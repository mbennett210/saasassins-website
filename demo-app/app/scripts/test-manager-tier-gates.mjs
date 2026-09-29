// Manager-tier server gates (2026-09-23). The 4th-tier `manager` defaults to full access in
// lib/roles.js, but six server gates still keyed on owner/admin role lists, so the app
// offered a manager actions the server then refused. Each gate now keeps its old role list
// passing on its own (owner/admin are never tightened) AND follows what the app gates the
// same action on, read from the COMMITTED matrix + per-user overrides:
//   time clock-in / clock-out / replay, the punch bypass  <- time.edit.all (a clock-out of
//                                                            someone else's punch is audited)
//   site-security reveal at any site                      <- ops.revealCodes
//   account-media list / upload at any site               <- the office roles (the app's site
//                                                            visibility is a role rule, not a key)
//   settings webhooks / outbound / deliveries             <- integrations.view to read (an
//                                                            allowlist of columns); manage to
//                                                            change them and to get the secrets
//   hr-files download / upload + delete                   <- hr.view / hr.edit
//   the zero-punch watchdog push                          <- variance.view (it links to /variance)
// Owner decisions 2026-09-23 (HANDOFF). The server reads the committed matrix exactly as the
// app's can() does, and a row can() can't read denies: never a 500, never wider than the app.
//
// It drives the REAL handlers through fake-supabase.mjs: no network, no credentials. A
// manager login is claim-less, exactly as live (claims.js VALID_ROLES has no 'manager'
// yet), so its role and id resolve from the roster by email.
//
//   node scripts/test-manager-tier-gates.mjs
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import webpush from 'web-push';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions, can } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000001';
// Set BEFORE anything under api/ loads (orgState.js and constants.js read them at import).
// The URL is a closed local port and fetch is stubbed: nothing here can reach a network.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.OPS_CODE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.CRON_SECRET = 'cron-test-secret';
// Real-format VAPID keys, so the watchdog's sendToUser reaches its per-user subscription
// read, which is how this suite sees who was paged. There are no subscriptions, so
// nothing is ever sent.
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const { encrypt } = await import('../api/_lib/crypto.js');
const time = (await import('../api/time/[...path].js')).default;
const siteSecurity = (await import('../api/site-security/[...path].js')).default;
const media = (await import('../api/account-media/[...path].js')).default;
const settings = (await import('../api/settings/[...path].js')).default;
const hrFiles = (await import('../api/hr-files/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── the people ──────────────────────────────────────────────────────────────
// Every key a gate here widened to, revoked from (…R) or granted to (crewG) one member.
const WIDENED = ['time.edit.all', 'ops.revealCodes', 'integrations.manage', 'hr.edit', 'variance.view'];
const GRANTED = ['time.edit.all', 'ops.revealCodes', 'integrations.view', 'hr.view', 'variance.view'];
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  adminR: { id: 'u_admin_r', role: 'admin', claim: true },               // every widened key revoked
  adminOff: { id: 'u_admin_off', role: 'admin', claim: true, status: 'disabled' },
  adminGone: { id: 'u_admin_gone', role: 'admin', claim: true, status: 'inactive' },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },                   // claim-less, as live
  mgrR: { id: 'u_mgr_r', role: 'manager', claim: false },                // every widened key revoked
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewG: { id: 'u_crew_g', role: 'crew', claim: true },                  // granted the view keys + more
  crewOn: { id: 'u_crew_on', role: 'crew', claim: true },                // standing crew at st_1
};
const OVERRIDES = [
  { userId: 'u_crew_g', grants: GRANTED, revokes: [] },
  { userId: 'u_mgr_r', grants: [], revokes: WIDENED },
  { userId: 'u_admin_r', grants: [], revokes: WIDENED },
];
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: p.status || 'active', name: k,
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`,
  email: emailOf(k),
  app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));

// ── the world ───────────────────────────────────────────────────────────────
const NOW = Date.now();
const H = 3600e3;
const iso = (ms) => new Date(NOW + ms).toISOString();
const SITE = { id: 'st_1', clientId: 'cl_1', name: 'Acme HQ', lat: 26.1, lng: -80.1, geofenceRadiusM: 150 };
const jobRow = (id, startMs, crewIds) => ({
  organization_id: ORG, id, site_id: 'st_1', status: 'upcoming', start_at: iso(startMs),
  data: { id, siteId: 'st_1', clientId: 'cl_1', crewIds, startAt: iso(startMs), endAt: iso(startMs + 2 * H), status: 'upcoming' },
});
const SILENT_DAY = { time_entries: [], jobs: [jobRow('j_a', -3 * H, []), jobRow('j_b', -4 * H, []), jobRow('j_c', -5 * H, [])] };

let queriesSeen = 0;
function buildWorld({ permissions = seedPermissions(), overrides = OVERRIDES, tables = {} } = {}) {
  queriesSeen += world.log.length;
  const state = {
    users: roster,
    permissions,
    userPermissionOverrides: overrides,
    clients: [{ id: 'cl_1', name: 'Acme', standingCrewIds: [] }],
    sites: [{ ...SITE, security: { doorCodeCipher: encrypt('4321', 'OPS_CODE_ENCRYPTION_KEY') } }],
    opsSettings: { offlineReplayWindowHours: 12 },
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 7 }],
      jobs: [jobRow('j_1', -1 * H, ['u_crew_on'])],
      time_entries: [{
        id: 'te_other', organization_id: ORG, user_id: 'u_crew_on', job_id: 'j_1', site_id: 'st_1',
        clock_in_at: iso(-0.5 * H), clock_out_at: null, status: 'in_progress', edit_history: [],
      }],
      crew_assignments: [
        { organization_id: ORG, user_id: '__synced__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_crew_on', site_id: 'st_1', client_id: 'cl_1', source: 'site' },
      ],
      account_media: [{
        id: 'm_1', organization_id: ORG, site_id: 'st_1', scope: 'cleaning_instruction', kind: 'image',
        mime_type: 'image/jpeg', storage_path: `${ORG}/st_1/abcdef0123456789.jpg`, created_at: iso(-H),
      }],
      // `api_key` / `auth_header` stand in for a credential column added to these tables later:
      // a reader without integrations.manage must not get a column nobody decided to show.
      webhook_endpoints: [
        { id: 'ep_1', organization_id: ORG, name: 'Sheet', slug: 'sheet1', signing_secret: 'whsec_SHEET', purpose: 'financial_snapshot', is_active: true, api_key: 'LEAK_1', created_at: iso(-3 * H) },
        { id: 'ep_2', organization_id: ORG, name: 'Leads', slug: 'leads1', signing_secret: 'whsec_LEAD', bearer_token: 'rlw_LEAD', purpose: 'lead_intake', lead_config: { pipelineId: 'p_1', stage: 'new' }, is_active: true, created_at: iso(-2 * H) },
      ],
      outbound_webhooks: [{ id: 'ob_1', organization_id: ORG, url: 'https://example.test/hook', secret: 'whsec_OUT', auth_header: 'LEAK_2', event_types: [], is_active: true, created_at: iso(-H) }],
      webhook_deliveries: [{ id: 'd_1', webhook_id: 'ep_1', direction: 'inbound', ok: true, status_code: 200, error: null, created_at: iso(-H) }],
      push_subscriptions: [],
      ...tables,
    },
    logins,
  });
}

// ── a request through the real handler ─────────────────────────────────────
// `req` is a readable stream (the settings route reads its raw body) that also carries the
// parsed `body` the other routes read. Console output from the routes is muted.
async function call(handler, { method = 'GET', path, token, body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally {
    Object.assign(console, quiet);
  }
}
const tok = (who) => `tok-${who}`;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`;
// Reads of the permission matrix (the protected-slice projection authz reads).
const matrixReads = () => world.log.filter((q) => q.table === 'org_state' && /permissions:/.test(q.cols)).length;
const paged = () => new Set(world.log.filter((q) => q.table === 'push_subscriptions').map((q) => q.eq.user_id));

async function expectEach(label, whoList, status, run, check) {
  for (const who of whoList) {
    buildWorld();
    const r = await run(who);
    ok(`${label}: ${who} → ${status}`, r.status === status, show(r));
    if (check) check(who, r); // always runs, so a refused call fails its checks too
  }
}

// The requests, each for one caller.
const clockIn = (who) => call(time, { method: 'POST', path: 'clock-in', token: tok(who), body: { jobId: 'j_1', lat: SITE.lat, lng: SITE.lng, accuracyM: 5, clientPunchId: `op_in_${who}` } });
const clockOut = (who) => call(time, { method: 'POST', path: 'clock-out', token: tok(who), body: { entryId: 'te_other' } });
const replayIn = (who) => call(time, { method: 'POST', path: 'replay', token: tok(who), body: { clientPunchId: `op_ri_${who}`, jobId: 'j_1', assertedInAt: iso(-10 * 60e3), inLat: SITE.lat, inLng: SITE.lng, inAccuracyM: 5 } });
const replayOut = (who) => call(time, { method: 'POST', path: 'replay', token: tok(who), body: { clientPunchId: `op_ro_${who}`, entryId: 'te_other', assertedOutAt: iso(-5 * 60e3) } });
const openNow = (who) => call(time, { method: 'GET', path: 'open', token: tok(who) });
const watchdog = () => call(time, { method: 'GET', path: 'watchdog', token: 'cron-test-secret' });
const reveal = (who) => call(siteSecurity, { method: 'POST', path: 'reveal', token: tok(who), body: { siteId: 'st_1', which: 'door' } });
const listMedia = (who) => call(media, { method: 'GET', path: 'list', token: tok(who), query: { siteId: 'st_1' } });
const uploadAt = (siteId) => (who) => call(media, { method: 'POST', path: 'upload-url', token: tok(who), body: { siteId, mimeType: 'image/jpeg', sizeBytes: 1000 } });
const getHooks = (who) => call(settings, { method: 'GET', path: 'webhooks', token: tok(who) });
const getOutbound = (who) => call(settings, { method: 'GET', path: 'outbound', token: tok(who) });
const getDeliveries = (who) => call(settings, { method: 'GET', path: 'deliveries', token: tok(who), query: { webhook: 'ep_1' } });
const createHook = (who) => call(settings, { method: 'POST', path: 'webhooks', token: tok(who), body: { name: 'New', purpose: 'generic' } });
const rotate = (who) => call(settings, { method: 'PATCH', path: 'webhooks/ep_2', token: tok(who), body: { rotate: true } });
const dropOutbound = (who) => call(settings, { method: 'DELETE', path: 'outbound/ob_1', token: tok(who) });
const HR_PATH = `${ORG}/hr/u_crew/abcdefabcdefabcd.pdf`;
const hrUpload = (who) => call(hrFiles, { method: 'POST', path: 'upload-url', token: tok(who), body: { ownerId: 'u_crew', mimeType: 'application/pdf', sizeBytes: 1000 } });
const hrDownload = (who) => call(hrFiles, { method: 'POST', path: 'download-url', token: tok(who), body: { ownerId: 'u_crew', storagePath: HR_PATH } });
const hrDelete = (who) => call(hrFiles, { method: 'POST', path: 'delete', token: tok(who), body: { ownerId: 'u_crew', storagePath: HR_PATH } });

// A reader without integrations.manage: no credential column, no column nobody decided to
// show, but everything the Integrations page renders.
const CREDENTIALS = ['signing_secret', 'bearer_token', 'secret', 'api_key', 'auth_header'];
const leaks = (rows) => (rows || []).flatMap((row) => CREDENTIALS.filter((k) => row[k] != null));

// ═══ 1. time: the punch bypass follows time.edit.all ════════════════════════
await expectEach('clock-in to a clean they are NOT on', ['owner', 'admin', 'adminR', 'mgr', 'crewG'], 200, clockIn,
  (who, r) => ok(`  ${who}'s punch is stamped as their own`, r.body?.entry?.user_id === PEOPLE[who].id, show(r)));
await expectEach('clock-in to a clean they are NOT on', ['crew', 'mgrR'], 403, clockIn);
buildWorld();
{
  const r = await clockIn('crewOn');
  ok('clock-in: assigned crew → 200', r.status === 200, show(r));
  ok('🔴 clock-in: assigned crew costs NO matrix read (the bypass is asked only when needed)', matrixReads() === 0, `read the matrix ${matrixReads()}×`);
  ok('the fake answered this suite\'s queries (no real client in play)', world.log.length > 0, `${world.log.length} queries`);
}
buildWorld();
await clockIn('mgr');
ok('clock-in: a manager\'s bypass reads the matrix at most once', matrixReads() <= 1, `read the matrix ${matrixReads()}×`);

await expectEach("clock-out of SOMEONE ELSE's punch", ['owner', 'admin', 'adminR', 'mgr', 'crewG'], 200, clockOut,
  (who, r) => {
    const last = (r.body?.entry?.edit_history || []).at(-1);
    ok(`  ${who} closed it`, !!r.body?.entry?.clock_out_at, show(r));
    ok(`  🔴 ${who}'s clock-out of another's punch is audited (who, which field)`,
      r.body?.entry?.edited === true && r.body?.entry?.edited_by === PEOPLE[who].id
      && last?.byUserId === PEOPLE[who].id && last?.field === 'clock_out_at' && last?.to === r.body?.entry?.clock_out_at, show(r));
  });
await expectEach("clock-out of someone else's punch", ['crew', 'mgrR'], 403, clockOut);
buildWorld();
{
  const r = await clockOut('crewOn');
  ok('clock-out: your own punch → 200', r.status === 200, show(r));
  ok('🔴 clock-out: your own punch costs NO matrix read', matrixReads() === 0, `read the matrix ${matrixReads()}×`);
  ok('clock-out: your own punch adds no edit history', (r.body?.entry?.edit_history || []).length === 0 && r.body?.entry?.edited !== true, show(r));
}

await expectEach('replayed clock-in to a clean they are NOT on', ['owner', 'admin', 'mgr', 'crewG'], 200, replayIn);
await expectEach('replayed clock-in to a clean they are NOT on', ['crew', 'mgrR'], 403, replayIn);
await expectEach("replayed clock-out of someone else's punch", ['owner', 'mgr', 'crewG'], 200, replayOut);
await expectEach("replayed clock-out of someone else's punch", ['crew', 'mgrR'], 403, replayOut);

// ═══ 2. the zero-punch watchdog pages who can open /variance ═════════════════
buildWorld({ tables: SILENT_DAY });
{
  const r = await watchdog();
  ok('watchdog: a silent day → 200 silent', r.status === 200 && r.body?.silent === true, show(r));
  const got = paged();
  for (const who of ['owner', 'admin', 'adminR', 'mgr', 'crewG']) ok(`watchdog pages ${who}`, got.has(PEOPLE[who].id), `paged: ${[...got].join(', ')}`);
  for (const who of ['crew', 'crewOn', 'mgrR', 'adminOff', 'adminGone']) ok(`watchdog does NOT page ${who}`, !got.has(PEOPLE[who].id), `paged: ${[...got].join(', ')}`);
}

// ═══ 3. site-security reveal follows ops.revealCodes ═════════════════════════
await expectEach('reveal a door code', ['owner', 'admin', 'adminR', 'mgr', 'crewG', 'crewOn'], 200, reveal,
  (who, r) => ok(`  ${who} gets the decrypted code`, r.body?.code === '4321', show(r)));
await expectEach('reveal a door code', ['crew', 'mgrR'], 403, reveal);
// A cleaner reveals a site's codes by being ON a clean there (owner's call 2026-09-23), from a
// day before it starts to a day after it ends, a clean longer than 36 h counting as 36 h
// (src/lib/siteAccess.js, the app's own rule). CREW only: a manager pared off
// ops.revealCodes doesn't get the codes back by being on a clean (the jobs guard lets a
// manager holding schedule.edit put themselves on any crew). These rows stand for jobs the
// SERVER wrote, which is the precondition: Increment 1e revokes browser writes to
// public.jobs, and jobsGuard keeps a cleaner from writing a job naming themselves (checked
// right below: this path is only as safe as that write point).
const jobAt = (id, siteId, startMs, crewIds, status = 'upcoming', data = {}) => {
  const r = jobRow(id, startMs, crewIds);
  return { ...r, site_id: siteId, status, data: { ...r.data, siteId, status, ...data } };
};
const JOB_CASES = [
  ['on a clean there in 2h', [jobAt('j_now', 'st_1', 2 * H, ['u_crew'])], 'crew', 200],
  ['on a clean there that ended 2h ago', [jobAt('j_past', 'st_1', -4 * H, ['u_crew'])], 'crew', 200],
  ['on a clean there in 3 days', [jobAt('j_far', 'st_1', 72 * H, ['u_crew'])], 'crew', 403],
  ['on a clean there that ended 3 days ago', [jobAt('j_old', 'st_1', -74 * H, ['u_crew'])], 'crew', 403],
  ['on a CANCELLED clean there today', [jobAt('j_cx', 'st_1', 2 * H, ['u_crew'], 'cancelled')], 'crew', 403],
  ['on a clean at ANOTHER site today', [jobAt('j_else', 'st_2', 2 * H, ['u_crew'])], 'crew', 403],
  ['not on the clean there today', [jobAt('j_them', 'st_1', 2 * H, ['u_crew_on'])], 'crew', 403],
  ['a manager WITHOUT the key, on a clean there today (crew only)', [jobAt('j_m', 'st_1', 2 * H, ['u_mgr_r'])], 'mgrR', 403],
  // The payload decides, not only the columns the query matched.
  ['on a clean whose payload is at ANOTHER site (its site_id column says this one)',
    [jobAt('j_x', 'st_1', 2 * H, ['u_crew'], 'upcoming', { siteId: 'st_2' })], 'crew', 403],
  ['on a clean whose end is unreadable', [jobAt('j_bad', 'st_1', -1 * H, ['u_crew'], 'upcoming', { endAt: 'later' })], 'crew', 403],
  ['on a clean whose payload is cancelled (its status column is not)',
    [jobAt('j_pc', 'st_1', 2 * H, ['u_crew'], 'upcoming', { status: 'cancelled' })], 'crew', 403],
  // One clean holds the window at most 36 h past its start.
  ['on a clean that started 3 days ago and runs for a week', [jobAt('j_week', 'st_1', -72 * H, ['u_crew'], 'upcoming', { endAt: iso(96 * H) })], 'crew', 403],
  ['on a clean that started 30 h ago and runs 40 h', [jobAt('j_40', 'st_1', -30 * H, ['u_crew'], 'upcoming', { endAt: iso(10 * H) })], 'crew', 200],
  ['on a clean that started 59 h ago and runs 36 h (the earliest start the read asks for)',
    [jobAt('j_59', 'st_1', -59 * H, ['u_crew'], 'upcoming', { endAt: iso(-23 * H) })], 'crew', 200],
  // The read is bounded by the indexed start_at column: a row whose column is outside the
  // window is never read, even with a payload that would open (white-box: pins the bound).
  ['on a clean whose indexed start is 100 h ago (its payload says in 2 h)',
    [{ ...jobAt('j_col', 'st_1', 2 * H, ['u_crew']), start_at: iso(-100 * H) }], 'crew', 403],
];
for (const [label, jobs, who, status] of JOB_CASES) {
  buildWorld({ tables: { jobs } });
  const r = await reveal(who);
  ok(`🔴 reveal by being on a clean (${label}): ${who} → ${status}`, r.status === status && (status !== 200 || r.body?.code === '4321'), show(r));
}
// A site cleaned for years passes PostgREST's row cap (1000 on Supabase). The old read was
// one unpaged query over every job at the site, so the clean that grants access could fall
// past the cap and a cleaner on today's clean was refused. The read now asks only for the
// caller's jobs, within the window, and pages in id order. 1,100 rows no rule ever accepts
// come first: each matches the query's columns (this site, this cleaner, in the window, a
// status column that isn't cancelled) but is cancelled in its payload, which both the old
// and the new rule refuse. So only paging reaches the granting row.
const refusedEverywhere = (n, startMs) => Array.from({ length: n }, (_, i) =>
  jobAt(`j_${String(i).padStart(4, '0')}`, 'st_1', startMs(i), ['u_crew'], 'upcoming', { status: 'cancelled' }));
{
  buildWorld({ tables: { jobs: [...refusedEverywhere(1100, () => 2 * H), jobAt('j_zzzz', 'st_1', 2 * H, ['u_crew'])] } });
  world.maxRows = 1000;
  const r = await reveal('crew');
  ok('🔴 reveal past the row cap: the granting clean is the 1,101st row at the site → 200', r.status === 200 && r.body?.code === '4321', show(r));
  const reads = world.log.filter((q) => q.table === 'jobs');
  ok('  ...read in pages (2 reads of the jobs table)', reads.length === 2, `${reads.length} reads`);
}
{
  // account-media's job path (any clean, any time): the same cap, the same paging.
  buildWorld({ tables: { jobs: [...refusedEverywhere(1100, (i) => -2000 * H + i * H), jobAt('j_zzzz', 'st_1', -3000 * H, ['u_crew'])] } });
  world.maxRows = 1000;
  const r = await listMedia('crew');
  ok("🔴 site photos past the row cap: a cleaner's one clean there is the 1,101st row → 200", r.status === 200 && r.body?.media?.length === 1, show(r));
}
{
  // ...and the read asks only for the caller's jobs: another cleaner's 1,100 cleans there
  // no longer crowd this one's out.
  const theirs = Array.from({ length: 1100 }, (_, i) => jobAt(`j_${String(i).padStart(4, '0')}`, 'st_1', -2000 * H + i * H, ['u_crew_on']));
  buildWorld({ tables: { jobs: [...theirs, jobAt('j_zzzz', 'st_1', -3000 * H, ['u_crew'])] } });
  world.maxRows = 1000;
  const r = await listMedia('crew');
  ok("🔴 site photos: another cleaner's 1,100 cleans at the site don't hide this one's → 200", r.status === 200 && r.body?.media?.length === 1, show(r));
  ok('  ...in one read (only the caller\'s rows come back)', world.log.filter((q) => q.table === 'jobs').length === 1);
}
{
  const { sanitizeJobsDelta } = await import('../api/_lib/jobsGuard.js');
  const forged = sanitizeJobsDelta({ prev: new Map(), changed: [{ id: 'j_forged', siteId: 'st_1', crewIds: ['u_crew'], startAt: iso(H), endAt: iso(2 * H) }], removed: [], role: 'crew' });
  ok('🔴 the write point: jobsGuard drops a cleaner\'s job create (no job naming yourself)', forged.changed.length === 0);
  const stored = { id: 'j_1', siteId: 'st_1', crewIds: ['u_crew_on'], startAt: iso(H), endAt: iso(2 * H) };
  const joined = sanitizeJobsDelta({ prev: new Map([['j_1', stored]]), changed: [{ ...stored, crewIds: ['u_crew_on', 'u_crew'], endAt: iso(900 * H) }], removed: [], role: 'crew' });
  ok('🔴 the write point: jobsGuard undoes a cleaner joining a clean or stretching its window',
    JSON.stringify(joined.changed[0]?.crewIds) === JSON.stringify(['u_crew_on']) && joined.changed[0]?.endAt === stored.endAt);
}
// requireSiteAssignment has no role default: a caller that names nobody lets nobody past by
// role, the owner included (the implicit owner/admin default is what refused managers).
{
  const { requireSiteAssignment } = await import('../api/_lib/authz.js');
  buildWorld();
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const g = await requireSiteAssignment({ headers: { authorization: `Bearer ${tok('owner')}` } }, res, 'st_1', {});
  ok('🔴 requireSiteAssignment with no managerRoles: the owner, not on the site, is refused', g === null && res.statusCode === 403, `got ${res.statusCode} ${JSON.stringify(res.body)}`);
}

// ═══ 4. account-media: the office roles reach every site ═════════════════════
await expectEach("list a site's photos", ['owner', 'admin', 'adminR', 'mgr', 'mgrR', 'crewOn'], 200, listMedia,
  (who, r) => ok(`  ${who} sees the photo`, r.body?.media?.length === 1, show(r)));
await expectEach("list a site's photos (not on its crew)", ['crew', 'crewG'], 403, listMedia);
await expectEach('photo upload URL at a site', ['owner', 'mgr'], 200, uploadAt('st_1'));
await expectEach('photo upload URL at a site', ['crew'], 403, uploadAt('st_1'));
await expectEach('photo upload URL with no site', ['owner', 'admin', 'mgr'], 200, uploadAt(undefined));
await expectEach('photo upload URL with no site', ['crew', 'crewOn'], 403, uploadAt(undefined));

// ═══ 5. settings integrations: view reads without secrets, manage changes ═════
await expectEach('list inbound webhooks, full rows', ['owner', 'mgr'], 200, getHooks,
  (who, r) => ok(`  ${who} gets the signing secret + lead token`, r.body?.endpoints?.[0]?.signing_secret === 'whsec_SHEET' && r.body?.endpoints?.[1]?.bearer_token === 'rlw_LEAD', show(r)));
await expectEach('list inbound webhooks, view-only', ['mgrR', 'crewG'], 200, getHooks,
  (who, r) => {
    const rows = r.body?.endpoints || [];
    ok(`  🔴 ${who} (view only) gets no credential, not even a column added later`, rows.length === 2 && leaks(rows).length === 0, `leaked: ${leaks(rows)}`);
    ok(`  ${who} still gets what the page renders`, rows[0]?.name === 'Sheet' && rows[0]?.purpose === 'financial_snapshot'
      && rows[1]?.slug === 'leads1' && rows[1]?.is_active === true && rows[1]?.lead_config?.pipelineId === 'p_1', show(r));
  });
await expectEach('list inbound webhooks', ['admin', 'adminR', 'crew'], 403, getHooks);
await expectEach('list outbound webhooks, view-only', ['mgrR'], 200, getOutbound,
  (who, r) => {
    const rows = r.body?.outbound || [];
    ok(`  🔴 ${who} (view only) gets no outbound credential`, rows.length === 1 && leaks(rows).length === 0, `leaked: ${leaks(rows)}`);
    ok(`  ${who} still gets the URL + status`, rows[0]?.url === 'https://example.test/hook' && rows[0]?.is_active === true, show(r));
  });
await expectEach('list outbound webhooks, full rows', ['mgr'], 200, getOutbound,
  (who, r) => ok(`  ${who} gets the outbound secret`, r.body?.outbound?.[0]?.secret === 'whsec_OUT', show(r)));
await expectEach('list deliveries', ['mgr', 'mgrR', 'crewG'], 200, getDeliveries);
await expectEach('list deliveries', ['crew', 'admin'], 403, getDeliveries);
await expectEach('create an inbound webhook', ['owner', 'mgr'], 200, createHook);
await expectEach('create an inbound webhook (view only)', ['mgrR', 'crewG', 'admin'], 403, createHook);
await expectEach('rotate a lead token', ['mgr'], 200, rotate, (who, r) => ok(`  ${who} gets the new token`, typeof r.body?.bearer_token === 'string', show(r)));
await expectEach('rotate a lead token (view only)', ['mgrR', 'crewG'], 403, rotate);
await expectEach('delete an outbound webhook', ['mgr'], 200, dropOutbound);
await expectEach('delete an outbound webhook (view only)', ['crewG'], 403, dropOutbound);

// ═══ 6. hr-files: hr.view downloads, hr.edit uploads + deletes ═══════════════
await expectEach('HR file upload URL', ['owner', 'admin', 'adminR', 'mgr'], 200, hrUpload);
await expectEach('HR file upload URL', ['mgrR', 'crewG', 'crew'], 403, hrUpload);
await expectEach('HR file download URL', ['owner', 'admin', 'adminR', 'mgr', 'mgrR', 'crewG'], 200, hrDownload);
await expectEach('HR file download URL', ['crew'], 403, hrDownload);
await expectEach('HR file delete', ['admin', 'mgr'], 200, hrDelete);
await expectEach('HR file delete', ['mgrR', 'crewG', 'crew'], 403, hrDelete);

// ═══ 7. owner/admin are never tightened, whatever the matrix says ════════════
// Every widened key taken off every role in the committed matrix.
const stripped = seedPermissions().map((p) => (
  [...WIDENED, ...GRANTED].includes(p.id) ? { ...p, roles: [] } : p));
async function underStripped(label, who, status, run) {
  buildWorld({ permissions: stripped, tables: label === 'the watchdog page' ? SILENT_DAY : {} });
  const r = await run(who);
  ok(`🔴 never tightened: ${label}: ${who} → ${status} with the key off every role`, r.status === status, show(r));
  return r;
}
for (const who of ['owner', 'admin']) {
  await underStripped('clock-in to a clean they are not on', who, 200, clockIn);
  await underStripped("clock-out of someone else's punch", who, 200, clockOut);
  await underStripped('replayed clock-in to a clean they are not on', who, 200, replayIn);
  await underStripped("replayed clock-out of someone else's punch", who, 200, replayOut);
  await underStripped('reveal a door code', who, 200, reveal);
  await underStripped('HR file upload URL', who, 200, hrUpload);
  await underStripped('HR file download URL', who, 200, hrDownload);
  await underStripped('HR file delete', who, 200, hrDelete);
  await underStripped('the watchdog page', who, 200, watchdog);
  ok(`  🔴 never tightened: the watchdog still pages ${who}`, paged().has(PEOPLE[who].id), `paged: ${[...paged()].join(', ')}`);
}
{
  const r = await underStripped('list inbound webhooks', 'owner', 200, getHooks);
  ok('  the owner still gets the secrets', r.body?.endpoints?.[0]?.signing_secret === 'whsec_SHEET', show(r));
  await underStripped('create an inbound webhook', 'owner', 200, createHook);
}
await underStripped('clock-in to a clean they are not on', 'mgr', 403, clockIn);
await underStripped('list inbound webhooks', 'mgr', 403, getHooks);

// ═══ 8. the server reads the committed matrix exactly as the app's can() does ═══
// Odd committed data (a string where a list belongs, a null row, roles that are null,
// malformed overrides): each gate must decide what the app decides on the same data, a
// row can() can't read (it throws in the app too) must deny, and nothing may answer 500.
const appCan = (who, key, perms, ovs) => {
  try { return can({ id: PEOPLE[who].id, role: PEOPLE[who].role }, key, perms, ovs) === true; } catch { return false; }
};
const roleIn = (who, roles) => roles.includes(PEOPLE[who].role);
const GATES = [
  { name: 'time/open (variance.view)', run: openNow, allow: (w, P, O) => appCan(w, 'variance.view', P, O) },
  { name: 'HR download (owner/admin, or hr.view)', run: hrDownload, allow: (w, P, O) => roleIn(w, ['owner', 'admin']) || appCan(w, 'hr.view', P, O) },
  { name: 'reveal (owner/admin, or ops.revealCodes)', run: reveal, allow: (w, P, O) => roleIn(w, ['owner', 'admin']) || appCan(w, 'ops.revealCodes', P, O) },
  { name: 'clock-in off the crew (owner/admin, or time.edit.all)', run: clockIn, allow: (w, P, O) => roleIn(w, ['owner', 'admin']) || appCan(w, 'time.edit.all', P, O) },
  {
    name: 'list webhooks (owner, or integrations.view)', run: getHooks,
    allow: (w, P, O) => roleIn(w, ['owner']) || appCan(w, 'integrations.view', P, O),
    secrets: (w, P, O) => roleIn(w, ['owner']) || appCan(w, 'integrations.manage', P, O),
  },
];
const seed = seedPermissions();
const reshape = (map) => seed.map((p) => (Object.prototype.hasOwnProperty.call(map, p.id) ? { ...p, roles: map[p.id] } : p));
const ODD_WORLDS = [
  ['roles written as strings', reshape({ 'variance.view': 'owner', 'hr.view': 'owner,admin', 'ops.revealCodes': 'owner', 'time.edit.all': 'owner,manager', 'integrations.view': 'owner manager', 'integrations.manage': 'owner' }), OVERRIDES],
  ['roles that are null', reshape({ 'variance.view': null, 'hr.view': null, 'ops.revealCodes': null, 'time.edit.all': null, 'integrations.view': null, 'integrations.manage': null }), OVERRIDES],
  ['a null row first', [null, ...seed], OVERRIDES],
  ['a malformed row, then a well-formed one that includes crew', [{ id: 'variance.view', roles: null }, ...reshape({ 'variance.view': ['owner', 'admin', 'manager', 'crew'] })], OVERRIDES],
  ['an override whose revokes is a string', seed, [...OVERRIDES, { userId: 'u_mgr', grants: [], revokes: 'variance.view integrations.manage' }]],
  ['an override whose revokes is an object', seed, [...OVERRIDES, { userId: 'u_mgr', grants: [], revokes: { variance: true } }]],
  ['an override whose grants is a string', seed, [...OVERRIDES, { userId: 'u_crew', grants: 'variance.view hr.view', revokes: [] }]],
  ['a null override row first', seed, [null, ...OVERRIDES]],
];
for (const [worldName, P, O] of ODD_WORLDS) {
  for (const gate of GATES) {
    for (const who of ['owner', 'admin', 'mgr', 'crew', 'crewG']) {
      buildWorld({ permissions: P, overrides: O });
      const r = await gate.run(who);
      const want = gate.allow(who, P, O) ? 200 : 403;
      ok(`🔴 as the app reads it (${worldName}): ${gate.name}: ${who} → ${want}`, r.status === want, show(r));
      if (gate.secrets && want === 200) {
        const sent = r.body?.endpoints?.[0]?.signing_secret != null;
        ok(`  secrets (${worldName}): ${who} ${gate.secrets(who, P, O) ? 'gets' : 'does not get'} them`, sent === gate.secrets(who, P, O), show(r));
      }
    }
  }
}
// The same property for the watchdog, whose recipients are read from the whole blob.
for (const [worldName, P, O] of ODD_WORLDS) {
  buildWorld({ permissions: P, overrides: O, tables: SILENT_DAY });
  const r = await watchdog();
  const got = paged();
  const want = Object.keys(PEOPLE).filter((who) => !['disabled', 'inactive'].includes(PEOPLE[who].status)
    && (roleIn(who, ['owner', 'admin']) || appCan(who, 'variance.view', P, O)));
  ok(`🔴 as the app reads it (${worldName}): the watchdog pages exactly ${want.join(', ')}`,
    r.status === 200 && got.size === want.length && want.every((who) => got.has(PEOPLE[who].id)), `${show(r)} · paged ${[...got].join(', ')}`);
}

// ═══ 9. an unreadable matrix fails CLOSED on every new path ══════════════════
// Only the matrix projection fails; the roster read (how a claim-less manager is
// identified) still works, so each gate reaches its matrix question and must refuse.
async function matrixDown(label, who, status, run) {
  buildWorld();
  world.failWhen = (q) => q.table === 'org_state' && /permissions:/.test(q.cols);
  const r = await run(who);
  const why = status === 500 ? r.body?.error === 'Authorization check failed' : true;
  ok(`🔴 matrix unreadable: ${label}: ${who} → ${status}${status === 500 ? ' (Authorization check failed)' : ''}`, r.status === status && why, show(r));
}
await matrixDown('clock-in to a clean they are not on', 'mgr', 403, clockIn);
await matrixDown("clock-out of someone else's punch", 'crewG', 403, clockOut);
await matrixDown('clock-in to their own clean (no matrix needed)', 'crewOn', 200, clockIn);
await matrixDown('reveal a door code (judged on assignment alone)', 'mgr', 403, reveal);
await matrixDown('reveal a door code (judged on assignment alone)', 'crewOn', 200, reveal);
await matrixDown('HR file download URL', 'mgr', 500, hrDownload);
await matrixDown('HR file download URL (role list, no matrix needed)', 'admin', 200, hrDownload);
await matrixDown('list inbound webhooks', 'mgr', 500, getHooks);
await matrixDown('list inbound webhooks (the Super Admin needs no matrix)', 'owner', 200, getHooks);
await matrixDown('time/open (requirePermission)', 'mgr', 500, openNow);
buildWorld({ tables: SILENT_DAY });
world.failWhen = (q) => q.table === 'org_state';
{
  const r = await watchdog();
  ok('🔴 blob unreadable: the watchdog still answers (the page is best-effort) and pages nobody', r.status === 200 && paged().size === 0, `${show(r)} · paged ${paged().size}`);
}

// ═══ 10. the app offers Copy only for a secret the server sent ═══════════════
// Live, a secret is on the row only for someone the server lets manage integrations, so the
// button follows the data (right for a Super Admin whose own column is off, never "undefined"
// when this tab's matrix is stale); the demo stub keeps every secret, so there the permission
// decides.
{
  const src = readFileSync(new URL('../src/components/WebhooksSection.jsx', import.meta.url), 'utf8');
  ok('canCopySecret: a secret must be present, and in stub mode the permission must hold',
    /export function canCopySecret\(secret, canManage\) \{\s*return !!secret && \(canManage \|\| !isStubMode\(\)\);/.test(src));
}
for (const f of ['src/components/WebhooksSection.jsx', 'src/components/LeadWebhooksSection.jsx']) {
  const lines = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n');
  const copiers = lines.map((l) => [l, l.match(/onClick=\{\s*\(\)\s*=>\s*copy\(\s*(\w+\.(?:signing_secret|secret|bearer_token))\b/)]).filter(([, m]) => m);
  ok(`${f}: has a secret/token copier to check`, copiers.length > 0);
  ok(`🔴 ${f}: every secret/token copier renders only when canCopySecret says so, for that same field`,
    copiers.every(([l, m]) => l.includes(`canCopySecret(${m[1]}, canManage)`)),
    copiers.filter(([l, m]) => !l.includes(`canCopySecret(${m[1]}, canManage)`)).map(([l]) => l.trim()).join('\n      '));
}

buildWorld();
ok('the fake answered every request (queries seen across the suite)', queriesSeen > 500, `${queriesSeen} queries`);

console.log(`\nmanager-tier gates: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
