// The supply catalog import's rules (src/lib/supplyCatalogImport.js) — task #257, Supplies → Catalog
// → Import items: "six columns starting with photo" (Photo · SKU · Item · Category · How it comes ·
// Price), "hundreds of items". Daniel's answers (2026-10-27): the Photo column is a picture in the
// cell or a link; a row whose SKU (or name, with no SKU) is already in the catalog UPDATES it —
// filled cells replace, blank cells leave, the preview lists every change.
//
//   A  the columns: the template's headers, and the names other spreadsheets use
//   B  prices as people type them
//   C  the dry run: new, update, unchanged, problem; matching SKU first, then name
//   D  file wins, blanks leave (in the plan, and again over the live row at the write)
//   E  the photo of a row: a picture in the Photo column, a picture on the row, a link, typed text
//   F  what the server is sent, and how it reads it back (batches, ids, versions)
//   G  the write over the live catalog: stale, gone, a SKU another item took, a retried create
//   H  the problems file (the formula guard kept)
//   I  hundreds of items: 500 rows, timed
//
//   node app/scripts/test-supply-catalog-import.mjs
import {
  CATALOG_IMPORT_BATCH, CATALOG_TEMPLATE_HEADERS, guessCatalogMapping, parseSupplyPrice, mergeCatalogImport,
  pickRowPhoto, planCatalogImport, catalogImportItems, catalogImportBatches, readCatalogImportBody,
  planCatalogImportWrite, catalogImportProblemsCsv,
} from '../src/lib/supplyCatalogImport.js';
import { gridTable } from '../src/lib/csv.js';

let passed = 0;
const failed = [];
function ok(label, cond, detail = '') {
  if (cond) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ''}`);
}
const section = (s) => console.log(`\n${s}`);
const keys = (list) => list.map((m) => m && m.$t);

// ── A the columns ─────────────────────────────────────────────────────────────────────────
section('A  the columns');
{
  const m = guessCatalogMapping(CATALOG_TEMPLATE_HEADERS);
  ok('A1 the template\'s six headers map to the six fields, in order', JSON.stringify(m) === JSON.stringify({ 0: 'photo', 1: 'sku', 2: 'name', 3: 'category', 4: 'unit', 5: 'price' }), JSON.stringify(m));
  const other = guessCatalogMapping(['Image URL', 'Item #', 'Product Description', 'Product Category', 'UOM', 'Unit Cost (USD)']);
  ok('A2 a supplier\'s price list maps too (Image URL, Item #, Product Description, UOM, Unit Cost (USD))', JSON.stringify(other) === JSON.stringify({ 0: 'photo', 1: 'sku', 2: 'name', 3: 'category', 4: 'unit', 5: 'price' }), JSON.stringify(other));
  const words = guessCatalogMapping(['Category Name', 'Name', 'Pack Size', 'Reference Number', 'Picture']);
  ok('A3 "Category Name" is the category, "Name" the item, "Pack Size" how it comes, "Reference Number" the SKU', words[0] === 'category' && words[1] === 'name' && words[2] === 'unit' && words[3] === 'sku' && words[4] === 'photo', JSON.stringify(words));
  const once = guessCatalogMapping(['Item', 'Item Name', 'Notes', '']);
  ok('A4 each field takes one column; an unknown or empty header is skipped', once[0] === 'name' && once[1] === undefined && once[2] === undefined && once[3] === undefined, JSON.stringify(once));
}

// ── B prices ──────────────────────────────────────────────────────────────────────────────
section('B  prices');
{
  const v = (s) => parseSupplyPrice(s);
  ok('B1 "$1,234.50", "12.5", "12,50", "USD 9", " 4 " read as prices', v('$1,234.50').value === 1234.5 && v('12.5').value === 12.5 && v('12,50').value === 12.5 && v('USD 9').value === 9 && v(' 4 ').value === 4);
  ok('B2 a blank price is no price (and fine)', v('').ok && v('').value === null && v(null).ok);
  ok('B3 words, a range, a negative are not prices', !v('call us').ok && !v('5-10').ok && !v('-3').ok && !v('1.2.3').ok && !v('12,5000').ok);
  const plan = planCatalogImport({ rows: [['Mop', '0'], ['Bucket', 'free']], mapping: { 0: 'name', 1: 'price' }, catalog: [], newId: (i) => `sc_new${i}` });
  ok('B4 a zero price or a word is a row problem (the catalog\'s rule: above zero, or blank)', plan.rows.every((r) => r.status === 'error' && keys(r.errors).includes('supplyImport.err.badPrice')), JSON.stringify(plan.rows.map((r) => keys(r.errors))));
}

// ── C the dry run ─────────────────────────────────────────────────────────────────────────
section('C  the dry run');
const CATALOG = [
  { id: 'sc_glass', sku: 'GC-100', name: 'Glass cleaner', category: 'Liquids', unit: 'Case of 12', unitPrice: 24, version: 3, imageV: 7 },
  { id: 'sc_mop', sku: null, name: 'Mop head', category: null, unit: null, unitPrice: null, version: 1 },
  { id: 'sc_bag1', sku: 'TB-1', name: 'Trash bags', category: 'Paper', unit: 'Roll', unitPrice: 9.5, version: 2 },
  { id: 'sc_bag2', sku: 'TB-2', name: 'Trash bags', category: 'Paper', unit: 'Box', unitPrice: 30, version: 2 },
];
const MAP = { 0: 'photo', 1: 'sku', 2: 'name', 3: 'category', 4: 'unit', 5: 'price' };
const ids = new Map();
const newId = (i) => { if (!ids.has(i)) ids.set(i, `sc_row${i}`); return ids.get(i); };
const rows = [
  ['', 'GC-100', '', '', '', '26.00'],                 // 0 SKU match: price only
  ['', 'gc-200', 'Floor polish', 'liquids', 'Gallon', '$41'], // 1 new, category as used
  ['', 'MH-9', 'Mop head', '', '', ''],                // 2 the SKU-less same-name item gains the SKU
  ['', '', 'Trash bags', '', '', '12'],                // 3 two items named so: a problem
  ['', 'GC-100', 'Glass cleaner', '', '', ''],         // 4 the same SKU as row 0: a problem
  ['', '', '', 'Paper', '', '4'],                      // 5 no name, no SKU: a problem
  ['', 'TB-1', 'Trash bags', 'Paper', 'Roll', '9.50'], // 6 everything as it is: unchanged
  ['', 'gc-200', 'Floor polish', '', '', ''],          // 7 the same SKU as row 1 (a new item): a problem
  ['', 'tb-2', '', '', '', ''],                        // 8 a SKU in another case: the one on file; unchanged
];
const plan = planCatalogImport({ rows, sheetRows: rows.map((_, i) => i + 1), mapping: MAP, catalog: CATALOG, newId });
const st = plan.rows.map((r) => r.status);
ok('C1 each row\'s status', JSON.stringify(st) === JSON.stringify(['update', 'create', 'update', 'error', 'error', 'error', 'unchanged', 'error', 'unchanged']), JSON.stringify(st));
ok('C2 "Row N" is the spreadsheet\'s own row number (the header is row 1)', plan.rows[0].line === 2 && plan.rows[8].line === 10);
ok('C3 a SKU match is that item, at the version the preview read', plan.rows[0].id === 'sc_glass' && plan.rows[0].version === 3);
ok('C4 the change is listed, from → to', keys(plan.rows[0].changes).join() === 'supplyImport.change.price' && plan.rows[0].changes[0].p.from === 24 && plan.rows[0].changes[0].p.to === 26, JSON.stringify(plan.rows[0].changes));
ok('C5 a new item gets the id newId gave its row', plan.rows[1].id === 'sc_row1' && plan.rows[1].version === null);
ok('C6 a category in another case joins the one in use', plan.rows[1].fields.category === 'Liquids' && plan.rows[1].set.category === 'Liquids', plan.rows[1].fields.category);
ok('C7 an item with that name and no SKU is matched, and gains the SKU', plan.rows[2].id === 'sc_mop' && plan.rows[2].fields.sku === 'MH-9' && keys(plan.rows[2].changes).includes('supplyImport.change.sku'));
ok('C8 two items with the name: "add the SKU to choose"', keys(plan.rows[3].errors).join() === 'supplyImport.err.ambiguousName');
ok('C9 a later row for the same item names the earlier row', keys(plan.rows[4].errors).join() === 'supplyImport.err.duplicate' && plan.rows[4].errors[0].p.row === 2, JSON.stringify(plan.rows[4].errors));
ok('C10 no name and no SKU is a problem', keys(plan.rows[5].errors).join() === 'supplyImport.err.nameRequired');
ok('C11 a row matching a NEW item an earlier row makes is a duplicate too', keys(plan.rows[7].errors).join() === 'supplyImport.err.duplicate' && plan.rows[7].errors[0].p.row === 3);
ok('C12 a SKU in another case is the item, kept as stored', plan.rows[8].id === 'sc_bag2' && plan.rows[8].fields.sku === 'TB-2' && plan.rows[8].changes.length === 0);
ok('C13 the totals', JSON.stringify(plan.counts) === JSON.stringify({ create: 1, update: 2, unchanged: 2, error: 4, warning: 0, photos: 0 }), JSON.stringify(plan.counts));
const again = planCatalogImport({ rows, sheetRows: rows.map((_, i) => i + 1), mapping: MAP, catalog: CATALOG, newId });
ok('C14 planned again, a new row keeps its id (a retried import is the same item)', again.rows[1].id === plan.rows[1].id);
{
  const p = planCatalogImport({ rows: [['A', 'x'.repeat(201)], ['B', 'Ok']], mapping: { 0: 'sku', 1: 'name' }, catalog: [], newId });
  ok('C15 a name over 200 characters is a problem in words', keys(p.rows[0].errors).join() === 'supplyImport.err.nameTooLong' && p.rows[1].status === 'create');
  const ws = planCatalogImport({ rows: [['  Glass   cleaner  ', '']], mapping: { 0: 'name', 1: 'sku' }, catalog: CATALOG, newId });
  ok('C16 a name matches whatever its case and spaces', ws.rows[0].id === 'sc_glass' && ws.rows[0].status === 'unchanged', JSON.stringify(ws.rows[0].status));
}

// ── D file wins, blanks leave ─────────────────────────────────────────────────────────────
section('D  file wins, blanks leave');
{
  const live = CATALOG[0];
  const m = mergeCatalogImport(live, { unitPrice: 30 });
  ok('D1 a blank cell leaves the item\'s value', m.fields.name === 'Glass cleaner' && m.fields.sku === 'GC-100' && m.fields.category === 'Liquids' && m.fields.unit === 'Case of 12' && m.fields.unitPriceCents === 3000, JSON.stringify(m));
  const w = mergeCatalogImport(live, { name: 'Glass cleaner XL', unit: 'Case of 6', sku: '  ', category: '' });
  ok('D2 a filled cell replaces; whitespace is blank', w.fields.name === 'Glass cleaner XL' && w.fields.unit === 'Case of 6' && w.fields.sku === 'GC-100' && w.fields.category === 'Liquids', JSON.stringify(w));
  const n = mergeCatalogImport(null, { name: 'New' });
  ok('D3 a new item is only what the file filled', n.fields.name === 'New' && n.fields.sku === null && n.fields.unitPriceCents === null);
  ok('D4 the plan sends only what the file filled', JSON.stringify(plan.rows[0].set) === JSON.stringify({ sku: 'GC-100', unitPrice: 26 }), JSON.stringify(plan.rows[0].set));
}

// ── E the photo of a row ──────────────────────────────────────────────────────────────────
section('E  the photo of a row');
{
  const pic = (row, col, type = 'image/png', source = 'cell') => ({ row, col, type, source, name: `p${row}${col}` });
  const a = pickRowPhoto({ sheetRow: 1, photoCol: 0, pictures: [pic(1, 0)] });
  ok('E1 a picture in the Photo cell is the photo', a.photo && a.photo.kind === 'picture' && a.warnings.length === 0);
  const b = pickRowPhoto({ sheetRow: 1, photoCol: 0, pictures: [pic(1, 2, 'image/jpeg', 'floating')] });
  ok('E2 a picture elsewhere on the row is the photo (a floating one a little off its column)', b.photo && b.photo.picture.col === 2);
  const c = pickRowPhoto({ sheetRow: 1, photoCol: 0, pictures: [pic(1, 3), pic(1, 0)] });
  ok('E3 two pictures: the Photo column\'s wins, with a note', c.photo.picture.col === 0 && keys(c.warnings).join() === 'supplyImport.warn.manyPicturesColumn');
  const d = pickRowPhoto({ sheetRow: 1, photoCol: 0, pictures: [pic(1, 0, 'image/x-emf')] });
  ok('E4 an EMF picture: no photo, and the words to paste it as JPG or PNG', d.photo === null && keys(d.warnings).join() === 'supplyImport.warn.photoUnreadable');
  const e = pickRowPhoto({ sheetRow: 1, photoCol: 0, links: [{ row: 1, col: 0, source: 'image-formula', url: 'https://x.example/a.png' }] });
  ok('E5 an IMAGE() link in the Photo cell is the photo', e.photo && e.photo.kind === 'link' && e.photo.url === 'https://x.example/a.png');
  const f = pickRowPhoto({ sheetRow: 1, photoCol: 0, photoText: 'https://x.example/typed.jpg' });
  ok('E6 an address typed in the Photo cell is the photo', f.photo && f.photo.url === 'https://x.example/typed.jpg');
  const g = pickRowPhoto({ sheetRow: 1, photoCol: 0, photoText: 'see attached' });
  ok('E7 other text in the Photo cell: no photo, with a note', g.photo === null && keys(g.warnings).join() === 'supplyImport.warn.photoText');
  const h = pickRowPhoto({ sheetRow: 1, photoCol: 0, links: [{ row: 1, col: 4, source: 'hyperlink', url: 'https://shop.example/item' }] });
  ok('E8 a hyperlink in another column is not the photo', h.photo === null);
  const i = pickRowPhoto({ sheetRow: 1, photoCol: 0, pictures: [pic(2, 0)] });
  ok('E9 a picture on another row is not this row\'s', i.photo === null);
  const withPhoto = planCatalogImport({ rows: [['', 'GC-100', '', '', '', '']], sheetRows: [1], mapping: MAP, pictures: [pic(1, 0)], catalog: CATALOG, newId });
  ok('E10 a photo for an item that has one reads "Replaces its photo", and counts', keys(withPhoto.rows[0].changes).join() === 'supplyImport.change.photoReplaced' && withPhoto.rows[0].status === 'update' && withPhoto.counts.photos === 1);
  const toMop = planCatalogImport({ rows: [['', '', 'Mop head', '', '', '']], sheetRows: [1], mapping: MAP, pictures: [pic(1, 0)], catalog: CATALOG, newId });
  ok('E11 … and "Adds its photo" for one that has none', keys(toMop.rows[0].changes).join() === 'supplyImport.change.photoAdded');
  // The table leaves empty columns out (csv.js gridTable); a picture's column follows.
  const t = gridTable([['', 'SKU', 'Item'], ['', 'A1', 'Mop'], ['', '', '']], { keepRow: (r) => r === 2 });
  ok('E12 a picture-only row stays in the table (keepRow), with its sheet row', t.rows.length === 2 && t.sheetRows.join() === '1,2', JSON.stringify(t));
}

// ── F what the server is sent ─────────────────────────────────────────────────────────────
section('F  what the server is sent');
{
  const items = catalogImportItems(plan);
  ok('F1 only new and updated rows are sent, in the file\'s order', items.map((x) => x.id).join() === 'sc_glass,sc_row1,sc_mop', items.map((x) => x.id).join());
  ok('F2 an update carries the version the preview read; a new one none', items[0].create === false && items[0].version === 3 && items[1].create === true && items[1].version === undefined);
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `sc_${i}`, create: true, set: { name: `x${i}` } }));
  const b = catalogImportBatches(many);
  ok(`F3 ${CATALOG_IMPORT_BATCH} a call`, b.length === 3 && b[0].length === 100 && b[2].length === 50);
  ok('F4 the server reads a batch back', readCatalogImportBody({ items: b[0] }).items?.length === 100);
  ok('F5 more than a batch is refused', readCatalogImportBody({ items: many }).error === 'too_many');
  ok('F6 an empty list, a bad id, a repeated id, an update with no version are refused', readCatalogImportBody({ items: [] }).error === 'bad_items'
    && readCatalogImportBody({ items: [{ id: '../x', create: true, set: {} }] }).error === 'bad_items'
    && readCatalogImportBody({ items: [{ id: 'a', create: true, set: {} }, { id: 'a', create: true, set: {} }] }).error === 'bad_items'
    && readCatalogImportBody({ items: [{ id: 'a', create: false, set: {} }] }).error === 'bad_items');
  const r = readCatalogImportBody({ items: [{ id: 'a', create: true, set: { name: 'Mop', sku: '', extra: 'x', unitPrice: '' } }] });
  ok('F7 blanks and unknown keys are dropped from what is set', JSON.stringify(r.items[0].set) === JSON.stringify({ name: 'Mop' }), JSON.stringify(r.items[0].set));
}

// ── G the write over the live catalog ─────────────────────────────────────────────────────
section('G  the write over the live catalog');
{
  const live = CATALOG.map((c) => ({ ...c }));
  const res = planCatalogImportWrite([
    { id: 'sc_glass', create: false, version: 3, set: { unitPrice: 26 } },
    { id: 'sc_mop', create: false, version: 9, set: { sku: 'MH-9' } },
    { id: 'sc_gone', create: false, version: 1, set: { name: 'x' } },
    { id: 'sc_new1', create: true, set: { name: 'Polish', sku: 'tb-1' } },
    { id: 'sc_bag1', create: true, set: { name: 'Trash bags' } },
    { id: 'sc_new2', create: true, set: { name: 'Gloves', sku: 'GL-1', category: 'paper' } },
    { id: 'sc_new3', create: true, set: { name: 'More gloves', sku: 'gl-1' } },
  ], live);
  const code = (i) => (res[i].ok ? (res[i].code || 'ok') : res[i].code);
  ok('G1 each item\'s answer', [0, 1, 2, 3, 4, 5, 6].map(code).join() === 'ok,stale,not_found,sku_taken,exists,ok,sku_taken', [0, 1, 2, 3, 4, 5, 6].map(code).join());
  ok('G2 an update merges over the LIVE row (blanks leave)', res[0].fields.name === 'Glass cleaner' && res[0].fields.unitPriceCents === 2600 && res[0].fields.unit === 'Case of 12');
  ok('G3 a SKU another item holds is named by that item', res[3].holder && res[3].holder.id === 'sc_bag1' && res[3].holder.name === 'Trash bags');
  ok('G4 a SKU an earlier item in the batch took is refused too', res[6].holder && res[6].holder.id === 'sc_new2');
  ok('G5 a category is stored as the one in use', res[5].fields.category === 'Paper');
  ok('G6 a create whose id already exists (a retried batch) is that item, not a second one', res[4].ok && res[4].code === 'exists' && res[4].before.id === 'sc_bag1');
  const swap = planCatalogImportWrite([
    { id: 'sc_bag1', create: false, version: 2, set: { sku: 'TB-9' } },
    { id: 'sc_new', create: true, set: { name: 'Roll bags', sku: 'TB-1' } },
  ], live);
  ok('G7 a SKU an item gives up earlier in the batch can be taken by a later one', swap[0].ok && swap[1].ok, JSON.stringify(swap.map((x) => x.code)));
}

// ── H the problems file ───────────────────────────────────────────────────────────────────
section('H  the problems file');
{
  const p = planCatalogImport({ rows: [['=HYPERLINK("http://x")', 'Mop'], ['', '']], sheetRows: [1, 2], mapping: { 0: 'sku', 1: 'name' }, catalog: [], newId });
  const outcomes = new Map([[2, [{ $t: 'supplyImport.photo.failed', p: {} }]]]);
  const csv = catalogImportProblemsCsv({ plan: p, headers: ['SKU', 'Item'], render: (m) => m.$t, outcomes });
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  ok('H1 the header row: Row, the file\'s columns, result, problem', lines[0] === '"supplyImport.csv.row","SKU","Item","supplyImport.csv.result","supplyImport.csv.problem"', lines[0]);
  ok('H2 a row that saved with something said after it is listed', lines.some((l) => l.startsWith('"2",') && l.includes('supplyImport.photo.failed') && l.includes('supplyImport.csv.withNote')), csv);
  ok('H3 a cell starting with = is defused (the CSV formula guard)', !/(^|,)"?=HYPERLINK/.test(csv) && /"'=HYPERLINK/.test(csv), lines[1]);
  ok('H4 the row with a problem says not imported, and why', lines.some((l) => l.startsWith('"3",') && l.includes('supplyImport.csv.notImported') && l.includes('supplyImport.err.nameRequired')), csv);
}

// ── I hundreds of items ───────────────────────────────────────────────────────────────────
section('I  hundreds of items');
{
  const big = Array.from({ length: 300 }, (_, i) => ({ id: `sc_live${i}`, sku: `SKU-${i}`, name: `Item ${i}`, category: `Cat ${i % 12}`, unit: 'Each', unitPrice: i + 1, version: 1 }));
  const fileRows = Array.from({ length: 500 }, (_, i) => ['', `SKU-${i}`, `Item ${i}`, `cat ${i % 12}`, 'Each', String(i + 1)]);
  const pictures = fileRows.map((_, i) => ({ row: i + 1, col: 0, type: 'image/png', source: 'cell', name: `image${i}.png` }));
  const t0 = performance.now();
  const p = planCatalogImport({ rows: fileRows, sheetRows: fileRows.map((_, i) => i + 1), mapping: MAP, pictures, catalog: big, newId: (i) => `sc_n${i}` });
  const ms = performance.now() - t0;
  ok('I1 500 rows against 300 items: 300 updates (their photos) and 200 new', p.counts.update === 300 && p.counts.create === 200 && p.counts.error === 0, JSON.stringify(p.counts));
  ok('I2 every row has its own picture', p.rows.every((r, i) => r.photo && r.photo.picture.name === `image${i}.png`));
  ok(`I3 planned in under a second (${ms.toFixed(0)} ms)`, ms < 1000);
  ok('I4 five calls of 100', catalogImportBatches(catalogImportItems(p)).length === 5);
}

console.log(`\ntest-supply-catalog-import: ${passed}/${passed + failed.length} passed`);
if (failed.length) {
  console.log(`\n✖ ${failed.length} failed:`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exitCode = 1;
}
