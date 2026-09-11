(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var main = $('tMain');
  var T = { tab: 'home', session: null };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 || r.status === 403) { T.session = null; renderLogin(); throw new Error(data.error || 'انتهت الجلسة.'); }
        if (!r.ok) throw new Error(data.error || ('خطأ ' + r.status));
        return data;
      });
    });
  }
  function toast(msg, isErr) { var d = document.createElement('div'); d.className = 'toast' + (isErr ? ' err' : ''); d.textContent = msg; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 3500); }

  function renderLogin() {
    $('teacherName').style.display = 'none'; $('logoutBtn').style.display = 'none'; $('tSidebar').style.display = 'none';
    main.innerHTML = '<div class="t-login-wrap"><div class="card t-login-card">' +
      '<div class="t-login-header"><div class="t-login-icon">\ud83d\udc68\u200d\ud83c\udfeb</div><h2>لوحة دخول المعلم</h2><p class="desc">منصة الامتحانات التعليمية</p></div>' +
      '<div class="field"><label>البريد / اسم المستخدم</label><input type="text" id="tEmail" autocomplete="username"></div>' +
      '<div class="field"><label>كلمة المرور</label><input type="password" id="tPass" autocomplete="current-password"></div>' +
      '<div id="loginErr" class="t-err"></div>' +
      '<button class="btn block" id="loginBtn" onclick="tDoLogin()">تسجيل الدخول</button></div></div>';
  }
  function tDoLogin() {
    var email = $('tEmail').value.trim(), pass = $('tPass').value, err = $('loginErr');
    err.textContent = '';
    if (!email || !pass) { err.textContent = 'الحقول مطلوبة.'; return; }
    $('loginBtn').disabled = true;
    api('/api/t/login', { method: 'POST', body: JSON.stringify({ email: email, password: pass }) })
      .then(function (d) { T.session = d; toast('مرحبًا، ' + d.name); enterDashboard(); })
      .catch(function (e) { err.textContent = e.message; $('loginBtn').disabled = false; });
  }
  function tLogout() { api('/api/t/logout', { method: 'POST' }).then(function () { location.reload(); }); }
  function enterDashboard() {
    return api('/api/t/session').then(function (d) {
      T.session = d; $('teacherName').style.display = ''; $('teacherName').textContent = d.name;
      $('logoutBtn').style.display = ''; $('tSidebar').style.display = ''; renderTab();
    });
  }
  function tSetTab(t) { T.tab = t; document.querySelectorAll('.t-nav-item').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-tab') === t); }); renderTab(); }
  function renderTab() {
    if (T.tab === 'home') renderHome();
    else if (T.tab === 'students') renderStudents();
    else if (T.tab === 'results') renderResults();
    else if (T.tab === 'profile') renderProfile();
    else if (T.tab === 'settings') renderSettings();
  }
  function renderHome() {
    main.innerHTML = '<div class="t-loading"><div class="spin"></div></div>';
    api('/api/t/dashboard').then(function (d) {
      var t = d.totals;
      main.innerHTML = '<div class="t-welcome"><h2>مرحبًا، ' + esc(d.teacher.name) + '</h2></div>' +
        '<div class="t-stat-grid">' +
        stat('👥', 'الطلاب', t.registeredStudents || t.students) + stat('📝', 'الامتحانات', t.results) +
        stat('📊', 'متوسط الدرجات', t.avgPercentage + '%') + stat('✅', 'نسبة النجاح', t.passRate + '%') +
        '</div><div class="t-grid-2">' +
        '<div class="card"><h3 class="t-card-title">آخر النشاط</h3>' +
        (d.recent.length ? d.recent.slice(0, 8).map(function (r) {
          var pct = Math.round(r.percentage); return '<div class="t-recent-item"><span class="t-r-name">' + esc(r.name) + '</span><span class="t-r-exam">' + esc(r.examLabel) + '</span><span class="t-r-score ' + (pct >= 50 ? 't-pass' : 't-fail') + '">' + pct + '%</span></div>';
        }).join('') : '<div class="empty">لا توجد نتائج</div>') + '</div>' +
        '<div class="card"><h3 class="t-card-title">أكثر الامتحانات</h3>' +
        (d.perExam.length ? d.perExam.slice(0, 8).map(function (e) {
          return '<div class="t-exam-item"><span class="t-e-title">' + esc(e.title) + '</span><span class="t-e-badge">' + e.attempts + ' محاولة</span></div>';
        }).join('') : '<div class="empty">لا توجد بيانات</div>') + '</div></div>';
    }).catch(function (e) { main.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function stat(icon, label, value) { return '<div class="t-stat-card"><div class="t-stat-icon">' + icon + '</div><div class="t-stat-body"><div class="t-stat-val">' + esc(String(value)) + '</div><div class="t-stat-label">' + esc(label) + '</div></div></div>'; }
  function renderStudents() {
    main.innerHTML = '<div class="t-page-header"><h2>الطلاب</h2></div><div class="t-search-bar"><input type="text" id="stuSearch" placeholder="بحث…" oninput="tSearchStudents()"></div><div id="stuList"><div class="t-loading"><div class="spin"></div></div></div>';
    loadStudents();
  }
  function loadStudents(q) {
    api('/api/t/students' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (d) {
      var el = $('stuList');
      if (!d.students.length) { el.innerHTML = '<div class="empty">لا يوجد طلاب</div>'; return; }
      el.innerHTML = '<div class="t-count">' + d.total + ' طالب</div>' + d.students.map(function (s) {
        return '<div class="t-stu-card"><div class="t-stu-avatar">' + esc(s.name.charAt(0)) + '</div><div class="t-stu-info"><div class="t-stu-name">' + esc(s.name) + '</div><div class="t-stu-meta">' + (s.phone ? esc(s.phone) : '') + ' · ' + s.examCount + ' امتحان</div></div><div class="t-stu-stats"><div class="t-stu-pct ' + (s.avgPercentage >= 50 ? 't-pass' : 't-fail') + '">' + s.avgPercentage + '%</div></div></div>';
      }).join('');
    }).catch(function (e) { $('stuList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  var stuTimer; function tSearchStudents() { clearTimeout(stuTimer); stuTimer = setTimeout(function () { loadStudents($('stuSearch').value.trim()); }, 300); }
  function renderResults() {
    main.innerHTML = '<div class="t-page-header"><h2>النتائج</h2></div><div class="t-filters"><input type="text" id="resSearch" placeholder="بحث…" oninput="tSearchResults()"><select id="resSubject" onchange="tSearchResults()"><option value="">كل المواد</option><option value="علم النفس">علم النفس</option><option value="الفلسفة والمنطق">الفلسفة والمنطق</option></select></div><div id="resList"><div class="t-loading"><div class="spin"></div></div></div>';
    loadResults();
  }
  function loadResults(page, q, subject) {
    page = page || 1; q = q || ''; subject = subject || '';
    var url = '/api/t/results?page=' + page;
    if (q) url += '&q=' + encodeURIComponent(q); if (subject) url += '&subject=' + encodeURIComponent(subject);
    api(url).then(function (d) {
      var el = $('resList');
      if (!d.results.length) { el.innerHTML = '<div class="empty">لا توجد نتائج</div>'; return; }
      el.innerHTML = d.results.map(function (r) {
        var pct = Math.round(r.percentage); var cls = pct >= 50 ? 't-pass' : 't-fail';
        return '<div class="t-result-card"><div class="t-res-head"><span class="t-res-name">' + esc(r.name) + '</span><span class="t-res-date">' + new Date(r.date).toLocaleDateString('ar-EG') + '</span></div><div class="t-res-body"><span class="t-res-exam">' + esc(r.examLabel) + '</span><span class="t-res-subj">' + esc(r.subject) + '</span></div><div class="t-res-score"><span class="' + cls + '">' + r.score + '/' + r.total + '</span><span class="t-res-pct ' + cls + '">' + pct + '%</span></div></div>';
      }).join('');
    }).catch(function (e) { $('resList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  var resTimer; function tSearchResults() { clearTimeout(resTimer); resTimer = setTimeout(function () { loadResults(1, $('resSearch').value.trim(), $('resSubject').value); }, 300); }
  function renderProfile() {
    main.innerHTML = '<div class="t-page-header"><h2>الملف الشخصي</h2></div><div class="card"><h3 class="t-card-title">تعديل الملف</h3><div class="field"><label>الاسم</label><input type="text" id="pfName"></div><div class="field"><label>نبذة</label><textarea id="pfBio" rows="3"></textarea></div><div class="field"><label>واتساب</label><input type="url" id="pfWa" dir="ltr"></div><div class="field"><label>فيسبوك</label><input type="url" id="pfFb" dir="ltr"></div><div class="field"><label>تيك توك</label><input type="url" id="pfTk" dir="ltr"></div><div id="pfErr" class="t-err"></div><button class="btn" id="pfBtn" onclick="tSaveProfile()">حفظ</button></div>';
    api('/api/t/dashboard').then(function (d) { $('pfName').value = d.teacher.name; });
  }
  function tSaveProfile() {
    $('pfBtn').disabled = true;
    api('/api/t/profile', { method: 'POST', body: JSON.stringify({ name: $('pfName').value.trim(), bio: $('pfBio').value.trim(), socialLinks: { whatsapp: $('pfWa').value.trim(), facebook: $('pfFb').value.trim(), tiktok: $('pfTk').value.trim() } }) })
      .then(function () { toast('تم الحفظ'); $('pfBtn').disabled = false; })
      .catch(function (e) { $('pfErr').textContent = e.message; $('pfBtn').disabled = false; });
  }
  function renderSettings() {
    main.innerHTML = '<div class="t-page-header"><h2>الإعدادات</h2></div><div class="card"><h3 class="t-card-title">تغيير كلمة المرور</h3><div class="field"><label>الحالية</label><input type="password" id="pwCur"></div><div class="field"><label>الجديدة (8 أحرف+)</label><input type="password" id="pwNew"></div><div class="field"><label>تأكيد الجديدة</label><input type="password" id="pwNew2"></div><div id="pwErr" class="t-err"></div><button class="btn" id="pwBtn" onclick="tChangePassword()">تغيير</button></div>';
  }
  function tChangePassword() {
    var cur = $('pwCur').value, next = $('pwNew').value, next2 = $('pwNew2').value, err = $('pwErr');
    err.textContent = '';
    if (next !== next2) { err.textContent = 'غير متطابقتين.'; return; }
    if (next.length < 8) { err.textContent = '8 أحرف على الأقل.'; return; }
    $('pwBtn').disabled = true;
    api('/api/t/password', { method: 'POST', body: JSON.stringify({ current: cur, next: next }) })
      .then(function () { toast('تم التغيير'); $('pwCur').value = ''; $('pwNew').value = ''; $('pwNew2').value = ''; $('pwBtn').disabled = false; })
      .catch(function (e) { err.textContent = e.message; $('pwBtn').disabled = false; });
  }
  window.tDoLogin = tDoLogin; window.tLogout = tLogout; window.tSetTab = tSetTab; window.tSearchStudents = tSearchStudents; window.tSearchResults = tSearchResults; window.tSaveProfile = tSaveProfile; window.tChangePassword = tChangePassword;
  api('/api/t/session').then(enterDashboard).catch(function () { renderLogin(); });
})();