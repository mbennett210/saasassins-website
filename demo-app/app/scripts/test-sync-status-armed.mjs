// CS-952 — the save status says 'synced' only when nothing is waiting to be saved.
//
// THE BUG. A save that landed said 'synced' whenever it hadn't been marked for a follow-up, even with
// the NEXT save already armed on its 600 ms debounce (an edit made while the first was in flight).
// So the status read 'synced' before that edit was sent, and when it did land the status was already
// 'synced': nothing changed, and nothing listening heard of it. The location's QR codes listen for
// exactly that change (components/AreaScanCodes asks the server for a new area's code once the save
// has landed): Matt adds his areas from the QR codes page while an earlier save is still in flight,
// and the codes never come.
//
// THE FIX (store/sync.js). The save's timer forgets itself as it fires (armSave), so `saveTimer` says
// whether a save is waiting, and a save that lands says 'synced' only with none waiting.
//
// HOW. The REAL sync engine against the REAL save route, offline, through scripts/sync-harness.mjs; the
// first save's POST is held at a gate so the second edit is made while it is in flight.
//
//   node app/scripts/test-sync-status-armed.mjs
import { readFileSync } from 'node:fs';
import { createSyncHarness } from './sync-harness.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// The real timer, taken before the harness swaps in its virtual clock.
const watchdog = setTimeout(() => { console.error('test-sync-status-armed: timed out'); process.exit(1); }, 90000);
watchdog.unref();

const h = await createSyncHarness();
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS } = await import('../src/store/reducer.js');

const ORG = '00000000-0000-0000-0000-000000000001';
const LOGINS = { 'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } } };
const baseState = () => ({
  ...productionInitialState(),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  users: [{ id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: 'owner@cs.co', pay: { type: 'none' } }],
  clients: [{ id: 'c1', name: 'Acme Towers', type: 'customer' }],
  sites: [{ id: 's1', clientId: 'c1', name: 'Acme Towers', cleaningAreas: [] }],
  jobs: [],
});
const savedAreas = () => (h.committed().state.sites || []).find((s) => s.id === 's1')?.cleaningAreas || [];
const TWO_AREAS = { type: ACTIONS.UPDATE_SITE, id: 's1', patch: { cleaningAreas: [{ id: 'a1', label: 'Lobby' }, { id: 'a2', label: 'Restroom 1' }] } };

// One run: `first` is dispatched and its save held in flight; the card's Save Changes (TWO_AREAS, as
// CleaningInstructionsCard.save dispatches it) is made meanwhile; then the first lands and the second
// is sent. Returns what the status said at each step.
async function overlap(first) {
  h.seedOrg(baseState(), { logins: LOGINS });
  const tab = await h.bootTab('tok-owner');
  const realFetch = globalThis.fetch;
  let gate = null;
  globalThis.fetch = async (url, init = {}) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (gate && p === '/api/state/org-state' && (init.method || 'GET') === 'POST') { const g = gate; gate = null; await g.p; }
    return realFetch(url, init);
  };
  let release;
  gate = { p: new Promise((r) => { release = r; }) };
  try {
    tab.dispatchLocal(first);
    await h.advance(600);                 // the first save's debounce fires; its POST waits at the gate
    tab.dispatchLocal(TWO_AREAS);         // the areas, saved while it is in flight
    const fromB = tab.statuses.length;
    release();
    await h.settle();                     // the first save lands; the second is still armed
    const afterFirst = { status: tab.status(), saved: savedAreas().length, armed: h.timerDelays().length > 0, since: tab.statuses.slice(fromB) };
    await h.advance(600);                 // the second save's debounce fires
    await h.settle();
    const end = { status: tab.status(), saved: savedAreas().length, since: tab.statuses.slice(fromB) };
    return { afterFirst, end };
  } finally {
    globalThis.fetch = realFetch;
    tab.stop();
  }
}

// ── 1. An unrelated edit in flight when the areas are saved ──────────────────────────────────────
{
  const r = await overlap({ type: ACTIONS.UPDATE_SITE, id: 's1', patch: { name: 'Acme Towers East' } });
  ok('1.1 (setup) the areas are not saved yet when the first save lands, and their save is armed', r.afterFirst.saved === 0 && r.afterFirst.armed, JSON.stringify(r.afterFirst));
  ok("1.2 🔴 the status doesn't say synced while the areas wait to be sent", r.afterFirst.status !== 'synced' && !r.afterFirst.since.includes('synced'), JSON.stringify(r.afterFirst));
  ok('1.3 the areas land', r.end.saved === 2, JSON.stringify(r.end));
  ok('1.4 🔴 …and only then does it say synced (the change the QR codes wait for)', r.end.status === 'synced' && r.end.since.indexOf('synced') === r.end.since.length - 1, JSON.stringify(r.end));
}

// ── 2. Two quick saves of the areas (the first still in flight) ──────────────────────────────────
{
  const r = await overlap({ type: ACTIONS.UPDATE_SITE, id: 's1', patch: { cleaningAreas: [{ id: 'a1', label: 'Lobby' }] } });
  ok("2.1 🔴 the first areas save landing doesn't say synced while the second waits", r.afterFirst.status !== 'synced' && !r.afterFirst.since.includes('synced'), JSON.stringify(r.afterFirst));
  ok('2.2 the second lands with both areas, then synced', r.end.saved === 2 && r.end.status === 'synced', JSON.stringify(r.end));
}

// ── 3. One save alone still ends synced (nothing held back for ever) ──────────────────────────────
{
  h.seedOrg(baseState(), { logins: LOGINS });
  const tab = await h.bootTab('tok-owner');
  try {
    tab.dispatchLocal(TWO_AREAS);
    ok('3.1 an edit says saving', tab.status() === 'saving', tab.statuses.join(' > '));
    await h.advance(600);
    await h.settle();
    ok('3.2 …and synced once it lands, with no timer left armed', tab.status() === 'synced' && savedAreas().length === 2 && h.timerDelays().length === 0, `${tab.statuses.join(' > ')} · timers ${JSON.stringify(h.timerDelays())}`);
  } finally {
    tab.stop();
  }
}

// ── 4. The rule in the code ───────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../src/store/sync.js', import.meta.url), 'utf8');
  ok('4.1 the save timer forgets itself as it fires', /saveTimer = setTimeout\(\(\) => \{ saveTimer = null; flush\(\); \}, ms\)/.test(src));
  ok("4.2 every save that lands says synced only with none armed", (src.match(/if \(!dirty && !saveTimer\) setStatus\('synced'\)/g) || []).length === 2 && !/if \(!dirty\) setStatus\('synced'\)/.test(src));
}

console.log(`\ntest-sync-status-armed: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
