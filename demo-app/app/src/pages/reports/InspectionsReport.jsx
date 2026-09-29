// "Inspections per site" — how many scored supervisor inspections each account got
// over a date range, with pass/fail + average score. Tallied over EVERY inspection in
// the window (qcApi.inspectionsBySite — server-side on the real backend, the same pure
// aggregator in the demo), then scoped to the Manager / Customer and relabelled live.
import { useCallback, useMemo, useState } from 'react';
import Badge from '../../components/Badge';
import { fmtDate, todayKey } from '../../lib/dates';
import * as qcApi from '../../lib/qcApi';
import { scopeSiteRows } from '../../lib/reports/qcReports';
import {
  useReportScope, ManagerFilter, CustomerFilter, SelectFilter, PeriodField, DateRangeField,
  FilterRow, RunActions, KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv, resolvePeriod, NoRows,
  periodError, defaultCustomRange, reportErrorMessage, canRetryError, useRunGuard,
} from './reportKit';

// The server tallies up to a year per run.
const MAX_DAYS = 366;

const RESULT_OPTIONS = [
  { value: '', label: 'All results' },
  { value: 'pass', label: 'Passed only' },
  { value: 'fail', label: 'Failed only' },
];

const COLUMNS = [
  { key: 'site', label: 'Customer', value: (r) => r.name },
  { key: 'count', label: 'Inspections', value: (r) => r.count },
  { key: 'avg', label: 'Avg score', value: (r) => (r.avgScore != null ? `${r.avgScore}%` : '—') },
  { key: 'passed', label: 'Passed', value: (r) => r.passCount },
  {
    key: 'failed', label: 'Failed', value: (r) => r.failCount,
    render: (r) => (r.failCount > 0 ? <Badge variant="red">{r.failCount}</Badge> : <span className="text-muted">0</span>),
  },
  { key: 'last', label: 'Last inspection', nowrap: true, value: (r) => (r.lastAt ? fmtDate(new Date(r.lastAt).toISOString()) : '—') },
];

export default function InspectionsReport() {
  const { currentUser, clients, managers, clientsById, sitesById } = useReportScope();
  const [period, setPeriod] = useState('30d');
  const [custom, setCustom] = useState(defaultCustomRange);
  const [managerScope, setManagerScope] = useState('');
  const [customerScope, setCustomerScope] = useState('');
  const [result, setResult] = useState('');
  const [rows, setRows] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null); // { message, canRetry, title? }
  const guard = useRunGuard();
  const reset = () => { guard.invalidate(); setRows(null); setError(null); setRunning(false); };

  const run = useCallback(async () => {
    const token = guard.begin();
    const bad = periodError(period, custom, { maxDays: MAX_DAYS });
    if (bad) { setRows(null); setError({ message: bad, canRetry: false, title: 'Check the dates' }); return; }
    setRunning(true); setError(null);
    try {
      const { fromIso, toIso } = resolvePeriod(period, custom);
      const siteRows = await qcApi.inspectionsBySite({
        fromIso, toIso, result: result || null, clientId: customerScope || null,
      });
      const out = scopeSiteRows(siteRows, {
        clientsById, sitesById, managerId: managerScope || null, clientId: customerScope || null,
      });
      if (guard.isCurrent(token)) setRows(out);
    } catch (e) {
      if (guard.isCurrent(token)) { setRows(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [period, custom, managerScope, customerScope, result, clientsById, sitesById, guard]);

  const kpis = useMemo(() => {
    const r = rows || [];
    let inspections = 0, passed = 0, failed = 0, scoreSum = 0, scoreN = 0;
    for (const a of r) {
      inspections += a.count; passed += a.passCount; failed += a.failCount;
      scoreSum += a.scoreSum || 0; scoreN += a.scoreN || 0;
    }
    return { sites: r.length, inspections, passed, failed, avg: scoreN ? Math.round(scoreSum / scoreN) : null };
  }, [rows]);

  return (
    <>
      <FilterRow>
        <PeriodField period={period} onPeriod={(p) => { setPeriod(p); reset(); }} />
        {period === 'custom' && <DateRangeField custom={custom} onCustom={(c) => { setCustom(c); reset(); }} />}
        <ManagerFilter managers={managers} currentUser={currentUser} value={managerScope} onChange={(v) => { setManagerScope(v); setCustomerScope(''); reset(); }} />
        <CustomerFilter clients={clients} managerScope={managerScope} value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
        <SelectFilter label="Result" value={result} onChange={(v) => { setResult(v); reset(); }} options={RESULT_OPTIONS} />
      </FilterRow>

      <RunActions running={running} hasRows={rows && rows.length > 0} onRun={run} onExport={() => downloadReportCsv(`inspections-per-site-${todayKey()}.csv`, COLUMNS, rows)} />

      <RunSurface rows={rows} running={running} error={error?.message} errorTitle={error?.title} onRetry={error?.canRetry ? run : undefined} empty={<NoRows title="No inspections" message="No inspections were recorded in this period for the selected criteria. Widen the period or clear the filters." />}>
        <KpiRow>
          <StatCard label="Inspections" value={kpis.inspections} />
          <StatCard label="Customers covered" value={kpis.sites} />
          <StatCard label="Avg score" value={kpis.avg != null ? `${kpis.avg}%` : '—'} />
          <StatCard label="Failed" value={kpis.failed} tone={kpis.failed > 0 ? 'danger' : null} />
        </KpiRow>
        <ResultsTable columns={COLUMNS} rows={rows || []} keyOf={(r) => r.key} />
      </RunSurface>
    </>
  );
}
