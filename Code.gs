/**
 * منصة امتحانات علم النفس — Master Web App
 * رابط واحد | 6 وحدات | 30 امتحانًا | 840 سؤالًا
 *
 * كل بيانات الأسئلة موجودة في Data.gs.
 * إعدادات الهوية والشكل والـPIN تُحفظ في Script Properties، ويمكن تعديلها
 * من لوحة التحكم بدون تعديل أي كود.
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

function doGet(e) {
  // الطالب: /exec
  // الأدمن: /exec?page=admin أو /exec?mode=admin أو /exec?admin=1
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
      '<pre style="white-space:pre-wrap;background:#f5f5f5;padding:15px;border-radius:10px">' +
      String(err && err.message ? err.message : err) +
      '</pre></div>'
    );
  }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getAppData() {
  const s = getSettings_();
  const catalog = CATALOG.map(function(x) {
    const m = String(x.id).match(/^U(\d+)-T(\d+)$/);
    return Object.assign({}, x, {
      topicNo: m ? Number(m[2]) : 0,
      typeLabel: x.type === 'comprehensive' ? 'امتحان الوحدة الشامل' : ('الموضوع ' + (m ? m[2] : ''))
    });
  }).sort(function(a,b) {
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

function getExam(examId) {
  if (!EXAMS[examId]) throw new Error('الامتحان غير موجود.');

  // خلط ترتيب الاختيارات على الخادم في كل فتح للامتحان.
  // لا نرسل الحروف الأصلية ولا مفتاح الإجابة للمتصفح.
  return EXAMS[examId].map(function(q, i) {
    const raw = ['A','B','C','D'].map(function(letter) {
      return {
        key: letter,
        text: stripOptionLabel_(q[letter])
      };
    });
    shuffle_(raw);
    return {
      n: i + 1,
      question: q.question,
      options: raw.map(function(o, idx) {
        return { id: String(idx), text: o.text };
      }),
      // الإجابة الصحيحة لا تُرسل؛ نحتفظ بمفتاح مؤقت في Cache على الخادم.
      token: makeQuestionToken_(examId, i, raw)
    };
  });
}

function makeQuestionToken_(examId, index, shuffled) {
  const token = Utilities.getUuid();
  const correct = shuffled.findIndex(function(o) {
    return o.key === EXAMS[examId][index].answer;
  });
  CacheService.getScriptCache().put('Q:' + token, JSON.stringify({
    examId: examId,
    index: index,
    correct: String(correct)
  }), 21600);
  return token;
}

function submitExam(payload) {
  if (!payload || !payload.examId || !EXAMS[payload.examId]) {
    throw new Error('بيانات الامتحان غير صحيحة.');
  }
  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  if (!name) throw new Error('اسم الطالب مطلوب.');
  if (getSettings_().requirePhone && !phone) throw new Error('رقم الهاتف مطلوب.');

  const exam = EXAMS[payload.examId];
  const answers = payload.answers || {};
  let score = 0;
  const detail = [];

  exam.forEach(function(q, i) {
    const selected = answers[String(i + 1)] || '';
    const token = String((payload.tokens || {})[String(i + 1)] || '');
    let correct = '';
    if (token) {
      const raw = CacheService.getScriptCache().get('Q:' + token);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj.examId === payload.examId && Number(obj.index) === i) correct = String(obj.correct);
      }
    }
    // إذا انتهت صلاحية الـCache، نرفض التسليم بدل تخمين الإجابة.
    if (!correct && correct !== '0') {
      throw new Error('انتهت جلسة الامتحان أو أصبحت غير صالحة. أعد فتح الامتحان وحاول مرة أخرى.');
    }
    const isCorrect = selected === correct;
    if (isCorrect) score++;
    detail.push({n: i + 1, selected: selected, correct: correct, isCorrect: isCorrect});
  });

  const total = exam.length;
  const percentage = Math.round((score / total) * 1000) / 10;
  const meta = CATALOG.find(function(x){ return x.id === payload.examId; }) || {};

  saveResult_(payload, meta, score, total, percentage, detail);

  return {
    score: score,
    total: total,
    percentage: percentage,
    examTitle: meta.title || payload.examId,
    unit: meta.unit || payload.unit || '',
    examType: meta.type || ''
  };
}

function saveResult_(payload, meta, score, total, percentage, detail) {
  const ss = getResultsSpreadsheet_();
  const sheet = ss.getSheetByName('النتائج') || ss.getSheets()[0];
  ensureResultHeader_(sheet);
  sheet.appendRow([
    new Date(),
    String(payload.name || '').trim(),
    String(payload.phone || '').trim(),
    meta.unit || payload.unit || '',
    meta.type === 'comprehensive' ? 'شامل' : 'موضوع',
    meta.title || payload.examTitle || payload.examId,
    total,
    score,
    percentage,
    JSON.stringify(detail)
  ]);
}

function ensureResultHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'التاريخ والوقت','اسم الطالب','رقم الهاتف','الوحدة','نوع الامتحان',
      'الامتحان','عدد الأسئلة','الدرجة','النسبة %','تفاصيل الإجابات'
    ]);
    sheet.setFrozenRows(1);
  }
}

function getResultsSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('RESULTS_SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  const ss = SpreadsheetApp.create(getSettings_().appTitle + ' — النتائج');
  props.setProperty('RESULTS_SPREADSHEET_ID', ss.getId());
  ensureResultHeader_(ss.getSheets()[0]);
  return ss;
}

function getResultsLink() {
  return getResultsSpreadsheet_().getUrl();
}

function getTeacherSettings(pin) {
  assertAdmin_(pin);
  const s = getSettings_();
  return s;
}

function saveTeacherSettings(pin, incoming) {
  assertAdmin_(pin);
  const current = getSettings_();
  const next = Object.assign({}, current);
  const allowed = [
    'teacherName','subjectName','gradeName','academicYear','appTitle',
    'subtitle','logoText','primaryColor','accentColor','welcomeText','requirePhone'
  ];
  allowed.forEach(function(k) {
    if (incoming && incoming[k] !== undefined) next[k] = incoming[k];
  });
  if (incoming && incoming.newAdminPin) next.adminPin = String(incoming.newAdminPin).trim();
  validateSettings_(next);
  PropertiesService.getScriptProperties().setProperty('APP_SETTINGS', JSON.stringify(next));
  return getPublicSettings_();
}

function getDashboardData(pin) {
  assertAdmin_(pin);
  const sheet = getResultsSpreadsheet_().getSheetByName('النتائج');
  if (!sheet || sheet.getLastRow() < 2) {
    return {link: getResultsSpreadsheet_().getUrl(), rows: [], stats: {students:0, attempts:0, avg:0}};
  }
  const values = sheet.getRange(2,1,sheet.getLastRow()-1,10).getValues();
  const rows = values.map(function(r){
    return {
      date: r[0] instanceof Date ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(r[0]),
      name: String(r[1]), phone: String(r[2]), unit: String(r[3]), type: String(r[4]),
      exam: String(r[5]), total: Number(r[6]), score: Number(r[7]), percentage: Number(r[8])
    };
  }).reverse();
  const attempts = rows.length;
  const students = new Set(rows.map(r => (r.name + '|' + r.phone).trim())).size;
  const avg = attempts ? Math.round(rows.reduce((a,r)=>a+r.percentage,0)/attempts*10)/10 : 0;
  return {link: getResultsSpreadsheet_().getUrl(), rows: rows.slice(0,500), stats:{students:students, attempts:attempts, avg:avg}};
}

function initializeSystem() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_SETTINGS')) {
    props.setProperty('APP_SETTINGS', JSON.stringify(DEFAULT_SETTINGS));
  }
  const ss = getResultsSpreadsheet_();
  Logger.log('تم تجهيز النظام. رابط النتائج: ' + ss.getUrl());
  return 'تم تجهيز النظام بنجاح.';
}

function validateSystem() {
  const ids = Object.keys(EXAMS);
  const total = ids.reduce(function(sum, id){ return sum + EXAMS[id].length; }, 0);
  if (ids.length !== 30) throw new Error('عدد الامتحانات = ' + ids.length + ' وليس 30.');
  if (total !== 840) throw new Error('عدد الأسئلة = ' + total + ' وليس 840.');
  ids.forEach(function(id) {
    const n = EXAMS[id].length;
    if (n !== 20 && n !== 60) throw new Error(id + ': عدد الأسئلة غير صحيح: ' + n);
    EXAMS[id].forEach(function(q, i) {
      ['question','A','B','C','D','answer'].forEach(function(k) {
        if (!q[k]) throw new Error(id + ' السؤال ' + (i+1) + ': الحقل ' + k + ' ناقص.');
      });
      if (!['A','B','C','D'].includes(q.answer)) throw new Error(id + ' السؤال ' + (i+1) + ': مفتاح غير صحيح.');
    });
  });
  Logger.log('نجاح التحقق: 30 امتحانًا / 840 سؤالًا.');
  return 'نجاح التحقق: 30 امتحانًا / 840 سؤالًا.';
}

function getSettings_() {
  const raw = PropertiesService.getScriptProperties().getProperty('APP_SETTINGS');
  if (!raw) {
    PropertiesService.getScriptProperties().setProperty('APP_SETTINGS', JSON.stringify(DEFAULT_SETTINGS));
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
  delete s.adminPin;
  return s;
}

function validateSettings_(s) {
  ['teacherName','subjectName','appTitle','subtitle'].forEach(function(k){
    if (!String(s[k] || '').trim()) throw new Error('الإعداد ' + k + ' مطلوب.');
  });
  ['primaryColor','accentColor'].forEach(function(k){
    if (!/^#[0-9a-fA-F]{6}$/.test(String(s[k] || ''))) throw new Error('لون غير صالح: ' + k);
  });
  if (!String(s.adminPin || '').trim()) throw new Error('PIN لوحة التحكم لا يمكن أن يكون فارغًا.');
}

function assertAdmin_(pin) {
  if (String(pin || '') !== String(getSettings_().adminPin)) throw new Error('رمز لوحة التحكم غير صحيح.');
}

function stripOptionLabel_(text) {
  return String(text || '').replace(/^\s*[أابجدهدABCDabcd]\s*[\)\].\-:：]\s*/u, '').trim();
}

function shuffle_(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
