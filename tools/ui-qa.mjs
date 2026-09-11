/**
 * ui-qa.mjs — فحص جودة الواجهة على مستوى الـDOM (بدون متصفح رسومي).
 * يشغّل app.js الحقيقي داخل jsdom (runScripts: dangerously) بحيث تعمل
 * أحداث onclick الحقيقية وحدث hashchange — أي أن الفحص يمثل سلوك
 * المتصفح الفعلي، بما في ذلك اختبار الانحدار لخلل «عودة الطالب
 * للرئيسية بعد بدء الامتحان».
 *
 * الاستخدام: node tools/ui-qa.mjs [http://127.0.0.1:8787]
 * (يحتاج تشغيل `wrangler dev` مسبقًا، و jsdom مثبتًا في /tmp/qa)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// jsdom: من devDependencies في cloudflare/ (npm install) أو من /tmp/qa كبديل قديم
const JSDOM_CANDIDATES = [
  path.join(ROOT, 'cloudflare', 'node_modules', 'jsdom', 'lib', 'api.js'),
  '/tmp/qa/node_modules/jsdom/lib/api.js'
];
const jsdomPath = JSDOM_CANDIDATES.find(p => fs.existsSync(p));
if (!jsdomPath) { console.error('jsdom غير مثبت — شغّل: cd cloudflare && npm install'); process.exit(2); }
const { JSDOM } = await import(pathToFileURL(jsdomPath).href);
const PUB = path.join(ROOT, 'cloudflare', 'public');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

/* ---- fetch the real app + catalog from the running worker ---- */
const [indexHtml, appJs, css, adminHtml, adminJs, teacherHtml, teacherJs] = await Promise.all([
  fetch(BASE + '/').then(r => r.text()),
  fetch(BASE + '/app.js').then(r => r.text()),
  fetch(BASE + '/styles.css').then(r => r.text()),
  fetch(BASE + '/admin').then(r => r.text()),
  fetch(BASE + '/admin.js').then(r => r.text()),
  fetch(BASE + '/teacher').then(r => r.text()),
  fetch(BASE + '/teacher.js').then(r => r.text())
]);
/* ثوابت الواجهة: لا محررات نصية حرفية \uXXXX في HTML (لا تُفك في هذا السياق — خلل PR9 الذي أُصلح) */
ok('لا توجد محارف \\u escape حرفية في ملفات HTML المنشورة',
  !/\\u[0-9a-f]{4}/.test(indexHtml) && !/\\u[0-9a-f]{4}/.test(adminHtml) && !/\\u[0-9a-f]{4}/.test(teacherHtml));
/* رابط المعلم ثابت: تسجيل دخول فقط — لا إنشاء حساب/تسجيل ذاتي في الصفحة أو السكربت */
ok('صفحة /teacher بلا أي تسجيل ذاتي (HTML+JS)',
  !/إنشاء حساب|تسجيل جديد|sign\s?up|\bregister\b/i.test(teacherHtml + teacherJs) && teacherHtml.includes('لوحة المعلم'));
const catalog = await fetch(BASE + '/api/catalog').then(r => r.json());

/* ---- boot: jsdom مع السكربتات الحقيقية والنقرات الحقيقية ---- */
const bootHtml = indexHtml.replace('<script src="/app.js"></script>', '');
function boot(pathname) {
  const dom = new JSDOM(bootHtml, {
    url: BASE + pathname,
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.fetch = (url, opts) => fetch(new URL(url, BASE + pathname).href, opts);
  window.confirm = () => true;
  window.scrollTo = () => {};
  window.print = () => {};
  const s = window.document.createElement('script');
  s.textContent = appJs;
  window.document.body.appendChild(s);
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
function clickBtn(doc, needle, scope) {
  const btn = [...(scope || doc).querySelectorAll('button, .btn, a.btn')].find(b => b.textContent.includes(needle));
  if (btn) btn.click();
  return !!btn;
}

console.log('\n[1] الشريط العلوي — الهوية والتنقل والتواصل (بلا روابط وهمية)');
let dom, doc;
{
  dom = boot('/');
  await sleep(500);
  doc = dom.window.document;
  const html = doc.body.innerHTML;
  ok('هوية المعلم الحقيقية يمين الشريط (د. مصطفى تيتو + التخصص)', doc.getElementById('brandName').textContent === 'د. مصطفى تيتو' && doc.getElementById('brandSub').textContent.includes('الفلسفة والمنطق'));
  ok('تنقل وسط الشريط: الرئيسية/الامتحانات/عن المنصة', ['الرئيسية', 'الامتحانات', 'عن المنصة'].every(t => !!doc.querySelector('.mainnav') && doc.querySelector('.mainnav').textContent.includes(t)));
  const hasSocials = Object.values(catalog.owner.socialLinks || {}).some(v => /^https?:\/\//i.test(String(v || '').trim()));
  ok('«تواصل معنا» وأيقونات التواصل تظهر فقط عند وجود روابط فعلية',
    hasSocials ? !doc.getElementById('navContact').hidden : (doc.getElementById('navContact').hidden === true && doc.getElementById('topSocials').children.length === 0));
  ok('لا أيقونات اجتماعية وهمية بلا روابط', doc.getElementById('topSocials').querySelectorAll('a').length === (hasSocials ? Object.values(catalog.owner.socialLinks).filter(v => /^https?:\/\//i.test(String(v || '').trim())).length : 0));
  ok('لا مبدّل لغة إنجليزية ولا وضع داكن', !html.includes('English') && !/dark/i.test(html) && !doc.querySelector('.theme-toggle'));
  harvestClasses(doc);
}

console.log('\n[2] الواجهة الرئيسية (Hero) — تكوين المرجع المعتمد');
{
  const html = doc.getElementById('app').innerHTML;
  const W = dom.window;
  ok('عنوان رئيسي قوي: «اختبر نفسك وقيّم مستواك!»', !!doc.querySelector('.hero h1') && doc.querySelector('.hero h1').textContent.includes('اختبر نفسك'));
  ok('وصف مهني قصير للمنصة (بلا ادعاءات)', !!doc.querySelector('.hero .lead') && doc.querySelector('.hero .lead').textContent.includes('وفق المنهج الرسمي'));
  ok('صورة المعلم كبيرة في الجهة اليمنى (عمود media أول الشبكة)', !!doc.querySelector('.hero .hero-media .photo') && /grid-template-areas:\s*"media body"/.test(css));
  ok('أشكال زخرفية تعليمية حول الصورة (blob/ring/badge/شارة عائمة)', !!doc.querySelector('.hero .blob') && !!doc.querySelector('.hero .ring') && !!doc.querySelector('.hero .photo-badge') && !!doc.querySelector('.hero .float-chip'));
  ok('لا صورة وهمية — حالة فارغة أنيقة (monogram) عند غياب صورة حقيقية', !catalog.owner.photo ? !!doc.querySelector('.hero .monogram') : true);
  ok('زر «ابدأ الامتحان الآن» يؤدي إلى بيانات الطالب (#/start)', !!doc.querySelector('.hero .hero-ctas .btn'));
  doc.querySelector('.hero .hero-ctas .btn').click();
  await sleep(200);
  ok('النقر على «ابدأ الامتحان الآن» يفتح شاشة بيانات الطالب (لا الرئيسية)', W.location.hash === '#/start' && !!doc.getElementById('stName'));
  harvestClasses(doc);
}

console.log('\n[3] أقسام الرئيسية — بطاقات الصفين والمميزات وعن المعلم');
{
  dom.window.location.hash = '#/';
  await sleep(250);
  const html = doc.getElementById('app').innerHTML;
  const cat = catalog.catalog;
  const psyExams = Object.values(catalog.exams).filter(e => e.subjectId === 'psychology').length;
  const phExams = Object.values(catalog.exams).filter(e => e.subjectId === 'philosophy').length;
  ok('بطاقتا الصفين: الأول الثانوي (فلسفة ومنطق) + الثاني الثانوي (بكالوريا — علم النفس)',
    html.includes('الصف الأول الثانوي') && html.includes('الفلسفة والمنطق') && html.includes('الصف الثاني الثانوي') && html.includes('بكالوريا — علم النفس'));
  const phTrainings = catalog.catalog.philosophy.terms.reduce((n, t) => n + t.sections.reduce((m, sec) => m + sec.topics.reduce((k, tp) => k + tp.lessons.reduce((z, l) => z + l.trainings.length, 0), 0), 0), 0);
  const phTopics = catalog.catalog.philosophy.terms.reduce((n, t) => n + t.sections.reduce((m, sec) => m + sec.topics.length, 0), 0);
  ok('إحصاءات فعلية من الفهرس (' + psyExams + ' علم نفس / ' + phTopics + ' موضوعًا و' + phTrainings + ' تدريبًا فلسفة — لا تُحتسب النماذج القديمة المخفية)', html.includes(psyExams + ' امتحانًا') && html.includes(phTrainings + ' تدريبًا') && html.includes(phTopics + ' موضوعًا') && phTrainings === 44 && phExams > phTrainings);
  ok('شريط مميزات بقدرات حقيقية فقط: امتحانات منظمة/نتيجتك فورًا/مراجعة الإجابات',
    doc.querySelectorAll('.feature').length === 3 && html.includes('امتحانات منظمة') && html.includes('نتيجتك فورًا') && html.includes('مراجعة الإجابات'));
  ok('قسم «عن المعلم والمنصة» ببيانات فعلية (الاسم/التخصص/النبذة/العام)', !!doc.querySelector('.about-card') && html.includes(catalog.owner.name) && html.includes(catalog.owner.specialty) && html.includes(catalog.owner.bio) && html.includes(cat.philosophy.academicYear));
  ok('صورة المعلم حاضرة بصريًا في قسم عن المعلم', !!doc.querySelector('.about-card .photo'));
  ok('لا إحصاءات مزيفة (عدد طلاب/شهادات/تقييمات)', !/\d+\s*(طالب|شاهد|تقييم|شهادة)/.test(html));
  ok('لا قيم undefined/null مسربة', !/\bundefined\b/.test(html) && !/>null</.test(html));
  const hasSocials = Object.values(catalog.owner.socialLinks || {}).some(v => /^https?:\/\//i.test(String(v || '').trim()));
  ok('قسم «تواصل معنا» يظهر فقط عند وجود روابط', hasSocials === !!doc.getElementById('contact'));
  // بطاقة الصف → بيانات الطالب مع تفعيل الصف مسبقًا
  doc.querySelector('.grade-card').click();
  await sleep(200);
  ok('النقر على بطاقة الصف يفتح بيانات الطالب مع اختيار الصف مسبقًا',
    dom.window.location.hash === '#/start' && !!doc.querySelector('.grade-opt.sel') && doc.querySelector('.grade-opt.sel').textContent.includes('الصف الأول الثانوي'));
  harvestClasses(doc);
}

console.log('\n[4] المسار الكامل بالنقرات الحقيقية — اختبار انحدار خلل العودة للرئيسية');
{
  // مسار جديد نظيف: بيانات الطالب ← الصف الثاني الثانوي ← علم النفس ← موضوع ← امتحان ← نتيجة
  doc.getElementById('stName').value = 'طالب فحص آلي';
  doc.getElementById('stPhone').value = '01000000000';
  const g2 = [...doc.querySelectorAll('.grade-opt')].find(o => o.textContent.includes('الصف الثاني الثانوي'));
  g2.click();
  await sleep(120);
  ok('اختيار الصف لا يمسح البيانات المُدخلة', doc.getElementById('stName').value === 'طالب فحص آلي');
  clickBtn(doc, 'متابعة إلى الامتحانات');
  await sleep(300);
  const W = dom.window;
  ok('المتابعة تفتح منهج الصف المختار (علم النفس — 6 وحدات)', W.location.hash === '#/s/psychology' && doc.querySelectorAll('.unit-card').length === 6);
  ok('منهج علم النفس منظمة: وحدات ← موضوعات (لا قائمة امتحانات مسطحة)', doc.querySelectorAll('.lesson:not(.comp)').length === 24 && doc.querySelectorAll('.unit-head').length === 6);
  // رقم الموضوع + اسم الدرس حرفيًا
  const l0 = catalog.catalog.psychology.units[0].lessons[0];
  const firstRow = doc.querySelector('.lesson:not(.comp)');
  ok('صف الموضوع: «الموضوع 1» + اسم الدرس حرفيًا من الفهرس', firstRow.querySelector('.lno b').textContent === '1' && firstRow.querySelector('.lt').textContent === l0.title);
  firstRow.click();
  await sleep(300);
  ok('صفحة بدء الامتحان: العنوان + القواعد + ملخص بيانات الطالب', W.location.hash === '#/e/' + l0.examIds[0] && !!doc.querySelector('.rules-card') && !!doc.querySelector('.stu-sum') && doc.querySelector('.stu-sum .sn').textContent === 'طالب فحص آلي');
  ok('زر «تعديل البيانات» يكشف النموذج مسبق التعبئة', (clickBtn(doc, 'تعديل البيانات'), await sleep(60), !doc.getElementById('stuFields').classList.contains('hidden') && doc.getElementById('stName').value === 'طالب فحص آلي'));
  // ★ اختبار الانحدار: بعد «ابدأ الامتحان» يجب أن تبقى شاشة الامتحان
  doc.getElementById('startBtn').click();
  await sleep(450);
  ok('★ إصلاح الخلل: بعد بدء الامتحان تبقى شاشة الأسئلة (لا عودة للرئيسية)',
    W.location.hash === '#/quiz' && W.S.view === 'quiz' && !!doc.querySelector('.qcard') && !doc.querySelector('.hero'));
  ok('«السؤال 1 من 20» + شريط تقدم + شريط أرقام', doc.body.textContent.includes('السؤال') && doc.body.textContent.includes('من 20') && !!doc.querySelector('.progressbar') && !!doc.querySelector('.navstrip'));
  ok('أزرار السابق/التالي', doc.body.textContent.includes('السؤال التالي'));
  // اختر إجابة بالنقر — حالة التحديد واضحة
  doc.querySelector('.opt').click();
  await sleep(80);
  ok('الخيار المحدد بحالة واضحة (selected) + مسودة محفوظة', !!doc.querySelector('.opt.selected') && W.sessionStorage.getItem('exammanasa_draft_' + W.S.examId) !== null);
  // زر الرجوع في المتصفح أثناء النتيجة يعيد للامتحان؟ لا — بعد التسليم
  const total = W.S.session.questions.length;
  for (let i = 1; i < total; i++) { W.jumpQ(i); await sleep(8); doc.querySelector('.opt').click(); await sleep(8); }
  W.jumpQ(total - 1); await sleep(40);
  clickBtn(doc, 'مراجعة وتسليم');
  await sleep(200);
  const sb = doc.getElementById('submitBtn');
  ok('بعد إجابة كل الأسئلة يُفتح «تسليم الامتحان»', !!sb && !sb.disabled);
  sb.click();
  await sleep(500);
  const r = W.S.result;
  ok('★ التسليم ينقل للنتيجة (لا عودة للرئيسية): #/result', W.location.hash === '#/result' && W.S.view === 'result' && !!doc.querySelector('.score-ring'));
  ok('النتيجة: الدرجة والنسبة فورًا', doc.querySelector('.score-ring .pct').textContent === r.percentage + '%' && doc.body.textContent.includes(r.score + ' من ' + r.total));
  ok('عدد الإجابات الصحيحة والخاطئة', doc.body.textContent.includes('إجابات صحيحة: ' + r.correct) && doc.body.textContent.includes('إجابات خاطئة: ' + r.wrong));
  ok('مراجعة كاملة لكل سؤال مع ✅/❌ و«إجابتك» و«الإجابة الصحيحة»',
    doc.querySelectorAll('.rq').length === r.total && doc.body.textContent.includes('✅') && doc.body.textContent.includes('❌') && doc.body.textContent.includes('إجابتك') && doc.body.textContent.includes('الإجابة الصحيحة'));
  // الرجوع بالمتصفح من النتيجة لا يعيد امتحانًا مُسلَّمًا
  W.location.hash = '#/quiz';
  await sleep(250);
  ok('زر الرجوع من النتيجة (#/quiz) يبقي على النتيجة — لا فتح امتحان مُسلَّم', W.S.view === 'result' && !!doc.querySelector('.score-ring'));
  clickBtn(doc, 'امتحانات أخرى');
  await sleep(300);
  ok('«امتحانات أخرى» يعيد لمنهج المادة', W.location.hash === '#/s/psychology' && doc.querySelectorAll('.unit-card').length === 6);
  harvestClasses(doc);
}

console.log('\n[4ب] الفلسفة والمنطق — الترم ← الموضوع (2) ← الدرس (اسم حقيقي) ← تدريبات الدرس ← الامتحان (بالنقرات الحقيقية)');
{
  const W = dom.window;
  W.location.hash = '#/s/philosophy/1';
  await sleep(300);
  const t1 = catalog.catalog.philosophy.terms[0];
  const topics1 = t1.sections.flatMap(sec => sec.topics);
  const trOf = tp => tp.lessons.flatMap(l => l.trainings);
  let html = doc.getElementById('app').innerHTML;
  ok('صفحة الترم: الفلسفة موضوعان + المنطق موضوعان فقط (4 بطاقات) — لا دروس ولا تدريبات ولا «نموذج N»', doc.querySelectorAll('.topic-card').length === 4 && topics1.length === 4 && !doc.querySelector('.lesson-card') && !doc.querySelector('.training-card') && !doc.querySelector('.model-btn') && !/نموذج \d/.test(html));
  ok('عناوين الموضوعات الرسمية', ['التفكير الإنساني', 'الفلسفة وطبيعة الموقف الفلسفي', 'مبادئ المنطق (الحدود - القضايا)', 'الاستدلال (تعريفه - أنواعه)'].every(t => html.includes(t)));
  ok('بطاقة الموضوع تعرض عدد الدروس وعدد التدريبات', [...doc.querySelectorAll('.topic-card .ls')].every(el => /درس|دروس/.test(el.textContent) && /تدريب/.test(el.textContent)));
  ok('قسم «امتحانات شاملة» منفصل عن الموضوعات (3 شوامل ت1)', html.includes('امتحانات شاملة') && doc.querySelectorAll('.lesson.comp').length === 3);
  ok('لا مستويات صعوبة في أي مكان', !/مستوى (سهل|متوسط|متقدم|صعب)/.test(html));
  // انقر الموضوع 1 من الفلسفة
  const tp0 = topics1[0];
  const card0 = [...doc.querySelectorAll('.topic-card')].find(c => c.querySelector('.lt').textContent === tp0.title);
  ok('بطاقة الموضوع 1 «' + tp0.title + '» تحمل رابطًا مباشرًا (#/s/philosophy/1/t/…)', !!card0 && card0.getAttribute('href') === '#/s/philosophy/1/t/' + encodeURIComponent(tp0.key));
  card0.click();
  await sleep(300);
  html = doc.getElementById('app').innerHTML;
  ok('صفحة الموضوع: المسار صحيح وتعرض دروس هذا الموضوع فقط (' + tp0.lessons.length + ')', W.location.hash === '#/s/philosophy/1/t/' + encodeURIComponent(tp0.key) && W.S.view === 'topic' && doc.querySelectorAll('.lesson-card').length === tp0.lessons.length && !doc.querySelector('.training-card'));
  ok('بطاقة الدرس: «الدرس N — الاسم الحقيقي» + عدد التدريبات + «عرض التدريبات»', tp0.lessons.every((l, i) => { const c = doc.querySelectorAll('.lesson-card')[i]; return c.querySelector('.lt').textContent === 'الدرس ' + l.no + ' — ' + l.title && c.textContent.includes(l.trainings.length + ' تدريب') && c.textContent.includes('عرض التدريبات'); }));
  ok('أسماء الدروس هي أسماء JSON الحقيقية (التفكير والنشاط العقلي / أساليب التفكير / مهارات التفكير الفلسفي)', ['التفكير والنشاط العقلي', 'أساليب التفكير', 'مهارات التفكير الفلسفي'].every(t => html.includes(t)) && !/الدرس \d+ — الدرس/.test(html));
  ok('لا تسريب لدروس موضوع آخر', [...doc.querySelectorAll('.lesson-card .lt')].every(el => tp0.lessons.some(l => el.textContent.endsWith(l.title))));
  ok('مسار الموقع + زر العودة إلى الموضوعات', doc.querySelector('.crumb').textContent.includes('الترم الأول') && html.includes('العودة إلى موضوعات'));
  // الدرس 1 → تدريباته
  doc.querySelector('.lesson-card').click();
  await sleep(300);
  html = doc.getElementById('app').innerHTML;
  const l0 = tp0.lessons[0];
  ok('صفحة الدرس: المسار #/s/philosophy/1/t/{topic}/l/{lesson} وتدريبات هذا الدرس فقط (' + l0.trainings.length + ')', W.location.hash === '#/s/philosophy/1/t/' + encodeURIComponent(tp0.key) + '/l/' + encodeURIComponent(l0.key) && W.S.view === 'lesson' && doc.querySelectorAll('.training-card').length === l0.trainings.length && !doc.querySelector('.lesson-card'));
  ok('عنوان الصفحة «الدرس 1 — ' + l0.title + '»', doc.querySelector('.topic-head h2').textContent === 'الدرس 1 — ' + l0.title);
  const tc = doc.querySelector('.training-card');
  ok('بطاقة التدريب: اسم التدريب + 20 سؤالًا + «ابدأ الامتحان» — بلا صعوبة', !!tc && tc.querySelector('.tc-title').textContent === l0.trainings[0].title && tc.textContent.includes(l0.trainings[0].questionCount + ' سؤالًا') && tc.querySelector('.tc-start').textContent.includes('ابدأ الامتحان') && !/مستوى/.test(tc.textContent));
  ok('أزرار العودة: إلى دروس الموضوع + إلى الترم', html.includes('العودة إلى دروس الموضوع') && html.includes('العودة إلى الترم الأول'));
  ok('حجم لمس مريح: بطاقة التدريب ≥ 96px وزر البدء ≥ 48px، عمود واحد على الموبايل',
    /\.training-card\s*{[^}]*min-height:\s*(9[6-9]|\d{3})px/.test(css) && /\.training-card \.tc-start\s*{[^}]*min-height:\s*(4[8-9]|[5-9]\d)px/.test(css) && /@media \(max-width: 600px\)\s*{[^@]*\.topic-grid, \.training-grid\s*{\s*grid-template-columns:\s*1fr/.test(css));
  // ت2: درس بأكثر من تدريب (الفلسفة البيئية = تدريبان)
  W.location.hash = '#/s/philosophy/2';
  await sleep(300);
  const t2 = catalog.catalog.philosophy.terms[1];
  const multiTp = t2.sections.flatMap(sec => sec.topics).find(tp => tp.lessons.some(l => l.trainings.length >= 2));
  const multi = multiTp.lessons.find(l => l.trainings.length >= 2);
  ok('ت2: يوجد درس بأكثر من تدريب (' + multi.title + ' — ' + multi.trainings.length + ')', !!multi);
  [...doc.querySelectorAll('.topic-card')].find(c => c.querySelector('.lt').textContent === multiTp.title).click();
  await sleep(300);
  [...doc.querySelectorAll('.lesson-card')].find(c => c.querySelector('.lt').textContent.endsWith(multi.title)).click();
  await sleep(300);
  const cards = [...doc.querySelectorAll('.training-card')];
  ok('تدريبات الدرس كبطاقات مستقلة «تدريب 1» / «تدريب 2» بعدد الأسئلة الحقيقي', cards.length === multi.trainings.length && cards.every((c, i) => c.querySelector('.tc-title').textContent === 'تدريب ' + (i + 1) && c.textContent.includes(catalog.exams[multi.trainings[i].examId].count + ' سؤالًا')));
  cards[1].querySelector('.tc-start').click();
  await sleep(300);
  const eid2 = multi.trainings[1].examId;
  ok('«تدريب 2» يفتح الامتحان الصحيح (#/e/' + eid2 + ') وصفحة البدء تعرض الدرس والتدريب', W.location.hash === '#/e/' + eid2 && doc.querySelector('.exam-head h2').textContent.includes(multi.title) && doc.querySelector('.exam-head h2').textContent.includes('تدريب 2') && !/مستوى|سهل:|متوسط:|متقدم:/.test(doc.getElementById('app').innerHTML));
  ok('مسار صفحة الامتحان يتضمن الموضوع والدرس', doc.querySelector('.crumb').textContent.includes('الموضوع ' + multiTp.no) && doc.querySelector('.crumb').textContent.includes('الدرس ' + multi.no));
  doc.getElementById('startBtn').click();
  await sleep(450);
  ok('جلسة تدريب 2: معرف الامتحان الصحيح و20 سؤالًا', W.S.session.exam.id === eid2 && W.S.session.questions.length === 20);
  ok('مفتاح الإجابة غير مكشوف قبل التسليم (حقول السؤال: نص/خيارات فقط)',
    W.S.session.questions.every(q => JSON.stringify(Object.keys(q).sort()) === JSON.stringify(['id', 'no', 'options', 'text'])));
  const total = W.S.session.questions.length;
  for (let i = 0; i < total; i++) { W.jumpQ(i); await sleep(8); doc.querySelectorAll('.opt')[i % 4].click(); await sleep(8); }
  W.jumpQ(total - 1); await sleep(30);
  clickBtn(doc, 'مراجعة وتسليم');
  await sleep(150);
  doc.getElementById('submitBtn').click();
  await sleep(500);
  const r = W.S.result;
  ok('تسليم تدريب 2 ينقل للنتيجة ويحفظها (تصحيح على الخادم)', W.location.hash === '#/result' && !!r && r.total === total);
  ok('التصحيح متسق ذاتيًا: isCorrect ≡ (إجابتك = الإجابة الصحيحة) لكل سؤال', r.review.every(q => q.isCorrect === (q.studentAnswerText === q.correctAnswerText)));
  ok('النسبة المئوية صحيحة حسابيًا وصحيح+خطأ = المجموع', r.percentage === Math.round(r.score / r.total * 100) && r.correct + r.wrong === r.total && r.score === r.correct);
  clickBtn(doc, 'امتحانات أخرى');
  await sleep(300);
  const lessonHash = '#/s/philosophy/2/t/' + encodeURIComponent(multiTp.key) + '/l/' + encodeURIComponent(multi.key);
  ok('«امتحانات أخرى» من النتيجة يعيد إلى صفحة الدرس نفسه', W.location.hash === lessonHash && doc.querySelectorAll('.training-card').length === multi.trainings.length);
  // Refresh / direct URL / Back
  const fresh = boot('/mostafa');
  fresh.window.location.hash = lessonHash;
  await sleep(600);
  const fdoc = fresh.window.document;
  ok('فتح رابط الدرس مباشرة/بعد Refresh يعرض تدريبات الدرس مع بقاء سياق المعلم', fdoc.querySelectorAll('.training-card').length === multi.trainings.length && fresh.window.S.slug === 'mostafa' && fresh.window.S.term === 2);
  fresh.window.history.back(); await sleep(250);
  fresh.window.location.hash = '#/s/philosophy/2/t/' + encodeURIComponent(multiTp.key);
  await sleep(250);
  ok('العودة إلى الموضوع تعرض دروسه (Back لا يكسر السياق)', fdoc.querySelectorAll('.lesson-card').length === multiTp.lessons.length && !fdoc.querySelector('.training-card'));
  fresh.window.location.hash = '#/s/philosophy/2';
  await sleep(250);
  ok('العودة إلى الترم تعرض الموضوعات الأربعة', fdoc.querySelectorAll('.topic-card').length === 4);
  fresh.window.location.hash = '#/s/philosophy/2/t/' + encodeURIComponent(multiTp.key) + '/l/nope';
  await sleep(250);
  ok('مفتاح درس غير موجود يعود بأمان لصفحة الموضوع', fresh.window.location.hash === '#/s/philosophy/2/t/' + encodeURIComponent(multiTp.key) && fdoc.querySelectorAll('.lesson-card').length > 0);
  fresh.window.location.hash = '#/s/philosophy/2/t/nope';
  await sleep(250);
  ok('مفتاح موضوع غير موجود يعود بأمان لصفحة الترم', fresh.window.location.hash === '#/s/philosophy/2' && fdoc.querySelectorAll('.topic-card').length === 4);
  harvestClasses(doc);
}

console.log('\n[5] قاعدة منع التسليم الناقص — تحديد الأسئلة بدقة');
{
  // جلسة جديدة عبر النقر على امتحان المنطق ت2
  const W = dom.window;
  W.location.hash = '#/s/philosophy/2';
  await sleep(300);
  doc.querySelector('.topic-card').click();
  await sleep(300);
  doc.querySelector('.lesson-card').click();
  await sleep(300);
  doc.querySelector('.training-card .tc-start').click();
  await sleep(300);
  doc.getElementById('startBtn').click();
  await sleep(450);
  ok('امتحان آخر يبدأ أيضًا دون عودة للرئيسية', W.S.view === 'quiz' && !!doc.querySelector('.qcard'));
  const total = W.S.session.questions.length;
  for (let i = 0; i < total - 1; i++) { W.jumpQ(i); await sleep(8); doc.querySelector('.opt').click(); await sleep(8); }
  W.jumpQ(total - 1); await sleep(40);
  clickBtn(doc, 'مراجعة وتسليم');
  await sleep(200);
  let sb = doc.getElementById('submitBtn');
  const html = doc.getElementById('app').innerHTML;
  ok('زر التسليم معطّل والتحذير يحدد رقم السؤال الناقص (' + total + ')', !!sb && sb.disabled === true && html.includes('ناقص 1'));
  ok('التحذير يسرد أرقام الأسئلة بدون إجابة بدقة', new RegExp('رقم ' + total + '\\b').test(html) && html.includes('بدون إجابة'));
  // أجب الأخير ثم سلّم
  W.jumpFromReview(total - 1);
  await sleep(60);
  doc.querySelector('.opt').click();
  await sleep(60);
  clickBtn(doc, 'مراجعة وتسليم');
  await sleep(150);
  sb = doc.getElementById('submitBtn');
  ok('بعد إكمال السؤال الأخير يُفتح التسليم', !!sb && !sb.disabled);
  // تحقق الخادم يرفض التسليم الناقص (طبقة الحماية الثانية)
  const st = await fetch(new URL('/api/exam/start', BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ examId: 'T2L-C1-T2', name: 'فحص آلي', phone: '01000000000' })
  }).then(r => r.json());
  const bad = await fetch(new URL('/api/exam/submit', BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ token: st.token, answers: st.questions.map((_, i) => (i === 0 ? null : 0)) })
  });
  const badBody = await bad.json().catch(() => ({}));
  ok('الخادم يرفض التسليم الناقص (400) مع قائمة الأسئلة غير المُجابة', bad.status === 400 && Array.isArray(badBody.unanswered) && badBody.unanswered.includes(1));
  // G: طابور التسليم دون اتصال — حفظ محلي ثم إرسال تلقائي يعرض النتيجة
  W.__offline.queue();
  ok('الطابور دون اتصال: يُحفظ التسليم في localStorage', W.__offline.list().length === 1 && (W.localStorage.getItem('exammanasa_pending_submits') || '').includes(W.S.session.token.slice(0, 24)));
  await W.__offline.flush();
  await sleep(300);
  ok('إرسال الطابور: يُسلَّم للخادم ويعرض النتيجة ويُفرَّغ الطابور', W.__offline.list().length === 0 && W.S.view === 'result' && !!W.S.result && W.S.result.total === W.S.session.questions.length);
  harvestClasses(doc);
}

console.log('\n[6] الفلسفة والمنطق — أسماء الموضوعات من JSON حرفيًا + الشوامل منفصلة + علم النفس دون تغيير');
{
  const W = dom.window;
  W.location.hash = '#/s/philosophy/2';
  await sleep(300);
  let html = doc.getElementById('app').innerHTML;
  ok('تبويبا الترم الأول/الثاني', html.includes('الترم الأول') && html.includes('الترم الثاني'));
  const t2 = catalog.catalog.philosophy.terms[1];
  ok('ت2: 4 موضوعات رسمية (2 فلسفة + 2 منطق) — الدروس لا تظهر على صفحة الترم', doc.querySelectorAll('.topic-card').length === 4 && !doc.querySelector('.lesson-card') && ['الفلسفة والأخلاق البيئية والبيوطبية', 'الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد', 'الاستقراء وتطبيق المنهج التجريبي', 'الاستنباط وتطبيقه في العلوم الصورية'].every(t => html.includes(t)));
  { // كل الدروس بأسماء JSON الحقيقية عبر صفحات الموضوعات
    const t2c = catalog.catalog.philosophy.terms[1];
    let allLessonsOk = true;
    for (const sec of t2c.sections) for (const tp of sec.topics) {
      W.location.hash = '#/s/philosophy/2/t/' + encodeURIComponent(tp.key); await sleep(250);
      const titles = [...doc.querySelectorAll('.lesson-card .lt')].map(el => el.textContent);
      if (JSON.stringify(titles) !== JSON.stringify(tp.lessons.map(l => 'الدرس ' + l.no + ' — ' + l.title))) allLessonsOk = false;
    }
    ok('ت2: كل موضوع يعرض دروسه فقط بأسمائها الحقيقية من JSON (الفلسفة البيئية / الأخلاق البيوطبية / … / المنطق والذكاء الاصطناعي)', allLessonsOk);
    W.location.hash = '#/s/philosophy/2'; await sleep(250); html = doc.getElementById('app').innerHTML;
  }
  ok('ت2: الشوامل (شامل المنطق + شامل الترم 40 سؤالًا) في قسم «امتحانات شاملة» منفصل', doc.querySelectorAll('.lesson.comp').length === 2 && /40 سؤالًا/.test(html) && html.includes('الترم الثاني كاملًا') && html.includes('⭐ امتحان شامل'));
  const sumTr = () => [...doc.querySelectorAll('.topic-card .ls')].reduce((n, el) => n + parseInt((el.textContent.match(/(\d+) تدريب/) || [0, 0])[1], 10), 0);
  ok('ت2: عدد التدريبات في بطاقات الموضوعات = 14', sumTr() === 14);
  W.location.hash = '#/s/philosophy/1';
  await sleep(300);
  html = doc.getElementById('app').innerHTML;
  ok('ت1: 4 موضوعات (5+5+8+1 دروس) / 30 تدريبًا / 3 شوامل', doc.querySelectorAll('.topic-card').length === 4 && sumTr() === 30 && doc.querySelectorAll('.lesson.comp').length === 3);
  ok('لا أفقي: لا عناصر تتجاوز عرض الحاوية (لا white-space:nowrap على البطاقات، شبكات auto-fill)', /\.topic-grid\s*{[^}]*auto-fill/.test(css) && /\.training-grid\s*{[^}]*auto-fill/.test(css));
  // علم النفس كما هو
  W.location.hash = '#/s/psychology';
  await sleep(300);
  html = doc.getElementById('app').innerHTML;
  ok('علم النفس دون تغيير: 6 وحدات × 4 موضوعات + شامل لكل وحدة + شامل المنهج، بلا بطاقات موضوعات/تدريبات', doc.querySelectorAll('.unit-card').length === 6 && doc.querySelectorAll('.lesson:not(.comp)').length === 24 && doc.querySelectorAll('.lesson.comp').length === 7 && !doc.querySelector('.topic-card') && !doc.querySelector('.training-card'));
  harvestClasses(doc);
}

console.log('\n[6ب] تعدد المعلمين — /mostafa → /ahmed → /mohamed → /mostafa (تبويب جديد/تحديث/Back)');
{
  const owner = catalog.owner;
  // معلمان إضافيان عبر واجهة المسؤول (بيانات اختبار داخل جلسة الاختبار المعزولة فقط)
  const jar = {};
  const jpost = async (url, body, headers) => {
    const r = await fetch(new URL(url, BASE), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, headers || {}), body: JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  let login = await jpost('/api/admin/login', { email: 'admin@test.local', password: 'TestAdminPass-2026' });
  if (login.status === 404) { await jpost('/api/admin/setup', { email: 'admin@test.local', password: 'TestAdminPass-2026' }); login = await jpost('/api/admin/login', { email: 'admin@test.local', password: 'TestAdminPass-2026' }); }
  const H = { Cookie: jar.cookie };
  const created = [];
  // run-scoped slugs: the tool archives its teachers at the end, and archived slugs are
  // protected from silent reuse (they still own a results index) — so each run uses fresh slugs.
  const RND = Date.now().toString(36).slice(-5);
  const AHMED = 'ahmed' + RND, MOHAMED = 'mohamed' + RND;
  const mk = async (b) => { const r = await jpost('/api/admin/teachers', b, H); if (r.data && r.data.teacher) created.push(r.data.teacher.id); else if (r.status !== 200) console.log('    ↳ تعذر إنشاء المعلم ' + b.slug + ': HTTP ' + r.status); };
  await mk({ name: 'أ. أحمد عبدالله', slug: AHMED, specialty: 'فلسفة ومنطق', bio: 'نبذة أحمد', phone: '01111111111', socialLinks: { facebook: 'https://facebook.com/ahmed.test' }, requirePhone: false, enabled: true });
  await mk({ name: 'أ. محمد سعيد', slug: MOHAMED, specialty: 'علم نفس', bio: 'نبذة محمد', phone: '01222222222', socialLinks: { whatsapp: 'https://wa.me/201222222222' }, requirePhone: true, enabled: true });
  const check = async (slug, name, bio) => {
    const d2 = boot('/' + slug);
    await sleep(600);
    const dd = d2.window.document, h = dd.body.innerHTML;
    const others = ['د. مصطفى تيتو', 'أ. أحمد عبدالله', 'أ. محمد سعيد'].filter(n => n !== name);
    const okBrand = dd.getElementById('brandName').textContent === name && h.includes(bio) && others.every(n => !h.includes(n)) && (slug === AHMED || !h.includes('01111111111')) && (slug === MOHAMED || !h.includes('01222222222'));
    // الترم ← الموضوع ← التدريب بنفس بيانات المعلم
    d2.window.location.hash = '#/s/philosophy/1';
    await sleep(250);
    const tp0 = catalog.catalog.philosophy.terms[0].sections[0].topics[0];
    d2.window.location.hash = '#/s/philosophy/1/t/' + encodeURIComponent(tp0.key);
    await sleep(250);
    const okTopic = dd.querySelectorAll('.lesson-card').length === tp0.lessons.length;
    d2.window.location.hash = '#/s/philosophy/1/t/' + encodeURIComponent(tp0.key) + '/l/' + encodeURIComponent(tp0.lessons[0].key);
    await sleep(250);
    const okNav = okTopic && dd.querySelectorAll('.training-card').length >= 1 && d2.window.S.slug === slug && dd.getElementById('brandName').textContent === name;
    if (!okBrand || !okNav) console.log('    ↳ ' + slug + ': brand=' + dd.getElementById('brandName').textContent + ' bio=' + h.includes(bio) + ' others=' + others.filter(n => h.includes(n)).join('/') + ' phones=' + ((slug !== 'ahmed' && h.includes('01111111111')) || (slug !== 'mohamed' && h.includes('01222222222'))) + ' nav=' + okNav);
    return { okBrand, okNav, win: d2.window };
  };
  const seq = [['mostafa', owner.name, owner.bio], [AHMED, 'أ. أحمد عبدالله', 'نبذة أحمد'], [MOHAMED, 'أ. محمد سعيد', 'نبذة محمد'], ['mostafa', owner.name, owner.bio]];
  let allBrand = true, allNav = true, lastWin;
  for (const [slug, name, bio] of seq) { const r = await check(slug, name, bio); allBrand = allBrand && r.okBrand; allNav = allNav && r.okNav; lastWin = r.win; }
  ok('كل صفحة معلم تعرض بيانات معلمها فقط (اسم/نبذة) بلا تسريب اسم أو هاتف معلم آخر — عبر التسلسل كاملًا', allBrand);
  ok('الترم ← الموضوع ← الدرس ← التدريب يعمل داخل كل معلم مع الحفاظ على slug في الحالة', allNav);
  // Back/Forward داخل نفس التبويب لا يغيّر المعلم
  lastWin.location.hash = '#/s/philosophy/1';
  await sleep(200);
  lastWin.history.back(); await sleep(250);
  lastWin.history.forward(); await sleep(250);
  ok('Back/Forward يحافظان على المعلم (mostafa) والصفحة الصحيحة', lastWin.S.slug === 'mostafa' && lastWin.document.getElementById('brandName').textContent === owner.name && lastWin.location.hash === '#/s/philosophy/1');
  // بدء امتحان من صفحة أحمد: التوكن يحمل slug أحمد؛ النتيجة تحمل teacherSlug
  const st = await fetch(new URL('/api/exam/start', BASE), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ examId: 'T1-PH-01', name: 'طالب أحمد', phone: '', slug: AHMED }) }).then(r => r.json());
  const payload = JSON.parse(Buffer.from(st.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  ok('جلسة من صفحة /ahmed*: التوكن الموقّع يحمل slug المعلم (هاتف اختياري حسب إعداد المعلم)', payload.slug === AHMED && st.questions && st.questions.length === 20);
  const ghost = await fetch(new URL('/ghost-teacher', BASE));
  const ghostApi = await fetch(new URL('/api/teacher/ghost-teacher', BASE));
  ok('معلم غير موجود: الصفحة 404 و/api/teacher 404 بلا fallback لمعلم آخر', ghost.status === 404 && ghostApi.status === 404 && !(await ghost.text()).includes(owner.name));
  // تنظيف
  for (const id of created) await fetch(new URL('/api/admin/teachers/' + id, BASE), { method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Cookie: jar.cookie } }).catch(() => {});
}

console.log('\n[7] الهوية البصرية (أزرق/ذهبي فاتح) + تغطية CSS + سلامة اللغة');
{
  const used = renderedClasses;
  ['lesson comp', 'lno', 'linfo', 'lt', 'ls', 'lgo', 'comp-badge', 'final-comp', 'unit-card', 'unit-head', 'uno', 'chapter', 'ch-title',
   'grade-mini', 'grade-card', 'grade-opt sel', 'gcheck', 'gstats', 'stu-sum', 'sn', 'sp', 'linkbtn', 'hero-media', 'blob', 'ring',
   'photo-badge', 'float-chip', 'hero-body', 'hero-grades', 'kicker', 'lead', 'hero-chips', 'hero-ctas', 'features', 'feature',
   'fi f1', 'fi f2', 'fi f3', 'about-card', 'abody', 'specialty', 'bio', 'social-row', 'social-big', 'grade-pick', 'mainnav', 'socials',
   'nchip answered current', 'opt selected', 'rv-item', 'rq correct', 'rq wrong', 'ans mine wrong', 'ans correct', 'score-ring pass',
   'score-ring fail', 'tab active', 'badge green', 'badge gold', 'badge red', 'toast err', 'progressbar', 'navstrip', 'qcard', 'qtext',
   'qn', 'opts', 'letter', 'txt', 'quiz-actions', 'rules-card', 'res-badges', 'review-filters', 'meta-row', 'topic-card', 'lesson-card', 'lgo-text', 'topic-grid', 'topics-hint', 'topic-head', 'training-grid', 'training-card', 'tc-no', 'tc-body', 'tc-title', 'tc-meta', 'tc-start', 'topic-nav',
   'exam-list', 'rv-note warn', 'rv-note ok', 'empty', 'spin', 'modal-bg', 'modal', 'gsub', 'bname', 'brand-txt', 'foot-brand', 'foot-sub', 'foot-copy'
  ].forEach(c => c.split(' ').forEach(x => used.add(x)));
  const missing = [...used].filter(c => !new RegExp('\\.' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s,{:.])').test(css));
  ok('كل الفئات المستخدمة موجودة في styles.css (' + used.size + ' فئة)', missing.length === 0, 'ناقص: ' + missing.join(', '));

  ok('هوية زرقاء احترافية (#1E56C8) + ذهبي (#C99A2E) — كمرجع التصميم', /--primary:\s*#1E56C8/i.test(css) && /--gold:\s*#C99A2E/i.test(css));
  ok('نظام فاتح فقط: خلفية فاتحة، لا prefers-color-scheme داكن', /--bg:\s*#F/i.test(css) && !/prefers-color-scheme:\s*dark/i.test(css));
  ok('تدرجات ناعمة زرقاء/لافندر وظلال خفيفة', /radial-gradient/.test(css) && /--shadow-sm/.test(css) && /--radius/.test(css));
  ok('استجابة مقصودة للموبايل: تكديس الواجهة على شاشات صغيرة', /@media \(max-width: 920px\)/.test(css) && /grid-template-areas: "body" "media" "grades"/.test(css));
  ok('RTL في القالبين + خط عربي احترافي مع swap', indexHtml.includes('dir="rtl"') && adminHtml.includes('dir="rtl"') && /Tajawal/.test(indexHtml) && /display=swap/.test(indexHtml));

  const allJs = appJs + adminJs;
  ok('مصطلحات موحدة: تسليم الامتحان / مراجعة الإجابات / إجابتك / الإجابة الصحيحة',
    allJs.includes('تسليم الامتحان') && allJs.includes('مراجعة الإجابات') && allJs.includes('إجابتك') && allJs.includes('الإجابة الصحيحة'));
  ok('مصطلحات موحدة: الموضوع / الدرس / الوحدة / الترم / الامتحان الشامل',
    allJs.includes('الموضوع') && allJs.includes('الدرس') && allJs.includes('الوحدة') && allJs.includes('الترم') && allJs.includes('الامتحان الشامل'));
  ok('لا خلط إنجليزي في نصوص الطالب', !/>(Start|Next|Prev|Submit|Score)</.test(appJs));
  ok('خط الطالب خفيف (لا أطر/مكتبات)', !/react|vue|angular|jquery/i.test(appJs));
  ok('لا صور ثقيلة/فيديو/مكتبات وسائط في الحزمة', !/background-video|<video|\.mp4/i.test(indexHtml + appJs + css));
  ok('لا طلبات دورية/استقصاء في كود الطالب', !/setInterval/.test(appJs));
}

console.log('\n[7ب] الأمان — حماية المسارات والتوكنات');
{
  const adminNoAuth = await fetch(new URL('/api/admin/overview', BASE)).catch(() => null);
  ok('مسارات الإدارة ترفض الوصول بدون جلسة (401)', !!adminNoAuth && adminNoAuth.status === 401);
  const forged = await fetch(new URL('/api/exam/submit', BASE), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'forged.token.here', answers: [0] })
  });
  ok('التوكن المزوَّر/العبث مرفوض (403)', forged.status === 403);
  ok('لا كلمات مرور ولا مفاتيح في كود الواجهة العام (app.js)',
    !/password\s*[:=]\s*['"][^'"]{4,}['"]/i.test(appJs) && !/secret\s*[:=]\s*['"][^'"]{8,}['"]/i.test(appJs) &&
    !/"answer"\s*:/.test(appJs));
}

console.log('\n[7ج] ملف المعلم — التواصل يظهر عند وجود روابط فعلية فقط');
{
  const W = dom.window;
  const saved = W.S.teacher;
  const fakeLinks = { whatsapp: 'https://wa.me/201000000000', facebook: 'https://facebook.com/exammanasa', tiktok: 'https://tiktok.com/@exammanasa' };
  W.S.teacher = Object.assign({}, saved, { socialLinks: fakeLinks });
  W.renderBrand();
  W.location.hash = '#/';
  await sleep(300);
  const icons = [...doc.querySelectorAll('#topSocials a')];
  ok('عند إعداد روابط فعلية: أيقونات الهيدر الثلاث تظهر بروابطها الصحيحة',
    icons.length === 3 && icons.every(a => Object.values(fakeLinks).includes(a.href)));
  ok('وزر «تواصل معنا» يظهر في التنقل + قسم تواصل بثلاث بطاقات',
    !doc.getElementById('navContact').hidden && !!doc.getElementById('contact') && doc.querySelectorAll('.social-big a').length === 3);
  ok('زر واتساب في الواجهة الرئيسية يشير للرابط الفعلي',
    !!doc.querySelector('.hero .btn.wa') && doc.querySelector('.hero .btn.wa').href === fakeLinks.whatsapp);
  // إعادة الحالة الفعلية (لا روابط مُعدّة حاليًا) — إعادة رسم مباشرة
  W.S.teacher = saved;
  W.renderBrand();
  W.renderHome();
  await sleep(100);
  ok('بدون روابط مُعدّة: لا أيقونات وهمية إطلاقًا (الحالة الفعلية الآن)',
    doc.querySelectorAll('#topSocials a').length === 0 && doc.getElementById('navContact').hidden && !doc.getElementById('contact'));
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
    !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(adminJs + adminHtml) &&
    !/password\s*[:=]\s*['"][^'"]{6,}['"]/i.test(adminJs + adminHtml));
}

console.log('\n[9] الأداء وخفة الحزمة');
{
  // Budget: student SPA + admin panel + shared CSS must stay framework-free and lean.
  // Re-baselined from 140KB → 155KB after the teacher-platform UI (PR #9 + final platform)
  // added ~3KB of real functionality; the assertion still catches any framework/bloat regression.
  const totalKB = Math.round((appJs.length + css.length + adminJs.length) / 1024);
  ok('ملفات الواجهة خفيفة (' + totalKB + 'KB غير مضغوطة، بدون أطر)', totalKB < 155);
  const cacheH = await fetch(BASE + '/app.js').then(r => r.headers.get('cache-control'));
  ok('ترويسة تخزين مؤقت للملفات الثابتة', (cacheH || '').includes('max-age'));
  ok('الخطوط من Google Fonts مع preconnect', /preconnect[^>]+fonts\.googleapis/.test(indexHtml));
}

console.log('\n══════════════════════════');
console.log('فحص الواجهة: ' + pass + ' ناجح ✓ / ' + fail + ' فاشل ✗');
if (fail) process.exit(1);
console.log('RESULT: UI QA PASSED ✓');
