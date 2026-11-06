// Operational-alert detection — PURE, node-safe (its one import is the equally pure
// checklist rule module, with the explicit `.js` the serverless cron's cold import needs
// — CS-011), so the "is this shift late / missed" logic is identical in the client tick
// (components/OpsAlertScheduler.jsx) and, at go-live, the server cron. Same split as
// opsAlertApply.js vs OpsAlertScheduler.jsx.
//
// Scope (this file): the MISSED-SHIFT alert (contract item "Late & missed-shift
// triggers: automatic alerts the moment a cleaner is late, has not arrived, or missed a
// shift"). Checklist / inspection reminders land alongside as more detectors.
//
// 🔴 ALR-11 (Matt, 2026-09-30): "One alert 30 minutes after the start with no clock-in:
// that's a missed shift, and the supervisor gets a notification and a text." There used
// to be TWO — a "late" one 10 minutes after the start and a "missed" one 15 minutes
// after the scheduled END. Both are gone, replaced by this one, timed
// off the START so a four-hour clean nobody turned up for is raised at 30 minutes rather
// than four and a half hours in. `missedAfterStartMins` is the ONE number, and everything
// that counts a missed clean reads it: this walker, `isMissedClean` (the Dashboard KPI),
// and the attendance report's "No punch".
//
// Recipients + delivery are NOT decided here — the walker only says WHICH shifts are
// due for WHICH kind of alert (with a deterministic id for once-only firing). The
// reducer routes each to the account supervisor via fanOutAccountAlert.

import { checklistFor, hasCompleteChecklistFor, completeChecklistIndex } from './crewChecklist.js';
import { resolveJobCrewIds } from './crewResolve.js';
// The org-zone day key, for the calendar-month walkers (SUP-8 / SUP-10). `dayKey` here is
// a LOCAL helper that keys off UTC for the checklist episode ids, so dates' one is aliased.
// lib/dates is as pure and node-safe as this module (lib/opsAlertCopy already imports it
// for the cron), and the zone is passed in explicitly rather than read from its module
// state, because the cron never calls setOrgTimezone.
import { dayKey as orgDayKey } from './dates.js';
import {
  supplyStatusOf, SUPPLY_STATUS, supplyOrderDayFor, supplyBudgetFor, supplyDeliveries, supplyToCents, isSupplyBuilding,
} from './supplies.js';
// CS-683: the ONE "is this a building we clean now?" rule (Inactive and Archived out), read by
// every walker below, the cron's reads and the manager Home's count.
import { isActiveBuilding } from './customerStatus.js';

// Defaults an operator can retune in Settings > Operations (opsSettings). Kept here as
// the single source so the walker, the seed, and the settings form agree.
export const OPS_ALERT_DEFAULTS = {
  // 🔴 ALR-11: minutes past the scheduled START with no clock-in by ANYONE on the clean
  // before it is a MISSED shift. Matt's number is 30. The only shift-alert timing there is.
  missedAfterStartMins: 30,
  shiftAlertLookbackHours: 24, // only shifts this recent can alert (back-blast guard)
  // SUP-8 (Matt, 2026-09-29): the day of the month each building should order supplies on.
  // The ORG default; a building may carry its own `supplyOrderDayOfMonth` ("adjustable per
  // building"). Capped at 28 so every month has the day (lib/supplies MAX_SUPPLY_ORDER_DAY).
  supplyOrderDayOfMonth: 1,
  // SUP-9 ★a: who approves a supply request. null = the BUILDING'S SUPERVISOR (the default
  // Matt's follow-up is expected to confirm); a user id names one person for the whole org
  // instead, so his answer is a settings change and not a build.
  supplyApproverUserId: null,
  // #3 reminders
  // 🔴 ALR-10 (Matt, 2026-09-29): "one hour before their shift ends, the cleaner should be
  // reminded to complete the checklist, or they won't be able to clock out." So the nudge is
  // timed off the scheduled END, not the start — a cleaner on a 3-hour clean used to be
  // nudged at start+60, two hours before it could possibly matter, and one on a 45-minute
  // clean was nudged after it had already ended. REPLACES `checklistReminderGraceMins`
  // (deleted, II.5). The supervisor ESCALATION after the end is unchanged.
  checklistReminderBeforeEndMins: 60,
  checklistEscalateGraceMins: 60,   // after end with still no checklist → escalate to supervisor
  inspectionReminderDays: 14,       // an account not inspected within this many days is due
  // (ALR-4's org-wide `operationsManagerUserId` was REMOVED by ALR-12, 2026-09-30: Matt's
  // follow-up names the person copied on every missed alert as "the account manager /
  // supervisor of the account", which is `client.supervisorId` — already a recipient. A
  // second, org-wide picker for the same person was a setting that could only be wrong.)
  // 🔴 ALR-5 (Matt, 2026-09-29): "Should cleaners get a reminder before each shift? —
  // (a) Yes, 30 minutes before." ★ Minutes BEFORE the scheduled start; 0 turns it off. The
  // walker is lib/preShiftReminders (a PUSH, never a bell row per cleaner per shift).
  preShiftReminderMins: 30,
};

// Jobs in these statuses are finished/void — never late or missed.
const TERMINAL_JOB = new Set(['done', 'completed', 'cancelled', 'canceled']);
const MIN = 60 * 1000;
// Shift length assumed when a job carries no endAt. EXPORTED because the Assignments
// screen's overdue walk (lib/checklistAssignments) must time its nudge point exactly as the
// reminder does (ALR-10 moved that point to the scheduled END), and a second copy of this
// number would put the two answers minutes apart on a clean with no end time.
export const FALLBACK_SHIFT_MINS = 120;

const num = (v, d) => (Number.isFinite(v) ? v : d);
const ms = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : NaN; };
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Caps on the two look-back settings, applied wherever they are read (walkers, read
// windows, marker retention, the cron's jobs read). Every alert read spans the shift
// look-back and the server bounds those windows, so an uncapped setting (say 5000h)
// would have every read refused and silently stop all shift alerts — a week is far past
// any sane back-blast guard. An inspection cadence at or past INSPECTION_LOOKBACK_DAYS
// could never fire: the account reads as never inspected first.
export const MAX_SHIFT_LOOKBACK_HOURS = 168;
export const MAX_INSPECTION_REMINDER_DAYS = 365;
export const shiftLookbackHours = (settings = {}) => Math.min(MAX_SHIFT_LOOKBACK_HOURS,
  Math.max(0, num(settings?.shiftAlertLookbackHours, OPS_ALERT_DEFAULTS.shiftAlertLookbackHours)));
export const inspectionReminderDays = (settings = {}) => Math.min(MAX_INSPECTION_REMINDER_DAYS,
  Math.max(1, num(settings?.inspectionReminderDays, OPS_ALERT_DEFAULTS.inspectionReminderDays)));

// ALR-10: the nudge's lead time before the scheduled END, in minutes. Clamped at 0 (never
// negative — nudging after the clean ended is the escalation's job) and at a day, so a
// crafted setting can't make every clean's nudge due the moment it is scheduled.
export const MAX_CHECKLIST_LEAD_MINS = 24 * 60;
export const checklistReminderBeforeEndMins = (settings = {}) => Math.min(MAX_CHECKLIST_LEAD_MINS,
  Math.max(0, num(settings?.checklistReminderBeforeEndMins, OPS_ALERT_DEFAULTS.checklistReminderBeforeEndMins)));

// 🔴 ALR-11: THE missed-shift mark — minutes past the scheduled start with no clock-in.
// Clamped at 0 (meaning "the moment the start passes"; a negative would make every
// not-yet-started clean missed) and at a day, so a crafted or fat-fingered setting cannot
// park the alert a year out and silently switch missed-shift detection off. Anything
// non-numeric falls back to the shipped default rather than disabling the rule.
// ONE reader, so the walker, the Dashboard KPI, the attendance report and the settings
// form can never disagree about when a clean counts as missed.
export const MAX_MISSED_AFTER_START_MINS = 24 * 60;
export const missedAfterStartMins = (settings = {}) => Math.min(MAX_MISSED_AFTER_START_MINS,
  Math.max(0, num(settings?.missedAfterStartMins, OPS_ALERT_DEFAULTS.missedAfterStartMins)));

// ALR-9 (Matt, 2026-09-29): how often THIS account should be inspected — its own
// `inspectionIntervalDays` when set, else the org default. Same clamp as the org setting, and
// a blank / zero / non-numeric per-account value falls back rather than disabling the reminder
// for that customer. Additive and default-safe on the client row, so no store bump.
export const clientInspectionIntervalDays = (client, settings = {}) => {
  const own = client?.inspectionIntervalDays;
  if (Number.isFinite(own) && own >= 1) return Math.min(MAX_INSPECTION_REMINDER_DAYS, own);
  return inspectionReminderDays(settings);
};

// 🔴 THE ONE "is this building due for an inspection" rule (ALR-9): its LATEST inspection is at
// least its interval old. The reminder walker below fires on it, and the manager Home's
// Inspections tile counts it (lib/managerHome inspectionsDueCount), so the tile can never say
// "2 due" about buildings nobody was reminded about, or the reverse. `lastMs` is the latest
// SUBMITTED inspection's instant; none (null / not a number) is NOT due — a building never
// inspected is an onboarding concern, not a lapse. The walker's own extras (skip inactive and
// seed buildings, fire once per episode) are notification rules and stay in the walker.
export function isInspectionOverdue({ client, lastMs, now = Date.now(), settings = {} } = {}) {
  if (lastMs == null || !Number.isFinite(lastMs)) return false;
  return lastMs <= now - clientInspectionIntervalDays(client, settings) * DAY;
}
// A checklist logged within 18h of the clean's scheduled start counts as "for that
// clean" — a timezone-free stand-in for same-calendar-day, fine for a once-daily list.
// EXPORTED because the Assignments screen's "overdue today" tally
// (lib/checklistAssignments) must ask the reminder's exact question: a tile that read a
// cleaner as missing when the nudge did not — or the reverse — would send the office after
// a problem the crew was never told about. One constant, two readers.
export const CHECKLIST_MATCH_WINDOW_MS = 18 * HOUR;

// Deterministic per-(kind, job) id so a shift alerts at most once for each kind, no
// matter how many ticks see it (the fired-set is the dedup, mirroring hasFired()).
export function opsAlertId(kind, refId) { return `oa_${kind}_${refId}`; }

// ── SEED-DATA SKIP (CS-011 / CS-030) — PARTIAL as of 2026-09-26; REMOVE AT CUTOVER ─
// Production is 100% seed data until the CS-030 cutover ("Leave fake data for now",
// 2026-09-25). The reminder walkers skip the fictional book so the re-enabled cron (and
// the in-browser tick — both share these pure walkers) don't burst ~160 fake alerts a
// week onto the owner's phone.
//
// EXCEPTION (owner call, 2026-09-26): LATE/MISSED-SHIFT alerts now DO fire on the seed
// book — the client demo has to prove missed-clean notifications reach the installed
// mobile app, and there is no real data yet to fire on. So getDueShiftAlerts no longer
// skips seed jobs; the checklist + inspection reminders (the bulk of the old flood) stay
// skipped so the only added noise is the missed/late cleans being demonstrated:
//   • shift late/missed — FIRES on seed jobs (skip removed 2026-09-26)
//   • checklist         — still skips seed JOBS (by id)
//   • inspection        — still skips seed CLIENTS (by id)
//
// Seed records are matched BY ID, using the two minters that create them:
//   • jobs    — seed.js `seedId('j', …)`  → `j_seed_*`   (see app/src/lib/ids.js)
//               seed-backend.mjs backfill  → `j_bkseed_*` (j_bkseed_<site>_<n>, j_bkseed_route_…)
//   • clients — seed.js `seedId('cl', …)`  → `cl_seed_*`
// A real, app-minted record (`newId('j')` → `j_<base36>`, `newId('cl')` → `cl_<base36>`;
// no `_seed_`/`_bkseed_` segment) never matches, so a REAL job still alerts even on a
// seed client (the checklist skip is BY JOB ID) — letting a test shift be run on a
// fake customer before the cutover.
//
// TODO(remove-by: CS-030 seed cutover): once the seed rows are purged these patterns
// match nothing and every use below is a no-op — delete this block and its call sites in
// that cutover change (grep: SEED_JOB_ID_RE, SEED_CLIENT_ID_RE, isSeedJobId, isSeedClientId).
export const SEED_JOB_ID_RE = /^j_(?:seed|bkseed)_/;
export const SEED_CLIENT_ID_RE = /^cl_seed_/;
export const isSeedJobId = (id) => typeof id === 'string' && SEED_JOB_ID_RE.test(id);
export const isSeedClientId = (id) => typeof id === 'string' && SEED_CLIENT_ID_RE.test(id);

// ── The windows the walkers read ──────────────────────────────────────────────
// Shared by the client tick (components/OpsAlertScheduler) and the cron
// (api/cron/ops-alerts) so both read the SAME slice, and every read is COMPLETE over its
// window (api/_lib/pagedSelect.js). They used to read the newest 500–2000 punches and the
// newest 200–1000 QC records: at full volume a busy day's older punches fell off, so a
// clean someone DID clock into looked uncovered and fired a false late/missed alert, and
// checklists/inspections past the slice read as never logged.
//   coverage    — the shift lookback, padded back so a clock-in made a little before a
//                 clean that starts right at the lookback edge still covers it.
//   checklists  — a checklist matches a clean within CHECKLIST_MATCH_WINDOW_MS of its start.
// Inspection reminders read no window: each account's LATEST inspection decides them, so
// the walkers read exactly that (qcApi.latestInspectionPerClient / the store fn of the same
// name — newest-first, stopping once every account is seen), looking back at most
// INSPECTION_LOOKBACK_DAYS. A window of recent records made an account lapsed beyond it
// read as "never inspected" — never reminded (review finding, 2026-09-22).
export const COVERAGE_PAD_HOURS = 2;
export const INSPECTION_LOOKBACK_DAYS = 366;
// (The accounts the inspection reminder watches are lib/customerStatus isActiveBuilding's: one
// definition for the walker and the reads that feed it. The reader this module had, which
// looked only at the RETIRED `client.status`, is gone — CS-683.)
export function opsAlertReadWindows(settings = {}, now = Date.now()) {
  const lookbackMs = shiftLookbackHours(settings) * HOUR;
  const nowIso = new Date(now).toISOString();
  const at = (t) => new Date(t).toISOString();
  return {
    coverage: { fromIso: at(now - lookbackMs - COVERAGE_PAD_HOURS * HOUR), toIso: nowIso },
    checklists: { fromIso: at(now - lookbackMs - CHECKLIST_MATCH_WINDOW_MS), toIso: nowIso },
    inspectionsSinceIso: at(now - INSPECTION_LOOKBACK_DAYS * DAY),
  };
}

// 🔴 THE MISSED-SHIFT ALERT (ALR-11). ONE alert per clean, `missedAfterStartMins` after
// its scheduled START with no clock-in by anyone on it. Pure over injected data so it is
// unit-testable and the client tick and the server cron cannot diverge.
//   jobs          : state.jobs (need startAt/status/clientId/siteId/crewIds)
//   coveredJobIds : Set of job ids with a real clock-in in the window (server-computed,
//                   complete — timeApi.coveredJobIds / coveredJobIdsInWindow). Preferred.
//   timeEntries   : OR the ledger rows for the window (need job_id + clock_in_at); only
//                   read when coveredJobIds is absent. A job with any clock-in is
//                   "covered" and never missed.
//   firedIds      : Set of opsAlertId()s already raised (dedup)
//   now, settings : injected clock + opsSettings (the mark + the look-back)
// Returns [{ id, kind: 'shiftMissed', jobId, clientId, siteId, crewIds,
//            scheduledStart, scheduledEnd }].
export function getDueShiftAlerts({ jobs = [], timeEntries = [], coveredJobIds = null, firedIds = new Set(), now = Date.now(), settings = {} } = {}) {
  const lookbackMs = shiftLookbackHours(settings) * HOUR;

  // A job is "covered" once ANY crew member has a clock-in for it (the alert is about
  // nobody having shown up, not about who specifically).
  const covered = coveredJobIds instanceof Set ? coveredJobIds : coveredJobIdSet(timeEntries);

  const due = [];
  for (const job of jobs) {
    if (!job || !job.id || TERMINAL_JOB.has(job.status)) continue;
    // Missed-shift alerts DO fire on seed jobs as of 2026-09-26 (owner call — the client
    // demo must prove missed-clean notifications; see the SEED-DATA SKIP block).
    if (job.status === 'in_progress') continue;   // clocked in already — covered by status
    const startMs = ms(job.startAt);
    if (!Number.isFinite(startMs)) continue;
    if (startMs > now) continue;                  // not started yet — nothing to miss
    if (startMs < now - lookbackMs) continue;     // too old — back-blast guard (activation + stale jobs)
    if (covered.has(job.id)) continue;            // someone clocked in — not missed
    // THE one rule, shared with isMissedClean below so the alert and every count agree.
    if (!isPastMissedMark(startMs, now, settings)) continue;

    const id = opsAlertId('shiftMissed', job.id);
    if (firedIds.has(id)) continue;
    due.push({
      id,
      kind: 'shiftMissed',
      jobId: job.id,
      clientId: job.clientId || null,
      siteId: job.siteId || null,
      crewIds: Array.isArray(job.crewIds) ? job.crewIds : [],
      scheduledStart: job.startAt,
      scheduledEnd: job.endAt || null,
      recipientScope: 'supervisor', // the account's single point of contact (ALR-12)
    });
  }
  return due;
}

// Has this clean's start passed by the configured mark? The ONE predicate the walker and
// `isMissedClean` share, so "missed" cannot mean two things in one app.
const isPastMissedMark = (startMs, now, settings) => now > startMs + missedAfterStartMins(settings) * MIN;

// The SET of job ids with at least one real clock-in (any crew member). Shared by the
// walker above and the Dashboard missed-cleans KPI so "covered" means the same thing in
// both. A row needs both a job_id and a clock_in_at to count.
export function coveredJobIdSet(timeEntries = []) {
  const covered = new Set();
  for (const e of timeEntries) {
    if (e && e.job_id && e.clock_in_at) covered.add(e.job_id);
  }
  return covered;
}

// 🔴 A scheduled clean is MISSED when `missedAfterStartMins` has passed since its
// scheduled START with NO clock-in at all, and it was not deliberately closed
// (done/cancelled) or already underway (in_progress means someone is on it). ALR-11
// moved this from "its whole window has passed" to the one mark the alert fires on, so
// the Dashboard "missed cleans" KPI (store/selectors.selectMissedCleansThisMonth) counts
// exactly the cleans the supervisor was alerted about — the alert and the metric cannot
// disagree, and neither waits for a four-hour clean to end before saying nobody came.
// `coveredJobIds` is the server's complete covered-job set (timeApi.coveredJobIds /
// coveredJobIdsInWindow), or coveredJobIdSet() over punches. `settings` is opsSettings;
// omitted, the shipped default applies.
export function isMissedClean(job, coveredJobIds, now = Date.now(), settings = {}) {
  if (!job || !job.id || TERMINAL_JOB.has(job.status) || job.status === 'in_progress') return false;
  const startMs = ms(job.startAt);
  if (!Number.isFinite(startMs) || startMs > now) return false;   // not started yet
  if (!isPastMissedMark(startMs, now, settings)) return false;    // still inside the mark
  return !(coveredJobIds && coveredJobIds.has(job.id));           // nobody clocked in
}

// ── #3 reminders ──────────────────────────────────────────────────────────────

const dayKey =(iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'na'; };

// The live checklist template ids out of a template read, or NULL when the answer is not
// known. ONE shaper for the cron and the in-browser tick, because the difference between
// "no checklists exist" and "we could not find out" decides whether every cleaner bound to
// a checklist is skipped. A read that failed is null already; a read that SUCCEEDED but
// came back as anything other than an array (the client adapter returns
// `(await api(...)).templates`, so a 200 with a different body shape yields `undefined`)
// is just as unknown — read as an empty set it would silence every reminder in the org.
// Accepts rows ({ id }) or the cron's narrow ids-only read (plain strings).
export function liveChecklistIdsFrom(result) {
  if (!Array.isArray(result)) return null;
  const ids = new Set();
  for (const t of result) {
    const id = typeof t === 'string' ? t : (t && t.id);
    if (id) ids.add(id);
  }
  return ids;
}

// Checklist reminders — PER CLEANER (CS-404). Every cleaner on the clean is judged
// against THEIR OWN checklist (the shared resolver, lib/crewChecklist.checklistFor), and
// is due when they have no COMPLETE submission of their own for that clean. Before this,
// the walker asked only whether the ACCOUNT had a default and whether ANY checklist
// existed for the site that day: a location run on per-cleaner checklists alone never
// reminded anyone, one cleaner's (even half-done) checklist silenced the whole crew, and
// the nudge fanned out to cleaners who owed nothing.
//   • crew NUDGE  — one per missing cleaner, id oa_checklistDue_<job>_<user>, addressed
//                   to that cleaner alone (crewIds = [them]).
//   • ESCALATION  — ONE per clean once it has ended, id oa_checklistDueEsc_<job>
//                   (unchanged), carrying `missingUserIds` so the copy can name them;
//                   routed to the supervisor AND the owner(s) in lib/opsAlertApply.
// Suppressed when a shift alert already fired for the job — the arrival problem
// supersedes the paperwork one.
//   jobs, clientsById (Map id->client), checklists (records: job_id, site_id,
//   completed_by_user_id, completed_count, total_count, performed_at —
//   CHECKLIST_WINDOW_COLUMNS), firedIds, now, settings.
//   liveChecklistIds — OPTIONAL Set/array of the checklist template ids that still
//   exist. A cleaner bound to a checklist that is no longer in it is skipped (CS-353).
//   ABSENT or null means "not known", and then nothing is skipped: a failed template
//   read must never silence reminders (shape a read with liveChecklistIdsFrom).
//   activeUserIds — OPTIONAL Set/array of the roster ids that are still ACTIVE. A
//   deactivated cleaner can still sit on a past clean's crewIds; the notification fan-out
//   drops them (fanOutToUserIds skips a non-active user) and the manager roster never
//   shows them, so judging them produced a nudge nobody could receive and named a removed
//   person in the escalation. ABSENT means "not known" → everyone on the clean is judged.
// Returns [{ id, kind:'checklistDue', recipientScope:'crew'|'supervisor', jobId,
//            clientId, siteId, crewIds, scheduledStart, userId?, missingUserIds }].
export function getDueChecklistReminders({ jobs = [], clientsById = new Map(), checklists = [], firedIds = new Set(), now = Date.now(), settings = {}, liveChecklistIds = null, activeUserIds = null } = {}) {
  // ALR-10: the nudge is timed off the scheduled END (this many minutes BEFORE it), not the
  // start. `checklistReminderGraceMins` is gone with it (II.5).
  const lead = checklistReminderBeforeEndMins(settings);
  const escalate = num(settings.checklistEscalateGraceMins, OPS_ALERT_DEFAULTS.checklistEscalateGraceMins);
  const lookbackMs = shiftLookbackHours(settings) * HOUR;
  const asSet = (v) => (v == null ? null : (v instanceof Set ? v : new Set(v)));
  const live = asSet(liveChecklistIds);
  const active = asSet(activeUserIds);
  // Index the window ONCE per walk: it spans every clean in the org for a day, and the
  // question below is asked per cleaner per clean.
  const logged = completeChecklistIndex(checklists);

  const due = [];
  for (const job of jobs) {
    if (!job || !job.id || job.status === 'cancelled') continue;
    if (isSeedJobId(job.id)) continue;             // seed job (CS-030) — see SEED_JOB_ID_RE; remove at cutover
    const client = clientsById.get(job.clientId);
    if (!client) continue;
    const startMs = ms(job.startAt);
    if (!Number.isFinite(startMs) || startMs > now || startMs < now - lookbackMs) continue;
    // The arrival problem supersedes the paperwork one.
    if (firedIds.has(opsAlertId('shiftMissed', job.id))) continue;

    // Who on this clean still owes their own checklist? The crew comes from the ONE
    // resolver (lib/crewResolve), so a falsy id can never become a recipient.
    const crewIds = [...resolveJobCrewIds(job)];
    const missingUserIds = [];
    for (const userId of crewIds) {
      if (active && !active.has(userId)) continue; // no longer on the roster (or disabled)
      const templateId = checklistFor({ client, job, userId });
      if (!templateId) continue;                   // no checklist for this cleaner — a normal state
      if (live && !live.has(templateId)) continue; // the checklist was deleted (CS-353)
      if (hasCompleteChecklistFor(logged, {
        userId, jobId: job.id, siteId: job.siteId || null, startMs, windowMs: CHECKLIST_MATCH_WINDOW_MS,
      })) continue;
      missingUserIds.push(userId);
    }
    if (!missingUserIds.length) continue;

    const endMs = Number.isFinite(ms(job.endAt)) ? ms(job.endAt) : startMs + FALLBACK_SHIFT_MINS * MIN;
    const base = {
      kind: 'checklistDue',
      jobId: job.id,
      clientId: job.clientId || null,
      siteId: job.siteId || null,
      scheduledStart: job.startAt,
    };
    if (now > endMs + escalate * MIN) {
      const id = opsAlertId('checklistDueEsc', job.id);
      if (!firedIds.has(id)) due.push({ id, ...base, recipientScope: 'supervisor', crewIds, missingUserIds });
      // 🔴 ALR-10: the cleaner's nudge goes out `lead` minutes BEFORE the scheduled end —
      // "one hour before their shift ends… or they won't be able to clock out." Never before
      // the clean has started (the `startMs > now` guard above holds), so a clean SHORTER than
      // the lead time nudges at its start instead of before it was scheduled.
    } else if (now > Math.max(startMs, endMs - lead * MIN)) {
      for (const userId of missingUserIds) {
        const id = opsAlertId('checklistDue', `${job.id}_${userId}`);
        // crewIds is the fan-out list (lib/opsAlertApply), so a nudge carries ONLY the
        // cleaner who owes it — never the whole crew.
        if (!firedIds.has(id)) due.push({ id, ...base, recipientScope: 'crew', userId, crewIds: [userId], missingUserIds: [userId] });
      }
    }
  }
  return due;
}

// Inspection reminders: an account whose most recent inspection is older than
// inspectionReminderDays. One reminder per overdue episode — the dedup id carries the
// last inspection's day, so a fresh inspection resets it and a later lapse can fire
// again; its marker is kept for the whole episode (lib/opsAlertApply — the 48h shift
// horizon used to prune it, and the same reminder re-fired every couple of days).
// Accounts with no inspection in INSPECTION_LOOKBACK_DAYS are left for onboarding, not
// nagged here. Only SUBMITTED inspections count — the reads that feed this skip drafts
// (an inspection started and abandoned is not one done; the Reports tally agrees).
//   clients (active), inspections (records: client_id, performed_at — the latest per
//   account is all that matters), firedIds, now, settings.
// Returns [{ id, kind:'inspectionDue', recipientScope:'supervisor', clientId, lastAt }].
export function getDueInspectionReminders({ clients = [], inspections = [], firedIds = new Set(), now = Date.now(), settings = {} } = {}) {
  // ALR-9: the interval is PER ACCOUNT, defaulting to the org's. A customer inspected every
  // 7 days and one every 30 are both normal, and one org number could not say so.
  const latestByClient = new Map();
  for (const insp of inspections) {
    if (!insp || !insp.client_id) continue;
    const t = ms(insp.performed_at);
    if (!Number.isFinite(t)) continue;
    const prev = latestByClient.get(insp.client_id);
    if (prev == null || t > prev) latestByClient.set(insp.client_id, t);
  }

  const due = [];
  for (const client of clients) {
    // A building we clean now (CS-683): Inactive or Archived — set through the status menu or
    // the import, `statusOverride` — and a vendor are skipped; no status set is a live account.
    if (!isActiveBuilding(client)) continue;
    if (isSeedClientId(client.id)) continue;       // seed client (CS-030) — see SEED_CLIENT_ID_RE; remove at cutover
    const last = latestByClient.get(client.id);
    // Never inspected, or inspected recently enough for THIS account's interval: the one rule.
    if (!isInspectionOverdue({ client, lastMs: last, now, settings })) continue;
    const lastIso = new Date(last).toISOString();
    const id = opsAlertId('inspectionDue', `${client.id}_${dayKey(lastIso)}`);
    if (firedIds.has(id)) continue;
    due.push({ id, kind: 'inspectionDue', recipientScope: 'supervisor', clientId: client.id, lastAt: lastIso });
  }
  return due;
}

// ── SUP-8 / CS-380 + SUP-7 / SUP-10: the supply walkers ───────────────────────
//
// Three alerts, all on the CALENDAR MONTH in the ORG's zone (SUP-10 ★a; `tz` is passed in
// because the cron never calls setOrgTimezone) and all keyed once per building per month:
//
//   supplyOrderDue      — it is the building's order day (or past it) and NO request has been
//                         SUBMITTED this month. Goes to the building's supervisor (SUP-8 a).
//   supplyOrderOverdue  — still nothing on an org-zone day AFTER the supervisor's reminder was
//                         raised (and past the order day). Goes to the office ("and the office
//                         the day after if still nothing").
//   supplyBudgetExceeded — the month's DELIVERED spend has passed the building's budget
//                         (SUP-7 b). Goes to the approver, ONCE per month (SUP-10 ★a).
//
// Why the ids carry `YYYY-MM`: the marker is the once-only guard, so a new month mints a new
// id and last month's is superseded (lib/opsAlertApply keeps the newest supply marker per
// building per kind — a 5-minute cron on a day-granularity reminder would otherwise re-send
// it every run for the rest of the month).
//
//   clients   : state.clients
//   requests  : this month's supply requests, read from `supply_requests` by the cron since
//               SUP-13 (api/_lib/supplies/store requestsForSupplyAlerts) — createdAt for "did
//               they order", and each DELIVERY in this month for spend (S131: a line delivered
//               counts in its own month, whether or not the order is completed yet)
//   firedIds  : Set of opsAlertId()s already raised (dedup)
//   firedAt   : Map of opsAlertId() -> when it was raised (the markers' `firedAt`, lib/opsAlertApply).
//               The office's alert is timed off the day the supervisor's was RAISED (CS-953).
//               A raised marker with no time reads as an earlier day: a missing time must
//               never silence the office for the rest of the month.
//   now, settings, tz
// Returns [{ id, kind, recipientScope, clientId, monthKey, orderDay?, budget?, spend? }].
export function getDueSupplyAlerts({ clients = [], requests = [], firedIds = new Set(), firedAt = new Map(), now = Date.now(), settings = {}, tz = undefined } = {}) {
  const todayKey = orgDayKey(new Date(now), tz);
  const monthKey = todayKey.slice(0, 7);                 // YYYY-MM
  const dayOfMonth = Number(todayKey.slice(8, 10));

  // Per building: was anything SUBMITTED this month, what was DELIVERED this month, and is a
  // request still in flight (requested, approved or sent — what makes an unmanaged building a
  // supply building, lib/supplies isSupplyBuilding)?
  const submittedThisMonth = new Set();
  const spendThisMonth = new Map();
  const inFlight = new Set();
  const IN_FLIGHT = new Set([SUPPLY_STATUS.requested, SUPPLY_STATUS.approved, SUPPLY_STATUS.sent]);
  for (const r of (Array.isArray(requests) ? requests : [])) {
    if (!r || !r.clientId) continue;
    if (IN_FLIGHT.has(supplyStatusOf(r))) inFlight.add(r.clientId);
    // "No request has been submitted this month" counts a request in ANY state — a rejected
    // one still means the supervisor did their part, so nagging them again is wrong.
    if (r.createdAt && orgDayKey(r.createdAt, tz).slice(0, 7) === monthKey) submittedThisMonth.add(r.clientId);
    // S131: each DELIVERY in this org-zone month, at its line's frozen price, in cents (lib/supplies
    // supplyDeliveries — an order completed before the per-line record at what went out, at
    // completedAt).
    for (const d of supplyDeliveries(r)) {
      if (!d.at || orgDayKey(d.at, tz).slice(0, 7) !== monthKey) continue;
      spendThisMonth.set(r.clientId, (spendThisMonth.get(r.clientId) || 0) + d.qty * (supplyToCents(d.line && d.line.unitPrice) || 0));
    }
  }
  for (const [id, cents] of spendThisMonth) spendThisMonth.set(id, cents / 100);

  // 🔴 CS-953: was the supervisor's reminder raised on an org-zone day BEFORE today? Only then
  // may the office hear. Off the order day alone, a building entered (or first given a manager)
  // after its order day raised the supervisor's reminder AND the office's in the same run.
  const raisedBeforeToday = (id) => {
    if (!firedIds.has(id)) return false;
    const at = firedAt instanceof Map ? firedAt.get(id) : null;
    const t = at ? new Date(at).getTime() : NaN;
    return !Number.isFinite(t) || orgDayKey(new Date(t), tz) < todayKey;
  };

  const due = [];
  for (const client of clients) {
    // CS-683: the SUPPLIES rule, the one the By building page and the manager Home read — a
    // building we clean now (no vendor, nothing Inactive or Archived), not a Lead, and one that
    // someone looks after (a manager, a budget or a request in flight). It used to read the
    // retired `client.status` alone, so leads, prospects, vendors and buildings set Inactive
    // through the menu were all reminded to order.
    if (!isSupplyBuilding(client, { hasOpen: inFlight.has(client && client.id) })) continue;
    if (isSeedClientId(client.id)) continue;       // seed client (CS-030) — see SEED_CLIENT_ID_RE; remove at cutover
    const orderDay = supplyOrderDayFor(client, settings);
    if (!submittedThisMonth.has(client.id)) {
      const dueId = opsAlertId('supplyOrderDue', `${client.id}_${monthKey}`);
      if (dayOfMonth >= orderDay) {
        if (!firedIds.has(dueId)) {
          due.push({ id: dueId, kind: 'supplyOrderDue', recipientScope: 'supervisor', clientId: client.id, monthKey, orderDay });
        }
      }
      // The office is told the day AFTER the supervisor was — and only then, so it is never the
      // first to hear, nor told in the same run (CS-953).
      if (dayOfMonth >= orderDay + 1 && raisedBeforeToday(dueId)) {
        const id = opsAlertId('supplyOrderOverdue', `${client.id}_${monthKey}`);
        if (!firedIds.has(id)) {
          due.push({ id, kind: 'supplyOrderOverdue', recipientScope: 'office', clientId: client.id, monthKey, orderDay });
        }
      }
    }
    // SUP-7 / SUP-10: over budget for the calendar month → the APPROVER, once per month.
    const budget = supplyBudgetFor(client);
    const spend = spendThisMonth.get(client.id) || 0;
    if (budget != null && spend > budget) {
      const id = opsAlertId('supplyBudgetExceeded', `${client.id}_${monthKey}`);
      if (!firedIds.has(id)) {
        due.push({ id, kind: 'supplyBudgetExceeded', recipientScope: 'approver', clientId: client.id, monthKey, budget, spend });
      }
    }
  }
  return due;
}
