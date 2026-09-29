// GET /api/reminders/run — server-side CUSTOMER-REMINDER engine, runs WITHOUT a
// browser tab. Driven by a Vercel Cron (see vercel.json). Mirrors
// /api/marketing/run: read the shared org_state doc, compute what's due, send
// the network calls FIRST, then record the results into org_state in a CAS-retry
// loop (idempotent — a re-applied record never re-sends).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The old client-side ReminderScheduler fired customer emails whenever any staff
// tab was open and flooded managers with failure alerts for no-email accounts
// (KILLED 2026-07-02). This cron replaces that with a tab-independent, gated
// engine. The client ReminderScheduler stays UNMOUNTED — this is the only path.
//
// ── HARD LIMITS (v1) ─────────────────────────────────────────────────────────
//   • EMAIL ONLY. There is NO server-side Twilio/SMS path, so SMS templates
//     (reminder_24h, day_of_eta) are excluded (getDueEmailReminders). Only
//     booking_confirmation + post_service (+ any operator email template) fire.
//   • OFF BY DEFAULT. Every reminder template ships enabled:false; nothing sends
//     until an operator turns a template on (Settings → Customer Reminders) —
//     and enabling on the LIVE org is a deliberate data-op.
//   • ONLY contacts WITH an email on file (the 2026-07-02 flood came from
//     no-email accounts) — a missing address is never even recorded as an attempt.
//   • Deduped by a deterministic per-(job, template) reminderEvent id, so this
//     cron cannot re-send a reminder it (or an old tab) already recorded.
//
// ?dryRun=1 returns what WOULD send without sending or writing — safe against prod.

import { getDueEmailReminders } from '../../src/lib/reminderScheduler.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { getJobsInWindow } from '../_lib/jobsTable.js';
import { sendTransactional, resolveFromAndReplyTo } from '../_lib/email.js';

const CAS_RETRIES = 5;
// Mirror the reducer's cap so the shared reminderEvents log can't grow the blob.
const REMINDER_EVENT_LIMIT = 500;

// Build the From header a reminder sends under (the company office address),
// then run it through the Resend from-allowlist: anything not explicitly
// env-allowlisted is rewritten to the verified default From with the office kept
// as Reply-To, so replies still reach the office and the send never 403s.
// `state.company` is the browser-writable blob, so this address is a REQUEST —
// the allowlist is what makes it safe to build a From from it at all.
function reminderFrom(state) {
  const co = state.company || {};
  const email = (co.email || '').trim();
  const requested = email ? (co.name ? `${co.name} <${email}>` : email) : '';
  return resolveFromAndReplyTo({ from: requested, replyTo: email || null });
}

// Idempotent upsert of one reminder event into the blob by its deterministic id
// (same semantics as the ADD_REMINDER_EVENT reducer). A retry re-uses the row;
// a row already 'sent' is never downgraded.
function upsertEvent(events, evt) {
  const list = events || [];
  const idx = list.findIndex((e) => e.id === evt.id);
  let next;
  if (idx >= 0) {
    if (list[idx].status === 'sent') return list; // already settled — don't touch
    next = list.map((e) => (e.id === evt.id ? { ...e, ...evt } : e));
  } else {
    next = [...list, evt];
  }
  return next.length > REMINDER_EVENT_LIMIT ? next.slice(next.length - REMINDER_EVENT_LIMIT) : next;
}

async function runReminders(dryRun) {
  const { state } = await readOrgState();
  // Jobs live in public.jobs now (B1); the reminder engine scans jobs to find due
  // sends, and state.jobs is written empty by every client save — inject the near-term
  // window the engine actually needs, or it can never find anything due (silent C01).
  const jobs = await getJobsInWindow({ backDays: 7, forwardDays: 45 });
  const due = getDueEmailReminders({ ...state, jobs }, new Date());

  if (dryRun) {
    return {
      due: due.map((d) => ({
        template: d.template.key,
        jobId: d.job.id,
        to: d.recipient,
        subject: d.subject,
        eventId: d.eventId,
      })),
      sent: 0,
    };
  }
  if (due.length === 0) return { sent: 0, failed: 0 };

  const { from, replyTo } = reminderFrom(state);

  // ── network phase: send each; DO NOT touch org_state yet ───────────────────
  const results = [];
  for (const d of due) {
    let outcome;
    try {
      const res = await sendTransactional({
        to: d.recipient,
        from,
        replyTo: replyTo || undefined,
        subject: d.subject || '(no subject)',
        body: d.body,
        tags: ['reminder', d.template.key],
      });
      outcome = res?.ok
        ? { ok: true, providerMessageId: res.id || null }
        : { ok: false, failureReason: res?.error || 'Email send failed' };
    } catch (err) {
      outcome = { ok: false, failureReason: err?.message || 'Email send error' };
    }
    results.push({ d, outcome });
  }

  // ── record phase: idempotent CAS-retry (re-applying never re-sends) ─────────
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state: fresh, version } = await readOrgState();
    let events = fresh.reminderEvents || [];
    const now = new Date().toISOString();
    for (const { d, outcome } of results) {
      // A concurrent writer may already have recorded this exact send as 'sent'.
      const existing = events.find((e) => e.id === d.eventId);
      if (existing && existing.status === 'sent') continue;
      events = upsertEvent(events, {
        id: d.eventId,
        templateKey: d.template.key,
        jobId: d.job.id,
        clientId: d.client.id,
        channel: 'email',
        recipient: d.recipient,
        subject: d.subject || null,
        body: d.body,
        attempts: d.attempt,
        status: outcome.ok ? 'sent' : 'failed',
        sentAt: outcome.ok ? now : null,
        providerMessageId: outcome.ok ? outcome.providerMessageId : null,
        failureReason: outcome.ok ? null : outcome.failureReason,
        source: 'cron',
        readAt: null,
      });
    }
    const next = { ...fresh, reminderEvents: events };
    const sent = results.filter((r) => r.outcome.ok).length;
    const failed = results.length - sent;
    if (events === (fresh.reminderEvents || [])) return { sent, failed }; // nothing new to record
    const ok = await writeOrgState(next, version);
    if (ok) return { sent, failed };
    // version moved under us — re-read + re-apply
  }
  // Sends went out but records kept conflicting — surface a 500 so cron
  // monitoring flags a sustained write problem (mirrors marketing/run).
  throw new Error('org_state write kept conflicting while recording reminders');
}

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail CLOSED (like
  // /api/marketing/run + /api/push/dispatch): with no secret configured, refuse
  // to run rather than accept an unauthenticated call that could force real sends.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(secret ? 401 : 500).json({ ok: false, error: secret ? 'Unauthorized' : 'CRON_SECRET is not configured' });
    return;
  }
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  try {
    const out = await runReminders(dryRun);
    res.status(200).json({ ok: true, dryRun, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'reminder run failed' });
  }
}
