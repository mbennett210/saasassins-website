// HR › PTO — track time off against a per-employee annual allowance. Reuses the
// existing timeOff ledger (the same records that gate scheduling coverage): add/remove
// here flows through ADD_TIME_OFF / DELETE_TIME_OFF. v1 is track + fixed allowance
// (user.hr.ptoAllowanceDays); no accrual/carryover engine.
import { useCallback, useMemo, useState } from 'react';
import { useDispatch, useSelector } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectTimeOff } from '../../store/selectors';
import { TIME_OFF_KINDS, TIME_OFF_KIND_LABEL, isCallOut, defaultTimeOffKind, jobsCoveredByTimeOff } from '../../store/timeOffRules';
import { isUserJobCrew } from '../../lib/crewResolve';
import Badge from '../../components/Badge';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import Icon from '../../components/Icon';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import { usePagedRows } from '../../hooks/usePagedRows';
import ListPager from '../../components/ListPager';
import { newId } from '../../lib/ids';
import { fmtDate, diffDaysKey, todayKey } from '../../lib/dates';
import { compareUsersByName } from '../../lib/roles';
import { ptoBalance } from '../../lib/pto';

const YEAR = new Date().getFullYear();
const dayKeyDate = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric' }) : '—');
const spanDays = (a, b) => (a && b ? diffDaysKey(a, b) + 1 : 0);

export default function PtoTab() {
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('hr.edit');
  const timeOff = useSelector(useCallback((s) => selectTimeOff(s), []));
  const users = useSelector(useCallback((s) => s.users, []));
  const jobs = useSelector(useCallback((s) => s.jobs, []));

  const active = useMemo(() => users.filter((u) => u.status === 'active').slice().sort(compareUsersByName), [users]);
  const nameById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const entries = useMemo(() => timeOff.slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')), [timeOff]);
  const pager = usePagedRows(entries, { param: 'page' });

  const [adding, setAdding] = useState(false);
  // kind: null = follow the first day (today → call-out, later → planned) until picked.
  const blankForm = () => ({ userId: '', startDate: todayKey(), endDate: todayKey(), reason: '', kind: null });
  const [form, setForm] = useState(blankForm);
  const [confirmId, setConfirmId] = useState(null);
  const kind = form.kind || defaultTimeOffKind(form.startDate, todayKey());

  const add = () => {
    if (!form.userId) { toast.error('Pick an employee'); return; }
    if (!form.startDate || !form.endDate) { toast.error('Pick both dates'); return; }
    if (form.endDate < form.startDate) { toast.error('Last day is before the first day'); return; }
    // Record the cleans this covers (what they called out of) — Reports › Called out still
    // names them after the office swaps cover in by hand.
    const covered = jobsCoveredByTimeOff(jobs, { startDate: form.startDate, endDate: form.endDate, isOnCrew: (j) => isUserJobCrew(j, form.userId) });
    dispatch({
      type: ACTIONS.ADD_TIME_OFF,
      entry: {
        id: newId('to'), userId: form.userId, startDate: form.startDate, endDate: form.endDate, reason: form.reason.trim(), kind,
        ...(covered.length ? { scheduledJobIds: covered.map((j) => j.id) } : {}),
      },
    });
    setForm(blankForm());
    setAdding(false);
    toast.success(kind === 'callout' ? 'Call-out added' : 'Time off added');
  };
  const del = (id) => { dispatch({ type: ACTIONS.DELETE_TIME_OFF, id }); setConfirmId(null); toast.success('Removed'); };
  const confirmEntry = entries.find((e) => e.id === confirmId);

  return (
    <div className="hr-view">
      <div className="hr-toolbar">
        <p className="text-sm text-muted" style={{ margin: 0 }}>Time off booked this year, per employee, against their annual allowance.</p>
        {canEdit && !adding && <button className="btn btn-primary" onClick={() => setAdding(true)} type="button">Add time off</button>}
      </div>

      {canEdit && adding && (
        <div className="hr-addform card detail-card">
          <div className="form-row">
            <FormField label="Employee" as="select" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} options={[{ value: '', label: '— Select —' }, ...active.map((u) => ({ value: u.id, label: u.name }))]} />
            <FormField label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Vacation" />
          </div>
          <div className="form-row">
            <FormField label="First day" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            <FormField label="Last day" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </div>
          <FormField label="Type">
            <div className="tab-container-line" role="group" aria-label="Type of time off">
              {TIME_OFF_KINDS.map((k) => (
                <button key={k} type="button" className={`tab-btn ${kind === k ? 'active' : ''}`} aria-pressed={kind === k} onClick={() => setForm({ ...form, kind: k })}>
                  {TIME_OFF_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </FormField>
          <div className="modal-actions">
            <button className="btn btn-outline" onClick={() => setAdding(false)} type="button">Cancel</button>
            <button className="btn btn-primary" onClick={add} type="button">Add</button>
          </div>
        </div>
      )}

      <div className="hr-pto-balances">
        {active.filter((u) => (u.hr && u.hr.ptoAllowanceDays)).map((u) => {
          const bal = ptoBalance(u, timeOff, YEAR);
          const pct = bal.allowance ? Math.min(100, Math.round((bal.used / bal.allowance) * 100)) : 0;
          return (
            <div className="hr-pto-card" key={u.id}>
              <div className="hr-pto-name">{u.name}</div>
              <div className="hr-pto-meter"><span className="hr-pto-fill" style={{ width: `${pct}%` }} /></div>
              <div className="hr-pto-nums">{bal.used} used · {bal.remaining} left <span className="pay-muted">/ {bal.allowance}d</span></div>
            </div>
          );
        })}
      </div>

      {entries.length === 0 ? <p className="text-muted">No time off booked.</p> : (
        <>
          <div className="table-wrap mobile-scroll">
            <table className="pay-register">
              <thead><tr><th>Employee</th><th>From</th><th>To</th><th className="rt">Days</th><th>Type</th><th>Reason</th>{canEdit && <th aria-label="actions" />}</tr></thead>
              <tbody>
                {pager.pageRows.map((e) => (
                  <tr key={e.id}>
                    <td className="pay-who-name"><span className="truncate" title={nameById[e.userId] || e.userName || ''}>{nameById[e.userId] || e.userName || '—'}</span></td>
                    <td className="mono">{dayKeyDate(e.startDate)}</td>
                    <td className="mono">{dayKeyDate(e.endDate)}</td>
                    <td className="rt mono">{spanDays(e.startDate, e.endDate)}</td>
                    <td><Badge variant={isCallOut(e) ? 'amber' : 'slate'}>{TIME_OFF_KIND_LABEL[isCallOut(e) ? 'callout' : 'planned']}</Badge></td>
                    <td>{e.reason ? <span className="truncate" title={e.reason}>{e.reason}</span> : <span className="pay-muted">—</span>}</td>
                    {canEdit && <td className="rt"><button className="btn-icon btn-icon-danger" onClick={() => setConfirmId(e.id)} type="button" aria-label="Remove"><Icon name="trash" size={14} /></button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun="entries" />
        </>
      )}

      {confirmEntry && <ConfirmDialog open title="Remove time off?" message={`Remove ${nameById[confirmEntry.userId] || confirmEntry.userName || 'this'}'s time off?`} confirmLabel="Remove" onConfirm={() => del(confirmEntry.id)} onClose={() => setConfirmId(null)} />}
    </div>
  );
}
