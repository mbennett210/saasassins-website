// Every pop-up steps the phone's menu bar out of its way (UI_RULES §105).
//
// WHY. Matt, 2026-11-02 (6:50 AM PT), with a picture of the work order panel on his phone: "This
// stays in the way when trying to change status." The panel was drawn inside the page (`.main`, a
// stacking context held below the floating menu bar), so on a phone the bar sat over its last
// buttons: a finger on In progress, Escalate or Mark resolved opened a page behind the bar
// instead (measured at his size, 420×912). §105 had said since 2026-09-15 that a phone pop-up sits
// above the bar, but nothing held a pop-up built another way to it: the Payroll panel (2026-09-14)
// and the work order panel (2026-09-19) were both drawn under it, and the phone sweep never opened
// either.
//
// The fix: on a phone the menu bar slides fully away while any pop-up is on the page and comes
// back once it has gone. ONE list names every pop-up: the POP-UP LIST selector in index.css (the
// floating nav's section). Both panels draw through the one SidePanel, which slides in and out.
//
//   §1  the list: one rule, inside the phone's media block, slides .cs-fnav-pill and
//       .cs-fnav-menu-btn past the screen's foot (their own height plus the home bar's room) and
//       hides them (visibility, pointer events) under body:has(:is(<the list>)); both carry a
//       translate and visibility transition, which reduced motion drops; the condensed puck can't
//       be pressed through it
//   §2  every fixed layer is accounted for: each `position: fixed` rule in app/src's CSS and each
//       inline fixed position in its JS is on the list or in NOT_POPUPS below, which says why it
//       is not a pop-up. A new one fails until it is on one or the other, and nothing on either
//       is stale (each still exists, and each listed pop-up is still drawn by a component)
//   §3  the shared side panel: SidePanel draws `.side-panel-layer` (on the list) at the page's top
//       level (a portal to <body>, under the shared Modal), slides in and out on transform, turns
//       round mid-way (two classes, one transition), leaves the page when its
//       slide out ends, closes on Esc (the escape stack) and a tap on its dim; the work order and
//       Payroll panels draw through it and nothing else; their pages keep them mounted, so the
//       slide out can run; each keeps the iPhone's status bar and home bar clear
//   §4  the detector on fixtures: a new fixed overlay is caught in a media block and a selector
//       list, one on the list passes, a commented-out one is not a rule
//   §5  the browser half: lint:responsive's phone pass opens both panels at phone sizes and fails
//       a button under the bar, a bar left showing over a pop-up, and a bar hidden with no pop-up
//       open; CI can't run a browser, so this holds that the pass exists
//
// REGRESSION (THE LAW II.3): on 8608fa5e there is no POP-UP LIST rule, .wo-drawer-backdrop,
// .wo-drawer, .pay-scrim and .pay-drawer are fixed layers on neither list, SidePanel does not exist
// and the sweep has no pop-up pass, so §1, §2, §3 and §5 fail there.
//
//   node app/scripts/test-popup-layers.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(APP, 'src');
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// The fixed layers that are NOT pop-ups, each with why. Keyed by the subject of the CSS selector
// that fixes it (its last compound). Everything else that is fixed must be on the POP-UP LIST.
const NOT_POPUPS = {
  'body::before': 'the page background',
  '.sidebar': 'the desktop sidebar; off the screen on a phone, where nothing opens it (the floating menu is the phone\'s)',
  '.sidebar-overlay': 'the sidebar\'s dim; nothing on a phone opens the sidebar (AppLayout only ever closes it there)',
  '.launcher-panel': 'the desktop sidebar\'s Launcher, opened from the sidebar\'s rows, which a phone never shows',
  '.topbar': 'the page\'s own top bar',
  '.msearch-trigger': 'the phone\'s search button; its screen, .msearch-screen, is on the list',
  '.select-menu.is-float': 'a desktop dropdown hung from its field; on a phone the same menu is a MobileSheet (.sheet-backdrop, on the list)',
  '.toast-stack': 'short notices, drawn through a portal over the bar; they cover nothing to press for long',
  '.boot-screen': 'the start-up screen, drawn before the app and its menu bar exist (store/index.jsx)',
  '.bell-floater': 'the bell, in the page\'s top corner',
  '.thread-row-menu-popover': 'a message row\'s small menu, drawn through a portal over the bar and hung from its row',
  '.key-status-menu': 'a key\'s status menu on a desktop; on a phone the same menu is a MobileSheet (on the list)',
  '.mgrh-fab': 'the manager Home\'s floating button, placed above the menu bar',
  '.cs-msg-dock': 'the desktop Messages dock; not drawn on a phone',
  '.hub-tabs': 'the customer hub\'s own bottom tabs; the hub has no office menu bar',
  '.hub-fab': 'the customer hub\'s New request button, above its own tabs',
};
// Inline fixed positions in JS (a style object, a style write or a cssText), per file, with why.
const NOT_POPUPS_INLINE = {
  'src/App.jsx': { count: 1, why: 'the sign-in check screen, drawn before the app and its menu bar exist' },
};

// ── the detector ──────────────────────────────────────────────────────────────────────────────

/** Every style rule in a stylesheet: its selector, its declarations, the at-rules it sits in, its line. */
function cssRules(source) {
  // Comments become spaces of the same shape, so a commented-out rule is not a rule and the line
  // numbers still match the file.
  const text = source.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  const rules = [];
  const at = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(start, i);
      const trimmed = prelude.trim();
      if (trimmed.startsWith('@')) { at.push(trimmed); start = i + 1; continue; }
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
      const lead = prelude.length - prelude.trimStart().length;
      rules.push({ selector: trimmed.replace(/\s+/g, ' '), body: text.slice(i + 1, j - 1), at: [...at], line: lineAt(start + lead) });
      i = j - 1;
      start = j;
    } else if (ch === '}') {
      at.pop();
      start = i + 1;
    } else if (ch === ';') {
      start = i + 1; // a statement at-rule (@import, @charset) ends here
    }
  }
  return rules;
}

/** A selector list split at its top-level commas (never inside :is(…) or [attr="a,b"]). */
function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The subject of a selector: its last compound, outside any (...). */
function subjectOf(sel) {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
  }
  return sel.slice(cut).trim();
}

const hasFixed = (body) => /(^|[;{\s])position\s*:\s*fixed\b/i.test(body);
const classesOf = (compound) => new Set((compound.replace(/\([^)]*\)/g, '').match(/\.[A-Za-z_][\w-]*/g) || []));

/** Every fixed layer in a set of stylesheets: one entry per selector in each fixed rule's list. */
function fixedLayers(sheets) {
  const out = [];
  for (const [file, source] of sheets) {
    for (const r of cssRules(source)) {
      if (!hasFixed(r.body)) continue;
      for (const sel of splitSelectors(r.selector)) out.push({ file, line: r.line, selector: sel, subject: subjectOf(sel) });
    }
  }
  return out;
}

/** The POP-UP LIST: the classes in the one rule that steps the menu bar out (null when absent). */
const LIST_RULE = /^body:has\(:is\(([^()]*)\)\) \.cs-fnav :is\(\.cs-fnav-pill, ?\.cs-fnav-menu-btn\)$/;
function popupList(sheets) {
  const found = [];
  for (const [file, source] of sheets) {
    for (const r of cssRules(source)) {
      const m = LIST_RULE.exec(r.selector);
      if (m) found.push({ file, rule: r, list: splitSelectors(m[1]) });
    }
  }
  return found;
}

/** The fixed layers on neither list: what a new pop-up built off the list looks like. */
function unaccounted(layers, list, notPopups) {
  const listed = new Set(list);
  return layers.filter((l) => {
    if (Object.prototype.hasOwnProperty.call(notPopups, l.subject)) return false;
    return ![...classesOf(l.subject)].some((c) => listed.has(c));
  });
}

// ── §1 the list ───────────────────────────────────────────────────────────────────────────────

const cssFiles = [];
const jsFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.css')) cssFiles.push(p);
    else if (/\.(jsx?|mjs)$/.test(e.name)) jsFiles.push(p);
  }
};
walk(SRC);
const rel = (p) => path.relative(APP, p).split(path.sep).join('/');
const sheets = cssFiles.map((f) => [rel(f), fs.readFileSync(f, 'utf8')]);
const css = read('src/index.css');
const rules = cssRules(css);

const lists = popupList(sheets);
ok('§1 one POP-UP LIST rule steps the menu bar out (body:has(:is(…)) .cs-fnav :is(.cs-fnav-pill, .cs-fnav-menu-btn))', lists.length === 1, `found ${lists.length}`);
const LIST = lists.length === 1 ? lists[0].list : [];
const listRule = lists.length === 1 ? lists[0].rule : null;
ok('§1 …in index.css, inside the phone\'s media block (max-width: 640px)',
  !!listRule && lists[0].file === 'src/index.css' && listRule.at.some((a) => /max-width:\s*640px/.test(a)),
  listRule ? `${lists[0].file}:${listRule.line} in ${JSON.stringify(listRule.at)}` : 'no rule');
ok('§1 …every entry is one class, once', LIST.length > 0 && LIST.every((c) => /^\.[A-Za-z_][\w-]*$/.test(c)) && new Set(LIST).size === LIST.length, LIST.join(', '));
const decl = (body, prop) => (new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, 'i').exec(body || '') || [])[1]?.trim() || '';
const slide = decl(listRule?.body, 'translate');
ok('§1 …slides them past the screen\'s foot: their own height (100%) plus the home bar\'s room',
  /^0\s+calc\(/.test(slide) && /100%/.test(slide) && /env\(safe-area-inset-bottom/.test(slide), slide || 'no translate');
ok('§1 …and hides them at the end, so nothing behind a pop-up is pressed, tabbed to or read out',
  decl(listRule?.body, 'visibility') === 'hidden' && decl(listRule?.body, 'pointer-events') === 'none');
ok('§1 …on translate, never the transform the open menu and the press already use', !/(^|[;{\s])transform\s*:/.test(listRule?.body || ''));
ok('§1 …and the rule sets no transition of its own (one clock, in the parts\' base rules, which reduced motion drops)', !decl(listRule?.body, 'transition'));
for (const part of ['.cs-fnav-pill', '.cs-fnav-menu-btn']) {
  const base = rules.find((r) => r.selector === part && r.at.some((a) => /max-width:\s*640px/.test(a)));
  const tr = decl(base?.body, 'transition');
  ok(`§1 ${part} slides on translate and keeps visibility for the whole slide`, /\btranslate\s+var\(--duration-[a-z]+\)/.test(tr) && /\bvisibility\s+var\(--duration-[a-z]+\)/.test(tr), tr || 'no base rule');
}
const reduced = rules.find((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a))
  && splitSelectors(r.selector).includes('.cs-fnav-pill') && splitSelectors(r.selector).includes('.cs-fnav-menu-btn'));
ok('§1 reduced motion: the bar steps out at once (its parts\' transitions are none)', !!reduced && decl(reduced.body, 'transition') === 'none');
const puck = rules.find((r) => r.selector === '.cs-fnav-pill.is-condensed .cs-fnav-puck');
ok('§1 the condensed puck takes the pill\'s pointer events (inherit), so it goes untappable with the pill',
  decl(puck?.body, 'pointer-events') === 'inherit', puck ? decl(puck.body, 'pointer-events') : 'no rule');

// ── §2 every fixed layer is accounted for ─────────────────────────────────────────────────────

const layers = fixedLayers(sheets);
ok('§2 the CSS has fixed layers to account for', layers.length >= 10, `${layers.length}`);
for (const l of unaccounted(layers, LIST, NOT_POPUPS)) {
  ok(`§2 ${l.file}:${l.line} ${l.selector} is a fixed layer on neither list`, false,
    'a pop-up goes on the POP-UP LIST in index.css; anything else goes in NOT_POPUPS here, with why it is not one');
}
for (const c of LIST) {
  ok(`§2 the list's ${c} is a fixed layer in the CSS`, layers.some((l) => classesOf(l.subject).has(c)), 'stale entry, or a pop-up that is not a full-screen layer');
  const name = c.slice(1);
  const drawnBy = jsFiles.filter((f) => new RegExp(`className=[{"'\`][^>]*?\\b${name.replace(/-/g, '\\-')}\\b`).test(fs.readFileSync(f, 'utf8')));
  ok(`§2 the list's ${c} is still drawn by a component`, drawnBy.length > 0);
}
for (const [subject, why] of Object.entries(NOT_POPUPS)) {
  ok(`§2 NOT_POPUPS ${subject} is still a fixed layer`, layers.some((l) => l.subject === subject), 'stale entry: remove it');
  ok(`§2 NOT_POPUPS ${subject} says why`, typeof why === 'string' && why.length > 12);
}
// Inline fixed positions in JS: a style object, a style write, a cssText.
const INLINE = /position\s*:\s*['"`]fixed['"`]|\.style\.position\s*=\s*['"`]fixed['"`]|setProperty\(\s*['"`]position['"`]\s*,\s*['"`]fixed['"`]|position\s*:\s*fixed\b/g;
const inline = {};
for (const f of jsFiles) {
  const n = (stripJsComments(fs.readFileSync(f, 'utf8')).match(INLINE) || []).length;
  if (n) inline[rel(f)] = n;
}
for (const [file, n] of Object.entries(inline)) {
  const known = NOT_POPUPS_INLINE[file];
  ok(`§2 ${file}: ${n} inline fixed position(s) accounted for`, !!known && known.count === n,
    known ? `NOT_POPUPS_INLINE says ${known.count}` : 'a pop-up goes on the POP-UP LIST (by its class); anything else in NOT_POPUPS_INLINE, with why');
}
for (const file of Object.keys(NOT_POPUPS_INLINE)) ok(`§2 NOT_POPUPS_INLINE ${file} still has its inline fixed position`, !!inline[file], 'stale entry: remove it');

// ── §3 the shared side panel ──────────────────────────────────────────────────────────────────

const panel = stripJsComments(read('src/components/SidePanel.jsx'));
ok('§3 components/SidePanel.jsx exists and is the default export', /export default function SidePanel\(/.test(panel));
ok('§3 …draws .side-panel-layer, which is on the POP-UP LIST', /side-panel-layer/.test(panel) && LIST.includes('.side-panel-layer'));
ok('§3 …at the page\'s top level: a portal to <body>, as Modal and MobileSheet draw', /return createPortal\(/.test(panel) && /document\.body,?\s*\)/.test(panel));
ok('§3 …closes on Esc through the one escape stack (UI_RULES §181)', /useEscapeLayer\(\s*open\s*,\s*onClose\s*\)/.test(panel));
ok('§3 …and on a tap on its dim', /className="side-panel-scrim"\s+onClick=\{onClose\}/.test(panel));
ok('§3 …slides between two classes (is-shown), set before the first paint from its closed place',
  /useLayoutEffect\(/.test(panel) && /getBoundingClientRect\(\)/.test(panel) && /is-shown/.test(panel));
ok('§3 …leaves the page when its slide out ends, with a backstop, and at once under reduced motion',
  /transitionend/.test(panel) && /setTimeout\(/.test(panel) && /prefers-reduced-motion/.test(panel));
ok('§3 …keeps the last item on screen while it slides out',
  /\[last, setLast\]\s*=\s*useState\(item\)/.test(panel) && /shownItem\s*=\s*open \? item : last/.test(panel) && /children\(shownItem\)/.test(panel));
ok('§3 …closed while typing on a phone, lets the keyboard start down before it slides (UI_RULES §105)',
  /\(pointer: coarse\)/.test(panel) && /KEYBOARD_HOLD_MS/.test(panel) && /\.blur\(\)/.test(panel) && /onBlur=/.test(panel));
const rule = (sel) => rules.find((r) => r.selector === sel && !r.at.length);
const layerRule = rule('.side-panel-layer');
ok('§3 .side-panel-layer is a fixed layer over the whole screen', hasFixed(layerRule?.body || '') && /inset\s*:\s*0/.test(layerRule?.body || ''));
const zOf = (sel) => Number(decl(rule(sel)?.body, 'z-index'));
ok('§3 …over the app (#root is one layer at z-index 1) and under the shared Modal, so a pop-up a panel opens shows over it',
  zOf('#root') === 1 && zOf('.side-panel-layer') > 1 && zOf('.side-panel-layer') < zOf('.modal-overlay'),
  `#root ${zOf('#root')} · .side-panel-layer ${zOf('.side-panel-layer')} · .modal-overlay ${zOf('.modal-overlay')}`);
const closedRule = rule('.side-panel');
const openRule = rule('.side-panel-layer.is-shown .side-panel');
ok('§3 .side-panel waits past the screen\'s right edge, and slides on transform',
  /translateX\(calc\(100% \+/.test(decl(closedRule?.body, 'transform')) && /^transform\s/.test(decl(closedRule?.body, 'transition')));
ok('§3 …to its place on transform, on a token clock both ways',
  decl(openRule?.body, 'transform') === 'none' && /^transform var\(--duration-[a-z]+\) var\(--ease-[a-z-]+\)$/.test(decl(openRule?.body, 'transition'))
    && /^transform var\(--duration-[a-z]+\) var\(--ease-[a-z-]+\)$/.test(decl(closedRule?.body, 'transition')));
ok('§3 …turning round mid-way: the two places are one transition between classes, not keyframes',
  !/animation\s*:/.test(closedRule?.body || '') && !/animation\s*:/.test(openRule?.body || ''));
const reducedPanel = rules.find((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)) && splitSelectors(r.selector).includes('.side-panel'));
ok('§3 …and reduced motion drops the slide', !!reducedPanel && decl(reducedPanel.body, 'transition') === 'none');
const scrimRule = rule('.side-panel-scrim');
ok('§3 the dim takes no drags, so the page behind it stays put', decl(scrimRule?.body, 'touch-action') === 'none');

const wo = stripJsComments(read('src/components/WorkOrderDrawer.jsx'));
const pay = stripJsComments(read('src/pages/payroll/PayrollLineDrawer.jsx'));
ok('§3 the work order panel draws through SidePanel', /import SidePanel from '\.\/SidePanel'/.test(wo) && /<SidePanel\b[^>]*className="wo-drawer"/.test(wo));
ok('§3 the Payroll panel draws through SidePanel', /import SidePanel from '\.\.\/\.\.\/components\/SidePanel'/.test(pay) && /<SidePanel\b[^>]*className="pay-drawer"/.test(pay));
ok('§3 neither draws a dim or a fixed panel of its own any more (replace means delete, II.5)',
  !/wo-drawer-backdrop|pay-scrim/.test(wo + pay + css) && !rules.some((r) => /^\.(wo|pay)-drawer$/.test(r.selector) && hasFixed(r.body)));
// Their pages keep them mounted, so the slide out can run (a `{x && <Drawer` unmounts it at once).
const offenders = jsFiles.filter((f) => /\{\s*[\w.]+\s*&&\s*\(?\s*<(WorkOrderDrawer|PayrollLineDrawer)\b/.test(fs.readFileSync(f, 'utf8'))).map(rel);
ok('§3 their pages keep them mounted (no `{x && <WorkOrderDrawer` / `<PayrollLineDrawer`)', !offenders.length, offenders.join(', '));
ok('§3 the work order panel\'s head keeps the status bar\'s room, its end the home bar\'s',
  /env\(safe-area-inset-top/.test(decl(rule('.wo-dh')?.body, 'padding-top')) && /env\(safe-area-inset-bottom/.test(decl(rule('.wo-drawer::after')?.body, 'height')));
ok('§3 the Payroll panel\'s head keeps the status bar\'s room, its foot the home bar\'s',
  /env\(safe-area-inset-top/.test(decl(rule('.pay-drawer-head')?.body, 'padding-top')) && /env\(safe-area-inset-bottom/.test(decl(rule('.pay-drawer-foot')?.body, 'padding-bottom')));

// ── §4 the detector on fixtures ───────────────────────────────────────────────────────────────

{
  const fixture = [
    '.ok-sheet { position: fixed; inset: 0; }',
    '@media (max-width: 640px) { .new-overlay { position:fixed; inset: 0; } }',
    '.a .x-panel, .y-panel.is-open { position: fixed; }',
    '/* .commented-out { position: fixed; } */',
    '.not-fixed { position: absolute; }',
    '@media (max-width: 640px) { body:has(:is(.ok-sheet, .y-panel)) .cs-fnav :is(.cs-fnav-pill, .cs-fnav-menu-btn) { visibility: hidden; } }',
  ].join('\n');
  const fx = [['fixture.css', fixture]];
  const fxList = popupList(fx);
  ok('§4 the list rule is found in a fixture', fxList.length === 1 && fxList[0].list.join() === '.ok-sheet,.y-panel', JSON.stringify(fxList.map((l) => l.list)));
  const left = unaccounted(fixedLayers(fx), fxList[0]?.list || [], {}).map((l) => l.subject);
  ok('§4 a new fixed overlay in a media block is caught', left.includes('.new-overlay'), left.join(', '));
  ok('§4 …and one in a selector list, by its subject', left.includes('.x-panel'), left.join(', '));
  ok('§4 a listed pop-up passes, with a state class too', !left.includes('.ok-sheet') && !left.includes('.y-panel.is-open'), left.join(', '));
  ok('§4 a commented-out rule and a non-fixed one are not layers', !left.includes('.commented-out') && !left.includes('.not-fixed'), left.join(', '));
  ok('§4 NOT_POPUPS clears a named layer', !unaccounted(fixedLayers(fx), fxList[0]?.list || [], { '.new-overlay': 'x', '.x-panel': 'x' }).length);
}

// ── §5 the browser half ───────────────────────────────────────────────────────────────────────

const sweep = read('scripts/responsive-sweep.mjs');
ok('§5 lint:responsive has the pop-up pass (POPUP_PROBES) at phone sizes', /const POPUP_PROBES\s*=/.test(sweep) && /POPUP_VIEWPORTS/.test(sweep));
ok('§5 …it opens the work order and Payroll panels', /wo-drawer/.test(sweep) && /pay-drawer/.test(sweep));
ok('§5 …fails a button under anything at its centre, and a bar showing over a pop-up', /popupProbe/.test(sweep) && /elementFromPoint/.test(sweep));
ok('§5 …and a bar hidden with no pop-up open (the list read from the page\'s own stylesheet)', /barHiddenWithNothingOpen|bar hidden with no pop-up/.test(sweep));

console.log(`test-popup-layers: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
