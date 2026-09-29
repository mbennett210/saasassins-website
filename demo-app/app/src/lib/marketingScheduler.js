// ─────────────────────────────────────────────────────────────────────────────
// Marketing scheduler — pure functions over state.
//
// Mirrors the shape of lib/reminderScheduler.js: pure walkers that take state
// and return work, no side effects. The dispatcher (components/MarketingScheduler.jsx)
// is the only place that touches dispatch.
//
// Exports:
//   getDueSends(state, now)
//     — walks active sequences × active enrollments × current step, gated by
//       hasSent dedup + time-window + days-between + reply-halt + per-inbox
//       send-interval throttle + per-inbox daily cap. Round-robin picks via
//       activeInboxes[seq.nextInboxIndex % activeInboxes.length].
//   getDueEnrollments(state)
//     — for sequences with audienceMode==='auto', returns contactIds who are the
//       primary contact of an open opportunity at a configured source stage and
//       aren't already enrolled.
//   getStaleEnrollments(state)
//     — for sequences with onStageExit==='unenroll', returns enrollments whose
//       contact no longer has an open deal at any of the source stages.
//   correlateReplyToEnrollment(state, inboundMsg)
//     — header chain match first, from-email fallback second.
//   hasSent, stepDelayMinutes, formatStepDelay, formatStepDelayShort,
//   buildMarketingVariables, interpolate, stripHtml
//     — helpers exported for testability + reuse.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: this module is imported server-side by api/marketing/run (the send cron)
// as well as in the browser. Keep it free of any browser-only globals, and use
// explicit .js extensions on relative imports so raw Node ESM (Vercel functions)
// can resolve it — Vite resolves both forms.
import { newId } from './ids.js';
import { isDoNotContact, buildSuppressedEmailSet } from './contactConsent.js';
import { DEFAULT_ORG_TIMEZONE } from './dates.js';

// Dedup: never re-fire the same (enrollmentId, stepId) pair. Reads from the
// persistent sends log so dedup survives reloads.
export function hasSent(sends, enrollmentId, stepId) {
  return (sends || []).some(
    (sd) => sd.enrollmentId === enrollmentId && sd.stepId === stepId
  );
}

// Retry policy for failed sends (AUTO-02): a step whose only attempts failed is
// retried up to MAX_SEND_ATTEMPTS, waiting SEND_RETRY_BACKOFF_MS between tries,
// then given up. A delivered (sent/pending) step is never retried.
const MAX_SEND_ATTEMPTS = 3;
const SEND_RETRY_BACKOFF_MS = 15 * 60 * 1000;

// ── Step delay ───────────────────────────────────────────────────────────────
// A step's wait-before-send is stored canonically as `delayMinutes`, which lets
// a sequence drip on an hourly cadence (1-hour minimum), not just whole days.
// Steps saved before sub-day delays existed only carry the legacy whole-day
// `daysAfterPrevious`; read those as ×1440 so old sequences keep firing without
// a data migration. Always returns a non-negative number of minutes.
export function stepDelayMinutes(step) {
  if (!step) return 0;
  const m = Number(step.delayMinutes);
  if (Number.isFinite(m)) return Math.max(0, m);
  const d = Number(step.daysAfterPrevious);
  return Number.isFinite(d) ? Math.max(0, d) * 1440 : 0;
}

// Human label for a step's delay — "1 hour", "6 hours", "1 day", "3 days".
// Whole-day multiples render in days; everything else rounds to hours.
// 0 → "Immediately" (the first step, or a legacy zero-wait follow-up).
export function formatStepDelay(step) {
  const mins = stepDelayMinutes(step);
  if (mins <= 0) return 'Immediately';
  if (mins % 1440 === 0) {
    const d = mins / 1440;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (mins % 60 === 0) {
    const h = mins / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

// Compact form for tight chips — "3d" / "6h" (no leading sign). 0 → "0d".
export function formatStepDelayShort(step) {
  const mins = stepDelayMinutes(step);
  if (mins > 0 && mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins > 0 && mins % 60 === 0) return `${mins / 60}h`;
  if (mins > 0) return `${mins}m`;
  return '0d';
}

// Map a raw send failureReason to a plain-English { label, hint } for the
// Diagnostics view. Falls back to the raw reason as the hint.
export function humanizeFailure(reason) {
  const r = String(reason || '').toLowerCase();
  if (!r) return { label: 'Send failed', hint: 'No reason was recorded. Retry, and check the sending inbox if it keeps failing.' };
  if (/502|503|504|bad gateway|gateway|timeout|timed out|econnrefused|failed to fetch|networkerror|network error|fetch failed|network/.test(r))
    return { label: 'Sending service unreachable', hint: 'The email backend or sending account was offline. Once it’s back, hit Retry.' };
  if (/401|403|unauthor|invalid_grant|invalid_request|invalid.*token|token.*expired|expired|revoked|credential|reconnect|\bauth\b/.test(r))
    return { label: 'Sending account needs reconnecting', hint: 'Its authorization expired or was revoked. Reconnect the inbox under Marketing → Inboxes, then Retry.' };
  if (/no .*inbox|inbox .*required|connected inbox|inbox id is required/.test(r))
    return { label: 'No connected sending inbox', hint: 'Connect a sending inbox under Marketing → Inboxes, then Retry.' };
  if (/recipient|to email|no email|invalid.*email|email is empty|body is empty|subject is required/.test(r))
    return { label: 'Email couldn’t be built', hint: 'The contact or step is missing something (email, subject, or body). Fix it, then Retry.' };
  return { label: 'Send failed', hint: String(reason) };
}

// Strip HTML tags + decode the most common entities. Conservative — preserves
// line breaks (<br>, <p>, </p>, </div>) as newlines so plain-text sends keep
// the visual structure of the source body.
export function stripHtml(input) {
  if (!input) return '';
  return String(input)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Catalog of the variables a user can insert into a step's subject + body.
// Single source of truth — buildMarketingVariables() below must return a value
// for every `key` here; the Step editor's variable picker renders this list;
// and Settings → Tags & Variables shows it as a read-only reference. Per entry:
//   group        — 'contact' | 'brand' | 'sequence' (sections the reference view)
//   from         — where the value is routed from, in plain language
//   companyField — brand vars whose live value is a state.company field
export const MARKETING_VARIABLES = [
  // ----- Contact: resolved per recipient -----
  { key: 'firstName',     label: 'First name',     group: 'contact',  from: "The contact's first name" },
  { key: 'lastName',      label: 'Last name',      group: 'contact',  from: "The contact's last name" },
  { key: 'fullName',      label: 'Full name',      group: 'contact',  from: "The contact's first and last name combined" },
  { key: 'email',         label: 'Email address',  group: 'contact',  from: "The contact's email address" },
  { key: 'phone',         label: 'Phone number',   group: 'contact',  from: "The contact's phone number" },
  { key: 'title',         label: 'Job title',      group: 'contact',  from: "The contact's job title" },
  { key: 'company',       label: 'Company',        group: 'contact',  from: "The contact's linked account name, or their Company field" },
  { key: 'stage',         label: 'Deal stage',     group: 'contact',  from: "The stage of the contact's company deal, if any" },
  { key: 'lifecycle',     label: 'Lifecycle',      group: 'contact',  from: "The contact's lifecycle. Lead, prospect, client" },
  // ----- Brand: your company + the sending teammate -----
  { key: 'senderName',    label: 'Sender name',    group: 'brand',    from: 'The teammate whose inbox sends the email' },
  { key: 'senderCompany', label: 'Your company',   group: 'brand',    from: 'Settings → Company', companyField: 'name' },
  { key: 'senderPhone',   label: 'Your phone',     group: 'brand',    from: 'Settings → Company', companyField: 'phone' },
  { key: 'signature',     label: 'Signature',      group: 'brand',    from: 'The signature block of the inbox that sends the email' },
  // ----- Sequence -----
  { key: 'sequenceName',  label: 'Sequence name',  group: 'sequence', from: 'The name of the sequence the email belongs to' },
];

// Variable map for a contact — the {placeholders} a user can drop into a
// step's subject + body. Missing values resolve to empty string (not
// undefined / null) so interpolated strings stay clean; pair with
// interpolate's {name|fallback} syntax to substitute a default when blank.
export function buildMarketingVariables({ contact, sequence, sender, inbox, state }) {
  const c = contact || {};
  const s = state || {};
  // {company} prefers the linked Client account's name — matching how the
  // rest of the app resolves company — and falls back to the free-text
  // customFields.company for contacts not attached to a Client.
  const client = c.companyId ? (s.clients || []).find((x) => x.id === c.companyId) : null;
  const company = client?.name || c.customFields?.company || '';
  // {stage} resolves to the human label of this contact's company DEAL stage — the
  // open opportunity they're the primary of, else any open opportunity at their
  // company. Blank when there's no open deal (a person is never on a pipeline).
  const opps = s.opportunities || [];
  const deal = opps.find((o) => o.status === 'open' && o.primaryContactId === c.id)
    || (c.companyId ? opps.find((o) => o.status === 'open' && o.clientId === c.companyId) : null)
    || null;
  const dealPipeline = deal ? (s.pipelines || []).find((p) => p.id === deal.pipelineId) : null;
  const stageObj = dealPipeline && deal.stage
    ? (dealPipeline.stages || []).find((st) => st.key === deal.stage)
    : null;
  const co = s.company || {};
  const vars = {
    // ----- Contact -----
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    fullName: [c.firstName, c.lastName].filter(Boolean).join(' '),
    email: c.email || '',
    phone: c.phone || '',
    title: c.title || '',
    company,
    stage: stageObj?.label || '',
    lifecycle: c.lifecycle || '',
    // ----- Sender / brand -----
    senderName: sender?.name || '',
    senderCompany: co.name || '',
    senderPhone: co.phone || '',
    // ----- Sequence -----
    sequenceName: sequence?.name || '',
  };
  // {signature} resolves to the sending inbox's signature block. The block
  // may itself contain {variables} (e.g. {senderName}), so interpolate it
  // against the vars above before exposing it.
  vars.signature = interpolate(inbox?.signature || '', vars);
  return vars;
}

// {placeholder} substitution. Supports an optional fallback after a pipe —
// {firstName|there} renders "there" when firstName is empty. An unknown
// variable is left literally in place so the user can spot a typo (rather
// than it silently rendering nothing).
export function interpolate(template, variables) {
  if (!template) return '';
  return String(template).replace(/\{(\w+)(?:\|([^}]*))?\}/g, (match, key, fallback) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      const val = variables[key];
      if (val != null && String(val) !== '') return String(val);
      return fallback != null ? fallback : '';
    }
    return match;
  });
}

// Read the active rotation set in the same way the dispatcher does — keeps
// getDueSends self-contained without importing the selector module (which
// would create a circular-ish path from lib → store → seed).
function activeMarketingInboxes(state) {
  return (state.marketingInboxes || [])
    .filter((i) => i.enabled !== false && i.status === 'active')
    .sort((a, b) => (a.rotationOrder ?? 0) - (b.rotationOrder ?? 0));
}

// Resolve the hour-of-day (0–23) in a given IANA timezone. A null / blank tz
// means "use this device's local timezone" — i.e. the user's own timezone,
// which is the default. Falls back to local time if the tz string is invalid.
// Resolve the zone the send window is judged in. NEVER falls back to the device
// timezone: the drip engine is cron-owned in deployed mode, Vercel functions run
// TZ=UTC in every region, and an operator's "send 9-5" window judged against UTC
// fires ~2am-10am for a Pacific business — prospect email in the middle of the
// night. This is the same principle dates.js already states for the org clock:
// "an operator in Manila must still see the business's Los-Angeles schedule, not
// their own."
//
// Reads company.timezone off the passed state rather than dates.js's module-level
// ORG_TZ, because that is set by StoreProvider — which never runs on the server,
// so on a cron it would always be the bare default and a clone in another zone
// would silently get Los Angeles.
function sendZone(state) {
  return state?.marketingSettings?.sendTimezone
    || state?.company?.timezone
    || DEFAULT_ORG_TIMEZONE;
}

function hourInZone(date, tz) {
  if (!tz) return date.getHours();
  try {
    const h = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date),
      10
    );
    return Number.isFinite(h) ? h % 24 : date.getHours();
  } catch {
    return date.getHours();
  }
}

// Resolve the calendar day (YYYY-MM-DD) of a date in a given IANA timezone.
// A null / blank tz means "use this device's local timezone". Used to bucket
// sends into per-day counts for the per-inbox daily cap. en-CA formats as
// YYYY-MM-DD; falls back to local date parts if the tz string is invalid.
function dayKeyInZone(date, tz) {
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(date);
    } catch {
      // fall through to local
    }
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Walk active sequences × active enrollments × current step, return what's
// due to fire right now. The dispatcher iterates the result and fires one at
// a time through sendViaInbox().
//
// On an excluded calendar day (marketingSettings.excludedDates — holidays /
// blackout dates, evaluated in the sending timezone) the whole batch returns
// [] and nothing sends.
//
// Gates (all must pass):
//   1. sequence.status === 'active'
//   2. sequence has at least one step
//   3. enrollment.status === 'active' AND repliedAt is falsy
//   4. enrollment.currentStepIndex < sequence.steps.length
//   5. hasSent(sends, enrollment.id, step.id) === false
//   6. the step's delay (stepDelayMinutes) has elapsed since enrollment.lastSentAt (step 0 fires immediately)
//   7. current hour (in marketingSettings.sendTimezone) ∈ [sendHourStart, sendHourEnd)
//   8. contact has an email address
//   8a. contact is NOT marked Do Not Contact (isDoNotContact) — stops
//       mid-sequence sends for a now-DNC contact; enrollment stays active so
//       clearing DNC resumes from currentStepIndex
//   8b. contact's email is NOT on the marketing suppression list
//   9. there is at least one active marketing inbox to send through
//  10. the picked inbox is past its per-inbox send-interval cooldown
//      (marketingSettings.sendIntervalMinutes, default 5)
//  11. the picked inbox is under its per-inbox daily send cap
//      (inbox.dailySendLimit, default 10)
export function getDueSends(state, now = new Date()) {
  const sequences = state.marketingSequences || [];
  const enrollments = state.marketingEnrollments || [];
  const sends = state.marketingSends || [];
  const contacts = state.contacts || [];
  const users = state.users || [];
  const suppressedEmails = buildSuppressedEmailSet(state);
  const activeInboxes = activeMarketingInboxes(state);

  if (activeInboxes.length === 0) return [];

  const due = [];
  const nowMs = now.getTime();
  // Hour is evaluated in the configured sending timezone (null = device tz).
  const hour = hourInZone(now, sendZone(state));

  // Per-inbox send throttle. Each rotation inbox must wait at least
  // sendIntervalMinutes (default 5) between sends. lastInboxSendMs holds the
  // most recent send time per inbox — seeded from the persistent sends log so
  // the cooldown survives reloads, then advanced as this walk assigns sends so
  // two enrollments in one pass can't both pick a just-used inbox.
  const intervalMs = Math.max(0, Number(state.marketingSettings?.sendIntervalMinutes ?? 5)) * 60 * 1000;
  const lastInboxSendMs = {};

  // Per-inbox daily send cap (dailySendLimit, default 10) is seeded below; failed
  // sends are excused (they never left the mailbox). Holiday/blackout gate first —
  // on an excluded day nothing sends, so skip the whole sends pass.
  const sendTz = sendZone(state);
  const todayKey = dayKeyInZone(now, sendTz);
  const excludedDates = state.marketingSettings?.excludedDates;
  if (Array.isArray(excludedDates) && excludedDates.includes(todayKey)) return [];
  const sentTodayByInbox = {};

  // SCALE-C20: ONE pass over the never-pruned sends log builds every per-send lookup
  // at once — the throttle seed (lastInboxSendMs), the daily-cap seed
  // (sentTodayByInbox), AND sendsByEnrStep. Previously the retry-dedup below
  // (`sends.filter`) re-scanned the WHOLE sends array once PER active enrollment →
  // O(enrollments × all-sends-ever) every 60s tick. sendsByEnrStep includes FAILED
  // rows (AUTO-02 retry counting needs them); the daily-cap tally keeps its
  // failed-skip + today filter; the throttle keeps attemptedAt||sentAt (a failed
  // send still occupied the inbox). Semantics of all three are unchanged.
  const sendsByEnrStep = new Map();
  for (const sd of sends) {
    const k = `${sd.enrollmentId}::${sd.stepId}`;
    const g = sendsByEnrStep.get(k);
    if (g) g.push(sd); else sendsByEnrStep.set(k, [sd]);
    const t = new Date(sd.attemptedAt || sd.sentAt || 0).getTime();
    if (Number.isFinite(t) && t > (lastInboxSendMs[sd.inboxId] || 0)) lastInboxSendMs[sd.inboxId] = t;
    if (sd.status !== 'failed') {
      const ts = sd.sentAt || sd.attemptedAt;
      if (ts && dayKeyInZone(new Date(ts), sendTz) === todayKey) {
        sentTodayByInbox[sd.inboxId] = (sentTodayByInbox[sd.inboxId] || 0) + 1;
      }
    }
  }

  // SCALE-C20: index enrollments by sequence (active only, ORIGINAL order preserved so
  // round-robin/inbox-pick ordering is byte-identical) and contacts by id (first-wins,
  // matching the old `.find`) — replacing the per-iteration `enrollments.filter` (~L344)
  // and `contacts.find` (~L378) that ran once per sequence / per enrollment.
  const enrBySeq = new Map();
  for (const e of enrollments) {
    if (e.status !== 'active') continue;
    const g = enrBySeq.get(e.sequenceId);
    if (g) g.push(e); else enrBySeq.set(e.sequenceId, [e]);
  }
  const contactsById = new Map();
  for (const c of contacts) if (!contactsById.has(c.id)) contactsById.set(c.id, c);

  for (const seq of sequences) {
    if (seq.status !== 'active') continue;
    const steps = Array.isArray(seq.steps) ? [...seq.steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
    if (steps.length === 0) continue;
    const seqEnrollments = enrBySeq.get(seq.id) || []; // SCALE-C20 (was enrollments.filter)

    for (const enr of seqEnrollments) {
      if (enr.repliedAt) continue;
      const idx = enr.currentStepIndex || 0;
      if (idx >= steps.length) continue;

      const step = steps[idx];
      // Retry-aware dedup (AUTO-02): skip a delivered step; retry a failed-only
      // step up to MAX_SEND_ATTEMPTS with a backoff between tries, then give up.
      const priorSends = sendsByEnrStep.get(`${enr.id}::${step.id}`) || []; // SCALE-C20 (was sends.filter — the hotspot)
      if (priorSends.some((sd) => sd.status !== 'failed')) continue; // sent/pending → done
      if (priorSends.length > 0) {
        if (priorSends.length >= MAX_SEND_ATTEMPTS) continue; // retries exhausted
        const lastAttempt = Math.max(...priorSends.map((sd) => new Date(sd.attemptedAt || sd.sentAt || 0).getTime()));
        if (Number.isFinite(lastAttempt) && nowMs - lastAttempt < SEND_RETRY_BACKOFF_MS) continue; // backoff
      }

      // Delay gate — the step's configured wait (delayMinutes, default-derived
      // from the legacy daysAfterPrevious) must have elapsed since the previous
      // send. Step 0 has no previous step, so it fires immediately on enrollment.
      if (idx > 0) {
        if (!enr.lastSentAt) continue; // defensive
        const earliest = new Date(enr.lastSentAt).getTime() + stepDelayMinutes(step) * 60 * 1000;
        if (nowMs < earliest) continue;
      }

      // Time-window gate. start/end are integers 0–23. end is exclusive.
      const startH = typeof step.sendHourStart === 'number' ? step.sendHourStart : 9;
      const endH = typeof step.sendHourEnd === 'number' ? step.sendHourEnd : 17;
      if (hour < startH || hour >= endH) continue;

      const contact = contactsById.get(enr.contactId); // SCALE-C20 (was contacts.find)
      if (!contact?.email) continue;
      // DNC gate — stop mid-sequence sends for an already-enrolled contact who
      // was later marked Do Not Contact. The enrollment stays 'active', so
      // clearing DNC resumes from its currentStepIndex.
      if (isDoNotContact(contact)) continue;
      // Suppression gate — never send to a globally opted-out email.
      if (suppressedEmails.has(contact.email.toLowerCase())) continue;

      // Round-robin inbox pick.
      const inboxes = activeInboxes;
      const pickIndex = ((seq.nextInboxIndex || 0) % inboxes.length + inboxes.length) % inboxes.length;
      const inbox = inboxes[pickIndex];

      // Per-inbox throttle — skip if this inbox sent within the interval. The
      // enrollment stays put; a later tick retries once the inbox cools down.
      if (intervalMs > 0 && nowMs - (lastInboxSendMs[inbox.id] || 0) < intervalMs) {
        continue;
      }

      // Per-inbox daily cap — skip if this inbox already hit its dailySendLimit
      // today. The enrollment stays put; it resumes when the day rolls over.
      const dailyLimit = Number.isFinite(Number(inbox.dailySendLimit))
        ? Number(inbox.dailySendLimit)
        : 10;
      if ((sentTodayByInbox[inbox.id] || 0) >= dailyLimit) {
        continue;
      }

      // Variable substitution. Sender = the user who owns the rotation inbox;
      // falls back to the inbox's own displayName / email for {senderName}.
      const sender = users.find((u) => u.id === inbox.connectedByUserId) || {
        name: inbox.displayName || inbox.email || '',
      };
      const variables = buildMarketingVariables({ contact, sequence: seq, sender, inbox, state });
      const subject = interpolate(step.subject || '', variables);
      let body = interpolate(step.body || '', variables);
      if (seq.plainText) body = stripHtml(body);

      // Pre-allocate the send id so the dispatcher can stamp it into the
      // outbound headers — backend echoes the headers on inbound, and the
      // reply listener uses the X-CleanSpace-Marketing-Send-Id chain to map
      // a reply straight back to this row.
      const sendId = newId('msnd');

      // Reserve this inbox for the interval so the next enrollment in this
      // same walk rotates to a different one instead of doubling up. The
      // daily-cap tally advances in lockstep so one walk can't overshoot.
      lastInboxSendMs[inbox.id] = nowMs;
      sentTodayByInbox[inbox.id] = (sentTodayByInbox[inbox.id] || 0) + 1;

      due.push({
        enrollment: enr,
        step,
        sequence: seq,
        contact,
        inboxId: inbox.id,
        toEmail: contact.email,
        fromName: inbox.senderName || '',
        subject,
        body,
        attachments: step.attachments || [],
        sendId,
        headers: {
          'X-CleanSpace-Marketing-Enrollment-Id': enr.id,
          'X-CleanSpace-Marketing-Step-Id': step.id,
          'X-CleanSpace-Marketing-Send-Id': sendId,
          'X-CleanSpace-Marketing-Sequence-Id': seq.id,
        },
        tags: ['marketing', `seq:${seq.id}`],
      });
    }
  }
  return due;
}

// The contacts a stage-driven sequence targets: the primary contact of every OPEN
// opportunity sitting at one of the given (pipelineId, stageKey) matchers. A person
// is never on a pipeline; a deal is a company Opportunity, and the person we email is
// that deal's primary contact (falling back to the company's primary contact).
export function contactIdsAtSourceStages(state, matchers) {
  const ids = new Set();
  if (!matchers || matchers.length === 0) return ids;
  const clients = state.clients || [];
  for (const o of state.opportunities || []) {
    if (o.status !== 'open') continue;
    if (!matchers.some((m) => o.pipelineId === m.pipelineId && o.stage === m.stageKey)) continue;
    const cid = o.primaryContactId
      || (clients.find((cl) => cl.id === o.clientId)?.primaryContactId)
      || null;
    if (cid) ids.add(cid);
  }
  return ids;
}

// For sequences with audienceMode==='auto', return the contacts that should
// be enrolled but aren't yet. The dispatcher calls this every tick + on state
// change and fires one ENROLL_CONTACTS per (sequenceId, contactIds[]) bucket.
//
// Runs for DRAFT sequences too — enrollments accumulate in the queue so the
// operator can see exactly who's lined up before clicking Start. Sends remain
// gated on status==='active' in getDueSends, so a draft sequence still never
// actually fires email; it just holds the queue.
//
// Dedup is STRICTER than the reducer's ENROLL_CONTACTS dedup: 'unenrolled'
// is also blocked here, so the scheduler never silently re-pulls a contact
// the operator manually removed (even if they're still at the source stage).
// Manual re-enroll via the modal IS allowed because the reducer's dedup
// excludes 'unenrolled' — operator-initiated, intentional.
export function getDueEnrollments(state) {
  const sequences = state.marketingSequences || [];
  const enrollments = state.marketingEnrollments || [];
  const contacts = state.contacts || [];
  const buckets = [];
  const suppressedEmails = buildSuppressedEmailSet(state);
  const blockedStatuses = new Set(['active', 'replied', 'completed', 'unenrolled']);

  for (const seq of sequences) {
    if (seq.audienceMode !== 'auto') continue;
    const sources = Array.isArray(seq.enrollmentSources) ? seq.enrollmentSources : [];
    if (sources.length === 0) continue;

    // The target set: primary contacts of open deals at any configured source stage.
    const matchers = sources.filter((src) => src && src.kind === 'pipelineStage' && src.pipelineId && src.stageKey);
    if (matchers.length === 0) continue;
    const targetIds = contactIdsAtSourceStages(state, matchers);
    if (targetIds.size === 0) continue;

    // Existing enrollments — skip them. Includes 'unenrolled' so the
    // scheduler respects manual removals (see header comment above).
    const alreadyEnrolled = new Set(
      enrollments
        .filter((e) => e.sequenceId === seq.id && blockedStatuses.has(e.status))
        .map((e) => e.contactId)
    );

    const fresh = [];
    for (const c of contacts) {
      if (!c.email) continue;                                 // no email = can't send
      if (isDoNotContact(c)) continue;                        // per-contact Do Not Contact
      if (suppressedEmails.has(c.email.toLowerCase())) continue; // globally opted out
      if (alreadyEnrolled.has(c.id)) continue;
      if (!targetIds.has(c.id)) continue;                     // not the primary of an open deal at a source stage
      fresh.push(c.id);
    }
    if (fresh.length > 0) buckets.push({ sequenceId: seq.id, contactIds: fresh });
  }
  return buckets;
}

// For sequences with onStageExit==='unenroll', return active enrollments
// whose contact is no longer at any of the configured source stages. The
// dispatcher fires one UNENROLL_CONTACT per result.
//
// Runs for DRAFT sequences too so the pre-launch preview queue stays
// accurate as contacts move around the pipeline. Only inspects sequences
// that ALSO have audienceMode==='auto' — manual enrollments aren't tied to
// a stage so this gate doesn't apply.
export function getStaleEnrollments(state) {
  const sequences = state.marketingSequences || [];
  const enrollments = state.marketingEnrollments || [];
  const stale = [];

  for (const seq of sequences) {
    if (seq.audienceMode !== 'auto') continue;
    if (seq.onStageExit !== 'unenroll') continue;
    const sources = Array.isArray(seq.enrollmentSources) ? seq.enrollmentSources : [];
    const matchers = sources.filter((src) => src && src.kind === 'pipelineStage' && src.pipelineId && src.stageKey);
    if (matchers.length === 0) continue;
    const targetIds = contactIdsAtSourceStages(state, matchers);

    const seqEnrollments = enrollments.filter(
      (e) => e.sequenceId === seq.id && e.status === 'active'
    );
    for (const enr of seqEnrollments) {
      // Manually-added enrollments are sticky — the operator picked them
      // deliberately, even if their company has no open deal at the source stage.
      // Only auto-pulled rows are subject to stage-exit unenroll.
      if (enr.source === 'manual') continue;
      if (!targetIds.has(enr.contactId)) stale.push(enr);
    }
  }
  return stale;
}

// Reply correlation. Two strategies tried in order:
//
//   1. Header chain match — walk the inbound's inReplyTo + references chain.
//      Look for a prior outbound message whose emailMessageId matches a send
//      row's providerMessageId; that row's enrollmentId is the answer.
//   2. From-email fallback — match the inbound's fromEmail against contacts.
//      If exactly one contact has an active enrollment, that's the answer.
//      If multiple match, pick the most-recently-touched enrollment.
//
// Returns the enrollment record or null. Pure — no side effects.
export function correlateReplyToEnrollment(state, inboundMsg) {
  if (!inboundMsg) return null;

  // Strategy 1: header chain match.
  const headers = inboundMsg.emailHeaders || {};
  const inReplyTo = headers.inReplyTo || null;
  const refs = headers.references || null;
  if (inReplyTo || refs) {
    const refSet = new Set();
    if (inReplyTo) refSet.add(inReplyTo);
    if (refs) {
      String(refs)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((r) => refSet.add(r));
    }
    if (refSet.size > 0) {
      const priorOut = (state.messages || []).find((m) => {
        if (m.direction !== 'out') return false;
        const mid = m.emailHeaders?.messageId;
        return mid && refSet.has(mid);
      });
      if (priorOut) {
        const matchId = priorOut.emailMessageId || priorOut.emailHeaders?.messageId || null;
        const sendRow = matchId
          ? (state.marketingSends || []).find((sd) => sd.providerMessageId === matchId)
          : null;
        if (sendRow) {
          const enrollment = (state.marketingEnrollments || []).find((e) => e.id === sendRow.enrollmentId);
          if (enrollment) return enrollment;
        }
      }
    }
  }

  // Strategy 2: from-email fallback.
  const from = (inboundMsg.fromEmail || '').toLowerCase();
  if (!from) return null;
  const contact = (state.contacts || []).find(
    (c) => (c.email || '').toLowerCase() === from
  );
  if (!contact) return null;
  // A reply can land while the sequence is still running (status 'active') OR
  // after it finished all its steps (status 'completed'). Both should route.
  // Already-replied / unenrolled enrollments are skipped — replied is handled
  // idempotently downstream, unenrolled means the contact opted out of routing.
  const candidates = (state.marketingEnrollments || []).filter(
    (e) => e.contactId === contact.id
      && (e.status === 'active' || e.status === 'completed')
      && !e.repliedAt
  );
  if (candidates.length === 0) return null;
  // Most-recently-touched wins on ambiguity.
  return [...candidates].sort((a, b) => {
    const aT = a.lastSentAt || a.enrolledAt || '';
    const bT = b.lastSentAt || b.enrolledAt || '';
    return aT < bT ? 1 : aT > bT ? -1 : 0;
  })[0];
}
