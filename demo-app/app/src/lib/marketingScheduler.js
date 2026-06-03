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
//     — for sequences with audienceMode==='auto', returns contactIds at any
//       configured (pipelineId, stageKey) that aren't already enrolled.
//   getStaleEnrollments(state)
//     — for sequences with onStageExit==='unenroll', returns enrollments
//       whose contact has left the source stage(s).
//   correlateReplyToEnrollment(state, inboundMsg)
//     — header chain match first, from-email fallback second.
//   hasSent, buildMarketingVariables, interpolate, stripHtml
//     — helpers exported for testability + reuse.
// ─────────────────────────────────────────────────────────────────────────────

import { newId } from './ids';

// Dedup: never re-fire the same (enrollmentId, stepId) pair. Reads from the
// persistent sends log so dedup survives reloads.
export function hasSent(sends, enrollmentId, stepId) {
  return (sends || []).some(
    (sd) => sd.enrollmentId === enrollmentId && sd.stepId === stepId
  );
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
  { key: 'stage',         label: 'Pipeline stage', group: 'contact',  from: "The contact's current pipeline stage" },
  { key: 'lifecycle',     label: 'Lifecycle',      group: 'contact',  from: "The contact's lifecycle — lead, prospect, client" },
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
  // {stage} resolves to the human stage label, not the internal stage key.
  const pipeline = c.pipelineId ? (s.pipelines || []).find((p) => p.id === c.pipelineId) : null;
  const stageObj = pipeline && c.stage
    ? (pipeline.stages || []).find((st) => st.key === c.stage)
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
// Gates (all must pass):
//   1. sequence.status === 'active'
//   2. sequence has at least one step
//   3. enrollment.status === 'active' AND repliedAt is falsy
//   4. enrollment.currentStepIndex < sequence.steps.length
//   5. hasSent(sends, enrollment.id, step.id) === false
//   6. step.daysAfterPrevious has elapsed since enrollment.lastSentAt (step 0 fires immediately)
//   7. current hour (in marketingSettings.sendTimezone) ∈ [sendHourStart, sendHourEnd)
//   8. contact has an email address
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
  const activeInboxes = activeMarketingInboxes(state);

  if (activeInboxes.length === 0) return [];

  const due = [];
  const nowMs = now.getTime();
  // Hour is evaluated in the configured sending timezone (null = device tz).
  const hour = hourInZone(now, state.marketingSettings?.sendTimezone || null);

  // Per-inbox send throttle. Each rotation inbox must wait at least
  // sendIntervalMinutes (default 5) between sends. lastInboxSendMs holds the
  // most recent send time per inbox — seeded from the persistent sends log so
  // the cooldown survives reloads, then advanced as this walk assigns sends so
  // two enrollments in one pass can't both pick a just-used inbox.
  const intervalMs = Math.max(0, Number(state.marketingSettings?.sendIntervalMinutes ?? 5)) * 60 * 1000;
  const lastInboxSendMs = {};
  for (const sd of sends) {
    const t = new Date(sd.attemptedAt || sd.sentAt || 0).getTime();
    if (Number.isFinite(t) && t > (lastInboxSendMs[sd.inboxId] || 0)) {
      lastInboxSendMs[sd.inboxId] = t;
    }
  }

  // Per-inbox daily send cap. Each inbox sends at most dailySendLimit emails
  // per calendar day (in the sending timezone), default 10 — a deliverability
  // guardrail. sentTodayByInbox is seeded from the persistent sends log so the
  // cap survives reloads, then advanced as this walk assigns sends. Failed
  // sends are excused — they never left the mailbox.
  const sendTz = state.marketingSettings?.sendTimezone || null;
  const todayKey = dayKeyInZone(now, sendTz);
  const sentTodayByInbox = {};
  for (const sd of sends) {
    if (sd.status === 'failed') continue;
    const t = sd.sentAt || sd.attemptedAt;
    if (t && dayKeyInZone(new Date(t), sendTz) === todayKey) {
      sentTodayByInbox[sd.inboxId] = (sentTodayByInbox[sd.inboxId] || 0) + 1;
    }
  }

  for (const seq of sequences) {
    if (seq.status !== 'active') continue;
    const steps = Array.isArray(seq.steps) ? [...seq.steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
    if (steps.length === 0) continue;

    const seqEnrollments = enrollments.filter(
      (e) => e.sequenceId === seq.id && e.status === 'active'
    );

    for (const enr of seqEnrollments) {
      if (enr.repliedAt) continue;
      const idx = enr.currentStepIndex || 0;
      if (idx >= steps.length) continue;

      const step = steps[idx];
      if (hasSent(sends, enr.id, step.id)) continue;

      // Days-between gate — step 0 fires immediately on enrollment.
      if (idx > 0) {
        if (!enr.lastSentAt) continue; // defensive
        const earliest = new Date(enr.lastSentAt).getTime()
          + (Number(step.daysAfterPrevious) || 0) * 24 * 60 * 60 * 1000;
        if (nowMs < earliest) continue;
      }

      // Time-window gate. start/end are integers 0–23. end is exclusive.
      const startH = typeof step.sendHourStart === 'number' ? step.sendHourStart : 9;
      const endH = typeof step.sendHourEnd === 'number' ? step.sendHourEnd : 17;
      if (hour < startH || hour >= endH) continue;

      const contact = contacts.find((c) => c.id === enr.contactId);
      if (!contact?.email) continue;

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
      // reply listener uses the X-PP-Marketing-Send-Id chain to map
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
          'X-PP-Marketing-Enrollment-Id': enr.id,
          'X-PP-Marketing-Step-Id': step.id,
          'X-PP-Marketing-Send-Id': sendId,
          'X-PP-Marketing-Sequence-Id': seq.id,
        },
        tags: ['marketing', `seq:${seq.id}`],
      });
    }
  }
  return due;
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
  const blockedStatuses = new Set(['active', 'replied', 'completed', 'unenrolled']);

  for (const seq of sequences) {
    if (seq.audienceMode !== 'auto') continue;
    const sources = Array.isArray(seq.enrollmentSources) ? seq.enrollmentSources : [];
    if (sources.length === 0) continue;

    // Build the set of (pipelineId, stageKey) matchers.
    const matchers = sources.filter((src) => src && src.kind === 'pipelineStage' && src.pipelineId && src.stageKey);
    if (matchers.length === 0) continue;

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
      if (alreadyEnrolled.has(c.id)) continue;
      const matches = matchers.some((m) => c.pipelineId === m.pipelineId && c.stage === m.stageKey);
      if (!matches) continue;
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
  const contacts = state.contacts || [];
  const stale = [];

  for (const seq of sequences) {
    if (seq.audienceMode !== 'auto') continue;
    if (seq.onStageExit !== 'unenroll') continue;
    const sources = Array.isArray(seq.enrollmentSources) ? seq.enrollmentSources : [];
    const matchers = sources.filter((src) => src && src.kind === 'pipelineStage' && src.pipelineId && src.stageKey);
    if (matchers.length === 0) continue;

    const seqEnrollments = enrollments.filter(
      (e) => e.sequenceId === seq.id && e.status === 'active'
    );
    for (const enr of seqEnrollments) {
      // Manually-added enrollments are sticky — the operator picked them
      // deliberately, even if they're not currently at the source stage.
      // Only auto-pulled rows are subject to stage-exit unenroll.
      if (enr.source === 'manual') continue;
      const c = contacts.find((x) => x.id === enr.contactId);
      if (!c) continue;
      const stillAtSource = matchers.some(
        (m) => c.pipelineId === m.pipelineId && c.stage === m.stageKey
      );
      if (!stillAtSource) stale.push(enr);
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
