// QBO dashboard view-model mapper (pure, offline). No network, no Supabase, no React.
//
// The ONE mapping function (API account -> dashboard view model) lives in
// src/lib/qboView.js (DEV_PLAYBOOK 3.6.4 / the slice-2 decision 6). This suite pins:
//   • money passes through as INTEGER CENTS (never re-derived by float math) — II.8;
//   • GPM = grossProfit / income, and is NULL when income is 0 (neutral health, never a
//     divide-by-zero or a fake 0%) — decision 4;
//   • health buckets against the SOURCE-OF-TRUTH band constants (GPM_TARGET_PCT /
//     GPM_WATCH_PCT), never a restated 22 or 14;
//   • in LIVE mode the metrics with no live source (past due, invoices, the 4-digit id chip)
//     are NULL so the UI hides those cells cleanly — decision 4;
//   • View-as scoping: the server answers with the owner's (full) scope; a non-owner sees
//     only the properties they supervise (client.supervisorId === their id) — decision 8;
//   • the preview book (the design-phase 20 fictional accounts) keeps its shape so the
//     client-review picker's output is unchanged — decision 6.
//
//   node scripts/test-qbo-view.mjs
import {
  accountToViewModel, gpmOf, healthOf, healthLabel, byRisk, buildLiveBook, buildPreviewBook,
} from '../src/lib/qboView.js';
// Namespace import so the CS-066 follow-up helpers (added in the fix) resolve to `undefined`
// pre-fix — a clean assertion FAIL — instead of a module-link crash that aborts the suite.
import * as qboViewNs from '../src/lib/qboView.js';
import { GPM_TARGET_PCT, GPM_WATCH_PCT, PREVIEW_ACCOUNTS, RANGES } from '../src/data/dashboardLayoutPreview.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// A representative /pnl account (server shape) — every field integer cents.
const apiAccount = (over = {}) => ({
  clientId: 'cl_a', clientName: 'Ball Harbor Village', entityType: 'customer', entityName: 'Ball Harbor (QBO)',
  incomeCents: 1000000, cogsCents: 380000, grossProfitCents: 620000, expensesCents: 200000,
  netOperatingIncomeCents: 420000, netIncomeCents: 420000, ...over,
});

// ── 1. mapper: money is cents passthrough, never re-derived ──────────────────
const vm = accountToViewModel(apiAccount(), { name: 'Ball Harbor Village', idChip: null });
eq('revenueCents is incomeCents passthrough', vm.revenueCents, 1000000);
eq('grossProfitCents passthrough', vm.grossProfitCents, 620000);
eq('deductionCents is cogsCents (live: "Cost of sales")', vm.deductionCents, 380000);
eq('deductionLabel is Cost of sales (live)', vm.deductionLabel, 'Cost of sales');
eq('revenueLabel is Income (live)', vm.revenueLabel, 'Income');
eq('name is the resolved client name', vm.name, 'Ball Harbor Village');
eq('key is the clientId (stable in live)', vm.key, 'cl_a');

// ── 2. GPM = grossProfit / income; null when income is 0 ─────────────────────
eq('gpmOf(620000,1000000) = 62', gpmOf(620000, 1000000), 62);
eq('gpmOf(3800,10000) = 38', gpmOf(3800, 10000), 38);
eq('gpmOf(3810,10000) = 38.1', gpmOf(3810, 10000), 38.1);
eq('gpmOf(gp, 0) is NULL (never divide-by-zero, never a fake 0%)', gpmOf(500, 0), null);
eq('gpmOf(0, 0) is NULL', gpmOf(0, 0), null);
eq('mapper: gpm null when income 0', accountToViewModel(apiAccount({ incomeCents: 0, grossProfitCents: 0 }), { name: 'X' }).gpm, null);

// ── 3. health buckets against the SOURCE-OF-TRUTH constant ───────────────────
// Assert against the imported band constants, never a restated 22 / 14 (THE LAW II.3).
eq('health AT the target is green', healthOf(GPM_TARGET_PCT), 'green');
eq('health just below the target is amber', healthOf(GPM_TARGET_PCT - 0.1), 'amber');
eq('health AT the watch floor is amber', healthOf(GPM_WATCH_PCT), 'amber');
eq('health just below the watch floor is red', healthOf(GPM_WATCH_PCT - 0.1), 'red');
eq('a margin between the two bands is amber', healthOf((GPM_TARGET_PCT + GPM_WATCH_PCT) / 2), 'amber');
eq('a margin well under the watch floor is red', healthOf(GPM_WATCH_PCT / 2), 'red');
eq('health of null gpm is neutral (no income)', healthOf(null), 'neutral');
eq('healthLabel green', healthLabel(GPM_TARGET_PCT + 1), 'On target');
eq('healthLabel amber', healthLabel((GPM_TARGET_PCT + GPM_WATCH_PCT) / 2), 'Watch');
eq('healthLabel red', healthLabel(10), 'Below target');
eq('healthLabel neutral', healthLabel(null), 'No income');

// ── 4. LIVE mode hides the metrics with no live source ───────────────────────
eq('live: no 4-digit id chip', vm.idChip, null);
eq('live: pastDueCents hidden (null, never a fake 0)', vm.pastDueCents, null);
eq('live: invCount hidden (null)', vm.invCount, null);
eq('live: invPastCount hidden (null)', vm.invPastCount, null);

// ── 5. buildLiveBook + View-as scoping (decision 8) ──────────────────────────
const clients = [
  { id: 'cl_a', name: 'Ball Harbor Village', supervisorId: 'u_m1' },
  { id: 'cl_b', name: 'Brickell Bay Offices', supervisorId: 'u_m2' },
  { id: 'cl_c', name: 'Las Olas Medical Plaza', supervisorId: 'u_m1' },
];
const pnl = {
  connected: true, environment: 'sandbox', basis: 'Accrual', range: 'd30',
  start: '2026-08-27', end: '2026-09-25', asOf: '2026-09-25T12:00:00.000Z',
  accounts: [
    apiAccount({ clientId: 'cl_a' }),
    apiAccount({ clientId: 'cl_b', incomeCents: 500000, grossProfitCents: 150000, cogsCents: 350000 }),
    apiAccount({ clientId: 'cl_c', incomeCents: 800000, grossProfitCents: 260000, cogsCents: 540000 }),
  ],
};
const ownerBook = buildLiveBook(pnl, { clients, currentUser: { id: 'u_owner', role: 'owner' } });
eq('owner sees every linked property (server scope)', ownerBook.accounts.length, 3);
eq('owner book status ok', ownerBook.status, 'ok');
eq('book carries the sandbox flag', ownerBook.sandbox, true);
eq('book carries the basis', ownerBook.basis, 'Accrual');
eq('book carries asOf', ownerBook.asOf, '2026-09-25T12:00:00.000Z');
eq('book count matches rendered rows', ownerBook.count, 3);
eq('live book hides past-due metric family', ownerBook.metrics.pastDue, false);
eq('live book hides invoices metric family', ownerBook.metrics.invoices, false);

const m1Book = buildLiveBook(pnl, { clients, currentUser: { id: 'u_m1', role: 'manager' } });
eq('manager m1 sees only their supervised properties', m1Book.accounts.length, 2);
ok('m1 sees cl_a + cl_c', m1Book.accounts.every((a) => a.clientId === 'cl_a' || a.clientId === 'cl_c'));
const m2Book = buildLiveBook(pnl, { clients, currentUser: { id: 'u_m2', role: 'manager' } });
eq('manager m2 sees only cl_b', m2Book.accounts.length, 1);
eq('m2 account is cl_b', m2Book.accounts[0].clientId, 'cl_b');
const noneBook = buildLiveBook(pnl, { clients, currentUser: { id: 'u_none', role: 'manager' } });
eq('a manager supervising none of the linked properties sees an empty book', noneBook.accounts.length, 0);
eq('empty scoped book count is 0', noneBook.count, 0);
// The name is resolved from the live client roster, then the API name, then the entity name.
eq('live account name resolves from the client roster', m2Book.accounts[0].name, 'Brickell Bay Offices');

// VIEW-AS (decision 8): the /pnl endpoint ALWAYS answers with the owner's (full) scope; when
// the owner views-as a manager, that SAME full response is filtered client-side to the
// manager's supervised properties. `pnl` above IS the owner-scope response (all 3 accounts),
// so feeding it with currentUser = a manager is exactly the view-as render — it must contain
// ONLY that manager's rows and never leak a property they don't supervise (the cache holds
// the owner-scope response; the render re-scopes per viewed-as user).
const viewAsM1 = buildLiveBook(pnl, { clients, currentUser: { id: 'u_m1', role: 'manager' } });
eq('view-as m1: owner-scope response filtered to m1 only', viewAsM1.accounts.map((a) => a.clientId).sort().join(','), 'cl_a,cl_c');
ok('view-as m1 never leaks cl_b (m2 supervises it, not m1)', !viewAsM1.accounts.some((a) => a.clientId === 'cl_b'));

// disconnected passthrough
eq('buildLiveBook on a disconnected response yields status disconnected',
  buildLiveBook({ connected: false }, { clients, currentUser: { id: 'u_owner', role: 'owner' } }).status, 'disconnected');

// ── 5b. byRisk orders worst-margin first, no-income last ─────────────────────
const riskInput = [
  { key: 'g', gpm: 42 }, { key: 'r', gpm: 28 }, { key: 'n', gpm: null }, { key: 'a', gpm: 33 },
];
const ranked = byRisk(riskInput);
eq('byRisk orders red, amber, green, then no-income (worst margin first, null last)', ranked.map((x) => x.key).join(','), 'r,a,g,n');
eq('byRisk does not mutate its input', riskInput.map((x) => x.key).join(','), 'g,r,n,a');

// ── 6. preview book keeps the picker's shape (decision 6) ────────────────────
const preview = buildPreviewBook('d30');
eq('preview book renders all 20 fictional accounts', preview.accounts.length, PREVIEW_ACCOUNTS.length);
eq('preview shows the 4-digit id chip', preview.accounts[0].idChip, PREVIEW_ACCOUNTS[0].id);
eq('preview carries the raw gpm from the fixture', preview.accounts[0].gpm, PREVIEW_ACCOUNTS[0].gpm);
eq('preview keeps the past-due metric', preview.metrics.pastDue, true);
eq('preview keeps the invoices metric', preview.metrics.invoices, true);
eq('preview account revenue is integer cents', Number.isInteger(preview.accounts[0].revenueCents), true);
eq('preview account carries per-range revenue rows for the bars', Array.isArray(preview.accounts[0].rangeRevenue), true);
ok('preview rangeRevenue has an integer-cents row per RANGES key',
  RANGES.every((r) => {
    const row = preview.accounts[0].rangeRevenue.find((x) => x.key === r.key);
    return row && Number.isInteger(row.cents);
  }));
eq('preview book is not a sandbox live view', preview.sandbox, false);
eq('preview book status is preview', preview.status, 'preview');

// ── F4 (CS-066): an id-less viewed-as user matches NOTHING (never null === null) ──
{
  const idlessClients = [{ id: 'cl_ns', name: 'Unassigned Plaza', supervisorId: null }];
  const idlessPnl = { connected: true, environment: 'sandbox', basis: 'Accrual', range: 'd30', accounts: [apiAccount({ clientId: 'cl_ns' })] };
  const idlessBook = buildLiveBook(idlessPnl, { clients: idlessClients, currentUser: { id: null, role: 'manager' } });
  eq('🔴 F4 client: an id-less viewed-as manager sees ZERO rows (never null === null)', idlessBook.accounts.length, 0);
  const undefBook = buildLiveBook(idlessPnl, { clients: idlessClients, currentUser: { role: 'manager' } });
  eq('F4 client: an undefined viewer id also sees zero rows', undefBook.accounts.length, 0);
}

// ── C2 (CS-066): the dashboard sub-header count clause is NEUTRAL while loading ──
{
  const f = qboViewNs.bookCountLabel;
  ok('🔴 C2: loading → neutral clause (no bogus preview count above the skeleton)', typeof f === 'function' && f({ loading: true, count: 20 }) === '');
  ok('C2: loaded → "Your book, N accounts"', typeof f === 'function' && f({ loading: false, count: 3 }) === 'Your book, 3 accounts');
  ok('C2: singular account label', typeof f === 'function' && f({ loading: false, count: 1 }) === 'Your book, 1 account');
}

// ── C3 (CS-066): the FIRST paint is chosen from a last-known-connection flag ──
{
  const f = qboViewNs.qboFirstPaintPhase;
  ok('🔴 C3: last-known connected → skeleton (no preview flash before live)', typeof f === 'function' && f({ hasFinancials: true, lastKnownConnected: true }) === 'live-loading');
  ok('C3: last-known NOT connected → instant preview', typeof f === 'function' && f({ hasFinancials: true, lastKnownConnected: false }) === 'preview');
  ok('C3: unknown (first-ever load) → instant preview', typeof f === 'function' && f({ hasFinancials: true, lastKnownConnected: undefined }) === 'preview');
  ok('C3: no financial visibility → instant preview regardless', typeof f === 'function' && f({ hasFinancials: false, lastKnownConnected: true }) === 'preview');
}

console.log(`\nqbo-view: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
