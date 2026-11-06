// Messages shows only the panes that fit, and nothing floats over its composer (CS-704; UI_RULES §164).
//
// At an iPad held upright (810–834px, and any desktop window 769–1025px) the thread pane needed
// 786px beside the 240px sidebar, the grid hid the overflow, and the conversation was cut off with
// its Send at x=937 on an 820px screen; Client Requests' Respond sat past its table's edge; the
// floating Messages launcher covered the composer at 820 and Send at 1024; and the right context
// pane ran off the screen at 1180 and on a 1366 laptop. lint:responsive measured page overflow
// only, and an overflow-hidden grid FITS.
//
//   §1  the grid's tracks, read from index.css at every width a reader can have, never ask for more
//       than the screen beside the sidebar: their minimums (a side pane's floor, the thread's 480px,
//       the handles) sum within it — three panes from 1280px, two from 1024px, one below
//   §2  below 1024px the inbox is ONE pane: the list, or the open thread (`has-active`) with its
//       back arrow, and the inbox's header wraps rather than squeezing its tabs
//   §3  the context pane is drawn only where a template has a column for it
//   §4  the Messages launcher draws nothing on Messaging itself
//   §5  Client Requests lets the building and the clock wrap below 1024px, so Respond stays in view
//   §6  the browser half: lint:responsive's REACH pass taps Send, a customer thread's Send and
//       Respond at 820, 1024, 1180 and 1366 (CI can't run a browser, so this holds that it exists)
//
// REGRESSION (THE LAW II.3): on the tree before the fix §1 (769–1279 and 1366), §2, §4, §5 and §6
// fail.
//
//   node app/scripts/test-messaging-panes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleRules } from './css-rules.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const css = read('src/index.css');
const RULES = styleRules(css);
// The rule's media: '' (every width) or its max-width bound; anything else is not part of this model.
const maxWidthOf = (at) => {
  if (!at) return Infinity;
  const m = /^@media \(max-width: (\d+)px\)$/.exec(at);
  return m ? Number(m[1]) : null;
};
// What a selector gets at viewport width `w`: the declarations of every rule that applies there
// (no media, or a max-width at or above w), in source order (they share one specificity).
function at(sel, w) {
  const out = {};
  for (const r of RULES) {
    if (!r.sels.includes(sel)) continue;
    const max = maxWidthOf(r.at);
    if (max === null || w > max) continue;
    Object.assign(out, r.decl);
  }
  return out;
}

// ── the tracks' minimums ─────────────────────────────────────────────────────────────────────
// A track's floor: `Npx` → N; `minmax(A, B)` → A's floor; `var(--x, Npx)` → N (the resize hook's
// default — the hook may make it wider, never narrower than PANE_MIN); `Nfr` / `0` → 0.
function splitTracks(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(v || '')) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function floorOf(track) {
  const t = track.trim();
  if (/^-?[\d.]+px$/.test(t)) return parseFloat(t);
  if (/^[\d.]*fr$/.test(t) || t === '0' || t === 'auto') return 0;
  const mm = /^minmax\((.*)\)$/.exec(t);
  if (mm) {
    let depth = 0, cut = -1;
    for (let i = 0; i < mm[1].length; i += 1) { const ch = mm[1][i]; if (ch === '(') depth += 1; else if (ch === ')') depth -= 1; else if (ch === ',' && depth === 0) { cut = i; break; } }
    return floorOf(mm[1].slice(0, cut));
  }
  const v = /^var\(--[\w-]+,\s*(.*)\)$/.exec(t);
  if (v) return floorOf(v[1]);
  return NaN;
}
const sidebarW = (() => { const m = /--sidebar-w:\s*(\d+)px/.exec(css); return m ? Number(m[1]) : NaN; })();
const PHONE_MAX = 640; // the sidebar goes off-canvas at 640px and below (index.css)

// §1 — every width a reader can have, the seams and the devices.
{
  ok('index.css names the sidebar\'s width', Number.isFinite(sidebarW), String(sidebarW));
  const WIDTHS = [641, 700, 768, 769, 800, 810, 820, 834, 900, 960, 1000, 1023, 1024, 1100, 1180, 1200, 1279, 1280, 1366, 1440, 1600, 1920];
  const over = [];
  for (const w of WIDTHS) {
    const cols = at('.msg-3pane', w)['grid-template-columns'];
    const floors = splitTracks(cols).map(floorOf);
    const need = floors.reduce((a, b) => a + b, 0);
    const room = w - (w > PHONE_MAX ? sidebarW : 0);
    if (!cols || floors.some((f) => !Number.isFinite(f)) || need > room) over.push(`${w}px: ${cols} needs ${need}px in ${room}px`);
  }
  ok(`🔴 §1 at every width the panes' minimums fit beside the sidebar (${over.length} widths over)`, over.length === 0, over.slice(0, 4).join(' | '));
  const tracks = (w) => splitTracks(at('.msg-3pane', w)['grid-template-columns']).length;
  ok('🔴 §1b three panes from 1280px, two from 1024px, one below', tracks(1280) === 5 && tracks(1366) === 5 && tracks(1279) === 3 && tracks(1024) === 3 && tracks(1023) === 1 && tracks(820) === 1 && tracks(768) === 1,
    [1366, 1280, 1279, 1024, 1023, 820, 768].map((w) => `${w}:${tracks(w)}`).join(' '));
}

// §2 — the single pane, below 1024px (and on a phone).
{
  for (const w of [1023, 820, 768, 375]) {
    const list = at('.msg-3pane.has-active .thread-list-pane', w).display;
    const thread = at('.msg-3pane:not(.has-active) .message-pane', w).display;
    const back = at('.msg-back-btn', w).display;
    ok(`🔴 §2 at ${w}px: the list alone, or the open thread alone with its back arrow`, list === 'none' && thread === 'none' && back === 'inline-flex', `${list} / ${thread} / ${back}`);
  }
  ok('§2b two panes keep no back arrow (1024px and up)', at('.msg-back-btn', 1024).display === 'none' && at('.msg-3pane.has-active .thread-list-pane', 1024).display === undefined);
  ok('🔴 §2c below 1024px the inbox\'s header wraps its actions to a second row (its tabs keep their width)', at('.messaging-header', 820)['flex-wrap'] === 'wrap');
}

// §3 — the context pane only where a template has its column.
{
  const shown = (w) => at('.context-pane', w).display !== 'none';
  const bad = [820, 1023, 1024, 1180, 1279, 1280, 1366].filter((w) => shown(w) !== (splitTracks(at('.msg-3pane', w)['grid-template-columns']).length === 5));
  ok('§3 the context pane is drawn exactly where the grid has its column', bad.length === 0, bad.join(', '));
}

// §4 — the launcher stays off Messaging.
{
  const dock = read('src/components/MessagesDock.jsx');
  const body = dock.slice(dock.indexOf('export default function MessagesDock'));
  const hookEnd = body.indexOf('if (isMobile) return null;');
  const guard = body.search(/if \(pathname === '\/messaging' \|\| pathname\.startsWith\('\/messaging\/'\)\) return null;/);
  ok('🔴 §4 the Messages launcher draws nothing on Messaging (it sat over the composer)', guard > -1 && /const \{ pathname \} = useLocation\(\);/.test(body)
    && body.indexOf('useLocation()') < hookEnd && guard > hookEnd);
}

// §5 — Client Requests' clock and building wrap where the queue is narrow.
{
  const left = at('.creq-table .creq-left', 820)['white-space'];
  const name = at('.creq-table td.cell-primary .truncate', 820)['white-space'];
  ok('🔴 §5 below 1024px the clock and the building\'s name wrap, so Respond stays in view', left === 'normal' && name === 'normal', `${left} / ${name}`);
  ok('§5b a computer keeps the clock on one line', at('.creq-left', 1280)['white-space'] === 'nowrap' && at('.creq-table .creq-left', 1280)['white-space'] === undefined);
}

// §6 — the browser half exists.
{
  const sweep = read('scripts/responsive-sweep.mjs').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const widths = [820, 1024, 1180, 1366];
  ok('🔴 §6a lint:responsive has a REACH pass at an iPad upright and lying down and a laptop', /const REACH_VIEWPORTS = \[/.test(sweep)
    && widths.every((w) => new RegExp(`\\{\\s*w:\\s*${w},`).test(sweep.slice(sweep.indexOf('REACH_VIEWPORTS')))), widths.join(', '));
  ok('🔴 §6b …tapping a conversation\'s Send, a customer thread\'s Send and Respond',
    /path: '\/messaging\/[\w-]+', sel: '\.message-pane \.compose-send'/.test(sweep) && /path: '\/messaging\?inbox=customers&b=[\w-]+', sel: '\.message-pane \.compose-send'/.test(sweep)
    && /path: '\/requests', sel: '[^']*col-review[^']*'/.test(sweep));
  ok('🔴 §6c …which fails a control off the screen, cut off by its box, or covered — and a context pane past the edge',
    /function reachProbe\b/.test(sweep) && /onScreen/.test(sweep) && /clippedBy/.test(sweep) && /topmost/.test(sweep) && /contextRight/.test(sweep) && /reachFails\.length/.test(sweep));
}

console.log(`\ntest-messaging-panes: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
