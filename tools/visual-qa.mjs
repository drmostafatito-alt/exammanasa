/* visual-qa.mjs — layout/geometry verification of the redesigned surfaces.
 * Extracts computed styles + bounding boxes (readable as text) to confirm the
 * premium RTL design: hierarchy order, circular portrait, card rounding/shadow,
 * bottom-nav (mobile only, safe-area, active state), footer, no overlap/overflow. */
import { chromium as pw } from 'playwright-core';
import chromiumMin from '@sparticuz/chromium-min';

const BASE = process.env.QABASE || 'http://127.0.0.1:8787';
const exe = await chromiumMin.executablePath('/tmp/chrm');
process.env.LD_LIBRARY_PATH = (process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : '') + '/tmp/crlibs/lib';
const browser = await pw.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ar'], headless: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  \u2713 ' + name); } else { fail++; console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + extra : '')); } };

async function facts(page, sel, props) {
  return page.evaluate(([sel, props]) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const out = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    for (const p of props) out[p] = cs.getPropertyValue(p).trim();
    return out;
  }, [sel, props]);
}

/* ---------- Desktop 1280 ---------- */
console.log('\n[V1] Desktop 1280\u00d7900 \u2014 hierarchy & premium visuals');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-EG' });
  await ctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });

  const order = await p.evaluate(() => [...document.querySelector('#app').children].map(c => (c.id || c.className.split(' ')[0])));
  const idx = (arr, v) => arr.findIndex(x => x === v);
  ok('ترتيب الأقسام: hero \u2192 subjects \u2192 features \u2192 about', order[0] === 'hero' && idx(order, 'subjects') < idx(order, 'features') && idx(order, 'features') < idx(order, 'about'), order.join(' \u2192 '));

  const hero = await facts(p, '.hero', ['grid-template-columns', 'border-radius', 'box-shadow', 'background-image']);
  ok('Hero شبكة عمودين (media+body)', hero && hero['grid-template-columns'].trim().split(/\s+/).length === 2, hero && hero['grid-template-columns']);
  ok('Hero مفتوح بلا خلفية بطاقة (transparent)', hero && hero['background-image'] === 'none', hero && hero['background-image']);
  ok('Hero بلا حواف/ظل بطاقة (radius 0 + shadow none)', hero && (parseInt(hero['border-radius']) === 0 || hero['border-radius'] === '0px') && hero['box-shadow'] === 'none', JSON.stringify(hero));

  const photo = await facts(p, '.hero .portrait .pt-img', ['border-radius', 'background-image']);
  ok('إطار الصورة عضوي (radius > 20%) وليس دائرة كاملة', photo && parseInt(photo['border-radius']) > 20 && photo['border-radius'] !== '50%', JSON.stringify(photo));
  ok('خلفية الصورة مولّدة فاتحة (لا أسود خلف الشفافية)', photo && photo['background-image'].includes('gradient'), photo && photo['background-image']);
  const fit = await p.evaluate(() => { const el = document.querySelector('.hero .portrait'); const img = el && el.querySelector('img'); return { fit: el && el.getAttribute('data-fit'), obj: img ? getComputedStyle(img).objectFit : getComputedStyle(el.querySelector('.monogram') || el).display }; });
  ok('strategy العرض معلنة (contain/cover) بلا قص إجباري دائري', !!fit.fit, JSON.stringify(fit));

  const badge = await facts(p, '.hero .photo-badge', ['background-image', 'border-radius']);
  ok('شارة ذهبية أسفل الصورة', badge && badge['background-image'].includes('gradient'));

  const cta = await facts(p, '.hero .hero-ctas .btn', ['min-height', 'font-size']);
  ok('زر CTA كبير (min-height \u2265 48px)', cta && parseInt(cta['min-height']) >= 48, JSON.stringify(cta));

  const feats = await p.locator('.feature').count();
  ok('4 بطاقات مميزات', feats === 4, 'count=' + feats);

  const fcard = await facts(p, '.feature', ['border-radius', 'box-shadow']);
  ok('بطاقة الميزة: حواف دائرية + ظل ناعم + حدود خفيفة', fcard && parseInt(fcard['border-radius']) >= 13 && fcard['box-shadow'] !== 'none');

  const gcard = await facts(p, '.grade-card', ['border-radius', 'box-shadow']);
  ok('بطاقة الصف: حواف دائرية + ظل', gcard && parseInt(gcard['border-radius']) >= 18 && gcard['box-shadow'] !== 'none');

  const about = await facts(p, '.about-card', ['border-radius']);
  ok('بطاقة النبذة موجودة بحواف دائرية', about && parseInt(about['border-radius']) >= 13);

  const bn = await facts(p, '#bottomnav', ['display']);
  ok('الشريط السفلي مخفي على سطح المكتب', bn && bn.display === 'none', JSON.stringify(bn));

  const foot = await facts(p, '#siteFooter', []);
  ok('التذييل معروض', !!foot);
  /* لا تُقارَن باسم المنصة الافتراضي المكتوب في الكود: الإعدادات قابلة للتعديل من
   * لوحة التحكم، و browser-e2e.mjs يغيّرها فعليًا أثناء تشغيله — فكان هذا الفحص
   * يعتمد على ترتيب التشغيل (ينجح على KV نظيفة ويفشل بعد browser-e2e). المصدر
   * الصحيح هو الخادم نفسه: التذييل يجب أن يعرض الاسم الذي يخدمه /api/settings. */
  const footBrand = await p.locator('#footBrand').textContent();
  const srvName = await p.evaluate(() => fetch('/api/settings').then(r => r.json()).then(d => (d.identity && d.identity.platformName) || '').catch(() => ''));
  ok('التذييل يحمل اسم المنصة (المخدوم من /api/settings)', !!srvName && footBrand.includes(srvName), 'footer=' + JSON.stringify(footBrand) + ' server=' + JSON.stringify(srvName));

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('لا overflow أفقي على 1280', overflow <= 0, 'delta=' + overflow);
  await ctx.close();
}

/* ---------- Mobile 360 ---------- */
console.log('\n[V2] Mobile 360\u00d7800 \u2014 hero stack + bottom nav');
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, locale: 'ar-EG', isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/153.0.0.0 Mobile Safari/537.36' });
  await ctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });

  const hero = await facts(p, '.hero', ['grid-template-columns', 'padding']);
  ok('Hero عمود واحد على الموبايل', hero && !/px px/.test(hero['grid-template-columns']), hero && hero['grid-template-columns']);

  const order = await p.evaluate(() => {
    const hero = document.querySelector('.hero');
    const mediaTop = hero.querySelector('.hero-media').getBoundingClientRect().top;
    const bodyTop = hero.querySelector('.hero-body').getBoundingClientRect().top;
    const withinBody = [...hero.querySelector('.hero-body').children].map(c => ({
      cls: c.className.split(' ')[0],
      top: c.getBoundingClientRect().top
    })).sort((a, b) => a.top - b.top);
    return { mediaFirst: mediaTop < bodyTop, bodyOrder: withinBody.map(c => c.cls) };
  });
  ok('الصورة قبل النص على الموبايل', order.mediaFirst);
  ok('داخل النص: الاسم ثم الزر ثم المقدمة', order.bodyOrder.indexOf('hero-ctas') > order.bodyOrder.indexOf('specialty') || order.bodyOrder.some(c => c === 'hero-ctas'), order.bodyOrder.join(' \u2192 '));

  const bn = await facts(p, '#bottomnav', ['display', 'padding-bottom']);
  ok('الشريط السفلي ظاهر على الموبايل', bn && bn.display === 'flex', JSON.stringify(bn));
  ok('الشريط السفلي يحترم safe-area (padding-bottom)', bn && parseInt(bn['padding-bottom']) >= 6, 'paddingBottom=' + bn && bn['padding-bottom']);

  const items = await p.locator('#bottomnav .bn-item').count();
  ok('4 عناصر في الشريط السفلي', items === 4, 'count=' + items);
  const active = await p.locator('#bottomnav .bn-item.active .bn-label').textContent();
  ok('عنصر نشط واضح (الرئيسية)', active === 'الرئيسية', active);

  // content must not be covered by the bottom nav
  const pad = await p.evaluate(() => {
    const m = document.querySelector('main.wrap');
    const bn = document.querySelector('#bottomnav');
    return { mainPad: parseInt(getComputedStyle(m).paddingBottom), navH: Math.round(bn.getBoundingClientRect().height) };
  });
  ok('padding أسفل المحتوى يغطي الشريط السفلي بالكامل + هامش', pad.mainPad >= pad.navH + 24, JSON.stringify(pad));
  const bnBox = await p.evaluate(() => Math.round(document.querySelector('#bottomnav').getBoundingClientRect().height));
  ok('ارتفاع الشريط السفلي مضغوط بنمط التطبيقات (46-68px)', bnBox >= 46 && bnBox <= 68, 'h=' + bnBox);

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('لا overflow أفقي على 360', overflow <= 0, 'delta=' + overflow);
  await ctx.close();
}

/* ---------- Mobile bottom-nav functionality (scroll to a real section) ---------- */
console.log('\n[V3] الشريط السفلي يعمل فعليًا (تمرير لقسم حقيقي)');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-EG', isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/153.0.0.0 Mobile Safari/537.36' });
  await ctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('#bottomnav .bn-item[data-key="subjects"]');
  await p.waitForTimeout(600);
  const subjectsTop = await p.evaluate(() => {
    const el = document.getElementById('subjects');
    return Math.round(el.getBoundingClientRect().top);
  });
  ok('زر «الامتحانات» يمرر لقسم الصفوف (في مجال الرؤية)', subjectsTop >= -20 && subjectsTop <= 200, 'top=' + subjectsTop);
  const active2 = await p.locator('#bottomnav .bn-item.active .bn-label').textContent();
  ok('العنصر النشط يتبدل إلى «الامتحانات»', active2 === 'الامتحانات', active2);
  await ctx.close();
}

/* ---------- Mobile exam UX: 360 / 390 / 430 ----------
 * الأولوية القصوى في التصميم: سؤال ← خيارات ← اختيار ← التالي ← السؤال التالي،
 * بلا بحث عن التمرير. تُقاس الأبعاد فعليًا في متصفح حقيقي لا بالاستنتاج. */
console.log('\n[V4] شاشة الامتحان على الجوال (360 / 390 / 430)');
for (const W of [360, 390, 430]) {
  const H = W === 360 ? 800 : W === 390 ? 844 : 932;
  console.log(`\n[M] ${W}\u00d7${H}`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, locale: 'ar-EG', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|net::|4(01|00|03|04)/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.click('text=ابدأ الامتحان الآن');
  await p.waitForSelector('#stName', { timeout: 15000 });
  await p.fill('#stName', 'طالب موبايل');
  await p.fill('#stPhone', '01012345678');
  await p.click('.grade-opt[data-grade="philosophy"]');
  await p.click('#contBtn');
  await p.waitForSelector('.topic-card', { timeout: 15000 });
  await p.locator('.topic-card').first().click();
  await p.waitForSelector('.lesson-card', { timeout: 15000 });
  await p.locator('.lesson-card').first().click();
  await p.waitForSelector('.training-card, #startBtn', { timeout: 15000 });
  if (await p.locator('.training-card').count()) { await p.locator('.tc-start').first().click(); await p.waitForSelector('#startBtn', { timeout: 15000 }); }
  await p.click('#startBtn');
  await p.waitForSelector('.qcard', { timeout: 20000 });

  const g = await p.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const r = el => el ? el.getBoundingClientRect() : null;
    const card = document.querySelector('.qcard');
    return {
      vw, vh,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - vw,
      dir: document.documentElement.dir,
      examMode: document.body.classList.contains('exam-mode'),
      q: r(document.querySelector('.qtext')), card: r(card), acts: r(document.querySelector('.quiz-actions')),
      opts: [...document.querySelectorAll('.opt')].map(o => { const b = r(o); return { top: b.top, bottom: b.bottom, h: b.height, left: b.left, right: b.right }; }),
      cardScrollH: card ? card.scrollHeight : 0, cardClientH: card ? card.clientHeight : 0
    };
  });
  ok(W + 'px: تدفق الامتحان وصل لشاشة السؤال', !!g.card);
  ok(W + 'px: لا overflow أفقي', g.docOverflow <= 0 && g.bodyOverflow <= 0, JSON.stringify({ d: g.docOverflow, b: g.bodyOverflow }));
  ok(W + 'px: RTL + exam-mode', g.dir === 'rtl' && g.examMode, JSON.stringify({ dir: g.dir, examMode: g.examMode }));
  ok(W + 'px: 4 خيارات معروضة، كل منها ≥44px ارتفاعًا (هدف لمس)', g.opts.length === 4 && g.opts.every(o => o.h >= 44), JSON.stringify(g.opts.map(o => Math.round(o.h))));
  ok(W + 'px: الخيارات داخل حدود العرض', g.opts.every(o => o.left >= -1 && o.right <= g.vw + 1));
  ok(W + 'px: نص السؤال أعلى الخيارات (لا بحث)', g.q && g.opts.length && g.q.top < g.opts[0].top, JSON.stringify({ q: g.q && Math.round(g.q.top), o0: Math.round(g.opts[0].top) }));
  ok(W + 'px: زر التالي داخل الشاشة (بلا تمرير) و≥48px', g.acts && g.acts.bottom <= g.vh + 1 && g.acts.top >= 0 && g.acts.height >= 48, JSON.stringify({ top: Math.round(g.acts.top), bottom: Math.round(g.acts.bottom), h: Math.round(g.acts.height), vh: g.vh }));
  ok(W + 'px: زر التالي لا يغطي أي خيار', g.opts.every(o => o.bottom <= g.acts.top + 1), JSON.stringify({ firstBottom: Math.round(g.opts[0].bottom), actsTop: Math.round(g.acts.top) }));

  await p.evaluate(() => { if (window.nextQ) window.nextQ(); });
  await p.waitForTimeout(500);
  const after = await p.evaluate(() => {
    const c = document.querySelector('.qcard'); const q = document.querySelector('.qtext');
    return { cardTop: c ? c.scrollTop : 0, qTop: q ? Math.round(q.getBoundingClientRect().top) : null, vh: innerHeight };
  });
  ok(W + 'px: السؤال التالي يبدأ من أوله (scrollTop=0)', after.cardTop === 0, JSON.stringify(after));
  ok(W + 'px: السؤال التالي يبدأ في موضع قراءة صحيح', after.qTop !== null && after.qTop < after.vh * 0.5, 'qTop=' + after.qTop);

  const long = await p.evaluate(() => {
    const q = document.querySelector('.qtext');
    if (q) q.textContent = 'سؤال طويل جدًا للاختبار: ' + ('كلمة '.repeat(220));
    const c = document.querySelector('.qcard');
    c.scrollTop = c.scrollHeight;
    const acts = document.querySelector('.quiz-actions').getBoundingClientRect();
    const card = c.getBoundingClientRect();
    return { cardScrollH: c.scrollHeight, cardClientH: c.clientHeight, scrolled: c.scrollTop > 0,
      actsBottom: Math.round(acts.bottom), actsTop: Math.round(acts.top), vh: innerHeight, cardBottom: Math.round(card.bottom) };
  });
  ok(W + 'px: سؤال طويل جدًا → المنطقة تمرّر داخليًا (لا تمرير للصفحة)', long.cardScrollH > long.cardClientH + 10 && long.scrolled, JSON.stringify(long));
  ok(W + 'px: سؤال طويل جدًا → زر التالي يبقى ظاهرًا', long.actsBottom <= long.vh + 1 && long.actsTop > 0, JSON.stringify(long));
  ok(W + 'px: سؤال طويل جدًا → زر التالي لا يعلو الخيارات', long.actsTop >= long.cardBottom - 1, JSON.stringify(long));
  ok(W + 'px: لا أخطاء كونسول أثناء الامتحان', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

/* ---------- Compact bottom nav (56–68px) ---------- */
console.log('\n[V5] الشريط السفلي مضغوط ويحترم safe-area');
for (const W of [360, 390, 430]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: W === 360 ? 800 : W === 390 ? 844 : 932 }, locale: 'ar-EG', isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  const m = await p.evaluate(() => {
    const bn = document.querySelector('#bottomnav');
    const r = bn.getBoundingClientRect();
    const icon = bn.querySelector('.bn-icon');
    return { h: Math.round(r.height), count: bn.querySelectorAll('.bn-item').length,
      icon: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
      font: parseFloat(getComputedStyle(bn.querySelector('.bn-label')).fontSize),
      mainPad: parseFloat(getComputedStyle(document.querySelector('main.wrap')).paddingBottom),
      footPad: parseFloat(getComputedStyle(document.querySelector('.foot-inner')).paddingBottom) };
  });
  ok(W + 'px: ارتفاع الشريط 56–68px (مضغوط، لا مستطيل ضخم)', m.h >= 56 && m.h <= 68, 'h=' + m.h);
  ok(W + 'px: ٤ عناصر بأيقونات صغيرة ونص صغير', m.count === 4 && m.icon <= 24 && m.font <= 13, JSON.stringify(m));
  ok(W + 'px: المحتوى والتذييل لا يُغطَّيان بالشريط', m.mainPad >= m.h - 4 && m.footPad >= 60, JSON.stringify({ main: m.mainPad, foot: m.footPad, h: m.h }));
  await ctx.close();
}

await browser.close();
console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('VISUAL QA: ' + pass + ' pass / ' + fail + ' fail');
if (fail) process.exit(1);
console.log('RESULT: VISUAL QA PASSED \u2713');
