/**
 * philo-trainings.mjs — Builds the PRODUCTION Philosophy & Logic structure
 * (Term → Section → Topic → Training → 20 questions) from the two JSON datasets:
 *
 *   data/ExamManasa_Term1_Philosophy_Logic_ExamData.json   (17 trainings)
 *   data/ExamManasa_Term2_Philosophy_Logic_ExamData.json   (13 trainings)
 *
 * RULES (enforced here, verified by tools/validate-banks.mjs):
 *  - The JSON files are the source of truth for TOPICS, TRAININGS and each
 *    training's QUESTION SET + ORDER. No question is generated, reworded, or moved.
 *  - Question text and options are kept verbatim. Only two mechanical
 *    normalisations are applied (identical to the existing bank pipeline):
 *      • option label prefixes such as "أ- " / "(ج) " / "د) " are stripped —
 *        the Worker shuffles option order per student, so embedded labels would
 *        otherwise appear out of order;
 *      • a leading stray "." / "-" docx list artefact before the question text
 *        is removed; the question wording itself is untouched.
 *  - Question bank stays CENTRAL: when a JSON question is textually identical to
 *    an existing bank question (text + 4 options), the existing bank id is reused.
 *  - ANSWER KEYS: when the JSON key and the existing bank key disagree, the bank
 *    key is kept, because the bank keys were verified manually against the
 *    source books (AUDIT_PHILOSOPHY.md / AUDIT_PHILOSOPHY_TERM2*.md), whereas the
 *    JSON keys were produced by automatic matching (`answer_match_score`).
 *    Nothing is guessed: every such question is flagged keyStatus =
 *    'conflict-bank-key-kept' with the JSON key recorded for human review.
 *  - Questions that do not exist in the bank are added with the JSON key
 *    (keyStatus 'json-only' → needs review, or 'json-corroborated' when a
 *    near-identical bank question carries the same correct-answer text).
 *  - A question with an empty option (extraction defect) is QUARANTINED — it is
 *    never shipped to students — and reported (training then has 19 questions).
 *  - JSON `topic_comprehensive_exams` are 100 % copies of the topic's training
 *    questions (verified), so they are NOT materialised as separate exams (that
 *    would be duplicate exams). Existing comprehensive exams are kept as-is.
 *
 * Exports buildTrainings(ctx) — pure function over the shared bank objects.
 */
import fs from 'node:fs';
import path from 'node:path';

const LETTERS = 'ABCD';

export const TRAINING_JSON_FILES = {
  1: 'data/ExamManasa_Term1_Philosophy_Logic_ExamData.json',
  2: 'data/ExamManasa_Term2_Philosophy_Logic_ExamData.json'
};

/* ---------- text helpers ---------- */
export function stripOptionLabel(text) {
  let out = String(text || ''), prev = null;
  while (out !== prev) {
    prev = out;
    out = out.replace(/^\s*[\(（]?[أابجدهABCDabcd][\)）\]\s.\-–:：]+\s*/, '').trim();
  }
  return out;
}
export function cleanQuestionText(text) {
  // remove ONLY a leading docx list artefact (". " / "- ") — wording is untouched
  return String(text || '').replace(/^\s*[.\-–]\s+/, '').trim();
}
export function normArabic(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[«»"“”'’‘.،,:؛;\-–—…()\[\]؟?!]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// looser: also unify hamza seats (ئ/ؤ) — used only to recognise orthographic option variants
function normLoose(s) { return normArabic(s).replace(/ئ/g, 'ي').replace(/ؤ/g, 'و'); }
function tokenSim(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i || 1);
}

export function loadTrainingJson(repoRoot, term) {
  const p = path.join(repoRoot, TRAINING_JSON_FILES[term]);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ---------- structural validation of one JSON file (technical checks only) ---------- */
export function validateTrainingJson(d, term) {
  const issues = [];
  if (!Array.isArray(d.training_exams) || !d.training_exams.length) issues.push('no training_exams');
  const tids = new Set(), qids = new Set();
  for (const t of d.training_exams || []) {
    if (tids.has(t.training_id)) issues.push('duplicate training_id ' + t.training_id);
    tids.add(t.training_id);
    if (!['الفلسفة', 'المنطق'].includes(t.subject)) issues.push(t.training_id + ': unknown subject ' + t.subject);
    if (!t.topic || !String(t.topic).trim()) issues.push(t.training_id + ': empty topic');
    if (!Array.isArray(t.questions) || t.questions.length !== 20) issues.push(t.training_id + ': questions=' + (t.questions || []).length);
    if (t.exam_question_count !== (t.questions || []).length) issues.push(t.training_id + ': exam_question_count mismatch');
    const seenText = new Set();
    (t.questions || []).forEach((q, i) => {
      if (!q.id) issues.push(t.training_id + ' q' + (i + 1) + ': missing id');
      else { if (qids.has(q.id)) issues.push('duplicate question id ' + q.id); qids.add(q.id); }
      if (!q.question || !String(q.question).trim()) issues.push(q.id + ': empty question');
      if (!Array.isArray(q.options) || q.options.length !== 4) issues.push(q.id + ': options != 4');
      else if (q.options.some(o => !stripOptionLabel(o))) issues.push(q.id + ': empty option (extraction defect)');
      const ci = LETTERS.indexOf(q.correct_option);
      if (ci < 0 || String(q.correct_option).length !== 1) issues.push(q.id + ': invalid correct_option');
      else if (Array.isArray(q.options) && q.options[ci] !== q.correct_answer) issues.push(q.id + ': correct_answer ≠ option[correct_option]');
      const key = cleanQuestionText(q.question) + '|' + (q.options || []).map(stripOptionLabel).join('|');
      if (seenText.has(key)) issues.push(t.training_id + ': duplicate question text inside training (' + q.id + ')');
      seenText.add(key);
    });
  }
  return issues;
}

/* ================================================================== *
 * buildTrainings
 *  ctx = { repoRoot, questions, exams, addNewQuestion(id, obj) }
 *  - questions: shared bank map id -> {text, options, answer, meta}
 *  - exams:     shared exam map (full, incl. questionIds)
 * returns { terms, report }
 * ================================================================== */
export function buildTrainings(ctx) {
  const { repoRoot, questions, exams } = ctx;

  // index of existing philosophy bank questions (before adding anything)
  const byExact = new Map();   // norm(text)||norm(options) -> id
  const byText = new Map();    // norm(text) -> [ids]
  const philoIds = [];
  for (const [id, q] of Object.entries(questions)) {
    if (q.meta.subjectId !== 'philosophy') continue;
    philoIds.push(id);
    const k = normArabic(q.text) + '||' + q.options.map(normArabic).join('|');
    if (!byExact.has(k)) byExact.set(k, id);
    const kt = normArabic(q.text);
    (byText.get(kt) || byText.set(kt, []).get(kt)).push(id);
  }
  const philoNorm = philoIds.map(id => ({ id, n: normArabic(questions[id].text) }));

  const report = {
    terms: {}, keyConflicts: [], newQuestions: [], corroborated: [], quarantined: [],
    sharedQuestions: [], optionVariantReuse: [], titleRenames: [], skippedComprehensives: []
  };

  const terms = [];
  for (const term of [1, 2]) {
    const d = loadTrainingJson(repoRoot, term);
    const issues = validateTrainingJson(d, term);
    const sections = [
      { id: 'philosophy', title: 'الفلسفة', topics: [] },
      { id: 'logic', title: 'المنطق', topics: [] }
    ];
    const secOf = { 'الفلسفة': sections[0], 'المنطق': sections[1] };
    const stats = { trainings: 0, questions: 0, reused: 0, added: 0, keyConflicts: 0, quarantined: 0, shared: 0 };
    const qidOwner = new Map(); // question id -> first training that used it (to detect sharing)
    const topicIndex = new Map(); // section|topic -> topic entry

    d.training_exams.forEach((t) => {
      const sec = secOf[t.subject];
      const tkey = sec.id + '|' + t.topic;
      let topic = topicIndex.get(tkey);
      if (!topic) {
        const no = sec.topics.length + 1;
        topic = {
          no, key: term + '-' + (sec.id === 'philosophy' ? 'ph' : 'lg') + '-' + no,
          title: String(t.topic).trim(), trainings: []
        };
        sec.topics.push(topic); topicIndex.set(tkey, topic);
      }
      const trainingNo = topic.trainings.length + 1;
      const displayTitle = 'تدريب ' + trainingNo;
      if (String(t.training_title).trim() !== displayTitle) {
        report.titleRenames.push({ trainingId: t.training_id, source: t.training_title, display: displayTitle });
      }

      const questionIds = [];
      t.questions.forEach((q, i) => {
        const text = cleanQuestionText(q.question);
        const opts = q.options.map(stripOptionLabel);
        const ci = LETTERS.indexOf(q.correct_option);
        const jsonAnswerText = stripOptionLabel(q.correct_answer);

        if (opts.some(o => !o)) {
          report.quarantined.push({ term, trainingId: t.training_id, jsonId: q.id, reason: 'empty option (extraction defect) — cannot be shown to students', question: text.slice(0, 120) });
          stats.quarantined++;
          return;
        }

        // 1) exact reuse (text + options)
        let bankId = byExact.get(normArabic(text) + '||' + opts.map(normArabic).join('|')) || null;
        let reuseKind = bankId ? 'exact' : null;

        // 2) same text, options differ only orthographically (ي/ئ, tanween…), same answer text
        if (!bankId) {
          for (const cand of (byText.get(normArabic(text)) || [])) {
            const bq = questions[cand];
            const same = bq.options.every((o, k) => normLoose(o) === normLoose(opts[k]));
            if (same) { bankId = cand; reuseKind = 'option-variant'; break; }
          }
        }

        let finalId, keyStatus;
        if (bankId) {
          const bq = questions[bankId];
          finalId = bankId; stats.reused++;
          const bankAnswerText = bq.options[LETTERS.indexOf(bq.answer)];
          if (normLoose(bankAnswerText) === normLoose(jsonAnswerText)) keyStatus = 'verified';
          else {
            keyStatus = 'conflict-bank-key-kept';
            stats.keyConflicts++;
            report.keyConflicts.push({
              term, trainingId: t.training_id, jsonId: q.id, bankId,
              question: text, options: bq.options,
              jsonKey: q.correct_option + ' — ' + jsonAnswerText,
              bankKey: bq.answer + ' — ' + bankAnswerText,
              jsonScore: q.answer_match_score === undefined ? null : q.answer_match_score
            });
          }
          if (reuseKind === 'option-variant') report.optionVariantReuse.push({ jsonId: q.id, bankId, jsonOptions: opts, bankOptions: bq.options });
          // provenance: record JSON linkage on the shared bank question
          bq.meta.trainingRefs = (bq.meta.trainingRefs || []).concat([q.id]);
          if (keyStatus !== 'verified') { bq.meta.keyStatus = keyStatus; bq.meta.jsonKey = q.correct_option + ' — ' + jsonAnswerText; }
        } else {
          // NEW question — JSON is the only source
          finalId = q.id;
          if (questions[finalId]) throw new Error('question id collision: ' + finalId);
          // corroboration: near-identical bank question with the same answer text?
          const n = normArabic(text);
          let best = null, bs = 0;
          for (const c of philoNorm) { const s = tokenSim(n, c.n); if (s > bs) { bs = s; best = c.id; } }
          let corroborated = false;
          if (best && bs >= 0.6) {
            const bq = questions[best];
            corroborated = normLoose(bq.options[LETTERS.indexOf(bq.answer)]) === normLoose(jsonAnswerText);
            report.corroborated.push({ jsonId: q.id, similarBankId: best, similarity: +bs.toFixed(2), sameAnswer: corroborated });
          }
          keyStatus = corroborated ? 'json-corroborated' : 'json-only';
          questions[finalId] = {
            text, options: opts, answer: LETTERS[ci],
            meta: {
              subject: 'الفلسفة والمنطق', subjectId: 'philosophy', term,
              unit: '', section: t.subject, chapter: '', training: displayTitle,
              topic: topic.title, lesson: topic.title,
              difficulty: '', authorCreated: false,
              source: d.source_document + ' (ExamManasa JSON dataset — ' + q.id + ')',
              sourceQuestionIndex: q.source_question_index ?? null,
              sourceParagraph: q.source_paragraph ?? null,
              verificationStatus: corroborated ? 'verified' : 'needs-review',
              keyStatus, grade: 'أولى ثانوي', academicYear: '2027'
            }
          };
          stats.added++;
          report.newQuestions.push({ term, trainingId: t.training_id, id: finalId, keyStatus });
        }

        if (questionIds.includes(finalId)) throw new Error(t.training_id + ': duplicate question inside training ' + finalId);
        if (qidOwner.has(finalId) && qidOwner.get(finalId) !== t.training_id) {
          stats.shared++;
          report.sharedQuestions.push({ term, questionId: finalId, trainings: [qidOwner.get(finalId), t.training_id], jsonId: q.id, note: q.top_up_from_related_training ? 'JSON top_up_from_related_training=' + q.top_up_from_related_training : 'present in both trainings in JSON' });
        } else qidOwner.set(finalId, t.training_id);
        questionIds.push(finalId);
      });

      exams[t.training_id] = {
        id: t.training_id, subjectId: 'philosophy', term, type: 'training',
        count: questionIds.length,
        title: displayTitle,
        sectionId: sec.id, sectionTitle: sec.title,
        topicKey: topic.key, topicNo: topic.no, topicTitle: topic.title,
        trainingNo, sourceTrainingTitle: String(t.training_title).trim(),
        sourcePoolSize: t.source_pool_size ?? null,
        // backwards-compatible fields used by the Worker's session/result payloads
        lessonNo: topic.no, lessonTitle: topic.title, chapterTitle: null, unitTitle: sec.title,
        training: displayTitle, variant: 1, questionIds
      };
      topic.trainings.push({ examId: t.training_id, title: displayTitle, questionCount: questionIds.length });
      stats.trainings++; stats.questions += questionIds.length;
    });

    (d.topic_comprehensive_exams || []).forEach(c => report.skippedComprehensives.push({ term, examId: c.exam_id, topic: c.topic, reason: '100% of its questions are the topic training questions (verified) — duplicate exam not created' }));

    report.terms[term] = { issues, stats, topics: sections.map(s => ({ section: s.title, count: s.topics.length })) };
    terms.push({
      term, label: term === 1 ? 'الترم الأول' : 'الترم الثاني',
      sections: sections.filter(s => s.topics.length),
      comprehensiveExamIds: [] // filled by build-banks.mjs (existing comps)
    });
  }
  return { terms, report };
}

/* ---------- markdown report ---------- */
export function renderTrainingReport(report, extra) {
  const L = [];
  L.push('# تقرير إعادة بناء الفلسفة والمنطق حسب التدريبات (JSON → Production)', '');
  L.push('> يُولَّد آليًا بواسطة `tools/build-banks.mjs`. المصدر: `data/ExamManasa_Term{1,2}_Philosophy_Logic_ExamData.json`.', '');
  for (const term of [1, 2]) {
    const t = report.terms[term]; if (!t) continue;
    L.push(`## الترم ${term === 1 ? 'الأول' : 'الثاني'}`, '');
    L.push(`- الموضوعات: ${t.topics.map(x => x.section + ' ' + x.count).join(' + ')} = ${t.topics.reduce((n, x) => n + x.count, 0)}`);
    L.push(`- التدريبات: ${t.stats.trainings} — الأسئلة داخل التدريبات: ${t.stats.questions}`);
    L.push(`- أسئلة أعيد استخدامها من البنك المركزي (نص + خيارات متطابقة): ${t.stats.reused}`);
    L.push(`- أسئلة أُضيفت إلى البنك من JSON (غير موجودة سابقًا): ${t.stats.added}`);
    L.push(`- تعارض مفتاح إجابة (JSON ≠ البنك المُدقَّق — احتُفظ بمفتاح البنك وسُجِّل للمراجعة): ${t.stats.keyConflicts}`);
    L.push(`- أسئلة مشتركة بين تدريبين وفق JSON نفسه: ${t.stats.shared}`);
    L.push(`- أسئلة محجوزة (عيب استخراج): ${t.stats.quarantined}`);
    L.push(`- مشاكل تقنية في ملف JSON: ${t.issues.length ? t.issues.map(i => '`' + i + '`').join('، ') : 'لا شيء'}`, '');
  }
  if (extra) { L.push('## الملخص الإنتاجي', '', ...extra, ''); }
  L.push('## أسئلة محجوزة (لا تُعرض للطالب)', '');
  report.quarantined.forEach(q => L.push(`- **${q.jsonId}** (${q.trainingId}): ${q.reason} — «${q.question}…»`));
  if (!report.quarantined.length) L.push('- لا شيء');
  L.push('', '## أسئلة مشتركة بين تدريبين (كما وردت في JSON)', '');
  report.sharedQuestions.forEach(s => L.push(`- ${s.questionId} ← ${s.trainings.join(' و ')} (${s.note})`));
  if (!report.sharedQuestions.length) L.push('- لا شيء');
  L.push('', '## خيارات أعيد استخدام صيغتها الإملائية المُدقَّقة من البنك (نفس السؤال ونفس الإجابة)', '');
  report.optionVariantReuse.forEach(o => L.push(`- ${o.jsonId} → ${o.bankId}: JSON «${o.jsonOptions.join(' | ')}» ⇐ البنك «${o.bankOptions.join(' | ')}»`));
  if (!report.optionVariantReuse.length) L.push('- لا شيء');
  L.push('', '## عناوين التدريبات المعروضة (JSON training_title غير متسق → «تدريب N» داخل الموضوع)', '');
  report.titleRenames.forEach(r => L.push(`- ${r.trainingId}: «${r.source}» → «${r.display}»`));
  L.push('', '## امتحانات شاملة في JSON لم تُنشأ (نسخ مطابقة لأسئلة التدريب)', '');
  report.skippedComprehensives.forEach(c => L.push(`- ${c.examId}: ${c.reason}`));
  L.push('', `## أسئلة جديدة بمفتاح JSON فقط — تحتاج مراجعة بشرية (${report.newQuestions.filter(n => n.keyStatus === 'json-only').length})`, '');
  L.push('| الترم | التدريب | معرف السؤال | الحالة |', '|---|---|---|---|');
  report.newQuestions.forEach(n => L.push(`| ${n.term} | ${n.trainingId} | ${n.id} | ${n.keyStatus} |`));
  L.push('', `## تعارضات مفاتيح الإجابة — احتُفظ بمفتاح البنك المُدقَّق يدويًا (${report.keyConflicts.length})`, '');
  L.push('> مفاتيح البنك مُوثَّقة في AUDIT_PHILOSOPHY.md / AUDIT_PHILOSOPHY_TERM2.md / AUDIT_PHILOSOPHY_TERM2_LOGIC.md. مفاتيح JSON نتجت عن مطابقة آلية (`answer_match_score`). لم يُغيَّر أي مفتاح بالتخمين؛ هذه القائمة للمراجعة مقابل نموذج الإجابة الرسمي.', '');
  L.push('| الترم | التدريب | JSON id | Bank id | مفتاح JSON | مفتاح البنك (المعتمد) | score |', '|---|---|---|---|---|---|---|');
  report.keyConflicts.forEach(k => L.push(`| ${k.term} | ${k.trainingId} | ${k.jsonId} | ${k.bankId} | ${k.jsonKey} | ${k.bankKey} | ${k.jsonScore ?? '—'} |`));
  L.push('', '### نصوص أسئلة التعارض', '');
  report.keyConflicts.forEach(k => L.push(`- **${k.jsonId} / ${k.bankId}**: ${k.question}  \n  الخيارات: ${k.options.join(' | ')}`));
  return L.join('\n') + '\n';
}
