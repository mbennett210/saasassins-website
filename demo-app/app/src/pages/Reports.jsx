// Reports — the run-and-export hub. A segmented report picker over a full-width
// results surface (the app report idiom; matches Variance). EVERY report runs INLINE
// with its own criteria — none of them punt you to another tab. Each report body is
// its own component under pages/reports/ (self-contained: filters → Run → KPI tiles →
// table → CSV). Gated by reports.view (owner / admin / manager).
import { useSearchParams } from 'react-router-dom';
import AttendanceReport from './reports/AttendanceReport';
import CalledOutReport from './reports/CalledOutReport';
import InspectionsReport from './reports/InspectionsReport';
import ChecklistsReport from './reports/ChecklistsReport';
import HoursReport from './reports/HoursReport';

const REPORTS = [
  { id: 'not-clocked', tab: 'Not clocked in / out', desc: 'Scheduled cleaners who missed a clock-in or clock-out for a chosen day — judged as of now, so cleans still ahead or underway aren’t counted as missed.', Component: AttendanceReport },
  { id: 'called-out', tab: 'Called out', desc: 'Cleaners who called out of a day’s shift (time off booked as a Call-out), the cleans they called out of, and which of those now have no crew.', Component: CalledOutReport },
  { id: 'inspections', tab: 'Inspections / site', desc: 'Scored supervisor inspections per account over a date range — pass/fail and average score.', Component: InspectionsReport },
  { id: 'checklists', tab: 'Checklists / site', desc: 'Nightly crew checklists completed per account over a date range, and how thoroughly.', Component: ChecklistsReport },
  { id: 'hours', tab: 'Hours by cleaner', desc: 'Regular / OT / total hours per cleaner over any date range, computed like the Payroll run (weekly-40h overtime on full weeks, paid drive included).', Component: HoursReport },
];

const DEFAULT_REPORT = 'not-clocked';

export default function Reports() {
  // The selected report lives in ?r= (the canonical two-way pattern, cf. Hr.jsx) so global
  // search can deep-link a specific report; the default drops the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('r');
  const selectedId = REPORTS.some((r) => r.id === raw) ? raw : DEFAULT_REPORT;
  const setSelectedId = (id) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === DEFAULT_REPORT) next.delete('r'); else next.set('r', id);
    return next;
  }, { replace: true });
  const selected = REPORTS.find((r) => r.id === selectedId) || REPORTS[0];
  const Body = selected.Component;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="page-sub">Run and export the reports your team needs — right here. Pick a report, set its criteria, then run or export.</p>
        </div>
      </div>

      {/* Report picker — the app's segmented rail (matches Variance's report/period tabs). */}
      <div className="tab-container-line reports-tabs" role="group" aria-label="Report">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`tab-btn ${r.id === selectedId ? 'active' : ''}`}
            onClick={() => setSelectedId(r.id)}
          >
            {r.tab}
          </button>
        ))}
      </div>
      <p className="reports-desc text-muted text-sm">{selected.desc}</p>

      {/* Remount per report so switching tabs starts each one fresh. */}
      <Body key={selected.id} />
    </div>
  );
}
