// Cold-import gate for the serverless functions (QUALITY_GATES.md §1.4, THE LAW II.3).
//
// Vercel loads each app/api function file in a fresh Node process with only the
// configured environment — no bundler, no import-resolver help. A relative import
// written without its `.js` extension resolves under Vite (dev + build) but throws
// ERR_MODULE_NOT_FOUND under plain Node, so the function 500s on EVERY invocation and
// nothing local catches it. That is exactly how /api/cron/ops-alerts crashed every 5
// minutes from 2026-09-20 (CS-011): opsAlertCopy.js and opsAlertApply.js imported
// './dates', './notifications' and './opsAlerts' extensionless. Test resolvers that
// append `.js` (CS-308) hid it from the suite.
//
// This gate imports every non-_lib function file the way production does: through
// pathToFileURL(path.resolve(f)).href — on Windows a bare "C:\..." path handed to
// import() throws ERR_UNSUPPORTED_ESM_URL_SCHEME, which would fail all 43 for the wrong
// reason — under a scrubbed (empty-of-config) environment. Importing a module is inert;
// none of these construct a client or open a socket at load, so the run makes no network
// call. Any load-time crash fails the gate.
//
// Offline: no live service is reached (no client is created, nothing is sent).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Script lives at <repo>/app/scripts/, so the repo root is two levels up. Deriving it
// from the script location (not process.cwd()) keeps the gate correct no matter where
// the runner invokes it from.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

// A stray floating rejection from a loaded module must not pass silently as green.
process.on('unhandledRejection', (err) => {
  console.error('✖ unhandledRejection during cold import:', err);
  process.exitCode = 1;
});

// Enumerate the function files exactly as §1.4 prescribes: git-tracked *.js under
// app/api, excluding the shared _lib/ helpers (those load through the function graph).
// Run git while the real environment is still present (below we scrub it).
function listFunctionFiles() {
  // Enumerate from app/ with the pathspec 'api', so tracked function files come back as
  // 'api/<route>.js'. That 'api/' string literal is also what run-tests.mjs's BACKEND_REF
  // (/['"](?:\.\.?\/)*api\/|\bsupabase\b/) matches: on a backend-stripped checkout (no
  // app/api) run-tests then SKIPS this suite instead of running it green — the same
  // treatment every other backend suite gets. No LIVE_MARKERS are added, so it stays
  // honestly OFFLINE.
  const out = execFileSync('git', ['ls-files', 'api'], { cwd: path.join(REPO_ROOT, 'app'), encoding: 'utf8' });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => f.endsWith('.js') && f.startsWith('api/') && !f.includes('/_lib/'))
    .sort();
}

// Reduce the environment to a minimal, config-free set so a module that reads config at
// load resolves to undefined (the empty-env / `env -i` posture §1.4 requires), while
// Node itself keeps working on Windows. Nothing app-specific (VITE_*, SUPABASE_*,
// CRON_SECRET, RESEND_*, …) survives.
function scrubEnv() {
  const keep = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'WINDIR', 'COMSPEC']);
  for (const k of Object.keys(process.env)) {
    if (!keep.has(k.toUpperCase())) delete process.env[k];
  }
}

const files = listFunctionFiles();

// Floor guard: 0 function files means app/api is absent or the enumeration ran from the
// wrong tree — NOT "nothing to check". Fail loudly instead of printing a false green (the
// L3-review finding). The floor is > 0, deliberately not a fixed count: the route set
// changes legitimately across the fix-wave program, so any positive constant would rot or
// fire falsely. run-tests skips this suite when the backend is stripped (see above), so
// whenever it actually runs, at least one function file must exist.
if (files.length === 0) {
  console.error('✖ cold-import listed 0 app/api function files — is app/api present, and is this a git checkout? (run-tests skips this suite when the backend is stripped, so a real run must find at least one)');
  process.exit(1);
}

scrubEnv();

console.log(`cold-import: ${files.length} app/api function files (empty env)`);

const failures = [];
let loaded = 0;
for (const f of files) {
  const abs = path.resolve(REPO_ROOT, 'app', f);
  try {
    await import(pathToFileURL(abs).href);
    loaded += 1;
  } catch (err) {
    failures.push([f, err]);
  }
}

console.log(`\n${loaded}/${files.length} function files loaded cold`);

if (failures.length) {
  console.error(`\n✖ ${failures.length} failed to import under plain Node:`);
  for (const [f, err] of failures) {
    console.error(`\n  ${f}`);
    console.error(`    ${err && err.code ? err.code + ': ' : ''}${err && err.message ? err.message : err}`);
  }
  console.error('');
  process.exit(1);
}

if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
console.log('all function files load cold — no missing-extension or load-time crashes\n');
