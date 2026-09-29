// keyboardInset — the visual-viewport math hooks/useKeyboardInset uses so the phone search
// screen's rows stay reachable above the on-screen keyboard (src/lib/keyboardInset.js, pure).
//
//   node scripts/test-keyboard-inset.mjs
import { measureKeyboard, KEYBOARD_MIN } from '../src/lib/keyboardInset.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// iPhone 812pt screen, no keyboard: nothing hidden.
ok('no keyboard → nothing hidden', eq(measureKeyboard(812, 812, 0), { top: 0, hidden: 0, raised: false }));
// Keyboard with its suggestion bar (~336pt): the band ends 336pt above the bottom.
ok('iOS keyboard → 336 hidden, raised', eq(measureKeyboard(812, 476, 0), { top: 0, hidden: 336, raised: true }));
// iOS panned the visual viewport down 100pt to reveal a field: the hidden part is what is
// left BELOW the visible band, not the raw height difference.
ok('panned viewport → top follows, hidden excludes the pan', eq(measureKeyboard(812, 376, 100), { top: 100, hidden: 336, raised: true }));
// A toolbar / URL bar settling is not a keyboard.
ok('small chrome change → not raised', measureKeyboard(812, 762, 0).raised === false && measureKeyboard(812, 762, 0).hidden === 50);
ok('threshold is inclusive', measureKeyboard(812, 812 - KEYBOARD_MIN, 0).raised === true && measureKeyboard(812, 812 - KEYBOARD_MIN + 1, 0).raised === false);
// Fractional visual-viewport values (pinch / zoomed layouts) round to whole px.
ok('rounds fractional values', eq(measureKeyboard(812, 475.6, 0.4), { top: 0, hidden: 336, raised: true }));
// Missing / junk inputs never produce NaN or a negative inset.
ok('missing visual viewport → nothing hidden', eq(measureKeyboard(812, undefined, undefined), { top: 0, hidden: 0, raised: false }));
ok('visual viewport taller than layout → clamps to 0', measureKeyboard(700, 812, 0).hidden === 0);
ok('junk innerHeight → safe zeros', eq(measureKeyboard(NaN, 400, 0), { top: 0, hidden: 0, raised: false }));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nkeyboard inset: ${pass}/${pass} passed`);
