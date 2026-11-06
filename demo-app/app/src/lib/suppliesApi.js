// Supplies API adapter (SUP-13, 2026-10-05). Real backend by default — Vercel serves
// /api/supplies/* over the supply tables (the queue and the approved lists left org_state).
//
// The localStorage stub engages ONLY in a DEMO build, on the STATIC `import.meta.env.MODE` Vite
// inlines at build time, exactly as lib/contractsApi.js does (the CS-010 lesson: a runtime env
// read once ran production on a browser stub for weeks). In `npm run build` STUB folds to a
// literal `false`, every `if (!STUB)` takes the real path, and the stub bodies plus the
// 'cs-stub:supplies' sentinel are dead code esbuild removes — check-bundle-stubs.mjs asserts it.
//
// 🔴 THE STUB RUNS THE SERVER'S RULES, not its own: the state machine and the stamps
// (lib/supplyFlow supplyDecisionPatch), the per-line acts (supplyFulfillPatch), who may decide or
// cancel (lib/supplies maySupplyDecide / maySupplyCancel), the snapshot from the building's own
// list (snapshotSupplyLines, with the cleaner's 1–20), the 12-month window and its refusal
// (supplyUsageWindowKeys), the queue's tabs (supplyQueueTabOf) and its number search
// (supplyOrderNumberOf), usage and spend per DELIVERY (supplyUsageByItem /
// supplyDeliveredCentsByClient), and the master list's (2026-10-11): the catalog sanitizer and the
// SKU rule (supplyCatalogFields / findSupplySkuClash), the switches (planSupplyAssign) and the
// history keyed on the catalog item. A demo that decided by rules of its own would be a second
// implementation to drift. The ONE thing it does not do is ring the bell or write the activity log:
// the demo's bell rows live in the store, which an API module does not write.
//
// `ctx` — { state, user, holds: { view, request, approve, manage, deliver } } — is read by the STUB
// only: the real route takes the caller's identity and permissions from the login's claim, never
// from here.
//
// 🔴 THE SUPPLY ORDERS (S131, plan docs/plans/2026-10-14-supply-orders.md): `listOrders` (the queue:
// six tabs, the Supply Manager's tiles, search by an order number), `getOrder` (one order, each
// line's state, its comments, photos and invoices, who approves it), `submitOrders` (Submit to
// supplier), `fulfillOrder` (deliver / backorder / cancel per line), `completeOrder`, `addOrderComment`,
// the invoice (`invoiceUploadUrl` → the bytes → `invoiceConfirm`, `invoiceViewUrl`, `invoiceDelete`;
// `uploadOrderInvoice` runs the three in order), `uploadCatalogImage`, and the driver's per-line
// `deliverRequests`. The delivery step's "how many went out" call and the queue's old list read are
// deleted (II.5).
//
// THE CLEANER ORDERS SUPPLIES (the Cleaner Hub, D4, 2026-10-13; S131 Builder C): `crewList` (one
// building's list with each product's photo link, and the cleaner's OWN orders there — no money),
// `crewOrder` (one of their orders, EP-400), `crewOrders` (their newest, Home's tile, EP-401), and
// `createRequest` from the cleaner's own page. The stub runs the route's rules for them: a caller who
// is not an office role only for a building they clean today or upcoming (lib/crewScope
// crewUpcomingClientIds), one order only their own there (lib/supplies crewMayReadOrder), at most
// CREW_SUPPLY_MAX_QTY of an item, answered field by field (supplyCrewList / supplyCrewOrder /
// supplyCrewOrders / supplyCrewRequest).
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { supabase } from './supabaseClient';
import { SUPPLIES_STUB_KEY } from '../data/stubKeys';
import { newId } from './ids';
import { todayKey, startOfDayKey, addDaysKey, startOfMonthKey, dayKey } from './dates';
import { customerLabel } from './customerNumber';
import { resolveSupplyApprover } from './notifications';
import { crewTodayClientIds, crewUpcomingClientIds } from './crewScope';
import { hubPersonName } from './clientHub';
import { ROLES } from './roles';
import { TEAM, teamClientIds, teamLeadFor } from './teamScope';
import { listMedia as listAccountMedia, stubRemoveMediaForRef } from './accountMediaApi';
import {
  SUPPLY_STATUS, SUPPLY_QUEUE_TABS, supplyStatusOf, maySupplyDecide, maySupplyCancel, isSupplyCancellable,
  snapshotSupplyLines, supplySearchText, supplyUsageByItem, supplyQueueTabOf, supplyOrderNumberOf,
  supplyUsageWindowKeys, supplyHistoryStartKey, isSupplySettled, supplySettledAt,
  runSupplyDecideBatches, supplyItemHistory, supplyRecentStartKey, withSupplyHistory,
  supplyBuildingRows, supplyBuildingCounts, supplyDeliveredCentsByClient, supplyOrderProgress,
  supplyApproverOpsManagerId, supplyCommentBody, CREW_SUPPLY_MAX_QTY, SUPPLY_INVOICE_MAX_BYTES, SUPPLY_INVOICE_MIME,
  supplyCatalogFields, findSupplySkuClash, supplyCategories, planSupplyAssign, supplyItemCatalogMap,
  supplyFromCents, SUPPLY_NO_CATEGORY, supplyCategoryAsUsed, supplyDeliveryList, supplyCrewBuildings,
  supplyCrewList, supplyCrewRequest, supplyCrewOrder, supplyCrewOrders, crewMayReadOrder, SUPPLY_DECIDE_MAX,
} from './supplies';
import { supplyDecisionPatch, supplyFulfillPatch } from './supplyFlow';
import { planCatalogImportWrite, readCatalogImportBody } from './supplyCatalogImport';

// PLAIN member reads so Vite inlines them and STUB folds to a literal (see the header).
const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_SUPPLIES_STUB === '1' || import.meta.env.VITE_SUPPLIES_STUB === 'true'));
if (STUB) markStub('cs-stub:supplies');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';
export const SUPPLY_PAGE_SIZE = 20;
// The private bucket an order's invoice lives in (migration 20261014120000).
const INVOICE_BUCKET = 'supply-documents';

export function isSuppliesStub() { return STUB; }

// Caller-minted ids, so a retried save or submit is a no-op server-side, never a duplicate. (A
// building's switch rows are minted by the route: the one-per-building-and-item index makes a
// retried switch a no-op on its own.)
export const newSupplyCatalogId = () => newId('sc');
export const newSupplyRequestId = () => newId('sr');
export const newSupplyCommentId = () => newId('src');
export const newSupplyDocumentId = () => newId('sdoc');

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let payload = null;
    try { payload = await res.json(); msg = payload.error || msg; } catch { /* non-JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    if (payload) {
      err.code = payload.code; err.firstKey = payload.firstKey; err.itemId = payload.itemId; err.holder = payload.holder;
      err.max = payload.max; err.line = payload.line;
    }
    throw err;
  }
  return res.json();
}
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// ── the calls ───────────────────────────────────────────────────────────────

// One building's list: its SWITCHED-ON items, read through the catalog (sku, category,
// catalogItemId and the product image beside the name, unit and price). `history` adds each item's
// last delivery, its quantity and the last 90 days' total, keyed on the catalog item (the customer's
// Supplies tab); the request form reads the plain list.
export async function listItems(clientId, { history = false } = {}) {
  if (!STUB) return (await api(`/supplies/items?${qs({ clientId, history: history ? 1 : null })}`)).items;
  const db = stubDb();
  const items = stubItemsOf(db, clientId);
  if (!history) return items;
  const today = todayKey();
  return withSupplyHistory(items, supplyItemHistory(db.requests.filter((r) => r.clientId === clientId), {
    recentFromMs: startOfDayKey(supplyRecentStartKey(today)).getTime(), itemCatalog: supplyItemCatalogMap(items),
  }));
}

// ── the master list (the Oct 6 call; plan 2026-10-11 §2) ─────────────────────
// The Catalog tab's read: one server page of 20 with its total, "On N buildings" per row and every
// category in use — or, with `all`, the WHOLE catalog (a building's switches).
// { items, total, page?, pageSize?, categories }. Each item carries `imageUrl` (S131).
export async function listCatalog({ q, category, page = 1, all = false } = {}) {
  if (!STUB) return api(`/supplies/catalog?${qs({ q, category, page: all ? null : page, all: all ? 1 : null })}`);
  return stubCatalog({ q, category, page, all });
}
// Add or edit one catalog item (the office). A SKU another item holds is refused with the item
// holding it (`err.code === 'sku_taken'`, `err.holder`).
export async function saveCatalogItem(payload) {
  if (!STUB) return (await api('/supplies/catalog/save', { method: 'POST', body: payload })).item;
  return stubSaveCatalogItem(payload);
}
// Delete one catalog item: it leaves every building's list (and its image leaves Storage). Answers
// how many buildings had it.
export async function deleteCatalogItem(id) {
  if (!STUB) return api('/supplies/catalog/delete', { method: 'POST', body: { id } });
  return stubDeleteCatalogItem(id);
}
// A PRODUCT IMAGE (S131, EP-399): `dataUrl` — a JPEG the device already shrank (lib/imageCanvas
// shrinkPhoto) — or `remove: true`. A compare-and-swap on the item's `version` (409 `stale`).
// → the item, with its new `imageUrl`.
export async function uploadCatalogImage({ id, version, dataUrl = null, remove = false }) {
  if (!STUB) return (await api('/supplies/catalog/image', { method: 'POST', body: { id, version, ...(remove ? { remove: true } : { dataUrl }) } })).item;
  return stubCatalogImage({ id, version, dataUrl, remove });
}
// IMPORT ITEMS (task 257): one batch of at most CATALOG_IMPORT_BATCH items (lib/supplyCatalogImport
// catalogImportItems) → { results: [{ id, ok, created, code?, holder?, item? }], counts }. Every item
// is answered; a new one's id was minted once per preview, so a retried batch adds nothing twice.
export async function importCatalog(items) {
  if (!STUB) return api('/supplies/catalog/import', { method: 'POST', body: { items } });
  return stubImportCatalog(items);
}
// The picture behind a web link, downloaded by the SERVER (a browser cannot read another site's
// picture) → { dataUrl, type, bytes }; a link it would not or could not fetch throws with its `code`.
// The demo has no server: it says so (`demo_no_download`).
export async function fetchImageLink(url) {
  if (!STUB) return api('/supplies/catalog/image-link', { method: 'POST', body: { url } });
  throw refuse('The demo does not download pictures from links.', 501, 'demo_no_download');
}
// A building's switches: ONE call carries what to switch on and off (catalog ids), every one
// answered by name — { results: [{ catalogItemId, on, ok, code }], counts }.
export async function assignItems({ clientId, on = [], off = [] }) {
  if (!STUB) return api('/supplies/items/assign', { method: 'POST', body: { clientId, on, off } });
  return stubAssign({ clientId, on, off });
}

// 🔴 THE ORDER QUEUE (EP-390): one PAGE of a tab (SUPPLY_QUEUE_TABS: open · approved · sent · partial ·
// completed · rejected), its total, every tab's count and the Supply Manager's `completedToday`, and
// (on the two tabs with a bulk action) every match's id + building for "Select all N". `countsOnly`
// reads just the counts. → { orders, total, page, pageSize, counts, matches? } | { counts }
export async function listOrders({ status, mgr, cust, om, q, page = 1, countsOnly = false } = {}, ctx) {
  if (!STUB) return api(`/supplies/orders?${qs({ status, mgr, cust, om, q, page, countsOnly: countsOnly ? 1 : null })}`);
  return stubOrders({ status, mgr, cust, om, q, page, countsOnly }, ctx);
}
// ONE ORDER (EP-391): { order, progress, comments, photos, invoices, approver, approverOpsManagerId }.
export async function getOrder(id, ctx) {
  if (!STUB) return api(`/supplies/order?${qs({ id })}`);
  return stubGetOrder(id, ctx);
}
// ONE building's requests: every OPEN one (requested, approved or submitted — a complete read,
// because the order sheet's on-order total is a figure) and its newest settled ones, newest first.
export async function buildingRequests(clientId) {
  if (!STUB) return api(`/supplies/requests?${qs({ building: clientId })}`);
  const mine = stubDb().requests.filter((r) => r.clientId === clientId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return {
    open: mine.filter((r) => !isSupplySettled(r)),
    recent: mine.filter((r) => isSupplySettled(r)).slice(0, 5),
  };
}
export async function createRequest(payload, ctx) {
  if (!STUB) return (await api('/supplies/requests/create', { method: 'POST', body: payload })).request;
  return stubCreate(payload, ctx);
}
// ONE call for one order or the bulk bar's batch (UI_RULES §132): { results, counts }. A selection
// bigger than one call may carry (SUPPLY_DECIDE_MAX) goes as several, answers merged in order, and an
// id a failed later batch never reached comes back named 'failed'. approve / reject / reopen only.
export async function decideRequests({ ids, decision, reason }, ctx) {
  return runSupplyDecideBatches(ids, (batch) => (STUB
    ? stubMove({ ids: batch, decision, reason }, ctx)
    : api('/supplies/requests/decide', { method: 'POST', body: { ids: batch, decision, reason } })));
}
// 🔴 SUBMIT TO SUPPLIER (EP-392): one order or the New tab's batch — { results, counts }.
export async function submitOrders({ ids }, ctx) {
  return runSupplyDecideBatches(ids, (batch) => (STUB
    ? stubMove({ ids: batch, decision: 'submit' }, ctx)
    : api('/supplies/orders/submit', { method: 'POST', body: { ids: batch } })));
}
// 🔴 THE PER-LINE ACTS (EP-393) on ONE submitted order, a CAS on the `version` the page read:
// `acts` [{ line, act: 'deliver' | 'backorder' | 'cancel', qty?, eta?, reason? }] — all land or none.
// → { order, progress, applied } for the Supply Manager; { id, version, applied } for a driver.
// Refusals carry `err.code` (stale · not_submitted · line_resolved · bad_qty · bad_eta · bad_reason …)
// and `err.line`.
export async function fulfillOrder({ id, version, acts }, ctx) {
  if (!STUB) return api('/supplies/orders/fulfill', { method: 'POST', body: { id, version, acts } });
  return stubFulfill({ id, version, acts }, ctx);
}
// 🔴 MARK COMPLETED (EP-394): only once every line is delivered or cancelled (409 `lines_open`).
// → { order, progress }
export async function completeOrder({ id, version }, ctx) {
  if (!STUB) return api('/supplies/orders/complete', { method: 'POST', body: { id, version } });
  return stubComplete({ id, version }, ctx);
}
// A COMMENT (EP-395): a caller-minted `id`, so a retry adds nothing. → { comment, created }
export async function addOrderComment({ id, requestId, body }, ctx) {
  if (!STUB) return api('/supplies/orders/comment', { method: 'POST', body: { id, requestId, body } });
  return stubComment({ id, requestId, body }, ctx);
}

// ── THE INVOICE (EP-396 / 397 / 398 / 408) ─────────────────────────────────
// An upload address for the path the SERVER builds, the bytes straight to Storage, then the record —
// in that order, so no row ever names a file nobody has (the customer documents' order, CS-043).
export async function invoiceUploadUrl({ requestId, docId, fileName, mimeType, sizeBytes }, ctx) {
  if (!STUB) return api('/supplies/orders/invoice/upload-url', { method: 'POST', body: { requestId, docId, fileName, mimeType, sizeBytes } });
  return stubInvoiceUploadUrl({ requestId, docId, fileName, mimeType, sizeBytes }, ctx);
}
export async function invoiceConfirm({ requestId, docId, fileName, mimeType, sizeBytes }, ctx) {
  if (!STUB) return api('/supplies/orders/invoice/confirm', { method: 'POST', body: { requestId, docId, fileName, mimeType, sizeBytes } });
  return stubInvoiceConfirm({ requestId, docId, fileName, mimeType, sizeBytes }, ctx);
}
// A link to open it: 300 seconds. In the demo a file seeded with the story was never kept, so it
// can't open (`err.code === 'demo_file'`; the page says so on its button).
export async function invoiceViewUrl(id) {
  if (!STUB) return (await api(`/supplies/orders/invoice/view-url?${qs({ id })}`)).url;
  return stubInvoiceViewUrl(id);
}
export async function invoiceDelete(id, ctx) {
  if (!STUB) return api('/supplies/orders/invoice/delete', { method: 'POST', body: { id } });
  return stubInvoiceDelete(id, ctx);
}
// The three, in order, for one picked file. `docId` is minted ONCE by the caller and kept until it
// lands, so a retry after a lost answer files one invoice. → { invoice, created }
export async function uploadOrderInvoice({ requestId, docId, file }, ctx) {
  const meta = { requestId, docId, fileName: String((file && file.name) || 'invoice').slice(0, 200), mimeType: file && file.type, sizeBytes: file && file.size };
  if (!SUPPLY_INVOICE_MIME.includes(meta.mimeType)) throw Object.assign(new Error('Use a PDF, JPG or PNG file.'), { status: 400, code: 'bad_type' });
  if (!(meta.sizeBytes > 0)) throw Object.assign(new Error('That file is empty.'), { status: 400, code: 'bad_size' });
  if (meta.sizeBytes > SUPPLY_INVOICE_MAX_BYTES) throw Object.assign(new Error('That file is over 10 MB.'), { status: 400, code: 'too_large' });
  const up = await invoiceUploadUrl(meta, ctx);
  if (STUB) keepDemoFile(docId, file);
  else {
    const sent = await supabase.storage.from(INVOICE_BUCKET).uploadToSignedUrl(up.path, up.token, file, { contentType: file.type });
    if (sent.error) throw new Error('The file did not upload. Try again.');
  }
  return invoiceConfirm(meta, ctx);
}

// Delivered, by the driver (EP-367, per line since S131): ONE submitted order — the lines named
// (`lines`, by index) or every line still to come — a CAS on the `version` the list showed. The
// answer names what landed and carries no order: { id, ok, version, delivered: [line] }.
export async function deliverRequests({ id, version, lines = null }, ctx) {
  if (!STUB) return api('/supplies/requests/deliver', { method: 'POST', body: { id, version, ...(Array.isArray(lines) ? { lines } : {}) } });
  return stubDeliver({ id, version, lines }, ctx);
}
// The driver's list (S4, per line): every submitted order with something still to come — its
// number, building and address, each line with how many and a backorder's ETA — and today's
// deliveries. No money in it. { dayKey, toDeliver, deliveredToday }.
export async function deliveries(ctx) {
  if (!STUB) return api('/supplies/deliveries');
  return stubDeliveries(ctx);
}
// The cleaner's line (S6): for the buildings the caller cleans today, what is on the way and what
// was delivered today — names and quantities only. { dayKey, buildings }.
export async function onsite(ctx) {
  if (!STUB) return api('/supplies/onsite');
  return stubOnsite(ctx);
}
// The cleaner's Request Supplies page (D4; S131 Builder C): ONE building's switched-on items, each with
// its product photo link, who approves its orders, and the cleaner's OWN orders there, newest first (at
// most CREW_SUPPLY_HISTORY_MAX) — names, quantities, each line's state; no money.
// { clientId, items, approverName, orders }. `userId` names the person on screen for the office's
// View-as (the server honours it only with supplies.view). Throws `err.code === 'not_your_building'`
// (403) for a building the cleaner does not clean.
export async function crewList(clientId, ctx, { userId = null } = {}) {
  if (!STUB) return api(`/supplies/crew-list?${qs({ clientId, userId })}`);
  return stubCrewList(clientId, ctx, { userId });
}
// ONE of the cleaner's own orders (EP-400, the order view their supply bells open): { order }, field by
// field. Any order that is not theirs at a building they clean is `err.code === 'not_found'` (404) —
// the office reads any (the owner's View-as).
export async function crewOrder(id, ctx) {
  if (!STUB) return api(`/supplies/crew-order?${qs({ id })}`);
  return stubCrewOrder(id, ctx);
}
// The cleaner's newest orders at the buildings they clean (EP-401, Home's Request Supplies tile): a
// light read, { orders }, newest first. `userId` as crewList's.
export async function crewOrders({ userId = null } = {}, ctx) {
  if (!STUB) return api(`/supplies/crew-orders?${qs({ userId })}`);
  return stubCrewOrders({ userId }, ctx);
}
export async function cancelRequest(id, ctx) {
  if (!STUB) return api('/supplies/requests/cancel', { method: 'POST', body: { id } });
  return stubCancel(id, ctx);
}
export async function usage({ period, from, to, mgr, cust, om }, ctx) {
  if (!STUB) return api(`/supplies/usage?${qs({ period, from, to, mgr, cust, om })}`);
  return stubUsage({ period, from, to, mgr, cust, om }, ctx);
}
// This calendar month's DELIVERED spend per building — each delivery in its own month (S131):
// { monthKey, spendCents: { id: cents } }.
export async function budgets(ctx) {
  if (!STUB) return api('/supplies/budgets');
  return stubBudgets(ctx);
}
// Every building in the Manager / Customer scope with its ONE state — Needs attention / Pending
// approval / Order placed / All set (the manager view redesign, 2026-10-09; S131 Wave 2) — and its
// in-flight orders (lib/supplies supplyBuildingRows, the route's rule): { monthKey, buildings, counts }.
// One complete read, never one per building; an OFFICE role's (403 office_only otherwise). `mgr` may
// be `team`, the caller's.
export async function buildings({ mgr, cust, om } = {}, ctx) {
  if (!STUB) return api(`/supplies/buildings?${qs({ mgr, cust, om })}`);
  return stubBuildings({ mgr, cust, om }, ctx);
}

// ── stub store (demo only; dead-code-eliminated from a production build) ─────
const nowIso = () => new Date().toISOString();
const EMPTY_DB = () => ({ catalog: [], items: [], requests: [], comments: [], invoices: [] });
const stubDb = () => {
  try {
    const db = JSON.parse(localStorage.getItem(SUPPLIES_STUB_KEY));
    if (!(db && Array.isArray(db.catalog) && Array.isArray(db.items) && Array.isArray(db.requests))) return EMPTY_DB();
    // S131's two lists are additive: a store written before them reads as having none.
    return { ...db, comments: Array.isArray(db.comments) ? db.comments : [], invoices: Array.isArray(db.invoices) ? db.invoices : [] };
  } catch { return EMPTY_DB(); }
};
// → whether it was kept (the device's storage can be full: a demo import's photos fill it).
const saveStub = (db) => { try { localStorage.setItem(SUPPLIES_STUB_KEY, JSON.stringify(db)); return true; } catch { /* quota */ return false; } };
const refuse = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const nameOf = (ctx, id) => (ctx?.state?.users || []).find((u) => u.id === id)?.name || null;
// The route's scopeIds: a Manager / Customer filter's buildings. `team` (S131 Wave 2) is the VIEWER's
// team (lib/teamScope), as the route resolves it from the claim; an owner or an admin may name whose
// with `om` (teamLeadFor, the one rule).
const scopeOf = (ctx, { mgr, cust, om }) => {
  if (!mgr && !cust) return null;
  const clients = ctx?.state?.clients || [];
  const users = ctx?.state?.users || [];
  const team = mgr === TEAM ? teamClientIds(users, clients, teamLeadFor({ role: ctx?.user?.role, selfId: ctx?.user?.id, users, om })) : null;
  return new Set(clients.filter((c) => (!mgr || (team ? team.has(c.id) : c.supervisorId === mgr)) && (!cust || c.id === cust)).map((c) => c.id));
};
const countsOf = (results) => results.reduce((a, x) => ({ ...a, [x.code]: (a[x.code] || 0) + 1 }), {});
// The stub's "sequence": the next number past every one it holds (the demo's story starts at SO-1041).
const DEMO_FIRST_NUMBER = 1041;
const nextNumber = (db) => Math.max(DEMO_FIRST_NUMBER - 1, ...db.requests.map((r) => Number(r.number) || 0)) + 1;

// What goes with an order that leaves the store (a cancel, the 12-month prune): its comments, its
// invoices (and a file picked this session), its delivery photos — as the route removes them.
function dropOrderExtras(db, ids) {
  const gone = new Set(ids);
  if (!gone.size) return;
  for (const inv of db.invoices) if (gone.has(inv.requestId)) forgetDemoFile(inv.id);
  db.comments = db.comments.filter((c) => !gone.has(c.requestId));
  db.invoices = db.invoices.filter((inv) => !gone.has(inv.requestId));
  for (const id of gone) stubRemoveMediaForRef({ scope: 'supply', refId: id });
}

// Retention at the write point, as the route does it (SUP-13: 12 months; in-flight never).
function stubPrune(db) {
  const cutoff = startOfDayKey(supplyHistoryStartKey(todayKey())).getTime();
  const gone = db.requests.filter((r) => isSupplySettled(r) && new Date(supplySettledAt(r) || 0).getTime() < cutoff).map((r) => r.id);
  if (!gone.length) return;
  db.requests = db.requests.filter((r) => !gone.includes(r.id));
  dropOrderExtras(db, gone);
}

// A building's switched-on items read through the catalog — the route's toItem, by name. A switch
// whose catalog item is gone is not orderable and is left out, as the route leaves it.
function stubItemsOf(db, clientId) {
  const byId = new Map(db.catalog.map((c) => [c.id, c]));
  return db.items.filter((it) => it.clientId === clientId && byId.has(it.catalogItemId)).map((it) => {
    const c = byId.get(it.catalogItemId);
    return {
      id: it.id, clientId: it.clientId, catalogItemId: it.catalogItemId,
      sku: c.sku || null, name: c.name || '', category: c.category || null, unit: c.unit || '', unitPrice: c.unitPrice ?? null,
      imageV: c.imageV || null, imageUrl: c.imageUrl || null,
      createdAt: it.createdAt || null, updatedAt: it.updatedAt || null, version: it.version || 1,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

// The route's catalog read, on the stub's rows: the same search (name, SKU, category), the same
// category filter, by name, 20 a page with "On N buildings".
function stubCatalog({ q, category, page, all }) {
  const db = stubDb();
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const cat = category === SUPPLY_NO_CATEGORY ? SUPPLY_NO_CATEGORY : (String(category || '').trim() || null);
  const rows = db.catalog.filter((c) => {
    if (cat === SUPPLY_NO_CATEGORY ? !!c.category : (cat && c.category !== cat)) return false;
    const hay = `${c.name} ${c.sku || ''} ${c.category || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }).sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)))
    .map((c) => ({ ...c, imageUrl: c.imageUrl || null }));
  const categories = supplyCategories(db.catalog);
  if (all) return { items: rows, total: rows.length, categories };
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const onCount = (id) => db.items.filter((it) => it.catalogItemId === id).length;
  return {
    items: rows.slice((p - 1) * SUPPLY_PAGE_SIZE, p * SUPPLY_PAGE_SIZE).map((c) => ({ ...c, buildings: onCount(c.id) })),
    total: rows.length, page: p, pageSize: SUPPLY_PAGE_SIZE, categories,
  };
}

function stubSaveCatalogItem(p) {
  const db = stubDb();
  const f = supplyCatalogFields(p);
  if (f.error) throw refuse('That item cannot be saved.', 400, f.error);
  const holder = findSupplySkuClash(db.catalog, { id: p.id, sku: f.fields.sku });
  if (holder) throw refuse(`That SKU is already on “${holder.name}”.`, 409, 'sku_taken', { holder: { id: holder.id, name: holder.name, sku: holder.sku } });
  const row = {
    sku: f.fields.sku, name: f.fields.name, category: supplyCategoryAsUsed(db.catalog, { id: p.id, category: f.fields.category }),
    unit: f.fields.unit || '', unitPrice: supplyFromCents(f.fields.unitPriceCents),
  };
  const i = db.catalog.findIndex((c) => c.id === p.id);
  if (i >= 0) db.catalog[i] = { ...db.catalog[i], ...row, updatedAt: nowIso(), version: (db.catalog[i].version || 1) + 1 };
  else db.catalog.push({ id: p.id, ...row, createdAt: nowIso(), updatedAt: nowIso(), version: 1 });
  saveStub(db);
  const saved = db.catalog.find((c) => c.id === p.id);
  return { ...saved, imageUrl: saved.imageUrl || null };
}

// The route's image door, on the stub's row: the CAS on the version, then the image (the demo keeps
// the shrunk JPEG itself as the item's link) or none.
function stubCatalogImage({ id, version, dataUrl, remove }) {
  const db = stubDb();
  const i = db.catalog.findIndex((c) => c.id === id);
  if (i < 0) throw refuse('That item is no longer in the catalog.', 404, 'not_found');
  const row = db.catalog[i];
  if (version != null && Number(version) !== (row.version || 1)) throw refuse('Someone changed this item at the same time. Open it again.', 409, 'stale');
  if (!remove && !/^data:image\/(?:jpeg|png);base64,/.test(String(dataUrl || ''))) throw refuse('Use a JPG or PNG photo.', 400, 'bad_image');
  db.catalog[i] = {
    ...row, imageV: remove ? null : (row.imageV || 0) + 1, imageUrl: remove ? null : dataUrl,
    updatedAt: nowIso(), version: (row.version || 1) + 1,
  };
  if (!saveStub(db)) throw refuse('The demo’s storage on this device is full.', 507, 'demo_storage_full');
  return db.catalog[i];
}

// The route's import door, on the stub's rows: the one write rule (planCatalogImportWrite), each
// item answered.
function stubImportCatalog(items) {
  const read = readCatalogImportBody({ items });
  if (read.error) throw refuse('items are required', 400, read.error);
  const db = stubDb();
  const plans = planCatalogImportWrite(read.items, db.catalog.map((c) => ({ ...c, version: c.version || 1 })));
  const results = plans.map((p) => {
    if (!p.ok) return { id: p.id, ok: false, created: false, code: p.code, ...(p.holder ? { holder: p.holder } : {}) };
    if (p.code === 'exists') return { id: p.id, ok: true, created: false, code: 'exists', item: p.before };
    const row = {
      sku: p.fields.sku, name: p.fields.name, category: p.fields.category, unit: p.fields.unit || '', unitPrice: supplyFromCents(p.fields.unitPriceCents),
    };
    const i = db.catalog.findIndex((c) => c.id === p.id);
    if (i >= 0) db.catalog[i] = { ...db.catalog[i], ...row, updatedAt: nowIso(), version: (db.catalog[i].version || 1) + 1 };
    else db.catalog.push({ id: p.id, ...row, createdAt: nowIso(), updatedAt: nowIso(), version: 1 });
    const saved = db.catalog.find((c) => c.id === p.id);
    return { id: p.id, ok: true, created: i < 0, item: { id: saved.id, sku: saved.sku, name: saved.name, version: saved.version, imageV: saved.imageV || null } };
  });
  if (!saveStub(db)) throw refuse('The demo’s storage on this device is full.', 507, 'demo_storage_full');
  return { results, counts: countsOf(results.map((r) => ({ code: r.ok ? (r.created ? 'added' : (r.code === 'exists' ? 'exists' : 'updated')) : r.code }))) };
}

function stubDeleteCatalogItem(id) {
  const db = stubDb();
  if (!db.catalog.some((c) => c.id === id)) throw refuse('That item is no longer in the catalog.', 404, 'not_found');
  const buildings = db.items.filter((it) => it.catalogItemId === id).length;
  db.items = db.items.filter((it) => it.catalogItemId !== id);
  db.catalog = db.catalog.filter((c) => c.id !== id);
  saveStub(db);
  return { ok: true, buildings };
}

// The route's switches, on the stub's rows: the one plan (planSupplyAssign), one row per building
// and catalog item.
function stubAssign({ clientId, on, off }) {
  const db = stubDb();
  const plan = planSupplyAssign({
    on, off,
    current: db.items.filter((it) => it.clientId === clientId).map((it) => it.catalogItemId),
    known: db.catalog.map((c) => c.id),
  });
  if (plan.error) throw refuse('Too many items at once.', 400, 'too_many', { max: plan.max });
  for (const catalogItemId of plan.add) {
    db.items.push({ id: newId('si'), clientId, catalogItemId, createdAt: nowIso(), updatedAt: nowIso(), version: 1 });
  }
  if (plan.remove.length) db.items = db.items.filter((it) => !(it.clientId === clientId && plan.remove.includes(it.catalogItemId)));
  saveStub(db);
  return { results: plan.results, counts: countsOf(plan.results) };
}

// The route's office gate for the order screens (OFFICE_ROLES + supplies.view).
const isOfficeRole = (role) => !!role && role !== 'crew' && ROLES.includes(role);
function officeGate(ctx) {
  if (!ctx?.holds?.view) throw refuse('Insufficient permissions', 403, null);
  if (!isOfficeRole(ctx?.user?.role)) throw refuse('This is for the office.', 403, 'office_only');
}

// The route's GET orders, on the stub's rows: the same tabs (supplyQueueTabOf), the same search
// (the order's words, its building's label or approver, or its NUMBER), newest first, 20 a page.
function stubOrders({ status, mgr, cust, om, q, page, countsOnly }, ctx) {
  officeGate(ctx);
  const db = stubDb();
  const dayStartMs = startOfDayKey(todayKey()).getTime();
  const counts = Object.fromEntries(SUPPLY_QUEUE_TABS.map((s) => [s, 0]));
  let completedToday = 0;
  for (const r of db.requests) {
    counts[supplyQueueTabOf(r)] = (counts[supplyQueueTabOf(r)] || 0) + 1;
    if (supplyStatusOf(r) === SUPPLY_STATUS.completed && new Date(r.completedAt || 0).getTime() >= dayStartMs) completedToday += 1;
  }
  const allCounts = { ...counts, completedToday };
  if (countsOnly) return { counts: allCounts };
  const tab = SUPPLY_QUEUE_TABS.includes(status) ? status : SUPPLY_QUEUE_TABS[0];
  const clients = ctx?.state?.clients || [];
  const scope = scopeOf(ctx, { mgr, cust, om });
  let rows = db.requests.filter((r) => supplyQueueTabOf(r) === tab && (!scope || scope.has(r.clientId)));
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    rows = rows.filter((r) => {
      const c = clients.find((x) => x.id === r.clientId);
      const approver = resolveSupplyApprover(ctx?.state || {}, r.clientId);
      const hay = `${supplySearchText(r)} ${c ? customerLabel(c).toLowerCase() : ''} ${(approver?.name || '').toLowerCase()}`;
      return terms.every((t) => hay.includes(t) || (supplyOrderNumberOf(t) !== null && supplyOrderNumberOf(t) === Number(r.number)));
    });
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  const p = Math.max(1, Math.floor(Number(page) || 1));
  return {
    orders: rows.slice((p - 1) * SUPPLY_PAGE_SIZE, p * SUPPLY_PAGE_SIZE),
    total: rows.length, page: p, pageSize: SUPPLY_PAGE_SIZE, counts: allCounts,
    ...(tab === SUPPLY_STATUS.requested || tab === SUPPLY_STATUS.approved
      ? { matches: rows.map((r) => ({ id: r.id, clientId: r.clientId })) } : {}),
  };
}

// The route's GET order, on the stub's rows (the photos from the media stub, the invoices with
// whether this session still holds the file).
async function stubGetOrder(id, ctx) {
  officeGate(ctx);
  const db = stubDb();
  const order = db.requests.find((r) => r.id === id);
  if (!order) throw refuse('That order no longer exists.', 404, 'not_found');
  const state = ctx?.state || {};
  const approver = resolveSupplyApprover(state, order.clientId);
  const photos = await listAccountMedia({ refId: id, scope: 'supply' }).catch(() => []);
  return {
    order,
    progress: supplyOrderProgress(order),
    comments: db.comments.filter((c) => c.requestId === id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id))),
    photos: photos.map((m) => ({
      id: m.id, kind: m.kind || 'image', mimeType: m.mimeType || null, caption: m.caption || null, areaId: m.area_id || null,
      createdAt: m.createdAt || m.created_at || null, uploadedByUserId: m.uploadedByUserId || null,
      uploaderName: nameOf(ctx, m.uploadedByUserId) || null, url: m.url || null, thumbUrl: m.thumbUrl || null,
    })),
    invoices: db.invoices.filter((inv) => inv.requestId === id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((inv) => ({ ...inv, demoFile: !demoFiles?.has(inv.id) })),
    approver: approver ? { id: approver.id, name: approver.name || null } : null,
    approverOpsManagerId: supplyApproverOpsManagerId(state.users || [], approver ? approver.id : null),
  };
}

// The route's building rule for a caller who is not an office role (D4): the buildings they clean
// today or upcoming, from the store's jobs. null = any building (an office role).
function stubCrewBuildings(ctx) {
  if (isOfficeRole(ctx?.user?.role)) return null;
  const state = ctx?.state || {};
  return crewUpcomingClientIds({
    jobs: state.jobs || [], sites: state.sites || [], userId: ctx?.user?.id || null, todayKey: todayKey(), dayKeyOf: (iso) => dayKey(iso),
  });
}
const notYourBuilding = () => refuse('You can ask for supplies only for a building you clean.', 403, 'not_your_building');

// The person a crew read serves, as the route's crewReadSubject decides it: a caller who is not an
// office role is always themselves; an office role naming someone needs supplies.view (the View-as).
function stubCrewSubject(ctx, userId) {
  const self = ctx?.user?.id || null;
  if (!userId || userId === self || !isOfficeRole(ctx?.user?.role)) return self;
  if (!ctx?.holds?.view) throw refuse('You can’t view this person’s screen.', 403, 'preview-forbidden');
  return userId;
}

// The route's GET crew-list, on the stub's rows: the key, the building rule, then the one shape (each
// item's photo link is the stub's own: the demo keeps an uploaded photo as the item's link).
function stubCrewList(clientId, ctx, { userId = null } = {}) {
  if (!ctx?.holds?.request) throw refuse('Insufficient permissions', 403, null);
  const mine = stubCrewBuildings(ctx);
  if (mine && !mine.has(clientId)) throw notYourBuilding();
  const state = ctx?.state || {};
  if (!(state.clients || []).some((c) => c && c.id === clientId)) throw refuse('That building no longer exists.', 404, 'unknown_client');
  const subject = stubCrewSubject(ctx, userId);
  const db = stubDb();
  const approver = resolveSupplyApprover(state, clientId);
  return {
    clientId,
    ...supplyCrewList({
      items: stubItemsOf(db, clientId),
      requests: db.requests.filter((r) => r.clientId === clientId),
      userId: subject,
      approverName: approver ? hubPersonName(approver.name) : null,
    }),
  };
}

// The route's GET crew-order (EP-400), on the stub's rows: the key, then the ONE rule
// (crewMayReadOrder: their own order at a building they clean; an office role any), then the one shape.
function stubCrewOrder(id, ctx) {
  if (!ctx?.holds?.request) throw refuse('Insufficient permissions', 403, null);
  const order = stubDb().requests.find((r) => r.id === id) || null;
  const office = isOfficeRole(ctx?.user?.role);
  const buildingIds = office ? new Set() : stubCrewBuildings(ctx);
  if (!crewMayReadOrder({ order, selfId: ctx?.user?.id || null, office, buildingIds })) {
    throw refuse('That order isn’t one you can open.', 404, 'not_found');
  }
  return { order: supplyCrewOrder(order) };
}

// The route's GET crew-orders (EP-401), on the stub's rows: the person on screen's own orders at the
// buildings they clean today or upcoming, newest first.
function stubCrewOrders({ userId = null } = {}, ctx) {
  if (!ctx?.holds?.request) throw refuse('Insufficient permissions', 403, null);
  const subject = stubCrewSubject(ctx, userId);
  const state = ctx?.state || {};
  const ids = subject
    ? crewUpcomingClientIds({ jobs: state.jobs || [], sites: state.sites || [], userId: subject, todayKey: todayKey(), dayKeyOf: (iso) => dayKey(iso) })
    : new Set();
  return { orders: supplyCrewOrders(stubDb().requests.filter((r) => ids.has(r.clientId)), { userId: subject }) };
}

function stubCreate(payload, ctx) {
  const mine = stubCrewBuildings(ctx);
  if (mine && !mine.has(payload.clientId)) throw notYourBuilding();
  // A caller who reads no prices (not an office role) is answered field by field, as the route does.
  const answer = (r) => (mine ? supplyCrewRequest(r) : r);
  const db = stubDb();
  const existing = db.requests.find((r) => r.id === payload.id);
  if (existing) return answer(existing);
  const items = stubItemsOf(db, payload.clientId);
  // S131: a cleaner asks for 1–20 of an item — the route's rule, refused by name, never clamped.
  const snap = snapshotSupplyLines(payload.lines, new Map(items.map((it) => [it.id, it])), mine ? { maxQty: CREW_SUPPLY_MAX_QTY } : {});
  if (snap.error === 'no_lines') throw refuse('Add at least one item.', 400, 'no_lines');
  if (snap.error === 'over_cap') throw refuse(`Ask for at most ${snap.max} of one item.`, 400, 'qty_over_cap', { itemId: snap.itemId, max: snap.max });
  if (snap.error) throw refuse('One of these items is not on this location’s approved list any more.', 409, snap.error);
  const selfId = ctx?.user?.id || null;
  const r = {
    id: payload.id, number: nextNumber(db), clientId: payload.clientId, status: SUPPLY_STATUS.requested,
    note: String(payload.note || '').trim(), lines: snap.lines,
    requestedByUserId: selfId, requestedByName: nameOf(ctx, selfId),
    approvedAt: null, approvedByUserId: null, approvedByName: null,
    rejectedAt: null, rejectedByUserId: null, rejectedByName: null, rejectionReason: null,
    sentAt: null, sentByUserId: null, sentByName: null, sentLines: null, sentTotalCents: null,
    fulfillment: null, fulfillmentState: null,
    completedAt: null, completedByUserId: null, completedByName: null,
    createdAt: nowIso(), updatedAt: nowIso(), version: 1,
  };
  db.requests.push(r);
  stubPrune(db);
  saveStub(db);
  return answer(r);
}

// Who decides, as the route resolves it: the building's approver and THEIR operations manager.
function stubMayDecide(ctx, request, decision) {
  const state = ctx?.state || {};
  const approverId = resolveSupplyApprover(state, request.clientId)?.id || null;
  return maySupplyDecide({
    request, decision, selfId: ctx?.user?.id || null, role: ctx?.user?.role || null,
    approverId, approverOpsManagerId: supplyApproverOpsManagerId(state.users || [], approverId),
    holdsApprove: !!ctx?.holds?.approve, holdsManage: !!ctx?.holds?.manage, holdsDeliver: !!ctx?.holds?.deliver,
  });
}

// Every whole-order move the route makes — decide (approve / reject / reopen), submit and complete —
// with the route's rules: who (maySupplyDecide), the version a single move read, then the one patch.
function stubMove({ ids, decision, reason, version = null }, ctx) {
  if (decision === 'submit' && !ctx?.holds?.manage) throw refuse('Insufficient permissions', 403, null);
  if (Array.isArray(ids) && ids.length > SUPPLY_DECIDE_MAX) throw refuse('Too many at once.', 400, 'too_many', { max: SUPPLY_DECIDE_MAX });
  const db = stubDb();
  const selfId = ctx?.user?.id || null;
  const results = [];
  for (const id of [...new Set(ids || [])]) {
    const i = db.requests.findIndex((r) => r.id === id);
    if (i < 0) { results.push({ id, ok: false, code: 'not_found' }); continue; }
    const before = db.requests[i];
    if (!stubMayDecide(ctx, before, decision)) { results.push({ id, ok: false, code: 'not_yours' }); continue; }
    if (version !== null && version !== undefined && Number(version) !== Number(before.version || 1)) { results.push({ id, ok: false, code: 'stale' }); continue; }
    const d = supplyDecisionPatch(before, decision, { byUserId: selfId, byName: nameOf(ctx, selfId), reason, now: nowIso() });
    if (d.refused) { results.push({ id, ok: false, code: d.refused }); continue; }
    db.requests[i] = { ...before, ...d.patch, updatedAt: nowIso(), version: (before.version || 1) + 1 };
    results.push({ id, ok: true, code: 'ok', request: db.requests[i] });
  }
  stubPrune(db);
  saveStub(db);
  return { results, counts: countsOf(results) };
}

// The route's per-line acts, on the stub's row (supplyFulfillPatch), with the route's refusals.
const FULFILL_STATUS = { not_found: 404, not_yours: 403, stale: 409, not_submitted: 409, line_resolved: 409 };
function stubApplyActs({ id, version, acts, via }, ctx) {
  const db = stubDb();
  const i = db.requests.findIndex((r) => r.id === id);
  if (i < 0) throw refuse('That order no longer exists.', 404, 'not_found');
  const before = db.requests[i];
  const kinds = { deliver: 'deliver', backorder: 'backorder', cancel: 'cancelLine' };
  if ((Array.isArray(acts) ? acts : []).some((a) => kinds[a && a.act] && !stubMayDecide(ctx, { id }, kinds[a.act]))) {
    throw refuse('You can’t make that change on this order.', 403, 'not_yours');
  }
  if (version !== null && version !== undefined && Number(version) !== Number(before.version || 1)) {
    throw refuse('This order changed since you opened it. It now shows where it is.', 409, 'stale');
  }
  const selfId = ctx?.user?.id || null;
  const p = supplyFulfillPatch(before, acts, { byUserId: selfId, byName: nameOf(ctx, selfId), via, now: nowIso(), todayKey: todayKey() });
  if (p.refused) throw refuse('That change can’t be made.', FULFILL_STATUS[p.refused] || 400, p.refused, p.line !== undefined ? { line: p.line } : {});
  db.requests[i] = { ...before, ...p.patch, updatedAt: nowIso(), version: (before.version || 1) + 1 };
  stubPrune(db);
  saveStub(db);
  return { request: db.requests[i], applied: p.applied };
}
function stubFulfill({ id, version, acts }, ctx) {
  if (!ctx?.holds?.manage && !ctx?.holds?.deliver) throw refuse('Insufficient permissions', 403, null);
  const manage = !!ctx?.holds?.manage;
  const { request, applied } = stubApplyActs({ id, version, acts, via: manage ? 'office' : 'driver' }, ctx);
  if (!manage) return { id: request.id, version: request.version, applied: applied.map((a) => ({ line: a.line, act: a.act, qty: a.qty })) };
  return { order: request, progress: supplyOrderProgress(request), applied };
}
// The route's MOVE_STATUS for a refused completion.
const COMPLETE_STATUS = { not_found: 404, not_yours: 403, stale: 409, lines_open: 409, illegal_move: 409 };
function stubComplete({ id, version }, ctx) {
  if (!ctx?.holds?.manage) throw refuse('Insufficient permissions', 403, null);
  const { results } = stubMove({ ids: [id], decision: 'complete', version }, ctx);
  const r = results[0];
  if (!r || !r.ok) {
    const code = (r && r.code) || 'not_found';
    throw refuse('That order can’t be completed.', COMPLETE_STATUS[code] || 409, code);
  }
  return { order: r.request, progress: supplyOrderProgress(r.request) };
}
// The driver's Delivered, per line, as the route answers it: no order, no money.
function stubDeliver({ id, version, lines }, ctx) {
  if (!ctx?.holds?.deliver) throw refuse('Insufficient permissions', 403, null);
  const order = stubDb().requests.find((r) => r.id === id);
  if (!order) throw refuse('That order no longer exists.', 404, 'not_found');
  const open = supplyOrderProgress(order).lines.filter((l) => l.remaining > 0).map((l) => l.index);
  const named = Array.isArray(lines) ? [...new Set(lines)] : open;
  if (!named.length) throw refuse('Everything on this order is already delivered.', 409, 'nothing_to_deliver');
  const { request, applied } = stubApplyActs({ id, version, acts: named.map((line) => ({ line, act: 'deliver' })), via: 'driver' }, { ...ctx, holds: { deliver: true } });
  return { id: request.id, ok: true, version: request.version, delivered: applied.map((a) => a.line) };
}

// The route's comment door, on the stub's rows: the office, the words, a replay-safe id.
function stubComment({ id, requestId, body }, ctx) {
  officeGate(ctx);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(id || ''))) throw refuse('A comment needs a caller-minted id.', 400, 'bad_id');
  const f = supplyCommentBody(body);
  if (f.error) throw refuse(f.error === 'body_required' ? 'Write the comment first.' : 'Keep a comment under 1,000 characters.', 400, f.error);
  const db = stubDb();
  if (!db.requests.some((r) => r.id === requestId)) throw refuse('That order no longer exists.', 404, 'not_found');
  const existing = db.comments.find((c) => c.id === id);
  if (existing) {
    if (existing.requestId !== requestId) throw refuse('That comment id is taken. Try again.', 409, 'id_taken');
    return { comment: existing, created: false };
  }
  const selfId = ctx?.user?.id || null;
  const comment = { id, requestId, authorUserId: selfId, authorRole: ctx?.user?.role || null, authorName: nameOf(ctx, selfId), body: f.body, createdAt: nowIso() };
  db.comments.push(comment);
  saveStub(db);
  return { comment, created: true };
}

// The invoice, on the stub's rows. Files picked this session open from memory; a file seeded with
// the story was never kept (`demoFile`), and says so.
const demoFiles = STUB ? new Map() : null;
function keepDemoFile(id, file) {
  try {
    forgetDemoFile(id);
    demoFiles.set(id, URL.createObjectURL(file));
  } catch { /* no object URLs here: the button says the demo keeps no file */ }
}
function forgetDemoFile(id) {
  const old = demoFiles && demoFiles.get(id);
  if (old) { try { URL.revokeObjectURL(old); } catch { /* gone */ } }
  if (demoFiles) demoFiles.delete(id);
}
// The route's invoice door: supplies.manage, an order with the supplier (or completed), the file's own checks.
function stubInvoiceGate({ requestId, docId, mimeType, sizeBytes }, ctx) {
  if (!ctx?.holds?.manage) throw refuse('Insufficient permissions', 403, null);
  const db = stubDb();
  const order = db.requests.find((r) => r.id === requestId);
  if (!order) throw refuse('That order no longer exists.', 404, 'not_found');
  if (![SUPPLY_STATUS.sent, SUPPLY_STATUS.completed].includes(supplyStatusOf(order))) throw refuse('An invoice is kept once the order is with the supplier.', 409, 'not_submitted');
  if (!SUPPLY_INVOICE_MIME.includes(mimeType)) throw refuse('Use a PDF, JPG or PNG file.', 400, 'bad_type');
  if (!(Number(sizeBytes) > 0)) throw refuse('That file is empty.', 400, 'bad_size');
  if (Number(sizeBytes) > SUPPLY_INVOICE_MAX_BYTES) throw refuse('That file is over 10 MB.', 400, 'too_large');
  return { db, order, docId };
}
function stubInvoiceUploadUrl(meta, ctx) {
  stubInvoiceGate(meta, ctx);
  return { path: `demo/${meta.requestId}/${meta.docId}`, token: 'demo', signedUrl: null };
}
function stubInvoiceConfirm(meta, ctx) {
  const { db } = stubInvoiceGate(meta, ctx);
  const existing = db.invoices.find((inv) => inv.id === meta.docId);
  if (existing) {
    if (existing.requestId !== meta.requestId) throw refuse('That id is taken. Try again.', 409, 'id_taken');
    return { invoice: existing, created: false };
  }
  const invoice = {
    id: meta.docId, requestId: meta.requestId, kind: 'invoice', fileName: String(meta.fileName || '').trim().slice(0, 200) || 'invoice',
    mimeType: meta.mimeType, sizeBytes: Number(meta.sizeBytes) || 0, uploadedByUserId: ctx?.user?.id || null,
    uploaderName: nameOf(ctx, ctx?.user?.id || null), createdAt: nowIso(),
  };
  db.invoices.push(invoice);
  saveStub(db);
  return { invoice, created: true };
}
function stubInvoiceViewUrl(id) {
  const db = stubDb();
  if (!db.invoices.some((inv) => inv.id === id)) throw refuse('That invoice is no longer kept.', 404, 'not_found');
  const url = demoFiles && demoFiles.get(id);
  if (!url) throw refuse('The demo keeps no file for this invoice.', 404, 'demo_file');
  return url;
}
function stubInvoiceDelete(id, ctx) {
  if (!ctx?.holds?.manage) throw refuse('Insufficient permissions', 403, null);
  const db = stubDb();
  if (!db.invoices.some((inv) => inv.id === id)) throw refuse('That invoice is no longer kept.', 404, 'not_found');
  db.invoices = db.invoices.filter((inv) => inv.id !== id);
  forgetDemoFile(id);
  saveStub(db);
  return { ok: true };
}

// The route's GET deliveries, on the stub's rows: the same list (no money), the building's name
// and address from the store.
function stubDeliveries(ctx) {
  const state = ctx?.state || {};
  const today = todayKey();
  const dayStartMs = startOfDayKey(today).getTime();
  const buildingOf = (id) => {
    const c = (state.clients || []).find((x) => x && x.id === id);
    const site = (state.sites || []).find((si) => si && si.clientId === id && si.address);
    return c ? { name: c.name || '', address: (site && site.address) || '' } : null;
  };
  return { dayKey: today, ...supplyDeliveryList({ requests: stubDb().requests, buildingOf, dayStartMs }) };
}

// The route's GET onsite, on the stub's rows: the buildings the viewer cleans today, from the
// store's jobs.
function stubOnsite(ctx) {
  const state = ctx?.state || {};
  const today = todayKey();
  const clientIds = crewTodayClientIds({ jobs: state.jobs || [], sites: state.sites || [], userId: ctx?.user?.id || null, todayKey: today, dayKeyOf: (iso) => dayKey(iso) });
  return { dayKey: today, buildings: supplyCrewBuildings({ requests: stubDb().requests, clientIds, dayStartMs: startOfDayKey(today).getTime() }) };
}

// The route's cancel, on the stub's rows, in the route's order: gone (404), gone out or settled
// (409 not_cancellable, CS-670), not yours (403). The stub has no concurrent writer, so no 'stale'.
// What goes with the order (comments, invoices, photos) goes too.
function stubCancel(id, ctx) {
  const db = stubDb();
  const before = db.requests.find((r) => r.id === id);
  if (!before) throw refuse('That request no longer exists.', 404, 'not_found');
  if (!isSupplyCancellable(before)) throw refuse('This order has already gone out, so it can’t be cancelled.', 409, 'not_cancellable');
  const approverId = resolveSupplyApprover(ctx?.state || {}, before.clientId)?.id || null;
  const may = maySupplyCancel({
    request: before, selfId: ctx?.user?.id || null, role: ctx?.user?.role || null,
    approverId, approverOpsManagerId: supplyApproverOpsManagerId(ctx?.state?.users || [], approverId),
    holdsRequest: !!ctx?.holds?.request, holdsApprove: !!ctx?.holds?.approve, holdsManage: !!ctx?.holds?.manage,
  });
  if (!may) throw refuse('You can’t cancel this request.', 403, 'not_yours');
  db.requests = db.requests.filter((r) => r.id !== id);
  dropOrderExtras(db, [id]);
  saveStub(db);
  return { ok: true };
}

function stubUsage({ period, from, to, mgr, cust, om }, ctx) {
  const today = todayKey();
  const w = supplyUsageWindowKeys(period || '30d', { todayKey: today, from: from || null, to: to || null });
  if (w.error) throw refuse('That range cannot be read.', 400, w.error, w.firstKey ? { firstKey: w.firstKey } : {});
  const fromMs = startOfDayKey(w.fromKey).getTime();
  const toMs = w.toKey >= today ? Date.now() : startOfDayKey(addDaysKey(w.toKey, 1)).getTime() - 1;
  const scope = scopeOf(ctx, { mgr, cust, om });
  const requests = stubDb().requests.filter((r) => !scope || scope.has(r.clientId));
  return { rows: supplyUsageByItem(requests, { fromMs, toMs }), fromKey: w.fromKey, toKey: w.toKey, historyStartKey: supplyHistoryStartKey(today) };
}

// The month's delivered spend, each delivery in its own month (the route's rule, in cents).
function stubBudgets() {
  const today = todayKey();
  const fromKey = startOfMonthKey(today);
  const spendCents = supplyDeliveredCentsByClient(stubDb().requests, { fromMs: startOfDayKey(fromKey).getTime(), toMs: Date.now() });
  return { monthKey: today.slice(0, 7), fromKey, spendCents };
}

// The route's GET buildings, on the stub's rows: the same gate (an office role — the rows carry each
// building's orders, S131 Wave 2), the same scope, the same month, the same rule.
function stubBuildings({ mgr, cust, om }, ctx) {
  officeGate(ctx);
  const state = ctx?.state || {};
  const scope = scopeOf(ctx, { mgr, cust, om });
  const { monthKey, spendCents } = stubBudgets();
  const buildings = supplyBuildingRows({
    clients: (state.clients || []).filter((c) => c && (!scope || scope.has(c.id))),
    requests: stubDb().requests.filter((r) => !isSupplySettled(r)),
    spendCents,
    approverOf: (clientId) => resolveSupplyApprover(state, clientId),
  });
  return { monthKey, buildings, counts: supplyBuildingCounts(buildings) };
}
