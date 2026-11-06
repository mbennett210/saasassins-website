// "Activity log" — the company-wide record of who did what and when (CS-379; Matt's
// LOG-1..8). Runs INLINE like every other report: filters (date range, customer, person,
// action type) → Run → paged table, newest first, plus the two exports LOG-6 asks for.
//
// WHAT YOU SEE IS DECIDED ON THE SERVER, NOT HERE (LOG-4): the owner everything, an admin
// everything except pay and money changes, a manager only the customers they supervise, crew
// nothing. The blob is on-device, so a client-side filter would not be a boundary — this
// screen just renders what /api/activity served and says which scope it was.
import { useCallback, useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import * as activityApi from '../../lib/activityApi';
import { getOrgTimezone } from '../../lib/dates';
import {
  ACTION_GROUPS, actionLabel, actorLabel, beforeAfterText, fmtStampIn,
} from '../../lib/activityLog';
import {
  useReportScope, CustomerFilter, SelectFilter, PeriodField, DateRangeField,
  FilterRow, KpiRow, StatCard, RunSurface, ResultsTable, resolvePeriod, NoRows,
  periodError, defaultCustomRange, reportErrorMessage, canRetryError, useRunGuard,
} from './reportKit';

// The server bounds the window at 400 days; keep the picker inside it.
const MAX_DAYS = 366;
// One server page. The table pages 20 at a time within what has been loaded, and "Load more"
// fetches the next page — so a year of entries never arrives in one response.
const PAGE = 50;

export default function ActivityLogReport() {
  const { currentUser, clients, state } = useReportScope();
  const tz = getOrgTimezone();
  const [period, setPeriod] = useState('30d');
  const [custom, setCustom] = useState(defaultCustomRange);
  const [customerScope, setCustomerScope] = useState('');
  const [person, setPerson] = useState('');
  const [group, setGroup] = useState('');
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const guard = useRunGuard();
  const reset = () => { guard.invalidate(); setRows(null); setTotal(0); setError(null); setRunning(false); };

  // The roster, for a row whose actor name was not denormalized (the jobs path).
  const usersById = useMemo(() => new Map((state.users || []).map((u) => [u.id, u])), [state.users]);

  const peopleOptions = useMemo(() => [
    { value: '', label: 'Everyone' },
    ...(state.users || [])
      .map((u) => ({ value: u.id, label: u.id === currentUser?.id ? `${u.name} (me)` : u.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ], [state.users, currentUser]);

  const groupOptions = useMemo(() => [
    { value: '', label: 'Everything' },
    ...ACTION_GROUPS.map((g) => ({ value: g.id, label: g.label })),
  ], []);

  const load = useCallback(async (offset) => {
    const token = guard.begin();
    const bad = periodError(period, custom, { maxDays: MAX_DAYS });
    if (bad) { setRows(null); setError({ message: bad, canRetry: false, title: 'Check the dates' }); return; }
    setRunning(true); setError(null);
    try {
      const { fromIso, toIso } = resolvePeriod(period, custom);
      const r = await activityApi.list({
        fromIso, toIso, clientId: customerScope || null, actorUserId: person || null,
        group: group || null, offset, limit: PAGE,
      });
      if (!guard.isCurrent(token)) return;
      setTotal(r.total || 0);
      setScope(r.scope || (r.stub ? { stub: true } : null));
      setRows((prev) => (offset > 0 && prev ? [...prev, ...(r.entries || [])] : (r.entries || [])));
    } catch (e) {
      if (guard.isCurrent(token)) { setRows(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [period, custom, customerScope, person, group, guard]);

  const run = useCallback(() => load(0), [load]);

  const doExport = useCallback(async (format) => {
    setExporting(true); setError(null);
    try {
      const { fromIso, toIso } = resolvePeriod(period, custom);
      await activityApi.exportFile({ format, clientId: customerScope || null, fromIso, toIso });
    } catch (e) {
      setError({ message: reportErrorMessage(e), canRetry: false, title: 'Couldn’t build the export' });
    } finally { setExporting(false); }
  }, [period, custom, customerScope]);

  const columns = useMemo(() => [
    { key: 'when', label: 'When', nowrap: true, value: (r) => fmtStampIn(r.occurredAt, tz) },
    { key: 'who', label: 'Who', value: (r) => actorLabel(r, usersById) },
    { key: 'action', label: 'Action', nowrap: true, value: (r) => actionLabel(r.action) },
    {
      key: 'customer',
      label: 'Customer',
      // The row keeps the name it was written with; the roster's CURRENT name is what the
      // reader recognizes, so prefer it and fall back to the snapshot.
      value: (r) => (r.clientId ? ((clients || []).find((c) => c.id === r.clientId)?.name || r.clientName || '—') : '—'),
    },
    {
      key: 'what',
      label: 'What happened',
      value: (r) => r.summary,
      render: (r) => {
        const change = beforeAfterText(r, tz);
        return (
          <>
            <span>{r.summary}</span>
            {/* LOG-3's before/after, on its own line under the sentence. Layout-only inline
                style (the kit's own cells do the same for nowrap) — no new class, no colour. */}
            {change && <span className="text-muted text-xs" style={{ display: 'block' }}>{change}</span>}
          </>
        );
      },
    },
  ], [clients, tz, usersById]);

  const kpis = useMemo(() => {
    const list = rows || [];
    return {
      loaded: list.length,
      people: new Set(list.filter((r) => !r.auto).map((r) => r.actorUserId).filter(Boolean)).size,
      automatic: list.filter((r) => r.auto).length,
    };
  }, [rows]);

  const scopeNote = scopeMessage(scope);

  return (
    <>
      <FilterRow>
        <PeriodField period={period} onPeriod={(p) => { setPeriod(p); reset(); }} />
        {period === 'custom' && <DateRangeField custom={custom} onCustom={(c) => { setCustom(c); reset(); }} />}
        <CustomerFilter clients={clients} managerScope="" value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
        <SelectFilter label="Person" value={person} onChange={(v) => { setPerson(v); reset(); }} options={peopleOptions} />
        <SelectFilter label="Action type" value={group} onChange={(v) => { setGroup(v); reset(); }} options={groupOptions} />
      </FilterRow>

      <div className="reports-actions">
        <button type="button" className="btn btn-primary" onClick={run} disabled={running}>{running ? 'Running…' : 'Run report'}</button>
        {rows && rows.length > 0 && (
          <>
            <button type="button" className="btn btn-gold" onClick={() => doExport('csv')} disabled={exporting}>
              <Icon name="upload" size={15} /> Export spreadsheet
            </button>
            <button type="button" className="btn btn-outline" onClick={() => doExport('pdf')} disabled={exporting}>
              <Icon name="upload" size={15} /> Export PDF
            </button>
          </>
        )}
        {scopeNote && <span className="hint reports-run-note">{scopeNote}</span>}
      </div>

      <RunSurface
        rows={rows}
        running={running}
        error={error?.message}
        errorTitle={error?.title}
        onRetry={error?.canRetry ? run : undefined}
        empty={<NoRows title="Nothing recorded" message="No activity was recorded in this period for the selected criteria. Widen the period or clear the filters." />}
      >
        <KpiRow>
          <StatCard label="Entries in range" value={total} />
          <StatCard label="Shown" value={kpis.loaded} />
          <StatCard label="People involved" value={kpis.people} />
          <StatCard label="Automatic" value={kpis.automatic} />
        </KpiRow>
        <ResultsTable columns={columns} rows={rows || []} keyOf={(r) => r.id} />
        {rows && rows.length < total && (
          <div className="reports-actions">
            <button type="button" className="btn btn-outline" onClick={() => load(rows.length)} disabled={running}>
              {running ? 'Loading…' : `Load ${Math.min(PAGE, total - rows.length)} more`}
            </button>
          </div>
        )}
      </RunSurface>
    </>
  );
}

// What the server served, said plainly — so nobody mistakes a scoped view for the whole
// record. `visibility` comes from the route (LOG-4).
function scopeMessage(scope) {
  if (!scope) return null;
  if (scope.stub) return 'The activity log lives on the server — sign in to the connected app to read it.';
  if (scope.visibility === 'no-money') return 'Pay and money changes are hidden at your access level.';
  if (scope.visibility === 'supervised') {
    return scope.customers === 0
      ? 'You supervise no customers yet, so there is nothing here.'
      : `Showing the ${scope.customers} customer${scope.customers === 1 ? '' : 's'} you supervise.`;
  }
  return null;
}
