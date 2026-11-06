// QR-30 (Matt, 2026-10-16: "Yes, and only the office sees the results, by building") — a visitor's
// thumbs up or down and the office's report, END TO END through the REAL handlers against
// fake-supabase.mjs (no network, no credentials, no live project):
//   POST /api/public/scan/rate (EP-415) · GET /api/qc/reports/visitor-ratings (EP-416)
//
//   R. a vote: one per phone per area per ORG day, changeable that day (the same row, never a
//      second), a new day a new vote; the phone an HMAC; the same refusals and dead-code 404 as the
//      report; the durable limits; no secret, or no table: 503;
//   O. the office's report: by building, % positive, worst first, its areas; 7 / 30 / 90 days in
//      the org's days; the Reports page's key AND an office role — never crew (even granted the
//      key), never a customer login; nothing about a phone in the answer.
//
// REGRESSION (THE LAW II.3): on 90d7ca9e neither route exists (POST is 405; the report is the qc
// route's 404), so every check below reports what it wanted.
//
//   node app/scripts/test-area-ratings-route.mjs
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-000000000078';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
const SECRET = Buffer.alloc(32, 9).toString('base64');
process.env.INBOX_TOKEN_ENCRYPTION_KEY = SECRET;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const ar = await tryImport('../src/lib/areaRatings.js');
const scanLib = await import('../src/lib/areaScan.js');
const dates = await import('../src/lib/dates.js');
const publicHandler = (await import('../api/public/scan/[...path].js')).default;
const qcHandler = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, want !== undefined && JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const show = (r) => `got ${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;

const H = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const TZ = 'America/New_York';
const SITE = 'st_club';
const T = (c) => c.repeat(32);
const TOK = { lobby: T('L'), rest: T('R'), old: T('O'), gone: T('G') };
const CODE = { lobby: 'c0000000-0000-4000-8000-0000000000b1', rest: 'c0000000-0000-4000-8000-0000000000b2' };
const DEVICE = 'dev_rater_0123456789abcdef';
const user = (id, role, name) => ({ id, role, name, status: 'active', email: `${id}@example.test` });

function seed({ ratings = [], overrides = [] } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 2,
        state: {
          company: { name: 'Clean Space', timezone: TZ },
          users: [user('u_owner', 'owner', 'Dana Owner'), user('u_mgr', 'manager', 'Renata Cruz'), user('u_crew', 'crew', 'Tomas Rivera')],
          permissions: seedPermissions(),
          userPermissionOverrides: overrides,
          clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr' }, { id: 'cl_b', name: 'Bayshore', supervisorId: 'u_owner' }],
          sites: [
            { id: SITE, clientId: 'cl_a', name: 'Clubhouse', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }] },
            { id: 'st_b', clientId: 'cl_b', name: 'Main', cleaningAreas: [{ id: 'area_gym', label: 'Gym' }] },
          ],
        },
      }],
      area_scan_codes: [
        { id: CODE.lobby, organization_id: ORG, site_id: SITE, area_id: 'area_lobby', token: TOK.lobby, created_at: iso(NOW - 48 * H), revoked_at: null },
        { id: CODE.rest, organization_id: ORG, site_id: SITE, area_id: 'area_rest', token: TOK.rest, created_at: iso(NOW - 48 * H), revoked_at: null },
        { id: 'c0000000-0000-4000-8000-0000000000b3', organization_id: ORG, site_id: SITE, area_id: 'area_lobby', token: TOK.old, created_at: iso(NOW - 96 * H), revoked_at: iso(NOW - 48 * H) },
        { id: 'c0000000-0000-4000-8000-0000000000b4', organization_id: ORG, site_id: SITE, area_id: 'area_removed', token: TOK.gone, created_at: iso(NOW - 96 * H), revoked_at: null },
      ],
      area_scan_ratings: ratings,
    },
    logins: {
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: 'a0000000-0000-4000-8000-000000000001', org_id: ORG } },
    },
  });
  // ONE vote per (org, location, area, phone, day): the table's unique constraint.
  world.uniqueKeys = { area_scan_ratings: [(r) => [r.organization_id, r.site_id, r.area_id, r.device_hash, r.day].join('|')] };
  __resetRateLimit();
}

async function call(handler, { method = 'GET', path, token, body, query = {}, headers = {} }) {
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  req.query = { ...query, subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 10000);
      const hdrs = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers: hdrs }); };
      const res = {
        statusCode: 200,
        setHeader(k, v) { hdrs[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
let ipSeq = 0;
const rate = (body, { ip = `203.0.113.${(ipSeq += 1) % 250}`, headers = { 'content-type': 'application/json' } } = {}) => call(publicHandler, {
  method: 'POST', path: 'rate', body, headers: { 'x-vercel-forwarded-for': ip, ...headers },
});
const votes = () => world.tables.area_scan_ratings || [];
const RC = ar.AREA_RATING_CODES || {};
const today = dates.dayKey(new Date(NOW), TZ);

// ── R. a vote ───────────────────────────────────────────────────────────────
{
  seed();
  const r = await rate({ token: TOK.lobby, value: 'up', deviceId: DEVICE });
  eq('R1 a thumbs up answers 200 "Thanks!"', [r.status, r.body?.ok, r.body?.vote, r.body?.message], [200, true, 'up', ar.AREA_RATING_THANKS]);
  ok('R1 …never cached', r.status === 200 && r.headers['cache-control'] === 'no-store');
  const v = votes()[0] || {};
  eq('R2 one row: the code, its location, its customer, its area, +1', [votes().length, v.code_id, v.site_id, v.client_id, v.area_id, v.value], [1, CODE.lobby, SITE, 'cl_a', 'area_lobby', 1]);
  eq('R2 …on the ORG\'s day (New York), not the server\'s', v.day, today);
  ok('R2 …the phone as a 43-character HMAC, never the id', /^[A-Za-z0-9_-]{43}$/.test(v.device_hash || '') && !JSON.stringify(votes()).includes(DEVICE), JSON.stringify(v));
  ok('R2 …and a vote never reads the whole shared record (only its locations, customers and zone)', world.log.some((q) => q.table === 'org_state') && world.log.filter((q) => q.table === 'org_state').every((q) => q.cols && q.cols !== '*' && !/^state\b/.test(q.cols)), JSON.stringify(world.log.filter((q) => q.table === 'org_state').map((q) => q.cols)));
  const d = await rate({ token: TOK.lobby, value: 'down', deviceId: DEVICE });
  eq('R3 the same phone, same area, same day: the vote CHANGES', [d.status, d.body?.vote, votes().length, votes()[0]?.value], [200, 'down', 1, -1]);
  const again = await rate({ token: TOK.lobby, value: 'down', deviceId: DEVICE });
  eq('R3 …the same vote again changes nothing', [again.status, votes().length, votes()[0]?.value], [200, 1, -1]);
  const other = await rate({ token: TOK.rest, value: 'up', deviceId: DEVICE });
  eq('R4 another area: its own vote', [other.status, votes().length], [200, 2]);
  const phone2 = await rate({ token: TOK.lobby, value: 'up', deviceId: 'dev_second_phone_000000001' });
  eq('R4 another phone: its own vote', [phone2.status, votes().length], [200, 3]);
  // Yesterday's vote is yesterday's: a new day is a new vote.
  seed({ ratings: [] });
  await rate({ token: TOK.lobby, value: 'up', deviceId: DEVICE });
  if (votes()[0]) votes()[0].day = dates.addDaysKey(today, -1);
  const tomorrow = await rate({ token: TOK.lobby, value: 'down', deviceId: DEVICE });
  eq('R5 the next day the same phone votes anew (a second row), yesterday\'s untouched', [tomorrow.status, votes().length, votes()[0]?.value, votes()[1]?.value, votes()[1]?.day], [200, 2, 1, -1, today]);
}
{
  seed();
  const refusal = async (label, body, wantStatus, wantCode, opts) => {
    const r = await rate(body, opts);
    eq(`${label}: ${wantStatus} ${wantCode}`, [r.status, r.body?.code], [wantStatus, wantCode]);
    ok(`${label}: …in a sentence, no echo`, wantCode !== undefined && r.body?.code === wantCode && typeof r.body?.error === 'string' && !JSON.stringify(r.body).includes('ZZSENT'), show(r));
  };
  await refusal('R6 not JSON', 'value=up', 415, RC.contentType, { headers: { 'content-type': 'text/plain' } });
  await refusal('R6 a body over its cap', { token: TOK.lobby, value: 'up', deviceId: DEVICE }, 413, RC.tooLarge, { headers: { 'content-type': 'application/json', 'content-length': String((ar.AREA_RATING_BODY_MAX_BYTES || 0) + 1) } });
  await refusal('R7 a value that is neither', { token: TOK.lobby, value: 'ZZSENT', deviceId: DEVICE }, 400, RC.value);
  await refusal('R7 no phone id', { token: TOK.lobby, value: 'up' }, 400, RC.device);
  for (const [label, token] of [['malformed', 'nope'], ['unknown', T('U')], ['replaced', TOK.old], ['orphaned', TOK.gone]]) {
    const r = await rate({ token, value: 'up', deviceId: DEVICE });
    eq(`R8 a ${label} code: the SAME 404 as the public page`, [r.status, r.body?.code], [404, scanLib.SCAN_INACTIVE_CODE]);
  }
  eq('R8 …and no vote written for any of them', votes().length, 0);
}
{
  const L = ar.AREA_RATING_LIMITS || {};
  // The code's hour: twenty new votes from other phones already.
  const mk = (i, extra = {}) => ({
    id: `r${i}`, organization_id: ORG, code_id: CODE.lobby, site_id: SITE, client_id: 'cl_a', area_id: 'area_lobby', value: 1,
    device_hash: `${'p'.repeat(40)}${String(i).padStart(3, '0')}`, day: today, created_at: iso(NOW - 10 * 60 * 1000), updated_at: iso(NOW - 10 * 60 * 1000), ...extra,
  });
  seed({ ratings: Array.from({ length: L.perCodePerHour || 0 }, (_, i) => mk(i)) });
  const r = await rate({ token: TOK.lobby, value: 'down', deviceId: DEVICE });
  eq('R9 a code at its hour\'s new votes: 429', [r.status, r.body?.code], [429, RC.limitCode]);
  // A phone's day across areas: seed its own HMAC by voting once, then fill its day.
  seed();
  await rate({ token: TOK.rest, value: 'up', deviceId: DEVICE });
  const hash = votes()[0]?.device_hash;
  world.tables.area_scan_ratings = Array.from({ length: L.perPhonePerDay || 0 }, (_, i) => mk(i, { device_hash: hash, code_id: CODE.rest, area_id: `area_${i}`, created_at: iso(NOW - 2 * H) }));
  const p = await rate({ token: TOK.lobby, value: 'up', deviceId: DEVICE });
  eq('R10 a phone at its day\'s new votes: 429', [p.status, p.body?.code], [429, RC.limitPhone]);
  // …but CHANGING today's vote is never "new".
  world.tables.area_scan_ratings.push(mk(99, { device_hash: hash, code_id: CODE.lobby, area_id: 'area_lobby', value: 1 }));
  const c = await rate({ token: TOK.lobby, value: 'down', deviceId: DEVICE });
  eq('R10 …changing today\'s vote still works at the limit', [c.status, c.body?.vote], [200, 'down']);
}
{
  seed();
  delete process.env.INBOX_TOKEN_ENCRYPTION_KEY;
  const r = await rate({ token: TOK.lobby, value: 'up', deviceId: DEVICE });
  eq('R11 no server secret: 503, in words', [r.status, r.body?.code], [503, RC.unavailable]);
  process.env.INBOX_TOKEN_ENCRYPTION_KEY = SECRET;
  seed();
  world.failWhen = (q) => q.table === 'area_scan_ratings';
  world.failMessage = 'relation "public.area_scan_ratings" does not exist';
  const m = await rate({ token: TOK.lobby, value: 'up', deviceId: DEVICE });
  eq('R12 before the migration (no table): 503', [m.status, m.body?.code], [503, RC.unavailable]);
  ok('R12 …never the provider\'s words', m.body?.code === RC.unavailable && !JSON.stringify(m.body).includes('relation'), show(m));
}

// ── O. the office's report ──────────────────────────────────────────────────
const report = (who, query = {}) => call(qcHandler, { method: 'GET', path: 'reports/visitor-ratings', token: who ? `tok-${who}` : null, query });
{
  const vote = (i, site, area, value, dayAgo, client = null) => ({
    id: `v${i}`, organization_id: ORG, code_id: CODE.lobby, site_id: site, client_id: client, area_id: area, value,
    device_hash: `${'h'.repeat(40)}${String(i).padStart(3, '0')}`, day: dates.addDaysKey(today, -dayAgo), created_at: iso(NOW), updated_at: iso(NOW),
  });
  seed({ ratings: [
    vote(1, SITE, 'area_lobby', 1, 0), vote(2, SITE, 'area_lobby', 1, 1), vote(3, SITE, 'area_rest', -1, 2), vote(4, SITE, 'area_rest', -1, 3),
    vote(5, 'st_b', 'area_gym', 1, 1), vote(6, 'st_b', 'area_gym', -1, 2), vote(7, 'st_b', 'area_gym', 1, 5),
    vote(8, SITE, 'area_lobby', -1, 20), // inside 30 days, outside 7
    vote(9, SITE, 'area_lobby', -1, 40), // outside 30
    { ...vote(10, 'st_other_org', 'area_z', 1, 0), organization_id: '00000000-0000-0000-0000-0000000000ff' },
  ] });
  const r = await report('owner');
  eq('O1 the office reads it: 200, the default 30 days', [r.status, r.body?.days], [200, ar.DEFAULT_RATING_PERIOD]);
  eq('O1 …the org\'s days, today included', [r.body?.fromDay, r.body?.toDay], [dates.addDaysKey(today, -29), today]);
  eq('O2 by building, worst first', (r.body?.buildings || []).map((b) => b.name), ['Coral Bay HOA', 'Bayshore']);
  const cb = (r.body?.buildings || [])[0] || {};
  eq('O2 …Coral Bay: 2 up, 3 down (40 days ago is outside; another org never counts)', [cb.up, cb.down, cb.total, cb.pctPositive], [2, 3, 5, 40]);
  eq('O3 …its areas, worst first', (cb.areas || []).map((a) => [a.label, a.up, a.down, a.pctPositive]), [['Restrooms', 0, 2, 0], ['Lobby', 2, 1, 67]]);
  eq('O4 the totals', [r.body?.totals?.up, r.body?.totals?.down, r.body?.totals?.buildings], [4, 4, 2]);
  ok('O5 nothing about a phone in the answer', (r.body?.buildings || []).length > 0 && !JSON.stringify(r.body || {}).includes('hhhhhhhh') && !/device/i.test(JSON.stringify(r.body || {})), show(r));
  eq('O5 …never cached', r.headers['cache-control'], 'private, no-store');
  const week = await report('mgr', { days: '7' });
  eq('O6 a manager, 7 days: the 20-day-old vote leaves', [week.status, ((week.body?.buildings || [])[0] || {}).down], [200, 2]);
  const bad = await report('owner', { days: '45' });
  eq('O7 a period the report does not offer: 400, saying which', [bad.status, bad.body?.code], [400, 'days']);
  const crew = await report('crew');
  eq('O8 a cleaner: refused', crew.status, 403);
  seed({ overrides: [{ userId: 'u_crew', grants: ['reports.view'], revokes: [] }] });
  const granted = await report('crew');
  eq('O8 …even granted the Reports key: the office only', [granted.status, granted.body?.code], [403, 'office-only']);
  seed({ overrides: [{ userId: 'u_mgr', grants: [], revokes: ['qc.view'] }] });
  const noQc = await report('mgr');
  eq('O8 …and a manager without qc.view: the second gate (a supply manager\'s Reports stays Supply usage alone)', noQc.status, 403);
  const client = await report('client');
  ok('O9 a customer login never reaches it', client.status === 401 || client.status === 403, show(client));
  const nobody = await report(null);
  eq('O9 …nor does nobody', nobody.status, 401);
}
{
  // Before migration 20261017110100 the table is not there, so no vote can exist yet: the report the
  // picker lists answers empty, never an error (the code keeps working on the old database shape).
  // Only a MISSING TABLE reads as empty: any other failure of the read is still an error.
  seed();
  world.failWhen = (q) => q.table === 'area_scan_ratings';
  world.failMessage = 'relation "public.area_scan_ratings" does not exist';
  const pre = await report('owner');
  eq('O10 before the migration (no table): 200 and no votes', [pre.status, pre.body?.totals?.up, pre.body?.totals?.down, (pre.body?.buildings || []).length], [200, 0, 0, 0]);
  ok('O10 …never the provider\'s words', pre.status === 200 && !JSON.stringify(pre.body || {}).includes('relation'), show(pre));
  world.failMessage = 'canceling statement due to statement timeout';
  const down = await report('owner');
  eq('O11 any other failure of the read is still an error, never an empty report', [down.status, down.body?.code], [500, 'qc_server_error']);
  world.failWhen = null;
  world.failMessage = null;
}

console.log(`\ntest-area-ratings-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
