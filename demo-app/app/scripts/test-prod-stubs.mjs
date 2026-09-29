// test-prod-stubs.mjs — CS-038 unit gate. The email / connectedInboxes / oauthWorkspaces
// CLIENT adapters must NEVER engage their localStorage/simulation stub in a PRODUCTION
// build. Each one used to gate its stub on `VITE_EMAIL_BACKEND_URL` alone, so a production
// build with that URL unset would silently FAKE sends and connects (CS-038, the sibling of
// the CS-010 quotes-stub loss). W2 already fixed quotes/integrations/team/twilio; this is
// the remainder.
//
// This loads each adapter under simulated build envs — via vite's OXC transform with an
// `import.meta.env` define, the SAME substitution Vite performs at build time — and asserts:
//   • PROD build, no backend URL  → every stub-capable call throws "not configured"
//                                    (never resolves to a fake {status:'sent'}/inbox/ws),
//                                    and *_STUB_ACTIVE === false, *_CONFIGURED === false.
//   • PROD build, backend URL set → *_CONFIGURED === true, *_STUB_ACTIVE === false.
//   • demo build, no backend URL  → *_STUB_ACTIVE === true (the stub is still the demo path).
//
// It is the per-adapter RUNTIME companion to the whole-bundle DCE gate (test-bundle-stubs.mjs):
// this proves the contract at the source; that proves the stub bodies dead-code-eliminate.
//
// OFFLINE. No network. sendEmail / connect* here are the CLIENT adapters — they throw
// synchronously in the not-configured case, and the real-backend path is never called (the
// PROD+URL case only reads the exported flags). Declared in run-tests.mjs OFFLINE_OK because
// the source text contains `sendEmail(` (the client adapter, not api/_lib/email.js).

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const LIB = fileURLToPath(new URL('../src/lib/', import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), 'cs-prod-stubs-'));
let seq = 0;

// Load a src/lib adapter with import.meta.env replaced by `env` (what Vite inlines at build
// time), so its build-time stub gate resolves the way it would in that build. The module's
// own relative imports are re-pointed at the REAL files so they resolve from the temp dir;
// those files load normally (untransformed) — only the adapter under test sees `env`.
async function loadUnder(file, env) {
  const src = readFileSync(join(LIB, file), 'utf8');
  const { code } = await transformWithOxc(src, file, {
    define: { 'import.meta.env': JSON.stringify(env) },
  });
  const rewritten = code.replace(/(from\s*['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, spec, b) => {
    let abs = fileURLToPath(new URL(spec, pathToFileURL(join(LIB, file))));
    if (!extname(abs)) abs += '.js';
    return a + pathToFileURL(abs).href + b;
  });
  const tag = `${env.PROD ? 'prod' : 'dev'}.${env.VITE_EMAIL_BACKEND_URL ? 'url' : 'nourl'}`;
  const tmp = join(tmpRoot, `${file.replace(/\.js$/, '')}.${tag}.${seq++}.mjs`);
  writeFileSync(tmp, rewritten);
  return import(pathToFileURL(tmp).href);
}

const PROD_NOURL = { PROD: true, MODE: 'production' };
const PROD_URL = { PROD: true, MODE: 'production', VITE_EMAIL_BACKEND_URL: '/api' };
const DEMO_NOURL = { PROD: false, MODE: 'demo' };

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

// The load-bearing assertion: the call must throw a "not configured" error, never resolve
// to a fabricated stub result.
async function throwsNotConfigured(factory) {
  let result, threw = false, msg = '';
  try { result = await factory(); }
  catch (e) { threw = true; msg = String(e && e.message || e); }
  assert.ok(threw, `expected a throw, but it resolved to a stub: ${JSON.stringify(result)}`);
  assert.match(msg, /not configured/i, `expected a "not configured" error, got: ${msg}`);
}

// Force the demo send's ~5% simulated-failure roll to succeed so this stays deterministic.
async function withNoRandomFailure(fn) {
  const orig = Math.random;
  Math.random = () => 0.999;
  try { return await fn(); } finally { Math.random = orig; }
}

console.log('CS-038 — client stub adapters must be dead in a production build\n');

// ────────────────────────── email.js ──────────────────────────
await check('email: PROD + no URL → not configured (never fakes a send)', async () => {
  const m = await loadUnder('email.js', PROD_NOURL);
  assert.equal(m.EMAIL_STUB_ACTIVE, false, 'EMAIL_STUB_ACTIVE must be false in a prod build');
  assert.equal(m.EMAIL_CONFIGURED, false, 'EMAIL_CONFIGURED must be false with no backend');
  await throwsNotConfigured(() => m.sendEmail({ to: 'a@b.co', from: 'x@y.co', subject: 's', body: 'b' }));
  const health = await m.getEmailHealth();
  assert.equal(health.status, 'not_configured', 'getEmailHealth must report not_configured');
  assert.ok(!health.stub, 'getEmailHealth must not return a stub health');
  assert.equal(m.simulateInboundEmail({ fromEmail: 'a@b.co' }), null, 'simulateInboundEmail must not fabricate in prod');
});
await check('email: PROD + URL → configured, not a stub', async () => {
  const m = await loadUnder('email.js', PROD_URL);
  assert.equal(m.EMAIL_STUB_ACTIVE, false);
  assert.equal(m.EMAIL_CONFIGURED, true);
});
await check('email: demo + no URL → stub is the demo path', async () => {
  const m = await loadUnder('email.js', DEMO_NOURL);
  assert.equal(m.EMAIL_STUB_ACTIVE, true);
  const r = await withNoRandomFailure(() => m.sendEmail({ to: 'a@b.co', from: 'x@y.co', subject: 's', body: 'b' }));
  assert.equal(r.status, 'sent', 'a demo build must still simulate a send');
});

// ────────────────────── connectedInboxes.js ──────────────────────
await check('inbox: PROD + no URL → not configured (never fakes a connect)', async () => {
  const m = await loadUnder('connectedInboxes.js', PROD_NOURL);
  assert.equal(m.INBOX_STUB_ACTIVE, false, 'INBOX_STUB_ACTIVE must be false in a prod build');
  assert.equal(m.INBOX_CONFIGURED, false, 'INBOX_CONFIGURED must be false with no backend');
  await throwsNotConfigured(() => m.connectGoogle());
  await throwsNotConfigured(() => m.connectMicrosoft());
  await throwsNotConfigured(() => m.connectSmtp({ email: 'a@b.co', smtpHost: 'h', smtpPort: 587, smtpUsername: 'u', smtpPassword: 'p' }));
  await throwsNotConfigured(() => m.disconnectInbox('ci_1'));
  await throwsNotConfigured(() => m.testInboxSend('ci_1', { to: 'a@b.co', subject: 's', body: 'b' }));
  await throwsNotConfigured(() => m.sendViaInbox('ci_1', { to: 'a@b.co', subject: 's', body: 'b' }));
});
await check('inbox: PROD + URL → configured, not a stub', async () => {
  const m = await loadUnder('connectedInboxes.js', PROD_URL);
  assert.equal(m.INBOX_STUB_ACTIVE, false);
  assert.equal(m.INBOX_CONFIGURED, true);
});
await check('inbox: demo + no URL → stub is the demo path', async () => {
  const m = await loadUnder('connectedInboxes.js', DEMO_NOURL);
  assert.equal(m.INBOX_STUB_ACTIVE, true);
  const r = await m.connectGoogle();
  assert.ok(r.ok && r.inbox, 'a demo build must still simulate a connect');
});

// ────────────────────── oauthWorkspaces.js ──────────────────────
await check('workspaces: PROD + no URL → not configured (never fakes a register)', async () => {
  const m = await loadUnder('oauthWorkspaces.js', PROD_NOURL);
  assert.equal(m.WORKSPACES_STUB_ACTIVE, false, 'WORKSPACES_STUB_ACTIVE must be false in a prod build');
  assert.equal(m.WORKSPACES_CONFIGURED, false, 'WORKSPACES_CONFIGURED must be false with no backend');
  await throwsNotConfigured(() => m.registerWorkspace({ label: 'W', clientId: 'c', clientSecret: 's' }));
  await throwsNotConfigured(() => m.testWorkspace('ws_1'));
  await throwsNotConfigured(() => m.removeWorkspace('ws_1'));
});
await check('workspaces: PROD + URL → configured, not a stub', async () => {
  const m = await loadUnder('oauthWorkspaces.js', PROD_URL);
  assert.equal(m.WORKSPACES_STUB_ACTIVE, false);
  assert.equal(m.WORKSPACES_CONFIGURED, true);
});
await check('workspaces: demo + no URL → stub is the demo path', async () => {
  const m = await loadUnder('oauthWorkspaces.js', DEMO_NOURL);
  assert.equal(m.WORKSPACES_STUB_ACTIVE, true);
  const r = await m.registerWorkspace({ label: 'W', clientId: 'c', clientSecret: 's' });
  assert.ok(r.ok && r.workspace, 'a demo build must still simulate a register');
});

rmSync(tmpRoot, { recursive: true, force: true });
if (failures) { console.error(`\n✗ test-prod-stubs: ${failures} check(s) failed (CS-038)\n`); process.exit(1); }
console.log('\n✓ test-prod-stubs: all CS-038 adapter checks passed\n');
process.exit(0);
