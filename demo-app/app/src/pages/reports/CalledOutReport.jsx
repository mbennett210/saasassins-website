// "Called out" — cleaners who called out of a day's shift (today / yesterday): a
// CALL-OUT time-off entry covering that day (Team › Time off or HR › PTO, type
// "Call-out" — planned time off is not listed), with the cleans they called out of,
// including the ones the booking took them off, and which of those now have no crew.
// Runs off state.timeOff + state.jobs via the pure lib/reports/calledOut engine.
import { useCallback, useMemo, useState } from 'react';
import Badge from '../../components/Badge';
import { calledOutOn } from '../../lib/reports/calledOut';
import {
  useReportScope, DayField, ManagerFilter, CustomerFilter, FilterRow, RunActions,
  KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv, NoRows, dayWindow,
} from './reportKit';

const COLUMNS = [
  { key: 'cleaner', label: 'Cleaner', value: (r) => r.userName },
  { key: 'reason', label: 'Reason', value: (r) => r.reason || '—' },
  { key: 'cust', label: 'Called out of', value: (r) => r.customers.join(', ') || '—' },
  { key: 'cleans', label: 'Cleans', value: (r) => r.cleanCount },
  {
    key: 'nocrew', label: 'No crew now', value: (r) => r.uncoveredCount,
    render: (r) => (r.uncoveredCount > 0 ? <Badge variant="red">{r.uncoveredCount}</Badge> : <span className="text-muted">0</span>),
  },
];

export default function CalledOutReport() {
  const { state, currentUser, clients, managers, iSupervise, clientsById, sitesById } = useReportScope();
  const [dayOffset, setDayOffset] = useState(0);
  const [managerScope, setManagerScope] = useState(() => (iSupervise ? currentUser?.id : ''));
  const [customerScope, setCustomerScope] = useState('');
  const [rows, setRows] = useState(null);
  const [running, setRunning] = useState(false);
  const reset = () => setRows(null);

  const run = useCallback(() => {
    setRunning(true);
    const usersById = new Map((state.users || []).map((u) => [u.id, u]));
    setRows(calledOutOn({
      timeOff: state.timeOff || [], jobs: state.jobs || [], usersById, clientsById, sitesById,
      dayKey: dayWindow(dayOffset).dayKey, managerId: managerScope || null, clientId: customerScope || null,
    }));
    setRunning(false);
  }, [state.users, state.timeOff, state.jobs, clientsById, sitesById, dayOffset, managerScope, customerScope]);

  // Cleans are counted ONCE each — two cleaners calling out of the same clean is one
  // clean affected, not two.
  const kpis = useMemo(() => {
    const r = rows || [];
    const cleans = new Set();
    const uncovered = new Set();
    for (const row of r) {
      for (const c of row.cleans) {
        cleans.add(c.jobId);
        if (c.uncovered) uncovered.add(c.jobId);
      }
    }
    return { count: r.length, cleans: cleans.size, uncovered: uncovered.size };
  }, [rows]);

  return (
    <>
      <FilterRow>
        <DayField dayOffset={dayOffset} onDay={(d) => { setDayOffset(d); reset(); }} />
        <ManagerFilter managers={managers} currentUser={currentUser} value={managerScope} onChange={(v) => { setManagerScope(v); setCustomerScope(''); reset(); }} />
        <CustomerFilter clients={clients} managerScope={managerScope} value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
      </FilterRow>

      <RunActions running={running} hasRows={rows && rows.length > 0} onRun={run} onExport={() => downloadReportCsv(`called-out-${dayWindow(dayOffset).dayKey}.csv`, COLUMNS, rows)} />

      <RunSurface rows={rows} running={running} empty={<NoRows title="No call-outs" message="No cleaners called out for the selected day. A call-out is time off booked as a Call-out (Team › Time off, or HR › PTO); planned time off isn't listed here." />}>
        <KpiRow>
          <StatCard label="Called out" value={kpis.count} tone={kpis.count > 0 ? 'danger' : null} />
          <StatCard label="Cleans affected" value={kpis.cleans} tone={kpis.cleans > 0 ? 'warn' : null} />
          <StatCard label="Cleans with no crew" value={kpis.uncovered} tone={kpis.uncovered > 0 ? 'danger' : null} />
        </KpiRow>
        <ResultsTable columns={COLUMNS} rows={rows || []} keyOf={(r) => r.userId} />
      </RunSurface>
    </>
  );
}
