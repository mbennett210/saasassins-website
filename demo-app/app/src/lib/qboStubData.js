// QuickBooks Online DEMO-stub data — PURE and node-safe (no import.meta, no Supabase, no
// React), so it is unit-testable headlessly (scripts/test-qbo-stub.mjs) and can be imported
// by data/demoStubs.js (the ?demo=reset registry) without dragging the auth/network stack
// into the pre-React bootstrap.
//
// It backs lib/qboApi.js's demo STUB (the CS-038 pattern: a STATIC Vite-MODE gate, dead in
// `npm run build`). Everything here is deterministic per (entity, range) so every dashboard
// and Settings state is reproducible in the login-free demo. Money is INTEGER CENTS and the
// QBO identity income − COGS = gross profit holds (THE LAW II.8).

import { dayKey, addDaysKey, addMonthsKey } from './dates.js';
import { rangeDays } from './pnlRange.js';

// The demo stub's localStorage key lives in the fixtures-free data/stubKeys.js, so
// data/demoStubs.js's ?demo=reset registry can name it WITHOUT dragging these fixtures into the
// production bundle (CS-066 C1). qboApi imports the key from there too; this module is reachable
// only through qboApi's demo STUB branch (DCE'd from `npm run build`).

// A fresh stub db: DISCONNECTED, no links. The demo opens on the not-connected state.
export function stubEmptyDb() {
  return { connection: null, links: [] };
}

// The simulated sandbox company a demo "Connect" produces (no popup, no Intuit). Always
// labelled sandbox so the dashboard shows the "test data" pill (decision 3). The name is
// generic (never the client brand) so a re-clone can't leak the previous client's identity
// (the re-skin guarantee; name-ledger enforces it).
export function stubSandboxCompany() {
  return {
    companyName: 'Sandbox Company (QuickBooks)',
    environment: 'sandbox',
    realmId: '9341450000000000',
    status: 'active',
  };
}

// Deterministic 32-bit string hash (FNV-1a-ish) — the seed for a stable per-entity book.
function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Inclusive calendar-day counts, matching api/_lib/qbo/ranges.js (m12 = a year). 'all' is a
// per-entity tenure, longer than every window so revenue never shrinks as the window grows.
const RANGE_DAYS = { day: 1, d10: 10, d15: 15, d30: 30, d60: 60, d90: 90, m12: 365 };
function daysForRange(rangeKey, seed) {
  if (rangeKey === 'all') return 400 + (seed % 500); // 400–899 days of history
  if (RANGE_DAYS[rangeKey]) return RANGE_DAYS[rangeKey];
  // This month, a calendar month or a span of dates: its own day count (lib/pnlRange.js).
  try { return rangeDays(rangeKey); } catch { return 30; }
}

// The QBO entity fixtures the owner links a property to. Deterministic; ids are stable so a
// persisted link keeps resolving. Customers are named the way Clean Space names every building
// in QuickBooks, "0001 Name" (QB-2, GO-2): the demo's seven active accounts (0001–0007, so
// linking one brings its number and the "needs matching" list suggests it), plus buildings the
// app does not have yet — two on their own, two jobs under a management company (whose own
// column is quiet), one made inactive in QuickBooks and one with no activity in twelve months,
// so the list shows what it leaves out and why (QB-12).
// [name, { active, activity, parent }] — active and activity default true; parent is a name.
const CUSTOMERS = [
  ['0001 Las Olas Medical Group'], ['0002 Lakeside Office Park'], ['0003 Gulfstream Logistics'],
  ['0004 Coral Bay HOA'], ['0005 Palmetto Ridge Corp'], ['0006 Bayshore Senior Living'], ['0007 Flagler Townhomes'],
  ['0008 Ball Harbor Village'], ['0009 Brickell Bay Offices'],
  ['Graystar Properties', { activity: false }],
  ['0010 Aventura Lofts', { parent: 'Graystar Properties' }], ['0011 Doral Point', { parent: 'Graystar Properties' }],
  ['0012 Sunset Corporate Center', { active: false }],
  ['0013 Wynwood Creative Lofts', { activity: false }],
];
const CLASSES = [['Janitorial'], ['Floor Care'], ['Day Porter'], ['Special Projects']];
const DEPARTMENTS = [['North Region'], ['Central Region'], ['South Region']];
// Per-dimension rows + id prefix. No top-level `.map()` — the entity rows are built LAZILY in
// stubEntities so this module has NO module-level side effect and thus tree-shakes ENTIRELY out
// of a production build (its only prod importer, qboApi, uses these solely inside its demo STUB
// branch, which DCEs). A top-level .map() would be retained as dead code (CS-066 C1).
const ENTITY_ROWS = { customer: CUSTOMERS, class: CLASSES, department: DEPARTMENTS };
const ENTITY_ID_PREFIX = { customer: '10', class: '20', department: '30' };
const idOf = (type, i) => `${ENTITY_ID_PREFIX[type]}${String(i + 1).padStart(2, '0')}`;

// The link-flow entity list for one dimension (customer | class | department). Unknown → [].
// Ids are stable (`<prefix><NN>`) so a persisted link keeps resolving; a job carries its parent.
export function stubEntities(type) {
  const rows = ENTITY_ROWS[type];
  if (!rows) return [];
  const idByName = new Map(rows.map(([name], i) => [name, idOf(type, i)]));
  return rows.map(([name, opt = {}], i) => ({
    id: idOf(type, i), name, active: opt.active !== false, type,
    parentId: opt.parent ? idByName.get(opt.parent) || null : null,
  }));
}

// The twelve months the demo's activity covers, as the server's 'm12' window does (org zone).
export function stubActivityWindow(now = new Date()) {
  const end = dayKey(now);
  return { start: addDaysKey(addMonthsKey(end, -12), 1), end };
}

// The demo's "activity in the last twelve months" (QB-12): every active customer but the quiet ones.
export function stubCustomerActivity() {
  return new Set(CUSTOMERS
    .map(([, opt = {}], i) => (opt.active !== false && opt.activity !== false ? idOf('customer', i) : null))
    .filter(Boolean));
}

// The deterministic P&L for a single linked entity over a range, in INTEGER CENTS. The QBO
// identity income − COGS = gross profit holds, and revenue scales with the window length so a
// longer range is always at least as much (test-qbo-stub asserts both).
function figuresFor(entityId, rangeKey) {
  const seed = hashStr(entityId);
  const dailyCents = 30000 + (seed % 220000);              // ~$300–$2,500 / day
  const marginBps = 2600 + (hashStr(`${entityId}:margin`) % 2200); // 26.00%–48.00%
  const days = daysForRange(rangeKey, seed);
  const incomeCents = dailyCents * days;
  const grossProfitCents = Math.round((incomeCents * marginBps) / 10000);
  const cogsCents = incomeCents - grossProfitCents;        // identity: income − COGS = GP
  const expensesCents = Math.round(grossProfitCents * 0.35); // operating expenses below GP
  const netOperatingIncomeCents = grossProfitCents - expensesCents;
  return {
    incomeCents,
    cogsCents,
    grossProfitCents,
    expensesCents,
    netOperatingIncomeCents,
    netIncomeCents: netOperatingIncomeCents, // no other income/expense in the stub
  };
}

// ── Illustration pin (DEMO-ONLY) ──────────────────────────────────────────────
// Four seed properties render the EXACT figures approved in the manager-dashboard mockup, so the
// login-free demo shows THAT illustration rather than the hashed book. Keyed by CRM clientId
// (lib/ids seedId('cl', …)). d30 is exact; shorter/longer ranges scale by day count so the QBO
// identity (income − COGS = gross profit) and range monotonicity (day ≤ … ≤ d30 ≤ all) still
// hold (test-qbo-stub). Like everything in this module it tree-shakes out of `npm run build` —
// only qboApi's demo STUB branch imports it (CS-066 C1).
const ILLUSTRATION_D30 = {
  cl_seed_evergreen: { incomeCents: 845000, grossProfitCents: 317000 }, // Las Olas Medical Group
  cl_seed_lakeside: { incomeCents: 1290000, grossProfitCents: 451500 }, // Lakeside Office Park
  cl_seed_cascade: { incomeCents: 615000, grossProfitCents: 184500 },   // Gulfstream Logistics
  cl_seed_mtbaker: { incomeCents: 478000, grossProfitCents: 196000 },   // Coral Bay HOA
};

// income + gross profit → the full section-total set, preserving income − COGS = gross profit.
function figuresFromIncomeGp(incomeCents, grossProfitCents) {
  const cogsCents = incomeCents - grossProfitCents;
  const expensesCents = Math.round(grossProfitCents * 0.35);
  const netOperatingIncomeCents = grossProfitCents - expensesCents;
  return { incomeCents, cogsCents, grossProfitCents, expensesCents, netOperatingIncomeCents, netIncomeCents: netOperatingIncomeCents };
}

// The pinned P&L for one of the illustration properties, or null for any other client (the caller
// then falls back to the hashed figuresFor). d30 is exact; other ranges scale linearly by day
// count, which keeps the identity and the monotonicity the stub guarantees.
function pinnedFiguresFor(clientId, rangeKey) {
  const pin = ILLUSTRATION_D30[clientId];
  if (!pin) return null;
  if (rangeKey === 'd30') return figuresFromIncomeGp(pin.incomeCents, pin.grossProfitCents);
  const days = daysForRange(rangeKey, hashStr(clientId));
  const incomeCents = Math.round((pin.incomeCents * days) / 30);
  const grossProfitCents = Math.round((incomeCents * pin.grossProfitCents) / pin.incomeCents);
  return figuresFromIncomeGp(incomeCents, grossProfitCents);
}

// ── the client hub's INVOICES (client hub redesign, plan 2026-10-08 §3.5) ────────────────────
// The demo book's invoices for one QuickBooks customer, in the SAME parsed shape the server caches
// (api/_lib/qbo/invoices.js): { id, number, totalCents, balanceCents, issuedDay, dueDay, paidDay }
// in INTEGER CENTS and org-zone day keys, relative to `today`, so lib/hubInvoices.js judges every
// status exactly as it does live. Deterministic per customer id: one invoice in every state the
// hub draws — open, overdue, partly paid, paid (with and without a paid day) and a voided one the
// rule drops. Only lib/hubDemo.js reaches it (a demo build's dynamic import), so like the rest of
// this module it is absent from `npm run build`.
export function stubInvoicesFor(entityId, today) {
  const seed = hashStr(`${entityId}:invoices`);
  const monthly = 90000 + (seed % 1200) * 100;          // $900.00–$2,099.00 a month, whole dollars
  const first = 1000 + (seed % 800);
  const day = (n) => addDaysKey(today, n);
  const inv = (i, issued, due, totalCents, balanceCents, paidDay = null) => ({
    id: `${entityId}${String(i).padStart(3, '0')}`,
    number: `CS-${first + 12 - i}`,
    totalCents, balanceCents, issuedDay: day(issued), dueDay: day(due), paidDay: paidDay === null ? null : day(paidDay),
  });
  return [
    inv(1, -9, 5, monthly, monthly),                                    // open
    inv(2, -14, 16, 48000, 18000),                                      // open, partly paid (an extra service)
    inv(3, -39, -9, monthly, monthly),                                  // overdue
    inv(4, -70, -40, monthly, 0, -42),                                  // paid
    inv(5, -100, -70, monthly, 0, -71),                                 // paid
    inv(6, -131, -101, monthly + 26050, 0, null),                       // paid by a credit (no paid day)
    inv(7, -45, -15, 0, 0),                                             // voided: dropped by the rule
  ];
}

// The /pnl accounts array for the persisted links + range (owner scope: every link). Mirrors
// the server account shape; clientName is null (the client view builder resolves it from the
// live roster). An illustration-pinned client uses its approved figures; every other falls back
// to the deterministic hashed book.
export function stubPnlAccounts(links, rangeKey) {
  return (links || []).map((l) => ({
    clientId: l.clientId,
    clientName: null,
    entityType: l.entityType,
    entityName: l.entityName || null,
    ...(pinnedFiguresFor(l.clientId, rangeKey) || figuresFor(l.entityId, rangeKey)),
  }));
}
