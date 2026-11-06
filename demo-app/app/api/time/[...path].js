// Crew clock-in/out + manager corrections + the labor projections. Writes the
// time_entries ledger. Every route re-checks authority server-side — the open
// org_state RLS means UI permission gating is NOT a boundary (§2.4).
//
//   POST /api/time/clock-in   { jobId, lat, lng, accuracyM, offSiteReason? }
//                               -> assigned crew (or the punch bypass); SERVER geofence,
//                               RECORDED never refused (PAY-17): an off-site punch lands
//                               pending and alerts the account's supervisor at once
//   POST /api/time/clock-out  { entryId, lat?, lng? }   -> the entry's owner or the punch bypass
//                               409 checklist_incomplete { done, total } when the ENTRY
//                               OWNER's own checklist for that clean isn't finished (R4)
//                               200 { entry, alreadyOut, jobDone } — jobDone: the LAST punch on
//                               the clean closed, so the server marked it done (CS-051)
//   POST /api/time/replay     { clientPunchId, jobId | entryId, ... } -> as clock-in / clock-out
//   POST /api/time/correct    { entryId, version, patch, reason } -> time.edit.all (scope/own/lock; CAS)
//   POST /api/time/manual     { jobId, userId, clockInAt, clockOutAt?, note?, reason? } -> time.edit.all (scope/own)
//   POST /api/time/approve    { items: [{ entryId, version }] } (≤200) -> time.approve; per-item results
//                             (legacy { entryId, approval }: 'rejected' → 400 reject-removed; TODO 2026-11-01)
//   POST /api/time/ot-approve { items: [{ userId, weekKey, clientId, minutes }] } (≤200) -> time.approve
//                             (scope/own per item; the stored total is the unit's approved OT)
//   GET  /api/time/approvals  [?supervisorId=<u_id>|none]  -> time.approve; the Approvals read:
//                             { scope, pending:[rows + ot_minutes], overtime:[units], ledger, asOf }
//                             (an Operations Manager's scope is their team; supervisorId narrows it
//                             to one member of the team, never beyond — S131)
//   POST /api/time/void       { entryId, version, reason } -> time.edit.all (scope/own/lock; CAS)
//   POST /api/time/restore    { entryId, version, reason? } -> time.edit.all (scope/own/lock; CAS)
//   POST /api/time/job-cancelled { jobId }               -> schedule.edit
//   GET  /api/time/mine       [?sinceIso]                -> the caller's own entries
//   GET  /api/time/my-hours   [?offset&userId]           -> the caller's own pay period, day by day
//                               (the Cleaner Hub's My Hours, EP-381; view only): the period worked
//                               out HERE from the full opsSettings (the crew's view has no cadence);
//                               userId only for an office login holding time.view (View-as)
//   GET  /api/time/on-my-way  [?jobIds]                  -> { available, sent } (EP-422; any staff login)
//   POST /api/time/on-my-way  { jobId }                  -> texts the customer "your crew is on the way"
//                               (EP-423; the CLEANER on that clean, today; once per clean)
//   GET  /api/time/open                                  -> who's on the clock (variance.view)
//   GET  /api/time/entries    [?fromIso&toIso&siteIds&clientIds&userIds&jobIds&limit]
//                                                        -> punch HISTORY, raw rows (time.view)
//        ...&paged=1&offset&limit[&lite=1]               -> COMPLETE read, one page + total
//   GET  /api/time/rollup     ?fromIso&toIso[&approvedOnly][&paged=1&offset&limit]
//                                                        -> completed labor (variance.view)
//   GET  /api/time/covered-jobs ?fromIso&toIso           -> job ids with a real clock-in (time.view)
//
//   POST /api/time/drive-report   { fromIso, toIso, filters?, skipEstimates?, payroll? } -> variance.view
//   GET  /api/time/drive-estimate ?fromSiteId&toSiteId    -> any crew (the "drive to
//                                 your next site" hint); coords resolved server-side;
//                                 429 past the login's billed allowance (DRIVE_ESTIMATE_RATE)
//   POST /api/time/drive-override { fromEntryId, toEntryId, ... , reason } -> time.edit.all
//                             (scope/own on the destination punch; refused in closed territory)
// Every key is read from the committed matrix + per-user overrides (authz.js).
//
// Note: clock-out has NO geofence gate (per requirements). All timestamps are
// server-stamped in the store; the client clock is never trusted.
import { requirePermission, requireAuthority, permissionChecker, authzSlicesOf, canCommitted } from '../_lib/authz.js';
import {
  clockIn, clockOut, manualEntry, cancelJobLabor,
  correctEntryRow, approveEntryRow, voidEntryRow, restoreEntryRow,
  getEntry, getEntriesByIds, readRunBounds, resolveJobContext,
  listMine, listOpen, listForRollup, listForReport, listForReportAll, autoCloseStale, replayPunch, punchWatchdog,
  recoverStubEntries, countForRollup, pageForRollup, countForReport, pageForReport,
  coveredJobIdsInWindow, listPendingApprovalsAll, ATTENDANCE_COLUMNS, LEDGER_ENTRY_COLUMNS,
  settleJobAfterPunchClosed, listOwnPunchesInWindow,
} from '../_lib/time/store.js';
import { myHoursPeriod, myHoursWindow, myHoursOffset } from '../../src/lib/myHours.js';
import { crewReadSubject } from '../_lib/crewPreview.js';
import {
  timeScopeFor, inTimeScope, refusesOwn, isPaidLocked, isInClosedTerritory,
  isGatedUser, isWorkedEntry, validatePunchTimes, TIME_REFUSALS,
  reasonRefusal, trimmedReason,
} from '../../src/lib/timeRules.js';
import { TEAM, teamMemberIds, teamClientIds, teamLeadFor } from '../../src/lib/teamScope.js';
import { DOUBLE_PUNCH_CODE, doublePunchMessage } from '../../src/lib/openPunchRule.js';
import {
  pendingByManager, unapprovedDigestBody, unapprovedDigestTitle, APPROVE_BATCH_MAX,
} from '../../src/lib/filters/timeApprovals.js';
import {
  CHECKLIST_INCOMPLETE_CODE, CHECKLIST_INCOMPLETE_ERROR,
  CHECKLIST_CHECK_FAILED_CODE, CHECKLIST_CHECK_FAILED_ERROR,
} from '../_lib/time/checklistGate.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { hit, tooMany } from '../_lib/rateLimit.js';
import { logActivityAs } from '../_lib/activityLog.js';
import { isoParam, idList, intParam } from '../_lib/queryParams.js';
import { reportError } from '../_lib/monitor.js';
import { refuseUnconfiguredCron } from '../_lib/cronGate.js';
import { sendToUser } from '../_lib/push/store.js';
import { translate, userLanguage } from '../_lib/i18n.js';
import { runDriveReport, siteMapFrom, PAYROLL_MAX_DAYS } from '../_lib/time/driveCompute.js';
import { resolveOneEstimate } from '../_lib/time/driveEstimates.js';
import { upsertOverride, clearOverride } from '../_lib/time/driveOverrides.js';
import { readOrgState, readProtectedSlices } from '../_lib/orgState.js';
import { onMyWayStatus, onMyWaySend } from '../_lib/customerMessages/onTheWay.js';
import { setOtApproval, readOtApprovalsForUsers } from '../_lib/time/otApprovals.js';
import { readRuns, openTerritoryStart, changedWeeksSinceLatestClose } from '../_lib/payroll/ledger.js';
import { computeWeekLedger, entryFromRow, entryOtMinutes, overtimeUnitsForApproval } from '../../src/lib/otLedger.js';
import { payWeekKeyOf, payWeekStartDayOf, isPayWeekKey } from '../../src/lib/payroll.js';
import { dayKey, addDaysKey, startOfDayKey, DEFAULT_ORG_TIMEZONE } from '../../src/lib/dates.js';

const MANAGER = ['owner', 'admin'];

// Legacy (unversioned) manager writes from an app bundle cached before W1-A shipped are
// accepted without the CAS. TODO(remove-by: 2026-11-01): once no such bundle can be live,
// require a version on correct / approve and drop the null-version paths (HANDOFF W1-A).
const LEGACY_UNVERSIONED_UNTIL = '2026-11-01';

// A refusal's HTTP status by its §4.1 code: 400 invalid input, 403 scope/own, 409 conflict.
const CODE_STATUS = {
  'out-of-scope': 403, 'own-entry': 403,
  stale: 409, 'paid-locked': 409, 'not-closed': 409, voided: 409,
  'reason-required': 400, 'reject-removed': 400, 'invalid-times': 400,
  'missing-in': 400, 'in-future': 400, 'out-before-in': 400, 'too-long': 400, 'missing-out': 400,
};
const refuse = (res, code) => res.status(CODE_STATUS[code] || 400).json({ error: TIME_REFUSALS[code] || 'Invalid request', code });

// A write the store could not land because the row kept changing under it (the compare-and-
// swap missed past its retries). RETRYABLE by design — 503, never a 4xx: a buffered punch
// must never be refused (THE LAW II.8), and lib/timeApi's offline queue treats 5xx as
// transient and replays it, where a 4xx would drop the crew's labor.
const contended = (res) => res.status(503).json({
  error: 'That didn’t save — the record was being changed at the same time. Try again.',
  code: 'write-contended',
});

// ── PAY-15: the morning "time waiting for your approval" digest ───────────────────────────
// Yesterday's still-pending punches, grouped by the manager of record (`client.supervisorId`,
// the same field every time-approval scope reads) and pushed one per manager. Rides the daily
// watchdog cron; the grouping and the wording are the pure shared rules in
// lib/filters/timeApprovals, so a screen showing the same figure cannot disagree with it.
//
// Delivery is `sendToUser`, exactly as the zero-punch page above: this is a cron with no
// org_state write, so there is no bell row to write and nothing to CAS. A manager with no
// device subscription simply gets nothing, which is what happens today for the watchdog too.
async function notifyUnapprovedYesterday({ now = Date.now() } = {}) {
  const { state } = await readOrgState();
  const tz = state?.company?.timezone || DEFAULT_ORG_TIMEZONE;
  // "The day before", in the ORG's calendar day — never the server's UTC day, or a punch from
  // an evening clean lands in the wrong digest.
  const yesterdayKey = addDaysKey(dayKey(new Date(now), tz), -1);
  const fromIso = startOfDayKey(yesterdayKey, tz).toISOString();
  const toIso = startOfDayKey(dayKey(new Date(now), tz), tz).toISOString();
  const rows = (await listPendingApprovalsAll({ fromIso }))
    .filter((e) => e && e.clock_in_at && e.clock_in_at < toIso);
  const { managers, unassigned } = pendingByManager(rows, state?.clients || []);
  // A manager who is no longer on the team, or is disabled, is not chased.
  const onTeam = new Map((Array.isArray(state?.users) ? state.users : [])
    .filter((u) => u && typeof u.id === 'string' && u.status !== 'inactive' && u.status !== 'disabled')
    .map((u) => [u.id, u]));
  const sent = [];
  await Promise.allSettled(managers.map(async (m) => {
    if (!onTeam.has(m.managerId) || m.count === 0) return;
    sent.push({ managerId: m.managerId, count: m.count });
    // In the manager's own language (CS-193, LANG-4).
    const lang = userLanguage(onTeam.get(m.managerId));
    await sendToUser(m.managerId, {
      title: unapprovedDigestTitle(lang),
      body: unapprovedDigestBody({ count: m.count, cleaners: m.cleanerIds.size, dayLabel: yesterdayKey }, lang),
      url: '/approvals?tab=approve',
      tag: `unapproved-${yesterdayKey}`,
    });
  }));
  return { dayKey: yesterdayKey, pending: rows.length, notified: sent, unassigned: unassigned.count };
}

// One read of the manager-write context: the caller's scope (null for owner/admin, else the
// Set of supervised customer ids) from the COMMITTED blob, and the first/latest closed run
// for the ledger lock — each read once per request (spec §5.1).
async function timeWriteContext(a) {
  const [slices, runs] = await Promise.all([
    readProtectedSlices('clients:state->clients,users:state->users'),
    readRunBounds(),
  ]);
  const clients = Array.isArray(slices?.clients) ? slices.clients : [];
  // The committed roster rides along so an Operations Manager's scope is their TEAM (S131,
  // lib/teamScope): the role is the claim's (`a.role`), the level the roster's.
  const users = Array.isArray(slices?.users) ? slices.users : [];
  const user = { id: a.orgUserId, role: a.role };
  return { user, scope: timeScopeFor(user, clients, users), firstRun: runs.firstRun, latestRun: runs.latestRun };
}

// Gate a single existing punch by scope, own, and (for correct/void/restore) the paid lock.
// Returns a refusal code or null. Approve never checks the lock (approving a pending punch
// only adds pay, and it arrives as arrears, §6.1).
function gatePunch(existing, { scope, user, firstRun, latestRun, checkLock }) {
  if (!inTimeScope(scope, existing.client_id)) return 'out-of-scope';
  if (refusesOwn(user, existing.user_id)) return 'own-entry';
  if (checkLock && isPaidLocked(existing, latestRun, firstRun)) return 'paid-locked';
  return null;
}

// ── CS-379 activity log: the five manager time edits + the two approvals ──────────────────
// A punch row already carries the customer and the cleaner's name, so nothing extra is read.
// Instants stay ISO in before/after — the reader re-zones them (the write point has no org
// timezone). Best-effort by contract: a failed audit row never fails a landed time edit.
const cleanerOf = (entry) => entry?.user_name || entry?.user_id || 'a cleaner';
function logTimeEdit(g, action, { entry, summary, before = null, after = null }) {
  return logActivityAs(g, {
    action,
    entityId: entry?.id || null,
    clientId: entry?.client_id || null,
    clientName: entry?.client_name || null,
    summary,
    before,
    after,
  });
}
const punchTimes = (e) => (e ? { startAt: e.clock_in_at ?? null, endAt: e.clock_out_at ?? null } : null);

// Approve each requested item on its own — a stale or refused item never blocks the others.
// version null on an item = a legacy (unversioned) approve, no CAS (see LEGACY_UNVERSIONED_UNTIL).
async function approveItems(items, g, ctx) {
  const byId = await getEntriesByIds(items.map((it) => it.entryId));
  const results = [];
  for (const it of items) {
    const existing = byId.get(it.entryId);
    if (!existing) { results.push({ entryId: it.entryId, ok: false, code: 'not-found' }); continue; }
    if (!inTimeScope(ctx.scope, existing.client_id)) { results.push({ entryId: it.entryId, ok: false, code: 'out-of-scope' }); continue; }
    if (refusesOwn(ctx.user, existing.user_id)) { results.push({ entryId: it.entryId, ok: false, code: 'own-entry' }); continue; }
    if (!existing.clock_out_at) { results.push({ entryId: it.entryId, ok: false, code: 'not-closed' }); continue; }
    if (existing.status === 'voided' || existing.status === 'no_show') { results.push({ entryId: it.entryId, ok: false, code: 'voided' }); continue; }
    if (existing.approval_status === 'approved') { results.push({ entryId: it.entryId, ok: true, entry: existing }); continue; } // idempotent
    const version = Number.isInteger(it.version) ? it.version : null;
    const r = await approveEntryRow({ existing, version, byUserId: g.orgUserId });
    if (r.notFound) { results.push({ entryId: it.entryId, ok: false, code: 'not-found' }); continue; }
    if (r.stale) { results.push({ entryId: it.entryId, ok: false, code: 'stale' }); continue; }
    // Logged here, not in the route, so a batch records ONE row per punch that actually moved
    // to approved — an already-approved item short-circuits above and adds nothing.
    await logTimeEdit(g, 'time.approved', {
      entry: r.entry || existing,
      summary: `${cleanerOf(existing)}: hours approved`,
      before: { status: existing.approval_status ?? 'pending', ...punchTimes(existing) },
      after: { status: 'approved' },
    });
    results.push({ entryId: it.entryId, ok: true, entry: r.entry });
  }
  return results;
}

// 🔴 CS-051: after a punch CLOSES, the server decides whether its clean is done (the last
// cleaner left) — never the screen, which saw only its own punch. Asked for any answer whose
// entry is closed: re-asking for a punch someone else already closed is a no-op read, and it
// covers the clock-out that lost a race to the cron or a manager. Best-effort inside
// (store.settleJobAfterPunchClosed): the punch is recorded whatever this answers.
async function settleIfClosed(entry) {
  if (!entry?.clock_out_at || !entry.job_id) return false;
  return (await settleJobAfterPunchClosed(entry.job_id)).jobDone === true;
}

// THE PUNCH BYPASS: clocking in to a clean you are not on, or clocking out (or replaying)
// someone else's punch. The owner/admin role list always had it; anyone holding
// time.edit.all under the committed matrix + overrides has it too (2026-09-23), because
// that key already lets its holder write or correct anyone's entries (manual / correct)
// and the list refused the 4th-tier manager. Returned as a function the store asks only
// when the caller is not on the clean / not the punch's owner, so a crew member's own punch
// costs no extra read; memoized, so a request reads the matrix at most once. An unreadable
// matrix answers no (fail closed: the crew rules apply).
function punchBypass(a) {
  let answer = null;
  return () => {
    if (MANAGER.includes(a.role)) return true;
    if (!answer) answer = permissionChecker(a).then((holds) => holds('time.edit.all'), () => false);
    return answer;
  };
}

// THE SCOPE HALF of that bypass (W5-M F2): the manager closing SOMEONE ELSE'S punch writes
// time only at the customers they supervise — the same rule `gatePunch` applies to correct /
// void / restore, and the same one `manual` applies to a new row. Returned as a function the
// store asks ONLY when the caller is not the punch's owner, so an ordinary crew clock-out
// pays for no extra read; memoized, so a request reads the blob at most once. Owner/admin
// are unscoped (timeScopeFor → null → inTimeScope true).
function punchScope(a) {
  let ctx = null;
  return async (entry) => {
    if (!ctx) ctx = timeWriteContext(a);
    return inTimeScope((await ctx).scope, entry.client_id ?? null);
  };
}

// Hard cap on a history page (bounded scan; the UI says "newest N" when hit).
const ENTRIES_CAP = 500;
// One page of a COMPLETE read (rollup / entries ?paged=1); the client pages until it
// holds the `total` the first page reports (lib/pagedFetch.js).
const PAGE_MAX = 2000;
const OFFSET_MAX = 1000000;
// covered-jobs spans the alert lookback or the Dashboard's 61-day KPI window.
const COVERAGE_MAX_DAYS = 93;
const ID_FILTER_MAX = 200;
// The Hours report reads at most a quarter in whole pay weeks; a year is the backstop.
const ROLLUP_MAX_DAYS = 400;
const LEGACY_ROLLUP_CAP = 5000;

// The complete reads page tens of thousands of rows at full volume (the covered-jobs
// scan, a payroll drive week) — more than the default function timeout allows.
export const config = { maxDuration: 60 };

// ── CS-083: the crew "drive to your next site" hint spends Google Routes money ──────────────
// Only an ask that would actually CALL Google counts: a pair already priced (drive_time_estimates,
// kept 180 days) is answered free and never refused, and so is a pair with no coordinates or no
// key (nothing to bill). The caller is one cleaner's My Day: one ask per finished clean whose
// next clean is somewhere else, so a real day is a handful of legs, each billed once and then
// cached. 30 billed asks an hour per login is twice a long day's legs in one hour, while a
// screen re-asking an unroutable pair (Google answers with no route, so nothing is cached and
// every ask is billed again) is refused after 30. Google's own cap on the project is 300
// ComputeRoutes a day (set 2026-10-13), so one login can spend at most a tenth of it in an hour.
// Per serverless instance (see _lib/rateLimit.js): a backstop against a runaway, not a quota.
export const DRIVE_ESTIMATE_RATE = { limit: 30, windowMs: 60 * 60 * 1000 };

export default async function handler(req, res) {
  // Vercel rewrites multi-segment paths via ?subpath=; single-seg hits the
  // catch-all directly. Same idiom as quotes / site-security.
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    // ---- crew clock-in (server geofence) ----
    if (action === 'clock-in' && req.method === 'POST') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(403).json({ error: 'Your login is not linked to a crew member' });
      const r = await clockIn({
        jobId: body.jobId,
        userId: a.orgUserId,
        isManager: punchBypass(a),
        deviceLat: body.lat, deviceLng: body.lng, accuracyM: body.accuracyM,
        // PAY-17: the cleaner's OPTIONAL note about an off-site punch. Recorded, never
        // required, and never able to change the server's verdict.
        offSiteReason: body.offSiteReason,
        clientPunchId: body.clientPunchId || null, // shared idempotency key vs a buffered replay
      });
      if (r.notFound) return res.status(404).json({ error: 'Job not found' });
      if (r.forbidden) return res.status(403).json({ error: 'You are not assigned to this clean' });
      if (r.duplicate) return res.status(409).json({ error: "You're already clocked in to this clean" });
      // 🔴 PAY-13 / CS-318 — still on the clock at ANOTHER clean. 409, naming that clean, so
      // the cleaner can go and close it; nothing has happened yet, so nothing is lost. A
      // manager (the punch bypass) never reaches this: the store lets them through and flags
      // the punch instead. An offline REPLAY is never refused for it at all (II.8).
      if (r.alreadyOpen) {
        return res.status(409).json({
          error: doublePunchMessage(r.openCleanName),
          code: DOUBLE_PUNCH_CODE,
          openEntryId: r.openPunch?.id || null,
          openCleanName: r.openCleanName || null,
        });
      }
      // PAY-17: there is no geofence refusal any more. An off-site clock-in is recorded as
      // 'outside', held pending like every punch, and the account's supervisor is alerted
      // by the store before this answers.
      return res.status(200).json({ entry: r.entry });
    }

    // ---- crew: replay a BUFFERED OFFLINE punch (§5.4) ----
    // The device buffered a clock event during an outage; on reconnect it replays
    // here. The store re-geofences the buffered coords server-side, accepts the
    // asserted event time only within a tight window, is idempotent on
    // clientPunchId, and flags source='offline_replay' (approval stays pending).
    if (action === 'replay' && req.method === 'POST') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(403).json({ error: 'Your login is not linked to a crew member' });
      let windowHours = 12;
      try {
        const { state } = await readOrgState();
        const w = state?.opsSettings?.offlineReplayWindowHours;
        if (Number.isFinite(w) && w > 0) windowHours = w;
      } catch { /* default 12h */ }
      const r = await replayPunch({
        clientPunchId: body.clientPunchId,
        userId: a.orgUserId, assertedUserId: body.userId || null, isManager: punchBypass(a),
        jobId: body.jobId || null, entryId: body.entryId || null,
        assertedInAt: body.assertedInAt || null, assertedOutAt: body.assertedOutAt || null,
        inLat: body.inLat, inLng: body.inLng, inAccuracyM: body.inAccuracyM,
        outLat: body.outLat, outLng: body.outLng, outAccuracyM: body.outAccuracyM,
        windowHours,
      });
      if (r.badRequest) return res.status(400).json({ error: r.badRequest });
      if (r.notFound) return res.status(404).json({ error: 'Job or entry not found' });
      // Identity mismatch is NOT terminal — the punch belongs to a different crew
      // member (shared device). Signal it so the client HOLDS it for its real owner
      // rather than marking it permanently failed.
      if (r.identityMismatch) return res.status(403).json({ error: 'This buffered punch belongs to a different crew member', identityMismatch: true });
      if (r.forbidden) return res.status(403).json({ error: 'You are not assigned to this clean' });
      // duplicate one-open-per-job = the punch is effectively already recorded; the
      // client should stop retrying it, so report success (idempotent), not an error.
      if (r.duplicate) return res.status(200).json({ entry: null, duplicate: true });
      if (r.retryable) return contended(res);
      return res.status(200).json({
        entry: r.entry, idempotent: !!r.idempotent,
        outsideWindow: !!r.outsideWindow, alreadyOut: !!r.alreadyOut,
        jobDone: await settleIfClosed(r.entry), // CS-051: the offline twin of the clock-out
      });
    }

    // ---- clock-out (no geofence) ----
    if (action === 'clock-out' && req.method === 'POST') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(403).json({ error: 'Your login is not linked to a crew member' });
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      const r = await clockOut({
        entryId: body.entryId, userId: a.orgUserId,
        isManager: punchBypass(a), inScope: punchScope(a),
        // PAY-12: the accuracy widens the ring for the clock-OUT verdict exactly as it does at
        // clock-in. The verdict itself is the server's — nothing in the body can assert it.
        deviceLat: body.lat, deviceLng: body.lng, accuracyM: body.accuracyM,
      });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
      if (r.forbidden) return res.status(403).json({ error: 'Not your time entry' });
      // Closing someone else's punch at a location that isn't theirs — the same refusal
      // time/correct gives the same manager for the same punch (W5-M F2).
      if (r.outOfScope) return refuse(res, 'out-of-scope');
      // R4 — the ENTRY OWNER's own clock-out, with their checklist for this clean
      // unfinished and no per-cleaner exemption. 409, and the punch stays open. Never
      // reached by the punch bypass (the office closes the entry), by time/correct or
      // time/manual (time.edit.all), or by the auto-close cron.
      if (r.checklistIncomplete) {
        return res.status(409).json({
          error: CHECKLIST_INCOMPLETE_ERROR,
          code: CHECKLIST_INCOMPLETE_CODE,
          done: r.done,
          total: r.total,
        });
      }
      // The gate could not be READ (the blob, the job row or checklist_results). Fail
      // CLOSED — nothing is recorded — but as a retryable 503 with its own code and no
      // provider text, not a 500 carrying "permission denied for relation …" (CS-077).
      if (r.checklistCheckFailed) {
        return res.status(503).json({ error: CHECKLIST_CHECK_FAILED_ERROR, code: CHECKLIST_CHECK_FAILED_CODE });
      }
      if (r.retryable) return contended(res);
      // CS-051: the clean is done only if this was its LAST open punch — decided here, where
      // every punch on it is visible, and written by the server; the screen follows jobDone.
      return res.status(200).json({ entry: r.entry, alreadyOut: !!r.alreadyOut, jobDone: await settleIfClosed(r.entry) });
    }

    // ---- manager: correct an entry (Correct) ----
    // Scope + own + the paid-lock, then validate the resulting times (a closed punch's
    // clock-out can't be cleared), then the versioned write. A changed clock time on an
    // approved punch is sent back to pending in the store.
    if (action === 'correct' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      // PAY-11 (Matt, 2026-09-29): a manager's edit always names a reason — checked before
      // anything is read, the same shape Delete has always used. Shared rule, so the route,
      // the demo stub and the modal cannot drift.
      if (reasonRefusal(body.reason)) return refuse(res, 'reason-required');
      const existing = await getEntry(body.entryId);
      if (!existing) return res.status(404).json({ error: 'Time entry not found' });
      const ctx = await timeWriteContext(g);
      const refusal = gatePunch(existing, { ...ctx, checkLock: true });
      if (refusal) return refuse(res, refusal);
      const patch = body.patch || {};
      const newIn = patch.clock_in_at !== undefined ? patch.clock_in_at : existing.clock_in_at;
      const newOut = ('clock_out_at' in patch) ? patch.clock_out_at : existing.clock_out_at;
      const vcode = validatePunchTimes({ clockInAt: newIn, clockOutAt: newOut, now: Date.now(), requireOut: !!existing.clock_out_at });
      if (vcode) return refuse(res, vcode);
      const version = Number.isInteger(body.version) ? body.version : null; // missing = legacy (LEGACY_UNVERSIONED_UNTIL)
      const r = await correctEntryRow({ existing, version, patch, reason: trimmedReason(body.reason), byUserId: g.orgUserId });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
      if (r.stale) return refuse(res, 'stale');
      // CS-694: nothing in the patch differs from the punch (a time compared as an instant, not
      // by its spelling), so nothing was written — and nothing happened to log.
      if (r.unchanged) return res.status(200).json({ entry: r.entry, jobDone: false, unchanged: true });
      await logTimeEdit(g, 'time.corrected', {
        entry: r.entry || existing,
        summary: `${cleanerOf(existing)}: time corrected — ${trimmedReason(body.reason)}`,
        before: punchTimes(existing),
        after: punchTimes(r.entry),
      });
      // CS-051: entering the clock-out of a forgotten punch closes it like a clock-out does —
      // if it was the clean's last open punch, the clean is done.
      const jobDone = !existing.clock_out_at ? await settleIfClosed(r.entry) : false;
      return res.status(200).json({ entry: r.entry, jobDone });
    }

    // ---- manager: manual entry (Add time) ----
    // Server re-derives the clean's customer from the job; scope on that customer, own
    // (owner-only), then validation. Lands pending (arrears if into closed territory).
    if (action === 'manual' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.userId || !body.clockInAt) return res.status(400).json({ error: 'userId and clockInAt are required' });
      // PAY-11: a manual add asserts times nobody clocked, so it names a reason too. There is
      // no default text — the modal used to send 'manual entry' when the field was blank,
      // which made the audit trail say nothing at all.
      if (reasonRefusal(body.reason)) return refuse(res, 'reason-required');
      const ctx = await timeWriteContext(g);
      if (refusesOwn(ctx.user, body.userId)) return refuse(res, 'own-entry');
      const jobCtx = await resolveJobContext(body.jobId || null, body.userId);
      if (!inTimeScope(ctx.scope, jobCtx.clientId)) return refuse(res, 'out-of-scope');
      const vcode = validatePunchTimes({ clockInAt: body.clockInAt, clockOutAt: body.clockOutAt || null, now: Date.now(), requireOut: false });
      if (vcode) return refuse(res, vcode);
      const r = await manualEntry({
        ctx: jobCtx, userId: body.userId,
        clockInAt: body.clockInAt, clockOutAt: body.clockOutAt || null,
        note: body.note, reason: trimmedReason(body.reason), byUserId: g.orgUserId,
      });
      await logTimeEdit(g, 'time.added', {
        entry: r.entry,
        summary: `${cleanerOf(r.entry)}: time added by hand — ${trimmedReason(body.reason)}`,
        after: punchTimes(r.entry),
      });
      return res.status(200).json({ entry: r.entry });
    }

    // ---- manager: approve (batch, versioned) ----
    // { items: [{ entryId, version }] } (≤ 200) → { results: [{ entryId, ok, code?, entry? }] },
    // each judged alone. Reject was removed (Delete replaces it): the legacy body
    // { entryId, approval } from a cached bundle is 400 reject-removed for 'rejected', or one
    // unversioned item for 'approved'. TODO(remove-by: 2026-11-01) — LEGACY_UNVERSIONED_UNTIL.
    if (action === 'approve' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.approve');
      if (!g) return;
      const ctx = await timeWriteContext(g);
      if (!Array.isArray(body.items) && body.entryId) {
        if (body.approval === 'rejected') return refuse(res, 'reject-removed');
        const results = await approveItems([{ entryId: body.entryId }], g, ctx); // no version check
        const one = results[0];
        if (one && !one.ok) return refuse(res, one.code === 'not-found' ? 'invalid-times' : one.code);
        return res.status(200).json({ results, entry: one?.entry || null });
      }
      const items = Array.isArray(body.items) ? body.items : [];
      // The cap is the Hours Approval page's batch size too (lib/filters/timeApprovals), so the
      // screen cuts its batches at the same number this refuses above.
      if (items.length > APPROVE_BATCH_MAX) return res.status(400).json({ error: `At most ${APPROVE_BATCH_MAX} items per approve`, code: 'too-many' });
      const results = await approveItems(items, g, ctx);
      return res.status(200).json({ results });
    }

    // ---- manager: approve overtime (batch) ----
    // { items: [{ userId, weekKey, clientId, minutes }] } (≤200) → { results: [{ key, ok,
    // code?, approvedMinutes? }] }, each judged alone. The stored value is the unit's TOTAL
    // approved OT (not an increment): clientId in the caller's scope, own refused unless
    // owner, weekKey a real day that starts the ORG's pay week, minutes clamped 0..10080. No
    // ledger read — approving OT only adds pay, and it lands on the next run as arrears (§6.1).
    if (action === 'ot-approve' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.approve');
      if (!g) return;
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > 200) return res.status(400).json({ error: 'At most 200 items per approve', code: 'too-many' });
      const slices = await readProtectedSlices('clients:state->clients,users:state->users,opsSettings:state->opsSettings');
      const clients = Array.isArray(slices?.clients) ? slices.clients : [];
      const users = Array.isArray(slices?.users) ? slices.users : [];
      // 🔴 CS-659: the unit's week is the ORG's workweek — the same `payWeekStartDay` the approvals
      // read below built it on (Monday in production). A Sunday-only check refused every Monday
      // unit, and unapproved overtime is held by the pay run, so no hour past 40 was ever paid.
      const weekStartDay = payWeekStartDayOf(slices?.opsSettings);
      const user = { id: g.orgUserId, role: g.role };
      const scope = timeScopeFor(user, clients, users);
      const results = [];
      for (const it of items) {
        const clientId = (it && it.clientId != null) ? String(it.clientId) : '';
        const key = `${it?.userId ?? ''}|${it?.weekKey ?? ''}|${clientId}`;
        // A valid OT unit needs a real cleaner and a key that starts one of the org's pay weeks.
        if (!it || !it.userId || !isPayWeekKey(it.weekKey, weekStartDay)) {
          results.push({ key, ok: false, code: 'invalid-week' }); continue;
        }
        if (!inTimeScope(scope, clientId)) { results.push({ key, ok: false, code: 'out-of-scope' }); continue; }
        if (refusesOwn(user, it.userId)) { results.push({ key, ok: false, code: 'own-entry' }); continue; }
        const minutes = Math.max(0, Math.min(10080, Math.round(Number(it.minutes) || 0)));
        const r = await setOtApproval({ userId: it.userId, weekKey: it.weekKey, clientId, minutes, byUserId: g.orgUserId });
        // CS-379: the stored value is the unit's TOTAL approved OT, so the log records the
        // total, the week and the customer — hours that become pay.
        await logActivityAs(g, {
          action: 'time.overtime_approved',
          entityId: `${it.userId}|${it.weekKey}|${clientId}`,
          clientId: clientId || null,
          clientName: clients.find((c) => c.id === clientId)?.name || null,
          summary: `Overtime approved for the week of ${it.weekKey}: ${(r.approvedMinutes / 60).toFixed(2)} h`,
          after: { minutes: r.approvedMinutes },
        });
        results.push({ key, ok: true, approvedMinutes: r.approvedMinutes });
      }
      return res.status(200).json({ results });
    }

    // ---- manager: the Approvals READ (pending punches + overtime awaiting) ----
    // Scope + gating are enforced HERE, not just in the UI (spec §2 last ¶). Returns the
    // pending punches of gated people in scope (not pre-ledger), each carrying its attributed
    // OT, and the OT units awaiting approval over the considered weeks. supervisorId is
    // honoured for an unscoped (owner/admin) caller, and for an Operations Manager within their
    // team (S131); 'none' = customers with no manager
    // plus punches with no customer.
    if (action === 'approvals' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'time.approve');
      if (!g) return;
      const asOf = new Date().toISOString();
      const now = new Date();
      const slices = await readProtectedSlices('clients:state->clients,users:state->users,company:state->company,opsSettings:state->opsSettings');
      const clients = Array.isArray(slices?.clients) ? slices.clients : [];
      const users = Array.isArray(slices?.users) ? slices.users : [];
      const tz = slices?.company?.timezone || DEFAULT_ORG_TIMEZONE;
      const cadence = slices?.opsSettings?.payPeriodCadence || 'biweekly';
      const weekStartDay = payWeekStartDayOf(slices?.opsSettings);
      const usersById = new Map(users.map((u) => [u.id, u]));
      const clientsById = new Map(clients.map((c) => [c.id, c]));

      const user = { id: g.orgUserId, role: g.role };
      const scope = timeScopeFor(user, clients, users);       // null = owner/admin; an OM's team (S131)
      const unscoped = scope === null;

      // Effective scope. supervisorId bites for an unscoped caller, and for an Operations Manager
      // within their team only (one account manager's buildings — never beyond the team).
      const supervisorId = typeof req.query.supervisorId === 'string' ? req.query.supervisorId : null;
      let effClientIds = null;          // null = every customer (owner, unfiltered)
      let includeNoCustomer = false;    // no-customer punches are owner-only
      if (unscoped) {
        includeNoCustomer = true;
        if (supervisorId === 'none') {
          effClientIds = new Set(clients.filter((c) => !c.supervisorId).map((c) => c.id));
        } else if (supervisorId === TEAM) {
          // `team` (S131 Wave 2: the owner's Operations view's Hours Approval tile): the owner or an
          // admin names WHOSE team with `om` — an active Operations Manager (lib/teamScope teamLeadFor,
          // the one rule; any other `om` is the caller's own, which holds no buildings of its own).
          const om = typeof req.query.om === 'string' ? req.query.om : null;
          effClientIds = teamClientIds(users, clients, teamLeadFor({ role: g.role, selfId: g.orgUserId, users, om }));
          includeNoCustomer = false;
        } else if (supervisorId) {
          effClientIds = new Set(clients.filter((c) => c.supervisorId === supervisorId).map((c) => c.id));
          includeNoCustomer = false;
        }
      } else {
        effClientIds = scope;
        if (supervisorId && supervisorId !== TEAM && teamMemberIds(users, g.orgUserId).includes(supervisorId)) {
          effClientIds = new Set([...scope].filter((id) => clientsById.get(id)?.supervisorId === supervisorId));
        }
      }
      const inEff = (clientId) => {
        const c = clientId || '';
        if (c === '') return includeNoCustomer;
        if (effClientIds === null) return true;
        return effClientIds.has(c);
      };
      const isGatedId = (userId) => isGatedUser(usersById.get(userId));

      const { firstRun, latestRun } = await readRuns();
      const floorIso = firstRun?.from_iso || null;            // "not pre-ledger" cutoff
      const scopedEmpty = !unscoped && effClientIds instanceof Set && effClientIds.size === 0;

      // Pending punches (complete, oldest first). Push the customer filter down only for a
      // SCOPED manager (no null-customer punches to include); unscoped reads all and filters.
      let pendingRows = [];
      if (!scopedEmpty) {
        const clientFilter = (!unscoped && effClientIds instanceof Set) ? [...effClientIds] : undefined;
        pendingRows = await listPendingApprovalsAll({ fromIso: floorIso, clientIds: clientFilter });
      }
      pendingRows = pendingRows.filter((r) => isWorkedEntry(r) && isGatedId(r.user_id) && inEff(r.client_id));

      // Considered weeks = open territory ∪ weeks changed since the latest close ∪ the latest
      // run's held_ot weeks ∪ the weeks of the pending punches.
      const considered = new Set();
      const openStart = openTerritoryStart({ latestRun, cadence, tz, weekStartDay, now });
      { let w = payWeekKeyOf(openStart.fromKey, weekStartDay, tz); const end = payWeekKeyOf(now, weekStartDay, tz);
        for (let i = 0; w <= end && i < 520; i += 1) { considered.add(w); w = addDaysKey(w, 7); } }
      const changed = await changedWeeksSinceLatestClose({ firstRun, latestRun, tz, weekStartDay });
      for (const uw of changed) considered.add(uw.split('|')[1]);
      for (const h of Array.isArray(latestRun?.held_ot) ? latestRun.held_ot : []) if (h?.weekKey) considered.add(h.weekKey);
      for (const r of pendingRows) considered.add(payWeekKeyOf(r.clock_in_at, weekStartDay, tz));

      // Build the ledger over the considered-weeks span for the relevant users.
      let items = [];
      let otUnits = [];
      if (!scopedEmpty && considered.size) {
        const weekKeys = [...considered].sort();
        const spanFromIso = startOfDayKey(weekKeys[0], tz).toISOString();
        const spanEndKey = addDaysKey(weekKeys[weekKeys.length - 1], 7);
        const spanToIso = new Date(startOfDayKey(spanEndKey, tz).getTime() - 1).toISOString();

        let entryRows;
        let userIds;
        if (unscoped) {
          // Owner/admin: read the company over the span; the ledger is filtered to the
          // effective scope below. Drive over everyone.
          entryRows = await listForReportAll({ fromIso: spanFromIso, toIso: spanToIso }, { columns: LEDGER_ENTRY_COLUMNS });
          userIds = undefined;
        } else {
          // A scoped manager: the gated cleaners who worked at an IN-SCOPE customer in the
          // span, then ALL of THEIR punches in the span (OT is company-wide per person).
          const seed = await listForReportAll({ fromIso: spanFromIso, toIso: spanToIso, clientIds: [...effClientIds] }, { columns: LEDGER_ENTRY_COLUMNS });
          userIds = [...new Set(seed.filter((r) => isGatedId(r.user_id)).map((r) => r.user_id))];
          entryRows = userIds.length ? await listForReportAll({ fromIso: spanFromIso, toIso: spanToIso, userIds }, { columns: LEDGER_ENTRY_COLUMNS }) : [];
        }
        // Paid drive legs feed the 40 h line. A failed drive read FAILS the run (it must not
        // silently under-count OT); the payroll read is compact + complete + no estimates.
        const drive = await runDriveReport({ fromIso: spanFromIso, toIso: spanToIso, filters: userIds ? { userIds } : {}, payroll: true });
        const legs = Array.isArray(drive?.rows) ? drive.rows : [];

        const ledgerUsers = userIds || [...new Set(entryRows.map((r) => r.user_id))];
        const otApprovals = await readOtApprovalsForUsers(ledgerUsers, weekKeys);
        const led = computeWeekLedger({ entries: entryRows.map(entryFromRow), driveSegments: legs, otApprovals, tz, weekStartDay });
        items = led.items;
        otUnits = led.otUnits.filter((u) => considered.has(u.weekKey));
      }

      const otByEntry = entryOtMinutes(items);
      const pending = pendingRows.map((r) => ({ ...r, ot_minutes: otByEntry.get(r.id) || 0 }));
      const overtime = overtimeUnitsForApproval(otUnits, { usersById, clientsById, inScope: inEff, isGated: isGatedId });

      return res.status(200).json({
        scope: { unscoped, clientIds: unscoped ? null : [...(effClientIds || [])] },
        pending,
        overtime,
        ledger: { firstFromKey: firstRun?.from_key || null, latestToKey: latestRun?.to_key || null, latestClosedAt: latestRun?.closed_at || null },
        asOf,
      });
    }

    // ---- manager: delete an entry (Void) ----
    if (action === 'void' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      if (reasonRefusal(body.reason)) return refuse(res, 'reason-required');
      const existing = await getEntry(body.entryId);
      if (!existing) return res.status(404).json({ error: 'Time entry not found' });
      const ctx = await timeWriteContext(g);
      const refusal = gatePunch(existing, { ...ctx, checkLock: true });
      if (refusal) return refuse(res, refusal);
      const version = Number.isInteger(body.version) ? body.version : null;
      const r = await voidEntryRow({ existing, version, reason: trimmedReason(body.reason), byUserId: g.orgUserId });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
      if (r.stale) return refuse(res, 'stale');
      await logTimeEdit(g, 'time.deleted', {
        entry: r.entry || existing,
        summary: `${cleanerOf(existing)}: time deleted — ${trimmedReason(body.reason)}`,
        before: { status: existing.status ?? null, ...punchTimes(existing) },
        after: { status: r.entry?.status ?? 'voided' },
      });
      // CS-051: a deleted OPEN punch held someone on the clock who wasn't there. If everyone
      // else has clocked out, the clean is done (the rule needs a real clock-out, so deleting
      // the only punch on a clean finishes nothing).
      const jobDone = (!existing.clock_out_at && existing.job_id)
        ? (await settleJobAfterPunchClosed(existing.job_id)).jobDone === true
        : false;
      return res.status(200).json({ entry: r.entry, jobDone });
    }

    // ---- manager: restore a voided entry (Restore) ----
    if (action === 'restore' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      const existing = await getEntry(body.entryId);
      if (!existing) return res.status(404).json({ error: 'Time entry not found' });
      const ctx = await timeWriteContext(g);
      const refusal = gatePunch(existing, { ...ctx, checkLock: true });
      if (refusal) return refuse(res, refusal);
      const version = Number.isInteger(body.version) ? body.version : null;
      const r = await restoreEntryRow({ existing, version, reason: body.reason, byUserId: g.orgUserId });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
      if (r.stale) return refuse(res, 'stale');
      await logTimeEdit(g, 'time.restored', {
        entry: r.entry || existing,
        summary: `${cleanerOf(existing)}: time restored${trimmedReason(body.reason) ? ` — ${trimmedReason(body.reason)}` : ''}`,
        before: { status: existing.status ?? null },
        after: { status: r.entry?.status ?? null, ...punchTimes(r.entry) },
      });
      return res.status(200).json({ entry: r.entry });
    }

    // ---- a clean was cancelled: stop the clock + flag its labor (manager) ----
    // Triggered by the JobDetail Cancel action. Gated on the SAME authority that cancels
    // the job (schedule.edit): closing these punches is a bounded side effect of that
    // authorized cancel; it only ever clocks out / flags punches for the ONE job id,
    // never free-form time editing (that stays time.edit.all). Idempotent server-side.
    if (action === 'job-cancelled' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'schedule.edit');
      if (!g) return;
      if (!body.jobId) return res.status(400).json({ error: 'jobId is required' });
      return res.status(200).json(await cancelJobLabor(body.jobId, {}));
    }

    // ---- the caller's own entries (clock screen) ----
    if (action === 'mine' && req.method === 'GET') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(200).json({ entries: [] });
      const entries = await listMine(a.orgUserId, { sinceIso: req.query.sinceIso });
      return res.status(200).json({ entries });
    }

    // ---- EP-381 — the cleaner's MY HOURS (the Cleaner Hub, 2026-10-13, brief C §3; view only) ----
    // AUTH STANCE: requireAuthority, then SELF from the login's claim; an office login may name
    // another person (`userId`, the owner's View-as) only while holding time.view, the key that
    // already shows them everyone's punches on the Time Clock (_lib/crewPreview; else 403); a crew
    // login is always itself. The PERIOD is the payroll's own calendar, worked out here from the
    // FULL opsSettings — the crew projection strips the cadence and the week start (crewView
    // OPS_PAYRUN_FIELDS) — in the org's zone (lib/myHours). The answer is days and totals: no
    // punch row, no place, no other person.
    if (action === 'my-hours' && req.method === 'GET') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      const who = await crewReadSubject(a, req.query.userId, 'time.view');
      if (who.status) return res.status(who.status).json({ error: who.error, code: who.code });
      const slices = await readProtectedSlices('opsSettings:state->opsSettings,company:state->company');
      const tz = slices?.company?.timezone || DEFAULT_ORG_TIMEZONE;
      const opsSettings = slices?.opsSettings || {};
      const offset = myHoursOffset(req.query.offset);
      const now = Date.now();
      const entries = who.userId ? await listOwnPunchesInWindow({ userId: who.userId, ...myHoursWindow({ opsSettings, now, offset, tz }) }) : [];
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json(myHoursPeriod({ entries, opsSettings, now, offset, tz }));
    }

    // ---- EP-422 / EP-423 — "On my way" (Matt's approved "Crew on the way" text, 2026-10-19) ----
    // AUTH STANCE: requireAuthority; the POST is CREW from the claim (403 crew-only otherwise), on
    // a clean the caller is ON, upcoming, on today's list — re-checked from the stored job, never
    // the body (api/_lib/customerMessages/onTheWay.js). The GET reads only whether texting is on and
    // which of the named cleans already sent.
    if (action === 'on-my-way' && (req.method === 'GET' || req.method === 'POST')) {
      const a = await requireAuthority(req, res);
      if (!a) return;
      const out = req.method === 'GET' ? await onMyWayStatus(a, req.query || {}) : await onMyWaySend(a, body);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(out.status).json(out.body);
    }

    // ---- who's on the clock (manager) ----
    if (action === 'open' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'variance.view');
      if (!g) return;
      return res.status(200).json({ entries: await listOpen() });
    }

    // ---- weekly-hours / OT rollup + payroll source (manager) ----
    // Completed labor rows in [fromIso,toIso]; approvedOnly=1 for the payroll
    // export. The reg/OT split is computed client-side by the SHARED lib/payroll.js.
    // ?paged=1 is the COMPLETE read the pay run + Hours report use: oldest-first pages of
    // <= PAGE_MAX rows, the first carrying `total`, which the client pages through until
    // it has every row (lib/pagedFetch.js). Without it: the old capped single read, kept
    // only for app bundles cached before paging shipped.
    if (action === 'rollup' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'variance.view');
      if (!g) return;
      const fromIso = isoParam(req.query.fromIso);
      const toIso = isoParam(req.query.toIso);
      if (fromIso === undefined || toIso === undefined) {
        return res.status(400).json({ error: 'fromIso / toIso must be ISO-8601 timestamps' });
      }
      const filters = { fromIso, toIso, approvedOnly: req.query.approvedOnly === '1' };
      if (req.query.paged === '1') {
        if (!fromIso || !toIso) return res.status(400).json({ error: 'A paged read needs both fromIso and toIso' });
        if (Date.parse(toIso) - Date.parse(fromIso) > ROLLUP_MAX_DAYS * 86400000) {
          return res.status(400).json({ error: `A rollup spans at most ${ROLLUP_MAX_DAYS} days` });
        }
        const offset = intParam(req.query.offset, 0, 0, OFFSET_MAX);
        const limit = intParam(req.query.limit, PAGE_MAX, 1, PAGE_MAX);
        const [total, entries] = await Promise.all([
          offset === 0 ? countForRollup(filters) : Promise.resolve(null),
          pageForRollup(filters, { offset, limit }),
        ]);
        return res.status(200).json({ entries, total, offset, limit });
      }
      // The old single read, for app bundles cached before paging shipped (an installed
      // PWA resumed on Payroll). They can't page and never checked for truncation, so a
      // window past the cap is REFUSED — their error banner says reload — rather than
      // answered with the newest rows, which would under-pay.
      if (await countForRollup(filters) > LEGACY_ROLLUP_CAP) {
        return res.status(409).json({ error: 'This screen needs the latest version of the app to load every punch. Reload the app and try again.' });
      }
      return res.status(200).json({ entries: await listForRollup({ ...filters, limit: LEGACY_ROLLUP_CAP }) });
    }

    // ---- "covered" cleans: distinct job ids with a real clock-in in a window ----
    // The late/missed alerts and the Dashboard missed-cleans KPI only need to know WHICH
    // cleans someone clocked into, so the server reads every punch in the window and
    // answers with the job ids — complete at any volume, and a fraction of the payload.
    if (action === 'covered-jobs' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'time.view');
      if (!g) return;
      const fromIso = isoParam(req.query.fromIso);
      const toIso = isoParam(req.query.toIso);
      if (!fromIso || !toIso) {
        return res.status(400).json({ error: 'fromIso and toIso are required ISO-8601 timestamps' });
      }
      if (Date.parse(toIso) - Date.parse(fromIso) > COVERAGE_MAX_DAYS * 86400000) {
        return res.status(400).json({ error: `The window can span at most ${COVERAGE_MAX_DAYS} days` });
      }
      return res.status(200).json({ jobIds: await coveredJobIdsInWindow({ fromIso, toIso }) });
    }

    // ---- clock-in/out HISTORY (manager): the Time Clock surfaces ----
    // Raw rows (same shape as mine/open/rollup) in [fromIso,toIso], optionally
    // narrowed to sites / accounts / cleaners / jobs. Newest first, capped. This is
    // the read the account, crew-member and job pages + /time use to show punches.
    // Before it existed the ONLY manager view of a punch was the Variance report,
    // so rows sat in time_entries — correctly linked to job/site/client — while
    // every page the office actually looks at showed nothing (Sept 3 report:
    // "can't see clock history / not registering with the locations").
    if (action === 'entries' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'time.view');
      if (!g) return;
      const fromIso = isoParam(req.query.fromIso);
      const toIso = isoParam(req.query.toIso);
      if (fromIso === undefined || toIso === undefined) {
        return res.status(400).json({ error: 'fromIso / toIso must be ISO-8601 timestamps' });
      }
      const idFilters = {
        siteIds: idList(req.query.siteIds),
        clientIds: idList(req.query.clientIds),
        userIds: idList(req.query.userIds),
        jobIds: idList(req.query.jobIds),
      };
      // ?paged=1 — the COMPLETE read (Reports › Not clocked in / out): a bounded window,
      // oldest-first pages, the first carrying `total`. ?lite=1 narrows each punch to the
      // columns attendance reads. An id filter is never trimmed here — trimming it would
      // silently drop rows from a read that promises every row.
      if (req.query.paged === '1') {
        if (!fromIso || !toIso) {
          return res.status(400).json({ error: 'A paged read needs both fromIso and toIso' });
        }
        if (Object.values(idFilters).some((list) => list.length > ID_FILTER_MAX)) {
          return res.status(400).json({ error: `At most ${ID_FILTER_MAX} ids per filter` });
        }
        const offset = intParam(req.query.offset, 0, 0, OFFSET_MAX);
        const limit = intParam(req.query.limit, PAGE_MAX, 1, PAGE_MAX);
        const columns = req.query.lite === '1' ? ATTENDANCE_COLUMNS : '*';
        const filters = { fromIso, toIso, ...idFilters };
        const [total, entries] = await Promise.all([
          offset === 0 ? countForReport(filters) : Promise.resolve(null),
          pageForReport(filters, { offset, limit, columns }),
        ]);
        return res.status(200).json({ entries, total, offset, limit });
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || ENTRIES_CAP, 1), ENTRIES_CAP);
      // Fetch one past the cap so `truncated` is exact (and agrees with the demo stub).
      const rows = await listForReport({
        fromIso, toIso,
        siteIds: idFilters.siteIds.slice(0, ID_FILTER_MAX),
        clientIds: idFilters.clientIds.slice(0, ID_FILTER_MAX),
        userIds: idFilters.userIds.slice(0, ID_FILTER_MAX),
        jobIds: idFilters.jobIds.slice(0, ID_FILTER_MAX),
        limit: limit + 1,
      });
      return res.status(200).json({ entries: rows.slice(0, limit), truncated: rows.length > limit });
    }

    // ---- drive time BETWEEN jobs: the manager report (derived, never stored) ----
    // Paid inter-site travel = clock-out at one clean -> clock-in at the next,
    // within the configured gap cap, flagged against a Google Routes estimate.
    if (action === 'drive-report' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'variance.view');
      if (!g) return;
      const payroll = !!body.payroll;          // COMPLETE window read + compact rows (pay run / Hours / OT watch)
      if (payroll) {
        // A payroll read must be bounded: legs departing in [fromIso, toIso], at most
        // PAYROLL_MAX_DAYS per call (lib/driveApi chunks longer windows by week).
        const f = isoParam(body.fromIso);
        const t = isoParam(body.toIso);
        if (!f || !t) return res.status(400).json({ error: 'A payroll drive read needs both fromIso and toIso' });
        const span = Date.parse(t) - Date.parse(f);
        if (span < 0 || span > PAYROLL_MAX_DAYS * 86400000) {
          return res.status(400).json({ error: `A payroll drive read spans at most ${PAYROLL_MAX_DAYS} days` });
        }
      }
      return res.status(200).json(await runDriveReport({
        fromIso: body.fromIso || null,
        toIso: body.toIso || null,
        filters: body.filters || {},
        skipEstimates: !!body.skipEstimates,   // payroll path — never bills a Routes call
        payroll,
      }));
    }

    // ---- drive estimate for ONE site pair (the crew "next site" hint) ----
    // Site coordinates are resolved server-side from the blob; the client sends
    // only ids, so a device can't spoof the baseline its own drive is judged against.
    if (action === 'drive-estimate' && req.method === 'GET') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      const { fromSiteId, toSiteId } = req.query;
      if (!fromSiteId || !toSiteId) return res.status(400).json({ error: 'fromSiteId and toSiteId are required' });
      const { state } = await readOrgState();
      // CS-083: the allowance is asked only just before a billable Routes call (DRIVE_ESTIMATE_RATE),
      // keyed on the login, never the IP. A refused ask is a 429; the hint hides, as for any failure.
      let refused = null;
      const est = await resolveOneEstimate(String(fromSiteId), String(toSiteId), siteMapFrom(state), {
        mayFetch: () => {
          const r = hit(`drive-estimate:${a.orgUserId || a.email || a.user?.id || 'unknown'}`, DRIVE_ESTIMATE_RATE);
          if (!r.ok) refused = r;
          return r.ok;
        },
      });
      if (refused) return tooMany(res, refused.retryAfterMs, 'rate-limited');
      return res.status(200).json({ estimate: est });   // null = not routable / no key (fail-soft)
    }

    // ---- manager: adjust or exclude the paid minutes on ONE drive leg ----
    // Recorded travel is compensable, so nothing is docked automatically — this is
    // the only path that changes what a leg pays, and it always carries a reason.
    if (action === 'drive-override' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.fromEntryId || !body.toEntryId) return res.status(400).json({ error: 'fromEntryId and toEntryId are required' });
      // The leg pays whoever ARRIVES: scope + own + the closed-territory refusal key on the
      // DESTINATION punch (spec §2 / §5.1). A manager may not adjust a leg into a customer
      // that isn't theirs, into their own arrival, or in a period already closed (drive pay
      // is priced at close and can't be changed after — §6.1).
      const ctx = await timeWriteContext(g);
      const dest = await getEntry(body.toEntryId);
      if (!inTimeScope(ctx.scope, dest?.client_id ?? null)) return refuse(res, 'out-of-scope');
      if (refusesOwn(ctx.user, dest?.user_id ?? null)) return refuse(res, 'own-entry');
      if (dest && isInClosedTerritory(dest.clock_in_at, ctx.firstRun, ctx.latestRun)) return refuse(res, 'paid-locked');
      if (body.action === 'clear') {
        const r = await clearOverride({ fromEntryId: body.fromEntryId, toEntryId: body.toEntryId });
        if (r.badRequest) return res.status(400).json({ error: r.badRequest });
        return res.status(200).json(r);
      }
      // Denormalize the approver's name at write (the house pattern) so the audit
      // line still reads correctly after that manager leaves the roster.
      let byName = g.email || null;
      try {
        const { state } = await readOrgState();
        byName = (state?.users || []).find((u) => u.id === g.orgUserId)?.name || byName;
      } catch { /* fall back to the login email */ }
      const r = await upsertOverride({
        fromEntryId: body.fromEntryId, toEntryId: body.toEntryId,
        excluded: !!body.excluded,
        paidMinutes: Number.isFinite(body.paidMinutes) ? body.paidMinutes : null,
        reason: body.reason,
        actualMinutes: Number.isFinite(body.actualMinutes) ? body.actualMinutes : null,
        estimateMinutes: Number.isFinite(body.estimateMinutes) ? body.estimateMinutes : null,
        byUserId: g.orgUserId, byName,
      });
      if (r.badRequest) return res.status(400).json({ error: r.badRequest });
      return res.status(200).json(r);
    }

    // ---- demo-period history upload (crew self; Sept 1 recovery) --------------
    // A phone that ran the stale demo-clock build offers its localStorage punch
    // history once it loads a current build (StubRecoveryBanner). Self-only: the
    // rows land under the TOKEN-resolved identity regardless of payload claims.
    if (action === 'recover-stub' && req.method === 'POST') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(403).json({ error: 'Your login is not linked to a crew member' });
      const r = await recoverStubEntries({ userId: a.orgUserId, entries: req.body?.entries });
      if (r.badRequest) return res.status(400).json({ error: r.badRequest });
      return res.status(200).json(r);
    }

    // ---- auto-close forgotten clock-outs (Vercel cron; CRON_SECRET-gated) ----
    // An unset secret is a 500 with a body that names nothing, the gap logged
    // (`_lib/cronGate.js`; it was a 401, which monitoring reads as a wrong secret —
    // CS-215); a wrong or missing bearer is a 401.
    if (action === 'auto-close') {
      const secret = process.env.CRON_SECRET;
      if (!secret) return refuseUnconfiguredCron(res, 'time/auto-close');
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
      let grace = 120;
      try { const { state } = await readOrgState(); if (Number.isFinite(state?.opsSettings?.autoCloseGraceMins)) grace = state.opsSettings.autoCloseGraceMins; } catch { /* default */ }
      const r = await autoCloseStale({ graceMinutes: grace });
      // CS-051: a forgotten clock-out held its clean open; closing it may finish the clean.
      let jobsDone = 0;
      for (const jobId of r.jobIds || []) {
        if ((await settleJobAfterPunchClosed(jobId)).jobDone) jobsDone += 1;
      }
      return res.status(200).json({ ...r, jobsDone });
    }

    // ---- zero-punch watchdog (Vercel cron, daily; CRON_SECRET-gated) ----------
    // Sept 1 guarantee: cleans happened, zero clock-ins recorded → page the
    // office. Months of missing payroll data must never be silent again.
    // The same gate as auto-close: an unset secret is a 500 that names nothing (logged).
    if (action === 'watchdog') {
      const secret = process.env.CRON_SECRET;
      if (!secret) return refuseUnconfiguredCron(res, 'time/watchdog');
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
      const r = await punchWatchdog();
      if (r.silent) {
        reportError('time.zero_punches',
          new Error(`${r.jobs} cleans in the last ${r.windowHours}h and ZERO clock-ins recorded`), r);
        try {
          const { state } = await readOrgState();
          // Everyone still on the team who can open the report the push links to: the
          // owner/admin list as before, plus any variance.view holder under the committed
          // matrix + overrides (a manager, by default). A disabled member and a revoked
          // invite are off the team; the old filter left 'disabled' in, so an offboarded
          // admin's phone kept getting this page.
          const slices = authzSlicesOf(state);
          const office = (Array.isArray(state?.users) ? state.users : [])
            .filter((u) => u && typeof u.id === 'string' && u.status !== 'inactive' && u.status !== 'disabled'
              && (MANAGER.includes(u.role) || canCommitted(u, 'variance.view', slices)));
          // In each person's own language (CS-193, LANG-4).
          await Promise.allSettled(office.map((u) => sendToUser(u.id, {
            title: translate(userLanguage(u), 'alerts.watchdog.title'),
            body: translate(userLanguage(u), 'alerts.watchdog.body', { count: r.jobs, hours: r.windowHours }),
            url: '/variance',
            tag: 'time-watchdog',
          })));
        } catch (e) { console.error('[time/watchdog] office push failed:', e?.message || e); }
      }
      // 🔴 PAY-15 (Matt, 2026-09-29): "would like the unapproved payroll to be flagged so the
      // account manager can see it in case they missed approving someone's clock-in and
      // clock-out yesterday." A MORNING digest per manager, about THEIR OWN customers — an
      // org-wide count tells the person who has to act nothing. It rides this existing daily
      // cron rather than adding one, and it is best-effort: a failure here never fails the
      // watchdog's own answer.
      let unapproved = null;
      try {
        unapproved = await notifyUnapprovedYesterday();
      } catch (e) { console.error('[time/watchdog] unapproved digest failed:', e?.message || e); }
      return res.status(200).json({ ...r, unapproved });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/time]', e);
    return res.status(readErrorStatus(e)).json({ error: e?.message || 'Server error' });
  }
}
