// Esc closes only the newest layer, and a field that handles Esc keeps it (UI_RULES §181,
// task #265 from Clean Corner's queue).
//
// The bug: with HR's warning form open, Esc on its Employee dropdown closed the whole form and
// everything typed into it. The pop-up (Modal) and the dropdown (PopMenu, through useDismissTap)
// each had a keydown listener on the window; the pop-up's was added first, so it ran first. A
// phone sheet listened on the document and closed together with the pop-up under it, and a
// picker's search box, an inline name editor and Add contact's "New company name" closed their
// own thing and then the pop-up too.
//
//   A. THE STACK (lib/escapeLayers.js, run here under node): Esc closes only the newest layer;
//      a layer that leaves the stack hands Esc back to the one under it; a key a field took
//      first (`preventDefault`) closes nothing; other keys close nothing; the one listener goes
//      when the last layer does.
//   B. EVERY LAYER IS ON IT: Modal, MobileSheet, useDismissTap (so PopMenu and every picker),
//      the messages dock and the messaging row menu call useEscapeLayer, and no file but the
//      stack adds a keydown listener that closes on Esc (MasterSearch excepted, below).
//   C. EVERY FIELD THAT HANDLES ESC TAKES IT: each `key === 'Escape'` branch in a component
//      calls preventDefault, so the layer around it stays.
//
// Offline. Run: node scripts/test-escape-layers.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(APP, 'src');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n');

// ── A. The stack ────────────────────────────────────────────────────────────────────────────
globalThis.window = new EventTarget();
// A field's own handler runs before the window's bubble listener in the browser; here it is a
// listener added to the window BEFORE any layer, so it runs first too.
let fieldTakes = false;
window.addEventListener('keydown', (e) => { if (fieldTakes && e.key === 'Escape') e.preventDefault(); });
const press = (key = 'Escape') => {
  const e = new Event('keydown', { cancelable: true });
  Object.defineProperty(e, 'key', { value: key });
  window.dispatchEvent(e);
  return e;
};

const { addEscapeLayer, escapeLayerCount } = await import(pathToFileURL(path.join(SRC, 'lib/escapeLayers.js')).href);
const closed = [];
const leavePopup = addEscapeLayer(() => closed.push('popup'));
const leaveDropdown = addEscapeLayer(() => closed.push('dropdown'));
ok('A1 two layers are open', escapeLayerCount() === 2);

press('Enter');
ok('A2 a key other than Esc closes nothing', closed.length === 0);

fieldTakes = true;
const taken = press();
ok('A3 Esc a field took first closes no layer', closed.length === 0 && taken.defaultPrevented);
fieldTakes = false;

const spent = press();
ok('A4 Esc closes the newest layer (the dropdown) and not the pop-up under it', closed.join() === 'dropdown');
ok('A5 the Esc a layer took is marked spent', spent.defaultPrevented);
leaveDropdown();
ok('A6 the dropdown left the stack', escapeLayerCount() === 1);

press();
ok('A7 the next Esc closes the pop-up', closed.join() === 'dropdown,popup');

// A layer that leaves out of order (a pop-up closed from outside while a sheet over it stays).
const leaveSheet = addEscapeLayer(() => closed.push('sheet'));
leavePopup();
closed.length = 0;
press();
ok('A8 a layer that left out of order hands Esc to the one still open', closed.join() === 'sheet');
leaveSheet();
leaveSheet(); // leaving twice is harmless
ok('A9 the stack is empty', escapeLayerCount() === 0);
closed.length = 0;
press();
ok('A10 with nothing open Esc closes nothing', closed.length === 0);

// ── B. Every layer is on the stack ──────────────────────────────────────────────────────────
const LAYERS = {
  'src/components/Modal.jsx': /useEscapeLayer\(\s*open\s*,\s*onClose\s*\)/,
  'src/components/MobileSheet.jsx': /useEscapeLayer\(\s*open\s*,\s*onClose\s*\)/,
  'src/hooks/useDismissTap.js': /useEscapeLayer\(\s*open\s*&&\s*escape\s*,/,
  'src/components/MessagesDock.jsx': /useEscapeLayer\(\s*open\s*,/,
  'src/components/ConversationThreadList.jsx': /useEscapeLayer\(\s*open\s*,/,
};
for (const [rel, re] of Object.entries(LAYERS)) ok(`B1 ${rel} joins the Escape stack`, re.test(read(rel)));
ok('B2 PopMenu dismisses through useDismissTap (so its Esc is on the stack)', /useDismissTap\(\{[^}]*onDismiss:\s*onClose/.test(read('src/components/PopMenu.jsx')));
ok('B3 Modal keeps no stack of its own', !/__modalStack/.test(read('src/components/Modal.jsx')));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : (/\.(jsx?|mjs)$/.test(n) ? [p] : []);
});
const files = walk(SRC).map((p) => path.relative(APP, p).split(path.sep).join('/'));
// MasterSearch's phone screen is a full screen nothing opens over (its hotkey refuses to open
// under a pop-up or sheet), and its field stops the key itself, so its listener closes nothing
// else. Every other Esc goes through the stack.
const OWN_LISTENER_OK = new Set(['src/lib/escapeLayers.js', 'src/components/MasterSearch.jsx']);
const ESC_LITERAL = /['"]Escape['"]|['"]Esc['"]/;
const KEYDOWN_LISTENER = /addEventListener\(\s*['"]keydown['"]/;
for (const rel of files) {
  if (OWN_LISTENER_OK.has(rel)) continue;
  const s = read(rel);
  ok(`B4 ${rel} closes on Esc through useEscapeLayer, not its own keydown listener`, !(KEYDOWN_LISTENER.test(s) && ESC_LITERAL.test(s)));
}

// ── C. Every field that handles Esc takes it ────────────────────────────────────────────────
const ESC_BRANCH = /key\s*===?\s*['"](?:Escape|Esc)['"]/g;
let branches = 0;
for (const rel of files) {
  if (OWN_LISTENER_OK.has(rel)) continue;
  const s = read(rel);
  for (const m of s.matchAll(ESC_BRANCH)) {
    branches += 1;
    const line = s.slice(0, m.index).split('\n').length;
    // The branch's own first statements (up to its first `}` or the next 200 characters).
    const body = s.slice(m.index, m.index + 200);
    const end = body.indexOf('}');
    const head = end === -1 ? body : body.slice(0, end);
    ok(`C1 ${rel}:${line} — an Esc branch calls preventDefault so the layer around it stays`, /preventDefault\(\)/.test(head));
  }
}
ok('C2 the field branches were found (the scan reads the code)', branches >= 8);

console.log(`test-escape-layers: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
