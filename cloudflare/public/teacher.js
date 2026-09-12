/* لوحة المعلم — تسجيل دخول فقط (لا تسجيل ذاتي للمعلم) ثم Dashboard مبسّط:
 * الرئيسية / الطلاب / النتائج / الملف الشخصي / الإعدادات. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var app = $('tApp');
  var T = { tab: 'home', session: null, settings: null };
  /* أيقونات SVG متناسقة بدل الإيموجي */
  var ICO = function (p, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; };
  var I_HOME = ICO('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>');
  var I_USERS = ICO('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.2 14.7c2 .7 3.3 2.4 3.3 5.3"/>');
  var I_RESULTS = ICO('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h4"/>');
  var I_USER = ICO('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>');
  var I_LOCK = ICO('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');
  var I_CAP = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 1 8l11 5 9-4.09V15h2V8L12 3zm-7 9.18V16c0 1.66 3.13 3 7 3s7-1.34 7-3v-3.82l-7 3.18-7-3.18z"/></svg>';
  var I_LINK = ICO('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>');
  var I_CHART = ICO('<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="1"/><rect x="12" y="8" width="3" height="10" rx="1"/><rect x="17" y="5" width="3" height="13" rx="1"/>');
  var I_COPY = ICO('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  var I_CHECK = ICO('<path d="M20 6L9 17l-5-5"/>', 2.4);

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
        if ((r.status === 401 || r.status === 403) && path !== '/api/t/login') { T.session = null; renderLogin(); throw new Error(data.error || 'انتهت الجلسة.'); }
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

  /* ============ تسجيل الدخول ============ */
  function renderLogin(errMsg) {
    var st = (T.settings && T.settings.identity) || {};
    var platformName = st.platformName || 'منصة الامتحانات';
    var shortDesc = st.shortDescription || 'منصة امتحانات إلكترونية للمرحلة الثانوية';
    var logo = st.logo || '';
    app.innerHTML =
      '<div class="tlogin">' +
      '<div class="tlogin-brand">' +
      '<div class="lb-logo">' + (logo ? '<img src="' + esc(logo) + '" alt="">' : I_CAP) + '</div>' +
      '<div><h1>لوحة المعلم</h1><p>' + esc(platformName) + ' — ' + esc(shortDesc) + '</p></div>' +
      '<ul>' +
      '<li><span class="dot">' + I_USERS + '</span> تابع طلابك ونتائجهم من مكان واحد</li>' +
      '<li><span class="dot">' + I_LINK + '</span> رابط ثابت لطلابك جاهز للمشاركة</li>' +
      '<li><span class="dot">' + I_CHART + '</span> نتائج فورية وتصحيح خادمي كامل</li>' +
      '</ul>' +
      '</div>' +
      '<div class="tlogin-form">' +
      '<div class="tlogin-card">' +
      '<div class="tlogin-header"><div class="tlogin-icon">' + I_USER + '</div><h2>تسجيل دخول المعلم</h2><p>أدخل بريدك الإلكتروني أو اسم المستخدم وكلمة المرور</p></div>' +
      '<form onsubmit="tDoLogin();return false">' +
      '<div class="field"><label for="tEmail">البريد الإلكتروني / اسم المستخدم</label><input type="text" id="tEmail" autocomplete="username" placeholder="اسم المستخدم أو البريد"></div>' +
      '<div class="field"><label for="tPass">كلمة المرور</label><input type="password" id="tPass" autocomplete="current-password" placeholder="••••••••"></div>' +
      '<div id="loginErr" class="t-err">' + esc(errMsg || '') + '</div>' +
      '<button class="btn" id="loginBtn" type="submit">تسجيل الدخول</button>' +
      '</form>' +
      '</div>' +
      '</div>' +
      '</div>';
    setTimeout(function () { var el = $('tEmail'); if (el) el.focus(); }, 50);
  }

  function tDoLogin() {
    var email = $('tEmail').value.trim(), pass = $('tPass').value, err = $('loginErr');
    err.textContent = '';
    if (!email || !pass) { err.textContent = 'يرجى إدخال البريد وكلمة المرور.'; return; }
    var btn = $('loginBtn');
    btn.disabled = true; btn.textContent = 'جارٍ الدخول…';
    api('/api/t/login', { method: 'POST', body: JSON.stringify({ email: email, password: pass }) })
      .then(function (d) { T.session = d; enterDashboard(); })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'تسجيل الدخول'; });
  }
  function tLogout() { api('/api/t/logout', { method: 'POST' }).then(function () { location.reload(); }); }

  /* ============ الصفحة الرئيسية (بعد الدخول) ============ */
  function renderShell() {
    app.innerHTML =
      '<header class="t-topbar">' +
      '<div class="brand"><div class="logo">' + I_USER + '</div><div><h1>لوحة المعلم</h1><div class="sub" id="tPlatformSub">منصة الامتحانات</div></div></div>' +
      '<div class="spacer"></div>' +
      '<div class="who"><span class="chip" id="teacherName"></span><button class="btn ghost small" onclick="tLogout()">خروج</button></div>' +
      '</header>' +
      '<div class="t-shell">' +
      '<nav class="t-sidebar" aria-label="التنقل">' +
      '<button class="t-nav-item active" data-tab="home" onclick="tSetTab(\'home\')"><span class="t-nav-icon">' + I_HOME + '</span>الرئيسية</button>' +
      '<button class="t-nav-item" data-tab="students" onclick="tSetTab(\'students\')"><span class="t-nav-icon">' + I_USERS + '</span>الطلاب</button>' +
      '<button class="t-nav-item" data-tab="results" onclick="tSetTab(\'results\')"><span class="t-nav-icon">' + I_RESULTS + '</span>النتائج</button>' +
      '<button class="t-nav-item" data-tab="profile" onclick="tSetTab(\'profile\')"><span class="t-nav-icon">' + I_USER + '</span>الملف الشخصي</button>' +
      '<button class="t-nav-item" data-tab="settings" onclick="tSetTab(\'settings\')"><span class="t-nav-icon">' + I_LOCK + '</span>كلمة المرور</button>' +
      '</nav>' +
      '<main class="t-main" id="tMain"><div class="t-loading"><div class="spin"></div></div></main>' +
      '</div>';
  }
  function enterDashboard() {
    return api('/api/t/session').then(function (d) {
      T.session = d;
      renderShell();
      focusActiveTab();
      $('teacherName').textContent = d.name;
      if (T.settings && T.settings.identity) $('tPlatformSub').textContent = T.settings.identity.platformName || 'منصة الامتحانات';
      renderTab();
    }).catch(function () { renderLogin(); });
  }
  /* على الجوال الشريط أفقي قابل للتمرير: نُظهر التبويب النشط داخل الرؤية دائمًا */
  function focusActiveTab() {
    var act = document.querySelector('.t-nav-item.active');
    if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { } }
  }
  function tSetTab(t) {
    T.tab = t;
    document.querySelectorAll('.t-nav-item').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-tab') === t); });
    focusActiveTab();
    renderTab();
  }
  function renderTab() {
    if (T.tab === 'home') renderHome();
    else if (T.tab === 'students') renderStudents();
    else if (T.tab === 'results') renderResults();
    else if (T.tab === 'profile') renderProfile();
    else if (T.tab === 'settings') renderSettings();
  }

  /* ============ الرئيسية ============ */
  function renderHome() {
    var main = $('tMain');
    main.innerHTML = '<div class="t-loading"><div class="spin"></div></div>';
    api('/api/t/dashboard').then(function (d) {
      var t = d.totals;
      main.innerHTML =
        '<div class="t-welcome">' +
        '<div class="tw-avatar" id="twAvatar">' + esc((d.teacher.name || '؟').slice(0, 2)) + '</div>' +
        '<div><h2>مرحبًا، ' + esc(d.teacher.name) + '</h2><div class="tw-sub">رابطك: <code dir="ltr">' + esc(location.origin + '/' + d.teacher.slug) + '</code></div></div>' +
        '<div class="tw-link"><button class="btn ghost small" onclick="tCopyLink()">' + I_COPY + ' نسخ رابط الطلاب</button></div>' +
        '</div>' +
        '<div class="t-stat-grid">' +
        stat(I_USERS, 'الطلاب المسجّلون', t.registeredStudents || t.students) +
        stat(I_RESULTS, 'النتائج', t.results) +
        stat(I_CHART, 'متوسط الدرجات', t.avgPercentage + '%') +
        stat(I_CHECK, 'نسبة النجاح', t.passRate + '%') +
        '</div>' +
        '<div class="t-grid-2">' +
        '<div class="card"><h3 class="t-card-title">آخر النشاط</h3>' +
        (d.recent.length ? d.recent.slice(0, 8).map(function (r) {
          var pct = Math.round(r.percentage);
          return '<div class="t-recent-item"><span class="t-r-name">' + esc(r.name) + '</span><span class="t-r-exam">' + esc(r.examLabel) + '</span><span class="t-r-score ' + (pct >= 50 ? 't-pass' : 't-fail') + '">' + pct + '%</span></div>';
        }).join('') : '<div class="empty">لا توجد نتائج بعد</div>') +
        '</div>' +
        '<div class="card"><h3 class="t-card-title">أكثر الامتحانات محاولةً</h3>' +
        (d.perExam.length ? d.perExam.slice(0, 8).map(function (e) {
          return '<div class="t-exam-item"><span class="t-e-title">' + esc(e.title) + '</span><span class="t-e-badge">' + e.attempts + ' محاولة</span></div>';
        }).join('') : '<div class="empty">لا توجد بيانات بعد</div>') +
        '</div>' +
        '</div>';
      // جلب الصورة لتحسين بطاقة الترحيب
      api('/api/t/profile').then(function (p) {
        var av = $('twAvatar');
        if (av && p.teacher.photo) av.innerHTML = '<img src="' + esc(p.teacher.photo) + '" alt="">';
      }).catch(function () {});
    }).catch(function (e) { main.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function stat(icon, label, value) {
    return '<div class="t-stat-card"><div class="t-stat-icon">' + icon + '</div><div class="t-stat-body"><div class="t-stat-val">' + esc(String(value)) + '</div><div class="t-stat-label">' + esc(label) + '</div></div></div>';
  }
  function tCopyLink() {
    var url = location.origin + '/' + (T.session ? T.session.slug : '');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('تم نسخ رابط الطلاب'); }, function () { prompt('انسخ الرابط:', url); });
    else prompt('انسخ الرابط:', url);
  }

  /* ============ الطلاب ============ */
  function renderStudents() {
    var main = $('tMain');
    main.innerHTML = '<div class="t-page-header"><h2>الطلاب</h2></div><div class="t-search-bar"><input type="search" id="stuSearch" placeholder="ابحث بالاسم أو الهاتف…" oninput="tSearchStudents()"></div><div id="stuList"><div class="t-loading"><div class="spin"></div></div></div>';
    loadStudents();
  }
  function loadStudents(q) {
    api('/api/t/students' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (d) {
      var el = $('stuList');
      if (!el) return;
      if (!d.students.length) { el.innerHTML = '<div class="empty">لا يوجد طلاب بعد</div>'; return; }
      el.innerHTML = '<div class="t-count">' + d.total + ' طالب</div>' + d.students.map(function (s) {
        return '<div class="t-stu-card"><div class="t-stu-avatar">' + esc(s.name.charAt(0)) + '</div><div class="t-stu-info"><div class="t-stu-name">' + esc(s.name) + '</div><div class="t-stu-meta">' + (s.phone ? esc(s.phone) + ' · ' : '') + s.examCount + ' امتحان</div></div><div class="t-stu-stats"><div class="t-stu-pct ' + (s.avgPercentage >= 50 ? 't-pass' : 't-fail') + '">' + s.avgPercentage + '%</div></div></div>';
      }).join('');
    }).catch(function (e) { var el = $('stuList'); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  var stuTimer;
  function tSearchStudents() { clearTimeout(stuTimer); stuTimer = setTimeout(function () { loadStudents($('stuSearch').value.trim()); }, 300); }

  /* ============ النتائج ============ */
  function renderResults() {
    var main = $('tMain');
    main.innerHTML = '<div class="t-page-header"><h2>النتائج</h2></div><div class="t-filters"><input type="search" id="resSearch" placeholder="بحث بالاسم أو الهاتف…" oninput="tSearchResults()"><select id="resSubject" onchange="tSearchResults()"><option value="">كل المواد</option><option value="علم النفس">علم النفس</option><option value="الفلسفة والمنطق">الفلسفة والمنطق</option></select></div><div id="resList"><div class="t-loading"><div class="spin"></div></div></div>';
    loadResults();
  }
  function loadResults(page, q, subject) {
    page = page || 1; q = q || ''; subject = subject || '';
    var url = '/api/t/results?page=' + page;
    if (q) url += '&q=' + encodeURIComponent(q);
    if (subject) url += '&subject=' + encodeURIComponent(subject);
    api(url).then(function (d) {
      var el = $('resList');
      if (!el) return;
      if (!d.results.length) { el.innerHTML = '<div class="empty">لا توجد نتائج بعد</div>'; return; }
      el.innerHTML = d.results.map(function (r) {
        var pct = Math.round(r.percentage); var cls = pct >= 50 ? 't-pass' : 't-fail';
        return '<div class="t-result-card"><div class="t-res-head"><span class="t-res-name">' + esc(r.name) + '</span><span class="t-res-date">' + new Date(r.date).toLocaleDateString('ar-EG') + '</span></div><div class="t-res-body"><span class="t-res-exam">' + esc(r.examLabel) + '</span><span class="t-res-subj">' + esc(r.subject) + '</span></div><div class="t-res-score"><span class="' + cls + '">' + r.score + '/' + r.total + '</span><span class="t-res-pct ' + cls + '">' + pct + '%</span></div></div>';
      }).join('');
    }).catch(function (e) { var el = $('resList'); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  var resTimer;
  function tSearchResults() { clearTimeout(resTimer); resTimer = setTimeout(function () { loadResults(1, $('resSearch').value.trim(), $('resSubject').value); }, 300); }

  /* ============ الملف الشخصي ============ */
  function renderProfile() {
    var main = $('tMain');
    main.innerHTML = '<div class="t-page-header"><h2>الملف الشخصي</h2></div><div class="card" id="pfCard"><div class="t-loading"><div class="spin"></div></div></div>';
    api('/api/t/profile').then(function (d) {
      var t = d.teacher; T.profileSlug = t.slug;
      var sl = t.socialLinks || {};
      $('pfCard').innerHTML =
        '<div class="t-profile-head"><div class="t-profile-avatar">' + (t.photo ? '<img src="' + esc(t.photo) + '" alt="">' : esc((t.name || '؟').slice(0, 2))) + '</div>' +
        '<div><h3 class="t-card-title" style="margin:0">' + esc(t.name) + '</h3><div class="desc" style="font-size:.78rem">' + esc(t.specialty || '') + '</div></div></div>' +
        '<div class="t-link-share"><span class="lbl">رابط طلابك:</span><code>' + esc(location.origin + t.studentUrl) + '</code><button class="btn small" onclick="tCopyLink()">نسخ</button></div>' +
        '<div class="field"><label>الاسم</label><input type="text" id="pfName" value="' + esc(t.name) + '" maxlength="80"></div>' +
        '<div class="field"><label>الهاتف</label><input type="text" id="pfPhone" value="' + esc(t.phone || '') + '" dir="ltr"></div>' +
        '<div class="field"><label>نبذة المدرس (تظهر لطلابك في صفحتك)</label><textarea id="pfBio" rows="3" maxlength="500">' + esc(t.bio || '') + '</textarea></div>' +
        '<div class="field"><label>واتساب</label><input type="url" id="pfWa" dir="ltr" placeholder="https://…" value="' + esc(sl.whatsapp || '') + '"></div>' +
        '<div class="field"><label>فيسبوك</label><input type="url" id="pfFb" dir="ltr" placeholder="https://…" value="' + esc(sl.facebook || '') + '"></div>' +
        '<div class="field"><label>تيك توك</label><input type="url" id="pfTk" dir="ltr" placeholder="https://…" value="' + esc(sl.tiktok || '') + '"></div>' +
        '<div class="field"><label>يوتيوب</label><input type="url" id="pfYt" dir="ltr" placeholder="https://…" value="' + esc(sl.youtube || '') + '"></div>' +
        '<div id="pfErr" class="t-err"></div><button class="btn" id="pfBtn" onclick="tSaveProfile()">حفظ التغييرات</button>';
    }).catch(function (e) { $('pfCard').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function tSaveProfile() {
    var btn = $('pfBtn');
    btn.disabled = true;
    api('/api/t/profile', {
      method: 'POST',
      body: JSON.stringify({
        name: $('pfName').value.trim(), phone: $('pfPhone').value.trim(), bio: $('pfBio').value.trim(),
        socialLinks: { whatsapp: $('pfWa').value.trim(), facebook: $('pfFb').value.trim(), tiktok: $('pfTk').value.trim(), youtube: $('pfYt').value.trim() }
      })
    }).then(function () { toast('تم حفظ الملف الشخصي'); btn.disabled = false; })
      .catch(function (e) { $('pfErr').textContent = e.message; btn.disabled = false; });
  }

  /* ============ كلمة المرور ============ */
  function renderSettings() {
    var main = $('tMain');
    main.innerHTML = '<div class="t-page-header"><h2>تغيير كلمة المرور</h2></div><div class="card" style="max-width:520px"><div class="field"><label>كلمة المرور الحالية</label><input type="password" id="pwCur" autocomplete="current-password"></div><div class="field"><label>كلمة المرور الجديدة (8 أحرف على الأقل)</label><input type="password" id="pwNew" autocomplete="new-password"></div><div class="field"><label>تأكيد كلمة المرور الجديدة</label><input type="password" id="pwNew2" autocomplete="new-password"></div><div id="pwErr" class="t-err"></div><button class="btn" id="pwBtn" onclick="tChangePassword()">تغيير كلمة المرور</button></div>';
  }
  function tChangePassword() {
    var cur = $('pwCur').value, next = $('pwNew').value, next2 = $('pwNew2').value, err = $('pwErr');
    err.textContent = '';
    if (next !== next2) { err.textContent = 'كلمتا المرور الجديدتان غير متطابقتين.'; return; }
    if (next.length < 8) { err.textContent = 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.'; return; }
    var btn = $('pwBtn');
    btn.disabled = true;
    api('/api/t/password', { method: 'POST', body: JSON.stringify({ current: cur, next: next }) })
      .then(function () { toast('تم تغيير كلمة المرور'); $('pwCur').value = ''; $('pwNew').value = ''; $('pwNew2').value = ''; btn.disabled = false; })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; });
  }

  window.tDoLogin = tDoLogin;
  window.tLogout = tLogout;
  window.tSetTab = tSetTab;
  window.tSearchStudents = tSearchStudents;
  window.tSearchResults = tSearchResults;
  window.tSaveProfile = tSaveProfile;
  window.tChangePassword = tChangePassword;
  window.tCopyLink = tCopyLink;

  /* boot: جرّب الجلسة أولًا ثم عرض شاشة الدخول إذا لزم */
  api('/api/settings').then(function (s) { T.settings = s; }).catch(function () {});
  api('/api/t/session').then(enterDashboard).catch(function () { renderLogin(); });
})();
