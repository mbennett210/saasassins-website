// Sample-data source for the owner + manager home layout preview.
//
// These fictional accounts drive the owner and manager production HOME PAGE: App.jsx
// HomeRoute renders AccountDashboard (variant C for owner, D for manager), which reads
// PREVIEW_ACCOUNTS from here (CS-013). By the owner's decision (Daniel, 2026-09-25) that
// layout preview SHIPS AS THE PRODUCTION HOME PAGE as-is, with no banner, until live data
// replaces it: the real Account-Manager dashboard will read a read-only QuickBooks Online
// feed (revenue / invoices / past due / gross profit per account) that isn't built yet
// (CS-066). Fictional on purpose (matches the seed convention); swap for the QB feed when
// it lands. (This same data also backs the design-phase layout PICKER, DashboardLayoutPicker.)
//
// Pure module — no React, no store. The picker's variant renderers read from here.

// Bonus threshold: managers keep an account "on target" by holding GPM at/above
// this. Green ≥ threshold, amber 32–threshold (watch), red < 32 (below target).
export const GPM_THRESHOLD = 35;

export const RANGES = [
  { key: 'day', label: 'Today' },
  { key: 'd10', label: '10 days' },
  { key: 'd15', label: '15 days' },
  { key: 'd30', label: '30 days' },
  { key: 'all', label: 'All-time' },
];
const RANGE_DAYS = { day: 1, d10: 10, d15: 15, d30: 30 };

// 20 accounts in Clean Space's 4-digit-ID + name convention. `daily` = daily
// revenue $, `tenure` = days on the books (drives all-time), `gpm` = gross-profit
// margin %, `pastDue` = $ past due, `inv` = invoices billed (30d), `invPast` =
// count past due.
export const PREVIEW_ACCOUNTS = [
  { id: '0001', name: 'Ball Harbor Village',       daily: 420,  tenure: 640, gpm: 38.2, pastDue: 0,    inv: 24, invPast: 0 },
  { id: '0002', name: 'Brickell Bay Offices',      daily: 880,  tenure: 410, gpm: 41.5, pastDue: 0,    inv: 18, invPast: 0 },
  { id: '0003', name: 'Graystar — Aventura Lofts', daily: 1250, tenure: 520, gpm: 33.1, pastDue: 4820, inv: 30, invPast: 2 },
  { id: '0004', name: 'Graystar — Doral Point',    daily: 1100, tenure: 300, gpm: 29.4, pastDue: 9650, inv: 22, invPast: 3 },
  { id: '0005', name: 'Las Olas Medical Plaza',    daily: 640,  tenure: 720, gpm: 44.0, pastDue: 0,    inv: 26, invPast: 0 },
  { id: '0006', name: 'Sunset Corporate Center',   daily: 970,  tenure: 260, gpm: 36.8, pastDue: 1200, inv: 16, invPast: 1 },
  { id: '0007', name: 'ABC Realty — Midtown',      daily: 520,  tenure: 880, gpm: 31.2, pastDue: 2100, inv: 34, invPast: 1 },
  { id: '0008', name: 'Coral Gables Financial',    daily: 1420, tenure: 190, gpm: 39.9, pastDue: 0,    inv: 12, invPast: 0 },
  { id: '0009', name: 'Wynwood Creative Lofts',    daily: 360,  tenure: 450, gpm: 27.6, pastDue: 3300, inv: 20, invPast: 2 },
  { id: '0010', name: 'Biscayne Tower',            daily: 1680, tenure: 610, gpm: 42.7, pastDue: 0,    inv: 28, invPast: 0 },
  { id: '0011', name: 'Pinecrest Surgical',        daily: 740,  tenure: 540, gpm: 34.3, pastDue: 780,  inv: 24, invPast: 1 },
  { id: '0012', name: 'Flagler Business Park',     daily: 590,  tenure: 370, gpm: 30.1, pastDue: 5400, inv: 19, invPast: 2 },
  { id: '0013', name: 'North Andrews Commerce',    daily: 430,  tenure: 300, gpm: 37.5, pastDue: 0,    inv: 14, invPast: 0 },
  { id: '0014', name: 'Doral Logistics Hub',       daily: 1310, tenure: 220, gpm: 40.6, pastDue: 0,    inv: 11, invPast: 0 },
  { id: '0015', name: 'Brickell City Dental',      daily: 480,  tenure: 660, gpm: 33.8, pastDue: 640,  inv: 27, invPast: 1 },
  { id: '0016', name: 'Palmetto Bay Plaza',        daily: 700,  tenure: 430, gpm: 28.9, pastDue: 7250, inv: 21, invPast: 3 },
  { id: '0017', name: 'Miami Lakes Executive',     daily: 820,  tenure: 350, gpm: 38.9, pastDue: 0,    inv: 15, invPast: 0 },
  { id: '0018', name: 'Kendall Medical Group',     daily: 910,  tenure: 700, gpm: 45.3, pastDue: 0,    inv: 31, invPast: 0 },
  { id: '0019', name: 'South Beach Retail Row',    daily: 560,  tenure: 280, gpm: 32.4, pastDue: 1850, inv: 17, invPast: 1 },
  { id: '0020', name: 'Aventura Asset LLC',        daily: 1150, tenure: 500, gpm: 35.6, pastDue: 0,    inv: 23, invPast: 0 },
];

export function revenueFor(acct, rangeKey) {
  const days = rangeKey === 'all' ? acct.tenure : (RANGE_DAYS[rangeKey] || 30);
  return acct.daily * days;
}
export function grossProfitFor(acct, rangeKey) {
  return revenueFor(acct, rangeKey) * acct.gpm / 100;
}
export function expenseFor(acct, rangeKey) {
  return revenueFor(acct, rangeKey) - grossProfitFor(acct, rangeKey);
}
export function healthOf(gpm) {
  return gpm >= GPM_THRESHOLD ? 'green' : (gpm >= 32 ? 'amber' : 'red');
}
export function healthLabel(gpm) {
  const h = healthOf(gpm);
  return h === 'green' ? 'On target' : (h === 'amber' ? 'Watch' : 'Below target');
}
export function rangeLabel(rangeKey) {
  const r = RANGES.find((x) => x.key === rangeKey);
  return r ? r.label : '';
}
export function fmtUsd(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
export function fmtPct(n) {
  return n.toFixed(1) + '%';
}

// Portfolio rollup for the current range: total revenue, total past due, the
// revenue-weighted book GPM, and counts of below-target / owing accounts.
export function portfolioTotals(rangeKey) {
  let rev = 0, past = 0, gp = 0, below = 0, owing = 0;
  PREVIEW_ACCOUNTS.forEach((a) => {
    rev += revenueFor(a, rangeKey);
    past += a.pastDue;
    gp += grossProfitFor(a, rangeKey);
    if (a.gpm < GPM_THRESHOLD) below += 1;
    if (a.pastDue > 0) owing += 1;
  });
  return { rev, past, bookGpm: rev ? gp / rev * 100 : 0, below, owing, count: PREVIEW_ACCOUNTS.length };
}

// Worst-GPM-first — the ordering every list view uses so at-risk accounts float up.
export function accountsByRisk() {
  return PREVIEW_ACCOUNTS.slice().sort((a, b) => a.gpm - b.gpm);
}
