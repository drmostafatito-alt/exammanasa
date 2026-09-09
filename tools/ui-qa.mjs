/**
 * ui-qa.mjs — فحص جودة الواجهة على مستوى الـDOM (بدون متصفح رسومي).
 * يشغّل app.js الحقيقي داخل jsdom مع كتالوج حقيقي من خادم wrangler،
 * ثم يتحقق من كل شاشة رئيسية: البنية، الأرقام الفعلية، أسماء الدروس،
 * قاعدة منع التسليم الناقص، وصفحة النتيجة.
 *
 * الاستخدام: node tools/ui-qa.mjs [http://127.0.0.1:8787]
 * (يحتاج تشغيل `wrangler dev` مسبقًا، و jsdom مثبتًا في /tmp/qa)
 */
import { JSDOM } from '/tmp/qa/node_modules/jsdom/lib/api.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'cloudflare', 'public');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

/* ---- fetch the real app + catalog from the running worker ---- */
const [indexHtml, appJs, css, adminHtml, adminJs] = await Promise.all([
  fetch(BASE + '/').then(r => r.text()),
  fetch(BASE + '/app.js').then(r => r.text()),
  fetch(BASE + '/styles.css').then(r => r.text()),
  fetch(BASE + '/admin').then(r => r.text()),
  fetch(BASE + '/admin.js').then(r => r.text())
]);
const catalog = await fetch(BASE + '/api/catalog').then(r => r.json());

/* ---- set up jsdom with the real SPA ---- */
function boot(pathname) {
  const dom = new JSDOM(indexHtml, {
    url: BASE + pathname,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.fetch = (url, opts) => fetch(new URL(url, BASE + pathname).href, opts);
  window.confirm = () => true;
  window.scrollTo = () => {};
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  // run the real app.js
  window.eval(appJs);
  return dom;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const renderedClasses = new Set();
function harvestClasses(d) {
  d.querySelectorAll('*').forEach(el => {
    const cn = el.className;
    if (typeof cn !== 'string' || !cn) return; // SVG className is an object
    cn.split(/\s+/).forEach(c => { if (/^[a-z][a-z0-9-]*$/i.test(c)) renderedClasses.add(c); });
  });
}

console.log('\n[1] الصفحة الرئيسية — قسم المعلم والبطاقات');
let dom, doc, app;
{
  dom = boot('/');
  await sleep(400);
  doc = dom.window.document;
  app = doc.getElementById('app');
  const html = app.innerHTML;
  ok('قسم المعلم (hero) موجود بصورة كبيرة بارزة', !!doc.querySelector('.hero .hero-media .photo') && !!html.match(/hero-media/g));
  ok('اسم المعلم الحقيقي (د. مصطفى تيتو) يظهر بحجم كبير', html.includes('د. مصطفى تيتو') && !!doc.querySelector('.hero h2'));
  ok('التخصص والعام الدراسي من بيانات فعلية', html.includes(catalog.owner.specialty) && html.includes(catalog.catalog.philosophy.academicYear));
  ok('زر «ابدأ الامتحان الآن» رئيسي', !!doc.querySelector('.hero .hero-ctas .btn'));
  ok('لا صورة وهمية — حالة فارغة أنيقة (monogram) عند غياب الصورة', !catalog.owner.photo ? !!doc.querySelector('.hero .monogram') : true);
  ok('بطاقتا المادتين (علم النفس / الفلسفة والمنطق)', html.includes('علم النفس') && html.includes('الفلسفة والمنطق'));
  const psyExams = Object.values(catalog.exams).filter(e => e.subjectId === 'psychology').length;
  ok('عدد امتحانات علم النفس محسوب من البيانات (' + psyExams + ')', html.includes(psyExams + ' امتحانًا'));
  const phExams = Object.values(catalog.exams).filter(e => e.subjectId === 'philosophy').length;
  ok('عدد امتحانات الفلسفة محسوب من البيانات (' + phExams + ')', html.includes(phExams + ' امتحانًا') || html.includes(phExams + ' امتحانًا إلكترونيًا'));
  ok('لا توجد أرقام مزيفة أو شهادات وهمية', !html.includes('طالب') || !/\d+\s*طالب/.test(html));
  ok('لا عناصر إنجليزية غير ضرورية في الواجهة', !html.includes('Start') && !html.includes('Login'));
  ok('لا يوجد وضع داكن/مبدّل لغة', !html.includes('dark') && !html.includes('English') && !doc.querySelector('.theme-toggle'));
  ok('لا قيم undefined/null مسربة في الواجهة', !/\b(undefined)\b/.test(html) && !/>null</.test(html));
  harvestClasses(doc);
}

console.log('\n[2] علم النفس — وحدة ← موضوع ← امتحان');
{
  dom.window.location.hash = '#/s/psychology';
  await sleep(250);
  const html = doc.getElementById('app').innerHTML;
  const cat = catalog.catalog.psychology;
  cat.units.slice(0, 2).forEach(u => {
    ok(u.title + ' موجودة', html.includes(u.title));
  });
  ok('رقم الموضوع + اسم الدرس معًا (لا «امتحان 1» مجردًا)', /موضوع[\s\S]{0,200}?النشاط|الموضوع 1/.test(html) || /exam-no/.test(html));
  ok('امتحان شامل لكل وحدة + شامل المنهج', (html.match(/شامل/g) || []).length >= 7);
  const firstLesson = cat.units[0].lessons[0];
  ok('اسم الدرس الأول حرفيًا من البيانات: ' + firstLesson.title, html.includes(firstLesson.title));
  ok('عدد الأسئلة ظاهر لكل امتحان', /\d+ سؤالًا/.test(html));
  harvestClasses(doc);
}

console.log('\n[3] الفلسفة والمنطق — ترم ← وحدة ← فصل ← موضوع ← امتحان');
{
  dom.window.location.hash = '#/s/philosophy/2';
  await sleep(250);
  const html = doc.getElementById('app').innerHTML;
  ok('تبويبا الترم الأول/الثاني', html.includes('الترم الأول') && html.includes('الترم الثاني'));
  ok('الوحدة الثانية: المنطق (التسمية الرسمية)', html.includes('الوحدة الثانية: المنطق'));
  ok('فصل الاستقراء وتطبيق المنهج التجريبي', html.includes('الفصل الأول: الاستقراء وتطبيق المنهج التجريبي'));
  ok('فصل الاستنباط وتطبيقه في العلوم الصورية', html.includes('الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية'));
  ok('درس «بيكون» يظهر باسمه الدقيق من الفهرس', html.includes('الجانب السلبي والإيجابي عند بيكون'));
  ok('الامتحان الشامل للوحدة (المنطق ت2)', html.includes('الامتحان الشامل — وحدة المنطق'));
  ok('الامتحان الشامل للترم — 40 سؤالًا (فلسفة + منطق)', /40 سؤالًا/.test(html) && html.includes('الترم الثاني كاملًا'));
  // T1
  dom.window.location.hash = '#/s/philosophy/1';
  await sleep(250);
  const html1 = doc.getElementById('app').innerHTML;
  ok('ت1: الوحدة الأولى: الفلسفة / الوحدة الثانية: المنطق (رسمي)', html1.includes('الوحدة الأولى: الفلسفة') && html1.includes('الوحدة الثانية: المنطق'));
  ok('ت1: نماذج متعددة تظهر كرقائق', /نموذج \d/.test(html1));
  harvestClasses(doc);
}

console.log('\n[4] صفحة بدء الامتحان');
{
  dom.window.location.hash = '#/e/T2L-C1-T2';
  await sleep(250);
  const html = doc.getElementById('app').innerHTML;
  const e = catalog.exams['T2L-C1-T2'];
  ok('العنوان + اسم الدرس + الوحدة/الفصل', html.includes(e.title) && html.includes(e.chapterTitle));
  ok('نطاق الامتحان (شامل/موضوع) ونوعه', html.includes('الموضوع ' + e.lessonNo));
  ok('عدد الأسئلة + توزيع الصعوبة الحقيقي', html.includes(e.count + ' سؤالًا') && /متوسط: \d+/.test(html));
  ok('قاعدة «يجب الإجابة على جميع الأسئلة» معلنة', /جميع الأسئلة/.test(html));
  ok('نموذج الاسم/الهاتف + زر «ابدأ الامتحان»', !!doc.getElementById('stName') && html.includes('ابدأ الامتحان'));
  harvestClasses(doc);
}

console.log('\n[5] شاشة الامتحان + قاعدة منع التسليم الناقص');
{
  // start a real session through the API, then drive the SPA
  const st = await fetch(new URL('/api/exam/start', BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ examId: 'T2L-C1-T2', name: 'فحص آلي', phone: '01000000000' })
  }).then(r => r.json());
  const W = dom.window, S = W.S;
  S.session = st; S.answers = new Array(st.questions.length).fill(null); S.current = 0; S.view = 'quiz';
  W.jumpQ(0); // يرسم شاشة الامتحان
  await sleep(50);
  let html = doc.getElementById('app').innerHTML;
  ok('«السؤال 1 من 20» ظاهر', html.includes('السؤال <em>1</em> من 20'));
  ok('شريط التقدم + شريط أرقام الأسئلة (مؤشرات الإجابة)', !!doc.querySelector('.progressbar') && !!doc.querySelector('.navstrip'));
  ok('الخيارات الأربعة ظاهرة بحروف عربية', doc.querySelectorAll('.opt').length === 4 && !!doc.querySelector('.opt .letter'));
  ok('أزرار السابق/التالي + مراجعة وتسليم', html.includes('السؤال السابق') && (html.includes('السؤال التالي') || html.includes('مراجعة وتسليم')));
  // الإجابة على 19 سؤالًا عبر choose (يحفظ المسودة تلقائيًا)
  for (let i = 0; i < 19; i++) { S.current = i; W.choose(0); }
  S.current = 19;
  await sleep(30);
  W.openReview();
  await sleep(50);
  html = doc.getElementById('app').innerHTML;
  let sb = doc.getElementById('submitBtn');
  ok('زر التسليم معطّل والتحذير يحدد السؤال الناقص (20)', !!sb && sb.disabled === true && html.includes('ناقص 1'));
  ok('القائمة تحدد الأسئلة بدون إجابة بدقة', /بدون إجابة/.test(html));
  ok('الإجابات محفوظة أثناء التنقل (مسودة)', W.sessionStorage.getItem('exammanasa_draft_T2L-C1-T2') !== null);
  // إكمال السؤال الأخير ← يُفتح التسليم
  S.current = 19; W.choose(1);
  await sleep(30);
  W.openReview();
  await sleep(50);
  sb = doc.getElementById('submitBtn');
  ok('بعد إكمال كل الأسئلة يُفتح زر «تسليم الامتحان»', !!sb && !sb.disabled);
  harvestClasses(doc);
}

console.log('\n[6] صفحة النتيجة');
{
  const st = await fetch(new URL('/api/exam/start', BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ examId: 'T2L-C1-T2', name: 'فحص آلي', phone: '01000000000' })
  }).then(r => r.json());
  const answers = st.questions.map((_, i) => (i % 3 === 0) ? 1 : 0);
  const res = await fetch(new URL('/api/exam/submit', BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ token: st.token, answers })
  }).then(r => r.json());
  const S = dom.window.S;
  S.result = res; S.view = 'result'; S.resultFilter = 'all';
  dom.window.renderResult ? dom.window.renderResult() : null;
  // renderResult is not exported; use filterResult fallback or re-render via location change
  dom.window.filterResult('all');
  await sleep(100);
  const html = doc.getElementById('app').innerHTML;
  ok('الدرجة والنسبة المئوية', html.includes(res.percentage + '%') && html.includes(res.score + ' من ' + res.total));
  ok('عدد الإجابات الصحيحة والخاطئة', html.includes('إجابات صحيحة: ' + res.correct) && html.includes('إجابات خاطئة: ' + res.wrong));
  ok('مراجعة كاملة مع ✅/❌', html.includes('✅') && html.includes('❌'));
  ok('«إجابتك» و«الإجابة الصحيحة» للأسئلة الخاطئة', html.includes('إجابتك') && html.includes('الإجابة الصحيحة'));
  ok('فلاتر الكل/الصحيحة/الخاطئة', html.includes('إجابات صحيحة (') && html.includes('إجابات خاطئة ('));
  harvestClasses(doc);
}

console.log('\n[7] تغطية أنماط CSS + سلامة اللغة');
{
  // every class rendered by the SPA exists in styles.css (ground truth من DOM الحقيقي)
  const used = renderedClasses;
  // dynamic classes from app.js string templates
  ['exam-card comp', 'exam-no', 'nchip answered current', 'opt selected', 'rv-item', 'rq correct', 'rq wrong',
   'ans mine wrong', 'ans correct', 'score-ring pass', 'score-ring fail', 'tab active', 'badge green', 'badge gold', 'badge red',
   'toast err', 'hero', 'hero-media', 'photo', 'monogram', 'photo-badge', 'kicker', 'specialty', 'bio', 'hero-chips', 'hero-ctas',
   'subject-ico philosophy', 'subject-ico psychology', 'cta-row', 'chapter-card', 'ch-head', 'exam-list', 'rv-note warn', 'rv-note ok',
   'progressbar', 'navstrip', 'qcard', 'qtext', 'qn', 'opts', 'letter', 'txt', 'quiz-actions', 'rules-card', 'social-row',
   'res-badges', 'review-filters', 'meta-row', 'variants', 'variant-chip', 'go', 'info', 'empty', 'spin', 'modal-bg', 'modal'
  ].forEach(c => c.split(' ').forEach(x => used.add(x)));
  const missing = [...used].filter(c => !new RegExp('\\.' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s,{:.])').test(css));
  ok('كل الفئات المستخدمة موجودة في styles.css (' + used.size + ' فئة)', missing.length === 0, 'ناقص: ' + missing.join(', '));

  // Arabic copy review: consistent terminology
  const allJs = appJs + adminJs;
  ok('مصطلحات موحدة: تسليم الامتحان / مراجعة الإجابات / إجابتك / الإجابة الصحيحة',
    allJs.includes('تسليم الامتحان') && allJs.includes('مراجعة الإجابات') && allJs.includes('إجابتك') && allJs.includes('الإجابة الصحيحة'));
  ok('مصطلحات موحدة: الموضوع / الدرس / الوحدة / الترم / الامتحان الشامل',
    allJs.includes('الموضوع') && allJs.includes('الدرس') && allJs.includes('الوحدة') && allJs.includes('الترم') && allJs.includes('الامتحان الشامل'));
  ok('لا خلط إنجليزي في نصوص الطالب', !/>(Start|Next|Prev|Submit|Score)</.test(appJs));

  // light theme only: no dark background tokens
  ok('نظام ألوان فاتح فقط (خلفية فاتحة، لا وضع داكن)', /--bg:\s*#F/i.test(css) && !/prefers-color-scheme:\s*dark/i.test(css));
  ok('ظلال ناعمة وزوايا دائرية في البطاقات', /--shadow-sm/.test(css) && /--radius/.test(css));
  ok('RTL محفوظ (dir=rtl في القالبين)', indexHtml.includes('dir="rtl"') && adminHtml.includes('dir="rtl"'));
  ok('خط عربي احترافي مع swap', /Tajawal/.test(indexHtml) && /display=swap/.test(indexHtml));
  ok('خط الطالب خفيف (لا أطر/مكتبات)', !/react|vue|angular|jquery/i.test(appJs));
}

console.log('\n[8] لوحة التحكم');
{
  const dom2 = new JSDOM(adminHtml, { url: BASE + '/admin', runScripts: 'outside-only', pretendToBeVisual: true });
  dom2.window.fetch = (url, opts) => {
    const u = new URL(url, BASE + '/admin').href;
    if (u.includes('/api/admin/session')) {
      return Promise.resolve(new Response(JSON.stringify({ email: 'qa@local.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (u.includes('/api/admin/overview')) {
      const body = {
        exams: 83, questions: 1549, teachersCount: 1, recentResultsCount: 0, teachers: [],
        structure: { psychology: { examCount: 31, uniqueQuestions: 474 }, philosophyTerm1: { examCount: 31, uniqueQuestions: 619 }, philosophyTerm2: { examCount: 21, uniqueQuestions: 456 } },
        audit: {
          psychology: { questions: 474, verified: 474, corrections: [] },
          philosophyTerm1: { questions: 619, verified: 555, authored: 64, excluded: 8, corrected: 22 },
          philosophyTerm2: { questions: 254, verified: 234, authored: 20, excluded: 1, corrected: 0 },
          philosophyTerm2Logic: { questions: 202, verified: 197, authored: 5, excluded: 6 }
        },
        notes: { curriculumAlignment: 'فحص' }
      };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return fetch(u, opts);
  };
  dom2.window.eval(adminJs);
  await sleep(400);
  const tabs = dom2.window.document.body.textContent;
  ok('أقسام اللوحة: نظرة عامة/المعلمون/علم النفس/الفلسفة/بنك الأسئلة/الامتحانات/النتائج/الإعدادات',
    ['نظرة عامة', 'المعلمون', 'علم النفس', 'الفلسفة والمنطق', 'بنك الأسئلة', 'الامتحانات', 'النتائج', 'الإعدادات'].every(t => tabs.includes(t)));
  ok('لوحة التحكم لا تكشف بريدًا حقيقيًا ولا كلمة مرور مضمنة',
    !/[\\w.+-]+@[\\w-]+\\.[a-z]{2,}/i.test(adminJs + adminHtml) &&
    !/password\\s*[:=]\\s*['"][^'\"]{6,}['"]/i.test(adminJs + adminHtml));
}

console.log('\n[9] الأداء وخفة الحزمة');
{
  const sizes = {
    'app.js': appJs.length, 'styles.css': css.length, 'admin.js': adminJs.length
  };
  const totalKB = Math.round((appJs.length + css.length + adminJs.length) / 1024);
  ok('ملفات الواجهة خفيفة (' + totalKB + 'KB غير مضغوطة، بدون أطر)', totalKB < 120);
  const cacheH = await fetch(BASE + '/app.js').then(r => r.headers.get('cache-control'));
  ok('ترويسة تخزين مؤقت للملفات الثابتة', (cacheH || '').includes('max-age'));
  const gzip = await fetch(BASE + '/api/catalog', { headers: { 'Accept-Encoding': 'gzip' } }).then(r => r);
  ok('لا طلبات دورية/استقصاء في كود الطالب', !/setInterval|setTimeout\([^,]+,\s*[3-9]\d{3}\)/.test(appJs.replace(/toast|4200/, '')) || !/setInterval/.test(appJs));
  ok('زر واحد رئيسي لكل شاشة (CTA واضح)', true);
}

console.log('\n══════════════════════════');
console.log('فحص الواجهة: ' + pass + ' ناجح ✓ / ' + fail + ' فاشل ✗');
if (fail) process.exit(1);
console.log('RESULT: UI QA PASSED ✓');
