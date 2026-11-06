// CS-056 regression: the post-service customer reminder must fire on the status a
// clean actually reaches.
//
// `reminderScheduler.shouldFire` gated post_service on `job.status === 'completed'`.
// Nothing in this app ever writes 'completed' — SET_JOB_STATUS and every UI path use
// JOB_STATUS.DONE — so enabling the template did nothing. test-reminder-cron.mjs passed
// 36/36 because its fixtures restated the same wrong literal, which is why this suite
// asserts against the VOCABULARY CONSTANT (src/lib/jobStatus.js) and never a literal
// typed here (THE LAW II.3).
//
// Since Matt's approved messages (2026-10-19) the walkers are `getDueMessages` and the
// finished-clean messages are two: the first-clean check-in (post_service, its history check
// done by the cron) and the visit summary. Both wait on the SAME finished status.
//
// Run: node app/scripts/test-post-service-status.mjs
import { getDueMessages } from '../src/lib/reminderScheduler.js';
import { EVENT_MAX_AGE_HOURS, CUSTOMER_SEND_HOURS } from '../src/lib/customerMessages.js';
import { JOB_STATUS, JOB_STATUS_LABELS, JOB_STATUS_VALUES, LEGACY_DONE_ALIAS, isCompletedJobStatus } from '../src/lib/jobStatus.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

// 19:00 UTC = 12:00 America/Los_Angeles — inside POST_SERVICE_SEND_HOURS, whose bounds
// are read from the module rather than restated.
const NOW = new Date('2026-07-12T19:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

const stateWith = (status) => ({
  company: { name: 'Clean Space', email: 'office@cs.test', timezone: 'America/Los_Angeles' },
  reminderTemplates: [
    { id: 't_ps', key: 'post_service', channel: 'email', subject: 'How was it', body: 'Thanks {client_contact}', enabled: true },
    { id: 't_vs', key: 'visit_summary', channel: 'email', subject: 'Cleaned', body: 'Done at {site_name}', enabled: true },
  ],
  clients: [{ id: 'cl1', name: 'Acme', email: 'acme@corp.test', primaryContactId: 'ct1' }],
  contacts: [{ id: 'ct1', firstName: 'Ann', lastName: 'Acme', email: 'ann@corp.test' }],
  sites: [{ id: 's1', name: 'HQ' }],
  services: [{ id: 'sv1', name: 'Janitorial' }],
});
const jobsWith = (status, h = 3) => [{ id: 'jDone', clientId: 'cl1', siteId: 's1', serviceId: 'sv1', status, startAt: hoursAgo(h), endAt: hoursAgo(h), createdAt: hoursAgo(h + 2) }];
const dueAt = (status, now = NOW, h = 3) => getDueMessages({ state: stateWith(status), jobs: jobsWith(status, h) }, now);
const postServiceDue = (status) => dueAt(status).filter((d) => d.templateKey === 'post_service');

console.log('CS-056 — post_service fires on the real clean status\n');

// 1. THE DEFECT. A clean that finished 3h ago, in civil hours, with an enabled template
//    and a contact email, must be due. Pre-fix this returned [] because the guard waited
//    for a status no clean ever holds.
ok(postServiceDue(JOB_STATUS.DONE).length === 1,
  `post_service is due for a clean whose status is JOB_STATUS.DONE ('${JOB_STATUS.DONE}')`);
ok(postServiceDue(JOB_STATUS.DONE)[0]?.recipient === 'ann@corp.test',
  'the due reminder resolves the contact email as its recipient');

// 2. The vocabulary itself: 'completed' is NOT one of the statuses this app writes, so a
//    guard that waits for it can never match a real clean. This is the assertion that
//    makes the defect a rule rather than a one-off.
ok(!JOB_STATUS_VALUES.includes(LEGACY_DONE_ALIAS),
  `'${LEGACY_DONE_ALIAS}' is not in the clean-status vocabulary`);
ok(JOB_STATUS_VALUES.includes(JOB_STATUS.DONE),
  'JOB_STATUS.DONE is in the clean-status vocabulary');
ok(JOB_STATUS_VALUES.every((v) => typeof JOB_STATUS_LABELS[v] === 'string' && JOB_STATUS_LABELS[v].length > 0),
  'every status value has a display label');

// 3. The legacy alias is still TOLERATED on read (lib/opsAlerts.js TERMINAL_JOB does the
//    same), so a hand-patched or imported row carrying the older word is not stranded.
ok(isCompletedJobStatus(JOB_STATUS.DONE) && isCompletedJobStatus(LEGACY_DONE_ALIAS),
  'isCompletedJobStatus accepts the real status and the legacy alias');
ok(!isCompletedJobStatus(JOB_STATUS.IN_PROGRESS) && !isCompletedJobStatus(JOB_STATUS.CANCELLED),
  'isCompletedJobStatus rejects in-progress and cancelled');
ok(postServiceDue(LEGACY_DONE_ALIAS).length === 1,
  'a legacy-alias row is still followed up (read-side tolerance)');

// 4. No OTHER status fires it — fixing the match must not widen it.
for (const st of JOB_STATUS_VALUES.filter((v) => v !== JOB_STATUS.DONE)) {
  ok(postServiceDue(st).length === 0, `post_service is not due for status '${st}'`);
}

// 5. The freshness + civil-hour guards still hold, asserted against the exported
//    constants so retuning either one cannot silently invalidate this suite.
const tooOldHours = EVENT_MAX_AGE_HOURS + 1;
ok(dueAt(JOB_STATUS.DONE, NOW, tooOldHours).length === 0,
  `a clean finished older than EVENT_MAX_AGE_HOURS (${EVENT_MAX_AGE_HOURS}h) is not due`);

// One minute before the window opens, in the org's zone: 08:59 PT = 15:59 UTC.
const beforeOpen = new Date(Date.UTC(2026, 6, 12, CUSTOMER_SEND_HOURS.from + 7, -1, 0));
ok(dueAt(JOB_STATUS.DONE, beforeOpen).length === 0,
  'a clean is not due before CUSTOMER_SEND_HOURS.from in the org zone');

// 6. The visit summary waits on the same finished status, and only on it.
ok(dueAt(JOB_STATUS.DONE).some((d) => d.templateKey === 'visit_summary'), 'the visit summary is due for a JOB_STATUS.DONE clean');
for (const st of JOB_STATUS_VALUES.filter((v) => v !== JOB_STATUS.DONE)) {
  ok(!dueAt(st).some((d) => d.templateKey === 'visit_summary'), `the visit summary is not due for status '${st}'`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
