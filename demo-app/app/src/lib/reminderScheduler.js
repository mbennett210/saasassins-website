// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER-MESSAGE WALKERS — pure functions over the data the reminders cron reads. They decide
// WHICH message is due RIGHT NOW, for whom, with which words; they send nothing and write nothing.
// The cron (api/reminders/run.js) gathers the inputs, asks `getDueMessages`, then confirms each
// item's history `check`, claims it in the sent log (customer_messages, "sent once") and hands it
// to THE send step (api/_lib/customerMessages/send.js, which refuses any sample record).
// The words and the timings are lib/customerMessages.js's; change a rule HERE, never in the cron.
//
// THE THREE RULES EVERY WALKER KEEPS
//   1. NO BACK-BLAST. Each message is bounded in time by the event it is about: a clean finished
//      within EVENT_MAX_AGE_HOURS, a change stamped within it, a date today or within
//      DAY_GRACE_DAYS after it. Switching a template ON therefore never sends about the past —
//      the sent log does NOT save you there (it dedupes what was sent, and nothing old ever was).
//   2. THE ORG'S CLOCK. Every day and hour is the ORG's (company.timezone; a falsy zone is the org
//      default, never the server's UTC — lib/dates zoneOr). A message not marked `immediate` goes
//      only within CUSTOMER_SEND_HOURS (09:00–19:00).
//   3. CONSENT. A contact marked Do Not Contact or reminder-opted-out gets nothing; a nudge (a
//      non-transactional message) also honours the marketing suppression list by address
//      (lib/contactConsent). A customer we no longer serve (archived, inactive, a vendor —
//      lib/customerStatus isActiveBuilding) gets nothing but the two messages about leaving.
//   No address on file = no item at all (the 2026-07-02 flood came from no-email accounts).
//
// Each due item: { id (the sent log key, messageKey), templateKey, message, template, channel,
//   recipient, refs { clientId, contactId, jobId, siteId, opportunityId }, subjectId, subject,
//   body, tokens, keepUntil, priority, check?, settles?, payload? }
//   check    a history fact the cron must confirm first ({ kind, … }; see run.js resolveChecks)
//   settles  sibling messages this one stands for (a series of reschedules collapsed into one):
//            recorded 'skipped' once it is sent, so none of them goes later
// ─────────────────────────────────────────────────────────────────────────────

import { isDoNotContact, isReminderOptOut, buildSuppressedEmailSet } from './contactConsent.js';
import { toE164 } from './alertDelivery.js';
import { fmtDate, fmtTime, hourInZone, dayKey, addDaysKey, diffDaysKey } from './dates.js';
import { JOB_STATUS, isCompletedJobStatus } from './jobStatus.js';
import { isActiveBuilding, isArchivedCustomer } from './customerStatus.js';
import { isOpenOpportunity } from './pipelines.js';
import {
  MESSAGE_BY_KEY, MESSAGE_KEY as K, CUSTOMER_SEND_HOURS, EVENT_MAX_AGE_HOURS, DEFAULT_KEEP_DAYS,
  DAY_GRACE_DAYS, UPSELL_AFTER_DAYS, WIN_BACK_AFTER_DAYS,
  RENEWAL_NOTICE_LEAD_DAYS, RENEWAL_OFFER_LEAD_DAYS, PRICE_INCREASE_LEAD_DAYS,
  UPCOMING_DUE_LEAD_DAYS, STATEMENT_DAY_OF_MONTH, SURVEY_EVERY_DAYS, SURVEY_MIN_TENURE_DAYS,
  composeMessage,
} from './customerMessages.js';
import { IDENTITY } from '../brand/identity.generated.js';
import { onTheWayEta } from './crewOnTheWay.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A failed send is retried (a transient error) up to this many attempts in all; then the row
// stays 'failed' and the office is told (api/reminders/run.js alertExhausted).
export const MAX_REMINDER_ATTEMPTS = 5;
// The day-of text may go from this long before the clean, inside the send window.
export const DAY_OF_LEAD_MS = 12 * HOUR;
// The clock-in window stays open this long after a clean's scheduled end (opsSettings
// autoCloseGraceMins, lib/clockInWindow) — only once it has closed is the clean truly missed:
// a cover can still arrive until then (not at the 30-minute missed-shift alert).
export const DEFAULT_CLOCK_IN_GRACE_MINS = 120;

// The sent log's key for one message: `<template>:<what it is about>[:<occurrence>]`.
export function messageKey(templateKey, ...parts) {
  return [templateKey, ...parts.map((p) => String(p ?? ''))].join(':');
}

const at = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : NaN; };
// 0 ≤ now − t ≤ max: the event happened, and recently enough.
const fresh = (iso, nowMs, maxMs) => { const t = at(iso); return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= maxMs; };

/** True when `now` is inside CUSTOMER_SEND_HOURS on the org's clock. */
export function isInSendWindow(now, tz) {
  const h = hourInZone(now, tz);
  return h >= CUSTOMER_SEND_HOURS.from && h < CUSTOMER_SEND_HOURS.until;
}

const firstWord = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const DATE_OPTS = { weekday: 'long', month: 'short', day: 'numeric' };
export const fmtCustomerDate = (iso, tz) => (iso ? fmtDate(iso, DATE_OPTS, tz, 'en-US') : '');
export const fmtCustomerTime = (iso, tz) => (iso ? fmtTime(iso, tz, 'en-US') : '');
export const dollars = (cents) => (cents != null && Number.isFinite(Number(cents))
  ? (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '');

// A recurring schedule in a customer's words: "weekly (Wednesdays)", "every 2 weeks
// (Mondays and Thursdays)", "monthly". The days are the series' own, else the first visit's.
const DAY_WORDS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
export function describeSchedule(recurrence, firstStartAt, tz) {
  if (!recurrence?.frequency) return '';
  const f = recurrence.frequency;
  const word = f === 'biweekly' ? 'every 2 weeks' : f;
  if (f === 'daily' || f === 'monthly') return word;
  let days = Array.isArray(recurrence.daysOfWeek) && recurrence.daysOfWeek.length ? [...recurrence.daysOfWeek] : [];
  if (!days.length && firstStartAt) {
    const [y, m, d] = dayKey(firstStartAt, tz).split('-').map(Number);
    days = [new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }
  const names = [...new Set(days)].sort((a, b) => a - b).map((d) => DAY_WORDS[d]).filter(Boolean);
  return names.length ? `${word} (${listWords(names)})` : word;
}

// The words' values for one message. `extra` adds or overrides (an invoice's number, a link).
export function buildTokens({ client, company, service, site, job, contact, users, extra } = {}) {
  const tz = company?.timezone;
  const fullName = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : '';
  const supervisor = client?.supervisorId ? (users || []).find((u) => u.id === client.supervisorId) : null;
  return {
    client_contact: fullName || client?.primaryContact || 'there',
    first_name: contact?.firstName?.trim() || firstWord(client?.primaryContact) || 'there',
    customer: client?.name || '',
    company: company?.name || IDENTITY.name,
    company_phone: company?.phone || IDENTITY.company.phone,
    service: service?.name || '',
    site_name: site?.name || client?.name || '',
    date: fmtCustomerDate(job?.startAt, tz),
    time: fmtCustomerTime(job?.startAt, tz),
    crew_lead: supervisor?.name || IDENTITY.company.signatory.name,
    ...(extra || {}),
  };
}

// ── the context every walker shares ───────────────────────────────────────────
function contextOf(input, now) {
  const state = input.state || {};
  const company = state.company || {};
  const tz = company.timezone;
  const nowMs = now.getTime();
  const enabled = new Map();
  for (const t of state.reminderTemplates || []) {
    const m = MESSAGE_BY_KEY[t?.key];
    if (t?.enabled === true && m?.built) enabled.set(t.key, t);
  }
  const index = (list) => new Map((list || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  return {
    input, state, company, tz, now, nowMs,
    today: dayKey(now, tz),
    inWindow: isInSendWindow(now, tz),
    enabled,
    clients: index(state.clients),
    contacts: index(state.contacts),
    sites: index(state.sites),
    services: index(state.services),
    users: state.users || [],
    suppressed: buildSuppressedEmailSet(state),
  };
}

// The person a message goes to, by the message's `recipient` rule.
function recipientContact(ctx, rule, { client, job, site, contact }) {
  if (rule === 'prospect') return contact || null;
  const pick = (id) => (id ? ctx.contacts.get(id) || null : null);
  if (rule === 'visit') return pick(job?.siteContactId) || pick(site?.siteContactId) || pick(client?.primaryContactId);
  if (rule === 'billing') return pick(client?.billingContactId) || pick(client?.primaryContactId);
  return pick(client?.primaryContactId);
}

// ONE due item, or null when this message must not go (now, or to this person). Every walker
// builds its items here, so consent, the window, the address and the words are decided once.
function make(ctx, key, {
  client = null, contact: given = null, site = null, job = null, service = null,
  keyParts, subjectId = null, opportunityId = null, extra = null, priority = 50, check = null,
  settles = null, payload = null, allowFormer = false,
}) {
  const template = ctx.enabled.get(key);
  const message = MESSAGE_BY_KEY[key];
  if (!template || !message) return null;
  if (!message.immediate && !ctx.inWindow) return null;
  if (client && !allowFormer && !isActiveBuilding(client)) return null;
  const contact = recipientContact(ctx, message.recipient, { client, job, site, contact: given });
  if (contact && (isDoNotContact(contact) || isReminderOptOut(contact))) return null;
  const prospect = message.recipient === 'prospect';
  // A text's number in E.164 (alertDelivery toE164, the one normalizer), so the sent log names it
  // the way the opt-out list and an incoming reply do (api/sms/inbound finds a reply's building
  // from it). A number that cannot be made into one is kept as typed: the send step refuses it.
  const phone = contact?.phone || (prospect ? null : client?.phone) || null;
  const recipient = message.channel === 'sms'
    ? (phone ? toE164(String(phone)) || phone : null)
    : (contact?.email || (prospect ? null : client?.email) || null);
  if (!recipient) return null;
  if (message.transactional === false && message.channel === 'email' && ctx.suppressed.has(String(recipient).toLowerCase())) return null;
  const tokens = buildTokens({ client, company: ctx.company, service, site, job, contact, users: ctx.users, extra });
  const unsubscribeUrl = typeof ctx.input.unsubscribeUrl === 'function' ? ctx.input.unsubscribeUrl(recipient) : null;
  const { subject, body, missing } = composeMessage(message, template, tokens, { unsubscribeUrl });
  if (missing.length) return null;   // e.g. no pay link: the message cannot say what it is for
  return {
    id: messageKey(key, ...keyParts),
    templateKey: key,
    message,
    template,
    channel: message.channel,
    recipient,
    refs: { clientId: client?.id ?? null, contactId: contact?.id ?? null, jobId: job?.id ?? null, siteId: site?.id ?? job?.siteId ?? null, opportunityId },
    subjectId,
    subject,
    body,
    tokens,
    keepUntil: new Date(ctx.nowMs + (message.keepDays || DEFAULT_KEEP_DAYS) * DAY).toISOString(),
    priority,
    check,
    settles,
    payload,
  };
}

// The pieces of one clean.
function partsOfJob(ctx, job) {
  const client = ctx.clients.get(job.clientId) || null;
  const site = ctx.sites.get(job.siteId) || null;
  const service = ctx.services.get(job.serviceId || client?.serviceId) || null;
  return { client, site, service };
}
const isFuture = (job, nowMs) => at(job?.startAt) > nowMs;

// 🔴 A CLEAN THE OFFICE IS ENTERING (task 477; Daniel's pick 2026-11-03, "Quiet on entry day").
// On 2026-11-03 a weekday schedule was entered at 1:49 PM Eastern with its first visit at 9 AM
// that morning; 108 seconds later the run emailed the customer the missed-visit apology for it
// and texted the 24-hour reminder for the next one, and the office deleted all 65 cleans seven
// minutes after. So:
//   · nothing about a moment that passed before the clean was put there: no apology for a clean
//     entered (or moved) after its start, no summary or first-clean check-in for one entered
//     after it ended, no upsell for a schedule entered on or after its upsell day;
//   · the day a clean is entered (the org's day) is the office's to get it right: no 24-hour or
//     day-of text about it that day, and no reschedule or cancellation notice for a change made
//     that day, unless an entry message (the booking confirmation, the service setup) is on and
//     so may already have told the customer it was booked.
// `createdAt` is stamped by every mint path (store/reducer.js ADD_JOB, ADD_JOB_SERIES, the top-up,
// an added series day). A clean without one predates the stamp and keeps the rules it had.
const enteredDay = (job, tz) => (Number.isFinite(at(job?.createdAt)) ? dayKey(job.createdAt, tz) : null);
// When the clean was put at the time it has now: its entry, or the move that put it there.
const placedAt = (job) => { const t = [at(job?.createdAt), at(job?.rescheduledAt)].filter(Number.isFinite); return t.length ? Math.max(...t) : NaN; };
const placedAfter = (job, ms) => Number.isFinite(placedAt(job)) && placedAt(job) >= ms;
const enteredOnOrAfter = (job, day, tz) => { const d = enteredDay(job, tz); return d != null && d >= day; };
// A change made the day the clean was entered is part of entering it, while no entry message is on.
function changedOnEntryDay(ctx, job, stampIso) {
  if (ctx.enabled.has(K.bookingConfirmation) || ctx.enabled.has(K.serviceSetup)) return false;
  const d = enteredDay(job, ctx.tz);
  return d != null && Number.isFinite(at(stampIso)) && dayKey(stampIso, ctx.tz) <= d;
}

// ── THE VISITS (the jobs window: −7 … +45 days) ──────────────────────────────

// Booking confirmation — once per BOOKING: a one-off clean, or a recurring schedule (its master,
// the row carrying `recurrence`, dated by its first visit). Booked within EVENT_MAX_AGE_HOURS
// (a top-up's freshly minted occurrences are not bookings). A customer's FIRST schedule is
// confirmed by the service-setup email instead when that is on (the cron's `firstSeries` check).
function walkBookings(ctx) {
  const out = [];
  for (const job of ctx.input.jobs || []) {
    if (job.status !== JOB_STATUS.UPCOMING || !isFuture(job, ctx.nowMs)) continue;
    if (!fresh(job.createdAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) continue;
    const isMaster = !!job.recurrence;
    if (job.seriesId && !isMaster) continue;            // a series is booked once, by its master
    const { client, site, service } = partsOfJob(ctx, job);
    if (!client) continue;
    const item = make(ctx, K.bookingConfirmation, {
      client, site, job, service, keyParts: [job.seriesId || job.id], priority: 10,
      check: isMaster && ctx.enabled.has(K.serviceSetup) ? { kind: 'firstSeries', clientId: client.id, seriesId: job.seriesId, when: 'notFirst' } : null,
    });
    if (item) out.push(item);
  }
  return out;
}

// The 24-hour text: the day before the clean (its org day is tomorrow), in the send window.
// The day-of text: the clean's own org day, from DAY_OF_LEAD_MS before it, in the window — a
// clean starting before 09:00 gets only the day-before text. Neither goes on the day the clean
// was entered (task 477): one entered today for tomorrow gets tomorrow's day-of text only.
function walkVisitTexts(ctx) {
  const out = [];
  const tomorrow = addDaysKey(ctx.today, 1);
  for (const job of ctx.input.jobs || []) {
    if (job.status !== JOB_STATUS.UPCOMING || !isFuture(job, ctx.nowMs)) continue;
    if (enteredOnOrAfter(job, ctx.today, ctx.tz)) continue;
    const day = dayKey(job.startAt, ctx.tz);
    if (day !== tomorrow && day !== ctx.today) continue;
    const { client, site, service } = partsOfJob(ctx, job);
    if (!client) continue;
    if (day === tomorrow) {
      const item = make(ctx, K.reminder24h, { client, site, job, service, keyParts: [job.id], priority: 30 });
      if (item) out.push(item);
    } else if (at(job.startAt) - ctx.nowMs <= DAY_OF_LEAD_MS) {
      const item = make(ctx, K.dayOfEta, { client, site, job, service, keyParts: [job.id], priority: 30 });
      if (item) out.push(item);
    }
  }
  return out;
}

// A finished clean (CS-056: JOB_STATUS.DONE, the legacy 'completed' tolerated on read) whose end
// is within EVENT_MAX_AGE_HOURS — there is no completedAt, so endAt is the honest proxy, and a
// "finished" clean ending in the FUTURE is a mis-set status, never a due message.
//   · the first-clean check-in: once per CUSTOMER, only for their first finished clean (the cron's
//     `firstClean` check reads the jobs table's history — the window cannot know it)
//   · the visit summary: one per clean; on the first clean, when the check-in is on, the check-in
//     goes INSTEAD (one email after the first visit, not two)
// A clean entered after it ended is the office writing down the past (task 477): neither goes.
function walkFinished(ctx) {
  const out = [];
  for (const job of ctx.input.jobs || []) {
    if (!isCompletedJobStatus(job.status)) continue;
    const endMs = at(job.endAt ?? job.startAt);
    if (!Number.isFinite(endMs) || endMs > ctx.nowMs || ctx.nowMs - endMs > EVENT_MAX_AGE_HOURS * HOUR) continue;
    if (placedAfter(job, endMs)) continue;
    const { client, site, service } = partsOfJob(ctx, job);
    if (!client) continue;
    const firstClean = { kind: 'firstClean', clientId: client.id, jobId: job.id, startAt: job.startAt };
    const checkIn = make(ctx, K.postService, { client, site, job, service, keyParts: [client.id], priority: 40, check: { ...firstClean, when: 'first' } });
    if (checkIn) out.push(checkIn);
    const summary = make(ctx, K.visitSummary, {
      client, site, job, service, keyParts: [job.id], priority: 20,
      check: checkIn ? { ...firstClean, when: 'notFirst' } : null,
    });
    if (summary) out.push(summary);
  }
  return out;
}

// Missed: the clean's scheduled end AND the clock-in window after it (DEFAULT_CLOCK_IN_GRACE_MINS,
// the office's opsSettings.autoCloseGraceMins) have passed, still not started — upcoming, or set
// missed by the office — and nobody clocked in (the cron's `noPunch` check reads the punches: a
// punch whose status write was lost still counts as someone there). Within EVENT_MAX_AGE_HOURS
// of the window closing; overnight ones go at 09:00. 🔴 Never for a clean entered, or moved,
// after its start (task 477): nobody could have come to a clean that was not on the schedule yet.
function walkMissed(ctx) {
  const out = [];
  const graceMins = Number(ctx.state.opsSettings?.autoCloseGraceMins);
  const graceMs = (Number.isFinite(graceMins) && graceMins >= 0 ? graceMins : DEFAULT_CLOCK_IN_GRACE_MINS) * 60 * 1000;
  for (const job of ctx.input.jobs || []) {
    if (job.status !== JOB_STATUS.UPCOMING && job.status !== JOB_STATUS.MISSED) continue;
    const closed = at(job.endAt ?? job.startAt) + graceMs;
    if (!Number.isFinite(closed) || closed > ctx.nowMs || ctx.nowMs - closed > EVENT_MAX_AGE_HOURS * HOUR) continue;
    if (placedAfter(job, at(job.startAt))) continue;
    const { client, site, service } = partsOfJob(ctx, job);
    if (!client) continue;
    const item = make(ctx, K.missedVisit, { client, site, job, service, keyParts: [job.id], priority: 15, check: { kind: 'noPunch', jobId: job.id } });
    if (item) out.push(item);
  }
  return out;
}

// A change the office made to a FUTURE clean: its date or time moved (`rescheduledAt`, stamped by
// lib/visitChanges at the write — crew swaps and covers are not reschedules), or it was cancelled
// (`cancelledAt`). Stamped within EVENT_MAX_AGE_HOURS, still in the future, and for a reschedule
// still at a time other than the one it moved from (a change the server put back is no change).
// ONE message per customer per run: a series edit that moved twelve visits tells the customer
// about the NEXT one, and the other eleven are settled with it (`settles`), so none goes later.
// A change made the day the clean was entered is part of entering it (task 477), while no entry
// message is on (changedOnEntryDay).
function walkChanges(ctx) {
  const out = [];
  const groups = new Map();
  const add = (key, job, keyParts) => {
    const g = `${key}|${job.clientId}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ key, job, keyParts });
  };
  for (const job of ctx.input.jobs || []) {
    if (!isFuture(job, ctx.nowMs)) continue;
    if (job.status === JOB_STATUS.UPCOMING && fresh(job.rescheduledAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)
      && job.rescheduledFrom && job.rescheduledFrom !== job.startAt && !changedOnEntryDay(ctx, job, job.rescheduledAt)) {
      add(K.reschedule, job, [job.id, at(job.rescheduledAt)]);
    }
    if (job.status === JOB_STATUS.CANCELLED && fresh(job.cancelledAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)
      && !changedOnEntryDay(ctx, job, job.cancelledAt)) {
      add(K.cancellation, job, [job.id]);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => at(a.job.startAt) - at(b.job.startAt) || String(a.job.id).localeCompare(String(b.job.id)));
    const [first, ...rest] = list;
    const { client, site, service } = partsOfJob(ctx, first.job);
    if (!client) continue;
    const settles = rest.map((r) => ({ id: messageKey(r.key, ...r.keyParts), templateKey: r.key, channel: 'email', clientId: client.id, jobId: r.job.id }));
    const item = make(ctx, first.key, { client, site, job: first.job, service, keyParts: first.keyParts, priority: 12, settles });
    if (item) out.push(item);
  }
  return out;
}

// ── THE CUSTOMER'S ACCOUNT ───────────────────────────────────────────────────

// Service setup: a customer's FIRST recurring schedule, created within EVENT_MAX_AGE_HOURS (its
// master, the row carrying `recurrence`). Once per customer; "first" is the cron's `firstSeries`
// check (the jobs table knows every series the customer ever had, the window does not).
function walkServiceSetup(ctx) {
  const out = [];
  for (const job of ctx.input.jobs || []) {
    if (!job.recurrence || !job.seriesId) continue;
    if (job.status === JOB_STATUS.CANCELLED) continue;
    if (!fresh(job.createdAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) continue;
    const { client, site, service } = partsOfJob(ctx, job);
    if (!client) continue;
    const item = make(ctx, K.serviceSetup, {
      client, site, job, service, keyParts: [client.id], priority: 11,
      extra: { schedule: describeSchedule(job.recurrence, job.startAt, ctx.tz), first_visit: fmtCustomerDate(job.startAt, ctx.tz) },
      check: { kind: 'firstSeries', clientId: client.id, seriesId: job.seriesId, when: 'first' },
    });
    if (item) out.push(item);
  }
  return out;
}

// The upsell: once per customer, UPSELL_AFTER_DAYS after their service started — the first visit
// of their first recurring schedule (`input.serviceStarts`: the masters that started that many
// days ago, give or take DAY_GRACE_DAYS; the cron's `firstSeries` check with `before` confirms no
// earlier schedule of theirs). Dated, so it never reaches a customer who started long ago, nor
// (task 477) one whose schedule was entered on or after its upsell day.
function walkUpsell(ctx) {
  const out = [];
  if (!ctx.enabled.has(K.upsell)) return out;
  for (const m of ctx.input.serviceStarts || []) {
    const startDay = dayKey(m.startAt, ctx.tz);
    const late = diffDaysKey(startDay, ctx.today) - UPSELL_AFTER_DAYS;
    if (late < 0 || late > DAY_GRACE_DAYS) continue;
    if (enteredOnOrAfter(m, addDaysKey(startDay, UPSELL_AFTER_DAYS), ctx.tz)) continue;
    const client = ctx.clients.get(m.clientId);
    if (!client) continue;
    const item = make(ctx, K.upsell, {
      client, site: ctx.sites.get(m.siteId) || null, keyParts: [client.id], priority: 60,
      check: { kind: 'firstSeries', clientId: client.id, seriesId: m.seriesId, before: m.startAt, when: 'first' },
    });
    if (item) out.push(item);
  }
  return out;
}

// Leaving: a customer's service ends when they are ARCHIVED (CS-663: archived, never deleted —
// the archive takes their upcoming cleans off the schedule). The offboarding thank-you within
// EVENT_MAX_AGE_HOURS of the archive; the win-back WIN_BACK_AFTER_DAYS after it (to DAY_GRACE_DAYS
// later), while they are still archived. The only messages to a customer we no longer serve.
function walkLeaving(ctx) {
  const out = [];
  for (const client of ctx.clients.values()) {
    if (!isArchivedCustomer(client) || !client.archivedAt) continue;
    const site = [...ctx.sites.values()].find((st) => st.clientId === client.id) || null;
    const day = dayKey(client.archivedAt, ctx.tz);
    if (fresh(client.archivedAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) {
      const item = make(ctx, K.offboarding, { client, site, keyParts: [client.id, day], priority: 25, allowFormer: true });
      if (item) out.push(item);
    }
    const late = diffDaysKey(day, ctx.today) - WIN_BACK_AFTER_DAYS;
    if (late >= 0 && late <= DAY_GRACE_DAYS) {
      const item = make(ctx, K.winBack, { client, site, keyParts: [client.id, day], priority: 65, allowFormer: true });
      if (item) out.push(item);
    }
  }
  return out;
}

// ── SALES ────────────────────────────────────────────────────────────────────

// The new-lead acknowledgement: a lead the lead webhook stamped (`contact.leadReceivedAt`,
// api/_lib/leads/upsert.js) within EVENT_MAX_AGE_HOURS. Immediate (an auto-reply), to the lead's
// own address.
function walkLeads(ctx) {
  const out = [];
  for (const contact of ctx.contacts.values()) {
    if (!fresh(contact.leadReceivedAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) continue;
    const client = contact.companyId ? ctx.clients.get(contact.companyId) || null : null;
    const item = make(ctx, K.leadAck, { client, contact, keyParts: [contact.id, at(contact.leadReceivedAt)], priority: 5 });
    if (item) out.push(item);
  }
  return out;
}

// The walkthrough confirmation: a deal's walkthrough date and time SET or CHANGED within
// EVENT_MAX_AGE_HOURS (`walkthroughSetAt`, stamped at the write — lib/walkthrough stampWalkthrough),
// on a walkthrough still ahead, on a deal still open. To the deal's primary contact (else the
// company's, as the board's card shows it) — a prospect's own address, never the company's.
// Keyed by the deal, the walkthrough and its stamp: once per date set, and a changed date or time
// is a new stamp, so ONE updated confirmation. A deal from before this build carries no stamp, so
// switching the message on never confirms an old walkthrough. {site_name} is where we meet: the
// deal's "Where to meet", else the company's location, else its name.
function walkWalkthroughs(ctx) {
  const out = [];
  if (!ctx.enabled.has(K.walkthroughConfirm)) return out;
  for (const opp of ctx.state.opportunities || []) {
    if (!opp?.id || !isOpenOpportunity(opp)) continue;
    const startMs = at(opp.walkthroughAt);
    if (!(startMs > ctx.nowMs)) continue;
    if (!fresh(opp.walkthroughSetAt, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) continue;
    const client = ctx.clients.get(opp.clientId) || null;
    if (!client) continue;
    const contact = ctx.contacts.get(opp.primaryContactId) || ctx.contacts.get(client.primaryContactId) || null;
    const site = [...ctx.sites.values()].find((st) => st.clientId === client.id) || null;
    const where = String(opp.walkthroughWhere || '').trim();
    const item = make(ctx, K.walkthroughConfirm, {
      client, contact, site, keyParts: [opp.id, startMs, at(opp.walkthroughSetAt)], subjectId: opp.id, opportunityId: opp.id, priority: 6,
      extra: {
        date: fmtCustomerDate(opp.walkthroughAt, ctx.tz),
        time: fmtCustomerTime(opp.walkthroughAt, ctx.tz),
        site_name: where || site?.name || client.name || '',
      },
    });
    if (item) out.push(item);
  }
  return out;
}

// ── QUALITY ──────────────────────────────────────────────────────────────────

// Complaints (`input.complaints`: problem_reports of type complaint). The acknowledgement within
// EVENT_MAX_AGE_HOURS of it being logged, the resolution within EVENT_MAX_AGE_HOURS of it being
// resolved. Not a VISITOR's report (a stranger scanning a QR code is not the customer), and no
// resolution email when the customer hub's own email (HUB-11) already told the same person
// (`input.raisers`: the hub login that raised it, when that login gets request emails).
function walkComplaints(ctx) {
  const out = [];
  for (const p of ctx.input.complaints || []) {
    if (p.type !== 'complaint' || p.origin === 'visitor') continue;
    const client = ctx.clients.get(p.client_id);
    if (!client) continue;
    const site = ctx.sites.get(p.site_id) || null;
    if (fresh(p.created_at, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) {
      const item = make(ctx, K.complaintAck, { client, site, keyParts: [p.id], subjectId: p.id, priority: 14 });
      if (item) out.push(item);
    }
    if (p.status === 'resolved' && fresh(p.resolved_at, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) {
      const item = make(ctx, K.complaintResolution, { client, site, keyParts: [p.id], subjectId: p.id, priority: 14 });
      const raiser = ctx.input.raisers?.get?.(p.id);
      const told = raiser?.receives && item && String(raiser.email || '').toLowerCase() === String(item.recipient).toLowerCase();
      if (item && !told) out.push(item);
    }
  }
  return out;
}

// ── THE AGREEMENT (contracts) ────────────────────────────────────────────────

// Dated by the agreement (`input.contractDates`: the contract module's own reminder dates, for
// ACTIVE contracts): the renewal notice RENEWAL_NOTICE_LEAD_DAYS before an auto-renewal, the
// renewal offer RENEWAL_OFFER_LEAD_DAYS before it, the price-increase notice
// PRICE_INCREASE_LEAD_DAYS before a year whose monthly price RISES (a drop is no "increase").
// Each on its day or within DAY_GRACE_DAYS after, never later; one per building the agreement
// covers (each building's own main contact).
function walkContractDates(ctx) {
  const out = [];
  for (const d of ctx.input.contractDates || []) {
    const ahead = diffDaysKey(ctx.today, d.targetDate);
    const plan = [];
    if (d.kind === 'renewal') plan.push([K.renewalNotice, RENEWAL_NOTICE_LEAD_DAYS], [K.renewalOffer, RENEWAL_OFFER_LEAD_DAYS]);
    if (d.kind === 'price_increase' && d.rise) plan.push([K.priceIncrease, PRICE_INCREASE_LEAD_DAYS]);
    for (const [key, lead] of plan) {
      if (ahead > lead || ahead < lead - DAY_GRACE_DAYS) continue;
      for (const clientId of d.clientIds || []) {
        const client = ctx.clients.get(clientId);
        if (!client) continue;
        const site = [...ctx.sites.values()].find((st) => st.clientId === clientId) || null;
        const item = make(ctx, key, { client, site, keyParts: [d.contractId, d.targetDate, clientId], subjectId: d.contractId, priority: 45 });
        if (item) out.push(item);
      }
    }
  }
  return out;
}

// The service-change confirmation: queued by the contracts route when an ACTIVE agreement's
// frequency, scope or price changed (`input.pending`, customer_messages rows in 'pending'), within
// EVENT_MAX_AGE_HOURS of the save. The item's id IS the queued row's, so the run claims that row.
function walkServiceChanges(ctx) {
  const out = [];
  for (const row of ctx.input.pending || []) {
    if (row.template_key !== K.serviceChange || !fresh(row.created_at, ctx.nowMs, EVENT_MAX_AGE_HOURS * HOUR)) continue;
    const client = ctx.clients.get(row.client_id);
    if (!client) continue;
    const site = [...ctx.sites.values()].find((st) => st.clientId === client.id) || null;
    const p = row.payload || {};
    const summary = Array.isArray(p.summary) ? p.summary.map((x) => String(x)).join('\n') : '';
    if (!summary) continue;
    const effective = p.effectiveDay ? fmtCustomerDate(`${p.effectiveDay}T12:00:00Z`, 'UTC') : '';
    const item = make(ctx, K.serviceChange, { client, site, keyParts: [], subjectId: p.contractId || null, priority: 13, extra: { change_summary: summary, effective_date: effective } });
    if (item) out.push({ ...item, id: row.id });
  }
  return out;
}

// ── BILLING (from QuickBooks: `input.billing`, api/_lib/customerMessages/billing.js) ──

// The upcoming-due reminder UPCOMING_DUE_LEAD_DAYS before an open invoice is due (with
// DAY_GRACE_DAYS, never later), to the customer's billing contact. It promises a pay link: an
// invoice QuickBooks gives none for is not messaged. (The past-due TEXT went 2026-10-28: billing is
// email only; QuickBooks sends its own past-due email.) The monthly statement on the STATEMENT_DAY_OF_MONTH (or the grace days after),
// for every customer with an invoice, a payment or a balance in it; its PDF is attached at send.
function walkBilling(ctx) {
  const out = [];
  const b = ctx.input.billing;
  if (!b) return out;
  for (const inv of b.invoices || []) {
    if (!(inv.balanceCents > 0) || !inv.dueDay) continue;
    const client = ctx.clients.get(inv.clientId);
    if (!client) continue;
    const ahead = diffDaysKey(ctx.today, inv.dueDay);
    const extra = { invoice_number: inv.number, amount: dollars(inv.balanceCents), pay_link: inv.payLink || '' };
    if (ahead <= UPCOMING_DUE_LEAD_DAYS && ahead >= UPCOMING_DUE_LEAD_DAYS - DAY_GRACE_DAYS) {
      const item = make(ctx, K.upcomingDue, { client, keyParts: [inv.id, inv.dueDay], subjectId: inv.id, priority: 35, extra });
      if (item) out.push(item);
    }
  }
  const dom = Number(ctx.today.slice(8, 10));
  if (dom >= STATEMENT_DAY_OF_MONTH && dom <= STATEMENT_DAY_OF_MONTH + DAY_GRACE_DAYS) {
    for (const st of b.statements || []) {
      if (!st.invoices?.length && !st.payments?.length && !(st.balanceCents > 0)) continue;
      const client = ctx.clients.get(st.clientId);
      if (!client) continue;
      const item = make(ctx, K.statement, {
        client, keyParts: [client.id, st.month], priority: 70, extra: { balance: dollars(st.balanceCents) },
        payload: { statement: { ...st, customer: client.name } },
      });
      if (item) out.push(item);
    }
  }
  return out;
}

// ── THE SATISFACTION SURVEY ──────────────────────────────────────────────────

// The placeholder the survey's words carry until the run mints the customer's own link at send
// (api/_lib/customerMessages/surveys.js mintSurvey): one token per email, never one in advance.
export const SURVEY_LINK_PLACEHOLDER = '{survey_link}';

// Each customer's day in the survey's cycle: a stable hash of their id, so the ~750 surveys of a
// quarter spread over its SURVEY_EVERY_DAYS days (about eight a day) instead of all going the
// morning the template is switched on.
export function surveySlot(clientId) {
  let h = 0x811c9dc5;
  for (const ch of String(clientId || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % SURVEY_EVERY_DAYS;
}

// Every SURVEY_EVERY_DAYS per ACTIVE customer we serve (a clean of theirs in the window), once
// they have been with us SURVEY_MIN_TENURE_DAYS: on their day of the cycle, or within
// DAY_GRACE_DAYS after it. Keyed by the cycle, so it goes once a quarter.
function walkSurveys(ctx) {
  const out = [];
  if (!ctx.enabled.has(K.satisfactionSurvey)) return out;
  const served = new Set((ctx.input.jobs || []).filter((j) => j.status !== JOB_STATUS.CANCELLED).map((j) => j.clientId));
  const dayIndex = Math.floor(Date.parse(`${ctx.today}T00:00:00Z`) / DAY);
  for (const client of ctx.clients.values()) {
    if (!served.has(client.id)) continue;
    const since = at(client.createdAt);
    if (!Number.isFinite(since) || ctx.nowMs - since < SURVEY_MIN_TENURE_DAYS * DAY) continue;
    const late = (((dayIndex - surveySlot(client.id)) % SURVEY_EVERY_DAYS) + SURVEY_EVERY_DAYS) % SURVEY_EVERY_DAYS;
    if (late > DAY_GRACE_DAYS) continue;
    const cycle = Math.floor((dayIndex - late) / SURVEY_EVERY_DAYS);
    const site = [...ctx.sites.values()].find((st) => st.clientId === client.id) || null;
    const item = make(ctx, K.satisfactionSurvey, {
      client, site, keyParts: [client.id, cycle], priority: 75,
      extra: { survey_link: SURVEY_LINK_PLACEHOLDER }, payload: { survey: true },
    });
    if (item) out.push(item);
  }
  return out;
}

// ── "ON MY WAY" (the cleaner's button, api/time on-my-way) ───────────────────

// When the crew will arrive (onTheWayEta) lives in lib/crewOnTheWay.js, so the hub's bell line and
// phone alert give the same time as the text; re-exported here for the text's callers.
export { ON_THE_WAY_MIN_LEAD_MS, onTheWayEta } from './crewOnTheWay.js';

// The "crew on the way" text for one clean, built by the same rules as every message (the
// template, consent, the customer we serve, the clean's site contact's phone) — or why not:
//   { item } | { refused: 'off' | 'no-phone' }
// Immediate: the cleaner taps it on the road, whatever the hour. Once per clean (its key).
export function onTheWayItem(state, job, now = new Date()) {
  const ctx = contextOf({ state, jobs: [job] }, now instanceof Date ? now : new Date(now));
  if (!ctx.enabled.has(K.onTheWay)) return { refused: 'off' };
  const { client, site, service } = partsOfJob(ctx, job);
  if (!client) return { refused: 'no-phone' };
  const eta = onTheWayEta(job, ctx.nowMs);
  const item = make(ctx, K.onTheWay, { client, site, job, service, keyParts: [job.id], priority: 1, extra: { time: fmtCustomerTime(eta, ctx.tz) } });
  return item ? { item } : { refused: 'no-phone' };
}

const WALKERS = [walkBookings, walkVisitTexts, walkFinished, walkMissed, walkChanges, walkServiceSetup, walkUpsell, walkLeaving, walkLeads, walkWalkthroughs, walkComplaints, walkContractDates, walkServiceChanges, walkBilling, walkSurveys];

/**
 * Every message due RIGHT NOW. Pure: reads `input`, writes nothing.
 *   input: { state (the shared record, its deals' walkthroughs included), jobs (the window), unsubscribeUrl?(address),
 *            serviceStarts? (schedules that began UPSELL_AFTER_DAYS ago: { clientId, siteId,
 *            seriesId, startAt }), complaints? (problem_reports rows), raisers? (Map problem id →
 *            { email, receives }), contractDates? ({ contractId,
 *            kind, targetDate, clientIds, rise }), pending? (customer_messages rows queued by a route),
 *            billing? ({ invoices, statements } from QuickBooks) }
 * Sorted by priority (the receipts and the visit messages first), then by id.
 */
export function getDueMessages(input, now = new Date()) {
  const ctx = contextOf(input || {}, now instanceof Date ? now : new Date(now));
  if (!ctx.enabled.size) return [];
  const out = [];
  for (const walk of WALKERS) out.push(...walk(ctx));
  return out.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
