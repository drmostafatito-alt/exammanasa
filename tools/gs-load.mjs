/**
 * gs-load.mjs — Loads the Google Apps Script .gs data files in Node (no GAS runtime).
 * Used by build/validate tooling only. Never shipped to the browser.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

export function loadGsData(files = ['Data.gs', 'PhiloData.gs', 'PhiloTerm2Data.gs']) {
  const ctx = { console };
  vm.createContext(ctx);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), ctx, { filename: f });
  }
  // Re-declare the consts onto the context object so ESM can read them.
  const names = [
    'EXAMS', 'CATALOG',
    'PHILO_SUBJECT', 'PHILO_BANK', 'PHILO_EXAMS', 'PHILO_AUDIT', 'PHILO_QUARANTINED',
    'PHILO_T2_BANK', 'PHILO_T2_EXAMS', 'PHILO_T2_AUDIT', 'PHILO_T2_QUARANTINED'
  ];
  vm.runInContext('globalThis.__out = {' + names.join(',') + '};', ctx);
  return ctx.__out;
}

/** Strips Arabic/Latin option prefixes like "أ)" — mirrors Code.gs stripOptionLabel_() */
export function stripOptionLabel(text) {
  return String(text || '').replace(/^\s*[أابجدهدABCDabcd][\s\)\].\-:：]+\s*/, '').trim();
}
