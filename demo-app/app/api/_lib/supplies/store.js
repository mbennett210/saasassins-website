// Service-role data layer for SUPPLIES (SUP-13, Matt 2026-10-05: "usage and spend go back 12
// months"). The approved lists and the request queue left the shared record for their own
// tables — migration 20261005130000_supplies.sql says why — and since the Oct 6 call the lists
// are SWITCHES over one master list (`supply_catalog`, migrations 20261011100000 / 20261011100100;
// plan 2026-10-11 §2). Nothing but this module touches them; app/api/supplies/*, the ops-alert
// cron, the org-state route's customer-delete cascade and the manager-day seed call it.
//
// 🔴 FIVE RULES THIS MODULE KEEPS, SO NO CALLER HAS TO REMEMBER THEM
//  1. MONEY IS INTEGER CENTS IN THE TABLE, the app's dollar shape OUT of it. `toCatalogItem` /
//     `toItem` / `toRequest` convert at this boundary (lib/supplies supplyFromCents), so every
//     screen and every pure rule reads `unitPrice` in dollars with null = no price (SUP-4), and
//     nothing above this file ever sees a cents column.
//  2. A REQUEST'S LINES ARE SNAPSHOTTED FROM THE BUILDING'S OWN LIST on submit
//     (lib/supplies snapshotSupplyLines): the body names items and quantities, never a price.
//     After that they are frozen — no write path here edits `lines`.
//  5. A BUILDING'S ROW IS ONLY ITS LINK (D5): its name, SKU, unit and price are READ from the
//     catalog, and no read here asks `supply_items` for the copied columns, so the code is the
//     same before and after 20261011100100 drops them (`ITEM_COLUMNS`).
//  3. EVERY DECISION IS A COMPARE-AND-SWAP on `version`, through the one state machine
//     (lib/supplyFlow supplyDecisionPatch → nextSupplyStatus). Two deciders cannot both land;
//     the loser gets 'stale' for that request and nothing else in its batch is affected.
//  4. READS THAT COUNT ARE COMPLETE. Usage, the monthly budget and the cron's walk go through
//     `selectAll` (count-first, ordered, paged), because a truncated tally is a wrong number
//     nobody would question (playbook II.7, UI_RULES §117). Only the queue PAGES, and it says
//     its total.
//
// `db` is the LAST argument everywhere and defaults to the real client, so the offline suite
// injects the PostgREST stand-in and drives every path with no Supabase.
import { randomUUID, createHash } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { selectAll } from '../pagedSelect.js';
import {
  SUPPLY_STATUS, SUPPLY_STATUSES, supplyFromCents, supplyToCents, supplyLinesTotalCents,
  snapshotSupplyLines, supplySearchText, supplyRequestItemCount, SUPPLY_DECIDE_MAX,
  supplyCatalogFields, findSupplySkuClash, supplyCategories, planSupplyAssign, SUPPLY_NO_CATEGORY,
  SUPPLY_CATEGORY_MAX, SUPPLY_ASSIGN_MAX, supplyCategoryAsUsed, isSupplyCancellable,
  normalizeSupplyFulfillment, SUPPLY_FULFILLMENT_STATES, supplyCommentBody, supplyDeliveredCentsByClient,
  supplyFulfillmentStateOf, CREW_SUPPLY_HISTORY_MAX,
} from '../../../src/lib/supplies.js';
import { supplyDecisionPatch, supplyFulfillPatch } from '../../../src/lib/supplyFlow.js';
import { planCatalogImportWrite } from '../../../src/lib/supplyCatalogImport.js';

export const T_CATALOG = 'supply_catalog';
export const T_ITEMS = 'supply_items';
export const T_REQUESTS = 'supply_requests';
export const T_COMMENTS = 'supply_request_comments';
// What a building's row is read with — never the copies 20261011100100 drops (rule 5).
const ITEM_COLUMNS = 'id, client_id, catalog_item_id, created_at, updated_at, version';
// S131: + `image_v`, the product image's version (migration 20261014120000).
const CATALOG_COLUMNS = 'id, sku, name, category, unit, unit_price_cents, image_v, created_at, updated_at, version';

// A caller-visible refusal: the route turns it into a 4xx with this message and code, never a
// raw Postgres error (which would leak the schema and read as a 500).
export class SupplyRefusal extends Error {
  constructor(message, { status = 400, code = 'supply_refused', ...extra } = {}) {
    super(message);
    this.name = 'SupplyRefusal';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const throwIf = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
// The app's caller-minted ids (`si_…`, `sr_…`, the move's `seed_…`): one safe token, so an id can
// never smuggle a PostgREST filter or a path.
export const isSupplyId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const text = (v, max) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

// ── row <-> object ──────────────────────────────────────────────────────────

// A catalog item in the app's shape (dollars; blank SKU / category = null).
export function toCatalogItem(row) {
  return {
    id: row.id,
    sku: row.sku || null,
    name: row.name || '',
    category: row.category || null,
    unit: row.unit || '',
    unitPrice: supplyFromCents(row.unit_price_cents),
    // S131: the product image's version (null = none); the route signs its link (catalogImage.js).
    imageV: Number.isInteger(row.image_v) && row.image_v > 0 ? row.image_v : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    version: row.version ?? 1,
  };
}

// A building's item: its switch row, READ THROUGH its catalog item (D5) — the same shape the list
// always served, plus the SKU, the category, the catalog item it is and its image's version.
export function toItem(row, cat) {
  return {
    id: row.id,
    clientId: row.client_id,
    catalogItemId: row.catalog_item_id || null,
    sku: (cat && cat.sku) || null,
    name: (cat && cat.name) || '',
    category: (cat && cat.category) || null,
    unit: (cat && cat.unit) || '',
    unitPrice: cat ? supplyFromCents(cat.unit_price_cents) : null,
    imageV: cat && Number.isInteger(cat.image_v) && cat.image_v > 0 ? cat.image_v : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    version: row.version ?? 1,
  };
}

export function toRequest(row) {
  // A line written before the master list has no SKU or catalog item: it reads null, and still
  // renders by its name.
  const lines = (Array.isArray(row.lines) ? row.lines : []).map((l) => ({
    itemId: l.itemId || null, catalogItemId: l.catalogItemId || null, sku: l.sku || null,
    name: l.name || '', qty: Number(l.qty) || 0, unitPrice: supplyFromCents(l.unitPriceCents),
  }));
  return {
    id: row.id,
    // S131: the order's number (SO-<number>, lib/supplies supplyOrderNo), from the sequence.
    number: Number.isInteger(Number(row.number)) && Number(row.number) > 0 ? Number(row.number) : null,
    clientId: row.client_id,
    status: row.status,
    note: row.note || '',
    lines,
    // S131: the per-line record, read safe (lib/supplies normalizeSupplyFulfillment), and its state.
    fulfillment: normalizeSupplyFulfillment(row.fulfillment, lines),
    fulfillmentState: SUPPLY_FULFILLMENT_STATES.includes(row.fulfillment_state) ? row.fulfillment_state : null,
    totalCents: row.total_cents ?? null,
    requestedByUserId: row.requested_by_user_id || null,
    requestedByName: row.requester_name || null,
    approvedAt: row.approved_at || null,
    approvedByUserId: row.approved_by_user_id || null,
    approvedByName: row.approver_name || null,
    rejectedAt: row.rejected_at || null,
    rejectedByUserId: row.rejected_by_user_id || null,
    rejectedByName: row.rejecter_name || null,
    rejectionReason: row.rejection_reason || null,
    // The delivery step (2026-10-12): what went out, by whom and when — null until sent. One entry
    // per line, in the lines' order (lib/supplies supplySentLines reads it).
    sentAt: row.sent_at || null,
    sentByUserId: row.sent_by_user_id || null,
    sentByName: row.sender_name || null,
    sentLines: Array.isArray(row.sent_lines)
      ? row.sent_lines.map((s) => ({ itemId: (s && s.itemId) || null, catalogItemId: (s && s.catalogItemId) || null, qtySent: Math.max(0, Math.floor(Number(s && s.qtySent) || 0)) }))
      : null,
    sentTotalCents: row.sent_total_cents ?? null,
    completedAt: row.completed_at || null,
    completedByUserId: row.completed_by_user_id || null,
    completedByName: row.completer_name || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    version: row.version ?? 1,
  };
}

// The app shape's lines → the stored snapshot, in cents, with the catalog item and its SKU.
const linesToRow = (lines) => (Array.isArray(lines) ? lines : []).map((l) => ({
  itemId: l.itemId || null, catalogItemId: l.catalogItemId || null, sku: l.sku || null,
  name: String(l.name || '').slice(0, 200), qty: Math.max(0, Math.floor(Number(l.qty) || 0)),
  unitPriceCents: supplyToCents(l.unitPrice),
}));

// The decision patch (camelCase, lib/supplyFlow) → the columns it writes. Every patch carries the
// sent columns (a submit stamps who and when; a reopen clears them, the legacy sent quantities with
// them) and, since S131, the per-line record and its state — so migrations 20261012100000 and
// 20261014120000 must be applied BEFORE the deploy (test-supply-delivery-migration.mjs and
// test-supply-orders-migration.mjs hold each column here to one they add).
export const REQUEST_PATCH_COLUMNS = Object.freeze({
  status: 'status',
  approvedAt: 'approved_at', approvedByUserId: 'approved_by_user_id', approvedByName: 'approver_name',
  rejectedAt: 'rejected_at', rejectedByUserId: 'rejected_by_user_id', rejectedByName: 'rejecter_name',
  rejectionReason: 'rejection_reason',
  sentAt: 'sent_at', sentByUserId: 'sent_by_user_id', sentByName: 'sender_name',
  sentLines: 'sent_lines', sentTotalCents: 'sent_total_cents',
  fulfillment: 'fulfillment', fulfillmentState: 'fulfillment_state',
  completedAt: 'completed_at', completedByUserId: 'completed_by_user_id', completedByName: 'completer_name',
});
const patchToRow = (patch) => Object.fromEntries(Object.entries(patch)
  .filter(([k]) => REQUEST_PATCH_COLUMNS[k]).map(([k, v]) => [REQUEST_PATCH_COLUMNS[k], v]));

// Every row of a filtered read, COMPLETE (count-first, ordered, paged). `extra` applies the
// read's own filter to both the count and the page, so they can never diverge.
async function allRows(table, { db, order = 'id', columns = '*', extra = (q) => q }) {
  return selectAll({
    count: async () => {
      const { count, error } = await extra(db.from(table).select('id', { count: 'exact', head: true })
        .eq('organization_id', CLEANSPACE_ORG_ID));
      throwIf(error, `count ${table}`);
      return count;
    },
    page: async (from, to) => {
      // Deterministic order, then id, before .range() — lint:paging.
      const { data, error } = await extra(db.from(table).select(columns)
        .eq('organization_id', CLEANSPACE_ORG_ID))
        .order(order).order('id').range(from, to);
      throwIf(error, `read ${table}`);
      return data || [];
    },
  });
}

// ── the master list (supply_catalog) ────────────────────────────────────────
// The office's "little Bible" (Matt, the Oct 6 call): SKU · name · category · how it comes ·
// price. Some hundred items, so the complete reads below stay small; the Catalog tab still pages
// at 20 on the server (UI_RULES §50).

// Catalog rows by id, keyed by id: complete for any number of ids (in chunks well under
// PostgREST's 1000-row cap).
const ID_CHUNK = 200;
async function catalogRowsByIds(ids, db) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(isSupplyId))];
  const out = new Map();
  for (let i = 0; i < list.length; i += ID_CHUNK) {
    const { data, error } = await db.from(T_CATALOG).select(CATALOG_COLUMNS)
      .eq('organization_id', CLEANSPACE_ORG_ID).in('id', list.slice(i, i + ID_CHUNK));
    throwIf(error, 'read supply catalog');
    for (const r of data || []) out.set(r.id, r);
  }
  return out;
}

export async function getCatalogItem(id, db = getSupabase()) {
  if (!isSupplyId(id)) return null;
  const { data, error } = await db.from(T_CATALOG).select(CATALOG_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read supply catalog item');
  return data ? toCatalogItem(data) : null;
}

// A category filter value: SUPPLY_NO_CATEGORY = the unlabelled items; else one label as written
// (≤ 60, the column's own limit); anything else is no filter.
export function catalogCategoryFilter(v) {
  if (v === SUPPLY_NO_CATEGORY) return v;
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= SUPPLY_CATEGORY_MAX ? s : null;
}
// The catalog's filters on one query: a category, and each search term on the name, the SKU or
// the category (searchTerms has already reduced a term to letters, digits and a few marks, so it
// cannot carry a filter of its own).
function applyCatalogFilters(q, { terms = [], category = null }) {
  let out = q;
  if (category === SUPPLY_NO_CATEGORY) out = out.is('category', null);
  else if (category) out = out.eq('category', category);
  for (const term of terms) out = out.or(`name.ilike.*${term}*,sku.ilike.*${term}*,category.ilike.*${term}*`);
  return out;
}

// One PAGE of the catalog, by name, with the total that matched (the Catalog tab).
export async function listCatalog({ terms = [], category = null, offset = 0, limit = 20 }, db = getSupabase()) {
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const { data, error, count } = await applyCatalogFilters(
    db.from(T_CATALOG).select(CATALOG_COLUMNS, { count: 'exact' }).eq('organization_id', CLEANSPACE_ORG_ID),
    { terms, category },
  ).order('name').order('id').range(from, from + size - 1);
  throwIf(error, 'read supply catalog');
  return { rows: (data || []).map(toCatalogItem), total: Number.isFinite(count) ? count : (data || []).length };
}

// The WHOLE catalog (a building's switches list every item): complete, past PostgREST's cap.
export async function allCatalog({ terms = [], category = null } = {}, db = getSupabase()) {
  const rows = await allRows(T_CATALOG, {
    db, order: 'name', columns: CATALOG_COLUMNS, extra: (q) => applyCatalogFilters(q, { terms, category }),
  });
  return rows.map(toCatalogItem);
}

// Every category in use, one spelling each, A to Z (the filter's options, the form's suggestions).
export async function catalogCategories(db = getSupabase()) {
  const rows = await allRows(T_CATALOG, {
    db, columns: 'id, category', extra: (q) => q.not('category', 'is', null),
  });
  return supplyCategories(rows);
}

// "On N buildings": how many buildings have each catalog item switched on — one head count per
// item, a few at a time (a page is 20 items; never a read of every building's rows).
export async function catalogBuildingCounts(ids, db = getSupabase()) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(isSupplyId))];
  const counts = await eachLimited(list, DECIDE_CONCURRENCY, async (id) => {
    const { count, error } = await db.from(T_ITEMS).select('id', { count: 'exact', head: true })
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('catalog_item_id', id);
    throwIf(error, 'count supply catalog buildings');
    return Number(count) || 0;
  });
  return Object.fromEntries(list.map((id, i) => [id, counts[i]]));
}

const SKU_TAKEN = (holder) => new SupplyRefusal(
  holder ? `That SKU is already on “${holder.name}”.` : 'That SKU is already on another item.',
  { status: 409, code: 'sku_taken', ...(holder ? { holder: { id: holder.id, name: holder.name, sku: holder.sku || null } } : {}) },
);
const CATALOG_FIELD_MESSAGES = {
  name_required: 'Give the item a name.',
  name_too_long: 'Keep the name under 200 characters.',
  sku_too_long: 'Keep the SKU under 40 characters.',
  category_too_long: 'Keep the category under 60 characters.',
  unit_too_long: 'Keep “how it comes” under 80 characters.',
  bad_price: 'Enter a price above zero, or leave it blank.',
};

// SAVE one catalog item (add or edit). CALLER-MINTED id, so a retried add is an edit, never a
// duplicate. 🔴 D2: a SKU another item holds is refused BY NAME (409 `sku_taken` with the
// holder) — checked against the catalog's SKUs first, and the database's unique index settles two
// saves racing past that check (its 23505 is the same refusal, never a 500). An edit is a
// compare-and-swap on `version`. Requests already sent keep their own snapshot, so an edit
// rewrites nothing that was asked for; every building with the item reads the new name and price.
export async function saveCatalogItem(body, { actorId = null } = {}, db = getSupabase()) {
  const id = body && body.id;
  if (!isSupplyId(id)) throw new SupplyRefusal('An item needs a caller-minted id.', { code: 'bad_id' });
  const f = supplyCatalogFields(body);
  if (f.error) throw new SupplyRefusal(CATALOG_FIELD_MESSAGES[f.error] || 'That item cannot be saved.', { code: f.error });
  const { sku, name, unit, unitPriceCents } = f.fields;
  let { category } = f.fields;
  // D3: a label typed in another case is stored as the spelling in use (supplyCategoryAsUsed).
  if (category) {
    const labelled = await allRows(T_CATALOG, { db, columns: 'id, category', extra: (q) => q.not('category', 'is', null) });
    category = supplyCategoryAsUsed(labelled, { id, category });
  }
  if (sku) {
    const withSku = await allRows(T_CATALOG, { db, columns: 'id, name, sku', extra: (q) => q.not('sku', 'is', null) });
    const holder = findSupplySkuClash(withSku, { id, sku });
    if (holder) throw SKU_TAKEN(holder);
  }
  const cols = { sku, name, category, unit, unit_price_cents: unitPriceCents };
  const existing = await getCatalogItem(id, db);
  if (existing) {
    const { data, error } = await db.from(T_CATALOG)
      .update({ ...cols, version: existing.version + 1 })
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('version', existing.version)
      .select(CATALOG_COLUMNS);
    if (error && error.code === '23505') throw SKU_TAKEN(null);
    throwIf(error, 'save supply catalog item');
    if (!data || !data.length) throw new SupplyRefusal('Someone changed this item at the same time. Open it again.', { status: 409, code: 'stale' });
    return { item: toCatalogItem(data[0]), created: false, before: existing };
  }
  const { error } = await db.from(T_CATALOG).insert({
    id, organization_id: CLEANSPACE_ORG_ID, ...cols, created_by_user_id: actorId || null, version: 1,
  });
  if (error && error.code === '23505') {
    // Either a retried add of this very id (it is there now: answer as the edit it became) or a
    // SKU taken in the meantime.
    const now = await getCatalogItem(id, db);
    if (now) return { item: now, created: false, before: now };
    throw SKU_TAKEN(null);
  }
  throwIf(error, 'add supply catalog item');
  return { item: await getCatalogItem(id, db), created: true, before: null };
}

// DELETE one catalog item, answering how many buildings had it switched on. The buildings' rows go
// first (the migration's ON DELETE CASCADE would take them too; deleting them here makes the
// order explicit). Requests keep their lines — a frozen snapshot of what was asked for.
export async function deleteCatalogItem(id, db = getSupabase()) {
  const before = await getCatalogItem(id, db);
  if (!before) return { before: null, buildings: 0 };
  const buildings = (await catalogBuildingCounts([id], db))[id] || 0;
  const items = await db.from(T_ITEMS).delete().eq('organization_id', CLEANSPACE_ORG_ID).eq('catalog_item_id', id);
  throwIf(items.error, 'remove the catalog item from the buildings');
  const { error } = await db.from(T_CATALOG).delete().eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id);
  throwIf(error, 'delete supply catalog item');
  return { before, buildings };
}

// IMPORT a batch of catalog items (task 257: Supplies → Catalog → Import items; at most
// CATALOG_IMPORT_BATCH, already read by readCatalogImportBody). The catalog is read ONCE and each
// item is judged against it and the batch's earlier items by the one pure rule
// (lib/supplyCatalogImport planCatalogImportWrite: filled cells replace, blank cells leave, a SKU
// another item holds refused by name, a category as used). New items go in ONE insert under their
// caller-minted ids (a retried batch finds them there and answers `exists`, never a second item);
// each update is a compare-and-swap on the version the preview read (`stale` when the item moved
// since). Every item is answered: → [{ id, ok, created, code?, holder?, item?, before? }].
export async function importCatalogItems(items, { actorId = null } = {}, db = getSupabase()) {
  const live = await allCatalog({}, db);
  const plans = planCatalogImportWrite(items, live);
  const out = new Map();
  const cols = (f) => ({ sku: f.sku, name: f.name, category: f.category, unit: f.unit, unit_price_cents: f.unitPriceCents });
  for (const p of plans) {
    if (!p.ok) out.set(p.id, { id: p.id, ok: false, created: false, code: p.code, ...(p.holder ? { holder: p.holder } : {}) });
    else if (p.code === 'exists') out.set(p.id, { id: p.id, ok: true, created: false, code: 'exists', item: p.before });
  }

  const creates = plans.filter((p) => p.ok && p.create && p.fields);
  const insertOne = async (p) => {
    const { data, error } = await db.from(T_CATALOG).insert({
      id: p.id, organization_id: CLEANSPACE_ORG_ID, ...cols(p.fields), created_by_user_id: actorId || null, version: 1,
    }).select(CATALOG_COLUMNS);
    if (error && error.code === '23505') {
      const now = await getCatalogItem(p.id, db);
      return now ? { id: p.id, ok: true, created: false, code: 'exists', item: now } : { id: p.id, ok: false, created: false, code: 'sku_taken' };
    }
    throwIf(error, 'import supply catalog item');
    return { id: p.id, ok: true, created: true, item: toCatalogItem(data[0]) };
  };
  if (creates.length) {
    const { data, error } = await db.from(T_CATALOG).insert(creates.map((p) => ({
      id: p.id, organization_id: CLEANSPACE_ORG_ID, ...cols(p.fields), created_by_user_id: actorId || null, version: 1,
    }))).select(CATALOG_COLUMNS);
    if (error && error.code === '23505') {
      // Something in the batch raced another save (or the batch was sent twice): one at a time, so
      // each item gets its own answer.
      for (const p of creates) out.set(p.id, await insertOne(p));
    } else {
      throwIf(error, 'import supply catalog items');
      const byId = new Map((data || []).map((r) => [r.id, r]));
      for (const p of creates) out.set(p.id, { id: p.id, ok: true, created: true, item: byId.has(p.id) ? toCatalogItem(byId.get(p.id)) : null });
    }
  }

  const updates = plans.filter((p) => p.ok && !p.create && p.fields);
  await eachLimited(updates, DECIDE_CONCURRENCY, async (p) => {
    const { data, error } = await db.from(T_CATALOG)
      .update({ ...cols(p.fields), version: p.before.version + 1 })
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', p.id).eq('version', p.before.version)
      .select(CATALOG_COLUMNS);
    if (error && error.code === '23505') { out.set(p.id, { id: p.id, ok: false, created: false, code: 'sku_taken' }); return; }
    throwIf(error, 'import supply catalog update');
    if (!data || !data.length) { out.set(p.id, { id: p.id, ok: false, created: false, code: 'stale' }); return; }
    out.set(p.id, { id: p.id, ok: true, created: false, item: toCatalogItem(data[0]), before: p.before });
  });
  return items.map((x) => out.get(x.id) || { id: x.id, ok: false, created: false, code: 'not_found' });
}

// ── a building's list: its switches (supply_items) ──────────────────────────

// ONE building's list, read through the catalog (D5), by name. A row whose catalog item is gone
// (never, with the cascade) or not linked yet (a row the old code wrote in the minutes before
// 20261011100100 re-runs the backfill) is not orderable and is left out.
export async function listItems({ clientId }, db = getSupabase()) {
  if (!clientId) return [];
  const rows = await allRows(T_ITEMS, { db, columns: ITEM_COLUMNS, extra: (q) => q.eq('client_id', clientId) });
  const cats = await catalogRowsByIds(rows.map((r) => r.catalog_item_id), db);
  return rows.filter((r) => cats.has(r.catalog_item_id))
    .map((r) => toItem(r, cats.get(r.catalog_item_id)))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

// SWITCH a building's items on and off (D4) — ONE call, bounded at SUPPLY_ASSIGN_MAX, every asked
// id answered (lib/supplies planSupplyAssign: ok · already · not_found · conflict). On = a row
// linking the building to the catalog item, inserted or-ignore on the one-row-per-pair unique
// index (a retry or a second tab cannot double it); off = that row deleted. The building's
// history is untouched either way, and keys on the catalog item, so off and back on keeps it
// (D6). Returns { results, names } — `names` the catalog items' names, for the activity row.
export async function assignItems({ clientId, on = [], off = [], actorId = null }, db = getSupabase()) {
  const building = text(clientId, 128);
  if (!building || !isSupplyId(building)) throw new SupplyRefusal('Pick the building.', { code: 'client_required' });
  const asked = (list) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x);
  const onIds = asked(on);
  const offIds = asked(off);
  const safeIds = [...onIds, ...offIds].filter(isSupplyId);
  // Refused before anything is read: a bigger selection is the client's to split.
  if (new Set(onIds).size + new Set(offIds).size > SUPPLY_ASSIGN_MAX) {
    throw new SupplyRefusal(`Switch at most ${SUPPLY_ASSIGN_MAX} items at once.`, { code: 'too_many', max: SUPPLY_ASSIGN_MAX });
  }
  const [rows, cats] = await Promise.all([
    allRows(T_ITEMS, { db, columns: 'id, catalog_item_id', extra: (q) => q.eq('client_id', building) }),
    catalogRowsByIds(safeIds, db),
  ]);
  const plan = planSupplyAssign({
    on: onIds, off: offIds,
    current: rows.map((r) => r.catalog_item_id).filter(Boolean),
    known: [...cats.keys()],
  });
  if (plan.error) throw new SupplyRefusal(`Switch at most ${plan.max} items at once.`, { code: 'too_many', max: plan.max });
  if (plan.add.length) {
    const { error } = await db.from(T_ITEMS).upsert(plan.add.map((catalogItemId) => ({
      id: `si_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      organization_id: CLEANSPACE_ORG_ID, client_id: building, catalog_item_id: catalogItemId,
      created_by_user_id: actorId || null, version: 1,
    })), { onConflict: 'organization_id,client_id,catalog_item_id', ignoreDuplicates: true });
    throwIf(error, 'switch supply items on');
  }
  if (plan.remove.length) {
    const { error } = await db.from(T_ITEMS).delete()
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_id', building).in('catalog_item_id', plan.remove);
    throwIf(error, 'switch supply items off');
  }
  const names = Object.fromEntries([...cats.values()].map((c) => [c.id, c.name || '']));
  return { results: plan.results, names };
}

// ── requests: reads ─────────────────────────────────────────────────────────

export async function getRequest(id, db = getSupabase()) {
  if (!isSupplyId(id)) return null;
  const { data, error } = await db.from(T_REQUESTS).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read supply request');
  return data ? toRequest(data) : null;
}

// A search term made safe for a PostgREST `or=(…)` value: letters, digits, spaces and a few
// harmless marks only — a comma, a parenthesis or a dot would otherwise end the term and start a
// filter of the caller's choosing.
const cleanTerm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} '&-]/gu, '').trim().slice(0, 60);
export function searchTerms(q) {
  return String(q || '').split(/\s+/).map(cleanTerm).filter(Boolean).slice(0, 6);
}

// ── THE ORDER QUEUE (S131: the Requests tab and the Supply Manager's Home; GET /api/supplies/orders) ──
// The tabs, as SQL: the stored status, and a SUBMITTED order split by its per-line record's state —
// `sent` = With supplier (nothing delivered yet; an order submitted before the record has none),
// `partial` = Partially fulfilled (something delivered, or everything in and not yet closed). The
// index supply_requests_org_status_fstate_idx serves each (migration 20261014120000).
function applyTab(q, tab) {
  if (tab === 'partial') return q.eq('status', SUPPLY_STATUS.sent).in('fulfillment_state', ['partial', 'ready']);
  if (tab === SUPPLY_STATUS.sent) return q.eq('status', SUPPLY_STATUS.sent).or('fulfillment_state.is.null,fulfillment_state.eq.pending');
  return SUPPLY_STATUSES.includes(tab) ? q.eq('status', tab) : q;
}
// The queue's filters, applied to one query. `clientIds` null = every building; an empty list
// matches nothing (a manager with no buildings). Each search term must match the row's words, OR
// name one of the buildings the caller resolved for it (its name, number or approver), OR — a term
// that reads as an order number ("SO-1047", "1047") — the order's number (`numbers[i]`).
function applyQueueFilters(q, { tab, clientIds, terms = [], termClientIds = [], numbers = [] }) {
  let out = applyTab(q, tab);
  if (Array.isArray(clientIds)) out = out.in('client_id', clientIds.length ? clientIds : ['__none__']);
  terms.forEach((term, i) => {
    const ids = (termClientIds[i] || []).filter(isSupplyId).slice(0, 200);
    const n = Number.isSafeInteger(numbers[i]) && numbers[i] > 0 ? numbers[i] : null;
    out = out.or([
      `search_text.ilike.*${term}*`,
      ...(ids.length ? [`client_id.in.(${ids.join(',')})`] : []),
      ...(n ? [`number.eq.${n}`] : []),
    ].join(','));
  });
  return out;
}

// One PAGE of the queue, newest first, with the total that matched. 20 a page (UI_RULES §50).
export async function listOrders({ tab, clientIds = null, terms = [], termClientIds = [], numbers = [], offset = 0, limit = 20 }, db = getSupabase()) {
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const { data, error, count } = await applyQueueFilters(
    db.from(T_REQUESTS).select('*', { count: 'exact' }).eq('organization_id', CLEANSPACE_ORG_ID),
    { tab, clientIds, terms, termClientIds, numbers },
  ).order('created_at', { ascending: false }).order('id').range(from, from + size - 1);
  throwIf(error, 'read supply orders');
  return { rows: (data || []).map(toRequest), total: Number.isFinite(count) ? count : (data || []).length };
}

// Every match's id and building — for "Select all N" on the two tabs with a bulk action (Pending
// approval, New), which stay small because a building's open orders are few. Complete, not a page.
export async function matchingOrderRefs({ tab, clientIds = null, terms = [], termClientIds = [], numbers = [] }, db = getSupabase()) {
  const rows = await allRows(T_REQUESTS, {
    db, order: 'created_at', columns: 'id, client_id',
    extra: (q) => applyQueueFilters(q, { tab, clientIds, terms, termClientIds, numbers }),
  });
  return rows.map((r) => ({ id: r.id, clientId: r.client_id }));
}

// The states a request is still IN FLIGHT in — not yet delivered or rejected (the delivery step
// added `sent`, 2026-10-12): what the order sheet counts on order and By building calls placed.
const IN_FLIGHT = [SUPPLY_STATUS.requested, SUPPLY_STATUS.approved, SUPPLY_STATUS.sent];

// ONE building's requests (round 3, 2026-10-06): every OPEN one — requested, approved or sent, the
// order sheet's "already on order" and the on-order money its budget line counts, so a COMPLETE
// read, never the queue's page of 20 — and its newest settled ones for the customer's Supplies
// tab. Both newest first.
export const BUILDING_RECENT_SETTLED = 5;
export async function buildingRequests({ clientId }, db = getSupabase()) {
  if (!isSupplyId(clientId)) return { open: [], recent: [] };
  const [openRows, recentRes] = await Promise.all([
    allRows(T_REQUESTS, {
      db, order: 'created_at',
      extra: (q) => q.eq('client_id', clientId).in('status', IN_FLIGHT),
    }),
    db.from(T_REQUESTS).select('*')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_id', clientId)
      .in('status', [SUPPLY_STATUS.completed, SUPPLY_STATUS.rejected])
      .order('created_at', { ascending: false }).order('id')
      .range(0, BUILDING_RECENT_SETTLED - 1),
  ]);
  throwIf(recentRes.error, 'read settled supply requests');
  const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id));
  return {
    open: openRows.map(toRequest).sort(newestFirst),
    recent: (recentRes.data || []).map(toRequest),
  };
}

// EVERY in-flight request (requested, approved or sent), every building — the Supplies "By
// building" view (the manager view redesign, 2026-10-09): one COMPLETE read the route narrows to
// the caller's buildings, never one read per building and never the queue's page of 20. In-flight
// requests stay few (a building's open orders are few), so the whole set is small; the columns
// are what the per-building rule reads — S131 Wave 2: the number and the per-line record (each
// order's line states), and who asked, when and their note (the approval cards). Never '*'.
export async function inFlightRequests(db = getSupabase()) {
  const rows = await allRows(T_REQUESTS, {
    db, order: 'created_at',
    columns: 'id, number, client_id, status, note, lines, sent_lines, fulfillment, fulfillment_state, total_cents, requested_by_user_id, requester_name, created_at, approved_at, sent_at',
    extra: (q) => q.in('status', IN_FLIGHT),
  });
  return rows.map(toRequest);
}

// ── the driver's list and the cleaners' line (the delivery step's reads, per line since S131) ──
// The columns they read: the lines (their names and quantities — the route builds the answer field
// by field through lib/supplies, so the prices in them never leave), the per-line record (what came,
// when and by whom), the legacy sent record, who submitted and completed it, when, the number and the
// version (the driver's per-line Delivered is a compare-and-swap). Never '*'.
const DELIVERY_COLUMNS = 'id, number, version, client_id, status, lines, sent_lines, fulfillment, fulfillment_state, sent_at, sender_name, completed_at, completer_name, created_at';

// The driver's list (GET /api/supplies/deliveries): EVERY submitted order, every building — what is
// with the supplier or on the van, few at any moment, and the source of today's deliveries on open
// orders — and every one COMPLETED since `dayStartIso` (the org-zone start of today: its last
// deliveries may be today's; one completed earlier has none today). Two complete reads (index:
// supply_requests_org_status_idx / _org_completed_idx).
export async function deliveryRequests({ dayStartIso }, db = getSupabase()) {
  const [sent, delivered] = await Promise.all([
    allRows(T_REQUESTS, { db, order: 'sent_at', columns: DELIVERY_COLUMNS, extra: (q) => q.eq('status', SUPPLY_STATUS.sent) }),
    allRows(T_REQUESTS, {
      db, order: 'completed_at', columns: DELIVERY_COLUMNS,
      extra: (q) => q.eq('status', SUPPLY_STATUS.completed).gte('completed_at', dayStartIso),
    }),
  ]);
  return [...sent, ...delivered].map(toRequest);
}

// The cleaners' read (GET /api/supplies/onsite): the same two, for the buildings `clientIds` only
// (the ones the cleaner cleans today — a handful), in chunks well under PostgREST's cap. Nothing
// is read for no building.
export async function onsiteRequests({ clientIds, dayStartIso }, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(clientIds) ? clientIds : []).filter(isSupplyId))];
  const out = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const [sent, delivered] = await Promise.all([
      allRows(T_REQUESTS, { db, order: 'sent_at', columns: DELIVERY_COLUMNS, extra: (q) => q.eq('status', SUPPLY_STATUS.sent).in('client_id', chunk) }),
      allRows(T_REQUESTS, {
        db, order: 'completed_at', columns: DELIVERY_COLUMNS,
        extra: (q) => q.eq('status', SUPPLY_STATUS.completed).gte('completed_at', dayStartIso).in('client_id', chunk),
      }),
    ]);
    out.push(...sent, ...delivered);
  }
  return out.map(toRequest);
}

// THE CLEANER'S OWN ORDERS (S131 Builder C: GET crew-list's history and last order, GET crew-orders —
// Home's tile — and GET crew-order): the columns a cleaner's answer is built from — the lines (their
// names and quantities; the route builds the answer field by field through lib/supplies
// supplyCrewOrders, so the prices in them never leave), the per-line record and the legacy sent record
// (each line's state), who asked, approved or declined it and when, and the decline's reason. Never '*'.
const CREW_ORDER_COLUMNS = 'id, number, client_id, status, lines, sent_lines, fulfillment, fulfillment_state, created_at, requested_by_user_id, requester_name, approved_at, approver_name, rejected_at, rejecter_name, rejection_reason, sent_at, completed_at, completed_by_user_id, completer_name';
// The orders `userId` asked for at the buildings `clientIds`, newest first, at most `limit`
// (CREW_SUPPLY_HISTORY_MAX): one read per chunk of buildings on the (org, client, created) index —
// a cleaner has a handful — each chunk's newest, merged. Nothing is read for no building or no person.
export async function crewOrderRequests({ clientIds, userId, limit = CREW_SUPPLY_HISTORY_MAX }, db = getSupabase()) {
  const ids = [...new Set((Array.isArray(clientIds) ? clientIds : []).filter(isSupplyId))];
  if (!ids.length || !isSupplyId(userId)) return [];
  const n = Math.max(1, Math.min(CREW_SUPPLY_HISTORY_MAX, Math.floor(Number(limit)) || CREW_SUPPLY_HISTORY_MAX));
  const rows = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db.from(T_REQUESTS).select(CREW_ORDER_COLUMNS)
      .eq('organization_id', CLEANSPACE_ORG_ID).in('client_id', ids.slice(i, i + ID_CHUNK)).eq('requested_by_user_id', userId)
      .order('created_at', { ascending: false }).order('id').range(0, n - 1);
    throwIf(error, 'read a cleaner\'s supply orders');
    rows.push(...(data || []));
  }
  return rows.map(toRequest)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id)))
    .slice(0, n);
}
// ONE order for the crew's door (EP-400), in the same narrow columns — or null.
export async function getCrewOrder(id, db = getSupabase()) {
  if (!isSupplyId(id)) return null;
  const { data, error } = await db.from(T_REQUESTS).select(CREW_ORDER_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read a supply order');
  return data ? toRequest(data) : null;
}

// The queue's counts: the whole backlog per TAB, before any filter (§132: the badge says what is
// waiting), and the Supply Manager's tiles — New, With supplier, Partially fulfilled and Completed
// TODAY (since `dayStartIso`, the org-zone start of today). One head count each, on the index.
//   → { open, approved, sent, partial, completed, rejected, completedToday }
const headCount = async (db, extra) => {
  const { count, error } = await extra(db.from(T_REQUESTS).select('id', { count: 'exact', head: true })
    .eq('organization_id', CLEANSPACE_ORG_ID));
  throwIf(error, 'count supply orders');
  return Number(count) || 0;
};
export async function orderCounts({ dayStartIso = null } = {}, db = getSupabase()) {
  const tabs = ['open', 'approved', 'sent', 'partial', 'completed', 'rejected'];
  const [values, completedToday] = await Promise.all([
    Promise.all(tabs.map((tab) => headCount(db, (q) => applyTab(q, tab)))),
    dayStartIso ? headCount(db, (q) => q.eq('status', SUPPLY_STATUS.completed).gte('completed_at', dayStartIso)) : Promise.resolve(0),
  ]);
  return { ...Object.fromEntries(tabs.map((t, i) => [t, values[i]])), completedToday };
}

// THE ORDERS THAT MAY HOLD A DELIVERY in [fromIso, toIso] (S131: usage and spend count each
// delivery in its own month), optionally for some buildings — the input of usage, the monthly budget
// and the cron's over-budget walk, which keep only the deliveries inside the window (lib/supplies
// supplyUsageByItem / supplyDeliveredCentsByClient). Two complete reads:
//   · every SUBMITTED order submitted by the window's end (deliveries come after the submit);
//   · every COMPLETED order closed from the window's start on, submitted by its end — or, one closed
//     before the per-line record, with no submit at all (it counts at its `completedAt`).
// The per-line record and the legacy sent record ride along; never '*'.
const DELIVERED_COLUMNS = 'id, number, client_id, status, lines, sent_lines, fulfillment, fulfillment_state, total_cents, created_at, sent_at, completed_at, completed_by_user_id, completer_name';
export async function deliveredRequests({ fromIso, toIso, clientIds = null }, db = getSupabase()) {
  if (Array.isArray(clientIds) && !clientIds.length) return [];
  const scoped = (x) => (Array.isArray(clientIds) ? x.in('client_id', clientIds) : x);
  const [open, closed] = await Promise.all([
    allRows(T_REQUESTS, {
      db, order: 'sent_at', columns: DELIVERED_COLUMNS,
      extra: (q) => scoped(q.eq('status', SUPPLY_STATUS.sent).lte('sent_at', toIso)),
    }),
    allRows(T_REQUESTS, {
      db, order: 'completed_at', columns: DELIVERED_COLUMNS,
      extra: (q) => scoped(q.eq('status', SUPPLY_STATUS.completed).gte('completed_at', fromIso)
        .or(`sent_at.is.null,sent_at.lte."${toIso}"`)),
    }),
  ]);
  return [...open, ...closed].map(toRequest);
}

// The window's DELIVERED money per building, in CENTS: { clientId → cents } — the monthly budget
// (SUP-7 / SUP-10: the Clients badge, a customer's budget card, the Supplies page, By building). S131:
// each delivery at its line's frozen price, in the month it happened (lib/supplies
// supplyDeliveredCentsByClient); an order completed before the per-line record at what went out.
export async function deliveredCentsByClient({ fromIso, toIso }, db = getSupabase()) {
  const rows = await deliveredRequests({ fromIso, toIso }, db);
  return supplyDeliveredCentsByClient(rows, { fromMs: Date.parse(fromIso), toMs: Date.parse(toIso) });
}

// What the monthly reminder and the over-budget alert walk (lib/opsAlerts getDueSupplyAlerts):
// every order CREATED this month (did the building order?), and every order that may hold a
// DELIVERY this month (what did it spend? — S131: per delivery). Merged by id, in the app's shape.
export async function requestsForSupplyAlerts({ fromIso }, db = getSupabase()) {
  const [created, delivered] = await Promise.all([
    allRows(T_REQUESTS, { db, order: 'created_at', columns: DELIVERED_COLUMNS, extra: (q) => q.gte('created_at', fromIso) }),
    deliveredRequests({ fromIso, toIso: new Date().toISOString() }, db),
  ]);
  const byId = new Map();
  for (const r of created.map(toRequest)) byId.set(r.id, r);
  for (const r of delivered) byId.set(r.id, r);
  return [...byId.values()];
}

// ── requests: writes ────────────────────────────────────────────────────────

// SUBMIT. Caller-minted id: a retried submit returns the request it already made and inserts
// nothing. The lines come from THIS building's catalog (rule 2), so a deleted or foreign item is
// refused by name rather than ordered at a price nobody approved. `maxQty` — the route passes the
// cleaner's 1–20 (lib/supplies CREW_SUPPLY_MAX_QTY) for a caller who is not an office role (S131):
// a line past it is refused by name, never clamped. The order's NUMBER comes from the table's
// sequence (migration 20261014120000); a create sends none.
export async function createRequest(body, { actorId = null, actorName = null, now, maxQty } = {}, db = getSupabase()) {
  const id = body && body.id;
  if (!isSupplyId(id)) throw new SupplyRefusal('A request needs a caller-minted id.', { code: 'bad_id' });
  const existing = await getRequest(id, db);
  if (existing) return { request: existing, created: false };
  const clientId = text(body.clientId, 128);
  if (!clientId) throw new SupplyRefusal('Pick a location.', { code: 'client_required' });
  const items = await listItems({ clientId }, db);
  const snap = snapshotSupplyLines(body.lines, new Map(items.map((it) => [it.id, it])), maxQty ? { maxQty } : {});
  if (snap.error === 'no_lines') throw new SupplyRefusal('Add at least one item.', { code: 'no_lines' });
  if (snap.error === 'too_many_lines') throw new SupplyRefusal('A request can list at most 100 items.', { code: 'too_many_lines' });
  if (snap.error === 'over_cap') {
    throw new SupplyRefusal(`Ask for at most ${snap.max} of one item.`, { code: 'qty_over_cap', itemId: snap.itemId, max: snap.max });
  }
  if (snap.error) throw new SupplyRefusal('One of these items is not on this location’s approved list any more.', { status: 409, code: 'unknown_item', itemId: snap.itemId });

  const request = {
    id, clientId, status: SUPPLY_STATUS.requested, note: text(body.note, 2000) || '',
    lines: snap.lines, requestedByUserId: actorId, requestedByName: actorName,
  };
  const rowLines = linesToRow(snap.lines);
  const { error } = await db.from(T_REQUESTS).insert({
    id, organization_id: CLEANSPACE_ORG_ID, client_id: clientId, status: SUPPLY_STATUS.requested,
    note: request.note || null, lines: rowLines, total_cents: supplyLinesTotalCents(rowLines),
    item_count: supplyRequestItemCount(request), search_text: supplySearchText(request),
    requested_by_user_id: actorId, requester_name: actorName,
    ...(now ? { created_at: now } : {}),
    version: 1,
  });
  throwIf(error, 'submit supply request');
  return { request: await getRequest(id, db), created: true };
}

/**
 * DECIDE a batch — ONE call for the queue's bulk bar (UI_RULES §132). Each id is judged on its
 * own and the results NAME every one that did not move, so the toast can say "Approved 12. 1
 * changed since you opened the page…" rather than pretending all or nothing happened:
 *   'ok' · 'not_found' · 'not_yours' (SUP-11: not this building's approver, and not the office)
 *   · 'illegal_move' (the state machine) · 'reason_required' · 'stale' (someone else decided it
 *   between the read and the write — the CAS on `version` missed).
 *
 * BOUNDED: at most SUPPLY_DECIDE_MAX ids, refused by name past it ('too_many' — the client splits
 * a bigger selection, lib/supplies runSupplyDecideBatches), never cut short in silence. The batch
 * is READ in one query and its updates run a few at a time, so a full batch is ~one second of
 * round-trips rather than two per request in series.
 *
 * The SAME write serves the supply orders' submit (S131: orders/submit — "Submitted to supplier",
 * which writes the per-line record and records no quantities) and Mark Completed (orders/complete,
 * with `version`: one order, the version the screen read — 'lines_open' until every line is
 * resolved). A reopen once something was delivered is 'has_deliveries'.
 *
 * @param mayDecide (request) => boolean — the caller's SUP-11 verdict for one request
 * @param version   one order only: the version the caller read; a different one is 'stale'
 * @returns [{ id, ok, code, before?, request? }] in the order the ids were sent
 */
export async function decideRequests({ ids, decision, reason = '', actorId = null, actorName = null, now, mayDecide, version = null }, db = getSupabase()) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(isSupplyId))];
  if (list.length > SUPPLY_DECIDE_MAX) {
    throw new SupplyRefusal(`Decide at most ${SUPPLY_DECIDE_MAX} requests at once.`, { code: 'too_many', max: SUPPLY_DECIDE_MAX });
  }
  if (!list.length) return [];
  const stamp = now || new Date().toISOString();
  const { data: rows, error: readError } = await db.from(T_REQUESTS).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).in('id', list);
  throwIf(readError, 'read supply requests');
  const byId = new Map((rows || []).map((r) => [r.id, toRequest(r)]));
  return eachLimited(list, DECIDE_CONCURRENCY, async (id) => {
    const before = byId.get(id);
    if (!before) return { id, ok: false, code: 'not_found' };
    if (typeof mayDecide === 'function' && !mayDecide(before)) return { id, ok: false, code: 'not_yours' };
    // The screen's own read: an order that moved since is the screen's to re-read, never overwritten.
    if (version !== null && version !== undefined && Number(version) !== Number(before.version)) return { id, ok: false, code: 'stale' };
    const d = supplyDecisionPatch(before, decision, { byUserId: actorId, byName: actorName, reason, now: stamp });
    if (d.refused) return { id, ok: false, code: d.refused };
    const after = { ...before, ...d.patch };
    const { data, error } = await db.from(T_REQUESTS)
      .update({ ...patchToRow(d.patch), search_text: supplySearchText(after), version: before.version + 1 })
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('version', before.version)
      .select('*');
    throwIf(error, 'decide supply request');
    if (!data || !data.length) return { id, ok: false, code: 'stale' };
    return { id, ok: true, code: 'ok', before, request: toRequest(data[0]) };
  });
}

// A few compare-and-swap updates in flight at once: enough to make a full batch quick, few
// enough not to crowd the pooled connections every other route shares.
const DECIDE_CONCURRENCY = 8;
async function eachLimited(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

/**
 * 🔴 THE PER-LINE ACTS on ONE submitted order (S131: orders/fulfill and the driver's requests/deliver) —
 * a compare-and-swap on the `version` the caller read: an order that moved since is 'stale' (the
 * screen re-reads), never overwritten. The acts are lib/supplyFlow supplyFulfillPatch's (all land or
 * none does); `mayAct(act)` is the caller's who-may verdict per act kind (lib/supplies maySupplyDecide
 * — the driver delivers and does nothing else). Throws a SupplyRefusal with the act's own code:
 *   404 not_found · 403 not_yours · 409 stale · 409 not_submitted · 409 line_resolved ·
 *   400 bad_line / bad_act / bad_qty / bad_eta / bad_reason / no_acts / too_many
 * → { before, request, applied }
 */
const FULFILL_REFUSAL = {
  not_submitted: [409, 'This order is not with the supplier, so nothing can be delivered on it.'],
  line_resolved: [409, 'That item is already delivered or cancelled.'],
  bad_line: [400, 'That item is not on this order.'],
  bad_act: [400, 'That is not something an item can be marked.'],
  bad_qty: [400, 'Deliver between 1 and the number still to come.'],
  bad_eta: [400, 'Give the supplier’s date: today or later, within a year.'],
  bad_reason: [400, 'Give a reason of 3 to 300 characters.'],
  no_acts: [400, 'Say what happened to which item.'],
  too_many: [400, 'Too many changes at once.'],
};
export async function fulfillOrder({ id, version, acts, actorId = null, actorName = null, via = 'office', todayKey = null, now, mayAct }, db = getSupabase()) {
  const before = await getRequest(id, db);
  if (!before) throw new SupplyRefusal('That order no longer exists.', { status: 404, code: 'not_found' });
  const list = Array.isArray(acts) ? acts : [];
  if (typeof mayAct === 'function' && list.some((a) => !mayAct(a && a.act))) {
    throw new SupplyRefusal('You can’t make that change on this order.', { status: 403, code: 'not_yours' });
  }
  if (version !== null && version !== undefined && Number(version) !== Number(before.version)) {
    throw new SupplyRefusal('This order changed since you opened it. It now shows where it is.', { status: 409, code: 'stale' });
  }
  const p = supplyFulfillPatch(before, list, { byUserId: actorId, byName: actorName, via, now: now || new Date().toISOString(), todayKey });
  if (p.refused) {
    const [status, message] = FULFILL_REFUSAL[p.refused] || [400, 'That change can’t be made.'];
    throw new SupplyRefusal(message, { status, code: p.refused, ...(p.line !== undefined ? { line: p.line } : {}) });
  }
  const { data, error } = await db.from(T_REQUESTS)
    .update({ ...patchToRow(p.patch), version: before.version + 1 })
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('version', before.version)
    .select('*');
  throwIf(error, 'fulfil supply order');
  if (!data || !data.length) throw new SupplyRefusal('This order changed since you opened it. It now shows where it is.', { status: 409, code: 'stale' });
  return { before, request: toRequest(data[0]), applied: p.applied };
}

// ── an order's COMMENTS (S131: the office's notes, `supply_request_comments`) ───────────────────
const COMMENT_COLUMNS = 'id, request_id, author_user_id, author_role, author_name, body, created_at';
export const toComment = (row) => ({
  id: row.id, requestId: row.request_id, authorUserId: row.author_user_id || null, authorRole: row.author_role || null,
  authorName: row.author_name || null, body: row.body || '', createdAt: row.created_at || null,
});
// Every comment of one order, oldest first — complete (an order's notes are few; the read pages).
export async function listComments(requestId, db = getSupabase()) {
  if (!isSupplyId(requestId)) return [];
  const rows = await allRows(T_COMMENTS, { db, order: 'created_at', columns: COMMENT_COLUMNS, extra: (q) => q.eq('request_id', requestId) });
  return rows.map(toComment);
}
// ADD one. A caller-minted id (`src_…`): a retried add answers the comment that landed (if it is this
// order's — an id another order holds is 409 `id_taken`). The author is the CALLER (the claim), never
// the body. → { comment, created }
export async function addComment({ id, requestId, body, authorUserId = null, authorRole = null, authorName = null }, db = getSupabase()) {
  if (!isSupplyId(id)) throw new SupplyRefusal('A comment needs a caller-minted id.', { code: 'bad_id' });
  const f = supplyCommentBody(body);
  if (f.error) throw new SupplyRefusal(f.error === 'body_required' ? 'Write the comment first.' : 'Keep a comment under 1,000 characters.', { code: f.error });
  const order = await getRequest(requestId, db);
  if (!order) throw new SupplyRefusal('That order no longer exists.', { status: 404, code: 'not_found' });
  const res = await db.from(T_COMMENTS).insert({
    id, organization_id: CLEANSPACE_ORG_ID, request_id: requestId, author_user_id: authorUserId,
    author_role: authorRole, author_name: authorName, body: f.body,
  }).select(COMMENT_COLUMNS);
  if (res.error && res.error.code === '23505') {
    const { data } = await db.from(T_COMMENTS).select(COMMENT_COLUMNS).eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
    if (data && data.request_id === requestId) return { comment: toComment(data), created: false };
    throw new SupplyRefusal('That comment id is taken. Try again.', { status: 409, code: 'id_taken' });
  }
  throwIf(res.error, 'add supply order comment');
  return { comment: toComment(res.data[0]), created: true };
}

// ── a catalog item's PRODUCT IMAGE version (S131: POST catalog/image) ──────────────────────────
// A compare-and-swap on the item's `version` the caller read: `imageV` the new version (null = no
// image). The bytes are already stored under it (api/_lib/supplies/catalogImage.js); a CAS that misses
// is the route's to undo. → the item as it now stands, or null when it moved (or is gone).
export async function setCatalogImageVersion({ id, version, imageV }, db = getSupabase()) {
  const { data, error } = await db.from(T_CATALOG)
    .update({ image_v: imageV, version: Number(version) + 1 })
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('version', Number(version))
    .select(CATALOG_COLUMNS);
  throwIf(error, 'set supply catalog image');
  return data && data.length ? toCatalogItem(data[0]) : null;
}

// CANCEL = delete, of a request that has NOT gone out (CS-670: lib/supplies isSupplyCancellable —
// requested or approved), by a caller `mayCancel` admits (CS-596: lib/supplies maySupplyCancel),
// and only the version that was judged (CS-790). The delete is version-guarded AND counted: a request
// that moved between the read and the delete (an approval landing in between) deleted nothing, and is
// answered 409 'stale' — it used to answer ok, and the screen said "Request cancelled" over a request
// that lived on, approved. Returns { before }: the request as it stood, which is all the record keeps
// of it once it is gone (the route's activity row and bells read it).
export async function cancelRequest(id, { mayCancel } = {}, db = getSupabase()) {
  const before = await getRequest(id, db);
  if (!before) throw new SupplyRefusal('That request no longer exists.', { status: 404, code: 'not_found' });
  if (!isSupplyCancellable(before)) {
    throw new SupplyRefusal(before.status === SUPPLY_STATUS.rejected
      ? 'This request was rejected, so there is nothing to cancel. It stays in the history; the office can reopen it.'
      : 'This order has already gone out, so it can’t be cancelled. The office can reopen it to correct it.', { status: 409, code: 'not_cancellable' });
  }
  if (typeof mayCancel === 'function' && !mayCancel(before)) {
    throw new SupplyRefusal(before.status === SUPPLY_STATUS.requested
      ? 'You can cancel only your own requests, or any of a building you approve for.'
      : 'This request has already been approved, so only its approver or the office can cancel it.', { status: 403, code: 'not_yours' });
  }
  const { data, error } = await db.from(T_REQUESTS).delete()
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).eq('version', before.version)
    .select('id');
  throwIf(error, 'cancel supply request');
  if (!Array.isArray(data) || !data.length) {
    throw new SupplyRefusal('This request changed since you opened it, so it was not cancelled. Reload to see where it is now.', { status: 409, code: 'stale' });
  }
  return { before };
}

// 🔴 RETENTION AT THE WRITE POINT (II.8 / BUILD_INTEGRITY §5; SUP-13: 12 months). Every SETTLED
// order — completed or declined — settled before `cutoffIso` is deleted; an in-flight one
// (waiting / approved / submitted) is never touched, because the office still owes the building an
// order. Called by every order write, so the table is bounded by Matt's 12 months and nothing else.
// S131: an order takes its comments and invoice rows with it (on delete cascade), and its files and
// photos go too — `beforeDelete(ids)` runs first (the route reads the invoices' paths, which the
// cascade would take), `afterDelete(ids, whatBeforeReturned)` once the rows are gone (the route
// removes the invoice objects and the delivery photos). → how many orders went.
export async function pruneSettledRequests({ cutoffIso, beforeDelete = null, afterDelete = null }, db = getSupabase()) {
  if (!cutoffIso) return 0;
  const settled = async (status, col) => (await allRows(T_REQUESTS, {
    db, order: col, columns: 'id', extra: (q) => q.eq('status', status).lt(col, cutoffIso),
  })).map((r) => r.id);
  const targets = [
    [SUPPLY_STATUS.completed, 'completed_at', await settled(SUPPLY_STATUS.completed, 'completed_at')],
    [SUPPLY_STATUS.rejected, 'rejected_at', await settled(SUPPLY_STATUS.rejected, 'rejected_at')],
  ];
  const all = targets.flatMap(([, , ids]) => ids);
  if (!all.length) return 0;
  const ctx = typeof beforeDelete === 'function' ? await beforeDelete(all) : null;
  const gone = [];
  for (const [status, col, ids] of targets) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      // The status and the cutoff ride on the delete too: an order that moved since the read stays.
      const { data, error } = await db.from(T_REQUESTS).delete()
        .eq('organization_id', CLEANSPACE_ORG_ID).eq('status', status).lt(col, cutoffIso).in('id', ids.slice(i, i + ID_CHUNK))
        .select('id');
      throwIf(error, `prune ${status} supply orders`);
      gone.push(...(data || []).map((r) => r.id));
    }
  }
  if (gone.length && typeof afterDelete === 'function') await afterDelete(gone, ctx);
  return gone.length;
}

// (A deleted customer's supply rows were removed here, after the save. Customers are archived,
// never deleted — CS-663 — so an archived building keeps its supply history, and the supply
// walkers and the By building page leave it out through lib/supplies isSupplyBuilding.)

// ── rows from the app's shape (the manager-day seed, scripts/_lib/managerDaySeed.mjs) ────────
// The one-time move out of org_state that these began as (supplies-move.mjs, run 2026-10-05) is
// done and deleted; the seed writes the same rows. App shape (dollars) → table rows (cents).

// The catalog id migration 20261011100000's BACKFILL gives an item with this name, unit and price
// in this org: 'sc_bf_' + the first 24 hex of md5(org|lower(trim(name))|trim(unit)|cents) — the
// SQL's own formula, so the seed's catalog rows ARE the ones the backfill made from the seed's
// earlier rows, and a re-seed never adds a second "Paper towels" to the office's list. (The
// offline rehearsal of the migration checks the two give the same ids.)
export function supplyBackfillCatalogId(org, { name, unit, unitPriceCents }) {
  const key = `${org}|${String(name || '').trim().toLowerCase()}|${String(unit || '').trim()}|${unitPriceCents == null ? '' : unitPriceCents}`;
  return `sc_bf_${createHash('md5').update(key, 'utf8').digest('hex').slice(0, 24)}`;
}

// A catalog item → its supply_catalog row (the sanitizer the route uses).
export function catalogRowFromApp(it) {
  const f = supplyCatalogFields(it);
  if (f.error) throw new Error(`catalog item ${it && it.id}: ${f.error}`);
  return {
    id: it.id, organization_id: CLEANSPACE_ORG_ID, sku: f.fields.sku, name: f.fields.name,
    category: f.fields.category, unit: f.fields.unit, unit_price_cents: f.fields.unitPriceCents,
    created_at: it.createdAt || undefined, version: 1,
  };
}
// A building's switch → its supply_items row: the link alone (D5).
export function itemRowFromApp(it) {
  return {
    id: it.id, organization_id: CLEANSPACE_ORG_ID, client_id: it.clientId, catalog_item_id: it.catalogItemId,
    created_at: it.createdAt || undefined, version: 1,
  };
}
export function requestRowFromBlob(r, { nameOf = () => null } = {}) {
  const lines = linesToRow(r.lines);
  const app = {
    ...r,
    requestedByName: r.requestedByName || nameOf(r.requestedByUserId),
    approvedByName: r.approvedByName || nameOf(r.approvedByUserId),
    rejectedByName: r.rejectedByName || nameOf(r.rejectedByUserId),
    sentByName: r.sentByName || nameOf(r.sentByUserId),
    completedByName: r.completedByName || nameOf(r.completedByUserId),
  };
  const status = SUPPLY_STATUSES.includes(r.status) ? r.status : SUPPLY_STATUS.requested;
  // S131: a submitted or completed order carries who submitted it and when, and its per-line record
  // with its state (the migration's check keeps the two together); never sent quantities — the legacy
  // record is written only for a row that still carries one (whole: supply_requests_sent_record).
  // The order's NUMBER is left to the table's sequence.
  const legacy = Array.isArray(r.sentLines) ? {
    sent_lines: r.sentLines.map((s) => ({ itemId: s.itemId || null, catalogItemId: s.catalogItemId || null, qtySent: Math.max(0, Math.floor(Number(s.qtySent) || 0)) })),
    sent_total_cents: lines.reduce((a, l, i) => a + (Math.max(0, Math.floor(Number(r.sentLines[i] && r.sentLines[i].qtySent) || 0)) * (Number(l.unitPriceCents) || 0)), 0),
  } : { sent_lines: null, sent_total_cents: null };
  const fulfillment = normalizeSupplyFulfillment(r.fulfillment, r.lines || []);
  const sent = {
    sent_at: r.sentAt || null, sent_by_user_id: r.sentAt ? (r.sentByUserId || null) : null, sender_name: r.sentAt ? (app.sentByName || null) : null,
    ...(r.sentAt ? legacy : { sent_lines: null, sent_total_cents: null }),
    fulfillment,
    fulfillment_state: fulfillment ? supplyFulfillmentStateOf(r.lines || [], fulfillment) : null,
  };
  return {
    id: r.id, organization_id: CLEANSPACE_ORG_ID, client_id: r.clientId, status,
    note: text(r.note, 2000), lines, total_cents: supplyLinesTotalCents(lines),
    item_count: supplyRequestItemCount(r), search_text: supplySearchText(app),
    requested_by_user_id: r.requestedByUserId || null, requester_name: app.requestedByName || null,
    approved_at: r.approvedAt || null, approved_by_user_id: r.approvedByUserId || null, approver_name: app.approvedByName || null,
    rejected_at: status === SUPPLY_STATUS.rejected ? (r.rejectedAt || r.createdAt || null) : (r.rejectedAt || null),
    rejected_by_user_id: r.rejectedByUserId || null, rejecter_name: app.rejectedByName || null,
    rejection_reason: status === SUPPLY_STATUS.rejected ? (text(r.rejectionReason, 1000) || 'Rejected') : text(r.rejectionReason, 1000),
    ...sent,
    completed_at: status === SUPPLY_STATUS.completed ? (r.completedAt || r.createdAt || null) : (r.completedAt || null),
    completed_by_user_id: r.completedByUserId || null, completer_name: app.completedByName || null,
    created_at: r.createdAt || undefined, version: 1,
  };
}
