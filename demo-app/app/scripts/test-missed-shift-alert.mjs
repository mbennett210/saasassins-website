// ALR-11 + ALR-12 (Matt, 2026-09-30 follow-up) — ONE missed-shift alert.
//
//   ALR-11  "One alert 30 minutes after the start with no clock-in: that's a missed shift,
//           and the supervisor gets a notification and a text."
//           So the two-stage late(start+10) / missed(END+15) pair is GONE: one alert, timed
//           off the scheduled START, fired while the clean is still running.
//   ALR-12  "the person copied on every missed alert is the account manager/supervisor of
//           the account" — which is `client.supervisorId`, who already receives it. The
//           org-wide "operations manager" picker (ALR-4) is therefore REPLACED, not kept.
//
// Everything is asserted against the SOURCE constant (OPS_ALERT_DEFAULTS /
// missedAfterStartMins), never a restated 30, so retuning the setting retunes the suite.
//
//   node app/scripts/test-missed-shift-alert.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => { try { return readFileSync(root(p), 'utf8'); } catch { return ''; } };

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const call = (fn, ...a) => { try { return fn(...a); } catch (e) { return `threw: ${e?.message || e}`; } };

const opsAlerts = await import('../src/lib/opsAlerts.js');
const {
  OPS_ALERT_DEFAULTS, getDueShiftAlerts, isMissedClean, opsAlertId,
  missedAfterStartMins, MAX_MISSED_AFTER_START_MINS,
} = opsAlerts;
const { applyOpsAlert } = await import('../src/lib/opsAlertApply.js');
const { opsAlertCopy: opsAlertCopyMessages } = await import('../src/lib/opsAlertCopy.js');
const { renderText } = await import('../src/i18n/core.js');
// CS-193: the alert copy is catalog MESSAGES now, rendered for each recipient in their own
// language by the fan-out. Read here in English — the catalog's English is the source of truth.
const opsAlertCopy = (...a) => {
  const c = opsAlertCopyMessages(...a);
  return { ...c, title: renderText(c.title, 'en'), body: renderText(c.body, 'en') };
};
const {
  ALWAYS_PUSH_EVENT_KEYS, SMS_ALERT_EVENT_KEYS, pushHoldReason, smsHoldReason,
} = await import('../src/lib/alertDelivery.js');
const { NOTIFICATION_GROUPS } = await import('../src/lib/notifications.js');
const { computeAttendanceReport, ATT_NO_PUNCH, ATT_UPCOMING } = await import('../src/lib/attendanceReport.js');
const { sweepUserOrphans } = await import('../src/lib/deleteCascade.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-03T16:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
// Matt's own number, stated once so A1 can pin the SOURCE default against it — and used
// as the fallback below purely so that on a tree where the reader does not exist yet the
// rest of the suite still runs and fails honestly instead of ending on line one.
const SPEC_MINUTES = 30;
// THE number, read from the source. Every timing below is built from it.
const rawN = call(missedAfterStartMins, {});
const N = Number.isFinite(rawN) ? rawN : SPEC_MINUTES;

// ═══════════════ A · one setting, one rule, timed off the START ═══════════════
console.log('── ALR-11: one alert, N minutes after the scheduled start ──');

eq('A1: the shipped default is Matt’s 30 minutes', OPS_ALERT_DEFAULTS.missedAfterStartMins, SPEC_MINUTES);
eq('A2: the reader answers the default for an empty blob', rawN, OPS_ALERT_DEFAULTS.missedAfterStartMins);
eq('A3: the retired late grace is gone from the defaults', 'lateAlertGraceMins' in OPS_ALERT_DEFAULTS, false);
eq('A4: …and so is the end-based missed grace', 'missedShiftGraceMins' in OPS_ALERT_DEFAULTS, false);
eq('A5: an operator value is honoured', call(missedAfterStartMins, { missedAfterStartMins: 5 }), 5);
eq('A6: 0 means "the moment the start passes"', call(missedAfterStartMins, { missedAfterStartMins: 0 }), 0);
eq('A7: a negative value clamps to 0', call(missedAfterStartMins, { missedAfterStartMins: -10 }), 0);
eq('A8: a nonsense value falls back', call(missedAfterStartMins, { missedAfterStartMins: 'soon' }), OPS_ALERT_DEFAULTS.missedAfterStartMins);
ok('A9: there is a ceiling', Number.isFinite(MAX_MISSED_AFTER_START_MINS) && MAX_MISSED_AFTER_START_MINS > 0);
eq('A10: …and it is applied', call(missedAfterStartMins, { missedAfterStartMins: 10 ** 9 }), MAX_MISSED_AFTER_START_MINS);

// A clean that is STILL RUNNING. Under the old rule nothing fired until the scheduled END
// had passed plus a second grace; under ALR-11 it is a missed shift at start + N.
const runningClean = (over = {}) => ({
  id: 'j_run', clientId: 'cl_a', siteId: 's1', status: 'upcoming', crewIds: ['u_c1'],
  startAt: iso(NOW - (N + 1) * MIN), endAt: iso(NOW + 4 * HOUR), ...over,
});
const walk = (jobs, settings = {}, firedIds = new Set()) =>
  getDueShiftAlerts({ jobs, coveredJobIds: new Set(), firedIds, now: NOW, settings });

{
  const due = walk([runningClean()]);
  eq('A11: a clean un-clocked N minutes past its start is MISSED, mid-shift',
    [due.length, due[0]?.kind], [1, 'shiftMissed']);
  eq('A12: …with the deterministic per-job id', due[0]?.id, opsAlertId('shiftMissed', 'j_run'));
  eq('A13: …routed to the account supervisor', due[0]?.recipientScope, 'supervisor');
}
{
  const due = walk([runningClean({ startAt: iso(NOW - (N - 1) * MIN) })]);
  eq('A14: a minute BEFORE the mark, nothing fires', due, []);
}
{
  const due = walk([runningClean({ startAt: iso(NOW + 5 * MIN) })]);
  eq('A15: a clean that has not started cannot be missed', due, []);
}
{
  const due = getDueShiftAlerts({
    jobs: [runningClean()], coveredJobIds: new Set(['j_run']), firedIds: new Set(), now: NOW, settings: {},
  });
  eq('A16: somebody clocked in → never missed', due, []);
}
{
  const due = walk([runningClean()], {}, new Set([opsAlertId('shiftMissed', 'j_run')]));
  eq('A17: it fires at most ONCE per clean', due, []);
}
{
  const due = walk([runningClean({ startAt: iso(NOW - 6 * MIN) })], { missedAfterStartMins: 5 });
  eq('A18: the operator setting moves the mark', [due.length, due[0]?.kind], [1, 'shiftMissed']);
}
{
  const done = walk([runningClean({ status: 'done' })]);
  const cancelled = walk([runningClean({ status: 'cancelled' })]);
  const started = walk([runningClean({ status: 'in_progress' })]);
  eq('A19: a finished / cancelled / underway clean is never missed',
    [done.length, cancelled.length, started.length], [0, 0, 0]);
}
{
  // The back-blast guard is unchanged: only a clean inside the look-back can alert.
  const old = walk([runningClean({ startAt: iso(NOW - 40 * HOUR), endAt: iso(NOW - 38 * HOUR) })]);
  eq('A20: a clean older than the look-back still never alerts', old, []);
}

// ═══════════════ B · "late" is gone, everywhere ═══════════════
console.log('── ALR-11: the "late" alert and its setting are deleted ──');

{
  // A clean every shape of old-late: 11 minutes past the start (the old 10-minute grace).
  const due = walk([runningClean({ startAt: iso(NOW - 11 * MIN) })], { missedAfterStartMins: 60 });
  eq('B1: 11 minutes late raises NOTHING now the one mark is an hour out', due, []);
}
eq('B2: the walker emits only the one kind',
  [...new Set(walk([runningClean()]).map((a) => a.kind))], ['shiftMissed']);
eq('B3: the copy module answers nothing for the retired kind',
  call(opsAlertCopy, { kind: 'shiftLate' }, 'Coral Bay').title, 'Operational alert');
ok('B4: the missed copy still names the customer and the time',
  /Coral Bay/.test(call(opsAlertCopy, { kind: 'shiftMissed', scheduledStart: iso(NOW) }, 'Coral Bay').title));

const NO_LATE_FILES = [
  'src/lib/opsAlerts.js', 'src/lib/opsAlertApply.js', 'src/lib/opsAlertCopy.js',
  'src/lib/alertDelivery.js', 'src/lib/notifications.js',
  'src/components/MobileNotificationList.jsx', 'src/pages/settings/Operations.jsx',
  'src/data/seed.js', 'src/lib/attendanceReport.js', 'src/pages/Approvals.jsx',
  'src/pages/reports/AttendanceReport.jsx',
];
for (const f of NO_LATE_FILES) {
  const src = read(f);
  ok(`B5: ${f} no longer names shiftLate`, !src.includes('shiftLate'));
  ok(`B6: ${f} no longer reads lateAlertGraceMins`, !src.includes('lateAlertGraceMins'));
  ok(`B7: ${f} no longer reads missedShiftGraceMins`, !src.includes('missedShiftGraceMins'));
}
ok('B8: the notification catalog offers no "late" toggle',
  !NOTIFICATION_GROUPS.some((g) => (g.items || []).some((i) => i.key === 'shiftLate')));
ok('B9: …and still offers the missed one',
  NOTIFICATION_GROUPS.some((g) => (g.items || []).some((i) => i.key === 'shiftMissed')));

// ═══════════════ C · the supervisor hears it: push + bell + text ═══════════════
console.log('── ALR-11/ALR-12: the account supervisor, through quiet hours, with a text ──');

const user = (id, role, over = {}) => ({
  id, role, status: 'active', name: id, phone: '754-555-0101',
  notificationPrefs: { shiftMissed: true, mobilePushEnabled: true, ...(over.notificationPrefs || {}) },
  ...over,
});
const state = (opsSettings = {}, { supervisorId = 'u_spoc', users = null } = {}) => ({
  users: users || [user('u_owner', 'owner'), user('u_spoc', 'manager')],
  clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId }],
  permissions: [], userPermissionOverrides: [], notifications: [], opsAlertEvents: [],
  opsSettings,
});
const missedAlert = (over = {}) => ({
  id: 'oa_shiftMissed_j1', kind: 'shiftMissed', recipientScope: 'supervisor',
  clientId: 'cl_a', jobId: 'j1', title: 't', body: 'b', url: '/u', ...over,
});
const recipients = (s, alert) => {
  const out = applyOpsAlert(s, alert, { now: NOW });
  return [...new Set((out?.notifications || []).map((n) => n.userId))].sort();
};

eq('C1: the alert reaches the account supervisor (and the one shared owner login)',
  recipients(state(), missedAlert()), ['u_owner', 'u_spoc']);
eq('C2: with no supervisor it blankets the office bench rather than going silent',
  recipients(state({}, { supervisorId: null }), missedAlert()).length > 0, true);
eq('C3: it breaks through a manager\'s quiet hours', ALWAYS_PUSH_EVENT_KEYS.has('shiftMissed'), true);
eq('C4: …proven on a muted recipient at 2 a.m.',
  pushHoldReason({
    user: user('u_spoc', 'manager', { notificationPrefs: { quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '07:00' } }),
    eventKey: 'shiftMissed', at: Date.parse('2026-10-03T02:00:00.000Z'), tz: 'UTC',
  }), null);
eq('C5: it also goes out as a TEXT', SMS_ALERT_EVENT_KEYS.has('shiftMissed'), true);
eq('C6: …with nothing holding it for a supervisor who has a phone and turned "Text me alerts" on (off by default, 2026-10-28)',
  smsHoldReason({ user: user('u_spoc', 'manager', { notificationPrefs: { smsAlertsEnabled: true } }), eventKey: 'shiftMissed' }), null);
eq('C6b: …and a supervisor who never turned it on is not texted',
  smsHoldReason({ user: user('u_spoc', 'manager'), eventKey: 'shiftMissed' }), 'switched-off');
eq('C7: the retired kind is in neither delivery set',
  [ALWAYS_PUSH_EVENT_KEYS.has('shiftLate'), SMS_ALERT_EVENT_KEYS.has('shiftLate')], [false, false]);

// ═══════════════ D · ALR-12: the org-wide operations manager is replaced ═══════════════
console.log('── ALR-12: the account supervisor IS the person copied; the picker is gone ──');

eq('D1: the setting is gone from the defaults', 'operationsManagerUserId' in OPS_ALERT_DEFAULTS, false);
eq('D2: there is no reader left to export', typeof opsAlerts.operationsManagerId, 'undefined');
eq('D3: the seed ships no such key', read('src/data/seed.js').includes('operationsManagerUserId'), false);
eq('D4: Settings → Operations offers no picker', read('src/pages/settings/Operations.jsx').includes('operationsManagerUserId'), false);
eq('D5: the apply path copies nobody extra', read('src/lib/opsAlertApply.js').includes('operationsManagerId'), false);
eq('D6: the DELETE_USER sweep no longer clears it', read('src/lib/deleteCascade.js').includes('operationsManagerUserId'), false);
// …but the server guard stays TOLERANT of a value still stored somewhere, so a save that
// clears a legacy one on a member removal is not refused (and the batch is not dropped).
ok('D7: orgStateGuard still tolerates a legacy stored value in its cascade carve-out',
  read('../app/api/_lib/orgStateGuard.js').includes("'operationsManagerUserId'"));
{
  // A DELETE_USER cascade must leave opsSettings alone now, even when the departing member
  // is named by a legacy key: nothing reads it, so moving a `time.config`-gated slice for it
  // would be a save nobody asked for.
  const before = {
    users: [user('u_owner', 'owner'), user('u_gone', 'manager')],
    clients: [], opsSettings: { missedAfterStartMins: 30, operationsManagerUserId: 'u_gone' },
    notifications: [], reimbursements: [], payrollLines: [],
  };
  const after = call(sweepUserOrphans, before, 'u_gone');
  eq('D8: removing that member does not touch opsSettings',
    JSON.stringify(after?.opsSettings ?? before.opsSettings), JSON.stringify(before.opsSettings));
}

// ═══════════════ E · ONE definition of "missed", shared by every counter ═══════════════
console.log('── ALR-11: the KPI, the report and the alert share one definition ──');

{
  const job = runningClean();
  eq('E1: isMissedClean agrees with the walker mid-shift',
    call(isMissedClean, job, new Set(), NOW, {}), true);
  eq('E2: …and not a minute before the mark',
    call(isMissedClean, { ...job, startAt: iso(NOW - (N - 1) * MIN) }, new Set(), NOW, {}), false);
  eq('E3: …and never when somebody clocked in',
    call(isMissedClean, job, new Set(['j_run']), NOW, {}), false);
  eq('E4: …and it honours the operator setting',
    call(isMissedClean, { ...job, startAt: iso(NOW - 6 * MIN) }, new Set(), NOW, { missedAfterStartMins: 5 }), true);
}
ok('E5: the Dashboard missed-cleans KPI passes opsSettings into the one rule',
  /isMissedClean\([^)]*opsSettings/.test(read('src/store/selectors.js').replace(/\s+/g, ' ')));

{
  // The attendance report's "No punch" is the same question, so it rides the same number.
  const jobs = [{ id: 'j_a', clientId: 'cl_a', siteId: 's1', status: 'upcoming', crewIds: ['u_c1'], startAt: iso(NOW - (N + 1) * MIN), endAt: iso(NOW + 4 * HOUR) }];
  const rows = computeAttendanceReport({ jobs, timeEntries: [], now: NOW, fromMs: NOW - 12 * HOUR, toMs: NOW + 12 * HOUR });
  eq('E6: the report reads it as No punch on its own default', rows[0]?.status, ATT_NO_PUNCH);
  const early = computeAttendanceReport({
    jobs: [{ ...jobs[0], startAt: iso(NOW - (N - 1) * MIN) }], timeEntries: [], now: NOW, fromMs: NOW - 12 * HOUR, toMs: NOW + 12 * HOUR,
  });
  eq('E7: …and Not started a minute earlier', early[0]?.status, ATT_UPCOMING);
}
ok('E8: the attendance report takes its default from the one source',
  /OPS_ALERT_DEFAULTS\.missedAfterStartMins/.test(read('src/lib/attendanceReport.js')));
for (const f of ['src/pages/Approvals.jsx', 'src/pages/reports/AttendanceReport.jsx']) {
  ok(`E9: ${f} passes the one setting`, /missedAfterStartMins/.test(read(f)));
}

// ═══════════════ F · Settings → Operations: ONE field ═══════════════
{
  const ops = read('src/pages/settings/Operations.jsx');
  ok('F1: the shift-alert card has the one field', ops.includes('missedAfterStartMins'));
  eq('F2: …and only one input for it', (ops.match(/form\.missedAfterStartMins/g) || []).length, 2); // value + onChange
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
