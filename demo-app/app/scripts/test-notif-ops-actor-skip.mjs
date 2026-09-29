// NOTIF-03 regression, fanOutOpsNotification must SKIP THE ACTOR, like every
// other human-actor fan-out (message/job/key/manager/account). Before the fix the
// ops fan-out had no actor-skip, so a manager who is also on the account's job
// crew bell'd themselves when they edited that account's ops.
//
// Pure client-side helper (no app/api), runs in the offline suite.
// Usage: node scripts/test-notif-ops-actor-skip.mjs
import assert from 'node:assert/strict';
import { fanOutOpsNotification } from '../src/lib/notifications.js';

let pass = 0;
function ok(label, fn) { fn(); pass += 1; console.log(`  ✓ ${label}`); }

const tomorrow = new Date(Date.now() + 86400000).toISOString();

// The actor (state.currentUserId) is ALSO named on the account's upcoming job crew,
// alongside a second crew member. accountOpsUpdated is opt-out + no roleAllowlist,
// so absent prefs = enabled and both are otherwise eligible recipients.
function fixtureState() {
  return {
    currentUserId: 'u_actor',
    users: [
      { id: 'u_actor', name: 'Dana (manager on the crew)', role: 'manager', status: 'active', notificationPrefs: {} },
      { id: 'u_crew2', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} },
    ],
    permissions: {},
    userPermissionOverrides: [],
    clients: [{ id: 'cl1', name: 'Las Olas Medical Group' }],
    sites: [],
    jobs: [{ id: 'j1', clientId: 'cl1', siteId: null, status: 'upcoming', endAt: tomorrow, crewIds: ['u_actor', 'u_crew2'] }],
    notifications: [],
  };
}

console.log('fanOutOpsNotification actor-skip:');

const out = fanOutOpsNotification(fixtureState(), { clientId: 'cl1', actorName: 'Dana', summary: 'Cleaning instructions updated.' });

ok('the actor (currentUserId) is NOT bell-notified about their own ops change', () => {
  assert.ok(!out.some((n) => n.userId === 'u_actor'), 'actor self-notified, actor-skip missing');
});
ok('a different crew member on the account IS notified', () => {
  assert.ok(out.some((n) => n.userId === 'u_crew2'), 'non-actor crew should still receive the ops alert');
});
ok('exactly one row written (crew2 only, actor skipped)', () => {
  assert.equal(out.length, 1);
  assert.equal(out[0].userId, 'u_crew2');
  assert.equal(out[0].eventKey, 'accountOpsUpdated');
});

console.log(`\nAll ${pass} assertions passed.`);
