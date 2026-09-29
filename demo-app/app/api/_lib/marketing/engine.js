// Pure server-side state transformers for the marketing send engine — mirror
// the matching cases in src/store/reducer.js exactly. Used by the
// api/marketing/run cron to apply enroll / unenroll / send-record / advance
// mutations to the shared org_state blob without a browser tab.
//
// Keep in lockstep with src/store/reducer.js: ENROLL_CONTACTS, UNENROLL_CONTACT,
// RECORD_MARKETING_SEND, ADVANCE_ENROLLMENT_STEP, ADVANCE_SEQUENCE_INBOX_INDEX.

import { newId } from '../../../src/lib/ids.js';
import { fanOutManagerAlert } from '../../../src/lib/notifications.js';
import { isDoNotContact, buildSuppressedEmailSet } from '../../../src/lib/contactConsent.js';

const nowIso = () => new Date().toISOString();

// Dedup key for a (enrollment, step) send — mirrors marketingScheduler.hasSent.
export function hasSent(sends, enrollmentId, stepId) {
  return (sends || []).some((sd) => sd.enrollmentId === enrollmentId && sd.stepId === stepId);
}

// ENROLL_CONTACTS — dedup vs non-terminal enrollments + suppression gate + DNC
// gate (mirrors src/store/reducer.js ENROLL_CONTACTS: both skip contacts on the
// email-keyed marketing suppression list AND per-contact isDoNotContact), then
// create one active enrollment per fresh contact. `source` defaults to 'auto'
// (the cron is the system enroller).
export function applyEnroll(state, sequenceId, contactIds, source = 'auto') {
  const ids = Array.isArray(contactIds) ? contactIds : [];
  if (!sequenceId || ids.length === 0) return state;
  const enrollments = state.marketingEnrollments || [];
  const blocked = new Set(['active', 'replied', 'completed']);
  const existing = new Set(
    enrollments.filter((e) => e.sequenceId === sequenceId && blocked.has(e.status)).map((e) => e.contactId)
  );
  const suppressed = buildSuppressedEmailSet(state);
  const contactOf = (cid) => (state.contacts || []).find((x) => x.id === cid);
  const emailOf = (cid) => (contactOf(cid)?.email || '').toLowerCase();
  const now = nowIso();
  const fresh = ids
    .filter((cid) => cid && !existing.has(cid)
      && !isDoNotContact(contactOf(cid))
      && !(suppressed.size > 0 && suppressed.has(emailOf(cid))))
    .map((cid) => ({
      id: newId('menr'),
      sequenceId,
      contactId: cid,
      enrolledAt: now,
      enrolledByUserId: null, // system / auto-enroll
      source: source === 'auto' ? 'auto' : 'manual',
      currentStepIndex: 0,
      status: 'active',
      lastSentAt: null,
      repliedAt: null,
    }));
  if (fresh.length === 0) return state;
  return { ...state, marketingEnrollments: [...enrollments, ...fresh] };
}

// UNENROLL_CONTACT
export function applyUnenroll(state, enrollmentId) {
  if (!enrollmentId) return state;
  return {
    ...state,
    marketingEnrollments: (state.marketingEnrollments || []).map((e) =>
      e.id === enrollmentId ? { ...e, status: 'unenrolled' } : e
    ),
  };
}

// RECORD_MARKETING_SEND — append a send row (defaults to pending; caller passes
// the resolved status/sentAt/etc via `send`). Idempotent: skips if a row for
// this (enrollmentId, stepId) already exists, so a CAS retry never re-records.
export function recordSend(state, send) {
  const incoming = send || {};
  if (!incoming.enrollmentId || !incoming.stepId) return state;
  // Idempotent on the send id (not enrollment+step) so a CAS retry within a run
  // doesn't double-record, while a genuine retry across runs — a fresh send id for
  // a failed step (AUTO-02) — is allowed through.
  if (incoming.id && (state.marketingSends || []).some((sd) => sd.id === incoming.id)) return state;
  const base = {
    id: incoming.id || newId('msnd'),
    status: 'pending',
    attemptedAt: nowIso(),
    sentAt: null,
    providerMessageId: null,
    failureReason: null,
  };
  return { ...state, marketingSends: [...(state.marketingSends || []), { ...base, ...incoming }] };
}

// ADVANCE_ENROLLMENT_STEP — bump currentStepIndex, stamp lastSentAt, complete
// when the sequence has no further steps.
export function advanceEnrollment(state, enrollmentId, sentAt) {
  if (!enrollmentId) return state;
  const seqs = state.marketingSequences || [];
  return {
    ...state,
    marketingEnrollments: (state.marketingEnrollments || []).map((e) => {
      if (e.id !== enrollmentId) return e;
      const seq = seqs.find((s) => s.id === e.sequenceId);
      const stepCount = seq ? (seq.steps || []).length : 0;
      const nextIndex = (e.currentStepIndex || 0) + 1;
      const completed = stepCount > 0 && nextIndex >= stepCount;
      return {
        ...e,
        currentStepIndex: nextIndex,
        lastSentAt: sentAt || nowIso(),
        status: completed ? 'completed' : e.status,
      };
    }),
  };
}

// ADVANCE_SEQUENCE_INBOX_INDEX — bump the round-robin counter.
export function advanceInboxIndex(state, sequenceId) {
  if (!sequenceId) return state;
  return {
    ...state,
    marketingSequences: (state.marketingSequences || []).map((s) =>
      s.id === sequenceId ? { ...s, nextInboxIndex: (s.nextInboxIndex || 0) + 1 } : s
    ),
  };
}

// Mark a rotation inbox expired (INT-01) so it drops out of activeMarketingInboxes
// and the UI's "Reconnect required" badge lights up — instead of the cron silently
// failing every tick against a revoked token. On the healthy→expired transition it
// also fans out an `inboxExpired` manager alert so a dead sending inbox tells the
// office (their drips would otherwise stall silently — the whole reason this was a
// gap). Fires ONCE: a no-op if the inbox is unknown or already expired, so the
// per-tick / per-failed-send repeats and CAS retries can't re-ping.
export function markInboxExpired(state, inboxId) {
  if (!inboxId) return state;
  const inbox = (state.marketingInboxes || []).find((i) => i.id === inboxId);
  if (!inbox || inbox.status === 'expired') return state;
  const next = {
    ...state,
    marketingInboxes: state.marketingInboxes.map((i) =>
      i.id === inboxId ? { ...i, status: 'expired' } : i
    ),
  };
  return {
    ...next,
    notifications: fanOutManagerAlert(next, {
      eventKey: 'inboxExpired',
      title: `Marketing inbox needs reconnecting — ${inbox.email || inbox.displayName || 'a sending inbox'}`,
      body: 'Its authorization expired or was revoked, so it dropped out of the sequence rotation. Reconnect it under Marketing → Inboxes.',
      url: '/marketing',
      actorUserId: null,
    }),
  };
}
