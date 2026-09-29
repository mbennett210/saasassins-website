// The LOGIN half of Settings → Team (/api/settings/users/*) and the removal pay rule on
// both halves, through the REAL handlers (api/settings/[...path].js, api/state/org-state.js)
// and the REAL supabase-js, against a local fake GoTrue + PostgREST
// (scripts/fake-supabase-server.mjs). Offline by construction: a fetch guard refuses every
// host but the fake, and the Resend key is removed so no email can be sent.
//
// What this pins (fixed 2026-09-23, owner's decisions). Before:
//   • claims.js VALID_ROLES was owner/admin/crew: nobody could invite a manager or re-role
//     anyone to manager in live mode (400 "Invalid role"), and manager logins were claim-less.
//   • the users section was owner/admin by role list, disable + remove owner-only, so a
//     manager's invite / role / disable / remove / reset (and an admin's disable / remove)
//     failed there, although the app offers them.
//   • nothing on the server refused removing a member who may still be owed pay.
//   • a Super Admin could demote, disable or remove the last Super Admin login.
//   • an Admin could re-invite an orphaned Super Admin login at a lower level.
//   • an owner's or admin's invite of an email already on the team went on to the adoption,
//     whose LENIENT roster read took a failed read for "no roster row" and re-stamped the
//     member's login (HANDOFF S78 find 5).
// Now each action follows the key the app gates it on (committed matrix + overrides) within
// the owner's limits, and a role is given only by someone who holds everything it carries
// (lib/roles canGiveRole). The rules live in api/_lib/teamAuthority.js.
//
//   node app/scripts/test-team-logins.mjs
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { startFakeSupabase } from './fake-supabase-server.mjs';
import * as roles from '../src/lib/roles.js';
import { payPeriodRange } from '../src/lib/payroll.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── offline rig: env first (the clients are built on first use), then the handlers ──────
const ORG = '00000000-0000-0000-0000-0000000fab12';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG,
  CLEANSPACE_ORG_ID: ORG,
  APP_BASE_URL: 'http://127.0.0.1',
});
for (const k of ['RESEND_API_KEY', 'ALERT_WEBHOOK_URL', 'RESEND_AUTH_FROM']) delete process.env[k];
const realFetch = globalThis.fetch;
const strays = [];
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(fake.url)) { strays.push(u); return Promise.reject(new Error(`offline suite: refused ${u}`)); }
  return realFetch(input, init);
};
// console noise from the routes (email skipped, alerts) is expected; keep the output readable.
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

const settings = (await import('../api/settings/[...path].js')).default;
const orgStateRoute = (await import('../api/state/org-state.js')).default;
const claims = await import('../api/_lib/claims.js');
// Missing before the fix; its assertions then fail instead of the suite crashing.
const team = await import('../api/_lib/teamAuthority.js').catch(() => ({}));

// ── the pure rule ─────────────────────────────────────────────────────────────────────
const matrix = roles.seedPermissions(); // the committed default the seed ships
const give = (user, role, perms = matrix, ov = []) => typeof roles.canGiveRole === 'function' && roles.canGiveRole(user, role, perms, ov);
const who = (role, id = 'u_x') => ({ id, role });
ok('VALID_ROLES is the app\'s own role list (lib/roles ROLES), manager included',
  JSON.stringify([...claims.VALID_ROLES]) === JSON.stringify(roles.ROLES) && claims.VALID_ROLES.includes('manager'));
ok('canGiveRole exists (lib/roles)', typeof roles.canGiveRole === 'function');
ok('a Super Admin may give every role', roles.ROLES.every((r) => give(who('owner'), r)));
ok('an Admin may give Admin and Crew (default matrix)', give(who('admin'), 'admin') && give(who('admin'), 'crew'));
ok('  ...not Manager, which carries permissions an Admin lacks (financials, roles)', !give(who('admin'), 'manager'));
ok('  ...and not Super Admin', !give(who('admin'), 'owner'));
ok('a Manager may give Admin, Manager and Crew, never Super Admin',
  give(who('manager'), 'admin') && give(who('manager'), 'manager') && give(who('manager'), 'crew') && !give(who('manager'), 'owner'));
ok('crew may give only Crew', give(who('crew'), 'crew') && !give(who('crew'), 'admin') && !give(who('crew'), 'manager'));
ok('an unknown role is never given ("Owner", an array, none)',
  !give(who('owner'), 'Owner') && !give(who('manager'), ['owner']) && !give(who('manager'), undefined));
ok('no identity / no role gives nothing', !give(null, 'crew') && !give({ id: 'u_x' }, 'crew'));
{
  // Decided by the MATRIX, not the role name: pare Manager down to what Admins hold and
  // Admins may give it; a Manager who personally lost a key can't give Manager.
  const pared = matrix.map((p) => (p.roles.includes('manager') && !p.roles.includes('admin') ? { ...p, roles: p.roles.filter((r) => r !== 'manager') } : p));
  ok('with Manager pared down to an Admin\'s permissions, an Admin may give Manager', give(who('admin'), 'manager', pared));
  ok('a Manager with a permission personally revoked cannot give Manager',
    !give(who('manager', 'u_m'), 'manager', matrix, [{ userId: 'u_m', grants: [], revokes: ['invoices.view'] }]));
  ok('  ...but still gives Admin (which never carried it)',
    give(who('manager', 'u_m'), 'admin', matrix, [{ userId: 'u_m', grants: [], revokes: ['invoices.view'] }]));
  ok('crew granted every Admin permission may give Admin',
    give(who('crew', 'u_c'), 'admin', matrix, [{ userId: 'u_c', grants: matrix.filter((p) => p.roles.includes('admin')).map((p) => p.id), revokes: [] }]));
}
ok('loginRefusal exists (api/_lib/teamAuthority.js)', typeof team.loginRefusal === 'function');
ok('owedPayFor exists (api/_lib/teamAuthority.js)', typeof team.owedPayFor === 'function');
if (typeof team.owedPayFor === 'function') {
  // A pay line's cutoff is a date KEY taken in the ORG zone. Find an instant where Los
  // Angeles and Kiritimati (21 h apart) sit in different pay periods, and pin that the
  // org zone decides whether a line that starts LA's previous period is still unsettled.
  const LA = 'America/Los_Angeles';
  const KIR = 'Pacific/Kiritimati';
  let t = null;
  for (let h = 0; h < 24 * 16 && !t; h += 1) {
    const cand = new Date(Date.UTC(2026, 8, 1) + h * 3600e3);
    if (payPeriodRange('biweekly', -1, cand, LA).fromKey !== payPeriodRange('biweekly', -1, cand, KIR).fromKey) t = cand;
  }
  ok('fixture: an instant where the two zones sit in different pay periods', !!t);
  if (t) {
    const keyLA = payPeriodRange('biweekly', -1, t, LA).fromKey;
    const keyKIR = payPeriodRange('biweekly', -1, t, KIR).fromKey;
    const facts = { payState: { payrollLines: [{ id: 'l1', userId: 'u_p', periodKey: keyLA }], opsSettings: { payPeriodCadence: 'biweekly' } }, recentHours: new Set(), now: t };
    const at = (timezone) => team.owedPayFor({ users: [{ id: 'u_p', role: 'crew', status: 'active' }], company: { timezone } }, facts, 'u_p');
    ok("a line starting the org zone's previous period is unsettled (Los Angeles)", at(LA) === 'unsettled-pay');
    ok('  ...and the same line reads by the other zone\'s calendar when that is the org zone (Kiritimati)',
      at(KIR) === (keyLA >= keyKIR ? 'unsettled-pay' : null));
  }
}

// ── the world: a small roster with every case the routes decide on ───────────────────
const TZ = 'America/Los_Angeles';
const NOW = new Date();
const THIS_PERIOD = payPeriodRange('biweekly', 0, NOW, TZ).fromKey; // the pay run's own period math
const PEOPLE = {
  owner: { role: 'owner' }, owner2: { role: 'owner' }, admin: { role: 'admin' }, admin2: { role: 'admin' },
  mgr: { role: 'manager' }, mgr0: { role: 'manager', claim: 'none' }, mgrnoid: { role: 'manager', claim: 'role-only' },
  crew: { role: 'crew' }, member: { role: 'crew' }, member2: { role: 'crew' }, paid: { role: 'crew' },
  hours: { role: 'crew' }, salary: { role: 'crew', pay: { type: 'salary', salaryPerPeriod: 2000 } },
};
const email = (k) => `${k}@cs.test`;
const idOf = (k) => `u_${k}`;
function world({ secondOwner = null, overrides = [], perms = matrix, orphanOwner = true, tz = TZ, punches = null } = {}) {
  const authUsers = [];
  const tokens = {};
  const users = [];
  for (const [k, p] of Object.entries(PEOPLE)) {
    if (k === 'owner2' && !secondOwner) continue;
    users.push({ id: idOf(k), role: p.role, status: 'active', name: k, email: email(k), ...(p.pay ? { pay: p.pay } : {}) });
    const md = { provider: 'email', providers: ['email'] };
    if (p.claim !== 'none') md.role = p.role;
    if (!p.claim) { md.org_user_id = idOf(k); md.org_id = ORG; }
    const authId = randomUUID();
    authUsers.push({ id: authId, email: email(k), app_metadata: md, user_metadata: {}, banned_until: k === 'owner2' && secondOwner === 'banned' ? '2126-01-01T00:00:00.000Z' : null });
    tokens[`tok_${k}`] = authId;
  }
  // Logins with no roster row: a Super Admin's (it can still sign in as one, so it counts
  // as another Super Admin for "who is left") and a crew member's.
  for (const [k, role] of [...(orphanOwner ? [['orphanowner', 'owner']] : []), ['orphancrew', 'crew']]) {
    authUsers.push({ id: randomUUID(), email: email(k), app_metadata: { role, org_user_id: idOf(k), org_id: ORG }, user_metadata: {}, banned_until: null });
  }
  return {
    authUsers,
    tokens,
    orgState: {
      organization_id: ORG,
      version: 7,
      protected_fingerprint: null,
      min_client_build: null,
      state: {
        users,
        permissions: perms,
        userPermissionOverrides: overrides,
        company: { name: 'Clean Space', timezone: tz },
        opsSettings: { payPeriodCadence: 'biweekly' },
        payrollLines: [{ id: 'pl_1', userId: idOf('paid'), periodKey: THIS_PERIOD, label: 'Bonus', amountCents: 5000 }],
        reimbursements: [],
        sites: [],
        clients: [],
        timeOff: [],
      },
    },
    timeEntries: punches || [{ id: 'te_1', organization_id: ORG, user_id: idOf('hours'), clock_in_at: new Date(NOW.getTime() - 3600e3).toISOString(), clock_out_at: null, status: 'open' }],
  };
}
const punch = (k, iso) => ({ id: `te_${k}_${iso}`, organization_id: ORG, user_id: idOf(k), clock_in_at: iso, clock_out_at: iso, status: 'closed' });

const mockRes = () => ({
  statusCode: 0, body: null,
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
});
// POST (or GET with no body) /api/settings/users[/sub] as `k`.
async function users(k, sub, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { authorization: `Bearer tok_${k}`, host: '127.0.0.1' };
  req.query = { subpath: sub ? `users/${sub}` : 'users' };
  const res = mockRes();
  await settings(req, res);
  return res;
}
// A roster save (POST /api/state/org-state) as `k`: the committed state with `mutate` applied.
async function save(k, mutate) {
  const committed = fake.db.orgState;
  const next = JSON.parse(JSON.stringify(committed.state));
  mutate(next);
  const req = { method: 'POST', headers: { authorization: `Bearer tok_${k}` }, body: { state: next, baseVersion: committed.version, build: 0, tab: 'tab_test' } };
  const res = mockRes();
  await orgStateRoute(req, res);
  return res;
}
const login = (k) => fake.db.authUsers.find((u) => u.email === email(k));
const fresh = (opts) => fake.reset(world(opts));
const errOf = (r) => String(r.body?.error || '');

// ── invite (POST /users) ──────────────────────────────────────────────────────────────
fresh();
let r = await users('mgr', '', { email: 'new1@cs.test', role: 'crew', orgUserId: 'u_new1' });
ok('a MANAGER can invite a crew member (settings.team.edit)', r.statusCode === 200);
ok('  ...and the login carries the role + id claims', login('new1')?.app_metadata?.role === 'crew' && login('new1')?.app_metadata?.org_user_id === 'u_new1');
fresh();
r = await users('owner', '', { email: 'new2@cs.test', role: 'manager', orgUserId: 'u_new2' });
ok('a Super Admin can invite a MANAGER (the claim role exists)', r.statusCode === 200 && login('new2')?.app_metadata?.role === 'manager');
fresh();
r = await users('mgr', '', { email: 'new3@cs.test', role: 'manager', orgUserId: 'u_new3' });
ok('a manager can invite a manager (holds everything it carries)', r.statusCode === 200 && login('new3')?.app_metadata?.role === 'manager');
fresh();
r = await users('admin', '', { email: 'new4@cs.test', role: 'crew', orgUserId: 'u_new4' });
ok('an admin still invites crew (never tightened)', r.statusCode === 200);
fresh();
r = await users('admin', '', { email: 'new5@cs.test', role: 'manager', orgUserId: 'u_new5' });
ok('an admin CANNOT invite a manager: it carries permissions an admin lacks (403)', r.statusCode === 403 && !login('new5'));
fresh();
r = await users('mgr', '', { email: 'new6@cs.test', role: 'owner', orgUserId: 'u_new6' });
ok('a manager cannot invite a Super Admin', r.statusCode === 403 && !login('new6'));
fresh();
r = await users('crew', '', { email: 'new7@cs.test', role: 'crew', orgUserId: 'u_new7' });
ok('crew cannot invite', r.statusCode === 403 && !login('new7'));
fresh({ overrides: [{ userId: idOf('crew'), grants: ['settings.team.edit'], revokes: [] }] });
r = await users('crew', '', { email: 'new8@cs.test', role: 'crew', orgUserId: 'u_new8' });
ok("crew GRANTED settings.team.edit may invite crew (the grant's intent)", r.statusCode === 200);
r = await users('crew', '', { email: 'new9@cs.test', role: 'admin', orgUserId: 'u_new9' });
ok('  ...but not an admin (more than they hold)', r.statusCode === 403 && !login('new9'));
fresh();
r = await users('mgr0', '', { email: 'new10@cs.test', role: 'crew', orgUserId: 'u_new10' });
ok('a manager login still WITHOUT claims is refused (claim-backed authority only)', r.statusCode === 403 && /claim-backed/.test(errOf(r)));
fresh();
r = await users('mgrnoid', '', { email: 'new11@cs.test', role: 'crew', orgUserId: 'u_new11' });
ok('a manager with a role claim but no id claim gets no matrix path (the email → id map is writable)', r.statusCode === 403 && !login('new11'));
fresh();
r = await users('admin', '', { email: email('orphanowner'), role: 'admin' });
ok("an admin CANNOT re-invite an orphaned Super Admin login at a lower level", r.statusCode === 403 && login('orphanowner')?.app_metadata?.role === 'owner');
fresh();
r = await users('mgr', '', { email: email('orphancrew'), role: 'crew' });
ok('a manager can re-invite an orphaned crew login (adopt)', r.statusCode === 200 && r.body?.adopted === true);
fresh();
r = await users('mgr', '', { email: email('mgr'), role: 'admin' });
ok('nobody invites themselves', r.statusCode === 403 && login('mgr')?.app_metadata?.role === 'manager');
fresh();
r = await users('mgr', '', { email: email('member'), role: 'admin' });
ok('a manager cannot invite an email already on the team', r.statusCode === 409 && login('member')?.app_metadata?.role === 'crew');
fresh();
r = await users('owner', '', { email: 'new12@cs.test', role: 'Owner' });
ok('an unknown role is still a 400 before any gate', r.statusCode === 400);

// An email already on the team is refused on the route's own read of the committed roster,
// for EVERY caller (S78 find 5). Before, only the matrix path checked it: an owner's or
// admin's invite went on to createUserAccount, whose adoption re-read the roster LENIENTLY,
// so a failed read meant "no roster row" and it adopted the member's login and re-stamped
// its claims. mgr0's login is claim-less (as a manager's was before claims.js knew the
// role), so nothing else stopped it. The fake fails the adoption's read (the first
// `state,version` read; the route's own read selects slices).
const failFirstBlobRead = (onFail) => {
  let failed = false;
  fake.intercept((q, db) => {
    if (failed || q.table !== 'org_state' || q.select !== 'state,version') return undefined;
    failed = true;
    onFail?.(db);
    return 'fail';
  });
};
for (const k of ['owner', 'admin']) {
  fresh();
  failFirstBlobRead();
  r = await users(k, '', { email: email('mgr0'), role: 'crew', orgUserId: `u_fresh_${k}` });
  const md = login('mgr0')?.app_metadata || {};
  ok(`🔴 ${k === 'owner' ? 'a Super Admin' : 'an admin'} re-inviting an email already on the team is refused by the route (409) and the login is untouched, even when the adoption's read would fail (got ${r.statusCode}, claims ${JSON.stringify({ role: md.role, id: md.org_user_id })})`,
    r.statusCode === 409 && md.role === undefined && md.org_user_id === undefined);
}
// The adoption's own read is strict too: the backstop for a member added after the route
// read the roster. A login with no roster row when the route looked, whose member appears
// just as the adoption reads, and that read fails: refuse (try again), never adopt.
fresh();
fake.db.authUsers.push({ id: randomUUID(), email: 'late@cs.test', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, banned_until: null });
failFirstBlobRead((db) => { db.orgState.state.users.push({ id: 'u_late', role: 'crew', status: 'active', name: 'late', email: 'late@cs.test' }); });
r = await users('owner', '', { email: 'late@cs.test', role: 'admin', orgUserId: 'u_fresh_late' });
{
  const md = fake.db.authUsers.find((u) => u.email === 'late@cs.test')?.app_metadata || {};
  ok(`🔴 the adoption's roster read is strict: when it fails, the login is left as it was (503, try again), never adopted and re-stamped (got ${r.statusCode}, claims ${JSON.stringify({ role: md.role, id: md.org_user_id })})`,
    r.statusCode === 503 && md.role === undefined && md.org_user_id === undefined && /couldn't be read/.test(errOf(r)));
}
fake.intercept(null);

// ── role change (POST /users/claims) ──────────────────────────────────────────────────
fresh();
r = await users('mgr', 'claims', { email: email('member'), role: 'admin', orgUserId: idOf('member') });
ok("a MANAGER can change a crew member's role (staff.assignRoles)", r.statusCode === 200 && login('member').app_metadata.role === 'admin');
fresh();
r = await users('mgr', 'claims', { email: email('member'), role: 'manager', orgUserId: idOf('member') });
ok('a manager can make a crew member a manager', r.statusCode === 200 && login('member').app_metadata.role === 'manager');
fresh();
r = await users('owner', 'claims', { email: email('member'), role: 'manager', orgUserId: idOf('member') });
ok('a Super Admin can make someone a manager (was 400 Invalid role)', r.statusCode === 200 && login('member').app_metadata.role === 'manager');
fresh();
r = await users('mgr', 'claims', { email: email('mgr'), role: 'admin', orgUserId: idOf('mgr') });
ok('a manager cannot change their OWN role', r.statusCode === 403 && login('mgr').app_metadata.role === 'manager');
r = await users('mgr', 'claims', { email: email('owner'), role: 'manager', orgUserId: idOf('owner') });
ok("a manager cannot change a Super Admin's role", r.statusCode === 403 && login('owner').app_metadata.role === 'owner');
r = await users('mgr', 'claims', { email: email('member'), role: 'owner', orgUserId: idOf('member') });
ok('a manager cannot make someone a Super Admin', r.statusCode === 403 && login('member').app_metadata.role === 'crew');
r = await users('mgr', 'claims', { email: email('member'), role: 'admin', orgUserId: idOf('member2') });
ok('a manager cannot re-link a login to another member', r.statusCode === 403 && login('member').app_metadata.org_user_id === idOf('member'));
r = await users('mgr', 'claims', { email: email('orphancrew'), role: 'admin' });
ok('a manager cannot re-role a login that is not on the team', r.statusCode === 403 && login('orphancrew').app_metadata.role === 'crew');
r = await users('admin', 'claims', { email: email('member'), role: 'crew', orgUserId: idOf('member') });
ok('an admin cannot change roles by default (no staff.assignRoles)', r.statusCode === 403);
fresh({ overrides: [{ userId: idOf('admin'), grants: ['staff.assignRoles'], revokes: [] }] });
r = await users('admin', 'claims', { email: email('member'), role: 'admin', orgUserId: idOf('member') });
ok('an admin GRANTED staff.assignRoles may make crew an admin', r.statusCode === 200 && login('member').app_metadata.role === 'admin');
r = await users('admin', 'claims', { email: email('member2'), role: 'manager', orgUserId: idOf('member2') });
ok('  ...but not a manager (more than they hold)', r.statusCode === 403 && login('member2').app_metadata.role === 'crew');
fresh({ overrides: [{ userId: idOf('mgr'), grants: [], revokes: ['staff.assignRoles'] }] });
r = await users('mgr', 'claims', { email: email('member'), role: 'admin', orgUserId: idOf('member') });
ok('a manager whose staff.assignRoles is revoked cannot change roles', r.statusCode === 403 && login('member').app_metadata.role === 'crew');
fresh({ orphanOwner: false });
r = await users('owner', 'claims', { email: email('owner'), role: 'admin', orgUserId: idOf('owner') });
ok('the ONLY Super Admin cannot demote themselves (was 200: an org with no Super Admin)', r.statusCode === 403 && login('owner').app_metadata.role === 'owner');
fresh({ secondOwner: 'active', orphanOwner: false });
r = await users('owner', 'claims', { email: email('owner'), role: 'admin', orgUserId: idOf('owner') });
// The claim changes first, so the roster save that follows runs as an Admin, and the
// guard refuses a role change on your own row to anyone but a Super Admin: a split.
ok('nor may a Super Admin with another beside them (the roster save would then be refused: a split)',
  r.statusCode === 403 && login('owner').app_metadata.role === 'owner');
r = await users('owner', 'claims', { email: email('owner'), role: 'owner', orgUserId: idOf('owner') });
ok('  ...re-stamping the role they already hold is a sync, allowed', r.statusCode === 200 && login('owner').app_metadata.role === 'owner');
r = await users('owner', 'claims', { email: email('owner2'), role: 'admin', orgUserId: idOf('owner2') });
ok('a Super Admin may demote ANOTHER Super Admin (the caller remains one)', r.statusCode === 200 && login('owner2').app_metadata.role === 'admin');
fresh({ secondOwner: 'active', orphanOwner: false });
fake.db.orgState.state.users.find((u) => u.id === idOf('owner')).role = 'admin'; // claim Super Admin, row not
r = await users('owner', 'claims', { email: email('owner2'), role: 'admin', orgUserId: idOf('owner2') });
ok('but not the LAST Super Admin row, even as a claimed Super Admin (the guard would refuse the roster save)',
  r.statusCode === 403 && login('owner2').app_metadata.role === 'owner');

// CS-355 (owner 2026-09-25): changing an ADMIN's role is admin+ by ROLE — a manager or crew
// holding staff.assignRoles cannot demote an Admin through the login route; an admin or owner
// can. The route refuses (403 admin-target) BEFORE it re-stamps the claim (syncUserClaims), so
// the claim is left intact. Promoting TO Admin is not gated by this decision.
{
  const authority = team.matrixAuthority({ permissions: matrix, userPermissionOverrides: [] }, 'manager', 'u_mgr');
  const no = typeof team.loginRefusal === 'function' && team.loginRefusal('role', {
    caller: { role: 'manager', orgUserId: 'u_mgr', email: 'mgr@cs.test', claimIdentity: true },
    authority,
    target: { email: 'admin@cs.test', claimRole: 'admin', claimOrgUserId: 'u_admin', rows: [{ id: 'u_admin', role: 'admin', email: 'admin@cs.test' }] },
    newRole: 'crew',
    orgUserId: 'u_admin',
  });
  ok('🔴 loginRefusal(role) on an Admin target → 403 admin-target (the exact code the route hides)', !!no && no.status === 403 && no.code === 'admin-target');
}
fresh();
r = await users('mgr', 'claims', { email: email('admin'), role: 'crew', orgUserId: idOf('admin') });
ok('🔴 a manager cannot change an ADMIN\'s role (403), and the claim is left unchanged', r.statusCode === 403 && login('admin').app_metadata.role === 'admin');
ok('🔴  ...with the Admin-floor wording', /Only an Admin or Super Admin can change an Admin/.test(errOf(r)));
fresh({ overrides: [{ userId: idOf('crew'), grants: ['staff.assignRoles'], revokes: [] }] });
r = await users('crew', 'claims', { email: email('admin'), role: 'crew', orgUserId: idOf('admin') });
ok('🔴  ...nor crew granted staff.assignRoles (the grant does not lift the role floor)', r.statusCode === 403 && login('admin').app_metadata.role === 'admin');
fresh({ overrides: [{ userId: idOf('admin'), grants: ['staff.assignRoles'], revokes: [] }] });
r = await users('admin', 'claims', { email: email('admin2'), role: 'crew', orgUserId: idOf('admin2') });
ok('an ADMIN granted staff.assignRoles CAN change another Admin\'s role', r.statusCode === 200 && login('admin2').app_metadata.role === 'crew');
fresh();
r = await users('owner', 'claims', { email: email('admin'), role: 'crew', orgUserId: idOf('admin') });
ok('the owner CAN change an Admin\'s role (unaffected)', r.statusCode === 200 && login('admin').app_metadata.role === 'crew');
fresh();
r = await users('mgr', 'claims', { email: email('member'), role: 'admin', orgUserId: idOf('member') });
ok('a manager may still PROMOTE a crew member to Admin (promotion TO Admin is not gated)', r.statusCode === 200 && login('member').app_metadata.role === 'admin');

// ── disable / re-enable (POST /users/disable) ─────────────────────────────────────────
fresh();
r = await users('mgr', 'disable', { email: email('member'), disabled: true });
ok('a MANAGER can disable a member (settings.team.edit)', r.statusCode === 200 && !!login('member').banned_until);
r = await users('mgr', 'disable', { email: email('member'), disabled: false });
ok('  ...and re-enable them', r.statusCode === 200 && !login('member').banned_until);
r = await users('mgr', 'disable', { email: email('owner'), disabled: true });
ok('a manager cannot disable a Super Admin', r.statusCode === 403 && !login('owner').banned_until);
r = await users('admin', 'disable', { email: email('member'), disabled: true });
ok('an admin can now disable a member (settings.team.edit, was Super Admin only)', r.statusCode === 200 && !!login('member').banned_until);
r = await users('crew', 'disable', { email: email('member2'), disabled: true });
ok('crew cannot disable anyone', r.statusCode === 403 && !login('member2').banned_until);
fresh({ orphanOwner: false });
r = await users('owner', 'disable', { email: email('owner'), disabled: true });
ok('the only Super Admin cannot disable their own login', r.statusCode === 403 && !login('owner').banned_until);
fresh({ secondOwner: 'banned', orphanOwner: false });
r = await users('owner', 'disable', { email: email('owner'), disabled: true });
ok('  ...nor when the only other Super Admin is disabled', r.statusCode === 403 && !login('owner').banned_until);
fresh();
r = await users('owner', 'disable', { email: email('owner'), disabled: true });
ok('  ...but may while another Super Admin login can sign in (their row stays, still a Super Admin)',
  r.statusCode === 200 && !!login('owner').banned_until);

// CS-329 (owner 2026-09-24): ending an Admin's access is admin+ by ROLE — a manager or crew
// holding settings.team.edit cannot DISABLE an Admin's login; an admin or owner can.
fresh();
r = await users('mgr', 'disable', { email: email('admin'), disabled: true });
ok('🔴 a manager cannot disable an ADMIN login (admin+ by role) — no ban happens', r.statusCode === 403 && !login('admin').banned_until);
fresh({ overrides: [{ userId: idOf('crew'), grants: ['settings.team.edit'], revokes: [] }] });
r = await users('crew', 'disable', { email: email('admin'), disabled: true });
ok('🔴  ...nor crew granted settings.team.edit (the grant does not lift the role floor)', r.statusCode === 403 && !login('admin').banned_until);
fresh();
r = await users('admin', 'disable', { email: email('admin2'), disabled: true });
ok('an ADMIN can disable another admin', r.statusCode === 200 && !!login('admin2').banned_until);
fresh();
r = await users('owner', 'disable', { email: email('admin'), disabled: true });
ok('the owner can disable an admin', r.statusCode === 200 && !!login('admin').banned_until);

// ── remove (POST /users/delete) ───────────────────────────────────────────────────────
fresh();
r = await users('mgr', 'delete', { email: email('member') });
ok('a MANAGER can remove a member owed nothing (settings.team.edit)', r.statusCode === 200 && !login('member'));
r = await users('mgr', 'delete', { email: email('mgr') });
ok('a manager cannot remove themselves', r.statusCode === 403 && !!login('mgr'));
r = await users('mgr', 'delete', { email: email('owner') });
ok('a manager cannot remove a Super Admin', r.statusCode === 403 && !!login('owner'));
r = await users('crew', 'delete', { email: email('member2') });
ok('crew cannot remove anyone', r.statusCode === 403 && !!login('member2'));
r = await users('mgr', 'delete', { email: email('paid') });
ok('a member with a pay line this period is NOT removed (409, owed pay)', r.statusCode === 409 && !!login('paid') && /owed pay/.test(errOf(r)));
r = await users('owner', 'delete', { email: email('paid') });
ok('  ...not by a Super Admin either (the app\'s rule, every role)', r.statusCode === 409 && !!login('paid'));
r = await users('owner', 'delete', { email: email('hours') });
ok('a member with clocked hours since the cutoff is not removed', r.statusCode === 409 && !!login('hours') && /clocked hours/.test(errOf(r)));
r = await users('owner', 'delete', { email: email('salary') });
ok('an active salaried member is not removed', r.statusCode === 409 && !!login('salary') && /salary/.test(errOf(r)));
r = await users('owner', 'delete', { email: email('owner') });
ok('the last Super Admin cannot remove themselves', r.statusCode === 403 && !!login('owner'));
fresh();
fake.failTable('time_entries');
r = await users('owner', 'delete', { email: email('member') });
ok('an unreadable time ledger REFUSES the removal (a check that cannot run never passes)', r.statusCode === 409 && !!login('member'));
fresh();
r = await users('admin', 'delete', { email: email('member') });
ok('an admin can now remove a member (settings.team.edit, was Super Admin only)', r.statusCode === 200 && !login('member'));

// CS-329 (owner 2026-09-24): removing an Admin's login is admin+ by ROLE too — a manager or
// crew holding settings.team.edit cannot delete an Admin's login; an admin or owner can.
fresh();
r = await users('mgr', 'delete', { email: email('admin') });
ok('🔴 a manager cannot remove an ADMIN login (admin+ by role) — nothing is deleted', r.statusCode === 403 && !!login('admin'));
fresh({ overrides: [{ userId: idOf('crew'), grants: ['settings.team.edit'], revokes: [] }] });
r = await users('crew', 'delete', { email: email('admin') });
ok('🔴  ...nor crew granted settings.team.edit', r.statusCode === 403 && !!login('admin'));
fresh();
r = await users('admin', 'delete', { email: email('admin2') });
ok('an ADMIN can remove another admin (owed nothing)', r.statusCode === 200 && !login('admin2'));
fresh();
r = await users('owner', 'delete', { email: email('admin') });
ok('the owner can remove an admin', r.statusCode === 200 && !login('admin'));

// ── reset links + the orphan list ─────────────────────────────────────────────────────
fresh();
r = await users('mgr', 'reset-link', { email: email('member') });
// No Resend key offline, so an allowed reset reaches the send and fails there — past the gate.
ok('a MANAGER may send a reset link (staff.resetPassword): it reaches the send', r.statusCode !== 403 && /Email is not configured/.test(errOf(r)));
r = await users('mgr', 'reset-link', { email: email('owner') });
ok("a manager cannot reset a Super Admin's password", r.statusCode === 403);
r = await users('admin', 'reset-link', { email: email('member') });
ok('an admin still may (never tightened)', r.statusCode !== 403 && /Email is not configured/.test(errOf(r)));
r = await users('crew', 'reset-link', { email: email('member') });
ok('crew may not', r.statusCode === 403);
r = await users('mgr', 'orphans');
ok('a MANAGER sees the logins with no team record (settings.team.edit)', r.statusCode === 200 && (r.body?.orphans || []).some((o) => o.email === email('orphanowner')));
r = await users('crew', 'orphans');
ok('crew does not', r.statusCode === 403);

// ── the ROSTER half: the org_state guard through the real route ───────────────────────
fresh();
const drop = (k) => (s) => { s.users = s.users.filter((u) => u.id !== idOf(k)); };
r = await save('mgr', drop('member'));
ok('roster: a manager removes a member owed nothing (200)', r.statusCode === 200);
fresh();
r = await save('mgr', drop('paid'));
ok('roster: removing a member with a pay line this period is refused (403 + violations)',
  r.statusCode === 403 && (r.body?.violations || []).includes('remove a team member who may still be owed pay'));
fresh();
r = await save('owner', drop('paid'));
ok('roster: ...by a Super Admin too', r.statusCode === 403);
fresh();
r = await save('owner', drop('hours'));
ok('roster: clocked hours since the cutoff refuse it (the time ledger, not the blob)', r.statusCode === 403);
fresh();
fake.failTable('time_entries');
r = await save('owner', drop('member'));
ok('roster: an unreadable ledger refuses (403 with violations, never a 500 the client would bypass)',
  r.statusCode === 403 && (r.body?.violations || []).some((v) => /couldn't be checked/.test(v)));
fresh();
r = await save('owner', drop('owner'));
ok('roster: the last Super Admin row cannot be removed', r.statusCode === 403 && (r.body?.violations || []).includes('leave the team without a Super Admin'));
fresh();
r = await save('admin', (s) => { s.users.push({ id: 'u_new20', role: 'manager', status: 'active', name: 'n', email: 'new20@cs.test' }); });
ok('roster: an admin cannot add a manager row (more than they hold)', r.statusCode === 403);
fresh();
r = await save('admin', (s) => { s.users.push({ id: 'u_new21', role: 'crew', status: 'active', name: 'n', email: 'new21@cs.test' }); });
ok('roster: an admin still adds a crew row', r.statusCode === 200);
fresh({ overrides: [{ userId: idOf('admin'), grants: ['staff.assignRoles'], revokes: [] }] });
r = await save('admin', (s) => { s.users.find((u) => u.id === idOf('member')).role = 'manager'; });
ok('roster: an admin granted staff.assignRoles cannot make someone a manager', r.statusCode === 403);
fresh();
r = await save('mgr', (s) => { s.users.find((u) => u.id === idOf('member')).role = 'manager'; });
ok('roster: a manager can make someone a manager', r.statusCode === 200);

// ── a Team › Profile save end to end: the login half, then the roster half ────────────
// The app changes the login FIRST and saves the roster after; if the second is refused
// once the first landed, the claim and the roster disagree (adversarial review, 2026-09-23).
fresh();
r = await users('mgr', 'claims', { email: email('member'), role: 'admin', orgUserId: idOf('member') });
let rr = await save('mgr', (s) => { s.users.find((u) => u.id === idOf('member')).role = 'admin'; });
ok('a manager re-roling crew → admin: the claim AND the roster save land, and agree',
  r.statusCode === 200 && rr.statusCode === 200 && login('member').app_metadata.role === 'admin'
  && fake.db.orgState.state.users.find((u) => u.id === idOf('member')).role === 'admin');
const teamApi = await import('../src/lib/teamApi.js').catch(() => ({}));
ok('applyLoginChanges exists (lib/teamApi: the order TeamDetail saves in)', typeof teamApi.applyLoginChanges === 'function');
if (typeof teamApi.applyLoginChanges === 'function') {
  // The order: status (ban / unban) first, then the role claim; the status is put back if
  // the role is refused. Its undo is always allowed; a role can't always be given back.
  const run = async (change, fail = {}) => {
    const calls = [];
    const out = await teamApi.applyLoginChanges({ email: 'x@cs.test', orgUserId: 'u_x', ...change }, {
      setDisabled: async (_e, disabled) => { calls.push(`status:${disabled}`); if (fail.status && calls.length === 1) throw new Error('refused'); },
      syncClaims: async (_e, role) => { calls.push(`role:${role}`); if (fail.role) throw new Error('refused'); },
    });
    return { out, calls: calls.join(' ') };
  };
  const both = { role: { from: 'crew', to: 'admin' }, status: { from: 'active', to: 'disabled' } };
  let t = await run(both);
  ok('applyLoginChanges: status first, then role; both land → null', t.out === null && t.calls === 'status:true role:admin');
  t = await run(both, { role: true });
  ok('  ...role refused → the status is put back, nothing left changed', t.out?.step === 'role' && t.calls === 'status:true role:admin status:false');
  t = await run(both, { status: true });
  ok('  ...status refused → the role is never tried', t.out?.step === 'status' && t.calls === 'status:true');
  t = await run({ role: { from: 'crew', to: 'admin' }, status: { from: 'active', to: 'active' } });
  ok('  ...a role-only change touches only the role', t.out === null && t.calls === 'role:admin');
  t = await run({ role: { from: 'crew', to: 'crew' }, status: { from: 'active', to: 'active' } });
  ok('  ...nothing changed, nothing called', t.out === null && t.calls === '');
  const viaRoute = (k) => ({
    setDisabled: async (em, disabled) => { const x = await users(k, 'disable', { email: em, disabled }); if (x.statusCode !== 200) throw new Error(errOf(x)); },
    syncClaims: async (em, role, orgUserId) => { const x = await users(k, 'claims', { email: em, role, orgUserId }); if (x.statusCode !== 200) throw new Error(errOf(x)); },
  });
  const assignRoles = [{ userId: idOf('admin'), grants: ['staff.assignRoles'], revokes: [] }];
  fresh({ overrides: assignRoles });
  let out = await teamApi.applyLoginChanges({ email: email('member'), orgUserId: idOf('member'), role: { from: 'crew', to: 'manager' }, status: { from: 'active', to: 'disabled' } }, viaRoute('admin'));
  ok('real routes: a role the caller may not give, saved with a disable → refused, the ban put back',
    out?.step === 'role' && !login('member').banned_until && login('member').app_metadata.role === 'crew');
  fresh({ overrides: assignRoles });
  out = await teamApi.applyLoginChanges({ email: email('mgr'), orgUserId: idOf('mgr'), role: { from: 'manager', to: 'crew' }, status: { from: 'active', to: 'disabled' } }, viaRoute('admin'));
  rr = await save('admin', (s) => { const u = s.users.find((x) => x.id === idOf('mgr')); u.role = 'crew'; u.status = 'disabled'; });
  ok('real routes + roster: an admin granted staff.assignRoles demoting a manager with a disable: all three land and agree',
    out === null && rr.statusCode === 200 && login('mgr').app_metadata.role === 'crew' && !!login('mgr').banned_until
    && fake.db.orgState.state.users.find((u) => u.id === idOf('mgr')).role === 'crew');
}

// ── a save from an out-of-date tab: 409 (adopt + replay), never a 403 that drops it ───
// The field guard ran before the version check, so everything changed since the tab
// loaded read as the tab's own edit: a member added since read as one it "removes", and
// with the pay rule that was a 403, which makes the client DROP its pending batch.
async function saveStale(k, tabState, baseVersion, mutate) {
  const next = JSON.parse(JSON.stringify(tabState));
  mutate(next);
  const req = { method: 'POST', headers: { authorization: `Bearer tok_${k}` }, body: { state: next, baseVersion, build: 0, tab: 'tab_stale' } };
  const res = mockRes();
  await orgStateRoute(req, res);
  return res;
}
for (const k of ['owner', 'admin', 'mgr']) {
  fresh();
  const tab = JSON.parse(JSON.stringify(fake.db.orgState.state));
  const tabVersion = fake.db.orgState.version;
  fake.db.orgState.state.users.push({ id: idOf('late'), role: 'crew', status: 'active', name: 'late', email: email('late') });
  fake.db.orgState.version += 1;
  fake.db.timeEntries.push(punch('late', new Date(NOW.getTime() - 600e3).toISOString()));
  r = await saveStale(k, tab, tabVersion, (s) => { s.company.name = 'Clean Space LLC'; });
  ok(`a stale ${k} save (a member added since, who has clocked in) is a 409 conflict, not a 403`,
    r.statusCode === 409 && r.body?.conflict === true && fake.db.orgState.state.company.name === 'Clean Space');
}
fresh();
{
  const tab = JSON.parse(JSON.stringify(fake.db.orgState.state));
  const tabVersion = fake.db.orgState.version;
  fake.db.orgState.state.users = fake.db.orgState.state.users.filter((u) => u.id !== idOf('mgrnoid'));
  fake.db.orgState.version += 1;
  r = await saveStale('admin', tab, tabVersion, (s) => { s.company.name = 'Clean Space LLC'; });
  ok('a stale admin save still holding a manager row removed since is a 409, not a 403', r.statusCode === 409);
}
fresh();
// CS-002: a crew self-promotion is now DROPPED by the crew MERGE (200, role stays crew — see
// test-crew-merge-route.mjs), no longer 403. The "a CURRENT save is still judged in full" point
// is an OFFICE-path property, so contrast the stale 409s above with an admin's own forbidden
// change (self-promotion to Super Admin), which the guard judges and refuses on a current base.
r = await save('admin', (s) => { s.users.find((u) => u.id === idOf('admin')).role = 'owner'; });
ok('  ...while a CURRENT save is still judged in full (an admin self-promoting to Super Admin: 403)', r.statusCode === 403);

// ── the pay cutoff + the org zone, through the routes ─────────────────────────────────
// The window is the pay run's own: any punch on or after the start of the previous pay
// period, in company.timezone (the server has no ambient zone).
{
  const cut = Date.parse(payPeriodRange('biweekly', -1, NOW, TZ).fromIso);
  const iso = (ms) => new Date(ms).toISOString();
  fresh({ punches: [punch('member', iso(cut - 60e3))] });
  r = await users('owner', 'delete', { email: email('member') });
  ok('a punch a minute BEFORE the cutoff (settled pay) does not block removal', r.statusCode === 200 && !login('member'));
  fresh({ punches: [punch('member', iso(cut + 60e3))] });
  r = await users('owner', 'delete', { email: email('member') });
  ok('a punch a minute AFTER the cutoff blocks it', r.statusCode === 409 && !!login('member'));
  const KIR = 'Pacific/Kiritimati'; // UTC+14: local midnight 21 hours before Los Angeles'
  const cutKir = Date.parse(payPeriodRange('biweekly', -1, NOW, KIR).fromIso);
  const between = iso(Math.round((cut + cutKir) / 2));
  const inKir = Date.parse(between) >= cutKir;
  const inLa = Date.parse(between) >= cut;
  ok('fixture: the two zones put the cutoff at different instants, with the punch between them', inKir !== inLa);
  for (const [zone, inside] of [[KIR, inKir], [TZ, inLa]]) {
    fresh({ tz: zone, punches: [punch('member', between)] });
    r = await users('owner', 'delete', { email: email('member') });
    ok(`the cutoff is taken in the ORG zone (${zone}): the login route ${inside ? 'refuses' : 'allows'} the removal`,
      inside ? r.statusCode === 409 : r.statusCode === 200);
    fresh({ tz: zone, punches: [punch('member', between)] });
    r = await save('owner', drop('member'));
    ok(`  ...and so does the roster guard (${zone})`, inside ? r.statusCode === 403 : r.statusCode === 200);
  }
}

// ── offline, really ───────────────────────────────────────────────────────────────────
ok('no request left the machine', strays.length === 0);

console.warn = quiet.warn;
console.error = quiet.error;
await fake.close();
console.log(`\nteam logins: ${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (strays.length) console.log(`  stray requests: ${strays.join(', ')}`);
process.exit(fails.length ? 1 : 0);
