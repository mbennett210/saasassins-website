// "Supply usage / building" — SUP-5 / CS-191. How much of each item a building took delivery of
// over a period, and what it cost.
//
// 🔴 ONE IMPLEMENTATION, TWO PLACES (2026-10-04). `SupplyUsageView` is the report: the Supplies
// page's Usage tab renders it with its filters in the URL and the figures following them live,
// and Reports → Supply usage renders it (the default export below) with local filters and the
// hub's Run gesture.
//
// Matt (SUP-5 a): an item counts "when it's delivered". Since the supply orders (S131) an order is
// delivered LINE BY LINE, so every figure here counts each DELIVERY at its own time and quantity
// (lib/supplies supplyUsageByItem over supplyDeliveries) — a line delivered in September and the
// rest in October count in their own months; an order still waiting for approval or with the
// supplier counts once something on it arrives. (An order completed before the per-line record
// counts what went out at its `completedAt`.)
//
// 🔴 SUP-13 (Matt, 2026-10-05): usage and spend go back 12 MONTHS. The requests left the shared
// record for their own table, so this is ONE server read (`suppliesApi.usage` → GET
// /api/supplies/usage): the server reads every delivery in the window — complete, not a page — and
// tallies it with the same pure lib/supplies supplyUsageByItem. Loading, error-with-Retry and
// empty are real states now (UI_RULES §117: a report reads its whole window or says it could not).
//
// 🔴 THE PERIOD IS CAPPED AT THE KEPT HISTORY. A settled request older than 12 months is deleted
// at the write point, so a custom range that STARTS before the kept history would read short; it
// is refused, naming the first allowed day (lib/supplies supplyUsageWindowKeys — the route runs
// the same rule, so a typed date that slips past the picker is refused there too).
//
// THE TEAM (S131 Wave 2): an Operations Manager's Manager filter offers "My team" (`team`, which
// the server resolves from their claim — lib/teamScope), and the Customer filter lists that team's
// customers (lib/managerFilter managerFilterIds). On the Supplies page the managers listed are the
// page's own (an OM's team); Reports lists every manager.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayKey, startOfDayKey, money, fmtDate } from '../../lib/dates';
import {
  supplyHistoryStartKey, supplyHistoryDays, supplyUsageWindowKeys, SUPPLY_HISTORY_MONTHS,
} from '../../lib/supplies';
import * as suppliesApi from '../../lib/suppliesApi';
import { searchRows } from '../../lib/searchRows';
import { managerFilterIds, teamPickLead } from '../../lib/managerFilter';
import { useSupplyBudgets } from '../../hooks/useSupplyBudgets';
import { useTableSearch } from '../../hooks/useTableSearch';
import TableSearch from '../../components/TableSearch';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useT } from '../../i18n/react';
import { msg } from '../../i18n/core';
import {
  useReportScope, ManagerFilter, CustomerFilter, PeriodField, DateRangeField, PERIODS,
  FilterRow, RunActions, KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv,
  NoRows, periodError, defaultCustomRange, PERIOD_ERROR_TITLE, reportErrorMessage,
} from './reportKit';

// The report kit's presets plus SUP-13's six and twelve months ('12m' IS the kept history), in
// the order the pills read. The windows themselves are lib/supplies supplyUsageWindowKeys.
export const SUPPLY_USAGE_PILLS = [
  ...PERIODS.filter((p) => p.value !== 'custom'),
  { value: '6m', labelKey: 'reportKit.period.6m' },
  { value: '12m', labelKey: 'reportKit.period.12m' },
  ...PERIODS.filter((p) => p.value === 'custom'),
];

// A refused window, as the reader's own sentence (the server's codes and the pure rule's agree).
function windowError(code, { firstKey } = {}) {
  if (code === 'before_history') {
    return msg('supplyUsage.beforeHistory', {
      months: SUPPLY_HISTORY_MONTHS, date: fmtDate(startOfDayKey(firstKey || supplyHistoryStartKey(todayKey())).toISOString()),
    });
  }
  if (code === 'pick_both') return msg('reportKit.pickBothDates');
  if (code === 'end_before_start') return msg('reportKit.endBeforeStart');
  return msg('reportKit.loadFailed');
}

/**
 * The supply-usage report.
 * filters: { period, from, to, mgr, cust, om? } · onFilters(patch) — `om`: whose team `mgr=team` is when
 *   the owner named one (the Supplies page, from the Operations view's tile — S131 Wave 2)
 * live: figures follow the filters (no Run button) — the Supplies tab; else the hub's Run gesture.
 * managers: the Manager filter's people when the host page has its own list (the Supplies page: an
 *   Operations Manager's team); else every manager.
 */
export function SupplyUsageView({ filters, onFilters, live = false, managers: hostManagers = null }) {
  const t = useT();
  const { state, currentUser, clients, managers: everyone } = useReportScope();
  const managers = hostManagers || everyone;
  const budgets = useSupplyBudgets();
  const [q, setQ] = useTableSearch('uq');
  const { period, mgr, cust } = filters;
  const om = filters.om || '';
  // The filter as the managers it keeps: `team` is the viewer's team, or the one the owner named with
  // `om` (the Customer options), the Manager filter naming it.
  const mgrScope = useMemo(() => managerFilterIds(mgr, { viewer: currentUser, users: state.users || [], omParam: om }), [mgr, om, currentUser, state.users]);
  const teamLead = useMemo(() => teamPickLead({ viewer: currentUser, users: state.users || [], value: mgr, omParam: om }), [mgr, om, currentUser, state.users]);
  const custom = useMemo(() => ({ from: filters.from, to: filters.to }), [filters.from, filters.to]);
  const today = todayKey();
  const historyStart = supplyHistoryStartKey(today);

  // The criteria, as one key. On the hub a result is SHOWN only for exactly the criteria Run was
  // pressed on (a changed filter clears it); on the Supplies tab every change reads at once.
  const criteria = JSON.stringify([period, custom.from, custom.to, mgr, om, cust]);
  const [ranCriteria, setRanCriteria] = useState(live ? criteria : null);
  useEffect(() => { if (live) setRanCriteria(criteria); }, [live, criteria]);

  const [result, setResult] = useState(null);   // { criteria, rows } | { criteria, error }
  const [running, setRunning] = useState(false);
  const seq = useRef(0);
  const read = useCallback(async (which) => {
    const token = (seq.current += 1);
    // The window is judged FIRST by the same pure rule the route runs, so an impossible range
    // never costs a request — and a range longer than the kept history is the kit's own refusal.
    const w = supplyUsageWindowKeys(period, { todayKey: today, from: custom.from, to: custom.to });
    const bad = w.error ? windowError(w.error, w)
      : periodError(period, custom, { maxDays: supplyHistoryDays(today) });
    if (bad) { setResult({ criteria: which, error: bad, canRetry: false }); return; }
    setRunning(true);
    try {
      const r = await suppliesApi.usage({ period, from: custom.from, to: custom.to, mgr, cust, om: om || null }, { state, user: currentUser });
      if (token === seq.current) setResult({ criteria: which, rows: r.rows || [] });
    } catch (e) {
      if (token !== seq.current) return;
      setResult({
        criteria: which,
        error: e && e.code ? windowError(e.code, e) : reportErrorMessage(e),
        canRetry: !(e && e.status === 400),
      });
    } finally {
      if (token === seq.current) setRunning(false);
    }
  }, [period, custom, mgr, om, cust, today, state, currentUser]);
  useEffect(() => { if (ranCriteria === criteria) read(criteria); }, [ranCriteria]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = result && result.criteria === criteria && ranCriteria === criteria ? result : null;
  const allRows = shown && !shown.error ? shown.rows : null;
  const rows = useMemo(() => (allRows ? searchRows(allRows, q, (r) => r.name) : null), [allRows, q]);
  const kpis = useMemo(() => {
    const r = allRows || [];
    const qty = r.reduce((a, x) => a + x.qty, 0);
    const spend = Math.round(r.reduce((a, x) => a + x.total, 0) * 100) / 100;
    return { items: r.length, qty, spend };
  }, [allRows]);

  const columns = useMemo(() => [
    { key: 'item', label: t('supplyUsage.col.item'), value: (r) => r.name },
    { key: 'qty', label: t('supplyUsage.col.delivered'), value: (r) => r.qty },
    { key: 'deliveries', label: t('supplyUsage.col.deliveries'), value: (r) => r.requests },
    { key: 'unit', label: t('supplyUsage.col.unitPrice'), nowrap: true, value: (r) => (r.unitPrice != null ? money(r.unitPrice) : t('supplyUsage.noPrice')) },
    { key: 'spend', label: t('supplyUsage.col.spend'), nowrap: true, value: (r) => money(r.total) },
  ], [t]);

  // The picked building's month: its budget beside the period's figures (SUP-7). The budget is a
  // CALENDAR-month figure whatever period is picked, and the tile says so.
  const budget = cust ? budgets.statusFor(cust) : null;

  return (
    <>
      <FilterRow>
        <PeriodField period={period} periods={SUPPLY_USAGE_PILLS} onPeriod={(p) => onFilters({ period: p })} />
        {period === 'custom' && (
          <DateRangeField custom={custom} min={historyStart} max={today} onCustom={(c) => onFilters({ from: c.from, to: c.to })} />
        )}
        <ManagerFilter managers={managers} currentUser={currentUser} value={mgr} onChange={(v) => onFilters({ mgr: v, cust: '' })} team teamLead={teamLead} />
        <CustomerFilter clients={clients} managerScope={mgrScope} value={cust} onChange={(v) => onFilters({ cust: v })} />
      </FilterRow>

      <RunActions
        running={running}
        hasRows={!!allRows && allRows.length > 0}
        onRun={live ? undefined : () => { if (ranCriteria === criteria) read(criteria); else setRanCriteria(criteria); }}
        onExport={() => downloadReportCsv(`supply-usage-${today}.csv`, columns, allRows || [])}
        note={msg('supplyUsage.note', { months: SUPPLY_HISTORY_MONTHS })}
      />

      <RunSurface
        rows={allRows}
        running={running}
        error={shown?.error}
        errorTitle={shown?.error && !shown.canRetry ? PERIOD_ERROR_TITLE : undefined}
        onRetry={shown?.error && shown.canRetry ? () => read(criteria) : undefined}
        empty={<NoRows title={t('supplyUsage.emptyTitle')} message={t('supplyUsage.emptyHint')} />}
      >
        <KpiRow>
          <StatCard label={t('supplyUsage.kpi.items')} value={kpis.items} />
          <StatCard label={t('supplyUsage.kpi.units')} value={kpis.qty} />
          <StatCard label={t('supplyUsage.kpi.spend')} value={money(kpis.spend)} />
          {budget && (
            <StatCard
              label={t('supplyUsage.kpi.budget')}
              tone={budget.over ? 'danger' : undefined}
              value={!budget.loaded ? '—'
                : budget.budget != null
                  ? t('supplyUsage.budgetOf', { amount: money(budget.spend), budget: money(budget.budget) })
                  : t('supplyUsage.noBudget')}
            />
          )}
        </KpiRow>
        <div className="table-head">
          <div className="table-controls">
            <TableSearch value={q} onChange={setQ} placeholder={t('supplyUsage.search')} />
            {q && rows && <span className="table-count">{t('supplyUsage.matchCount', { shown: rows.length, total: allRows?.length || 0 })}</span>}
          </div>
        </div>
        {rows && rows.length === 0 ? (
          <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyUsage.noMatch')} message={t('supplyUsage.noMatchHint')} />
        ) : (
          <ResultsTable columns={columns} rows={rows || []} keyOf={(r) => r.name} />
        )}
      </RunSurface>
    </>
  );
}

// Reports → Supply usage: the same view, its filters held on the hub, run on the hub's gesture.
export default function SupplyUsageReport() {
  const [filters, setFilters] = useState(() => {
    const c = defaultCustomRange();
    return { period: '30d', from: c.from, to: c.to, mgr: '', cust: '' };
  });
  return <SupplyUsageView filters={filters} onFilters={(patch) => setFilters((f) => ({ ...f, ...patch }))} />;
}
