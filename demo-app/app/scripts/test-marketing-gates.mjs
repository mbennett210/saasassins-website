// Node unit test for the per-contact Do-Not-Contact gates in the marketing
// pure walkers — no Supabase / network needed. Covers:
//   • getDueSends skips a DNC contact mid-sequence (enrollment stays active) and
//     resumes from the same step once DNC is cleared.
//   • getDueEnrollments skips a DNC contact from auto-enroll.
//   • engine.applyEnroll (the tab-less cron mirror) skips a DNC contact — parity
//     with reducer ENROLL_CONTACTS.
//
// Imports are limited to node-safe modules: marketingScheduler.js (imports only
// ids.js + contactConsent.js) and api/_lib/marketing/engine.js (the server
// mirror). The reducer's ENROLL_CONTACTS is NOT imported here — reducer.js drags
// browser-oriented deps via seed.js; engine.applyEnroll is its verified mirror
// and is what the cron actually runs, so DNC parity is asserted against it.
// Run: node app/scripts/test-marketing-gates.mjs  (from repo root)
import { getDueSends, getDueEnrollments } from '../src/lib/marketingScheduler.js';
import { applyEnroll } from '../api/_lib/marketing/engine.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const NOW = new Date('2026-07-12T19:00:00.000Z'); // 12:00 America/Los_Angeles — inside the default 9–17 window.
// The window is resolved in the ORG timezone, not UTC and not the device (see
// marketingScheduler sendZone). The old fixture used 12:00 UTC and called it
// "noon", which is 05:00 Pacific — outside the window. It only passed because a
// sub-hour step delay used to bypass the window entirely (seqIsFast, removed).

// A minimal but valid "one due send" fixture. The single step carries a sub-hour
// delayMinutes. NOTE: this no longer bypasses
// the business-hours window or the throttle (seqIsFast was removed — it let a live
// sequence skip both on real customer inboxes). NOW is inside the window instead.
function sendState(overrides = {}) {
  return {
    marketingSequences: [{
      id: 'seq1', status: 'active', nextInboxIndex: 0,
      steps: [{ id: 'st0', order: 0, delayMinutes: 30, subject: 'Hi {firstName}', body: 'Body' }],
    }],
    marketingEnrollments: [{
      id: 'enr1', sequenceId: 'seq1', contactId: 'ct1', status: 'active',
      currentStepIndex: 0, lastSentAt: null, repliedAt: null, source: 'manual',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    }],
    marketingSends: [],
    contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com' }],
    users: [],
    marketingInboxes: [{ id: 'ib1', enabled: true, status: 'active', rotationOrder: 0, dailySendLimit: 10, connectedByUserId: null }],
    marketingSettings: {},
    marketingSuppressions: [],
    ...overrides,
  };
}

// 1. Baseline: a clean active enrollment produces one due send.
{
  const due = getDueSends(sendState(), NOW);
  ok(due.length === 1, 'clean active enrollment → one due send');
  ok(due[0]?.toEmail === 'ann@corp.com', 'due send targets the contact email');
}

// 2. DNC mid-sequence: the same enrollment yields NO send, but the enrollment
//    itself is untouched (getDueSends is pure — status stays 'active').
{
  const s = sendState({ contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com', doNotContact: true }] });
  const due = getDueSends(s, NOW);
  ok(due.length === 0, 'DNC contact → zero due sends (mid-sequence stop)');
  ok(s.marketingEnrollments[0].status === 'active', 'DNC stop leaves enrollment active (resumable, not unenrolled)');
}

// 3. Clearing DNC resumes from the SAME step index (still step 0, nothing sent yet).
{
  const s = sendState({ contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com', doNotContact: false }] });
  const due = getDueSends(s, NOW);
  ok(due.length === 1, 'clearing DNC resumes sending');
  ok(due[0]?.step?.id === 'st0', 'resumes from the same currentStepIndex (step 0)');
}

// ── getDueEnrollments ─────────────────────────────────────────────────────────
function enrollState(overrides = {}) {
  return {
    marketingSequences: [{
      id: 'seq1', status: 'draft', audienceMode: 'auto',
      enrollmentSources: [{ kind: 'pipelineStage', pipelineId: 'p1', stageKey: 'new' }],
      steps: [{ id: 'st0', order: 0, subject: 'Hi', body: 'x' }],
    }],
    marketingEnrollments: [],
    // Auto-enroll targets the PRIMARY CONTACT of an OPEN deal at a source stage
    // (contactIdsAtSourceStages reads state.opportunities), not a contact's own stage.
    contacts: [{ id: 'ct1', email: 'ann@corp.com' }],
    opportunities: [{ id: 'op1', status: 'open', pipelineId: 'p1', stage: 'new', primaryContactId: 'ct1' }],
    marketingSuppressions: [],
    ...overrides,
  };
}

// 4. Clean contact at the source stage is picked up for auto-enroll.
{
  const buckets = getDueEnrollments(enrollState());
  ok(buckets.some((b) => b.sequenceId === 'seq1' && b.contactIds.includes('ct1')), 'clean contact at source stage → auto-enroll bucket');
}

// 5. DNC contact at the source stage is skipped.
{
  const s = enrollState({ contacts: [{ id: 'ct1', email: 'ann@corp.com', pipelineId: 'p1', stage: 'new', doNotContact: true }] });
  const buckets = getDueEnrollments(s);
  ok(!buckets.some((b) => b.contactIds.includes('ct1')), 'DNC contact at source stage → skipped from auto-enroll');
}

// ── engine.applyEnroll parity ─────────────────────────────────────────────────
function engineState(overrides = {}) {
  return {
    marketingSequences: [{ id: 'seq1', status: 'active', steps: [{ id: 'st0', order: 0 }] }],
    marketingEnrollments: [],
    contacts: [{ id: 'ct1', email: 'ann@corp.com' }],
    marketingSuppressions: [],
    ...overrides,
  };
}

// 6. applyEnroll enrolls a clean contact.
{
  const next = applyEnroll(engineState(), 'seq1', ['ct1']);
  ok((next.marketingEnrollments || []).some((e) => e.contactId === 'ct1'), 'applyEnroll enrolls a clean contact');
}

// 7. applyEnroll skips a DNC contact (parity with reducer ENROLL_CONTACTS).
{
  const s = engineState({ contacts: [{ id: 'ct1', email: 'ann@corp.com', doNotContact: true }] });
  const next = applyEnroll(s, 'seq1', ['ct1']);
  ok(!(next.marketingEnrollments || []).some((e) => e.contactId === 'ct1'), 'applyEnroll skips a DNC contact');
  ok(next === s, 'applyEnroll returns state unchanged when the only contact is DNC (no fresh rows)');
}

console.log(`\nmarketing DNC gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
