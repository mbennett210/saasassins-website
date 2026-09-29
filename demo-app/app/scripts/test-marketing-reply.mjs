// Node unit test for the server-side marketing-reply ingest (no Supabase needed).
// Run: node app/scripts/test-marketing-reply.mjs  (from repo root)
import { ingestMarketingReply } from '../api/_lib/ingestMarketingReply.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

function baseState() {
  return {
    users: [{ id: 'u1', status: 'active', notificationPrefs: {} }],
    contacts: [{ id: 'c1', email: 'lead@example.com', firstName: 'Lead', lastName: 'Person', stage: 'new', companyId: null, tagIds: [] }],
    clients: [],
    pipelines: [{ id: 'p1', stages: [{ key: 'won' }] }],
    marketingSequences: [{
      id: 's1', name: 'Welcome', haltOnReply: true,
      notifyOnReplyUserId: 'u1', notifyOnReplyChannels: { inApp: true },
      replyRouting: { enabled: true, pipelineId: 'p1', stageKey: 'won' },
      replyTags: ['tag1'],
    }],
    marketingEnrollments: [{ id: 'e1', sequenceId: 's1', contactId: 'c1', status: 'active', repliedAt: null }],
    marketingReplies: [],
    marketingSuppressions: [],
    contactActivities: [],
    notifications: [],
  };
}

// 1. Happy path: record + halt + route + tag + notify.
{
  const s = baseState();
  const r = ingestMarketingReply(s, { fromEmail: 'lead@example.com', subject: 'Re: Welcome', body: 'Yes, interested!', messageId: '<m1@x>', receivedAt: '2026-06-21T00:00:00.000Z' });
  ok(r.marketingReplies.length === 1, 'records one reply');
  ok(r.marketingReplies[0].contactId === 'c1' && r.marketingReplies[0].sequenceId === 's1', 'reply correlated to enrollment by from-email');
  const e = r.marketingEnrollments.find((x) => x.id === 'e1');
  ok(e.status === 'replied' && !!e.repliedAt, 'halts the drip (status replied)');
  const c = r.contacts.find((x) => x.id === 'c1');
  ok(c.stage === 'won', 'routes the contact to the configured stage');
  ok((c.tagIds || []).includes('tag1'), 'applies reply tags');
  ok(r.contactActivities.length === 1 && r.contactActivities[0].kind === 'stage_change', 'logs a stage-change activity');
  const n = r.notifications.filter((x) => x.eventKey === 'marketingReplyAssigned');
  ok(n.length === 1 && n[0].userId === 'u1', 'fans out marketingReplyAssigned to the notify user');
  ok(n[0].title.includes('Lead Person') && n[0].title.includes('Welcome'), 'notification title names the contact + sequence');
}

// 2. Idempotency: re-ingesting the same message-id is a no-op.
{
  const s = baseState();
  const r1 = ingestMarketingReply(s, { fromEmail: 'lead@example.com', body: 'hi', messageId: '<dup@x>' });
  const r2 = ingestMarketingReply(r1, { fromEmail: 'lead@example.com', body: 'hi', messageId: '<dup@x>' });
  ok(r2 === r1, 'duplicate message-id returns the same state object (no double-record/notify)');
  ok(r2.marketingReplies.length === 1, 'still exactly one reply after a duplicate');
}

// 3. Opt-out: an unsubscribe phrase adds a suppression.
{
  const s = baseState();
  const r = ingestMarketingReply(s, { fromEmail: 'lead@example.com', body: 'please unsubscribe me', messageId: '<m3@x>' });
  ok(r.marketingSuppressions.some((x) => x.email === 'lead@example.com'), 'auto opt-out adds a suppression');
}

// 4. Notify opt-out + inactive recipient are respected.
{
  const s = baseState();
  s.users[0].notificationPrefs = { marketingReplyAssigned: false };
  const r = ingestMarketingReply(s, { fromEmail: 'lead@example.com', body: 'hi', messageId: '<m4@x>' });
  ok(r.notifications.filter((x) => x.eventKey === 'marketingReplyAssigned').length === 0, 'respects an explicit notify opt-out');
}

// 5. Unknown sender (no contact) still records a reply, no enrollment.
{
  const s = baseState();
  const r = ingestMarketingReply(s, { fromEmail: 'stranger@nowhere.com', body: 'who?', messageId: '<m5@x>' });
  ok(r.marketingReplies.length === 1 && r.marketingReplies[0].enrollmentId === null, 'records an unmatched reply with null enrollment');
}

console.log(`\nmarketing-reply ingest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
