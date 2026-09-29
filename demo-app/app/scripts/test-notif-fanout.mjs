// NOTIF-02 verification — drives the server-side cron ingest
// (api/_lib/ingestEmail.js) against a fixture org state and asserts the
// per-recipient bell-row fan-out: prefs gating, role visibility, muted
// threads, idempotency, the per-user cap, and contact-name titles.
//
// Usage: node scripts/test-notif-fanout.mjs

import assert from 'node:assert/strict';
import { ingestInboundEmail } from '../api/_lib/ingestEmail.js';
// Imported, never hardcoded. This file asserted a literal 200 while 621c664 shipped
// 100 (C22, blob obesity), so the suite had been RED since that commit — long enough
// that a permanently-failing suite stops being a signal. Deriving the expectation
// from the constant means the cap can move again without silently rotting the test.
import { NOTIFICATION_LIMIT_PER_USER as CAP } from '../src/lib/notifications.js';

let pass = 0;
function ok(label, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${label}`);
}

const prefsOn = { newClientMessage: true };
const prefsOff = { newClientMessage: false };

function fixtureState() {
  return {
    users: [
      { id: 'u_owner', name: 'Kyle Boyden', role: 'owner', status: 'active', notificationPrefs: { ...prefsOn } },
      { id: 'u_admin', name: 'Heather', role: 'admin', status: 'active', notificationPrefs: { ...prefsOn } },
      { id: 'u_admin_off', name: 'Lauren', role: 'admin', status: 'active', notificationPrefs: { ...prefsOff } },
      { id: 'u_crew', name: 'Casey', role: 'crew', status: 'active', notificationPrefs: { ...prefsOn } },
      { id: 'u_inactive', name: 'Former Admin', role: 'admin', status: 'inactive', notificationPrefs: { ...prefsOn } },
    ],
    permissions: {},
    userPermissionOverrides: [],
    contacts: [
      { id: 'ct_pat', firstName: 'Pat', lastName: 'Jones', email: 'pat@client.com', companyId: null },
    ],
    conversations: [],
    messages: [],
    notifications: [],
  };
}

const inbound = {
  fromEmail: 'pat@client.com',
  toInboxEmail: 'kyle@cleanspaceonline.com',
  subject: 'Re: Cleaning quote',
  body: 'We are ready to move forward with all three locations.',
  messageId: '<test-1@client.com>',
  inReplyTo: null,
  references: null,
};

console.log('ingestInboundEmail fan-out:');

// ── Basic fan-out + gating ───────────────────────────────────────────────────
const s1 = ingestInboundEmail(fixtureState(), inbound);

ok('message threaded into a new conversation', () => {
  assert.equal(s1.messages.length, 1);
  assert.equal(s1.conversations.length, 1);
  assert.equal(s1.conversations[0].contactId, 'ct_pat');
});
ok('bell rows written for opted-in owner + admin only', () => {
  const userIds = s1.notifications.map((n) => n.userId).sort();
  assert.deepEqual(userIds, ['u_admin', 'u_owner']);
});
ok('crew never notified for newClientMessage (roleAllowlist)', () => {
  assert.ok(!s1.notifications.some((n) => n.userId === 'u_crew'));
});
ok('prefs-off and inactive users not notified', () => {
  assert.ok(!s1.notifications.some((n) => n.userId === 'u_admin_off' || n.userId === 'u_inactive'));
});
ok('row shape matches the bell-inbox contract', () => {
  const row = s1.notifications[0];
  assert.equal(row.eventKey, 'newClientMessage');
  assert.equal(row.readAt, null);
  assert.equal(row.url, `/messaging/${s1.messages[0].conversationId}`);
  assert.ok(row.id.startsWith('nt_'));
  assert.ok(row.body.includes('ready to move forward'));
});
ok('contact-linked thread resolves the contact name in the title', () => {
  assert.equal(s1.notifications[0].title, 'New email from Pat Jones');
});

// ── Idempotency (re-poll of the same buffered reply) ────────────────────────
const s2 = ingestInboundEmail(s1, inbound);
ok('duplicate messageId is a no-op (no double bell)', () => {
  assert.equal(s2, s1);
  assert.equal(s2.notifications.length, 2);
});

// ── Unknown sender (no contact match) ───────────────────────────────────────
const s3 = ingestInboundEmail(fixtureState(), { ...inbound, fromEmail: 'stranger@example.org', messageId: '<test-2@x>' });
ok('unknown sender still fans out, titled with the raw address', () => {
  assert.equal(s3.notifications.length, 2);
  assert.equal(s3.notifications[0].title, 'New email from stranger@example.org');
});

// ── Muted thread ─────────────────────────────────────────────────────────────
{
  const base = ingestInboundEmail(fixtureState(), inbound);
  const muted = {
    ...base,
    conversations: base.conversations.map((c) => ({ ...c, mutedByUserIds: ['u_owner'] })),
  };
  const s4 = ingestInboundEmail(muted, { ...inbound, messageId: '<test-3@client.com>' });
  ok('muted recipient skipped, others still notified', () => {
    const newRows = s4.notifications.length - base.notifications.length;
    assert.equal(newRows, 1);
    assert.equal(s4.notifications.find((n) => !base.notifications.includes(n)).userId, 'u_admin');
  });
}

// ── per-user cap (NOTIFICATION_LIMIT_PER_USER) ───────────────────────────────
{
  const state = fixtureState();
  // Start exactly AT the cap with RECENT unread rows (a day old — inside every
  // TTL), so ingesting one more must evict exactly one via the COUNT cap alone.
  // (The fixture previously dated these 2026-01-01, which only worked while
  // unread rows were immortal; the absolute age ceiling now sweeps those.)
  const recent = new Date(Date.now() - 86400000).toISOString();
  state.notifications = Array.from({ length: CAP }, (_, i) => ({
    id: `nt_old_${i}`, createdAt: recent, readAt: null,
    userId: 'u_owner', eventKey: 'newClientMessage', title: 'old', body: '', url: '/messaging/x',
  }));
  const s5 = ingestInboundEmail(state, inbound);
  ok(`per-user cap holds at ${CAP} (oldest dropped, newest first)`, () => {
    const ownerRows = s5.notifications.filter((n) => n.userId === 'u_owner');
    assert.equal(ownerRows.length, CAP);
    assert.ok(ownerRows[0].id.startsWith('nt_') && !ownerRows[0].id.startsWith('nt_old_'));
    // capInsert keeps [new, ...existing].slice(0, CAP), so the LAST seeded row is the
    // one evicted — derived from CAP rather than a literal index.
    assert.ok(!s5.notifications.some((n) => n.id === `nt_old_${CAP - 1}`));
  });
}

// ── absolute age ceiling (NOTIFICATION_MAX_AGE_DAYS) — unread is NOT immortal ─
{
  const state = fixtureState();
  // One ancient unread row (previously force-kept forever) + one recent unread.
  state.notifications = [
    { id: 'nt_ancient', createdAt: '2026-01-01T00:00:00.000Z', readAt: null, userId: 'u_owner', eventKey: 'newClientMessage', title: 'ancient', body: '', url: '/messaging/x' },
    { id: 'nt_recent', createdAt: new Date(Date.now() - 86400000).toISOString(), readAt: null, userId: 'u_owner', eventKey: 'newClientMessage', title: 'recent', body: '', url: '/messaging/x' },
  ];
  const s6 = ingestInboundEmail(state, inbound);
  ok('unread rows past the absolute ceiling are swept; recent unread survive', () => {
    assert.ok(!s6.notifications.some((n) => n.id === 'nt_ancient'));
    assert.ok(s6.notifications.some((n) => n.id === 'nt_recent'));
  });
}

// ── In-Reply-To threading keeps the fan-out on the existing conversation ────
{
  const base = ingestInboundEmail(fixtureState(), inbound);
  const reply = {
    fromEmail: 'pat@client.com',
    subject: 'Re: Re: Cleaning quote',
    body: 'One more question about scheduling.',
    messageId: '<test-4@client.com>',
    inReplyTo: '<test-1@client.com>',
    references: null,
  };
  // Wire the prior message's Message-ID so In-Reply-To matches.
  const wired = {
    ...base,
    messages: base.messages.map((m) => ({ ...m, emailHeaders: { ...m.emailHeaders, messageId: '<test-1@client.com>' } })),
  };
  const s6 = ingestInboundEmail(wired, reply);
  ok('reply threads into the existing conversation and notifies again', () => {
    assert.equal(s6.conversations.length, 1);
    assert.equal(s6.notifications.length, 4);
  });
}

console.log(`\nAll ${pass} assertions passed.`);
