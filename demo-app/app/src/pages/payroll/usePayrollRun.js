// The Payroll run data hook — the single source the four views share. It fetches
// EVERY clocked hour for the pay period (timeApi.rollup, paged and complete) + every
// paid drive leg (driveApi.report payroll mode), then joins each team member on the run (payRunRoster: every
// active member, plus anyone who earned pay in the period whatever their status now)
// with their pay config + custom lines into one gross-per-person row. The previous
// period is fetched too so the Review view can show period-over-period deltas.
//
// Rows are a component-local projection (useState), never the synced blob — a pay
// run must not rewrite org_state. Money math is the pure lib/payroll.js.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from '../../store';
import { compareUsersByName } from '../../lib/roles';
import * as timeApi from '../../lib/timeApi';
import * as driveApi from '../../lib/driveApi';
import { dayKey } from '../../lib/dates';
import {
  payrollByUser, payrollByUserClipped, payPeriodRange, basePayForUser, lineTotals, grossForUser, isHeldCancelled,
  payRunRoster,
} from '../../lib/payroll';

const EMPTY = [];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function usePayrollRun(periodOffset = 0) {
  const users = useSelector(useCallback((s) => s.users, []));
  const ops = useSelector(useCallback((s) => s.opsSettings, []));
  const lines = useSelector(useCallback((s) => s.payrollLines || EMPTY, []));
  const sites = useSelector(useCallback((s) => s.sites, []));

  const cadence = ops?.payPeriodCadence === 'weekly' ? 'weekly'
    : ops?.payPeriodCadence === 'semimonthly' ? 'semimonthly' : 'biweekly';
  const otMultiplier = Number.isFinite(ops?.otMultiplier) ? ops.otMultiplier : 1.5;
  const payDrive = ops?.payDriveTime !== false;
  const driveMaxGapMins = ops?.driveMaxGapMins;

  const period = useMemo(() => payPeriodRange(cadence, periodOffset), [cadence, periodOffset]);
  const prevPeriod = useMemo(() => payPeriodRange(cadence, periodOffset - 1), [cadence, periodOffset]);

  const [hoursRows, setHoursRows] = useState(null);
  const [prevRows, setPrevRows] = useState(null);
  const [pending, setPending] = useState(0);
  // Cancelled-clean labor currently HELD from this run (flagged, not yet approved). The
  // affirmative-decision gate's counterpart: it pays $0 until approved, so the run
  // surfaces how much is withheld and prompts the manager to review it.
  const [held, setHeld] = useState({ count: 0, minutes: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const fetchPeriod = async (p) => {
      // Semi-monthly's calendar bounds cut through workweeks, so fetch the whole
      // overlapping pay-weeks (rollupFromIso/rollupToIso) and let payrollByUserClipped
      // place the 40h line on the full week, then attribute reg/OT by day into the
      // period. The week-aligned cadences fetch the period itself (rollup == period).
      const rollupFromIso = p.rollupFromIso || p.fromIso;
      const rollupToIso = p.rollupToIso || p.toIso;
      // Both reads are COMPLETE for the window (timeApi.rollup pages every punch; the
      // payroll drive read covers every leg) and a failure of EITHER fails the run. The
      // drive read used to be swallowed (.catch(() => null)), which priced the run with
      // no paid drive at all and looked like a normal pay run.
      const [entries, drive] = await Promise.all([
        timeApi.rollup({ fromIso: rollupFromIso, toIso: rollupToIso }),
        payDrive
          ? driveApi.report({ fromIso: rollupFromIso, toIso: rollupToIso, payroll: true, config: { maxGapMins: driveMaxGapMins }, sites })
            .catch((e) => { throw new Error(`Paid drive time couldn't be loaded, so pay can't be calculated yet. ${e?.message || ''}`.trim()); })
          : Promise.resolve(null),
      ]);
      const list = entries || [];
      const driveRows = payDrive ? (drive?.rows || []) : [];
      // OPERATIONAL LENS (approvedOnly:false) — the run projects pay from ALL completed
      // clocked hours so the page is useful all period, not only after sign-off; the
      // approved-hours GATE (pending count) is the guardrail before you export for payout.
      const rows = p.cadence === 'semimonthly'
        ? payrollByUserClipped(list, { approvedOnly: false, weekStartDay: 0, driveSegments: driveRows, clipFromKey: p.fromKey, clipToKey: p.toKey })
        : payrollByUser(list, { approvedOnly: false, weekStartDay: 0, driveSegments: driveRows });
      // The pending / held guardrails count THIS period only — semi-monthly's rollup
      // window spills into the boundary weeks, so clip those entries back to the period.
      const inPeriod = p.cadence === 'semimonthly'
        ? list.filter((e) => { const k = dayKey(e.clockInAt); return k >= p.fromKey && k <= p.toKey; })
        : list;
      return { entries: inPeriod, rows };
    };
    // THIS period decides the run (and whether it can be exported). The previous period
    // only feeds the period-over-period comparison, so it loads alongside and its
    // failure never blocks the run — the comparison is simply hidden (prevGross null).
    setPrevRows(null);
    fetchPeriod(period)
      .then((cur) => {
        if (!alive) return;
        setHoursRows(cur.rows);
        setPending(cur.entries.filter((e) => e.clockOutAt && e.approvalStatus === 'pending').length);
        const heldRows = cur.entries.filter(isHeldCancelled);
        setHeld({ count: heldRows.length, minutes: heldRows.reduce((a, e) => a + (e.durationMinutes || 0), 0) });
        setLoading(false);
      })
      .catch((e) => { if (alive) { setError(e?.message || 'Could not load payroll.'); setLoading(false); } });
    fetchPeriod(prevPeriod)
      .then((prev) => { if (alive) setPrevRows(prev.rows); })
      .catch(() => { if (alive) setPrevRows(null); });
    return () => { alive = false; };
  }, [period, prevPeriod, payDrive, driveMaxGapMins, sites]);

  // Disabling someone mid-period keeps them on the run for the pay they earned; people
  // since removed from the team can't be priced, so they come back apart (`removed`)
  // for the page's notice instead of silently vanishing from the totals.
  const roster = useMemo(
    () => payRunRoster({ users, hoursRows: hoursRows || EMPTY, lines, periodKey: period.fromKey, periodFromIso: period.fromIso }),
    [users, hoursRows, lines, period.fromKey, period.fromIso],
  );

  const rows = useMemo(() => {
    const byUser = new Map((hoursRows || []).map((r) => [r.userId, r]));
    const prevByUser = new Map((prevRows || []).map((r) => [r.userId, r]));
    return roster.members
      .slice()
      .sort(compareUsersByName)
      .map((u) => {
        const pay = u.pay || { type: null };
        const hours = byUser.get(u.id) || null;
        const userLines = lines.filter((l) => l.userId === u.id && l.periodKey === period.fromKey);
        const totals = lineTotals(userLines);
        const base = basePayForUser(hours, pay, { otMultiplier });
        const gross = grossForUser(hours, pay, userLines, { otMultiplier });
        const prevLines = lines.filter((l) => l.userId === u.id && l.periodKey === prevPeriod.fromKey);
        // null while the previous period is loading or unavailable → no comparison shown.
        const prevGross = prevRows ? grossForUser(prevByUser.get(u.id) || null, pay, prevLines, { otMultiplier }) : null;
        return {
          user: u, pay, payType: pay.type || null,
          hours, base, lines: userLines, totals, gross, prevGross,
          excluded: pay.type === 'none', unset: !pay.type,
          inactive: u.status !== 'active',
        };
      });
  }, [roster, hoursRows, prevRows, lines, period.fromKey, prevPeriod.fromKey, otMultiplier]);

  const summary = useMemo(() => {
    const s = { base: 0, adjustments: 0, gross: 0, prevGross: 0, regMinutes: 0, otMinutes: 0, onPayroll: 0, byCategory: {} };
    for (const row of rows) {
      if (row.gross == null) continue;
      s.onPayroll += 1;
      s.base = r2(s.base + (row.base || 0));
      s.adjustments = r2(s.adjustments + row.totals.net);
      s.gross = r2(s.gross + row.gross);
      if (row.prevGross != null) s.prevGross = r2(s.prevGross + row.prevGross);
      if (row.hours) { s.regMinutes += row.hours.regularMinutes || 0; s.otMinutes += row.hours.otMinutes || 0; }
      for (const [k, v] of Object.entries(row.totals.byCategory)) s.byCategory[k] = r2((s.byCategory[k] || 0) + v);
    }
    // No previous period (still loading / couldn't load): no comparison, not a fake one.
    if (!prevRows) { s.prevGross = null; s.deltaGross = 0; } else s.deltaGross = r2(s.gross - s.prevGross);
    return s;
  }, [rows, prevRows]);

  return { period, prevPeriod, rows, removed: roster.removed, summary, pending, held, loading, error, cadence, otMultiplier };
}
