// THE BILLING MESSAGES' INPUTS, FROM QUICKBOOKS (Matt's approved messages, 2026-10-19): the
// upcoming-due reminder (7 days before an invoice is due) and the monthly statement (the 1st), both
// email. Read-only; server only.
//
// ONE company-wide read per kind, never one per building (750 buildings × one Intuit call each
// would not fit a run): the open invoices (`Balance > '0'`, with QuickBooks' own customer pay link,
// `include=invoiceLink`), and on a statement day last month's invoices and payments. Each row is
// placed on a building by the P&L's nearest-linked rule (src/lib/hubInvoices.js
// invoiceCustomerIds: a building's linked QuickBooks customer and every sub-customer not linked to
// another building) — the same rule the client hub's Invoices tab uses. Only a company that links
// its buildings BY CUSTOMER can say whose invoice is whose (CS-565); any other answers nothing.
// The answer is cached for six hours in qbo_invoice_cache (its own key; that table's reaper keeps
// a day), so the 120 runs of a day ask Intuit four times.
//
// 🔴 NOT YET CONFIRMED against a live company: the Invoice / Payment shapes (and InvoiceLink, which
// QuickBooks returns only for an invoice with online payment on and a customer email) are Intuit's
// documented ones. With no pay link an invoice's messages are not sent (their words promise one).
import { createHash } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { qboEnvironment, isConfigured } from '../qbo/config.js';
import { getConnectionForEnv, listLinks } from '../qbo/store.js';
import { getValidAccessToken } from '../qbo/tokens.js';
import { queryRows } from '../qbo/client.js';
import { centsFromDecimalString, realmDimension } from '../qbo/report.js';
import { loadEntities, NIGHTLY_TTL_MS } from '../qbo/pnl.js';
import { invoiceCustomerIds, isDay } from '../../../src/lib/hubInvoices.js';
import { INVOICE_CACHE_TABLE } from '../qbo/invoices.js';
import { addDaysKey, addMonthsKey } from '../../../src/lib/dates.js';

const ORG = CLEANSPACE_ORG_ID;
export const BILLING_CACHE_MS = 6 * 60 * 60 * 1000;
export const BILLING_PARSE_VERSION = 1;
const PAGE = 1000;
const MAX_PAGES = 20;
const amount = (v) => centsFromDecimalString(typeof v === 'number' ? String(v) : v);
const httpsOrNull = (v) => (typeof v === 'string' && /^https:\/\/\S+$/i.test(v.trim()) ? v.trim() : null);

// PURE. QuickBooks customer id -> building (client id), for every building linked by customer.
export function customerOwners(links, entities) {
  const byCustomer = links.filter((l) => l.entity_type === 'customer' && l.entity_id != null);
  const all = byCustomer.map((l) => String(l.entity_id));
  const owner = new Map();
  for (const l of byCustomer) {
    for (const id of invoiceCustomerIds(String(l.entity_id), entities, all)) {
      if (!owner.has(id)) owner.set(id, l.client_id);
    }
  }
  return owner;
}

// PURE. The run's billing input from Intuit's rows.
//   → { invoices: [{ id, number, clientId, dueDay, balanceCents, totalCents, payLink }],
//       statements: [{ clientId, month, periodStart, periodEnd, balanceCents, invoices, payments }] }
export function billingFromRows({ owner, openRows = [], monthInvoiceRows = null, paymentRows = null, month = null, periodStart = null, periodEnd = null }) {
  const invoices = [];
  for (const r of openRows) {
    const clientId = owner.get(String(r?.CustomerRef?.value ?? ''));
    if (!clientId || r?.Id == null) continue;
    const balanceCents = amount(r.Balance);
    if (!(balanceCents > 0)) continue;
    const issued = isDay(r.TxnDate) ? r.TxnDate : null;
    invoices.push({
      id: String(r.Id),
      number: typeof r.DocNumber === 'string' && r.DocNumber.trim() ? r.DocNumber.trim().slice(0, 40) : String(r.Id),
      clientId,
      dueDay: isDay(r.DueDate) ? r.DueDate : issued,
      balanceCents,
      totalCents: amount(r.TotalAmt),
      payLink: httpsOrNull(r.InvoiceLink),
    });
  }
  let statements = [];
  if (month && monthInvoiceRows && paymentRows) {
    const by = new Map();
    const entry = (clientId) => {
      if (!by.has(clientId)) by.set(clientId, { clientId, month, periodStart, periodEnd, balanceCents: 0, invoices: [], payments: [] });
      return by.get(clientId);
    };
    for (const r of monthInvoiceRows) {
      const clientId = owner.get(String(r?.CustomerRef?.value ?? ''));
      if (!clientId || !isDay(r.TxnDate) || r.TxnDate < periodStart || r.TxnDate > periodEnd) continue;
      entry(clientId).invoices.push({ number: String(r.DocNumber || r.Id), issuedDay: r.TxnDate, totalCents: amount(r.TotalAmt), balanceCents: amount(r.Balance) });
    }
    for (const r of paymentRows) {
      const clientId = owner.get(String(r?.CustomerRef?.value ?? ''));
      if (!clientId || !isDay(r.TxnDate) || r.TxnDate < periodStart || r.TxnDate > periodEnd) continue;
      entry(clientId).payments.push({ day: r.TxnDate, amountCents: amount(r.TotalAmt) });
    }
    for (const inv of invoices) entry(inv.clientId).balanceCents += inv.balanceCents;
    statements = [...by.values()].map((s) => ({
      ...s,
      invoices: s.invoices.sort((a, b) => (a.issuedDay < b.issuedDay ? -1 : 1)),
      payments: s.payments.sort((a, b) => (a.day < b.day ? -1 : 1)),
    }));
  }
  return { invoices, statements };
}

// The previous calendar month of `today`: { month: 'YYYY-MM', periodStart, periodEnd }.
export function previousMonth(today) {
  const first = `${today.slice(0, 8)}01`;
  const start = addMonthsKey(first, -1);
  return { month: start.slice(0, 7), periodStart: start, periodEnd: addDaysKey(first, -1) };
}

async function allRows(token, { environment, realmId, entity, fields, where, include }) {
  const out = [];
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const rows = await queryRows(token, {
      environment, realmId, entity, include,
      query: `select ${fields} from ${entity} ${where} orderby Id startposition ${p * PAGE + 1} maxresults ${PAGE}`,
    });
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  console.error(`[reminders] billing: the ${entity} read stopped at ${MAX_PAGES * PAGE} rows`);
  return out;
}

let readerOverride = null;
// A suite swaps the whole QuickBooks read for its own (null restores the real one).
export function __setBillingReaderForTests(fn) { readerOverride = typeof fn === 'function' ? fn : null; }

// → the billing input, or null when QuickBooks cannot say (not connected, linked another way,
// unreadable): then no billing message is due. `withStatements`: today is a statement day.
export async function readBilling({ now = new Date(), today, withStatements = false } = {}) {
  if (readerOverride) return readerOverride({ now, today, withStatements });
  try {
    const environment = qboEnvironment();
    if (!environment || !isConfigured()) return null;
    const conn = await getConnectionForEnv(environment);
    if (!conn || conn.status === 'reauth_required') return null;
    const links = (await listLinks()).filter((l) => l.realm_id === conn.realm_id);
    if (!links.length || realmDimension(links) !== 'customer') return null;
    const slot = Math.floor(now.getUTCHours() / 6);
    const key = `msg:v${BILLING_PARSE_VERSION}:${environment}:${conn.realm_id}:${today}:${slot}:${withStatements ? 's' : 'i'}:${createHash('sha256').update(links.map((l) => `${l.client_id}=${l.entity_id}`).sort().join(',')).digest('hex').slice(0, 12)}`;
    const { data: cached } = await getSupabase().from(INVOICE_CACHE_TABLE).select('payload, fetched_at')
      .eq('organization_id', ORG).eq('cache_key', key).maybeSingle();
    if (cached?.payload && now.getTime() - Date.parse(cached.fetched_at) < BILLING_CACHE_MS) return cached.payload;

    const { entities } = await loadEntities({ environment, realmId: conn.realm_id, type: 'customer', maxAgeMs: NIGHTLY_TTL_MS });
    const owner = customerOwners(links, entities);
    const token = await getValidAccessToken(environment);
    const base = { environment, realmId: conn.realm_id };
    const openRows = await allRows(token, { ...base, entity: 'Invoice', fields: 'Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef', where: "where Balance > '0'", include: 'invoiceLink' });
    let extra = {};
    if (withStatements) {
      const pm = previousMonth(today);
      const range = `where TxnDate >= '${pm.periodStart}' and TxnDate <= '${pm.periodEnd}'`;
      extra = {
        ...pm,
        monthInvoiceRows: await allRows(token, { ...base, entity: 'Invoice', fields: 'Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef', where: range }),
        paymentRows: await allRows(token, { ...base, entity: 'Payment', fields: 'Id, TxnDate, TotalAmt, CustomerRef', where: range }),
      };
    }
    const payload = billingFromRows({ owner, openRows, ...extra });
    await getSupabase().from(INVOICE_CACHE_TABLE).upsert(
      { organization_id: ORG, cache_key: key, payload, fetched_at: now.toISOString() },
      { onConflict: 'organization_id,cache_key' },
    );
    return payload;
  } catch (e) {
    console.error('[reminders] billing read failed:', e?.code || e?.name || 'error', String(e?.message || '').slice(0, 160));
    return null;
  }
}
