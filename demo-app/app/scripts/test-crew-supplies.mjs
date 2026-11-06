// REQUEST SUPPLIES FOR CLEANERS (the Cleaner Hub, D4; plan docs/plans/2026-10-13-cleaner-hub.md).
// Matt: "Request Supplies: flag low or out items for their property … I need this option to be
// turned on or off … We can remove their access."
//
// The route's half is test-supplies-route.mjs §18, §20 and §27 (the real handler per role). This
// suite holds the pure rules and the wiring around it:
//   1. 🔴 the default: a cleaner holds `supplies.request` — and nothing else in Supplies
//   2. 🔴 the per-cleaner switch: ONE pure rule (lib/roles overrideForEffective) writes the
//      member's permission override — a revoke when off, cleared when back on (a grant where the
//      stored matrix lacks crew) — through the REAL reducer, and can() reads it; TeamDetail's Time
//      tab wires it with the Access tab's own guards
//   3. 🔴 which buildings are the cleaner's (lib/crewScope crewUpcomingClientIds: cleans today or
//      upcoming, none cancelled; one in progress since last night too)
//   4. 🔴 what the cleaner's read and answer carry (lib/supplies supplyCrewList / supplyCrewOrders /
//      supplyCrewRequest): built FIELD BY FIELD — the product's photo link rides along, no price can;
//      only the cleaner's OWN orders, newest first, at most CREW_SUPPLY_HISTORY_MAX
//   5. the page, rebuilt to Matt's board (S131 Builder C): a − 0 + stepper per item (0–20, the
//      server's cap), no "Other" (SUP-3 a), Submit for Approval off until something is picked, the
//      last-order card and the history, no money helper, writes off while previewing or offline
//   6. 🔴 one of the cleaner's own orders (lib/supplies supplyCrewOrder, crewMayReadOrder: their own
//      order at a building they clean, the office any, nothing else) and its page
//   7. 🔴 the stop's supplies line PER LINE (lib/supplies supplyCrewBuildings): what came today, what
//      is backordered with its ETA, what is on the way — names and quantities only
//
// REGRESSION (THE LAW II.3): before each change the exports and the wiring it names do not exist,
// so every check reports what it wanted (S131 Builder C's counts are in its commit message).
//
//   node app/scripts/test-crew-supplies.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/[^'"`]*$/, ''))).join('\n');

// The app's own imports omit the extension (Vite resolves them); the reducer reads import.meta.env.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) {
        for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
      }
      throw e;
    }
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (/\/app\/src\//.test(url) && r.source && String(r.source).includes('import.meta.env')) {
      r.source = `if (!import.meta.env) import.meta.env = { MODE: 'test', PROD: false, DEV: true };\n${r.source}`;
    }
    return r;
  },
});
const imp = (rel) => import(pathToFileURL(path.join(APP, rel)).href).catch(() => ({}));

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);

const roles = await imp('src/lib/roles.js');
const S = await imp('src/lib/supplies.js');
const scope = await imp('src/lib/crewScope.js');
const reducerMod = await imp('src/store/reducer.js');

// ── 1. the default ───────────────────────────────────────────────────────────
{
  const P = roles.PERMISSIONS || {};
  ok('1a 🔴 D4: cleaners request supplies by default (crew on supplies.request\'s defaults)', (P['supplies.request']?.defaultRoles || []).includes('crew'),
    JSON.stringify(P['supplies.request']?.defaultRoles));
  ok('1b …and hold nothing else in Supplies by default (no prices, no approving, no list editing, no deliveries)',
    ['supplies.view', 'supplies.approve', 'supplies.manage', 'supplies.deliver'].every((k) => !(P[k]?.defaultRoles || []).includes('crew')));
  const can = fn(roles, 'can');
  const m = fn(roles, 'seedPermissions')() || [];
  ok('1c a cleaner on the seeded matrix can request', can({ id: 'u_c', role: 'crew' }, 'supplies.request', m, []) === true);
  ok('1d …and the office tiers keep it', ['owner', 'admin', 'manager'].every((r) => can({ id: `u_${r}`, role: r }, 'supplies.request', m, [])));
  ok('1e Settings → Roles → Crew → Request supplies is the switch for every cleaner (a matrix row without crew refuses them)',
    can({ id: 'u_c', role: 'crew' }, 'supplies.request', m.map((p) => (p.id === 'supplies.request' ? { ...p, roles: ['owner', 'admin', 'manager'] } : p)), []) === false);
}

// ── 2. the per-cleaner switch ────────────────────────────────────────────────
{
  const set = fn(roles, 'overrideForEffective');
  const K = 'supplies.request';
  eq('2a off, when the role has it: a revoke', set({ grants: [], revokes: [], key: K, roleHas: true, on: false }), { grants: [], revokes: [K] });
  eq('2b back on: the revoke is cleared (nothing left — the row prunes)', set({ grants: [], revokes: [K], key: K, roleHas: true, on: true }), { grants: [], revokes: [] });
  eq('2c on where the STORED matrix lacks crew (production until the release adds it): a grant', set({ grants: [], revokes: [], key: K, roleHas: false, on: true }), { grants: [K], revokes: [] });
  eq('2d …and off there clears the grant', set({ grants: [K], revokes: [], key: K, roleHas: false, on: false }), { grants: [], revokes: [] });
  eq('2e the member\'s other overrides are untouched', set({ grants: ['keys.view'], revokes: ['tags.manage'], key: K, roleHas: true, on: false }), { grants: ['keys.view'], revokes: ['tags.manage', K] });
  eq('2f already as asked: nothing changes', set({ grants: [], revokes: [K], key: K, roleHas: true, on: false }), { grants: [], revokes: [K] });
  eq('2g a stray grant on a role that has it is dropped when switched off', set({ grants: [K], revokes: [], key: K, roleHas: true, on: false }), { grants: [], revokes: [K] });

  // Through the REAL reducer, read back by can() — the same data the Access tab edits.
  const reducer = reducerMod.default || reducerMod.reducer || reducerMod.appReducer;
  const A = reducerMod.ACTIONS || {};
  const can = fn(roles, 'can');
  const matrix = fn(roles, 'seedPermissions')() || [];
  let state = { permissions: matrix, userPermissionOverrides: [{ userId: 'u_other', grants: ['keys.view'], revokes: [] }] };
  const crew = { id: 'u_c', role: 'crew' };
  const flip = (on) => {
    const cur = (state.userPermissionOverrides || []).find((o) => o.userId === crew.id) || { grants: [], revokes: [] };
    const roleHas = (matrix.find((p) => p.id === K)?.roles || []).includes(crew.role);
    const next = set({ grants: cur.grants, revokes: cur.revokes, key: K, roleHas, on });
    state = typeof reducer === 'function' ? reducer(state, { type: A.SET_USER_PERMISSION_OVERRIDE, userId: crew.id, ...next }) : state;
  };
  ok('2h (the reducer and its action load)', typeof reducer === 'function' && A.SET_USER_PERMISSION_OVERRIDE === 'SET_USER_PERMISSION_OVERRIDE');
  flip(false);
  ok('2i 🔴 switched OFF through the reducer: can() refuses the cleaner', can(crew, K, state.permissions, state.userPermissionOverrides) === false,
    JSON.stringify(state.userPermissionOverrides));
  flip(true);
  ok('2j 🔴 back ON: can() allows again, and the cleaner\'s override row is gone (pruned, nothing custom left)',
    can(crew, K, state.permissions, state.userPermissionOverrides) === true && !state.userPermissionOverrides.some((o) => o.userId === crew.id)
    && state.userPermissionOverrides.some((o) => o.userId === 'u_other'), JSON.stringify(state.userPermissionOverrides));

  const td = strip(read('src/pages/settings/TeamDetail.jsx'));
  ok('2k TeamDetail\'s Time tab has the "Can request supplies" switch for a cleaner', /Can request supplies/.test(td) && /user\.role === 'crew'/.test(td)
    && /<section id=\{sectionElementId\('time'\)\}[\s\S]*Can request supplies[\s\S]*<\/section>/.test(td));
  ok('2l 🔴 it writes the member\'s override for supplies.request through the one rule and the Access tab\'s action',
    /overrideForEffective\(\{[^}]*key: SUPPLY_REQUEST_KEY/.test(td) && /const SUPPLY_REQUEST_KEY = 'supplies\.request'/.test(td)
    && /dispatch\(\{ type: ACTIONS\.SET_USER_PERMISSION_OVERRIDE, userId: user\.id, \.\.\.next \}\)/.test(td));
  ok('2m 🔴 …behind the Access tab\'s own guards: staff.editOverrides, the owner\'s limits, and turning ON only a key the viewer holds (canGrantPermission)',
    /setSupplyRequests[\s\S]{0,400}canEditOverrides[\s\S]{0,400}overrideLimit[\s\S]{0,600}canGrant\(SUPPLY_REQUEST_KEY\)/.test(td));
  ok('2n a switch the viewer may not use stays in place, disabled, and says why (UI_RULES §118)', /supplySwitchReason/.test(td) && /disabled=\{!!supplySwitchReason\}/.test(td));
}

// ── 3. the cleaner's buildings ───────────────────────────────────────────────
{
  const ids = fn(scope, 'crewUpcomingClientIds');
  const dk = (iso) => String(iso).slice(0, 10);
  const J = (id, clientId, startAt, extra = {}) => ({ id, clientId, siteId: null, crewIds: ['u_c'], startAt, status: 'upcoming', ...extra });
  const jobs = [
    J('a', 'cl_today', '2026-10-13T22:00:00Z'),
    J('b', 'cl_next', '2026-10-20T12:00:00Z'),
    J('c', 'cl_past', '2026-10-06T12:00:00Z'),
    J('d', 'cl_cancel', '2026-10-13T23:00:00Z', { status: 'cancelled' }),
    J('e', 'cl_overnight', '2026-10-12T23:00:00Z', { status: 'in_progress' }),
    { ...J('f', 'cl_other', '2026-10-13T22:00:00Z'), crewIds: ['u_other'] },
    J('g', null, '2026-10-14T12:00:00Z', { siteId: 's_site' }),
  ];
  const got = ids({ jobs, sites: [{ id: 's_site', clientId: 'cl_by_site' }], userId: 'u_c', todayKey: '2026-10-13', dayKeyOf: dk });
  eq('3a 🔴 today and upcoming, a clean in progress since last night, a clean by its location — never the past, a cancelled clean, or someone else\'s',
    [...(got || [])].sort(), ['cl_by_site', 'cl_next', 'cl_overnight', 'cl_today']);
  eq('3b no person, no day: nothing', [...(ids({ jobs, userId: null, todayKey: '2026-10-13', dayKeyOf: dk }) || [])], []);
}


// ── 4. what the cleaner reads and is answered ────────────────────────────────
// S131 Builder C: the list carries each product's PHOTO LINK (signed by the route) and no price;
// what the old status card read (every order in hand at the building, today's deliveries) is
// replaced by the cleaner's OWN orders there — their last order and their history.
const MONEY = /unitPrice|price|cents|total|budget|spend|note|comment|invoice/i;
{
  const list = fn(S, 'supplyCrewList');
  const items = [
    { id: 'si_1', clientId: 'cl_A', catalogItemId: 'sc_glass', sku: 'CL-1', name: 'Glass cleaner', category: 'Liquids', unit: 'each', unitPrice: 6.79, imageV: 3, imageUrl: 'https://img.test/glass.jpg', version: 3, createdAt: 'x' },
    { id: 'si_2', clientId: 'cl_A', catalogItemId: 'sc_liner', sku: null, name: 'Trash liners', category: null, unit: 'case', unitPrice: null },
  ];
  const L = (name, qty, p = 5) => ({ itemId: name, catalogItemId: name, name, qty, unitPrice: p, sku: 'S' });
  const mine = (id, extra) => ({ id, clientId: 'cl_A', requestedByUserId: 'u_c', requestedByName: 'Keisha Bryant', note: 'secret note', totalCents: 1000, ...extra });
  const requests = [
    mine('r_wait', { number: 1049, status: 'open', lines: [L('Trash liners', 2)], createdAt: '2026-10-13T10:00:00Z' }),
    mine('r_appr', { number: 1047, status: 'approved', lines: [L('Bulbs', 1)], createdAt: '2026-10-12T10:00:00Z', approvedAt: '2026-10-13T11:00:00Z', approvedByName: 'Renata Cruz' }),
    // submitted to the supplier; one glass cleaner already came, the liners were cancelled.
    mine('r_sent', { number: 1046, status: 'sent', lines: [L('Glass cleaner', 4), L('Trash liners', 1)], createdAt: '2026-10-11T10:00:00Z', sentAt: '2026-10-13T12:00:00Z',
      fulfillment: [{ deliveries: [{ qty: 1, at: '2026-10-12T15:00:00Z' }], backorder: null, cancelled: null }, { deliveries: [], backorder: null, cancelled: { at: '2026-10-13T12:30:00Z', reason: 'Discontinued' } }] }),
    // someone else's order at the same building: never the cleaner's to read
    { id: 'r_other', clientId: 'cl_A', requestedByUserId: 'u_other', status: 'open', number: 1050, lines: [L('Gloves', 1)], createdAt: '2026-10-13T11:00:00Z' },
  ];
  const out = list({ items, requests, userId: 'u_c', approverName: 'Dana K.' }) || {};
  eq('4a the items, field by field', (out.items || []).map((x) => Object.keys(x)), [S.SUPPLY_CREW_ITEM_KEYS, S.SUPPLY_CREW_ITEM_KEYS]);
  ok('4b 🔴 the allowlist gains ONLY the product photo\'s link (S131) and carries no money',
    Array.isArray(S.SUPPLY_CREW_ITEM_KEYS) && JSON.stringify(S.SUPPLY_CREW_ITEM_KEYS) === JSON.stringify(['id', 'catalogItemId', 'name', 'unit', 'category', 'sku', 'imageUrl'])
    && !S.SUPPLY_CREW_ITEM_KEYS.some((k) => MONEY.test(k)), JSON.stringify(S.SUPPLY_CREW_ITEM_KEYS));
  eq('4c the photo link rides along (null with none) — the version it was signed from does not', (out.items || []).map((x) => [x.imageUrl, 'imageV' in x]),
    [['https://img.test/glass.jpg', false], [null, false]]);
  ok('4d 🔴 no price, total, budget, spend, note, comment or invoice anywhere — even when the rows carry them', !!out.items && !MONEY.test(JSON.stringify(out)), JSON.stringify(out));
  eq('4e the cleaner\'s OWN orders at the building, newest first (someone else\'s never)', (out.orders || []).map((o) => o.id), ['r_wait', 'r_appr', 'r_sent']);
  eq('4f who approves new orders, as "First L."', out.approverName, 'Dana K.');
  eq('4g the old status card\'s reads are gone (replace means delete)', ['open', 'deliveredToday'].filter((k) => k in out), []);
  const many = Array.from({ length: 13 }, (_, i) => mine(`r_${String(i).padStart(2, '0')}`, { number: 1100 + i, status: 'completed', lines: [L('Glass cleaner', 1)], createdAt: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z` }));
  const capped = fn(S, 'supplyCrewOrders')(many, { userId: 'u_c' }) || [];
  ok('4h the history holds at most CREW_SUPPLY_HISTORY_MAX (10), the newest', S.CREW_SUPPLY_HISTORY_MAX === 10 && capped.length === 10 && capped[0].id === 'r_12' && capped[9].id === 'r_03',
    JSON.stringify(capped.map((o) => o.id)));
  eq('4i no person, no orders', (fn(S, 'supplyCrewOrders')(requests, { userId: null }) || ['?']).length, 0);
  const answer = fn(S, 'supplyCrewRequest')({ ...requests[0], clientId: 'cl_A', requestedByUserId: 'u_c' });
  ok('4j 🔴 the answer to a cleaner\'s own request is built field by field too', !!answer && !MONEY.test(JSON.stringify(answer)) && answer.id === 'r_wait'
    && answer.status === 'open' && answer.clientId === 'cl_A' && JSON.stringify(answer.items) === JSON.stringify([{ name: 'Trash liners', qty: 2 }]), JSON.stringify(answer));
}

// ── 5. the page (Matt's RequestSupplies board, S131 Builder C) ───────────────
{
  eq('5a the stepper\'s quantity: 0 to 20, a whole number, 0 (not ordered) by default', [0, 1, 2.6, 20, 21, -3, 'x', null].map((v) => fn(S, 'crewSupplyQty')(v)), [0, 1, 2, 20, 20, 0, 0, 0]);
  eq('5b …its ceiling is ONE constant, the server\'s own cap (20)', S.CREW_SUPPLY_MAX_QTY, 20);
  const block = fn(S, 'crewSupplySendBlock');
  eq('5c nothing above 0: nothing to submit', block({ lines: [{ itemId: 'si_1', qty: 0 }] }), 'nothing_picked');
  eq('5d one item above 0: submit', block({ lines: [{ itemId: 'si_1', qty: 0 }, { itemId: 'si_2', qty: 2 }] }), null);
  eq('5e 🔴 "Other" is gone (SUP-3 a): an Other switch and a note change nothing', [
    block({ lines: [], otherOn: true, note: 'Mop heads' }), block({ lines: [{ itemId: 'si_1', qty: 1 }], otherOn: true, note: '' }),
  ], ['nothing_picked', null]);
  const libSrc = strip(read('src/lib/supplies.js'));
  ok('5f …and its branch and codes are deleted from the rule (replace means delete)', libSrc.length > 0 && !/otherOn|note_required|list_item_required/.test(libSrc));

  const page = strip(read('src/pages/crew/CrewSupplies.jsx'));
  const en = read('src/i18n/catalog/en.js');
  ok('5g the page exists', existsSync(path.join(APP, 'src/pages/crew/CrewSupplies.jsx')));
  ok('5h 🔴 "Other (note below)" and its words are gone from the page and from every catalog (en, es, ht)',
    page.length > 0 && !/otherOn|crewSupplies\.other|notesRequired|crewSupplies\.block\./.test(page)
    && ['en', 'es', 'ht'].every((l) => !/['"]crewSupplies\.(other|notesRequired|block\.noteRequired|block\.listItemRequired)['"]/.test(read(`src/i18n/catalog/${l}.js`))));
  ok('5i 🔴 no money on the cleaner\'s screens: no money helper, price or total in the page or the order view (the photo link is not money)',
    page.length > 0 && ['src/pages/crew/CrewSupplies.jsx', 'src/pages/crew/CrewSupplyOrder.jsx'].every((f) => {
      const s = strip(read(f));
      return s.length > 0 && !/\bmoney\(|fmtMoney|formatMoney|unitPrice|price|supplyRequestTotal|supplyLineTotal|supplyOrderDeliveredCents|SupplyBudget|budget|Cents/i.test(s);
    }) && /imageUrl/.test(page));
  ok('5j …and no line the cleaner reads names a price', !/'crewSupplies?\.[^']+': '[^'\n]*\$/.test(en) && !/'crewSupplyOrder\.[^']+': '[^'\n]*\$/.test(en));
  ok('5k it reads the crew list and sends through the adapter with an id minted once per attempt', /suppliesApi\.crewList\(/.test(page) && /suppliesApi\.createRequest\(/.test(page)
    && /if \(!pendingId\.current\) pendingId\.current = suppliesApi\.newSupplyRequestId\(\)/.test(page));
  ok('5l 🔴 every write is off while the owner previews a cleaner, and offline', /useCrewPreview\(\)/.test(page) && /previewing/.test(page) && /useOnlineStatus\(\)/.test(page)
    && /disabled=\{[^}]*sendDisabled/.test(page) && /const sendDisabled = previewing \|\| !online \|\| send\.busy \|\| !!block/.test(page));
  ok('5m the key held is the gate on the page, with the honest "turned off" line', /usePermission\('supplies\.request'\)/.test(page) && /crewSupplies\.off/.test(page));
  ok('5n words are catalog lines (crewSupplies.*), the paths come from crewPaths', /t\('crewSupplies\./.test(page) && /crewPaths\./.test(page) && !/['`"]\/my-day\//.test(page));
  ok('5o 🔴 a − 0 + stepper per item: − off at 0, + off at the cap, grouped by category when there is more than one group',
    /crewSupplyQty\(/.test(page) && /groupSupplyByCategory\(/.test(page) && /disabled=\{[^}]*qty <= 0/.test(page) && /disabled=\{[^}]*qty >= CREW_SUPPLY_MAX_QTY/.test(page)
    && !/type="checkbox"/.test(page));
  ok('5p each row: the product photo (40 px, nothing when none), the name, how it comes', /\{it\.imageUrl \? <img\b[^>]*src=\{it\.imageUrl\}/.test(page) && /className="crew-sup-thumb"/.test(page)
    && /it\.unit/.test(page) && /'crewSupplies\.orderTitle'/.test(page) && /'crewSupplies\.orderHint'/.test(page));
  ok('5q 🔴 Submit for Approval, off until at least one quantity is above 0 (the reason said), with the board\'s review line',
    /crewSupplySendBlock\(\{ lines \}\)/.test(page) && /'crewSupplies\.submit'/.test(page) && /'crewSupplies\.pickOne'/.test(page) && /'crewSupplies\.reviewNote'/.test(page)
    && /'crewSupplies\.submit': 'Submit for Approval'/.test(en));
  ok('5r 🔴 "Your last order": the newest of the cleaner\'s orders here, its crew status chip and each line\'s state in their words (an ETA in the org zone)',
    /const last = orders\[0\] \|\| null/.test(page) && /supplyOrderLabelKey\(last, 'crew'\)/.test(page) && /supplyOrderVariant\(last\)/.test(page)
    && /<CrewOrderLines\b/.test(page));
  const parts = strip(read('src/pages/crew/supplyOrderParts.jsx'));
  ok('5s …one line per item from its own state — delivered · backordered with its ETA · on order · not available',
    ['line.delivered', 'line.backordered', 'line.onOrder', 'line.notAvailable'].every((k) => parts.includes(`'crewSupplies.${k}'`))
    && /supplyEtaInstant\(l\.eta\)/.test(parts) && /SUPPLY_LINE_STATE\.(delivered|backordered|cancelled)/.test(parts));
  // S131 integration (the coordinator): the cleaner's supplyItemCancelled bell already carries the
  // office's reason, so the order's line says it too — "Glass cleaner (1) not available — Discontinued".
  ok('5s2 🔴 a line the office could not get says why, as the cleaner\'s bell did: "{item} not available — {reason}"',
    /l\.reason \? t\('crewSupplies\.line\.notAvailableReason', \{ item, reason: l\.reason \}\)/.test(parts)
    && /'crewSupplies\.line\.notAvailableReason': '\{item\} not available — \{reason\}'/.test(en));
  ok('5t 🔴 Order History: each of the cleaner\'s orders here (the server\'s 10), its number and date, items, status chip — opening the order view with the referrer',
    /'crewSupplies\.history\.title'/.test(page) && /orders\.map\(/.test(page) && /to=\{crewPaths\.supplyOrder\(o\.id\)\}/.test(page) && /state=\{nav\}/.test(page)
    && /supplyOrderLabelKey\(o, 'crew'\)/.test(page));
  ok('5u the success line names who approves it next ("{First L.} approves it next")', /'crewSupplies\.sent\.body', \{ name: send\.sent\.approverName \}/.test(page)
    && /'crewSupplies\.sent\.body': '\{name\} approves it next\.'/.test(en));
  ok('5v a refusal of the cap is said in words (400 qty_over_cap, never clamped)', /qty_over_cap/.test(page) && /'crewSupplies\.error\.overCap'/.test(page));
  ok('5w 🔴 the old status card and its words are gone (en, es, ht)', !/crewSupplies\.status\./.test(page)
    && ['en', 'es', 'ht'].every((l) => !/['"]crewSupplies\.status\./.test(read(`src/i18n/catalog/${l}.js`))));
  const app = read('src/App.jsx');
  ok('5x /my-day/supplies is a crew route (the page holds the key\'s gate, so a switched-off cleaner reads why)',
    /<Route path="my-day\/supplies" element=\{<RequirePerm perm="time\.clock"><CrewSupplies \/><\/RequirePerm>\} \/>/.test(app)
    && /const CrewSupplies = lazyRoute\(\(\) => import\('\.\/pages\/crew\/CrewSupplies'\)\)/.test(app));
  const api = strip(read('src/lib/suppliesApi.js'));
  ok('5y the adapter has the crew read, real and demo, the demo running the route\'s rules (the person on screen for the office\'s View-as)',
    /export async function crewList\(clientId, ctx, \{ userId = null \} = \{\}\)/.test(api) && /api\(`\/supplies\/crew-list\?\$\{qs\(\{ clientId, userId \}\)\}`\)/.test(api)
    && /function stubCrewList\(/.test(api) && /crewUpcomingClientIds\(/.test(api) && /supplyCrewList\(\{/.test(api) && /stubCrewSubject\(ctx, userId\)/.test(api));
  ok('5z the demo\'s create refuses a building the cleaner does not clean, as the route does', /not_your_building/.test(api)
    && /function stubCreate\([^)]*\) \{\s*const mine = stubCrewBuildings\(ctx\);\s*if \(mine && !mine\.has\(payload\.clientId\)\) throw notYourBuilding\(\);/.test(api)
    && /function stubCrewBuildings\([\s\S]*?crewUpcomingClientIds\(/.test(api));
}

// ── 6. one of the cleaner's own orders (EP-400) and its page ─────────────────
{
  const one = fn(S, 'supplyCrewOrder');
  const L = (name, qty, p = 5) => ({ itemId: name, catalogItemId: name, name, qty, unitPrice: p, sku: 'S' });
  const row = {
    id: 'sr_1046', number: 1046, clientId: 'cl_A', status: 'sent', note: 'Out of towels', totalCents: 9999, sentTotalCents: 1,
    requestedByUserId: 'u_c', requestedByName: 'Keisha Bryant', createdAt: '2026-10-10T18:00:00Z',
    approvedAt: '2026-10-10T19:00:00Z', approvedByUserId: 'u_r', approvedByName: 'Renata Cruz',
    sentAt: '2026-10-11T10:00:00Z', sentByName: 'Kyler Office',
    lines: [L('Paper towels', 3), L('Trash liners', 2), L('Hand soap', 2), L('Glass cleaner', 1)],
    fulfillment: [
      { deliveries: [{ qty: 1, at: '2026-10-12T13:00:00Z', byName: 'Alberto Reyes' }, { qty: 2, at: '2026-10-13T13:15:00Z', byName: 'Alberto Reyes' }], backorder: null, cancelled: null },
      { deliveries: [], backorder: { at: '2026-10-13T09:00:00Z', byName: 'Kyler Office', eta: '2026-10-21' }, cancelled: null },
      { deliveries: [], backorder: null, cancelled: null },
      { deliveries: [], backorder: null, cancelled: { at: '2026-10-13T09:00:00Z', byName: 'Kyler Office', reason: 'Discontinued by the supplier' } },
    ],
    comments: [{ body: 'x' }], invoices: [{ fileName: 'Invoice.pdf' }],
  };
  const o = one(row) || {};
  eq('6a 🔴 the order, field by field — exactly the allowlist', Object.keys(o), S.SUPPLY_CREW_ORDER_KEYS || ['?']);
  ok('6b …which carries no money, note, comment, invoice, photo or SKU', Array.isArray(S.SUPPLY_CREW_ORDER_KEYS) && !S.SUPPLY_CREW_ORDER_KEYS.some((k) => MONEY.test(k) || /photo|sku/i.test(k))
    && !MONEY.test(JSON.stringify(o)) && !/Alberto|Kyler|"S"/.test(JSON.stringify(o)), JSON.stringify(o));
  eq('6c its number, building, status and the computed fulfilment state', [o.id, o.no, o.clientId, o.status, o.fulfillmentState], ['sr_1046', 'SO-1046', 'cl_A', 'sent', 'partial']);
  eq('6d each line field by field: name, quantity, state, how many came, an ETA only while backordered, the last delivery\'s time',
    (o.lines || []).map((l) => Object.keys(l)), Array(4).fill(S.SUPPLY_CREW_LINE_KEYS || ['?']));
  eq('6e …delivered (its latest delivery) · backordered (its ETA) · on order · not available WITH the office\'s reason (only that line)', (o.lines || []).map((l) => [l.name, l.qty, l.state, l.delivered, l.eta, l.deliveredAt, l.reason]), [
    ['Paper towels', 3, 'delivered', 3, null, '2026-10-13T13:15:00Z', null],
    ['Trash liners', 2, 'backordered', 0, '2026-10-21', null, null],
    ['Hand soap', 2, 'pending', 0, null, null, null],
    ['Glass cleaner', 1, 'cancelled', 0, null, null, 'Discontinued by the supplier'],
  ]);
  eq('6s 🔴 the line\'s allowlist gains ONLY the reason (S131 integration: the bell already told the cleaner)', S.SUPPLY_CREW_LINE_KEYS,
    ['name', 'qty', 'state', 'delivered', 'eta', 'deliveredAt', 'reason']);
  const legacy = one({ ...row, status: 'completed', fulfillment: undefined, sentLines: [{ qtySent: 3 }, { qtySent: 2 }, { qtySent: 2 }, { qtySent: 0 }], completedAt: '2026-10-12T10:00:00Z' }) || {};
  eq('6t …a line cancelled with no reason given (an order completed before the per-line record) says only "not available"', (() => { const l = (legacy.lines || [])[3]; return l && 'reason' in l ? l.reason : 'missing'; })(), null);
  eq('6f who asked and who approved, as "First L.", and when', [o.requestedBy, o.requestedAt, o.approvedBy, o.approvedAt, o.declinedBy, o.declineReason],
    ['Keisha B.', '2026-10-10T18:00:00Z', 'Renata C.', '2026-10-10T19:00:00Z', null, null]);
  const declined = one({ ...row, status: 'rejected', fulfillment: null, approvedAt: null, approvedByName: null, rejectedAt: '2026-10-11T09:00:00Z', rejectedByName: 'Renata Cruz', rejectionReason: 'Ordered last week' }) || {};
  eq('6g a declined order says who declined it, when, and the reason — the same words the cleaner\'s bell carried', [declined.declinedBy, declined.declinedAt, declined.declineReason],
    ['Renata C.', '2026-10-11T09:00:00Z', 'Ordered last week']);
  eq('6h 🔴 the crew shape reads the SAME status words as the full row, at every phase', ['open', 'approved', 'sent', 'completed', 'rejected'].map((st) => {
    const full = { ...row, status: st, fulfillment: st === 'sent' || st === 'completed' ? row.fulfillment : null };
    return S.supplyOrderLabelKey && S.supplyOrderLabelKey(one(full) || {}, 'crew') === S.supplyOrderLabelKey(full, 'crew');
  }), [true, true, true, true, true]);
  eq('6i no order, nothing', one(null), null);

  // WHO may read one (the route and the stub read this ONE rule).
  const may = fn(S, 'crewMayReadOrder');
  const mineA = { id: 'x', clientId: 'cl_A', requestedByUserId: 'u_c' };
  const ids = new Set(['cl_A', 'cl_B']);
  eq('6j 🔴 the cleaner reads their OWN order at a building they clean today or upcoming — nothing else; the office any (the owner\'s View-as)', [
    may({ order: mineA, selfId: 'u_c', office: false, buildingIds: ids }),
    may({ order: { ...mineA, clientId: 'cl_C' }, selfId: 'u_c', office: false, buildingIds: ids }),
    may({ order: { ...mineA, requestedByUserId: 'u_other' }, selfId: 'u_c', office: false, buildingIds: ids }),
    may({ order: mineA, selfId: null, office: false, buildingIds: ids }),
    may({ order: null, selfId: 'u_c', office: false, buildingIds: ids }),
    may({ order: { ...mineA, requestedByUserId: 'u_other', clientId: 'cl_Z' }, selfId: 'u_admin', office: true, buildingIds: new Set() }),
    may({ order: null, selfId: 'u_admin', office: true, buildingIds: new Set() }),
  ], [true, false, false, false, false, true, false]);

  const view = strip(read('src/pages/crew/CrewSupplyOrder.jsx'));
  ok('6k the order view exists and reads ONE order through the adapter (EP-400), by the route\'s id', view.length > 0 && /suppliesApi\.crewOrder\(id, /.test(view) && /useParams\(\)/.test(view));
  ok('6l it shows the number, the building, the status chip, each line\'s state with when, and who asked and approved',
    /'crewSupplyOrder\.title'/.test(view) && /selectClientById\(/.test(view) && /supplyOrderLabelKey\(order, 'crew'\)/.test(view)
    && /<CrewOrderLines\b[^>]*withWhen/.test(view) && /'crewSupplyOrder\.requested'/.test(view) && /'crewSupplyOrder\.approved'/.test(view));
  ok('6m 🔴 and NO prices, invoice, comments, photos or totals (no such reads, words or galleries)',
    view.length > 0 && !/MediaGallery|invoice|comment|getOrder\(|listMedia|photo/i.test(view) && !/'crewSupplyOrder\.[^']+': '[^'\n]*(invoice|comment|photo|\$)/i.test(read('src/i18n/catalog/en.js')));
  ok('6n its states: loading, not one you can open (404, naming nothing), no signal, a failed read with Try again, turned off',
    /code === 'not_found'/.test(view) && /'crewSupplyOrder\.notFound'/.test(view) && /'crewSupplyOrder\.offline'/.test(view)
    && /'crewSupplyOrder\.loadFailed'/.test(view) && /'crewSupplies\.tryAgain'/.test(view) && /'crewSupplies\.off'/.test(view));
  ok('6o 🔴 it opens cold from a bell: Back goes to the referrer, else Request Supplies for the order\'s building', /useBackTarget\(crewPaths\.supplies\(/.test(view)
    && /t\('crewSupplies\.title'\)/.test(view));
  const app = read('src/App.jsx');
  ok('6p 🔴 /my-day/supplies/orders/:id is a crew route keyed by the order (the path the bells write, lib/crewPaths)',
    /<Route path="my-day\/supplies\/orders\/:id" element=\{<RequirePerm perm="time\.clock"><KeyedByParam name="id"><CrewSupplyOrder \/><\/KeyedByParam><\/RequirePerm>\} \/>/.test(app)
    && /const CrewSupplyOrder = lazyRoute\(\(\) => import\('\.\/pages\/crew\/CrewSupplyOrder'\)\)/.test(app)
    && (await imp('src/lib/crewPaths.js')).crewPaths?.supplyOrder('sr_1') === '/my-day/supplies/orders/sr_1');
  const api = strip(read('src/lib/suppliesApi.js'));
  ok('6q the adapter reads one order (EP-400), real and demo, the demo running the route\'s one rule and shape',
    /export async function crewOrder\(id, ctx\)/.test(api) && /api\(`\/supplies\/crew-order\?\$\{qs\(\{ id \}\)\}`\)/.test(api)
    && /function stubCrewOrder\([\s\S]*?crewMayReadOrder\(\{[\s\S]*?supplyCrewOrder\(order\)/.test(api));
  ok('6r and the cleaner\'s newest orders for Home\'s tile (EP-401), real and demo', /export async function crewOrders\(\{ userId = null \} = \{\}, ctx\)/.test(api)
    && /api\(`\/supplies\/crew-orders\?\$\{qs\(\{ userId \}\)\}`\)/.test(api) && /function stubCrewOrders\([\s\S]*?supplyCrewOrders\(/.test(api));
}

// ── 7. the stop's supplies line, PER LINE (EP-368 onsite) ────────────────────
{
  const lines = fn(S, 'supplyCrewBuildings');
  const day = Date.parse('2026-10-13T04:00:00Z');
  const L = (name, qty, p = 5) => ({ itemId: name, catalogItemId: name, name, qty, unitPrice: p, sku: 'S' });
  const reqs = [
    { id: 's1', clientId: 'cl_A', status: 'sent', note: 'call me', sentAt: '2026-10-13T08:00:00Z',
      lines: [L('Paper towels', 3), L('Trash liners', 2), L('Hand soap', 2), L('Gloves', 1)],
      fulfillment: [
        { deliveries: [{ qty: 3, at: '2026-10-13T13:15:00Z', byName: 'Alberto Reyes' }], backorder: null, cancelled: null },
        { deliveries: [], backorder: { at: '2026-10-13T09:00:00Z', eta: '2026-10-21' }, cancelled: null },
        { deliveries: [{ qty: 1, at: '2026-10-12T13:00:00Z' }], backorder: null, cancelled: null },
        { deliveries: [], backorder: null, cancelled: { at: '2026-10-13T09:00:00Z', reason: 'Gone' } },
      ] },
    { id: 's2', clientId: 'cl_A', status: 'sent', sentAt: '2026-10-13T09:00:00Z', lines: [L('Hand soap', 4)], fulfillment: [{ deliveries: [], backorder: null, cancelled: null }] },
    { id: 'd1', clientId: 'cl_A', status: 'completed', completedAt: '2026-10-13T15:10:00Z', completedByName: 'Alberto Reyes', lines: [L('Towels', 2)], sentLines: [{ qtySent: 2 }] },
    { id: 'old', clientId: 'cl_A', status: 'completed', completedAt: '2026-10-12T15:10:00Z', lines: [L('Towels', 9)] },
    { id: 'b1', clientId: 'cl_B', status: 'sent', lines: [L('Glass cleaner', 1)] },
  ];
  const out = lines({ requests: reqs, clientIds: new Set(['cl_A']), dayStartMs: day }) || [];
  eq('7a 🔴 per building it leaves, per LINE: what came today (name, how many, when), what is backordered (its ETA), what is on the way — and nothing else',
    out.map((b) => Object.keys(b)), [['clientId', 'delivered', 'backordered', 'onTheWay']]);
  const a = out[0] || {};
  eq('7b "Paper towels delivered today at 9:15 AM": each line delivered TODAY, newest first (yesterday\'s gone)', a.delivered,
    [{ name: 'Towels', qty: 2, at: '2026-10-13T15:10:00Z' }, { name: 'Paper towels', qty: 3, at: '2026-10-13T13:15:00Z' }]);
  eq('7c "Trash liners backordered — ETA Oct 21": each backordered line still to come, with its ETA', a.backordered, [{ name: 'Trash liners', qty: 2, eta: '2026-10-21' }]);
  eq('7d "Supplies on the way: …": the submitted lines not yet here (not backordered, not cancelled), one per item name, summed', a.onTheWay,
    [{ name: 'Hand soap', qty: 5 }]);
  ok('7e 🔴 names and quantities only — no price, total, budget, note, SKU, reason or person', !/unitPrice|price|cents|total|budget|note|sku|"S"|Gone|Reyes|by/i.test(JSON.stringify(out)), JSON.stringify(out));
  eq('7f only the buildings asked for, and only with something to say', lines({ requests: reqs, clientIds: new Set(['cl_Z']), dayStartMs: day }), []);

  const note = strip(read('src/components/CrewSupplyNote.jsx'));
  ok('7g the note renders the three kinds of line in the catalog\'s words, an ETA in the org zone', /'crewSupply\.lineDelivered'/.test(note) && /'crewSupply\.lineBackordered'/.test(note)
    && /'crewSupply\.onTheWay'/.test(note) && /supplyEtaInstant\(/.test(note));
  ok('7h 🔴 …with no money helper, and the per-order words it replaced are gone (en, es, ht)', !/money\(|unitPrice|Total|budget/.test(note)
    && ['en', 'es', 'ht'].every((l) => !/['"]crewSupply\.(deliveredToday|deliveredTodayNoName|items)['"]/.test(read(`src/i18n/catalog/${l}.js`))));
}

// ── 8. the words, the inventory, the term list ───────────────────────────────
{
  const cov = read('scripts/test-i18n-coverage.mjs');
  ok('8a the cleaner\'s new screens are on the catalog\'s converted list', ['src/pages/crew/CrewSupplyOrder.jsx', 'src/pages/crew/supplyOrderParts.jsx'].every((f) => cov.includes(`'${f}'`)));
  const terms = (() => { try { return readFileSync(path.join(APP, '..', 'docs', 'i18n', 'term-list.md'), 'utf8'); } catch { return ''; } })();
  ok('8b the term list names order, backordered and ETA for the Google pass', /\border\b/.test(terms) && /backordered/.test(terms) && /\bETA\b/.test(terms) && /S131/.test(terms));
}

// ── 9. the demo tells the cleaner's story at the stop she is on (S131 integration) ────────────
// Daniel's walkthrough opens the demo as Keisha. Home's tile, Request Supplies (opened on her stop in
// progress), the last-order card and the Order History must all show the supply-order story THERE: a
// switched-on list, and her OWN orders — one partly delivered (a line delivered, with its delivery photo,
// and a line backordered with the supplier's day), one waiting for approval, one New, one completed with
// its invoice — approved by her account manager. Her stop is read from the day the demo builds
// (data/demoManagerDay buildManagerDay: the clean she is on), never restated here.
{
  const stubsMod = await imp('src/data/demoStubs.js');
  const keysMod = await imp('src/data/stubKeys.js');
  const dayMod = await imp('src/data/demoManagerDay.js');
  const mediaMod = await imp('src/data/demoSiteMedia.js');
  const seedMod = await imp('src/data/seed.js');
  const datesMod = await imp('src/lib/dates.js');
  const KEISHA = 'u_seed_crew3';
  // 🔴 READ THE STORY AT MIDDAY ON THE ORG'S CLOCK (CS-859). The demo's day is built in the org's
  // zone and is complete from about 6 AM to 11 PM there, thinning at its ends (a visit that began
  // before the org's midnight is yesterday's). Keisha's Coral Bay visit began 36 minutes before
  // `now`, so read at the real clock the story had no stop for her from midnight to 00:41 Eastern —
  // eight checks red every night, on any machine and in CI. The day is read at 2 PM Eastern today.
  const tz = datesMod.DEFAULT_ORG_TIMEZONE;
  const storyNow = typeof datesMod.composeIso === 'function' ? new Date(datesMod.composeIso(datesMod.dayKey(new Date(), tz), '14:00', tz)) : new Date();
  const day = typeof dayMod.buildManagerDay === 'function' ? dayMod.buildManagerDay(storyNow, { tz }) : { jobs: [] };
  const onSite = (day.jobs || []).find((j) => j.status === 'in_progress' && (j.crewIds || []).includes(KEISHA));
  const stop = onSite ? onSite.clientId : null;
  const db = typeof stubsMod.buildDemoStubs === 'function' ? (stubsMod.buildDemoStubs()[keysMod.SUPPLIES_STUB_KEY] || {}) : {};
  const list = (db.items || []).filter((it) => it.clientId === stop);
  const hers = (db.requests || []).filter((r) => r.clientId === stop && r.requestedByUserId === KEISHA);
  const states = JSON.stringify(hers.map((r) => [r.id, r.status]));
  ok('9a (the demo day has Keisha on the clock at a building: her stop, the one her Request Supplies opens on)', !!stop, JSON.stringify(onSite || null));
  ok('9b 🔴 her stop has a switched-on supply list (Request Supplies opens on a list, not "no supply list yet")', list.length > 0, `${stop}: ${list.length} items`);
  const byStatus = (st) => hers.filter((r) => r.status === st);
  const partial = byStatus('sent').find((r) => {
    const p = S.supplyOrderProgress ? S.supplyOrderProgress(r) : { lines: [] };
    return p.lines.some((l) => l.state === 'delivered') && p.lines.some((l) => l.state === 'backordered' && l.eta);
  });
  ok('9c 🔴 her orders there tell the story: one partly delivered — a line delivered, a line backordered with the supplier\'s day', !!partial, states);
  const photos = typeof mediaMod.buildDemoSiteMedia === 'function' ? (mediaMod.buildDemoSiteMedia().media || []) : [];
  ok('9d …its delivered line has a delivery photo, filed under the order at her stop',
    !!partial && photos.some((m) => m.scope === 'supply' && m.ref_id === partial.id && m.client_id === stop), JSON.stringify(photos.filter((m) => m.scope === 'supply')));
  ok('9e …and one waiting for approval, one New (approved), one completed with its invoice', byStatus('open').length >= 1 && byStatus('approved').length >= 1
    && byStatus('completed').some((r) => (db.invoices || []).some((inv) => inv.requestId === r.id)), states);
  ok('9f every line of her orders there is an item on that list (her order sheet and her history agree)', hers.length > 0
    && hers.every((r) => (r.lines || []).every((l) => list.some((it) => it.id === l.itemId && it.catalogItemId === l.catalogItemId))), states);
  const building = ((seedMod.INITIAL_STATE || seedMod.default || {}).clients || []).find((c) => c.id === stop);
  ok('9g her stop is her account manager Renata\'s, who approved what was approved', !!building && building.supervisorId === 'u_seed_mgr1'
    && hers.filter((r) => r.approvedAt).every((r) => r.approvedByUserId === 'u_seed_mgr1'), JSON.stringify(building ? building.supervisorId : null));
  const read = S.supplyCrewList ? S.supplyCrewList({ items: list, requests: db.requests || [], userId: KEISHA, approverName: 'Renata C.' }) : { orders: [] };
  ok('9h 🔴 so her page reads the whole story back — the history holds all four, the newest first', ['open', 'approved', 'sent', 'completed'].every((st) => read.orders.some((o) => o.status === st))
    && read.orders[0] && read.orders[0].requestedAt === hers.map((r) => r.createdAt).sort().pop(), JSON.stringify(read.orders.map((o) => [o.no, o.status])));
}

console.log(`\ncrew supplies: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exitCode = 1;
}
