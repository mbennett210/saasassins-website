// A CHECKLIST BELONGS TO ONE CUSTOMER (R2) — the rules, and the proof that all three
// implementations read them from ONE place.
//
// WHY ONE PLACE. `lib/inspections.js` is already the shared, browser-dep-free rule module
// for scoring, the list cap and the publish refusal, imported by BOTH the server store
// (`api/_lib/qc/store.js`) and the demo stub (`lib/qcApi.js`) precisely so a rule cannot
// mean two things. Step 5 adds four rules of the same class and they go in the same place:
//   · which rows a template list returns (a customer's, the starters', or all);
//   · that creating a CHECKLIST requires a customer and creating an INSPECTION refuses one;
//   · what a COPY starts from and whether it is published at once;
//   · the narrow summary row step 6's problems view reads.
//
// THE STUB CANNOT BE IMPORTED HERE. `lib/qcApi.js` uses extensionless imports (Vite
// resolves them, bare Node does not) and DEV_PLAYBOOK 3.9.5 forbids a test registering a
// resolver hook to repair them. So the rules are unit-tested directly and the stub is held
// to them MECHANICALLY over its source, the same shape `test-checklist-by-user-id.mjs`
// uses. The stub's behaviour itself is driven in the demo browser (the drive log in the
// build's report), and the SERVER half of every rule is driven through the real handler in
// `test-checklist-location-route.mjs`.
//
// Failing-first by construction: pre-fix `lib/inspections.js` exports none of this, so the
// import throws.
//
//   node app/scripts/test-checklist-location-rules.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CHECKLIST_NEEDS_CUSTOMER, INSPECTION_TAKES_NO_CUSTOMER, TEMPLATE_FILTER_CONFLICT,
  COPY_SOURCE_MUST_BE_CHECKLIST, TEMPLATE_KINDS, TEMPLATE_KIND_MESSAGE,
  templateKind, createTemplateRefusal, copyTemplateRefusal, templateFilterRefusal,
  templateKindRefusal, templateMatchesFilters, planTemplateCopy, toTemplateSummaryRow,
  newestTemplateFirst, countSchemaItems, NO_ITEMS_MESSAGE,
} from '../src/lib/inspections.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (p) => { try { return readFileSync(path.join(APP, p), 'utf8'); } catch { return ''; } };
const QCAPI = read('src/lib/qcApi.js');
const STORE = read('api/_lib/qc/store.js');
const ROUTE = read('api/qc/[...path].js');
const STUBKEYS = read('src/data/stubKeys.js');
const DEMOSTUBS = read('src/data/demoStubs.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── the kind, normalized the ONE way the insert normalizes it ────────────────
{
  eq('checklist stays a checklist', templateKind('checklist'), 'checklist');
  eq('anything else is an inspection', templateKind('inspection'), 'inspection');
  eq('…including nothing at all', templateKind(undefined), 'inspection');
  eq('…and including a near miss', templateKind('Checklist'), 'inspection');
}

// ── CREATE: a checklist needs a customer; an inspection refuses one ──────────
{
  eq('a checklist with no customer is refused', createTemplateRefusal({ kind: 'checklist' }), CHECKLIST_NEEDS_CUSTOMER);
  eq('…and with an empty one', createTemplateRefusal({ kind: 'checklist', clientId: '' }), CHECKLIST_NEEDS_CUSTOMER);
  eq('a checklist with a customer proceeds', createTemplateRefusal({ kind: 'checklist', clientId: 'cl_seed_mtbaker' }), null);
  eq('an inspection proceeds without one', createTemplateRefusal({ kind: 'inspection' }), null);
  eq('an inspection WITH one is refused — inspections stay company-wide',
    createTemplateRefusal({ kind: 'inspection', clientId: 'cl_seed_mtbaker' }), INSPECTION_TAKES_NO_CUSTOMER);
  eq('…and so is an unrecognised kind carrying one (it becomes an inspection)',
    createTemplateRefusal({ kind: 'whatever', clientId: 'cl_seed_mtbaker' }), INSPECTION_TAKES_NO_CUSTOMER);
  ok(/customer/i.test(CHECKLIST_NEEDS_CUSTOMER) && !/client_id|clientId|400/.test(CHECKLIST_NEEDS_CUSTOMER),
    'the refusal is a plain sentence for the office, not a field name or a status code');
}

// ── LIST: a customer's rows, the starters, or everything ────────────────────
const T = (id, kind, clientId, extra = {}) => ({ id, kind, client_id: clientId, name: id, ...extra });
const ROWS = [
  T('it_floorcare', 'checklist', 'cl_bay'),
  T('it_fullclean', 'checklist', 'cl_bay'),
  T('it_lobby', 'checklist', 'cl_olas'),
  T('it_closeout', 'checklist', null),
  T('it_janitorial', 'inspection', null),
];
const ids = (f) => ROWS.filter((t) => templateMatchesFilters(t, f)).map((t) => t.id);
{
  eq('no filter keeps every row (today\'s behaviour)', ids({}), ROWS.map((t) => t.id));
  eq('a kind filters as it always did', ids({ kind: 'checklist' }), ['it_floorcare', 'it_fullclean', 'it_lobby', 'it_closeout']);
  eq('a customer gives THAT customer\'s rows only — never the starters',
    ids({ kind: 'checklist', clientId: 'cl_bay' }), ['it_floorcare', 'it_fullclean']);
  eq('another customer\'s rows are a different set', ids({ kind: 'checklist', clientId: 'cl_olas' }), ['it_lobby']);
  eq('starters are the rows with NO customer', ids({ kind: 'checklist', starters: true }), ['it_closeout']);
  eq('starters + no kind still excludes every filed row', ids({ starters: true }), ['it_closeout', 'it_janitorial']);
  eq('a customer nobody has a checklist for is empty, not everything', ids({ kind: 'checklist', clientId: 'cl_nobody' }), []);
  eq('an undefined client_id reads as no customer',
    templateMatchesFilters({ id: 'x', kind: 'checklist' }, { starters: true }), true);
  eq('…and never as a match for a customer',
    templateMatchesFilters({ id: 'x', kind: 'checklist' }, { clientId: 'cl_bay' }), false);
  eq('a missing row never matches', templateMatchesFilters(null, {}), false);

  // Asking for one customer AND the starters is a contradiction, and answering it with an
  // empty list would look like "this customer has none".
  eq('one customer and starters together is refused',
    templateFilterRefusal({ clientId: 'cl_bay', starters: true }), TEMPLATE_FILTER_CONFLICT);
  eq('either alone proceeds', [templateFilterRefusal({ clientId: 'cl_bay' }), templateFilterRefusal({ starters: true })], [null, null]);
  eq('neither proceeds', templateFilterRefusal({}), null);

  // …and `kind` is a VOCABULARY. Unvalidated it went straight into `.eq('kind', …)`, so a
  // typo came back as an empty list that reads exactly like "there are none".
  eq('the kinds are the two the schema allows', TEMPLATE_KINDS, ['inspection', 'checklist']);
  eq('absent is no filter', templateKindRefusal(undefined), null);
  eq('…and so is empty', templateKindRefusal(''), null);
  eq('each real kind proceeds', TEMPLATE_KINDS.map(templateKindRefusal), [null, null]);
  eq('a near miss is refused', templateKindRefusal('checklists'), TEMPLATE_KIND_MESSAGE);
  eq('…and so is the wrong case — the column stores one exact spelling', templateKindRefusal('Checklist'), TEMPLATE_KIND_MESSAGE);
  ok(TEMPLATE_KINDS.every((k) => TEMPLATE_KIND_MESSAGE.includes(k)), 'the refusal names the kinds there are');
}

// ── COPY: what version 1 is, and whether it is published at once ────────────
const ONE = { areas: [{ id: 'a', label: 'A', items: [{ id: 'i1', label: 'Sweep' }, { id: 'i2', label: 'Mop' }] }] };
const DRAFT = { areas: [{ id: 'a', label: 'A', items: [{ id: 'i1', label: 'Sweep' }] }] };
const EMPTY = { areas: [] };
{
  eq('a published source is copied from its PUBLISHED schema, and published at once',
    planTemplateCopy({ kind: 'checklist', publishedSchema: ONE, latestSchema: DRAFT, sourcePublished: true }),
    { schema: ONE, publish: true });
  eq('…never from the newer draft beside it',
    planTemplateCopy({ kind: 'checklist', publishedSchema: ONE, latestSchema: DRAFT, sourcePublished: true }).schema, ONE);
  eq('an UNPUBLISHED source is copied from its latest draft, and stays a draft',
    planTemplateCopy({ kind: 'checklist', publishedSchema: null, latestSchema: DRAFT, sourcePublished: false }),
    { schema: DRAFT, publish: false });
  eq('a source with nothing at all copies an empty schema, unpublished',
    planTemplateCopy({ kind: 'checklist' }), { schema: EMPTY, publish: false });
  // The publish rule is the SAME publishRefusal the editor and the server already share:
  // an item-less checklist can never be complete, so a copy of one may not auto-publish.
  eq('an item-less published source copies as a DRAFT — publishRefusal still rules',
    planTemplateCopy({ kind: 'checklist', publishedSchema: EMPTY, sourcePublished: true }),
    { schema: EMPTY, publish: false });
  ok(countSchemaItems(EMPTY) === 0 && NO_ITEMS_MESSAGE, 'the item-less rule is the existing shared one');

  eq('only a checklist may be copied to a customer',
    copyTemplateRefusal({ kind: 'inspection', clientId: 'cl_bay' }), COPY_SOURCE_MUST_BE_CHECKLIST);
  eq('a copy still needs the customer it is filed under',
    copyTemplateRefusal({ kind: 'checklist' }), CHECKLIST_NEEDS_CUSTOMER);
  eq('a checklist source with a customer proceeds', copyTemplateRefusal({ kind: 'checklist', clientId: 'cl_bay' }), null);
}

// ── SUMMARY: the narrow row, and its order ──────────────────────────────────
{
  const t = { id: 'it_a', name: 'Floor care', client_id: 'cl_bay', is_published: true, published_version_id: 'v1', updated_at: '2026-09-20T00:00:00.000Z', rating_scale: { type: 'passfail' }, slug: 's' };
  eq('the summary row is NARROW — seven fields, no schema and no scale',
    Object.keys(toTemplateSummaryRow(t, 2)).sort(),
    ['client_id', 'id', 'is_published', 'item_count', 'name', 'published_version_id', 'updated_at']);
  eq('…and carries the published version\'s item count', toTemplateSummaryRow(t, 2).item_count, 2);
  eq('an UNPUBLISHED template has a null item count, never 0',
    toTemplateSummaryRow({ ...t, is_published: false, published_version_id: null }, 5).item_count, null);
  eq('a published template whose version could not be read is null too, never 0',
    toTemplateSummaryRow(t, undefined).item_count, null);
  eq('a starter keeps its null customer', toTemplateSummaryRow({ ...t, client_id: null }, 2).client_id, null);

  const a = { id: 'it_a', updated_at: '2026-09-20T00:00:00.000Z' };
  const b = { id: 'it_b', updated_at: '2026-09-21T00:00:00.000Z' };
  const c = { id: 'it_c', updated_at: '2026-09-20T00:00:00.000Z' };
  eq('newest edited first, ties broken by id descending — the order the query asks for',
    [a, b, c].slice().sort(newestTemplateFirst).map((x) => x.id), ['it_b', 'it_c', 'it_a']);
}

// ── the three implementations read the rules from that ONE place ────────────
{
  ok(QCAPI && STORE && ROUTE, 'read the stub, the store and the route');

  // the stub
  ok(/from '\.\/inspections'/.test(QCAPI), 'the stub imports the shared rule module');
  for (const sym of ['templateMatchesFilters', 'createTemplateRefusal', 'planTemplateCopy', 'toTemplateSummaryRow', 'templateFilterRefusal', 'templateKindRefusal']) {
    ok(new RegExp(`\\b${sym}\\b`).test(QCAPI), `the stub uses ${sym} rather than restating it`);
  }
  ok(/export async function copyTemplate/.test(QCAPI), 'the stub adapter exposes copyTemplate');
  ok(/export async function templatesSummary/.test(QCAPI), 'the stub adapter exposes templatesSummary');
  ok(/client_id:/.test(QCAPI), 'the stub STORES client_id on a template row, as the backend does');

  // the server
  ok(/createTemplateRefusal/.test(ROUTE), 'the route refuses a create with the SAME rule the stub throws');
  ok(/templateFilterRefusal/.test(ROUTE), 'the route refuses the contradictory list filter with the same rule');
  ok(/templateKindRefusal/.test(ROUTE), 'the route refuses an unknown kind with the same rule');
  ok(/copyTemplateRefusal/.test(ROUTE) || /copyTemplateRefusal/.test(STORE), 'the copy refusal is the shared rule');
  ok(/planTemplateCopy/.test(STORE), 'the store decides a copy\'s version 1 with the shared rule');
  ok(/toTemplateSummaryRow/.test(STORE), 'the store shapes the summary row with the shared rule');
  ok(/client_id/.test(STORE), 'the store writes and reads client_id');

  // No restated literal of either message anywhere — that is how two halves drift.
  const restated = [QCAPI, STORE, ROUTE].filter((s) => s.includes(CHECKLIST_NEEDS_CUSTOMER));
  eq('the refusal text is never restated as a literal in the stub, the store or the route', restated.length, 0);
}

// ── the stub key IS the row shape's version ─────────────────────────────────
// lib/demoBootstrap writes a stub only when its key is ABSENT, so a row-shape change with
// an unchanged key leaves an already-seeded browser on the old rows for ever. Template rows
// now carry client_id, so the key moves — and the old one is retired, not left behind.
// Pinned as "at least v3, and every earlier key retired" rather than "exactly v3": this
// suite owns the reason the key moved to 3 (rows carry client_id AND item_count), not the
// right to block the next shape change — CS-546 moved it to 4 for the schema's naAllowed
// flags, and re-pinning a literal per suite is how two suites end up disagreeing about the
// live key. The invariant that matters is that NO earlier key is left un-retired.
{
  const version = Number((STUBKEYS.match(/QC_TEMPLATES_STUB_KEY\s*=\s*'cleanspace_qc_templates_stub_v(\d+)'/) || [])[1]);
  ok(version >= 3,
    `the template stub key lives in data/stubKeys.js and is at least v3, rows carrying client_id AND item_count (got v${version})`);
  const retired = STUBKEYS.slice(STUBKEYS.indexOf('RETIRED_STUB_KEYS'));
  const unretired = Array.from({ length: Math.max(0, version - 1) }, (_, i) => `cleanspace_qc_templates_stub_v${i + 1}`)
    .filter((k) => !retired.includes(`'${k}'`));
  ok(unretired.length === 0,
    `…and EVERY older key is listed in RETIRED_STUB_KEYS so no stale rows linger (${unretired.join(', ') || 'none left behind'})`);
  ok(!/=\s*'cleanspace_qc_templates_stub_v\d'/.test(QCAPI) && !/=\s*'cleanspace_qc_templates_stub_v\d'/.test(DEMOSTUBS),
    'ONE declaration: neither the stub adapter nor the demo seed restates the key as a literal');
  ok(/QC_TEMPLATES_STUB_KEY/.test(QCAPI) && /from '\.\.\/data\/stubKeys'/.test(QCAPI),
    'the stub adapter imports the key from data/stubKeys');
  ok(/QC_CHECKLISTS_STUB_KEY/.test(STUBKEYS), 'the checklist key still lives there too (one file, every stub key)');
}

// ── the demo seed files the two Coral Bay checklists, and leaves it_closeout a starter ──
{
  ok(/clientId|client_id/.test(DEMOSTUBS), 'the demo seed gives template rows a customer');
  const closeAt = DEMOSTUBS.indexOf('CLOSE_TEMPLATE_ID, CLOSE_VERSION_ID');
  const floorAt = DEMOSTUBS.indexOf('FLOOR_TEMPLATE_ID, FLOOR_VERSION_ID');
  const fullAt = DEMOSTUBS.indexOf('FULL_TEMPLATE_ID, FULL_VERSION_ID');
  ok(closeAt > 0 && floorAt > 0 && fullAt > 0, 'found the three checklist templates in the demo seed');
  const lineOf = (at) => DEMOSTUBS.slice(DEMOSTUBS.lastIndexOf('\n', at) + 1, DEMOSTUBS.indexOf('\n', at));
  ok(/coralBay|mtbaker/.test(lineOf(floorAt)), 'it_floorcare is filed under Coral Bay HOA');
  ok(/coralBay|mtbaker/.test(lineOf(fullAt)), 'it_fullclean is filed under Coral Bay HOA');
  ok(/null/.test(lineOf(closeAt)) && !/coralBay|mtbaker/.test(lineOf(closeAt)),
    'it_closeout has no customer — it is the STARTER');
}

console.log(`\nchecklist-location-rules: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
