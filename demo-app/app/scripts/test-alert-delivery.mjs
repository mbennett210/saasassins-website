// Alert DELIVERY policy — Matt's NTF-2 (quiet hours), WO-7 (office hours for non-urgent
// ticket alerts) and NTF-1 (texts for missed shifts and urgent tickets), all 2026-09-29.
// CS-069.
//
// Pins src/lib/alertDelivery, the one module the push dispatcher and both settings screens
// read, so what a manager is shown is what the server does. Pure + offline.
//
//   node app/scripts/test-alert-delivery.mjs
import assert from 'node:assert/strict';

const {
  ALWAYS_PUSH_EVENT_KEYS, OFFICE_HOURS_EVENT_KEYS, SMS_ALERT_EVENT_KEYS,
  QUIET_HOURS_DEFAULTS, quietHoursFor, isInQuietHours, pushHoldReason,
  SMS_ALERTS_DEFAULT, smsAlertsEnabled, isSmsOptedOut, smsHoldReason,
  toE164, alertSmsBody, SMS_MAX_BODY, TWILIO_OPTED_OUT_CODE,
} = await import('../src/lib/alertDelivery.js');
const { ROLES, NOTIFICATIONS_MANDATORY_ROLES, applyMandatoryNotificationPolicy } = await import('../src/lib/roles.js');
const { NOTIFICATION_GROUPS } = await import('../src/lib/notifications.js');

let pass = 0;
const fails = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

const TZ = 'America/New_York';
const WED_2AM = Date.parse('2026-09-30T06:00:00.000Z');  // 02:00 EDT, a Wednesday
const WED_10AM = Date.parse('2026-09-30T14:00:00.000Z'); // 10:00 EDT
const WED_10PM = Date.parse('2026-10-01T02:00:00.000Z'); // 22:00 EDT

const user = (over = {}) => ({
  id: 'u_sup', name: 'Renata', role: 'manager', status: 'active', phone: '1-754-555-0103',
  notificationPrefs: {}, ...over,
});
// A member who switched "Text me alerts" on (it is off by default for everyone, 2026-10-28).
const texter = (over = {}) => user({ ...over, notificationPrefs: { smsAlertsEnabled: true, ...(over.notificationPrefs || {}) } });
const quiet = (over = {}) => user({
  notificationPrefs: { quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '07:00', ...(over.prefs || {}) },
  ...over.user,
});

console.log('\n── The three event sets ──');

ok('the loud events are exactly the ones Matt named', () => {
  assert.deepEqual([...ALWAYS_PUSH_EVENT_KEYS].sort(), ['offSitePunch', 'shiftMissed', 'ticketUrgent']);
  assert.deepEqual([...SMS_ALERT_EVENT_KEYS].sort(), ['offSitePunch', 'shiftMissed', 'ticketUrgent']);
  assert.deepEqual([...OFFICE_HOURS_EVENT_KEYS].sort(), ['problemReported', 'ticketUnanswered']);
});
ok('every SMS event also breaks through quiet hours (a text is louder than a banner)', () => {
  for (const k of SMS_ALERT_EVENT_KEYS) assert.ok(ALWAYS_PUSH_EVENT_KEYS.has(k), k);
});
ok('every key named here is a real catalog toggle someone can see and set', () => {
  const catalog = new Set(NOTIFICATION_GROUPS.flatMap((g) => g.items).map((i) => i.key));
  for (const k of [...ALWAYS_PUSH_EVENT_KEYS, ...OFFICE_HOURS_EVENT_KEYS, ...SMS_ALERT_EVENT_KEYS]) {
    assert.ok(catalog.has(k), `${k} is missing from NOTIFICATION_GROUPS`);
  }
});

console.log('── NTF-2: quiet hours hold the PUSH, never the row ──');

ok('quiet hours are opt-in — absent prefs are no quiet hours', () => {
  assert.equal(quietHoursFor(user()), null);
  assert.equal(quietHoursFor(user({ notificationPrefs: { quietHoursStart: '21:00', quietHoursEnd: '07:00' } })), null);
});
ok('an overnight window wraps midnight', () => {
  assert.equal(isInQuietHours(quiet(), WED_2AM, TZ), true);
  assert.equal(isInQuietHours(quiet(), WED_10PM, TZ), true);
  assert.equal(isInQuietHours(quiet(), WED_10AM, TZ), false);
});
ok('a same-day window does not wrap', () => {
  const u = quiet({ prefs: { quietHoursStart: '09:00', quietHoursEnd: '11:00' } });
  assert.equal(isInQuietHours(u, WED_10AM, TZ), true);
  assert.equal(isInQuietHours(u, WED_2AM, TZ), false);
});
ok('a malformed or zero-width window silences nobody', () => {
  assert.equal(quietHoursFor(quiet({ prefs: { quietHoursStart: 'oops' } })), null);
  assert.equal(quietHoursFor(quiet({ prefs: { quietHoursStart: '09:00', quietHoursEnd: '09:00' } })), null);
  assert.equal(isInQuietHours(quiet({ prefs: { quietHoursStart: '' } }), WED_2AM, TZ), false);
});
ok('an ordinary alert is HELD during quiet hours', () => {
  assert.equal(pushHoldReason({ user: quiet(), eventKey: 'newDM', at: WED_2AM, tz: TZ }), 'quiet-hours');
});
ok('late, missed and urgent tickets break through', () => {
  for (const k of ALWAYS_PUSH_EVENT_KEYS) {
    assert.equal(pushHoldReason({ user: quiet(), eventKey: k, at: WED_2AM, tz: TZ }), null, k);
  }
});
ok('outside quiet hours nothing is held', () => {
  assert.equal(pushHoldReason({ user: quiet(), eventKey: 'newDM', at: WED_10AM, tz: TZ }), null);
});
ok('a CREW member has no quiet hours, whatever the blob says', () => {
  assert.deepEqual(NOTIFICATIONS_MANDATORY_ROLES, ['crew']);
  const crew = quiet({ user: { role: 'crew' } });
  assert.equal(quietHoursFor(crew), null);
  assert.equal(isInQuietHours(crew, WED_2AM, TZ), false);
  assert.equal(pushHoldReason({ user: crew, eventKey: 'checklistDue', at: WED_2AM, tz: TZ }), null);
});
ok('the delivery prefs are NOT treated as event mutes at the write point', () => {
  // A crew member turning their own texts or quiet hours off must not be read as muting an
  // event (which the mandatory-role rule would drop). The policy for them is in the READER.
  const patch = applyMandatoryNotificationPolicy(user({ role: 'crew' }), {
    quietHoursEnabled: false, smsAlertsEnabled: false, mobilePushEnabled: false, shiftMissed: false,
  });
  assert.equal(patch.quietHoursEnabled, false);
  assert.equal(patch.smsAlertsEnabled, false);
  assert.equal(patch.mobilePushEnabled, false);
  assert.equal('shiftMissed' in patch, false, 'an event mute is still dropped for crew');
});

console.log('── WO-7: a non-urgent ticket alert waits for office hours ──');

ok('a new non-urgent ticket is HELD at 2 a.m. and released in the morning', () => {
  const u = user();
  assert.equal(pushHoldReason({ user: u, eventKey: 'problemReported', at: WED_2AM, tz: TZ }), 'office-hours');
  assert.equal(pushHoldReason({ user: u, eventKey: 'ticketUnanswered', at: WED_2AM, tz: TZ }), 'office-hours');
  assert.equal(pushHoldReason({ user: u, eventKey: 'problemReported', at: WED_10AM, tz: TZ }), null);
});
ok('an urgent ticket is never held, at any hour', () => {
  assert.equal(pushHoldReason({ user: user(), eventKey: 'ticketUrgent', at: WED_2AM, tz: TZ }), null);
});
ok('the office-hours gate is scoped to tickets — it is not a curfew on DMs', () => {
  assert.equal(pushHoldReason({ user: user(), eventKey: 'newDM', at: WED_2AM, tz: TZ }), null);
});
ok('the gate reads the org\'s office-hours SETTING', () => {
  const nights = { officeHoursDays: [0, 1, 2, 3, 4, 5, 6], officeHoursStart: '00:00', officeHoursEnd: '23:59' };
  assert.equal(pushHoldReason({ user: user(), eventKey: 'problemReported', at: WED_2AM, settings: nights, tz: TZ }), null);
});
ok('office hours outrank quiet hours in the reason given (both would hold)', () => {
  assert.equal(pushHoldReason({ user: quiet(), eventKey: 'problemReported', at: WED_2AM, tz: TZ }), 'office-hours');
});

console.log('── NTF-1: who is texted ──');

// 🔴 Staff alert texts are OFF by default for everyone (Daniel, 2026-10-28: the A2P campaign
// covers the customer texts only). REGRESSION: on e489af8f a manager was texted by default.
ok('🔴 the switch defaults OFF for every role, managers and the office included', () => {
  assert.equal(SMS_ALERTS_DEFAULT, false);
  for (const role of ROLES) {
    assert.equal(smsAlertsEnabled(user({ role })), false, role);
    assert.equal(smsHoldReason({ user: user({ role }), eventKey: 'shiftMissed' }), 'switched-off', role);
  }
});
ok('a person\'s own setting still wins, either way (the Account switch stays)', () => {
  for (const role of ROLES) assert.equal(smsAlertsEnabled(user({ role, notificationPrefs: { smsAlertsEnabled: true } })), true, role);
  assert.equal(smsAlertsEnabled(user({ notificationPrefs: { smsAlertsEnabled: false } })), false);
});
ok('only the two named events text', () => {
  assert.equal(smsHoldReason({ user: texter(), eventKey: 'shiftMissed' }), null);
  assert.equal(smsHoldReason({ user: texter(), eventKey: 'ticketUrgent' }), null);
  assert.equal(smsHoldReason({ user: texter(), eventKey: 'shiftLate' }), 'not-an-sms-event'); // ALR-11 retired it
  assert.equal(smsHoldReason({ user: texter(), eventKey: 'problemReported' }), 'not-an-sms-event');
  assert.equal(smsHoldReason({ user: texter(), eventKey: 'newDM' }), 'not-an-sms-event');
});
ok('a disabled member, a switched-off member and one with no phone are not texted', () => {
  assert.equal(smsHoldReason({ user: texter({ status: 'disabled' }), eventKey: 'shiftMissed' }), 'inactive');
  assert.equal(smsHoldReason({ user: user({ notificationPrefs: { smsAlertsEnabled: false } }), eventKey: 'shiftMissed' }), 'switched-off');
  assert.equal(smsHoldReason({ user: texter({ phone: '' }), eventKey: 'shiftMissed' }), 'no-phone');
  assert.equal(smsHoldReason({ user: texter({ phone: 'x123' }), eventKey: 'shiftMissed' }), 'no-phone');
});
ok('an opted-out number stops texting, even with the switch on', () => {
  const out = user({ notificationPrefs: { smsAlertsEnabled: true, smsOptedOut: true } });
  assert.equal(isSmsOptedOut(out), true);
  assert.equal(smsHoldReason({ user: out, eventKey: 'shiftMissed' }), 'opted-out');
});
ok('the opt-out is keyed on Twilio\'s own error code', () => {
  assert.equal(TWILIO_OPTED_OUT_CODE, 21610);
});
ok('crew are not texted even about a missed shift', () => {
  assert.equal(smsHoldReason({ user: user({ role: 'crew' }), eventKey: 'shiftMissed' }), 'switched-off');
});

console.log('── E.164 and the text body ──');

ok('the profile\'s own shapes become E.164', () => {
  assert.equal(toE164('1-754-555-0103'), '+17545550103');
  assert.equal(toE164('(754) 555-0103'), '+17545550103');
  assert.equal(toE164('7545550103'), '+17545550103');
  assert.equal(toE164('+1 754 555 0103'), '+17545550103');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
});
ok('anything that cannot be made into one is refused, never guessed', () => {
  assert.equal(toE164('1234'), null);          // an extension
  assert.equal(toE164('555-0103'), null);      // 7 digits, no area code
  assert.equal(toE164(''), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164('+123'), null);          // shorter than E.164 allows
});
ok('the text names the brand and both halves of the alert', () => {
  const body = alertSmsBody({ wordmark: 'Clean Space', title: 'Missed shift: Las Olas', body: 'Scheduled 9:00 PM, no clock-in.' });
  assert.ok(body.startsWith('Clean Space: '));
  assert.ok(body.includes('Missed shift: Las Olas'));
  assert.ok(body.includes('no clock-in'));
});
ok('the text is bounded, and a bodyless alert still reads as a sentence', () => {
  const long = alertSmsBody({ wordmark: 'X', title: 'a'.repeat(400), body: 'b'.repeat(400) });
  assert.ok(long.length <= SMS_MAX_BODY, `${long.length} > ${SMS_MAX_BODY}`);
  assert.equal(alertSmsBody({ wordmark: 'X', title: 'Only a title' }), 'X: Only a title');
});
ok('the default quiet window is a night, not a working day', () => {
  assert.equal(QUIET_HOURS_DEFAULTS.quietHoursStart, '21:00');
  assert.equal(QUIET_HOURS_DEFAULTS.quietHoursEnd, '07:00');
});

if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${pass} passed, ${fails.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ alert delivery: ${pass} checks passed`);
}
