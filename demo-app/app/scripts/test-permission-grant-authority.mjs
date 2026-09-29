// CS-331 (owner's option (b), 2026-09-24): the CLIENT side of "a grant is valid only when the
// caller holds that permission". This suite pins the shared predicate lib/roles
// canGrantPermission and the two client surfaces that must use it — the Roles matrix editor
// and TeamDetail › Access — so no client control offers a grant orgStateGuard would refuse. The
// server half is proven in test-org-state-guard.mjs. Offline; keys come from lib/roles
// PERMISSIONS, never restated literals.
//
//   node app/scripts/test-permission-grant-authority.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as R from '../src/lib/roles.js';
import { protectedFieldViolations as orgGuard } from '../api/_lib/orgStateGuard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const { canGrantPermission, seedPermissions, PERMISSIONS, OWNER_ONLY, ALWAYS_GRANTED, ROLES, can } = R;

// ── the shared predicate ──────────────────────────────────────────────────────────────
ok('canGrantPermission is exported (lib/roles)', typeof canGrantPermission === 'function');
if (typeof canGrantPermission === 'function') {
  const matrix = seedPermissions();                 // the committed default the seed ships
  const UNHELD = 'payroll.rates.edit';              // owner-only by default → a manager doesn't hold it
  const HELD = 'clients.edit';                      // a manager holds it by default
  const editable = Object.keys(PERMISSIONS).filter((k) => !ALWAYS_GRANTED.has(k));
  ok('fixture: the keys are real (UNHELD is owner-only, HELD a manager holds)',
    UNHELD in PERMISSIONS && HELD in PERMISSIONS
    && PERMISSIONS[UNHELD].defaultRoles.join() === 'owner' && PERMISSIONS[HELD].defaultRoles.includes('manager'));
  const mgr = { id: 'u_m', role: 'manager' };
  const owner = { id: 'u_o', role: 'owner' };

  ok('🔴 a Super Admin may grant every editable key (owners unaffected)',
    editable.every((k) => canGrantPermission(owner, k, matrix, []) === true));
  ok('a manager MAY grant a key they hold', canGrantPermission(mgr, HELD, matrix, []) === true);
  ok('🔴 a manager may NOT grant a key they do not hold', canGrantPermission(mgr, UNHELD, matrix, []) === false);
  ok('an OWNER_ONLY key is never grantable by a non-owner',
    [...OWNER_ONLY].every((k) => canGrantPermission(mgr, k, matrix, []) === false));
  ok('no identity / no role grants nothing',
    canGrantPermission(null, HELD, matrix, []) === false && canGrantPermission({ id: 'x' }, HELD, matrix, []) === false);
  // "Holds" is the caller's effective permission on the GIVEN (committed) matrix + their overrides.
  ok('a per-user REVOKE on the caller removes the key (can no longer grant it)',
    canGrantPermission(mgr, HELD, matrix, [{ userId: 'u_m', grants: [], revokes: [HELD] }]) === false);
  ok("a per-user GRANT on the caller lets them grant it (the grant's intent)",
    canGrantPermission({ id: 'u_c', role: 'crew' }, HELD, matrix, [{ userId: 'u_c', grants: [HELD], revokes: [] }]) === true);
  // Parity with can(): a non-owner may grant exactly the keys they effectively hold.
  ok('🔴 canGrantPermission agrees with can() for a non-owner across every editable key',
    editable.every((k) => canGrantPermission(mgr, k, matrix, []) === can(mgr, k, matrix, [])));
  ok('  ...and with a mix of grants + revokes on the caller',
    editable.every((k) => {
      const ov = [{ userId: 'u_m', grants: [UNHELD], revokes: [HELD] }];
      return canGrantPermission(mgr, k, matrix, ov) === can(mgr, k, matrix, ov);
    }));
}

// ── Roles.jsx: the matrix editor gates grants (source pins) ─────────────────────────────
{
  const roles = read('src/pages/settings/Roles.jsx');
  ok('Roles imports canGrantPermission + the current user + overrides',
    /canGrantPermission/.test(roles) && /selectCurrentUser/.test(roles) && /selectUserPermissionOverrides/.test(roles));
  ok('Roles computes canGrant from the current user (committed matrix + overrides)',
    /const canGrant = \(key\) => canGrantPermission\(currentUser, key, permissions, overrides\);/.test(roles));
  ok('🔴 setPerm refuses a GRANT of a key the caller does not hold (a revoke stays free)',
    /if \(on && !canGrant\(perm\.id\)\) return;/.test(roles));
  ok('🔴 a grant-locked cell (OFF for a role + unheld key) is shown disabled, not offered (CS-370 adds reduceLocked)',
    /const grantLocked = \(perm, role\) => !perm\.roles\.includes\(role\) && !canGrant\(perm\.id\);/.test(roles)
    && /disabled=\{!!p\.schemaDefault \|\| grantLocked\(p, r\) \|\| reduceLocked\(p, r\)\}/.test(roles));
  ok('🔴 the section master drives only grantable rows (never grants an unheld key; CS-370 excludes reduce-locked)',
    /rows\.filter\(\(r\) => !r\.schemaDefault && !locked\(r, role\) && !grantLocked\(r, role\) && !reduceLocked\(r, role\)\)/.test(roles)
    && /drivable\(rows, role\)\.forEach\(\(r\) => setPerm/.test(roles));
  ok('🔴 Reset to defaults never re-grants an unheld key (revoke-only for those)',
    /let target = canGrant\(p\.id\) \? \[\.\.\.def\] : p\.roles\.filter\(\(r\) => def\.includes\(r\)\);/.test(roles));
  ok('the reason is shown to a non-owner', /You can switch on only the permissions you have yourself/.test(roles));
}

// ── TeamDetail › Access: the override editor gates grants (source pins) ─────────────────
{
  const td = read('src/pages/settings/TeamDetail.jsx');
  ok('TeamDetail imports canGrantPermission + computes canGrant',
    /canGrantPermission/.test(td)
    && /const canGrant = \(key\) => canGrantPermission\(currentUser, key, permissions, overrides\);/.test(td));
  ok('🔴 togglePermOverride refuses BOTH grant directions (a new grant AND un-revoking a role default)',
    (td.match(/if \(!canGrant\(permKey\)\) return;/g) || []).length === 2);
  ok('🔴 a grant-locked override row is read-only (overrideLocked includes grantLocked; CS-369 adds reduceLocked)',
    /const grantLocked = !ownerOnly && \(revoked \|\| \(!roleHas && !granted\)\) && !canGrant\(key\);/.test(td)
    && /const overrideLocked = !!overrideLimit \|\| \(ownerOnly && !granted && !revoked\) \|\| grantLocked \|\| reduceLocked;/.test(td));
  ok('the reason is shown to a non-owner on Access', /You can only grant permissions you have yourself/.test(td));
}

// ── CS-370: reducing the Admin ROLE's permissions is admin+ by role (owner's call 2026-09-25) ──
// The matrix twin of CS-369: turning an ADMIN-column key OFF reduces every Admin at once, so it is
// admin+ by ROLE (canEndAccess). Granting the admin column stays CS-331. Pinned on Roles.jsx and
// cross-checked against the server guard. Keys from lib/roles PERMISSIONS, never restated literals.
{
  const roles = read('src/pages/settings/Roles.jsx');
  ok('CS-370: Roles imports canEndAccess + computes canReduceAdminRole',
    /canEndAccess/.test(roles) && /const canReduceAdminRole = canEndAccess\(currentUser\?\.role, true\);/.test(roles));
  ok('🔴 CS-370: reduceLocked locks an ON admin-column cell for a non-admin+ viewer',
    /const reduceLocked = \(perm, role\) => perm\.roles\.includes\(role\) && \(/.test(roles)
    && /\(role === 'admin' && !canReduceAdminRole\)/.test(roles));
  ok('🔴 CS-370: setPerm refuses turning an admin-column key OFF (a reduction)',
    /if \(!on && reduceLocked\(perm, role\)\) return;/.test(roles));
  ok('🔴 CS-370: the cell switch is disabled when reduce-locked',
    /disabled=\{!!p\.schemaDefault \|\| grantLocked\(p, r\) \|\| reduceLocked\(p, r\)\}/.test(roles));
  ok('🔴 CS-370: the section master leaves reduce-locked cells alone (drivable excludes them)',
    /rows\.filter\(\(r\) => !r\.schemaDefault && !locked\(r, role\) && !grantLocked\(r, role\) && !reduceLocked\(r, role\)\)/.test(roles));
  ok('🔴 CS-370: Reset never drops admin from a key the admin column carries (non-admin+ viewer)',
    /if \(!canReduceAdminRole && p\.roles\.includes\('admin'\) && !target\.includes\('admin'\)\) target = \[\.\.\.target, 'admin'\];/.test(roles));
  ok('CS-370: the reason is shown to a non-admin+ viewer', /Only an Admin or Super Admin can reduce the Admin role/.test(roles));

  // Cross-check the page's admin-column reduce decision against the server guard.
  const { canEndAccess } = R;
  const matrix = seedPermissions();
  const ADMKEY = 'clients.edit'; // admin carries it → turning it off is an admin-role reduction
  ok('fixture: ADMKEY is a real key the admin role carries', ADMKEY in PERMISSIONS && PERMISSIONS[ADMKEY].defaultRoles.includes('admin'));
  const dropAdmin = (m) => m.map((p) => (p.id === ADMKEY ? { ...p, roles: p.roles.filter((r) => r !== 'admin') } : p));
  const usersFor = (actorRole) => [
    { id: 'u_o', role: 'owner', status: 'active', name: 'O', email: 'o@cs.co' },
    { id: 'u_act', role: actorRole, status: 'active', name: 'Act', email: 'act@cs.co' },
    { id: 'u_adm', role: 'admin', status: 'active', name: 'Adm', email: 'adm@cs.co' },
  ];
  // The Roles page enables the admin-column ON->OFF switch iff the viewer holds settings.roles.edit
  // (reach) AND canReduceAdminRole (canEndAccess on an Admin target).
  const pageAllowsAdminReduce = (actor, ov) => can(actor, 'settings.roles.edit', matrix, ov) && canEndAccess(actor.role, true);
  let disagree = 0; const firstD = [];
  for (const actorRole of ['owner', 'admin', 'manager', 'crew']) {
    const actor = { id: 'u_act', role: actorRole };
    // grant settings.roles.edit so the reach is satisfied (admins/crew lack it by default)
    const ov = can(actor, 'settings.roles.edit', matrix, []) ? [] : [{ userId: 'u_act', grants: ['settings.roles.edit'], revokes: [] }];
    const prev = { users: usersFor(actorRole), permissions: matrix, userPermissionOverrides: ov, company: {}, sites: [], clients: [] };
    const next = { ...prev, permissions: dropAdmin(matrix) };
    const guardAccepts = orgGuard(prev, next, actorRole, 'u_act', { removal: { payState: {}, recentHours: new Set() } }).length === 0;
    const pageAllows = pageAllowsAdminReduce(actor, ov);
    if (pageAllows !== guardAccepts) { disagree += 1; if (firstD.length < 8) firstD.push(`${actorRole}: page ${pageAllows}, guard ${guardAccepts}`); }
  }
  ok(`🔴 CS-370: the Roles admin-column reduce decision AGREES with the server guard for every actor role (${disagree}${firstD.length ? `: ${firstD.join(' · ')}` : ''})`, disagree === 0);
}

// ── CS-371: reducing the Super Admin (owner) ROLE's permissions is Super-Admin-only (owner's call 2026-09-25) ──
// The owner-column twin of CS-370: turning an OWNER-column key OFF reduces every part of the app the owner
// reaches (authz reads the same can()), so only a Super Admin may (lib/roles canReduceRole). The OWNER_CORE
// keys resolve true for an owner whatever the matrix says, so they are never a reduction and never locked —
// which keeps the page in exact agreement with the guard. Pinned on Roles.jsx and cross-checked against the
// server guard for a non-core key (a real reduction) and an OWNER_CORE key (never one). Keys from lib/roles.
{
  const roles = read('src/pages/settings/Roles.jsx');
  const { canReduceRole, canEndAccess, OWNER_CORE } = R;
  ok('CS-371: canReduceRole is exported (lib/roles)', typeof canReduceRole === 'function');
  ok('CS-371: Roles imports canReduceRole + OWNER_CORE and computes canReduceOwnerRole',
    /canReduceRole/.test(roles) && /OWNER_CORE/.test(roles)
    && /const canReduceOwnerRole = canReduceRole\(currentUser\?\.role, 'owner'\);/.test(roles));
  ok('🔴 CS-371: reduceLocked also locks an ON owner-column cell (excluding OWNER_CORE) for a non-owner viewer',
    /\(role === 'owner' && !OWNER_CORE\.has\(perm\.id\) && !canReduceOwnerRole\)/.test(roles));
  ok('🔴 CS-371: setPerm refuses turning an owner-column key OFF (a reduction) — the same reduceLocked guard',
    /if \(!on && reduceLocked\(perm, role\)\) return;/.test(roles));
  ok('🔴 CS-371: the cell switch is disabled when reduce-locked (owner column included)',
    /disabled=\{!!p\.schemaDefault \|\| grantLocked\(p, r\) \|\| reduceLocked\(p, r\)\}/.test(roles));
  ok('🔴 CS-371: the section master leaves reduce-locked owner cells alone (drivable excludes them)',
    /rows\.filter\(\(r\) => !r\.schemaDefault && !locked\(r, role\) && !grantLocked\(r, role\) && !reduceLocked\(r, role\)\)/.test(roles));
  ok('🔴 CS-371: Reset never drops owner from a non-core key the owner column carries (non-owner viewer)',
    /if \(!canReduceOwnerRole && p\.roles\.includes\('owner'\) && !OWNER_CORE\.has\(p\.id\) && !target\.includes\('owner'\)\) target = \[\.\.\.target, 'owner'\];/.test(roles));
  ok('CS-371: the reason is shown to a non-owner viewer', /Only a Super Admin can reduce the Super Admin role/.test(roles));

  // The shared predicate: only the owner may reduce the owner column; admin+ may reduce admin (= canEndAccess).
  if (typeof canReduceRole === 'function') {
    ok('🔴 canReduceRole: only a Super Admin may reduce the owner column',
      canReduceRole('owner', 'owner') === true
      && canReduceRole('admin', 'owner') === false && canReduceRole('manager', 'owner') === false && canReduceRole('crew', 'owner') === false);
    ok('canReduceRole: admin+ may reduce the admin column, agreeing with canEndAccess for an Admin target',
      canReduceRole('owner', 'admin') === true && canReduceRole('admin', 'admin') === true
      && canReduceRole('manager', 'admin') === false && canReduceRole('crew', 'admin') === false
      && ROLES.every((r) => canReduceRole(r, 'admin') === canEndAccess(r, true)));
    ok('canReduceRole: the manager and crew columns carry no floor',
      ROLES.every((r) => canReduceRole(r, 'manager') === true && canReduceRole(r, 'crew') === true));
  }

  // Cross-check the page's owner-column reduce decision against the server guard, for a NON-core key
  // (a real reduction) and an OWNER_CORE key (never a reduction). 0 disagreements for every actor role.
  if (typeof canReduceRole === 'function') {
    const matrix = seedPermissions();
    const OWNKEY = 'clients.edit';          // owner carries it, not OWNER_CORE → dropping owner is a real reduction
    const COREKEY = 'settings.roles.edit';  // OWNER_CORE → dropping owner is a no-op the guard never refuses
    ok('fixture: OWNKEY is a non-core key the owner carries; COREKEY is OWNER_CORE',
      OWNKEY in PERMISSIONS && PERMISSIONS[OWNKEY].defaultRoles.includes('owner') && !OWNER_CORE.has(OWNKEY)
      && OWNER_CORE.has(COREKEY));
    const dropOwner = (m, key) => m.map((p) => (p.id === key ? { ...p, roles: p.roles.filter((r) => r !== 'owner') } : p));
    const usersFor = (actorRole) => [
      { id: 'u_o', role: 'owner', status: 'active', name: 'O', email: 'o@cs.co' },
      { id: 'u_act', role: actorRole, status: 'active', name: 'Act', email: 'act@cs.co' },
    ];
    // The page enables the owner-column ON->OFF switch iff the viewer holds settings.roles.edit (reach),
    // and either the key is OWNER_CORE (a no-op cell, never locked) or canReduceOwnerRole (Super Admin only).
    const pageAllowsOwnerReduce = (actor, ov, key) => can(actor, 'settings.roles.edit', matrix, ov)
      && (OWNER_CORE.has(key) || canReduceRole(actor.role, 'owner'));
    let disagree = 0; const firstD = [];
    for (const actorRole of ['owner', 'admin', 'manager', 'crew']) {
      const actor = { id: 'u_act', role: actorRole };
      const ov = can(actor, 'settings.roles.edit', matrix, []) ? [] : [{ userId: 'u_act', grants: ['settings.roles.edit'], revokes: [] }];
      for (const key of [OWNKEY, COREKEY]) {
        const prev = { users: usersFor(actorRole), permissions: matrix, userPermissionOverrides: ov, company: {}, sites: [], clients: [] };
        const next = { ...prev, permissions: dropOwner(matrix, key) };
        const guardAccepts = orgGuard(prev, next, actorRole, 'u_act', { removal: { payState: {}, recentHours: new Set() } }).length === 0;
        const pageAllows = pageAllowsOwnerReduce(actor, ov, key);
        if (pageAllows !== guardAccepts) { disagree += 1; if (firstD.length < 8) firstD.push(`${actorRole}/${key}: page ${pageAllows}, guard ${guardAccepts}`); }
      }
    }
    ok(`🔴 CS-371: the Roles owner-column reduce decision AGREES with the server guard for every actor role, core + non-core (${disagree}${firstD.length ? `: ${firstD.join(' · ')}` : ''})`, disagree === 0);
  }
}

console.log(`\ntest-permission-grant-authority: ${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
