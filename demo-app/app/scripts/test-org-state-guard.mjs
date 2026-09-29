// Field-level authorization for the org_state blob — the check that makes
// Increment 1e mean something.
//
// The proven-live hole (AUTHORIZATION_AUDIT.md) is that an authenticated user
// can write the whole blob and set their own users[].role = 'owner'. Revoking
// the browser's write policy in 1e only forces writes through
// /api/state/org-state; if that endpoint commits whatever it is handed, the
// escalation survives behind a service-role proxy. These tests pin the guard
// that closes it.
//
//   node scripts/test-org-state-guard.mjs
import { protectedFieldViolations as guard, protectedFingerprint, removedMemberIds } from '../api/_lib/orgStateGuard.js';
import { seedPermissions, PERMISSIONS, OWNER_CORE } from '../src/lib/roles.js';
import { payPeriodRange } from '../src/lib/payroll.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// A removal needs the pay facts the route reads (the committed pay slices + the time
// ledger); without them the guard refuses it (2026-09-23). These suites are about the
// role and identity rules, so by default they pass "nothing owed"; the pay rule has its
// own section below.
const NOTHING_OWED = { removal: { payState: {}, recentHours: new Set() } };
const protectedFieldViolations = (prev, next, role, self, facts = NOTHING_OWED) => guard(prev, next, role, self, facts);

const CREW = 'u_crew';
const ADMIN = 'u_admin';
const OWNER = 'u_owner';

const base = () => ({
  users: [
    { id: OWNER, role: 'owner', status: 'active', name: 'Owner', notificationPrefs: {} },
    { id: ADMIN, role: 'admin', status: 'active', name: 'Admin', notificationPrefs: {} },
    { id: CREW, role: 'crew', status: 'active', name: 'Crew', notificationPrefs: {} },
  ],
  permissions: [{ id: 'invoices.view', roles: ['owner'] }],
  userPermissionOverrides: [],
  sites: [{ id: 's1', standingCrewIds: ['u_other'] }],
  clients: [{ id: 'c1', standingCrewIds: [] }],
  company: { id: 'co', name: 'Clean Space', timezone: 'America/Los_Angeles' },
});
const edit = (fn) => { const s = base(); fn(s); return s; };
const denied = (next, role, self) => protectedFieldViolations(base(), next, role, self).length > 0;

// ── THE headline escalation ────────────────────────────────────────────────
const selfPromote = edit((s) => { s.users.find((u) => u.id === CREW).role = 'owner'; });
ok('crew CANNOT promote themselves to owner', denied(selfPromote, 'crew', CREW));
ok('admin CANNOT promote themselves to owner', denied(selfPromote, 'admin', ADMIN));
ok('owner CAN change roles', !denied(selfPromote, 'owner', OWNER));

const demoteOwner = edit((s) => { s.users.find((u) => u.id === OWNER).role = 'crew'; });
ok('crew CANNOT demote the owner', denied(demoteOwner, 'crew', CREW));
ok('admin CANNOT demote the owner', denied(demoteOwner, 'admin', ADMIN));

// ── permission matrix + overrides ──────────────────────────────────────────
const widenMatrix = edit((s) => { s.permissions = [{ id: 'invoices.view', roles: ['owner', 'crew'] }]; });
ok('crew CANNOT rewrite the permission matrix', denied(widenMatrix, 'crew', CREW));
ok('admin CANNOT rewrite the permission matrix', denied(widenMatrix, 'admin', ADMIN));
ok('owner CAN rewrite the permission matrix', !denied(widenMatrix, 'owner', OWNER));

const grantSelf = edit((s) => { s.userPermissionOverrides = [{ userId: CREW, grants: ['invoices.view'], revokes: [] }]; });
ok('crew CANNOT grant themselves an override', denied(grantSelf, 'crew', CREW));
ok('admin CANNOT grant an override', denied(grantSelf, 'admin', ADMIN));

// ── the org-wide display timezone (owner-only) — 2026-08-03 ────────────────
const changeTz = edit((s) => { s.company.timezone = 'Africa/Johannesburg'; });
ok('crew CANNOT change the company timezone', denied(changeTz, 'crew', CREW));
ok('admin CANNOT change the company timezone', denied(changeTz, 'admin', ADMIN));
ok('owner CAN change the company timezone', !denied(changeTz, 'owner', OWNER));
ok('fingerprint CHANGES on a timezone edit', protectedFingerprint(base()) !== protectedFingerprint(changeTz));
{
  const renameCompany = edit((s) => { s.company.name = 'CleanSpace LLC'; });
  ok('fingerprint IGNORES an ordinary company field edit (stays off the hot path)',
    protectedFingerprint(base()) === protectedFingerprint(renameCompany));
}

// ── standing crew assignment (gates door codes + QC scope) ─────────────────
const selfAssignSite = edit((s) => { s.sites[0].standingCrewIds = ['u_other', CREW]; });
ok('crew CANNOT self-assign to a site', denied(selfAssignSite, 'crew', CREW));
ok('admin CAN change site assignments', !denied(selfAssignSite, 'admin', ADMIN));

const selfAssignClient = edit((s) => { s.clients[0].standingCrewIds = [CREW]; });
ok('crew CANNOT self-assign to an account', denied(selfAssignClient, 'crew', CREW));

// Reordering the same ids is not a change — the UI reorders freely.
const reorder = edit((s) => { s.sites[0].standingCrewIds = ['u_other']; s.sites[0].standingCrewIds.push(); });
ok('reordering identical assignments is not a violation', !denied(reorder, 'crew', CREW));

// ── membership ─────────────────────────────────────────────────────────────
const addUser = edit((s) => { s.users.push({ id: 'u_new', role: 'crew', status: 'active' }); });
ok('crew CANNOT add a team member', denied(addUser, 'crew', CREW));
ok('admin CAN invite a crew member', !denied(addUser, 'admin', ADMIN));
const addOwner = edit((s) => { s.users.push({ id: 'u_new', role: 'owner', status: 'active' }); });
ok('admin CANNOT mint a Super Admin', denied(addOwner, 'admin', ADMIN));
ok('owner CAN mint a Super Admin', !denied(addOwner, 'owner', OWNER));
const removeUser = edit((s) => { s.users = s.users.filter((u) => u.id !== ADMIN); });
ok('crew CANNOT remove a team member', denied(removeUser, 'crew', CREW));
ok('admin CANNOT remove a team member', denied(removeUser, 'admin', ADMIN));

// ── the flows that MUST keep working (37 of 43 users are crew) ─────────────
const ownProfile = edit((s) => {
  const me = s.users.find((u) => u.id === CREW);
  me.name = 'Crew Renamed';
  me.notificationPrefs = { mobilePushEnabled: false };
});
ok('crew CAN edit their own profile + notification prefs', !denied(ownProfile, 'crew', CREW));

const othersProfile = edit((s) => { s.users.find((u) => u.id === ADMIN).name = 'Renamed'; });
ok("crew CANNOT edit another member's profile", denied(othersProfile, 'crew', CREW));
ok("admin CAN edit another member's profile", !denied(othersProfile, 'admin', ADMIN));

const ordinaryData = edit((s) => { s.sites.push({ id: 's2', standingCrewIds: [] }); });
ok('crew CAN create ordinary records with no crew assigned', !denied(ordinaryData, 'crew', CREW));

ok('an unchanged state is never a violation', !denied(base(), 'crew', CREW));

// ── fingerprint: the thing that keeps the guard off the hot path ───────────
ok('fingerprint is stable across identical states', protectedFingerprint(base()) === protectedFingerprint(base()));
// Creating a site now MOVES the fingerprint, because a site's parent account is
// authority (getAssignedScope expands an assigned client into all of its sites, so
// re-parenting is a privilege escalation) and a snapshot fingerprint cannot tell a new
// site from a re-parented one. Cost: one deeper read per site creation. See the longer
// note in test-authority-adversarial.mjs. Crew are still ALLOWED to create the site —
// only the cheap-path optimisation changes, not the permission (asserted above).
ok('fingerprint moves when a site is created (parentage is authority)',
  protectedFingerprint(base()) !== protectedFingerprint(ordinaryData));
// The property that actually keeps the guard off the hot path: editing fields on an
// existing record must stay free.
{
  const fieldEdit = edit((s) => { s.sites[0].name = 'Renamed'; s.sites[0].address = '9 Elm'; });
  ok('🔴 fingerprint IGNORES ordinary field edits on existing records',
    protectedFingerprint(base()) === protectedFingerprint(fieldEdit));
  ok('  ...and such an edit is still allowed for crew', !denied(fieldEdit, 'crew', CREW));
}
ok('fingerprint CHANGES on a role edit', protectedFingerprint(base()) !== protectedFingerprint(selfPromote));
ok('fingerprint CHANGES on a matrix edit', protectedFingerprint(base()) !== protectedFingerprint(widenMatrix));
ok('fingerprint CHANGES on an override edit', protectedFingerprint(base()) !== protectedFingerprint(grantSelf));
ok('fingerprint CHANGES on a site assignment edit', protectedFingerprint(base()) !== protectedFingerprint(selfAssignSite));
ok('fingerprint CHANGES on an account assignment edit', protectedFingerprint(base()) !== protectedFingerprint(selfAssignClient));
ok('fingerprint CHANGES on member add', protectedFingerprint(base()) !== protectedFingerprint(addUser));
ok('fingerprint CHANGES on member removal', protectedFingerprint(base()) !== protectedFingerprint(removeUser));
ok('fingerprint IGNORES own-profile edits', protectedFingerprint(base()) === protectedFingerprint(ownProfile));
// A member's login email is IDENTITY: a login with no role claim (every manager) is
// matched to its row by email, so re-pointing one is an authority change. Outside the
// digest, a save changing only that skipped the guard: a manager set the owner row's
// email to their own and their next request ran as a Super Admin (S77 review).
const repointEmail = edit((s) => { s.users.find((u) => u.id === OWNER).email = 'crew@cs.co'; });
ok("fingerprint CHANGES when a member's email changes (claim-less logins are matched by it)",
  protectedFingerprint(base()) !== protectedFingerprint(repointEmail));
ok('  ...and the guard then refuses it for crew', denied(repointEmail, 'crew', CREW));

// EVERY protected check must be covered by the fingerprint, or the guard is
// silently skipped for that field — the one failure mode that matters here.
ok('no protected change escapes the fingerprint',
  [selfPromote, demoteOwner, widenMatrix, grantSelf, selfAssignSite, selfAssignClient, addUser, addOwner, removeUser, changeTz, repointEmail]
    .every((s) => protectedFingerprint(s) !== protectedFingerprint(base())));

// ── time off: who may book it (2026-09-22) ─────────────────────────────────
// The UI books time off on Team › Time off (settings.team.edit) and HR › PTO
// (hr.edit). The guard used an owner+admin ROLE list that predated the 4th-tier
// `manager` role, so every manager's call-out was rejected on save.
{
  const MGR = 'u_mgr';
  const withMgr = () => { const s = base(); s.users.push({ id: MGR, role: 'manager', status: 'active', name: 'Mgr', notificationPrefs: {} }); return s; };
  const booked = (prevState) => { const s = JSON.parse(JSON.stringify(prevState)); s.timeOff = [{ id: 'to1', userId: CREW, startDate: '2026-09-22', endDate: '2026-09-22', kind: 'callout' }]; return s; };
  const v = (prevState, role, self) => protectedFieldViolations(prevState, booked(prevState), role, self);
  ok('a MANAGER can book a call-out (holds settings.team.edit + hr.edit by default)', v(withMgr(), 'manager', MGR).length === 0);
  ok('an admin can still book time off', v(withMgr(), 'admin', ADMIN).length === 0);
  ok('the owner can book time off', v(withMgr(), 'owner', OWNER).length === 0);
  ok('crew CANNOT book or forge time off', v(withMgr(), 'crew', CREW).includes('change time off'));
  const revoked = withMgr();
  revoked.userPermissionOverrides = [{ userId: MGR, grants: [], revokes: ['settings.team.edit', 'hr.edit'] }];
  ok('a manager with BOTH keys revoked cannot book time off', v(revoked, 'manager', MGR).includes('change time off'));
  const granted = withMgr();
  granted.userPermissionOverrides = [{ userId: CREW, grants: ['hr.edit'], revokes: [] }];
  ok('crew granted hr.edit by override may book (the grant\'s intent)', v(granted, 'crew', CREW).length === 0);
  const noChange = withMgr();
  noChange.timeOff = [];
  ok('crew saving WITHOUT touching time off is not flagged', protectedFieldViolations(noChange, JSON.parse(JSON.stringify(noChange)), 'crew', CREW).length === 0);
}

// ── team administration through the Settings → Roles matrix (2026-09-23) ────
// Every Team check used an owner / owner+admin ROLE LIST that predated the 4th-tier
// `manager` (full access by default, pared back per client in Settings → Roles), so a
// manager's Team edits were refused on save. Each check now ALSO passes for whoever
// holds the key the UI gates that action on, read from the COMMITTED matrix +
// overrides, within the owner's limits (2026-09-23): only a Super Admin makes, re-roles,
// disables or removes a Super Admin or edits their overrides; nobody re-roles or removes
// themselves or edits their own overrides; a login email is never editable through the
// matrix; the company timezone stays Super-Admin-only.
{
  const MGR = 'u_mgr';
  const MEMBER = 'u_member'; // the crew member being administered
  // The real default matrix (roles.js seedPermissions, what the seed commits), not a
  // restated literal: a manager holds settings.team.edit, staff.assignRoles,
  // staff.editOverrides, settings.roles.edit and hr.edit, but NOT payroll.rates.edit.
  const team = () => ({
    ...base(),
    permissions: seedPermissions(),
    users: [
      { id: OWNER, role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co' },
      { id: ADMIN, role: 'admin', status: 'active', name: 'Admin', email: 'admin@cs.co' },
      { id: MGR, role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@cs.co' },
      { id: CREW, role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co' },
      { id: MEMBER, role: 'crew', status: 'active', name: 'Member', email: 'member@cs.co', phone: '555-0100',
        pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'EMP-0005', hireDate: '2025-01-02' } },
    ],
  });
  const tweak = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; };
  // Violations for `role`/`self` making edit `fn` against the committed state `from`.
  const v = (fn, role, self, from = team()) => protectedFieldViolations(from, tweak(from, fn), role, self);
  const allows = (fn, role, self, from) => v(fn, role, self, from).length === 0;
  const refuses = (fn, role, self, from) => v(fn, role, self, from).length > 0;
  const row = (s, id) => s.users.find((u) => u.id === id);
  // Pared back per client: `manager` taken off a key in the matrix, or one member's key
  // revoked on Team › Access. An override GRANT is the other direction: the grant's intent.
  const offFor = (tier, key) => tweak(team(), (s) => {
    s.permissions = s.permissions.map((p) => (p.id === key ? { ...p, roles: p.roles.filter((r) => r !== tier) } : p));
  });
  const offForManagers = (key) => offFor('manager', key);
  const overridden = (userId, grants, revokes = []) => tweak(team(), (s) => { s.userPermissionOverrides = [{ userId, grants, revokes }]; });

  const invite = (s) => { s.users.push({ id: 'u_new', role: 'crew', status: 'active', name: 'New', email: 'new@cs.co' }); };
  const promote = (s) => { row(s, MEMBER).role = 'admin'; };
  const disable = (s) => { row(s, MEMBER).status = 'disabled'; };
  const rephone = (s) => { row(s, MEMBER).phone = '555-0199'; };
  const rehire = (s) => { row(s, MEMBER).hr = { ...row(s, MEMBER).hr, hireDate: '2025-02-03' }; };
  const repay = (s) => { row(s, MEMBER).pay = { type: 'hourly', hourlyRate: 45 }; };
  const remove = (s) => { s.users = s.users.filter((u) => u.id !== MEMBER); };
  const widenMatrix = (s) => { s.permissions = s.permissions.map((p) => (p.id === 'invoices.view' ? { ...p, roles: [...p.roles, 'admin'] } : p)); };
  const grantMember = (s) => { s.userPermissionOverrides = [{ userId: MEMBER, grants: ['invoices.view'], revokes: [] }]; };
  const everyEdit = [invite, promote, disable, rephone, rehire, repay, remove, widenMatrix, grantMember];

  // The UI flows a default manager could not save before (each RED against the role lists).
  ok('a MANAGER can add a team member (settings.team.edit)', allows(invite, 'manager', MGR));
  ok("a MANAGER can change a crew member's role (staff.assignRoles)", allows(promote, 'manager', MGR));
  ok('a MANAGER can disable a member (settings.team.edit)', allows(disable, 'manager', MGR));
  ok("a MANAGER can edit another member's profile (settings.team.edit)", allows(rephone, 'manager', MGR));
  ok("a MANAGER can edit another member's HR record (hr.edit)", allows(rehire, 'manager', MGR));
  ok('a MANAGER can remove a member (settings.team.edit)', allows(remove, 'manager', MGR));
  ok('a MANAGER can edit the permission matrix (settings.roles.edit)', allows(widenMatrix, 'manager', MGR));
  ok("a MANAGER can edit another member's overrides (staff.editOverrides)", allows(grantMember, 'manager', MGR));
  {
    // Removing a member also drops their override row (DELETE_USER). That rides on the
    // removal's key, so a manager without staff.editOverrides can still remove them.
    const from = tweak(team(), (s) => {
      s.userPermissionOverrides = [
        { userId: MGR, grants: [], revokes: ['staff.editOverrides'] },
        { userId: MEMBER, grants: ['invoices.view'], revokes: [] },
      ];
    });
    ok('  ...and a removal takes the member\'s override row with it, without staff.editOverrides',
      allows((s) => { remove(s); s.userPermissionOverrides = s.userPermissionOverrides.filter((o) => o.userId !== MEMBER); }, 'manager', MGR, from));
  }

  // Admin keeps everything it could do; what it holds by default now follows the matrix
  // (disable + remove ride settings.team.edit, the owner's call 2026-09-23).
  ok('an admin can still add a member and edit a profile', allows(invite, 'admin', ADMIN) && allows(rephone, 'admin', ADMIN) && allows(repay, 'admin', ADMIN));
  ok('an admin can now disable a member (settings.team.edit)', allows(disable, 'admin', ADMIN));
  ok('an admin can now remove a member (settings.team.edit)', allows(remove, 'admin', ADMIN));

  // A no-access status now ENDS server access (authz.js ROSTER STATUS), so disabling an
  // ADMIN takes admin+ by ROLE, not a settings.team.edit grant (owner's call 2026-09-23).
  const disableAdmin = (s) => { row(s, ADMIN).status = 'disabled'; };
  const twoAdmins = tweak(team(), (s) => { row(s, MEMBER).role = 'admin'; });
  ok('🔴 a MANAGER cannot disable an Admin (a no-access status ends access)', refuses(disableAdmin, 'manager', MGR));
  ok('🔴  ...nor can crew granted settings.team.edit', refuses(disableAdmin, 'crew', CREW, overridden(CREW, ['settings.team.edit'])));
  ok('an ADMIN can disable another Admin', allows((s) => { row(s, MEMBER).status = 'disabled'; }, 'admin', ADMIN, twoAdmins));
  ok('an admin can still disable a manager or a crew member', allows((s) => { row(s, MGR).status = 'disabled'; }, 'admin', ADMIN) && allows(disable, 'admin', ADMIN));
  ok('a manager can still disable a crew member (unchanged)', allows(disable, 'manager', MGR));

  // CS-329 (owner's call 2026-09-24): ending an Admin's access covers REMOVAL too, not just a
  // no-access status. A manager or crew holding settings.team.edit may end a manager's or a
  // crew member's access, never an Admin's — admin+ by ROLE (lib/roles canEndAccess), the same
  // floor as disable/revoke. Demoting the Admin first no longer escapes it (CS-355 below).
  const removeAdmin = (s) => { s.users = s.users.filter((u) => u.id !== ADMIN); };
  ok('🔴 a MANAGER cannot remove an Admin (ending access is admin+ by role)', refuses(removeAdmin, 'manager', MGR));
  ok('🔴  ...nor can crew granted settings.team.edit', refuses(removeAdmin, 'crew', CREW, overridden(CREW, ['settings.team.edit'])));
  ok('an ADMIN can remove another Admin', allows((s) => { s.users = s.users.filter((u) => u.id !== MEMBER); }, 'admin', ADMIN, twoAdmins));
  ok('an admin can still remove a manager or a crew member',
    allows((s) => { s.users = s.users.filter((u) => u.id !== MGR); }, 'admin', ADMIN) && allows(remove, 'admin', ADMIN));
  ok('a manager can still remove a crew member (unchanged)', allows(remove, 'manager', MGR));

  // CS-355 (owner's call 2026-09-25): changing an Admin's access level is admin+ BY ROLE too.
  // A manager holding staff.assignRoles could DEMOTE an Admin (Admin → crew) in one save; once
  // crew, a later save could disable or remove them. So a role change whose CURRENT (before)
  // role is admin now shares the canEndAccess floor: a manager or crew is refused, an admin or
  // owner may. Promoting TO Admin (before.role !== 'admin') stays canGiveRole's rule, unaffected.
  const demoteAdmin = (s) => { row(s, ADMIN).role = 'crew'; };
  const demoteAdminToManager = (s) => { row(s, ADMIN).role = 'manager'; };
  ok('🔴 a MANAGER cannot demote an Admin (reducing access is admin+ by role)', refuses(demoteAdmin, 'manager', MGR));
  ok('🔴  ...and the violation names the Admin floor', v(demoteAdmin, 'manager', MGR).includes("change an Admin's access level"));
  ok('🔴  ...nor Admin → manager (still a reduction from Admin)', refuses(demoteAdminToManager, 'manager', MGR));
  ok('🔴  ...nor can crew granted staff.assignRoles', refuses(demoteAdmin, 'crew', CREW, overridden(CREW, ['staff.assignRoles'])));
  // The two-step attack: step 1 (demote) is refused, so the Admin never becomes crew and the
  // follow-up removal (step 2, blocked by CS-329) never gets its precondition.
  ok('🔴 CS-355 two-step: the demotion is refused, and with the Admin still an Admin the removal stays refused (CS-329)',
    refuses(demoteAdmin, 'manager', MGR) && refuses(removeAdmin, 'manager', MGR));
  // An admin (with staff.assignRoles) may change ANOTHER Admin's role, within canGiveRole.
  const adminMayAssign = tweak(twoAdmins, (s) => { s.userPermissionOverrides = [{ userId: ADMIN, grants: ['staff.assignRoles'], revokes: [] }]; });
  ok('an ADMIN granted staff.assignRoles CAN demote another Admin (MEMBER admin → crew)',
    allows((s) => { row(s, MEMBER).role = 'crew'; }, 'admin', ADMIN, adminMayAssign));
  ok("the owner is unaffected: may change an Admin's role", allows(demoteAdmin, 'owner', OWNER));
  // Promotion TO Admin is not gated by this rule (before.role is not admin), within canGiveRole.
  ok('a manager may still promote a crew member to Admin (promotion TO Admin is not gated)', allows(promote, 'manager', MGR));
  ok('a manager may still change a crew member crew → manager', allows((s) => { row(s, MEMBER).role = 'manager'; }, 'manager', MGR));
  ok("an admin still can't change roles, the matrix or overrides by default",
    refuses(promote, 'admin', ADMIN) && refuses(widenMatrix, 'admin', ADMIN) && refuses(grantMember, 'admin', ADMIN));
  ok('an admin GRANTED staff.assignRoles may change a role', allows(promote, 'admin', ADMIN, overridden(ADMIN, ['staff.assignRoles'])));
  ok('the owner can still do all of it', everyEdit.every((fn) => allows(fn, 'owner', OWNER)));
  // Never tightened: the role lists still stand on their own, whatever the matrix says.
  ok('an admin keeps inviting + editing profiles by role with settings.team.edit taken off admins',
    allows(invite, 'admin', ADMIN, offFor('admin', 'settings.team.edit')) && allows(rephone, 'admin', ADMIN, offFor('admin', 'settings.team.edit')));
  ok('the owner keeps re-roling + overrides with those keys taken off owners',
    allows(promote, 'owner', OWNER, offFor('owner', 'staff.assignRoles')) && allows(grantMember, 'owner', OWNER, offFor('owner', 'staff.editOverrides')));

  // It reads the MATRIX, not the role name: a pared-back manager is refused.
  ok('a manager with settings.team.edit taken off managers cannot add, disable, edit or remove',
    [invite, disable, rephone, remove].every((fn) => refuses(fn, 'manager', MGR, offForManagers('settings.team.edit'))));
  ok('a manager whose staff.assignRoles is revoked cannot change a role', refuses(promote, 'manager', MGR, overridden(MGR, [], ['staff.assignRoles'])));
  ok('a manager with settings.roles.edit off cannot edit the matrix', refuses(widenMatrix, 'manager', MGR, offForManagers('settings.roles.edit')));
  ok('a manager with staff.editOverrides off cannot edit overrides', refuses(grantMember, 'manager', MGR, offForManagers('staff.editOverrides')));
  ok('a manager without hr.edit cannot edit an HR record...', refuses(rehire, 'manager', MGR, offForManagers('hr.edit')));
  ok('  ...but can still edit the rest of the profile', allows(rephone, 'manager', MGR, offForManagers('hr.edit')));
  ok("pay is payroll.rates.edit: a default manager cannot change another member's pay...", refuses(repay, 'manager', MGR));
  ok('  ...a manager GRANTED payroll.rates.edit can', allows(repay, 'manager', MGR, overridden(MGR, ['payroll.rates.edit'])));
  ok("crew GRANTED settings.team.edit by override may add a member (the grant's intent)", allows(invite, 'crew', CREW, overridden(CREW, ['settings.team.edit'])));
  ok('crew still cannot do any of it', everyEdit.every((fn) => refuses(fn, 'crew', CREW)));
  {
    // A malformed committed slice must not throw inside can() (the route would 500 every
    // save): a malformed row reads as a missing one, i.e. the schema default / no override.
    const junk = [
      tweak(team(), (s) => { s.permissions = { broken: true }; s.userPermissionOverrides = [null, 'x', { userId: MGR, grants: [], revokes: [] }]; }),
      tweak(team(), (s) => {
        s.permissions = s.permissions.map((p) => (p.id === 'settings.team.edit' ? { ...p, roles: null } : p));
        s.userPermissionOverrides = [{ userId: MGR, grants: 5, revokes: {} }, { userId: CREW, grants: 'settings.team.edit' }];
      }),
    ];
    let threw = false;
    let mgrOk = true;
    let crewRefused = true;
    try {
      for (const j of junk) {
        mgrOk = mgrOk && allows(invite, 'manager', MGR, j);
        crewRefused = crewRefused && refuses(invite, 'crew', CREW, j);
      }
    } catch { threw = true; }
    ok('a malformed committed matrix / overrides slice does not throw', !threw);
    ok('  ...and reads as the schema defaults (manager may invite, crew may not)', !threw && mgrOk && crewRefused);
  }
  // Every client's can() reads these slices on every render: a malformed row written now
  // (roles: null, grants: 'x') would crash the app for everyone, the owner included.
  ok('a manager cannot write a malformed matrix row',
    refuses((s) => { s.permissions = s.permissions.map((p) => (p.id === 'invoices.view' ? { ...p, roles: null } : p)); }, 'manager', MGR));
  ok('  ...nor replace the matrix with a non-array', refuses((s) => { s.permissions = { 'invoices.view': ['owner'] }; }, 'manager', MGR));
  ok("  ...while a malformed row already committed doesn't block a manager's other matrix edits",
    allows(widenMatrix, 'manager', MGR, tweak(team(), (s) => { s.permissions.push({ id: 'legacy.key', roles: null }); })));
  ok('a manager cannot write a malformed override row',
    refuses((s) => { s.userPermissionOverrides = [{ userId: MEMBER, grants: 'invoices.view', revokes: [] }]; }, 'manager', MGR));
  ok('the COMMITTED matrix decides: granting crew the key in the same save does not count',
    v((s) => {
      s.permissions = s.permissions.map((p) => (p.id === 'settings.team.edit' ? { ...p, roles: [...p.roles, 'crew'] } : p));
      invite(s);
    }, 'crew', CREW).includes('add a team member'));
  ok('  ...nor does a grant on your own override row in the same save',
    v((s) => { s.userPermissionOverrides = [{ userId: CREW, grants: ['settings.team.edit'], revokes: [] }]; invite(s); }, 'crew', CREW)
      .includes('add a team member'));

  // The owner's limits (2026-09-23): refused even with every key held.
  ok('a manager cannot change their OWN role', refuses((s) => { row(s, MGR).role = 'admin'; }, 'manager', MGR));
  ok('a manager cannot make someone a Super Admin', refuses((s) => { row(s, MEMBER).role = 'owner'; }, 'manager', MGR));
  ok("a manager cannot change a Super Admin's role", refuses((s) => { row(s, OWNER).role = 'manager'; }, 'manager', MGR));
  ok('a manager cannot set a role the app does not have',
    refuses((s) => { row(s, MEMBER).role = 'Owner'; }, 'manager', MGR) && refuses((s) => { row(s, MEMBER).role = ['owner']; }, 'manager', MGR));
  ok('a manager cannot disable a Super Admin', refuses((s) => { row(s, OWNER).status = 'disabled'; }, 'manager', MGR));
  ok('a manager cannot remove a Super Admin', refuses((s) => { s.users = s.users.filter((u) => u.id !== OWNER); }, 'manager', MGR));
  ok('a manager cannot remove themselves', refuses((s) => { s.users = s.users.filter((u) => u.id !== MGR); }, 'manager', MGR));
  ok('a manager cannot edit their OWN overrides (no self-grants)',
    refuses((s) => { s.userPermissionOverrides = [{ userId: MGR, grants: ['payroll.rates.edit'], revokes: [] }]; }, 'manager', MGR));
  ok("a manager cannot edit a Super Admin's overrides",
    refuses((s) => { s.userPermissionOverrides = [{ userId: OWNER, grants: [], revokes: ['staff.editOverrides'] }]; }, 'manager', MGR));
  ok('  ...not even by slipping a second row for them in front of theirs (can() reads the first)',
    refuses((s) => { s.userPermissionOverrides.unshift({ userId: OWNER, grants: [], revokes: ['staff.editOverrides'] }); }, 'manager', MGR, overridden(OWNER, ['invoices.view'])));
  ok('a manager cannot write overrides for someone not on the team',
    refuses((s) => { s.userPermissionOverrides = [{ userId: 'u_ghost', grants: ['invoices.view'], revokes: [] }]; }, 'manager', MGR));
  ok('a manager cannot replace the overrides list with a non-array',
    refuses((s) => { s.userPermissionOverrides = { [MEMBER]: { grants: ['invoices.view'] } }; }, 'manager', MGR));
  ok('a manager cannot add an override row that names nobody',
    refuses((s) => { s.userPermissionOverrides = [{ grants: ['invoices.view'], revokes: [] }]; }, 'manager', MGR));
  ok('a manager cannot invite a Super Admin', refuses((s) => { s.users.push({ id: 'u_new', role: 'owner', status: 'active', email: 'new@cs.co' }); }, 'manager', MGR));
  ok('a manager cannot invite with a role the app does not have',
    refuses((s) => { s.users.push({ id: 'u_new', role: 'Owner', status: 'active', email: 'new@cs.co' }); }, 'manager', MGR));
  ok('a manager cannot invite a second member with an email already on the team (any case/spacing)',
    refuses((s) => { s.users.unshift({ id: 'u_new', role: 'admin', status: 'active', email: ' Owner@CS.co ' }); }, 'manager', MGR));
  ok("a manager cannot change another member's login email", refuses((s) => { row(s, OWNER).email = 'mgr@cs.co'; }, 'manager', MGR));
  ok('  ...not even to an unused one', refuses((s) => { row(s, MEMBER).email = 'unused@cs.co'; }, 'manager', MGR));
  ok('the company timezone stays Super-Admin-only', refuses((s) => { s.company.timezone = 'America/New_York'; }, 'manager', MGR));
  ok('standing crew stays owner+admin (nothing in the app writes it since 2026-09-09)',
    refuses((s) => { s.sites[0].standingCrewIds = ['u_other', CREW]; }, 'manager', MGR));
  ok("a manager's own row is still theirs", allows((s) => { row(s, MGR).name = 'Renata'; }, 'manager', MGR));

  // A key-ORDER difference is not an edit: jsonb hands a nested object's keys back in its
  // own order, so the committed row and a tab's copy can differ in order alone.
  const reorder = (s) => { const { hr } = row(s, MEMBER); row(s, MEMBER).hr = { hireDate: hr.hireDate, employeeId: hr.employeeId }; };
  ok("reordered keys on another member's row are not an edit (crew)", allows(reorder, 'crew', CREW));
  ok('  ...nor for a manager without hr.edit', allows(reorder, 'manager', MGR, offForManagers('hr.edit')));
  // A field is read as the row's OWN property: an added "__proto__" key (JSON can carry
  // one) must read as a change, not as the prototype every object already has.
  ok('an added "__proto__" field on another member is still an edit (crew)',
    refuses((s) => { s.users[s.users.findIndex((u) => u.id === MEMBER)] = JSON.parse(`{"__proto__":{},${JSON.stringify(row(s, MEMBER)).slice(1)}`); }, 'crew', CREW));
  {
    // The slices compared whole ignore key order too.
    const withTimeOff = tweak(team(), (s) => { s.timeOff = [{ id: 'to1', userId: MEMBER, startDate: '2026-09-22', endDate: '2026-09-22', kind: 'callout', reason: '' }]; });
    const noTimeOffKeys = tweak(withTimeOff, (s) => {
      s.permissions = s.permissions.map((p) => (['settings.team.edit', 'hr.edit'].includes(p.id) ? { ...p, roles: p.roles.filter((r) => r !== 'manager') } : p));
    });
    const flip = (o) => Object.fromEntries(Object.entries(o).reverse());
    const reorderTimeOff = (s) => { s.timeOff = s.timeOff.map(flip); };
    ok('reordered keys in time off are not a change (a manager without the time-off keys)', allows(reorderTimeOff, 'manager', MGR, noTimeOffKeys));
    ok('  ...nor for crew', allows(reorderTimeOff, 'crew', CREW, withTimeOff));
    ok('reordered keys in the matrix are not a change (crew)', allows((s) => { s.permissions = s.permissions.map(flip); }, 'crew', CREW));
  }

  // ── the roster's shape (adversarial review, 2026-09-23) ──────────────────────
  // A login with no role claim (every manager's, until claims.js knew the role) is matched
  // to the FIRST row carrying its email, while byId() sees only the LAST row per id and none
  // without one. Before this, a manager could prepend a copy of their own row as a Super
  // Admin and resolve as one on the next request.
  const inviteWith = (extra) => (s) => { s.users.push({ id: 'u_new', role: 'crew', status: 'active', name: 'New', email: 'new@cs.co', ...extra }); };
  ok('a manager cannot prepend a copy of their own row as Super Admin (same id)',
    refuses((s) => { s.users.unshift({ ...row(s, MGR), role: 'owner' }); }, 'manager', MGR));
  ok('a manager cannot add a second row for an existing id, even with a fresh email',
    refuses((s) => { s.users.unshift({ ...row(s, OWNER), email: 'fresh@cs.co' }); }, 'manager', MGR));
  ok('a manager cannot move their own email and re-add it on a new, higher row in one save',
    refuses((s) => { row(s, MGR).email = 'moved@cs.co'; s.users.unshift({ id: 'u_new', role: 'admin', status: 'active', email: 'mgr@cs.co' }); }, 'manager', MGR));
  ok('a manager cannot add a row with no id', refuses((s) => { s.users.unshift({ email: 'mgr@cs.co', role: 'owner', status: 'active' }); }, 'manager', MGR));
  ok('  ...nor a row that is not an object', refuses((s) => { s.users.push(null); }, 'manager', MGR));
  ok('a manager cannot give their own row an email already on the team', refuses((s) => { row(s, MGR).email = 'OWNER@cs.co'; }, 'manager', MGR));
  ok('crew cannot prepend a copy of their row either', refuses((s) => { s.users.unshift({ ...row(s, CREW), role: 'owner' }); }, 'crew', CREW));
  {
    // A defect already in the committed roster is not the caller's.
    const legacy = tweak(team(), (s) => {
      s.users.push({ id: 'u_dup', role: 'crew', status: 'active', email: 'member@cs.co' });
      s.users.push({ note: 'a legacy row with no id' });
    });
    ok("a duplicate already committed doesn't block a manager's other edits", allows(rephone, 'manager', MGR, legacy));
    ok('  ...but adding one more row with that email does', refuses((s) => { row(s, MGR).email = 'member@cs.co'; }, 'manager', MGR, legacy));
  }
  // The roster's shape is checked for admins too now (owner's call 2026-09-23): planting a
  // duplicate owner row for a claim-less manager to resolve as was a live path, and an
  // admin planting one for their OWN id shielded them from being disabled (adversarial
  // review 2026-09-23, findings 2 + R6).
  ok('🔴 an admin cannot prepend a duplicate owner row either (was DOCUMENTED-allowed pre-2026-09-23)',
    refuses((s) => { s.users.unshift({ ...row(s, ADMIN), role: 'owner' }); }, 'admin', ADMIN));
  {
    // R6: a duplicate id ALREADY committed. byId sees the LAST copy (unchanged), a claim-less
    // login the FIRST by email — so editing the first copy slipped through before.
    const dupId = tweak(team(), (s) => { s.users.unshift({ ...row(s, MGR) }); }); // two rows for u_mgr
    ok('🔴 a manager cannot set a pre-existing duplicate of their own row to owner (R6)',
      refuses((s) => { s.users[0].role = 'owner'; }, 'manager', MGR, dupId));
    ok('🔴  ...nor can an admin (by role) flip it for them', refuses((s) => { s.users[0].role = 'owner'; }, 'admin', ADMIN, dupId));
    ok('  ...touching the duplicated run at all is refused for a non-owner', refuses((s) => { s.users.shift(); }, 'manager', MGR, dupId));
    ok('  ...but an unrelated edit is still fine while a duplicate id sits in the roster',
      allows((s) => { row(s, CREW).phone = '555-0142'; }, 'manager', MGR, dupId));
    ok('  ...and the owner can still repair a duplicate id', allows((s) => { s.users.shift(); }, 'owner', OWNER, dupId));
  }
  // A new member through the matrix carries what the invite form sets (name, email,
  // phone, role, an employee id); pay and the rest of the HR record need their own keys.
  ok('a manager cannot invite a member who already carries a pay rate...', refuses(inviteWith({ pay: { type: 'hourly', hourlyRate: 250 } }), 'manager', MGR));
  ok('  ...a manager GRANTED payroll.rates.edit can', allows(inviteWith({ pay: { type: 'hourly', hourlyRate: 25 } }), 'manager', MGR, overridden(MGR, ['payroll.rates.edit'])));
  ok("the invite form's employee id needs no hr.edit...", allows(inviteWith({ hr: { employeeId: 'EMP-0009' } }), 'manager', MGR, offForManagers('hr.edit')));
  ok('  ...the rest of the HR record does', refuses(inviteWith({ hr: { employeeId: 'EMP-0009', hireDate: '2026-01-01' } }), 'manager', MGR, offForManagers('hr.edit')));

  // ── a role is given only by someone who holds all it carries (owner's rule, 2026-09-23) ──
  // lib/roles canGiveRole, read from the COMMITTED matrix + the giver's overrides. With the
  // default matrix a Manager carries financials and role assignment an Admin doesn't.
  ok('an admin (by role) cannot add a MANAGER row: it carries more than an admin holds', refuses(inviteWith({ role: 'manager' }), 'admin', ADMIN));
  ok('  ...an admin still adds admin and crew rows', allows(inviteWith({ role: 'admin' }), 'admin', ADMIN) && allows(inviteWith({ role: 'crew' }), 'admin', ADMIN));
  ok('a manager adds a manager row', allows(inviteWith({ role: 'manager' }), 'manager', MGR));
  ok("crew granted settings.team.edit adds crew but not an admin (the grant doesn't reach the role)",
    allows(inviteWith({ role: 'crew' }), 'crew', CREW, overridden(CREW, ['settings.team.edit']))
    && refuses(inviteWith({ role: 'admin' }), 'crew', CREW, overridden(CREW, ['settings.team.edit'])));
  ok('an admin granted staff.assignRoles makes crew an admin, but not a manager',
    allows(promote, 'admin', ADMIN, overridden(ADMIN, ['staff.assignRoles']))
    && refuses((s) => { row(s, MEMBER).role = 'manager'; }, 'admin', ADMIN, overridden(ADMIN, ['staff.assignRoles'])));
  ok('a manager with a key personally revoked cannot give Manager (add or re-role)...',
    refuses(inviteWith({ role: 'manager' }), 'manager', MGR, overridden(MGR, [], ['invoices.view']))
    && refuses((s) => { row(s, MEMBER).role = 'manager'; }, 'manager', MGR, overridden(MGR, [], ['invoices.view'])));
  ok('  ...but still gives Admin', allows(promote, 'manager', MGR, overridden(MGR, [], ['invoices.view'])));
  {
    const pared = tweak(team(), (s) => {
      s.permissions = s.permissions.map((p) => (p.roles.includes('manager') && !p.roles.includes('admin') ? { ...p, roles: p.roles.filter((r) => r !== 'manager') } : p));
    });
    ok('it reads the MATRIX: pare Manager down to what Admins hold and an admin may add one', allows(inviteWith({ role: 'manager' }), 'admin', ADMIN, pared));
  }
  ok('the owner gives any role', allows(inviteWith({ role: 'manager' }), 'owner', OWNER) && allows(inviteWith({ role: 'owner' }), 'owner', OWNER));

  // ── removal: pay that may still be owed (every caller, 2026-09-23) ─────────────────
  // The app's rule (lib/deleteCascade owedPayBlock: DELETE_USER + the Team page), on the
  // COMMITTED state. The route reads the facts; this is what the guard does with them.
  const TZ = 'America/Los_Angeles';
  const NOW = new Date();
  const thisPeriod = payPeriodRange('biweekly', 0, NOW, TZ).fromKey;
  const oldPeriod = payPeriodRange('biweekly', -3, NOW, TZ).fromKey;
  const facts = (payState = {}, hours = []) => ({ removal: { payState, recentHours: new Set(hours), now: NOW } });
  const vf = (fn, role, self, f, from = team()) => guard(from, tweak(from, fn), role, self, f);
  const owedWord = 'remove a team member who may still be owed pay';
  const withLine = (periodKey) => facts({ payrollLines: [{ id: 'pl1', userId: MEMBER, periodKey }], opsSettings: { payPeriodCadence: 'biweekly' } });
  ok('removing a member with a pay line THIS period is refused, for a manager...', vf(remove, 'manager', MGR, withLine(thisPeriod)).includes(owedWord));
  ok('  ...and for the owner (the app\'s rule binds every role)', vf(remove, 'owner', OWNER, withLine(thisPeriod)).includes(owedWord));
  ok('a line only in an old, settled period does not block', vf(remove, 'owner', OWNER, withLine(oldPeriod)).length === 0);
  ok('a pending reimbursement blocks', vf(remove, 'owner', OWNER, facts({ reimbursements: [{ id: 'r1', userId: MEMBER, status: 'pending' }] })).includes(owedWord));
  ok('clocked hours since the cutoff (the time ledger) block', vf(remove, 'owner', OWNER, facts({}, [MEMBER])).includes(owedWord));
  ok("  ...another member's hours don't", vf(remove, 'owner', OWNER, facts({}, [CREW])).length === 0);
  ok('an active salaried member is owed this period', vf(remove, 'owner', OWNER, facts(),
    tweak(team(), (s) => { row(s, MEMBER).pay = { type: 'salary', salaryPerPeriod: 2000 }; })).includes(owedWord));
  ok('with NO facts a removal is refused, even for the owner (a check that cannot run never passes)',
    guard(team(), tweak(team(), remove), 'owner', OWNER, {}).some((x) => /couldn't be checked/.test(x)));
  ok('  ...and a save that removes nobody needs no facts', guard(team(), tweak(team(), rephone), 'manager', MGR, {}).length === 0);
  {
    // Junk slices read as empty (nothing owed); facts with no pay state at all refuse.
    let threw = false;
    let asExpected = false;
    try {
      asExpected = vf(remove, 'owner', OWNER, facts({ payrollLines: 'x', reimbursements: [null, 5], opsSettings: 'weekly' })).length === 0
        && vf(remove, 'owner', OWNER, { removal: { payState: null, recentHours: new Set() } }).some((x) => /couldn't be checked/.test(x));
    } catch { threw = true; }
    ok('junk pay slices do not throw (a throw would 500 and send the client around the guard)', !threw && asExpected);
  }
  ok('removedMemberIds names exactly the committed members a save drops',
    JSON.stringify(removedMemberIds(team(), tweak(team(), remove))) === JSON.stringify([MEMBER])
    && removedMemberIds(team(), tweak(team(), rephone)).length === 0);

  // ── the roster keeps a Super Admin (every caller) ────────────────────────────────
  ok('the owner cannot remove the only Super Admin row (their own)',
    vf((s) => { s.users = s.users.filter((u) => u.id !== OWNER); }, 'owner', OWNER, facts()).includes('leave the team without a Super Admin'));
  ok('  ...nor demote it', vf((s) => { row(s, OWNER).role = 'admin'; }, 'owner', OWNER, facts()).includes('leave the team without a Super Admin'));
  ok('  ...but may once another Super Admin is on the roster',
    vf((s) => { s.users = s.users.filter((u) => u.id !== OWNER); }, 'owner', OWNER, facts(),
      tweak(team(), (s) => { row(s, ADMIN).role = 'owner'; })).length === 0);
  ok('a committed roster with no Super Admin is not held against a save',
    vf(rephone, 'manager', MGR, facts(), tweak(team(), (s) => { row(s, OWNER).role = 'admin'; })).length === 0);
}

// ── customer (account) removal follows clients.delete (2026-09-23) ───────────
// Deleting a customer cascades to its sites / contacts / invoices / jobs; the blob
// half commits here. DELETION is a restricted capability (clients.delete: owner /
// admin / manager by default), so the server refuses a customer removal from anyone
// who does not hold it — owner+admin by role, else clients.delete in the COMMITTED
// matrix + overrides. Editing or creating a customer stays ordinary data. The digest
// must move on a removal (even a crew-less account) or the guard silently skips.
{
  const MGR = 'u_mgr';
  // A manager on the roster + the REAL default matrix (not a restated literal), and a
  // SECOND crew-less customer so a removal is a pure client-row drop that assign(clients)
  // — which lists only crew-BEARING accounts — cannot see. That is the case the new
  // clientIds fingerprint input exists for.
  const withMgr = () => ({
    ...base(),
    permissions: seedPermissions(),
    users: [...base().users, { id: MGR, role: 'manager', status: 'active', name: 'Mgr' }],
    clients: [{ id: 'c1', standingCrewIds: [] }, { id: 'c2', standingCrewIds: [] }],
  });
  const removeC1 = (from) => { const s = JSON.parse(JSON.stringify(from)); s.clients = s.clients.filter((c) => c.id !== 'c1'); return s; };
  const addClient = (from) => { const s = JSON.parse(JSON.stringify(from)); s.clients.push({ id: 'c3', standingCrewIds: [] }); return s; };
  const editClient = (from) => { const s = JSON.parse(JSON.stringify(from)); s.clients[0].name = 'Renamed'; return s; };
  const v = (from, role, self) => protectedFieldViolations(from, removeC1(from), role, self);

  ok('crew CANNOT delete a customer (no clients.delete)', v(withMgr(), 'crew', CREW).includes('delete a customer'));
  ok('owner CAN delete a customer (by role)', v(withMgr(), 'owner', OWNER).length === 0);
  ok('admin CAN delete a customer (by role)', v(withMgr(), 'admin', ADMIN).length === 0);
  ok('a default manager CAN delete a customer (holds clients.delete)', v(withMgr(), 'manager', MGR).length === 0);
  // Reads the MATRIX, not the role name: clients.delete taken off managers → refused.
  const paredMgr = () => { const s = withMgr(); s.permissions = s.permissions.map((p) => (p.id === 'clients.delete' ? { ...p, roles: p.roles.filter((r) => r !== 'manager') } : p)); return s; };
  ok('a manager with clients.delete off managers CANNOT delete a customer', v(paredMgr(), 'manager', MGR).includes('delete a customer'));
  // A per-user REVOKE outranks the default.
  const revokedMgr = () => { const s = withMgr(); s.userPermissionOverrides = [{ userId: MGR, grants: [], revokes: ['clients.delete'] }]; return s; };
  ok('a manager with clients.delete revoked per-user CANNOT delete a customer', v(revokedMgr(), 'manager', MGR).includes('delete a customer'));
  // A GRANT is the other direction: the grant's intent.
  const grantedCrew = () => { const s = withMgr(); s.userPermissionOverrides = [{ userId: CREW, grants: ['clients.delete'], revokes: [] }]; return s; };
  ok("crew GRANTED clients.delete may delete a customer (the grant's intent)", v(grantedCrew(), 'crew', CREW).length === 0);
  // The COMMITTED matrix decides: granting crew the key in the SAME save does not count.
  ok('the committed matrix decides: granting clients.delete to crew in the same save does not admit the delete',
    protectedFieldViolations(withMgr(), (() => { const s = removeC1(withMgr()); s.permissions = s.permissions.map((p) => (p.id === 'clients.delete' ? { ...p, roles: [...p.roles, 'crew'] } : p)); return s; })(), 'crew', CREW).includes('delete a customer'));
  // Create + edit stay ordinary data (never gated as a delete) — proves it is not over-gated.
  ok('crew CAN create a customer (create is not gated here)', protectedFieldViolations(withMgr(), addClient(withMgr()), 'crew', CREW).length === 0);
  ok('crew CAN edit a customer field (ordinary data)', protectedFieldViolations(withMgr(), editClient(withMgr()), 'crew', CREW).length === 0);

  // Fingerprint: a removal MUST move the digest, or the guard is silently skipped.
  ok('fingerprint CHANGES on a customer removal (even a crew-less account)', protectedFingerprint(withMgr()) !== protectedFingerprint(removeC1(withMgr())));
  ok('fingerprint CHANGES on a customer add (accepted cost of a snapshot digest)', protectedFingerprint(withMgr()) !== protectedFingerprint(addClient(withMgr())));
  ok('fingerprint IGNORES a customer field rename (stays off the hot path)', protectedFingerprint(withMgr()) === protectedFingerprint(editClient(withMgr())));
}

// ── money slices: payroll lines · reimbursements · pay-run config (S87) ─────
// Three MONEY slices were checked by protectedFieldViolations for NOTHING before,
// because protectedFingerprint never covered them — so a crew login's crafted save
// adding a $5,000 bonus line, approving its own reimbursement, or setting the OT
// multiplier to 5 committed with 200 and no guard run (playbook II.8). The check now
// mirrors the UI gate (payroll.edit / hr.edit / time.config, from the COMMITTED matrix)
// and the owner's calls (2026-09-23): pay lines are handled through the permission (no
// self-line carve-out); approving your OWN reimbursement is owner/admin only.
{
  const MGR = 'u_mgr';
  const money = () => ({
    ...base(),
    permissions: seedPermissions(),
    userPermissionOverrides: [],
    users: [
      { id: OWNER, role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co' },
      { id: ADMIN, role: 'admin', status: 'active', name: 'Admin', email: 'admin@cs.co' },
      { id: MGR, role: 'manager', status: 'active', name: 'Mgr', email: 'mgr@cs.co' },
      { id: CREW, role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co' },
    ],
    payrollLines: [
      { id: 'pl1', userId: CREW, periodKey: '2026-09-01', kind: 'earning', category: 'bonus', label: 'Perf', amount: 100, taxable: true, createdBy: OWNER },
      { id: 'pl_mgr', userId: MGR, periodKey: '2026-09-01', kind: 'earning', category: 'special', label: 'Deep clean', amount: 80, taxable: true, createdBy: OWNER },
    ],
    reimbursements: [
      { id: 'rmb1', userId: CREW, amount: 40, status: 'pending', periodKey: '2026-09-01', description: 'gas' },
      { id: 'rmb_mgr', userId: MGR, amount: 60, status: 'pending', periodKey: '2026-09-01', description: 'parking' },
      { id: 'rmb_adm', userId: ADMIN, amount: 30, status: 'pending', periodKey: '2026-09-01', description: 'supplies' },
    ],
    opsSettings: { otMultiplier: 1.5, payPeriodCadence: 'biweekly', payWeekStartDay: 0, payDriveTime: true, defaultGeofenceRadiusM: 120 },
  });
  const tweak = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; };
  const v = (fn, role, self, from = money()) => protectedFieldViolations(from, tweak(from, fn), role, self);
  const blocked = (label, needle, fn, role, self, from) => ok(label, v(fn, role, self, from).includes(needle));
  const allowed = (label, fn, role, self, from) => ok(label, v(fn, role, self, from).length === 0);
  const line = (o) => ({ periodKey: '2026-09-01', kind: 'earning', taxable: true, ...o });
  const crewGranted = (key) => { const s = money(); s.userPermissionOverrides = [{ userId: CREW, grants: [key], revokes: [] }]; return s; };

  // payroll lines ------------------------------------------------------------
  blocked('crew CANNOT add a payroll line (a $5,000 self-bonus)', 'add or change a payroll line',
    (s) => s.payrollLines.push(line({ id: 'plX', userId: CREW, category: 'bonus', amount: 5000 })), 'crew', CREW);
  blocked('crew CANNOT add a payroll line for someone else', 'add or change a payroll line',
    (s) => s.payrollLines.push(line({ id: 'plY', userId: MGR, category: 'bonus', amount: 500 })), 'crew', CREW);
  blocked('crew CANNOT edit a payroll line amount', 'add or change a payroll line',
    (s) => { s.payrollLines[0].amount = 9999; }, 'crew', CREW);
  blocked('crew CANNOT remove a payroll line', 'add or change a payroll line',
    (s) => { s.payrollLines = s.payrollLines.slice(1); }, 'crew', CREW);
  allowed('a manager (payroll.edit) CAN add a payroll line for a crew member',
    (s) => s.payrollLines.push(line({ id: 'plZ', userId: CREW, category: 'bonus', amount: 200 })), 'manager', MGR);
  allowed('a manager MAY add their OWN payroll line (owner: no self-line carve-out)',
    (s) => s.payrollLines.push(line({ id: 'plS', userId: MGR, category: 'bonus', amount: 200 })), 'manager', MGR);
  allowed('owner CAN add a payroll line', (s) => s.payrollLines.push(line({ id: 'plO', userId: CREW, category: 'bonus', amount: 1 })), 'owner', OWNER);
  allowed('admin CAN add a payroll line (by role)', (s) => s.payrollLines.push(line({ id: 'plA', userId: CREW, category: 'bonus', amount: 1 })), 'admin', ADMIN);
  allowed("crew GRANTED payroll.edit MAY add a line (the grant's intent)",
    (s) => s.payrollLines.push(line({ id: 'plG', userId: CREW, category: 'bonus', amount: 10 })), 'crew', CREW, crewGranted('payroll.edit'));
  allowed('an hr.edit holder MAY add a special-service line (HR category)',
    (s) => s.payrollLines.push(line({ id: 'plSp', userId: MGR, category: 'special', amount: 75 })), 'crew', CREW, crewGranted('hr.edit'));
  allowed('an hr.edit holder MAY add a reimbursement line (HR category)',
    (s) => s.payrollLines.push(line({ id: 'plRb', userId: MGR, category: 'reimbursement', amount: 40, taxable: false })), 'crew', CREW, crewGranted('hr.edit'));
  blocked('an hr.edit holder (no payroll.edit) CANNOT add a BONUS line', 'add or change a payroll line',
    (s) => s.payrollLines.push(line({ id: 'plB', userId: MGR, category: 'bonus', amount: 500 })), 'crew', CREW, crewGranted('hr.edit'));
  ok('the committed matrix decides: granting payroll.edit to crew in the same save does not admit the line',
    protectedFieldViolations(money(), tweak(money(), (s) => {
      s.permissions = s.permissions.map((p) => (p.id === 'payroll.edit' ? { ...p, roles: [...p.roles, 'crew'] } : p));
      s.payrollLines.push(line({ id: 'plM', userId: CREW, category: 'bonus', amount: 500 }));
    }), 'crew', CREW).includes('add or change a payroll line'));
  ok('a userName stamp on a kept payroll line is NOT a money change (DELETE_USER sweep)',
    v((s) => { s.payrollLines[0].userName = 'Crew (removed)'; }, 'crew', CREW).length === 0);
  ok('a payroll line label / note change is NOT a money change (display only)',
    v((s) => { s.payrollLines[0].label = 'Renamed'; s.payrollLines[0].note = 'x'; }, 'crew', CREW).length === 0);

  // reimbursements -----------------------------------------------------------
  blocked('crew CANNOT add a reimbursement', 'change a reimbursement',
    (s) => s.reimbursements.push({ id: 'rX', userId: CREW, amount: 20, status: 'pending', periodKey: '2026-09-01' }), 'crew', CREW);
  blocked('crew CANNOT edit a reimbursement amount', 'change a reimbursement',
    (s) => { s.reimbursements[0].amount = 999; }, 'crew', CREW);
  allowed('a manager (hr.edit) CAN approve a crew reimbursement (+ its minted pay line)',
    (s) => { s.reimbursements[0].status = 'approved'; s.reimbursements[0].payrollLineId = 'plNew'; s.payrollLines.push(line({ id: 'plNew', userId: CREW, category: 'reimbursement', amount: 40, taxable: false })); }, 'manager', MGR);
  allowed("an hr.edit holder (no payroll.edit) CAN approve ANOTHER member's reimbursement incl. its pay line",
    (s) => { const r = s.reimbursements.find((x) => x.userId === MGR); r.status = 'approved'; r.payrollLineId = 'plH'; s.payrollLines.push(line({ id: 'plH', userId: MGR, category: 'reimbursement', amount: 60, taxable: false })); }, 'crew', CREW, crewGranted('hr.edit'));
  allowed('a manager (hr.edit) CAN reject a reimbursement', (s) => { s.reimbursements[0].status = 'rejected'; }, 'manager', MGR);
  blocked('a manager CANNOT approve their OWN reimbursement (owner/admin only)', 'approve your own reimbursement',
    (s) => { const r = s.reimbursements.find((x) => x.userId === MGR); r.status = 'approved'; r.payrollLineId = 'plM2'; s.payrollLines.push(line({ id: 'plM2', userId: MGR, category: 'reimbursement', amount: 60, taxable: false })); }, 'manager', MGR);
  blocked('an hr.edit holder CANNOT approve their OWN reimbursement', 'approve your own reimbursement',
    (s) => { const r = s.reimbursements.find((x) => x.userId === CREW); r.status = 'approved'; r.payrollLineId = 'plC2'; s.payrollLines.push(line({ id: 'plC2', userId: CREW, category: 'reimbursement', amount: 40, taxable: false })); }, 'crew', CREW, crewGranted('hr.edit'));
  allowed('an admin CAN approve their OWN reimbursement (by role, never tightened)',
    (s) => { const r = s.reimbursements.find((x) => x.userId === ADMIN); r.status = 'approved'; r.payrollLineId = 'plAd'; s.payrollLines.push(line({ id: 'plAd', userId: ADMIN, category: 'reimbursement', amount: 30, taxable: false })); }, 'admin', ADMIN);
  allowed("crew GRANTED hr.edit MAY submit a reimbursement (the grant's intent)",
    (s) => s.reimbursements.push({ id: 'rG', userId: MGR, amount: 15, status: 'pending', periodKey: '2026-09-01' }), 'crew', CREW, crewGranted('hr.edit'));
  ok('the committed matrix decides: granting hr.edit to crew in the same save does not admit the reimbursement',
    protectedFieldViolations(money(), tweak(money(), (s) => {
      s.permissions = s.permissions.map((p) => (p.id === 'hr.edit' ? { ...p, roles: [...p.roles, 'crew'] } : p));
      s.reimbursements[0].amount = 500;
    }), 'crew', CREW).includes('change a reimbursement'));

  // operations settings — pay-run config AND the geofence / variance / alert knobs (whole slice, time.config)
  blocked('crew CANNOT change the OT multiplier', 'change operations settings', (s) => { s.opsSettings.otMultiplier = 5; }, 'crew', CREW);
  blocked('crew CANNOT change the pay-period cadence', 'change operations settings', (s) => { s.opsSettings.payPeriodCadence = 'weekly'; }, 'crew', CREW);
  blocked('crew CANNOT toggle paid drive time', 'change operations settings', (s) => { s.opsSettings.payDriveTime = false; }, 'crew', CREW);
  blocked('crew CANNOT change the pay week start day', 'change operations settings', (s) => { s.opsSettings.payWeekStartDay = 3; }, 'crew', CREW);
  blocked('crew CANNOT widen the geofence radius (attendance-gaming)', 'change operations settings', (s) => { s.opsSettings.defaultGeofenceRadiusM = 5000; }, 'crew', CREW);
  blocked('crew CANNOT loosen a variance threshold', 'change operations settings', (s) => { s.opsSettings.varianceFlagOverMins = 999; }, 'crew', CREW);
  allowed('a manager (time.config) CAN change the OT multiplier', (s) => { s.opsSettings.otMultiplier = 2; }, 'manager', MGR);
  allowed('a manager (time.config) CAN change the geofence radius', (s) => { s.opsSettings.defaultGeofenceRadiusM = 200; }, 'manager', MGR);
  allowed('an admin CAN change an ops setting (by role)', (s) => { s.opsSettings.otMultiplier = 2; }, 'admin', ADMIN);
  allowed("crew GRANTED time.config MAY change an ops setting (the grant's intent)", (s) => { s.opsSettings.otMultiplier = 2; }, 'crew', CREW, crewGranted('time.config'));
  allowed('a crew save that does NOT touch opsSettings is not flagged', (s) => { s.notes = [{ id: 'n1' }]; }, 'crew', CREW);

  // a member removal keeps + userName-stamps their pay records — never refused for that
  const remover = () => { const s = money(); s.userPermissionOverrides = [{ userId: CREW, grants: ['settings.team.edit'], revokes: ['payroll.edit', 'hr.edit'] }]; return s; };
  const removeMgr = (s) => {
    s.users = s.users.filter((u) => u.id !== MGR);
    for (const l of s.payrollLines) if (l.userId === MGR) l.userName = 'Mgr (removed)';
    for (const r of s.reimbursements) if (r.userId === MGR) r.userName = 'Mgr (removed)';
  };
  ok('removing a member (settings.team.edit, no payroll/hr) is NOT refused for the userName stamp on their kept pay records',
    !protectedFieldViolations(remover(), tweak(remover(), removeMgr), 'crew', CREW).some((x) => x.includes('payroll line') || x.includes('reimbursement')));

  // fingerprint contract: money moves the digest; display / non-pay does not --
  const fp = protectedFingerprint;
  ok('fingerprint CHANGES when a payroll line amount changes', fp(money()) !== fp(tweak(money(), (s) => { s.payrollLines[0].amount = 9999; })));
  ok('fingerprint CHANGES when a payroll line is added', fp(money()) !== fp(tweak(money(), (s) => { s.payrollLines.push(line({ id: 'plF', userId: CREW, category: 'bonus', amount: 5000 })); })));
  ok('fingerprint CHANGES when a reimbursement is approved', fp(money()) !== fp(tweak(money(), (s) => { s.reimbursements[0].status = 'approved'; })));
  ok('fingerprint CHANGES when the OT multiplier changes', fp(money()) !== fp(tweak(money(), (s) => { s.opsSettings.otMultiplier = 5; })));
  ok('fingerprint IGNORES a userName stamp on a payroll line (stays off the hot path)', fp(money()) === fp(tweak(money(), (s) => { s.payrollLines[0].userName = 'X'; })));
  ok('fingerprint IGNORES a payroll line label / note change (display only)', fp(money()) === fp(tweak(money(), (s) => { s.payrollLines[0].label = 'Y'; s.payrollLines[0].note = 'z'; })));
  ok('fingerprint IGNORES a reimbursement description change (display only)', fp(money()) === fp(tweak(money(), (s) => { s.reimbursements[0].description = 'changed'; })));
  ok('fingerprint CHANGES on ANY ops setting incl. geofence radius (whole opsSettings, 2026-09-23)', fp(money()) !== fp(tweak(money(), (s) => { s.opsSettings.defaultGeofenceRadiusM = 999; })));

  // ── your OWN / another member's pay + HR record (2026-09-23, HANDOFF S79 FOUND 2) ──
  // pay + the HR record are money/PII: your OWN change only for a Super Admin (owner/admin
  // by role); another member's needs payroll.rates.edit / hr.edit. Before, none fired —
  // the fields were outside the fingerprint. name / phone stay free (cosmetic, and left
  // out of the fingerprint so an Account save doesn't pay the read).
  const payRow = (s, uid, patch) => { const u = s.users.find((x) => x.id === uid); u.pay = { ...(u.pay || {}), ...patch }; };
  blocked('crew CANNOT change their OWN pay', 'change your own pay', (s) => payRow(s, CREW, { hourlyRate: 999 }), 'crew', CREW);
  blocked('a manager CANNOT change their OWN pay (even a payroll.rates.edit grant)', 'change your own pay',
    (s) => payRow(s, MGR, { salaryPerPeriod: 9999 }), 'manager', MGR, (() => { const s = money(); s.userPermissionOverrides = [{ userId: MGR, grants: ['payroll.rates.edit'], revokes: [] }]; return s; })());
  blocked('crew CANNOT change their OWN HR record', 'edit your own HR record', (s) => { s.users.find((x) => x.id === CREW).hr = { employeeId: 'EMP-0003', ptoAllowanceDays: 99 }; }, 'crew', CREW);
  allowed('the owner CAN change their own pay', (s) => payRow(s, OWNER, { salaryPerPeriod: 100 }), 'owner', OWNER);
  allowed('an admin CAN change their own pay (owner/admin by role, never tightened)', (s) => { s.users.find((x) => x.id === ADMIN).pay = { type: 'hourly', hourlyRate: 40 }; }, 'admin', ADMIN);
  allowed('crew CAN edit their own name (cosmetic, free)', (s) => { s.users.find((x) => x.id === CREW).name = 'Renamed'; }, 'crew', CREW);
  blocked("a manager without payroll.rates.edit CANNOT change ANOTHER member's pay", 'change another member\'s pay',
    (s) => payRow(s, CREW, { hourlyRate: 5 }), 'manager', MGR, (() => { const s = money(); s.userPermissionOverrides = [{ userId: MGR, grants: [], revokes: ['payroll.rates.edit'] }]; return s; })());
  allowed('the owner CAN change another member\'s pay', (s) => payRow(s, CREW, { hourlyRate: 25 }), 'owner', OWNER);
  ok('fingerprint CHANGES on an OWN pay edit (so the guard fires)', fp(money()) !== fp(tweak(money(), (s) => payRow(s, CREW, { hourlyRate: 999 }))));
  ok('fingerprint CHANGES on an HR-record edit', fp(money()) !== fp(tweak(money(), (s) => { s.users.find((x) => x.id === CREW).hr = { employeeId: 'X' }; })));
  ok('fingerprint IGNORES an own name / phone edit (cosmetic, stays off the read)', fp(money()) === fp(tweak(money(), (s) => { const u = s.users.find((x) => x.id === CREW); u.name = 'Renamed'; u.phone = '555-0000'; })));
}

// ── CS-331: a grant is valid only when the caller holds that permission (owner (b) 2026-09-24) ──
// The matrix and overrides accepted ANY well-formed change from a settings.roles.edit /
// staff.editOverrides holder, never that the caller holds each key granted — so a manager
// pared back but still holding those keys could re-grant everything in two saves. Now every
// DELTA that newly grants a key needs the caller's own effective (COMMITTED) permission —
// canGiveRole's rule, from roles to individual keys. Removing access is unchanged. Keys are
// read from lib/roles PERMISSIONS, never restated literals.
{
  const OWN = 'u_own'; const MGR = 'u_mgr331'; const MEM = 'u_mem331'; const MEM2 = 'u_mem2_331';
  const UNHELD = 'payroll.edit';   // a real key the MGR loses via their own override revoke
  const HELD = 'clients.edit';     // a real key a manager holds by default
  ok('fixture: the CS-331 keys are real permissions a manager carries by default',
    UNHELD in PERMISSIONS && HELD in PERMISSIONS
    && PERMISSIONS[UNHELD].defaultRoles.includes('manager') && PERMISSIONS[HELD].defaultRoles.includes('manager'));
  // MGR keeps settings.roles.edit + staff.editOverrides (edits the matrix + overrides) but has
  // UNHELD revoked on their OWN row, so they do not hold it. MEM2 is a manager with UNHELD
  // revoked, so REMOVING that revoke would RESTORE a key the caller lacks.
  const world = () => ({
    ...base(),
    permissions: seedPermissions(),
    userPermissionOverrides: [
      { userId: MGR, grants: [], revokes: [UNHELD] },
      { userId: MEM2, grants: [], revokes: [UNHELD] },
    ],
    users: [
      { id: OWN, role: 'owner', status: 'active', name: 'O', email: 'o331@cs.co' },
      { id: MGR, role: 'manager', status: 'active', name: 'M', email: 'm331@cs.co' },
      { id: MEM, role: 'crew', status: 'active', name: 'C', email: 'c331@cs.co' },
      { id: MEM2, role: 'manager', status: 'active', name: 'M2', email: 'm2_331@cs.co' },
    ],
  });
  const tweak = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; };
  const v = (fn, role, self, from = world()) => guard(from, tweak(from, fn), role, self, NOTHING_OWED);
  const allows = (fn, role, self, from) => v(fn, role, self, from).length === 0;
  const prow = (s, key) => s.permissions.find((p) => p.id === key);
  const ovOf = (s, uid) => s.userPermissionOverrides.find((o) => o.userId === uid);
  const need = `give a permission you don't have (${UNHELD})`;

  // MATRIX ── a (key, role) pair newly granted needs the caller to hold the key ──
  ok('🔴 a caller granting an UNHELD key to a role via the matrix is refused, naming the key',
    v((s) => { prow(s, UNHELD).roles = [...prow(s, UNHELD).roles, 'crew']; }, 'manager', MGR).includes(need));
  ok('a caller MAY grant a key they hold (clients.edit → crew)',
    allows((s) => { prow(s, HELD).roles = [...prow(s, HELD).roles, 'crew']; }, 'manager', MGR));
  ok('🔴 the OWNER is unaffected (a Super Admin holds everything): may grant the unheld key',
    allows((s) => { prow(s, UNHELD).roles = [...prow(s, UNHELD).roles, 'crew']; }, 'owner', OWN));
  ok('a REVOKE is always allowed: removing a role from the unheld key row',
    allows((s) => { prow(s, UNHELD).roles = prow(s, UNHELD).roles.filter((r) => r !== 'manager'); }, 'manager', MGR));
  ok('an unchanged grant of the unheld key elsewhere in the same save is NOT refused',
    allows((s) => { prow(s, HELD).roles = [...prow(s, HELD).roles, 'crew']; }, 'manager', MGR)); // UNHELD→[owner,manager] stays, unjudged
  ok('the COMMITTED matrix decides: a caller cannot bootstrap by granting themselves the key in the same save',
    v((s) => { ovOf(s, MGR).revokes = []; prow(s, UNHELD).roles = [...prow(s, UNHELD).roles, 'crew']; }, 'manager', MGR).includes(need));

  // OVERRIDES ── any key that becomes effective for the target, and wasn't, needs the caller to hold it ──
  ok('🔴 a caller granting an unheld key via an override GRANT is refused',
    v((s) => { s.userPermissionOverrides.push({ userId: MEM, grants: [UNHELD], revokes: [] }); }, 'manager', MGR).includes(need));
  ok('🔴 a caller removing a REVOKE that would RESTORE an unheld key (role default carries it) is refused',
    v((s) => { ovOf(s, MEM2).revokes = []; }, 'manager', MGR).includes(need));
  {
    // MEM (crew) has a stale revoke of UNHELD, which crew never carries by default; removing
    // it restores nothing effective, so the caller need not hold UNHELD to clear it.
    const staleRevoke = tweak(world(), (s) => { s.userPermissionOverrides.push({ userId: MEM, grants: [], revokes: [UNHELD] }); });
    ok('removing a revoke for a key the role does NOT carry changes nothing (crew never had UNHELD) — not refused',
      allows((s) => { ovOf(s, MEM).revokes = []; }, 'manager', MGR, staleRevoke));
  }
  ok('a caller MAY grant a key they hold via an override', allows((s) => { s.userPermissionOverrides.push({ userId: MEM, grants: [HELD], revokes: [] }); }, 'manager', MGR));
  ok('adding a REVOKE (taking access away) via an override is always allowed', allows((s) => { s.userPermissionOverrides.push({ userId: MEM, grants: [], revokes: [HELD] }); }, 'manager', MGR));
  ok('🔴 the owner may grant an unheld key via an override too (holds everything)',
    allows((s) => { s.userPermissionOverrides.push({ userId: MEM, grants: [UNHELD], revokes: [] }); }, 'owner', OWN));
  ok('a caller removing their OWN unheld-key revoke (a self-grant) is refused (no self overrides anyway)',
    guard(world(), tweak(world(), (s) => { ovOf(s, MGR).revokes = []; }), 'manager', MGR, NOTHING_OWED).length > 0);
}

// ── CS-369: reducing an Admin's per-user overrides is admin+ BY ROLE (owner's call 2026-09-25) ──
// A manager (or crew) holding staff.editOverrides could REDUCE an Admin's access through the
// override editor — add a key to the Admin's revokes, or drop a key from their grants — and
// CS-331 never caught it (CS-331 judges GRANTS only). The owner's call: reducing an Admin's
// per-user permissions shares the canEndAccess floor (admin+ by role), the same as ending
// (CS-329) or re-roling (CS-355) an Admin. Granting an Admin a key stays CS-331 (a holder may
// still grant). Judged on the target's COMMITTED role and the committed-matrix effective delta,
// exactly the machinery CS-331 uses. Keys from lib/roles PERMISSIONS, never restated literals.
{
  const OWN = 'u_own369'; const MGR = 'u_mgr369'; const MGR2 = 'u_mgr2_369';
  const ADM = 'u_adm369'; const ADM2 = 'u_adm2_369'; const CRW = 'u_crw369';
  const ROLEKEY = 'clients.edit';    // admin carries it by role → adding a revoke to an Admin reduces
  const GRANTKEY = 'payroll.view';   // admin lacks it, a manager holds it → committed as an Admin grant; dropping it reduces
  const INCKEY = 'invoices.view';    // admin lacks it, a manager holds it → granting it is an INCREASE (CS-331 ok)
  const CREWKEY = 'clients.view';    // crew carries it → a revoke on a crew member reduces them (not an Admin, so allowed)
  ok('fixture: CS-369 keys are real (ROLEKEY on admin; GRANTKEY/INCKEY off admin but a manager holds them)',
    [ROLEKEY, GRANTKEY, INCKEY, CREWKEY].every((k) => k in PERMISSIONS)
    && PERMISSIONS[ROLEKEY].defaultRoles.includes('admin')
    && !PERMISSIONS[GRANTKEY].defaultRoles.includes('admin') && PERMISSIONS[GRANTKEY].defaultRoles.includes('manager')
    && !PERMISSIONS[INCKEY].defaultRoles.includes('admin') && PERMISSIONS[INCKEY].defaultRoles.includes('manager'));
  // ADM holds GRANTKEY only via a committed grant, so dropping that grant is a reduction.
  const world = () => ({
    ...base(),
    permissions: seedPermissions(),
    userPermissionOverrides: [{ userId: ADM, grants: [GRANTKEY], revokes: [] }],
    users: [
      { id: OWN, role: 'owner', status: 'active', name: 'O', email: 'o369@cs.co' },
      { id: MGR, role: 'manager', status: 'active', name: 'M', email: 'm369@cs.co' },
      { id: MGR2, role: 'manager', status: 'active', name: 'M2', email: 'm2_369@cs.co' },
      { id: ADM, role: 'admin', status: 'active', name: 'A', email: 'a369@cs.co' },
      { id: ADM2, role: 'admin', status: 'active', name: 'A2', email: 'a2_369@cs.co' },
      { id: CRW, role: 'crew', status: 'active', name: 'C', email: 'c369@cs.co' },
    ],
  });
  const tweak = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; };
  const v = (fn, role, self, from = world()) => guard(from, tweak(from, fn), role, self, NOTHING_OWED);
  const allows = (fn, role, self, from) => v(fn, role, self, from).length === 0;
  const ovOf = (s, uid) => s.userPermissionOverrides.find((o) => o.userId === uid);
  const setOv = (s, uid, grants, revokes) => {
    const o = ovOf(s, uid);
    if (o) { o.grants = grants; o.revokes = revokes; } else s.userPermissionOverrides.push({ userId: uid, grants, revokes });
  };
  const REDUCE = "reduce an Admin's permissions";
  // crew / admin actors need staff.editOverrides to reach the override editor at all (the floor is
  // by ROLE, held on top of the key): crew lacks it, admin lacks it — grant it in the committed state.
  const crewCanEdit = () => tweak(world(), (s) => { s.userPermissionOverrides.push({ userId: CRW, grants: ['staff.editOverrides'], revokes: [] }); });
  const admCanEdit = () => tweak(world(), (s) => { s.userPermissionOverrides.push({ userId: ADM2, grants: ['staff.editOverrides'], revokes: [] }); });

  // Reductions of an Admin — REFUSED for a manager / crew, NAMING the Admin floor.
  ok('🔴 a MANAGER adding a revoke to an Admin (turning off a role-default key) is refused',
    v((s) => { setOv(s, ADM, [GRANTKEY], [ROLEKEY]); }, 'manager', MGR).includes(REDUCE));
  ok('🔴 a MANAGER dropping a grant from an Admin (a key they only had via that grant) is refused',
    v((s) => { setOv(s, ADM, [], []); }, 'manager', MGR).includes(REDUCE));
  ok('🔴 crew holding staff.editOverrides is refused the same reduction (the floor is by ROLE)',
    v((s) => { setOv(s, ADM, [GRANTKEY], [ROLEKEY]); }, 'crew', CRW, crewCanEdit()).includes(REDUCE));

  // Grants to an Admin stay CS-331 — a holder may still grant.
  ok('a MANAGER may still GRANT an Admin a key the manager holds (CS-331 unchanged, no reduction)',
    allows((s) => { setOv(s, ADM2, [INCKEY], []); }, 'manager', MGR));
  ok("  ...but NOT grant an Admin a key the manager lacks (CS-331 still bites)",
    v((s) => { setOv(s, ADM2, ['payroll.rates.edit'], []); }, 'manager', MGR).some((x) => x.startsWith('give a permission you don\'t have')));

  // An admin may reduce ANOTHER Admin's overrides.
  ok('an ADMIN (holding staff.editOverrides) MAY reduce another Admin\'s overrides',
    allows((s) => { setOv(s, ADM, [GRANTKEY], [ROLEKEY]); }, 'admin', ADM2, admCanEdit()));

  // The owner may do anything.
  ok('the OWNER may reduce an Admin\'s overrides (unaffected)',
    allows((s) => { setOv(s, ADM, [], [ROLEKEY]); }, 'owner', OWN));

  // A manager may still reduce a crew member's or a manager's overrides.
  ok('a MANAGER may still reduce a CREW member\'s overrides (not an Admin target)',
    allows((s) => { setOv(s, CRW, [], [CREWKEY]); }, 'manager', MGR));
  ok('a MANAGER may still reduce a MANAGER\'s overrides (not an Admin target)',
    allows((s) => { setOv(s, MGR2, [], [CREWKEY]); }, 'manager', MGR));

  // Not double-judged: a bare grant to an Admin (no reduction) is never called a reduction.
  ok('granting an Admin a fresh key is not flagged as a reduction',
    !v((s) => { setOv(s, ADM2, [INCKEY], []); }, 'manager', MGR).includes(REDUCE));
}

// ── CS-370: removing a key from the Admin ROLE column is admin+ BY ROLE (owner's call 2026-09-25) ──
// The matrix twin of CS-369: a matrix save that makes a key NO LONGER effective for the `admin`
// ROLE reduces EVERY Admin's access at once, so it shares the canEndAccess floor. Granting the
// admin column stays CS-331; the other role columns and the owner column are unaffected.
{
  const OWN = 'u_own370'; const MGR = 'u_mgr370'; const ADM = 'u_adm370'; const CRW = 'u_crw370';
  const ADMKEY = 'clients.edit';   // admin carries it → turning it off in the matrix reduces the admin role
  const MGRKEY = 'invoices.view';  // manager carries it, admin does not → a manager-column key
  ok('fixture: CS-370 keys are real (ADMKEY on admin; MGRKEY on manager, not admin)',
    ADMKEY in PERMISSIONS && MGRKEY in PERMISSIONS
    && PERMISSIONS[ADMKEY].defaultRoles.includes('admin')
    && PERMISSIONS[MGRKEY].defaultRoles.includes('manager') && !PERMISSIONS[MGRKEY].defaultRoles.includes('admin'));
  const world = () => ({
    ...base(),
    permissions: seedPermissions(),
    userPermissionOverrides: [],
    users: [
      { id: OWN, role: 'owner', status: 'active', name: 'O', email: 'o370@cs.co' },
      { id: MGR, role: 'manager', status: 'active', name: 'M', email: 'm370@cs.co' },
      { id: ADM, role: 'admin', status: 'active', name: 'A', email: 'a370@cs.co' },
      { id: CRW, role: 'crew', status: 'active', name: 'C', email: 'c370@cs.co' },
    ],
  });
  const tweak = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; };
  const v = (fn, role, self, from = world()) => guard(from, tweak(from, fn), role, self, NOTHING_OWED);
  const allows = (fn, role, self, from) => v(fn, role, self, from).length === 0;
  const prow = (s, key) => s.permissions.find((p) => p.id === key);
  const dropCol = (key, col) => (s) => { prow(s, key).roles = prow(s, key).roles.filter((r) => r !== col); };
  const REDUCE = "reduce the Admin role's permissions";
  const withRolesEdit = (uid) => tweak(world(), (s) => { s.userPermissionOverrides = [{ userId: uid, grants: ['settings.roles.edit'], revokes: [] }]; });

  ok('🔴 a MANAGER turning OFF an admin-column key is refused, naming the Admin-role floor',
    v(dropCol(ADMKEY, 'admin'), 'manager', MGR).includes(REDUCE));
  ok('🔴  ...nor can crew granted settings.roles.edit', v(dropCol(ADMKEY, 'admin'), 'crew', CRW, withRolesEdit(CRW)).includes(REDUCE));
  ok('an ADMIN holding settings.roles.edit MAY turn off an admin-column key', allows(dropCol(ADMKEY, 'admin'), 'admin', ADM, withRolesEdit(ADM)));
  ok('the OWNER may turn off an admin-column key', allows(dropCol(ADMKEY, 'admin'), 'owner', OWN));
  ok('a MANAGER may still turn off a MANAGER-column key (other columns unaffected)', allows(dropCol(MGRKEY, 'manager'), 'manager', MGR));
  ok('a MANAGER may still turn off a CREW-column key', allows(dropCol('clients.view', 'crew'), 'manager', MGR));
  ok('a MANAGER may still GRANT the admin column a key they hold (CS-331 unchanged)',
    allows((s) => { prow(s, MGRKEY).roles = [...prow(s, MGRKEY).roles, 'admin']; }, 'manager', MGR));
  ok('the two paths are distinct: turning off a manager-column key is NOT an Admin-role reduction',
    !v(dropCol(MGRKEY, 'manager'), 'manager', MGR).includes(REDUCE));
}

// ── CS-371: removing a key from the Super Admin (owner) ROLE column is Super-Admin-only (owner's call 2026-09-25) ──
// The owner-column twin of CS-370: a matrix save that makes a key NO LONGER effective for the `owner`
// ROLE reduces every part of the app the owner reaches, and authz reads the same can(), so only a Super
// Admin may (lib/roles canReduceRole). The OWNER_CORE keys resolve true for an owner whatever the matrix
// says (can() gives them regardless), so turning their owner cell off is never a reduction and never
// refused — that keeps the owner recoverable. Granting the owner column stays CS-331. Keys from lib/roles
// PERMISSIONS / OWNER_CORE, never restated literals.
{
  const OWN = 'u_own371'; const MGR = 'u_mgr371'; const ADM = 'u_adm371'; const CRW = 'u_crw371';
  const OWNKEY = 'clients.edit';          // owner carries it, not OWNER_CORE → turning it off reduces the owner role
  const COREKEY = 'settings.roles.edit';  // OWNER_CORE → the owner keeps it whatever the matrix says
  const MGRKEY = 'invoices.view';         // owner+manager, not admin → a manager-column key
  const UNHELD = 'payroll.rates.edit';    // owner-only default → a manager does not hold it
  ok('fixture: CS-371 keys are real (OWNKEY on owner, not OWNER_CORE; COREKEY is OWNER_CORE; UNHELD owner-only)',
    [OWNKEY, COREKEY, MGRKEY, UNHELD].every((k) => k in PERMISSIONS)
    && PERMISSIONS[OWNKEY].defaultRoles.includes('owner') && !OWNER_CORE.has(OWNKEY)
    && OWNER_CORE.has(COREKEY)
    && PERMISSIONS[UNHELD].defaultRoles.join() === 'owner');
  const world = () => ({
    ...base(),
    permissions: seedPermissions(),
    userPermissionOverrides: [],
    users: [
      { id: OWN, role: 'owner', status: 'active', name: 'O', email: 'o371@cs.co' },
      { id: MGR, role: 'manager', status: 'active', name: 'M', email: 'm371@cs.co' },
      { id: ADM, role: 'admin', status: 'active', name: 'A', email: 'a371@cs.co' },
      { id: CRW, role: 'crew', status: 'active', name: 'C', email: 'c371@cs.co' },
    ],
  });
  const tweak = (s, fn) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; };
  const v = (fn, role, self, from = world()) => guard(from, tweak(from, fn), role, self, NOTHING_OWED);
  const allows = (fn, role, self, from) => v(fn, role, self, from).length === 0;
  const prow = (s, key) => s.permissions.find((p) => p.id === key);
  const dropCol = (key, col) => (s) => { prow(s, key).roles = prow(s, key).roles.filter((r) => r !== col); };
  const REDUCE = "reduce the Super Admin role's permissions";
  const withRolesEdit = (uid) => tweak(world(), (s) => { s.userPermissionOverrides = [{ userId: uid, grants: ['settings.roles.edit'], revokes: [] }]; });

  // A reduction of the owner column — REFUSED for anyone but a Super Admin, NAMING the floor.
  ok('🔴 a MANAGER turning OFF an owner-column key is refused, naming the Super-Admin-role floor',
    v(dropCol(OWNKEY, 'owner'), 'manager', MGR).includes(REDUCE));
  ok('🔴 an ADMIN turning OFF an owner-column key is refused too (only a Super Admin may)',
    v(dropCol(OWNKEY, 'owner'), 'admin', ADM, withRolesEdit(ADM)).includes(REDUCE));
  ok('🔴  ...nor can crew granted settings.roles.edit', v(dropCol(OWNKEY, 'owner'), 'crew', CRW, withRolesEdit(CRW)).includes(REDUCE));

  // The manipulation vectors all reach the same reduction (can() reads the FIRST row of a duplicate).
  ok('🔴 the duplicate-row trick is caught (a prepended owner-less copy makes the key ineffective for the owner)',
    v((s) => { s.permissions.unshift({ id: OWNKEY, roles: prow(s, OWNKEY).roles.filter((r) => r !== 'owner') }); }, 'manager', MGR).includes(REDUCE));
  ok('🔴 whole-array replacement is caught (a fresh matrix with owner dropped from the key)',
    v((s) => { s.permissions = seedPermissions().map((p) => (p.id === OWNKEY ? { ...p, roles: p.roles.filter((r) => r !== 'owner') } : p)); }, 'manager', MGR).includes(REDUCE));
  // Deleting the row is NOT a reduction: can() falls back to the schema default, which carries owner.
  ok('deleting an owner-column row is NOT a reduction (the schema default keeps the owner) — not refused',
    allows((s) => { s.permissions = s.permissions.filter((p) => p.id !== OWNKEY); }, 'manager', MGR));

  // The owner may reduce their OWN column (a non-core key).
  ok('the OWNER may turn off an owner-column key (their own column)', allows(dropCol(OWNKEY, 'owner'), 'owner', OWN));

  // OWNER_CORE: the owner keeps the key whatever the matrix says, so its owner cell is never a reduction.
  ok('turning off an OWNER_CORE owner cell is NOT a reduction (the owner keeps it via can()) — allowed for a manager and the owner',
    allows(dropCol(COREKEY, 'owner'), 'manager', MGR, withRolesEdit(MGR)) && allows(dropCol(COREKEY, 'owner'), 'owner', OWN));
  ok('  ...and it is never named as a Super-Admin reduction', !v(dropCol(COREKEY, 'owner'), 'manager', MGR, withRolesEdit(MGR)).includes(REDUCE));

  // Other columns are unaffected; the owner-column floor is distinct from the admin-column (CS-370) one.
  ok('a MANAGER may still turn off a MANAGER-column key (owner untouched)', allows(dropCol(MGRKEY, 'manager'), 'manager', MGR));
  ok('a MANAGER may still turn off a CREW-column key', allows(dropCol('clients.view', 'crew'), 'manager', MGR));
  ok('an ADMIN may still turn off an ADMIN-column key (CS-370 unchanged)', allows(dropCol(OWNKEY, 'admin'), 'admin', ADM, withRolesEdit(ADM)));
  ok('the two floors are distinct: turning off the admin column is NOT a Super-Admin reduction',
    !v(dropCol(OWNKEY, 'admin'), 'admin', ADM, withRolesEdit(ADM)).includes(REDUCE));

  // Granting the owner column stays CS-331 (a holder may grant back; an unheld key is still refused).
  const ownerDropped = tweak(world(), (s) => { prow(s, OWNKEY).roles = prow(s, OWNKEY).roles.filter((r) => r !== 'owner'); });
  ok('a MANAGER may GRANT the owner column back a key the manager holds (CS-331; not a reduction)',
    allows((s) => { prow(s, OWNKEY).roles = [...prow(s, OWNKEY).roles, 'owner']; }, 'manager', MGR, ownerDropped));
  const unheldDropped = tweak(world(), (s) => { prow(s, UNHELD).roles = prow(s, UNHELD).roles.filter((r) => r !== 'owner'); });
  ok('  ...but NOT grant the owner column a key the manager LACKS (CS-331 still bites)',
    v((s) => { prow(s, UNHELD).roles = [...prow(s, UNHELD).roles, 'owner']; }, 'manager', MGR, unheldDropped)
      .some((x) => x.startsWith("give a permission you don't have")));

  // Fingerprint: a matrix reduction moves the digest (the guard is not silently skipped).
  ok('fingerprint CHANGES when the owner column is reduced', protectedFingerprint(world()) !== protectedFingerprint(tweak(world(), dropCol(OWNKEY, 'owner'))));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
