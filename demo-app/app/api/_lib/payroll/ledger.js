// Payroll-ledger reads shared by the Approvals read (wave W1-B) and the pay run (wave
// W2-L): the closed pay runs, the closed/open territory boundaries, and WHAT CHANGED in
// closed territory since the latest close (the arrears-detection rule, spec §6.2).
//
// Every date helper is passed `tz` EXPLICITLY (spec §5.1 / DEV_PLAYBOOK 3.4.10): per-request
// org data never sets the module-level ambient zone on the server, where a Vercel function
// is TZ=UTC and shared across orgs.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { selectAll, exactCount } from '../pagedSelect.js';
import { payWeekKeyOf, payPeriodRange } from '../../../src/lib/payroll.js';
import { addDaysKey, startOfDayKey } from '../../../src/lib/dates.js';

const RUNS_TABLE = 'payroll_runs';
const ENTRIES_TABLE = 'time_entries';
const OT_TABLE = 'time_ot_approvals';

// The columns the Approvals read needs (bounds + the latest run's held OT). W2-L reads the
// full row (paid_weeks + file) by passing columns:'*'.
const RUN_COLUMNS = 'id, period_key, from_key, to_key, from_iso, to_iso, closed_at, held_ot';

// Every closed run, oldest first (periods are contiguous + non-overlapping, so period_key
// order gives first/latest). Runs are never deleted or edited, so one ordered read is
// complete; there are few of them.
export async function readRuns({ columns = RUN_COLUMNS } = {}, db = getSupabase()) {
  const { data, error } = await db.from(RUNS_TABLE)
    .select(columns)
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('period_key', { ascending: true });
  if (error) throw error;
  const runs = data || [];
  return { runs, firstRun: runs[0] || null, latestRun: runs[runs.length - 1] || null };
}

// Closed territory: the day-key + ISO span from the first run's start through the latest
// run's end. null before any run exists.
export function closedTerritory({ firstRun, latestRun } = {}) {
  if (!firstRun || !latestRun) return null;
  return { fromKey: firstRun.from_key, toKey: latestRun.to_key, fromIso: firstRun.from_iso, toIso: latestRun.to_iso };
}

// The start of open territory (spec §1 / §5.1): the day AFTER the latest run's window, or —
// before any run exists — the start of the PREVIOUS pay period in the org cadence, so the
// first open period always has a sane lower bound to gather punches from. Returns
// { fromKey, fromIso }.
export function openTerritoryStart({ latestRun, cadence = 'biweekly', tz, weekStartDay = 0, now = new Date() } = {}) {
  if (latestRun && latestRun.to_key) {
    const fromKey = addDaysKey(latestRun.to_key, 1);
    return { fromKey, fromIso: startOfDayKey(fromKey, tz).toISOString() };
  }
  const prev = payPeriodRange(cadence, -1, now, tz, weekStartDay);   // PAY-19: the org's workweek start
  return { fromKey: prev.fromKey, fromIso: prev.fromIso };
}

// Does a pay week (weekKey .. weekKey+6) intersect closed territory [fromKey, toKey]? Day
// keys are labels, so a lexical compare IS a chronological one.
export function weekMeetsClosedTerritory(weekKey, territory) {
  if (!territory) return false;
  const weekEnd = addDaysKey(weekKey, 6);
  return weekKey <= territory.toKey && weekEnd >= territory.fromKey;
}

// The (userId, weekKey) pairs whose pay is owed to be RECOMPUTED because something changed
// in closed territory after the latest close (spec §6.2). threshold = latest closed_at − 1 h
// (the overlap only guards clock skew; recomputing a week that did not really change yields
// a zero delta, so a false positive is safe, a miss is not). Two sources:
//   · punches whose clock-in is in closed territory and whose updated_at > threshold
//   · OT approvals whose updated_at > threshold and whose week meets closed territory
// Drive rulings can't change in closed territory (§6.1), so they need no detection.
export async function changedWeeksSinceLatestClose({ firstRun, latestRun, tz, weekStartDay = 0 } = {}, db = getSupabase()) {
  const set = new Set();
  const territory = closedTerritory({ firstRun, latestRun });
  if (!territory || !latestRun.closed_at) return set;
  const threshold = new Date(Date.parse(latestRun.closed_at) - 3600 * 1000).toISOString();

  // Punches changed in closed territory since the threshold — a bounded, complete read.
  const punchFilter = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID)
    .gte('clock_in_at', territory.fromIso).lte('clock_in_at', territory.toIso)
    .gt('updated_at', threshold);
  const punches = await selectAll({
    count: async () => {
      const { count, error } = await punchFilter(db.from(ENTRIES_TABLE).select('id', { count: 'exact', head: true }));
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await punchFilter(db.from(ENTRIES_TABLE).select('id, user_id, clock_in_at'))
        .order('clock_in_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
  for (const p of punches) if (p.user_id && p.clock_in_at) set.add(`${p.user_id}|${payWeekKeyOf(p.clock_in_at, weekStartDay, tz)}`);

  // OT approvals changed since the threshold whose week meets closed territory.
  const { data: otRows, error: otErr } = await db.from(OT_TABLE)
    .select('user_id, week_key').eq('organization_id', CLEANSPACE_ORG_ID).gt('updated_at', threshold);
  if (otErr) throw otErr;
  for (const r of otRows || []) if (r.user_id && r.week_key && weekMeetsClosedTerritory(r.week_key, territory)) set.add(`${r.user_id}|${r.week_key}`);

  return set;
}
