// "Time to resolve" — how long tickets take from being opened to being closed. Matt's KPI (the Oct
// 6 call: "how long it takes from a ticket to be open to closed … on the average last 30 days …
// company-wide or account-wide"; plan docs/plans/2026-10-11-oct-6-call-additions.md §4, D10/D12).
//
// Runs INLINE like every report: period · Manager · Customer → Run → the company-wide figures
// (average, median, tickets closed, closed within their deadline) → a table by type → a table by
// customer (20 a page, stacked on a phone) → CSV of the customer table.
//
// THE NUMBERS ARE THE SERVER'S (qcApi.resolveTimes → GET /api/qc/reports/resolve-time, EP-360): a
// complete read of every ticket resolved in the period, tallied by the ONE rule (lib/resolveTime)
// that also feeds the customer hub's tile; the demo runs the same rule over its stub. Manager and
// Customer are sent to the server and narrow the TICKETS, because a median and a deadline tally
// cannot be added up from per-customer rows here. Every origin counts (the office's own tickets
// too) — the hub's figure is the customer's requests only (D11), so the two can differ for a
// building, on purpose. Names are relabelled live from the customer book.
//
// Written on the catalog from its first line (UI_RULES §140): `resolveTime.report.*`, the type
// names included (a literal key map, never a built key).
import { useCallback, useMemo, useState } from 'react';
import { useT } from '../../i18n/react';
import { todayKey } from '../../lib/dates';
import * as qcApi from '../../lib/qcApi';
import { formatResolveDuration } from '../../lib/resolveTime';
import { customerLabel } from '../../lib/customerNumber';
import { managerFilterIds } from '../../lib/managerFilter';
import {
  useReportScope, ManagerFilter, CustomerFilter, PeriodField, DateRangeField,
  FilterRow, RunActions, KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv, resolvePeriod, NoRows,
  periodError, defaultCustomRange, PERIOD_ERROR_TITLE, reportErrorMessage, canRetryError, useRunGuard,
} from './reportKit';

// The server reads at most 367 days (api/qc windowParams); the picker stays inside it.
const MAX_DAYS = 366;

// Each work-order type's name, as a literal key (lib/workOrders WO_TYPES).
const TYPE_KEYS = {
  complaint: 'resolveTime.report.type.complaint',
  request: 'resolveTime.report.type.request',
  issue: 'resolveTime.report.type.issue',
  failed_inspection: 'resolveTime.report.type.failed_inspection',
};

export default function ResolveTimeReport() {
  const t = useT();
  const { state, currentUser, clients, managers, clientsById } = useReportScope();
  const [period, setPeriod] = useState('30d');
  const [custom, setCustom] = useState(defaultCustomRange);
  const [managerScope, setManagerScope] = useState('');
  const [customerScope, setCustomerScope] = useState('');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null); // { message, canRetry, title? }
  const guard = useRunGuard();
  const reset = () => { guard.invalidate(); setResult(null); setError(null); setRunning(false); };

  const run = useCallback(async () => {
    const token = guard.begin();
    const bad = periodError(period, custom, { maxDays: MAX_DAYS });
    if (bad) { setResult(null); setError({ message: bad, canRetry: false, title: PERIOD_ERROR_TITLE }); return; }
    setRunning(true); setError(null);
    try {
      const { fromIso, toIso } = resolvePeriod(period, custom);
      const r = await qcApi.resolveTimes({
        fromIso, toIso, supervisorId: managerScope || null, clientId: customerScope || null,
      });
      if (guard.isCurrent(token)) setResult(r);
    } catch (e) {
      if (guard.isCurrent(token)) { setResult(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [period, custom, managerScope, customerScope, guard]);

  const overall = result?.overall || null;
  const dur = useCallback((ms) => formatResolveDuration(ms, t), [t]);
  const within = useCallback((s) => (s?.withDeadline ? t('resolveTime.report.metOf', { onTime: s.onTime, total: s.withDeadline }) : '—'), [t]);

  const typeRows = useMemo(
    () => (result?.byType || []).map((r) => ({ ...r, name: TYPE_KEYS[r.type] ? t(TYPE_KEYS[r.type]) : r.type })),
    [result, t],
  );
  const customerRows = useMemo(() => (result?.byClient || [])
    .map((r) => {
      const live = clientsById.get(r.clientId);
      return { ...r, name: live ? customerLabel(live) : (r.clientName || r.clientId) };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name))), [result, clientsById]);

  // The figures every table shares, after its own first column.
  const figureColumns = useMemo(() => [
    { key: 'closed', label: t('resolveTime.report.col.closed'), value: (r) => r.count },
    { key: 'average', label: t('resolveTime.report.col.average'), nowrap: true, value: (r) => dur(r.meanMs) },
    { key: 'median', label: t('resolveTime.report.col.median'), nowrap: true, value: (r) => dur(r.medianMs) },
    { key: 'met', label: t('resolveTime.report.col.met'), nowrap: true, value: (r) => within(r) },
  ], [t, dur, within]);
  const typeColumns = useMemo(() => [
    { key: 'type', label: t('resolveTime.report.col.type'), value: (r) => r.name },
    ...figureColumns,
  ], [t, figureColumns]);
  const customerColumns = useMemo(() => [
    { key: 'customer', label: t('resolveTime.report.col.customer'), value: (r) => r.name },
    ...figureColumns,
  ], [t, figureColumns]);

  // The result-area state: not run, nothing closed (the empty state), or the figures.
  const shown = result ? (overall?.count ? [overall] : []) : null;

  return (
    <>
      <FilterRow>
        <PeriodField period={period} onPeriod={(p) => { setPeriod(p); reset(); }} />
        {period === 'custom' && <DateRangeField custom={custom} onCustom={(c) => { setCustom(c); reset(); }} />}
        {/* An Operations Manager may pick "My team" (S131): `supervisorId=team`, which the route
            resolves from their claim (api/qc reports/resolve-time); the Customer filter follows it. */}
        <ManagerFilter managers={managers} currentUser={currentUser} value={managerScope} onChange={(v) => { setManagerScope(v); setCustomerScope(''); reset(); }} team />
        <CustomerFilter clients={clients} managerScope={managerFilterIds(managerScope, { viewer: currentUser, users: state.users })} value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
      </FilterRow>

      <RunActions
        running={running}
        hasRows={customerRows.length > 0}
        onRun={run}
        onExport={() => downloadReportCsv(`time-to-resolve-${todayKey()}.csv`, customerColumns, customerRows)}
        note={t('resolveTime.report.note')}
      />

      <RunSurface
        rows={shown}
        running={running}
        error={error?.message}
        errorTitle={error?.title}
        onRetry={error?.canRetry ? run : undefined}
        empty={<NoRows title={t('resolveTime.report.emptyTitle')} message={t('resolveTime.report.emptyHint')} />}
      >
        <KpiRow>
          <StatCard label={t('resolveTime.report.kpi.average')} value={dur(overall?.meanMs)} />
          <StatCard label={t('resolveTime.report.kpi.median')} value={dur(overall?.medianMs)} />
          <StatCard label={t('resolveTime.report.kpi.closed')} value={overall?.count ?? 0} />
          <StatCard label={t('resolveTime.report.kpi.metDeadline')} value={within(overall)} />
        </KpiRow>
        <h3 className="section-title reports-section-title">{t('resolveTime.report.byType')}</h3>
        <ResultsTable columns={typeColumns} rows={typeRows} keyOf={(r) => r.type} />
        <h3 className="section-title reports-section-title">{t('resolveTime.report.byCustomer')}</h3>
        <ResultsTable columns={customerColumns} rows={customerRows} keyOf={(r) => r.clientId} />
      </RunSurface>
    </>
  );
}
