// Direction 2 — Guided wizard (≈ Gusto / QuickBooks). A short linear run: Period →
// Hours → Adjustments → Review → Export, with a running total pinned in the footer.
// Lowest-error path for an occasional operator.
import { useState } from 'react';
import Avatar from '../../components/Avatar';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import { usePagedRows } from '../../hooks/usePagedRows';
import { fmtMoney, fmtSigned, fmtHours, PayTypeBadge, StatusTag } from './shared';

const STEPS = ['Period', 'Hours', 'Adjustments', 'Review', 'Export'];

// Paged roster table (lint:tables) shared by the Hours / Adjustments / Review steps.
function RosterMini({ rows, period, cols, render, onOpenPerson }) {
  const pager = usePagedRows(rows, { resetKey: period.fromKey });
  return (
    <>
      <div className="table-wrap">
        <table className="pay-register">
          <thead><tr><th>Team member</th><th>Type</th>{cols.map((c) => <th key={c} className="rt">{c || ' '}</th>)}</tr></thead>
          <tbody>
            {pager.pageRows.map((r) => (
              <tr key={r.user.id} className={r.excluded ? 'pay-row-excl' : 'pay-row'} onClick={() => onOpenPerson && !r.excluded && onOpenPerson(r)}>
                <td><div className="pay-who"><Avatar initials={r.user.initials} variant={r.user.avatar} size="sm" /><span className="pay-who-name truncate" title={r.user.name}>{r.user.name}</span><StatusTag row={r} /></div></td>
                <td><PayTypeBadge type={r.payType} /></td>
                {render(r)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun="team members" />
    </>
  );
}

export default function WizardView({ rows, period, summary, pending, onOpenPerson, onExport, canEdit }) {
  const [step, setStep] = useState(0);

  return (
    <div className="pay-view pay-wizard">
      <div className="pay-wsteps">
        {STEPS.map((s, i) => (
          <button key={s} type="button" className={`pay-wstep ${i < step ? 'done' : ''} ${i === step ? 'active' : ''}`} onClick={() => setStep(i)}>
            <span className="pay-wnum">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>{s}
          </button>
        ))}
      </div>

      <div className="pay-wbody">
        {step === 0 && (
          <>
            <div className="pay-infocard">
              <div><div className="pay-info-k">Pay schedule</div><div className="pay-info-v">Biweekly</div></div>
              <div><div className="pay-info-k">Pay period</div><div className="pay-info-v">{period.label}</div></div>
              <div><div className="pay-info-k">Team on payroll</div><div className="pay-info-v">{summary.onPayroll} of {rows.length}</div></div>
            </div>
            <p className={`pay-gate ${pending ? 'warn' : ''}`}><span className="pay-gate-dot" />{pending ? `${pending} punches pending approval` : 'Hours approved — ready to run'}</p>
          </>
        )}
        {step === 1 && (
          <>
            <div className="pay-sec-t">Review &amp; approve hours</div>
            <RosterMini rows={rows} period={period} cols={['Reg h', 'OT h']} onOpenPerson={onOpenPerson} render={(r) => (
              <>
                <td className="rt mono">{r.excluded ? '—' : (r.payType === 'per_visit' ? `${(r.hours && r.hours.cleanCount) || 0} cln` : (r.hours ? fmtHours(r.hours.regularMinutes) : '—'))}</td>
                <td className="rt mono">{!r.excluded && r.payType === 'hourly' && r.hours ? (r.hours.otMinutes ? <span className="pay-ot">{fmtHours(r.hours.otMinutes)}</span> : '0.0h') : '—'}</td>
              </>
            )} />
            <p className="pay-muted">Hours come from approved time entries with weekly OT already computed. Salaried &amp; per-visit rows don't need hours.</p>
          </>
        )}
        {step === 2 && (
          <>
            <div className="pay-sec-t">Add one-off pay &amp; deductions</div>
            <RosterMini rows={rows} period={period} cols={['Adjustments', '']} render={(r) => (
              <>
                <td className="rt mono">{r.excluded ? '—' : (r.totals.net === 0 ? <span className="pay-muted">none</span> : <span className={r.totals.net < 0 ? 'pay-neg' : 'pay-pos'}>{fmtSigned(r.totals.net)}</span>)}</td>
                <td className="rt">{!r.excluded && canEdit && <button className="btn btn-outline" onClick={(e) => { e.stopPropagation(); onOpenPerson(r); }} type="button">Edit lines</button>}</td>
              </>
            )} />
          </>
        )}
        {step === 3 && (
          <>
            <div className="pay-review3">
              <div className="pay-r3"><div className="pay-info-k">Base pay</div><div className="pay-r3-v mono">{fmtMoney(summary.base)}</div></div>
              <div className="pay-r3"><div className="pay-info-k">Adjustments</div><div className="pay-r3-v mono pay-pos">{fmtSigned(summary.adjustments)}</div></div>
              <div className="pay-r3"><div className="pay-info-k">Company gross</div><div className="pay-r3-v mono">{fmtMoney(summary.gross)}</div>{summary.deltaGross !== 0 && <div className={`pay-r3-cmp ${summary.deltaGross < 0 ? 'pay-neg' : 'pay-pos'}`}>{summary.deltaGross < 0 ? '▼' : '▲'} {fmtSigned(summary.deltaGross)} vs last</div>}</div>
            </div>
            <RosterMini rows={rows} period={period} cols={['Gross']} onOpenPerson={onOpenPerson} render={(r) => (
              <td className="rt mono pay-gross">{r.excluded ? '—' : fmtMoney(r.gross)}</td>
            )} />
          </>
        )}
        {step === 4 && (
          <>
            <div className="pay-sec-t">Export</div>
            <p className="pay-muted">Download the pay register as CSV for your payroll processor — columns: Cleaner, Reg h, OT h, Base, Bonus, Reimbursement (non-tax), Tip, Deduction, Gross.</p>
            <button className="btn btn-primary pay-export-btn" onClick={onExport} type="button"><Icon name="upload" size={15} /> Download CSV</button>
          </>
        )}
      </div>

      <div className="pay-wfoot">
        <span className="pay-running"><span className="pay-running-l">Running total</span><span className="pay-running-v mono">{fmtMoney(summary.gross)}</span></span>
        {step > 0 && <button className="btn btn-outline" onClick={() => setStep(step - 1)} type="button">Back</button>}
        {step < STEPS.length - 1
          ? <button className="btn btn-primary" onClick={() => setStep(step + 1)} type="button">Continue</button>
          : <button className="btn btn-success" onClick={onExport} type="button">Export CSV</button>}
      </div>
    </div>
  );
}
