// CREW ON THE WAY (Daniel's Oct 28 call: "why not send a push notification to them, as well? The
// text ability should remain"; his picks 2026-11-03, "A · Row on Home + Account" and "When someone
// can be told"). A cleaner's On my way tells the building's customers in the hub — a line in their
// bell and an alert on the phones they turned alerts on — as well as Matt's approved text. The REAL
// handlers (api/time on-my-way, api/hub) over scripts/fake-supabase.mjs; the push service is caught
// at node's https.request (web-push's own transport), Twilio at fetch.
//   S  the status: the button shows on a clean whose customer someone can be told on — a hub login
//      on the building, or the text — and on nothing else (a cleaner asks only about their own)
//   P  the send: ONE bell row per clean (its id is the clean's: a second tap writes and rings
//      nothing), the alert to the building's active logins' phones only, a dead phone pruned, the
//      push keys unset never stopping the bell, the text kept as built, nobody to tell = 409
//   B  the bell: every login on the building sees "Your crew is on the way to …", opening Crew
//      status; a login on another building does not
//   H  the hub's own sign-up (GET push / POST push / POST push-off): always the caller's own row
//      from the claim, a bad sign-up refused whole, a preview and a staff login never signed up,
//      a login's rate
//   R  the rules (lib/crewOnTheWay.js) and the screens' wiring
// REGRESSION (THE LAW II.3): on 872893a5 the tap only texts (no bell row, no alert), the button
// shows only when texting is on, and the hub has no push branches — S1, P1–P6, B1, H1–H7 fail.
//   node app/scripts/test-crew-on-the-way.mjs
import fs from 'node:fs';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createECDH, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-00000000c0a1';
Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon', FORMS_ORG_ID: ORG, CLEANSPACE_ORG_ID: ORG, APP_PUBLIC_URL: 'https://hub.example.test' });
delete process.env.SYSTEM_SENDER_EMAIL;
const twilioOn = (on) => {
  if (on) Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000' });
  else for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];
};
let texts = [];
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith('https://api.twilio.com/')) { texts.push(new URLSearchParams(String(init?.body || ''))); return { ok: true, status: 201, json: async () => ({ sid: `SM${texts.length}` }) }; }
  throw new Error(`network blocked in this suite (${u})`);
};

// ── the push service, caught where web-push sends (https.request) ──
let pushes = [];
const gone = new Set(); // push paths the "service" answers 410 for
https.request = (opts, onResponse) => {
  const req = new EventEmitter();
  const body = [];
  req.write = (chunk) => { body.push(chunk); return true; };
  req.end = (chunk) => {
    if (chunk) body.push(chunk);
    const path = opts.path || '';
    pushes.push({ host: opts.hostname || opts.host, path, bytes: Buffer.concat(body.map((b) => Buffer.from(b))).length, ttl: opts.headers?.TTL });
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = gone.has(path) ? 410 : 201;
      res.headers = {};
      onResponse(res);
      res.emit('end');
    });
  };
  req.setTimeout = () => req;
  req.destroy = () => {};
  return req;
};
const webpush = (await import('web-push')).default;
const VAPID = webpush.generateVAPIDKeys();
const vapidOn = (on) => {
  if (on) Object.assign(process.env, { VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:ops@example.test' });
  else { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
};
// A real browser's subscription keys (a P-256 point and 16 bytes), so web-push really encrypts.
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const keysFor = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) }; };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const W = await soft('../src/lib/crewOnTheWay.js');
const RS = await soft('../src/lib/reminderScheduler.js');
const CM = await soft('../src/lib/customerMessages.js');
const OTW = await soft('../api/_lib/customerMessages/onTheWay.js');
const timeRoute = await soft('../api/time/[...path].js');
const hubRoute = await soft('../api/hub/[...path].js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const K = CM.MESSAGE_KEY || {};
ok('Z0 the rules load (src/lib/crewOnTheWay.js)', !W.__error && typeof W.onTheWayLine === 'function', W.__error);
ok('Z1 the routes load', typeof timeRoute.default === 'function' && typeof hubRoute.default === 'function', timeRoute.__error || hubRoute.__error);

const MIN = 60e3; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const NOW = Date.now();
const TZ = 'America/New_York';
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const CU1 = '11111111-1111-4111-8111-111111111111'; // Coral Bay, active, two phones (one dead)
const CU2 = '22222222-2222-4222-8222-222222222222'; // Coral Bay, DISABLED, one phone
const CU3 = '33333333-3333-4333-8333-333333333333'; // Harbor Tower only, one phone
const templates = (on = true) => (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: t.key === K.onTheWay ? on : false }));
const state = (o = {}) => ({
  company: { name: 'Way Co', timezone: TZ }, reminderTemplates: templates(),
  users: [{ id: 'u_ana', role: 'crew', status: 'active', name: 'Ana Ruiz', email: 'ana@way.test' }, { id: 'u_bo', role: 'crew', status: 'active', name: 'Bo', email: 'bo@way.test' }, { id: 'u_off', role: 'owner', status: 'active', name: 'Office', email: 'off@way.test' }],
  permissions: seedPermissions(), userPermissionOverrides: [], opsSettings: {}, notifications: [],
  clients: [
    { id: 'cl_a', name: 'Coral Bay HOA', phone: '+15555550100', primaryContactId: 'ct_a' },
    { id: 'cl_b', name: 'Quiet Plaza', phone: null, primaryContactId: null },
    { id: 'cl_x', name: 'Harbor Tower', phone: null, primaryContactId: null },
  ],
  contacts: [{ id: 'ct_a', firstName: 'Pat', email: 'pat@coralbay.test', phone: '+15555550101', companyId: 'cl_a' }],
  sites: [{ id: 'st_a', clientId: 'cl_a', name: 'Coral Bay HOA, Lobby' }],
  services: [], marketingSuppressions: [], ...o,
});
// Always on today's list whatever the hour: started half an hour ago, ending in ninety minutes.
const job = (o = {}) => ({ id: 'j_a', clientId: 'cl_a', siteId: 'st_a', crewIds: ['u_ana'], status: 'upcoming', startAt: new Date(NOW - 30 * MIN).toISOString(), endAt: new Date(NOW + 90 * MIN).toISOString(), ...o });
const SUB = {
  cu1: { endpoint: 'https://push.example.test/wp/cu1-phone', ...keysFor() },
  cu1Dead: { endpoint: 'https://push.example.test/wp/cu1-old-laptop', ...keysFor() },
  cu2: { endpoint: 'https://push.example.test/wp/cu2-phone', ...keysFor() },
  cu3: { endpoint: 'https://push.example.test/wp/cu3-phone', ...keysFor() },
  staff: { endpoint: 'https://push.example.test/wp/staff-phone', ...keysFor() },
};
const pushRow = (cu, s) => ({ id: `cps_${s.endpoint.split('/').pop()}`, organization_id: ORG, client_user_id: cu, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, device_label: 'iPhone', created_at: ago(DAY), last_seen_at: ago(DAY) });
function seed({ st = state(), jobs = [job()], logins = true, phones = true, log = [] } = {}) {
  texts = []; pushes = []; gone.clear();
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 2, state: st }],
      jobs: jobs.map((j) => ({ id: j.id, organization_id: ORG, data: j, start_at: j.startAt, status: j.status, client_id: j.clientId, site_id: j.siteId })),
      customer_messages: log,
      activity_log: [],
      crew_assignments: [],
      client_users: logins ? [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) },
        { id: CU2, organization_id: ORG, name: 'Old Contact', email: 'old@coralbay.test', phone: null, status: 'disabled', auth_user_id: 'auth-c2', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) },
        { id: CU3, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c3', email_prefs: null, updates_seen_at: null, updated_at: ago(30 * DAY) },
      ] : [],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: logins ? [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU2, client_id: 'cl_a', group_id: null },
        { id: 'as3', organization_id: ORG, client_user_id: CU3, client_id: 'cl_x', group_id: null },
      ] : [],
      client_push_subscriptions: phones ? [pushRow(CU1, SUB.cu1), pushRow(CU1, SUB.cu1Dead), pushRow(CU2, SUB.cu2), pushRow(CU3, SUB.cu3)] : [],
      push_subscriptions: [{ id: 'ps1', organization_id: ORG, user_id: 'u_off', endpoint: SUB.staff.endpoint, p256dh: SUB.staff.p256dh, auth: SUB.staff.auth }],
      client_messages: [], client_message_threads: [], client_message_reads: [], problem_reports: [], work_order_messages: [], inspection_records: [],
    },
    logins: {
      'tok-ana': { id: 'auth-ana', email: 'ana@way.test', app_metadata: { role: 'crew', org_user_id: 'u_ana', org_id: ORG } },
      'tok-bo': { id: 'auth-bo', email: 'bo@way.test', app_metadata: { role: 'crew', org_user_id: 'u_bo', org_id: ORG } },
      'tok-off': { id: 'auth-off', email: 'off@way.test', app_metadata: { role: 'owner', org_user_id: 'u_off', org_id: ORG } },
      'tok-c1': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-c3': { id: 'auth-c3', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU3, org_id: ORG } },
    },
  });
  world.uniqueKeys = {
    customer_messages: [(r) => `${r.organization_id}|${r.id}`],
    activity_log: [(r) => r.id],
    client_push_subscriptions: [(r) => `${r.organization_id}|${r.endpoint}`],
  };
}
async function call(handler, { method = 'GET', token, body, sub, query = {}, headers = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  req.query = { ...query, subpath: sub };
  req.body = body ?? {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = { statusCode: 200, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const status = (token, jobIds) => call(timeRoute.default, { token, sub: 'on-my-way', query: { jobIds } });
const tap = (token, jobId = 'j_a') => call(timeRoute.default, { method: 'POST', token, sub: 'on-my-way', body: { jobId } });
const hubGet = (sub, token = 'tok-c1', query = {}, headers = {}) => call(hubRoute.default, { token, sub, query, headers });
const hubPost = (sub, body, token = 'tok-c1', headers = {}) => call(hubRoute.default, { method: 'POST', token, sub, body, headers });
const notices = () => (world.tables.activity_log || []).filter((r) => r.action === 'job.on_the_way');
const phonesOf = (cu) => (world.tables.client_push_subscriptions || []).filter((r) => r.client_user_id === cu).map((r) => r.endpoint);
const pathOf = (endpoint) => new URL(endpoint).pathname;

if (typeof timeRoute.default === 'function' && typeof hubRoute.default === 'function') {
  // ── S. the status ──
  twilioOn(false);
  vapidOn(true);
  seed({ jobs: [job(), job({ id: 'j_b', clientId: 'cl_b', siteId: null }), job({ id: 'j_bo', crewIds: ['u_bo'] })] });
  let s = await status('tok-ana', 'j_a,j_b,j_bo');
  ok('🔴 S1 texting not set up, a customer login on the building: the button shows on that clean', s.status === 200 && JSON.stringify(s.body?.canTell) === '["j_a"]' && s.body?.available === true, s);
  ok('S2 …not on a clean whose customer nobody can be told (no login, no text)', !(s.body?.canTell || []).includes('j_b'), s.body);
  ok('S3 …and a cleaner is answered only about the cleans they are on', !(s.body?.canTell || []).includes('j_bo'), s.body);
  ok('S4 nothing sent yet', JSON.stringify(s.body?.sent) === '[]', s.body);
  seed({ logins: false });
  s = await status('tok-ana', 'j_a');
  ok('S5 no customer login and no texting: the button does not show', s.body?.available === false && (s.body?.canTell || []).length === 0, s);
  twilioOn(true);
  s = await status('tok-ana', 'j_a');
  ok('S6 no customer login, texting on with a number: it shows (the text, as built)', s.body?.available === true && JSON.stringify(s.body?.canTell) === '["j_a"]', s);
  twilioOn(false);

  // ── P. the send ──
  seed();
  let p = await tap('tok-ana');
  const row = notices()[0];
  ok('🔴 P1 the tap tells them: 200 { sent }, ONE bell row for the clean (the activity log, kept 3 years)', p.status === 200 && p.body?.sent === true && notices().length === 1 && row?.client_id === 'cl_a' && row?.entity_id === 'j_a' && row?.actor_role === 'crew', { p, rows: notices() });
  ok('P1 …its id is the clean\'s (on_the_way:<jobId>, a UUID), its arrival kept', row?.id === OTW.onTheWayNoticeId?.('j_a') && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row?.id || '') && Number.isFinite(Date.parse(row?.after?.eta)), row);
  ok('P1 …in the office\'s words: "Ana Ruiz is on the way to Coral Bay HOA."', row?.summary === 'Ana Ruiz is on the way to Coral Bay HOA.', row?.summary);
  const rang = pushes.map((x) => x.path).sort();
  ok('🔴 P2 the alert rings the building\'s ACTIVE logins\' phones only (not the disabled login, not another building\'s, not the staff)', JSON.stringify(rang) === JSON.stringify([pathOf(SUB.cu1.endpoint), pathOf(SUB.cu1Dead.endpoint)].sort()) && pushes.every((x) => x.host === 'push.example.test' && x.bytes > 0), pushes);
  ok('P2 …and no text when texting is not set up', texts.length === 0);
  p = await tap('tok-ana');
  ok('🔴 P3 a second tap writes and rings nothing (once per clean)', p.status === 200 && p.body?.already === true && notices().length === 1 && pushes.length === 2, { p, pushes: pushes.length, rows: notices().length });
  s = await status('tok-ana', 'j_a');
  ok('P4 the status then names the clean as told', JSON.stringify(s.body?.sent) === '["j_a"]', s.body);
  seed();
  gone.add(pathOf(SUB.cu1Dead.endpoint));
  await tap('tok-ana');
  ok('🔴 P5 a phone the push service says is gone (410) is removed from the customer table; the live one, the staff\'s and the others stay', JSON.stringify(phonesOf(CU1)) === JSON.stringify([SUB.cu1.endpoint]) && phonesOf(CU2).length === 1 && phonesOf(CU3).length === 1 && world.tables.push_subscriptions.length === 1, { cu1: phonesOf(CU1), staff: world.tables.push_subscriptions.length });
  vapidOn(false);
  seed();
  p = await tap('tok-ana');
  ok('P6 the push keys unset: the bell still gets its row, nothing rings, still 200', p.status === 200 && notices().length === 1 && pushes.length === 0, { p, pushes: pushes.length });
  vapidOn(true);
  seed({ jobs: [job({ id: 'j_b', clientId: 'cl_b', siteId: null })] });
  p = await tap('tok-ana', 'j_b');
  ok('🔴 P7 nobody to tell (no login, no text): 409 nobody, nothing written', p.status === 409 && p.body?.code === 'nobody' && notices().length === 0 && pushes.length === 0, p);
  twilioOn(true);
  seed();
  p = await tap('tok-ana');
  ok('🔴 P8 texting on too: all three — the bell row, the alert and Matt\'s text to the site contact', p.status === 200 && notices().length === 1 && pushes.length === 2 && texts.length === 1 && texts[0].get('To') === '+15555550101', { p, texts: texts.length, pushes: pushes.length });
  p = await tap('tok-ana');
  ok('P8 …and a second tap repeats none of them', p.body?.already === true && notices().length === 1 && pushes.length === 2 && texts.length === 1, { p, texts: texts.length });
  seed({ logins: false });
  p = await tap('tok-ana');
  ok('P9 no hub login, texting on: the text alone, as built (the bell row is the claim, nobody reads it but the office)', p.status === 200 && texts.length === 1 && pushes.length === 0, { p, texts: texts.length });
  twilioOn(false);
  seed();
  ok('P10 an office login never taps it (403 crew-only)', (await tap('tok-off')).body?.code === 'crew-only' && notices().length === 0);

  // ── B. the bell ──
  seed();
  await tap('tok-ana');
  const b1 = await hubGet('updates');
  const line = (b1.body?.updates || []).find((i) => i.kind === W.ON_THE_WAY_KIND);
  ok('🔴 B1 the building\'s login sees it in the bell: "Your crew is on the way to Coral Bay HOA, arriving around …", opening Crew status', b1.status === 200 && /^Your crew is on the way to Coral Bay HOA, arriving around \d{1,2}:\d{2} [AP]M\.$/.test(line?.text || '') && line?.url === '/hub/b/cl_a/visit' && line?.unread === true, b1.body?.updates);
  const b2 = await hubGet('updates', 'tok-c3');
  ok('B2 …and a login on another building does not', b2.status === 200 && Array.isArray(b2.body?.updates) && !b2.body.updates.some((i) => i.kind === W.ON_THE_WAY_KIND), b2);

  // ── H. the hub's own sign-up ──
  seed({ phones: false });
  const mine = { endpoint: 'https://push.example.test/wp/new-phone', ...keysFor() };
  let h = await hubPost('push', { subscription: { endpoint: mine.endpoint, keys: { p256dh: mine.p256dh, auth: mine.auth } }, deviceLabel: 'iPhone', clientUserId: CU3 });
  ok('🔴 H1 Turn on: 200 { on: true }, ONE row for the caller from the claim (a body\'s login is ignored)', h.status === 200 && h.body?.on === true && JSON.stringify(phonesOf(CU1)) === JSON.stringify([mine.endpoint]) && phonesOf(CU3).length === 0, { h, rows: world.tables.client_push_subscriptions });
  h = await hubPost('push', { subscription: { endpoint: mine.endpoint, keys: { p256dh: mine.p256dh, auth: mine.auth } }, deviceLabel: 'iPhone' });
  ok('H2 the same phone again: still one row (updated in place)', h.status === 200 && world.tables.client_push_subscriptions.length === 1, world.tables.client_push_subscriptions.length);
  ok('H3 GET push names this phone on for its login, off for another', (await hubGet('push', 'tok-c1', { endpoint: mine.endpoint })).body?.on === true && (await hubGet('push', 'tok-c3', { endpoint: mine.endpoint })).body?.on === false);
  h = await hubPost('push-off', { endpoint: mine.endpoint }, 'tok-c3');
  ok('🔴 H4 another login\'s Turn off removes nothing of this one\'s', h.status === 200 && phonesOf(CU1).length === 1, phonesOf(CU1));
  h = await hubPost('push-off', { endpoint: mine.endpoint });
  ok('H4 …its own Turn off removes it', h.status === 200 && h.body?.on === false && phonesOf(CU1).length === 0);
  const bad = [
    { subscription: { endpoint: 'http://push.example.test/x', keys: { p256dh: mine.p256dh, auth: mine.auth } } },
    { subscription: { endpoint: mine.endpoint, keys: { p256dh: mine.p256dh } } },
    { subscription: { endpoint: `https://push.example.test/${'x'.repeat(2100)}`, keys: { p256dh: mine.p256dh, auth: mine.auth } } },
    { subscription: { endpoint: mine.endpoint, keys: { p256dh: '<script>', auth: mine.auth } } },
    {},
  ];
  const refusals = [];
  for (const b of bad) refusals.push(await hubPost('push', b));
  ok('🔴 H5 a bad sign-up is refused whole (http, a missing key, too long, odd characters, nothing): 400 bad-subscription, nothing saved', refusals.every((r) => r.status === 400 && r.body?.code === W.HUB_PUSH_CODES?.bad) && world.tables.client_push_subscriptions.length === 0, refusals.map((r) => r.status));
  const staff = await hubPost('push', { subscription: { endpoint: mine.endpoint, keys: { p256dh: mine.p256dh, auth: mine.auth } } }, 'tok-off');
  const preview = await hubPost('push', { subscription: { endpoint: mine.endpoint, keys: { p256dh: mine.p256dh, auth: mine.auth } } }, 'tok-off', { 'x-hub-preview': 'cl_a' });
  const previewGet = await hubGet('push', 'tok-off', { endpoint: mine.endpoint }, { 'x-hub-preview': 'cl_a' });
  ok('🔴 H6 a staff login is refused, and the office\'s preview never signs a phone up (403 preview-no-alerts; its read answers off)', staff.status === 403 && preview.status === 403 && preview.body?.code === W.HUB_PUSH_CODES?.preview && previewGet.body?.on === false && world.tables.client_push_subscriptions.length === 0, { staff: staff.status, preview, previewGet: previewGet.body });
  ok('H6 …and no login at all: 401', (await call(hubRoute.default, { method: 'POST', sub: 'push', body: {} })).status === 401);
  let limited = null;
  for (let i = 0; i < 40 && !limited; i += 1) { const r = await hubPost('push-off', { endpoint: mine.endpoint }); if (r.status === 429) limited = r; }
  ok('H7 a login hammering the switch is limited (429)', !!limited, limited);
}

// ── R. the rules and the screens' wiring ──
if (!W.__error) {
  ok('R1 the eta is the one the text uses (reminderScheduler re-exports it)', RS.onTheWayEta === W.onTheWayEta);
  ok('R2 the alert: no buttons, its words, Crew status, one per clean', (() => { const a = W.onTheWayAlert({ buildingId: 'cl_a', buildingName: 'Coral Bay HOA', eta: '2026-11-03T19:15:00Z', tz: TZ, jobId: 'j_a' }); return a.title === 'Your crew is on the way' && a.body === 'Coral Bay HOA, arriving around 2:15 PM.' && a.url === '/hub/b/cl_a/visit' && a.tag === 'on-the-way-j_a' && Object.keys(a).length === 4; })());
  ok('R3 someone can be told: a login, or the text', W.canTellCustomer({ hubLogins: 1 }) && W.canTellCustomer({ textReady: true }) && !W.canTellCustomer({}));
  ok('R4 the device: an iPhone outside the Home Screen app gets the steps; blocked and unsupported say so', W.hubAlertsDevice({ ios: true, standalone: false, supported: true }) === 'install' && W.hubAlertsDevice({ ios: true, standalone: true, supported: true }) === 'ready' && W.hubAlertsDevice({ supported: true, permission: 'denied' }) === 'blocked' && W.hubAlertsDevice({ supported: false }) === 'unsupported');
  ok('R5 Home\'s row: where alerts can be had, until turned on or closed', W.hubAlertsRowShows({ device: 'ready' }) && W.hubAlertsRowShows({ device: 'install' }) && !W.hubAlertsRowShows({ device: 'ready', memory: 'on' }) && !W.hubAlertsRowShows({ device: 'ready', memory: 'dismissed' }) && !W.hubAlertsRowShows({ device: 'blocked' }) && !W.hubAlertsRowShows({ device: 'unsupported' }));
}
const read = (rel) => { try { return fs.readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };
const stops = read('../src/pages/crew/CrewStops.jsx');
const home = read('../src/pages/hub/HubHome.jsx');
const account = read('../src/pages/hub/HubAccount.jsx');
const demo = read('../src/lib/hubDemo.js');
const time = read('../src/lib/timeApi.js');
const sw = read('../public/sw.js');
ok('🔴 U1 the cleaner\'s button shows on a stop someone can be told on (canTell), not only when texting is on', /state === STOP\.UPCOMING && job && jobId && onMyWay\?\.canTell\?\.has\(jobId\) &&/.test(stops) && !/onMyWay\?\.available/.test(stops));
ok('U2 Home draws the alerts row over the crew band', /<HubAlertsRow [^>]*\/>\s*<HubCrewBand/.test(home));
ok('U3 Account carries the Phone alerts card after Emails', /\{ key: 'emails', Card: HubEmailsCard \},\s*\{ key: 'alerts', Card: HubAlertsCard \}/.test(account));
ok('U4 Sign out drops this phone\'s sign-up first', /forgetHubAlerts\(viewerKey\); signOut\(\)/.test(account));
ok('U5 the demo answers as the server: its own sign-ups, the bell line from the crew\'s tap', /export async function pushStatus/.test(demo) && /export async function pushOn/.test(demo) && /export async function pushOff/.test(demo) && /readOnTheWayStub\(\)/.test(demo) && /ON_THE_WAY_STUB_KEY/.test(time));
ok('U6 the service worker shows the alert with its title, words and link (the payload\'s four keys)', /data\.title/.test(sw) && /data\.body/.test(sw) && /data\.url/.test(sw) && /tag: data\.tag/.test(sw));

console.log(`test-crew-on-the-way: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
