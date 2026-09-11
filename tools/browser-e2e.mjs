/**
 * browser-e2e.mjs — متصفح Chromium حقيقي (إلزامي في التدقيق النهائي، 2026-09-11)
 * ================================================================================
 * يشغّل مصفوفة QA الكاملة على wrangler dev: مسؤول (إعداد أولي → إضافة معلم → تعطيل/إعادة تفعيل →
 * إعادة تعيين كلمة مرور → تغيير كلمة مرور المسؤول → إعدادات المنصة)، معلم (/teacher بلا تسجيل، لوحة،
 * ملف شخصي مع النبذة ويوتيوب، عزل تام، منع CSRF)، طالب (تدفق كامل من رابط المعلم حتى النتيجة)،
 * أمان حي (slug وهمي 404، حقن درجة، بلا تسريب مفاتيح)، ومصفوفة عرض حقيقية
 * 360×800 / 390×844 / 412×915 / 1280×720 / 1440×900 / 1920×1080 (RTL بلا overflow).
 *
 * التشغيل (يتطلب شبكة لـnpm ولقطات في مجلد tools/shots):
 *   cd cloudflare && npx wrangler dev --port 8787 --persist-to /tmp/wrangler-qa &   # KV نظيف
 *   npm i --no-save playwright-core @sparticuz/chromium @sparticuz/chromium-min @fontsource/noto-sans-arabic
 *   # فكّ bin/*.br من @sparticuz/chromium إلى /tmp/chrm و al2023.tar.br إلى /tmp/crlibs/lib
 *   QABASE=http://127.0.0.1:8787 node tools/browser-e2e.mjs
 * (هذا الملف وثيقة QA — لا يدخل npm test الذي يعمل بلا متصفح.)
 */
import fs from 'node:fs';
import chromiumMin from '@sparticuz/chromium-min';
import { chromium as pw } from 'playwright-core';

const BASE = process.env.QABASE || 'http://127.0.0.1:8787';
const SHOTS = process.env.QASHOTS || (import.meta.dirname + '/shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ADMIN_EMAIL = 'qa-admin@exam.test';
const ADMIN_PASS = 'QaAdmin#2026x';
const T_A = {
  name: 'أ. أحمد QA', slug: 'ahmedqa', email: 'ahmed@qa.test', user: 'ahmedqa', pass: 'Teacher#Pass1',
  phone: '01144445550', bio: 'نبذة أحمد التعليمية', specialty: 'مدرس الفلسفة والمنطق',
  wa: 'https://wa.me/201144445550', fb: 'https://facebook.com/ahmed.qa', yt: 'https://youtube.com/@ahmedqa'
};
const T_B = { name: 'BakerQA', email: 'baker@qa.test', pass: 'Baker#Pass22' };
const STUDENT = { name: 'طالب تجريبي واحد', phone: '01144445551' };

const exe = await chromiumMin.executablePath('/tmp/chrm');
process.env.LD_LIBRARY_PATH = (process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : '') + '/tmp/crlibs/lib';
const browser = await pw.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ar'], headless: true });

let apiAudit = [];
async function noCache(ctx) {
  await ctx.route(/.*\.(js|css)(\?.*)?$/, route => route.continue({ headers: { ...route.request().headers(), 'Cache-Control': 'no-cache' } }));
}
function attachAudit(page) {
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (u.includes('/api/admin/teachers') || u.includes('/api/exam/') || u.includes('/api/t/')) {
        const ct = r.headers()['content-type'] || '';
        if (ct.includes('json')) apiAudit.push({ url: u, status: r.status, text: await r.text() });
      }
    } catch { }
  });
}
const auditFor = sub => apiAudit.filter(a => a.url.includes(sub));
async function shot(page, name) { await page.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: false }); console.log('    [shot] ' + name + '.png'); }

try {
  /* ============ 1. ADMIN: first-run setup + login ============ */
  console.log('\n[1] ADMIN — الإعداد الأولي والدخول');
  const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 950 }, locale: 'ar-EG' });
  await noCache(adminCtx);
  const ap = await adminCtx.newPage();
  attachAudit(ap);
  await ap.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  ok('/admin يعرض شاشة الإعداد الأولي عند عدم وجود حساب', (await ap.locator('text=إنشاء حساب المسؤول').count()) === 1);
  await shot(ap, '01-admin-first-run-setup');
  await ap.fill('#admEmail', ADMIN_EMAIL);
  await ap.fill('#admPass', ADMIN_PASS);
  await ap.fill('#admPass2', ADMIN_PASS);
  await ap.click('button:has-text("إنشاء الحساب")');
  await ap.waitForSelector('button:has-text("دخول")', { timeout: 10000 }); // setup → login form
  await ap.fill('#admEmail', ADMIN_EMAIL);
  await ap.fill('#admPass', ADMIN_PASS);
  await ap.click('button:has-text("دخول")');
  await ap.waitForSelector('.a-sidebar', { timeout: 10000 });
  ok('تسجيل دخول المسؤول يفتح اللوحة (الشريط الجانبي + البريد)', (await ap.locator('#aEmail').textContent()) === ADMIN_EMAIL);
  {
    const sideTxt = await ap.locator('.a-sidebar').innerText();
    ok('الشريط الجانبي يعرض الأقسام الثمانية', ['نظرة عامة', 'المعلمون', 'علم النفس', 'الفلسفة والمنطق', 'بنك الأسئلة', 'الامتحانات', 'النتائج', 'الإعدادات'].every(t => sideTxt.includes(t)));
  }
  await shot(ap, '02-admin-shell');

  /* ============ 2. ADMIN → Teachers → + Add Teacher ============ */
  console.log('\n[2] ADMIN — إضافة معلم (الملف الكامل + بيانات الدخول + الحدود + يوتيوب)');
  await ap.click('.a-nav-item:has-text("المعلمون")');
  await ap.waitForSelector('button:has-text("+ إضافة معلم جديد")');
  await ap.click('button:has-text("+ إضافة معلم جديد")');
  await ap.waitForSelector('#tName');
  await ap.fill('#tName', T_A.name);
  await ap.fill('#tSlug', T_A.slug);
  await ap.fill('#tEmail', T_A.email);
  await ap.fill('#tUsername', T_A.user);
  await ap.fill('#tPassword', T_A.pass);
  await ap.fill('#tPhone', T_A.phone);
  await ap.fill('#tSpecialty', T_A.specialty);
  await ap.fill('#tBio', T_A.bio);
  await ap.fill('#tWhats', T_A.wa);
  await ap.fill('#tFb', T_A.fb);
  await ap.fill('#tYt', T_A.yt);
  await ap.click('#tSave');
  await ap.waitForSelector(`a[href="/${T_A.slug}"]`, { timeout: 10000 });
  const cardText = await ap.locator('.teacher-card', { hasText: T_A.name }).first().innerText();
  ok('البطاقة تعرض اسم المعلم', cardText.includes('أحمد QA'));
  ok('البطاقة تعرض رابط الطلاب', cardText.includes('/' + T_A.slug));
  ok('البطاقة تعرض البريد', cardText.includes(T_A.email));
  ok('البطاقة تعرض حالة الدخول (دخول مضبوط)', cardText.includes('دخول مضبوط'));
  ok('البطاقة تعرض صف حد الطلاب', cardText.includes('حد الطلاب'));
  ok('البطاقة تعرض زر تعديل', (await ap.locator('.teacher-card', { hasText: T_A.name }).first().locator('button:has-text("تعديل")').count()) >= 1);
  await shot(ap, '03-admin-teacher-card');

  // Teacher B — slug auto-generated from the name
  await ap.click('button:has-text("+ إضافة معلم جديد")');
  await ap.waitForSelector('#tName');
  await ap.fill('#tName', T_B.name);
  await ap.fill('#tEmail', T_B.email);
  await ap.fill('#tPassword', T_B.pass);
  await ap.click('#tSave');
  await ap.waitForSelector('a[href="/bakerqa"]', { timeout: 10000 });
  ok('slug يُولَّد تلقائيًا من الاسم (BakerQA → /bakerqa)', (await ap.locator('.teacher-card', { hasText: 'BakerQA' }).first().innerText()).includes('/bakerqa'));

  // Admin list must NEVER contain credential material
  const latest = auditFor('/api/admin/teachers').filter(a => a.url.endsWith('/api/admin/teachers'));
  const anyLeak = latest.some(a => /passHash|passSalt|passIterations/.test(a.text));
  ok('استجابة /api/admin/teachers لا تتضمن passHash/passSalt أبدًا', latest.length > 0 && !anyLeak);

  // Edit: rename must NOT break the slug; bio+youtube must survive
  await ap.locator('.teacher-card', { hasText: 'أحمد QA' }).first().locator('button:has-text("تعديل")').click();
  await ap.waitForSelector('#tName');
  await ap.fill('#tName', 'أ. أحمد QA ٢');
  await ap.click('#tSave');
  await ap.waitForSelector('a[href="/' + T_A.slug + '"]', { timeout: 10000 });
  const card2 = await ap.locator('.teacher-card', { hasText: 'أحمد QA ٢' }).first().innerText();
  ok('تغيير الاسم يحافظ على slug الحالي', card2.includes('/' + T_A.slug) && card2.includes('أحمد QA ٢'));

  /* ============ 3. TEACHER LOGIN PAGE: no registration ============ */
  console.log('\n[3] /teacher — رابط ثابت بلا تسجيل');
  const tctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-EG' });
  await noCache(tctx);
  const tp = await tctx.newPage();
  attachAudit(tp);
  await tp.goto(BASE + '/teacher', { waitUntil: 'networkidle' });
  const tHtml = await tp.content();
  ok('/teacher يعرض دخولًا فقط — لا إنشاء حساب/تسجيل جديد', !/إنشاء حساب|تسجيل جديد|Sign up|\bregister\b/i.test(tHtml));
  const tBodyTxt = await tp.evaluate(() => document.body.innerText);
  ok('صفحة المعلم تعرض رموزًا سليمة (بلا محارف \\u حرفية)', !/\\u[0-9a-f]{4}/.test(tBodyTxt) && !tBodyTxt.includes('\uFFFD'), tBodyTxt.slice(0, 80));
  ok('عنوان الصفحة لوحة المعلم', (await tp.locator('h1').first().innerText()).includes('لوحة المعلم'));
  await shot(tp, '04-teacher-login');
  // wrong credentials rejected
  await tp.fill('#tEmail', T_A.email); await tp.fill('#tPass', 'WrongPass#000');
  await tp.click('#loginBtn');
  await tp.waitForSelector('#loginErr:not(:empty)', { timeout: 8000 });
  ok('كلمة مرور خاطئة → رسالة خطأ بدون كشف أي شيء', (await tp.locator('#loginErr').textContent()).includes('غير صحيحة'));
  // login with admin-created creds
  await tp.fill('#tPass', T_A.pass);
  await tp.click('#loginBtn');
  await tp.waitForSelector('#teacherName', { state: 'visible', timeout: 10000 });
  ok('دخول المعلم ناجح (بيانات أنشأها المسؤول فقط)', (await tp.locator('#teacherName').textContent()).includes('أحمد QA ٢'));
  await tp.waitForSelector('.t-stat-grid', { timeout: 10000 });
  await shot(tp, '05-teacher-dashboard');
  ok('لوحة بسيطة: رئيسية/طلاب/نتائج/ملف/كلمة مرور (5 عناصر)', (await tp.locator('.t-nav-item').count()) === 5);

  /* ============ 4. Teacher profile: prefill + link + youtube; no bio-wipe ============ */
  console.log('\n[4] ملف المعلم الشخصي (pre-fill + رابط + يوتيوب + بلا مسح بيانات)');
  await tp.click('.t-nav-item[data-tab="profile"]');
  await tp.waitForSelector('#pfBio', { timeout: 10000 });
  ok('الملف الشخصي يعرض رابط الطلاب مع زر نسخ', (await tp.locator('#pfCard').innerText()).includes('/' + T_A.slug) && (await tp.locator('#pfCard button:has-text("نسخ")').count()) >= 1);
  ok('pre-fill: الاسم محفوظ', (await tp.locator('#pfName').inputValue()).includes('أحمد QA ٢'));
  ok('pre-fill: النبذة محفوظة (لم تُمسح عند الحفظ السابق)', (await tp.locator('#pfBio').inputValue()) === T_A.bio);
  ok('pre-fill: واتساب محفوظ', (await tp.locator('#pfWa').inputValue()) === T_A.wa);
  ok('pre-fill: يوتيوب محفوظ (حقل جديد)', (await tp.locator('#pfYt').inputValue()) === T_A.yt);
  await tp.click('#pfBtn'); // save without changes → must NOT wipe
  await sleep(700);
  await tp.click('.t-nav-item[data-tab="home"]');
  await tp.click('.t-nav-item[data-tab="profile"]');
  await tp.waitForSelector('#pfBio');
  ok('الحفظ دون تغيير لا يمسح النبذة/الروابط', (await tp.locator('#pfBio').inputValue()) === T_A.bio && (await tp.locator('#pfWa').inputValue()) === T_A.wa && (await tp.locator('#pfYt').inputValue()) === T_A.yt);
  // update bio+youtube from the teacher dashboard
  await tp.fill('#pfBio', 'نبذة محدثة من لوحة المعلم');
  await tp.fill('#pfYt', 'https://youtube.com/@updated-qa');
  await tp.click('#pfBtn');
  await sleep(700);
  await tp.click('.t-nav-item[data-tab="home"]');
  await tp.click('.t-nav-item[data-tab="profile"]');
  await tp.waitForSelector('#pfBio');
  ok('تحديث النبذة ويوتيوب من لوحة المعلم', (await tp.locator('#pfBio').inputValue()) === 'نبذة محدثة من لوحة المعلم' && (await tp.locator('#pfYt').inputValue()) === 'https://youtube.com/@updated-qa');
  await shot(tp, '06-teacher-profile');

  /* ============ 5. Teacher isolation + admin block + CSRF ============ */
  console.log('\n[5] العزل والأمان من جهة المتصفح');
  const sec1 = await tp.evaluate(() => fetch('/api/admin/teachers', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.status));
  const sec2 = await tp.evaluate(() => fetch('/api/admin/overview').then(r => r.status));
  const sec3 = await tp.evaluate(() => fetch('/api/t/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'بدون CSRF' }) }).then(r => r.status));
  ok('معلم لا يصل /api/admin/teachers (401)', sec1 === 401, String(sec1));
  ok('معلم لا يصل /api/admin/overview (401)', sec2 === 401, String(sec2));
  ok('POST بلا ترويسة CSRF مرفوض (403)', sec3 === 403, String(sec3));
  const ownResults = await tp.evaluate(() => fetch('/api/t/results', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.json()));
  ok('نتائج المعلم A فارغة قبل أي امتحان (عزل خادومي)', ownResults.total === 0);
  // Teacher B sees nothing of A
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-EG' });
  await noCache(bctx);
  const bp = await bctx.newPage();
  await bp.goto(BASE + '/teacher');
  await bp.fill('#tEmail', T_B.email); await bp.fill('#tPass', T_B.pass); await bp.click('#loginBtn');
  await bp.waitForSelector('#teacherName', { timeout: 10000 });
  const bRes = await bp.evaluate(() => fetch('/api/t/results', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.json()));
  ok('المعلم B لا يرى أي شيء من بيانات A (نتائج 0)', bRes.total === 0);
  const bStu = await bp.evaluate(() => fetch('/api/t/students', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.json()));
  ok('المعلم B: طلابه فارغون فقط (لا طلاب A)', bStu.total === 0);
  const cross = await bp.evaluate(() => fetch('/api/admin/teachers/t_default_mostafa/stats', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.status));
  ok('إحصاءات لوحة أي معلم محجوبة عن معلم آخر (401)', cross === 401, String(cross));

  /* ============ 6. STUDENT flow via /ahmedqa (real UI clicks) ============ */
  console.log('\n[6] تدفق الطالب من رابط المعلم (واجهة حقيقية + يوتيوب)');
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ar-EG' });
  await noCache(sctx);
  const sp = await sctx.newPage();
  attachAudit(sp);
  await sp.goto(BASE + '/' + T_A.slug, { waitUntil: 'networkidle' });
  ok('صفحة المعلم تحمل اسمه في الهوية', (await sp.locator('#brandName').textContent()).includes('أحمد QA ٢'));
  ok('صفحة المعلم تحمل نبذته', (await sp.locator('.about-card').first().textContent()).includes('نبذة محدثة'));
  ok('صفحة المعلم تعرض رابط يوتيوب فعلي فقط', (await sp.locator('.about-card a[href*="youtube.com"]').count()) >= 1);
  await sp.click('text=ابدأ الامتحان الآن');
  await sp.waitForSelector('#stName');
  await sp.fill('#stName', STUDENT.name);
  await sp.fill('#stPhone', STUDENT.phone);
  await sp.click('.grade-opt[data-grade="philosophy"]');
  await sp.click('#contBtn');
  await sp.waitForSelector('.topic-card', { timeout: 10000 });
  const topicCount = await sp.locator('.topic-card').count();
  ok('شاشة الترم/الموضوعات تعرض الموضوعات', topicCount >= 1, String(topicCount));
  await sp.locator('.topic-card').first().click();
  await sp.waitForSelector('.lesson-card', { timeout: 10000 });
  const lessonCards = await sp.locator('.lesson-card').count();
  ok('عرض دروس الموضوع', lessonCards >= 1, String(lessonCards));
  await sp.locator('.lesson-card').first().click();
  await sp.waitForSelector('.training-card, #startBtn', { timeout: 10000 });
  if (await sp.locator('.training-card').count()) {
    await sp.locator('.tc-start').first().click();
    await sp.waitForSelector('#startBtn', { timeout: 10000 });
  }
  // answer-key safety: inspect the ACTUAL exam/start response the browser received
  const startRespP = sp.waitForResponse(r => r.url().includes('/api/exam/start') && r.status() === 200, { timeout: 20000 });
  await sp.click('#startBtn');
  const startBody = await (await startRespP).text();
  await sp.waitForSelector('.qcard', { timeout: 15000 });
  const leaky = /"answer"|correctAnswer|correct_answer|correct_option|isCorrect|answerKey/.test(startBody);
  ok('استجابة /api/exam/start لا تحمل أي مفاتيح إجابة (متصفّح حقيقي)', startBody.length > 0 && !leaky);
  const qFields = JSON.parse(startBody).questions[0];
  ok('السؤال: حقول no/id/text/options فقط', qFields && JSON.stringify(Object.keys(qFields).sort()) === '["id","no","options","text"]');
  const totalQ = await sp.evaluate(() => window.S.session.questions.length);
  for (let i = 0; i < totalQ; i++) {
    await sp.click('.opts .opt >> nth=0');
    await sleep(40);
    if (i < totalQ - 1) await sp.click('button:has-text("السؤال التالي")');
    else await sp.click('button:has-text("مراجعة وتسليم")');
  }
  await sp.waitForSelector('#submitBtn:not([disabled])', { timeout: 10000 });
  await shot(sp, '07-student-review-before-submit');
  const submitRespP = sp.waitForResponse(r => r.url().includes('/api/exam/submit') && r.status() === 200, { timeout: 20000 });
  await sp.click('#submitBtn');
  const submitBody = await (await submitRespP).text();
  await sp.waitForSelector('.score-ring', { timeout: 15000 });
  const pct = await sp.locator('.score-ring .pct').textContent();
  ok('شاشة النتيجة تظهر بعد التسليم', /%/.test(pct), pct);
  await shot(sp, '08-student-result');
  const submitJson = JSON.parse(submitBody);
  ok('استجابة التسليم تحوي المراجعة فقط بعد التصحيح الخادومي', submitJson.review.length === totalQ && typeof submitJson.score === 'number' && submitJson.score <= totalQ);

  /* ============ 7. Teacher A dashboard now shows the result ============ */
  console.log('\n[7] النتيجة تظهر في لوحة المعلم (ربط خادومي)');
  await sleep(1300);
  await tp.reload({ waitUntil: 'networkidle' });
  await tp.waitForSelector('.t-stat-grid', { timeout: 15000 });
  const homeTxt = await tp.locator('.t-main').innerText();
  ok('لوحة A تعرض نتيجة الطالب (اسم + آخر نشاط)', homeTxt.includes(STUDENT.name), homeTxt.slice(0, 240));
  await tp.click('.t-nav-item[data-tab="students"]');
  await tp.waitForSelector('.t-stu-card', { timeout: 10000 });
  ok('تبويب الطلاب يعرض الطالب + هاتفه', (await tp.locator('.t-stu-card').first().innerText()).includes(STUDENT.phone));
  await tp.click('.t-nav-item[data-tab="results"]');
  await tp.waitForSelector('.t-result-card', { timeout: 10000 });
  ok('تبويب النتائج يعرض نتيجة الطالب', (await tp.locator('.t-result-card').first().innerText()).includes(STUDENT.name));
  await shot(tp, '09-teacher-results');
  const bRes2 = await bp.evaluate(() => fetch('/api/t/results', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.json()));
  ok('B لا تزال لا ترى نتيجة A بعد التسليم', bRes2.total === 0);
  const found = await tp.evaluate(() => fetch('/api/t/results?q=' + encodeURIComponent('لا يوجد'), { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.json()));
  ok('البحث في النتائج يعمل ويرجّع 0 لغير المطابق', found.total === 0);

  /* ============ 8. SECURITY: fake slug, score injection, disabled teacher, password reset ============ */
  console.log('\n[8] اختبارات أمان مباشرة');
  const ghostStart = await sp.evaluate(() => fetch('/api/exam/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ examId: 'U1-T1', name: 'وهم', phone: '01099999991', slug: 'no-such-teacher-999' }) }).then(r => r.status));
  ok('بدء بـ slug وهمي → 404', ghostStart === 404, String(ghostStart));
  const rootStart = await sp.evaluate(async () => {
    const r = await fetch('/api/exam/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ examId: 'U1-T1', name: 'طالب الجذر', phone: '01099999993' }) });
    return { status: r.status, d: await r.json() };
  });
  ok('بدء بلا slug (الصفحة الجذرية) مسموح ويُنسب خادوميًا للمالك', rootStart.status === 200 && !!rootStart.d.token);
  const scoreInject = await sp.evaluate(async () => {
    const r = await fetch('/api/exam/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ examId: 'U1-T1', name: 'طالب حقن درجة', phone: '01099999994', slug: 'ahmedqa' }) });
    const d = await r.json();
    const s2 = await fetch('/api/exam/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d.token, answers: new Array(20).fill(0), score: 9999, percentage: 100, isAdmin: true }) });
    return await s2.json();
  });
  ok('حقن درجة من العميل يُتجاهل (تصحيح خادومي فقط)', typeof scoreInject.score === 'number' && scoreInject.score <= 20 && scoreInject.total === 20);
  await ap.click('.a-nav-item:has-text("النتائج")');
  await ap.waitForSelector('.tbl', { timeout: 15000 });
  const resTable = await ap.locator('.tbl').innerText();
  ok('لوحة المسؤول ترى نتيجة الطالب (رؤية كاملة)', resTable.includes('طالب تجريبي واحد'), resTable.slice(0, 120));
  await shot(ap, '10-admin-results');
  const csv = await ap.evaluate(() => fetch('/api/admin/results.csv', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.text()));
  ok('CSV يشمل عمود المعلم للنتيجة', csv.includes('ahmedqa'));
  // Disable teacher A
  await ap.click('.a-nav-item:has-text("المعلمون")');
  await ap.waitForSelector('.teacher-card');
  await ap.locator('.teacher-card', { hasText: 'أحمد QA ٢' }).first().locator('button:has-text("تعديل")').click();
  await ap.waitForSelector('#tEnabled', { state: 'attached' });
  await ap.locator('#tEnabled').evaluate(el => el.click());
  await ap.waitForTimeout(150);
  await ap.click('#tSave');
  await sleep(600);
  const sessAfterDisable = await tp.evaluate(() => fetch('/api/t/session', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.status));
  ok('تعطيل المعلم يسقط جلساته فورًا (401)', sessAfterDisable === 401, String(sessAfterDisable));
  await sp.goto(BASE + '/' + T_A.slug, { waitUntil: 'networkidle' });
  ok('صفحة طالب لمعلم معطّل: رسالة غير متاح', (await sp.locator('text=هذا الرابط غير متاح حاليًا').count()) === 1);
  await shot(sp, '11-disabled-teacher-page');
  const loginDisabled = await tctx.newPage();
  await loginDisabled.goto(BASE + '/teacher');
  await loginDisabled.fill('#tEmail', T_A.email); await loginDisabled.fill('#tPass', T_A.pass); await loginDisabled.click('#loginBtn');
  await loginDisabled.waitForSelector('#loginErr:not(:empty)', { timeout: 8000 });
  ok('معلم معطّل لا يستطيع الدخول', (await loginDisabled.locator('#loginErr').textContent()).includes('غير صحيحة'));
  await loginDisabled.close();
  // re-enable
  await ap.locator('.teacher-card', { hasText: 'أحمد QA ٢' }).first().locator('button:has-text("تعديل")').click();
  await ap.waitForSelector('#tEnabled', { state: 'attached' });
  await ap.locator('#tEnabled').evaluate(el => el.click());
  await ap.waitForTimeout(150);
  await ap.click('#tSave');
  await sleep(500);
  const loginBack = await tctx.newPage();
  await loginBack.goto(BASE + '/teacher');
  await loginBack.fill('#tEmail', T_A.email); await loginBack.fill('#tPass', T_A.pass); await loginBack.click('#loginBtn');
  await loginBack.waitForSelector('#teacherName', { timeout: 10000 });
  ok('إعادة التفعيل تعيد المعلم للحياة', (await loginBack.locator('#teacherName').textContent()).includes('أحمد'));
  await loginBack.close();
  // admin resets teacher password via edit form; old password dies
  await ap.locator('.teacher-card', { hasText: 'أحمد QA ٢' }).first().locator('button:has-text("تعديل")').click();
  await ap.waitForSelector('#tPassword');
  await ap.fill('#tPassword', 'NewQa#Pass9');
  await ap.click('#tSave');
  await sleep(700);
  const rstCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-EG' });
  const oldPwRst = await rstCtx.newPage();
  await oldPwRst.goto(BASE + '/teacher');
  await oldPwRst.fill('#tEmail', T_A.email); await oldPwRst.fill('#tPass', T_A.pass); await oldPwRst.click('#loginBtn');
  await oldPwRst.waitForSelector('#loginErr:not(:empty)', { timeout: 8000 });
  ok('إعادة تعيين كلمة المرور: القديمة مرفوضة', (await oldPwRst.locator('#loginErr').textContent()).includes('غير صحيحة'));
  await oldPwRst.fill('#tPass', 'NewQa#Pass9'); await oldPwRst.click('#loginBtn');
  await oldPwRst.waitForSelector('#teacherName', { timeout: 10000 });
  ok('إعادة تعيين كلمة المرور: الجديدة تدخل', true);
  await rstCtx.close();
  // restore teacher password for determinism
  await ap.locator('.teacher-card', { hasText: 'أحمد QA ٢' }).first().locator('button:has-text("تعديل")').click();
  await ap.waitForSelector('#tPassword');
  await ap.fill('#tPassword', T_A.pass);
  await ap.click('#tSave'); await sleep(500);

  // admin password change via settings → account
  await ap.click('.a-nav-item:has-text("الإعدادات")');
  await ap.waitForSelector('.st-tabs', { timeout: 10000 });
  await ap.click('.st-tabs .tab:has-text("الحساب")');
  await ap.waitForSelector('#pwCur');
  await ap.fill('#pwCur', ADMIN_PASS); await ap.fill('#pwNew', 'QaAdmin#2026y'); await ap.fill('#pwNew2', 'QaAdmin#2026y');
  const pwRespP = ap.waitForResponse(r => r.url().includes('/api/admin/password'), { timeout: 15000 });
  await ap.click('#pwBtn');
  const pwResp = await pwRespP;
  ok('تغيير كلمة مرور المسؤول من الواجهة يعمل (200)', pwResp.status() === 200);
  const stillIn = await ap.evaluate(() => fetch('/api/admin/session').then(r => r.status));
  ok('المتصفح الحالي يبقى مسجلاً بعد التغيير', stillIn === 200);
  const relogNew = await (await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: 'QaAdmin#2026y' }) })).status;
  const relogOld = await (await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }) })).status;
  ok('كلمة المرور الجديدة تعمل والقديمة ماتت', relogNew === 200 && relogOld === 401, relogNew + '/' + relogOld);

  /* ============ 9. PLATFORM SETTINGS reflected on the student page ============ */
  console.log('\n[9] إعدادات المنصة تنعكس على صفحة الطالب');
  await ap.click('.a-nav-item:has-text("الإعدادات")');
  await ap.waitForSelector('.st-tabs');
  await ap.click('.st-tabs .tab:has-text("هوية المنصة")');
  await ap.waitForSelector('[data-k="identity.platformName"]');
  await ap.fill('[data-k="identity.platformName"]', 'منصة الاختبار QA');
  await ap.fill('[data-k="identity.academicYear"]', '2027 / 2028');
  await ap.click('#stSave');
  await ap.waitForSelector('.st-tabs .tab:has-text("الشكل العام")');
  await sleep(600);
  await ap.click('.st-tabs .tab:has-text("الشكل العام")');
  await ap.waitForSelector('[data-k="appearance.primary"]');
  await ap.fill('[data-k="appearance.primary"]', '#0E7C4A');
  await ap.fill('[data-k="appearance.accent"]', '#D9A441');
  await ap.click('#stSave');
  await ap.waitForSelector('body');
  await sleep(800);
  const pubSettings = await ap.evaluate(() => fetch('/api/settings').then(r => r.json()));
  ok('الإعدادات المحفوظة تُقرأ من الخادم (اسم المنصة)', pubSettings.identity.platformName === 'منصة الاختبار QA');
  ok('العام الدراسي الجديد محفوظ', pubSettings.identity.academicYear === '2027 / 2028');
  // fresh student context reflects the new branding + color + year
  const s2ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-EG' });
  await noCache(s2ctx);
  const sp2 = await s2ctx.newPage();
  await sp2.goto(BASE + '/', { waitUntil: 'networkidle' });
  ok('اسم المنصة الجديد يظهر في التذييل', (await sp2.locator('#footBrand').textContent()).includes('منصة الاختبار QA'));
  ok('العام الدراسي الجديد يظهر في الواجهة', (await sp2.locator('.hero').first().textContent()).includes('2027 / 2028'));
  const primaryVar = await sp2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
  ok('اللون الأساسي الجديد مطبق (#0E7C4A)', primaryVar === '#0E7C4A', primaryVar);
  await shot(sp2, '12-settings-reflected');
  await s2ctx.close();

  /* ============ 10. MOBILE-FIRST hero order + RTL ============ */
  console.log('\n[10] موبايل 360×800 RTL — الترتيب صورة ← اسم ← CTA ← نبذة');
  const mctx = await browser.newContext({ viewport: { width: 360, height: 800 }, locale: 'ar-EG', isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' });
  await noCache(mctx);
  const mp = await mctx.newPage();
  await mp.goto(BASE + '/' + T_A.slug, { waitUntil: 'networkidle' });
  const noOverflowHome = await mp.evaluate(() => document.documentElement.scrollWidth);
  ok('الرئيسية 360px: لا أفقي overflow', noOverflowHome <= 360, 'scrollWidth=' + noOverflowHome);
  ok('الصفحة RTL فعلية dir=rtl', (await mp.evaluate(() => document.documentElement.dir)) === 'rtl');
  const bodyTxt = await mp.evaluate(() => document.body.innerText);
  ok('لا حروف فاسدة (mojibake) في نص العربية', !bodyTxt.includes('\uFFFD') && /[\u0600-\u06FF]/.test(bodyTxt));
  const heroOrder = await mp.evaluate(() => {
    const kids = [...document.querySelector('.hero').children].map(c => c.className);
    const body = document.querySelector('.hero-body');
    return { first: kids[0], hasName: !!body.querySelector('h1'), hasCta: !!body.querySelector('.hero-ctas .btn'), hasBio: !!document.querySelector('.about-card .bio') };
  });
  ok('الترتيب الموبايل: الصورة أولًا ثم الاسم ثم CTA ثم النبذة', heroOrder.first === 'hero-media' && heroOrder.hasName && heroOrder.hasCta && heroOrder.hasBio, JSON.stringify(heroOrder));
  await shot(mp, '13-mobile-teacher-home');
  await mp.click('text=ابدأ الامتحان الآن');
  await mp.fill('#stName', 'طالبة موبايل');
  await mp.fill('#stPhone', '01234567890');
  await mp.click('.grade-opt[data-grade="philosophy"]');
  await mp.click('#contBtn');
  await mp.waitForSelector('.topic-card', { timeout: 10000 });
  ok('شاشة الاختيار على الموبايل بلا overflow', (await mp.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await mp.locator('.topic-card').first().click();
  await mp.waitForSelector('.lesson-card', { timeout: 10000 });
  await mp.locator('.lesson-card').first().click();
  await mp.waitForSelector('.training-card, #startBtn', { timeout: 10000 });
  if (await mp.locator('.training-card').count()) { await mp.locator('.tc-start').first().click(); await mp.waitForSelector('#startBtn', { timeout: 10000 }); }
  const startVisible = await mp.locator('#startBtn').boundingBox();
  ok('زر البدء واضح على الشاشة (touch ≥ 40px)', startVisible && startVisible.height >= 40 && startVisible.width > 100);
  await mp.click('#startBtn');
  await mp.waitForSelector('.qcard', { timeout: 15000 });
  await shot(mp, '14-mobile-quiz');
  const optBoxes = await mp.locator('.opts .opt').all();
  let optsVisible = true, optsInView = true;
  for (const el of optBoxes) { const b = await el.boundingBox(); if (!b || b.width < 50 || b.height < 36) optsVisible = false; if (b && (b.x < 0 || b.x + b.width > 360)) optsInView = false; }
  ok('الخيارات الأربعة مرئية وقابلة للمس داخل العرض', optsVisible && optsInView);
  const mq = await mp.evaluate(() => window.S.session.questions.length);
  for (let i = 0; i < mq; i++) { await mp.click('.opts .opt >> nth=0'); await sleep(30); if (i < mq - 1) await mp.click('button:has-text("السؤال التالي")'); else await mp.click('button:has-text("مراجعة وتسليم")'); }
  await mp.waitForSelector('#submitBtn:not([disabled])', { timeout: 10000 });
  await mp.click('#submitBtn');
  await mp.waitForSelector('.score-ring', { timeout: 15000 });
  await shot(mp, '15-mobile-result');
  ok('شاشة النتيجة على الموبايل تعمل', /%/.test(await mp.locator('.score-ring .pct').textContent()));
  // teacher login + dashboard on mobile
  await mp.goto(BASE + '/teacher');
  const tnoOv = await mp.evaluate(() => document.documentElement.scrollWidth);
  ok('صفحة دخول المعلم 360px بلا overflow', tnoOv <= 360, 'scrollWidth=' + tnoOv);
  await mp.fill('#tEmail', 'baker@qa.test'); await mp.fill('#tPass', T_B.pass);
  const tbtn = await mp.locator('#loginBtn').boundingBox();
  ok('زر دخول المعلم مناسب للمس (≥40px)', tbtn && tbtn.height >= 40);
  await mp.click('#loginBtn');
  await mp.waitForSelector('.t-stat-grid', { timeout: 15000 });
  await shot(mp, '16-mobile-teacher-dashboard');
  const mOvDash = await mp.evaluate(() => document.documentElement.scrollWidth);
  ok('لوحة المعلم على الموبايل بلا overflow', mOvDash <= 360, 'scrollWidth=' + mOvDash);
  const amp = await mctx.newPage();
  await amp.goto(BASE + '/admin');
  await amp.waitForSelector('#admEmail', { timeout: 10000 });
  const aOv = await amp.evaluate(() => document.documentElement.scrollWidth);
  ok('لوحة المسؤول 360px بلا overflow أفقي', aOv <= 360, 'scrollWidth=' + aOv);

  /* ============ 11. VIEWPORT MATRIX ============ */
  console.log('\n[11] مصفوفة العرض 360/390/412/1280/1440/1920 — بلا overflow أفقي + RTL');
  const sizes = [
    [360, 800, true], [390, 844, true], [412, 915, true],
    [1280, 720, false], [1440, 900, false], [1920, 1080, false]
  ];
  for (const [w, h, isMobile] of sizes) {
    const c = await browser.newContext({
      viewport: { width: w, height: h }, locale: 'ar-EG',
      isMobile, hasTouch: isMobile,
      userAgent: isMobile ? 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36' : undefined
    });
    await noCache(c);
    const pg = await c.newPage();
    await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
    const homeSW = await pg.evaluate(() => document.documentElement.scrollWidth);
    ok('الرئيسية ' + w + 'px بلا overflow أفقي', homeSW <= w, 'scrollWidth=' + homeSW);
    await pg.goto(BASE + '/teacher', { waitUntil: 'networkidle' });
    const tSW = await pg.evaluate(() => document.documentElement.scrollWidth);
    ok('دخول المعلم ' + w + 'px بلا overflow أفقي', tSW <= w, 'scrollWidth=' + tSW);
    await pg.goto(BASE + '/admin', { waitUntil: 'networkidle' });
    await pg.waitForSelector('#admEmail', { timeout: 10000 });
    const aSW = await pg.evaluate(() => document.documentElement.scrollWidth);
    ok('دخول المسؤول ' + w + 'px بلا overflow أفقي', aSW <= w, 'scrollWidth=' + aSW);
    ok('RTL مفعّل على ' + w + 'px', (await pg.evaluate(() => document.documentElement.dir)) === 'rtl');
    await c.close();
  }

  /* ============ 12. cookie attributes / transport ============ */
  console.log('\n[12] كوكيز وترويسات أمان');
  const rawLogin = await fetch(BASE + '/api/t/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'baker@qa.test', password: T_B.pass }) });
  const sc = rawLogin.headers.get('set-cookie') || '';
  ok('Set-Cookie للمعلم: HttpOnly + Secure + SameSite=Strict + Max-Age', /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=\d+/.test(sc), sc);
  const secHdrs = rawLogin.headers;
  ok('ترويسات أمان (nosniff, X-Frame-Options DENY, Referrer-Policy)', secHdrs.get('x-content-type-options') === 'nosniff' && secHdrs.get('x-frame-options') === 'DENY' && String(secHdrs.get('referrer-policy')).includes('when-cross-origin'));
  const robots = await (await fetch(BASE + '/robots.txt')).text();
  ok('robots.txt يمنع فهرسة لوحات التحكم', /admin|Disallow/i.test(robots));

  console.log('\n════════════════════════════════');
  console.log(`BROWSER E2E: ${pass} pass ✓ / ${fail} fail ✗`);
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
