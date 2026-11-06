// NOTIF-03 regression, fanOutOpsNotification must SKIP THE ACTOR, like every
// other human-actor fan-out (message/job/key/manager/account). Before the fix the
// ops fan-out had no actor-skip, so a manager who is also on the account's job
// crew bell'd themselves when they edited that account's ops.
//
// CS-226 extends the same rule to the INVOICE fan-out, the last one without it: whoever
// recorded the payment that zeroed a balance was told their own invoice was paid. The
// server sweep (lib/invoiceSweep.js) has no actor and passes none, so nobody is skipped
// there — which this suite also pins, because an actor-skip that fires on a system event
// would silence the notification for everyone.
//
// Pure client-side helper (no app/api), runs in the offline suite.
// Usage: node scripts/test-notif-ops-actor-skip.mjs
import assert from 'node:assert/strict';
import { fanOutOpsNotification, fanOutInvoiceNotification } from '../src/lib/notifications.js';
import { seedPermissions } from '../src/lib/roles.js';

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

// ── CS-226 · the invoice fan-out ─────────────────────────────────────────────
// Two people who both hold invoices.view by role default (owner + manager, Q24), so the
// visibility gate lets both through and only the actor-skip can explain a missing row.
function invoiceState() {
  return {
    currentUserId: 'u_actor',
    users: [
      { id: 'u_actor', name: 'Renata (recorded the payment)', role: 'manager', status: 'active', notificationPrefs: {} },
      { id: 'u_owner', name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
    ],
    permissions: seedPermissions(),
    userPermissionOverrides: [],
    notifications: [],
  };
}
const invoice = { id: 'CS-1042' };

console.log('\nfanOutInvoiceNotification actor-skip (CS-226):');

const paid = fanOutInvoiceNotification(invoiceState(), { invoice, eventKey: 'invoicePaid', actorUserId: 'u_actor' });
ok('the person who recorded the payment is NOT told their own invoice was paid', () => {
  assert.ok(!paid.some((n) => n.userId === 'u_actor'), 'actor self-notified, actor-skip missing');
});
ok('the other invoice-holder IS told', () => {
  assert.equal(paid.length, 1, `one row, got ${paid.length}`);
  assert.equal(paid[0].userId, 'u_owner');
  assert.equal(paid[0].eventKey, 'invoicePaid');
});
ok('🔴 with NO actor (the server overdue sweep) nobody is skipped', () => {
  const swept = fanOutInvoiceNotification(invoiceState(), { invoice, eventKey: 'invoiceOverdue' });
  assert.equal(swept.length, 2, `both holders notified, got ${swept.length}`);
  assert.deepEqual(swept.map((n) => n.userId).sort(), ['u_actor', 'u_owner']);
});

console.log(`\nAll ${pass} assertions passed.`);
