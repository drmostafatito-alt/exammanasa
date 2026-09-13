/** round-visual.mjs — جولة الفحص البصري: لقطات حقيقية بمتصفح Chromium فعلي
 * يلتقط صفحات المنصة (رئيسية/معلم/مواد/امتحان/نتيجة/إدارة/معلم) على مصفوفة
 * العرض الكاملة، بخط عربي مدمج (Noto Sans Arabic عبر fontsource) لأن Google
 * Fonts محجوبة في بيئة الاختبار — الحقن للقطات التدقيق فقط ولا يمس الإنتاج.
 *
 * التشغيل: node tools/round-visual.mjs [home|student|panels|all]
 * يتطلب: خادم wrangler يعمل على QABASE + /tmp/chromium + /tmp/chrm + /tmp/crlibs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium as pw } from 'playwright-core';
import { launchQaBrowser } from './qa-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.QABASE || 'http://127.0.0.1:8787';
const SHOTS = path.join(__dirname, 'shots', 'round');
fs.mkdirSync(SHOTS, { recursive: true });
const MODE = process.argv[2] || 'all';

/* ---- خط التدقيق: Noto Sans Arabic مدمج base64 (400/700/800) ---- */
function fontCss() {
  const dir = path.join(ROOT, 'cloudflare', 'node_modules', '@fontsource', 'noto-sans-arabic', 'files');
  const faces = [[400, '400'], [700, '700'], [800, '800']].map(([w, f]) => {
    const p = path.join(dir, `noto-sans-arabic-arabic-${f}-normal.woff2`);
    if (!fs.existsSync(p)) return '';
    const b64 = fs.readFileSync(p).toString('base64');
    return `@font-face{font-family:'AuditArabic';font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  }).join('\n');
  return faces + `
    body, button, input, select, textarea, .btn, .tab { font-family:'AuditArabic','Tajawal','Segoe UI',Tahoma,sans-serif !important; }
    .hero-doodle, .quote-item blockquote { font-family:'AuditArabic','Tajawal',serif !important; }
    .reveal { transition-duration: .01ms !important; }`;
}
const FONT_CSS = fontCss();

const browser = await launchQaBrowser(pw);

/* حقن خط التدقيق في كل تحميل (addStyleTag لا يبقى بعد التنقل — لذا initScript) */
async function mkCtx(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(css => {
    const st = document.createElement('style');
    st.setAttribute('data-qa-font', '1');
    st.textContent = css;
    const root = document.head || document.documentElement;
    if (root) root.appendChild(st);
    else document.addEventListener('DOMContentLoaded', () => (document.head || document.documentElement).appendChild(st), { once: true });
  }, FONT_CSS);
  return ctx;
}

const consoleIssues = [];
const networkLog = [];
async function newPage(ctx) {
  const pg = await ctx.newPage();
  await pg.addStyleTag({ content: FONT_CSS }).catch(() => {});
  pg.on('console', m => { if (m.type() === 'error') { const t = m.text() || ''; if (!/fonts\.(googleapis|gstatic)|net::|ERR_|Failed to load resource.*4(01|00|03|04|29)/.test(t)) consoleIssues.push(`[${pg.url().slice(0, 70)}] ${t.slice(0, 170)}`); } });
  pg.on('pageerror', e => consoleIssues.push(`pageerror [${pg.url().slice(0, 70)}] ${String(e && e.message).slice(0, 170)}`));
  pg.on('response', async r => {
    try { const u = r.url(); if (u.includes('/api/')) networkLog.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`); } catch {}
  });
  return pg;
}
async function readyFonts(pg) { try { await pg.evaluate(() => document.fonts && document.fonts.ready); } catch {} }
async function settle(pg, ms = 900) { await pg.waitForTimeout(ms); await readyFonts(pg); }
/* تمرير حقيقي من أعلى لأسفل (تفعيل reveal + رصد أي قفزات) ثم عودة للأعلى */
async function scrollThrough(pg) {
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(250);
  const h = await pg.evaluate(() => document.documentElement.scrollHeight);
  const vh = await pg.evaluate(() => window.innerHeight);
  for (let y = vh / 2; y < h; y += Math.max(200, vh / 2)) { await pg.evaluate(yy => window.scrollTo(0, yy), y); await pg.waitForTimeout(120); }
  await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pg.waitForTimeout(400);
}
async function geom(pg) {
  return pg.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    dir: document.documentElement.dir, h: document.documentElement.scrollHeight, vh: window.innerHeight
  }));
}
async function shot(pg, name, full = false) {
  await pg.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
  console.log(`    [shot] ${name}.png`);
}

const DESKTOP = [[1280, 720], [1366, 768], [1440, 900], [1920, 1080]];
const MOBILE = [[360, 800], [390, 844], [430, 932]];
const TABLET = [[768, 1024], [834, 1112], [1024, 768]];

function ua(mobile) { return mobile ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' : undefined; }

/* ================= HOME + TEACHER PAGES ================= */
async function captureHome() {
  console.log('\n[HOME] public pages matrix');
  for (const [W, H] of [...DESKTOP, ...TABLET, ...MOBILE]) {
    const mobile = W <= 500;
    const ctx = await mkCtx({ viewport: { width: W, height: H }, locale: 'ar-EG', isMobile: mobile, hasTouch: mobile, userAgent: ua(mobile) });
    await ctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
    const pg = await newPage(ctx);
    // / — default owner (monogram, no socials)
    await pg.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await settle(pg);
    const g0 = await geom(pg);
    console.log(`  / @${W}x${H}: overflow=${g0.sw - g0.cw} dir=${g0.dir} h=${g0.h}`);
    await shot(pg, `home-${W}-top`);
    await scrollThrough(pg);
    // section close-ups on one desktop + one mobile size
    if (W === 1440 || W === 390) {
      for (const sec of ['subjects', 'features', 'about']) {
        const el = pg.locator(`#${sec}`);
        if (await el.count()) { await el.scrollIntoViewIfNeeded(); await pg.waitForTimeout(500); await shot(pg, `home-${W}-${sec}`); }
      }
      await pg.evaluate(() => document.querySelector('.cta-band').scrollIntoView({ block: 'center' }));
      await pg.waitForTimeout(500); await shot(pg, `home-${W}-ctaband`);
      await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await pg.waitForTimeout(500); await shot(pg, `home-${W}-footer`);
    }
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.waitForTimeout(300);
    await shot(pg, `home-${W}-full`, true);
    // /ahmed — transparent PNG + bio + 4 socials
    await pg.goto(`${BASE}/ahmed`, { waitUntil: 'networkidle' });
    await settle(pg);
    await shot(pg, `ahmed-${W}-top`);
    if (W === 1440 || W === 390) {
      await scrollThrough(pg);
      await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await pg.waitForTimeout(400); await shot(pg, `ahmed-${W}-footer`);
      await pg.evaluate(() => window.scrollTo(0, 0)); await pg.waitForTimeout(300);
      await shot(pg, `ahmed-${W}-full`, true);
    }
    // /mohamed — JPEG cover + 1 social
    await pg.goto(`${BASE}/mohamed`, { waitUntil: 'networkidle' });
    await settle(pg);
    await shot(pg, `mohamed-${W}-top`);
    // invalid slug
    await pg.goto(`${BASE}/ghost-teacher-xyz`, { waitUntil: 'networkidle' });
    await settle(pg, 500);
    if (W === 1440 || W === 390) await shot(pg, `ghost-${W}`);
    // subject browsing pages (desktop 1440 + mobile 390)
    if (W === 1440 || W === 390) {
      await pg.goto(`${BASE}/ahmed#/s/philosophy/1`, { waitUntil: 'networkidle' });
      await settle(pg); await shot(pg, `philo-t1-${W}`);
      await pg.goto(`${BASE}/ahmed#/s/psychology`, { waitUntil: 'networkidle' });
      await settle(pg); await shot(pg, `psy-${W}`);
      await pg.goto(`${BASE}/ahmed#/start`, { waitUntil: 'networkidle' });
      await settle(pg); await shot(pg, `start-${W}`);
    }
    await ctx.close();
  }
}

/* ================= STUDENT EXAM FLOW ================= */
async function studentFlow(W, H, tag) {
  const mobile = W <= 500;
  const ctx = await mkCtx({ viewport: { width: W, height: H }, locale: 'ar-EG', isMobile: mobile, hasTouch: mobile, userAgent: ua(mobile) });
  await ctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
  const pg = await newPage(ctx);
  console.log(`\n[STUDENT] full flow @${W}x${H}`);
  await pg.goto(`${BASE}/ahmed`, { waitUntil: 'networkidle' });
  await settle(pg);
  await pg.click('text=ابدأ الامتحان الآن');
  await pg.waitForSelector('#stName');
  await pg.fill('#stName', 'طالب الفحص البصري');
  await pg.fill('#stPhone', '01012345678');
  await pg.click('.grade-opt[data-grade="philosophy"]');
  await pg.click('#contBtn');
  await pg.waitForSelector('.topic-card');
  await shot(pg, `flow-${tag}-term`);
  await pg.locator('.topic-card').first().click();
  await pg.waitForSelector('.lesson-card');
  await shot(pg, `flow-${tag}-topic`);
  await pg.locator('.lesson-card').first().click();
  await pg.waitForSelector('.training-card, #startBtn');
  if (await pg.locator('.training-card').count()) { await shot(pg, `flow-${tag}-lesson`); await pg.locator('.tc-start').first().click(); await pg.waitForSelector('#startBtn'); }
  await shot(pg, `flow-${tag}-examinfo`);
  const startRespP = pg.waitForResponse(r => r.url().includes('/api/exam/start') && r.status() === 200, { timeout: 20000 });
  await pg.click('#startBtn');
  const startBody = await (await startRespP).text();
  await pg.waitForSelector('.qcard');
  await settle(pg, 600);
  await shot(pg, `flow-${tag}-q1`);
  const totalQ = await pg.evaluate(() => window.S.session.questions.length);
  // long-question stress on Q1 view
  await pg.evaluate(() => {
    const q = document.querySelector('.qtext');
    if (q) { const qn = q.querySelector('.qn'); q.textContent = 'سؤال طويل جدًا لاختبار التمرير الداخلي والحدود: ' + 'ما الحكم الفلسفي الدقيق الذي يترتب على التسليم بمقدمات القياس الأرسطي في صورته الكاملة مع مراعاة قواعد الاستغراق والكيف والكم في الحدود والنتائج؟ '.repeat(6); if (qn) q.prepend(qn); }
    const o = document.querySelectorAll('.opt .txt')[1];
    if (o) o.textContent = 'خيار طويل جدًا يختبر التفاف النص داخل زر الاختيار وعدم كسر التخطيط أو تجاوز الحدود: ' + 'نص إضافي مكرر للاختبار '.repeat(10);
  });
  await pg.waitForTimeout(400);
  await shot(pg, `flow-${tag}-qlong`);
  // scroll inside qcard to bottom, verify Next still visible (geometry logged)
  const longG = await pg.evaluate(() => {
    const c = document.querySelector('.qcard'); if (c) c.scrollTop = c.scrollHeight;
    const acts = document.querySelector('.quiz-actions').getBoundingClientRect();
    return { actsTop: Math.round(acts.top), actsBottom: Math.round(acts.bottom), vh: innerHeight, cardScroll: c ? c.scrollTop : -1 };
  });
  console.log(`  long-q geometry:`, JSON.stringify(longG));
  await pg.reload(); // reload loses session → home (expected guard); restart quickly
  await pg.waitForSelector('.hero', { timeout: 15000 }).catch(() => {});
  // restart exam fresh for the answer loop
  await pg.goto(`${BASE}/ahmed#/e/T1-PH-01`, { waitUntil: 'networkidle' });
  await settle(pg);
  if (await pg.locator('#stuFields:not(.hidden) #stName').count()) await pg.fill('#stName', 'طالب الفحص البصري');
  const startRespP2 = pg.waitForResponse(r => r.url().includes('/api/exam/start') && r.status() === 200, { timeout: 20000 });
  await pg.click('#startBtn');
  await startRespP2;
  await pg.waitForSelector('.qcard');
  // Next→Next→Next navigation + scroll reset check
  for (let i = 0; i < 3; i++) {
    await pg.click('.opts .opt >> nth=0');
    await pg.waitForTimeout(120);
    await pg.evaluate(() => { const c = document.querySelector('.qcard'); if (c) c.scrollTop = 9999; window.scrollTo(0, 9999); });
    await pg.click('button:has-text("السؤال التالي")');
    await pg.waitForTimeout(350);
  }
  const navG = await pg.evaluate(() => ({ cardTop: document.querySelector('.qcard') ? document.querySelector('.qcard').scrollTop : -1, winY: window.scrollY, cur: window.S.current }));
  console.log(`  nav-after-3-next:`, JSON.stringify(navG));
  await shot(pg, `flow-${tag}-q4`);
  // keyboard: arrows + digits
  await pg.keyboard.press('1');
  await pg.waitForTimeout(150);
  const kbSel = await pg.evaluate(() => window.S.answers[window.S.current]);
  console.log(`  keyboard digit selects: answers[current]=${kbSel}`);
  await pg.keyboard.press('ArrowLeft'); // next in RTL
  await pg.waitForTimeout(300);
  console.log(`  ArrowLeft → current=${await pg.evaluate(() => window.S.current)}`);
  await pg.keyboard.press('ArrowRight');
  await pg.waitForTimeout(300);
  console.log(`  ArrowRight → current=${await pg.evaluate(() => window.S.current)}`);
  // finish all
  const total = await pg.evaluate(() => window.S.session.questions.length);
  for (let i = 0; i < total; i++) {
    await pg.evaluate(ii => window.jumpQ(ii), i);
    await pg.waitForTimeout(30);
    await pg.evaluate(() => { const o = document.querySelectorAll('.opt')[window.S.current % 4]; if (o) o.click(); });
    await pg.waitForTimeout(30);
  }
  await pg.evaluate(() => window.jumpQ(window.S.session.questions.length - 1));
  await pg.waitForTimeout(200);
  await pg.click('button:has-text("مراجعة وتسليم")');
  await pg.waitForSelector('#submitBtn:not([disabled])', { timeout: 10000 });
  await shot(pg, `flow-${tag}-review`);
  // double-click submit
  const submitRespP = pg.waitForResponse(r => r.url().includes('/api/exam/submit'), { timeout: 20000 });
  await pg.click('#submitBtn');
  await pg.click('#submitBtn', { force: true }).catch(() => {});
  const submitResp = await submitRespP;
  console.log(`  submit status: ${submitResp.status()}`);
  await pg.waitForSelector('.score-ring', { timeout: 15000 });
  await settle(pg, 600);
  await shot(pg, `flow-${tag}-result`);
  // result filters
  await pg.click('button:has-text("إجابات خاطئة")');
  await pg.waitForTimeout(400);
  await shot(pg, `flow-${tag}-result-wrong`);
  await pg.click('button:has-text("امتحانات أخرى")');
  await pg.waitForTimeout(600);
  console.log(`  back-to: ${pg.url()}`);
  // incomplete-submit guard via review (new exam, answer 1 only)
  await pg.goto(`${BASE}/ahmed#/e/U1-T1`, { waitUntil: 'networkidle' });
  await settle(pg);
  if (await pg.locator('#stuFields:not(.hidden) #stName').count()) {
    await pg.fill('#stName', 'طالب ناقص');
    await pg.fill('#stPhone', '01099999999');
  }
  await pg.click('#startBtn');
  await pg.waitForSelector('.qcard', { timeout: 15000 });
  await pg.click('.opts .opt >> nth=1');
  await pg.evaluate(() => window.jumpQ(window.S.session.questions.length - 1));
  await pg.waitForTimeout(200);
  await pg.click('button:has-text("مراجعة وتسليم")');
  await pg.waitForSelector('#submitBtn[disabled]', { timeout: 8000 });
  await shot(pg, `flow-${tag}-review-incomplete`);
  const dis = await pg.locator('#submitBtn').isDisabled();
  console.log(`  incomplete submit disabled: ${dis}`);
  await ctx.close();
  return { startBody };
}

/* ================= ADMIN + TEACHER PANELS ================= */
async function capturePanels() {
  console.log('\n[PANELS] admin + teacher');
  const ADMIN = { email: 'visual@audit.local', pass: 'Visual#Audit9' };
  for (const [W, H] of [[1440, 900], [390, 844]]) {
    const mobile = W <= 500;
    const tag = `${W}`;
    const ctx = await mkCtx({ viewport: { width: W, height: H }, locale: 'ar-EG', isMobile: mobile, hasTouch: mobile, userAgent: ua(mobile) });
    await ctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
    const pg = await newPage(ctx);
    // admin login
    await pg.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await settle(pg);
    await shot(pg, `admin-${tag}-login`);
    await pg.fill('#admEmail', ADMIN.email);
    await pg.fill('#admPass', ADMIN.pass);
    await pg.click('button:has-text("دخول")');
    await pg.waitForSelector('.a-sidebar', { timeout: 12000 });
    await settle(pg);
    await shot(pg, `admin-${tag}-dash`);
    // teachers
    await pg.click('.a-nav-item:has-text("المعلمون")');
    await pg.waitForSelector('.teacher-card', { timeout: 10000 });
    await settle(pg, 500);
    await shot(pg, `admin-${tag}-teachers`);
    // add-teacher modal
    await pg.click('button:has-text("+ إضافة معلم جديد")');
    await pg.waitForSelector('#tName', { timeout: 8000 });
    await pg.fill('#tName', 'أ. تجربة مشاهدة');
    await settle(pg, 400);
    await shot(pg, `admin-${tag}-teacher-add`);
    // validation: empty name → inline error, form stays open
    await pg.fill('#tName', '');
    await pg.click('#tSave');
    await pg.waitForTimeout(500);
    const tErr = await pg.locator('#tErr').textContent().catch(() => '');
    console.log(`  teacher-add validation err: "${(tErr || '').trim()}"`);
    await shot(pg, `admin-${tag}-teacher-add-err`);
    await pg.locator('.tform-bg .close').click();
    await pg.waitForTimeout(300);
    // cleanup stray teacher from earlier probe run (if any)
    await pg.evaluate(async () => {
      const l = await fetch('/api/admin/teachers', { headers: { 'X-Requested-With': 'fetch' } }).then(r => r.json());
      const hit = (l.teachers || []).find(t => t.name === 'أ. تجربة مشاهدة');
      if (hit) await fetch('/api/admin/teachers/' + hit.id, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch' } });
    });
    // edit teacher modal (ahmed)
    await pg.locator('.teacher-card', { hasText: 'أحمد عبدالله' }).first().locator('button:has-text("تعديل")').click();
    await pg.waitForSelector('#tName', { timeout: 8000 });
    await settle(pg, 400);
    await shot(pg, `admin-${tag}-teacher-edit`);
    await pg.locator('.tform-bg .close').click();
    await pg.waitForTimeout(300);
    // question bank
    await pg.click('.a-nav-item:has-text("بنك الأسئلة")');
    await pg.waitForSelector('#bankList .cms-q', { timeout: 15000 });
    await settle(pg, 600);
    await shot(pg, `admin-${tag}-bank`);
    // bank search
    const searchBox = pg.locator('.filters input[type="search"], .filters input').first();
    if (await searchBox.count()) { await searchBox.fill('المنطق'); await pg.waitForTimeout(900); await shot(pg, `admin-${tag}-bank-search`); await searchBox.fill(''); await pg.waitForTimeout(600); }
    // question editor modal
    await pg.locator('#bankList .cms-q').first().locator('.ibtn, button').first().click();
    await pg.waitForTimeout(700);
    await shot(pg, `admin-${tag}-bank-edit`);
    const qesc = pg.locator('.modal-bg .acts .btn.ghost').first();
    if (await qesc.count()) await qesc.click(); else await pg.keyboard.press('Escape');
    await pg.waitForTimeout(300);
    // exams list + editor
    await pg.click('.a-nav-item:has-text("الامتحانات")');
    await pg.waitForSelector('.cms-exrow', { timeout: 15000 });
    await settle(pg, 500);
    await shot(pg, `admin-${tag}-exams`);
    await pg.locator('.cms-exrow').first().locator('.ibtn, .btn, button').first().click();
    await pg.waitForTimeout(900);
    await shot(pg, `admin-${tag}-exam-editor`);
    // results
    await pg.click('.a-nav-item:has-text("النتائج")');
    await pg.waitForFunction(() => document.querySelector('#resTbl') || /لا توجد نتائج محفوظة/.test(document.body.innerText), null, { timeout: 15000 });
    await settle(pg, 500);
    await shot(pg, `admin-${tag}-results`);
    // settings tabs
    await pg.click('.a-nav-item:has-text("الإعدادات")');
    await pg.waitForSelector('.st-tabs', { timeout: 10000 });
    const tabs = await pg.locator('.st-tabs .tab').all();
    for (let i = 0; i < tabs.length; i++) {
      await tabs[i].click();
      await pg.waitForTimeout(500);
      const label = (await tabs[i].innerText()).replace(/\s+/g, '_').slice(0, 18);
      await shot(pg, `admin-${tag}-st-${i}-${label}`);
    }
    // overview tabs (psychology/philosophy)
    await pg.click('.a-nav-item:has-text("نظرة عامة")');
    await pg.waitForTimeout(600);
    await shot(pg, `admin-${tag}-overview`);
    await ctx.close();

    // teacher panel
    const tctx = await mkCtx({ viewport: { width: W, height: H }, locale: 'ar-EG', isMobile: mobile, hasTouch: mobile, userAgent: ua(mobile) });
    await tctx.route(/\.(js|css)(\?.*)?$/, r => r.continue({ headers: { ...r.request().headers(), 'Cache-Control': 'no-cache' } }));
    const tp = await newPage(tctx);
    await tp.goto(`${BASE}/teacher`, { waitUntil: 'networkidle' });
    await settle(tp);
    await shot(tp, `teacher-${tag}-login`);
    // bad login first
    await tp.fill('#tEmail', 'ahmed@audit.local');
    await tp.fill('#tPass', 'Wrong#0000');
    await tp.click('#loginBtn');
    await tp.waitForSelector('#loginErr:not(:empty)', { timeout: 8000 });
    await shot(tp, `teacher-${tag}-login-err`);
    await tp.fill('#tPass', 'Ahmed#Pass11');
    await tp.click('#loginBtn');
    await tp.waitForSelector('#teacherName', { timeout: 12000 });
    await tp.waitForSelector('.t-stat-grid', { timeout: 10000 });
    await settle(tp, 500);
    await shot(tp, `teacher-${tag}-dash`);
    for (const tab of ['students', 'results', 'profile']) {
      await tp.click(`.t-nav-item[data-tab="${tab}"]`);
      await tp.waitForTimeout(700);
      await shot(tp, `teacher-${tag}-${tab}`);
    }
    // password tab
    await tp.click('.t-nav-item[data-tab="settings"]');
    await tp.waitForTimeout(600);
    await shot(tp, `teacher-${tag}-settings`);
    await tctx.close();
  }
}

try {
  if (MODE === 'home' || MODE === 'all') await captureHome();
  if (MODE === 'student' || MODE === 'all') {
    const r1 = await studentFlow(1440, 900, 'd1440');
    const leak = /"answer"|correctAnswer|correct_answer|correct_option|isCorrect|answerKey/.test(r1.startBody);
    console.log(`  start-response leak check: ${leak ? 'LEAK!' : 'clean'}`);
    await studentFlow(390, 844, 'm390');
  }
  if (MODE === 'panels' || MODE === 'all') await capturePanels();
  console.log('\n[console] issues:', consoleIssues.length);
  consoleIssues.slice(0, 12).forEach(i => console.log('   !', i));
  const dupes = {};
  networkLog.forEach(l => { dupes[l] = (dupes[l] || 0) + 1; });
  const repeated = Object.entries(dupes).filter(([, n]) => n > 6);
  console.log('[network] total api calls:', networkLog.length, '| repeated>6:', repeated.length);
  repeated.slice(0, 8).forEach(([l, n]) => console.log(`   ${n}x ${l}`));
} finally {
  await browser.close();
}
console.log('\nDONE — shots in tools/shots/round/');
