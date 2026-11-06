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

import { rangeDays } from '../lib/pnlRange.js';

// 🔴 THE GROSS-PROFIT BANDS (QB-6, Matt 2026-09-29, verbatim): "Bonus on gross profit is
// tracked as: - Above 22%: meets target. - Between 14% and 22%: needs to be on yellow warning.
// - Below 14%: needs to be on red." They REPLACE the 35 / 32 placeholder this file shipped
// with, which put every real account in the red.
//
// TWO NAMED NUMBERS, because the old pair was one constant plus a bare `32` inline — the
// amber floor could not be retuned, or even found. The single `GPM_THRESHOLD` went with it
// (II.5); the book view-model carries both as `gpmThreshold` (green) and `gpmWatch`.
export const GPM_TARGET_PCT = 22;   // at or above → green, meets target
export const GPM_WATCH_PCT = 14;    // at or above (and under target) → amber, yellow warning

// The drill-in's "Revenue by range" bars (Matt's kickoff D3: day / 10 / 15 / 30 days / all-time),
// and the layout picker's range switch.
export const RANGES = [
  { key: 'day', label: 'Today' },
  { key: 'd10', label: '10 days' },
  { key: 'd15', label: '15 days' },
  { key: 'd30', label: '30 days' },
  { key: 'all', label: 'All-time' },
];

// The owner and manager dashboards' WINDOW toggle: the period the whole book is shown for (S111
// ②'s "next", once a longer window no longer asked QuickBooks to summarize the whole book —
// CS-598; QB-10: "the last 12 months"). Labels are catalog lines (UI_RULES §140). The server's
// RANGE_KEYS (api/_lib/qbo/ranges.js) is exactly RANGES plus these (test-qbo-window.mjs).
export const WINDOWS = [
  { key: 'd30', labelKey: 'acctDash.range.d30' },
  { key: 'd60', labelKey: 'acctDash.range.d60' },
  { key: 'd90', labelKey: 'acctDash.range.d90' },
  { key: 'm12', labelKey: 'acctDash.range.m12' },
];
export const DEFAULT_WINDOW = 'd30';

// Fictional daily revenue × days. 'm12' is a year of it; 'all' is each account's tenure; this
// month, a calendar month or a span of dates is its own day count (lib/pnlRange.js).
const RANGE_DAYS = { day: 1, d10: 10, d15: 15, d30: 30, d60: 60, d90: 90, m12: 365 };
function daysOf(rangeKey) {
  if (RANGE_DAYS[rangeKey]) return RANGE_DAYS[rangeKey];
  try { return rangeDays(rangeKey); } catch { return 30; }
}

// 20 accounts in Clean Space's 4-digit-ID + name convention. `daily` = daily
// revenue $, `tenure` = days on the books (drives all-time), `gpm` = gross-profit
// margin %, `pastDue` = $ past due, `inv` = invoices billed (30d), `invPast` =
// count past due.
export const PREVIEW_ACCOUNTS = [
  { id: '0001', name: 'Ball Harbor Village',       daily: 420,  tenure: 640, gpm: 38.2, pastDue: 0,    inv: 24, invPast: 0 },
  { id: '0002', name: 'Brickell Bay Offices',      daily: 880,  tenure: 410, gpm: 41.5, pastDue: 0,    inv: 18, invPast: 0 },
  { id: '0003', name: 'Graystar — Aventura Lofts', daily: 1250, tenure: 520, gpm: 19.4, pastDue: 4820, inv: 30, invPast: 2 },
  { id: '0004', name: 'Graystar — Doral Point',    daily: 1100, tenure: 300, gpm: 11.8, pastDue: 9650, inv: 22, invPast: 3 },
  { id: '0005', name: 'Las Olas Medical Plaza',    daily: 640,  tenure: 720, gpm: 44.0, pastDue: 0,    inv: 26, invPast: 0 },
  { id: '0006', name: 'Sunset Corporate Center',   daily: 970,  tenure: 260, gpm: 36.8, pastDue: 1200, inv: 16, invPast: 1 },
  { id: '0007', name: 'ABC Realty — Midtown',      daily: 520,  tenure: 880, gpm: 21.6, pastDue: 2100, inv: 34, invPast: 1 },
  { id: '0008', name: 'Coral Gables Financial',    daily: 1420, tenure: 190, gpm: 39.9, pastDue: 0,    inv: 12, invPast: 0 },
  { id: '0009', name: 'Wynwood Creative Lofts',    daily: 360,  tenure: 450, gpm: 9.3, pastDue: 3300, inv: 20, invPast: 2 },
  { id: '0010', name: 'Biscayne Tower',            daily: 1680, tenure: 610, gpm: 42.7, pastDue: 0,    inv: 28, invPast: 0 },
  { id: '0011', name: 'Pinecrest Surgical',        daily: 740,  tenure: 540, gpm: 34.3, pastDue: 780,  inv: 24, invPast: 1 },
  { id: '0012', name: 'Flagler Business Park',     daily: 590,  tenure: 370, gpm: 16.2, pastDue: 5400, inv: 19, invPast: 2 },
  { id: '0013', name: 'North Andrews Commerce',    daily: 430,  tenure: 300, gpm: 37.5, pastDue: 0,    inv: 14, invPast: 0 },
  { id: '0014', name: 'Doral Logistics Hub',       daily: 1310, tenure: 220, gpm: 40.6, pastDue: 0,    inv: 11, invPast: 0 },
  { id: '0015', name: 'Brickell City Dental',      daily: 480,  tenure: 660, gpm: 33.8, pastDue: 640,  inv: 27, invPast: 1 },
  { id: '0016', name: 'Palmetto Bay Plaza',        daily: 700,  tenure: 430, gpm: 13.1, pastDue: 7250, inv: 21, invPast: 3 },
  { id: '0017', name: 'Miami Lakes Executive',     daily: 820,  tenure: 350, gpm: 38.9, pastDue: 0,    inv: 15, invPast: 0 },
  { id: '0018', name: 'Kendall Medical Group',     daily: 910,  tenure: 700, gpm: 45.3, pastDue: 0,    inv: 31, invPast: 0 },
  { id: '0019', name: 'South Beach Retail Row',    daily: 560,  tenure: 280, gpm: 14.0, pastDue: 1850, inv: 17, invPast: 1 },
  { id: '0020', name: 'Aventura Asset LLC',        daily: 1150, tenure: 500, gpm: 35.6, pastDue: 0,    inv: 23, invPast: 0 },
];

export function revenueFor(acct, rangeKey) {
  // An account on the books for less than a window earned only its tenure's worth of it.
  const days = rangeKey === 'all' ? acct.tenure : Math.min(daysOf(rangeKey), acct.tenure);
  return acct.daily * days;
}
export function grossProfitFor(acct, rangeKey) {
  return revenueFor(acct, rangeKey) * acct.gpm / 100;
}
export function expenseFor(acct, rangeKey) {
  return revenueFor(acct, rangeKey) - grossProfitFor(acct, rangeKey);
}
export function healthOf(gpm) {
  return gpm >= GPM_TARGET_PCT ? 'green' : (gpm >= GPM_WATCH_PCT ? 'amber' : 'red');
}
export function healthLabel(gpm) {
  const h = healthOf(gpm);
  return h === 'green' ? 'On target' : (h === 'amber' ? 'Watch' : 'Below target');
}
// NOTE: the layout renderers no longer read this file directly. lib/qboView.js maps these
// fictional accounts (and the live QuickBooks feed) into ONE `book` view model, the layouts
// format money via money.js moneyCentsCompact, and the risk sort / portfolio rollups live in
// lib/qboView.js (byRisk) + components/dashboardLayouts.jsx (MiniTiles). The prior formatting
// and rollup helpers here (fmtUsd / fmtPct / rangeLabel / portfolioTotals / accountsByRisk)
// were removed with that refactor (slice-2, replace-means-delete).
