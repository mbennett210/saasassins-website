// A member the org_state WRITE PATH moves into a no-access status gets their Supabase LOGIN
// banned too — however the status was set, a RAW org_state save that bypasses the Team UI
// included. The belt to S87's route-level suspenders: S87 ends a disabled member's ROUTE
// authority (403 account-disabled), but their un-banned login can still hit Supabase
// directly (open read RLS + the storage buckets that admit any authenticated user, e.g.
// marketing-attachments). Only the GoTrue login ban stops that, and until now only the Team
// UI's disable route set it — a crafted client saving org_state directly skipped it.
//
// Drives the REAL api/state/org-state.js handler through the REAL supabase-js client against
// a loopback fake of GoTrue + PostgREST (scripts/fake-supabase-server.mjs), which records the
// admin ban call and turns ban_duration into banned_until. Nothing leaves 127.0.0.1: a fetch
// guard refuses every other host and the Resend key is removed.
//
//   node app/scripts/test-org-state-login-ban.mjs
//
// PRE-FIX (before the org-state.js post-commit sync): a raw save flipping a member to
// `disabled` commits (200) but their login is never banned — every 🔴 B-check below fails.
import { randomUUID } from 'node:crypto';
import { startFakeSupabase } from './fake-supabase-server.mjs';
// loginBanSync + the handler are imported DYNAMICALLY below, AFTER env is set: several
// server modules (orgState.js CLEANSPACE_ORG_ID, crewAssignments.js) capture env at
// module-load, so importing them before SUPABASE_URL / CLEANSPACE_ORG_ID exist binds the
// wrong org and every read/write misses. Static-importing here would reintroduce that.

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── offline rig: env first (the clients build on first use), then the handler ───────────
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
const { loginBanTransitions, syncLoginBansFromState } = await import('../api/_lib/loginBanSync.js');

// ── the world: a small roster; the actor's token → its login → its claim (role) ─────────
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
// applied — exactly what a crafted client that skips the Team UI's disable route would send.
async function save(k, mutate) {
  const committed = fake.db.orgState;
  const next = JSON.parse(JSON.stringify(committed.state));
  mutate(next.users);
  const req = { method: 'POST', headers: { authorization: `Bearer tok_${k}` }, body: { state: next, baseVersion: committed.version, build: 0, tab: 'tab_test' } };
  const res = mockRes();
  await orgStateRoute(req, res);
  return res;
}
const setStatus = (users, k, status) => { for (const u of users) if (u.id === idOf(k)) u.status = status; };
const setRole = (users, k, role) => { for (const u of users) if (u.id === idOf(k)) u.role = role; };
const login = (k) => fake.db.authUsers.find((u) => u.email === email(k));
const isBanned = (k) => !!login(k)?.banned_until;
const committedStatus = (k) => fake.db.orgState.state.users.find((u) => u.id === idOf(k))?.status;
const putsFor = (k) => { const id = login(k)?.id; return fake.requests.filter((r) => r.method === 'PUT' && r.path === `/auth/v1/admin/users/${id}`); };
const fresh = (opts) => fake.reset(world(opts));

try {
  // ── A. loginBanTransitions, pure ──────────────────────────────────────────────────────
  const row = (id, status, extra = {}) => ({ id, role: 'crew', status, email: `${id}@cs.test`, ...extra });
  const t = (prev, next) => loginBanTransitions(prev, next);
  ok('A1 active → disabled is a ban', t([row('a', 'active')], [row('a', 'disabled')]).toBan.map((m) => m.id).join() === 'a');
  ok('A2 disabled → active is an un-ban', t([row('a', 'disabled')], [row('a', 'active')]).toUnban.map((m) => m.id).join() === 'a');
  ok('A3 active → active is neither', (() => { const r = t([row('a', 'active')], [row('a', 'active')]); return !r.toBan.length && !r.toUnban.length; })());
  ok('A4 disabled → disabled is neither (no double-ban trigger)', (() => { const r = t([row('a', 'disabled')], [row('a', 'disabled')]); return !r.toBan.length && !r.toUnban.length; })());
  ok('A5 "inactive" (a revoked invite) ends access → a ban', t([row('a', 'active')], [row('a', 'inactive')]).toBan.length === 1);
  ok('A6 active → "invited" keeps access → neither', (() => { const r = t([row('a', 'active')], [row('a', 'invited')]); return !r.toBan.length && !r.toUnban.length; })());
  ok('A7 a crafted mis-cased "Disabled " still bans (hasNoAccess owns the allowlist)', t([row('a', 'active')], [row('a', 'Disabled ')]).toBan.length === 1);
  ok('A8 a NEW row added as disabled is a ban; added as active is not', t([], [row('a', 'disabled'), row('b', 'active')]).toBan.map((m) => m.id).join() === 'a');
  ok('A9 a REMOVED member (only in prev) is NOT ours (the login-delete route deletes it)', (() => { const r = t([row('a', 'disabled')], []); return !r.toBan.length && !r.toUnban.length; })());
  ok('A10 a row with no email is skipped (nothing to find)', t([row('a', 'active', { email: '' })], [row('a', 'disabled', { email: '' })]).toBan.length === 0);
  ok('A11 the target carries its email (trimmed) and role', (() => { const m = t([row('a', 'active', { role: 'admin', email: ' A@cs.test ' })], [row('a', 'disabled', { role: 'admin', email: ' A@cs.test ' })]).toBan[0]; return m?.email === 'A@cs.test' && m?.role === 'admin'; })());
  ok('A12 a non-array prev/next cannot throw', (() => { try { const r = t(null, undefined); return !r.toBan.length && !r.toUnban.length; } catch { return false; } })());

  // ── B. the real handler: a raw save that flips a member to a no-access status bans them ─
  fresh();
  ok('B0 control: nobody is banned to start', !isBanned('crew') && !isBanned('admin') && !isBanned('owner'));
  let r = await save('owner', (u) => setStatus(u, 'crew', 'disabled'));
  ok('🔴 B1 an owner\'s raw save disabling a crew member COMMITS', r.statusCode === 200 && r.body?.ok === true && fake.db.orgState.version === 8);
  ok('🔴 B2 …and that member\'s Supabase login is now banned (ban_duration → banned_until)', isBanned('crew'));
  ok('🔴 B3 …via a PUT to the admin user (the GoTrue ban call was actually made)', putsFor('crew').length === 1 && putsFor('crew')[0].body?.ban_duration === '876000h');
  ok('B4 the save reports success (no loginBansSynced:false)', r.body?.loginBansSynced === undefined);
  ok('B5 an untouched member is not banned', !isBanned('crew2') && !isBanned('admin'));

  // un-ban on the way back
  r = await save('owner', (u) => setStatus(u, 'crew', 'active'));
  ok('🔴 B6 re-enabling the member un-bans the login (disabled → active)', r.statusCode === 200 && !isBanned('crew') && putsFor('crew').some((p) => p.body?.ban_duration === 'none'));

  // "inactive" (revoked invite) also bans; "invited" does not
  fresh();
  await save('owner', (u) => setStatus(u, 'crew', 'inactive'));
  ok('🔴 B7 a member set to "inactive" (a revoked invite) is banned', isBanned('crew'));
  fresh();
  r = await save('owner', (u) => setStatus(u, 'crew', 'invited'));
  ok('B8 a member set to "invited" (still access) is NOT banned', r.statusCode === 200 && !isBanned('crew') && putsFor('crew').length === 0);

  // an authority change that is NOT a status change touches no login ban
  fresh();
  r = await save('owner', (u) => setRole(u, 'crew2', 'admin'));
  ok('B9 a role change (authority, no status transition) bans nobody', r.statusCode === 200 && !isBanned('crew2') && putsFor('crew2').length === 0);

  // ── C. only a member the actor was ALLOWED to disable is banned (the guard is upstream) ─
  fresh();
  r = await save('mgr', (u) => setStatus(u, 'crew', 'disabled'));
  ok('C1 a manager (settings.team.edit) may disable crew → committed AND login banned', r.statusCode === 200 && isBanned('crew'));
  fresh();
  r = await save('mgr', (u) => setStatus(u, 'admin', 'disabled'));
  ok('🔴 C2 a manager disabling an ADMIN is REFUSED by the guard (S87: admin+), 403', r.statusCode === 403 && Array.isArray(r.body?.violations) && r.body.violations.some((v) => /account status/.test(v)));
  ok('C3 …so the admin\'s login is NOT banned and nothing was written', !isBanned('admin') && committedStatus('admin') === 'active' && putsFor('admin').length === 0);
  fresh();
  r = await save('admin', (u) => setStatus(u, 'crew', 'disabled'));
  ok('C4 an admin may disable crew → login banned', r.statusCode === 200 && isBanned('crew'));

  // ── D. the last active owner is NEVER banned; a non-last owner IS ───────────────────────
  // Integration: a single-owner org — an owner disabling their own row leaves the login active.
  fresh();
  r = await save('owner', (u) => setStatus(u, 'owner', 'disabled'));
  ok('🔴 D1 the LAST active owner is not locked out: disabled in the roster, login left ACTIVE', r.statusCode === 200 && committedStatus('owner') === 'disabled' && !isBanned('owner'));
  ok('D2 …and that skip is not reported as a sync FAILURE', r.body?.loginBansSynced === undefined);
  // With a second owner, disabling one DOES ban it (a deliberate owner action on a co-owner).
  fresh({ secondOwner: true });
  r = await save('owner', (u) => setStatus(u, 'owner2', 'disabled'));
  ok('🔴 D3 a NON-last owner is banned (another active owner login remains)', r.statusCode === 200 && isBanned('owner2'));
  ok('D4 …and the remaining owner is untouched', !isBanned('owner'));

  // Unit: the summary from syncLoginBansFromState, straight against the fake.
  fresh();
  let sum = await syncLoginBansFromState(
    fake.db.orgState.state.users,
    fake.db.orgState.state.users.map((u) => (u.id === idOf('owner') ? { ...u, status: 'disabled' } : u)),
  );
  ok('D5 syncLoginBansFromState reports skippedLastOwner=1 for the sole owner, banned=0', sum.skippedLastOwner === 1 && sum.banned === 0 && !isBanned('owner'));

  // ── E. idempotent + best-effort ────────────────────────────────────────────────────────
  // Team UI already banned the login (banned first, then the org_state save): no double-ban.
  fresh({ loginBanned: ['crew'] });
  r = await save('owner', (u) => setStatus(u, 'crew', 'disabled'));
  ok('🔴 E1 a login already banned (by the Team UI) is not PUT a second time (idempotent)', r.statusCode === 200 && isBanned('crew') && putsFor('crew').length === 0);

  // Best-effort: the GoTrue ban call fails — the save STILL commits, flagged, never lost.
  fresh();
  fake.intercept(({ method, path }) => (method === 'PUT' && /^\/auth\/v1\/admin\/users\//.test(path) ? 'fail' : undefined));
  r = await save('owner', (u) => setStatus(u, 'crew', 'disabled'));
  ok('🔴 E2 a failed ban does NOT fail the committed save (best-effort): 200, version bumped', r.statusCode === 200 && r.body?.ok === true && fake.db.orgState.version === 8);
  ok('🔴 E3 …but the failure is surfaced (loginBansSynced:false), and the member is not banned', r.body?.loginBansSynced === false && !isBanned('crew'));

  // The finder still fails closed the safe way: a status change with NO login at all is a no-op.
  fresh();
  r = await save('owner', (u) => { u.push({ id: 'u_ghost', role: 'crew', status: 'disabled', name: 'ghost', email: 'ghost@cs.test' }); });
  ok('E4 a newly-added disabled member with no login is a clean no-op (no failure flagged)', r.statusCode === 200 && r.body?.loginBansSynced === undefined);
} finally {
  console.warn = quiet.warn;
  console.error = quiet.error;
  globalThis.fetch = realFetch;
  await fake.close();
}

console.log(`\norg_state login-ban sync: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
