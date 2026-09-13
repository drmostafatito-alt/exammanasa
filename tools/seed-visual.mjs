/** seed-visual.mjs — تجهيز بيانات الفحص البصري على خادم QA المحلي.
 *  admin: visual@audit.local / Visual#Audit9
 *  teachers: /ahmed (PNG شفافة + نبذة + 4 سوشيال) /mohamed (JPEG + سوشيال واحد) /noha (بلا صورة) + معلم معطّل
 *  التشغيل: node tools/seed-visual.mjs [BASE]
 *  (أداة QA محلية فقط — لا تمس الإنتاج ولا تُضمَّن في الاختبارات.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || process.env.QABASE || 'http://127.0.0.1:8787';
const A = path.join(ROOT, 'tools', 'audit-assets');

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
let cookie = '';
async function req(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { ...H, ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
}

function dataUri(f) {
  const b = fs.readFileSync(path.join(A, f));
  const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${b.toString('base64')}`;
}

// 1. admin setup/login (idempotent)
const st = await req('/api/admin/status');
console.log('admin status:', st.status, JSON.stringify(st.data));
if (st.data && st.data.setup) {
  const s = await req('/api/admin/setup', { method: 'POST', body: JSON.stringify({ email: 'visual@audit.local', password: 'Visual#Audit9' }) });
  console.log('setup:', s.status, s.text.slice(0, 120));
}
const login = await req('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: 'visual@audit.local', password: 'Visual#Audit9' }) });
console.log('admin login:', login.status);
if (login.status !== 200) { console.error('ADMIN LOGIN FAILED', login.text.slice(0, 200)); process.exit(1); }

// 2. teachers
const png = dataUri('teacher-cutout.png'); // PNG شفافة حقيقية (alpha فعلي)
const jpg = dataUri('portrait.jpg');
console.log('photo sizes:', png.length, jpg.length);
const teachers = [
  { name: 'أ. أحمد عبدالله', slug: 'ahmed', email: 'ahmed@audit.local', username: 'ahmed', password: 'Ahmed#Pass11', phone: '01012345678', specialty: 'مدرس الفلسفة والمنطق — خبرة 15 عامًا', bio: 'مدرس الفلسفة والمنطق للمرحلة الثانوية بخبرة تتجاوز خمسة عشر عامًا، أؤمن بأن الفلسفة ليست حفظًا بل تدريب على التفكير. صممت هذه المنصة لتجعل التدريب على الامتحانات متعة يومية: امتحانات قصيرة مركزة، تصحيح فوري، ومراجعة ذكية للأخطاء حتى تتقن كل درس قبل الانتقال لما بعده.', photo: png, photoFit: '', socialLinks: { whatsapp: 'https://wa.me/201012345678', facebook: 'https://facebook.com/ahmed.teacher', youtube: 'https://youtube.com/@ahmed-teacher', tiktok: 'https://tiktok.com/@ahmed.teacher' } },
  { name: 'أ. محمد السيد', slug: 'mohamed', email: 'mohamed@audit.local', username: 'mohamed', password: 'Mohamed#Pass22', phone: '01123456789', specialty: 'مدرس علم النفس', bio: 'مدرس علم النفس للصف الثاني الثانوي — تبسيط المفاهيم النفسية بأمثلة من الحياة اليومية.', photo: jpg, photoFit: 'cover', socialLinks: { whatsapp: 'https://wa.me/201123456789' } },
  { name: 'أ. نهى كمال', slug: 'noha', email: 'noha@audit.local', username: 'noha', password: 'Noha#Pass33', phone: '01223456789', specialty: 'مدرسة الفلسفة', bio: 'مدرسة الفلسفة والمنطق — أسلوب مبسط وخرائط ذهنية لكل وحدة.' },
  { name: 'أ. معلم معطل', slug: 'disabled-t', email: 'disabled@audit.local', username: 'disabled-t', password: 'Disabled#0000', enabled: false },
];
const existing = await req('/api/admin/teachers');
const have = new Set((existing.data.teachers || []).map(t => t.slug));
for (const t of teachers) {
  if (have.has(t.slug)) { console.log('skip (exists):', t.slug); continue; }
  const r = await req('/api/admin/teachers', { method: 'POST', body: JSON.stringify(t) });
  console.log('create', t.slug, '→', r.status, r.status !== 200 ? r.text.slice(0, 160) : ('id=' + (r.data.teacher && r.data.teacher.id)));
}
console.log('SEED DONE');
