// SUPPLIES API (SUP-13: the queue and the approved lists left the shared record; SUP-11: who
// may approve; S131: the supply ORDERS). A catch-all domain — its `vercel.json` rewrite is
// `/api/supplies/:rest* -> /api/supplies/_?subpath=:rest*`, and without it every pretty URL here
// 404s while the file path works (BUILD_INTEGRITY §2).
//
//   GET  /api/supplies/items?clientId=[&history=1]             -> { items } (a building's switched-on items, read through the catalog: + sku, category, catalogItemId, imageUrl; history: + lastDeliveredAt, lastDeliveredQty, qty90d, by catalog item)
//   GET  /api/supplies/catalog?q=&category=&page=              -> { items (+ buildings, imageUrl), total, page, pageSize, categories }
//   GET  /api/supplies/catalog?all=1[&q=&category=]            -> { items, total, categories } (the whole catalog, complete)
//   GET  /api/supplies/requests?building=<clientId>            -> { open, recent } (one building: every open order + its newest settled)
//   GET  /api/supplies/usage?period=&from=&to=&mgr=&cust=      -> { rows, fromKey, toKey, historyStartKey } (mgr: an id, or `team` — the caller's)
//   GET  /api/supplies/budgets                                 -> { monthKey, fromKey, spendCents }
//   GET  /api/supplies/buildings?mgr=&cust=                    -> { monthKey, buildings, counts } (every building's one state and its orders; office)
//   POST /api/supplies/catalog/save        { id, sku, name, category, unit, unitPrice } -> { item, created } (409 sku_taken + holder)
//   POST /api/supplies/catalog/delete      { id }                                  -> { ok, buildings }
//   POST /api/supplies/items/assign        { clientId, on: [catalogIds], off: [catalogIds] } -> { results, counts }
//   POST /api/supplies/requests/create     { id, clientId, lines: [{ itemId, catalogItemId?, qty }], note } -> { request, created }
//   POST /api/supplies/requests/decide     { ids, decision: approve|reject|reopen, reason }  -> { results, counts }
//   POST /api/supplies/requests/cancel     { id }                     -> { ok }
//   ── the driver and the cleaners (the delivery step, 2026-10-12; per line since S131) ──
//   GET  /api/supplies/deliveries                              -> { dayKey, toDeliver, deliveredToday } (no money)
//   POST /api/supplies/requests/deliver    { id, version, lines?: [index] } -> { id, ok, version, delivered } (no money)
//   GET  /api/supplies/onsite                                  -> { dayKey, buildings: [{ clientId, delivered, backordered, onTheWay }] } (per line)
//   GET  /api/supplies/crew-list?clientId=[&userId=]           -> { clientId, items (+ imageUrl), approverName, orders } (no money)
//   GET  /api/supplies/crew-order?id=                          -> { order } (EP-400, the cleaner's own; no money)
//   GET  /api/supplies/crew-orders[?userId=]                   -> { orders } (EP-401, Home's tile; no money)
//   ── 🔴 THE SUPPLY ORDERS (S131, plan docs/plans/2026-10-14-supply-orders.md §5; brief S §3) ──
//   GET  /api/supplies/orders?status=&mgr=&cust=&q=&page=      -> { orders, total, page, pageSize, counts, matches? } (EP-390; mgr may be `team`)
//   GET  /api/supplies/orders?countsOnly=1                     -> { counts }
//   GET  /api/supplies/order?id=                               -> { order, progress, comments, photos, invoices, approver, approverOpsManagerId } (EP-391)
//   POST /api/supplies/orders/submit       { ids }                    -> { results, counts } (EP-392)
//   POST /api/supplies/orders/fulfill      { id, version, acts: [{ line, act, qty?, eta?, reason? }] } -> { order, progress, applied } (EP-393)
//   POST /api/supplies/orders/complete     { id, version }            -> { order, progress } (EP-394)
//   POST /api/supplies/orders/comment      { id, requestId, body }    -> { comment, created } (EP-395)
//   POST /api/supplies/orders/invoice/upload-url { requestId, docId, fileName, mimeType, sizeBytes } -> { path, token, signedUrl } (EP-396)
//   POST /api/supplies/orders/invoice/confirm    { requestId, docId, fileName, mimeType, sizeBytes } -> { invoice, created } (EP-397)
//   GET  /api/supplies/orders/invoice/view-url?id=             -> { url, expiresIn } (EP-398)
//   POST /api/supplies/orders/invoice/delete     { id }        -> { ok } (EP-408)
//   POST /api/supplies/catalog/image       { id, version, dataUrl | remove: true } -> { item } (EP-399)
//   POST /api/supplies/catalog/import      { items: [{ id, create, version?, set }] } (≤ 100) -> { results, counts }
//   POST /api/supplies/catalog/image-link  { url } -> { dataUrl, type, bytes } (a picture behind a web link)
//
// THE MASTER SUPPLY LIST (Matt, the Oct 6 call; plan 2026-10-11 §2): one catalog per org, and a
// building's list is its switches over it (D4, D5).
//
// THE SUPPLY ORDERS (S131): requested → approved (the building's account manager, their operations
// manager, the owner or an admin) → SUBMITTED to the supplier (the stored `sent`, by the Supply
// Manager — no quantities: `requests/send` and its "how many went out" are DELETED, II.5) → each line
// delivered (the Supply Manager on the order page, the driver on /deliveries), backordered with the
// supplier's ETA or cancelled with a reason → COMPLETED once every line is resolved.
//
// ── AUTH STANCE (declared at creation, by capability — BUILD_INTEGRITY §2) ───────────────
// Every branch gates through `requirePermission` / `requireAnyPermission`, which run the SAME
// `can()` the screens run against the COMMITTED matrix + per-user overrides, from the login's
// claim. RLS is on with no policies, so this gate IS the boundary.
//   reads (catalog included)          supplies.view
//   catalog/save|delete|image|import|image-link, items/assign   supplies.manage (the office: the master list, its
//                                     images and every building's switches — D4, no new key)
//   requests/create    supplies.request
//   requests/decide    supplies.approve OR supplies.manage at the door, then PER ORDER
//                      lib/supplies maySupplyDecide: approve / reject — the building's approver,
//                      that approver's operations manager, or the owner / an admin, each with
//                      supplies.approve (never supplies.manage alone: the Supply Manager is refused
//                      `not_yours`); reopen — supplies.manage.
//   requests/cancel    any supplies key at the door, then PER REQUEST lib/supplies maySupplyCancel
//                      (CS-596), and only while waiting or approved (CS-670). S131 Wave 2: a WAITING
//                      order only by its asker or whoever may decide it (maySupplyDecide) — never on
//                      supplies.manage alone, the Supply Manager's key.
//   orders, order, orders/invoice/view-url, orders/comment, buildings (S131 Wave 2: it carries each
//                      building's orders) — supplies.view AND an office role (OFFICE_ROLES): never
//                      crew, never the driver on a crew login (403 office_only).
//   `mgr=team` (orders, usage, buildings) — the CALLER's team from the claim (lib/teamScope): an
//                      Operations Manager's, else the caller's own buildings; an owner or an admin may
//                      name whose with `om` (an active OM: lib/teamScope teamLeadFor), a manager never.
//   orders/submit, orders/complete, orders/invoice/upload-url|confirm|delete — supplies.manage.
//   orders/fulfill     supplies.manage, or supplies.deliver for `deliver` acts only (maySupplyDecide
//                      per act: the driver may not backorder or cancel); a deliver-only caller is
//                      answered with no order and no money.
//   deliveries, requests/deliver — supplies.deliver (the driver; owner + admin by default, anyone by
//                      a per-person grant, e.g. a CREW login). No money in either answer.
//   onsite             time.clock — every staff login, SELF-SCOPED to the buildings the caller
//                      cleans today (lib/crewScope crewTodayClientIds).
//   crew-list          supplies.request (EP-385), the building rule for a non-office caller; the orders
//                      are the person on screen's own (crewReadSubject: `?userId=` only for an office
//                      login holding supplies.view — the View-as; a crew login is always itself).
//   crew-order         supplies.request (EP-400), then lib/supplies crewMayReadOrder: a non-office
//                      caller only their OWN order at a building they clean; an office role any; else
//                      the same 404, naming nothing.
//   crew-orders        supplies.request (EP-401), the person on screen as crew-list, their own orders at
//                      the buildings they clean today or upcoming.
//   requests/create    for a non-office caller: the same building rule (403 not_your_building), the
//                      cleaner's 1–20 per line HELD HERE (400 qty_over_cap, S131), answered field by
//                      field (supplyCrewRequest) when the caller lacks supplies.view.
//
// Every calendar question (this month's budget, a usage window, an ETA, the 12-month retention) is
// answered in the ORG's zone, never the process zone (this function runs TZ=UTC — THE LAW II.8).
import { randomInt } from 'node:crypto';
import { requirePermission, requireAnyPermission, holdsPermission, OFFICE_ROLES } from '../_lib/authz.js';
import { logActivities } from '../_lib/activityLog.js';
import { readProtectedSlices, readOrgState, writeOrgState } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { cached } from '../_lib/requestCache.js';
import { reportError } from '../_lib/monitor.js';
import { dayKey, startOfDayKey, addDaysKey, startOfMonthKey } from '../../src/lib/dates.js';
import { customerLabel } from '../../src/lib/customerNumber.js';
import { resolveSupplyApprover } from '../../src/lib/notifications.js';
import { crewTodayClientIds, crewUpcomingClientIds } from '../../src/lib/crewScope.js';
import { hubPersonName } from '../../src/lib/clientHub.js';
import { TEAM, teamClientIds, teamLeadFor } from '../../src/lib/teamScope.js';
import { crewReadSubject } from '../_lib/crewPreview.js';
import {
  SUPPLY_STATUS, SUPPLY_DECIDE_DECISIONS, SUPPLY_QUEUE_TABS, maySupplyDecide, maySupplyCancel,
  supplyApproverOpsManagerId, supplyOrderNumberOf, supplyOrderNo, supplyOrderProgress, CREW_SUPPLY_MAX_QTY,
  supplyHistoryStartKey, supplyUsageWindowKeys, supplyUsageByItem, supplyStatusOf,
  supplyItemHistory, supplyRecentStartKey, withSupplyHistory, supplyBuildingRows, supplyBuildingCounts,
  supplyItemCatalogMap, supplyDeliveryList, supplyCrewBuildings, supplyCrewList, supplyCrewRequest,
  supplyCrewOrder, supplyCrewOrders, crewMayReadOrder,
} from '../../src/lib/supplies.js';
import {
  supplyDecisionNotifications, supplySubmitNotifications, supplyCancelNotifications, supplyFulfillNotifications,
} from '../../src/lib/supplyFlow.js';
import { getCrewJobs } from '../_lib/jobsTable.js';
import { listMedia, removeMediaForRefs } from '../_lib/accountMedia/store.js';
import {
  SupplyRefusal, isSupplyId, listItems, assignItems, getCatalogItem, setCatalogImageVersion,
  listCatalog, allCatalog, catalogCategories, catalogBuildingCounts, catalogCategoryFilter, saveCatalogItem, deleteCatalogItem,
  getRequest, listOrders, matchingOrderRefs, orderCounts, deliveredRequests, deliveredCentsByClient, buildingRequests, inFlightRequests,
  createRequest, decideRequests, fulfillOrder, cancelRequest, pruneSettledRequests, searchTerms, deliveryRequests, onsiteRequests,
  crewOrderRequests, getCrewOrder, listComments, addComment, importCatalogItems,
} from '../_lib/supplies/store.js';
import {
  invoicePathFor, validateInvoiceUpload, signedInvoiceUploadUrl, insertInvoice, listInvoices, getInvoiceRow,
  signedInvoiceViewUrl, deleteInvoice, invoiceObjectPaths, removeInvoiceObjects, toInvoice,
  SUPPLY_INVOICES_MAX, SUPPLY_INVOICE_URL_TTL_S,
} from '../_lib/supplies/documents.js';
import { validateCatalogImage, putCatalogImage, removeCatalogImages, withCatalogImageUrls } from '../_lib/supplies/catalogImage.js';
import { fetchLinkImage, LINK_IMAGE_RATE } from '../_lib/supplies/imageLink.js';
import { readCatalogImportBody, CATALOG_IMPORT_BATCH } from '../../src/lib/supplyCatalogImport.js';
import { allow } from '../_lib/rateLimit.js';

export const SUPPLY_PAGE_SIZE = 20;

// A full decide batch (SUPPLY_DECIDE_MAX requests, a few CAS updates at a time, then the bells
// and the activity rows) and a 12-month usage read both want more than the platform default.
export const config = { maxDuration: 60 };

// The slices this route reads from the shared record: the roster (names, the approver's
// eligibility, the operations manager), the customers (buildings, supervisors, labels), the
// locations (a building's address for the driver's list, and a clean's building for the cleaners'
// read), the ops settings (SUP-9's named approver) and the company zone. One projection, once per
// request.
const slices = () => cached('suppliesSlices', async () => {
  const data = await readProtectedSlices('users:state->users,clients:state->clients,sites:state->sites,opsSettings:state->opsSettings,company:state->company');
  return {
    users: Array.isArray(data && data.users) ? data.users : [],
    clients: Array.isArray(data && data.clients) ? data.clients : [],
    sites: Array.isArray(data && data.sites) ? data.sites : [],
    opsSettings: (data && data.opsSettings) || {},
    tz: (data && data.company && data.company.timezone) || null,
  };
});

const nameOf = (s, id) => (id ? (s.users.find((u) => u && u.id === id)?.name || null) : null);
const clientOf = (s, id) => s.clients.find((c) => c && c.id === id) || null;
const approverIdOf = (s, clientId) => resolveSupplyApprover(s, clientId)?.id || null;
// A building as the driver reads it (S4): its name and the address of its location (one location
// per customer; the first one with an address).
const buildingOf = (s, clientId) => {
  const c = clientOf(s, clientId);
  const site = s.sites.find((si) => si && si.clientId === clientId && si.address);
  return c ? { name: c.name || '', address: (site && site.address) || '' } : null;
};
// The ids a batch call names: `ids`, or one `id`.
const idsOf = (body) => (Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []));
const countsOf = (results) => results.reduce((a, x) => ({ ...a, [x.code]: (a[x.code] || 0) + 1 }), {});

// The buildings a Manager / Customer filter narrows to: null = all. The Manager is the
// BUILDING's supervisor (lib/supplies filterSupplyRequests' rule), never the requester.
// 🔴 S131 Wave 2: `mgr=team` is the CALLER's team, resolved from their claim and the committed roster
// (lib/teamScope teamClientIds: an Operations Manager's own buildings and their account managers';
// anyone else's own); an owner or an admin, who reads every building, may name WHOSE with `om` (an
// active Operations Manager — the owner's Operations view's tiles), and a manager never widens theirs
// that way (lib/teamScope teamLeadFor, the one rule).
function scopeIds(s, { mgr, cust, om }, g) {
  if (!mgr && !cust) return null;
  const team = mgr === TEAM
    ? teamClientIds(s.users, s.clients, teamLeadFor({ role: g && g.role, selfId: g && g.orgUserId, users: s.users, om }))
    : null;
  return s.clients
    .filter((c) => c && (!mgr || (team ? team.has(c.id) : c.supervisorId === mgr)) && (!cust || c.id === cust))
    .map((c) => c.id);
}

// Each search term may also NAME buildings: their label ("0001 Las Olas…") or their approver.
function termClientIdsFor(s, terms) {
  return terms.map((t) => s.clients.filter((c) => {
    if (!c) return false;
    if (customerLabel(c).toLowerCase().includes(t)) return true;
    const a = resolveSupplyApprover(s, c.id);
    return !!(a && String(a.name || '').toLowerCase().includes(t));
  }).map((c) => c.id));
}

// 🔴 THE OFFICE (OFFICE_ROLES: every role but crew, derived from ROLES — the Supply Manager too once
// the role exists). The order screens are the office's: a crew login, even the driver holding a
// grant, reads none of them.
const isOfficeCaller = (g) => !!(g && g.role && OFFICE_ROLES.includes(g.role));
const officeOnly = (res) => res.status(403).json({ error: 'This is for the office.', code: 'office_only' });

// 🔴 THE CLEANER'S BUILDINGS (the Cleaner Hub, D4): a caller who is not an office role asks for —
// and reads — supplies only for a building they clean today or upcoming (their own cleans in
// public.jobs, which a cleaner cannot write: jobsGuard). An office role is not scoped. The refusal
// names no building. `userId` (S131 Builder C) is whose cleans: the caller's, or — Home's tile read
// under the office's View-as (EP-401) — the person on screen, whom crewReadSubject has already allowed.
async function crewBuildingIds(g, s, userId = g.orgUserId || null) {
  const today = dayKey(new Date(), s.tz);
  const jobs = userId ? await getCrewJobs(userId) : [];
  return crewUpcomingClientIds({
    jobs, sites: s.sites, userId, todayKey: today, dayKeyOf: (iso) => dayKey(iso, s.tz),
  });
}
const notYourBuilding = (res) => res.status(403).json({ error: 'You can ask for supplies only for a building you clean.', code: 'not_your_building' });

// The 12-month retention's cutoff instant: the start of the kept history's first org-zone day.
const retentionCutoffIso = (s) => startOfDayKey(supplyHistoryStartKey(dayKey(new Date(), s.tz)), s.tz).toISOString();

// An order's delivery photos, removed with it (S131: a cancel and the 12-month prune). Best-effort,
// in bounded batches (the ids ride a PostgREST in() list).
async function removeOrderPhotos(ids) {
  for (let i = 0; i < ids.length; i += 100) {
    try { await removeMediaForRefs({ refIds: ids.slice(i, i + 100), scope: 'supply' }); }
    catch (e) { reportError('supplies.photos_remove_failed', e, {}); }
  }
}

// Retention at the write point (SUP-13; S131: an order takes its invoices' files and its photos with
// it). Best-effort: a failed prune is retried by the next write and never fails the act the user
// just made.
async function prune(s) {
  try {
    await pruneSettledRequests({
      cutoffIso: retentionCutoffIso(s),
      beforeDelete: (ids) => invoiceObjectPaths(ids),
      afterDelete: async (ids, paths) => {
        await removeInvoiceObjects(paths);
        await removeOrderPhotos(ids);
      },
    });
  } catch (e) { reportError('supplies.prune_failed', e, {}); }
}

// Bell rows into org_state, CAS-guarded and best-effort — the precedent is
// api/_lib/qc/store.js notifyTicketRaised. `build(base)` returns the next notifications array
// (the same array when nobody is to be told). Each row is a MESSAGE the fan-out renders for its
// recipient, in their language (CS-193).
async function ring(build, tries = 4) {
  try {
    for (let i = 0; i < tries; i += 1) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const notifications = build(base);
      if (notifications === base.notifications) return;
      if (await writeOrgState({ ...state, notifications }, version)) return;
    }
  } catch (e) {
    reportError('supplies.notify_failed', e, {});
  }
}

// What every applied move does after its rows landed — decide, submit and complete alike: the bell
// rows (who hears is lib/supplyFlow's rule, the same for one or fifty, the actor skipped), ONE
// `supply_request.status_changed` row per move with its before and after, and the retention prune.
async function afterMoves({ g, s, done, decision }) {
  if (!done.length) return;
  const selfId = g.orgUserId || null;
  await ring((base) => done.reduce((notifications, x) => supplyDecisionNotifications(
    { ...base, notifications }, { request: x.request, decision, actorUserId: selfId },
  ), base.notifications));
  await logActivities(done.map((x) => {
    const client = clientOf(s, x.request.clientId);
    const from = supplyStatusOf(x.before);
    const to = supplyStatusOf(x.request);
    const no = supplyOrderNo(x.request);
    return {
      action: 'supply_request.status_changed',
      actorUserId: selfId, actorRole: g.role || null, actorName: nameOf(s, selfId),
      entityId: x.id,
      clientId: x.request.clientId || null,
      clientName: client ? client.name || null : null,
      summary: `Supply order${no ? ` ${no}` : ''}${client && client.name ? ` for ${client.name}` : ''}: ${from} → ${to}${decision === 'submit' ? ' (submitted to the supplier)' : ''}`,
      before: { status: from },
      after: { status: to },
    };
  }));
  await prune(s);
}

// What a set of per-line acts does after it landed (S131): the bells (the cleaner and the account
// manager — one per person per kind of act), ONE `supply_order.lines_changed` row naming each line,
// and the retention prune.
async function afterLineActs({ g, s, before, request, applied }) {
  const selfId = g.orgUserId || null;
  await ring((base) => supplyFulfillNotifications(base, { request, applied, actorUserId: selfId }));
  const client = clientOf(s, request.clientId);
  const words = applied.map((a) => {
    const l = (request.lines || [])[a.line] || {};
    const name = l.name || 'Item';
    if (a.act === 'deliver') return `${name} ×${a.qty} delivered`;
    if (a.act === 'backorder') return `${name} backordered (ETA ${a.eta})`;
    return `${name} cancelled (“${a.reason}”)`;
  });
  const no = supplyOrderNo(request);
  await logActivities([{
    action: 'supply_order.lines_changed',
    actorUserId: selfId, actorRole: g.role || null, actorName: nameOf(s, selfId),
    entityId: request.id, clientId: request.clientId || null, clientName: client ? client.name || null : null,
    summary: `Supply order${no ? ` ${no}` : ''}${client && client.name ? ` for ${client.name}` : ''}: ${words.join('; ')}`.slice(0, 1000),
    before: { state: before.fulfillmentState || null },
    after: { state: request.fulfillmentState || null, acts: applied.slice(0, 100) },
  }]);
  await prune(s);
}

// A refused move's status, by its code (the store's answers, worded for the screen).
const MOVE_STATUS = { not_found: 404, not_yours: 403, stale: 409, lines_open: 409, illegal_move: 409, has_deliveries: 409, reason_required: 400 };
const MOVE_WORDS = {
  not_found: 'That order no longer exists.',
  not_yours: 'You can’t make that change on this order.',
  stale: 'This order changed since you opened it. It now shows where it is.',
  lines_open: 'Every item has to be delivered or cancelled before the order is completed.',
  illegal_move: 'This order has already moved on.',
  has_deliveries: 'Something on this order was already delivered, so it can’t be reopened.',
};

// A link's picture that could not be had, by its code (_lib/supplies/imageLink.js).
const LINK_WORDS = {
  bad_link: 'That is not a web link to a picture.',
  blocked_port: 'That link uses a port this app does not download from.',
  blocked_address: 'That link does not point to the public internet.',
  not_found: 'Nothing is at that link any more.',
  unreachable: 'That link could not be reached.',
  timeout: 'That link took too long to answer.',
  too_large: 'The picture at that link is over 3 MB.',
  not_an_image: 'That link is not a JPG, PNG, GIF or WebP picture.',
  too_many_redirects: 'That link redirects too many times.',
};

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const body = req.body || {};
  const [head, tail, third] = path;
  // One door: exactly these segments, nothing after.
  const door = (h, t, x) => head === h && tail === t && third === x && path.length === [h, t, x].filter(Boolean).length;
  const qs = (k) => (typeof req.query[k] === 'string' ? req.query[k] : '');

  try {
    // ── the driver's list and the cleaners' line, each behind its OWN door ──
    // The driver's list (EP-366, per line since S131). supplies.deliver — which a crew login may hold
    // by a per-person grant — and nothing else: no price, no total and no budget is in it (lib/supplies
    // supplyDeliveryList builds every field), and holding it opens no other supplies read.
    if (req.method === 'GET' && door('deliveries')) {
      const g = await requirePermission(req, res, 'supplies.deliver');
      if (!g) return;
      const s = await slices();
      const today = dayKey(new Date(), s.tz);
      const dayStart = startOfDayKey(today, s.tz);
      const requests = await deliveryRequests({ dayStartIso: dayStart.toISOString() });
      return res.status(200).json({
        dayKey: today,
        ...supplyDeliveryList({ requests, buildingOf: (id) => buildingOf(s, id), dayStartMs: dayStart.getTime() }),
      });
    }
    // The cleaners' line (EP-368). Every staff login (time.clock is everyone's), SELF-SCOPED: only the
    // buildings the caller cleans TODAY — their own cleans in public.jobs (a cleaner cannot write a
    // clean's crew, jobsGuard) starting on the org's today — and only names and quantities.
    if (req.method === 'GET' && door('onsite')) {
      const g = await requirePermission(req, res, 'time.clock');
      if (!g) return;
      const s = await slices();
      const today = dayKey(new Date(), s.tz);
      const dayStart = startOfDayKey(today, s.tz);
      const jobs = g.orgUserId ? await getCrewJobs(g.orgUserId) : [];
      const clientIds = crewTodayClientIds({
        jobs, sites: s.sites, userId: g.orgUserId || null, todayKey: today, dayKeyOf: (iso) => dayKey(iso, s.tz),
      });
      const requests = clientIds.size ? await onsiteRequests({ clientIds: [...clientIds], dayStartIso: dayStart.toISOString() }) : [];
      return res.status(200).json({ dayKey: today, buildings: supplyCrewBuildings({ requests, clientIds, dayStartMs: dayStart.getTime() }) });
    }

    // EP-385, the cleaner's Request Supplies page (D4; S131 Builder C): supplies.request, then the
    // building rule for a non-office caller, then ONE building's list — each product's photo link signed
    // in ONE batch — and the cleaner's OWN orders there, newest first (the last-order card and the
    // history) — no money. `?userId=` names the person on screen for the office's View-as
    // (crewReadSubject: honoured only for an office login holding supplies.view; a crew login is
    // always itself).
    if (req.method === 'GET' && door('crew-list')) {
      const g = await requirePermission(req, res, 'supplies.request');
      if (!g) return;
      const clientId = qs('clientId');
      if (!isSupplyId(clientId)) return res.status(400).json({ error: 'Name one building.', code: 'client_required' });
      const s = await slices();
      if (!isOfficeCaller(g) && !(await crewBuildingIds(g, s)).has(clientId)) return notYourBuilding(res);
      if (!clientOf(s, clientId)) return res.status(404).json({ error: 'That building no longer exists.', code: 'unknown_client' });
      const who = await crewReadSubject(g, qs('userId'), 'supplies.view');
      if (who.status) return res.status(who.status).json({ error: who.error, code: who.code });
      const [items, orders] = await Promise.all([
        listItems({ clientId }).then((list) => withCatalogImageUrls(list, { idOf: (it) => it.catalogItemId })),
        crewOrderRequests({ clientIds: [clientId], userId: who.userId }),
      ]);
      const approver = resolveSupplyApprover(s, clientId);
      return res.status(200).json({
        clientId,
        ...supplyCrewList({ items, requests: orders, userId: who.userId, approverName: approver ? hubPersonName(approver.name) : null }),
      });
    }

    // 🔴 EP-400, ONE of the cleaner's own orders (S131 Builder C: the order view a cleaner's supply bells
    // open, crewPaths.supplyOrder): supplies.request; then lib/supplies crewMayReadOrder — a caller who
    // is not an office role reads only their OWN order (the claim) at a building they clean today or
    // upcoming (EP-385's rule); an office role any (the owner's View-as). Every other answer is the SAME
    // 404, naming nothing. Field by field (supplyCrewOrder): no money, note, comment, invoice or photo.
    if (req.method === 'GET' && door('crew-order')) {
      const g = await requirePermission(req, res, 'supplies.request');
      if (!g) return;
      const id = qs('id');
      if (!isSupplyId(id)) return res.status(400).json({ error: 'Name one order.', code: 'id_required' });
      const notFound = () => res.status(404).json({ error: 'That order isn’t one you can open.', code: 'not_found' });
      const order = await getCrewOrder(id);
      const office = isOfficeCaller(g);
      const selfId = g.orgUserId || null;
      if (!order || (!office && order.requestedByUserId !== selfId)) return notFound();
      const buildingIds = office ? new Set() : await crewBuildingIds(g, await slices());
      if (!crewMayReadOrder({ order, selfId, office, buildingIds })) return notFound();
      return res.status(200).json({ order: supplyCrewOrder(order) });
    }

    // 🔴 EP-401, the cleaner's NEWEST orders (S131 Builder C: Home's Request Supplies tile, "#SO-1047 ·
    // partial"): supplies.request; the person on screen (crewReadSubject, as EP-385); their own orders
    // at the buildings THEY clean today or upcoming, newest first, at most CREW_SUPPLY_HISTORY_MAX.
    // LIGHT: no list, no photo links — one read of narrow columns. Field by field, no money.
    if (req.method === 'GET' && door('crew-orders')) {
      const g = await requirePermission(req, res, 'supplies.request');
      if (!g) return;
      const who = await crewReadSubject(g, qs('userId'), 'supplies.view');
      if (who.status) return res.status(who.status).json({ error: who.error, code: who.code });
      const buildingIds = who.userId ? await crewBuildingIds(g, await slices(), who.userId) : new Set();
      const orders = buildingIds.size ? await crewOrderRequests({ clientIds: [...buildingIds], userId: who.userId }) : [];
      return res.status(200).json({ orders: supplyCrewOrders(orders, { userId: who.userId }) });
    }

    // ── 🔴 THE ORDER QUEUE (EP-390): the Requests tab and the Supply Manager's Home ──
    // supplies.view AND an office role. One server page of 20 with its total, the six tabs' counts and
    // the Supply Manager's tiles (completed TODAY in the org's zone), and — on Pending approval and
    // New, the two tabs with a bulk action — every match's id for "Select all N". The search matches
    // the order's words, a building's name or approver, or an order number ("SO-1047", "1047").
    if (req.method === 'GET' && door('orders')) {
      const g = await requirePermission(req, res, 'supplies.view');
      if (!g) return;
      if (!isOfficeCaller(g)) return officeOnly(res);
      const s = await slices();
      const dayStartIso = startOfDayKey(dayKey(new Date(), s.tz), s.tz).toISOString();
      if (qs('countsOnly')) return res.status(200).json({ counts: await orderCounts({ dayStartIso }) });
      const tab = SUPPLY_QUEUE_TABS.includes(qs('status')) ? qs('status') : SUPPLY_QUEUE_TABS[0];
      const clientIds = scopeIds(s, { mgr: qs('mgr'), cust: qs('cust'), om: qs('om') }, g);
      const terms = searchTerms(qs('q'));
      const filters = { tab, clientIds, terms, termClientIds: termClientIdsFor(s, terms), numbers: terms.map(supplyOrderNumberOf) };
      const page = Math.max(1, Math.floor(Number(qs('page')) || 1));
      const [list, counts, matches] = await Promise.all([
        listOrders({ ...filters, offset: (page - 1) * SUPPLY_PAGE_SIZE, limit: SUPPLY_PAGE_SIZE }),
        orderCounts({ dayStartIso }),
        tab === SUPPLY_STATUS.requested || tab === SUPPLY_STATUS.approved ? matchingOrderRefs(filters) : null,
      ]);
      return res.status(200).json({
        orders: list.rows, total: list.total, page, pageSize: SUPPLY_PAGE_SIZE, counts,
        ...(matches ? { matches } : {}),
      });
    }

    // ONE ORDER (EP-391): the row with its per-line record, each line's state, its comments, its
    // delivery photos (signed links), its invoices (no link — view-url signs one), and who approves it
    // (with their operations manager), so the page offers exactly the moves the route allows.
    if (req.method === 'GET' && door('order')) {
      const g = await requirePermission(req, res, 'supplies.view');
      if (!g) return;
      if (!isOfficeCaller(g)) return officeOnly(res);
      const id = qs('id');
      if (!isSupplyId(id)) return res.status(400).json({ error: 'Name one order.', code: 'id_required' });
      const order = await getRequest(id);
      if (!order) return res.status(404).json({ error: 'That order no longer exists.', code: 'not_found' });
      const s = await slices();
      const [comments, photos, invoices] = await Promise.all([
        listComments(id), listMedia({ refId: id, scope: 'supply' }), listInvoices(id),
      ]);
      const approver = resolveSupplyApprover(s, order.clientId);
      return res.status(200).json({
        order,
        progress: supplyOrderProgress(order),
        comments,
        photos: photos.map((p) => ({ ...p, uploaderName: nameOf(s, p.uploadedByUserId) })),
        invoices,
        approver: approver ? { id: approver.id, name: approver.name || null } : null,
        approverOpsManagerId: supplyApproverOpsManagerId(s.users, approver ? approver.id : null),
      });
    }

    // AN INVOICE'S LINK (EP-398): supplies.view and an office role; 300 seconds, never cached.
    if (req.method === 'GET' && door('orders', 'invoice', 'view-url')) {
      const g = await requirePermission(req, res, 'supplies.view');
      if (!g) return;
      if (!isOfficeCaller(g)) return officeOnly(res);
      const row = await getInvoiceRow(qs('id'));
      if (!row) return res.status(404).json({ error: 'That invoice is no longer kept.', code: 'not_found' });
      const url = await signedInvoiceViewUrl(row);
      if (!url) return res.status(404).json({ error: 'The invoice’s file is missing.', code: 'file_missing' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ url, expiresIn: SUPPLY_INVOICE_URL_TTL_S });
    }

    // ── reads ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const g = await requirePermission(req, res, 'supplies.view');
      if (!g) return;
      const s = await slices();
      const today = dayKey(new Date(), s.tz);

      if (door('items')) {
        const clientId = qs('clientId');
        if (!clientId) return res.status(400).json({ error: 'clientId is required' });
        const items = await withCatalogImageUrls(await listItems({ clientId }), { idOf: (it) => it.catalogItemId });
        if (!qs('history')) return res.status(200).json({ items });
        // The customer's Supplies tab (round 3): per CATALOG ITEM, from this building's deliveries
        // inside the kept 12 months — the last delivery, its quantity, and the last 90 days of the
        // ORG's calendar (lib/supplies supplyItemHistory, the demo stub's rule too). Keyed on the
        // catalog item, so an item switched off and back on keeps it (D6).
        const delivered = await deliveredRequests({
          fromIso: startOfDayKey(supplyHistoryStartKey(today), s.tz).toISOString(),
          toIso: new Date().toISOString(),
          clientIds: [clientId],
        });
        const history = supplyItemHistory(delivered, {
          recentFromMs: startOfDayKey(supplyRecentStartKey(today), s.tz).getTime(),
          itemCatalog: supplyItemCatalogMap(items),
        });
        return res.status(200).json({ items: withSupplyHistory(items, history) });
      }

      if (door('catalog')) {
        // The master list (D4: everyone with supplies.view reads it). A server page of 20 with
        // its total and "On N buildings" for the Catalog tab; `?all=1` the WHOLE catalog,
        // complete, for a building's switches. Each item's image link signed in ONE batch (S131).
        const terms = searchTerms(qs('q'));
        const category = catalogCategoryFilter(qs('category'));
        if (qs('all')) {
          const [items, categories] = await Promise.all([allCatalog({ terms, category }), catalogCategories()]);
          return res.status(200).json({ items: await withCatalogImageUrls(items, { idOf: (it) => it.id }), total: items.length, categories });
        }
        const page = Math.max(1, Math.floor(Number(qs('page')) || 1));
        const [list, categories] = await Promise.all([
          listCatalog({ terms, category, offset: (page - 1) * SUPPLY_PAGE_SIZE, limit: SUPPLY_PAGE_SIZE }),
          catalogCategories(),
        ]);
        const buildings = await catalogBuildingCounts(list.rows.map((r) => r.id));
        const items = await withCatalogImageUrls(list.rows.map((r) => ({ ...r, buildings: buildings[r.id] || 0 })), { idOf: (it) => it.id });
        return res.status(200).json({ items, total: list.total, page, pageSize: SUPPLY_PAGE_SIZE, categories });
      }

      if (door('requests')) {
        // One building (the order sheet's "already on order" + budget line, the customer tab). The
        // queue's page, counts and "Select all" moved to GET orders (S131).
        const building = qs('building');
        if (!isSupplyId(building)) return res.status(400).json({ error: 'building must be one customer id', code: 'building_required' });
        return res.status(200).json(await buildingRequests({ clientId: building }));
      }

      if (door('usage')) {
        const w = supplyUsageWindowKeys(qs('period') || '30d', { todayKey: today, from: qs('from') || null, to: qs('to') || null });
        if (w.error) {
          return res.status(400).json({ error: 'That range cannot be read.', code: w.error, ...(w.firstKey ? { firstKey: w.firstKey } : {}) });
        }
        const fromMs = startOfDayKey(w.fromKey, s.tz).getTime();
        const toMs = w.toKey >= today ? Date.now() : startOfDayKey(addDaysKey(w.toKey, 1), s.tz).getTime() - 1;
        const requests = await deliveredRequests({
          fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(),
          clientIds: scopeIds(s, { mgr: qs('mgr'), cust: qs('cust'), om: qs('om') }, g),
        });
        return res.status(200).json({
          rows: supplyUsageByItem(requests, { fromMs, toMs }),
          fromKey: w.fromKey, toKey: w.toKey, historyStartKey: supplyHistoryStartKey(today),
        });
      }

      if (door('budgets')) {
        // The CALENDAR month in the org's zone (SUP-10 ★a), from its first day to now — each delivery
        // counted in the month it happened (S131).
        const fromKey = startOfMonthKey(today);
        const spendCents = await deliveredCentsByClient({
          fromIso: startOfDayKey(fromKey, s.tz).toISOString(), toIso: new Date().toISOString(),
        });
        return res.status(200).json({ monthKey: today.slice(0, 7), fromKey, spendCents });
      }

      if (door('buildings')) {
        // Supplies "By building" (the manager view redesign, 2026-10-09; SUP-14 ★a): every
        // building in the Manager / Customer scope with its ONE state (lib/supplies
        // supplyBuildingRows — the demo stub runs it too). Two COMPLETE reads, never a page and
        // never a read per building: every in-flight order, and the calendar month's delivered
        // spend in the org's zone (the budgets read's own window).
        // 🔴 S131 Wave 2: each row carries its ORDERS (numbers, who asked, the asker's note, each
        // line's state), so this door takes the queue's gate (EP-390): an OFFICE role holding
        // supplies.view — never crew, never the driver on a crew login.
        if (!isOfficeCaller(g)) return officeOnly(res);
        const scope = scopeIds(s, { mgr: qs('mgr'), cust: qs('cust'), om: qs('om') }, g);
        const inScope = scope ? new Set(scope) : null;
        const fromKey = startOfMonthKey(today);
        const [open, spendCents] = await Promise.all([
          inFlightRequests(),
          deliveredCentsByClient({ fromIso: startOfDayKey(fromKey, s.tz).toISOString(), toIso: new Date().toISOString() }),
        ]);
        const buildings = supplyBuildingRows({
          clients: s.clients.filter((c) => c && (!inScope || inScope.has(c.id))),
          requests: open, spendCents,
          approverOf: (clientId) => resolveSupplyApprover(s, clientId),
        });
        return res.status(200).json({ monthKey: today.slice(0, 7), buildings, counts: supplyBuildingCounts(buildings) });
      }
      return res.status(404).json({ error: 'Unknown route' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── the master list, its images and a building's switches (supplies.manage, D4) ─────
    if (door('catalog', 'save')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      const s = await slices();
      const actorId = g.orgUserId || null;
      const { item, created, before } = await saveCatalogItem(body, { actorId });
      const price = (v) => (v == null ? null : Math.round(v * 100));
      await logActivities([{
        action: created ? 'supply_catalog.created' : 'supply_catalog.edited',
        actorUserId: actorId, actorRole: g.role || null, actorName: nameOf(s, actorId),
        entityId: item.id,
        summary: created ? `Supply catalog: added ${item.name}${item.sku ? ` (${item.sku})` : ''}` : `Supply catalog: edited ${item.name}${item.sku ? ` (${item.sku})` : ''}`,
        ...(created ? {} : { before: { sku: before.sku, name: before.name, category: before.category, unit: before.unit, unitPriceCents: price(before.unitPrice) } }),
        after: { sku: item.sku, name: item.name, category: item.category, unit: item.unit, unitPriceCents: price(item.unitPrice) },
      }]);
      return res.status(200).json({ item: (await withCatalogImageUrls([item], { idOf: (it) => it.id }))[0], created });
    }
    if (door('catalog', 'delete')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      if (!isSupplyId(body.id)) return res.status(400).json({ error: 'id is required' });
      const s = await slices();
      const { before, buildings } = await deleteCatalogItem(body.id);
      if (!before) return res.status(404).json({ error: 'That item is no longer in the catalog.', code: 'not_found' });
      // Its product image leaves Storage with it (replace means delete).
      if (before.imageV) await removeCatalogImages(before.id, [before.imageV]);
      const actorId = g.orgUserId || null;
      await logActivities([{
        action: 'supply_catalog.deleted',
        actorUserId: actorId, actorRole: g.role || null, actorName: nameOf(s, actorId),
        entityId: before.id,
        summary: `Supply catalog: deleted ${before.name}${before.sku ? ` (${before.sku})` : ''}, on ${buildings} building${buildings === 1 ? '' : 's'}`,
        before: { sku: before.sku, name: before.name, buildings },
      }]);
      return res.status(200).json({ ok: true, buildings });
    }
    // A PRODUCT IMAGE (EP-399, S131): a data URL ≤ 1 MB whose bytes are a JPEG or PNG (the device
    // shrank it to ~640 px), stored once at a NEW version in ops-media, then the item's `image_v` set
    // by a compare-and-swap on its `version`; the previous object is removed once the row points at
    // the new one. `remove: true` clears it.
    if (door('catalog', 'image')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      if (!isSupplyId(body.id)) return res.status(400).json({ error: 'id is required' });
      const item = await getCatalogItem(body.id);
      if (!item) return res.status(404).json({ error: 'That item is no longer in the catalog.', code: 'not_found' });
      const version = body.version === undefined || body.version === null ? item.version : Number(body.version);
      const stale = () => res.status(409).json({ error: 'Someone changed this item at the same time. Open it again.', code: 'stale' });
      if (version !== item.version) return stale();
      const s = await slices();
      const actorId = g.orgUserId || null;
      let saved;
      if (body.remove) {
        saved = await setCatalogImageVersion({ id: item.id, version, imageV: null });
        if (!saved) return stale();
        if (item.imageV) await removeCatalogImages(item.id, [item.imageV]);
      } else {
        const v = validateCatalogImage(body.dataUrl);
        if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });
        // A fresh version above the last (a random step, so two uploads racing never share one).
        const nextV = (item.imageV || 0) + 1 + randomInt(0, 1000);
        await putCatalogImage(item.id, nextV, v);
        saved = await setCatalogImageVersion({ id: item.id, version, imageV: nextV });
        if (!saved) {
          await removeCatalogImages(item.id, [nextV]);
          return stale();
        }
        if (item.imageV) await removeCatalogImages(item.id, [item.imageV]);
      }
      await logActivities([{
        action: 'supply_catalog.edited',
        actorUserId: actorId, actorRole: g.role || null, actorName: nameOf(s, actorId),
        entityId: item.id,
        summary: `Supply catalog: ${body.remove ? 'removed the photo of' : 'new photo for'} ${item.name}`,
        before: { image: item.imageV ? 'set' : 'none' },
        after: { image: saved.imageV ? 'set' : 'none' },
      }]);
      return res.status(200).json({ item: (await withCatalogImageUrls([saved], { idOf: (it) => it.id }))[0] });
    }
    // IMPORT ITEMS (task 257: Supplies → Catalog → Import items): at most CATALOG_IMPORT_BATCH a call,
    // each judged against the LIVE catalog (store.importCatalogItems → lib/supplyCatalogImport): a new
    // item under its caller-minted id, an update merged over the row as it is now — filled cells
    // replace, blank cells leave — by a compare-and-swap on the version the preview read. Every item
    // is answered; ONE activity row says what the call did.
    if (door('catalog', 'import')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      const read = readCatalogImportBody(body, { isId: isSupplyId });
      if (read.error === 'too_many') return res.status(400).json({ error: `At most ${CATALOG_IMPORT_BATCH} items a call.`, code: 'too_many', max: CATALOG_IMPORT_BATCH });
      if (read.error) return res.status(400).json({ error: 'items are required', code: 'bad_items' });
      const s = await slices();
      const actorId = g.orgUserId || null;
      const results = await importCatalogItems(read.items, { actorId });
      const added = results.filter((r) => r.ok && r.created);
      const updated = results.filter((r) => r.ok && !r.created && r.code !== 'exists');
      if (added.length || updated.length) {
        const names = (list) => list.slice(0, 20).map((r) => (r.item ? r.item.name : r.id)).join(', ') + (list.length > 20 ? `, and ${list.length - 20} more` : '');
        await logActivities([{
          action: 'supply_catalog.imported',
          actorUserId: actorId, actorRole: g.role || null, actorName: nameOf(s, actorId),
          entityId: null,
          summary: `Supply catalog: imported ${added.length + updated.length} item${added.length + updated.length === 1 ? '' : 's'} (${added.length} added, ${updated.length} updated)`
            + `${added.length ? `. Added: ${names(added)}` : ''}${updated.length ? `. Updated: ${names(updated)}` : ''}`.slice(0, 1000),
          after: { added: added.map((r) => r.id).slice(0, 100), updated: updated.map((r) => r.id).slice(0, 100) },
        }]);
      }
      return res.status(200).json({
        results: results.map((r) => ({
          id: r.id, ok: r.ok, created: !!r.created, ...(r.code ? { code: r.code } : {}), ...(r.holder ? { holder: r.holder } : {}),
          ...(r.item ? { item: { id: r.item.id, sku: r.item.sku, name: r.item.name, version: r.item.version, imageV: r.item.imageV || null } } : {}),
        })),
        counts: countsOf(results.map((r) => ({ code: r.ok ? (r.created ? 'added' : (r.code === 'exists' ? 'exists' : 'updated')) : r.code }))),
      });
    }
    // A PICTURE BEHIND A LINK (task 257): the import's Photo cell may be a web address; a browser
    // cannot read another site's picture, so the server downloads it — locked down in
    // _lib/supplies/imageLink.js (public addresses only, checked at the socket; redirects checked
    // again; a deadline, a size cap, picture bytes only) — and answers the bytes. It stores nothing:
    // the browser shrinks the picture and stores it through catalog/image (EP-399).
    if (door('catalog', 'image-link')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      if (!allow(req, res, { bucket: 'supply-image-link', id: g.orgUserId || g.email || g.user?.id || 'unknown', ...LINK_IMAGE_RATE, code: 'rate-limited' })) return;
      const r = await fetchLinkImage(body.url);
      res.setHeader('Cache-Control', 'private, no-store');
      if (!r.ok) {
        const status = r.code === 'bad_link' || r.code === 'blocked_port' || r.code === 'blocked_address' ? 400 : 422;
        return res.status(status).json({ error: LINK_WORDS[r.code] || LINK_WORDS.unreachable, code: r.code });
      }
      return res.status(200).json({ dataUrl: `data:${r.type};base64,${r.bytes.toString('base64')}`, type: r.type, bytes: r.bytes.length });
    }
    if (door('items', 'assign')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      const s = await slices();
      const client = clientOf(s, body.clientId);
      if (!client) return res.status(400).json({ error: 'That building no longer exists.', code: 'unknown_client' });
      const actorId = g.orgUserId || null;
      const { results, names } = await assignItems({ clientId: client.id, on: body.on, off: body.off, actorId });
      const changed = results.filter((x) => x.code === 'ok');
      if (changed.length) {
        const list = (isOn) => changed.filter((x) => x.on === isOn).map((x) => names[x.catalogItemId] || x.catalogItemId);
        const [onNames, offNames] = [list(true), list(false)];
        await logActivities([{
          action: 'supply_list.changed',
          actorUserId: actorId, actorRole: g.role || null, actorName: nameOf(s, actorId),
          entityId: client.id, clientId: client.id, clientName: client.name || null,
          summary: `Supply list for ${client.name || client.id}: ${[
            onNames.length ? `switched on ${onNames.join(', ')}` : '',
            offNames.length ? `switched off ${offNames.join(', ')}` : '',
          ].filter(Boolean).join('; ')}`.slice(0, 1000),
          after: { on: changed.filter((x) => x.on).map((x) => x.catalogItemId), off: changed.filter((x) => !x.on).map((x) => x.catalogItemId) },
        }]);
      }
      return res.status(200).json({ results, counts: countsOf(results) });
    }

    // ── a new order (supplies.request) ──────────────────────────────────────
    if (door('requests', 'create')) {
      const g = await requirePermission(req, res, 'supplies.request');
      if (!g) return;
      const s = await slices();
      const office = isOfficeCaller(g);
      // D4: a cleaner only for a building they clean (today or upcoming) — checked before anything
      // about the building is said.
      if (!office && !(await crewBuildingIds(g, s)).has(body.clientId)) return notYourBuilding(res);
      const client = clientOf(s, body.clientId);
      if (!client) return res.status(400).json({ error: 'That location no longer exists.', code: 'unknown_client' });
      const actorId = g.orgUserId || null;
      const seesMoney = await holdsPermission(g, 'supplies.view');
      // 🔴 S131: a cleaner asks for 1–20 of an item — the server's rule, not only the screen's.
      const { request, created } = await createRequest(body, {
        actorId, actorName: nameOf(s, actorId), ...(office ? {} : { maxQty: CREW_SUPPLY_MAX_QTY }),
      });
      // A replayed id answers the stored request — for a caller who reads no prices, only if it is
      // their own (an id is caller-minted; someone else's is not theirs to read).
      if (!created && !seesMoney && request.requestedByUserId !== actorId) {
        return res.status(409).json({ error: 'That request id is taken. Try again.', code: 'id_taken' });
      }
      if (created) {
        // SUP-1 b / SUP-9: the building's APPROVER hears — not the whole office.
        await ring((base) => supplySubmitNotifications(base, request, { actorUserId: actorId }));
        await prune(s);
      }
      return res.status(200).json({ request: seesMoney ? request : supplyCrewRequest(request), created });
    }

    // ── decide: ONE call for one order or the bulk bar's batch (§132) ─────
    // approve / reject / reopen. Submitting, the line acts and completing have their own doors.
    if (door('requests', 'decide')) {
      const g = await requireAnyPermission(req, res, ['supplies.approve', 'supplies.manage']);
      if (!g) return;
      const decision = body.decision;
      if (!SUPPLY_DECIDE_DECISIONS.includes(decision)) return res.status(400).json({ error: 'Unknown decision.', code: 'bad_decision' });
      const ids = idsOf(body);
      if (!ids.length) return res.status(400).json({ error: 'ids is required' });
      const s = await slices();
      const [holdsApprove, holdsManage] = await Promise.all([
        holdsPermission(g, 'supplies.approve'), holdsPermission(g, 'supplies.manage'),
      ]);
      const selfId = g.orgUserId || null;
      const results = await decideRequests({
        ids, decision, reason: typeof body.reason === 'string' ? body.reason : '',
        actorId: selfId, actorName: nameOf(s, selfId),
        mayDecide: (r) => {
          const approverId = approverIdOf(s, r.clientId);
          return maySupplyDecide({
            request: r, decision, selfId, role: g.role || null, approverId,
            approverOpsManagerId: supplyApproverOpsManagerId(s.users, approverId), holdsApprove, holdsManage,
          });
        },
      });
      await afterMoves({ g, s, done: results.filter((x) => x.ok), decision });
      return res.status(200).json({
        results: results.map(({ id, ok, code, request }) => ({ id, ok, code, ...(request ? { request } : {}) })),
        counts: countsOf(results),
      });
    }

    // ── 🔴 SUBMIT TO SUPPLIER (EP-392): approved → sent, one order or the bulk bar's batch ──
    if (door('orders', 'submit')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      const ids = idsOf(body);
      if (!ids.length) return res.status(400).json({ error: 'ids is required' });
      const s = await slices();
      const selfId = g.orgUserId || null;
      const results = await decideRequests({
        ids, decision: 'submit', actorId: selfId, actorName: nameOf(s, selfId),
        mayDecide: (r) => maySupplyDecide({ request: r, decision: 'submit', selfId, role: g.role || null, holdsManage: true }),
      });
      await afterMoves({ g, s, done: results.filter((x) => x.ok), decision: 'submit' });
      return res.status(200).json({
        results: results.map(({ id, ok, code, request }) => ({ id, ok, code, ...(request ? { request } : {}) })),
        counts: countsOf(results),
      });
    }

    // ── 🔴 THE PER-LINE ACTS (EP-393): deliver · backorder · cancel, on a submitted order ──
    // supplies.manage, or supplies.deliver for `deliver` alone (maySupplyDecide per act). A CAS on the
    // version the page read. A deliver-only caller (the driver) is answered with no order and no money.
    if (door('orders', 'fulfill')) {
      const g = await requireAnyPermission(req, res, ['supplies.manage', 'supplies.deliver']);
      if (!g) return;
      if (!isSupplyId(body.id)) return res.status(400).json({ error: 'id is required' });
      const [holdsManage, holdsDeliver] = await Promise.all([holdsPermission(g, 'supplies.manage'), holdsPermission(g, 'supplies.deliver')]);
      const s = await slices();
      const selfId = g.orgUserId || null;
      const DECISION_OF = { deliver: 'deliver', backorder: 'backorder', cancel: 'cancelLine' };
      const { before, request, applied } = await fulfillOrder({
        id: body.id, version: body.version, acts: body.acts, actorId: selfId, actorName: nameOf(s, selfId),
        via: holdsManage ? 'office' : 'driver', todayKey: dayKey(new Date(), s.tz),
        // An act the route does not know is the patch's to refuse by name (400 bad_act), not a 403.
        mayAct: (act) => !DECISION_OF[act] || maySupplyDecide({
          request: { id: body.id }, decision: DECISION_OF[act], selfId, role: g.role || null, holdsManage, holdsDeliver,
        }),
      });
      await afterLineActs({ g, s, before, request, applied });
      if (!holdsManage) return res.status(200).json({ id: request.id, version: request.version, applied: applied.map((a) => ({ line: a.line, act: a.act, qty: a.qty })) });
      return res.status(200).json({ order: request, progress: supplyOrderProgress(request), applied });
    }

    // ── 🔴 MARK COMPLETED (EP-394): only once every line is delivered or cancelled ──
    if (door('orders', 'complete')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      if (!isSupplyId(body.id)) return res.status(400).json({ error: 'id is required' });
      const s = await slices();
      const selfId = g.orgUserId || null;
      const [result] = await decideRequests({
        ids: [body.id], decision: 'complete', version: body.version, actorId: selfId, actorName: nameOf(s, selfId),
        mayDecide: (r) => maySupplyDecide({ request: r, decision: 'complete', selfId, role: g.role || null, holdsManage: true }),
      });
      if (!result || !result.ok) {
        const code = (result && result.code) || 'not_found';
        return res.status(MOVE_STATUS[code] || 409).json({ error: MOVE_WORDS[code] || 'That order can’t be completed.', code });
      }
      await afterMoves({ g, s, done: [result], decision: 'complete' });
      return res.status(200).json({ order: result.request, progress: supplyOrderProgress(result.request) });
    }

    // ── A COMMENT (EP-395): the office's note on an order, append-only ──
    if (door('orders', 'comment')) {
      const g = await requirePermission(req, res, 'supplies.view');
      if (!g) return;
      if (!isOfficeCaller(g)) return officeOnly(res);
      if (!isSupplyId(body.requestId)) return res.status(400).json({ error: 'Name the order.', code: 'request_required' });
      const s = await slices();
      const selfId = g.orgUserId || null;
      const { comment, created } = await addComment({
        id: body.id, requestId: body.requestId, body: body.body,
        authorUserId: selfId, authorRole: g.role || null, authorName: nameOf(s, selfId),
      });
      return res.status(200).json({ comment, created });
    }

    // ── THE INVOICE (EP-396 / EP-397 / EP-408): upload, confirm, remove — supplies.manage ──
    // Kept with a SUBMITTED or COMPLETED order (the supplier invoices what was ordered).
    if (door('orders', 'invoice', 'upload-url') || door('orders', 'invoice', 'confirm')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      const order = isSupplyId(body.requestId) ? await getRequest(body.requestId) : null;
      if (!order) return res.status(404).json({ error: 'That order no longer exists.', code: 'not_found' });
      if (![SUPPLY_STATUS.sent, SUPPLY_STATUS.completed].includes(supplyStatusOf(order))) {
        return res.status(409).json({ error: 'An invoice is kept once the order is with the supplier.', code: 'not_submitted' });
      }
      const v = validateInvoiceUpload(body);
      if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });
      const kept = await listInvoices(order.id);
      if (kept.length >= SUPPLY_INVOICES_MAX && !kept.some((x) => x.id === body.docId)) {
        return res.status(409).json({ error: 'This order already keeps as many files as it can.', code: 'too_many' });
      }
      if (third === 'upload-url') {
        const su = await signedInvoiceUploadUrl(invoicePathFor(order.id, body.docId));
        return res.status(200).json({ path: su.path, token: su.token, signedUrl: su.signedUrl });
      }
      const s = await slices();
      const selfId = g.orgUserId || null;
      const { row, created } = await insertInvoice({
        docId: body.docId, requestId: order.id, fileName: v.fileName, mimeType: body.mimeType, sizeBytes: v.sizeBytes,
        uploadedByUserId: selfId, uploaderName: nameOf(s, selfId),
      });
      if (created) {
        const client = clientOf(s, order.clientId);
        await logActivities([{
          action: 'supply_order.invoice_added',
          actorUserId: selfId, actorRole: g.role || null, actorName: nameOf(s, selfId),
          entityId: order.id, clientId: order.clientId || null, clientName: client ? client.name || null : null,
          summary: `Supply order ${supplyOrderNo(order) || order.id}: invoice ${v.fileName} added`.slice(0, 1000),
          after: { file: v.fileName, sizeBytes: v.sizeBytes },
        }]);
      }
      return res.status(200).json({ invoice: toInvoice(row), created });
    }
    if (door('orders', 'invoice', 'delete')) {
      const g = await requirePermission(req, res, 'supplies.manage');
      if (!g) return;
      const row = await getInvoiceRow(body.id);
      if (!row) return res.status(404).json({ error: 'That invoice is no longer kept.', code: 'not_found' });
      await deleteInvoice(row);
      const s = await slices();
      const selfId = g.orgUserId || null;
      const order = await getRequest(row.request_id);
      const client = order ? clientOf(s, order.clientId) : null;
      await logActivities([{
        action: 'supply_order.invoice_removed',
        actorUserId: selfId, actorRole: g.role || null, actorName: nameOf(s, selfId),
        entityId: row.request_id, clientId: (order && order.clientId) || null, clientName: client ? client.name || null : null,
        summary: `Supply order ${(order && supplyOrderNo(order)) || row.request_id}: invoice ${row.file_name} removed`.slice(0, 1000),
        before: { file: row.file_name, sizeBytes: row.size_bytes },
      }]);
      return res.status(200).json({ ok: true });
    }

    // ── DELIVERED, by the driver (EP-367, per line since S131) ──────────────
    // One submitted order: the lines named (`lines`, by index), or every line still to come. Stamped
    // with the caller's name from the login, `via: driver`. A CAS on the version the list showed. The
    // answer names what landed and carries NO order — no lines, no prices reach the driver. The driver
    // can't backorder, cancel or complete.
    if (door('requests', 'deliver')) {
      const g = await requirePermission(req, res, 'supplies.deliver');
      if (!g) return;
      if (!isSupplyId(body.id)) return res.status(400).json({ error: 'id is required' });
      const order = await getRequest(body.id);
      if (!order) return res.status(404).json({ error: 'That order no longer exists.', code: 'not_found' });
      const open = supplyOrderProgress(order).lines.filter((l) => l.remaining > 0).map((l) => l.index);
      const named = Array.isArray(body.lines) ? [...new Set(body.lines)] : open;
      if (!named.length) return res.status(409).json({ error: 'Everything on this order is already delivered.', code: 'nothing_to_deliver' });
      const s = await slices();
      const selfId = g.orgUserId || null;
      const { before, request, applied } = await fulfillOrder({
        id: order.id, version: body.version, acts: named.map((line) => ({ line, act: 'deliver' })),
        actorId: selfId, actorName: nameOf(s, selfId), via: 'driver', todayKey: dayKey(new Date(), s.tz),
        mayAct: (act) => act === 'deliver',
      });
      await afterLineActs({ g, s, before, request, applied });
      return res.status(200).json({ id: request.id, ok: true, version: request.version, delivered: applied.map((a) => a.line) });
    }

    // ── cancel (CS-596 who, CS-670 when, CS-790 a cancel that deleted nothing) ──
    // Only while the order is waiting or approved (the store answers 409 not_cancellable once it has
    // gone to the supplier, 409 stale when it moved under the cancel). A cancel DELETES the order, so
    // what it was is written to the activity log, the people waiting on it are told, and its files and
    // photos go with it (S131: its invoice paths are read before the delete takes them).
    if (door('requests', 'cancel')) {
      const g = await requireAnyPermission(req, res, ['supplies.request', 'supplies.approve', 'supplies.manage']);
      if (!g) return;
      if (!isSupplyId(body.id)) return res.status(400).json({ error: 'id is required' });
      const s = await slices();
      const [holdsRequest, holdsApprove, holdsManage] = await Promise.all([
        holdsPermission(g, 'supplies.request'), holdsPermission(g, 'supplies.approve'), holdsPermission(g, 'supplies.manage'),
      ]);
      const selfId = g.orgUserId || null;
      const paths = await invoiceObjectPaths([body.id]);
      // S131 Wave 2: a WAITING order is cancelled only by whoever may decide it (the approver, their
      // operations manager, the owner / an admin, with supplies.approve) or its asker — never on
      // supplies.manage alone (the Supply Manager); an approved one by the office too.
      const { before } = await cancelRequest(body.id, {
        mayCancel: (r) => {
          const approverId = approverIdOf(s, r.clientId);
          return maySupplyCancel({
            request: r, selfId, role: g.role || null, approverId,
            approverOpsManagerId: supplyApproverOpsManagerId(s.users, approverId), holdsRequest, holdsApprove, holdsManage,
          });
        },
      });
      await removeInvoiceObjects(paths);
      await removeOrderPhotos([before.id]);
      // The requester, and the building's approver, whoever did not cancel it (lib/supplyFlow).
      await ring((base) => supplyCancelNotifications(base, { request: before, actorUserId: selfId }));
      const client = clientOf(s, before.clientId);
      const was = supplyStatusOf(before);
      await logActivities([{
        action: 'supply_request.cancelled',
        actorUserId: selfId, actorRole: g.role || null, actorName: nameOf(s, selfId),
        entityId: before.id,
        clientId: before.clientId || null,
        clientName: client ? client.name || null : null,
        summary: `Supply request${client && client.name ? ` for ${client.name}` : ''} cancelled (it was ${was})`,
        // The request is gone: this is its record — where it stood, who asked, and what for.
        before: {
          status: was,
          requestedBy: before.requestedByName || null,
          items: (before.lines || []).map((l) => `${l.name || 'Item'} ×${Number(l.qty) || 0}`).join(', ').slice(0, 1000),
        },
      }]);
      await prune(s);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    // A refusal the caller caused is its own status, code and sentence; anything else is a
    // server error with no schema in the body.
    if (e instanceof SupplyRefusal) {
      const extra = Object.fromEntries(Object.entries(e).filter(([k]) => !['status', 'code', 'name'].includes(k)));
      return res.status(e.status).json({ error: e.message, code: e.code, ...extra });
    }
    if (e && e.code === 'id_taken') return res.status(409).json({ error: 'That id is taken. Try again.', code: 'id_taken' });
    const status = readErrorStatus(e);
    if (status !== 500) return res.status(status).json({ error: e.message });
    console.error('[api/supplies]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
