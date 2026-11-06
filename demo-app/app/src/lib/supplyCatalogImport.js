// THE SUPPLY CATALOG IMPORT (task 257, the "Live testing prep call" 2026-10-27): Supplies →
// Catalog → Import items brings a supplier's or the office's spreadsheet into the master list, one
// row per product, pictures included. Pure and node-safe: the screen (components/
// SupplyCatalogImport.jsx), the route (api/supplies catalog/import), the demo stub and the tests read
// these rules.
//
// THE SIX COLUMNS, in the order the template writes them (the call: "six columns starting with photo
// following the same order you have there on the catalog"): Photo · SKU · Item · Category · How it
// comes · Price. Headers are matched by name, forgivingly, so a supplier's own price list maps too.
//
// THE RULES (Daniel's answers, 2026-10-27):
//   · THE PHOTO is a picture placed in its cell in Excel (or floating over its row), or a web link
//     to one (an IMAGE() formula, a hyperlink, or the address typed in the cell). Pictures travel in
//     the file; a link is downloaded by the server (catalog/image-link) — never by the browser.
//   · A ROW FOR AN ITEM ALREADY IN THE CATALOG UPDATES IT FROM THE FILE: matched by its SKU, or — when
//     the row has no SKU, or no item holds it — by its name; filled cells replace that item's
//     values, blank cells leave them. Decided TWICE: here for the preview, and again by the server
//     against the live row at the write (mergeCatalogImport), so an empty cell never blanks a field.
//   · Every field keeps the catalog's own limits (lib/supplies supplyCatalogFields); a category
//     written in another case joins the label in use (supplyCategoryAsUsed).
//   · A dry run first (planCatalogImport writes nothing); new items get caller-minted ids, minted
//     once per preview, so a retried batch never makes a second item.
import { normalizeHeader } from './customerImport.js';
import { toCsvText } from './csv.js';
import { webLink, templateWorkbook, DRAWABLE_PICTURES } from './xlsx.js';
import {
  supplyCatalogFields, supplySkuKey, supplyCategoryAsUsed, supplyFromCents, SUPPLY_NAME_MAX,
} from './supplies.js';
import { msg } from '../i18n/core.js';

// The server takes at most this many items in one call (api/supplies catalog/import).
export const CATALOG_IMPORT_BATCH = 100;
// A file bigger than this is refused before it is read (pictures make an .xlsx big).
export const CATALOG_IMPORT_MAX_FILE_BYTES = 100 * 1024 * 1024;
// More rows than this is not a supply catalog; said, never cut short.
export const CATALOG_IMPORT_MAX_ROWS = 5000;

// The fields a column can be, each with its header aliases (normalized: lower case, "#" read as
// "number", punctuation as spaces — customerImport's normalizeHeader, the one rule).
export const CATALOG_IMPORT_FIELDS = Object.freeze([
  { key: 'photo', labelKey: 'supplyImport.field.photo', aliases: ['photo', 'photos', 'image', 'images', 'picture', 'pictures', 'pic', 'img', 'product image', 'product photo', 'image url', 'photo url', 'picture url', 'image link', 'photo link', 'image address'] },
  { key: 'sku', labelKey: 'supplyImport.field.sku', aliases: ['sku', 'sku number', 'item number', 'item no', 'ref', 'ref number', 'reference', 'reference number', 'product code', 'product number', 'part number', 'part no', 'catalog number', 'mfr number', 'manufacturer number', 'code'] },
  { key: 'name', labelKey: 'supplyImport.field.name', required: true, aliases: ['item', 'items', 'item name', 'name', 'product', 'product name', 'description', 'item description', 'product description'] },
  { key: 'category', labelKey: 'supplyImport.field.category', aliases: ['category', 'categories', 'type', 'group', 'department', 'product category'] },
  { key: 'unit', labelKey: 'supplyImport.field.unit', aliases: ['how it comes', 'unit', 'units', 'uom', 'unit of measure', 'pack', 'pack size', 'packaging', 'package', 'case pack', 'size'] },
  { key: 'price', labelKey: 'supplyImport.field.price', aliases: ['price', 'unit price', 'unit cost', 'cost', 'price each', 'cost each', 'price per unit', 'each price'] },
]);
export const CATALOG_IMPORT_KEYS = CATALOG_IMPORT_FIELDS.map((f) => f.key);
// The template's headers, in the call's order. i18n-ok: column names the import matches.
export const CATALOG_TEMPLATE_HEADERS = Object.freeze(['Photo', 'SKU', 'Item', 'Category', 'How it comes', 'Price']);

// Header → field, each field for ONE column (the first that fits): an exact alias first; then an
// alias whose every word is a word of the header ("Price (USD)" is the price, "Product Image URL"
// the photo), the longest such alias winning, then the one that starts the header ("Category Name"
// is the category, not the name).
export function guessCatalogMapping(headers) {
  const norm = (headers || []).map(normalizeHeader);
  const out = {};
  const taken = new Set();
  const take = (i, f) => { out[i] = f.key; taken.add(f.key); };
  norm.forEach((h, i) => {
    if (!h) return;
    const f = CATALOG_IMPORT_FIELDS.find((x) => !taken.has(x.key) && x.aliases.includes(h));
    if (f) take(i, f);
  });
  norm.forEach((h, i) => {
    if (out[i] || !h) return;
    const words = h.split(' ');
    const has = new Set(words);
    let best = null;
    for (const f of CATALOG_IMPORT_FIELDS) {
      if (taken.has(f.key)) continue;
      for (const a of f.aliases) {
        const aw = a.split(' ');
        if (!aw.every((w) => has.has(w))) continue;
        const score = aw.length * 10 + (aw[0] === words[0] ? 5 : 0);
        if (!best || score > best.score) best = { f, score };
      }
    }
    if (best) take(i, best.f);
  });
  return out;
}

// A price as people type it: "$1,234.50", "12.5", "12,50" (a decimal comma), "USD 9". Blank is no
// price. → { ok: true, value: dollars | null } | { ok: false }. Zero passes here and is refused by the
// catalog's own rule (above zero, or blank).
export function parseSupplyPrice(raw) {
  const s0 = String(raw ?? '').replace(/[\s\u00a0]+/g, '');
  if (!s0) return { ok: true, value: null };
  const s = s0.replace(/^(?:US\$|USD|\$)/i, '').replace(/(?:USD|\$)$/i, '');
  let n = null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = Number(s.replace(/,/g, ''));
  else if (/^\d+,\d{1,2}$/.test(s)) n = Number(s.replace(',', '.'));
  else if (/^(\d+(\.\d*)?|\.\d+)$/.test(s)) n = Number(s);
  return n !== null && Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
}

// One line of text, as the catalog stores it (supplyCatalogFields' rule), and its matching key.
const nameKey = (v) => {
  const f = supplyCatalogFields({ name: v });
  return f.fields ? f.fields.name.toLowerCase() : null;
};

// THE MERGE, the one rule for "filled cells replace, blank cells leave": `set` holds only what the
// file filled ({ sku, name, category, unit, unitPrice }); `live` is the item as stored (null for a
// new one). → supplyCatalogFields' answer for the item as it will be: { fields } | { error }.
export function mergeCatalogImport(live, set = {}) {
  const has = (k) => set[k] !== undefined && set[k] !== null && String(set[k]).trim() !== '';
  const pick = (k, liveValue) => (has(k) ? set[k] : liveValue);
  return supplyCatalogFields({
    sku: pick('sku', live ? live.sku : null),
    name: pick('name', live ? live.name : ''),
    category: pick('category', live ? live.category : null),
    unit: pick('unit', live ? live.unit : null),
    unitPrice: pick('unitPrice', live ? live.unitPrice : null),
  });
}

// A field-limit refusal's words (supplyCatalogFields' codes).
const FIELD_ERROR = {
  name_required: 'supplyImport.err.nameRequired',
  name_too_long: 'supplyImport.err.nameTooLong',
  sku_too_long: 'supplyImport.err.skuTooLong',
  category_too_long: 'supplyImport.err.categoryTooLong',
  unit_too_long: 'supplyImport.err.unitTooLong',
  bad_price: 'supplyImport.err.badPrice',
};
export const fieldErrorMessage = (code) => msg(FIELD_ERROR[code] || 'supplyImport.err.invalid');

// ── the photo of a row ─────────────────────────────────────────────────────────────────────
// `pictures` / `links` are readWorkbook's (by SHEET row and column). The row's photo, first that
// fits: a picture in the Photo column (a picture in the cell, then a floating one, then a web image
// or an IMAGE() link there); then a picture anywhere on the row (a floating picture a little off
// its column); then a hyperlink in the Photo cell; then an address typed in it.
// → { photo: { kind: 'picture', picture } | { kind: 'link', url } | null, warnings: [msg] }
const PICTURE_LINKS = new Set(['web-image', 'image-formula', 'floating']);
export function pickRowPhoto({ sheetRow, photoCol, photoText = '', pictures = [], links = [] }) {
  const warnings = [];
  const here = pictures.filter((p) => p.row === sheetRow);
  const linksHere = links.filter((l) => l.row === sheetRow);
  const inCol = (x) => photoCol !== undefined && photoCol !== null && x.col === photoCol;
  const asPicture = here.filter(inCol)[0] || here[0] || null;
  const pictureLink = linksHere.filter((l) => PICTURE_LINKS.has(l.source) && inCol(l))[0]
    || linksHere.filter((l) => PICTURE_LINKS.has(l.source))[0] || null;
  if (here.length > 1) warnings.push(msg(here.some(inCol) ? 'supplyImport.warn.manyPicturesColumn' : 'supplyImport.warn.manyPictures', { count: here.length }));
  if (asPicture && (!pictureLink || inCol(asPicture) || !inCol(pictureLink))) {
    if (!DRAWABLE_PICTURES.has(asPicture.type)) {
      warnings.push(msg('supplyImport.warn.photoUnreadable', { name: asPicture.name || '' }));
      return { photo: null, warnings };
    }
    return { photo: { kind: 'picture', picture: asPicture }, warnings };
  }
  if (pictureLink) return { photo: { kind: 'link', url: pictureLink.url }, warnings };
  const hyper = linksHere.find((l) => l.source === 'hyperlink' && inCol(l));
  if (hyper) return { photo: { kind: 'link', url: hyper.url }, warnings };
  const typed = webLink(photoText);
  if (typed) return { photo: { kind: 'link', url: typed }, warnings };
  if (String(photoText || '').trim()) warnings.push(msg('supplyImport.warn.photoText'));
  return { photo: null, warnings };
}

// ── the dry run ────────────────────────────────────────────────────────────────────────────
// `rows` are the data rows (string[] in the file's column order) and `sheetRows` each one's row in
// the sheet (0-based; a CSV's record number), for the pictures and the "Row N" a person reads;
// `mapping` is { [column]: fieldKey }; `catalog` the WHOLE catalog as it is now (app shape:
// { id, sku, name, category, unit, unitPrice, version }); `newId(rowIndex)` gives a new item's id —
// the same one for the same row on every re-plan, so a retried import is the same item.
// → { rows: [{ index, line, status: 'create' | 'update' | 'unchanged' | 'error', id, version,
//              label, sku, fields, set, changes, warnings, errors, photo, values }],
//     counts: { create, update, unchanged, error, warning, photos } }
export function planCatalogImport({ rows = [], sheetRows = [], mapping = {}, pictures = [], links = [], catalog = [], newId }) {
  const colOf = {};
  for (const [i, key] of Object.entries(mapping || {})) if (key && colOf[key] === undefined) colOf[key] = Number(i);
  const cell = (r, key) => (colOf[key] === undefined ? '' : String(r[colOf[key]] ?? '').trim());

  // The catalog as the plan goes: a new item planned by an earlier row is matchable by a later one.
  const bySku = new Map();
  const byName = new Map();
  const index = (it) => {
    const k = supplySkuKey(it.sku);
    if (k) bySku.set(k, it);
    const n = nameKey(it.name);
    if (n) byName.set(n, [...(byName.get(n) || []).filter((x) => x.id !== it.id), it]);
  };
  for (const it of catalog || []) if (it && it.id) index(it);
  const labelled = (catalog || []).filter((c) => c && c.category).map((c) => ({ id: c.id, category: c.category }));
  const touchedBy = new Map(); // item id → the line of the row that took it

  const out = [];
  rows.forEach((r, i) => {
    const sheetRow = Number.isInteger(sheetRows[i]) ? sheetRows[i] : i + 1;
    const line = sheetRow + 1;
    const errors = [];
    const raw = { sku: cell(r, 'sku'), name: cell(r, 'name'), category: cell(r, 'category'), unit: cell(r, 'unit') };
    const price = parseSupplyPrice(cell(r, 'price'));
    if (!price.ok) errors.push(msg('supplyImport.err.badPrice'));
    const { photo, warnings } = pickRowPhoto({ sheetRow, photoCol: colOf.photo, photoText: cell(r, 'photo'), pictures, links });

    // Which item this row is: its SKU's; else an item with its name and no SKU (which then takes
    // the SKU); a row with no SKU by its name alone; two items of that name is the person's to choose.
    const skuKey = supplySkuKey(raw.sku);
    const nKey = nameKey(raw.name);
    let target = null;
    if (skuKey) target = bySku.get(skuKey) || null;
    if (!target && nKey) {
      const named = (byName.get(nKey) || []).filter((it) => !skuKey || !supplySkuKey(it.sku));
      if (named.length > 1 && !skuKey) errors.push(msg('supplyImport.err.ambiguousName', { name: raw.name.slice(0, SUPPLY_NAME_MAX) }));
      else if (named.length === 1) [target] = named;
    }
    if (!skuKey && !nKey) errors.push(msg('supplyImport.err.nameRequired'));
    if (target && touchedBy.has(target.id)) errors.push(msg('supplyImport.err.duplicate', { row: touchedBy.get(target.id) }));

    const set = {};
    for (const k of ['sku', 'name', 'category', 'unit']) if (raw[k]) set[k] = raw[k];
    if (price.ok && price.value !== null) set.unitPrice = price.value;
    const merged = errors.length ? null : mergeCatalogImport(target, set);
    if (merged && merged.error) errors.push(fieldErrorMessage(merged.error));

    const base = { index: i, line, label: raw.name || (target ? target.name : ''), sku: raw.sku || (target ? target.sku || '' : ''), values: r, photo, warnings };
    if (errors.length) {
      out.push({ ...base, status: 'error', id: target ? target.id : null, version: target ? target.version : null, set, fields: null, changes: [], errors });
      return;
    }
    const id = target ? target.id : newId(i);
    const fields = { ...merged.fields, category: supplyCategoryAsUsed(labelled, { id, category: merged.fields.category }) };
    if (fields.category) labelled.push({ id, category: fields.category });
    if (fields.category && set.category) set.category = fields.category;

    const changes = [];
    if (target) {
      const was = { sku: target.sku || null, name: target.name || '', category: target.category || null, unit: target.unit || null, cents: target.unitPrice == null ? null : Math.round(Number(target.unitPrice) * 100) };
      if (supplySkuKey(was.sku) !== supplySkuKey(fields.sku)) changes.push(msg('supplyImport.change.sku', { from: was.sku || '—', to: fields.sku || '—' }));
      else if (fields.sku !== was.sku) { fields.sku = was.sku; delete set.sku; } // the same SKU in another case: kept as stored
      if (fields.name !== was.name) changes.push(msg('supplyImport.change.name', { from: was.name || '—', to: fields.name }));
      if ((fields.category || null) !== was.category) changes.push(msg('supplyImport.change.category', { from: was.category || '—', to: fields.category || '—' }));
      if ((fields.unit || null) !== was.unit) changes.push(msg('supplyImport.change.unit', { from: was.unit || '—', to: fields.unit || '—' }));
      if (fields.unitPriceCents !== was.cents) changes.push(msg('supplyImport.change.price', { from: supplyFromCents(was.cents) ?? 0, to: supplyFromCents(fields.unitPriceCents) ?? 0 }));
      if (photo) changes.push(msg(target.imageV || target.imageUrl ? 'supplyImport.change.photoReplaced' : 'supplyImport.change.photoAdded'));
    }
    const status = !target ? 'create' : (changes.length ? 'update' : 'unchanged');
    touchedBy.set(id, line);
    const planned = { id, sku: fields.sku, name: fields.name, category: fields.category, unit: fields.unit || '', unitPrice: supplyFromCents(fields.unitPriceCents), version: target ? target.version : 1 };
    index(planned);
    out.push({ ...base, label: fields.name, sku: fields.sku || '', status, id, version: target ? target.version ?? 1 : null, set, fields, changes, errors: [] });
  });

  const counts = { create: 0, update: 0, unchanged: 0, error: 0, warning: 0, photos: 0 };
  for (const r of out) {
    counts[r.status] += 1;
    if (r.warnings.length) counts.warning += 1;
    if (r.photo && r.status !== 'error') counts.photos += 1;
  }
  return { rows: out, counts };
}

// What the server is sent, in the file's order, CATALOG_IMPORT_BATCH a call: a new item with what
// the file filled; an update with what the file filled and the version the preview read (the server
// merges it over the LIVE row, and a row changed since is refused `stale`).
export function catalogImportItems(plan) {
  return (plan?.rows || []).filter((r) => r.status === 'create' || r.status === 'update').map((r) => (
    r.status === 'create'
      ? { id: r.id, create: true, set: r.set }
      : { id: r.id, create: false, version: r.version, set: r.set }
  ));
}
export function catalogImportBatches(items, size = CATALOG_IMPORT_BATCH) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The items one call may carry, as the server reads them: → { items } | { error: 'bad_items' |
// 'too_many' }. Each { id, create, version?, set: { sku?, name?, category?, unit?, unitPrice? } }.
export function readCatalogImportBody(body, { isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) } = {}) {
  const list = body && Array.isArray(body.items) ? body.items : null;
  if (!list || !list.length) return { error: 'bad_items' };
  if (list.length > CATALOG_IMPORT_BATCH) return { error: 'too_many' };
  const items = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || !isId(x.id) || seen.has(x.id) || typeof x.create !== 'boolean') return { error: 'bad_items' };
    seen.add(x.id);
    const s = x.set && typeof x.set === 'object' ? x.set : {};
    const set = {};
    for (const k of ['sku', 'name', 'category', 'unit']) if (typeof s[k] === 'string' && s[k].trim()) set[k] = s[k];
    if (s.unitPrice !== undefined && s.unitPrice !== null && s.unitPrice !== '') set.unitPrice = s.unitPrice;
    const version = x.create ? null : Number(x.version);
    if (!x.create && !(Number.isInteger(version) && version > 0)) return { error: 'bad_items' };
    items.push({ id: x.id, create: x.create, version, set });
  }
  return { items };
}

// THE WRITE PLAN, the server's (and the demo stub's) half of "decided twice": each asked item
// against the LIVE catalog and the batch's earlier items, in order. `live` is the whole catalog
// (app shape). → [{ id, create, ok, code?, holder?, before?, fields? }] where ok rows carry the
// fields to store (cents, the category as used) and an update its `before`.
export function planCatalogImportWrite(items, live) {
  const byId = new Map((live || []).map((c) => [c.id, c]));
  const skuHolder = new Map();
  for (const c of live || []) { const k = supplySkuKey(c.sku); if (k) skuHolder.set(k, c); }
  const labelled = (live || []).filter((c) => c.category).map((c) => ({ id: c.id, category: c.category }));
  return items.map((x) => {
    const before = byId.get(x.id) || null;
    if (x.create && before) return { id: x.id, create: true, ok: true, code: 'exists', before, fields: null };
    if (!x.create && !before) return { id: x.id, create: false, ok: false, code: 'not_found' };
    if (!x.create && before.version !== x.version) return { id: x.id, create: false, ok: false, code: 'stale', before };
    const merged = mergeCatalogImport(x.create ? null : before, x.set);
    if (merged.error) return { id: x.id, create: x.create, ok: false, code: merged.error };
    const k = supplySkuKey(merged.fields.sku);
    const holder = k ? skuHolder.get(k) : null;
    if (holder && holder.id !== x.id) {
      return { id: x.id, create: x.create, ok: false, code: 'sku_taken', holder: { id: holder.id, name: holder.name, sku: holder.sku || null } };
    }
    const category = supplyCategoryAsUsed(labelled, { id: x.id, category: merged.fields.category });
    if (category) labelled.push({ id: x.id, category });
    const fields = { ...merged.fields, category };
    // The same SKU in another case is the one on file.
    if (before && k && supplySkuKey(before.sku) === k) fields.sku = before.sku;
    const after = { id: x.id, sku: fields.sku, name: fields.name };
    if (before) { const was = supplySkuKey(before.sku); if (was && was !== k) skuHolder.delete(was); }
    if (k) skuHolder.set(k, after);
    return { id: x.id, create: x.create, ok: true, before, fields };
  });
}

// ── the files a person downloads ───────────────────────────────────────────────────────────
// The template: the six headers in the call's order, the SKU column formatted as Text (so "00123"
// keeps its zeros), the price as a number with cents, rows tall enough for a picture.
export function catalogTemplateXlsx() {
  return templateWorkbook({
    sheet: 'Supply catalog', // i18n-ok: the template's sheet name, a file the import reads
    rowHeight: 60,
    columns: [
      { header: CATALOG_TEMPLATE_HEADERS[0], width: 16 },
      { header: CATALOG_TEMPLATE_HEADERS[1], width: 14, text: true },
      { header: CATALOG_TEMPLATE_HEADERS[2], width: 40 },
      { header: CATALOG_TEMPLATE_HEADERS[3], width: 22 },
      { header: CATALOG_TEMPLATE_HEADERS[4], width: 18 },
      { header: CATALOG_TEMPLATE_HEADERS[5], width: 12, money: true },
    ],
  });
}

// The problems file: every row with a problem or a note, with what the file said and the words. A
// picture cannot travel in a CSV, so its cell reads empty. `outcomes` (after the import) adds what
// the server or the photo step said per row: Map line → [msg].
export function catalogImportProblemsCsv({ plan, headers = [], render, outcomes = new Map() }) {
  const say = (m) => (typeof render === 'function' ? render(m) : '');
  const out = [[say(msg('supplyImport.csv.row')), ...headers, say(msg('supplyImport.csv.result')), say(msg('supplyImport.csv.problem'))]];
  for (const r of plan?.rows || []) {
    const later = outcomes.get(r.line) || [];
    if (!r.errors.length && !r.warnings.length && !later.length) continue;
    const result = r.errors.length ? msg('supplyImport.csv.notImported') : msg('supplyImport.csv.withNote');
    out.push([String(r.line), ...headers.map((_, i) => r.values?.[i] ?? ''), say(result), [...r.errors, ...r.warnings, ...later].map(say).join(' ')]);
  }
  return toCsvText(out);
}
