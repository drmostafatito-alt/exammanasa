/**
 * build-banks.mjs — Compiles the production question banks (Data.gs / PhiloData.gs /
 * PhiloTerm2Data.gs) into a single JSON artifact consumed by the Cloudflare Worker.
 *
 * STRUCTURAL SOURCE OF TRUTH:
 *  - Philosophy Term 1 unit/chapter organization follows the OFFICIAL Ministry of
 *    Education curriculum book "كتاب الشرح فلسفة ومنطق أولي ثانوي" (provided source library):
 *      الوحدة الأولى: الفلسفة  → الفصل الأول: التفكير الإنساني / الفصل الثاني: الفلسفة وطبيعة الموقف الفلسفي
 *      الوحدة الثانية: المنطق  → الفصل الأول: مبادئ المنطق (الحدود - القضايا) / الفصل الثاني: الاستدلال (تعريفه - أنواعه)
 *  - Term 2 chapters follow the official mapping documented in AUDIT_PHILOSOPHY_TERM2.md.
 *  - Psychology topics use the exact lesson names embedded in the source bank
 *    (they match the provided psychology question books).
 *  - Legacy exam IDs are preserved. Two NEW comprehensive exams are composed from
 *    existing verified questions only (documented deterministic rules; no new questions).
 *  - Four conflicting psychology answer keys (self-contradictory duplicates in U2-T1)
 *    are corrected via a DOCUMENTED override layer. Data.gs itself is never modified.
 *
 * This script NEVER modifies the .gs source files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGsData, REPO_ROOT } from './gs-load.mjs';

const OUT = path.resolve(REPO_ROOT, 'cloudflare/src/data/banks.json');
const D = loadGsData();

/* ================================================================== *
 * Psychology answer-key corrections (DOCUMENTED — AUDIT_EDUCATIONAL_V2.md)
 *
 * U2-T1 (الدرس: كيف يبدأ السلوك؟) contains 6 duplicated questions inherited from
 * the protected source (Data.gs). Four pairs carry IDENTICAL text and options but
 * CONFLICTING answer keys. The correct key was verified against the provided
 * official psychology question books (كتاب_الأسئلة_علم النفس_2 — الدرس «كيف يبدأ
 * السلوك؟») and the curriculum model. Applied as an override layer only.
 * ================================================================== */
const PSY_KEY_CORRECTIONS = [
  {
    match: 'يجلس طالب في قاعة محاضرات تعج بالضوضاء',
    to: 'D',
    reason: 'U2-T1 Q3 (مفتاح B) يناقض مكرره Q13 (مفتاح D). الصواب: الإحساس مجرد استقبال أولي ولا ندرك من المثيرات إلا ما ننتبه إليه (الكتاب: «الإحساس بمفرده لا يعني الفهم ولا يكفي لتفسير السلوك»).'
  },
  {
    match: 'المرحلة الفسيولوجية في عملية الإحساس تتضمن دوراً حاسماً للمستقبلات',
    to: 'C',
    reason: 'U2-T1 Q4 (مفتاح B) يناقض مكرره Q14 (مفتاح C). الصواب: المستقبلات تحوّل الطاقة الفيزيائية/الكيميائية إلى طاقة عصبية (كهروكيميائية) ليفهمها المخ.'
  },
  {
    match: 'الدافعية ليست مجرد رغبة سطحية',
    to: 'B',
    reason: 'U2-T1 Q7 (مفتاح A) يناقض مكرره Q17 (مفتاح B). الصواب: تحوّل الإحساس بالمثير إلى تنبيه عصبي ينشط مراكز الدماغ = الاستثارة (تسلسل الدافعية: حاجة ← إحساس بالمثير ← استثارة ← دافع ← سلوك).'
  },
  {
    match: 'يعتبر الإحساس الخطوة الأولى في بناء السلوك وأولى العمليات المعرفية',
    to: 'A',
    reason: 'U2-T1 Q9 (مفتاح B) يناقض مكرره Q19 (مفتاح A). الصواب: كافة العمليات المعرفية اللاحقة (الانتباه والإدراك) تعتمد على الإحساس بشكل أساسي.'
  }
];

const psychCorrectionsApplied = [];
for (const examId of Object.keys(D.EXAMS)) {
  D.EXAMS[examId].forEach((q, i) => {
    const text = String(q.question || '').trim();
    for (const c of PSY_KEY_CORRECTIONS) {
      if (text.startsWith(c.match) && q.answer !== c.to) {
        psychCorrectionsApplied.push({ exam: examId, q: i + 1, from: q.answer, to: c.to, reason: c.reason });
        q.answer = c.to;
      }
    }
  });
}

/* ================================================================== *
 * Shared helpers
 * ================================================================== */
function stripPrefixLoop(text) {
  let out = String(text || ''), prev = null;
  while (out !== prev) { prev = out; out = out.replace(/^\s*[أابجدهدABCDabcd][\s\)\].\-:：]+\s*/, '').trim(); }
  return out;
}

const contentKey = (q) => JSON.stringify([
  String(q.question || '').trim(),
  String(q.A || '').trim(), String(q.B || '').trim(),
  String(q.C || '').trim(), String(q.D || '').trim(),
  String(q.answer || q.correctAnswer || '').trim()
]);

const questions = {}; // id -> {text, options[4], answer, meta}
const exams = {};     // id -> full exam (incl. questionIds)

const catalog = {
  psychology: {
    id: 'psychology', name: 'علم النفس', gradeName: 'الصف الثاني الثانوي',
    academicYear: 'العام الدراسي 2026 / 2027', color: '#7a5c2e',
    units: [], subjectComprehensiveExamId: 'PSY-FULL-COMP'
  },
  philosophy: {
    id: 'philosophy', name: 'الفلسفة والمنطق', gradeName: 'الصف الأول الثانوي',
    academicYear: 'العام الدراسي 2026 / 2027', color: '#123B40',
    terms: []
  }
};

function addQuestion(id, q, meta) {
  if (questions[id]) {
    const ex = questions[id];
    if (ex.text !== String(q.question).trim() || ex.answer !== String(q.answer || q.correctAnswer).trim() ||
        ex.options.join('\u0000') !== [q.A, q.B, q.C, q.D].map(stripPrefixLoop).join('\u0000')) {
      throw new Error('Question id collision with different content: ' + id);
    }
    return id;
  }
  questions[id] = {
    text: String(q.question).trim(),
    options: [q.A, q.B, q.C, q.D].map(stripPrefixLoop),
    answer: String(q.answer || q.correctAnswer).trim(),
    meta
  };
  return id;
}

/* ================================================================== *
 * 1) PSYCHOLOGY (Data.gs — protected source, never modified)
 * ================================================================== */
function buildPsychology() {
  const byUnit = {};
  for (const c of D.CATALOG) (byUnit[c.unit] = byUnit[c.unit] || []).push(c);

  const unitTopicIds = {}; // unit -> per-topic arrays of question ids

  for (const unit of Object.keys(byUnit).map(Number).sort((a, b) => a - b)) {
    const topics = byUnit[unit]
      .filter(c => c.type !== 'comprehensive')
      .sort((a, b) => Number(a.topicNo || 0) - Number(b.topicNo || 0));
    unitTopicIds[unit] = [];
    const lessons = [];

    topics.forEach((c, tIdx) => {
      const list = D.EXAMS[c.id];
      if (!list) throw new Error('Missing psych exam ' + c.id);
      const topicNames = new Set(list.map(q => String(q.topic || '').trim()));
      if (topicNames.size !== 1) throw new Error(c.id + ': mixed lesson titles: ' + [...topicNames].join(' | '));
      const lessonTitle = [...topicNames][0];
      if (lessonTitle !== c.title) throw new Error(c.id + ': catalog title ≠ embedded lesson title (' + c.title + ' / ' + lessonTitle + ')');

      const idsInExam = [];
      const seen = new Map();
      list.forEach((q, i) => {
        const key = contentKey(q);
        let id = seen.get(key);
        if (!id) {
          id = 'PSY-' + c.id + '-Q' + String(i + 1).padStart(2, '0');
          addQuestion(id, q, {
            subject: 'علم النفس', subjectId: 'psychology', unit: unit,
            lesson: lessonTitle, topic: lessonTitle,
            source: 'بنك علم النفس (Data.gs)', verificationStatus: 'verified'
          });
          seen.set(key, id);
        }
        idsInExam.push(id);
      });
      exams[c.id] = {
        id: c.id, subjectId: 'psychology', term: null, type: 'topic', count: list.length,
        title: 'امتحان الموضوع ' + (tIdx + 1) + ' — ' + lessonTitle,
        lessonNo: tIdx + 1, lessonTitle, unitTitle: 'الوحدة ' + unit,
        variant: 1, questionIds: idsInExam
      };
      unitTopicIds[unit].push(idsInExam);
      lessons.push({ no: tIdx + 1, title: lessonTitle, examIds: [c.id], questionCount: list.length });
    });

    // Unit comprehensive — legacy composition preserved, rows mapped to topic ids by content.
    const comp = byUnit[unit].find(c => c.type === 'comprehensive');
    const compList = D.EXAMS[comp.id];
    const realIndex = new Map();
    topics.forEach((c, tIdx) => {
      const ids = unitTopicIds[unit][tIdx];
      D.EXAMS[c.id].forEach((q, i) => realIndex.set(contentKey(q), ids[i]));
    });
    const compIds = compList.map((q, i) => {
      const mapped = realIndex.get(contentKey(q));
      if (mapped) return mapped;
      const id = 'PSY-' + comp.id + '-Q' + String(i + 1).padStart(2, '0');
      addQuestion(id, q, {
        subject: 'علم النفس', subjectId: 'psychology', unit: unit,
        lesson: '', topic: String(q.topic || ''),
        source: 'بنك علم النفس (Data.gs)', verificationStatus: 'verified'
      });
      return id;
    });
    exams[comp.id] = {
      id: comp.id, subjectId: 'psychology', term: null, type: 'unit-comprehensive',
      count: compList.length, title: 'الامتحان الشامل — الوحدة ' + unit,
      unitTitle: 'الوحدة ' + unit, variant: 1, questionIds: compIds
    };

    catalog.psychology.units.push({
      no: unit, title: 'الوحدة ' + unit, lessons, comprehensiveExamId: comp.id
    });
  }

  // NEW: full-curriculum comprehensive — 60 questions (10 per unit, 3/3/2/2 round-robin
  // across the unit's four topics at deterministic spread positions). Verified
  // existing questions only. If a chosen position collides with an already-selected
  // id (known intra-exam duplicates in U2-T1), the next position is used.
  const fullIds = [];
  const used = new Set();
  for (const unit of Object.keys(unitTopicIds).map(Number).sort((a, b) => a - b)) {
    const topicIds = unitTopicIds[unit];
    const base = (unit * 3) % 20;
    for (let step = 0; step < 10; step++) {
      const t = step % 4;
      let p = (base + Math.floor(step / 4) * 5) % 20;
      while (used.has(topicIds[t][p])) p = (p + 1) % 20;
      const id = topicIds[t][p];
      used.add(id);
      fullIds.push(id);
    }
  }
  if (new Set(fullIds).size !== 60) throw new Error('PSY-FULL-COMP selection produced duplicates');
  exams['PSY-FULL-COMP'] = {
    id: 'PSY-FULL-COMP', subjectId: 'psychology', term: null,
    type: 'subject-comprehensive', count: 60,
    title: 'الامتحان الشامل — المنهج كاملًا',
    unitTitle: 'المنهج كاملًا', variant: 1, questionIds: fullIds
  };
}

/* ================================================================== *
 * 2) PHILOSOPHY (PhiloData.gs = Term 1, PhiloTerm2Data.gs = Term 2)
 * ================================================================== */
const T1_UNITS = [
  {
    no: 1, title: 'الوحدة الأولى: الفلسفة', section: 'الفلسفة',
    chapters: [
      {
        no: 1, title: 'الفصل الأول: التفكير الإنساني', bankChapter: 'الفصل الأول: التفكير الإنساني',
        lessons: [
          { title: 'النشاط العقلي الإنساني', training: 'تدريب 1' },
          { title: 'التفكير الناقد والتفكير الإبداعي', training: 'تدريب 2' }
        ]
      },
      {
        no: 2, title: 'الفصل الثاني: الفلسفة وطبيعة الموقف الفلسفي', bankChapter: 'الفصل الثاني: الفلسفة وطبيعة الموقف الفلسفي',
        lessons: [
          { title: 'نشأة الفلسفة وتعريفها', training: 'تدريب 1' },
          { title: 'مباحث الفلسفة وقيمها وأهميتها', training: 'تدريب 2' },
          { title: 'خصائص الموقف الفلسفي وتحدياته وعصوره', training: 'تدريب 3' }
        ]
      }
    ],
    comprehensiveId: 'PHI-COMP', comprehensiveTitle: 'الامتحان الشامل — الوحدة الأولى (الفلسفة)'
  },
  {
    no: 2, title: 'الوحدة الثانية: المنطق', section: 'المنطق',
    chapters: [
      {
        no: 1, title: 'الفصل الأول: مبادئ المنطق (الحدود - القضايا)', bankChapter: 'الفصل الأول: مبادئ علم المنطق',
        lessons: [
          { title: 'الحد المنطقي', training: 'تدريب 1' },
          { title: 'القضية المنطقية', training: 'تدريب 2' },
          { title: 'التقابل بين القضايا', training: 'تدريب 3' }
        ]
      },
      {
        no: 2, title: 'الفصل الثاني: الاستدلال (تعريفه - أنواعه)', bankChapter: 'الفصل الثاني: الاستدلال',
        lessons: [
          { title: 'القياس المنطقي', training: 'تدريب 1' }
        ]
      }
    ],
    comprehensiveId: 'LOG-COMP', comprehensiveTitle: 'الامتحان الشامل — الوحدة الثانية (المنطق)'
  }
];

const T2_UNITS = [
  {
    no: 1, title: 'الوحدة الأولى: الفلسفة', section: 'الفلسفة',
    chapters: [
      {
        no: 1, title: 'الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية',
        bankChapter: 'الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية',
        lessons: [
          { title: 'الفلسفة البيئية', training: 'تدريب 1' },
          { title: 'الأخلاق البيوطبية', training: 'تدريب 2' }
        ]
      },
      {
        no: 2, title: 'الفصل الثاني: الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد',
        bankChapter: 'الفصل الثاني: الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد',
        lessons: [
          { title: 'الأخلاق المهنية', training: 'تدريب 1' },
          { title: 'القيم والتفلسف', training: 'تدريب 2' }
        ]
      }
    ],
    comprehensiveId: null, comprehensiveTitle: null
  },
  {
    no: 2, title: 'الوحدة الثانية: المنطق', section: 'المنطق',
    chapters: [
      {
        no: 1, title: 'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي',
        bankChapter: 'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي',
        lessons: [
          { title: 'الاستقراء وتطبيقه في العلوم الطبيعية', training: 'تدريب 1' },
          { title: 'الجانب السلبي والإيجابي عند بيكون', training: 'تدريب 2' },
          { title: 'خطوات المنهج الاستقرائي التجريبي وشروطه', training: 'تدريب 3' },
          { title: 'الاستقراء العلمي الحديث والمعاصر', training: 'تدريب 4' }
        ]
      },
      {
        no: 2, title: 'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية',
        bankChapter: 'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية',
        lessons: [
          { title: 'النسق الاستنباطي والقضايا الرياضية', training: 'تدريب 1' },
          { title: 'المنطق الرمزي والأساس المنطقي للحاسوب', training: 'تدريب 2' },
          { title: 'المنطق والذكاء الاصطناعي', training: 'تدريب 3' }
        ]
      }
    ],
    comprehensiveId: 'T2L-COMP', comprehensiveTitle: 'الامتحان الشامل — وحدة المنطق (الترم الثاني)'
  }
];

function buildPhilosophyTerm(termNo, bank, examsObj, unitDefs, termComprehensive) {
  bank.forEach(q => {
    addQuestion(q.id, q, {
      subject: 'الفلسفة والمنطق', subjectId: 'philosophy', term: termNo,
      unit: '', section: q.section || '', chapter: q.chapter, training: q.training,
      difficulty: q.difficulty || '', source: q.source || '',
      verificationStatus: q.verificationStatus || 'verified',
      authorCreated: !!q.authorCreated,
      grade: q.grade || '', academicYear: q.academicYear || ''
    });
  });

  const byTraining = {};
  Object.entries(examsObj).forEach(([id, e]) => {
    const key = e.section + '|' + e.chapter + '|' + e.training;
    (byTraining[key] = byTraining[key] || []).push({ id, e });
  });

  const unitOut = [];
  for (const u of unitDefs) {
    const chaptersOut = [];
    for (const ch of u.chapters) {
      const lessonsOut = [];
      for (let li = 0; li < ch.lessons.length; li++) {
        const lesson = ch.lessons[li];
        const key = u.section + '|' + ch.bankChapter + '|' + lesson.training;
        const variants = (byTraining[key] || []).sort((a, b) => (a.e.variant || 1) - (b.e.variant || 1));
        if (!variants.length) throw new Error('No exams found for training: ' + key);
        const examIds = [];
        let questionCount = 0;
        variants.forEach(({ id, e }) => {
          const ids = e.indices.map(i => {
            const q = bank[i];
            if (!q) throw new Error(id + ': index out of range');
            return q.id;
          });
          const v = e.variant || 1;
          exams[id] = {
            id, subjectId: 'philosophy', term: termNo, type: 'training', count: ids.length,
            title: 'امتحان الموضوع ' + (li + 1) + ' — ' + lesson.title + (v > 1 ? ' (نموذج ' + v + ')' : ''),
            lessonNo: li + 1, lessonTitle: lesson.title,
            chapterTitle: ch.title, unitTitle: u.title,
            training: lesson.training, variant: v, questionIds: ids
          };
          examIds.push(id);
          questionCount = Math.max(questionCount, ids.length);
        });
        lessonsOut.push({ no: li + 1, title: lesson.title, training: lesson.training, examIds, questionCount });
      }
      chaptersOut.push({ no: ch.no, title: ch.title, lessons: lessonsOut });
    }
    const unitEntry = { no: u.no, title: u.title, chapters: chaptersOut };
    if (u.comprehensiveId) {
      const e = examsObj[u.comprehensiveId];
      if (!e) throw new Error('Missing comprehensive ' + u.comprehensiveId);
      const ids = e.indices.map(i => bank[i].id);
      exams[u.comprehensiveId] = {
        id: u.comprehensiveId, subjectId: 'philosophy', term: termNo,
        type: 'unit-comprehensive', count: ids.length, title: u.comprehensiveTitle,
        unitTitle: u.title, variant: 1, questionIds: ids
      };
      unitEntry.comprehensiveExamId = u.comprehensiveId;
    }
    unitOut.push(unitEntry);
  }

  const termEntry = { term: termNo, label: termNo === 1 ? 'الترم الأول' : 'الترم الثاني', units: unitOut };

  if (termComprehensive) {
    const e = examsObj[termComprehensive.id];
    if (!e) throw new Error('Missing term comprehensive ' + termComprehensive.id);
    const ids = e.indices.map(i => bank[i].id);
    exams[termComprehensive.id] = {
      id: termComprehensive.id, subjectId: 'philosophy', term: termNo,
      type: 'term-comprehensive', count: ids.length, title: termComprehensive.title,
      unitTitle: '', variant: 1, questionIds: ids
    };
    termEntry.termComprehensiveExamId = termComprehensive.id;
  }
  return termEntry;
}

function buildT2TermComprehensive() {
  // Term-2 comprehensive — 40 questions covering the FULL term:
  //   20 فلسفة questions: 5 per training (positions 0/12/24/36/48 of each
  //     training's bank-ordered list).
  //   20 منطق questions: proportional to training sizes (3/3/3/3/2/3/3), picked
  //     at midpoints round((j+0.5)*n/k) — deliberately different positions from
  //     T2L-COMP's endpoint spread so the two exams do not overlap wholesale.
  // Verified existing questions only.
  const philoTrainings = [
    { section: 'الفلسفة', chapter: 'الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية', training: 'تدريب 1' },
    { section: 'الفلسفة', chapter: 'الفصل الأول: الفلسفة والأخلاق البيئية والبيوطبية', training: 'تدريب 2' },
    { section: 'الفلسفة', chapter: 'الفصل الثاني: الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد', training: 'تدريب 1' },
    { section: 'الفلسفة', chapter: 'الفصل الثاني: الأخلاق المهنية ودور القيم الفلسفية في حياة الفرد', training: 'تدريب 2' }
  ];
  const logicTrainings = [
    { section: 'المنطق', chapter: 'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي', training: 'تدريب 1', k: 3 },
    { section: 'المنطق', chapter: 'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي', training: 'تدريب 2', k: 3 },
    { section: 'المنطق', chapter: 'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي', training: 'تدريب 3', k: 3 },
    { section: 'المنطق', chapter: 'الفصل الأول: الاستقراء وتطبيق المنهج التجريبي', training: 'تدريب 4', k: 3 },
    { section: 'المنطق', chapter: 'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية', training: 'تدريب 1', k: 2 },
    { section: 'المنطق', chapter: 'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية', training: 'تدريب 2', k: 3 },
    { section: 'المنطق', chapter: 'الفصل الثاني: الاستنباط وتطبيقه في العلوم الصورية', training: 'تدريب 3', k: 3 }
  ];
  const ids = [];
  philoTrainings.forEach(t => {
    const list = D.PHILO_T2_BANK.filter(q => q.section === t.section && q.chapter === t.chapter && q.training === t.training);
    if (list.length < 50) throw new Error('T2 training too small: ' + t.chapter + ' ' + t.training + ' = ' + list.length);
    [0, 12, 24, 36, 48].forEach(p => ids.push(list[p].id));
  });
  logicTrainings.forEach(t => {
    const list = D.PHILO_T2_LOGIC_BANK.filter(q => q.section === t.section && q.chapter === t.chapter && q.training === t.training);
    if (list.length < t.k) throw new Error('T2 logic training too small: ' + t.chapter + ' ' + t.training + ' = ' + list.length);
    const used = new Set();
    for (let j = 0; j < t.k; j++) {
      let p = Math.round((j + 0.5) * list.length / t.k);
      if (p > list.length - 1) p = list.length - 1;
      while (used.has(p)) p = (p + 1) % list.length;
      used.add(p);
      ids.push(list[p].id);
    }
  });
  if (new Set(ids).size !== 40) throw new Error('T2-TERM-COMP duplicates');
  exams['T2-TERM-COMP'] = {
    id: 'T2-TERM-COMP', subjectId: 'philosophy', term: 2,
    type: 'term-comprehensive', count: 40,
    title: 'الامتحان الشامل — الترم الثاني (الفلسفة والمنطق)',
    unitTitle: '', variant: 1, questionIds: ids
  };
  return 'T2-TERM-COMP';
}

/* ================================================================== *
 * Run
 * ================================================================== */
buildPsychology();
catalog.philosophy.terms.push(
  buildPhilosophyTerm(1, D.PHILO_BANK, D.PHILO_EXAMS, T1_UNITS,
    { id: 'PHLO-COMP', title: 'الامتحان الشامل — الترم الأول (الفلسفة والمنطق)' })
);

// T2 combines two .gs sources: the فلسفة bank and the NEW منطق bank
// (PhiloTerm2LogicData.gs). The logic exams' `indices` are relative to their own
// bank, so they are offset by the فلسفة bank length to live in one combined array.
const T2_BANK = D.PHILO_T2_BANK.concat(D.PHILO_T2_LOGIC_BANK);
const T2_LOGIC_OFFSET = D.PHILO_T2_BANK.length;
const T2_EXAMS = Object.assign({}, D.PHILO_T2_EXAMS);
Object.entries(D.PHILO_T2_LOGIC_EXAMS).forEach(([id, e]) => {
  T2_EXAMS[id] = Object.assign({}, e, { indices: e.indices.map(i => i + T2_LOGIC_OFFSET) });
});

const t2 = buildPhilosophyTerm(2, T2_BANK, T2_EXAMS, T2_UNITS, null);
t2.termComprehensiveExamId = buildT2TermComprehensive();
catalog.philosophy.terms.push(t2);

// Public exam metadata (no question ids, no answers).
const publicExams = {};
Object.values(exams).forEach(e => {
  publicExams[e.id] = {
    id: e.id, subjectId: e.subjectId, term: e.term, type: e.type, count: e.count,
    title: e.title, lessonNo: e.lessonNo || null, lessonTitle: e.lessonTitle || null,
    chapterTitle: e.chapterTitle || null, unitTitle: e.unitTitle || null,
    training: e.training || null, variant: e.variant || 1
  };
});

// Server-only exam definitions (question id lists). NEVER served to the browser.
const examDefs = {};
Object.values(exams).forEach(e => { examDefs[e.id] = e.questionIds; });

function keyDist(ids) {
  const d = { A: 0, B: 0, C: 0, D: 0 };
  ids.forEach(id => { d[questions[id].answer]++; });
  return d;
}

const philoT1Ids = D.PHILO_BANK.map(q => q.id);
const philoT2Ids = D.PHILO_T2_BANK.concat(D.PHILO_T2_LOGIC_BANK).map(q => q.id);
const philoT2LogicIds = D.PHILO_T2_LOGIC_BANK.map(q => q.id);
const psychIds = Object.keys(questions).filter(id => id.startsWith('PSY-'));

const banks = {
  version: 4,
  generatedAt: new Date().toISOString(),
  catalog,
  exams: publicExams,
  examDefs,
  questions,
  structure: {
    psychology: {
      examCount: Object.values(exams).filter(e => e.subjectId === 'psychology').length,
      uniqueQuestions: psychIds.length
    },
    philosophyTerm1: {
      examCount: Object.values(exams).filter(e => e.subjectId === 'philosophy' && e.term === 1).length,
      uniqueQuestions: philoT1Ids.length
    },
    philosophyTerm2: {
      examCount: Object.values(exams).filter(e => e.subjectId === 'philosophy' && e.term === 2).length,
      uniqueQuestions: philoT2Ids.length
    }
  },
  audit: {
    psychology: {
      source: 'Data.gs (بنك علم النفس — محمي، لم يُعدَّل)',
      questions: psychIds.length,
      verified: psychIds.length, authored: 0, excluded: 0,
      corrections: psychCorrectionsApplied,
      keyDistribution: keyDist(psychIds)
    },
    philosophyTerm1: {
      source: 'كتاب الامتحان 2027 (مُتحقق يدويًا — AUDIT_PHILOSOPHY.md)',
      questions: D.PHILO_BANK.length,
      verified: D.PHILO_BANK.filter(q => !q.authorCreated).length,
      authored: D.PHILO_BANK.filter(q => q.authorCreated).length,
      excluded: D.PHILO_AUDIT.quarantinedCount,
      corrected: D.PHILO_AUDIT.correctedKeys,
      keyDistribution: keyDist(philoT1Ids)
    },
    philosophyTerm2: {
      source: 'كتاب الامتحان فلسفة الترم التاني (مُتحقق يدويًا — AUDIT_PHILOSOPHY_TERM2.md)',
      questions: D.PHILO_T2_BANK.length,
      verified: D.PHILO_T2_BANK.filter(q => !q.authorCreated).length,
      authored: D.PHILO_T2_BANK.filter(q => q.authorCreated).length,
      excluded: D.PHILO_T2_AUDIT.quarantinedCount,
      corrected: D.PHILO_T2_AUDIT.correctedKeys,
      keyDistribution: keyDist(D.PHILO_T2_BANK.map(q => q.id))
    },
    philosophyTerm2Logic: {
      source: 'كتاب الامتحان فلسفة الترم التاني 2026 — أقسام المنطق (مُتحقق يدويًا — AUDIT_PHILOSOPHY_TERM2_LOGIC.md)',
      questions: D.PHILO_T2_LOGIC_BANK.length,
      verified: D.PHILO_T2_LOGIC_BANK.filter(q => !q.authorCreated).length,
      authored: D.PHILO_T2_LOGIC_BANK.filter(q => q.authorCreated).length,
      excluded: D.PHILO_T2_LOGIC_AUDIT.quarantined,
      quarantinedDetails: D.PHILO_T2_LOGIC_QUARANTINED.map(q => q.id + ': ' + q.reason),
      keyDistribution: keyDist(philoT2LogicIds)
    }
  },
  notes: {
    newExams: [
      'PSY-FULL-COMP: امتحان شامل لمنهج علم النفس كاملًا (60 سؤالًا) — 10 أسئلة لكل وحدة موزعة بالتناوب على موضوعات الوحدة (3/3/2/2) بمواقع متباعدة ثابتة؛ أسئلة موثقة قائمة فقط، دون أي سؤال جديد.',
      'T2-TERM-COMP: امتحان شامل للترم الثاني كاملًا (40 سؤالًا) — 20 سؤال فلسفة (5 لكل تدريب بالمواضع 0/12/24/36/48) + 20 سؤال منطق بنسب أحجام التدريبات (3/3/3/3/2/3/3) بمواضع منتصف مختلفة عن امتحان شامل الوحدة؛ أسئلة موثقة قائمة فقط.',
      'T2L-* (8 امتحانات): وحدة المنطق للترم الثاني — 7 امتحانات تدريبات (20 سؤالًا لكل تدريب بتوزيع متساوٍ على ترتيب بنك التدريب) + امتحان شامل الوحدة T2L-COMP (20 سؤالًا بنسبة أحجام التدريبات). المصدر: كتاب الامتحان — أقسام المنطق، مع 6 أسئلة مستبعدة موثقة الأسباب و5 أسئلة مؤلفة من المنهج لاستكمال تدريب النسق.'
    ],
    curriculumAlignment: 'هيكل الفلسفة (الوحدات/الفصول) مطابق لكتاب الشرح الرسمي لوزارة التربية والتعليم (أولى ثانوي)؛ فلسفة الترم الثاني وفق المطابقة الموثقة في AUDIT_PHILOSOPHY_TERM2.md، ومنطق الترم الثاني وفق عناوين فصول وتدريبات كتاب الأسئلة الرسمي (موثقة في AUDIT_PHILOSOPHY_TERM2_LOGIC.md).',
    knownIssue: 'U2-T1 يحتوي 6 أسئلة مكررة داخل الامتحان (موروثة من المصدر المحمي Data.gs وحُفظت كما هي بعد توحيد مفاتيحها المتناقضة) — موثقة في AUDIT_EDUCATIONAL_V2.md.',
    contentGap: 'أُغلقت فجوة منطق الترم الثاني (سبتمبر 2026): أُضيفت وحدة المنطق كاملة (203 سؤالًا مستخرجًا من كتاب الأسئلة، 197 موثقة + 5 مؤلفة + 6 مستبعدة موثقة) — راجع AUDIT_PHILOSOPHY_TERM2_LOGIC.md. الاختبارات الشهرية في كتاب المصدر استُبعدت عمدًا لتجنب تكرار أسئلة التدريبات.'
  }
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(banks));

console.log('=== banks.json generated ===');
console.log('Psychology key corrections applied:', psychCorrectionsApplied.length);
psychCorrectionsApplied.forEach(c => console.log('  ', c.exam, 'Q' + c.q, c.from + ' → ' + c.to));
console.log('Questions (unique):', Object.keys(questions).length);
console.log('  psychology:', psychIds.length, '| philo T1:', philoT1Ids.length, '| philo T2:', philoT2Ids.length);
console.log('Exams:', Object.keys(exams).length,
  '(psych:', banks.structure.psychology.examCount,
  '| philo T1:', banks.structure.philosophyTerm1.examCount,
  '| philo T2:', banks.structure.philosophyTerm2.examCount + ')');
console.log('Output:', OUT, '(' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
