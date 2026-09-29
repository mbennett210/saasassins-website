// Operational-alert detection — PURE, node-safe (its one import is the equally pure
// checklist rule module, with the explicit `.js` the serverless cron's cold import needs
// — CS-011), so the "is this shift late / missed" logic is identical in the client tick
// (components/OpsAlertScheduler.jsx) and, at go-live, the server cron. Same split as
// reminderScheduler.js vs ReminderScheduler.jsx.
//
// Scope (this file): the late & missed-shift alerts (contract item "Late & missed-
// shift triggers: automatic alerts the moment a cleaner is late, has not arrived, or
// missed a shift"). Checklist / inspection reminders land alongside as more detectors.
//
// Recipients + delivery are NOT decided here — the walker only says WHICH shifts are
// due for WHICH kind of alert (with a deterministic id for once-only firing). The
// reducer routes each to the account supervisor via fanOutAccountAlert.

import { checklistFor, hasCompleteChecklistFor, completeChecklistIndex } from './crewChecklist.js';
import { resolveJobCrewIds } from './crewResolve.js';

// Defaults an operator can retune in Settings > Operations (opsSettings). Kept here as
// the single source so the walker, the seed, and the settings form agree.
export const OPS_ALERT_DEFAULTS = {
  lateAlertGraceMins: 10,     // minutes past scheduled start with no clock-in before "late"
  missedShiftGraceMins: 15,   // minutes past scheduled end with no clock-in before "missed"
  shiftAlertLookbackHours: 24, // only shifts this recent can alert (back-blast guard)
  // #3 reminders
  checklistReminderGraceMins: 60,   // after start with no checklist logged → nudge the crew
  checklistEscalateGraceMins: 60,   // after end with still no checklist → escalate to supervisor
  inspectionReminderDays: 14,       // an account not inspected within this many days is due
};

// Jobs in these statuses are finished/void — never late or missed.
const TERMINAL_JOB = new Set(['done', 'completed', 'cancelled', 'canceled']);
const MIN = 60 * 1000;
const FALLBACK_SHIFT_MINS = 120; // shift length assumed when a job carries no endAt

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
// A checklist logged within 18h of the clean's scheduled start counts as "for that
// clean" — a timezone-free stand-in for same-calendar-day, fine for a once-daily list.
const CHECKLIST_MATCH_WINDOW_MS = 18 * HOUR;

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
// The accounts the inspection reminder watches: every client not explicitly inactive
// (the seed and CRM leave status absent for live customers). One definition for the
// walker and the reads that feed it (the latest-per-client read stops once each is seen).
export const isReminderClient = (c) => !!(c && c.id && c.status !== 'inactive');
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

// Late & missed-shift alerts. Pure over injected data so it is unit-testable and the
// client/server paths cannot diverge.
//   jobs          : state.jobs (need startAt/endAt/status/clientId/siteId/crewIds)
//   coveredJobIds : Set of job ids with a real clock-in in the window (server-computed,
//                   complete — timeApi.coveredJobIds / coveredJobIdsInWindow). Preferred.
//   timeEntries   : OR the ledger rows for the window (need job_id + clock_in_at); only
//                   read when coveredJobIds is absent. A job with any clock-in is
//                   "covered" and never late/missed.
//   firedIds      : Set of opsAlertId()s already raised (dedup)
//   now, settings : injected clock + opsSettings (thresholds)
// Returns [{ id, kind: 'shiftLate' | 'shiftMissed', jobId, clientId, siteId, crewIds,
//            scheduledStart, scheduledEnd }].
export function getDueShiftAlerts({ jobs = [], timeEntries = [], coveredJobIds = null, firedIds = new Set(), now = Date.now(), settings = {} } = {}) {
  const lateGrace = num(settings.lateAlertGraceMins, OPS_ALERT_DEFAULTS.lateAlertGraceMins);
  const missedGrace = num(settings.missedShiftGraceMins, OPS_ALERT_DEFAULTS.missedShiftGraceMins);
  const lookbackMs = shiftLookbackHours(settings) * HOUR;

  // A job is "covered" once ANY crew member has a clock-in for it (a late alert is
  // about nobody having shown up, not about who specifically).
  const covered = coveredJobIds instanceof Set ? coveredJobIds : coveredJobIdSet(timeEntries);

  const due = [];
  for (const job of jobs) {
    if (!job || !job.id || TERMINAL_JOB.has(job.status)) continue;
    // Shift (late/missed) alerts DO fire on seed jobs as of 2026-09-26 (owner call — the
    // client demo must prove missed-clean notifications; see the SEED-DATA SKIP block).
    if (job.status === 'in_progress') continue;   // clocked in already — covered by status
    const startMs = ms(job.startAt);
    if (!Number.isFinite(startMs)) continue;
    if (startMs > now) continue;                 // not started yet — nothing to be late for
    if (startMs < now - lookbackMs) continue;     // too old — back-blast guard (activation + stale jobs)
    if (covered.has(job.id)) continue;            // someone clocked in — not late/missed

    const endMs = Number.isFinite(ms(job.endAt)) ? ms(job.endAt) : startMs + FALLBACK_SHIFT_MINS * MIN;
    const base = {
      jobId: job.id,
      clientId: job.clientId || null,
      siteId: job.siteId || null,
      crewIds: Array.isArray(job.crewIds) ? job.crewIds : [],
      scheduledStart: job.startAt,
      scheduledEnd: job.endAt || null,
      recipientScope: 'supervisor', // late/missed go to the account's single point of contact
    };

    if (now > endMs + missedGrace * MIN) {
      const id = opsAlertId('shiftMissed', job.id);
      if (!firedIds.has(id)) due.push({ id, kind: 'shiftMissed', ...base });
      continue;                                   // past the whole window → missed, not late
    }
    if (now > startMs + lateGrace * MIN) {
      const id = opsAlertId('shiftLate', job.id);
      if (!firedIds.has(id)) due.push({ id, kind: 'shiftLate', ...base });
    }
  }
  return due;
}

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

// A scheduled clean is MISSED when its whole window has passed with NO clock-in at all
// and it was not deliberately closed (done/cancelled) or already underway (in_progress
// means someone is on it). This is the SINGLE deterministic definition the shift-missed
// alert encodes inline (lookback and grace aside) and the Dashboard "missed cleans" KPI
// reuses (store/selectors.selectMissedCleansThisMonth), so the alert and the metric can
// never disagree. `coveredJobIds` is the server's complete covered-job set
// (timeApi.coveredJobIds / coveredJobIdsInWindow), or coveredJobIdSet() over punches.
export function isMissedClean(job, coveredJobIds, now = Date.now()) {
  if (!job || !job.id || TERMINAL_JOB.has(job.status) || job.status === 'in_progress') return false;
  const startMs = ms(job.startAt);
  if (!Number.isFinite(startMs) || startMs > now) return false;   // not started yet
  const endMs = Number.isFinite(ms(job.endAt)) ? ms(job.endAt) : startMs + FALLBACK_SHIFT_MINS * MIN;
  if (now <= endMs) return false;                                 // window not fully past
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
  const grace = num(settings.checklistReminderGraceMins, OPS_ALERT_DEFAULTS.checklistReminderGraceMins);
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
    if (firedIds.has(opsAlertId('shiftLate', job.id)) || firedIds.has(opsAlertId('shiftMissed', job.id))) continue;

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
    } else if (now > startMs + grace * MIN) {
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
  const days = inspectionReminderDays(settings);
  const cutoff = now - days * DAY;

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
    // Skip only explicitly-inactive/churned accounts; a client with no status set is a
    // live account (the seed and CRM leave status absent for active customers).
    if (!isReminderClient(client)) continue;
    if (isSeedClientId(client.id)) continue;       // seed client (CS-030) — see SEED_CLIENT_ID_RE; remove at cutover
    const last = latestByClient.get(client.id);
    if (last == null) continue;   // never inspected — an onboarding concern, not nagged here
    if (last > cutoff) continue;  // inspected recently enough
    const lastIso = new Date(last).toISOString();
    const id = opsAlertId('inspectionDue', `${client.id}_${dayKey(lastIso)}`);
    if (firedIds.has(id)) continue;
    due.push({ id, kind: 'inspectionDue', recipientScope: 'supervisor', clientId: client.id, lastAt: lastIso });
  }
  return due;
}
