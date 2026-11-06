// Per-person payroll drawer — a non-modal side panel (research: keep the roster visible,
// never a modal for routine entry). Two tabs: the hours→base Breakdown (plus the per-week
// arrears owed from prior closed periods) and the Custom lines editor (bonus / reimbursement
// / tip / deduction). Edits dispatch ADD/DELETE_PAYROLL_LINE; the run reloads.
//
// A CLOSED pay period is read-only (spec §8.5): lines can't be added or removed there (a
// correction is paid as arrears on the next payroll). Your OWN pay line is a Super Admin's,
// closed or not (MTA §8.6). Both mirror the server guard — the UI never offers what it refuses.
import { useCallback, useState } from 'react';
import { useDispatch, useSelector } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectCurrentUser } from '../../store/selectors';
import { reimbursementForLine } from '../../lib/deleteCascade';
import { useToast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Avatar from '../../components/Avatar';
import SidePanel from '../../components/SidePanel';
import { fmtDate } from '../../lib/dates';
import { minutesToHours } from '../../lib/payroll';
import { newId } from '../../lib/ids';
import { fmtMoney, fmtSigned, fmtHours, LINE_CATEGORY, StatusTag, rateSummary } from './shared';

const EMPTY = [];
const signedHours = (min) => (min == null || min === 0 ? '0.0h' : `${min < 0 ? '-' : '+'}${fmtHours(Math.abs(min))}`);
// A day-key ('YYYY-MM-DD') is a CALENDAR label, not a UTC instant — parse it at local noon so
// it renders as that calendar day in any US zone (same trap the HR tabs guard). Bare fmtDate
// would parse it as UTC midnight = the evening before in every US zone (Eastern → a day early).
const dayKeyLabel = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric' }) : '');

const CATS = [
  { value: 'bonus', label: 'Bonus', kind: 'earning' },
  { value: 'special', label: 'Special service', kind: 'earning' },
  { value: 'reimbursement', label: 'Reimbursement', kind: 'earning' },
  { value: 'tip', label: 'Tip', kind: 'earning' },
  { value: 'deduction', label: 'Deduction', kind: 'deduction' },
];

// The hours→base lines for an HOURLY member, from the run's OWN breakdown (`row.rateBreakdown`,
// lib/payRun → lib/payroll.hourlyPayBreakdown). This used to re-derive them from
// `pay.hourlyRate` × a hardcoded 1.5, which is a different number from what was paid the moment
// the cleaner has a rate at another building (PAY-7 / PAY-18) — or the org sets any other
// multiplier. One rate keeps the two familiar lines; two or more get a line per rate plus the
// week's blended overtime premium, because that premium belongs to no single rate.
function HourlyLines({ rb, current }) {
  if (!rb) return null;
  const premiumFactor = Math.max(0, (Number(rb.otMultiplier) || 1.5) - 1);
  if (!rb.multiRate) {
    const rate = rb.rates.length ? rb.rates[0].rate : 0;
    const otHours = rb.otExempt ? 0 : minutesToHours(current ? current.otMinutes : 0);
    return (
      <>
        <div className="pay-math"><span>Regular {fmtHours(current ? current.regularMinutes : 0)} × {fmtMoney(rate)}</span><span className="mono">{fmtMoney(minutesToHours(current ? current.regularMinutes : 0) * rate)}</span></div>
        <div className="pay-math"><span>Overtime {otHours.toFixed(1)}h × {fmtMoney(rate * (1 + premiumFactor))}</span><span className="mono">{fmtMoney(rb.otPremium + otHours * rate)}</span></div>
      </>
    );
  }
  return (
    <>
      {rb.rates.map((r) => (
        <div className="pay-math" key={r.rateCents}>
          <span>Straight time {fmtHours(r.minutes)} × {fmtMoney(r.rate)}</span>
          <span className="mono">{fmtMoney(r.pay)}</span>
        </div>
      ))}
      <div className="pay-math">
        <span>Overtime premium {minutesToHours(rb.otMinutes).toFixed(1)}h × {premiumFactor} × {fmtMoney(rb.blendedRate)} blended</span>
        <span className="mono">{fmtMoney(rb.otPremium)}</span>
      </div>
      <p className="pay-muted">Overtime past 40 hours in a week is paid on the week&rsquo;s blended rate — that week&rsquo;s pay divided by that week&rsquo;s hours — so the premium is the same whichever building it fell at.</p>
    </>
  );
}

function Breakdown({ row, periodClosed }) {
  const { user, pay, current, base, arrears, rateBreakdown } = row;
  if (row.excluded) return <p className="pay-muted">{user.name} takes an owner draw — not on payroll.</p>;
  if (row.unset) return <p className="pay-muted">Pay type not set. Set a pay type &amp; rate in Settings → Team → {user.name}.</p>;
  const arrRows = (arrears && arrears.rows) || EMPTY;
  return (
    <>
      <div className="pay-sec-t">Approved hours &amp; base pay</div>
      {pay && pay.type === 'hourly' && current && (
        <>
          {/* A CLOSED period is rendered from the stored file, which keeps totals and not the
              rate lines, so it shows the one hours→base line it always did. */}
          {!periodClosed && <HourlyLines rb={rateBreakdown} current={current} />}
          {periodClosed && <div className="pay-math"><span>Regular {fmtHours(current.regularMinutes)}{current.otMinutes ? ` · OT ${fmtHours(current.otMinutes)}` : ''}</span><span className="mono">{fmtMoney(base)}</span></div>}
        </>
      )}
      {pay && pay.type === 'hourly' && !current && <p className="pay-muted">No approved hours this period.</p>}
      {(!pay || (pay.type !== 'hourly' && pay.type !== 'salary')) && current && current.cleanCount != null && (
        <div className="pay-math"><span>{current.cleanCount || 0} cleans</span><span className="mono">{fmtMoney(base)}</span></div>
      )}
      {pay && pay.type === 'salary' && <div className="pay-math"><span>Salary · this period{pay.otExempt ? ' (OT exempt)' : ''}</span><span className="mono">{fmtMoney(base)}</span></div>}
      <div className="pay-math pay-math-base"><span>Base pay</span><span className="mono">{fmtMoney(base)}</span></div>
      {/* PAY-6: this line needs no gate of its own — the figure is REAL. With drive pay off the
          pricer drops every leg before the weekly ledger (lib/payRun via driveTime's
          `payableDriveSegments`), so `driveMinutes` is 0 and the sentence simply does not
          render; with it on the minutes are what was paid. It reads the row, not the setting. */}
      {current && current.driveMinutes ? <p className="pay-muted">Includes {fmtHours(current.driveMinutes)} paid drive (counted in hours worked, not paid on top).</p> : null}

      {arrRows.length > 0 && (
        <>
          <div className="pay-sec-t pay-arrears-t">Arrears · owed from prior closed periods</div>
          <div className="pay-weeks">
            {arrRows.map((w) => (
              <div className="pay-week" key={`${w.forPeriodKey}|${w.weekKey}`}>
                <span>Week of {dayKeyLabel(w.weekKey)}<span className="pay-muted"> · from the {dayKeyLabel(w.forPeriodKey)} period</span></span>
                <span className="mono">{signedHours(w.regularMinutes)}{w.otMinutes ? <span className="pay-ot"> · {signedHours(w.otMinutes)} OT</span> : null}</span>
              </div>
            ))}
          </div>
          <div className="pay-math pay-math-base"><span>Arrears pay</span><span className={`mono ${arrears.pay < 0 ? 'pay-neg' : 'pay-pos'}`}>{fmtSigned(arrears.pay)}</span></div>
          <p className="pay-muted">A late approval, a manual entry into a paid week, or a void changes what was owed for a closed period; the difference is paid on this run.</p>
        </>
      )}
    </>
  );
}

export default function PayrollLineDrawer({ row, period, onClose, canEdit, periodClosed, currentUserId }) {
  // The panel itself is the shared SidePanel (its slide in and out, the dim that closes it, Esc).
  // Always mounted by the Payroll page: `row` null closes it, and the panel keeps the last row on
  // screen while it slides out.
  return (
    <SidePanel item={row} onClose={onClose} className="pay-drawer" label={(r) => `Payroll — ${r.user.name}`}>
      {(shown) => (
        <PayrollLinePanel
          row={shown} period={period} onClose={onClose}
          canEdit={canEdit} periodClosed={periodClosed} currentUserId={currentUserId}
        />
      )}
    </SidePanel>
  );
}

// One row's panel. It mounts with each opening, so its tab and a half-typed line start fresh
// every time the panel opens, as they did when the whole drawer mounted per opening.
function PayrollLinePanel({ row, period, onClose, canEdit, periodClosed, currentUserId }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const [tab, setTab] = useState('breakdown');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ category: 'bonus', label: '', amount: '' });
  const reimbursements = useSelector(useCallback((s) => s.reimbursements || EMPTY, []));
  const me = useSelector(useCallback((s) => selectCurrentUser(s), []));

  const { user, pay, lines, gross } = row;
  // Your OWN pay lines are a Super Admin's — a reimbursement / bonus typed straight into the
  // drawer was the way around HR's own-approval rule (MTA §8.6). The server (orgStateGuard)
  // refuses an own-line add / change / remove for anyone but role owner. Role is claims-first.
  const ownLineLocked = !!currentUserId && user.id === currentUserId && me?.role !== 'owner';
  // A closed period is INSERT-only: no line add / remove there (a correction is paid as arrears).
  const mayEditLines = canEdit && !ownLineLocked && !periodClosed;
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
      <div className="pay-drawer-head">
        <Avatar user={user} size="md" />
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
        {tab === 'breakdown' ? <Breakdown row={row} periodClosed={periodClosed} /> : (
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
                      {mayEditLines && (hrLineIds.has(l.id)
                        ? <span className="pay-nontax pay-hr-tag">From HR</span>
                        : <button className="btn-icon btn-icon-danger" onClick={() => delLine(l.id)} type="button" aria-label="Remove line"><Icon name="trash" size={14} /></button>)}
                    </div>
                  );
                })}
              </div>
            )}
            {periodClosed && (
              <p className="pay-muted">This pay period is closed. Lines can't be added or removed — a correction is paid as arrears on the next payroll.</p>
            )}
            {mayEditLines && hrLineIds.size > 0 && (
              <p className="pay-muted">Lines tagged From HR pay out an approved reimbursement. To undo one, remove the reimbursement in HR › Reimbursements.</p>
            )}
            {!periodClosed && ownLineLocked && (
              <p className="pay-muted">Only a Super Admin can add or change your own pay lines.</p>
            )}
            {mayEditLines && !adding && <button className="btn btn-outline pay-addbtn" onClick={() => setAdding(true)} type="button">Add line</button>}
            {mayEditLines && adding && (
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
    </>
  );
}
