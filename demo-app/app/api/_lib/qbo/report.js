// QuickBooks Online ProfitAndLoss parser — PURE (no network, no Supabase, node-loadable so
// it is unit-testable headlessly). Turns Intuit's documented ProfitAndLoss JSON into integer
// cents per entity per section.
//
// SHAPE (developer.intuit.com/.../report-entities/profitandloss; the column tags CONFIRMED
// against a live sandbox company on 2026-09-28 by scripts/qbo-sandbox-probe.mjs, fixtures in
// scripts/fixtures/qbo/):
//   Header.ReportBasis            — 'Cash' | 'Accrual' (the company default; we record it).
//   Columns.Column[]              — EVERY column carries MetaData:[{ Name:'ColKey', Value }]:
//                                   'account' on the row-label column, the ENTITY ID ('1',
//                                   '7', …, the same id the Customer/Class/Department query
//                                   API returns) on a per-entity column, 'not_specified' on
//                                   the column of amounts tagged to no entity, and 'total' on
//                                   the TOTAL column.
//   Rows.Row[]                    — nested sections; a row that represents a section TOTAL
//                                   carries `group` (Income | COGS | GrossProfit | Expenses |
//                                   NetOperatingIncome | OtherIncome | OtherExpenses |
//                                   NetOtherIncome | NetIncome) and its per-column totals in
//                                   `Summary.ColData[]` (sections) or `ColData[]` (the
//                                   computed GrossProfit / NetOperatingIncome / NetIncome
//                                   summary rows). We read BOTH shapes.
//
// The column → entity mapping lives in exactly ONE function (columnEntityMap). It first read a
// MetaData entry named 'ID' (from the docs + synthetic fixtures), which matched 0 of 17 columns
// on the live company; the tests now pin it to the captured responses. Every figure is INTEGER
// CENTS via a strict decimal-string parser — NEVER Number() arithmetic, which loses cents on
// values like 8014.15.

// The documented section groups, in report order. The dashboard's headline is GrossProfit
// and GPM = grossProfit / income (owner: "revenue − expense = gross profit, explicitly NOT
// net operating income"); every section total is returned so the definition can change with
// no re-architecture.
export const PNL_GROUPS = Object.freeze([
  'Income', 'COGS', 'GrossProfit', 'Expenses',
  'NetOperatingIncome', 'OtherIncome', 'OtherExpenses', 'NetOtherIncome', 'NetIncome',
]);

// group → the response field it fills.
const GROUP_FIELD = Object.freeze({
  Income: 'incomeCents',
  COGS: 'cogsCents',
  GrossProfit: 'grossProfitCents',
  Expenses: 'expensesCents',
  NetOperatingIncome: 'netOperatingIncomeCents',
  OtherIncome: 'otherIncomeCents',
  OtherExpenses: 'otherExpensesCents',
  NetOtherIncome: 'netOtherIncomeCents',
  NetIncome: 'netIncomeCents',
});

// Strict decimal string → integer cents. NO float math (Number('8014.15')*100 = 801414.9999).
// '' / null / undefined → 0. Negatives kept. Commas + surrounding whitespace tolerated.
// Anything that is not an optionally-signed decimal THROWS — a shape Intuit never sends is
// API drift we want to see, not silently zero.
export function centsFromDecimalString(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  if (s === '') return 0;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`qbo: not a decimal money string: ${JSON.stringify(raw)}`);
  const sign = m[1] === '-' ? -1 : 1;
  const dollars = m[2];
  const frac = m[3] || '';
  // Two-decimal cents. Round half-up on a third decimal (Intuit sends 2, but be exact if not).
  const cents2 = (frac + '00').slice(0, 2);
  const third = frac.length > 2 ? Number(frac[2]) : 0;
  let cents = Number(dollars) * 100 + Number(cents2);
  if (third >= 5) cents += 1;
  return sign * cents;
}

// The reserved ColKey values; any other ColKey on a money column is an entity id.
const RESERVED_COL_KEYS = Object.freeze({ account: 'label', not_specified: 'unassigned', total: 'total' });

// The column list → [{ entityId, kind, title, colType, rollupOf }] aligned by index. `kind` is
// 'label' | 'entity' | 'rollup' | 'unassigned' | 'total' | 'unknown'; only an 'entity' column
// carries an entityId.
//   SUB-CUSTOMERS (confirmed on the live sandbox, 2026-09-28): a parent customer with
//   sub-customers gets its OWN column (its own id), then its sub-customers' columns, then a
//   "Total <parent>" roll-up column carrying the parent's id AGAIN. So an id seen a second time
//   is a 'rollup' (rollupOf = that id), never a second entity, or its money would count twice.
// A column with no ColKey (Intuit's documented single-column sample omits it) is 'label' when
// it is the Account column and 'unknown' otherwise, so it can never be mis-attributed to an
// entity; parseProfitAndLoss still accepts it as the TOTAL of a one-column report.
export function columnEntityMap(columns) {
  const cols = Array.isArray(columns) ? columns : [];
  const seen = new Set();
  return cols.map((c) => {
    const meta = Array.isArray(c?.MetaData) ? c.MetaData : [];
    const keyEntry = meta.find((mm) => mm && mm.Name === 'ColKey');
    const colKey = keyEntry && keyEntry.Value != null ? String(keyEntry.Value) : '';
    const colType = c?.ColType || null;
    let kind;
    if (RESERVED_COL_KEYS[colKey]) kind = RESERVED_COL_KEYS[colKey];
    else if (colKey !== '') kind = colType === 'Account' ? 'label' : (seen.has(colKey) ? 'rollup' : 'entity');
    else kind = colType === 'Account' ? 'label' : 'unknown';
    if (kind === 'entity') seen.add(colKey);
    return {
      entityId: kind === 'entity' ? colKey : null,
      rollupOf: kind === 'rollup' ? colKey : null,
      kind,
      title: typeof c?.ColTitle === 'string' ? c.ColTitle : '',
      colType,
    };
  });
}

// Walk every row (depth-first) and, for any row carrying a known `group`, read its per-column
// totals. A section total lives in Summary.ColData; a computed summary row in ColData.
function collectGroupTotals(rows, out) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.group === 'string' && GROUP_FIELD[row.group]) {
      const colData = (row.Summary && Array.isArray(row.Summary.ColData) ? row.Summary.ColData : null)
        || (Array.isArray(row.ColData) ? row.ColData : null);
      if (colData) out[row.group] = colData.map((cd) => (cd && cd.value !== undefined ? cd.value : ''));
    }
    if (row.Rows && Array.isArray(row.Rows.Row)) collectGroupTotals(row.Rows.Row, out);
  }
  return out;
}

// Build one section-total object for a single column index from the collected group rows.
function figuresForColumn(groupTotals, colIndex) {
  const cell = (group) => {
    const arr = groupTotals[group];
    return arr && colIndex < arr.length ? centsFromDecimalString(arr[colIndex]) : 0;
  };
  const income = cell('Income');
  const cogs = cell('COGS');
  // QBO's own GrossProfit line is authoritative; only when the report omits it (a P&L with no
  // COGS section can) do we fall back to income − COGS.
  const grossProfit = groupTotals.GrossProfit ? cell('GrossProfit') : income - cogs;
  return {
    incomeCents: income,
    cogsCents: cogs,
    grossProfitCents: grossProfit,
    expensesCents: cell('Expenses'),
    netOperatingIncomeCents: cell('NetOperatingIncome'),
    otherIncomeCents: cell('OtherIncome'),
    otherExpensesCents: cell('OtherExpenses'),
    netOtherIncomeCents: cell('NetOtherIncome'),
    netIncomeCents: cell('NetIncome'),
  };
}

// The version of the shape parseProfitAndLoss returns. The route caches that shape, so its
// cache key carries this number (THE LAW II.7: key a result on its full inputs) and a payload
// from an older parser is never served. 🔴 BUMP IT whenever the returned shape changes.
// v2 (2026-09-28): ColKey columns, roll-up columns dropped, entities carry `ancestorIds`.
export const PNL_PARSE_VERSION = 2;

// Parse a ProfitAndLoss report. Returns:
//   { basis, entities: [{ entityId, entityName, ancestorIds, ...Cents }], unassigned: { ...Cents }, total: { ...Cents } }
// `entities` is one entry per 'entity' column — an entity's OWN amounts (a customer / class /
// department; for a parent customer, only what is booked on the parent itself). `ancestorIds`
// lists the parents whose roll-up encloses that column, innermost first ([] at the top level);
// attributeToLinked uses it. The 'rollup' columns are not returned: they re-add their subtree
// and would double-count. So Σ entities + unassigned = total, to the cent. `unassigned` is the
// Not Specified column (amounts tagged to no entity; all-zero when the report has none), which
// shows whether a company's costs are recorded per property at all; `total` is the column tagged
// 'total', else (a report without ColKey tags, like Intuit's documented one-column sample) the
// last money column that is not an entity. All values are integer cents.
export function parseProfitAndLoss(report) {
  const basis = report?.Header?.ReportBasis || null;
  const columns = columnEntityMap(report?.Columns?.Column);
  const groupTotals = collectGroupTotals(report?.Rows?.Row, {});

  // Each parent's span: its own column → its roll-up column. A column strictly inside a span
  // belongs to that parent's subtree.
  const spans = [];
  columns.forEach((col, i) => {
    if (col.kind !== 'rollup') return;
    const ownIdx = columns.findIndex((c) => c.kind === 'entity' && c.entityId === col.rollupOf);
    if (ownIdx >= 0 && ownIdx < i) spans.push({ id: col.rollupOf, from: ownIdx, to: i });
  });
  const ancestorsOf = (i) => spans
    .filter((s) => s.from < i && i < s.to)
    .sort((a, b) => b.from - a.from) // innermost (latest-opening) first
    .map((s) => s.id);

  const entities = [];
  let totalIdx = columns.findIndex((col) => col.kind === 'total');
  const unassignedIdx = columns.findIndex((col) => col.kind === 'unassigned');
  columns.forEach((col, i) => {
    if (col.kind === 'entity') {
      entities.push({ entityId: col.entityId, entityName: col.title, ancestorIds: ancestorsOf(i), ...figuresForColumn(groupTotals, i) });
    }
  });
  if (totalIdx < 0) {
    for (let i = columns.length - 1; i > 0; i -= 1) {
      if (columns[i].kind === 'unknown') { totalIdx = i; break; }
    }
  }
  // -1 reads as an all-zero figure set (figuresForColumn indexes nothing).
  return {
    basis,
    entities,
    unassigned: figuresForColumn(groupTotals, unassignedIdx),
    total: figuresForColumn(groupTotals, totalIdx),
  };
}

// The P&L REQUEST's entity filter (2026-10-03): a P&L summarized over a whole book does not scale
// (Matt's 778 active customers: all-time 502, 30 days ~9 s), so the route asks QuickBooks for the
// linked entities' transactions only. Every linked id plus every DESCENDANT of one — a parent linked
// on its own covers its subtree (attributeToLinked), so its sub-customers' columns must come back
// too. `entities` is the entity list ({ id, parentId }); a list without parentIds, or none at all,
// degrades to the linked ids alone. De-duplicated and sorted numerically so the cache key is stable.
// Cycle-safe (a malformed parent loop terminates).
export function reportFilterIds(linkedIds, entities) {
  const want = new Set((Array.isArray(linkedIds) ? linkedIds : []).map(String));
  const children = new Map();
  for (const e of Array.isArray(entities) ? entities : []) {
    if (!e || e.parentId == null || e.id == null) continue;
    const p = String(e.parentId);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(String(e.id));
  }
  const stack = [...want];
  while (stack.length) {
    for (const kid of children.get(stack.pop()) || []) {
      if (!want.has(kid)) { want.add(kid); stack.push(kid); }
    }
  }
  return [...want].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

// Above this many ids the filter would push the report URL toward Intuit's request-line limit, so
// the route falls back to the unfiltered (summarize-everything) report.
export const MAX_REPORT_FILTER_IDS = 500;

// ONE DIMENSION PER COMPANY (CS-565): the rule lives in the shared, node-safe src/lib/qboRules.js
// (the route, the demo stub and the Link dialog all read it); re-exported here for the server.
export { realmDimension } from '../../../src/lib/qboRules.js';

const MONEY_FIELDS = Object.freeze(Object.values(GROUP_FIELD));

// Attribute every entity's own amounts to the NEAREST linked property: the entity itself when it
// is linked, else its innermost linked ancestor, else nobody. `linkedIds` must be EVERY id the
// org links for this dimension (not just the caller's), so a parent linked to one property is
// never credited with a sub-customer linked to another (no double count), and a parent linked on
// its own covers its whole subtree. Returns Map(linkedEntityId → { ...Cents }); a linked id with
// no amounts in the report is absent (the caller reads that as all-zero).
export function attributeToLinked(parsed, linkedIds) {
  const out = new Map();
  const linked = linkedIds instanceof Set ? linkedIds : new Set(linkedIds || []);
  for (const e of Array.isArray(parsed?.entities) ? parsed.entities : []) {
    const target = linked.has(e.entityId) ? e.entityId : (e.ancestorIds || []).find((id) => linked.has(id));
    if (!target) continue;
    const acc = out.get(target) || Object.fromEntries(MONEY_FIELDS.map((f) => [f, 0]));
    for (const f of MONEY_FIELDS) acc[f] += Number.isInteger(e[f]) ? e[f] : 0;
    out.set(target, acc);
  }
  return out;
}
