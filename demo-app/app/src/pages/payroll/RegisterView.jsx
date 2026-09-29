// Direction 1 — Register grid (≈ ADP RUN / Patriot). One dense worksheet: workers
// as rows, pay types as columns, a "Show all pay types" progressive-disclosure toggle
// that breaks the single Adjustments column into Bonus/Reimb/Tip/Deduct, and a sticky
// company-total footer. Paged (lint:tables) with a mobile-card fallback (lint:responsive).
import { useState } from 'react';
import Avatar from '../../components/Avatar';
import ListPager from '../../components/ListPager';
import { usePagedRows } from '../../hooks/usePagedRows';
import { fmtMoney, fmtSigned, fmtHours, PayTypeBadge, StatusTag, rateSummary } from './shared';

const catAmt = (r, k) => r.totals.byCategory[k] || 0;
const catCell = (v, neg) => (v ? <span className={neg ? 'pay-neg' : 'pay-pos'}>{fmtSigned(v)}</span> : <span className="pay-muted">—</span>);

export default function RegisterView({ rows, period, summary, onOpenPerson }) {
  const [expand, setExpand] = useState(false);
  const pager = usePagedRows(rows, { resetKey: period.fromKey });

  return (
    <div className="pay-view">
      <div className="pay-view-toolbar">
        <label className="pay-check"><input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} /> Show all pay types</label>
      </div>

      <div className="table-wrap">
        <table className={`pay-register ${expand ? 'expanded' : ''}`}>
          <thead>
            <tr>
              <th>Team member</th><th>Type</th>
              <th className="rt">Reg h</th><th className="rt">OT h</th><th className="rt">Base</th>
              <th className="rt rl-col">Adjustments</th>
              <th className="rt bd-col">Bonus</th><th className="rt bd-col">Special</th><th className="rt bd-col">Reimb</th><th className="rt bd-col">Tip</th><th className="rt bd-col">Deduct</th>
              <th className="rt">Gross</th>
            </tr>
          </thead>
          <tbody>
            {pager.pageRows.map((r) => (
              <tr key={r.user.id} className={r.excluded ? 'pay-row-excl' : 'pay-row'} onClick={() => !r.excluded && onOpenPerson(r)}>
                <td>
                  <div className="pay-who">
                    <Avatar initials={r.user.initials} variant={r.user.avatar} size="sm" />
                    <div><div className="pay-who-name truncate" title={r.user.name}>{r.user.name}</div><div className="pay-who-sub">{rateSummary(r.pay)}<StatusTag row={r} /></div></div>
                  </div>
                </td>
                <td><PayTypeBadge type={r.payType} /></td>
                <td className="rt mono">{r.excluded ? '—' : (r.payType === 'per_visit' ? `${(r.hours && r.hours.cleanCount) || 0} cln` : (r.hours ? fmtHours(r.hours.regularMinutes) : '—'))}</td>
                <td className="rt mono">{!r.excluded && r.payType === 'hourly' && r.hours ? (r.hours.otMinutes ? <span className="pay-ot">{fmtHours(r.hours.otMinutes)}</span> : '0.0h') : '—'}</td>
                <td className="rt mono">{r.excluded ? <span className="pay-muted">Not on payroll</span> : fmtMoney(r.base)}</td>
                <td className="rt mono rl-col">{r.excluded ? '—' : (r.totals.net === 0 ? <span className="pay-muted">—</span> : <span className={r.totals.net < 0 ? 'pay-neg' : 'pay-pos'}>{fmtSigned(r.totals.net)}</span>)}</td>
                <td className="rt mono bd-col">{r.excluded ? '—' : catCell(catAmt(r, 'bonus'))}</td>
                <td className="rt mono bd-col">{r.excluded ? '—' : catCell(catAmt(r, 'special'))}</td>
                <td className="rt mono bd-col">{r.excluded ? '—' : catCell(catAmt(r, 'reimbursement'))}</td>
                <td className="rt mono bd-col">{r.excluded ? '—' : catCell(catAmt(r, 'tip'))}</td>
                <td className="rt mono bd-col">{r.excluded ? '—' : catCell(catAmt(r, 'deduction'), true)}</td>
                <td className="rt mono pay-gross">{r.excluded ? '—' : fmtMoney(r.gross)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="pay-foot-row">
              <td>Company total · {summary.onPayroll} on payroll</td><td />
              <td className="rt mono">{fmtHours(summary.regMinutes)}</td>
              <td className="rt mono">{fmtHours(summary.otMinutes)}</td>
              <td className="rt mono">{fmtMoney(summary.base)}</td>
              <td className="rt mono rl-col">{summary.adjustments ? <span className={summary.adjustments < 0 ? 'pay-neg' : 'pay-pos'}>{fmtSigned(summary.adjustments)}</span> : '—'}</td>
              <td className="rt mono bd-col">{fmtMoney(summary.byCategory.bonus || 0)}</td>
              <td className="rt mono bd-col">{fmtMoney(summary.byCategory.special || 0)}</td>
              <td className="rt mono bd-col">{fmtMoney(summary.byCategory.reimbursement || 0)}</td>
              <td className="rt mono bd-col">{fmtMoney(summary.byCategory.tip || 0)}</td>
              <td className="rt mono bd-col">{fmtMoney(summary.byCategory.deduction || 0)}</td>
              <td className="rt mono pay-gross">{fmtMoney(summary.gross)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="pay-cards">
        {pager.pageRows.map((r) => (
          <button key={r.user.id} className="pay-card" onClick={() => !r.excluded && onOpenPerson(r)} type="button" disabled={r.excluded}>
            <div className="pay-card-row"><span className="pay-card-name">{r.user.name}<StatusTag row={r} /></span><PayTypeBadge type={r.payType} /></div>
            {r.excluded ? <div className="pay-card-sub pay-muted">Owner draw — not on payroll</div> : (
              <>
                <div className="pay-card-meta">
                  <span>{r.hours ? fmtHours(r.hours.regularMinutes) : '—'} reg{r.hours && r.hours.otMinutes ? <span className="pay-ot"> · {fmtHours(r.hours.otMinutes)} OT</span> : ''}</span>
                  <span>Base {fmtMoney(r.base)}</span>
                </div>
                <div className="pay-card-row pay-card-foot">
                  <span>{r.totals.net !== 0 && <span className={r.totals.net < 0 ? 'pay-neg' : 'pay-pos'}>{fmtSigned(r.totals.net)} adj</span>}</span>
                  <span className="pay-gross mono">{fmtMoney(r.gross)}</span>
                </div>
              </>
            )}
          </button>
        ))}
      </div>

      <ListPager pager={pager} noun="team members" />
    </div>
  );
}
