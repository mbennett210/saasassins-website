// CS-955 — the New work order's Category options drew over each other (UI_RULES §184). Matt
// (2026-10-30), an email titled "Need to fix the options" with a picture of the pop-up: its seven
// Category answers sat in one §7 strip, an inline grid of equal columns in the pop-up's 430px, and the
// app's global `* { min-width: 0 }` let each column shrink below its word, so the words overlapped.
// Seven answers are quick-pick chips that wrap (§124), never a one-row strip; a strip keeps to the few
// answers that fit (Type, Priority). Each field of the form ends on the form's own gap.
//
// Offline. Run: node scripts/test-wo-category-chips.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const wo = await import('../src/lib/workOrders.js').catch(() => ({}));
const modal = read('src/components/WorkOrderModal.jsx');
const css = read('src/index.css');
const rule = (sel) => { const i = css.indexOf(`${sel} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };

// The Category field: from its label to the next field.
const catAt = modal.indexOf('id="wo-category-label"');
const category = catAt < 0 ? '' : modal.slice(catAt, modal.indexOf('<label className="form-label">Priority', catAt));

ok('🔴 Category is wrapping chips (.chip-picker of .chip), never a one-row strip',
  /className="chip-picker wo-category-picks"/.test(category) && /className=\{`chip\$\{/.test(category) && !/tab-container-line|tab-btn/.test(category));
ok('…a group named by its label, each chip saying whether it is the one picked',
  /role="group" aria-labelledby="wo-category-label"/.test(category) && (category.match(/aria-pressed=\{/g) || []).length === 2);
ok('…Uncategorized first, then every category, each with its hint', /UNCATEGORIZED_LABEL/.test(category) && /WO_CATEGORIES\.map\(/.test(category) && /title=\{WO_CATEGORY_META\[c\]\.hint\}/.test(category));
ok('the chips wrap onto as many rows as they need', /flex-wrap: wrap/.test(rule('.chip-picker')));

const n = (a) => (Array.isArray(a) ? a.length : 0);
ok(`a strip keeps to the few answers that fit: Type ${n(wo.RAISABLE_WO_TYPES)}, Priority ${n(wo.WO_PRIORITIES)} (four at most)`,
  n(wo.RAISABLE_WO_TYPES) > 0 && n(wo.RAISABLE_WO_TYPES) <= 4 && n(wo.WO_PRIORITIES) > 0 && n(wo.WO_PRIORITIES) <= 4);
ok(`…while Category has ${n(wo.WO_CATEGORIES) + 1} answers, past what a strip can hold`, n(wo.WO_CATEGORIES) + 1 > 4);
ok('Type and Priority stay §7 strips', (modal.match(/className="tab-container-line" role="group"/g) || []).length === 2);
ok('every field of the form ends on the form\'s own gap (a strip drops a tab bar\'s 20px), in every form',
  /className="wo-form"/.test(modal) && /margin-bottom: 0/.test(rule('.form-group > .tab-container-line')) && !css.includes('.wo-form .tab-container-line'));
// CS-956: the same squeeze drew the words of Supplies' status tabs, HR's tabs and a customer's Activity
// tabs over each other at a laptop's or an iPad's width. Every strip's column is floored at its words,
// and a row out of room scrolls in place (the page never does).
const stripAt = css.search(/^\.tab-container-line \{/m);   // the kit's own rule, not a page's override
const strip = stripAt < 0 ? '' : css.slice(stripAt, css.indexOf('}', stripAt));
ok('🔴 a strip\'s column is never narrower than its words (CS-956)', /grid-auto-columns: minmax\(max-content, 1fr\)/.test(strip) && !/grid-auto-columns: 1fr;/.test(strip));
ok('…and a row out of room scrolls in place, inside its own width', /max-width: 100%/.test(strip) && /overflow-x: auto/.test(strip));
// The phone's two-column grid of Supplies' status tabs (no rail to scroll): at the floor (320px) "Pending
// approval 2" needed 141px of its 139 and its words ran past both edges. A grid tab keeps 8px a side and
// wraps its words when even that is too little (a count of three figures).
const phoneTab = rule('.supply-status-tabs .tab-btn');
ok('…and a phone\'s grid of status tabs keeps each tab\'s words inside it at 320px',
  /padding-inline: var\(--space-2\)/.test(phoneTab) && /white-space: normal/.test(phoneTab));

console.log(`\ntest-wo-category-chips: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
