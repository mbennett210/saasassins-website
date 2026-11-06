// The payroll domain (wave W2-L §5.2): the pay-run preview, the closed runs, and closing a
// period. Money is the sensitive core, so every branch authenticates first, gates by
// CAPABILITY (payroll.view to look, payroll.edit to close/export), reads the committed blob
// ONCE per request (withRequestCache; runDriveReport reuses it), passes `tz` explicitly, and
// sends Cache-Control: private, no-store. RLS on payroll_runs is closed (service role only),
// so these route checks ARE the authorization boundary (BUILD_INTEGRITY §1.4).
//
//   GET  /api/payroll/runs                 -> payroll.view : closed runs (no file/paid_weeks)
//   GET  /api/payroll/run?periodKey=       -> payroll.edit : one run, full (the CSV source)
//   GET  /api/payroll/preview?offset=      -> payroll.view : the period at offset — closed
//                                            meta+file, or the priced open run + closable/blockers
//   POST /api/payroll/close { periodKey, asOf } -> payroll.edit : close the period (ONE insert)
import { requirePermission, requireAuthority, holdsPermission } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readOrgState } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { intParam } from '../_lib/queryParams.js';
import { listRuns, getRun, insertRun } from '../_lib/payroll/store.js';
import { readRuns } from '../_lib/payroll/ledger.js';
import { computeRunForPeriod, changedSinceAsOf, nextClosablePeriodKey, payConfigOf } from '../_lib/payroll/compute.js';
import { payPeriodRange } from '../../src/lib/payroll.js';

// The complete reads page tens of thousands of rows at full volume; a wide arrears window can
// too, so the run needs more than the default timeout.
export const config = { maxDuration: 60 };

const MSG = {
  'invalid-period': 'That is not the start of a pay period.',
  'not-ended': 'That pay period has not ended yet.',
  'period-order': 'Close the earliest open pay period first.',
  'period-closed': 'That pay period is already closed.',
  stale: 'Payroll changed since you loaded it. Reload and try again.',
  'pending-blocks-close': "Some hours still need a manager's approval, and this org is set not to close until everything is approved.",
};
const noStore = (res) => { res.setHeader('Cache-Control', 'private, no-store'); return res; };
const refuse = (res, status, code, extra = {}) => noStore(res).status(status).json({ error: MSG[code] || 'Refused', code, ...extra });

function subpathOf(req) {
  if (typeof req.query.subpath === 'string' && req.query.subpath) return req.query.subpath.split('/').filter(Boolean);
  if (Array.isArray(req.query.path)) return req.query.path;
  return req.query.path ? String(req.query.path).split('/').filter(Boolean) : [];
}

// The previous closed run's per-person gross (for the preview's period-over-period compare).
const prevGrossOf = (latestRun) => (latestRun
  ? { periodKey: latestRun.period_key, label: latestRun.file?.label || null, rows: (latestRun.file?.rows || []).map((r) => ({ userName: r.userName, gross: r.gross })) }
  : null);

export default async function handler(req, res) {
  return withRequestCache(() => route(req, res));
}

async function route(req, res) {
  const [action] = subpathOf(req);
  const body = req.body || {};
  try {
    // ---- the closed runs, METADATA ONLY (payroll.view OR time.config) ----
    // listRuns() projects META_COLUMNS — no file / paid_weeks / held_ot / money — so this list is
    // safe to hand to anyone who configures pay periods: Operations reads it to freeze the cadence
    // once a run exists, and a default Admin holds time.config but NOT payroll.view (W4-F finding
    // 1), so gating on payroll.view alone made that lock fail open. Authenticate first, as every
    // branch does; the money-bearing single run stays payroll.edit (GET /payroll/run below).
    if (action === 'runs' && req.method === 'GET') {
      const a = await requireAuthority(req, res); if (!a) return;
      const mayList = (await holdsPermission(a, 'payroll.view')) || (await holdsPermission(a, 'time.config'));
      if (!mayList) return noStore(res).status(403).json({ error: 'Insufficient permissions' });
      return noStore(res).status(200).json({ runs: await listRuns() });
    }

    // ---- one closed run, full — the CSV source (payroll.edit) ----
    if (action === 'run' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'payroll.edit'); if (!g) return;
      const periodKey = typeof req.query.periodKey === 'string' ? req.query.periodKey : null;
      if (!periodKey) return noStore(res).status(400).json({ error: 'periodKey is required' });
      const run = await getRun(periodKey);
      if (!run) return noStore(res).status(404).json({ error: 'No closed run for that period', code: 'not-found' });
      return noStore(res).status(200).json({ run });
    }

    // ---- the pay-run PREVIEW at an offset (payroll.view) ----
    if (action === 'preview' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'payroll.view'); if (!g) return;
      const offset = intParam(req.query.offset, 0, -520, 520);
      const now = new Date();
      const { state } = await readOrgState();
      const { tz, cadence, weekStartDay, pendingPolicy } = payConfigOf(state);
      // PAY-19: the pay-period calendar follows the ORG's workweeek start, not a hardcoded Sunday.
      const period = payPeriodRange(cadence, offset, now, tz, weekStartDay);

      const closed = await getRun(period.fromKey);
      if (closed) return noStore(res).status(200).json({ period, closed });

      const ctx = await computeRunForPeriod({ period, state, now });
      const expectedKey = nextClosablePeriodKey({ latestRun: ctx.latestRun, cadence, tz, weekStartDay, now });
      const ended = Date.parse(period.toIso) < now.getTime();
      const inOrder = period.fromKey === expectedKey;
      const rf = ctx.run.rolledForward;
      const blocks = pendingPolicy === 'block' && (rf.pendingCount > 0 || rf.openCount > 0 || rf.otHeldMinutes > 0);
      const closeBlockers = [];
      if (!ended) closeBlockers.push('not-ended');
      if (!inOrder) closeBlockers.push({ code: 'period-order', expected: expectedKey });
      if (blocks) closeBlockers.push({ code: 'pending-blocks-close', counts: rf });
      return noStore(res).status(200).json({
        ...ctx.run, closable: closeBlockers.length === 0, closeBlockers, asOf: ctx.asOf, prev: prevGrossOf(ctx.latestRun),
      });
    }

    // ---- CLOSE a period (payroll.edit) — one atomic insert of the run ----
    if (action === 'close' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'payroll.edit'); if (!g) return;
      const closedAt = new Date();                       // taken BEFORE any read (spec §6.3)
      const periodKey = typeof body.periodKey === 'string' ? body.periodKey : null;
      const asOf = typeof body.asOf === 'string' ? body.asOf : null;
      if (!periodKey) return noStore(res).status(400).json({ error: 'periodKey is required' });

      const { state } = await readOrgState();
      const { tz, cadence, weekStartDay, pendingPolicy } = payConfigOf(state);
      const period = payPeriodRange(cadence, 0, periodKey, tz, weekStartDay);
      if (period.fromKey !== periodKey) return refuse(res, 400, 'invalid-period');

      const { runs, latestRun } = await readRuns({ columns: '*' });
      if (Date.parse(period.toIso) >= closedAt.getTime()) return refuse(res, 409, 'not-ended');
      if (runs.some((r) => r.period_key === periodKey)) return refuse(res, 409, 'period-closed');
      const expectedKey = nextClosablePeriodKey({ latestRun, cadence, tz, weekStartDay, now: closedAt });
      if (periodKey !== expectedKey) return refuse(res, 409, 'period-order', { expected: expectedKey });

      const ctx = await computeRunForPeriod({ period, state, now: closedAt });
      // Nothing may have changed since the preview the caller confirmed (spec §5.2).
      if (asOf && await changedSinceAsOf({ fromIso: ctx.gatherFromIso, toIso: ctx.gatherToIso, weekKeys: ctx.weekKeys, asOf })) {
        return refuse(res, 409, 'stale');
      }
      const rf = ctx.run.rolledForward;
      if (pendingPolicy === 'block' && (rf.pendingCount > 0 || rf.openCount > 0 || rf.otHeldMinutes > 0)) {
        return refuse(res, 409, 'pending-blocks-close', { counts: rf });
      }
      const closedByName = (state?.users || []).find((u) => u.id === g.orgUserId)?.name || g.email || null;
      const ins = await insertRun({
        period_key: period.fromKey, cadence, from_key: period.fromKey, to_key: period.toKey,
        from_iso: period.fromIso, to_iso: period.toIso, status: 'closed',
        closed_at: closedAt.toISOString(), closed_by: g.orgUserId, closed_by_name: closedByName,
        pending_policy: pendingPolicy, rolled_forward: rf,
        paid_weeks: ctx.run.paidWeeksOut, held_ot: ctx.run.heldOtOut, file: ctx.run.file,
      });
      if (ins.conflict) return refuse(res, 409, 'period-closed');   // concurrent double-close (23505)
      return noStore(res).status(200).json({ run: ins.run });
    }

    // Unknown subpath: authenticate first, THEN 404 (spec §5.1 / 3.4.3 — 401 before 404).
    const a = await requireAuthority(req, res); if (!a) return;
    return noStore(res).status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/payroll]', e?.code || 'error');            // no bodies / tokens / PII
    return noStore(res).status(readErrorStatus(e)).json({ error: 'Could not load payroll. Try again.' });
  }
}
