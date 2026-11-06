// The avatar initials' colour on the brand ink (CS-578, UI_RULES §121). The initials read --avatar-text, which the
// brand step writes from the pack: colors.avatarText "accent" or "white", or, unset, the accent where it reads at
// AVATAR_ACCENT_FLOOR (7:1) or more on the ink, else white. They used the accent whatever it read: Clean Corner's
// teal on its navy was 5.88:1, passing AA and still muddy at 10px (Daniel, 2026-09-29).
//
//   node app/scripts/test-avatar-text.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

// dynamic imports, so a missing export is a failed check rather than a module link error
const colorsLib = await import('./brand-colors.mjs');
const brand = await import('./brand.mjs');
const { derivePalette, paletteBlock, contrast } = colorsLib;
const { avatarText, AVATAR_ACCENT_FLOOR, AVATAR_TEXT_TOKEN } = colorsLib;
const { loadBrand, brandIds, validateColors, PACK_FEATURES, activeBrandId } = brand;

// Fixed colours, not the packs on disk: an in-place re-skin rewrites brands/cleanspace itself (the lesson of CS-575).
// Clean Space's four, gold on black:
const GOLD = { primary: '#18181B', secondary: '#FFD45A', link: '#283CA1', neutral: '#64748B' };
// Clean Corner's colours as its re-skin confirmed them (navy, the teal lightened to pass the checks)
const CORNER = { primary: '#073B70', secondary: '#4FCFBD', link: '#107E72', neutral: '#6C727B' };

console.log('the rule');
ok(typeof avatarText === 'function' && AVATAR_ACCENT_FLOOR === 7, 'brand-colors.mjs decides the initials\' colour, with a 7:1 floor for the accent (WCAG AAA for small text)');
if (typeof avatarText === 'function') {
  const clean = avatarText(GOLD);
  const corner = avatarText(CORNER);
  ok(clean.mode === 'accent' && clean.auto && clean.ratio >= 12, `gold on black (Clean Space's four) keeps its gold initials: the accent reads ${clean.ratio.toFixed(2)}:1 on the black`);
  ok(corner.mode === 'white' && corner.auto && corner.accentRatio < 7 && corner.ratio >= 7,
    `a brand whose accent reads under 7:1 on its ink gets white initials (Clean Corner: teal ${corner.accentRatio.toFixed(2)}:1, white ${corner.ratio.toFixed(2)}:1)`);
  ok(avatarText({ ...CORNER, avatarText: 'accent' }).mode === 'accent' && avatarText({ ...GOLD, avatarText: 'white' }).mode === 'white',
    'colors.avatarText "accent" or "white" is the pack\'s own choice, kept whatever the contrast');
}

console.log('the pack');
ok(PACK_FEATURES.includes('avatar-text'), 'brand.mjs tells a pack-making tool (Forge) the pack may carry colors.avatarText');
const errs = (c) => validateColors({ ...GOLD, ...c });
ok(errs({ avatarText: 'white' }).length === 0 && errs({ avatarText: 'accent' }).length === 0 && errs({}).length === 0,
  'colors.avatarText may be "accent", "white", or left out');
ok(errs({ avatarText: 'gold' }).some((e) => /colors\.avatarText/.test(e)) && errs({ avatarText: 5 }).some((e) => /colors\.avatarText/.test(e)),
  'anything else is refused with the field named');

console.log('the theme');
const block = (colors) => paletteBlock({ id: 'x', colors }).text;
const decl = (text) => /--avatar-text:\s*([^;]+);/.exec(text)?.[1]?.trim();
ok(AVATAR_TEXT_TOKEN && decl(block(GOLD)) === AVATAR_TEXT_TOKEN.accent && decl(block(CORNER)) === AVATAR_TEXT_TOKEN.white,
  `the BRAND PALETTE block declares --avatar-text: the accent for gold on black, the text on the ink for Clean Corner (${decl(block(CORNER)) || 'none'})`);
const css = fs.readFileSync(path.join(APP, 'src', 'index.css'), 'utf8');
const avatarRule = /\n\.avatar\s*\{([^}]*)\}/.exec(css)?.[1] || '';
ok(/color:\s*var\(--avatar-text\)/.test(avatarRule) && !/--color-brand-secondary-500/.test(avatarRule),
  `.avatar paints its initials with --avatar-text, not the accent directly (${/color:\s*([^;]+);/.exec(avatarRule)?.[1] || 'no colour'})`);
ok(/--avatar-text:\s*var\(--color-brand-secondary-500\);/.test(fs.readFileSync(path.join(APP, 'src', 'theme.css'), 'utf8')),
  'theme.css gives --avatar-text a default (the accent), so a theme without the block still paints the initials');
// the committed client theme follows the active pack, as a re-skin commits it
const active = loadBrand(activeBrandId()).brand;
const client = fs.readFileSync(path.join(APP, 'src', 'theme-cleanspace.css'), 'utf8');
ok(typeof avatarText === 'function' && decl(client) === AVATAR_TEXT_TOKEN?.[avatarText(active.colors).mode],
  `the committed client theme's --avatar-text is the active pack's (${active.id}: ${decl(client) || 'none'})`);

console.log('every pack');
for (const id of brandIds()) {
  const { brand: b } = loadBrand(id);
  if (typeof avatarText !== 'function') { ok(false, `brands/${id}: no rule to read`); continue; }
  const r = avatarText(b.colors);
  const values = derivePalette(b.colors).values;
  ok(r.ratio >= 4.5 && (!r.auto || r.ratio >= AVATAR_ACCENT_FLOOR) && Math.abs(r.ratio - contrast(r.color, values['primary-500'])) < 0.01,
    `brands/${id}: its initials read ${r.ratio.toFixed(2)}:1 on its ink (${r.mode}${r.auto ? ', by contrast' : ', its choice'})`);
}

if (failed) { console.error(`\n✗ test-avatar-text: ${failed} check(s) failed`); process.exitCode = 1; } else console.log('\n✓ test-avatar-text: the avatar initials read on the ink, in every pack');
