// The Supplies page holds together as a screen (the 2026-10-04 rebuild).
//
//   A. ITS CLASSES ARE ITS OWN. From 2026-09-19 to 2026-10-04 the queue's rows wore `.sup-row`,
//      a class the Supervised-customers card had already defined as `display: flex`, so every
//      request row became a flex box: the header no longer lined up with its cells (the first
//      <th> measured 1070px) and the table scrolled sideways at 1440px. Nothing failed, because
//      two blocks each owning "their" `.sup-*` is not a duplicate declaration of one rule. So:
//      the Supplies block of index.css has ONE class prefix (read from the block itself, never
//      restated here), and no rule outside that block — in any stylesheet, in any @media — may
//      use a class with that prefix; every prefixed class the Supplies screens use is defined in
//      the block; and no other screen uses the prefix.
//   B. THE SCREEN'S STRUCTURE (UI_RULES §1, §3, §72, §126, §132): every list table searches and
//      pages with the pager AFTER its frame, the bulk bar is always rendered and offers
//      "Select all N", and no control is recoloured by an inline style.
//
// Offline. Run: node scripts/test-supplies-page.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleRules } from './css-rules.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(APP, 'src');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n');

// The Supplies screens: the page, its usage view (shared with Reports → Supply usage), the
// request form (the order sheet, opened from the page and from a customer) and the customer's
// own Supplies tab (round 3, 2026-10-06). The Overview's budget card went into that tab. The
// master supply list (the Oct 6 call, plan 2026-10-11 §2) added the page's Catalog tab and a
// building's switches over it.
const MODULE_FILES = [
  'src/pages/Supplies.jsx',
  'src/pages/reports/SupplyUsageReport.jsx',
  'src/components/SupplyRequestModal.jsx',
  'src/components/ClientSupplies.jsx',
  'src/components/SupplyCatalog.jsx',
  'src/components/SupplyCatalogImport.jsx',
  'src/components/SupplyListSwitches.jsx',
  // the delivery step (plan 2026-10-12 §2): the driver's Deliveries page and the cleaner's supplies
  // line (the office's "Record sent" is deleted — S131, II.5)
  'src/pages/Deliveries.jsx',
  'src/components/CrewSupplyNote.jsx',
  // the supply orders (S131): the order queue (one implementation, on the page and the Supply
  // Manager's Home), its tiles, the decline form, the Home and one order's page
  'src/components/SupplyQueue.jsx',
  'src/components/SupplyQueueTiles.jsx',
  'src/components/SupplyDeclineModal.jsx',
  'src/pages/SupplyHome.jsx',
  'src/pages/SupplyOrder.jsx',
  // S131 Wave 2 (brief A): By building's "Awaiting your approval" cards
  'src/components/SupplyApprovalCards.jsx',
];
const has = (rel) => existsSync(path.join(APP, rel));

// ── A. the block, its prefix, and who else uses it ──────────────────────────────────────────
const indexCss = read('src/index.css');
const lines = indexCss.split('\n');
const startAt = lines.findIndex((l) => /^\/\* ── Supplies\b/.test(l));
ok('index.css has a Supplies block (a "/* ── Supplies" header)', startAt >= 0);
// The block runs to the next section header that is not about supplies.
let endAt = lines.length;
for (let i = startAt + 1; i < lines.length; i++) {
  if (/^\/\* ── /.test(lines[i]) && !/Supplies|SUP-/.test(lines[i])) { endAt = i; break; }
}
const blockText = lines.slice(Math.max(0, startAt), endAt).join('\n');
// Everything else, with the block blanked out line for line (so line numbers still read true).
const outsideText = lines.map((l, i) => (i >= startAt && i < endAt ? '' : l)).join('\n');

const classesOf = (sel) => [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
const blockRules = styleRules(blockText);
const blockClasses = new Set(blockRules.flatMap((r) => r.sels.flatMap(classesOf)));
// The block's prefix is the leading segment most of its classes share.
const prefixCounts = new Map();
for (const c of blockClasses) {
  const m = c.match(/^([a-z]+)-/);
  if (m) prefixCounts.set(m[1], (prefixCounts.get(m[1]) || 0) + 1);
}
const [prefixWord, prefixN] = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
const PREFIX = prefixWord ? `${prefixWord}-` : null;
ok(`the Supplies block's classes share one prefix (${PREFIX}: ${prefixN} of ${blockClasses.size})`, !!PREFIX && prefixN >= blockClasses.size * 0.6);
const owned = (c) => !!PREFIX && c.startsWith(PREFIX);

// A1: no rule outside the block, in any stylesheet, uses the prefix.
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = path.join(d, n);
  return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.css') ? [p] : []);
});
const clashes = [];
for (const file of walk(SRC)) {
  const rel = path.relative(APP, file).split(path.sep).join('/');
  const text = rel === 'src/index.css' ? outsideText : readFileSync(file, 'utf8');
  for (const r of styleRules(text)) {
    for (const sel of r.sels) {
      const hit = classesOf(sel).filter(owned);
      if (hit.length) clashes.push(`${rel}:${r.line} ${sel}`);
    }
  }
}
ok(`A1: no rule outside the Supplies block uses its ${PREFIX} prefix (${clashes.length}: ${clashes.slice(0, 6).join(' | ')}${clashes.length > 6 ? ' | …' : ''})`, clashes.length === 0);

// The class names a JSX file puts in className (a plain string, or a template's text and its
// quoted branches).
const jsxClasses = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\}|\{"([^"]*)"\})/g)) {
    const text = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    for (const t of text.match(/[a-zA-Z][\w-]*/g) || []) out.add(t);
  }
  return out;
};
// A2: every prefixed class a Supplies screen uses is defined in the block.
const undefinedHere = [];
for (const rel of MODULE_FILES.filter(has)) {
  for (const c of jsxClasses(read(rel))) if (owned(c) && !blockClasses.has(c)) undefinedHere.push(`${rel}: ${c}`);
}
ok(`A2: every ${PREFIX} class the Supplies screens use is defined in the block (missing: ${undefinedHere.join(', ') || 'none'})`, undefinedHere.length === 0);
// A3: no other screen wears the prefix.
const jsxWalk = (d) => readdirSync(d).flatMap((n) => {
  const p = path.join(d, n);
  return statSync(p).isDirectory() ? jsxWalk(p) : (/\.jsx?$/.test(n) ? [p] : []);
});
const borrowers = [];
for (const file of jsxWalk(SRC)) {
  const rel = path.relative(APP, file).split(path.sep).join('/');
  if (MODULE_FILES.includes(rel)) continue;
  const hit = [...jsxClasses(readFileSync(file, 'utf8'))].filter(owned);
  if (hit.length) borrowers.push(`${rel}: ${hit.join(' ')}`);
}
ok(`A3: no screen outside Supplies wears its ${PREFIX} classes (${borrowers.join(' | ') || 'none'})`, borrowers.length === 0);

// ── B. the screen's structure ───────────────────────────────────────────────────────────────
const page = read('src/pages/Supplies.jsx');
const usage = read('src/pages/reports/SupplyUsageReport.jsx');
// S131: the Requests tab IS the order queue — ONE component (components/SupplyQueue), read by the
// page and the Supply Manager's Home; its moves' toasts are one hook (hooks/useSupplyMoves).
const queue = has('src/components/SupplyQueue.jsx') ? read('src/components/SupplyQueue.jsx') : '';
const moves = has('src/hooks/useSupplyMoves.js') ? read('src/hooks/useSupplyMoves.js') : '';
const orderPage = has('src/pages/SupplyOrder.jsx') ? read('src/pages/SupplyOrder.jsx') : '';
// S131 Wave 2: who may decide or cancel an order, per order, for the queue and By building's cards —
// ONE hook over lib/supplies' rules (the queue's inline copy went, II.5).
const rulesHook = has('src/hooks/useSupplyRules.js') ? read('src/hooks/useSupplyRules.js') : '';
ok('B1: the Requests table searches (§72: TableSearch + useTableSearch, the page reset in the same update — CS-720)',
  /<SupplyQueue\b/.test(page) && /import TableSearch from '\.\/TableSearch'/.test(queue) && /useTableSearch\('q', \{ reset: \['page'\] \}\)/.test(queue));
ok('B2: the usage table searches too (§72)', /TableSearch/.test(usage) && /useTableSearch\('/.test(usage));
// Every <ListPager> sits AFTER its table's frame: the line before it closes a div.
const pagerLines = (src) => src.split('\n').map((l, i, all) => ({ l, prev: all.slice(0, i).reverse().find((x) => x.trim()) || '' }))
  .filter(({ l }) => /<ListPager\b/.test(l));
const misplaced = [...pagerLines(page), ...pagerLines(queue), ...pagerLines(read('src/pages/reports/reportKit.jsx'))].filter(({ prev }) => !/^\s*<\/div>\s*$/.test(prev));
ok(`B3: every pager follows its .table-wrap, never inside it (§72; misplaced: ${misplaced.length})`,
  pagerLines(page).length >= 1 && pagerLines(queue).length >= 1 && misplaced.length === 0);
ok('B4: the bulk bar is always rendered with an empty state (§3) and offers Select all N (§132)',
  /bulk-bar/.test(queue) && /is-empty/.test(queue) && /supplyPage\.selectAllN/.test(queue));
// SUP-13: the queue is a server read, so "one batched action" is ONE call carrying the ids (and the
// store is not written at all) — decide, or (S131) Submit to supplier.
ok('B5: bulk is ONE call over the selected ids (§132) — decide, or submit to the supplier',
  /moves\.run\(selectedRows, bulkDecision\)/.test(queue) && /suppliesApi\.decideRequests\(\{ ids, decision, reason \}/.test(moves)
  && /suppliesApi\.submitOrders\(\{ ids \}/.test(moves) && !/ACTIONS\.SUPPLY_/.test(page + queue));
ok('B6: no inline style recolours or places anything on the page, the queue or the order page (§126, §128)', !/style=\{\{/.test(page + queue + orderPage));
ok('B7: the status axis is tabs ABOVE the filter card, not a pill group inside it (§132)',
  !/<FormField label=\{t\('supplyPage\.status'\)\}/.test(page + queue) && /supply-status-tabs/.test(queue)
  && queue.indexOf('supply-status-tabs') < queue.indexOf('{filters}'));
// B8 moved with the list: C5 (the customer's Supplies tab edits an item, not only adds one).
// SUP-11: a row the viewer may not decide offers no Approve / Reject and is never selectable.
ok('B9: Approve/Decline and the row checkbox are gated per order by maySupplyDecide (SUP-11; S131: with the approver\'s operations manager — through the one rules hook)',
  /useSupplyRules\(\)/.test(queue) && /maySupplyDecide\(/.test(rulesHook) && /approverOpsManagerId: supplyApproverOpsManagerId\(/.test(rulesHook)
  && /mayApprove && </.test(queue) && /movable\(r\) && \(/.test(queue));
ok('B9b: the bulk bar and its "select to approve" hint show only when a row is this viewer\'s to decide (SUP-11)',
  /\{showChecks && \(\s*<div className=\{`bulk-bar/.test(queue) && !/\{bulkDecision && \(\s*<div className=\{`bulk-bar/.test(queue));
// SUP-13 / §131: nothing is queued on the phone, so offline is said and the controls are off.
ok('B10: offline is honest — the No-signal line and disabled controls (§131)', /supplyPage\.offline/.test(page) && /disabled=\{[^}]*!online/.test(page)
  && /disabled=\{[^}]*!online/.test(queue));

// ── C. Round 3 (Daniel, 2026-10-06): "Go with A; but the separate supply tab in the customer view
//    that B has. Wire it up." ────────────────────────────────────────────────────────────────
const tab = has('src/components/ClientSupplies.jsx') ? read('src/components/ClientSupplies.jsx') : '';
const form = has('src/components/SupplyRequestModal.jsx') ? read('src/components/SupplyRequestModal.jsx') : '';
const detail = read('src/pages/ClientDetail.jsx');
const registry = read('src/lib/masterSearch/registry.js');
const sweep = read('scripts/responsive-sweep.mjs');
// The page has two views now; the building's list lives with the building.
ok('C1: the Supplies page is Requests | Usage — the Approved items tab and its view are deleted (II.5)',
  !/key: 'approved'/.test(page) && !/function ApprovedView/.test(page) && !/supplyPage\.tab\.approved/.test(page) && !/function ItemModal/.test(page));
ok('C2: an old ?tab=approved link lands on Requests, or with cust= on that customer\'s Supplies tab',
  /rawTab [!=]== 'approved'/.test(page) && /\/clients\/\$\{[^}]+\}\?tab=supplies/.test(page));
ok('C3: the Overview\'s budget card is gone and deleted (replace means delete)',
  !/SupplyBudgetCard/.test(detail) && !has('src/components/SupplyBudgetCard.jsx'));
ok('C4: the customer page mounts its Supplies tab, gated on supplies.view',
  /<ClientSupplies\b/.test(detail) && /clientSectionKeys\(/.test(detail) && /supplies: canViewSupplies/.test(detail));
// The master list (plan 2026-10-11 §2, D4/D5): a building's list is its SWITCHES over the
// catalog. The add / edit / remove of a per-building copy, and the two routes behind them, are
// gone (II.5).
const switches = has('src/components/SupplyListSwitches.jsx') ? read('src/components/SupplyListSwitches.jsx') : '';
const catalogView = has('src/components/SupplyCatalog.jsx') ? read('src/components/SupplyCatalog.jsx') : '';
const adapter = read('src/lib/suppliesApi.js');
ok('C5: the tab\'s "Edit list" opens the building\'s switches, which save through ONE assign call — the per-building add / edit / remove is deleted (II.5)',
  /<SupplyListSwitches\b/.test(tab) && /suppliesApi\.assignItems\(/.test(switches)
  && !/saveItem|deleteItem|newSupplyItemId|items\/save|items\/delete/.test(tab + switches + adapter + page + form)
  && !/function ItemModal/.test(tab));
ok('C6: the tab\'s history comes from the server; its open requests from one complete building read',
  /history: true/.test(tab + detail) && /buildingRequests\(/.test(tab));
ok('C7: the tab writes the budget and order day the way the old card did (UPDATE_CLIENT_OPS, its own two fields)',
  /ACTIONS\.UPDATE_CLIENT_OPS/.test(tab) && /supplyBudgetMonthly:/.test(tab) && /supplyOrderDayOfMonth:/.test(tab));
ok('C8: the office-only controls are gated on supplies.manage (a supervisor reads the list)',
  /usePermission\('supplies\.manage'\)/.test(tab) && /canManage && /.test(tab));
ok('C9: ?edit=1 opens the switches once for the office, then the param is stripped (the old ?add=1 is gone)',
  /get\('edit'\)/.test(tab) && /delete\('edit'\)/.test(tab) && !/get\('add'\)/.test(tab) && !/[?&]add=1/.test(page + tab + form));
// The request form: the order sheet.
ok('C10: the request form is its own component, opened from the page and from the customer tab',
  /<SupplyRequestModal\b/.test(page) && /<SupplyRequestModal\b/.test(tab) && !/function RequestModal/.test(page));
ok('C11: what is already on order is matched by ITEM ID through the one pure helper — the "pending ×N" chip is gone',
  /supplyOnOrderByItem\(/.test(form) && !/pending\[it\.name\]/.test(form + page) && !/supplyPage\.form\.pending/.test(form + page));
ok('C12: the budget line is the one pure rule (cents inside), never re-derived on the screen',
  /supplyBudgetLine\(/.test(form) && /supplyOnOrderCents\(/.test(form));
ok('C13: the footer is pinned to the dialog\'s bottom (a sticky .supply-sheet-foot in the Supplies block)',
  /className="supply-sheet-foot"/.test(form) && /\.supply-sheet-foot\s*\{[^}]*position:\s*sticky/.test(blockText));
ok('C14: "Edit list" and "Set up the list" are the office\'s, and lead to the customer\'s Supplies tab',
  /canManage && /.test(form) && /onEditList\(/.test(form) && /onEditList=/.test(page));
ok('C15: the on-order total behind the budget line is a COMPLETE building read, not the queue\'s first page',
  /buildingRequests\(/.test(form) && !/listRequests\(/.test(form));
// Everything that pointed at the old tab moves with it.
ok('C16: global search no longer offers the Approved items tab', !/supplies\?tab=approved/.test(registry));
ok('C17: the responsive sweep covers the customer\'s Supplies tab instead of the deleted one',
  /\/clients\/cl_seed_evergreen\?tab=supplies/.test(sweep) && !/supplies\?tab=approved/.test(sweep));
ok('C17b: … and the Catalog tab and a building\'s open switches',
  /'\/supplies\?tab=catalog'/.test(sweep) && /\/clients\/cl_seed_evergreen\?tab=supplies&edit=1/.test(sweep));
// The tab list is one pure rule the page builds from the permissions.
let keys = null;
try { keys = (await import('../src/lib/clientSections.js')).clientSectionKeys; } catch { keys = null; }
ok('C18: clientSectionKeys — Supplies after Contract, before Activity, only for supplies.view',
  !!keys
  && JSON.stringify(keys({ contracts: true, supplies: true })) === JSON.stringify(['overview', 'access', 'contacts', 'contract', 'supplies', 'activity', 'notes'])
  && JSON.stringify(keys({ contracts: false, supplies: true })) === JSON.stringify(['overview', 'access', 'contacts', 'supplies', 'activity', 'notes'])
  && !keys({ contracts: true, supplies: false }).includes('supplies'));

// ── D. The master supply list (Matt, the Oct 6 call; plan 2026-10-11 §2) ──────────────────────
ok('D1: the Supplies page has a Catalog tab (?tab=catalog) that mounts the catalog view',
  /key: 'catalog'/.test(page) && /<SupplyCatalog\b/.test(page) && /rawTab === 'catalog'/.test(page));
ok('D2: the catalog is a server page of 20 — FilterSelect for the category and the search in a .filter-bar, the pager after its frame, cards on a phone (and a building\'s products, S131, paged the same way)',
  /className="filter-bar/.test(catalogView) && /<FilterSelect\b/.test(catalogView) && /<TableSearch\b/.test(catalogView)
  && /mobile-stack/.test(catalogView) && /<ListPager\b/.test(catalogView) && /suppliesApi\.listCatalog\(/.test(catalogView)
  && pagerLines(catalogView).length === 2 && pagerLines(catalogView).every(({ prev }) => /^\s*<\/div>\s*$/.test(prev)));
ok('D3: its columns are SKU · Item · Category · How it comes · Price · On N buildings',
  ['sku', 'item', 'category', 'howItComes', 'price', 'buildings'].every((c) => new RegExp(`supplyPage\\.catalog\\.col\\.${c}'`).test(catalogView)));
ok('D4: the office adds and edits in a kit Modal and deletes through a ConfirmDialog that names the building count; everyone else reads',
  /<Modal\b/.test(catalogView) && /<ConfirmDialog\b/.test(catalogView) && /supplyPage\.catalog\.deleteMessage'/.test(catalogView)
  && /buildings/.test(catalogView) && /usePermission\('supplies\.manage'\)/.test(catalogView)
  && /suppliesApi\.saveCatalogItem\(/.test(catalogView) && /suppliesApi\.deleteCatalogItem\(/.test(catalogView));
ok('D5: a SKU clash says which item holds it (the route\'s 409 names it)',
  /sku_taken/.test(catalogView) && /supplyPage\.catalog\.skuTaken'/.test(catalogView) && /holder/.test(catalogView));
ok('D6: the switches: the whole catalog, grouped by category with one master switch per group, a search and the count on',
  /suppliesApi\.listCatalog\(\{[^}]*all: true/.test(switches) && /groupSupplyByCategory\(/.test(switches)
  && (switches.match(/<Toggle\b/g) || []).length >= 2 && /<TableSearch\b/.test(switches) && /supplyPage\.switches\.countOn'/.test(switches));
ok('D7: the switches say what they are doing — saving, saved, failed with a retry — and stay off with no signal (§131)',
  /supplyPage\.switches\.saving'/.test(switches) && /supplyPage\.switches\.failed'/.test(switches)
  && /supplyPage\.switches\.retry'/.test(switches) && /disabled=\{[^}]*!online/.test(switches));
ok('D8: an empty catalog says so and sends the office to the Catalog tab',
  /supplyPage\.switches\.emptyCatalog'/.test(switches) && /to="\/supplies\?tab=catalog"/.test(switches));
ok('D9: the order sheet offers the building\'s switched-on items (its list, never the whole catalog), grouped by category, the SKU under the name',
  /suppliesApi\.listItems\(/.test(form) && !/listCatalog\(/.test(form) && /groupSupplyByCategory\(/.test(form) && /it\.sku/.test(form));
ok('D10: the read-only list shows each item\'s SKU', /it\.sku/.test(tab));

// ── E. The delivery step (Matt, SUP-16 a + SUP-17 a, 2026-10-12; plan 2026-10-12 §2) — since S131
//    the supply ORDERS (plan 2026-10-14 §1, §4): submit to the supplier, per line, then complete ─────
const deliveries = has('src/pages/Deliveries.jsx') ? read('src/pages/Deliveries.jsx') : '';
const note = has('src/components/CrewSupplyNote.jsx') ? read('src/components/CrewSupplyNote.jsx') : '';
const app = read('src/App.jsx');
const navData = read('src/lib/navData.js');
const lib = await import('../src/lib/supplies.js');
// The cleaner's day is the Cleaner Hub since brief A (2026-10-13): each stop's supplies line sits on My
// Stops Today (pages/crew/CrewStops), from the same ONE crew read.
const myDay = read('src/pages/crew/CrewStops.jsx');
const visit = read('src/components/CrewJobVisit.jsx');
ok('E1: the queue\'s tabs are Pending approval · New · With supplier · Partially fulfilled · Completed · Declined (S131), each a catalog word',
  JSON.stringify(lib.SUPPLY_QUEUE_TABS) === JSON.stringify(['open', 'approved', 'sent', 'partial', 'completed', 'rejected'])
  && /tabs = SUPPLY_QUEUE_TABS/.test(queue) && /t\(SUPPLY_QUEUE_TAB_KEYS\[s\]\)/.test(queue));
ok('E2: an approved order offers the Supply Manager "Submit to supplier" (the row and the order page) — "Record sent" and its modal are deleted (II.5)',
  /maySubmit && <button[^\n]*moves\.run\(\[r\], 'submit'\)/.test(queue) && /may\('submit'\)/.test(orderPage)
  && !has('src/components/SupplySendModal.jsx') && !/recordSent|sendRequests|SupplySendModal/.test(page + queue + adapter + orderPage));
ok('E3: the New tab\'s bulk bar is "Submit to supplier (N)", ONE submit call over the selected ids (§132)',
  /status === SUPPLY_STATUS\.approved && canManage \? 'submit'/.test(queue) && /supplyPage\.bulk\.submitN'/.test(queue) && /supplyPage\.bulk\.hintSubmit'/.test(queue));
ok('E4: the order page\'s per-line acts — Mark delivered (1..the rest, the rest by default, an optional photo), Backordered (the supplier\'s ETA), Cancel item (a reason) — each a kit Modal, ONE fulfil call on the version the page read',
  /suppliesApi\.fulfillOrder\(\{ id: order\.id, version: order\.version, acts \}/.test(orderPage)
  && /useState\(String\(line\.remaining\)\)/.test(orderPage) && /max=\{line\.remaining\}/.test(orderPage) && /uploadMedia\(photo,/.test(orderPage)
  && /type="date"/.test(orderPage) && /supplyEtaError\(/.test(orderPage) && /SUPPLY_CANCEL_REASON_MIN/.test(orderPage)
  && (orderPage.match(/<Modal\b/g) || []).length >= 3);
ok('🔴 E5: Mark Completed is held back until every line is resolved, its reason line saying how many and which (UI_RULES §168) — ONE complete call on the version read',
  /disabled=\{off \|\| !progress\.ready\}/.test(orderPage) && /supplyPage\.order\.lockedBackordered'/.test(orderPage) && /supplyPage\.order\.lockedOpen'/.test(orderPage)
  && /suppliesApi\.completeOrder\(\{ id: order\.id, version: order\.version \}/.test(orderPage));
const HISTORY_KINDS = ['requested', 'approved', 'declined', 'submitted', 'delivered', 'backordered', 'lineCancelled', 'comment', 'photo', 'invoice', 'completed'];
ok('E6: the order history is the ONE stored timeline (lib/supplies supplyOrderHistory), every kind worded',
  /supplyOrderHistory\(order, \{ comments: data\.comments, photos: data\.photos, invoices: data\.invoices \}\)/.test(orderPage)
  && HISTORY_KINDS.every((k) => new RegExp(`${k}: 'supplyPage\\.order\\.history\\.${k}'`).test(orderPage)));
// The driver's page (S4, per line since S131).
ok('E7: /deliveries is a route gated on supplies.deliver, in the nav and the phone menu for its holders',
  /path="deliveries" element=\{<RequirePerm perm="supplies\.deliver">/.test(app)
  && /to: '\/deliveries'[^}]*perm: 'supplies\.deliver'/.test(navData) && (navData.match(/'\/deliveries'/g) || []).length >= 2);
ok('E8: the Deliveries page reads the driver\'s list and marks a LINE — or "All delivered" — through the route on the version it read, behind ONE confirmation that names the building, with an optional photo',
  /suppliesApi\.deliveries\(/.test(deliveries) && /suppliesApi\.deliverRequests\(\{ id: r\.id, version: r\.version, lines: line \? \[line\.line\] : null \}/.test(deliveries)
  && /deliveries\.allDelivered'/.test(deliveries) && /<Modal\b/.test(deliveries) && /deliveries\.confirmTitle'/.test(deliveries) && /deliveries\.photo'/.test(deliveries));
ok('🔴 E9: the Deliveries page shows NO money — no price, total, budget or money formatter (S3/S4)',
  !!deliveries && !/money\(|unitPrice|supplyRequestTotal|supplyDeliveredTotal|useSupplyBudgets|supplyBudget|Cents/.test(deliveries));
ok('E10: it is phone first and honest — cards by building, the address, today\'s delivered, a search and a pager, offline said',
  /deliveries\.deliveredToday'/.test(deliveries) && /building\.address/.test(deliveries) && /<TableSearch\b/.test(deliveries)
  && /<ListPager\b/.test(deliveries) && /deliveries\.offline'/.test(deliveries) && /disabled=\{[^}]*!online/.test(deliveries));
// The cleaner's line (S6).
ok('E11: My Stops Today and the visit show the building\'s supplies line from ONE crew read',
  /<CrewSupplyNote\b/.test(myDay) && /<CrewSupplyNote\b/.test(visit) && /useOnsiteSupplies\(/.test(myDay) && /useOnsiteSupplies\(/.test(visit));
ok('🔴 E12: the cleaner\'s line carries names and quantities only — no money, never a full name it did not get',
  !!note && /crewSupply\.onTheWay'/.test(note) && /crewSupply\.lineDelivered'/.test(note) && /crewSupply\.lineBackordered'/.test(note)
  && !/money\(|unitPrice|Total|budget/.test(note));
let routes = [];
try { routes = (await import('./app-routes.mjs')).appRoutes(); } catch { routes = []; }
ok('E13: the responsive sweep covers the Deliveries page, the queue\'s With supplier / Partially fulfilled / New tabs, a building\'s catalog and the order pages (every App.jsx route)',
  routes.includes('/deliveries') && /'\/supplies\?status=sent'/.test(sweep) && /'\/supplies\?status=partial'/.test(sweep) && /'\/supplies\?status=approved'/.test(sweep)
  && /'\/supplies\?tab=catalog&cb=/.test(sweep) && routes.includes('/supplies/orders/sr_seed_prc-partial'));

// ── F. Cancel (CS-670 / CS-790, 2026-10-12) ───────────────────────────────────────────────────
// The rule (only while requested or approved) is lib/supplies maySupplyCancel, which the route also
// reads (test-supplies-approval.mjs, test-supplies-route.mjs §19); here, that the page offers
// Cancel through that rule alone and words every refusal the route can give.
const enCatalog = read('src/i18n/catalog/en.js');
const enLine = (key) => (enCatalog.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1] || '';
ok('F1: the row\'s Cancel and the order page\'s are offered by the shared rule only (never once it is with the supplier, completed or declined)',
  /const showCancel = rules\.mayCancel\(r\);/.test(queue) && /maySupplyCancel\(\{/.test(rulesHook) && !/maySupplyCancel/.test(queue)
  && /const canCancel = maySupplyCancel\(\{/.test(orderPage) && /\{canCancel && \(/.test(orderPage));
// 🔴 S131 Wave 2 (the cancel gap): cancelling a waiting order is deciding it, so every caller of the
// rule hands it what maySupplyDecide reads — supplies.approve and the approver's operations manager.
const cancelCall = (src) => { const i = src.indexOf('maySupplyCancel({'); return i < 0 ? '' : src.slice(i, src.indexOf('})', i)); };
ok('🔴 F5: the route, the demo stub, the rules hook and the order page each judge a cancel with supplies.approve and the approver\'s operations manager (S131: supplies.manage alone never cancels a waiting order)',
  [cancelCall(read('api/supplies/[...path].js')), cancelCall(read('src/lib/suppliesApi.js')), cancelCall(rulesHook), cancelCall(orderPage)]
    .every((c) => /holdsApprove/.test(c) && /approverOpsManagerId/.test(c)));
ok('🔴 F2: a refused cancel says why, in words: changed meanwhile (409 stale, CS-790), already gone out (409 not_cancellable, CS-670), gone, not yours',
  /stale: 'supplyPage\.toast\.cancelStale'/.test(queue) && /not_cancellable: 'supplyPage\.toast\.cancelGoneOut'/.test(queue)
  && /not_found: 'supplyPage\.toast\.cancelGone'/.test(queue) && /not_yours: 'supplyPage\.toast\.cancelRefused'/.test(queue)
  && ['supplyPage.toast.cancelStale', 'supplyPage.toast.cancelGoneOut', 'supplyPage.toast.cancelGone'].every((k) => !!enLine(k)));
ok('F3: … and a cancel that found the order moved or gone re-reads the queue, so the screen shows where it is now',
  /e\.status === 409 \|\| e\.status === 404/.test(queue));
ok('F4: the confirm says the cancel is told to the people waiting on it', /told/i.test(enLine('supplyPage.cancelMessage')), enLine('supplyPage.cancelMessage'));

// ── G. The supply orders' screens (S131, plan 2026-10-14 §4; Matt's boards sm-*) ──────────────────
const tiles = has('src/components/SupplyQueueTiles.jsx') ? read('src/components/SupplyQueueTiles.jsx') : '';
const home = has('src/pages/SupplyHome.jsx') ? read('src/pages/SupplyHome.jsx') : '';
const ops = read('src/pages/settings/Operations.jsx');
// A fresh page per order (KeyedByParam): the bell opens another order in place, and a reused page
// kept the comment typed for the last one (task #130).
ok('G1: /supplies/orders/:id is a route gated on supplies.view, a fresh page per order, its Back from the referrer (useBackTarget)',
  /path="supplies\/orders\/:id" element=\{<RequirePerm perm="supplies\.view"><KeyedByParam name="id"><SupplyOrder \/><\/KeyedByParam>/.test(app) && /useBackTarget\('\/supplies'\)/.test(orderPage) && /useParams\(\)/.test(orderPage));
ok('G2: a queue row opens its order page carrying the referrer, its number and its status in the office\'s words (supplyOrderLabelKey)',
  /navigate\(`\/supplies\/orders\/\$\{encodeURIComponent\(r\.id\)\}`, \{ state: nav \}\)/.test(queue) && /state=\{nav\}/.test(queue)
  && /supplyOrderNo\(r\)/.test(queue) && /supplyOrderLabelKey\(r, 'office'\)/.test(queue) && /supplyOrderVariant\(r\)/.test(queue));
ok('G3: the Supply Manager\'s four tiles (New orders · With supplier · Partially fulfilled · Completed today) are the queue\'s own counts, over the queue for supplies.manage holders',
  ['approved', 'sent', 'partial', 'completedToday'].every((k) => new RegExp(`n\\('${k}'\\)`).test(tiles))
  && ['new', 'supplier', 'partial', 'completedToday'].every((k) => tiles.includes(`'supplyPage.tiles.${k}'`)) && /canManage && <SupplyQueueTiles\b/.test(page));
ok('G4: the Supply Manager\'s Home: "Hey, {first}", the role line, the tiles and the ONE queue from approved onward (rendered: test-supply-home-render.mjs)',
  /supplyPage\.home\.greeting'/.test(home) && /roleLabel\(t, currentUser\?\.role\)/.test(home) && /<SupplyQueueTiles\b/.test(home)
  && /<SupplyQueue ctx=\{ctx\} tabs=\{SUPPLY_MANAGER_TABS\}/.test(home)
  && JSON.stringify(lib.SUPPLY_MANAGER_TABS) === JSON.stringify(['approved', 'sent', 'partial', 'completed']));
ok('G5: the order page says loading, an error with Try again, "not found", and No signal (§117, §131)',
  /common\.loading/.test(orderPage) && /supplyPage\.tryAgain'/.test(orderPage) && /supplyPage\.order\.gone'/.test(orderPage) && /supplyPage\.offline'/.test(orderPage)
  && /not found/i.test(enLine('supplyPage.order.gone')));
ok('G6: on Pending approval the page offers Approve / Decline to whoever may decide, and says whose it is to everyone else (§118)',
  /may\('approve'\) \?/.test(orderPage) && /supplyPage\.detail\.waitingOn'/.test(orderPage) && /<SupplyDeclineModal\b/.test(orderPage) && /<SupplyDeclineModal\b/.test(queue));
ok('G7: "Copy order" copies SKU · item · qty, one line each, and says if it could not',
  /navigator\.clipboard\.writeText\(/.test(orderPage) && /\[l\.sku, l\.name, l\.qty\]/.test(orderPage) && /supplyPage\.order\.copyFailed'/.test(orderPage));
ok('G8: a comment\'s and an invoice\'s id is minted ONCE and kept until it lands (a retry files one)',
  /if \(!draftId\.current\) draftId\.current = suppliesApi\.newSupplyCommentId\(\)/.test(orderPage)
  && /pending\.current = \{ file, docId: suppliesApi\.newSupplyDocumentId\(\) \}/.test(orderPage) && /suppliesApi\.uploadOrderInvoice\(/.test(orderPage));
ok('G9: delivery photos are the order\'s gallery (scope supply, images only, the supply keys add and remove, no caption editor)',
  /scope="supply"/.test(orderPage) && /canAdd=\{online && \(holds\.manage \|\| \(holds\.deliver && isSent\)\)\}/.test(orderPage) && /canRemove=\{holds\.manage\}/.test(orderPage)
  && /accept="image\/\*"/.test(orderPage) && /captions=\{false\}/.test(orderPage));
ok('🔴 G10: CS-798 — the order sheet mints its id ONCE and keeps it until it lands; a refusal the server named mints anew',
  /if \(!pendingId\.current\) pendingId\.current = suppliesApi\.newSupplyRequestId\(\)/.test(form) && /id: pendingId\.current/.test(form)
  && /pendingId\.current = null;\s*toast\.success/.test(form) && /if \(e && e\.status\) pendingId\.current = null/.test(form) && !/id: suppliesApi\.newSupplyRequestId\(\)/.test(form));
ok('G11: the Catalog per building (Matt\'s board): a building FilterSelect (?cb=), its products from its own list, "+ Add product" switching one on or creating one, the footer line, and a product photo shrunk on the device',
  /get\('cb'\)/.test(catalogView) && /suppliesApi\.listItems\(clientId\)/.test(catalogView) && /suppliesApi\.assignItems\(\{ clientId, on: \[c\.id\] \}\)/.test(catalogView)
  && /supplyPage\.catalog\.footer'/.test(catalogView) && /shrinkPhoto\(/.test(catalogView) && /suppliesApi\.uploadCatalogImage\(/.test(catalogView));
ok('G12: Settings → Operations names the approver for buildings with no account manager (S131)',
  /label="Approver for buildings with no account manager"/.test(ops) && !/Who approves supply requests/.test(ops));
// 🔴 G14 (S131 Wave 2, brief A): Decline asks for a REASON — a kit dialog with a textarea, at least
// SUPPLY_DECLINE_REASON_MIN characters (the write point's own number, lib/supplyFlow), said under the
// field — and it is the ONE dialog every decline opens: the queue, the order page, By building's cards.
const decline = has('src/components/SupplyDeclineModal.jsx') ? read('src/components/SupplyDeclineModal.jsx') : '';
const approvalCards = has('src/components/SupplyApprovalCards.jsx') ? read('src/components/SupplyApprovalCards.jsx') : '';
ok('🔴 G14: the decline dialog needs a reason of SUPPLY_DECLINE_REASON_MIN+ characters (its confirm off below it, the number in its words), and every decline opens it',
  /const valid = trimmed\.length >= SUPPLY_DECLINE_REASON_MIN;/.test(decline) && /disabled=\{!valid \|\| working\}/.test(decline)
  && /supplyPage\.rejectReasonShort', \{ min: SUPPLY_DECLINE_REASON_MIN \}/.test(decline) && /maxLength=\{SUPPLY_DECLINE_REASON_MAX\}/.test(decline)
  && /<textarea\b/.test(decline) && /<Modal\b/.test(decline)
  && [queue, orderPage, approvalCards].every((s) => /<SupplyDeclineModal\b/.test(s)));

// G13: a phone card's cell (§24) is a row: its label, then its children side by side. The queue's
// Items cell shipped its three lines — the items, the estimated cost, the note — loose in the <td>,
// so on a 390 phone they stood in three columns (S131, caught on the screenshots, not by the
// sweep: nothing overflowed). So every labelled cell of every Supplies screen holds ONE value: one
// element, one expression or one text — several lines go in one wrapper. Read from the parsed JSX
// (espree, eslint's own parser), comments ignored.
{
  const espree = await import('espree');
  const many = [];
  const walk = (n, file) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && n.openingElement.name.name === 'td'
      && n.openingElement.attributes.some((a) => a.type === 'JSXAttribute' && a.name && a.name.name === 'data-label')) {
      const kids = n.children.filter((k) => (k.type === 'JSXText' ? k.value.trim() !== ''
        : k.type === 'JSXExpressionContainer' ? k.expression.type !== 'JSXEmptyExpression' : true));
      if (kids.length > 1) many.push(`${file}:${n.loc.start.line} (${kids.length})`);
    }
    for (const [key, v] of Object.entries(n)) {
      if (key === 'loc' || key === 'range') continue;
      if (Array.isArray(v)) v.forEach((x) => walk(x, file));
      else if (v && typeof v.type === 'string') walk(v, file);
    }
  };
  let cells = 0;
  for (const rel of MODULE_FILES.filter(has)) {
    const src = read(rel);
    cells += (src.match(/<td\b[^>]*data-label=/g) || []).length;
    walk(espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true }), rel);
  }
  ok(`G13: every labelled cell of a Supplies table holds ONE value, so a phone card reads label → value (§24; ${cells} cells; several: ${many.join(' | ') || 'none'})`,
    cells > 0 && many.length === 0);
}

console.log(`\ntest-supplies-page: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
