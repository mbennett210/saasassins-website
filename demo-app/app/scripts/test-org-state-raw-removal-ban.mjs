// A member the org_state WRITE PATH REMOVES from the roster gets their Supabase LOGIN BANNED
// too — closing the raw-removal login gap (the fast-follow to test-org-state-login-ban.mjs).
//
// THE GAP. The normal Team path DELETES the login on removal (/api/settings/users/delete). But
// a RAW org_state save (a crafted client bypassing the Team UI) can drop a roster row WITHOUT
// that delete, and authz.js keeps a CLAIMED login with no roster row VALID (the orphan-login
// recovery fallback, S87) — so the removed member's login AND its JWT claim persist with FULL
// route authority, worse than the status gap the login-ban tie (S94) closed. The write endpoint
// now BANS (reversible, not delete) the login of any member a committed save removed.
//
// Drives the REAL api/state/org-state.js handler through the REAL supabase-js client against a
// loopback fake of GoTrue + PostgREST (scripts/fake-supabase-server.mjs). Nothing leaves
// 127.0.0.1: a fetch guard refuses every other host and the Resend key is removed.
//
//   node app/scripts/test-org-state-raw-removal-ban.mjs
//
// PRE-FIX (before the org-state.js post-commit banRemovedLogins reconcile): a raw save removing
// a roster row commits (200) but the login is never banned — every 🔴 handler check below fails.
// The pure removedLoginsToBan checks (section A) pass on the helper alone.
import { randomUUID } from 'node:crypto';
import { startFakeSupabase } from './fake-supabase-server.mjs';
// The handler + loginBanSync are imported DYNAMICALLY below, AFTER env is set: several server
// modules capture env at module-load (orgState.js CLEANSPACE_ORG_ID, crewAssignments.js), so a
// static import before SUPABASE_URL / CLEANSPACE_ORG_ID exist would bind the wrong org.

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── offline rig: env first (the clients build on first use), then the handler ───────────────
const ORG = '00000000-0000-0000-0000-0000000ba401';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG,
  CLEANSPACE_ORG_ID: ORG,
});
for (const k of ['RESEND_API_KEY', 'ALERT_WEBHOOK_URL', 'RESEND_AUTH_FROM']) delete process.env[k];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(fake.url)) return Promise.reject(new Error(`offline suite: refused ${u}`));
  return realFetch(input, init);
};
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

const orgStateRoute = (await import('../api/state/org-state.js')).default;
const { removedLoginsToBan, banRemovedLogins } = await import('../api/_lib/loginBanSync.js');

// ── the world: a small roster; the actor's token → its login → its claim (role) ─────────────
const PEOPLE = {
  owner: { role: 'owner' },
  owner2: { role: 'owner' },   // only when secondOwner
  admin: { role: 'admin' },
  mgr: { role: 'manager' },
  crew: { role: 'crew' },
  crew2: { role: 'crew' },
};
const email = (k) => `${k}@cs.test`;
const idOf = (k) => `u_${k}`;
function world({ secondOwner = false, statuses = {}, loginBanned = [] } = {}) {
  const authUsers = [];
  const tokens = {};
  const users = [];
  for (const [k, p] of Object.entries(PEOPLE)) {
    if (k === 'owner2' && !secondOwner) continue;
    users.push({ id: idOf(k), role: p.role, status: statuses[k] || 'active', name: k, email: email(k) });
    const authId = randomUUID();
    authUsers.push({
      id: authId,
      email: email(k),
      app_metadata: { provider: 'email', providers: ['email'], role: p.role, org_user_id: idOf(k), org_id: ORG },
      user_metadata: {},
      banned_until: loginBanned.includes(k) ? '2126-01-01T00:00:00.000Z' : null,
    });
    tokens[`tok_${k}`] = authId;
  }
  return {
    authUsers,
    tokens,
    orgState: {
      organization_id: ORG,
      version: 7,
      protected_fingerprint: null, // forces the guard + prev read on the first save
      min_client_build: null,
      state: {
        users,
        permissions: null,             // schema defaults: a manager holds settings.team.edit
        userPermissionOverrides: [],
        company: { name: 'Clean Space', timezone: 'America/Los_Angeles' },
        sites: [],
        clients: [],
        timeOff: [],
      },
    },
    timeEntries: [],
  };
}

const mockRes = () => ({
  statusCode: 0,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
});
// A raw org_state save (POST /api/state/org-state) as `k`: the committed state with `mutate`
// applied — exactly what a crafted client that skips the Team UI's delete route would send.
async function save(k, mutate) {
  const committed = fake.db.orgState;
  const next = JSON.parse(JSON.stringify(committed.state));
  mutate(next.users);
  const req = { method: 'POST', headers: { authorization: `Bearer tok_${k}` }, body: { state: next, baseVersion: committed.version, build: 0, tab: 'tab_test' } };
  const res = mockRes();
  await orgStateRoute(req, res);
  return res;
}
const removeMember = (users, k) => { const i = users.findIndex((u) => u.id === idOf(k)); if (i >= 0) users.splice(i, 1); };
const setRole = (users, k, role) => { for (const u of users) if (u.id === idOf(k)) u.role = role; };
const login = (mail) => fake.db.authUsers.find((u) => u.email === mail);
const isBanned = (k) => !!login(email(k))?.banned_until;
const inRoster = (k) => fake.db.orgState.state.users.some((u) => u.id === idOf(k));
const putsFor = (mail) => { const id = login(mail)?.id; return fake.requests.filter((r) => r.method === 'PUT' && r.path === `/auth/v1/admin/users/${id}`); };
const fresh = (opts) => fake.reset(world(opts));

try {
  // ── A. removedLoginsToBan, pure ─────────────────────────────────────────────────────────
  const row = (id, extra = {}) => ({ id, role: 'crew', status: 'active', email: `${id}@cs.test`, ...extra });
  const ids = (arr) => arr.map((m) => m.id).sort().join();
  ok('A1 a member only in prev (removed) is returned', ids(removedLoginsToBan([row('a'), row('b')], [row('b')])) === 'a');
  ok('A2 a member in BOTH states is NOT a removal (status change is loginBanTransitions\' job)', removedLoginsToBan([row('a', { status: 'active' })], [row('a', { status: 'disabled' })]).length === 0);
  ok('A3 a member only in NEXT (an add) is not a removal', removedLoginsToBan([row('a')], [row('a'), row('b')]).length === 0);
  ok('A4 an empty next removes everyone rostered', ids(removedLoginsToBan([row('a'), row('b')], [])) === 'a,b');
  ok('A5 the removed target carries its trimmed email and role', (() => { const m = removedLoginsToBan([row('a', { role: 'admin', email: ' A@cs.test ' })], [])[0]; return m?.email === 'A@cs.test' && m?.role === 'admin' && m?.id === 'a'; })());
  ok('A6 a removed row with no email is skipped (nothing to find)', removedLoginsToBan([row('a', { email: '' })], []).length === 0);
  ok('A7 a removed row with no string id is ignored (byId needs one)', removedLoginsToBan([{ role: 'crew', email: 'x@cs.test' }], []).length === 0);
  ok('A8 LAST row wins per id (as byId dedups)', (() => { const m = removedLoginsToBan([row('a', { email: 'first@cs.test' }), row('a', { email: 'last@cs.test' })], [])[0]; return m?.email === 'last@cs.test'; })());
  ok('A9 an ORPHAN-shaped input (only in next, never prev) is never returned', removedLoginsToBan([], [row('orphan')]).length === 0);
  ok('A10 non-array prev/next cannot throw', (() => { try { return removedLoginsToBan(null, undefined).length === 0; } catch { return false; } })());

  // ── B. the real handler: a raw save that REMOVES a member bans their login ───────────────
  fresh();
  ok('B0 control: nobody is banned to start', !isBanned('crew') && !isBanned('admin') && !isBanned('owner'));
  let r = await save('owner', (u) => removeMember(u, 'crew'));
  ok('🔴 B1 an owner\'s raw save REMOVING a crew member COMMITS', r.statusCode === 200 && r.body?.ok === true && fake.db.orgState.version === 8 && !inRoster('crew'));
  ok('🔴 B2 …and that member\'s Supabase login is now banned (the roster row is gone, the login must not be)', isBanned('crew'));
  ok('🔴 B3 …via a PUT to the admin user (the GoTrue ban call was actually made)', putsFor(email('crew')).length === 1 && putsFor(email('crew'))[0].body?.ban_duration === '876000h');
  ok('B4 the save reports success (no removedLoginsSynced:false)', r.body?.removedLoginsSynced === undefined);
  ok('B5 an untouched member is not banned', !isBanned('crew2') && !isBanned('admin') && !isBanned('owner'));

  // A manager (settings.team.edit) may remove crew → committed AND login banned.
  fresh();
  r = await save('mgr', (u) => removeMember(u, 'crew'));
  ok('🔴 B6 a manager removing crew → committed and login banned', r.statusCode === 200 && !inRoster('crew') && isBanned('crew'));

  // A save that changes authority but removes NOBODY touches no removal ban.
  fresh();
  r = await save('owner', (u) => setRole(u, 'crew2', 'admin'));
  ok('B7 a role change (authority, no removal) bans nobody via the removal path', r.statusCode === 200 && !isBanned('crew2') && putsFor(email('crew2')).length === 0);

  // ── C. the ADVERSARIAL case: a genuine ORPHAN login is NEVER banned ──────────────────────
  // An orphan login is an auth login present in NEITHER the prev NOR the next roster (its
  // ADD_USER was lost). It must stay signable-in to self-heal via /api/settings/users/
  // reconcile-self — a REMOVAL (in prev, not in next) is a different thing. A save removing a
  // real member must not touch the orphan.
  fresh();
  const orphanMail = 'orphan@cs.test';
  fake.db.authUsers.push({ id: randomUUID(), email: orphanMail, app_metadata: { provider: 'email', providers: ['email'], role: 'crew', org_user_id: 'u_orphan', org_id: ORG }, user_metadata: {}, banned_until: null });
  ok('C0 the orphan login exists and is on NEITHER roster to start', !!login(orphanMail) && !fake.db.orgState.state.users.some((u) => u.email === orphanMail));
  r = await save('owner', (u) => removeMember(u, 'crew'));
  ok('🔴 C1 removing a DIFFERENT member bans that member…', r.statusCode === 200 && isBanned('crew'));
  ok('🔴 C2 …and the ORPHAN login is left ACTIVE (never in prev → never a removal)', !login(orphanMail).banned_until && putsFor(orphanMail).length === 0);

  // ── D. the last active owner is NEVER banned on removal; a non-last owner IS ─────────────
  // Unit: the sole owner removed → skippedLastOwner, banned=0 (the HANDLER can't reach this —
  // orgStateGuard refuses leaving the team without a Super Admin — so it is proven here).
  fresh();
  let sum = await banRemovedLogins(fake.db.orgState.state.users, fake.db.orgState.state.users.filter((u) => u.id !== idOf('owner')));
  ok('D1 banRemovedLogins on the sole owner reports skippedLastOwner=1, banned=0', sum.skippedLastOwner === 1 && sum.banned === 0 && !isBanned('owner'));
  // Handler: the guard indeed refuses removing the sole owner (belt-and-suspenders).
  fresh();
  r = await save('owner', (u) => removeMember(u, 'owner'));
  ok('D2 the handler refuses removing the SOLE owner (guard: no team without a Super Admin), 403', r.statusCode === 403 && Array.isArray(r.body?.violations) && r.body.violations.some((v) => /Super Admin/.test(v)) && inRoster('owner') && !isBanned('owner'));
  // With a second owner, an owner removing the co-owner DOES ban it (another active owner remains).
  fresh({ secondOwner: true });
  r = await save('owner', (u) => removeMember(u, 'owner2'));
  ok('🔴 D3 a NON-last owner removed is banned (another active owner login remains)', r.statusCode === 200 && !inRoster('owner2') && isBanned('owner2'));
  ok('D4 …and the remaining owner is untouched', !isBanned('owner'));

  // ── E. idempotent + best-effort + clean no-ops ──────────────────────────────────────────
  // Already banned before removal (disabled first, then removed): not PUT a second time.
  fresh({ loginBanned: ['crew'] });
  r = await save('owner', (u) => removeMember(u, 'crew'));
  ok('🔴 E1 a login already banned is not PUT a second time on removal (idempotent)', r.statusCode === 200 && !inRoster('crew') && isBanned('crew') && putsFor(email('crew')).length === 0);

  // Best-effort: the GoTrue ban call fails — the save STILL commits, flagged, never lost.
  fresh();
  fake.intercept(({ method, path }) => (method === 'PUT' && /^\/auth\/v1\/admin\/users\//.test(path) ? 'fail' : undefined));
  r = await save('owner', (u) => removeMember(u, 'crew'));
  ok('🔴 E2 a failed removal-ban does NOT fail the committed save (best-effort): 200, version bumped, row gone', r.statusCode === 200 && r.body?.ok === true && fake.db.orgState.version === 8 && !inRoster('crew'));
  ok('🔴 E3 …but the failure is surfaced (removedLoginsSynced:false), and the member is not banned', r.body?.removedLoginsSynced === false && !isBanned('crew'));

  // A removed roster row with NO login at all is a clean no-op (no failure flagged).
  fresh();
  fake.db.orgState.state.users.push({ id: 'u_ghost', role: 'crew', status: 'active', name: 'ghost', email: 'ghost@cs.test' });
  r = await save('owner', (u) => { const i = u.findIndex((x) => x.id === 'u_ghost'); if (i >= 0) u.splice(i, 1); });
  ok('E4 removing a member with no login is a clean no-op (no removedLoginsSynced:false)', r.statusCode === 200 && r.body?.ok === true && r.body?.removedLoginsSynced === undefined);
} finally {
  console.warn = quiet.warn;
  console.error = quiet.error;
  globalThis.fetch = realFetch;
  await fake.close();
}

console.log(`\norg_state raw-removal login ban: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
