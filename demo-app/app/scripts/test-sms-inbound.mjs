// A CUSTOMER'S TEXT REPLY, AND THE OFFICE'S ANSWER TEXTED BACK (Daniel, 2026-10-28: "Customer
// thread, texted back"). Twilio's Messaging Service posts every incoming text to the app's public
// inbound route, POST /api/sms/inbound (api/sms/[...path].js). The real handlers over
// scripts/fake-supabase.mjs; Twilio and Gmail captured by a stubbed fetch.
//   V  the route: only a request signed by Twilio (X-Twilio-Signature, HMAC-SHA1 of the route's
//      public URL and the sorted form, keyed by TWILIO_AUTH_TOKEN) is read; anything unsigned or
//      wrongly signed (another token, a changed form, the request's own Host) is refused and changes
//      nothing; no auth token configured = nothing is read;
//      the answer is an empty TwiML <Response/>, and carries no secret
//   K  the keywords: STOP (and its seven siblings, any case; or Twilio's OptOutType) records the
//      number as opted out; START / UNSTOP clears it; HELP is Twilio's; none of them is a line;
//      "Stop by at 5" is a message
//   M  a message: matched to a building by the newest text the app sent to that number, else by
//      the contacts with that number; one building = a customer line in its thread, marked as a
//      text from that number, under the contact's name, waiting, with the office's bell; no
//      building or several (or an archived one) = an email to the office with the number and the
//      words, so nothing is lost; a picture is noted; the same text posted twice is one line; a
//      flood from one number stops making lines
//   T  the office's answer (the real api/client-messages handler): in a thread whose newest
//      customer line came by text, the reply is also texted to that number through the one send
//      step (with the STOP line), once; not to an opted-out number; never for a hub line; the
//      office's line says how it went; the thread says where the next reply will be texted
//   S  the office can see a number that is off: GET /api/client-messages/text-status (contacts.view)
// REGRESSION (THE LAW II.3): on e489af8f there is no inbound route, no opt-out list, no text line
// and no text-back — every check but V0's own fixtures fails.
//   node app/scripts/test-sms-inbound.mjs
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-00000000519e';
const PUBLIC = 'https://app.inbound.test';
const TOKEN = 'twilio-auth-token-for-tests';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG, APP_PUBLIC_URL: PUBLIC, INBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: TOKEN, TWILIO_MESSAGING_SERVICE_SID: 'MGfake',
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'TWILIO_FROM_NUMBER', 'ALERT_WEBHOOK_URL', 'APP_BASE_URL']) delete process.env[k];

let texts = [];
let gmail = [];
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (url.startsWith('https://api.twilio.com/')) { texts.push(new URLSearchParams(String(init?.body || ''))); return { ok: true, status: 201, json: async () => ({ sid: `SM${texts.length}` }) }; }
  if (url.includes('gmail.googleapis.com') && url.includes('/messages/send')) { gmail.push(String(init?.body || '')); return { ok: true, status: 200, json: async () => ({ id: `gm_${gmail.length}`, threadId: 't' }) }; }
  throw new Error(`network blocked in this suite (${url})`);
};
const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const inbound = await soft('../api/sms/[...path].js');
const office = await soft('../api/client-messages/[...path].js');
const CM = await soft('../src/lib/customerMessages.js');
const TX = await soft('../src/lib/texting.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const LINE = CM.SMS_STOP_LINE;
ok('the inbound route, the office route and the rules load', typeof inbound.default === 'function' && typeof office.default === 'function' && typeof TX.smsKeyword === 'function', inbound.__error || office.__error || TX.__error);

// Twilio's documented signature, written here independently of the app: the full URL Twilio was
// given, then each POST parameter's name and value, sorted by name; HMAC-SHA1 keyed by the
// account's auth token; base64.
function twilioSignature(url, params, token = TOKEN) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
const URL_IN = `${PUBLIC}/api/sms/inbound`;
let sidN = 0;
const form = (o = {}) => ({ MessageSid: `SM${String(++sidN).padStart(32, '0')}`, AccountSid: 'ACfake', MessagingServiceSid: 'MGfake', From: '+15555550101', To: '+17542039207', Body: 'Hello', NumMedia: '0', ...o });

const FAR = new Date(Date.now() + 7 * 864e5).toISOString();
const MAILBOX = () => ({ id: '00000000-0000-4000-8000-000000005001', organization_id: ORG, email: 'alerts@in.test', display_name: 'alerts@in.test', provider: 'google', status: 'active', refresh_token_enc: encrypt('r'), access_token_enc: encrypt('a'), access_token_expires_at: FAR, owner_user_id: null, is_system_sender: true });
const USERS = [
  { id: 'u_own', role: 'owner', status: 'active', name: 'Olive Owner', email: 'own@in.test', notificationPrefs: {} },
  { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mara Manager', email: 'mgr@in.test', notificationPrefs: {} },
  { id: 'u_adm', role: 'admin', status: 'active', name: 'Ada Admin', email: 'adm@in.test', notificationPrefs: {} },
];
const baseState = (o = {}) => ({
  company: { name: 'Clean Co', email: 'office@in.test', timezone: 'America/New_York' },
  users: USERS, permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
  clients: [
    { id: 'cl_a1x', name: 'Tower A', supervisorId: 'u_mgr', primaryContactId: 'ct_a1x' },
    { id: 'cl_b1x', name: 'Tower B', supervisorId: 'u_mgr', primaryContactId: 'ct_b1x' },
    { id: 'cl_old', name: 'Old Tower', supervisorId: 'u_mgr', statusOverride: 'archived', archivedAt: '2026-10-01T00:00:00.000Z' },
  ],
  contacts: [
    { id: 'ct_a1x', firstName: 'Pat', lastName: 'Lee', phone: '(555) 555-0101', companyId: 'cl_a1x' },
    { id: 'ct_b1x', firstName: 'Bo', lastName: 'Ray', phone: '555-555-0202', companyId: 'cl_b1x' },
    { id: 'ct_b2x', firstName: 'Cy', lastName: 'Ray', phone: '555-555-0303', companyId: 'cl_b1x' },
    { id: 'ct_a2x', firstName: 'Dee', lastName: 'Lu', phone: '555-555-0303', companyId: 'cl_a1x' },
  ],
  ...o,
});
const sentText = (to, clientId, at = '2026-10-27T15:00:00.000Z', id = `reminder_24h:j_${clientId}`) => ({ organization_id: ORG, id, template_key: 'reminder_24h', channel: 'sms', client_id: clientId, recipient: to, status: 'sent', attempts: 1, sent_at: at, created_at: at, updated_at: at, keep_until: FAR });
const OWNER_LOGIN = { id: 'auth-own', email: 'own@in.test', app_metadata: { role: 'owner', org_user_id: 'u_own', org_id: ORG } };
const ADMIN_LOGIN = { id: 'auth-adm', email: 'adm@in.test', app_metadata: { role: 'admin', org_user_id: 'u_adm', org_id: ORG } };
function seed({ state = baseState(), log = [], optOuts = [], lines = [] } = {}) {
  texts = []; gmail = [];
  __resetSystemSenderCache();
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 5, state }],
      customer_messages: log, sms_opt_outs: optOuts, client_messages: lines, client_message_threads: [], client_message_reads: [],
      activity_log: [], inbox_accounts: [MAILBOX()], sent_messages: [], client_users: [], client_user_assignments: [], client_user_groups: [], client_user_group_members: [],
    },
    logins: { 'tok-own': OWNER_LOGIN, 'tok-adm': ADMIN_LOGIN },
  });
  world.uniqueKeys = { client_messages: [(r) => r.id], customer_messages: [(r) => `${r.organization_id}|${r.id}`] };
}

let logs = [];
function respond(handler, req) {
  const keep = { log: console.log, warn: console.warn, error: console.error };
  logs = [];
  console.log = console.warn = console.error = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : x?.message || JSON.stringify(x))).join(' '));
  return new Promise((resolve) => {
    const headers = {};
    const done = (status, body) => { Object.assign(console, keep); resolve({ status, body, headers }); };
    const res = {
      statusCode: 200, headersSent: false,
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
    };
    Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message || String(e) }));
  });
}
function postText(params, { sign = true, signature = null, url = URL_IN, method = 'POST', host = 'app.inbound.test' } = {}) {
  const raw = new URLSearchParams(params).toString();
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { host, 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': signature || twilioSignature(url, params) } : {}) };
  req.query = { subpath: 'inbound' };
  return respond(inbound.default, req);
}
const officeCall = (action, { method = 'GET', token = 'tok-own', query = {}, body } = {}) => respond(office.default, { method, headers: { authorization: `Bearer ${token}` }, query: { ...query, subpath: action }, body });
const lines = () => world.tables.client_messages || [];
const optOuts = () => world.tables.sms_opt_outs || [];
const bells = () => (world.tables.org_state?.[0]?.state?.notifications || []);
// The text of a MIME message the fake Gmail received (its base64 body part, decoded).
const bodyOf = (mime) => {
  const m = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(String(mime || ''));
  return (m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8') : '') + String(mime || '');
};
const isEmptyTwiml = (r) => r.status === 200 && /xml/.test(String(r.headers['content-type'] || '')) && /^<\?xml[^>]*\?>\s*<Response\s*\/?>\s*(<\/Response>)?\s*$/.test(String(r.body || ''));

if (typeof inbound.default === 'function') {
  // ── V. the route ──
  seed();
  let r = await postText(form({ Body: 'Hi there' }), { sign: false });
  ok('🔴 V1 an UNSIGNED post is refused and changes nothing', r.status === 403 && lines().length === 0 && optOuts().length === 0, { r, lines: lines().length });
  r = await postText(form({ Body: 'STOP' }), { signature: twilioSignature(URL_IN, form({ Body: 'STOP' }), 'some-other-token') });
  ok('🔴 V2 a post signed with another token is refused and changes nothing', r.status === 403 && optOuts().length === 0, r);
  const tampered = form({ Body: 'STOP' });
  r = await postText({ ...tampered, From: '+15555559999' }, { signature: twilioSignature(URL_IN, tampered) });
  ok('🔴 V2 …and so is a signed post whose form was changed', r.status === 403 && optOuts().length === 0, r);
  r = await postText(form({ Body: 'STOP' }));
  ok('🔴 V3 a post signed for the route\'s public URL is read, and answered with an empty TwiML <Response/>', isEmptyTwiml(r), r);
  ok('V3 …the answer carries no secret', !String(r.body || '').includes(TOKEN) && !String(r.body || '').includes('ACfake'));
  seed();
  const elsewhere = form({ Body: 'STOP' });
  r = await postText(elsewhere, { host: 'other.example.test', signature: twilioSignature('https://other.example.test/api/sms/inbound', elsewhere) });
  ok('🔴 V2 …and so is one signed for the request\'s own Host instead of the public URL (the Host is never trusted)', r.status === 403 && optOuts().length === 0, r);
  r = await postText(form({ Body: 'Hi' }), { method: 'GET' });
  ok('V4 a GET is not a delivery (405)', r.status === 405, r);
  const savedToken = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_AUTH_TOKEN;
  seed();
  r = await postText(form({ Body: 'STOP' }));
  ok('🔴 V5 no auth token configured: nothing is read (fail closed)', r.status !== 200 && optOuts().length === 0, r);
  process.env.TWILIO_AUTH_TOKEN = savedToken;

  // ── K. keywords ──
  seed();
  r = await postText(form({ Body: 'STOP' }));
  ok('🔴 K1 STOP records the number as opted out (E.164, a reply, the word), and is no thread line', isEmptyTwiml(r) && optOuts().length === 1 && optOuts()[0].phone === '+15555550101' && optOuts()[0].source === 'reply' && optOuts()[0].keyword === 'STOP' && lines().length === 0, optOuts());
  for (const word of ['stopall', ' Unsubscribe ', 'cancel', 'END', 'quit', 'OptOut', 'revoke.']) {
    seed();
    await postText(form({ Body: word, From: '+15555550111' }));
    ok(`🔴 K2 "${word.trim()}" is STOP too`, optOuts().length === 1 && optOuts()[0].phone === '+15555550111' && lines().length === 0, { word, rows: optOuts() });
  }
  for (const word of ['START', 'unstop']) {
    seed({ optOuts: [{ organization_id: ORG, phone: '+15555550101', opted_out_at: '2026-10-20T00:00:00.000Z', source: 'reply', keyword: 'STOP', updated_at: '2026-10-20T00:00:00.000Z' }] });
    await postText(form({ Body: word }));
    ok(`🔴 K3 "${word}" clears it`, optOuts().length === 0 && lines().length === 0, optOuts());
  }
  seed();
  await postText(form({ Body: 'help' }));
  ok('K4 HELP is Twilio\'s to answer: nothing recorded, no line', optOuts().length === 0 && lines().length === 0);
  seed();
  await postText(form({ Body: 'please take me off this list', OptOutType: 'STOP' }));
  ok('🔴 K5 Twilio\'s OptOutType STOP (Advanced Opt-Out) is honoured whatever the words', optOuts().length === 1 && lines().length === 0, optOuts());
  seed({ log: [sentText('+15555550101', 'cl_a1x')] });
  await postText(form({ Body: 'Stop by at 5 please' }));
  ok('🔴 K6 "Stop by at 5 please" is a message, not STOP', optOuts().length === 0 && lines().length === 1, { opt: optOuts(), lines: lines().length });

  // ── M. a message ──
  seed({ log: [sentText('+15555550101', 'cl_a1x', '2026-10-26T15:00:00.000Z', 'a'), sentText('+15555550101', 'cl_b1x', '2026-10-20T15:00:00.000Z', 'b')] });
  r = await postText(form({ Body: 'The side door is locked today' }));
  const L = lines()[0];
  ok('🔴 M1 matched by the NEWEST text the app sent to that number: one customer line in that building\'s thread', isEmptyTwiml(r) && lines().length === 1 && L?.client_id === 'cl_a1x' && L?.author_role === 'client' && L?.body === 'The side door is locked today', L);
  ok('🔴 M1 …marked as a text, from that number (E.164), under the contact\'s name', L?.via === TX.TEXT_VIA && L?.phone === '+15555550101' && L?.author_name === 'Pat Lee' && L?.author_client_user_id == null && L?.organization_id === ORG, L);
  const summary = (world.tables.client_message_threads || [])[0];
  ok('🔴 M1 …so the thread waits on the office (a customer wrote last)', summary?.client_id === 'cl_a1x' && summary?.last_author_role === 'client' && !!summary?.last_client_message_at, summary);
  ok('🔴 M1 …and the office\'s bell rings, as for a hub message (the building\'s manager)', bells().some((n) => n.eventKey === 'customerMessage' && n.userId === 'u_mgr' && /cl_a1x/.test(n.url || '')), bells());
  seed();
  await postText(form({ Body: 'Can we move Friday?', From: '+15555550202' }));
  ok('🔴 M2 no text sent to it: matched by the one contact with that number (typed another way)', lines().length === 1 && lines()[0].client_id === 'cl_b1x' && lines()[0].author_name === 'Bo Ray' && gmail.length === 0, lines());
  seed();
  await postText(form({ Body: 'Who is this?', From: '+15555550303' }));
  ok('🔴 M3 two buildings\' contacts share the number: no line, the office is emailed', lines().length === 0 && gmail.length === 1, { lines: lines().length, gmail: gmail.length });
  const mail = bodyOf(gmail[0]);
  ok('M3 …the email names the number and carries the words', /555.*555.*0303/.test(mail) && /Who is this\?/.test(mail), mail.slice(0, 400));
  seed();
  await postText(form({ Body: 'Wrong number?', From: '+15555550999' }));
  ok('🔴 M4 an unknown number: no line, the office is emailed (nothing is lost)', lines().length === 0 && gmail.length === 1);
  seed({ log: [sentText('+15555550404', 'cl_old')] });
  await postText(form({ Body: 'Are you still coming?', From: '+15555550404' }));
  ok('M5 the newest text went to an ARCHIVED customer: no line there (its thread takes none), the office is emailed', lines().length === 0 && gmail.length === 1, { lines: lines(), gmail: gmail.length });
  seed({ log: [sentText('+15555550101', 'cl_a1x')] });
  await postText(form({ Body: 'Here is the leak', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME1' }));
  ok('🔴 M6 a picture: the words are kept and the line says a picture came', lines().length === 1 && lines()[0].body.startsWith('Here is the leak') && lines()[0].body.includes(TX.pictureNote?.(1) || '\u0000'), lines()[0]?.body);
  seed({ log: [sentText('+15555550101', 'cl_a1x')] });
  await postText(form({ Body: '', NumMedia: '2' }));
  ok('M6 …a picture with no words still makes a line, saying so', lines().length === 1 && lines()[0].body === TX.pictureNote?.(2), lines()[0]?.body);
  seed({ log: [sentText('+15555550101', 'cl_a1x')] });
  const twice = form({ Body: 'On my way in' });
  await postText(twice);
  await postText(twice);
  ok('🔴 M7 the same text posted twice (one MessageSid) is ONE line', lines().length === 1, lines().length);
  seed({ log: [sentText('+15555550101', 'cl_a1x')] });
  for (let i = 0; i < (TX.INBOUND_TEXT_RATE?.limit || 60) + 1; i += 1) await postText(form({ Body: `spam ${i}` }));
  ok('M8 a flood from one number stops making lines at the hour\'s limit (STOP still works)', lines().length === (TX.INBOUND_TEXT_RATE?.limit || 60), lines().length);
  await postText(form({ Body: 'STOP' }));
  ok('M8 …STOP still works past it', optOuts().length === 1);

  // ── T. the office's answer, texted back ──
  const textLine = { id: '00000000-0000-4000-8000-0000000a0001', organization_id: ORG, client_id: 'cl_a1x', author_role: 'client', author_client_user_id: null, author_user_id: null, author_name: 'Pat Lee', body: 'Side door locked', via: 'sms', phone: '+15555550101', created_at: new Date(Date.now() - 3600e3).toISOString() };
  const hubLine = { ...textLine, id: '00000000-0000-4000-8000-0000000a0002', via: null, phone: null, author_client_user_id: '00000000-0000-4000-8000-0000000c0001', body: 'From the hub', created_at: new Date(Date.now() - 1800e3).toISOString() };
  const replyId = '00000000-0000-4000-8000-0000000b0001';
  seed({ lines: [textLine] });
  r = await officeCall('send', { method: 'POST', body: { id: replyId, clientId: 'cl_a1x', body: 'We will send someone with a key.' } });
  ok('🔴 T1 the reply in a thread whose newest customer line came by text is texted to that number', r.status === 200 && texts.length === 1 && texts[0].get('To') === '+15555550101', { r, texts: texts.length });
  ok('🔴 T1 …through the one send step: the office\'s words, then the STOP line once', typeof LINE === 'string' && String(texts[0]?.get('Body') || '').startsWith('We will send someone with a key.') && texts[0].get('Body').endsWith(LINE) && texts[0].get('Body').split(LINE).length === 2, texts[0]?.get('Body'));
  ok('🔴 T1 …and the office\'s line says it was texted', r.body?.message?.text?.status === TX.TEXT_BACK?.sent && r.body?.message?.text?.to === '+15555550101', r.body);
  const logRow = (world.tables.customer_messages || []).find((x) => x.id === TX.officeReplyLogId?.(replyId));
  ok('T1 …recorded in the sent log against the building (so a reply to it finds its way back)', logRow?.status === 'sent' && logRow?.client_id === 'cl_a1x' && logRow?.recipient === '+15555550101' && logRow?.channel === 'sms', logRow);
  r = await officeCall('send', { method: 'POST', body: { id: replyId, clientId: 'cl_a1x', body: 'We will send someone with a key.' } });
  ok('🔴 T2 the same reply sent again (a retry) texts nothing more', r.status === 200 && texts.length === 1, { r, texts: texts.length });
  r = await officeCall('thread', { query: { clientId: 'cl_a1x' } });
  const shown = r.body?.messages || [];
  ok('🔴 T3 the thread shows the customer\'s line as a text from that number, and the office\'s as texted', shown.some((m) => m.id === textLine.id && m.via === TX.TEXT_VIA && m.phone === '+15555550101') && shown.some((m) => m.id === replyId && m.text?.status === TX.TEXT_BACK?.sent), shown);
  ok('🔴 T3 …and says where the next reply will be texted', r.body?.textBack?.phone === '+15555550101' && r.body?.textBack?.optedOutAt === null, r.body?.textBack);
  seed({ lines: [textLine], optOuts: [{ organization_id: ORG, phone: '+15555550101', opted_out_at: '2026-10-28T12:00:00.000Z', source: 'reply', keyword: 'STOP', updated_at: '2026-10-28T12:00:00.000Z' }] });
  r = await officeCall('send', { method: 'POST', body: { id: '00000000-0000-4000-8000-0000000b0002', clientId: 'cl_a1x', body: 'Noted.' } });
  ok('🔴 T4 the number replied STOP: the line is saved, nothing is texted, and the line says why', r.status === 200 && texts.length === 0 && r.body?.message?.text?.status === TX.TEXT_BACK?.optedOut, { r, texts: texts.length });
  r = await officeCall('thread', { query: { clientId: 'cl_a1x' } });
  ok('T4 …and the thread says texts are off for that number, since when', r.body?.textBack?.phone === '+15555550101' && r.body?.textBack?.optedOutAt === '2026-10-28T12:00:00.000Z', r.body?.textBack);
  seed({ lines: [textLine, hubLine] });
  r = await officeCall('send', { method: 'POST', body: { id: '00000000-0000-4000-8000-0000000b0003', clientId: 'cl_a1x', body: 'Thanks!' } });
  ok('🔴 T5 the newest customer line came from the HUB: nothing is texted, the line carries no text', r.status === 200 && texts.length === 0 && (r.body?.message?.text ?? null) === null, { r, texts: texts.length });
  r = await officeCall('thread', { query: { clientId: 'cl_a1x' } });
  ok('T5 …and the thread names no number to text', r.status === 200 && (r.body?.textBack ?? null) === null, r.body?.textBack);

  // ── S. the office sees a number that is off ──
  seed({ optOuts: [
    { organization_id: ORG, phone: '+15555550101', opted_out_at: '2026-10-28T12:00:00.000Z', source: 'reply', keyword: 'STOP', updated_at: '2026-10-28T12:00:00.000Z' },
    { organization_id: ORG, phone: '+15555550202', opted_out_at: '2026-10-28T12:00:00.000Z', source: 'carrier', keyword: null, updated_at: '2026-10-28T12:00:00.000Z' },
  ] });
  r = await officeCall('text-status', { query: { clientId: 'cl_a1x' } });
  const nums = (r.body?.optOuts || []).map((x) => x.phone).sort();
  ok('🔴 S1 the customer page reads which of ITS numbers have texts off, and since when (not another building\'s)', r.status === 200 && JSON.stringify(nums) === '["+15555550101"]' && r.body.optOuts[0].optedOutAt === '2026-10-28T12:00:00.000Z' && r.body.optOuts[0].source === 'reply', r.body);
  ok('S1 …no-store', /no-store/.test(String(r.headers['cache-control'] || '')), r.headers);
  seed({ state: baseState({ userPermissionOverrides: [{ userId: 'u_adm', grants: [], revokes: ['contacts.view'] }] }) });
  r = await officeCall('text-status', { token: 'tok-adm', query: { clientId: 'cl_a1x' } });
  ok('🔴 S2 without contacts.view: 403', r.status === 403, r);
  r = await officeCall('text-status', { token: 'nobody', query: { clientId: 'cl_a1x' } });
  ok('S3 no login: 401', r.status === 401, r);
  seed();
  r = await officeCall('text-status', { query: { clientId: 'cl_nope' } });
  ok('S4 a building not in the book: 404', r.status === 404, r);
}

console.log(`test-sms-inbound: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
