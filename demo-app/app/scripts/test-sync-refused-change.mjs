// CS-008 — a refused change is dropped ALONE: the rest of the pending batch still saves, and
// the person is told, in words, which change was not saved.
//
// THE BUG. store/sync.js saves whatever was edited in the last ~600 ms as ONE write. When the
// server's field guard refused that write (403 with `violations` — a manager changing a pay
// rate their access level doesn't cover, say), flush() dropped EVERY pending action in it,
// adopted the server's copy and reported "synced". The two other edits the person made in the
// same breath vanished with the refused one, and nothing on screen said so. It bites the day
// managers and cleaners get their own logins: every save the guard refuses takes its
// neighbours with it.
//
// THE FIX. On a refusal the batch is ISOLATED: starting from the server's committed state, the
// pending actions are replayed one at a time, each saved on its own; the ones the guard refuses
// are dropped and REPORTED (a blocking message names each refused change and the server's
// reason); every other one lands. A table-owned slice (jobs) that a refused action changed is
// put back to the server's copy, so a refused customer delete cannot still delete its cleans.
//
// HOW. The REAL sync engine (src/store/sync.js + src/lib/stateApi.js) against the REAL save
// route (api/state/org-state.js and its guard), offline, through scripts/sync-harness.mjs.
//
//   node app/scripts/test-sync-refused-change.mjs
import { createSyncHarness } from './sync-harness.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// The real timer, taken before the harness swaps in its virtual clock.
const watchdog = setTimeout(() => { console.error('test-sync-refused-change: timed out'); process.exit(1); }, 60000);
watchdog.unref();

const h = await createSyncHarness();
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS } = await import('../src/store/reducer.js');

const ORG = '00000000-0000-0000-0000-000000000001';
const LOGINS = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  'tok-mgr': { id: 'a-mgr', email: 'mgr@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
};
const baseState = () => ({
  ...productionInitialState(),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona Manager', email: 'mgr@cs.co', pay: { type: 'salary', salaryPerPeriod: 2800 }, hr: { employeeId: 'EMP-0002' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl Crew', email: 'crew@cs.co', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0003' } },
  ],
  clients: [{ id: 'c1', name: 'Acme Towers', type: 'customer', standingCrewIds: [] }],
  sites: [{ id: 's1', clientId: 'c1', name: 'Acme Towers', standingCrewIds: [] }],
  jobs: [],
});
const crewPay = (state) => (state.users || []).find((u) => u.id === 'u_crew')?.pay?.hourlyRate;
const client = (state, id) => (state.clients || []).find((c) => c.id === id) || null;

// ── 1. Three edits in one save; the server refuses the middle one ─────────────────────────
// A manager renames a customer, raises a cleaner's pay rate (payroll.rates.edit is the Super
// Admin's by default, so the guard refuses it) and adds a new customer — all inside one
// debounce window, so all three ride ONE save.
h.seedOrg(baseState(), { logins: LOGINS });
{
  const tab = await h.bootTab('tok-mgr');
  ok('1.0 the tab boots on the committed state', client(tab.state(), 'c1')?.name === 'Acme Towers');
  tab.dispatchLocal({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { name: 'Acme Towers North' } });
  tab.dispatchLocal({ type: ACTIONS.UPDATE_USER, id: 'u_crew', patch: { pay: { type: 'hourly', hourlyRate: 45 } } });
  tab.dispatchLocal({ type: ACTIONS.ADD_CLIENT, client: { id: 'c_new', name: 'Bayside Plaza', type: 'customer' } });
  ok('1.1 all three edits are pending before the save', tab.pending().length === 3);
  await h.advance(600);
  await h.advance(600);

  const server = h.committed().state;
  ok('1.2 the rename (edit 1) reached the server', client(server, 'c1')?.name === 'Acme Towers North', `server has "${client(server, 'c1')?.name}"`);
  ok('1.3 the new customer (edit 3) reached the server', !!client(server, 'c_new'), 'missing on the server');
  ok('1.4 the refused pay rate (edit 2) did NOT reach the server', crewPay(server) === 20, `server pay ${crewPay(server)}`);
  ok('1.5 the screen shows the two saved edits', client(tab.state(), 'c1')?.name === 'Acme Towers North' && !!client(tab.state(), 'c_new'));
  ok('1.6 the screen no longer shows the refused pay rate', crewPay(tab.state()) === 20, `screen pay ${crewPay(tab.state())}`);
  ok('1.7 nothing is left pending', tab.pending().length === 0, `${tab.pending().length} pending`);

  const problems = tab.problems.filter((p) => p && p.kind === 'refused');
  ok('1.8 the person is told a change was not saved (one blocking notice)', problems.length === 1, `${tab.problems.length} problems: ${JSON.stringify(tab.problems)}`);
  const refused = problems[0]?.refused || [];
  ok('1.9 the notice names exactly the refused change', refused.length === 1 && refused[0]?.action?.type === ACTIONS.UPDATE_USER,
    JSON.stringify(refused.map((r) => r?.action?.type)));
  ok("1.10 …with the server's reason for it", (refused[0]?.violations || []).includes("change another member's pay"),
    JSON.stringify(refused[0]?.violations));
  ok('1.11 the saved edits are not in the notice', !refused.some((r) => r?.action?.type === ACTIONS.UPDATE_CLIENT || r?.action?.type === ACTIONS.ADD_CLIENT));
  ok('1.12 no direct browser write was attempted', h.directWrites.length === 0, JSON.stringify(h.directWrites));
  tab.stop();
  h.clearTimers();
}

// ── 2. A refused change alone in its save is still reported (and nothing else is lost) ────
h.seedOrg(baseState(), { logins: LOGINS });
{
  const tab = await h.bootTab('tok-mgr');
  tab.dispatchLocal({ type: ACTIONS.UPDATE_USER, id: 'u_crew', patch: { pay: { type: 'hourly', hourlyRate: 99 } } });
  await h.advance(600);
  await h.advance(600);
  ok('2.1 the refused pay rate is not on the server', crewPay(h.committed().state) === 20);
  ok('2.2 …nor on the screen', crewPay(tab.state()) === 20);
  const problems = tab.problems.filter((p) => p && p.kind === 'refused');
  ok('2.3 one blocking notice names it', problems.length === 1 && (problems[0]?.refused || []).length === 1, JSON.stringify(tab.problems));
  ok('2.4 nothing is left pending (a refused change is not retried for ever)', tab.pending().length === 0);
  tab.stop();
  h.clearTimers();
}

// ── 3. The JOBS half of a refused change does not land either ─────────────────────────────
// A manager pared off `clients.delete` ARCHIVES a customer (a stale tab: the screen offered it
// before the matrix changed). The guard refuses the archive; ARCHIVE_CLIENT also took the
// customer's upcoming cleans off the schedule locally, and those must come back rather than be
// deleted from the jobs table by the next save. (Until CS-663 this was a customer DELETE; customers
// are archived, never deleted, and the archive carries the same jobs half.)
{
  const state = baseState();
  state.permissions = state.permissions.map((p) => (p.id === 'clients.delete' ? { ...p, roles: ['owner', 'admin'] } : p));
  const day = (n, h) => new Date(Date.now() + n * 86400000 + h * 3600000).toISOString();
  const jobs = [
    { id: 'j1', clientId: 'c1', siteId: 's1', startAt: day(3, 0), endAt: day(3, 2), status: 'upcoming', crewIds: ['u_crew'] },
    { id: 'j2', clientId: 'c1', siteId: 's1', startAt: day(4, 0), endAt: day(4, 2), status: 'upcoming', crewIds: ['u_crew'] },
  ];
  h.seedOrg(state, { logins: LOGINS, jobs });
  const tab = await h.bootTab('tok-mgr');
  await h.advance(100);
  ok('3.0 the tab loaded the customer\'s two cleans', (tab.state().jobs || []).length === 2, `${(tab.state().jobs || []).length}`);
  tab.dispatchLocal({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { notes: 'gate code changed' } });
  tab.dispatchLocal({ type: ACTIONS.ARCHIVE_CLIENT, id: 'c1', by: 'u_mgr' });
  await h.advance(600);
  await h.advance(600);
  await h.advance(600);
  // The person keeps working: the NEXT save is where a stray jobs delete would land.
  tab.dispatchLocal({ type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { name: 'Acme Towers (gate 2)' } });
  await h.advance(600);
  await h.advance(600);
  ok('3.1 the customer is still on the server, not archived', !!client(h.committed().state, 'c1') && client(h.committed().state, 'c1').statusOverride !== 'archived',
    JSON.stringify(client(h.committed().state, 'c1')));
  ok('3.2 the note saved alongside it still landed', client(h.committed().state, 'c1')?.notes === 'gate code changed', `notes "${client(h.committed().state, 'c1')?.notes}"`);
  ok('3.3 the customer is back on the screen, not archived', !!client(tab.state(), 'c1') && client(tab.state(), 'c1').statusOverride !== 'archived');
  ok("3.4 the customer's cleans are still in the jobs table", h.world.tables.jobs.length === 2, `${h.world.tables.jobs.length} rows`);
  ok("3.5 the customer's cleans are back on the screen", (tab.state().jobs || []).length === 2, `${(tab.state().jobs || []).length} on screen`);
  const problems = tab.problems.filter((p) => p && p.kind === 'refused');
  ok('3.6 the notice names the customer archive', (problems[0]?.refused || []).some((r) => r?.action?.type === ACTIONS.ARCHIVE_CLIENT), JSON.stringify(tab.problems));
  tab.stop();
  h.clearTimers();
}

// ── 4. The message's words, and that the message is mounted ───────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  let P = null;
  try { P = await import('../src/store/syncProblems.js'); } catch { P = null; }
  ok('4.1 the words for a refused change live in one module (store/syncProblems.js)', !!P);
  const state = baseState();
  const words = (action) => (P ? P.describeRefusedAction(action, state) : null);
  ok("4.2 a refused pay change names the person", words({ type: ACTIONS.UPDATE_USER, id: 'u_crew', patch: { pay: {} } })?.key === 'syncProblem.change.pay'
    && words({ type: ACTIONS.UPDATE_USER, id: 'u_crew', patch: { pay: {} } })?.params?.name === 'Carl Crew');
  ok('4.3 a refused customer archive names the customer', words({ type: ACTIONS.ARCHIVE_CLIENT, id: 'c1' })?.key === 'syncProblem.change.archiveCustomer'
    && words({ type: ACTIONS.ARCHIVE_CLIENT, id: 'c1' })?.params?.customer === 'Acme Towers');
  ok('4.3b …and a refused restore too', words({ type: ACTIONS.RESTORE_CLIENT, id: 'c1' })?.key === 'syncProblem.change.restoreCustomer');
  ok('4.4 an unknown change reads as "a change you made", never a raw action type', words({ type: 'SOMETHING_NEW' })?.key === 'syncProblem.change.other');
  ok('4.5 a record no longer on file reads as "a change you made", never a blank name', words({ type: ACTIONS.UPDATE_USER, id: 'u_gone', patch: {} })?.key === 'syncProblem.change.other');
  const en = read('src/i18n/catalog/en.js');
  const src = P ? read('src/store/syncProblems.js') : '';
  const keys = [...new Set(src.match(/'syncProblem\.[A-Za-z.]+'/g) || [])].map((k) => k.slice(1, -1));
  ok('4.6 every line the module can name is in the English catalog', keys.length > 10 && keys.every((k) => en.includes(`'${k}':`)),
    keys.filter((k) => !en.includes(`'${k}':`)).join(', '));
  const merged = P ? P.mergeSyncProblems({ kind: 'refused', refused: [{ action: { type: 'A' } }] }, { kind: 'refused', refused: [{ action: { type: 'B' } }] }) : null;
  ok('4.7 two refusals before the first is closed become ONE message listing both', merged?.refused?.length === 2);
  const layout = read('src/layouts/AppLayout.jsx');
  // Two shells since the Cleaner Hub (brief A): the crew shell's early return and the office's. Exactly
  // one of them renders, and each mounts the message once.
  const crewAt = layout.indexOf('if (crew) {');
  const shells = crewAt >= 0 ? [layout.slice(crewAt, layout.indexOf('\n  }\n', crewAt)), layout.slice(layout.indexOf('\n  }\n', crewAt))] : [layout];
  ok('4.8 the blocking message is mounted once, in the app shell', shells.every((sh) => (sh.match(/<SyncProblemDialog\s*\/>/g) || []).length === 1));
}

console.log(`\ntest-sync-refused-change: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
