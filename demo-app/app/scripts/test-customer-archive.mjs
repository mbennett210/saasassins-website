// CUSTOMERS ARE ARCHIVED, NEVER DELETED (CS-663, CS-027; S128 F2-01 / F6-06).
//
// Matt, kickoff 2026-09-10 (meetings/2026-09-10-kickoff-action-items.md:52): "Never delete
// customers — reactivating a former customer keeps the same ID." Nobody built it: Delete still
// shipped (ClientDetail, the Customers bulk bar → DELETE_CLIENT), and deleting a customer left its
// Active contract in the book value, its open requests escalating, its waiting messages, documents,
// hub logins, QuickBooks link and inspections keyed to a customer that no longer existed.
//
// The archive (lib/customerStatus + ARCHIVE_CLIENT / RESTORE_CLIENT):
//   · `statusOverride: 'archived'` (where the customer's status already lives) + archivedAt /
//     archivedBy / statusBeforeArchive; the record, its number, contacts, location, invoices,
//     notes and history all stay;
//   · its cleans not started yet come off the schedule and its never-ending series stop at the
//     archive (the crew are told) — an archived building is cleaned no more;
//   · it leaves the pickers (selectActiveClients), its badge says Archived, and Restore puts its
//     status back (the schedule is not put back);
//   · DELETE_CLIENT is GONE (replace means delete), and the server refuses a customer removal for
//     everyone; archiving or restoring is `clients.delete`'s ("Archive customers").
// (What leaves the book, the hub, the alerts and the counts: test-archive-consumers.mjs.)
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`247618d9`) there is no ARCHIVE_CLIENT /
// RESTORE_CLIENT, DELETE_CLIENT removes the customer, the server lets a clients.delete holder remove
// one, and the screens offer Delete.
//
//   node app/scripts/test-customer-archive.mjs
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { loadStore, installResolveShim } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000001';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
const consoleError = console.error;
console.error = (...args) => { if (args[0] !== '[ALERT]' || process.env.VERBOSE) consoleError(...args); };
installFakeSupabase();
installResolveShim(); // the store and its selectors are written for Vite's extensionless imports

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const CS = await tryImport('../src/lib/customerStatus.js');
const SEL = await import('../src/store/selectors.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { canonicalJson } = await import('../src/lib/canonicalJson.js');
const { default: orgState } = await import('../api/state/org-state.js');
const { protectedFingerprint } = await import('../api/_lib/orgStateGuard.js');
const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 240)}`;

// ── the book ─────────────────────────────────────────────────────────────────
const HOUR = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const job = (id, over = {}) => ({ id, clientId: 'c1', siteId: 's1', serviceId: null, crewIds: ['u_crew'], tagIds: [], status: 'upcoming', ...over });
const book = () => ({
  ...INITIAL_STATE,
  currentUserId: 'u_owner',
  clients: [
    { id: 'c1', name: 'Coral Bay HOA', type: 'customer', customerNumber: '0004', statusOverride: 'active', supervisorId: 'u_mgr', tagIds: [] },
    { id: 'c2', name: 'Bayside Plaza', type: 'customer', customerNumber: '0006', tagIds: [] },
  ],
  sites: [{ id: 's1', clientId: 'c1', name: 'Coral Bay HOA' }, { id: 's2', clientId: 'c2', name: 'Bayside Plaza' }],
  contacts: [{ id: 'ct1', firstName: 'Pat', lastName: 'Lee', email: 'pat@coral.test', companyId: 'c1', tagIds: [] }],
  invoices: [{ id: 'INV-1', clientId: 'c1', siteId: 's1', status: 'pending', lineItems: [{ id: 'l', qty: 1, unitPrice: 100 }], payments: [], jobIds: ['j_past', 'j_future'] }],
  jobs: [
    job('j_past', { status: 'done', startAt: iso(NOW - 48 * HOUR), endAt: iso(NOW - 45 * HOUR) }),
    job('j_now', { status: 'in_progress', startAt: iso(NOW - HOUR), endAt: iso(NOW + HOUR) }),
    job('j_future', { startAt: iso(NOW + 24 * HOUR), endAt: iso(NOW + 27 * HOUR) }),
    // a never-ending weekly series: its master last week, two occurrences ahead
    job('j_m', { seriesId: 'ser1', startAt: iso(NOW - 7 * 24 * HOUR), endAt: iso(NOW - 7 * 24 * HOUR + 3 * HOUR), status: 'done', recurrence: { freq: 'weekly', interval: 1, daysOfWeek: [new Date(NOW).getUTCDay()], endType: 'never' } }),
    job('j_o1', { seriesId: 'ser1', startAt: iso(NOW + 2 * HOUR), endAt: iso(NOW + 5 * HOUR) }),
    job('j_o2', { seriesId: 'ser1', startAt: iso(NOW + 7 * 24 * HOUR + 2 * HOUR), endAt: iso(NOW + 7 * 24 * HOUR + 5 * HOUR) }),
    job('j_other', { clientId: 'c2', siteId: 's2', startAt: iso(NOW + 24 * HOUR), endAt: iso(NOW + 26 * HOUR) }),
  ],
  notifications: [],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive', email: 'owner@cs.co' },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona', email: 'mgr@cs.co' },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl', email: 'crew@cs.co' },
  ],
});

// ── A. the rule ──────────────────────────────────────────────────────────────
ok('A1 lib/customerStatus exports the archive rule',
  typeof CS.archiveCustomerPatch === 'function' && typeof CS.restoreCustomerPatch === 'function' && typeof CS.archiveSchedulePlan === 'function');
const ap = typeof CS.archiveCustomerPatch === 'function' ? CS.archiveCustomerPatch({ id: 'c1', statusOverride: 'inactive' }, { at: '2026-10-13T12:00:00Z', by: 'u_owner' }) : {};
ok('A2 the archive is statusOverride archived, stamped, remembering the status it had', ap.statusOverride === 'archived' && ap.archivedAt === '2026-10-13T12:00:00Z' && ap.archivedBy === 'u_owner' && ap.statusBeforeArchive === 'inactive', JSON.stringify(ap));
const rp = typeof CS.restoreCustomerPatch === 'function' ? CS.restoreCustomerPatch({ id: 'c1', ...ap }) : {};
ok('A3 Restore puts that status back and clears the stamps', rp.statusOverride === 'inactive' && rp.archivedAt === null && rp.statusBeforeArchive === null, JSON.stringify(rp));
const rpDerived = typeof CS.restoreCustomerPatch === 'function' ? CS.restoreCustomerPatch({ id: 'c1', statusOverride: 'archived', statusBeforeArchive: null }) : {};
ok('A4 a customer whose status was derived goes back to derived', rpDerived.statusOverride === null, JSON.stringify(rpDerived));

// ── B. the store ─────────────────────────────────────────────────────────────
ok('B0 🔴 DELETE_CLIENT is gone (customers are archived, never deleted)', !('DELETE_CLIENT' in ACTIONS));
ok('B0b …and ARCHIVE_CLIENT / RESTORE_CLIENT exist', !!ACTIONS.ARCHIVE_CLIENT && !!ACTIONS.RESTORE_CLIENT);
const s0 = book();
const dead = reducer(s0, { type: 'DELETE_CLIENT', id: 'c1' });
ok('B1 🔴 a stale DELETE_CLIENT dispatch removes nothing', dead.clients.length === 2 && dead.contacts.length === 1 && dead.invoices.length === 1);
const AT = iso(NOW);
const s1 = reducer(s0, { type: ACTIONS.ARCHIVE_CLIENT, id: 'c1', at: AT, by: 'u_owner' });
const c1 = (s) => s.clients.find((c) => c.id === 'c1');
const jobIds = (s) => new Set((s.jobs || []).map((j) => j.id));
ok('B2 🔴 the customer is archived — kept, with its number', c1(s1)?.statusOverride === 'archived' && c1(s1)?.customerNumber === '0004' && c1(s1)?.archivedAt === AT && c1(s1)?.archivedBy === 'u_owner', JSON.stringify(c1(s1)));
ok('B3 its contacts, location and invoices all stay', s1.contacts.length === 1 && s1.sites.length === 2 && s1.invoices.length === 1);
ok('B4 its past and running cleans stay (history)', jobIds(s1).has('j_past') && jobIds(s1).has('j_now') && jobIds(s1).has('j_m'));
ok('B5 🔴 its cleans not started yet come off the schedule', !jobIds(s1).has('j_future') && !jobIds(s1).has('j_o1') && !jobIds(s1).has('j_o2'), JSON.stringify([...jobIds(s1)]));
ok('B6 another customer\'s clean is untouched', jobIds(s1).has('j_other'));
const master = s1.jobs.find((j) => j.id === 'j_m');
ok('B7 🔴 its never-ending series stops at the archive (no top-up re-mints it)', master?.recurrence?.endType === 'date' && master?.recurrence?.endDate === AT, JSON.stringify(master?.recurrence));
const topped = reducer(s1, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: NOW + 60 * 24 * HOUR });
ok('B8 a top-up after the archive adds nothing for it', ![...jobIds(topped)].some((id) => !jobIds(s1).has(id) && topped.jobs.find((j) => j.id === id)?.clientId === 'c1'));
const sneaky = { ...s1, jobs: s1.jobs.map((j) => (j.id === 'j_m' ? { ...j, recurrence: { ...j.recurrence, endType: 'never', endDate: null } } : j)) };
const topped2 = reducer(sneaky, { type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs: NOW + 60 * 24 * HOUR });
ok('B9 belt and braces: even an uncapped series of an archived customer is not topped up', (topped2.jobs || []).filter((j) => j.clientId === 'c1').length === (sneaky.jobs || []).filter((j) => j.clientId === 'c1').length);
ok('B10 the invoice no longer links a clean that was taken off', !(s1.invoices[0].jobIds || []).includes('j_future') && s1.invoices[0].jobIds.includes('j_past'));
ok('B11 the crew are told their cleans there were removed', (s1.notifications || []).some((n) => n.eventKey === 'jobCancelled' && n.userId === 'u_crew'), JSON.stringify((s1.notifications || []).map((n) => [n.eventKey, n.userId])));
ok('B12 🔴 it leaves the pickers (selectActiveClients)', !SEL.selectActiveClients(s1).some((c) => c.id === 'c1') && SEL.selectActiveClients(s1).some((c) => c.id === 'c2'));
ok('B13 the pickers keep ONE list while nothing changes (a stable reference for the screens\' memos)', SEL.selectActiveClients(s1) === SEL.selectActiveClients(s1));
ok('B14 its status and badge read Archived', SEL.selectClientStatus(s1, c1(s1)) === 'archived' && SEL.selectClientBadgeStatus(s1, c1(s1)) === 'archived');
ok('B15 a page still finds it by id (history stays readable)', SEL.selectClientById(s1, 'c1')?.name === 'Coral Bay HOA');
const viaUpdate = reducer(s0, { type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { statusOverride: 'archived', name: 'Coral Bay HOA (renamed)' } });
ok('B16 🔴 the status menu\'s UPDATE_CLIENT cannot archive (only ARCHIVE_CLIENT, which ends the schedule)', c1(viaUpdate).statusOverride === 'active' && c1(viaUpdate).name === 'Coral Bay HOA (renamed)', JSON.stringify(c1(viaUpdate)));
const unarch = reducer(s1, { type: ACTIONS.UPDATE_CLIENT, id: 'c1', patch: { statusOverride: 'active' } });
ok('B17 …nor un-archive one (only RESTORE_CLIENT)', c1(unarch).statusOverride === 'archived');
const s2 = reducer(s1, { type: ACTIONS.RESTORE_CLIENT, id: 'c1' });
ok('B18 🔴 Restore brings it back with the status it had', c1(s2).statusOverride === 'active' && !c1(s2).archivedAt && SEL.selectActiveClients(s2).some((c) => c.id === 'c1'), JSON.stringify(c1(s2)));
ok('B19 Restore does not put the removed cleans back', !jobIds(s2).has('j_future'));
ok('B20 archiving twice changes nothing the second time', reducer(s1, { type: ACTIONS.ARCHIVE_CLIENT, id: 'c1', at: iso(NOW + HOUR) }) === s1);

// ── C. the server: never a removal; archive and restore are clients.delete's ───────
const login = (id, email, role, orgUserId) => ({ id, email, app_metadata: { role, org_user_id: orgUserId, org_id: ORG } });
const LOGINS = {
  'tok-owner': login('a-owner', 'owner@cs.co', 'owner', 'u_owner'),
  'tok-admin': login('a-admin', 'admin@cs.co', 'admin', 'u_admin'),
  'tok-mgr': login('a-mgr', 'mgr@cs.co', 'manager', 'u_mgr'),
  'tok-mgr2': login('a-mgr2', 'mgr2@cs.co', 'manager', 'u_mgr2'),   // clients.delete revoked
};
const seedState = () => ({
  version: 58,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York', invoicePrefix: 'INV' },
  permissions: seedPermissions(),
  userPermissionOverrides: [{ userId: 'u_mgr2', grants: [], revokes: ['clients.delete'] }],
  timeOff: [],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive', email: 'owner@cs.co' },
    { id: 'u_admin', role: 'admin', status: 'active', name: 'Adam', email: 'admin@cs.co' },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona', email: 'mgr@cs.co' },
    { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Milo', email: 'mgr2@cs.co' },
  ],
  clients: [
    { id: 'c1', name: 'Acme Towers', type: 'customer', standingCrewIds: [] },
    { id: 'c2', name: 'Bayside Plaza', type: 'customer', standingCrewIds: [], statusOverride: 'archived', archivedAt: '2026-10-01T12:00:00Z', archivedBy: 'u_owner', statusBeforeArchive: 'active' },
  ],
  sites: [{ id: 's1', clientId: 'c1', name: 'Acme Towers', standingCrewIds: [] }, { id: 's2', clientId: 'c2', name: 'Bayside Plaza', standingCrewIds: [] }],
  contacts: [], invoices: [], payrollLines: [], reimbursements: [], opsSettings: {}, notes: [],
});
async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"t1"}`;
  const req = { method: 'POST', query: {}, headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await orgState(req, res);
  return out;
}
const row = () => world.tables.org_state[0];
async function freshOrg() {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state: seedState(), version: 1, protected_fingerprint: null, min_client_build: null, updated_at: new Date().toISOString() }],
      jobs: [], crew_assignments: [], payroll_runs: [], job_deletes: [], supply_items: [], supply_requests: [],
    },
    logins: LOGINS,
  });
  const boot = await save('tok-owner', JSON.parse(JSON.stringify(row().state)), 1);
  if (boot.status !== 200) throw new Error(`bootstrap save failed: ${boot.status} ${JSON.stringify(boot.body)}`);
}
async function attempt(token, edit) {
  await freshOrg();
  const before = row().version;
  const next = JSON.parse(JSON.stringify(row().state));
  edit(next);
  const r = await save(token, next, before);
  return { ...r, wrote: row().version !== before };
}
const refused = (r, words) => r.status === 403 && !r.wrote && (!words || (r.body?.violations || []).includes(words));
const accepted = (r) => r.status === 200 && r.wrote;
const remove = (s) => { s.clients = s.clients.filter((c) => c.id !== 'c1'); s.sites = s.sites.filter((x) => x.clientId !== 'c1'); };
const archive = (s) => { Object.assign(s.clients.find((c) => c.id === 'c1'), { statusOverride: 'archived', archivedAt: '2026-10-13T12:00:00Z', archivedBy: 'u_mgr', statusBeforeArchive: null }); };
const restore = (s) => { Object.assign(s.clients.find((c) => c.id === 'c2'), { statusOverride: 'active', archivedAt: null, archivedBy: null, statusBeforeArchive: null }); };
{
  const o = await attempt('tok-owner', remove);
  ok('C1 🔴 even the Super Admin cannot remove a customer through a save', refused(o, 'remove a customer'), show(o));
  const m = await attempt('tok-mgr', remove);
  ok('C2 🔴 nor a manager holding clients.delete', refused(m, 'remove a customer'), show(m));
  const a1 = await attempt('tok-mgr', archive);
  ok('C3 a manager holding clients.delete ("Archive customers") may archive', accepted(a1), show(a1));
  const a2 = await attempt('tok-mgr2', archive);
  ok('C4 🔴 a manager pared off clients.delete may not', refused(a2, 'archive or restore a customer'), show(a2));
  const a3 = await attempt('tok-admin', archive);
  ok('C5 an Admin holding it by default may', accepted(a3), show(a3));
  const r1 = await attempt('tok-mgr2', restore);
  ok('C6 🔴 restoring is the same key', refused(r1, 'archive or restore a customer'), show(r1));
  const r2 = await attempt('tok-mgr', restore);
  ok('C7 …which a holder may', accepted(r2), show(r2));
  const e1 = await attempt('tok-mgr2', (s) => { s.clients.find((c) => c.id === 'c2').notes = 'still on file'; });
  ok('C8 an ordinary edit of an archived customer stays ordinary data', accepted(e1), show(e1));
  const before = seedState();
  const after = seedState(); archive(after);
  ok('C9 an archive-only save moves the protected digest, so the guard runs on it', protectedFingerprint(before) !== protectedFingerprint(after));
  const plain = seedState(); plain.clients[0].name = 'Acme Towers II';
  ok('C10 …while a rename does not (it stays off the deep read)', protectedFingerprint(before) === protectedFingerprint(plain));
}

// ── D. the screens (read mechanically; the drive is the screenshots) ───────────
{
  const flat = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const CD = flat('../src/pages/ClientDetail.jsx');
  ok('D1 🔴 the customer page has no Delete and no DELETE_CLIENT', !/\bDELETE_CLIENT\b/.test(CD) && !/>Delete<\/button>\}/.test(CD));
  ok('D2 it archives through ARCHIVE_CLIENT behind a confirm', /ACTIONS\.ARCHIVE_CLIENT/.test(CD) && /custArchive\.confirmTitle/.test(CD));
  ok('D3 …and restores through RESTORE_CLIENT', /ACTIONS\.RESTORE_CLIENT/.test(CD));
  ok('D4 archive is offered only to clients.delete holders who may edit the schedule, once every clean has loaded', /const canArchive = canArchiveClient && canEditJobs && jobsHydrated;/.test(CD));
  ok('D5 an archived customer says so on its page', /custArchive\.banner/.test(CD));
  const CL = flat('../src/pages/Clients.jsx');
  ok('D6 🔴 the Customers bulk bar archives, never deletes', !/\bDELETE_CLIENT\b/.test(CL) && /ACTIONS\.ARCHIVE_CLIENT/.test(CL));
  ok('D7 the list hides archived customers unless asked, and the Status filter offers Archived', /isArchivedCustomer\(cl\)/.test(CL) && /'archived'/.test(CL));
  const RL = flat('../src/lib/roles.js');
  ok('D8 the permission is named for what it does now', /'clients\.delete':\s*\{ label: 'Archive customers'/.test(RL));
}

console.log(`\n${pass}/${pass + fails.length} customer-archive checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
