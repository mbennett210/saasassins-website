// Single reducer for the whole app. Actions are flat and explicit.
// Prefer small, named actions over a generic "update entity" action — easier to trace.

import { newId } from '../lib/ids';
import { nowIso, splitIso, composeIso, composeEndIso, dayOfWeekIso, addDaysKey, dayKey, diffDaysKey, money } from '../lib/dates';
import { expandRecurrence, crewForOccurrence, dayPatternOf, HORIZON_DAYS } from '../lib/recurrence';
import { classifyReply, OPT_OUT_RE } from '../lib/replyTriage';
import { stageExistsOnPipeline } from '../lib/pipelines';
import { isDoNotContact, buildSuppressedEmailSet } from '../lib/contactConsent';
import { INITIAL_STATE, DEFAULT_NOTIFICATION_PREFS } from '../data/seed';
import { deriveInvoiceStatus } from './selectors';
import { tableOwnedSliceKeys } from './tableSlices';
import { applyJobPatch } from './jobsMerge';
import { applyTimeOffToOccurrence, normalizeTimeOffKind, normalizeJobIds } from './timeOffRules';
import { resolveJobCrewIds, isUserJobCrew } from '../lib/crewResolve';
import { buildClientLocation, clientGetsLocation, CLIENT_BILLING_DEFAULTS } from '../lib/location';
import { isLastOwner, applyMandatoryNotificationPolicy } from '../lib/roles';
import { REVIEW_KINDS, emptyReview, mergeReview, SIGNOFF_FIELDS, isSignedOff, sameSitting, reviewFieldEq } from '../lib/clientReview';
import jobTombstones from './jobTombstones';
import {
  isNotificationVisibleForUser,
  isNotificationEnabled,
  fanOutMessageNotifications,
  fanOutOpsNotification,
  opsPatchTouchesCrew,
  fanOutJobNotification,
  fanOutInvoiceNotification,
  fanOutKeyNotification,
  fanOutManagerAlert,
  fanOutToUserIds,
  capInsert,
} from '../lib/notifications';
import { capTail, capTailProtected } from '../lib/retention';
import { supplyRequestTotal, supplyRequestItemCount, pruneSupplyRequests } from '../lib/supplies';
import {
  sweepClientOrphans, scrubTagFromSequences, oauthWorkspaceInUse, sweepUserOrphans, hasUnsettledPay,
  reimbursementForLine, removeReimbursement,
} from '../lib/deleteCascade';
import { removeTemplateFromClients } from '../lib/crewChecklist';
import { normalizeCoverFor, settleCoverFor, coverForNamesUser, removeUserFromCoverFor } from '../lib/jobCover';
import { applyOpsAlert } from '../lib/opsAlertApply';

export const ACTIONS = {
  RESET: 'RESET',
  HYDRATE: 'HYDRATE',

  SET_CURRENT_USER: 'SET_CURRENT_USER',
  SET_VIEW_AS: 'SET_VIEW_AS',

  // Company
  UPDATE_COMPANY: 'UPDATE_COMPANY',

  // Services / frequencies
  ADD_SERVICE: 'ADD_SERVICE',
  UPDATE_SERVICE: 'UPDATE_SERVICE',
  DELETE_SERVICE: 'DELETE_SERVICE',
  ADD_FREQUENCY: 'ADD_FREQUENCY',
  UPDATE_FREQUENCY: 'UPDATE_FREQUENCY',
  DELETE_FREQUENCY: 'DELETE_FREQUENCY',

  // Team (users)
  ADD_USER: 'ADD_USER',
  UPDATE_USER: 'UPDATE_USER',
  DELETE_USER: 'DELETE_USER',
  UPDATE_NOTIFICATION_PREFS: 'UPDATE_NOTIFICATION_PREFS',
  UPDATE_SIGNATURE_PREFS: 'UPDATE_SIGNATURE_PREFS',

  // Account operations (Swept replacement — v49 ops)
  UPDATE_CLIENT_OPS: 'UPDATE_CLIENT_OPS',
  UPDATE_OPS_SETTINGS: 'UPDATE_OPS_SETTINGS',
  // Scrub a hard-deleted checklist template out of every location's per-cleaner bindings
  // (`crewChecklists`, the only binding there is since R3 retired the location-wide
  // default) — dispatched after qcApi.deleteTemplate so no binding dangles.
  SCRUB_CHECKLIST_TEMPLATE: 'SCRUB_CHECKLIST_TEMPLATE',

  // Payroll — one-off pay lines (bonus / reimbursement / tip / deduction) per user
  // per pay period. Hours + rates drive base pay; these are the manual adjustments.
  ADD_PAYROLL_LINE: 'ADD_PAYROLL_LINE',
  UPDATE_PAYROLL_LINE: 'UPDATE_PAYROLL_LINE',
  DELETE_PAYROLL_LINE: 'DELETE_PAYROLL_LINE',

  // HR — reimbursement requests (approved → a payroll reimbursement line) and
  // per-employee document metadata (bytes in the lib/hrFiles stub, never the blob).
  ADD_REIMBURSEMENT: 'ADD_REIMBURSEMENT',
  UPDATE_REIMBURSEMENT: 'UPDATE_REIMBURSEMENT',
  DELETE_REIMBURSEMENT: 'DELETE_REIMBURSEMENT',
  ADD_EMPLOYEE_DOCUMENT: 'ADD_EMPLOYEE_DOCUMENT',
  DELETE_EMPLOYEE_DOCUMENT: 'DELETE_EMPLOYEE_DOCUMENT',

  // Notifications inbox (persistent in-app, surfaced via the bell). Rows are
  // created by the fan-out helpers in lib/notifications (message / job / invoice
  // / ops) and by RECEIVE_MARKETING_REPLY — not via a generic add action.
  REMOVE_NOTIFICATION: 'REMOVE_NOTIFICATION',
  MARK_NOTIFICATION_READ: 'MARK_NOTIFICATION_READ',
  MARK_ALL_NOTIFICATIONS_READ: 'MARK_ALL_NOTIFICATIONS_READ',
  CLEAR_NOTIFICATIONS: 'CLEAR_NOTIFICATIONS',

  // Clients
  ADD_CLIENT: 'ADD_CLIENT',
  UPDATE_CLIENT: 'UPDATE_CLIENT',
  DELETE_CLIENT: 'DELETE_CLIENT',
  TAG_CLIENT: 'TAG_CLIENT',
  UNTAG_CLIENT: 'UNTAG_CLIENT',
  APPEND_CLIENT_NOTE: 'APPEND_CLIENT_NOTE',
  ADD_CLIENT_ACTIVITY: 'ADD_CLIENT_ACTIVITY',
  UPDATE_CLIENT_ACTIVITY: 'UPDATE_CLIENT_ACTIVITY',
  DELETE_CLIENT_ACTIVITY: 'DELETE_CLIENT_ACTIVITY',

  // Contacts (CRM)
  ADD_CONTACT: 'ADD_CONTACT',
  UPDATE_CONTACT: 'UPDATE_CONTACT',
  DELETE_CONTACT: 'DELETE_CONTACT',
  TAG_CONTACT: 'TAG_CONTACT',
  UNTAG_CONTACT: 'UNTAG_CONTACT',
  APPEND_CONTACT_NOTE: 'APPEND_CONTACT_NOTE',

  // Opportunities (deals) — company-owned, the cards on the pipeline board.
  ADD_OPPORTUNITY: 'ADD_OPPORTUNITY',
  UPDATE_OPPORTUNITY: 'UPDATE_OPPORTUNITY',
  DELETE_OPPORTUNITY: 'DELETE_OPPORTUNITY',
  SET_OPPORTUNITY_STAGE: 'SET_OPPORTUNITY_STAGE',

  // Tags
  ADD_TAG: 'ADD_TAG',
  UPDATE_TAG: 'UPDATE_TAG',
  DELETE_TAG: 'DELETE_TAG',

  // Contact activities
  ADD_CONTACT_ACTIVITY: 'ADD_CONTACT_ACTIVITY',
  UPDATE_CONTACT_ACTIVITY: 'UPDATE_CONTACT_ACTIVITY',
  DELETE_CONTACT_ACTIVITY: 'DELETE_CONTACT_ACTIVITY',

  // Per-user permission overrides
  SET_USER_PERMISSION_OVERRIDE: 'SET_USER_PERMISSION_OVERRIDE',

  // Location (one per customer; created + removed with the customer)
  UPDATE_SITE: 'UPDATE_SITE',

  // Jobs
  // B1: jobs are persisted per-row in public.jobs (not the org_state blob). These
  // two are dispatched by the sync manager only — SET_JOBS replaces the whole array
  // at boot (loaded from the table); PATCH_JOBS applies per-row realtime upserts/deletes.
  SET_JOBS: 'SET_JOBS',
  PATCH_JOBS: 'PATCH_JOBS',
  ADD_JOB: 'ADD_JOB',
  ADD_JOB_SERIES: 'ADD_JOB_SERIES',
  TOP_UP_RECURRING_SERIES: 'TOP_UP_RECURRING_SERIES',
  UPDATE_JOB: 'UPDATE_JOB',
  UPDATE_JOB_SERIES: 'UPDATE_JOB_SERIES',
  SET_JOB_STATUS: 'SET_JOB_STATUS',
  DELETE_JOB: 'DELETE_JOB',
  DELETE_JOB_SERIES: 'DELETE_JOB_SERIES',

  // Time off (Sept 1: availability finally has a machine-readable model —
  // see store/timeOffRules.js). APPLY_TIME_OFF_EXCLUSIONS is the bulk "take
  // this person off their already-materialized cleans in the range" companion.
  ADD_TIME_OFF: 'ADD_TIME_OFF',
  DELETE_TIME_OFF: 'DELETE_TIME_OFF',
  APPLY_TIME_OFF_EXCLUSIONS: 'APPLY_TIME_OFF_EXCLUSIONS',

  // Invoices
  ADD_INVOICE: 'ADD_INVOICE',
  UPDATE_INVOICE: 'UPDATE_INVOICE',
  ADD_INVOICE_PAYMENT: 'ADD_INVOICE_PAYMENT',
  UPDATE_INVOICE_PAYMENT: 'UPDATE_INVOICE_PAYMENT',
  REMOVE_INVOICE_PAYMENT: 'REMOVE_INVOICE_PAYMENT',
  SET_INVOICE_STATUS: 'SET_INVOICE_STATUS',
  MARK_INVOICES_OVERDUE: 'MARK_INVOICES_OVERDUE',
  DELETE_INVOICE: 'DELETE_INVOICE',

  // Quotes (Supabase-backed; mirrored into the store for the list + payment sync)
  UPSERT_QUOTE: 'UPSERT_QUOTE',
  MARK_PAYMENT_SYNCED: 'MARK_PAYMENT_SYNCED',

  // Integrations — external financial snapshot (Google Sheet → dashboard)
  SET_FINANCIAL_SNAPSHOT: 'SET_FINANCIAL_SNAPSHOT',

  // Keys (check-in / check-out)
  ADD_KEY: 'ADD_KEY',
  UPDATE_KEY: 'UPDATE_KEY',
  DELETE_KEY: 'DELETE_KEY',
  CHECKOUT_KEY: 'CHECKOUT_KEY',
  CHECKIN_KEY: 'CHECKIN_KEY',
  MARK_KEY_UNKNOWN: 'MARK_KEY_UNKNOWN',
  MARK_KEY_LOST: 'MARK_KEY_LOST',
  SET_INSPECTION_FOLLOWUP: 'SET_INSPECTION_FOLLOWUP',
  // ---------- Supplies (S58) ----------
  ADD_SUPPLY_ITEM: 'ADD_SUPPLY_ITEM',
  UPDATE_SUPPLY_ITEM: 'UPDATE_SUPPLY_ITEM',
  DELETE_SUPPLY_ITEM: 'DELETE_SUPPLY_ITEM',
  ADD_SUPPLY_REQUEST: 'ADD_SUPPLY_REQUEST',
  COMPLETE_SUPPLY_REQUEST: 'COMPLETE_SUPPLY_REQUEST',
  REOPEN_SUPPLY_REQUEST: 'REOPEN_SUPPLY_REQUEST',
  DELETE_SUPPLY_REQUEST: 'DELETE_SUPPLY_REQUEST',
  SET_REVIEWS: 'SET_REVIEWS',
  // Operational alerts (late/missed shift; checklist/inspection reminders later).
  // Raised by the client tick (components/OpsAlertScheduler) + the go-live cron.
  RAISE_OPS_ALERT: 'RAISE_OPS_ALERT',

  // Conversations / messages
  ADD_CONVERSATION: 'ADD_CONVERSATION',
  ADD_DM_CONVERSATION: 'ADD_DM_CONVERSATION',
  ADD_INTERNAL_CONVERSATION: 'ADD_INTERNAL_CONVERSATION',
  ADD_THREAD_PARTICIPANT: 'ADD_THREAD_PARTICIPANT',
  UPDATE_CONVERSATION: 'UPDATE_CONVERSATION',
  RENAME_CONVERSATION: 'RENAME_CONVERSATION',
  ADD_MESSAGE: 'ADD_MESSAGE',
  MARK_CONVERSATION_READ: 'MARK_CONVERSATION_READ',
  MARK_CONVERSATION_UNREAD: 'MARK_CONVERSATION_UNREAD',
  DELETE_CONVERSATION: 'DELETE_CONVERSATION',

  // Snippets (Messaging Phase 2a)
  ADD_SNIPPET: 'ADD_SNIPPET',
  UPDATE_SNIPPET: 'UPDATE_SNIPPET',
  DELETE_SNIPPET: 'DELETE_SNIPPET',

  // Messaging Phase 2b — starring / muting / folders / bulk
  TOGGLE_CONVERSATION_STAR: 'TOGGLE_CONVERSATION_STAR',
  TOGGLE_CONVERSATION_MUTE: 'TOGGLE_CONVERSATION_MUTE',
  BULK_MARK_CONVERSATIONS_READ: 'BULK_MARK_CONVERSATIONS_READ',
  BULK_MARK_CONVERSATIONS_UNREAD: 'BULK_MARK_CONVERSATIONS_UNREAD',
  BULK_DELETE_CONVERSATIONS: 'BULK_DELETE_CONVERSATIONS',

  // Reminders
  UPDATE_REMINDER_TEMPLATE: 'UPDATE_REMINDER_TEMPLATE',
  ADD_REMINDER_EVENT: 'ADD_REMINDER_EVENT',
  UPDATE_REMINDER_EVENT: 'UPDATE_REMINDER_EVENT',
  MARK_REMINDER_EVENT_READ: 'MARK_REMINDER_EVENT_READ',
  MARK_REMINDER_EVENT_UNREAD: 'MARK_REMINDER_EVENT_UNREAD',

  // Client review (shared: section approvals + draft reviews + layout picks + notes)
  UPDATE_CLIENT_REVIEW: 'UPDATE_CLIENT_REVIEW',
  ADD_CLIENT_REVIEW_NOTE: 'ADD_CLIENT_REVIEW_NOTE',
  SET_CLIENT_REVIEW: 'SET_CLIENT_REVIEW',

  // Permissions
  UPDATE_PERMISSION: 'UPDATE_PERMISSION',

  // Pipelines (v15)
  ADD_PIPELINE: 'ADD_PIPELINE',
  UPDATE_PIPELINE: 'UPDATE_PIPELINE',
  DELETE_PIPELINE: 'DELETE_PIPELINE',
  SET_ACTIVE_PIPELINE: 'SET_ACTIVE_PIPELINE',
  ADD_PIPELINE_STAGE: 'ADD_PIPELINE_STAGE',
  UPDATE_PIPELINE_STAGE: 'UPDATE_PIPELINE_STAGE',
  DELETE_PIPELINE_STAGE: 'DELETE_PIPELINE_STAGE',
  REORDER_PIPELINE_STAGES: 'REORDER_PIPELINE_STAGES',

  // Invitations
  SEND_INVITATION: 'SEND_INVITATION',
  RESEND_INVITATION: 'RESEND_INVITATION',
  REVOKE_INVITATION: 'REVOKE_INVITATION',

  // Integrations / Twilio (v8)
  CONNECT_TWILIO: 'CONNECT_TWILIO',
  DISCONNECT_TWILIO: 'DISCONNECT_TWILIO',
  UPDATE_TWILIO_NUMBER: 'UPDATE_TWILIO_NUMBER',
  UPDATE_TWILIO_WEBHOOK: 'UPDATE_TWILIO_WEBHOOK',
  UPDATE_TWILIO_ERROR: 'UPDATE_TWILIO_ERROR',
  SUBMIT_A2P: 'SUBMIT_A2P',
  UPDATE_A2P_STATUS: 'UPDATE_A2P_STATUS',
  RESET_A2P: 'RESET_A2P',
  // Integrations / Email Provider — Resend (v27). System transactional sends only.
  // Per-user conversational email lives in connectedInboxes (Phase 3).
  CONNECT_EMAIL_PROVIDER: 'CONNECT_EMAIL_PROVIDER',
  DISCONNECT_EMAIL_PROVIDER: 'DISCONNECT_EMAIL_PROVIDER',
  UPDATE_EMAIL_DOMAIN_STATUS: 'UPDATE_EMAIL_DOMAIN_STATUS',
  UPDATE_EMAIL_DEFAULT_FROM: 'UPDATE_EMAIL_DEFAULT_FROM',
  UPDATE_EMAIL_ERROR: 'UPDATE_EMAIL_ERROR',
  // Connected Inboxes (per-user mailbox connections for Messaging email).
  // Tokens + SMTP passwords live encrypted on the backend; these actions
  // only manipulate the metadata + status surface visible to the frontend.
  ADD_CONNECTED_INBOX: 'ADD_CONNECTED_INBOX',
  UPDATE_CONNECTED_INBOX: 'UPDATE_CONNECTED_INBOX',
  REMOVE_CONNECTED_INBOX: 'REMOVE_CONNECTED_INBOX',
  SET_DEFAULT_CONNECTED_INBOX: 'SET_DEFAULT_CONNECTED_INBOX',
  // ---------- Google Workspaces (multi-Workspace OAuth registry, super admin) ----------
  // One entry per Google Workspace org wired to its own Internal OAuth app.
  // Mailboxes attribute to a workspace via workspaceId. The OAuth client_secret
  // stays backend-side (encrypted); these actions only touch display metadata.
  ADD_OAUTH_WORKSPACE: 'ADD_OAUTH_WORKSPACE',
  UPDATE_OAUTH_WORKSPACE: 'UPDATE_OAUTH_WORKSPACE',
  REMOVE_OAUTH_WORKSPACE: 'REMOVE_OAUTH_WORKSPACE',
  // Inbound/outbound SMS plumbing — adds delivery state to messages and routes inbound to threads.
  RECEIVE_SMS: 'RECEIVE_SMS',
  // Inbound email plumbing — backend (Phase 4c) parses Gmail Pub/Sub /
  // Microsoft Graph / IMAP-poll payloads and dispatches RECEIVE_EMAIL with
  // the parsed envelope. Thread continuity is established via In-Reply-To
  // header lookup; falls back to recipient-email matching, then unlinked.
  RECEIVE_EMAIL: 'RECEIVE_EMAIL',
  SET_MESSAGE_DELIVERY: 'SET_MESSAGE_DELIVERY',

  // ---------- Marketing (v37) ----------
  // Company-shared rotation inboxes — distinct from connectedInboxes (which
  // are per-user Messaging mailboxes). Tokens stay backend-side; the frontend
  // only sees metadata.
  ADD_MARKETING_INBOX: 'ADD_MARKETING_INBOX',
  UPDATE_MARKETING_INBOX: 'UPDATE_MARKETING_INBOX',
  REMOVE_MARKETING_INBOX: 'REMOVE_MARKETING_INBOX',
  REORDER_MARKETING_INBOXES: 'REORDER_MARKETING_INBOXES',
  // Sequences with embedded steps. status: 'draft' | 'active' | 'paused' | 'archived'.
  // audienceMode: 'auto' | 'manual'. onStageExit: 'continue' | 'unenroll'.
  ADD_MARKETING_SEQUENCE: 'ADD_MARKETING_SEQUENCE',
  UPDATE_MARKETING_SEQUENCE: 'UPDATE_MARKETING_SEQUENCE',
  DELETE_MARKETING_SEQUENCE: 'DELETE_MARKETING_SEQUENCE',
  ADD_MARKETING_STEP: 'ADD_MARKETING_STEP',
  UPDATE_MARKETING_STEP: 'UPDATE_MARKETING_STEP',
  DELETE_MARKETING_STEP: 'DELETE_MARKETING_STEP',
  REORDER_MARKETING_STEPS: 'REORDER_MARKETING_STEPS',
  // Round-robin counter — dispatched by the scheduler on every successful enqueue.
  ADVANCE_SEQUENCE_INBOX_INDEX: 'ADVANCE_SEQUENCE_INBOX_INDEX',
  // Enrollment lifecycle. ENROLL_CONTACTS is dedup-safe (skips contacts
  // already enrolled). ADVANCE_ENROLLMENT_STEP bumps currentStepIndex AND
  // stamps lastSentAt — single seam, called once per successful send.
  ENROLL_CONTACTS: 'ENROLL_CONTACTS',
  UNENROLL_CONTACT: 'UNENROLL_CONTACT',
  ADVANCE_ENROLLMENT_STEP: 'ADVANCE_ENROLLMENT_STEP',
  // Send events log — mirrors reminderEvents.
  RECORD_MARKETING_SEND: 'RECORD_MARKETING_SEND',
  UPDATE_MARKETING_SEND: 'UPDATE_MARKETING_SEND',
  // Diagnostics "Retry": drop a failed send row so the scheduler re-attempts
  // that (enrollment, step). Paired with clearInFlight() in the UI.
  RETRY_MARKETING_SEND: 'RETRY_MARKETING_SEND',
  // Reply handling. RECEIVE_MARKETING_REPLY records an inbound reply, halts
  // the enrollment when the sequence opts in (haltOnReply), and routes the
  // contact per the sequence's replyRouting config — all in one transition.
  // UPDATE_MARKETING_REPLY patches a reply row (e.g. mark handled).
  // RESUME_ENROLLMENT clears a reply-halt so the drip continues.
  RECEIVE_MARKETING_REPLY: 'RECEIVE_MARKETING_REPLY',
  // Suppression list (CAN-SPAM opt-out): add/remove a globally suppressed email.
  ADD_MARKETING_SUPPRESSION: 'ADD_MARKETING_SUPPRESSION',
  REMOVE_MARKETING_SUPPRESSION: 'REMOVE_MARKETING_SUPPRESSION',
  UPDATE_MARKETING_REPLY: 'UPDATE_MARKETING_REPLY',
  RESUME_ENROLLMENT: 'RESUME_ENROLLMENT',
  // Global Marketing settings — shallow-merged into state.marketingSettings.
  UPDATE_MARKETING_SETTINGS: 'UPDATE_MARKETING_SETTINGS',
};

function replaceById(list, id, patch) {
  return list.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

function removeById(list, id) {
  return list.filter((x) => x.id !== id);
}

const idSetKey = (ids) => [...new Set(ids || [])].sort().join(',');

// A NEW series' template (ADD_JOB_SERIES): the regular crew, times and weekday go into
// the recurrence, so no row's own values stand in for them — not the master's visit when
// it is edited on its own, not whichever row inherits the recurrence when the master is
// deleted or re-homed. Only fills what isn't already set.
function pinTemplateDefaults(rec, master) {
  if (!rec || !master) return rec;
  let r = rec;
  if (!Array.isArray(r.crewOverride)) r = { ...r, crewOverride: master.crewIds || [] };
  if (!r.timeOverride?.startTime) {
    r = { ...r, timeOverride: { startTime: splitIso(master.startAt).time, endTime: splitIso(master.endAt).time } };
  }
  if (r.frequency === 'weekly' && !r.daysOfWeek?.length) r = { ...r, daysOfWeek: [dayOfWeekIso(master.startAt)] };
  return r;
}

// Is this visit's crew the series' regular crew for its day? Forgives what the system
// itself does to a regular visit: someone booked off that day and taken off it (the
// pattern minus them), and a departed cleaner scrubbed from it (ids no longer on the
// team are ignored).
function isRegularCrew(state, visit, patternCrew) {
  const team = new Set((state.users || []).map((u) => u.id));
  const key = (ids) => idSetKey((ids || []).filter((id) => team.has(id)));
  return key(visit.crewIds) === key(patternCrew)
    || key(visit.crewIds) === key(applyTimeOffToOccurrence(state, { crewIds: patternCrew, startAt: visit.startAt }).crewIds);
}

// 🔴 A single-visit edit of a SERIES visit marks what it changed as a one-off
// (`oneOff: { crew?: true, time?: true }`, 2026-09-23 owner default). A later "this &
// all future" crew / time change skips those fields on this visit, so a one-night cover
// or a one-off time survives it. Setting the value back to the series' regular one
// (dayPatternOf) clears the mark. EXPLICIT on purpose: an adversarial review broke the
// first design, which inferred one-offs by comparing each visit to the template, in six
// ways (series edited before this existed, a later-dated edit followed by an earlier
// one, a template re-homed onto a one-off row, DST, a replay). Mints never copy the
// mark; the server guard protects it like crewIds (it decides who stays on a visit).
function markOneOff(state, prior, patch) {
  const merged = { ...prior, ...patch };
  const master = merged.recurrence
    ? merged
    : (state.jobs.find((j) => j.seriesId === prior.seriesId && j.recurrence) || null);
  const pat = master ? dayPatternOf(master, dayOfWeekIso(merged.startAt)) : null;
  const flags = { ...(prior.oneOff || {}) };
  if (Array.isArray(patch.crewIds) && idSetKey(patch.crewIds) !== idSetKey(prior.crewIds)) {
    if (pat && isRegularCrew(state, merged, pat.crewIds)) delete flags.crew;
    else flags.crew = true;
  }
  const hm = (j) => `${splitIso(j.startAt).time}-${splitIso(j.endAt).time}`;
  if (hm(merged) !== hm(prior)) {
    if (pat && hm(merged) === `${pat.startTime}-${pat.endTime}`) delete flags.time;
    else flags.time = true;
  }
  // Canonical key order (crew, then time), so equal marks always serialize alike.
  const next = (flags.crew || flags.time)
    ? { ...(flags.crew ? { crew: true } : {}), ...(flags.time ? { time: true } : {}) }
    : null;
  return JSON.stringify(next) === JSON.stringify(prior.oneOff || null) ? patch : { ...patch, oneOff: next };
}

// A SYSTEM crew change (the time-off exclusion, a deleted user) can end a one-off crew:
// the helper ADDED to a visit books that night off (back on the regular crew), or the
// cover who REPLACED the regular leaves (nobody on it). Either way the visit is no longer
// a one-off, and a kept mark would make the next series crew change skip it: a regular-
// looking visit keeps the replaced cleaner, or an empty one stays unassigned (adversarial
// review). Pass the state as it will be (a deleted user already off the roster) so the
// regular-crew test sees the same team.
//
// 🔴 `coverFor` (R8, 2026-09-27) settles HERE TOO, and BEFORE the mark test — its lifetime
// is the one-off crew mark's (lib/jobCover.js). It is normalized whatever the mark says,
// because a visit can hold a cover with no mark (a non-series clean, or a sanitized write
// that put `oneOff: null` back), and a stale entry silently sends a cleaner to the wrong
// checklist rather than merely mis-scoping a later series edit.
// The day's REGULAR crew for a series visit — the same value markOneOff judges a one-off
// against, and what decides whether a cover is still covering anyone (lib/jobCover.js).
// Returns null when it is UNKNOWABLE: a one-off clean, which has no weekday pattern, or a
// series whose master sits outside the windowed boot. `normalizeCoverFor` then falls back
// to crew membership alone rather than dropping a live cover on a guess.
// The RAW pattern, deliberately: applying booked time off first would delete the headline
// case, where the regular is off the visit precisely because they booked that day off.
function regularCrewFor(state, visit, master = undefined) {
  if (!visit?.seriesId || !visit.startAt) return null;
  const m = master !== undefined ? master : state.jobs.find((j) => j.seriesId === visit.seriesId && j.recurrence);
  if (!m?.recurrence) return null;
  const pat = dayPatternOf(m, dayOfWeekIso(visit.startAt));
  return Array.isArray(pat?.crewIds) ? pat.crewIds : null;
}

function settleCrewMark(state, visit) {
  const settled = settleCoverFor(visit, regularCrewFor(state, visit));
  if (!settled.oneOff?.crew) return settled;
  if ((settled.crewIds || []).length) {
    const master = state.jobs.find((j) => j.seriesId === settled.seriesId && j.recurrence);
    if (!master || !isRegularCrew(state, settled, dayPatternOf(master, dayOfWeekIso(settled.startAt)).crewIds)) return settled;
  }
  return { ...settled, oneOff: settled.oneOff.time ? { time: true } : null };
}

// The single-visit edit's cover, settled at the WRITE point (UPDATE_JOB). The office's
// "Covering for" control sends `coverFor` beside `crewIds`; whatever arrives — a fresh
// pick, a stale map from a tab that never saw the crew change, or a replayed action — is
// re-normalized against the visit's FINAL crew, so an entry naming someone not on the
// visit is never stored. Returns the patch with `coverFor` only when it actually moves, so
// an unrelated edit (notes, tags) neither adds the key nor rewrites it.
function settleCoverPatch(state, prior, patch) {
  if (!prior) return patch;
  const asked = ('coverFor' in patch) ? patch.coverFor : prior.coverFor;
  const crewIds = Array.isArray(patch.crewIds) ? patch.crewIds : prior.crewIds;
  // Judged on the row this edit LEAVES: a date move changes which weekday's regulars apply.
  const next = normalizeCoverFor(asked, crewIds, regularCrewFor(state, { ...prior, ...patch }));
  if (JSON.stringify(next) !== JSON.stringify(prior.coverFor ?? null)) return { ...patch, coverFor: next };
  if (!('coverFor' in patch)) return patch;
  const { coverFor, ...rest } = patch;   // the ask resolved to what is already stored
  void coverFor;
  return rest;
}

// Ops-relevant fields whose change should ping the account's assigned crew via
// the accountOpsUpdated notification — the same event the client Operations tab
// fires through UPDATE_CLIENT_OPS. Applied to the generic UPDATE_SITE /
// UPDATE_CLIENT paths (site editor, per-site codes, and the Team → member and
// invite "assign to accounts" surfaces) so a standing-crew / access / cleaning
// change made outside the Operations tab is no longer silent. Deliberately
// minimal + deep-compared so ordinary edits (rename, address, geofence, tags,
// status, attachments, contact) never fire a spurious notification.
const SITE_OPS_FIELDS = ['security', 'accessNotes', 'cleaningAreas'];
const CLIENT_OPS_FIELDS = ['security', 'opsNotes'];

// Cap on the shared reminderEvents log so it can't grow the org_state blob
// unbounded (mirrors NOTIFICATION_LIMIT_PER_USER for bell rows). Oldest-by-
// position dropped.
const REMINDER_EVENT_LIMIT = 500;

// Internal-thread title cap — matches the maxLength on the create modal's Title
// field (NewInternalThreadModal), so a rename can never produce a name the
// create flow would have rejected.
export const THREAD_TITLE_MAX = 120;
// SCALE-C21: hard-ceiling backstops for the other append-only event-log arrays that
// otherwise grow the org_state blob forever. These are deliberately GENEROUS — they
// are safety nets against pathological growth, not the primary trim (that is the
// audited /data-op with age-based TTLs + a retention decision on keyEvents). They are
// no-ops at today's volumes, so this ships additive with no seed/STORAGE_KEY bump.
// Applied once per dispatch in applyLogCaps(), only when an array's ref actually changed.
const ACTIVITY_LOG_CEIL = 5000;    // contactActivities / clientActivities (each)
const MARKETING_REPLY_CEIL = 2000; // marketingReplies
const MARKETING_SEND_CEIL = 5000;  // marketingSends — enrollment-aware (never drops a live send)
const KEY_EVENT_CEIL = 25000;      // keyEvents — legal custody trail: ceiling only, NEVER a TTL
// Reminder-failure reasons we do NOT alert the office about — systemic setup or
// per-ACCOUNT data-gap conditions, not genuine per-send delivery failures. These
// fire on EVERY reminder to an affected account, so alerting would flood the bell
// (e.g. an account with no email on file → every booking/post-service email
// reminder "fails", or SMS before the Twilio number is provisioned). Only a real
// send error (the adapter actually attempted and was rejected) raises reminderFailed.
const NON_ACTIONABLE_REMINDER_FAIL_RE = /twilio not connected|no twilio number|a2p|not provisioned|no email address|no phone number/i;

function opsFieldsChanged(fields, prev, patch) {
  if (!prev || !patch) return false;
  return fields.some((f) => f in patch && JSON.stringify(patch[f]) !== JSON.stringify(prev[f]));
}

// SCALE-C21: bound the append-only event-log arrays once per dispatch. Only an array
// whose reference actually changed this dispatch is touched (cheap ref checks otherwise).
// Ceilings only — a generous backstop against unbounded blob growth that is a no-op at
// today's volumes; the age-based TTL trims + the historical bulk cleanup are the audited
// /data-op. keyEvents is a legal custody trail → ceiling only, never a TTL.
function applyLogCaps(prev, next) {
  let out = next;
  const cap = (key, fn) => {
    const cur = out[key];
    if (cur === prev[key]) return; // untouched this dispatch
    const capped = fn(cur);
    if (capped !== cur) out = { ...out, [key]: capped };
  };
  cap('contactActivities', (a) => capTail(a, ACTIVITY_LOG_CEIL));
  cap('clientActivities', (a) => capTail(a, ACTIVITY_LOG_CEIL));
  cap('marketingReplies', (a) => capTail(a, MARKETING_REPLY_CEIL));
  cap('keyEvents', (a) => capTail(a, KEY_EVENT_CEIL));
  // marketingSends: enrollment-aware — a send whose enrollment is still 'active' is
  // protected (dropping it would make hasSent() false → re-fire the step → CAN-SPAM).
  // liveEnrIds is built lazily (cap only invokes fn when marketingSends changed).
  cap('marketingSends', (a) => capTailProtected(
    a, MARKETING_SEND_CEIL,
    new Set((out.marketingEnrollments || []).filter((e) => e.status === 'active').map((e) => e.id)),
    'enrollmentId',
  ));
  return out;
}

// The reducer the app dispatches through: the pure switch (baseReducer) then a
// once-per-dispatch pass that bounds the event-log arrays. A no-op dispatch
// (baseReducer returns the same state ref) skips the cap pass entirely, so state
// identity is preserved exactly as before — load-bearing for the sync content-guard
// and React render bail-outs.
export function reducer(state, action) {
  const next = baseReducer(state, action);
  return next === state ? next : applyLogCaps(state, next);
}

function baseReducer(state, action) {
  switch (action.type) {
    case ACTIONS.RESET:
      return INITIAL_STATE;

    case ACTIONS.HYDRATE: {
      // Defensive per-slice defaults. A blob that DROPS a table-owned slice key
      // instead of emptying it — a botched prune, or a doc written by a build that
      // predates the slice — would otherwise crash every reader doing
      // `state.<slice>.filter(...)` app-wide, on the one code path that exists to
      // load a user's workspace. Degrade to an empty slice instead. This is the
      // safety net behind the PRUNE-TO-[]-NEVER-DELETE-KEY invariant, not a licence
      // to drop the key (see REMEDIATION_PLAN.md §4).
      //
      // Returns the payload UNTOUCHED (same ref) when nothing needs defaulting, so
      // this never perturbs reference identity for the render bailout.
      const payload = action.payload;
      if (!payload || typeof payload !== 'object') return payload;
      let patched = null;
      for (const key of tableOwnedSliceKeys()) {
        if (!Array.isArray(payload[key])) {
          patched = patched || { ...payload };
          patched[key] = [];
        }
      }
      return patched || payload;
    }

    // B1: jobs are synced per-row from public.jobs, separately from the org_state
    // blob. SET_JOBS replaces the whole array (boot); PATCH_JOBS applies realtime
    // upserts/deletes from other tabs. Sync-manager only (raw dispatch, not recorded).
    case ACTIONS.SET_JOBS:
      return { ...state, jobs: Array.isArray(action.jobs) ? action.jobs : [] };
    // ORDER-GUARDED-PATCH (Increment 2). Realtime delivery is UNORDERED — and
    // Broadcast, which replaces postgres_changes here, is explicitly so — meaning
    // an older payload for a row can arrive after a newer one and silently revert
    // it. `_rv` is the row's globally monotonic server stamp (public.jobs
    // .row_version, assigned by trigger; see the jobs_row_version migration), so
    // "is this actually newer?" is answerable locally. Anything not strictly
    // newer is dropped.
    //
    // The guard is NOT the delivery guarantee — a DROPPED message has no row to
    // compare against. The keyset cursor poll in store/sync.js is the
    // authoritative backstop; this only prevents reordering damage.
    case ACTIONS.PATCH_JOBS: {
      // The guard itself lives in the dependency-free jobsMerge core so it is
      // unit-testable from a plain node script (test-jobs-order-guard.mjs).
      // The delete memory is injected rather than imported by jobsMerge, which keeps
      // that core importless. It is a module singleton and deliberately NOT reducer
      // state: a `state.jobTombstones` key would ride toSharedBlob into the org_state
      // blob, defeat the flush content-guard, and fan a realtime signal PER DELETE.
      const r = applyJobPatch(state.jobs, action.upserts || [], action.deletes || [], jobTombstones);
      // Preserve state identity when nothing actually changed: a dropped stale
      // patch or a duplicate delete must not re-render every jobs consumer or
      // dirty the save path.
      if (!r.changed) return state;
      return { ...state, jobs: r.jobs };
    }

    case ACTIONS.SET_CURRENT_USER:
      return { ...state, currentUserId: action.id };
    case ACTIONS.SET_VIEW_AS:
      // Owner-only view-as perspective switch (UI only; the SERVER still enforces the
      // real JWT claim). Transient per-session — stripped from the shared blob
      // (tableSlices.toSharedBlob + offlineCache). null clears back to the owner's own view.
      return { ...state, viewAsUserId: action.id };

    // ---------- Company ----------
    case ACTIONS.UPDATE_COMPANY:
      return { ...state, company: { ...state.company, ...action.patch } };

    // ---------- Ops settings (org-wide clock/variance tunables) ----------
    // Additive, default-safe: readers (server clock-in geofence, auto-close cron,
    // variance thresholds/basis) already fall back to hard defaults when a key is
    // absent, so an un-backfilled live blob keeps working. Merge (never replace).
    case ACTIONS.UPDATE_OPS_SETTINGS:
      return { ...state, opsSettings: { ...(state.opsSettings || {}), ...action.patch } };

    // ---------- Payroll lines (bonus / reimbursement / tip / deduction) ----------
    // Additive, default-safe blob slice — readers default via selectPayrollLines →
    // EMPTY_ARRAY, so an old blob without the key is safe (no store-version bump).
    // A line is { id, userId, periodKey, kind, category, label, amount(signed $),
    // taxable, note, createdAt, createdBy }; deductions carry a negative amount.
    case ACTIONS.ADD_PAYROLL_LINE:
      // Replay-idempotent (F2): id minted at the dispatch site, so a conflict-replay of
      // the same action through sync.js adoptRemote is a no-op, not a duplicate line.
      if (action.line?.id && (state.payrollLines || []).some((l) => l.id === action.line.id)) return state;
      return { ...state, payrollLines: [...(state.payrollLines || []), { id: newId('pl'), createdAt: nowIso(), ...action.line }] };
    case ACTIONS.UPDATE_PAYROLL_LINE:
      return { ...state, payrollLines: replaceById(state.payrollLines || [], action.id, action.patch) };
    case ACTIONS.DELETE_PAYROLL_LINE:
      // A line that pays out an approved HR reimbursement is managed from HR (removing the
      // reimbursement there takes the line). Deleting it alone left the reimbursement
      // 'approved' but unpaid, with nothing flagging it.
      if (reimbursementForLine(state, action.id)) return state;
      return { ...state, payrollLines: removeById(state.payrollLines || [], action.id) };

    // ---------- HR: reimbursements + employee documents ----------
    // Additive, default-safe blob slices (readers default via selectors → EMPTY_ARRAY).
    // A reimbursement is { id, userId, amount, description, receiptFileId, receiptName,
    // status:'pending'|'approved'|'rejected', periodKey, submittedAt, submittedBy,
    // decidedBy, decidedAt, payrollLineId }; on approve the HR surface ALSO dispatches
    // ADD_PAYROLL_LINE (category 'reimbursement', taxable:false) and stores its id here.
    case ACTIONS.ADD_REIMBURSEMENT:
      // Replay-idempotent (F2): id minted at the dispatch site → conflict-replay is a no-op.
      if (action.reimbursement?.id && (state.reimbursements || []).some((r) => r.id === action.reimbursement.id)) return state;
      return { ...state, reimbursements: [...(state.reimbursements || []), { id: newId('rmb'), status: 'pending', submittedAt: nowIso(), ...action.reimbursement }] };
    case ACTIONS.UPDATE_REIMBURSEMENT:
      return { ...state, reimbursements: replaceById(state.reimbursements || [], action.id, action.patch) };
    case ACTIONS.DELETE_REIMBURSEMENT:
      // Takes the reimbursement's own pay line (payrollLineId) in the same write.
      return { ...state, ...removeReimbursement(state, action.id) };
    // Employee document METADATA only — { id, userId, name, mimeType, sizeBytes,
    // fileId (lib/hrFiles), uploadedAt, uploadedBy }. Bytes never ride the blob.
    case ACTIONS.ADD_EMPLOYEE_DOCUMENT:
      // Replay-idempotent (F2): id minted at the dispatch site → conflict-replay is a no-op.
      if (action.document?.id && (state.employeeDocuments || []).some((d) => d.id === action.document.id)) return state;
      return { ...state, employeeDocuments: [...(state.employeeDocuments || []), { id: newId('edoc'), uploadedAt: nowIso(), ...action.document }] };
    case ACTIONS.DELETE_EMPLOYEE_DOCUMENT:
      return { ...state, employeeDocuments: removeById(state.employeeDocuments || [], action.id) };

    // ---------- Services ----------
    case ACTIONS.ADD_SERVICE:
      return { ...state, services: [...state.services, { id: newId('svc'), defaultDurationMins: 60, ...action.service }] };
    case ACTIONS.UPDATE_SERVICE:
      return { ...state, services: replaceById(state.services, action.id, action.patch) };
    case ACTIONS.DELETE_SERVICE: {
      const id = action.id;
      return {
        ...state,
        services: removeById(state.services, id),
        clients: state.clients.map((c) => (c.serviceId === id ? { ...c, serviceId: null } : c)),
        jobs: state.jobs.map((j) => (j.serviceId === id ? { ...j, serviceId: null } : j)),
      };
    }

    case ACTIONS.ADD_FREQUENCY:
      return { ...state, frequencies: [...state.frequencies, { id: newId('frq'), ...action.frequency }] };
    case ACTIONS.UPDATE_FREQUENCY:
      return { ...state, frequencies: replaceById(state.frequencies, action.id, action.patch) };
    case ACTIONS.DELETE_FREQUENCY: {
      const id = action.id;
      return {
        ...state,
        frequencies: removeById(state.frequencies, id),
        clients: state.clients.map((c) => (c.frequencyId === id ? { ...c, frequencyId: null } : c)),
      };
    }

    // ---------- Users ----------
    case ACTIONS.ADD_USER: {
      // Seed notificationPrefs so a newly-invited user receives notifications the
      // moment they go active — without it, the fan-out gates (and the Account
      // toggles) would treat every event as un-set. Default-on, opt-out.
      const base = { id: newId('u'), status: 'invited', role: 'crew', createdAt: nowIso(), avatar: ((state.users.length % 5) + 1), initials: '', notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS } };
      const row = { ...base, ...action.user };
      // UPSERT BY ID, don't blind-append (crew audit F3). A re-invite from the
      // Settings → Team reconciliation banner, or a replayed dispatch, carries an id
      // that may already be present — appending would mint a SECOND roster row with the
      // same id (a duplicate that renders twice and confuses every by-id lookup). Replace
      // in place when the id exists (preserving the existing row's fields), else append.
      // This is also the prerequisite that lets a future server-side atomic roster write
      // coexist with this dispatch without duplicating.
      const idx = state.users.findIndex((u) => u.id === row.id);
      if (idx === -1) return { ...state, users: [...state.users, row] };
      const users = state.users.slice();
      users[idx] = { ...users[idx], ...action.user };
      return { ...state, users };
    }
    case ACTIONS.UPDATE_USER: {
      // Record WHEN a member is disabled. The pay run keeps a disabled member on every
      // period they were still employed in, and the delete guard treats a salaried
      // member's pay as owed until that period is paid out — a salaried member has no
      // punches to show either (lib/payroll payRunRoster, lib/deleteCascade.hasUnpaidSalary).
      const prev = state.users.find((u) => u.id === action.id);
      let patch = action.patch;
      if (prev && patch && 'status' in patch && patch.status !== prev.status) {
        if (patch.status === 'disabled') patch = { ...patch, disabledAt: nowIso() };
        else if (prev.status === 'disabled') patch = { ...patch, disabledAt: null };
      }
      return { ...state, users: replaceById(state.users, action.id, patch) };
    }
    case ACTIONS.UPDATE_NOTIFICATION_PREFS: {
      const { userId, patch } = action;
      // Crew notifications are MANDATORY: strip any event mute (value:false) so a
      // crew member can never turn an alert off — the write-point guard, since the
      // org_state blob is browser-writable and the UI lock alone is not a boundary.
      // Enables + channel prefs (device push) still pass. lib/roles is the policy.
      const target = state.users.find((u) => u.id === userId);
      const effective = applyMandatoryNotificationPolicy(target, patch);
      if (!effective || Object.keys(effective).length === 0) return state;
      return {
        ...state,
        users: state.users.map((u) =>
          u.id === userId
            ? { ...u, notificationPrefs: { ...(u.notificationPrefs || {}), ...effective } }
            : u
        ),
      };
    }
    case ACTIONS.UPDATE_SIGNATURE_PREFS: {
      const { userId, patch } = action;
      return {
        ...state,
        users: state.users.map((u) =>
          u.id === userId
            ? { ...u, signaturePrefs: { ...(u.signaturePrefs || {}), ...patch } }
            : u
        ),
      };
    }

    // ---------- Notifications inbox ----------
    case ACTIONS.REMOVE_NOTIFICATION: {
      // Per-row dismiss from the bell panel.
      const { id } = action;
      return {
        ...state,
        notifications: (state.notifications || []).filter((n) => n.id !== id),
      };
    }
    case ACTIONS.MARK_NOTIFICATION_READ: {
      const { id } = action;
      const stamp = nowIso();
      return {
        ...state,
        notifications: (state.notifications || []).map((n) =>
          n.id === id && !n.readAt ? { ...n, readAt: stamp } : n
        ),
      };
    }
    case ACTIONS.MARK_ALL_NOTIFICATIONS_READ: {
      const { userId } = action;
      const stamp = nowIso();
      return {
        ...state,
        notifications: (state.notifications || []).map((n) =>
          n.userId === userId && !n.readAt ? { ...n, readAt: stamp } : n
        ),
      };
    }
    case ACTIONS.CLEAR_NOTIFICATIONS: {
      const { userId } = action;
      return {
        ...state,
        notifications: (state.notifications || []).filter((n) => n.userId !== userId),
      };
    }
    case ACTIONS.DELETE_USER: {
      const id = action.id;
      // Safety invariant (DEL-05): never remove the last owner, or the org loses
      // every owner-only capability (settings.roles.edit, staff.assignRoles,
      // settings.company.timezone, OWNER_CORE) with no way to restore it. The Team UI
      // disables the control; this is the write-point backstop (a no-op if reached).
      if (isLastOwner(state.users, id)) return state;
      // Refuse while the user may still be owed pay (a line in this or the last pay
      // period, or a pending reimbursement): the pay run skips non-active users, so it
      // would silently vanish (audit DR-18/19; owner: block-delete). Settled history
      // never blocks. The Team page checks the same rule before deleting the login.
      if (hasUnsettledPay(state, id)) return state;
      const gone = state.users.find((u) => u.id === id) || null;
      const rosterAfter = { ...state, users: removeById(state.users, id) };
      return {
        ...state,
        users: removeById(state.users, id),
        userPermissionOverrides: (state.userPermissionOverrides || []).filter((o) => o.userId !== id),
        jobs: state.jobs.map((j) => {
          let nj = j;
          if ((j.crewIds || []).includes(id)) {
            // A visit whose one-off crew was just this person is regular again.
            nj = settleCrewMark(rosterAfter, { ...nj, crewIds: nj.crewIds.filter((u) => u !== id) });
          }
          // A cover naming the departed cleaner as the one being COVERED FOR is invisible
          // to the crew sweep above — the covered cleaner is by definition NOT on the
          // visit — so it needs its own scrub, or the cover fills a deleted cleaner's
          // checklist forever (anti-orphan, the `coverFor` twin of the crewChecklists
          // sweep in lib/deleteCascade.sweepUserOrphans).
          if (coverForNamesUser(nj.coverFor, id)) {
            nj = { ...nj, coverFor: removeUserFromCoverFor(nj.coverFor, id) };
          }
          // Also scrub the id from a master's per-day crew overrides — else every
          // future occurrence TOP_UP_RECURRING_SERIES materializes carries the dangling
          // (deleted) crew id, re-creating the "Unknown user" ghost this handler removes.
          const dov = nj.recurrence?.dayOverrides;
          if (dov && Object.values(dov).some((o) => Array.isArray(o?.crewIds) && o.crewIds.includes(id))) {
            const scrubbed = {};
            for (const [dow, o] of Object.entries(dov)) {
              scrubbed[dow] = Array.isArray(o?.crewIds) && o.crewIds.includes(id)
                ? { ...o, crewIds: o.crewIds.filter((u) => u !== id) } : o;
            }
            nj = { ...nj, recurrence: { ...nj.recurrence, dayOverrides: scrubbed } };
          }
          // ...and from its series-level crew (crewOverride), for the same reason.
          const co = nj.recurrence?.crewOverride;
          if (Array.isArray(co) && co.includes(id)) {
            nj = { ...nj, recurrence: { ...nj.recurrence, crewOverride: co.filter((u) => u !== id) } };
          }
          return nj;
        }),
        // A key in the departed user's hands stays 'out' but keeps WHO has it:
        // demote the link to the denormalized name (holder display falls back to
        // heldByName), instead of a dangling id that renders "Unknown user" at
        // exactly the moment an admin is chasing the physical key.
        keys: (state.keys || []).map((k) => (
          k.heldByUserId === id ? { ...k, heldByUserId: null, heldByName: k.heldByName || gone?.name || null } : k
        )),
        // A thread ALWAYS outlives its creator — nothing here deletes a conversation.
        // The creator link is demoted to a denormalized name (same move as the keys
        // block above): without it the thread reads as authored by nobody, and a
        // Super Admin cleaning up orphans in OrphanedThreadsModal has no way to tell
        // whose thread they're about to destroy.
        conversations: state.conversations.map((cv) => {
          const next = { ...cv };
          if (next.createdByUserId === id) {
            next.createdByUserId = null;
            next.createdByName = next.createdByName || gone?.name || null;
          }
          if ((next.mutedByUserIds || []).includes(id)) next.mutedByUserIds = next.mutedByUserIds.filter((u) => u !== id);
          if ((next.participantUserIds || []).includes(id)) next.participantUserIds = next.participantUserIds.filter((u) => u !== id);
          // Read-receipt + star lists are membership sets too — scrub the departed user
          // so they don't ride as dangling ids (DR-01 readByUserIds / DR-02 starred).
          if ((next.starredByUserIds || []).includes(id)) next.starredByUserIds = next.starredByUserIds.filter((u) => u !== id);
          return next;
        }),
        // Same demotion for message authorship, so a departed teammate's messages
        // keep their byline instead of rendering as anonymous text in the thread; and
        // scrub the id from every message's read-receipt list (DR-01).
        messages: state.messages.map((m) => {
          let nm = m;
          if (nm.authorUserId === id) nm = { ...nm, authorUserId: null, authorName: nm.authorName || gone?.name || null };
          if ((nm.readByUserIds || []).includes(id)) nm = { ...nm, readByUserIds: nm.readByUserIds.filter((u) => u !== id) };
          return nm;
        }),
        contactActivities: (state.contactActivities || []).map((a) => (a.authorUserId === id ? { ...a, authorUserId: null, authorName: a.authorName || gone?.name || null } : a)),
        // Key custody events are a legal trail — demote the actor + holder links to their
        // denormalized name (like the keys block above) so the trail survives the delete
        // instead of rendering blank (audit DR-25/26; owner: preserve the name).
        keyEvents: (state.keyEvents || []).map((e) => {
          let ne = e;
          if (ne.byUserId === id) ne = { ...ne, byUserId: null, byName: ne.byName || gone?.name || null };
          if (ne.holderUserId === id) ne = { ...ne, holderUserId: null, holderName: ne.holderName || gone?.name || null };
          return ne;
        }),
        // Drop the departed user's bell rows — they're unreachable once the user
        // is gone (CLEAR is self-scoped from the bell) and would otherwise ride
        // in the shared blob forever as dead weight on every load/save/sync.
        notifications: (state.notifications || []).filter((n) => n.userId !== id),
        // The ~14 other user-referencing slices the store grew after this handler was
        // written (clients supervisor/crewChecklists, marketing/supply authorship, HR,
        // invitations, activities) — swept here so a delete leaves zero orphans (audit
        // DR-03/04/06/07/08/09/10/12/13/14/15/16/17/20). Decision-gated slices excluded.
        // The name rides along so every record that outlives the person keeps it.
        ...sweepUserOrphans(state, id, gone?.name || null),
      };
    }

    // ---------- Clients ----------
    case ACTIONS.ADD_CLIENT: {
      // Contact # (friendly sequential id): next after the current max, or 1001
      // on a fresh book. Honored if the caller supplied one (spread below).
      const nums = (state.clients || []).map((c) => Number(c.contactNumber)).filter(Number.isFinite);
      const base = {
        id: newId('cl'),
        // Type is the one manual flag: Customer (default) or Vendor. Status
        // (Lead/Active) is derived, never stored (see selectClientStatus).
        type: 'customer',
        contactNumber: (nums.length ? Math.max(...nums) : 1000) + 1,
        // Default service so a new account (and its jobs) always resolves a catalog
        // service, keeping the variance expected-time fallback airtight (see
        // selectEffectiveExpectedCleanMins). Editable on the account page; a
        // caller-supplied serviceId still wins (spread below).
        serviceId: (state.services || [])[0]?.id || null,
        revenue: 0, notes: '', tagIds: [],
        // Account-level structured address (the manual add + display use these).
        street: '', city: '', state: '', zip: '',
        // Customer-level billing settings (Overview → Billing information).
        ...CLIENT_BILLING_DEFAULTS,
        createdAt: nowIso(), updatedAt: nowIso(), lastServiceAt: null, primaryContactId: null,
      };
      const client = { ...base, ...action.client };
      // Adopt orphan keys: unlinked keys (clientId null — free-typed or imported)
      // whose company label matches the new account's name become linked, so a
      // late-created account picks up its keys without a manual backfill.
      const cname = (client.name || '').trim().toLowerCase();
      const keys = cname
        ? (state.keys || []).map((k) => (
          !k.clientId && (k.clientName || '').trim().toLowerCase() === cname
            ? { ...k, clientId: client.id, clientName: client.name }
            : k))
        : (state.keys || []);
      // Every customer has exactly one location (a `site`), created with the account
      // from its address. A vendor gets none. Deterministic id (buildClientLocation)
      // so a sync-replay can't mint a second location for the same customer.
      const sites = clientGetsLocation(client) && !(state.sites || []).some((s) => s.clientId === client.id)
        ? [...(state.sites || []), buildClientLocation(client, state.services)]
        : (state.sites || []);
      return { ...state, clients: [...state.clients, client], keys, sites };
    }
    case ACTIONS.UPDATE_CLIENT: {
      const prevClient = state.clients.find((c) => c.id === action.id);
      const next = { ...state, clients: replaceById(state.clients, action.id, action.patch) };
      // Rename cascade: keys carry a denormalized clientName (the Keys page groups
      // by it, and crew name-fallback matches on it) — keep it in sync so a renamed
      // account's keys don't file under the stale old header.
      if (typeof action.patch?.name === 'string' && action.patch.name.trim()) {
        next.keys = (state.keys || []).map((k) => (
          k.clientId === action.id && k.clientName !== action.patch.name
            ? { ...k, clientName: action.patch.name }
            : k));
      }
      // accountOpsUpdated fan-out when an ops field changes via the generic
      // client update (Team → member "assign to accounts" + the invite step both
      // patch standingCrewIds this way, bypassing the Operations tab's
      // UPDATE_CLIENT_OPS). Non-ops edits (name/contact/status/service/tags) skip.
      if (opsFieldsChanged(CLIENT_OPS_FIELDS, prevClient, action.patch)) {
        const actor = (state.users || []).find((u) => u.id === state.currentUserId);
        next.notifications = fanOutOpsNotification(next, {
          clientId: action.id,
          actorName: actor?.name,
          summary: 'Account operations were updated.',
        });
      }
      return next;
    }
    case ACTIONS.DELETE_CLIENT: {
      // Cascade-delete: a client takes its contacts, sites, jobs, invoices, and activities with it.
      // Conversations attached to deleted contacts have their contactId/clientId nulled (the message
      // history is preserved as "Unlinked" — only the entity rows are gone).
      const id = action.id;
      const contactsToDelete = new Set(
        (state.contacts || []).filter((c) => c.companyId === id).map((c) => c.id)
      );
      // Cascade marketing rows for the deleted contacts (SYNC-02): drop their
      // enrollments, sends, and replies so nothing orphans (and no deleted-contact
      // email/body lingers in marketingReplies).
      const delClientEnrollmentIds = new Set(
        (state.marketingEnrollments || []).filter((e) => contactsToDelete.has(e.contactId)).map((e) => e.id)
      );
      // This handler filters the client's jobs out DIRECTLY (not via DELETE_JOB), so it
      // must apply the same store scrubs DELETE_JOB does — otherwise dead /schedule/{id}
      // bell links and reminderEvents survive for jobs that no longer exist.
      const delClientJobIds = new Set((state.jobs || []).filter((j) => j.clientId === id).map((j) => j.id));
      const delClientJobUrls = new Set([...delClientJobIds].map((jid) => `/schedule/${jid}`));
      // The account's own deep-link (DR-24): the job urls above miss /clients/{id}, so a
      // bell row pointing at the deleted account survived its own cascade.
      const delClientUrl = `/clients/${id}`;
      return {
        ...state,
        clients: (state.clients || []).filter((c) => c.id !== id),
        contacts: (state.contacts || []).filter((c) => !contactsToDelete.has(c.id)),
        sites: (state.sites || []).filter((s) => s.clientId !== id),
        jobs: (state.jobs || []).filter((j) => j.clientId !== id),
        reminderEvents: (state.reminderEvents || []).filter((e) => !delClientJobIds.has(e.jobId)),
        notifications: (state.notifications || []).filter((n) => !delClientJobUrls.has(n.url) && n.url !== delClientUrl),
        invoices: (state.invoices || []).filter((inv) => inv.clientId !== id),
        opportunities: (state.opportunities || []).filter((o) => o.clientId !== id),
        clientActivities: (state.clientActivities || []).filter((a) => a.clientId !== id),
        contactActivities: (state.contactActivities || []).filter((a) => !contactsToDelete.has(a.contactId)),
        marketingEnrollments: (state.marketingEnrollments || []).filter((e) => !contactsToDelete.has(e.contactId)),
        marketingSends: (state.marketingSends || []).filter((sd) => !delClientEnrollmentIds.has(sd.enrollmentId) && !contactsToDelete.has(sd.contactId)),
        marketingReplies: (state.marketingReplies || []).filter((r) => !contactsToDelete.has(r.contactId) && !delClientEnrollmentIds.has(r.enrollmentId)),
        conversations: (state.conversations || []).map((cv) => {
          const next = { ...cv };
          if (contactsToDelete.has(cv.contactId)) next.contactId = null;
          if (cv.clientId === id) next.clientId = null;
          return next;
        }),
        // Keys survive account deletion (physical objects), but the link must be
        // NULLED, not left dangling: a dead clientId short-circuits the crew scope
        // check (keyInScope skips the name fallback when clientId is set), making
        // the key invisible to every crew member forever. Keeping clientName
        // preserves the Keys-page grouping + name-fallback matching.
        keys: (state.keys || []).map((k) => (k.clientId === id ? { ...k, clientId: null, siteId: null } : k)),
        // Sweep the client-scoped slices that carry clientId but are NOT entity rows the
        // block above removes: supply items/requests (Supplies, S58) + ops-alert events.
        // They were never cascaded, so a deleted account left them orphaned on the blob
        // keyed to a clientId nothing resolves (LW-01, live wiring audit 2026-09-20).
        ...sweepClientOrphans(state, id, delClientJobIds),
      };
    }
    case ACTIONS.APPEND_CLIENT_NOTE: {
      const now = nowIso();
      const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const authorUserId = action.authorUserId || state.currentUserId;
      const activity = {
        id: newId('clact'),
        clientId: action.id,
        kind: 'note',
        authorUserId,
        body: action.text,
        attachment: action.attachment || null,
        occurredAt: now,
        createdAt: now,
      };
      return {
        ...state,
        clients: state.clients.map((c) => {
          if (c.id !== action.id) return c;
          const bodyLine = action.text || (action.attachment ? `📎 ${action.attachment.name}` : '');
          const entry = `[${stamp}] ${action.author ? action.author + ': ' : ''}${bodyLine}`;
          const next = c.notes ? `${entry}\n\n${c.notes}` : entry;
          return { ...c, notes: next };
        }),
        clientActivities: [...(state.clientActivities || []), activity],
      };
    }
    case ACTIONS.ADD_CLIENT_ACTIVITY: {
      const base = { id: newId('clact'), occurredAt: nowIso(), createdAt: nowIso(), authorUserId: state.currentUserId };
      return { ...state, clientActivities: [...(state.clientActivities || []), { ...base, ...action.activity }] };
    }
    case ACTIONS.UPDATE_CLIENT_ACTIVITY: {
      return {
        ...state,
        clientActivities: (state.clientActivities || []).map((a) =>
          a.id === action.id ? { ...a, ...action.patch } : a
        ),
      };
    }
    case ACTIONS.DELETE_CLIENT_ACTIVITY: {
      return {
        ...state,
        clientActivities: (state.clientActivities || []).filter((a) => a.id !== action.id),
      };
    }

    // ---------- Contacts ----------
    case ACTIONS.ADD_CONTACT: {
      const email = (action.contact?.email || '').trim().toLowerCase();
      // Email-keyed uniqueness guard only runs when an email is provided.
      // Email-less contacts (phone-only / name-only) are accepted by design — see CSV import flow.
      if (email) {
        const exists = (state.contacts || []).some((c) => (c.email || '').toLowerCase() === email);
        if (exists) return state;
      }
      const base = {
        id: newId('ct'),
        email: '',
        firstName: '', lastName: '', title: '', phone: '',
        companyId: null,
        tagIds: [],
        lifecycle: 'lead',
        notes: '', customFields: {},
        createdAt: nowIso(), updatedAt: nowIso(),
      };
      const contact = { ...base, ...action.contact, email };
      // People are never placed on a pipeline. Deals are company-owned
      // Opportunities (ADD_OPPORTUNITY), so there is no auto-placement here.
      // First person attached to a company becomes its primary contact —
      // without this, auto-created companies sit with no visible person.
      let clients = state.clients;
      if (contact.companyId) {
        clients = (state.clients || []).map((cl) =>
          cl.id === contact.companyId && !cl.primaryContactId ? { ...cl, primaryContactId: contact.id } : cl
        );
      }
      return {
        ...state,
        clients,
        contacts: [...(state.contacts || []), contact],
      };
    }
    case ACTIONS.UPDATE_CONTACT: {
      const patch = { ...action.patch, updatedAt: nowIso() };
      if (patch.email) {
        const lower = patch.email.trim().toLowerCase();
        const dup = (state.contacts || []).some((c) => c.id !== action.id && (c.email || '').toLowerCase() === lower);
        if (dup) return state; // email must stay unique
        patch.email = lower;
      }
      // Company side effect: a company with no primary contact adopts this one.
      // (No status promotion: customer status is derived from real work, not from
      // a contact's lifecycle. See selectClientStatus.)
      const prev = (state.contacts || []).find((c) => c.id === action.id);
      const companyId = patch.companyId !== undefined ? patch.companyId : prev?.companyId;
      let clients = state.clients;
      if (companyId) {
        clients = (state.clients || []).map((cl) =>
          cl.id === companyId && !cl.primaryContactId ? { ...cl, primaryContactId: action.id } : cl
        );
      }
      return { ...state, clients, contacts: replaceById(state.contacts || [], action.id, patch) };
    }
    case ACTIONS.DELETE_CONTACT: {
      // Remove the contact + unwire any FK references so the app doesn't render dangling ids.
      const id = action.id;
      // Cascade marketing rows (SYNC-02): drop this contact's enrollments, sends,
      // and replies so nothing orphans (and no deleted-contact email/body lingers).
      const delContactEnrollmentIds = new Set(
        (state.marketingEnrollments || []).filter((e) => e.contactId === id).map((e) => e.id)
      );
      return {
        ...state,
        contacts: (state.contacts || []).filter((c) => c.id !== id),
        // Unwire the company-level role FKs (primary + billing). The Site role lives
        // on the location record, cleaned by the `sites` map below.
        clients: state.clients.map((cl) => (
          (cl.primaryContactId === id || cl.billingContactId === id)
            ? {
                ...cl,
                primaryContactId: cl.primaryContactId === id ? null : cl.primaryContactId,
                billingContactId: cl.billingContactId === id ? null : cl.billingContactId,
              }
            : cl
        )),
        invoices: state.invoices.map((inv) => (inv.billingContactId === id ? { ...inv, billingContactId: null } : inv)),
        sites: state.sites.map((st) => (st.siteContactId === id ? { ...st, siteContactId: null } : st)),
        opportunities: (state.opportunities || []).map((o) => (o.primaryContactId === id ? { ...o, primaryContactId: null } : o)),
        conversations: state.conversations.map((cv) => (cv.contactId === id ? { ...cv, contactId: null } : cv)),
        contactActivities: (state.contactActivities || []).filter((a) => a.contactId !== id),
        marketingEnrollments: (state.marketingEnrollments || []).filter((e) => e.contactId !== id),
        marketingSends: (state.marketingSends || []).filter((sd) => sd.contactId !== id && !delContactEnrollmentIds.has(sd.enrollmentId)),
        marketingReplies: (state.marketingReplies || []).filter((r) => r.contactId !== id && !delContactEnrollmentIds.has(r.enrollmentId)),
      };
    }
    case ACTIONS.TAG_CONTACT:
      return {
        ...state,
        contacts: (state.contacts || []).map((c) => {
          if (c.id !== action.id) return c;
          const tagIds = c.tagIds || [];
          if (tagIds.includes(action.tagId)) return c;
          return { ...c, tagIds: [...tagIds, action.tagId], updatedAt: nowIso() };
        }),
      };
    case ACTIONS.UNTAG_CONTACT:
      return {
        ...state,
        contacts: (state.contacts || []).map((c) => {
          if (c.id !== action.id) return c;
          return { ...c, tagIds: (c.tagIds || []).filter((t) => t !== action.tagId), updatedAt: nowIso() };
        }),
      };
    // Company (account) tags. People are grouped under a company, so tags live
    // here; a contact's "effective tags" are its company's (see selectors).
    case ACTIONS.TAG_CLIENT:
      return {
        ...state,
        clients: (state.clients || []).map((cl) => {
          if (cl.id !== action.id) return cl;
          const tagIds = cl.tagIds || [];
          if (tagIds.includes(action.tagId)) return cl;
          return { ...cl, tagIds: [...tagIds, action.tagId], updatedAt: nowIso() };
        }),
      };
    case ACTIONS.UNTAG_CLIENT:
      return {
        ...state,
        clients: (state.clients || []).map((cl) => {
          if (cl.id !== action.id) return cl;
          return { ...cl, tagIds: (cl.tagIds || []).filter((t) => t !== action.tagId), updatedAt: nowIso() };
        }),
      };
    // ── Opportunities (company-owned deals; the cards on the pipeline board) ────
    case ACTIONS.ADD_OPPORTUNITY: {
      // Replay-idempotent (F2): id minted at the dispatch site → conflict-replay is a no-op.
      if (action.opportunity?.id && (state.opportunities || []).some((o) => o.id === action.opportunity.id)) return state;
      const now = nowIso();
      const base = {
        id: newId('opp'),
        clientId: null, primaryContactId: null, title: '',
        value: null, expectedCloseDate: null,
        pipelineId: state.activePipelineId, stage: null,
        status: 'open', ownerUserId: null, notes: '',
        stageChangedAt: now, createdAt: now, updatedAt: now,
      };
      const opp = { ...base, ...action.opportunity };
      // Default the primary contact from the owning company when not supplied.
      if (!opp.primaryContactId && opp.clientId) {
        const cl = (state.clients || []).find((c) => c.id === opp.clientId);
        if (cl?.primaryContactId) opp.primaryContactId = cl.primaryContactId;
      }
      return { ...state, opportunities: [...(state.opportunities || []), opp] };
    }
    case ACTIONS.UPDATE_OPPORTUNITY: {
      const patch = { ...action.patch, updatedAt: nowIso() };
      return { ...state, opportunities: replaceById(state.opportunities || [], action.id, patch) };
    }
    case ACTIONS.DELETE_OPPORTUNITY:
      return { ...state, opportunities: (state.opportunities || []).filter((o) => o.id !== action.id) };
    case ACTIONS.SET_OPPORTUNITY_STAGE: {
      const now = nowIso();
      const all = state.opportunities || [];
      const prev = all.find((o) => o.id === action.id);
      if (!prev) return state;
      const stageChanged = prev.stage !== action.stage;
      const pipelineId = action.pipelineId || prev.pipelineId || state.activePipelineId;
      // Anti-vanish guard: only place on a stage that exists on the pipeline.
      if (action.stage && !stageExistsOnPipeline((state.pipelines || []).find((p) => p.id === pipelineId), action.stage)) {
        return state;
      }
      // Won/Lost are terminal stages that ALSO set an explicit status (decoupled
      // from the stage key): 'won' makes the owning company Active (see
      // selectClientStatus), 'lost' closes it out, anything else is 'open'. A pure
      // same-stage reorder keeps the status.
      const status = !stageChanged ? prev.status
        : action.stage === 'won' ? 'won'
          : action.stage === 'lost' ? 'lost'
            : 'open';
      const patched = {
        ...prev,
        stage: action.stage,
        pipelineId: action.stage ? pipelineId : null,
        status,
        stageChangedAt: stageChanged ? now : prev.stageChangedAt,
        updatedAt: now,
      };
      const without = all.filter((o) => o.id !== action.id);
      let next;
      if (action.insertBeforeId) {
        const i = without.findIndex((o) => o.id === action.insertBeforeId);
        next = i >= 0 ? [...without.slice(0, i), patched, ...without.slice(i)] : [...without, patched];
      } else {
        let lastIdx = -1;
        for (let i = 0; i < without.length; i++) if (without[i].stage === action.stage) lastIdx = i;
        next = lastIdx >= 0 ? [...without.slice(0, lastIdx + 1), patched, ...without.slice(lastIdx + 1)] : [...without, patched];
      }
      // Log the move on the owning COMPANY's timeline (deals belong to companies).
      const activity = stageChanged && prev.clientId ? [{
        id: newId('clact'),
        clientId: prev.clientId,
        kind: 'stage_change',
        authorUserId: action.authorUserId || state.currentUserId,
        body: `Deal stage: ${prev.stage || 'none'} -> ${action.stage}`,
        occurredAt: now,
        createdAt: now,
      }] : [];
      return {
        ...state,
        opportunities: next,
        clientActivities: [...(state.clientActivities || []), ...activity],
      };
    }

    case ACTIONS.APPEND_CONTACT_NOTE: {
      const now = nowIso();
      const authorUserId = action.authorUserId || state.currentUserId;
      const author = state.users.find((u) => u.id === authorUserId);
      const authorName = author?.name || 'Someone';
      const activity = {
        id: newId('act'),
        contactId: action.id,
        kind: 'note',
        authorUserId,
        body: action.text,
        occurredAt: now,
      };
      return {
        ...state,
        contacts: (state.contacts || []).map((c) => {
          if (c.id !== action.id) return c;
          const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
          const entry = `[${stamp}] ${authorName}: ${action.text}`;
          const next = c.notes ? `${entry}\n\n${c.notes}` : entry;
          return { ...c, notes: next, updatedAt: now };
        }),
        contactActivities: [...(state.contactActivities || []), activity],
      };
    }

    // ---------- Tags ----------
    case ACTIONS.ADD_TAG: {
      const base = { id: newId('tg'), color: 'slate', scope: 'contact' };
      return { ...state, tags: [...(state.tags || []), { ...base, ...action.tag }] };
    }
    case ACTIONS.UPDATE_TAG:
      return { ...state, tags: replaceById(state.tags || [], action.id, action.patch) };
    case ACTIONS.DELETE_TAG: {
      // Scrub the dead tag id from EVERY slice that can hold one — not just contacts.
      // Jobs + sites reference tag ids too (JobDetail's tag chips, the schedule tag
      // filter); leaving them dangling keeps a deleted tag id living in jobs.tagIds /
      // sites.tagIds / clients.tagIds forever. Marketing sequences hold tag ids in
      // replyTags — scrubbed via scrubTagFromSequences so the next inbound reply can't
      // re-apply a deleted tag to a contact (LW-02, live wiring audit 2026-09-20).
      const tid = action.id;
      const dropTag = (ids) => (ids || []).filter((x) => x !== tid);
      return {
        ...state,
        tags: (state.tags || []).filter((t) => t.id !== tid),
        contacts: (state.contacts || []).map((c) => ((c.tagIds || []).includes(tid) ? { ...c, tagIds: dropTag(c.tagIds) } : c)),
        clients: (state.clients || []).map((c) => ((c.tagIds || []).includes(tid) ? { ...c, tagIds: dropTag(c.tagIds) } : c)),
        jobs: (state.jobs || []).map((j) => ((j.tagIds || []).includes(tid) ? { ...j, tagIds: dropTag(j.tagIds) } : j)),
        sites: (state.sites || []).map((s) => ((s.tagIds || []).includes(tid) ? { ...s, tagIds: dropTag(s.tagIds) } : s)),
        marketingSequences: scrubTagFromSequences(state.marketingSequences, tid),
      };
    }

    // ---------- Contact activities ----------
    case ACTIONS.ADD_CONTACT_ACTIVITY: {
      const base = { id: newId('act'), occurredAt: nowIso(), createdAt: nowIso(), authorUserId: state.currentUserId };
      return { ...state, contactActivities: [...(state.contactActivities || []), { ...base, ...action.activity }] };
    }
    case ACTIONS.UPDATE_CONTACT_ACTIVITY: {
      return {
        ...state,
        contactActivities: (state.contactActivities || []).map((a) =>
          a.id === action.id ? { ...a, ...action.patch } : a
        ),
      };
    }
    case ACTIONS.DELETE_CONTACT_ACTIVITY: {
      return {
        ...state,
        contactActivities: (state.contactActivities || []).filter((a) => a.id !== action.id),
      };
    }

    // ---------- Per-user permission overrides ----------
    case ACTIONS.SET_USER_PERMISSION_OVERRIDE: {
      const { userId, grants = [], revokes = [] } = action;
      const existing = (state.userPermissionOverrides || []).find((o) => o.userId === userId);
      const isEmpty = grants.length === 0 && revokes.length === 0;
      let next = state.userPermissionOverrides || [];
      if (isEmpty) {
        next = next.filter((o) => o.userId !== userId);
      } else if (existing) {
        next = next.map((o) => (o.userId === userId ? { userId, grants, revokes } : o));
      } else {
        next = [...next, { userId, grants, revokes }];
      }
      return { ...state, userPermissionOverrides: next };
    }

    // ---------- Location (one per customer; created + removed with the customer) ----------
    case ACTIONS.UPDATE_SITE: {
      const prevSite = state.sites.find((s) => s.id === action.id);
      const next = { ...state, sites: replaceById(state.sites, action.id, action.patch) };
      // Rename cascade: keys denormalize siteName for display — keep it in sync.
      if (typeof action.patch?.name === 'string' && action.patch.name.trim()) {
        next.keys = (state.keys || []).map((k) => (
          k.siteId === action.id && k.siteName !== action.patch.name
            ? { ...k, siteName: action.patch.name }
            : k));
      }
      // accountOpsUpdated fan-out for per-site ops changes (access notes,
      // cleaning areas, site standing crew, door/alarm codes in stub mode) —
      // the site editor + SecurityCard used to save these silently.
      const cid = prevSite?.clientId || action.patch?.clientId || null;
      if (cid && opsFieldsChanged(SITE_OPS_FIELDS, prevSite, action.patch)) {
        const actor = (state.users || []).find((u) => u.id === state.currentUserId);
        next.notifications = fanOutOpsNotification(next, {
          clientId: cid,
          actorName: actor?.name,
          summary: `${prevSite?.name ? `${prevSite.name}. ` : ''}site details were updated.`,
        });
      }
      return next;
    }
    // ---------- Jobs ----------
    case ACTIONS.UPDATE_CLIENT_OPS: {
      const prevClient = (state.clients || []).find((c) => c.id === action.id);
      const clients = state.clients.map((c) => (c.id === action.id
        ? { ...c, ...action.patch, opsUpdatedAt: nowIso() }
        : c));
      const next = { ...state, clients };
      // A supervisor (SPOC) reassignment is internal, not a crew-facing ops change, so it
      // must not ping the account's crew (NOTIF-05). opsPatchTouchesCrew value-diffs the
      // non-supervisor fields (ServiceSetupCard resends the whole form).
      if (opsPatchTouchesCrew(prevClient, action.patch)) {
        next.notifications = fanOutOpsNotification(next, {
          clientId: action.id,
          actorName: action.actorName,
          summary: action.summary,
        });
      }
      return next;
    }
    case ACTIONS.SCRUB_CHECKLIST_TEMPLATE: {
      // A checklist template was hard-deleted → clear it from every client's default +
      // per-cleaner bindings so nothing points at a template that no longer exists.
      return { ...state, clients: removeTemplateFromClients(state.clients, action.templateId) };
    }
    case ACTIONS.ADD_JOB: {
      // REPLAY IDEMPOTENCE (2026-07-30): every UI action is recorded to the
      // pending queue and re-dispatched by adoptRemote whenever a peer's blob
      // write lands inside the save window. Creates minted their ids IN the
      // reducer, so each replay minted a fresh row — the Holistique ×5 /
      // Harnish ×8 duplicate-series incident. Ids now arrive ON the action
      // (dispatch-time mint); a second apply of the same action is a no-op.
      // The newId fallback keeps old queued actions and tests working.
      if (action.job?.id && state.jobs.some((j) => j.id === action.job.id)) return state;
      const base = { id: newId('j'), status: 'upcoming', crewIds: [], tagIds: [], shiftId: null, notes: '', seriesId: null, recurrence: null, createdAt: nowIso() };
      let job = { ...base, ...action.job };
      // Phase 1 invariant: a clean must name a specific site. The UI blocks this at
      // save; this is the write-point backstop so a siteless clean can't exist.
      if (!job.siteId) return state;
      // The create spreads action.job VERBATIM, so a cover arriving on it — a stale draft,
      // a replay, a forged action — is sanitized here like every other write point (R8).
      if (job.coverFor) {
        const cover = normalizeCoverFor(job.coverFor, job.crewIds, regularCrewFor(state, job));
        job = cover ? { ...job, coverFor: cover } : (() => { const { coverFor, ...rest } = job; void coverFor; return rest; })();
      }
      const next = { ...state, jobs: [...state.jobs, job] };
      next.notifications = fanOutJobNotification(next, { job, eventKey: 'jobCreatedOrRescheduled' });
      return next;
    }
    // ── Time off ────────────────────────────────────────────────────────────
    case ACTIONS.ADD_TIME_OFF: {
      // Replay-idempotent by id (same law as ADD_JOB): the id arrives on the
      // action, so a conflict-replay of the same entry is a no-op.
      const entry = action.entry || {};
      if (!entry.id || !entry.userId || !entry.startDate || !entry.endDate) return state;
      if ((state.timeOff || []).some((t) => t.id === entry.id)) return state;
      // kind (call-out vs planned) + scheduledJobIds (the cleans the booking covered) are
      // sanitized at the write point; see store/timeOffRules.js.
      const { kind, scheduledJobIds, ...rest } = entry;
      const cleanKind = normalizeTimeOffKind(kind);
      const cleanJobs = normalizeJobIds(scheduledJobIds);
      return {
        ...state,
        timeOff: [...(state.timeOff || []), {
          reason: '', ...rest,
          ...(cleanKind ? { kind: cleanKind } : {}),
          ...(cleanJobs ? { scheduledJobIds: cleanJobs } : {}),
          createdAt: entry.createdAt || nowIso(),
        }],
      };
    }
    case ACTIONS.DELETE_TIME_OFF: {
      const list = state.timeOff || [];
      const next = list.filter((t) => t.id !== action.id);
      return next.length === list.length ? state : { ...state, timeOff: next };
    }
    case ACTIONS.APPLY_TIME_OFF_EXCLUSIONS: {
      // Bulk companion to ADD_TIME_OFF: take the person off every already-
      // materialized FUTURE clean in the range by removing them from crewIds. Set-
      // semantics make a replay a no-op, and past/done cleans are never touched.
      const { userId, startDate, endDate } = action;
      if (!userId || !startDate || !endDate) return state;
      const nowMs = Date.now();
      let changed = false;
      const jobs = (state.jobs || []).map((j) => {
        // Recurrence-bearing rows are the SERIES TEMPLATE — touching their crew
        // silently rewrites every future mint (see applyTimeOffToOccurrence).
        if (j.recurrence) return j;
        if (!j.startAt || new Date(j.startAt).getTime() <= nowMs) return j;
        if (j.status === 'done' || j.status === 'cancelled') return j;
        const d = dayKey(j.startAt);
        if (!d || d < startDate || d > endDate) return j;
        if (!isUserJobCrew(j, userId)) return j;
        changed = true;
        return settleCrewMark(state, { ...j, crewIds: j.crewIds.filter((id) => id !== userId) });
      });
      return changed ? { ...state, jobs } : state;
    }

    case ACTIONS.ADD_JOB_SERIES: {
      // Same replay-idempotence law as ADD_JOB: the seriesId arrives on the
      // action; a series that already exists means this is a replay — no-op.
      const seriesId = action.seriesId || newId('ser');
      if (state.jobs.some((j) => j.seriesId === seriesId)) return state;
      const ts = nowIso();
      const draft = { id: newId('j'), status: 'upcoming', crewIds: [], tagIds: [], shiftId: null, notes: '', ...action.baseJob, seriesId, recurrence: action.recurrence, createdAt: ts };
      // 🔴 The series TEMPLATE is written down at creation (2026-09-23): its crew, times and
      // weekday go into the recurrence (crewOverride / timeOverride / daysOfWeek), so the
      // master's OWN visit is just a visit: a one-off edit of it, or deleting it, can never
      // change what every future visit gets (before, a cover on a series' first visit became
      // every later visit's crew). Only HERE, where the values are known to be the regular
      // ones: pinning later, at a single edit or a re-home, froze whatever a pre-existing
      // series already had wrong (adversarial review), so older series keep the old rules.
      const master = { ...draft, recurrence: pinTemplateDefaults(action.recurrence, draft) };
      // Phase 1 invariant: a clean must name a specific site (write-point backstop).
      if (!master.siteId) return state;
      // `until` widens the never-horizon so a series STARTING beyond the rolling
      // 90-day edge still materializes its first quarter (without it, a far-
      // future start produced exactly ONE row — the master — and the calendar
      // looked empty after "Recurring job scheduled", 2026-07-30 report).
      const instances = expandRecurrence({
        startAt: master.startAt, endAt: master.endAt, recurrence: master.recurrence,
        until: new Date(master.startAt).getTime() + HORIZON_DAYS * 86400000,
      });
      const children = instances.map((inst) => applyTimeOffToOccurrence(state, {
        ...master, ...inst, id: newId('j'),
        // Per-day crew (schedule blocks): each occurrence resolves its own day's crew.
        crewIds: crewForOccurrence(master.recurrence, inst.startAt, master.crewIds),
        recurrence: null, createdAt: ts,
      }));
      // Time off is consulted at mint time (Sept 1): an occurrence landing on a
      // day someone is off drops them from that day only — the series keeps them.
      // The MASTER is deliberately untouched: it is the series template every
      // future mint derives from (applyTimeOffToOccurrence refuses recurrence-
      // bearing rows for the same reason); its own day relies on the conflict
      // warnings, which is honest — the person is genuinely still assigned there.
      const next = { ...state, jobs: [...state.jobs, master, ...children] };
      // Notify the crew of every occurrence, unioned, ONCE for the series — so a
      // cleaner who only covers some days still hears about it.
      const recipientIds = new Set();
      for (const j of [master, ...children]) for (const id of resolveJobCrewIds(j)) recipientIds.add(id);
      next.notifications = fanOutJobNotification(next, { job: master, eventKey: 'jobCreatedOrRescheduled', recipients: [...recipientIds] });
      return next;
    }
    // Keep never-ending series perpetual: extend each one's tail up to the rolling
    // horizon. Idempotent — only appends occurrences beyond the latest existing one
    // (so a deleted mid-series occurrence is never resurrected), and returns the
    // same state when nothing is due so it can run on every Schedule mount.
    case ACTIONS.TOP_UP_RECURRING_SERIES: {
      const now = Date.now();
      // Optional extend-on-navigate target: materialize 'never' series through this
      // instant instead of only the default rolling horizon. Dispatched by Schedule
      // when the calendar cursor moves past what's materialized — expandRecurrence's
      // `until` can only WIDEN the window, never narrow it.
      const untilMs = Number(action.untilMs) || null;
      const masters = (state.jobs || []).filter((j) => j.seriesId && j.recurrence && j.recurrence.endType === 'never');
      if (masters.length === 0) return state;
      const ts = nowIso();
      const additions = [];
      // Skip any series that transiently carries MORE THAN ONE recurrence row: a
      // dayShift re-home (or an out-of-order realtime apply on a peer) can briefly
      // leave both the old master and the new anchor holding `recurrence`. Topping up
      // then would expand BOTH cadences and persist duplicates the shift meant to
      // remove — and the (seriesId,startAt) dedup below can't catch a shifted stride.
      // Defer until the series settles back to a single master.
      const recCount = {};
      for (const j of (state.jobs || [])) if (j.seriesId && j.recurrence) recCount[j.seriesId] = (recCount[j.seriesId] || 0) + 1;
      // Never append an occurrence that already exists at the same (seriesId, startAt).
      // This makes top-up idempotent under a per-row realtime race: a dayShift re-home
      // moves `recurrence` between two rows, and peers can briefly see the series with
      // TWO recurrence-carrying rows (old not-yet-nulled + new) — without this guard a
      // top-up in that window would expand both and persist duplicate occurrences.
      const occKey = (seriesId, startAt) => `${seriesId}|${startAt}`;
      const seenOcc = new Set(state.jobs.filter((j) => j.seriesId).map((j) => occKey(j.seriesId, j.startAt)));
      for (const master of masters) {
        if (recCount[master.seriesId] > 1) continue; // transient multi-master (re-home in flight) — defer
        // The master is also a real visit: its one-off marks — and whoever is covering on
        // it (coverFor, R8) — are its own, never a new visit's.
        const { oneOff, coverFor, ...template } = master;
        void oneOff; void coverFor;
        const series = state.jobs.filter((j) => j.seriesId === master.seriesId);
        let lastStart = 0;
        for (const j of series) { const t = new Date(j.startAt).getTime(); if (t > lastStart) lastStart = t; }
        const occ = expandRecurrence({ startAt: master.startAt, endAt: master.endAt, recurrence: master.recurrence, now, until: untilMs });
        for (const o of occ) {
          const t = new Date(o.startAt).getTime();
          if (t <= lastStart || t <= now) continue; // only extend the future tail
          const k = occKey(master.seriesId, o.startAt);
          if (seenOcc.has(k)) continue; // already materialized (or added this pass)
          // Occupied-slot memory: the DB's partial unique index still holds this
          // (seriesId, startAt) slot (a deleted-then-re-minted tail row) — minting
          // into it 23505s server-side and wedges the delta retry loop behind an
          // "offline" badge. The guard was built for exactly this and never wired.
          if (jobTombstones.hasOcc(master.seriesId, o.startAt)) continue;
          seenOcc.add(k);
          // applyTimeOffToOccurrence: the horizon sweep respects booked time off
          // (Sept 1) — a topped-up occurrence landing on someone's off-day mints
          // WITHOUT them instead of silently re-adding them week after week.
          additions.push(applyTimeOffToOccurrence(state, {
            ...template, ...o, id: newId('j'),
            // Always a fresh, upcoming visit. Spreading the master copied ITS status, so
            // once a never-ending series' first clean was in progress / done / cancelled,
            // every visit the sweep added was born that way (2026-09-23).
            status: 'upcoming',
            // Same per-day crew resolution as ADD_JOB_SERIES — without this, the
            // master's crew would silently leak into every topped-up occurrence
            // of a never-ending series with per-day crews.
            crewIds: crewForOccurrence(master.recurrence, o.startAt, master.crewIds),
            recurrence: null, createdAt: ts,
          }));
        }
      }
      if (additions.length === 0) return state;
      return { ...state, jobs: [...state.jobs, ...additions] };
    }
    case ACTIONS.UPDATE_JOB: {
      const prior = state.jobs.find((j) => j.id === action.id);
      // A series visit: mark what this edit changed as a one-off (markOneOff).
      let patch = action.patch || {};
      if (prior?.seriesId && !('oneOff' in patch)) patch = markOneOff(state, prior, patch);
      // ...and settle who is covering whom on it (R8) against the crew this edit leaves.
      patch = settleCoverPatch(state, prior, patch);
      const next = { ...state, jobs: replaceById(state.jobs, action.id, patch) };
      if (prior) {
        const updated = next.jobs.find((j) => j.id === action.id);
        if (patch.status === 'cancelled' && prior.status !== 'cancelled') {
          next.notifications = fanOutJobNotification(next, { job: updated, eventKey: 'jobCancelled' });
        } else {
          // Notify newly-added crew (a re-assignment) as a new assignment, and
          // continuing crew about a time change — never both for the same person.
          const oldCrew = prior.crewIds || [];
          const newCrew = updated.crewIds || [];
          const added = newCrew.filter((id) => !oldCrew.includes(id));
          const startChanged = patch.startAt && patch.startAt !== prior.startAt;
          let notifs = next.notifications;
          if (added.length) {
            // recipients: added → notify ONLY the newly-named crew, not the
            // account's standing crew (who already hold the job) — see #52.
            notifs = fanOutJobNotification({ ...next, notifications: notifs }, { job: updated, eventKey: 'jobCreatedOrRescheduled', recipients: added });
          }
          if (startChanged) {
            const continuing = newCrew.filter((id) => oldCrew.includes(id));
            if (continuing.length) {
              notifs = fanOutJobNotification({ ...next, notifications: notifs }, { job: { ...updated, crewIds: continuing }, eventKey: 'jobCreatedOrRescheduled', priorStartAt: prior.startAt });
            }
          }
          next.notifications = notifs;
        }
      }
      return next;
    }
    case ACTIONS.UPDATE_JOB_SERIES: {
      // Beyond the uniform `patch`, the action takes optional per-time / per-day shapes:
      //   dayPatches: { [dow]: { startTime, endTime, crewIds } } — weekly series
      //     (schedule blocks): each future occurrence is re-timed/re-crewed by its
      //     own local day-of-week.
      //   timePatch: { startTime, endTime } — non-weekly series: every future
      //     occurrence is re-timed on its own date.
      //   dayShift: <integer days> — move every future occurrence to a different
      //     calendar day ("this & all future" from drag-drop / Reschedule). The
      //     uniform `patch` must NEVER carry startAt/endAt: it is spread onto every
      //     eligible row, so a date there would collapse the whole series onto one
      //     instant. Day moves ride dayShift and time moves ride timePatch, both of
      //     which re-derive each row on its OWN date. A dev guard below enforces this.
      //   dayPlan: { days: [dow…], overrides: { dow: {startTime,endTime,crewIds} } } —
      //     the COMPLETE intended weekly shape from the block editor. Unlike dayPatches
      //     (which can only re-time days that already run), this also ADDS and REMOVES
      //     days: occurrences on a dropped day are deleted and occurrences on a new day
      //     are materialized, both only from `fromDate` forward. See the reconciliation
      //     block below.
      const { timePatch, dayPlan } = action;
      // dayPlan supersedes dayPatches; the legacy shape still means "re-time these days,
      // leave the day set alone" so older dispatchers keep working unchanged.
      const dayPatches = dayPlan ? (dayPlan.overrides || {}) : action.dayPatches;
      // REPLAY IDEMPOTENCE (2026-07-30): a relative dayShift applied twice
      // double-moves the series (adoptRemote replays recorded actions after
      // any peer's save). Dispatchers now send targetDayKey — the ABSOLUTE
      // destination day for the fromDate anchor — and the shift is derived
      // from where that anchor sits NOW. If no still-upcoming occurrence sits
      // on fromDate's day anymore, the move (and the rest of this action)
      // already applied — whole-action no-op. Bare dayShift stays honored for
      // old queued actions only. (Never combined with dayPlan — moves and the
      // block editor are separate dispatchers.)
      let dayShift = Math.trunc(Number(action.dayShift) || 0);
      if (action.targetDayKey) {
        // With the opened visit's id (anchorId) the check is EXACT: the move has applied
        // once that visit sits on the target day. The day test alone can't tell after a
        // BACKWARD move (the next visit slides onto fromDate's day, so a replay moved the
        // series again, adversarial review); it stays the fallback for older actions.
        const opened = action.anchorId
          ? state.jobs.find((j) => j.id === action.anchorId && j.seriesId === action.seriesId)
          : null;
        if (opened) {
          if (dayKey(opened.startAt) === action.targetDayKey) return state;
          dayShift = Math.trunc(diffDaysKey(dayKey(opened.startAt), action.targetDayKey) || 0);
        } else {
          const fromKey = dayKey(action.fromDate);
          const anchorPresent = state.jobs.some((j) => j.seriesId === action.seriesId
            && j.status === 'upcoming' && dayKey(j.startAt) === fromKey);
          if (!anchorPresent) return state;
          dayShift = Math.trunc(diffDaysKey(fromKey, action.targetDayKey) || 0);
        }
      }
      if (import.meta.env?.DEV && action.patch && ('startAt' in action.patch || 'endAt' in action.patch)) {
        // eslint-disable-next-line no-console
        console.warn('[UPDATE_JOB_SERIES] startAt/endAt in `patch` is ignored. Use dayShift (date) / timePatch (time); a uniform patch would collapse the series onto one datetime.');
      }
      const patch = { ...(action.patch || {}) };
      delete patch.startAt; delete patch.endAt;

      const eligible = (j) => j.seriesId === action.seriesId && j.status === 'upcoming'
        && !(action.fromDate && j.startAt < action.fromDate);
      const eligibleIds = new Set(state.jobs.filter(eligible).map((j) => j.id));
      const rep = state.jobs.find((j) => eligibleIds.has(j.id)) || null;
      // The visit the edit was opened FROM: "this & all future" includes this one, so it
      // takes the edit even where it is marked a one-off. Dispatchers send its id; an
      // older recorded action falls back to the eligible visit sitting exactly at
      // fromDate (seriesFromDate's anchor for a clean that hasn't started).
      const anchorId = (action.anchorId && eligibleIds.has(action.anchorId))
        ? action.anchorId
        : (state.jobs.find((j) => eligibleIds.has(j.id) && j.startAt === action.fromDate)?.id || null);

      // Time/crew/day edits must survive future top-ups, so the master's recurrence is
      // re-synced in the same pass. A uniform crew change writes the series-level
      // crewOverride and a timePatch the series-level timeOverride (the master keeps its
      // original crew and startAt — it's history — so expansion can't re-derive from it);
      // both also reach any day override naming its own crew / times, which would
      // otherwise shadow them. dayPatches get a DENSE dayOverrides freeze: every
      // scheduled day first pins its currently-resolved times+crew, then the patches
      // land on top — otherwise days that inherited from the (historical) master job
      // would drift the next top-up. dayShift rotates the weekly daysOfWeek +
      // dayOverrides keys by the same delta (materializing an implicit single-day
      // series' day) so generation follows the new day; for a non-weekly never-series
      // whose master is now history, the recurrence is RE-HOMED (below) onto the
      // earliest still-scheduled occurrence so top-up strides from the new day.
      const masterRow = state.jobs.find((j) => j.seriesId === action.seriesId && j.recurrence) || null;
      const mod7 = (d) => ((d % 7) + 7) % 7;
      const mapDays = (dov, fn) => Object.fromEntries(Object.entries(dov).map(([d, o]) => [d, o ? fn(o) : o]));
      let nextRecurrence = null;
      if (masterRow) {
        let r = masterRow.recurrence;
        let changed = false;
        // 🔴 A series crew or time change moves the TEMPLATE with the visits (2026-09-23).
        // Before, a crew change reached only the visits already on the calendar, so every
        // visit TOP_UP added later came back with the OLD crew; and a time change set
        // timeOverride alone, which dense day overrides shadow. Either way the next series
        // edit also read every visit this one changed as a one-off. Only a crew actually
        // SENT counts: an empty patch (a day move) leaves the template alone.
        if (Array.isArray(patch.crewIds)) {
          const crewIds = patch.crewIds;
          r = { ...r, crewOverride: crewIds, ...(r.dayOverrides ? { dayOverrides: mapDays(r.dayOverrides, (o) => (Array.isArray(o.crewIds) ? { ...o, crewIds } : o)) } : {}) };
          changed = true;
        }
        if (timePatch) {
          r = {
            ...r,
            timeOverride: { ...(r.timeOverride || null), ...timePatch },
            ...(r.dayOverrides ? { dayOverrides: mapDays(r.dayOverrides, (o) => (o.startTime || o.endTime ? { ...o, ...timePatch } : o)) } : {}),
          };
          changed = true;
        }
        if (dayPatches) {
          // With a dayPlan the NEW day set drives the freeze: days it dropped fall out
          // of `dense` (pruned), days it added get the series defaults and then their
          // patch on top. Without one, the day set is untouched.
          const days = dayPlan?.days?.length
            ? [...new Set(dayPlan.days.map(Number))].sort((a, b) => a - b)
            : (r.daysOfWeek?.length ? r.daysOfWeek : [dayOfWeekIso(masterRow.startAt)]);
          // Each day starts from what it runs at NOW (dayPatternOf honors timeOverride
          // and crewOverride: after a series-level edit the master job keeps its ORIGINAL
          // values, so freezing from the master would silently rewind them). A dayPlan
          // from the block editor is SPARSE — only what the user changed per day
          // (dayPlanFromBlocks) — so everything else carries over from here.
          // A day the editor shows but the series doesn't run on right now (added in the
          // editor, or removed by another user while this editor was open) starts from
          // the values the editor showed (dayPlan.full), not the series defaults.
          const liveDays = new Set((r.daysOfWeek?.length ? r.daysOfWeek : [dayOfWeekIso(masterRow.startAt)]).map(Number));
          const dense = {};
          for (const dow of days) {
            dense[dow] = !liveDays.has(dow) && dayPlan?.full?.[dow]
              ? { ...dayPlan.full[dow] }
              : dayPatternOf({ ...masterRow, recurrence: r }, dow);
          }
          for (const [dow, dp] of Object.entries(dayPatches)) {
            if (!(dow in dense)) continue; // patch for a day the plan dropped — ignore
            dense[dow] = { ...dense[dow], ...dp };
          }
          r = { ...r, dayOverrides: dense, ...(dayPlan ? { daysOfWeek: days } : {}) };
          changed = true;
        }
        if (dayShift) {
          if (r.frequency === 'weekly') {
            const days = (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length)
              ? r.daysOfWeek
              : [dayOfWeekIso(masterRow.startAt)];
            r = { ...r, daysOfWeek: [...new Set(days.map((d) => mod7(d + dayShift)))].sort((a, b) => a - b) };
          }
          if (r.dayOverrides && Object.keys(r.dayOverrides).length) {
            const rotated = {};
            for (const [k, v] of Object.entries(r.dayOverrides)) rotated[mod7(Number(k) + dayShift)] = v;
            r = { ...r, dayOverrides: rotated };
          }
          changed = true;
        }
        nextRecurrence = changed ? r : null;
      }

      // Re-home the recurrence for a non-weekly never-series shifted from a point
      // AFTER its (now historical) master: the master's date is the only stride
      // anchor and a historical row must not move, so the recurrence hops onto the
      // earliest still-scheduled occurrence — itself shifted to the new day below.
      const eligibleRows = state.jobs.filter((j) => eligibleIds.has(j.id));
      const earliestEligible = eligibleRows.length
        ? eligibleRows.reduce((a, b) => (a.startAt <= b.startAt ? a : b))
        : null;
      const rehome = !!(dayShift && masterRow && earliestEligible
        && !eligibleIds.has(masterRow.id)
        && masterRow.recurrence.endType === 'never'
        && masterRow.recurrence.frequency !== 'weekly');
      const rehomeRecurrence = nextRecurrence || (masterRow ? masterRow.recurrence : null);

      // ── dayPlan: reconcile the MATERIALIZED rows with the new day set ──────────
      // The recurrence above only governs what future top-ups generate. The rows
      // already on the board have to be brought in line too, or the calendar and the
      // recurrence disagree: a dropped day keeps showing cleans nobody will do, and an
      // added day shows nothing until the horizon rolls far enough to top it up.
      // Both sides are bounded by `fromDate` — history is never touched.
      const planDays = dayPlan?.days?.length
        ? new Set(dayPlan.days.map(Number))
        : null;
      const droppedIds = new Set();
      const additions = [];
      if (planDays && masterRow && nextRecurrence) {
        const priorDays = new Set(
          (masterRow.recurrence.daysOfWeek?.length
            ? masterRow.recurrence.daysOfWeek
            : [dayOfWeekIso(masterRow.startAt)]).map(Number),
        );
        // Only visits on a day the plan REMOVED go. A visit moved on its own to a day
        // the series never runs on isn't part of any removed day, and deleting it (the
        // old "not in the new day set" test) made a notes-only save destroy it.
        for (const j of eligibleRows) {
          const dow = dayOfWeekIso(j.startAt);
          if (priorDays.has(dow) && !planDays.has(dow)) droppedIds.add(j.id);
        }
        const addedDays = [...planDays].filter((d) => !priorDays.has(d));
        if (addedDays.length) {
          // 🔴 MATERIALIZE THE NEW DAY OVER THE SPAN THE SERIES ALREADY COVERS — never
          // over the recurrence's own cutoff.
          //
          // Expanding a never-series against its rolling horizon looks right and is not:
          // the existing days reach only as far as the last top-up put them, so the new
          // day would run months past its siblings — and TOP_UP_RECURRING_SERIES appends
          // only BEYOND the series' latest occurrence (`t <= lastStart` → continue), so
          // the older days can never catch up through the gap. The result is a permanent
          // hole: Tuesdays booked into October against Mondays that stop in August.
          // Observed on the first run of this path.
          //
          // Capping at the surviving tail makes the added day match its siblings exactly,
          // and the next top-up then extends every day together. The same cap is what a
          // count-capped series needs for its own reason — expandRecurrence's limit counts
          // occurrences across ALL days, so a wider day set packs N into a shorter window.
          const survivingTail = eligibleRows
            .filter((j) => !droppedIds.has(j.id))
            .reduce((max, j) => (j.startAt > max ? j.startAt : max), '');
          const genRecurrence = survivingTail
            ? { ...nextRecurrence, endType: 'date', endDate: survivingTail }
            : nextRecurrence;
          const added = new Set(addedDays);
          // Same (seriesId, startAt) dedup TOP_UP uses — an occurrence that somehow
          // already exists on the new day is never doubled.
          const seenOcc = new Set(
            state.jobs.filter((j) => j.seriesId === action.seriesId).map((j) => j.startAt),
          );
          const ts = nowIso();
          // The master visit's own marks — and its cover (R8) — aren't a new visit's.
          const { oneOff, coverFor, ...template } = masterRow;
          void oneOff; void coverFor;
          for (const o of expandRecurrence({
            startAt: masterRow.startAt, endAt: masterRow.endAt, recurrence: genRecurrence,
          })) {
            if (!added.has(dayOfWeekIso(o.startAt))) continue;
            if (action.fromDate && o.startAt < action.fromDate) continue;
            if (seenOcc.has(o.startAt)) continue;
            seenOcc.add(o.startAt);
            // applyTimeOffToOccurrence: the added-day mint respects booked time
            // off exactly like ADD_JOB_SERIES/TOP_UP (the third mint path the
            // adversarial review found unwired).
            additions.push(applyTimeOffToOccurrence(state, {
              ...template, ...o, id: newId('j'),
              ...patch,
              status: 'upcoming',
              crewIds: crewForOccurrence(nextRecurrence, o.startAt, masterRow.crewIds),
              recurrence: null, createdAt: ts,
            }));
          }
        }
      }

      // 🔴 HEADLESS-SERIES GUARD. Removing a day can delete the very row that CARRIES
      // the recurrence, and a series with no recurrence row stops rolling forward
      // forever: TOP_UP_RECURRING_SERIES finds no master, so a never-ending series
      // silently dies and nobody sees an error. Re-home onto the earliest survivor,
      // exactly as DELETE_JOB does when it removes a master. Safe because the freeze
      // above made dayOverrides DENSE — every day carries its own times, so expansion
      // no longer depends on which row happens to be the anchor.
      const masterDropped = !!(masterRow && droppedIds.has(masterRow.id));
      const heirRow = masterDropped
        ? state.jobs
          .filter((j) => j.seriesId === action.seriesId && !droppedIds.has(j.id) && j.id !== masterRow.id)
          .concat(additions)
          .reduce((a, b) => (a && a.startAt <= b.startAt ? a : b), null)
        : null;

      // Dropping a day deletes rows, so it inherits DELETE_JOB_SERIES' obligation to
      // scrub their now-dead notification links (url → /schedule/{id}). Caught on the
      // live write test: removing the master's day left Demo Crew holding a "New job
      // assigned to you" bell row pointing at a job that no longer existed — click it,
      // get "Job not found". Deleting rows without this scrub is how that happens, and
      // this action deletes rows now too.
      const deadUrls = new Set([...droppedIds].map((rid) => `/schedule/${rid}`));

      // 🔴 A VISIT CHANGED ON ITS OWN KEEPS THAT CHANGE (2026-09-23, owner default). A
      // crew or time change skips that field on a visit marked a one-off (`oneOff`, set by
      // a single-visit UPDATE_JOB — see markOneOff), so a one-night cover or a one-off
      // time survives "this & all future"; crew and time are marked apart. The visit the
      // edit was opened from (anchorId) always takes it and loses those marks. Crew rides
      // apart from the other uniform fields for that reason; notes, site, service and
      // tags still apply to every future visit.
      const uniformFields = { ...patch };
      delete uniformFields.crewIds;
      // A "this & all future" edit NEVER writes a cover (R8): `coverFor` describes one
      // visit's swap, and the uniform patch is spread onto every future visit, so letting
      // it ride would point the whole series at one cleaner's checklist. The UI does not
      // put it here; this is the write-point backstop for a stale tab or a replay.
      delete uniformFields.coverFor;

      const next = {
        ...state,
        ...(droppedIds.size
          ? { notifications: (state.notifications || []).filter((n) => !deadUrls.has(n.url)) }
          : null),
        // Rows on a day the plan dropped are removed here; the sync manager's diff
        // turns that into a `removed` delta on its own (jobsSync.persistJobsDelta),
        // the same path DELETE_JOB_SERIES relies on — no new write path.
        jobs: state.jobs.filter((j) => !droppedIds.has(j.id)).map((j) => {
          let nj = j;
          let recrewed = false;
          // The day's REGULAR crew after this edit, for the cover settle below. It is what
          // this edit put on the day when it sent a crew, else the (possibly re-synced)
          // pattern. Null on a row this edit does not reach — its regulars did not move
          // from its own point of view, and past visits are history.
          let dayRegulars = null;
          if (eligibleIds.has(j.id)) {
            nj = { ...j, ...uniformFields };
            const dow = dayOfWeekIso(j.startAt);
            const dp = dayPatches ? dayPatches[dow] : null;
            // A day's own patch wins over the uniform one; a sparse day patch that names
            // no times (crew only) re-times nothing.
            let crewTo = Array.isArray(patch.crewIds) ? patch.crewIds : null;
            if (dp && Array.isArray(dp.crewIds)) crewTo = dp.crewIds;
            const timeTo = dp ? ((dp.startTime || dp.endTime) ? dp : null) : timePatch;
            dayRegulars = crewTo
              || regularCrewFor(state, j, masterRow ? { ...masterRow, recurrence: nextRecurrence || masterRow.recurrence } : null);
            const isAnchor = j.id === anchorId;
            const takesTime = !!timeTo && (isAnchor || !j.oneOff?.time);
            const takesCrew = !!crewTo && (isAnchor || !j.oneOff?.crew);
            if (takesTime || dayShift) {
              const s = splitIso(j.startAt);
              const dateKey = dayShift ? addDaysKey(s.date, dayShift) : s.date;
              const startTime = (takesTime && timeTo.startTime) || s.time;
              const endTime = (takesTime && timeTo.endTime) || splitIso(j.endAt).time;
              nj.startAt = composeIso(dateKey, startTime);
              // composeEndIso: end <= start means the shift crosses midnight —
              // same-day composition inverted endAt for overnight cleans.
              nj.endAt = composeEndIso(dateKey, startTime, endTime);
            }
            if (takesCrew) { nj.crewIds = crewTo; recrewed = true; }
            // A mark goes once the visit no longer differs: the opened visit took the
            // edit, or the series CAUGHT UP with the one-off, i.e. TAKING the edit would
            // change nothing (the new crew, after time off, is exactly this visit's crew;
            // the new times are its times). Anything looser breaks replay: a cleared mark
            // lets the replay re-crew it. A kept mark would make the next series change
            // skip a visit that looks regular (adversarial review).
            if (j.oneOff) {
              const clock = (x) => `${x.startTime || splitIso(j.startAt).time}-${x.endTime || splitIso(j.endAt).time}`;
              const minted = crewTo ? applyTimeOffToOccurrence(state, { crewIds: crewTo, startAt: nj.startAt }).crewIds : null;
              const dropCrew = !!(j.oneOff.crew && crewTo && (takesCrew || idSetKey(minted) === idSetKey(j.crewIds)));
              const dropTime = !!(j.oneOff.time && timeTo
                && (takesTime || clock(timeTo) === `${splitIso(j.startAt).time}-${splitIso(j.endAt).time}`));
              if (dropCrew || dropTime) {
                const keepCrew = j.oneOff.crew && !dropCrew;
                const keepTime = j.oneOff.time && !dropTime;
                nj.oneOff = (keepCrew || keepTime)
                  ? { ...(keepCrew ? { crew: true } : {}), ...(keepTime ? { time: true } : {}) }
                  : null;
              }
            }
          }
          // Recurrence placement: normally re-sync the master in place; when re-homing,
          // strip it off the old (historical) master and pin it on the new anchor row.
          // A master deleted by a day-drop is already filtered out above, so its
          // recurrence lands on the heir instead (headless-series guard).
          if (rehome) {
            if (j.id === masterRow.id) nj = { ...nj, recurrence: null };
            else if (j.id === earliestEligible.id) nj = { ...nj, recurrence: rehomeRecurrence };
          } else if (masterDropped) {
            if (heirRow && j.id === heirRow.id) nj = { ...nj, recurrence: nextRecurrence };
          } else if (nextRecurrence && masterRow && j.id === masterRow.id) {
            nj = { ...nj, recurrence: nextRecurrence };
          }
          // A RE-CREW respects booked time off exactly like a mint (ADD_JOB_SERIES, TOP_UP,
          // the added-day mint above). A crew change re-crews every regular visit, so
          // without this it put back a cleaner Team › Time off had taken off those cleans
          // (2026-09-23). It runs on the FINAL row: the day judged is the one the clean now
          // runs on (after a dayShift), and whichever row now carries the recurrence is the
          // series template, which applyTimeOffToOccurrence refuses to touch. Rows this
          // edit didn't re-crew keep the crew the office left on them.
          //
          // Every visit this edit REACHES settles its cover (R8, lib/jobCover.js), not only
          // the re-crewed ones: a series crew change moves the day's REGULARS for all of
          // them, and a cover whose cleaner is now the regular — or who is a regular
          // themselves — is covering nobody. That is reviewer finding C1: the anchor takes
          // the promotion and loses `oneOff`, and the crew rule alone still saw a valid
          // cover. On a re-crewed row it runs AFTER the time-off pass, so the crew judged
          // is the one the visit ends up with. The row's crew and its one-off mark are
          // untouched either way, so a one-night cover still survives "this & all future".
          const settled = recrewed ? applyTimeOffToOccurrence(state, nj) : nj;
          return dayRegulars ? settleCoverFor(settled, dayRegulars) : settled;
        }).concat(
          // The heir can itself be a freshly materialized occurrence (every surviving
          // row predates it only when the drop removed the whole early tail).
          additions.map((a) => (masterDropped && heirRow && a.id === heirRow.id
            ? { ...a, recurrence: nextRecurrence }
            : a)),
        ),
      };

      // Mirror UPDATE_JOB's notification split at series level: newly-added crew
      // hear "new assignment" once; continuing crew hear "rescheduled" once when
      // any occurrence's time actually moved — never both for the same person.
      if (rep || additions.length) {
        // Newly materialized occurrences count as part of the post-state: crew who only
        // cover a day the plan ADDED are new assignees and must hear about it, and
        // without them in the union they'd silently pick up cleans nobody told them of.
        const addedIds = new Set(additions.map((a) => a.id));
        const post = next.jobs.filter((j) => eligibleIds.has(j.id) || addedIds.has(j.id));
        let notifs = next.notifications;
        // Judged VISIT BY VISIT (2026-09-23): with one-off visits kept as they were, visits
        // no longer all carry the same crew. "Added" = on a visit now and not on that visit
        // before (a freshly materialized one counts whole), so a cover who becomes the
        // regular crew hears about the visits they were just put on; the old union test
        // ("on none of the eligible visits before") read them as continuing and said
        // nothing. Each person hears ONCE, naming the earliest such visit THEY are on.
        const pairs = post.map((n) => [state.jobs.find((o) => o.id === n.id) || null, n]);
        const on = (job, uid) => (job?.crewIds || []).includes(uid);
        const noticeEach = (visitPairs, recipients, rescheduled) => {
          const groups = new Map(); // earliest visit id → { pair, ids }
          for (const uid of recipients) {
            const pair = visitPairs
              .filter((p) => on(p[1], uid))
              .reduce((a, b) => (a && a[1].startAt <= b[1].startAt ? a : b), null);
            if (!pair) continue;
            const g = groups.get(pair[1].id) || { pair, ids: [] };
            g.ids.push(uid);
            groups.set(pair[1].id, g);
          }
          for (const { pair: [o, n], ids } of groups.values()) {
            notifs = fanOutJobNotification({ ...next, notifications: notifs }, {
              job: n, eventKey: 'jobCreatedOrRescheduled', recipients: ids,
              ...(rescheduled ? { priorStartAt: o.startAt } : {}),
            });
          }
        };
        // recipients: added → only the newly-named crew, not standing crew (#52).
        const addedPairs = pairs.filter(([o, n]) => (n.crewIds || []).some((id) => !on(o, id)));
        const added = [...new Set(addedPairs.flatMap(([o, n]) => (n.crewIds || []).filter((id) => !on(o, id))))];
        if (added.length) noticeEach(addedPairs.map(([o, n]) => [o, { ...n, crewIds: (n.crewIds || []).filter((id) => !on(o, id)) }]), added, false);
        // "Rescheduled" (copy keys off priorStartAt !== startAt): crew who were already
        // on a visit whose time actually MOVED — never both notices for the same person.
        const addedSet = new Set(added);
        const movedPairs = pairs
          .filter(([o, n]) => o && o.startAt !== n.startAt)
          .map(([o, n]) => [o, { ...n, crewIds: (n.crewIds || []).filter((id) => on(o, id) && !addedSet.has(id)) }]);
        const continuing = [...new Set(movedPairs.flatMap(([, n]) => n.crewIds))];
        if (continuing.length) noticeEach(movedPairs, continuing, true);
        next.notifications = notifs;
      }
      return next;
    }
    case ACTIONS.SET_JOB_STATUS: {
      const prior = state.jobs.find((j) => j.id === action.id);
      const next = { ...state, jobs: replaceById(state.jobs, action.id, { status: action.status }) };
      if (prior && action.status === 'cancelled' && prior.status !== 'cancelled') {
        const updated = next.jobs.find((j) => j.id === action.id);
        next.notifications = fanOutJobNotification(next, { job: updated, eventKey: 'jobCancelled' });
      }
      return next;
    }
    case ACTIONS.DELETE_JOB: {
      const id = action.id;
      const job = state.jobs.find((j) => j.id === id);
      let jobsAfter = removeById(state.jobs, id);
      // If we deleted the row that CARRIED the series' recurrence, the series would go
      // HEADLESS — children keep a seriesId with no master, and a never-ending series
      // silently stops rolling forward (TOP_UP finds no recurrence row). Re-home the
      // recurrence onto the earliest surviving occurrence (mirrors the dayShift re-home).
      if (job && job.recurrence && job.seriesId) {
        const survivors = jobsAfter.filter((j) => j.seriesId === job.seriesId);
        if (survivors.length && !survivors.some((j) => j.recurrence)) {
          const heir = survivors.reduce((a, b) => (a.startAt <= b.startAt ? a : b));
          jobsAfter = jobsAfter.map((j) => (j.id === heir.id ? { ...j, recurrence: job.recurrence } : j));
        }
      }
      const next = {
        ...state,
        jobs: jobsAfter,
        invoices: state.invoices.map((inv) => (
          (inv.jobIds || []).includes(id) ? { ...inv, jobIds: inv.jobIds.filter((j) => j !== id) } : inv
        )),
        reminderEvents: (state.reminderEvents || []).filter((e) => e.jobId !== id),
        // Drop this job's own now-dead notification links (url → /schedule/{id}); the
        // fresh cancellation notice below points at the schedule list instead. (Server-
        // side, deleting the public.jobs row DETACHES its labor/QC records — job_id set
        // null, history preserved — via ON DELETE SET NULL FKs, and a trigger removes the
        // clean's before/after media. See 20260717120000_job_delete_dependents.sql.)
        notifications: (state.notifications || []).filter((n) => n.url !== `/schedule/${id}`),
      };
      // Deleting an upcoming job strands its crew exactly like cancelling it.
      // url→/schedule since the job's detail route no longer exists.
      if (job && job.status !== 'cancelled' && job.status !== 'done') {
        next.notifications = fanOutJobNotification(next, { job, eventKey: 'jobCancelled', url: '/schedule' });
      }
      return next;
    }
    case ACTIONS.DELETE_JOB_SERIES: {
      const removed = state.jobs.filter((j) => {
        if (j.seriesId !== action.seriesId) return false;
        if (j.status !== 'upcoming') return false;
        if (action.fromDate && j.startAt < action.fromDate) return false;
        return true;
      });
      const removedIds = new Set(removed.map((j) => j.id));
      const deadUrls = new Set([...removedIds].map((rid) => `/schedule/${rid}`));
      // If a recurrence-carrying master SURVIVES the delete (it's before fromDate, so
      // not in the removed set), a never-ending series would just re-materialize the
      // deleted tail on the next TOP_UP — "end this & all future" becomes a no-op after
      // one Schedule mount. Cap the surviving master's recurrence at the deletion point
      // so generation stops there (endType:'date' also removes it from TOP_UP entirely).
      const capDate = action.fromDate || nowIso();
      const survivingMaster = state.jobs.find((j) => j.seriesId === action.seriesId && j.recurrence && !removedIds.has(j.id));
      const next = {
        ...state,
        jobs: state.jobs.filter((j) => !removedIds.has(j.id)).map((j) => (
          survivingMaster && j.id === survivingMaster.id
            ? { ...j, recurrence: { ...j.recurrence, endType: 'date', endDate: capDate } }
            : j
        )),
        invoices: state.invoices.map((inv) => {
          const ids = (inv.jobIds || []).filter((id) => !removedIds.has(id));
          return ids.length === (inv.jobIds || []).length ? inv : { ...inv, jobIds: ids };
        }),
        reminderEvents: (state.reminderEvents || []).filter((e) => !removedIds.has(e.jobId)),
        // Drop the removed occurrences' now-dead notification links (see DELETE_JOB).
        notifications: (state.notifications || []).filter((n) => !deadUrls.has(n.url)),
      };
      // Notify the series crew once that their upcoming jobs were removed.
      // url→/schedule since the deleted jobs' detail routes no longer exist.
      if (removed[0]) {
        next.notifications = fanOutJobNotification(next, { job: removed[0], eventKey: 'jobCancelled', url: '/schedule' });
      }
      return next;
    }

    // ---------- Invoices ----------
    case ACTIONS.ADD_INVOICE: {
      // status='pending' by default. The 'draft' status was removed when the
      // section was rescoped to manual tracking — there is no authoring/sending
      // workflow that would justify a draft state anymore.
      const base = {
        id: action.invoice?.id || nextInvoiceId(state),
        jobIds: [], lineItems: [], payments: [],
        taxRate: state.company.taxRate || 0,
        status: 'pending',
        createdAt: nowIso(),
        billingContactId: null,
        attachment: null,
        notes: '',
      };
      const incoming = action.invoice || {};
      const status = incoming.status === 'draft' ? 'pending' : (incoming.status || base.status);
      return { ...state, invoices: [...state.invoices, { ...base, ...incoming, id: base.id, status }] };
    }
    case ACTIONS.UPDATE_INVOICE: {
      const prior = state.invoices.find((i) => i.id === action.id);
      const next = { ...state, invoices: replaceById(state.invoices, action.id, action.patch) };
      const ns = action.patch?.status;
      if (prior && ns && ns !== prior.status && (ns === 'paid' || ns === 'overdue')) {
        const inv = next.invoices.find((i) => i.id === action.id);
        next.notifications = fanOutInvoiceNotification(next, { invoice: inv, eventKey: ns === 'paid' ? 'invoicePaid' : 'invoiceOverdue' });
      }
      return next;
    }
    case ACTIONS.ADD_INVOICE_PAYMENT: {
      const pay = { id: newId('pay'), date: action.payment?.date || nowIso(), amount: 0, method: '', note: '', ...action.payment };
      const prior = state.invoices.find((inv) => inv.id === action.id);
      // 🔴 IDEMPOTENT ON REPLAY — a payment must never be recorded twice.
      //
      // The sync manager replays the pending queue on top of an adopted remote document
      // (sync.js adoptRemote). If a save COMMITS SERVER-SIDE but the response is lost —
      // a timeout, a cold start, a dropped connection — the client cannot tell it
      // succeeded, keeps the action queued, and replays it onto a remote state that
      // ALREADY CONTAINS the payment. Money gets counted twice, the invoice reads
      // overpaid, and clientBalance then nets the phantom credit against the account's
      // other open invoices.
      //
      // The id is the dedupe key, which is why the callers now mint it at dispatch
      // (lib/ids newId) instead of letting this line generate a fresh one per replay.
      // BOTH HALVES ARE REQUIRED: dedupe alone does nothing while every replay invents a
      // new id, and a stable id alone does nothing without this check.
      if (prior && (prior.payments || []).some((p) => p && p.id === pay.id)) return state;
      const next = {
        ...state,
        invoices: state.invoices.map((inv) => (inv.id === action.id ? { ...inv, payments: [...inv.payments, pay] } : inv)),
      };
      // 'paid' is balance-derived — logging the payment that zeroes the balance is
      // the canonical "paid" event, so fan out on the derived-status transition.
      if (prior) {
        const updated = next.invoices.find((inv) => inv.id === action.id);
        if (deriveInvoiceStatus(prior) !== 'paid' && deriveInvoiceStatus(updated) === 'paid') {
          next.notifications = fanOutInvoiceNotification(next, { invoice: updated, eventKey: 'invoicePaid' });
        }
      }
      return next;
    }
    case ACTIONS.UPDATE_INVOICE_PAYMENT: {
      // Edit a previously-recorded payment (amount / method / date / note).
      // Only mutates the targeted payment row; status auto-derives from the
      // resulting balance via deriveInvoiceStatus.
      const patch = action.patch || {};
      const prior = state.invoices.find((inv) => inv.id === action.id);
      const next = {
        ...state,
        invoices: state.invoices.map((inv) => (
          inv.id === action.id
            ? { ...inv, payments: inv.payments.map((p) => (p.id === action.paymentId ? { ...p, ...patch } : p)) }
            : inv
        )),
      };
      if (prior) {
        const updated = next.invoices.find((inv) => inv.id === action.id);
        if (deriveInvoiceStatus(prior) !== 'paid' && deriveInvoiceStatus(updated) === 'paid') {
          next.notifications = fanOutInvoiceNotification(next, { invoice: updated, eventKey: 'invoicePaid' });
        }
      }
      return next;
    }
    case ACTIONS.REMOVE_INVOICE_PAYMENT:
      return {
        ...state,
        invoices: state.invoices.map((inv) => (inv.id === action.id ? { ...inv, payments: inv.payments.filter((p) => p.id !== action.paymentId) } : inv)),
      };
    case ACTIONS.SET_INVOICE_STATUS: {
      // 'draft' is no longer part of the schema (manual-tracking rescope).
      // Any caller that sends 'draft' is treated as a no-op rather than corrupting state.
      const allowed = new Set(['pending', 'overdue', 'paid', 'void']);
      if (!allowed.has(action.status)) return state;
      const prior = state.invoices.find((i) => i.id === action.id);
      const next = { ...state, invoices: replaceById(state.invoices, action.id, { status: action.status }) };
      if (prior && action.status !== prior.status && (action.status === 'paid' || action.status === 'overdue')) {
        const inv = next.invoices.find((i) => i.id === action.id);
        next.notifications = fanOutInvoiceNotification(next, { invoice: inv, eventKey: action.status === 'paid' ? 'invoicePaid' : 'invoiceOverdue' });
      }
      return next;
    }
    case ACTIONS.MARK_INVOICES_OVERDUE: {
      // Time-driven sweep (dispatched on mount, like TOP_UP_RECURRING_SERIES):
      // 'overdue' is a derived status that no user action ever persists, so we
      // detect newly-overdue invoices here, stamp a one-shot `overdueNotifiedAt`
      // marker, and fan out invoiceOverdue once. Idempotent — returns the same
      // state when nothing is newly overdue, so it's safe to run on every mount.
      const now = new Date();
      const newlyOverdue = (state.invoices || []).filter(
        (inv) => !inv.overdueNotifiedAt && deriveInvoiceStatus(inv, now) === 'overdue',
      );
      if (newlyOverdue.length === 0) return state;
      const stamp = nowIso();
      const ids = new Set(newlyOverdue.map((inv) => inv.id));
      const next = {
        ...state,
        invoices: state.invoices.map((inv) => (ids.has(inv.id) ? { ...inv, overdueNotifiedAt: stamp } : inv)),
      };
      let notifs = next.notifications;
      for (const inv of newlyOverdue) {
        notifs = fanOutInvoiceNotification({ ...next, notifications: notifs }, { invoice: inv, eventKey: 'invoiceOverdue' });
      }
      next.notifications = notifs;
      return next;
    }
    case ACTIONS.DELETE_INVOICE:
      return { ...state, invoices: removeById(state.invoices, action.id) };

    // ---------- Quotes ----------
    case ACTIONS.UPSERT_QUOTE: {
      // Mirror a Supabase quote into the store for the admin Quotes list.
      const quotes = state.quotes || [];
      const exists = quotes.some((q) => q.id === action.quote.id);
      return {
        ...state,
        quotes: exists
          ? quotes.map((q) => (q.id === action.quote.id ? { ...q, ...action.quote } : q))
          : [action.quote, ...quotes],
      };
    }
    case ACTIONS.MARK_PAYMENT_SYNCED:
      // Idempotency ledger: server payment ids already materialized as invoices.
      return { ...state, syncedPayments: [...(state.syncedPayments || []), action.paymentId] };

    // ---------- Integrations ----------
    case ACTIONS.SET_FINANCIAL_SNAPSHOT:
      // External snapshot (e.g. Google Sheet). null clears the override.
      return { ...state, financialSnapshot: action.snapshot || null };

    // ---------- Keys (check-in / check-out) ----------
    case ACTIONS.ADD_KEY: {
      const now = nowIso();
      const key = {
        id: newId('key'), status: 'in', heldByUserId: null, heldByName: null,
        clientName: '', clientId: null, siteId: null, siteName: '', masterCode: '', label: '', notes: '',
        ...action.key, createdAt: now, updatedAt: now,
      };
      // A key belongs to a site; derive + denormalize the site name (and backfill
      // the company link from the site) so the row survives a later rename/delete.
      if (key.siteId) {
        const site = (state.sites || []).find((s) => s.id === key.siteId);
        if (site) { key.siteName = site.name; if (!key.clientId) key.clientId = site.clientId; }
        else { key.siteId = null; key.siteName = ''; }
      } else {
        key.siteName = '';
      }
      // Inventory changes are audited like check-in/out — the page promises
      // "every action is timestamped with who did it".
      const evt = { id: newId('kev'), keyId: key.id, kind: 'created', byUserId: state.currentUserId, occurredAt: now, note: null };
      return { ...state, keys: [...(state.keys || []), key], keyEvents: [...(state.keyEvents || []), evt] };
    }
    case ACTIONS.UPDATE_KEY: {
      const now = nowIso();
      const patch = { ...action.patch };
      // Re-derive the denormalized site name (and company link) whenever the site
      // changes, so it can't drift from the chosen siteId.
      if ('siteId' in patch) {
        const site = patch.siteId ? (state.sites || []).find((s) => s.id === patch.siteId) : null;
        patch.siteId = site ? site.id : null;
        patch.siteName = site ? site.name : '';
        if (site && !patch.clientId) patch.clientId = site.clientId;
      }
      const evt = { id: newId('kev'), keyId: action.id, kind: 'edited', byUserId: state.currentUserId, occurredAt: now, note: action.note || null };
      return {
        ...state,
        keys: (state.keys || []).map((k) => (k.id === action.id ? { ...k, ...patch, updatedAt: now } : k)),
        keyEvents: [...(state.keyEvents || []), evt],
      };
    }
    case ACTIONS.DELETE_KEY:
      return {
        ...state,
        keys: (state.keys || []).filter((k) => k.id !== action.id),
        keyEvents: (state.keyEvents || []).filter((e) => e.keyId !== action.id),
      };
    // Complaints were folded into Work Orders (Quality hub): a customer complaint is now a
    // Work Order of type:complaint, a relational problem_reports row created through qcApi
    // (createProblem) — NOT a blob action. The manager alert rides the work-order notify
    // (notifyManagersOfProblem, server-side) instead of the old ADD_COMPLAINT fan-out.
    // ---------- Supplies (S58) ----------
    case ACTIONS.ADD_SUPPLY_ITEM: {
      const item = action.item || {};
      // Caller-minted id + dedupe guard (lint:queue replay-idempotency): a replayed
      // ADD with the same id is a no-op, not a duplicate row.
      const id = item.id || newId('si');
      if ((state.supplyItems || []).some((s) => s.id === id)) return state;
      return {
        ...state,
        supplyItems: [...(state.supplyItems || []), {
          clientId: null, name: '', unit: '', ...item,
          id, unitPrice: Math.round((Number(item.unitPrice) || 0) * 100) / 100, createdAt: item.createdAt || nowIso(),
        }],
      };
    }
    case ACTIONS.UPDATE_SUPPLY_ITEM:
      return {
        ...state,
        supplyItems: (state.supplyItems || []).map((s) => (s.id === action.id
          ? {
            ...s, ...action.patch,
            ...(action.patch && action.patch.unitPrice != null
              ? { unitPrice: Math.round((Number(action.patch.unitPrice) || 0) * 100) / 100 } : {}),
          }
          : s)),
      };
    case ACTIONS.DELETE_SUPPLY_ITEM:
      // Hard delete (replace-means-delete; no soft-active flag). Submitted request
      // lines snapshot name + price, so removing a catalog item never rewrites history.
      return { ...state, supplyItems: (state.supplyItems || []).filter((s) => s.id !== action.id) };
    case ACTIONS.ADD_SUPPLY_REQUEST: {
      const req = action.request || {};
      const id = req.id || newId('sr');
      if ((state.supplyRequests || []).some((r) => r.id === id)) return state; // dedupe guard
      const now = nowIso();
      const request = {
        id,
        clientId: req.clientId || null,
        requestedByUserId: req.requestedByUserId || state.currentUserId,
        status: 'open',
        note: (req.note || '').trim(),
        lines: (req.lines || []).map((l) => ({
          itemId: l.itemId || null, name: l.name || '',
          qty: Number(l.qty) || 0, unitPrice: Math.round((Number(l.unitPrice) || 0) * 100) / 100,
        })),
        createdAt: now, completedAt: null, completedByUserId: null,
      };
      let next = { ...state, supplyRequests: [...(state.supplyRequests || []), request] };
      // Ping the office — whoever can fulfill (supplyRequestSubmitted requiresPermission
      // supplies.manage, enforced in isNotificationVisibleForUser). Skip the requester.
      const client = (state.clients || []).find((c) => c.id === request.clientId) || null;
      const requester = (state.users || []).find((u) => u.id === request.requestedByUserId) || null;
      const count = supplyRequestItemCount(request);
      next.notifications = fanOutManagerAlert(next, {
        eventKey: 'supplyRequestSubmitted',
        title: `Supply request: ${client ? client.name : 'a location'}`,
        body: `${count} item${count === 1 ? '' : 's'} · ${money(supplyRequestTotal(request))}${requester ? ` · by ${requester.name}` : ''}`,
        url: '/supplies',
        actorUserId: state.currentUserId,
      });
      return next;
    }
    case ACTIONS.COMPLETE_SUPPLY_REQUEST: {
      const req = (state.supplyRequests || []).find((r) => r.id === action.id);
      if (!req || req.status === 'completed') return state; // idempotent — already done
      const now = nowIso();
      const byUserId = action.byUserId || state.currentUserId;
      const completed = { ...req, status: 'completed', completedAt: now, completedByUserId: byUserId };
      let next = {
        ...state,
        supplyRequests: (state.supplyRequests || []).map((r) => (r.id === action.id ? completed : r)),
      };
      // Notify the requester (skip when they completed their own — they know).
      const client = (state.clients || []).find((c) => c.id === completed.clientId) || null;
      const count = supplyRequestItemCount(completed);
      next.notifications = fanOutToUserIds(next, {
        userIds: [completed.requestedByUserId],
        eventKey: 'supplyRequestCompleted',
        title: 'Your supply request was completed',
        body: `${client ? client.name : 'a location'} · ${count} item${count === 1 ? '' : 's'}`,
        url: '/supplies',
        actorUserId: byUserId,
      });
      // Retention at the write point (BUILD_INTEGRITY §5): trim the completed tail.
      next.supplyRequests = pruneSupplyRequests(next.supplyRequests, Date.parse(now));
      return next;
    }
    case ACTIONS.REOPEN_SUPPLY_REQUEST:
      // completedByName is the kept name of a completer who was since deleted; reopening
      // clears it with the id, so a later completion is never credited to them.
      return {
        ...state,
        supplyRequests: (state.supplyRequests || []).map((r) => (r.id === action.id
          ? { ...r, status: 'open', completedAt: null, completedByUserId: null, completedByName: null } : r)),
      };
    case ACTIONS.DELETE_SUPPLY_REQUEST:
      return { ...state, supplyRequests: (state.supplyRequests || []).filter((r) => r.id !== action.id) };

    case ACTIONS.SET_REVIEWS:
      return { ...state, reviews: { ...(state.reviews || {}), ...action.patch } };
    case ACTIONS.RAISE_OPS_ALERT: {
      // Raise one operational alert via the shared pure applier (lib/opsAlertApply,
      // also used by the go-live server cron app/api/cron/ops-alerts.js), so the client
      // reducer and that cron dedup, retain markers, and route recipients identically.
      // action.alert: { id, kind, recipientScope, clientId, jobId, crewIds, title, body, url }.
      const applied = applyOpsAlert(state, action.alert);
      if (!applied) return state; // missing id/kind, or already raised (idempotent)
      return { ...state, opsAlertEvents: applied.opsAlertEvents, notifications: applied.notifications };
    }

    case ACTIONS.CHECKOUT_KEY: {
      const now = nowIso();
      const evt = {
        id: newId('kev'), keyId: action.keyId, kind: 'checkout',
        byUserId: state.currentUserId,
        holderUserId: action.holderUserId || null,
        holderName: action.holderName || null,
        occurredAt: now, note: action.note || null,
      };
      const next = {
        ...state,
        keys: (state.keys || []).map((k) => (k.id === action.keyId
          ? { ...k, status: 'out', heldByUserId: action.holderUserId || null, heldByName: action.holderName || null, updatedAt: now }
          : k)),
        keyEvents: [...(state.keyEvents || []), evt],
      };
      // Tell the NEW holder a key is now in their name (self-checkouts are silent).
      const keyRec = next.keys.find((k) => k.id === action.keyId) || null;
      next.notifications = fanOutKeyNotification(next, { key: keyRec, holderUserId: action.holderUserId || null });
      return next;
    }
    case ACTIONS.CHECKIN_KEY: {
      const now = nowIso();
      const evt = {
        id: newId('kev'), keyId: action.keyId, kind: 'checkin',
        byUserId: state.currentUserId, occurredAt: now, note: action.note || null,
      };
      return {
        ...state,
        keys: (state.keys || []).map((k) => (k.id === action.keyId
          ? { ...k, status: 'in', heldByUserId: null, heldByName: null, updatedAt: now }
          : k)),
        keyEvents: [...(state.keyEvents || []), evt],
      };
    }
    // Manual status correction: the key's whereabouts are unclear — missing from
    // the lockbox, holder unconfirmed, possibly misplaced but likely recoverable.
    // Clears any holder and logs an auditable event like checkout/checkin do.
    // `lost` (below) is the harder, confirmed-gone signal. Returning to a known
    // state goes through CHECKIN_KEY / CHECKOUT_KEY.
    case ACTIONS.MARK_KEY_UNKNOWN: {
      const now = nowIso();
      const evt = {
        id: newId('kev'), keyId: action.keyId, kind: 'unknown',
        byUserId: state.currentUserId, occurredAt: now, note: action.note || null,
      };
      const next = {
        ...state,
        keys: (state.keys || []).map((k) => (k.id === action.keyId
          ? { ...k, status: 'unknown', heldByUserId: null, heldByName: null, updatedAt: now }
          : k)),
        keyEvents: [...(state.keyEvents || []), evt],
      };
      // A key going to an unknown state is a security/ops signal the office
      // needs — keyCustody only covers checkout-TO-you, so this was silent.
      const keyRec = next.keys.find((k) => k.id === action.keyId) || null;
      if (keyRec) {
        next.notifications = fanOutManagerAlert(next, {
          eventKey: 'keyLost',
          title: `Key ${keyRec.label || ''} marked unknown`.replace(/\s+/g, ' ').trim(),
          body: keyRec.clientName || '',
          url: '/keys',
          actorUserId: state.currentUserId,
        });
      }
      return next;
    }
    // Confirmed lost — the stronger sibling of MARK_KEY_UNKNOWN. Same shape
    // (clears holder, logs an auditable event, alerts managers) but its own
    // `lost` status/event kind so the Keys list can surface it in red and count
    // it apart from the softer "Unknown". Recovery still runs through CHECKIN /
    // CHECKOUT. Additive + default-safe (unknown readers bucket it as unknown),
    // so no storage-version bump is needed.
    case ACTIONS.MARK_KEY_LOST: {
      const now = nowIso();
      const evt = {
        id: newId('kev'), keyId: action.keyId, kind: 'lost',
        byUserId: state.currentUserId, occurredAt: now, note: action.note || null,
      };
      const next = {
        ...state,
        keys: (state.keys || []).map((k) => (k.id === action.keyId
          ? { ...k, status: 'lost', heldByUserId: null, heldByName: null, updatedAt: now }
          : k)),
        keyEvents: [...(state.keyEvents || []), evt],
      };
      const keyRec = next.keys.find((k) => k.id === action.keyId) || null;
      if (keyRec) {
        next.notifications = fanOutManagerAlert(next, {
          eventKey: 'keyLost',
          title: `Key ${keyRec.label || ''} reported LOST`.replace(/\s+/g, ' ').trim(),
          body: keyRec.clientName || '',
          url: '/keys',
          actorUserId: state.currentUserId,
        });
      }
      return next;
    }
    // REMOVED 2026-07-22 — `SWEEP_OVERDUE_KEYS`. Keys have no return window and no
    // due-back date/time: a key stays out until someone checks it in, and that is
    // not a condition anyone is alerted about. The old sweep fanned out a manager
    // `keyOverdue` alert past `opsSettings.keyOverdueDays` (14). Removed with its
    // catalog toggle, its ops setting, and the `{n}d overdue` chip on the Keys page.
    // Do not reintroduce an overdue/due-back concept here without the owner asking.
    // Lightweight per-inspection follow-up (assignee + done) for failed/needs-follow-up
    // records. Sparse: only inspections with a set assignee or done flag get a row;
    // clearing both prunes the row so the slice can't grow unbounded. The inspection
    // RECORD stays relational in Supabase — only this triage state rides the blob.
    case ACTIONS.SET_INSPECTION_FOLLOWUP: {
      const { inspectionId } = action;
      if (!inspectionId) return state;
      const rows = state.inspectionFollowUps || [];
      const existing = rows.find((r) => r.inspectionId === inspectionId) || null;
      const assigneeUserId = 'assigneeUserId' in action ? (action.assigneeUserId || null) : (existing?.assigneeUserId || null);
      const done = 'done' in action ? !!action.done : (existing?.done || false);
      const now = nowIso();
      // Empty row (no assignee, not done) → prune.
      if (!assigneeUserId && !done) {
        return { ...state, inspectionFollowUps: rows.filter((r) => r.inspectionId !== inspectionId) };
      }
      const row = {
        inspectionId,
        assigneeUserId,
        done,
        doneAt: done ? (existing?.done ? existing.doneAt : now) : null,
        updatedAt: now,
        updatedBy: state.currentUserId || null,
      };
      return {
        ...state,
        inspectionFollowUps: existing
          ? rows.map((r) => (r.inspectionId === inspectionId ? row : r))
          : [...rows, row],
      };
    }

    // ---------- Conversations / messages ----------
    case ACTIONS.ADD_CONVERSATION: {
      const now = nowIso();
      const base = {
        id: newId('cv'), channel: 'sms',
        createdAt: now, lastMessageAt: now,
        contactId: null, clientId: null, title: null,
        createdByUserId: action.conversation?.createdByUserId ?? state.currentUserId ?? null,
        starredByUserIds: [],
        mutedByUserIds: [],
      };
      return { ...state, conversations: [...state.conversations, { ...base, ...action.conversation }] };
    }
    case ACTIONS.ADD_DM_CONVERSATION: {
      const pair = Array.isArray(action.participantUserIds) ? [...action.participantUserIds] : [];
      if (pair.length !== 2) return state;
      if (pair[0] === pair[1]) return state; // self-DM guard
      const sorted = [...pair].sort();
      // Dedupe: if a DM between the same pair exists, don't create another.
      const existing = state.conversations.find((c) => {
        if (c.channel !== 'dm') return false;
        const p = (c.participantUserIds || []).slice().sort();
        return p.length === 2 && p[0] === sorted[0] && p[1] === sorted[1];
      });
      if (existing) return state;
      const now = nowIso();
      const conversation = {
        id: action.id || newId('cv'),
        channel: 'dm',
        participantUserIds: sorted,
        clientId: null,
        contactId: null,
        title: null,
        createdAt: now,
        lastMessageAt: now,
        createdByUserId: state.currentUserId || null,
        starredByUserIds: [],
        mutedByUserIds: [],
      };
      return { ...state, conversations: [...state.conversations, conversation] };
    }
    case ACTIONS.ADD_INTERNAL_CONVERSATION: {
      // Internal team thread — explicit member list (no implicit "everyone" anymore).
      // Permission gate (messaging.startInternalThread) is enforced at the call site,
      // not here. participantUserIds MUST be a non-empty list and MUST include the
      // creator — both invariants are kept here so a malformed dispatch can't slip
      // through and create an unreachable thread.
      const title = (action.title || '').trim();
      if (!title) return state;
      const creatorId = action.authorUserId || state.currentUserId || null;
      const incoming = Array.isArray(action.participantUserIds) ? action.participantUserIds : [];
      const participantSet = new Set(incoming);
      if (creatorId) participantSet.add(creatorId);
      const participantUserIds = Array.from(participantSet);
      if (participantUserIds.length === 0) return state;
      const id = action.id || newId('cv');
      const now = nowIso();
      const conversation = {
        id,
        channel: 'internal',
        contactId: null,
        clientId: null,
        title,
        participantUserIds,
        createdAt: now,
        lastMessageAt: now,
        createdByUserId: creatorId,
        starredByUserIds: [],
        mutedByUserIds: [],
      };
      const firstBody = (action.firstMessage || '').trim();
      const seedAuthorId = action.authorUserId || state.currentUserId || null;
      const messages = firstBody
        ? [
            ...state.messages,
            {
              id: newId('m'),
              conversationId: id,
              direction: 'internal',
              text: firstBody,
              authorUserId: seedAuthorId,
              snippetId: null,
              sentAt: now,
              readByUserIds: seedAuthorId ? [seedAuthorId] : [],
            },
          ]
        : state.messages;
      return {
        ...state,
        conversations: [...(state.conversations || []), conversation],
        messages,
      };
    }
    case ACTIONS.UPDATE_CONVERSATION:
      return { ...state, conversations: replaceById(state.conversations, action.id, action.patch) };
    case ACTIONS.RENAME_CONVERSATION: {
      // Retitle an internal team thread. Ownership is gated at the CALL SITE
      // (creator, or Super Admin when the thread is orphaned — selectCanRenameThread),
      // same division of labour as DELETE_CONVERSATION. What lives here are the
      // shape invariants, so a malformed dispatch can't blank a thread's name or
      // stamp a title onto a channel that doesn't have one: DMs derive their name
      // from the other participant, and on sms threads `title` doubles as the
      // fallback recipient phone (Messaging.jsx handleRetry) — writing a display
      // name there would break sending.
      const conv = (state.conversations || []).find((c) => c.id === action.id);
      if (!conv || conv.channel !== 'internal') return state;
      const title = (action.title || '').trim().slice(0, THREAD_TITLE_MAX);
      if (!title || title === conv.title) return state;
      return { ...state, conversations: replaceById(state.conversations, action.id, { title }) };
    }
    case ACTIONS.ADD_THREAD_PARTICIPANT: {
      // Adds a user to an internal thread's participantUserIds AND fans out a
      // notification to the added user — coupled in the reducer so callers
      // can't accidentally add someone without pinging them. Mirrors the
      // ADD_MESSAGE fan-out pattern: notification is stamped at action time
      // with the recipient's userId so it surfaces correctly when they switch
      // in. Only valid for internal threads — DMs are 2-person fixed and
      // external threads don't carry participantUserIds.
      const conv = state.conversations.find((c) => c.id === action.conversationId);
      if (!conv || conv.channel !== 'internal') return state;
      const current = conv.participantUserIds || [];
      if (current.includes(action.userId)) return state;
      const user = (state.users || []).find((u) => u.id === action.userId);
      if (!user) return state;
      const conversations = replaceById(state.conversations, action.conversationId, {
        participantUserIds: [...current, action.userId],
      });
      // Notification gated on the added user's prefs + visibility for the
      // 'newInternalMessage' event key — being added is a stronger signal
      // than a passive new message, so no separate toggle yet; if the user
      // wants internal-thread notifications, they want this too.
      let notifications = state.notifications || [];
      const eventKey = 'newInternalMessage';
      if (
        // Shared on/off resolver (opt-out for this key), matching every fan-out.
        isNotificationEnabled(user.notificationPrefs, eventKey)
        && isNotificationVisibleForUser(eventKey, user, state.permissions, state.userPermissionOverrides)
      ) {
        const adderId = action.addedByUserId || state.currentUserId;
        const adder = (state.users || []).find((u) => u.id === adderId);
        const adderName = adder?.name || 'Someone';
        const row = {
          id: newId('nt'),
          createdAt: nowIso(),
          readAt: null,
          userId: action.userId,
          eventKey,
          title: `${adderName} added you to ${conv.title || 'a channel'}`,
          body: '',
          url: `/messaging/${action.conversationId}`,
        };
        // Route through the shared cap helper (was a drifted inline copy hardcoding
        // 200 — it silently skipped the C22 cap-lower + TTL until this collapse).
        notifications = capInsert(notifications, action.userId, row);
      }
      return { ...state, conversations, notifications };
    }
    case ACTIONS.ADD_MESSAGE: {
      const incoming = action.message || {};
      // Auto-mark the message read for whoever wrote it — they don't need to
      // see their own send as unread. External inbound messages (no author)
      // start with an empty list so every user sees them as unread.
      const seedReadBy = Array.isArray(incoming.readByUserIds)
        ? incoming.readByUserIds
        : (incoming.authorUserId ? [incoming.authorUserId] : []);
      const base = {
        id: newId('m'), direction: 'out', sentAt: nowIso(),
        authorUserId: null, snippetId: null,
      };
      const msg = { ...base, ...incoming, readByUserIds: seedReadBy };

      // Fan out a per-recipient notification row for everyone who should be
      // pinged (shared helper — also used by RECEIVE_EMAIL + the server-side
      // cron ingest). Toast + tab title remain the listener's responsibility —
      // for the current viewer only.
      const conv = state.conversations.find((c) => c.id === msg.conversationId);
      const notifications = fanOutMessageNotifications(state, msg, conv);

      return {
        ...state,
        messages: [...state.messages, msg],
        // Keep conversation.lastMessageAt in sync so thread list sorts correctly.
        conversations: replaceById(state.conversations, msg.conversationId, { lastMessageAt: msg.sentAt }),
        notifications,
      };
    }
    case ACTIONS.MARK_CONVERSATION_READ: {
      const conv = state.conversations.find((c) => c.id === action.id);
      const uid = action.currentUserId || state.currentUserId;
      if (!uid) return state;
      const isDm = conv?.channel === 'dm';
      // Reading the thread also clears its bell rows — a message notification
      // points at /messaging/:id, so opening that thread marks those rows read
      // (the bell badge + tab title stop counting a thread you've already seen).
      const convUrl = `/messaging/${action.id}`;
      const readStamp = nowIso();
      return {
        ...state,
        notifications: (state.notifications || []).map((n) => (
          n.userId === uid && n.url === convUrl && !n.readAt ? { ...n, readAt: readStamp } : n
        )),
        messages: state.messages.map((m) => {
          if (m.conversationId !== action.id) return m;
          // Skip messages the viewer authored — own sends are always read.
          if (m.authorUserId === uid) return m;
          // For DMs, only flip messages authored by the other participant. For
          // external/internal, only flip inbound (direction='in') for external
          // and any non-author message for internal.
          if (isDm) {
            if (!m.authorUserId || m.authorUserId === uid) return m;
          } else if (conv?.channel !== 'internal' && m.direction !== 'in') {
            return m;
          }
          const list = m.readByUserIds || [];
          if (list.includes(uid)) return m;
          return { ...m, readByUserIds: [...list, uid] };
        }),
      };
    }
    case ACTIONS.MARK_CONVERSATION_UNREAD: {
      // Drop the viewer from readByUserIds on the most recent message they'd
      // count as unread, so the thread surfaces again with one unread badge.
      const conv = state.conversations.find((c) => c.id === action.id);
      const uid = action.currentUserId || state.currentUserId;
      if (!uid) return state;
      const isDm = conv?.channel === 'dm';
      const candidates = state.messages
        .filter((m) => {
          if (m.conversationId !== action.id) return false;
          if (m.authorUserId === uid) return false;
          if (isDm) return Boolean(m.authorUserId) && m.authorUserId !== uid;
          if (conv?.channel === 'internal') return m.authorUserId !== uid;
          return m.direction === 'in';
        })
        .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
      const target = candidates[0];
      if (!target) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === target.id
            ? { ...m, readByUserIds: (m.readByUserIds || []).filter((u) => u !== uid) }
            : m
        ),
      };
    }
    case ACTIONS.DELETE_CONVERSATION: {
      // Hard delete — call site MUST gate this to creator OR super-admin.
      const id = action.id;
      return {
        ...state,
        conversations: (state.conversations || []).filter((c) => c.id !== id),
        messages: (state.messages || []).filter((m) => m.conversationId !== id),
        // Drop bell rows deep-linking to the gone thread (DR-23) — else /messaging/{id}
        // survives as a dead link, exactly as DELETE_JOB guards /schedule/{id}.
        notifications: (state.notifications || []).filter((n) => n.url !== `/messaging/${id}`),
      };
    }

    // ---------- Snippets ----------
    case ACTIONS.ADD_SNIPPET: {
      const base = { id: newId('sn'), label: '', body: '', channel: 'all' };
      return { ...state, snippets: [...(state.snippets || []), { ...base, ...action.snippet }] };
    }
    case ACTIONS.UPDATE_SNIPPET:
      return { ...state, snippets: replaceById(state.snippets || [], action.id, action.patch) };
    case ACTIONS.DELETE_SNIPPET:
      return { ...state, snippets: (state.snippets || []).filter((s) => s.id !== action.id) };

    // ---------- Messaging Phase 2b ----------
    case ACTIONS.TOGGLE_CONVERSATION_STAR: {
      // Per-user pin: toggle membership of the current viewer in
      // starredByUserIds so each user maintains their own pinned list.
      const existing = state.conversations.find((c) => c.id === action.id);
      if (!existing) return state;
      const uid = action.userId || state.currentUserId;
      if (!uid) return state;
      const current = existing.starredByUserIds || [];
      const next = current.includes(uid)
        ? current.filter((u) => u !== uid)
        : [...current, uid];
      return { ...state, conversations: replaceById(state.conversations, action.id, { starredByUserIds: next }) };
    }
    case ACTIONS.TOGGLE_CONVERSATION_MUTE: {
      const existing = state.conversations.find((c) => c.id === action.id);
      if (!existing) return state;
      const current = existing.mutedByUserIds || [];
      const next = current.includes(action.userId)
        ? current.filter((uid) => uid !== action.userId)
        : [...current, action.userId];
      return { ...state, conversations: replaceById(state.conversations, action.id, { mutedByUserIds: next }) };
    }

    case ACTIONS.BULK_MARK_CONVERSATIONS_READ: {
      const set = new Set(action.ids || []);
      if (set.size === 0) return state;
      const uid = action.currentUserId || state.currentUserId;
      if (!uid) return state;
      const channelByConv = new Map(
        state.conversations.filter((c) => set.has(c.id)).map((c) => [c.id, c.channel])
      );
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (!set.has(m.conversationId)) return m;
          if (m.authorUserId === uid) return m;
          const channel = channelByConv.get(m.conversationId);
          if (channel === 'dm') {
            if (!m.authorUserId || m.authorUserId === uid) return m;
          } else if (channel !== 'internal' && m.direction !== 'in') {
            return m;
          }
          const list = m.readByUserIds || [];
          if (list.includes(uid)) return m;
          return { ...m, readByUserIds: [...list, uid] };
        }),
      };
    }
    case ACTIONS.BULK_MARK_CONVERSATIONS_UNREAD: {
      const set = new Set(action.ids || []);
      if (set.size === 0) return state;
      const uid = action.currentUserId || state.currentUserId;
      if (!uid) return state;
      const channelByConv = new Map(
        state.conversations.filter((c) => set.has(c.id)).map((c) => [c.id, c.channel])
      );
      // Drop the viewer from readByUserIds on each conv's most recent unread-eligible message.
      const targets = new Set();
      set.forEach((convId) => {
        const channel = channelByConv.get(convId);
        const candidates = state.messages
          .filter((m) => {
            if (m.conversationId !== convId) return false;
            if (m.authorUserId === uid) return false;
            if (channel === 'dm') return Boolean(m.authorUserId) && m.authorUserId !== uid;
            if (channel === 'internal') return m.authorUserId !== uid;
            return m.direction === 'in';
          })
          .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
        if (candidates[0]) targets.add(candidates[0].id);
      });
      return {
        ...state,
        messages: state.messages.map((m) =>
          targets.has(m.id)
            ? { ...m, readByUserIds: (m.readByUserIds || []).filter((u) => u !== uid) }
            : m
        ),
      };
    }
    case ACTIONS.BULK_DELETE_CONVERSATIONS: {
      // Hard delete — call site MUST gate this to creator OR super-admin per id.
      const set = new Set(action.ids || []);
      if (set.size === 0) return state;
      const deadThreadUrls = new Set([...set].map((cid) => `/messaging/${cid}`));
      return {
        ...state,
        conversations: (state.conversations || []).filter((c) => !set.has(c.id)),
        messages: (state.messages || []).filter((m) => !set.has(m.conversationId)),
        // Drop bell rows deep-linking to any gone thread (DR-23).
        notifications: (state.notifications || []).filter((n) => !deadThreadUrls.has(n.url)),
      };
    }

    // ---------- Client review (shared: sections / drafts / picks / decisions) ----------
    // One merge action drives every review surface (Drafts accept, Dashboard/Payroll
    // layout picks, per-nav approvals, build-decision answers). It rides the org_state
    // blob, so sign-offs sync to every seat instead of a single browser.
    //
    // ADDITIVE (CS-402, UI_RULES §130). A client sign-off must never be overwritten by a
    // stray click, so THE REDUCER — not just the UI — is the guarantee:
    //   • notes are ADD-ONLY: a note/notes field in the patch is STRIPPED here (notes go
    //     through ADD_CLIENT_REVIEW_NOTE);
    //   • a LOCKED entry (signed off in a DIFFERENT sitting) refuses any sign-off-field
    //     change unless action.confirm === true — otherwise the state is returned unchanged;
    //   • a confirmed change first appends the prior sign-off value to `history` (only ever
    //     grows), then applies the patch and stamps the new sitting;
    //   • a same-sitting edit (a misclick fix within one visit) needs no confirm and adds
    //     no history.
    case ACTIONS.UPDATE_CLIENT_REVIEW: {
      const { kind, id } = action; // kind ∈ REVIEW_KINDS (sections | drafts | picks | decisions)
      if (!REVIEW_KINDS.includes(kind) || !id) return state;
      // Notes are add-only — strip note/notes from any UPDATE patch.
      const patch = {};
      for (const [k, v] of Object.entries(action.patch || {})) {
        if (k === 'note' || k === 'notes') continue;
        patch[k] = v;
      }
      const review = state.clientReview || emptyReview();
      const bucket = review[kind] || {};
      const cur = bucket[id] || {};
      // No-op when nothing actually changes (also silences a notes-only patch stripped to {}
      // and an idempotent re-write), so `at` isn't restamped and no needless sync fires.
      const changed = Object.keys(patch).some((k) => !reviewFieldEq(patch[k], cur[k]));
      if (!changed) return state;

      const signoffFields = SIGNOFF_FIELDS[kind] || [];
      const changesSignoff = signoffFields.some((f) => f in patch && !reviewFieldEq(patch[f], cur[f]));
      const locked = isSignedOff(kind, cur) && !sameSitting(cur.sitting, action.sitting);
      // A locked sign-off change is refused without an explicit confirm — no silent override.
      if (locked && changesSignoff && action.confirm !== true) return state;

      const next = { ...cur, ...patch, at: nowIso() };
      if (action.sitting != null) next.sitting = action.sitting;
      // Keep the prior sign-off value on a confirmed change to a locked entry (grows only).
      if (locked && changesSignoff) {
        const prior = {};
        for (const f of signoffFields) if (f in cur) prior[f] = cur[f];
        next.history = [...(Array.isArray(cur.history) ? cur.history : []), { ...prior, at: cur.at ?? null, sitting: cur.sitting ?? null }];
      }
      return { ...state, clientReview: { ...review, [kind]: { ...bucket, [id]: next } } };
    }
    // Notes are ADD-ONLY: append { id, text, at } to the entry's `notes` array; empty/whitespace
    // text is ignored. Never touches a sign-off field or the entry's `sitting`, so adding a
    // note can't unlock a sign-off. A legacy single `note` string is left in place (shown as
    // the first note, never rewritten).
    //
    // IDEMPOTENT UNDER REPLAY (DATA_AND_SYNC §5 rule 3, II.7 — BOTH halves): the id is minted at
    // the DISPATCH site (ClientReviewProvider.addNote → newId('note')) and rides on the action,
    // so adoptRemote replaying a note the server already committed (a 12 s abort / 409 —
    // CS-026/CS-009) finds it here and no-ops. The `newId('note')` below is only the fallback
    // for a note dispatched with no id.
    case ACTIONS.ADD_CLIENT_REVIEW_NOTE: {
      const { kind, id, text } = action; // kind ∈ REVIEW_KINDS; a note attaches to any entry
      if (!REVIEW_KINDS.includes(kind) || !id) return state;
      if (typeof text !== 'string' || !text.trim()) return state;
      const noteId = action.noteId || newId('note');
      const review = state.clientReview || emptyReview();
      const bucket = review[kind] || {};
      const cur = bucket[id] || {};
      const notes = Array.isArray(cur.notes) ? cur.notes : [];
      if (notes.some((n) => n && n.id === noteId)) return state; // dedupe → replay is a no-op
      return {
        ...state,
        clientReview: {
          ...review,
          [kind]: { ...bucket, [id]: { ...cur, notes: [...notes, { id: noteId, text: text.trim(), at: nowIso() }] } },
        },
      };
    }
    // UNION the incoming review INTO the current slice: current entries WIN, ids are never
    // dropped, buckets never removed (add-only). The one-time localStorage migration is the
    // only writer (mergeReview preserves every bucket). Returns state unchanged when the
    // incoming review adds nothing new. (clearAll was removed — II.5.)
    case ACTIONS.SET_CLIENT_REVIEW: {
      const current = state.clientReview || emptyReview();
      const merged = mergeReview(current, action.review);
      return merged ? { ...state, clientReview: merged } : state;
    }

    // ---------- Reminders ----------
    case ACTIONS.UPDATE_REMINDER_TEMPLATE:
      return { ...state, reminderTemplates: replaceById(state.reminderTemplates, action.id, action.patch) };
    case ACTIONS.ADD_REMINDER_EVENT: {
      const base = { id: newId('re'), channel: 'sms', status: 'sent', attempts: 1, sentAt: nowIso(), readAt: null };
      const evt = { ...base, ...action.event };
      // Idempotent upsert by id: the scheduler uses a deterministic per-(job,
      // template) id, so a retry re-uses the row (bumping attempts) and a second
      // open tab computing the same id can't stack a duplicate event.
      const exists = (state.reminderEvents || []).some((e) => e.id === evt.id);
      let reminderEvents = exists
        ? state.reminderEvents.map((e) => (e.id === evt.id ? { ...e, ...action.event } : e))
        : [...(state.reminderEvents || []), evt];
      if (reminderEvents.length > REMINDER_EVENT_LIMIT) {
        reminderEvents = reminderEvents.slice(reminderEvents.length - REMINDER_EVENT_LIMIT);
      }
      return { ...state, reminderEvents };
    }
    case ACTIONS.UPDATE_REMINDER_EVENT: {
      // Patches delivery status (pending → sent / failed) + failureReason /
      // providerMessageId after the adapter resolves. On a genuine delivery
      // failure it also alerts the office ONCE (failed reminders used to be
      // fully silent — no bell/push/UI), skipping systemic setup + per-account
      // data-gap reasons (no email/phone, Twilio not provisioned) that would
      // otherwise flood, and de-duping via a failureAlerted flag so retries and
      // multi-tab updates don't re-ping.
      const prev = (state.reminderEvents || []).find((e) => e.id === action.id);
      const patch = action.patch || {};
      const merged = prev ? { ...prev, ...patch } : { ...patch };
      const shouldAlert = patch.status === 'failed'
        && !prev?.failureAlerted
        && !NON_ACTIONABLE_REMINDER_FAIL_RE.test(merged.failureReason || '');
      const finalPatch = shouldAlert ? { ...patch, failureAlerted: true } : patch;
      let next = { ...state, reminderEvents: replaceById(state.reminderEvents, action.id, finalPatch) };
      if (shouldAlert) {
        const job = (state.jobs || []).find((j) => j.id === merged.jobId);
        const client = (state.clients || []).find((c) => c.id === merged.clientId);
        const chan = merged.channel === 'sms' ? 'text' : 'email';
        next = {
          ...next,
          notifications: fanOutManagerAlert(next, {
            eventKey: 'reminderFailed',
            title: `Reminder ${chan} failed${client ? `. ${client.name}` : ''}`,
            body: merged.failureReason || 'A customer reminder could not be delivered.',
            url: job ? `/schedule/${job.id}` : '/schedule',
            actorUserId: null,
          }),
        };
      }
      return next;
    }
    case ACTIONS.MARK_REMINDER_EVENT_READ:
      return { ...state, reminderEvents: replaceById(state.reminderEvents, action.id, { readAt: nowIso() }) };
    case ACTIONS.MARK_REMINDER_EVENT_UNREAD:
      return { ...state, reminderEvents: replaceById(state.reminderEvents, action.id, { readAt: null }) };

    // ---------- Invitations ----------
    case ACTIONS.SEND_INVITATION: {
      const base = {
        id: newId('inv'),
        userId: action.userId,
        email: action.email,
        role: action.role || 'crew',
        invitedBy: action.invitedBy || state.currentUserId,
        token: `tok_${Math.random().toString(36).slice(2, 14)}`,
        status: 'pending',
        sentAt: nowIso(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        lastResentAt: null,
        resendCount: 0,
      };
      return { ...state, invitations: [...(state.invitations || []), base] };
    }
    case ACTIONS.RESEND_INVITATION: {
      const now = nowIso();
      return {
        ...state,
        invitations: (state.invitations || []).map((inv) =>
          inv.id === action.id
            ? {
                ...inv,
                lastResentAt: now,
                resendCount: (inv.resendCount || 0) + 1,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
              }
            : inv
        ),
      };
    }
    case ACTIONS.REVOKE_INVITATION: {
      const inv = (state.invitations || []).find((i) => i.id === action.id);
      if (!inv) return state;
      return {
        ...state,
        invitations: (state.invitations || []).map((i) =>
          i.id === action.id ? { ...i, status: 'revoked', revokedAt: nowIso() } : i
        ),
        users: state.users.map((u) =>
          u.id === inv.userId ? { ...u, status: 'inactive' } : u
        ),
      };
    }

    // ---------- Permissions ----------
    case ACTIONS.UPDATE_PERMISSION:
      return { ...state, permissions: replaceById(state.permissions, action.id, action.patch) };

    // ---------- Pipelines ----------
    case ACTIONS.ADD_PIPELINE: {
      const label = (action.label || '').trim();
      if (!label) return state;
      const id = newId('pl');
      const usedKeys = new Set(['won', 'lost']);
      const customStages = (action.stageLabels || [])
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean)
        .map((stageLabel) => {
          const baseKey = stageLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
          let key = baseKey;
          let n = 2;
          while (usedKeys.has(key)) { key = `${baseKey}-${n++}`; }
          usedKeys.add(key);
          return { id: newId('ps'), key, label: stageLabel };
        });
      const pipeline = {
        id,
        label,
        createdAt: nowIso(),
        stages: [
          ...customStages,
          { id: newId('ps'), key: 'won', label: 'Won' },
          { id: newId('ps'), key: 'lost', label: 'Lost' },
        ],
      };
      // Each pipeline is its own board with its own real stages. A new one is
      // appended and becomes active; the Master Pipeline is just the un-deletable
      // default, not a roll-up of the others.
      const pipelines = [...(state.pipelines || []), pipeline];
      return { ...state, pipelines, activePipelineId: id };
    }
    case ACTIONS.UPDATE_PIPELINE: {
      const label = (action.patch?.label || '').trim();
      if (!label) return state;
      const target = (state.pipelines || []).find((p) => p.id === action.id);
      if (target?.isMaster) return state; // the Master Pipeline can't be renamed
      const pipelines = (state.pipelines || []).map((p) =>
        p.id === action.id ? { ...p, label } : p
      );
      return { ...state, pipelines };
    }
    case ACTIONS.DELETE_PIPELINE: {
      const pipelines = state.pipelines || [];
      const target = pipelines.find((p) => p.id === action.id);
      if (!target) return state;
      if (target.isMaster) return state; // the Master Pipeline is un-deletable
      // Block while deals still sit on this board — the user moves or deletes
      // them first, so no opportunity is left orphaned off every pipeline.
      if ((state.opportunities || []).some((o) => o.pipelineId === action.id)) return state;
      const next = pipelines.filter((p) => p.id !== action.id);
      const activePipelineId = state.activePipelineId === action.id
        ? (next.find((p) => p.isMaster)?.id || next[0]?.id || null)
        : state.activePipelineId;
      // Clear reply-routing that pointed at the deleted pipeline (audit DR-21/22; owner:
      // clear it). The selector already null-guards, but a live pointer shouldn't dangle.
      const marketingSequences = (state.marketingSequences || []).map((s) => (
        s.replyRouting?.pipelineId === action.id
          ? { ...s, replyRouting: { ...s.replyRouting, pipelineId: null } } : s
      ));
      const marketingSettings = state.marketingSettings?.replyRouting?.pipelineId === action.id
        ? { ...state.marketingSettings, replyRouting: { ...state.marketingSettings.replyRouting, pipelineId: null } }
        : state.marketingSettings;
      return { ...state, pipelines: next, activePipelineId, marketingSequences, marketingSettings };
    }
    case ACTIONS.SET_ACTIVE_PIPELINE:
      return { ...state, activePipelineId: action.id };

    // ---------- Pipeline stages (scoped to pipeline) ----------
    case ACTIONS.ADD_PIPELINE_STAGE: {
      const pipelineId = action.pipelineId || state.activePipelineId;
      const label = (action.label || '').trim();
      if (!label) return state;
      const pipelines = (state.pipelines || []).map((p) => {
        if (p.id !== pipelineId) return p;
        const existing = p.stages || [];
        const baseKey = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
        let key = baseKey;
        let n = 2;
        while (existing.some((s) => s.key === key)) { key = `${baseKey}-${n++}`; }
        return { ...p, stages: [...existing, { id: newId('ps'), key, label }] };
      });
      return { ...state, pipelines };
    }
    case ACTIONS.UPDATE_PIPELINE_STAGE: {
      const pipelineId = action.pipelineId || state.activePipelineId;
      const label = (action.patch?.label || '').trim();
      if (!label) return state;
      const pipelines = (state.pipelines || []).map((p) => {
        if (p.id !== pipelineId) return p;
        return { ...p, stages: replaceById(p.stages || [], action.id, { label }) };
      });
      return { ...state, pipelines };
    }
    case ACTIONS.DELETE_PIPELINE_STAGE: {
      const pipelineId = action.pipelineId || state.activePipelineId;
      const pipeline = (state.pipelines || []).find((p) => p.id === pipelineId);
      if (!pipeline) return state;
      const target = (pipeline.stages || []).find((s) => s.id === action.id);
      if (!target) return state;
      const inUse = (state.contacts || []).some((c) => c.pipelineId === pipelineId && c.stage === target.key);
      if (inUse) return state;
      const pipelines = (state.pipelines || []).map((p) => {
        if (p.id !== pipelineId) return p;
        return { ...p, stages: (p.stages || []).filter((s) => s.id !== action.id) };
      });
      return { ...state, pipelines };
    }
    case ACTIONS.REORDER_PIPELINE_STAGES: {
      const pipelineId = action.pipelineId || state.activePipelineId;
      const ids = Array.isArray(action.ids) ? action.ids : [];
      const pipelines = (state.pipelines || []).map((p) => {
        if (p.id !== pipelineId) return p;
        const existing = p.stages || [];
        const map = Object.fromEntries(existing.map((s) => [s.id, s]));
        const ordered = ids.map((id) => map[id]).filter(Boolean);
        const leftover = existing.filter((s) => !ids.includes(s.id));
        return { ...p, stages: [...ordered, ...leftover] };
      });
      return { ...state, pipelines };
    }
    // ---------- Integrations / Twilio ----------
    case ACTIONS.CONNECT_TWILIO: {
      const tw = state.company.integrations?.twilio || {};
      const next = {
        ...tw,
        connected: true,
        accountSidLast4: action.accountSidLast4 || null,
        phoneNumber: action.phoneNumber || null,
        phoneNumberFriendlyName: action.phoneNumberFriendlyName || null,
        connectedAt: nowIso(),
        lastError: null,
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.DISCONNECT_TWILIO: {
      const tw = state.company.integrations?.twilio || {};
      const next = {
        ...tw,
        connected: false,
        accountSidLast4: null,
        phoneNumber: null,
        phoneNumberFriendlyName: null,
        connectedAt: null,
        lastError: null,
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.UPDATE_TWILIO_NUMBER: {
      const tw = state.company.integrations?.twilio || {};
      const next = {
        ...tw,
        phoneNumber: action.phoneNumber || null,
        phoneNumberFriendlyName: action.friendlyName || null,
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.UPDATE_TWILIO_WEBHOOK: {
      const tw = state.company.integrations?.twilio || {};
      const next = { ...tw, inboundWebhookUrl: action.url || null };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.UPDATE_TWILIO_ERROR: {
      const tw = state.company.integrations?.twilio || {};
      const next = { ...tw, lastError: action.error || null };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.SUBMIT_A2P: {
      const tw = state.company.integrations?.twilio || {};
      const a2p = tw.a2p || {};
      const next = {
        ...tw,
        a2p: {
          ...a2p,
          ...action.patch,
          status: 'pending',
          submittedAt: nowIso(),
          rejectionReason: null,
        },
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.UPDATE_A2P_STATUS: {
      const tw = state.company.integrations?.twilio || {};
      const a2p = tw.a2p || {};
      const patch = { status: action.status };
      if (action.status === 'approved') {
        patch.approvedAt = nowIso();
        patch.rejectionReason = null;
      }
      if (action.status === 'rejected') {
        patch.rejectionReason = action.rejectionReason || 'Not specified';
      }
      const next = { ...tw, a2p: { ...a2p, ...patch } };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }
    case ACTIONS.RESET_A2P: {
      const tw = state.company.integrations?.twilio || {};
      const next = {
        ...tw,
        a2p: {
          status: 'not_started',
          brandName: null,
          ein: null,
          businessAddress: null,
          useCase: null,
          sampleMessages: [],
          submittedAt: null,
          approvedAt: null,
          rejectionReason: null,
          notes: '',
        },
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), twilio: next },
        },
      };
    }

    // ---------- Integrations / Email Provider (Resend) ----------
    // System transactional sender wired by an admin in Settings → Integrations.
    // Per-user conversational email goes through Connected Inboxes (Phase 3),
    // not through these actions.
    case ACTIONS.CONNECT_EMAIL_PROVIDER: {
      const em = state.company.integrations?.email || {};
      const next = {
        ...em,
        connected: true,
        provider: action.provider || 'resend',
        apiKeyLast4: action.apiKeyLast4 || null,
        verifiedDomain: action.verifiedDomain || null,
        defaultFrom: action.defaultFrom || null,
        defaultReplyTo: action.defaultReplyTo || null,
        connectedAt: nowIso(),
        lastError: null,
        // Domain status starts as 'pending' on connect — DKIM records are
        // generated by the provider and the user has to add them to DNS.
        // The Settings card polls /email/health and dispatches
        // UPDATE_EMAIL_DOMAIN_STATUS as the records propagate.
        domain: {
          status: action.domainStatus || 'pending',
          dkimRecords: action.dkimRecords || [],
          spfStatus: action.spfStatus || null,
          dmarcStatus: action.dmarcStatus || null,
          lastCheckedAt: nowIso(),
          failureReason: null,
        },
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), email: next },
        },
      };
    }
    case ACTIONS.DISCONNECT_EMAIL_PROVIDER: {
      const em = state.company.integrations?.email || {};
      const next = {
        ...em,
        connected: false,
        provider: null,
        apiKeyLast4: null,
        verifiedDomain: null,
        defaultFrom: null,
        defaultReplyTo: null,
        connectedAt: null,
        lastVerifiedAt: null,
        lastError: null,
        domain: {
          status: 'not_started',
          dkimRecords: [],
          spfStatus: null,
          dmarcStatus: null,
          lastCheckedAt: null,
          failureReason: null,
        },
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), email: next },
        },
      };
    }
    case ACTIONS.UPDATE_EMAIL_DOMAIN_STATUS: {
      const em = state.company.integrations?.email || {};
      const prevDomain = em.domain || {};
      const patch = {
        ...prevDomain,
        ...(action.status !== undefined ? { status: action.status } : null),
        ...(action.dkimRecords !== undefined ? { dkimRecords: action.dkimRecords } : null),
        ...(action.spfStatus !== undefined ? { spfStatus: action.spfStatus } : null),
        ...(action.dmarcStatus !== undefined ? { dmarcStatus: action.dmarcStatus } : null),
        ...(action.failureReason !== undefined ? { failureReason: action.failureReason } : null),
        lastCheckedAt: nowIso(),
      };
      const next = {
        ...em,
        domain: patch,
        ...(action.status === 'verified' ? { lastVerifiedAt: nowIso(), lastError: null } : null),
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), email: next },
        },
      };
    }
    case ACTIONS.UPDATE_EMAIL_DEFAULT_FROM: {
      const em = state.company.integrations?.email || {};
      const next = {
        ...em,
        defaultFrom: action.defaultFrom ?? em.defaultFrom ?? null,
        defaultReplyTo: action.defaultReplyTo !== undefined ? action.defaultReplyTo : em.defaultReplyTo,
      };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), email: next },
        },
      };
    }
    case ACTIONS.UPDATE_EMAIL_ERROR: {
      const em = state.company.integrations?.email || {};
      const next = { ...em, lastError: action.error || null };
      return {
        ...state,
        company: {
          ...state.company,
          integrations: { ...(state.company.integrations || {}), email: next },
        },
      };
    }

    // ---------- Connected Inboxes (per-user) ----------
    // Backend creates the inbox record on the OAuth callback or after a
    // successful SMTP handshake; the frontend dispatches ADD_CONNECTED_INBOX
    // with the metadata returned. Tokens + SMTP passwords NEVER ride along
    // — they stay encrypted at rest on the backend.
    case ACTIONS.ADD_CONNECTED_INBOX: {
      const inboxes = Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [];
      const now = nowIso();
      const userId = action.userId;
      const provider = action.provider;
      if (!userId || !provider) return state;
      const id = action.id || newId('ci');
      // Auto-default the first connection for a user; explicit isDefault wins.
      const userHasOther = inboxes.some((i) => i.userId === userId);
      const isDefault = action.isDefault === true || !userHasOther;
      // If this row is becoming default, demote any other defaults for the user.
      const peers = isDefault
        ? inboxes.map((i) => (i.userId === userId ? { ...i, isDefault: false } : i))
        : inboxes;
      const next = {
        id,
        userId,
        provider,                                // 'google' | 'microsoft' | 'smtp'
        email: action.email || null,
        displayName: action.displayName || null,
        status: action.status || 'active',       // 'active' | 'expired' | 'error' | 'pending'
        connectedAt: now,
        lastSyncAt: null,
        lastError: null,
        isDefault,
        // SMTP-only metadata — null on OAuth providers.
        smtpHost: action.smtpHost || null,
        smtpPort: action.smtpPort || null,
        smtpSecurity: action.smtpSecurity || null, // 'ssl' | 'starttls' | 'none'
        imapHost: action.imapHost || null,
        imapPort: action.imapPort || null,
        imapSecurity: action.imapSecurity || null,
        // Inbound capability hint set by backend on connect (Phase 4c uses
        // this to decide which webhook/poll to wire). Until inbound is
        // implemented for the provider, this stays null.
        inboundCapability: action.inboundCapability || null, // 'pubsub' | 'graph' | 'imap_poll'
        inboundEnabled: false,
        // Which Google Workspace (oauthWorkspaces) issued this mailbox's OAuth
        // app. null on legacy single-app deployments with no registry.
        workspaceId: action.workspaceId || null,
      };
      return { ...state, connectedInboxes: [...peers, next] };
    }
    case ACTIONS.UPDATE_CONNECTED_INBOX: {
      const inboxes = Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [];
      const id = action.id;
      if (!id) return state;
      const patch = { ...action.patch };
      // Default-toggle handling: if patch sets isDefault: true, demote peers.
      if (patch.isDefault === true) {
        const target = inboxes.find((i) => i.id === id);
        if (target) {
          const peers = inboxes.map((i) =>
            i.userId === target.userId && i.id !== id ? { ...i, isDefault: false } : i
          );
          return {
            ...state,
            connectedInboxes: peers.map((i) => (i.id === id ? { ...i, ...patch } : i)),
          };
        }
      }
      return {
        ...state,
        connectedInboxes: inboxes.map((i) => (i.id === id ? { ...i, ...patch } : i)),
      };
    }
    case ACTIONS.REMOVE_CONNECTED_INBOX: {
      const inboxes = Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [];
      const id = action.id;
      if (!id) return state;
      const removed = inboxes.find((i) => i.id === id);
      const remaining = inboxes.filter((i) => i.id !== id);
      // If we removed the user's default, promote the most recently connected
      // remaining inbox for that user to default — UX nicety so the user
      // doesn't have to re-pick after disconnecting their only-default.
      if (removed?.isDefault) {
        const userInboxes = remaining
          .filter((i) => i.userId === removed.userId)
          .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1));
        if (userInboxes.length) {
          const promote = userInboxes[0].id;
          return {
            ...state,
            connectedInboxes: remaining.map((i) => (i.id === promote ? { ...i, isDefault: true } : i)),
          };
        }
      }
      return { ...state, connectedInboxes: remaining };
    }
    case ACTIONS.SET_DEFAULT_CONNECTED_INBOX: {
      const inboxes = Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [];
      const id = action.id;
      if (!id) return state;
      const target = inboxes.find((i) => i.id === id);
      if (!target) return state;
      return {
        ...state,
        connectedInboxes: inboxes.map((i) => {
          if (i.userId !== target.userId) return i;
          return { ...i, isDefault: i.id === id };
        }),
      };
    }

    // ---------- Google Workspaces (multi-Workspace OAuth registry) ----------
    // Super-admin registry of Google Workspace orgs, each wired to its own
    // Internal OAuth app. The client_secret never reaches client state — only
    // display metadata (label, domains, clientId, secret last4, status).
    case ACTIONS.ADD_OAUTH_WORKSPACE: {
      const list = Array.isArray(state.oauthWorkspaces) ? state.oauthWorkspaces : [];
      if (action.label == null) return state;
      const id = action.id || newId('ws');
      const next = {
        id,
        label: action.label,
        domains: Array.isArray(action.domains) ? action.domains : [],
        clientId: action.clientId || null,
        clientSecretLast4: action.clientSecretLast4 || null,
        status: action.status || 'pending', // 'active' | 'pending' | 'setup' | 'error'
        // First registered workspace becomes the primary unless told otherwise.
        isPrimary: action.isPrimary === true || list.length === 0,
        connectedAt: nowIso(),
        lastError: null,
      };
      return { ...state, oauthWorkspaces: [...list, next] };
    }
    case ACTIONS.UPDATE_OAUTH_WORKSPACE: {
      const list = Array.isArray(state.oauthWorkspaces) ? state.oauthWorkspaces : [];
      const id = action.id;
      if (!id || !action.patch) return state;
      return {
        ...state,
        oauthWorkspaces: list.map((w) => (w.id === id ? { ...w, ...action.patch } : w)),
      };
    }
    case ACTIONS.REMOVE_OAUTH_WORKSPACE: {
      const list = Array.isArray(state.oauthWorkspaces) ? state.oauthWorkspaces : [];
      const id = action.id;
      if (!id) return state;
      // Refuse to orphan mailboxes: block removal while ANY connected inbox OR marketing
      // rotation inbox still references this workspace (the UI disables the button too).
      // Was connected-inbox-only, so a workspace used solely by a marketing inbox could
      // be removed, orphaning that inbox (LW-03, live wiring audit 2026-09-20).
      if (oauthWorkspaceInUse(state, id)) return state;
      return { ...state, oauthWorkspaces: list.filter((w) => w.id !== id) };
    }

    // ---------- Inbound SMS routing ----------
    // Inbound SMS arrives via the deployment webhook. We try to match the from-number
    // to an existing contact's phone field; if no match, the conversation is created
    // unlinked (contactId: null) and surfaces as "needs linkage" in the inbox.
    case ACTIONS.RECEIVE_SMS: {
      const now = nowIso();
      const fromPhone = (action.fromPhone || '').trim();
      if (!fromPhone) return state;

      // Find existing contact by phone match (loose normalize: strip non-digits, compare last 10).
      const normalize = (p) => (p || '').replace(/\D+/g, '').slice(-10);
      const fromNorm = normalize(fromPhone);
      const matchContact = fromNorm
        ? (state.contacts || []).find((c) => normalize(c.phone) === fromNorm)
        : null;

      // Find existing open SMS conversation for this contact OR by phone-only thread title.
      const existing = state.conversations.find((c) => {
        if (c.channel !== 'sms') return false;
        if (matchContact && c.contactId === matchContact.id) return true;
        if (!matchContact && c.title === fromPhone) return true;
        return false;
      });

      let convId;
      let conversations;
      if (existing) {
        convId = existing.id;
        conversations = replaceById(state.conversations, existing.id, { lastMessageAt: now });
      } else {
        convId = newId('cv');
        const newConv = {
          id: convId,
          channel: 'sms',
          createdAt: now,
          lastMessageAt: now,
          contactId: matchContact?.id || null,
          clientId: matchContact?.companyId || null,
          title: matchContact ? null : fromPhone, // unlinked threads carry the raw number as title
          // Inbound thread — no human creator. Hard-delete is Super Admin only.
          createdByUserId: null,
          starredByUserIds: [],
          mutedByUserIds: [],
        };
        conversations = [...state.conversations, newConv];
      }

      const message = {
        id: newId('m'),
        conversationId: convId,
        direction: 'in',
        text: action.body || '',
        sentAt: now,
        readByUserIds: [],
        authorUserId: null,
        snippetId: null,
        deliveryStatus: 'received',
        twilioMessageSid: action.messageSid || null,
        fromPhone,
        toPhone: action.toPhone || null,
      };

      // Bell-row fan-out (NOTIF-02): an inbound client text pings every opted-in
      // owner/admin, exactly like an inbound email through RECEIVE_EMAIL. Without
      // this, a client SMS produced no bell row, no badge, and no OS push — only
      // a transient toast if a manager happened to have a tab open at that moment.
      const convForFanOut = conversations.find((c) => c.id === convId);
      const notifications = fanOutMessageNotifications(state, message, convForFanOut);

      return {
        ...state,
        conversations,
        messages: [...state.messages, message],
        notifications,
      };
    }

    case ACTIONS.SET_MESSAGE_DELIVERY: {
      // Update delivery status on an outbound message after the adapter resolves
      // (queued → sent → delivered / failed). Carries SMS-specific (twilio)
      // and email-specific (provider message id) refs so the UI can surface
      // them when investigating delivery issues.
      const patch = { deliveryStatus: action.status };
      if (action.twilioMessageSid) patch.twilioMessageSid = action.twilioMessageSid;
      if (action.emailMessageId) patch.emailMessageId = action.emailMessageId;
      if (action.failureReason) patch.failureReason = action.failureReason;
      // Stamp the real RFC Message-ID Gmail assigned onto emailHeaders so an
      // inbound reply's In-Reply-To matches this exact message (precise threading).
      if (action.rfcMessageId) {
        const msg = (state.messages || []).find((m) => m.id === action.id);
        patch.emailHeaders = { ...(msg?.emailHeaders || {}), messageId: action.rfcMessageId };
      }
      return { ...state, messages: replaceById(state.messages, action.id, patch) };
    }

    // ---------- Inbound email routing ----------
    // Mirrors RECEIVE_SMS for the email channel. Backend (Phase 4c) parses
    // the Gmail Pub/Sub / Microsoft Graph / IMAP-poll payload and dispatches
    // RECEIVE_EMAIL with the normalized envelope. Thread continuity is
    // established by:
    //   1. In-Reply-To header → existing message Message-ID lookup (best)
    //   2. From-address → contact.email match (auto-creates a thread)
    //   3. Otherwise unlinked (raw From address as title)
    case ACTIONS.RECEIVE_EMAIL: {
      const now = nowIso();
      const fromEmail = (action.fromEmail || '').trim().toLowerCase();
      if (!fromEmail) return state;
      const inReplyTo = action.inReplyTo || null;
      const subject = action.subject || null;
      const body = action.body || '';
      const messageId = action.messageId || null;
      const references = action.references || null;
      const toInboxEmail = action.toInboxEmail || null; // which connected-inbox received it

      // Idempotency — the same buffered reply can be re-polled (cursor reset, or
      // another device sharing org state). Skip if we've already stored it.
      if (messageId && (state.messages || []).some((m) => m.emailMessageId === messageId)) {
        return state;
      }

      // Strategy 1: In-Reply-To match — find the prior message whose
      // emailHeaders.messageId matches and reuse its conversation.
      let convId = null;
      if (inReplyTo) {
        const priorMsg = (state.messages || []).find(
          (m) => m.emailHeaders?.messageId === inReplyTo
        );
        if (priorMsg?.conversationId) convId = priorMsg.conversationId;
      }

      // Strategy 2: contact match by email.
      const matchContact = !convId
        ? (state.contacts || []).find((c) => (c.email || '').toLowerCase() === fromEmail)
        : null;

      let conversations;
      if (convId) {
        // Reuse existing thread — just bump lastMessageAt.
        conversations = replaceById(state.conversations, convId, { lastMessageAt: now });
      } else {
        // Find the thread this reply belongs to. Prefer a thread that already
        // carries email with this contact, so the reply lands with the emails
        // you sent — even if that thread's nominal channel is 'sms' (the compose
        // SMS/Email toggle records emails in-thread). Then a dedicated email
        // thread; otherwise create one below.
        const carriesEmail = (c) =>
          (state.messages || []).some(
            (m) => m.conversationId === c.id && (m.emailSubject || m.emailHeaders)
          );
        const existing = matchContact
          ? (state.conversations.find((c) => c.contactId === matchContact.id && carriesEmail(c))
            || state.conversations.find((c) => c.channel === 'email' && c.contactId === matchContact.id)
            // Last resort before creating: ANY thread for this contact. A reply
            // must join an existing thread — never spawn a new one for a known contact.
            || state.conversations.find((c) => c.contactId === matchContact.id))
          : state.conversations.find((c) => c.channel === 'email' && c.title === fromEmail);
        if (existing) {
          convId = existing.id;
          conversations = replaceById(state.conversations, existing.id, { lastMessageAt: now });
        } else {
          convId = newId('cv');
          const newConv = {
            id: convId,
            channel: 'email',
            createdAt: now,
            lastMessageAt: now,
            contactId: matchContact?.id || null,
            clientId: matchContact?.companyId || null,
            title: matchContact ? null : fromEmail, // unlinked threads carry the raw email as title
            createdByUserId: null,                  // inbound — no human creator
            status: 'open',
            snoozedUntil: null,
            starredByUserIds: [],
            mutedByUserIds: [],
          };
          conversations = [...state.conversations, newConv];
        }
      }

      const message = {
        id: newId('m'),
        conversationId: convId,
        direction: 'in',
        text: body,
        sentAt: now,
        readByUserIds: [],
        authorUserId: null,
        snippetId: null,
        deliveryStatus: 'received',
        // Email-specific fields — preserved for outbound replies to chain
        // off the same Message-ID / References tree.
        emailMessageId: messageId,
        emailHeaders: {
          messageId,
          inReplyTo,
          references,
        },
        emailSubject: subject,
        fromEmail,
        toInboxEmail,
      };

      // Bell-row fan-out (NOTIF-02): an inbound client email pings every
      // opted-in owner/admin, same as an inbound SMS through ADD_MESSAGE.
      // The cron ingest (api/_lib/ingestEmail.js) mirrors this for the
      // no-tab-open path; this covers live-tab delivery.
      const convForFanOut = conversations.find((c) => c.id === convId);
      const notifications = fanOutMessageNotifications(state, message, convForFanOut);

      return {
        ...state,
        conversations,
        messages: [...state.messages, message],
        notifications,
      };
    }

    // ---------- Marketing (v37) ----------
    // Company-shared rotation inboxes. Tokens stay backend-side; the frontend
    // only sees metadata. rotationOrder = max(existing) + 1 on add so connect
    // order = rotation order by default; user can manually reorder later.
    case ACTIONS.ADD_MARKETING_INBOX: {
      const inboxes = Array.isArray(state.marketingInboxes) ? state.marketingInboxes : [];
      const provider = action.provider;
      if (!provider) return state;
      const id = action.id || newId('mi');
      const maxOrder = inboxes.reduce((acc, i) => Math.max(acc, i.rotationOrder ?? 0), -1);
      const next = {
        id,
        provider,
        email: action.email || null,
        displayName: action.displayName || null,
        status: action.status || 'active',
        connectedAt: nowIso(),
        connectedByUserId: action.connectedByUserId || state.currentUserId || null,
        lastSyncAt: null,
        lastError: null,
        enabled: action.enabled !== false,            // default true
        rotationOrder: typeof action.rotationOrder === 'number' ? action.rotationOrder : maxOrder + 1,
        // Max emails this inbox sends per calendar day — a deliverability
        // guardrail the scheduler enforces. Default 10; user-adjustable.
        dailySendLimit: typeof action.dailySendLimit === 'number' ? action.dailySendLimit : 10,
        // Email signature block — inserted into step bodies via the
        // {signature} variable. Plain text / HTML; may contain {variables}.
        signature: typeof action.signature === 'string' ? action.signature : '',
        inboundCapability: action.inboundCapability || (provider === 'google' ? 'pubsub' : null),
        inboundEnabled: false,
        // Which Google Workspace (oauthWorkspaces) this rotation inbox routes
        // through. null on legacy single-app deployments.
        workspaceId: action.workspaceId || null,
      };
      return { ...state, marketingInboxes: [...inboxes, next] };
    }
    case ACTIONS.UPDATE_MARKETING_INBOX: {
      const inboxes = Array.isArray(state.marketingInboxes) ? state.marketingInboxes : [];
      if (!action.id) return state;
      return {
        ...state,
        marketingInboxes: inboxes.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i)),
      };
    }
    case ACTIONS.REMOVE_MARKETING_INBOX: {
      const inboxes = Array.isArray(state.marketingInboxes) ? state.marketingInboxes : [];
      if (!action.id) return state;
      const remaining = inboxes.filter((i) => i.id !== action.id);
      // Renumber rotationOrder so positions stay contiguous (0..n-1) after
      // removal. Keeps the modulo math predictable when sequences advance.
      const sorted = [...remaining].sort((a, b) => (a.rotationOrder ?? 0) - (b.rotationOrder ?? 0));
      const renumbered = sorted.map((i, idx) => ({ ...i, rotationOrder: idx }));
      return { ...state, marketingInboxes: renumbered };
    }
    case ACTIONS.REORDER_MARKETING_INBOXES: {
      const inboxes = Array.isArray(state.marketingInboxes) ? state.marketingInboxes : [];
      const ids = Array.isArray(action.ids) ? action.ids : [];
      if (ids.length === 0) return state;
      const byId = new Map(inboxes.map((i) => [i.id, i]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      const leftover = inboxes.filter((i) => !ids.includes(i.id));
      const final = [...ordered, ...leftover].map((i, idx) => ({ ...i, rotationOrder: idx }));
      return { ...state, marketingInboxes: final };
    }

    case ACTIONS.ADD_MARKETING_SEQUENCE: {
      const incoming = action.sequence || {};
      const name = (incoming.name || '').trim();
      if (!name) return state;
      const now = nowIso();
      const base = {
        id: incoming.id || newId('mseq'),
        name,
        status: incoming.status || 'draft',
        plainText: incoming.plainText === true,
        nextInboxIndex: 0,
        audienceMode: incoming.audienceMode === 'manual' ? 'manual' : 'auto',
        enrollmentSources: Array.isArray(incoming.enrollmentSources) ? incoming.enrollmentSources : [],
        onStageExit: incoming.onStageExit === 'unenroll' ? 'unenroll' : 'continue',
        // Drip stops for a contact who replies — default on; toggled per sequence.
        haltOnReply: incoming.haltOnReply !== false,
        // Where a reply moves the contact. Seeded from the global default in
        // marketingSettings; overridable per sequence in the editor.
        replyRouting:
          incoming.replyRouting && typeof incoming.replyRouting === 'object'
            ? incoming.replyRouting
            : { ...(state.marketingSettings?.replyRouting || { enabled: false, pipelineId: null, stageKey: null }) },
        // Tags applied to a contact when they reply. Per sequence; empty = none.
        replyTags: Array.isArray(incoming.replyTags) ? incoming.replyTags : [],
        // Per-sequence "Notify on reply" — operator explicitly picks a team
        // user to ping when a contact replies to this sequence. null = no
        // notification. inApp toggle gates whether the picked user gets a
        // notification row + bell badge. Email arm intentionally not wired
        // yet (Resend transactional path + DNS records still pending; see
        // HANDOFF backlog item).
        notifyOnReplyUserId:
          typeof incoming.notifyOnReplyUserId === 'string' && incoming.notifyOnReplyUserId
            ? incoming.notifyOnReplyUserId
            : null,
        notifyOnReplyChannels: {
          inApp: incoming.notifyOnReplyChannels?.inApp === true,
        },
        createdAt: now,
        createdByUserId: incoming.createdByUserId || state.currentUserId || null,
        updatedAt: now,
        steps: Array.isArray(incoming.steps) ? incoming.steps : [],
      };
      return { ...state, marketingSequences: [...(state.marketingSequences || []), base] };
    }
    case ACTIONS.UPDATE_MARKETING_SEQUENCE: {
      const seqs = state.marketingSequences || [];
      if (!action.id) return state;
      return {
        ...state,
        marketingSequences: seqs.map((s) => (s.id === action.id ? { ...s, ...action.patch, updatedAt: nowIso() } : s)),
      };
    }
    case ACTIONS.DELETE_MARKETING_SEQUENCE: {
      const id = action.id;
      if (!id) return state;
      return {
        ...state,
        marketingSequences: (state.marketingSequences || []).filter((s) => s.id !== id),
        marketingEnrollments: (state.marketingEnrollments || []).filter((e) => e.sequenceId !== id),
        marketingSends: (state.marketingSends || []).filter((sd) => sd.sequenceId !== id),
        marketingReplies: (state.marketingReplies || []).filter((r) => r.sequenceId !== id),
      };
    }

    case ACTIONS.ADD_MARKETING_STEP: {
      const { sequenceId } = action;
      if (!sequenceId) return state;
      const seqs = state.marketingSequences || [];
      return {
        ...state,
        marketingSequences: seqs.map((s) => {
          if (s.id !== sequenceId) return s;
          const existing = Array.isArray(s.steps) ? s.steps : [];
          const incoming = action.step || {};
          const order = typeof incoming.order === 'number' ? incoming.order : existing.length;
          const sw = state.marketingSettings?.defaultSendWindow || { start: 9, end: 17 };
          // Wait-before-send in minutes — supports an hourly cadence, not just
          // whole days. Back-compat: accept a legacy whole-day daysAfterPrevious
          // (×1440). Default 0 for step 0 (fires on enrollment), else 3 days.
          const delayMinutes = Number.isFinite(Number(incoming.delayMinutes))
            ? Math.max(0, Number(incoming.delayMinutes))
            : (Number.isFinite(Number(incoming.daysAfterPrevious))
              ? Math.max(0, Number(incoming.daysAfterPrevious)) * 1440
              : (order === 0 ? 0 : 3 * 1440));
          const step = {
            id: incoming.id || newId('mstep'),
            order,
            delayMinutes,
            // Coarse whole-day mirror so a client still on the pre-hourly build
            // degrades safely — it waits the rounded-up day count instead of
            // reading an absent field as 0 and firing immediately. Drop once
            // every client is on the hourly build.
            daysAfterPrevious: Math.ceil(delayMinutes / 1440),
            sendHourStart: typeof incoming.sendHourStart === 'number' ? incoming.sendHourStart : sw.start,
            sendHourEnd: typeof incoming.sendHourEnd === 'number' ? incoming.sendHourEnd : sw.end,
            subject: incoming.subject || '',
            body: incoming.body || '',
            attachments: Array.isArray(incoming.attachments) ? incoming.attachments : [],
          };
          return { ...s, steps: [...existing, step], updatedAt: nowIso() };
        }),
      };
    }
    case ACTIONS.UPDATE_MARKETING_STEP: {
      const { sequenceId, stepId, patch } = action;
      if (!sequenceId || !stepId) return state;
      const seqs = state.marketingSequences || [];
      return {
        ...state,
        marketingSequences: seqs.map((s) => {
          if (s.id !== sequenceId) return s;
          const steps = (s.steps || []).map((st) => (st.id === stepId ? { ...st, ...patch } : st));
          return { ...s, steps, updatedAt: nowIso() };
        }),
      };
    }
    case ACTIONS.DELETE_MARKETING_STEP: {
      const { sequenceId, stepId } = action;
      if (!sequenceId || !stepId) return state;
      const seqs = state.marketingSequences || [];
      return {
        ...state,
        marketingSequences: seqs.map((s) => {
          if (s.id !== sequenceId) return s;
          const filtered = (s.steps || []).filter((st) => st.id !== stepId);
          // Renumber `order` on survivors so the embedded array index === order.
          const renumbered = filtered.map((st, idx) => ({ ...st, order: idx }));
          return { ...s, steps: renumbered, updatedAt: nowIso() };
        }),
      };
    }
    case ACTIONS.REORDER_MARKETING_STEPS: {
      const { sequenceId } = action;
      const ids = Array.isArray(action.ids) ? action.ids : [];
      if (!sequenceId || ids.length === 0) return state;
      const seqs = state.marketingSequences || [];
      return {
        ...state,
        marketingSequences: seqs.map((s) => {
          if (s.id !== sequenceId) return s;
          const byId = new Map((s.steps || []).map((st) => [st.id, st]));
          const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
          const leftover = (s.steps || []).filter((st) => !ids.includes(st.id));
          const final = [...ordered, ...leftover].map((st, idx) => ({ ...st, order: idx }));
          return { ...s, steps: final, updatedAt: nowIso() };
        }),
      };
    }

    case ACTIONS.ADVANCE_SEQUENCE_INBOX_INDEX: {
      const { sequenceId } = action;
      if (!sequenceId) return state;
      const seqs = state.marketingSequences || [];
      return {
        ...state,
        marketingSequences: seqs.map((s) =>
          s.id === sequenceId ? { ...s, nextInboxIndex: (s.nextInboxIndex || 0) + 1 } : s
        ),
      };
    }

    case ACTIONS.ENROLL_CONTACTS: {
      const { sequenceId } = action;
      const contactIds = Array.isArray(action.contactIds) ? action.contactIds : [];
      if (!sequenceId || contactIds.length === 0) return state;
      const enrollments = state.marketingEnrollments || [];
      // Dedup-safe: skip contacts that already have a non-terminal enrollment
      // (active / replied / completed) on this sequence.
      const blockedStatuses = new Set(['active', 'replied', 'completed']);
      const existingActiveIds = new Set(
        enrollments
          .filter((e) => e.sequenceId === sequenceId && blockedStatuses.has(e.status))
          .map((e) => e.contactId)
      );
      const now = nowIso();
      // source: 'manual' (the human added them) or 'auto' (the marketing
      // scheduler pulled them in from a configured pipeline stage). Defaults
      // to 'manual' since every UI surface that dispatches ENROLL_CONTACTS
      // is the operator manually adding; auto-pull passes source: 'auto'
      // explicitly. Used downstream to keep manual adds sticky against
      // onStageExit: 'unenroll' (see getStaleEnrollments).
      const source = action.source === 'auto' ? 'auto' : 'manual';
      // Honor the suppression list AND per-contact Do-Not-Contact — never
      // (re)enroll a globally opted-out email or a DNC contact.
      const suppressedEmails = buildSuppressedEmailSet(state);
      const contactOf = (cid) => (state.contacts || []).find((x) => x.id === cid);
      const emailOfContact = (cid) => (contactOf(cid)?.email || '').toLowerCase();
      const fresh = contactIds
        .filter((cid) => cid && !existingActiveIds.has(cid)
          && !isDoNotContact(contactOf(cid))
          && !(suppressedEmails.size > 0 && suppressedEmails.has(emailOfContact(cid))))
        .map((cid) => ({
          id: newId('menr'),
          sequenceId,
          contactId: cid,
          enrolledAt: now,
          source,
          currentStepIndex: 0,
          status: 'active',
          lastSentAt: null,
          repliedAt: null,
        }));
      if (fresh.length === 0) return state;
      return { ...state, marketingEnrollments: [...enrollments, ...fresh] };
    }
    case ACTIONS.UNENROLL_CONTACT: {
      const { enrollmentId } = action;
      if (!enrollmentId) return state;
      return {
        ...state,
        marketingEnrollments: (state.marketingEnrollments || []).map((e) =>
          e.id === enrollmentId
            ? { ...e, status: 'unenrolled' }
            : e
        ),
      };
    }
    case ACTIONS.ADVANCE_ENROLLMENT_STEP: {
      const { enrollmentId, sentAt } = action;
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

    case ACTIONS.RECORD_MARKETING_SEND: {
      const incoming = action.send || {};
      if (!incoming.enrollmentId || !incoming.stepId) return state;
      const base = {
        id: incoming.id || newId('msnd'),
        status: 'pending',
        attemptedAt: nowIso(),
        sentAt: null,
        providerMessageId: null,
        failureReason: null,
      };
      return {
        ...state,
        marketingSends: [...(state.marketingSends || []), { ...base, ...incoming }],
      };
    }
    case ACTIONS.UPDATE_MARKETING_SEND: {
      if (!action.id) return state;
      return {
        ...state,
        marketingSends: (state.marketingSends || []).map((sd) =>
          sd.id === action.id ? { ...sd, ...action.patch } : sd
        ),
      };
    }
    case ACTIONS.RETRY_MARKETING_SEND: {
      // Remove the failed send so hasSent() is false and the scheduler re-fires
      // this (enrollment, step). The enrollment never advanced on failure, so it
      // still sits at the right step; the Diagnostics UI clears the in-flight
      // guard for the same key alongside this.
      if (!action.id) return state;
      return {
        ...state,
        marketingSends: (state.marketingSends || []).filter((sd) => sd.id !== action.id),
      };
    }
    case ACTIONS.RECEIVE_MARKETING_REPLY: {
      const now = nowIso();
      const fromEmail = (action.fromEmail || '').trim().toLowerCase();
      const enrollments = state.marketingEnrollments || [];
      const sequences = state.marketingSequences || [];
      const contacts = state.contacts || [];
      const replies = state.marketingReplies || [];

      // Idempotency — don't double-record if a provider id replays.
      if (action.id && replies.some((r) => r.id === action.id)) return state;

      // Resolve the enrollment: explicit id first (the marketing send stamps
      // X-CleanSpace-Marketing-Enrollment-Id), then a from-email contact match.
      let enrollment = action.enrollmentId
        ? enrollments.find((e) => e.id === action.enrollmentId) || null
        : null;
      if (!enrollment && fromEmail) {
        const contact = contacts.find((c) => (c.email || '').toLowerCase() === fromEmail);
        if (contact) {
          const owned = enrollments.filter((e) => e.contactId === contact.id);
          enrollment =
            owned.find((e) => !e.repliedAt && (e.status === 'active' || e.status === 'completed')) ||
            owned[0] ||
            null;
        }
      }
      const sequence = enrollment
        ? sequences.find((s) => s.id === enrollment.sequenceId) || null
        : null;
      const contactId = enrollment ? enrollment.contactId : null;

      // 1. Record the reply row. Triage-classify it (human / auto-reply / bounce
      // / unsubscribe) at record time so the Replies inbox can bucket without
      // re-scanning; additive field, defaults to a live classify for old rows.
      const reply = {
        id: action.id || newId('mrep'),
        enrollmentId: enrollment ? enrollment.id : null,
        sequenceId: sequence ? sequence.id : null,
        contactId,
        fromEmail: fromEmail || null,
        subject: String(action.subject || '').slice(0, 300),
        body: String(action.body || '').slice(0, 4000), // SCALE-02: cap inline body to bound org_state growth
        receivedAt: action.receivedAt || now,
        status: 'new',
        category: classifyReply({ subject: action.subject, body: action.body, fromEmail }).category,
      };

      // 2. Halt the enrollment when the sequence opts in (haltOnReply default on).
      let nextEnrollments = enrollments;
      if (enrollment && sequence && sequence.haltOnReply !== false) {
        nextEnrollments = enrollments.map((e) =>
          e.id === enrollment.id && !e.repliedAt
            ? { ...e, repliedAt: now, status: 'replied' }
            : e
        );
      }

      // 3. Route the reply per the sequence's reply-routing config: advance the
      //    replying contact's company DEAL to the target stage. A person is never on
      //    a pipeline, so this moves the company's open Opportunity, not the person.
      let nextContacts = contacts;
      let nextOpportunities = state.opportunities || [];
      let nextClientActivities = state.clientActivities || [];
      const rr = sequence ? (sequence.replyRouting || {}) : {};
      if (contactId && rr.enabled && rr.pipelineId && rr.stageKey) {
        const pipeline = (state.pipelines || []).find((p) => p.id === rr.pipelineId);
        const stageExists = !!pipeline && (pipeline.stages || []).some((st) => st.key === rr.stageKey);
        const contact = contacts.find((c) => c.id === contactId);
        const companyId = contact?.companyId || null;
        // The deal to advance: the open opportunity this contact is the primary of,
        // else the company's first open opportunity.
        const deal = companyId
          ? (nextOpportunities.find((o) => o.status === 'open' && o.clientId === companyId && o.primaryContactId === contactId)
              || nextOpportunities.find((o) => o.status === 'open' && o.clientId === companyId))
          : null;
        if (stageExists && deal && deal.stage !== rr.stageKey) {
          const status = rr.stageKey === 'won' ? 'won' : rr.stageKey === 'lost' ? 'lost' : 'open';
          nextOpportunities = nextOpportunities.map((o) =>
            o.id === deal.id
              ? { ...o, stage: rr.stageKey, pipelineId: rr.pipelineId, status, stageChangedAt: now, updatedAt: now }
              : o
          );
          nextClientActivities = [
            ...nextClientActivities,
            {
              id: newId('clact'),
              clientId: companyId,
              kind: 'stage_change',
              authorUserId: null, // system action — automated reply routing
              body: `Deal stage: ${deal.stage || 'none'} -> ${rr.stageKey}`,
              occurredAt: now,
              createdAt: now,
            },
          ];
        }
      }

      // 4. Notify the assigned user (per-sequence "Notify on reply"). The
      // operator explicitly picked this user for this sequence — write the
      // bell-inbox row directly (no notification-prefs gate; the per-sequence
      // pick IS the gate). Email arm intentionally not wired yet.
      let nextNotifications = state.notifications || [];
      const notifyUserId = sequence?.notifyOnReplyUserId || null;
      const notifyInApp = sequence?.notifyOnReplyChannels?.inApp === true;
      if (notifyUserId && notifyInApp && sequence) {
        const targetUser = (state.users || []).find((u) => u.id === notifyUserId);
        // The operator explicitly picked this user for this sequence (that pick
        // IS the gate), but still respect an active account + an explicit opt-out
        // of the marketingReplyAssigned toggle (default on / absent = on).
        if (targetUser
          && targetUser.status === 'active'
          && (targetUser.notificationPrefs || {}).marketingReplyAssigned !== false) {
          const contact = contactId ? nextContacts.find((c) => c.id === contactId) : null;
          const contactName = contact
            ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email || 'a contact'
            : (fromEmail || 'a contact');
          const row = {
            id: newId('nt'),
            createdAt: now,
            readAt: null,
            userId: targetUser.id,
            eventKey: 'marketingReplyAssigned',
            title: `${contactName} replied to "${sequence.name}"`,
            body: (action.body || '').replace(/\s+/g, ' ').trim().slice(0, 90),
            url: '/marketing?tab=replies',
          };
          nextNotifications = capInsert(nextNotifications, targetUser.id, row);
        }
      }

      // 5. Apply the sequence's reply tags to the contact.
      const replyTags = sequence && Array.isArray(sequence.replyTags) ? sequence.replyTags : [];
      if (contactId && replyTags.length > 0) {
        nextContacts = nextContacts.map((c) => {
          if (c.id !== contactId) return c;
          const have = c.tagIds || [];
          const merged = [...have];
          for (const tid of replyTags) {
            if (tid && !merged.includes(tid)) merged.push(tid);
          }
          return merged.length === have.length ? c : { ...c, tagIds: merged, updatedAt: now };
        });
      }

      // 6. Auto opt-out: if the reply matches an unsubscribe phrase (subject or
      // body), add the sender's email to the suppression list so it's never
      // marketed to again. Shares OPT_OUT_RE with the triage classifier, so the
      // 'unsubscribe' bucket and the CAN-SPAM suppress always agree.
      let nextSuppressions = state.marketingSuppressions || [];
      if (fromEmail && (OPT_OUT_RE.test(action.body || '') || OPT_OUT_RE.test(action.subject || ''))) {
        if (!nextSuppressions.some((s) => (s.email || '').toLowerCase() === fromEmail)) {
          nextSuppressions = [
            ...nextSuppressions,
            { email: fromEmail, source: 'reply', reason: 'Auto-detected opt-out in reply', createdAt: now },
          ];
        }
      }

      return {
        ...state,
        marketingReplies: [...replies, reply],
        marketingEnrollments: nextEnrollments,
        contacts: nextContacts,
        opportunities: nextOpportunities,
        clientActivities: nextClientActivities,
        notifications: nextNotifications,
        marketingSuppressions: nextSuppressions,
      };
    }
    case ACTIONS.ADD_MARKETING_SUPPRESSION: {
      const email = (action.email || '').trim().toLowerCase();
      if (!email) return state;
      const list = state.marketingSuppressions || [];
      if (list.some((s) => (s.email || '').toLowerCase() === email)) return state;
      return {
        ...state,
        marketingSuppressions: [
          ...list,
          { email, source: action.source || 'manual', reason: action.reason || null, createdAt: nowIso() },
        ],
      };
    }
    case ACTIONS.REMOVE_MARKETING_SUPPRESSION: {
      const email = (action.email || '').trim().toLowerCase();
      if (!email) return state;
      return {
        ...state,
        marketingSuppressions: (state.marketingSuppressions || []).filter(
          (s) => (s.email || '').toLowerCase() !== email
        ),
      };
    }
    case ACTIONS.UPDATE_MARKETING_REPLY: {
      if (!action.id) return state;
      return {
        ...state,
        marketingReplies: (state.marketingReplies || []).map((r) =>
          r.id === action.id ? { ...r, ...action.patch } : r
        ),
      };
    }
    case ACTIONS.RESUME_ENROLLMENT: {
      const { enrollmentId } = action;
      if (!enrollmentId) return state;
      // Clears a reply-halt — only un-halts an enrollment that was halted by
      // a reply (status 'replied'); completed/unenrolled rows are left alone.
      return {
        ...state,
        marketingEnrollments: (state.marketingEnrollments || []).map((e) =>
          e.id === enrollmentId && e.status === 'replied'
            ? { ...e, repliedAt: null, status: 'active' }
            : e
        ),
      };
    }

    case ACTIONS.UPDATE_MARKETING_SETTINGS: {
      const prev = state.marketingSettings || {};
      const patch = action.patch || {};
      const next = {
        ...prev,
        ...patch,
        replyRouting: {
          ...(prev.replyRouting || {}),
          ...(patch.replyRouting || {}),
        },
        defaultSendWindow: {
          ...(prev.defaultSendWindow || {}),
          ...(patch.defaultSendWindow || {}),
        },
        unsubscribe: {
          ...(prev.unsubscribe || {}),
          ...(patch.unsubscribe || {}),
        },
      };
      return { ...state, marketingSettings: next };
    }

    default:
      return state;
  }
}

function nextInvoiceId(state) {
  const prefix = state.company.invoicePrefix || 'INV';
  const numbers = state.invoices
    .map((inv) => {
      const m = String(inv.id).match(new RegExp(`^${prefix}-(\\d+)$`));
      return m ? Number(m[1]) : 0;
    })
    .filter(Boolean);
  const next = (numbers.length ? Math.max(...numbers) : 1000) + 1;
  return `${prefix}-${next}`;
}
