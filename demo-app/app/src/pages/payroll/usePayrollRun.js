// The Payroll run data hook — now a THIN READER of the server pay run (wave W3-P §8.5).
// It calls payrollApi.preview(offset) and normalises the response for the four views; the
// old client-side rollup + drive pricing is GONE (II.5) — the pay math is the shared
// lib/payRun.computePayRun that the server route and the demo stub run, so a preview, a
// close and a demo can never price a period differently.
//
// A preview is either an OPEN period (the priced run + closable/blockers/asOf/prev/file) or
// a CLOSED period ({ period, closed } — the stored run, whose `file` holds the exact rows the
// final CSV was built from). Rows are joined back to the store `users` slice only for display
// (name, initials, avatar, status); nothing here recomputes pay.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from '../../store';
import * as payrollApi from '../../lib/payrollApi';
import { payPeriodRange, payDateKeyFor, payDateConfigOf, payWeekStartDayOf } from '../../lib/payroll';
import { DEFAULT_ORG_TIMEZONE } from '../../lib/dates';

const EMPTY = [];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const initialsOf = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '—';
const emptyTotals = () => ({ regularMinutes: 0, otMinutes: 0, driveMinutes: 0, cleanCount: 0 });
// The CSV pay-type labels a stored run keeps → back to the view's pay-type key.
const PAY_TYPE_FROM_LABEL = { Hourly: 'hourly', Salary: 'salary', 'Per-visit': 'per_visit' };

export function usePayrollRun(periodOffset = 0) {
  const users = useSelector(useCallback((s) => s.users, []));

  // The org cadence / zone drive a client-side period for the header + stepper so they render
  // instantly while the preview loads (the SAME payPeriodRange the server uses, so no drift);
  // once the preview lands its own `period` is used.
  const cadence = useSelector(useCallback((s) => {
    const c = s.opsSettings?.payPeriodCadence;
    return c === 'weekly' || c === 'semimonthly' ? c : 'biweekly';
  }, []));
  const tz = useSelector(useCallback((s) => s.company?.timezone || DEFAULT_ORG_TIMEZONE, []));
  // PAY-19: the org's workweek start, so the placeholder period the header renders before the
  // preview lands is the SAME period the server will price (a Sunday-only calendar would flash
  // the wrong dates and, worse, the wrong periodKey).
  const weekStartDay = useSelector(useCallback((s) => payWeekStartDayOf(s.opsSettings), []));
  // PAY-2: the payday schedule, for the same reason — the run's own `payDateKey` wins once it
  // arrives; this is what the header shows while it loads. `payDateConfigOf` ALLOCATES, so it is
  // memoized off the ref-stable slice rather than called inside useSelector.
  const opsSettings = useSelector(useCallback((s) => s.opsSettings, []));
  const payDateCfg = useMemo(() => payDateConfigOf(opsSettings), [opsSettings]);
  const clientPeriod = useMemo(() => payPeriodRange(cadence, periodOffset, new Date(), tz, weekStartDay), [cadence, periodOffset, tz, weekStartDay]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reqRef = useRef(0);
  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const token = reqRef.current + 1; reqRef.current = token;
    setLoading(true); setError(null);
    payrollApi.preview(periodOffset)
      .then((res) => { if (alive && token === reqRef.current) { setData(res); setLoading(false); } })
      .catch((e) => { if (alive && token === reqRef.current) { setError(e?.message || 'Could not load payroll.'); setData(null); setLoading(false); } });
    return () => { alive = false; };
  }, [periodOffset, reloadTick]);

  const usersById = useMemo(() => new Map((users || []).map((u) => [u.id, u])), [users]);
  const usersByName = useMemo(() => new Map((users || []).map((u) => [u.name, u])), [users]);
  const joinUser = useCallback((userId, userName) => {
    const u = (userId != null && usersById.get(userId)) || (userName && usersByName.get(userName)) || null;
    if (u) return { id: u.id, name: u.name, initials: u.initials || initialsOf(u.name), avatar: u.avatar ?? 0, status: u.status || 'active' };
    return { id: userId ?? null, name: userName || '—', initials: initialsOf(userName), avatar: 0, status: 'active' };
  }, [usersById, usersByName]);

  const closed = data?.closed || null;   // the stored run when this period is already closed
  const isClosed = !!closed;
  const period = data?.period || clientPeriod;

  // The previous CLOSED run's per-person gross → the period-over-period compare (open only;
  // matched by name because a stored file row keeps only { userName, gross }).
  const prevByName = useMemo(() => {
    const m = new Map();
    for (const p of data?.prev?.rows || EMPTY) m.set(p.userName, p.gross);
    return m;
  }, [data]);

  const rows = useMemo(() => {
    if (isClosed) {
      // A closed run is rendered read-only from the exact rows the CSV was built from.
      return (closed.file?.rows || EMPTY).map((fr, i) => {
        const u = usersByName.get(fr.userName) || null;
        const byCategory = fr.byCategory || {};
        const net = r2(Object.values(byCategory).reduce((a, v) => a + (Number(v) || 0), 0));
        return {
          key: (u && u.id) || `${fr.userName}#${i}`,
          userId: (u && u.id) || null,
          user: joinUser(u && u.id, fr.userName),
          pay: (u && u.pay) || null,
          payType: PAY_TYPE_FROM_LABEL[fr.payTypeLabel] || (u && u.pay && u.pay.type) || null,
          current: { regularMinutes: fr.regularMinutes || 0, otMinutes: fr.otMinutes || 0, driveMinutes: 0, cleanCount: 0 },
          arrears: { regularMinutes: fr.arrearsRegularMinutes || 0, otMinutes: fr.arrearsOtMinutes || 0, driveMinutes: 0, cleanCount: 0, pay: fr.arrearsPay || 0, rows: EMPTY },
          base: fr.base, lines: EMPTY, totals: { net, byCategory }, gross: fr.gross,
          // A closed run's stored file keeps totals, not the per-rate lines (PAY-7 / PAY-18), so
          // the drawer falls back to the one hours→base line it shows for a closed period.
          rateBreakdown: null,
          prevGross: null, excluded: false, unset: false, inactive: u ? u.status !== 'active' : false,
        };
      });
    }
    return (data?.rows || EMPTY).map((r) => ({
      key: r.userId,
      userId: r.userId,
      user: joinUser(r.userId, r.userName),
      pay: r.pay || { type: r.payType || null },
      payType: r.payType || null,
      current: r.current || emptyTotals(),
      arrears: { ...(r.arrears || emptyTotals()), pay: r.arrearsPay || 0, rows: (r.arrears && r.arrears.rows) || EMPTY },
      base: r.base, lines: r.lines || EMPTY, totals: r.totals || { net: 0, byCategory: {} }, gross: r.gross,
      // The server's own hours→base lines (per building rate + the week's blended overtime
      // premium, PAY-7 / PAY-18). The drawer RENDERS these; it never re-derives a rate.
      rateBreakdown: r.rateBreakdown || null,
      prevGross: prevByName.has(r.userName) ? prevByName.get(r.userName) : null,
      excluded: !!r.excluded, unset: !!r.unset, inactive: !!r.inactive,
    }));
  }, [isClosed, closed, data, prevByName, usersByName, joinUser]);

  // Summary is a DISPLAY rollup of already-priced rows (gross is rounded per-row on the
  // server, so summing is exact) — never a re-pricing. prevGross/deltaGross come from the
  // previous closed run.
  const summary = useMemo(() => {
    const s = { base: 0, arrears: 0, adjustments: 0, gross: 0, regMinutes: 0, otMinutes: 0, arrearsRegMinutes: 0, arrearsOtMinutes: 0, onPayroll: 0, byCategory: {} };
    let anyPrev = false; let prevSum = 0;
    for (const row of rows) {
      if (row.gross == null) continue;
      s.onPayroll += 1;
      s.base = r2(s.base + (row.base || 0));
      s.arrears = r2(s.arrears + (row.arrears.pay || 0));
      s.adjustments = r2(s.adjustments + (row.totals.net || 0));
      s.gross = r2(s.gross + row.gross);
      s.regMinutes += row.current.regularMinutes || 0; s.otMinutes += row.current.otMinutes || 0;
      s.arrearsRegMinutes += row.arrears.regularMinutes || 0; s.arrearsOtMinutes += row.arrears.otMinutes || 0;
      for (const [k, v] of Object.entries(row.totals.byCategory || {})) s.byCategory[k] = r2((s.byCategory[k] || 0) + (Number(v) || 0));
      if (row.prevGross != null) { anyPrev = true; prevSum = r2(prevSum + row.prevGross); }
    }
    // The compare is to the previous CLOSED run; before one exists there is nothing to compare.
    const prevAvailable = !isClosed && (data?.prev != null);
    s.prevGross = prevAvailable ? prevSum : null;
    s.deltaGross = prevAvailable && anyPrev ? r2(s.gross - prevSum) : 0;
    return s;
  }, [rows, isClosed, data]);

  // Readiness (open period): pending / open / held-OT grouped by each customer's supervisor,
  // with the manager's name resolved for the card. Groups with nothing waiting are dropped.
  const readiness = useMemo(() => {
    if (isClosed) return EMPTY;
    return (data?.readiness || EMPTY)
      .filter((g) => (g.pendingCount || 0) || (g.openCount || 0) || (g.otHeldMinutes || 0))
      .map((g) => ({
        ...g,
        supervisorName: g.supervisorId ? (usersById.get(g.supervisorId)?.name || 'A manager') : 'No manager',
      }))
      .sort((a, b) => (b.pendingCount + b.openCount) - (a.pendingCount + a.openCount) || (b.otHeldMinutes - a.otHeldMinutes));
  }, [isClosed, data, usersById]);

  const rolledForward = (isClosed ? closed.rolled_forward : data?.rolledForward) || { pendingCount: 0, pendingMinutes: 0, openCount: 0, otHeldMinutes: 0 };
  const file = (isClosed ? closed.file : data?.file) || null;
  const prevLabel = data?.prev?.label || null;
  // PAY-2: the payday. A CLOSED run's stored file keeps the date that run actually paid on, so a
  // later download still says it even if the setting has since changed; an open period takes the
  // server's figure, and falls back to the same pure rule while the preview loads (or for a run
  // closed before this field shipped).
  const payDateKey = (isClosed ? closed.file?.payDateKey : data?.payDateKey)
    || payDateKeyFor(period, payDateCfg);

  return {
    loading, error, reload,
    period, isClosed,
    chip: isClosed ? { closed: true, at: closed.closed_at, by: closed.closed_by_name } : { closed: false },
    rows,
    removed: isClosed ? EMPTY : (data?.removed || EMPTY),
    summary, readiness, rolledForward,
    closable: !isClosed && !!data?.closable,
    closeBlockers: isClosed ? EMPTY : (data?.closeBlockers || EMPTY),
    asOf: data?.asOf || null,
    prev: data?.prev || null, prevLabel,
    file, payDateKey,
    cadence: data?.cadence || cadence,
    otMultiplier: Number.isFinite(data?.otMultiplier) ? data.otMultiplier : undefined,
    tz: data?.tz || tz,
  };
}
