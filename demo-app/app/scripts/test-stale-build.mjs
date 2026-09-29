// Stale-build recovery: a tab (an installed PWA resumed from the background) that outlived
// a deploy. Owner report 2026-09-22: "after going into the app … it wasn't a fresh load, but
// the buttons were not responsive at the bottom". Reproduced: the old build asks for page
// chunks the new deploy no longer has; the SPA rewrite answered with index.html (200
// text/html), which fails as a module; the once-per-session reload guard recovered from the
// first deploy and then crashed the whole app on the next. Pinned here, layer by layer:
//   1. vercel.json — a missing /assets/* file is a real 404, never the app's HTML
//   2. lib/staleBuild — a COOLDOWN loop guard, not once-per-session (executed, fresh module
//      instance per case, against a stand-in window/sessionStorage)
//   3. the recovery is wired into every on-demand chunk (lazyRoute + vite:preloadError)
//   4. AutoUpdater checks for a new build the moment the app returns to the foreground,
//      and a tapped tab lights up while its page loads
//
//   node scripts/test-stale-build.mjs
import { readFileSync } from 'node:fs';
import { shouldRecover, RELOAD_COOLDOWN_MS, RELOAD_KEY } from '../src/lib/staleBuild.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 1. the server never answers a missing build file with the app's HTML ─────────────────
const vercel = JSON.parse(src('../vercel.json'));
const spa = vercel.rewrites.find((r) => r.destination === '/index.html');
const fallsBack = (p) => new RegExp(`^${spa.source}$`).test(p);
ok('app routes still fall back to index.html', ['/', '/schedule', '/clients/cl_1', '/settings/team', '/my-day'].every(fallsBack));
ok('a missing build file is a real 404, never index.html', !fallsBack('/assets/Schedule-DaL5_MOR.js') && !fallsBack('/assets/index-C_P5bZ_C.css'));
ok('api stays out of the SPA fallback', !fallsBack('/api/health'));

// ── 2. the guard: recover from EVERY deploy, never loop ───────────────────────────────────
const now = 1_790_000_000_000;
ok('first failure recovers', shouldRecover(null, now));
ok('junk or zero stored value recovers', shouldRecover('abc', now) && shouldRecover('0', now) && shouldRecover(undefined, now));
ok('a failure right after a recovery reload does NOT loop', !shouldRecover(String(now - 5_000), now));
ok('a later deploy in the same long-lived session recovers again (was: crash)',
  shouldRecover(String(now - RELOAD_COOLDOWN_MS), now) && shouldRecover(String(now - 6 * 60 * 60 * 1000), now));
ok('a clock that moved backwards does not trap the app', shouldRecover(String(now + 60_000), now));
ok('the cooldown is a loop guard (seconds), not a session guard', RELOAD_COOLDOWN_MS >= 10_000 && RELOAD_COOLDOWN_MS <= 5 * 60_000);

// Run the real recoverFromStaleBuild against a stand-in browser; each case gets a fresh
// module instance (a query string makes node load a separate copy) so its reload flag starts
// clear.
let fresh = 0;
async function run({ stored, throwsOnRead = false }) {
  const store = new Map(stored == null ? [] : [[RELOAD_KEY, String(stored)]]);
  let reloads = 0;
  globalThis.window = { location: { reload: () => { reloads += 1; } } };
  globalThis.sessionStorage = {
    getItem: (k) => { if (throwsOnRead) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  fresh += 1;
  const mod = await import(`../src/lib/staleBuild.js?case=${fresh}`);
  const first = mod.recoverFromStaleBuild();
  const second = mod.recoverFromStaleBuild(); // another failing import while the reload is under way
  return { first, second, reloads, stamped: store.get(RELOAD_KEY) };
}
{
  const r = await run({ stored: null });
  ok('never reloaded → reloads once, and stamps the time', r.first === true && r.reloads === 1 && Number(r.stamped) > 0);
  ok('a second failing import during that reload waits for it (no second reload)', r.second === true && r.reloads === 1);
}
{
  const r = await run({ stored: Date.now() - 2_000 });
  ok('reloaded 2s ago and still failing → surfaces the error instead of looping', r.first === false && r.reloads === 0);
}
{
  const r = await run({ stored: Date.now() - RELOAD_COOLDOWN_MS - 1_000 });
  ok('an earlier recovery this session does not block the next deploy', r.first === true && r.reloads === 1);
}
{
  const r = await run({ stored: null, throwsOnRead: true });
  ok('blocked storage still recovers', r.first === true && r.reloads === 1);
}
delete globalThis.window;
delete globalThis.sessionStorage;

// ── 3. wired into every on-demand chunk ───────────────────────────────────────────────────
const app = src('../src/App.jsx');
ok('lazyRoute recovers through lib/staleBuild', /factory\(\)\.catch\(\(err\) => \{\s*if \(recoverFromStaleBuild\(\)\) return new Promise\(\(\) => \{\}\);/.test(app));
ok('the once-per-session guard is gone', !/!sessionStorage\.getItem\(KEY\)/.test(app));
const main = src('../src/main.jsx');
ok('any failed on-demand chunk recovers (vite:preloadError), without swallowing the rejection',
  /addEventListener\('vite:preloadError', \(\) => \{ recoverFromStaleBuild\(\) \}\)/.test(main) && !/preloadError[\s\S]{0,80}preventDefault/.test(main));

// ── 4. resume check + tap feedback ────────────────────────────────────────────────────────
const au = src('../src/components/AutoUpdater.jsx');
ok('AutoUpdater checks for a new build on returning to the foreground',
  /visibilityState === 'hidden'\) maybeReload\(\);\s*else check\(\);/.test(au));
ok('…and on a back/forward-cache restore', /addEventListener\('pageshow', onPageShow\)/.test(au) && /e\.persisted\) check\(\)/.test(au));
const fnav = src('../src/components/FloatingNav.jsx');
ok('a tapped tab lights up while its page loads', /const shownPath = pendingTo \?\? pathname;/.test(fnav)
  && /if \(to !== pathname\) setPendingTo\(to\);/.test(fnav) && /setPendingTo\(null\); \}, \[pathname\]\)/.test(fnav));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nstale-build recovery: ${pass}/${pass} passed`);
