// The server pay-run compute (wave W2-L §5.2): gather the inputs a pay run needs and price
// them with the SHARED pure computePayRun (src/lib/payRun.js) — the SAME module the demo stub
// runs, so a server preview / close and a demo can never diverge.
//
// Every date helper is passed `tz` EXPLICITLY (spec §5.1 / DEV_PLAYBOOK 3.4.10): a Vercel
// function is TZ=UTC and shared across orgs, so per-request org data never sets an ambient
// zone. The committed blob is read ONCE per request by the CALLER (the route, inside
// withRequestCache) and passed in as `state`; runDriveReport re-reads it through the request
// cache, so the whole request pays one full blob read (spec §5.2).
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { getSupabase } from '../supabase.js';
import { readRuns, changedWeeksSinceLatestClose } from './ledger.js';
import { listForReportAll, LEDGER_ENTRY_COLUMNS } from '../time/store.js';
import { readOtApprovalsForUsers } from '../time/otApprovals.js';
import { runDriveReport } from '../time/driveCompute.js';
import { entryFromRow } from '../../../src/lib/otLedger.js';
import { computePayRun } from '../../../src/lib/payRun.js';
import { drivePayEnabled } from '../../../src/lib/driveTime.js';
import { payPeriodRange, payWeekKeyOf, payDateConfigOf, payWeekStartDayOf } from '../../../src/lib/payroll.js';
import { DEFAULT_ORG_TIMEZONE, startOfDayKey, addDaysKey } from '../../../src/lib/dates.js';

const ENTRIES_TABLE = 'time_entries';
const OT_TABLE = 'time_ot_approvals';

// Org zone / cadence / week-start / OT multiplier / paid-drive from the committed blob
// (default-safe). `payDriveTime` is read through lib/driveTime's ONE reader (PAY-6).
export function payConfigOf(state) {
  return {
    tz: state?.company?.timezone || DEFAULT_ORG_TIMEZONE,
    cadence: state?.opsSettings?.payPeriodCadence || 'biweekly',
    // PAY-19: the workweek start through lib/payroll's ONE reader — the same answer the approvals
    // read and overtime approval get (CS-659), so the run and the units it pays share one week.
    weekStartDay: payWeekStartDayOf(state?.opsSettings),
    otMultiplier: Number.isFinite(state?.opsSettings?.otMultiplier) ? state.opsSettings.otMultiplier : 1.5,
    pendingPolicy: state?.opsSettings?.payrollPendingPolicy === 'block' ? 'block' : 'rollForward',
    payDriveTime: drivePayEnabled(state?.opsSettings || {}),
    // PAY-2: the payday schedule, through lib/payroll's ONE reader of those field names.
    payDate: payDateConfigOf(state?.opsSettings),
  };
}

// Gather + price ONE period (open). Reads the closed runs, detects the weeks that changed in
// closed territory since the latest close (arrears, spec §6.2), then reads every punch + paid
// drive leg + OT approval over the window [earliest arrears week .. the period's whole
// pay-weeks], maps them to the neutral ledger shapes, and prices with computePayRun.
// Returns the computePayRun result plus the context a close needs (the window + week keys for
// the stale check, the runs, and asOf).
export async function computeRunForPeriod({ period, state, now = new Date() }, db = getSupabase()) {
  const { tz, cadence, weekStartDay, otMultiplier, payDriveTime, payDate } = payConfigOf(state);
  const users = Array.isArray(state?.users) ? state.users : [];
  const lines = Array.isArray(state?.payrollLines) ? state.payrollLines : [];
  const clients = Array.isArray(state?.clients) ? state.clients : [];
  const clientsById = new Map(clients.map((c) => [c.id, c]));

  const { runs, firstRun, latestRun } = await readRuns({ columns: '*' }, db);
  const arrearsWeeks = await changedWeeksSinceLatestClose({ firstRun, latestRun, tz, weekStartDay }, db);

  // The read window: the period's whole overlapping pay-weeks, extended BACK to the earliest
  // arrears week so the 40h walk can recompute those (closed-territory) weeks. Drive rulings
  // can't change in closed territory (§6.1), but a manual add / void there still reshapes the
  // week's OT split, so the week's punches AND legs must be re-read.
  const firstWeek = payWeekKeyOf(period.fromKey, weekStartDay, tz);
  let earliestWeek = firstWeek;
  for (const uw of arrearsWeeks) { const w = uw.slice(uw.indexOf('|') + 1); if (w < earliestWeek) earliestWeek = w; }
  const lastWeek = payWeekKeyOf(period.toKey, weekStartDay, tz);
  const gatherFromIso = startOfDayKey(earliestWeek, tz).toISOString();
  const gatherToIso = new Date(startOfDayKey(addDaysKey(lastWeek, 7), tz).getTime() - 1).toISOString();

  const rows = await listForReportAll({ fromIso: gatherFromIso, toIso: gatherToIso }, { columns: LEDGER_ENTRY_COLUMNS }, db);
  const entries = rows.map(entryFromRow);

  // Paid drive over the same window (compact + complete; no Google estimate). A failed drive
  // read THROWS (the route answers non-2xx) — the run must never be priced with drive missing.
  // PAY-6: with drive pay OFF the read is not made at all — computePayRun would drop every leg
  // anyway, so this is a whole window of punch pairing the run no longer pays for. The pricer
  // stays the boundary; this is only the saving.
  let driveSegments = [];
  if (payDriveTime) {
    const drive = await runDriveReport({ fromIso: gatherFromIso, toIso: gatherToIso, payroll: true });
    driveSegments = Array.isArray(drive?.rows) ? drive.rows : [];
  }

  // Every week key in the span, and every user who worked in it, for the OT-approval read.
  const weekKeys = [];
  for (let w = earliestWeek, i = 0; w <= lastWeek && i < 520; w = addDaysKey(w, 7), i += 1) weekKeys.push(w);
  const userIds = [...new Set([...rows.map((r) => r.user_id), ...driveSegments.map((s) => s.userId)].filter(Boolean))];
  const otApprovals = await readOtApprovalsForUsers(userIds, weekKeys, db);

  const run = computePayRun({ period, tz, weekStartDay, entries, driveSegments, otApprovals, runs, arrearsWeeks, users, lines, otMultiplier, payDriveTime, payDate, clientsById });
  return { run, asOf: now.toISOString(), runs, firstRun, latestRun, tz, cadence, weekStartDay, gatherFromIso, gatherToIso, weekKeys, period };
}

// The next period that MAY be closed (spec §5.2): the day after the latest run's window, or —
// before any run exists — the most recent period that has ended (the one just before the
// current open period). Everything before that is pre-ledger.
export function nextClosablePeriodKey({ latestRun, cadence, tz, weekStartDay = 0, now = new Date() }) {
  if (latestRun && latestRun.to_key) return addDaysKey(latestRun.to_key, 1);
  return payPeriodRange(cadence, -1, now, tz, weekStartDay).fromKey;
}

// The asOf stale guard (spec §5.2): did any punch (by clock-in in the window) or any OT
// approval (by week) change AFTER `asOf`? A truthy answer means the preview the caller
// confirmed is out of date → the route answers 409 stale and the page re-previews.
export async function changedSinceAsOf({ fromIso, toIso, weekKeys, asOf }, db = getSupabase()) {
  const punch = await db.from(ENTRIES_TABLE).select('id')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .gte('clock_in_at', fromIso).lte('clock_in_at', toIso).gt('updated_at', asOf).limit(1);
  if (punch.error) throw punch.error;
  if ((punch.data || []).length) return true;
  if (!Array.isArray(weekKeys) || !weekKeys.length) return false;
  const ot = await db.from(OT_TABLE).select('id')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .in('week_key', weekKeys).gt('updated_at', asOf).limit(1);
  if (ot.error) throw ot.error;
  return (ot.data || []).length > 0;
}
