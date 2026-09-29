// "Not clocked in / out" — scheduled cleans cross-referenced against punches for a
// day (today / yesterday, the org's calendar day). Reads EVERY punch around the day
// (timeApi.entriesAll — a complete, paged read) and judges each (cleaner, clean) at the
// moment the report runs via the pure lib/attendanceReport engine: a clean that hasn't
// started is "Not started", a cleaner still inside their shift is "On the clock", and a
// punch the auto-close cron finished counts as a missing clock-out.
import { useCallback, useMemo, useState } from 'react';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import EmptyState from '../../components/EmptyState';
import { fmtTime } from '../../lib/dates';
import * as timeApi from '../../lib/timeApi';
import {
  computeAttendanceReport, ATT_COMPLETE, ATT_MISSING_OUT, ATT_NO_PUNCH, ATT_ON_CLOCK, ATT_UPCOMING, ATT_OFF,
  ATT_INCOMPLETE,
} from '../../lib/attendanceReport';
import { OPS_ALERT_DEFAULTS } from '../../lib/opsAlerts';
import {
  useReportScope, DayField, ManagerFilter, CustomerFilter, FilterRow, RunActions,
  KpiRow, StatCard, RunSurface, ResultsTable, downloadReportCsv, dayWindow, reportErrorMessage,
  canRetryError, useRunGuard,
} from './reportKit';

const STATUS_BADGE = {
  [ATT_COMPLETE]: ['green', 'Complete'],
  [ATT_MISSING_OUT]: ['amber', 'Missing clock-out'],
  [ATT_NO_PUNCH]: ['red', 'No punch'],
  [ATT_ON_CLOCK]: ['blue', 'On the clock'],
  [ATT_UPCOMING]: ['slate', 'Not started'],
};
const statusBadge = (r) => {
  if (r.status === ATT_OFF) return ['slate', r.offKind === 'planned' ? 'Time off' : 'Called out'];
  return STATUS_BADGE[r.status] || ['slate', r.status];
};

// Punches are fetched around the day, not just inside it: a clean is matched to its punch
// by job id, and a night clean can be clocked into early or after midnight.
const PAD_BEFORE_MS = 12 * 3600 * 1000;
const PAD_AFTER_MS = 18 * 3600 * 1000;

const clockOutText = (r) => (r.clockOutAt ? `${fmtTime(r.clockOutAt)}${r.autoClosed ? ' (auto)' : ''}` : '—');

const COLUMNS = [
  { key: 'cleaner', label: 'Cleaner', value: (r) => r.userName },
  { key: 'customer', label: 'Customer', value: (r) => r.clientName || r.siteName || '—' },
  { key: 'scheduled', label: 'Scheduled', nowrap: true, value: (r) => (r.scheduledStart ? fmtTime(r.scheduledStart) : '—') },
  {
    key: 'inout', label: 'Clock in / out', nowrap: true,
    value: (r) => `${r.clockInAt ? fmtTime(r.clockInAt) : '—'} / ${clockOutText(r)}`,
    render: (r) => (
      <>
        {r.clockInAt ? fmtTime(r.clockInAt) : <span className="text-muted">—</span>}
        {' / '}
        {r.clockOutAt ? clockOutText(r) : <span className="text-muted">—</span>}
      </>
    ),
  },
  {
    key: 'status', label: 'Status',
    value: (r) => statusBadge(r)[1],
    render: (r) => { const [v, l] = statusBadge(r); return <Badge variant={v}>{l}</Badge>; },
  },
];

export default function AttendanceReport() {
  const { state, currentUser, clients, managers, iSupervise, clientsById, sitesById } = useReportScope();
  const [dayOffset, setDayOffset] = useState(0);
  const [managerScope, setManagerScope] = useState(() => (iSupervise ? currentUser?.id : ''));
  const [customerScope, setCustomerScope] = useState('');
  const [rows, setRows] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const guard = useRunGuard();
  const reset = () => { guard.invalidate(); setRows(null); setError(null); setRunning(false); };
  const grace = state.opsSettings?.lateAlertGraceMins ?? OPS_ALERT_DEFAULTS.lateAlertGraceMins;

  const run = useCallback(async () => {
    const token = guard.begin();
    setRunning(true); setError(null);
    try {
      const day = dayWindow(dayOffset);
      const punches = await timeApi.entriesAll({
        fromIso: new Date(day.fromMs - PAD_BEFORE_MS).toISOString(),
        toIso: new Date(day.toMs + PAD_AFTER_MS).toISOString(),
        lite: true,
      });
      const usersById = new Map((state.users || []).map((u) => [u.id, u]));
      let out = computeAttendanceReport({
        jobs: state.jobs || [], timeEntries: punches, usersById, clientsById, sitesById,
        fromMs: day.fromMs, toMs: day.toMs, managerId: managerScope || null,
        now: Date.now(), graceMins: grace, timeOff: state.timeOff || [],
      });
      if (customerScope) out = out.filter((row) => row.clientId === customerScope);
      if (guard.isCurrent(token)) setRows(out);
    } catch (e) {
      if (guard.isCurrent(token)) { setRows(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [dayOffset, managerScope, customerScope, state.users, state.jobs, state.timeOff, clientsById, sitesById, grace, guard]);

  const counts = useMemo(() => {
    const r = rows || [];
    const c = { scheduled: r.length, complete: 0, missingOut: 0, noPunch: 0, notDue: 0, off: 0 };
    for (const row of r) {
      if (row.status === ATT_COMPLETE) c.complete += 1;
      else if (row.status === ATT_MISSING_OUT) c.missingOut += 1;
      else if (row.status === ATT_NO_PUNCH) c.noPunch += 1;
      else if (row.status === ATT_OFF) c.off += 1;
      else c.notDue += 1; // on the clock / not started
    }
    c.incomplete = c.missingOut + c.noPunch;
    return c;
  }, [rows]);
  const visibleRows = useMemo(
    () => (showAll ? (rows || []) : (rows || []).filter((r) => ATT_INCOMPLETE.has(r.status))),
    [rows, showAll],
  );

  return (
    <>
      <FilterRow>
        <DayField dayOffset={dayOffset} onDay={(d) => { setDayOffset(d); reset(); }} />
        <ManagerFilter managers={managers} currentUser={currentUser} value={managerScope} onChange={(v) => { setManagerScope(v); setCustomerScope(''); reset(); }} />
        <CustomerFilter clients={clients} managerScope={managerScope} value={customerScope} onChange={(v) => { setCustomerScope(v); reset(); }} />
      </FilterRow>

      <RunActions running={running} hasRows={rows && rows.length > 0} onRun={run} onExport={() => downloadReportCsv(`attendance-${dayWindow(dayOffset).dayKey}.csv`, COLUMNS, visibleRows)} />

      <RunSurface rows={rows} running={running} error={error?.message} onRetry={error?.canRetry ? run : undefined} empty={<EmptyState icon={<Icon name="check" size={28} />} title="No cleans scheduled" message="No cleans were scheduled in this view, so there's nothing to check." />}>
        <KpiRow>
          <StatCard label="Scheduled" value={counts.scheduled} />
          <StatCard label="Complete" value={counts.complete} tone={counts.complete > 0 ? 'success' : null} />
          <StatCard label="Missing clock-out" value={counts.missingOut} tone={counts.missingOut > 0 ? 'warn' : null} />
          <StatCard label="No punch" value={counts.noPunch} tone={counts.noPunch > 0 ? 'danger' : null} />
          <StatCard label="Not due yet" value={counts.notDue} />
        </KpiRow>
        <div className="reports-summary">
          <div className="tab-container-line reports-viewtoggle" role="group" aria-label="Which cleans to show">
            <button type="button" className={`tab-btn ${!showAll ? 'active' : ''}`} onClick={() => setShowAll(false)}>Incomplete · {counts.incomplete}</button>
            <button type="button" className={`tab-btn ${showAll ? 'active' : ''}`} onClick={() => setShowAll(true)}>All scheduled · {counts.scheduled}</button>
          </div>
          <span className="text-muted text-sm">
            Showing {visibleRows.length} of {counts.scheduled} scheduled clean{counts.scheduled === 1 ? '' : 's'}
            {counts.off > 0 ? ` · ${counts.off} booked off (call-outs are on Called out)` : ''}
          </span>
        </div>
        {visibleRows.length === 0 ? (
          <EmptyState
            icon={<Icon name="check" size={28} />}
            title="All clear"
            message={[
              'No one has missed a clock-in or clock-out.',
              counts.notDue > 0 ? 'Cleans that haven’t started or are still underway aren’t counted yet.' : '',
              counts.off > 0 ? `${counts.off} scheduled ${counts.off === 1 ? 'cleaner was' : 'cleaners were'} booked off.` : '',
              'Switch to “All scheduled” to see every clean.',
            ].filter(Boolean).join(' ')}
          />
        ) : (
          <ResultsTable columns={COLUMNS} rows={visibleRows} keyOf={(r) => `${r.jobId}-${r.userId}`} />
        )}
      </RunSurface>
    </>
  );
}
