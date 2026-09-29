// NOTIF-01 regression, reminderFailed is emitted (reducer UPDATE_REMINDER_EVENT) and
// seeded on, but had NO catalog entry in NOTIFICATION_GROUPS, so isNotificationVisibleForUser
// returned false for everyone and the office alert reached nobody. Assert it now delivers to
// an opted-in manager and stays off crew's bell. Pure client-side (no app/api).
// Usage: node scripts/test-notif-reminder-failed.mjs
import assert from 'node:assert/strict';
import { fanOutManagerAlert, isNotificationVisibleForUser } from '../src/lib/notifications.js';

let pass = 0;
function ok(label, fn) { fn(); pass += 1; console.log(`  ✓ ${label}`); }

function state() {
  return {
    users: [
      { id: 'u_mgr', name: 'Yolanda', role: 'admin', status: 'active', notificationPrefs: {} },
      { id: 'u_crew', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} },
    ],
    permissions: {},
    userPermissionOverrides: [],
    notifications: [],
  };
}

console.log('reminderFailed catalog wiring:');

ok('reminderFailed is a visible catalog event for a manager', () => {
  const mgr = state().users[0];
  assert.ok(isNotificationVisibleForUser('reminderFailed', mgr, {}, []), 'reminderFailed not in catalog, gate returns false for everyone');
});

const out = fanOutManagerAlert(state(), { eventKey: 'reminderFailed', title: 'Reminder text failed', body: 'carrier rejected', actorUserId: null });

ok('an opted-in manager receives the reminderFailed alert', () => {
  assert.ok(out.some((n) => n.userId === 'u_mgr' && n.eventKey === 'reminderFailed'), 'reminderFailed reached nobody');
});
ok('crew do NOT receive it (roleAllowlist owner/admin/manager)', () => {
  assert.ok(!out.some((n) => n.userId === 'u_crew'));
});

console.log(`\nAll ${pass} assertions passed.`);
