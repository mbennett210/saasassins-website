// Direction 4 — Review-first (≈ Rippling compare / Paychex Pre-check). Because hours
// are already approved and OT already computed, the run is an APPROVAL task: lead with
// the total, the vs-last-period delta, and a flag list of what changed; the full roster
// is a drill-down. Most on-brand with the Variance page.
import ListPager from '../../components/ListPager';
import Avatar from '../../components/Avatar';
import { usePagedRows } from '../../hooks/usePagedRows';
import { fmtMoney, fmtSigned, fmtHours, PayTypeBadge, StatusTag } from './shared';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default function ReviewView({ rows, period, prevPeriod, summary, pending, onOpenPerson }) {
  const pager = usePagedRows(rows, { resetKey: period.fromKey });
  const pct = summary.prevGross ? Math.round((summary.deltaGross / summary.prevGross) * 1000) / 10 : null;

  const flags = [];
  for (const r of rows) {
    if (r.excluded) continue;
    if (r.unset) { flags.push({ id: r.user.id, sev: 'i', t: `${r.user.name} · pay not set`, d: 'Set a pay type & rate to include them in the run', delta: null }); continue; }
    const reasons = [];
    // Someone no longer active is on this run only for pay they earned — a final pay
    // worth confirming before export.
    if (r.inactive) reasons.push(r.user.status === 'invited' ? 'invited, not active yet' : 'disabled · final pay');
    if (r.hours && r.hours.otMinutes) reasons.push(`${fmtHours(r.hours.otMinutes)} OT`);
    if (r.totals.byCategory.bonus) reasons.push(`bonus ${fmtSigned(r.totals.byCategory.bonus)}`);
    if (r.totals.byCategory.special) reasons.push(`special service ${fmtSigned(r.totals.byCategory.special)}`);
    if (r.totals.byCategory.tip) reasons.push(`tip ${fmtSigned(r.totals.byCategory.tip)}`);
    if (r.totals.byCategory.deduction) reasons.push(`deduction ${fmtSigned(r.totals.byCategory.deduction)}`);
    const delta = (r.gross != null && r.prevGross != null) ? r2(r.gross - r.prevGross) : null;
    const big = delta != null && Math.abs(delta) >= 100;
    if (reasons.length || big) flags.push({ id: r.user.id, sev: ((r.hours && r.hours.otMinutes) || big || r.inactive) ? 'a' : 'i', t: r.user.name, d: reasons.join(' · ') || `changed ${fmtSigned(delta)} vs last period`, delta });
  }

  return (
    <div className="pay-view">
      <div className="pay-review-hero">
        <div className="pay-hero-big">
          <div className="pay-hero-l">Company gross · this period</div>
          <div className="pay-hero-v mono">{fmtMoney(summary.gross)}</div>
          {summary.deltaGross !== 0 && (
            <div className={`pay-hero-cmp ${summary.deltaGross < 0 ? 'pay-neg' : 'pay-pos'}`}>
              {summary.deltaGross < 0 ? '▼' : '▲'} {fmtSigned(summary.deltaGross)}{pct != null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''} vs {prevPeriod.label}
            </div>
          )}
        </div>
        <div className="pay-hero-mini">
          <div className="pay-mini"><div className="pay-mini-k">On payroll</div><div className="pay-mini-v mono">{summary.onPayroll}<span className="pay-muted"> / {rows.length}</span></div></div>
          <div className="pay-mini"><div className="pay-mini-k">Reg / OT hrs</div><div className="pay-mini-v mono">{Math.round(summary.regMinutes / 60)} / <span className="pay-ot">{(summary.otMinutes / 60).toFixed(1)}</span></div></div>
          <div className="pay-mini"><div className="pay-mini-k">Adjustments</div><div className="pay-mini-v mono pay-pos">{fmtSigned(summary.adjustments)}</div></div>
          <div className="pay-mini"><div className="pay-mini-k">Hours approved</div><div className={`pay-mini-v mono ${pending ? 'pay-neg' : 'pay-approved'}`}>{pending ? `${pending} pending` : '100%'}</div></div>
        </div>
      </div>

      <div className="pay-flags">
        <h4 className="pay-flags-h">Needs a look · {flags.length} {flags.length === 1 ? 'flag' : 'flags'}</h4>
        {flags.length === 0 ? <p className="pay-muted">Nothing unusual — hours approved, no adjustments or big swings this period.</p> : flags.map((f) => (
          <button key={f.id} className="pay-flag" onClick={() => onOpenPerson(rows.find((r) => r.user.id === f.id))} type="button">
            <span className={`pay-flag-sev sev-${f.sev}`} aria-hidden />
            <span className="pay-flag-txt"><span className="pay-flag-t">{f.t}</span><span className="pay-flag-d">{f.d}</span></span>
            {f.delta != null && <span className={`pay-flag-delta mono ${f.delta < 0 ? 'pay-neg' : 'pay-pos'}`}>{fmtSigned(f.delta)}</span>}
            <span className="pay-flag-go" aria-hidden>›</span>
          </button>
        ))}
      </div>

      <details className="pay-rest">
        <summary>Show full roster ({rows.length})</summary>
        <div className="table-wrap">
          <table className="pay-register">
            <thead><tr><th>Team member</th><th>Type</th><th className="rt">Reg h</th><th className="rt">OT h</th><th className="rt">Gross</th><th className="rt">vs last</th></tr></thead>
            <tbody>
              {pager.pageRows.map((r) => {
                const d = (r.gross != null && r.prevGross != null) ? r2(r.gross - r.prevGross) : null;
                return (
                  <tr key={r.user.id} className={r.excluded ? 'pay-row-excl' : 'pay-row'} onClick={() => !r.excluded && onOpenPerson(r)}>
                    <td><div className="pay-who"><Avatar initials={r.user.initials} variant={r.user.avatar} size="sm" /><span className="pay-who-name truncate" title={r.user.name}>{r.user.name}</span><StatusTag row={r} /></div></td>
                    <td><PayTypeBadge type={r.payType} /></td>
                    <td className="rt mono">{r.excluded ? '—' : (r.payType === 'per_visit' ? `${(r.hours && r.hours.cleanCount) || 0} cln` : (r.hours ? fmtHours(r.hours.regularMinutes) : '—'))}</td>
                    <td className="rt mono">{!r.excluded && r.payType === 'hourly' && r.hours ? (r.hours.otMinutes ? <span className="pay-ot">{fmtHours(r.hours.otMinutes)}</span> : '0.0h') : '—'}</td>
                    <td className="rt mono pay-gross">{r.excluded ? '—' : fmtMoney(r.gross)}</td>
                    <td className="rt mono">{d == null ? <span className="pay-muted">—</span> : (d === 0 ? <span className="pay-muted">—</span> : <span className={d < 0 ? 'pay-neg' : 'pay-pos'}>{fmtSigned(d)}</span>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ListPager pager={pager} noun="team members" />
      </details>
    </div>
  );
}
