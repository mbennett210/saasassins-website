// Reports — the run-and-export hub. A segmented report picker over a full-width
// results surface (the app report idiom; matches Variance). EVERY report runs INLINE
// with its own criteria — none of them punt you to another tab. Each report body is
// its own component under pages/reports/ (self-contained: filters → Run → KPI tiles →
// table → CSV). Gated by reports.view (owner / admin / manager / supply manager); EVERY report
// names the key its read needs (`perm`) and is listed only for those who hold it — so a supply
// manager's Reports is Supply usage alone (S131), and nobody is shown a report whose read would
// refuse them. The called-out report reads the schedule, and sits with attendance (time.view).
//
// An entry's words: `tab` / `desc` in English (the older reports, not yet converted — LANG-1),
// or `tabKey` / `descKey`, catalog lines shown in the reader's language (UI_RULES §140).
// `office` (QR-30, 2026-10-17): listed only for an office role, whatever a per-user grant says —
// the route refuses anyone else (EP-416), so nobody is shown a report that would refuse them.
import { useSearchParams } from 'react-router-dom';
import { useT } from '../i18n/react';
import { usePermissionChecker } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { isOfficeRole } from '../lib/roles';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import AttendanceReport from './reports/AttendanceReport';
import CalledOutReport from './reports/CalledOutReport';
import InspectionsReport from './reports/InspectionsReport';
import ChecklistsReport from './reports/ChecklistsReport';
import ResolveTimeReport from './reports/ResolveTimeReport';
import HoursReport from './reports/HoursReport';
import SupplyUsageReport from './reports/SupplyUsageReport';
import ActivityLogReport from './reports/ActivityLogReport';
import VisitorRatingsReport from './reports/VisitorRatingsReport';

const REPORTS = [
  { id: 'not-clocked', tab: 'Not clocked in / out', desc: 'Scheduled cleaners who missed a clock-in or clock-out for a chosen day — judged as of now, so cleans still ahead or underway aren’t counted as missed.', perm: 'time.view', Component: AttendanceReport },
  { id: 'called-out', tab: 'Called out', desc: 'Cleaners who called out of a day’s shift (time off booked as a Call-out), the cleans they called out of, and which of those now have no crew.', perm: 'time.view', Component: CalledOutReport },
  { id: 'inspections', tab: 'Inspections / site', desc: 'Scored supervisor inspections per account over a date range — pass/fail and average score.', perm: 'qc.view', Component: InspectionsReport },
  { id: 'checklists', tab: 'Checklists / site', desc: 'Nightly crew checklists completed per account over a date range, and how thoroughly.', perm: 'qc.view', Component: ChecklistsReport },
  // Matt's KPI (the Oct 6 call): how long a ticket takes from opened to closed. Its route needs
  // qc.view as well as reports.view (EP-360), so it is listed only for a holder of both.
  { id: 'resolve-time', tabKey: 'resolveTime.report.tab', descKey: 'resolveTime.report.desc', perm: 'qc.view', Component: ResolveTimeReport },
  // QR-30 (Matt, 2026-10-16): the visitors' thumbs on QR-coded areas, by building — "only the office
  // sees the results". The route's door is the Reports key, qc.view and an office role (EP-416).
  { id: 'visitor-ratings', tabKey: 'visitorRatings.report.tab', descKey: 'visitorRatings.report.desc', perm: 'qc.view', office: true, Component: VisitorRatingsReport },
  { id: 'hours', tab: 'Hours by cleaner', desc: 'Regular / OT / total hours per cleaner over any date range, computed like the Payroll run (weekly-40h overtime on full weeks, paid drive included).', perm: 'variance.view', Component: HoursReport },
  // SUP-5 / CS-191 (Matt, 2026-09-29): "how many boxes of toilet paper in 30 days". Counted on
  // DELIVERY, so a request still waiting for approval or for the office is not in it.
  { id: 'supply-usage', tab: 'Supply usage', desc: 'Quantities and spend per supply item for a building over a period — counted the day each request was delivered (marked completed), not when it was asked for.', perm: 'supplies.view', Component: SupplyUsageReport },
  // CS-379 — the activity log lives here rather than in the sidebar (no new nav item): it is
  // a record you run over a period, like every other report. What it serves is scoped on the
  // server by access level (LOG-4), which the report states on screen.
  { id: 'activity', tab: 'Activity log', desc: 'Who did what and when — schedule changes, time edits, inspections, tickets, supplies, pay and access changes, and the alerts the system sent by itself. Kept for three years and never editable.', perm: 'activity.view', Component: ActivityLogReport },
];

const DEFAULT_REPORT = 'not-clocked';

export default function Reports() {
  const t = useT();
  const can = usePermissionChecker();
  const { currentUser } = useAuth();
  const reports = REPORTS.filter((r) => (!r.perm || can(r.perm)) && (!r.office || isOfficeRole(currentUser?.role)));
  const tabOf = (r) => (r.tabKey ? t(r.tabKey) : r.tab);
  const descOf = (r) => (r.descKey ? t(r.descKey) : r.desc);
  // The selected report lives in ?r= (the canonical two-way pattern, cf. Hr.jsx) so global
  // search can deep-link a specific report; the default drops the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('r');
  // The default when ?r= names none the viewer may run: the usual first report, else their first.
  const fallbackId = reports.some((r) => r.id === DEFAULT_REPORT) ? DEFAULT_REPORT : (reports[0]?.id || DEFAULT_REPORT);
  const selectedId = reports.some((r) => r.id === raw) ? raw : fallbackId;
  const setSelectedId = (id) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === fallbackId) next.delete('r'); else next.set('r', id);
    return next;
  }, { replace: true });
  const selected = reports.find((r) => r.id === selectedId) || null;
  const Body = selected ? selected.Component : null;

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
        {reports.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`tab-btn ${r.id === selectedId ? 'active' : ''}`}
            onClick={() => setSelectedId(r.id)}
          >
            {tabOf(r)}
          </button>
        ))}
      </div>
      {selected ? (
        <>
          <p className="reports-desc text-muted text-sm">{descOf(selected)}</p>
          {/* Remount per report so switching tabs starts each one fresh. */}
          <Body key={selected.id} />
        </>
      ) : (
        <EmptyState icon={<Icon name="chart" size={28} />} title={t('reportKit.noReports')} message={t('reportKit.noReportsHint')} />
      )}
    </div>
  );
}
