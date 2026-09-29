// Crew clock-in/out + manager corrections + the labor projections. Writes the
// time_entries ledger. Every route re-checks authority server-side — the open
// org_state RLS means UI permission gating is NOT a boundary (§2.4).
//
//   POST /api/time/clock-in   { jobId, lat, lng, accuracyM, override?, overrideReason? }
//                               -> assigned crew (or the punch bypass); SERVER geofence
//   POST /api/time/clock-out  { entryId, lat?, lng? }   -> the entry's owner or the punch bypass
//                               409 checklist_incomplete { done, total } when the ENTRY
//                               OWNER's own checklist for that clean isn't finished (R4)
//   POST /api/time/replay     { clientPunchId, jobId | entryId, ... } -> as clock-in / clock-out
//   POST /api/time/correct    { entryId, patch, reason } -> time.edit.all
//   POST /api/time/manual     { jobId, userId, clockInAt, clockOutAt?, note?, reason? } -> time.edit.all
//   POST /api/time/approve    { entryId, approval }      -> time.approve
//   POST /api/time/job-cancelled { jobId }               -> schedule.edit
//   GET  /api/time/mine       [?sinceIso]                -> the caller's own entries
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
//                                 your next site" hint); coords resolved server-side
//   POST /api/time/drive-override { fromEntryId, toEntryId, ... , reason } -> time.edit.all
// Every key is read from the committed matrix + per-user overrides (authz.js).
//
// Note: clock-out has NO geofence gate (per requirements). All timestamps are
// server-stamped in the store; the client clock is never trusted.
import { requirePermission, requireAuthority, permissionChecker, authzSlicesOf, canCommitted } from '../_lib/authz.js';
import {
  clockIn, clockOut, correctEntry, manualEntry, approveEntry, cancelJobLabor,
  listMine, listOpen, listForRollup, listForReport, autoCloseStale, replayPunch, punchWatchdog,
  recoverStubEntries, countForRollup, pageForRollup, countForReport, pageForReport,
  coveredJobIdsInWindow, ATTENDANCE_COLUMNS,
} from '../_lib/time/store.js';
import {
  CHECKLIST_INCOMPLETE_CODE, CHECKLIST_INCOMPLETE_ERROR,
  CHECKLIST_CHECK_FAILED_CODE, CHECKLIST_CHECK_FAILED_ERROR,
} from '../_lib/time/checklistGate.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { isoParam, idList, intParam } from '../_lib/queryParams.js';
import { reportError } from '../_lib/monitor.js';
import { sendToUser } from '../_lib/push/store.js';
import { runDriveReport, siteMapFrom, PAYROLL_MAX_DAYS } from '../_lib/time/driveCompute.js';
import { resolveOneEstimate } from '../_lib/time/driveEstimates.js';
import { upsertOverride, clearOverride } from '../_lib/time/driveOverrides.js';
import { readOrgState } from '../_lib/orgState.js';

const MANAGER = ['owner', 'admin'];

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
        override: !!body.override, overrideReason: body.overrideReason,
        clientPunchId: body.clientPunchId || null, // shared idempotency key vs a buffered replay
      });
      if (r.notFound) return res.status(404).json({ error: 'Job not found' });
      if (r.forbidden) return res.status(403).json({ error: 'You are not assigned to this clean' });
      if (r.duplicate) return res.status(409).json({ error: "You're already clocked in to this clean" });
      if (r.blocked) {
        return res.status(403).json({
          error: 'Outside the geofence — you must be at the site to clock in',
          geofence: { result: r.verdict.result, distanceM: r.verdict.distanceM, allowedM: r.verdict.allowedM },
        });
      }
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
        outLat: body.outLat, outLng: body.outLng,
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
      return res.status(200).json({
        entry: r.entry, idempotent: !!r.idempotent,
        outsideWindow: !!r.outsideWindow, alreadyOut: !!r.alreadyOut,
      });
    }

    // ---- clock-out (no geofence) ----
    if (action === 'clock-out' && req.method === 'POST') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(403).json({ error: 'Your login is not linked to a crew member' });
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      const r = await clockOut({
        entryId: body.entryId, userId: a.orgUserId, isManager: punchBypass(a),
        deviceLat: body.lat, deviceLng: body.lng,
      });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
      if (r.forbidden) return res.status(403).json({ error: 'Not your time entry' });
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
      return res.status(200).json({ entry: r.entry, alreadyOut: !!r.alreadyOut });
    }

    // ---- manager: correct an entry ----
    if (action === 'correct' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      const r = await correctEntry({ entryId: body.entryId, patch: body.patch || {}, reason: body.reason, byUserId: g.orgUserId });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
      return res.status(200).json({ entry: r.entry });
    }

    // ---- manager: manual entry ----
    if (action === 'manual' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
      if (!body.userId || !body.clockInAt) return res.status(400).json({ error: 'userId and clockInAt are required' });
      const r = await manualEntry({
        jobId: body.jobId || null, userId: body.userId,
        clockInAt: body.clockInAt, clockOutAt: body.clockOutAt || null,
        note: body.note, reason: body.reason, byUserId: g.orgUserId,
      });
      return res.status(200).json({ entry: r.entry });
    }

    // ---- manager: approve / reject ----
    if (action === 'approve' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.approve');
      if (!g) return;
      if (!body.entryId) return res.status(400).json({ error: 'entryId is required' });
      const r = await approveEntry({ entryId: body.entryId, approval: body.approval, byUserId: g.orgUserId });
      if (r.notFound) return res.status(404).json({ error: 'Time entry not found' });
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
      const est = await resolveOneEstimate(String(fromSiteId), String(toSiteId), siteMapFrom(state));
      return res.status(200).json({ estimate: est });   // null = not routable / no key (fail-soft)
    }

    // ---- manager: adjust or exclude the paid minutes on ONE drive leg ----
    // Recorded travel is compensable, so nothing is docked automatically — this is
    // the only path that changes what a leg pays, and it always carries a reason.
    if (action === 'drive-override' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'time.edit.all');
      if (!g) return;
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
    if (action === 'auto-close') {
      const secret = process.env.CRON_SECRET;
      const auth = req.headers.authorization || '';
      if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
      let grace = 120;
      try { const { state } = await readOrgState(); if (Number.isFinite(state?.opsSettings?.autoCloseGraceMins)) grace = state.opsSettings.autoCloseGraceMins; } catch { /* default */ }
      return res.status(200).json(await autoCloseStale({ graceMinutes: grace }));
    }

    // ---- zero-punch watchdog (Vercel cron, daily; CRON_SECRET-gated) ----------
    // Sept 1 guarantee: cleans happened, zero clock-ins recorded → page the
    // office. Months of missing payroll data must never be silent again.
    if (action === 'watchdog') {
      const secret = process.env.CRON_SECRET;
      const auth = req.headers.authorization || '';
      if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
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
          await Promise.allSettled(office.map((u) => sendToUser(u.id, {
            title: 'No clock-ins recorded',
            body: `${r.jobs} cleans in the last ${r.windowHours}h and zero clock-ins. The time clock may be broken, or crew phones are on an old app version.`,
            url: '/variance',
            tag: 'time-watchdog',
          })));
        } catch (e) { console.error('[time/watchdog] office push failed:', e?.message || e); }
      }
      return res.status(200).json(r);
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/time]', e);
    return res.status(readErrorStatus(e)).json({ error: e?.message || 'Server error' });
  }
}
