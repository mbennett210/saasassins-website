// One read, many readers (lib/sharedRead; the manager view, UI_RULES §152).
//
// The manager's nav pills, the manager Home's tiles and the today screens read the same figures.
// The orchestrator's rule for Wave B: "one shared hook/cache, never a second fetch per page view;
// refresh on focus". This holds the store (a read in flight is joined, a fresh answer is reused, a
// failure keeps the last answer) and the wiring (every reader of a figure goes through it).
//
// Offline. Run: node scripts/test-shared-read.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const sr = await import('../src/lib/sharedRead.js').catch(() => ({}));
const fn = (name) => (typeof sr[name] === 'function' ? sr[name] : () => undefined);
const refresh = fn('refreshShared');
const entry = fn('sharedEntry');
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── the store ────────────────────────────────────────────────────────────────────────────────
{
  fn('clearShared')();
  let calls = 0;
  let release;
  const reader = () => { calls += 1; return new Promise((r) => { release = r; }); };
  const a = refresh('k1', reader);
  const b = refresh('k1', reader);
  await tick();
  ok('a second reader while a read is in flight JOINS it (one fetch)', calls === 1 && a === b);
  ok('the entry says a read is in flight', !!entry('k1')?.inflight);
  if (release) release({ n: 1 });
  await a;
  ok('the answer lands for every reader', entry('k1')?.data?.n === 1 && !entry('k1')?.inflight);
  await refresh('k1', reader, { maxAgeMs: 60000 });
  ok('an answer younger than maxAgeMs is reused (no fetch)', calls === 1);
  const c = refresh('k1', reader, { maxAgeMs: 0 });
  await tick();
  if (release) release({ n: 2 });
  await c;
  ok('maxAgeMs 0 always reads (Try again, the connection returning)', calls === 2 && entry('k1')?.data?.n === 2);
  ok('another key is another answer', entry('k2') === null);
}
{
  fn('clearShared')();
  await refresh('k3', async () => ({ v: 'first' }));
  await refresh('k3', async () => { throw new Error('boom'); });
  ok('a failed re-read keeps the last answer and records the error beside it',
    entry('k3')?.data?.v === 'first' && entry('k3')?.error?.message === 'boom');
  let reread = 0;
  await refresh('k3', async () => { reread += 1; return { v: 'again' }; }, { maxAgeMs: 60000 });
  ok('after a failure a fresh-enough answer is NOT trusted: the next asker reads again', reread === 1 && entry('k3')?.data?.v === 'again' && entry('k3')?.error === null);
  await refresh('k4', () => { throw new Error('sync'); });
  ok('a reader that throws synchronously settles (nothing stays "in flight")', !entry('k4')?.inflight && entry('k4')?.error?.message === 'sync');
  let seen = 0;
  const off = fn('subscribeShared')('k5', () => { seen += 1; });
  const v0 = fn('sharedVersion')('k5');
  await refresh('k5', async () => 1);
  await tick();
  ok(`subscribers hear the start and the answer, and the version moves (${seen})`, seen === 2 && fn('sharedVersion')('k5') > v0);
  if (typeof off === 'function') off();
  await refresh('k5', async () => 2);
  ok('an unsubscribed reader hears nothing more', seen === 2);
}

// ── the wiring: every reader of a figure goes through the one store ────────────────────────
{
  const today = read('src/hooks/useManagerToday.js');
  ok('the today engine reads through the shared store, keyed by the viewer and the scope',
    /useSharedRead\(`mgrToday\|\$\{currentUser\?\.id/.test(today) && !/useState\(null\); \/\/ \{ punches/.test(today));
  const reads = read('src/hooks/useManagerHomeReads.js');
  ok('the Home\'s reads are shared, keyed by the viewer and the scope', /useSharedRead\(`mgrHome:\$\{name\}\|\$\{currentUser\?\.id/.test(reads) && /homeScopeKey\(scope\)/.test(reads));
  ok('the nav pills read the SAME hooks as the Home (no second fetch per page view)',
    /export function useManagerNavCounts/.test(reads) && /useHoursRead\(scope/.test(reads) && /useRequestsRead\(scope/.test(reads)
    && /useSuppliesRead\(scope/.test(reads) && /useManagerToday\(/.test(reads));
  const home = read('src/pages/ManagerHome.jsx');
  ok('the Home reads its tiles through those hooks (its own per-tile fetch is gone)',
    /useInspectionsRead\(scope/.test(home) && /useHoursRead\(scope/.test(home) && /useRequestsRead\(scope/.test(home)
    && /useSuppliesRead\(scope/.test(home) && !/function useTileRead/.test(home) && !/useSupplyBudgets/.test(home));
  // For the roles menuCountsFor names: a manager, the owner and an admin (Daniel, 2026-10-30).
  ok('the sidebar and the phone menu draw the pills from useManagerNavCounts',
    /useManagerNavCounts\(menuCountsFor\(currentUser\?\.role\)\)/.test(read('src/components/Sidebar.jsx'))
    && /useManagerNavCounts\(menuCountsFor\(user\?\.role\)\)/.test(read('src/components/FloatingNav.jsx')));
  const hook = read('src/hooks/useSharedRead.js');
  ok('a shared read refreshes on focus and when the connection returns', /addEventListener\('focus'/.test(hook) && /addEventListener\('online'/.test(hook));
}

console.log(`\ntest-shared-read: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
