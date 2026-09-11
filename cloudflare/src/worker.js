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

/* ============================ storage (KV) ============================ */
const DEFAULT_TEACHERS = [{
  id: 't_default_mostafa',
  slug: 'mostafa',
  name: 'د. مصطفى تيتو',
  phone: '',
  specialty: 'مدرس الفلسفة والمنطق وعلم النفس — المرحلة الثانوية',
  bio: 'منصة امتحانات إلكترونية للفلسفة والمنطق وعلم النفس وفق المنهج الرسمي: اختبر نفسك، اعرف درجتك فورًا، وراجع إجاباتك بعد كل امتحان.',
  photo: '',
  socialLinks: { whatsapp: '', facebook: '', tiktok: '' },
  requirePhone: true,
  enabled: true,
  isDefault: true,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z'
}];

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
async function publicCatalog(env) {
  const teachers = await getTeachers(env).catch(() => DEFAULT_TEACHERS);
  const owner = teachers.find(t => t.isDefault) || teachers.find(t => t.enabled !== false) || teachers[0] || null;
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
    if (!session) return fail('\u063a\u064a\u0631 \u0645\u0635\u0631\u062d.', 401);
    const teachers = await getTeachers(env);
    const t = teachers.find(x => x.id === session.tid);
    if (!t || t.enabled === false || t.archived) return fail('\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0639\u0644\u0645 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d.', 403);
    return json({ id: t.id, name: t.name, slug: t.slug });
  }
  /* ---------- teacher auth: logout ---------- */
  if (pathname === '/api/t/logout' && method === 'POST') {
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
    const slug = String(body.slug || '').toLowerCase();
    const teachers = await getTeachers(env);
    const teacher = teachers.find(x => x.slug === slug) || null;
    if (teacher && teacher.enabled === false) return fail('صفحة هذا المعلم غير متاحة حاليًا.', 403);
    if (!rawPhone && teacher && teacher.requirePhone !== false) return fail('رقم الهاتف مطلوب.');
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

  /* ---------- login ---------- */
  if (pathname === '/api/admin/login' && method === 'POST') {
    const fails = loginFails.get(ip) || { n: 0, until: 0 };
    if (fails.n >= 10 && Date.now() < fails.until) return fail('محاولات كثيرة. حاول بعد قليل.', 429);

    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return fail('البريد وكلمة المرور مطلوبان.');

    const admin = await getAdminRecord(env);
    if (!admin) return fail('لم يُنشأ حساب المسؤول بعد. افتح صفحة الإعداد الأولي.', 404);

    const hash = await pbkdf2(password, admin.salt, admin.iterations);
    if (email !== admin.email || hash !== admin.hash) {
      loginFails.set(ip, { n: fails.n + 1, until: Date.now() + 15 * 60 * 1000 });
      return fail('بيانات الدخول غير صحيحة.', 401);
    }
    loginFails.delete(ip);

    const secret = await getSessionSecret(env).catch(() => null);
    if (!secret) return fail('تهيئة الخادم غير مكتملة (KV).', 503);
    const token = await signToken({ t: 'admin', email, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL }, secret);
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
  const authed = !!(session && session.t === 'admin');

  if (pathname === '/api/admin/session' && method === 'GET') {
    if (!authed) return fail('غير مصرح.', 401);
    return json({ email: session.email });
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
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

  /* ---------- change admin password ---------- */
  if (pathname === '/api/admin/password' && method === 'POST') {
    const body = await readJson(request);
    const current = String(body.current || '');
    const next = String(body.next || '');
    const admin = await getAdminRecord(env);
    if (!admin) return fail('لم يُنشأ حساب المسؤول بعد.', 404);
    const curHash = await pbkdf2(current, admin.salt, admin.iterations);
    if (curHash !== admin.hash) return fail('كلمة المرور الحالية غير صحيحة.', 401);
    if (next.length < 8) return fail('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.');
    if (next === current) return fail('كلمة المرور الجديدة مطابقة للحالية.');
    const salt = randomHex(16);
    const hash = await pbkdf2(next, salt);
    await kvPut(env, 'admin', JSON.stringify({ ...admin, salt, hash, iterations: 120000, updatedAt: new Date().toISOString() }));
    return json({ ok: true });
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
    const withStatus = await Promise.all(teachers.map(async t => ({ ...t, studentLimitStatus: await studentLimitStatus(env, t) })));
    return json({ teachers: withStatus, archived });
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
    return json({ ok: true, teacher: t });
  }
  if (pathname === '/api/admin/teachers' && method === 'POST') {
    const body = await readJson(request, 3 * 1024 * 1024);
    const t = await sanitizeTeacher(body, null, env);
    const teachers = await getTeachers(env);
    if (teachers.some(x => x.slug === t.slug)) return fail('الرابط (slug) مستخدم بالفعل.', 409);
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
      t.id = teachers[idx].id;
      t.teacherCode = teachers[idx].teacherCode || ('TCH-' + String(idx + 1).padStart(4, '0'));
      t.createdAt = teachers[idx].createdAt;
      t.updatedAt = new Date().toISOString();
      if (teachers[idx].isDefault && t.slug !== teachers[idx].slug) delete t.isDefault;
      teachers[idx] = t;
      await kvPut(env, 'teachers', JSON.stringify(teachers));
      return json({ ok: true, teacher: teacherAdminPayload(t) });
    }
    if (method === 'DELETE') {
      // Non-destructive: the profile moves to the archive (restorable); results (results:teacher:<slug>)
      // and the student registry are never deleted. The slug is released for reuse.
      if (teachers[idx].isDefault) return fail('لا يمكن حذف المعلم الافتراضي — يمكنك تعطيله فقط.', 400);
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
  const social = {};
  for (const k of ['whatsapp', 'facebook', 'tiktok']) {
    const v = String(body.socialLinks?.[k] || '').trim();
    if (v && !/^https?:\/\//i.test(v)) throw bad('روابط التواصل يجب أن تبدأ بـ http:// أو https://');
    social[k] = v;
  }
  let phone = String(body.phone || '').trim();
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
  let email = String(body.email || '').trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('البريد الإلكتروني غير صالح.');
  let username = String(body.username || '').trim().toLowerCase();
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

  return {
    slug, name, phone, email, username, passHash, passSalt, passIterations,
    specialty: String(body.specialty ?? existing?.specialty ?? '').trim().slice(0, 120),
    bio: String(body.bio ?? existing?.bio ?? '').trim().slice(0, 500),
    photo,
    socialLinks: social,
    requirePhone: body.requirePhone !== false,
    enabled: body.enabled !== false,
    unlimited: body.unlimited !== false,
    maxAttempts: Math.max(1, Math.min(50, parseInt(body.maxAttempts ?? existing?.maxAttempts ?? 3, 10) || 3)),
    offlineMode: body.offlineMode === true || (body.offlineMode === undefined && existing?.offlineMode === true),
    // Student limit: a REAL unlimited flag (not a big number). When limited, studentLimit is the
    // max number of DISTINCT students (by normalized phone) who may register under this teacher.
    // 0 = registration closed for new students (existing students keep access).
    studentLimitUnlimited: body.studentLimitUnlimited === undefined
      ? (existing ? existing.studentLimitUnlimited !== false : true)
      : body.studentLimitUnlimited !== false,
    studentLimit: sanitizeStudentLimit(body.studentLimit ?? existing?.studentLimit ?? 0)
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

      // teacher SPA: /teacher (login + dashboard)
      if (pathname === '/teacher' || pathname === '/teacher/' || pathname.startsWith('/teacher/')) {
        const res = await env.ASSETS.fetch(new URL('https://assets.internal/teacher.html'));
        return securityHeaders(new Response(res.body, { status: 200, headers: res.headers }));
      }

      // student SPA: / or /:slug ; admin SPA: /admin
      if (pathname === '/admin' || pathname === '/admin/') {
        const res = await env.ASSETS.fetch(new URL('https://assets.internal/admin.html'));
        return securityHeaders(new Response(res.body, { status: 200, headers: res.headers }));
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
