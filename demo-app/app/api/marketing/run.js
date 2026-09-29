// GET /api/marketing/run — server-side marketing send engine, runs WITHOUT a
// browser tab. Driven by a Vercel Cron (see vercel.json). Each run:
//   1. auto-enroll / auto-unenroll (state-only, CAS write), then
//   2. send every due sequence email through its rotation inbox and record the
//      result into the shared org_state document.
//
// This makes the cron the SOLE owner of sequence sends in deployed (authed)
// mode — the client MarketingScheduler is gated off there, which also removes
// the multi-tab double-send. The unsubscribe footer (performSend) and the
// suppression gate (getDueSends) already run server-side, so they come along.
//
// Send safety: the network sends happen FIRST, then their results are recorded
// in a CAS-retry loop. The record step is idempotent ON THE SEND ID (recordSend in
// _lib/marketing/engine.js), so a write conflict re-applies records without
// re-sending.
//
// ⚠️ NOT on (enrollment, step) — this comment used to say hasSent guarded it, and that
// is wrong in a way that matters. hasSent() is the SCHEDULING dedup: getDueSends uses
// it to decide what is due. recordSend deliberately keys on send.id instead, so a
// genuine cross-run retry — a FRESH send id for a previously failed step (AUTO-02) —
// still records. Swapping recordSend onto hasSent would silently disable failed-step
// retries.
//
// ?dryRun=1 returns what WOULD send/enroll without sending or writing — for safe
// verification against production.

import { getDueSends, getDueEnrollments, getStaleEnrollments } from '../../src/lib/marketingScheduler.js';
import {
  applyEnroll, applyUnenroll, recordSend, advanceEnrollment, advanceInboxIndex, markInboxExpired,
} from '../_lib/marketing/engine.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { performSend } from '../_lib/sender.js';
import { loadStepAttachmentsForSend } from '../_lib/marketing/attachments.js';

const CAS_RETRIES = 5;

// A revoked/expired Gmail token surfaces as the send's failureReason. When it
// does, the inbox is flagged expired (INT-01) so it leaves rotation + the UI can
// prompt a reconnect, instead of the cron silently failing every tick.
function isAuthError(reason) {
  return /invalid_grant|invalid_request|unauthor|\b401\b|\b403\b|expired or revoked|token (?:has been )?(?:expired|revoked)|reconnect/i.test(String(reason || ''));
}

// Build the unsubscribe config the same way the client scheduler does, from
// marketingSettings + company (the footer + List-Unsubscribe header are assembled
// inside performSend from this).
function unsubscribeConfig(state) {
  const co = state.company || {};
  const u = state.marketingSettings?.unsubscribe || {};
  return {
    senderCompanyName: co.name || '',
    unsubscribe: {
      enabled: u.enabled !== false,
      message: u.message || '',
      linkText: u.linkText || '',
      includeAddress: u.includeAddress !== false,
      address: (u.address && String(u.address).trim()) ? String(u.address).trim() : (co.address || ''),
      baseUrl: u.baseUrl || '',
    },
  };
}

// Phase 1 — auto-enroll + auto-unenroll. State-only; one CAS write per run.
async function runEnrollments(dryRun) {
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state, version } = await readOrgState();
    let next = state;
    const buckets = getDueEnrollments(next);
    for (const b of buckets) next = applyEnroll(next, b.sequenceId, b.contactIds, 'auto');
    const stale = getStaleEnrollments(next);
    for (const enr of stale) next = applyUnenroll(next, enr.id);

    const enrolled = buckets.reduce((n, b) => n + (b.contactIds?.length || 0), 0);
    if (dryRun || next === state) return { enrolled, unenrolled: stale.length };
    const ok = await writeOrgState(next, version);
    if (ok) return { enrolled, unenrolled: stale.length };
    // version moved under us — re-read + retry
  }
  return { enrolled: 0, unenrolled: 0, enrollConflict: true };
}

// Phase 2 — sends. Network first (no state mutation), then record in a CAS loop.
async function runSends(dryRun) {
  const { state } = await readOrgState();
  const due = getDueSends(state, new Date());

  if (dryRun) {
    return {
      due: due.map((d) => ({
        to: d.toEmail, subject: d.subject, sequenceId: d.sequence.id,
        stepId: d.step.id, inboxId: d.inboxId, attachments: (d.attachments || []).length,
      })),
      sent: 0,
    };
  }
  if (due.length === 0) return { sent: 0, failed: 0 };

  const { senderCompanyName, unsubscribe } = unsubscribeConfig(state);

  // --- network phase: send each, collect outcomes; do NOT touch org_state yet ---
  const results = [];
  for (const d of due) {
    let outcome;
    try {
      const attachments = await loadStepAttachmentsForSend(d.attachments);
      const res = await performSend(d.inboxId, {
        to: d.toEmail,
        fromName: d.fromName,
        subject: d.subject,
        body: d.body,
        headers: d.headers,
        attachments,
        senderCompanyName,
        unsubscribe,
      });
      outcome = { ok: true, providerMessageId: res?.messageId || res?.id || null };
    } catch (err) {
      outcome = { ok: false, failureReason: err?.message || 'Send error' };
    }
    results.push({ d, outcome });
  }

  // --- record phase: idempotent CAS-retry (re-applying never re-sends) ---
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state: fresh, version } = await readOrgState();
    let next = fresh;
    for (const { d, outcome } of results) {
      if ((next.marketingSends || []).some((sd) => sd.id === d.sendId)) continue; // this attempt already recorded
      const now = new Date().toISOString();
      next = recordSend(next, {
        id: d.sendId,
        enrollmentId: d.enrollment.id,
        sequenceId: d.sequence.id,
        stepId: d.step.id,
        inboxId: d.inboxId,
        contactId: d.contact.id,
        toEmail: d.toEmail,
        subject: d.subject,
        bodyPreview: (d.body || '').slice(0, 200),
        marketingHeaders: d.headers,
        status: outcome.ok ? 'sent' : 'failed',
        attemptedAt: now,
        sentAt: outcome.ok ? now : null,
        providerMessageId: outcome.ok ? outcome.providerMessageId : null,
        failureReason: outcome.ok ? null : outcome.failureReason,
      });
      if (outcome.ok) {
        next = advanceEnrollment(next, d.enrollment.id, now);
        next = advanceInboxIndex(next, d.sequence.id);
      } else if (isAuthError(outcome.failureReason)) {
        next = markInboxExpired(next, d.inboxId); // INT-01: drop the dead inbox from rotation
      }
    }
    const sent = results.filter((r) => r.outcome.ok).length;
    const failed = results.length - sent;
    if (next === fresh) return { sent, failed }; // nothing new to record
    const ok = await writeOrgState(next, version);
    if (ok) return { sent, failed };
    // version moved under us — re-read + re-apply (recordSend skips by send id)
  }
  // Sends went out but we couldn't persist the records after retries. Surface it
  // (500) so cron monitoring catches a sustained write problem.
  throw new Error('org_state write kept conflicting while recording sends');
}

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail CLOSED (like
  // /api/push/dispatch): with no secret configured, refuse to run rather than
  // accept unauthenticated calls that could force real drip sends or dry-run-probe
  // pipeline counts.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(secret ? 401 : 500).json({ ok: false, error: secret ? 'Unauthorized' : 'CRON_SECRET is not configured' });
    return;
  }
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  try {
    const enroll = await runEnrollments(dryRun);
    const sends = await runSends(dryRun);
    res.status(200).json({ ok: true, dryRun, ...enroll, ...sends });
  } catch (err) {
    // Hard failure (e.g. org_state read/write down) — return non-2xx so the
    // Vercel cron dashboard flags it instead of silently soft-failing.
    res.status(500).json({ ok: false, error: err?.message || 'marketing run failed' });
  }
}
