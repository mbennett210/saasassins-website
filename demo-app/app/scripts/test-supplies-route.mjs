// /api/supplies/[...path] + the org-state route's retired-slice restore + the supply walker of the
// ops-alert cron, driven END TO END through the REAL handlers against fake-supabase.mjs (no
// network, no credentials, no live project — BUILD_INTEGRITY §6b). SUP-11 and SUP-13 (Matt,
// 2026-10-05); the master supply list (Matt, the Oct 6 call; plan 2026-10-11 §2).
//
// What it proves, in the order it matters:
//   1. every branch refuses an anonymous caller and a cleaner; each write needs its own key; the
//      replaced `items/save`, `items/delete` and `requests/send` are gone (II.5), and the queue's
//      read moved from GET requests to GET orders
//   2. 🔴 SUP-11 + S131: who may approve or decline, per order, through the route — the building's
//      account manager (A on A ✓, on B ✗), THAT manager's operations manager ✓ (another's ✗), the
//      owner / an admin holding supplies.approve ✓, the named org approver only for a building with
//      no account manager, a Supply Manager (supplies.manage, no supplies.approve) never, the
//      approver pared off supplies.approve ✗
//   3. the state machine's refusals, the frozen lines, a rejection's required reason
//   4. 🔴 the batched decide: ONE call, every partial NAMED (ok / not_yours / illegal_move /
//      not_found / stale — a CAS miss on `version`), and the bell rows + activity rows it writes
//   5. money is INTEGER CENTS in the catalog and dollars out of it (round-trip); a building's list
//      is READ THROUGH the catalog (D5: one source of truth, the switch rows hold only the link);
//      a request's lines are snapshotted from it with the SKU and the catalog item — never the
//      body's price
//   6. 🔴 retention at 12 months at the write point; in-flight requests are never dropped
//   7. usage: the 12-month window, the honest refusal before it; budgets: month-to-date in the
//      ORG's zone
//   8. 🔴 the org-state route puts a stale bundle's supply edits back, and a deleted customer's
//      supply rows go with it
//   9. the cron's supply walker reads the table (supplyAlertsFor)
//  11. the customer's Supplies tab reads: history per CATALOG item, every open request of one
//      building
//  12. GET buildings: every building's one state
//  13. 🔴 the catalog: SKU unique case-insensitively (409 naming the holder, the database's
//      23505 too), blank SKUs many times, a server page of 20 with its total, search, category,
//      `?all=1` complete past PostgREST's cap, "On N buildings", delete naming the count
//  14. 🔴 a building's switches: on / off answered per id, bounded, only switched-on items
//      orderable, and an item switched off and back on keeps its history (D6)
//  THE SUPPLY ORDERS (S131, plan docs/plans/2026-10-14-supply-orders.md; brief S):
//  15. 🔴 Submit to supplier (orders/submit): one order or many, each NAMED; no quantities — every
//      line starts pending; the requested total and the approval untouched; nobody rung; a reopen
//      clears it until something was delivered
//  16. 🔴 the per-line acts (orders/fulfill) and Mark Completed (orders/complete): deliver part or
//      all, backorder with the supplier's ETA, cancel with a reason — all land or none does, a CAS on
//      the version; completion only once every line is resolved; one bell per kind per person (the
//      asker and the account manager); usage and spend count each DELIVERY in its own month
//  17. 🔴 the driver PER LINE (GET deliveries, requests/deliver): a CREW login holding ONLY the
//      Deliveries grant lists what is still to come and marks lines delivered — `via: driver`, no
//      money anywhere — and may not backorder, cancel or complete, and is refused every other read
//  18. 🔴 the cleaner's read (GET onsite): only the buildings they clean TODAY, PER LINE (S131
//      Builder C) — what came today, what is backordered with its ETA, what is on the way — names
//      and quantities only
//  CANCEL (CS-670 / CS-790, 2026-10-12):
//  19. 🔴 Cancel only while requested or approved (a submitted or completed order is never deleted —
//      usage and spend keep it); every cancel writes an activity row and tells the requester and
//      the approver (the canceller skipped); a cancel whose delete matched nothing (an approval
//      landed in between) is a 409 'stale', never "cancelled"
//  20. the CLEANER asks for supplies (crew-list, requests/create): their buildings only, no money;
//      what they read back is their OWN orders (S131 Builder C)
//  21. 🔴 THE QUEUE (GET orders): the six tabs' counts and lists (a submitted order split by its
//      per-line state), the Supply Manager's tiles (completed TODAY in the org zone), search by an
//      order NUMBER ("SO-1003", "#1003", "1003"), "Select all" only on the two bulk tabs, the office
//      only (a crew login refused even holding supplies.view)
//  22. 🔴 ONE ORDER (GET order) and its COMMENTS (orders/comment): the order, each line's state,
//      who approves it; comments the office's, append-only, a caller-minted id, the author the claim
//  23. 🔴 THE INVOICE (orders/invoice/*): supplies.manage, PDF / JPEG / PNG ≤ 10 MB, the path built
//      on the server, a 300-second view link never cached, the object deleted before its row, at
//      most 20; the 12-month prune takes the files and the delivery photos with the order
//  24. 🔴 A PRODUCT IMAGE (catalog/image): the bytes checked, a new version per image, a CAS on the
//      item's version, the old object removed, links signed in one batch
//  25. 🔴 the cleaner asks for 1–20 of an item — the server's rule (400 qty_over_cap)
//  26. 🔴 an order's DELIVERY PHOTOS (account-media, scope `supply`): the supply keys, never a site
//  27. 🔴 the cleaner's OWN orders (S131 Builder C): one order (crew-order — their own at a building
//      they clean, the office any, every refusal the same 404), Home's light read (crew-orders), the
//      crew list's history (newest 10) and photo links, the office's View-as by supplies.view
//  30. 🔴 IMPORT ITEMS (catalog/import, task #257): supplies.manage only, a batch answered per item,
//      blanks leave over the live row, a retry adds nothing twice, a SKU clash named; A PICTURE BEHIND
//      A LINK (catalog/image-link): never a private, loopback or metadata address (checked at the
//      socket's lookup and on every redirect), a size cap, picture bytes only, a rate limit per login
//
//   node app/scripts/test-supplies-route.mjs
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { dayKey, startOfDayKey, startOfMonthKey, addDaysKey } = await import('../src/lib/dates.js');
const S = await import('../src/lib/supplies.js');
const handler = (await import('../api/supplies/[...path].js')).default;
const mediaRoute = (await import('../api/account-media/[...path].js')).default;
const orgStateRoute = (await import('../api/state/org-state.js')).default;
const { supplyAlertsFor } = await import('../api/cron/ops-alerts.js');

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — this repo's suites disagree, so it is stated.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 260)}`;
// A section that throws (a route missing on an older tree, a read of a row that never landed) is
// one named failure and the next section still runs, so every run says how much failed.
async function section(name, fn) {
  try { await fn(); } catch (e) { fails.push(`§${name} stopped: ${String(e && e.message || e).split('\n')[0]}`); }
}

// ── the world ───────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const NOW = Date.now();
const TODAY = dayKey(new Date(NOW), TZ);
const iso = (ms) => new Date(ms).toISOString();

const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },     // the office (supplies.manage)
  mgrA: { id: 'u_mgrA', role: 'manager', claim: false },    // supervises cl_A (claim-less, as live)
  mgrB: { id: 'u_mgrB', role: 'manager', claim: false },    // supervises cl_B
  crew: { id: 'u_crew', role: 'crew', claim: true },
  // SUP-17's "Alberto": a crew login; the Deliveries grant is given per section (overrides)
  driver: { id: 'u_driver', role: 'crew', claim: true, name: 'Alberto Reyes' },
  // S131's Supply Manager, as the matrix makes one: supplies.manage + supplies.deliver, never
  // supplies.approve (granted per section). A manager login stands in for the `supply_manager` role
  // Builder R adds to ROLES; the rule under test is the KEYS (lib/supplies maySupplyDecide).
  sm: { id: 'u_sm', role: 'manager', claim: true, name: 'Sam Supply' },
};
// The Supply Manager's keys, as a per-person override (see `sm` above).
const SM_KEYS = { userId: 'u_sm', grants: ['supplies.manage', 'supplies.deliver'], revokes: ['supplies.approve'] };
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: p.name || `${k} person`, notificationPrefs: {},
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const tok = (k) => `tok-${k}`;
// The matrix the Super Admin pares to for SUP-11 to bite: managers request and approve, only the
// office (owner + admin) holds supplies.manage. (With the DEFAULT matrix every manager holds
// supplies.manage, i.e. is "the office", and may decide any building's request.)
const matrix = () => seedPermissions().map((p) => (p.id === 'supplies.manage' ? { ...p, roles: ['owner', 'admin'] } : p));
const CLIENTS = [
  { id: 'cl_A', name: 'Alpha Tower', supervisorId: 'u_mgrA', supplyBudgetMonthly: 100, supplyOrderDayOfMonth: 1 },
  { id: 'cl_B', name: 'Beta Plaza', supervisorId: 'u_mgrB', supplyOrderDayOfMonth: 1 },
  { id: 'cl_C', name: 'Gamma Court', supervisorId: null, supplyOrderDayOfMonth: 1 },
];
const baseState = ({ overrides = [], opsSettings = {}, extra = {} } = {}) => ({
  users: roster.map((u) => ({ ...u })), permissions: matrix(), userPermissionOverrides: overrides,
  clients: CLIENTS.map((c) => ({ ...c })), company: { timezone: TZ }, opsSettings,
  notifications: [], opsAlertEvents: [], invoices: [], ...extra,
});
// The two UNIQUE indexes the master list rests on (migration 20261011100000), as the database
// enforces them: one SKU per org on lower(btrim(sku)) where given, and one switch per building
// and catalog item.
// S131 (migration 20261014120000): an order's number is the table's sequence, from 1001, unique per
// org; a comment's and an invoice's caller-minted id is its primary key.
const UNIQUE = {
  supply_catalog: [(r) => (r.sku == null || String(r.sku).trim() === '' ? null : `${r.organization_id}|${String(r.sku).trim().toLowerCase()}`)],
  supply_items: [(r) => (r.catalog_item_id == null ? null : `${r.organization_id}|${r.client_id}|${r.catalog_item_id}`)],
  supply_requests: [(r) => (r.number == null ? null : `${r.organization_id}|${r.number}`)],
  supply_request_comments: [(r) => r.id],
  supply_order_documents: [(r) => r.id],
};
const FIRST_ORDER_NUMBER = 1001;
function build(opts = {}, tables = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: baseState(opts), protected_fingerprint: null, updated_at: '2026-10-01T00:00:00.000Z' }],
      supply_catalog: [], supply_items: [], supply_requests: [], activity_log: [], activity_log_baseline: [],
      supply_request_comments: [], supply_order_documents: [], account_media: [],
      ...tables,
    },
    logins,
  });
  world.uniqueKeys = UNIQUE;
  let next = FIRST_ORDER_NUMBER;
  world.columnDefaults = { supply_requests: { number: () => { const n = next; next += 1; return n; } } };
}

async function call(h, { method = 'GET', path: p, token, body, query = {} }) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, ...(p ? { subpath: p } : {}) };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${p}: no response`)), 10000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(h(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const get = (p, who, query = {}) => call(handler, { path: p, token: who ? tok(who) : undefined, query });
const post = (p, who, body) => call(handler, { method: 'POST', path: p, token: who ? tok(who) : undefined, body });
const rowOf = (id) => world.tables.supply_requests.find((r) => r.id === id);
const bells = (key) => (world.tables.org_state[0].state.notifications || []).filter((n) => n.eventKey === key).map((n) => n.userId).sort();
// The building's switch row for a catalog item (the route mints its id).
const itemOf = (clientId, catalogItemId) => world.tables.supply_items.find((r) => r.client_id === clientId && r.catalog_item_id === catalogItemId)?.id || null;

// The master list, saved through the route (as the office), and two buildings switched on.
async function seedCatalog() {
  await post('catalog/save', 'admin', { id: 'sc_glass', sku: 'CL-1001', name: 'Glass cleaner', category: 'Liquids', unit: 'each', unitPrice: 6.79 });
  await post('catalog/save', 'admin', { id: 'sc_liner', sku: 'PP-2003', name: 'Trash liners', category: 'Paper, plastic & soap', unit: 'case', unitPrice: 32.9 });
  await post('catalog/save', 'admin', { id: 'sc_bulb', name: 'Bulbs', unit: '', unitPrice: null });
  await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_glass', 'sc_liner', 'sc_bulb'] });
  await post('items/assign', 'admin', { clientId: 'cl_B', on: ['sc_glass'] });
  return {
    A: { glass: itemOf('cl_A', 'sc_glass'), liner: itemOf('cl_A', 'sc_liner'), bulb: itemOf('cl_A', 'sc_bulb') },
    B: { glass: itemOf('cl_B', 'sc_glass') },
  };
}
const submit = (id, who, clientId, lines, note = '') => post('requests/create', who, { id, clientId, lines, note });
// S131's order doors, as the screens call them.
const toSupplier = (ids, who = 'admin') => post('orders/submit', who, { ids });
// One stored order read as lib/supplies reads it (its lines and per-line record are stored as is).
const progressOf = (id) => {
  const r = rowOf(id);
  return r ? S.supplyOrderProgress({ status: r.status, lines: r.lines, fulfillment: r.fulfillment }) : null;
};
const fulfill = (id, who, acts, version) => post('orders/fulfill', who, { id, version: version ?? rowOf(id)?.version, acts });
// Every line still to come, delivered in full (the Supply Manager's "Delivered" on each).
const deliverAll = (id, who = 'admin') => fulfill(id, who, (progressOf(id)?.lines || [])
  .filter((l) => l.remaining > 0).map((l) => ({ line: l.index, act: 'deliver' })));
const complete = (id, who = 'admin') => post('orders/complete', who, { id, version: rowOf(id)?.version });
// submit → approve → to the supplier → every line delivered → completed, as one story.
async function deliveredOrder(ids, approver = 'admin') {
  await post('requests/decide', approver, { ids, decision: 'approve' });
  await toSupplier(ids);
  for (const id of ids) { await deliverAll(id); await complete(id); }
}

// ── 1. the doors ─────────────────────────────────────────────────────────────
await section('1', async () => {
  build();
  // A cleaner holds `supplies.request` since the Cleaner Hub (D4, 2026-10-13): `requests/create`,
  // `requests/cancel` and `crew-list` take them past the door to their own rules — the building must
  // be one they clean, a cancel must be their own waiting request (§20). Every other door below
  // still refuses them.
  const doors = [['items', 'GET'], ['catalog', 'GET'], ['requests', 'GET'], ['usage', 'GET'], ['budgets', 'GET'],
    ['catalog/save', 'POST'], ['catalog/delete', 'POST'], ['catalog/image', 'POST'], ['items/assign', 'POST'],
    ['requests/decide', 'POST'],
    // the driver's list and Delivered (a cleaner holds no supplies.deliver)
    ['deliveries', 'GET'], ['requests/deliver', 'POST'],
    // S131: the orders — the queue, one order, its moves, its comments and its invoice
    ['orders', 'GET'], ['order', 'GET'], ['orders/submit', 'POST'], ['orders/fulfill', 'POST'], ['orders/complete', 'POST'],
    ['orders/comment', 'POST'], ['orders/invoice/upload-url', 'POST'], ['orders/invoice/confirm', 'POST'],
    ['orders/invoice/view-url', 'GET'], ['orders/invoice/delete', 'POST']];
  // (S131 Builder C: the cleaner's own orders — crew-order and crew-orders — are crew doors too, §27.)
  for (const [p, m] of [...doors, ['requests/create', 'POST'], ['requests/cancel', 'POST'], ['crew-list', 'GET'], ['crew-order', 'GET'], ['crew-orders', 'GET']]) {
    const anon = await call(handler, { method: m, path: p, query: { clientId: 'cl_A', building: 'cl_A', id: 'x' }, body: {} });
    ok(`anonymous ${m} ${p} → 401`, anon.status === 401, show(anon));
  }
  for (const [p, m] of doors) {
    const crew = await call(handler, { method: m, path: p, token: tok('crew'), query: { clientId: 'cl_A', building: 'cl_A', id: 'x' }, body: { id: 'x', name: 'X', clientId: 'cl_A', on: ['sc_x'], ids: ['x'], decision: 'approve', requestId: 'x', body: 'hi' } });
    ok(`🔴 a cleaner ${m} ${p} → 403`, crew.status === 403, show(crew));
  }
  for (const [p, body] of [['catalog/save', { id: 'sc_x', name: 'X' }], ['catalog/delete', { id: 'sc_x' }], ['catalog/image', { id: 'sc_x', remove: true }], ['items/assign', { clientId: 'cl_A', on: ['sc_x'] }]]) {
    const r = await post(p, 'mgrA', body);
    ok(`🔴 a manager without supplies.manage cannot ${p} (the master list, its images and the switches are the office's)`, r.status === 403, show(r));
  }
  // (orders/fulfill is past the door for a manager — the office tiers hold supplies.deliver by default,
  // S35 — and then a deliver only: §16.)
  for (const [p, body] of [['orders/submit', { ids: ['x'] }], ['orders/complete', { id: 'x' }],
    ['orders/invoice/upload-url', { requestId: 'x' }], ['orders/invoice/confirm', { requestId: 'x' }], ['orders/invoice/delete', { id: 'x' }]]) {
    const r = await post(p, 'mgrA', body);
    ok(`🔴 S131: a manager without supplies.manage cannot ${p} (the Supply Manager's)`, r.status === 403, show(r));
  }
  ok('… and nothing was written', world.tables.supply_catalog.length === 0 && world.tables.supply_items.length === 0);
  const read = await get('catalog', 'mgrA');
  ok('a manager READS the catalog (supplies.view)', read.status === 200 && Array.isArray(read.body.items), show(read));
  for (const gone of ['items/save', 'items/delete']) {
    const r = await post(gone, 'admin', { id: 'si_x', clientId: 'cl_A', name: 'X' });
    ok(`🔴 ${gone} is gone — replaced by the catalog and items/assign (II.5)`, r.status === 404, show(r));
  }
  const send = await post('requests/send', 'admin', { ids: ['x'], qtySent: [1] });
  ok('🔴 S131: requests/send ("how many went out") is gone — replaced by orders/submit and the per-line acts (II.5)', send.status === 404, show(send));
  const queue = await get('requests', 'admin', { status: 'open' });
  ok('🔴 S131: the queue no longer reads through GET requests (it is GET orders); GET requests names one building', queue.status === 400 && queue.body.code === 'building_required', show(queue));
});

// ── 5. money in cents, the list read through the catalog, the snapshot ───────
await section('5', async () => {
  build();
  const I = await seedCatalog();
  const glassRow = world.tables.supply_catalog.find((r) => r.id === 'sc_glass');
  ok('🔴 a catalog item\'s price is stored as INTEGER CENTS', glassRow && glassRow.unit_price_cents === 679 && !('unitPrice' in glassRow), JSON.stringify(glassRow));
  ok('"no price" is stored NULL, never 0 (SUP-4); a blank SKU and category are NULL',
    world.tables.supply_catalog.find((r) => r.id === 'sc_bulb')?.unit_price_cents === null
    && world.tables.supply_catalog.find((r) => r.id === 'sc_bulb')?.sku === null
    && world.tables.supply_catalog.find((r) => r.id === 'sc_bulb')?.category === null);
  ok('🔴 D5: a building\'s switch row holds only the link — no copy of the name, unit or price',
    world.tables.supply_items.length === 4 && world.tables.supply_items.every((r) => r.catalog_item_id
      && !('name' in r) && !('unit' in r) && !('unit_price_cents' in r)), JSON.stringify(world.tables.supply_items[0]));
  const list = await get('items', 'mgrA', { clientId: 'cl_A' });
  const glass = (list.body.items || []).find((x) => x.id === I.A.glass);
  ok('… and served back in dollars, READ THROUGH the catalog (SKU, category, the catalog item)', list.status === 200 && glass
    && glass.unitPrice === 6.79 && glass.sku === 'CL-1001' && glass.category === 'Liquids' && glass.catalogItemId === 'sc_glass'
    && glass.name === 'Glass cleaner' && glass.unit === 'each', show(list));
  ok('a building\'s list is ITS switches: Alpha has three, every one Alpha\'s', (list.body.items || []).every((x) => x.clientId === 'cl_A') && list.body.items.length === 3);
  const reads = world.log.filter((q) => q.table === 'supply_items' && q.op === 'select');
  ok('🔴 D5: no read of supply_items asks for the copied columns (the code works before and after they are dropped)',
    reads.length > 0 && reads.every((q) => q.cols !== '*' && !/\b(name|unit|unit_price_cents)\b/.test(q.cols)), JSON.stringify(reads.map((q) => q.cols)));
  const edit = await post('catalog/save', 'admin', { id: 'sc_glass', sku: 'CL-1001', name: 'Glass cleaner 32 oz', category: 'Liquids', unit: 'each', unitPrice: 7.1 });
  ok('a catalog item is edited in place by its id (version bumped)', edit.status === 200 && edit.body.created === false
    && world.tables.supply_catalog.find((r) => r.id === 'sc_glass').unit_price_cents === 710
    && world.tables.supply_catalog.find((r) => r.id === 'sc_glass').version === 2, show(edit));
  const bList = await get('items', 'mgrB', { clientId: 'cl_B' });
  ok('🔴 ONE source of truth: the edit reads on EVERY building that has the item', (bList.body.items || [])[0]?.name === 'Glass cleaner 32 oz'
    && bList.body.items[0].unitPrice === 7.1, show(bList));

  const r = await submit('sr_1', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 2, unitPrice: 0.01, name: 'FREE', sku: 'HACK' }, { itemId: I.A.bulb, qty: 1 }]);
  const row = rowOf('sr_1');
  ok('a request is submitted (supplies.request) and stored as REQUESTED (open)', r.status === 200 && r.body.created === true && row?.status === 'open', show(r));
  ok('🔴 its lines are SNAPSHOTTED from the building\'s list in cents, with the SKU and the catalog item — the body\'s price, name and SKU are ignored',
    row && JSON.stringify(row.lines) === JSON.stringify([
      { itemId: I.A.glass, catalogItemId: 'sc_glass', sku: 'CL-1001', name: 'Glass cleaner 32 oz', qty: 2, unitPriceCents: 710 },
      { itemId: I.A.bulb, catalogItemId: 'sc_bulb', sku: null, name: 'Bulbs', qty: 1, unitPriceCents: null },
    ]), JSON.stringify(row?.lines));
  ok('… with its cents total and the requester\'s NAME stamped at the act', row?.total_cents === 1420 && row?.requester_name === 'mgrB person' && row?.requested_by_user_id === 'u_mgrB');
  ok('… and served back in dollars, the SKU beside the name', r.body.request?.lines?.[0]?.unitPrice === 7.1 && r.body.request?.lines?.[1]?.unitPrice === null
    && r.body.request?.lines?.[0]?.sku === 'CL-1001' && r.body.request?.lines?.[0]?.catalogItemId === 'sc_glass');
  ok('… and a request can be found by its SKU', /cl-1001/.test(row?.search_text || ''), row?.search_text);
  ok('SUP-9: the building\'s APPROVER is rung — not the whole office', JSON.stringify(bells('supplyRequestSubmitted')) === JSON.stringify(['u_mgrA']), JSON.stringify(bells('supplyRequestSubmitted')));
  const again = await submit('sr_1', 'mgrB', 'cl_A', [{ itemId: I.A.liner, qty: 9 }]);
  ok('🔴 a retried submit (same id) creates nothing and changes nothing — the lines stay frozen',
    again.status === 200 && again.body.created === false && world.tables.supply_requests.length === 1 && rowOf('sr_1').lines.length === 2, show(again));
  const foreign = await submit('sr_2', 'mgrB', 'cl_A', [{ itemId: I.B.glass, qty: 1 }]);
  ok('an item from ANOTHER building\'s list is refused by name', foreign.status === 409 && foreign.body.code === 'unknown_item' && foreign.body.itemId === I.B.glass, show(foreign));
  const none = await submit('sr_3', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 0 }]);
  ok('a request with nothing on it is refused', none.status === 400 && none.body.code === 'no_lines', show(none));
  const ghost = await submit('sr_4', 'mgrB', 'cl_nope', [{ itemId: I.A.glass, qty: 1 }]);
  ok('a request for a building that does not exist is refused', ghost.status === 400 && ghost.body.code === 'unknown_client', show(ghost));
});

// ── 2. 🔴 SUP-11: who may approve, through the route ──────────────────────────
await section('2', async () => {
  build();
  const I = await seedCatalog();
  await submit('sr_a1', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('sr_a2', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('sr_b1', 'admin', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  const asB = await post('requests/decide', 'mgrB', { ids: ['sr_a1'], decision: 'approve' });
  ok('🔴 SUP-11: the supervisor of B CANNOT approve A\'s request (not_yours, nothing moves)',
    asB.status === 200 && asB.body.results[0].code === 'not_yours' && rowOf('sr_a1').status === 'open', show(asB));
  const asA = await post('requests/decide', 'mgrA', { ids: ['sr_a1'], decision: 'approve' });
  ok('SUP-11: the supervisor of A CAN approve A\'s request', asA.body.results?.[0]?.ok === true && rowOf('sr_a1').status === 'approved'
    && rowOf('sr_a1').approver_name === 'mgrA person', show(asA));
  const office = await post('requests/decide', 'admin', { ids: ['sr_b1'], decision: 'approve' });
  ok('SUP-11: the office (an admin holding supplies.approve) steps in on any building', office.body.results?.[0]?.ok === true && rowOf('sr_b1').status === 'approved', show(office));
  const fillByA = await toSupplier(['sr_a1'], 'mgrA');
  ok('the approver may not SUBMIT it to the supplier — that is the Supply Manager\'s (supplies.manage)', fillByA.status === 403 && rowOf('sr_a1').status === 'approved', show(fillByA));

  // 🔴 S131: the account manager comes FIRST; the named org approver (SUP-9) answers only for a
  // building with no account manager.
  world.tables.supply_items.push({ id: 'si_c_glass', organization_id: ORG, client_id: 'cl_C', catalog_item_id: 'sc_glass', version: 1 });
  await submit('sr_c1', 'admin', 'cl_C', [{ itemId: 'si_c_glass', qty: 1 }]);
  world.tables.org_state[0].state.opsSettings = { supplyApproverUserId: 'u_mgrB' };
  const namedOnA = await post('requests/decide', 'mgrB', { ids: ['sr_a2'], decision: 'approve' });
  ok('🔴 S131: the named approver does NOT approve a building that has an account manager (not_yours)', namedOnA.body.results?.[0]?.code === 'not_yours' && rowOf('sr_a2').status === 'open', show(namedOnA));
  const namedOnC = await post('requests/decide', 'mgrB', { ids: ['sr_c1'], decision: 'approve' });
  ok('🔴 S131: … and approves the building with no account manager ("Approver for buildings with no account manager")', namedOnC.body.results?.[0]?.ok === true && rowOf('sr_c1')?.status === 'approved', show(namedOnC));
  await submit('sr_a3', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  const supNow = await post('requests/decide', 'mgrA', { ids: ['sr_a3'], decision: 'approve' });
  ok('🔴 S131: with a named approver the account manager is STILL the building\'s approver', supNow.body.results?.[0]?.ok === true, show(supNow));
  world.tables.org_state[0].state.opsSettings = {};

  // 🔴 S131: the account manager's OPERATIONS MANAGER approves for them (users[].opsManagerId) —
  // only theirs: mgrB is mgrA's operations manager, not the other way round.
  world.tables.org_state[0].state.users = world.tables.org_state[0].state.users.map((u) => (u.id === 'u_mgrA' ? { ...u, opsManagerId: 'u_mgrB' } : u));
  const asOm = await post('requests/decide', 'mgrB', { ids: ['sr_a2'], decision: 'approve' });
  ok('🔴 S131: the account manager\'s operations manager CAN approve their building\'s order', asOm.body.results?.[0]?.ok === true
    && rowOf('sr_a2').status === 'approved' && rowOf('sr_a2').approver_name === 'mgrB person', show(asOm));
  await submit('sr_b2', 'admin', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  const notOm = await post('requests/decide', 'mgrA', { ids: ['sr_b2'], decision: 'approve' });
  ok('🔴 S131: … and nobody else\'s (mgrA is not mgrB\'s operations manager)', notOm.body.results?.[0]?.code === 'not_yours' && rowOf('sr_b2').status === 'open', show(notOm));
  await submit('sr_a4', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  world.tables.org_state[0].state.users = world.tables.org_state[0].state.users.map((u) => (u.id === 'u_mgrA' ? { ...u, opsManagerId: 'u_crew' } : u));
  const crewOm = await post('requests/decide', 'mgrB', { ids: ['sr_a4'], decision: 'approve' });
  ok('S131: an operations manager who is not a manager is no operations manager (the link is ignored)', crewOm.body.results?.[0]?.code === 'not_yours', show(crewOm));
  const reject = await post('requests/decide', 'mgrB', { ids: ['sr_a4'], decision: 'reject', reason: 'No' });
  ok('… the same rule decides a decline', reject.body.results?.[0]?.code === 'not_yours' && rowOf('sr_a4').status === 'open', show(reject));

  // 🔴 S131: the SUPPLY MANAGER holds supplies.manage and NOT supplies.approve: past the door (they
  // reopen), never an approval — and the owner or an admin pared off supplies.approve neither.
  build({ overrides: [SM_KEYS, { userId: 'u_admin', grants: [], revokes: ['supplies.approve'] }] });
  const M = await seedCatalog();
  await submit('sr_m', 'mgrA', 'cl_A', [{ itemId: M.A.glass, qty: 1 }]);
  for (const who of ['sm', 'admin']) {
    const r = await post('requests/decide', who, { ids: ['sr_m'], decision: 'approve' });
    ok(`🔴 S131: ${who === 'sm' ? 'the Supply Manager' : 'an admin pared off supplies.approve'} CANNOT approve (supplies.manage alone never approves — not_yours)`,
      r.status === 200 && r.body.results?.[0]?.code === 'not_yours' && rowOf('sr_m').status === 'open', show(r));
  }
  const declineSm = await post('requests/decide', 'sm', { ids: ['sr_m'], decision: 'reject', reason: 'Too many' });
  ok('🔴 S131: … nor decline', declineSm.body.results?.[0]?.code === 'not_yours' && rowOf('sr_m').status === 'open', show(declineSm));
  const owner = await post('requests/decide', 'owner', { ids: ['sr_m'], decision: 'approve' });
  ok('S131: the owner holding supplies.approve approves any building', owner.body.results?.[0]?.ok === true && rowOf('sr_m').status === 'approved', show(owner));
  const smSubmits = await toSupplier(['sr_m'], 'sm');
  ok('S131: … and the Supply Manager submits it to the supplier', smSubmits.status === 200 && smSubmits.body.results?.[0]?.ok === true && rowOf('sr_m').status === 'sent', show(smSubmits));
  const smReopens = await post('requests/decide', 'sm', { ids: ['sr_m'], decision: 'reopen' });
  ok('S131: … and may reopen it while nothing was delivered (supplies.manage)', smReopens.body.results?.[0]?.ok === true && rowOf('sr_m').status === 'open', show(smReopens));

  // The approver, pared off supplies.approve in Settings → Roles, is turned away at the door.
  build({ overrides: [{ userId: 'u_mgrA', grants: [], revokes: ['supplies.approve'] }] });
  const P = await seedCatalog();
  await submit('sr_p', 'admin', 'cl_A', [{ itemId: P.A.glass, qty: 1 }]);
  const pared = await post('requests/decide', 'mgrA', { ids: ['sr_p'], decision: 'approve' });
  ok('🔴 SUP-11: the approver WITHOUT supplies.approve cannot approve', pared.status === 403 && rowOf('sr_p').status === 'open', show(pared));
});

// ── 3 + 4. the state machine, the batch, the partials, the stale CAS ─────────
await section('3', async () => {
  build();
  const I = await seedCatalog();
  for (const id of ['q1', 'q2', 'q3', 'q4']) await submit(id, 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('qb', 'admin', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  await post('requests/decide', 'mgrA', { ids: ['q3'], decision: 'approve' });
  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  // q4 changes underneath the batch: someone else's write lands between its read and its update.
  let bumped = false;
  world.beforeQuery = async (q) => {
    if (!bumped && q.table === 'supply_requests' && q.op === 'update' && q.eq.id === 'q4') {
      bumped = true;
      const r = rowOf('q4');
      r.version += 1;
    }
  };
  const logFrom = world.log.length;
  const batch = await post('requests/decide', 'mgrA', { ids: ['q1', 'q2', 'q3', 'q4', 'qb', 'q_gone'], decision: 'approve' });
  world.beforeQuery = null;
  // The batch's rows are the reads that NAME ids (the 12-month prune after it reads by status and date).
  const reads = world.log.slice(logFrom).filter((q) => q.table === 'supply_requests' && q.op === 'select' && Array.isArray(q.in?.id)).length;
  ok('🔴 the batch is READ in one query, not one per request (a 200-id batch must fit one function call)', reads === 1, `read ${reads} times`);
  const code = Object.fromEntries((batch.body.results || []).map((x) => [x.id, x.code]));
  ok('🔴 ONE call decides the batch and NAMES every partial (§132)',
    batch.status === 200 && code.q1 === 'ok' && code.q2 === 'ok' && code.q3 === 'illegal_move'
    && code.q4 === 'stale' && code.qb === 'not_yours' && code.q_gone === 'not_found', show(batch));
  ok('… with a count per code for the toast', batch.body.counts?.ok === 2 && batch.body.counts?.stale === 1 && batch.body.counts?.not_yours === 1);
  ok('🔴 a CAS miss on `version` moves nothing (the other writer wins)', rowOf('q4').status === 'open');
  ok('S131: with no Supply Manager on the team, "a new approved order" rings whoever holds supplies.manage, the approver skipped',
    JSON.stringify(bells('supplyRequestApproved')) === JSON.stringify(['u_admin', 'u_owner', 'u_admin', 'u_owner'].sort()),
    JSON.stringify(bells('supplyRequestApproved')));
  ok('🔴 S131: … and the person who ASKED hears it was approved (supplyOrderApproved), once per order',
    JSON.stringify(bells('supplyOrderApproved')) === JSON.stringify(['u_admin', 'u_admin']), JSON.stringify(bells('supplyOrderApproved')));
  const approvedBell = (world.tables.org_state[0].state.notifications || []).find((n) => n.eventKey === 'supplyOrderApproved');
  ok('S131: … its title names the order\'s number and the building, its link the order page',
    !!approvedBell && /SO-\d+/.test(approvedBell.title) && /Alpha Tower/.test(approvedBell.title) && /^\/supplies\/orders\/q[12]$/.test(approvedBell.url || ''),
    JSON.stringify(approvedBell));
  const acts = world.tables.activity_log.filter((a) => a.action === 'supply_request.status_changed');
  ok('the route logs supply_request.status_changed once per applied decision, before and after', acts.length === 2
    && acts.every((a) => a.before?.status === 'open' && a.after?.status === 'approved' && a.actor_user_id === 'u_mgrA'), JSON.stringify(acts.map((a) => [a.entity_id, a.before, a.after])));

  const tooMany = Array.from({ length: (S.SUPPLY_DECIDE_MAX || 500) + 1 }, (_, i) => `q_many_${i}`);
  const big = await post('requests/decide', 'admin', { ids: ['q4', ...tooMany], decision: 'approve' });
  ok('🔴 a batch over SUPPLY_DECIDE_MAX is REFUSED by name, never silently cut short (the client splits it)',
    big.status === 400 && big.body.code === 'too_many' && big.body.max === S.SUPPLY_DECIDE_MAX && rowOf('q4').status === 'open', show(big));

  const fillUnapproved = await toSupplier(['q4']);
  ok('🔴 the office cannot SUBMIT an order nobody approved (the state machine, on the server)', fillUnapproved.body.results?.[0]?.code === 'illegal_move' && rowOf('q4').status === 'open', show(fillUnapproved));
  for (const d of ['complete', 'send', 'submit', 'deliver', 'backorder', 'cancelLine']) {
    const viaDecide = await post('requests/decide', 'admin', { ids: ['q4'], decision: d });
    ok(`🔴 decide takes approve / reject / reopen only — "${d}" has its own call (II.5)`, viaDecide.status === 400 && viaDecide.body.code === 'bad_decision' && rowOf('q4').status === 'open', show(viaDecide));
  }
  const noReason = await post('requests/decide', 'mgrA', { ids: ['q4'], decision: 'reject', reason: '  ' });
  ok('SUP-1 b: a rejection without a reason is refused', noReason.body.results?.[0]?.code === 'reason_required' && rowOf('q4').status === 'open');
  world.tables.org_state[0].state.notifications = [];
  const rej = await post('requests/decide', 'mgrA', { ids: ['q4'], decision: 'reject', reason: 'Ordered last week' });
  ok('a rejection with a reason lands, stamped and dated', rej.body.results?.[0]?.ok === true && rowOf('q4').status === 'rejected'
    && rowOf('q4').rejection_reason === 'Ordered last week' && !!rowOf('q4').rejected_at);
  const declined = (world.tables.org_state[0].state.notifications || []).find((n) => n.eventKey === 'supplyOrderDeclined');
  ok('🔴 S131: … and tells the REQUESTER it was declined, with the reason (supplyOrderDeclined)', JSON.stringify(bells('supplyOrderDeclined')) === JSON.stringify(['u_admin'])
    && /Ordered last week/.test(declined?.body || ''), JSON.stringify(declined));
  const linesBefore = JSON.stringify(rowOf('q1').lines);
  const fill = await toSupplier(['q1']);
  const drop = await deliverAll('q1');
  const done = await complete('q1');
  ok('the office submits an APPROVED order, its lines are delivered and it is completed; the approval stamps are kept', fill.body.results?.[0]?.ok === true
    && drop.status === 200 && done.status === 200
    && rowOf('q1').status === 'completed' && rowOf('q1').approver_name === 'mgrA person' && !!rowOf('q1').completed_at && !!rowOf('q1').sent_at, show(done));
  ok('🔴 a decision never edits the lines (frozen once submitted)', JSON.stringify(rowOf('q1').lines) === linesBefore);
  const bad = await post('requests/decide', 'admin', { ids: ['q1'], decision: 'frobnicate' });
  ok('an unknown decision is refused', bad.status === 400 && bad.body.code === 'bad_decision');

  // CS-596 cancel, per request.
  await submit('c_own', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('c_other', 'mgrA', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  const cancelOther = await post('requests/cancel', 'mgrB', { id: 'q2' });
  ok('CS-596: a requester cannot cancel a request that is not theirs (and decided)', cancelOther.status === 403 && !!rowOf('q2'), show(cancelOther));
  const cancelOwn = await post('requests/cancel', 'mgrB', { id: 'c_own' });
  ok('CS-596: a requester may cancel their own request while it waits', cancelOwn.status === 200 && !rowOf('c_own'), show(cancelOwn));
  const cancelAsApprover = await post('requests/cancel', 'mgrB', { id: 'c_other' });
  ok('CS-596: the building\'s approver may cancel any of its requests', cancelAsApprover.status === 200 && !rowOf('c_other'), show(cancelAsApprover));
  const listed = await get('orders', 'mgrA', { status: 'open' });
  ok('the queue (GET orders) lists one page with its total and the tabs\' counts', listed.status === 200 && Array.isArray(listed.body.orders)
    && listed.body.counts && typeof listed.body.counts.open === 'number' && Array.isArray(listed.body.matches)
    && listed.body.page === 1 && listed.body.pageSize === 20 && typeof listed.body.total === 'number', show(listed));
  const byMgr = await get('orders', 'admin', { status: 'open', mgr: 'u_mgrB' });
  ok('the Manager filter is the BUILDING\'s supervisor', (byMgr.body.orders || []).length > 0 && byMgr.body.orders.every((r) => r.clientId === 'cl_B'), show(byMgr));
  const search = await get('orders', 'admin', { status: 'approved', q: 'alpha' });
  ok('the queue search matches a building by its name', (search.body.orders || []).length > 0 && search.body.orders.every((r) => r.clientId === 'cl_A'), show(search));
  const sneaky = await get('orders', 'admin', { status: 'approved', q: 'x),status.eq.open' });
  ok('a search term cannot smuggle a filter', sneaky.status === 200 && (sneaky.body.orders || []).every((r) => r.status === 'approved'), show(sneaky));
});

// ── 6. 🔴 retention at the write point: 12 months, in-flight never ───────────
await section('6', async () => {
  const cutoffMs = startOfDayKey(S.supplyHistoryStartKey(TODAY), TZ).getTime();
  const DAY = 86400000;
  const seeded = (id, status, extra) => ({
    id, organization_id: ORG, client_id: 'cl_A', status, lines: [], total_cents: 0, item_count: 0, search_text: '', version: 1,
    created_at: iso(cutoffMs - 400 * DAY), ...extra,
  });
  build({}, {
    supply_requests: [
      seeded('old_done', 'completed', { completed_at: iso(cutoffMs - DAY) }),
      seeded('old_rej', 'rejected', { rejected_at: iso(cutoffMs - DAY), rejection_reason: 'no' }),
      seeded('kept_done', 'completed', { completed_at: iso(cutoffMs + DAY) }),
      seeded('ancient_open', 'open', {}),
      seeded('ancient_approved', 'approved', { approved_at: iso(cutoffMs - 300 * DAY) }),
    ],
    // S131: the pruned order's invoice and delivery photo, and the kept order's.
    supply_order_documents: [
      { id: 'doc_old', organization_id: ORG, request_id: 'old_done', kind: 'invoice', file_name: 'old.pdf', mime_type: 'application/pdf', size_bytes: 10, storage_path: `${ORG}/old_done/doc_old` },
      { id: 'doc_kept', organization_id: ORG, request_id: 'kept_done', kind: 'invoice', file_name: 'kept.pdf', mime_type: 'application/pdf', size_bytes: 10, storage_path: `${ORG}/kept_done/doc_kept` },
    ],
    account_media: [
      { id: 'm_old', organization_id: ORG, scope: 'supply', ref_id: 'old_done', client_id: 'cl_A', site_id: null, kind: 'image', storage_path: `${ORG}/_supply/old.jpg`, thumb_path: null },
      { id: 'm_kept', organization_id: ORG, scope: 'supply', ref_id: 'kept_done', client_id: 'cl_A', site_id: null, kind: 'image', storage_path: `${ORG}/_supply/kept.jpg`, thumb_path: null },
    ],
  });
  const I = await seedCatalog();
  world.storage = [];
  await submit('trigger', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  const ids = world.tables.supply_requests.map((r) => r.id).sort();
  ok('🔴 SUP-13: a write prunes settled requests older than 12 months (completed AND rejected)', !ids.includes('old_done') && !ids.includes('old_rej'), ids.join(','));
  ok('… keeps one settled inside the 12 months', ids.includes('kept_done'));
  ok('🔴 … and NEVER drops a request still in flight, however old', ids.includes('ancient_open') && ids.includes('ancient_approved'));
  ok('the newest-300 cap is gone: nothing here counts settled rows', S.SUPPLY_COMPLETED_CAP === undefined);
  const removed = world.storage.filter((x) => x.op === 'remove');
  ok('🔴 S131 (retention at the write point): a pruned order\'s INVOICE file leaves Storage with it — read before the delete took its row',
    removed.some((x) => x.bucket === 'supply-documents' && x.path === `${ORG}/old_done/doc_old`), JSON.stringify(removed));
  ok('🔴 S131: … and its delivery PHOTO (object and row)', removed.some((x) => x.bucket === 'ops-media' && x.path === `${ORG}/_supply/old.jpg`)
    && !world.tables.account_media.some((m) => m.id === 'm_old'), JSON.stringify(removed));
  ok('… while a kept order keeps both', !removed.some((x) => /kept/.test(x.path)) && world.tables.account_media.some((m) => m.id === 'm_kept'), JSON.stringify(removed));
});

// ── 7. usage and budgets ─────────────────────────────────────────────────────
await section('7', async () => {
  const DAY = 86400000;
  const monthStartMs = startOfDayKey(startOfMonthKey(TODAY), TZ).getTime();
  const done = (id, clientId, completedMs, lines, totalCents) => ({
    id, organization_id: ORG, client_id: clientId, status: 'completed', lines, total_cents: totalCents, item_count: 1,
    search_text: '', version: 1, created_at: iso(completedMs - DAY), completed_at: iso(completedMs),
  });
  build({}, {
    supply_requests: [
      // 300 days ago: inside 12 months, outside 90 days
      done('u_300', 'cl_A', NOW - 300 * DAY, [{ itemId: 'i', name: 'Toilet paper', qty: 3, unitPriceCents: 4120 }], 12360),
      // 10 days ago
      done('u_10', 'cl_A', NOW - 10 * DAY, [{ itemId: 'i', name: 'Toilet paper', qty: 2, unitPriceCents: 4120 }], 8240),
      // the org-zone MONTH boundary: an hour before the month began in New York (still "this
      // month" in UTC on the 1st) and a minute after it began
      done('m_before', 'cl_A', monthStartMs - 3600000, [{ itemId: 'i', name: 'Liners', qty: 1, unitPriceCents: 9000 }], 9000),
      done('m_after', 'cl_A', monthStartMs + 60000, [{ itemId: 'i', name: 'Liners', qty: 1, unitPriceCents: 4500 }], 4500),
    ],
  });
  const y = await get('usage', 'mgrA', { period: '12m' });
  const tp = (y.body.rows || []).find((r) => r.name === 'Toilet paper');
  ok('🔴 SUP-13: usage reaches 12 months back (a delivery 300 days ago counts)', y.status === 200 && tp && tp.qty === 5 && tp.total === 206, show(y));
  const q = await get('usage', 'mgrA', { period: '90d' });
  ok('… and a shorter period leaves it out', ((q.body.rows || []).find((r) => r.name === 'Toilet paper') || {}).qty === 2, show(q));
  const before = await get('usage', 'mgrA', { period: 'custom', from: addDaysKey(S.supplyHistoryStartKey(TODAY), -1), to: TODAY });
  ok('🔴 a custom range that starts before the kept history is REFUSED, naming the first day', before.status === 400
    && before.body.code === 'before_history' && before.body.firstKey === S.supplyHistoryStartKey(TODAY), show(before));
  const both = await get('usage', 'mgrA', { period: 'custom', from: TODAY });
  ok('a custom range needs both days', both.status === 400 && both.body.code === 'pick_both', show(both));
  const scoped = await get('usage', 'mgrA', { period: '12m', cust: 'cl_B' });
  ok('usage is scoped to the picked building', scoped.status === 200 && (scoped.body.rows || []).length === 0, show(scoped));

  const b = await get('budgets', 'mgrA');
  const minuteIn = NOW - monthStartMs > 120000;
  ok('🔴 the budget is MONTH-TO-DATE in the ORG\'s zone: a delivery before the month began in New York does not count',
    b.status === 200 && b.body.monthKey === TODAY.slice(0, 7)
    && (b.body.spendCents.cl_A || 0) === (minuteIn ? 4500 : 0) + (NOW - 10 * DAY >= monthStartMs ? 8240 : 0), show(b));
});

// ── 8. 🔴 the org-state route: retired slices restored, a deleted customer's rows go ──
await section('8', async () => {
  // The committed blob still holds the old slices (the window before the one-time move's strip).
  const legacy = [{ id: 'sr_legacy', clientId: 'cl_A', status: 'open', lines: [{ name: 'TP', qty: 1, unitPrice: 4 }] }];
  build({ extra: { supplyRequests: legacy, supplyItems: [{ id: 'si_legacy', clientId: 'cl_A', name: 'TP', unitPrice: 4 }] } });
  const committed = world.tables.org_state[0].state;
  // A stale installed bundle approves the request IN THE BLOB and adds another.
  const staleSave = structuredClone(committed);
  staleSave.supplyRequests = [{ ...legacy[0], status: 'completed' }, { id: 'sr_stale', clientId: 'cl_A', status: 'open', lines: [] }];
  const r1 = await call(orgStateRoute, { method: 'POST', token: tok('owner'), body: { state: staleSave, baseVersion: 3, build: 1, tab: 't1' } });
  const after1 = world.tables.org_state[0].state;
  ok('a stale bundle\'s save still succeeds (nothing else it carried is lost)', r1.status === 200, show(r1));
  ok('🔴 SUP-13: … but its supply edits are PUT BACK to the committed value', JSON.stringify(after1.supplyRequests) === JSON.stringify(legacy)
    && JSON.stringify(after1.supplyItems) === JSON.stringify(committed.supplyItems), JSON.stringify(after1.supplyRequests));
  // A new bundle that never had the keys saves: they must NOT vanish before the strip.
  const fresh = structuredClone(after1);
  delete fresh.supplyRequests; delete fresh.supplyItems;
  fresh.company = { ...fresh.company, name: 'Clean Space' };
  const r2 = await call(orgStateRoute, { method: 'POST', token: tok('owner'), body: { state: fresh, baseVersion: world.tables.org_state[0].version, build: 1, tab: 't1' } });
  ok('🔴 SUP-13: a bundle without the keys does not erase them before the strip', r2.status === 200
    && JSON.stringify(world.tables.org_state[0].state.supplyRequests) === JSON.stringify(legacy), show(r2));

  // After the strip: a stale bundle cannot put them back.
  delete world.tables.org_state[0].state.supplyRequests;
  delete world.tables.org_state[0].state.supplyItems;
  const late = structuredClone(world.tables.org_state[0].state);
  late.supplyRequests = [{ id: 'sr_late', clientId: 'cl_A', status: 'open', lines: [] }];
  const r3 = await call(orgStateRoute, { method: 'POST', token: tok('owner'), body: { state: late, baseVersion: world.tables.org_state[0].version, build: 1, tab: 't1' } });
  ok('🔴 SUP-13: after the strip a stale bundle cannot write the keys back', r3.status === 200 && !('supplyRequests' in world.tables.org_state[0].state), show(r3));

  // CS-663: customers are ARCHIVED, never deleted. A save removing one is refused (it used to take
  // its supply rows with it, LW-01), and an archived customer keeps its supply list and requests:
  // its history. The walkers and the By building page leave it out (lib/supplies isSupplyBuilding).
  world.tables.supply_catalog.push({ id: 'sc_x', organization_id: ORG, name: 'X', version: 1 });
  world.tables.supply_items.push({ id: 'si_c', organization_id: ORG, client_id: 'cl_C', catalog_item_id: 'sc_x', version: 1 });
  world.tables.supply_requests.push({ id: 'sr_c', organization_id: ORG, client_id: 'cl_C', status: 'open', lines: [], version: 1 });
  const keptRows = () => world.tables.supply_items.some((r) => r.client_id === 'cl_C') && world.tables.supply_requests.some((r) => r.client_id === 'cl_C');
  const del = structuredClone(world.tables.org_state[0].state);
  del.clients = del.clients.filter((c) => c.id !== 'cl_C');
  const r4 = await call(orgStateRoute, { method: 'POST', token: tok('owner'), body: { state: del, baseVersion: world.tables.org_state[0].version, build: 1, tab: 't1' } });
  ok('🔴 CS-663: a save removing a customer is refused, and its supply rows stay', r4.status === 403 && keptRows(), show(r4));
  const arch = structuredClone(world.tables.org_state[0].state);
  Object.assign(arch.clients.find((c) => c.id === 'cl_C'), { statusOverride: 'archived', archivedAt: '2026-10-13T12:00:00.000Z', archivedBy: null, statusBeforeArchive: null });
  const r5 = await call(orgStateRoute, { method: 'POST', token: tok('owner'), body: { state: arch, baseVersion: world.tables.org_state[0].version, build: 1, tab: 't1' } });
  ok('an archived customer keeps its supply switches and requests (its history)', r5.status === 200 && keptRows(), show(r5));
});

// ── 9. the cron's supply walker reads the table ──────────────────────────────
await section('9', async () => {
  build();
  const I = await seedCatalog();
  await submit('ordered', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  const state = world.tables.org_state[0].state;
  const alerts = await supplyAlertsFor(state, NOW, new Set());
  const due = alerts.filter((a) => a.kind === 'supplyOrderDue').map((a) => a.clientId).sort();
  // Gamma Court has no manager, no budget and nothing in flight, so it is not a supply building
  // (lib/supplies isSupplyBuilding, which the walker reads since CS-683) and is not chased either.
  ok('the monthly reminder walks the supply TABLE: a building that ordered this month is not chased', !due.includes('cl_A') && due.includes('cl_B') && !due.includes('cl_C'), JSON.stringify(due));
  // 🔴 CS-953: the office hears the day after the supervisor's reminder was RAISED — the cron hands
  // the walker each marker's firedAt. The 15th of this month at noon in the org's zone, so the
  // check never depends on what day the suite runs.
  const month = TODAY.slice(0, 7);
  const noonOn = (d) => startOfDayKey(`${month}-${d}`, TZ).getTime() + 12 * 3600 * 1000;
  const MID = noonOn('15');
  const dueB = `oa_supplyOrderDue_cl_B_${month}`;
  const officeFor = async (firedAtMs) => {
    const s = { ...state, opsAlertEvents: firedAtMs == null ? [] : [{ id: dueB, kind: 'supplyOrderDue', clientId: 'cl_B', jobId: null, firedAt: iso(firedAtMs) }] };
    const ids = new Set(s.opsAlertEvents.map((e) => e.id));
    return (await supplyAlertsFor(s, MID, ids)).filter((a) => a.kind === 'supplyOrderOverdue').map((a) => a.clientId);
  };
  const sameRun = await supplyAlertsFor({ ...state, opsAlertEvents: [] }, MID, new Set());
  ok('🔴 CS-953: a building first walked past its order day reminds its supervisor and NOT the office in the same run',
    sameRun.some((a) => a.kind === 'supplyOrderDue' && a.clientId === 'cl_B') && !sameRun.some((a) => a.kind === 'supplyOrderOverdue'), JSON.stringify(sameRun.map((a) => a.id)));
  ok('🔴 CS-953: the supervisor reminded earlier today: the office still waits', !(await officeFor(MID - 3600 * 1000)).includes('cl_B'));
  ok('🔴 CS-953: the supervisor reminded yesterday and still nothing: the office is told', (await officeFor(noonOn('14'))).includes('cl_B'));
  world.failWhen = (qd) => qd.table === 'supply_requests';
  let threw = false;
  try { await supplyAlertsFor(state, NOW, new Set()); } catch { threw = true; }
  world.failWhen = null;
  ok('a failed read THROWS (the cron skips the supply alerts rather than chasing every building)', threw);
});

// ── 11. Round 3 (2026-10-06): the customer's Supplies tab reads ──────────────
// The list's history columns come from the server, aggregated BY CATALOG ITEM from THIS
// building's delivered requests, with "the last 3 months" counted from the start of the 90th
// org-zone day. A line written before the master list names only the building's row; it is
// resolved through the building's own list. The request form and the tab read every OPEN request
// of one building in one complete read (the on-order total behind the budget line), plus its
// newest settled ones.
await section('11', async () => {
  const DAY = 86400000;
  // (The literal 89 only stands in on a tree without the helper, so the pre-change run counts.)
  const edgeMs = startOfDayKey(S.supplyRecentStartKey ? S.supplyRecentStartKey(TODAY) : addDaysKey(TODAY, -89), TZ).getTime();
  const row = (id, clientId, status, at, lines, extra = {}) => ({
    id, organization_id: ORG, client_id: clientId, status, lines, total_cents: 0, item_count: 1, search_text: '', version: 1,
    created_at: iso(at - DAY), ...(status === 'completed' ? { completed_at: iso(at) } : {}),
    ...(status === 'rejected' ? { rejected_at: iso(at), rejection_reason: 'no' } : {}), ...extra,
  });
  // The master list and Alpha's switches as the backfill leaves them (fixed ids, the old rows').
  const cat = (id, name, cents) => ({ id, organization_id: ORG, sku: null, name, category: null, unit: 'each', unit_price_cents: cents, version: 1 });
  const sw = (id, clientId, catalogItemId) => ({ id, organization_id: ORG, client_id: clientId, catalog_item_id: catalogItemId, version: 1 });
  const G = (qty, itemId = 'si_glass') => ({ itemId, catalogItemId: 'sc_glass', name: 'Glass', qty, unitPriceCents: 679 });
  build({}, {
    supply_catalog: [cat('sc_glass', 'Glass', 679), cat('sc_liner', 'Liners', 3290), cat('sc_bulb', 'Bulbs', null)],
    supply_items: [sw('si_glass', 'cl_A', 'sc_glass'), sw('si_liner', 'cl_A', 'sc_liner'), sw('si_bulb', 'cl_A', 'sc_bulb'), sw('si_b_glass', 'cl_B', 'sc_glass')],
    supply_requests: [
      row('d_new', 'cl_A', 'completed', NOW - 5 * DAY, [G(2), G(1)]),
      // written before the master list: the row id only, resolved through Alpha's list
      row('d_in', 'cl_A', 'completed', edgeMs + 60000, [{ itemId: 'si_glass', name: 'Glass', qty: 4, unitPriceCents: 679 }, { name: 'loose', qty: 9 }]),
      row('d_out', 'cl_A', 'completed', edgeMs - 60000, [G(50), { itemId: 'si_liner', catalogItemId: 'sc_liner', name: 'Liners', qty: 6, unitPriceCents: 3290 }]),
      row('d_other', 'cl_B', 'completed', NOW - 2 * DAY, [G(70, 'si_b_glass')]),
      ...Array.from({ length: 23 }, (_, i) => row(`o_${i}`, 'cl_A', i % 2 ? 'approved' : 'open', NOW - (i + 1) * 3600000, [G(1)])),
      ...Array.from({ length: 7 }, (_, i) => row(`s_${i}`, 'cl_A', i === 3 ? 'rejected' : 'completed', NOW - (10 + i) * DAY, [])),
      row('o_b', 'cl_B', 'open', NOW - 3600000, []),
    ],
  });
  const plain = await get('items', 'mgrA', { clientId: 'cl_A' });
  ok('the plain items read carries no history (the request form does not pay for it)', plain.status === 200
    && (plain.body.items || []).length === 3 && (plain.body.items || []).every((x) => !('qty90d' in x)), show(plain));
  const h = await get('items', 'mgrA', { clientId: 'cl_A', history: '1' });
  const byId = Object.fromEntries((h.body.items || []).map((x) => [x.id, x]));
  ok('🔴 items?history=1: per CATALOG ITEM, this building only — the last delivery and its quantity (two lines of one item are one delivery)',
    h.status === 200 && byId.si_glass?.lastDeliveredAt === iso(NOW - 5 * DAY) && byId.si_glass?.lastDeliveredQty === 3, show(h));
  ok('🔴 … "the last 3 months" counts from the start of the 90th day in the ORG zone (a minute inside counts, a minute before does not) — a line from before the master list counted through the building\'s list',
    byId.si_glass?.qty90d === 3 + 4, JSON.stringify(byId.si_glass));
  ok('… an item last delivered before the window still shows that delivery, with 0 in the window',
    byId.si_liner?.lastDeliveredQty === 6 && byId.si_liner?.qty90d === 0, JSON.stringify(byId.si_liner));
  ok('… an item never delivered reads "not yet", never a made-up number',
    byId.si_bulb && byId.si_bulb.lastDeliveredAt === null && byId.si_bulb.lastDeliveredQty === 0 && byId.si_bulb.qty90d === 0, JSON.stringify(byId.si_bulb));
  const crewH = await get('items', 'crew', { clientId: 'cl_A', history: '1' });
  ok('the history read keeps the items read\'s door (a cleaner is refused)', crewH.status === 403, show(crewH));

  const b = await get('requests', 'mgrA', { building: 'cl_A' });
  ok('🔴 requests?building=: EVERY open request of one building (23, past the queue\'s page of 20), newest first',
    b.status === 200 && (b.body.open || []).length === 23 && b.body.open.every((r) => r.clientId === 'cl_A' && (r.status === 'open' || r.status === 'approved'))
    && b.body.open[0].id === 'o_0', show(b));
  ok('… its lines carry the catalog item the order sheet keys "already on order" on', b.body.open?.[0]?.lines?.[0]?.catalogItemId === 'sc_glass', JSON.stringify(b.body.open?.[0]?.lines));
  ok('… and its newest settled ones (completed or rejected), capped, newest first',
    (b.body.recent || []).length === 5 && b.body.recent[0].id === 'd_new' && b.body.recent[1].id === 's_0'
    && b.body.recent.some((r) => r.status === 'rejected')
    && b.body.recent.every((r) => r.clientId === 'cl_A'), show(b));
  const bad = await get('requests', 'mgrA', { building: 'x),status.eq.open' });
  ok('a building id that is not one safe token is refused', bad.status === 400, show(bad));
  const crewB = await get('requests', 'crew', { building: 'cl_A' });
  ok('the building read keeps the requests read\'s door (a cleaner is refused)', crewB.status === 403, show(crewB));
});

// ── 12. the manager view redesign (Wave B, 2026-10-09): GET buildings, every building's one state ──
// SUP-14 ★a, on Matt's boards: Needs attention / Order placed / All set, from ONE complete read of
// every in-flight request and the month's delivered spend (lib/supplies supplyBuildingRows).
await section('12', async () => {
  const DAY = 86400000;
  const monthStartMs = startOfDayKey(startOfMonthKey(TODAY), TZ).getTime();
  const row = (id, clientId, status, lines, extra = {}) => ({
    id, organization_id: ORG, client_id: clientId, status, lines,
    total_cents: lines.reduce((a, l) => a + l.qty * (l.unitPriceCents || 0), 0), item_count: 1, search_text: '', version: 1,
    created_at: iso(NOW - DAY), ...extra,
  });
  build({}, {
    supply_requests: [
      // 25 waiting at Alpha Tower — past any page of 20, so a paged read would lose some.
      ...Array.from({ length: 25 }, (_, i) => row(`w_${String(i).padStart(2, '0')}`, 'cl_A', 'open', [{ itemId: `i${i}`, name: `Item ${i}`, qty: 1, unitPriceCents: 100 }])),
      row('p_B', 'cl_B', 'approved', [{ itemId: 'g', name: 'Glass cleaner', qty: 2, unitPriceCents: 679 }], { approved_at: iso(NOW - DAY) }),
      // delivered a minute into this org-zone month at Alpha ($120 against its $100 budget) …
      row('d_A', 'cl_A', 'completed', [{ itemId: 'x', name: 'Liners', qty: 1, unitPriceCents: 12000 }], { completed_at: iso(monthStartMs + 60000) }),
      // … and an hour before it began at Beta: last month's, not this month's
      row('d_B', 'cl_B', 'completed', [{ itemId: 'x', name: 'Liners', qty: 1, unitPriceCents: 99900 }], { completed_at: iso(monthStartMs - 3600000) }),
      row('r_C', 'cl_C', 'rejected', [{ itemId: 'x', name: 'Liners', qty: 1, unitPriceCents: 100 }], { rejected_at: iso(NOW - DAY), rejection_reason: 'no' }),
    ],
  });
  const all = await get('buildings', 'mgrA');
  const b = new Map(((all.body && all.body.buildings) || []).map((x) => [x.clientId, x]));
  ok('GET buildings answers a supplies.view holder', all.status === 200 && Array.isArray(all.body.buildings), show(all));
  ok('🔴 every waiting request counts — all 25, past the queue\'s page of 20 (a COMPLETE read)',
    b.get('cl_A')?.waiting === 25 && (b.get('cl_A')?.items || []).length === 25, JSON.stringify(b.get('cl_A')));
  ok('Alpha needs attention, waiting for its supervisor, and is over this month\'s budget',
    b.get('cl_A')?.state === S.SUPPLY_BUILDING_STATE?.attention && b.get('cl_A')?.approverId === 'u_mgrA'
    && b.get('cl_A')?.over === true && b.get('cl_A')?.spend === 120 && b.get('cl_A')?.budget === 100, JSON.stringify(b.get('cl_A')));
  ok('Beta\'s approved request is an order placed, naming its item, with nobody to approve',
    b.get('cl_B')?.state === S.SUPPLY_BUILDING_STATE?.placed && JSON.stringify(b.get('cl_B')?.items) === '["Glass cleaner"]' && b.get('cl_B')?.approverId === null,
    JSON.stringify(b.get('cl_B')));
  ok('🔴 the month is the ORG zone\'s: a delivery an hour before it began is not this month\'s spend', b.get('cl_B')?.spend === 0, JSON.stringify(b.get('cl_B')));
  ok('a customer with no manager, no budget and nothing in flight is not a building (a rejected request is settled)', !b.has('cl_C'));
  ok('the counts are the rule\'s', JSON.stringify(all.body.counts) === JSON.stringify(S.supplyBuildingCounts ? S.supplyBuildingCounts(all.body.buildings) : null)
    && all.body.counts.attention === 1 && all.body.counts.placed === 1 && all.body.counts.total === 2, show(all));
  const mgrB = await get('buildings', 'mgrA', { mgr: 'u_mgrB' });
  ok('?mgr= narrows to that manager\'s buildings (the building\'s supervisor)', mgrB.status === 200
    && (mgrB.body.buildings || []).map((x) => x.clientId).join() === 'cl_B', show(mgrB));
  const one = await get('buildings', 'admin', { cust: 'cl_A' });
  ok('?cust= narrows to one building', one.status === 200 && (one.body.buildings || []).map((x) => x.clientId).join() === 'cl_A', show(one));
  const crew = await get('buildings', 'crew');
  ok('a cleaner is refused (supplies.view is the door)', crew.status === 403, show(crew));
  const anon = await get('buildings', null);
  ok('no login is refused', anon.status === 401, show(anon));
});

// ── 13. 🔴 the master list (Matt, the Oct 6 call: "the little Bible") ─────────
// One catalog per org: SKU · name · category · how it comes · price (D2). The office edits it
// (supplies.manage), everyone with supplies.view reads it, 20 a page with its total.
await section('13', async () => {
  build();
  const LIQ = 'Liquids';
  const PPS = 'Paper, plastic & soap';
  // 25 items: SKU-01..SKU-23 alternating between Matt's two groups, and two with no SKU and no
  // category (a blank SKU may repeat).
  const seeded = [];
  for (let i = 1; i <= 25; i += 1) {
    const n = String(i).padStart(2, '0');
    seeded.push(await post('catalog/save', 'admin', i <= 23
      ? { id: `sc_${n}`, sku: `SKU-${n}`, name: `Item ${n}`, category: i % 2 ? LIQ : PPS, unit: 'each', unitPrice: i }
      : { id: `sc_${n}`, sku: '', name: `Loose item ${n}`, category: '', unit: '', unitPrice: '' }));
  }
  ok('catalog/save adds each of 25 items (the office, supplies.manage)', seeded.every((r) => r.status === 200 && r.body.created === true), show(seeded[0]));
  ok('a blank SKU may repeat (two items saved with none)', world.tables.supply_catalog.filter((r) => r.sku === null).length === 2);
  const created = world.tables.activity_log.filter((a) => a.action === 'supply_catalog.created');
  ok('every new catalog item writes supply_catalog.created (the activity log)', created.length === 25
    && created[0].entity_id === 'sc_01' && created[0].actor_user_id === 'u_admin', JSON.stringify(created.slice(0, 1)));

  const clash = await post('catalog/save', 'admin', { id: 'sc_new', sku: ' sku-07 ', name: 'Another', unitPrice: 2 });
  ok('🔴 D2: a SKU another item holds is a 409 that NAMES the item holding it — case and spaces ignored',
    clash.status === 409 && clash.body.code === 'sku_taken' && clash.body.holder?.id === 'sc_07' && clash.body.holder?.name === 'Item 07', show(clash));
  ok('… and nothing was written', !world.tables.supply_catalog.some((r) => r.id === 'sc_new'));
  const keep = await post('catalog/save', 'admin', { id: 'sc_07', sku: 'SKU-07', name: 'Item 07 renamed', category: LIQ, unit: 'each', unitPrice: 7 });
  ok('an item keeps its own SKU on an edit', keep.status === 200 && keep.body.item?.name === 'Item 07 renamed', show(keep));
  ok('… and the edit writes supply_catalog.edited', world.tables.activity_log.some((a) => a.action === 'supply_catalog.edited' && a.entity_id === 'sc_07'));
  // Two saves racing past the read: the database's unique index answers, and the route says so.
  world.beforeQuery = async (q) => {
    if (q.table === 'supply_catalog' && q.op === 'insert' && !world.tables.supply_catalog.some((r) => r.id === 'sc_racer')) {
      world.tables.supply_catalog.push({ id: 'sc_racer', organization_id: ORG, sku: 'RACE-1', name: 'The other tab', version: 1 });
    }
  };
  const race = await post('catalog/save', 'admin', { id: 'sc_race', sku: 'race-1', name: 'Mine' });
  world.beforeQuery = null;
  ok('🔴 … and a SKU taken between the check and the write (the 23505) is the same 409, not a 500', race.status === 409 && race.body.code === 'sku_taken'
    && !world.tables.supply_catalog.some((r) => r.id === 'sc_race'), show(race));
  world.tables.supply_catalog = world.tables.supply_catalog.filter((r) => r.id !== 'sc_racer');
  const noName = await post('catalog/save', 'admin', { id: 'sc_x', name: '  ' });
  ok('an item needs a name', noName.status === 400 && noName.body.code === 'name_required', show(noName));
  const zero = await post('catalog/save', 'admin', { id: 'sc_x', name: 'X', unitPrice: 0 });
  ok('a price is above zero or blank (SUP-4)', zero.status === 400 && zero.body.code === 'bad_price', show(zero));
  const badId = await post('catalog/save', 'admin', { id: 'x),id.eq.y', name: 'X' });
  ok('an id that is not one safe token is refused', badId.status === 400 && badId.body.code === 'bad_id', show(badId));
  ok('none of those wrote a row', world.tables.supply_catalog.length === 25, String(world.tables.supply_catalog.length));

  // The reads: a server page of 20 with its total, search (name, SKU), the category filter.
  const p1 = await get('catalog', 'mgrA');
  ok('🔴 GET catalog: one server page of 20 with its total and every category used (supplies.view)',
    p1.status === 200 && p1.body.items.length === 20 && p1.body.total === 25 && p1.body.pageSize === 20 && p1.body.page === 1
    && JSON.stringify(p1.body.categories) === JSON.stringify([LIQ, PPS]), show(p1));
  const p2 = await get('catalog', 'mgrA', { page: '2' });
  ok('… page 2 holds the rest', p2.status === 200 && p2.body.items.length === 5 && p2.body.total === 25, show(p2));
  const bySku = await get('catalog', 'mgrA', { q: 'sku-1' });
  ok('… a search matches the SKU', bySku.status === 200 && bySku.body.total === 10 && bySku.body.items.every((x) => /^SKU-1/.test(x.sku)), show(bySku));
  const byName = await get('catalog', 'mgrA', { q: 'loose' });
  ok('… and the name', byName.body.total === 2, show(byName));
  const liq = await get('catalog', 'mgrA', { category: LIQ });
  ok('… the category filter keeps one group', liq.body.total === 12 && liq.body.items.every((x) => x.category === LIQ), show(liq));
  // D3: a label typed in another case is saved as the spelling in use, so the filter keeps one group.
  const recased = await post('catalog/save', 'admin', { id: 'sc_recased', name: 'Odor neutralizer', category: ' liquids ', unitPrice: 8.25 });
  const liq2 = await get('catalog', 'mgrA', { category: LIQ });
  ok('🔴 D3: a category typed in another case is saved as the one in use ("liquids" is "Liquids"), so its group never splits',
    recased.status === 200 && recased.body.item?.category === LIQ && liq2.body.total === 13
    && JSON.stringify(liq2.body.categories) === JSON.stringify([LIQ, PPS]), show(recased));
  world.tables.supply_catalog = world.tables.supply_catalog.filter((r) => r.id !== 'sc_recased');
  const noCat = await get('catalog', 'mgrA', { category: S.SUPPLY_NO_CATEGORY });
  ok('… and "no category" keeps the unlabelled ones', noCat.body.total === 2 && noCat.body.items.every((x) => x.category === null), show(noCat));
  const sneaky = await get('catalog', 'mgrA', { q: 'x),sku.is.null' });
  ok('a search term cannot smuggle a filter', sneaky.status === 200 && sneaky.body.total === 0, show(sneaky));
  // ?all=1 is the switches' list: COMPLETE, through PostgREST's row cap.
  world.maxRows = 10;
  const all = await get('catalog', 'mgrA', { all: '1' });
  world.maxRows = null;
  ok('🔴 GET catalog?all=1 is the WHOLE catalog, past PostgREST\'s row cap (a complete, paged read)', all.status === 200 && all.body.items.length === 25
    && new Set(all.body.items.map((x) => x.id)).size === 25, show(all));

  // "On N buildings", and a delete that says how many buildings had it.
  await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_01', 'sc_02'] });
  await post('items/assign', 'admin', { clientId: 'cl_B', on: ['sc_01'] });
  const counted = await get('catalog', 'mgrA', { q: 'sku-0' });
  const on = Object.fromEntries(counted.body.items.map((x) => [x.id, x.buildings]));
  ok('🔴 each row says how many buildings have it switched on', on.sc_01 === 2 && on.sc_02 === 1 && on.sc_03 === 0, JSON.stringify(on));
  const req = await submit('sr_cat', 'admin', 'cl_A', [{ itemId: itemOf('cl_A', 'sc_01'), qty: 3 }]);
  const linesBefore = JSON.stringify(rowOf('sr_cat')?.lines);
  const delMgr = await post('catalog/delete', 'mgrA', { id: 'sc_01' });
  ok('a manager without supplies.manage cannot delete from the catalog', delMgr.status === 403 && world.tables.supply_catalog.some((r) => r.id === 'sc_01'), show(delMgr));
  const del = await post('catalog/delete', 'admin', { id: 'sc_01' });
  ok('🔴 catalog/delete answers how many buildings had it', req.status === 200 && del.status === 200 && del.body.ok === true && del.body.buildings === 2, show(del));
  ok('… the item leaves the catalog and every building\'s list', !world.tables.supply_catalog.some((r) => r.id === 'sc_01')
    && !world.tables.supply_items.some((r) => r.catalog_item_id === 'sc_01') && world.tables.supply_items.some((r) => r.catalog_item_id === 'sc_02'));
  ok('🔴 … and past requests keep their lines (a frozen snapshot)', JSON.stringify(rowOf('sr_cat')?.lines) === linesBefore && /Item 01/.test(linesBefore), linesBefore);
  ok('… and the delete writes supply_catalog.deleted', world.tables.activity_log.some((a) => a.action === 'supply_catalog.deleted' && a.entity_id === 'sc_01'));
  const gone = await post('catalog/delete', 'admin', { id: 'sc_01' });
  ok('deleting it again is a 404, not a second success', gone.status === 404 && gone.body.code === 'not_found', show(gone));
});

// ── 14. 🔴 a building's switches (Matt: "the supplies will come from that master list with maybe
//    a toggle switch") ─────────────────────────────────────────────────────────────────────────
await section('14', async () => {
  build();
  for (const [id, name] of [['sc_glass', 'Glass cleaner'], ['sc_liner', 'Trash liners'], ['sc_tp', 'Toilet paper']]) {
    await post('catalog/save', 'admin', { id, name, unit: 'each', unitPrice: 5 });
  }
  world.tables.activity_log = [];
  const first = await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_glass', 'sc_liner'] });
  ok('🔴 items/assign switches items on, every id answered by name', first.status === 200
    && JSON.stringify(first.body.results) === JSON.stringify([
      { catalogItemId: 'sc_glass', on: true, ok: true, code: 'ok' },
      { catalogItemId: 'sc_liner', on: true, ok: true, code: 'ok' },
    ]) && first.body.counts?.ok === 2, show(first));
  const listed = await get('items', 'mgrA', { clientId: 'cl_A' });
  ok('🔴 the building\'s list — what the order sheet offers — is ONLY its switched-on items', (listed.body.items || []).map((x) => x.catalogItemId).sort().join() === 'sc_glass,sc_liner', show(listed));
  const twice = await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_glass'] });
  ok('switching on an item already on is "already" and writes no second row', twice.body.results?.[0]?.code === 'already'
    && world.tables.supply_items.filter((r) => r.client_id === 'cl_A' && r.catalog_item_id === 'sc_glass').length === 1, show(twice));
  const acts = world.tables.activity_log.filter((a) => a.action === 'supply_list.changed');
  ok('a change to a building\'s list writes supply_list.changed against THAT building (a no-op writes none)', acts.length === 1
    && acts[0].client_id === 'cl_A' && /Glass cleaner/.test(acts[0].summary) && acts[0].actor_user_id === 'u_admin', JSON.stringify(acts));

  // An order placed and delivered, so the item has a history at Alpha.
  const glassRow = itemOf('cl_A', 'sc_glass');
  await submit('sr_h', 'mgrA', 'cl_A', [{ itemId: glassRow, qty: 4 }]);
  await deliveredOrder(['sr_h'], 'mgrA');
  await submit('sr_open', 'mgrA', 'cl_A', [{ itemId: glassRow, qty: 2 }]);
  const linerRow = itemOf('cl_A', 'sc_liner');
  const off = await post('items/assign', 'admin', { clientId: 'cl_A', off: ['sc_liner', 'sc_tp'] });
  ok('switching off: ok for an item that was on, "already" for one that was not', JSON.stringify((off.body.results || []).map((x) => x.code)) === '["ok","already"]'
    && !itemOf('cl_A', 'sc_liner'), show(off));
  const offOrder = await submit('sr_off', 'mgrA', 'cl_A', [{ itemId: linerRow, qty: 1 }]);
  ok('🔴 an item switched off can no longer be ordered there (409, named)', offOrder.status === 409 && offOrder.body.code === 'unknown_item' && !rowOf('sr_off'), show(offOrder));

  // 🔴 D6: off and back on keeps the history.
  await post('items/assign', 'admin', { clientId: 'cl_A', off: ['sc_glass'] });
  await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_glass'] });
  const newRow = itemOf('cl_A', 'sc_glass');
  const h = await get('items', 'mgrA', { clientId: 'cl_A', history: '1' });
  const back = (h.body.items || []).find((x) => x.catalogItemId === 'sc_glass');
  ok('🔴 D6: an item switched off and back on keeps its history (Last delivered, Last 3 months) — a new row, the same catalog item',
    newRow && newRow !== glassRow && back && back.id === newRow && back.lastDeliveredQty === 4 && back.qty90d === 4 && !!back.lastDeliveredAt, JSON.stringify(back));
  const bldg = await get('requests', 'mgrA', { building: 'cl_A' });
  const onOrder = S.supplyOnOrderByItem(bldg.body.open || [], { itemCatalog: S.supplyItemCatalogMap(h.body.items) });
  ok('🔴 D6: … and what is on order still counts against it (keyed on the catalog item)', onOrder.sc_glass?.requested === 2, JSON.stringify(onOrder));
  const reorder = await submit('sr_again', 'mgrA', 'cl_A', [{ itemId: newRow, qty: 1 }]);
  ok('… and it can be ordered again', reorder.status === 200 && reorder.body.request?.lines?.[0]?.catalogItemId === 'sc_glass', show(reorder));

  // The refusals.
  const ghost = await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_nope', 'x),id.eq.y'] });
  ok('an item not in the catalog is answered not_found, by name — so is an id that is not one safe token',
    ghost.status === 200 && (ghost.body.results || []).map((x) => x.code).join() === 'not_found,not_found', show(ghost));
  const both = await post('items/assign', 'admin', { clientId: 'cl_A', on: ['sc_tp'], off: ['sc_tp'] });
  ok('an item asked on AND off in one call is a conflict, and nothing changes', (both.body.results || []).every((x) => x.code === 'conflict') && !itemOf('cl_A', 'sc_tp'), show(both));
  const noBuilding = await post('items/assign', 'admin', { clientId: 'cl_nope', on: ['sc_tp'] });
  ok('a building that does not exist is refused', noBuilding.status === 400 && noBuilding.body.code === 'unknown_client', show(noBuilding));
  const tooMany = Array.from({ length: S.SUPPLY_ASSIGN_MAX + 1 }, (_, i) => `sc_m${i}`);
  const big = await post('items/assign', 'admin', { clientId: 'cl_A', on: tooMany });
  ok('🔴 a batch over SUPPLY_ASSIGN_MAX is refused by name, never cut short', big.status === 400 && big.body.code === 'too_many' && big.body.max === S.SUPPLY_ASSIGN_MAX, show(big));
});

// ── THE SUPPLY ORDERS (S131; plan docs/plans/2026-10-14-supply-orders.md; brief S) ─────────────
// requested → approved → SUBMITTED to the supplier (the Supply Manager; no quantities) → each line
// delivered (the Supply Manager, or the driver), backordered with the supplier's ETA, or cancelled
// with a reason → COMPLETED once every line is resolved. No money ever reaches the driver or a
// cleaner.
const MONEY = /unitPrice|price|cents|total|budget|spend/i;
const HR = 3600000;

// ── 15. 🔴 Submit to supplier (EP-392) ───────────────────────────────────────
await section('15', async () => {
  build();
  const I = await seedCatalog();
  await submit('s_one', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 4 }, { itemId: I.A.liner, qty: 2 }]);
  await submit('s_two', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('s_three', 'mgrA', 'cl_A', [{ itemId: I.A.bulb, qty: 3 }]);
  await submit('s_b', 'mgrB', 'cl_B', [{ itemId: I.B.glass, qty: 5 }]);
  await submit('s_wait', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  ok('🔴 S131: every order takes the next NUMBER from the table\'s sequence (SO-1001 on) — a create sends none',
    JSON.stringify(['s_one', 's_two', 's_three', 's_b', 's_wait'].map((id) => rowOf(id)?.number)) === JSON.stringify([1001, 1002, 1003, 1004, 1005]),
    JSON.stringify(world.tables.supply_requests.map((r) => [r.id, r.number])));
  await post('requests/decide', 'admin', { ids: ['s_one', 's_two', 's_three', 's_b'], decision: 'approve' });
  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  const totalBefore = rowOf('s_one').total_cents;
  const one = await toSupplier(['s_one']);
  const row = rowOf('s_one');
  ok('🔴 S131: Submit to supplier moves ONE approved order to the supplier, every line PENDING — no quantities recorded', one.status === 200 && one.body.results?.[0]?.ok === true
    && row?.status === 'sent' && row.fulfillment_state === 'pending'
    && JSON.stringify(row.fulfillment) === JSON.stringify(S.supplyEmptyFulfillment(row.lines))
    && JSON.stringify(row.fulfillment.map((e) => e.catalogItemId)) === JSON.stringify(['sc_glass', 'sc_liner'])
    && row.sent_lines == null && row.sent_total_cents == null, JSON.stringify(row));
  ok('… stamped who and when — the requested total and the approval untouched', !!row?.sent_at
    && row.sender_name === 'admin person' && row.sent_by_user_id === 'u_admin'
    && row.total_cents === totalBefore && row.approver_name === 'admin person', JSON.stringify(row));
  ok('… answered with the order (its number with it)', one.body.results?.[0]?.request?.status === 'sent' && one.body.results[0].request.number === 1001
    && one.body.results[0].request.fulfillmentState === 'pending', show(one));
  ok('🔴 S131: a submit rings NOBODY (the order page and the queue show it)', (world.tables.org_state[0].state.notifications || []).length === 0,
    JSON.stringify(world.tables.org_state[0].state.notifications));
  const act = world.tables.activity_log.find((a) => a.action === 'supply_request.status_changed' && a.entity_id === 's_one');
  ok('S8: the activity log has it, before and after, by its number', !!act && act.before?.status === 'approved' && act.after?.status === 'sent'
    && act.actor_user_id === 'u_admin' && /SO-1001/.test(act.summary || '') && /submitted to the supplier/.test(act.summary || ''), JSON.stringify(act));

  const bulk = await toSupplier(['s_two', 's_three', 's_b', 's_wait', 's_one', 's_gone']);
  const code = Object.fromEntries((bulk.body.results || []).map((x) => [x.id, x.code]));
  ok('🔴 S131: "Submit to supplier (N)" over many — ONE call, every one that did not move NAMED', bulk.status === 200
    && code.s_two === 'ok' && code.s_three === 'ok' && code.s_b === 'ok' && code.s_wait === 'illegal_move'
    && code.s_one === 'illegal_move' && code.s_gone === 'not_found' && bulk.body.counts?.ok === 3, show(bulk));
  const tooMany = Array.from({ length: S.SUPPLY_DECIDE_MAX + 1 }, (_, i) => `s_many_${i}`);
  const big = await toSupplier(tooMany);
  ok('🔴 a batch over SUPPLY_DECIDE_MAX is refused by name, never cut short', big.status === 400 && big.body.code === 'too_many' && big.body.max === S.SUPPLY_DECIDE_MAX, show(big));
  const none = await toSupplier([]);
  ok('a submit names at least one order', none.status === 400, show(none));
  const asMgr = await toSupplier(['s_wait'], 'mgrA');
  ok('a manager without supplies.manage cannot submit', asMgr.status === 403 && rowOf('s_wait').status === 'open', show(asMgr));

  const back = await post('requests/decide', 'admin', { ids: ['s_two'], decision: 'reopen' });
  ok('the office may reopen a submitted order while nothing was delivered: it waits for approval again, its submit and per-line record cleared', back.body.results?.[0]?.ok === true
    && rowOf('s_two').status === 'open' && rowOf('s_two').sent_at === null && rowOf('s_two').fulfillment === null && rowOf('s_two').fulfillment_state === null, show(back));
  await fulfill('s_one', 'admin', [{ line: 0, act: 'deliver', qty: 1 }]);
  const noBack = await post('requests/decide', 'admin', { ids: ['s_one'], decision: 'reopen' });
  ok('🔴 S131: … and NOT once something was delivered (has_deliveries: a delivery is usage and spend)', noBack.body.results?.[0]?.code === 'has_deliveries'
    && rowOf('s_one').status === 'sent' && rowOf('s_one').fulfillment[0].deliveries.length === 1, show(noBack));
  const counts = await get('orders', 'admin', { countsOnly: '1' });
  ok('the tabs count them: With supplier 2, Partially fulfilled 1', counts.status === 200 && counts.body.counts?.sent === 2 && counts.body.counts?.partial === 1
    && !('orders' in counts.body), show(counts));
  const sentTab = await get('orders', 'admin', { status: 'sent' });
  ok('… and the With supplier tab lists them, who submitted them and when', (sentTab.body.orders || []).map((r) => r.id).sort().join() === 's_b,s_three'
    && sentTab.body.orders.every((r) => r.status === 'sent' && r.fulfillmentState === 'pending' && !!r.sentAt && r.sentByName === 'admin person' && Number.isInteger(r.number)), show(sentTab));
});

// ── 16. 🔴 the per-line acts (EP-393) and Mark Completed (EP-394) ─────────────
await section('16', async () => {
  build();
  const I = await seedCatalog();
  // mgrB asks at Alpha Tower, whose account manager is mgrA.
  await submit('f_one', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 4 }, { itemId: I.A.liner, qty: 2 }, { itemId: I.A.bulb, qty: 1 }]);
  await submit('f_appr', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await post('requests/decide', 'admin', { ids: ['f_one', 'f_appr'], decision: 'approve' });
  await toSupplier(['f_one']);
  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  const v1 = rowOf('f_one').version;

  const part = await fulfill('f_one', 'admin', [{ line: 0, act: 'deliver', qty: 3 }]);
  const f = rowOf('f_one').fulfillment;
  ok('🔴 S131: the Supply Manager delivers PART of a line — how many, who, when, via the office — and the order is partially fulfilled', part.status === 200
    && f[0].deliveries.length === 1 && f[0].deliveries[0].qty === 3 && f[0].deliveries[0].byUserId === 'u_admin' && f[0].deliveries[0].byName === 'admin person'
    && f[0].deliveries[0].via === 'office' && !!f[0].deliveries[0].at && rowOf('f_one').fulfillment_state === 'partial' && rowOf('f_one').status === 'sent'
    && rowOf('f_one').version === v1 + 1, show(part));
  ok('… answered with the order and each line\'s state (the page redraws from it)', part.body.order?.id === 'f_one' && part.body.progress?.state === 'partial'
    && part.body.progress?.lines?.[0]?.state === S.SUPPLY_LINE_STATE.pending && part.body.progress.lines[0].delivered === 3 && part.body.progress.lines[0].remaining === 1
    && JSON.stringify(part.body.applied) === JSON.stringify([{ line: 0, act: 'deliver', qty: 3 }]), show(part));
  const delivered = (world.tables.org_state[0].state.notifications || []).find((n) => n.eventKey === 'supplyItemsDelivered');
  ok('🔴 S131: a delivery tells the person who ASKED and the building\'s ACCOUNT MANAGER — the Supply Manager who did it skipped',
    JSON.stringify(bells('supplyItemsDelivered')) === JSON.stringify(['u_mgrA', 'u_mgrB']), JSON.stringify(bells('supplyItemsDelivered')));
  ok('… naming what came, and what is still to come', /Alpha Tower/.test(delivered?.title || '') && /Glass cleaner ×3/.test(delivered?.title || '')
    && /SO-1001/.test(delivered?.body || '') && /Glass cleaner ×1/.test(delivered?.body || '') && /Trash liners ×2/.test(delivered?.body || ''), JSON.stringify(delivered));
  const lineAct = world.tables.activity_log.find((a) => a.action === 'supply_order.lines_changed' && a.entity_id === 'f_one');
  ok('S131: the activity log has each act, named (supply_order.lines_changed)', !!lineAct && /Glass cleaner ×3 delivered/.test(lineAct.summary || '')
    && lineAct.before?.state === 'pending' && lineAct.after?.state === 'partial' && lineAct.actor_user_id === 'u_admin', JSON.stringify(lineAct));

  world.tables.org_state[0].state.notifications = [];
  const eta = addDaysKey(TODAY, 7);
  const bo = await fulfill('f_one', 'admin', [{ line: 1, act: 'backorder', eta }]);
  ok('🔴 S131: a line is BACKORDERED with the supplier\'s ETA', bo.status === 200 && rowOf('f_one').fulfillment[1].backorder?.eta === eta
    && bo.body.progress?.lines?.[1]?.state === S.SUPPLY_LINE_STATE.backordered && bo.body.progress.lines[1].eta === eta && bo.body.progress.backordered === 1, show(bo));
  ok('… and the asker and the account manager hear it, with the line', JSON.stringify(bells('supplyItemBackordered')) === JSON.stringify(['u_mgrA', 'u_mgrB'])
    && /Trash liners/.test((world.tables.org_state[0].state.notifications || []).find((n) => n.eventKey === 'supplyItemBackordered')?.title || ''), JSON.stringify(world.tables.org_state[0].state.notifications));
  for (const [bad, why] of [[addDaysKey(TODAY, -1), 'yesterday'], [addDaysKey(TODAY, S.SUPPLY_ETA_MAX_DAYS + 1), 'past a year'], ['soon', 'not a day']]) {
    const r = await fulfill('f_one', 'admin', [{ line: 1, act: 'backorder', eta: bad }]);
    ok(`an ETA ${why} is refused by name (400 bad_eta), nothing moves`, r.status === 400 && r.body.code === 'bad_eta' && r.body.line === 1
      && rowOf('f_one').fulfillment[1].backorder?.eta === eta, show(r));
  }
  for (const reason of [undefined, '  ', 'no', 'x'.repeat(S.SUPPLY_CANCEL_REASON_MAX + 1)]) {
    const r = await fulfill('f_one', 'admin', [{ line: 2, act: 'cancel', reason }]);
    ok(`a cancel without a reason of ${S.SUPPLY_CANCEL_REASON_MIN}–${S.SUPPLY_CANCEL_REASON_MAX} characters is refused (${JSON.stringify(reason)?.slice(0, 12)})`,
      r.status === 400 && r.body.code === 'bad_reason' && rowOf('f_one').fulfillment[2].cancelled === null, show(r));
  }
  world.tables.org_state[0].state.notifications = [];
  const cx = await fulfill('f_one', 'admin', [{ line: 2, act: 'cancel', reason: 'Discontinued by the supplier' }]);
  ok('🔴 S131: a line is CANCELLED with a reason (a discontinued item)', cx.status === 200 && rowOf('f_one').fulfillment[2].cancelled?.reason === 'Discontinued by the supplier'
    && cx.body.progress?.lines?.[2]?.state === S.SUPPLY_LINE_STATE.cancelled, show(cx));
  ok('… and the asker and the account manager hear it, with the reason', JSON.stringify(bells('supplyItemCancelled')) === JSON.stringify(['u_mgrA', 'u_mgrB'])
    && /Discontinued by the supplier/.test((world.tables.org_state[0].state.notifications || []).find((n) => n.eventKey === 'supplyItemCancelled')?.body || ''));

  // The refusals, each by name, and nothing written.
  const versionNow = rowOf('f_one').version;
  const cases = [
    [[{ line: 0, act: 'deliver', qty: 2 }], 400, 'bad_qty', 'more than is still to come'],
    [[{ line: 0, act: 'deliver', qty: 0 }], 400, 'bad_qty', 'none'],
    [[{ line: 0, act: 'deliver', qty: 0.5 }], 400, 'bad_qty', 'a fraction'],
    [[{ line: 2, act: 'deliver' }], 409, 'line_resolved', 'a cancelled line'],
    [[{ line: 9, act: 'deliver' }], 400, 'bad_line', 'a line the order does not have'],
    [[{ line: 0, act: 'frobnicate' }], 400, 'bad_act', 'an act there is none of'],
    [[], 400, 'no_acts', 'no act at all'],
    [Array.from({ length: S.SUPPLY_FULFILL_MAX_ACTS + 1 }, () => ({ line: 0, act: 'deliver', qty: 1 })), 400, 'too_many', 'too many acts'],
    [[{ line: 0, act: 'deliver', qty: 1 }, { line: 9, act: 'deliver' }], 400, 'bad_line', 'ALL OR NONE: a good act with a bad one'],
  ];
  for (const [acts, status, want, why] of cases) {
    const r = await fulfill('f_one', 'admin', acts);
    ok(`🔴 ${why} → ${status} ${want}, nothing written`, r.status === status && r.body.code === want && rowOf('f_one').version === versionNow
      && supplyRemaining('f_one', 0) === 1, show(r));
  }
  const stale = await fulfill('f_one', 'admin', [{ line: 0, act: 'deliver' }], versionNow - 1);
  ok('🔴 a CAS on the version the page read: an order that moved since is 409 stale, never overwritten', stale.status === 409 && stale.body.code === 'stale'
    && rowOf('f_one').version === versionNow && supplyRemaining('f_one', 0) === 1, show(stale));
  for (const act of [{ line: 0, act: 'backorder', eta }, { line: 0, act: 'cancel', reason: 'Not needed' }]) {
    const r = await fulfill('f_one', 'mgrA', [act]);
    ok(`🔴 S131: a manager holding supplies.deliver but not supplies.manage may not ${act.act} a line (403 not_yours)`, r.status === 403 && r.body.code === 'not_yours'
      && rowOf('f_one').version === versionNow, show(r));
  }
  const notSent = await fulfill('f_appr', 'admin', [{ line: 0, act: 'deliver' }]);
  ok('an order not yet with the supplier takes no act (409 not_submitted)', notSent.status === 409 && notSent.body.code === 'not_submitted', show(notSent));
  const gone = await fulfill('f_gone', 'admin', [{ line: 0, act: 'deliver' }], 1);
  ok('an order that is gone is 404', gone.status === 404 && gone.body.code === 'not_found', show(gone));

  // 🔴 Mark Completed: only once every line is delivered or cancelled.
  const early = await complete('f_one');
  ok('🔴 S131: Mark Completed is REFUSED while a line is still to come (409 lines_open — "complete delivery to unlock")', early.status === 409
    && early.body.code === 'lines_open' && rowOf('f_one').status === 'sent', show(early));
  const rest = await deliverAll('f_one');
  ok('… the rest delivered (the backordered line too): every line resolved, "ready"', rest.status === 200 && rowOf('f_one').fulfillment_state === 'ready'
    && rest.body.progress?.ready === true && rowOf('f_one').status === 'sent', show(rest));
  const readyTab = await get('orders', 'admin', { status: 'partial' });
  ok('… and the order waits on the Partially fulfilled tab, ready to complete', (readyTab.body.orders || []).some((r) => r.id === 'f_one' && r.fulfillmentState === 'ready'), show(readyTab));
  const staleDone = await post('orders/complete', 'admin', { id: 'f_one', version: rowOf('f_one').version - 1 });
  ok('a completion on a stale read is 409 stale', staleDone.status === 409 && staleDone.body.code === 'stale' && rowOf('f_one').status === 'sent', show(staleDone));
  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  const done = await complete('f_one');
  ok('🔴 S131: Mark Completed closes it — who and when, every line\'s record kept', done.status === 200 && rowOf('f_one').status === 'completed'
    && !!rowOf('f_one').completed_at && rowOf('f_one').completer_name === 'admin person' && rowOf('f_one').fulfillment_state === 'ready'
    && rowOf('f_one').fulfillment[2].cancelled?.reason === 'Discontinued by the supplier' && rowOf('f_one').sender_name === 'admin person'
    && done.body.order?.status === 'completed' && done.body.progress?.ready === true, show(done));
  ok('… the asker and the account manager hear it is complete', JSON.stringify(bells('supplyOrderCompleted')) === JSON.stringify(['u_mgrA', 'u_mgrB']), JSON.stringify(bells('supplyOrderCompleted')));
  ok('… and the activity log has it, sent → completed', world.tables.activity_log.some((a) => a.action === 'supply_request.status_changed' && a.entity_id === 'f_one'
    && a.before?.status === 'sent' && a.after?.status === 'completed'));
  const twice = await complete('f_one');
  ok('completing it again is 409 illegal_move', twice.status === 409 && twice.body.code === 'illegal_move', show(twice));
  const afterDone = await fulfill('f_one', 'admin', [{ line: 0, act: 'deliver', qty: 1 }]);
  ok('a completed order takes no act (409 not_submitted)', afterDone.status === 409 && afterDone.body.code === 'not_submitted', show(afterDone));
  const ghost = await post('orders/complete', 'admin', { id: 'f_gone', version: 1 });
  ok('completing an order that is gone is 404', ghost.status === 404 && ghost.body.code === 'not_found', show(ghost));

  // 🔴 S131: usage and spend count each DELIVERY — what came, at its line's frozen price, in the month it came.
  const u = await get('usage', 'admin', { period: '30d', cust: 'cl_A' });
  const byName = Object.fromEntries((u.body.rows || []).map((r) => [r.name, r]));
  ok('🔴 S131: usage counts what was DELIVERED (all 4 glass, both liners; the cancelled bulb never)', u.status === 200
    && byName['Glass cleaner']?.qty === 4 && byName['Glass cleaner']?.total === 27.16 && byName['Trash liners']?.qty === 2 && !byName.Bulbs, show(u));
  const b = await get('budgets', 'admin');
  ok('🔴 S131: the month\'s spend is the delivered value, in integer cents', b.status === 200 && b.body.spendCents?.cl_A === 4 * 679 + 2 * 3290, show(b));
  // A delivery last month (in the org's zone) on an order completed this month is LAST month's spend;
  // a delivery today on an order still with the supplier is this month's.
  const monthStartMs = startOfDayKey(startOfMonthKey(TODAY), TZ).getTime();
  const D = (qty, at) => ({ qty, at: iso(at), byUserId: 'u_admin', byName: 'admin person', via: 'office' });
  world.tables.supply_requests.push(
    { id: 'm_done', number: 1901, organization_id: ORG, client_id: 'cl_B', status: 'completed', version: 3, created_at: iso(monthStartMs - 5 * HR),
      lines: [{ itemId: 'x', catalogItemId: 'sc_x', name: 'Mops', qty: 1, unitPriceCents: 5000 }, { itemId: 'y', catalogItemId: 'sc_y', name: 'Liners', qty: 1, unitPriceCents: 3290 }],
      fulfillment: [{ itemId: 'x', catalogItemId: 'sc_x', deliveries: [D(1, monthStartMs - HR)], backorder: null, cancelled: null },
        { itemId: 'y', catalogItemId: 'sc_y', deliveries: [D(1, NOW - 1000)], backorder: null, cancelled: null }],
      fulfillment_state: 'ready', sent_at: iso(monthStartMs - 2 * HR), completed_at: iso(NOW - 500) },
    { id: 'm_open', number: 1902, organization_id: ORG, client_id: 'cl_C', status: 'sent', version: 2, created_at: iso(monthStartMs - 5 * HR),
      lines: [{ itemId: 'z', catalogItemId: 'sc_z', name: 'Bulbs', qty: 5, unitPriceCents: 100 }],
      fulfillment: [{ itemId: 'z', catalogItemId: 'sc_z', deliveries: [D(2, NOW - 1000)], backorder: null, cancelled: null }],
      fulfillment_state: 'partial', sent_at: iso(monthStartMs - 2 * HR) },
  );
  const b2 = await get('budgets', 'admin');
  ok('🔴 S131: each delivery counts in ITS month — last month\'s delivery on an order completed today is not this month\'s spend',
    b2.body.spendCents?.cl_B === 3290, show(b2));
  ok('🔴 S131: … and a delivery on an order still with the supplier is spent the day it came (2 of 5)', b2.body.spendCents?.cl_C === 200, show(b2));
});
// The quantity still to come on one line of a stored order.
function supplyRemaining(id, line) { return progressOf(id)?.lines?.[line]?.remaining; }

// ── 17. 🔴 the driver PER LINE (EP-366 / EP-367), a CREW login holding ONLY the Deliveries grant ──
await section('17', async () => {
  build({
    overrides: [{ userId: 'u_driver', grants: ['supplies.deliver'], revokes: [] }],
    extra: { sites: [{ id: 'st_A', clientId: 'cl_A', name: 'Main', address: '1 Alpha Way, Fort Lauderdale, FL 33301' }, { id: 'st_B', clientId: 'cl_B', name: 'Tower', address: '2 Beta Blvd' }] },
  });
  const I = await seedCatalog();
  await submit('d_one', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 4 }, { itemId: I.A.liner, qty: 2 }], 'Leave it at the front desk');
  await submit('d_two', 'mgrB', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  await submit('d_appr', 'mgrA', 'cl_A', [{ itemId: I.A.bulb, qty: 1 }]);
  await post('requests/decide', 'admin', { ids: ['d_one', 'd_two', 'd_appr'], decision: 'approve' });
  await toSupplier(['d_one', 'd_two']);
  rowOf('d_one').sent_at = iso(NOW - HR); // submitted an hour before the other
  const eta = addDaysKey(TODAY, 3);
  await fulfill('d_one', 'admin', [{ line: 1, act: 'backorder', eta }]);

  const list = await get('deliveries', 'driver');
  ok('🔴 S3: a crew login with ONLY the grant lists every SUBMITTED order with something still to come (never one only approved), oldest submitted first',
    list.status === 200 && (list.body.toDeliver || []).map((r) => r.id).join() === 'd_one,d_two', show(list));
  const first = (list.body.toDeliver || [])[0] || {};
  ok('🔴 S131: … each with its number, building, address and version, and every LINE still to come — how many, and a backorder with its ETA',
    first.no === 'SO-1001' && first.version === rowOf('d_one').version && first.building?.name === 'Alpha Tower'
    && first.building?.address === '1 Alpha Way, Fort Lauderdale, FL 33301' && first.clientId === 'cl_A'
    && JSON.stringify(first.items) === JSON.stringify([
      { line: 0, name: 'Glass cleaner', sku: 'CL-1001', qty: 4, state: S.SUPPLY_LINE_STATE.pending, eta: null },
      { line: 1, name: 'Trash liners', sku: 'PP-2003', qty: 2, state: S.SUPPLY_LINE_STATE.backordered, eta },
    ]) && first.itemCount === 6 && first.sentByName === 'admin person' && first.sentAt === iso(NOW - HR), JSON.stringify(first));
  ok('🔴 S3: … and sees no price, no budget, no money anywhere', list.status === 200 && !MONEY.test(JSON.stringify(list.body)), JSON.stringify(list.body).slice(0, 400));

  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  const v = rowOf('d_one').version;
  const one = await post('requests/deliver', 'driver', { id: 'd_one', version: v, lines: [0] });
  const e0 = rowOf('d_one').fulfillment[0];
  ok('🔴 S131: the driver marks ONE line delivered — in full, stamped with their own name from the login, via the driver', one.status === 200 && one.body.ok === true
    && JSON.stringify(one.body.delivered) === '[0]' && one.body.version === v + 1
    && e0.deliveries.length === 1 && e0.deliveries[0].qty === 4 && e0.deliveries[0].byUserId === 'u_driver' && e0.deliveries[0].byName === 'Alberto Reyes'
    && e0.deliveries[0].via === 'driver' && rowOf('d_one').status === 'sent' && rowOf('d_one').fulfillment_state === 'partial', show(one));
  ok('🔴 S3: … its answer carries no order — no lines, no names, no prices', !MONEY.test(JSON.stringify(one.body)) && !/"lines"|"items"|"name"/.test(JSON.stringify(one.body)), show(one));
  ok('… and the asker and the account manager hear what came (the driver skipped)', JSON.stringify(bells('supplyItemsDelivered')) === JSON.stringify(['u_mgrA', 'u_mgrB']),
    JSON.stringify(bells('supplyItemsDelivered')));
  ok('… and the activity log has it, by the driver', world.tables.activity_log.some((a) => a.action === 'supply_order.lines_changed' && a.entity_id === 'd_one' && a.actor_user_id === 'u_driver'));
  const again = await post('requests/deliver', 'driver', { id: 'd_one', version: v, lines: [0] });
  ok('🔴 the same Delivered on the list it read (a stale version) is 409 stale, never twice', again.status === 409 && again.body.code === 'stale'
    && rowOf('d_one').fulfillment[0].deliveries.length === 1, show(again));
  const resolved = await post('requests/deliver', 'driver', { id: 'd_one', version: rowOf('d_one').version, lines: [0] });
  ok('… and a line already delivered is 409 line_resolved', resolved.status === 409 && resolved.body.code === 'line_resolved', show(resolved));
  const rest = await post('requests/deliver', 'driver', { id: 'd_one', version: rowOf('d_one').version });
  ok('🔴 S131: "All delivered" (no lines named) delivers every line still to come — the backordered one too — and leaves completing to the office',
    rest.status === 200 && JSON.stringify(rest.body.delivered) === '[1]' && rowOf('d_one').fulfillment_state === 'ready' && rowOf('d_one').status === 'sent', show(rest));
  const nothing = await post('requests/deliver', 'driver', { id: 'd_one', version: rowOf('d_one').version });
  ok('… and once nothing is left: 409 nothing_to_deliver', nothing.status === 409 && nothing.body.code === 'nothing_to_deliver', show(nothing));
  const appr = await post('requests/deliver', 'driver', { id: 'd_appr', version: rowOf('d_appr').version });
  ok('an order only approved (not with the supplier) takes no Delivered (409 not_submitted)', appr.status === 409 && appr.body.code === 'not_submitted'
    && rowOf('d_appr').status === 'approved', show(appr));
  const ghost = await post('requests/deliver', 'driver', { id: 'd_gone', version: 1 });
  ok('an order that is gone is 404', ghost.status === 404 && ghost.body.code === 'not_found', show(ghost));
  const after = await get('deliveries', 'driver');
  ok('S4: the list keeps only what is still to come, and shows today\'s deliveries — what, who and when', (after.body.toDeliver || []).map((r) => r.id).join() === 'd_two'
    && (after.body.deliveredToday || []).map((r) => r.id).join() === 'd_one'
    && JSON.stringify(after.body.deliveredToday[0].items) === JSON.stringify([{ name: 'Glass cleaner', qty: 4 }, { name: 'Trash liners', qty: 2 }])
    && after.body.deliveredToday[0].deliveredByName === 'Alberto Reyes' && after.body.deliveredToday[0].no === 'SO-1001'
    && !!after.body.deliveredToday[0].deliveredAt && !MONEY.test(JSON.stringify(after.body)), show(after));

  // Through the order page's door, the driver may only DELIVER.
  const viaFulfill = await fulfill('d_two', 'driver', [{ line: 0, act: 'deliver' }]);
  ok('S131: through orders/fulfill the driver may deliver — answered with no order and no money', viaFulfill.status === 200 && viaFulfill.body.id === 'd_two'
    && !('order' in viaFulfill.body) && !MONEY.test(JSON.stringify(viaFulfill.body)) && rowOf('d_two').fulfillment_state === 'ready', show(viaFulfill));
  await submit('d_three', 'mgrB', 'cl_B', [{ itemId: I.B.glass, qty: 2 }]);
  await post('requests/decide', 'admin', { ids: ['d_three'], decision: 'approve' });
  await toSupplier(['d_three']);
  for (const act of [{ line: 0, act: 'backorder', eta }, { line: 0, act: 'cancel', reason: 'Not needed' }]) {
    const r = await fulfill('d_three', 'driver', [act]);
    ok(`🔴 S131: … and never ${act.act === 'cancel' ? 'cancel' : 'backorder'} a line (403 not_yours — the Supply Manager's)`, r.status === 403 && r.body.code === 'not_yours'
      && rowOf('d_three').fulfillment[0].backorder === null && rowOf('d_three').fulfillment[0].cancelled === null, show(r));
  }
  const doneByDriver = await complete('d_two', 'driver');
  ok('🔴 S131: … and never complete an order', doneByDriver.status === 403 && rowOf('d_two').status === 'sent', show(doneByDriver));

  const refusals = [
    ['GET', 'requests', null, { building: 'cl_A' }], ['GET', 'orders', null, {}], ['GET', 'orders', null, { countsOnly: '1' }], ['GET', 'order', null, { id: 'd_one' }],
    ['GET', 'orders/invoice/view-url', null, { id: 'x' }],
    ['GET', 'items', null, { clientId: 'cl_A' }], ['GET', 'catalog', null, {}], ['GET', 'usage', null, {}],
    ['GET', 'budgets', null, {}], ['GET', 'buildings', null, {}],
    ['POST', 'requests/decide', { ids: ['d_appr'], decision: 'approve' }], ['POST', 'requests/decide', { ids: ['d_appr'], decision: 'reject', reason: 'no' }],
    ['POST', 'orders/submit', { ids: ['d_appr'] }], ['POST', 'orders/complete', { id: 'd_two', version: 1 }],
    ['POST', 'orders/comment', { id: 'src_x', requestId: 'd_one', body: 'hi' }],
    ['POST', 'orders/invoice/upload-url', { requestId: 'd_one', docId: 'sdoc_x', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
    ['POST', 'requests/create', { id: 'a_new', clientId: 'cl_A', lines: [{ itemId: I.A.glass, qty: 1 }] }],
    ['POST', 'requests/cancel', { id: 'd_appr' }],
    ['POST', 'catalog/save', { id: 'sc_x', name: 'X' }], ['POST', 'catalog/image', { id: 'sc_glass', remove: true }], ['POST', 'items/assign', { clientId: 'cl_A', on: ['sc_glass'] }],
  ];
  for (const [m, p, body, query = {}] of refusals) {
    const r = await call(handler, { method: m, path: p, token: tok('driver'), body: body || undefined, query });
    ok(`🔴 S3: the grant opens nothing else — ${m} ${p}${Object.keys(query).length ? `?${Object.keys(query).join('&')}` : ''} → 403`, r.status === 403, show(r));
  }
  ok('… and nothing else moved', rowOf('d_appr').status === 'approved' && !rowOf('a_new') && world.tables.supply_catalog.every((r) => r.id !== 'sc_x')
    && world.tables.supply_request_comments.length === 0);
  // A manager pared off the Deliveries key (the office tiers hold it by default, S35).
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_mgrA', grants: [], revokes: ['supplies.deliver'] }];
  const mgr = await post('requests/deliver', 'mgrA', { id: 'd_three', version: rowOf('d_three').version });
  ok('a manager pared off the Deliveries key cannot mark it delivered', mgr.status === 403 && rowOf('d_three').fulfillment[0].deliveries.length === 0, show(mgr));
  const mgrList = await get('deliveries', 'mgrA');
  ok('… nor read the list', mgrList.status === 403, show(mgrList));
  // The same crew login WITHOUT the grant is refused both.
  build();
  const none = await get('deliveries', 'driver');
  ok('the same crew login WITHOUT the grant is refused the list', none.status === 403, show(none));
  const noneDel = await post('requests/deliver', 'driver', { id: 'd_one', version: 1 });
  ok('… and Delivered', noneDel.status === 403, show(noneDel));
});

// ── 18. 🔴 the cleaner's read (EP-368): their buildings today, names and quantities ──
await section('18', async () => {
  const startToday = startOfDayKey(TODAY, TZ).getTime();
  const job = (id, clientId, crewIds, startMs, extra = {}) => ({
    id, organization_id: ORG, start_at: iso(startMs),
    data: { id, clientId, crewIds, startAt: iso(startMs), endAt: iso(startMs + 2 * HR), status: 'scheduled', ...extra },
  });
  build({ overrides: [{ userId: 'u_driver', grants: ['supplies.deliver'], revokes: [] }] }, {
    jobs: [
      job('j_today_A', 'cl_A', ['u_crew'], startToday + 12 * HR),
      job('j_tomorrow_B', 'cl_B', ['u_crew'], startOfDayKey(addDaysKey(TODAY, 1), TZ).getTime() + 12 * HR),
      job('j_today_C_other', 'cl_C', ['u_other'], startToday + 12 * HR),
      job('j_today_C_cancelled', 'cl_C', ['u_crew'], startToday + 13 * HR, { status: 'cancelled' }),
    ],
  });
  const I = await seedCatalog();
  await post('items/assign', 'admin', { clientId: 'cl_C', on: ['sc_glass'] });
  await submit('o_sent', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 4 }, { itemId: I.A.liner, qty: 2 }]);
  await submit('o_today', 'mgrA', 'cl_A', [{ itemId: I.A.bulb, qty: 6 }]);
  await submit('o_yday', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('o_beta', 'mgrB', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  await submit('o_gamma', 'admin', 'cl_C', [{ itemId: itemOf('cl_C', 'sc_glass'), qty: 1 }]);
  await submit('o_appr', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 9 }]);
  // S131 Builder C: a line backordered with the supplier's day (the line reads "backordered — ETA").
  await submit('o_back', 'mgrA', 'cl_A', [{ itemId: I.A.liner, qty: 3 }]);
  await post('requests/decide', 'admin', { ids: ['o_sent', 'o_today', 'o_yday', 'o_beta', 'o_gamma', 'o_appr', 'o_back'], decision: 'approve' });
  await toSupplier(['o_sent', 'o_today', 'o_yday', 'o_beta', 'o_gamma', 'o_back']);
  await fulfill('o_sent', 'admin', [{ line: 1, act: 'cancel', reason: 'Out of stock' }]);
  await fulfill('o_back', 'admin', [{ line: 0, act: 'backorder', eta: addDaysKey(TODAY, 7) }]);
  for (const id of ['o_today', 'o_yday']) {
    await post('requests/deliver', 'driver', { id, version: rowOf(id).version });
    await complete(id);
  }
  // o_yday landed yesterday, in the org's calendar.
  rowOf('o_yday').completed_at = iso(startToday - HR);
  rowOf('o_yday').fulfillment[0].deliveries[0].at = iso(startToday - 2 * HR);
  const readFrom = world.log.length;
  const r = await get('onsite', 'crew');
  ok('🔴 S6: a cleaner reads the supplies of the buildings they clean TODAY — and only those', r.status === 200
    && (r.body.buildings || []).map((b) => b.clientId).join() === 'cl_A', show(r));
  const a = (r.body.buildings || [])[0] || {};
  // S131 Builder C: the line goes PER LINE — "Paper towels delivered today at 9:15 AM", "Trash liners
  // backordered — ETA Oct 21", "Supplies on the way: …" — the same building-level line every cleaner there reads.
  ok('🔴 S131: … per building, per LINE: what came today, what is backordered, what is on the way — nothing else',
    JSON.stringify(Object.keys(a)) === JSON.stringify(['clientId', 'delivered', 'backordered', 'onTheWay']), JSON.stringify(a));
  ok('🔴 S131: … "on the way": each submitted line still to come and not backordered (a cancelled line left out; an approved order not yet)',
    JSON.stringify(a.onTheWay) === JSON.stringify([{ name: 'Glass cleaner', qty: 4 }]), JSON.stringify(a));
  ok('🔴 S131: … "backordered": each backordered line still to come, with the supplier\'s day',
    JSON.stringify(a.backordered) === JSON.stringify([{ name: 'Trash liners', qty: 3, eta: addDaysKey(TODAY, 7) }]), JSON.stringify(a));
  ok('… "delivered today": each line that came, how many and when — yesterday\'s is gone', (a.delivered || []).length === 1
    && a.delivered[0].name === 'Bulbs' && a.delivered[0].qty === 6 && !!a.delivered[0].at && Object.keys(a.delivered[0]).join() === 'name,qty,at', JSON.stringify(a));
  ok('🔴 S6: no price, budget, SKU, note, reason or name reaches a cleaner', r.status === 200 && !/unitPrice|price|cents|total|budget|spend|sku|note|reason|Out of stock|Reyes|person|"by"/i.test(JSON.stringify(r.body)),
    JSON.stringify(r.body));
  const reads = world.log.slice(readFrom).filter((q) => q.table === 'supply_requests' && q.op === 'select');
  ok('… and its read never asks for every column', reads.length > 0 && reads.every((q) => q.cols !== '*'), JSON.stringify(reads.map((q) => q.cols)));
  const from = world.log.length;
  const mgr = await get('onsite', 'mgrA');
  ok('the read is the CALLER\'s own day: a manager on no clean today reads nothing, and nothing is queried', mgr.status === 200
    && (mgr.body.buildings || []).length === 0 && !world.log.slice(from).some((q) => q.table === 'supply_requests'), show(mgr));
  const anon = await get('onsite', null);
  ok('no login is refused', anon.status === 401, show(anon));
});

// ── 19. 🔴 CS-670 / CS-790: Cancel — before it goes out, recorded, said, never a ghost ──────
// Daniel (2026-10-12): stop cancels once an order has gone out. WHO stays CS-596 (your own while it
// waits; the approver and the office, any). A sent order is on the van and the cleaners see it
// coming; a delivered one is usage, spend and the budget's history — Reopen is the correction.
await section('19', async () => {
  build();
  const I = await seedCatalog();
  // All at Alpha Tower (approver: its supervisor mgrA), asked for by mgrB.
  for (const id of ['c_req', 'c_appr', 'c_sent', 'c_done', 'c_rej']) {
    await submit(id, 'mgrB', 'cl_A', id === 'c_appr' ? [{ itemId: I.A.glass, qty: 3 }, { itemId: I.A.liner, qty: 1 }] : [{ itemId: I.A.glass, qty: 1 }]);
  }
  await post('requests/decide', 'mgrA', { ids: ['c_appr', 'c_sent', 'c_done'], decision: 'approve' });
  await post('requests/decide', 'mgrA', { ids: ['c_rej'], decision: 'reject', reason: 'Ordered last week' });
  await toSupplier(['c_sent', 'c_done']);
  await deliverAll('c_done');
  await complete('c_done');
  ok('(setup) one request in each state', ['open', 'approved', 'sent', 'completed', 'rejected']
    .every((st, i) => rowOf(['c_req', 'c_appr', 'c_sent', 'c_done', 'c_rej'][i])?.status === st));
  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  const usageBefore = await get('usage', 'admin', { period: '30d', cust: 'cl_A' });
  const spendBefore = await get('budgets', 'admin');

  for (const [id, who] of [['c_sent', 'admin'], ['c_sent', 'owner'], ['c_sent', 'mgrA'], ['c_done', 'admin'], ['c_done', 'owner'], ['c_done', 'mgrA'], ['c_rej', 'admin'], ['c_rej', 'mgrA']]) {
    const st = rowOf(id)?.status;
    const r = await post('requests/cancel', who, { id });
    ok(`🔴 CS-670: ${who} cannot cancel a ${st === 'completed' ? 'completed' : st === 'sent' ? 'submitted' : st} request — 409 not_cancellable, the row kept`,
      r.status === 409 && r.body.code === 'not_cancellable' && rowOf(id)?.status === st, show(r));
  }
  const usageAfter = await get('usage', 'admin', { period: '30d', cust: 'cl_A' });
  const spendAfter = await get('budgets', 'admin');
  ok('🔴 CS-670: … so the completed order still counts in usage and the month\'s spend', usageBefore.status === 200
    && JSON.stringify(usageAfter.body.rows) === JSON.stringify(usageBefore.body.rows) && (usageAfter.body.rows || []).length > 0
    && spendAfter.body.spendCents?.cl_A === spendBefore.body.spendCents?.cl_A && spendAfter.body.spendCents?.cl_A > 0, show(usageAfter));
  ok('… and the driver still has the sent one to deliver', ((await get('deliveries', 'admin')).body.toDeliver || []).some((r) => r.id === 'c_sent'));
  ok('… and a refused cancel writes nothing (no activity row, no bell)', world.tables.activity_log.length === 0
    && (world.tables.org_state[0].state.notifications || []).length === 0);
  const reopen = await post('requests/decide', 'admin', { ids: ['c_sent'], decision: 'reopen' });
  ok('CS-670: Reopen stays the office\'s correction for an order with the supplier, while nothing came (recorded)', reopen.body.results?.[0]?.ok === true && rowOf('c_sent')?.status === 'open'
    && world.tables.activity_log.some((x) => x.action === 'supply_request.status_changed' && x.entity_id === 'c_sent'), show(reopen));
  world.tables.activity_log = [];

  // The approver cancels an APPROVED request (mgrB's): recorded, and the requester told.
  const a = await post('requests/cancel', 'mgrA', { id: 'c_appr' });
  ok('CS-596 kept: the building\'s approver may cancel an approved request', a.status === 200 && a.body.ok === true && !rowOf('c_appr'), show(a));
  const act = world.tables.activity_log.find((x) => x.action === 'supply_request.cancelled' && x.entity_id === 'c_appr');
  ok('🔴 CS-670: a cancel writes an activity row — who, which building, and what it was (the record keeps nothing else of it)',
    !!act && act.actor_user_id === 'u_mgrA' && act.client_id === 'cl_A' && act.client_name === 'Alpha Tower' && act.before?.status === 'approved'
    && act.before?.requestedBy === 'mgrB person' && act.before?.items === 'Glass cleaner ×3, Trash liners ×1'
    && /Alpha Tower/.test(act.summary || '') && /approved/.test(act.summary || ''), JSON.stringify(act));
  ok('🔴 CS-670: … and tells the requester (the approver who cancelled is not told)', JSON.stringify(bells('supplyRequestCancelled')) === JSON.stringify(['u_mgrB']),
    JSON.stringify(bells('supplyRequestCancelled')));

  world.tables.org_state[0].state.notifications = [];
  const own = await post('requests/cancel', 'mgrB', { id: 'c_req' });
  ok('CS-596 kept: a requester withdraws their own request while it waits — and the APPROVER is told', own.status === 200 && !rowOf('c_req')
    && JSON.stringify(bells('supplyRequestCancelled')) === JSON.stringify(['u_mgrA']), `${show(own)} ${JSON.stringify(bells('supplyRequestCancelled'))}`);

  await submit('c_office', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  world.tables.org_state[0].state.notifications = [];
  const off = await post('requests/cancel', 'admin', { id: 'c_office' });
  ok('the office cancels: the requester AND the approver are told', off.status === 200 && !rowOf('c_office')
    && JSON.stringify(bells('supplyRequestCancelled')) === JSON.stringify(['u_mgrA', 'u_mgrB']), `${show(off)} ${JSON.stringify(bells('supplyRequestCancelled'))}`);
  ok('… three cancels, three activity rows, each in the supplies group', world.tables.activity_log.filter((x) => x.action === 'supply_request.cancelled').length === 3);

  // 🔴 CS-790 (the audit's s04 shape, through the route): an approval lands between the cancel's
  // read and its version-guarded delete, so the delete matches nothing.
  await submit('c_race', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  world.tables.org_state[0].state.notifications = [];
  const actsBefore = world.tables.activity_log.length;
  world.beforeQuery = async (q) => {
    if (q.table === 'supply_requests' && q.op === 'delete' && q.eq.id === 'c_race') {
      const r = rowOf('c_race');
      r.status = 'approved';
      r.version += 1;
    }
  };
  const race = await post('requests/cancel', 'mgrB', { id: 'c_race' });
  world.beforeQuery = null;
  ok('🔴 CS-790: a cancel whose delete matched nothing answers 409 "stale" — never "cancelled"', race.status === 409 && race.body.code === 'stale', show(race));
  ok('🔴 CS-790: … the request lives on, approved, and nothing was recorded or rung', rowOf('c_race')?.status === 'approved'
    && world.tables.activity_log.length === actsBefore && bells('supplyRequestCancelled').length === 0);
  const gone = await post('requests/cancel', 'admin', { id: 'c_appr' });
  ok('cancelling a request that is already gone is a 404, not a second success', gone.status === 404 && gone.body.code === 'not_found', show(gone));
});

// ── 20. 🔴 the CLEANER asks for supplies (the Cleaner Hub, D4; plan 2026-10-13) ──────────────
// Matt: "Request Supplies: flag low or out items for their property … I need this option to be
// turned on or off … We can remove their access." A cleaner holds `supplies.request` by default
// (a per-cleaner revoke switches it off); the building must be one they clean — today or upcoming;
// their read carries NO money; their request goes to the building's approver like any other.
await section('20', async () => {
  const startToday = startOfDayKey(TODAY, TZ).getTime();
  const HR = 3600000;
  const job = (id, clientId, crewIds, startMs, extra = {}) => ({
    id, organization_id: ORG, start_at: iso(startMs), status: extra.status || 'upcoming',
    data: { id, clientId, crewIds, startAt: iso(startMs), endAt: iso(startMs + 2 * HR), status: 'upcoming', ...extra },
  });
  const jobs = [
    job('j_A_today', 'cl_A', ['u_crew'], startToday + 20 * HR),                                          // tonight at Alpha
    job('j_B_next_week', 'cl_B', ['u_crew'], startOfDayKey(addDaysKey(TODAY, 7), TZ).getTime() + 12 * HR), // upcoming at Beta
    job('j_C_last_week', 'cl_C', ['u_crew'], startOfDayKey(addDaysKey(TODAY, -7), TZ).getTime() + 12 * HR), // only in the past at Gamma
    job('j_C_today_x', 'cl_C', ['u_crew'], startToday + 21 * HR, { status: 'cancelled' }),               // and cancelled tonight
  ];
  build({}, { jobs });
  const I = await seedCatalog();
  await post('items/assign', 'admin', { clientId: 'cl_C', on: ['sc_glass'] });
  // In hand for Alpha: one waiting, one approved, one on the way, one delivered today.
  await submit('w_wait', 'mgrA', 'cl_A', [{ itemId: I.A.liner, qty: 2 }]);
  await submit('w_appr', 'mgrA', 'cl_A', [{ itemId: I.A.bulb, qty: 1 }]);
  await submit('w_sent', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 4 }, { itemId: I.A.liner, qty: 1 }]);
  await submit('w_done', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 2 }]);
  await post('requests/decide', 'admin', { ids: ['w_appr', 'w_sent', 'w_done'], decision: 'approve' });
  await toSupplier(['w_sent', 'w_done']);
  // S131: the liners on w_sent are cancelled (the supplier is out); w_done is delivered and completed.
  await fulfill('w_sent', 'admin', [{ line: 1, act: 'cancel', reason: 'Out of stock' }]);
  await deliverAll('w_done');
  await complete('w_done');

  // ── the read: GET crew-list (EP-385) ──
  const from = world.log.length;
  const r = await get('crew-list', 'crew', { clientId: 'cl_A' });
  ok('🔴 D4: a cleaner reads the list of a building they clean TODAY', r.status === 200 && Array.isArray(r.body.items) && r.body.items.length === 3, show(r));
  ok('… each item is exactly what the screen needs, field by field (no price, no budget)', r.status === 200
    && r.body.items.every((x) => JSON.stringify(Object.keys(x)) === JSON.stringify(S.SUPPLY_CREW_ITEM_KEYS || ['?'])), JSON.stringify(r.body.items?.[0]));
  const glass = (r.body.items || []).find((x) => x.catalogItemId === 'sc_glass');
  ok('… the item by name, how it comes, its category and SKU', !!glass && glass.name === 'Glass cleaner' && glass.unit === 'each' && glass.category === 'Liquids' && glass.sku === 'CL-1001' && glass.id === I.A.glass, JSON.stringify(glass));
  ok('🔴 NO MONEY reaches a cleaner: no price, cents, total, budget or spend anywhere in the answer', r.status === 200 && !MONEY.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 500));
  // S131 Builder C: the old status card's reads (every order in hand here, today's deliveries) are
  // replaced by the cleaner's OWN orders here — the account manager's four are never theirs.
  ok('🔴 S131: the cleaner reads only their OWN orders here — none yet (the account manager\'s are never theirs); the old in-hand reads are gone',
    r.status === 200 && Array.isArray(r.body.orders) && r.body.orders.length === 0 && !('open' in r.body) && !('deliveredToday' in r.body), JSON.stringify(r.body).slice(0, 400));
  ok('… and who approves a new order, as "First L." (the success line names them)', r.body.approverName === 'mgrA P.', JSON.stringify(r.body.approverName));
  ok('… its reads never ask supply_requests for every column', world.log.slice(from).filter((q) => q.table === 'supply_requests' && q.op === 'select').every((q) => q.cols !== '*')
    && world.log.slice(from).some((q) => q.table === 'supply_requests' && q.op === 'select'), JSON.stringify(world.log.slice(from).filter((q) => q.table === 'supply_requests').map((q) => q.cols)));
  const upcoming = await get('crew-list', 'crew', { clientId: 'cl_B' });
  ok('🔴 a building they clean UPCOMING (next week) is theirs too', upcoming.status === 200 && upcoming.body.items.length === 1, show(upcoming));
  const past = await get('crew-list', 'crew', { clientId: 'cl_C' });
  ok('🔴 a building they cleaned only in the past (and whose clean tonight is cancelled) is NOT theirs → 403 not_your_building', past.status === 403 && past.body.code === 'not_your_building', show(past));
  const driver = await get('crew-list', 'driver', { clientId: 'cl_A' });
  ok('🔴 a cleaner on no clean there reads nothing (403)', driver.status === 403 && driver.body.code === 'not_your_building', show(driver));
  const office = await get('crew-list', 'mgrB', { clientId: 'cl_A' });
  ok('the office (any office role holding the key) reads any building — the owner\'s View-as reads through it', office.status === 200 && office.body.items.length === 3, show(office));
  const noId = await get('crew-list', 'crew', {});
  ok('a read names one building (400)', noId.status === 400, show(noId));
  const ghost = await get('crew-list', 'admin', { clientId: 'cl_nope' });
  ok('a building that does not exist is 404 for the office', ghost.status === 404 && ghost.body.code === 'unknown_client', show(ghost));

  // ── the write: requests/create ──
  world.tables.org_state[0].state.notifications = [];
  const c = await submit('k_one', 'crew', 'cl_A', [{ itemId: I.A.glass, qty: 2 }, { itemId: I.A.liner, qty: 1, unitPrice: 0.01 }], 'Out of glass cleaner on 3');
  const row = rowOf('k_one');
  ok('🔴 D4: a cleaner asks for supplies at a building they clean — stored as requested, THEIRS (the claim)', c.status === 200 && c.body.created === true
    && row?.status === 'open' && row.requested_by_user_id === 'u_crew' && row.requester_name === 'crew person' && row.note === 'Out of glass cleaner on 3', show(c));
  ok('… its lines snapshotted from the building\'s list as any request (the body\'s price ignored)', row && row.total_cents === 2 * 679 + 3290
    && JSON.stringify(row.lines.map((l) => [l.catalogItemId, l.qty])) === JSON.stringify([['sc_glass', 2], ['sc_liner', 1]]), JSON.stringify(row?.lines));
  ok('🔴 … and the answer to a cleaner carries no money (a field-by-field shape)', c.status === 200 && !MONEY.test(JSON.stringify(c.body))
    && c.body.request?.id === 'k_one' && JSON.stringify(c.body.request?.items) === JSON.stringify([{ name: 'Glass cleaner', qty: 2 }, { name: 'Trash liners', qty: 1 }]), show(c));
  ok('SUP-11: it goes to the building\'s APPROVER, like any request', JSON.stringify(bells('supplyRequestSubmitted')) === JSON.stringify(['u_mgrA']), JSON.stringify(bells('supplyRequestSubmitted')));
  const readBack = await get('crew-list', 'crew', { clientId: 'cl_A' });
  const theirs = readBack.body.orders || [];
  ok('🔴 S131: … and it is now theirs to read back: its number, waiting for approval, its lines as names and quantities — field by field, no money, no note',
    readBack.status === 200 && theirs.length === 1 && theirs[0].id === 'k_one' && theirs[0].no === `SO-${row?.number}` && theirs[0].status === 'open'
    && JSON.stringify(Object.keys(theirs[0])) === JSON.stringify(S.SUPPLY_CREW_ORDER_KEYS || ['?'])
    && JSON.stringify(theirs[0].lines.map((l) => [l.name, l.qty, l.state])) === JSON.stringify([['Glass cleaner', 2, 'pending'], ['Trash liners', 1, 'pending']])
    && !MONEY.test(JSON.stringify(readBack.body)) && !/Out of glass cleaner/.test(JSON.stringify(readBack.body)), JSON.stringify(theirs));
  const replay = await submit('k_one', 'crew', 'cl_A', [{ itemId: I.A.glass, qty: 9 }]);
  ok('a retried send (same id) creates nothing, and still shows no money', replay.status === 200 && replay.body.created === false && !MONEY.test(JSON.stringify(replay.body))
    && world.tables.supply_requests.filter((x) => x.id === 'k_one').length === 1, show(replay));
  const nextWeek = await submit('k_two', 'crew', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  ok('a building they clean next week is theirs to ask for', nextWeek.status === 200 && rowOf('k_two')?.requested_by_user_id === 'u_crew', show(nextWeek));
  const notTheirs = await submit('k_three', 'crew', 'cl_C', [{ itemId: itemOf('cl_C', 'sc_glass'), qty: 1 }]);
  ok('🔴 a building they do not clean → 403 not_your_building, nothing stored', notTheirs.status === 403 && notTheirs.body.code === 'not_your_building' && !rowOf('k_three'), show(notTheirs));
  const officeAsk = await submit('k_four', 'mgrB', 'cl_C', [{ itemId: itemOf('cl_C', 'sc_glass'), qty: 1 }]);
  ok('… while the office still asks for any building, and its answer still carries the request\'s money (supplies.view)', officeAsk.status === 200
    && officeAsk.body.request?.lines?.[0]?.unitPrice === 6.79, show(officeAsk));
  const ownCancel = await post('requests/cancel', 'crew', { id: 'k_two' });
  ok('CS-596: a cleaner may withdraw their OWN request while it waits', ownCancel.status === 200 && !rowOf('k_two'), show(ownCancel));
  const otherCancel = await post('requests/cancel', 'crew', { id: 'w_wait' });
  ok('🔴 … but never someone else\'s (403 not_yours)', otherCancel.status === 403 && otherCancel.body.code === 'not_yours' && !!rowOf('w_wait'), show(otherCancel));

  // ── the switch: a per-cleaner revoke, and the stored matrix ──
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_crew', grants: [], revokes: ['supplies.request'] }];
  const offRead = await get('crew-list', 'crew', { clientId: 'cl_A' });
  const offAsk = await submit('k_five', 'crew', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  ok('🔴 the cleaner\'s switch OFF (a revoke of supplies.request) blocks the read', offRead.status === 403, show(offRead));
  ok('🔴 … and the request, nothing stored', offAsk.status === 403 && !rowOf('k_five'), show(offAsk));
  world.tables.org_state[0].state.userPermissionOverrides = [];
  world.tables.org_state[0].state.permissions = matrix().map((p) => (p.id === 'supplies.request' ? { ...p, roles: ['owner', 'admin', 'manager'] } : p));
  const oldMatrix = await get('crew-list', 'crew', { clientId: 'cl_A' });
  ok('a STORED matrix without crew on the row (production until the release adds it) still refuses cleaners — Settings → Roles is the switch for all',
    oldMatrix.status === 403, show(oldMatrix));
});

// ── 21. 🔴 THE QUEUE (EP-390): six tabs, the tiles, an order's number, the office only ──────────
await section('21', async () => {
  const DAY = 86400000;
  const startToday = startOfDayKey(TODAY, TZ).getTime();
  const D = (qty, at) => ({ qty, at: iso(at), byUserId: 'u_admin', byName: 'admin person', via: 'office' });
  const entry = (deliveries = []) => ({ itemId: 'si_glass', catalogItemId: 'sc_glass', deliveries, backorder: null, cancelled: null });
  // Higher numbers are newer, as the sequence makes them.
  const row = (id, number, clientId, status, extra = {}) => ({
    id, number, organization_id: ORG, client_id: clientId, status, version: 1,
    lines: [{ itemId: 'si_glass', catalogItemId: 'sc_glass', name: 'Glass cleaner', qty: 2, unitPriceCents: 679 }],
    total_cents: 1358, item_count: 2, search_text: 'glass cleaner', created_at: iso(NOW - (2000 - number) * 60000), ...extra,
  });
  const sent = (daysAgo) => ({ sent_at: iso(NOW - daysAgo * DAY), sender_name: 'admin person' });
  build({}, {
    supply_requests: [
      row('q_open_a', 1001, 'cl_A', 'open'),
      row('q_open_b', 1002, 'cl_B', 'open'),
      row('q_appr', 1003, 'cl_A', 'approved', { approved_at: iso(NOW - DAY) }),
      row('q_supplier', 1004, 'cl_A', 'sent', { ...sent(1), fulfillment: [entry()], fulfillment_state: 'pending' }),
      // submitted before the per-line record (the delivery step's row): With supplier too
      row('q_legacy', 1005, 'cl_B', 'sent', { ...sent(1), sent_lines: [{ itemId: 'si_glass', catalogItemId: 'sc_glass', qtySent: 2 }], sent_total_cents: 1358 }),
      row('q_partial', 1006, 'cl_A', 'sent', { ...sent(1), fulfillment: [entry([D(1, NOW - HR)])], fulfillment_state: 'partial' }),
      row('q_ready', 1007, 'cl_B', 'sent', { ...sent(1), fulfillment: [entry([D(2, NOW - HR)])], fulfillment_state: 'ready' }),
      row('q_done_today', 1008, 'cl_A', 'completed', { ...sent(1), fulfillment: [entry([D(2, NOW - HR)])], fulfillment_state: 'ready', completed_at: iso(Math.max(startToday, NOW - 60000)) }),
      row('q_done_week', 1009, 'cl_A', 'completed', { ...sent(8), completed_at: iso(NOW - 7 * DAY) }),
      // completed a minute before today began in the org's zone: not one of today's
      row('q_done_edge', 1010, 'cl_B', 'completed', { ...sent(2), completed_at: iso(startToday - 60000) }),
      row('q_rej', 1011, 'cl_C', 'rejected', { rejected_at: iso(NOW - DAY), rejection_reason: 'no' }),
      ...Array.from({ length: 20 }, (_, i) => row(`q_more_${String(i).padStart(2, '0')}`, 1100 + i, 'cl_A', 'open')),
    ],
  });
  const c = await get('orders', 'admin', { countsOnly: '1' });
  ok('🔴 S131: the six tabs\' counts — a submitted order split by its per-line state — and the Supply Manager\'s "Completed today" in the ORG zone',
    c.status === 200 && JSON.stringify(c.body.counts) === JSON.stringify({ open: 22, approved: 1, sent: 2, partial: 2, completed: 3, rejected: 1, completedToday: 1 }), show(c));
  const want = {
    approved: ['q_appr'], sent: ['q_legacy', 'q_supplier'], partial: ['q_ready', 'q_partial'],
    completed: ['q_done_edge', 'q_done_week', 'q_done_today'], rejected: ['q_rej'],
  };
  for (const tab of S.SUPPLY_QUEUE_TABS) {
    const r = await get('orders', 'admin', { status: tab });
    const ids = (r.body.orders || []).map((o) => o.id);
    ok(`🔴 S131: the "${tab}" tab lists exactly its orders, newest first — each one the screen's own rule puts there (supplyQueueTabOf)`, r.status === 200
      && (r.body.orders || []).every((o) => S.supplyQueueTabOf(o) === tab && Number.isInteger(o.number))
      && (tab === 'open' ? r.body.total === 22 && ids.length === 20 && ids[0] === 'q_more_19' : JSON.stringify(ids) === JSON.stringify(want[tab])), show(r));
  }
  const p2 = await get('orders', 'admin', { status: 'open', page: '2' });
  ok('… one server page of 20 at a time, with its total', p2.status === 200 && p2.body.page === 2 && JSON.stringify((p2.body.orders || []).map((o) => o.id)) === '["q_open_b","q_open_a"]'
    && p2.body.total === 22, show(p2));
  for (const q of ['SO-1006', '#1006', '1006', 'so-1006']) {
    const r = await get('orders', 'admin', { status: 'partial', q });
    ok(`🔴 S131: the search finds an order by its NUMBER ("${q}")`, r.status === 200 && JSON.stringify((r.body.orders || []).map((o) => o.id)) === '["q_partial"]', show(r));
  }
  const elsewhere = await get('orders', 'admin', { status: 'open', q: 'SO-1006' });
  ok('… only on its own tab', elsewhere.status === 200 && (elsewhere.body.orders || []).length === 0, show(elsewhere));
  const beta = await get('orders', 'admin', { status: 'open', q: 'beta' });
  ok('… a building by its name', JSON.stringify((beta.body.orders || []).map((o) => o.id)) === '["q_open_b"]', show(beta));
  const glass = await get('orders', 'admin', { status: 'open', q: 'glass' });
  ok('… an item by its words', glass.body.total === 22, show(glass));
  const open = await get('orders', 'admin', { status: 'open' });
  ok('🔴 "Select all N" on Pending approval: every match\'s id and building, complete past the page', (open.body.matches || []).length === 22
    && open.body.matches.every((m) => typeof m.id === 'string' && typeof m.clientId === 'string'), show(open));
  const appr = await get('orders', 'admin', { status: 'approved' });
  ok('… and on New', JSON.stringify(appr.body.matches) === JSON.stringify([{ id: 'q_appr', clientId: 'cl_A' }]), show(appr));
  for (const tab of ['sent', 'partial', 'completed', 'rejected']) {
    const r = await get('orders', 'admin', { status: tab });
    ok(`… and on no tab without a bulk action ("${tab}")`, r.status === 200 && !('matches' in r.body), show(r));
  }
  const odd = await get('orders', 'admin', { status: 'frobnicate' });
  ok('an unknown tab reads as the first (Pending approval)', odd.status === 200 && odd.body.total === 22, show(odd));
  const byMgr = await get('orders', 'admin', { status: 'open', mgr: 'u_mgrB' });
  ok('the Manager filter is the BUILDING\'s account manager', JSON.stringify((byMgr.body.orders || []).map((o) => o.id)) === '["q_open_b"]', show(byMgr));
  const byCust = await get('orders', 'admin', { status: 'partial', cust: 'cl_B' });
  ok('the Customer filter is one building', JSON.stringify((byCust.body.orders || []).map((o) => o.id)) === '["q_ready"]', show(byCust));
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_crew', grants: ['supplies.view'], revokes: [] }, { userId: 'u_driver', grants: ['supplies.deliver'], revokes: [] }];
  const crewView = await get('orders', 'crew', { status: 'open' });
  ok('🔴 S131: a CREW login even holding supplies.view reads no queue (403 office_only)', crewView.status === 403 && crewView.body.code === 'office_only', show(crewView));
  const driver = await get('orders', 'driver', { status: 'sent' });
  ok('… nor the driver (403)', driver.status === 403, show(driver));
  const anon = await get('orders', null);
  ok('no login is refused (401)', anon.status === 401, show(anon));
});

// ── 22. 🔴 ONE ORDER (EP-391) and its COMMENTS (EP-395) ─────────────────────────
await section('22', async () => {
  build();
  const I = await seedCatalog();
  world.tables.org_state[0].state.users = world.tables.org_state[0].state.users.map((u) => (u.id === 'u_mgrA' ? { ...u, opsManagerId: 'u_mgrB' } : u));
  await submit('o_1', 'mgrB', 'cl_A', [{ itemId: I.A.glass, qty: 2 }, { itemId: I.A.liner, qty: 1 }], 'Front desk');
  await submit('o_2', 'mgrB', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  const r = await get('order', 'mgrA', { id: 'o_1' });
  ok('🔴 S131: GET order — the order with its number, each line\'s state, its comments, photos and invoices, and who approves it with their operations manager',
    r.status === 200 && r.body.order?.id === 'o_1' && r.body.order?.number === 1001 && r.body.order?.note === 'Front desk'
    && (r.body.progress?.lines || []).length === 2 && r.body.progress.lines.every((l) => l.state === S.SUPPLY_LINE_STATE.pending)
    && Array.isArray(r.body.comments) && Array.isArray(r.body.photos) && Array.isArray(r.body.invoices)
    && r.body.approver?.id === 'u_mgrA' && r.body.approver?.name === 'mgrA person' && r.body.approverOpsManagerId === 'u_mgrB', show(r));
  const other = await get('order', 'admin', { id: 'o_2' });
  ok('… an approver with no operations manager reads null', other.status === 200 && other.body.approver?.id === 'u_mgrB' && other.body.approverOpsManagerId === null, show(other));
  const gone = await get('order', 'admin', { id: 'o_gone' });
  ok('an order that is gone is 404', gone.status === 404 && gone.body.code === 'not_found', show(gone));
  const bad = await get('order', 'admin', { id: 'x),id.eq.y' });
  ok('an id that is not one safe token is refused (400)', bad.status === 400 && bad.body.code === 'id_required', show(bad));

  const c1 = await post('orders/comment', 'mgrA', { id: 'src_1', requestId: 'o_1', body: '  Called the supplier — Tuesday.  ', authorName: 'Someone else', authorUserId: 'u_owner' });
  const row = world.tables.supply_request_comments.find((x) => x.id === 'src_1');
  ok('🔴 S131: the office comments on an order — the author is the CALLER (the claim), never the body; the words trimmed', c1.status === 200 && c1.body.created === true
    && row?.author_user_id === 'u_mgrA' && row.author_name === 'mgrA person' && row.author_role === 'manager' && row.body === 'Called the supplier — Tuesday.'
    && c1.body.comment?.authorName === 'mgrA person' && c1.body.comment?.requestId === 'o_1', show(c1));
  const replay = await post('orders/comment', 'mgrA', { id: 'src_1', requestId: 'o_1', body: 'Called the supplier — Tuesday.' });
  ok('a retried add (same id) answers the comment that landed, and adds nothing', replay.status === 200 && replay.body.created === false
    && world.tables.supply_request_comments.filter((x) => x.id === 'src_1').length === 1, show(replay));
  const taken = await post('orders/comment', 'admin', { id: 'src_1', requestId: 'o_2', body: 'Another' });
  ok('🔴 … an id another order holds is 409 id_taken, never that order\'s comment', taken.status === 409 && taken.body.code === 'id_taken', show(taken));
  await post('orders/comment', 'admin', { id: 'src_2', requestId: 'o_1', body: 'Supplier confirmed.' });
  for (const [b, want] of [
    [{ id: 'src_3', requestId: 'o_1', body: '   ' }, 'body_required'],
    [{ id: 'src_3', requestId: 'o_1', body: 'x'.repeat(S.SUPPLY_COMMENT_MAX + 1) }, 'body_too_long'],
    [{ id: 'x),y', requestId: 'o_1', body: 'Hi' }, 'bad_id'],
    [{ id: 'src_3', body: 'Hi' }, 'request_required'],
  ]) {
    const r2 = await post('orders/comment', 'admin', b);
    ok(`a comment is refused by name (400 ${want})`, r2.status === 400 && r2.body.code === want && !world.tables.supply_request_comments.some((x) => x.id === 'src_3'), show(r2));
  }
  const noOrder = await post('orders/comment', 'admin', { id: 'src_4', requestId: 'o_gone', body: 'Hi' });
  ok('a comment on an order that is gone is 404', noOrder.status === 404 && noOrder.body.code === 'not_found', show(noOrder));
  const listed = await get('order', 'admin', { id: 'o_1' });
  ok('GET order lists its comments oldest first, each with who wrote it', JSON.stringify((listed.body.comments || []).map((x) => [x.id, x.authorName]))
    === JSON.stringify([['src_1', 'mgrA person'], ['src_2', 'admin person']]), show(listed));

  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_crew', grants: ['supplies.view'], revokes: [] }, { userId: 'u_driver', grants: ['supplies.deliver'], revokes: [] }];
  for (const [m, p, body, query] of [['GET', 'order', undefined, { id: 'o_1' }], ['POST', 'orders/comment', { id: 'src_9', requestId: 'o_1', body: 'Hi' }, {}],
    ['GET', 'orders/invoice/view-url', undefined, { id: 'sdoc_x' }]]) {
    const crewView = await call(handler, { method: m, path: p, token: tok('crew'), body, query });
    ok(`🔴 S131: a CREW login even holding supplies.view is refused ${m} ${p} (403 office_only)`, crewView.status === 403 && crewView.body.code === 'office_only', show(crewView));
    const drv = await call(handler, { method: m, path: p, token: tok('driver'), body, query });
    ok(`… and so is the driver (${m} ${p} → 403)`, drv.status === 403, show(drv));
  }
  ok('… and no comment landed', !world.tables.supply_request_comments.some((x) => x.id === 'src_9'));
});

// ── 23. 🔴 THE INVOICE (EP-396 / EP-397 / EP-398 / EP-408) ──────────────────────
await section('23', async () => {
  build();
  const I = await seedCatalog();
  await submit('i_open', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('i_sent', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await submit('i_other', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await post('requests/decide', 'admin', { ids: ['i_sent', 'i_other'], decision: 'approve' });
  await toSupplier(['i_sent', 'i_other']);
  const PDF = { requestId: 'i_sent', docId: 'sdoc_1', fileName: 'Invoice 4471.pdf', mimeType: 'application/pdf', sizeBytes: 52000 };
  const path = `${ORG}/i_sent/sdoc_1`;
  const early = await post('orders/invoice/upload-url', 'admin', { ...PDF, requestId: 'i_open' });
  ok('🔴 S131: an invoice is kept once the order is with the supplier (409 not_submitted before)', early.status === 409 && early.body.code === 'not_submitted', show(early));
  for (const [patch, want] of [[{ mimeType: 'text/html' }, 'bad_type'], [{ sizeBytes: 0 }, 'bad_size'], [{ sizeBytes: S.SUPPLY_INVOICE_MAX_BYTES + 1 }, 'too_large'],
    [{ docId: 'x),y' }, 'bad_id'], [{ fileName: '  ' }, 'file_name_required']]) {
    const r = await post('orders/invoice/upload-url', 'admin', { ...PDF, ...patch });
    ok(`🔴 an upload is refused by name before any link is minted (400 ${want})`, r.status === 400 && r.body.code === want, show(r));
  }
  ok('… and no upload link was minted', !world.storage.some((x) => x.bucket === 'supply-documents'));
  const mgr = await post('orders/invoice/upload-url', 'mgrA', PDF);
  ok('a manager without supplies.manage cannot add an invoice', mgr.status === 403, show(mgr));
  const up = await post('orders/invoice/upload-url', 'admin', { ...PDF, storagePath: '../../_signatures/x' });
  ok('🔴 S131: the upload link is for a path the SERVER builds — <org>/<order>/<document> in the private supply-documents bucket (a body\'s path ignored)',
    up.status === 200 && up.body.path === path && !!up.body.token && !!up.body.signedUrl
    && world.storage.some((x) => x.bucket === 'supply-documents' && x.op === 'upload-url' && x.path === path), show(up));
  world.tables.activity_log = [];
  const conf = await post('orders/invoice/confirm', 'admin', { ...PDF, fileName: '\u0007Invoice\n 4471.pdf' });
  const doc = world.tables.supply_order_documents.find((x) => x.id === 'sdoc_1');
  ok('🔴 S131: confirm records it — the path the one built, the name cleaned of control characters, who added it', conf.status === 200 && conf.body.created === true
    && doc?.storage_path === path && doc.request_id === 'i_sent' && doc.file_name === 'Invoice 4471.pdf' && doc.mime_type === 'application/pdf' && doc.size_bytes === 52000
    && doc.uploaded_by_user_id === 'u_admin' && conf.body.invoice?.uploaderName === 'admin person' && !/storage/i.test(JSON.stringify(conf.body)), show(conf));
  ok('… and the activity log has it (supply_order.invoice_added)', world.tables.activity_log.some((a) => a.action === 'supply_order.invoice_added' && a.entity_id === 'i_sent'
    && /Invoice 4471\.pdf/.test(a.summary || '')), JSON.stringify(world.tables.activity_log));
  const again = await post('orders/invoice/confirm', 'admin', PDF);
  ok('a retried confirm (same id) answers the row that landed, and adds nothing', again.status === 200 && again.body.created === false
    && world.tables.supply_order_documents.filter((x) => x.id === 'sdoc_1').length === 1, show(again));
  const taken = await post('orders/invoice/confirm', 'admin', { ...PDF, requestId: 'i_other' });
  ok('🔴 … an id another order holds is 409 id_taken', taken.status === 409 && taken.body.code === 'id_taken', show(taken));
  const read = await get('order', 'mgrA', { id: 'i_sent' });
  ok('GET order lists the invoice — no path and no link in it (view-url signs one)', read.status === 200 && (read.body.invoices || []).map((x) => x.id).join() === 'sdoc_1'
    && !/storage|signedUrl|"url"/i.test(JSON.stringify(read.body.invoices)), show(read));
  world.storage = [];
  const view = await get('orders/invoice/view-url', 'mgrA', { id: 'sdoc_1' });
  ok('🔴 S131: view-url signs a 300-SECOND link for the office (supplies.view), never cached', view.status === 200 && view.body.expiresIn === 300 && typeof view.body.url === 'string'
    && view.headers['cache-control'] === 'no-store'
    && world.storage.some((x) => x.bucket === 'supply-documents' && x.op === 'download-url' && x.path === path && x.ttl === 300), show(view));
  const noDoc = await get('orders/invoice/view-url', 'mgrA', { id: 'sdoc_none' });
  ok('a document that is gone is 404', noDoc.status === 404 && noDoc.body.code === 'not_found', show(noDoc));
  world.tables.supply_order_documents.push({ id: 'sdoc_forged', organization_id: ORG, request_id: 'i_sent', kind: 'invoice', file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: 1, storage_path: `${ORG}/i_other/sdoc_forged` });
  const forged = await get('orders/invoice/view-url', 'admin', { id: 'sdoc_forged' });
  ok('🔴 a row whose stored path is not the one built for it is never signed (404 file_missing)', forged.status === 404 && forged.body.code === 'file_missing', show(forged));
  world.tables.supply_order_documents = world.tables.supply_order_documents.filter((x) => x.id !== 'sdoc_forged');

  const delMgr = await post('orders/invoice/delete', 'mgrA', { id: 'sdoc_1' });
  ok('a manager without supplies.manage cannot remove it', delMgr.status === 403 && world.tables.supply_order_documents.some((x) => x.id === 'sdoc_1'), show(delMgr));
  let objectGoneFirst = null;
  world.storage = [];
  world.tables.activity_log = [];
  world.beforeQuery = async (q) => {
    if (q.table === 'supply_order_documents' && q.op === 'delete') objectGoneFirst = world.storage.some((x) => x.bucket === 'supply-documents' && x.op === 'remove' && x.path === path);
  };
  const del = await post('orders/invoice/delete', 'admin', { id: 'sdoc_1' });
  world.beforeQuery = null;
  ok('🔴 S131: removing an invoice deletes its OBJECT before its row (a removed invoice is never readable by its path)', del.status === 200 && objectGoneFirst === true
    && !world.tables.supply_order_documents.some((x) => x.id === 'sdoc_1'), show(del));
  ok('… and the activity log has it (supply_order.invoice_removed)', world.tables.activity_log.some((a) => a.action === 'supply_order.invoice_removed' && a.entity_id === 'i_sent'));
  const viewGone = await get('orders/invoice/view-url', 'admin', { id: 'sdoc_1' });
  ok('… after which it cannot be viewed', viewGone.status === 404, show(viewGone));
  const delGone = await post('orders/invoice/delete', 'admin', { id: 'sdoc_1' });
  ok('… nor removed twice (404)', delGone.status === 404 && delGone.body.code === 'not_found', show(delGone));

  for (let i = 0; i < 20; i += 1) {
    world.tables.supply_order_documents.push({ id: `sdoc_k${i}`, organization_id: ORG, request_id: 'i_other', kind: 'invoice', file_name: `k${i}.pdf`, mime_type: 'application/pdf',
      size_bytes: 1, storage_path: `${ORG}/i_other/sdoc_k${i}`, created_at: iso(NOW - (30 - i) * 1000) });
  }
  const full = await post('orders/invoice/upload-url', 'admin', { ...PDF, requestId: 'i_other', docId: 'sdoc_21' });
  ok('🔴 an order keeps at most 20 files (409 too_many)', full.status === 409 && full.body.code === 'too_many', show(full));
  const reconfirm = await post('orders/invoice/confirm', 'admin', { ...PDF, requestId: 'i_other', docId: 'sdoc_k3' });
  ok('… while a retried confirm of one it keeps still answers', reconfirm.status === 200 && reconfirm.body.created === false, show(reconfirm));
  await deliverAll('i_sent');
  await complete('i_sent');
  const late = await post('orders/invoice/upload-url', 'admin', { ...PDF, docId: 'sdoc_late' });
  ok('a COMPLETED order still takes its invoice', late.status === 200 && rowOf('i_sent').status === 'completed', show(late));
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_driver', grants: ['supplies.deliver'], revokes: [] }];
  for (const who of ['crew', 'driver']) {
    const r = await get('orders/invoice/view-url', who, { id: 'sdoc_k1' });
    ok(`🔴 ${who === 'crew' ? 'a cleaner' : 'the driver'} is refused the invoice (403)`, r.status === 403, show(r));
  }
});

// ── 24. 🔴 A PRODUCT IMAGE (EP-399) ─────────────────────────────────────────────
await section('24', async () => {
  build();
  await seedCatalog();
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
  const cat = (id = 'sc_glass') => world.tables.supply_catalog.find((r) => r.id === id);
  const pathOf = (v, id = 'sc_glass') => `${ORG}/_supply-catalog/${id}/${v}.jpg`;
  const v0 = cat().version;
  world.tables.activity_log = [];
  const up = await post('catalog/image', 'admin', { id: 'sc_glass', version: v0, dataUrl: dataUrl('image/jpeg', JPEG) });
  const first = cat().image_v;
  ok('🔴 S131: a product image is stored in ops-media at a path the server builds, and the item points at its version (a CAS: version bumped)', up.status === 200
    && Number.isInteger(first) && first > 0 && cat().version === v0 + 1 && world.objects[`ops-media/${pathOf(first)}`] != null, show(up));
  ok('… answered with a signed link to it', typeof up.body.item?.imageUrl === 'string' && up.body.item.imageUrl.includes(pathOf(first)) && up.body.item?.imageV === first, show(up));
  ok('… and the activity log has it', world.tables.activity_log.some((a) => a.action === 'supply_catalog.edited' && a.entity_id === 'sc_glass' && /photo/.test(a.summary || '')));
  world.storage = [];
  const second = await post('catalog/image', 'admin', { id: 'sc_glass', version: cat().version, dataUrl: dataUrl('image/png', PNG) });
  const v2 = cat().image_v;
  ok('🔴 S131: a new image is a NEW version (a cached link never shows the old one), and the old object is removed once the row points at the new one',
    second.status === 200 && v2 > first && world.objects[`ops-media/${pathOf(v2)}`] != null
    && world.storage.some((x) => x.bucket === 'ops-media' && x.op === 'remove' && x.path === pathOf(first)), show(second));
  const stale = await post('catalog/image', 'admin', { id: 'sc_glass', version: v0, dataUrl: dataUrl('image/jpeg', JPEG) });
  ok('🔴 an image on a stale read is 409 stale, and nothing changes', stale.status === 409 && stale.body.code === 'stale' && cat().image_v === v2, show(stale));
  world.storage = [];
  world.beforeQuery = async (q) => { if (q.table === 'supply_catalog' && q.op === 'update') cat().version += 1; };
  const race = await post('catalog/image', 'admin', { id: 'sc_glass', version: cat().version, dataUrl: dataUrl('image/jpeg', JPEG) });
  world.beforeQuery = null;
  const raced = world.storage.filter((x) => x.bucket === 'ops-media' && x.op === 'upload').map((x) => x.path);
  ok('🔴 … and one that lost the race between its upload and the row: 409 stale, the object it stored removed again', race.status === 409 && race.body.code === 'stale'
    && cat().image_v === v2 && raced.length === 1 && world.storage.some((x) => x.op === 'remove' && x.path === raced[0]), show(race));
  for (const [body, want, why] of [
    [{ dataUrl: dataUrl('image/jpeg', PNG) }, 'bad_image', 'a "JPEG" whose bytes are a PNG'],
    [{ dataUrl: dataUrl('image/png', Buffer.from('<svg onload=alert(1)>')) }, 'bad_image', 'text dressed as a PNG'],
    [{ dataUrl: 'https://example.test/x.jpg' }, 'bad_image', 'a link, not the bytes'],
    [{ dataUrl: dataUrl('image/jpeg', Buffer.concat([JPEG, Buffer.alloc(S.SUPPLY_IMAGE_MAX_BYTES)])) }, 'too_large', 'an image over 1 MB'],
  ]) {
    const r = await post('catalog/image', 'admin', { id: 'sc_glass', version: cat().version, ...body });
    ok(`🔴 ${why} is refused (400 ${want}), nothing stored`, r.status === 400 && r.body.code === want && cat().image_v === v2, show(r));
  }
  const ghost = await post('catalog/image', 'admin', { id: 'sc_nope', dataUrl: dataUrl('image/jpeg', JPEG) });
  ok('an item that is not in the catalog is 404', ghost.status === 404 && ghost.body.code === 'not_found', show(ghost));

  await post('catalog/image', 'admin', { id: 'sc_bulb', dataUrl: dataUrl('image/jpeg', JPEG) });
  world.storage = [];
  const list = await get('catalog', 'mgrA');
  const byId = Object.fromEntries((list.body.items || []).map((x) => [x.id, x]));
  const signs = world.storage.filter((x) => x.bucket === 'ops-media' && x.op === 'download-url');
  ok('🔴 S131: GET catalog carries each item\'s image link — signed in ONE batch — and null for an item without one', list.status === 200
    && byId.sc_glass?.imageUrl?.includes(pathOf(v2)) && byId.sc_bulb?.imageUrl?.includes(pathOf(cat('sc_bulb').image_v, 'sc_bulb')) && byId.sc_liner?.imageUrl === null
    && signs.length === 2 && signs.every((x) => x.batch === 2), JSON.stringify(signs));
  const items = await get('items', 'mgrA', { clientId: 'cl_A' });
  ok('… and so does a building\'s list (the order sheet and the catalog per building)', (items.body.items || []).find((x) => x.catalogItemId === 'sc_glass')?.imageUrl?.includes(pathOf(v2)), show(items));
  world.storage = [];
  const removed = await post('catalog/image', 'admin', { id: 'sc_glass', version: cat().version, remove: true });
  ok('🔴 remove: the item has no image, and its object leaves Storage', removed.status === 200 && cat().image_v === null && removed.body.item?.imageUrl === null
    && world.storage.some((x) => x.op === 'remove' && x.path === pathOf(v2)), show(removed));
  const bulbV = cat('sc_bulb').image_v;
  world.storage = [];
  await post('catalog/delete', 'admin', { id: 'sc_bulb' });
  ok('🔴 deleting a catalog item takes its image with it', world.storage.some((x) => x.op === 'remove' && x.path === pathOf(bulbV, 'sc_bulb')), JSON.stringify(world.storage));
});

// ── 25. 🔴 a cleaner's 1–20 of an item is the SERVER's rule (S131) ──────────────
await section('25', async () => {
  const startToday = startOfDayKey(TODAY, TZ).getTime();
  build({}, {
    jobs: [{ id: 'j_A', organization_id: ORG, start_at: iso(startToday + 20 * HR), status: 'upcoming',
      data: { id: 'j_A', clientId: 'cl_A', crewIds: ['u_crew'], startAt: iso(startToday + 20 * HR), endAt: iso(startToday + 22 * HR), status: 'upcoming' } }],
  });
  const I = await seedCatalog();
  const over = await submit('k_over', 'crew', 'cl_A', [{ itemId: I.A.liner, qty: 1 }, { itemId: I.A.glass, qty: S.CREW_SUPPLY_MAX_QTY + 1 }]);
  ok('🔴 S131: a cleaner asking for more than CREW_SUPPLY_MAX_QTY of an item is refused BY NAME (400 qty_over_cap) — never clamped, nothing stored',
    over.status === 400 && over.body.code === 'qty_over_cap' && over.body.itemId === I.A.glass && over.body.max === S.CREW_SUPPLY_MAX_QTY && !rowOf('k_over'), show(over));
  const at = await submit('k_max', 'crew', 'cl_A', [{ itemId: I.A.glass, qty: S.CREW_SUPPLY_MAX_QTY }]);
  ok('… exactly the cap is fine', at.status === 200 && rowOf('k_max')?.lines?.[0]?.qty === S.CREW_SUPPLY_MAX_QTY, show(at));
  const office = await submit('k_office', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 50 }]);
  ok('… while the office orders past it (its order sheet keeps SUPPLY_MAX_QTY)', office.status === 200 && rowOf('k_office')?.lines?.[0]?.qty === 50, show(office));
});

// ── 26. 🔴 an order's DELIVERY PHOTOS (account-media, scope `supply`; S131) ──────
await section('26', async () => {
  build({ overrides: [{ userId: 'u_driver', grants: ['supplies.deliver'], revokes: [] }, SM_KEYS] });
  const I = await seedCatalog();
  await submit('p_sent', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 2 }]);
  await submit('p_open', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await post('requests/decide', 'admin', { ids: ['p_sent'], decision: 'approve' });
  await toSupplier(['p_sent']);
  const media = (method, action, who, { body, query } = {}) => call(mediaRoute, { method, path: action, token: who ? tok(who) : undefined, body, query });
  const IMG = { scope: 'supply', mimeType: 'image/jpeg', sizeBytes: 120000 };
  const urlAs = (who, refId) => media('POST', 'upload-url', who, { body: { ...IMG, refId } });
  const driverSent = await urlAs('driver', 'p_sent');
  ok('🔴 S131: the driver (a crew login with the Deliveries grant) may photograph a SUBMITTED order\'s drop-off — in the order photos\' folder, never a site\'s',
    driverSent.status === 200 && new RegExp(`^${ORG}/site/[a-z0-9]+\\.jpg$`, 'i').test(driverSent.body.path || ''), show(driverSent));
  const driverOpen = await urlAs('driver', 'p_open');
  ok('🔴 … but not an order that is not with the supplier (403)', driverOpen.status === 403, show(driverOpen));
  const smOpen = await urlAs('sm', 'p_open');
  ok('the Supply Manager (supplies.manage) may, on any order', smOpen.status === 200, show(smOpen));
  const crew = await urlAs('crew', 'p_sent');
  ok('🔴 a cleaner may not (403) — no site assignment opens an order', crew.status === 403, show(crew));
  const ghost = await urlAs('sm', 'p_gone');
  ok('🔴 an order that does not exist reads exactly like one that is not yours (403, no existence oracle)', ghost.status === 403 && ghost.body.error === crew.body.error, show(ghost));
  const anon = await urlAs(null, 'p_sent');
  ok('no login is refused (401)', anon.status === 401, show(anon));
  const video = await media('POST', 'upload-url', 'driver', { body: { ...IMG, refId: 'p_sent', mimeType: 'video/mp4', sizeBytes: 1000 } });
  ok('a delivery photo is a photo, never a video (400)', video.status === 400, show(video));
  const storagePath = driverSent.body.path;
  const conf = await media('POST', 'confirm', 'driver', { body: { ...IMG, refId: 'p_sent', storagePath, areaId: 'sc_glass', clientId: 'cl_B', siteId: 'st_x', caption: 'At the front desk' } });
  const row = world.tables.account_media.find((m) => m.storage_path === storagePath);
  ok('🔴 S131: confirm files it under the ORDER and its building (never a site, never the body\'s), the area one of its own items, the uploader the login',
    conf.status === 200 && row?.scope === 'supply' && row.ref_id === 'p_sent' && row.client_id === 'cl_A' && row.site_id === null
    && row.area_id === 'sc_glass' && row.uploaded_by_user_id === 'u_driver' && row.kind === 'image', show(conf));
  const wild = await media('POST', 'confirm', 'driver', { body: { ...IMG, refId: 'p_sent', storagePath: `${ORG}/site/abc123.jpg`, areaId: 'sc_not_on_it' } });
  const wildRow = world.tables.account_media.find((m) => m.storage_path === `${ORG}/site/abc123.jpg`);
  ok('… an area that is not one of the order\'s items is dropped (the photo is of the order)', wild.status === 200 && wildRow?.area_id === null, show(wild));
  const badPath = await media('POST', 'confirm', 'driver', { body: { ...IMG, refId: 'p_sent', storagePath: `${ORG}/st_A/abc123.jpg` } });
  ok('🔴 a path outside the order photos\' folder is refused (400)', badPath.status === 400, show(badPath));
  const listMgr = await media('GET', 'list', 'mgrA', { query: { scope: 'supply', refId: 'p_sent' } });
  ok('S131: the office reads an order\'s photos (supplies.view)', listMgr.status === 200 && (listMgr.body.media || []).length === 2, show(listMgr));
  for (const who of ['driver', 'crew']) {
    const r = await media('GET', 'list', who, { query: { scope: 'supply', refId: 'p_sent' } });
    ok(`🔴 … ${who === 'driver' ? 'the driver' : 'a cleaner'} does not (403)`, r.status === 403, show(r));
  }
  const order = await get('order', 'mgrA', { id: 'p_sent' });
  ok('GET order carries the photos, each with who took it', (order.body.photos || []).some((p) => p.uploaderName === 'Alberto Reyes' && p.areaId === 'sc_glass'), show(order));
  const delMgr = await media('POST', 'delete', 'mgrA', { body: { id: row.id } });
  ok('🔴 S131: a manager without supplies.manage cannot remove an order\'s photo', delMgr.status === 403 && world.tables.account_media.some((m) => m.id === row.id), show(delMgr));
  const delSm = await media('POST', 'delete', 'sm', { body: { id: row.id } });
  ok('… the Supply Manager can', delSm.status === 200 && !world.tables.account_media.some((m) => m.id === row.id), show(delSm));
  world.tables.account_media.push({ id: 'm_site', organization_id: ORG, scope: 'cleaning_instruction', site_id: 'st_A', client_id: 'cl_A', ref_id: null, kind: 'image', storage_path: `${ORG}/st_A/site1.jpg` });
  const delSite = await media('POST', 'delete', 'driver', { body: { id: 'm_site' } });
  ok('… and every other photo stays ops.edit\'s (the driver\'s grant opens nothing else)', delSite.status === 403 && world.tables.account_media.some((m) => m.id === 'm_site'), show(delSite));
});

// ── S131 Wave 2 (brief A: the account manager's side) ─────────────────────────────────────────
// The team: mgrB is an Operations Manager (`managerLevel: 'operations'`) and mgrA reports to them
// (`opsManagerId`), as Builder R's roster stores it.
const makeTeam = () => {
  world.tables.org_state[0].state.users = world.tables.org_state[0].state.users.map((u) => (u.id === 'u_mgrB' ? { ...u, managerLevel: 'operations' }
    : u.id === 'u_mgrA' ? { ...u, opsManagerId: 'u_mgrB' } : u));
};
// A real `supply_manager` login (Builder R's 5th role), with the keys the release gives the role.
const addSupplyManagerLogin = () => {
  world.logins.set('tok-smr', { id: 'auth-smr', email: 'smr@example.test', app_metadata: { role: 'supply_manager', org_user_id: 'u_smr', org_id: ORG } });
  const st = world.tables.org_state[0].state;
  st.users = [...st.users, { id: 'u_smr', email: 'smr@example.test', role: 'supply_manager', status: 'active', name: 'Wes Carter', notificationPrefs: {} }];
  st.permissions = st.permissions.map((p) => (['supplies.view', 'supplies.manage', 'supplies.deliver'].includes(p.id) && !p.roles.includes('supply_manager') ? { ...p, roles: [...p.roles, 'supply_manager'] } : p));
};

// ── 27. 🔴 THE CANCEL GAP (found by Builder S): a cancel DELETES an order, and supplies.manage alone
// — now the Supply Manager's role — let them delete one still waiting for approval, against Matt's
// "only approved orders reach the Supply Manager". While it waits, only those who may DECIDE it
// (maySupplyDecide) may cancel it, and the asker their own. ──
await section('27', async () => {
  build({ overrides: [SM_KEYS] });
  makeTeam();
  addSupplyManagerLogin();
  const I = await seedCatalog();
  for (const id of ['g_sm', 'g_smr', 'g_am', 'g_om', 'g_owner', 'g_appr', 'g_appr2']) await submit(id, 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 1 }]);
  await post('requests/decide', 'mgrA', { ids: ['g_appr', 'g_appr2'], decision: 'approve' });
  world.tables.org_state[0].state.notifications = [];
  world.tables.activity_log = [];
  for (const [who, id, label] of [['sm', 'g_sm', 'a login holding the Supply Manager\'s keys (supplies.manage, no supplies.approve)'], ['smr', 'g_smr', 'a supply_manager login']]) {
    const r = await call(handler, { method: 'POST', path: 'requests/cancel', token: tok(who), body: { id } });
    ok(`🔴 S131: ${label} CANNOT cancel an order still waiting for approval — 403 not_yours, the order kept`,
      r.status === 403 && r.body.code === 'not_yours' && rowOf(id)?.status === 'open', show(r));
  }
  ok('… and a refused cancel writes nothing (no activity row, no bell)', world.tables.activity_log.length === 0
    && (world.tables.org_state[0].state.notifications || []).length === 0);
  const am = await post('requests/cancel', 'mgrA', { id: 'g_am' });
  ok('the building\'s account manager may (they may decide it)', am.status === 200 && !rowOf('g_am'), show(am));
  const omCancel = await post('requests/cancel', 'mgrB', { id: 'g_om' });
  ok('🔴 S131: … and so may THEIR operations manager (Daniel\'s answer 3: an OM acts like their AMs)', omCancel.status === 200 && !rowOf('g_om'), show(omCancel));
  const own = await post('requests/cancel', 'owner', { id: 'g_owner' });
  ok('… and the owner', own.status === 200 && !rowOf('g_owner'), show(own));
  const smAppr = await post('requests/cancel', 'sm', { id: 'g_appr' });
  ok('S131: once APPROVED the order is the Supply Manager\'s to process, and they may cancel it (supplies.manage)', smAppr.status === 200 && !rowOf('g_appr'), show(smAppr));
  const smrAppr = await call(handler, { method: 'POST', path: 'requests/cancel', token: tok('smr'), body: { id: 'g_appr2' } });
  ok('… the supply_manager role too', smrAppr.status === 200 && !rowOf('g_appr2'), show(smrAppr));
});

// ── 28. 🔴 THE ACCOUNT MANAGER'S SIDE (brief A): `mgr=team` on the supplies reads, resolved from the
// CALLER's claim; By building's orders (number, the AM's words, each line's state), under the queue's
// office gate; a decline's reason of 3+ characters ──
await section('28', async () => {
  build();
  makeTeam();
  // A building whose manager is on no team (the admin supervises it).
  world.tables.org_state[0].state.clients.push({ id: 'cl_D', name: 'Delta Point', supervisorId: 'u_admin', supplyOrderDayOfMonth: 1 });
  const I = await seedCatalog();
  await post('items/assign', 'admin', { clientId: 'cl_D', on: ['sc_glass'] });
  const dGlass = itemOf('cl_D', 'sc_glass');
  await submit('t_A', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 2 }, { itemId: I.A.liner, qty: 1 }], 'Restrooms are out.');
  await submit('t_B', 'admin', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  await submit('t_D', 'admin', 'cl_D', [{ itemId: dGlass, qty: 4 }]);
  // At Alpha, one order with the supplier: the glass delivered, the liners backordered a week out.
  const ETA = addDaysKey(TODAY, 7);
  await submit('t_A2', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 3 }, { itemId: I.A.liner, qty: 2 }]);
  await post('requests/decide', 'admin', { ids: ['t_A2'], decision: 'approve' });
  await toSupplier(['t_A2']);
  await fulfill('t_A2', 'admin', [{ line: 0, act: 'deliver' }, { line: 1, act: 'backorder', eta: ETA }]);
  // Delivered and completed: 2 at Alpha (the team's), 5 at Delta (not the team's).
  await submit('u_A', 'admin', 'cl_A', [{ itemId: I.A.glass, qty: 2 }]);
  await submit('u_D', 'admin', 'cl_D', [{ itemId: dGlass, qty: 5 }]);
  await deliveredOrder(['u_A', 'u_D']);

  const ids = (r) => (r.body.buildings || []).map((b) => b.clientId).sort().join();
  const omTeam = await get('buildings', 'mgrB', { mgr: 'team' });
  ok('🔴 S131: an Operations Manager asking for `team` gets their team\'s buildings — their own and their account managers\'', omTeam.status === 200 && ids(omTeam) === 'cl_A,cl_B', show(omTeam));
  const amTeam = await get('buildings', 'mgrA', { mgr: 'team' });
  ok('🔴 S131: a plain account manager cannot widen to `team`: they get their own buildings', amTeam.status === 200 && ids(amTeam) === 'cl_A', show(amTeam));
  const ownerTeam = await get('buildings', 'owner', { mgr: 'team' });
  ok('… and `team` is the CALLER\'s, never one the request names: the owner leads none', ownerTeam.status === 200 && ids(ownerTeam) === '', show(ownerTeam));
  // The owner's Operations view's tiles (lib/teamScope teamLeadFor): an owner or an admin, who reads
  // every building, may name WHOSE team with `om` — an active Operations Manager; a manager never
  // widens theirs that way.
  const ownerOm = await get('buildings', 'owner', { mgr: 'team', om: 'u_mgrB' });
  ok('🔴 S131: the owner names an Operations Manager\'s team (`om`): that team\'s buildings', ownerOm.status === 200 && ids(ownerOm) === 'cl_A,cl_B', show(ownerOm));
  const ownerNotOm = await get('buildings', 'owner', { mgr: 'team', om: 'u_mgrA' });
  ok('… an id that is not an active Operations Manager names no team (the owner\'s own: none)', ownerNotOm.status === 200 && ids(ownerNotOm) === '', show(ownerNotOm));
  const amOm = await get('buildings', 'mgrA', { mgr: 'team', om: 'u_mgrB' });
  ok('🔴 … and a manager never widens their `team` with `om` (mgrA: still only their own)', amOm.status === 200 && ids(amOm) === 'cl_A', show(amOm));
  const ownerQueue = await get('orders', 'owner', { status: 'open', mgr: 'team', om: 'u_mgrB' });
  const ownerUsage = await get('usage', 'owner', { period: '30d', mgr: 'team', om: 'u_mgrB' });
  const usageQty = (r) => (r.body.rows || []).reduce((a, x) => a + x.qty, 0);
  ok('… the queue and usage take it too', ownerQueue.status === 200 && (ownerQueue.body.orders || []).map((o) => o.id).sort().join() === 't_A,t_B'
    && ownerUsage.status === 200 && usageQty(ownerUsage) === 5, `${show(ownerQueue)} ${show(ownerUsage)}`);
  const all = await get('buildings', 'mgrB', {});
  ok('… while the whole book is still one pick away (no `mgr`)', all.status === 200 && ids(all) === 'cl_A,cl_B,cl_D', show(all));
  const queue = await get('orders', 'mgrB', { status: 'open', mgr: 'team' });
  ok('🔴 S131: the queue (GET orders) takes `team` too', queue.status === 200 && (queue.body.orders || []).map((o) => o.id).sort().join() === 't_A,t_B', show(queue));
  const usageTeam = await get('usage', 'mgrB', { period: '30d', mgr: 'team' });
  const usageAll = await get('usage', 'mgrB', { period: '30d' });
  const qtyOf = (r) => (r.body.rows || []).reduce((a, x) => a + x.qty, 0);
  ok('🔴 S131: … and usage: the team\'s deliveries only (2 + the 3 delivered on the open order), never another team\'s', usageTeam.status === 200 && qtyOf(usageTeam) === 5 && qtyOf(usageAll) === 10, `${show(usageTeam)} ${show(usageAll)}`);

  // By building's orders: field by field, no money.
  const alpha = (omTeam.body.buildings || []).find((b) => b.clientId === 'cl_A') || {};
  const byId = new Map((alpha.orders || []).map((o) => [o.id, o]));
  ok('🔴 S131: each building carries its in-flight orders — waiting first, then with the supplier', (alpha.orders || []).map((o) => o.id).join() === 't_A,t_A2'
    && alpha.state === S.SUPPLY_BUILDING_STATE?.pending, JSON.stringify(alpha));
  ok('… a waiting one with its number, who asked, when, the note, and its lines (no state yet)', byId.get('t_A')?.number === rowOf('t_A')?.number
    && byId.get('t_A')?.no === `SO-${rowOf('t_A')?.number}` && byId.get('t_A')?.requestedByName === 'admin person' && byId.get('t_A')?.note === 'Restrooms are out.'
    && JSON.stringify(byId.get('t_A')?.lines) === JSON.stringify([{ name: 'Glass cleaner', qty: 2, state: null, delivered: 0, eta: null }, { name: 'Trash liners', qty: 1, state: null, delivered: 0, eta: null }]),
  JSON.stringify(byId.get('t_A')));
  ok('🔴 … one with the supplier with each line\'s state from the per-line record, and the ETA the office typed (the only date)', byId.get('t_A2')?.phase === 'partial'
    && JSON.stringify(byId.get('t_A2')?.labelKeys) === JSON.stringify([S.SUPPLY_ORDER_LABEL_KEYS?.am?.approved, S.SUPPLY_ORDER_LABEL_KEYS?.am?.partial])
    && JSON.stringify(byId.get('t_A2')?.lines) === JSON.stringify([{ name: 'Glass cleaner', qty: 3, state: 'delivered', delivered: 3, eta: null }, { name: 'Trash liners', qty: 2, state: 'backordered', delivered: 0, eta: ETA }]),
  JSON.stringify(byId.get('t_A2')));
  ok('🔴 … and never a price, a total or a cent in an order', (alpha.orders || []).length === 2 && !MONEY.test(JSON.stringify(alpha.orders)), JSON.stringify(alpha.orders));
  // The office gate (the queue's): order details are never a crew login's, even holding supplies.view.
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_crew', grants: ['supplies.view'], revokes: [] }];
  const crewView = await get('buildings', 'crew');
  ok('🔴 S131: GET buildings is an OFFICE role\'s, like the queue: a crew login holding supplies.view is 403 office_only', crewView.status === 403 && crewView.body.code === 'office_only', show(crewView));
  world.tables.org_state[0].state.userPermissionOverrides = [];

  // A decline's reason (S131 Wave 2): 3+ characters at the write point.
  const short = await post('requests/decide', 'mgrA', { ids: ['t_A'], decision: 'reject', reason: 'no' });
  ok('🔴 S131: a decline with a reason under 3 characters is refused by name (reason_required), the order kept', short.status === 200
    && short.body.results?.[0]?.code === 'reason_required' && rowOf('t_A')?.status === 'open', show(short));
  const fine = await post('requests/decide', 'mgrA', { ids: ['t_A'], decision: 'reject', reason: 'Not this month' });
  ok('… and one of 3+ declines it, the reason kept', fine.body.results?.[0]?.ok === true && rowOf('t_A')?.status === 'rejected' && rowOf('t_A')?.rejection_reason === 'Not this month', show(fine));
});

// ── 29. 🔴 the cleaner's OWN orders (S131 Builder C): one order (EP-400), Home's light read (EP-401),
//    the crew list's history and photo links (EP-385), and the office's View-as ──────────────────────
await section('29', async () => {
  const startToday = startOfDayKey(TODAY, TZ).getTime();
  const job = (id, clientId, startMs) => ({
    id, organization_id: ORG, start_at: iso(startMs), status: 'upcoming',
    data: { id, clientId, crewIds: ['u_crew'], startAt: iso(startMs), endAt: iso(startMs + 2 * HR), status: 'upcoming' },
  });
  build({}, {
    jobs: [
      job('j_A', 'cl_A', startToday + 20 * HR),                                                // tonight at Alpha
      job('j_B', 'cl_B', startOfDayKey(addDaysKey(TODAY, 7), TZ).getTime() + 12 * HR),         // next week at Beta
      job('j_C', 'cl_C', startOfDayKey(addDaysKey(TODAY, -7), TZ).getTime() + 12 * HR),        // only in the past at Gamma
    ],
  });
  const I = await seedCatalog();
  await post('items/assign', 'admin', { clientId: 'cl_C', on: ['sc_glass'] });
  // The cleaner's own: two at Alpha, one at Beta; the account manager's at Alpha; and one the cleaner
  // asked for at Gamma back when they cleaned it.
  await submit('m_a1', 'crew', 'cl_A', [{ itemId: I.A.glass, qty: 3 }, { itemId: I.A.liner, qty: 2 }]);
  await submit('m_a2', 'crew', 'cl_A', [{ itemId: I.A.bulb, qty: 1 }]);
  await submit('m_b1', 'crew', 'cl_B', [{ itemId: I.B.glass, qty: 1 }]);
  await submit('o_a', 'mgrA', 'cl_A', [{ itemId: I.A.glass, qty: 5 }]);
  await submit('m_c1', 'admin', 'cl_C', [{ itemId: itemOf('cl_C', 'sc_glass'), qty: 1 }]);
  rowOf('m_c1').requested_by_user_id = 'u_crew';
  rowOf('m_c1').requester_name = 'crew person';
  await post('requests/decide', 'admin', { ids: ['m_a1'], decision: 'approve' });
  await toSupplier(['m_a1']);
  await fulfill('m_a1', 'admin', [{ line: 0, act: 'deliver' }, { line: 1, act: 'backorder', eta: addDaysKey(TODAY, 7) }]);
  rowOf('m_a1').created_at = iso(NOW - 3 * HR);
  rowOf('m_a2').created_at = iso(NOW - 2 * HR);
  rowOf('m_b1').created_at = iso(NOW - HR);

  // ── one order (EP-400) ──
  const from = world.log.length;
  const own = await get('crew-order', 'crew', { id: 'm_a1' });
  const o = own.body.order || {};
  ok('🔴 S131 EP-400: a cleaner opens their OWN order at a building they clean — field by field, each line\'s state', own.status === 200
    && JSON.stringify(Object.keys(o)) === JSON.stringify(S.SUPPLY_CREW_ORDER_KEYS || ['?'])
    && o.no === `SO-${rowOf('m_a1').number}` && o.status === 'sent' && o.fulfillmentState === 'partial'
    && JSON.stringify((o.lines || []).map((l) => [l.name, l.qty, l.state, l.eta])) === JSON.stringify([['Glass cleaner', 3, 'delivered', null], ['Trash liners', 2, 'backordered', addDaysKey(TODAY, 7)]])
    && o.requestedBy === 'crew P.' && o.approvedBy === 'admin P.' && !!o.lines[0].deliveredAt, show(own));
  ok('🔴 … with NO money, note, comment, invoice or photo in it', own.status === 200 && !MONEY.test(JSON.stringify(own.body)) && !/note|photo|invoice|comment/i.test(JSON.stringify(own.body)), show(own));
  const reads = world.log.slice(from).filter((q) => q.table === 'supply_requests' && q.op === 'select');
  ok('… and its read never asks for every column', reads.length > 0 && reads.every((q) => q.cols !== '*'), JSON.stringify(reads.map((q) => q.cols)));
  // S131 integration: a line the office could not get tells the cleaner why — the reason their
  // supplyItemCancelled bell already carried.
  await post('requests/decide', 'admin', { ids: ['m_a2'], decision: 'approve' });
  await toSupplier(['m_a2']);
  await fulfill('m_a2', 'admin', [{ line: 0, act: 'cancel', reason: 'Discontinued by the supplier' }]);
  const cx = await get('crew-order', 'crew', { id: 'm_a2' });
  ok('🔴 S131 integration: a cancelled line carries the office\'s reason to the cleaner (as their bell did) — still field by field, no money', cx.status === 200
    && cx.body.order?.lines?.[0]?.state === 'cancelled' && cx.body.order.lines[0].reason === 'Discontinued by the supplier'
    && JSON.stringify(Object.keys(cx.body.order.lines[0])) === JSON.stringify(S.SUPPLY_CREW_LINE_KEYS || ['?']) && !MONEY.test(JSON.stringify(cx.body)), show(cx));
  const notTheirs = await get('crew-order', 'crew', { id: 'o_a' });
  const pastBuilding = await get('crew-order', 'crew', { id: 'm_c1' });
  const ghost = await get('crew-order', 'crew', { id: 'sr_nope' });
  ok('🔴 … someone else\'s order, at their own building → 404', notTheirs.status === 404 && notTheirs.body.code === 'not_found', show(notTheirs));
  ok('🔴 … their own order at a building they no longer clean → 404', pastBuilding.status === 404 && pastBuilding.body.code === 'not_found', show(pastBuilding));
  ok('🔴 … every refusal reads exactly like an order that does not exist (naming nothing)', ghost.status === 404
    && JSON.stringify(ghost.body) === JSON.stringify(notTheirs.body) && JSON.stringify(ghost.body) === JSON.stringify(pastBuilding.body), `${show(ghost)} | ${show(notTheirs)}`);
  const office = await get('crew-order', 'mgrB', { id: 'o_a' });
  ok('the office reads any (the owner\'s View-as reads through it) — field by field all the same', office.status === 200 && office.body.order?.id === 'o_a'
    && JSON.stringify(Object.keys(office.body.order)) === JSON.stringify(S.SUPPLY_CREW_ORDER_KEYS || ['?']) && !MONEY.test(JSON.stringify(office.body)), show(office));
  const noId = await get('crew-order', 'crew', {});
  ok('one order is named (400)', noId.status === 400 && noId.body.code === 'id_required', show(noId));
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_crew', grants: [], revokes: ['supplies.request'] }];
  const off = await get('crew-order', 'crew', { id: 'm_a1' });
  const offTile = await get('crew-orders', 'crew');
  ok('🔴 the cleaner\'s switch OFF (a revoke of supplies.request) refuses both reads (403)', off.status === 403 && offTile.status === 403, `${show(off)} | ${show(offTile)}`);
  world.tables.org_state[0].state.userPermissionOverrides = [];

  // ── Home's light read (EP-401) ──
  world.storage = [];
  const tile = await get('crew-orders', 'crew');
  ok('🔴 S131 EP-401: Home\'s read — the cleaner\'s newest orders at every building they clean today or upcoming (never a past one\'s, never someone else\'s)',
    tile.status === 200 && JSON.stringify((tile.body.orders || []).map((x) => x.id)) === JSON.stringify(['m_b1', 'm_a2', 'm_a1']), show(tile));
  ok('… light: no list, no photo links signed, no money', tile.status === 200 && !('items' in tile.body) && !world.storage.some((x) => x.op === 'download-url')
    && !MONEY.test(JSON.stringify(tile.body)), show(tile));
  const naming = await get('crew-orders', 'crew', { userId: 'u_mgrA' });
  ok('🔴 a cleaner naming someone else reads themselves (the claim, never the query)', naming.status === 200
    && JSON.stringify(naming.body.orders) === JSON.stringify(tile.body.orders), show(naming));
  const preview = await get('crew-orders', 'admin', { userId: 'u_crew' });
  ok('🔴 the office\'s View-as names the cleaner (supplies.view): the same answer the cleaner reads', preview.status === 200
    && JSON.stringify(preview.body.orders) === JSON.stringify(tile.body.orders), show(preview));
  world.tables.org_state[0].state.userPermissionOverrides = [{ userId: 'u_mgrB', grants: [], revokes: ['supplies.view'] }];
  const noView = await get('crew-orders', 'mgrB', { userId: 'u_crew' });
  ok('🔴 … an office login without supplies.view may not (403)', noView.status === 403, show(noView));
  world.tables.org_state[0].state.userPermissionOverrides = [];
  const anon = await get('crew-orders', null);
  ok('no login is refused (401)', anon.status === 401, show(anon));

  // ── the crew list: the history and each product's photo link (EP-385) ──
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  await post('catalog/image', 'admin', { id: 'sc_glass', dataUrl: `data:image/jpeg;base64,${JPEG.toString('base64')}` });
  world.storage = [];
  const list = await get('crew-list', 'crew', { clientId: 'cl_A' });
  ok('🔴 S131: the crew list carries the cleaner\'s OWN orders here, newest first (the account manager\'s never)', list.status === 200
    && JSON.stringify((list.body.orders || []).map((x) => x.id)) === JSON.stringify(['m_a2', 'm_a1']), show(list));
  const signs = world.storage.filter((x) => x.bucket === 'ops-media' && x.op === 'download-url');
  const items = list.body.items || [];
  ok('🔴 S131: … and each product\'s photo link, signed in ONE batch (null without one) — still no money', items.find((x) => x.catalogItemId === 'sc_glass')?.imageUrl?.includes('/_supply-catalog/sc_glass/')
    && items.find((x) => x.catalogItemId === 'sc_liner')?.imageUrl === null && signs.length === 1 && signs[0].batch === 1
    && !MONEY.test(JSON.stringify(list.body)), JSON.stringify(signs));
  const previewList = await get('crew-list', 'admin', { clientId: 'cl_A', userId: 'u_crew' });
  ok('🔴 the office\'s View-as reads the cleaner\'s history here, not its own', previewList.status === 200
    && (previewList.body.orders || []).length === 2 && JSON.stringify(previewList.body.orders) === JSON.stringify(list.body.orders), show(previewList));
  for (let i = 0; i < 11; i += 1) await submit(`m_x${i}`, 'crew', 'cl_A', [{ itemId: I.A.bulb, qty: 1 }]);
  const ten = await get('crew-list', 'crew', { clientId: 'cl_A' });
  ok('… at most the newest CREW_SUPPLY_HISTORY_MAX (10)', ten.status === 200 && (ten.body.orders || []).length === S.CREW_SUPPLY_HISTORY_MAX
    && !(ten.body.orders || []).some((x) => x.id === 'm_a1'), show(ten));
});

// ── 30. IMPORT ITEMS (catalog/import) and A PICTURE BEHIND A LINK (catalog/image-link) ─────────
// Task #257, Supplies → Catalog → Import items: the catalog from a spreadsheet, a batch at a time,
// each item answered; the Photo column's links downloaded by the server, never into a private network.
await section('30', async () => {
  const { __setLinkImageDeps, fetchLinkImage, LINK_IMAGE_RATE } = await import('../api/_lib/supplies/imageLink.js');
  const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
  const { EventEmitter } = await import('node:events');
  const net = await import('node:net');
  const { CATALOG_IMPORT_BATCH } = await import('../src/lib/supplyCatalogImport.js');
  build({ overrides: [SM_KEYS] });
  await seedCatalog();
  const cat = (id) => world.tables.supply_catalog.find((r) => r.id === id);
  const glassV = cat('sc_glass').version;

  // the doors: supplies.manage only
  for (const p of ['catalog/import', 'catalog/image-link']) {
    const anon = await post(p, null, {});
    const crew = await post(p, 'crew', { items: [{ id: 'sc_x', create: true, set: { name: 'x' } }], url: 'https://img.example.test/a.png' });
    const mgr = await post(p, 'mgrA', { items: [{ id: 'sc_x', create: true, set: { name: 'x' } }], url: 'https://img.example.test/a.png' });
    ok(`🔴 task #257: ${p} refuses no login (401), a cleaner and a manager without supplies.manage (403)`, anon.status === 401 && crew.status === 403 && mgr.status === 403, `${show(anon)} ${show(crew)} ${show(mgr)}`);
  }
  ok('… and nothing was written by them', !cat('sc_x'));

  // one batch: an update (blanks leave), two new items (one category in another case), a SKU taken
  world.tables.activity_log = [];
  const batch = [
    { id: 'sc_glass', create: false, version: glassV, set: { unitPrice: 7.25 } },
    { id: 'sc_n1', create: true, set: { sku: 'FP-1', name: 'Floor polish', category: 'liquids', unit: 'gallon', unitPrice: 41 } },
    { id: 'sc_n2', create: true, set: { name: 'Gloves' } },
    { id: 'sc_n3', create: true, set: { sku: 'cl-1001', name: 'Another glass cleaner' } },
  ];
  const r1 = await post('catalog/import', 'sm', { items: batch });
  const res = (r, id) => (r.body.results || []).find((x) => x.id === id) || {};
  ok('🔴 task #257: the Supply Manager imports a batch; every item answered, in order', r1.status === 200
    && (r1.body.results || []).map((x) => x.id).join() === 'sc_glass,sc_n1,sc_n2,sc_n3', show(r1));
  ok('🔴 an update merges over the live row: the price replaced, every blank left (name, SKU, category, unit)', res(r1, 'sc_glass').ok && !res(r1, 'sc_glass').created
    && cat('sc_glass').unit_price_cents === 725 && cat('sc_glass').name === 'Glass cleaner' && cat('sc_glass').sku === 'CL-1001'
    && cat('sc_glass').category === 'Liquids' && cat('sc_glass').unit === 'each' && cat('sc_glass').version === glassV + 1, JSON.stringify(cat('sc_glass')));
  ok('🔴 new items are stored with the caller\'s ids, the category as used ("liquids" → "Liquids"), the price in cents', res(r1, 'sc_n1').created && res(r1, 'sc_n2').created
    && cat('sc_n1')?.category === 'Liquids' && cat('sc_n1')?.unit_price_cents === 4100 && cat('sc_n1')?.version === 1 && cat('sc_n2')?.name === 'Gloves', JSON.stringify(cat('sc_n1')));
  ok('🔴 a SKU another item holds (any case) is refused for THAT item only, naming the holder', res(r1, 'sc_n3').ok === false && res(r1, 'sc_n3').code === 'sku_taken'
    && res(r1, 'sc_n3').holder?.name === 'Glass cleaner' && !cat('sc_n3'), JSON.stringify(res(r1, 'sc_n3')));
  ok('… each answer carries the item\'s new version (for its photo)', res(r1, 'sc_glass').item?.version === glassV + 1 && res(r1, 'sc_n1').item?.version === 1);
  const logged = world.tables.activity_log.filter((a) => a.action === 'supply_catalog.imported');
  ok('🔴 ONE activity row for the call, with the counts and the names', logged.length === 1 && /imported 3 items \(2 added, 1 updated\)/.test(logged[0].summary || '')
    && /Floor polish/.test(logged[0].summary) && /Glass cleaner/.test(logged[0].summary), JSON.stringify(logged.map((a) => a.summary)));

  // the same batch again (a retry after a lost answer): nothing twice
  const count = world.tables.supply_catalog.length;
  const r2 = await post('catalog/import', 'admin', { items: batch });
  ok('🔴 the same batch sent again adds nothing: the new ones answer "exists", the update "stale"', r2.status === 200 && world.tables.supply_catalog.length === count
    && res(r2, 'sc_n1').ok && res(r2, 'sc_n1').code === 'exists' && !res(r2, 'sc_n1').created
    && res(r2, 'sc_glass').ok === false && res(r2, 'sc_glass').code === 'stale' && cat('sc_glass').unit_price_cents === 725, show(r2));
  const gone = await post('catalog/import', 'admin', { items: [{ id: 'sc_gone', create: false, version: 1, set: { name: 'x' } }] });
  ok('… an item deleted since the preview answers not_found', gone.status === 200 && res(gone, 'sc_gone').code === 'not_found', show(gone));
  // an edit that lands between the import's read and its write (the row's version CAS)
  const liveV = cat('sc_liner').version;
  world.beforeQuery = async (q) => { if (q.table === 'supply_catalog' && q.op === 'update') cat('sc_liner').version += 1; };
  const lost = await post('catalog/import', 'admin', { items: [{ id: 'sc_liner', create: false, version: liveV, set: { unitPrice: 99 } }] });
  world.beforeQuery = null;
  ok('🔴 an edit landing between the read and the write wins: the import answers stale and writes nothing over it', lost.status === 200
    && res(lost, 'sc_liner').code === 'stale' && cat('sc_liner').unit_price_cents === 3290, `${show(lost)} ${JSON.stringify(cat('sc_liner'))}`);

  // a create that races another save between the read and the insert (the unique index's 23505)
  let raced = false;
  world.beforeQuery = async (q) => {
    if (!raced && q.table === 'supply_catalog' && q.op === 'insert') {
      raced = true;
      world.tables.supply_catalog.push({ ...cat('sc_n2'), id: 'sc_race', sku: 'RACE-1', name: 'Saved elsewhere', version: 1 });
    }
  };
  const r3 = await post('catalog/import', 'admin', { items: [
    { id: 'sc_r1', create: true, set: { sku: 'race-1', name: 'Mine' } },
    { id: 'sc_r2', create: true, set: { sku: 'OK-1', name: 'Fine' } },
  ] });
  world.beforeQuery = null;
  ok('🔴 a SKU taken by a save racing the batch: that item sku_taken, the rest of the batch still saved', r3.status === 200
    && res(r3, 'sc_r1').code === 'sku_taken' && !cat('sc_r1') && res(r3, 'sc_r2').created && cat('sc_r2')?.sku === 'OK-1', show(r3));

  // the body
  const none = await post('catalog/import', 'admin', { items: [] });
  const bad = await post('catalog/import', 'admin', { items: [{ id: 'sc_ok', create: false, set: { name: 'x' } }] });
  const many = await post('catalog/import', 'admin', { items: Array.from({ length: CATALOG_IMPORT_BATCH + 1 }, (_, i) => ({ id: `sc_m${i}`, create: true, set: { name: `m${i}` } })) });
  ok('an empty batch and an update with no version are 400 bad_items; more than a batch 400 too_many, nothing written', none.status === 400 && none.body.code === 'bad_items'
    && bad.status === 400 && bad.body.code === 'bad_items' && many.status === 400 && many.body.code === 'too_many' && !cat('sc_m0'), `${show(none)} ${show(many)}`);

  // ── the link download, with the network swapped for a stand-in (this suite blocks the real one)
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const DNS = {
    'img.example.test': ['93.184.216.34'],
    'inside.example.test': ['10.0.0.5'],
    'mixed.example.test': ['93.184.216.34', '169.254.169.254'],
    'v6.example.test': ['::ffff:127.0.0.1'],
    'cdn.example.test': ['2606:2800:220:1:248:1893:25c8:1946'],
  };
  const SITES = {
    'https://img.example.test/a.png': { status: 200, headers: { 'content-type': 'image/png' }, body: PNG },
    'https://cdn.example.test/b.png': { status: 200, headers: {}, body: PNG },
    'https://img.example.test/page': { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('<html>not a picture</html>') },
    'https://img.example.test/huge.png': { status: 200, headers: { 'content-length': String(4 * 1024 * 1024) }, body: PNG },
    'https://img.example.test/stream.png': { status: 200, headers: {}, body: Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]) },
    'https://img.example.test/missing.png': { status: 404, headers: {}, body: null },
    'https://img.example.test/to-metadata': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' }, body: null },
    'https://img.example.test/to-inside': { status: 301, headers: { location: 'https://inside.example.test/a.png' }, body: null },
    'https://img.example.test/to-a': { status: 302, headers: { location: '/a.png' }, body: null },
    'https://img.example.test/loop': { status: 302, headers: { location: '/loop' }, body: null },
  };
  const asked = [];
  const lookup = (host, opts, cb) => setImmediate(() => {
    const list = DNS[host] || (net.isIP(host) ? [host] : null);
    if (!list) { cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })); return; }
    cb(null, list.map((address) => ({ address, family: net.isIP(address) })));
  });
  const fakeGet = (url, opts, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    asked.push(url);
    // As a real socket does: the name is resolved through the lookup it was GIVEN, then connected.
    opts.lookup(new URL(url).hostname.replace(/^\[|\]$/g, ''), { all: false }, (err) => {
      if (err) { req.emit('error', err); return; }
      const site = SITES[url];
      if (!site) { req.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })); return; }
      const out = Readable.from(site.body ? [site.body] : []);
      out.statusCode = site.status;
      out.headers = site.headers;
      onResponse(out);
    });
    return req;
  };
  __setLinkImageDeps({ lookup, get: fakeGet });
  __resetRateLimit();
  try {
    const link = (url, who = 'admin') => post('catalog/image-link', who, { url });
    const good = await link('https://img.example.test/a.png');
    ok('🔴 task #257: a public link\'s picture comes back as its bytes (a data URL), never cached', good.status === 200
      && good.body.dataUrl === `data:image/png;base64,${PNG.toString('base64')}` && good.body.type === 'image/png' && good.headers['cache-control'] === 'private, no-store', show(good));
    const v6 = await link('https://cdn.example.test/b.png');
    ok('… a public IPv6 host too, the kind read from the bytes (no content-type needed)', v6.status === 200 && v6.body.type === 'image/png', show(v6));
    for (const [url, code, why] of [
      ['http://127.0.0.1/a.png', 'blocked_address', 'a loopback address in the link'],
      ['http://[::1]/a.png', 'blocked_address', 'an IPv6 loopback in the link'],
      ['http://169.254.169.254/latest/meta-data', 'blocked_address', 'the cloud metadata address'],
      ['http://192.168.1.10/a.png', 'blocked_address', 'a private address'],
      ['http://localhost/a.png', 'blocked_address', 'localhost'],
      ['http://printer.local/a.png', 'blocked_address', 'a .local name'],
      ['http://intranet/a.png', 'blocked_address', 'a single-label name'],
      ['https://img.example.test:8443/a.png', 'blocked_port', 'a port other than 80 / 443'],
      ['ftp://img.example.test/a.png', 'bad_link', 'an ftp link'],
      ['https://user:pw@img.example.test/a.png', 'bad_link', 'a link with a password'],
      ['file:///etc/passwd', 'bad_link', 'a file link'],
      ['not a link', 'bad_link', 'words'],
    ]) {
      const r = await link(url);
      ok(`🔴 ${why} is refused before anything is fetched (400 ${code})`, r.status === 400 && r.body.code === code && !asked.includes(url), show(r));
    }
    for (const [url, why] of [
      ['https://inside.example.test/a.png', 'a name that resolves to a private address'],
      ['https://mixed.example.test/a.png', 'a name with ONE private address among public ones'],
      ['https://v6.example.test/a.png', 'a name that resolves to an IPv4-mapped loopback'],
    ]) {
      const r = await link(url);
      ok(`🔴 ${why} is refused at the socket's own lookup (400 blocked_address)`, r.status === 400 && r.body.code === 'blocked_address', show(r));
    }
    const meta = await link('https://img.example.test/to-metadata');
    ok('🔴 a redirect to the metadata address is refused (each hop checked again)', meta.status === 400 && meta.body.code === 'blocked_address' && !asked.some((u) => u.startsWith('http://169.254')), show(meta));
    const inside = await link('https://img.example.test/to-inside');
    ok('🔴 a redirect to a name that resolves inside is refused', inside.status === 400 && inside.body.code === 'blocked_address', show(inside));
    const hop = await link('https://img.example.test/to-a');
    ok('… a redirect on the same public site is followed', hop.status === 200 && hop.body.type === 'image/png', show(hop));
    for (const [url, code, why] of [
      ['https://img.example.test/loop', 'too_many_redirects', 'endless redirects stop'],
      ['https://img.example.test/page', 'not_an_image', 'a page, whatever its content-type says, is not a picture'],
      ['https://img.example.test/huge.png', 'too_large', 'a picture declared over 3 MB is not read'],
      ['https://img.example.test/stream.png', 'too_large', 'a body that streams past 3 MB is cut off'],
      ['https://img.example.test/missing.png', 'not_found', 'a link with nothing there'],
      ['https://nowhere.example.test/a.png', 'unreachable', 'a name that does not resolve'],
    ]) {
      const r = await link(url);
      ok(`${why} (422 ${code})`, r.status === 422 && r.body.code === code, show(r));
    }
    const slow = await (async () => {
      __setLinkImageDeps({ lookup, get: () => { const req = new EventEmitter(); req.destroy = () => {}; return req; } });
      const t0 = Date.now();
      const r = await fetchLinkImage('https://img.example.test/a.png', { timeoutMs: 60 });
      __setLinkImageDeps({ lookup, get: fakeGet });
      return { r, ms: Date.now() - t0 };
    })();
    ok('a link that never answers stops at the deadline (timeout)', slow.r.ok === false && slow.r.code === 'timeout' && slow.ms < 1000, JSON.stringify(slow));
    __resetRateLimit();
    let last = null;
    for (let i = 0; i < LINK_IMAGE_RATE.limit; i += 1) last = await link('not a link', 'sm');
    const over = await link('https://img.example.test/a.png', 'sm');
    const other = await link('https://img.example.test/a.png', 'admin');
    ok(`🔴 a login is held to ${LINK_IMAGE_RATE.limit} links an hour (429 rate-limited); another login is not`, last.status === 400 && over.status === 429 && over.body.code === 'rate-limited' && other.status === 200, `${show(over)} ${show(other)}`);
  } finally {
    __setLinkImageDeps(null);
    __resetRateLimit();
  }
});

console.log(`\ntest-supplies-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
