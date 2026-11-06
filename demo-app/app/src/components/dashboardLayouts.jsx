// Account-Manager Dashboard LAYOUT RENDERERS: the single source of truth for the A/B/C/D
// variant markup. Shared by two consumers:
//   1. DashboardLayoutPicker (the client-review modal that previews all four), and
//   2. AccountDashboard (the LIVE per-role home page: owner lands on C, manager on D;
//      see App.jsx HomeRoute).
//
// PURELY PRESENTATIONAL over a `book` view-model (lib/qboView.js) passed in as a prop — never
// importing the preview fixture directly (slice-2 decision 6). The book is built either from
// the design-phase preview accounts (buildPreviewBook) or the live QuickBooks Online feed
// (buildLiveBook); these renderers don't know or care which. Money is INTEGER CENTS, shown via
// money.js moneyCentsCompact (THE LAW II.8). `book.metrics` says which cells have a live
// source: in LIVE mode past due, invoice counts and the 4-digit id chip are absent, so those
// cells are hidden cleanly rather than showing a fake 0 (decision 4).
//
// CSS: the `.dlp-*` block in index.css (tokens-only, no raw hex). The layout grids
// (`.dlp-clay` C, `.dlp-board` D) collapse to one column at ≤820px.

import { moneyCentsCompact } from '../lib/money';
import { byRisk } from '../lib/qboView';
import { rangeKind } from '../lib/pnlRange';
import { fmtDate, todayKey } from '../lib/dates';
import { useT } from '../i18n/react';

// The four directions (letter, name, one-line description). Used by the picker's tabs + the
// "you chose Direction X" decision line, and by AccountDashboard to look up the human name of
// the role's assigned layout.
export const LAYOUT_VARIANTS = [
  { key: 'A', name: 'Portfolio Table', desc: 'Every account on one sortable line' },
  { key: 'B', name: 'Account Cards', desc: 'A tile per account, health at a glance' },
  { key: 'C', name: 'KPI Cockpit', desc: 'Pick an account, detail beside the list' },
  { key: 'D', name: 'Health Triage', desc: 'Grouped by who needs attention' },
];
export const LAYOUT_NAME = Object.fromEntries(LAYOUT_VARIANTS.map((v) => [v.key, v.name]));

// Short labels for the layout PICKER's range segmented control (Today / 10d / 15d / 30d / All-time).
export const RANGE_SHORT = { day: 'Today', d10: '10d', d15: '15d', d30: '30d', all: 'All-time' };
// The catalog line naming each window a book can be for — the tile subtitles and the drill-in
// card title (UI_RULES §140). Every preset the server answers (lib/pnlRange.js RANGE_KEYS): the
// drill-in bars plus the dashboards' 30 / 60 / 90-day and 12-month windows, and this month.
export const RANGE_LABEL_KEY = Object.freeze({
  day: 'acctDash.range.day', d10: 'acctDash.range.d10', d15: 'acctDash.range.d15', d30: 'acctDash.range.d30',
  d60: 'acctDash.range.d60', d90: 'acctDash.range.d90', m12: 'acctDash.range.m12', all: 'acctDash.range.all',
  mtd: 'acctDash.range.mtd',
});

// A day label for a period's edge: "Aug 3", with the year when it is not this year's.
function edgeLabel(key, withYear) {
  return fmtDate(key, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

// The words for the period a book covers (lib/pnlRange.js): a preset or this month is its catalog
// line; a calendar month is its name ("August 2026", in the reader's language); a span of dates
// is its first and last day ("Aug 3 – Sep 14"). `start` / `end` are the book's own dates (the
// server's, when live), so the label always matches the figures beside it.
export function periodLabel(t, { range, start, end } = {}) {
  if (RANGE_LABEL_KEY[range]) return t(RANGE_LABEL_KEY[range]);
  const kind = rangeKind(range);
  if (kind === 'month') return fmtDate(`${range}-01`, { month: 'long', year: 'numeric' });
  if (kind === 'span' && start && end) {
    const thisYear = todayKey().slice(0, 4);
    const withYear = start.slice(0, 4) !== thisYear || end.slice(0, 4) !== thisYear;
    if (start === end) return edgeLabel(start, withYear);
    // Inside one month the month is said once: "Aug 15 – 31".
    if (start.slice(0, 7) === end.slice(0, 7)) return `${edgeLabel(start, withYear)} – ${fmtDate(end, { day: 'numeric' })}`;
    return `${edgeLabel(start, withYear)} – ${edgeLabel(end, withYear)}`;
  }
  return '';
}

// GPM percent for display: one decimal, or an em dash when there is no margin (null GPM =
// no income in live mode). Matches the preview's prior fmtPct for every numeric value.
const pct = (gpm) => (gpm == null ? '—' : `${gpm.toFixed(1)}%`);
const usd = moneyCentsCompact;

// The account's id chip + name, or just the name when there is no chip (live has no 4-digit id).
function IdName({ acct, space = true }) {
  if (!acct.idChip) return acct.name;
  return <>{<span className="dlp-idchip">{acct.idChip}</span>}{space ? ' ' : ''}{acct.name}</>;
}

// Portfolio KPI tiles for the current range. Tile 2 is Past due in preview (a live source we
// don't have yet) and Gross profit in live, so the 4-up grid stays full either way.
function MiniTiles({ book }) {
  const t = useT();
  const rev = book.accounts.reduce((s, a) => s + a.revenueCents, 0);
  const gp = book.accounts.reduce((s, a) => s + a.grossProfitCents, 0);
  const past = book.accounts.reduce((s, a) => s + (a.pastDueCents || 0), 0);
  const bookGpm = rev ? (gp / rev) * 100 : null;
  const below = book.accounts.filter((a) => a.gpm != null && a.gpm < book.gpmThreshold).length;
  return (
    <div className="dlp-mini">
      <div className="dlp-mtile"><div className="dlp-ml">Revenue · {periodLabel(t, book)}</div><div className="dlp-mv">{usd(rev)}</div></div>
      {book.metrics.pastDue
        ? <div className="dlp-mtile"><div className="dlp-ml">Past due</div><div className="dlp-mv due">{usd(past)}</div></div>
        : <div className="dlp-mtile"><div className="dlp-ml">Gross profit</div><div className="dlp-mv">{usd(gp)}</div></div>}
      <div className="dlp-mtile"><div className="dlp-ml">Book GPM</div><div className="dlp-mv">{pct(bookGpm)}</div></div>
      <div className={`dlp-mtile${below ? ' warn' : ''}`}><div className="dlp-ml">Below target</div><div className="dlp-mv">{below}</div></div>
    </div>
  );
}

// The account drill-in: revenue-by-range bars + the gross-profit breakdown. Shown beside the
// rail in variant C. In preview the breakdown is Revenue − Expense = Gross profit with the
// invoice rows above; in live it is Income − Cost of sales = Gross profit (the QBO lines), and
// the invoice rows are absent (decision 4).
function AccountDetail({ acct, book }) {
  const t = useT();
  const bars = acct.rangeRevenue || [];
  const mx = Math.max(...bars.map((x) => x.cents || 0), 1);
  const rangeLabel = periodLabel(t, book);
  const title = book.metrics.invoices
    ? `Invoices & gross profit (${rangeLabel})`
    : `Gross profit · ${rangeLabel}`;
  return (
    <div className="dlp-detail">
      <div className="dlp-dh">
        <div><IdName acct={acct} /></div>
        <span className={`dlp-pill ${acct.health}`}>{acct.healthLabel} · {pct(acct.gpm)}</span>
      </div>
      <div className="dlp-dgrid">
        <section className="dlp-dcard">
          <div className="dlp-dcard-t">Revenue by range</div>
          {bars.map((x) => (
            <div className="dlp-rr" key={x.key}>
              <span className="dlp-rr-l">{x.label}</span>
              <span className="dlp-rr-tk"><span className="dlp-rr-fl" style={{ width: `${(x.cents == null ? 0 : (x.cents / mx * 100)).toFixed(1)}%` }} /></span>
              <span className="dlp-rr-v">{x.cents == null ? '—' : usd(x.cents)}</span>
            </div>
          ))}
        </section>
        <section className="dlp-dcard">
          <div className="dlp-dcard-t">{title}</div>
          {book.metrics.invoices && <div className="dlp-eq"><span>Invoices billed</span><span>{acct.invCount}</span></div>}
          {book.metrics.pastDue && <div className="dlp-eq"><span>Past due ({acct.invPastCount})</span><span className="due">{usd(acct.pastDueCents)}</span></div>}
          <div className="dlp-eq"><span>{acct.revenueLabel}</span><span>{usd(acct.revenueCents)}</span></div>
          <div className="dlp-eq"><span>− {acct.deductionLabel}</span><span>{usd(acct.deductionCents)}</span></div>
          <div className="dlp-eq total"><span>= Gross profit ({pct(acct.gpm)})</span><span>{usd(acct.grossProfitCents)}</span></div>
        </section>
      </div>
    </div>
  );
}

// A (Portfolio Table): every account on one sortable line, worst GPM first. Inv + Past due
// columns render only when they have a live source (preview).
export function VariantA({ book }) {
  const m = book.metrics;
  return (
    <>
      <MiniTiles book={book} />
      <div className="dlp-tablewrap">
        <table className="dlp-table">
          <thead><tr>
            <th>Account</th>
            <th className="r">Revenue</th>
            {m.invoices && <th className="r">Inv</th>}
            {m.pastDue && <th className="r">Past due</th>}
            <th className="r">GPM</th>
          </tr></thead>
          <tbody>
            {byRisk(book.accounts).map((a) => (
              <tr key={a.key}>
                <td><IdName acct={a} /></td>
                <td className="r">{usd(a.revenueCents)}</td>
                {m.invoices && <td className="r">{a.invCount}</td>}
                {m.pastDue && <td className={`r${a.pastDueCents > 0 ? ' due' : ''}`}>{a.pastDueCents > 0 ? usd(a.pastDueCents) : '—'}</td>}
                <td className="r"><span className={`dlp-pill ${a.health}`}>{pct(a.gpm)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// B (Account Cards): a tile per account, health on the left edge + a GPM meter.
export function VariantB({ book }) {
  const t = useT();
  return (
    <div className="dlp-bgrid">
      {book.accounts.map((a) => {
        const fw = a.gpm == null ? 0 : Math.min(a.gpm / 60 * 100, 100);
        // The meter's scale is 0–60% GPM, so the tick sits at the GREEN line's share of it
        // (QB-6 moved that line from the 35 placeholder to 22 — lib/qboView `gpmThreshold`).
        const th = book.gpmThreshold / 60 * 100;
        return (
          <div className={`dlp-acard ${a.health}`} key={a.key}>
            <div className="dlp-acard-top">{a.idChip && <span className="dlp-idchip">{a.idChip}</span>}<span className={`dlp-dot ${a.health}`} /></div>
            <div className="dlp-acard-nm">{a.name}</div>
            <div className="dlp-acard-rv">{usd(a.revenueCents)}</div>
            <div className="dlp-acard-rl">rev · {periodLabel(t, book)}</div>
            <div className="dlp-meter"><span className={`dlp-meter-fl ${a.health}`} style={{ width: `${fw}%` }} /><span className="dlp-meter-th" style={{ left: `${th}%` }} /></div>
            <div className="dlp-acard-ft">
              <span className={`dlp-pill ${a.health}`}>{pct(a.gpm)}</span>
              {book.metrics.pastDue
                ? (a.pastDueCents > 0 ? <span className="dlp-due-chip">{usd(a.pastDueCents)}</span> : <span className="dlp-ok-chip">Current</span>)
                : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// C (KPI Cockpit): portfolio tiles on top, account rail on the left, the selected account's
// detail on the right (no pop-up). `cSel`/`onSel` are owned by the parent.
export function VariantC({ book, cSel, onSel }) {
  const ranked = byRisk(book.accounts);
  const acct = book.accounts.find((a) => a.key === cSel) || ranked[0] || book.accounts[0];
  return (
    <>
      <MiniTiles book={book} />
      <div className="dlp-clay">
        <div className="dlp-rail">
          <div className="dlp-rail-h">Your book · {book.count} accounts</div>
          {ranked.map((a) => (
            <button type="button" key={a.key} className={`dlp-rail-i${a.key === (acct && acct.key) ? ' sel' : ''}`} onClick={() => onSel(a.key)}>
              <span className={`dlp-dot ${a.health}`} /><span className="dlp-rail-id">{a.idChip || ''}</span><span className="dlp-rail-nm">{a.name}</span><span className={`dlp-rail-g ${a.health}`}>{pct(a.gpm)}</span>
            </button>
          ))}
        </div>
        <div className="dlp-cdetail">{acct && <AccountDetail acct={acct} book={book} />}</div>
      </div>
    </>
  );
}

// D (Health Triage): accounts grouped into Below-target / Watch / On-target buckets so the
// problems land first, each bucket sorted worst GPM first. A neutral (no-income) bucket
// appears only when a live property has zero income.
export function VariantD({ book }) {
  const buckets = [
    { k: 'red', t: 'Below target' },
    { k: 'amber', t: 'Watch' },
    { k: 'green', t: 'On target' },
    { k: 'neutral', t: 'No income', optional: true },
  ];
  return (
    <div className="dlp-board">
      {buckets.map((b) => {
        const items = byRisk(book.accounts.filter((a) => a.health === b.k));
        if (b.optional && items.length === 0) return null;
        return (
          <section className={`dlp-buk ${b.k}`} key={b.k}>
            <header className="dlp-buk-h"><span className={`dlp-dot ${b.k}`} />{b.t}<span className="dlp-buk-c">{items.length}</span></header>
            {items.map((a) => (
              <div className="dlp-buk-i" key={a.key}>
                <span className="dlp-buk-mn">{a.idChip && <span className="dlp-idchip">{a.idChip}</span>}{a.name}</span>
                <span className="dlp-buk-mt">
                  <span className="dlp-buk-rev">{usd(a.revenueCents)}</span>
                  {book.metrics.pastDue && a.pastDueCents > 0 ? <span className="dlp-due-chip">{usd(a.pastDueCents)}</span> : null}
                  <span className={`dlp-pill ${b.k}`}>{pct(a.gpm)}</span>
                </span>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
