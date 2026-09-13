/* لوحة التحكم — منصة الامتحانات
 * تسجيل دخول بالبريد وكلمة مرور، إدارة المعلمين، استعراض المنهج والبنك،
 * النتائج، وإعدادات المنصة (الهوية/الرئيسية/المظهر/التواصل/افتراضيات المعلمين). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  /* مفاتيح الإجابة القانونية في المنصة كلها لاتينية A/B/C/D (البنك، التصدير، الاستيراد،
   * والتصحيح على الخادم). الحروف العربية للعرض فقط بجانبها حتى لا يضطر المسؤول للترجمة
   * ذهنيًا — وأي خلط بينهما كان يجعل حفظ السؤال مرفوضًا من الخادم. */
  var LETTERS = ['A', 'B', 'C', 'D'];
  var LETTER_AR = { A: 'أ', B: 'ب', C: 'ج', D: 'د' };
  var A = {
    tab: 'dashboard', data: {}, bankPage: 1,
    bankFilters: { subject: '', term: '', lesson: '', q: '', only: '' },
    session: null, settings: null, settingsDirty: false,
    teachers: [], pendingPhoto: null
  };
  /* أيقونات SVG متناسقة بدل الإيموجي */
  var ICO = function (p, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; };
  var I_HOME = ICO('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>');
  var I_USERS = ICO('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.2 14.7c2 .7 3.3 2.4 3.3 5.3"/>');
  var I_CHART = ICO('<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="1"/><rect x="12" y="8" width="3" height="10" rx="1"/><rect x="17" y="5" width="3" height="13" rx="1"/>');
  var I_BRAIN = ICO('<path d="M9.5 3.5A3.2 3.2 0 0 0 6.4 7.6 3.8 3.8 0 0 0 4.5 11a3.9 3.9 0 0 0 1.6 6.9A3.3 3.3 0 0 0 12 19.5v-13a3.2 3.2 0 0 0-2.5-3z"/><path d="M14.5 3.5a3.2 3.2 0 0 1 3.1 4.1A3.8 3.8 0 0 1 19.5 11a3.9 3.9 0 0 1-1.6 6.9A3.3 3.3 0 0 1 12 19.5"/>');
  var I_BOOK = ICO('<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>');
  var I_BANK = ICO('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>');
  var I_CLIP = ICO('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h4"/>');
  var I_GEAR = ICO('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>');
  var I_TAG = ICO('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>');
  var I_LINK = ICO('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>');
  var I_PUZZLE = ICO('<path d="M14 3v3a2 2 0 0 0 2 2h3v5h-2a2 2 0 0 0 0 4h2v4h-6v-2a2 2 0 0 0-4 0v2H4v-6H3a2 2 0 0 1 0-4h1V6h5V5a2 2 0 0 1 5-2z"/>');
  var I_PALETTE = ICO('<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.4-.7-.4-1.1 0-1 .9-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8z"/><circle cx="7.5" cy="11.5" r=".6"/><circle cx="11" cy="7.5" r=".6"/><circle cx="15.5" cy="9" r=".6"/>');
  var I_LOCK = ICO('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');
  /* أيقونات إدارة المحتوى (CMS) — خط متناسق 24px */
  var I_EDIT = ICO('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/>');
  var I_COPY = ICO('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  var I_TRASH = ICO('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>');
  var I_IMPORT = ICO('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>');
  var I_EXPORT = ICO('<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M4 3h16"/>');
  var I_EYE = ICO('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>');
  var I_EYEOFF = ICO('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9"/><path d="M6.6 6.6C3.8 8.5 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>');
  var I_BACK = ICO('<path d="M9 6l6 6-6 6"/>');
  var I_UP = ICO('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>');
  var I_DOWN = ICO('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>');
  var I_REVERT = ICO('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>');
  var I_PLUS = ICO('<path d="M12 5v14"/><path d="M5 12h14"/>');
  var WARN_SVG_A = ICO('<path d="M12 8v5"/><circle cx="12" cy="16.6" r=".5" fill="currentColor"/><path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/>');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== '/api/admin/login') { A.session = null; renderLogin(); throw new Error(data.error || 'انتهت الجلسة.'); }
        if (!r.ok) throw new Error(data.error || ('خطأ ' + r.status));
        return data;
      });
    });
  }
  function toast(msg, isErr) {
    var d = document.createElement('div');
    d.className = 'toast' + (isErr ? ' err' : '');
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 3500);
  }

  /* ================= تسجيل الدخول / الإعداد الأولي ================= */
  function renderLogin(setupMode) {
    var app = $('app');
    app.innerHTML =
      '<div class="tlogin"><div class="tlogin-brand">' +
      '<div class="lb-logo">' + I_GEAR + '</div>' +
      '<div><h1>لوحة التحكم</h1><p>إدارة المنصة بالكامل: المعلمون، الإعدادات، المحتوى، والنتائج — من مكان واحد آمن.</p></div>' +
      '<ul><li><span class="dot">' + I_USERS + '</span>إدارة المعلمين وروابطهم</li><li><span class="dot">' + I_PALETTE + '</span>التحكم في هوية المنصة وألوانها</li><li><span class="dot">' + I_CHART + '</span>متابعة النتائج لحظيًا</li></ul>' +
      '</div><div class="tlogin-form"><div class="tlogin-card">' +
      '<div class="tlogin-header"><div class="tlogin-icon">' + I_LOCK + '</div><h2>' + (setupMode ? 'إنشاء حساب المسؤول' : 'تسجيل الدخول') + '</h2><p>' + (setupMode ? 'لم يُنشأ حساب مسؤول بعد — أنشئ الحساب الآن.' : 'لوحة إدارة المنصة') + '</p></div>' +
      '<form onsubmit="doLogin(' + !!setupMode + ');return false">' +
      '<div class="field"><label for="admEmail">البريد الإلكتروني</label><input type="email" id="admEmail" autocomplete="username"></div>' +
      '<div class="field"><label for="admPass">كلمة المرور</label><input type="password" id="admPass" autocomplete="current-password"></div>' +
      (setupMode ? '<div class="field"><label for="admPass2">تأكيد كلمة المرور</label><input type="password" id="admPass2"></div>' : '') +
      '<div id="loginErr" class="t-err"></div>' +
      '<button class="btn" type="submit">' + (setupMode ? 'إنشاء الحساب' : 'دخول') + '</button>' +
      '</form></div></div></div>';
    setTimeout(function () { var el = $('admEmail'); if (el) el.focus(); }, 50);
  }
  function doLogin(isSetup) {
    var email = $('admEmail').value.trim();
    var pass = $('admPass').value;
    var err = $('loginErr');
    err.textContent = '';
    if (isSetup && pass !== $('admPass2').value) { err.textContent = 'كلمتا المرور غير متطابقتين.'; return; }
    api(isSetup ? '/api/admin/setup' : '/api/admin/login', { method: 'POST', body: JSON.stringify({ email: email, password: pass }) })
      .then(function () {
        if (isSetup) { toast('تم إنشاء الحساب — سجّل الدخول الآن.'); renderLogin(false); }
        else enter();
      })
      .catch(function (e) { err.textContent = e.message; });
  }
  function enter() {
    return api('/api/admin/session').then(function (d) {
      A.session = d.email;
      renderShell();
      renderTab();
    });
  }
  function logout() {
    api('/api/admin/logout', { method: 'POST' }).then(function () { location.reload(); });
  }

  /* ================= الهيكل (Sidebar + محتوى) ================= */
  var NAV = [
    { title: 'عام', items: [['dashboard', I_HOME, 'نظرة عامة'], ['teachers', I_USERS, 'المعلمون'], ['results', I_CHART, 'النتائج']] },
    { title: 'إدارة المحتوى', items: [['exams', I_CLIP, 'الامتحانات'], ['bank', I_BANK, 'بنك الأسئلة'], ['import', I_IMPORT, 'استيراد/تصدير'], ['psychology', I_BRAIN, 'علم النفس'], ['philosophy', I_BOOK, 'الفلسفة والمنطق']] },
    { title: 'النظام', items: [['settings', I_GEAR, 'الإعدادات']] }
  ];
  var TITLES = { dashboard: 'نظرة عامة', teachers: 'المعلمون', psychology: 'خريطة علم النفس', philosophy: 'خريطة الفلسفة', bank: 'بنك الأسئلة', exams: 'الامتحانات', import: 'استيراد/تصدير', results: 'النتائج', settings: 'إعدادات المنصة' };
  function renderShell() {
    var app = $('app');
    app.innerHTML =
      '<div class="a-shell">' +
      '<aside class="a-sidebar">' +
      '<div class="a-brand"><div class="logo">' + I_GEAR + '</div><div class="t"><b>لوحة التحكم</b><span>منصة الامتحانات</span></div></div>' +
      '<nav class="a-nav">' +
      NAV.map(function (g) {
        return '<div class="a-nav-group"><div class="a-nav-title">' + g.title + '</div>' +
          g.items.map(function (it) {
            return '<button class="a-nav-item' + (A.tab === it[0] ? ' active' : '') + '" onclick="setTab(\'' + it[0] + '\')"><span class="a-nav-icon">' + it[1] + '</span>' + it[2] + '</button>';
          }).join('') + '</div>';
      }).join('') +
      '</nav>' +
      '<div class="a-sidebar-foot"><span class="who">' + esc(A.session) + '</span><button class="btn ghost small" onclick="logout()">خروج</button></div>' +
      '</aside>' +
      '<div class="a-main">' +
      '<header class="a-topbar"><div><h1 id="aTitle">' + (TITLES[A.tab] || '') + '</h1></div><div class="spacer"></div><span class="chip" id="aEmail">' + esc(A.session) + '</span></header>' +
      '<div class="a-content" id="aContent"><div class="empty"><div class="spin"></div></div></div>' +
      '</div></div>';
  }
  function setTab(t) {
    if (A.settingsDirty && t !== 'settings' && !confirm('لديك تغييرات غير محفوظة في الإعدادات. متابعة دون حفظ؟')) return;
    if (A.ee && A.ee.dirty && t !== 'exams' && !confirm('لديك تغييرات غير محفوظة في محرر الامتحان. متابعة دون حفظ؟')) return;
    if (t !== 'exams') A.ee = null;
    A.tab = t;
    var title = $('aTitle'); if (title) title.textContent = TITLES[t] || '';
    document.querySelectorAll('.a-nav-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('onclick') && el.getAttribute('onclick').indexOf("setTab('" + t + "')") !== -1);
    });
    /* على الجوال الشريط أفقي: نُبقي التبويب النشط داخل الرؤية */
    var act = document.querySelector('.a-nav-item.active');
    if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { } }
    renderTab();
  }
  function renderTab() {
    var body = $('aContent');
    if (!body) return;
    body.innerHTML = '<div class="empty"><div class="spin"></div></div>';
    if (A.tab === 'dashboard') renderDashboard(body);
    else if (A.tab === 'teachers') renderTeachers(body);
    else if (A.tab === 'psychology' || A.tab === 'philosophy') renderSubjectTree(body, A.tab);
    else if (A.tab === 'bank') renderBank(body);
    else if (A.tab === 'exams') renderExams(body);
    else if (A.tab === 'import') renderImport(body);
    else if (A.tab === 'results') renderResults(body);
    else if (A.tab === 'settings') renderSettings(body);
  }

  /* ================= نظرة عامة ================= */
  function renderDashboard(body) {
    api('/api/admin/overview').then(function (d) {
      var a = d.audit, st = d.structure;
      body.innerHTML =
        '<div class="cms-quick">' +
        '<button class="qq" onclick="setTab(\'exams\')">' + I_CLIP + '<b>الامتحانات</b><span>فتح/تعديل/ترتيب/تعطيل</span></button>' +
        '<button class="qq" onclick="setTab(\'bank\')">' + I_BANK + '<b>بنك الأسئلة</b><span>تعديل/إنشاء/تكرار/حذف</span></button>' +
        '<button class="qq" onclick="setTab(\'import\')">' + I_IMPORT + '<b>استيراد امتحان</b><span>JSON → معاينة → تأكيد</span></button>' +
        '<button class="qq" onclick="setTab(\'teachers\')">' + I_USERS + '<b>المعلمون</b><span>حسابات وروابط الطلاب</span></button>' +
        '</div>' +
        '<div class="stat-grid">' +
        stat(d.exams, 'امتحانًا') + stat(d.questions, 'سؤالًا فريدًا') +
        stat(d.teachersCount, 'معلمًا') + stat(d.recentResultsCount, 'نتيجة أخيرة') +
        '</div>' +
        ((d.customExams || d.customQuestions || d.editedQuestions || d.editedExams || d.disabledExams || d.deletedQuestions || d.deletedExams)
          ? '<div class="section-title"><h3>طبقة التعديلات (فوق البنك الأصلي)</h3></div>' +
          '<div class="cms-counts" style="margin:0 0 4px">' +
          '<span class="cchip gold">' + (d.customExams || 0) + ' امتحان مخصّص</span>' +
          '<span class="cchip gold">' + (d.customQuestions || 0) + ' سؤال مضاف</span>' +
          '<span class="cchip blue">' + (d.editedExams || 0) + ' امتحان معدّل</span>' +
          '<span class="cchip blue">' + (d.editedQuestions || 0) + ' سؤال معدّل</span>' +
          '<span class="cchip red">' + (d.disabledExams || 0) + ' معطّل</span>' +
          '<span class="cchip red">' + ((d.deletedQuestions || 0) + (d.deletedExams || 0)) + ' في السلة</span>' +
          (d.contentUpdatedAt ? '<span class="cchip muted">آخر تحديث ' + new Date(d.contentUpdatedAt).toLocaleString('ar-EG') + '</span>' : '') +
          '</div>'
          : '') +
        '<div class="section-title"><h3>توزيع المحتوى</h3></div>' +
        '<div class="stat-grid">' +
        stat(st.psychology.examCount, 'امتحانات علم النفس (' + st.psychology.uniqueQuestions + ' سؤالًا)') +
        stat(st.philosophyTerm1.examCount, 'امتحانات فلسفة ت1 (' + st.philosophyTerm1.uniqueQuestions + ' سؤالًا)') +
        stat(st.philosophyTerm2.examCount, 'امتحانات فلسفة ت2 (' + st.philosophyTerm2.uniqueQuestions + ' سؤالًا)') +
        '</div>' +
        '<div class="section-title"><h3>التحقق والتوثيق</h3></div>' +
        '<div class="card"><div class="kv">' +
        kv('علم النفس', a.psychology.questions + ' سؤالًا — ' + a.psychology.verified + ' موثق · ' + a.psychology.corrections.length + ' تصحيح مفتاح موثق') +
        kv('فلسفة ت1', a.philosophyTerm1.questions + ' سؤالًا — ' + a.philosophyTerm1.verified + ' موثق + ' + a.philosophyTerm1.authored + ' مؤلَّف · ' + a.philosophyTerm1.corrected + ' تصحيح مفتاح') +
        kv('فلسفة ت2', a.philosophyTerm2.questions + ' سؤالًا — ' + a.philosophyTerm2.verified + ' موثق + ' + a.philosophyTerm2.authored + ' مؤلَّف · ' + a.philosophyTerm2.corrected + ' تصحيح مفتاح') +
        '</div></div>' +
        '<div class="section-title"><h3>المعلمون</h3></div>' +
        '<div class="card"><div style="overflow-x:auto"><table class="tbl"><tr><th>الاسم</th><th>الرابط</th><th>الحالة</th><th>حد الطلاب</th><th>الحالي</th><th>المتبقي</th></tr>' +
        d.teachers.map(function (t) {
          var sl = t.studentLimit || { unlimited: true, current: 0 };
          return '<tr><td>' + esc(t.name) + '</td><td><code>/' + esc(t.slug) + '</code></td><td>' +
            (t.enabled ? '<span class="badge green">مفعّل</span>' : '<span class="badge">معطّل</span>') + '</td>' +
            '<td>' + (sl.unlimited ? 'غير محدود' : sl.limit) + '</td><td>' + sl.current + '</td><td>' + (sl.unlimited ? '—' : sl.remaining) + '</td></tr>';
        }).join('') + '</table></div></div>';
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function stat(v, l) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + esc(l) + '</div></div>'; }
  function kv(k, v) { return '<div class="k">' + esc(k) + '</div><div>' + esc(v) + '</div>'; }

  /* ================= المعلمون ================= */
  function renderTeachers(body) {
    api('/api/admin/teachers').then(function (d) {
      A.teachers = d.teachers;
      body.innerHTML =
        '<div class="page-head" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:200px"><input type="search" id="tSearch" placeholder="ابحث باسم المعلم أو الرابط أو البريد…" style="max-width:420px" oninput="filterTeachers()"></div>' +
        '<button class="btn" onclick="editTeacher(null)">+ إضافة معلم جديد</button>' +
        '</div>' +
        '<div id="tList">' + teacherCards(d.teachers) + '</div>' +
        (d.archived && d.archived.length ? '<div class="section-title" style="margin-top:22px"><h3>الأرشيف (محذوفون — قابلون للاستعادة)</h3></div>' +
          '<div class="card"><div style="overflow-x:auto"><table class="tbl"><tr><th>الاسم</th><th>الرابط</th><th>تاريخ الحذف</th><th></th></tr>' +
          d.archived.map(function (t) {
            return '<tr><td>' + esc(t.name) + '</td><td><code>/' + esc(t.slug) + '</code></td><td style="font-size:.76rem">' + (t.archivedAt ? new Date(t.archivedAt).toLocaleString('ar-EG') : '—') + '</td>' +
              '<td><button class="btn small ghost" onclick="restoreTeacher(\'' + esc(t.id) + '\')">استعادة</button></td></tr>';
          }).join('') + '</table></div></div>' : '');
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function teacherCards(list) {
    if (!list.length) return '<div class="empty">لا يوجد معلمون بعد — أضف أول معلم.</div>';
    return '<div class="grid two">' + list.map(function (t) {
      var sl = t.studentLimitStatus || { unlimited: true, current: 0 };
      return '<div class="card teacher-card" style="margin-top:0">' +
        '<div class="avatar">' + (t.photo ? '<img src="' + esc(t.photo) + '" alt="">' : esc(t.name.slice(0, 2))) + '</div>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap"><b>' + esc(t.name) + '</b>' +
        (t.isDefault ? '<span class="badge gold">افتراضي</span>' : '') +
        (t.enabled ? '<span class="badge green">مفعّل</span>' : '<span class="badge">معطّل</span>') +
        (t.hasPassword ? '<span class="badge blue">دخول مضبوط</span>' : '<span class="badge">بدون دخول</span>') + '</div>' +
        (t.specialty ? '<div class="desc" style="font-size:.76rem;margin-top:3px;color:var(--gold-deep);font-weight:700">' + esc(t.specialty) + '</div>' : '') +
        '<div class="tmeta-row"><span class="tmeta-k">الرابط:</span><a dir="ltr" href="/' + esc(t.slug) + '" target="_blank">' + esc(location.host + '/' + t.slug) + '</a>' +
        '<button class="btn small ghost" style="padding:3px 10px;min-height:0" onclick="copyLink(\'' + esc(t.slug) + '\')">نسخ</button></div>' +
        (t.email ? '<div class="tmeta-row"><span class="tmeta-k">البريد:</span><span dir="ltr">' + esc(t.email) + '</span></div>' : '') +
        studentLimitLine(sl) +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
        '<button class="btn small" onclick="editTeacher(\'' + esc(t.id) + '\')">تعديل</button>' +
        '<button class="btn small ghost" onclick="teacherDash(\'' + esc(t.id) + '\')">لوحة المعلم</button>' +
        '<button class="btn small ghost" onclick="resetTeacherPassword(\'' + esc(t.id) + '\')">إعادة تعيين كلمة المرور</button>' +
        (t.enabled
          ? '<button class="btn small ghost" onclick="setTeacherEnabled(\'' + esc(t.id) + '\',false)">تعطيل</button>'
          : '<button class="btn small ghost" onclick="setTeacherEnabled(\'' + esc(t.id) + '\',true)">تفعيل</button>') +
        (t.isDefault ? '' : '<button class="btn small danger" onclick="deleteTeacher(\'' + esc(t.id) + '\')">أرشفة</button>') +
        '</div></div></div>';
    }).join('') + '</div>';
  }
  function studentLimitLine(st) {
    if (!st) return '';
    var txt = st.unlimited
      ? 'حد الطلاب: <b>غير محدود</b> · المسجَّلون: <b>' + st.current + '</b>'
      : 'حد الطلاب: <b>' + st.limit + '</b> · الحالي: <b>' + st.current + '</b> · المتبقي: <b style="color:' + (st.remaining > 0 ? 'var(--ok)' : 'var(--bad)') + '">' + st.remaining + '</b>';
    return '<div class="tmeta-row">' + txt + '</div>';
  }
  function filterTeachers() {
    var q = $('tSearch').value.trim().toLowerCase();
    var list = A.teachers.filter(function (t) {
      return !q || (t.name && t.name.toLowerCase().indexOf(q) !== -1) || (t.slug && t.slug.indexOf(q) !== -1) || (t.email && t.email.toLowerCase().indexOf(q) !== -1) || (t.teacherCode && t.teacherCode.toLowerCase().indexOf(q) !== -1);
    });
    $('tList').innerHTML = teacherCards(list);
  }
  function copyLink(slug) {
    var url = location.origin + '/' + slug;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('تم نسخ الرابط'); }, function () { prompt('انسخ الرابط:', url); });
    else prompt('انسخ الرابط:', url);
  }
  function copyLogin() {
    var url = location.origin + '/teacher';
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('تم نسخ رابط دخول المعلم'); }, function () { prompt('انسخ الرابط:', url); });
    else prompt('انسخ الرابط:', url);
  }
  function setTeacherEnabled(id, enabled) {
    var t = A.teachers.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    api('/api/admin/teachers/' + id, {
      method: 'PUT',
      body: JSON.stringify({ name: t.name, slug: t.slug, enabled: enabled })
    }).then(function () {
      toast(enabled ? 'تم تفعيل المعلم' : 'تم تعطيل المعلم (أُسقطت جلساته)');
      renderTeachers($('aContent'));
    }).catch(function (e) { toast(e.message, true); });
  }
  function deleteTeacher(id) {
    var t = A.teachers.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (!confirm('أرشفة المعلم «' + t.name + '»؟ سيُنقل إلى الأرشيف (قابل للاستعادة) ولن يعمل رابطه /' + t.slug + ' حتى الاستعادة. النتائج لا تُحذف.')) return;
    api('/api/admin/teachers/' + id, { method: 'DELETE' }).then(function () {
      toast('نُقل المعلم إلى الأرشيف');
      renderTeachers($('aContent'));
    }).catch(function (e) { toast(e.message, true); });
  }
  function restoreTeacher(id) {
    api('/api/admin/teachers/' + id + '/restore', { method: 'POST', body: '{}' }).then(function () {
      toast('تمت الاستعادة (المعلم معطّل حتى تفعّله)');
      renderTeachers($('aContent'));
    }).catch(function (e) { toast(e.message, true); });
  }
  function resetTeacherPassword(id) {
    var t = A.teachers.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML =
      '<div class="modal"><h3>إعادة تعيين كلمة مرور «' + esc(t.name) + '»</h3>' +
      '<p>كلمة مرور جديدة (8 أحرف على الأقل) — ستُسقَط كل جلسات المعلم فورًا.</p>' +
      '<div class="field" style="margin-top:12px"><label>كلمة المرور الجديدة</label><input type="password" id="rpPw" autocomplete="new-password"></div>' +
      '<div id="rpErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em"></div>' +
      '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إلغاء</button><button class="btn" onclick="doResetPassword(\'' + esc(id) + '\')">إعادة تعيين</button></div></div>';
    document.body.appendChild(overlay);
  }
  function doResetPassword(id) {
    var pw = $('rpPw').value;
    if (pw.length < 8) { $('rpErr').textContent = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.'; return; }
    api('/api/admin/teachers/' + id + '/password', { method: 'POST', body: JSON.stringify({ password: pw }) })
      .then(function () { toast('تمت إعادة تعيين كلمة المرور'); document.querySelector('.modal-bg').remove(); })
      .catch(function (e) { $('rpErr').textContent = e.message; });
  }

  /* ================= نموذج إضافة/تعديل المعلم ================= */
  function editTeacher(id) {
    var t = id ? A.teachers.filter(function (x) { return x.id === id; })[0] : null;
    var isNew = !t;
    var td = (A.settings && A.settings.teacherDefaults) || {};
    t = t || {
      name: '', slug: '', phone: '', specialty: '', bio: '', photo: '', email: '', username: '',
      socialLinks: {}, requirePhone: td.requirePhone !== false, enabled: true,
      unlimited: td.unlimited !== false, maxAttempts: td.maxAttempts || 3, offlineMode: td.offlineMode === true,
      studentLimitUnlimited: td.studentLimitUnlimited !== false, studentLimit: td.studentLimit || 0,
      id: '', teacherCode: ''
    };
    var sl = t.socialLinks || {};
    var overlay = document.createElement('div');
    overlay.className = 'tform-bg';
    overlay.innerHTML =
      '<div class="tform">' +
      '<div class="tform-head"><div><h2>' + (isNew ? 'إضافة معلم جديد' : 'تعديل بيانات المعلم') + '</h2><div class="sub">' + (isNew ? 'أكمل بيانات المعلم — ستُنشأ كلمة مرور الدخول ورابط الطلاب تلقائيًا' : 'عدّل بيانات المعلم — الرابط (slug) لا يتغيّر إلا بطلب صريح') + '</div></div>' +
      '<button class="btn ghost small close" onclick="this.closest(\'.tform-bg\').remove()">إغلاق ✕</button></div>' +
      '<div class="tform-body"><div class="tform-grid">' +

      section(1, 'البيانات الأساسية',
        '<div class="field"><label>اسم المعلم *</label><input id="tName" value="' + esc(t.name) + '" maxlength="80" placeholder="مثال: أ. محمد أحمد"></div>' +
        '<div class="field"><label>التخصص</label><input id="tSpecialty" value="' + esc(t.specialty || '') + '" maxlength="120" placeholder="مثال: مدرس الفلسفة والمنطق — المرحلة الثانوية"></div>' +
        '<div class="field"><label>نبذة المدرس (تظهر في صفحتك العامة)</label><textarea id="tBio" rows="3" maxlength="500" placeholder="اكتب نبذة حقيقية عنك وعن خبرتك…">' + esc(t.bio || '') + '</textarea></div>' +
        '<div class="field"><label>صورة المدرس</label>' +
        '<div class="photo-upload"><div class="prev" id="tPhotoPrev" data-fit="' + esc(t.photoFit || '') + '">' + (t.photo ? '<img src="' + esc(t.photo) + '" alt="">' : '<span class="mono">' + esc((t.name || 'م ت').slice(0, 2)) + '</span>') + '</div>' +
        '<div class="actions"><input type="file" id="tPhoto" accept="image/png,image/jpeg,image/webp" style="font-size:.78rem">' +
        '<button class="btn small ghost" id="tPhotoClear" type="button">إزالة الصورة</button>' +
        '<select id="tPhotoFit" style="font-size:.78rem"><option value=""' + (!t.photoFit ? ' selected' : '') + '>تلقائي (شفاف ⇒ احتواء كامل)</option><option value="contain"' + (t.photoFit === 'contain' ? ' selected' : '') + '>احتواء كامل بلا قص</option><option value="cover"' + (t.photoFit === 'cover' ? ' selected' : '') + '>قص متناسق (صور فوتوغرافية)</option></select>' +
        '</div></div>' +
        '<div class="hint" style="font-size:.7rem;color:var(--muted-2);margin-top:6px">PNG الشفاف يبقى شفافًا فوق الخلفية الزخرفية — المعاينة هنا تطابق الظهور العام للطالب.</div></div>') +

      section(2, 'بيانات الدخول',
        '<div class="field"><label>البريد الإلكتروني (لدخول المعلم)</label><input id="tEmail" type="email" dir="ltr" value="' + esc(t.email || '') + '" placeholder="بريد المعلم"></div>' +
        '<div class="field"><label>اسم المستخدم (اختياري)</label><input id="tUsername" dir="ltr" value="' + esc(t.username || '') + '" placeholder="username"></div>' +
        '<div class="field"><label>كلمة المرور ' + (t.hasPassword ? '(اتركها فارغة للإبقاء على الحالية)' : '(مطلوبة للدخول)') + '</label><input id="tPassword" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل"></div>') +

      section(3, 'بيانات التواصل',
        '<div class="field"><label>الهاتف (خاص — لا يظهر للطلاب)</label><input id="tPhone" dir="ltr" value="' + esc(t.phone || '') + '" placeholder="01xxxxxxxxx"></div>' +
        '<div class="field"><label>واتساب</label><input id="tWhats" dir="ltr" placeholder="https://wa.me/…" value="' + esc(sl.whatsapp || '') + '"></div>' +
        '<div class="field"><label>فيسبوك</label><input id="tFb" dir="ltr" placeholder="https://facebook.com/…" value="' + esc(sl.facebook || '') + '"></div>' +
        '<div class="field"><label>تيك توك</label><input id="tTt" dir="ltr" placeholder="https://tiktok.com/…" value="' + esc(sl.tiktok || '') + '"></div>' +
        '<div class="field"><label>يوتيوب</label><input id="tYt" dir="ltr" placeholder="https://youtube.com/…" value="' + esc(sl.youtube || '') + '"></div>') +

      section(4, 'رابط الطالب',
        '<div class="field"><label>معرّف المعلم (ID — ثابت)</label><input dir="ltr" readonly value="' + esc(t.id || 'يُنشأ تلقائيًا عند الحفظ') + '"></div>' +
        '<div class="field"><label>الرابط (slug) — إنجليزي صغير وأرقام وشرطات</label><input id="tSlug" dir="ltr" value="' + esc(t.slug) + '" placeholder="مثال: mostafa"></div>' +
        '<div class="field"><label>رابط الطلاب</label><div style="display:flex;gap:8px"><input dir="ltr" readonly id="tUrlPreview" value="' + esc(location.host + '/' + (t.slug || '…')) + '" style="opacity:.8"><button class="btn small ghost" type="button" onclick="copyLink(document.getElementById(\'tSlug\').value || \'' + esc(t.slug) + '\')">نسخ</button></div></div>' +
        (t.teacherCode ? '<div class="field"><label>رمز المعلم</label><input dir="ltr" readonly value="' + esc(t.teacherCode) + '"></div>' : '')) +

      section(5, 'التحكم في الطلاب',
        toggleRow('tReqPhone', 'طلب رقم الهاتف من الطالب', 'يُطلب رقم الهاتف قبل بدء الامتحان', t.requirePhone !== false) +
        toggleRow('tUnlimited', 'محاولات غير محدودة', 'عدد محاولات مفتوح لكل امتحان', t.unlimited !== false) +
        '<div class="field"><label>الحد الأقصى للمحاولات (لكل طالب لكل امتحان)</label><input id="tMaxAtt" type="number" min="1" max="50" value="' + (t.maxAttempts || 3) + '" ' + (t.unlimited !== false ? 'disabled' : '') + '></div>' +
        toggleRow('tStuUnl', 'عدد طلاب غير محدود', 'لا سقف لعدد الطلاب المسجّلين', t.studentLimitUnlimited !== false) +
        '<div class="field"><label>حد الطلاب (0 = إغلاق التسجيل للجدد)</label><input id="tStuLimit" type="number" min="0" max="1000000" value="' + (t.studentLimit || 0) + '" ' + (t.studentLimitUnlimited !== false ? 'disabled' : '') + '></div>' +
        toggleRow('tOffMode', 'وضع عدم الاتصال', 'صلاحية الجلسات 72 ساعة للعمل دون إنترنت', t.offlineMode === true)) +

      section(6, 'الحالة',
        toggleRow('tEnabled', 'الحساب مفعّل', 'المعلم المعطّل لا يدخل ولا تظهر صفحته للطلاب', t.enabled !== false) +
        '<p class="desc" style="font-size:.76rem;color:var(--muted)">الأرشفة تتم من بطاقة المعلم في القائمة (غير تدميرية وقابلة للاستعادة).</p>') +

      '</div></div>' +
      '<div class="tform-foot"><div class="err" id="tErr"></div><div class="acts"><button class="btn ghost" onclick="this.closest(\'.tform-bg\').remove()">إلغاء</button><button class="btn" id="tSave" onclick="saveTeacher(\'' + (id || '') + '\')">' + (isNew ? 'إضافة المعلم' : 'حفظ التغييرات') + '</button></div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    $('tSlug').addEventListener('input', function () { $('tUrlPreview').value = location.host + '/' + this.value; });
    $('tPhoto').addEventListener('change', function () {
      resizePhoto(this.files[0], function (d, keepAlpha) {
        A.pendingPhoto = d;
        var prev = $('tPhotoPrev');
        prev.innerHTML = '<img src="' + d + '" alt="">';
        // شفافية ⇒ احتواء كامل افتراضيًا (يمكن تغييره يدويًا)
        if (keepAlpha && !$('tPhotoFit').value) $('tPhotoFit').value = 'contain';
        prev.setAttribute('data-fit', $('tPhotoFit').value || (keepAlpha ? 'contain' : 'cover'));
      });
    });
    $('tPhotoClear').addEventListener('click', function () { A.pendingPhoto = ''; $('tPhotoPrev').innerHTML = '<span class="mono">م‌ت</span>'; });
    var pfSel = $('tPhotoFit');
    if (pfSel) pfSel.addEventListener('change', function () { $('tPhotoPrev').setAttribute('data-fit', this.value); });
    $('tUnlimited').addEventListener('change', function () { $('tMaxAtt').disabled = this.checked; });
    $('tStuUnl').addEventListener('change', function () { $('tStuLimit').disabled = this.checked; });
    var es = document.createElement('style');
    document.body.appendChild(overlay);
    if (isNew) {
      var sel = $('tName'); if (sel) setTimeout(function () { sel.focus(); }, 60);
    }
    void es;
  }
  function section(n, title, inner) {
    return '<div class="tform-section' + (n === 1 || n === 5 || n === 6 ? ' full' : '') + '"><div class="ts-head"><span class="n">' + n + '</span>' + title + '</div>' + inner + '</div>';
  }
  function toggleRow(id, label, hint, checked) {
    return '<div class="toggle-row"><div class="tl"><b>' + label + '</b><span>' + hint + '</span></div>' +
      '<label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><i></i></label></div>';
  }
  /* ضغط صورة المعلم مع الحفاظ على الشفافية: PNG/WebP تُحفظ PNG بقناة ألفا
   * (لا تُحوَّل لجسم أسود/أبيض)، وJPG تُضغط JPEG. الخلفية مسؤولية التصميم لا الملف. */
  function resizePhoto(file, cb) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('الصورة كبيرة جدًا (الحد 8 ميجابايت قبل الضغط)', true); return; }
    if (!/image\/(png|jpe?g|webp)/i.test(file.type || '')) { toast('نوع الصورة غير مدعوم (PNG/JPG/WebP).', true); return; }
    var keepAlpha = /image\/(png|webp)/i.test(file.type || '');
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 640;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var out = keepAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88);
        if (out.length > 2.4 * 1024 * 1024) {
          var c2 = document.createElement('canvas');
          c2.width = Math.max(1, Math.round(c.width * 0.7)); c2.height = Math.max(1, Math.round(c.height * 0.7));
          c2.getContext('2d').drawImage(c, 0, 0, c2.width, c2.height);
          out = keepAlpha ? c2.toDataURL('image/png') : c2.toDataURL('image/jpeg', 0.85);
        }
        cb(out, keepAlpha);
      };
      img.onerror = function () { toast('الملف ليس صورة صالحة.', true); };
      img.src = reader.result;
    };
    reader.onerror = function () { toast('تعذّرت قراءة الملف.', true); };
    reader.readAsDataURL(file);
  }
  function saveTeacher(id) {
    var payload = {
      name: $('tName').value.trim(),
      slug: $('tSlug').value.trim(),
      email: $('tEmail').value.trim(),
      username: $('tUsername').value.trim(),
      password: $('tPassword') ? $('tPassword').value : '',
      phone: $('tPhone').value.trim(),
      specialty: $('tSpecialty').value.trim(),
      bio: $('tBio').value.trim(),
      socialLinks: { whatsapp: $('tWhats').value.trim(), facebook: $('tFb').value.trim(), tiktok: $('tTt').value.trim(), youtube: $('tYt').value.trim() },
      requirePhone: $('tReqPhone').checked,
      enabled: $('tEnabled').checked,
      unlimited: $('tUnlimited').checked,
      maxAttempts: parseInt($('tMaxAtt').value, 10) || 3,
      offlineMode: $('tOffMode').checked,
      studentLimitUnlimited: $('tStuUnl').checked,
      studentLimit: Math.max(0, parseInt($('tStuLimit').value, 10) || 0)
    };
    if (A.pendingPhoto !== null) payload.photo = A.pendingPhoto || '';
    payload.photoFit = $('tPhotoFit') ? $('tPhotoFit').value : '';
    if (!payload.name) { $('tErr').textContent = 'اسم المعلم مطلوب.'; return; }
    $('tSave').disabled = true;
    api(id ? '/api/admin/teachers/' + id : '/api/admin/teachers', {
      method: id ? 'PUT' : 'POST', body: JSON.stringify(payload)
    }).then(function () {
      toast('تم الحفظ بنجاح');
      A.pendingPhoto = null;
      document.querySelector('.tform-bg').remove();
      renderTeachers($('aContent'));
    }).catch(function (e) {
      $('tSave').disabled = false;
      $('tErr').textContent = e.message;
    });
  }

  /* لوحة المعلم (إحصائيات) */
  function teacherDash(id) {
    var t = A.teachers.filter(function (x) { return x.id === id; })[0] || { name: '' };
    var overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML =
      '<div class="modal" style="max-width:640px"><h3>لوحة المعلم: ' + esc(t.name) + '</h3>' +
      '<div id="tdBody"><div class="empty"><div class="spin"></div></div></div>' +
      '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إغلاق</button></div></div>';
    document.body.appendChild(overlay);
    api('/api/admin/teachers/' + id + '/stats').then(function (d) {
      var sl = d.studentLimit || { unlimited: true, current: d.totals.students };
      var h = '<div class="stat-grid" style="margin-top:12px">' +
        stat(d.totals.results, 'نتيجة') + stat(d.totals.students, 'طالبًا') +
        stat(d.totals.avgPercentage + '%', 'متوسط النسب') + stat(d.totals.passRate + '%', 'نسبة النجاح') + '</div>' +
        '<div class="section-title"><h3>حد الطلاب</h3></div><div class="stat-grid">' +
        stat(sl.unlimited ? '∞' : sl.limit, 'الحد') + stat(sl.current, 'الحالي') + stat(sl.unlimited ? '∞' : sl.remaining, 'المتبقي') + '</div>' +
        '<div class="section-title"><h3>حسب الامتحان</h3></div>' +
        (d.perExam.length ? '<div style="overflow-x:auto"><table class="tbl"><tr><th>الامتحان</th><th>المحاولات</th><th>المتوسط</th></tr>' +
          d.perExam.map(function (e) { return '<tr><td style="font-size:.8rem">' + esc(e.title) + '</td><td>' + e.attempts + '</td><td>' + e.avgPercentage + '%</td></tr>'; }).join('') + '</table></div>' : '<div class="empty">لا نتائج بعد.</div>') +
        '<div class="section-title"><h3>أحدث النتائج</h3></div>' +
        (d.recent.length ? '<div style="overflow-x:auto"><table class="tbl"><tr><th>الطالب</th><th>الامتحان</th><th>الدرجة</th></tr>' +
          d.recent.map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td style="font-size:.78rem">' + esc(r.examLabel) + '</td><td><b>' + r.score + '/' + r.total + '</b></td></tr>'; }).join('') + '</table></div>' : '');
      $('tdBody').innerHTML = h;
    }).catch(function (e) { $('tdBody').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  /* ================= أشجار المحتوى ================= */
  function renderSubjectTree(body, subjectId) {
    api('/api/admin/exams').then(function (d) {
      var cat = d.catalog[subjectId];
      var exams = d.exams;
      var html = '<div class="section-title"><h3>' + esc(cat.name) + ' — ' + esc(cat.gradeName) + '</h3></div>';
      if (subjectId === 'psychology') {
        cat.units.forEach(function (u) {
          html += '<div class="card" style="margin-bottom:12px"><div style="font-weight:800;color:var(--primary-deep)">' + esc(u.title) + '</div><div class="grid" style="gap:8px;margin-top:10px">';
          u.lessons.forEach(function (l) { var e = exams[l.examIds[0]]; html += treeRow('موضوع ' + l.no, l.title, e.count); });
          html += treeRow('شامل', 'الامتحان الشامل — ' + u.title, exams[u.comprehensiveExamId].count);
          html += '</div></div>';
        });
        html += '<div class="card" style="border-color:var(--accent)">' + treeRow('شامل عام', 'الامتحان الشامل — المنهج كاملًا', exams[cat.subjectComprehensiveExamId].count) + '</div>';
      } else {
        cat.terms.forEach(function (term) {
          var tCount = 0; term.sections.forEach(function (sec) { sec.topics.forEach(function (tp) { tp.lessons.forEach(function (l) { tCount += l.trainings.length; }); }); });
          html += '<div class="section-title" style="margin-top:18px"><h3>' + esc(term.label) + '</h3><span class="count">' + tCount + ' تدريبًا</span></div>';
          term.sections.forEach(function (sec) {
            html += '<div class="card" style="margin-bottom:12px"><div style="font-weight:800;color:var(--primary-deep)">' + esc(sec.title) + ' — ' + sec.topics.length + ' موضوعات</div>';
            sec.topics.forEach(function (tp) {
              html += '<div style="font-weight:800;font-size:.92rem;margin:12px 0 4px">الموضوع ' + tp.no + ': ' + esc(tp.title) + ' <span class="badge">' + tp.lessons.length + ' دروس</span></div>';
              tp.lessons.forEach(function (l) {
                html += '<div style="font-weight:700;font-size:.85rem;margin:8px 8px 6px;color:var(--muted)">الدرس ' + l.no + ' — ' + esc(l.title) + ' (' + l.trainings.length + ' تدريب)</div><div class="grid" style="gap:8px">';
                l.trainings.forEach(function (tr) { var e = exams[tr.examId]; html += treeRow(tr.title, 'الدرس ' + l.no + ' — ' + l.title, e.count, e.id); });
                html += '</div>';
              });
            });
            html += '</div>';
          });
          if (term.comprehensiveExamIds && term.comprehensiveExamIds.length) {
            html += '<div class="card" style="border-color:var(--accent)"><div style="font-weight:800;color:var(--primary-deep);margin-bottom:8px">امتحانات شاملة</div><div class="grid" style="gap:8px">';
            term.comprehensiveExamIds.forEach(function (id) { html += treeRow('شامل', exams[id].title, exams[id].count, id); });
            html += '</div></div>';
          }
        });
      }
      body.innerHTML = html;
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function treeRow(kicker, title, count, extra) {
    return '<div style="display:flex;gap:10px;align-items:center;background:var(--bg-2);border:1px solid var(--line);border-radius:10px;padding:10px 12px">' +
      '<span class="badge">' + esc(kicker) + '</span><span style="flex:1;font-size:.9rem;font-weight:700">' + esc(title) + '</span>' +
      (extra ? '<span class="badge gold">' + esc(extra) + '</span>' : '') +
      '<span class="badge green">' + count + ' س</span></div>';
  }

  /* ================= CMS: بنك الأسئلة (إدارة كاملة) =================
   * عرض/بحث/تصفية + تعديل/إنشاء/تكرار/حذف/استعادة — المفاتيح ظاهرة هنا فقط
   * (جلسة مسؤول + CSRF)، ولا تصل لأي واجهة طلابية أبدًا. */
  function renderBank(body) {
    var f = A.bankFilters;
    body.innerHTML =
      '<div class="cms-bar">' +
      '<div class="cms-bar-t"><h2>بنك الأسئلة</h2><p>كل أسئلة المنصة مع مفاتيحها — التعديل هنا يُخزَّن كطبقة فوقية فوق البنك الأصلي ولا يمسّه.</p></div>' +
      '<div class="cms-bar-a"><button class="btn small" onclick="openQuestionEditor(null)">+ سؤال جديد</button>' +
      '<button class="btn small ghost" onclick="openDeletedQuestions()">سلة المحذوفات</button></div>' +
      '</div>' +
      '<div class="filters cms-filters">' +
      '<select id="fSubject" onchange="bankFilter()"><option value="">كل المواد</option><option value="psychology"' + (f.subject === 'psychology' ? ' selected' : '') + '>علم النفس</option><option value="philosophy"' + (f.subject === 'philosophy' ? ' selected' : '') + '>الفلسفة والمنطق</option></select>' +
      '<select id="fTerm" onchange="bankFilter()"><option value="">كل الترمات</option><option value="1"' + (f.term === '1' ? ' selected' : '') + '>الترم الأول</option><option value="2"' + (f.term === '2' ? ' selected' : '') + '>الترم الثاني</option></select>' +
      '<select id="fOnly" onchange="bankFilter()"><option value="">كل الأسئلة</option><option value="custom"' + (f.only === 'custom' ? ' selected' : '') + '>مضافة/مستوردة</option><option value="edited"' + (f.only === 'edited' ? ' selected' : '') + '>معدّلة</option><option value="base"' + (f.only === 'base' ? ' selected' : '') + '>أصلية بلا تعديل</option></select>' +
      '<input id="fLesson" placeholder="بحث بالدرس/الفصل…" value="' + esc(f.lesson) + '" onchange="bankFilter()">' +
      '<input id="fQ" placeholder="بحث في نص السؤال…" value="' + esc(f.q) + '" onchange="bankFilter()">' +
      '<button class="btn small" onclick="bankFilter()">بحث</button></div>' +
      '<div id="bankList"><div class="empty"><div class="spin"></div></div></div>';
    loadBank();
  }
  function bankFilter() {
    A.bankFilters = { subject: $('fSubject').value, term: $('fTerm').value, lesson: $('fLesson').value.trim(), q: $('fQ').value.trim(), only: $('fOnly').value };
    A.bankPage = 1;
    loadBank();
  }
  function loadBank() {
    var f = A.bankFilters;
    var qs = '?subject=' + encodeURIComponent(f.subject) + '&term=' + encodeURIComponent(f.term) + '&lesson=' + encodeURIComponent(f.lesson) + '&q=' + encodeURIComponent(f.q) + '&only=' + encodeURIComponent(f.only || '') + '&page=' + A.bankPage;
    api('/api/admin/questions' + qs).then(function (d) {
      var el = $('bankList');
      if (!el) return;
      if (!d.questions.length) { el.innerHTML = '<div class="empty">لا نتائج مطابقة.</div>'; return; }
      el.innerHTML =
        '<div class="cms-counts">' +
        '<span class="cchip">' + d.counts.all + ' سؤالًا</span>' +
        '<span class="cchip gold">' + d.counts.custom + ' مضاف/مستورد</span>' +
        '<span class="cchip blue">' + d.counts.edited + ' معدّل</span>' +
        '<span class="cchip red">' + d.counts.deleted + ' في السلة</span>' +
        '<span class="cchip muted">صفحة ' + d.page + ' من ' + Math.ceil(d.total / d.perPage) + '</span>' +
        '</div>' +
        d.questions.map(function (q) {
          return '<div class="rq cms-q">' +
            '<div class="no"><span class="qid" dir="ltr">' + esc(q.id) + '</span> · ' + esc(q.meta.subject) +
            (q.meta.term ? ' · ترم ' + q.meta.term : '') +
            (q.custom ? ' <span class="badge gold">مضاف</span>' : (q.edited ? ' <span class="badge blue">معدّل</span>' : ' <span class="badge green">موثق</span>')) +
            '<span class="cms-q-acts">' +
            '<button class="ibtn" title="تعديل السؤال" onclick="openQuestionEditor(\'' + esc(q.id) + '\')">' + I_EDIT + '</button>' +
            '<button class="ibtn" title="تكرار السؤال" onclick="duplicateQuestion(\'' + esc(q.id) + '\')">' + I_COPY + '</button>' +
            '<button class="ibtn danger" title="حذف السؤال" onclick="deleteQuestion(\'' + esc(q.id) + '\')">' + I_TRASH + '</button>' +
            '</span></div>' +
            '<div class="q">' + esc(q.text) + '</div>' +
            '<div class="cms-opts">' +
            q.options.map(function (o, i) {
              var isAns = LETTERS[i] === q.answer;
              return '<div class="ans' + (isAns ? ' correct' : '') + '"><span class="k">' + LETTERS[i] + '</span>' + esc(o) + (isAns ? ' <b class="ktag">الإجابة الصحيحة</b>' : '') + '</div>';
            }).join('') +
            '</div>' +
            '<div class="no cms-qmeta">' + (q.meta.lesson || q.meta.chapter ? esc(q.meta.lesson || q.meta.chapter) + ' · ' : '') + 'يُستخدم في ' + q.usedBy + ' امتحان' + (q.meta.source ? ' · ' + esc(q.meta.source) : '') + '</div>' +
            '</div>';
        }).join('') +
        '<div class="cms-pager">' +
        (A.bankPage > 1 ? '<button class="btn small ghost" onclick="bankPage(' + (A.bankPage - 1) + ')">السابق</button>' : '') +
        (A.bankPage < Math.ceil(d.total / d.perPage) ? '<button class="btn small ghost" onclick="bankPage(' + (A.bankPage + 1) + ')">التالي</button>' : '') +
        '</div>';
    }).catch(function (e) { var el = $('bankList'); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function bankPage(p) { A.bankPage = p; loadBank(); }

  /* ---- محرر السؤال (إنشاء/تعديل) — واجهة آمنة للمفتاح ---- */
  function openQuestionEditor(qid, prefill) {
    var done = function (q, edited) {
      var m = (q && q.meta) || {};
      var v = prefill || {};
      var overlay = document.createElement('div');
      overlay.className = 'modal-bg';
      overlay.innerHTML =
        '<div class="modal cms-qmodal"><h3>' + (q ? 'تعديل السؤال' : 'سؤال جديد') + '</h3>' +
        '<p class="desc" style="font-size:.76rem;color:var(--muted)">نص السؤال والخيارات ومفتاح الإجابة — الحقول المطلوبة معلّمة بـ *</p>' +
        '<div class="field"><label>نص السؤال *</label><textarea id="qeText" rows="3" maxlength="3000">' + esc(q ? q.text : (v.text || '')) + '</textarea></div>' +
        '<div class="cms-optgrid">' +
        LETTERS.map(function (L, i) {
          return '<div class="field cms-optfield"><label><span class="kchip' + (q && q.answer === L ? ' on' : '') + '" data-k="' + L + '">' + L + '</span> الخيار ' + L + ' (' + LETTER_AR[L] + ') *</label><input id="qeOpt' + L + '" maxlength="600" value="' + esc(q ? q.options[i] : ((v.options || [])[i] || '')) + '"></div>';
        }).join('') +
        '</div>' +
        '<div class="field"><label>الإجابة الصحيحة * <span class="hint">A/B/C/D — تُحفظ بالحرف اللاتيني كما في البنك وملف الاستيراد</span></label><div class="cms-keypick" id="qeKey">' +
        LETTERS.map(function (L) {
          return '<button type="button" class="kbtn' + (q && q.answer === L ? ' on' : '') + '" data-k="' + L + '" title="الخيار ' + LETTER_AR[L] + '" onclick="qePickKey(\'' + L + '\')">' + L + '<i>' + LETTER_AR[L] + '</i></button>';
        }).join('') + '</div><input type="hidden" id="qeAnswer" value="' + esc(q ? q.answer : (v.answer || '')) + '"></div>' +
        '<div class="cms-meta-grid">' +
        '<div class="field"><label>المادة</label><select id="qeSubject"><option value="philosophy"' + (m.subjectId === 'psychology' ? '' : ' selected') + '>الفلسفة والمنطق</option><option value="psychology"' + (m.subjectId === 'psychology' ? ' selected' : '') + '>علم النفس</option></select></div>' +
        '<div class="field"><label>الترم</label><select id="qeTerm"><option value="">بدون</option><option value="1"' + (String(m.term) === '1' ? ' selected' : '') + '>الترم الأول</option><option value="2"' + (String(m.term) === '2' ? ' selected' : '') + '>الترم الثاني</option></select></div>' +
        '<div class="field"><label>الوحدة / الموضوع</label><input id="qeUnit" maxlength="80" value="' + esc(m.unit || m.topic || '') + '"></div>' +
        '<div class="field"><label>الدرس</label><input id="qeLesson" maxlength="200" value="' + esc(m.lesson || m.chapter || '') + '"></div>' +
        '<div class="field full"><label>المصدر</label><input id="qeSource" maxlength="200" value="' + esc(m.source || '') + '" placeholder="مثال: كتاب الأسئلة الرسمي / إضافة المعلم"></div>' +
        '</div>' +
        '<div class="err" id="qeErr"></div>' +
        '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إلغاء</button>' +
        (q && edited ? '<button class="btn ghost" onclick="revertQuestion(\'' + esc(qid) + '\')">' + I_REVERT + ' استعادة الأصل</button>' : '') +
        '<button class="btn" onclick="saveQuestionEditor(\'' + (qid || '') + '\')">' + (q ? 'حفظ التعديلات' : 'حفظ السؤال') + '</button></div></div>';
      document.body.appendChild(overlay);
      var t = $('qeText'); if (t) setTimeout(function () { t.focus(); }, 60);
    };
    if (!qid) { done(null); return; }
    // edited تأتي أعلى استجابة الخادم (بجانب question) لا داخلها
    api('/api/admin/questions/' + encodeURIComponent(qid)).then(function (d) { done(d.question, d.edited === true); }).catch(function (e) { toast(e.message, true); });
  }
  function revertQuestion(qid) {
    confirmModal('استعادة الأصل', '<p>سيُحذف تعديل الطبقة الفوقية ويعود السؤال حرفيًا كما في البنك الأصلي (نصًا وخيارات ومفتاحًا).</p>', 'استعادة الأصل', function () {
      api('/api/admin/questions/' + encodeURIComponent(qid) + '/revert', { method: 'POST', body: '{}' })
        .then(function () {
          toast('تمت استعادة السؤال الأصل من البنك.');
          var ed = document.querySelector('.cms-qmodal'); if (ed) { var bg = ed.closest('.modal-bg'); if (bg) bg.remove(); }
          if (A.tab === 'bank') loadBank();
          if (A.ee) refreshExamEditor();
        })
        .catch(function (e) { toast(e.message, true); });
    });
  }
  function qePickKey(L) {
    $('qeAnswer').value = L;
    document.querySelectorAll('#qeKey .kbtn').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-k') === L); });
  }
  function saveQuestionEditor(qid) {
    var payload = {
      text: $('qeText').value,
      options: LETTERS.map(function (L) { return $('qeOpt' + L).value; }),
      answer: $('qeAnswer').value,
      meta: {
        subjectId: $('qeSubject').value,
        term: $('qeTerm').value === '' ? null : parseInt($('qeTerm').value, 10),
        unit: $('qeUnit').value, lesson: $('qeLesson').value, source: $('qeSource').value
      }
    };
    var err = $('qeErr'); err.textContent = '';
    api('/api/admin/questions' + (qid ? '/' + encodeURIComponent(qid) : ''), { method: qid ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      .then(function (d) {
        document.querySelector('.modal-bg').remove();
        toast(qid ? 'تم حفظ تعديلات السؤال.' : 'تمت إضافة السؤال (' + d.id + ').');
        if (A.tab === 'bank') loadBank();
        if (A.ee && A.ee.ids.indexOf(qid) !== -1) refreshExamEditor();
      })
      .catch(function (e) { err.textContent = e.message; });
  }
  function duplicateQuestion(qid) {
    api('/api/admin/questions/' + encodeURIComponent(qid) + '/duplicate', { method: 'POST', body: '{}' })
      .then(function (d) { toast('تم إنشاء نسخة: ' + d.id); loadBank(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function deleteQuestion(qid) {
    api('/api/admin/questions/' + encodeURIComponent(qid)).then(function (d) {
      var used = (d.usedBy || []).map(function (u) { return u.title; });
      confirmModal('حذف السؤال',
        '<p>سيُزال السؤال من البنك ومن كل الامتحانات التي تستخدمه' + (used.length ? ' (' + esc(used.slice(0, 3).join('، ')) + (used.length > 3 ? '…' : '') + ')' : '') + '.</p><p class="desc" style="font-size:.76rem;color:var(--muted)">الحذف غير تدميري: يبقى السؤال في سلة المحذوفات ويمكن استعادته.</p>',
        'حذف', function () {
          api('/api/admin/questions/' + encodeURIComponent(qid), { method: 'DELETE' }).then(function (r) {
            toast('تم الحذف — تأثّر ' + r.affectedExams + ' امتحان.');
            if (A.tab === 'bank') loadBank();
            if (A.ee) refreshExamEditor();
          }).catch(function (e) { toast(e.message, true); });
        });
    }).catch(function (e) { toast(e.message, true); });
  }
  function openDeletedQuestions() {
    api('/api/admin/questions/deleted').then(function (d) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-bg';
      overlay.innerHTML = '<div class="modal"><h3>سلة المحذوفات — الأسئلة</h3>' +
        (d.questions.length
          ? '<div class="cms-deleted">' + d.questions.map(function (q) {
            return '<div class="dr"><div><b dir="ltr" style="font-size:.72rem">' + esc(q.id) + '</b> <span style="font-size:.82rem">' + esc(String(q.text).slice(0, 90)) + '…</span></div>' +
              '<button class="btn small ghost" onclick="restoreQuestion(\'' + esc(q.id) + '\')">استعادة</button></div>';
          }).join('') + '</div>'
          : '<div class="empty">السلة فارغة.</div>') +
        '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إغلاق</button></div></div>';
      document.body.appendChild(overlay);
    }).catch(function (e) { toast(e.message, true); });
  }
  function restoreQuestion(qid) {
    api('/api/admin/questions/' + encodeURIComponent(qid) + '/restore', { method: 'POST', body: '{}' })
      .then(function () { toast('تمت الاستعادة.'); document.querySelector('.modal-bg').remove(); if (A.tab === 'bank') loadBank(); if (A.ee) refreshExamEditor(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function confirmModal(title, html, okLabel, onOk) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML = '<div class="modal" style="max-width:460px"><h3>' + esc(title) + '</h3>' + html +
      '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إلغاء</button>' +
      '<button class="btn danger" id="cmOk">' + esc(okLabel) + '</button></div></div>';
    document.body.appendChild(overlay);
    $('cmOk').addEventListener('click', function () { overlay.remove(); onOk(); });
  }

  /* ================= CMS: الامتحانات ================= */
  function renderExams(body) {
    if (A.ee) { renderExamEditor(body); return; }
    var f = A.examFilters || (A.examFilters = { q: '', subject: '', term: '', status: '' });
    body.innerHTML =
      '<div class="cms-bar">' +
      '<div class="cms-bar-t"><h2>الامتحانات</h2><p>فتح/تعديل/ترتيب/تعطيل/استيراد/تصدير — كل امتحانات المنصة بما فيها المخصّصة والمستوردة.</p></div>' +
      '<div class="cms-bar-a">' +
      '<button class="btn small" onclick="openExamEditor(null)">+ امتحان جديد</button>' +
      '<button class="btn small gold" onclick="setTab(\'import\')">' + I_IMPORT + ' استيراد امتحان</button>' +
      '<button class="btn small ghost" onclick="openDeletedExams()">سلة المحذوفات</button>' +
      '</div></div>' +
      '<div class="filters cms-filters">' +
      '<input id="exQ" placeholder="بحث بالعنوان أو المعرف…" value="' + esc(f.q) + '" oninput="examFilterDebounced()">' +
      '<select id="exSubject" onchange="examFilter()"><option value="">كل المواد</option><option value="psychology"' + (f.subject === 'psychology' ? ' selected' : '') + '>علم النفس</option><option value="philosophy"' + (f.subject === 'philosophy' ? ' selected' : '') + '>الفلسفة والمنطق</option></select>' +
      '<select id="exTerm" onchange="examFilter()"><option value="">كل الترمات</option><option value="1"' + (f.term === '1' ? ' selected' : '') + '>الترم الأول</option><option value="2"' + (f.term === '2' ? ' selected' : '') + '>الترم الثاني</option></select>' +
      '<select id="exStatus" onchange="examFilter()"><option value="">كل الحالات</option><option value="enabled"' + (f.status === 'enabled' ? ' selected' : '') + '>نشط</option><option value="disabled"' + (f.status === 'disabled' ? ' selected' : '') + '>معطّل</option><option value="custom"' + (f.status === 'custom' ? ' selected' : '') + '>مخصّص/مستورد</option><option value="edited"' + (f.status === 'edited' ? ' selected' : '') + '>معدّل</option></select>' +
      '</div>' +
      '<div id="exList"><div class="empty"><div class="spin"></div></div></div>';
    loadExams();
  }
  var exFT = null;
  function examFilterDebounced() { clearTimeout(exFT); exFT = setTimeout(examFilter, 250); }
  function examFilter() {
    A.examFilters = { q: ($('exQ') || {}).value || '', subject: ($('exSubject') || {}).value || '', term: ($('exTerm') || {}).value || '', status: ($('exStatus') || {}).value || '' };
    loadExams();
  }
  function loadExams() {
    var f = A.examFilters || {};
    var qs = '?q=' + encodeURIComponent(f.q || '') + '&subject=' + encodeURIComponent(f.subject || '') + '&term=' + encodeURIComponent(f.term || '') + '&status=' + encodeURIComponent(f.status || '');
    api('/api/admin/exams' + qs).then(function (d) {
      var el = $('exList');
      if (!el) return;
      if (!d.exams.length) { el.innerHTML = '<div class="empty">لا امتحانات مطابقة.</div>'; return; }
      el.innerHTML =
        '<div class="cms-counts"><span class="cchip">' + d.counts.all + ' امتحانًا</span><span class="cchip gold">' + d.counts.custom + ' مخصّص/مستورد</span><span class="cchip blue">' + d.counts.edited + ' معدّل</span><span class="cchip red">' + d.counts.disabled + ' معطّل</span></div>' +
        '<div class="cms-exlist">' +
        d.exams.map(function (e) {
          return '<div class="cms-exrow">' +
            '<div class="ex-i"><div class="ex-t">' + esc(e.title) + ' ' +
            (e.custom ? '<span class="badge gold">مخصّص</span>' : '') +
            (e.modified && !e.custom ? '<span class="badge blue">معدّل</span>' : '') +
            (e.enabled === false ? '<span class="badge red">معطّل</span>' : '') +
            (e.legacy ? '<span class="badge">قديم</span>' : '') + '</div>' +
            '<div class="ex-s"><span dir="ltr" class="qid">' + esc(e.id) + '</span> · ' + (e.subjectId === 'psychology' ? 'علم النفس' : 'الفلسفة والمنطق') +
            (e.term ? ' · ترم ' + e.term : '') + ' · ' + typeLabel(e.type) + ' · ' + e.count + ' سؤالًا' + (e.grade ? ' · ' + esc(e.grade) : '') + '</div></div>' +
            '<div class="ex-a">' +
            '<button class="btn small" onclick="openExamEditor(\'' + esc(e.id) + '\')">فتح المحرر</button>' +
            '<button class="ibtn" title="تصدير JSON" onclick="exportExam(\'' + esc(e.id) + '\')">' + I_EXPORT + '</button>' +
            '<button class="ibtn" title="' + (e.enabled === false ? 'تفعيل' : 'تعطيل') + '" onclick="toggleExam(\'' + esc(e.id) + '\',' + (e.enabled === false) + ')">' + (e.enabled === false ? I_EYE : I_EYEOFF) + '</button>' +
            '</div></div>';
        }).join('') + '</div>';
    }).catch(function (e) { var el = $('exList'); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function typeLabel(t) {
    return { topic: 'موضوع', training: 'تدريب', 'unit-comprehensive': 'شامل وحدة', 'term-comprehensive': 'شامل ترم', 'subject-comprehensive': 'شامل مادة', custom: 'مخصّص' }[t] || t;
  }
  function toggleExam(id, enable) {
    api('/api/admin/exams/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ enabled: enable }) })
      .then(function () { toast(enable ? 'تم تفعيل الامتحان.' : 'تم تعطيل الامتحان — لن يظهر للطلاب.'); loadExams(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function exportExam(id) {
    api('/api/admin/exams/' + encodeURIComponent(id) + '/export').then(function (d) {
      var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'exam-' + id + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      toast('تم تنزيل ملف الامتحان بالصيغة القياسية.');
    }).catch(function (e) { toast(e.message, true); });
  }
  function openDeletedExams() {
    api('/api/admin/exams/deleted').then(function (d) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-bg';
      overlay.innerHTML = '<div class="modal"><h3>سلة المحذوفات — الامتحانات</h3>' +
        (d.exams.length
          ? '<div class="cms-deleted">' + d.exams.map(function (e) {
            return '<div class="dr"><div><b dir="ltr" style="font-size:.72rem">' + esc(e.id) + '</b> <span style="font-size:.82rem">' + esc(e.title) + '</span></div>' +
              '<button class="btn small ghost" onclick="restoreExam(\'' + esc(e.id) + '\')">استعادة</button></div>';
          }).join('') + '</div>'
          : '<div class="empty">السلة فارغة.</div>') +
        '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إغلاق</button></div></div>';
      document.body.appendChild(overlay);
    }).catch(function (e) { toast(e.message, true); });
  }
  function restoreExam(id) {
    api('/api/admin/exams/' + encodeURIComponent(id) + '/restore', { method: 'POST', body: '{}' })
      .then(function () { toast('تمت الاستعادة.'); document.querySelector('.modal-bg').remove(); loadExams(); })
      .catch(function (e) { toast(e.message, true); });
  }

  /* ================= CMS: محرر الامتحان ================= */
  function openExamEditor(id) {
    if (!id) {
      A.ee = { id: null, title: '', subjectId: 'philosophy', term: null, grade: '', enabled: true, ids: [], qs: [], dirty: false, isNew: true };
      renderTab();
      return;
    }
    A.ee = { id: id, loading: true };
    renderTab();
    api('/api/admin/exams/' + encodeURIComponent(id)).then(function (d) {
      A.ee = {
        id: id, isNew: false, dirty: false,
        title: d.exam.title, subjectId: d.exam.subjectId, term: d.exam.term == null ? null : d.exam.term,
        grade: d.exam.grade || '', enabled: d.exam.enabled !== false, custom: d.exam.custom === true, modified: d.exam.modified === true,
        ids: d.questionIds.slice(), qs: d.questions.slice()
      };
      renderTab();
    }).catch(function (e) { A.ee = null; toast(e.message, true); renderTab(); });
  }
  function closeExamEditor() {
    if (A.ee && A.ee.dirty && !confirm('لديك تغييرات غير محفوظة في المحرر — خروج دون حفظ؟')) return;
    A.ee = null;
    renderTab();
  }
  function refreshExamEditor() {
    if (!A.ee || !A.ee.id) return;
    var keep = A.ee;
    api('/api/admin/exams/' + encodeURIComponent(keep.id)).then(function (d) {
      A.ee.ids = d.questionIds.slice(); A.ee.qs = d.questions.slice();
      if (A.tab === 'exams') renderTab();
    }).catch(function () { });
  }
  function renderExamEditor(body) {
    var ee = A.ee;
    if (!ee) { renderExams(body); return; }
    if (ee.loading) { body.innerHTML = '<div class="empty"><div class="spin"></div></div>'; return; }
    body.innerHTML =
      '<div class="cms-bar">' +
      '<div class="cms-bar-t"><button class="ibtn big" onclick="closeExamEditor()" title="رجوع">' + I_BACK + '</button>' +
      '<div><h2>' + (ee.isNew ? 'امتحان جديد' : 'تعديل الامتحان') + '</h2><p>' + (ee.isNew ? 'أنشئ امتحانًا مخصّصًا واختر أسئلته من البنك.' : '<span dir="ltr" class="qid">' + esc(ee.id) + '</span>' + (ee.custom ? ' · مخصّص' : (ee.modified ? ' · معدّل عن الأصل' : ' · من البنك الأصلي'))) + '</p></div></div>' +
      '<div class="cms-bar-a">' +
      (!ee.isNew ? '<button class="btn small ghost" onclick="exportExam(\'' + esc(ee.id) + '\')">' + I_EXPORT + ' تصدير</button>' : '') +
      (!ee.isNew && !ee.custom ? '<button class="btn small ghost" onclick="revertExam()">' + I_REVERT + ' استعادة الأصل</button>' : '') +
      (!ee.isNew ? '<button class="btn small ghost" onclick="toggleExamEE()">' + (ee.enabled ? I_EYEOFF + ' تعطيل' : I_EYE + ' تفعيل') + '</button>' : '') +
      (!ee.isNew ? '<button class="btn small danger" onclick="deleteExam(\'' + esc(ee.id) + '\')">' + I_TRASH + ' حذف</button>' : '') +
      '<button class="btn" onclick="saveExamEE()">حفظ التعديلات</button>' +
      '</div></div>' +
      '<div class="cms-editor">' +
      '<div class="cms-ed-meta card">' +
      '<div class="field"><label>اسم الامتحان *</label><input id="eeTitle" maxlength="200" value="' + esc(ee.title) + '" oninput="eeDirty()"></div>' +
      '<div class="cms-meta-grid">' +
      '<div class="field"><label>المادة</label><select id="eeSubject" onchange="eeDirty()"><option value="philosophy"' + (ee.subjectId === 'psychology' ? '' : ' selected') + '>الفلسفة والمنطق</option><option value="psychology"' + (ee.subjectId === 'psychology' ? ' selected' : '') + '>علم النفس</option></select></div>' +
      '<div class="field"><label>الترم</label><select id="eeTerm" onchange="eeDirty()"><option value=""' + (ee.term == null ? ' selected' : '') + '>بدون</option><option value="1"' + (ee.term === 1 ? ' selected' : '') + '>الترم الأول</option><option value="2"' + (ee.term === 2 ? ' selected' : '') + '>الترم الثاني</option></select></div>' +
      '<div class="field"><label>الصف</label><input id="eeGrade" maxlength="80" value="' + esc(ee.grade) + '" placeholder="الصف الأول الثانوي" oninput="eeDirty()"></div>' +
      '</div>' +
      '<div class="cms-ed-count"><span class="cchip blue">' + ee.ids.length + ' سؤالًا في الامتحان</span>' + (ee.dirty ? '<span class="cchip gold">تغييرات غير محفوظة</span>' : '') + '</div>' +
      '</div>' +
      '<div class="cms-ed-list">' +
      '<div class="cms-ed-head"><h3>الأسئلة</h3><div><button class="btn small" onclick="openQuestionPicker()">+ إضافة سؤال</button></div></div>' +
      (ee.ids.length ? '<div id="eeRows">' + eeRowsHtml() + '</div>' : '<div class="empty">لا أسئلة بعد — اضغط «+ إضافة سؤال» للاختيار من البنك أو إنشاء سؤال جديد.</div>') +
      '</div></div>';
  }
  function eeRowsHtml() {
    var ee = A.ee;
    return ee.qs.map(function (q, i) {
      return '<div class="ee-row">' +
        '<span class="ee-n">' + (i + 1) + '</span>' +
        '<div class="ee-b"><div class="ee-t">' + esc(q.text) + '</div>' +
        '<div class="ee-m"><span dir="ltr" class="qid">' + esc(q.id) + '</span> · مفتاح <b class="ktag">' + esc(q.answer) + '</b> · ' + esc((q.meta && q.meta.subject) || '') + (q.meta && q.meta.lesson ? ' · ' + esc(String(q.meta.lesson).slice(0, 40)) : '') + '</div></div>' +
        '<div class="ee-a">' +
        '<button class="ibtn" title="تعديل السؤال" onclick="openQuestionEditor(\'' + esc(q.id) + '\')">' + I_EDIT + '</button>' +
        '<button class="ibtn" title="لأعلى" onclick="eeMove(' + i + ',-1)"' + (i === 0 ? ' disabled' : '') + '>' + I_UP + '</button>' +
        '<button class="ibtn" title="لأسفل" onclick="eeMove(' + i + ',1)"' + (i === ee.qs.length - 1 ? ' disabled' : '') + '>' + I_DOWN + '</button>' +
        '<button class="ibtn danger" title="إزالة من الامتحان" onclick="eeRemove(' + i + ')">' + I_TRASH + '</button>' +
        '</div></div>';
    }).join('');
  }
  function eeDirty() { if (A.ee) A.ee.dirty = true; }
  function eeMove(i, dir) {
    var ee = A.ee; var j = i + dir;
    if (j < 0 || j >= ee.ids.length) return;
    var t = ee.ids[i]; ee.ids[i] = ee.ids[j]; ee.ids[j] = t;
    var q = ee.qs[i]; ee.qs[i] = ee.qs[j]; ee.qs[j] = q;
    ee.dirty = true; $('eeRows').innerHTML = eeRowsHtml();
    var c = document.querySelector('.cms-ed-count'); if (c) c.innerHTML = '<span class="cchip blue">' + ee.ids.length + ' سؤالًا في الامتحان</span><span class="cchip gold">تغييرات غير محفوظة</span>';
  }
  function eeRemove(i) {
    var ee = A.ee;
    ee.ids.splice(i, 1); ee.qs.splice(i, 1); ee.dirty = true;
    if (!ee.ids.length) { renderTab(); return; }
    $('eeRows').innerHTML = eeRowsHtml();
  }
  function toggleExamEE() {
    var ee = A.ee;
    api('/api/admin/exams/' + encodeURIComponent(ee.id), { method: 'PUT', body: JSON.stringify({ enabled: !ee.enabled }) })
      .then(function () { ee.enabled = !ee.enabled; toast(ee.enabled ? 'تم التفعيل.' : 'تم التعطيل.'); renderTab(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function deleteExam(id) {
    confirmModal('حذف الامتحان', '<p>سيُنقل الامتحان إلى سلة المحذوفات — الأسئلة والنتائج لا تُحذف، ويمكن استعادة الامتحان لاحقًا من السلة.</p>', 'حذف الامتحان', function () {
      api('/api/admin/exams/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
          toast('تم نقل الامتحان إلى سلة المحذوفات.');
          A.ee = null;
          if (A.tab !== 'exams') setTab('exams'); else renderTab();
          loadExams();
        })
        .catch(function (e) { toast(e.message, true); });
    });
  }
  function revertExam() {
    confirmModal('استعادة الأصل', '<p>سيُحذف كل تعديل محفوظ على هذا الامتحان (العنوان/الترتيب/التعطيل) ويعود حرفيًا لتعريف البنك الأصلي.</p>', 'استعادة الأصل', function () {
      api('/api/admin/exams/' + encodeURIComponent(A.ee.id) + '/revert', { method: 'POST', body: '{}' })
        .then(function () { toast('تمت استعادة الأصل.'); openExamEditor(A.ee.id); })
        .catch(function (e) { toast(e.message, true); });
    });
  }
  function saveExamEE() {
    var ee = A.ee;
    var payload = {
      title: $('eeTitle').value.trim(),
      subjectId: $('eeSubject').value,
      term: $('eeTerm').value === '' ? null : parseInt($('eeTerm').value, 10),
      grade: $('eeGrade').value.trim(),
      questionIds: ee.ids
    };
    if (!payload.title) { toast('اسم الامتحان مطلوب.', true); return; }
    if (!ee.ids.length) { toast('أضف سؤالًا واحدًا على الأقل.', true); return; }
    if (ee.isNew) {
      api('/api/admin/exams', { method: 'POST', body: JSON.stringify(payload) }).then(function (d) {
        toast('تم إنشاء الامتحان (' + d.id + ').');
        openExamEditor(d.id);
      }).catch(function (e) { toast(e.message, true); });
      return;
    }
    api('/api/admin/exams/' + encodeURIComponent(ee.id), { method: 'PUT', body: JSON.stringify(payload) }).then(function (d) {
      ee.dirty = false;
      toast('تم حفظ الامتحان (' + d.count + ' سؤالًا).');
      openExamEditor(ee.id);
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ---- منتقي الأسئلة من البنك (إضافة دون تكرار) ---- */
  function openQuestionPicker() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML = '<div class="modal cms-picker"><h3>إضافة أسئلة من البنك</h3>' +
      '<p class="desc" style="font-size:.76rem;color:var(--muted)">الأسئلة تُربط من البنك المركزي نفسه — لا تُنسخ. اختر سؤالًا أو أكثر ثم أضفه.</p>' +
      '<div class="filters cms-filters"><input id="pkQ" placeholder="بحث في نص السؤال…" oninput="pkDebounced()">' +
      '<select id="pkSubject" onchange="pkLoad(1)"><option value="">كل المواد</option><option value="psychology">علم النفس</option><option value="philosophy">الفلسفة والمنطق</option></select>' +
      '<select id="pkTerm" onchange="pkLoad(1)"><option value="">كل الترمات</option><option value="1">الأول</option><option value="2">الثاني</option></select></div>' +
      '<div id="pkList" class="cms-pklist"><div class="empty"><div class="spin"></div></div></div>' +
      '<div class="cms-pkfoot"><span id="pkSel" class="cchip blue">0 محدد</span>' +
      '<div class="acts"><button class="btn ghost" onclick="openQuestionEditor(null)">+ سؤال جديد</button>' +
      '<button class="btn" onclick="pkAdd()">إضافة إلى الامتحان</button></div></div></div>';
    document.body.appendChild(overlay);
    A.pkSel = {};
    pkLoad(1);
  }
  var pkT = null;
  function pkDebounced() { clearTimeout(pkT); pkT = setTimeout(function () { pkLoad(1); }, 250); }
  function pkLoad(page) {
    A.pkPage = page || 1;
    var qs = '?q=' + encodeURIComponent(($('pkQ') || {}).value || '') + '&subject=' + encodeURIComponent(($('pkSubject') || {}).value || '') + '&term=' + encodeURIComponent(($('pkTerm') || {}).value || '') + '&page=' + A.pkPage + '&perPage=20';
    api('/api/admin/questions' + qs).then(function (d) {
      var el = $('pkList');
      if (!el) return;
      if (!d.questions.length) { el.innerHTML = '<div class="empty">لا نتائج.</div>'; return; }
      var ee = A.ee || { ids: [] };
      el.innerHTML = d.questions.map(function (q) {
        var inExam = ee.ids.indexOf(q.id) !== -1;
        return '<label class="pk-row' + (inExam ? ' inexam' : '') + '"><input type="checkbox" value="' + esc(q.id) + '" onchange="pkToggle(this)"' + (inExam ? ' disabled' : '') + '>' +
          '<span class="pk-b"><span class="pk-t">' + esc(q.text) + '</span>' +
          '<span class="pk-m"><span dir="ltr" class="qid">' + esc(q.id) + '</span> · مفتاح <b class="ktag">' + esc(q.answer) + '</b>' + (inExam ? ' · <b>مضاف بالفعل</b>' : '') + '</span></span></label>';
      }).join('') +
        '<div class="cms-pager">' + (A.pkPage > 1 ? '<button class="btn small ghost" onclick="pkLoad(' + (A.pkPage - 1) + ')">السابق</button>' : '') +
        (A.pkPage < Math.ceil(d.total / d.perPage) ? '<button class="btn small ghost" onclick="pkLoad(' + (A.pkPage + 1) + ')">التالي</button>' : '') + '</div>';
    }).catch(function (e) { var el = $('pkList'); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function pkToggle(cb) {
    A.pkSel = A.pkSel || {};
    if (cb.checked) A.pkSel[cb.value] = true; else delete A.pkSel[cb.value];
    var n = Object.keys(A.pkSel).length;
    var s = $('pkSel'); if (s) s.textContent = n + ' محدد';
  }
  function pkAdd() {
    var ids = Object.keys(A.pkSel || {});
    if (!ids.length) { toast('اختر سؤالًا واحدًا على الأقل.', true); return; }
    // fetch full objects for the chosen ids (single batched call per id is fine: selection is small)
    Promise.all(ids.map(function (id) { return api('/api/admin/questions/' + encodeURIComponent(id)); })).then(function (res) {
      var ee = A.ee;
      res.forEach(function (r) {
        if (!r.question || ee.ids.indexOf(r.question.id) !== -1) return;
        ee.ids.push(r.question.id);
        ee.qs.push({ id: r.question.id, text: r.question.text, options: r.question.options, answer: r.question.answer, meta: r.question.meta });
      });
      ee.dirty = true;
      document.querySelector('.modal-bg').remove();
      toast('تمت إضافة ' + ids.length + ' سؤالًا إلى الامتحان (لم يُحفظ بعد).');
      renderTab();
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ================= CMS: استيراد امتحان من ملف ================= */
  function renderImport(body) {
    body.innerHTML =
      '<div class="cms-bar"><div class="cms-bar-t"><h2>استيراد امتحان</h2>' +
      '<p>ارفع ملفًا بالصيغة القياسية (JSON) — تُعرض معاينة وتحقق كامل قبل أي حفظ، ولا يُستورد شيء دون تأكيدك.</p></div>' +
      '<div class="cms-bar-a"><button class="btn small ghost" onclick="downloadTemplate()">' + I_EXPORT + ' تنزيل نموذج JSON</button></div></div>' +
      '<div class="card cms-import">' +
      '<div class="cms-drop" id="impDrop">' + I_IMPORT +
      '<div class="t">اسحب ملف الامتحان هنا أو اضغط للاختيار</div>' +
      '<div class="s">JSON بصيغة المنصة القياسية — موثّقة في docs/exam-import-format.md</div>' +
      '<input type="file" id="impFile" accept=".json,application/json" style="display:none"></div>' +
      '<div id="impName" class="cchip muted" style="margin-top:10px;display:none"></div>' +
      '<div class="acts" style="margin-top:14px"><button class="btn" id="impPrevBtn" onclick="importPreview()" disabled>معاينة وتحقق</button></div>' +
      '</div>' +
      '<div id="impReport"></div>';
    var inp = $('impFile'), drop = $('impDrop');
    drop.addEventListener('click', function () { inp.click(); });
    inp.addEventListener('change', function () { if (inp.files[0]) readImportFile(inp.files[0]); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readImportFile(e.dataTransfer.files[0]); });
  }
  function readImportFile(file) {
    if (file.size > 5 * 1024 * 1024) { toast('الملف كبير جدًا (الحد 5 ميجابايت).', true); return; }
    var r = new FileReader();
    r.onload = function () {
      A.importText = String(r.result || '');
      A.importName = file.name;
      var n = $('impName'); n.style.display = ''; n.textContent = file.name + ' · ' + (file.size / 1024).toFixed(1) + 'KB';
      $('impPrevBtn').disabled = false;
      $('impReport').innerHTML = '';
    };
    r.onerror = function () { toast('تعذّرت قراءة الملف.', true); };
    r.readAsText(file, 'utf-8');
  }
  function downloadTemplate() {
    var tpl = {
      version: 1,
      exam: { title: 'امتحان فلسفة — الوحدة الأولى', subject: 'الفلسفة والمنطق', term: 'الترم الأول', grade: 'الصف الأول الثانوي' },
      questions: [
        { text: 'نص السؤال هنا', options: { A: 'الخيار الأول', B: 'الخيار الثاني', C: 'الخيار الثالث', D: 'الخيار الرابع' }, correctAnswer: 'B' }
      ]
    };
    var blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'exam-template.json';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function importPreview() {
    if (!A.importText) { toast('اختر ملفًا أولًا.', true); return; }
    var rep = $('impReport');
    rep.innerHTML = '<div class="empty"><div class="spin"></div></div>';
    api('/api/admin/import/preview', { method: 'POST', body: JSON.stringify({ text: A.importText }) }).then(function (d) {
      var r = d.report;
      A.importReport = r;
      rep.innerHTML =
        '<div class="card cms-rep' + (r.ok ? ' ok' : ' bad') + '">' +
        '<h3>' + (r.ok ? 'تم العثور على ' + r.stats.total + ' سؤالًا — جاهز للمعاينة' : 'الملف غير صالح للاستيراد') + '</h3>' +
        '<div class="cms-counts">' +
        '<span class="cchip">الإجمالي ' + r.stats.total + '</span>' +
        '<span class="cchip green">جديد ' + r.stats.newCount + '</span>' +
        '<span class="cchip blue">موجود بالفعل ' + r.stats.existsInBank + '</span>' +
        '<span class="cchip gold">مكرر داخليًا ' + r.stats.duplicateInFile + '</span>' +
        '<span class="cchip red">غير صالح ' + r.stats.invalid + '</span>' +
        '</div>' +
        '<div class="kv" style="margin-top:10px"><div class="k">الامتحان</div><div>' + esc(r.exam.title || '—') + ' · ' + (r.exam.subjectId === 'psychology' ? 'علم النفس' : (r.exam.subjectId === 'philosophy' ? 'الفلسفة والمنطق' : '—')) + (r.exam.term ? ' · ترم ' + r.exam.term : '') + (r.exam.grade ? ' · ' + esc(r.exam.grade) : '') + '</div></div>' +
        (r.errors.length ? '<div class="rv-note warn" style="margin-top:12px"><div><b>أخطاء تمنع الاستيراد:</b><ul style="margin:6px 0 0 18px;font-size:.8rem">' + r.errors.slice(0, 12).map(function (e) { return '<li><code dir="ltr">' + esc(e.where) + '</code>: ' + esc(e.message) + '</li>'; }).join('') + (r.errors.length > 12 ? '<li>… و' + (r.errors.length - 12) + ' خطأ آخر</li>' : '') + '</ul></div></div>' : '') +
        (r.warnings.length ? '<div class="rv-note ok" style="margin-top:10px"><div><b>ملاحظات:</b><ul style="margin:6px 0 0 18px;font-size:.8rem">' + r.warnings.slice(0, 8).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div></div>' : '') +
        '<div class="cms-rep-list">' + r.rows.map(function (row) {
          return '<div class="rep-row ' + row.status + '"><span class="st">' + ({ 'new': 'جديد', exists: 'موجود', 'duplicate-file': 'مكرر', invalid: 'غير صالح' }[row.status] || row.status) + '</span>' +
            '<div><div class="rt">' + esc(row.text || '(نص فارغ)') + '</div>' +
            '<div class="rm">الإجابة: <b class="ktag">' + esc(row.correctAnswer || '—') + '</b>' + (row.existingId ? ' · <span dir="ltr" class="qid">' + esc(row.existingId) + '</span>' : '') + (row.problems.length ? ' · ' + esc(row.problems.join('، ')) : '') + '</div></div></div>';
        }).join('') + '</div>' +
        '<div class="acts" style="margin-top:14px">' +
        '<button class="btn ghost" onclick="document.getElementById(\'impReport\').innerHTML=\'\'">إلغاء</button>' +
        '<button class="btn gold" onclick="importCommit()"' + (r.ok ? '' : ' disabled') + '>استيراد (' + (r.stats.newCount + r.stats.existsInBank) + ' سؤالًا)</button>' +
        '</div></div>';
    }).catch(function (e) { rep.innerHTML = '<div class="rv-note warn">' + WARN_SVG_A + '<div>' + esc(e.message) + '</div></div>'; });
  }
  function importCommit() {
    if (!A.importText) return;
    confirmModal('تأكيد الاستيراد', '<p>سيُنشأ امتحان جديد بالأسئلة الصالحة: الأسئلة الموجودة في البنك تُربط كما هي، والجديدة تُضاف للبنك كمصادر موثّقة باسم الاستيراد.</p>', 'استيراد الآن', function () {
      api('/api/admin/import/commit', { method: 'POST', body: JSON.stringify({ text: A.importText, confirm: true }) }).then(function (d) {
        toast('تم الاستيراد: ' + d.total + ' سؤالًا (' + d.createdQuestions + ' جديد، ' + d.reusedQuestions + ' مرتبط).');
        A.importText = ''; A.importName = '';
        // المحرر يُرسم داخل تبويب الامتحانات — انقل المسؤول إليه ليفتح الامتحان المستورد مباشرة
        if (A.tab !== 'exams') setTab('exams');
        openExamEditor(d.examId);
      }).catch(function (e) { toast(e.message, true); });
    });
  }
  /* ================= النتائج ================= */
  function renderResults(body) {
    api('/api/admin/results').then(function (d) {
      if (!d.results.length) {
        body.innerHTML = '<div class="empty">لا توجد نتائج محفوظة بعد.<br><span style="font-size:.76rem">تُحفظ آخر ١٠٠ نتيجة هنا، وتُرسل جميع النتائج إلى Google Sheets عند ضبط الربط.</span></div>';
        return;
      }
      body.innerHTML =
        '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><a class="btn small ghost" href="/api/admin/results.csv" download>تصدير CSV</a></div>' +
        '<div class="card"><div style="overflow-x:auto"><table class="tbl">' +
        '<tr><th>التاريخ</th><th>الطالب</th><th>الهاتف</th><th>الامتحان</th><th>المادة</th><th>الدرجة</th><th>النسبة</th><th>المعلم</th></tr>' +
        d.results.map(function (r) {
          var pct = Math.round(r.percentage);
          var color = pct >= 50 ? 'var(--ok)' : 'var(--bad)';
          return '<tr><td style="font-size:.74rem">' + new Date(r.date).toLocaleString('ar-EG') + '</td>' +
            '<td>' + esc(r.name) + '</td><td dir="ltr" style="font-size:.76rem">' + esc(r.phone || '—') + '</td>' +
            '<td style="font-size:.8rem;max-width:220px">' + esc(r.examLabel) + '</td><td>' + esc(r.subject) + '</td>' +
            '<td><b>' + r.score + '/' + r.total + '</b></td><td style="color:' + color + ';font-weight:800">' + pct + '%</td>' +
            '<td><code>/' + esc(r.teacherSlug || '') + '</code></td></tr>';
        }).join('') + '</table></div></div>';
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  /* ================= الإعدادات ================= */
  var SETTING_TABS = [
    ['platform', I_TAG, 'هوية المنصة'], ['homepage', I_HOME, 'الصفحة الرئيسية'], ['appearance', I_PALETTE, 'الشكل العام'],
    ['social', I_LINK, 'التواصل'], ['sections', I_PUZZLE, 'الأقسام'], ['teacherDefaults', I_USERS, 'افتراضيات المعلمين'], ['account', I_LOCK, 'الحساب']
  ];
  function renderSettings(body) {
    api('/api/admin/settings').then(function (d) {
      A.settings = d.settings;
      A.settingsDirty = false;
      body.innerHTML =
        '<div class="st-tabs">' + SETTING_TABS.map(function (t) {
          return '<button class="tab' + (A.settingsTab === t[0] ? ' active' : '') + '" onclick="settingsPanel(\'' + t[0] + '\')">' + t[1] + ' ' + t[2] + '</button>';
        }).join('') + '</div>' +
        '<div id="stPanel"></div>';
      A.settingsTab = A.settingsTab || 'platform';
      settingsPanel(A.settingsTab);
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function settingsPanel(key) {
    if (A.settingsDirty && key !== A.settingsTab && !confirm('لديك تغييرات غير محفوظة — متابعة دون حفظ؟')) { return; }
    A.settingsTab = key;
    if (key !== 'account') A.settingsDirty = false;
    document.querySelectorAll('.st-tabs .tab').forEach(function (el, i) { el.classList.toggle('active', SETTING_TABS[i][0] === key); });
    var s = A.settings;
    var panel = $('stPanel');
    var html = '';
    if (key === 'platform') {
      html = stCard('هوية المنصة', 'الاسم والعام الدراسي والوصف والشعار — تظهر للطلاب في كل الصفحات.',
        stText('identity.platformName', 'اسم المنصة', s.identity.platformName, 'مثال: منصة الامتحانات', 80) +
        stText('identity.academicYear', 'العام الدراسي', s.identity.academicYear, 'مثال: 2026 / 2027', 60) +
        stText('identity.shortDescription', 'وصف قصير', s.identity.shortDescription, 'يظهر بجوار اسم المنصة', 160) +
        stLogo('identity.logo', 'شعار المنصة (اختياري)', s.identity.logo));
    } else if (key === 'homepage') {
      html = stCard('الصفحة الرئيسية', 'كل النصوص الرئيسية التي يراها الطالب — بدون تعديل أي كود.',
        '<div class="st-grid">' +
        stText('homepage.badgeText', 'النص الصغير أعلى الصفحة (Badge)', s.homepage.badgeText, '', 80) +
        stText('homepage.heroTitle', 'العنوان الرئيسي', s.homepage.heroTitle, '', 80) +
        stText('homepage.heroTitleAccent', 'الجزء الملوّن من العنوان', s.homepage.heroTitleAccent, '', 80) +
        stTextArea('homepage.heroSubtitle', 'النص التعريفي أسفل العنوان', s.homepage.heroSubtitle, 500) +
        stText('homepage.chip1', 'نص الشارة الأولى', s.homepage.chip1, '', 60) +
        stText('homepage.chip2', 'نص الشارة الثانية', s.homepage.chip2, '', 60) +
        stText('homepage.floatChip', 'نص الشارة فوق الصورة', s.homepage.floatChip, '', 30) +
        stText('homepage.ctaLabel', 'نص زر «ابدأ الامتحان»', s.homepage.ctaLabel, '', 40) +
        stText('homepage.whatsappCtaLabel', 'نص زر واتساب', s.homepage.whatsappCtaLabel, '', 40) +
        '</div>' +
        '<h3 style="margin:18px 0 4px;font-size:.9rem">عناوين الأقسام</h3>' +
        '<div class="st-grid">' +
        stText('homepage.subjectsTitle', 'عنوان قسم الصفوف', s.homepage.subjectsTitle, '', 60) +
        stText('homepage.featuresTitle', 'عنوان قسم المميزات', s.homepage.featuresTitle, '', 60) +
        stText('homepage.aboutTitle', 'عنوان قسم النبذة', s.homepage.aboutTitle, '', 60) +
        stText('homepage.contactTitle', 'عنوان قسم التواصل', s.homepage.contactTitle, '', 60) +
        '</div>' +
        '<h3 style="margin:18px 0 4px;font-size:.9rem">بطاقات المميزات</h3>' +
        '<div class="st-grid">' +
        stText('homepage.feature1Title', 'ميزة 1 — العنوان', s.homepage.feature1Title, '', 60) + stText('homepage.feature1Text', 'ميزة 1 — النص', s.homepage.feature1Text, '', 300) +
        stText('homepage.feature2Title', 'ميزة 2 — العنوان', s.homepage.feature2Title, '', 60) + stText('homepage.feature2Text', 'ميزة 2 — النص', s.homepage.feature2Text, '', 300) +
        stText('homepage.feature3Title', 'ميزة 3 — العنوان', s.homepage.feature3Title, '', 60) + stText('homepage.feature3Text', 'ميزة 3 — النص', s.homepage.feature3Text, '', 300) +
        stText('homepage.feature4Title', 'ميزة 4 — العنوان', s.homepage.feature4Title, '', 60) + stText('homepage.feature4Text', 'ميزة 4 — النص', s.homepage.feature4Text, '', 300) +
        '</div>');
    } else if (key === 'appearance') {
      html = stCard('الشكل العام', 'ألوان المنصة الأساسية — تُطبَّق فورًا على كل الصفحات. اختر لونًا أو اكتب قيمة HEX.',
        '<div class="st-grid">' +
        stColor('appearance.primary', 'اللون الأساسي (Primary)', s.appearance.primary) +
        stColor('appearance.accent', 'اللون الثانوي / الذهبي (Gold)', s.appearance.accent) +
        stColor('appearance.background', 'لون الخلفية', s.appearance.background) +
        stColor('appearance.text', 'لون النص', s.appearance.text) +
        stColor('appearance.button', 'لون الأزرار', s.appearance.button) +
        '</div>' +
        '<div class="st-actions"><button class="btn small ghost" onclick="settingsPreset(\'blue\')">النمط الأزرق</button>' +
        '<button class="btn small ghost" onclick="settingsPreset(\'green\')">النمط الأخضر</button>' +
        '<button class="btn small ghost" onclick="settingsPreset(\'purple\')">النمط البنفسجي</button>' +
        '<span class="note">أنماط جاهزة يمكن تخصيصها بعد ذلك</span></div>');
    } else if (key === 'social') {
      html = stCard('روابط المنصة', 'روابط عامة مرتبطة بالمنصة (تظهر في الصفحة الرئيسية للطالب) — اترك الحقل فارغًا لإخفائه.',
        '<div class="st-grid">' +
        stText('social.whatsapp', 'واتساب', s.social.whatsapp, 'https://wa.me/…') +
        stText('social.facebook', 'فيسبوك', s.social.facebook, 'https://facebook.com/…') +
        stText('social.tiktok', 'تيك توك', s.social.tiktok, 'https://tiktok.com/…') +
        stText('social.youtube', 'يوتيوب', s.social.youtube, 'https://youtube.com/…') +
        '</div>');
    } else if (key === 'sections') {
      html = stCard('إظهار/إخفاء الأقسام', 'تحكم في ظهور أقسام الصفحة الرئيسية للطالب.',
        '<div style="margin-top:4px">' +
        stToggle('sections.showFeatures', 'قسم المميزات', 'أظهر «لماذا المنصة؟»', s.sections.showFeatures) +
        stToggle('sections.showAbout', 'قسم عن المعلم', 'أظهر بطاقة المعلم والمنصة', s.sections.showAbout) +
        stToggle('sections.showContact', 'قسم تواصل معنا', 'أظهر روابط التواصل الكبيرة', s.sections.showContact) +
        stToggle('sections.showSocials', 'روابط التواصل داخل الهيرو', 'أظهر روابط التواصل بجانب النبذة', s.sections.showSocials) +
        '</div>');
    } else if (key === 'teacherDefaults') {
      html = stCard('افتراضيات المعلمين الجدد', 'تُطبَّق هذه القيم عند إنشاء معلم جديد (يمكن تعديل كل معلم على حدة لاحقًا).',
        '<div style="margin-top:4px">' +
        stToggle('teacherDefaults.requirePhone', 'طلب رقم الهاتف من الطالب', 'مفعّل افتراضيًا', s.teacherDefaults.requirePhone) +
        stToggle('teacherDefaults.unlimited', 'محاولات غير محدودة', 'عدد محاولات مفتوح لكل امتحان', s.teacherDefaults.unlimited) +
        stNumber('teacherDefaults.maxAttempts', 'الحد الأقصى للمحاولات', s.teacherDefaults.maxAttempts, 1, 50) +
        stToggle('teacherDefaults.offlineMode', 'وضع عدم الاتصال', 'صلاحية الجلسات 72 ساعة', s.teacherDefaults.offlineMode) +
        stToggle('teacherDefaults.studentLimitUnlimited', 'عدد طلاب غير محدود', 'بلا سقف لعدد الطلاب', s.teacherDefaults.studentLimitUnlimited) +
        stNumber('teacherDefaults.studentLimit', 'حد الطلاب (0 = إغلاق التسجيل)', s.teacherDefaults.studentLimit, 0, 1000000) +
        '</div>');
    } else if (key === 'account') {
      html = renderAdminPassword() +
        '<div class="st-card" style="margin-top:14px"><h3>معلومات النظام</h3><div class="kv" style="margin-top:10px">' +
        '<div class="k">حساب المسؤول</div><div>' + esc(A.session) + '</div>' +
        '<div class="k">الدخول الموحّد للمعلمين</div><div><code dir="ltr">' + esc(location.host) + '/teacher</code></div>' +
        '</div></div>';
    }
    if (key === 'account') {
      panel.innerHTML = html;
      return;
    }
    panel.innerHTML = html +
      '<div class="st-actions"><button class="btn" id="stSave" onclick="saveSettings()">حفظ الإعدادات</button>' +
      '<button class="btn ghost" onclick="loadSettingsDraft()">إعادة تعيين</button>' +
      '<span class="note" id="stDirty" style="display:none;color:var(--warn)">● لديك تغييرات غير محفوظة</span></div>';
    bindSettingsForm();
    if (key === 'appearance') panel.querySelectorAll('.color-field input[type=color]').forEach(function (c) { var txt = c.parentElement.querySelector('input[type=text]'); if (txt) c.value = normalizeColor(txt.value); });
  }
  function stCard(title, hint, inner) {
    return '<div class="st-section"><div class="st-card"><h3>' + title + '</h3><div class="hint">' + hint + '</div>' + inner + '</div></div>';
  }
  function stText(key, label, val, placeholder, max) {
    return '<div class="field"><label>' + label + '</label><input data-k="' + key + '" value="' + esc(val) + '" maxlength="' + max + '" placeholder="' + esc(placeholder || '') + '"></div>';
  }
  function stTextArea(key, label, val, max) {
    return '<div class="field full"><label>' + label + '</label><textarea data-k="' + key + '" rows="3" maxlength="' + max + '">' + esc(val) + '</textarea></div>';
  }
  function stNumber(key, label, val, min, max) {
    return '<div class="toggle-row"><div class="tl"><b>' + label + '</b></div><input data-k="' + key + '" type="number" min="' + min + '" max="' + max + '" value="' + (Number(val) || 0) + '" style="width:110px;flex:none"></div>';
  }
  function stToggle(key, label, hint, checked) {
    return '<div class="toggle-row"><div class="tl"><b>' + label + '</b><span>' + hint + '</span></div><label class="switch"><input data-k="' + key + '" type="checkbox"' + (checked ? ' checked' : '') + '><i></i></label></div>';
  }
  function stColor(key, label, val) {
    return '<div class="field"><label>' + label + '</label><div class="color-field"><span class="swatch" style="background:' + esc(normalizeColor(val)) + '"></span>' +
      '<input data-k="' + key + '" type="text" value="' + esc(val) + '" dir="ltr" maxlength="7">' +
      '<input type="color" value="' + esc(normalizeColor(val)) + '"></div></div>';
  }
  function stLogo(key, label, val) {
    return '<div class="field full"><label>' + label + '</label><div class="photo-upload"><div class="prev" id="logoPrev">' + (val ? '<img src="' + esc(val) + '" alt="">' : 'شعار') + '</div><div class="actions"><input type="file" id="logoFile" accept="image/*" style="font-size:.78rem"><button class="btn small ghost" id="logoClear" type="button">إزالة الشعار</button></div></div></div>';
  }
  function normalizeColor(v) {
    var s = String(v || '').trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : '#1E56C8';
  }
  function getDraft() {
    var draft = JSON.parse(JSON.stringify(A.settings));
    return draft;
  }
  function loadSettingsDraft() {
    api('/api/admin/settings').then(function (d) { A.settings = d.settings; A.settingsDirty = false; settingsPanel(A.settingsTab); });
  }
  function bindSettingsForm() {
    var panel = $('stPanel');
    panel.addEventListener('input', function (e) {
      var el = e.target;
      if (!el.getAttribute('data-k')) return;
      A.settingsDirty = true;
      $('stDirty').style.display = '';
    });
    panel.addEventListener('change', function (e) {
      var el = e.target;
      if (el.type === 'color') {
        var txt = el.parentElement.querySelector('input[type=text]');
        var swatch = el.parentElement.querySelector('.swatch');
        if (txt) { txt.value = el.value; txt.dispatchEvent(new Event('input')); }
        if (swatch) swatch.style.background = el.value;
      }
    });
    var logoFile = $('logoFile');
    if (logoFile) logoFile.addEventListener('change', function () { resizePhoto(this.files[0], function (d) { A.settingsDraftLogo = d; $('logoPrev').innerHTML = '<img src="' + d + '" alt="">'; A.settingsDirty = true; $('stDirty').style.display = ''; }); });
    var logoClear = $('logoClear');
    if (logoClear) logoClear.addEventListener('click', function () { A.settingsDraftLogo = ''; $('logoPrev').innerHTML = 'شعار'; A.settingsDirty = true; $('stDirty').style.display = ''; });
  }
  function saveSettings() {
    var draft = getDraft();
    var panel = $('stPanel');
    panel.querySelectorAll('[data-k]').forEach(function (el) {
      var key = el.getAttribute('data-k');
      var parts = key.split('.');
      var section = draft[parts[0]] = draft[parts[0]] || {};
      var val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') val = parseInt(el.value, 10) || 0;
      else val = el.value;
      section[parts[1]] = val;
    });
    if (A.settingsDraftLogo !== undefined && A.settingsDraftLogo !== null) draft.identity.logo = A.settingsDraftLogo;
    var btn = $('stSave');
    btn.disabled = true;
    api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(draft) }).then(function (d) {
      A.settings = d.settings;
      A.settingsDirty = false;
      A.settingsDraftLogo = undefined;
      toast('تم حفظ الإعدادات — ستظهر للطلاب خلال دقيقة');
      $('stDirty').style.display = 'none';
      btn.disabled = false;
      settingsPanel(A.settingsTab);
    }).catch(function (e) { toast(e.message, true); btn.disabled = false; });
  }
  function settingsPreset(name) {
    var p = $('stPanel');
    var set = function (k, v) {
      var el = p.querySelector('[data-k="' + k + '"]');
      if (!el) return;
      if (el.type === 'color') { el.value = v; el.dispatchEvent(new Event('change')); }
      else { el.value = v; el.dispatchEvent(new Event('input')); }
    };
    if (name === 'blue') { set('appearance.primary', '#1E56C8'); set('appearance.accent', '#C99A2E'); set('appearance.background', '#F5F7FD'); set('appearance.text', '#1B2540'); set('appearance.button', '#1E56C8'); }
    else if (name === 'green') { set('appearance.primary', '#0E7C4A'); set('appearance.accent', '#D9A441'); set('appearance.background', '#F3F8F4'); set('appearance.text', '#17351F'); set('appearance.button', '#0E7C4A'); }
    else if (name === 'purple') { set('appearance.primary', '#5B2C8E'); set('appearance.accent', '#C98A2E'); set('appearance.background', '#F6F3FB'); set('appearance.text', '#251533'); set('appearance.button', '#5B2C8E'); }
  }

  /* ================= كلمة مرور المسؤول (ضمن الإعدادات) ================= */
  function renderAdminPassword() {
    return '<div class="st-card"><h3>تغيير كلمة مرور المسؤول</h3><div class="hint">كلمة المرور تُخزَّن مشفّرة (PBKDF2-120k) ولا يمكن استعادتها.</div>' +
      '<div class="field"><label>كلمة المرور الحالية</label><input type="password" id="pwCur" autocomplete="current-password"></div>' +
      '<div class="field"><label>كلمة المرور الجديدة (8 أحرف على الأقل)</label><input type="password" id="pwNew" autocomplete="new-password"></div>' +
      '<div class="field"><label>تأكيد كلمة المرور الجديدة</label><input type="password" id="pwNew2" autocomplete="new-password"></div>' +
      '<div id="pwErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:8px"></div>' +
      '<button class="btn" id="pwBtn" onclick="changePassword()">تغيير كلمة المرور</button></div>';
  }
  function changePassword() {
    var cur = $('pwCur').value, next = $('pwNew').value, next2 = $('pwNew2').value;
    var err = $('pwErr');
    err.textContent = '';
    if (next !== next2) { err.textContent = 'كلمتا المرور الجديدتان غير متطابقتين.'; return; }
    if (next.length < 8) { err.textContent = 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.'; return; }
    var btn = $('pwBtn');
    btn.disabled = true;
    api('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: cur, next: next }) })
      .then(function () {
        toast('تم تغيير كلمة المرور بنجاح');
        $('pwCur').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
        btn.disabled = false;
      })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; });
  }

  /* ================= التصدير ================= */
  window.doLogin = doLogin;
  window.logout = logout;
  window.setTab = setTab;
  window.editTeacher = editTeacher;
  window.saveTeacher = saveTeacher;
  window.deleteTeacher = deleteTeacher;
  window.setTeacherEnabled = setTeacherEnabled;
  window.restoreTeacher = restoreTeacher;
  window.resetTeacherPassword = resetTeacherPassword;
  window.doResetPassword = doResetPassword;
  window.copyLink = copyLink;
  window.copyLogin = copyLogin;
  window.teacherDash = teacherDash;
  window.bankFilter = bankFilter;
  window.bankPage = bankPage;
  window.filterTeachers = filterTeachers;
  window.settingsPanel = settingsPanel;
  window.saveSettings = saveSettings;
  window.settingsPreset = settingsPreset;
  window.changePassword = changePassword;
  /* CMS */
  window.openQuestionEditor = openQuestionEditor;
  window.saveQuestionEditor = saveQuestionEditor;
  window.qePickKey = qePickKey;
  window.duplicateQuestion = duplicateQuestion;
  window.deleteQuestion = deleteQuestion;
  window.openDeletedQuestions = openDeletedQuestions;
  window.restoreQuestion = restoreQuestion;
  window.openExamEditor = openExamEditor;
  window.closeExamEditor = closeExamEditor;
  window.saveExamEE = saveExamEE;
  window.eeMove = eeMove;
  window.eeRemove = eeRemove;
  window.toggleExamEE = toggleExamEE;
  window.revertExam = revertExam;
  window.deleteExam = deleteExam;
  window.revertQuestion = revertQuestion;
  window.openQuestionPicker = openQuestionPicker;
  window.pkLoad = pkLoad;
  window.pkToggle = pkToggle;
  window.pkAdd = pkAdd;
  window.toggleExam = toggleExam;
  window.exportExam = exportExam;
  window.openDeletedExams = openDeletedExams;
  window.restoreExam = restoreExam;
  window.examFilter = examFilter;
  window.examFilterDebounced = examFilterDebounced;
  window.importPreview = importPreview;
  window.importCommit = importCommit;
  window.downloadTemplate = downloadTemplate;

  /* boot */
  api('/api/admin/session').then(enter).catch(function () {
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: '', password: '' }) })
      .then(function () { renderLogin(false); })
      .catch(function (e) { renderLogin(String(e.message).indexOf('لم يُنشأ') !== -1); });
  });
})();
