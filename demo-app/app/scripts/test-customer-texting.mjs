// CUSTOMER TEXTS: THE STOP LINE AND THE OPTED-OUT NUMBERS (Daniel, 2026-10-28, once Twilio went
// live: "Yes, add the Reply STOP functionality."). The approved A2P campaign covers the 24-hour
// reminder, the day-of reminder and crew on the way, and its samples end with the campaign's own
// opt-out words. Every text the app sends a customer leaves through ONE step,
// api/_lib/customerMessages/send.js sendCustomerMessage, so the rules live there:
//   S  the STOP line: every text ends with SMS_STOP_LINE, exactly once (a body that already carries
//      it, or the app's older "Reply STOP to opt out.", never doubles it); an email never gets it
//   O  the opted-out numbers (sms_opt_outs, keyed by the number in E.164): a text to one is refused
//      with `optedOut` and NO Twilio call, whatever shape the number is typed in; email is never
//      affected; Twilio's 21610 ("the recipient replied STOP") records the number, so the next
//      text is refused before Twilio; an opt-out list that cannot be read sends nothing (fail
//      closed)
//   W  the cleaner's On my way (the real api/time handler): the text ends with the STOP line; to an
//      opted-out number it is refused (409 `opted-out`), recorded refused, and Twilio is not called
// The real modules over scripts/fake-supabase.mjs; Gmail and Twilio captured by a stubbed fetch.
// REGRESSION (THE LAW II.3): on e489af8f there is no STOP line, no opt-out list and no refusal —
// S1–S5, O1, O2, O4–O6 and W1, W3, W4 fail.
//   node app/scripts/test-customer-texting.mjs
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-00000000c7e1';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG, INBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'TWILIO_MESSAGING_SERVICE_SID', 'ALERT_WEBHOOK_URL']) delete process.env[k];

// The campaign's approved opt-out words, as registered with the carriers (A2P campaign samples,
// checked 2026-10-28). This is the external source of truth the constant must equal.
const CAMPAIGN_OPT_OUT = 'Reply STOP to opt out or HELP for assistance. Msg & data rates may apply.';

let texts = [];
let gmail = [];
let refuseWith21610 = new Set();
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (url.startsWith('https://api.twilio.com/')) {
    const p = new URLSearchParams(String(init?.body || ''));
    texts.push(p);
    if (refuseWith21610.has(p.get('To'))) return { ok: false, status: 400, json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }) };
    return { ok: true, status: 201, json: async () => ({ sid: `SM${texts.length}` }) };
  }
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
const quietly = async (fn) => {
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, keep); }
};

const CM = await soft('../src/lib/customerMessages.js');
const SEND = await soft('../api/_lib/customerMessages/send.js');
const OPT = await soft('../api/_lib/sms/optOuts.js');
const TX = await soft('../src/lib/texting.js');
const RS = await soft('../src/lib/reminderScheduler.js');
const route = await soft('../api/time/[...path].js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const LINE = CM.SMS_STOP_LINE;
const send = typeof SEND.sendCustomerMessage === 'function' ? (m) => quietly(() => SEND.sendCustomerMessage(m)) : async () => ({ __missing: SEND.__error });
const endsOnce = (body) => typeof LINE === 'string' && String(body || '').endsWith(LINE) && String(body).split(LINE).length === 2;

const FAR = new Date(Date.now() + 7 * 864e5).toISOString();
const MAILBOX = () => ({ id: '00000000-0000-4000-8000-000000005000', organization_id: ORG, email: 'alerts@tx.test', display_name: 'alerts@tx.test', provider: 'google', status: 'active', refresh_token_enc: encrypt('r'), access_token_enc: encrypt('a'), access_token_expires_at: FAR, owner_user_id: null, is_system_sender: true });
const optOut = (phone, o = {}) => ({ organization_id: ORG, phone, opted_out_at: '2026-10-28T14:00:00.000Z', source: 'reply', keyword: 'STOP', updated_at: '2026-10-28T14:00:00.000Z', ...o });
function seed({ optOuts = [], tables = {} } = {}) {
  texts = []; gmail = []; refuseWith21610 = new Set();
  __resetSystemSenderCache();
  __resetRateLimit();
  resetWorld({ tables: { sms_opt_outs: optOuts, inbox_accounts: [MAILBOX()], sent_messages: [], customer_messages: [], ...tables } });
}
const sms = (to, body = 'Reminder: Clean Co will be at Tower One tomorrow at 9:00 AM for Janitorial.', o = {}) => ({ templateKey: 'reminder_24h', channel: 'sms', to, body, refs: { clientId: 'cl_tx1x' }, ...o });

// ── S. the STOP line ─────────────────────────────────────────────────────────
ok('S0 the STOP line is the campaign\'s own words, one constant in the catalog', LINE === CAMPAIGN_OPT_OUT, LINE);
seed();
let r = await send(sms('+15555550101'));
ok('🔴 S1 a text to a customer ends with the STOP line, once', r.ok === true && texts.length === 1 && endsOnce(texts[0].get('Body')), { r, body: texts[0]?.get('Body') });
ok('S1 …after Matt\'s words, untouched', String(texts[0]?.get('Body') || '').startsWith('Reminder: Clean Co will be at Tower One tomorrow at 9:00 AM for Janitorial.'));
seed();
await send(sms('+15555550101', `Thanks, we'll be there. ${LINE}`));
ok('🔴 S2 a body that already carries the line: still once', texts.length === 1 && endsOnce(texts[0].get('Body')), texts[0]?.get('Body'));
seed();
await send(sms('+15555550101', 'Running late. Reply STOP to opt out.'));
ok('🔴 S3 the app\'s older "Reply STOP to opt out." gives way to the campaign\'s line (one STOP, not two)', texts.length === 1 && endsOnce(texts[0].get('Body')) && (texts[0].get('Body').match(/Reply STOP/g) || []).length === 1, texts[0]?.get('Body'));
ok('🔴 S4 the composer\'s opt-out line for a text IS the campaign\'s line (so a nudge text cannot carry two)', typeof CM.optOutLine === 'function' && CM.optOutLine('sms') === LINE, CM.optOutLine?.('sms'));
seed();
r = await send({ templateKey: 'visit_summary', channel: 'email', to: 'pat@corp.test', subject: 'Your clean', body: 'Hi Pat, your clean is done.', refs: { clientId: 'cl_tx1x' } });
ok('S5 an email never gets the STOP line', r.ok === true && gmail.length === 1 && !gmail[0].includes('Reply STOP') && typeof LINE === 'string', { r, gmail: gmail.length });
ok('S5 …and withSmsStopLine is the one rule (idempotent)', typeof CM.withSmsStopLine === 'function' && CM.withSmsStopLine(CM.withSmsStopLine('Hi')) === CM.withSmsStopLine('Hi') && endsOnce(CM.withSmsStopLine('Hi')));

// ── O. opted-out numbers ─────────────────────────────────────────────────────
seed({ optOuts: [optOut('+15555550101')] });
r = await send(sms('+15555550101'));
ok('🔴 O1 a text to an opted-out number is refused (optedOut) and Twilio is never called', r.ok === false && r.optedOut === true && texts.length === 0, { r, texts: texts.length });
r = await send(sms('(555) 555-0101'));
ok('🔴 O2 …however the number is typed (the list is keyed by E.164)', r.optedOut === true && texts.length === 0, r);
r = await send({ templateKey: 'visit_summary', channel: 'email', to: 'pat@corp.test', subject: 'Your clean', body: 'Done.', refs: { clientId: 'cl_tx1x' } });
ok('O3 email to the same customer is never affected', r.ok === true && gmail.length === 1, r);
seed();
refuseWith21610.add('+15555550102');
r = await send(sms('555-555-0102'));
ok('🔴 O4 Twilio refuses with 21610: the answer is optedOut and the number is recorded (source carrier)', r.optedOut === true && (world.tables.sms_opt_outs || []).some((x) => x.phone === '+15555550102' && x.source === TX.OPT_OUT_SOURCE?.carrier && x.organization_id === ORG), { r, rows: world.tables.sms_opt_outs });
r = await send(sms('+15555550102'));
ok('🔴 O4 …so the next text to it is refused before Twilio (one call in all)', r.optedOut === true && texts.length === 1, { r, texts: texts.length });
seed();
world.failWhen = (q) => q.table === 'sms_opt_outs';
r = await send(sms('+15555550103'));
ok('🔴 O5 the opt-out list cannot be read: nothing is texted (fail closed), and it is no "sent"', r.ok === false && !r.optedOut && texts.length === 0 && typeof r.error === 'string', { r, texts: texts.length });
seed();
ok('O6 the store answers one number\'s opt-out, null for one never opted out', typeof OPT.readOptOut === 'function'
  && (await OPT.recordOptOut({ phone: '+15555550104', source: 'reply', keyword: 'STOP', at: '2026-10-28T15:00:00.000Z' }), (await OPT.readOptOut('+15555550104'))?.source === 'reply')
  && (await OPT.readOptOut('+15555550105')) === null, world.tables.sms_opt_outs);
ok('O6 …and START clears it', typeof OPT.clearOptOut === 'function' && (await OPT.clearOptOut('+15555550104'), (await OPT.readOptOut('+15555550104')) === null));
ok('O6 …a number that is not one is never written', typeof OPT.recordOptOut === 'function' && (await OPT.recordOptOut({ phone: 'abc', source: 'reply' })) === false && !(world.tables.sms_opt_outs || []).some((x) => x.phone === 'abc'));

// ── W. On my way, end to end ─────────────────────────────────────────────────
const K = CM.MESSAGE_KEY || {};
const NOW = Date.now();
const MIN = 60e3;
const templates = () => (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: t.key === K.onTheWay }));
const state = () => ({
  company: { name: 'Way Co', timezone: 'America/New_York' }, reminderTemplates: templates(),
  users: [{ id: 'u_ana', role: 'crew', status: 'active', name: 'Ana', email: 'ana@way.test' }],
  permissions: seedPermissions(), userPermissionOverrides: [], opsSettings: {},
  clients: [{ id: 'cl_w1x', name: 'Tower One', primaryContactId: 'ct_w1x' }],
  contacts: [{ id: 'ct_w1x', firstName: 'Pat', email: 'pat@corp.test', phone: '(555) 555-0111', companyId: 'cl_w1x' }],
  sites: [{ id: 'st_w1x', clientId: 'cl_w1x', name: 'Tower One, Lobby' }], services: [], marketingSuppressions: [],
});
const job = { id: 'j_w1x', clientId: 'cl_w1x', siteId: 'st_w1x', crewIds: ['u_ana'], status: 'upcoming', startAt: new Date(NOW - 30 * MIN).toISOString(), endAt: new Date(NOW + 90 * MIN).toISOString() };
function seedWay(optOuts = []) {
  seed({
    optOuts,
    tables: {
      org_state: [{ organization_id: ORG, version: 2, state: state() }],
      jobs: [{ id: job.id, organization_id: ORG, data: job, start_at: job.startAt, status: job.status, client_id: job.clientId, site_id: job.siteId }],
    },
  });
  world.logins = new Map([['tok-ana', { id: 'auth-ana', email: 'ana@way.test', app_metadata: { role: 'crew', org_user_id: 'u_ana', org_id: ORG } }]]);
  world.uniqueKeys = { customer_messages: [(x) => `${x.organization_id}|${x.id}`] };
}
function onMyWay() {
  const raw = JSON.stringify({ jobId: job.id });
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer tok-ana' };
  req.query = { subpath: 'on-my-way' };
  req.body = { jobId: job.id };
  return quietly(() => new Promise((resolve, reject) => {
    const res = { statusCode: 200, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end(b) { resolve({ status: this.statusCode, body: b ?? null }); return this; } };
    Promise.resolve(route.default(req, res)).catch(reject);
  }));
}
if (typeof route.default === 'function' && typeof RS.onTheWayItem === 'function') {
  seedWay();
  let w = await onMyWay();
  ok('🔴 W1 On my way: the text ends with the STOP line, once', w.status === 200 && texts.length === 1 && endsOnce(texts[0].get('Body')) && /your crew is on the way to Tower One, Lobby/.test(texts[0].get('Body')), { w, body: texts[0]?.get('Body') });
  ok('W2 …to the contact\'s number', texts[0]?.get('To') === '+15555550111', texts[0]?.get('To'));
  seedWay([optOut('+15555550111')]);
  w = await onMyWay();
  const row = (world.tables.customer_messages || [])[0];
  ok('🔴 W3 to an opted-out number: refused (409 opted-out), Twilio never called', w.status === 409 && w.body?.code === 'opted-out' && texts.length === 0, { w, texts: texts.length });
  ok('🔴 W4 …recorded refused with the reason, never "failed" (nothing to try again)', row?.status === 'refused' && row?.failure_reason === TX.OPTED_OUT_REASON, row);
} else {
  ok('the On my way route and rule load', false, route.__error || RS.__error);
}

console.log(`test-customer-texting: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
