// S131 (plan 2026-10-14 §0, brief R Part 1) — the SUPPLY MANAGER role, `supply_manager`.
//
// A new role whose permissions really differ (supplies only), so it is a 5th entry in
// lib/roles ROLES rather than a level of another role. What this pins:
//   1. the role list: ROLES carries it right after `manager` (column and display order follow
//      ROLES); SUPERVISOR_ROLES does not (a supply manager supervises no building);
//   2. its defaults, read off PERMISSIONS (never restated): exactly dashboard.view,
//      supplies.view, supplies.manage, supplies.deliver and reports.view (the key that opens
//      Reports → Supply usage) — NOT supplies.approve (Matt: only approved orders reach them)
//      and NOT supplies.request; and Reports lists for it only the report its keys can run;
//   3. its words: the catalog's role.supply_manager (+ .desc), and role.manager reading
//      "Account Manager" with "Operations Manager" beside it (the Manager role's two levels);
//   4. who may give it (lib/roles canGiveRole → teamLimits): the owner, an admin and a manager
//      by default; the role picker's six choices in order;
//   5. 🔴 THE TRAP — an unknown role is treated as crew by the server (authz.js, state/view.js),
//      so the role must be OFFICE everywhere a role list decides it: the claim's VALID_ROLES,
//      authz OFFICE_ROLES (ONE list, lib/roles), the browser's read path (store/sync.js), the
//      office background workers (App.jsx), orgStateGuard's OFFICE floor, push/status, the
//      login routes' "Invalid role", the Team pages' office-only columns;
//   6. the RLS migration 20261014120100: the three LIVE policies dropped and re-created with
//      'supply_manager' added, everything else byte-for-byte the source migrations'.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying on
// the first missing export. Offline. Run: node scripts/test-supply-manager-role.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP, '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);

const R = await import('../src/lib/roles.js');
const core = await import('../src/i18n/core.js');
const TL = await import('../src/lib/teamLimits.js').catch(() => ({}));
const claims = await import('../api/_lib/claims.js').catch(() => ({}));
const authz = await import('../api/_lib/authz.js').catch(() => ({}));
const guard = await import('../api/_lib/orgStateGuard.js').catch(() => ({}));
const teamAuth = await import('../api/_lib/teamAuthority.js').catch(() => ({}));
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);

const SM = 'supply_manager';

// ── 1. the role list ─────────────────────────────────────────────────────────────────────────
ok(`ROLES carries supply_manager right after manager (${show(R.ROLES)})`,
  show(R.ROLES) === show(['owner', 'admin', 'manager', SM, 'crew']));
ok('SUPERVISOR_ROLES stays owner / admin / manager: a supply manager supervises no building',
  show(R.SUPERVISOR_ROLES) === show(['owner', 'admin', 'manager']));
ok('the claim knows the role (claims.js VALID_ROLES is ROLES), so the login routes never answer "Invalid role"',
  Array.isArray(claims.VALID_ROLES) && claims.VALID_ROLES.includes(SM)
  && show([...claims.VALID_ROLES]) === show([...R.ROLES]));

// ── 2. the defaults ──────────────────────────────────────────────────────────────────────────
{
  const held = Object.entries(R.PERMISSIONS).filter(([, d]) => (d.defaultRoles || []).includes(SM)).map(([k]) => k).sort();
  const WANT = ['dashboard.view', 'reports.view', 'supplies.deliver', 'supplies.manage', 'supplies.view'];
  ok(`a supply manager holds exactly the supply keys + Dashboard + Reports by default (${show(held)})`, show(held) === show(WANT));
  const can = (key) => R.can({ id: 'u_sm', role: SM }, key, R.seedPermissions(), []);
  ok('🔴 never supplies.approve (Matt: only approved orders reach them) and never supplies.request',
    can('supplies.approve') === false && can('supplies.request') === false);
  ok('the always-granted surfaces stay theirs (Schedule, Messaging, My Day, Account)',
    ['schedule.view', 'messaging.use', 'time.clock', 'settings.account'].every(can));
  ok('…and nothing office-wide beyond that: no customers, team, time or quality keys',
    ['clients.view', 'contacts.view', 'settings.team.view', 'time.view', 'time.approve', 'qc.view', 'ops.view', 'invoices.view'].every((k) => !can(k)));
  // The supply key rows keep the office tiers in ROLES order, the new role inserted after manager.
  for (const key of ['supplies.view', 'supplies.manage', 'supplies.deliver']) {
    ok(`${key} defaults to owner / admin / manager / supply_manager, in ROLES order`,
      show(R.PERMISSIONS[key]?.defaultRoles) === show(['owner', 'admin', 'manager', SM]));
  }
  // Reports opens on reports.view; a report whose read needs another key names it (`perm`) and is
  // listed only for its holders — so a supply manager's Reports is Supply usage alone, never six
  // reports whose reads would refuse them.
  const rep = read('src/pages/Reports.jsx');
  ok('Reports → Supply usage names its read key (supplies.view)', /id: 'supply-usage'[^\n]*perm: 'supplies\.view'/.test(rep));
  const entries = (rep.match(/^ {2}\{ id: '[^']+'[^\n]*$/gm) || []);
  ok(`every report names the key its read needs, so each is listed only for its holders (${entries.filter((e) => !/perm: '/.test(e)).length} without)`,
    entries.length >= 8 && entries.every((e) => /perm: '[a-z]+\.[A-Za-z.]+'/.test(e)));
  ok('Reports opens on the first report the viewer may run (never an id they cannot see)',
    /const fallbackId = reports\.some\(\(r\) => r\.id === DEFAULT_REPORT\) \? DEFAULT_REPORT : \(reports\[0\]\?\.id/.test(rep));
}

// ── 3. the words ─────────────────────────────────────────────────────────────────────────────
ok('role.supply_manager reads "Supply Manager", with a description', core.english('role.supply_manager') === 'Supply Manager'
  && typeof core.english('role.supply_manager.desc') === 'string' && core.english('role.supply_manager.desc').length > 20
  && R.ROLE_LABELS?.[SM] === 'Supply Manager' && R.ROLE_DESCRIPTIONS?.[SM] === core.english('role.supply_manager.desc'));
ok('role.manager reads "Account Manager"; the operations level reads "Operations Manager"',
  core.english('role.manager') === 'Account Manager' && core.english('role.opsManager') === 'Operations Manager');
ok('roleLabel(t, role) names the new role through the catalog', R.roleLabel?.((k) => `T:${k}`, SM) === 'T:role.supply_manager');

// ── 4. who may give it, and the picker ───────────────────────────────────────────────────────
{
  const matrix = R.seedPermissions();
  const gives = (role) => R.ROLES.filter((r) => R.canGiveRole({ id: `u_${role}`, role }, r, matrix, []));
  ok(`default matrix: owner gives all five, admin Admin / Supply Manager / Crew, a manager Admin / Account or Ops Manager / Supply Manager / Crew (${show(['owner', 'admin', 'manager'].map(gives))})`,
    show(gives('owner')) === show(R.ROLES)
    && show(gives('admin')) === show(['admin', SM, 'crew'])
    && show(gives('manager')) === show(['admin', 'manager', SM, 'crew']));
  ok('a supply manager can give only their own role, crew holds keys they lack', show(gives(SM)) === show([SM]) && show(gives('crew')) === show(['crew']));
  const choices = fn(TL, 'roleChoices')({ id: 'u_owner', role: 'owner' }, matrix, []) || [];
  ok(`the owner's picker reads Super Admin · Admin · Account Manager · Operations Manager · Supply Manager · Crew (${show(choices.map((c) => core.english(c.labelKey)))})`,
    show(choices.map((c) => core.english(c.labelKey))) === show(['Super Admin', 'Admin', 'Account Manager', 'Operations Manager', 'Supply Manager', 'Crew']));
  ok('the two manager entries are role manager + a level', choices.filter((c) => c.role === 'manager').map((c) => c.level).join() === 'account,operations');
  const mgrChoices = fn(TL, 'roleChoices')({ id: 'u_manager', role: 'manager' }, matrix, []) || [];
  ok('a manager is offered Account Manager but not Operations Manager (setting a level is owner / admin + ops.edit)',
    mgrChoices.some((c) => c.value === 'manager') && !mgrChoices.some((c) => c.level === 'operations') && mgrChoices.some((c) => c.role === SM));
  const authority = typeof teamAuth.matrixAuthority === 'function'
    ? teamAuth.matrixAuthority({ permissions: matrix, userPermissionOverrides: [] }, 'manager', 'u_manager') : null;
  const no = typeof teamAuth.loginRefusal === 'function' && authority
    ? teamAuth.loginRefusal('invite', { caller: { role: 'manager', orgUserId: 'u_manager', email: 'm@x.test', claimIdentity: true }, authority, target: { email: 'sm@x.test', rows: [] }, newRole: SM })
    : 'not-run';
  ok(`the login route lets a manager invite a supply manager (${show(no)})`, no === null);
}

// ── 5. OFFICE EVERYWHERE (the trap: an unknown role reads as crew) ────────────────────────────
ok('lib/roles exports OFFICE_ROLES — every tier but crew — with the new role in it',
  Array.isArray(R.OFFICE_ROLES) && R.OFFICE_ROLES.includes(SM) && !R.OFFICE_ROLES.includes('crew')
  && show(R.OFFICE_ROLES) === show(R.ROLES.filter((r) => r !== 'crew')));
ok('isOfficeRole(role): the one predicate (null / unknown / crew → false)', typeof R.isOfficeRole === 'function'
  && R.isOfficeRole(SM) && R.isOfficeRole('manager') && !R.isOfficeRole('crew') && !R.isOfficeRole(null) && !R.isOfficeRole('Owner') && !R.isOfficeRole('client'));
ok('authz OFFICE_ROLES IS lib/roles OFFICE_ROLES (one list, not a copy)', authz.OFFICE_ROLES === R.OFFICE_ROLES);
{
  const sync = read('src/store/sync.js');
  ok('🔴 store/sync.js derives the restricted (crew) read path from the office set, not a hand list (NEW-CANDIDATE)',
    /const restrictedRead = !isOfficeRole\(claimRole\);/.test(sync) && !/claimRole !== 'manager'/.test(sync));
  const app = read('src/App.jsx');
  const bg = (app.match(/function BackgroundServices\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('App.jsx: the office background workers follow the office set', /const isOffice = isOfficeRole\(currentUser\?\.role\);/.test(bg)
    && !/role === 'manager'/.test(bg));
  ok('…and the late / missed-shift scheduler runs only for a time.view holder (its first read), so a supply manager\'s tab never 403s every minute',
    /isOffice && canTimeView && <OpsAlertScheduler \/>/.test(bg));
  const g = read('api/_lib/orgStateGuard.js');
  ok('orgStateGuard\'s OFFICE floor is the office set', /const OFFICE = OFFICE_ROLES;/.test(g) && !/const OFFICE = \['owner', 'admin', 'manager'\];/.test(g));
  const push = read('api/push/status.js');
  ok('push/status: the team-device read is the office set', /requireRole\(req, res, OFFICE_ROLES\)/.test(push) && !/\['owner', 'admin', 'manager'\]/.test(push));
  const view = read('api/state/view.js');
  ok('state/view: the full blob goes to the office set (OFFICE_ROLES), the projection to anyone else', /if \(OFFICE_ROLES\.includes\(a\.role\)\)/.test(view));
  const team = read('src/pages/settings/Team.jsx');
  ok('Team.jsx: the Push, Clock rules and app-versions columns follow the office set', /const canSeePush = isOfficeRole\(currentUser\?\.role\);/.test(team)
    && /holdsClockRules && isOfficeRole\(currentUser\?\.role\)/.test(team) && !/\['owner', 'admin', 'manager'\]\.includes/.test(team));
  const detail = read('src/pages/settings/TeamDetail.jsx');
  ok('TeamDetail: the clock-rules office floor is the office set (the guard\'s twin)', /canEditClockRules\s*&& isOfficeRole\(currentUser\?\.role\)/.test(detail));
}
// The guard: a supply manager is office for the clockRules floor; crew never is.
{
  const pv = fn(guard, 'protectedFieldViolations');
  const users = [
    { id: 'u_owner', role: 'owner', status: 'active', email: 'o@x.test' },
    { id: 'u_sm', role: SM, status: 'active', email: 'sm@x.test' },
    { id: 'u_crew', role: 'crew', status: 'active', email: 'c@x.test' },
  ];
  const grant = (id) => [{ userId: id, grants: ['time.clockRules', 'settings.team.edit'], revokes: [] }];
  const base = (ov) => ({ users, permissions: R.seedPermissions(), userPermissionOverrides: ov, company: {}, sites: [], clients: [] });
  const exempt = (prev) => ({ ...prev, users: users.map((u) => (u.id === 'u_crew' ? { ...u, clockRules: { geofenceOff: true } } : u)) });
  const smOut = pv(base(grant('u_sm')), exempt(base(grant('u_sm'))), SM, 'u_sm', {});
  const crewOut = pv(base(grant('u_crew')), exempt(base(grant('u_crew'))), 'crew', 'u_crew', {});
  ok(`a supply manager granted time.clockRules passes the OFFICE floor (${show(smOut)})`, Array.isArray(smOut) && smOut.length === 0);
  ok(`a cleaner granted the same key still does not (${show(crewOut)})`, Array.isArray(crewOut) && crewOut.length > 0);
}

// ── 6. Settings → Roles, the Team pages, the switcher ────────────────────────────────────────
{
  const roles = read('src/pages/settings/Roles.jsx');
  ok('Settings → Roles: the "New" tag moved to the supply manager column', /r === 'supply_manager' \? ' is-new' : ''/.test(roles)
    && /r === 'supply_manager' && <span className="rp-legend-tag">/.test(roles) && !/r === 'manager' \? ' is-new'/.test(roles));
  // CS-858 (2026-10-16): the one Manager column both levels shared became two — the Account
  // Managers' and the Operations Managers' own (lib/roles PERMISSION_COLUMNS; rendered and pinned in
  // test-roles-om-column-render.mjs).
  ok('…and the manager levels have a column each: Account Manager, then Operations Manager (PERMISSION_COLUMNS)',
    /PERMISSION_COLUMNS\.map\(\(r\) =>/.test(roles) && /columnLabel\(t, r\)/.test(roles)
    && typeof core.english('role.managerColumn.desc') === 'string' && typeof core.english('role.opsManager.desc') === 'string');
  const sw = read('src/components/UserSwitcher.jsx');
  ok('the user switcher names a member by their level (memberRoleLabel)', /memberRoleLabel\(t, u\)/.test(sw) && /memberRoleLabel\(t, currentUser\)/.test(sw));
  const add = read('src/components/AddUserModal.jsx');
  ok('AddUserModal offers the six choices (roleChoices) and names them through the catalog', /roleChoices\(currentUser, selectPermissions\(state\), selectUserPermissionOverrides\(state\)\)/.test(add)
    && /label: t\(c\.labelKey\)/.test(add));
}

// ── 7. the RLS migration (written here, applied by the orchestrator at release) ───────────────
{
  const dir = path.join(REPO, 'supabase', 'migrations');
  const list = (() => { try { return readdirSync(dir); } catch { return []; } })();
  const file = list.find((f) => f === '20261014120100_supply_manager_office_read.sql');
  ok('migration 20261014120100_supply_manager_office_read.sql exists', !!file);
  const raw = file ? readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n') : '';
  const sql = raw.replace(/--.*$/gm, '');
  const src = (f) => { try { return readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').replace(/--.*$/gm, ''); } catch { return ''; } };
  const cs002 = src('20260925120000_cs002_crew_read_split.sql');
  const jd = src('20261003110100_job_deletes_scoped_read.sql');
  // A policy statement, whitespace-collapsed, from its `create policy "name"` to its `;`.
  const stmt = (text, name) => ((text.match(new RegExp(`create policy "${name}"[\\s\\S]*?;`)) || [''])[0]).replace(/\s+/g, ' ').trim();
  const withSm = (s) => s.split("in ('owner', 'admin', 'manager')").join("in ('owner', 'admin', 'manager', 'supply_manager')");
  ok('one transaction', /^\s*begin;/m.test(sql) && /^\s*commit;/m.test(sql) && (sql.match(/\bbegin;/g) || []).length === 1);
  for (const [name, from] of [['office read org_state', cs002], ['scoped read jobs', cs002], ['scoped read job_deletes', jd]]) {
    const was = stmt(from, name);
    const now = stmt(sql, name);
    ok(`"${name}": dropped if exists, then re-created`, new RegExp(`drop policy if exists "${name}" on public\\.`).test(sql) && !!now);
    ok(`"${name}": the source policy byte-for-byte, 'supply_manager' added to the office set`, !!was && was.includes("'manager')") && now === withSm(was));
  }
  const created = [...sql.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
  ok(`nothing else changes: exactly the three policies (${show(created)})`, show(created.sort()) === show(['office read org_state', 'scoped read job_deletes', 'scoped read jobs']));
  const statements = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  ok(`only begin / set / drop / create / commit statements (${statements.length})`, statements.length > 0
    && statements.every((s) => /^(begin|commit|set (lock|statement)_timeout = '\w+'|drop policy if exists "[^"]+" on public\.\w+|create policy "[^"]+" on public\.\w+ for select to authenticated using \([\s\S]+\))$/.test(s)));
  ok('the header says it is written, not applied, and how to roll it back', /NOT APPLIED/.test(raw) && /ROLLBACK|forward-fix/i.test(raw));
}

// ── 8. a STORED matrix row wins over the code default ─────────────────────────────────────────
// A matrix saved before S131 holds every key's row WITHOUT the new role, and can() reads a stored
// row before the schema's defaultRoles — so on such a matrix a supply manager holds nothing (no
// dashboard.view: they land on My Day). The demo's v58 → v59 hop adds the role to the rows of its
// default keys, as v54 → v55 seeded schedule.reset; production's stored matrix needs the same at
// release (a data-op, or Settings → Roles).
{
  const P = await import('../src/store/persist.js').catch(() => ({}));
  const hop = typeof P.migrateV58toV59 === 'function' ? P.migrateV58toV59 : () => null;
  const before = R.seedPermissions().map((p) => ({ ...p, roles: (p.roles || []).filter((r) => r !== SM) }));
  const after = hop({ version: 58, users: [], clients: [], permissions: before });
  const canAfter = (key) => !!after && R.can({ id: 'u_sm', role: SM }, key, after.permissions, []);
  const want = Object.entries(R.PERMISSIONS).filter(([, d]) => (d.defaultRoles || []).includes(SM)).map(([k]) => k);
  ok(`🔴 after the v59 hop a supply manager holds their defaults on a matrix saved before S131 (missing: ${show(want.filter((k) => !canAfter(k)))})`,
    want.length === 5 && want.every(canAfter));
  ok('…and still never supplies.approve or supplies.request, nor anything else', !!after
    && !canAfter('supplies.approve') && !canAfter('supplies.request') && !canAfter('clients.view') && !canAfter('time.view'));
  const custom = before.map((p) => (p.id === 'reports.view' ? { ...p, roles: ['owner'] } : p));
  const afterCustom = hop({ version: 58, users: [], clients: [], permissions: custom });
  ok('…a row the office customised keeps its roles as they were, the new role added after them',
    show(afterCustom?.permissions?.find((p) => p.id === 'reports.view')?.roles) === show(['owner', SM]));
  ok('…the hop is idempotent', !!after && show(hop(after)?.permissions) === show(after.permissions));
  ok('…and a state with no stored matrix stays without one (the defaults apply)', !('permissions' in (hop({ version: 58, users: [], clients: [] }) || { permissions: 1 })));
}

console.log(`\ntest-supply-manager-role: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
