/**
 * منصة الامتحانات التعليمية — Master Web App (متعددة المواد)
 * رابط واحد | علم النفس + الفلسفة والمنطق
 *
 * - بنك أسئلة علم النفس: Data.gs (EXAMS / CATALOG) — 30 امتحانًا / 840 سؤالًا.
 * - بنك أسئلة الفلسفة والمنطق: PhiloData.gs (PHILO_BANK / PHILO_EXAMS).
 * - إعدادات الهوية والشكل والـPIN تُحفظ في Script Properties وتُدار من لوحة التحكم.
 * - التصحيح يتم بالكامل على الخادم، ولا يصل مفتاح الإجابة إلى المتصفح أبدًا.
 * - الجلسة موقَّعة رقميًا (HMAC) ولا تعتمد على ذاكرة مؤقتة لصحة التصحيح.
 */

const DEFAULT_SETTINGS = {
  teacherName: 'د. مصطفى تيتو',
  subjectName: 'الفلسفة والمنطق',
  gradeName: 'المرحلة الثانوية',
  academicYear: 'العام الدراسي 2026 / 2027',
  appTitle: 'منصة الامتحانات التعليمية',
  subtitle: 'علم النفس · الفلسفة والمنطق — اختبارات المنهج الدراسي',
  logoText: 'EDU',
  primaryColor: '#123B40',
  accentColor: '#C9A86A',
  welcomeText: 'اختر المادة ثم ابدأ الامتحان.',
  requirePhone: true,
  adminPin: '1234'
};

const RESULTS_SHEET_NAME = 'النتائج';
const SESSION_TTL_SECONDS = 21600; // 6 ساعات

const SUBJECTS = [
  { id: 'psychology', name: 'علم النفس', gradeName: 'المرحلة الثانوية', academicYear: 'العام الدراسي 2026 / 2027', color: '#123B40' },
  { id: 'philosophy', name: 'الفلسفة والمنطق', gradeName: 'أولى ثانوي', academicYear: '2027', color: '#7a5c2e' }
];

/**
 * نقطة الدخول الوحيدة للتطبيق.
 * الطالب:  /exec
 * الأدمن:  /exec?page=admin  (وأيضًا ?mode=admin أو ?admin=1)
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const requested = String(params.page || params.mode || '').toLowerCase().trim();
  const isAdmin = requested === 'admin' || String(params.admin || '') === '1';
  const fileName = isAdmin ? 'Admin' : 'Index';

  try {
    return HtmlService
      .createTemplateFromFile(fileName)
      .evaluate()
      .setTitle(isAdmin ? 'لوحة تحكم المنصة' : getSettings_().appTitle)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:760px;margin:60px auto;padding:30px;line-height:2">' +
      '<h2>تعذر فتح صفحة المنصة</h2>' +
      '<p>الملف المطلوب: <b>' + fileName + '.html</b></p>' +
      '<p>تأكد من وجود الملف داخل مشروع Apps Script ثم احفظ وأنشئ إصدار Deployment جديد.</p>' +
      '</div>'
    );
  }
}

/**
 * بيانات الواجهة العامة (الهوية + المواد + الكتالوجات) — بدون أي بيانات حساسة.
 */
function getAppData() {
  const s = getSettings_();
  const catalog = CATALOG.map(function (x) {
    const m = String(x.id).match(/^U(\d+)-T(\d+)$/);
    return Object.assign({}, x, {
      topicNo: m ? Number(m[2]) : 0,
      typeLabel: x.type === 'comprehensive' ? 'امتحان الوحدة الشامل' : ('الموضوع ' + (m ? m[2] : ''))
    });
  }).sort(function (a, b) {
    if (Number(a.unit) !== Number(b.unit)) return Number(a.unit) - Number(b.unit);
    if (a.type === 'comprehensive' && b.type !== 'comprehensive') return 1;
    if (a.type !== 'comprehensive' && b.type === 'comprehensive') return -1;
    return Number(a.topicNo) - Number(b.topicNo);
  });

  return {
    teacherName: s.teacherName,
    subjectName: s.subjectName,
    gradeName: s.gradeName,
    academicYear: s.academicYear,
    appTitle: s.appTitle,
    subtitle: s.subtitle,
    logoText: s.logoText,
    primaryColor: s.primaryColor,
    accentColor: s.accentColor,
    welcomeText: s.welcomeText,
    requirePhone: s.requirePhone,
    subjects: SUBJECTS,
    catalog: catalog,
    philoCatalog: getPhiloCatalog_()
  };
}

function getPhiloCatalog_() {
  const sectionDefs = [
    { name: 'الفلسفة', chapters: ['الفصل الأول: التفكير الإنساني', 'الفصل الثاني: الفلسفة وطبيعة الموقف الفلسفي'] },
    { name: 'المنطق', chapters: ['الفصل الأول: مبادئ علم المنطق', 'الفصل الثاني: الاستدلال'] }
  ];
  const sections = [];
  sectionDefs.forEach(function (sd) {
    const sec = { name: sd.name, chapters: [] };
    sd.chapters.forEach(function (chName) {
      const exams = [];
      Object.keys(PHILO_EXAMS).forEach(function (eid) {
        const e = PHILO_EXAMS[eid];
        if (e.type === 'training' && e.section === sd.name && e.chapter === chName) {
          exams.push({ id: eid, title: e.title, count: 20, type: 'training', training: e.training, chapter: e.chapter, section: e.section });
        }
      });
      exams.sort(function (a, b) {
        return (Number(String(a.training).replace(/\D/g, '')) || 0) - (Number(String(b.training).replace(/\D/g, '')) || 0);
      });
      sec.chapters.push({ name: chName, exams: exams });
    });
    const comps = [];
    Object.keys(PHILO_EXAMS).forEach(function (eid) {
      const e = PHILO_EXAMS[eid];
      if (e.type === 'comprehensive' && e.section === sd.name) {
        comps.push({ id: eid, title: e.title, count: 20, type: 'comprehensive', section: e.section });
      }
    });
    if (comps.length) sec.comprehensives = comps;
    sections.push(sec);
  });
  const full = [];
  Object.keys(PHILO_EXAMS).forEach(function (eid) {
    const e = PHILO_EXAMS[eid];
    if (e.type === 'comprehensive' && e.section === 'الفلسفة والمنطق') {
      full.push({ id: eid, title: e.title, count: 20, type: 'comprehensive' });
    }
  });
  return { sections: sections, fullComprehensive: full };
}

/**
 * فتح امتحان (علم النفس أو الفلسفة والمنطق).
 * تُخلط الاختيارات على الخادم، ولا يُرسل مفتاح الإجابة أبدًا.
 */
function getExam(subjectId, examId) {
  // توافق خلفي: getExam(examId) تعني مادة علم النفس.
  if (examId === undefined || examId === null) {
    examId = subjectId;
    subjectId = 'psychology';
  }
  if (subjectId === undefined || subjectId === null || subjectId === '') subjectId = 'psychology';
  if (subjectId !== 'psychology' && subjectId !== 'philosophy') throw new Error('المادة غير معروفة.');

  const raw = getRawQuestions_(subjectId, examId);
  const sessionId = Utilities.getUuid();
  const seed = randomSeed_();

  const questions = raw.map(function (q, i) {
    const order = shuffledOrder_(seed, i);
    return {
      n: i + 1,
      question: q.question,
      options: order.map(function (letter, idx) {
        return { id: String(idx), text: stripOptionLabel_(q[letter]) };
      })
    };
  });

  const signature = signSession_(sessionId, subjectId, examId, seed);

  try {
    CacheService.getScriptCache().put('S:' + sessionId, JSON.stringify({
      subjectId: subjectId,
      examId: examId,
      seed: String(seed),
      submitted: false,
      at: Date.now()
    }), SESSION_TTL_SECONDS);
  } catch (e) { /* تجاهل */ }

  return {
    subjectId: subjectId,
    examId: examId,
    sessionId: sessionId,
    seed: seed,
    sig: signature,
    total: raw.length,
    questions: questions
  };
}

/**
 * الأسئلة الخام (النص + الاختيارات + الإجابة) لمادة وامتحان معينين — للاستخدام الخادمي فقط.
 */
function getRawQuestions_(subjectId, examId) {
  if (subjectId === 'philosophy') {
    const def = PHILO_EXAMS[examId];
    if (!def) throw new Error('الامتحان غير موجود.');
    return def.indices.map(function (i) {
      const q = PHILO_BANK[i];
      if (!q) throw new Error('بيانات الامتحان غير مكتملة.');
      return { question: q.question, A: q.A, B: q.B, C: q.C, D: q.D, answer: q.correctAnswer };
    });
  }
  if (!EXAMS[examId]) throw new Error('الامتحان غير موجود.');
  return EXAMS[examId];
}

/**
 * تسليم الامتحان وتصحيحه بالكامل على الخادم.
 */
function submitExam(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('بيانات التسليم غير صحيحة.');

  const subjectId = String(payload.subjectId || 'psychology');
  if (subjectId !== 'psychology' && subjectId !== 'philosophy') throw new Error('المادة غير معروفة.');
  const examId = String(payload.examId || '');

  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  if (!name) throw new Error('اسم الطالب مطلوب.');
  if (name.length > 120) throw new Error('اسم الطالب طويل جدًا.');
  if (getSettings_().requirePhone && !phone) throw new Error('رقم الهاتف مطلوب.');
  if (phone && !/^[0-9+\- ]{4,25}$/.test(phone)) throw new Error('رقم الهاتف غير صالح.');

  const sessionId = String(payload.sessionId || '');
  const seed = Number(payload.seed);
  if (!sessionId || !isFinite(seed) || seed <= 0) throw new Error('جلسة الامتحان غير صالحة. أعد فتح الامتحان.');
  if (String(payload.sig || '') !== signSession_(sessionId, subjectId, examId, seed)) {
    throw new Error('جلسة الامتحان غير صالحة. أعد فتح الامتحان.');
  }

  // منع التسليم المكرر (أفضل جهد): إعادة نفس النتيجة دون حفظ صف جديد.
  const cache = CacheService.getScriptCache();
  const sessionKey = 'S:' + sessionId;
  const cached = cache.get(sessionKey);
  if (cached) {
    try {
      const sess = JSON.parse(cached);
      if (sess && sess.submitted && sess.result) return sess.result;
    } catch (e) { /* تجاهل */ }
  }

  const exam = getRawQuestions_(subjectId, examId);
  const answers = (payload.answers && typeof payload.answers === 'object') ? payload.answers : {};
  let score = 0;
  const detail = [];

  exam.forEach(function (q, i) {
    const order = shuffledOrder_(seed, i);
    const correctId = String(order.indexOf(q.answer));
    const selected = String(answers[String(i + 1)] || '');
    const isCorrect = selected !== '' && selected === correctId;
    if (isCorrect) score++;
    detail.push({ n: i + 1, selected: selected, correct: correctId, isCorrect: isCorrect });
  });

  const total = exam.length;
  const percentage = Math.round((score / total) * 1000) / 10;
  const meta = getExamMeta_(subjectId, examId);

  saveResult_(payload, meta, score, total, percentage, detail, subjectId);

  const result = {
    score: score,
    total: total,
    percentage: percentage,
    examTitle: meta.title || examId,
    subject: meta.subject,
    subjectId: subjectId,
    unit: meta.unit,
    chapter: meta.chapter || '',
    training: meta.training || '',
    examType: meta.examType,
    dateTime: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  };

  try {
    cache.put(sessionKey, JSON.stringify({
      subjectId: subjectId,
      examId: examId,
      seed: String(seed),
      submitted: true,
      result: result
    }), SESSION_TTL_SECONDS);
  } catch (e) { /* تجاهل */ }

  return result;
}

function getExamMeta_(subjectId, examId) {
  if (subjectId === 'philosophy') {
    const def = PHILO_EXAMS[examId];
    return {
      subject: 'الفلسفة والمنطق',
      unit: def.section,
      examType: def.type === 'comprehensive' ? 'comprehensive' : 'training',
      typeLabel: def.type === 'comprehensive' ? 'شامل' : 'تدريب',
      title: def.title,
      chapter: def.chapter || '',
      training: def.type === 'comprehensive' ? 'شامل' : (def.training || '')
    };
  }
  const meta = CATALOG.find(function (x) { return x.id === examId; }) || {};
  return {
    subject: 'علم النفس',
    unit: String(meta.unit || ''),
    examType: meta.type || '',
    typeLabel: meta.type === 'comprehensive' ? 'شامل' : 'موضوع',
    title: meta.title || examId,
    chapter: '',
    training: meta.type === 'comprehensive' ? 'شامل' : (meta.title || '')
  };
}

/* ============================== النتائج ============================== */

function saveResult_(payload, meta, score, total, percentage, detail, subjectId) {
  const sheet = getResultsSheet_();
  const examLabel = meta.chapter
    ? (meta.title + ' — ' + meta.chapter)
    : meta.title;
  sheet.appendRow([
    new Date(),
    String(payload.name || '').trim(),
    String(payload.phone || '').trim(),
    meta.unit || '',
    meta.typeLabel || '',
    examLabel,
    total,
    score,
    percentage,
    JSON.stringify(detail),
    meta.subject || (subjectId === 'philosophy' ? 'الفلسفة والمنطق' : 'علم النفس')
  ]);
}

function ensureResultHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'التاريخ والوقت', 'اسم الطالب', 'رقم الهاتف', 'الوحدة / القسم', 'نوع الامتحان',
      'الامتحان', 'عدد الأسئلة', 'الدرجة', 'النسبة %', 'تفاصيل الإجابات', 'المادة'
    ]);
    sheet.setFrozenRows(1);
  }
}

/**
 * إرجاع ورقة النتائج المعيارية، مع إنشائها/إعادة تسميتها إذا لزم الأمر.
 */
function getResultsSheet_() {
  return getResultsSheetOf_(getResultsSpreadsheet_());
}

function getResultsSheetOf_(ss) {
  let sheet = null;
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === RESULTS_SHEET_NAME) { sheet = sheets[i]; break; }
  }
  if (!sheet) {
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheets[0].setName(RESULTS_SHEET_NAME);
      sheet = sheets[0];
    } else {
      sheet = ss.insertSheet(RESULTS_SHEET_NAME);
    }
  }
  ensureResultHeader_(sheet);
  return sheet;
}

function getResultsSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('RESULTS_SPREADSHEET_ID');
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(getSettings_().appTitle + ' — النتائج');
    props.setProperty('RESULTS_SPREADSHEET_ID', ss.getId());
  }
  return ss;
}

function getResultsLink() {
  return getResultsSpreadsheet_().getUrl();
}

/* ============================== لوحة التحكم ============================== */

/**
 * إعدادات المدرس — لا يُعاد رمز الـPIN إلى المتصفح.
 */
function getTeacherSettings(pin) {
  assertAdmin_(pin);
  return getPublicSettings_();
}

function saveTeacherSettings(pin, incoming) {
  assertAdmin_(pin);
  const current = getSettings_();
  const next = Object.assign({}, current);

  const allowed = [
    'teacherName', 'subjectName', 'gradeName', 'academicYear', 'appTitle',
    'subtitle', 'logoText', 'primaryColor', 'accentColor', 'welcomeText'
  ];
  allowed.forEach(function (k) {
    if (incoming && incoming[k] !== undefined) next[k] = String(incoming[k]).trim();
  });

  if (incoming && incoming.requirePhone !== undefined && incoming.requirePhone !== null) {
    next.requirePhone = (incoming.requirePhone === true ||
      String(incoming.requirePhone) === 'true' ||
      String(incoming.requirePhone) === '1');
  }

  if (incoming && incoming.newAdminPin !== undefined && String(incoming.newAdminPin).trim() !== '') {
    next.adminPin = String(incoming.newAdminPin).trim();
  }

  validateSettings_(next);
  PropertiesService.getScriptProperties().setProperty('APP_SETTINGS', JSON.stringify(next));
  return getPublicSettings_();
}

/**
 * قراءة كل صفوف النتائج (خادميًا) مع عمود المادة.
 */
function readAllResults_() {
  const ss = getResultsSpreadsheet_();
  const sheet = getResultsSheetOf_(ss);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  return values.map(function (r) {
    return {
      date: r[0] instanceof Date ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(r[0] || ''),
      name: String(r[1] || ''),
      phone: String(r[2] || ''),
      unit: String(r[3] || ''),
      type: String(r[4] || ''),
      exam: String(r[5] || ''),
      total: Number(r[6]) || 0,
      score: Number(r[7]) || 0,
      percentage: Number(r[8]) || 0,
      subject: String(r[10] || '') || 'علم النفس'
    };
  }).reverse();
}

function getDashboardData(pin, filter) {
  assertAdmin_(pin);
  const link = getResultsSpreadsheet_().getUrl();
  const all = readAllResults_();
  const subjectFilter = (filter && filter.subject) ? String(filter.subject) : '';
  const rows = subjectFilter ? all.filter(function (r) { return r.subject === subjectFilter; }) : all;

  const attempts = rows.length;
  const students = new Set(rows.map(function (r) { return (r.name + '|' + r.phone).trim(); })).size;
  const avg = attempts ? Math.round(rows.reduce(function (a, r) { return a + r.percentage; }, 0) / attempts * 10) / 10 : 0;
  const max = attempts ? Math.max.apply(null, rows.map(function (r) { return r.percentage; })) : 0;
  const last = attempts ? rows[0].date : '';

  return {
    link: link,
    rows: rows.slice(0, 1000),
    stats: { students: students, attempts: attempts, avg: avg, max: max, last: last }
  };
}

/**
 * نظرة عامة متعددة المواد.
 */
function getAdminOverview(pin) {
  assertAdmin_(pin);
  const all = readAllResults_();

  const psychRows = all.filter(function (r) { return r.subject === 'علم النفس'; });
  const philoRows = all.filter(function (r) { return r.subject === 'الفلسفة والمنطق'; });

  function statsOf(rows) {
    const attempts = rows.length;
    const students = new Set(rows.map(function (r) { return (r.name + '|' + r.phone).trim(); })).size;
    const avg = attempts ? Math.round(rows.reduce(function (a, r) { return a + r.percentage; }, 0) / attempts * 10) / 10 : 0;
    return { attempts: attempts, students: students, avg: avg };
  }

  const psychExamCount = Object.keys(EXAMS).length;
  const psychQuestionCount = Object.keys(EXAMS).reduce(function (s, id) { return s + EXAMS[id].length; }, 0);

  const philoTrainingCount = Object.keys(PHILO_EXAMS).filter(function (k) { return PHILO_EXAMS[k].type === 'training'; }).length;
  const philoCompCount = Object.keys(PHILO_EXAMS).filter(function (k) { return PHILO_EXAMS[k].type === 'comprehensive'; }).length;
  const philoChapters = PHILO_AUDIT ? (PHILO_AUDIT.chapters || 4) : 4;

  return {
    link: getResultsSpreadsheet_().getUrl(),
    subjects: {
      psychology: {
        id: 'psychology',
        name: 'علم النفس',
        exams: psychExamCount,
        questions: psychQuestionCount,
        comprehensive: 6,
        topicExams: 24,
        verified: psychQuestionCount,
        excluded: 0,
        corrected: 0,
        generated: 0,
        stats: statsOf(psychRows)
      },
      philosophy: {
        id: 'philosophy',
        name: 'الفلسفة والمنطق',
        sourceQuestions: PHILO_AUDIT ? PHILO_AUDIT.sourceCount : 563,
        questions: PHILO_BANK.length,
        verified: PHILO_BANK.length,
        excluded: PHILO_AUDIT ? PHILO_AUDIT.quarantinedCount : 0,
        corrected: PHILO_AUDIT ? PHILO_AUDIT.correctedKeys : 0,
        generated: PHILO_AUDIT ? (PHILO_AUDIT.generatedQuestions || 0) : 0,
        chapters: philoChapters,
        trainings: philoTrainingCount,
        exams: philoTrainingCount + philoCompCount,
        comprehensive: philoCompCount,
        stats: statsOf(philoRows)
      }
    }
  };
}

/**
 * بنك الأسئلة للمدير (مع مفتاح الإجابة — للمدير فقط).
 */
function getQuestionBank(pin, filter) {
  assertAdmin_(pin);
  const f = filter || {};
  const subject = String(f.subject || 'philosophy');
  const q = String(f.q || '').trim().toLowerCase();
  const chapter = String(f.chapter || '');
  const training = String(f.training || '');
  const difficulty = String(f.difficulty || '');
  const status = String(f.status || '');

  let out = [];
  if (subject === 'psychology') {
    Object.keys(EXAMS).forEach(function (examId) {
      const meta = CATALOG.find(function (x) { return x.id === examId; }) || {};
      EXAMS[examId].forEach(function (qq, i) {
        out.push({
          id: examId + '-Q' + (i + 1),
          subject: 'علم النفس',
          section: 'الوحدة ' + (meta.unit || ''),
          chapter: meta.title || examId,
          training: meta.type === 'comprehensive' ? 'شامل' : ('الموضوع ' + (String(examId).match(/T(\d+)/) ? String(examId).match(/T(\d+)/)[1] : '')) ,
          question: qq.question,
          A: qq.A, B: qq.B, C: qq.C, D: qq.D,
          correctAnswer: qq.answer,
          difficulty: '',
          source: 'بنك علم النفس',
          verificationStatus: 'verified'
        });
      });
    });
  } else {
    out = PHILO_BANK.map(function (qq) {
      return {
        id: qq.id,
        subject: 'الفلسفة والمنطق',
        section: qq.section,
        chapter: qq.chapter,
        training: qq.training,
        question: qq.question,
        A: qq.A, B: qq.B, C: qq.C, D: qq.D,
        correctAnswer: qq.correctAnswer,
        difficulty: qq.difficulty,
        source: qq.source,
        verificationStatus: qq.verificationStatus
      };
    });
  }

  if (chapter) out = out.filter(function (x) { return x.chapter === chapter; });
  if (training) out = out.filter(function (x) { return x.training === training; });
  if (difficulty) out = out.filter(function (x) { return x.difficulty === difficulty; });
  if (status) out = out.filter(function (x) { return x.verificationStatus === status; });
  if (q) {
    out = out.filter(function (x) {
      return (x.question + ' ' + x.chapter + ' ' + x.training).toLowerCase().indexOf(q) !== -1;
    });
  }

  return { count: out.length, rows: out.slice(0, 500) };
}

/**
 * خيارات الفلترة المتاحة لبنك الأسئلة (للإدارة فقط).
 */
function getBankFilterOptions(pin, subject) {
  assertAdmin_(pin);
  const subj = String(subject || 'philosophy');
  if (subj === 'psychology') {
    const chapters = [];
    const seen = new Set();
    CATALOG.forEach(function (c) {
      const label = 'الوحدة ' + c.unit + ' · ' + c.title;
      if (!seen.has(label)) { seen.add(label); chapters.push(label); }
    });
    return { chapters: chapters, trainings: [], difficulties: [], statuses: ['verified'] };
  }
  const chapters = [];
  const trainings = [];
  const difficulties = [];
  const statuses = [];
  const seenC = new Set(); const seenT = new Set(); const seenD = new Set(); const seenS = new Set();
  PHILO_BANK.forEach(function (q) {
    if (!seenC.has(q.chapter)) { seenC.add(q.chapter); chapters.push(q.chapter); }
    if (!seenT.has(q.training)) { seenT.add(q.training); trainings.push(q.training); }
    if (!seenD.has(q.difficulty)) { seenD.add(q.difficulty); difficulties.push(q.difficulty); }
    if (!seenS.has(q.verificationStatus)) { seenS.add(q.verificationStatus); statuses.push(q.verificationStatus); }
  });
  return { chapters: chapters, trainings: trainings, difficulties: difficulties, statuses: statuses };
}

/**
 * هرم الامتحانات للمدير.
 */
function getExamHierarchy(pin, subject) {
  assertAdmin_(pin);
  const subj = String(subject || 'philosophy');
  if (subj === 'psychology') {
    return {
      subject: 'علم النفس',
      exams: CATALOG.map(function (c) {
        return {
          id: c.id, title: c.title, count: c.count,
          type: c.type === 'comprehensive' ? 'comprehensive' : 'topic',
          unit: c.unit, typeLabel: c.type === 'comprehensive' ? 'امتحان شامل' : 'موضوع',
          status: 'نشط'
        };
      })
    };
  }
  const exams = Object.keys(PHILO_EXAMS).map(function (eid) {
    const e = PHILO_EXAMS[eid];
    const diffs = {};
    e.indices.forEach(function (i) {
      const q = PHILO_BANK[i];
      const d = q.difficulty || 'medium';
      diffs[d] = (diffs[d] || 0) + 1;
    });
    return {
      id: eid, title: e.title, count: e.indices.length,
      type: e.type, section: e.section, chapter: e.chapter, training: e.training,
      difficulty: diffs, status: 'نشط'
    };
  });
  return { subject: 'الفلسفة والمنطق', exams: exams, audit: PHILO_AUDIT, quarantined: PHILO_QUARANTINED };
}

function getPhiloAudit(pin) {
  assertAdmin_(pin);
  return { audit: PHILO_AUDIT, quarantined: PHILO_QUARANTINED };
}

/* ============================== إعداد النظام ============================== */

function initializeSystem() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_SETTINGS')) {
    props.setProperty('APP_SETTINGS', JSON.stringify(DEFAULT_SETTINGS));
  }
  getSecret_();
  const ss = getResultsSpreadsheet_();
  getResultsSheetOf_(ss);
  Logger.log('تم تجهيز النظام. رابط النتائج: ' + ss.getUrl());
  return 'تم تجهيز النظام بنجاح.';
}

/**
 * فحص سلامة بنك علم النفس: 30 امتحانًا / 840 سؤالًا.
 */
function validateSystem() {
  const ids = Object.keys(EXAMS);
  const total = ids.reduce(function (sum, id) { return sum + EXAMS[id].length; }, 0);
  if (ids.length !== 30) throw new Error('عدد امتحانات علم النفس = ' + ids.length + ' وليس 30.');
  if (total !== 840) throw new Error('عدد أسئلة علم النفس = ' + total + ' وليس 840.');

  ids.forEach(function (id) {
    const n = EXAMS[id].length;
    if (n !== 20 && n !== 60) throw new Error(id + ': عدد الأسئلة غير صحيح: ' + n);
    EXAMS[id].forEach(function (q, i) {
      ['question', 'A', 'B', 'C', 'D', 'answer'].forEach(function (k) {
        if (!q[k]) throw new Error(id + ' السؤال ' + (i + 1) + ': الحقل ' + k + ' ناقص.');
      });
      if (['A', 'B', 'C', 'D'].indexOf(q.answer) === -1) {
        throw new Error(id + ' السؤال ' + (i + 1) + ': مفتاح إجابة غير صحيح.');
      }
    });
  });

  const catIds = CATALOG.map(function (c) { return c.id; });
  ids.forEach(function (id) {
    if (catIds.indexOf(id) === -1) throw new Error('الامتحان ' + id + ' غير موجود في الكتالوج.');
    const c = CATALOG.filter(function (x) { return x.id === id; })[0] || {};
    if (EXAMS[id].length !== c.count) throw new Error('عدد أسئلة ' + id + ' لا يطابق الكتالوج.');
  });

  Logger.log('نجاح التحقق: علم النفس 30 امتحانًا / 840 سؤالًا.');
  return 'نجاح التحقق: علم النفس 30 امتحانًا / 840 سؤالًا.';
}

/**
 * فحص سلامة بنك الفلسفة والمنطق.
 */
function validatePhiloSystem() {
  if (!PHILO_BANK || !PHILO_BANK.length) throw new Error('بنك الفلسفة والمنطق فارغ.');
  if (PHILO_BANK.length !== 555) throw new Error('عدد أسئلة الفلسفة والمنطق = ' + PHILO_BANK.length + ' وليس 555.');

  const ids = new Set();
  PHILO_BANK.forEach(function (q, i) {
    if (!q.id) throw new Error('سؤال بدون معرف (فهرس ' + i + ').');
    if (ids.has(q.id)) throw new Error('معرف مكرر: ' + q.id);
    ids.add(q.id);
    ['question', 'A', 'B', 'C', 'D', 'correctAnswer'].forEach(function (k) {
      if (!q[k]) throw new Error(q.id + ': الحقل ' + k + ' ناقص.');
    });
    if (['A', 'B', 'C', 'D'].indexOf(q.correctAnswer) === -1) throw new Error(q.id + ': مفتاح إجابة غير صحيح.');
    if (q.verificationStatus !== 'verified') throw new Error(q.id + ': حالة تحقق غير نهائية.');
  });

  const examIds = Object.keys(PHILO_EXAMS);
  const trainings = examIds.filter(function (k) { return PHILO_EXAMS[k].type === 'training'; });
  const comps = examIds.filter(function (k) { return PHILO_EXAMS[k].type === 'comprehensive'; });
  if (trainings.length !== 9) throw new Error('عدد امتحانات التدريب = ' + trainings.length + ' وليس 9.');
  if (comps.length !== 3) throw new Error('عدد الامتحانات الشاملة = ' + comps.length + ' وليس 3.');

  examIds.forEach(function (k) {
    const e = PHILO_EXAMS[k];
    if (e.indices.length !== 20) throw new Error(k + ': عدد الأسئلة = ' + e.indices.length + ' وليس 20.');
    const uniq = new Set(e.indices);
    if (uniq.size !== 20) throw new Error(k + ': تكرار أسئلة داخل الامتحان.');
    e.indices.forEach(function (i) {
      if (i < 0 || i >= PHILO_BANK.length) throw new Error(k + ': فهرس خارج النطاق.');
    });
  });

  Logger.log('نجاح التحقق: الفلسفة والمنطق 555 سؤالًا / 12 امتحانًا.');
  return 'نجاح التحقق: الفلسفة والمنطق 555 سؤالًا / 12 امتحانًا (9 تدريبات + 3 شاملة).';
}

/* ============================== الإعدادات ============================== */

function getSettings_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('APP_SETTINGS');
  if (!raw) {
    props.setProperty('APP_SETTINGS', JSON.stringify(DEFAULT_SETTINGS));
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  try {
    const s = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    validateSettings_(s);
    return s;
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function getPublicSettings_() {
  const s = getSettings_();
  const out = {};
  Object.keys(s).forEach(function (k) { if (k !== 'adminPin') out[k] = s[k]; });
  return out;
}

function validateSettings_(s) {
  ['teacherName', 'subjectName', 'appTitle', 'subtitle'].forEach(function (k) {
    if (!String(s[k] || '').trim()) throw new Error('الإعداد ' + k + ' مطلوب.');
  });
  ['primaryColor', 'accentColor'].forEach(function (k) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(s[k] || ''))) throw new Error('لون غير صالح: ' + k);
  });
  const pin = String(s.adminPin || '').trim();
  if (!pin) throw new Error('رمز لوحة التحكم لا يمكن أن يكون فارغًا.');
  if (pin.length > 64) throw new Error('رمز لوحة التحكم طويل جدًا.');
}

function assertAdmin_(pin) {
  if (String(pin || '') !== String(getSettings_().adminPin)) {
    throw new Error('رمز لوحة التحكم غير صحيح.');
  }
}

/* ============================== أدوات الجلسة والتوقيع ============================== */

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid() + String(Date.now());
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function signSession_(sessionId, subjectId, examId, seed) {
  const value = sessionId + '|' + subjectId + '|' + examId + '|' + String(seed);
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(value, getSecret_()));
}

function randomSeed_() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

/**
 * مولّد أرقام شبه عشوائي حتمي (mulberry32).
 */
function prng_(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledOrder_(seed, index) {
  const rng = prng_((seed ^ Math.imul(index + 1, 2654435761)) >>> 0);
  const arr = ['A', 'B', 'C', 'D'];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/* ============================== أدوات عامة ============================== */

function stripOptionLabel_(text) {
  // يزيل بادئات الحروف (أ/ب/ج/د أو A/B/C/D) سواء تبعتها أقواس/نقط أو مسافة فقط.
  return String(text || '').replace(/^\s*[أابجدهدABCDabcd][\s\)\].\-:：]+\s*/, '').trim();
}
