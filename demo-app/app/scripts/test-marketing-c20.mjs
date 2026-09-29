// SCALE-C20 equivalence test: the retry-dedup (`priorSends`) path now reads from a
// prebuilt `sendsByEnrStep` Map keyed `${enrollmentId}::${stepId}` instead of
// re-scanning the whole sends log per enrollment. This proves the Map lookup is
// behavior-identical to the old `sends.filter(sd => sd.enrollmentId===enr.id &&
// sd.stepId===step.id)` — especially that a send for a DIFFERENT enrollment/step
// does NOT bleed into this enrollment's retry count (the isolation the key provides).
// Run: node app/scripts/test-marketing-c20.mjs
import { getDueSends } from '../src/lib/marketingScheduler.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } };

const NOW = new Date('2026-07-12T19:00:00.000Z'); // 12:00 America/Los_Angeles — inside the default 9–17 window (resolved in the ORG timezone, not UTC)
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const send = (o) => ({ id: 'sd_' + Math.random().toString(36).slice(2), enrollmentId: 'enr1', stepId: 'st0', inboxId: 'ib1', ...o });

function state(sends = [], extraEnr = [], extraContacts = []) {
  return {
    marketingSequences: [{ id: 'seq1', status: 'active', nextInboxIndex: 0,
      steps: [{ id: 'st0', order: 0, delayMinutes: 30, subject: 'Hi', body: 'B' }] }], // sub-hour = fast: bypass window+throttle
    marketingEnrollments: [{ id: 'enr1', sequenceId: 'seq1', contactId: 'ct1', status: 'active', currentStepIndex: 0, lastSentAt: null, repliedAt: null }, ...extraEnr],
    marketingSends: sends,
    contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com' }, ...extraContacts],
    users: [],
    marketingInboxes: [{ id: 'ib1', enabled: true, status: 'active', rotationOrder: 0, dailySendLimit: 10, connectedByUserId: null }],
    marketingSettings: {},
    marketingSuppressions: [],
  };
}
const dueCount = (s) => getDueSends(s, NOW).length;

ok('no prior sends → step 0 fires', dueCount(state([])) === 1);
ok('delivered step (status sent) → skipped', dueCount(state([send({ status: 'sent', sentAt: minsAgo(60) })])) === 0);
ok('delivered step (status pending) → skipped', dueCount(state([send({ status: 'pending', attemptedAt: minsAgo(60) })])) === 0);
ok('1 failed attempt, backoff elapsed (>15m) → retries', dueCount(state([send({ status: 'failed', attemptedAt: minsAgo(20) })])) === 1);
ok('1 failed attempt, within backoff (<15m) → held', dueCount(state([send({ status: 'failed', attemptedAt: minsAgo(5) })])) === 0);
ok('3 failed attempts (>= MAX) → exhausted, no retry', dueCount(state([
  send({ status: 'failed', attemptedAt: minsAgo(120) }),
  send({ status: 'failed', attemptedAt: minsAgo(90) }),
  send({ status: 'failed', attemptedAt: minsAgo(60) }),
])) === 0);

// THE isolation case: a delivered send for a DIFFERENT enrollment/step must NOT
// count as a prior send for enr1/st0 (would wrongly skip it if the key were mis-built).
ok('send for a different enrollment does NOT block this one', dueCount(state([
  send({ enrollmentId: 'enrX', status: 'sent', sentAt: minsAgo(60) }),
])) === 1);
ok('send for a different step does NOT block this one', dueCount(state([
  send({ stepId: 'stX', status: 'sent', sentAt: minsAgo(60) }),
])) === 1);
// And a delivered send for the SAME key still blocks even amid unrelated rows.
ok('correct key still matches amid unrelated rows', dueCount(state([
  send({ enrollmentId: 'enrX', status: 'sent', sentAt: minsAgo(60) }),
  send({ stepId: 'stX', status: 'failed', attemptedAt: minsAgo(5) }),
  send({ status: 'sent', sentAt: minsAgo(60) }), // enr1/st0 delivered → must skip
])) === 0);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
