// ADVERSARIAL tests for the two authority mechanisms — queue item 10.
//
// test-org-state-guard.mjs asserts the guard does what it is DESIGNED to do. This
// file assumes an attacker who has read the source and is looking for the shape of
// edit that slips past: id-rewriting, duplicate keys, type confusion, delete-and-
// re-add, case tricks. Everything here must either DENY or be explicitly recorded
// below as a known-inert gap with the reason it is not exploitable.
//
// The two mechanisms are one system: orgStateGuard protects `standingCrewIds` in the
// blob, and crew_assignments is DERIVED from those same fields. If the guard has a
// hole, the tamper-proof table faithfully mirrors the attacker's self-assignment and
// closes nothing — which is why HANDOFF records their shipping order as load-bearing.
//
//   node scripts/test-authority-adversarial.mjs
import { protectedFieldViolations, protectedFingerprint } from '../api/_lib/orgStateGuard.js';
import { assignmentRowsFromState } from '../api/_lib/crewAssignments.js';
import { seedPermissions } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const CREW = 'u_crew';
const ADMIN = 'u_admin';
const OWNER = 'u_owner';

const base = () => ({
  users: [
    { id: OWNER, role: 'owner', status: 'active', name: 'Owner' },
    { id: ADMIN, role: 'admin', status: 'active', name: 'Admin' },
    { id: CREW, role: 'crew', status: 'active', name: 'Crew' },
  ],
  permissions: [{ id: 'invoices.view', roles: ['owner'] }],
  userPermissionOverrides: [],
  sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u_other'] }],
  clients: [{ id: 'c1', standingCrewIds: [] }],
});
const edit = (fn) => { const s = base(); fn(s); return s; };
const denied = (next, role, self) => protectedFieldViolations(base(), next, role, self).length > 0;

// ── IDENTITY REWRITING ────────────────────────────────────────────────────
// The guard keys users by id. Anything that changes WHICH id a row carries is an
// attempt to make the guard compare the wrong pair of rows.

// Rename own row to the owner's id: prev has u_crew, next does not -> a removal,
// which is owner-only.
ok('crew CANNOT rename their own row to the owner id',
  denied(edit((s) => { s.users.find((u) => u.id === CREW).id = OWNER; }), 'crew', CREW));

// Append a SECOND row carrying the admin's id but an owner role. byId keeps the LAST
// entry for a duplicate key, so the appended row is the one compared.
ok('crew CANNOT shadow an existing user with a duplicate id + higher role',
  denied(edit((s) => { s.users.push({ id: ADMIN, role: 'owner', status: 'active', name: 'Admin' }); }), 'crew', CREW));
ok('admin CANNOT shadow a user with a duplicate id + owner role',
  denied(edit((s) => { s.users.push({ id: ADMIN, role: 'owner', status: 'active', name: 'Admin' }); }), 'admin', ADMIN));

// Delete-then-re-add in ONE write: the re-added row is `!before`, i.e. the "new team
// member" branch, which is manager-only and owner-only for an owner role.
ok('crew CANNOT delete-and-readd themselves as owner in one write',
  denied(edit((s) => { s.users = s.users.filter((u) => u.id !== CREW); s.users.push({ id: 'u_crew2', role: 'owner', status: 'active' }); }), 'crew', CREW));
ok('admin CANNOT mint an owner via the add branch',
  denied(edit((s) => { s.users.push({ id: 'u_new', role: 'owner', status: 'active' }); }), 'admin', ADMIN));
ok('admin CAN add an ordinary crew member', !denied(edit((s) => { s.users.push({ id: 'u_new', role: 'crew', status: 'active' }); }), 'admin', ADMIN));

// ── TYPE CONFUSION ────────────────────────────────────────────────────────
// byId() ignores anything without an id and anything non-array. The question is
// whether a malformed payload can make the guard see "nothing changed".
ok('crew CANNOT blank the whole roster (array -> [])',
  denied(edit((s) => { s.users = []; }), 'crew', CREW));
ok('crew CANNOT replace the roster with a non-array',
  denied(edit((s) => { s.users = { [OWNER]: { id: OWNER, role: 'crew' } }; }), 'crew', CREW));
ok('crew CANNOT drop users by nulling the slice',
  denied(edit((s) => { s.users = null; }), 'crew', CREW));
ok('crew CANNOT strip ids so rows become invisible to byId',
  denied(edit((s) => { s.users = s.users.map((u) => (u.id === OWNER ? { ...u, id: undefined } : u)); }), 'crew', CREW));

// ── CASE + COERCION ───────────────────────────────────────────────────────
// The 1c review found `(b.role||'crew')==='owner'` bypassed by "Owner". norm() is a
// strict JSON compare, so any case change reads as a change and is refused.
ok('crew CANNOT change their role even to a differently-cased value',
  denied(edit((s) => { s.users.find((u) => u.id === CREW).role = 'Crew'; }), 'crew', CREW));
ok('crew CANNOT set role to "Owner" (case trick)',
  denied(edit((s) => { s.users.find((u) => u.id === CREW).role = 'Owner'; }), 'crew', CREW));
ok('crew CANNOT set role to an array containing owner',
  denied(edit((s) => { s.users.find((u) => u.id === CREW).role = ['owner']; }), 'crew', CREW));
ok('crew CANNOT null their status to dodge the status compare',
  denied(edit((s) => { s.users.find((u) => u.id === CREW).status = null; }), 'crew', CREW));

// WAS a known-inert gap: an ADMIN could create a user whose role is "Owner" (capital),
// because the add branch compared `after.role === 'owner'` literally. It was a BROKEN
// user rather than a privileged one (every consumer compares lowercase), but it would
// have become a live admin->owner escalation the day anything case-folded roles on
// read. Since 2026-09-23 a new member's role must be one the caller may give
// (lib/roles canGiveRole), which an unknown role never is, so the row is refused.
ok('admin creating role "Owner" (case trick) is refused: an unknown role is never given',
  denied(edit((s) => { s.users.push({ id: 'u_new', role: 'Owner', status: 'active' }); }), 'admin', ADMIN));

// ── SELF vs OTHERS ────────────────────────────────────────────────────────
ok('crew CAN edit their own non-authority profile', !denied(edit((s) => { s.users.find((u) => u.id === CREW).name = 'New Name'; }), 'crew', CREW));
ok('crew CANNOT edit another member\'s profile', denied(edit((s) => { s.users.find((u) => u.id === ADMIN).name = 'Hacked'; }), 'crew', CREW));
// ⚠️ `role` and `selfId` ARE THE TRUST BOUNDARY — the guard cannot validate them,
// it can only act on them. Both must come from resolveAuthority() (the JWT claim)
// and NEVER from the request body. These two assertions pin what breaks if that
// ever changes, so the consequence is visible in a diff rather than discovered:
ok('with the TRUE selfId, crew cannot touch the owner row',
  denied(edit((s) => { s.users.find((u) => u.id === OWNER).name = 'Hacked'; }), 'crew', CREW));
ok('DOCUMENTED: a forged selfId equal to the target WOULD permit that edit — which is precisely why selfId must be claim-derived',
  !denied(edit((s) => { s.users.find((u) => u.id === OWNER).name = 'Hacked'; }), 'crew', OWNER));
ok('DOCUMENTED: a forged role of owner WOULD permit everything — same reason',
  !denied(edit((s) => { s.users.find((u) => u.id === CREW).role = 'owner'; }), 'owner', CREW));

// ── ASSIGNMENT ESCALATION (the crew_assignments feeder) ───────────────────
ok('crew CANNOT self-assign to a site', denied(edit((s) => { s.sites[0].standingCrewIds = [CREW]; }), 'crew', CREW));
ok('crew CANNOT self-assign via the ACCOUNT', denied(edit((s) => { s.clients[0].standingCrewIds = [CREW]; }), 'crew', CREW));
ok('crew CANNOT create a new site with themselves assigned',
  denied(edit((s) => { s.sites.push({ id: 's2', clientId: 'c1', standingCrewIds: [CREW] }); }), 'crew', CREW));
ok('crew CANNOT remove someone else\'s assignment', denied(edit((s) => { s.sites[0].standingCrewIds = []; }), 'crew', CREW));
ok('admin CAN reassign crew', !denied(edit((s) => { s.sites[0].standingCrewIds = [CREW]; }), 'admin', ADMIN));
// Order-insensitivity is intended (the UI reorders freely) and must not be a hole:
// reordering is allowed, but the SET changing is not.
ok('reordering an assignment list alone is not a violation',
  !denied(edit((s) => { s.sites[0].standingCrewIds = ['u_other']; }), 'crew', CREW));

// ── FINGERPRINT: the guard's cost optimisation must not become its bypass ─
// The endpoint skips the deep check when the fingerprint is unchanged, so ANY
// authority edit that does not move the digest slides through as "unchanged".
const fpBase = protectedFingerprint(base());
const movesFp = (fn) => protectedFingerprint(edit(fn)) !== fpBase;
ok('fingerprint moves on a role change', movesFp((s) => { s.users.find((u) => u.id === CREW).role = 'owner'; }));
ok('fingerprint moves on a status change', movesFp((s) => { s.users.find((u) => u.id === CREW).status = 'banned'; }));
ok('fingerprint moves on a permission-matrix change', movesFp((s) => { s.permissions = [{ id: 'invoices.view', roles: ['owner', 'crew'] }]; }));
ok('fingerprint moves on an overrides change', movesFp((s) => { s.userPermissionOverrides = [{ userId: CREW, grants: ['invoices.view'] }]; }));
ok('fingerprint moves on a site self-assignment', movesFp((s) => { s.sites[0].standingCrewIds = [CREW]; }));
ok('fingerprint moves on an account self-assignment', movesFp((s) => { s.clients[0].standingCrewIds = [CREW]; }));
ok('fingerprint moves when a user is REMOVED', movesFp((s) => { s.users = s.users.filter((u) => u.id !== OWNER); }));
ok('fingerprint moves when a user is ADDED', movesFp((s) => { s.users.push({ id: 'u_new', role: 'owner', status: 'active' }); }));
ok('fingerprint moves when a new site arrives WITH crew', movesFp((s) => { s.sites.push({ id: 's2', standingCrewIds: [CREW] }); }));
// Intended no-ops: these must NOT move it, or every ordinary save pays a 314KB read.
ok('fingerprint IGNORES a profile-only edit', !movesFp((s) => { s.users.find((u) => u.id === CREW).name = 'Renamed'; }));
// ⚠️ THIS ASSERTION FLIPPED, deliberately. It used to require that a crew-less new site
// be invisible to the fingerprint, because creation is common and the deeper check costs
// a 314 KB read. But a site's PARENT ACCOUNT is authority, not topology: getAssignedScope
// expands an assigned client into all of its sites via sites[].clientId, so re-parenting
// a site pulls it into a crew user's scope — which gates door/alarm code reveal. A
// snapshot fingerprint cannot distinguish "new site" from "re-parented site", so covering
// the re-parent means covering creation too.
//
// The trade is one extra deeper read PER SITE CREATION (the new fingerprint is then
// stored, so it is not ongoing) in exchange for closing a privilege escalation. The
// property that actually protects the hot path — ordinary field edits stay free — is
// asserted directly below and still holds.
ok('fingerprint MOVES on a new site (its parentage is authority)', movesFp((s) => { s.sites.push({ id: 's2', clientId: 'c1', standingCrewIds: [] }); }));
ok('  ...and MOVES when an existing site is re-parented', movesFp((s) => { s.sites[0].clientId = 'c_other'; }));
ok('  🔴 ...but still IGNORES an ordinary field edit on a site (the hot path)',
  !movesFp((s) => { s.sites[0].name = 'Renamed Site'; s.sites[0].address = '1 New St'; }));
ok('fingerprint IGNORES user array REORDERING', !movesFp((s) => { s.users.reverse(); }));
ok('fingerprint IGNORES assignment REORDERING', !movesFp((s) => { s.sites[0].standingCrewIds = ['u_other']; }));
// A digest whose length component is its only difference would be weak; check that a
// same-length substitution still moves it.
ok('fingerprint moves on a same-LENGTH role substitution',
  protectedFingerprint({ ...base(), users: [{ id: OWNER, role: 'admin', status: 'active' }] })
  !== protectedFingerprint({ ...base(), users: [{ id: OWNER, role: 'owner', status: 'active' }] }));

// ── crew_assignments: the derivation itself ──────────────────────────────
const rows = (s) => assignmentRowsFromState(s);
ok('a site assignment becomes one row', rows({ sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u1'] }] }).length === 1);
ok('  ...carrying the site AND its account', (() => {
  const r = rows({ sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u1'] }] })[0];
  return r.site_id === 's1' && r.client_id === 'c1' && r.source === 'standing_site';
})());
ok('an account assignment has a null site', (() => {
  const r = rows({ clients: [{ id: 'c1', standingCrewIds: ['u1'] }] })[0];
  return r.site_id === null && r.client_id === 'c1' && r.source === 'standing_client';
})());
// Duplicates must collapse — the table is delete-then-insert, and duplicate rows
// would inflate it without changing meaning.
ok('duplicate ids within one site collapse to one row',
  rows({ sites: [{ id: 's1', standingCrewIds: ['u1', 'u1', 'u1'] }] }).length === 1);
ok('the same user on a site AND its account yields two DISTINCT rows',
  rows({ sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u1'] }], clients: [{ id: 'c1', standingCrewIds: ['u1'] }] }).length === 2);
// Malformed input must produce NO rows rather than a row that means nothing — a row
// with a null user_id would be a wildcard the reader could not interpret.
ok('empty / null / undefined user ids are dropped',
  rows({ sites: [{ id: 's1', standingCrewIds: ['', null, undefined, 0, false] }] }).length === 0);
ok('a non-array standingCrewIds is ignored', rows({ sites: [{ id: 's1', standingCrewIds: 'u1' }] }).length === 0);
ok('a null sites slice is ignored', rows({ sites: null, clients: null }).length === 0);
ok('an undefined state is ignored', rows(undefined).length === 0);
ok('a site with no id still records the ACCOUNT, never a null/null row', (() => {
  const r = rows({ sites: [{ clientId: 'c1', standingCrewIds: ['u1'] }] });
  return r.length === 1 && r[0].site_id === null && r[0].client_id === 'c1';
})());
ok('every row is org-pinned', rows({ sites: [{ id: 's1', standingCrewIds: ['u1'] }] }).every((r) => !!r.organization_id));
// Odd-but-legal ids must not break the dedupe key or reach through the prototype.
ok('a __proto__ user id is treated as an ordinary string',
  rows({ sites: [{ id: 's1', standingCrewIds: ['__proto__'] }] }).length === 1);
ok('ids containing the key separator do not collide', (() => {
  const r = rows({ sites: [{ id: 's1', standingCrewIds: ['a|standing_site|s1', 'a'] }] });
  return r.length === 2;
})());

// ── MONEY SLICES: payroll lines · reimbursements · pay-run config (S87) ─────
// An attacker crafting the blob directly (not through the UI), where crew hold none of
// payroll.edit / hr.edit / time.config. The money projections must be robust to id
// tricks, type confusion and delete-and-re-add — a line still pays out even with no id.
{
  const money = () => ({
    ...base(),
    permissions: seedPermissions(),
    payrollLines: [{ id: 'pl1', userId: 'u_other', periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 100, taxable: true }],
    reimbursements: [{ id: 'r1', userId: 'u_other', amount: 20, status: 'pending', periodKey: 'p1' }],
    opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payDriveTime: true },
  });
  const bad = (fn) => { const s = JSON.parse(JSON.stringify(money())); fn(s); return protectedFieldViolations(money(), s, 'crew', CREW); };
  ok('crew cannot add a payroll line with NO id (byId would drop it, but it still pays)',
    bad((s) => s.payrollLines.push({ userId: CREW, periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 5000, taxable: true })).includes('add or change a payroll line'));
  ok('crew cannot slip an amount past the check as a STRING',
    bad((s) => { s.payrollLines[0].amount = '9999'; }).includes('add or change a payroll line'));
  ok('crew cannot delete-and-re-add a line to launder it',
    bad((s) => { s.payrollLines = [{ id: 'pl2', userId: CREW, periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 4000, taxable: true }]; }).includes('add or change a payroll line'));
  ok('crew cannot add a line with a __proto__ id',
    bad((s) => s.payrollLines.push({ id: '__proto__', userId: CREW, periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 1, taxable: true })).includes('add or change a payroll line'));
  ok('crew cannot craft an id-less approved reimbursement for themselves',
    bad((s) => s.reimbursements.push({ userId: CREW, amount: 500, status: 'approved', periodKey: 'p1' })).some((v) => v.includes('reimbursement')));
  ok('crew cannot set the OT multiplier as a string',
    bad((s) => { s.opsSettings.otMultiplier = '5'; }).includes('change operations settings'));
  ok('crew cannot toggle paid drive time',
    bad((s) => { s.opsSettings.payDriveTime = false; }).includes('change operations settings'));
  ok('crew cannot widen the geofence radius (whole opsSettings gated, 2026-09-23)',
    bad((s) => { s.opsSettings.defaultGeofenceRadiusM = 5000; }).includes('change operations settings'));
  // Pay + HR on a user row (2026-09-23): own is owner/admin only, another's needs the key.
  ok('crew cannot raise their OWN pay (a crafted user-row edit)',
    bad((s) => { s.users.find((u) => u.id === CREW).pay = { type: 'hourly', hourlyRate: 999 }; }).includes('change your own pay'));
  ok('crew cannot change their OWN HR record',
    bad((s) => { s.users.find((u) => u.id === CREW).hr = { employeeId: 'E9', ptoAllowanceDays: 99 }; }).includes('edit your own HR record'));
  ok('crew cannot change ANOTHER member\'s pay (no payroll.rates.edit)',
    bad((s) => { s.users.find((u) => u.id === ADMIN).pay = { type: 'hourly', hourlyRate: 1 }; }).includes("change another member's pay"));
  ok('a pay edit MOVES the fingerprint (so the guard fires)',
    protectedFingerprint(money()) !== protectedFingerprint((() => { const s = JSON.parse(JSON.stringify(money())); s.users.find((u) => u.id === CREW).pay = { hourlyRate: 999 }; return s; })()));
  ok('owner is blocked on NO money edit (never tightened)',
    protectedFieldViolations(money(), (() => { const s = JSON.parse(JSON.stringify(money())); s.payrollLines.push({ id: 'x', userId: OWNER, periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 9, taxable: true }); s.opsSettings.otMultiplier = 3; s.users.find((u) => u.id === OWNER).pay = { hourlyRate: 5 }; return s; })(), 'owner', OWNER).length === 0);
  // A userName stamp is authority-neutral, so it neither refuses nor moves the digest.
  ok('a userName stamp on a payroll line is inert (no violation, no digest move)',
    bad((s) => { s.payrollLines[0].userName = 'X'; }).length === 0
    && protectedFingerprint(money()) === protectedFingerprint((() => { const s = JSON.parse(JSON.stringify(money())); s.payrollLines[0].userName = 'X'; return s; })()));
}

console.log(`\nauthority (adversarial): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
