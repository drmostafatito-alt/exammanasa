/**
 * run-all.mjs — منصة الامتحانات: مجموعة اختبارات شاملة
 * =====================================================
 * تشغّل نسخة wrangler dev معزولة (حالة KV نظيفة) ثم تختبر:
 *   1. الصفحات الثابتة والمسارات (الرئيسية / admin / slug / 404)
 *   2. الكتالوج العام (بلا أي مفاتيح أو قوائم أسئلة)
 *   3. ملفات المعلمين العامة
 *   4. جلسات الامتحان (تحقق من المدخلات + عدم تسريب المفاتيح)
 *   5. التسليم: الرفض عند النقص/التلاعب + منع الإعادة
 *   6. دورة كاملة بدرجة كاملة لكل امتحانات المنصة الـ٧٥ (تصحيح على الخادم)
 *   7. دورة درجة صفر + مراجعة الأسئلة (إجابة الطالب مقابل الصحيحة)
 *   8. حساب المسؤول: الإعداد الأولي، الدخول، الجلسات، CSRF
 *   9. إدارة المعلمين: إنشاء/تعطيل/حذف + التحقق من المدخلات
 *  10. النتائج و CSV
 *  11. تكافؤ خلط الخيارات مع خوارزمية تطبيق GAS الأصلي (Code.gs)
 *
 * Usage: npm test   (from cloudflare/)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 8700 + Math.floor(Math.random() * 200); // random port: avoid leftover servers
const BASE = `http://127.0.0.1:${PORT}`;

const BANKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudflare/src/data/banks.json'), 'utf8'));

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

/* ---------- tiny fetch helpers ---------- */
async function jfetch(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, headers: r.headers };
}
async function post(path, body, headers = {}) {
  // retry transient local-worker failures only (5xx / empty body) — never 4xx
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      last = await jfetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...headers },
        body: JSON.stringify(body)
      });
      if (last.status < 500 && last.data) return last;
      if (last.status < 500 && last.status !== 200) return last; // real 4xx
    } catch (e) { last = { status: 0, data: null, text: String(e) }; }
    await new Promise(r => setTimeout(r, 350));
  }
  return last;
}

/* ---------- worker shuffle (must mirror src/worker.js) ---------- */
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
  const arr = [0, 1, 2, 3];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function decodeToken(token) {
  const b = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
}
function correctPositions(examId, seed) {
  return BANKS.examDefs[examId].map((qid, i) => {
    const q = BANKS.questions[qid];
    const perm = shuffledOrder(seed, i);
    return perm.indexOf('ABCD'.indexOf(q.answer));
  });
}
function wrongPositions(examId, seed) {
  return BANKS.examDefs[examId].map((qid, i) => {
    const q = BANKS.questions[qid];
    const perm = shuffledOrder(seed, i);
    const c = perm.indexOf('ABCD'.indexOf(q.answer));
    return (c + 1) % 4;
  });
}

/* ---------- start server ---------- */
console.log('Starting isolated wrangler dev on :' + PORT + ' …');
const STATE = fs.mkdtempSync('/tmp/wrangler-test-');
const proc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', STATE], {
  cwd: path.join(ROOT, 'cloudflare'),
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
proc.stdout.on('data', d => { logs += d; });
proc.stderr.on('data', d => { logs += d; });

async function waitForServer(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/catalog', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    if (proc.exitCode !== null) throw new Error('wrangler dev exited:\n' + logs.slice(-2000));
    await new Promise(r => setTimeout(r, 700));
  }
  throw new Error('server did not start:\n' + logs.slice(-2000));
}

try {
  await waitForServer();
  console.log('Server ready.\n');

  /* ============ 1. static & routes ============ */
  console.log('[1] الصفحات والمسارات');
  {
    const home = await jfetch('/');
    ok('GET / → 200 HTML', home.status === 200 && home.text.includes('منصة الامتحانات'));
    const admin = await jfetch('/admin');
    ok('GET /admin → 200 (admin SPA)', admin.status === 200 && admin.text.includes('لوحة التحكم'));
    const slug = await jfetch('/mostafa');
    ok('GET /mostafa → 200 (معلم افتراضي)', slug.status === 200);
    const notFound = await jfetch('/nOsUcHtEaChEr');
    ok('GET /unknown-slug → 404', notFound.status === 404);
    const css = await jfetch('/styles.css');
    ok('GET /styles.css → 200 CSS', css.status === 200 && css.text.includes('--primary'));
    const robots = await jfetch('/robots.txt');
    ok('robots.txt يمنع /admin و /api', robots.status === 200 && robots.text.includes('Disallow: /admin'));
  }

  /* ============ 2. catalog ============ */
  console.log('\n[2] الكتالوج العام (بلا تسريب)');
  {
    const r = await jfetch('/api/catalog');
    const examCount = Object.keys(r.data.exams).length;
    ok('83 امتحانًا', examCount === 83, 'got ' + examCount);
    ok('لا مفاتيح إجابة في الكتالوج', !r.text.includes('"answer"'));
    ok('لا قوائم أسئلة في الكتالوج', !r.text.includes('questionIds'));
    ok('لا نصوص أسئلة في الكتالوج', !BANKS.examDefs || !r.text.includes(Object.values(BANKS.questions)[0].text.slice(0, 30)));
    const t1 = r.data.catalog.philosophy.terms[0];
    ok('أسماء الوحدات الرسمية (الفلسفة/المنطق)', t1.units[0].title === 'الوحدة الأولى: الفلسفة' && t1.units[1].title === 'الوحدة الثانية: المنطق');
    const psy = r.data.catalog.psychology;
    ok('علم النفس: ٦ وحدات + شامل كامل', psy.units.length === 6 && psy.subjectComprehensiveExamId === 'PSY-FULL-COMP');
    const exam = r.data.exams['U1-T1'];
    ok('امتحان الموضوع يحمل رقم الموضوع واسم الدرس الرسمي', exam.lessonNo === 1 && exam.lessonTitle.includes('من الفلسفة إلى المعمل'));
  }

  /* ============ 3. teachers public ============ */
  console.log('\n[3] ملفات المعلمين');
  {
    const r = await jfetch('/api/teacher/mostafa');
    ok('الملف الافتراضي /mostafa', r.status === 200 && r.data.teacher.name.includes('مصطفى'));
    const nf = await jfetch('/api/teacher/ghost');
    ok('معلم غير موجود → 404', nf.status === 404);
  }

  /* ============ 4. exam sessions ============ */
  console.log('\n[4] جلسات الامتحان');
  let session;
  {
    const bad1 = await post('/api/exam/start', { examId: 'U1-T1', name: '' });
    ok('رفض بدء الجلسة بدون اسم', bad1.status === 400);
    const bad2 = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب', phone: '01' });
    ok('رفض هاتف غير صالح', bad2.status === 400 && bad2.data.error.includes('الهاتف'));
    const bad3 = await post('/api/exam/start', { examId: 'NOPE', name: 'طالب' });
    ok('رفض امتحان غير موجود', bad3.status === 404);
    const noPhone = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب', slug: 'mostafa' });
    ok('طلب رقم الهاتف إلزامي للمعلم الافتراضي', noPhone.status === 400 && noPhone.data.error.includes('مطلوب'));

    const r = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب الاختبار', phone: '01012345678', slug: 'mostafa' });
    ok('بدء جلسة U1-T1', r.status === 200 && r.data.questions.length === 20);
    session = r.data;
    const flat = JSON.stringify(r.data);
    ok('لا تسريب للمفاتيح في الجلسة', !flat.includes('"answer"') && !flat.includes('correctAnswer'));
    ok('عدد الأسئلة = 20 وخيارات كل سؤال 4', r.data.questions.every(q => q.options.length === 4));
  }

  /* ============ 5. submission validation ============ */
  console.log('\n[5] التحقق من التسليم');
  {
    const incomplete = await post('/api/exam/submit', { token: session.token, answers: session.questions.map((_, i) => i === 19 ? null : 1) });
    ok('رفض التسليم الناقص', incomplete.status === 400 && incomplete.data.error.includes('بدون إجابة'));
    const short = await post('/api/exam/submit', { token: session.token, answers: [0, 1] });
    ok('رفض عدد إجابات غير مطابق', short.status === 400);
    const tampered = await post('/api/exam/submit', { token: session.token.slice(0, -6) + 'AAAAAA', answers: session.questions.map(() => 0) });
    ok('رفض توكن متلاعب به (HMAC)', tampered.status === 403);
    const badVal = await post('/api/exam/submit', { token: session.token, answers: session.questions.map(() => 9) });
    ok('رفض قيم إجابة خارج النطاق', badVal.status === 400);
  }

  /* ============ 6. perfect-score round-trip: ALL 83 exams ============ */
  console.log('\n[6] دورة الدرجة الكاملة — كل الامتحانات (83)');
  {
    const examIds = Object.keys(BANKS.examDefs);
    let allOk = true, badOnes = [];
    for (const examId of examIds) {
      const r = await post('/api/exam/start', { examId, name: 'اختبار آلي', phone: '01000000000' });
      if (r.status !== 200) { allOk = false; badOnes.push(examId + ':start'); continue; }
      const seed = decodeToken(r.data.token).seed;
      const answers = correctPositions(examId, seed);
      const s = await post('/api/exam/submit', { token: r.data.token, answers });
      if (s.status !== 200 || s.data.score !== r.data.exam.count || s.data.percentage !== 100) {
        allOk = false; badOnes.push(`${examId}:${s.status}/${s.data && s.data.score}/${r.data.exam.count}`);
      }
    }
    ok('83/83 امتحانًا: الدرجة الكاملة صحيحة والتصحيح متطابق مع البنك', allOk, badOnes.join(', '));
  }

  /* ============ 7. zero-score + review ============ */
  console.log('\n[7] الدرجة الصفرية ومراجعة الأسئلة');
  {
    const r = await post('/api/exam/start', { examId: 'T2P-C1-T1', name: 'اختبار آلي صفر', phone: '01000000000' });
    const seed = decodeToken(r.data.token).seed;
    const answers = wrongPositions('T2P-C1-T1', seed);
    const s = await post('/api/exam/submit', { token: r.data.token, answers });
    ok('درجة صفرية عند إجابات خاطئة كاملة', s.status === 200 && s.data.score === 0 && s.data.wrong === r.data.exam.count);
    ok('المراجعة تعرض إجابة الطالب والإجابة الصحيحة لكل سؤال', s.data.review.length === r.data.exam.count && s.data.review.every(q =>
      q.isCorrect === false && q.studentAnswerText && q.correctAnswerText && q.questionText));
    ok('إجابة الطالب ≠ الإجابة الصحيحة في كل الأسئلة الخاطئة', s.data.review.every(q => q.studentAnswerText !== q.correctAnswerText));
    // replay must return the SAME result (dedupe)
    const again = await post('/api/exam/submit', { token: r.data.token, answers });
    ok('منع إعادة التسليم — نفس النتيجة تُعاد دون حفظ مزدوج', again.status === 200 && again.data.id === s.data.id && again.data.score === 0);
  }

  /* ============ 8. admin auth ============ */
  console.log('\n[8] حساب المسؤول');
  let cookie;
  {
    const noAdmin = await post('/api/admin/login', { email: 'x@y.z', password: 'whatever1' });
    ok('لا دخول قبل إنشاء الحساب (رسالة إعداد)', noAdmin.status === 404);
    const weak = await post('/api/admin/setup', { email: 'bad', password: 'short' });
    ok('رفض بريد/كلمة مرور ضعيفة عند الإعداد', weak.status === 400);
    const setup = await post('/api/admin/setup', { email: 'admin@test.local', password: 'TestAdminPass-2026' });
    ok('الإعداد الأولي ناجح', setup.status === 200);
    const dup = await post('/api/admin/setup', { email: 'a@b.c', password: 'longenough1' });
    ok('لا يمكن إنشاء حساب مسؤول ثانٍ', dup.status === 409);
    const wrong = await post('/api/admin/login', { email: 'admin@test.local', password: 'wrong-password' });
    ok('رفض كلمة مرور خاطئة', wrong.status === 401);
    const login = await post('/api/admin/login', { email: 'admin@test.local', password: 'TestAdminPass-2026' });
    ok('تسجيل الدخول ناجح', login.status === 200 && login.data.ok === true);
    const sc = login.headers.get('set-cookie') || '';
    ok('كوكي الجلسة HttpOnly+SameSite=Strict', /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc));
    cookie = sc.split(';')[0];
    const sessionOk = await jfetch('/api/admin/session', { headers: { Cookie: cookie } });
    ok('الجلسة تعمل', sessionOk.status === 200 && sessionOk.data.email === 'admin@test.local');
    const unauth = await jfetch('/api/admin/overview');
    ok('رفض الوصول بدون جلسة', unauth.status === 401);
    const noCsrf = await fetch(BASE + '/api/admin/teachers', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'x', slug: 'csrfy' })
    });
    ok('رفض طلب تعديل بدون ترويسة CSRF', noCsrf.status === 403);
  }

  /* ============ 9. teacher CRUD ============ */
  console.log('\n[9] إدارة المعلمين');
  {
    const create = await post('/api/admin/teachers', {
      name: 'أ. سارة أحمد', slug: 'sara', bio: 'معلمة علم نفس',
      socialLinks: { whatsapp: 'https://wa.me/201000000000' },
      colors: { primary: '#3a2a5a', accent: '#c9a86a' }, requirePhone: false, enabled: true
    }, { Cookie: cookie });
    ok('إنشاء معلم جديد', create.status === 200 && create.data.teacher.slug === 'sara');
    const publicProfile = await jfetch('/api/teacher/sara');
    ok('الملف العام للمعلمة يعمل', publicProfile.status === 200 && publicProfile.data.teacher.name.includes('سارة'));
    ok('هاتف المعلم لا يظهر في الملف العام', !JSON.stringify(publicProfile.data).includes('phone'));
    const dupSlug = await post('/api/admin/teachers', { name: 'آخر', slug: 'sara' }, { Cookie: cookie });
    ok('رفض slug مكرر', dupSlug.status === 409);
    const badSocial = await post('/api/admin/teachers', { name: 'س', slug: 'bad1', socialLinks: { facebook: 'javascript:alert(1)' } }, { Cookie: cookie });
    ok('رفض رابط تواصل غير http(s)', badSocial.status === 400);
    const reserved = await post('/api/admin/teachers', { name: 'س', slug: 'api' }, { Cookie: cookie });
    ok('رفض slug محجوز (api)', reserved.status === 400);

    const tid = create.data.teacher.id;
    const upd = await jfetch('/api/admin/teachers/' + tid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: cookie },
      body: JSON.stringify({ name: 'أ. سارة أحمد', slug: 'sara', enabled: false, requirePhone: true })
    });
    ok('تعطيل المعلم', upd.status === 200 && upd.data.teacher.enabled === false);
    const disabledPublic = await jfetch('/api/teacher/sara');
    ok('المعلم المعطّل غير متاح للطلاب', disabledPublic.status === 404);
    const del = await jfetch('/api/admin/teachers/' + tid, {
      method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Cookie: cookie }
    });
    ok('حذف المعلم', del.status === 200);
    const gone = await jfetch('/api/teacher/sara');
    ok('الملف المحذوف يعطي 404', gone.status === 404);
    const defDel = await jfetch('/api/admin/teachers/t_default_mostafa', {
      method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Cookie: cookie }
    });
    ok('لا يمكن حذف المعلم الافتراضي', defDel.status === 400);
  }

  /* ============ 10. results & CSV ============ */
  console.log('\n[10] النتائج و CSV');
  {
    const res = await jfetch('/api/admin/results', { headers: { Cookie: cookie } });
    ok('لوحة النتائج تعمل', res.status === 200 && Array.isArray(res.data.results) && res.data.results.length >= 76);
    const csvResp = await fetch(BASE + '/api/admin/results.csv', { headers: { Cookie: cookie } });
    const csvBytes = new Uint8Array(await csvResp.arrayBuffer());
    const csvText = new TextDecoder('utf-8').decode(csvBytes);
    ok('تصدير CSV مع BOM عربي (0xEF 0xBB 0xBF)',
      csvResp.status === 200 && csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF && csvText.includes('اسم الطالب'));
    const overview = await jfetch('/api/admin/overview', { headers: { Cookie: cookie } });
    ok('نظرة عامة: 83 امتحانًا / 1549 سؤالًا + توثيق التصحيحات',
      overview.data.exams === 83 && overview.data.questions === 1549 &&
      overview.data.audit.psychology.corrections.length === 8);
    const qs = await jfetch('/api/admin/questions?subject=philosophy&term=2&q=' + encodeURIComponent('البيئية'), { headers: { Cookie: cookie } });
    ok('بنك الأسئلة: بحث + مفاتيح للمسؤول فقط', qs.status === 200 && qs.data.questions.length > 0 && qs.data.questions[0].answer);
    const qsLogic = await jfetch('/api/admin/questions?subject=philosophy&term=2&q=' + encodeURIComponent('بيكون'), { headers: { Cookie: cookie } });
    ok('بنك أسئلة المنطق ت2: البحث يجد أسئلة بيكون', qsLogic.status === 200 && qsLogic.data.questions.length >= 20);
    const qsPublic = await jfetch('/api/admin/questions');
    ok('بنك الأسئلة محمي بدون جلسة', qsPublic.status === 401);
  }

  /* ============ 11. shuffle equivalence with GAS ============ */
  console.log('\n[11] تكافؤ خلط الخيارات مع تطبيق GAS الأصلي');
  {
    const ctx = { console, Logger: { log() {} } };
    vm.createContext(ctx);
    for (const f of ['Data.gs', 'PhiloData.gs', 'PhiloTerm2Data.gs', 'Code.gs']) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    const gasOrder = vm.runInContext(`shuffledOrder_`, ctx);
    let same = true, firstDiff = '';
    outer:
    for (let seed = 1; seed <= 500; seed++) {
      for (let i = 0; i < 60; i++) {
        const g = gasOrder(seed, i).map(x => 'ABCD'.indexOf(x));
        const w = shuffledOrder(seed, i);
        if (JSON.stringify(g) !== JSON.stringify(w)) { same = false; firstDiff = `seed=${seed} i=${i}`; break outer; }
      }
    }
    ok('خوارزمية الخلط مطابقة تمامًا لـ Code.gs (500 بذرة × 60 موضعًا)', same, firstDiff);
  }

  console.log('\n══════════════════════════════');
  console.log(`النتيجة: ${passed} ناجح ✓ / ${failed} فاشل ✗`);
} finally {
  proc.kill('SIGTERM');
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
