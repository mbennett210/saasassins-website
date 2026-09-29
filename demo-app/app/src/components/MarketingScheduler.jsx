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
import { loadMarketingAttachment, backfillMarketingAttachmentsToStorage } from '../lib/attachments';
import { nowIso } from '../lib/dates';
import { inFlight } from '../lib/marketingInFlight';
import { isAuthConfigured } from '../lib/supabaseClient';

const TICK_MS = 60 * 1000;

// Module-level in-flight guard (keyed enrollmentId::stepId) now lives in
// lib/marketingInFlight so the Diagnostics "Retry" can clear a key and let this
// scheduler re-fire. Survives StrictMode's double-mount; state-based hasSent()
// covers refires after a reload.

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

  // In deployed (authed) mode the api/marketing/run cron is the SOLE owner of
  // enroll / unenroll / send — so it runs with no tab open and there's no
  // multi-tab double-send. This component only drives sends in local-only mode.
  const authed = isAuthConfigured();

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
      .then((attachments) => {
        // Server-side CAN-SPAM footer config (the link itself is signed server-
        // side). Resolves the address + base-URL overrides from Marketing Settings.
        const co = stateRef.current.company || {};
        const u = stateRef.current.marketingSettings?.unsubscribe || {};
        return sendViaInbox(due.inboxId, {
          to: due.toEmail,
          fromName: due.fromName,
          subject: due.subject,
          body: due.body,
          headers: due.headers,
          tags: due.tags,
          attachments,
          senderCompanyName: co.name || '',
          unsubscribe: {
            enabled: u.enabled !== false,
            message: u.message || '',
            linkText: u.linkText || '',
            includeAddress: u.includeAddress !== false,
            address: (u.address && u.address.trim()) ? u.address.trim() : (co.address || ''),
            baseUrl: u.baseUrl || '',
          },
        });
      })
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
        // Clear the in-flight guard so the retry-aware getDueSends can re-fire
        // this (enrollment, step) after the backoff (AUTO-02). currentStepIndex
        // stays put; state-based dedup prevents a duplicate within an attempt.
        inFlight.delete(key);
      });
  }

  // State-change reactor — local-only mode (deployed mode runs the cron instead).
  useEffect(() => {
    if (authed) return;
    autoEnroll();
    autoUnenroll();
    const due = getDueSends(stateRef.current, new Date());
    due.forEach(fireOne);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    authed,
    state.marketingSequences,
    state.marketingEnrollments,
    state.marketingSends,
    state.marketingInboxes,
    state.contacts,
  ]);

  // 60-second tick — local-only mode only.
  useEffect(() => {
    if (authed) return undefined;
    const id = setInterval(() => {
      autoEnroll();
      autoUnenroll();
      const due = getDueSends(stateRef.current, new Date());
      due.forEach(fireOne);
    }, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Deployed mode: one-time-per-device backfill of marketing attachment blobs to
  // Supabase Storage, so the send cron can attach files added before the Storage
  // mirror existed. Gated by a localStorage flag so it runs once.
  useEffect(() => {
    if (!authed) return;
    const FLAG = 'rfs.marketingAttachmentsBackfilled.v1';
    try { if (localStorage.getItem(FLAG)) return; } catch { return; }
    backfillMarketingAttachmentsToStorage()
      .then(() => { try { localStorage.setItem(FLAG, '1'); } catch { /* ignore */ } })
      .catch(() => { /* retry on next load */ });
  }, [authed]);

  return null;
}
