// THE CLIENT HUB'S INVOICES, READ-ONLY FROM QUICKBOOKS (client hub redesign, plan 2026-10-08 §3.5,
// Matt's M4 ★a: the last 12 months billed to the building's own QuickBooks customer and its
// sub-customers). Money, so a test is required (CLAUDE.md, the lite spine).
//
// Driven through the REAL /api/hub handler over fake-supabase (scripts/qbo-harness.mjs: the real
// stores, authz and token lease) with Intuit stubbed at fetch. The Invoice and Payment answers
// come from scripts/fixtures/qbo/invoices-query.json + payments-query.json — built to Intuit's
// DOCUMENTED shapes, not captured: the orchestrator's read-only sandbox probe has not run yet.
//
// What it holds:
//   A. money is INTEGER CENTS from a strict decimal parse (numbers and strings, no float math);
//   B. the status rule on the ORG-ZONE day: paid · open · overdue, partly paid noted, a voided
//      (total 0) invoice dropped — pure, and through the route in a zone ≠ the server's;
//   C. the building's own customer AND its sub-customers, never a sub-customer linked to another
//      building, never another building's customer, never past 12 months — asserted on the
//      QUERY sent to Intuit, not only on what came back;
//   D. the paid date is the latest linked Payment's date (none linked → null);
//   E. each state: not-connected, not-linked, unsupported-dimension (+ a server log), unavailable;
//   F. the 30-minute cache lives in its OWN table (never qbo_report_cache) and reaps rows older
//      than a day at the write;
//   G. the PDF re-checks the invoice belongs to this building: a foreign id is a 404;
//   H. the gate: no login 401, a staff login 403, another building 404; allowlisted answers.
//
// REGRESSION (THE LAW II.3): on the pre-change tree /api/hub has no `invoices` / `invoice-pdf`
// branch and src/lib/hubInvoices.js does not exist, so every check below fails.
//
//   node app/scripts/test-hub-invoices.mjs
import { readFileSync } from 'node:fs';
import { rig, counter, ORG } from './qbo-harness.mjs';

const { ok, finish } = counter('hub-invoices');
const r = await rig();
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const inv = await tryImport('../src/lib/hubInvoices.js');
const srv = await tryImport('../api/_lib/qbo/invoices.js');
const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
const hub = (await tryImport('../api/hub/[...path].js')).default || null;
const { hubPage } = await import('../src/lib/clientHubView.js');
ok('the pure rule module exists (src/lib/hubInvoices.js)', !inv.__error, inv.__error);
ok('the server module exists (api/_lib/qbo/invoices.js)', !srv.__error, srv.__error);

// ── A. cents ─────────────────────────────────────────────────────────────────
{
  const parse = srv.parseIntuitInvoice;
  const p = (raw) => { try { return parse(raw); } catch { return null; } };
  const a = typeof parse === 'function' ? p({ Id: '9', DocNumber: 'X1', TxnDate: '2026-09-01', DueDate: '2026-09-30', TotalAmt: 8014.15, Balance: 8014.15, CustomerRef: { value: '1' } }) : null;
  ok('🔴 A1 a JSON number 8014.15 is 801415 cents (Number*100 would give 801414.9999…)', a?.totalCents === 801415 && a?.balanceCents === 801415, JSON.stringify(a));
  const b = typeof parse === 'function' ? p({ Id: '9', TxnDate: '2026-09-01', TotalAmt: '1,160.50', Balance: '0.00', CustomerRef: { value: '1' } }) : null;
  ok('A2 a decimal STRING with a thousands comma is exact too; no DocNumber falls back to the id', b?.totalCents === 116050 && b?.balanceCents === 0 && b?.number === '9', JSON.stringify(b));
  const c = typeof parse === 'function' ? p({ Id: '9', TxnDate: '2026-09-01', TotalAmt: 1160, Balance: 0, CustomerRef: { value: '1' } }) : null;
  ok('A3 a whole number is whole cents; no DueDate means due on the day it was issued', c?.totalCents === 116000 && c?.dueDay === '2026-09-01', JSON.stringify(c));
  let threw = false;
  try { parse({ Id: '9', TxnDate: '2026-09-01', TotalAmt: 'abc', Balance: 0, CustomerRef: { value: '1' } }); } catch { threw = true; }
  ok('A4 a money value Intuit never sends THROWS (API drift is loud, never a silent zero)', typeof parse === 'function' && threw);
  ok('A5 every money figure the rule hands back is an integer', [a, b, c].every((x) => x && Number.isInteger(x.totalCents) && Number.isInteger(x.balanceCents)));
}

// ── B. the status rule, pure ─────────────────────────────────────────────────
{
  const st = inv.invoiceStatus;
  const T = '2026-10-08';
  const s = (o) => (typeof st === 'function' ? st(o, T) : 'missing');
  ok('🔴 B1 paid = nothing owed on a real invoice', s({ totalCents: 100, balanceCents: 0, dueDay: '2026-09-01' }) === 'paid');
  ok('🔴 B2 open = owed and due today or later (due TODAY is not overdue)', s({ totalCents: 100, balanceCents: 100, dueDay: T }) === 'open' && s({ totalCents: 100, balanceCents: 100, dueDay: '2026-10-09' }) === 'open');
  ok('🔴 B3 overdue = owed and due before today', s({ totalCents: 100, balanceCents: 100, dueDay: '2026-10-07' }) === 'overdue');
  ok('🔴 B4 a voided invoice (total 0) has no status: it is dropped', s({ totalCents: 0, balanceCents: 0, dueDay: T }) === null);
  const proj = typeof inv.projectHubInvoice === 'function' ? inv.projectHubInvoice({ id: '1', number: 'N', totalCents: 1000, balanceCents: 400, issuedDay: '2026-10-01', dueDay: '2026-10-20', paidDay: null }, T) : null;
  ok('B5 partly paid is OPEN with partlyPaid noted', proj?.status === 'open' && proj?.partlyPaid === true, JSON.stringify(proj));
  ok('B6 the row is exactly the allowlist', !!proj && Array.isArray(inv.HUB_INVOICE_ROW_FIELDS) && Object.keys(proj).sort().join() === [...inv.HUB_INVOICE_ROW_FIELDS].sort().join());
  ok('B7 the window is the last twelve months, ending today', typeof inv.invoiceWindowStart === 'function' && inv.invoiceWindowStart(T) === '2025-10-09', typeof inv.invoiceWindowStart === 'function' ? inv.invoiceWindowStart(T) : '');
  // M4 ★a: the linked customer + its sub-customers, never one linked to ANOTHER building.
  const ents = [{ id: '1' }, { id: '4', parentId: '1' }, { id: '5', parentId: '1' }, { id: '6', parentId: '5' }, { id: '7', parentId: '4' }, { id: '2' }];
  const ids = typeof inv.invoiceCustomerIds === 'function' ? inv.invoiceCustomerIds('1', ents, ['5', '2']) : null;
  ok('🔴 B8 sub-customers (and theirs) are included; a sub-customer linked elsewhere — and its own subtree — is not', JSON.stringify(ids) === JSON.stringify(['1', '4', '7']), JSON.stringify(ids));
}

// ── the world ────────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const today = () => dayKey(new Date(), r.world.tables.org_state?.[0]?.state?.company?.timezone || TZ);
const resolveDays = (node, base) => JSON.parse(JSON.stringify(node), (k, v) => (typeof v === 'string' && /^@d[+-]\d+$/.test(v) ? addDaysKey(base, Number(v.slice(2))) : v));
const INVOICES_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/qbo/invoices-query.json', import.meta.url), 'utf8'));
const PAYMENTS_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/qbo/payments-query.json', import.meta.url), 'utf8'));

// Intuit's /query for Invoice and Payment, and /invoice/<id>/pdf, in front of the harness's own
// stub. A tiny evaluator of the WHERE clause the code sends, so the book answers what was asked.
const book = { invoices: [], payments: [], log: [], pdfLog: [], fail: null };
const harnessFetch = globalThis.fetch;
const jsonRes = (okk, status, body) => ({ ok: okk, status, headers: { get: (k) => (k.toLowerCase() === 'intuit_tid' ? 'tid_inv' : null) }, json: async () => body });
const quotedList = (s) => [...String(s || '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const q = u.searchParams.get('query') || '';
  const isInvoiceQuery = u.pathname.endsWith('/query') && /from\s+Invoice\b/i.test(q);
  const isPaymentQuery = u.pathname.endsWith('/query') && /from\s+Payment\b/i.test(q);
  const pdf = /\/invoice\/([^/]+)\/pdf$/.exec(u.pathname);
  if (!isInvoiceQuery && !isPaymentQuery && !pdf) return harnessFetch(url, init);
  if (book.fail) { const f = book.fail(u); if (f) return jsonRes(false, f.status, {}); }
  if (pdf) {
    book.pdfLog.push(pdf[1]);
    const bytes = Buffer.from(`%PDF-1.4 invoice ${pdf[1]}`);
    return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/pdf' : null) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), json: async () => ({}) };
  }
  book.log.push(q);
  const start = Number((/startposition\s+(\d+)/i.exec(q) || [])[1] || 1);
  const max = Number((/maxresults\s+(\d+)/i.exec(q) || [])[1] || 100);
  if (isInvoiceQuery) {
    const refIn = /CustomerRef\s+in\s*\(([^)]*)\)/i.exec(q);
    const since = /TxnDate\s*>=\s*'(\d{4}-\d{2}-\d{2})'/i.exec(q);
    const idEq = /\bId\s*=\s*'([^']*)'/i.exec(q);
    let rows = book.invoices.slice();
    if (refIn) { const set = new Set(quotedList(refIn[1])); rows = rows.filter((x) => set.has(x.CustomerRef?.value)); }
    if (since) rows = rows.filter((x) => x.TxnDate >= since[1]);
    if (idEq) rows = rows.filter((x) => x.Id === idEq[1]);
    rows.sort((a, b) => Number(a.Id) - Number(b.Id));
    const page = rows.slice(start - 1, start - 1 + max);
    return jsonRes(true, 200, { QueryResponse: page.length ? { Invoice: page, startPosition: start, maxResults: page.length } : {} });
  }
  const idIn = /\bId\s+in\s*\(([^)]*)\)/i.exec(q);
  const set = new Set(quotedList(idIn ? idIn[1] : ''));
  const page = book.payments.filter((x) => set.has(x.Id)).slice(start - 1, start - 1 + max);
  return jsonRes(true, 200, { QueryResponse: page.length ? { Payment: page, startPosition: start, maxResults: page.length } : {} });
};

const CU = 'a1000000-0000-4000-8000-000000000001';
const CUSTOMERS = [
  { Id: '1', DisplayName: '0001 Ball Harbor Village', Active: true },
  { Id: '2', DisplayName: '0002 Brickell Bay Offices', Active: true },
  { Id: '4', DisplayName: '0004 Ball Harbor Annex', Active: true, ParentRef: { value: '1' } },
  { Id: '5', DisplayName: '0005 Ball Harbor Marina', Active: true, ParentRef: { value: '1' } },
];
const CLIENTS = [
  { id: 'cl_1', name: 'Ball Harbor Village', supervisorId: 'u_mgr' },
  { id: 'cl_2', name: 'Brickell Bay Offices', supervisorId: 'u_mgr2' },
  { id: 'cl_3', name: 'Ball Harbor Marina', supervisorId: 'u_mgr' },
  { id: 'cl_4', name: 'Unlinked Plaza', supervisorId: 'u_mgr' },
];
function world({ links, timezone = TZ, connected = true, assigned = ['cl_1', 'cl_4'], cache = [] } = {}) {
  r.build({
    connected, clients: CLIENTS, timezone,
    entities: { customer: CUSTOMERS },
    links: links || [
      r.linkRow('cl_1', 'customer', '1', '0001 Ball Harbor Village'),
      r.linkRow('cl_2', 'customer', '2', '0002 Brickell Bay Offices'),
      r.linkRow('cl_3', 'customer', '5', '0005 Ball Harbor Marina'),
    ],
  });
  const W = r.world;
  W.tables.client_users = [{ id: CU, organization_id: ORG, name: 'Pat Manager', email: 'pat@ballharbor.test', phone: null, status: 'active', auth_user_id: 'auth-client' }];
  W.tables.client_user_assignments = assigned.map((id, i) => ({ id: `as${i}`, organization_id: ORG, client_user_id: CU, client_id: id, group_id: null }));
  W.tables.client_user_groups = [];
  W.tables.client_user_group_members = [];
  W.tables.qbo_invoice_cache = cache;
  W.logins.set('tok-client', { id: 'auth-client', email: 'pat@ballharbor.test', app_metadata: { role: 'client', client_user_id: CU, org_id: ORG } });
  const base = dayKey(new Date(), timezone);
  book.invoices = resolveDays(INVOICES_FIXTURE, base).QueryResponse.Invoice;
  book.payments = resolveDays(PAYMENTS_FIXTURE, base).QueryResponse.Payment;
  book.log.length = 0;
  book.pdfLog.length = 0;
  book.fail = null;
}
const get = (path, query = {}, token = 'tok-client') => (hub
  ? r.call({ using: hub, path, token, query })
  : Promise.resolve({ status: 0, body: null, headers: {}, logged: [] }));
const rowsById = (res) => new Map((res.body?.rows || []).map((x) => [x.id, x]));

// ── C/D. the list, through the route ─────────────────────────────────────────
world();
{
  const res = await get('invoices', { buildingId: 'cl_1' });
  ok('🔴 C1 GET /api/hub/invoices answers the building\'s invoices', res.status === 200 && res.body?.state === 'ready', r.show(res));
  ok('C2 the answer is exactly its allowlist', !!res.body && Array.isArray(inv.HUB_INVOICE_RESPONSE_FIELDS) && Object.keys(res.body).sort().join() === [...inv.HUB_INVOICE_RESPONSE_FIELDS].sort().join(), Object.keys(res.body || {}).join());
  const rows = rowsById(res);
  ok('🔴 C3 the building\'s own customer AND its sub-customer (1003 on customer 4) are listed', rows.has('1001') && rows.has('1003'), [...rows.keys()].join());
  ok('🔴 C4 never a sub-customer linked to ANOTHER building (1006 on customer 5), never another building\'s (1007)', !rows.has('1006') && !rows.has('1007'));
  ok('🔴 C5 a voided invoice (total 0) is dropped', !rows.has('1005'));
  ok('🔴 C6 nothing older than twelve months', !rows.has('1008'));
  const invQ = book.log.filter((q) => /from\s+Invoice/i.test(q));
  ok('🔴 C7 the Invoice query asks for EXACTLY this building\'s customers (1 and sub-customer 4)', invQ.length >= 1 && invQ.every((q) => JSON.stringify(quotedList((/CustomerRef\s+in\s*\(([^)]*)\)/i.exec(q) || [])[1]).sort()) === JSON.stringify(['1', '4'])), invQ.join(' | '));
  const win = typeof inv.invoiceWindowStart === 'function' ? inv.invoiceWindowStart(today()) : '?';
  ok('C8 …and from the start of the twelve-month window', invQ.length >= 1 && invQ.every((q) => q.includes(`TxnDate >= '${win}'`)), invQ.join(' | '));
  const T = today();
  ok('🔴 D1 statuses on the org-zone day: 1001 open, 1002 overdue, 1003 paid, 1010 due today = open',
    rows.get('1001')?.status === 'open' && rows.get('1002')?.status === 'overdue' && rows.get('1003')?.status === 'paid' && rows.get('1010')?.status === 'open',
    JSON.stringify([...rows.values()].map((x) => [x.id, x.status, x.dueDay])));
  ok('🔴 D2 partly paid (1004: 980.50 billed, 480.50 owed) is open with partlyPaid', rows.get('1004')?.status === 'open' && rows.get('1004')?.partlyPaid === true && rows.get('1004')?.balanceCents === 48050 && rows.get('1004')?.totalCents === 98050);
  ok('🔴 D3 the paid date is the LATEST linked payment (1003: two payments, the later wins)', rows.get('1003')?.paidDay === addDaysKey(T, -38), rows.get('1003')?.paidDay);
  ok('D4 paid with no linked payment (a credit memo) has no paid date', rows.get('1009')?.status === 'paid' && rows.get('1009')?.paidDay === null);
  ok('D5 money is integer cents: 1003 is 8014.15', rows.get('1003')?.totalCents === 801415 && [...rows.values()].every((x) => Number.isInteger(x.totalCents) && Number.isInteger(x.balanceCents)));
  ok('D6 every row is exactly HUB_INVOICE_ROW_FIELDS', rows.size > 0 && [...rows.values()].every((x) => Object.keys(x).sort().join() === [...(inv.HUB_INVOICE_ROW_FIELDS || ['?'])].sort().join()));
  const blob = JSON.stringify(res.body);
  ok('🔴 D7 nothing else from QuickBooks rides along (memo, line items, customer names, ids)', !/ZZPRIVATEZZ|Janitorial|Ball Harbor|CustomerRef|SyncToken/.test(blob), blob.slice(0, 200));
  ok('D8 newest first', (res.body?.rows || []).map((x) => x.issuedDay).join() === (res.body?.rows || []).map((x) => x.issuedDay).sort().reverse().join());
  const sum = res.body?.summary || {};
  ok('🔴 D9 the summary: open count and owed cents (open + overdue), paid count', sum.openCount === 4 && sum.openCents === 116000 + 116000 + 48050 + 123456 && sum.paidCount === 2 && sum.overdueCount === 1, JSON.stringify(sum));
  ok('D10 total + paging', res.body?.total === 6 && res.body?.offset === 0 && res.body?.limit === hubPage({}).limit);
  const p2 = await get('invoices', { buildingId: 'cl_1', offset: '4', limit: '2' });
  ok('D11 a later page holds the rest', p2.status === 200 && (p2.body?.rows || []).length === 2 && p2.body?.total === 6, r.show(p2));
  ok('D12 the answer is private and never cached by the browser', /private/.test(res.headers?.['cache-control'] || '') && /no-store/.test(res.headers?.['cache-control'] || ''));
}

// ── B (route): the org-zone day in a zone that is NOT the server's ───────────
{
  // A zone whose calendar day differs from UTC's right now (Kiritimati is UTC+14, Pago Pago
  // UTC−11: between them one always differs), so a server-zone day would get it wrong.
  const utcDay = new Date().toISOString().slice(0, 10);
  const zone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => dayKey(new Date(), z) !== utcDay) || 'Pacific/Kiritimati';
  world({ timezone: zone });
  book.invoices = [{ Id: '1101', DocNumber: 'Z-1', TxnDate: addDaysKey(utcDay, -5), DueDate: utcDay, TotalAmt: 100, Balance: 100, CustomerRef: { value: '1' }, LinkedTxn: [] }];
  const res = await get('invoices', { buildingId: 'cl_1' });
  const orgDay = dayKey(new Date(), zone);
  const want = orgDay > utcDay ? 'overdue' : 'open';
  ok(`🔴 B9 the route judges "due" on the ORG's day (${zone}: ${orgDay}), not the server's (${utcDay}) → ${want}`, res.body?.rows?.[0]?.status === want, r.show(res));
}

// ── E. states ────────────────────────────────────────────────────────────────
{
  world({ connected: false });
  const a = await get('invoices', { buildingId: 'cl_1' });
  ok('🔴 E1 not-connected when QuickBooks is not connected (no Intuit call)', a.status === 200 && a.body?.state === 'not-connected' && (a.body?.rows || []).length === 0 && book.log.length === 0, r.show(a));
  world();
  const b = await get('invoices', { buildingId: 'cl_4' });
  ok('🔴 E2 not-linked for a building with no QuickBooks link', b.status === 200 && b.body?.state === 'not-linked' && book.log.length === 0, r.show(b));
  world({ links: [r.linkRow('cl_1', 'class', '20', 'Janitorial'), r.linkRow('cl_2', 'class', '21', 'Floor Care')] });
  const c = await get('invoices', { buildingId: 'cl_1' });
  ok('🔴 E3 unsupported-dimension when the company links by class (or location)', c.status === 200 && c.body?.state === 'unsupported-dimension' && book.log.length === 0, r.show(c));
  ok('E4 …and the server log says why', (c.logged || []).some((l) => /unsupported|dimension/i.test(l)), (c.logged || []).join(' | '));
  world();
  book.fail = () => ({ status: 503 });
  const d = await get('invoices', { buildingId: 'cl_1' });
  ok('🔴 E5 unavailable when QuickBooks is down — a state, never the provider\'s words', d.status === 200 && d.body?.state === 'unavailable' && !/QuickBooks request failed|503/.test(JSON.stringify(d.body)), r.show(d));
  ok('E6 the four states and their sentences are one shared vocabulary', ['not-connected', 'not-linked', 'unsupported-dimension', 'unavailable'].every((s) => typeof inv.HUB_INVOICE_STATE_SENTENCES?.[s] === 'string'));
}

// ── F. the cache ─────────────────────────────────────────────────────────────
{
  const stale = { organization_id: ORG, cache_key: 'inv:old', payload: { invoices: [] }, fetched_at: new Date(Date.now() - 26 * 3600e3).toISOString() };
  world({ cache: [stale] });
  const first = await get('invoices', { buildingId: 'cl_1' });
  const asked = book.log.length;
  const second = await get('invoices', { buildingId: 'cl_1' });
  ok('🔴 F1 a second read inside 30 minutes asks QuickBooks nothing', first.body?.state === 'ready' && asked > 0 && book.log.length === asked && second.body?.total === first.body?.total, `${asked} → ${book.log.length}`);
  ok('🔴 F2 the cache is its OWN table — never the P&L cache (whose row cap would crowd)', (r.world.tables.qbo_invoice_cache || []).some((row) => row.cache_key !== 'inv:old') && !(r.world.tables.qbo_report_cache || []).some((row) => /^inv/.test(row.cache_key)));
  ok('🔴 F3 a row older than a day is reaped at the write', !(r.world.tables.qbo_invoice_cache || []).some((row) => row.cache_key === 'inv:old'));
  ok('F4 the cached payload carries no status (it is judged on each read\'s own day)', (r.world.tables.qbo_invoice_cache || []).every((row) => !JSON.stringify(row.payload).includes('"status"')));
  // Older than 30 minutes → read again; and when QuickBooks is down then, the last good copy is served.
  for (const row of r.world.tables.qbo_invoice_cache) row.fetched_at = new Date(Date.now() - 40 * 60e3).toISOString();
  const before = book.log.length;
  await get('invoices', { buildingId: 'cl_1' });
  ok('F5 past 30 minutes it reads QuickBooks again', book.log.length > before);
  for (const row of r.world.tables.qbo_invoice_cache) row.fetched_at = new Date(Date.now() - 40 * 60e3).toISOString();
  book.fail = () => ({ status: 503 });
  const down = await get('invoices', { buildingId: 'cl_1' });
  ok('F6 QuickBooks down with a copy from today: the copy is served, with its time', down.body?.state === 'ready' && down.body?.total === 6 && typeof down.body?.asOf === 'string', r.show(down));
}

// ── G. the PDF ───────────────────────────────────────────────────────────────
world();
{
  const own = await get('invoice-pdf', { buildingId: 'cl_1', id: '1001' });
  ok('🔴 G1 the building\'s own invoice streams Intuit\'s PDF', own.status === 200 && /application\/pdf/.test(own.headers?.['content-type'] || '') && Buffer.isBuffer(own.body) && String(own.body).startsWith('%PDF') && book.pdfLog.includes('1001'), r.show(own));
  ok('G2 a sub-customer\'s invoice is the building\'s too', (await get('invoice-pdf', { buildingId: 'cl_1', id: '1003' })).status === 200);
  for (const [label, id] of [['another building\'s', '1007'], ['a sub-customer linked to another building\'s', '1006'], ['a voided', '1005'], ['an over-a-year-old', '1008'], ['a made-up', '99999'], ['a non-numeric', '../1001']]) {
    book.pdfLog.length = 0;
    const x = await get('invoice-pdf', { buildingId: 'cl_1', id });
    ok(`🔴 G3 ${label} invoice id is a 404 and no PDF is fetched`, x.status === 404 && x.body?.code === 'not-found' && book.pdfLog.length === 0, r.show(x));
  }
  const other = await get('invoice-pdf', { buildingId: 'cl_2', id: '1007' });
  ok('🔴 G4 a building outside the login\'s scope is a 404, even with its own invoice id', other.status === 404 && other.body?.code === 'not-found');
}

// ── H. the gate ──────────────────────────────────────────────────────────────
world();
{
  for (const p of ['invoices', 'invoice-pdf']) {
    const q = { buildingId: 'cl_1', id: '1001' };
    const anon = await get(p, q, null);
    ok(`H1 ${p}: no login is a 401`, anon.status === 401, r.show(anon));
    const staff = await get(p, q, 'tok-owner');
    ok(`🔴 H2 ${p}: a staff login is refused (403 office-login)`, staff.status === 403 && staff.body?.code === 'office-login', r.show(staff));
  }
  const x = await get('invoices', { buildingId: 'cl_2' });
  ok('🔴 H3 another building\'s invoices are a 404 that names nothing', x.status === 404 && x.body?.code === 'not-found' && !JSON.stringify(x.body).includes('Brickell'));
  ok('H4 …and QuickBooks was not asked about it', !book.log.some((q) => /'2'/.test(q)));
}

finish();
