// QBO ProfitAndLoss parser + range windows (pure, offline). No network, no Supabase.
//
// Oracles: (1) the REAL responses Intuit's sandbox company returned on 2026-09-28, captured by
// scripts/qbo-sandbox-probe.mjs into scripts/fixtures/qbo/ — checked against INDEPENDENT
// sources, never against the parser's own premise: the Customer query API's id → name list
// (entities-customer.json), Intuit's separate summarize_column_by=Total report
// (pnl-Total-d30.json), and the accounting identity (entity columns + the Not Specified
// column = TOTAL, per section, to the cent); (2) Intuit's documented single-column sample for
// the Summary.ColData / ColData row shapes. Every money figure is asserted in INTEGER CENTS
// parsed by a strict decimal-string parser — no float math.
//
// History: the parser first read a per-entity column's id from a MetaData entry named 'ID',
// built from synthetic fixtures before any live company existed. The sandbox probe showed
// Intuit tags EVERY column with MetaData ColKey (the entity id, or 'account' /
// 'not_specified' / 'total'): 0 of 17 by-customer columns mapped. Those synthetic fixtures
// encoded the false premise and were deleted (a test that inherits the implementation's
// premise proves only that the mistake is self-consistent, THE LAW II.3).
//
//   node scripts/test-qbo-report.mjs
import { readFileSync } from 'node:fs';
import {
  centsFromDecimalString, columnEntityMap, parseProfitAndLoss, attributeToLinked, PNL_GROUPS,
  reportFilterIds, MAX_REPORT_FILTER_IDS,
} from '../api/_lib/qbo/report.js';
import { RANGE_KEYS, resolveRange, ALL_TIME_START } from '../api/_lib/qbo/ranges.js';
import { RANGES, WINDOWS } from '../src/data/dashboardLayoutPreview.js';
import { dayKey, addDaysKey, diffDaysKey } from '../src/lib/dates.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/qbo/${name}.json`, import.meta.url), 'utf8'));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const throws = (label, fn) => { let t = false; try { fn(); } catch { t = true; } ok(label, t, 'expected a throw'); };

// ── 1. strict decimal-string → integer cents ────────────────────────────────
eq('cents "1234.56" → 123456', centsFromDecimalString('1234.56'), 123456);
eq('cents "1234.5" → 123450', centsFromDecimalString('1234.5'), 123450);
eq('cents "1234" → 123400', centsFromDecimalString('1234'), 123400);
eq('cents "0" → 0', centsFromDecimalString('0'), 0);
eq('cents "" → 0', centsFromDecimalString(''), 0);
eq('cents null → 0', centsFromDecimalString(null), 0);
eq('cents undefined → 0', centsFromDecimalString(undefined), 0);
eq('cents "-50.00" → -5000 (negatives kept)', centsFromDecimalString('-50.00'), -5000);
eq('cents "-0.01" → -1', centsFromDecimalString('-0.01'), -1);
eq('cents "0.1" → 10', centsFromDecimalString('0.1'), 10);
eq('cents "  12.30  " (trim) → 1230', centsFromDecimalString('  12.30  '), 1230);
eq('cents "1,234.56" (comma stripped) → 123456', centsFromDecimalString('1,234.56'), 123456);
eq('cents "+7.00" → 700', centsFromDecimalString('+7.00'), 700);
// No float error: 0.1 + 0.2 style money that a Number path would fumble.
eq('cents "8014.15" exact → 801415', centsFromDecimalString('8014.15'), 801415);
throws('cents "abc" throws (surfaces API drift)', () => centsFromDecimalString('abc'));
throws('cents "1.2.3" throws', () => centsFromDecimalString('1.2.3'));

// ── 2. column → entity-id mapping, on the REAL by-customer report ───────────
// Oracle: the Customer query API (entities-customer.json) — an independent id → name list.
const CUSTOMERS_D30 = fixture('pnl-Customers-d30');
const CUSTOMER_LIST = fixture('entities-customer');
const customerName = new Map(CUSTOMER_LIST.map((c) => [String(c.id), c.name]));
const realMap = columnEntityMap(CUSTOMERS_D30.Columns.Column);
const entityCols = realMap.filter((c) => c.entityId);
eq('real report: one map entry per column', realMap.length, CUSTOMERS_D30.Columns.Column.length);
ok('real report: per-customer columns ARE mapped (the live bug mapped 0 of 17)', entityCols.length > 0, `mapped ${entityCols.length}`);
ok('every mapped column is a real customer id from the Customer API',
  entityCols.every((c) => customerName.has(c.entityId)), JSON.stringify(entityCols.filter((c) => !customerName.has(c.entityId))));
ok('every mapped column title is that customer\'s name',
  entityCols.every((c) => customerName.get(c.entityId) === c.title), JSON.stringify(entityCols.filter((c) => customerName.get(c.entityId) !== c.title).map((c) => [c.entityId, c.title])));
eq('column 0 (the row label) → no entity', realMap[0].entityId, null);
const kinds = realMap.map((c) => c.kind);
eq('exactly one TOTAL column', kinds.filter((k) => k === 'total').length, 1);
eq('the Not Specified column is recognised as unassigned (not an entity)', kinds.filter((k) => k === 'unassigned').length, 1);
// Sub-customers: a parent's "Total <parent>" roll-up repeats the parent's id AFTER its
// sub-customer columns. It is a roll-up, never a second entity (else money counts twice).
const colKeys = CUSTOMERS_D30.Columns.Column.map((c) => c.MetaData.find((m) => m.Name === 'ColKey').Value);
const repeatedIds = [...new Set(colKeys.filter((k, i) => colKeys.indexOf(k) !== i))];
ok('the real report has a parent with sub-customers (a repeated id)', repeatedIds.length > 0, JSON.stringify(repeatedIds));
eq('each repeated id\'s LAST column is a roll-up', repeatedIds.every((id) => realMap[colKeys.lastIndexOf(id)].kind === 'rollup'), true);
eq('each repeated id\'s FIRST column is the parent\'s own entity column', repeatedIds.every((id) => realMap[colKeys.indexOf(id)].kind === 'entity'), true);
eq('every other money column is an entity', kinds.filter((k) => k === 'entity').length, realMap.length - 3 - repeatedIds.length);

// ── 3. Total-column sample (Intuit's documented single-column shape) ─────────
// Sections carry the group total in Summary.ColData; the GrossProfit / NetOperatingIncome
// / NetIncome summary rows carry it in ColData directly — the parser reads both shapes.
const TOTAL_SAMPLE = {
  Header: { ReportBasis: 'Accrual', StartPeriod: '2026-01-01', EndPeriod: '2026-01-31', Currency: 'USD' },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: {
    Row: [
      { group: 'Income', type: 'Section', Summary: { ColData: [{ value: 'Total Income' }, { value: '1000.00' }] } },
      { group: 'COGS', type: 'Section', Summary: { ColData: [{ value: 'Total COGS' }, { value: '400.00' }] } },
      { group: 'GrossProfit', type: 'Data', ColData: [{ value: 'GROSS PROFIT' }, { value: '600.00' }] },
      { group: 'Expenses', type: 'Section', Summary: { ColData: [{ value: 'Total Expenses' }, { value: '250.00' }] } },
      { group: 'NetOperatingIncome', type: 'Data', ColData: [{ value: 'NET OPERATING INCOME' }, { value: '350.00' }] },
      { group: 'NetIncome', type: 'Data', ColData: [{ value: 'NET INCOME' }, { value: '350.00' }] },
    ],
  },
};
const totalParsed = parseProfitAndLoss(TOTAL_SAMPLE);
eq('basis is recorded from Header.ReportBasis', totalParsed.basis, 'Accrual');
// The Total column has no entity id, so it lands in `total`, not `entities`.
eq('Total sample: no per-entity rows', totalParsed.entities.length, 0);
eq('Total sample: incomeCents', totalParsed.total.incomeCents, 100000);
eq('Total sample: cogsCents', totalParsed.total.cogsCents, 40000);
eq('Total sample: grossProfitCents (QBO line, not income-cogs by luck)', totalParsed.total.grossProfitCents, 60000);
eq('Total sample: expensesCents', totalParsed.total.expensesCents, 25000);
eq('Total sample: netOperatingIncomeCents', totalParsed.total.netOperatingIncomeCents, 35000);
eq('Total sample: netIncomeCents', totalParsed.total.netIncomeCents, 35000);
eq('Total sample: missing OtherIncome → 0', totalParsed.total.otherIncomeCents, 0);
eq('Total sample: missing OtherExpenses → 0', totalParsed.total.otherExpensesCents, 0);
ok('PNL_GROUPS carries every documented section group', PNL_GROUPS.includes('Income') && PNL_GROUPS.includes('GrossProfit') && PNL_GROUPS.includes('NetIncome'));

// ── 4. The REAL by-customer report parsed — the shape the dashboard uses ─────
const cust = parseProfitAndLoss(CUSTOMERS_D30);
eq('real report: basis recorded', cust.basis, CUSTOMERS_D30.Header.ReportBasis);
eq('real report: one parsed entity per mapped customer column', cust.entities.length, entityCols.length);
ok('real report: each parsed entity carries its customer name', cust.entities.every((e) => customerName.get(e.entityId) === e.entityName));
ok('real report: at least one customer has income in the window', cust.entities.some((e) => e.incomeCents > 0));
// Oracle: Intuit's SEPARATE summarize_column_by=Total report for the same window.
const TOTAL_D30 = parseProfitAndLoss(fixture('pnl-Total-d30'));
for (const f of ['incomeCents', 'cogsCents', 'grossProfitCents', 'expensesCents', 'netIncomeCents']) {
  eq(`TOTAL column ${f} = the separate Total report`, cust.total[f], TOTAL_D30.total[f]);
}
ok('the unassigned (Not Specified) column is parsed apart from the entities', cust.unassigned && typeof cust.unassigned.incomeCents === 'number');
// Accounting identity, to the cent: every customer column + Not Specified = TOTAL.
for (const f of ['incomeCents', 'cogsCents', 'expensesCents', 'netIncomeCents']) {
  const sum = cust.entities.reduce((s, e) => s + e[f], 0) + cust.unassigned[f];
  eq(`Σ customers + Not Specified = TOTAL (${f})`, sum, cust.total[f]);
}
// ── 4b. attribution: each column's money goes to the nearest LINKED property ──
// Oracle: the raw Income row of the real report, read by column index (not through the parser).
const incomeRow = CUSTOMERS_D30.Rows.Row.find((r) => r.group === 'Income').Summary.ColData;
const incomeAt = (i) => centsFromDecimalString(incomeRow[i].value);
const parentId = repeatedIds[0];
const parentOwnIdx = colKeys.indexOf(parentId);
const parentRollupIdx = colKeys.lastIndexOf(parentId);
const subIds = colKeys.slice(parentOwnIdx + 1, parentRollupIdx);
ok('the parent has at least one sub-customer column', subIds.length > 0, JSON.stringify(subIds));
const subId = subIds[0];
const parentOwnIncome = incomeAt(parentOwnIdx);
const subIncome = incomeAt(colKeys.indexOf(subId));
const subtreeIncome = incomeAt(parentRollupIdx);
{
  const only = attributeToLinked(cust, new Set([parentId]));
  eq('parent linked alone → its whole subtree (the roll-up figure)', only.get(parentId)?.incomeCents, subtreeIncome);
  const both = attributeToLinked(cust, new Set([parentId, subId]));
  eq('parent + sub-customer both linked → the parent keeps only its own amounts', both.get(parentId)?.incomeCents, parentOwnIncome);
  eq('parent + sub-customer both linked → the sub-customer gets its own amounts', both.get(subId)?.incomeCents, subIncome);
  const subOnly = attributeToLinked(cust, new Set([subId]));
  eq('sub-customer linked alone → its own amounts', subOnly.get(subId)?.incomeCents, subIncome);
  ok('sub-customer linked alone → the unlinked parent gets nothing', !subOnly.has(parentId));
  const everyone = attributeToLinked(cust, new Set(cust.entities.map((e) => e.entityId)));
  const attributed = [...everyone.values()].reduce((s, f) => s + f.incomeCents, 0);
  eq('every entity linked → Σ attributed income = TOTAL − Not Specified (nothing counted twice)', attributed, cust.total.incomeCents - cust.unassigned.incomeCents);
  eq('nothing linked → nothing attributed', attributeToLinked(cust, new Set()).size, 0);
}

// A dimension the sandbox company does not use: no entities, but the TOTAL still matches.
const classes = parseProfitAndLoss(fixture('pnl-Classes-d30'));
eq('no classes in use → no class entities', classes.entities.length, 0);
eq('by-class report TOTAL income = the separate Total report', classes.total.incomeCents, TOTAL_D30.total.incomeCents);

// A period with NO transactions, as Intuit really answers it (NoReportData=true: no entity
// columns, every money cell ''). Captured by the first probe run, whose "all" window was one day
// long (the CompanyStartDate defect above). Every dimension must parse to zeros, never throw.
for (const dim of ['Customers', 'Classes', 'Departments', 'Total']) {
  const raw = fixture(`pnl-${dim}-empty`);
  ok(`empty ${dim} fixture is the real no-data shape`, raw.Header?.Option?.some((o) => o.Name === 'NoReportData' && o.Value === 'true'), JSON.stringify(raw.Header?.Option));
  const empty = parseProfitAndLoss(raw);
  eq(`empty ${dim}: no entities`, empty.entities.length, 0);
  ok(`empty ${dim}: TOTAL and Not Specified are all zero`, Object.values(empty.total).every((v) => v === 0) && Object.values(empty.unassigned).every((v) => v === 0), JSON.stringify(empty));
  eq(`empty ${dim}: a linked property is attributed nothing`, attributeToLinked(empty, new Set(['1'])).size, 0);
}

// ── 5. GrossProfit falls back to income − COGS only when the QBO line is absent ─
const NO_GP_LINE = {
  Header: {},
  Columns: { Column: [{ ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] }, { ColTitle: 'X', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '9' }] }] },
  Rows: {
    Row: [
      { group: 'Income', Summary: { ColData: [{ value: 'Income' }, { value: '900.00' }] } },
      { group: 'COGS', Summary: { ColData: [{ value: 'COGS' }, { value: '250.00' }] } },
    ],
  },
};
const noGp = parseProfitAndLoss(NO_GP_LINE).entities[0];
eq('GrossProfit fallback = income − COGS when the line is absent', noGp.grossProfitCents, 65000);

// ── 6. range windows in the ORG zone ────────────────────────────────────────
// The drill-in bars (RANGES) plus the window toggle (WINDOWS) — test-qbo-window.mjs owns the rest.
eq('RANGE_KEYS match the dashboard RANGES + WINDOWS (source of truth)',
  [...RANGE_KEYS].sort().join(','), [...new Set([...RANGES, ...WINDOWS].map((r) => r.key))].sort().join(','));

const TZ = 'America/Los_Angeles';
// A fixed instant: 2026-06-15T02:00:00Z is still 2026-06-14 (19:00) in Los Angeles but
// 2026-06-15 in UTC — proves the window resolves in the ORG zone, not the device/UTC zone.
const now1 = new Date('2026-06-15T02:00:00Z');
const today1 = dayKey(now1, TZ);
eq('org-zone "today" is the LA day, not the UTC day', today1, '2026-06-14');
const day = resolveRange('day', { now: now1, tz: TZ });
eq('day: start === end === org today', `${day.start}|${day.end}`, `${today1}|${today1}`);
const d10 = resolveRange('d10', { now: now1, tz: TZ });
eq('d10: end is today', d10.end, today1);
eq('d10: start is today − 9 (10 inclusive days)', d10.start, addDaysKey(today1, -9));
eq('d10: spans exactly 9 day-steps', diffDaysKey(d10.start, d10.end), 9);
const d30 = resolveRange('d30', { now: now1, tz: TZ });
eq('d30: start is today − 29', d30.start, addDaysKey(today1, -29));

// DST day (US spring-forward is 2026-03-08): a window straddling it is still counted in
// calendar-day labels, unperturbed by the missing hour.
const nowDst = new Date('2026-03-10T18:00:00Z'); // 2026-03-10 in LA
const todayDst = dayKey(nowDst, TZ);
const d10Dst = resolveRange('d10', { now: nowDst, tz: TZ });
eq('d10 across the DST boundary: still 9 day-steps', diffDaysKey(d10Dst.start, d10Dst.end), 9);
ok('d10 across DST: start precedes the DST day 2026-03-08', d10Dst.start <= '2026-03-08' && '2026-03-08' <= todayDst);

// all-time: always the fixed floor. NOT CompanyInfo.CompanyStartDate — the sandbox probe
// (2026-09-28) showed it is the day the QuickBooks company was CREATED (today, for a new
// sandbox), and a real company imports older history from before it, so 'all' came back
// empty. The floor must predate Clean Space itself: "est. 2011" (brain/CLIENT.md).
const all = resolveRange('all', { now: now1, tz: TZ });
eq('all: start is the fixed floor', all.start, ALL_TIME_START);
eq('all: end is today', all.end, today1);
ok('all: the floor predates Clean Space (est. 2011)', ALL_TIME_START <= '2011-01-01', ALL_TIME_START);

// an unknown range is rejected (the route turns this into a 400).
throws('unknown range key throws', () => resolveRange('week', { now: now1, tz: TZ }));

// ── the report filter (2026-10-03): the P&L asks QuickBooks for the LINKED entities only ──
// A summarized P&L over Matt's whole book (778 active customers) timed out: all-time 502, 30 days
// ~9 s. The route now sends the linked ids (plus every descendant, so a parent linked on its own
// still covers its jobs — attributeToLinked) as the report's customer/class/department filter.
{
  const ents = [
    { id: '1217', parentId: null }, { id: '1218', parentId: '1217' }, { id: '1219', parentId: '1217' },
    { id: '1220', parentId: '1219' }, { id: '939', parentId: null }, { id: '1697', parentId: '939' },
    { id: '1562', parentId: '1281' },
  ];
  eq('filter: a linked job alone is just that job (no parent, no siblings)',
    JSON.stringify(reportFilterIds(['1218'], ents)), JSON.stringify(['1218']));
  eq('filter: a linked parent brings its whole subtree (grandchildren too)',
    JSON.stringify(reportFilterIds(['1217'], ents)), JSON.stringify(['1217', '1218', '1219', '1220']));
  eq('filter: de-duplicated and sorted numerically (stable cache key)',
    JSON.stringify(reportFilterIds(['1697', '939', '1697', '1562'], ents)), JSON.stringify(['939', '1562', '1697']));
  eq('filter: an entity list with no parentIds degrades to the linked ids',
    JSON.stringify(reportFilterIds(['1217'], [{ id: '1218' }])), JSON.stringify(['1217']));
  eq('filter: no entity list at all degrades to the linked ids',
    JSON.stringify(reportFilterIds(['42', '7'], null)), JSON.stringify(['7', '42']));
  eq('filter: nothing linked → empty', reportFilterIds([], ents).length, 0);
  ok('filter: a cycle in parent refs cannot loop forever',
    reportFilterIds(['a'], [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]).length === 2);
  ok('filter: there is a URL-safety cap', Number.isInteger(MAX_REPORT_FILTER_IDS) && MAX_REPORT_FILTER_IDS > 0);

  // The ONE read path wires it (_lib/qbo/pnl.js, shared by the route and the nightly refresh since
  // Wave 3): the request carries the filter, and the cache key carries the filter set (THE LAW
  // II.7 — key a result on its full inputs, so a link change never serves an old report).
  const pnlSrc = readFileSync(new URL('../api/_lib/qbo/pnl.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  ok('pnl.js: the P&L request passes the linked-entity filter', /fetchProfitAndLoss\([^)]*filter/.test(pnlSrc));
  ok('pnl.js: the P&L cache key carries the filter-set digest', /pnl:v\$\{PNL_PARSE_VERSION\}[^`]*:f\$\{/.test(pnlSrc));
  const route = readFileSync(new URL('../api/quickbooks/[...path].js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  ok('route: the P&L is read through that path (loadPnl), not a second copy', /loadPnl\(/.test(route) && !/fetchProfitAndLoss\(/.test(route));
  const client = readFileSync(new URL('../api/_lib/qbo/client.js', import.meta.url), 'utf8');
  ok('client: entity rows carry their parentId', /parentId:/.test(client));
}

console.log(`\nqbo-report: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
