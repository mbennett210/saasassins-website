// "Hours by cleaner" — regular / OT / total hours per cleaner over ANY date range,
// computed exactly as the Payroll run computes them for the same days: every punch in
// the whole pay weeks around the range (timeApi.rollup, a complete paged read) plus paid
// drive when the org pays it (driveApi payroll read), the weekly 40h line placed on the
// FULL week, then the range's days (and the Manager / Customer scope) carved out per
// punch (lib/payroll.attributeWeeklyOt + hoursByUserForRange). A range that cuts through
// a week no longer drops that week's overtime, and hours worked at another customer still
// count toward the 40h line.
import { useCallback, useMemo, useState } from 'react';
import Badge from '../../components/Badge';
import { todayKey } from '../../lib/dates';
import * as timeApi from '../../lib/timeApi';
import * as driveApi from '../../lib/driveApi';
import { attributeWeeklyOt, hoursByUserForRange, payWeeksWindow, minutesToHours } from '../../lib/payroll';
import {
  useReportScope, ManagerFilter, CustomerFilter, SelectFilter, PeriodField, DateRangeField,
  FilterRow, RunActions, KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv, resolvePeriod, NoRows,
  periodError, defaultCustomRange, reportErrorMessage, canRetryError, useRunGuard,
} from './reportKit';

const INCLUDE_OPTIONS = [
  { value: 'all', label: 'All completed' },
  { value: 'approved', label: 'Approved only' },
];

// A range is read in full pay weeks from the browser, so it is held to a quarter.
const MAX_DAYS = 92;
// Pay weeks are Sunday-anchored, the same week the Payroll run uses (lib/payroll).
const WEEK_START_DAY = 0;

const hoursColumns = (withDrive) => [
  { key: 'cleaner', label: 'Cleaner', value: (r) => r.userName },
  { key: 'reg', label: 'Regular (h)', nowrap: true, value: (r) => minutesToHours(r.regularMinutes) },
  {
    key: 'ot', label: 'OT (h)', nowrap: true, value: (r) => minutesToHours(r.otMinutes),
    render: (r) => (r.otMinutes > 0 ? <Badge variant="amber">{minutesToHours(r.otMinutes)}</Badge> : <span className="text-muted">0</span>),
  },
  ...(withDrive ? [{ key: 'drive', label: 'Paid drive (h, in total)', nowrap: true, value: (r) => minutesToHours(r.driveMinutes) }] : []),
  { key: 'total', label: 'Total (h)', nowrap: true, value: (r) => minutesToHours(r.totalMinutes) },
  { key: 'cleans', label: 'Cleans', value: (r) => r.cleanCount },
];

export default function HoursReport() {
  const { state, currentUser, clients, managers } = useReportScope();
  const [period, setPeriod] = useState('30d');
  const [custom, setCustom] = useState(defaultCustomRange);
  const [managerScope, setManagerScope] = useState('');
  const [customerScope, setCustomerScope] = useState('');
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [rows, setRows] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null); // { message, canRetry, title? }
  const guard = useRunGuard();
  const reset = () => { guard.invalidate(); setRows(null); setError(null); setRunning(false); };
  const payDrive = state.opsSettings?.payDriveTime !== false;
  const driveMaxGapMins = state.opsSettings?.driveMaxGapMins;
  const columns = useMemo(() => hoursColumns(payDrive), [payDrive]);

  const run = useCallback(async () => {
    const token = guard.begin();
    const bad = periodError(period, custom, { maxDays: MAX_DAYS });
    if (bad) { setRows(null); setError({ message: bad, canRetry: false, title: 'Check the dates' }); return; }
    setRunning(true); setError(null);
    try {
      const { fromKey, toKey } = resolvePeriod(period, custom);
      const win = payWeeksWindow(fromKey, toKey, { weekStartDay: WEEK_START_DAY });
      const [entries, drive] = await Promise.all([
        timeApi.rollup({ fromIso: win.fromIso, toIso: win.toIso }),
        payDrive
          ? driveApi.report({ fromIso: win.fromIso, toIso: win.toIso, payroll: true, config: { maxGapMins: driveMaxGapMins }, sites: state.sites })
          : Promise.resolve(null),
      ]);
      const items = attributeWeeklyOt(entries, {
        approvedOnly, weekStartDay: WEEK_START_DAY, driveSegments: payDrive ? (drive?.rows || []) : [],
      });
      // Scope the cleans by customer, or by the selected manager's book of customers.
      let clientIds = null;
      if (customerScope) clientIds = [customerScope];
      else if (managerScope) clientIds = (clients || []).filter((c) => c.supervisorId === managerScope).map((c) => c.id);
      const out = hoursByUserForRange(items, { fromKey, toKey, clientIds });
      if (guard.isCurrent(token)) setRows(out);
    } catch (e) {
      if (guard.isCurrent(token)) { setRows(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [period, custom, managerScope, customerScope, approvedOnly, clients, payDrive, driveMaxGapMins, state.sites, guard]);

  const kpis = useMemo(() => {
    const r = rows || [];
    let total = 0, ot = 0, cleans = 0;
    for (const u of r) { total += u.totalMinutes; ot += u.otMinutes; cleans += u.cleanCount; }
    return { cleaners: r.length, total: minutesToHours(total), ot: minutesToHours(ot), cleans };
  }, [rows]);

  const scoped = !!(customerScope || managerScope);
  const note = [
    approvedOnly ? 'Approved punches only' : 'All completed punches',
    'weekly 40h overtime, same as the Payroll run',
    payDrive ? (scoped ? 'drive counted to the customer driven to' : 'paid drive included') : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <FilterRow>
        <PeriodField period={period} onPeriod={(p) => { setPeriod(p); reset(); }} />
        {period === 'custom' && <DateRangeField custom={custom} onCustom={(c) => { setCustom(c); reset(); }} />}
        <ManagerFilter managers={managers} currentUser={currentUser} value={managerScope} onChange={(v) => { setManagerScope(v); setCustomerScope(''); reset(); }} />
        <CustomerFilter clients={clients} managerScope={managerScope} value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
        <SelectFilter label="Include" value={approvedOnly ? 'approved' : 'all'} onChange={(v) => { setApprovedOnly(v === 'approved'); reset(); }} options={INCLUDE_OPTIONS} />
      </FilterRow>

      <RunActions running={running} hasRows={rows && rows.length > 0} onRun={run} onExport={() => downloadReportCsv(`hours-by-cleaner-${todayKey()}.csv`, columns, rows)} note={note} />

      <RunSurface rows={rows} running={running} error={error?.message} errorTitle={error?.title} onRetry={error?.canRetry ? run : undefined} empty={<NoRows title="No hours in this period" message="No completed punches were found for these criteria. Widen the period, or switch to “All completed”." />}>
        <KpiRow>
          <StatCard label="Total hours" value={kpis.total} />
          <StatCard label="OT hours" value={kpis.ot} tone={kpis.ot > 0 ? 'warn' : null} />
          <StatCard label="Cleaners" value={kpis.cleaners} />
          <StatCard label="Cleans" value={kpis.cleans} />
        </KpiRow>
        <ResultsTable columns={columns} rows={rows || []} keyOf={(r) => r.userId} />
      </RunSurface>
    </>
  );
}
