/**
 * prod-runtime-crypto.mjs — PRODUCTION-RUNTIME regression test for the PBKDF2 cap
 * ==================================================================================
 * Why this file exists (PR #23 → production HTTP 500 on POST /api/admin/setup):
 *
 *   The Cloudflare Workers runtime (workerd) HARD-CAPS Web Crypto PBKDF2 at
 *   100,000 iterations. Requesting more throws:
 *     DOMException NotSupportedError:
 *       "Pbkdf2 failed: iteration counts above 100000 are not supported
 *        (requested 120000)."
 *   That exception is NOT an ApiError, so it escaped handleAdmin()'s error mapping
 *   and surfaced as the generic HTTP 500 the owner saw in production. Every password
 *   path died the same way: /api/admin/setup, /api/admin/login, ensureAdminBootstrap
 *   (hence status showed setup:true even though envBootstrap:true), password change,
 *   teacher login/create/reset.
 *
 *   THE LOCAL DEV RUNTIME DOES NOT REPRODUCE THIS. `wrangler dev` / Miniflare ship a
 *   workerd build with no CPU-time limit, so it happily runs 1,000,000 PBKDF2
 *   iterations. That is exactly why PR #23's local tests passed while production 500'd.
 *   A mock-KV / node-webcrypto test can NEVER catch this bug.
 *
 * What this test does:
 *   It runs the REAL src/worker.js inside the REAL workerd runtime (via wrangler dev),
 *   but first installs a crypto.subtle shim that re-imposes the PRODUCTION iteration
 *   cap (throw the identical NotSupportedError above 100000). The local runtime then
 *   behaves exactly like production for PBKDF2, so:
 *     • the pre-fix behaviour (120000) is reproduced as the exact production exception;
 *     • the fix (setup/login succeed, worker never requests >100000) is verified in the
 *       real runtime — not a mock.
 *
 *   If anyone re-introduces a >100000 iteration cost WITHOUT the clamp, setup throws
 *   under the cap → the worker returns 503 (not 200) and maxIterations exceeds the cap,
 *   so this test FAILS. That is the regression guard.
 *
 * Usage: node tests/prod-runtime-crypto.mjs   (also run by `npm test`)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF = path.resolve(__dirname, '..');           // …/cloudflare
const PORT = Number(process.env.CAPTEST_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const CAPDIR = path.join(CF, '.captest');           // transient project (gitignored, removed below)
const STATE = fs.mkdtempSync('/tmp/wrangler-captest-');
const PROD_CAP = 100000;                            // workerd's production PBKDF2 iteration cap

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

async function jfetch(p, opts) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...(opts || {}) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, headers: r.headers };
}
const post = (p, body, headers = {}) => jfetch(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...headers },
  body: JSON.stringify(body)
});

/* ------------------------------------------------------------------ *
 * Build the transient cap-enforced project that imports the REAL worker.
 * ------------------------------------------------------------------ */
function writeCapProject() {
  fs.rmSync(CAPDIR, { recursive: true, force: true });
  fs.mkdirSync(CAPDIR, { recursive: true });

  // 1) The production cap shim. Patches crypto.subtle BEFORE the worker module runs
  //    (ESM imports evaluate in order; entry.js imports this first). Faithfully throws
  //    the SAME DOMException(name/message) production workerd throws above the cap, and
  //    records the maximum iteration count any code path actually requested.
  fs.writeFileSync(path.join(CAPDIR, 'cap-enforcer.js'), `
const PROD_CAP = ${PROD_CAP};
const state = { patched: false, inProbe: false, maxAppIterations: 0, appCapThrows: 0 };
globalThis.__CAPTEST = state;

function enforce(alg) {
  if (alg && typeof alg === 'object' && alg.name === 'PBKDF2') {
    const it = Number(alg.iterations) || 0;
    // Count ONLY real worker traffic toward the regression guard; the /__captest/probe
    // route sets inProbe=true so its intentional over-cap reproduction is excluded.
    if (!state.inProbe && it > state.maxAppIterations) state.maxAppIterations = it;
    if (it > PROD_CAP) {
      if (!state.inProbe) state.appCapThrows++;
      // Byte-for-byte the production workerd error (src/workerd/api/crypto-impl-pbkdf2.c++).
      throw new DOMException(
        'Pbkdf2 failed: iteration counts above ' + PROD_CAP + ' are not supported (requested ' + it + ').',
        'NotSupportedError'
      );
    }
  }
}
const subtle = crypto.subtle;
const origDeriveBits = subtle.deriveBits;
const origDeriveKey = subtle.deriveKey;
subtle.deriveBits = function (alg, key, len) { enforce(alg); return origDeriveBits.call(subtle, alg, key, len); };
if (typeof origDeriveKey === 'function') {
  subtle.deriveKey = function (alg, key, derived, extractable, usages) { enforce(alg); return origDeriveKey.call(subtle, alg, key, derived, extractable, usages); };
}
state.patched = (subtle.deriveBits !== origDeriveBits);
`);

  // 2) Entry module: install the cap shim, then wrap the REAL worker's fetch and add
  //    two test-only introspection routes (/__captest/state, /__captest/probe).
  fs.writeFileSync(path.join(CAPDIR, 'entry.js'), `
import './cap-enforcer.js';
import worker from '../src/worker.js';

const enc = new TextEncoder();
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__captest/state') {
      return Response.json(globalThis.__CAPTEST || {});
    }
    if (url.pathname === '/__captest/probe') {
      // Directly exercise crypto.subtle.deriveBits at a chosen iteration count through
      // the SAME patched path the worker uses — proves the shim reproduces production.
      // inProbe=true keeps this intentional over-cap call out of the worker counters.
      const iters = parseInt(url.searchParams.get('iters') || '1000', 10);
      const st = globalThis.__CAPTEST; if (st) st.inProbe = true;
      try {
        const key = await crypto.subtle.importKey('raw', enc.encode('probe-password'), 'PBKDF2', false, ['deriveBits']);
        await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('0123456789abcdef'), iterations: iters }, key, 256);
        return Response.json({ threw: false, iters });
      } catch (e) {
        return Response.json({ threw: true, iters, name: (e && e.name) || 'Error', message: String((e && e.message) || e).slice(0, 200) });
      } finally { if (st) st.inProbe = false; }
    }
    return worker.fetch(request, env, ctx);
  }
};
`);

  // 3) Wrangler config mirroring production bindings (assets + PLATFORM_KV). The KDF
  //    cap only affects auth paths, so no Durable Object binding is needed here.
  fs.writeFileSync(path.join(CAPDIR, 'wrangler.jsonc'), `{
  "name": "exams-captest",
  "main": "entry.js",
  "compatibility_date": "2025-06-01",
  "assets": { "directory": "../public", "binding": "ASSETS", "not_found_handling": "none", "run_worker_first": true },
  "kv_namespaces": [{ "binding": "PLATFORM_KV", "id": "b2335d799e2a4caabff6d9d4530f425c" }],
  "observability": { "enabled": true }
}
`);
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
writeCapProject();
console.log('Starting cap-enforced REAL workerd (wrangler dev) on :' + PORT + ' …');
const proc = spawn('npx', ['wrangler', 'dev', '--config', path.join(CAPDIR, 'wrangler.jsonc'), '--port', String(PORT), '--ip', '0.0.0.0', '--persist-to', STATE], {
  cwd: CF,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
});
let logs = '';
proc.stdout.on('data', d => { logs += d; });
proc.stderr.on('data', d => { logs += d; });

async function waitForServer(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/__captest/state', { signal: AbortSignal.timeout(1500) });
      if (r.ok) { const s = await r.json(); if (s && s.patched) return s; }
    } catch {}
    if (proc.exitCode !== null) throw new Error('wrangler dev exited:\n' + logs.slice(-3000));
    await new Promise(r => setTimeout(r, 700));
  }
  throw new Error('server did not start:\n' + logs.slice(-3000));
}

try {
  const boot = await waitForServer();
  console.log('Cap-enforced workerd ready (shim patched=' + boot.patched + ').\n');
  ok('crypto.subtle cap shim installed in the real runtime', boot.patched === true);

  /* ---- A. Reproduce the EXACT production exception (root cause) ---- */
  console.log('[A] Reproduce production PBKDF2 cap (the PR #23 root cause)');
  {
    const over = await jfetch('/__captest/probe?iters=120000');
    ok('deriveBits @120000 throws (the value PR #23 used)', over.data && over.data.threw === true, JSON.stringify(over.data));
    ok('  …as DOMException NotSupportedError', over.data && over.data.name === 'NotSupportedError', over.data && over.data.name);
    ok('  …with the production message "iteration counts above 100000 … (requested 120000)"',
      over.data && /iteration counts above 100000 are not supported \(requested 120000\)/.test(over.data.message || ''),
      over.data && over.data.message);

    const at = await jfetch('/__captest/probe?iters=100000');
    ok('deriveBits @100000 succeeds (production-safe maximum)', at.data && at.data.threw === false, JSON.stringify(at.data));
  }

  /* ---- B. The real worker under the production cap: setup must NOT 500 ---- */
  console.log('\n[B] Real /api/admin/* under the production cap');
  const st0 = await jfetch('/api/admin/status');
  ok('GET /api/admin/status → 200 setup:true (fresh KV)', st0.status === 200 && st0.data && st0.data.setup === true, JSON.stringify(st0.data));

  // Probe traffic is excluded from the worker counters (inProbe flag), so B/C/D measure
  // ONLY the real worker's pbkdf2 calls.
  const setup = await post('/api/admin/setup', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass-2026' });
  ok('POST /api/admin/setup → 200 (was HTTP 500 in production before the fix)', setup.status === 200, 'got ' + setup.status + ' ' + setup.text.slice(0, 120));
  ok('  …returns {ok:true}', setup.data && setup.data.ok === true, JSON.stringify(setup.data));

  const dup = await post('/api/admin/setup', { email: 'a@b.c', password: 'longenough1' });
  ok('POST /api/admin/setup again → 409 (account now exists)', dup.status === 409, 'got ' + dup.status);

  const st1 = await jfetch('/api/admin/status');
  ok('GET /api/admin/status after setup → setup:false', st1.status === 200 && st1.data && st1.data.setup === false, JSON.stringify(st1.data));

  /* ---- C. Login (verification path) under the cap + security invariants ---- */
  console.log('\n[C] Real /api/admin/login under the production cap');
  const wrong = await post('/api/admin/login', { email: 'owner@example.com', password: 'wrong-password-1' });
  ok('login with wrong password → 401 (not 500)', wrong.status === 401, 'got ' + wrong.status);

  const login = await post('/api/admin/login', { email: 'owner@example.com', password: 'Str0ng-Owner-Pass-2026' });
  ok('login with correct password → 200 (verification recompute works at the capped cost)', login.status === 200 && login.data && login.data.ok === true, 'got ' + login.status + ' ' + login.text.slice(0, 120));
  const sc = login.headers.get('set-cookie') || '';
  ok('session cookie is HttpOnly + Secure + SameSite=Strict (security unchanged)',
    /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Strict/i.test(sc), sc.slice(0, 120));

  /* ---- D. THE regression guard: the worker never requests > cap ---- */
  console.log('\n[D] Regression guard — worker never exceeds the production cap');
  {
    const state = await jfetch('/__captest/state');
    const maxIt = state.data && Number(state.data.maxAppIterations);
    const appThrows = state.data && Number(state.data.appCapThrows);
    ok('max PBKDF2 iterations requested by the real worker ≤ 100000', Number.isFinite(maxIt) && maxIt <= PROD_CAP, 'maxAppIterations=' + maxIt);
    ok('  …and it used the production-safe cost (100000), not a weak/low value', maxIt === PROD_CAP, 'maxAppIterations=' + maxIt);
    // appCapThrows counts over-cap requests made by the WORKER (probe excluded). The
    // pre-fix code (120000) would make this ≥1 and setup/login would 500; the fix keeps it 0.
    ok('the worker tripped the production cap 0 times (appCapThrows=0)', appThrows === 0, 'appCapThrows=' + appThrows);
  }

  console.log('\n══════════════════════════════');
  console.log(`prod-runtime-crypto: ${passed} passed ✓ / ${failed} failed ✗`);
} catch (e) {
  failed++;
  console.error('\nFATAL: ' + (e && e.stack || e));
  console.error('--- wrangler logs (tail) ---\n' + logs.slice(-3000));
} finally {
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CAPDIR, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
