// What CHANGED in the shared alert plumbing for Matt's WO-6, NTF-2, NTF-1 and ALR-5
// (2026-09-29). Deliberately imports ONLY modules that existed BEFORE this change, so every
// check here fails on the pre-fix tree with a wrong-behaviour assertion rather than a missing
// file (THE LAW II.3): the walkers and the delivery policy are new modules and are pinned by
// their own suites (test-ticket-alerts, test-preshift-reminders, test-alert-delivery,
// test-alert-sms); this one pins the seams they hang off.
//
// Pure + offline: the qc store is imported for its EXPORTS only — nothing here calls Supabase.
// It is a "backend" suite (it imports ../api/…), so run-tests skips it on a stripped checkout.
//
//   node app/scripts/test-alert-routing.mjs
import assert from 'node:assert/strict';
import { applyOpsAlert } from '../src/lib/opsAlertApply.js';
import * as notifications from '../src/lib/notifications.js';
import * as roles from '../src/lib/roles.js';
import * as dates from '../src/lib/dates.js';
import * as qcStore from '../api/_lib/qc/store.js';

let pass = 0;
const fails = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

const NOW = Date.parse('2026-09-30T14:00:00.000Z'); // Wednesday 10:00 EDT
const state = (over = {}) => ({
  users: [
    { id: 'u_owner', name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
    { id: 'u_admin', name: 'Yolanda', role: 'admin', status: 'active', notificationPrefs: {} },
    { id: 'u_sup', name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} },
    { id: 'u_crew', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} },
  ],
  clients: [
    { id: 'cl_sup', name: 'Las Olas', supervisorId: 'u_sup' },
    { id: 'cl_none', name: 'No Sup Co', supervisorId: null },
  ],
  permissions: {}, userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
  ...over,
});
const recips = (rows) => [...new Set((rows || []).map((n) => n.userId))].sort();

console.log('\n── WO-6: a new ticket goes to the account\'s supervisor, the office when there is none ──');

ok('lib/notifications exports the supervisor-first rule', () => {
  assert.equal(typeof notifications.fanOutSupervisorFirst, 'function');
});
ok('with a supervisor it routes to them ALONE — not the whole bench', () => {
  const rows = notifications.fanOutSupervisorFirst(state(), {
    clientId: 'cl_sup', eventKey: 'problemReported', title: 'work order — Las Olas', body: 'Soap empty', url: '/x',
  });
  assert.deepEqual(recips(rows), ['u_sup']);
});
ok('with NO supervisor it blankets the office bench — never nobody', () => {
  const rows = notifications.fanOutSupervisorFirst(state(), {
    clientId: 'cl_none', eventKey: 'problemReported', title: 't', body: 'b', url: '/x',
  });
  assert.deepEqual(recips(rows), ['u_admin', 'u_owner', 'u_sup']);
});
ok('the person who filed the ticket is not told about their own', () => {
  const rows = notifications.fanOutSupervisorFirst(state(), {
    clientId: 'cl_sup', eventKey: 'problemReported', title: 't', body: 'b', url: '/x', actorUserId: 'u_sup',
  });
  assert.deepEqual(recips(rows), []);
});
ok('the server-side creation ping is notifyTicketRaised, and the old name is gone', () => {
  assert.equal(typeof qcStore.notifyTicketRaised, 'function');
  assert.equal(qcStore.notifyManagersOfProblem, undefined, 'replace means delete (II.5)');
});
ok('the cron\'s ticket read selects the origin, so a repeat can tell a customer\'s request (HUB-21, CS-639)', () => {
  assert.ok(qcStore.TICKET_ALERT_COLUMNS.split(',').map((c) => c.trim()).includes('origin'), qcStore.TICKET_ALERT_COLUMNS);
});
ok('the store exposes the two ticket-alert reads the cron needs', () => {
  assert.equal(typeof qcStore.openTicketsForAlerts, 'function');
  assert.equal(typeof qcStore.firstStaffReplyByProblem, 'function');
});

console.log('── applyOpsAlert: an OFFICE scope, an event key of its own, and a push-only alert ──');

ok('an `office`-scope alert reaches the whole office bench', () => {
  const res = applyOpsAlert(state(), {
    id: 'oa_ticketEscalate_t1', kind: 'ticketEscalate', eventKey: 'ticketUnanswered',
    recipientScope: 'office', clientId: 'cl_sup', refId: 't1', title: 't', body: 'b', url: '/x',
  }, { now: NOW });
  assert.deepEqual(recips(res.notifications), ['u_admin', 'u_owner', 'u_sup']);
});
ok('an alert\'s eventKey overrides its kind on the row (the dispatcher only sees the key)', () => {
  const res = applyOpsAlert(state(), {
    id: 'oa_ticketRepeat_t1_1', kind: 'ticketRepeat', eventKey: 'ticketUrgent',
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't1', title: 't', body: 'b', url: '/x',
  }, { now: NOW });
  assert.equal(res.notifications.length, 1);
  assert.equal(res.notifications[0].eventKey, 'ticketUrgent');
});
ok('an alert with no eventKey still uses its kind, exactly as before', () => {
  const res = applyOpsAlert(state(), {
    id: 'oa_shiftMissed_j1', kind: 'shiftMissed', recipientScope: 'supervisor',
    clientId: 'cl_sup', jobId: 'j1', title: 't', body: 'b', url: '/x',
  }, { now: NOW });
  assert.equal(res.notifications[0].eventKey, 'shiftMissed');
});
ok('a pushOnly alert records the marker and writes NO bell row', () => {
  // The CONTROL first: the same alert WITHOUT the flag, on an event key crew can see, does
  // produce a row. So this pair proves the FLAG is what suppresses it, not the event's gating.
  const alert = {
    id: 'oa_shiftReminder_j1_u_crew', kind: 'shiftReminder', eventKey: 'checklistDue',
    recipientScope: 'crew', clientId: 'cl_sup', jobId: 'j1', userId: 'u_crew', crewIds: ['u_crew'],
    title: 't', body: 'b', url: '/x',
  };
  const control = applyOpsAlert(state(), alert, { now: NOW });
  assert.equal(control.notifications.length, 1, 'control: this alert would reach the cleaner');
  const res = applyOpsAlert(state(), { ...alert, pushOnly: true }, { now: NOW });
  assert.equal(res.notifications.length, 0, 'no row per cleaner per shift in the shared record');
  assert.equal(res.opsAlertEvents.length, 1, 'the dedup marker is still recorded');
});
ok('a marker carries refId when the alert names one, and not otherwise', () => {
  const withRef = applyOpsAlert(state(), {
    id: 'oa_ticketRepeat_t2_1', kind: 'ticketRepeat', eventKey: 'ticketUnanswered',
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't2',
  }, { now: NOW });
  assert.equal(withRef.opsAlertEvents.at(-1).refId, 't2');
  const without = applyOpsAlert(state(), {
    id: 'oa_shiftMissed_j2', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_sup', jobId: 'j2',
  }, { now: NOW });
  assert.equal('refId' in without.opsAlertEvents.at(-1), false, 'the existing marker shape is unchanged');
});

console.log('── The catalog and the prefs the new channels need ──');

ok('the two ticket toggles exist, office-gated, with descriptions', () => {
  const items = notifications.NOTIFICATION_GROUPS.flatMap((g) => g.items);
  for (const key of ['ticketUrgent', 'ticketUnanswered']) {
    const item = items.find((i) => i.key === key);
    assert.ok(item, `${key} is missing from the catalog`);
    assert.deepEqual(item.roleAllowlist, ['owner', 'admin', 'manager'], key);
    assert.ok(item.description, `${key} needs a description`);
    assert.equal(item.defaultOff, undefined, `${key} must be opt-out, like every other alert`);
  }
});
ok('both ticket toggles are visible to the office and hidden from crew', () => {
  const office = { id: 'u_sup', role: 'manager' };
  const crew = { id: 'u_crew', role: 'crew' };
  for (const key of ['ticketUrgent', 'ticketUnanswered']) {
    assert.equal(notifications.isNotificationVisibleForUser(key, office, {}, []), true, key);
    assert.equal(notifications.isNotificationVisibleForUser(key, crew, {}, []), false, key);
  }
});
ok('they are opt-out: an un-backfilled prefs object reads them as ON', () => {
  for (const key of ['ticketUrgent', 'ticketUnanswered']) {
    assert.equal(notifications.isNotificationEnabled({}, key), true, key);
    assert.equal(notifications.isNotificationEnabled({ [key]: false }, key), false, key);
  }
});
ok('the delivery prefs are exempt from the crew mandatory-mute rule', () => {
  const crew = { id: 'u_crew', role: 'crew' };
  const patch = roles.applyMandatoryNotificationPolicy(crew, {
    quietHoursEnabled: false, quietHoursStart: '21:00', quietHoursEnd: '07:00',
    smsAlertsEnabled: false, smsOptedOut: false, smsOptedOutAt: null,
  });
  assert.deepEqual(Object.keys(patch).sort(), [
    'quietHoursEnabled', 'quietHoursEnd', 'quietHoursStart', 'smsAlertsEnabled', 'smsOptedOut', 'smsOptedOutAt',
  ]);
});
ok('…while an event mute from a crew member is still refused', () => {
  const patch = roles.applyMandatoryNotificationPolicy({ id: 'u', role: 'crew' }, { ticketUrgent: false, shiftMissed: false });
  assert.deepEqual(patch, {});
});

console.log('── The minute-of-day reader office hours and quiet hours are built on ──');

ok('minutesInZone reads the wall clock of the ORG zone, not the process zone', () => {
  assert.equal(typeof dates.minutesInZone, 'function');
  // 14:00 UTC is 10:00 in New York and 23:00 in Tokyo.
  assert.equal(dates.minutesInZone(NOW, 'America/New_York'), 10 * 60);
  assert.equal(dates.minutesInZone(NOW, 'Asia/Tokyo'), 23 * 60);
});
ok('it keeps minute precision, so 08:30 is expressible', () => {
  assert.equal(dates.minutesInZone(Date.parse('2026-09-30T12:30:00.000Z'), 'America/New_York'), 8 * 60 + 30);
});

if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${pass} passed, ${fails.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ alert routing seams: ${pass} checks passed`);
}
