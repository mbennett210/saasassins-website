// "Checklists per site" — how many nightly crew checklists each account completed
// over a date range, and how thoroughly (avg item completion). Tallied over EVERY
// checklist in the window (qcApi.checklistsBySite — server-side on the real backend,
// the same pure aggregator in the demo), then scoped to the Manager / Customer.
import { useCallback, useMemo, useState } from 'react';
import { fmtDate, todayKey } from '../../lib/dates';
import * as qcApi from '../../lib/qcApi';
import { scopeSiteRows } from '../../lib/reports/qcReports';
import {
  useReportScope, ManagerFilter, CustomerFilter, PeriodField, DateRangeField,
  FilterRow, RunActions, KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv, resolvePeriod, NoRows,
  periodError, defaultCustomRange, reportErrorMessage, canRetryError, useRunGuard,
} from './reportKit';

// The server tallies up to a year per run.
const MAX_DAYS = 366;

const COLUMNS = [
  { key: 'site', label: 'Customer', value: (r) => r.name },
  { key: 'count', label: 'Checklists', value: (r) => r.count },
  { key: 'pct', label: 'Avg completion', value: (r) => (r.completionPct != null ? `${r.completionPct}%` : '—') },
  { key: 'full', label: 'Fully complete', value: (r) => `${r.fullCount}/${r.count}` },
  { key: 'last', label: 'Last completed', nowrap: true, value: (r) => (r.lastAt ? fmtDate(new Date(r.lastAt).toISOString()) : '—') },
];

export default function ChecklistsReport() {
  const { currentUser, clients, managers, clientsById, sitesById } = useReportScope();
  const [period, setPeriod] = useState('30d');
  const [custom, setCustom] = useState(defaultCustomRange);
  const [managerScope, setManagerScope] = useState('');
  const [customerScope, setCustomerScope] = useState('');
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
      const siteRows = await qcApi.checklistsBySite({ fromIso, toIso, clientId: customerScope || null });
      const out = scopeSiteRows(siteRows, {
        clientsById, sitesById, managerId: managerScope || null, clientId: customerScope || null,
      });
      if (guard.isCurrent(token)) setRows(out);
    } catch (e) {
      if (guard.isCurrent(token)) { setRows(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [period, custom, managerScope, customerScope, clientsById, sitesById, guard]);

  const kpis = useMemo(() => {
    const r = rows || [];
    let checklists = 0, full = 0, done = 0, total = 0;
    for (const a of r) { checklists += a.count; full += a.fullCount; done += a.itemsDone; total += a.itemsTotal; }
    return { sites: r.length, checklists, full, pct: total ? Math.round((done / total) * 100) : null };
  }, [rows]);

  return (
    <>
      <FilterRow>
        <PeriodField period={period} onPeriod={(p) => { setPeriod(p); reset(); }} />
        {period === 'custom' && <DateRangeField custom={custom} onCustom={(c) => { setCustom(c); reset(); }} />}
        <ManagerFilter managers={managers} currentUser={currentUser} value={managerScope} onChange={(v) => { setManagerScope(v); setCustomerScope(''); reset(); }} />
        <CustomerFilter clients={clients} managerScope={managerScope} value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
      </FilterRow>

      <RunActions running={running} hasRows={rows && rows.length > 0} onRun={run} onExport={() => downloadReportCsv(`checklists-per-site-${todayKey()}.csv`, COLUMNS, rows)} />

      <RunSurface rows={rows} running={running} error={error?.message} errorTitle={error?.title} onRetry={error?.canRetry ? run : undefined} empty={<NoRows title="No checklists" message="No checklists were completed in this period for the selected criteria. Widen the period or clear the filters." />}>
        <KpiRow>
          <StatCard label="Checklists" value={kpis.checklists} />
          <StatCard label="Customers covered" value={kpis.sites} />
          <StatCard label="Avg completion" value={kpis.pct != null ? `${kpis.pct}%` : '—'} tone={kpis.pct != null && kpis.pct < 100 ? 'warn' : (kpis.pct === 100 ? 'success' : null)} />
          <StatCard label="Fully complete" value={kpis.full} />
        </KpiRow>
        <ResultsTable columns={COLUMNS} rows={rows || []} keyOf={(r) => r.key} />
      </RunSurface>
    </>
  );
}
