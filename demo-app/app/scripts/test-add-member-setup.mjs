// A new cleaner set up in one step: Add Team Member's Works at, pay and Access (task #470 from Clean
// Corner's queue, Daniel's picks 2026-11-03: the pay is a pay type and its rate, Crew only; the
// Access since 2026-11-03 evening, his pick "B · Crew's switches up front": every permission the
// Crew role has as a switch, and "Give another permission" for the rest). Offline.
//
// The pop-up (components/AddUserModal) saves what lib/newMemberSetup decides: Works at and pay ride
// the new member's ADD_USER, the Access is one SET_USER_PERMISSION_OVERRIDE written key by key by the
// Access tab's own rule (lib/roles overrideForEffective). The save route is the boundary
// (BUILD_INTEGRITY §1.4): this suite drives api/state/org-state.js through scripts/fake-supabase.mjs
// with the pop-up's OWN output (the form → the lib → the actions → the REAL reducer):
//   · the rule: each pay type, a blank rate (no pay), a bad rate (refused, words), Crew only, the
//     switches against a crew column with and without a key, several keys at once, a key given only
//     by a holder, the four everyone has and the Super Admin's own never written, an adopted login's
//     row kept, and the list "Give another permission" offers;
//   · a holder of the keys adds a cleaner with two customers, $17.50/hr, two of Crew's permissions
//     off and two more given: ACCEPTED, in one save and in two;
//   · pay without "Set team-member pay rates", Access without "Grant / revoke per-user perms", and a
//     key given by a caller who doesn't hold it: REFUSED, nothing written, and the pop-up's rule had
//     already left each out for that caller (the rest of their Access kept);
//   · the pop-up offers pay and Access behind the same keys, and only for Crew.
//
//   node app/scripts/test-add-member-setup.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions, can } from '../src/lib/roles.js';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { loadStore } from './deletion-core.mjs';

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
const { default: handler } = await import('../api/state/org-state.js');
const { reducer, ACTIONS } = await loadStore();
let ms = {};
let pt = {};
try { ms = await import('../src/lib/newMemberSetup.js'); } catch { /* the pre-change tree has no rule */ }
try { pt = await import('../src/lib/payTypes.js'); } catch { /* reported by the checks */ }

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const has = typeof ms.newMemberFields === 'function' && typeof ms.newMemberOverride === 'function';
ok('the new-member rule loads', has && Array.isArray(pt.PAY_TYPES));
const fieldsOf = (o) => (has ? ms.newMemberFields(o) : { fields: {}, error: 'missing' });
const overrideOf = (o) => (has ? ms.newMemberOverride(o) : undefined);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const P = seedPermissions();
// The matrix with crew taken off "Request supplies" (Settings → Roles → Crew → Request supplies).
const noCrewSupplies = P.map((p) => (p.id === 'supplies.request' ? { ...p, roles: p.roles.filter((r) => r !== 'crew') } : p));

// ── the rule ───────────────────────────────────────────────────────────────────────────────
{
  const crew = { role: 'crew', canSetPay: true };
  ok('1 hourly with a rate: { type, hourlyRate }', same(fieldsOf({ ...crew, payType: 'hourly', payRate: '17.50' }).fields, { pay: { type: 'hourly', hourlyRate: 17.5 } }));
  ok('2 salary: { type, salaryPerPeriod }', same(fieldsOf({ ...crew, payType: 'salary', payRate: '1200' }).fields, { pay: { type: 'salary', salaryPerPeriod: 1200 } }));
  ok('3 per clean: { type, perVisitRate }', same(fieldsOf({ ...crew, payType: 'per_visit', payRate: '45' }).fields, { pay: { type: 'per_visit', perVisitRate: 45 } }));
  ok('4 "Not on payroll": { type: none }, no rate needed', same(fieldsOf({ ...crew, payType: 'none', payRate: '' }).fields, { pay: { type: 'none' } }));
  ok('5 a blank rate saves no pay', same(fieldsOf({ ...crew, payType: 'hourly', payRate: '  ' }), { fields: {}, error: null }));
  ok('6 a rate kept to the cent, a typed $ allowed', fieldsOf({ ...crew, payType: 'hourly', payRate: '$17.499' }).fields.pay?.hourlyRate === 17.5);
  const bad = fieldsOf({ ...crew, payType: 'hourly', payRate: '-3' });
  const word = fieldsOf({ ...crew, payType: 'hourly', payRate: 'abc' });
  ok('7 a negative or non-number rate is refused, in words, and nothing is saved', !!bad.error && bad.error === word.error && same(bad.fields, {}) && /17\.50/.test(bad.error || ''));
  ok('8 no pay without the key (canSetPay false)', same(fieldsOf({ role: 'crew', payType: 'hourly', payRate: '20' }).fields, {}));
  ok('9 Works at: each customer once, in order', same(fieldsOf({ role: 'crew', worksAt: ['c2', 'c1', 'c2', '', null] }).fields, { worksAt: ['c2', 'c1'] }));
  ok('10 nothing for any role but Crew', ['owner', 'admin', 'manager', 'supply_manager'].every((role) => same(fieldsOf({ role, worksAt: ['c1'], payType: 'hourly', payRate: '20', canSetPay: true }).fields, {})));

  const all = () => true;
  const acc = { role: 'crew', permissions: P, canSetAccess: true, mayGrant: all };
  const crewKeys = (perms) => (has && typeof ms.crewAccessKeys === 'function' ? ms.crewAccessKeys(perms) : []);
  const fixed = ['time.clock', 'schedule.view', 'messaging.use', 'settings.account', 'settings.company.timezone'];
  ok('11 the switches are what the crew column holds, never the four everyone has or the Super Admin\'s own',
    crewKeys(P).includes('supplies.request') && crewKeys(P).includes('keys.checkout') && !crewKeys(noCrewSupplies).includes('supplies.request')
    && !crewKeys(P).includes('schedule.edit') && fixed.every((k) => !crewKeys(P).includes(k)), JSON.stringify(crewKeys(P)));
  ok('12 left as the role gives it (nothing set, or flipped back): no row', overrideOf({ ...acc, access: {} }) === null && overrideOf({ ...acc, access: { 'supplies.request': true } }) === null);
  ok('13 two of Crew\'s turned off: two revokes', same(overrideOf({ ...acc, access: { 'supplies.request': false, 'keys.checkout': false } }), { grants: [], revokes: ['keys.checkout', 'supplies.request'] }));
  ok('14 one given where crew lacks it, one taken away: a grant and a revoke, for a holder',
    same(overrideOf({ ...acc, access: { 'schedule.edit': true, 'supplies.request': false } }), { grants: ['schedule.edit'], revokes: ['supplies.request'] })
    && same(overrideOf({ ...acc, permissions: noCrewSupplies, access: { 'supplies.request': true } }), { grants: ['supplies.request'], revokes: [] }));
  ok('15 …a key the caller doesn\'t hold is never given, the rest of the Access kept',
    same(overrideOf({ ...acc, mayGrant: (k) => k !== 'schedule.edit', access: { 'schedule.edit': true, 'invoices.view': true, 'supplies.request': false } }), { grants: ['invoices.view'], revokes: ['supplies.request'] })
    && overrideOf({ ...acc, permissions: noCrewSupplies, access: { 'supplies.request': true }, mayGrant: () => false }) === null);
  ok('16 nothing without "Grant / revoke per-user perms", or for another role', overrideOf({ ...acc, access: { 'supplies.request': false }, canSetAccess: false }) === null
    && overrideOf({ ...acc, role: 'manager', access: { 'supplies.request': false } }) === null);
  const existing = { userId: 'u_old', grants: ['keys.view'], revokes: ['messaging.use'] };
  ok('17 an adopted login\'s row is kept, the Access added to it', same(overrideOf({ ...acc, access: { 'supplies.request': false, 'schedule.edit': true }, existing }), { grants: ['keys.view', 'schedule.edit'], revokes: ['messaging.use', 'supplies.request'] }));
  ok('17b the four everyone has and the Super Admin\'s own are never written', overrideOf({ ...acc, access: { 'time.clock': false, 'messaging.use': false, 'settings.company.timezone': true } }) === null);
  const give = (o) => (has && typeof ms.giveChoices === 'function' ? ms.giveChoices(o) : []);
  const offered = give({ permissions: P, mayGrant: (k) => k !== 'invoices.view' });
  ok('17c "Give another permission" offers what Crew lacks and the caller holds, in the Roles page\'s order',
    offered.includes('schedule.edit') && !offered.includes('invoices.view') && !offered.includes('supplies.request')
    && fixed.every((k) => !offered.includes(k)) && offered.indexOf('schedule.edit') < offered.indexOf('payroll.view')
    && give({ permissions: noCrewSupplies, mayGrant: all }).includes('supplies.request'), JSON.stringify(offered.slice(0, 6)));
}

// ── the pop-up's actions through the REAL reducer ────────────────────────────────────────────
const LOGINS = {
  'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  // Holds every key the pop-up asks for: "Edit team" and per-user perms by role, pay rates granted.
  'tok-mgr': { id: 'a-mgr', email: 'mgr@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
  'tok-mgr-nopay': { id: 'a-mgr2', email: 'mgr2@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr2', org_id: ORG } },
  'tok-mgr-noov': { id: 'a-mgr3', email: 'mgr3@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr3', org_id: ORG } },
  'tok-mgr-nosup': { id: 'a-mgr4', email: 'mgr4@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr4', org_id: ORG } },
  'tok-mgr-nojobs': { id: 'a-mgr5', email: 'mgr5@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr5', org_id: ORG } },
};
const seedState = (permissions = P) => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York', invoicePrefix: 'INV' },
  permissions,
  userPermissionOverrides: [
    { userId: 'u_mgr', grants: ['payroll.rates.edit'], revokes: [] },
    { userId: 'u_mgr2', grants: [], revokes: ['payroll.rates.edit'] },
    { userId: 'u_mgr3', grants: ['payroll.rates.edit'], revokes: ['staff.editOverrides'] },
    { userId: 'u_mgr4', grants: [], revokes: ['supplies.request'] },
    { userId: 'u_mgr5', grants: ['payroll.rates.edit'], revokes: ['schedule.edit'] },
  ],
  timeOff: [],
  services: [{ id: 'svc_1', name: 'Nightly clean', defaultDurationMins: 90 }],
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Olive', email: 'owner@cs.co', pay: { type: 'none' }, hr: { employeeId: 'EMP-0001' } },
    { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mona', email: 'mgr@cs.co', pay: { type: 'salary', salaryPerPeriod: 2800 }, hr: { employeeId: 'EMP-0002' } },
    { id: 'u_mgr2', role: 'manager', status: 'active', name: 'Milo', email: 'mgr2@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0003' } },
    { id: 'u_mgr3', role: 'manager', status: 'active', name: 'Mae', email: 'mgr3@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0004' } },
    { id: 'u_mgr4', role: 'manager', status: 'active', name: 'Max', email: 'mgr4@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0005' } },
    { id: 'u_mgr5', role: 'manager', status: 'active', name: 'Mia', email: 'mgr5@cs.co', pay: { type: 'salary', salaryPerPeriod: 2600 }, hr: { employeeId: 'EMP-0007' } },
  ],
  clients: [
    { id: 'c1', name: 'Acme Towers', type: 'customer', customerNumber: '0001', tagIds: [] },
    { id: 'c2', name: 'Bayside Plaza', type: 'customer', customerNumber: '0002', tagIds: [] },
  ],
  sites: [], contacts: [], clientActivities: [], invoices: [], payrollLines: [], reimbursements: [],
  opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0 },
});
const userIdOf = { 'tok-owner': 'u_owner', 'tok-mgr': 'u_mgr', 'tok-mgr-nopay': 'u_mgr2', 'tok-mgr-noov': 'u_mgr3', 'tok-mgr-nosup': 'u_mgr4', 'tok-mgr-nojobs': 'u_mgr5' };

// What the pop-up decides for a caller: their keys as the pop-up reads them (usePermission → can()).
function keysOf(state, token) {
  const actor = state.users.find((u) => u.id === userIdOf[token]);
  const holds = (key) => can(actor, key, state.permissions, state.userPermissionOverrides);
  return { canSetPay: holds('payroll.rates.edit'), canSetAccess: holds('staff.editOverrides'), mayGrant: holds };
}
const FORM = { role: 'crew', worksAt: ['c1', 'c2'], payType: 'hourly', payRate: '17.50' };
// The pop-up's two dispatches, through the real reducer. `force` stands in for a screen that let a
// field through the rule shouldn't have, to show the server refuses it anyway.
function added(state, token, { access = { 'supplies.request': false }, force = {} } = {}) {
  const keys = { ...keysOf(state, token), ...force };
  const { fields } = fieldsOf({ ...FORM, canSetPay: keys.canSetPay });
  let next = reducer(state, { type: ACTIONS.ADD_USER, user: { id: 'u_new', name: 'Rosa Delgado', email: 'rosa@example.com', phone: '', role: 'crew', ...fields, status: 'active', initials: 'RD', hr: { employeeId: 'EMP-0006' } } });
  const ov = overrideOf({ role: 'crew', access, permissions: state.permissions, existing: null, canSetAccess: keys.canSetAccess, mayGrant: keys.mayGrant });
  if (ov) next = reducer(next, { type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: 'u_new', ...ov });
  return next;
}
{
  const s = added(seedState(), 'tok-mgr');
  const rosa = s.users.find((u) => u.id === 'u_new');
  ok('18 reducer: the cleaner saved with Works at, pay and the supply switch off',
    same(rosa?.worksAt, ['c1', 'c2']) && same(rosa?.pay, { type: 'hourly', hourlyRate: 17.5 })
    && same(s.userPermissionOverrides.find((o) => o.userId === 'u_new'), { userId: 'u_new', grants: [], revokes: ['supplies.request'] })
    && !can(rosa, 'supplies.request', s.permissions, s.userPermissionOverrides), JSON.stringify(rosa));
}

// ── the save route ───────────────────────────────────────────────────────────────────────────
async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"t1"}`;
  const req = { method: 'POST', query: {}, headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await handler(req, res);
  return out;
}
const row = () => world.tables.org_state[0];
async function freshOrg(permissions) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state: seedState(permissions), version: 1, protected_fingerprint: null, min_client_build: null, updated_at: new Date().toISOString() }],
      jobs: [], crew_assignments: [], payroll_runs: [], job_deletes: [],
    },
    logins: LOGINS,
  });
  const boot = await save('tok-owner', JSON.parse(JSON.stringify(row().state)), 1);
  if (boot.status !== 200) throw new Error(`bootstrap save failed: ${boot.status} ${JSON.stringify(boot.body)}`);
}
async function attempt(token, edit, permissions) {
  await freshOrg(permissions);
  const before = row().version;
  const next = JSON.parse(JSON.stringify(row().state));
  const r = await save(token, edit(next) || next, before);
  return { ...r, wrote: row().version !== before };
}
const refused = (r, words) => r.status === 403 && !r.wrote && (!words || (r.body?.violations || []).includes(words));
const accepted = (r) => r.status === 200 && r.wrote;
const show = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const saved = () => row().state.users.find((u) => u.id === 'u_new');
const savedRow = () => (row().state.userPermissionOverrides || []).find((o) => o.userId === 'u_new');

{
  const r = await attempt('tok-mgr', (s) => added(s, 'tok-mgr'));
  ok('19 a holder of the keys adds the cleaner in one save: accepted', accepted(r), show(r));
  ok('20 …saved: Works at, pay and the revoke', same(saved()?.worksAt, ['c1', 'c2']) && saved()?.pay?.hourlyRate === 17.5 && same(savedRow()?.revokes, ['supplies.request']));
  // The store may save the two dispatches apart: the member first, then their row.
  await freshOrg();
  const v1 = row().version;
  const first = JSON.parse(JSON.stringify(row().state));
  const keys = keysOf(first, 'tok-mgr');
  const { fields } = fieldsOf({ ...FORM, canSetPay: keys.canSetPay });
  const withUser = reducer(first, { type: ACTIONS.ADD_USER, user: { id: 'u_new', name: 'Rosa Delgado', email: 'rosa@example.com', role: 'crew', ...fields, status: 'active', initials: 'RD', hr: { employeeId: 'EMP-0006' } } });
  const a = await save('tok-mgr', withUser, v1);
  const ov = overrideOf({ role: 'crew', access: { 'supplies.request': false }, permissions: first.permissions, canSetAccess: keys.canSetAccess, mayGrant: keys.mayGrant });
  const b = await save('tok-mgr', reducer(JSON.parse(JSON.stringify(row().state)), { type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: 'u_new', ...(ov || {}) }), row().version);
  ok('21 …and in two saves: both accepted', a.status === 200 && b.status === 200 && same(savedRow()?.revokes, ['supplies.request']), `${show(a)} ${show(b)}`);
  const owner = await attempt('tok-owner', (s) => added(s, 'tok-owner'));
  ok('22 the Super Admin\'s: accepted', accepted(owner) && saved()?.pay?.hourlyRate === 17.5, show(owner));
  const on = await attempt('tok-mgr', (s) => added(s, 'tok-mgr', { access: { 'supplies.request': true } }), noCrewSupplies);
  ok('23 turned ON where crew lacks the key, by a holder: accepted, a grant', accepted(on) && same(savedRow()?.grants, ['supplies.request']), show(on));
  const four = { 'keys.checkout': false, 'supplies.request': false, 'schedule.edit': true, 'invoices.view': true };
  const many = await attempt('tok-mgr', (s) => added(s, 'tok-mgr', { access: four }));
  ok('23b two of Crew\'s off and two more given, by a holder: accepted, one row with all four', accepted(many)
    && same(savedRow()?.grants, ['schedule.edit', 'invoices.view']) && same(savedRow()?.revokes, ['keys.checkout', 'supplies.request']), `${show(many)} ${JSON.stringify(savedRow())}`);
}
{
  const r = await attempt('tok-mgr-nopay', (s) => added(s, 'tok-mgr-nopay', { force: { canSetPay: true } }));
  ok('24 pay without "Set team-member pay rates": refused, nothing written', refused(r, "set a new member's pay"), show(r));
  ok('25 …and the pop-up\'s rule leaves the pay out for that caller', !('pay' in added(seedState(), 'tok-mgr-nopay').users.find((u) => u.id === 'u_new')));
  const own = await attempt('tok-mgr-nopay', (s) => added(s, 'tok-mgr-nopay'));
  ok('26 the same caller\'s own add (no pay): accepted', accepted(own), show(own));

  const r2 = await attempt('tok-mgr-noov', (s) => added(s, 'tok-mgr-noov', { force: { canSetAccess: true } }));
  ok('27 the switch without "Grant / revoke per-user perms": refused', refused(r2, 'change per-user permission overrides'), show(r2));
  ok('28 …and the pop-up\'s rule writes no row for that caller', !added(seedState(), 'tok-mgr-noov').userPermissionOverrides.some((o) => o.userId === 'u_new'));

  const r3 = await attempt('tok-mgr-nosup', (s) => added(s, 'tok-mgr-nosup', { access: { 'supplies.request': true }, force: { mayGrant: () => true } }), noCrewSupplies);
  ok('29 turned ON by a caller who doesn\'t hold the key: refused', refused(r3, "give a permission you don't have (supplies.request)"), show(r3));
  ok('30 …and the pop-up\'s rule grants nothing for that caller', !added(seedState(noCrewSupplies), 'tok-mgr-nosup', { access: { 'supplies.request': true } }).userPermissionOverrides.some((o) => o.userId === 'u_new'));
  const mixed = { 'schedule.edit': true, 'invoices.view': true, 'supplies.request': false };
  const r4 = await attempt('tok-mgr-nojobs', (s) => added(s, 'tok-mgr-nojobs', { access: mixed, force: { mayGrant: () => true } }));
  ok('30b one key among several given by a caller who doesn\'t hold it: refused', refused(r4, "give a permission you don't have (schedule.edit)"), show(r4));
  const r5 = await attempt('tok-mgr-nojobs', (s) => added(s, 'tok-mgr-nojobs', { access: mixed }));
  ok('30c …the pop-up\'s rule leaves that one out and keeps the rest: accepted', accepted(r5)
    && same(savedRow()?.grants, ['invoices.view']) && same(savedRow()?.revokes, ['supplies.request']), `${show(r5)} ${JSON.stringify(savedRow())}`);
}

// ── the pop-up ───────────────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../src/components/AddUserModal.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('31 the pop-up reads pay and Access behind their keys', src.includes("usePermission('payroll.rates.edit')") && src.includes("usePermission('staff.editOverrides')"));
  ok('32 …offers the crew fields only for Crew', src.includes("const crew = picked.role === 'crew';") && src.includes('useCrewMotion(crew, crewOverflows)') && src.includes('{motion.showFields && (')
    && src.includes("showFields: phase === 'out' || (crew && phase !== 'clear')"));
  ok('33 …pay only with the pay key, Access only with the override key', src.includes('{canSetPay ? (') && src.includes('{canSetAccess && ('));
  ok('34 …saves through the rule: the fields on ADD_USER, the Access for the bound id',
    src.includes('newMemberFields({') && src.includes('...setup.fields') && src.includes('newMemberOverride({') && src.includes('saveAccess(boundId);') && src.includes('saveAccess(userId);'));
  ok('34b …draws Crew\'s switches and the list to give from by the rule, the list in the kit\'s picker (PopMenu, float)',
    src.includes('crewAccessKeys(permissions)') && src.includes('giveChoices({') && src.includes('mayGrant: canGrant') && /<PopMenu open=\{open\}[^\n]*sheetTitle="Give another permission" float>/.test(src) && src.includes('aria-haspopup="listbox"'));
  ok('35 …and a bad rate stops before any login is made', src.indexOf('if (setup.error)') > -1 && src.indexOf('if (setup.error)') < src.indexOf('createTeamLogin(email'));
  const detail = readFileSync(new URL('../src/pages/settings/TeamDetail.jsx', import.meta.url), 'utf8');
  ok('36 the Pay tab offers the same pay types (lib/payTypes)', /import \{ PAY_TYPES, payTypeOf \} from '\.\.\/\.\.\/lib\/payTypes'/.test(detail) && src.includes('PAY_TYPES.map('));
  // The Role turning away from Crew and back: the card holds its size and the fields fade (the
  // styling vault's "transitions"; measured: without the hold the card snapped from 720px to 540px).
  ok('37 the card holds the tallest it has been, under its 90vh cap', src.includes('card.style.minHeight = `min(${cardTallest.current}px, 90vh)`'));
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  ok('38 …and the fades\' CSS times are the code\'s (160ms fields, 120ms buttons), with reduced motion skipping them',
    src.includes('const CREW_FADE_OUT_MS = 160;') && src.includes('const ACTIONS_FADE_OUT_MS = 120;')
    && css.includes('.add-member-crew.is-out { animation: add-member-fade-out 160ms') && css.includes('.add-member-actions.is-out { animation: add-member-fade-out 120ms')
    && /prefers-reduced-motion: reduce\) \{\s*\.add-member-crew\.is-in, \.add-member-crew\.is-out, \.add-member-actions\.is-in, \.add-member-actions\.is-out \{ animation: none; \}/.test(css));
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — test-add-member-setup: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
