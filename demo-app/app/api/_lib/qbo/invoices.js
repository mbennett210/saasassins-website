// THE CLIENT HUB'S INVOICES — read-only from QuickBooks (client hub redesign, plan 2026-10-08
// §3.5; Matt's M4 ★a / HUB-23: the last twelve months, billed to the building's own QuickBooks
// customer and its sub-customers). Server only (service role). Called by /api/hub/invoices and
// /api/hub/invoice-pdf, through api/_lib/clientHub/branches/invoicesDocuments.js.
//
// THE RULES THIS MODULE KEEPS
//  · Every Intuit call goes through getValidAccessToken (tokens.js, the single-flight lease —
//    Intuit rotates the refresh token, so a second refresher would kill the connection) and
//    carries the caller's DEADLINE (CS-572).
//  · ONE DIMENSION PER COMPANY (CS-565): invoices are billed to a CUSTOMER, so a company that links
//    its buildings by class or location has no per-building invoices to show — it answers
//    `unsupported-dimension` and says why in the server log, never a guess.
//  · The building's customers are its linked customer + every sub-customer NOT linked to another
//    building (src/lib/hubInvoices.js invoiceCustomerIds — the P&L's nearest-linked rule), and the
//    Invoice query names exactly those ids: another building's invoice is never even fetched.
//  · 🔴 MONEY IS INTEGER CENTS from the strict decimal parser (report.js centsFromDecimalString);
//    Intuit sends amounts as JSON numbers, which are turned back into their shortest decimal text
//    first — never multiplied as floats.
//  · The 30-minute cache is ITS OWN TABLE, qbo_invoice_cache (migration 20261008120200), not
//    qbo_report_cache: that one's reaper caps its ROW COUNT (CS-566), and 750 buildings' keys
//    would crowd the P&L out. Rows older than a day are reaped at the write (THE LAW II.8). The
//    payload carries no status: a status is judged on each read's own org-zone day.
//
// 🔴 THE INTUIT SHAPES ARE NOT YET CONFIRMED against a live company (the P&L's were, 2026-09-28).
// This is built to Intuit's documented Invoice and Payment query answers; the fixtures in
// scripts/fixtures/qbo/ say so. A refused field list falls back to `select *` once (logged), the
// way queryEntities falls back when the count query is refused.
import { createHash } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { qboEnvironment, isConfigured } from './config.js';
import { getConnectionForEnv, listLinks } from './store.js';
import { getValidAccessToken } from './tokens.js';
import { queryRows, fetchInvoicePdf, QboError, isTransient } from './client.js';
import { centsFromDecimalString, realmDimension } from './report.js';
import { loadEntities, NIGHTLY_TTL_MS } from './pnl.js';
import {
  HUB_INVOICE_STATE, HUB_INVOICE_CACHE_MS, invoiceWindowStart, invoiceCustomerIds, isDay,
} from '../../../src/lib/hubInvoices.js';
import { dayKey } from '../../../src/lib/dates.js';

const ORG = CLEANSPACE_ORG_ID;
export const INVOICE_CACHE_TABLE = 'qbo_invoice_cache';
// A cached answer older than this is gone at the next write anywhere (a day: today's window).
export const INVOICE_CACHE_REAP_MS = 24 * 60 * 60 * 1000;
// The cached shape's version: 🔴 BUMP IT when parseIntuitInvoice's output changes, so a payload
// from an older parser is never served (THE LAW II.7, the PNL_PARSE_VERSION rule).
export const INVOICE_PARSE_VERSION = 1;

// The fields one invoice row needs. LinkedTxn names the payments, for the paid date.
export const INVOICE_FIELDS = 'Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef, LinkedTxn';
const PAGE = 1000;        // Intuit's maxresults ceiling
const MAX_PAGES = 5;      // 5,000 invoices in a year for ONE building is not a building
const IN_CHUNK = 100;     // ids per `in (…)` list

// A QuickBooks id is digits. Every id interpolated into a query statement passes this first; a
// request's id that does not is a 404 before anything is asked.
const QBO_ID_RE = /^\d{1,20}$/;
export const isQboId = (v) => typeof v === 'string' && QBO_ID_RE.test(v);

const amount = (v) => centsFromDecimalString(typeof v === 'number' ? String(v) : v);
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const quoted = (ids) => ids.map((id) => `'${id}'`).join(', ');

// One Intuit invoice → the row this module caches (no status: see the header). Throws on a money
// value Intuit never sends (API drift is loud, never a silent zero).
export function parseIntuitInvoice(raw) {
  const id = raw && raw.Id != null ? String(raw.Id) : '';
  if (!id) throw new Error('qbo: an invoice without an Id');
  const issuedDay = isDay(raw.TxnDate) ? raw.TxnDate : null;
  const doc = typeof raw.DocNumber === 'string' ? raw.DocNumber.trim() : '';
  return {
    id,
    number: doc ? doc.slice(0, 40) : id,
    totalCents: amount(raw.TotalAmt),
    balanceCents: amount(raw.Balance),
    issuedDay,
    dueDay: isDay(raw.DueDate) ? raw.DueDate : issuedDay,
    customerId: raw.CustomerRef && raw.CustomerRef.value != null ? String(raw.CustomerRef.value) : null,
    paymentIds: (Array.isArray(raw.LinkedTxn) ? raw.LinkedTxn : [])
      .filter((l) => l && l.TxnType === 'Payment' && l.TxnId != null && QBO_ID_RE.test(String(l.TxnId)))
      .map((l) => String(l.TxnId)),
  };
}

// ── which QuickBooks customers are this building's ────────────────────────────
// → { state } for every case that has nothing to read, else { state: 'ready', environment,
// realmId, customerIds }. Answers the not-* states WITHOUT asking Intuit anything.
export async function buildingInvoiceScope({ clientId, deadline = null }) {
  const environment = qboEnvironment();
  if (!environment || !isConfigured()) return { state: HUB_INVOICE_STATE.notConnected };
  const conn = await getConnectionForEnv(environment);
  if (!conn || conn.status === 'reauth_required') return { state: HUB_INVOICE_STATE.notConnected };
  const realmLinks = (await listLinks()).filter((l) => l.realm_id === conn.realm_id);
  const own = realmLinks.find((l) => l.client_id === clientId);
  if (!own) return { state: HUB_INVOICE_STATE.notLinked };
  const dimension = realmDimension(realmLinks);
  if (dimension !== 'customer' || own.entity_type !== 'customer') {
    console.error(`[api/hub] invoices unsupported-dimension: the company links its buildings by ${dimension || 'nothing'} and this one by ${own.entity_type}; invoices are billed per QuickBooks customer, so none are shown`);
    return { state: HUB_INVOICE_STATE.unsupportedDimension };
  }
  if (!isQboId(own.entity_id)) {
    console.error('[api/hub] invoices: the building\'s QuickBooks link is not a customer id; none are shown');
    return { state: HUB_INVOICE_STATE.notLinked };
  }
  // The nightly customer list is enough here (a sub-customer added today joins tomorrow), so a
  // hub read almost never pays for the whole list itself.
  const { entities } = await loadEntities({ environment, realmId: conn.realm_id, type: 'customer', maxAgeMs: NIGHTLY_TTL_MS, deadline });
  const others = realmLinks.filter((l) => l.client_id !== clientId && l.entity_type === 'customer').map((l) => String(l.entity_id));
  return {
    state: HUB_INVOICE_STATE.ready,
    environment,
    realmId: conn.realm_id,
    customerIds: invoiceCustomerIds(String(own.entity_id), entities, others).filter(isQboId),
  };
}

// ── Intuit reads ─────────────────────────────────────────────────────────────
// The field list first; a QuickBooks that refuses it (a 4xx `api_error`) is asked for whole
// rows instead — still every row, just bigger.
async function queryWithFallback(token, { environment, realmId, entity, fields, tail, deadline }) {
  try {
    return await queryRows(token, { environment, realmId, entity, query: `select ${fields} from ${entity} ${tail}`, deadline });
  } catch (e) {
    if (!(e instanceof QboError) || e.code !== 'api_error') throw e;
    console.error(`[api/hub] invoices: QuickBooks refused the ${entity} field list; reading whole rows`);
    return queryRows(token, { environment, realmId, entity, query: `select * from ${entity} ${tail}`, deadline });
  }
}

async function fetchInvoiceRows(token, { environment, realmId, customerIds, sinceDay, deadline }) {
  const byId = new Map();
  for (const ids of chunks(customerIds, IN_CHUNK)) {
    const where = `where CustomerRef in (${quoted(ids)}) and TxnDate >= '${sinceDay}'`;
    for (let p = 0; ; p += 1) {
      if (p >= MAX_PAGES) throw new QboError('too_many', 'Too many QuickBooks invoices to read.');
      const rows = await queryWithFallback(token, {
        environment, realmId, entity: 'Invoice', fields: INVOICE_FIELDS, deadline,
        tail: `${where} orderby Id startposition ${p * PAGE + 1} maxresults ${PAGE}`,
      });
      for (const r of rows) if (r && r.Id != null) byId.set(String(r.Id), r);
      if (rows.length < PAGE) break;
    }
  }
  return [...byId.values()];
}

// The paid date of each PAID invoice: the latest TxnDate among the Payments linked to it. An
// invoice settled some other way (a credit memo, a journal entry) has no paid date.
async function paymentDays(token, { environment, realmId, paymentIds, deadline }) {
  const days = new Map();
  for (const ids of chunks(paymentIds, IN_CHUNK)) {
    const rows = await queryWithFallback(token, {
      environment, realmId, entity: 'Payment', fields: 'Id, TxnDate', deadline,
      tail: `where Id in (${quoted(ids)}) maxresults ${PAGE}`,
    });
    for (const r of rows) if (r && r.Id != null && isDay(r.TxnDate)) days.set(String(r.Id), r.TxnDate);
  }
  return days;
}

// ── the cache (its own table; reaped at the write) ───────────────────────────
export function invoiceCacheKey({ environment, realmId, clientId, sinceDay, customerIds }) {
  const digest = createHash('sha256').update(customerIds.join(',')).digest('hex').slice(0, 16);
  return `inv:v${INVOICE_PARSE_VERSION}:${environment}:${realmId}:${clientId}:${sinceDay}:${digest}`;
}

async function readCache(cacheKey) {
  const { data, error } = await getSupabase().from(INVOICE_CACHE_TABLE).select('payload, fetched_at')
    .eq('organization_id', ORG).eq('cache_key', cacheKey).maybeSingle();
  if (error) throw new Error(`${INVOICE_CACHE_TABLE} read failed: ${error.message}`);
  return data ?? null;
}

// Rows older than INVOICE_CACHE_REAP_MS go, for every building. Logged, never thrown: a failed
// reap must not fail the read that is writing a fresh row.
export async function reapInvoiceCache({ maxAgeMs = INVOICE_CACHE_REAP_MS } = {}) {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const { data, error } = await getSupabase().from(INVOICE_CACHE_TABLE).delete()
      .eq('organization_id', ORG).lt('fetched_at', cutoff).select('cache_key');
    if (error) throw new Error(error.message);
    return { reaped: Array.isArray(data) ? data.length : 0 };
  } catch (e) {
    console.error(`[api/hub] invoice cache reap failed: ${String(e?.message || '').slice(0, 160)}`);
    return { reaped: 0 };
  }
}

async function writeCache(cacheKey, payload, fetchedAt) {
  const { error } = await getSupabase().from(INVOICE_CACHE_TABLE).upsert(
    { organization_id: ORG, cache_key: cacheKey, payload, fetched_at: fetchedAt },
    { onConflict: 'organization_id,cache_key' },
  );
  if (error) throw new Error(`${INVOICE_CACHE_TABLE} write failed: ${error.message}`);
  await reapInvoiceCache();
}

const latest = (days) => days.filter(isDay).sort().pop() || null;

// ── the building's invoices ──────────────────────────────────────────────────
// → { state, invoices: [{ id, number, totalCents, balanceCents, issuedDay, dueDay, paidDay }],
// asOf }. Served from the cache inside HUB_INVOICE_CACHE_MS; when QuickBooks does not answer and
// a copy from the last day is held, that copy is served with its own time rather than nothing.
// A QboError other than a transient one propagates (the branch says `unavailable`).
export async function invoicesForBuilding({ clientId, now = Date.now(), tz = null, deadline = null }) {
  const scope = await buildingInvoiceScope({ clientId, deadline });
  if (scope.state !== HUB_INVOICE_STATE.ready) return { state: scope.state, invoices: [], asOf: null };
  const { environment, realmId, customerIds } = scope;
  const today = dayKey(new Date(now), tz);
  const sinceDay = invoiceWindowStart(today);
  const key = invoiceCacheKey({ environment, realmId, clientId, sinceDay, customerIds });
  const cached = await readCache(key);
  if (cached && now - Date.parse(cached.fetched_at) < HUB_INVOICE_CACHE_MS && Array.isArray(cached.payload?.invoices)) {
    return { state: HUB_INVOICE_STATE.ready, invoices: cached.payload.invoices, asOf: cached.fetched_at };
  }
  try {
    const token = await getValidAccessToken(environment);
    const wanted = new Set(customerIds);
    const parsed = (await fetchInvoiceRows(token, { environment, realmId, customerIds, sinceDay, deadline }))
      .map(parseIntuitInvoice)
      // Belt and braces: Intuit was asked for these customers only; keep exactly those.
      .filter((x) => x.customerId && wanted.has(x.customerId) && x.issuedDay && x.issuedDay >= sinceDay);
    const paidIds = [...new Set(parsed.filter((x) => x.totalCents > 0 && x.balanceCents <= 0).flatMap((x) => x.paymentIds))];
    const days = paidIds.length ? await paymentDays(token, { environment, realmId, paymentIds: paidIds, deadline }) : new Map();
    const invoices = parsed.map((x) => ({
      id: x.id, number: x.number, totalCents: x.totalCents, balanceCents: x.balanceCents,
      issuedDay: x.issuedDay, dueDay: x.dueDay, paidDay: latest(x.paymentIds.map((p) => days.get(p))),
    }));
    const fetchedAt = new Date(now).toISOString();
    await writeCache(key, { invoices }, fetchedAt);
    return { state: HUB_INVOICE_STATE.ready, invoices, asOf: fetchedAt };
  } catch (e) {
    if (cached && Array.isArray(cached.payload?.invoices) && isTransient(e)) {
      console.error(`[api/hub] invoices: QuickBooks did not answer (${e.code}); serving the copy from ${cached.fetched_at}`);
      return { state: HUB_INVOICE_STATE.ready, invoices: cached.payload.invoices, asOf: cached.fetched_at };
    }
    throw e;
  }
}

// ── one invoice's PDF, after re-checking it is this building's ────────────────
// → { found: false } (the branch answers 404, asking Intuit for no PDF) or { found: true, pdf,
// number }. The invoice is READ AGAIN by id, here, now — its CustomerRef must be one of this
// building's customers, it must be inside the window and not voided. A cached list is never the
// authority for serving a document.
export async function buildingInvoicePdf({ clientId, invoiceId, now = Date.now(), tz = null, deadline = null }) {
  if (!isQboId(invoiceId)) return { found: false };
  const scope = await buildingInvoiceScope({ clientId, deadline });
  if (scope.state !== HUB_INVOICE_STATE.ready) return { found: false };
  const { environment, realmId, customerIds } = scope;
  const sinceDay = invoiceWindowStart(dayKey(new Date(now), tz));
  const token = await getValidAccessToken(environment);
  const rows = await queryWithFallback(token, {
    environment, realmId, entity: 'Invoice', fields: 'Id, DocNumber, TxnDate, TotalAmt, CustomerRef', deadline,
    tail: `where Id = '${invoiceId}'`,
  });
  const raw = rows.find((r) => r && String(r.Id) === invoiceId);
  if (!raw) return { found: false };
  const inv = parseIntuitInvoice(raw);
  if (!inv.customerId || !customerIds.includes(inv.customerId)) return { found: false };
  if (!(inv.totalCents > 0) || !inv.issuedDay || inv.issuedDay < sinceDay) return { found: false };
  const pdf = await fetchInvoicePdf(token, { environment, realmId, invoiceId, deadline });
  return { found: true, pdf, number: inv.number };
}
