// HR › Employees — the roster with HR fields (Employee ID, employment type, hire date),
// pay summary, and PTO used-of-allowance. Click a row to open the employee's HR record
// (fields + documents). Reuses the roster selectors, paging, and mobile-card fallback.
import { useCallback, useMemo, useState } from 'react';
import { useSelector } from '../../store';
import { selectTimeOff } from '../../store/selectors';
import { compareUsersByName } from '../../lib/roles';
import { usePagedRows } from '../../hooks/usePagedRows';
import ListPager from '../../components/ListPager';
import Avatar from '../../components/Avatar';
import { fmtDate } from '../../lib/dates';
import { ptoBalance } from '../../lib/pto';
import { EMPLOYMENT_LABEL } from '../../components/EmployeeHrFieldsCard';
import { rateSummary } from '../payroll/shared';
import EmployeeHrPanel from './EmployeeHrPanel';

const YEAR = new Date().getFullYear();
const dayKeyDate = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function EmployeesTab() {
  const users = useSelector(useCallback((s) => s.users, []));
  const timeOff = useSelector(useCallback((s) => selectTimeOff(s), []));
  const active = useMemo(() => users.filter((u) => u.status === 'active').slice().sort(compareUsersByName), [users]);
  const pager = usePagedRows(active, { param: 'page' });
  const [openId, setOpenId] = useState(null);
  const openUser = active.find((u) => u.id === openId) || null;

  return (
    <div className="hr-view">
      <div className="table-wrap">
        <table className="pay-register hr-table">
          <thead><tr><th>Employee</th><th>Employee ID</th><th>Type</th><th>Hire date</th><th>Pay</th><th className="rt">PTO used</th></tr></thead>
          <tbody>
            {pager.pageRows.map((u) => {
              const hr = u.hr || {}; const bal = ptoBalance(u, timeOff, YEAR);
              return (
                <tr key={u.id} className="pay-row" onClick={() => setOpenId(u.id)}>
                  <td><div className="pay-who"><Avatar initials={u.initials} variant={u.avatar} size="sm" /><span className="pay-who-name truncate" title={u.name}>{u.name}</span></div></td>
                  <td className="mono">{hr.employeeId || <span className="pay-muted">—</span>}</td>
                  <td>{EMPLOYMENT_LABEL[hr.employmentType] || <span className="pay-muted">—</span>}</td>
                  <td className="mono">{dayKeyDate(hr.hireDate)}</td>
                  <td className="pay-muted">{rateSummary(u.pay)}</td>
                  <td className="rt mono">{bal.allowance ? `${bal.used} / ${bal.allowance}d` : `${bal.used}d`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pay-cards">
        {pager.pageRows.map((u) => {
          const hr = u.hr || {}; const bal = ptoBalance(u, timeOff, YEAR);
          return (
            <button key={u.id} className="pay-card" type="button" onClick={() => setOpenId(u.id)}>
              <div className="pay-card-row"><span className="pay-card-name">{u.name}</span><span className="mono pay-muted">{hr.employeeId || ''}</span></div>
              <div className="pay-card-meta">
                <span>{EMPLOYMENT_LABEL[hr.employmentType] || '—'}</span>
                <span>PTO {bal.used}{bal.allowance ? `/${bal.allowance}` : ''}d</span>
              </div>
            </button>
          );
        })}
      </div>

      <ListPager pager={pager} noun="employees" />
      {openUser && <EmployeeHrPanel user={openUser} onClose={() => setOpenId(null)} />}
    </div>
  );
}
