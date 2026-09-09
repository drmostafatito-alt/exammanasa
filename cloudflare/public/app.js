/* منصة الامتحانات — تطبيق الطالب (SPA بدون أي أطر — خفيف وسريع)
 * لا يحتوي هذا الملف على أي مفاتيح إجابة: التصحيح يتم على الخادم فقط،
 * وترتيب الخيارات يُخلط على الخادم لكل جلسة. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');
  var LETTERS = ['أ', 'ب', 'ج', 'د'];

  /* ---------------- state ---------------- */
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

  /* ---------------- data ---------------- */
  function teacherSlugFromPath() {
    var p = location.pathname.replace(/^\/+|\/+$/g, '');
    if (!p || p === 'index.html' || p === 'admin' || p === 'admin.html') return '';
    return /^[a-z0-9][a-z0-9-]{0,29}$/i.test(p) ? p.toLowerCase() : '';
  }

  function api(path, opts) {
    return fetch(path, opts ? Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts) : undefined)
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || ('خطأ ' + r.status));
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
      S.teacher = res[1] || null;
      if (S.teacher) document.title = S.teacher.name + ' — منصة الامتحانات';
      renderBrand();
      route();
    }).catch(function (e) {
      app.innerHTML = '<div class="card" style="text-align:center;padding:40px">' +
        '<h3>تعذر تحميل المنصة</h3><p class="desc" style="margin-top:8px">' + esc(e.message) + '</p>' +
        '<div style="margin-top:16px"><button class="btn" onclick="location.reload()">إعادة المحاولة</button></div></div>';
    });
  }

  function renderBrand() {
    var t = S.teacher;
    var name = $('brandName'), sub = $('brandSub'), logo = $('brandLogo');
    name.textContent = t ? t.name : 'منصة الامتحانات التعليمية';
    sub.textContent = t ? (t.bio ? t.bio.slice(0, 60) : 'اختبارات المنهج الرسمي') : 'الفلسفة والمنطق · علم النفس';
    if (t && t.photo) logo.innerHTML = '<img src="' + esc(t.photo) + '" alt="">';
    else logo.textContent = t ? t.name.replace(/^(د\.|أ\.|م\.|الدكتور)\s*/, '').slice(0, 2) : 'EDU';
    if (t && t.colors) {
      document.documentElement.style.setProperty('--primary', t.colors.primary || '#123B40');
      document.documentElement.style.setProperty('--accent', t.colors.accent || '#C9A86A');
    }
  }

  /* ---------------- routing ---------------- */
  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (!parts.length) { S.view = 'home'; renderHome(); return; }
    if (parts[0] === 's' && parts[1]) { S.view = 'subject'; S.sub = parts[1]; S.term = parts[2] ? parseInt(parts[2], 10) || 1 : 1; renderSubject(); return; }
    if (parts[0] === 'e' && parts[1]) { S.view = 'exam'; S.examId = parts[1]; renderExamInfo(); return; }
    S.view = 'home'; renderHome();
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

  /* ---------------- home ---------------- */
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
    var html =
      '<div class="hero">' +
      '<div class="hello">' + (t ? 'أهلًا بك في منصة' : 'منصة الامتحانات التعليمية') + '</div>' +
      '<h2>' + (t ? esc(t.name) : 'اختبر نفسك في المنهج') + '</h2>' +
      '<div class="year">' + esc(cat.philosophy.academicYear) + ' · ' + (t ? 'اختبارات المنهج الرسمي' : '') + '</div>' +
      socialRow(t) +
      '</div>' +
      '<div class="grid two">';
    html += subjectCard('psychology', 'علم النفس', cat.psychology, '🧠',
      '٦ وحدات · ٢٤ موضوعًا · ٣١ امتحانًا — الصف الثاني الثانوي');
    html += subjectCard('philosophy', 'الفلسفة والمنطق', cat.philosophy, '📚',
      'الترم الأول والثاني · ٥٢ امتحانًا — الصف الأول الثانوي');
    html += '</div>';
    app.innerHTML = html;
  }

  function subjectCard(id, name, sub, ico, desc) {
    return '<div class="card clickable" onclick="go(\'#/s/' + id + '\')">' +
      '<div class="subject-ico">' + ico + '</div>' +
      '<h3>' + esc(name) + '</h3>' +
      '<div class="desc">' + esc(desc) + '</div>' +
      '<div class="meta-row">' +
      '<span class="badge">' + (sub.units ? sub.units.length + ' وحدات' : 'ترمان دراسيان') + '</span>' +
      '<span class="badge gold">' + countExams(id) + ' امتحانًا</span>' +
      '</div></div>';
  }

  function countExams(subjectId) {
    return Object.keys(S.exams).filter(function (id) { return S.exams[id].subjectId === subjectId; }).length;
  }

  /* ---------------- subject view ---------------- */
  function crumb(parts) {
    var html = '<div class="crumb">';
    parts.forEach(function (p, i) {
      if (i) html += '<span class="sep">‹</span>';
      html += p[1] ? '<button onclick="' + p[1] + '">' + esc(p[0]) + '</button>' : '<span>' + esc(p[0]) + '</span>';
    });
    return html + '</div>';
  }

  function renderSubject() {
    var cat = S.catalog;
    if (S.sub === 'psychology') {
      var sub = cat.psychology;
      var html = crumb([['الرئيسية', "go('#/')"], [sub.name]]);
      html += '<div class="section-title"><h3>' + esc(sub.gradeName) + '</h3><span class="count">' + countExams('psychology') + ' امتحانًا</span></div>';
      sub.units.forEach(function (u) {
        html += '<div class="section-title" style="margin-top:22px"><h3>' + esc(u.title) + '</h3><span class="count">' + u.lessons.length + ' موضوعات</span></div>';
        html += '<div class="grid" style="gap:9px">';
        u.lessons.forEach(function (l) {
          var e = S.exams[l.examIds[0]];
          html += lessonItem(l.examIds[0], l.no, l.title, e.count + ' سؤالًا', false);
        });
        var ce = S.exams[u.comprehensiveExamId];
        html += lessonItem(u.comprehensiveExamId, '★', ce.title.replace('الامتحان الشامل — ', 'الشامل'), ce.count + ' سؤالًا', true);
        html += '</div>';
      });
      var full = S.exams[sub.subjectComprehensiveExamId];
      html += '<div class="grid" style="gap:9px;margin-top:22px">' +
        lessonItem(sub.subjectComprehensiveExamId, '★', 'الامتحان الشامل — المنهج كاملًا', full.count + ' سؤالًا · كل الوحدات', true) + '</div>';
      app.innerHTML = html;
    } else if (S.sub === 'philosophy') {
      var sub2 = cat.philosophy;
      var html2 = crumb([['الرئيسية', "go('#/')"], [sub2.name]]);
      html2 += '<div class="section-title"><h3>' + esc(sub2.gradeName) + '</h3></div>';
      html2 += '<div class="filters" style="justify-content:center">' +
        '<button class="tab ' + (S.term === 1 ? 'active' : '') + '" onclick="S.term=1;renderSubject()">الترم الأول</button>' +
        '<button class="tab ' + (S.term === 2 ? 'active' : '') + '" onclick="S.term=2;renderSubject()">الترم الثاني</button></div>';
      var term = sub2.terms.filter(function (t) { return t.term === S.term; })[0];
      if (!term) { app.innerHTML = html2 + '<div class="empty">لا توجد بيانات لهذا الترم.</div>'; return; }
      term.units.forEach(function (u) {
        html2 += '<div class="section-title" style="margin-top:22px"><h3>' + esc(u.title) + '</h3></div>';
        u.chapters.forEach(function (ch) {
          html2 += '<div class="card" style="padding:14px 16px;margin-bottom:12px">' +
            '<div style="font-weight:800;color:var(--accent-2);font-size:.95rem">' + esc(ch.title) + '</div>' +
            '<div class="grid" style="gap:9px;margin-top:12px">';
          ch.lessons.forEach(function (l) {
            var e = S.exams[l.examIds[0]];
            var variants = '';
            if (l.examIds.length > 1) {
              variants = '<div class="variants">' + l.examIds.map(function (eid, i) {
                return '<span class="variant-chip" onclick="event.stopPropagation();go(\'#/e/' + eid + '\')">نموذج ' + (i + 1) + '</span>';
              }).join('') + '</div>';
            }
            html2 += lessonItem(l.examIds[0], l.no, l.title, e.count + ' سؤالًا' + (l.examIds.length > 1 ? ' · ' + l.examIds.length + ' نماذج' : ''), false, variants);
          });
          html2 += '</div></div>';
        });
        if (u.comprehensiveExamId) {
          var ce = S.exams[u.comprehensiveExamId];
          html2 += '<div class="grid" style="gap:9px;margin-top:10px">' +
            lessonItem(u.comprehensiveExamId, '★', ce.title, ce.count + ' سؤالًا · شامل الوحدة', true) + '</div>';
        }
      });
      if (term.termComprehensiveExamId) {
        var tc = S.exams[term.termComprehensiveExamId];
        html2 += '<div class="grid" style="gap:9px;margin-top:16px">' +
          lessonItem(term.termComprehensiveExamId, '★', tc.title, tc.count + ' سؤالًا · ' + term.label + ' كاملًا', true) + '</div>';
      }
      app.innerHTML = html2;
    } else {
      go('#/');
    }
  }

  function lessonItem(examId, no, title, sub, comp, extra) {
    var e = S.exams[examId];
    var kicker = comp ? 'شامل' : 'موضوع';
    return '<div class="lesson-item' + (comp ? ' comp' : '') + '" onclick="go(\'#/e/' + examId + '\')">' +
      '<div class="lesson-no"><span>' + kicker + '</span><b>' + no + '</b></div>' +
      '<div class="info"><div class="t">' + esc(title) + '</div><div class="s">' + esc(sub) + '</div>' + (extra || '') + '</div>' +
      '<div class="arrow">‹</div></div>';
  }

  /* ---------------- exam info + start ---------------- */
  function renderExamInfo() {
    var e = S.exams[S.examId];
    if (!e) { app.innerHTML = '<div class="empty">الامتحان غير موجود.</div>'; return; }
    var sub = e.subjectId === 'psychology' ? S.catalog.psychology : S.catalog.philosophy;
    var html = crumb([
      ['الرئيسية', "go('#/')"],
      [sub.name, "go('#/s/" + e.subjectId + (e.subjectId === 'philosophy' && e.term ? '/' + e.term : '') + "')"],
      [e.type === 'topic' || e.type === 'training' ? 'الموضوع ' + e.lessonNo : 'امتحان شامل']
    ]);
    html += '<div class="exam-head">' +
      '<div class="kicker">' + esc(e.unitTitle || '') + (e.chapterTitle ? ' · ' + esc(e.chapterTitle) : '') + '</div>' +
      '<h2>' + esc(e.title) + '</h2>' +
      (e.lessonTitle && (e.type === 'topic' || e.type === 'training') ? '<div class="sub">الدرس: ' + esc(e.lessonTitle) + '</div>' : '') +
      '</div>' +
      '<div class="exam-facts">' +
      '<span class="badge gold">' + e.count + ' سؤالًا</span>' +
      '<span class="badge">اختيار من متعدد</span>' +
      '<span class="badge">تصحيح فوري على الخادم</span>' +
      '<span class="badge green">مراجعة الإجابات بعد التسليم</span>' +
      '</div>' +
      '<div class="card" style="max-width:480px;margin:18px auto">' +
      '<div class="field"><label>الاسم</label><input type="text" id="stName" maxlength="120" placeholder="اكتب اسمك الثلاثي"></div>' +
      '<div class="field"><label>رقم الهاتف' + (S.teacher && S.teacher.requirePhone === false ? ' (اختياري)' : '') + '</label>' +
      '<input type="tel" id="stPhone" placeholder="01xxxxxxxxx" inputmode="numeric"></div>' +
      '<div id="startErr" style="color:var(--bad);font-size:.8rem;min-height:1.2em;margin-bottom:8px"></div>' +
      '<button class="btn block" id="startBtn" onclick="startExam()">بدء الامتحان</button>' +
      '</div>' +
      '<div class="desc" style="text-align:center;font-size:.76rem;color:var(--muted)">يجب الإجابة على جميع الأسئلة قبل التسليم — يمكنك مراجعة إجاباتك قبل التأكيد.</div>';
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

  /* ---------------- draft persistence (sessionStorage) ---------------- */
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

  /* ---------------- quiz ---------------- */
  function answeredCount() { return S.answers.filter(function (a) { return a !== null; }).length; }

  function renderQuiz() {
    var q = S.session.questions[S.current];
    var total = S.session.questions.length;
    var done = answeredCount();
    var html =
      '<div class="quiz-top">' +
      '<div class="row"><div class="qnum">السؤال ' + (S.current + 1) + ' من ' + total + '</div>' +
      '<div class="chip">' + done + ' من ' + total + ' تم الإجابة</div></div>' +
      '<div class="progressbar"><i style="width:' + Math.round((done / total) * 100) + '%"></i></div>' +
      '<div class="navstrip">' + S.session.questions.map(function (_, i) {
        var cls = 'nchip' + (S.answers[i] !== null ? ' answered' : '') + (i === S.current ? ' current' : '');
        return '<button class="' + cls + '" onclick="jumpQ(' + i + ')" aria-label="سؤال ' + (i + 1) + '">' + (i + 1) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="qcard card">' +
      '<div class="qtext">' + (S.current + 1) + '. ' + esc(q.text) + '</div>' +
      '<div class="opts">' + q.options.map(function (opt, i) {
        return '<button class="opt' + (S.answers[S.current] === i ? ' selected' : '') + '" onclick="choose(' + i + ')">' +
          '<span class="letter">' + LETTERS[i] + '</span><span class="txt">' + esc(opt) + '</span></button>';
      }).join('') + '</div></div>' +
      '<div class="quiz-actions">' +
      '<button class="btn ghost" onclick="prevQ()" ' + (S.current === 0 ? 'disabled' : '') + '>السابق</button>' +
      (S.current === total - 1
        ? '<button class="btn" onclick="openReview()">مراجعة وتسليم</button>'
        : '<button class="btn" onclick="nextQ()">التالي</button>') +
      '</div>';
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
  }

  function choose(i) { S.answers[S.current] = i; saveDraft(); renderQuiz(); }
  function jumpQ(i) { S.current = i; renderQuiz(); }
  function nextQ() { if (S.current < S.session.questions.length - 1) { S.current++; renderQuiz(); } }
  function prevQ() { if (S.current > 0) { S.current--; renderQuiz(); } }

  document.addEventListener('keydown', function (e) {
    if (S.view !== 'quiz' || !S.session) return;
    if (e.key === 'ArrowLeft') nextQ();
    if (e.key === 'ArrowRight') prevQ();
    if (['1', '2', '3', '4'].includes(e.key)) choose(parseInt(e.key, 10) - 1);
  });

  /* ---------------- review before submit ---------------- */
  function openReview() {
    var total = S.session.questions.length;
    var missing = [];
    S.answers.forEach(function (a, i) { if (a === null) missing.push(i); });
    var html =
      '<div class="quiz-top"><div class="row"><div class="qnum">مراجعة الإجابات</div>' +
      '<div class="chip">' + answeredCount() + ' من ' + total + ' تم الإجابة</div></div>' +
      '<div class="progressbar"><i style="width:' + Math.round((answeredCount() / total) * 100) + '%"></i></div></div>' +
      '<div style="margin-top:14px">' +
      S.session.questions.map(function (q, i) {
        var a = S.answers[i];
        return '<div class="rv-item" onclick="jumpFromReview(' + i + ')">' +
          '<div class="no">سؤال ' + (i + 1) + (a === null ? ' — بدون إجابة' : '') + '</div>' +
          '<div class="q">' + esc(q.text.slice(0, 120)) + (q.text.length > 120 ? '…' : '') + '</div>' +
          (a === null
            ? '<div class="a missing">لم تُجب بعد — اضغط للانتقال إلى السؤال</div>'
            : '<div class="a">' + LETTERS[a] + ') ' + esc(q.options[a].slice(0, 90)) + '</div>') +
          '</div>';
      }).join('') + '</div>' +
      '<div class="quiz-actions">' +
      '<button class="btn ghost" onclick="backToQuiz()">عودة للأسئلة</button>' +
      '<button class="btn" id="submitBtn" onclick="submitExam(' + (missing.length === 0) + ')">' +
      (missing.length === 0 ? 'تسليم الامتحان' : 'تسليم (' + missing.length + ' أسئلة بدون إجابة)') + '</button></div>';
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
  }

  function jumpFromReview(i) { S.current = i; renderQuiz(); }
  function backToQuiz() { renderQuiz(); }

  function submitExam(complete) {
    if (!complete) {
      var missing = [];
      S.answers.forEach(function (a, i) { if (a === null) missing.push(i); });
      if (missing.length) {
        toastMsg('لا يمكن التسليم قبل الإجابة على جميع الأسئلة — تم الانتقال إلى أول سؤال بدون إجابة.', true);
        S.current = missing[0];
        renderQuiz();
        return;
      }
    }
    if (!confirm('هل أنت متأكد من تسليم الامتحان؟ لا يمكن التعديل بعد التسليم.')) return;
    $('submitBtn').disabled = true;
    $('submitBtn').textContent = 'جارٍ التصحيح…';
    api('/api/exam/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ token: S.session.token, answers: S.answers })
    }).then(function (res) {
      S.result = res;
      S.view = 'result';
      clearDraft();
      renderResult();
    }).catch(function (e) {
      $('submitBtn').disabled = false;
      $('submitBtn').textContent = 'تسليم الامتحان';
      toastMsg(e.message, true);
    });
  }

  /* ---------------- result + per-question review ---------------- */
  function renderResult() {
    var r = S.result;
    var cls = r.pass ? 'pass' : 'fail';
    var list = r.review.filter(function (q) {
      return S.resultFilter === 'all' || (S.resultFilter === 'correct' ? q.isCorrect : !q.isCorrect);
    });
    var html =
      '<div class="score-hero">' +
      '<div class="score-ring ' + cls + '"><div class="pct">' + r.percentage + '%</div><div class="frac">' + r.score + ' من ' + r.total + '</div></div>' +
      '<h2 style="font-size:1.3rem">' + (r.pass ? '🎉 أحسنت! نتيجة ناجحة' : 'تحتاج مراجعة المادة') + '</h2>' +
      '<div class="res-badges">' +
      '<span class="badge green">صحيحة: ' + r.correct + '</span>' +
      '<span class="badge" style="color:var(--bad);border-color:rgba(255,107,107,.4)">خاطئة: ' + r.wrong + '</span>' +
      '<span class="badge gold">' + esc(S.session.exam.title) + '</span></div>' +
      '</div>' +
      '<div class="noprint" style="display:flex;gap:10px;justify-content:center;margin:14px 0 6px">' +
      '<button class="btn ghost small" onclick="window.print()">طباعة / PDF</button>' +
      '<button class="btn small" onclick="go(\'#/s/' + S.session.exam.subjectId + (S.session.exam.term ? '/' + S.session.exam.term : '') + '\')">امتحانات أخرى</button>' +
      '</div>' +
      '<div class="section-title" style="margin-top:26px"><h3>مراجعة الأسئلة</h3></div>' +
      '<div class="review-filters">' +
      '<button class="tab ' + (S.resultFilter === 'all' ? 'active' : '') + '" onclick="filterResult(\'all\')">الكل (' + r.total + ')</button>' +
      '<button class="tab ' + (S.resultFilter === 'correct' ? 'active' : '') + '" onclick="filterResult(\'correct\')">الصحيحة (' + r.correct + ')</button>' +
      '<button class="tab ' + (S.resultFilter === 'wrong' ? 'active' : '') + '" onclick="filterResult(\'wrong\')">الخاطئة (' + r.wrong + ')</button></div>' +
      list.map(function (q) {
        return '<div class="rq">' +
          '<div class="no">سؤال ' + q.no + ' · ' + (q.isCorrect ? '✓ إجابة صحيحة' : '✗ إجابة خاطئة') + '</div>' +
          '<div class="q">' + esc(q.questionText) + '</div>' +
          '<div class="ans mine ' + (q.isCorrect ? '' : 'wrong') + '"><span class="lbl">إجابتك</span>' + esc(q.studentAnswerText) + '</div>' +
          '<div class="ans correct"><span class="lbl">الإجابة الصحيحة</span>' + esc(q.correctAnswerText) + '</div>' +
          '</div>';
      }).join('');
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
    document.title = 'نتيجة ' + r.score + '/' + r.total + ' — منصة الامتحانات';
  }

  function filterResult(f) { S.resultFilter = f; renderResult(); }

  /* ---------------- toast ---------------- */
  function toastMsg(msg, isErr) {
    var t = h('<div class="toast' + (isErr ? ' err' : '') + '">' + esc(msg) + '</div>');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }

  /* ---------------- expose ---------------- */
  window.go = go;
  window.S = S;
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
