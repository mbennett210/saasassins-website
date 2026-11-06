// My Hours — a cleaner's own time in a pay period, VIEW ONLY (Matt's Cleaner Hub, "My Hours";
// plan docs/plans/2026-10-13-cleaner-hub.md, brief C §3). ONE rule, PURE and node-safe, read by the
// server (api/time my-hours, EP-381) and by the demo stub (lib/timeApi myHours), so the phone and
// the demo can never count a day differently.
//
// WHY THE SERVER WORKS OUT THE PERIOD. A cleaner's view of the shared record has no pay cadence:
// the crew projection strips the pay-run fields (api/_lib/crewView.js OPS_PAYRUN_FIELDS — the
// cadence and the workweek start among them). So the period is computed where the full
// `opsSettings` is read, by the payroll's own calendar (lib/payroll payPeriodRange, in the ORG's
// zone, on the org's workweek start), never by a second reading of it here.
//
// THE RULE
//   period    payPeriodRange(cadence, -offset, now, tz, weekStartDay): `offset` 0 = this period,
//             1 = the one before … at most MY_HOURS_MAX_OFFSET back, never forward (no future).
//   a punch   counts on the org-zone DAY its clock-in falls on, inside the period. A VOIDED punch
//             (Delete), a no-show and a legacy rejected one never count — none of them pays.
//   minutes   a closed punch: its `duration_minutes` (the server's own figure), else clock-out −
//             clock-in; an OPEN punch: the time elapsed so far ("in progress").
//   a day     In progress while it holds an open punch; else Approved when EVERY punch that day is
//             approved; else Pending (some time is still waiting for the account manager).
//   totals    total = every counted minute (elapsed time included, "so far"); approved = the
//             approved punches'; pending = the closed punches still waiting; in progress = the
//             open punches' elapsed time. approvedDays = the days that read Approved.
import { payPeriodRange, payWeekStartDayOf } from './payroll.js';
import { dayKey, startOfDayKey, DEFAULT_ORG_TIMEZONE } from './dates.js';

// How far back the cleaner can page: a year of biweekly periods.
export const MY_HOURS_MAX_OFFSET = 26;
export const MY_HOURS_STATUS = Object.freeze({ approved: 'approved', pending: 'pending', inProgress: 'inProgress' });
// The cadences the payroll knows; anything else (unset, a typo) is the payroll's own default.
export const PAY_CADENCES = Object.freeze(['weekly', 'biweekly', 'semimonthly']);
const DEFAULT_CADENCE = 'biweekly';
// A punch that never pays.
const NOT_COUNTED_STATUSES = new Set(['voided', 'no_show']);

// The org's pay cadence, read the way the pay run reads it (lib/payrollApi, api/time approvals).
export function payCadenceOf(opsSettings) {
  const c = opsSettings?.payPeriodCadence;
  return PAY_CADENCES.includes(c) ? c : DEFAULT_CADENCE;
}

// `offset` from a query string or a screen: a whole number 0..MY_HOURS_MAX_OFFSET (no future).
export function myHoursOffset(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MY_HOURS_MAX_OFFSET);
}

const msOf = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };

// Does this punch count at all?
export function countsForHours(e) {
  if (!e || !e.clock_in_at || msOf(e.clock_in_at) == null) return false;
  if (NOT_COUNTED_STATUSES.has(e.status)) return false;
  if (e.approval_status === 'rejected') return false;
  return true;
}

// A punch's minutes: closed = its own duration (else out − in), open = elapsed until `nowMs`.
export function punchMinutes(e, nowMs) {
  const inMs = msOf(e?.clock_in_at);
  if (inMs == null) return 0;
  if (!e.clock_out_at) return Math.max(0, Math.floor((nowMs - inMs) / 60000));
  const d = Number(e.duration_minutes);
  if (e.duration_minutes != null && Number.isFinite(d)) return Math.max(0, Math.round(d));
  const outMs = msOf(e.clock_out_at);
  return outMs == null ? 0 : Math.max(0, Math.round((outMs - inMs) / 60000));
}

// Hours to one decimal, from minutes ("7.5", "8.0" on a screen). One rounding, every screen.
export function hoursOneDecimal(minutes) {
  return Math.round((Number(minutes) || 0) / 6) / 10;
}

// The answer for one period. `entries` are raw punch rows (the server's `time_entries` columns,
// which the demo stub stores too); `now` an instant or ms; `tz` the org's zone.
export function myHoursPeriod({ entries = [], opsSettings = {}, now = Date.now(), offset = 0, tz } = {}) {
  const zone = tz || DEFAULT_ORG_TIMEZONE;
  const nowMs = typeof now === 'number' ? now : (msOf(now) ?? Date.now());
  const back = myHoursOffset(offset);
  const cadence = payCadenceOf(opsSettings);
  const weekStartDay = payWeekStartDayOf(opsSettings);
  const p = payPeriodRange(cadence, -back, new Date(nowMs), zone, weekStartDay);
  const fromMs = Date.parse(p.fromIso);
  const toMs = Date.parse(p.toIso);
  const today = dayKey(new Date(nowMs), zone);

  const byDay = new Map();
  let approvedMinutes = 0;
  let pendingMinutes = 0;
  let inProgressMinutes = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!countsForHours(e)) continue;
    const inMs = msOf(e.clock_in_at);
    if (inMs < fromMs || inMs > toMs) continue;
    const key = dayKey(e.clock_in_at, zone);
    const mins = punchMinutes(e, nowMs);
    let day = byDay.get(key);
    if (!day) {
      day = { dayKey: key, dayIso: startOfDayKey(key, zone).toISOString(), minutes: 0, open: false, allApproved: true, openSince: null, isToday: key === today };
      byDay.set(key, day);
    }
    day.minutes += mins;
    if (!e.clock_out_at) {
      day.open = true;
      inProgressMinutes += mins;
      if (!day.openSince || inMs < Date.parse(day.openSince)) day.openSince = new Date(inMs).toISOString();
    } else if (e.approval_status === 'approved') {
      approvedMinutes += mins;
    } else {
      pendingMinutes += mins;
    }
    if (!e.clock_out_at || e.approval_status !== 'approved') day.allApproved = false;
  }

  const days = [...byDay.values()]
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0))
    .map((d) => ({
      dayKey: d.dayKey,
      dayIso: d.dayIso,
      minutes: d.minutes,
      status: d.open ? MY_HOURS_STATUS.inProgress : (d.allApproved ? MY_HOURS_STATUS.approved : MY_HOURS_STATUS.pending),
      openSince: d.openSince,
      isToday: d.isToday,
    }));
  return {
    cadence,
    offset: back,
    from: p.fromKey,
    to: p.toKey,
    fromIso: p.fromIso,
    toIso: p.toIso,
    days,
    totalMinutes: approvedMinutes + pendingMinutes + inProgressMinutes,
    approvedMinutes,
    pendingMinutes,
    inProgressMinutes,
    approvedDays: days.filter((d) => d.status === MY_HOURS_STATUS.approved).length,
    inProgress: days.some((d) => d.status === MY_HOURS_STATUS.inProgress),
    hasNewer: back > 0,
    hasOlder: back < MY_HOURS_MAX_OFFSET,
  };
}

// The window a server reads the punches in for one period (the same calendar the rule uses), so
// the read and the answer cannot disagree about where a period starts.
export function myHoursWindow({ opsSettings = {}, now = Date.now(), offset = 0, tz } = {}) {
  const zone = tz || DEFAULT_ORG_TIMEZONE;
  const nowMs = typeof now === 'number' ? now : (msOf(now) ?? Date.now());
  const p = payPeriodRange(payCadenceOf(opsSettings), -myHoursOffset(offset), new Date(nowMs), zone, payWeekStartDayOf(opsSettings));
  return { fromIso: p.fromIso, toIso: p.toIso };
}
