// The test runner. Use this instead of `for f in scripts/test-*.mjs; do node "$f"; done`.
//
//   node scripts/run-tests.mjs          # every offline suite
//   node scripts/run-tests.mjs --list   # show the split, run nothing
//
// ⚠️ WHY THIS EXISTS. `scripts/test-*.mjs` is NOT a homogeneous set. Most files are
// offline unit suites, but a handful reach live Supabase or Resend — and one of them
// (`test-email.mjs`) SENDS A REAL EMAIL, historically to a hardcoded real address when
// argv[2] was absent. On 2026-07-20 an unattended loop "verified the suite" with a
// glob-and-run sweep, which invoked the live sender. It was saved only by an unrelated
// ENOENT on a machine-local file; on a machine where that file existed it would have
// mailed a live recipient. The name `test-*` implied "safe to run" and that was wrong.
//
// So the split is declared here, and DRIFT IS AN ERROR: a new test-*.mjs that reaches a
// live service without being declared below fails the runner. That way the next person
// to add one cannot quietly re-arm the hazard — the same "make it not expressible"
// shape used for the signature upload path and the jobs write guard.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// fileURLToPath, NOT url.pathname — on Windows the latter yields "/C:/Users/..." with a
// leading slash, which Node cannot resolve (every suite fails MODULE_NOT_FOUND).
import { fileURLToPath } from 'node:url';

const DIR = new URL('.', import.meta.url);

// Scripts that legitimately reach a live service. Each needs a reason, and each is
// SKIPPED by default. Reads are safe but still excluded — an offline suite must not
// depend on network or credentials to be green.
const LIVE_EFFECT = {
  'test-email.mjs': 'SENDS REAL EMAIL via Resend. Guarded behind --send.',
  'test-email-route.mjs': 'live Supabase client; exercises the send route end to end',
  'test-reviews-route.mjs': 'live env + route drive',
  'test-fleet-gate-predicate.mjs': 'live READ of the fleet-gate state (safe, but needs creds)',
  'test-gmb-live.mjs': 'live probe of the deployed /api/reviews surface (unauthenticated 401/404 checks only)',
  'test-row-version-trigger.mjs': 'live READ of row_version stamping during the 1e soak',
  'test-series-master-invariant.mjs': 'live READ — every multi-occurrence series has exactly one recurrence master',
  'test-time-replay.mjs': 'imports api/_lib/supabase; also needs node:test module mocking',
};

// Markers that mean "this file talks to something real". CALL-shaped, not import-shaped:
// importing a module is inert, invoking its client/sender is not. A bare `fetch(` is
// excluded because in an offline suite it is nearly always a stub being defined.
const LIVE_MARKERS = [/@supabase\/supabase-js/, /createClient\s*\(/, /getSupabase\s*\(/, /\bsendEmail\s*\(/];

// Files that import a live module but use only its PURE exports. Each was read to
// confirm it never invokes the live path — an entry here is a claim someone checked.
const OFFLINE_OK = {
  'test-email-from-allowlist.mjs': 'imports _lib/email for resolveFromAndReplyTo/addressOf/verifiedDomain — pure, never sendEmail()',
  'test-prod-stubs.mjs': 'CS-038 gate — transforms the CLIENT email/inbox/workspaces adapters under a PROD env and asserts they throw not-configured; sendEmail here is the client stub adapter (no network), never api/_lib/email.js',
};

const all = readdirSync(DIR).filter((f) => f.startsWith('test-') && f.endsWith('.mjs')).sort();
const offline = all.filter((f) => !(f in LIVE_EFFECT));

// ── drift check: an undeclared file that reaches live is a hard error ──────
const undeclared = offline.filter((f) => {
  if (f in OFFLINE_OK) return false;
  const src = readFileSync(new URL(f, DIR), 'utf8');
  return LIVE_MARKERS.some((re) => re.test(src));
});
if (undeclared.length) {
  console.error('\n✖ These test-*.mjs reach a live service but are not declared in LIVE_EFFECT:\n');
  for (const f of undeclared) console.error(`    ${f}`);
  console.error('\n  Add each to LIVE_EFFECT with a reason, or remove the live dependency.');
  console.error('  Refusing to run — an undeclared live script may have side effects.\n');
  process.exit(2);
}

// A declared entry for a file that no longer exists is also drift, just quieter.
const stale = Object.keys(LIVE_EFFECT).filter((f) => !all.includes(f));
if (stale.length) console.warn(`\n⚠ LIVE_EFFECT names files that no longer exist: ${stale.join(', ')}`);

// ── backend-less branch: the static demo strips app/api, so suites that import
// it cannot resolve their modules. Skip those (they test code this build does not
// ship) rather than fail. Detected by a relative import into ../api/. When app/api
// IS present, nothing is skipped and every offline suite runs as before.
const hasBackend = existsSync(fileURLToPath(new URL('../api', DIR)));
const backendSkip = [];
const runnable = [];
// A suite is "backend" if it references app/api (an ES import, or a readFileSync/read
// of the source) or supabase (its migrations, e.g. join(..,'supabase','migrations')).
// `api/` must be a path literal (not a `/api/` fetch URL); `supabase` matches the bare
// word since nothing frontend uses it. app/api + supabase are stripped together.
const BACKEND_REF = /['"](?:\.\.?\/)*api\/|\bsupabase\b/i;
for (const f of offline) {
  const src = readFileSync(new URL(f, DIR), 'utf8');
  if (!hasBackend && BACKEND_REF.test(src)) backendSkip.push(f);
  else runnable.push(f);
}

if (process.argv.includes('--list')) {
  console.log(`\noffline suites (${runnable.length}):`);
  for (const f of runnable) console.log(`  ${f}`);
  if (backendSkip.length) {
    console.log(`\nbackend suites skipped, no app/api (${backendSkip.length}):`);
    for (const f of backendSkip) console.log(`  ${f}`);
  }
  console.log(`\nskipped — live effect (${Object.keys(LIVE_EFFECT).length}):`);
  for (const [f, why] of Object.entries(LIVE_EFFECT)) console.log(`  ${f.padEnd(34)} ${why}`);
  console.log('');
  process.exit(0);
}

// ── run ───────────────────────────────────────────────────────────────────
const red = [];
for (const f of runnable) {
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL(f, DIR))], { stdio: 'pipe' });
  } catch (e) {
    red.push([f, `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-6).join('\n')]);
  }
}

console.log(`\n${runnable.length - red.length}/${runnable.length} offline suites green` +
  (backendSkip.length ? ` · ${backendSkip.length} backend suites skipped (no app/api on this branch)` : '') +
  ` · ${Object.keys(LIVE_EFFECT).length} live-effect scripts skipped`);
if (red.length) {
  for (const [f, tail] of red) console.error(`\n✖ ${f}\n${tail.replace(/^/gm, '    ')}`);
  console.error(`\n${red.length} suite(s) red.\n`);
  process.exit(1);
}
console.log('');
