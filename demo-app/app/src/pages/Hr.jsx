// HR — employee records, special-service pay, reimbursements, PTO, warnings, incident reports and
// terminations. One page, seven in-page tabs (the plain §7 segmented control, NOT the payroll layout picker). The
// tab lives in ?tab= so a view is shareable. Gated hr.view at the route; edit actions
// inside are gated hr.edit. Compensation-touching entries feed the pay run. Warnings (Matt's
// HR-1..HR-5), Incidents (task #258, Matt's incident report form, set up like Warnings) and
// Terminations (Super Clippy's idea #513, Matt's termination form, which turns the person's login
// off on its day) are written on the translation catalog, so their labels are catalog lines (`labelKey`) where the
// four older tabs still carry English.
import { useSearchParams } from 'react-router-dom';
import EmployeesTab from './hr/EmployeesTab';
import SpecialServicesTab from './hr/SpecialServicesTab';
import ReimbursementsTab from './hr/ReimbursementsTab';
import PtoTab from './hr/PtoTab';
import WarningsTab from './hr/WarningsTab';
import IncidentsTab from './hr/IncidentsTab';
import TerminationsTab from './hr/TerminationsTab';
import { useT } from '../i18n/react';

const TABS = [
  { key: 'employees', label: 'Employees', Cmp: EmployeesTab },
  { key: 'special', label: 'Special services', Cmp: SpecialServicesTab },
  { key: 'reimbursements', label: 'Reimbursements', Cmp: ReimbursementsTab },
  { key: 'pto', label: 'PTO', Cmp: PtoTab },
  { key: 'warnings', labelKey: 'hrWarn.tab', Cmp: WarningsTab },
  { key: 'incidents', labelKey: 'hrInc.tab', Cmp: IncidentsTab },
  { key: 'terminations', labelKey: 'hrTerm.tab', Cmp: TerminationsTab },
];
const DEFAULT_TAB = 'employees';

export default function Hr() {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab = TABS.some((x) => x.key === raw) ? raw : DEFAULT_TAB;
  const setTab = (k) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (k === DEFAULT_TAB) next.delete('tab'); else next.set('tab', k);
    return next;
  }, { replace: true });

  const Active = (TABS.find((x) => x.key === tab) || TABS[0]).Cmp;

  return (
    <div className="hr-page">
      <div className="page-head-text">
        <h1 className="page-head-title">HR</h1>
        <p className="hr-sub">Employees, special services, reimbursements, PTO, warnings, incidents &amp; terminations</p>
      </div>
      <div className="hr-tabs">
        <div className="tab-container tab-container-line">
          {TABS.map((tb) => (
            <button key={tb.key} type="button" className={`tab-btn ${tab === tb.key ? 'active' : ''}`} onClick={() => setTab(tb.key)}>{tb.labelKey ? t(tb.labelKey) : tb.label}</button>
          ))}
        </div>
      </div>
      <Active />
    </div>
  );
}
