/* لوحة تحكم منصة الامتحانات — تسجيل دخول بالبريد وكلمة المرور، إدارة المعلمين،
 * استعراض المنهج والبنك (بمفاتيح الإجابة للمسؤول فقط)، والنتائج. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var LETTERS = ['أ', 'ب', 'ج', 'د'];
  var A = { tab: 'overview', data: {}, bankPage: 1, bankFilters: { subject: '', term: '', lesson: '', q: '' } };

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
        if (r.status === 401) { A.session = null; renderLogin(); throw new Error(data.error || 'انتهت الجلسة.'); }
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

  /* ================= login / setup ================= */
  function renderLogin(setupMode) {
    $('adminEmail').style.display = 'none';
    $('logoutBtn').style.display = 'none';
    app.innerHTML =
      '<div class="card" style="max-width:400px;margin:40px auto">' +
      '<h3 style="text-align:center;margin-bottom:18px">' + (setupMode ? 'إنشاء حساب المسؤول (إعداد أولي)' : 'تسجيل الدخول') + '</h3>' +
      (setupMode ? '<p class="desc" style="font-size:.8rem;margin-bottom:14px">لم يُنشأ حساب مسؤول بعد. أنشئ الحساب الآن — تُخزَّن كلمة المرور مشفّرة (PBKDF2) على الخادم ولن تظهر لأي مستخدم.</p>' : '') +
      '<div class="field"><label>البريد الإلكتروني</label><input type="email" id="admEmail" autocomplete="username"></div>' +
      '<div class="field"><label>كلمة المرور</label><input type="password" id="admPass" autocomplete="current-password"></div>' +
      (setupMode ? '<div class="field"><label>تأكيد كلمة المرور</label><input type="password" id="admPass2"></div>' : '') +
      '<div id="loginErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:8px"></div>' +
      '<button class="btn block" onclick="doLogin(' + !!setupMode + ')">' + (setupMode ? 'إنشاء الحساب' : 'دخول') + '</button>' +
      '</div>';
  }

  function doLogin(isSetup) {
    var email = $('admEmail').value.trim();
    var pass = $('admPass').value;
    var err = $('loginErr');
    err.textContent = '';
    if (isSetup && pass !== $('admPass2').value) { err.textContent = 'كلمتا المرور غير متطابقتين.'; return; }
    api(isSetup ? '/api/admin/setup' : '/api/admin/login', {
      method: 'POST', body: JSON.stringify({ email: email, password: pass })
    }).then(function () {
      if (isSetup) { toast('تم إنشاء الحساب — سجّل الدخول الآن.'); renderLogin(false); }
      else enter();
    }).catch(function (e) { err.textContent = e.message; });
  }

  function enter() {
    return api('/api/admin/session').then(function (d) {
      A.session = d.email;
      $('adminEmail').style.display = '';
      $('adminEmail').textContent = d.email;
      $('logoutBtn').style.display = '';
      renderTabs();
    });
  }

  function logout() {
    api('/api/admin/logout', { method: 'POST' }).then(function () { location.reload(); });
  }

  /* ================= shell ================= */
  var TABS = [
    ['overview', 'نظرة عامة'], ['teachers', 'المعلمون'], ['psychology', 'علم النفس'],
    ['philosophy', 'الفلسفة والمنطق'], ['bank', 'بنك الأسئلة'], ['exams', 'الامتحانات'],
    ['results', 'النتائج'], ['settings', 'الإعدادات']
  ];
  function renderTabs() {
    app.innerHTML =
      '<div class="tabs">' + TABS.map(function (t) {
        return '<button class="tab' + (A.tab === t[0] ? ' active' : '') + '" onclick="setTab(\'' + t[0] + '\')">' + t[1] + '</button>';
      }).join('') + '</div><div id="tabBody"><div class="empty"><div class="spin"></div></div></div>';
    renderTab();
  }
  function setTab(t) { A.tab = t; renderTabs(); }

  function renderTab() {
    var body = $('tabBody');
    if (A.tab === 'overview') renderOverview(body);
    else if (A.tab === 'teachers') renderTeachers(body);
    else if (A.tab === 'psychology' || A.tab === 'philosophy') renderSubjectTree(body, A.tab);
    else if (A.tab === 'bank') renderBank(body);
    else if (A.tab === 'exams') renderExams(body);
    else if (A.tab === 'results') renderResults(body);
    else if (A.tab === 'settings') renderSettings(body);
  }

  /* ================= settings ================= */
  function renderSettings(body) {
    Promise.all([api('/api/admin/overview'), api('/api/admin/session')]).then(function (r) {
      var d = r[0], me = r[1];
      body.innerHTML =
        '<div class="grid two">' +
        '<div class="card" style="margin-top:0">' +
        '<h3 style="font-size:.98rem">معلومات المنصة</h3>' +
        '<div class="kv" style="margin-top:12px">' +
        kv('حساب المسؤول', me.email) +
        kv('عدد الامتحانات', d.exams + ' امتحانًا') +
        kv('عدد الأسئلة', d.questions + ' سؤالًا فريدًا') +
        kv('عدد المعلمين', d.teachersCount) +
        '</div>' +
        '<p class="desc" style="margin-top:12px;font-size:.76rem">المنصة تعمل على Cloudflare Workers (الخطة المجانية) — بنك الأسئلة مضمن في الـWorker والمفاتيح على الخادم فقط.</p>' +
        '</div>' +
        '<div class="card" style="margin-top:0">' +
        '<h3 style="font-size:.98rem">تغيير كلمة مرور المسؤول</h3>' +
        '<p class="desc" style="font-size:.78rem;margin-top:4px">كلمة المرور تُخزَّن مشفّرة (PBKDF2-120k) ولا يمكن استعادتها — فقط تغييرها من هنا.</p>' +
        '<div class="field" style="margin-top:12px"><label>كلمة المرور الحالية</label><input type="password" id="pwCur" autocomplete="current-password"></div>' +
        '<div class="field"><label>كلمة المرور الجديدة (8 أحرف على الأقل)</label><input type="password" id="pwNew" autocomplete="new-password"></div>' +
        '<div class="field"><label>تأكيد كلمة المرور الجديدة</label><input type="password" id="pwNew2" autocomplete="new-password"></div>' +
        '<div id="pwErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:8px"></div>' +
        '<button class="btn block" id="pwBtn" onclick="changePassword()">تغيير كلمة المرور</button>' +
        '</div></div>';
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function changePassword() {
    var cur = $('pwCur').value, next = $('pwNew').value, next2 = $('pwNew2').value;
    var err = $('pwErr');
    err.textContent = '';
    if (next !== next2) { err.textContent = 'كلمتا المرور الجديدتان غير متطابقتين.'; return; }
    if (next.length < 8) { err.textContent = 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.'; return; }
    $('pwBtn').disabled = true;
    api('/api/admin/password', { method: 'POST', body: JSON.stringify({ current: cur, next: next }) })
      .then(function () {
        toast('تم تغيير كلمة المرور بنجاح');
        $('pwCur').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
        $('pwBtn').disabled = false;
      })
      .catch(function (e) { err.textContent = e.message; $('pwBtn').disabled = false; });
  }

  /* ================= overview ================= */
  function renderOverview(body) {
    api('/api/admin/overview').then(function (d) {
      var a = d.audit, st = d.structure;
      body.innerHTML =
        '<div class="stat-grid">' +
        stat(d.exams, 'امتحانًا') + stat(d.questions, 'سؤالًا (فريد)') +
        stat(d.teachersCount, 'معلمًا') + stat(d.recentResultsCount, 'نتيجة أخيرة') +
        '</div>' +
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
        (a.philosophyTerm2Logic ? kv('منطق ت2', a.philosophyTerm2Logic.questions + ' سؤالًا — ' + a.philosophyTerm2Logic.verified + ' موثق + ' + a.philosophyTerm2Logic.authored + ' مؤلَّف · ' + a.philosophyTerm2Logic.excluded + ' معزول (موثق الأسباب)') : '') +
        kv('مستبعد', (a.philosophyTerm1.excluded || 0) + ' (ت1) + ' + (a.philosophyTerm2.excluded || 0) + ' (فلسفة ت2) + ' + ((a.philosophyTerm2Logic && a.philosophyTerm2Logic.excluded) || 0) + ' (منطق ت2) سؤالًا معزولًا') +
        '</div>' +
        '<div class="desc" style="margin-top:12px;font-size:.78rem">' + esc(d.notes.curriculumAlignment) + '</div></div>' +
        '<div class="section-title"><h3>تصحيحات مفاتيح علم النفس (توثيق)</h3></div>' +
        '<div class="card">' + (a.psychology.corrections || []).map(function (c) {
          return '<div style="padding:8px 0;border-bottom:1px solid var(--line);font-size:.8rem">' +
            '<b>' + esc(c.exam) + ' — س' + c.q + ':</b> ' + c.from + ' ← ' + c.to +
            '<div class="desc" style="font-size:.74rem;margin-top:3px">' + esc(c.reason) + '</div></div>';
        }).join('') + '</div>' +
        '<div class="section-title"><h3>المعلمون</h3></div>' +
        '<div class="card"><table class="tbl"><tr><th>الاسم</th><th>الرابط</th><th>الحالة</th></tr>' +
        d.teachers.map(function (t) {
          return '<tr><td>' + esc(t.name) + '</td><td><code>/' + esc(t.slug) + '</code></td><td>' +
            (t.enabled ? '<span class="badge green">مفعّل</span>' : '<span class="badge">معطّل</span>') + '</td></tr>';
        }).join('') + '</table></div>';
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function stat(v, l) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + esc(l) + '</div></div>'; }
  function kv(k, v) { return '<div class="k">' + esc(k) + '</div><div>' + esc(v) + '</div>'; }

  /* ================= teachers ================= */
  function renderTeachers(body) {
    api('/api/admin/teachers').then(function (d) {
      body.innerHTML =
        '<button class="btn small" onclick="editTeacher(null)">+ إضافة معلم</button>' +
        '<div class="grid">' + d.teachers.map(function (t) {
          return '<div class="card teacher-card" style="margin-top:12px">' +
            '<div class="avatar">' + (t.photo ? '<img src="' + esc(t.photo) + '">' : esc(t.name.slice(0, 2))) + '</div>' +
            '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b>' + esc(t.name) + '</b>' +
            (t.isDefault ? '<span class="badge gold">افتراضي</span>' : '') +
            (t.enabled ? '<span class="badge green">مفعّل</span>' : '<span class="badge">معطّل</span>') + '</div>' +
            (t.specialty ? '<div class="desc" style="font-size:.76rem;margin-top:3px;color:var(--gold-deep);font-weight:700">' + esc(t.specialty) + '</div>' : '') +
            '<div class="desc" style="font-size:.78rem;margin-top:4px">' + esc(t.bio || '') + '</div>' +
            '<div style="margin-top:8px;font-size:.78rem">الرابط العام: <a href="/' + esc(t.slug) + '" target="_blank">' + esc(location.host + '/' + t.slug) + '</a></div>' +
            '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
            '<button class="btn small ghost" onclick="copyLink(\'' + esc(t.slug) + '\')">نسخ الرابط</button>' +
            '<button class="btn small" onclick="editTeacher(\'' + esc(t.id) + '\')">تعديل</button>' +
            (t.isDefault ? '' : '<button class="btn small danger" onclick="deleteTeacher(\'' + esc(t.id) + '\')">حذف</button>') +
            '</div></div></div>';
        }).join('') + '</div>';
      A.teachers = d.teachers;
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function copyLink(slug) {
    var url = location.origin + '/' + slug;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('تم نسخ الرابط: ' + url); });
    else { prompt('انسخ الرابط:', url); }
  }

  function editTeacher(id) {
    var t = id ? A.teachers.filter(function (x) { return x.id === id; })[0] : null;
    var isNew = !t;
    t = t || { name: '', slug: '', phone: '', specialty: '', bio: '', photo: '', socialLinks: {}, requirePhone: true, enabled: true };
    var overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML =
      '<div class="modal">' +
      '<h3>' + (isNew ? 'إضافة معلم جديد' : 'تعديل: ' + esc(t.name)) + '</h3>' +
      '<div class="field"><label>الاسم *</label><input id="tName" value="' + esc(t.name) + '" maxlength="80"></div>' +
      '<div class="field"><label>الرابط (slug) — حروف إنجليزية وأرقام وشرطات</label><input id="tSlug" value="' + esc(t.slug) + '" placeholder="مثال: mostafa" dir="ltr"></div>' +
      '<div class="field"><label>الرابط العام</label><input class="input" dir="ltr" readonly value="' + esc(location.host + '/' + (t.slug || '…')) + '" id="tUrlPreview" style="opacity:.7"></div>' +
      '<div class="field"><label>الهاتف (خاص — لا يظهر للطلاب)</label><input id="tPhone" value="' + esc(t.phone || '') + '" dir="ltr"></div>' +
      '<div class="field"><label>التخصص (يظهر في الصفحة الرئيسية)</label><input id="tSpecialty" value="' + esc(t.specialty || '') + '" maxlength="120" placeholder="مثال: مدرس الفلسفة والمنطق — المرحلة الثانوية"></div>' +
      '<div class="field"><label>نبذة</label><textarea id="tBio" rows="2" maxlength="500">' + esc(t.bio || '') + '</textarea></div>' +
      '<div class="field"><label>روابط التواصل (تبدأ بـ https://)</label>' +
      '<input id="tWhats" placeholder="واتساب https://…" dir="ltr" value="' + esc(t.socialLinks.whatsapp || '') + '" style="margin-bottom:6px">' +
      '<input id="tFb" placeholder="فيسبوك https://…" dir="ltr" value="' + esc(t.socialLinks.facebook || '') + '" style="margin-bottom:6px">' +
      '<input id="tTt" placeholder="تيك توك https://…" dir="ltr" value="' + esc(t.socialLinks.tiktok || '') + '"></div>' +
      '<div class="field"><label>الصورة</label><input type="file" id="tPhoto" accept="image/*">' +
      '<div id="tPhotoPrev" style="margin-top:8px">' + (t.photo ? '<img src="' + esc(t.photo) + '" style="width:64px;height:64px;border-radius:12px;object-fit:cover">' : '') + '</div></div>' +
      '<div style="display:flex;gap:18px;align-items:center;margin:10px 0">' +
      '<label style="display:flex;gap:8px;align-items:center;font-size:.85rem">طلب رقم الهاتف' +
      '<span class="switch"><input type="checkbox" id="tReqPhone"' + (t.requirePhone ? ' checked' : '') + '><i></i></span></label>' +
      '<label style="display:flex;gap:8px;align-items:center;font-size:.85rem">مفعّل' +
      '<span class="switch"><input type="checkbox" id="tEnabled"' + (t.enabled ? ' checked' : '') + '><i></i></span></label></div>' +
      '<div id="tErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em"></div>' +
      '<div class="acts"><button class="btn ghost" onclick="this.closest(\'.modal-bg\').remove()">إلغاء</button>' +
      '<button class="btn" id="tSave" onclick="saveTeacher(\'' + (id || '') + '\')">حفظ</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    $('tSlug').addEventListener('input', function () { $('tUrlPreview').value = location.host + '/' + this.value; });
    $('tPhoto').addEventListener('change', function () { resizePhoto(this.files[0]); });
  }

  function resizePhoto(file) {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { toast('الصورة كبيرة جدًا (الحد 6 ميجابايت قبل الضغط)', true); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 512;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        A.pendingPhoto = c.toDataURL('image/jpeg', 0.85);
        $('tPhotoPrev').innerHTML = '<img src="' + A.pendingPhoto + '" style="width:64px;height:64px;border-radius:12px;object-fit:cover">';
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function saveTeacher(id) {
    var payload = {
      name: $('tName').value.trim(),
      slug: $('tSlug').value.trim(),
      phone: $('tPhone').value.trim(),
      specialty: $('tSpecialty').value.trim(),
      bio: $('tBio').value.trim(),
      socialLinks: { whatsapp: $('tWhats').value.trim(), facebook: $('tFb').value.trim(), tiktok: $('tTt').value.trim() },
      photo: A.pendingPhoto || undefined,
      requirePhone: $('tReqPhone').checked,
      enabled: $('tEnabled').checked
    };
    $('tSave').disabled = true;
    api(id ? '/api/admin/teachers/' + id : '/api/admin/teachers', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    }).then(function () {
      toast('تم الحفظ بنجاح');
      A.pendingPhoto = null;
      document.querySelector('.modal-bg').remove();
      renderTeachers($('tabBody'));
    }).catch(function (e) {
      $('tSave').disabled = false;
      $('tErr').textContent = e.message;
    });
  }

  function deleteTeacher(id) {
    var t = A.teachers.filter(function (x) { return x.id === id; })[0];
    if (!confirm('حذف المعلم «' + t.name + '» نهائيًا؟ لن يعمل رابطه /' + t.slug + ' بعد الحذف.')) return;
    api('/api/admin/teachers/' + id, { method: 'DELETE' }).then(function () {
      toast('تم الحذف');
      renderTeachers($('tabBody'));
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ================= subject trees ================= */
  function renderSubjectTree(body, subjectId) {
    api('/api/admin/exams').then(function (d) {
      var cat = d.catalog[subjectId];
      var exams = d.exams;
      var html = '<div class="section-title"><h3>' + esc(cat.name) + ' — ' + esc(cat.gradeName) + '</h3></div>';
      if (subjectId === 'psychology') {
        cat.units.forEach(function (u) {
          html += '<div class="card" style="margin-bottom:12px"><div style="font-weight:800;color:var(--primary-deep)">' + esc(u.title) + '</div><div class="grid" style="gap:8px;margin-top:10px">';
          u.lessons.forEach(function (l) {
            var e = exams[l.examIds[0]];
            html += treeRow('موضوع ' + l.no, l.title, e.count);
          });
          html += treeRow('شامل', 'الامتحان الشامل — ' + u.title, exams[u.comprehensiveExamId].count);
          html += '</div></div>';
        });
        html += '<div class="card" style="border-color:var(--accent)">' + treeRow('شامل عام', 'الامتحان الشامل — المنهج كاملًا', exams[cat.subjectComprehensiveExamId].count) + '</div>';
      } else {
        cat.terms.forEach(function (term) {
          html += '<div class="section-title" style="margin-top:18px"><h3>' + esc(term.label) + '</h3></div>';
          term.units.forEach(function (u) {
            html += '<div class="card" style="margin-bottom:12px"><div style="font-weight:800;color:var(--primary-deep)">' + esc(u.title) + '</div>';
            u.chapters.forEach(function (ch) {
              html += '<div style="font-weight:700;font-size:.88rem;margin:10px 0 6px">' + esc(ch.title) + '</div><div class="grid" style="gap:8px">';
              ch.lessons.forEach(function (l) {
                var e = exams[l.examIds[0]];
                html += treeRow('موضوع ' + l.no, l.title, e.count, l.examIds.length + ' نماذج');
              });
              if (u.comprehensiveExamId) html += treeRow('شامل', exams[u.comprehensiveExamId].title, exams[u.comprehensiveExamId].count);
              html += '</div>';
            });
            html += '</div>';
          });
          if (term.termComprehensiveExamId) {
            html += '<div class="card" style="border-color:var(--accent)">' + treeRow('شامل', exams[term.termComprehensiveExamId].title, exams[term.termComprehensiveExamId].count) + '</div>';
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

  /* ================= question bank ================= */
  function renderBank(body) {
    var f = A.bankFilters;
    body.innerHTML =
      '<div class="filters">' +
      '<select id="fSubject" onchange="bankFilter()"><option value="">كل المواد</option>' +
      '<option value="psychology"' + (f.subject === 'psychology' ? ' selected' : '') + '>علم النفس</option>' +
      '<option value="philosophy"' + (f.subject === 'philosophy' ? ' selected' : '') + '>الفلسفة والمنطق</option></select>' +
      '<select id="fTerm" onchange="bankFilter()"><option value="">كل الترمات</option>' +
      '<option value="1"' + (f.term === '1' ? ' selected' : '') + '>الترم الأول</option>' +
      '<option value="2"' + (f.term === '2' ? ' selected' : '') + '>الترم الثاني</option></select>' +
      '<input id="fLesson" placeholder="بحث بالدرس/الفصل…" value="' + esc(f.lesson) + '" onchange="bankFilter()">' +
      '<input id="fQ" placeholder="بحث في نص السؤال…" value="' + esc(f.q) + '" onchange="bankFilter()">' +
      '<button class="btn small" onclick="bankFilter()">بحث</button></div>' +
      '<div id="bankList"><div class="empty"><div class="spin"></div></div></div>';
    loadBank();
  }
  function bankFilter() {
    A.bankFilters = {
      subject: $('fSubject').value, term: $('fTerm').value,
      lesson: $('fLesson').value.trim(), q: $('fQ').value.trim()
    };
    A.bankPage = 1;
    loadBank();
  }
  function loadBank() {
    var f = A.bankFilters;
    var qs = '?subject=' + encodeURIComponent(f.subject) + '&term=' + encodeURIComponent(f.term) +
      '&lesson=' + encodeURIComponent(f.lesson) + '&q=' + encodeURIComponent(f.q) + '&page=' + A.bankPage;
    api('/api/admin/questions' + qs).then(function (d) {
      var el = $('bankList');
      if (!d.questions.length) { el.innerHTML = '<div class="empty">لا نتائج.</div>'; return; }
      el.innerHTML =
        '<div class="desc" style="font-size:.78rem;margin-bottom:10px">' + d.total + ' سؤالًا — صفحة ' + d.page + ' من ' + Math.ceil(d.total / d.perPage) + '</div>' +
        d.questions.map(function (q) {
          return '<div class="rq"><div class="no">' + esc(q.id) + ' · ' + esc(q.meta.subject) +
            (q.meta.term ? ' · ترم ' + q.meta.term : '') + (q.meta.difficulty ? ' · ' + esc(q.meta.difficulty) : '') +
            (q.meta.authorCreated ? ' · مؤلَّف' : ' · موثق') + '</div>' +
            '<div class="q">' + esc(q.text) + '</div>' +
            q.options.map(function (o, i) {
              var isAns = LETTERS[i] === q.answer;
              return '<div class="ans ' + (isAns ? 'correct' : '') + '"' + (isAns ? '' : ' style="opacity:.75"') + '>' +
                LETTERS[i] + ') ' + esc(o) + (isAns ? ' ✓' : '') + '</div>';
            }).join('') +
            (q.meta.lesson || q.meta.chapter ? '<div class="no" style="margin-top:6px">' + esc(q.meta.lesson || q.meta.chapter) + '</div>' : '') +
            '</div>';
        }).join('') +
        '<div style="display:flex;gap:10px;justify-content:center;margin-top:16px">' +
        (A.bankPage > 1 ? '<button class="btn small ghost" onclick="bankPage(' + (A.bankPage - 1) + ')">السابق</button>' : '') +
        (A.bankPage < Math.ceil(d.total / d.perPage) ? '<button class="btn small ghost" onclick="bankPage(' + (A.bankPage + 1) + ')">التالي</button>' : '') +
        '</div>';
    }).catch(function (e) { $('bankList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function bankPage(p) { A.bankPage = p; loadBank(); }

  /* ================= exams table ================= */
  function renderExams(body) {
    api('/api/admin/exams').then(function (d) {
      var rows = Object.values(d.exams).sort(function (a, b) {
        return (a.subjectId + a.term + a.title).localeCompare(b.subjectId + b.term + b.title, 'ar');
      });
      body.innerHTML = '<div class="card"><div style="overflow-x:auto"><table class="tbl">' +
        '<tr><th>المعرف</th><th>العنوان</th><th>المادة</th><th>الترم</th><th>النوع</th><th>الأسئلة</th></tr>' +
        rows.map(function (e) {
          return '<tr><td dir="ltr" style="font-size:.72rem">' + esc(e.id) + '</td><td>' + esc(e.title) + '</td>' +
            '<td>' + (e.subjectId === 'psychology' ? 'علم النفس' : 'الفلسفة') + '</td>' +
            '<td>' + (e.term || '—') + '</td><td>' + typeLabel(e.type) + '</td><td>' + e.count + '</td></tr>';
        }).join('') + '</table></div></div>';
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function typeLabel(t) {
    return { topic: 'موضوع', training: 'تدريب', 'unit-comprehensive': 'شامل وحدة', 'term-comprehensive': 'شامل ترم', 'subject-comprehensive': 'شامل مادة' }[t] || t;
  }

  /* ================= results ================= */
  function renderResults(body) {
    api('/api/admin/results').then(function (d) {
      if (!d.results.length) {
        body.innerHTML = '<div class="empty">لا توجد نتائج محفوظة بعد.<br>' +
          '<span style="font-size:.76rem">تُحفظ آخر ١٠٠ نتيجة هنا، وتُرسل جميع النتائج إلى Google Sheets عند ضبط الربط.</span></div>';
        return;
      }
      body.innerHTML =
        '<div style="display:flex;justify-content:flex-end;margin-bottom:10px">' +
        '<a class="btn small ghost" href="/api/admin/results.csv" download>تصدير CSV</a></div>' +
        '<div class="card"><div style="overflow-x:auto"><table class="tbl">' +
        '<tr><th>التاريخ</th><th>الطالب</th><th>الهاتف</th><th>الامتحان</th><th>المادة</th><th>الدرجة</th><th>النسبة</th></tr>' +
        d.results.map(function (r) {
          var pct = Math.round(r.percentage);
          var color = pct >= 50 ? 'var(--ok)' : 'var(--bad)';
          return '<tr><td style="font-size:.74rem">' + new Date(r.date).toLocaleString('ar-EG') + '</td>' +
            '<td>' + esc(r.name) + '</td><td dir="ltr" style="font-size:.76rem">' + esc(r.phone || '—') + '</td>' +
            '<td style="font-size:.8rem;max-width:220px">' + esc(r.examLabel) + '</td><td>' + esc(r.subject) + '</td>' +
            '<td><b>' + r.score + '/' + r.total + '</b></td><td style="color:' + color + ';font-weight:800">' + pct + '%</td></tr>';
        }).join('') + '</table></div></div>';
    }).catch(function (e) { body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  /* ================= expose ================= */
  window.doLogin = doLogin;
  window.logout = logout;
  window.setTab = setTab;
  window.changePassword = changePassword;
  window.editTeacher = editTeacher;
  window.saveTeacher = saveTeacher;
  window.deleteTeacher = deleteTeacher;
  window.copyLink = copyLink;
  window.bankFilter = bankFilter;
  window.bankPage = bankPage;

  /* boot: login → panel (detect first-run setup) */
  api('/api/admin/session').then(enter).catch(function () {
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: '', password: '' }) })
      .then(function () { renderLogin(false); })
      .catch(function (e) {
        renderLogin(String(e.message).indexOf('لم يُنشأ') !== -1);
      });
  });
})();
