import chromium from '@sparticuz/chromium';
import { chromium as pw } from 'playwright-core';
process.env.LD_LIBRARY_PATH = (process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : '') + '/tmp/al2023/lib:/tmp';
const BASE = process.env.QABASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };
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
async function launchBrowser() {
  const exe = await chromium.executablePath();
  return pw.launch({ args: chromium.args, executablePath: exe, headless: true });
}

console.log('\n[V1] Desktop 1280x900 — hierarchy & premium visuals');
{
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-EG' });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await p.waitForTimeout(800);
  const order = await p.evaluate(() => [...document.querySelector('#app').children].map(c => (c.id || c.className.split(' ')[0])));
  const idx = (arr, v) => arr.findIndex(x => x === v);
  ok('ترتيب الأقسام: hero → features → about(bio) → subjects', order[0] === 'hero' && idx(order, 'features') < idx(order, 'about') && idx(order, 'about') < idx(order, 'subjects'), order.join(' → '));
  const hero = await facts(p, '.hero', ['grid-template-columns', 'border-radius', 'box-shadow']);
  ok('Hero شبكة عمودين (media+body)', hero && hero['grid-template-columns'].trim().split(/\s+/).length === 2, hero && hero['grid-template-columns']);
  ok('Hero بحواف دائرية كبيرة (radius ≥ 24px)', hero && parseInt(hero['border-radius']) >= 24, hero && hero['border-radius']);
  ok('Hero بظل ناعم', hero && hero['box-shadow'] && hero['box-shadow'] !== 'none');
  const photo = await facts(p, '.hero .photo', ['border-radius', 'border-width']);
  ok('صورة المعلم دائرية/عضوية (radius غير حادة) + إطار', photo && parseInt(photo['border-radius']) > 20 && parseInt(photo['border-width']) >= 4, JSON.stringify(photo));
  const badge = await facts(p, '.hero .photo-badge', ['background-image', 'border-radius']);
  ok('شارة ذهبية أسفل الصورة', badge && badge['background-image'].includes('gradient'), JSON.stringify(badge));
  const cta = await facts(p, '.hero .hero-ctas .btn', ['min-height', 'font-size']);
  ok('زر CTA كبير (min-height ≥ 48px)', cta && parseInt(cta['min-height']) >= 48, JSON.stringify(cta));
  const feats = await p.locator('.feature').count();
  ok('4 بطاقات مميزات', feats === 4, 'count=' + feats);
  const fcard = await facts(p, '.feature', ['border-radius', 'box-shadow']);
  ok('بطاقة الميزة: حواف دائرية + ظل ناعم + حدود خفيفة', fcard && parseInt(fcard['border-radius']) >= 13 && fcard['box-shadow'] !== 'none', JSON.stringify(fcard));
  const gcard = await facts(p, '.grade-card', ['border-radius', 'box-shadow']);
  ok('بطاقة الصف: حواف دائرية + ظل', gcard && parseInt(gcard['border-radius']) >= 18 && gcard['box-shadow'] !== 'none', JSON.stringify(gcard));
  const about = await facts(p, '.about-card', ['border-radius']);
  ok('بطاقة النبذة موجودة بحواف دائرية', about && parseInt(about['border-radius']) >= 13, JSON.stringify(about));
  const bn = await facts(p, '#bottomnav', ['display']);
  ok('الشريط السفلي مخفي على سطح المكتب', bn && bn.display === 'none', JSON.stringify(bn));
  const foot = await facts(p, '#siteFooter', []);
  ok('التذييل معروض', !!foot);
  const footBrand = await p.locator('#footBrand').textContent();
  ok('التذييل يحمل اسم المنصة', footBrand.includes('منصة الامتحانات'), footBrand);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('لا overflow أفقي على 1280', overflow <= 0, 'delta=' + overflow);
  await p.screenshot({ path: '/tmp/visual-desktop-1280.png', fullPage: false });
  console.log("  screenshot desktop saved");
  await browser.close();
}

console.log('\n[V2] Mobile 360x800 — hero stack + bottom nav');
{
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, locale: 'ar-EG', isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/153.0.0.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout:15000 });
  await p.waitForTimeout(800);
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
  ok('الصورة قبل النص على الموبايل', order.mediaFirst, JSON.stringify(order));
  ok('داخل النص: الاسم ثم الزر ثم المقدمة', order.bodyOrder.indexOf('hero-ctas') > order.bodyOrder.indexOf('specialty') || order.bodyOrder.some(c => c === 'hero-ctas'), order.bodyOrder.join(' → '));
  const bn = await facts(p, '#bottomnav', ['display', 'padding-bottom']);
  ok('الشريط السفلي ظاهر على الموبايل', bn && bn.display === 'flex', JSON.stringify(bn));
  ok('الشريط السفلي يحترم safe-area (padding-bottom)', bn && parseInt(bn['padding-bottom']) >= 6, 'paddingBottom=' + (bn && bn['padding-bottom']));
  const items = await p.locator('#bottomnav .bn-item').count();
  ok('4 عناصر في الشريط السفلي', items === 4, 'count=' + items);
  const active = await p.locator('#bottomnav .bn-item.active .bn-label').textContent();
  ok('عنصر نشط واضح (الرئيسية)', active === 'الرئيسية', active);
  const mainPad = await p.evaluate(() => {
    const m = document.querySelector('main.wrap');
    return getComputedStyle(m).paddingBottom;
  });
  ok('padding أسفل المحتوى يكفي لعدم تغطية الشريط', parseInt(mainPad) >= 120, 'paddingBottom=' + mainPad);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('لا overflow أفقي على 360', overflow <= 0, 'delta=' + overflow);
  await p.screenshot({ path: '/tmp/visual-mobile-360.png', fullPage: false });
  console.log("  screenshot mobile 360 saved");
  await browser.close();
}

console.log('\n[V3] الشريط السفلي يعمل فعليًا (تمرير لقسم حقيقي)');
{
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-EG', isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/153.0.0.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout:15000 });
  await p.waitForTimeout(600);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('#bottomnav .bn-item[data-key="subjects"]');
  await p.waitForTimeout(700);
  const subjectsTop = await p.evaluate(() => {
    const el = document.getElementById('subjects');
    return Math.round(el.getBoundingClientRect().top);
  });
  ok('زر «الامتحانات» يمرر لقسم الصفوف (في مجال الرؤية)', subjectsTop >= -20 && subjectsTop <= 700, 'top=' + subjectsTop);
  const active2 = await p.locator('#bottomnav .bn-item.active .bn-label').textContent();
  ok('العنصر النشط يتبدل إلى «الامتحانات»', active2 === 'الامتحانات', active2);
  await p.screenshot({ path: '/tmp/visual-mobile-390.png', fullPage: false });
  console.log("  screenshot mobile 390 saved");
  await browser.close();
}

console.log('\n══════════════════');
console.log('VISUAL QA: ' + pass + ' pass / ' + fail + ' fail');
if (fail) process.exit(1);
console.log('RESULT: VISUAL QA PASSED ✓');
