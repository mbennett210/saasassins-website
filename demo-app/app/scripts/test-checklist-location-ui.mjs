// Step 5's UI half: the surfaces where "a checklist belongs to one customer" (R2) has to
// be VISIBLE and un-skippable.
//
//   · the editor asks whose checklist this is before it can be created;
//   · the Quality hub's Templates tab SHOWS the customer and can filter by it;
//   · "New checklist" offers only that customer's published checklists;
//   · a clean reads its own customer's checklists, not the company's.
//
// TWO LAYERS, because a .jsx cannot be imported by plain Node (Vite writes extensionless
// imports, and DEV_PLAYBOOK 3.9.5 forbids a suite registering a resolver hook to repair
// them — `installResolveShim` exists but is registered debt, not a pattern to grow):
//   A. the Customer FACET itself, as a real module. `lib/filters/templateFilters.js` takes
//      its customers from `ctx` and imports only the pure rule module, so it is node-native
//      and its matching is unit-tested here rather than eyeballed.
//   B. the four components, MECHANICALLY over their source (the shape
//      test-checklist-by-user-id.mjs uses): that each one asks the shared rule and passes
//      the customer, and that no half restates a message the rule owns. The behaviour
//      itself is driven in the demo browser, with screenshots, in the build's report.
//
// Failing-first by construction: pre-fix `lib/filters/templateFilters.js` does not exist,
// so the import throws.
//
//   node app/scripts/test-checklist-location-ui.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { templateFilterSpecs, TEMPLATE_STARTERS } from '../src/lib/filters/templateFilters.js';
import { CHECKLIST_NEEDS_CUSTOMER, INSPECTION_TAKES_NO_CUSTOMER } from '../src/lib/inspections.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (p) => { try { return readFileSync(path.join(APP, p), 'utf8'); } catch { return ''; } };
const EDITOR = read('src/components/InspectionTemplateEditor.jsx');
const HUB = read('src/pages/Inspections.jsx');
const FILL = read('src/components/ChecklistFill.jsx');
const CLEAN = read('src/components/CleanChecklist.jsx');
const SPEC = read('src/lib/filters/templateFilters.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── A. the Customer facet ────────────────────────────────────────────────────
const BAY = 'cl_seed_mtbaker';
const OLAS = 'cl_seed_evergreen';
const ROWS = [
  { id: 'it_floorcare', kind: 'checklist', client_id: BAY, name: 'Floor Care' },
  { id: 'it_fullclean', kind: 'checklist', client_id: BAY, name: 'Full Facility' },
  { id: 'it_lobby', kind: 'checklist', client_id: OLAS, name: 'Lobby' },
  { id: 'it_closeout', kind: 'checklist', client_id: null, name: 'Close-Out' },
  { id: 'it_janitorial', kind: 'inspection', client_id: null, name: 'Nightly QC' },
];
const CUSTOMERS = [{ id: BAY, name: 'Coral Bay HOA' }, { id: OLAS, name: 'Las Olas Dental' }];
const spec = templateFilterSpecs[0];
// The engine (lib/filters/applyFilters) skips a facet whose value is empty, so the spec is
// exercised the way FilterBar/useUrlFilters drive it: a value, then spec.match per row.
const shown = (value) => (value === '' || value == null ? ROWS : ROWS.filter((t) => spec.match(t, value, { customers: CUSTOMERS }))).map((t) => t.id);

{
  eq('ONE facet, and it is the Customer one', templateFilterSpecs.map((s) => [s.key, s.label, s.kind]), [['cust', 'Customer', 'single']]);
  eq('its "no constraint" value is the empty string, so the URL param is dropped when it is All', spec.defaultValue, '');

  const opts = spec.options({ customers: CUSTOMERS });
  eq('the options read All, Starters, then each customer by name',
    opts.map((o) => o.label), ['All customers', 'Starters (no customer)', 'Coral Bay HOA', 'Las Olas Dental']);
  eq('…and the first option is the reset row FilterSelect pins', opts[0].value, '');
  eq('…with the starters row on its own sentinel', opts[1].value, TEMPLATE_STARTERS);
  eq('no customers yet is still a usable menu', spec.options({}).map((o) => o.value), ['', TEMPLATE_STARTERS]);
  ok(!opts.some((o) => /account|location/i.test(o.label)),
    'VOCABULARY: the menu says Customer, never Account or Location');

  eq('All shows everything, inspection templates included', shown(''), ROWS.map((t) => t.id));
  eq('one customer shows that customer\'s checklists only', shown(BAY), ['it_floorcare', 'it_fullclean']);
  eq('…and a different customer a different set', shown(OLAS), ['it_lobby']);
  eq('Starters shows the checklists filed under nobody', shown(TEMPLATE_STARTERS), ['it_closeout']);
  ok(!shown(TEMPLATE_STARTERS).includes('it_janitorial'),
    'an INSPECTION template is not a starter — a starter is a checklist waiting to be copied');
  ok(!shown(BAY).includes('it_janitorial'),
    '…and it is not one customer\'s either: filtering by customer is a question about checklists');
  eq('a customer with no checklists is empty, never everything', shown('cl_nobody'), []);
  ok(/from '\.\.\/inspections\.js'/.test(SPEC),
    'the facet asks the SHARED rule (lib/inspections) rather than re-implementing the match');
  ok(!/store\/selectors/.test(SPEC),
    'the facet takes its customers from ctx, so it stays a pure module the suite can import');
}

// ── B1. the editor asks whose checklist this is ──────────────────────────────
{
  ok(EDITOR, 'read InspectionTemplateEditor.jsx');
  ok(/InspectionTemplateEditor\(\{[^)]*\bclientId\b/s.test(EDITOR), 'the editor takes a `clientId` prop');
  // Step 6 calls it with clientId + presetKind from its customer view: the prop API is frozen.
  for (const prop of ['open', 'onClose', 'templateId', 'onSaved', 'presetKind', 'clientId']) {
    ok(new RegExp(`\\b${prop}\\b`).test(EDITOR.slice(EDITOR.indexOf('export default function'), EDITOR.indexOf(') {', EDITOR.indexOf('export default function')))),
      `the prop API still carries \`${prop}\``);
  }
  ok(/createTemplate\(\{[^}]*clientId/s.test(EDITOR), 'it passes the customer to createTemplate');
  ok(/createTemplateRefusal/.test(EDITOR), 'the gate is the SHARED rule, not a hand-rolled check');
  ok(!EDITOR.includes(CHECKLIST_NEEDS_CUSTOMER) && !EDITOR.includes(INSPECTION_TAKES_NO_CUSTOMER),
    '…and no message is restated as a literal — the rule owns the words');
  ok(/FilterSelect/.test(EDITOR), 'the customer is chosen with the searchable FilterSelect');
  ok(/selectActiveClients/.test(EDITOR), '…over the customer roster');
  // Save must be UNREACHABLE without a customer, not merely warned about.
  const actions = EDITOR.slice(EDITOR.indexOf('modal-actions'));
  ok(/disabled=\{[^}]*customer/i.test(actions) || /disabled=\{[^}]*Block/.test(actions),
    'Save and Save & publish are disabled until the customer is chosen');
  ok(/className="form-help"|text-xs text-muted/.test(EDITOR), 'the reason is visible text, never a tooltip');
  ok(/kind === 'checklist'\s*\?\s*\(?\s*customerId[^:]*:\s*null/.test(EDITOR),
    'an INSPECTION never carries a customer, whatever the caller passed');
}

// ── B2. the Quality hub's Templates tab ──────────────────────────────────────
{
  ok(HUB, 'read Inspections.jsx');
  ok(/templateFilterSpecs/.test(HUB) && /useUrlFilters\(templateFilterSpecs\)/.test(HUB),
    'the Customer filter runs on the page\'s existing URL-filter engine, not a new one');
  ok(/applyFilters\(/.test(HUB), '…and its rows go through the shared applyFilters');
  ok(/<FilterBar[\s\S]{0,400}templateFilterSpecs/.test(HUB) || /specs=\{templateFilterSpecs\}/.test(HUB),
    'it renders through the shared FilterBar (a FilterSelect in the .filter-bar)');
  // The templates table gained a Customer column.
  const table = HUB.slice(HUB.lastIndexOf('<thead><tr><th>Name</th>'));
  ok(/<th>Customer<\/th>/.test(table), 'the Templates table has a Customer column');
  ok(/data-label="Customer"/.test(table), '…which stacks with its label on a phone (UI_RULES §24)');
  ok(/Starter/.test(HUB), 'a checklist filed under nobody reads "Starter"');
  ok(/All customers/.test(HUB), 'an inspection template reads "All customers" — it is not missing a customer, it has none');
  ok(/colSpan=\{6\}/.test(table), 'the empty / loading rows span the new column count');
  ok(/clientId=\{/.test(HUB), 'the hub passes a customer into the editor');
  // These two lines pinned the BOUNDARY while step 6 was still in flight: step 5 must not
  // touch the Checklists tab's organizer button or add a tab. Step 6 has since landed on
  // top, so the boundary reads the other way round — the pop-up organizer is deleted and
  // the Assignments tab mounts step 6's screen (UI_RULES §134). The Templates-tab
  // machinery asserted above is still step 5's, and the assignments screen is not in this
  // file at all.
  ok(!/ChecklistAssignmentsModal/.test(HUB), 'the pop-up organizer is gone (step 6 replaced it)');
  ok(/tab === 'assignments'/.test(HUB) && /components\/checklists\/ChecklistAssignments/.test(HUB),
    "the Assignments tab mounts step 6's screen, not another copy of the organizer");
  eq('the tab strip holds exactly the five tabs', (HUB.match(/tab === '(records|checklists|assignments|workorders|templates)' \? 'active'/g) || []).length, 5);
  ok(!/\bAccounts?\b/.test(table), 'VOCABULARY: the templates table never says Account');
}

// ── B3. "New checklist" asks for the customer first ──────────────────────────
{
  ok(FILL, 'read ChecklistFill.jsx');
  ok(/listTemplates\(\{[^}]*kind: 'checklist'[^}]*clientId/s.test(FILL),
    'the fill lists only the chosen customer\'s checklists');
  ok(/customerId/.test(FILL), '…from a customer the crew picks');
  ok(/is_published/.test(FILL), '…and only the published ones, as before');
  ok(/SearchSelect|FilterSelect/.test(FILL), 'the customer is chosen with a searchable picker');
  const gate = FILL.slice(FILL.indexOf('modal-actions'));
  ok(/disabled=\{[^}]*customerId|disabled=\{[^}]*!templateId/s.test(gate), 'Start stays disabled until there is something to start');
  ok(!/\bAccount\b/.test(FILL), 'VOCABULARY: the fill never says Account');
}

// ── B4. a clean reads its own customer's checklists ──────────────────────────
{
  ok(CLEAN, 'read CleanChecklist.jsx');
  ok(/listTemplates\(\{[^}]*kind: 'checklist'[^}]*clientId/s.test(CLEAN),
    'the clean names its customer in the template read — not the whole company list');
  ok(/client\?\.id|client\.id|job\?\.clientId|job\.clientId/.test(CLEAN),
    '…taken from the clean it is already showing');
  // A cover is served the COVERED cleaner's checklist, which is at the SAME customer, so a
  // customer-scoped read still names it. Pinned because it is the non-obvious half.
  ok(/cover/i.test(CLEAN), 'the cover rule is still in play on this surface');
}

// ── the all-ids cron read is deliberately NOT scoped ─────────────────────────
{
  const sched = read('src/components/OpsAlertScheduler.jsx');
  ok(/listTemplates\(\{ kind: 'checklist' \}\)/.test(sched),
    'the reminder walker still reads EVERY live checklist id — it judges every clean in the org, so a customer-scoped read would make other customers\' checklists look deleted (CS-353)');
}

console.log(`\nchecklist-location-ui: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
