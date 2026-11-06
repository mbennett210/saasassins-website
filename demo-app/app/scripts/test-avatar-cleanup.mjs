// Team PROFILE PHOTOS — the cleanup (UI_RULES §141; also CS-627), through the REAL handlers
// and the REAL supabase-js against the loopback fake (scripts/fake-supabase-server.mjs).
// Offline by construction: a fetch guard refuses every host but the fake.
//
//   A. removing a member (POST /api/settings/users/delete) deletes their photo folder
//      `<org>/_avatars/<id>/` AND their signature image `<org>/_signatures/<id>.*` (CS-627: a
//      removed member's signature was never deleted) — and nobody else's; a Storage failure
//      there never fails the removal (the login is already gone);
//   B. the daily reap (GET /api/cron/reap) sweeps ONLY orphans: a photo folder whose id is off the
//      roster, a version that is not the roster's current one AND is older than a day, a
//      signature whose id is off the roster; it keeps the current photo, a fresh upload whose
//      save is still on its way, and every on-roster signature; it reports its counts; and an
//      empty or unreadable roster sweeps NOTHING.
//
//   node app/scripts/test-avatar-cleanup.mjs
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { startFakeSupabase } from './fake-supabase-server.mjs';
import * as roles from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const ORG = '00000000-0000-0000-0000-0000000c1ea7';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  FORMS_ORG_ID: ORG,
  CLEANSPACE_ORG_ID: ORG,
  APP_BASE_URL: 'http://127.0.0.1',
  CRON_SECRET: 'test-cron-secret',
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL']) delete process.env[k];
const realFetch = globalThis.fetch;
const strays = [];
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(fake.url)) { strays.push(u); return Promise.reject(new Error(`offline suite: refused ${u}`)); }
  return realFetch(input, init);
};
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

const settings = (await import('../api/settings/[...path].js')).default;
const reap = (await import('../api/cron/reap.js')).default;

const BUCKET = 'ops-media';
const V1 = 'a1b2c3d4e5f6g7h8i9j0k1l2m';
const V2 = 'zz00yy11xx22ww33vv44uu55t';
const V3 = 'qq99pp88oo77nn66mm55ll44k';
const OLD = '2026-01-01T00:00:00.000Z';
const avatarKey = (id, v) => `${BUCKET}/${ORG}/_avatars/${id}/${v}.jpg`;
const sigKey = (id, ext) => `${BUCKET}/${ORG}/_signatures/${id}.${ext}`;
const keys = () => [...fake.db.objects.keys()].sort();
const mockRes = () => ({
  statusCode: 0, body: null, headers: {},
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  end() { return this; },
});

// ── the world: an owner, a member to remove, a member who stays ─────────────────────────
function world({ users, objects, authUsers = [] }) {
  return {
    authUsers,
    tokens: Object.fromEntries(authUsers.map((u) => [`tok_${u.email.split('@')[0]}`, u.id])),
    objects,
    orgState: {
      organization_id: ORG,
      version: 5,
      protected_fingerprint: null,
      min_client_build: null,
      state: {
        users,
        permissions: roles.seedPermissions(),
        userPermissionOverrides: [],
        company: { name: 'Clean Space', timezone: 'America/New_York' },
        opsSettings: { payPeriodCadence: 'biweekly' },
        payrollLines: [],
        reimbursements: [],
      },
    },
  };
}
const login = (key, role) => ({ id: randomUUID(), email: `${key}@cs.test`, app_metadata: { provider: 'email', role, org_user_id: `u_${key}`, org_id: ORG }, user_metadata: {}, banned_until: null });

async function removeMember(callerKey, email) {
  const raw = JSON.stringify({ email });
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { authorization: `Bearer tok_${callerKey}`, host: '127.0.0.1' };
  req.query = { subpath: 'users/delete' };
  const res = mockRes();
  await settings(req, res);
  return res;
}

// ── A. removing a member ─────────────────────────────────────────────────────────────────
{
  const owner = login('owner', 'owner');
  const leaver = login('leaver', 'crew');
  const stayer = login('stayer', 'crew');
  const seed = () => world({
    authUsers: [owner, leaver, stayer],
    users: [
      { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: owner.email },
      { id: 'u_leaver', role: 'crew', status: 'disabled', name: 'Leaver', email: leaver.email, photo: { v: V1 } },
      { id: 'u_stayer', role: 'crew', status: 'active', name: 'Stayer', email: stayer.email, photo: { v: V3 } },
    ],
    objects: {
      [avatarKey('u_leaver', V1)]: { bytes: [1] },
      [avatarKey('u_leaver', V2)]: { bytes: [1] },
      [sigKey('u_leaver', 'png')]: { bytes: [1] },
      [avatarKey('u_stayer', V3)]: { bytes: [1] },
      [sigKey('u_stayer', 'jpg')]: { bytes: [1] },
      [`${BUCKET}/${ORG}/st_site1/photo.jpg`]: { bytes: [1] },
    },
  });
  fake.reset(seed());
  const r = await removeMember('owner', leaver.email);
  ok('A1: the removal itself still succeeds (200)', r.statusCode === 200);
  ok('A2: the removed member\'s photo folder is gone', !keys().some((k) => k.includes('/_avatars/u_leaver/')));
  ok('A3: …and their signature image is gone (CS-627)', !keys().includes(sigKey('u_leaver', 'png')));
  ok('A4: …and NOTHING of anyone else\'s was touched', JSON.stringify(keys()) === JSON.stringify([
    avatarKey('u_stayer', V3), sigKey('u_stayer', 'jpg'), `${BUCKET}/${ORG}/st_site1/photo.jpg`,
  ].sort()));
  ok('A5: the login is gone too (the removal ran first)', !fake.db.authUsers.some((u) => u.id === leaver.id));

  // Storage down: the login is already deleted, so the removal must not look failed.
  fake.reset(seed());
  fake.intercept((q) => (q.path.startsWith('/storage/') ? 'fail' : undefined));
  const r2 = await removeMember('owner', leaver.email);
  ok('A6: a Storage failure during the cleanup never fails the removal', r2.statusCode === 200 && !fake.db.authUsers.some((u) => u.id === leaver.id));
}

// ── B. the daily reap ────────────────────────────────────────────────────────────────────
async function runReap() {
  const req = { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} };
  const res = mockRes();
  await reap(req, res);
  return res;
}
const reapObjects = () => ({
  [avatarKey('u_a', V1)]: { bytes: [1], created_at: OLD },            // u_a's current photo: keep
  [avatarKey('u_a', V2)]: { bytes: [1], created_at: OLD },            // an old version: sweep
  [avatarKey('u_a', V3)]: { bytes: [1] },                             // a fresh upload (save on its way): keep
  [avatarKey('u_b', V2)]: { bytes: [1], created_at: OLD },            // u_b has no photo now: sweep the old one
  [avatarKey('u_gone', V1)]: { bytes: [1] },                          // off the roster, however fresh: sweep
  [avatarKey('u_gone2', V1)]: { bytes: [1], created_at: OLD },
  [sigKey('u_a', 'png')]: { bytes: [1], created_at: OLD },            // on the roster: keep
  [sigKey('u_gone', 'gif')]: { bytes: [1], created_at: OLD },         // off the roster: sweep (CS-627's backlog)
  [`${BUCKET}/${ORG}/st_site1/photo.jpg`]: { bytes: [1], created_at: OLD }, // not the sweep's: untouched
});
const roster = [
  { id: 'u_a', role: 'crew', status: 'active', name: 'A', photo: { v: V1 } },
  { id: 'u_b', role: 'crew', status: 'active', name: 'B' },
];
{
  fake.reset({ ...world({ users: roster, objects: reapObjects() }) });
  fake.answer((q) => (q.path === '/rest/v1/rpc/reap_job_deletes' ? { status: 200, body: 0 } : null));
  const r = await runReap();
  ok('B1: the reap still answers 200', r.statusCode === 200 && r.body?.ok === true);
  ok('B2: it keeps exactly the current photo, the fresh upload, the on-roster signature and what is not its own',
    JSON.stringify(keys()) === JSON.stringify([
      avatarKey('u_a', V1), avatarKey('u_a', V3), sigKey('u_a', 'png'), `${BUCKET}/${ORG}/st_site1/photo.jpg`,
    ].sort()));
  const s = r.body?.memberStorage || {};
  ok('B3: it reports what it swept (photo objects, signatures, orphan folders)',
    s.avatarsRemoved === 4 && s.signaturesRemoved === 1 && s.orphanFolders === 2);
}
{
  fake.reset({ ...world({ users: [], objects: reapObjects() }) });
  fake.answer((q) => (q.path === '/rest/v1/rpc/reap_job_deletes' ? { status: 200, body: 0 } : null));
  const before = keys();
  const r = await runReap();
  ok('B4: an EMPTY roster sweeps nothing (never read as "nobody is on the team")',
    r.statusCode === 200 && JSON.stringify(keys()) === JSON.stringify(before) && r.body?.memberStorage?.skipped === 'no-roster');
}
{
  fake.reset({ ...world({ users: roster, objects: reapObjects() }) });
  fake.answer((q) => (q.path === '/rest/v1/rpc/reap_job_deletes' ? { status: 200, body: 0 } : null));
  fake.intercept((q) => (q.table === 'org_state' ? 'fail' : undefined));
  const before = keys();
  const r = await runReap();
  ok('B5: an UNREADABLE roster sweeps nothing, and the reap still answers', r.statusCode === 200 && JSON.stringify(keys()) === JSON.stringify(before));
}
{
  // Bounded: a run removes at most `removals` objects and says there is more.
  const lib = await import('../api/_lib/memberStorage.js').catch(() => ({}));
  if (typeof lib.sweepMemberStorage === 'function') {
    fake.reset({ ...world({ users: roster, objects: reapObjects() }) });
    const out = await lib.sweepMemberStorage({ users: roster, limits: { folderPages: 30, foldersOpened: 200, removals: 2 } });
    const removed = 9 - keys().length;
    ok('B6: a run is bounded (removes at most its cap) and says there is more', removed <= 2 && out.more === true);
  } else {
    ok('B6: api/_lib/memberStorage.js exports sweepMemberStorage', false);
  }
}

console.warn = quiet.warn;
console.error = quiet.error;
globalThis.fetch = realFetch;
await fake.close();
ok('nothing left the machine', strays.length === 0);

console.log(`\ntest-avatar-cleanup: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
