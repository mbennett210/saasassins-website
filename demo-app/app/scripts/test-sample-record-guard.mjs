// NO SAMPLE RECORD CAN BE MESSAGED (Matt's approved messages, 2026-10-19).
//
// Production still holds the seed's 13 customers, their 13 contacts and their 406 cleans, every
// one with an id from seedId() (`<prefix>_seed_<key>`, src/lib/ids.js) and each contact with an
// email at a real-looking company domain. The moment a customer message is switched on, a walker
// finds those records due like any others, and the email goes to a stranger. So ONE guard sits at
// the single send step (api/_lib/customerMessages/send.js sendCustomerMessage) and refuses any
// message whose customer, contact, clean, location or deal is a seed record, before the email or
// text transport is touched.
//
//   A. the mark: every record the seed ships is marked (asked of the seed itself, never a typed
//      list), and no id the app mints (newId) or a database uuid ever is
//   B. the send step: a message about a seed customer, contact, clean or location is refused with
//      no Gmail and no Twilio call, and says so in one log line; a real record still sends
//   C. the real reminders cron, end to end (the real handler, supabase-js against the local fake,
//      a working Google mailbox): the seed with every reminder switched on sends NOTHING; the same
//      book re-keyed to real ids sends
//   D. the cron reaches the transports only through the send step
//
// REGRESSION (THE LAW II.3): on the tree before the guard (811e54eb) A and B fail (there is no mark
// and no send step) and C1 fails — the cron emails the seed's customers.
//
// Offline: the fake answers every Supabase call and a fetch guard refuses any other host.
//   node app/scripts/test-sample-record-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSupabase } from './fake-supabase-server.mjs';
import { loadStore } from './deletion-core.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const ORG = '00000000-0000-0000-0000-0000000f5eed';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG,
  FORMS_ORG_ID: ORG,
  CRON_SECRET: 'cron-secret-test',
  APP_PUBLIC_URL: 'https://app.guard.test',
  INBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  // Texting configured, so a refusal is proved to happen BEFORE Twilio, not because it is off.
  TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'fake-token', TWILIO_FROM_NUMBER: '+15550000000',
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL', 'APP_BASE_URL', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];

// Every outbound request: the fake passes; a Gmail send and a Twilio send are captured and
// answered; anything else is refused and remembered.
const realFetch = globalThis.fetch;
const strays = [];
let gmail = [];
let twilio = [];
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (u.startsWith(fake.url)) return realFetch(input, init);
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) {
    gmail.push(Buffer.from(init?.body || '').toString('utf8'));
    return Promise.resolve(new Response(JSON.stringify({ id: `gm_${gmail.length}`, threadId: 't' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  if (u.startsWith('https://api.twilio.com/')) {
    twilio.push(String(init?.body || ''));
    return Promise.resolve(new Response(JSON.stringify({ sid: `SM${twilio.length}` }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
  }
  strays.push(u);
  return Promise.reject(new Error(`offline suite: refused ${u}`));
};
const logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
const keep = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : x?.message || JSON.stringify(x))).join(' ')); };
console.warn = keep;
console.error = keep;

const ids = await soft('../src/lib/ids.js');
const sendMod = await soft('../api/_lib/customerMessages/send.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const { INITIAL_STATE } = await loadStore();
const isSeedId = typeof ids.isSeedId === 'function' ? ids.isSeedId : () => false;

// ── A. the mark ───────────────────────────────────────────────────────────────
// Asked of the seed itself: every record in the slices a message can be about.
const SLICES = ['clients', 'contacts', 'jobs', 'sites', 'opportunities'];
for (const slice of SLICES) {
  const rows = INITIAL_STATE[slice] || [];
  const unmarked = rows.filter((r) => !isSeedId(r?.id)).map((r) => r?.id);
  ok(`A1 every one of the seed's ${rows.length} ${slice} is marked as a sample record`, rows.length > 0 && unmarked.length === 0, unmarked.slice(0, 3));
}
ok('A2 the mark is derived from seedId itself (no restated literal)', typeof ids.SEED_ID_MARK === 'string' && ids.SEED_ID_MARK === ids.seedId?.('', ''), ids.SEED_ID_MARK);
ok('A3 seedId(prefix, key) is always marked', ['cl', 'ct', 'j', 'st', 'opp', 'u'].every((p) => isSeedId(ids.seedId?.(p, 'x-1'))));
const minted = [];
for (let i = 0; i < 2000; i += 1) minted.push(ids.newId?.(['cl', 'ct', 'j', 'st', 'opp', 'seed'][i % 6]));
ok('A4 no id the app mints (newId, 2,000 of them, a "seed" prefix included) is ever marked', minted.every((id) => typeof id === 'string' && !isSeedId(id)), minted.find(isSeedId));
ok('A5 a database uuid is never marked', !isSeedId('6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'));
ok('A6 a bare mark with no prefix is not a seed id', !isSeedId('_seed_x') && !isSeedId('') && !isSeedId(null));
const seedRecordIn = typeof ids.seedRecordIn === 'function' ? ids.seedRecordIn : () => null;
ok('A7 seedRecordIn finds a seed id among the refs, arrays included', seedRecordIn({ clientId: ids.newId?.('cl'), jobId: [ids.newId?.('j'), 'j_seed_k'] }) === 'j_seed_k');
ok('A8 seedRecordIn answers null for real records and no refs', seedRecordIn({ clientId: ids.newId?.('cl'), contactId: null }) === null && seedRecordIn(null) === null);

// ── fake world: a working Google mailbox ─────────────────────────────────────
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAR = new Date(Date.now() + 3600e3).toISOString();
const MAILBOX = () => ({
  id: uuid(77), organization_id: ORG, email: 'alerts@guard.test', display_name: 'alerts@guard.test', provider: 'google', status: 'active',
  refresh_token_enc: encrypt('refresh-token'), access_token_enc: encrypt('access-token'), access_token_expires_at: FAR,
  owner_user_id: null, workspace_id: null, is_system_sender: true,
});
function world({ state, jobs = [] }) {
  gmail = [];
  twilio = [];
  logs.length = 0;
  __resetSystemSenderCache();
  fake.reset({
    orgState: { organization_id: ORG, version: 3, protected_fingerprint: null, min_client_build: null, state },
    tables: {
      inbox_accounts: [MAILBOX()],
      sent_messages: [],
      customer_messages: [],
      sms_opt_outs: [],   // the send step reads it before every text (2026-10-28)
      jobs: jobs.map((j) => ({ id: j.id, organization_id: ORG, data: j, start_at: j.startAt, status: j.status, client_id: j.clientId, site_id: j.siteId, series_id: j.seriesId ?? null })),
    },
  });
}

// ── B. the send step ──────────────────────────────────────────────────────────
const send = typeof sendMod.sendCustomerMessage === 'function' ? sendMod.sendCustomerMessage : null;
ok('B0 api/_lib/customerMessages/send.js exports sendCustomerMessage', !!send, sendMod.__error);
const REAL_CLIENT = ids.newId?.('cl') || 'cl_real';
const msg = (refs, channel = 'email') => ({ templateKey: 'booking_confirmation', channel, to: channel === 'sms' ? '+15555550123' : 'pat@lasolasmed.example', subject: 'Your cleaning is booked', body: 'Hi Pat', refs });
if (send) {
  world({ state: { company: { name: 'Guard Co', timezone: 'America/New_York' } } });
  for (const [label, refs] of [
    ['a seed customer', { clientId: 'cl_seed_evergreen' }],
    ['a seed contact of a real customer', { clientId: REAL_CLIENT, contactId: 'ct_seed_jamiep' }],
    ['a seed clean of a real customer', { clientId: REAL_CLIENT, jobId: 'j_seed_miss-1' }],
    ['a seed location', { clientId: REAL_CLIENT, siteId: 'st_seed_x' }],
    // The walkthrough confirmation (2026-10-20) is about a deal: a seed deal is refused even with a
    // real customer and contact around it.
    ['a seed deal', { clientId: REAL_CLIENT, contactId: ids.newId?.('ct'), opportunityId: ids.seedId?.('opp', 'aventura') }],
  ]) {
    gmail = []; logs.length = 0;
    const r = await send(msg(refs));
    ok(`🔴 B1 an email about ${label} is refused, nothing reaches Gmail`, r?.ok === false && r?.refused === sendMod.SAMPLE_RECORD_REFUSAL && gmail.length === 0, { r, gmail: gmail.length });
    ok(`B2 …and the refusal is one log line naming the record (${label})`, logs.filter((l) => /sample record/.test(l)).length === 1 && logs.some((l) => l.includes(r?.recordId || '?')), logs);
  }
  twilio = [];
  const rs = await send(msg({ clientId: 'cl_seed_evergreen' }, 'sms'));
  ok('🔴 B3 a text about a seed customer is refused before Twilio (texting IS configured here)', rs?.refused === sendMod.SAMPLE_RECORD_REFUSAL && twilio.length === 0, { rs, twilio: twilio.length });
  gmail = [];
  const rr = await send(msg({ clientId: REAL_CLIENT, contactId: ids.newId?.('ct'), jobId: ids.newId?.('j') }));
  ok('B4 control: an email about real records is sent (one Gmail call)', rr?.ok === true && gmail.length === 1, { rr, gmail: gmail.length });
  twilio = [];
  const rt = await send(msg({ clientId: REAL_CLIENT }, 'sms'));
  ok('B5 control: a text about a real customer reaches Twilio', rt?.ok === true && twilio.length === 1, { rt, twilio: twilio.length });
}

// ── C. the real reminders cron ────────────────────────────────────────────────
const run = await soft('../api/reminders/run.js');
const handler = typeof run.default === 'function' ? run.default : null;
ok('C0 the reminders cron loads', !!handler, run.__error);
async function cron() {
  const out = { statusCode: 0, body: null };
  const res = { status(c) { out.statusCode = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await handler({ method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} }, res);
  return out;
}
// The seed's book with EVERY reminder switched on, and its cleans moved into the booking window:
// booked an hour ago, starting tomorrow (booking confirmation fires on that at any hour).
const HOUR = 3600e3;
const nowMs = Date.now();
const enabled = (INITIAL_STATE.reminderTemplates || []).map((t) => ({ ...t, enabled: true }));
const seedJobs = (INITIAL_STATE.jobs || []).slice(0, 40).map((j, i) => ({
  ...j, status: 'upcoming',
  startAt: new Date(nowMs + (20 + (i % 5)) * HOUR).toISOString(),
  endAt: new Date(nowMs + (22 + (i % 5)) * HOUR).toISOString(),
  createdAt: new Date(nowMs - HOUR).toISOString(),
}));
const seedState = { ...INITIAL_STATE, jobs: [], reminderTemplates: enabled, reminderEvents: [], marketingSuppressions: [] };
if (handler) {
  world({ state: seedState, jobs: seedJobs });
  const r = await cron();
  ok('🔴 C1 the seed with every reminder on: the cron sends NOTHING (no Gmail call)', r.statusCode === 200 && gmail.length === 0, { status: r.statusCode, body: r.body, gmail: gmail.length });
  const log = fake.db.tables.get('customer_messages') || [];
  const refusedRows = log.filter((row) => row.status === 'refused');
  ok('C2 …every one that reached the send step is recorded REFUSED in the sent log (never retried), and none is sent',
    refusedRows.length > 0 && log.every((row) => row.status !== 'sent' && !row.sent_at), log.map((row) => row.status));
  ok('C3 …and the run says how many it refused', Number(r.body?.refused) > 0 && Number(r.body?.refused) === refusedRows.length, r.body);
  gmail = [];
  const again = await cron();
  ok('C3b a second run sends nothing and refuses nothing new (the refusals are settled)', again.statusCode === 200 && gmail.length === 0 && Number(again.body?.refused) === 0, again.body);

  // Control: the same book re-keyed to real ids — the very same cleans and customers send.
  const realId = new Map();
  const re = (id) => { if (!isSeedId(id)) return id; if (!realId.has(id)) realId.set(id, `${id.split('_')[0]}_r${realId.size.toString(36)}x`); return realId.get(id); };
  const realClients = (INITIAL_STATE.clients || []).map((c) => ({ ...c, id: re(c.id), primaryContactId: re(c.primaryContactId) }));
  const realContacts = (INITIAL_STATE.contacts || []).map((c) => ({ ...c, id: re(c.id), companyId: re(c.companyId) }));
  const realSites = (INITIAL_STATE.sites || []).map((s) => ({ ...s, id: re(s.id), clientId: re(s.clientId), siteContactId: re(s.siteContactId) }));
  const realJobs = seedJobs.map((j) => ({ ...j, id: re(j.id), clientId: re(j.clientId), siteId: re(j.siteId), siteContactId: re(j.siteContactId), seriesId: re(j.seriesId) }));
  world({ state: { ...seedState, clients: realClients, contacts: realContacts, sites: realSites }, jobs: realJobs });
  const r2 = await cron();
  ok('C4 control: the same book on real ids sends (the guard, not the walkers, stopped C1)', r2.statusCode === 200 && gmail.length > 0, { status: r2.statusCode, body: r2.body, gmail: gmail.length });
}

// ── D. the cron reaches the transports only through the send step ────────────
const RUN = fs.readFileSync(path.join(APP, 'api', 'reminders', 'run.js'), 'utf8');
ok('D1 api/reminders/run.js imports no transport of its own (sendTransactional / sendSms)', !/\bsendTransactional\b/.test(RUN.replace(/^\s*\/\/.*$/gm, '')) && !/\bsendSms\b/.test(RUN.replace(/^\s*\/\/.*$/gm, '')));
ok('D2 …and sends through sendCustomerMessage', /sendCustomerMessage\(/.test(RUN));

ok('Z offline: no request left this machine', strays.length === 0, strays);
await fake.close();
Object.assign(console, saved);
console.log(`test-sample-record-guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
