// Account-supervisor notification routing — the "single point of contact"
// behaviour behind `client.supervisorId`. Verifies fanOutAccountAlert routes an
// account-scoped alert to ONLY the account's valid, willing supervisor, and (NOTIF-02,
// owner decision 2026-09-16) sends NO notification when there is no available SPOC
// (none set, demoted/inactive, muted, actor-is-supervisor) — the event stays captured on
// its own surface (e.g. the Work Order in the Quality queue), NOT a manager blanket. Pure
// client-side helpers, offline-safe. fanOutAccountAlert is the shared account-alert router
// (RAISE_OPS_ALERT uses it today); this pins its narrowing invariant with a representative
// account event.
//
// INVARIANT (playbook II.3): fanOutManagerAlert BLANKETS the whole manager bench, while
// fanOutAccountAlert NARROWS to the account's SPOC. The "BEFORE vs AFTER" block pins that
// the blanket notifies a non-supervisor manager and the narrow path does NOT — the
// assertion that fails against a blanket helper and passes against the narrow one.
//
// Usage: node scripts/test-notif-supervisor.mjs

import assert from 'node:assert/strict';
import {
  fanOutAccountAlert,
  fanOutManagerAlert,
  resolveAccountSupervisor,
} from '../src/lib/notifications.js';

let pass = 0;
function ok(label, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${label}`);
}

// problemReported: roleAllowlist owner/admin/manager, no requiresPermission,
// default-on (opt-out) — so an empty notificationPrefs = enabled. A representative
// account-scoped Quality event (customer complaints are Work Orders of this family).
const EVENT = 'problemReported';

// u_sup is the account's supervisor (a Manager). u_other is a second Manager who
// must STOP getting the account's alerts under narrowing. u_owner/u_admin round out
// the manager bench. u_crew is the actor (the field cleaner who raised the work order).
function fixtureState(overrides = {}) {
  return {
    users: [
      { id: 'u_owner', name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
      { id: 'u_admin', name: 'Yolanda', role: 'admin', status: 'active', notificationPrefs: {} },
      { id: 'u_sup', name: 'Renata Cruz', role: 'manager', status: 'active', notificationPrefs: {} },
      { id: 'u_other', name: 'Other Manager', role: 'manager', status: 'active', notificationPrefs: {} },
      { id: 'u_crew', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} },
      ...(overrides.extraUsers || []),
    ],
    clients: [
      { id: 'cl_sup', name: 'Las Olas Medical Group', supervisorId: 'u_sup' },
      { id: 'cl_none', name: 'No Supervisor Co', supervisorId: null },
      { id: 'cl_demoted', name: 'Demoted Sup Co', supervisorId: 'u_demoted' },
      { id: 'cl_inactive', name: 'Inactive Sup Co', supervisorId: 'u_gone' },
      { id: 'cl_missing', name: 'Dangling Sup Co', supervisorId: 'u_nonexistent' },
    ],
    permissions: {},
    userPermissionOverrides: [],
    notifications: [],
  };
}

const alert = (state, clientId, actorUserId = 'u_crew') => fanOutAccountAlert(state, {
  clientId,
  eventKey: EVENT,
  title: 'New work order',
  body: 'Trash not emptied',
  url: '/inspections',
  actorUserId,
});
const notifiedIds = (rows) => rows.map((n) => n.userId).sort();

console.log('account-supervisor notification routing:');

// ── resolveAccountSupervisor: the guard matrix ──────────────────────────────
ok('resolveAccountSupervisor returns the valid supervisor', () => {
  assert.equal(resolveAccountSupervisor(fixtureState(), 'cl_sup')?.id, 'u_sup');
});
ok('resolveAccountSupervisor null when no supervisor / no client / no id', () => {
  assert.equal(resolveAccountSupervisor(fixtureState(), 'cl_none'), null);
  assert.equal(resolveAccountSupervisor(fixtureState(), 'cl_missing'), null);
  assert.equal(resolveAccountSupervisor(fixtureState(), null), null);
  assert.equal(resolveAccountSupervisor(fixtureState(), 'cl_nope'), null);
});
ok('resolveAccountSupervisor null when supervisor demoted to crew', () => {
  const s = fixtureState({ extraUsers: [{ id: 'u_demoted', name: 'Ex Mgr', role: 'crew', status: 'active', notificationPrefs: {} }] });
  assert.equal(resolveAccountSupervisor(s, 'cl_demoted'), null);
});
ok('resolveAccountSupervisor null when supervisor inactive', () => {
  const s = fixtureState({ extraUsers: [{ id: 'u_gone', name: 'Former Mgr', role: 'manager', status: 'inactive', notificationPrefs: {} }] });
  assert.equal(resolveAccountSupervisor(s, 'cl_inactive'), null);
});

// ── fanOutAccountAlert: narrow to the supervisor ────────────────────────────
ok('valid supervisor → ONLY the supervisor is notified (narrow)', () => {
  const rows = alert(fixtureState(), 'cl_sup');
  assert.deepEqual(notifiedIds(rows), ['u_sup']);
});
ok('the narrowed row carries the event, account url, and unread bell shape', () => {
  const row = alert(fixtureState(), 'cl_sup')[0];
  assert.equal(row.userId, 'u_sup');
  assert.equal(row.eventKey, EVENT);
  assert.equal(row.url, '/inspections');
  assert.equal(row.readAt, null);
  assert.ok(row.id.startsWith('nt_'));
});

// ── no available SPOC → NO notification (the event's own surface is the record, NOTIF-02) ─
ok('no supervisor set → NO notification (the work-order queue is the review surface)', () => {
  assert.deepEqual(alert(fixtureState(), 'cl_none'), []);
});
ok('demoted supervisor → NO notification (no available SPOC → log only)', () => {
  const s = fixtureState({ extraUsers: [{ id: 'u_demoted', name: 'Ex Mgr', role: 'crew', status: 'active', notificationPrefs: {} }] });
  assert.deepEqual(alert(s, 'cl_demoted'), []);
});
ok('inactive supervisor → NO notification (no available SPOC → log only)', () => {
  const s = fixtureState({ extraUsers: [{ id: 'u_gone', name: 'Former Mgr', role: 'manager', status: 'inactive', notificationPrefs: {} }] });
  assert.deepEqual(alert(s, 'cl_inactive'), []);
});

// ── per-recipient guards on the narrow path ─────────────────────────────────
ok('supervisor is the actor → no row (they already know), no blanket fallback', () => {
  assert.deepEqual(alert(fixtureState(), 'cl_sup', 'u_sup'), []);
});
ok('supervisor opted OUT of the event → no row (prefs respected)', () => {
  const s = fixtureState();
  s.users = s.users.map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { [EVENT]: false } } : u));
  assert.deepEqual(alert(s, 'cl_sup'), []);
});

// ── BLANKET vs NARROW — the invariant that separates the two routers ─────────
// fanOutManagerAlert blankets the whole manager bench; fanOutAccountAlert narrows to the
// account's SPOC. Pin that the blanket reaches a NON-supervisor manager and the narrow
// path does not — the assertion that fails against a blanket helper and passes the narrow.
ok('BLANKET: fanOutManagerAlert reaches a non-supervisor manager (u_other)', () => {
  const rows = fanOutManagerAlert(fixtureState(), { eventKey: EVENT, title: 'x', body: '', url: '/inspections', actorUserId: 'u_crew' });
  assert.ok(rows.some((n) => n.userId === 'u_other'), 'blanket must reach u_other');
});
ok('AFTER: fanOutAccountAlert does NOT notify the non-supervisor manager (u_other)', () => {
  const rows = alert(fixtureState(), 'cl_sup');
  assert.ok(!rows.some((n) => n.userId === 'u_other'), 'narrowed path must NOT reach u_other');
});

console.log(`\nAll ${pass} assertions passed.`);
