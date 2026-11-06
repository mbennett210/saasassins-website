// Buttons with an edge have a fill (CS-577, UI_RULES §11, §125). The outline button and the add tile were
// transparent with a hairline edge; on a tinted ground (the page, a well, a tinted card, a board column) the edge
// read 1.03 to 1.18:1 and the button looked like bare text ("some buttons with no fill", Daniel, 2026-09-29, in a
// re-skin; the same in Clean Space). §11 wants every button in a row filled.
//
//   node app/scripts/test-button-fill.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };
const css = fs.readFileSync(path.join(APP, 'src', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// the top-level rules whose selector list is exactly one class (no :hover, no descendants)
const rules = [...css.matchAll(/(^|\n)\s*(\.[\w-]+)\s*\{([^}]*)\}/g)].map((m) => ({ sel: m[2], body: m[3] }));
const prop = (body, name) => new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

const fill = (sel) => prop(rules.find((r) => r.sel === sel)?.body || '', 'background');
ok(/var\(--card-bg\)/.test(fill('.btn-outline') || ''), `.btn-outline has the card fill (${fill('.btn-outline') || 'none'})`);
ok(/var\(--card-bg\)/.test(fill('.add-tile') || ''), `.add-tile has the card fill (${fill('.add-tile') || 'none'})`);

// and none comes back: no button-like class (.btn*, .add-tile) pairs a drawn edge with no fill
const edge = (body) => { const b = prop(body, 'border'); return !!b && !/^(none|0|transparent)\b/.test(b) && !/transparent/.test(b); };
const bare = rules.filter((r) => /^\.(btn|add-tile)/.test(r.sel) && edge(r.body) && /^(transparent|none)$/.test(prop(r.body, 'background') || ''));
ok(bare.length === 0, `no button class draws an edge around no fill${bare.length ? ` (${bare.map((r) => r.sel).join(', ')})` : ''}`);

if (failed) { console.error(`\n✗ test-button-fill: ${failed} check(s) failed`); process.exitCode = 1; } else console.log('\n✓ test-button-fill: every button with an edge has a fill');
