// Per-person payroll drawer — a non-modal side panel (research: keep the roster
// visible, never a modal for routine entry). Two tabs: the hours→base Breakdown and
// the Custom lines editor (bonus / reimbursement / tip / deduction). Edits dispatch
// ADD/DELETE_PAYROLL_LINE; the run hook recomputes gross and re-passes the row.
import { useCallback, useState } from 'react';
import { useDispatch, useSelector } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { reimbursementForLine } from '../../lib/deleteCascade';
import { useToast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Avatar from '../../components/Avatar';
import { fmtDate } from '../../lib/dates';
import { minutesToHours } from '../../lib/payroll';
import { newId } from '../../lib/ids';
import { fmtMoney, fmtSigned, fmtHours, LINE_CATEGORY, StatusTag, rateSummary } from './shared';

const EMPTY = [];

const CATS = [
  { value: 'bonus', label: 'Bonus', kind: 'earning' },
  { value: 'special', label: 'Special service', kind: 'earning' },
  { value: 'reimbursement', label: 'Reimbursement', kind: 'earning' },
  { value: 'tip', label: 'Tip', kind: 'earning' },
  { value: 'deduction', label: 'Deduction', kind: 'deduction' },
];

function Breakdown({ row }) {
  const { user, pay, hours, base } = row;
  if (row.excluded) return <p className="pay-muted">{user.name} takes an owner draw — not on payroll.</p>;
  if (row.unset) return <p className="pay-muted">Pay type not set. Set a pay type &amp; rate in Settings → Team → {user.name}.</p>;
  const rate = Number(pay.hourlyRate) || 0;
  const otHours = pay.otExempt ? 0 : minutesToHours(hours ? hours.otMinutes : 0);
  return (
    <>
      <div className="pay-sec-t">Hours &amp; base pay</div>
      {pay.type === 'hourly' && hours && (
        <>
          <div className="pay-weeks">
            {(hours.weeks || []).map((w) => (
              <div className="pay-week" key={w.weekKey}>
                <span>{fmtDate(w.weekStart, { month: 'short', day: 'numeric' })}</span>
                <span>
                  <span className="mono">{fmtHours(w.totalMinutes)}</span>
                  {w.otMinutes ? <span className="pay-ot"> · {fmtHours(w.otMinutes)} OT</span> : null}
                </span>
              </div>
            ))}
          </div>
          <div className="pay-math"><span>Regular {fmtHours(hours.regularMinutes)} × {fmtMoney(rate)}</span><span className="mono">{fmtMoney(minutesToHours(hours.regularMinutes) * rate)}</span></div>
          <div className="pay-math"><span>Overtime {otHours.toFixed(1)}h × {fmtMoney(rate * 1.5)}</span><span className="mono">{fmtMoney(otHours * rate * 1.5)}</span></div>
        </>
      )}
      {pay.type === 'hourly' && !hours && <p className="pay-muted">No approved hours this period.</p>}
      {pay.type === 'per_visit' && <div className="pay-math"><span>{(hours && hours.cleanCount) || 0} cleans × {fmtMoney(pay.perVisitRate)}</span><span className="mono">{fmtMoney(base)}</span></div>}
      {pay.type === 'salary' && <div className="pay-math"><span>Salary · this period{pay.otExempt ? ' (OT exempt)' : ''}</span><span className="mono">{fmtMoney(base)}</span></div>}
      <div className="pay-math pay-math-base"><span>Base pay</span><span className="mono">{fmtMoney(base)}</span></div>
      {hours && hours.driveMinutes ? <p className="pay-muted">Includes {fmtHours(hours.driveMinutes)} paid drive (counted in hours worked, not paid on top).</p> : null}
    </>
  );
}

export default function PayrollLineDrawer({ row, period, onClose, canEdit, currentUserId }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const [tab, setTab] = useState('breakdown');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ category: 'bonus', label: '', amount: '' });
  const reimbursements = useSelector(useCallback((s) => s.reimbursements || EMPTY, []));

  if (!row) return null;
  const { user, pay, lines, gross } = row;
  // Lines that pay out an approved HR reimbursement are undone from HR, never here.
  const hrLineIds = new Set(lines.filter((l) => reimbursementForLine({ reimbursements }, l.id)).map((l) => l.id));

  const addLine = () => {
    const cat = CATS.find((c) => c.value === form.category) || CATS[0];
    const raw = parseFloat(form.amount) || 0;
    const amount = cat.kind === 'deduction' ? -Math.abs(raw) : Math.abs(raw);
    if (!amount) { toast.error('Enter an amount'); return; }
    dispatch({
      type: ACTIONS.ADD_PAYROLL_LINE,
      line: {
        id: newId('pl'),
        userId: user.id, periodKey: period.fromKey, kind: cat.kind, category: cat.value,
        label: form.label.trim() || cat.label, amount, taxable: cat.value !== 'reimbursement',
        createdBy: currentUserId || null,
      },
    });
    setForm({ category: 'bonus', label: '', amount: '' });
    setAdding(false);
    toast.success('Line added');
  };
  const delLine = (id) => dispatch({ type: ACTIONS.DELETE_PAYROLL_LINE, id });

  return (
    <>
      <div className="pay-scrim" onClick={onClose} aria-hidden />
      <aside className="pay-drawer" role="dialog" aria-label={`Payroll — ${user.name}`}>
        <div className="pay-drawer-head">
          <Avatar initials={user.initials} variant={user.avatar} size="md" />
          <div className="pay-drawer-who">
            <div className="pay-drawer-name">{user.name}<StatusTag row={row} /></div>
            <div className="pay-drawer-sub">{rateSummary(pay)}</div>
          </div>
          <button className="modal-close" onClick={onClose} type="button" aria-label="Close">×</button>
        </div>

        <div className="section-tabs pay-drawer-tabs" role="tablist">
          <button className={`section-tab ${tab === 'breakdown' ? 'active' : ''}`} role="tab" aria-selected={tab === 'breakdown'} onClick={() => setTab('breakdown')} type="button">Breakdown</button>
          <button className={`section-tab ${tab === 'lines' ? 'active' : ''}`} role="tab" aria-selected={tab === 'lines'} onClick={() => setTab('lines')} type="button">Custom lines<span className="section-tab-count">{lines.length}</span></button>
        </div>

        <div className="pay-drawer-body">
          {tab === 'breakdown' ? <Breakdown row={row} /> : (
            <>
              <div className="pay-sec-t">Custom lines · {period.label}</div>
              {lines.length === 0 ? <p className="pay-muted">No custom lines this period.</p> : (
                <div className="pay-lines">
                  {lines.map((l) => {
                    const c = LINE_CATEGORY[l.category] || { label: l.category, cls: '' };
                    return (
                      <div className="pay-line" key={l.id}>
                        <span className={`pay-lcat ${c.cls}`}>{c.label}</span>
                        <span className="pay-line-label">{l.label}{l.taxable === false && <span className="pay-nontax">non-tax</span>}</span>
                        <span className={`pay-line-amt mono ${l.amount < 0 ? 'pay-neg' : 'pay-pos'}`}>{fmtSigned(l.amount)}</span>
                        {canEdit && (hrLineIds.has(l.id)
                          ? <span className="pay-nontax pay-hr-tag">From HR</span>
                          : <button className="btn-icon btn-icon-danger" onClick={() => delLine(l.id)} type="button" aria-label="Remove line"><Icon name="trash" size={14} /></button>)}
                      </div>
                    );
                  })}
                </div>
              )}
              {canEdit && hrLineIds.size > 0 && (
                <p className="pay-muted">Lines tagged From HR pay out an approved reimbursement. To undo one, remove the reimbursement in HR › Reimbursements.</p>
              )}
              {canEdit && !adding && <button className="btn btn-outline pay-addbtn" onClick={() => setAdding(true)} type="button">Add line</button>}
              {canEdit && adding && (
                <div className="pay-addform">
                  <div className="pay-add-row">
                    <label className="pay-add-field">
                      <span>Type</span>
                      <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                        <option value="bonus">Bonus</option>
                        <option value="special">Special service</option>
                        <option value="reimbursement">Reimbursement</option>
                        <option value="tip">Tip</option>
                        <option value="deduction">Deduction</option>
                      </select>
                    </label>
                    <label className="pay-add-field pay-add-grow">
                      <span>Label</span>
                      <input className="input" type="text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Referral bonus" />
                    </label>
                    <label className="pay-add-field pay-add-amt">
                      <span>Amount</span>
                      <input className="input" type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
                    </label>
                  </div>
                  {form.category === 'reimbursement' && <p className="pay-muted pay-add-hint">Reimbursements are non-taxable and reported apart from wages.</p>}
                  <div className="pay-add-actions">
                    <button className="btn btn-outline" onClick={() => setAdding(false)} type="button">Cancel</button>
                    <button className="btn btn-primary" onClick={addLine} type="button">Add line</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="pay-drawer-foot">
          <span className="pay-foot-l">Gross · {period.label}</span>
          <span className="pay-foot-v mono">{fmtMoney(gross)}</span>
        </div>
      </aside>
    </>
  );
}
