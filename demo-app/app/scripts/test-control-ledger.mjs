// test-control-ledger — every clickable control is a kit control or written down (UI_RULES §128).
//
// control-families.mjs groups every <button>, role="button" element and `.btn` in app/src into families. A family
// that wears a kit class (.btn, .btn-icon, .chip, .menu-option …) is the kit's; every other family must be in
// app/design-system/controls.json with a role (row, card, nav, variant, exception) and the reason. So a new bespoke
// control fails CI until it adopts the kit or is classified where review sees it, and an entry whose control is gone
// fails as stale. On 2026-09-25 the step ④ sweep took 820 controls in 138 families to 813 in 71; the ledger holds 51.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlFamilies, KIT } from './control-families.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const LEDGER = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../design-system/controls.json', import.meta.url)), 'utf8'));

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

/** The ledger's verdict on a family map: { unclassified, stale, badRole, undocumentedKit, reclassifiedKit }. */
export function judge(fams, ledger) {
  const kit = new Set(KIT.map((k) => '.' + k));
  const roles = new Set(Object.keys(ledger.roles || {}));
  const entries = ledger.families || {};
  return {
    unclassified: [...fams.keys()].filter((f) => !kit.has(f) && !(f in entries)),
    stale: Object.keys(entries).filter((f) => !fams.has(f)),
    badRole: Object.entries(entries).filter(([, e]) => !roles.has(e.role) || !(e.why || '').trim()).map(([f]) => f),
    undocumentedKit: [...kit].filter((k) => !(k in (ledger.kit || {}))),
    reclassifiedKit: Object.keys(entries).filter((f) => kit.has(f)),
  };
}

// 1. the tree against the committed ledger
const fams = controlFamilies(SRC);
const v = judge(fams, LEDGER);
const where = (f) => fams.get(f)?.at[0] || '';
console.log('the tree');
ok(v.unclassified.length === 0, `every control family wears a kit class or is classified in controls.json${v.unclassified.length ? `: ${v.unclassified.map((f) => `${f} (${where(f)})`).join(', ')}` : ''}`);
ok(v.stale.length === 0, `no ledger entry is stale${v.stale.length ? `: ${v.stale.join(', ')}` : ''}`);
ok(v.badRole.length === 0, `every entry has a known role and a reason${v.badRole.length ? `: ${v.badRole.join(', ')}` : ''}`);
ok(v.undocumentedKit.length === 0, `every kit class is documented in controls.json → kit${v.undocumentedKit.length ? `: ${v.undocumentedKit.join(', ')}` : ''}`);
ok(v.reclassifiedKit.length === 0, `no kit family is reclassified as a one-off${v.reclassifiedKit.length ? `: ${v.reclassifiedKit.join(', ')}` : ''}`);

// 2. the detections fire (a throwaway tree)
console.log('the detections');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  try {
    fs.writeFileSync(path.join(dir, 'A.jsx'), [
      'export default () => (<div>',
      '  <button className="btn btn-primary">Save</button>',
      '  <button className="fancy-pill on">New</button>',
      '  {/* <button className="ghost-in-a-comment">x</button> */}',
      '  // <button className="also-a-comment">y</button>',
      '</div>);',
      '',
    ].join('\n'));
    const f2 = controlFamilies(dir);
    ok(f2.has('.btn') && f2.has('.fancy-pill'), 'the scan finds a kit button and a bespoke one');
    ok(!f2.has('.ghost-in-a-comment') && !f2.has('.also-a-comment'), 'a <button> inside a comment is not a control');
    const j = judge(f2, { roles: LEDGER.roles, kit: LEDGER.kit, families: { '.gone-control': { role: 'row', why: 'x' }, '.btn': { role: 'row', why: 'x' } } });
    ok(j.unclassified.includes('.fancy-pill'), 'a bespoke family nobody classified fails');
    ok(j.stale.includes('.gone-control'), 'an entry whose control is gone fails as stale');
    ok(j.reclassifiedKit.includes('.btn'), 'a kit family cannot be reclassified as a one-off');
    const j2 = judge(f2, { roles: LEDGER.roles, kit: LEDGER.kit, families: { '.fancy-pill': { role: 'gadget', why: '' } } });
    ok(j2.badRole.includes('.fancy-pill'), 'an entry with an unknown role or no reason fails');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const count = (role) => Object.values(LEDGER.families).filter((e) => e.role === role).length;
const kitFams = [...fams.keys()].filter((f) => KIT.includes(f.slice(1)));
const kitCount = kitFams.reduce((s, f) => s + fams.get(f).n, 0);
const total = [...fams.values()].reduce((s, F) => s + F.n, 0);
if (failed) { console.error(`\n✗ test-control-ledger: ${failed} check(s) failed. Adopt a kit class, or classify the family in app/design-system/controls.json (UI_RULES §128).`); process.exit(1); }
console.log(`\n✓ test-control-ledger: ${total} controls in ${fams.size} families; ${kitFams.length} kit families hold ${kitCount}; ${Object.keys(LEDGER.families).length} are classified (${count('row')} rows, ${count('card')} cards, ${count('nav')} nav, ${count('variant')} variants, ${count('exception')} exceptions)`);
