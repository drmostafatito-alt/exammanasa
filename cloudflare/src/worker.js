/**
 * exammanasa-platform — Cloudflare Worker (Free plan)
 * ====================================================
 * الخادم الوحيد للمنصة: يقدّم الواجهات الثابتة، واجهة برمجة التطبيقات للطلاب
 * (بدون كشف المفاتيح أبدًا قبل التسليم)، لوحة الإدارة (بريد/كلمة مرور)،
 * إدارة المعلمين متعددي المستأجرين (/slug)، وحفظ النتائج + تمريرها إلى
 * Google Sheets عبر تطبيق Google Apps Script القائم.
 *
 * Security model (mirrors the audited GAS implementation):
 *  - Grading happens ONLY server-side; correct answers are never sent to the browser.
 *  - Exam sessions are HMAC-SHA256 signed tokens (examId + seed + student + expiry).
 *  - Per-question option order is shuffled with a seeded PRNG (mulberry32) — same
 *    algorithm as Code.gs shuffledOrder_().
 *  - Submissions require a valid token, are validated for completeness, and are
 *    de-duplicated (Cache API + KV) to prevent double submission / tampering.
 *  - Admin auth: PBKDF2-SHA256 (120k iterations) password hash in KV + signed
 *    HttpOnly SameSite=Strict session cookie + login rate limiting.
 *  - Answer keys live ONLY inside the Worker bundle (banks.json) and are exposed
 *    exclusively through authenticated admin endpoints.
 */
import BANKS from './data/banks.json';

const SESSION_TTL_SECONDS = 6 * 3600;      // 6 ساعات — مطابق لتطبيق GAS
const OFFLINE_TTL_SECONDS = 72 * 3600;     // 72 ساعة لجلسات معلمي وضع عدم الاتصال
const ADMIN_SESSION_TTL = 8 * 3600;
const TEACHER_SESSION_TTL = 8 * 3600;
const RESERVED_SLUGS = new Set([
  'api', 'admin', 'assets', 'static', 'favicon.ico', 'favicon.svg', 'robots.txt',
  'index.html', 'admin.html', 'app.js', 'admin.js', 'styles.css', 'index.js',
  'worker.js', 'wrangler.toml', 'wrangler.jsonc', 'src', 'public', 'docs', 'tests', 'www',
  'teacher', 'login', 'dashboard'
]);

/* ============================ helpers ============================ */
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}
const fail = (message, status = 400) => json({ error: message }, status);
/* Errors that are safe to show to the client (Arabic, no internals). Anything else → generic. */
class ApiError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const bad = (message, status = 400) => new ApiError(message, status);

/* ---- phone normalization (Egyptian mobiles; server-side identity) ----
 * Accepts Arabic-Indic/Persian digits, spaces/dashes, +20/0020 prefixes.
 * Canonical form: 01XXXXXXXXX (11 digits). Used for attempt-limit identity
 * and stored in tokens/results — the client value is never trusted as-is. */
function normalizePhone(raw) {
  let d = String(raw || '').trim()
    .replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
  d = d.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0020')) d = d.slice(4);
  else if (d.startsWith('20') && d.length >= 12) d = d.slice(2);
  if (/^1[0125]\d{8}$/.test(d)) d = '0' + d; // missing trunk zero
  return d;
}
function isValidEgMobile(d) { return /^01[0125][0-9]{8}$/.test(d); }
function normalizeName(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function securityHeaders(res) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---- seeded shuffle — ported verbatim from Code.gs (prng_/shuffledOrder_) ---- */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffledOrder(seed, index) {
  const rng = prng((seed ^ Math.imul(index + 1, 2654435761)) >>> 0);
  const arr = [0, 1, 2, 3]; // original option indices
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr; // arr[positionShownToStudent] = originalIndex
}

/* ---- HMAC / hashing ---- */
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(value));
}
async function pbkdf2(password, salt, iterations = 120000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return hex(bits);
}
const randomHex = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));

/* Constant-time hex comparison — used for all password-hash checks so the
 * comparison itself never leaks partial-match timing. */
function safeEqualHex(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length === 0 || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/* ---- exam session token: payload.HMAC ---- */
// token = base64url(payload) + '.' + base64url(hmac)
async function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(String.fromCharCode(...new Uint8Array(await hmac(secret, body))));
  return body + '.' + sig;
}
async function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = b64url(String.fromCharCode(...new Uint8Array(await hmac(secret, parts[0]))));
  if (expected !== parts[1]) return null; // non-constant-time compare is acceptable here: sig is 256-bit random-keyed
  try {
    const payload = JSON.parse(fromB64url(parts[0]));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

/* ---- session epochs (server-side revocation for the signed cookies) ----
 * Each login registers a random v inside the signed token AND in a KV list
 * (`sessv:admin` / `sessv:t:<id>`). Every authenticated request must present a v
 * still on the list, so logout-elsewhere, password changes/resets, disabling and
 * archiving revoke sessions immediately (last 8 sessions kept = multi-device).
 * The list is capped and last-write-wins — acceptable trade-off on the free plan. */
async function getVList(env, key) {
  const raw = await kvGet(env, key).catch(() => null);
  let arr = []; try { arr = raw ? JSON.parse(raw) : []; } catch { arr = []; }
  return Array.isArray(arr) ? arr : [];
}
async function addV(env, key, v) {
  const arr = await getVList(env, key);
  await kvPut(env, key, JSON.stringify(arr.filter(x => x !== v).concat([v]).slice(-8)));
}
async function setVList(env, key, list) { await kvPut(env, key, JSON.stringify(list)); }
async function hasV(env, key, v) {
  if (typeof v !== 'string' || !v) return false;
  const arr = await getVList(env, key);
  return arr.some(x => typeof x === 'string' && safeEqualHex(x, v));
}
async function dropV(env, key, v) {
  const arr = await getVList(env, key);
  await kvPut(env, key, JSON.stringify(arr.filter(x => x !== v)));
}
async function clearV(env, key) { try { if (env.PLATFORM_KV) await env.PLATFORM_KV.delete(key); } catch { } }

/* ============================ storage (KV) ============================ */
const DEFAULT_TEACHERS = [{
  id: 't_default_mostafa',
  slug: 'mostafa',
  name: 'د. مصطفى تيتو',
  phone: '',
  specialty: 'مدرس الفلسفة والمنطق وعلم النفس — المرحلة الثانوية',
  bio: 'منصة امتحانات إلكترونية للفلسفة والمنطق وعلم النفس وفق المنهج الرسمي: اختبر نفسك، اعرف درجتك فورًا، وراجع إجاباتك بعد كل امتحان.',
  photo: '',
  socialLinks: { whatsapp: '', facebook: '', tiktok: '', youtube: '' },
  requirePhone: true,
  enabled: true,
  isDefault: true,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z'
}];

/* ============================ platform settings (KV) ============================
 * Public platform configuration managed from the Admin panel (Settings section).
 * It is the single source of truth for branding / homepage copy / appearance /
 * platform-level social links — students never need code changes to update them.
 * Stored as one validated JSON document under `platform_settings`. Unknown keys are
 * dropped on save and merged with defaults on read, so old deployments keep working
 * (backward compatible). NEVER stored in localStorage — served from the server. */
const DEFAULT_SETTINGS = {
  identity: {
    platformName: 'منصة الامتحانات',
    academicYear: 'العام الدراسي 2026 / 2027',
    shortDescription: 'الفلسفة والمنطق · علم النفس',
    logo: '' // data:image/…;base64 OR https:// URL — optional
  },
  homepage: {
    badgeText: 'منصة الامتحانات الإلكترونية',
    heroTitle: 'اختبر نفسك',
    heroTitleAccent: 'وقيّم مستواك!',
    heroSubtitle: 'منصة امتحانات إلكترونية للفلسفة والمنطق وعلم النفس وفق المنهج الرسمي: امتحانات منظمة حسب الصفوف والوحدات والموضوعات، درجتك فورًا بعد التسليم، ومراجعة كاملة لإجاباتك.',
    chip1: 'اختبارات وفق المنهج الرسمي',
    chip2: 'تصحيح فوري ومراجعة الإجابات',
    floatChip: 'تصحيح فوري',
    ctaLabel: 'ابدأ الامتحان الآن',
    whatsappCtaLabel: 'تواصل عبر واتساب',
    subjectsTitle: 'اختر صفك للبدء',
    featuresTitle: 'لماذا منصة الامتحانات؟',
    aboutTitle: 'نبذة عن المعلم',
    contactTitle: 'تواصل معنا',
    feature1Title: 'امتحانات منظمة',
    feature1Text: 'امتحانات مرتبة حسب الصف والوحدات والموضوعات وفق المنهج الرسمي.',
    feature2Title: 'نتيجتك فورًا',
    feature2Text: 'اعرف درجتك ونسبتك المئوية مباشرة بعد تسليم الامتحان.',
    feature3Title: 'مراجعة الإجابات',
    feature3Text: 'راجع إجاباتك الصحيحة والخاطئة سؤالًا بسؤال بعد التسليم.',
    feature4Title: 'اعمل من أي جهاز',
    feature4Text: 'المنصة تعمل على الموبايل والكمبيوتر مباشرة من المتصفح — بدون تطبيقات أو تثبيت.'
  },
  appearance: {
    primary: '#1E56C8', accent: '#C99A2E', background: '#F5F7FD', text: '#1B2540', button: '#1E56C8'
  },
  social: { whatsapp: '', facebook: '', tiktok: '', youtube: '' },
  sections: { showFeatures: true, showAbout: true, showContact: true, showSocials: true },
  teacherDefaults: {
    requirePhone: true, unlimited: true, maxAttempts: 3, offlineMode: false, studentLimitUnlimited: true, studentLimit: 0
  }
};

function mergeSettings(stored) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!stored || typeof stored !== 'object') return out;
  for (const section of Object.keys(DEFAULT_SETTINGS)) {
    const s = stored[section];
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      for (const k of Object.keys(out[section])) {
        if (s[k] !== undefined) out[section][k] = s[k];
      }
    }
  }
  return out;
}
async function getSettings(env) {
  const stored = await kvGetJson(env, 'platform_settings').catch(() => null);
  return mergeSettings(stored);
}

function sanitizeSettings(body, base) {
  // Merge onto the CURRENT settings (or defaults) so a partial update never wipes
  // untouched fields. Only keys actually present in the body override the base.
  const d = base || DEFAULT_SETTINGS;
  const out = JSON.parse(JSON.stringify(d));
  const b = body && typeof body === 'object' ? body : {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const color = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : null;
  };
  const url = (v, { allowDataImage = false } = {}) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (allowDataImage && /^data:image\/(png|jpe?g|webp);base64,/i.test(s)) {
      if (s.length > 2.5 * 1024 * 1024) throw bad('حجم الصورة كبير جدًا (الحد 2.5 ميجابايت).');
      return s;
    }
    if (!/^https?:\/\//i.test(s)) throw bad('روابط التواصل والشعار يجب أن تبدأ بـ http:// أو https://');
    if (s.length > 300) throw bad('الرابط طويل جدًا.');
    return s;
  };

  /* identity */
  const id = b.identity || {};
  if (id.platformName !== undefined) out.identity.platformName = str(id.platformName, 80) || d.identity.platformName;
  if (id.academicYear !== undefined) out.identity.academicYear = str(id.academicYear, 60) || d.identity.academicYear;
  if (id.shortDescription !== undefined) out.identity.shortDescription = str(id.shortDescription, 160);
  if (id.logo !== undefined) out.identity.logo = url(id.logo, { allowDataImage: true });

  /* homepage */
  const hp = b.homepage || {};
  const hpText = (key, max, required) => {
    if (hp[key] !== undefined) out.homepage[key] = str(hp[key], max) || (required ? d.homepage[key] : '');
  };
  hpText('badgeText', 80, true);
  hpText('heroTitle', 80, true);
  hpText('heroTitleAccent', 80, false);
  hpText('heroSubtitle', 500, true);
  hpText('chip1', 60, true);
  hpText('chip2', 60, true);
  hpText('floatChip', 30, true);
  hpText('ctaLabel', 40, true);
  hpText('whatsappCtaLabel', 40, true);
  hpText('subjectsTitle', 60, true);
  hpText('featuresTitle', 60, true);
  hpText('aboutTitle', 60, true);
  hpText('contactTitle', 60, true);
  for (const f of [1, 2, 3, 4]) {
    hpText('feature' + f + 'Title', 60, true);
    hpText('feature' + f + 'Text', 300, true);
  }

  /* appearance */
  const ap = b.appearance || {};
  for (const k of ['primary', 'accent', 'background', 'text', 'button']) {
    if (ap[k] === undefined) continue;
    const c = color(ap[k]);
    if (c) out.appearance[k] = c; // invalid color → keep the previous value
  }

  /* social */
  const sc = b.social || {};
  for (const k of ['whatsapp', 'facebook', 'tiktok', 'youtube']) {
    if (sc[k] !== undefined) out.social[k] = url(sc[k]);
  }

  /* sections */
  const sec = b.sections || {};
  for (const k of ['showFeatures', 'showAbout', 'showContact', 'showSocials']) {
    if (sec[k] !== undefined) out.sections[k] = sec[k] !== false;
  }

  /* teacher defaults */
  const td = b.teacherDefaults || {};
  if (td.requirePhone !== undefined) out.teacherDefaults.requirePhone = td.requirePhone !== false;
  if (td.unlimited !== undefined) out.teacherDefaults.unlimited = td.unlimited !== false;
  if (td.maxAttempts !== undefined) out.teacherDefaults.maxAttempts = Math.max(1, Math.min(50, parseInt(td.maxAttempts, 10) || d.teacherDefaults.maxAttempts));
  if (td.offlineMode !== undefined) out.teacherDefaults.offlineMode = td.offlineMode === true;
  if (td.studentLimitUnlimited !== undefined) out.teacherDefaults.studentLimitUnlimited = td.studentLimitUnlimited !== false;
  if (td.studentLimit !== undefined) out.teacherDefaults.studentLimit = sanitizeStudentLimit(td.studentLimit);

  return out;
}

/* Public projection of settings — only what the student pages need. No secrets. */
function publicSettings(s) {
  return { identity: s.identity, homepage: s.homepage, appearance: s.appearance, social: s.social, sections: s.sections };
}

async function kvGet(env, key) {
  if (!env.PLATFORM_KV) throw bad('تهيئة الخادم غير مكتملة (KV).', 503);
  const v = await env.PLATFORM_KV.get(key);
  return v === null ? null : v;
}
async function kvGetJson(env, key) {
  const v = await kvGet(env, key).catch(() => null);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}
async function kvPut(env, key, value, ttlSeconds) {
  if (!env.PLATFORM_KV) throw bad('تهيئة الخادم غير مكتملة (KV).', 503);
  const opts = ttlSeconds ? { expirationTtl: Math.max(60, ttlSeconds) } : undefined;
  await env.PLATFORM_KV.put(key, value, opts);
}

async function getTeachers(env) {
  const stored = await kvGetJson(env, 'teachers').catch(() => null);
  if (Array.isArray(stored) && stored.length) return stored;
  return DEFAULT_TEACHERS;
}
async function getSessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let s = await kvGet(env, 'session_secret').catch(() => null);
  if (!s) {
    s = randomHex(32);
    try { await kvPut(env, 'session_secret', s); } catch { /* KV missing — caller handles */ }
  }
  return s;
}

/* ============================ request parsing ============================ */
async function readJson(request, maxBytes = 128 * 1024) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) throw bad('حجم الطلب كبير جدًا.', 413);
  let data;
  try { data = JSON.parse(new TextDecoder().decode(buf)); } catch { throw bad('بيانات غير صالحة.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('بيانات غير صالحة.');
  return data;
}

/* ============================ public API ============================ */
/* Owner/default teacher shown on the root page ("/"). Same resolution rule is
 * used by /api/exam/start when a student arrives without a slug, so results
 * collected on "/" are always attributed to the teacher whose identity "/" shows. */
function ownerTeacher(teachers) {
  return teachers.find(t => t.isDefault && t.enabled !== false)
    || teachers.find(t => t.enabled !== false)
    || teachers.find(t => t.isDefault)
    || teachers[0] || null;
}

async function publicCatalog(env) {
  const teachers = await getTeachers(env).catch(() => DEFAULT_TEACHERS);
  const owner = ownerTeacher(teachers);
  return {
    version: BANKS.version, generatedAt: BANKS.generatedAt,
    catalog: BANKS.catalog, exams: BANKS.exams,
    owner: owner ? teacherPublic(owner) : null
  };
}

function teacherPublic(t) {
  return {
    slug: t.slug, name: t.name, specialty: t.specialty || '', bio: t.bio || '', photo: t.photo || '',
    socialLinks: t.socialLinks || {},
    requirePhone: !!t.requirePhone
  };
}

async function handleApi(request, env, ctx, pathname) {
  const method = request.method;

  /* ---------- public: catalog ---------- */
  if (pathname === '/api/catalog' && method === 'GET') {
    return json(await publicCatalog(env), 200, { 'Cache-Control': 'public, max-age=300, s-maxage=3600' });
  }

  /* ---------- public: platform settings (branding/homepage/appearance) ---------- */
  if (pathname === '/api/settings' && method === 'GET') {
    return json(publicSettings(await getSettings(env)), 200, { 'Cache-Control': 'public, max-age=60, s-maxage=300' });
  }

  /* ---------- public: teacher profile ---------- */
  const teacherMatch = pathname.match(/^\/api\/teacher\/([a-z0-9-]+)$/);
  if (teacherMatch && method === 'GET') {
    const teachers = await getTeachers(env);
    const t = teachers.find(x => x.slug === teacherMatch[1] && x.enabled !== false);
    if (!t) return fail('لا يوجد معلم بهذا الرابط.', 404);
    return json({ teacher: teacherPublic(t) }, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=300' });
  }


  /* ---------- teacher auth: login ---------- */
  if (pathname === '/api/t/login' && method === 'POST') {
    return handleTeacherLogin(request, env);
  }
  /* ---------- teacher auth: session ---------- */
  if (pathname === '/api/t/session' && method === 'GET') {
    const session = await teacherCookiePayload(request, env);
    if (!session || !(await hasV(env, 'sessv:t:' + session.tid, session.v))) return fail('\u063a\u064a\u0631 \u0645\u0635\u0631\u062d.', 401);
    const teachers = await getTeachers(env);
    const t = teachers.find(x => x.id === session.tid);
    if (!t || t.enabled === false || t.archived) return fail('\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0639\u0644\u0645 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d.', 403);
    return json({ id: t.id, name: t.name, slug: t.slug });
  }
  /* ---------- teacher auth: logout ---------- */
  if (pathname === '/api/t/logout' && method === 'POST') {
    // drop only this session's epoch (other devices stay signed in)
    const s = await teacherCookiePayload(request, env).catch(() => null);
    if (s && s.tid && s.v) await dropV(env, 'sessv:t:' + s.tid, s.v).catch(() => {});
    const res = json({ ok: true });
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', 'teacher_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return new Response(res.body, { status: res.status, headers });
  }

  /* ---------- student: start exam session ---------- */
  if (pathname === '/api/exam/start' && method === 'POST') {
    const body = await readJson(request);
    const examId = String(body.examId || '');
    const examMeta = BANKS.exams[examId];
    if (!examMeta) return fail('الامتحان غير موجود.', 404);
    const ids = BANKS.examDefs[examId];
    if (!ids || !ids.length) return fail('الامتحان غير متاح حاليًا.', 404);

    const name = String(body.name || '').trim();
    const rawPhone = String(body.phone || '').trim();
    if (!name) return fail('اسم الطالب مطلوب.');
    if (name.length > 120) return fail('اسم الطالب طويل جدًا.');
    const normPhone = normalizePhone(rawPhone);
    if (rawPhone && !isValidEgMobile(normPhone)) return fail('رقم الهاتف غير صالح. أدخل رقمًا مصريًا صحيحًا (01xxxxxxxxx).');
    // Teacher attribution — the slug is the public entry link, but it is NEVER a
    // free-form security input: an unknown slug is rejected outright, and an empty
    // slug (root page "/") is resolved server-side to the owner/default teacher.
    // This closes two holes: (1) results orphaned outside any teacher's index via a
    // fabricated slug, and (2) bypassing a teacher's student-limit seat registration
    // by simply omitting/mismarking the slug on this request.
    const teachers = await getTeachers(env);
    let slug = String(body.slug || '').trim().toLowerCase();
    let teacher = null;
    if (slug) {
      teacher = teachers.find(x => x.slug === slug) || null;
      if (!teacher) return fail('رابط المعلم غير صالح — أعد فتح الرابط الصحيح.', 404);
    } else {
      teacher = ownerTeacher(teachers);
      if (!teacher) return fail('لا توجد صفحة معلم نشطة على المنصة.', 403);
      slug = teacher.slug;
    }
    if (teacher.enabled === false) return fail('صفحة هذا المعلم غير متاحة حاليًا.', 403);
    if (!rawPhone && teacher.requirePhone !== false) return fail('رقم الهاتف مطلوب.');
    // Student limit — registration is the moment a distinct student is counted. Atomic inside the
    // teacher's DO instance, so N concurrent new registrations can never exceed the limit.
    let studentSeat = null;
    if (teacher) {
      const reg = await registerStudent(env, teacher, studentIdentity(normPhone, name), { enforce: true });
      if (!reg) return fail('خدمة تسجيل الطلاب غير متاحة حاليًا.', 503);
      if (reg.allowed !== true) return fail(STUDENT_LIMIT_MSG, 429);
      const sl = studentLimitOf(teacher);
      studentSeat = { unlimited: sl.unlimited, limit: sl.limit, current: reg.count, remaining: sl.unlimited ? null : Math.max(0, sl.limit - reg.count) };
    }
    // read-only limit pre-check (atomic enforcement happens at submit time)
    const limit = teacherLimit(teacher);
    let attemptsInfo = null;
    if (limit > 0) {
      const stub = await limiterStub(env, await limitKey(slug, examId, studentIdentity(normPhone, name)));
      if (!stub) return fail('خدمة حدود المحاولات غير متاحة حاليًا.', 503);
      const st = await stub.fetch('https://limiter.internal/count').then(r => r.json()).catch(() => null);
      const used = (st && Number.isFinite(st.used)) ? st.used : 0;
      if (used >= limit) return fail('استنفدت عدد المحاولات المسموح به لهذا الامتحان (' + limit + ').', 429);
      attemptsInfo = { used, limit, remaining: limit - used };
    }

    const secret = await getSessionSecret(env).catch(() => null);
    if (!secret) return fail('تهيئة الخادم غير مكتملة (KV).', 503);

    const seed = Math.floor(Math.random() * 2147483646) + 1;
    const nonce = randomHex(12);
    const offlineMode = teacher && teacher.offlineMode === true;
    const ttl = offlineMode ? OFFLINE_TTL_SECONDS : SESSION_TTL_SECONDS;
    const iss = Math.floor(Date.now() / 1000);
    const token = await signToken({
      t: 'exam', examId, seed, nonce, name, phone: normPhone,
      slug, iss, exp: iss + ttl
    }, secret);

    const questions = ids.map((qid, i) => {
      const q = BANKS.questions[qid];
      const perm = shuffledOrder(seed, i);
      return { no: i + 1, id: qid, text: q.text, options: perm.map(origIdx => q.options[origIdx]) };
    });

    return json({
      token,
      ...(attemptsInfo ? { attempts: attemptsInfo } : {}),
      ...(studentSeat ? { students: studentSeat } : {}),
      offline: { enabled: offlineMode, expiresAt: new Date((iss + ttl) * 1000).toISOString() },
      exam: {
        id: examId, title: examMeta.title, count: examMeta.count,
        lessonTitle: examMeta.lessonTitle, lessonNo: examMeta.lessonNo,
        chapterTitle: examMeta.chapterTitle, unitTitle: examMeta.unitTitle,
        subjectId: examMeta.subjectId, term: examMeta.term, type: examMeta.type
      },
      questions
    });
  }

  /* ---------- student: submit ---------- */
  if (pathname === '/api/exam/submit' && method === 'POST') {
    const body = await readJson(request);
    const token = String(body.token || '');
    const answers = body.answers;
    const secret = await getSessionSecret(env).catch(() => null);
    if (!secret) return fail('تهيئة الخادم غير مكتملة (KV).', 503);
    const sess = await verifyToken(token, secret);
    if (!sess || sess.t !== 'exam') return fail('جلسة الامتحان غير صالحة أو منتهية. أعد فتح الامتحان.', 403);
    if (!Array.isArray(answers) || answers.length !== BANKS.examDefs[sess.examId].length) {
      return fail('عدد الإجابات لا يطابق عدد الأسئلة.');
    }
    const unanswered = [];
    answers.forEach((a, i) => { if (!Number.isInteger(a) || a < 0 || a > 3) unanswered.push(i + 1); });
    if (unanswered.length) {
      return json({
        error: 'لا يمكن تسليم الامتحان قبل الإجابة على جميع الأسئلة. أسئلة بدون إجابة: ' + unanswered.join('، '),
        unanswered
      }, 400);
    }

    // dedupe (best-effort across isolates: Cache API + durable KV)
    const tokenHash = hex(await hmac(secret + '|dedupe', token));
    const dedupeUrl = 'https://dedupe.internal/' + tokenHash;
    const cache = caches.default;
    let replay = null;
    if (env.PLATFORM_KV) {
      const prev = await env.PLATFORM_KV.get('dedupe:' + tokenHash).catch(() => null);
      if (prev) replay = prev;
    }
    if (!replay) {
      const cached = await cache.match(dedupeUrl).catch(() => null);
      if (cached) replay = await cached.text();
    }
    if (replay) {
      try { return json(JSON.parse(replay), 200); } catch { /* fallthrough */ }
    }

    // atomic attempt consumption for limited teachers (race-safe inside the DO)
    {
      const teachers = await getTeachers(env);
      const t = teachers.find(x => x.slug === (sess.slug || '')) || null;
      if (t && t.enabled === false) return fail('صفحة هذا المعلم غير متاحة حاليًا.', 403);
      if (t) {
        // Seat check at submit too: a token whose student was never registered (or a teacher whose
        // limit was lowered afterwards) cannot bypass the limit. Registered students are always allowed.
        const reg = await registerStudent(env, t, studentIdentity(sess.phone || '', sess.name || ''), { enforce: true });
        if (!reg) return fail('خدمة تسجيل الطلاب غير متاحة حاليًا.', 503);
        if (reg.allowed !== true) return fail(STUDENT_LIMIT_MSG, 429);
      }
      const lim = teacherLimit(t);
      if (lim > 0) {
        const stub = await limiterStub(env, await limitKey(sess.slug || '', sess.examId, studentIdentity(sess.phone || '', sess.name || '')));
        if (!stub) return fail('خدمة حدود المحاولات غير متاحة حاليًا.', 503);
        const c = await stub.fetch('https://limiter.internal/consume', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: lim })
        }).then(r => r.json()).catch(() => null);
        if (!c || c.allowed !== true) return fail('استنفدت عدد المحاولات المسموح به لهذا الامتحان (' + lim + ').', 429);
      }
    }

    // grade — SERVER ONLY
    const ids = BANKS.examDefs[sess.examId];
    const examMeta = BANKS.exams[sess.examId];
    let score = 0;
    const review = ids.map((qid, i) => {
      const q = BANKS.questions[qid];
      const perm = shuffledOrder(sess.seed, i);
      const correctOrig = 'ABCD'.indexOf(q.answer);
      const chosenOrig = perm[answers[i]];
      const isCorrect = chosenOrig === correctOrig;
      if (isCorrect) score++;
      return {
        no: i + 1,
        id: qid,
        isCorrect,
        questionText: q.text,
        studentAnswerText: q.options[chosenOrig],
        correctAnswerText: q.options[correctOrig]
      };
    });
    const total = ids.length;
    const percentage = Math.round((score / total) * 10000) / 100;

    const result = {
      id: tokenHash.slice(0, 16),
      date: new Date().toISOString(),
      name: sess.name, phone: sess.phone,
      teacherSlug: sess.slug || '',
      examId: sess.examId, examTitle: examMeta.title,
      subject: examMeta.subjectId === 'psychology' ? 'علم النفس' : 'الفلسفة والمنطق',
      term: examMeta.term,
      unitOrSection: examMeta.unitTitle || '',
      examType: examMeta.type, examLabel: examMeta.title,
      total, score, percentage,
      review
    };

    const response = {
      id: result.id,
      score, total, percentage,
      correct: score, wrong: total - score,
      pass: percentage >= 50,
      review
    };
    const responseJson = JSON.stringify(response);

    // persist + forward (best effort — never block the student's result)
    const persist = async () => {
      try {
        if (env.PLATFORM_KV) {
          await env.PLATFORM_KV.put('dedupe:' + tokenHash, responseJson, { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
          await env.PLATFORM_KV.put('result:' + result.id, JSON.stringify(result)).catch(() => {});
          const recent = await env.PLATFORM_KV.get('results:recent').catch(() => null);
          let list = [];
          try { list = recent ? JSON.parse(recent) : []; } catch {}
          list.unshift({ id: result.id, date: result.date, name: result.name, phone: result.phone, examId: result.examId, examLabel: result.examLabel, subject: result.subject, total, score, percentage, teacherSlug: result.teacherSlug });
          if (list.length > 100) list = list.slice(0, 100);
          await env.PLATFORM_KV.put('results:recent', JSON.stringify(list)).catch(() => {});
          // per-teacher index (powers the teacher dashboard; bank/exams stay shared)
          const tslug = result.teacherSlug || '';
          if (tslug) {
            const tprev = await env.PLATFORM_KV.get('results:teacher:' + tslug).catch(() => null);
            let tlist = [];
            try { tlist = tprev ? JSON.parse(tprev) : []; } catch {}
            tlist.unshift({ id: result.id, date: result.date, name: result.name, phone: result.phone, examId: result.examId, examLabel: result.examLabel, subject: result.subject, total, score, percentage });
            if (tlist.length > 200) tlist = tlist.slice(0, 200);
            await env.PLATFORM_KV.put('results:teacher:' + tslug, JSON.stringify(tlist)).catch(() => {});
          }
        }
      } catch { /* storage failure must not lose the student's result response */ }

      if (env.GAS_WEBAPP_URL && env.GAS_RESULTS_SECRET) {
        try {
          await fetch(env.GAS_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'appendResult',
              secret: env.GAS_RESULTS_SECRET,
              result: {
                date: result.date, name: result.name, phone: result.phone,
                unitOrSection: result.unitOrSection, examType: result.examType,
                examLabel: result.examLabel, total, score, percentage,
                detailsJson: JSON.stringify(review.map(r => ({ no: r.no, id: r.id, correct: r.isCorrect }))),
                subject: result.subject, term: result.term, teacherSlug: result.teacherSlug
              }
            })
          });
        } catch { /* GAS unreachable — result stays in KV */ }
      }
    };
    ctx.waitUntil(persist());
    ctx.waitUntil(cache.put(dedupeUrl, new Response(responseJson, { headers: { 'Cache-Control': 'max-age=604800' } })).catch(() => {}));
    return json(response);
  }


  /* ============================ teacher API (authenticated) ============================ */
  if (pathname.startsWith('/api/t/')) {
    return handleTeacherAuthenticated(request, env, ctx, pathname);
  }

  /* ============================ admin ============================ */
  const isAdminPath = pathname.startsWith('/api/admin/');
  if (isAdminPath) {
    return handleAdmin(request, env, ctx, pathname);
  }

  return fail('المسار غير موجود.', 404);
}

/* ============================ admin API ============================ */
const loginFails = new Map(); // per-isolate best effort

async function getAdminRecord(env) {
  return kvGetJson(env, 'admin');
}

/* Secret-based first-run provisioning (see cloudflare/README.md §4): when
 * ADMIN_INITIAL_EMAIL/ADMIN_INITIAL_PASSWORD are set as Worker secrets, the admin
 * account is created automatically on the first admin-API request — the public
 * setup screen is then permanently closed (409) and was never usable to race the
 * owner. Without the secrets, the one-time setup screen remains the bootstrap path. */
async function ensureAdminBootstrap(env) {
  if (!env.ADMIN_INITIAL_EMAIL || !env.ADMIN_INITIAL_PASSWORD) return;
  const existing = await kvGetJson(env, 'admin').catch(() => null);
  if (existing) return;
  const email = String(env.ADMIN_INITIAL_EMAIL).trim().toLowerCase();
  const password = String(env.ADMIN_INITIAL_PASSWORD);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8) return; // invalid secret → fall back to setup screen
  const salt = randomHex(16);
  const hash = await pbkdf2(password, salt);
  await kvPut(env, 'admin', JSON.stringify({ email, salt, hash, iterations: 120000, createdAt: new Date().toISOString(), via: 'env-secret' }));
}

async function adminCookiePayload(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (!m) return null;
  const secret = await getSessionSecret(env).catch(() => null);
  if (!secret) return null;
  return verifyToken(decodeURIComponent(m[1]), secret);
}

async function handleAdmin(request, env, ctx, pathname) {
  const method = request.method;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // First-run: if initial-admin secrets are configured, provision now (idempotent).
  await ensureAdminBootstrap(env).catch(() => {});

  /* ---------- login ---------- */
  if (pathname === '/api/admin/login' && method === 'POST') {
    const fails = loginFails.get(ip) || { n: 0, until: 0 };
    if (fails.n >= 10 && Date.now() < fails.until) return fail('محاولات كثيرة. حاول بعد قليل.', 429);

    const body = await readJson(request);
    // Existence check FIRST: the admin SPA boot probes login with empty credentials to
    // detect first run — a fresh deployment must receive the 404 "not created yet"
    // signal (and switch to the one-time setup screen) instead of a generic 400.
    const admin = await getAdminRecord(env);
    if (!admin) return fail('لم يُنشأ حساب المسؤول بعد. افتح صفحة الإعداد الأولي.', 404);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return fail('البريد وكلمة المرور مطلوبان.');

    const hash = await pbkdf2(password, admin.salt, admin.iterations);
    if (email !== admin.email || !safeEqualHex(hash, admin.hash)) {
      loginFails.set(ip, { n: fails.n + 1, until: Date.now() + 15 * 60 * 1000 });
      return fail('بيانات الدخول غير صحيحة.', 401);
    }
    loginFails.delete(ip);

    const secret = await getSessionSecret(env).catch(() => null);
    if (!secret) return fail('تهيئة الخادم غير مكتملة (KV).', 503);
    const v = randomHex(8);
    await addV(env, 'sessv:admin', v); // server-side revocation registry for admin sessions
    const token = await signToken({ t: 'admin', email, v, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL }, secret);
    const res = json({ ok: true, email });
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie',
      `admin_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL}`);
    return new Response(res.body, { status: res.status, headers });
  }

  /* ---------- initial setup (only when no admin exists) ---------- */
  if (pathname === '/api/admin/setup' && method === 'POST') {
    const existing = await getAdminRecord(env);
    if (existing) return fail('حساب المسؤول موجود بالفعل.', 409);
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('البريد الإلكتروني غير صالح.');
    if (password.length < 8) return fail('كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
    const salt = randomHex(16);
    const hash = await pbkdf2(password, salt);
    await kvPut(env, 'admin', JSON.stringify({ email, salt, hash, iterations: 120000, createdAt: new Date().toISOString() }));
    return json({ ok: true });
  }

  /* ---------- everything below requires an admin session ---------- */
  const session = await adminCookiePayload(request, env);
  let authed = !!(session && session.t === 'admin');
  if (authed && !(await hasV(env, 'sessv:admin', session.v))) authed = false; // revoked (password change / logout elsewhere)

  if (pathname === '/api/admin/session' && method === 'GET') {
    if (!authed) return fail('غير مصرح.', 401);
    return json({ email: session.email });
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
    const s0 = await adminCookiePayload(request, env).catch(() => null);
    if (s0 && s0.v) await dropV(env, 'sessv:admin', s0.v).catch(() => {});
    const res = json({ ok: true });
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', 'admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return new Response(res.body, { status: res.status, headers });
  }
  if (!authed) return fail('غير مصرح.', 401);
  // CSRF defense for state-changing endpoints: SameSite=Strict cookie + custom header
  if (method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') {
    return fail('طلب غير مصرح.', 403);
  }

  /* ---------- platform settings (admin) ---------- */
  if (pathname === '/api/admin/settings' && method === 'GET') {
    return json({ settings: await getSettings(env) });
  }
  if (pathname === '/api/admin/settings' && method === 'PUT') {
    const body = await readJson(request, 3 * 1024 * 1024); // logo data URLs can be sizable
    const current = await getSettings(env);
    const next = sanitizeSettings(body, current);
    await kvPut(env, 'platform_settings', JSON.stringify(next));
    return json({ ok: true, settings: next });
  }

  /* ---------- change admin password ---------- */
  if (pathname === '/api/admin/password' && method === 'POST') {
    const body = await readJson(request);
    const current = String(body.current || '');
    const next = String(body.next || '');
    const admin = await getAdminRecord(env);
    if (!admin) return fail('لم يُنشأ حساب المسؤول بعد.', 404);
    const curHash = await pbkdf2(current, admin.salt, admin.iterations);
    if (!safeEqualHex(curHash, admin.hash)) return fail('كلمة المرور الحالية غير صحيحة.', 401);
    if (next.length < 8) return fail('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.');
    if (next === current) return fail('كلمة المرور الجديدة مطابقة للحالية.');
    const salt = randomHex(16);
    const hash = await pbkdf2(next, salt);
    await kvPut(env, 'admin', JSON.stringify({ ...admin, salt, hash, iterations: 120000, updatedAt: new Date().toISOString() }));
    // password change revokes every admin session, then re-issues THIS device only
    const v = randomHex(8);
    await setVList(env, 'sessv:admin', [v]);
    const secret2 = await getSessionSecret(env);
    const token = await signToken({ t: 'admin', email: admin.email, v, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL }, secret2);
    const res = json({ ok: true });
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', `admin_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL}`);
    return new Response(res.body, { status: res.status, headers });
  }

  /* ---------- overview ---------- */
  if (pathname === '/api/admin/overview' && method === 'GET') {
    const teachers = await getTeachers(env);
    const recent = await kvGetJson(env, 'results:recent').catch(() => null) || [];
    return json({
      exams: Object.keys(BANKS.exams).length,
      questions: Object.keys(BANKS.questions).length,
      structure: BANKS.structure,
      audit: BANKS.audit,
      notes: BANKS.notes,
      teachersCount: teachers.length,
      teachersEnabled: teachers.filter(t => t.enabled !== false).length,
      recentResultsCount: recent.length,
      teachers: await Promise.all(teachers.map(async t => ({ slug: t.slug, name: t.name, enabled: t.enabled !== false, studentLimit: await studentLimitStatus(env, t) })))
    });
  }

  /* ---------- teachers CRUD ---------- */
  if (pathname === '/api/admin/teachers' && method === 'GET') {
    const teachers = await getTeachers(env);
    const archived = await kvGetJson(env, 'teachers:archived').catch(() => null) || [];
    // NEVER return raw KV records: they carry passHash/passSalt. The admin UI only
    // needs the safe projection (+isDefault / +studentLimitStatus for the cards).
    const withStatus = await Promise.all(teachers.map(async t => ({
      ...teacherAdminPayload(t), isDefault: !!t.isDefault, studentLimitStatus: await studentLimitStatus(env, t)
    })));
    const archivedSafe = archived.map(a => ({ ...teacherAdminPayload(a), archived: true }));
    return json({ teachers: withStatus, archived: archivedSafe });
  }
  /* ---------- restore an archived teacher (delete is non-destructive) ---------- */
  const restoreMatch = pathname.match(/^\/api\/admin\/teachers\/([A-Za-z0-9_-]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    const teachers = await getTeachers(env);
    const archived = await kvGetJson(env, 'teachers:archived').catch(() => null) || [];
    const i = archived.findIndex(x => x.id === restoreMatch[1]);
    if (i === -1) return fail('المعلم غير موجود في الأرشيف.', 404);
    const t = archived[i];
    if (teachers.some(x => x.slug === t.slug)) return fail('الرابط (slug) مستخدم حاليًا بواسطة معلم آخر — عدّل رابط المعلم الحالي أولًا.', 409);
    delete t.archivedAt; delete t.archived; t.enabled = false; t.updatedAt = new Date().toISOString();
    archived.splice(i, 1);
    teachers.push(t);
    await kvPut(env, 'teachers', JSON.stringify(teachers));
    await kvPut(env, 'teachers:archived', JSON.stringify(archived));
    return json({ ok: true, teacher: teacherAdminPayload(t) });
  }
  if (pathname === '/api/admin/teachers' && method === 'POST') {
    const body = await readJson(request, 3 * 1024 * 1024);
    const t = await sanitizeTeacher(body, null, env);
    const teachers = await getTeachers(env);
    if (teachers.some(x => x.slug === t.slug)) return fail('الرابط (slug) مستخدم بالفعل.', 409);
    // An archived teacher keeps its results index (results:teacher:<slug>). Creating a
    // NEW account on that slug would silently inherit the old teacher's history — blocked.
    const archivedNow = await kvGetJson(env, 'teachers:archived').catch(() => null) || [];
    if (archivedNow.some(x => x.slug === t.slug)) return fail('هذا الرابط يخص معلمًا مؤرشفًا — استعده من الأرشيف أو اختر رابطًا مختلفًا.', 409);
    t.id = 't_' + randomHex(6);
    t.teacherCode = 'TCH-' + String(teachers.length + 1).padStart(4, '0');
    t.createdAt = new Date().toISOString();
    t.updatedAt = t.createdAt;
    teachers.push(t);
    await kvPut(env, 'teachers', JSON.stringify(teachers));
    return json({ ok: true, teacher: teacherAdminPayload(t) });
  }
  /* ---------- teacher dashboard (per-teacher results index) ---------- */
  const statsMatch = pathname.match(/^\/api\/admin\/teachers\/([A-Za-z0-9_-]+)\/stats$/);
  if (statsMatch && method === 'GET') {
    const teachers = await getTeachers(env);
    const t = teachers.find(x => x.id === statsMatch[1]);
    if (!t) return fail('المعلم غير موجود.', 404);
    const tlist = await kvGetJson(env, 'results:teacher:' + t.slug).catch(() => null) || [];
    const slStatus = await studentLimitStatus(env, t);
    // distinct registered students come from the per-teacher registry (exact, not capped by the 100-row index)
    const students = Math.max(slStatus.current, new Set(tlist.map(r => (r.phone || '') + '|' + r.name)).size);
    const avg = tlist.length ? Math.round(tlist.reduce((n, r) => n + r.percentage, 0) / tlist.length * 100) / 100 : 0;
    const pass = tlist.filter(r => r.percentage >= 50).length;
    const perExam = {};
    tlist.forEach(r => {
      const k = r.examId || r.examLabel;
      perExam[k] = perExam[k] || { examId: r.examId || '', title: r.examLabel || '', attempts: 0, sum: 0 };
      perExam[k].attempts++; perExam[k].sum += r.percentage;
    });
    return json({
      teacher: teacherAdminSummary(t),
      studentLimit: slStatus,
      totals: { results: tlist.length, students, registeredStudents: slStatus.current, avgPercentage: avg, passRate: tlist.length ? Math.round(pass / tlist.length * 10000) / 100 : 0 },
      perExam: Object.values(perExam).map(e => ({ examId: e.examId, title: e.title, attempts: e.attempts, avgPercentage: Math.round(e.sum / e.attempts * 100) / 100 })).sort((a, b) => b.attempts - a.attempts),
      recent: tlist.slice(0, 10)
    });
  }
  const tMatch = pathname.match(/^\/api\/admin\/teachers\/([A-Za-z0-9_-]+)$/);
  if (tMatch) {
    const teachers = await getTeachers(env);
    const idx = teachers.findIndex(x => x.id === tMatch[1]);
    if (idx === -1) return fail('المعلم غير موجود.', 404);
    if (method === 'PUT') {
      const body = await readJson(request, 3 * 1024 * 1024);
      const t = await sanitizeTeacher(body, teachers[idx], env);
      if (teachers.some((x, i) => i !== idx && x.slug === t.slug)) return fail('الرابط (slug) مستخدم بالفعل.', 409);
      // setting/clearing the password through the edit form is a credential change → revoke sessions
      if ((teachers[idx].passHash || '') !== (t.passHash || '')) await clearV(env, 'sessv:t:' + teachers[idx].id);
      t.id = teachers[idx].id;
      t.teacherCode = teachers[idx].teacherCode || ('TCH-' + String(idx + 1).padStart(4, '0'));
      t.createdAt = teachers[idx].createdAt;
      t.updatedAt = new Date().toISOString();
      if (teachers[idx].isDefault && t.slug !== teachers[idx].slug) delete t.isDefault;
      teachers[idx] = t;
      await kvPut(env, 'teachers', JSON.stringify(teachers));
      // disabling kills all live sessions immediately (re-enabling requires a fresh login)
      if (t.enabled === false) await clearV(env, 'sessv:t:' + t.id);
      return json({ ok: true, teacher: teacherAdminPayload(t) });
    }
    if (method === 'DELETE') {
      // Non-destructive: the profile moves to the archive (restorable); results (results:teacher:<slug>)
      // and the student registry are never deleted. The slug is released for reuse.
      if (teachers[idx].isDefault) return fail('لا يمكن حذف المعلم الافتراضي — يمكنك تعطيله فقط.', 400);
      await clearV(env, 'sessv:t:' + teachers[idx].id); // archive = sign out everywhere
      const [removed] = teachers.splice(idx, 1);
      const archived = await kvGetJson(env, 'teachers:archived').catch(() => null) || [];
      archived.unshift({ ...removed, enabled: false, archived: true, archivedAt: new Date().toISOString() });
      await kvPut(env, 'teachers:archived', JSON.stringify(archived.slice(0, 200)));
      await kvPut(env, 'teachers', JSON.stringify(teachers));
      return json({ ok: true, archived: true });
    }
  }

  /* ---------- admin: reset teacher password ---------- */
  const resetPwMatch = pathname.match(/^\/api\/admin\/teachers\/([A-Za-z0-9_-]+)\/password$/);
  if (resetPwMatch && method === 'POST') {
    const teachers = await getTeachers(env);
    const idx = teachers.findIndex(x => x.id === resetPwMatch[1]);
    if (idx === -1) return fail('\u0627\u0644\u0645\u0639\u0644\u0645 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f.', 404);
    const body = await readJson(request);
    const newPassword = String(body.password || '');
    if (newPassword.length < 8) return fail('\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 8 \u0623\u062d\u0631\u0641 \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644.');
    const salt = randomHex(16);
    const hash = await pbkdf2(newPassword, salt);
    teachers[idx] = { ...teachers[idx], passSalt: salt, passHash: hash, passIterations: 120000, updatedAt: new Date().toISOString() };
    await kvPut(env, 'teachers', JSON.stringify(teachers));
    await clearV(env, 'sessv:t:' + teachers[idx].id); // admin reset = the teacher must sign in again everywhere
    return json({ ok: true });
  }

  /* ---------- question bank (admin sees keys) ---------- */
  if (pathname === '/api/admin/questions' && method === 'GET') {
    const url = new URL(request.url);
    const subject = url.searchParams.get('subject') || '';
    const term = url.searchParams.get('term') || '';
    const search = (url.searchParams.get('q') || '').trim();
    const lesson = (url.searchParams.get('lesson') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const perPage = 50;
    const entries = Object.entries(BANKS.questions)
      .filter(([, q]) => !subject || q.meta.subjectId === subject)
      .filter(([, q]) => !term || String(q.meta.term || '') === term)
      .filter(([, q]) => !lesson || String(q.meta.lesson || q.meta.chapter || '').includes(lesson))
      .filter(([, q]) => !search || q.text.includes(search));
    const total = entries.length;
    const slice = entries.slice((page - 1) * perPage, page * perPage)
      .map(([id, q]) => ({ id, text: q.text, options: q.options, answer: q.answer, meta: q.meta }));
    return json({ total, page, perPage, questions: slice });
  }

  /* ---------- exams ---------- */
  if (pathname === '/api/admin/exams' && method === 'GET') {
    return json({ exams: BANKS.exams, catalog: BANKS.catalog });
  }

  /* ---------- results ---------- */
  if (pathname === '/api/admin/results' && method === 'GET') {
    const recent = await kvGetJson(env, 'results:recent').catch(() => null) || [];
    return json({ results: recent });
  }
  if (pathname === '/api/admin/results.csv' && method === 'GET') {
    const recent = await kvGetJson(env, 'results:recent').catch(() => null) || [];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['التاريخ', 'اسم الطالب', 'رقم الهاتف', 'الامتحان', 'المادة', 'الدرجة', 'النسبة %', 'المعلم'].map(esc).join(',')];
    recent.forEach(r => rows.push([
      new Date(r.date).toLocaleString('ar-EG'), r.name, r.phone, r.examLabel, r.subject,
      r.score + '/' + r.total, r.percentage, r.teacherSlug
    ].map(esc).join(',')));
    return new Response('\uFEFF' + rows.join('\r\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.csv"' }
    });
  }

  return fail('المسار غير موجود.', 404);
}

async function sanitizeTeacher(body, existing, env) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) throw bad('اسم المعلم مطلوب (80 حرفًا كحد أقصى).');
  let slug = String(body.slug || existing?.slug || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  if (!slug && body.name) {
    slug = name.toLowerCase().replace(/[^\u0600-\u06FFa-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    // Arabic names produce no latin slug — fall back to a short random one
    if (!/^[a-z0-9-]{2,30}$/.test(slug)) slug = 't' + randomHex(4);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug)) throw bad('الرابط (slug) غير صالح: حروف إنجليزية صغيرة وأرقام وشرطات فقط (2-30).');
  if (RESERVED_SLUGS.has(slug)) throw bad('هذا الرابط محجوز.');
  // Field-preserving merge: only keys PRESENT in body.socialLinks override the stored
  // value (explicit '' clears it) — a partial update must never wipe sibling links.
  const social = { ...(existing?.socialLinks || {}) };
  for (const k of ['whatsapp', 'facebook', 'tiktok', 'youtube']) {
    if (body.socialLinks === undefined || body.socialLinks[k] === undefined) continue;
    const v = String(body.socialLinks[k] || '').trim();
    if (v && !/^https?:\/\//i.test(v)) throw bad('روابط التواصل يجب أن تبدأ بـ http:// أو https://');
    if (v.length > 300) throw bad('رابط التواصل طويل جدًا.');
    social[k] = v;
  }
  // Field-preserving PUT semantics: an ABSENT field keeps the stored value (explicit '' clears it).
  // Otherwise a partial update would silently wipe phone/email/social links or re-enable a disabled teacher.
  let phone = String(body.phone !== undefined ? body.phone : (existing?.phone ?? '')).trim();
  if (phone) {
    const np = normalizePhone(phone);
    phone = isValidEgMobile(np) ? np : phone.replace(/[\s\-.()]/g, '');
    if (!/^[0-9+]{4,25}$/.test(phone)) throw bad('رقم هاتف المعلم غير صالح.');
  }
  let photo = String(body.photo || existing?.photo || '');
  if (photo && !/^data:image\/(png|jpe?g|webp);base64,/i.test(photo)) throw bad('صورة غير صالحة.');
  if (photo && photo.length > 2.5 * 1024 * 1024) throw bad('حجم الصورة كبير جدًا (الحد 2.5 ميجابايت).');
  // الهوية البصرية موحدة للجميع (styles.css) — لا ألوان مخصصة لكل معلم؛
  // أي قيم colors قادمة من الطلب تُتجاهل ولا تُخزَّن.
  let email = String(body.email !== undefined ? body.email : (existing?.email ?? '')).trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('البريد الإلكتروني غير صالح.');
  let username = String(body.username !== undefined ? body.username : (existing?.username ?? '')).trim().toLowerCase();
  if (username && !/^[a-z0-9][a-z0-9_.-]{1,29}$/.test(username)) throw bad('اسم المستخدم غير صالح.');
  if (email || username) {
    const teachers = env ? await getTeachers(env).catch(() => []) : [];
    if (email && teachers.some((x, i) => (!existing || x.id !== existing.id) && x.email && x.email.toLowerCase() === email))
      throw bad('البريد الإلكتروني مستخدم بالفعل.');
    if (username && teachers.some((x, i) => (!existing || x.id !== existing.id) && x.username && x.username.toLowerCase() === username))
      throw bad('اسم المستخدم مستخدم بالفعل.');
  }
  let passHash = existing?.passHash || '';
  let passSalt = existing?.passSalt || '';
  let passIterations = existing?.passIterations || 120000;
  if (body.password && String(body.password).length >= 8) {
    passSalt = randomHex(16);
    passHash = await pbkdf2(String(body.password), passSalt);
    passIterations = 120000;
  } else if (body.password && String(body.password).length > 0 && String(body.password).length < 8) {
    throw bad('كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
  }

  // Admin-configured defaults apply only when creating a NEW teacher (existing is null)
  // and only when the request did not carry an explicit value for that field.
  const tdefs = (env && !existing) ? ((await getSettings(env).catch(() => null))?.teacherDefaults) : null;

  return {
    slug, name, phone, email, username, passHash, passSalt, passIterations,
    specialty: String(body.specialty ?? existing?.specialty ?? '').trim().slice(0, 120),
    bio: String(body.bio ?? existing?.bio ?? '').trim().slice(0, 500),
    photo,
    socialLinks: social,
    requirePhone: body.requirePhone !== undefined ? body.requirePhone !== false : (existing ? existing.requirePhone !== false : (tdefs ? tdefs.requirePhone !== false : true)),
    enabled: body.enabled !== undefined ? body.enabled !== false : (existing ? existing.enabled !== false : true),
    unlimited: body.unlimited !== undefined ? body.unlimited !== false : (existing ? existing.unlimited !== false : (tdefs ? tdefs.unlimited !== false : true)),
    maxAttempts: Math.max(1, Math.min(50, parseInt(body.maxAttempts ?? existing?.maxAttempts ?? tdefs?.maxAttempts ?? 3, 10) || 3)),
    offlineMode: body.offlineMode === true || (body.offlineMode === undefined && (existing ? existing.offlineMode === true : tdefs?.offlineMode === true)),
    // Student limit: a REAL unlimited flag (not a big number). When limited, studentLimit is the
    // max number of DISTINCT students (by normalized phone) who may register under this teacher.
    // 0 = registration closed for new students (existing students keep access).
    studentLimitUnlimited: body.studentLimitUnlimited === undefined
      ? (existing ? existing.studentLimitUnlimited !== false : (tdefs ? tdefs.studentLimitUnlimited !== false : true))
      : body.studentLimitUnlimited !== false,
    studentLimit: sanitizeStudentLimit(body.studentLimit ?? existing?.studentLimit ?? tdefs?.studentLimit ?? 0)
  };
}
function sanitizeStudentLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1000000, n);
}
function studentLimitOf(t) {
  if (!t) return { unlimited: true, limit: null };
  if (t.studentLimitUnlimited !== false) return { unlimited: true, limit: null };
  return { unlimited: false, limit: sanitizeStudentLimit(t.studentLimit) };
}
/* ============================ TEACHER AUTH ============================ */
const teacherLoginFails = new Map();
async function teacherCookiePayload(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)teacher_session=([^;]+)/);
  if (!m) return null;
  const secret = await getSessionSecret(env).catch(() => null);
  if (!secret) return null;
  return verifyToken(decodeURIComponent(m[1]), secret);
}
async function handleTeacherLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const fails = teacherLoginFails.get(ip) || { n: 0, until: 0 };
  if (fails.n >= 10 && Date.now() < fails.until) return fail('محاولات كثيرة.', 429);
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return fail('البريد/اسم المستخدم وكلمة المرور مطلوبان.');
  const teachers = await getTeachers(env);
  const t = teachers.find(x => x.enabled !== false && !x.archived &&
    ((x.email && x.email.toLowerCase() === email) || (x.username && x.username.toLowerCase() === email)));
  if (!t || !t.passHash) {
    teacherLoginFails.set(ip, { n: fails.n + 1, until: Date.now() + 15 * 60 * 1000 });
    return fail('بيانات الدخول غير صحيحة.', 401);
  }
  if (t.enabled === false || t.archived) return fail('حساب المعلم غير مفعّل.', 403);
  const hash = await pbkdf2(password, t.passSalt, t.passIterations || 120000);
  if (!safeEqualHex(hash, t.passHash)) {
    teacherLoginFails.set(ip, { n: fails.n + 1, until: Date.now() + 15 * 60 * 1000 });
    return fail('بيانات الدخول غير صحيحة.', 401);
  }
  teacherLoginFails.delete(ip);
  const secret = await getSessionSecret(env).catch(() => null);
  if (!secret) return fail('تهيئة الخادم غير مكتملة (KV).', 503);
  const v = randomHex(8);
  await addV(env, 'sessv:t:' + t.id, v); // server-side revocation registry
  const token = await signToken({ t: 'teacher', tid: t.id, slug: t.slug, v, exp: Math.floor(Date.now() / 1000) + TEACHER_SESSION_TTL }, secret);
  const res = json({ ok: true, name: t.name, slug: t.slug, id: t.id });
  const headers = new Headers(res.headers);
  headers.append('Set-Cookie', 'teacher_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + TEACHER_SESSION_TTL);
  return new Response(res.body, { status: res.status, headers });
}
async function requireTeacher(request, env) {
  const session = await teacherCookiePayload(request, env);
  if (!session || session.t !== 'teacher') return null;
  if (!(await hasV(env, 'sessv:t:' + session.tid, session.v))) return null; // revoked elsewhere → dead
  const teachers = await getTeachers(env);
  const t = teachers.find(x => x.id === session.tid);
  if (!t || t.enabled === false || t.archived) return null;
  return t;
}
async function handleTeacherAuthenticated(request, env, ctx, pathname) {
  const method = request.method;
  const teacher = await requireTeacher(request, env);
  if (!teacher) return fail('غير مصرح.', 401);
  if (method !== 'GET' && request.headers.get('X-Requested-With') !== 'fetch') return fail('طلب غير مصرح.', 403);
  if (pathname === '/api/t/password' && method === 'POST') {
    const body = await readJson(request);
    const current = String(body.current || ''); const next = String(body.next || '');
    if (!current || !next) return fail('كلمتا المرور مطلوبتان.');
    if (next.length < 8) return fail('كلمة المرور 8 أحرف على الأقل.');
    if (next === current) return fail('كلمتا المرور متطابقتان.');
    const curHash = await pbkdf2(current, teacher.passSalt, teacher.passIterations || 120000);
    if (!safeEqualHex(curHash, teacher.passHash)) return fail('كلمة المرور الحالية غير صحيحة.', 401);
    const salt = randomHex(16); const hash = await pbkdf2(next, salt);
    const teachers = await getTeachers(env);
    const idx = teachers.findIndex(x => x.id === teacher.id);
    if (idx === -1) return fail('المعلم غير موجود.', 404);
    teachers[idx] = { ...teachers[idx], passSalt: salt, passHash: hash, passIterations: 120000, updatedAt: new Date().toISOString() };
    await kvPut(env, 'teachers', JSON.stringify(teachers));
    // password change revokes every session, then re-issues the CURRENT device only
    const v = randomHex(8);
    await setVList(env, 'sessv:t:' + teacher.id, [v]);
    const secret2 = await getSessionSecret(env);
    const token = await signToken({ t: 'teacher', tid: teacher.id, slug: teacher.slug, v, exp: Math.floor(Date.now() / 1000) + TEACHER_SESSION_TTL }, secret2);
    const res = json({ ok: true });
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', 'teacher_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + TEACHER_SESSION_TTL);
    return new Response(res.body, { status: res.status, headers });
  }
  if (pathname === '/api/t/profile' && method === 'GET') {
    // The teacher's own safe profile (used to pre-fill the edit form — prevents the
    // "save blanks out fields you never saw" bug). Never exposes hashes/limits of others.
    return json({ teacher: {
      id: teacher.id, slug: teacher.slug, studentUrl: '/' + teacher.slug,
      phone: teacher.phone || '', email: teacher.email || '', username: teacher.username || '',
      hasPassword: !!teacher.passHash,
      ...teacherPublic(teacher)
    } });
  }
  if (pathname === '/api/t/profile' && method === 'POST') {
    const body = await readJson(request, 3 * 1024 * 1024);
    const teachers = await getTeachers(env);
    const idx = teachers.findIndex(x => x.id === teacher.id);
    if (idx === -1) return fail('المعلم غير موجود.', 404);
    const existing = teachers[idx]; const updated = { ...existing };
    updated.name = String(body.name || '').trim() || existing.name;
    if (updated.name.length > 80) throw bad('اسم المعلم طويل.');
    updated.phone = String(body.phone ?? existing.phone ?? '').trim();
    if (updated.phone) { const np = normalizePhone(updated.phone); updated.phone = isValidEgMobile(np) ? np : updated.phone.replace(/[\s\-.()]/g, ''); }
    const social = { ...(existing.socialLinks || {}) };
    for (const k of ['whatsapp', 'facebook', 'tiktok', 'youtube']) {
      if (body.socialLinks && body.socialLinks[k] !== undefined) {
        const v = String(body.socialLinks[k]).trim();
        if (v && !/^https?:\/\//i.test(v)) throw bad('روابط التواصل يجب أن تبدأ بـ http:// أو https://');
        if (v.length > 300) throw bad('رابط التواصل طويل جدًا.');
        social[k] = v;
      }
    }
    updated.socialLinks = social;
    updated.bio = String(body.bio ?? existing.bio ?? '').trim().slice(0, 500);
    if (body.photo !== undefined) {
      let photo = String(body.photo || '');
      if (photo && !/^data:image\/(png|jpe?g|webp);base64,/i.test(photo)) throw bad('صورة غير صالحة.');
      if (photo && photo.length > 2.5 * 1024 * 1024) throw bad('حجم الصورة كبير.');
      updated.photo = photo;
    }
    updated.updatedAt = new Date().toISOString();
    teachers[idx] = updated;
    await kvPut(env, 'teachers', JSON.stringify(teachers));
    return json({ ok: true, teacher: teacherPublic(updated) });
  }
  if (pathname === '/api/t/dashboard' && method === 'GET') {
    const tlist = await kvGetJson(env, 'results:teacher:' + teacher.slug).catch(() => null) || [];
    const slStatus = await studentLimitStatus(env, teacher);
    const students = Math.max(slStatus.current, new Set(tlist.map(r => (r.phone || '') + '|' + r.name)).size);
    const avg = tlist.length ? Math.round(tlist.reduce((n, r) => n + r.percentage, 0) / tlist.length * 100) / 100 : 0;
    const pass = tlist.filter(r => r.percentage >= 50).length;
    const highest = tlist.length ? Math.max(...tlist.map(r => r.percentage)) : 0;
    const lowest = tlist.length ? Math.min(...tlist.map(r => r.percentage)) : 0;
    const perExam = {};
    tlist.forEach(r => { const k = r.examId || r.examLabel; perExam[k] = perExam[k] || { examId: r.examId || '', title: r.examLabel || '', attempts: 0, sum: 0 }; perExam[k].attempts++; perExam[k].sum += r.percentage; });
    return json({ teacher: { id: teacher.id, name: teacher.name, slug: teacher.slug },
      totals: { results: tlist.length, students, registeredStudents: slStatus.current, avgPercentage: avg, passRate: tlist.length ? Math.round(pass / tlist.length * 10000) / 100 : 0, highestPercentage: highest, lowestPercentage: lowest },
      perExam: Object.values(perExam).map(e => ({ examId: e.examId, title: e.title, attempts: e.attempts, avgPercentage: Math.round(e.sum / e.attempts * 100) / 100 })).sort((a, b) => b.attempts - a.attempts),
      recent: tlist.slice(0, 10) });
  }
  if (pathname === '/api/t/students' && method === 'GET') {
    const tlist = await kvGetJson(env, 'results:teacher:' + teacher.slug).catch(() => null) || [];
    const slStatus = await studentLimitStatus(env, teacher);
    const studentMap = new Map();
    tlist.forEach(r => { const key = (r.phone || '') + '|' + normalizeName(r.name); if (!studentMap.has(key)) studentMap.set(key, { name: r.name, phone: r.phone || '', examCount: 0, totalScore: 0, totalPossible: 0, lastActivity: r.date, firstSeen: r.date }); const s = studentMap.get(key); s.examCount++; s.totalScore += r.score; s.totalPossible += r.total; if (new Date(r.date) > new Date(s.lastActivity)) s.lastActivity = r.date; if (new Date(r.date) < new Date(s.firstSeen)) s.firstSeen = r.date; });
    const url = new URL(request.url); const search = (url.searchParams.get('q') || '').trim().toLowerCase();
    let students = [...studentMap.values()];
    if (search) students = students.filter(s => s.name.toLowerCase().includes(search) || (s.phone && s.phone.includes(search)));
    students.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    return json({ total: students.length, registered: slStatus.current, students: students.map(s => ({ name: s.name, phone: s.phone, examCount: s.examCount, avgPercentage: s.totalPossible > 0 ? Math.round(s.totalScore / s.totalPossible * 10000) / 100 : 0, lastActivity: s.lastActivity, firstSeen: s.firstSeen })) });
  }
  if (pathname === '/api/t/results' && method === 'GET') {
    const tlist = await kvGetJson(env, 'results:teacher:' + teacher.slug).catch(() => null) || [];
    const url = new URL(request.url); const search = (url.searchParams.get('q') || '').trim().toLowerCase(); const subject = (url.searchParams.get('subject') || '').trim(); const examId = (url.searchParams.get('examId') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1); const perPage = 50;
    let results = tlist;
    if (search) results = results.filter(r => r.name.toLowerCase().includes(search) || (r.phone && r.phone.includes(search)));
    if (subject) results = results.filter(r => r.subject === subject);
    if (examId) results = results.filter(r => r.examId === examId);
    const total = results.length; const slice = results.slice((page - 1) * perPage, page * perPage);
    return json({ total, page, perPage, results: slice.map(r => ({ id: r.id, date: r.date, name: r.name, phone: r.phone, examId: r.examId, examLabel: r.examLabel, subject: r.subject, score: r.score, total: r.total, percentage: r.percentage })) });
  }
  return fail('المسار غير موجود.', 404);
}

function teacherAdminPayload(t) {
  const sl = studentLimitOf(t);
  return {
    id: t.id, teacherCode: t.teacherCode || '', slug: t.slug, name: t.name,
    email: t.email || '', username: t.username || '',
    phone: t.phone || '', specialty: t.specialty || '', bio: t.bio || '',
    photo: t.photo || '', socialLinks: t.socialLinks || {},
    requirePhone: t.requirePhone !== false, enabled: t.enabled !== false,
    archived: !!t.archived,
    unlimited: t.unlimited !== false, maxAttempts: t.maxAttempts || 3,
    offlineMode: t.offlineMode === true,
    studentLimitUnlimited: sl.unlimited, studentLimit: sl.limit,
    hasPassword: !!t.passHash,
    createdAt: t.createdAt || '', updatedAt: t.updatedAt || ''
  };
}
function teacherAdminSummary(t) {
  const sl = studentLimitOf(t);
  return {
    id: t.id, slug: t.slug, name: t.name, enabled: t.enabled !== false,
    unlimited: t.unlimited !== false, maxAttempts: t.maxAttempts || 3, offlineMode: t.offlineMode === true,
    studentLimitUnlimited: sl.unlimited, studentLimit: sl.limit
  };
}
/* Per-teacher distinct-student registry (one DO instance per teacher slug).
 * Returns { allowed, existing, count } — `allowed:false` only for a NEW student when the limit is reached. */
async function registerStudent(env, teacher, identity, { enforce }) {
  const stub = await limiterStub(env, 'students:' + teacher.slug);
  if (!stub) return null;
  const sl = studentLimitOf(teacher);
  const digest = hex(await crypto.subtle.digest('SHA-256', enc.encode(identity)));
  const body = { key: digest, unlimited: sl.unlimited, limit: sl.limit, enforce: !!enforce };
  return stub.fetch('https://limiter.internal/students/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json()).catch(() => null);
}
async function studentCount(env, teacher) {
  const stub = await limiterStub(env, 'students:' + teacher.slug);
  if (!stub) return 0;
  const st = await stub.fetch('https://limiter.internal/students/count').then(r => r.json()).catch(() => null);
  return st && Number.isFinite(st.count) ? st.count : 0;
}
async function studentLimitStatus(env, teacher) {
  const sl = studentLimitOf(teacher);
  const current = await studentCount(env, teacher);
  return {
    unlimited: sl.unlimited, limit: sl.limit, current,
    remaining: sl.unlimited ? null : Math.max(0, sl.limit - current)
  };
}
const STUDENT_LIMIT_MSG = 'اكتمل العدد المسموح به من الطلاب لدى هذا المعلم. تواصل مع المعلم للحصول على مقعد.';

/* ============================ attempt limiter (Durable Object) ============
 * Race-safe per-student attempt counting. Each (teacher, exam, student-identity)
 * maps to ONE DO instance (idFromName); /consume does an atomic
 * read-check-increment inside that single instance, so concurrent submissions
 * can never over-consume — unlike KV read-modify-write. Free plan includes DO. */
export class AttemptLimiter {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const url = new URL(request.url);
    const used = (await this.state.storage.get('used')) || 0;
    if (url.pathname === '/count' && request.method === 'GET') {
      return Response.json({ used });
    }
    /* ---- per-teacher distinct-student registry (instance = 'students:<slug>') ---- */
    if (url.pathname === '/students/count' && request.method === 'GET') {
      return Response.json({ count: (await this.state.storage.get('studentCount')) || 0 });
    }
    if (url.pathname === '/students/register' && request.method === 'POST') {
      let b = null;
      try { b = await request.json(); } catch {}
      if (!b || !/^[0-9a-f]{64}$/.test(String(b.key || ''))) return Response.json({ error: 'key required' }, 400);
      const unlimited = b.unlimited !== false;
      const limit = Math.max(0, parseInt(b.limit, 10) || 0);
      const enforce = b.enforce !== false;
      // Atomic: existing student → always allowed; new student → allowed only if under the limit.
      const result = await this.state.storage.transaction(async (txn) => {
        const count = (await txn.get('studentCount')) || 0;
        if (await txn.get('s:' + b.key)) return { allowed: true, existing: true, count };
        if (enforce && !unlimited && count >= limit) return { allowed: false, existing: false, count };
        await txn.put('s:' + b.key, Date.now());
        await txn.put('studentCount', count + 1);
        return { allowed: true, existing: false, count: count + 1 };
      });
      return Response.json(result);
    }
    if (url.pathname === '/consume' && request.method === 'POST') {
      let limit = 0;
      try { limit = Math.max(1, Math.min(50, parseInt((await request.json()).limit, 10) || 0)); } catch {}
      if (!limit) return Response.json({ error: 'limit required' }, 400);
      // Serializable storage transaction: the read-check-increment is atomic even
      // when concurrent consumes interleave at await points — the losers retry
      // and observe the incremented value. This is the race-safety guarantee.
      const result = await this.state.storage.transaction(async (txn) => {
        const cur = (await txn.get('used')) || 0;
        if (cur >= limit) return { allowed: false, used: cur, remaining: 0 };
        await txn.put('used', cur + 1);
        return { allowed: true, used: cur + 1, remaining: limit - cur - 1 };
      });
      return Response.json(result);
    }
    return new Response('not found', { status: 404 });
  }
}

async function limiterStub(env, key) {
  if (!env.ATTEMPT_LIMITER) return null;
  return env.ATTEMPT_LIMITER.get(env.ATTEMPT_LIMITER.idFromName('v1:' + key));
}
async function limitKey(slug, examId, identity) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(slug + '|' + examId + '|' + identity));
  return slug + ':' + examId + ':' + hex(digest).slice(0, 32);
}
// 0 = unlimited (default). A positive number = max submitted attempts per student per exam.
function teacherLimit(t) {
  if (!t || t.unlimited !== false) return 0;
  const n = parseInt(t.maxAttempts, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 3;
}
function studentIdentity(normPhone, name) {
  return normPhone ? 'p:' + normPhone : 'n:' + normalizeName(name);
}

/* ============================ main entry ============================ */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        try {
          return securityHeaders(await handleApi(request, env, ctx, pathname));
        } catch (e) {
          // Only ApiError messages reach the client; anything else is an internal fault → generic text, no details.
          if (e instanceof ApiError) return securityHeaders(fail(e.message, e.status));
          return securityHeaders(fail('خطأ غير متوقع في الخادم. حاول مرة أخرى.', 500));
        }
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return securityHeaders(fail('الطريقة غير مسموح بها.', 405));
      }

      // teacher SPA: /teacher (login + dashboard) — shell must always revalidate (assets are ?v= versioned)
      if (pathname === '/teacher' || pathname === '/teacher/' || pathname.startsWith('/teacher/')) {
        const res = await env.ASSETS.fetch(new URL('https://assets.internal/teacher.html'));
        const h = new Headers(res.headers); h.set('Cache-Control', 'no-cache');
        return securityHeaders(new Response(res.body, { status: 200, headers: h }));
      }

      // student SPA: / or /:slug ; admin SPA: /admin
      if (pathname === '/admin' || pathname === '/admin/') {
        const res = await env.ASSETS.fetch(new URL('https://assets.internal/admin.html'));
        const h = new Headers(res.headers); h.set('Cache-Control', 'no-cache');
        return securityHeaders(new Response(res.body, { status: 200, headers: h }));
      }

      if (pathname === '/' || pathname === '') {
        const res = await env.ASSETS.fetch(new URL('https://assets.internal/index.html'));
        return securityHeaders(new Response(res.body, { status: 200, headers: res.headers }));
      }

      // teacher slug route
      const slug = pathname.replace(/^\//, '').replace(/\/+$/, '');
      if (slug && /^[a-z0-9][a-z0-9-]{0,29}$/i.test(slug) && !slug.includes('.') && !pathname.slice(1).includes('/')) {
        if (!RESERVED_SLUGS.has(slug.toLowerCase())) {
          const teachers = await getTeachers(env).catch(() => DEFAULT_TEACHERS);
          const t = teachers.find(x => x.slug === slug.toLowerCase());
          if (t && t.enabled !== false) {
            const res = await env.ASSETS.fetch(new URL('https://assets.internal/index.html'));
            const headers = new Headers(res.headers);
            headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
            return securityHeaders(new Response(res.body, { status: 200, headers }));
          }
          const res = await env.ASSETS.fetch(new URL('https://assets.internal/index.html'));
          return securityHeaders(new Response(res.body, { status: 404, headers: res.headers }));
        }
      }

      // everything else: static assets (JS/CSS/icons) — cached for fast repeat loads
      const res = await env.ASSETS.fetch(request);
      if (res.status === 200 && /\.(js|css|svg)$/.test(pathname)) {
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'public, max-age=3600');
        return securityHeaders(new Response(res.body, { status: res.status, headers }));
      }
      return securityHeaders(res);
    } catch (e) {
      return securityHeaders(fail('خطأ في الخادم.', 500));
    }
  }
};
