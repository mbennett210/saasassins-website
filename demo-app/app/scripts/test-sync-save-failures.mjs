// CS-009 — a save that fails is retried LATER, through the server, with the failure showing.
// Nothing ever writes org_state or public.jobs around the server routes.
//
// THE BUG. lib/stateApi.js treated only a 409 and a guard refusal as answers; every other
// outcome — an expired session, a 500, a missing route, a 413, a timeout, no network — "fell
// back" to a DIRECT supabase write. Since Increment 1e revoked the browser's write policies that
// update matches no row and reports no error, so store/sync.js read it as a CAS conflict:
// adopt, replay, save again in 600 ms — for ever, under "Saving…". The jobs mirror did the same
// with a direct upsert / DELETE, and a removal-only chunk "succeeded" (the database filtered
// the DELETE out and said nothing), so the baseline advanced and a deleted clean came back on
// the next load. A first-run seed fell back to a direct upsert the same way.
//
// THE FIX. The fallback is deleted. Every non-2xx is classified once (stateApi): the edits stay
// pending, the save is retried after a growing backoff (5 s, 10, 20 … 60), the status says
// `offline` (no answer) or `error` (the server answered and did not accept it), and a 413 — which
// no retry can fix — is also TOLD as a blocking message, once.
//
// HOW. The REAL sync engine against the REAL routes, offline, through scripts/sync-harness.mjs.
//
//   node app/scripts/test-sync-save-failures.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createSyncHarness } from './sync-harness.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// The real timer, taken before the harness swaps in its virtual clock.
const watchdog = setTimeout(() => { console.error('test-sync-save-failures: timed out'); process.exit(1); }, 90000);
watchdog.unref();

const h = await createSyncHarness();
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS } = await import('../src/store/reducer.js');

const ORG = '00000000-0000-0000-0000-000000000001';
const LOGINS = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  'tok-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
};
const day = (n, hr) => new Date(Date.now() + n * 86400000 + hr * 3600000).toISOString();
const baseState = () => ({
  ...productionInitialState(),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl Crew', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0003' } },
  ],
  clients: [{ id: 'c1', name: 'Acme Towers', type: 'customer', standingCrewIds: [] }],
  sites: [{ id: 's1', clientId: 'c1', name: 'Acme Towers', standingCrewIds: [] }],
  jobs: [],
});
const JOBS = () => [
  { id: 'j1', clientId: 'c1', siteId: 's1', startAt: day(3, 0), endAt: day(3, 2), status: 'upcoming', crewIds: ['u_crew'], notes: '' },
  { id: 'j2', clientId: 'c1', siteId: 's1', startAt: day(4, 0), endAt: day(4, 2), status: 'upcoming', crewIds: ['u_crew'], notes: '' },
];
const clientName = (state) => (state?.clients || []).find((c) => c.id === 'c1')?.name;
const answer = (path, status, body) => (p) => (p === path ? { status, body } : null);
const ORG_STATE = '/api/state/org-state';
const JOBS_DELTA = '/api/state/jobs-delta';
const directOrgState = () => h.directWrites.filter((w) => w.table === 'org_state');
const directJobs = () => h.directWrites.filter((w) => w.table === 'jobs');
const minDelay = () => { const d = h.timerDelays(); return d.length ? Math.min(...d) : null; };

// ── 1. A 500 from the save route ──────────────────────────────────────────────────────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  const tab = await h.bootTab('tok-owner');
  h.override = answer(ORG_STATE, 500, { error: 'Write failed' });
  tab.dispatchLocal({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { name: 'Acme Towers North' } });
  await h.advance(600);
  ok('1.1 no direct org_state write is attempted', directOrgState().length === 0, JSON.stringify(h.directWrites));
  ok('1.2 the status shows an error (not "saving", not "synced")', tab.status() === 'error', `status ${tab.status()}`);
  ok('1.3 the retry is BACKED OFF (≥ 5 s), not a 600 ms loop', minDelay() !== null && minDelay() >= 5000, `next timer in ${minDelay()} ms`);
  ok('1.4 the edit is still pending', tab.pending().length === 1, `${tab.pending().length} pending`);
  ok('1.5 …and still on screen', clientName(tab.state()) === 'Acme Towers North');
  const posts1 = h.requests.filter((r) => r.path === ORG_STATE).length;
  await h.advance(4000);
  ok('1.6 nothing is sent again before the backoff runs out', h.requests.filter((r) => r.path === ORG_STATE).length === posts1);
  await h.advance(1000);
  ok('1.7 the retry comes after the backoff', h.requests.filter((r) => r.path === ORG_STATE).length === posts1 + 1);
  ok('1.8 a second failure backs off further (≥ 10 s)', minDelay() !== null && minDelay() >= 10000, `next timer in ${minDelay()} ms`);
  h.override = null;
  await h.advance(10000);
  ok('1.9 once the server is back, the edit saves', clientName(h.committed().state) === 'Acme Towers North', `server "${clientName(h.committed().state)}"`);
  ok('1.10 …nothing is left pending, and the status settles', tab.pending().length === 0 && tab.status() === 'synced', `${tab.pending().length} pending, ${tab.status()}`);
  ok('1.11 still no direct write after all that', h.directWrites.length === 0);
  tab.stop();
  h.clearTimers();
}

// ── 2. A 413 (the shared record over its size limit) ─────────────────────────────────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  const tab = await h.bootTab('tok-owner');
  h.override = answer(ORG_STATE, 413, { error: 'body is 3700 KB, over the 3584 KB limit' });
  tab.dispatchLocal({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { name: 'Acme 413' } });
  await h.advance(600);
  ok('2.1 no direct org_state write is attempted', directOrgState().length === 0, JSON.stringify(h.directWrites));
  ok('2.2 the status shows an error', tab.status() === 'error', `status ${tab.status()}`);
  ok('2.3 the retry is backed off', minDelay() !== null && minDelay() >= 5000, `next timer in ${minDelay()} ms`);
  const told = tab.problems.filter((p) => p && p.kind === 'tooLarge');
  ok('2.4 the person is TOLD, in a blocking message, with the server\'s words', told.length === 1 && /3700 KB/.test(told[0]?.error || ''), JSON.stringify(tab.problems));
  ok('2.5 the edit is kept', tab.pending().length === 1 && clientName(tab.state()) === 'Acme 413');
  await h.advance(5000);
  ok('2.6 a second 413 does not repeat the message', tab.problems.filter((p) => p && p.kind === 'tooLarge').length === 1);
  tab.stop();
  h.clearTimers();
}

// ── 3. Not signed in (401) and no answer at all (offline) ────────────────────────────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  const tab = await h.bootTab('tok-owner');
  h.override = answer(ORG_STATE, 401, { error: 'Authentication required' });
  tab.dispatchLocal({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { name: 'Acme 401' } });
  await h.advance(600);
  ok('3.1 a 401: no direct write, an error, a backed-off retry', directOrgState().length === 0 && tab.status() === 'error' && minDelay() >= 5000,
    `${JSON.stringify(h.directWrites)} ${tab.status()} ${minDelay()}`);
  h.override = (p) => (p === ORG_STATE ? 'network' : null);
  await h.advance(10000);
  ok('3.2 no answer at all: no direct write, OFFLINE (the edits wait on the device), backed off', directOrgState().length === 0 && tab.status() === 'offline' && minDelay() >= 5000,
    `${JSON.stringify(h.directWrites)} ${tab.status()} ${minDelay()}`);
  ok('3.3 the edit is still pending through both', tab.pending().length === 1);
  tab.stop();
  h.clearTimers();
}

// ── 4. The jobs mirror: a 500 never becomes a direct write, and a delete is not "done" until the server says so
h.seedOrg(baseState(), { logins: LOGINS, jobs: JOBS() });
{
  const tab = await h.bootTab('tok-owner');
  await h.advance(100);
  ok('4.0 the tab loaded both cleans', (tab.state().jobs || []).length === 2);
  // 4a. A REMOVAL-ONLY delta: the one a filtered DELETE used to "succeed" through.
  h.override = answer(JOBS_DELTA, 500, { error: 'Write failed' });
  tab.dispatchLocal({ type: ACTIONS.DELETE_JOB, id: 'j2' });
  await h.advance(600);
  ok('4.1 no direct jobs write is attempted', directJobs().length === 0, JSON.stringify(h.directWrites));
  ok('4.2 the status shows an error', tab.status() === 'error', `status ${tab.status()}`);
  ok('4.3 the retry is backed off', minDelay() !== null && minDelay() >= 5000, `next timer in ${minDelay()} ms`);
  h.override = null;
  await h.advance(6000);
  await h.advance(600);
  ok('4.4 once the server is back, the deleted clean is deleted in the jobs table (not "succeeded" through a filtered DELETE and lost)',
    !h.world.tables.jobs.some((r) => r.id === 'j2'), JSON.stringify(h.world.tables.jobs.map((r) => r.id)));
  // 4b. An edit.
  h.override = answer(JOBS_DELTA, 500, { error: 'Write failed' });
  tab.dispatchLocal({ type: ACTIONS.UPDATE_JOB, id: 'j1', patch: { notes: 'bring the ladder' } });
  await h.advance(600);
  ok('4.5 an edit that fails: no direct jobs write either', directJobs().length === 0, JSON.stringify(h.directWrites));
  h.override = null;
  await h.advance(6000);
  await h.advance(600);
  ok('4.6 …and it reaches the jobs table once the server is back', h.world.tables.jobs.find((r) => r.id === 'j1')?.data?.notes === 'bring the ladder',
    JSON.stringify(h.world.tables.jobs.map((r) => [r.id, r.data?.notes])));
  ok('4.7 the status settles', tab.status() === 'synced', `status ${tab.status()}`);
  tab.stop();
  h.clearTimers();
}

// ── 5. A crew login (CS-002 projection): the same rules, and never a direct write ─────────
h.seedOrg(baseState(), { logins: LOGINS });
{
  // A crew tab reads the projection through /api/state/view; serve it the committed blob — and,
  // for its launch's own window of cleans (`?part=jobs`, CS-677), none.
  const bounds = (await import('../src/lib/jobsWindow.js')).jobsWindowBounds();
  const win = { jobs: [], highWater: 0, from: bounds.fromIso, to: bounds.toIso };
  const prevOverride = (p) => (p === '/api/state/view' ? { status: 200, body: { state: h.committed().state, version: h.committed().version, ...win } } : null);
  h.override = prevOverride;
  const tab = await h.bootTab('tok-crew');
  h.override = (p) => prevOverride(p) || (p === ORG_STATE ? { status: 503, body: { error: 'Service unavailable' } } : null);
  tab.dispatchLocal({ type: ACTIONS.UPDATE_USER, id: 'u_crew', patch: { phone: '555-0199' } });
  await h.advance(600);
  ok('5.1 a crew save that fails: no direct write, an error, backed off', h.directWrites.length === 0 && tab.status() === 'error' && minDelay() >= 5000,
    `${JSON.stringify(h.directWrites)} ${tab.status()} ${minDelay()}`);
  tab.stop();
  h.clearTimers();
}

// ── 6. A brand-new org whose first-run seed fails ─────────────────────────────────────────
h.seedOrg(baseState(), { logins: LOGINS, noRow: true });
{
  h.override = answer('/api/state/seed', 500, { error: 'Seed failed' });
  const tab = await h.bootTab('tok-owner');
  ok('6.1 a failed seed is not worked around with a direct upsert', directOrgState().length === 0, JSON.stringify(h.directWrites));
  tab.stop();
  h.clearTimers();
}

// ── 7. No browser module writes org_state or public.jobs at all ──────────────────────────
{
  const root = new URL('../src/', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = new URL(name, dir);
      if (statSync(p).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(jsx?|mjs)$/.test(name)) files.push(p);
    }
  };
  walk(root);
  const offenders = [];
  for (const f of files) {
    // Code only: a comment may NAME the write it no longer makes.
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const re = /\.from\(\s*['"](org_state|jobs)['"]\s*\)([\s\S]{0,400})/g;
    for (const m of src.matchAll(re)) {
      // The statement this .from() starts: up to its first `;` or the next .from(.
      const stmt = m[2].split(/;|\.from\(/)[0];
      if (/\.(update|upsert|insert|delete)\s*\(/.test(stmt)) offenders.push(`${f.pathname.split('/src/')[1]} → ${m[1]}`);
    }
  }
  ok('7.1 no file under app/src writes org_state or public.jobs directly', offenders.length === 0, offenders.join(', '));
  const readOr = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };
  const stateApi = readOr('../src/lib/stateApi.js');
  ok("7.2 stateApi has no 'unavailable' answer left to fall back on", !/unavailable/.test(stateApi.replace(/\/\/.*$/gm, '')));
  const indicator = readOr('../src/components/SyncIndicator.jsx');
  const en = readOr('../src/i18n/catalog/en.js');
  ok('7.3 the indicator shows the error state in words', /'error'/.test(indicator) && /t\('sync\.error'\)/.test(indicator) && /'sync\.error':/.test(en));
  const dialog = readOr('../src/components/SyncProblemDialog.jsx');
  ok('7.4 the blocking message covers the size limit', /tooLarge/.test(dialog) && /'syncProblem\.tooLargeTitle':/.test(en));
}

console.log(`\ntest-sync-save-failures: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
