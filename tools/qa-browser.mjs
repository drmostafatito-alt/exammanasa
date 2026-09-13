/** qa-browser.mjs — إقلاع Chromium الحقيقي لسكربتات QA (مشترك).
 * يحلّ مسار المتصفح ومكتبات al2023 بمرونة حسب ما هو مفكوك فعلًا في /tmp،
 * بدل افتراض بنية واحدة قد تختلف بين البيئات (سبب تعطل سابق: LD_LIBRARY_PATH
 * كان يشير لمجلد أب لا يحوي ملفات .so مباشرة).
 */
import fs from 'node:fs';
import chromiumMin from '@sparticuz/chromium-min';

export async function qaExecutable() {
  for (const p of ['/tmp/chrm/chromium', '/tmp/chromium']) {
    try {
      if (fs.existsSync(p)) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch { /* جرّب التالي */ }
  }
  return chromiumMin.executablePath('/tmp/chrm');
}

export function qaLibPath() {
  const dirs = ['/tmp/crlibs/lib/lib', '/tmp/crlibs/lib'].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  const cur = (process.env.LD_LIBRARY_PATH || '').split(':').filter(Boolean);
  const merged = [...dirs.filter(d => !cur.includes(d)), ...cur];
  if (merged.length) process.env.LD_LIBRARY_PATH = merged.join(':');
}

export async function launchQaBrowser(pw, extraArgs = []) {
  qaLibPath();
  const exe = await qaExecutable();
  return pw.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=ar', ...extraArgs],
    headless: true,
  });
}
