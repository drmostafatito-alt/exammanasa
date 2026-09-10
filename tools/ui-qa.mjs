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
  ok('إحصاءات فعلية من الفهرس (' + psyExams + ' علم نفس / ' + phExams + ' فلسفة)', html.includes(psyExams + ' امتحانًا') && html.includes(phExams + ' امتحانًا'));
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

console.log('\n[4ب] نماذج الامتحان — ظهور واضح ومسار مستقل لكل نموذج');
{
  const W = dom.window;
  W.location.hash = '#/s/philosophy/1';
  await sleep(300);
  // الدرس ذات 4 نماذج من الفهرس
  const t1 = catalog.catalog.philosophy.terms[0];
  let multi = null;
  t1.units.forEach(u => u.chapters.forEach(ch => ch.lessons.forEach(l => { if (!multi && l.examIds.length >= 4) multi = l; })));
  ok('يوجد درس متعدد النماذج في الفهرس (' + multi.examIds.length + ' نماذج)', !!multi && multi.examIds.length === 4);
  const row = [...doc.querySelectorAll('.lesson:not(.comp)')].find(r => r.querySelector('.lt').textContent === multi.title);
  ok('صف الموضوع يعرض منطقة «الامتحانات المتاحة» مجمّعة وواضحة', !!row && !!row.querySelector('.models') && row.querySelector('.models-label').textContent.includes('الامتحانات المتاحة'));
  const btns = row ? row.querySelectorAll('.model-btn') : [];
  ok('كل نموذج زر امتحان مستقل بارز (' + btns.length + ' أزرار — ليست رقائق صغيرة)', btns.length === multi.examIds.length && !doc.querySelector('.variant-chip'));
  const countsOk = [...btns].every((b, i) =>
    b.querySelector('.m-name').textContent.trim() === 'نموذج ' + (i + 1) &&
    b.querySelector('.m-meta').textContent.includes(catalog.exams[multi.examIds[i]].count + ' سؤالًا'));
  ok('كل زر يعرض «نموذج N» + عدد الأسئلة الفعلي من البيانات («امتحان تدريبي · 20 سؤالًا»)', countsOk);
  ok('حجم لمس مريح (min-height ≥ 48px) وحالة hover/active في CSS',
    /\.model-btn\s*{[^}]*min-height:\s*(4[8-9]|[5-9]\d)px/.test(css) && /\.model-btn:hover/.test(css) && /\.model-btn:active/.test(css));
  // المسار: النقر على «نموذج 2» يفتح الامتحان الثاني تحديدًا
  const model2 = btns[1];
  model2.click();
  await sleep(300);
  const eid2 = multi.examIds[1];
  ok('«نموذج 2» يفتح الامتحان الصحيح (#/e/' + eid2 + ')', W.location.hash === '#/e/' + eid2);
  ok('عنوان الامتحان الصحيح للنموذج 2', doc.querySelector('.exam-head h2').textContent === catalog.exams[eid2].title);
  // بدء نموذج 2 فعليًا وتسليمه — التحقق من الأسئلة والتصحيح
  doc.getElementById('startBtn').click();
  await sleep(450);
  ok('جلسة النموذج 2: معرف الامتحان الصحيح وعدد الأسئلة الصحيح',
    W.S.session.exam.id === eid2 && W.S.session.questions.length === catalog.exams[eid2].count);
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
  ok('تسليم النموذج 2 ينقل للنتيجة ويحفظها', W.location.hash === '#/result' && !!r && r.total === total);
  ok('التصحيح متسق ذاتيًا: isCorrect ≡ (إجابتك = الإجابة الصحيحة) لكل سؤال',
    r.review.every(q => q.isCorrect === (q.studentAnswerText === q.correctAnswerText)));
  ok('النسبة المئوية صحيحة حسابيًا وصحيح+خطأ = المجموع',
    r.percentage === Math.round(r.score / r.total * 100) && r.correct + r.wrong === r.total && r.score === r.correct);
  // «نموذج 4» يمتد أيضًا للامتحان الصحيح (لا توجيه كل النماذج لنفس الامتحان)
  W.location.hash = '#/s/philosophy/1';
  await sleep(300);
  const row2 = [...doc.querySelectorAll('.lesson:not(.comp)')].find(x => x.querySelector('.lt').textContent === multi.title);
  row2.querySelectorAll('.model-btn')[3].click();
  await sleep(300);
  ok('«نموذج 4» يفتح امتحانًا مختلفًا عن النموذج 2 (#/e/' + multi.examIds[3] + ')',
    W.location.hash === '#/e/' + multi.examIds[3] && multi.examIds[3] !== eid2);
  harvestClasses(doc);
}

console.log('\n[5] قاعدة منع التسليم الناقص — تحديد الأسئلة بدقة');
{
  // جلسة جديدة عبر النقر على امتحان المنطق ت2
  const W = dom.window;
  W.location.hash = '#/s/philosophy/2';
  await sleep(300);
  const rows = [...doc.querySelectorAll('.lesson:not(.comp)')];
  rows[0].click();
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
  harvestClasses(doc);
}

console.log('\n[6] الفلسفة والمنطق — ترم ← وحدة ← فصل ← موضوع ← امتحان ← شوامل');
{
  const W = dom.window;
  W.location.hash = '#/s/philosophy/2';
  await sleep(300);
  let html = doc.getElementById('app').innerHTML;
  ok('تبويبا الترم الأول/الثاني', html.includes('الترم الأول') && html.includes('الترم الثاني'));
  const t2 = catalog.catalog.philosophy.terms[1];
  ok('وحدتا ت2 (فلسفة + منطق) كبطاقات وحدات', doc.querySelectorAll('.unit-card').length === t2.units.length && html.includes('الوحدة الأولى: الفلسفة') && html.includes('الوحدة الثانية: المنطق'));
  ok('الفصول داخل الوحدات بتسميتها الرسمية', html.includes('الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية') && html.includes('الفصل الأول: الاستقراء وتطبيق المنهج التجريبي'));
  const l0 = t2.units[1].chapters[0].lessons[0];
  const row = [...doc.querySelectorAll('.lesson:not(.comp)')].find(r2 => r2.querySelector('.lt').textContent === l0.title);
  ok('«الموضوع ' + l0.no + '» + الدرس حرفيًا: ' + l0.title, !!row && row.querySelector('.lno b').textContent === String(l0.no));
  ok('نماذج الامتحانات المتعددة تظهر كأزرار مستقلة داخل صف الموضوع', doc.querySelectorAll('.model-btn').length >= 3 && html.includes('الامتحانات المتاحة'));
  ok('شوامل الوحدات بشارة ⭐ «امتحان شامل» مميزة', doc.querySelectorAll('.lesson.comp').length >= 2 && html.includes('⭐ امتحان شامل'));
  ok('الامتحان الشامل للترم — 40 سؤالًا (فلسفة + منطق)', /40 سؤالًا/.test(html) && html.includes('الترم الثاني كاملًا'));
  // ت1
  W.location.hash = '#/s/philosophy/1';
  await sleep(300);
  html = doc.getElementById('app').innerHTML;
  ok('ت1: الوحدة الأولى: الفلسفة / الوحدة الثانية: المنطق', html.includes('الوحدة الأولى: الفلسفة') && html.includes('الوحدة الثانية: المنطق'));
  ok('ت1: الامتحان الشامل للترم موجود', html.includes('الامتحان الشامل للترم'));
  harvestClasses(doc);
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
   'qn', 'opts', 'letter', 'txt', 'quiz-actions', 'rules-card', 'res-badges', 'review-filters', 'meta-row', 'models', 'models-label', 'models-grid', 'model-btn', 'm-top', 'm-name', 'm-arrow', 'm-meta',
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
  const totalKB = Math.round((appJs.length + css.length + adminJs.length) / 1024);
  ok('ملفات الواجهة خفيفة (' + totalKB + 'KB غير مضغوطة، بدون أطر)', totalKB < 140);
  const cacheH = await fetch(BASE + '/app.js').then(r => r.headers.get('cache-control'));
  ok('ترويسة تخزين مؤقت للملفات الثابتة', (cacheH || '').includes('max-age'));
  ok('الخطوط من Google Fonts مع preconnect', /preconnect[^>]+fonts\.googleapis/.test(indexHtml));
}

console.log('\n══════════════════════════');
console.log('فحص الواجهة: ' + pass + ' ناجح ✓ / ' + fail + ' فاشل ✗');
if (fail) process.exit(1);
console.log('RESULT: UI QA PASSED ✓');
