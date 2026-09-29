// Shared building blocks for the Reports hub's inline reports — so every report
// (attendance, called out, inspections, checklists, hours) uses the SAME filter bar,
// searchable filter selects, org-zone periods, KPI tiles, table, error state and CSV,
// and reads like one surface. Filters use the app's real filter-bar primitives:
// `.filter-bar` + <FormField> + the searchable <FilterSelect> (same as Clients.jsx), so
// they conform in size and behavior. Every report reads its data COMPLETELY for the
// chosen window (timeApi.rollup / entriesAll, qcApi.*BySite) and shows a failed or
// incomplete read as an error, never as an empty result.
import { useMemo, useRef } from 'react';
import Icon from '../../components/Icon';
import EmptyState from '../../components/EmptyState';
import FormField from '../../components/FormField';
import FilterSelect from '../../components/FilterSelect';
import ListPager from '../../components/ListPager';
import usePagedRows from '../../hooks/usePagedRows';
import { useStore } from '../../store';
import { useAuth } from '../../hooks/useAuth';
import { SUPERVISOR_ROLES } from '../../lib/roles';
import { todayKey, addDaysKey, diffDaysKey, startOfDayKey, startOfMonthKey } from '../../lib/dates';

// Shared scope for every report: the account supervisors (Manager filter), the
// customers (Customer filter), the current user's default scope, and id→entity maps.
export function useReportScope() {
  const state = useStore();
  const { currentUser } = useAuth();
  const managers = useMemo(
    () => (state.users || []).filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)),
    [state.users],
  );
  const iSupervise = useMemo(
    () => (state.clients || []).some((c) => c.supervisorId === currentUser?.id),
    [state.clients, currentUser],
  );
  const clientsById = useMemo(() => new Map((state.clients || []).map((c) => [c.id, c])), [state.clients]);
  const sitesById = useMemo(() => new Map((state.sites || []).map((s) => [s.id, s])), [state.sites]);
  return { state, currentUser, clients: state.clients || [], managers, iSupervise, clientsById, sitesById };
}

// ── Date-range periods (the range-based reports). Attendance + Called out own a
//    Today/Yesterday day-picker instead (dayWindow below). ALL calendar math is in the
//    ORG's timezone (lib/dates — playbook II.8), the same days the schedule and payroll
//    use: device-local days made "today" disagree with the rest of the app for anyone
//    whose device isn't in the company's zone. ──
export const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'mtd', label: 'Month' },
  { value: 'custom', label: 'Custom' },
];

const endOfDayMs = (key) => startOfDayKey(addDaysKey(key, 1)).getTime() - 1;

// Resolve a period pill (+ custom {from,to} day-keys) into the org-zone window:
// { fromKey, toKey, fromMs, toMs, fromIso, toIso }. A rolling preset ends NOW; a custom
// range ends at the close of its last day. Check periodError() first for a custom range.
export function resolvePeriod(period, custom = {}, now = new Date()) {
  const today = todayKey();
  let fromKey = today;
  let toKey = today;
  let toMs = now.getTime();
  switch (period) {
    case '7d': fromKey = addDaysKey(today, -6); break;
    case '90d': fromKey = addDaysKey(today, -89); break;
    case 'mtd': fromKey = startOfMonthKey(today); break;
    case 'custom':
      fromKey = custom.from || today;
      toKey = custom.to || today;
      toMs = endOfDayMs(toKey);
      break;
    case '30d':
    default: fromKey = addDaysKey(today, -29);
  }
  const fromMs = startOfDayKey(fromKey).getTime();
  return { fromKey, toKey, fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}

// A custom range must name both days, run forward and fit the report's reach — a blank
// "from" used to mean ALL TIME, a scan no report should start by accident.
export function periodError(period, custom = {}, { maxDays = 366 } = {}) {
  if (period !== 'custom') return null;
  if (!custom.from || !custom.to) return 'Pick both a start and an end date.';
  if (custom.to < custom.from) return 'The end date is before the start date.';
  if (diffDaysKey(custom.from, custom.to) + 1 > maxDays) return `Pick a range of ${maxDays} days or fewer.`;
  return null;
}

// What Custom starts on: the last 30 days, so it is never blank.
export function defaultCustomRange() {
  const today = todayKey();
  return { from: addDaysKey(today, -29), to: today };
}

// One org-zone calendar day, `offset` days from today (0 = today, -1 = yesterday):
// { dayKey, fromMs, toMs, fromIso, toIso }.
export function dayWindow(offset = 0) {
  const key = addDaysKey(todayKey(), offset);
  const fromMs = startOfDayKey(key).getTime();
  const toMs = endOfDayMs(key);
  return { dayKey: key, fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}

export function StatCard({ label, value, tone }) {
  return (
    <div className={`stat-card${tone ? ` tone-${tone}` : ''}`}>
      <div className="stat-val">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// ── Filter primitives — all sit inside <FilterRow> (the app's .filter-bar). ──
export const FilterRow = ({ children }) => <div className="filter-bar">{children}</div>;

// A segmented Today/Yesterday day picker (attendance).
export function DayField({ dayOffset, onDay }) {
  return (
    <FormField label="Day">
      <div className="tab-container-line reports-pills" role="group" aria-label="Day">
        <button type="button" className={`tab-btn ${dayOffset === 0 ? 'active' : ''}`} onClick={() => onDay(0)}>Today</button>
        <button type="button" className={`tab-btn ${dayOffset === -1 ? 'active' : ''}`} onClick={() => onDay(-1)}>Yesterday</button>
      </div>
    </FormField>
  );
}

// The date-range period pills (range reports). Custom range renders via <DateRangeField>.
export function PeriodField({ period, onPeriod }) {
  return (
    <FormField label="Period">
      <div className="tab-container-line reports-pills" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.value} type="button" className={`tab-btn ${period === p.value ? 'active' : ''}`} onClick={() => onPeriod(p.value)}>{p.label}</button>
        ))}
      </div>
    </FormField>
  );
}

export function DateRangeField({ custom, onCustom }) {
  return (
    <FormField label="Date range">
      <div className="facet-daterange-custom reports-daterange">
        <input type="date" className="input" aria-label="From" value={custom.from || ''} onChange={(e) => onCustom({ ...custom, from: e.target.value })} />
        <span className="facet-daterange-sep" aria-hidden>–</span>
        <input type="date" className="input" aria-label="To" value={custom.to || ''} onChange={(e) => onCustom({ ...custom, to: e.target.value })} />
      </div>
    </FormField>
  );
}

// Searchable Manager (account-supervisor) filter — the app's FilterSelect.
export function ManagerFilter({ managers, currentUser, value, onChange }) {
  const options = useMemo(() => [
    { value: '', label: 'All managers' },
    ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? `${m.name} (me)` : m.name })),
  ], [managers, currentUser]);
  return <FormField label="Manager"><FilterSelect ariaLabel="Manager" value={value} onChange={onChange} options={options} /></FormField>;
}

// Searchable Customer filter — clients, optionally narrowed to a manager's book.
export function CustomerFilter({ clients, managerScope, value, onChange }) {
  const options = useMemo(() => [
    { value: '', label: 'All customers' },
    ...(clients || [])
      .filter((c) => !managerScope || c.supervisorId === managerScope)
      .map((c) => ({ value: c.id, label: c.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ], [clients, managerScope]);
  return <FormField label="Customer"><FilterSelect ariaLabel="Customer" value={value} onChange={onChange} options={options} /></FormField>;
}

// A plain searchable single-select filter (Result, Include, …).
export function SelectFilter({ label, value, onChange, options }) {
  return <FormField label={label}><FilterSelect ariaLabel={label} value={value} onChange={onChange} options={options} /></FormField>;
}

// KPI tile row + actions row wrappers (shared spacing/markup).
export const KpiRow = ({ children }) => <div className="stat-grid reports-stats">{children}</div>;

// The run button + CSV export, shared across reports.
export function RunActions({ running, hasRows, onRun, onExport, note }) {
  return (
    <div className="reports-actions">
      <button className="btn btn-primary" onClick={onRun} disabled={running}>{running ? 'Running…' : 'Run report'}</button>
      {hasRows && <button className="btn btn-gold" onClick={onExport}><Icon name="upload" size={15} /> Export CSV</button>}
      {note && <span className="hint reports-run-note">{note}</span>}
    </div>
  );
}

// The result-area state machine: not-run hint → running → error → empty → the table.
// A failed or incomplete read is an ERROR with a retry, never an empty result — "no
// inspections this period" and "we couldn't read the inspections" must not look alike.
export function RunSurface({ rows, running, error, errorTitle, onRetry, empty, children }) {
  if (running && rows === null) return <div className="card reports-body-card">Running…</div>;
  if (error) {
    return (
      <EmptyState
        icon={<Icon name="warning" size={28} />}
        title={errorTitle || 'Couldn’t run this report'}
        message={error}
        action={onRetry ? <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button> : null}
      />
    );
  }
  if (rows === null) return <p className="text-muted text-sm reports-hint">Set the criteria above and click <b>Run report</b>.</p>;
  if (rows.length === 0) return empty;
  return children;
}

// The message a thrown read error should show the manager, and whether "Try again" can
// help: a 4xx is the server refusing the request (too wide a range, no permission) —
// retrying can't change that — except 408 / 429, which are transient.
export const reportErrorMessage = (e) => (e && e.message) || 'The report could not be loaded. Check your connection and try again.';
export const canRetryError = (e) => !(e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);

// Stale-run guard. A run takes seconds at full volume (several paged requests) and the
// filters stay editable meanwhile: without this, changing a filter cleared the table,
// then the OLD run finished and filled it with results for the old criteria under the
// new labels — and Export CSV exported them. begin() before a run; apply its result only
// while isCurrent(token); invalidate() whenever the criteria change.
export function useRunGuard() {
  const seq = useRef(0);
  return useMemo(() => ({
    begin: () => { seq.current += 1; return seq.current; },
    isCurrent: (token) => token === seq.current,
    invalidate: () => { seq.current += 1; },
  }), []);
}

// A column-driven results table. Each column: { key, label, value(row)->text|number
// (used for CSV + default cell), render?(row)->node (rich cell), nowrap? }. The first
// column is the row's primary cell; the rest carry data-label for the mobile stack.
export function ResultsTable({ columns, rows, keyOf }) {
  // Cap the rendered rows at 20 (UI_RULES §50 / lint:tables): a report can return a
  // long period's worth of rows. CSV export uses the full `rows` separately, so it is
  // unaffected. resetKey is the rows reference, so a fresh Run snaps back to page 1.
  const pager = usePagedRows(rows, { resetKey: rows });
  return (
    <div className="table-wrap mobile-stack">
      <table>
        <thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {pager.pageRows.map((row) => (
            <tr key={keyOf(row)}>
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={i === 0 ? 'cell-primary' : undefined}
                  data-label={i === 0 ? undefined : c.label}
                  style={c.nowrap ? { whiteSpace: 'nowrap' } : undefined}
                >
                  {c.render ? c.render(row) : c.value(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ListPager pager={pager} noun="results" />
    </div>
  );
}

// CSV from the same column specs (uses column.value for text). Triggers a download.
// A text cell a spreadsheet would run as a FORMULA (leading =, +, -, @, tab or CR) is
// prefixed with ' — free-text fields (a call-out reason, a name) go straight into Excel.
// Numbers are written as numbers (a negative stays a negative).
export function csvCell(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
export function downloadReportCsv(filename, columns, rows) {
  const esc = (v) => `"${csvCell(v).replace(/"/g, '""')}"`;
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(c.value(row))).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Shared empty-state for a range report that found nothing.
export function NoRows({ title, message }) {
  return <EmptyState icon={<Icon name="chart" size={28} />} title={title} message={message} />;
}
