// CS-565 — one QuickBooks dimension per company, so no money is counted twice (offline).
//
// The register (S109): "two properties linking the same money under different QuickBooks
// dimensions each get the full amount". A QuickBooks transaction can carry a customer AND a
// class; property A linked to the customer and property B linked to the class each received the
// full amount, and the owner's book tiles (Book revenue, Book GPM) summed both — above the
// company's own total. The rule now: a company's properties are linked on ONE dimension.
//   1. realmDimension: the dimension a company's links are on (legacy mixed links: the majority);
//   2. PUT links refuses a property on another dimension (409 dimension_mismatch, in words);
//   3. the P&L counts only the company's dimension, so the book never sums above the company
//      total, and asks QuickBooks for that one dimension only;
//   4. GET links says which links are counted;
//   5. the demo stub mirrors the refusal.
//
//   node scripts/test-qbo-dimension.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { rig, counter, pnlReport } from './qbo-harness.mjs';
import * as report from '../api/_lib/qbo/report.js';

const { ok, finish } = counter('qbo-dimension');
const r = await rig();

// ── 1. the pure rule ────────────────────────────────────────────────────────
{
  ok('realmDimension is exported', typeof report.realmDimension === 'function');
  // Pre-change the export is absent; each check below then FAILS rather than being skipped.
  const dim = typeof report.realmDimension === 'function' ? report.realmDimension : () => undefined;
  const L = (t) => ({ entity_type: t });
  ok('no links → no dimension yet', dim([]) === null);
  ok('all customer → customer', dim([L('customer'), L('customer')]) === 'customer');
  ok('legacy mixed → the majority (2 customer + 1 class → customer)', dim([L('customer'), L('class'), L('customer')]) === 'customer');
  ok('legacy mixed → the majority (2 class + 1 customer → class)', dim([L('class'), L('customer'), L('class')]) === 'class');
  ok('a tie goes to customer (QB-2: each building is a customer)', dim([L('class'), L('customer')]) === 'customer');
  ok('a class/location tie goes to class', dim([L('department'), L('class')]) === 'class');
}

// ── 2. PUT links refuses a second dimension ──────────────────────────────────
const CUST_LINKS = () => [r.linkRow('cl_1', 'customer', '1', 'Ball Harbor'), r.linkRow('cl_2', 'customer', '2', 'Brickell')];
r.build({ links: CUST_LINKS() });
{
  const res = await r.call({ method: 'PUT', path: 'links', token: 'tok-owner', body: { clientId: 'cl_3', entityType: 'class', entityId: '3', entityName: 'Las Olas class' } });
  ok('🔴 a property on another dimension is refused (409 dimension_mismatch)', res.status === 409 && res.body.code === 'dimension_mismatch', r.show(res));
  ok('… in words that say which dimension the company uses', typeof res.body.error === 'string' && /customer/i.test(res.body.error), r.show(res));
  ok('🔴 … and nothing was stored', !r.world.tables.qbo_property_links.some((l) => l.client_id === 'cl_3'), JSON.stringify(r.world.tables.qbo_property_links));
  const same = await r.call({ method: 'PUT', path: 'links', token: 'tok-owner', body: { clientId: 'cl_3', entityType: 'customer', entityId: '3', entityName: 'Las Olas' } });
  ok('a property on the company\'s dimension links (200)', same.status === 200, r.show(same));
}
r.build({ links: [r.linkRow('cl_1', 'customer', '1', 'Ball Harbor')] });
{
  const relink = await r.call({ method: 'PUT', path: 'links', token: 'tok-owner', body: { clientId: 'cl_1', entityType: 'class', entityId: '5', entityName: 'Janitorial' } });
  ok('the ONLY linked property may move to another dimension (it replaces its own link)', relink.status === 200, r.show(relink));
}
r.build({ links: [r.linkRow('cl_1', 'customer', '1', 'Ball Harbor', 'realm_OTHER')] });
{
  const other = await r.call({ method: 'PUT', path: 'links', token: 'tok-owner', body: { clientId: 'cl_2', entityType: 'class', entityId: '5', entityName: 'Janitorial' } });
  ok('a link on ANOTHER company (realm) does not set this company\'s dimension', other.status === 200, r.show(other));
}

// ── 3. the P&L counts one dimension: the book never sums above the company total ──
// Legacy data (linked before this rule): cl_1 → customer 1, cl_2 → customer 2, cl_3 → class 3.
// ONE $1,000 sale is tagged customer 1 AND class 3, so each report shows it in full.
const MIXED = () => [...CUST_LINKS(), r.linkRow('cl_3', 'class', '3', 'Las Olas class')];
r.build({ links: MIXED(), entities: { customer: [{ Id: '1', DisplayName: 'Ball Harbor', Active: true }, { Id: '2', DisplayName: 'Brickell', Active: true }], class: [{ Id: '3', Name: 'Las Olas class', Active: true }] } });
r.intuit.pnl = (u) => (u.searchParams.get('summarize_column_by') === 'Classes'
  ? pnlReport({ cols: [{ key: '3', title: 'Las Olas class', income: '1000.00', cogs: '0.00' }] })
  : pnlReport({ cols: [{ key: '1', title: 'Ball Harbor', income: '1000.00', cogs: '0.00' }, { key: '2', title: 'Brickell', income: '0.00', cogs: '0.00' }] }));
{
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  ok('pnl → 200', res.status === 200, r.show(res));
  const accounts = res.body.accounts || [];
  const bookIncome = accounts.reduce((s, a) => s + a.incomeCents, 0);
  const COMPANY_TOTAL = 100000; // the one $1,000 sale
  ok('🔴 the owner\'s book never sums above the company\'s total (no double count across dimensions)', bookIncome <= COMPANY_TOTAL, `book ${bookIncome} > company ${COMPANY_TOTAL}: ${JSON.stringify(accounts.map((a) => [a.clientId, a.incomeCents]))}`);
  ok('the company\'s dimension (customer) is the one counted', accounts.some((a) => a.clientId === 'cl_1' && a.incomeCents === 100000), JSON.stringify(accounts));
  ok('🔴 the off-dimension property is not in the book', !accounts.some((a) => a.clientId === 'cl_3'), JSON.stringify(accounts));
  const dims = new Set(r.pnlUrls().map((u) => u.searchParams.get('summarize_column_by')));
  ok('QuickBooks is asked for the one dimension only (one P&L, by customer)', r.pnlUrls().length === 1 && dims.has('Customers'), [...dims].join(','));
}

// ── 4. GET links says which are counted ──────────────────────────────────────
r.build({ links: MIXED() });
{
  const res = await r.call({ path: 'links', token: 'tok-owner' });
  const by = Object.fromEntries((res.body.links || []).map((l) => [l.clientId, l]));
  ok('links → the company\'s dimension', res.body.dimension === 'customer', r.show(res));
  ok('🔴 an off-dimension link is marked not counted', by.cl_3 && by.cl_3.counted === false, JSON.stringify(by.cl_3));
  ok('an on-dimension link is counted', by.cl_1 && by.cl_1.counted === true, JSON.stringify(by.cl_1));
}

// ── 5. the demo stub mirrors the rule ────────────────────────────────────────
const APP = fileURLToPath(new URL('..', import.meta.url));
const LIB = join(APP, 'src', 'lib');
const tmpRoot = mkdtempSync(join(tmpdir(), 'cs-qbo-dimension-'));
async function loadUnder(file, env) {
  const src = readFileSync(join(LIB, file), 'utf8');
  const { code } = await transformWithOxc(src, file, { define: { 'import.meta.env': JSON.stringify(env) } });
  const rewritten = code.replace(/(from\s*['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, spec, b) => {
    let abs = fileURLToPath(new URL(spec, pathToFileURL(join(LIB, file))));
    if (!extname(abs)) abs += '.js';
    return a + pathToFileURL(abs).href + b;
  });
  const tmp = join(tmpRoot, `${file.replace(/\.js$/, '')}.demo.mjs`);
  writeFileSync(tmp, rewritten);
  return import(pathToFileURL(tmp).href);
}
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
try {
  const api = await loadUnder('qboApi.js', { PROD: false, MODE: 'demo' });
  await api.connectQbo();
  await api.linkQboProperty({ clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'A' });
  let refusal = null;
  try { await api.linkQboProperty({ clientId: 'cl_b', entityType: 'class', entityId: '2001', entityName: 'B' }); } catch (e) { refusal = e; }
  ok('🔴 the demo stub refuses a property on another dimension (409)', refusal && refusal.status === 409, refusal ? `${refusal.status} ${refusal.message}` : 'no refusal');
  const links = (await api.listQboLinks()).links;
  ok('… and stored nothing', links.length === 1 && links[0].clientId === 'cl_a', JSON.stringify(links));
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

finish();
