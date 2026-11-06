// Payroll period-lock helpers (wave W3-P §8.5) — PURE, node-safe, `.js` on every import.
// A closed pay period is INSERT-only and read-only (spec §6.1): its pay lines can't be added
// or removed, and any surface that lets someone pick a pay period (HR › Special services and
// Reimbursements) must offer only OPEN periods. These helpers encode "which period is open"
// so the drawer, the HR pickers and the payroll page all agree with the server's runs.
//
// A `run` here is a payroll_runs row (or the demo stub's shape); only `period_key` and
// `to_key` are read. Day keys are labels, so a lexical compare IS a chronological one
// (matches lib/payroll + api/_lib/payroll/ledger). The org cadence/zone come from the caller.
import { payPeriodRange } from '../../lib/payroll.js';
import { addDaysKey } from '../../lib/dates.js';

// The most recently closed run (highest period_key), or null before any run exists.
export function latestClosedRun(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.period_key);
  if (!list.length) return null;
  return list.reduce((a, b) => (String(b.period_key).localeCompare(String(a.period_key)) > 0 ? b : a));
}

// Is this pay period (by its fromKey = period_key) already closed?  The predicate the
// drawer's closed-period lock and the HR pickers read.
export function isPeriodClosed(runs, periodKey) {
  return (Array.isArray(runs) ? runs : []).some((r) => r && r.period_key === periodKey);
}

// The first OPEN pay period: the day after the latest closed run's window, or — before any
// run exists — the current period (spec §8.5; everything before it is pre-ledger, never
// paid by a run). Returns a day-key (= a period fromKey), NOT a full period.
export function firstOpenPeriodKey(runs, cadence, { now = new Date(), tz, weekStartDay = 0 } = {}) {
  const latest = latestClosedRun(runs);
  if (latest && latest.to_key) return addDaysKey(latest.to_key, 1);
  return payPeriodRange(cadence, 0, now, tz, weekStartDay).fromKey;
}

// The OPEN pay periods a picker may offer, newest first: from `ahead` future periods down to
// the first open period. Periods before the first open one (closed or pre-ledger) are never
// offered — a reimbursement / special service there would drop from the run (spec §8.5).
export function openPeriods(runs, cadence, { now = new Date(), tz, weekStartDay = 0, ahead = 0, max = 8 } = {}) {
  const firstOpen = firstOpenPeriodKey(runs, cadence, { now, tz, weekStartDay });
  const out = [];
  // Offsets descend → fromKeys descend, so once one falls before firstOpen every later one
  // does too. A wide floor guards a long-un-closed stretch; `max` bounds the list.
  for (let o = ahead; o >= ahead - (max + 60) && out.length < max; o -= 1) {
    const p = payPeriodRange(cadence, o, now, tz, weekStartDay);
    if (p.fromKey < firstOpen) break;
    out.push(p);
  }
  // The current-or-first-open period is always offerable; never hand back an empty list.
  if (!out.length) out.push(payPeriodRange(cadence, 0, now, tz, weekStartDay));
  return out;
}

// The default period a picker should preselect: the current period when it is open, else the
// first open period. (The current period is always on/after the first open period.)
export function defaultOpenPeriodKey(runs, cadence, { now = new Date(), tz, weekStartDay = 0 } = {}) {
  const firstOpen = firstOpenPeriodKey(runs, cadence, { now, tz, weekStartDay });
  const curKey = payPeriodRange(cadence, 0, now, tz, weekStartDay).fromKey;
  return curKey >= firstOpen ? curKey : firstOpen;
}

// Where a pay line should actually land: the chosen period if still open, else the first open
// period. Approving a reimbursement whose chosen period closed in the meantime pays it in the
// first open period (spec §8.5) — the line's periodKey moves, and the reimbursement is stamped
// with where it was paid.
export function retargetToOpenPeriodKey(chosenKey, runs, cadence, { now = new Date(), tz, weekStartDay = 0 } = {}) {
  if (!isPeriodClosed(runs, chosenKey)) return chosenKey;
  return firstOpenPeriodKey(runs, cadence, { now, tz, weekStartDay });
}

// Whether a pay line (e.g. an HR › Special service) may be REMOVED from a surface: only while
// its period is still OPEN. Removing a line whose periodKey is a closed run's period is refused
// by the server (orgStateGuard: "change pay in a closed payroll period"), and a refused org-state
// save drops the whole pending batch — so the HR tabs must not offer Remove there (spec §8.5;
// mirrored by PayrollLineDrawer's `periodClosed` lock). W4-F finding 2.
export function payLineRemovable(runs, periodKey) {
  return !isPeriodClosed(runs, periodKey);
}

// Whether a reimbursement row may be REMOVED. Pending / rejected ones carry no pay line, so they
// are always removable; an APPROVED reimbursement's Remove ALSO deletes its pay line
// (reducer removeReimbursement), so it is locked exactly when that line's period (= the
// reimbursement's periodKey, stamped on approve) is closed. W4-F finding 2.
export function reimbursementRemovable(runs, reimbursement) {
  if (!reimbursement || reimbursement.status !== 'approved') return true;
  return !isPeriodClosed(runs, reimbursement.periodKey);
}

// The pay-run CSV file name. A DRAFT (an open period's preview) ends `-DRAFT` so it is never
// mistaken for the final file the payroll specialist pulls once the period is closed.
// PAY-2: it also carries the PAYDAY (`-pay-YYYY-MM-DD`) when there is one, because the specialist
// files by the date the money goes out, not by the period it covers — and the Paychex CSV's own
// columns are deliberately untouched until Matt sends the sample file (PAY-1).
export function csvFileName(period, { draft = false, payDateKey = null } = {}) {
  const pay = payDateKey ? `-pay-${payDateKey}` : '';
  const base = `payroll-${period.fromKey}_to_${period.toKey}${pay}`;
  return draft ? `${base}-DRAFT.csv` : `${base}.csv`;
}
