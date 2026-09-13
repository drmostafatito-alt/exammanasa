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

/* سياسة محتوى مقيدة قدر الإمكان بدون كسر التطبيق (الواجهة تستخدم معالجات
 * onclick داخلية وألوانًا تُضبط عبر CSSOM، لذا 'unsafe-inline' مطلوب فعليًا).
 * القيمة الحقيقية هنا: frame-ancestors 'none' (يمنع التأطير/النقر المخفي)،
 * object-src 'none'، base-uri 'self'، form-action 'self'. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

function securityHeaders(res) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  h.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(res.body, { status: res.status, headers: h });
}

/* إزالة محارف التحكم (CR/LF/TAB… ) من النصوص الحرة: تمنع تسميم CSV/السجلات وتمنع
 * كسر العرض، دون المساس بأي نص سؤال (الأسئلة لا تمرّ عبر هذه الدالة أبدًا). */
function stripControl(value, max) {
  let s = String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

/* طبقة حماية ثانية ضد CSRF: المتصفح يرسل Origin دائمًا مع الطلبات بين المواقع.
 * غياب الترويسة يعني عميلًا غير متصفح (اختبارات/curl) — مسموح. */
function hostOf(value) {
  try { return new URL(String(value)).host; } catch (e) { return ''; }
}
function isLoopbackHost(h) {
  const name = String(h || '').replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}
function crossSiteRequest(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const oh = hostOf(origin);
  if (!oh) return true; // Origin غير قابل للتحليل → ارفض احتياطًا
  const rh = request.headers.get('Host') || '';
  if (oh === rh) return false;
  if (isLoopbackHost(oh) && isLoopbackHost(rh)) return false; // تطوير محلي بمنفذ مختلف
  return true;
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
  // constant-time: the comparison must not leak where a forged signature diverged
  if (!safeEqualHex(expected, parts[1])) return null;
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
  return DEFAULT_TEACHERS.map(t => Object.assign({}, t));
}

/* صور المعلمين تُخزَّن في مفتاح منفصل لكل معلم (teacher:photo:<id>) بدل أن توضع
 * داخل مستند `teachers` نفسه. سبب القرار: حد القيمة الواحدة في KV هو ٢٥ ميجابايت،
 * وصورة واحدة بصيغة data-URL قد تصل إلى ٢.٥ ميجابايت — أي أن ~١٠ معلمين بصور كان
 * يكفي لإيقاف كتابة قائمة المعلمين كلها (فشل إضافة/تعديل أي معلم). بهذا الفصل يبقى
 * مستند القائمة خفيفًا مهما كثر المعلمون، ومفتاح الصورة يُكتب فقط عند تغيّرها. */
async function kvDelete(env, key) { try { if (env.PLATFORM_KV) await env.PLATFORM_KV.delete(key); } catch (e) { } }
async function getTeacherPhoto(env, id) {
  if (!id) return '';
  return (await kvGet(env, 'teacher:photo:' + id).catch(() => null)) || '';
}
/* تحميل الصور فقط حيث يحتاجها العرض فعليًا (لا تُقرأ في المسار الساخن للامتحان). */
async function hydratePhotos(env, list) {
  if (!Array.isArray(list) || !list.length) return list;
  await Promise.all(list.map(async t => { if (!t.photo) t.photo = await getTeacherPhoto(env, t.id); }));
  return list;
}
async function hydrateTeacher(env, t) {
  if (!t) return t;
  if (!t.photo) t.photo = await getTeacherPhoto(env, t.id);
  return t;
}
function leanTeacher(t) { const c = Object.assign({}, t); delete c.photo; return c; }
function leanTeachers(list) { return (list || []).map(leanTeacher); }
/* يكتب القائمة (بلا صور) + مفاتيح الصور المُعدَّلة فقط (photoUpdates: { id: dataUrl }).
 * تمرير {} يعني «لا تغيير على الصور» — لا قراءة ولا كتابة إضافية (حصة KV المجانية). */
async function saveTeachers(env, teachers, photoUpdates) {
  const payload = JSON.stringify(leanTeachers(teachers));
  // حد القيمة الواحدة في KV هو ٢٥ ميجابايت — نرفض مبكرًا برسالة واضحة بدل
  // فشل كتابة غامض (500) يترك المسؤول بلا تفسير.
  if (payload.length > 20 * 1024 * 1024) {
    throw bad('حجم بيانات المعلمين تجاوز الحد المسموح (٢٠ ميجابايت). احذف بعض الحسابات المؤرشفة أو ارفع مساحة التخزين.', 413);
  }
  await kvPut(env, 'teachers', payload);
  for (const id of Object.keys(photoUpdates || {})) {
    const photo = photoUpdates[id] || '';
    if (photo) await kvPut(env, 'teacher:photo:' + id, photo);
    else await kvDelete(env, 'teacher:photo:' + id);
  }
}
async function saveArchived(env, archived) {
  await kvPut(env, 'teachers:archived', JSON.stringify(leanTeachers(archived).slice(0, 200)));
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

/* ============================ content overlay — Admin CMS ============================
 * بنك الإنتاج الأساسي (banks.json المولَّد من ملفات .gs المدقَّقة) لا يُعاد توليده
 * ولا يُعدَّل هنا أبدًا: كل تعديل يجريه المسؤول (تعديل سؤال/حذفه/تكراره/إضافته،
 * تعديل امتحان/عنوانه/ترتيبه/تعطيله، استيراد امتحان من ملف، تصدير) يُخزَّن كطبقة
 * فوقية صغيرة في KV تحت المفتاح `content:overrides` وتُدمج مع الأساس عند القراءة.
 * النتائج: بنك الإنتاج يبقى diff = 0، كل تعديل موثَّق وقابل للتراجع («استعادة
 * الأصل»)، والمفاتيح لا تغادر الخادم أبدًا (نفس قواعد الأمان القائمة). */
const CONTENT_KEY = 'content:overrides';
const CONTENT_CACHE_MS = 5000; // قراءة KV مرة كل ٥ ثوانٍ كحد أقصى لكل عزلة
let _contentCache = null;      // { doc, view, catalog, pubExams, at }

function blankContent() {
  return { version: 1, updatedAt: null, questions: {}, deletedQuestions: [], exams: {}, deletedExams: [] };
}
function normalizeContentDoc(d) {
  const o = blankContent();
  if (!d || typeof d !== 'object') return o;
  if (d.questions && typeof d.questions === 'object' && !Array.isArray(d.questions)) o.questions = d.questions;
  if (Array.isArray(d.deletedQuestions)) o.deletedQuestions = d.deletedQuestions.filter(x => typeof x === 'string');
  if (d.exams && typeof d.exams === 'object' && !Array.isArray(d.exams)) o.exams = d.exams;
  if (Array.isArray(d.deletedExams)) o.deletedExams = d.deletedExams.filter(x => typeof x === 'string');
  if (typeof d.updatedAt === 'string') o.updatedAt = d.updatedAt;
  return o;
}
async function getContentDoc(env) {
  const now = Date.now();
  if (_contentCache && now - _contentCache.at < CONTENT_CACHE_MS) return _contentCache.doc;
  const doc = normalizeContentDoc(await kvGetJson(env, CONTENT_KEY).catch(() => null));
  _contentCache = { doc, at: now, view: null, catalog: null, pubExams: null };
  return doc;
}
function invalidateContentCache() { _contentCache = null; }
async function saveContentDoc(env, doc) {
  doc.version = 1;
  doc.updatedAt = new Date().toISOString();
  await kvPut(env, CONTENT_KEY, JSON.stringify(doc));
  _contentCache = { doc, at: Date.now(), view: null, catalog: null, pubExams: null };
  return doc;
}

/* حقول وصف الامتحان القابلة للتعديل من الإدارة (لا شيء حساس) */
const EXAM_META_KEYS = ['title', 'subjectId', 'term', 'type', 'unitTitle', 'chapterTitle', 'lessonTitle', 'lessonNo', 'topicKey', 'topicNo', 'topicTitle', 'training', 'variant', 'grade'];

/* دمج الأساس + الطبقة الفوقية → منظر فعّال واحد لكل القراءات */
function buildView(doc) {
  const delQ = new Set(doc.deletedQuestions), delE = new Set(doc.deletedExams);
  const questions = {};
  for (const id of Object.keys(BANKS.questions)) {
    if (delQ.has(id)) continue;
    const base = BANKS.questions[id];
    const p = doc.questions[id];
    questions[id] = p
      ? Object.assign({}, base, p, { id, meta: Object.assign({}, base.meta || {}, p.meta || {}) })
      : base;
  }
  for (const id of Object.keys(doc.questions)) {
    if (questions[id] || delQ.has(id)) continue;
    const q = doc.questions[id];
    if (q && q.custom === true) questions[id] = Object.assign({ id }, q);
  }
  const examDefs = {}, exams = {};
  for (const id of Object.keys(BANKS.examDefs)) {
    if (delE.has(id)) continue;
    const p = doc.exams[id];
    let ids = Array.isArray(p && p.questionIds) ? p.questionIds.filter(q => typeof q === 'string') : BANKS.examDefs[id];
    ids = ids.filter(qid => questions[qid]);
    examDefs[id] = ids;
    const meta = Object.assign({}, BANKS.exams[id]);
    if (p) for (const k of EXAM_META_KEYS) if (p[k] !== undefined) meta[k] = p[k];
    meta.id = id;
    meta.custom = false;
    meta.enabled = (p && p.enabled === false) ? false : true;
    meta.modified = !!(p && (Array.isArray(p.questionIds) || EXAM_META_KEYS.some(k => p[k] !== undefined)));
    meta.count = ids.length;
    exams[id] = meta;
  }
  for (const id of Object.keys(doc.exams)) {
    if (exams[id] || delE.has(id)) continue;
    const p = doc.exams[id];
    if (!p || p.custom !== true) continue;
    const ids = (Array.isArray(p.questionIds) ? p.questionIds : []).filter(qid => questions[qid]);
    examDefs[id] = ids;
    const meta = { id, custom: true };
    for (const k of EXAM_META_KEYS) if (p[k] !== undefined) meta[k] = p[k];
    if (!meta.title) meta.title = 'امتحان';
    if (meta.subjectId !== 'psychology') meta.subjectId = 'philosophy';
    if (!meta.type) meta.type = 'custom';
    meta.enabled = p.enabled !== false;
    meta.modified = true;
    meta.createdAt = p.createdAt || '';
    meta.updatedAt = p.updatedAt || '';
    meta.count = ids.length;
    exams[id] = meta;
  }
  return { questions, examDefs, exams };
}

/* فهرس الطلاب العام: يُستبعد المعطّل/المحذوف حتى لا يصل إليه طالب أبدًا،
 * وتُضاف الامتحانات المخصّصة (المستوردة/المنشأة) كمجموعة مستقلة لكل مادة. */
function buildCatalog(view) {
  const cat = JSON.parse(JSON.stringify(BANKS.catalog));
  const live = (id) => !!(view.exams[id] && view.exams[id].enabled !== false);
  if (cat.psychology && Array.isArray(cat.psychology.units)) {
    cat.psychology.units = cat.psychology.units.map(u => Object.assign({}, u, {
      lessons: (u.lessons || []).filter(l => (l.examIds || []).some(live))
    })).filter(u => u.lessons.length || live(u.comprehensiveExamId));
    if (!live(cat.psychology.subjectComprehensiveExamId)) cat.psychology.subjectComprehensiveExamId = null;
  }
  if (cat.philosophy && Array.isArray(cat.philosophy.terms)) {
    cat.philosophy.terms = cat.philosophy.terms.map(t => Object.assign({}, t, {
      sections: (t.sections || []).map(s => Object.assign({}, s, {
        topics: (s.topics || []).map(tp => Object.assign({}, tp, {
          lessons: (tp.lessons || []).map(l => Object.assign({}, l, {
            trainings: (l.trainings || []).filter(tr => live(tr.examId))
          })).filter(l => l.trainings.length)
        })).filter(tp => tp.lessons.length)
      })).filter(s => s.topics.length),
      comprehensiveExamIds: (t.comprehensiveExamIds || []).filter(live)
    }));
  }
  for (const sid of ['psychology', 'philosophy']) {
    const list = Object.keys(view.exams)
      .filter(id => view.exams[id].custom === true && view.exams[id].subjectId === sid && view.exams[id].enabled !== false)
      .map(id => ({ id, title: view.exams[id].title, count: view.exams[id].count, term: view.exams[id].term == null ? null : view.exams[id].term, grade: view.exams[id].grade || '' }));
    if (cat[sid]) cat[sid].custom = list;
  }
  return cat;
}
function buildPublicExams(view) {
  const out = {};
  for (const id of Object.keys(view.exams)) {
    const e = view.exams[id];
    if (e.enabled === false) continue;
    // وصف الامتحان فقط (بلا أي مفاتيح/قوائم أسئلة) — التصحيح على الخادم حصرًا.
    const pub = Object.assign({}, e);
    delete pub.modified;
    delete pub.enabled;
    out[id] = pub;
  }
  return out;
}
async function contentView(env) {
  const now = Date.now();
  if (_contentCache && now - _contentCache.at < CONTENT_CACHE_MS && _contentCache.view) {
    return { doc: _contentCache.doc, view: _contentCache.view, catalog: _contentCache.catalog, pubExams: _contentCache.pubExams };
  }
  const doc = await getContentDoc(env);
  const view = buildView(doc);
  const catalog = buildCatalog(view);
  const pubExams = buildPublicExams(view);
  _contentCache = { doc, view, catalog, pubExams, at: now };
  return { doc, view, catalog, pubExams };
}

/* ---- تحقق موحّد للسؤال (إنشاء/تعديل/استيراد) — الخادم هو الحكم ---- */
function sanitizeQuestionInput(body, existing) {
  const b = body && typeof body === 'object' ? body : {};
  const text = String(b.text === undefined && existing ? existing.text : (b.text == null ? '' : b.text)).replace(/\s+$/g, '').trim();
  if (!text) throw bad('نص السؤال مطلوب.');
  if (text.length > 3000) throw bad('نص السؤال طويل جدًا (الحد 3000 حرف).');
  /* Field-preserving: عند التعديل يكفي إرسال الحقول المراد تغييرها (الخيارات/المفتاح
   * تُترك كما هي إن لم تُرسل) — أما الإنشاء فيطلب الحقول كاملة. */
  let rawOpts = null;
  if (Array.isArray(b.options)) rawOpts = b.options;
  else if (b.options && typeof b.options === 'object') rawOpts = ['A', 'B', 'C', 'D'].map(k => b.options[k]);
  else if (existing && Array.isArray(existing.options)) rawOpts = existing.options;
  if (!rawOpts) throw bad('الخيارات الأربعة مطلوبة.');
  const options = rawOpts.map(o => String(o == null ? '' : o).trim().slice(0, 600));
  if (options.length !== 4) throw bad('يجب إدخال أربعة خيارات بالضبط (أ/ب/ج/د).');
  if (options.some(o => !o)) throw bad('لا يُسمح بخيار فارغ.');
  const hasAnswer = b.answer !== undefined || b.correctAnswer !== undefined;
  const answer = String(hasAnswer ? (b.answer != null ? b.answer : b.correctAnswer) : (existing ? existing.answer : '')).trim().toUpperCase();
  if (!answer) throw bad('الإجابة الصحيحة مطلوبة.');
  if (!/^[ABCD]$/.test(answer)) throw bad('الإجابة الصحيحة يجب أن تكون أحد الحروف A أو B أو C أو D.');
  const meta = Object.assign({}, (existing && existing.meta) || {});
  const m = b.meta && typeof b.meta === 'object' ? b.meta : b;
  const setMeta = (key, src, max) => { if (src !== undefined) meta[key] = String(src == null ? '' : src).trim().slice(0, max || 200); };
  setMeta('subject', m.subject); setMeta('subjectId', m.subjectId); setMeta('unit', m.unit, 80);
  setMeta('lesson', m.lesson); setMeta('topic', m.topic); setMeta('chapter', m.chapter);
  setMeta('source', m.source); setMeta('difficulty', m.difficulty, 40);
  if (m.term !== undefined) meta.term = (m.term === null || m.term === '') ? null : (parseInt(m.term, 10) === 2 ? 2 : 1);
  if (meta.subjectId === 'psychology') meta.subject = meta.subject || 'علم النفس';
  else if (meta.subjectId === 'philosophy') meta.subject = meta.subject || 'الفلسفة والمنطق';
  return { text, options, answer, meta };
}
/* تطبيع نص السؤال لاكتشاف المكرر (يتجاهل التشكيل والفراغات وعلامات الترقيم) */
function normalizeQuestionText(s) {
  return String(s || '').replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[\s\u00A0]+/g, ' ')
    .replace(/[.,،؛:!?؟()"«»'\-ـ]/g, '')
    .trim();
}
function questionFingerprint(view, text) {
  return normalizeQuestionText(text);
}
function buildTextIndex(view) {
  const idx = new Map();
  for (const id of Object.keys(view.questions)) {
    const fp = questionFingerprint(view, view.questions[id].text);
    if (fp && !idx.has(fp)) idx.set(fp, id);
  }
  return idx;
}
/* معرفات فريدة للطبقة الفوقية (بادئة مميّزة لا تصطدم بمعرفات البنك الأصلية) */
function uniqueQuestionId(doc) {
  for (let i = 0; i < 500; i++) {
    const id = 'CQ-' + randomHex(4).toUpperCase();
    if (!doc.questions[id] && !BANKS.questions[id]) return id;
  }
  return 'CQ-' + randomHex(8).toUpperCase();
}
function uniqueExamId(doc) {
  for (let i = 0; i < 500; i++) {
    const id = 'CX-' + randomHex(4).toUpperCase();
    if (!doc.exams[id] && !BANKS.examDefs[id]) return id;
  }
  return 'CX-' + randomHex(8).toUpperCase();
}
/* تنسيق التصدير/الاستيراد القياسي (موثّق في docs/exam-import-format.md) */
function examToCanonical(view, examId) {
  const e = view.exams[examId];
  const ids = view.examDefs[examId] || [];
  return {
    version: 1,
    platform: 'exammanasa',
    exportedAt: new Date().toISOString(),
    exam: {
      id: examId,
      title: e.title,
      subject: e.subjectId === 'psychology' ? 'علم النفس' : 'الفلسفة والمنطق',
      subjectId: e.subjectId,
      term: e.term == null ? null : e.term,
      grade: e.grade || (e.subjectId === 'psychology' ? 'الصف الثاني الثانوي' : 'الصف الأول الثانوي'),
      type: e.type || 'custom',
      unitTitle: e.unitTitle || '', lessonTitle: e.lessonTitle || ''
    },
    questions: ids.map(qid => {
      const q = view.questions[qid];
      return {
        id: qid,
        text: q.text,
        options: { A: q.options[0], B: q.options[1], C: q.options[2], D: q.options[3] },
        correctAnswer: q.answer,
        meta: q.meta || {}
      };
    })
  };
}
/* تحليل ملف الاستيراد + التحقق الكامل (بلا أي حفظ) → تقرير معاينة */
function parseImportPayload(rawText) {
  let data;
  try { data = JSON.parse(String(rawText)); } catch (e) {
    throw bad('الملف ليس JSON صالحًا — تأكد من تنزيله بصيغة UTF-8 دون إضافات.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('بنية الملف غير صحيحة: يُتوقع كائن JSON يحتوي exam و questions.');
  const ex = data.exam && typeof data.exam === 'object' ? data.exam : {};
  const title = String(ex.title == null ? '' : ex.title).trim();
  const subjectRaw = String(ex.subject == null ? (ex.subjectId == null ? '' : ex.subjectId) : ex.subject).trim();
  const subjectId = /^(psychology|psych)$/i.test(subjectRaw) || subjectRaw.includes('علم النفس') ? 'psychology'
    : /^(philosophy|philo)$/i.test(subjectRaw) || subjectRaw.includes('فلسفة') ? 'philosophy' : '';
  const termRaw = ex.term == null ? null : ex.term;
  const term = termRaw === null || termRaw === '' ? null : (String(termRaw).includes('2') || String(termRaw).includes('الثاني') ? 2 : 1);
  const grade = String(ex.grade == null ? '' : ex.grade).trim().slice(0, 80);
  const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
  return { title, subjectId, term, grade, rawQuestions, version: data.version == null ? 1 : data.version };
}
function validateImport(parsed, view) {
  const errors = [], warnings = [], rows = [];
  const textIndex = buildTextIndex(view);
  const seenInFile = new Map();
  if (!parsed.title) errors.push({ where: 'exam.title', message: 'اسم الامتحان مطلوب (exam.title).' });
  if (!parsed.subjectId) errors.push({ where: 'exam.subject', message: 'المادة مطلوبة: «الفلسفة والمنطق» أو «علم النفس» (exam.subject).' });
  if (!parsed.rawQuestions.length) errors.push({ where: 'questions', message: 'لا توجد أسئلة في الملف (questions).' });
  if (parsed.rawQuestions.length > 200) errors.push({ where: 'questions', message: 'عدد الأسئلة كبير جدًا (الحد 200 سؤال لكل امتحان).' });
  parsed.rawQuestions.forEach((q, i) => {
    const at = 'questions[' + i + ']';
    const row = { index: i + 1, text: '', options: { A: '', B: '', C: '', D: '' }, correctAnswer: '', status: 'new', existingId: null, problems: [] };
    if (!q || typeof q !== 'object') { row.problems.push('السجل ليس كائنًا.'); row.status = 'invalid'; rows.push(row); errors.push({ where: at, message: 'السجل ليس كائنًا صالحًا.' }); return; }
    const text = String(q.text == null ? '' : q.text).trim();
    row.text = text;
    if (!text) { row.problems.push('نص السؤال فارغ.'); errors.push({ where: at + '.text', message: 'نص السؤال فارغ.' }); }
    else if (text.length > 3000) { row.problems.push('نص السؤال أطول من 3000 حرف.'); errors.push({ where: at + '.text', message: 'نص السؤال أطول من 3000 حرف.' }); }
    let opts = null;
    if (Array.isArray(q.options)) opts = q.options;
    else if (q.options && typeof q.options === 'object') opts = ['A', 'B', 'C', 'D'].map(k => q.options[k]);
    if (!opts) { row.problems.push('الخيارات مفقودة.'); errors.push({ where: at + '.options', message: 'الخيارات مفقودة (options بكائن A-D أو مصفوفة من 4).' }); }
    else {
      opts = opts.map(o => String(o == null ? '' : o).trim());
      if (opts.length !== 4) { row.problems.push('عدد الخيارات ' + opts.length + ' وليس 4.'); errors.push({ where: at + '.options', message: 'عدد الخيارات ' + opts.length + ' — المطلوب 4 بالضبط.' }); }
      else {
        opts.forEach((o, k) => { row.options['ABCD'[k]] = o; if (!o) { row.problems.push('الخيار ' + 'ABCD'[k] + ' فارغ.'); errors.push({ where: at + '.options.' + 'ABCD'[k], message: 'الخيار ' + 'ABCD'[k] + ' فارغ.' }); } });
        if (new Set(opts).size !== opts.length) { row.problems.push('خيارات مكررة داخل السؤال.'); warnings.push('السؤال ' + (i + 1) + ': خيارات مكررة داخل السؤال نفسه.'); }
      }
    }
    const ans = String(q.correctAnswer != null ? q.correctAnswer : (q.answer != null ? q.answer : '')).trim().toUpperCase();
    row.correctAnswer = ans;
    if (!/^[ABCD]$/.test(ans)) { row.problems.push('الإجابة الصحيحة غير صالحة: «' + ans + '».'); errors.push({ where: at + '.correctAnswer', message: 'الإجابة الصحيحة يجب أن تكون A/B/C/D — الوارد: «' + ans + '».' }); }
    const fp = questionFingerprint(view, text);
    if (fp) {
      if (seenInFile.has(fp)) { row.status = 'duplicate-file'; row.existingId = seenInFile.get(fp); row.problems.push('مكرر داخل الملف نفسه (سؤال ' + row.existingId + ').'); warnings.push('السؤال ' + (i + 1) + ' مكرر داخل الملف نفسه — سيُضاف مرة واحدة.'); }
      else {
        seenInFile.set(fp, i + 1);
        const bankId = textIndex.get(fp);
        if (bankId) { row.status = 'exists'; row.existingId = bankId; warnings.push('السؤال ' + (i + 1) + ' موجود بالفعل في البنك (' + bankId + ') — سيُربط الموجود دون تكرار.'); }
      }
    }
    if (row.problems.length && row.status !== 'duplicate-file') row.status = 'invalid';
    rows.push(row);
  });
  const stats = {
    total: rows.length,
    invalid: rows.filter(r => r.status === 'invalid').length,
    existsInBank: rows.filter(r => r.status === 'exists').length,
    duplicateInFile: rows.filter(r => r.status === 'duplicate-file').length,
    newCount: rows.filter(r => r.status === 'new').length
  };
  return {
    ok: errors.length === 0 && stats.total > 0,
    exam: { title: parsed.title, subjectId: parsed.subjectId, term: parsed.term, grade: parsed.grade },
    stats, errors, warnings, rows
  };
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
  const teachers = await getTeachers(env).catch(() => DEFAULT_TEACHERS.map(t => Object.assign({}, t)));
  const owner = await hydrateTeacher(env, ownerTeacher(teachers));
  const { catalog, pubExams } = await contentView(env);
  return {
    version: BANKS.version, generatedAt: BANKS.generatedAt,
    catalog, exams: pubExams,
    owner: owner ? teacherPublic(owner) : null
  };
}

function teacherPublic(t) {
  return {
    slug: t.slug, name: t.name, specialty: t.specialty || '', bio: t.bio || '', photo: t.photo || '',
    photoFit: t.photoFit === 'cover' ? 'cover' : (t.photoFit === 'contain' ? 'contain' : ''),
    socialLinks: t.socialLinks || {},
    requirePhone: !!t.requirePhone
  };
}

async function handleApi(request, env, ctx, pathname) {
  // HEAD must behave exactly like GET (same routing, empty body).
  const method = request.method === 'HEAD' ? 'GET' : request.method;

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
    await hydrateTeacher(env, t);
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
    const cv = await contentView(env);
    const examMeta = cv.view.exams[examId];
    if (!examMeta) return fail('الامتحان غير موجود.', 404);
    if (examMeta.enabled === false) return fail('الامتحان غير متاح حاليًا.', 404);
    const ids = cv.view.examDefs[examId];
    if (!ids || !ids.length) return fail('الامتحان غير متاح حاليًا.', 404);

    // محارف التحكم تُزال (تمنع تسميم CSV/السجلات) — نص السؤال لا يمرّ هنا أبدًا.
    const name = stripControl(body.name, 120);
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
      qcount: ids.length,
      slug, iss, exp: iss + ttl
    }, secret);

    const questions = ids.map((qid, i) => {
      const q = cv.view.questions[qid];
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
    const cv = await contentView(env);
    const sessDefs = cv.view.examDefs[sess.examId];
    const sessMeta = cv.view.exams[sess.examId];
    if (!sessDefs || !sessMeta || sessMeta.enabled === false) return fail('الامتحان غير متاح حاليًا — أعد فتحه من قائمة الامتحانات.', 404);
    // A live content edit that changed the exam size after this session started would
    // desync the seeded shuffle — refuse politely instead of mis-grading. يجب أن يسبق
    // فحص عدد الإجابات، وإلا استحال الوصول إليه (تغيير الحجم يغيّر الطول أيضًا).
    if (Number.isInteger(sess.qcount) && sess.qcount !== sessDefs.length) {
      return fail('تم تحديث هذا الامتحان أثناء الجلسة — أعد فتح الامتحان ثم سلّم إجاباتك.', 409);
    }
    if (!Array.isArray(answers) || answers.length !== sessDefs.length) {
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
    const ids = sessDefs;
    const examMeta = sessMeta;
    let score = 0;
    const review = ids.map((qid, i) => {
      const q = cv.view.questions[qid];
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
          const tslug = result.teacherSlug || '';
          const entry = { id: result.id, date: result.date, name: result.name, phone: result.phone, examId: result.examId, examLabel: result.examLabel, subject: result.subject, total, score, percentage, teacherSlug: tslug };
          /* The indices are a single KV key each, so a plain read-modify-write loses
           * an entry whenever two submissions interleave. The limiter DO appends
           * inside a storage transaction (serialised), so ordering is atomic; KV is
           * then overwritten with the DO's authoritative list (no read-modify-write). */
          const idx = await resultIndexAppend(env, entry, tslug).catch(() => null);
          if (idx) {
            await env.PLATFORM_KV.put('results:recent', JSON.stringify(idx.recent)).catch(() => {});
            if (tslug && idx.mine) await env.PLATFORM_KV.put('results:teacher:' + tslug, JSON.stringify(idx.mine)).catch(() => {});
          } else {
            // DO unavailable → degrade to the previous best-effort append
            await kvAppendResult(env, 'results:recent', entry, 100, true).catch(() => {});
            if (tslug) await kvAppendResult(env, 'results:teacher:' + tslug, entry, 200, false).catch(() => {});
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
/* خريطة الإخفاقات تعيش بعمر الـisolate نفسِه — فلو لم تُنظَّف لأمكن لرشٍّ من محاولات
 * دخول فاشلة من آلاف الـIP أن يضخّمها بلا حد (تسريب ذاكرة/تضخيم). كنس الداخل المنتهي
 * عند كل محاولة، وسقف صلب يتخلص من الأقدم عند تجاوزه. */
function sweepThrottles(map) {
  const now = Date.now();
  if (map.size >= 256) {
    for (const [k, v] of map) if (!v.until || v.until <= now) map.delete(k);
  }
  if (map.size > 4096) {
    let excess = map.size - 4096;
    for (const k of map.keys()) { if (excess-- <= 0) break; map.delete(k); }
  }
  return map;
}

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

  /* ---------- حالة الإعداد الأولي (عام — لا يكشف إلا وجود حساب من عدمه) ----------
   * كان اكتشاف «أول تشغيل» يتم بمحاولة دخول ببيانات فارغة على /api/admin/login؛
   * وبما أن هذا المسار خاضع لحد المحاولات، كان استنفاد المحاولات من نفس IP يخفي
   * شاشة الإعداد الأولي عن المالك على نشر جديد. نقطة حالة مخصّصة تحل المشكلة. */
  if (pathname === '/api/admin/status' && method === 'GET') {
    /* نقطة حالة واحدة لبدء التشغيل: هل يحتاج المالك إعدادًا أوليًا؟ وهل لديه جلسة
     * سارية؟ — دمجتهما في طلب واحد حتى لا يبدأ التطبيق بطلب /status ثم /session.
     * البريد يُرسَل فقط مع جلسة سارية (لا كشف لحساب بلا مصادقة). */
    const admin = await getAdminRecord(env).catch(() => null);
    const session = await adminCookiePayload(request, env).catch(() => null);
    const authed = !!(admin && session && session.t === 'admin' && await hasV(env, 'sessv:admin', session.v));
    return json({
      setup: !admin,
      authed,
      email: authed ? session.email : undefined,
      envBootstrap: !!(env.ADMIN_INITIAL_EMAIL && env.ADMIN_INITIAL_PASSWORD)
    }, 200, { 'Cache-Control': 'no-store' });
  }

  /* ---------- login ---------- */
  if (pathname === '/api/admin/login' && method === 'POST') {
    sweepThrottles(loginFails);
    const fails = loginFails.get(ip) || { n: 0, until: 0 };
    if (fails.n >= 10 && Date.now() < fails.until) return fail('محاولات كثيرة. حاول بعد قليل.', 429);

    if (crossSiteRequest(request)) return fail('طلب من مصدر آخر مرفوض.', 403);
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
    // الإعداد الأولي يُنشئ مالك المنصة — يجب ألا يكون قابلًا للاستدعاء من صفحة
    // أخرى (CSRF)، لذا يُشترط نفس ترويسة الطلب المخصّصة (المتصفح لا يستطيع
    // إضافتها عبر المصادر دون preflight فاشل).
    if (request.headers.get('X-Requested-With') !== 'fetch') return fail('طلب غير مصرح.', 403);
    if (crossSiteRequest(request)) return fail('طلب من مصدر آخر مرفوض.', 403);
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
  // CSRF defense for state-changing endpoints: SameSite=Strict cookie + custom header + Origin/Host check
  if (method !== 'GET') {
    if (request.headers.get('X-Requested-With') !== 'fetch') return fail('طلب غير مصرح.', 403);
    if (crossSiteRequest(request)) return fail('طلب من مصدر آخر مرفوض.', 403);
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
    const cv = await contentView(env);
    const allExams = Object.values(cv.view.exams);
    const doc = cv.doc;
    return json({
      exams: allExams.length,
      questions: Object.keys(cv.view.questions).length,
      customExams: allExams.filter(e => e.custom === true).length,
      customQuestions: Object.values(cv.view.questions).filter(q => q.custom === true).length,
      disabledExams: allExams.filter(e => e.enabled === false).length,
      deletedQuestions: doc.deletedQuestions.length,
      deletedExams: doc.deletedExams.length,
      editedQuestions: Object.keys(doc.questions).filter(id => BANKS.questions[id]).length,
      editedExams: Object.keys(doc.exams).filter(id => BANKS.examDefs[id]).length,
      contentUpdatedAt: doc.updatedAt,
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
    await hydratePhotos(env, teachers);
    await hydratePhotos(env, archived);
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
    // مفتاح الصورة (teacher:photo:<id>) لا يتحرك مع الأرشفة/الاستعادة — لا تحديث له.
    await saveTeachers(env, teachers);
    await saveArchived(env, archived);
    await hydrateTeacher(env, t);
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
    t.teacherCode = nextTeacherCode(teachers);
    t.createdAt = new Date().toISOString();
    t.updatedAt = t.createdAt;
    teachers.push(t);
    await saveTeachers(env, teachers, t.photo ? { [t.id]: t.photo } : {});
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
      // الصورة محفوظة في مفتاح مستقل — تُحمَّل أولًا حتى لا يمحوها تعديل لا يذكرها.
      await hydrateTeacher(env, teachers[idx]);
      const prevPhoto = teachers[idx].photo || '';
      const t = await sanitizeTeacher(body, teachers[idx], env);
      if (teachers.some((x, i) => i !== idx && x.slug === t.slug)) return fail('الرابط (slug) مستخدم بالفعل.', 409);
      /* تغيير الرابط (slug) ممنوع بعد وجود بيانات مرتبطة به — لأن فهرس النتائج
       * (results:teacher:<slug>) وسجل الطلاب (students:<slug>) وعدادات المحاولات
       * كلها مفتاحها هو الرابط. تغييره كان: (١) يُخفي نتائج المعلم عنه وعن
       * الإدارة نهائيًا، و(٢) يُصفّر عدد الطلاب المسجلين وعدد المحاولات فيسمح
       * بتجاوز حد الطلاب/حد المحاولات بمجرد إعادة التسمية. مسموح فقط قبل أي بيانات. */
      if (t.slug !== teachers[idx].slug) {
        const prev = teachers[idx];
        const prevResults = await kvGetJson(env, 'results:teacher:' + prev.slug).catch(() => null);
        const prevStudents = await studentCount(env, prev);
        if ((Array.isArray(prevResults) && prevResults.length > 0) || prevStudents > 0) {
          return fail('لا يمكن تغيير رابط معلم لديه نتائج أو طلاب مسجلون — الرابط هو مفتاح بياناته على الخادم. أرشف الحساب وأنشئ معلمًا جديدًا برابط جديد إن لزم.', 409);
        }
      }
      // setting/clearing the password through the edit form is a credential change → revoke sessions
      if ((teachers[idx].passHash || '') !== (t.passHash || '')) await clearV(env, 'sessv:t:' + teachers[idx].id);
      t.id = teachers[idx].id;
      t.teacherCode = teachers[idx].teacherCode || nextTeacherCode(teachers);
      t.createdAt = teachers[idx].createdAt;
      t.updatedAt = new Date().toISOString();
      if (teachers[idx].isDefault && t.slug !== teachers[idx].slug) delete t.isDefault;
      teachers[idx] = t;
      await saveTeachers(env, teachers, (t.photo || '') === prevPhoto ? {} : { [t.id]: t.photo || '' });
      // disabling kills all live sessions immediately (re-enabling requires a fresh login)
      if (t.enabled === false) await clearV(env, 'sessv:t:' + t.id);
      return json({ ok: true, teacher: teacherAdminPayload(t) });
    }
    if (method === 'DELETE') {
      // Non-destructive: the profile moves to the archive (restorable); results (results:teacher:<slug>)
      // and the student registry are never deleted. The slug STAYS reserved: creating a new
      // teacher on an archived slug is rejected (409) so nobody inherits that history.
      if (teachers[idx].isDefault) return fail('لا يمكن حذف المعلم الافتراضي — يمكنك تعطيله فقط.', 400);
      await clearV(env, 'sessv:t:' + teachers[idx].id); // archive = sign out everywhere
      const [removed] = teachers.splice(idx, 1);
      const archived = await kvGetJson(env, 'teachers:archived').catch(() => null) || [];
      archived.unshift({ ...removed, enabled: false, archived: true, archivedAt: new Date().toISOString() });
      await saveArchived(env, archived);
      await saveTeachers(env, teachers);
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
    await saveTeachers(env, teachers);
    await clearV(env, 'sessv:t:' + teachers[idx].id); // admin reset = the teacher must sign in again everywhere
    return json({ ok: true });
  }

  /* ---------- question bank (admin sees keys) — merged base + overlay ---------- */
  if (pathname === '/api/admin/questions' && method === 'GET') {
    const url = new URL(request.url);
    const cv = await contentView(env);
    const subject = url.searchParams.get('subject') || '';
    const term = url.searchParams.get('term') || '';
    const search = (url.searchParams.get('q') || '').trim();
    const lesson = (url.searchParams.get('lesson') || '').trim();
    const only = url.searchParams.get('only') || ''; // custom | edited | base
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const perPage = Math.min(100, Math.max(10, parseInt(url.searchParams.get('perPage') || '50', 10) || 50));
    const entries = Object.entries(cv.view.questions)
      .filter(([, q]) => !subject || q.meta.subjectId === subject)
      .filter(([, q]) => !term || String(q.meta.term || '') === term)
      .filter(([, q]) => !lesson || String(q.meta.lesson || q.meta.chapter || '').includes(lesson))
      .filter(([, q]) => !search || q.text.includes(search))
      .filter(([id, q]) => !only || (only === 'custom' ? q.custom === true : only === 'edited' ? !!cv.doc.questions[id] : q.custom !== true && !cv.doc.questions[id]));
    const total = entries.length;
    const slice = entries.slice((page - 1) * perPage, page * perPage)
      .map(([id, q]) => ({
        id, text: q.text, options: q.options, answer: q.answer, meta: q.meta,
        custom: q.custom === true, edited: !!cv.doc.questions[id], deleted: false,
        usedBy: Object.keys(cv.view.examDefs).filter(eid => (cv.view.examDefs[eid] || []).indexOf(id) !== -1).length
      }));
    return json({
      total, page, perPage, questions: slice,
      counts: {
        all: Object.keys(cv.view.questions).length,
        custom: Object.values(cv.view.questions).filter(q => q.custom === true).length,
        edited: Object.keys(cv.doc.questions).filter(id => BANKS.questions[id]).length,
        deleted: cv.doc.deletedQuestions.length
      }
    });
  }
  /* deleted (tombstoned) questions — restorable */
  if (pathname === '/api/admin/questions/deleted' && method === 'GET') {
    const cv = await contentView(env);
    return json({
      questions: cv.doc.deletedQuestions.map(id => {
        const base = BANKS.questions[id];
        const p = cv.doc.questions[id];
        const q = p || base;
        return { id, text: q ? q.text : '(غير متاح)', custom: !!(p && p.custom === true), hasBase: !!base };
      })
    });
  }

  /* ---------- single question (admin, privileged: includes the key) ---------- */
  const qMatch = pathname.match(/^\/api\/admin\/questions\/([A-Za-z0-9_.:-]+)$/);
  if (qMatch) {
    const cv = await contentView(env);
    const id = qMatch[1];
    if (method === 'GET') {
      const q = cv.view.questions[id];
      const del = cv.doc.deletedQuestions.indexOf(id) !== -1;
      if (!q && !del) return fail('السؤال غير موجود.', 404);
      return json({
        question: q ? { id, text: q.text, options: q.options, answer: q.answer, meta: q.meta, custom: q.custom === true } : null,
        deleted: del, edited: !!cv.doc.questions[id],
        usedBy: Object.keys(cv.view.examDefs).filter(eid => (cv.view.examDefs[eid] || []).indexOf(id) !== -1).map(eid => ({ id: eid, title: cv.view.exams[eid].title }))
      });
    }
    if (method === 'PUT') {
      const existing = cv.view.questions[id];
      if (!existing) return fail('السؤال غير موجود.', 404);
      const clean = sanitizeQuestionInput(await readJson(request, 64 * 1024), existing);
      const doc = cv.doc;
      const isBase = !!BANKS.questions[id];
      if (isBase) {
        doc.questions[id] = Object.assign({}, doc.questions[id], clean, { edited: true, updatedAt: new Date().toISOString() });
      } else {
        doc.questions[id] = Object.assign({}, doc.questions[id], clean, { custom: true, updatedAt: new Date().toISOString() });
      }
      await saveContentDoc(env, doc);
      return json({ ok: true, id });
    }
    if (method === 'DELETE') {
      const doc = cv.doc;
      if (doc.deletedQuestions.indexOf(id) === -1) doc.deletedQuestions.push(id);
      await saveContentDoc(env, doc);
      const affected = Object.keys(buildView(doc).examDefs).filter(eid => (BANKS.examDefs[eid] || []).indexOf(id) !== -1);
      return json({ ok: true, deleted: true, affectedExams: affected.length });
    }
  }
  /* restore a tombstoned question */
  const qRestore = pathname.match(/^\/api\/admin\/questions\/([A-Za-z0-9_.:-]+)\/restore$/);
  if (qRestore && method === 'POST') {
    const doc = await getContentDoc(env);
    const i = doc.deletedQuestions.indexOf(qRestore[1]);
    if (i === -1) return fail('السؤال ليس في سلة المحذوفات.', 404);
    doc.deletedQuestions.splice(i, 1);
    await saveContentDoc(env, doc);
    return json({ ok: true });
  }
  /* duplicate a question (creates a NEW custom question; the bank copy stays) */
  const qDup = pathname.match(/^\/api\/admin\/questions\/([A-Za-z0-9_.:-]+)\/duplicate$/);
  if (qDup && method === 'POST') {
    const cv = await contentView(env);
    const src = cv.view.questions[qDup[1]];
    if (!src) return fail('السؤال غير موجود.', 404);
    const doc = cv.doc;
    const id = uniqueQuestionId(doc);
    doc.questions[id] = {
      id, custom: true, text: src.text, options: src.options.slice(), answer: src.answer,
      meta: Object.assign({}, src.meta, { source: 'نسخة من ' + qDup[1] + ' (لوحة التحكم)', duplicatedFrom: qDup[1] }),
      createdAt: new Date().toISOString()
    };
    await saveContentDoc(env, doc);
    return json({ ok: true, id });
  }
  /* create a brand-new question */
  if (pathname === '/api/admin/questions' && method === 'POST') {
    const cv = await contentView(env);
    const clean = sanitizeQuestionInput(await readJson(request, 64 * 1024), null);
    const doc = cv.doc;
    const id = uniqueQuestionId(doc);
    clean.meta.subjectId = clean.meta.subjectId === 'psychology' ? 'psychology' : (clean.meta.subjectId === 'philosophy' ? 'philosophy' : 'philosophy');
    clean.meta.source = clean.meta.source || 'أُنشئ من لوحة التحكم';
    clean.meta.verificationStatus = clean.meta.verificationStatus || 'admin';
    doc.questions[id] = Object.assign({ id, custom: true, createdAt: new Date().toISOString() }, clean);
    await saveContentDoc(env, doc);
    return json({ ok: true, id });
  }

  /* ---------- exams list (admin; merged + custom + disabled flags) ---------- */
  if (pathname === '/api/admin/exams' && method === 'GET') {
    const url = new URL(request.url);
    const cv = await contentView(env);
    const q = (url.searchParams.get('q') || '').trim();
    const subject = url.searchParams.get('subject') || '';
    const term = url.searchParams.get('term') || '';
    const status = url.searchParams.get('status') || ''; // enabled|disabled|custom|edited
    let rows = Object.values(cv.view.exams)
      .filter(e => !subject || e.subjectId === subject)
      .filter(e => !term || String(e.term == null ? '' : e.term) === term)
      .filter(e => !q || (e.title || '').includes(q) || e.id.toLowerCase().includes(q.toLowerCase()))
      .filter(e => !status || (status === 'enabled' ? e.enabled !== false : status === 'disabled' ? e.enabled === false : status === 'custom' ? e.custom === true : e.modified === true));
    rows.sort((a, b) => (a.subjectId + '|' + (a.term == null ? '' : a.term) + '|' + a.title).localeCompare(b.subjectId + '|' + (b.term == null ? '' : b.term) + '|' + b.title, 'ar'));
    return json({
      exams: rows, catalog: cv.catalog, deleted: cv.doc.deletedExams,
      counts: {
        all: Object.keys(cv.view.exams).length,
        custom: Object.values(cv.view.exams).filter(e => e.custom === true).length,
        disabled: Object.values(cv.view.exams).filter(e => e.enabled === false).length,
        edited: Object.values(cv.view.exams).filter(e => e.modified === true && e.custom !== true).length,
        deleted: cv.doc.deletedExams.length
      }
    });
  }
  /* deleted exams — restorable */
  if (pathname === '/api/admin/exams/deleted' && method === 'GET') {
    const cv = await contentView(env);
    return json({
      exams: cv.doc.deletedExams.map(id => {
        const p = cv.doc.exams[id] || {};
        return { id, title: p.title || (BANKS.exams[id] ? BANKS.exams[id].title : '(غير متاح)'), custom: !!(p.custom === true) };
      })
    });
  }

  /* ---------- single exam (admin editor payload: includes keys) ---------- */
  const eMatch = pathname.match(/^\/api\/admin\/exams\/([A-Za-z0-9_.:-]+)$/);
  if (eMatch) {
    const cv = await contentView(env);
    const id = eMatch[1];
    if (method === 'GET') {
      const e = cv.view.exams[id];
      if (!e) return fail('الامتحان غير موجود.', 404);
      const ids = cv.view.examDefs[id] || [];
      return json({
        exam: e, questionIds: ids,
        questions: ids.map(qid => {
          const q = cv.view.questions[qid];
          return { id: qid, text: q.text, options: q.options, answer: q.answer, meta: q.meta, custom: q.custom === true };
        })
      });
    }
    if (method === 'PUT') {
      const existing = cv.view.exams[id];
      if (!existing) return fail('الامتحان غير موجود.', 404);
      const body = await readJson(request, 512 * 1024);
      const doc = cv.doc;
      const isBase = !!BANKS.examDefs[id];
      const patch = doc.exams[id] || (isBase ? {} : { custom: true, createdAt: new Date().toISOString() });
      if (body.title !== undefined) {
        const t = String(body.title || '').trim();
        if (!t) throw bad('اسم الامتحان مطلوب.');
        patch.title = t.slice(0, 200);
      }
      if (body.subjectId !== undefined) patch.subjectId = body.subjectId === 'psychology' ? 'psychology' : 'philosophy';
      if (body.term !== undefined) patch.term = (body.term === null || body.term === '') ? null : (parseInt(body.term, 10) === 2 ? 2 : 1);
      if (body.grade !== undefined) patch.grade = String(body.grade || '').trim().slice(0, 80);
      if (body.type !== undefined && !isBase) patch.type = String(body.type || 'custom').slice(0, 30);
      if (body.unitTitle !== undefined) patch.unitTitle = String(body.unitTitle || '').trim().slice(0, 120);
      if (body.lessonTitle !== undefined) patch.lessonTitle = String(body.lessonTitle || '').trim().slice(0, 200);
      if (body.enabled !== undefined) patch.enabled = body.enabled !== false;
      if (body.questionIds !== undefined) {
        if (!Array.isArray(body.questionIds)) throw bad('قائمة الأسئلة غير صالحة.');
        const seen = new Set(); const ids = [];
        for (const qid of body.questionIds) {
          if (typeof qid !== 'string' || !cv.view.questions[qid]) throw bad('سؤال غير موجود في البنك: ' + qid);
          if (seen.has(qid)) throw bad('السؤال ' + qid + ' مكرر داخل الامتحان.');
          seen.add(qid); ids.push(qid);
        }
        if (!ids.length) throw bad('لا يمكن حفظ امتحان بلا أسئلة.');
        if (ids.length > 200) throw bad('الحد الأقصى 200 سؤال لكل امتحان.');
        patch.questionIds = ids;
      }
      patch.updatedAt = new Date().toISOString();
      doc.exams[id] = patch;
      await saveContentDoc(env, doc);
      return json({ ok: true, id, count: (buildView(doc).examDefs[id] || []).length });
    }
    if (method === 'DELETE') {
      const doc = cv.doc;
      if (doc.deletedExams.indexOf(id) === -1) doc.deletedExams.push(id);
      await saveContentDoc(env, doc);
      return json({ ok: true, deleted: true });
    }
  }
  /* restore a tombstoned exam */
  const eRestore = pathname.match(/^\/api\/admin\/exams\/([A-Za-z0-9_.:-]+)\/restore$/);
  if (eRestore && method === 'POST') {
    const doc = await getContentDoc(env);
    const i = doc.deletedExams.indexOf(eRestore[1]);
    if (i === -1) return fail('الامتحان ليس في سلة المحذوفات.', 404);
    doc.deletedExams.splice(i, 1);
    await saveContentDoc(env, doc);
    return json({ ok: true });
  }
  /* revert an exam to its pristine bank definition (drop the overlay patch) */
  const eRevert = pathname.match(/^\/api\/admin\/exams\/([A-Za-z0-9_.:-]+)\/revert$/);
  if (eRevert && method === 'POST') {
    const cv = await contentView(env);
    const id = eRevert[1];
    if (!BANKS.examDefs[id]) return fail('هذا الامتحان مخصّص (ليس من البنك الأصلي) — لا يمكن استعادة أصل له.', 400);
    const doc = cv.doc;
    delete doc.exams[id];
    await saveContentDoc(env, doc);
    return json({ ok: true });
  }
  /* revert a base question to its pristine bank wording/key */
  const qRevert = pathname.match(/^\/api\/admin\/questions\/([A-Za-z0-9_.:-]+)\/revert$/);
  if (qRevert && method === 'POST') {
    const cv = await contentView(env);
    const id = qRevert[1];
    if (!BANKS.questions[id]) return fail('هذا السؤال مخصّص (ليس من البنك الأصلي) — لا يمكن استعادة أصل له.', 400);
    const doc = cv.doc;
    delete doc.questions[id];
    await saveContentDoc(env, doc);
    return json({ ok: true });
  }
  /* create a new (custom) exam */
  if (pathname === '/api/admin/exams' && method === 'POST') {
    const cv = await contentView(env);
    const body = await readJson(request, 512 * 1024);
    const title = String(body.title || '').trim();
    if (!title) throw bad('اسم الامتحان مطلوب.');
    const subjectId = body.subjectId === 'psychology' ? 'psychology' : 'philosophy';
    const doc = cv.doc;
    const ids = [];
    if (Array.isArray(body.questionIds)) {
      const seen = new Set();
      for (const qid of body.questionIds) {
        if (typeof qid !== 'string' || !cv.view.questions[qid]) throw bad('سؤال غير موجود: ' + qid);
        if (seen.has(qid)) throw bad('السؤال ' + qid + ' مكرر داخل الامتحان.');
        seen.add(qid); ids.push(qid);
      }
    }
    if (ids.length > 200) throw bad('الحد الأقصى 200 سؤال لكل امتحان.');
    const id = uniqueExamId(doc);
    doc.exams[id] = {
      custom: true, title: title.slice(0, 200), subjectId,
      term: body.term === null || body.term === undefined || body.term === '' ? null : (parseInt(body.term, 10) === 2 ? 2 : 1),
      grade: String(body.grade || '').trim().slice(0, 80),
      type: 'custom', unitTitle: String(body.unitTitle || '').trim().slice(0, 120), lessonTitle: String(body.lessonTitle || '').trim().slice(0, 200),
      enabled: body.enabled !== false, questionIds: ids,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await saveContentDoc(env, doc);
    return json({ ok: true, id });
  }
  /* export an exam in the canonical import format (ADMIN ONLY — includes keys) */
  const eExport = pathname.match(/^\/api\/admin\/exams\/([A-Za-z0-9_.:-]+)\/export$/);
  if (eExport && method === 'GET') {
    const cv = await contentView(env);
    const id = eExport[1];
    if (!cv.view.exams[id]) return fail('الامتحان غير موجود.', 404);
    const canonical = examToCanonical(cv.view, id);
    return new Response(JSON.stringify(canonical, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="exam-' + id + '.json"',
        'Cache-Control': 'no-store'
      }
    });
  }
  /* import: validate + preview ONLY (nothing is stored) */
  if (pathname === '/api/admin/import/preview' && method === 'POST') {
    const body = await readJson(request, 6 * 1024 * 1024);
    const raw = typeof body.text === 'string' ? body.text : (typeof body.json === 'string' ? body.json : '');
    if (!raw) throw bad('لم يُستلم محتوى الملف.');
    const parsed = parseImportPayload(raw);
    const cv = await contentView(env);
    const report = validateImport(parsed, cv.view);
    return json({ report });
  }
  /* import: commit AFTER an explicit preview+confirm (server re-validates) */
  if (pathname === '/api/admin/import/commit' && method === 'POST') {
    const body = await readJson(request, 6 * 1024 * 1024);
    if (body.confirm !== true) throw bad('التأكيد مطلوب قبل الاستيراد.');
    const raw = typeof body.text === 'string' ? body.text : '';
    if (!raw) throw bad('لم يُستلم محتوى الملف.');
    const parsed = parseImportPayload(raw);
    const cv = await contentView(env);
    const report = validateImport(parsed, cv.view);
    if (!report.ok) throw bad('لا يمكن الاستيراد: ' + (report.errors[0] ? report.errors[0].message : 'الملف غير صالح.'));
    const doc = cv.doc;
    const view = cv.view;
    const textIndex = buildTextIndex(view);
    const ids = []; const seenFp = new Map(); const created = [];
    report.rows.forEach((row) => {
      // invalid rows are rejected; intra-file duplicates are added ONCE (first occurrence wins)
      if (row.status === 'invalid' || row.status === 'duplicate-file') return;
      const fp = questionFingerprint(view, row.text);
      if (fp && seenFp.has(fp)) return;
      if (row.status === 'exists' && row.existingId) { seenFp.set(fp, row.existingId); ids.push(row.existingId); return; }
      // brand-new question — unless the bank already holds this exact wording (race-safe re-check)
      const bankHit = textIndex.get(fp);
      if (bankHit) { seenFp.set(fp, bankHit); ids.push(bankHit); return; }
      const qid = uniqueQuestionId(doc);
      doc.questions[qid] = {
        id: qid, custom: true, text: row.text,
        options: [row.options.A, row.options.B, row.options.C, row.options.D],
        answer: row.correctAnswer,
        meta: {
          subject: parsed.subjectId === 'psychology' ? 'علم النفس' : 'الفلسفة والمنطق',
          subjectId: parsed.subjectId, term: parsed.term, lesson: parsed.grade || '',
          source: 'استيراد من ملف (لوحة التحكم)', verificationStatus: 'imported'
        },
        createdAt: new Date().toISOString()
      };
      seenFp.set(fp, qid); ids.push(qid); created.push(qid);
    });
    if (!ids.length) throw bad('لا توجد أسئلة صالحة للاستيراد.');
    const examId = uniqueExamId(doc);
    doc.exams[examId] = {
      custom: true, title: parsed.title.slice(0, 200), subjectId: parsed.subjectId,
      term: parsed.term, grade: parsed.grade, type: 'custom',
      unitTitle: '', lessonTitle: '', enabled: true, questionIds: ids,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await saveContentDoc(env, doc);
    return json({ ok: true, examId, createdQuestions: created.length, reusedQuestions: ids.length - created.length, total: ids.length });
  }

  /* ---------- results ---------- */
  if (pathname === '/api/admin/results' && method === 'GET') {
    const recent = await resultsRecent(env, 100);
    return json({ results: recent });
  }
  if (pathname === '/api/admin/results.csv' && method === 'GET') {
    const recent = await resultsRecent(env, 200);
    /* حقن الصيغ (CSV injection): أي قيمة تبدأ بـ = + - @ أو تبويب تُعتبر صيغة عند
     * فتح الملف في Excel/Sheets — تُسبَق بفاصلة عليا لتُقرأ كنص. */
    const esc = (v) => {
      let x = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
      if (/^[=+\-@\t\r]/.test(x)) x = "'" + x;
      return '"' + x.replace(/"/g, '""') + '"';
    };
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
  // اسم/نبذة/تخصص المعلم تظهر في صفحته العامة — تُهرَّب عند العرض، وتُنظَّف هنا
  // من محارف التحكم حتى لا تُستخدم لتسميم CSV أو السجلات.
  /* نفس قاعدة بقية الحقول: غياب `name` في طلب PUT = إبقاء الاسم المخزَّن.
   * كان الاسم هو الحقل الوحيد المطلوب دائمًا، فأي تحديث جزئي (تعطيل/تفعيل،
   * تغيير حد الطلاب، تغيير عدد المحاولات) كان يُرفض بـ«اسم المعلم مطلوب» —
   * رغم أن العقد الموثَّق أدناه ينص على أن الحقل الغائب يحافظ على قيمته المخزّنة. */
  const name = stripControl(body.name !== undefined ? body.name : (existing?.name ?? ''), 80);
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
  /* photo: '' صريحة = «إزالة الصورة» (زر الإزالة في لوحة التحكم)؛ غياب الحقل = إبقاء الحالية.
   * الخلط بين الحالتين كان يجعل إزالة الصورة مستحيلة من اللوحة. */
  let photo = body.photo === undefined ? String(existing?.photo || '') : String(body.photo || '');
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
    specialty: stripControl(body.specialty ?? existing?.specialty ?? '', 120),
    bio: stripControl(body.bio ?? existing?.bio ?? '', 500),
    photo,
    // عرض الصورة: contain (افتراضي للشفاف) أو cover (قص متناسق) — فارغ = تلقائي حسب نوع الملف
    photoFit: body.photoFit === 'cover' || body.photoFit === 'contain' ? body.photoFit
      : (body.photoFit === '' || body.photoFit === null ? '' : (existing?.photoFit || '')),
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
  sweepThrottles(teacherLoginFails);
  const fails = teacherLoginFails.get(ip) || { n: 0, until: 0 };
  if (fails.n >= 10 && Date.now() < fails.until) return fail('محاولات كثيرة.', 429);
  // نفس قواعد الحماية من CSRF: لا تسجيل دخول مُجبر من موقع آخر (login CSRF)،
  // ولا مصدر خارجي (ترويسة مخصّصة + تطابق Origin/Host).
  if (request.headers.get('X-Requested-With') !== 'fetch') return fail('طلب غير مصرح.', 403);
  if (crossSiteRequest(request)) return fail('طلب من مصدر آخر مرفوض.', 403);
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
  if (method !== 'GET') {
    if (request.headers.get('X-Requested-With') !== 'fetch') return fail('طلب غير مصرح.', 403);
    if (crossSiteRequest(request)) return fail('طلب من مصدر آخر مرفوض.', 403);
  }
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
    await saveTeachers(env, teachers);
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
    await hydrateTeacher(env, teacher);
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
    // الصورة في مفتاح مستقل — تُحمَّل أولًا حتى لا يمحوها حفظ لا يذكرها.
    const existing = await hydrateTeacher(env, teachers[idx]);
    const prevPhoto = existing.photo || '';
    const updated = { ...existing };
    updated.name = stripControl(body.name, 80) || existing.name;
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
    updated.bio = stripControl(body.bio ?? existing.bio ?? '', 500);
    if (body.photo !== undefined) {
      let photo = String(body.photo || '');
      if (photo && !/^data:image\/(png|jpe?g|webp);base64,/i.test(photo)) throw bad('صورة غير صالحة.');
      if (photo && photo.length > 2.5 * 1024 * 1024) throw bad('حجم الصورة كبير.');
      updated.photo = photo;
    }
    if (body.photoFit === 'cover' || body.photoFit === 'contain') updated.photoFit = body.photoFit;
    else if (body.photoFit === '') updated.photoFit = '';
    updated.updatedAt = new Date().toISOString();
    teachers[idx] = updated;
    await saveTeachers(env, teachers, (updated.photo || '') === prevPhoto ? {} : { [updated.id]: updated.photo || '' });
    return json({ ok: true, teacher: teacherPublic(updated) });
  }
  if (pathname === '/api/t/dashboard' && method === 'GET') {
    const tlist = await resultsForTeacher(env, teacher.slug, 200);
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
    const tlist = await resultsForTeacher(env, teacher.slug, 200);
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
    const tlist = await resultsForTeacher(env, teacher.slug, 200);
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

/* كود معلم فريد فعلًا: 'TCH-' + (count+1) كان يُكرَّر بعد أي حذف/أرشفة. */
function nextTeacherCode(teachers) {
  const used = new Set((teachers || []).map(x => x.teacherCode).filter(Boolean));
  for (let n = (teachers || []).length + 1; n < 10000; n++) {
    const code = 'TCH-' + String(n).padStart(4, '0');
    if (!used.has(code)) return code;
  }
  return 'TCH-' + randomHex(3).toUpperCase();
}

function teacherAdminPayload(t) {
  const sl = studentLimitOf(t);
  return {
    id: t.id, teacherCode: t.teacherCode || '', slug: t.slug, name: t.name,
    email: t.email || '', username: t.username || '',
    phone: t.phone || '', specialty: t.specialty || '', bio: t.bio || '',
    photo: t.photo || '', photoFit: t.photoFit || '', socialLinks: t.socialLinks || {},
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
    /* ---- results index: serialised, transactional append ---- */
    if (url.pathname === '/results/append' && request.method === 'POST') {
      let b = null;
      try { b = await request.json(); } catch {}
      const e = b && b.entry;
      if (!e || !e.id) return Response.json({ error: 'entry required' }, 400);
      const scope = String(b.scope || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 90);
      const lean = { id: String(e.id).slice(0, 64), date: String(e.date || '').slice(0, 40), name: String(e.name || '').slice(0, 120), phone: String(e.phone || '').slice(0, 40), examId: String(e.examId || '').slice(0, 60), examLabel: String(e.examLabel || '').slice(0, 200), subject: String(e.subject || '').slice(0, 60), total: Number(e.total) || 0, score: Number(e.score) || 0, percentage: Number(e.percentage) || 0, teacherSlug: String(e.teacherSlug || '').slice(0, 80) };
      const out = await this.state.storage.transaction(async (txn) => {
        const all = (await txn.get('recent')) || [];
        if (all.some((r) => r.id === lean.id)) {
          return { recent: all.slice(0, 200), mine: scope ? ((await txn.get(scope)) || []).slice(0, 200) : null, duplicate: true };
        }
        const next = [lean, ...all].slice(0, RESULT_INDEX_CAP);
        await txn.put('recent', next);
        let mine = null;
        if (scope) {
          const prev = (await txn.get(scope)) || [];
          if (!prev.some((r) => r.id === lean.id)) {
            mine = [lean, ...prev].slice(0, RESULT_INDEX_CAP);
            await txn.put(scope, mine);
          } else mine = prev;
        }
        return { recent: next.slice(0, 200), mine: mine ? mine.slice(0, 200) : null, duplicate: false };
      });
      return Response.json(out);
    }
    if (url.pathname === '/results/list' && request.method === 'GET') {
      const scope = String(url.searchParams.get('scope') || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 90);
      const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      const list = scope ? ((await this.state.storage.get(scope)) || []) : ((await this.state.storage.get('recent')) || []);
      return Response.json({ items: Array.isArray(list) ? list.slice(0, limit) : [] });
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

/* ---------- results index: KV cannot do read-modify-write atomically ----------
 * Two submissions finishing together both read `results:recent`, both prepend and
 * both write back — the slower write drops the other result from the index (the
 * result body at `result:<id>` survives, but it vanishes from every dashboard).
 * The Durable Object serialises the append in a storage transaction, so the list
 * is never lost; KV is kept as a write-through mirror (and as history for results
 * recorded before this existed), and readers merge the two and de-duplicate by id.
 */
const RESULT_INDEX_CAP = 400;
async function resultIndexAppend(env, entry, teacherSlug) {
  const stub = await limiterStub(env, '__results__');
  if (!stub) return null;
  const r = await stub.fetch('https://limiter/results/append', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry, scope: 't:' + String(teacherSlug || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) })
  }).catch(() => null);
  if (!r || !r.ok) return null;
  return await r.json().catch(() => null);
}
async function resultIndexList(env, scope, limit) {
  const stub = await limiterStub(env, '__results__');
  if (!stub) return null;
  const r = await stub.fetch('https://limiter/results/list?scope=' + encodeURIComponent(scope || '') + '&limit=' + limit, { method: 'GET' }).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json().catch(() => null);
  return Array.isArray(d && d.items) ? d.items : null;
}
function mergeResultLists(a, b, limit) {
  const seen = new Set(); const out = [];
  for (const r of (a || []).concat(b || [])) {
    if (!r || !r.id || seen.has(r.id)) continue;   // de-dup: KV mirror + DO overlap
    seen.add(r.id); out.push(r);
  }
  out.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
  return out.slice(0, limit);
}
async function resultsRecent(env, limit) {
  const [fromDo, fromKv] = await Promise.all([
    resultIndexList(env, '', 200),
    kvGetJson(env, 'results:recent').catch(() => null)
  ]);
  return mergeResultLists(fromDo, fromKv, limit);
}
async function resultsForTeacher(env, slug, limit) {
  const [fromDo, fromKv] = await Promise.all([
    slug ? resultIndexList(env, 't:' + slug, 200) : null,
    kvGetJson(env, 'results:teacher:' + slug).catch(() => null)
  ]);
  return mergeResultLists(fromDo, fromKv, limit);
}
async function kvAppendResult(env, key, entry, cap, withSlug) {
  const raw = await env.PLATFORM_KV.get(key).catch(() => null);
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch {}
  if (!Array.isArray(list)) list = [];
  list.unshift(withSlug ? entry : { id: entry.id, date: entry.date, name: entry.name, phone: entry.phone, examId: entry.examId, examLabel: entry.examLabel, subject: entry.subject, total: entry.total, score: entry.score, percentage: entry.percentage });
  if (list.length > cap) list = list.slice(0, cap);
  await env.PLATFORM_KV.put(key, JSON.stringify(list)).catch(() => {});
  return list;
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
          const res = await handleApi(request, env, ctx, pathname);
          // HEAD must behave exactly like GET (status + headers) with no body —
          // previously every HEAD on /api/* fell through to a 404.
          const out = (request.method === 'HEAD')
            ? new Response(null, { status: res.status, headers: res.headers })
            : res;
          return securityHeaders(out);
        } catch (e) {
          // Only ApiError messages reach the client; anything else is an internal fault → generic text, no details.
          if (e instanceof ApiError) return securityHeaders(fail(e.message, e.status));
          return securityHeaders(fail('خطأ غير متوقع في الخادم. حاول مرة أخرى.', 500));
        }
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return securityHeaders(fail('الطريقة غير مسموح بها.', 405));
      }

      /* الملفات نفسها تُخدَم من مساراتها القياسية فقط (/ و /admin و /teacher):
       * /index.html و /admin.html و /teacher.html تُحوَّل تحويلًا دائمًا حتى لا
       * يُفهرس المحتوى نفسه تحت أكثر من رابط (كان خادم الأصول يحوّل /index.html
       * → / تلقائيًا، ومع run_worker_first صار التحويل مسؤولية الـWorker). */
      const canonicalHtml = { '/index.html': '/', '/admin.html': '/admin', '/teacher.html': '/teacher' };
      if (canonicalHtml[pathname]) {
        return securityHeaders(new Response(null, { status: 308, headers: { Location: canonicalHtml[pathname], 'Cache-Control': 'no-store' } }));
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
