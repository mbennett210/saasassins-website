// The TEXT channel end to end — NTF-1 ★b (Matt, 2026-09-29): "A phone notification, plus a
// text message for missed shifts and urgent tickets." CS-069.
//
// Two halves:
//   1. the TRANSPORT (api/_lib/sms/twilio.js) against a STUBBED fetch — no Twilio account, no
//      network: what it posts, what it does with Twilio's opt-out code 21610, and that it is
//      OFF (and says so) with the env unset;
//   2. the DISPATCHER (api/_lib/push/dispatch.js) with every dependency injected — which
//      events text, to whom, that a push and a text are decided separately, that quiet hours
//      hold a push and not a text, and that an opt-out is stamped on the person so nothing
//      texts them again.
//
// 🔴 It reaches NO live service: fetch, the push sender, the subscription read and the
// org_state write are all fakes, so this needs no LIVE_EFFECT entry. It is a "backend" suite
// (it imports ../api/…), so run-tests skips it on a backend-stripped checkout.
//
//   node app/scripts/test-alert-sms.mjs
import assert from 'node:assert/strict';
import { sendSms, smsConfigured, smsStatus } from '../api/_lib/sms/twilio.js';
import { dispatchDue } from '../api/_lib/push/dispatch.js';
import { TWILIO_OPTED_OUT_CODE } from '../src/lib/alertDelivery.js';

let pass = 0;
const fails = [];
const ok = async (label, fn) => {
  try { await fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

// ── env, saved and restored so the suite never leaks a setting into the next one ──
const ENV_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_FROM_NUMBER'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (over = {}) => {
  for (const k of ENV_KEYS) { if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]; }
};
// Test-shaped values only; nothing here is a credential.
const TEST_ENV = { TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_AUTH_TOKEN: 'tok_test_value', TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000000000000000000000000000' };

const stubFetch = (reply) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(calls.length) : reply;
    return { ok: r.ok !== false, status: r.status || (r.ok === false ? 400 : 201), json: async () => (r.body || {}) };
  };
  impl.calls = calls;
  return impl;
};

const TZ = 'America/New_York';
const WED_2AM = Date.parse('2026-09-30T06:00:00.000Z');  // 02:00 EDT
const WED_10AM = Date.parse('2026-09-30T14:00:00.000Z'); // 10:00 EDT

console.log('\n── The transport, against a stubbed fetch ──');

await ok('with the env unset the channel is OFF and says which names are missing', async () => {
  setEnv({});
  assert.equal(smsConfigured(), false);
  const st = smsStatus();
  assert.equal(st.configured, false);
  assert.equal(st.senderKind, null);
  assert.deepEqual(st.missing, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER']);
  const f = stubFetch({ ok: true });
  const r = await sendSms({ to: '+17545550103', body: 'hi' }, { fetchImpl: f });
  assert.equal(r.skipped, 'sms_unconfigured');
  assert.equal(f.calls.length, 0, 'nothing is posted when it is off');
});
await ok('a half-configured env is still OFF (a sender alone is not a channel)', async () => {
  setEnv({ TWILIO_ACCOUNT_SID: TEST_ENV.TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER: '+15005550006' });
  assert.equal(smsConfigured(), false);
  assert.deepEqual(smsStatus().missing, ['TWILIO_AUTH_TOKEN']);
});
await ok('the status reports which KIND of sender, and never a value', async () => {
  setEnv(TEST_ENV);
  assert.equal(smsStatus().senderKind, 'messaging_service');
  setEnv({ ...TEST_ENV, TWILIO_MESSAGING_SERVICE_SID: undefined, TWILIO_FROM_NUMBER: '+15005550006' });
  assert.equal(smsStatus().senderKind, 'from_number');
  const printed = JSON.stringify(smsStatus());
  for (const v of [TEST_ENV.TWILIO_ACCOUNT_SID, TEST_ENV.TWILIO_AUTH_TOKEN, '+15005550006']) {
    assert.equal(printed.includes(v), false, 'no credential or number in the status');
  }
});
await ok('a send posts To/Body and the Messaging Service, with basic auth', async () => {
  setEnv(TEST_ENV);
  const f = stubFetch({ ok: true, body: { sid: 'SMtest' } });
  const r = await sendSms({ to: '1-754-555-0103', body: 'Missed shift: Las Olas' }, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.sid, 'SMtest');
  const { url, init } = f.calls[0];
  assert.ok(url.includes(`/Accounts/${TEST_ENV.TWILIO_ACCOUNT_SID}/Messages.json`), url);
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('To'), '+17545550103', 'the profile number is normalized to E.164');
  assert.equal(form.get('Body'), 'Missed shift: Las Olas');
  assert.equal(form.get('MessagingServiceSid'), TEST_ENV.TWILIO_MESSAGING_SERVICE_SID);
  assert.equal(form.get('From'), null, 'a Messaging Service replaces the From number');
  assert.ok(String(init.headers.Authorization).startsWith('Basic '));
});
await ok('with only a From number, that is what is sent', async () => {
  setEnv({ ...TEST_ENV, TWILIO_MESSAGING_SERVICE_SID: undefined, TWILIO_FROM_NUMBER: '+15005550006' });
  const f = stubFetch({ ok: true });
  await sendSms({ to: '+17545550103', body: 'x' }, { fetchImpl: f });
  assert.equal(new URLSearchParams(f.calls[0].init.body).get('From'), '+15005550006');
});
await ok('an un-textable number never reaches Twilio', async () => {
  setEnv(TEST_ENV);
  const f = stubFetch({ ok: true });
  assert.equal((await sendSms({ to: '1234', body: 'x' }, { fetchImpl: f })).skipped, 'bad_number');
  assert.equal((await sendSms({ to: '+17545550103', body: '  ' }, { fetchImpl: f })).skipped, 'empty_body');
  assert.equal(f.calls.length, 0);
});
await ok('Twilio 21610 comes back as an OPT-OUT, not a generic failure', async () => {
  setEnv(TEST_ENV);
  const f = stubFetch({ ok: false, status: 400, body: { code: TWILIO_OPTED_OUT_CODE, message: 'Attempt to send to unsubscribed recipient' } });
  const r = await sendSms({ to: '+17545550103', body: 'x' }, { fetchImpl: f });
  assert.equal(r.optedOut, true);
  assert.equal(r.code, TWILIO_OPTED_OUT_CODE);
});
await ok('any other rejection carries Twilio\'s code and never throws', async () => {
  setEnv(TEST_ENV);
  const f = stubFetch({ ok: false, status: 400, body: { code: 21211, message: 'Invalid To number' } });
  const r = await sendSms({ to: '+17545550103', body: 'x' }, { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.code, 21211);
  assert.equal(r.optedOut, undefined);
});
await ok('a transport failure is an outcome, not an exception', async () => {
  setEnv(TEST_ENV);
  const boom = async () => { throw new Error('socket hang up'); };
  const r = await sendSms({ to: '+17545550103', body: 'x' }, { fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.ok(/socket hang up/.test(r.error));
});

console.log('── The dispatcher: which events text, and to whom ──');

const users = () => [
  // Renata switched "Text me alerts" on herself: it is off by default for everyone (2026-10-28).
  { id: 'u_sup', name: 'Renata', role: 'manager', status: 'active', phone: '1-754-555-0103', notificationPrefs: { smsAlertsEnabled: true } },
  { id: 'u_crew', name: 'Tomas', role: 'crew', status: 'active', phone: '1-754-555-0110', notificationPrefs: {} },
];
const row = (over = {}) => ({
  id: 'nt_1', userId: 'u_sup', eventKey: 'shiftMissed', title: 'Missed shift: Las Olas',
  body: 'Scheduled 9:00 PM, no clock-in.', url: '/schedule/j1', createdAt: new Date(WED_2AM).toISOString(),
  readAt: null, ...over,
});
// Every dependency is injected, so nothing here touches Supabase, VAPID or Twilio.
function deps(over = {}) {
  const log = { pushed: [], texted: [], optedOut: [] };
  return {
    log,
    opts: {
      now: over.now ?? WED_2AM,
      claim: async () => ({
        toSend: over.rows || [row()], users: over.users || users(), claimed: (over.rows || [row()]).length,
        opsSettings: over.opsSettings || {}, timeZone: over.timeZone ?? TZ,
      }),
      subscriptionsFor: async () => (over.noDevices ? [] : [{ endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }]),
      pushTo: async (_subs, payload) => { log.pushed.push(payload); return { delivered: 1, failed: 0, expired: 0 }; },
      text: async (msg) => { log.texted.push(msg); return over.textResult || { ok: true, sid: 'SM1' }; },
      textConfigured: () => over.textConfigured !== false,
      markOptedOut: async (ids) => { log.optedOut.push(...ids); return ids.length; },
    },
  };
}

await ok('a missed shift is pushed AND texted', async () => {
  const d = deps();
  const out = await dispatchDue(d.opts);
  assert.equal(out.sent, 1);
  assert.equal(out.texted, 1);
  assert.equal(d.log.texted.length, 1);
  assert.equal(d.log.texted[0].to, '1-754-555-0103');
  assert.ok(d.log.texted[0].body.includes('Missed shift'), d.log.texted[0].body);
});
await ok('an urgent ticket is texted; a non-SMS event is not', async () => {
  const urgent = await dispatchDue(deps({ rows: [row({ eventKey: 'ticketUrgent', title: 'Urgent · No reply yet: Las Olas' })] }).opts);
  assert.equal(urgent.texted, 1);
  for (const eventKey of ['problemReported', 'ticketUnanswered', 'newDM', 'checklistDue', 'inspectionDue']) {
    const out = await dispatchDue(deps({ rows: [row({ eventKey })] }).opts);
    assert.equal(out.texted, 0, eventKey);
  }
});
await ok('with the env unset nothing is texted and the push still goes', async () => {
  const d = deps({ textConfigured: false });
  const out = await dispatchDue(d.opts);
  assert.equal(out.texted, 0);
  assert.equal(d.log.texted.length, 0);
  assert.equal(out.sent, 1);
});
await ok('crew are not texted about a missed shift', async () => {
  const out = await dispatchDue(deps({ rows: [row({ userId: 'u_crew' })] }).opts);
  assert.equal(out.texted, 0);
});
await ok('a member with the switch off, or no phone, is not texted', async () => {
  const off = users().map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { smsAlertsEnabled: false } } : u));
  assert.equal((await dispatchDue(deps({ users: off }).opts)).texted, 0);
  const noPhone = users().map((u) => (u.id === 'u_sup' ? { ...u, phone: '' } : u));
  assert.equal((await dispatchDue(deps({ users: noPhone }).opts)).texted, 0);
});
await ok('an already-opted-out member is not texted again', async () => {
  const out = users().map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { ...u.notificationPrefs, smsOptedOut: true } } : u));
  const d = deps({ users: out });
  const res = await dispatchDue(d.opts);
  assert.equal(res.texted, 0);
  assert.equal(d.log.texted.length, 0);
});
await ok('a STOP reply stamps the person, so the next run skips them', async () => {
  const d = deps({ textResult: { ok: false, optedOut: true, code: TWILIO_OPTED_OUT_CODE } });
  const out = await dispatchDue(d.opts);
  assert.equal(out.texted, 0);
  assert.equal(out.smsOptedOut, 1);
  assert.deepEqual(d.log.optedOut, ['u_sup']);
});
await ok('a text failure is reported by CODE, never with the number or the token', async () => {
  const d = deps({ textResult: { ok: false, code: 21211, error: 'Invalid To number' } });
  const out = await dispatchDue(d.opts);
  assert.deepEqual(out.smsErrors, ['21211']);
  assert.equal(JSON.stringify(out).includes('754'), false);
});
await ok('push and text are decided SEPARATELY: banners off still texts', async () => {
  const noPush = users().map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { ...u.notificationPrefs, mobilePushEnabled: false } } : u));
  const d = deps({ users: noPush });
  const out = await dispatchDue(d.opts);
  assert.equal(out.sent, 0, 'no banner');
  assert.equal(out.texted, 1, 'still texted');
});
await ok('a member with no subscribed device is still texted', async () => {
  const d = deps({ noDevices: true });
  const out = await dispatchDue(d.opts);
  assert.equal(out.sent, 0);
  assert.equal(out.texted, 1);
});

console.log('── The dispatcher: quiet hours and office hours hold the PUSH ──');

await ok('quiet hours hold an ordinary push, and are reported', async () => {
  const quiet = users().map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { ...u.notificationPrefs, quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '07:00' } } : u));
  const d = deps({ users: quiet, rows: [row({ eventKey: 'newDM', title: 'DM from Matt' })] });
  const out = await dispatchDue(d.opts);
  assert.equal(out.sent, 0);
  assert.deepEqual(out.pushHeld, { quietHours: 1, officeHours: 0 });
  assert.equal(d.log.pushed.length, 0);
});
await ok('a missed shift breaks through quiet hours, and still texts', async () => {
  const quiet = users().map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { ...u.notificationPrefs, quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '07:00' } } : u));
  const out = await dispatchDue(deps({ users: quiet }).opts);
  assert.equal(out.sent, 1);
  assert.equal(out.texted, 1);
  assert.equal(out.pushHeld, undefined);
});
await ok('a non-urgent ticket push waits for office hours; an urgent one does not', async () => {
  const held = await dispatchDue(deps({ rows: [row({ eventKey: 'ticketUnanswered' })] }).opts);
  assert.equal(held.sent, 0);
  assert.deepEqual(held.pushHeld, { quietHours: 0, officeHours: 1 });
  const urgent = await dispatchDue(deps({ rows: [row({ eventKey: 'ticketUrgent' })] }).opts);
  assert.equal(urgent.sent, 1);
});
await ok('inside office hours the same non-urgent ticket push goes out', async () => {
  const out = await dispatchDue(deps({
    now: WED_10AM, rows: [row({ eventKey: 'ticketUnanswered', createdAt: new Date(WED_10AM).toISOString() })],
  }).opts);
  assert.equal(out.sent, 1);
  assert.equal(out.pushHeld, undefined);
});
await ok('the hour is judged in the ORG zone — the cron\'s own clock is UTC', async () => {
  // 02:00 EDT is 06:00 UTC. Read as UTC that is BEFORE the 08:00 open either way, so use a
  // case that separates them: 13:00 UTC is 09:00 EDT (open) but would be 13:00 (open) in UTC
  // too — so flip it: 21:30 UTC is 17:30 EDT, past closing, but 21:30 in a zone that closes at
  // 23:00 would be open.
  const at = Date.parse('2026-09-30T21:30:00.000Z');
  const rows = [row({ eventKey: 'ticketUnanswered', createdAt: new Date(at).toISOString() })];
  const closed = await dispatchDue(deps({ now: at, rows, timeZone: TZ }).opts);
  assert.equal(closed.sent, 0, '17:30 in New York is past closing');
  const open = await dispatchDue(deps({
    now: at, rows, timeZone: TZ, opsSettings: { officeHoursStart: '08:00', officeHoursEnd: '23:00' },
  }).opts);
  assert.equal(open.sent, 1, 'the same instant is inside a later closing time');
});
await ok('nothing claimed means nothing sent and nothing texted', async () => {
  const out = await dispatchDue(deps({ rows: [] }).opts);
  assert.equal(out.sent, 0);
  assert.equal(out.texted, 0);
});

setEnv(savedEnv);

if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${pass} passed, ${fails.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ alert texting: ${pass} checks passed`);
}
