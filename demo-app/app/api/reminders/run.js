// GET /api/reminders/run — THE CUSTOMER-MESSAGE ENGINE, run by a Vercel Cron every 5 minutes
// (vercel.json), with no browser tab. Matt's approved messages (2026-10-19) on the engine that
// started as the booking / post-service reminders.
//
// ── ONE RUN ──────────────────────────────────────────────────────────────────
//   1. read the shared record (templates, customers, contacts, locations, company) and the jobs
//      window (−7 … +45 days; jobs live in public.jobs, never in the blob — the C01 trap);
//   2. ask the pure walkers what is due NOW (src/lib/reminderScheduler.js getDueMessages: time-
//      bounded so switching a template on never sends about the past, the org's clock and its
//      09:00–19:00 window, consent);
//   3. drop what cannot leave now — texts while Twilio is not set up, email while no Google
//      mailbox is the system sender — with ONE log line each, nothing recorded, so they go once
//      the channel is set up and the message is still due;
//   4. drop what the SENT LOG says already went (customer_messages, the table — never a list in
//      the shared record: the visit summary alone is ~750 a night at Matt's book, CS-119);
//   5. confirm each remaining item's history check (api/_lib/customerMessages/checks.js) — ruled
//      out ones are recorded 'skipped' so the question is never asked again;
//   6. hold email to the mailbox's daily ceiling (CUSTOMER_EMAIL_DAILY_BUDGET) and the run to
//      MAX_SENDS_PER_RUN, the receipts and visit messages first;
//   7. for each: CLAIM it in the sent log (the lease: two runs never both send one), send it
//      through THE send step (api/_lib/customerMessages/send.js — it refuses any sample record),
//      record the outcome; a message standing for collapsed siblings settles them;
//   8. tell the office about a message that failed for good (the `reminderFailed` bell);
//   9. once an hour, delete sent-log rows past their keep_until.
// The run never writes the shared record except for those bells.
//
// ?dryRun=1 answers what WOULD send (after steps 1–6) without claiming, sending or writing.
import { getDueMessages, MAX_REMINDER_ATTEMPTS, SURVEY_LINK_PLACEHOLDER } from '../../src/lib/reminderScheduler.js';
import { dayKey, startOfDayKey } from '../../src/lib/dates.js';
import { fanOutManagerAlert } from '../../src/lib/notifications.js';
import { seedRecordIn } from '../../src/lib/ids.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { getJobsInWindow } from '../_lib/jobsTable.js';
import { resolveFromAndReplyTo, systemSenderReady } from '../_lib/email.js';
import { smsConfigured } from '../_lib/sms/twilio.js';
import { sendCustomerMessage } from '../_lib/customerMessages/send.js';
import { OPTED_OUT_REASON, SAMPLE_RECORD_REASON } from '../../src/lib/texting.js';
import {
  MESSAGE_STATUS, STALE_SENDING_MS, readMessages, insertNew, claimExisting, finishMessage,
  settleSkipped, countSentSince, reapMessages, readPending,
} from '../_lib/customerMessages/store.js';
import { resolveChecks } from '../_lib/customerMessages/checks.js';
import { readSeriesStarts, readComplaints, readRaisers } from '../_lib/customerMessages/sources.js';
import { readContractDates } from '../_lib/customerMessages/contractEvents.js';
import { readBilling } from '../_lib/customerMessages/billing.js';
import { statementPdfBase64, statementFilename } from '../_lib/customerMessages/statementPdf.js';
import { mintSurvey, reapSurveys } from '../_lib/customerMessages/surveys.js';
import { MESSAGE_KEY as K, EVENT_MAX_AGE_HOURS, UPSELL_AFTER_DAYS, DAY_GRACE_DAYS, STATEMENT_DAY_OF_MONTH } from '../../src/lib/customerMessages.js';
import { unsubscribeUrl } from '../_lib/marketing/compliance.js';
import { refuseUnconfiguredCron } from '../_lib/cronGate.js';

// Gmail sends about 2,000 messages a day from one Workspace mailbox. Customer messages keep to
// this many, leaving the rest for the office's own mail (quotes, invites, the hub's emails);
// what does not fit waits for the next day while it is still due (every dated message has
// DAY_GRACE_DAYS). The volume per message at Matt's book is in the reminders brain card.
export const CUSTOMER_EMAIL_DAILY_BUDGET = 1500;
// One run sends at most this many (a Gmail send is a few hundred ms; the function has 60 s).
export const MAX_SENDS_PER_RUN = 100;
const RUN_BUDGET_MS = 45 * 1000;
const CAS_RETRIES = 5;
export const config = { maxDuration: 60 };

// The From a message sends under. `state.company` is the browser-writable blob, so the office
// address is a REQUEST, never an instruction: Gmail sends as the system sender and the office
// address rides as the Reply-To, so replies still reach the office.
async function senderOf(state) {
  const co = state.company || {};
  const email = (co.email || '').trim();
  const requested = email ? (co.name ? `${co.name} <${email}>` : email) : '';
  return resolveFromAndReplyTo({ from: requested, replyTo: email || null });
}

// One due item as the send step's message. `refs` names every record it is about, so the step's
// sample-record guard sees the customer, the contact, the clean, the location and the deal.
export function dueMessage(d, { from, replyTo } = {}) {
  const nudgeEmail = d.message?.transactional === false && d.channel === 'email';
  const unsub = nudgeEmail ? unsubscribeUrl(d.recipient) : '';
  return {
    templateKey: d.templateKey,
    channel: d.channel,
    to: d.recipient,
    from,
    replyTo: replyTo || undefined,
    subject: d.subject || '(no subject)',
    body: d.body,
    tags: ['reminder', d.templateKey],
    // A nudge carries the one-click unsubscribe (RFC 8058), the same signed link as its opt-out line.
    headers: unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    refs: d.refs || {},
  };
}

// The sent-log row for a due item (or one it settles).
const rowOf = (d, status) => ({
  id: d.id,
  templateKey: d.templateKey,
  channel: d.channel || 'email',
  clientId: d.refs?.clientId ?? d.clientId ?? null,
  contactId: d.refs?.contactId ?? null,
  jobId: d.refs?.jobId ?? d.jobId ?? null,
  subjectId: d.subjectId ?? null,
  recipient: d.recipient ?? null,
  status,
  keepUntil: d.keepUntil || new Date(Date.now() + 35 * 864e5).toISOString(),
});

// What the sent log says about an item: 'new' (claim by insert), 'claim' (claim the row), or
// 'done' (it went, was refused or skipped, is being sent now, or has used its attempts).
function logState(row, nowMs) {
  if (!row) return 'new';
  if (row.status === MESSAGE_STATUS.pending) return 'claim';
  if (row.status === MESSAGE_STATUS.failed) return (row.attempts || 0) < MAX_REMINDER_ATTEMPTS ? 'claim' : 'done';
  if (row.status === MESSAGE_STATUS.sending) return nowMs - Date.parse(row.updated_at || 0) > STALE_SENDING_MS ? 'claim' : 'done';
  return 'done';
}

// The office's bell for messages that failed for good — one row per message, at most ten a run
// (then one that counts the rest), through the shared record's CAS.
async function alertExhausted(failures) {
  if (!failures.length) return;
  const shown = failures.slice(0, 10);
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state, version } = await readOrgState();
    let notifications = state.notifications || [];
    const clients = new Map((state.clients || []).map((c) => [c.id, c]));
    for (const f of shown) {
      const client = clients.get(f.clientId);
      const chan = f.channel === 'sms' ? 'text' : 'email';
      notifications = fanOutManagerAlert({ ...state, notifications }, {
        eventKey: 'reminderFailed',
        title: `Customer ${chan} failed${client ? `. ${client.name}` : ''}`,
        body: f.reason || 'A customer message could not be delivered.',
        url: f.jobId ? `/schedule/${f.jobId}` : (f.clientId ? `/clients/${f.clientId}` : '/settings/reminders'),
        actorUserId: null,
      });
    }
    if (failures.length > shown.length) {
      notifications = fanOutManagerAlert({ ...state, notifications }, {
        eventKey: 'reminderFailed',
        title: `${failures.length - shown.length} more customer messages failed`,
        body: 'They could not be delivered after several tries.',
        url: '/settings/reminders',
        actorUserId: null,
      });
    }
    if (await writeOrgState({ ...state, notifications }, version)) return;
  }
  console.error('[reminders] the failed-message bells could not be written (org_state kept conflicting)');
}

// The other tables a run reads — each only when a message that needs it is switched on.
async function readSources(state, now) {
  const on = new Set((state.reminderTemplates || []).filter((t) => t?.enabled === true).map((t) => t.key));
  const since = new Date(now.getTime() - EVENT_MAX_AGE_HOURS * 3600e3).toISOString();
  const day = 864e5;
  const out = {};
  if (on.has(K.upsell)) {
    out.serviceStarts = await readSeriesStarts(
      new Date(now.getTime() - (UPSELL_AFTER_DAYS + DAY_GRACE_DAYS + 1) * day).toISOString(),
      new Date(now.getTime() - (UPSELL_AFTER_DAYS - 1) * day).toISOString(),
    ) || [];
  }
  if (on.has(K.complaintAck) || on.has(K.complaintResolution)) {
    out.complaints = await readComplaints(since) || [];
    out.raisers = await readRaisers(out.complaints);
  }
  if (on.has(K.renewalNotice) || on.has(K.renewalOffer) || on.has(K.priceIncrease)) {
    out.contractDates = await readContractDates(dayKey(now, state.company?.timezone)) || [];
  }
  if (on.has(K.upcomingDue) || on.has(K.statement)) {
    const today = dayKey(now, state.company?.timezone);
    const dom = Number(today.slice(8, 10));
    const withStatements = on.has(K.statement) && dom >= STATEMENT_DAY_OF_MONTH && dom <= STATEMENT_DAY_OF_MONTH + DAY_GRACE_DAYS;
    out.billing = await readBilling({ now, today, withStatements });
  }
  // What a route queued (the service-change confirmation).
  const queued = [K.serviceChange].filter((k) => on.has(k));
  if (queued.length) {
    try { out.pending = await readPending(queued, since); } catch (e) { console.error('[reminders] queue read failed:', e?.message || e); out.pending = []; }
  }
  return out;
}

export async function runCustomerMessages({ dryRun = false, now = new Date() } = {}) {
  const started = Date.now();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const { state } = await readOrgState();
  const tz = state.company?.timezone;
  const out = { sent: 0, failed: 0, refused: 0, skipped: 0, deferred: 0 };
  if (!dryRun && now.getUTCMinutes() < 5) { await reapMessages(nowIso); await reapSurveys(now); }

  const anyOn = (state.reminderTemplates || []).some((t) => t?.enabled === true);
  if (!anyOn) return dryRun ? { due: [], ...out } : out;

  const jobs = await getJobsInWindow({ backDays: 7, forwardDays: 45 });
  const input = { state, jobs, unsubscribeUrl: (addr) => unsubscribeUrl(addr), ...(await readSources(state, now)) };
  let due = getDueMessages(input, now);

  // ── 3. channels that cannot send now ──
  const textsOn = smsConfigured();
  const emailOn = await systemSenderReady();
  const texts = due.filter((d) => d.channel === 'sms').length;
  const emails = due.filter((d) => d.channel === 'email').length;
  if (!textsOn && texts) console.warn(`[reminders] ${texts} text(s) not sent: texting is not set up`);
  if (!emailOn && emails) console.warn(`[reminders] ${emails} email(s) not sent: no Google mailbox is the system sender`);
  due = due.filter((d) => (d.channel === 'sms' ? textsOn : emailOn));
  if (!due.length) return dryRun ? { due: [], ...out } : out;

  // ── 4. the sent log ──
  const rows = await readMessages(due.flatMap((d) => [d.id, ...(d.settles || []).map((s) => s.id)]));
  due = due.filter((d) => logState(rows.get(d.id), nowMs) !== 'done');

  // ── 5. the history checks ──
  const { go, skip, wait } = await resolveChecks(due, { jobs });
  out.deferred += wait.length;
  if (!dryRun && skip.length) {
    await settleSkipped(skip.map((d) => rowOf(d, MESSAGE_STATUS.skipped)), nowIso);
    out.skipped += skip.length;
  }

  // ── 6. the daily ceiling and the run's size ──
  let emailRoom = CUSTOMER_EMAIL_DAILY_BUDGET - (go.some((d) => d.channel === 'email')
    ? await countSentSince('email', startOfDayKey(dayKey(now, tz), tz).toISOString()) : 0);
  const send = [];
  for (const d of go) {
    if (send.length >= MAX_SENDS_PER_RUN) { out.deferred += 1; continue; }
    if (d.channel === 'email') {
      if (emailRoom <= 0) { out.deferred += 1; continue; }
      emailRoom -= 1;
    }
    send.push(d);
  }

  if (dryRun) {
    return {
      ...out,
      skipped: skip.length,
      due: send.map((d) => ({
        template: d.templateKey, id: d.id, channel: d.channel, to: d.recipient, subject: d.subject,
        // The send step would refuse it: a seed customer, contact, clean or location.
        sampleRecord: seedRecordIn(d.refs),
      })),
    };
  }

  // ── 7. claim, send, record ──
  const sender = send.some((d) => d.channel === 'email') ? await senderOf(state) : {};
  const exhausted = [];
  const settle = (d, at) => (d.settles?.length
    ? settleSkipped(d.settles.map((s) => rowOf({ ...s, keepUntil: d.keepUntil, channel: d.channel }, MESSAGE_STATUS.skipped)), at)
    : null);
  for (const d of send) {
    if (Date.now() - started > RUN_BUDGET_MS) { out.deferred += 1; continue; }
    const prev = rows.get(d.id);
    const claimed = prev ? await claimExisting(prev, new Date().toISOString())
      : (await insertNew([{ ...rowOf(d, MESSAGE_STATUS.sending), attempts: 1 }])).has(d.id);
    if (!claimed) continue;                       // another run holds it
    const msg = dueMessage(d, sender);
    if (d.templateKey === K.statement && d.payload?.statement) {
      // The statement email says "Attached is your monthly account statement": no PDF, no email.
      try {
        msg.attachments = [{ filename: statementFilename(d.payload.statement.month), content: await statementPdfBase64(d.payload.statement, state.company || {}) }];
      } catch (e) {
        await finishMessage(d.id, { status: MESSAGE_STATUS.failed, failureReason: `statement PDF: ${e?.message || 'failed'}`, recipient: d.recipient });
        out.failed += 1;
        continue;
      }
    }
    if (d.payload?.survey) {
      // The customer's own survey link, minted now (one CSPRNG token per email; the table keeps its
      // hash). No row, no link: the message is recorded failed and nothing is sent.
      try {
        const { link } = await mintSurvey({ messageId: d.id, clientId: d.refs?.clientId, contactId: d.refs?.contactId, now: new Date() });
        msg.body = msg.body.split(SURVEY_LINK_PLACEHOLDER).join(link);
      } catch (e) {
        await finishMessage(d.id, { status: MESSAGE_STATUS.failed, failureReason: `survey link: ${e?.message || 'failed'}`, recipient: d.recipient });
        out.failed += 1;
        continue;
      }
    }
    const res = await sendCustomerMessage(msg);
    const at = new Date().toISOString();
    if (res.ok) {
      await finishMessage(d.id, { status: MESSAGE_STATUS.sent, providerMessageId: res.id || null, recipient: d.recipient }, at);
      out.sent += 1;
      await settle(d, at);
    } else if (res.refused || res.optedOut) {
      // Refused, and settled for good: a sample record, or a number that replied STOP (nothing to
      // try again, and no failure for the office to chase; the customer's page says texts are off).
      await finishMessage(d.id, { status: MESSAGE_STATUS.refused, failureReason: res.optedOut ? OPTED_OUT_REASON : SAMPLE_RECORD_REASON, recipient: d.recipient }, at);
      out.refused += 1;
      await settle(d, at);
    } else {
      await finishMessage(d.id, { status: MESSAGE_STATUS.failed, failureReason: res.error || res.skipped || 'Send failed', recipient: d.recipient }, at);
      out.failed += 1;
      const attempts = !prev ? 1 : (prev.status === MESSAGE_STATUS.pending ? (prev.attempts || 0) : (prev.attempts || 0) + 1);
      if (attempts >= MAX_REMINDER_ATTEMPTS) {
        exhausted.push({ clientId: d.refs?.clientId, jobId: d.refs?.jobId, channel: d.channel, reason: res.error || 'Send failed' });
      }
    }
  }

  // ── 8. the office hears about a message that failed for good ──
  await alertExhausted(exhausted);
  return out;
}

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail CLOSED: with no secret
  // configured, refuse to run rather than accept an unauthenticated call that could force real
  // sends. An unset secret is a 500 with a body that names nothing (`_lib/cronGate.js`); a wrong
  // or missing bearer is a 401.
  const secret = process.env.CRON_SECRET;
  if (!secret) { refuseUnconfiguredCron(res, 'reminders/run'); return; }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  try {
    const out = await runCustomerMessages({ dryRun });
    res.status(200).json({ ok: true, dryRun, ...out });
  } catch (err) {
    console.error('[reminders] run failed:', err?.message || err);
    res.status(500).json({ ok: false, error: 'The customer-message run failed.' });
  }
}
