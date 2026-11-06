// Locating imported buildings, through the REAL sync engine (offline): ONE action, ONE save.
//
// WHY. After an import, Customers → Import customers locates its buildings a hundred at a time.
// It used to dispatch one UPDATE_SITE per building in a loop. In the normal path the sync
// engine's 600 ms debounce folded those into ONE save — but a save the server refuses is
// replayed ONE ACTION AT A TIME to find the refused change (CS-008, store/sync.js
// isolateRefusedBatch), and every replayed action that changes the shared record is a full save
// of it. A locate run of 100 sharing its batch with one refused change became 102 saves of the
// whole record (about 1.45 MB each with 750 buildings). A locate run is now ONE action,
// LOCATE_BUILDINGS: one pending entry, one save, one line if it is ever refused. A result whose
// building's address changed while the lookup ran is not applied (the coordinates belong to the
// old address, CS-041).
//
// HOW. The REAL engine (src/store/sync.js + src/lib/stateApi.js) against the REAL save route
// (api/state/org-state.js and its guard) through scripts/sync-harness.mjs, the import built by
// the real engine (src/lib/customerImport.js) from the 750-building sample file.
//
//   node app/scripts/test-customer-import-locate.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { createSyncHarness, ORG } from './sync-harness.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// The real timer, taken before the harness swaps in its virtual clock.
const watchdog = setTimeout(() => { console.error('test-customer-import-locate: timed out'); process.exit(1); }, 120000);
watchdog.unref();

const h = await createSyncHarness();
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS, reducer } = await import('../src/store/reducer.js');
const { parseCsv } = await import('../src/lib/csv.js');
const { resolveGeocodeMany, GEOCODE_STATUS } = await import('../src/lib/geocodeLocation.js');
const { sampleBuildingsCsv } = await import('./customer-import-sample.mjs');
const { describeRefusedAction } = await import('../src/store/syncProblems.js');
const { english } = await import('../src/i18n/core.js');
let ci = {};
try { ci = await import('../src/lib/customerImport.js'); } catch (e) { fails.push(`src/lib/customerImport.js loads (${e.message.split('\n')[0]})`); }
const has = (name) => typeof ci[name] === 'function';

const LOGINS = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  // A manager pared off "Create / edit customers": their new customer is refused at the save.
  'tok-mgr-nocust': { id: 'a-mgr2', email: 'mgr2@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr2', org_id: ORG } },
};

// The 750-building book, imported by the real engine onto a production-shaped record.
let n = 0;
const newId = (p = 'id') => `${p}_loc${(n += 1)}`;
function importedBook(buildings = 750) {
  const base = {
    ...productionInitialState(),
    permissions: seedPermissions(),
    userPermissionOverrides: [{ userId: 'u_mgr2', grants: [], revokes: ['clients.edit'] }],
    users: [
      { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
      { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Milo Manager', email: 'mgr2@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0002' } },
    ],
    clients: [], sites: [], contacts: [], jobs: [],
  };
  if (!has('planCustomerImport')) return base;
  const f = parseCsv(sampleBuildingsCsv({ buildings, contactsPerBuilding: 2 }));
  const plan = ci.planCustomerImport({ rows: f.rows, mapping: ci.guessImportMapping(f.headers), state: base, perms: { canImport: true, canContacts: true, canAssignSupervisor: true } });
  return reducer(base, { type: ACTIONS.IMPORT_CUSTOMERS, ops: ci.buildImportOps(plan, { newId }) });
}
// A geocoder that answers every address (no network): a point per address.
const fakeGeocode = async (address) => ({ lat: 26 + (address.length % 50) / 100, lng: -80 - (address.length % 40) / 100 });
// What the screen does after an import: up to 100 buildings, one locate run, one dispatch.
async function locateRun(state) {
  const items = (has('locatableLocations') ? ci.locatableLocations(state) : []).slice(0, 100);
  const res = await resolveGeocodeMany(items, { geocode: fakeGeocode, stopWhenUnavailable: true });
  const results = has('locateResults') ? ci.locateResults(items, res.patches) : [];
  return { items, res, action: { type: ACTIONS.LOCATE_BUILDINGS, results } };
}
const saves = () => h.requests.filter((r) => r.path === '/api/state/org-state' && r.method === 'POST');
const located = (state) => (state?.sites || []).filter((s) => s.geocodeStatus === GEOCODE_STATUS.LOCATED).length;
// Every save's body, as the browser sent it.
const bodies = [];
const watchSaves = () => {
  bodies.length = 0;
  h.override = (path, init) => {
    if (path === '/api/state/org-state' && (init?.method || 'GET') === 'POST') bodies.push(Buffer.byteLength(String(init.body || '')));
    return null; // the real route answers
  };
};

ok('0.1 the store has ONE action for a locate run, LOCATE_BUILDINGS', typeof ACTIONS.LOCATE_BUILDINGS === 'string');
ok('0.2 the engine pairs each answer with the address it was looked up for (locateResults)', has('locateResults'));

// ── 1. A locate run of 100 buildings is ONE pending action and ONE save ────────────────────
const book = importedBook(750);
h.seedOrg(book, { logins: LOGINS });
{
  const tab = await h.bootTab('tok-owner');
  ok('1.0 the tab boots on the imported book (750 buildings, none located)', (tab.state().sites || []).length >= 750 && located(tab.state()) === 0,
    `${(tab.state().sites || []).length} sites, ${located(tab.state())} located`);
  const run = await locateRun(tab.state());
  ok('1.1 the run asked for 100 buildings and every one answered', run.items.length === 100 && run.res.patches.length === 100, `${run.items.length} / ${run.res.patches.length}`);
  watchSaves();
  h.requests.length = 0;
  tab.dispatchLocal(run.action);
  ok('1.2 the whole run is ONE pending action', tab.pending().length === 1, `${tab.pending().length} pending`);
  await h.advance(600);
  await h.advance(600);
  ok('1.3 …and ONE save', saves().length === 1, JSON.stringify(saves()));
  ok('1.4 the server has the 100 buildings located', located(h.committed().state) === 100, `${located(h.committed().state)} located on the server`);
  ok('1.5 nothing is left pending', tab.pending().length === 0);
  console.log(`  locate run of 100 at 750 buildings: ${saves().length} save(s), ${bodies.map((b) => `${b} bytes`).join(', ')}`);
  tab.stop();
  h.clearTimers();
}

// ── 2. Beside a refused change, the run is still ONE save (not one per building) ───────────
// A manager pared off "Create / edit customers" adds a customer in the same breath as the
// locate run lands. The server refuses that save; the engine replays the batch one action at a
// time. The run is one action, so it is one save, and only the new customer is reported.
h.seedOrg(importedBook(750), { logins: LOGINS });
{
  const tab = await h.bootTab('tok-mgr-nocust');
  const run = await locateRun(tab.state());
  watchSaves();
  h.requests.length = 0;
  tab.dispatchLocal(run.action);
  tab.dispatchLocal({ type: ACTIONS.ADD_CLIENT, client: { id: 'cl_refused', name: 'Refused Plaza', type: 'customer' } });
  await h.advance(600);
  await h.advance(600);
  await h.advance(600);
  ok('2.1 the batch took three saves: the refused one, the locate run, the refused change alone', saves().length === 3,
    `${saves().length} saves: ${JSON.stringify(saves().map((r) => r.status))}`);
  ok('2.2 the 100 buildings are located on the server', located(h.committed().state) === 100, `${located(h.committed().state)} located`);
  ok('2.3 the refused customer is not', !(h.committed().state.clients || []).some((c) => c.id === 'cl_refused'));
  const refused = tab.problems.filter((p) => p && p.kind === 'refused').flatMap((p) => p.refused || []);
  ok('2.4 only the new customer is reported as not saved', refused.length === 1 && refused[0]?.action?.type === ACTIONS.ADD_CLIENT,
    JSON.stringify(refused.map((r) => r?.action?.type)));
  console.log(`  beside a refused change: ${saves().length} saves, ${bodies.map((b) => `${b} bytes`).join(', ')}`);
  tab.stop();
  h.clearTimers();
}

// ── 3. An answer for an address that changed meanwhile is not applied ──────────────────────
{
  const state = importedBook(5);
  const items = has('locatableLocations') ? ci.locatableLocations(state) : [];
  const res = await resolveGeocodeMany(items, { geocode: fakeGeocode });
  const moved = items[0]?.id;
  // Someone fixed the first building's address while the lookup ran.
  const edited = reducer(state, { type: ACTIONS.UPDATE_SITE, id: moved, patch: { street: '77 New Rd', address: '77 New Rd, Miami FL 33131' } });
  const after = reducer(edited, { type: ACTIONS.LOCATE_BUILDINGS, results: has('locateResults') ? ci.locateResults(items, res.patches) : [] });
  const site = (id) => (after.sites || []).find((s) => s.id === id);
  ok('3.1 the building whose address changed keeps no coordinates from the old address', site(moved) && site(moved).lat == null && site(moved).geocodeStatus !== GEOCODE_STATUS.LOCATED,
    JSON.stringify(site(moved)));
  ok('3.2 the others are located', items.slice(1).every((it) => site(it.id)?.geocodeStatus === GEOCODE_STATUS.LOCATED), JSON.stringify(items.slice(1).map((it) => site(it.id)?.geocodeStatus)));
  const again = reducer(after, { type: ACTIONS.LOCATE_BUILDINGS, results: has('locateResults') ? ci.locateResults(items, res.patches) : [] });
  ok('3.3 replaying the run changes nothing more (a replayed save is harmless)', JSON.stringify(again.sites) === JSON.stringify(after.sites));
  // A refused run reads as one line in the "not saved" message, never a raw action type.
  const said = describeRefusedAction({ type: ACTIONS.LOCATE_BUILDINGS, results: (has('locateResults') ? ci.locateResults(items, res.patches) : []) }, after);
  ok('3.4 a refused locate run is ONE named line in the "not saved" message', said?.key === 'syncProblem.change.locate' && english(said.key, said.params) === `Locating ${items.length} buildings on the map`,
    JSON.stringify(said));
}

clearTimeout(watchdog);
console.log(`\ntest-customer-import-locate: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
