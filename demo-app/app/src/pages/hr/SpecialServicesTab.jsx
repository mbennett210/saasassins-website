// HR › Special services — one-off flat-rate compensation (a custom amount + description
// paid to an employee for a specific pay period). Each is a payroll line with
// category 'special', so it lands on the pay run in its own column and in gross.
import { useCallback, useMemo, useState } from 'react';
import { useDispatch, useSelector } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectPayrollLines } from '../../store/selectors';
import { newId } from '../../lib/ids';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import Icon from '../../components/Icon';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import { usePagedRows } from '../../hooks/usePagedRows';
import ListPager from '../../components/ListPager';
import { payPeriodRange } from '../../lib/payroll';
import { money } from '../../lib/dates';
import { compareUsersByName } from '../../lib/roles';

export default function SpecialServicesTab() {
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('hr.edit');
  const currentUserId = useSelector(useCallback((s) => s.currentUserId, []));
  const lines = useSelector(useCallback((s) => selectPayrollLines(s), []));
  const users = useSelector(useCallback((s) => s.users, []));
  // Follow the ORG's pay cadence so a line's periodKey (= period fromKey) matches the
  // pay run's period; hardcoding biweekly here silently drops lines under semi-monthly.
  const cadence = useSelector(useCallback((s) => {
    const c = s.opsSettings?.payPeriodCadence;
    return c === 'weekly' || c === 'semimonthly' ? c : 'biweekly';
  }, []));

  const periods = useMemo(() => [0, -1, -2, -3].map((o) => payPeriodRange(cadence, o)), [cadence]);
  const nameById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const payableUsers = useMemo(() => users.filter((u) => u.status === 'active' && u.pay && u.pay.type && u.pay.type !== 'none').slice().sort(compareUsersByName), [users]);
  const special = useMemo(() => lines.filter((l) => l.category === 'special').slice().reverse(), [lines]);
  const pager = usePagedRows(special, { param: 'page' });
  const periodLabel = (key) => (periods.find((p) => p.fromKey === key) || {}).label || key;

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ userId: '', description: '', amount: '', periodKey: periods[0].fromKey });
  const [confirmId, setConfirmId] = useState(null);

  const add = () => {
    const amt = Math.abs(parseFloat(form.amount) || 0);
    if (!form.userId) { toast.error('Pick an employee'); return; }
    if (!amt) { toast.error('Enter an amount'); return; }
    dispatch({ type: ACTIONS.ADD_PAYROLL_LINE, line: { id: newId('pl'), userId: form.userId, periodKey: form.periodKey, kind: 'earning', category: 'special', label: form.description.trim() || 'Special service', amount: amt, taxable: true, createdBy: currentUserId } });
    setForm({ userId: '', description: '', amount: '', periodKey: periods[0].fromKey });
    setAdding(false);
    toast.success('Special service added');
  };
  const del = (id) => { dispatch({ type: ACTIONS.DELETE_PAYROLL_LINE, id }); setConfirmId(null); toast.success('Removed'); };

  return (
    <div className="hr-view">
      <div className="hr-toolbar">
        <p className="text-sm text-muted" style={{ margin: 0 }}>One-off flat-rate pay for a special service — a custom amount + description for an employee in a pay period. Shows on the payroll run as a “Special service” line.</p>
        {canEdit && !adding && <button className="btn btn-primary" onClick={() => setAdding(true)} type="button">Add special service</button>}
      </div>

      {canEdit && adding && (
        <div className="hr-addform card detail-card">
          <div className="form-row">
            <FormField label="Employee" as="select" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} options={[{ value: '', label: '— Select —' }, ...payableUsers.map((u) => ({ value: u.id, label: u.name }))]} />
            <FormField label="Pay period" as="select" value={form.periodKey} onChange={(e) => setForm({ ...form, periodKey: e.target.value })} options={periods.map((p) => ({ value: p.fromKey, label: p.label }))} />
          </div>
          <div className="form-row">
            <FormField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Emergency flood cleanup — Banyan Ct" />
            <FormField label="Amount ($)" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="modal-actions">
            <button className="btn btn-outline" onClick={() => setAdding(false)} type="button">Cancel</button>
            <button className="btn btn-primary" onClick={add} type="button">Add</button>
          </div>
        </div>
      )}

      {special.length === 0 ? <p className="text-muted">No special services yet.</p> : (
        <>
          <div className="table-wrap mobile-scroll">
            <table className="pay-register">
              <thead><tr><th>Employee</th><th>Description</th><th>Pay period</th><th className="rt">Amount</th>{canEdit && <th aria-label="actions" />}</tr></thead>
              <tbody>
                {pager.pageRows.map((l) => (
                  <tr key={l.id}>
                    <td className="pay-who-name"><span className="truncate" title={nameById[l.userId] || l.userName || ''}>{nameById[l.userId] || l.userName || '—'}</span></td>
                    <td><span className="truncate" title={l.label}>{l.label}</span></td>
                    <td>{periodLabel(l.periodKey)}</td>
                    <td className="rt mono pay-pos">{money(l.amount)}</td>
                    {canEdit && <td className="rt"><button className="btn-icon btn-icon-danger" onClick={() => setConfirmId(l.id)} type="button" aria-label="Remove"><Icon name="trash" size={14} /></button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun="special services" />
        </>
      )}

      {confirmId && <ConfirmDialog open title="Remove special service?" message="This removes the pay line from the run." confirmLabel="Remove" onConfirm={() => del(confirmId)} onClose={() => setConfirmId(null)} />}
    </div>
  );
}
