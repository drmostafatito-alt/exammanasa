/* منصة الامتحانات — د. مصطفى تيتو — تطبيق الطالب (SPA خفيف بدون أي أطر)
 * وضع فاتح احترافي فقط — لا مفاتيح إجابة في هذا الملف: التصحيح يتم على
 * الخادم فقط، وترتيب الخيارات يُخلط على الخادم لكل جلسة. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var LETTERS = ['أ', 'ب', 'ج', 'د'];

  /* ---------------- الحالة ---------------- */
  var S = {
    slug: '', teacher: null, catalog: null, exams: null,
    view: 'home', // home | subject | exam | quiz | result
    sub: null, term: 1,
    examId: null, session: null,
    answers: [], current: 0, reviewMode: false,
    result: null, resultFilter: 'all'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var CAP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 1 8l11 5 9-4.09V15h2V8L12 3zm-7 9.18V16c0 1.66 3.13 3 7 3s7-1.34 7-3v-3.82l-7 3.18-7-3.18z"/></svg>';
  var WARN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="16.6" r=".5" fill="currentColor"/><path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/></svg>';

  /* ---------------- البيانات ---------------- */
  function teacherSlugFromPath() {
    var p = location.pathname.replace(/^\/+|\/+$/g, '');
    if (!p || p === 'index.html' || p === 'admin' || p === 'admin.html') return '';
    return /^[a-z0-9][a-z0-9-]{0,29}$/i.test(p) ? p.toLowerCase() : '';
  }

  function api(path, opts) {
    return fetch(path, opts ? Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts) : undefined)
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) { var e = new Error(data.error || ('خطأ ' + r.status)); e.data = data; throw e; }
          return data;
        });
      });
  }

  function loadAll() {
    S.slug = teacherSlugFromPath();
    var jobs = [api('/api/catalog')];
    if (S.slug) jobs.push(api('/api/teacher/' + S.slug).then(function (d) { return d.teacher; }).catch(function () { return null; }));
    return Promise.all(jobs).then(function (res) {
      S.catalog = res[0].catalog;
      S.exams = res[0].exams;
      // في الصفحة الرئيسية نعرض مالك المنصة (المعلم الافتراضي) من بيانات فعلية
      S.teacher = S.slug ? (res[1] || null) : (res[0].owner || null);
      renderBrand();
      route();
    }).catch(function (e) {
      app.innerHTML = '<div class="card" style="text-align:center;padding:44px;margin-top:20px">' +
        '<h3>تعذر تحميل المنصة</h3><p class="desc" style="margin-top:8px">' + esc(e.message) + '</p>' +
        '<div style="margin-top:18px"><button class="btn" onclick="location.reload()">إعادة المحاولة</button></div></div>';
    });
  }

  function renderBrand() {
    var t = S.teacher;
    var year = S.catalog && S.catalog.philosophy ? S.catalog.philosophy.academicYear : '';
    document.title = t ? (t.name + ' — منصة الامتحانات') : 'منصة الامتحانات — د. مصطفى تيتو';
    $('brandName').textContent = t ? t.name : 'منصة الامتحانات';
    $('brandSub').textContent = t ? (t.specialty || 'اختبارات المنهج الرسمي') : 'الفلسفة والمنطق · علم النفس';
    $('yearChip').textContent = (year || '').replace('العام الدراسي ', '');
    if (year && !$('yearChip').textContent.trim()) $('yearChip').textContent = year;
    var logo = $('brandLogo');
    if (t && t.photo) logo.innerHTML = '<img src="' + esc(t.photo) + '" alt="">';
    else logo.textContent = monogramOf(t ? t.name : 'م ت');
    if (t && t.colors && /^#[0-9a-fA-F]{6}$/.test(t.colors.primary || '')) {
      document.documentElement.style.setProperty('--primary', t.colors.primary);
    }
  }

  function monogramOf(name) {
    var clean = String(name || '').replace(/^(د\.|أ\.|م\.|الدكتور|الأستاذ|استاذ)\s*/g, '').trim();
    var parts = clean.split(/\s+/).filter(Boolean);
    return (parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)) || 'م‌ت';
  }

  /* ---------------- التوجيه ---------------- */
  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (!parts.length) { S.view = 'home'; renderHome(); return; }
    if (parts[0] === 's' && parts[1]) { S.view = 'subject'; S.sub = parts[1]; S.term = parts[2] ? parseInt(parts[2], 10) || 1 : 1; renderSubject(); return; }
    if (parts[0] === 'e' && parts[1]) { S.view = 'exam'; S.examId = parts[1]; renderExamInfo(); return; }
    S.view = 'home'; renderHome(); return;
  }
  window.addEventListener('hashchange', function () {
    if (S.view === 'quiz' && location.hash !== '#/quiz') {
      if (!confirm('سيتم الخروج من الامتحان. هل أنت متأكد؟ (لن تُسلَّم إجاباتك)')) {
        location.hash = '#/quiz'; return;
      }
    }
    route();
  });

  function go(hash) { location.hash = hash; }

  /* ---------------- الرئيسية: قسم المعلم + المواد ---------------- */
  function socialRow(t) {
    if (!t || !t.socialLinks) return '';
    var links = [];
    var defs = [
      ['whatsapp', 'واتساب', 'M12 2a10 10 0 00-8.6 15L2 22l5.2-1.4A10 10 0 1012 2zm5 13.6c-.2.6-1.2 1.2-1.7 1.2-.4 0-1 .1-3.3-1s-3.8-3.6-4-3.9c-.1-.3-.8-1.2-.8-2.3s.6-1.6.8-1.8c.2-.2.4-.3.6-.3h.5c.2 0 .4 0 .6.4l.8 1.9c.1.2.1.4 0 .6l-.4.5c-.1.2-.3.3-.1.6.2.3.7 1.1 1.4 1.8 1 .9 1.8 1.2 2.1 1.3.2.1.4.1.6-.1l.8-.9c.2-.2.4-.2.6-.1l1.8.9c.2.1.4.2.4.3.1.2.1.8-.1 1.4z'],
      ['facebook', 'فيسبوك', 'M13 22v-8h3l.5-4H13V8c0-1.1.3-1.9 2-1.9h1.6V2.6C16.3 2.5 15.1 2.4 13.8 2.4 10.9 2.4 9 4.1 9 7.5V10H6v4h3v8h4z'],
      ['tiktok', 'تيك توك', 'M16.6 5.8c.9 1 2.1 1.6 3.4 1.7v-3a4.9 4.9 0 01-3.4-2.1 5 5 0 01-.9-2.4h-3v13.6a2.8 2.8 0 11-2.8-2.8c.3 0 .6 0 .9.1V8.8a6 6 0 00-.9-.1 5.9 5.9 0 105.9 5.9V9.7c1.1.9 2.4 1.4 3.8 1.5V8.2c-.5 0-1-.1-1.4-.2-.8-.3-1.5-.7-2-1.3l-.6-.9z']
    ];
    defs.forEach(function (d) {
      var url = (t.socialLinks[d[0]] || '').trim();
      if (/^https?:\/\//i.test(url)) {
        links.push('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
          '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + d[2] + '"/></svg>' + d[1] + '</a>');
      }
    });
    return links.length ? '<div class="social-row">' + links.join('') + '</div>' : '';
  }

  function renderHome() {
    var cat = S.catalog;
    var t = S.teacher;
    var year = cat.philosophy.academicYear;
    var photo = (t && t.photo)
      ? '<img src="' + esc(t.photo) + '" alt="صورة ' + esc(t.name) + '">'
      : '<div class="monogram">' + esc(monogramOf(t ? t.name : 'م ت')) + '</div>';
    var waUrl = t && t.socialLinks && /^https?:\/\//i.test((t.socialLinks.whatsapp || '').trim()) ? t.socialLinks.whatsapp.trim() : '';

    var html =
      '<section class="hero">' +
      '<div class="hero-body">' +
      '<div class="hero-head">' +
      '<span class="kicker">' + CAP_SVG.replace('<svg', '<svg style="width:14px;height:14px"') + ' منصة الامتحانات الإلكترونية</span>' +
      '<h2>' + (t ? esc(t.name) : 'منصة الامتحانات التعليمية') + '</h2>' +
      (t && t.specialty ? '<div class="specialty">' + esc(t.specialty) + '</div>' : '') +
      '</div>' +
      (t && t.bio ? '<p class="bio">' + esc(t.bio) + '</p>' : '') +
      '<div class="hero-chips">' +
      '<span class="chip">' + esc(year) + '</span>' +
      '<span class="chip">اختبارات وفق <em>المنهج الرسمي</em></span>' +
      '<span class="chip">تصحيح فوري ومراجعة الإجابات</span>' +
      '</div>' +
      '<div class="hero-ctas">' +
      '<button class="btn" onclick="scrollToSubjects()">ابدأ الامتحان الآن</button>' +
      (waUrl ? '<a class="btn wa" href="' + esc(waUrl) + '" target="_blank" rel="noopener noreferrer">تواصل عبر واتساب</a>' : '') +
      '</div>' +
      socialRow(t) +
      '<div class="hero-foot">الفلسفة والمنطق — الصف الأول الثانوي · علم النفس — الصف الثاني الثانوي</div>' +
      '</div>' +
      '<div class="hero-media"><div class="photo">' + photo + '</div>' +
      '<div class="photo-badge">' + CAP_SVG + '</div></div>' +
      '</section>' +

      '<div class="section-title" id="subjects" style="scroll-margin-top:80px"><h3>اختر المادة</h3></div>' +
      '<div class="grid two">';
    html += subjectCard('psychology', cat.psychology, '🧠', 'psychology');
    html += subjectCard('philosophy', cat.philosophy, '📚', 'philosophy');
    html += '</div>';
    app.innerHTML = html;
  }

  function scrollToSubjects() {
    var el = $('subjects');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function subjectStats(subjectId, sub) {
    // أرقام فعلية محسوبة من بيانات المنصة — لا أرقام ثابتة
    if (subjectId === 'psychology') {
      var topics = sub.units.reduce(function (n, u) { return n + u.lessons.length; }, 0);
      return sub.units.length + ' وحدات · ' + topics + ' موضوعات';
    }
    var units = sub.terms.reduce(function (n, t) { return n + t.units.length; }, 0);
    return 'ترمان دراسيان · ' + units + ' وحدات';
  }

  function subjectCard(id, sub, ico, icoCls) {
    return '<div class="card clickable" onclick="go(\'#/s/' + id + '\')" role="button" tabindex="0">' +
      '<div class="subject-ico ' + icoCls + '">' + ico + '</div>' +
      '<h3>' + esc(sub.name) + '</h3>' +
      '<div class="desc">' + esc(sub.gradeName) + ' — ' + subjectStats(id, sub) + '</div>' +
      '<div class="meta-row">' +
      '<span class="badge green">' + countExams(id) + ' امتحانًا إلكترونيًا</span>' +
      '<span class="badge">اختيار من متعدد</span>' +
      '</div>' +
      '<div class="cta-row"><span class="cta-hint">اضغط للدخول إلى المواد والامتحانات</span>' +
      '<span class="btn small">ابدأ</span></div>' +
      '</div>';
  }

  function countExams(subjectId) {
    return Object.keys(S.exams).filter(function (id) { return S.exams[id].subjectId === subjectId; }).length;
  }

  /* ---------------- صفحة المادة ---------------- */
  function crumb(parts) {
    var html = '<div class="crumb">';
    parts.forEach(function (p, i) {
      if (i) html += '<span class="sep">‹</span>';
      html += p[1] ? '<button onclick="' + p[1] + '">' + esc(p[0]) + '</button>' : '<span>' + esc(p[0]) + '</span>';
    });
    return html + '</div>';
  }

  function difficultyBadge(e) {
    if (!e.difficulty) return '';
    var d = e.difficulty;
    if (d.hard >= d.easy && d.hard >= d.medium) return '<span class="badge red">مستوى متقدم</span>';
    if (d.easy >= d.medium) return '<span class="badge green">مستوى سهل</span>';
    return '<span class="badge gold">مستوى متوسط</span>';
  }

  function renderSubject() {
    var cat = S.catalog;
    if (S.sub === 'psychology') {
      var sub = cat.psychology;
      var html = crumb([['الرئيسية', "go('#/')"], [sub.name]]);
      html += '<div class="section-title"><h3>' + esc(sub.name) + ' — ' + esc(sub.gradeName) + '</h3><span class="count">' + countExams('psychology') + ' امتحانًا</span></div>';
      sub.units.forEach(function (u) {
        html += '<div class="section-title" style="margin-top:26px"><h3>' + esc(u.title) + '</h3><span class="count">' + u.lessons.length + ' موضوعات</span></div>';
        html += '<div class="exam-list">';
        u.lessons.forEach(function (l) {
          html += examCard(l.examIds[0], 'موضوع', l.no, l.title, null);
        });
        var ce = S.exams[u.comprehensiveExamId];
        html += examCard(u.comprehensiveExamId, 'شامل', '★', ce.title, null);
        html += '</div>';
      });
      var full = S.exams[sub.subjectComprehensiveExamId];
      html += '<div class="section-title" style="margin-top:26px"><h3>الامتحان الشامل للمنهج</h3></div><div class="exam-list">' +
        examCard(sub.subjectComprehensiveExamId, 'شامل', '★', full.title, 'المنهج كاملًا — ' + sub.units.length + ' وحدات') + '</div>';
      app.innerHTML = html;
    } else if (S.sub === 'philosophy') {
      var sub2 = cat.philosophy;
      var html2 = crumb([['الرئيسية', "go('#/')"], [sub2.name]]);
      html2 += '<div class="section-title"><h3>' + esc(sub2.name) + ' — ' + esc(sub2.gradeName) + '</h3></div>';
      html2 += '<div class="filters" style="justify-content:center">' +
        '<button class="tab ' + (S.term === 1 ? 'active' : '') + '" onclick="S.term=1;renderSubject()">الترم الأول</button>' +
        '<button class="tab ' + (S.term === 2 ? 'active' : '') + '" onclick="S.term=2;renderSubject()">الترم الثاني</button></div>';
      var term = sub2.terms.filter(function (t) { return t.term === S.term; })[0];
      if (!term) { app.innerHTML = html2 + '<div class="empty">لا توجد بيانات لهذا الترم.</div>'; return; }
      term.units.forEach(function (u) {
        html2 += '<div class="section-title" style="margin-top:26px"><h3>' + esc(u.title) + '</h3></div>';
        u.chapters.forEach(function (ch) {
          html2 += '<div class="chapter-card"><div class="ch-head">' + esc(ch.title) + '</div><div class="exam-list">';
          ch.lessons.forEach(function (l) {
            html2 += examCard(l.examIds[0], 'موضوع', l.no, l.title, null, l);
          });
          html2 += '</div></div>';
        });
        if (u.comprehensiveExamId) {
          var ce = S.exams[u.comprehensiveExamId];
          html2 += '<div class="exam-list" style="margin-top:2px">' +
            examCard(u.comprehensiveExamId, 'شامل', '★', ce.title, 'شامل الوحدة') + '</div>';
        }
      });
      if (term.termComprehensiveExamId) {
        var tc = S.exams[term.termComprehensiveExamId];
        html2 += '<div class="section-title" style="margin-top:26px"><h3>الامتحان الشامل للترم</h3></div>' +
          '<div class="exam-list">' + examCard(term.termComprehensiveExamId, 'شامل', '★', tc.title, term.label + ' كاملًا') + '</div>';
      }
      app.innerHTML = html2;
    } else {
      go('#/');
    }
  }

  function examCard(examId, kicker, no, title, scope, lesson) {
    var e = S.exams[examId];
    var variants = '';
    if (lesson && lesson.examIds.length > 1) {
      variants = '<div class="variants">' + lesson.examIds.map(function (eid, i) {
        return '<span class="variant-chip" onclick="event.stopPropagation();go(\'#/e/' + eid + '\')">نموذج ' + (i + 1) + '</span>';
      }).join('') + '</div>';
    }
    var meta = e.count + ' سؤالًا · اختيار من متعدد' + (lesson && lesson.examIds.length > 1 ? ' · ' + lesson.examIds.length + ' نماذج' : '');
    return '<div class="exam-card' + (kicker === 'شامل' ? ' comp' : '') + '" onclick="go(\'#/e/' + examId + '\')" role="button" tabindex="0">' +
      '<div class="exam-no"><span>' + kicker + '</span><b>' + no + '</b></div>' +
      '<div class="info">' +
      '<div class="t">' + esc(title) + '</div>' +
      '<div class="s"><span>' + esc(meta) + '</span>' + difficultyBadge(e) + (scope ? '<span class="badge gold">' + esc(scope) + '</span>' : '') + '</div>' +
      variants +
      '</div>' +
      '<button class="go" aria-label="ابدأ الامتحان">‹</button>' +
      '</div>';
  }

  /* ---------------- صفحة بدء الامتحان ---------------- */
  function examScopeText(e) {
    if (e.type === 'subject-comprehensive') return 'شامل المنهج كاملًا';
    if (e.type === 'term-comprehensive') return 'شامل ' + (e.term === 1 ? 'الترم الأول' : 'الترم الثاني') + ' كاملًا';
    if (e.type === 'unit-comprehensive' || e.type === 'comprehensive') return 'شامل الوحدة: ' + (e.unitTitle || '');
    return 'الموضوع ' + (e.lessonNo || '') + (e.lessonTitle ? ' — ' + e.lessonTitle : '');
  }

  function renderExamInfo() {
    var e = S.exams[S.examId];
    if (!e) { app.innerHTML = '<div class="empty">الامتحان غير موجود.</div>'; return; }
    var sub = e.subjectId === 'psychology' ? S.catalog.psychology : S.catalog.philosophy;
    var html = crumb([
      ['الرئيسية', "go('#/')"],
      [sub.name, "go('#/s/" + e.subjectId + (e.subjectId === 'philosophy' && e.term ? '/' + e.term : '') + "')"],
      [e.type === 'topic' || e.type === 'training' ? 'الموضوع ' + e.lessonNo : 'الامتحان الشامل']
    ]);
    var diffRow = e.difficulty
      ? '<span class="badge">سهل: ' + e.difficulty.easy + '</span><span class="badge">متوسط: ' + e.difficulty.medium + '</span><span class="badge">متقدم: ' + e.difficulty.hard + '</span>'
      : '';
    html += '<div class="exam-head">' +
      '<div class="kicker">' + esc(e.unitTitle || '') + (e.chapterTitle ? ' · ' + esc(e.chapterTitle) : '') + '</div>' +
      '<h2>' + esc(e.title) + '</h2>' +
      (e.lessonTitle && (e.type === 'topic' || e.type === 'training') ? '<div class="sub">الدرس: ' + esc(e.lessonTitle) + '</div>' : '') +
      '</div>' +
      '<div class="exam-facts">' +
      '<span class="badge green">' + e.count + ' سؤالًا</span>' +
      '<span class="badge gold">' + esc(examScopeText(e)) + '</span>' +
      '<span class="badge">اختيار من متعدد</span>' +
      diffRow +
      '</div>' +
      '<div class="card rules-card">' +
      '<h3 style="font-size:.95rem">قبل أن تبدأ</h3>' +
      '<ul>' +
      '<li>' + CHECK_SVG + '<span>يجب الإجابة على <b>جميع الأسئلة</b> قبل تسليم الامتحان — لا يمكن التسليم وهناك سؤال بدون إجابة.</span></li>' +
      '<li>' + CHECK_SVG + '<span>يمكنك التنقل بين الأسئلة وتغيير إجاباتك بحرية قبل التسليم، وإجاباتك محفوظة أثناء التنقل.</span></li>' +
      '<li>' + CHECK_SVG + '<span>التصحيح فوري ويتم على الخادم، وترتيب الخيارات يختلف من طالب لآخر.</span></li>' +
      '<li>' + CHECK_SVG + '<span>بعد التسليم تظهر درجتك مباشرة مع مراجعة كاملة لإجاباتك الصحيحة والخاطئة.</span></li>' +
      '</ul></div>' +
      '<div class="card" style="max-width:480px;margin:0 auto 18px">' +
      '<div class="field"><label for="stName">الاسم</label><input type="text" id="stName" maxlength="120" placeholder="اكتب اسمك الثلاثي"></div>' +
      '<div class="field"><label for="stPhone">رقم الهاتف' + (S.teacher && S.teacher.requirePhone === false ? ' <span class="hint">(اختياري)</span>' : '') + '</label>' +
      '<input type="tel" id="stPhone" placeholder="01xxxxxxxxx" inputmode="numeric"></div>' +
      '<div id="startErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:10px"></div>' +
      '<button class="btn block" id="startBtn" onclick="startExam()">ابدأ الامتحان</button>' +
      '</div>';
    app.innerHTML = html;
    setTimeout(function () { $('stName').focus(); }, 50);
  }

  function startExam() {
    var name = $('stName').value.trim();
    var phone = $('stPhone').value.trim();
    var err = $('startErr');
    err.textContent = '';
    if (!name) { err.textContent = 'الاسم مطلوب.'; return; }
    $('startBtn').disabled = true;
    api('/api/exam/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ examId: S.examId, name: name, phone: phone, slug: S.slug })
    }).then(function (data) {
      S.session = data;
      S.answers = new Array(data.questions.length).fill(null);
      S.current = 0;
      S.reviewMode = false;
      restoreDraft();
      S.view = 'quiz';
      go('#/quiz');
      renderQuiz();
    }).catch(function (e) {
      err.textContent = e.message;
      $('startBtn').disabled = false;
    });
  }

  /* ---------------- حفظ مسودة الإجابات (sessionStorage) ---------------- */
  function draftKey() { return 'exammanasa_draft_' + S.examId; }
  function saveDraft() {
    try { sessionStorage.setItem(draftKey(), JSON.stringify({ token: S.session.token, answers: S.answers })); } catch (e) { }
  }
  function restoreDraft() {
    try {
      var raw = sessionStorage.getItem(draftKey());
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && d.token === S.session.token && Array.isArray(d.answers) && d.answers.length === S.answers.length) {
        S.answers = d.answers.map(function (a) { return (a === 0 || a === 1 || a === 2 || a === 3) ? a : null; });
      }
    } catch (e) { }
  }
  function clearDraft() { try { sessionStorage.removeItem(draftKey()); } catch (e) { } }

  /* ---------------- شاشة الامتحان ---------------- */
  function answeredCount() { return S.answers.filter(function (a) { return a !== null; }).length; }
  function missingList() {
    var m = [];
    S.answers.forEach(function (a, i) { if (a === null) m.push(i); });
    return m;
  }

  function renderQuiz() {
    var q = S.session.questions[S.current];
    var total = S.session.questions.length;
    var done = answeredCount();
    var html =
      '<div class="quiz-top">' +
      '<div class="row"><div class="qnum">السؤال <em>' + (S.current + 1) + '</em> من ' + total + '</div>' +
      '<div class="chip">أجبت ' + done + ' من ' + total + '</div></div>' +
      '<div class="progressbar"><i style="width:' + Math.round((done / total) * 100) + '%"></i></div>' +
      '<div class="navstrip">' + S.session.questions.map(function (_, i) {
        var cls = 'nchip' + (S.answers[i] !== null ? ' answered' : '') + (i === S.current ? ' current' : '');
        return '<button class="' + cls + '" onclick="jumpQ(' + i + ')" aria-label="سؤال ' + (i + 1) + '">' + (i + 1) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="qcard card">' +
      '<div class="qtext"><span class="qn">' + (S.current + 1) + '</span>' + esc(q.text) + '</div>' +
      '<div class="opts">' + q.options.map(function (opt, i) {
        return '<button class="opt' + (S.answers[S.current] === i ? ' selected' : '') + '" onclick="choose(' + i + ')">' +
          '<span class="letter">' + LETTERS[i] + '</span><span class="txt">' + esc(opt) + '</span></button>';
      }).join('') + '</div></div>' +
      '<div class="quiz-actions">' +
      '<button class="btn ghost" onclick="prevQ()" ' + (S.current === 0 ? 'disabled' : '') + '>السؤال السابق</button>' +
      (S.current === total - 1
        ? '<button class="btn gold" onclick="openReview()">مراجعة وتسليم</button>'
        : '<button class="btn" onclick="nextQ()">السؤال التالي</button>') +
      '</div>';
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
  }

  function choose(i) { S.answers[S.current] = i; saveDraft(); renderQuiz(); }
  function jumpQ(i) { S.current = i; renderQuiz(); }
  function nextQ() { if (S.current < S.session.questions.length - 1) { S.current++; renderQuiz(); } }
  function prevQ() { if (S.current > 0) { S.current--; renderQuiz(); } }

  document.addEventListener('keydown', function (e) {
    if (S.view !== 'quiz' || !S.session || S.reviewMode) return;
    if (e.key === 'ArrowLeft') nextQ();
    if (e.key === 'ArrowRight') prevQ();
    if (['1', '2', '3', '4'].includes(e.key)) choose(parseInt(e.key, 10) - 1);
  });

  /* ---------------- مراجعة الإجابات قبل التسليم ---------------- */
  function openReview() {
    S.reviewMode = true;
    var total = S.session.questions.length;
    var missing = missingList();
    var done = answeredCount();
    var html =
      '<div class="quiz-top"><div class="row"><div class="qnum">مراجعة الإجابات</div>' +
      '<div class="chip">أجبت ' + done + ' من ' + total + '</div></div>' +
      '<div class="progressbar"><i style="width:' + Math.round((done / total) * 100) + '%"></i></div></div>' +
      '<div style="margin-top:16px">';
    if (missing.length) {
      html += '<div class="rv-note warn">' + WARN_SVG +
        '<span>لم تُجب على ' + missing.length + ' ' + (missing.length === 1 ? 'سؤال' : 'أسئلة') + ' (رقم ' +
        missing.map(function (i) { return i + 1; }).join('، ') +
        ') — لا يمكن تسليم الامتحان قبل الإجابة عليها. اضغط على أي سؤال للانتقال إليه.</span></div>';
    } else {
      html += '<div class="rv-note ok">' + CHECK_SVG + '<span>أجبت على جميع الأسئلة — يمكنك تسليم الامتحان الآن.</span></div>';
    }
    html += S.session.questions.map(function (q, i) {
      var a = S.answers[i];
      return '<div class="rv-item" onclick="jumpFromReview(' + i + ')">' +
        '<div class="no">سؤال ' + (i + 1) + (a === null ? ' — بدون إجابة' : '') + '</div>' +
        '<div class="q">' + esc(q.text.slice(0, 130)) + (q.text.length > 130 ? '…' : '') + '</div>' +
        (a === null
          ? '<div class="a missing">لم تُجب بعد — اضغط للانتقال إلى السؤال</div>'
          : '<div class="a">' + LETTERS[a] + ') ' + esc(q.options[a].slice(0, 90)) + '</div>') +
        '</div>';
    }).join('') + '</div>' +
      '<div class="quiz-actions">' +
      '<button class="btn ghost" onclick="backToQuiz()">عودة إلى الأسئلة</button>' +
      (missing.length
        ? '<button class="btn" id="submitBtn" disabled>تسليم الامتحان — ناقص ' + missing.length + ' ' + (missing.length === 1 ? 'سؤال' : 'أسئلة') + '</button>'
        : '<button class="btn" id="submitBtn" onclick="submitExam()">تسليم الامتحان</button>') +
      '</div>';
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
  }

  function jumpFromReview(i) { S.reviewMode = false; S.current = i; renderQuiz(); }
  function backToQuiz() { S.reviewMode = false; renderQuiz(); }

  function submitExam() {
    var missing = missingList();
    if (missing.length) {
      toastMsg('لا يمكن التسليم قبل الإجابة على جميع الأسئلة.', true);
      S.current = missing[0];
      renderQuiz();
      return;
    }
    var btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = 'جارٍ التصحيح…';
    api('/api/exam/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ token: S.session.token, answers: S.answers })
    }).then(function (res) {
      S.result = res;
      S.view = 'result';
      S.reviewMode = false;
      clearDraft();
      renderResult();
    }).catch(function (e) {
      // رفض الخادم: أسئلة بدون إجابة — حددناها وانتقل إليها
      var unanswered = (e.data && e.data.unanswered) || [];
      if (unanswered.length) {
        toastMsg('أسئلة بدون إجابة: ' + unanswered.join('، ') + ' — لا يمكن التسليم قبل إجابتها.', true);
        S.reviewMode = false;
        S.current = (unanswered[0] - 1) || 0;
        renderQuiz();
      } else {
        btn.disabled = false;
        btn.textContent = 'تسليم الامتحان';
        toastMsg(e.message, true);
      }
    });
  }

  /* ---------------- النتيجة ومراجعة الأسئلة ---------------- */
  function renderResult() {
    var r = S.result;
    var cls = r.pass ? 'pass' : 'fail';
    var list = r.review.filter(function (q) {
      return S.resultFilter === 'all' || (S.resultFilter === 'correct' ? q.isCorrect : !q.isCorrect);
    });
    var html =
      '<div class="score-hero">' +
      '<div class="score-ring ' + cls + '"><div class="pct">' + r.percentage + '%</div><div class="frac">' + r.score + ' من ' + r.total + '</div></div>' +
      '<h2 style="font-size:1.3rem;color:var(--ink)">' + (r.pass ? '🎉 أحسنت — نتيجة ناجحة' : 'تحتاج مراجعة الموضوع') + '</h2>' +
      '<div class="res-badges">' +
      '<span class="badge green">إجابات صحيحة: ' + r.correct + '</span>' +
      '<span class="badge red">إجابات خاطئة: ' + r.wrong + '</span>' +
      '<span class="badge gold">' + esc(S.session.exam.title) + '</span></div>' +
      '</div>' +
      '<div class="noprint" style="display:flex;gap:10px;justify-content:center;margin:16px 0 4px;flex-wrap:wrap">' +
      '<button class="btn ghost small" onclick="window.print()">طباعة / PDF</button>' +
      '<button class="btn small" onclick="go(\'#/s/' + S.session.exam.subjectId + (S.session.exam.term ? '/' + S.session.exam.term : '') + '\')">امتحانات أخرى</button>' +
      '</div>' +
      '<div class="section-title" style="margin-top:26px"><h3>مراجعة الإجابات</h3></div>' +
      '<div class="review-filters">' +
      '<button class="tab ' + (S.resultFilter === 'all' ? 'active' : '') + '" onclick="filterResult(\'all\')">الكل (' + r.total + ')</button>' +
      '<button class="tab ' + (S.resultFilter === 'correct' ? 'active' : '') + '" onclick="filterResult(\'correct\')">إجابات صحيحة (' + r.correct + ')</button>' +
      '<button class="tab ' + (S.resultFilter === 'wrong' ? 'active' : '') + '" onclick="filterResult(\'wrong\')">إجابات خاطئة (' + r.wrong + ')</button></div>' +
      list.map(function (q) {
        return '<div class="rq ' + (q.isCorrect ? 'correct' : 'wrong') + '">' +
          '<div class="no"><span class="mark">' + (q.isCorrect ? '✅' : '❌') + '</span>السؤال ' + q.no + ' · ' + (q.isCorrect ? 'إجابة صحيحة' : 'إجابة خاطئة') + '</div>' +
          '<div class="q">' + esc(q.questionText) + '</div>' +
          '<div class="ans mine ' + (q.isCorrect ? 'correct' : 'wrong') + '"><span class="lbl">إجابتك</span>' + esc(q.studentAnswerText) + '</div>' +
          (q.isCorrect ? '' : '<div class="ans correct"><span class="lbl">الإجابة الصحيحة</span>' + esc(q.correctAnswerText) + '</div>') +
          '</div>';
      }).join('');
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
    document.title = 'النتيجة: ' + r.score + ' من ' + r.total + ' — منصة الامتحانات';
  }

  function filterResult(f) { S.resultFilter = f; renderResult(); }

  /* ---------------- تنبيه ---------------- */
  function toastMsg(msg, isErr) {
    var t = h('<div class="toast' + (isErr ? ' err' : '') + '">' + esc(msg) + '</div>');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  }

  /* ---------------- التصدير ---------------- */
  window.go = go;
  window.S = S;
  window.scrollToSubjects = scrollToSubjects;
  window.renderSubject = renderSubject;
  window.startExam = startExam;
  window.choose = choose;
  window.jumpQ = jumpQ;
  window.nextQ = nextQ;
  window.prevQ = prevQ;
  window.openReview = openReview;
  window.backToQuiz = backToQuiz;
  window.jumpFromReview = jumpFromReview;
  window.submitExam = submitExam;
  window.filterResult = filterResult;

  loadAll();
})();
