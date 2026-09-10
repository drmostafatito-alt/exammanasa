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
 *  12. حدود المحاولات لكل معلم (خادم + عدّاد ذري) وتوحيد أرقام الهواتف
 *  13. وضع عدم الاتصال (عقد الخادم: صلاحية 72 ساعة + علَم offline)
 *  14. لوحة المعلم لكل معلم + أمان التسجيل (رفض المعلم المعطّل، تجاهل حقن الدرجة) وعدم تسريب المفاتيح
 *
 * Usage: npm test   (from cloudflare/)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
    const listed = Object.values(r.data.exams).filter(e => !e.legacy).length;
    ok('127 امتحانًا في الفهرس (80 معروضًا + 47 نموذجًا قديمًا محفوظًا)', examCount === 127 && listed === 80, 'got ' + examCount + '/' + listed);
    ok('الفهرس يتضمن مالك المنصة (owner) ببيانات عامة فقط',
      r.data.owner && r.data.owner.name === 'د. مصطفى تيتو' && r.data.owner.slug === 'mostafa' &&
      'specialty' in r.data.owner && !('phone' in r.data.owner) && !('id' in r.data.owner));
    const anyExam = r.data.exams['T2L-COMP'];
    ok('لا مستويات صعوبة في أي امتحان فلسفة معروض للطالب (أُزيلت بطلب المنتج) وبدون تسريب مفاتيح',
      Object.values(r.data.exams).filter(e => e.subjectId === 'philosophy').every(e => !('difficulty' in e)) &&
      !('questionIds' in anyExam) && !('answer' in anyExam));
    ok('لا مفاتيح إجابة في الكتالوج', !r.text.includes('"answer"'));
    ok('لا قوائم أسئلة في الكتالوج', !r.text.includes('questionIds'));
    ok('لا نصوص أسئلة في الكتالوج', !BANKS.examDefs || !r.text.includes(Object.values(BANKS.questions)[0].text.slice(0, 30)));
    const t1 = r.data.catalog.philosophy.terms[0];
    ok('الفلسفة والمنطق: الترم → القسم (الفلسفة/المنطق) → موضوعان → الدرس → التدريب', t1.sections.length === 2 && t1.sections[0].title === 'الفلسفة' && t1.sections[1].title === 'المنطق' && t1.sections.every(s => s.topics.length === 2) && t1.sections[0].topics[0].lessons[0].trainings[0].examId === 'T1-PH-01');
    ok('لا مستويات صعوبة في بيانات تدريبات الفلسفة المعروضة للطالب', Object.values(r.data.exams).filter(e => e.topicKey).every(e => !('difficulty' in e)));
    ok('لا تسريب لحقول مفاتيح JSON في الفهرس', !/correct_option|correct_answer|keyStatus|jsonKey/.test(r.text));
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

  /* ============ 5b. Philosophy & Logic training structure (JSON = source of truth) ============ */
  console.log('\n[5ب] الفلسفة والمنطق — الترم → الموضوع → التدريب (من JSON)');
  {
    const cat = (await jfetch('/api/catalog')).data;
    const ph = cat.catalog.philosophy;
    const summarize = (term) => {
      const t = ph.terms.find(x => x.term === term);
      const topics = t.sections.flatMap(s => s.topics);
      const lessons = topics.flatMap(tp => tp.lessons);
      const trainings = lessons.flatMap(l => l.trainings);
      return { t, topics, lessons, trainings, q: trainings.reduce((n, tr) => n + tr.questionCount, 0) };
    };
    const s1 = summarize(1), s2 = summarize(2);
    const lessonsOf = (S, sec, no) => S.t.sections[sec].topics[no].lessons.map(l => l.title);
    ok('الترم الأول: الفلسفة موضوعان (التفكير الإنساني / الفلسفة وطبيعة الموقف الفلسفي) والمنطق موضوعان (مبادئ المنطق / الاستدلال)',
      s1.topics.length === 4 && s1.t.sections[0].topics.map(t => t.title).join('|') === 'التفكير الإنساني|الفلسفة وطبيعة الموقف الفلسفي' && s1.t.sections[1].topics.map(t => t.title).join('|') === 'مبادئ المنطق (الحدود - القضايا)|الاستدلال (تعريفه - أنواعه)');
    ok('الترم الأول: 19 درسًا بأسماء JSON الحقيقية (5+5 فلسفة، 8+1 منطق) / 30 تدريبًا', s1.lessons.length === 19 && lessonsOf(s1, 0, 0).join('|') === 'التفكير والنشاط العقلي|أساليب التفكير|مهارات التفكير الفلسفي|الفلسفة والدين|الفلسفة والعلم' && lessonsOf(s1, 0, 1).length === 5 && lessonsOf(s1, 1, 0).length === 8 && lessonsOf(s1, 1, 1).join('|') === 'القياس الأرسطي' && s1.trainings.length === 30);
    ok('كل درس يحمل اسمًا حقيقيًا (لا «الدرس N» عامًا) ورقمًا متسلسلًا', s1.lessons.concat(s2.lessons).every(l => l.title.trim() && !/^الدرس\s*(الأول|الثاني|الثالث|\d+)$/.test(l.title.trim())) && s1.topics.concat(s2.topics).every(tp => tp.lessons.every((l, i) => l.no === i + 1)));
    ok('الترم الثاني: الفلسفة موضوعان (البيئية والبيوطبية / المهنية والقيم) والمنطق موضوعان (الاستقراء / الاستنباط) — 11 درسًا',
      s2.topics.length === 4 && s2.t.sections[0].topics.map(t => t.title).join('|') === 'الفلسفة والأخلاق البيئية والبيوطبية|الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد' && s2.t.sections[1].topics.map(t => t.title).join('|') === 'الاستقراء وتطبيق المنهج التجريبي|الاستنباط وتطبيقه في العلوم الصورية' && s2.lessons.length === 11 && lessonsOf(s2, 0, 0).length === 3 && lessonsOf(s2, 0, 1).length === 2 && lessonsOf(s2, 1, 0).length === 3 && lessonsOf(s2, 1, 1).length === 3);
    ok('الترم الأول: 710 أسئلة في التدريبات (30 تدريبًا بأعداد JSON الفعلية 15–58)', s1.q === 710 && s1.trainings.length === 30 && s1.trainings.find(tr => tr.examId === 'T1-PH-RELIGION-01').questionCount === 15 && s1.trainings.find(tr => tr.examId === 'T1-PH-07-T2').questionCount === 34);
    ok('الترم الثاني: 14 تدريبًا / 319 سؤالًا (بأعداد JSON الفعلية)', s2.trainings.length === 14 && s2.q === 319 && s2.trainings.find(tr => tr.examId === 'T2-PH-BIO-01').questionCount === 21 && s2.trainings.find(tr => tr.examId === 'T2-PH-PRO-T2').questionCount === 20);
    const allTr = s1.trainings.concat(s2.trainings);
    ok('معرفات التدريبات فريدة ومستقرة (T1-PH-01 … T2-LG-AI — 44 تدريبًا)', new Set(allTr.map(tr => tr.examId)).size === 44 && allTr.every(tr => /^T[12]-(PH|LG)-/.test(tr.examId)));
    ok('كل تدريب ينتمي لدرس واحد فقط ولا يظهر تحت درس/موضوع آخر', [1, 2].every(term => { const seen = new Set(); return summarize(term).lessons.every(l => l.trainings.every(tr => !seen.has(tr.examId) && seen.add(tr.examId))); }));
    ok('metadata كل تدريب تطابق موضوعه ودرسه (topicKey/lessonKey/lessonTitle/trainingNo/count)', allTr.every(tr => { const e = cat.exams[tr.examId]; return e && e.type === 'training' && !e.legacy && e.count === tr.questionCount && e.title === tr.title; }) &&
      [1, 2].every(term => summarize(term).topics.every(tp => tp.lessons.every(l => l.trainings.every((tr, i) => { const e = cat.exams[tr.examId]; return e.topicKey === tp.key && e.topicTitle === tp.title && e.lessonKey === l.key && e.lessonNo === l.no && e.lessonTitle === l.title && e.trainingNo === i + 1; })))));
    ok('كل تدريب يحتفظ بـ training_id/الدرس/العنوان/عدد أسئلة JSON الفعلي (لا دمج ولا تحويل إلى label)', allTr.every(tr => BANKS.examDefs[tr.examId] && BANKS.examDefs[tr.examId].length === tr.questionCount && tr.questionCount >= 15));
    ok('الامتحانات الشاملة في قسم منفصل وليست تدريبات (ت1: PHI-COMP, LOG-COMP, PHLO-COMP · ت2: T2L-COMP, T2-TERM-COMP)',
      JSON.stringify(s1.t.comprehensiveExamIds) === JSON.stringify(['PHI-COMP', 'LOG-COMP', 'PHLO-COMP']) && JSON.stringify(s2.t.comprehensiveExamIds) === JSON.stringify(['T2L-COMP', 'T2-TERM-COMP']) &&
      s1.t.comprehensiveExamIds.concat(s2.t.comprehensiveExamIds).every(id => !allTr.some(tr => tr.examId === id)));
    ok('النماذج القديمة لا تظهر في الفهرس لكنها ما زالت قابلة للحل على الخادم (روابط/نتائج قديمة)', !JSON.stringify(ph).includes('PHI-C1-T1') && !!cat.exams['PHI-C1-T1'] && cat.exams['PHI-C1-T1'].legacy === true);
    // server side: each training = JSON question set (verbatim, same order), 4 options, valid key, no dups
    const fs2 = fs; const norm = (x) => String(x || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[«»"“”'’‘.،,:؛;\-–—…()\[\]؟?!]/g, ' ').replace(/\s+/g, ' ').trim();
    const stripL = (t) => { let o = String(t || ''), p = null; while (o !== p) { p = o; o = o.replace(/^\s*[\(（]?[أابجدهABCDabcd][\)）\]\s.\-–:：]+\s*/, '').trim(); } return o; };
    let jsonOk = true, det = [];
    // an empty JSON option is only usable when a documented restoreOptions entry supplies it
    const RESTORE = (JSON.parse(fs2.readFileSync(path.join(ROOT, 'data', 'key-decisions.json'), 'utf8')).restoreOptions) || {};
    const effOpts = (q) => (RESTORE[q.id] ? RESTORE[q.id].options : q.options);
    for (const term of [1, 2]) {
      const J = JSON.parse(fs2.readFileSync(path.join(ROOT, 'data', 'ExamManasa_Term' + term + '_Philosophy_Logic_ExamData.json'), 'utf8'));
      for (const t of J.training_exams) {
        const ids = BANKS.examDefs[t.training_id];
        const exp = t.questions.filter(q => effOpts(q).every(o => stripL(o)));
        if (!ids || ids.length !== exp.length || new Set(ids).size !== ids.length) { jsonOk = false; det.push(t.training_id + ':len'); continue; }
        exp.forEach((jq, i) => {
          const bq = BANKS.questions[ids[i]];
          if (!bq || norm(bq.text) !== norm(String(jq.question).replace(/^\s*[.\-–]\s+/, '')) || bq.options.length !== 4 || !'ABCD'.includes(bq.answer)) { jsonOk = false; det.push(t.training_id + ':q' + (i + 1)); }
        });
      }
    }
    ok('كل تدريب على الخادم = مجموعة أسئلة JSON نفسها بالترتيب نفسه، 4 خيارات ومفتاح صالح، بلا تكرار', jsonOk, det.slice(0, 5).join(', '));
    {
      const prodQ = [...new Set(allTr.flatMap(tr => BANKS.examDefs[tr.examId]))].map(id => BANKS.questions[id]);
      const allowed = new Set(['verified', 'needs-review']);
      ok('كل سؤال إنتاجي له verificationStatus صريح (verified أو needs-review) — لا مفاتيح مخمَّنة بلا وسم', prodQ.every(q => allowed.has(q.meta.verificationStatus)));
      const nr = prodQ.filter(q => q.meta.verificationStatus === 'needs-review' || q.meta.keyStatus === 'conflict-bank-key-kept').length;
      ok('الأسئلة غير المؤكدة موسومة needs-review وموثقة في AUDIT_PHILOSOPHY_TRAININGS.md (' + nr + ' من ' + prodQ.length + ')', nr < prodQ.length * 0.15 && fs.existsSync(path.join(ROOT, 'AUDIT_PHILOSOPHY_TRAININGS.md')));
    }
    // start a JSON training session: no keys, 20 questions, 4 options
    const st = await post('/api/exam/start', { examId: 'T1-LG-03', name: 'اختبار تدريب', phone: '01000000000', slug: 'mostafa' });
    ok('بدء تدريب JSON (T1-LG-03): 20 سؤالًا × 4 خيارات، بلا مفاتيح، الجلسة تحمل slug المعلم', st.status === 200 && st.data.questions.length === 20 && st.data.questions.every(q => q.options.length === 4 && JSON.stringify(Object.keys(q).sort()) === JSON.stringify(['id', 'no', 'options', 'text'])) && !JSON.stringify(st.data).includes('"answer"') && decodeToken(st.data.token).slug === 'mostafa' && st.data.exam.lessonTitle === 'الحدود المنطقية' && !('difficulty' in st.data.exam));
    const seed = decodeToken(st.data.token).seed;
    const sub = await post('/api/exam/submit', { token: st.data.token, answers: correctPositions('T1-LG-03', seed) });
    ok('تصحيح تدريب JSON على الخادم: الدرجة الكاملة 20/20', sub.status === 200 && sub.data.score === 20 && sub.data.percentage === 100);
    // psychology frozen (sha256 of catalog+exams+examDefs+questions vs pre-rebuild snapshot)
    const psyExams = Object.fromEntries(Object.entries(BANKS.exams).filter(([, e]) => e.subjectId === 'psychology').sort());
    const psyDefs = Object.fromEntries(Object.keys(psyExams).sort().map(id => [id, BANKS.examDefs[id]]));
    const psyQ = Object.fromEntries(Object.entries(BANKS.questions).filter(([, q]) => q.meta.subjectId === 'psychology').sort());
    const h = crypto.createHash('sha256').update(JSON.stringify({ catalog: BANKS.catalog.psychology, exams: psyExams, examDefs: psyDefs, questions: psyQ })).digest('hex');
    ok('علم النفس لم يتغير (sha256 مطابق للقطة ما قبل إعادة البناء)', h === '8851437be88724537693cbf1ad57c0531e36eca4b55dcea102f7c077b44a8198', h);
    ok('علم النفس: نفس واجهة الفهرس (6 وحدات × 4 موضوعات + شامل) دون أي حقول تدريبات', cat.catalog.psychology.units.length === 6 && cat.catalog.psychology.units.every(u => u.lessons.length === 4 && u.comprehensiveExamId) && !JSON.stringify(cat.catalog.psychology).includes('topicKey') && !Object.values(cat.exams).some(e => e.subjectId === 'psychology' && ('topicKey' in e || 'legacy' in e)));
  }

  /* ============ 6. perfect-score round-trip: ALL exams ============ */
  console.log('\n[6] دورة الدرجة الكاملة — كل الامتحانات (127)');
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
    ok(examIds.length + '/' + examIds.length + ' امتحانًا (بما فيها 44 تدريب JSON و47 نموذجًا قديمًا): الدرجة الكاملة صحيحة والتصحيح متطابق مع البنك', allOk && examIds.length === 127, badOnes.join(', '));
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
      specialty: 'مدرس الفلسفة والمنطق',
      colors: { primary: '#3a2a5a', accent: '#c9a86a' }, requirePhone: false, enabled: true
    }, { Cookie: cookie });
    ok('إنشاء معلم جديد', create.status === 200 && create.data.teacher.slug === 'sara');
    const publicProfile = await jfetch('/api/teacher/sara');
    ok('الملف العام للمعلمة يعمل', publicProfile.status === 200 && publicProfile.data.teacher.name.includes('سارة'));
    ok('تخصص المعلم يظهر في الملف العام (قسم المعلم في الرئيسية)',
      publicProfile.data.teacher.specialty === 'مدرس الفلسفة والمنطق');
    const updKeep = await jfetch('/api/admin/teachers/' + create.data.teacher.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: cookie },
      body: JSON.stringify({ name: 'أ. سارة أحمد', slug: 'sara', enabled: true, requirePhone: false })
    });
    ok('التعديل الجزئي يحافظ على التخصص والنبذة',
      updKeep.status === 200 && updKeep.data.teacher.specialty === 'مدرس الفلسفة والمنطق');
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
    ok('نظرة عامة: 127 امتحانًا / 1887 سؤالًا + توثيق التصحيحات + إحصاءات التدريبات',
      overview.data.exams === 127 && overview.data.questions === 1887 && overview.data.structure.philosophyTrainings.term1.trainings === 30 && overview.data.structure.philosophyTrainings.term2.trainings === 14 &&
      overview.data.audit.psychology.corrections.length === 8);
    const qs = await jfetch('/api/admin/questions?subject=philosophy&term=2&q=' + encodeURIComponent('البيئية'), { headers: { Cookie: cookie } });
    ok('بنك الأسئلة: بحث + مفاتيح للمسؤول فقط', qs.status === 200 && qs.data.questions.length > 0 && qs.data.questions[0].answer);
    const qsLogic = await jfetch('/api/admin/questions?subject=philosophy&term=2&q=' + encodeURIComponent('بيكون'), { headers: { Cookie: cookie } });
    ok('بنك أسئلة المنطق ت2: البحث يجد أسئلة بيكون', qsLogic.status === 200 && qsLogic.data.questions.length >= 20);
    const qsPublic = await jfetch('/api/admin/questions');
    ok('بنك الأسئلة محمي بدون جلسة', qsPublic.status === 401);
  }

  /* ============ 11. shuffle equivalence with GAS ============ */
  /* ============ 10b. تغيير كلمة مرور المسؤول ============ */
  console.log('\n[10b] تغيير كلمة مرور المسؤول');
  {
    const cookie2 = cookie;
    const wrongCur = await post('/api/admin/password', { current: 'not-the-password', next: 'NewPass-2026' }, { Cookie: cookie2, 'X-Requested-With': 'fetch' });
    ok('رفض كلمة المرور الحالية الخاطئة', wrongCur.status === 401);
    const tooShort = await post('/api/admin/password', { current: 'TestAdminPass-2026', next: 'short' }, { Cookie: cookie2, 'X-Requested-With': 'fetch' });
    ok('رفض كلمة مرور جديدة قصيرة', tooShort.status === 400);
    const ch = await post('/api/admin/password', { current: 'TestAdminPass-2026', next: 'TestAdminPass-2027' }, { Cookie: cookie2, 'X-Requested-With': 'fetch' });
    ok('تغيير كلمة المرور ناجح', ch.status === 200);
    const oldLogin = await post('/api/admin/login', { email: 'admin@test.local', password: 'TestAdminPass-2026' });
    ok('كلمة المرور القديمة لم تعد تعمل', oldLogin.status === 401);
    const newLogin = await post('/api/admin/login', { email: 'admin@test.local', password: 'TestAdminPass-2027' });
    ok('كلمة المرور الجديدة تعمل', newLogin.status === 200);
    const newCookie = (newLogin.headers.get('set-cookie') || '').split(';')[0];
    const back = await post('/api/admin/password', { current: 'TestAdminPass-2027', next: 'TestAdminPass-2026' }, { Cookie: newCookie, 'X-Requested-With': 'fetch' });
    ok('العودة لكلمة المرور الأصلية', back.status === 200);
  }

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

  /* ============ 12. attempt limits (server-side, race-safe) + phone normalization ============ */
  console.log('\n[12] حدود المحاولات (خادم + عدّاد ذري) وتوحيد الهاتف');
  {
    const mk = await post('/api/admin/teachers', { name: 'معلم محدود', slug: 'limited12', unlimited: false, maxAttempts: 2, requirePhone: true }, { Cookie: cookie });
    ok('إنشاء معلم بحد محاولات (2) + unlimited=false', mk.status === 200 && mk.data.teacher.unlimited === false && mk.data.teacher.maxAttempts === 2);
    const PH = '01055556666';
    const doAttempt = async () => {
      const st = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب محدود', phone: PH, slug: 'limited12' });
      if (st.status !== 200) return st;
      const seed = decodeToken(st.data.token).seed;
      const sub = await post('/api/exam/submit', { token: st.data.token, answers: correctPositions('U1-T1', seed) });
      return { status: sub.status, data: sub.data, start: st.data };
    };
    const a1 = await doAttempt();
    ok('المحاولة 1 تنجح + الاستجابة تعلن المتبقي قبل الاستهلاك (2/2)', a1.status === 200 && a1.start.attempts && a1.start.attempts.remaining === 2 && a1.start.attempts.limit === 2);
    const a2 = await doAttempt();
    ok('المحاولة 2 تنجح + المتبقي (1/2)', a2.status === 200 && a2.start.attempts.remaining === 1);
    const a3 = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب محدود', phone: PH, slug: 'limited12' });
    ok('بدء المحاولة 3 مرفوض مبكرًا (429)', a3.status === 429);
    // submit-time gate: a token issued before exhaustion must also be rejected
    const mk2 = await post('/api/admin/teachers', { name: 'محدود ب', slug: 'limited12b', unlimited: false, maxAttempts: 2, requirePhone: true }, { Cookie: cookie });
    const PH2 = '01077778888';
    const held = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب ب', phone: PH2, slug: 'limited12b' });
    for (let k = 0; k < 2; k++) {
      const s = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب ب', phone: PH2, slug: 'limited12b' });
      const sd = decodeToken(s.data.token).seed;
      await post('/api/exam/submit', { token: s.data.token, answers: correctPositions('U1-T1', sd) });
    }
    const heldSub = await post('/api/exam/submit', { token: held.data.token, answers: correctPositions('U1-T1', decodeToken(held.data.token).seed) });
    ok('التسليم بعد الاستنفاد مرفوض على الخادم (429) حتى بتوكن قديم', heldSub.status === 429);
    // concurrency: 6 parallel submits, limit 3 → exactly 3 pass (atomicity proof)
    const mk3 = await post('/api/admin/teachers', { name: 'محدود ج', slug: 'limited12c', unlimited: false, maxAttempts: 3, requirePhone: true }, { Cookie: cookie });
    const PH3 = '01099990000';
    const tokens = [];
    for (let k = 0; k < 6; k++) {
      const s = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب ج', phone: PH3, slug: 'limited12c' });
      tokens.push(s.data.token);
    }
    const parResults = await Promise.all(tokens.map(t => post('/api/exam/submit', { token: t, answers: correctPositions('U1-T1', decodeToken(t).seed) })));
    const okN = parResults.filter(r => r.status === 200).length;
    const rejN = parResults.filter(r => r.status === 429).length;
    ok('تزامن: 6 تسليمات متوازية بحد 3 → 3 ناجحة + 3 مرفوضة بالضبط (ذرية)', okN === 3 && rejN === 3, okN + '/' + rejN);
    // unlimited default unaffected
    const u = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب حر', phone: '01000000001', slug: 'mostafa' });
    ok('المعلم غير المحدود: بدء بلا حقل attempts', u.status === 200 && !('attempts' in u.data));
    // phone normalization: variants collapse to one canonical identity
    for (const v of ['+2 010-1234 5678', '00201012345678', '٠١٠١٢٣٤٥٦٧٨']) {
      const s = await post('/api/exam/start', { examId: 'T2P-C1-T1', name: 'طالب توحيد', phone: v });
      if (s.status !== 200) { ok('توحيد الهاتف: بدء بصيغة ' + v, false, 'status ' + s.status); break; }
      const sd = decodeToken(s.data.token).seed;
      await post('/api/exam/submit', { token: s.data.token, answers: correctPositions('T2P-C1-T1', sd) });
    }
    await new Promise(r => setTimeout(r, 800)); // waitUntil persist
    const res = await jfetch('/api/admin/results', { headers: { Cookie: cookie } });
    const mine = res.data.results.filter(r => r.name === 'طالب توحيد');
    ok('توحيد الهاتف: 3 صيغ → نفس الرقم المعياري في النتائج', mine.length === 3 && mine.every(r => r.phone === '01012345678'), JSON.stringify(mine.map(r => r.phone)));
    const badPh = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب', phone: '019123' });
    ok('رفض هاتف لا يطابق صيغة الموبايل المصري', badPh.status === 400);
    // cleanup
    for (const id of [mk.data.teacher.id, mk2.data.teacher.id, mk3.data.teacher.id]) {
      await jfetch('/api/admin/teachers/' + id, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Cookie: cookie } });
    }
  }

  /* ============ 13. offline mode (server contract) ============ */
  console.log('\n[13] وضع عدم الاتصال (عقد الخادم)');
  {
    const mk = await post('/api/admin/teachers', { name: 'معلم أوفلاين', slug: 'offline13', offlineMode: true }, { Cookie: cookie });
    ok('إنشاء معلم بوضع عدم الاتصال', mk.status === 200 && mk.data.teacher.offlineMode === true);
    const s = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب أوفلاين', phone: '01013131313', slug: 'offline13' });
    const tk = decodeToken(s.data.token);
    ok('جلسة الأوفلاين: offline.enabled + صلاحية 72 ساعة', s.status === 200 && s.data.offline && s.data.offline.enabled === true && (tk.exp - tk.iss) === 72 * 3600 && !isNaN(Date.parse(s.data.offline.expiresAt)));
    const s2 = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب عادي', phone: '01014141414', slug: 'mostafa' });
    const tk2 = decodeToken(s2.data.token);
    ok('الجلسة العادية: offline.enabled=false + صلاحية 6 ساعات', s2.data.offline && s2.data.offline.enabled === false && (tk2.exp - tk2.iss) === 6 * 3600);
    const sub = await post('/api/exam/submit', { token: s.data.token, answers: correctPositions('U1-T1', tk.seed) });
    ok('تسليم جلسة الأوفلاين يعمل (الإجابة دون اتصال + التسليم عند الاتصال)', sub.status === 200 && sub.data.score === 20);
    await jfetch('/api/admin/teachers/' + mk.data.teacher.id, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Cookie: cookie } });
  }

  /* ============ 14. teacher dashboard + registration/API security ============ */
  console.log('\n[14] لوحة المعلم وأمان التسجيل');
  {
    const mk = await post('/api/admin/teachers', { name: 'معلم اللوحة', slug: 'dash14', phone: '+20 011-2222 3333' }, { Cookie: cookie });
    ok('إنشاء معلم + توحيد هاتف المعلم للصيغة المعيارية', mk.status === 200 && mk.data.teacher.phone === '01122223333', mk.data.teacher && mk.data.teacher.phone);
    const dashId = mk.data.teacher.id;
    // submit 1: U1-T1 perfect (100) + submit 2: T2P-C1-T1 all-wrong (0)
    const s1 = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب لوحة 1', phone: '01015151515', slug: 'dash14' });
    await post('/api/exam/submit', { token: s1.data.token, answers: correctPositions('U1-T1', decodeToken(s1.data.token).seed) });
    const s2 = await post('/api/exam/start', { examId: 'T2P-C1-T1', name: 'طالب لوحة 2', phone: '01016161616', slug: 'dash14' });
    await post('/api/exam/submit', { token: s2.data.token, answers: wrongPositions('T2P-C1-T1', decodeToken(s2.data.token).seed) });
    await new Promise(r => setTimeout(r, 800)); // waitUntil persist
    const stats = await jfetch('/api/admin/teachers/' + dashId + '/stats', { headers: { Cookie: cookie } });
    ok('لوحة المعلم: إجماليات صحيحة (2 نتيجة / طالبان / متوسط 50 / نجاح 50%)',
      stats.status === 200 && stats.data.totals.results === 2 && stats.data.totals.students === 2 &&
      stats.data.totals.avgPercentage === 50 && stats.data.totals.passRate === 50);
    ok('تفصيل حسب الامتحان (امتحانان × محاولة) + الأحدث (2)',
      stats.data.perExam.length === 2 && stats.data.perExam.every(e => e.attempts === 1) && stats.data.recent.length === 2);
    const mkB = await post('/api/admin/teachers', { name: 'معلم عزل', slug: 'dash14b' }, { Cookie: cookie });
    const statsB = await jfetch('/api/admin/teachers/' + mkB.data.teacher.id + '/stats', { headers: { Cookie: cookie } });
    ok('عزل اللوحات: معلم آخر لا يرى نتائج الأول (0)', statsB.status === 200 && statsB.data.totals.results === 0);
    const noAuth = await jfetch('/api/admin/teachers/' + dashId + '/stats');
    ok('لوحة المعلم محمية بدون جلسة (401)', noAuth.status === 401);
    // disabled teacher: new sessions rejected
    await jfetch('/api/admin/teachers/' + mkB.data.teacher.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: cookie },
      body: JSON.stringify({ name: 'معلم عزل', slug: 'dash14b', enabled: false })
    });
    const disStart = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب', phone: '01017171717', slug: 'dash14b' });
    ok('رفض بدء جلسة جديدة لمعلم معطّل (403)', disStart.status === 403);
    // server ignores client-injected score (no localStorage/client trust)
    const v = await post('/api/exam/start', { examId: 'U1-T1', name: 'طالب حقن', phone: '01018181818', slug: 'mostafa' });
    const inj = await post('/api/exam/submit', { token: v.data.token, answers: wrongPositions('U1-T1', decodeToken(v.data.token).seed), score: 9999, percentage: 100, pass: true });
    ok('الخادم يتجاهل الدرجة المحقونة من العميل (صفر محسوب خادميًا)', inj.status === 200 && inj.data.score === 0 && inj.data.percentage === 0 && inj.data.pass === false);
    // no key leak on a NEW training session
    const rel = await post('/api/exam/start', { examId: 'T1-PH-RELIGION-01', name: 'طالب دين', phone: '01019191919', slug: 'mostafa' });
    ok('جلسة تدريب جديد (دين 15 سؤالًا): حقول السؤال نص/خيارات فقط بلا مفاتيح',
      rel.status === 200 && rel.data.questions.length === 15 &&
      rel.data.questions.every(q => JSON.stringify(Object.keys(q).sort()) === JSON.stringify(['id', 'no', 'options', 'text'])) &&
      !JSON.stringify(rel.data).includes('"answer"'));
    // cleanup
    for (const id of [dashId, mkB.data.teacher.id]) {
      await jfetch('/api/admin/teachers/' + id, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch', Cookie: cookie } });
    }
  }

  console.log('\n══════════════════════════════');
  console.log(`النتيجة: ${passed} ناجح ✓ / ${failed} فاشل ✗`);
} finally {
  proc.kill('SIGTERM');
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
