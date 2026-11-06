// Pre-shift reminders — ALR-5 ★ (Matt, 2026-09-29): "Should cleaners get a reminder before
// each shift? — (a) Yes, 30 minutes before."
//
// Pins the walker (src/lib/preShiftReminders) AND the thing that keeps it out of the shared
// record: it is a PUSH, so applyOpsAlert must record the dedup marker and create NO bell row,
// and that marker must be retained on the lead-time horizon rather than for ever.
// Pure + offline.
//
//   node app/scripts/test-preshift-reminders.mjs
import assert from 'node:assert/strict';

const {
  getDuePreShiftReminders, preShiftReminderId, preShiftReminderMins, MAX_PRESHIFT_LEAD_MINS,
} = await import('../src/lib/preShiftReminders.js');
const { OPS_ALERT_DEFAULTS } = await import('../src/lib/opsAlerts.js');
const { applyOpsAlert } = await import('../src/lib/opsAlertApply.js');
const { opsAlertCopy: opsAlertCopyMessages } = await import('../src/lib/opsAlertCopy.js');
const { renderText } = await import('../src/i18n/core.js');
// CS-193: the alert copy is catalog MESSAGES now, rendered for each recipient in their own
// language by the fan-out. Read here in English — the catalog's English is the source of truth.
const opsAlertCopy = (...a) => {
  const c = opsAlertCopyMessages(...a);
  return { ...c, title: renderText(c.title, 'en'), body: renderText(c.body, 'en') };
};

let pass = 0;
const fails = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-30T14:00:00.000Z');
const LEAD = OPS_ALERT_DEFAULTS.preShiftReminderMins;

const job = (over = {}) => ({
  id: 'j_real1', clientId: 'cl_real', siteId: 'st_1', status: 'upcoming',
  crewIds: ['u_crew1'], startAt: new Date(NOW + LEAD * MIN).toISOString(),
  ...over,
});
const walk = (over = {}) => getDuePreShiftReminders({ jobs: [job(over.job || {})], now: NOW, ...(over.args || {}) });

console.log('\n── ALR-5: 30 minutes before, once per shift, per cleaner ──');

ok('the default lead is Matt\'s 30 minutes', () => {
  assert.equal(OPS_ALERT_DEFAULTS.preShiftReminderMins, 30);
  assert.equal(preShiftReminderMins({}), 30);
});
ok('a clean starting exactly the lead away is due', () => {
  const due = walk();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, preShiftReminderId('j_real1', 'u_crew1'));
  assert.equal(due[0].kind, 'shiftReminder');
  assert.equal(due[0].userId, 'u_crew1');
});
ok('a clean further out than the lead is not due yet', () => {
  assert.deepEqual(walk({ job: { startAt: new Date(NOW + (LEAD + 1) * MIN).toISOString() } }), []);
});
ok('a clean that has already STARTED is the late alert\'s problem, not this one', () => {
  assert.deepEqual(walk({ job: { startAt: new Date(NOW).toISOString() } }), []);
  assert.deepEqual(walk({ job: { startAt: new Date(NOW - MIN).toISOString() } }), []);
});
ok('one reminder per CLEANER on the clean', () => {
  const due = walk({ job: { crewIds: ['u_crew1', 'u_crew2'] } });
  assert.deepEqual(due.map((d) => d.userId).sort(), ['u_crew1', 'u_crew2']);
  assert.deepEqual(due.map((d) => d.crewIds), [['u_crew1'], ['u_crew2']]);
});
ok('the marker id is per (clean, cleaner), so a cleaner on two cleans gets two', () => {
  const due = getDuePreShiftReminders({
    jobs: [job(), job({ id: 'j_real2' })], now: NOW,
  });
  assert.deepEqual(due.map((d) => d.id).sort(), [
    preShiftReminderId('j_real1', 'u_crew1'), preShiftReminderId('j_real2', 'u_crew1'),
  ].sort());
});
ok('an already-sent reminder is a no-op', () => {
  const firedIds = new Set([preShiftReminderId('j_real1', 'u_crew1')]);
  assert.deepEqual(walk({ args: { firedIds } }), []);
});
ok('the lead is a SETTING, and 0 turns it off', () => {
  const far = { startAt: new Date(NOW + 90 * MIN).toISOString() };
  assert.deepEqual(walk({ job: far }), []);
  assert.equal(walk({ job: far, args: { settings: { preShiftReminderMins: 120 } } }).length, 1);
  assert.deepEqual(walk({ args: { settings: { preShiftReminderMins: 0 } } }), []);
});
ok('the lead is clamped at a day, so a typo cannot make every booking due', () => {
  assert.equal(preShiftReminderMins({ preShiftReminderMins: 99999 }), MAX_PRESHIFT_LEAD_MINS);
  assert.equal(preShiftReminderMins({ preShiftReminderMins: -5 }), 0);
});
ok('a cancelled or finished clean reminds nobody', () => {
  for (const status of ['cancelled', 'done', 'completed', 'in_progress']) {
    assert.deepEqual(walk({ job: { status } }), [], status);
  }
});
ok('someone who already clocked in is not told their shift is about to start', () => {
  assert.deepEqual(walk({ args: { coveredJobIds: new Set(['j_real1']) } }), []);
});
ok('a cleaner off the roster is skipped; an absent roster judges everyone', () => {
  assert.deepEqual(walk({ args: { activeUserIds: new Set(['u_other']) } }), []);
  assert.equal(walk({ args: { activeUserIds: null } }).length, 1);
});
ok('a SEED clean reminds nobody (CS-030)', () => {
  assert.deepEqual(walk({ job: { id: 'j_seed_lasolas_1' } }), []);
  assert.deepEqual(walk({ job: { id: 'j_bkseed_st1_3' } }), []);
});
ok('a clean with no crew, or a broken start time, is skipped', () => {
  assert.deepEqual(walk({ job: { crewIds: [] } }), []);
  assert.deepEqual(walk({ job: { startAt: 'not-a-date' } }), []);
});

console.log('── It is a PUSH, not a bell row ──');

const state = () => ({
  users: [{ id: 'u_crew1', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} }],
  clients: [{ id: 'cl_real', name: 'Las Olas', supervisorId: null }],
  permissions: {}, userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
});

ok('applyOpsAlert records the marker and creates NO notification row', () => {
  const al = walk()[0];
  const res = applyOpsAlert(state(), { ...al, title: 'Your shift starts soon', body: 'Las Olas', url: '/my-day' }, { now: NOW });
  assert.ok(res, 'the alert is applied');
  assert.equal(res.notifications.length, 0, 'no bell row');
  assert.equal(res.opsAlertEvents.length, 1);
  assert.equal(res.opsAlertEvents[0].id, al.id);
});
ok('a second apply of the same reminder is a no-op (idempotent across cron runs)', () => {
  const al = walk()[0];
  const first = applyOpsAlert(state(), { ...al, title: 't' }, { now: NOW });
  const st = { ...state(), opsAlertEvents: first.opsAlertEvents };
  assert.equal(applyOpsAlert(st, { ...al, title: 't' }, { now: NOW }), null);
});
ok('the marker is pruned on the lead-time horizon, not kept for days', () => {
  const stale = {
    ...state(),
    opsAlertEvents: [{
      id: preShiftReminderId('j_old', 'u_crew1'), kind: 'shiftReminder',
      clientId: 'cl_real', jobId: 'j_old', firedAt: new Date(NOW - 6 * HOUR).toISOString(),
    }],
  };
  const al = walk()[0];
  const res = applyOpsAlert(stale, { ...al, title: 't' }, { now: NOW });
  assert.equal(res.opsAlertEvents.some((e) => e.jobId === 'j_old'), false, 'the 6-hour-old marker is gone');
  assert.equal(res.opsAlertEvents.length, 1);
});
ok('…and a marker still inside the horizon is kept', () => {
  const fresh = {
    ...state(),
    opsAlertEvents: [{
      id: preShiftReminderId('j_recent', 'u_crew1'), kind: 'shiftReminder',
      clientId: 'cl_real', jobId: 'j_recent', firedAt: new Date(NOW - 20 * MIN).toISOString(),
    }],
  };
  const al = walk()[0];
  const res = applyOpsAlert(fresh, { ...al, title: 't' }, { now: NOW });
  assert.equal(res.opsAlertEvents.length, 2);
});
ok('a SHIFT marker is not pruned by the pre-shift horizon', () => {
  const st = {
    ...state(),
    opsAlertEvents: [{
      id: 'oa_shiftMissed_j_old', kind: 'shiftMissed', clientId: 'cl_real', jobId: 'j_old',
      firedAt: new Date(NOW - 6 * HOUR).toISOString(),
    }],
  };
  const al = walk()[0];
  const res = applyOpsAlert(st, { ...al, title: 't' }, { now: NOW });
  assert.ok(res.opsAlertEvents.some((e) => e.id === 'oa_shiftMissed_j_old'));
});
ok('the banner copy names the time and the customer', () => {
  const al = walk()[0];
  const copy = opsAlertCopy(al, 'Las Olas');
  assert.ok(/shift starts/i.test(copy.title), copy.title);
  assert.ok(copy.body.includes('Las Olas'), copy.body);
  assert.equal(copy.url, `/schedule/${al.jobId}`);
});

if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${pass} passed, ${fails.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ pre-shift reminders: ${pass} checks passed`);
}
