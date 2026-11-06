// QBO dashboard view-model — the ONE mapping layer between a data source (the design-phase
// preview fixture OR the live QuickBooks Online feed) and the shared A/B/C/D layout
// renderers (components/dashboardLayouts.jsx). PURE: no React, no store, no network — so it
// is unit-testable headlessly (scripts/test-qbo-view.mjs) and the layouts stay dumb, rendering
// a `book` view-model without knowing which source it came from (slice-2 decision 6).
//
// Contracts this module owns:
//   • Money is INTEGER CENTS end to end (THE LAW II.8). The layouts format via money.js
//     moneyCentsCompact; nothing here does float math on dollars.
//   • GPM = grossProfit / income, NULL when income is 0 — a property with no income has no
//     margin, so it renders NEUTRAL, never 0% or NaN (decision 4).
//   • Health buckets route through the ONE source of the bands, dashboardLayoutPreview's
//     GPM_TARGET_PCT / GPM_WATCH_PCT (22 / 14 — Matt's QB-6 call, 2026-09-29), plus a NEUTRAL
//     bucket for null GPM.
//   • LIVE mode has no source yet for past due or invoice counts, so those are NULL and the
//     layouts hide the cells cleanly (decision 4). The 4-digit id chip is the customer's own
//     number (client.customerNumber, GO-2) when it has one.
//   • A non-owner is scoped to the properties they supervise (client.supervisorId === their
//     id) — an Operations Manager to their TEAM's (S131, lib/teamScope, the route's own rule:
//     the role is the manager's, the level the roster's). This is the DISPLAY twin of the server's real gate: the /pnl endpoint always
//     answers with the real caller's (owner's) scope, and when the owner is viewing-as a
//     manager we filter client-side so the preview of that manager's view is faithful
//     (decision 8). The server twin (api/quickbooks pnl) is the actual authorization.

import {
  PREVIEW_ACCOUNTS, RANGES, WINDOWS, DEFAULT_WINDOW, GPM_TARGET_PCT, GPM_WATCH_PCT, healthOf as previewHealthOf,
  healthLabel as previewHealthLabel, revenueFor, grossProfitFor, expenseFor,
} from '../data/dashboardLayoutPreview.js';
import { isCustomerNumber } from './customerNumber.js';
import { rangeKind, resolveRange, isRangeKey } from './pnlRange.js';
import { isOpsManagerIn, teamClientIds } from './teamScope.js';

// The dashboards' period from the URL (`?window=…`): one of the picker's rolling WINDOWS, this
// month ('mtd'), a calendar month ('2026-08') or a span of dates ('2026-08-03_2026-09-14') that
// does not start after today — else the default 30 days. A bar-only range (today, 10/15 days,
// all-time) is not a period the picker offers, so a hand-typed `?window=all` reads as the default
// rather than a state the picker cannot show.
const WINDOW_KEYS = new Set(WINDOWS.map((w) => w.key));
export function windowFromParam(raw, opts) {
  if (WINDOW_KEYS.has(raw)) return raw;
  const kind = rangeKind(raw);
  if ((kind === 'mtd' || kind === 'month' || kind === 'span') && isRangeKey(raw, opts)) return raw;
  return DEFAULT_WINDOW;
}

// The first and last day a period covers today, in the org zone; null for a key that is not one.
export function periodDates(key, opts) {
  try { return resolveRange(key, opts); } catch { return null; }
}

// dollars → integer cents. The preview fixture is whole-dollar-ish design data; one rounding
// at the boundary keeps everything downstream in integer cents (no float drift on sums).
const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100);

// GPM = gross profit ÷ income, as a percentage. NULL when income is 0 (decision 4): never a
// divide-by-zero, never a fabricated 0%.
export function gpmOf(grossProfitCents, incomeCents) {
  if (!incomeCents) return null; // 0 / null / undefined income → no margin
  return (grossProfitCents / incomeCents) * 100;
}

// Health bucket. A number routes through the ONE source of the bands (green at/above 22%,
// amber 14–22%, red below 14% — QB-6); null GPM (no income) is neutral.
export function healthOf(gpm) {
  return gpm == null ? 'neutral' : previewHealthOf(gpm);
}
export function healthLabel(gpm) {
  return gpm == null ? 'No income' : previewHealthLabel(gpm);
}

// Worst-margin-first ordering for the rail + portfolio table. Neutral (no-income) properties
// sink to the bottom rather than reading as the most at-risk.
export function byRisk(accounts) {
  return (accounts || []).slice().sort((a, b) => (a.gpm ?? Infinity) - (b.gpm ?? Infinity));
}

// Per-account revenue-by-range bars. `revByRange` (live) is { rangeKey: cents|null }; when a
// range hasn't been fetched yet its bar is null (rendered muted). The CURRENT range is always
// populated from the account's own figure so the main view never shows an empty current bar.
function rangeRevenueRows(revByRange, currentRange, currentCents) {
  return RANGES.map((r) => ({
    key: r.key,
    label: r.label,
    cents: (revByRange && revByRange[r.key] != null)
      ? revByRange[r.key]
      : (r.key === currentRange ? (currentCents ?? null) : null),
  }));
}

// The ONE mapper: a server /pnl account (integer cents) → a layout view model. LIVE shape —
// past due and invoice counts have no live source, so they are NULL and the layouts hide those
// cells (decision 4). `name` and the id chip (the customer number) are resolved by the caller.
export function accountToViewModel(a, { name, idChip = null, rangeRevenue = null } = {}) {
  const gpm = gpmOf(a.grossProfitCents, a.incomeCents);
  return {
    key: a.clientId,
    clientId: a.clientId,
    idChip,                                   // null in live → no id chip
    name: name || a.clientName || a.entityName || a.clientId,
    entityType: a.entityType,
    entityName: a.entityName,
    revenueCents: a.incomeCents,              // QBO Income line
    revenueLabel: 'Income',
    deductionCents: a.cogsCents,              // QBO Cost of sales line (income − cogs = gross profit)
    deductionLabel: 'Cost of sales',
    grossProfitCents: a.grossProfitCents,     // QBO's own Gross Profit line (authoritative)
    gpm,
    health: healthOf(gpm),
    healthLabel: healthLabel(gpm),
    pastDueCents: null,                       // no live source yet (decision 4)
    invCount: null,
    invPastCount: null,
    rangeRevenue,
  };
}

// Build the LIVE book from a /pnl response. `clients` is the live client roster (for the
// display name and the supervisor scope); `users` the roster (an Operations Manager's team);
// `currentUser` is the resolved (possibly viewed-as) perspective; `rangeRevenueByClient` is { clientId: { rangeKey: incomeCents } } filled in as
// the lazy per-range fetches land (decision 3). Returns a disconnected marker when the feed
// isn't connected, so the caller can fall back to the preview home (decision 3).
export function buildLiveBook(pnl, { clients = [], users = [], currentUser = null, rangeRevenueByClient = null } = {}) {
  if (!pnl || pnl.connected === false) return { status: 'disconnected' };
  const clientsById = new Map((clients || []).map((c) => [c && c.id, c]));
  const role = currentUser?.role;
  const uid = currentUser?.id;
  const team = role === 'manager' && uid && isOpsManagerIn(users, { id: uid, role })
    ? teamClientIds(users, clients, uid) : null;

  // View-as / non-owner scope (decision 8). DISPLAY-ONLY: the server already scopes a real
  // non-owner login, so this is a no-op there; when the OWNER views-as a manager the server
  // still answers with the owner's full scope, and this narrows the rendered rows to that
  // manager's supervised properties so the preview of their view is faithful. The server
  // twin (api/quickbooks pnl) is the real authorization boundary.
  const scoped = (pnl.accounts || []).filter((a) => {
    if (role === 'owner') return true;
    if (!uid) return false; // an id-less viewed-as user supervises nothing (never null === null)
    if (team) return team.has(a.clientId);
    const c = clientsById.get(a.clientId);
    return !!c && c.supervisorId === uid;
  });

  const accounts = scoped.map((a) => {
    const client = clientsById.get(a.clientId);
    return accountToViewModel(a, {
      name: (client && client.name) || a.clientName || a.entityName,
      // The four-digit customer number is the live chip (GO-2: "0001 Ball Harbor Village"),
      // when the customer has one; none yet → no chip.
      idChip: (client && isCustomerNumber(client.customerNumber)) ? client.customerNumber : null,
      rangeRevenue: rangeRevenueRows(rangeRevenueByClient?.[a.clientId], pnl.range, a.incomeCents),
    });
  });

  return {
    status: 'ok',
    accounts,
    metrics: { pastDue: false, invoices: false }, // no live source (decision 4)
    environment: pnl.environment || null,
    basis: pnl.basis || null,
    asOf: pnl.asOf || null,
    start: pnl.start || null,
    end: pnl.end || null,
    range: pnl.range,
    sandbox: pnl.environment === 'sandbox',
    gpmThreshold: GPM_TARGET_PCT,
    gpmWatch: GPM_WATCH_PCT,
    count: accounts.length,
  };
}

// Build the PREVIEW book from the design-phase fictional accounts. Keeps the metrics the
// picker shows (past due, invoices, the id chip) and INSERTION order (each variant sorts as
// it needs), so the client-review picker's rendered output is unchanged (decision 6).
export function buildPreviewBook(range) {
  const accounts = PREVIEW_ACCOUNTS.map((a) => {
    const gpm = a.gpm;
    return {
      key: a.id,
      clientId: a.id,
      idChip: a.id,
      name: a.name,
      revenueCents: toCents(revenueFor(a, range)),
      revenueLabel: 'Revenue',
      deductionCents: toCents(expenseFor(a, range)),
      deductionLabel: 'Expense',
      grossProfitCents: toCents(grossProfitFor(a, range)),
      gpm,
      health: healthOf(gpm),
      healthLabel: healthLabel(gpm),
      pastDueCents: toCents(a.pastDue),
      invCount: a.inv,
      invPastCount: a.invPast,
      rangeRevenue: RANGES.map((r) => ({ key: r.key, label: r.label, cents: toCents(revenueFor(a, r.key)) })),
    };
  });
  const dates = periodDates(range);
  return {
    status: 'preview',
    accounts,
    metrics: { pastDue: true, invoices: true },
    environment: null,
    basis: null,
    asOf: null,
    start: dates?.start || null,
    end: dates?.end || null,
    range,
    sandbox: false,
    gpmThreshold: GPM_TARGET_PCT,
    gpmWatch: GPM_WATCH_PCT,
    count: accounts.length,
  };
}

// ── Dashboard first-paint + sub-header helpers (CS-066 C2 / C3) ──────────────

// C2: the account-book sub-header's "Your book, N accounts" clause. While the book is still
// LOADING there is no real count yet (the preview's 20 would flash above the skeleton), so the
// clause is empty and the sub-header shows only the date.
export function bookCountLabel({ loading, count } = {}) {
  if (loading) return '';
  const n = Number(count) || 0;
  return `Your book, ${n} ${n === 1 ? 'account' : 'accounts'}`;
}

// C3: the dashboard's FIRST paint, chosen from a NON-SENSITIVE per-user "was connected last
// time" flag so a cache-first paint is instant (THE LAW II.7) instead of waiting on a
// getQboStatus round-trip. No financial visibility, or unknown / last-known NOT connected →
// paint the preview immediately (load() switches to live only if status says connected). Only a
// last-known-CONNECTED user opens on the skeleton, so live rows never flash the preview first.
export function qboFirstPaintPhase({ hasFinancials, lastKnownConnected } = {}) {
  if (!hasFinancials) return 'preview';
  return lastKnownConnected ? 'live-loading' : 'preview';
}
