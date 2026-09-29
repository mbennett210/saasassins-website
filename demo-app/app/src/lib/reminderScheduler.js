// ─────────────────────────────────────────────────────────────────────────────
// Reminder scheduler — pure functions over state. The React component in
// components/ReminderScheduler.jsx wires this to dispatch + setInterval and
// the delivery adapters (twilio.js, email.js).
//
// Fire windows (one-time per job per template, deduped by hasFired):
//   booking_confirmation : on job creation, immediately (status=upcoming)
//   reminder_24h         : when startAt is 12–30h away (status=upcoming)
//   day_of_eta           : when startAt is 0–12h away (status=upcoming)
//   post_service         : when status flips to 'completed'
//
// Token interpolation: {client_contact} {company} {service} {site_name}
//                      {date} {time}
// ─────────────────────────────────────────────────────────────────────────────

import {
  isDoNotContact,
  isReminderOptOut,
  buildSuppressedEmailSet,
  NON_TRANSACTIONAL_REMINDER_KEYS,
} from './contactConsent.js';
import { fmtDate, fmtTime, hourInZone } from './dates.js';

const HOUR = 60 * 60 * 1000;

// ── post_service guards ──────────────────────────────────────────────────────
//
// post_service is the ONLY template that fires on a state the job ALREADY HOLDS
// ('completed') rather than on a moment approaching. Every other key is bounded by a
// window around startAt, so it can only ever match jobs near now. post_service had no
// time bound at all, and the cron feeds it `getJobsInWindow({ backDays: 7 })` — so
// the moment the template is enabled, EVERY job completed in the last 7 days becomes
// due on the same tick and the customers get a week of "how did we do?" emails at
// once. All 5 templates are currently disabled in the live blob, which is the only
// reason this has never fired; enabling it was a live back-blast waiting to happen.
//
// hasFired() does NOT prevent this: it dedupes a job that has already sent, and none
// of these ever have.
export const POST_SERVICE_MAX_AGE_MS = 48 * HOUR;

// And an hour window, in the ORG's zone — post_service alone. The cron runs every 5
// minutes under TZ=UTC, so without this a job completing at 23:30 UTC mails the
// customer at 4:30pm... or 3:30am, depending on their zone. The other three keys are
// already implicitly bounded to civil hours by their relationship to startAt (nobody
// schedules a 3am clean), and booking_confirmation is transactional — a receipt is
// expected immediately, so delaying it would be wrong.
export const POST_SERVICE_SEND_HOURS = { from: 9, until: 19 };

// A reminder retries after a failure (a transient send error, or SMS that
// couldn't go out until Twilio was provisioned) but is bounded so a permanently
// undeliverable one (bad address / no phone) doesn't retry forever. Once the
// budget is spent the event stays 'failed' and the office is alerted (reducer).
export const MAX_REMINDER_ATTEMPTS = 5;

// Deterministic per-(job, template) event id so the scheduler — and any second
// open tab — converge on ONE event instead of racing to create duplicates.
export function reminderEventId(templateKey, jobId) {
  return `re_${jobId}_${templateKey}`;
}

// The single event for a (template, job), if one exists yet.
export function findReminderEvent(events, templateKey, jobId) {
  return (events || []).find((e) => e.templateKey === templateKey && e.jobId === jobId) || null;
}

// "Settled" — whether an existing event blocks a (re)fire. It blocks UNLESS it
// failed with retry budget remaining (then it's eligible to retry in place).
// Previously ANY event blocked, so a failed reminder never retried even after
// its cause cleared — a job already in-window at Twilio cutover stayed unsent.
export function hasFired(events, templateKey, jobId) {
  if (!jobId) return false;
  const e = findReminderEvent(events, templateKey, jobId);
  if (!e) return false;
  if (e.status === 'failed' && (e.attempts || 1) < MAX_REMINDER_ATTEMPTS) return false;
  return true;
}

export function shouldFire(template, job, events, now = new Date(), opts = {}) {
  if (!template?.enabled) return false;
  if (hasFired(events, template.key, job.id)) return false;

  const startAt = new Date(job.startAt).getTime();
  const nowMs = now.getTime();
  const diffMs = startAt - nowMs;

  switch (template.key) {
    case 'booking_confirmation':
      // Fire on creation for any job that hasn't yet started.
      return job.status === 'upcoming';
    case 'reminder_24h':
      if (job.status !== 'upcoming') return false;
      return diffMs > 12 * HOUR && diffMs <= 30 * HOUR;
    case 'day_of_eta':
      if (job.status !== 'upcoming') return false;
      return diffMs > 0 && diffMs <= 12 * HOUR;
    case 'post_service': {
      if (job.status !== 'completed') return false;
      // FRESHNESS. There is no completedAt on a job, so endAt is the honest proxy
      // for "when the service actually finished" (startAt only if endAt is absent).
      // A job whose end is in the FUTURE is not a completed service to follow up on,
      // whatever its status says — that is a mis-set status, not a due reminder.
      const endMs = new Date(job.endAt || job.startAt).getTime();
      if (!Number.isFinite(endMs)) return false;
      const age = nowMs - endMs;
      if (age < 0 || age > POST_SERVICE_MAX_AGE_MS) return false;
      // CIVIL HOURS in the org's zone. opts.timezone is the blob's company.timezone,
      // which may be null/'' — hourInZone resolves falsy to the org default rather
      // than the process zone (UTC here). See dates.js zoneOr.
      const hour = hourInZone(now, opts.timezone);
      if (hour < POST_SERVICE_SEND_HOURS.from || hour >= POST_SERVICE_SEND_HOURS.until) return false;
      return true;
    }
    default:
      return false;
  }
}

export function buildTokens({ client, company, service, site, job, contact }) {
  const contactName = contact
    ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
    : (client?.primaryContact || 'there');
  // The {date}/{time} tokens go into the SMS/email the CUSTOMER reads, so they must
  // render in the org's zone — the cron fires under UTC on Vercel, which otherwise
  // announced a 9 AM PT clean as "4:00 PM". Pass company.timezone explicitly since
  // the server never sets the ambient org zone; it falls back to the LA default when
  // the blob predates the field.
  const tz = company?.timezone;
  return {
    client_contact: contactName || (client?.primaryContact || 'there'),
    company: company?.name || '',
    service: service?.name || '',
    site_name: site?.name || (client?.name || ''),
    date: fmtDate(job?.startAt, undefined, tz),
    time: fmtTime(job?.startAt, tz),
  };
}

export function interpolate(template, tokens) {
  if (!template) return '';
  return Object.entries(tokens || {}).reduce(
    (out, [k, v]) => out.replaceAll(`{${k}}`, v ?? ''),
    template
  );
}

/**
 * Given the full app state and a moment in time, return the list of reminders
 * that should fire RIGHT NOW. Does not mutate state. Caller is expected to
 * dispatch ADD_REMINDER_EVENT for each + call the matching delivery adapter.
 *
 * Consent gating (shared with the server cron via getDueEmailReminders):
 *   • A resolved contact marked Do Not Contact OR reminder-opted-out gets NO
 *     reminders at all (booking_confirmation included).
 *   • Non-transactional email templates (NON_TRANSACTIONAL_REMINDER_KEYS —
 *     post_service, welcome_email) additionally honor the email-keyed marketing
 *     suppression list, matched against the RESOLVED recipient (client.email
 *     fallback included). booking_confirmation is transactional and exempt from
 *     that list. Enforcement lives here in the pure walker so the client tick
 *     and the tab-less cron can never diverge.
 *
 * Each entry: {
 *   template, job, client, contact?, site?, service?,
 *   channel, recipient, fromAddress?, fromPhone?,
 *   subject, body, tokens
 * }
 */
export function getDueReminders(state, now = new Date()) {
  const templates = state.reminderTemplates || [];
  const jobs = state.jobs || [];
  const events = state.reminderEvents || [];
  const company = state.company || {};
  // Email-keyed marketing suppression list — honored ONLY by non-transactional
  // (marketing-like) reminder templates (NON_TRANSACTIONAL_REMINDER_KEYS).
  // booking_confirmation is transactional and exempt from this list (but still
  // honors the per-contact DNC / reminderOptOut flags below).
  const suppressedEmails = buildSuppressedEmailSet(state);

  const due = [];
  for (const job of jobs) {
    const client = (state.clients || []).find((c) => c.id === job.clientId);
    if (!client) continue;
    const site = (state.sites || []).find((s) => s.id === job.siteId);
    const service = (state.services || []).find((s) => s.id === (job.serviceId || client.serviceId));
    const contact = job.siteContactId
      ? (state.contacts || []).find((c) => c.id === job.siteContactId)
      : (client.primaryContactId
          ? (state.contacts || []).find((c) => c.id === client.primaryContactId)
          : null);

    // Per-contact consent gate — a resolved contact marked Do Not Contact OR
    // reminder-opted-out receives NO reminders of any kind (booking_confirmation
    // included). When there is NO linked contact (recipient falls back to
    // client.email), there are no per-contact flags to honor, so the job passes
    // through unchanged — the marketing-suppression gate below still applies to
    // the resolved recipient email.
    if (contact && (isDoNotContact(contact) || isReminderOptOut(contact))) continue;

    for (const template of templates) {
      // company.timezone reaches shouldFire so post_service can ask what hour it is
      // for the CUSTOMER. The cron has no ambient org zone (TZ=UTC), so passing it
      // explicitly is the only way the window means anything server-side.
      if (!shouldFire(template, job, events, now, { timezone: company.timezone })) continue;

      const tokens = buildTokens({ client, company, service, site, job, contact });
      const subject = interpolate(template.subject || '', tokens);
      const body = interpolate(template.body || '', tokens);

      // Resolve recipient by channel. SMS uses phone, email uses email.
      // Prefer the linked contact's contact info, fall back to client-level.
      const recipient = template.channel === 'sms'
        ? (contact?.phone || client.phone || null)
        : (contact?.email || client.email || null);

      // Marketing-suppression gate — a non-transactional (marketing-like) email
      // template must not send to a globally opted-out address. Matches the
      // RESOLVED recipient (which may be the client.email fallback when there's
      // no linked contact). Transactional booking_confirmation is exempt.
      if (
        template.channel === 'email'
        && NON_TRANSACTIONAL_REMINDER_KEYS.has(template.key)
        && recipient
        && suppressedEmails.has(String(recipient).toLowerCase())
      ) continue;

      // Deterministic id + attempt count so the fire path is an idempotent
      // upsert: a retry re-uses the same event (bumping attempts) rather than
      // stacking duplicates, and a second tab computing the same id can't
      // double-record. `prior` is the existing failed event being retried, if any.
      const prior = findReminderEvent(events, template.key, job.id);

      due.push({
        template,
        job,
        client,
        contact,
        site,
        service,
        channel: template.channel,
        recipient,
        fromPhone: company.integrations?.twilio?.phoneNumber || null,
        fromEmail: company.email || null,
        subject,
        body,
        tokens,
        eventId: reminderEventId(template.key, job.id),
        attempt: (prior?.attempts || 0) + 1,
      });
    }
  }
  return due;
}

// ─── Server cron gating (email-only v1) ──────────────────────────────────────
//
// The reminder cron (/api/reminders/run) is EMAIL-ONLY: there is no server-side
// Twilio path, so SMS templates (reminder_24h, day_of_eta) can't be sent from a
// tab-less cron and are excluded here. This wrapper narrows getDueReminders to
// the reminders a server run may actually deliver:
//   1. channel === 'email'      — SMS can't send server-side (no Twilio backend)
//   2. a real recipient email    — the 2026-07-02 flood came from no-email
//      accounts; we never even record an attempt for a contact with no address
//   3. booking_confirmation freshness — because that template fires for ANY
//      upcoming job, enabling it must NOT back-blast the entire existing
//      schedule. Only jobs created within `bookingMaxAgeHours` (default 48h) get
//      a confirmation from the cron; older upcoming jobs are skipped. A missing
//      job.createdAt is treated as stale (skip) to stay conservative.
export const BOOKING_CONFIRMATION_MAX_AGE_HOURS = 48;

export function getDueEmailReminders(state, now = new Date(), opts = {}) {
  const bookingMaxAgeHours = opts.bookingMaxAgeHours ?? BOOKING_CONFIRMATION_MAX_AGE_HOURS;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  return getDueReminders(state, now).filter((d) => {
    if (d.channel !== 'email') return false;               // (1) email-only
    if (!d.recipient) return false;                        // (2) must have an email
    if (d.template.key === 'booking_confirmation') {       // (3) freshness guard
      const createdMs = d.job?.createdAt ? new Date(d.job.createdAt).getTime() : NaN;
      if (!Number.isFinite(createdMs)) return false;
      if (nowMs - createdMs > bookingMaxAgeHours * HOUR) return false;
    }
    return true;
  });
}
