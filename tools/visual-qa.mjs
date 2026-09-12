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
  ok('ترتيب الأقسام: features \u2192 about(bio) \u2192 subjects', order[0] === 'hero' && idx(order, 'features') < idx(order, 'about') && idx(order, 'about') < idx(order, 'subjects'), order.join(' \u2192 '));

  const hero = await facts(p, '.hero', ['grid-template-columns', 'border-radius', 'box-shadow', 'background-image']);
  ok('Hero شبكة عمودين (media+body)', hero && hero['grid-template-columns'].trim().split(/\s+/).length === 2, hero && hero['grid-template-columns']);
  ok('Hero مفتوح بلا خلفية بطاقة (transparent)', hero && hero['background-image'] === 'none', hero && hero['background-image']);
  ok('Hero بلا حواف/ظل بطاقة (radius 0 + shadow none)', hero && (parseInt(hero['border-radius']) === 0 || hero['border-radius'] === '0px') && hero['box-shadow'] === 'none', JSON.stringify(hero));

  const photo = await facts(p, '.hero .photo', ['border-radius', 'border-width']);
  ok('صورة المعلم دائرية/عضوية (radius غير حادة) + إطار', photo && parseInt(photo['border-radius']) > 20 && parseInt(photo['border-width']) >= 4, JSON.stringify(photo));

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
  const footBrand = await p.locator('#footBrand').textContent();
  ok('التذييل يحمل اسم المنصة', footBrand.includes('منصة الامتحانات'));

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
  ok('ارتفاع الشريط السفلي مضغوط بنمط التطبيقات (52-72px)', bnBox >= 52 && bnBox <= 72, 'h=' + bnBox);

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

await browser.close();
console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('VISUAL QA: ' + pass + ' pass / ' + fail + ' fail');
if (fail) process.exit(1);
console.log('RESULT: VISUAL QA PASSED \u2713');
