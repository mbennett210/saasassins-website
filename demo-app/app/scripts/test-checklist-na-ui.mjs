// CS-546 — the surfaces where "N/A" has to be VISIBLE, opt-in, and impossible to widen.
//
// THE DEFECT. `InspectionTemplateEditor` has written an `naAllowed` flag on every checklist
// item since the templates shipped, and `ChecklistFill` rendered no N/A control at all: the
// flag was authored and never read. With the clock-out block (plan step 4a) an item that
// does not apply tonight — the exterior bins on a night with no collection — had to be
// ticked anyway, or the cleaner could not clock out. Worse, the editor defaulted EVERY new
// item to `naAllowed: true`, so the moment the control appeared the exception would have
// been on everywhere by default, against the client's rule that the whole checklist is done
// before clock-out with no way around it on the cleaner's side.
//
// THE RULE, in three places: the OFFICE opts in per item (the editor), the control shows
// only where they did (the fill), and the count is measured against the published schema
// (`lib/checklistCount`, proven in test-checklist-count.mjs and, through the real handlers,
// in test-checklist-submit-count-route.mjs).
//
// TWO LAYERS, because a .jsx cannot be imported by plain Node (Vite writes extensionless
// imports, and DEV_PLAYBOOK 3.9.5 forbids a suite registering a resolver hook):
//   A. the RULE itself, as a real module — `defaultNaAllowed` / `itemAllowsNa` are run, not
//      eyeballed, so "a new checklist item does not allow N/A" is executable truth;
//   B. the three components + the demo seed MECHANICALLY over their source (the shape
//      test-checklist-by-user-id.mjs and test-checklist-location-ui.mjs use). The behaviour
//      itself is driven in the demo browser, at 375x812 and 1280x800, in the build's report.
//
// Failing-first by construction: pre-fix `defaultNaAllowed` / `itemAllowsNa` are not
// exported (section A goes red without throwing, they are read off the namespace) and
// `ChecklistFill` contains no N/A control at all.
//
//   node app/scripts/test-checklist-na-ui.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as checklistCount from '../src/lib/checklistCount.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (p) => { try { return readFileSync(path.join(APP, p), 'utf8'); } catch { return ''; } };
// Comments quote the old code and describe the rule on purpose; only real code counts.
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const FILL = code('src/components/ChecklistFill.jsx');
const EDITOR = code('src/components/InspectionTemplateEditor.jsx');
const EDITOR_TEXT = read('src/components/InspectionTemplateEditor.jsx');
const INSP_FILL = code('src/components/InspectionFill.jsx');
const DEMO = code('src/data/demoStubs.js');
const KEYS = read('src/data/stubKeys.js');
const CSS = read('src/index.css');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── A. the rule, run ─────────────────────────────────────────────────────────
const { defaultNaAllowed, itemAllowsNa } = checklistCount;
ok('the shared rule exports defaultNaAllowed', typeof defaultNaAllowed === 'function');
ok('the shared rule exports itemAllowsNa', typeof itemAllowsNa === 'function');
if (typeof defaultNaAllowed === 'function') {
  eq('a NEW CHECKLIST item does not allow N/A — the office opts in per item', defaultNaAllowed('checklist'), false);
  eq('a NEW INSPECTION item keeps the long-standing default', defaultNaAllowed('inspection'), true);
}
if (typeof itemAllowsNa === 'function') {
  eq('an item at the checklist default may not be marked N/A',
    itemAllowsNa({ id: 'i1', naAllowed: defaultNaAllowed('checklist') }), false);
  eq('an item the office flagged may', itemAllowsNa({ id: 'i1', naAllowed: true }), true);
}

// ── B1. the fill: the control exists, only where allowed, exclusive with the tick ──
ok('the fill reads the shared rule', /itemAllowsNa/.test(FILL));
ok('…and renders the N/A control ONLY for an item that allows it',
  /itemAllowsNa\(it\)\s*&&/.test(FILL));
ok('…as a kit control, not a bespoke one (UI_RULES §124: .chip is the toggle pill)',
  /className=\{`chip[^`]*chk-item-na/.test(FILL));
ok('…that says what it is to a screen reader', /aria-pressed=\{!!c\.na\}/.test(FILL));
// Mutually exclusive BOTH ways: an item is done, or it does not apply, never both. The
// count would forgive a double mark (it counts the key once) — the SCREEN must not show one.
ok('ticking an item clears its N/A', /checked: e\.target\.checked, na: false/.test(FILL));
ok('marking an item N/A clears its tick', /na: !c\.na, checked: false/.test(FILL));
ok('the submitted item carries the mark', /na: !!c\.na/.test(FILL));
ok('…alongside the tick, so the record says which of the two it was', /checked: !!c\.checked/.test(FILL));

// The screen and the server agree by construction: the progress the cleaner reads is the
// SAME function the route stores (`lib/checklistCount`), never a second count.
ok('the progress comes from the shared counter', /countChecklistSubmission\(/.test(FILL));
// CS-547 added the photos the device holds as the counter's third input; the list and the
// schema it is measured against are unchanged, so what this asserts is unchanged too.
ok('…over the very list it will post (ONE memoized list, not two walks of the schema)',
  /const items = useMemo\(/.test(FILL) && /countChecklistSubmission\(schema, items, \{ photoKeys \}\)/.test(FILL));
ok('the fill shows the cleaner an n/m', /insp-fill-progress/.test(FILL));
// II.8 — a partial submission is never REFUSED. The clock-out block is the enforcement
// point (`api/_lib/time/checklistGate.js`); a fill that refused to submit would also throw
// away the work of a fill buffered across a republish, which the server deliberately stores
// partial. So the Submit button is gated on the in-flight request and on nothing about how
// much of the checklist is done.
//
// CS-547 added ONE further gate, and it is not a completeness gate: a checklist whose
// office marked an item photo-required, opened with NO location, has nowhere to put the
// photos (media is site-scoped), so the screen would show items ticked that the server
// must count as not done. `needsLocationForPhotos` holds Submit and says why, rather than
// letting the two disagree. Asserted by NAME so a completeness gate can never slip in
// behind it.
const SUBMIT_GATE = /disabled=\{busy \|\| needsLocationForPhotos\}\s+onClick=\{submit\}/;
// CS-193: the button's word is the catalog's (`checklist.fill.submit`), rendered in the
// cleaner's language.
ok('Submit is never gated on completeness — the clock-out block is the boundary (II.8)',
  /\{t\('checklist\.fill\.submit'\)\}/.test(FILL) && SUBMIT_GATE.test(FILL));
ok('…and the one gate it does carry is "nowhere to put the required photo", not progress',
  /const needsLocationForPhotos = useMemo\(/.test(FILL)
  && /!siteId/.test(FILL)
  && !/disabled=\{[^}]*progress\./.test(FILL));

// ── B2. the editor: the office opts in, and is told what it is opting into ──
ok('the editor defaults a new item through the shared rule', /defaultNaAllowed\(/.test(EDITOR));
ok('…and no longer hard-codes the flag', !/naAllowed:\s*(true|false)\b/.test(EDITOR));
ok('a new item is minted by ONE factory, so "Add item" and a new area agree',
  /const blankItem = \(kind\)/.test(EDITOR) && (EDITOR.match(/blankItem\(/g) || []).length >= 2);
ok('switching the type re-defaults the flags that were never opted into',
  /retypeNaDefaults/.test(EDITOR));
// …and "never opted into" is a FLAG the checkbox sets, not "its value equals the old
// default": by value alone, Checklist → Inspection → Checklist threw the office's own
// choice away (driven in the browser, 2026-09-28). The flag is editor state only — the
// saved schema is an explicit field list, so it cannot leak into a published template.
ok('…and an item the office SET is never re-defaulted, however the type is switched',
  /naTouched: true/.test(EDITOR) && /i\.naTouched \? i :/.test(EDITOR));
ok('…while naTouched never reaches the saved schema',
  /items: \(a\.items \|\| \[\]\)\.map\(\(i\) => \(\{ id: i\.id, label: i\.label, photoRequired: !!i\.photoRequired, naAllowed: !!i\.naAllowed, \.\.\.withI18n\(i\) \}\)\)/.test(EDITOR)
    && !/naTouched: !!/.test(EDITOR));
ok('the checklist flag carries a plain explanation, as visible text',
  /counts as done/.test(EDITOR_TEXT) && /form-help/.test(EDITOR));
// A tooltip never appears on a phone (the publish-refusal precedent), so the explanation
// must not be ONLY a title attribute.
ok('…not only a title attribute', /form-help[^]{0,400}counts as done/.test(EDITOR_TEXT.replace(/\n/g, '\n')));

// The SCORED inspection is a different surface with a different permission and no
// clock-out block: its N/A is a rating. Since the New Inspection form as drawn (2026-10-09)
// it asks the same shared rule which items may be N/A, and lib/inspections posts the mark as
// the rating 'na' (inspectionFillItems), never as a checklist mark.
ok('the inspection fill still offers its own N/A rating, through the shared rule', /itemAllowsNa\(item\)/.test(INSP_FILL));
ok('…and still spells it as a rating, not a checklist mark', /rating = 'na'/.test(code('src/lib/inspections.js')));

// ── B3. the phone: the control is a real tap target ─────────────────────────
// Cleaners work this screen on a phone. `.chip` is 32px, under the touch floor, so the N/A
// control takes the kit's --control-height-lg on a phone, the same floor `.chip-remove` and
// `.btn-icon` take (UI_RULES §123).
ok('the N/A control has its own class to size', /\.chk-item-na\b/.test(CSS));
// Inside a phone media query, with no other @media opening in between, so the rule cannot
// drift out of the block it is supposed to live in.
ok('…and reaches the 44px floor on a phone',
  /@media \(max-width: 640px\)\s*\{(?:(?!@media)[^])*?\.chk-item-na\s*\{[^}]*--control-height-lg/.test(CSS));

// ── B4. the demo shows it ───────────────────────────────────────────────────
// One item of one demo checklist carries the flag, so the control is reachable in the demo
// at all — and exactly one, so the demo also shows what an item WITHOUT it looks like.
const naFlags = (DEMO.match(/naAllowed:\s*true/g) || []).length;
eq('exactly one demo checklist item allows N/A', naFlags, 1);
ok('…on the Floor Care checklist the demo assigns to a cleaner', /f_spot[^\n]*naAllowed: true/.test(DEMO));
// demoBootstrap writes a stub only when its key is ABSENT, so a schema change with an
// unchanged key leaves an already-seeded browser on the old rows for ever — it would never
// see the control (the CS-403 lesson, data/stubKeys.js).
const key = (KEYS.match(/QC_TEMPLATES_STUB_KEY = '([^']+)'/) || [])[1];
// (v5 since CS-850, 2026-10-15: the demo's checklists carry their Spanish and Creole lines.)
ok('the templates stub key moved off v3', !!key && key !== 'cleanspace_qc_templates_stub_v3' && /^cleanspace_qc_templates_stub_v\d+$/.test(key), String(key));
ok('…and v3 is retired so the stale rows are cleared', /'cleanspace_qc_templates_stub_v3'/.test(KEYS));

if (fails.length) { console.error('\nchecklist-na-ui FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-na-ui: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
