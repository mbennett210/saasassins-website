// WHICH BUILDINGS A CLIENT USER MAY SEE — the pure rule, exhaustively (HUB-3 / HUB-17).
//
// resolveAllowedClientIds is the ONE decision behind the hub's whole answer: the server gate
// runs it (api/_lib/clientHub/store.js), and the office's Settings page runs the same
// function to show what a person will actually get, so the screen can never promise access
// the hub refuses or hide access it grants. That makes it worth testing on its own, away
// from any transport.
//
// It is also the half that is EASY to get subtly wrong and hard to see: a group grants the
// buildings it holds TODAY, a removed customer grants nothing, and a disabled person gets
// nothing whatever their rows say.
//
//   node app/scripts/test-client-hub-scope.mjs
import * as clientHub from '../src/lib/clientHub.js';

// Read through the namespace so the pre-redesign tree, which has no view projections, fails
// P10..P12 one by one instead of crashing the suite at the import.
const {
  resolveAllowedClientIds, clientUserHasAccess, projectHubBuilding,
  buildHubView, HUB_BUILDING_FIELDS, HUB_SUPERVISOR_FIELDS,
  CLIENT_USER_STATUSES, CLIENT_USER_ACCESS_STATUSES, CLIENT_GROUP_KINDS, isClientGroupKind,
  CLIENT_ROLE, isClientSession,
} = clientHub;
const HUB_VIEW_FIELDS = clientHub.HUB_VIEW_FIELDS || [];
const HUB_VIEWER_FIELDS = clientHub.HUB_VIEWER_FIELDS || [];
const HUB_GROUP_FIELDS = clientHub.HUB_GROUP_FIELDS || [];
const HUB_VIEW_BUILDING_FIELDS = clientHub.HUB_VIEW_BUILDING_FIELDS || [];
const projectHubViewBuilding = clientHub.projectHubViewBuilding || (() => ({}));
const projectHubGroups = clientHub.projectHubGroups || (() => []);

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: (label, cond). Read this before adding a check — the repo's suites
// disagree on it, and a swapped call "passes" on a truthy label.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const BOOK = ['cl_a', 'cl_b', 'cl_c', 'cl_d'];
const direct = (clientId) => ({ clientId, groupId: null });
const viaGroup = (groupId) => ({ clientId: null, groupId });
const member = (groupId, clientId) => ({ groupId, clientId });

// ── the vocabulary ───────────────────────────────────────────────────────────
ok('V1 the statuses are exactly invited / active / disabled',
  CLIENT_USER_STATUSES.join(',') === 'invited,active,disabled');
ok('V2 access is an ALLOWLIST of invited + active — an invited person must be able to sign in once',
  CLIENT_USER_ACCESS_STATUSES.join(',') === 'invited,active'
  && CLIENT_USER_ACCESS_STATUSES.every(clientUserHasAccess)
  && clientUserHasAccess('disabled') === false);
ok('🔴 V3 …so anything unrecognized holds NOTHING: a crafted "Disabled ", a future value, a non-string',
  ['Disabled ', ' suspended', 'archived', '', 'owner'].every((s) => clientUserHasAccess(s) === false)
  && [null, undefined, 5, ['active'], { v: 'active' }].every((s) => clientUserHasAccess(s) === false));
ok('V4 …while case and padding do not change a real one',
  clientUserHasAccess(' Active ') === true && clientUserHasAccess('INVITED') === true);
ok('V5 a group kind is one of the three the office can pick',
  CLIENT_GROUP_KINDS.map((k) => k.id).join(',') === 'management,city,other'
  && isClientGroupKind('city') === true && isClientGroupKind('vendor') === false && isClientGroupKind(null) === false);
ok('V6 a client session is recognized from the service-role-written claim only',
  isClientSession({ user: { app_metadata: { role: CLIENT_ROLE } } }) === true
  && isClientSession({ user: { app_metadata: { role: 'owner' } } }) === false
  && isClientSession({ user: { user_metadata: { role: CLIENT_ROLE } } }) === false
  && isClientSession(null) === false);

// ── the scope ────────────────────────────────────────────────────────────────
const scope = (o) => resolveAllowedClientIds({ clientIds: BOOK, ...o }).join(',');

ok('S1 no assignments = no buildings', scope({ assignments: [] }) === '');
ok('S2 a DIRECT assignment grants exactly that building (a property manager, HUB-3)',
  scope({ assignments: [direct('cl_b')] }) === 'cl_b');
ok('S3 several direct assignments grant all of them, sorted and deduplicated',
  scope({ assignments: [direct('cl_c'), direct('cl_a'), direct('cl_c')] }) === 'cl_a,cl_c');
ok('S4 a GROUP assignment grants every building in that group (a city\'s facility director, HUB-17)',
  scope({ assignments: [viaGroup('g1')], groupMembers: [member('g1', 'cl_a'), member('g1', 'cl_d')] }) === 'cl_a,cl_d');
ok('🔴 S5 …including a building added to the group AFTERWARDS, with no change to the person',
  scope({ assignments: [viaGroup('g1')], groupMembers: [member('g1', 'cl_a')] }) === 'cl_a'
  && scope({ assignments: [viaGroup('g1')], groupMembers: [member('g1', 'cl_a'), member('g1', 'cl_b')] }) === 'cl_a,cl_b');
ok('S6 a group they are NOT in grants nothing',
  scope({ assignments: [viaGroup('g1')], groupMembers: [member('g2', 'cl_a'), member('g1', 'cl_b')] }) === 'cl_b');
ok('S7 direct and group access are the UNION, not a replacement',
  scope({ assignments: [direct('cl_c'), viaGroup('g1')], groupMembers: [member('g1', 'cl_a')] }) === 'cl_a,cl_c');
ok('S8 …and overlapping grants are one building, not two',
  scope({ assignments: [direct('cl_a'), viaGroup('g1')], groupMembers: [member('g1', 'cl_a')] }) === 'cl_a');
ok('🔴 S9 a customer the office REMOVED drops out, stale assignment and membership rows and all',
  resolveAllowedClientIds({
    clientIds: ['cl_a'], assignments: [direct('cl_a'), direct('cl_gone'), viaGroup('g1')],
    groupMembers: [member('g1', 'cl_alsogone')],
  }).join(',') === 'cl_a');
ok('🔴 S10 a DISABLED person gets nothing, whatever they are assigned',
  scope({ status: 'disabled', assignments: [direct('cl_a'), viaGroup('g1')], groupMembers: [member('g1', 'cl_b')] }) === '');
ok('🔴 S11 …and so does one whose status is a value this app does not know (fail closed)',
  ['suspended', '', null, 7].every((status) => scope({ status, assignments: [direct('cl_a')] }) === ''));
ok('S12 an INVITED person already has their scope — their first sign-in has to work',
  scope({ status: 'invited', assignments: [direct('cl_a')] }) === 'cl_a');
ok('S13 omitting the customer book skips the removed-customer filter (the caller said so)',
  resolveAllowedClientIds({ assignments: [direct('cl_zzz')] }).join(',') === 'cl_zzz');
ok('S14 an EMPTY customer book grants nothing — fail closed, never "every id an assignment names"',
  resolveAllowedClientIds({ clientIds: [], assignments: [direct('cl_a')] }).join(',') === '');
ok('S15 malformed rows cannot throw or grant',
  (() => {
    try {
      return resolveAllowedClientIds({
        clientIds: BOOK, assignments: [null, 5, {}, { clientId: null, groupId: null }, direct('cl_a')],
        groupMembers: [null, 'x', { groupId: 'g1' }],
      }).join(',') === 'cl_a';
    } catch { return false; }
  })());
ok('S16 defaults alone (no arguments) grant nothing', resolveAllowedClientIds().length === 0);

// ── the projection ───────────────────────────────────────────────────────────
// The customer record as it really is: revenue, internal notes, tags, billing, the access
// codes the Access tab holds. None of it may leave.
const CLIENT = {
  id: 'cl_a', name: 'Harbor Tower', supervisorId: 'u_1',
  street: '1 Harbor Way', city: 'Fort Lauderdale', state: 'FL', zip: '33301',
  revenue: 5400, notes: 'gate code 4455', email: 'ap@harbor.test', phone: '(754) 555-0202',
  tagIds: ['tg_vip'], standingCrewIds: ['u_crew'], billingEmail: 'ap@harbor.test',
  primaryContact: 'Pat Ramirez', serviceId: 'svc_jan', lastServiceAt: '2026-10-01',
};
const SITE = { id: 'st_loc_cl_a', clientId: 'cl_a', address: '1 Harbor Way, Fort Lauderdale FL 33301', lat: 26.1, lng: -80.1, accessNotes: 'alarm 9911' };
const SUP = { id: 'u_1', name: 'Dana Owner', phone: '(754) 555-0100', email: 'dana@cleanspace.test', role: 'owner', pay: { rateCents: 4200 } };

const projected = projectHubBuilding(CLIENT, { site: SITE, supervisor: SUP });
ok(`P1 the projection has EXACTLY the whitelisted keys (${Object.keys(projected).sort().join(',')})`,
  Object.keys(projected).sort().join(',') === [...HUB_BUILDING_FIELDS].sort().join(','));
ok('🔴 P2 and NOTHING else from the customer record rides along',
  !JSON.stringify(projected).includes('5400')
  && !JSON.stringify(projected).includes('gate code')
  && !JSON.stringify(projected).includes('alarm 9911')
  && !JSON.stringify(projected).includes('ap@harbor.test')
  && !JSON.stringify(projected).includes('tg_vip')
  && !JSON.stringify(projected).includes('u_crew')
  && !JSON.stringify(projected).includes('4200'));
ok('P3 the supervisor is their name + their OWN phone, nothing else (HUB-12 / HUB-18)',
  Object.keys(projected.supervisor).sort().join(',') === [...HUB_SUPERVISOR_FIELDS].sort().join(',')
  && projected.supervisor.phone === '(754) 555-0100');
ok('P4 the address comes from the location when it has one',
  projected.address === SITE.address);
ok('P5 …and is composed from the customer\'s own fields when there is no location',
  projectHubBuilding(CLIENT, {}).address === '1 Harbor Way, Fort Lauderdale FL 33301');
ok('P6 no supervisor is null, not a half-filled object the screen would render blank',
  projectHubBuilding(CLIENT, { site: SITE }).supervisor === null);
ok('P7 a customer with no number yet is served customerNumber null, not omitted; one with a number (GO-2) is served it',
  'customerNumber' in projected && projected.customerNumber === null
  && projectHubBuilding({ ...CLIENT, customerNumber: '0104' }, {}).customerNumber === '0104');
ok('P8 an empty customer cannot throw and leaks nothing',
  (() => { try { return Object.keys(projectHubBuilding(null, {})).sort().join(',') === [...HUB_BUILDING_FIELDS].sort().join(','); } catch { return false; } })());

const view = buildHubView({ clientUser: { name: 'Pat Manager', email: 'pm@x.test', phone: '(754) 555-0300', status: 'active', auth_user_id: 'a-1' }, buildings: [projected], brandName: 'Clean Space', timezone: 'America/New_York' });
// The redesign (2026-10-08) adds the viewer's phone and first name, the viewer's groups and the
// org's zone — each read against its source-of-truth constant, never a restated list.
ok('P9 the hub view names the viewer, their buildings, their groups and the org zone, and carries no row internals',
  Object.keys(view).sort().join(',') === [...HUB_VIEW_FIELDS].sort().join(',')
  && Object.keys(view.viewer).sort().join(',') === [...HUB_VIEWER_FIELDS].sort().join(',')
  && view.viewer.firstName === 'Pat' && view.viewer.phone === '(754) 555-0300' && view.timezone === 'America/New_York'
  && !JSON.stringify(view).includes('a-1'));
// A view ROW is the building projection plus its next visit; the projection itself is unchanged.
const row = projectHubViewBuilding(projected, { nextVisit: '2026-10-12T22:00:00.000Z' });
ok('P10 a view row is EXACTLY the building projection plus its next visit',
  Object.keys(row).sort().join(',') === [...HUB_VIEW_BUILDING_FIELDS].sort().join(',')
  && HUB_VIEW_BUILDING_FIELDS.length === HUB_BUILDING_FIELDS.length + 1 && row.nextVisit === '2026-10-12T22:00:00.000Z'
  && projectHubViewBuilding(projected, { nextVisit: 42 }).nextVisit === null);
// The groups: only the ones the viewer is ASSIGNED, only their in-scope buildings, none emptied.
const groups = projectHubGroups({
  assignedGroupIds: ['g1', 'g3'],
  groups: [{ id: 'g1', name: 'Royal Palm', secret: 'x' }, { id: 'g2', name: 'Not Mine' }, { id: 'g3', name: 'Emptied' }],
  members: [{ groupId: 'g1', clientId: 'cl_a' }, { groupId: 'g1', clientId: 'cl_out' }, { groupId: 'g2', clientId: 'cl_a' }, { groupId: 'g3', clientId: 'cl_out' }],
  allowedIds: new Set(['cl_a']),
});
ok('P11 the viewer\'s groups: assigned ones only, in-scope buildings only, an emptied one dropped, EXACTLY their allowlist',
  groups.length === 1 && groups[0].id === 'g1' && groups[0].buildingIds.join() === 'cl_a'
  && Object.keys(groups[0]).sort().join(',') === [...HUB_GROUP_FIELDS].sort().join(','));
ok('P12 the supervisor reaches a customer as first name + last initial (a staff name only through hubPersonName)',
  projectHubBuilding({ id: 'c' }, { supervisor: { id: 'u', name: 'Renata Cruz', phone: '1' } }).supervisor.name === 'Renata C.');

console.log(`\nclient hub scope + projection: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
