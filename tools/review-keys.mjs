/**
 * review-keys.mjs — يولّد REVIEW_ANSWER_KEYS.md: كل سؤال إنتاجي (الفلسفة والمنطق)
 * ما زال مفتاحه غير محسوم بدليل مصدر، مع النص + الخيارات + مفتاح الإنتاج +
 * مفتاح كتاب الأسئلة (JSON) + نوع الدليل. لا يغيّر أي بيانات.
 * الاستخدام: node tools/review-keys.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './gs-load.mjs';
import { loadTrainingJson } from './philo-trainings.mjs';

const B = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cloudflare/src/data/banks.json'), 'utf8'));
const { questions: Q, examDefs: D, exams: E } = B;
const jq = new Map();
for (const term of [1, 2]) for (const t of loadTrainingJson(REPO_ROOT, term).training_exams) for (const q of t.questions) jq.set(q.id, { tid: t.training_id, q });

const prod = new Set();
for (const e of Object.values(E)) if (e.subjectId === 'philosophy' && !e.legacy) D[e.id].forEach(id => prod.add(id));
const isOpen = id => Q[id].meta.verificationStatus === 'needs-review' || Q[id].meta.keyStatus === 'conflict-bank-key-kept';
const NR = [...prod].filter(isOpen).sort();
const refOf = id => jq.has(id) ? id : (Q[id].meta.trainingRefs || []).find(r => jq.has(r));
const esc = s => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');

const L = [];
L.push('# ملف مراجعة مفاتيح الإجابة — الفلسفة والمنطق (Production)', '',
  '> يُولَّد من `tools/review-keys.mjs`. **لم يُغيَّر أي مفتاح هنا.** لكل سؤال غير محسوم: النص + الخيارات + مفتاح الإنتاج الحالي + مفتاح كتاب الأسئلة (كما نُقل في JSON) + نوع الدليل — ليُحسم مقابل **نموذج الإجابة الرسمي / كتاب الشرح** فور وضعه في `data/sources/` وتسجيل القرار في `data/key-decisions.json`.', '',
  '## ما هو متاح وما هو ناقص', '',
  '| المصدر | الحالة داخل المستودع/بيئة العمل |', '|---|---|',
  '| كتاب الشرح الرسمي (أولى ثانوي — فلسفة ومنطق، ت1) | استُشيرت فصوله عبر نسخة الوزارة (رابط CDN في القرارات من نوع A)؛ غير مخزّن في المستودع |',
  '| نموذج الإجابة الرسمي | **مدمج في كتاب الأسئلة**: فقرات المفاتيح 7061+ (ت1) وسطور المفاتيح 2866+ (ت2) — تُنقل حرفيًا في `answer_key_text` |',
  '| كتاب الأسئلة الأصلي «كتاب اسئلة الترم الاول فلسفة ومنطق .docx» | **موجود** في `data/sources/` — استُخرجت منه كل الأسئلة والمفاتيح حرفيًا |',
  '| كتاب الأسئلة الأصلي «كتاب اسئلة فلسفة الترم التاني .docx» | **موجود** في `data/sources/` — استُخرجت منه كل الأسئلة والمفاتيح حرفيًا |',
  '| بنك الأسئلة الحالي (PhiloData.gs …) | موجود — مفاتيحه من تدقيق سابق (AUDIT_PHILOSOPHY*.md) بلا مرجع صفحة لكل سؤال |', '',
  `## الأسئلة غير المحسومة: ${NR.length}`, '',
  '| # | المعرف | التدريب | مفتاح الإنتاج (البنك) | مفتاح كتاب الأسئلة (JSON) | الدليل المتاح | النوع |', '|---|---|---|---|---|---|---|');
const rows = NR.map((id, i) => {
  const q = Q[id], { tid, q: j } = jq.get(refOf(id));
  const ev = 'answer_key_text' in j ? `answer_key_text=«${esc(j.answer_key_text)}»` : `answer_match_score=${j.answer_match_score}`;
  const kind = q.meta.keyStatus === 'conflict-bank-key-kept' ? 'تعارض بنك ↔ مفتاح الكتاب' : 'سؤال جديد — مفتاح الكتاب غير مطابق حرفيًا لأي خيار';
  L.push(`| ${i + 1} | ${id} | ${tid} | ${q.answer} — ${esc(q.options['ABCD'.indexOf(q.answer)])} | ${j.correct_option} — ${esc(j.correct_answer)} | ${ev} | ${kind} |`);
  return { i: i + 1, id, tid, q, j, ev };
});
L.push('', '## النصوص الكاملة (للمراجعة مقابل المصدر الرسمي)', '');
for (const r of rows) {
  L.push(`### ${r.i}. ${r.id} — ${r.tid} (${E[r.tid].lessonTitle})`, `**السؤال:** ${r.q.text}  `);
  r.q.options.forEach((o, k) => L.push(`- ${'ABCD'[k]}. ${o}`));
  L.push(`- **الإنتاج الآن:** ${r.q.answer}  ·  **مفتاح الكتاب (JSON):** ${r.j.correct_option}  ·  ${r.ev}`,
    '- **الحكم:** ☐ MATCH البنك  ☐ MATCH الكتاب  ☐ آخر: ___  — **دليل المصدر (صفحة/فقرة):** ___', '');
}
L.push('## سؤال ناقص الخيار (تمت استعادته — يُعرض للطالب)', '',
  '- **T1-PH-04-Q16** (الدرس: نشأة الفلسفة وتعريفاتها): «يؤكد كونفوشيوس…» — كان الخيار A فارغًا في كل النسخ (فقرة docx بلا نص)؛ استُعيد بقرار موثق في `data/key-decisions.json` تحت `restoreOptions` (A = أثينا، والمفتاح D = الشرق القديم: كتاب الوزارة ينص «كونفوشيوس في الصين» ضمن حكماء الشرق).', '',
  '## الامتحانات الشاملة', '', '| الامتحان | الأسئلة | مصدر أسئلته | غير محسوم |', '|---|---|---|---|');
for (const eid of ['PHI-COMP', 'LOG-COMP', 'PHLO-COMP', 'T2L-COMP', 'T2-TERM-COMP']) {
  const ids = D[eid], nr = ids.filter(isOpen), ac = ids.filter(i => Q[i].meta.authorCreated).length;
  L.push(`| ${eid} | ${ids.length} | بنك مُدقَّق${ac ? ' + ' + ac + ' مؤلَّف من المنهج' : ''} | ${nr.length}${nr.length ? ': ' + nr.join(', ') : ''} |`);
}
fs.writeFileSync(path.join(REPO_ROOT, 'REVIEW_ANSWER_KEYS.md'), L.join('\n') + '\n');
console.log('REVIEW_ANSWER_KEYS.md: ' + NR.length + ' open questions');
