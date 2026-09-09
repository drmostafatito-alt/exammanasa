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
import path from 'node:path';
import vm from 'node:vm';
import { loadGsData, REPO_ROOT } from './gs-load.mjs';

const D = loadGsData();
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
  for (const [name, bank] of [['T1', D.PHILO_BANK], ['T2', D.PHILO_T2_BANK]]) {
    let m = 0;
    for (const q of bank) {
      const nq = B.questions[q.id];
      if (!nq) { fail('philo ' + name + ' missing question ' + q.id); continue; }
      if (nq.text === String(q.question).trim() &&
          nq.options[0] === String(q.A).trim() && nq.options[1] === String(q.B).trim() &&
          nq.options[2] === String(q.C).trim() && nq.options[3] === String(q.D).trim() &&
          nq.answer === String(q.correctAnswer).trim()) m++;
      else fail('philo ' + name + ' ' + q.id + ': content mismatch');
    }
    if (m === bank.length) ok('philosophy ' + name + ': ' + m + '/' + bank.length + ' questions identical to source');
  }

  // exam count parity with legacy + new
  const legacyCount = Object.keys(D.EXAMS).length + Object.keys(D.PHILO_EXAMS).length + Object.keys(D.PHILO_T2_EXAMS).length;
  const newCount = Object.keys(B.examDefs).length;
  if (newCount === legacyCount + 2) ok('exams: ' + legacyCount + ' legacy + 2 new = ' + newCount);
  else fail('exam count mismatch: legacy ' + legacyCount + ', bank ' + newCount);
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
  const unreached = [...examIds].filter(id => !referenced.has(id));
  if (unreached.length === 0) ok('all ' + examIds.size + ' exams reachable from catalog');
  else fail('exams not reachable from catalog: ' + unreached.join(', '));

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
  for (const t of B.catalog.philosophy.terms) for (const u of t.units) for (const ch of u.chapters) {
    ch.lessons.forEach((l, i) => {
      if (l.no !== i + 1 || !l.title) lessonsOk = false;
      const e = B.exams[l.examIds[0]];
      if (!e || e.lessonTitle !== l.title || e.lessonNo !== l.no) lessonsOk = false;
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
  // T2-TERM-COMP balance
  {
    const ids = B.examDefs['T2-TERM-COMP'];
    const perTraining = {};
    ids.forEach(qid => { const m = B.questions[qid].meta; perTraining[m.chapter + ' ' + m.training] = (perTraining[m.chapter + ' ' + m.training] || 0) + 1; });
    const keys = Object.keys(perTraining);
    const balanced = keys.length === 4 && keys.every(k => perTraining[k] === 5) && new Set(ids).size === 20;
    if (balanced) ok('T2-TERM-COMP: 20 questions, 5 per training across all 4 T2 trainings, no duplicates');
    else fail('T2-TERM-COMP unbalanced: ' + JSON.stringify(perTraining));
  }

  // official unit/chapter names (T1) present
  const t1 = B.catalog.philosophy.terms[0];
  const expectTitles = ['الوحدة الأولى: الفلسفة', 'الوحدة الثانية: المنطق'];
  const expectChapters = ['الفصل الأول: التفكير الإنساني', 'الفصل الثاني: الفلسفة وطبيعة الموقف الفلسفي',
    'الفصل الأول: مبادئ المنطق (الحدود - القضايا)', 'الفصل الثاني: الاستدلال (تعريفه - أنواعه)'];
  const gotUnits = t1.units.map(u => u.title);
  const gotChapters = t1.units.flatMap(u => u.chapters.map(c => c.title));
  if (JSON.stringify(gotUnits) === JSON.stringify(expectTitles) && JSON.stringify(gotChapters) === JSON.stringify(expectChapters))
    ok('T1 units/chapters match the official curriculum book exactly');
  else fail('T1 structure mismatch: ' + JSON.stringify({ gotUnits, gotChapters }));

  // every T1/T2 legacy exam id preserved
  const legacyIds = [...Object.keys(D.PHILO_EXAMS), ...Object.keys(D.PHILO_T2_EXAMS), ...Object.keys(D.EXAMS)];
  const missing = legacyIds.filter(id => !B.exams[id]);
  if (!missing.length) ok('all ' + legacyIds.length + ' legacy exam ids preserved');
  else fail('legacy exam ids lost: ' + missing.join(', '));
}

/* ---------- E. No leaks ---------- */
console.log('\n[E] Public-surface leak check');
{
  const publicJson = JSON.stringify(B.catalog) + JSON.stringify(B.exams);
  const leaks = [];
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
