/**
 * e2e-cms.mjs — تدفق CMS كامل عبر متصفح Chromium حقيقي على لوحة التحكم الفعلية:
 * بنك الأسئلة ← تعديل سؤال ← تغيير مفتاح الإجابة (A/B/C/D) ← استعادة الأصل (diff=0)،
 * محرر الامتحان ← إعادة ترتيب/إزالة/إضافة من المنتقي ← حفظ ← استعادة الأصل،
 * استيراد JSON ← معاينة ← تأكيد صريح ← تصدير قياسي ← حذف ← سلة المحذوفات،
 * ثم تنظيف الطبقة الفوقية حتى تعود العدّادات لخط الأساس (حماية بنك الأسئلة).
 * مع مراقب console/pageerror وفحص تسريب مفاتيح الإجابة لواجهة الطالب.
 *
 * التشغيل:
 *   cd cloudflare && npx wrangler dev --port 8787 --persist-to /tmp/wrangler-dev &
 *   QABASE=http://127.0.0.1:8787 ADM_EMAIL=... ADM_PASS=... node ../tools/e2e-cms.mjs
 * (يتطلب playwright-core + @sparticuz/chromium مثبتين كما في tools/browser-e2e.mjs)
 */
/* e2e-cms.mjs — تدفق CMS كامل من المتصفح (لوحة التحكم الحقيقية):
 * بنك الأسئلة ← تعديل سؤال ← تغيير مفتاح الإجابة ← استعادة الأصل،
 * محرر الامتحان ← إعادة ترتيب/إزالة/إضافة من المنتقي ← حفظ ← استعادة الأصل،
 * استيراد JSON ← معاينة ← تأكيد ← تصدير ← حذف ← سلة المحذوفات،
 * وتنظيف الطبقة الفوقية حتى يعود عدّاد المحتوى لطبيعته (bank diff = 0).
 * مع مراقب console/pageerror وتسريب المفاتيح للطلاب. */
import { chromium as pw } from 'playwright-core';
import chromiumMin from '@sparticuz/chromium-min';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.QABASE || 'http://127.0.0.1:8787';
const ADMIN = { email: process.env.ADM_EMAIL || 'admin@exam.test', pass: process.env.ADM_PASS || 'AdminPass#2026' };
const SHOTS = process.env.QASHOTS || '/home/user/exammanasa/tools/shots';
mkdirSync(SHOTS, { recursive: true });
const exe = await chromiumMin.executablePath('/tmp/chrm');
process.env.LD_LIBRARY_PATH = (process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : '') + '/tmp/crlibs/lib';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const consoleIssues = [];
const ALLOW = [/fonts\.(googleapis|gstatic)\.com/, /net::/, /ERR_[A-Z_]+/, /Failed to load resource: the server responded with a status of 4(01|00|03|04|29)/];

const browser = await pw.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ar'], headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar-EG' });
const p = await ctx.newPage();
p.on('console', m => { if (m.type() === 'error') { const t = m.text() || ''; if (!ALLOW.some(re => re.test(t))) consoleIssues.push(t.slice(0, 160)); } });
p.on('pageerror', e => consoleIssues.push('pageerror: ' + String(e && e.message).slice(0, 160)));

const api = (path, opts) => p.evaluate(([path, opts]) => fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' } }, opts || {})).then(r => r.json().then(b => ({ status: r.status, body: b }))), [path, opts]);

await p.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
await p.fill('#admEmail', ADMIN.email);
await p.fill('#admPass', ADMIN.pass);
await p.click('.tlogin-card button[type=submit]');
await p.waitForSelector('.a-shell', { timeout: 15000 });
console.log('\n[CMS-1] دخول المسؤول + تنظيف بقايا_runs سابقة + خط الأساس');
// تطهير ذاتي: أي امتحانات/أسئلة مخصّصة تخلّفت عن تشغيل سابق تُنقل للسلة قبل قياس الأساس
const leftoverExams = (await api('/api/admin/exams?status=custom&perPage=100')).body.exams || [];
for (const e of leftoverExams) { await api('/api/admin/exams/' + encodeURIComponent(e.id), { method: 'DELETE' }); }
if (leftoverExams.length) console.log('    ↳ بقايا امتحانات مخصّصة نُقلت للسلة: ' + leftoverExams.length);
await p.evaluate(() => window.setTab('bank'));
await p.waitForSelector('#fOnly', { timeout: 8000 });
await p.selectOption('#fOnly', 'custom');
await sleep(1200);
let leftQ = await p.locator('#bankList .cms-q').count();
while (leftQ > 0) {
  await p.click('#bankList .cms-q button[title="حذف السؤال"]');
  await p.waitForSelector('#cmOk', { timeout: 5000 });
  await p.click('#cmOk');
  await sleep(1200);
  leftQ = await p.locator('#bankList .cms-q').count();
}
if (leftoverExams.length || leftQ >= 0) console.log('    ↳ بقايا أسئلة مخصّصة نُقلت للسلة: ' + leftQ);
await p.selectOption('#fOnly', '');
await sleep(1200);
const base = (await api('/api/admin/overview')).body;
const baseCounts = { custom: base.customQuestions || 0, edited: base.editedQuestions || 0, editedExams: base.editedExams || 0 };
ok('خط الأساس: عدّادات الطبقة الفوقية مقروءة', typeof baseCounts.custom === 'number', JSON.stringify(baseCounts));

/* ---------- بنك الأسئلة: تعديل سؤال + مفتاح الإجابة + استعادة ---------- */
console.log('\n[CMS-2] بنك الأسئلة — تعديل سؤال ومفتاحه ثم استعادة الأصل');
await p.evaluate(() => window.setTab('bank'));
await p.waitForSelector('#bankList .cms-q', { timeout: 15000 });
const first = await p.evaluate(() => {
  // سؤال «موثق» غير معدّل مسبقًا حتى يكون أصل البنك هو مرجع المقارنة
  const row = [...document.querySelectorAll('#bankList .cms-q')].find(r => r.querySelector('.badge.green'));
  return {
    qid: row.querySelector('.qid').textContent.trim(),
    key: (row.querySelector('.ans.correct .k') || {}).textContent || ''
  };
});
ok('صف البنك يعرض المعرف والمفتاح الصحيح', !!first.qid && /^[ABCD]$/.test(first.key), JSON.stringify(first));
await p.click('#bankList .cms-q:has-text("' + first.qid + '") button[title="تعديل السؤال"]');
await p.waitForSelector('#qeKey', { timeout: 8000 });
const origOn = await p.evaluate(() => (document.querySelector('#qeKey .kbtn.on') || {}).getAttribute('data-k'));
ok('محرر السؤال يعلّم المفتاح المخزّن أصلًا', origOn === first.key, origOn + ' vs ' + first.key);
const newKey = 'ABCD'.replace(first.key, '').slice(0, 1);
await p.click('#qeKey .kbtn[data-k="' + newKey + '"]');
await p.click('.cms-qmodal button:has-text("حفظ التعديلات")');
await sleep(1500);
let q1r = (await api('/api/admin/questions/' + first.qid)).body; let q1 = q1r.question; q1.edited = q1r.edited;
ok('حفظ تعديل المفتاح من الواجهة (' + first.key + '←' + newKey + ')', q1.answer === newKey && q1.edited === true, JSON.stringify({ a: q1.answer, e: q1.edited }));
const modOf = (x) => (x && x.exam && x.exam.modified !== undefined) ? x.exam.modified : (x ? x.modified : undefined);
await p.screenshot({ path: SHOTS + '/cms-bank-edited.png' });
// استعادة الأصل من الواجهة
await p.click('#bankList .cms-q:has-text("' + first.qid + '") button[title="تعديل السؤال"]');
await p.waitForSelector('.cms-qmodal button:has-text("استعادة الأصل")', { timeout: 8000 });
await p.click('.cms-qmodal button:has-text("استعادة الأصل")');
await p.waitForSelector('#cmOk', { timeout: 5000 });
await p.click('#cmOk');
await sleep(1500);
q1r = (await api('/api/admin/questions/' + first.qid)).body; q1 = q1r.question; q1.edited = q1r.edited;
ok('استعادة الأصل تعيد المفتاح والنص حرفيًا (diff=0)', q1.answer === first.key && q1.edited === false, JSON.stringify({ a: q1.answer, e: q1.edited }));

/* ---------- محرر الامتحان: ترتيب/إزالة/إضافة/حفظ/استعادة ---------- */
console.log('\n[CMS-3] محرر الامتحان — ترتيب وإزالة وإضافة وحفظ ثم استعادة الأصل');
const EX = 'T1-PH-01';
const orig = (await api('/api/admin/exams/' + EX)).body;
const origIds = orig.questionIds.slice();
await p.evaluate(() => window.setTab('exams'));
await p.waitForSelector('#exList .cms-exrow', { timeout: 15000 });
await p.click('#exList .cms-exrow:has-text("' + EX + '") button:has-text("فتح المحرر")');
await p.waitForSelector('#eeRows .ee-row', { timeout: 10000 });
const n0 = await p.locator('#eeRows .ee-row').count();
ok('المحرر يفتح بصفوف الامتحان (' + n0 + ')', n0 === origIds.length, n0 + ' vs ' + origIds.length);
await p.locator('#eeRows .ee-row').nth(0).locator('button[title="لأسفل"]').click();
await p.locator('#eeRows .ee-row').nth(2).locator('button[title="إزالة من الامتحان"]').click();
await sleep(300);
await p.click('button:has-text("+ إضافة سؤال")');
await p.waitForSelector('#pkList label.pk-row input:not([disabled])', { timeout: 10000 });
const pickId = await p.evaluate((inExam) => {
  const cbs = [...document.querySelectorAll('#pkList label.pk-row input:not([disabled])')];
  const cb = cbs.find(c => !inExam.includes(c.value)) || cbs[0];
  cb.click();
  return cb.value;
}, origIds);
await p.click('button:has-text("إضافة إلى الامتحان")');
await sleep(600);
const n1 = await p.locator('#eeRows .ee-row').count();
ok('المنتقي يضيف سؤالًا من البنك بلا نسخ', n1 === n0 - 1 + 1, n1 + '');
await p.screenshot({ path: SHOTS + '/cms-exam-editor-dirty.png' });
await p.click('button:has-text("حفظ التعديلات")');
await sleep(1800);
const after = (await api('/api/admin/exams/' + EX)).body;
const expectIds = [origIds[1], origIds[0], ...origIds.slice(3), pickId];
ok('الحفظ يطبّق الترتيب والإزالة والإضافة', JSON.stringify(after.questionIds) === JSON.stringify(expectIds),
  JSON.stringify({ got: after.questionIds.slice(0, 5), want: expectIds.slice(0, 5) }));
ok('الامتحان يُعلَّم «معدّل» في الطبقة الفوقية', modOf(after) === true, String(modOf(after)));
await p.click('button:has-text("استعادة الأصل")');
await p.waitForSelector('#cmOk', { timeout: 5000 });
await p.click('#cmOk');
await sleep(1500);
const rev = (await api('/api/admin/exams/' + EX)).body;
ok('استعادة أصل الامتحان تعيد الترتيب حرفيًا (diff=0)', JSON.stringify(rev.questionIds) === JSON.stringify(origIds) && modOf(rev) === false, JSON.stringify({ got: rev.questionIds.slice(0, 4), want: origIds.slice(0, 4), mod: modOf(rev) }));

/* ---------- الاستيراد: معاينة ← تأكيد ← تصدير ← حذف ---------- */
console.log('\n[CMS-4] استيراد JSON — معاينة ثم تأكيد صريح ثم تصدير ثم حذف');
const bankQ = (await api('/api/admin/questions?perPage=1')).body.questions[0];
const impDoc = {
  version: 1,
  exam: { title: 'امتحان تدقيق CMS (يُحذف بعد الاختبار)', subject: 'الفلسفة والمنطق', term: 'الترم الأول', grade: 'الصف الأول الثانوي' },
  questions: [
    { text: bankQ.text, options: { A: bankQ.options[0], B: bankQ.options[1], C: bankQ.options[2], D: bankQ.options[3] }, correctAnswer: bankQ.answer },
    { text: 'سؤال جديد تمامًا أنشأه تدقيق CMS الجولة الخامسة رقم ' + Date.now() + ' — ما عنوانه؟', options: { A: 'خ1', B: 'خ2', C: 'خ3', D: 'خ4' }, correctAnswer: 'C' }
  ]
};
writeFileSync('/tmp/shots/import-ok.json', JSON.stringify(impDoc, null, 2));
await p.evaluate(() => window.setTab('import'));
await p.waitForSelector('#impDrop', { timeout: 8000 });
await p.setInputFiles('#impFile', '/tmp/shots/import-ok.json');
await sleep(400);
await p.click('#impPrevBtn');
await sleep(1500);
const rep = await p.evaluate(() => ({
  okCls: !!document.querySelector('#impReport .cms-rep.ok'),
  chips: [...document.querySelectorAll('#impReport .cchip')].map(c => c.textContent.trim()),
  commitDisabled: (() => { const b = [...document.querySelectorAll('#impReport button')].find(x => /importCommit/.test(x.getAttribute('onclick') || '')); return b ? b.disabled : null; })()
}));
ok('المعاينة: سؤال موجود + سؤال جديد وبلا أخطاء', rep.okCls && rep.commitDisabled === false, JSON.stringify(rep.chips));
ok('المعاينة تذكر الربط دون تكرار', rep.chips.some(c => /موجود بالفعل 1/.test(c)) && rep.chips.some(c => /جديد 1/.test(c)), JSON.stringify(rep.chips));
await p.screenshot({ path: SHOTS + '/cms-import-preview.png' });
await p.click('#impReport button:has-text("استيراد")');
await p.waitForSelector('#cmOk', { timeout: 5000 });
await p.click('#cmOk');
await p.waitForSelector('#eeRows .ee-row', { timeout: 10000 });
const impId = await p.evaluate(() => document.querySelector('.cms-bar .qid').textContent.trim());
ok('التأكيد ينشئ امتحان CX- ويفتح محرره بصفين', /^CX-/.test(impId) && (await p.locator('#eeRows .ee-row').count()) === 2, impId);
await p.screenshot({ path: SHOTS + '/cms-import-committed.png' });
// الطالب يبدأ الامتحان المستورد بلا مفاتيح
const start = await p.evaluate(([id]) => fetch('/api/exam/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ examId: id, name: 'طالب تدقيق', phone: '01000000000' }) }).then(r => r.json()), [impId]);
ok('الطالب يبدأ الامتحان المستورد', !!start.token && start.questions.length === 2, JSON.stringify(Object.keys(start).slice(0, 5)));
ok('لا مفاتيح إجابة في جلسة الطالب', !JSON.stringify(start).includes('correctAnswer') && !/"answer"/.test(JSON.stringify(start.questions)));
// التصدير بصيغة قياسية
const exp = (await api('/api/admin/exams/' + impId + '/export')).body;
ok('التصدير بصيغة قانية كاملة (exam+questions+correctAnswer للمسؤول فقط)',
  exp.version === 1 && exp.exam.id === impId && exp.questions.length === 2 && exp.questions.every(q => /^[ABCD]$/.test(q.correctAnswer) && Object.keys(q.options).join('') === 'ABCD'),
  JSON.stringify(Object.keys(exp)));
// حذف الامتحان (سلة المحذوفات) ثم التحقق
await p.click('button:has-text("حذف")');
await p.waitForSelector('#cmOk', { timeout: 5000 });
await p.click('#cmOk');
await sleep(1500);
const gone = await p.evaluate(([id]) => fetch('/api/exam/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ examId: id, name: 'ط', phone: '01000000000' }) }).then(r => r.status), [impId]);
ok('الامتحان المحذوف لا يبدأ للطلاب', gone >= 400, String(gone));
await p.evaluate(() => window.setTab('exams'));
await p.waitForSelector('#exList', { timeout: 8000 });
await p.click('button:has-text("سلة المحذوفات")');
await p.waitForSelector('.modal-bg', { timeout: 5000 });
const inTrash = await p.evaluate(([id]) => document.querySelector('.modal-bg').textContent.includes(id), [impId]);
ok('الامتحان المحذوف في سلة المحذوفات (قابل للاستعادة)', inTrash);
await p.screenshot({ path: SHOTS + '/cms-exams-trash.png' });
await p.click('.modal-bg button:has-text("إغلاق")');
await sleep(300);

/* ---------- تنظيف السؤال المخصّص + عدّاد المحتوى ---------- */
console.log('\n[CMS-5] تنظيف الطبقة الفوقية (bank diff = 0)');
await p.evaluate(() => window.setTab('bank'));
await p.waitForSelector('#fOnly', { timeout: 8000 });
await p.selectOption('#fOnly', 'custom');
await sleep(1500);
const customRows = await p.locator('#bankList .cms-q').count();
ok('سؤال الاستيراد المخصّص وحيد في فلتر «مضافة/مستوردة»', customRows === 1, 'rows=' + customRows);
if (customRows === 1) {
  await p.click('#bankList .cms-q button[title="حذف السؤال"]');
  await p.waitForSelector('#cmOk', { timeout: 5000 });
  await p.click('#cmOk');
  await sleep(1500);
}
const end = (await api('/api/admin/overview')).body;
const endCounts = { custom: end.customQuestions || 0, edited: end.editedQuestions || 0, editedExams: end.editedExams || 0 };
ok('عدّادات الطبقة الفوقية عادت لخط الأساس (لا أثر للاستيراد/التعديل)',
  JSON.stringify(endCounts) === JSON.stringify(baseCounts), JSON.stringify({ baseCounts, endCounts }));

console.log('\n[CMS-6] أخطاء الكونسول');
ok('لا أخطاء console/pageerror غير متوقعة', consoleIssues.length === 0, consoleIssues.slice(0, 5).join(' | '));

await browser.close();
console.log('\n══════════════════════');
console.log('CMS E2E: ' + pass + ' pass / ' + fail + ' fail');
console.log(fail ? 'RESULT: FAILED ✗' : 'RESULT: PASSED ✓');
process.exit(fail ? 1 : 0);
