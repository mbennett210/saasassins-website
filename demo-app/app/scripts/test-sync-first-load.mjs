// CS-672 — a first load that fails or is slow NEVER opens the app on the demo's data.
//
// THE BUG. A signed-in store starts on INITIAL_STATE — the DEMO's book: fictional customers,
// schedule and pay, with the seed's Super Admin as "you" (store/index.jsx, data/seed.js). On a
// device with no offline cache (every first sign-in, and every sign-in after a sign-out, which
// wipes it) the first read of the company's record had 8 s (store/sync.js BOOT_FETCH_TIMEOUT_MS);
// when it failed or ran over, start() REJECTED and the store "failed open onto the seed": the app
// opened on the demo book, no warning showing, nothing wired to refresh it.
//
// THE FIX. The first read fails CLOSED. A slow read keeps the loading screen (saying it is taking
// longer); a failed read, or one with no answer by BOOT_ATTEMPT_MS, shows "can't reach" and is
// tried again after a growing back-off (or at once on Retry) — and an answer that lands late still
// boots the app. start() settles only once a read answered; realtime and the backstop are wired
// only then. Nothing is saved before the first load (a sign-out from the can't-reach screen posts
// nothing). A disabled login reading its projection is signed out, not retried as "can't reach".
//
// HOW. The REAL sync engine (src/store/sync.js) against the fake Supabase of
// scripts/sync-harness.mjs, on its virtual clock; plus the store's own source for the one branch
// the harness cannot run (store/index.jsx's React effect).
//
//   node app/scripts/test-sync-first-load.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createSyncHarness } from './sync-harness.mjs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — this repo's suites disagree, so it is stated.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// The real timer, taken before the harness swaps in its virtual clock.
const watchdog = setTimeout(() => { console.error('test-sync-first-load: timed out'); process.exit(1); }, 90000);
watchdog.unref();

const h = await createSyncHarness();
// NAMESPACE import: a constant or method the pre-fix tree lacks fails as its own named check.
const sync = await import('../src/store/sync.js');
const stateApi = await import('../src/lib/stateApi.js');
const { createExternalStore } = await import('../src/store/externalStore.js');
const { ACTIONS } = await import('../src/store/reducer.js');
const { INITIAL_STATE, productionInitialState } = await import('../src/data/seed.js');
const { seedPermissions } = await import('../src/lib/roles.js');

// The source of truth for the timings (the fallbacks only let the pre-fix tree run to its failures).
const SLOW_MS = sync.BOOT_SLOW_MS ?? 8000;
const ATTEMPT_MS = sync.BOOT_ATTEMPT_MS ?? 20000;
const RETRY_BASE_MS = sync.BOOT_RETRY_BASE_MS ?? 2000;
const RETRY_MAX_MS = sync.BOOT_RETRY_MAX_MS ?? 30000;

const ORG = '00000000-0000-0000-0000-000000000001';
const LOGINS = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  'tok-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
};
const COMPANY_CUSTOMER = 'Acme Towers'; // the company's real customer — the demo seed has none by that name
const baseState = () => ({
  ...productionInitialState(),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: 'owner@cs.co', pay: { type: 'none' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl Crew', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 } },
  ],
  clients: [{ id: 'c1', name: COMPANY_CUSTOMER, type: 'customer', standingCrewIds: ['u_crew'] }],
  sites: [{ id: 's1', clientId: 'c1', name: COMPANY_CUSTOMER, standingCrewIds: ['u_crew'] }],
  jobs: [],
});
ok('(setup) the demo seed holds none of the company\'s customers, so "which book is on screen" is decidable',
  !(INITIAL_STATE.clients || []).some((c) => c.name === COMPANY_CUSTOMER));

const hasCompanyData = (s) => (s?.clients || []).some((c) => c.name === COMPANY_CUSTOMER);
// The boot's own read of the record (state + version + fleet controls) — not the backstop's
// `select version` poll, which starts only once the app has loaded.
const bootReads = () => h.world.log.filter((q) => q.table === 'org_state' && q.op === 'select' && /\bstate\b/.test(q.cols || '')).length;
// The projection reads only: a crew launch also asks the same route for its own window of
// cleans (`?part=jobs`, CS-677), which is not the first load of the record.
const viewReads = () => h.requests.filter((r) => r.path === '/api/state/view' && !/(^|&)part=jobs/.test(r.search || '')).length;
const minDelay = () => { const d = h.timerDelays(); return d.length ? Math.min(...d) : null; };
const orgStatePosts = () => h.requests.filter((r) => r.path === '/api/state/org-state').length;

// A signed-in tab, booted through the REAL createSyncManager — like the harness's bootTab, but
// start() is NOT awaited: what the screen sees WHILE the first read fails is the point.
function boot(token, { initial = INITIAL_STATE } = {}) {
  const login = h.world.logins.get(token);
  h.token = token;
  const store = createExternalStore(initial, h.reducer);
  let pending = [];
  const tab = { store, boots: [], settled: null };
  tab.edit = (action) => { pending.push(action); store.dispatch(action); tab.mgr.notifyChange(); };
  tab.pending = () => pending;
  tab.mgr = sync.createSyncManager({
    dispatch: store.dispatch,
    getState: store.getSnapshot,
    getPending: () => pending,
    clearPending: () => { pending = []; },
    setPending: (a) => { pending = Array.isArray(a) ? a : []; },
    userId: login.id,
    sessionEmail: login.email,
    claimOrgUserId: login.app_metadata?.org_user_id ?? null,
    claimRole: login.app_metadata?.role ?? null,
    onStatus: () => {},
    onJobsReady: () => {},
    onProblem: () => {},
    onBoot: (b) => tab.boots.push(b),
  });
  tab.started = tab.mgr.start().then(
    () => { tab.settled = 'resolved'; },
    (e) => { tab.settled = `rejected (${e?.message || e})`; },
  );
  tab.phase = () => (tab.boots.length ? tab.boots[tab.boots.length - 1].phase : null);
  tab.state = () => store.getSnapshot();
  tab.retry = () => (typeof tab.mgr.retryBoot === 'function' ? tab.mgr.retryBoot() : undefined);
  return tab;
}
const done = (tab) => { tab.mgr.stop(); h.clearTimers(); h.world.failWhen = null; h.world.beforeQuery = null; h.override = null; };

// ── A. The office's first read FAILS ──────────────────────────────────────────────────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  h.world.failWhen = (q) => q.table === 'org_state' && q.op === 'select';
  const tab = boot('tok-owner');
  await h.settle();
  ok('A1 🔴 a failed first read does not END the boot: start() neither resolves nor rejects, so there is nothing to fail open on',
    tab.settled === null, `start() ${tab.settled}`);
  ok('A2 the screen is told it cannot reach the server', tab.phase() === 'unreachable', JSON.stringify(tab.boots));
  ok('A3 nothing is wired before the company\'s data loads (no realtime channel)', h.browserClient.getChannels().length === 0,
    `${h.browserClient.getChannels().length} channel(s)`);
  ok('A4 the store still holds no company data (and the screen shows none: it is not ready)', !hasCompanyData(tab.state()));
  const r1 = bootReads();
  await h.advance(RETRY_BASE_MS - 1);
  ok('A5 nothing is tried again before the back-off', bootReads() === r1, `${bootReads() - r1} extra read(s)`);
  await h.advance(1);
  ok('A6 🔴 the read is tried again after the back-off (keeps retrying)', bootReads() === r1 + 1, `${bootReads() - r1} extra read(s)`);
  ok('A7 a second failure waits longer (the back-off grows)', minDelay() !== null && minDelay() >= 2 * RETRY_BASE_MS, `next timer in ${minDelay()} ms`);
  const r2 = bootReads();
  tab.retry();
  await h.settle();
  ok('A8 🔴 Retry tries again at once', bootReads() === r2 + 1, `${bootReads() - r2} extra read(s)`);
  ok('A9 still waiting, still never the demo book', tab.settled === null && tab.phase() === 'unreachable', `start() ${tab.settled}, ${tab.phase()}`);
  // Many failures in a row: the wait never grows past the cap.
  for (let i = 0; i < 8; i += 1) await h.advance(RETRY_MAX_MS);
  ok('A10 the back-off stops growing at BOOT_RETRY_MAX_MS', minDelay() !== null && minDelay() <= RETRY_MAX_MS && minDelay() > 0, `next timer in ${minDelay()} ms`);
  h.world.failWhen = null;
  tab.retry();
  await h.settle();
  await h.advance(0);
  ok('A11 🔴 once the read answers, the boot completes with the COMPANY\'s data', tab.settled === 'resolved' && hasCompanyData(tab.state()),
    `start() ${tab.settled}; clients ${JSON.stringify((tab.state().clients || []).map((c) => c.name))}`);
  ok('A12 … and only then are realtime and the backstop wired', h.browserClient.getChannels().length === 2,
    `${h.browserClient.getChannels().length} channel(s)`);
  const after = bootReads();
  await h.advance(RETRY_MAX_MS * 2);
  ok('A13 no boot read runs after the boot (the pending retry was cleared)', bootReads() === after, `${bootReads() - after} extra read(s)`);
  done(tab);
}

// ── B. The office's first read HANGS (a weak signal, a ~3 MB record) ────────────────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hang = true;
  h.world.beforeQuery = (q) => (hang && q.table === 'org_state' && q.op === 'select' ? gate : null);
  const tab = boot('tok-owner');
  await h.settle();
  await h.advance(SLOW_MS - 1);
  ok('B1 a slow first read keeps the loading screen', tab.settled === null && tab.phase() !== 'unreachable', `start() ${tab.settled}, ${tab.phase()}`);
  await h.advance(1);
  ok('B2 🔴 after BOOT_SLOW_MS the loader says it is taking longer — and the boot is still waiting (it used to give up at 8 s and open the demo book)',
    tab.settled === null && tab.phase() === 'slow', `start() ${tab.settled}, ${tab.phase()}`);
  await h.advance(ATTEMPT_MS - SLOW_MS);
  ok('B3 🔴 no answer by BOOT_ATTEMPT_MS: the can\'t-reach screen, a retry on its way — still never the demo book',
    tab.settled === null && tab.phase() === 'unreachable' && minDelay() !== null, `start() ${tab.settled}, ${tab.phase()}, next timer ${minDelay()}`);
  // The FIRST read finally answers (the retry has not run yet): a late answer still counts.
  hang = false;
  release();
  await h.settle();
  await h.advance(0);
  ok('B4 🔴 a late answer still boots the app, with the company\'s data (a slow link must be able to finish)',
    tab.settled === 'resolved' && hasCompanyData(tab.state()), `start() ${tab.settled}`);
  const after = bootReads();
  await h.advance(RETRY_MAX_MS * 2);
  ok('B5 … and the retry it had scheduled never runs', bootReads() === after, `${bootReads() - after} extra read(s)`);
  done(tab);
}

// ── C. A CLEANER's first read (the server-built projection, CS-002) fails, then answers ──
h.seedOrg(baseState(), { logins: LOGINS });
{
  h.override = (p) => (p === '/api/state/view' ? 'network' : null);
  const tab = boot('tok-crew');
  await h.settle();
  ok('C1 🔴 crew: a failed projection read does not end the boot either', tab.settled === null && tab.phase() === 'unreachable',
    `start() ${tab.settled}, ${tab.phase()}`);
  const v1 = viewReads();
  h.override = (p) => (p === '/api/state/view' ? { status: 200, body: { state: h.committed().state, version: h.committed().version } } : null);
  await h.advance(RETRY_BASE_MS);
  await h.advance(0);
  ok('C2 crew: the retry loads the company\'s projection and the boot completes', viewReads() === v1 + 1 && tab.settled === 'resolved'
    && hasCompanyData(tab.state()), `${viewReads() - v1} read(s), start() ${tab.settled}`);
  done(tab);
}

// ── D. A DISABLED cleaner's first read: signed out, not retried as "can't reach" ─────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  let terminal = null;
  stateApi.setTerminalAuthHandler((code) => { terminal = code; });
  h.override = (p) => (p === '/api/state/view' ? { status: 403, body: { error: 'This account is disabled.', code: 'account-disabled' } } : null);
  const tab = boot('tok-crew');
  await h.settle();
  ok('D1 a 403 account-disabled on the first read hands the login to the sign-out', terminal === 'account-disabled', `handler got ${terminal}`);
  ok('D2 … and the app is not opened', tab.settled !== 'resolved' && !hasCompanyData(tab.state()), `start() ${tab.settled}`);
  stateApi.setTerminalAuthHandler(null);
  done(tab);
}

// ── E. A boot stopped while it waits (sign-out, a remount) stops trying ───────────────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  h.world.failWhen = (q) => q.table === 'org_state' && q.op === 'select';
  const tab = boot('tok-owner');
  await h.settle();
  tab.mgr.stop();
  await h.settle();
  const before = bootReads();
  await h.advance(RETRY_MAX_MS * 3);
  ok('E1 a stopped boot makes no further attempt', bootReads() === before, `${bootReads() - before} extra read(s)`);
  ok('E2 … and never opens the app', tab.settled !== 'resolved' || !hasCompanyData(tab.state()));
  done(tab);
}

// ── G. Signing out from the can't-reach screen saves nothing ──────────────────────────────
// Before the first load nothing can have been edited (no screen was shown), so the sign-out's
// last flush must not save: the only "local state" is the demo seed placeholder.
h.seedOrg(baseState(), { logins: LOGINS });
{
  h.world.failWhen = (q) => q.table === 'org_state' && q.op === 'select';
  const tab = boot('tok-owner');
  await h.settle();
  const p0 = orgStatePosts();
  const flushing = sync.flushSyncBeforeSignOut(15000);
  await h.advance(16000);
  const clean = await flushing;
  ok('G1 🔴 a sign-out before the first load posts NOTHING to the shared record (the demo seed placeholder is never sent)',
    orgStatePosts() === p0, `${orgStatePosts() - p0} save(s) sent`);
  ok('G2 … and reports nothing unsaved (nothing could have been edited)', clean === true, `flush answered ${clean}`);
  ok('G3 … and the committed record is untouched', !h.committed().state.currentUserId && h.committed().version === 1, `version ${h.committed().version}`);
  done(tab);
}
// The gate holds back the placeholder, never a person's edit: when the session's claim changes
// mid-use, a NEW manager boots under a screen that is already showing the company's data, and an
// edit made meanwhile still goes to the server (as it did before this change).
h.seedOrg(baseState(), { logins: LOGINS });
{
  h.world.failWhen = (q) => q.table === 'org_state' && q.op === 'select';
  const tab = boot('tok-owner', { initial: { ...INITIAL_STATE, ...baseState() } });
  await h.settle();
  const p0 = orgStatePosts();
  tab.edit({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { name: `${COMPANY_CUSTOMER} North` } });
  await h.advance(600);
  ok('G4 an edit waiting under a live screen is still sent while the new manager boots (only the placeholder is held back)',
    orgStatePosts() > p0 && tab.pending().length >= 1, `${orgStatePosts() - p0} save(s) sent, ${tab.pending().length} pending`);
  done(tab);
}

// ── H. The store (store/index.jsx): the fail-open branch is gone ──────────────────────────
// The React effect cannot run under node, so its source is read: the ONLY way to `ready` is a
// start() that RESOLVED. A rejected start shows the can't-reach screen instead.
{
  const raw = readFileSync(new URL('../src/store/index.jsx', import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const startAt = src.indexOf('.start()');
  const chain = startAt >= 0 ? src.slice(startAt, src.indexOf('return () =>', startAt)) : '';
  const catchAt = chain.indexOf('.catch(');
  const thenPart = catchAt >= 0 ? chain.slice(0, catchAt) : chain;
  const catchPart = catchAt >= 0 ? chain.slice(catchAt) : '';
  ok('H1 the store boots through start() and becomes ready when it RESOLVES', /\.then\([\s\S]*setReady\(true\)/.test(thenPart), thenPart.slice(0, 200));
  ok('H2 🔴 a REJECTED start never makes the store ready (no fail open onto the seed)', !!catchPart && !/setReady\(true\)/.test(catchPart), catchPart.slice(0, 240));
  ok('H3 … the store hands the boot\'s phase to the screen (onBoot) and renders the boot screen until ready',
    /onBoot\s*:/.test(src) && /<BootScreen\b/.test(src) && /if \(!ready\) return <BootScreen\b/.test(src));
  ok('H4 the old loader is gone (replace means delete)', !/FullScreenLoader/.test(raw) && !/Loading your workspace/.test(raw));
}

// ── I. The boot screen: its words from the catalog, the brand from the brand file ─────────
{
  const path = new URL('../src/components/BootScreen.jsx', import.meta.url);
  const src = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const en = readFileSync(new URL('../src/i18n/catalog/en.js', import.meta.url), 'utf8');
  ok('I1 the boot screen exists', !!src);
  const keys = [...src.matchAll(/t\('(boot\.[\w.]+)'/g)].map((m) => m[1]);
  ok('I2 its words are catalog lines that exist (loading, slow, can\'t reach, retry, sign out)',
    ['boot.loading', 'boot.slow', 'boot.unreachableTitle', 'boot.unreachableLead', 'boot.retry', 'boot.signOut'].every((k) => keys.includes(k) && en.includes(`'${k}':`)),
    `uses ${JSON.stringify(keys)}`);
  ok('I3 the app\'s name comes from the brand file (IDENTITY.product), never a literal', /IDENTITY\.product\.name/.test(src) && !/Clean Corner|Clean Space/.test(src));
  ok('I4 Retry and Sign out are buttons wired to the store\'s handlers', /onClick=\{onRetry\}/.test(src) && /onSignOut/.test(src));
  const coverage = readFileSync(new URL('./test-i18n-coverage.mjs', import.meta.url), 'utf8');
  ok('I5 it is on the converted list, so no English literal can creep in', coverage.includes("'src/components/BootScreen.jsx'"));
}

console.log(`\ntest-sync-first-load: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
