/* build-art.mjs — إعادة توليد لوحات الفلاسفة/الأكاديميا في cloudflare/public/art/.
 *
 * المسار: tools/artwork-src/*.png (نقوش أكاديمية تحريرية مولّدة، أحادية اللون)
 *        ← قصّ الهوامش البيضاء ← تعتيب ← تتبّع متجهي (potrace)
 *        ← SVG أحادي اللون بقناع تلاشي شعاعي (نفس نظام الأقنعة الحالي).
 *
 * ⚠️ أداة تطوير فقط (لا تُستخدم في التشغيل): تحتاج حزمتين محليًا
 *      npm i --no-save sharp potrace
 *    الملفات المولّدة ملتزمة في المستودع، لذا لا حاجة للأدوات لتشغيل المنصة.
 *
 * ثوابت لا تُمس: أسماء الملفات + viewBox لكل أصل (CSS يُقاس عليها) —
 * سقراط/أفلاطون/أرسطو/ماركس 400×480، الأعمدة 960×320، الكتاب 480×360، المنطق 480×320.
 * صورة المعلم وبياناته وبيانات الأسئلة/الامتحانات خارج نطاق هذه الأداة تمامًا.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'tools', 'artwork-src');
const DST = path.join(ROOT, 'cloudflare', 'public', 'art');

let sharp, potrace;
try {
  sharp = (await import('sharp')).default;
  potrace = (await import('potrace')).default;
} catch {
  console.error('build-art: تحتاج الحزمتين محليًا — npm i --no-save sharp potrace');
  process.exit(1);
}

/* viewBox مطابق للأصول السابقة 1:1 حتى لا يتغير أي قياس في CSS */
const ASSETS = [
  { name: 'socrates', vw: 400, vh: 480, fade: 'radial', long: 820 },
  { name: 'plato', vw: 400, vh: 480, fade: 'radial', long: 820 },
  { name: 'aristotle', vw: 400, vh: 480, fade: 'radial', long: 820 },
  { name: 'marx', vw: 400, vh: 480, fade: 'radial', long: 820 },
  { name: 'columns', vw: 960, vh: 320, fade: 'vertical', long: 1100 },
  { name: 'open-book', vw: 480, vh: 360, fade: 'radial', long: 820 },
  { name: 'logic', vw: 480, vh: 320, fade: 'radial', long: 800 },
];

const traceP = (buf, params) => new Promise((res, rej) => potrace.trace(buf, params, (e, svg) => e ? rej(e) : res(svg)));
const round0 = d => d.replace(/-?\d+\.\d+/g, m => Math.round(parseFloat(m)).toString());

for (const a of ASSETS) {
  const src = path.join(SRC, a.name + '.png');
  /* قصّ الهوامش البيضاء حتى يُعرِّف جسم اللوحة نسبة الأبعاد */
  const trimmed = await sharp(src)
    .greyscale()
    .flatten({ background: '#ffffff' })
    .trim({ threshold: 42 })
    .png()
    .toBuffer();
  const meta = await sharp(trimmed).metadata();
  const scale = a.long / Math.max(meta.width, meta.height);
  const w = Math.round(meta.width * scale), h = Math.round(meta.height * scale);
  const buf = await sharp(trimmed)
    .resize(w, h, { fit: 'fill' })
    .threshold(150)
    .png()
    .toBuffer();

  const svg = await traceP(buf, {
    threshold: 128,
    turdsize: 11,         // إسقاط ذرات الورق/التنقيط
    turnpolicy: 'minority',
    alphamax: 1.0,
    optcurve: true,
    opttolerance: 0.7,    // منحنيات أنعم ومسار أخف
    fillMode: 'black',
  });

  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => round0(m[1]));
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
  const vbn = vb ? vb.split(/\s+/).map(Number) : [0, 0, w, h];
  const sw = vbn[2] || w, sh = vbn[3] || h;

  /* احتواء داخل صندوق الهدف مع هامش تنفّس بسيط */
  const pad = 0.045;
  const s = Math.min((a.vw * (1 - pad * 2)) / sw, (a.vh * (1 - pad * 2)) / sh);
  const tx = (a.vw - sw * s) / 2;
  const ty = (a.vh - sh * s) / 2;

  const cx = a.vw / 2, cy = a.vh * 0.47, r = Math.max(a.vw, a.vh) * 0.8;
  const fadeDefs = a.fade === 'vertical'
    ? `<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="${a.vw / 2}" y1="0" x2="${a.vw / 2}" y2="${a.vh}">
      <stop offset="0" stop-color="#fff" stop-opacity=".97"/>
      <stop offset=".55" stop-color="#fff" stop-opacity=".82"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".3"/>
    </linearGradient>`
    : `<radialGradient id="fade" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">
      <stop offset="0" stop-color="#fff"/>
      <stop offset=".6" stop-color="#fff" stop-opacity=".94"/>
      <stop offset=".87" stop-color="#fff" stop-opacity=".5"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>`;

  /* القناع الخارجي على مجموعة بلا transform: إحداثيات القناع = إحداثيات viewBox */
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${a.vw} ${a.vh}" fill="none">
  <!-- ${a.name}: نقش أكاديمي تحريري (premium academic editorial engraving) مُتتبَّع إلى متجه — قناع ألفا -->
  <defs>
    ${fadeDefs}
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${a.vw}" height="${a.vh}">
      <rect width="${a.vw}" height="${a.vh}" fill="url(#fade)"/>
    </mask>
  </defs>
  <g mask="url(#m)" fill="#fff" fill-rule="evenodd">
    <g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${s.toFixed(4)})">
    ${paths.map(d => `<path d="${d}"/>`).join('\n    ')}
    </g>
  </g>
</svg>
`;
  fs.writeFileSync(path.join(DST, a.name + '.svg'), out);
  console.log(`${a.name}.svg  paths=${paths.length}  src=${sw}x${sh}  scale=${s.toFixed(3)}  bytes=${Buffer.byteLength(out)}`);
}
