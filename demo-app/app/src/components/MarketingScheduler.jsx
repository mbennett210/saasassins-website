// ─────────────────────────────────────────────────────────────────────────────
// Marketing scheduler — background dispatcher for email sequences.
//
// Mounted once at app root (next to ReminderScheduler / NotificationListener).
// Mirrors ReminderScheduler.jsx mechanics:
//   1. Re-evaluates due sends whenever the relevant state slices change.
//   2. Ticks every 60 seconds to catch time-window changes when state is idle.
//   3. Auto-enrolls contacts matched by sequence.enrollmentSources (auto mode).
//   4. Auto-unenrolls when contacts leave a source stage AND the sequence's
//      onStageExit setting is 'unenroll'.
//   5. For each due send: dispatches RECORD_MARKETING_SEND (pending) +
//      ADVANCE_SEQUENCE_INBOX_INDEX (optimistic round-robin) → calls
//      sendViaInbox() → dispatches UPDATE_MARKETING_SEND with the resolved
//      status + ADVANCE_ENROLLMENT_STEP on success.
//
// Dedup: state-tracked via marketingSends (hasSent check in getDueSends) AND
// a module-level in-flight Set keyed by `${enrollmentId}::${stepId}`. Once a
// key is added to inFlight it is NEVER removed — same rule as the reminder
// scheduler: state-based dedup covers reloads, in-flight covers the brief
// window before the pending dispatch lands.
//
// Production: when VITE_EMAIL_BACKEND_URL is set, sendViaInbox calls the
// real /inbox/{id}/send endpoint. Otherwise stub mode resolves with a fake
// provider message id so the full flow is exercisable offline.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  getDueSends,
  getDueEnrollments,
  getStaleEnrollments,
} from '../lib/marketingScheduler';
import { sendViaInbox } from '../lib/connectedInboxes';
import { loadMarketingAttachment } from '../lib/attachments';
import { nowIso } from '../lib/dates';

const TICK_MS = 60 * 1000;

// Module-level in-flight guard. Survives React.StrictMode's dev-only
// double-mount cycle (a useRef would be reset on remount, briefly allowing
// a duplicate fire before the first dispatch lands in state). Never deleted
// — state-based hasSent() covers refires after a reload.
const inFlight = new Set();

// Read a Blob as base64 (no data-URL prefix) for JSON transport to the send
// backend.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Resolve a step's attachment metadata into send-ready parts — pull each blob
// from IndexedDB and base64-encode it. Missing blobs are skipped so a stray
// attachment never blocks the send (metadata + blob can drift apart).
async function loadAttachmentsForSend(metas) {
  const parts = [];
  for (const meta of metas || []) {
    const rec = await loadMarketingAttachment(meta.id);
    if (!rec?.blob) continue;
    parts.push({
      name: meta.name || rec.name,
      mimeType: meta.mimeType || rec.mimeType,
      content: await blobToBase64(rec.blob),
    });
  }
  return parts;
}

export default function MarketingScheduler() {
  const state = useStore();
  const dispatch = useDispatch();

  const stateRef = useRef(state);
  stateRef.current = state;

  function autoEnroll() {
    const buckets = getDueEnrollments(stateRef.current);
    buckets.forEach(({ sequenceId, contactIds }) => {
      if (!contactIds || contactIds.length === 0) return;
      dispatch({
        type: ACTIONS.ENROLL_CONTACTS,
        sequenceId,
        contactIds,
        // authorUserId omitted on auto-enroll — reducer stores null, which
        // reads as "system" in the activity timeline.
        // source: 'auto' tags the enrollment as scheduler-created so the
        // stage-exit logic only unenrolls auto-sourced rows (manual adds
        // are sticky regardless of where the contact is in the pipeline).
        source: 'auto',
      });
    });
  }

  function autoUnenroll() {
    const stale = getStaleEnrollments(stateRef.current);
    stale.forEach((enr) => {
      dispatch({ type: ACTIONS.UNENROLL_CONTACT, enrollmentId: enr.id, reason: 'stage_exit' });
    });
  }

  function fireOne(due) {
    const key = `${due.enrollment.id}::${due.step.id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    // 1. Record the send as pending immediately — Overview tab counts it as
    // soon as it's dispatched, then flips to sent/failed when the adapter resolves.
    dispatch({
      type: ACTIONS.RECORD_MARKETING_SEND,
      send: {
        id: due.sendId,
        enrollmentId: due.enrollment.id,
        sequenceId: due.sequence.id,
        stepId: due.step.id,
        inboxId: due.inboxId,
        contactId: due.contact.id,
        toEmail: due.toEmail,
        subject: due.subject,
        bodyPreview: (due.body || '').slice(0, 200),
        status: 'pending',
        attemptedAt: nowIso(),
        sentAt: null,
        providerMessageId: null,
        failureReason: null,
        marketingHeaders: due.headers,
      },
    });

    // 2. Advance the round-robin counter optimistically. A failed send still
    // consumes a rotation slot — avoiding the alternative (advance only on
    // success) which would re-fire the same broken inbox repeatedly.
    dispatch({ type: ACTIONS.ADVANCE_SEQUENCE_INBOX_INDEX, sequenceId: due.sequence.id });

    // 3. Load attachment blobs from IndexedDB, then fire through the adapter.
    loadAttachmentsForSend(due.attachments)
      .then((attachments) => sendViaInbox(due.inboxId, {
        to: due.toEmail,
        fromName: due.fromName,
        subject: due.subject,
        body: due.body,
        headers: due.headers,
        tags: due.tags,
        attachments,
      }))
      .then((res) => {
        dispatch({
          type: ACTIONS.UPDATE_MARKETING_SEND,
          id: due.sendId,
          patch: {
            status: 'sent',
            sentAt: nowIso(),
            providerMessageId: res?.id || null,
          },
        });
        dispatch({
          type: ACTIONS.ADVANCE_ENROLLMENT_STEP,
          enrollmentId: due.enrollment.id,
          sentAt: nowIso(),
        });
      })
      .catch((err) => {
        dispatch({
          type: ACTIONS.UPDATE_MARKETING_SEND,
          id: due.sendId,
          patch: {
            status: 'failed',
            failureReason: err?.message || 'Send error',
          },
        });
        // Do NOT advance the enrollment on failure — currentStepIndex stays
        // where it was so the next tick retries this same (enrollment, step).
      });
  }

  // State-change reactor.
  useEffect(() => {
    autoEnroll();
    autoUnenroll();
    const due = getDueSends(stateRef.current, new Date());
    due.forEach(fireOne);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.marketingSequences,
    state.marketingEnrollments,
    state.marketingSends,
    state.marketingInboxes,
    state.contacts,
  ]);

  // 60-second tick — covers time-window gates when state is idle.
  useEffect(() => {
    const id = setInterval(() => {
      autoEnroll();
      autoUnenroll();
      const due = getDueSends(stateRef.current, new Date());
      due.forEach(fireOne);
    }, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
