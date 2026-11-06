// Direction 3 — Roster + drawer (≈ Rippling / NN/g nonmodal panel). A calm roster
// list with a persistent totals rail; clicking a person opens the shared side drawer
// (breakdown + line editor + the per-week arrears) without hiding the list. Reads the
// SERVER pay run (approved-only, in arrears).
import Avatar from '../../components/Avatar';
import { fmtMoney, fmtSigned, fmtHours, PayTypeBadge, StatusTag, rateSummary } from './shared';

export default function RosterView({ rows, summary, onOpenPerson }) {
  return (
    <div className="pay-view pay-roster">
      <div className="pay-roster-list">
        {rows.map((r) => (
          <button key={r.key} className={`pay-rrow ${r.excluded ? 'is-excl' : ''}`} onClick={() => !r.excluded && onOpenPerson(r)} type="button" disabled={r.excluded}>
            <Avatar user={r.user} size="sm" />
            <div className="pay-rrow-main">
              <div className="pay-rrow-name">{r.user.name}<StatusTag row={r} />{r.arrears.pay ? <span className={`pay-arrears-chip ${r.arrears.pay < 0 ? 'neg' : ''}`}>{fmtSigned(r.arrears.pay)} arrears</span> : null}</div>
              <div className="pay-rrow-sub"><PayTypeBadge type={r.payType} /> <span className="pay-muted">{rateSummary(r.pay)}</span></div>
            </div>
            <div className="pay-rrow-hrs mono">
              {r.excluded ? '' : (r.payType === 'hourly' && r.current
                ? `${fmtHours(r.current.regularMinutes)}${r.current.otMinutes ? ` + ${fmtHours(r.current.otMinutes)} OT` : ''}`
                : (r.payType === 'per_visit' ? `${(r.current && r.current.cleanCount) || 0} cleans` : (r.payType === 'salary' ? 'salaried' : '')))}
            </div>
            <div className="pay-rrow-gross mono">{r.excluded ? <span className="pay-muted">excluded</span> : fmtMoney(r.gross)}</div>
            {!r.excluded && <span className="pay-rrow-go" aria-hidden>›</span>}
          </button>
        ))}
      </div>
      <aside className="pay-rail">
        <h4 className="pay-rail-h">This pay run</h4>
        <div className="pay-rail-line"><span>Base pay</span><span className="mono">{fmtMoney(summary.base)}</span></div>
        <div className="pay-rail-line"><span>Bonuses / tips</span><span className="mono pay-pos">{fmtSigned((summary.byCategory.bonus || 0) + (summary.byCategory.tip || 0))}</span></div>
        <div className="pay-rail-line"><span>Special services</span><span className="mono pay-pos">{fmtSigned(summary.byCategory.special || 0)}</span></div>
        <div className="pay-rail-line"><span>Reimbursements</span><span className="mono pay-pos">{fmtSigned(summary.byCategory.reimbursement || 0)}</span></div>
        <div className="pay-rail-line"><span>Deductions</span><span className="mono pay-neg">{fmtSigned(summary.byCategory.deduction || 0)}</span></div>
        {summary.arrears ? <div className="pay-rail-line"><span>Arrears</span><span className={`mono ${summary.arrears < 0 ? 'pay-neg' : 'pay-pos'}`}>{fmtSigned(summary.arrears)}</span></div> : null}
        <div className="pay-rail-line"><span>On payroll</span><span className="mono">{summary.onPayroll} of {rows.length}</span></div>
        <div className="pay-rail-total"><span className="pay-rail-total-l">Company gross</span><span className="pay-rail-total-v mono">{fmtMoney(summary.gross)}</span></div>
      </aside>
    </div>
  );
}
