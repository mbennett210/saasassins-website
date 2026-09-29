// HR — employee records, special-service pay, reimbursements & PTO. One page, four
// in-page tabs (the plain §7 segmented control, NOT the payroll layout picker). The
// tab lives in ?tab= so a view is shareable. Gated hr.view at the route; edit actions
// inside are gated hr.edit. Compensation-touching entries feed the pay run.
import { useSearchParams } from 'react-router-dom';
import EmployeesTab from './hr/EmployeesTab';
import SpecialServicesTab from './hr/SpecialServicesTab';
import ReimbursementsTab from './hr/ReimbursementsTab';
import PtoTab from './hr/PtoTab';

const TABS = [
  { key: 'employees', label: 'Employees', Cmp: EmployeesTab },
  { key: 'special', label: 'Special services', Cmp: SpecialServicesTab },
  { key: 'reimbursements', label: 'Reimbursements', Cmp: ReimbursementsTab },
  { key: 'pto', label: 'PTO', Cmp: PtoTab },
];
const DEFAULT_TAB = 'employees';

export default function Hr() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab = TABS.some((t) => t.key === raw) ? raw : DEFAULT_TAB;
  const setTab = (k) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (k === DEFAULT_TAB) next.delete('tab'); else next.set('tab', k);
    return next;
  }, { replace: true });

  const Active = (TABS.find((t) => t.key === tab) || TABS[0]).Cmp;

  return (
    <div className="hr-page">
      <div className="page-head-text">
        <h1 className="page-head-title">HR</h1>
        <p className="hr-sub">Employees, special services, reimbursements &amp; PTO</p>
      </div>
      <div className="hr-tabs">
        <div className="tab-container tab-container-line">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      <Active />
    </div>
  );
}
