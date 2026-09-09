/* منصة الامتحانات — د. مصطفى تيتو — تطبيق الطالب (SPA خفيف بدون أي أطر)
 * وضع فاتح فقط (أزرق + ذهبي) — لا مفاتيح إجابة في هذا الملف: التصحيح يتم على
 * الخادم فقط، وترتيب الخيارات يُخلط على الخادم لكل جلسة.
 * المسار: الرئيسية ← بيانات الطالب ← الصف ← المادة/الترم ← الوحدة ← الموضوع ← الامتحان ← النتيجة */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var LETTERS = ['أ', 'ب', 'ج', 'د'];

  /* ---------------- الحالة ---------------- */
  var S = {
    slug: '', teacher: null, catalog: null, exams: null,
    view: 'home', // home | student | subject | exam | quiz | result
    sub: null, term: 1,
    examId: null, session: null,
    answers: [], current: 0, reviewMode: false,
    result: null, resultFilter: 'all',
    student: null,      // { name, phone, grade }
    pendingGrade: '',   // الصف المُختار مسبقًا عند القدوم من بطاقة صف
    uiGrade: '',        // اختيار الصف الحالي في شاشة بيانات الطالب
    scrollTo: null      // قسم للتمرير إليه بعد رسم الرئيسية
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
  function smoothScroll(el) { try { if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { } }

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var CAP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 1 8l11 5 9-4.09V15h2V8L12 3zm-7 9.18V16c0 1.66 3.13 3 7 3s7-1.34 7-3v-3.82l-7 3.18-7-3.18z"/></svg>';
  var WARN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="16.6" r=".5" fill="currentColor"/><path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/></svg>';
  var USER_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-3.9 0-8 1.97-8 4.5V21h16v-2.5c0-2.53-4.1-4.5-8-4.5z"/></svg>';
  var SOCIAL_DEFS = [
    ['whatsapp', 'واتساب', 'M12 2a10 10 0 00-8.6 15L2 22l5.2-1.4A10 10 0 1012 2zm5 13.6c-.2.6-1.2 1.2-1.7 1.2-.4 0-1 .1-3.3-1s-3.8-3.6-4-3.9c-.1-.3-.8-1.2-.8-2.3s.6-1.6.8-1.8c.2-.2.4-.3.6-.3h.5c.2 0 .4 0 .6.4l.8 1.9c.1.2.1.4 0 .6l-.4.5c-.1.2-.3.3-.1.6.2.3.7 1.1 1.4 1.8 1 .9 1.8 1.2 2.1 1.3.2.1.4.1.6-.1l.8-.9c.2-.2.4-.2.6-.1l1.8.9c.2.1.4.2.4.3.1.2.1.8-.1 1.4z'],
    ['facebook', 'فيسبوك', 'M13 22v-8h3l.5-4H13V8c0-1.1.3-1.9 2-1.9h1.6V2.6C16.3 2.5 15.1 2.4 13.8 2.4 10.9 2.4 9 4.1 9 7.5V10H6v4h3v8h4z'],
    ['tiktok', 'تيك توك', 'M16.6 5.8c.9 1 2.1 1.6 3.4 1.7v-3a4.9 4.9 0 01-3.4-2.1 5 5 0 01-.9-2.4h-3v13.6a2.8 2.8 0 11-2.8-2.8c.3 0 .6 0 .9.1V8.8a6 6 0 00-.9-.1 5.9 5.9 0 105.9 5.9V9.7c1.1.9 2.4 1.4 3.8 1.5V8.2c-.5 0-1-.1-1.4-.2-.8-.3-1.5-.7-2-1.3l-.6-.9z']
  ];

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
      try {
        var raw = sessionStorage.getItem('exammanasa_student');
        if (raw) { var st = JSON.parse(raw); if (st && st.name) S.student = st; }
      } catch (e) { }
      renderBrand();
      route();
    }).catch(function (e) {
      app.innerHTML = '<div class="card" style="text-align:center;padding:44px;margin-top:20px">' +
        '<h3>تعذر تحميل المنصة</h3><p class="desc" style="margin-top:8px">' + esc(e.message) + '</p>' +
        '<div style="margin-top:18px"><button class="btn" onclick="location.reload()">إعادة المحاولة</button></div></div>';
    });
  }

  function socialLinksOf(t) {
    if (!t || !t.socialLinks) return [];
    return SOCIAL_DEFS
      .map(function (d) { return { key: d[0], label: d[1], path: d[2], url: String(t.socialLinks[d[0]] || '').trim() }; })
      .filter(function (l) { return /^https?:\/\//i.test(l.url); });
  }

  function renderBrand() {
    var t = S.teacher;
    document.title = t ? (t.name + ' — منصة الامتحانات') : 'منصة الامتحانات — د. مصطفى تيتو';
    $('brandName').textContent = t ? t.name : 'منصة الامتحانات';
    $('brandSub').textContent = t ? (t.specialty || 'اختبارات المنهج الرسمي') : 'الفلسفة والمنطق · علم النفس';
    var logo = $('brandLogo');
    if (t && t.photo) logo.innerHTML = '<img src="' + esc(t.photo) + '" alt="">';
    else logo.textContent = monogramOf(t ? t.name : 'م ت');
    // ألوان المعلم (من الإعدادات الفعلية) فوق الهوية الزرقاء/الذهبية الافتراضية
    if (t && t.colors && /^#[0-9a-fA-F]{6}$/.test(t.colors.primary || '')) {
      document.documentElement.style.setProperty('--primary', t.colors.primary);
    }
    if (t && t.colors && /^#[0-9a-fA-F]{6}$/.test(t.colors.accent || '')) {
      document.documentElement.style.setProperty('--gold', t.colors.accent);
    }
    // أيقونات التواصل في الشريط العلوي — روابط فعلية فقط (لا أيقونات وهمية)
    var links = socialLinksOf(t);
    $('topSocials').innerHTML = links.map(function (l) {
      return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" aria-label="' + l.label + '" title="' + l.label + '">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + l.path + '"/></svg></a>';
    }).join('');
    var navContact = $('navContact');
    if (navContact) {
      if (links.length) { navContact.hidden = false; navContact.classList.remove('hidden'); }
      else { navContact.hidden = true; navContact.classList.add('hidden'); }
    }
  }

  function monogramOf(name) {
    var clean = String(name || '').replace(/^(د\.|أ\.|م\.|الدكتور|الأستاذ|استاذ)\s*/g, '').trim();
    var parts = clean.split(/\s+/).filter(Boolean);
    return (parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)) || 'م‌ت';
  }

  /* ---------------- التوجيه ----------------
   * مهم: كل مسار متوقع له فرع صريح في route() — أي هاش غير معروف
   * يعود للرئيسية. هذا يمنع عودة الطالب للرئيسية بعد بدء الامتحان
   * (الخلل القديم: '#/quiz' لم يكن له فرع فكانت الرئيسية تُرسم بعد بدء الامتحان). */
  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (!parts.length) { S.view = 'home'; renderHome(); return; }
    if (parts[0] === 'start') { S.view = 'student'; renderStudentData(); return; }
    if (parts[0] === 'quiz') {
      if (!S.session) { S.view = 'home'; renderHome(); return; } // لا جلسة (مثل تحديث الصفحة)
      if (S.view === 'result') { renderResult(); return; }
      S.view = 'quiz';
      if (S.reviewMode) openReview(); else renderQuiz();
      return;
    }
    if (parts[0] === 'result') {
      if (S.session && S.result) { S.view = 'result'; renderResult(); return; }
      S.view = 'home'; renderHome(); return;
    }
    if (parts[0] === 's' && parts[1]) { S.view = 'subject'; S.sub = parts[1]; S.term = parts[2] ? parseInt(parts[2], 10) || 1 : 1; renderSubject(); return; }
    if (parts[0] === 'e' && parts[1]) { S.view = 'exam'; S.examId = parts[1]; renderExamInfo(); return; }
    S.view = 'home'; renderHome(); return;
  }
  window.addEventListener('hashchange', function () {
    var h = location.hash;
    if (S.view === 'quiz' && h !== '#/quiz' && h !== '#/result') {
      if (!confirm('سيتم الخروج من الامتحان. هل أنت متأكد؟ (لن تُسلَّم إجاباتك)')) {
        location.hash = '#/quiz'; return;
      }
    }
    route();
  });

  function go(hash) {
    if (location.hash === hash) route(); // نفس الهاش لا يطلق حدثًا — نوجّه يدويًا
    else location.hash = hash;
  }

  /* ---------------- تنقل الشريط العلوي ---------------- */
  function navTo(target) {
    if (S.view === 'home') {
      if (target === 'top') { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { } return; }
      var el = $(target);
      if (el) { smoothScroll(el); return; }
    }
    S.scrollTo = target; // يُنفذ بعد رسم الرئيسية
    if (location.hash === '#/' || location.hash === '') { S.view = 'home'; renderHome(); }
    else go('#/');
  }
  function scrollToSubjects() { var el = $('subjects'); if (el) smoothScroll(el); }

  /* ---------------- بيانات الصفوف (أرقام فعلية من الفهرس) ---------------- */
  function countExams(subjectId) {
    return Object.keys(S.exams).filter(function (id) { return S.exams[id].subjectId === subjectId; }).length;
  }
  function gradeInfo(id) {
    if (id === 'psychology') {
      var p = S.catalog.psychology;
      var topics = p.units.reduce(function (n, u) { return n + u.lessons.length; }, 0);
      return {
        subjectId: 'psychology', icon: '🧠', cls: 'psychology',
        grade: 'الصف الثاني الثانوي', subject: 'بكالوريا — علم النفس',
        subName: p.name,
        stats: [p.units.length + ' وحدات', topics + ' موضوعات', countExams('psychology') + ' امتحانًا إلكترونيًا'],
        desc: 'امتحانات علم النفس مرتبة حسب الوحدات والموضوعات وفق المنهج الرسمي — مع تصحيح فوري ومراجعة الإجابات.'
      };
    }
    var ph = S.catalog.philosophy;
    var units = ph.terms.reduce(function (n, t) { return n + t.units.length; }, 0);
    return {
      subjectId: 'philosophy', icon: '📚', cls: 'philosophy',
      grade: 'الصف الأول الثانوي', subject: 'الفلسفة والمنطق',
      subName: ph.name,
      stats: ['ترمان دراسيان', units + ' وحدات', countExams('philosophy') + ' امتحانًا إلكترونيًا'],
      desc: 'امتحانات الفلسفة والمنطق مرتبة حسب الترم والوحدات والموضوعات وفق المنهج الرسمي — مع تصحيح فوري ومراجعة الإجابات.'
    };
  }

  /* ---------------- الرئيسية ---------------- */
  function renderHome() {
    var cat = S.catalog;
    var t = S.teacher;
    var year = cat.philosophy.academicYear;
    var links = socialLinksOf(t);
    var photo = (t && t.photo)
      ? '<img src="' + esc(t.photo) + '" alt="صورة ' + esc(t.name) + '">'
      : '<div class="monogram">' + esc(monogramOf(t ? t.name : 'م ت')) + '</div>';
    var g1 = gradeInfo('philosophy');
    var g2 = gradeInfo('psychology');
    var waUrl = '';
    links.forEach(function (l) { if (l.key === 'whatsapp' && !waUrl) waUrl = l.url; });

    var html =
      '<section class="hero">' +
      '<div class="hero-media">' +
      '<div class="blob"></div><div class="ring"></div>' +
      '<div class="photo">' + photo + '</div>' +
      '<div class="photo-badge">' + CAP_SVG + '</div>' +
      '<div class="float-chip">' + CHECK_SVG + ' تصحيح فوري</div>' +
      '</div>' +
      '<div class="hero-body">' +
      '<span class="kicker">' + CAP_SVG + ' منصة الامتحانات الإلكترونية — ' + esc(year) + '</span>' +
      '<h1>اختبر نفسك <em>وقيّم مستواك!</em></h1>' +
      '<p class="lead">منصة امتحانات إلكترونية للفلسفة والمنطق وعلم النفس وفق المنهج الرسمي: امتحانات منظمة حسب الصفوف والوحدات والموضوعات، درجتك فورًا بعد التسليم، ومراجعة كاملة لإجاباتك.</p>' +
      '<div class="hero-chips">' +
      '<span class="chip">اختبارات وفق <em>المنهج الرسمي</em></span>' +
      '<span class="chip">تصحيح فوري ومراجعة الإجابات</span>' +
      '</div>' +
      '<div class="hero-ctas">' +
      '<button class="btn" onclick="go(\'#/start\')">ابدأ الامتحان الآن</button>' +
      (waUrl ? '<a class="btn wa" href="' + esc(waUrl) + '" target="_blank" rel="noopener noreferrer">تواصل عبر واتساب</a>' : '') +
      '</div>' +
      (links.length ? socialRowHtml(links) : '') +
      '</div>' +
      '<div class="hero-grades">' +
      gradeMini(g1) + gradeMini(g2) +
      '</div>' +
      '</section>' +

      '<div class="section-title" id="subjects"><h3>اختر صفك للبدء</h3></div>' +
      '<div class="grid two">' +
      gradeCard(g1) + gradeCard(g2) +
      '</div>' +

      '<div class="section-title" id="features"><h3>لماذا منصة الامتحانات؟</h3></div>' +
      '<div class="features">' +
      '<div class="feature"><div class="fi f1">📚</div><h3>امتحانات منظمة</h3><p>امتحانات مرتبة حسب الصف والوحدات والموضوعات وفق المنهج الرسمي.</p></div>' +
      '<div class="feature"><div class="fi f2">📊</div><h3>نتيجتك فورًا</h3><p>اعرف درجتك ونسبتك المئوية مباشرة بعد تسليم الامتحان.</p></div>' +
      '<div class="feature"><div class="fi f3">📝</div><h3>مراجعة الإجابات</h3><p>راجع إجاباتك الصحيحة والخاطئة سؤالًا بسؤال بعد التسليم.</p></div>' +
      '</div>' +

      '<div class="section-title" id="about"><h3>عن المعلم والمنصة</h3></div>' +
      '<div class="card about-card">' +
      '<div class="photo">' + photo + '</div>' +
      '<div class="abody">' +
      '<h3>' + (t ? esc(t.name) : 'منصة الامتحانات التعليمية') + '</h3>' +
      (t && t.specialty ? '<div class="specialty">' + esc(t.specialty) + '</div>' : '') +
      (t && t.bio ? '<p class="bio">' + esc(t.bio) + '</p>' : '') +
      '<div class="hero-chips">' +
      '<span class="chip">' + esc(year) + '</span>' +
      '<span class="chip">الفلسفة والمنطق — الصف الأول الثانوي</span>' +
      '<span class="chip">علم النفس — الصف الثاني الثانوي</span>' +
      '</div>' +
      (links.length ? socialRowHtml(links) : '') +
      '</div>' +
      '</div>';

    if (links.length) {
      html += '<div class="section-title" id="contact"><h3>تواصل معنا</h3></div>' +
        '<div class="card" style="padding:26px">' +
        '<div class="social-big">' +
        links.map(function (l) {
          return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
            '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + l.path + '"/></svg>' + l.label + '</a>';
        }).join('') +
        '</div></div>';
    }
    app.innerHTML = html;

    if (S.scrollTo) {
      var target = S.scrollTo; S.scrollTo = null;
      if (target === 'top') { try { window.scrollTo({ top: 0 }); } catch (e) { } }
      else { var el = $(target); if (el) setTimeout(function () { smoothScroll(el); }, 40); }
    }
  }

  function socialRowHtml(links) {
    return '<div class="social-row">' + links.map(function (l) {
      return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + l.path + '"/></svg>' + l.label + '</a>';
    }).join('') + '</div>';
  }

  function gradeMini(g) {
    return '<div class="grade-mini" onclick="startWithGrade(\'' + g.subjectId + '\')" role="button" tabindex="0">' +
      '<div class="gi ' + g.cls + '">' + g.icon + '</div>' +
      '<div class="gt"><div class="g1">' + esc(g.grade) + '</div><div class="g2">' + esc(g.subject) + '</div></div>' +
      '<span class="ga">‹</span>' +
      '</div>';
  }

  function gradeCard(g) {
    return '<div class="grade-card" onclick="startWithGrade(\'' + g.subjectId + '\')" role="button" tabindex="0">' +
      '<div class="gi ' + g.cls + '">' + g.icon + '</div>' +
      '<h3>' + esc(g.grade) + '</h3>' +
      '<div class="gsub">' + esc(g.subject) + '</div>' +
      '<div class="desc">' + esc(g.desc) + '</div>' +
      '<div class="meta-row">' + g.stats.map(function (s) { return '<span class="badge">' + esc(s) + '</span>'; }).join('') + '</div>' +
      '<div class="cta-row"><span class="cta-hint">بيانات الطالب ثم الامتحانات</span><span class="btn small">ابدأ الآن</span></div>' +
      '</div>';
  }

  function startWithGrade(subjectId) {
    S.pendingGrade = subjectId;
    go('#/start');
  }

  /* ---------------- شاشة بيانات الطالب (قبل التصفح) ---------------- */
  function renderStudentData() {
    // اختيار بطاقة الصف له الأولوية دائمًا، ثم آخر صف مسجل للطالب
    if (S.pendingGrade) S.uiGrade = S.pendingGrade;
    else if (!S.uiGrade) S.uiGrade = (S.student && S.student.grade) || '';
    S.pendingGrade = '';
    var t = S.teacher;
    var st = S.student || {};
    var phoneOptional = !!(t && t.requirePhone === false);
    var g1 = gradeInfo('philosophy');
    var g2 = gradeInfo('psychology');
    var html = crumb([['الرئيسية', "go('#/')"], ['بيانات الطالب']]) +
      '<div class="exam-head"><h2>بيانات الطالب</h2><div class="sub">أدخل بياناتك ثم اختر صفك — الامتحانات منظمة حسب منهج صفك.</div></div>' +
      '<div class="card" style="max-width:560px;margin:0 auto">' +
      '<div class="field"><label for="stName">الاسم الكامل</label>' +
      '<input type="text" id="stName" maxlength="120" placeholder="اكتب اسمك الثلاثي" value="' + esc(st.name || '') + '"></div>' +
      '<div class="field"><label for="stPhone">رقم الهاتف' + (phoneOptional ? ' <span class="hint">(اختياري)</span>' : '') + '</label>' +
      '<input type="tel" id="stPhone" placeholder="01xxxxxxxxx" inputmode="numeric" value="' + esc(st.phone || '') + '"></div>' +
      '<div class="field"><label>اختر الصف</label>' +
      '<div class="grade-pick">' +
      gradeOpt(g1, S.uiGrade) + gradeOpt(g2, S.uiGrade) +
      '</div></div>' +
      '<div id="startErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:10px"></div>' +
      '<button class="btn block" id="contBtn" onclick="continueStudent()">متابعة إلى الامتحانات</button>' +
      '</div>';
    app.innerHTML = html;
    setTimeout(function () { var el = $('stName'); if (el && !el.value) el.focus(); }, 50);
  }

  function gradeOpt(g, selected) {
    var sel = selected === g.subjectId;
    return '<div class="grade-opt' + (sel ? ' sel' : '') + '" data-grade="' + g.subjectId + '" onclick="pickGrade(\'' + g.subjectId + '\')" role="button" tabindex="0" aria-pressed="' + sel + '">' +
      '<span class="gcheck">' + CHECK_SVG + '</span>' +
      '<div class="g1">' + g.icon + ' ' + esc(g.grade) + '</div>' +
      '<div class="g2">' + esc(g.subject) + '</div>' +
      '<div class="gstats">' + g.stats.join(' · ') + '</div>' +
      '</div>';
  }

  /* اختيار الصف دون إعادة رسم النموذج — حتى لا تُفقد القيم المكتوبة */
  function pickGrade(subjectId) {
    S.uiGrade = subjectId;
    var opts = document.querySelectorAll('.grade-opt');
    for (var i = 0; i < opts.length; i++) {
      var el = opts[i];
      var isSel = el.getAttribute('data-grade') === subjectId;
      if (isSel) el.classList.add('sel'); else el.classList.remove('sel');
      el.setAttribute('aria-pressed', isSel ? 'true' : 'false');
    }
  }

  function continueStudent() {
    var name = $('stName').value.trim();
    var phone = $('stPhone').value.trim();
    var err = $('startErr');
    err.textContent = '';
    if (!name || name.length < 3) { err.textContent = 'من فضلك اكتب الاسم الكامل.'; return; }
    var phoneOptional = !!(S.teacher && S.teacher.requirePhone === false);
    if (!phoneOptional && !phone) { err.textContent = 'رقم الهاتف مطلوب.'; return; }
    if (phone && !/^[0-9+\- ]{4,25}$/.test(phone)) { err.textContent = 'رقم الهاتف غير صالح.'; return; }
    if (!S.uiGrade) { err.textContent = 'اختر صفك للمتابعة.'; return; }
    S.student = { name: name, phone: phone, grade: S.uiGrade };
    try { sessionStorage.setItem('exammanasa_student', JSON.stringify(S.student)); } catch (e) { }
    go('#/s/' + S.uiGrade);
  }

  /* ---------------- صفحة المادة (حسب الصف) ---------------- */
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

  /* صف موضوع: رقم الموضوع + اسم الدرس حرفيًا + امتحاناته */
  function lessonRow(lesson) {
    var first = S.exams[lesson.examIds[0]];
    if (!first) return '';
    var isTraining = first.type === 'training' || !!first.training;
    var meta = (isTraining ? 'امتحان تدريبي' : 'امتحان الموضوع') + ' · ' + first.count + ' سؤالًا · اختيار من متعدد' +
      (lesson.examIds.length > 1 ? ' · ' + lesson.examIds.length + ' نماذج' : '');
    var variants = '';
    if (lesson.examIds.length > 1) {
      variants = '<div class="variants">' + lesson.examIds.map(function (eid, i) {
        return '<span class="variant-chip" onclick="event.stopPropagation();go(\'#/e/' + eid + '\')">نموذج ' + (i + 1) + '</span>';
      }).join('') + '</div>';
    }
    return '<div class="lesson" onclick="go(\'#/e/' + lesson.examIds[0] + '\')" role="button" tabindex="0">' +
      '<div class="lno"><span>الموضوع</span><b>' + lesson.no + '</b></div>' +
      '<div class="linfo">' +
      '<div class="lt">' + esc(lesson.title) + '</div>' +
      '<div class="ls"><span>' + esc(meta) + '</span>' + difficultyBadge(first) + '</div>' +
      variants +
      '</div>' +
      '<span class="lgo" aria-hidden="true">‹</span>' +
      '</div>';
  }

  /* بطاقة امتحان شامل — شكل مميز وشارة واضحة */
  function compRow(examId, scope) {
    var e = S.exams[examId];
    if (!e) return '';
    return '<div class="lesson comp" onclick="go(\'#/e/' + examId + '\')" role="button" tabindex="0">' +
      '<div class="lno"><span>شامل</span><b>★</b></div>' +
      '<div class="linfo">' +
      '<div class="lt">' + esc(e.title) + '</div>' +
      '<div class="ls"><span>' + e.count + ' سؤالًا · اختيار من متعدد' + (scope ? ' · ' + esc(scope) : '') + '</span>' + difficultyBadge(e) + '</div>' +
      '</div>' +
      '<span class="comp-badge">⭐ امتحان شامل</span>' +
      '</div>';
  }

  function renderSubject() {
    var cat = S.catalog;
    if (S.sub === 'psychology') {
      var sub = cat.psychology;
      var html = crumb([['الرئيسية', "go('#/')"], ['بيانات الطالب', "go('#/start')"], [sub.name]]);
      html += '<div class="section-title"><h3>' + esc(sub.name) + ' — الصف الثاني الثانوي (بكالوريا)</h3>' +
        '<span class="count">' + countExams('psychology') + ' امتحانًا</span></div>';
      sub.units.forEach(function (u) {
        html += '<div class="unit-card">' +
          '<div class="unit-head"><div class="uno">' + u.no + '</div><h4>' + esc(u.title) + '</h4>' +
          '<span class="chip count">' + u.lessons.length + ' موضوعات</span></div>' +
          '<div class="exam-list">';
        u.lessons.forEach(function (l) { html += lessonRow(l); });
        html += compRow(u.comprehensiveExamId, 'شامل الوحدة');
        html += '</div></div>';
      });
      html += '<div class="section-title" style="margin-top:26px"><h3>الامتحان الشامل للمنهج</h3></div>' +
        '<div class="final-comp">' + compRow(sub.subjectComprehensiveExamId, 'المنهج كاملًا — ' + sub.units.length + ' وحدات') + '</div>';
      app.innerHTML = html;
    } else if (S.sub === 'philosophy') {
      var sub2 = cat.philosophy;
      var html2 = crumb([['الرئيسية', "go('#/')"], ['بيانات الطالب', "go('#/start')"], [sub2.name]]);
      html2 += '<div class="section-title"><h3>' + esc(sub2.name) + ' — الصف الأول الثانوي</h3></div>';
      html2 += '<div class="filters" style="justify-content:center">' +
        '<button class="tab ' + (S.term === 1 ? 'active' : '') + '" onclick="S.term=1;renderSubject()">الترم الأول</button>' +
        '<button class="tab ' + (S.term === 2 ? 'active' : '') + '" onclick="S.term=2;renderSubject()">الترم الثاني</button></div>';
      var term = sub2.terms.filter(function (t) { return t.term === S.term; })[0];
      if (!term) { app.innerHTML = html2 + '<div class="empty">لا توجد بيانات لهذا الترم.</div>'; return; }
      term.units.forEach(function (u) {
        var lessonsCount = u.chapters.reduce(function (n, ch) { return n + ch.lessons.length; }, 0);
        html2 += '<div class="unit-card">' +
          '<div class="unit-head"><div class="uno">✦</div><h4>' + esc(u.title) + '</h4>' +
          '<span class="chip count">' + lessonsCount + ' موضوعات</span></div>';
        u.chapters.forEach(function (ch) {
          html2 += '<div class="chapter"><div class="ch-title">' + esc(ch.title) + '</div><div class="exam-list">';
          ch.lessons.forEach(function (l) { html2 += lessonRow(l); });
          html2 += '</div></div>';
        });
        if (u.comprehensiveExamId) html2 += '<div class="exam-list" style="margin-top:12px">' + compRow(u.comprehensiveExamId, 'شامل الوحدة') + '</div>';
        html2 += '</div>';
      });
      if (term.termComprehensiveExamId) {
        html2 += '<div class="section-title" style="margin-top:26px"><h3>الامتحان الشامل للترم</h3></div>' +
          '<div class="final-comp">' + compRow(term.termComprehensiveExamId, term.label + ' كاملًا') + '</div>';
      }
      app.innerHTML = html2;
    } else {
      go('#/');
    }
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
    var st = S.student || {};
    var hasStudent = !!st.name;
    var phoneOptional = !!(S.teacher && S.teacher.requirePhone === false);
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
      (hasStudent
        ? '<div class="stu-sum">' + USER_SVG + '<div><div class="sn">' + esc(st.name) + '</div>' +
          (st.phone ? '<div class="sp">' + esc(st.phone) + '</div>' : '') + '</div>' +
          '<button class="linkbtn" onclick="toggleStuForm()">تعديل البيانات</button></div>'
        : '') +
      '<div id="stuFields"' + (hasStudent ? ' class="hidden"' : '') + '>' +
      '<div class="field"><label for="stName">الاسم' + (hasStudent ? '' : ' الكامل') + '</label><input type="text" id="stName" maxlength="120" placeholder="اكتب اسمك الثلاثي" value="' + esc(st.name || '') + '"></div>' +
      '<div class="field"><label for="stPhone">رقم الهاتف' + (phoneOptional ? ' <span class="hint">(اختياري)</span>' : '') + '</label>' +
      '<input type="tel" id="stPhone" placeholder="01xxxxxxxxx" inputmode="numeric" value="' + esc(st.phone || '') + '"></div>' +
      '</div>' +
      '<div id="startErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:10px"></div>' +
      '<button class="btn block" id="startBtn" onclick="startExam()">ابدأ الامتحان</button>' +
      '</div>';
    app.innerHTML = html;
    if (!hasStudent) setTimeout(function () { var el = $('stName'); if (el) el.focus(); }, 50);
  }

  function toggleStuForm() {
    var f = $('stuFields');
    if (f) f.classList.toggle('hidden');
  }

  function startExam() {
    var fields = $('stuFields');
    var useStudent = S.student && S.student.name && (!fields || fields.classList.contains('hidden'));
    var name = useStudent ? S.student.name : ($('stName').value.trim());
    var phone = useStudent ? (S.student.phone || '') : ($('stPhone').value.trim());
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
      go('#/quiz'); // ← route() يعيد رسم شاشة الامتحان (إصلاح خلل العودة للرئيسية)
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
    try { window.scrollTo({ top: 0 }); } catch (e) { }
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
    try { window.scrollTo({ top: 0 }); } catch (e) { }
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
      go('#/result'); // ← route() يعيد رسم النتيجة (ولا يعود للرئيسية)
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
    if (!r) { go('#/'); return; }
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
    try { window.scrollTo({ top: 0 }); } catch (e) { }
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
  window.navTo = navTo;
  window.scrollToSubjects = scrollToSubjects;
  window.startWithGrade = startWithGrade;
  window.renderSubject = renderSubject;
  window.renderStudentData = renderStudentData;
  window.pickGrade = pickGrade;
  window.continueStudent = continueStudent;
  window.toggleStuForm = toggleStuForm;
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
