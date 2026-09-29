// Account-Manager Dashboard LAYOUT RENDERERS: the single source of truth for the
// A/B/C/D variant markup. Shared by two consumers:
//   1. DashboardLayoutPicker (the client-review modal that previews all four), and
//   2. AccountDashboard (the LIVE per-role home page: owner lands on C, manager on D;
//      see App.jsx HomeRoute).
//
// Pure presentational components over the design-phase preview data
// (data/dashboardLayoutPreview.js, fictional accounts; the real QuickBooks Online
// feed isn't built yet). No store, no review state: the picker owns the pick/notes
// UI, AccountDashboard owns the page chrome; both just render these.
//
// CSS: the `.dlp-*` block in index.css (tokens-only, no raw hex). The layout grids
// (`.dlp-clay` C, `.dlp-board` D) already collapse to one column at ≤820px.

import {
  PREVIEW_ACCOUNTS, RANGES, GPM_THRESHOLD,
  revenueFor, grossProfitFor, expenseFor, healthOf, healthLabel,
  rangeLabel, fmtUsd, fmtPct, portfolioTotals, accountsByRisk,
} from '../data/dashboardLayoutPreview';

// The four directions (letter, name, one-line description). Used by the picker's
// tabs + the "you chose Direction X" decision line, and by AccountDashboard to look
// up the human name of the role's assigned layout.
export const LAYOUT_VARIANTS = [
  { key: 'A', name: 'Portfolio Table', desc: 'Every account on one sortable line' },
  { key: 'B', name: 'Account Cards', desc: 'A tile per account, health at a glance' },
  { key: 'C', name: 'KPI Cockpit', desc: 'Pick an account, detail beside the list' },
  { key: 'D', name: 'Health Triage', desc: 'Grouped by who needs attention' },
];
export const LAYOUT_NAME = Object.fromEntries(LAYOUT_VARIANTS.map((v) => [v.key, v.name]));

// Short labels for the range segmented control (Today / 10d / 15d / 30d / All-time).
export const RANGE_SHORT = { day: 'Today', d10: '10d', d15: '15d', d30: '30d', all: 'All-time' };

// Portfolio KPI tiles (revenue / past due / book GPM / below-target count) for the
// current range. Header row on variants A and C.
function MiniTiles({ range }) {
  const p = portfolioTotals(range);
  return (
    <div className="dlp-mini">
      <div className="dlp-mtile"><div className="dlp-ml">Revenue · {rangeLabel(range)}</div><div className="dlp-mv">{fmtUsd(p.rev)}</div></div>
      <div className="dlp-mtile"><div className="dlp-ml">Past due</div><div className="dlp-mv due">{fmtUsd(p.past)}</div></div>
      <div className="dlp-mtile"><div className="dlp-ml">Book GPM</div><div className="dlp-mv">{fmtPct(p.bookGpm)}</div></div>
      <div className={`dlp-mtile${p.below ? ' warn' : ''}`}><div className="dlp-ml">Below target</div><div className="dlp-mv">{p.below}</div></div>
    </div>
  );
}

// The account drill-in: revenue-by-range bars + the Revenue − Expense = Gross Profit
// breakdown. Shown beside the rail in variant C.
function AccountDetail({ acct, range }) {
  const h = healthOf(acct.gpm);
  const revs = RANGES.map((r) => ({ label: r.label, val: revenueFor(acct, r.key) }));
  const mx = Math.max(...revs.map((x) => x.val)) || 1;
  return (
    <div className="dlp-detail">
      <div className="dlp-dh">
        <div><span className="dlp-idchip">{acct.id}</span> <strong>{acct.name}</strong></div>
        <span className={`dlp-pill ${h}`}>{healthLabel(acct.gpm)} · {fmtPct(acct.gpm)}</span>
      </div>
      <div className="dlp-dgrid">
        <section className="dlp-dcard">
          <div className="dlp-dcard-t">Revenue by range</div>
          {revs.map((x) => (
            <div className="dlp-rr" key={x.label}>
              <span className="dlp-rr-l">{x.label}</span>
              <span className="dlp-rr-tk"><span className="dlp-rr-fl" style={{ width: `${(x.val / mx * 100).toFixed(1)}%` }} /></span>
              <span className="dlp-rr-v">{fmtUsd(x.val)}</span>
            </div>
          ))}
        </section>
        <section className="dlp-dcard">
          <div className="dlp-dcard-t">Invoices &amp; gross profit ({rangeLabel(range)})</div>
          <div className="dlp-eq"><span>Invoices billed</span><span>{acct.inv}</span></div>
          <div className="dlp-eq"><span>Past due ({acct.invPast})</span><span className="due">{fmtUsd(acct.pastDue)}</span></div>
          <div className="dlp-eq"><span>Revenue</span><span>{fmtUsd(revenueFor(acct, range))}</span></div>
          <div className="dlp-eq"><span>− Expense</span><span>{fmtUsd(expenseFor(acct, range))}</span></div>
          <div className="dlp-eq total"><span>= Gross profit ({fmtPct(acct.gpm)})</span><span>{fmtUsd(grossProfitFor(acct, range))}</span></div>
        </section>
      </div>
    </div>
  );
}

// A (Portfolio Table): every account on one sortable line, worst GPM first.
export function VariantA({ range }) {
  return (
    <>
      <MiniTiles range={range} />
      <div className="dlp-tablewrap">
        <table className="dlp-table">
          <thead><tr><th>Account</th><th className="r">Revenue</th><th className="r">Inv</th><th className="r">Past due</th><th className="r">GPM</th></tr></thead>
          <tbody>
            {accountsByRisk().map((a) => {
              const h = healthOf(a.gpm);
              return (
                <tr key={a.id}>
                  <td><span className="dlp-idchip">{a.id}</span> {a.name}</td>
                  <td className="r">{fmtUsd(revenueFor(a, range))}</td>
                  <td className="r">{a.inv}</td>
                  <td className={`r${a.pastDue > 0 ? ' due' : ''}`}>{a.pastDue > 0 ? fmtUsd(a.pastDue) : '—'}</td>
                  <td className="r"><span className={`dlp-pill ${h}`}>{fmtPct(a.gpm)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// B (Account Cards): a tile per account, health on the left edge + a GPM meter.
export function VariantB({ range }) {
  return (
    <div className="dlp-bgrid">
      {PREVIEW_ACCOUNTS.map((a) => {
        const h = healthOf(a.gpm);
        const fw = Math.min(a.gpm / 60 * 100, 100);
        const th = GPM_THRESHOLD / 60 * 100;
        return (
          <div className={`dlp-acard ${h}`} key={a.id}>
            <div className="dlp-acard-top"><span className="dlp-idchip">{a.id}</span><span className={`dlp-dot ${h}`} /></div>
            <div className="dlp-acard-nm">{a.name}</div>
            <div className="dlp-acard-rv">{fmtUsd(revenueFor(a, range))}</div>
            <div className="dlp-acard-rl">rev · {rangeLabel(range)}</div>
            <div className="dlp-meter"><span className={`dlp-meter-fl ${h}`} style={{ width: `${fw}%` }} /><span className="dlp-meter-th" style={{ left: `${th}%` }} /></div>
            <div className="dlp-acard-ft">
              <span className={`dlp-pill ${h}`}>{fmtPct(a.gpm)}</span>
              {a.pastDue > 0 ? <span className="dlp-due-chip">{fmtUsd(a.pastDue)}</span> : <span className="dlp-ok-chip">Current</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// C (KPI Cockpit): portfolio tiles on top, account rail on the left, the selected
// account's detail on the right (no pop-up). `cSel`/`onSel` are owned by the parent.
export function VariantC({ range, cSel, onSel }) {
  const acct = PREVIEW_ACCOUNTS.find((a) => a.id === cSel) || PREVIEW_ACCOUNTS[0];
  return (
    <>
      <MiniTiles range={range} />
      <div className="dlp-clay">
        <div className="dlp-rail">
          <div className="dlp-rail-h">Your book · 20 accounts</div>
          {accountsByRisk().map((a) => {
            const h = healthOf(a.gpm);
            return (
              <button type="button" key={a.id} className={`dlp-rail-i${a.id === cSel ? ' sel' : ''}`} onClick={() => onSel(a.id)}>
                <span className={`dlp-dot ${h}`} /><span className="dlp-rail-id">{a.id}</span><span className="dlp-rail-nm">{a.name}</span><span className={`dlp-rail-g ${h}`}>{fmtPct(a.gpm)}</span>
              </button>
            );
          })}
        </div>
        <div className="dlp-cdetail"><AccountDetail acct={acct} range={range} /></div>
      </div>
    </>
  );
}

// D (Health Triage): accounts grouped into Below-target / Watch / On-target buckets
// so the problems land first, each bucket sorted worst GPM first.
export function VariantD({ range }) {
  const buckets = [
    { k: 'red', t: 'Below target', test: (a) => a.gpm < 32 },
    { k: 'amber', t: 'Watch', test: (a) => a.gpm >= 32 && a.gpm < GPM_THRESHOLD },
    { k: 'green', t: 'On target', test: (a) => a.gpm >= GPM_THRESHOLD },
  ];
  return (
    <div className="dlp-board">
      {buckets.map((b) => {
        const items = PREVIEW_ACCOUNTS.filter(b.test).sort((x, y) => x.gpm - y.gpm);
        return (
          <section className={`dlp-buk ${b.k}`} key={b.k}>
            <header className="dlp-buk-h"><span className={`dlp-dot ${b.k}`} />{b.t}<span className="dlp-buk-c">{items.length}</span></header>
            {items.map((a) => (
              <div className="dlp-buk-i" key={a.id}>
                <span className="dlp-buk-mn"><span className="dlp-idchip">{a.id}</span>{a.name}</span>
                <span className="dlp-buk-mt">
                  <span className="dlp-buk-rev">{fmtUsd(revenueFor(a, range))}</span>
                  {a.pastDue > 0 ? <span className="dlp-due-chip">{fmtUsd(a.pastDue)}</span> : null}
                  <span className={`dlp-pill ${b.k}`}>{fmtPct(a.gpm)}</span>
                </span>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
