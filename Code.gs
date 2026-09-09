/**
 * منصة الامتحانات — Master Web App (نسخة محسّنة)
 * رابط واحد | 6 وحدات | 30 امتحانًا | 840 سؤالًا
 *
 * - بنك الأسئلة (EXAMS / CATALOG) موجود في Data.gs ولا يُعدَّل من هنا.
 * - إعدادات الهوية والشكل والـPIN تُحفظ في Script Properties وتُدار من لوحة التحكم.
 * - التصحيح يتم بالكامل على الخادم، ولا يصل مفتاح الإجابة إلى المتصفح أبدًا.
 * - الجلسة موقَّعة رقميًا (HMAC) ولا تعتمد على ذاكرة مؤقتة لصحة التصحيح.
 */

const DEFAULT_SETTINGS = {
  teacherName: 'د. مصطفى تيتو',
  subjectName: 'علم النفس',
  gradeName: 'المرحلة الثانوية',
  academicYear: 'العام الدراسي 2026 / 2027',
  appTitle: 'منصة امتحانات علم النفس',
  subtitle: 'اختبارات شاملة على المنهج الدراسي',
  logoText: 'PSY',
  primaryColor: '#123B40',
  accentColor: '#C9A86A',
  welcomeText: 'اختر الوحدة ثم اختر الدرس أو الامتحان الشامل.',
  requirePhone: true,
  adminPin: '1234'
};

const RESULTS_SHEET_NAME = 'النتائج';
const SESSION_TTL_SECONDS = 21600; // 6 ساعات

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
 * بيانات الواجهة العامة (الهوية + كتالوج الامتحانات) — بدون أي بيانات حساسة.
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
    catalog: catalog
  };
}

/**
 * فتح امتحان: يُخلط ترتيب الاختيارات على الخادم، ولا يُرسل مفتاح الإجابة أبدًا.
 * تُوقَّع الجلسة رقميًا حتى لا يمكن تزويرها، ولا تعتمد صحة التصحيح على أي ذاكرة مؤقتة.
 */
function getExam(examId) {
  if (!EXAMS[examId]) throw new Error('الامتحان غير موجود.');

  const sessionId = Utilities.getUuid();
  const seed = randomSeed_();
  const exam = EXAMS[examId];

  const questions = exam.map(function (q, i) {
    const order = shuffledOrder_(seed, i);
    return {
      n: i + 1,
      question: q.question,
      options: order.map(function (letter, idx) {
        return { id: String(idx), text: stripOptionLabel_(q[letter]) };
      })
    };
  });

  const signature = signSession_(sessionId, examId, seed);

  // تُستخدم الذاكرة المؤقتة فقط لمنع التسليم المكرر، وليس لصحة التصحيح.
  try {
    CacheService.getScriptCache().put('S:' + sessionId, JSON.stringify({
      examId: examId,
      seed: String(seed),
      submitted: false,
      at: Date.now()
    }), SESSION_TTL_SECONDS);
  } catch (e) { /* تجاهل: لا تؤثر على صحة التصحيح */ }

  return {
    examId: examId,
    sessionId: sessionId,
    seed: seed,
    sig: signature,
    total: exam.length,
    questions: questions
  };
}

/**
 * تسليم الامتحان وتصحيحه بالكامل على الخادم.
 * يعيد حساب ترتيب الاختيارات من بذرة الجلسة، ويقارن الإجابة الصحيحة من Data.gs فقط.
 */
function submitExam(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('بيانات التسليم غير صحيحة.');

  const examId = String(payload.examId || '');
  if (!EXAMS[examId]) throw new Error('الامتحان غير موجود.');

  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  if (!name) throw new Error('اسم الطالب مطلوب.');
  if (name.length > 120) throw new Error('اسم الطالب طويل جدًا.');
  if (getSettings_().requirePhone && !phone) throw new Error('رقم الهاتف مطلوب.');
  if (phone && !/^[0-9+\- ]{4,25}$/.test(phone)) throw new Error('رقم الهاتف غير صالح.');

  const sessionId = String(payload.sessionId || '');
  const seed = Number(payload.seed);
  if (!sessionId || !isFinite(seed) || seed <= 0) throw new Error('جلسة الامتحان غير صالحة. أعد فتح الامتحان.');
  if (String(payload.sig || '') !== signSession_(sessionId, examId, seed)) {
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

  const exam = EXAMS[examId];
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
  const meta = CATALOG.find(function (x) { return x.id === examId; }) || {};

  saveResult_(payload, meta, score, total, percentage, detail);

  const result = {
    score: score,
    total: total,
    percentage: percentage,
    examTitle: meta.title || examId,
    unit: meta.unit || payload.unit || '',
    examType: meta.type || ''
  };

  try {
    cache.put(sessionKey, JSON.stringify({
      examId: examId,
      seed: String(seed),
      submitted: true,
      result: result
    }), SESSION_TTL_SECONDS);
  } catch (e) { /* تجاهل */ }

  return result;
}

/* ============================== النتائج ============================== */

function saveResult_(payload, meta, score, total, percentage, detail) {
  const sheet = getResultsSheet_();
  sheet.appendRow([
    new Date(),
    String(payload.name || '').trim(),
    String(payload.phone || '').trim(),
    meta.unit || payload.unit || '',
    meta.type === 'comprehensive' ? 'شامل' : 'موضوع',
    meta.title || payload.examId,
    total,
    score,
    percentage,
    JSON.stringify(detail)
  ]);
}

function ensureResultHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'التاريخ والوقت', 'اسم الطالب', 'رقم الهاتف', 'الوحدة', 'نوع الامتحان',
      'الامتحان', 'عدد الأسئلة', 'الدرجة', 'النسبة %', 'تفاصيل الإجابات'
    ]);
    sheet.setFrozenRows(1);
  }
}

/**
 * إرجاع ورقة النتائج المعيارية، مع إنشائها/إعادة تسميتها إذا لزم الأمر
 * (يُعالج اختلاف اسم الورقة الافتراضية مثل "Sheet1").
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

function getDashboardData(pin) {
  assertAdmin_(pin);
  const ss = getResultsSpreadsheet_();
  const sheet = getResultsSheetOf_(ss);
  const link = ss.getUrl();

  if (!sheet || sheet.getLastRow() < 2) {
    return { link: link, rows: [], stats: { students: 0, attempts: 0, avg: 0, max: 0, last: '' } };
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  const rows = values.map(function (r) {
    return {
      date: r[0] instanceof Date
        ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
        : String(r[0] || ''),
      name: String(r[1] || ''),
      phone: String(r[2] || ''),
      unit: String(r[3] || ''),
      type: String(r[4] || ''),
      exam: String(r[5] || ''),
      total: Number(r[6]) || 0,
      score: Number(r[7]) || 0,
      percentage: Number(r[8]) || 0
    };
  }).reverse();

  const attempts = rows.length;
  const students = new Set(rows.map(function (r) { return (r.name + '|' + r.phone).trim(); })).size;
  const avg = attempts ? Math.round(rows.reduce(function (a, r) { return a + r.percentage; }, 0) / attempts * 10) / 10 : 0;
  const max = attempts ? Math.max.apply(null, rows.map(function (r) { return r.percentage; })) : 0;
  const last = attempts ? rows[0].date : '';

  return {
    link: link,
    rows: rows.slice(0, 500),
    stats: { students: students, attempts: attempts, avg: avg, max: max, last: last }
  };
}

/* ============================== إعداد النظام ============================== */

function initializeSystem() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_SETTINGS')) {
    props.setProperty('APP_SETTINGS', JSON.stringify(DEFAULT_SETTINGS));
  }
  getSecret_(); // توليد سر الجلسات إن لم يوجد
  const ss = getResultsSpreadsheet_();
  getResultsSheetOf_(ss);
  Logger.log('تم تجهيز النظام. رابط النتائج: ' + ss.getUrl());
  return 'تم تجهيز النظام بنجاح.';
}

/**
 * فحص سلامة بنك الأسئلة: 30 امتحانًا / 840 سؤالًا.
 */
function validateSystem() {
  const ids = Object.keys(EXAMS);
  const total = ids.reduce(function (sum, id) { return sum + EXAMS[id].length; }, 0);
  if (ids.length !== 30) throw new Error('عدد الامتحانات = ' + ids.length + ' وليس 30.');
  if (total !== 840) throw new Error('عدد الأسئلة = ' + total + ' وليس 840.');

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
    if (EXAMS[id].length !== (CATALOG.filter(function (c) { return c.id === id; })[0] || {}).count) {
      throw new Error('عدد أسئلة ' + id + ' لا يطابق الكتالوج.');
    }
  });

  Logger.log('نجاح التحقق: 30 امتحانًا / 840 سؤالًا.');
  return 'نجاح التحقق: 30 امتحانًا / 840 سؤالًا.';
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

/**
 * سر مشترك لكل مشروع (يُولَّد مرة واحدة في Script Properties) لتوقيع الجلسات.
 */
function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid() + String(Date.now());
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function signSession_(sessionId, examId, seed) {
  const value = sessionId + '|' + examId + '|' + String(seed);
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(value, getSecret_()));
}

function randomSeed_() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

/**
 * مولّد أرقام شبه عشوائي حتمي (mulberry32) — يُعيد نفس الترتيب لنفس البذرة
 * في كل تنفيذ خادم، فلا حاجة لتخزين الترتيب.
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

/**
 * ترتيب حتمي لخيارات سؤال معين اعتمادًا على بذرة الجلسة ورقم السؤال.
 */
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
  return String(text || '').replace(/^\s*[أابجدهدABCDabcd]\s*[\)\].\-:：]\s*/u, '').trim();
}
