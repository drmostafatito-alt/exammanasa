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

/* ------------------------------------------------------------------ *
 * OFFICIAL TOPIC MAPPING (2 topics per section per term)
 * Source: official curriculum chapters (كتاب الشرح — same titles the legacy
 * catalog used and that verified bank questions carry in meta.chapter).
 * A JSON "topic" is a LESSON; it is assigned to its official topic by
 *  (a) the chapter tag of the verified bank questions reused inside the
 *      training, and (b) the source-document paragraph order for trainings
 *      whose questions were JSON-only. Nothing here is invented: lesson
 *      titles are the JSON topic strings verbatim.
 * ------------------------------------------------------------------ */
export const OFFICIAL_TOPICS = {
  1: {
    philosophy: [
      { no: 1, title: 'التفكير الإنساني', trainingIds: ['T1-PH-01', 'T1-PH-02', 'T1-PH-03'] },
      { no: 2, title: 'الفلسفة وطبيعة الموقف الفلسفي', trainingIds: ['T1-PH-04', 'T1-PH-05', 'T1-PH-06', 'T1-PH-07', 'T1-PH-08'] }
    ],
    logic: [
      { no: 1, title: 'مبادئ المنطق (الحدود - القضايا)', trainingIds: ['T1-LG-01', 'T1-LG-02', 'T1-LG-03', 'T1-LG-04', 'T1-LG-05', 'T1-LG-06', 'T1-LG-07', 'T1-LG-08'] },
      { no: 2, title: 'الاستدلال (تعريفه - أنواعه)', trainingIds: ['T1-LG-09'] }
    ]
  },
  2: {
    philosophy: [
      { no: 1, title: 'الفلسفة والأخلاق البيئية والبيوطبية', trainingIds: ['T2-PH-ENV-01', 'T2-PH-ENV-02', 'T2-PH-BIO-01', 'T2-PH-MED-01'] },
      { no: 2, title: 'الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد', trainingIds: ['T2-PH-PRO-01', 'T2-PH-VAL-01', 'T2-PH-VAL-02'] }
    ],
    logic: [
      { no: 1, title: 'الاستقراء وتطبيق المنهج التجريبي', trainingIds: ['T2-LG-IND-01', 'T2-LG-BACON', 'T2-LG-MODERN'] },
      { no: 2, title: 'الاستنباط وتطبيقه في العلوم الصورية', trainingIds: ['T2-LG-DED-01', 'T2-LG-DED-02', 'T2-LG-AI'] }
    ]
  }
};

/* Evidence-based key status for a JSON question (never a guess):
 *  - Term 1 carries answer_match_score (1.0 = answer text found verbatim in the
 *    source answer key); Term 2 carries answer_key_text (the source key text).
 *  Returns { status, note }:
 *    'source-exact'  : source key text == chosen option           → verified
 *    'source-near'   : score ≥ 0.9 / key text is a prefix variant → verified (near)
 *    'source-other'  : source key text names a DIFFERENT option    → source wins
 *    'unverified'    : key text matches no option / low score      → needs review */
export function jsonKeyEvidence(q) {
  const opts = q.options.map(o => normLoose(stripOptionLabel(o)));
  const ci = LETTERS.indexOf(q.correct_option);
  const chosen = opts[ci];
  if (q.answer_key_text !== undefined) {
    const akt = normLoose(stripOptionLabel(q.answer_key_text));
    if (akt && akt === chosen) return { status: 'source-exact' };
    const other = opts.findIndex((o, k) => k !== ci && o && o === akt);
    if (other >= 0) return { status: 'source-other', sourceOption: LETTERS[other], note: 'answer_key_text = «' + q.answer_key_text + '»' };
    if (akt && chosen && (akt.startsWith(chosen) || chosen.startsWith(akt))) return { status: 'source-near', note: 'answer_key_text = «' + q.answer_key_text + '»' };
    return { status: 'unverified', note: 'answer_key_text = «' + q.answer_key_text + '» لا يطابق أي خيار' };
  }
  const sc = q.answer_match_score;
  if (sc === 1) return { status: 'source-exact' };
  if (sc >= 0.9) return { status: 'source-near', note: 'answer_match_score = ' + sc };
  return { status: 'unverified', note: 'answer_match_score = ' + sc };
}

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

/* ------------------------------------------------------------------ *
 * data/key-decisions.json — human decisions backed by an official source.
 * { "decisions": { "<questionId|jsonId>": { "answer": "B", "source": "كتاب الشرح ص 41", "note": "" } },
 *   "restoreOptions": { "<jsonId>": { "options": ["…","…","…","…"], "source": "كتاب الأسئلة ص 12" } } }
 * Every entry MUST carry a non-empty `source`; entries without one are rejected.
 * ------------------------------------------------------------------ */
export function loadKeyDecisions(repoRoot) {
  const p = path.join(repoRoot, 'data/key-decisions.json');
  if (!fs.existsSync(p)) return { decisions: {}, restoreOptions: {} };
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [id, v] of Object.entries(d.decisions || {})) {
    if (!/^[ABCD]$/.test(v.answer || '') || !String(v.source || '').trim()) throw new Error('key-decisions: ' + id + ' needs answer A-D and a non-empty source');
  }
  for (const [id, v] of Object.entries(d.restoreOptions || {})) {
    if (!Array.isArray(v.options) || v.options.length !== 4 || v.options.some(o => !String(o || '').trim()) || !String(v.source || '').trim()) throw new Error('key-decisions.restoreOptions: ' + id + ' needs 4 non-empty options and a source');
  }
  return { decisions: d.decisions || {}, restoreOptions: d.restoreOptions || {} };
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
    sharedQuestions: [], optionVariantReuse: [], titleRenames: [], skippedComprehensives: [], sourceOverrides: []
  };

  const KD = loadKeyDecisions(repoRoot);
  report.decisionsApplied = [];
  const terms = [];
  for (const term of [1, 2]) {
    const d = loadTrainingJson(repoRoot, term);
    const issues = validateTrainingJson(d, term);
    const sections = [
      { id: 'philosophy', title: 'الفلسفة', topics: [] },
      { id: 'logic', title: 'المنطق', topics: [] }
    ];
    const secOf = { 'الفلسفة': sections[0], 'المنطق': sections[1] };
    const stats = { trainings: 0, questions: 0, reused: 0, added: 0, keyConflicts: 0, quarantined: 0, shared: 0, sourceOverrides: 0 };
    const qidOwner = new Map(); // question id -> first training that used it (to detect sharing)
    const lessonIndex = new Map(); // topicKey|lessonTitle -> lesson entry
    // official 2-topic skeleton
    const topicOfTraining = new Map();
    sections.forEach(sec => {
      OFFICIAL_TOPICS[term][sec.id].forEach(ot => {
        const topic = { no: ot.no, key: term + '-' + (sec.id === 'philosophy' ? 'ph' : 'lg') + '-' + ot.no, title: ot.title, lessons: [] };
        sec.topics.push(topic);
        ot.trainingIds.forEach(id => topicOfTraining.set(id, { sec, topic }));
      });
    });
    const unmapped = d.training_exams.filter(t => !topicOfTraining.has(t.training_id)).map(t => t.training_id);
    if (unmapped.length) throw new Error('term ' + term + ': trainings not mapped to an official topic: ' + unmapped.join(', '));
    d.training_exams.forEach(t => { if (topicOfTraining.get(t.training_id).sec !== secOf[t.subject]) throw new Error(t.training_id + ': official topic section ≠ JSON subject'); });

    d.training_exams.forEach((t) => {
      const { sec, topic } = topicOfTraining.get(t.training_id);
      const lkey = topic.key + '|' + String(t.topic).trim();
      let lesson = lessonIndex.get(lkey);
      if (!lesson) {
        const no = topic.lessons.length + 1;
        lesson = { no, key: topic.key + '-' + no, title: String(t.topic).trim(), trainings: [] };
        topic.lessons.push(lesson); lessonIndex.set(lkey, lesson);
      }
      const trainingNo = lesson.trainings.length + 1;
      const displayTitle = 'تدريب ' + trainingNo;
      if (String(t.training_title).trim() !== displayTitle) {
        report.titleRenames.push({ trainingId: t.training_id, source: t.training_title, display: displayTitle });
      }

      const questionIds = [];
      t.questions.forEach((q, i) => {
        const text = cleanQuestionText(q.question);
        let opts = q.options.map(stripOptionLabel);
        if (KD.restoreOptions[q.id]) {
          const ro = KD.restoreOptions[q.id];
          // only an EMPTY option may be restored; non-empty options must stay verbatim
          opts.forEach((o, k) => { if (o && normLoose(o) !== normLoose(stripOptionLabel(ro.options[k]))) throw new Error('restoreOptions ' + q.id + ': option ' + LETTERS[k] + ' differs from JSON — only empty options may be restored'); });
          opts = ro.options.map(stripOptionLabel);
          report.decisionsApplied.push({ term, trainingId: t.training_id, id: q.id, kind: 'restoreOption', source: ro.source });
        }
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
            // JSON disagrees with the manually verified bank key. Decide by SOURCE evidence:
            //  - source key text names the BANK option → bank confirmed by source (verified)
            //  - source key text names the JSON option verbatim → genuine source-vs-bank conflict → bank kept, needs review
            //  - otherwise JSON key is an automated fuzzy guess → bank kept (verified against the bank audit)
            const ev = jsonKeyEvidence(q);
            const bankIdx = LETTERS.indexOf(bq.answer);
            const sourceNamesBank = ev.status === 'source-other' && ev.sourceOption === bq.answer;
            if (sourceNamesBank) keyStatus = 'bank-confirmed-by-source';
            else if (ev.status === 'source-exact') keyStatus = 'conflict-bank-key-kept';
            else keyStatus = 'bank-key-kept-json-unverified';
            stats.keyConflicts++;
            report.keyConflicts.push({
              term, trainingId: t.training_id, jsonId: q.id, bankId, status: keyStatus,
              question: text, options: bq.options,
              jsonKey: q.correct_option + ' — ' + jsonAnswerText,
              bankKey: bq.answer + ' — ' + bankAnswerText,
              jsonScore: q.answer_match_score === undefined ? null : q.answer_match_score,
              evidence: ev.status, note: ev.note || ''
            });
            void bankIdx;
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
          const ev = jsonKeyEvidence(q);
          let answer = LETTERS[ci];
          if (ev.status === 'source-other') {
            // the source answer key names a different option than JSON's correct_option → source wins (documented)
            answer = ev.sourceOption; stats.sourceOverrides++;
            report.sourceOverrides.push({ term, trainingId: t.training_id, id: q.id, jsonOption: q.correct_option, sourceOption: ev.sourceOption, note: ev.note, question: text });
          }
          keyStatus = ev.status === 'source-exact' || ev.status === 'source-near' || ev.status === 'source-other'
            ? (corroborated ? 'json-source-corroborated' : 'json-source')
            : (corroborated ? 'json-corroborated' : 'json-only');
          questions[finalId] = {
            text, options: opts, answer,
            meta: {
              subject: 'الفلسفة والمنطق', subjectId: 'philosophy', term,
              unit: '', section: t.subject, chapter: '', training: displayTitle,
              topic: topic.title, lesson: topic.title,
              difficulty: '', authorCreated: false,
              source: d.source_document + ' (ExamManasa JSON dataset — ' + q.id + ')',
              sourceQuestionIndex: q.source_question_index ?? null,
              sourceParagraph: q.source_paragraph ?? null,
              verificationStatus: (keyStatus === 'json-only') ? 'needs-review' : 'verified',
              keyStatus, keyEvidence: ev.status, keyNote: ev.note || '', grade: 'أولى ثانوي', academicYear: '2027'
            }
          };
          stats.added++;
          report.newQuestions.push({ term, trainingId: t.training_id, id: finalId, keyStatus, evidence: ev.status, note: ev.note || '' });
        }

        // human decision backed by an official source overrides everything (documented)
        const dec = KD.decisions[finalId] || KD.decisions[q.id];
        if (dec) {
          const bq = questions[finalId];
          bq.answer = dec.answer;
          bq.meta.verificationStatus = 'verified';
          bq.meta.keyStatus = 'official-source-decision';
          bq.meta.keySource = dec.source; if (dec.note) bq.meta.keyNote = dec.note;
          report.decisionsApplied.push({ term, trainingId: t.training_id, id: finalId, kind: 'answer', answer: dec.answer, source: dec.source });
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
        lessonKey: lesson.key, lessonNo: lesson.no, lessonTitle: lesson.title,
        trainingNo, sourceTrainingTitle: String(t.training_title).trim(),
        sourcePoolSize: t.source_pool_size ?? null,
        // backwards-compatible fields used by the Worker's session/result payloads
        chapterTitle: topic.title, unitTitle: sec.title,
        training: displayTitle, variant: 1, questionIds
      };
      lesson.trainings.push({ examId: t.training_id, title: displayTitle, questionCount: questionIds.length });
      stats.trainings++; stats.questions += questionIds.length;
    });

    (d.topic_comprehensive_exams || []).forEach(c => report.skippedComprehensives.push({ term, examId: c.exam_id, topic: c.topic, reason: '100% of its questions are the topic training questions (verified) — duplicate exam not created' }));

    report.terms[term] = { issues, stats, topics: sections.map(s => ({ section: s.title, count: s.topics.length, lessons: s.topics.reduce((n, tp) => n + tp.lessons.length, 0) })), structure: sections };
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
    L.push(`- الموضوعات الرسمية: ${t.topics.map(x => x.section + ' ' + x.count).join(' + ')} = ${t.topics.reduce((n, x) => n + x.count, 0)} — الدروس: ${t.topics.map(x => x.section + ' ' + x.lessons).join(' + ')}`);
    t.structure.forEach(sec => sec.topics.forEach(tp => {
      L.push(`  - ${sec.title} / الموضوع ${tp.no}: ${tp.title}`);
      tp.lessons.forEach(l => L.push(`    - الدرس ${l.no} — ${l.title}: ${l.trainings.map(tr => tr.examId + ' (' + tr.questionCount + ')').join('، ')}`));
    }));
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
  L.push('', `## قرارات بشرية مدعومة بمصدر رسمي (data/key-decisions.json) (${(report.decisionsApplied || []).length})`, '');
  (report.decisionsApplied || []).forEach(x => L.push(`- ${x.id} (${x.trainingId}): ${x.kind === 'answer' ? 'المفتاح → ' + x.answer : 'استعادة خيار ناقص'} — المصدر: ${x.source}`));
  if (!(report.decisionsApplied || []).length) L.push('- لا شيء بعد — انظر REVIEW_ANSWER_KEYS.md');
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
  L.push('', `## تصحيحات مفاتيح مدعومة بالمصدر (نص مفتاح الإجابة في المصدر يسمّي خيارًا غير correct_option في JSON) (${report.sourceOverrides.length})`, '');
  report.sourceOverrides.forEach(o => L.push(`- **${o.id}** (${o.trainingId}): JSON ${o.jsonOption} → المصدر ${o.sourceOption} — ${o.note}  \n  «${o.question}»`));
  if (!report.sourceOverrides.length) L.push('- لا شيء');
  const nq = report.newQuestions;
  L.push('', `## أسئلة أُضيفت من JSON (${nq.length}) — التحقق من المفتاح حسب دليل المصدر`, '');
  L.push(`- مطابقة حرفية لنص مفتاح المصدر: ${nq.filter(n => n.evidence === 'source-exact').length}`);
  L.push(`- مطابقة قريبة (score ≥ 0.9 أو اختلاف لاحقة/بادئة): ${nq.filter(n => n.evidence === 'source-near').length}`);
  L.push(`- صُحح حسب مفتاح المصدر: ${nq.filter(n => n.evidence === 'source-other').length}`);
  L.push(`- **غير مؤكد — يحتاج مراجعة بشرية: ${nq.filter(n => n.evidence === 'unverified').length}**`, '');
  L.push('| الترم | التدريب | معرف السؤال | الحالة | الدليل | ملاحظة |', '|---|---|---|---|---|---|');
  nq.forEach(n => L.push(`| ${n.term} | ${n.trainingId} | ${n.id} | ${n.keyStatus} | ${n.evidence} | ${n.note} |`));
  L.push('', `## تعارضات مفاتيح الإجابة — احتُفظ بمفتاح البنك المُدقَّق يدويًا (${report.keyConflicts.length})`, '');
  L.push('> مفاتيح البنك مُوثَّقة في AUDIT_PHILOSOPHY.md / AUDIT_PHILOSOPHY_TERM2.md / AUDIT_PHILOSOPHY_TERM2_LOGIC.md. مفاتيح JSON نتجت عن مطابقة آلية (`answer_match_score`). لم يُغيَّر أي مفتاح بالتخمين؛ هذه القائمة للمراجعة مقابل نموذج الإجابة الرسمي.', '');
  const kc = report.keyConflicts;
  L.push(`- مفتاح البنك أكده نص مفتاح المصدر (JSON correct_option خاطئ): ${kc.filter(k => k.status === 'bank-confirmed-by-source').length}`);
  L.push(`- مفتاح JSON مطابقة آلية ضعيفة/غير مؤكدة → احتُفظ بمفتاح البنك المُدقَّق: ${kc.filter(k => k.status === 'bank-key-kept-json-unverified').length}`);
  L.push(`- **تعارض حقيقي (مفتاح المصدر يسمّي خيار JSON حرفيًا بينما البنك مُدقَّق على خيار آخر) — احتُفظ بالبنك ويحتاج مراجعة بشرية: ${kc.filter(k => k.status === 'conflict-bank-key-kept').length}**`, '');
  L.push('| الترم | التدريب | JSON id | Bank id | مفتاح JSON | مفتاح البنك (المعتمد) | الحالة | الدليل |', '|---|---|---|---|---|---|---|---|');
  kc.forEach(k => L.push(`| ${k.term} | ${k.trainingId} | ${k.jsonId} | ${k.bankId} | ${k.jsonKey} | ${k.bankKey} | ${k.status} | ${k.evidence}${k.note ? ' — ' + k.note : ''}${k.jsonScore != null ? ' (score ' + k.jsonScore + ')' : ''} |`));
  L.push('', '### نصوص أسئلة التعارض', '');
  report.keyConflicts.forEach(k => L.push(`- **${k.jsonId} / ${k.bankId}**: ${k.question}  \n  الخيارات: ${k.options.join(' | ')}`));
  return L.join('\n') + '\n';
}
