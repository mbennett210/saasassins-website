// "ON MY WAY" (Matt's approved "Crew on the way" text, 2026-10-19): the cleaner's button in the
// Cleaner Hub and its two routes, EP-422 GET / EP-423 POST /api/time/on-my-way — the real handler
// over scripts/fake-supabase.mjs, Twilio captured by a stubbed fetch.
//   W  the words: the clean's start as the arrival time, or a quarter of an hour from now once the
//      start has passed; the template off = none; no phone = none
//   G  the status: with no customer login on the building (this suite seeds none; the hub's side is
//      test-crew-on-the-way.mjs), the button shows only when texting is set up AND the text is on;
//      it names the stops that already told their customer
//   P  the send: a CLEANER only, on a clean they are ON, still upcoming, on today's list; someone to
//      tell (no login and no text = 409 nobody, Crew on the way 2026-11-03); once per clean (a
//      second tap texts nothing); a sample record never; a login's rate
//   U  the screen: the button only on a stop still to do, only where someone can be told, off in
//      the preview
// REGRESSION (THE LAW II.3): on 811e54eb there is no on-my-way route, rule or button — every check
// fails.
//   node app/scripts/test-on-my-way.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ORG = '00000000-0000-0000-0000-00000000a0a1';
Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon', FORMS_ORG_ID: ORG, CLEANSPACE_ORG_ID: ORG });
const twilioOn = (on) => {
  if (on) Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000' });
  else for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];
};
let texts = [];
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith('https://api.twilio.com/')) { texts.push(new URLSearchParams(String(init?.body || ''))); return { ok: true, status: 201, json: async () => ({ sid: `SM${texts.length}` }) }; }
  throw new Error(`network blocked in this suite (${u})`);
};
const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();
const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const RS = await soft('../src/lib/reminderScheduler.js');
const CM = await soft('../src/lib/customerMessages.js');
const route = await soft('../api/time/[...path].js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const K = CM.MESSAGE_KEY || {};
ok('the rule and the route load', typeof RS.onTheWayItem === 'function' && typeof route.default === 'function', RS.__error || route.__error);

const MIN = 60e3; const HOUR = 60 * MIN;
const NOW = Date.now();
const TZ = 'America/New_York';
const templates = (on = true) => (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: t.key === K.onTheWay ? on : false }));
const state = (o = {}) => ({
  company: { name: 'Way Co', timezone: TZ }, reminderTemplates: templates(),
  users: [{ id: 'u_ana', role: 'crew', status: 'active', name: 'Ana', email: 'ana@way.test' }, { id: 'u_bo', role: 'crew', status: 'active', name: 'Bo', email: 'bo@way.test' }, { id: 'u_off', role: 'owner', status: 'active', name: 'Office', email: 'off@way.test' }],
  permissions: seedPermissions(), userPermissionOverrides: [], opsSettings: {},
  clients: [{ id: 'cl_w1x', name: 'Tower One', email: 'tower@corp.test', phone: '+15555550100', primaryContactId: 'ct_w1x' }, { id: 'cl_seed_evergreen', name: 'Sample', phone: '+15555550199', primaryContactId: null }],
  contacts: [{ id: 'ct_w1x', firstName: 'Pat', email: 'pat@corp.test', phone: '+15555550101', companyId: 'cl_w1x' }],
  sites: [{ id: 'st_w1x', clientId: 'cl_w1x', name: 'Tower One, Lobby' }],
  services: [], marketingSuppressions: [], ...o,
});
const job = (o = {}) => ({ id: 'j_w1x', clientId: 'cl_w1x', siteId: 'st_w1x', crewIds: ['u_ana'], status: 'upcoming', startAt: new Date(NOW + 2 * HOUR).toISOString(), endAt: new Date(NOW + 4 * HOUR).toISOString(), ...o });

// ── W. the words ─────────────────────────────────────────────────────────────
if (typeof RS.onTheWayItem === 'function') {
  const r = RS.onTheWayItem(state(), job(), new Date(NOW));
  ok('W1 a clean two hours out: the text, to the contact\'s phone, the arrival = the start', r.item?.recipient === '+15555550101' && r.item.body.includes(RS.fmtCustomerTime(job().startAt, TZ)) && r.item.body.includes('Tower One, Lobby'), r);
  ok('W2 …once per clean (its key)', r.item?.id === RS.messageKey(K.onTheWay, 'j_w1x'));
  const late = RS.onTheWayItem(state(), job({ startAt: new Date(NOW - 20 * MIN).toISOString() }), new Date(NOW));
  const eta = RS.onTheWayEta(job({ startAt: new Date(NOW - 20 * MIN).toISOString() }), NOW);
  ok('W3 past the start: arriving a quarter of an hour from now, on a five-minute mark', Date.parse(eta) - NOW >= 15 * MIN && Date.parse(eta) - NOW < 20 * MIN && new Date(eta).getUTCMinutes() % 5 === 0 && late.item?.body.includes(RS.fmtCustomerTime(eta, TZ)), eta);
  ok('W4 the template off: none', RS.onTheWayItem(state({ reminderTemplates: templates(false) }), job(), new Date(NOW)).refused === 'off');
  ok('W5 no phone anywhere: none', RS.onTheWayItem(state({ contacts: [{ id: 'ct_w1x', firstName: 'Pat' }], clients: [{ ...state().clients[0], phone: null }] }), job(), new Date(NOW)).refused === 'no-phone');
  ok('W6 the words are Matt\'s approved text', /your crew is on the way to Tower One, Lobby and will arrive around .*\. Reply here with any access notes\.$/.test(r.item?.body || ''), r.item?.body);
}

// ── the route ────────────────────────────────────────────────────────────────
// The route's cleans are NOW-relative and always on today's list whatever the hour: started half
// an hour ago, ending in ninety minutes (lib/clockInWindow isOnTodayList: today's, or yesterday's
// still inside its clock-in window).
const today = (o = {}) => job({ startAt: new Date(NOW - 30 * MIN).toISOString(), endAt: new Date(NOW + 90 * MIN).toISOString(), ...o });
function seed({ st = state(), jobs = [today()], log = [] } = {}) {
  texts = [];
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 2, state: st }],
      jobs: jobs.map((j) => ({ id: j.id, organization_id: ORG, data: j, start_at: j.startAt, status: j.status, client_id: j.clientId, site_id: j.siteId })),
      customer_messages: log,
    },
    logins: {
      'tok-ana': { id: 'auth-ana', email: 'ana@way.test', app_metadata: { role: 'crew', org_user_id: 'u_ana', org_id: ORG } },
      'tok-bo': { id: 'auth-bo', email: 'bo@way.test', app_metadata: { role: 'crew', org_user_id: 'u_bo', org_id: ORG } },
      'tok-off': { id: 'auth-off', email: 'off@way.test', app_metadata: { role: 'owner', org_user_id: 'u_off', org_id: ORG } },
    },
  });
  // The activity log's primary key: Crew on the way's bell row is the claim (one per clean).
  world.uniqueKeys = { customer_messages: [(r) => `${r.organization_id}|${r.id}`], activity_log: [(r) => r.id] };
}
async function call({ method = 'GET', token, body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: 'on-my-way' };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const res = { statusCode: 200, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end(b) { resolve({ status: this.statusCode, body: b ?? null }); return this; } };
      Promise.resolve(route.default(req, res)).catch(reject);
    });
  } finally { Object.assign(console, quiet); }
}
const post = (token, jobId = 'j_w1x') => call({ method: 'POST', token, body: { jobId } });
const rows = () => world.tables.customer_messages || [];
if (typeof route.default === 'function') {
  // ── G. the status ──
  twilioOn(false);
  seed();
  let g = await call({ token: 'tok-ana', query: { jobIds: 'j_w1x' } });
  ok('🔴 G1 texting not set up (and no customer login): the button does not show (available false)', g.status === 200 && g.body?.available === false, g);
  twilioOn(true);
  seed({ st: state({ reminderTemplates: templates(false) }) });
  g = await call({ token: 'tok-ana', query: { jobIds: 'j_w1x' } });
  ok('G2 the text switched off in Settings: the button does not show', g.body?.available === false, g);
  seed({ log: [{ organization_id: ORG, id: RS.messageKey?.(K.onTheWay, 'j_w1x'), template_key: K.onTheWay, channel: 'sms', status: 'sent', attempts: 1, sent_at: new Date().toISOString(), keep_until: new Date(NOW + 864e5).toISOString() }] });
  g = await call({ token: 'tok-ana', query: { jobIds: 'j_w1x,j_other' } });
  ok('G3 texting on and the text on: it shows, and names the stop that already told its customer', g.body?.available === true && JSON.stringify(g.body?.sent) === '["j_w1x"]', g);
  ok('G4 a malformed list: 400', (await call({ token: 'tok-ana', query: { jobIds: 'a b' } })).status === 400);

  // ── P. the send ──
  seed();
  let p = await post('tok-ana');
  ok('🔴 P1 the cleaner on the clean taps it: one text to the customer\'s site contact, recorded sent', p.status === 200 && p.body?.sent === true && texts.length === 1 && texts[0].get('To') === '+15555550101' && rows()[0]?.status === 'sent', { p, texts: texts.length, rows: rows() });
  ok('P1 …and the answer carries no number and no words', JSON.stringify(Object.keys(p.body || {})) === '["sent"]', p.body);
  p = await post('tok-ana');
  ok('🔴 P2 a second tap texts nothing (once per clean)', p.status === 200 && p.body?.already === true && texts.length === 1, { p, texts: texts.length });
  seed();
  ok('P3 an office login (even an owner) never sends: 403 crew-only', (await post('tok-off')).body?.code === 'crew-only' && texts.length === 0);
  ok('P4 a cleaner who is not on the clean: 403 not-your-clean', (await post('tok-bo')).body?.code === 'not-your-clean' && texts.length === 0);
  seed({ jobs: [today({ status: 'in_progress' })] });
  ok('P5 a clean already started: 409 not-upcoming', (await post('tok-ana')).body?.code === 'not-upcoming');
  seed({ jobs: [job({ startAt: new Date(NOW + 3 * 864e5).toISOString(), endAt: new Date(NOW + 3 * 864e5 + HOUR).toISOString() })] });
  ok('P6 a clean days away: 409 not-today', (await post('tok-ana')).body?.code === 'not-today');
  twilioOn(false);
  seed();
  ok('P7 texting not set up and no customer login: 409 nobody, nothing recorded', (await post('tok-ana')).body?.code === 'nobody' && rows().length === 0);
  twilioOn(true);
  seed({ st: state({ reminderTemplates: templates(false) }) });
  ok('P8 the text switched off and no customer login: 409 nobody', (await post('tok-ana')).body?.code === 'nobody');
  seed({ st: state({ contacts: [], clients: [{ ...state().clients[0], phone: null, primaryContactId: null }] }) });
  ok('P9 no phone and no customer login: 409 nobody', (await post('tok-ana')).body?.code === 'nobody');
  seed({ jobs: [today({ id: 'j_seed_way', clientId: 'cl_seed_evergreen', siteId: null })] });
  const s = await post('tok-ana', 'j_seed_way');
  ok('🔴 P10 a SAMPLE customer\'s clean: never texted (the send step refuses it)', s.status === 409 && s.body?.code === 'not-sent' && texts.length === 0 && rows()[0]?.status === 'refused', { s, rows: rows() });
  seed();
  let limited = null;
  for (let i = 0; i < 15 && !limited; i += 1) { const r = await post('tok-ana', `j_none${i}`); if (r.status === 429) limited = r; }
  ok('P11 a login hammering it is limited (429)', limited?.body?.code === 'rate-limited', limited);
  twilioOn(false);
}

// ── U. the screen ────────────────────────────────────────────────────────────
const read = (...p) => { try { return fs.readFileSync(path.join(APP, ...p), 'utf8'); } catch { return ''; } };
const stops = read('src', 'pages', 'crew', 'CrewStops.jsx');
ok('U1 the button renders only on a stop still to do, and only where someone can be told', /state === STOP\.UPCOMING && job && jobId && onMyWay\?\.canTell\?\.has\(jobId\) &&/.test(stops));
ok('U2 …off in the owner\'s View-as and offline', /disabled=\{previewing \|\| !online\}/.test(stops));
ok('U3 …its words are catalog lines (the Cleaner Hub is translated)', ['crewStops.onMyWay', 'crewStops.onMyWaySent', 'crewStops.onMyWayDone', 'crewStops.onMyWayFailed'].every((k) => stops.includes(`'${k}'`) && read('src', 'i18n', 'catalog', 'en.js').includes(`'${k}':`)));

console.log(`test-on-my-way: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
