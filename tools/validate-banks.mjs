/**
 * validate-banks.mjs — Full validation gate for cloudflare/src/data/banks.json.
 *
 * Verifies, against the ORIGINAL .gs sources:
 *  A. Source integrity — the three GAS validators still pass (sources untouched).
 *  B. Completeness — every production question/exam row is present and identical
 *     (modulo the documented psychology key corrections + option-prefix stripping).
 *  C. Question validity — text, 4 distinct options, valid key; no same-text conflicts.
 *  D. Structure — catalog/exam referential integrity, lesson numbering, comprehensive
 *     exam compositions (legacy preserved; new exams balanced & duplicate-free).
 *  E. No leaks — public exam metadata contains no answers/question lists.
 *
 * Exit code 1 on any failure. Run: node tools/validate-banks.mjs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { loadGsData, REPO_ROOT } from './gs-load.mjs';
import { loadTrainingJson, validateTrainingJson, stripOptionLabel as stripJsonLabel, cleanQuestionText, normArabic, OFFICIAL_TOPICS, jsonKeyEvidence, loadKeyDecisions, expectedTrainingSize } from './philo-trainings.mjs';

const D = loadGsData();
const KEY_DECISIONS = loadKeyDecisions(REPO_ROOT).decisions;
const RESTORE_OPTIONS = loadKeyDecisions(REPO_ROOT).restoreOptions;
// A JSON question with an empty option is unusable UNLESS a documented restoreOptions
// entry supplies it (same rule build-banks.mjs applies). Returns the effective options.
const effectiveJsonOptions = (q) => {
  const ro = RESTORE_OPTIONS[q.id];
  return ro ? ro.options : q.options;
};
const B = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cloudflare/src/data/banks.json'), 'utf8'));

let failures = 0, warnings = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);
const warn = (msg) => { warnings++; console.log('  ⚠ ' + msg); };

/* ---------- A. Source integrity (the three GAS validators) ---------- */
console.log('\n[A] Source integrity (original GAS validators)');
{
  const ctx = { console, Logger: { log() {} } };
  vm.createContext(ctx);
  for (const f of ['Data.gs', 'PhiloData.gs', 'PhiloTerm2Data.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), ctx, { filename: f });
  }
  for (const fn of ['validateSystem', 'validatePhiloSystem', 'validatePhiloTerm2System']) {
    const res = vm.runInContext(`globalThis.__v = ${fn}(); globalThis.__v`, ctx);
    const passed = (res && (res.ok === true || res.valid === true)) || String(res).includes('نجاح') || String(res).includes('صالح') || String(res).includes('PASS');
    if (passed) ok(fn + ' → PASS');
    else fail(fn + ' → ' + String(JSON.stringify(res)).slice(0, 200));
  }
}

/* ---------- B. Completeness vs sources ---------- */
console.log('\n[B] Completeness vs .gs sources');
{
  // psychology: 840 rows
  let rows = 0, matched = 0; const corrections = new Map(B.audit.psychology.corrections.map(c => [c.exam + '#Q' + c.q, c]));
  const strip = (t) => { let o = String(t || ''), p = null; while (o !== p) { p = o; o = o.replace(/^\s*[أابجدهدABCDabcd][\s\)\].\-:：]+\s*/, '').trim(); } return o; };
  outer:
  for (const [examId, list] of Object.entries(D.EXAMS)) {
    const newIds = B.examDefs[examId];
    if (!newIds) { fail('psych exam missing from bank: ' + examId); continue; }
    if (newIds.length !== list.length) fail(examId + ': length mismatch ' + newIds.length + ' vs ' + list.length);
    for (let i = 0; i < list.length; i++) {
      rows++;
      const src = list[i], q = B.questions[newIds[i]];
      if (!q) { fail(examId + ' Q' + (i + 1) + ': missing question ' + newIds[i]); continue; }
      const srcOpts = [src.A, src.B, src.C, src.D].map(strip);
      const srcKey = src.answer;
      const corr = corrections.get(examId + '#Q' + (i + 1));
      const expectedKey = corr ? corr.to : srcKey;
      if (q.text === String(src.question).trim() &&
          q.options.every((o, j) => o === srcOpts[j]) &&
          q.answer === expectedKey) matched++;
      else {
        // the duplicate-pair rows map to the FIRST occurrence's id — verify identity by content
        const sameByText = B.questions[newIds[i]].text === String(src.question).trim() &&
          B.questions[newIds[i]].options.every((o, j) => o === srcOpts[j]);
        if (sameByText && B.questions[newIds[i]].answer === expectedKey) matched++;
        else fail(examId + ' Q' + (i + 1) + ': content mismatch vs source');
      }
    }
  }
  console.log('  psychology rows: ' + rows + ' / matched: ' + matched + (rows === matched && rows === 840 ? '' : ''));
  if (rows === 840 && matched === 840) ok('840/840 psychology rows present & identical (incl. 8 documented corrections)');
  else fail('psychology row coverage ' + matched + '/' + rows);

  // philosophy T1 + T2
  for (const [name, bank] of [['T1', D.PHILO_BANK], ['T2', D.PHILO_T2_BANK], ['T2-LOGIC', D.PHILO_T2_LOGIC_BANK]]) {
    let m = 0, decided = 0;
    for (const q of bank) {
      const nq = B.questions[q.id];
      if (!nq) { fail('philo ' + name + ' missing question ' + q.id); continue; }
      const dec = KEY_DECISIONS[q.id];
      const expectedAnswer = dec ? dec.answer : String(q.correctAnswer).trim();
      if (nq.text === String(q.question).trim() &&
          nq.options[0] === String(q.A).trim() && nq.options[1] === String(q.B).trim() &&
          nq.options[2] === String(q.C).trim() && nq.options[3] === String(q.D).trim() &&
          nq.answer === expectedAnswer) { m++; if (dec && dec.answer !== String(q.correctAnswer).trim()) decided++; }
      else fail('philo ' + name + ' ' + q.id + ': content mismatch');
    }
    if (m === bank.length) ok('philosophy ' + name + ': ' + m + '/' + bank.length + ' questions identical to source' + (decided ? ' (' + decided + ' keys overridden by data/key-decisions.json — documented)' : ''));
  }

  // exam count parity with legacy + new
  const legacyCount = Object.keys(D.EXAMS).length + Object.keys(D.PHILO_EXAMS).length + Object.keys(D.PHILO_T2_EXAMS).length + Object.keys(D.PHILO_T2_LOGIC_EXAMS).length;
  const newCount = Object.keys(B.examDefs).length;
  const trainingCount = Object.values(B.exams).filter(e => e.subjectId === 'philosophy' && e.type === 'training' && !e.legacy).length;
  if (newCount === legacyCount + 2 + trainingCount) ok('exams: ' + legacyCount + ' legacy + 2 comprehensive + ' + trainingCount + ' JSON trainings = ' + newCount);
  else fail('exam count mismatch: legacy ' + legacyCount + ', trainings ' + trainingCount + ', bank ' + newCount);
}

/* ---------- C. Question validity ---------- */
console.log('\n[C] Question validity');
{
  let bad = 0;
  const byText = new Map(); // subject -> text -> {key, optionsHash, id}
  for (const [id, q] of Object.entries(B.questions)) {
    if (!q.text || q.text.length < 5) { fail(id + ': empty/short text'); bad++; }
    if (!Array.isArray(q.options) || q.options.length !== 4) { fail(id + ': options != 4'); bad++; }
    else {
      if (q.options.some(o => !o || !String(o).trim())) { fail(id + ': empty option'); bad++; }
      if (new Set(q.options.map(o => o.trim())).size !== 4) { fail(id + ': duplicate options within question'); bad++; }
    }
    if (!['A', 'B', 'C', 'D'].includes(q.answer)) { fail(id + ': invalid answer key ' + q.answer); bad++; }
    // Same text, different options/key within a subject = conflict
    const tk = q.meta.subjectId + '\u0000' + q.text;
    const sig = q.answer + '|' + q.options.join('§');
    if (byText.has(tk)) {
      const prev = byText.get(tk);
      if (prev.sig !== sig) { fail('CONFLICT same text different key/options: ' + prev.id + ' vs ' + id); bad++; }
    } else byText.set(tk, { sig, id });
  }
  if (!bad) ok(Object.keys(B.questions).length + ' questions valid; no same-text conflicts within subjects');
}

/* ---------- D. Structure ---------- */
console.log('\n[D] Structure & curriculum mapping');
{
  const examIds = new Set(Object.keys(B.exams));
  const referenced = new Set();
  const walk = (o) => {
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && examIds.has(v)) referenced.add(v);
      else if (Array.isArray(v)) v.forEach(x => { if (typeof x === 'string' && examIds.has(x)) referenced.add(x); else if (x && typeof x === 'object') walk(x); });
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(B.catalog);
  const unreached = [...examIds].filter(id => !referenced.has(id) && !B.exams[id].legacy);
  const hiddenLegacy = [...examIds].filter(id => B.exams[id].legacy);
  if (unreached.length === 0) ok('all ' + (examIds.size - hiddenLegacy.length) + ' listed exams reachable from catalog (' + hiddenLegacy.length + ' legacy model exams kept server-side only)');
  else fail('exams not reachable from catalog: ' + unreached.join(', '));
  if (hiddenLegacy.every(id => !referenced.has(id))) ok('legacy model exams are not listed anywhere in the student catalog');
  else fail('legacy exams leaked into catalog');

  const dangling = [...referenced].filter(id => !examIds.has(id));
  if (dangling.length === 0) ok('no dangling exam references');
  else fail('dangling exam references: ' + dangling.join(', '));

  // lesson numbering + titles
  let lessonsOk = true;
  for (const u of B.catalog.psychology.units) {
    u.lessons.forEach((l, i) => {
      if (l.no !== i + 1 || !l.title) lessonsOk = false;
      const e = B.exams[l.examIds[0]];
      if (!e || e.lessonTitle !== l.title || e.lessonNo !== l.no) lessonsOk = false;
    });
  }
  for (const t of B.catalog.philosophy.terms) for (const s of t.sections) {
    s.topics.forEach((tp, i) => {
      if (tp.no !== i + 1 || !tp.title || !tp.key) lessonsOk = false;
      tp.lessons.forEach((l, k) => {
        if (l.no !== k + 1 || !l.title || !l.key) lessonsOk = false;
        l.trainings.forEach((tr, j) => {
          const e = B.exams[tr.examId];
          if (!e || e.topicTitle !== tp.title || e.topicKey !== tp.key || e.lessonKey !== l.key || e.lessonNo !== l.no || e.lessonTitle !== l.title || e.trainingNo !== j + 1 || e.title !== tr.title || e.count !== tr.questionCount) lessonsOk = false;
        });
      });
    });
  }
  if (lessonsOk) ok('lesson numbering sequential; exam lesson metadata matches catalog (topic # + exact lesson name)');
  else fail('lesson numbering/metadata inconsistent');

  // every exam def resolves & counts
  let defsOk = true;
  for (const [id, ids] of Object.entries(B.examDefs)) {
    if (ids.length !== B.exams[id].count) { fail(id + ': count mismatch'); defsOk = false; }
    for (const qid of ids) if (!B.questions[qid]) { fail(id + ': unknown question ' + qid); defsOk = false; }
  }
  if (defsOk) ok('all exam definitions resolve; counts consistent');

  // intra-exam duplicates
  let dupExams = [];
  for (const [id, ids] of Object.entries(B.examDefs)) {
    const dups = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dups.length) dupExams.push(id + ' (' + dups.length + ')');
  }
  if (dupExams.length === 0) ok('no intra-exam duplicate questions');
  else warn('intra-exam duplicates (documented legacy): ' + dupExams.join(', '));

  // PSY-FULL-COMP balance
  {
    const ids = B.examDefs['PSY-FULL-COMP'];
    const perUnit = {};
    ids.forEach(qid => { const u = B.questions[qid].meta.unit; perUnit[u] = (perUnit[u] || 0) + 1; });
    const units = Object.keys(perUnit).map(Number).sort((a, b) => a - b);
    const balanced = units.length === 6 && units.every(u => perUnit[u] === 10) && new Set(ids).size === 60;
    if (balanced) ok('PSY-FULL-COMP: 60 questions, 10 per unit across all 6 units, no duplicates');
    else fail('PSY-FULL-COMP unbalanced: ' + JSON.stringify(perUnit));
  }
  // T2-TERM-COMP balance (full term: 20 فلسفة + 20 منطق)
  {
    const ids = B.examDefs['T2-TERM-COMP'];
    const perTraining = {};
    ids.forEach(qid => { const m = B.questions[qid].meta; perTraining[m.chapter + ' ' + m.training] = (perTraining[m.chapter + ' ' + m.training] || 0) + 1; });
    const keys = Object.keys(perTraining);
    const expect = {
      'الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية تدريب 1': 5,
      'الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية تدريب 2': 5,
      'الفصل الثاني: الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد تدريب 1': 5,
      'الفصل الثاني: الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد تدريب 2': 5,
      'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي تدريب 1': 3,
      'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي تدريب 2': 3,
      'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي تدريب 3': 3,
      'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي تدريب 4': 3,
      'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية تدريب 1': 2,
      'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية تدريب 2': 3,
      'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية تدريب 3': 3
    };
    const balanced = ids.length === 40 && new Set(ids).size === 40 &&
      keys.length === 11 && keys.every(k => perTraining[k] === expect[k]);
    if (balanced) ok('T2-TERM-COMP: 40 questions covering the full term (20 فلسفة + 20 منطق, per-training balance verified, no duplicates)');
    else fail('T2-TERM-COMP unbalanced: ' + JSON.stringify(perTraining));
  }

  // T2L-COMP balance (منطق unit: 20Q proportional 3/3/3/3/2/3/3)
  {
    const ids = B.examDefs['T2L-COMP'];
    if (!ids || ids.length !== 20 || new Set(ids).size !== 20) fail('T2L-COMP missing/duplicated');
    else {
      const sec = new Set(ids.map(qid => B.questions[qid].meta.section));
      if (sec.size === 1 && sec.has('المنطق')) ok('T2L-COMP: 20 unique questions, all from وحدة المنطق');
      else fail('T2L-COMP contains non-logic questions');
    }
  }

  // ===== Philosophy & Logic PRODUCTION structure: Term → Section → Topic → Training (JSON = source of truth)
  for (const term of [1, 2]) {
    const J = loadTrainingJson(REPO_ROOT, term);
    const jsonIssues = validateTrainingJson(J, term).filter(i => !i.includes('empty option'));
    if (!jsonIssues.length) ok('T' + term + ' JSON structurally valid (ids unique, expected q/training, 4 options, keys consistent)');
    else fail('T' + term + ' JSON issues: ' + jsonIssues.join('; '));
    const T = B.catalog.philosophy.terms.find(x => x.term === term);
    if (!T) { fail('term ' + term + ' missing from catalog'); continue; }
    const catTrainings = T.sections.flatMap(s => s.topics.flatMap(tp => tp.lessons.flatMap(l => l.trainings.map(tr => tr.examId))));
    // official structure: exactly 2 topics per section; lesson titles = JSON topic strings verbatim; every training under exactly one lesson
    const twoTopics = T.sections.length === 2 && T.sections.every(s => s.topics.length === 2 && s.topics.every((tp, i) => tp.title === OFFICIAL_TOPICS[term][s.id][i].title));
    if (twoTopics) ok('T' + term + ': الفلسفة 2 موضوعات + المنطق 2 موضوعات (official chapter titles)');
    else fail('T' + term + ': topic structure ≠ 2+2 official topics');
    const seenTr = new Set(); let oneLesson = true;
    T.sections.forEach(s => s.topics.forEach(tp => tp.lessons.forEach(l => l.trainings.forEach(tr => { if (seenTr.has(tr.examId)) oneLesson = false; seenTr.add(tr.examId); }))));
    if (oneLesson) ok('T' + term + ': every training appears under exactly one lesson (no cross-lesson leakage)');
    else fail('T' + term + ': a training appears under more than one lesson');
    const genericLesson = T.sections.flatMap(s => s.topics.flatMap(tp => tp.lessons)).filter(l => /^الدرس\s*(الأول|الثاني|الثالث|\d+)$/.test(l.title.trim()) || !l.title.trim());
    if (!genericLesson.length) ok('T' + term + ': all lesson titles are real names from the source (no generic «الدرس N»)');
    else fail('T' + term + ': generic lesson titles: ' + genericLesson.map(l => l.key).join(','));
    const jsonIds = J.training_exams.map(t => t.training_id);
    if (JSON.stringify([...catTrainings].sort()) === JSON.stringify([...jsonIds].sort()) && catTrainings.length === jsonIds.length)
      ok('T' + term + ': all ' + jsonIds.length + ' JSON trainings present as independent exams (none dropped, none merged)');
    else fail('T' + term + ' training set mismatch: catalog ' + catTrainings.join(',') + ' vs JSON ' + jsonIds.join(','));
    const jsonLessons = [...new Set(J.training_exams.map(t => t.subject + '|' + t.topic))];
    const catLessons = T.sections.flatMap(s => s.topics.flatMap(tp => tp.lessons.map(l => s.title + '|' + l.title)));
    if (JSON.stringify(jsonLessons) === JSON.stringify(catLessons)) ok('T' + term + ': ' + catLessons.length + ' lessons — exact JSON lesson names & source order, no invented lessons');
    else fail('T' + term + ' lesson mismatch: ' + JSON.stringify({ jsonLessons, catLessons }));
    // each training: same questions, same order, verbatim text/options (label-stripped), no dup, 4 opts, valid key
    let okTr = 0;
    for (const t of J.training_exams) {
      const e = B.exams[t.training_id], ids = B.examDefs[t.training_id];
      if (!e || !ids) { fail('missing training exam ' + t.training_id); continue; }
      if (e.subjectId !== 'philosophy' || e.term !== term || e.type !== 'training' || e.legacy) { fail(t.training_id + ': wrong metadata'); continue; }
      if (e.lessonTitle !== t.topic || e.sectionTitle !== t.subject) { fail(t.training_id + ': lesson/section ≠ JSON'); continue; }
      if ('difficulty' in e) { fail(t.training_id + ': difficulty exposed to students'); continue; }
      const expected = t.questions.filter(q => effectiveJsonOptions(q).every(o => stripJsonLabel(o)));
      const expSize = expectedTrainingSize(t.training_id);
      if (ids.length !== expected.length || (ids.length !== expSize && ids.length !== expSize - 1)) { fail(t.training_id + ': ' + ids.length + ' questions (JSON usable ' + expected.length + ', expected ' + expSize + ')'); continue; }
      if (ids.length === expSize - 1) warn(t.training_id + ': ships at ' + ids.length + ' (one quarantined extraction defect — see AUDIT_PHILOSOPHY_TRAININGS.md)');
      if (new Set(ids).size !== ids.length) { fail(t.training_id + ': duplicate question inside training'); continue; }
      let good = true;
      expected.forEach((jq, i) => {
        const bq = B.questions[ids[i]];
        if (!bq) { fail(t.training_id + ' q' + (i + 1) + ': unresolved ' + ids[i]); good = false; return; }
        if (normArabic(bq.text) !== normArabic(cleanQuestionText(jq.question))) { fail(t.training_id + ' q' + (i + 1) + ': text ≠ JSON (' + ids[i] + ')'); good = false; }
        const jo = effectiveJsonOptions(jq).map(o => normArabic(stripJsonLabel(o)).replace(/ئ/g, 'ي').replace(/ؤ/g, 'و'));
        const bo = bq.options.map(o => normArabic(o).replace(/ئ/g, 'ي').replace(/ؤ/g, 'و'));
        if (JSON.stringify(jo) !== JSON.stringify(bo)) { fail(t.training_id + ' q' + (i + 1) + ': options ≠ JSON (' + ids[i] + ')'); good = false; }
        if (bq.options.length !== 4 || !['A', 'B', 'C', 'D'].includes(bq.answer)) { fail(ids[i] + ': invalid options/key'); good = false; }
        // key: either identical to JSON, or a documented conflict where the manually verified bank key was kept
        const jsonAns = normArabic(stripJsonLabel(jq.correct_answer)).replace(/ئ/g, 'ي');
        const bankAns = normArabic(bq.options['ABCD'.indexOf(bq.answer)]).replace(/ئ/g, 'ي');
        if (jsonAns !== bankAns) {
          const ks = bq.meta.keyStatus;
          const documented = ks === 'conflict-bank-key-kept' || ks === 'bank-key-kept-json-unverified' || ks === 'bank-confirmed-by-source' || (ks === 'official-source-decision' && bq.meta.keySource) ||
            (bq.meta.keyEvidence === 'source-other' && jsonKeyEvidence(jq).sourceOption === bq.answer);
          if (!documented) { fail(ids[i] + ': key differs from JSON without documented evidence'); good = false; }
        }
        if (bq.meta.verificationStatus !== 'verified' && bq.meta.verificationStatus !== 'needs-review') { fail(ids[i] + ': unknown verificationStatus'); good = false; }
        if (bq.meta.subjectId !== 'philosophy' || bq.meta.term !== term) { fail(ids[i] + ': wrong subject/term meta'); good = false; }
      });
      if (good) okTr++;
    }
    if (okTr === J.training_exams.length) ok('T' + term + ': every training = JSON question set, same order, verbatim text/options, 4 options, valid server-side key, no intra-training duplicates');
    const totalQ = catTrainings.reduce((n, id) => n + B.examDefs[id].length, 0);
    { // key verification summary for this term's production questions
      const qids = [...new Set(catTrainings.flatMap(id => B.examDefs[id]))];
      const nr = qids.filter(q => B.questions[q].meta.verificationStatus === 'needs-review' || B.questions[q].meta.keyStatus === 'conflict-bank-key-kept');
      const msg = 'T' + term + ': ' + (qids.length - nr.length) + '/' + qids.length + ' production keys verified; ' + nr.length + ' open (REVIEW_ANSWER_KEYS.md — never guessed)';
      // STRICT_KEYS=1 turns the remaining open items into a hard failure (production gate)
      if (nr.length && process.env.STRICT_KEYS) fail(msg); else if (nr.length) warn(msg); else ok(msg);
    }
    const expTotal = catTrainings.reduce((n, id) => n + expectedTrainingSize(id), 0);
    ok('T' + term + ': ' + catTrainings.length + ' trainings = ' + totalQ + ' training questions (expected ' + expTotal + ')' + (totalQ !== expTotal ? ' (' + (expTotal - totalQ) + ' quarantined extraction defect — see AUDIT_PHILOSOPHY_TRAININGS.md)' : ''));
    // comprehensive exams kept & separated
    const comps = T.comprehensiveExamIds || [];
    if (comps.length && comps.every(id => B.exams[id] && /comprehensive/.test(B.exams[id].type) && !catTrainings.includes(id)))
      ok('T' + term + ': ' + comps.length + ' comprehensive exams preserved in a separate section (' + comps.join(', ') + ')');
    else fail('T' + term + ' comprehensive exams missing/mixed: ' + comps.join(','));
  }
  // no philosophy question is orphaned from every listed exam except legacy-only ones (allowed, documented)
  {
    const listed = new Set(Object.values(B.exams).filter(e => !e.legacy).flatMap(e => B.examDefs[e.id]));
    const newQ = Object.keys(B.questions).filter(id => B.questions[id].meta.source && String(B.questions[id].meta.source).includes('ExamManasa JSON dataset'));
    const orphanNew = newQ.filter(id => !listed.has(id));
    if (!orphanNew.length) ok('no orphan JSON-sourced questions (' + newQ.length + ' new questions all referenced by a listed training)');
    else fail('orphan JSON questions: ' + orphanNew.join(','));
  }

  // every T1/T2 legacy exam id preserved
  const legacyIds = [...Object.keys(D.PHILO_EXAMS), ...Object.keys(D.PHILO_T2_EXAMS), ...Object.keys(D.PHILO_T2_LOGIC_EXAMS), ...Object.keys(D.EXAMS)];
  const missing = legacyIds.filter(id => !B.exams[id]);
  if (!missing.length) ok('all ' + legacyIds.length + ' legacy exam ids preserved');
  else fail('legacy exam ids lost: ' + missing.join(', '));
}

/* ---------- D2. Psychology frozen (byte-identical snapshot) ---------- */
console.log('\n[D2] Psychology unchanged');
{
  const psyExams = Object.fromEntries(Object.entries(B.exams).filter(([, e]) => e.subjectId === 'psychology').sort());
  const psyDefs = Object.fromEntries(Object.keys(psyExams).sort().map(id => [id, B.examDefs[id]]));
  const psyQ = Object.fromEntries(Object.entries(B.questions).filter(([, q]) => q.meta.subjectId === 'psychology').sort());
  const snap = JSON.stringify({ catalog: B.catalog.psychology, exams: psyExams, examDefs: psyDefs, questions: psyQ });
  const hash = crypto.createHash('sha256').update(snap).digest('hex');
  const EXPECTED = '8851437be88724537693cbf1ad57c0531e36eca4b55dcea102f7c077b44a8198'; // snapshot taken before the philosophy rebuild (2026-09-10)
  if (hash === EXPECTED) ok('psychology catalog/exams/examDefs/questions byte-identical to pre-rebuild snapshot (sha256 ' + hash.slice(0, 12) + '…)');
  else fail('PSYCHOLOGY CHANGED — sha256 ' + hash + ' ≠ ' + EXPECTED);
}

/* ---------- E. No leaks ---------- */
console.log('\n[E] Public-surface leak check');
{
  const publicJson = JSON.stringify(B.catalog) + JSON.stringify(B.exams);
  const leaks = [];
  if (/correct_option|correct_answer|keyStatus|jsonKey/.test(publicJson)) leaks.push('JSON key fields in public data');
  if (publicJson.includes('"answer"')) leaks.push('answers in public data');
  if (publicJson.includes('questionIds')) leaks.push('question lists in public data');
  for (const id of Object.keys(B.questions).slice(0, 50)) {
    const q = B.questions[id];
    if (publicJson.includes(JSON.stringify(q.text).slice(1, 40))) { leaks.push('question text in public data'); break; }
  }
  if (!leaks.length) ok('catalog + public exam metadata contain no answers, no question lists, no question texts');
  else fail('leaks: ' + leaks.join('; '));
}

/* ---------- summary ---------- */
console.log('\n==============================');
console.log('Questions: ' + Object.keys(B.questions).length +
  ' (psych ' + B.structure.psychology.uniqueQuestions +
  ', philo T1 ' + B.structure.philosophyTerm1.uniqueQuestions +
  ', philo T2 ' + B.structure.philosophyTerm2.uniqueQuestions + ')');
console.log('Exams: ' + Object.keys(B.exams).length +
  ' (psych ' + B.structure.psychology.examCount +
  ', philo T1 ' + B.structure.philosophyTerm1.examCount +
  ', philo T2 ' + B.structure.philosophyTerm2.examCount + ')');
console.log('Warnings: ' + warnings);
if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
console.log('RESULT: ALL CHECKS PASSED ✓');
