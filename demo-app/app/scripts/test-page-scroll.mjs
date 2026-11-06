// Every page opens at its top; Back and Forward put you back where you were (UI_RULES §186, CS-960).
//
// WHY. Found 2026-11-02 while measuring the area page's Open customer: a page opened from a scrolled
// page opened as far down as that page was. The Customers list scrolled 600px, then a customer opened
// from it, opened 600px down, its name, its Back and its tabs off the top, on a phone (the shell's one
// scroller, `.main`, kept its scroll across pages) and on a computer (the document did). Nothing in
// app/src put a new page at its top. Daniel, 2026-11-02, after seeing the before-and-after pictures:
// "Fix it next, own change (Recommended)": every page opens at its top from its first frame, Back
// and Forward return you to where you were, and tabs and filters are left as they are.
//
// The fix: components/PageScroll.jsx, mounted in both of AppLayout's shells before the page, asks
// lib/pageScroll.js where the page now on screen goes and puts it there before its first frame.
//
//   §1  the decision (lib/pageScroll.js placeFor), run here on the cases: another page opens at its
//       top (PUSH or REPLACE), even one seen before; Back or Forward in the browser (POP) goes to the
//       entry's own place, its top if it has none; the page's own ← Back (every ← Back control moves
//       with BACK_STATE: useBackTarget, DetailHeader) goes to where that address was left, referrer
//       or not, and any other link to it, the menu's to the page you came from included, opens it at
//       its top; the same page with another query or hash (a tab, a filter) is left alone, however
//       it got there; the first page of a load is the browser's
//   §2  the component: it places the page in a layout effect (before the frame is drawn), never in a
//       plain effect; it scrolls with `behavior: 'instant'` (html scrolls smoothly, index.css, so a
//       plain scrollTop would glide there on a computer); its box is `.main` while that scrolls (a
//       phone) and the document otherwise; it keeps each place from the scroll of both, by entry and
//       by address; it turns the browser's own restore off while it runs and gives it back when the
//       page goes (pagehide, unmount), taking it again when the page comes back from the cache; a
//       page put back keeps to its place for a moment as it fills in (the browser's scroll anchoring
//       off, snapped each frame), letting go when the moment ends or the person scrolls, taps or
//       types, and a page at its top needs none
//   §3  mounted before every page: AppLayout's office shell and its crew shell each draw it before
//       {page}, so its layout effect runs before the page's own (a page that moves itself, like a QR
//       code's area on a checklist, still has the last word); nothing else in app/src sets the
//       browser's scroll restoration
//   §4  the browser half: lint:responsive's page pass logs every frame at a phone's size and a
//       computer's, opening a customer from the scrolled Customers list, then Back, Forward and the
//       page's ← Back, and fails a frame off its place; CI can't run a browser, so this holds that
//       the pass exists
//
// REGRESSION (THE LAW II.3): on 2c5ea06c there is no lib/pageScroll.js and no PageScroll component,
// AppLayout draws nothing that places a page, and the sweep has no page pass, so §1 to §4 fail there.
// On 919be3e5 (the fix as first released) a ← Back was known only by the referrer it went to, so
// Settings' ← Settings, whose sections are opened without one, put Settings at its top (found live,
// 2026-11-02, at 390 x 844: 0 in all 110 frames, not 400), and a menu link to the page you came from
// put it back where it was: §1's BACK_STATE cases fail there.
//
//   node app/scripts/test-page-scroll.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// A hook call's body: from `name(` to its matching `)`.
function callBodies(src, name) {
  const out = [];
  for (let i = src.indexOf(`${name}(`); i > -1; i = src.indexOf(`${name}(`, i + 1)) {
    let depth = 0;
    for (let j = i + name.length; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') { depth -= 1; if (depth === 0) { out.push(src.slice(i, j + 1)); break; } }
    }
  }
  return out;
}

// ── §1 the decision ───────────────────────────────────────────────────────────────────────────

let lib = null;
try { lib = await import(pathToFileURL(path.join(APP, 'src/lib/pageScroll.js')).href); } catch { lib = null; }
ok('§1 lib/pageScroll.js decides where a page opens (placeFor, addressOf)', !!lib && typeof lib.placeFor === 'function' && typeof lib.addressOf === 'function');
if (lib && typeof lib.placeFor === 'function' && typeof lib.addressOf === 'function') {
  const { placeFor, addressOf } = lib;
  // What a ← Back control moves with; on code without it, the same shape, so the cases still run.
  const BACK = lib.BACK_STATE || { pageBack: true };
  const at = (key, pathname, search = '', state = null) => ({ key, pathname, search, hash: '', state });
  const list = at('k1', '/clients', '?tag=hoa');
  const customer = at('k2', '/clients/cl_1', '', { from: '/clients?tag=hoa', fromLabel: 'Customers' });
  const places = () => ({ byKey: new Map([['k1', 600], ['k2', 150], ['k3', 40]]), byAddress: new Map([['/clients?tag=hoa', 480], ['/clients/cl_1', 90], ['/schedule', 300]]) });

  ok('§1 the first page of a load is the browser\'s (no page before it)', placeFor(null, list, 'POP', places()) === null);
  ok('§1 the same history entry is left alone (a redraw, a shell mounted again)', placeFor(list, { ...list }, 'PUSH', places()) === null);
  ok('§1 another page opens at its top (a link: PUSH)', placeFor(list, customer, 'PUSH', places()) === 0);
  ok('§1 another page opens at its top (a redirect: REPLACE)', placeFor(list, customer, 'REPLACE', places()) === 0);
  ok('§1 a page seen before still opens at its top when it is opened again', placeFor(customer, at('k5', '/schedule'), 'PUSH', places()) === 0);
  ok('§1 Back or Forward in the browser goes to the entry\'s own place', placeFor(customer, list, 'POP', places()) === 600);
  ok('§1 …and to the place it was left at, not its address\'s latest', placeFor(list, at('k3', '/clients/cl_1'), 'POP', places()) === 40);
  ok('§1 …and to its top when it has none', placeFor(list, at('k9', '/invoices'), 'POP', places()) === 0);
  ok('§1 ← Back controls move with BACK_STATE ({ pageBack: true }, frozen), and isPageBack reads it',
    !!lib.BACK_STATE && lib.BACK_STATE.pageBack === true && Object.isFrozen(lib.BACK_STATE) && typeof lib.isPageBack === 'function'
    && lib.isPageBack({ state: lib.BACK_STATE }) && !lib.isPageBack({ state: { from: '/clients' } }) && !lib.isPageBack({ state: null }) && !lib.isPageBack(null));
  ok('§1 the page\'s own ← Back goes to where that address was left', placeFor(customer, at('k4', '/clients', '?tag=hoa', BACK), 'PUSH', places()) === 480);
  ok('§1 …referrer or not: Settings\' ← Settings (its sections opened without one) puts Settings where it was',
    placeFor(at('k10', '/settings/operations'), at('k11', '/settings', '', BACK), 'PUSH', { byKey: new Map(), byAddress: new Map([['/settings', 400]]) }) === 400);
  ok('§1 …and to its top when that address was never left', placeFor(at('k6', '/x', '', { from: '/never' }), at('k7', '/never', '', BACK), 'PUSH', places()) === 0);
  ok('§1 …only that address: a Back to the same path with another query is that query\'s place', placeFor(customer, at('k4', '/clients', '?tag=other', BACK), 'PUSH', places()) === 0);
  ok('§1 a link to the page you came from that is not a Back (the menu\'s Customers) opens it at its top', placeFor(customer, at('k4', '/clients', '?tag=hoa'), 'PUSH', places()) === 0);
  ok('§1 a Back\'s entry gone back to through the browser is that entry\'s place (POP)', placeFor(list, at('k2', '/clients/cl_1', '', BACK), 'POP', places()) === 150);
  for (const how of ['PUSH', 'REPLACE', 'POP']) {
    ok(`§1 a tab or a filter on the same page (only ?… changes, ${how}) is left alone`, placeFor(list, at('k8', '/clients', '?tag=office'), how, places()) === null);
    ok(`§1 …and a hash on the same page (${how})`, placeFor(list, { ...at('k8', '/clients', '?tag=hoa'), hash: '#top' }, how, places()) === null);
  }
  ok('§1 an address is the path and the query, as useFromHere\'s `from` is', addressOf(at('k1', '/clients', '?tag=hoa')) === '/clients?tag=hoa' && addressOf(at('k1', '/schedule')) === '/schedule');
  ok('§1 …and useFromHere still makes `from` that way', /from:\s*`\$\{pathname\}\$\{search\}`/.test(read('src/hooks/useFromHere.js')));
  ok('§1 …and the ← Back controls still go to that `from`, else their own page (useBackTarget, DetailHeader)',
    /location\.state\?\.from\s*\|\|/.test(read('src/hooks/useBackTarget.js')) && /location\.state\?\.from\s*\|\|/.test(read('src/components/DetailHeader.jsx')));
}
for (const rel of ['src/hooks/useBackTarget.js', 'src/components/DetailHeader.jsx']) {
  const src = stripJsComments(read(rel));
  ok(`§1 ${rel.split('/').pop()} moves as a Back: navigate(target, { state: BACK_STATE }), BACK_STATE from lib/pageScroll`,
    /navigate\(target,\s*\{\s*state:\s*BACK_STATE\s*\}\)/.test(src) && /import\s*\{[^}]*\bBACK_STATE\b[^}]*\}\s*from\s*'\.\.\/lib\/pageScroll'/.test(src));
}
{
  // Every other move to a referrer or a back target goes through those two: none left bare.
  const bare = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (/\.(jsx?|mjs)$/.test(ent.name) && /navigate\(\s*(target|location\.state\?\.from)\s*\)/.test(stripJsComments(read(rel)))) bare.push(rel);
    }
  };
  walk('src');
  ok('§1 no move to a referrer or a back target goes without BACK_STATE (a bare navigate(target))', bare.length === 0, bare.join(', '));
}

// ── §2 the component ──────────────────────────────────────────────────────────────────────────

const comp = stripJsComments(read('src/components/PageScroll.jsx'));
ok('§2 components/PageScroll.jsx exists', comp.length > 0);
const layoutBodies = callBodies(comp, 'useLayoutEffect');
const effectBodies = callBodies(comp, 'useEffect');
ok('§2 it places the page in a layout effect, before the frame is drawn', layoutBodies.some((b) => /placeFor\(/.test(b) && /placePage\(|scrollTo\(/.test(b)));
ok('§2 …never in a plain effect, after it is drawn', comp.length > 0 && !effectBodies.some((b) => /placeFor\(|placePage\(|scrollTo\(/.test(b)));
ok('§2 it scrolls with behavior \'instant\' (html scrolls smoothly)', /scrollTo\(\s*\{[^}]*behavior:\s*'instant'/.test(comp));
ok('§2 …and never by setting scrollTop, which would glide on a computer', comp.length > 0 && !/\.scrollTop\s*=[^=]/.test(comp));
ok('§2 …which index.css still makes smooth (else this needs no instant)', /html\s*\{[^}]*scroll-behavior:\s*smooth/.test(read('src/index.css')));
ok('§2 its box is .main while that scrolls (a phone), the document otherwise', /querySelector\('main\.main'\)/.test(comp) && /overflowY/.test(comp) && /document\.scrollingElement/.test(comp));
ok('§2 it keeps each place from the scroll of .main and the window', /addEventListener\('scroll'/.test(comp) && /window\.addEventListener\('scroll'/.test(comp) && /removeEventListener\('scroll'/.test(comp));
ok('§2 …by history entry and by address', /byKey\.set\(/.test(comp) && /byAddress\.set\(/.test(comp) && /addressOf\(/.test(comp));
ok('§2 it turns the browser\'s own restore off while it runs', /scrollRestoration\s*=/.test(comp) && /'manual'/.test(comp));
ok('§2 …and gives it back when the page goes (pagehide) and when it unmounts', /addEventListener\('pagehide'/.test(comp) && /'auto'/.test(comp) && effectBodies.some((b) => /return\s*\(\)\s*=>[\s\S]*(browserRestores\(true\)|scrollRestoration\s*=\s*'auto')/.test(b)));
ok('§2 …taking it again when the page comes back from the cache (pageshow)', /addEventListener\('pageshow'/.test(comp));
ok('§2 one memory for the tab, so a shell mounted by a page change carries on from the last page', /^let here\b/m.test(comp) && /^const places\s*=/m.test(comp));
const placeBody = (() => { const at = comp.indexOf('function placePage('); return at > -1 ? comp.slice(at, comp.indexOf('\n}\n', at)) : ''; })();
ok('§2 a page put back keeps to its place as it fills in, snapped each frame', /requestAnimationFrame\(keepTo\)/.test(placeBody) && /Math\.abs\(box\.scrollTop - y\) > 1/.test(placeBody));
ok('§2 …for a moment only (HOLD_MS, a second at most)', /const HOLD_MS = (\d+);/.test(comp) && Number(/const HOLD_MS = (\d+);/.exec(comp)?.[1]) <= 1000 && /performance\.now\(\) \+ HOLD_MS/.test(placeBody));
ok('§2 …letting go when the person scrolls, taps or types', /const HANDS = \['wheel', 'touchstart', 'pointerdown', 'keydown'\]/.test(comp) && /addEventListener\(ev, letGo, \{ capture: true/.test(placeBody) && /removeEventListener\(ev, letGo, true\)/.test(comp));
ok('§2 …and a page at its top needs none', /if \(!y\) return;/.test(placeBody));
ok('§2 …with the browser\'s scroll anchoring off while it holds, and the box\'s own back after', /box\.style\.overflowAnchor = 'none'/.test(placeBody) && /anchor: box\.style\.overflowAnchor/.test(placeBody) && /hold\.box\.style\.overflowAnchor = hold\.anchor/.test(comp));
ok('§2 a new placement or the shell going lets the last hold go', /^\s*letGo\(\);/m.test(placeBody) && effectBodies.some((b) => /return\s*\(\)\s*=>[\s\S]*letGo\(\)/.test(b)));

// ── §3 mounted before every page ──────────────────────────────────────────────────────────────

const layout = stripJsComments(read('src/layouts/AppLayout.jsx'));
ok('§3 AppLayout imports PageScroll', /import PageScroll from '\.\.\/components\/PageScroll'/.test(layout));
const crewAt = layout.indexOf('if (crew)');
const crewShell = crewAt > -1 ? layout.slice(crewAt, layout.indexOf('\n  }\n', crewAt)) : '';
const officeShell = crewAt > -1 ? layout.slice(layout.indexOf('\n  }\n', crewAt)) : '';
for (const [name, shell] of [['the crew shell', crewShell], ['the office shell', officeShell]]) {
  const at = shell.indexOf('<PageScroll />');
  const pageAt = shell.indexOf('{page}');
  ok(`§3 ${name} draws <PageScroll /> before {page}, inside its .main`, at > -1 && pageAt > -1 && at < pageAt && shell.lastIndexOf('<main', at) > -1 && shell.indexOf('</main>', at) > pageAt);
}
const restorers = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jsx?|tsx?)$/.test(e.name) && /scrollRestoration\s*=/.test(stripJsComments(fs.readFileSync(p, 'utf8')))) restorers.push(path.relative(APP, p));
  }
};
walk(path.join(APP, 'src'));
ok('§3 nothing else in app/src sets the browser\'s scroll restoration', restorers.length === 1 && restorers[0] === path.join('src', 'components', 'PageScroll.jsx'), restorers.join(', ') || 'none');

// ── §4 the browser half ───────────────────────────────────────────────────────────────────────

const sweep = read('scripts/responsive-sweep.mjs');
ok('§4 lint:responsive has the page pass (PAGE_PROBES) at a phone\'s size and a computer\'s', /const PAGE_PROBES\s*=/.test(sweep) && /const PAGE_VIEWPORTS\s*=\s*\[[^\]]*\b390\b[^\]]*\b1280\b/.test(sweep));
ok('§4 …logging every frame after it is drawn (a task posted from requestAnimationFrame)', /requestAnimationFrame\(\(\) => \{ setTimeout\(/.test(sweep));
ok('§4 …opening a customer from the scrolled Customers list', /list: '\/clients'/.test(sweep));
ok('§4 …then Back, Forward and the page\'s ← Back', /goBack\(/.test(sweep) && /goForward\(/.test(sweep) && /a\.detail-back/.test(sweep));
ok('§4 …and Settings\' ← Settings, the Back that names no referrer (its sections are opened without one)',
  /list:\s*'\/settings'/.test(sweep) && /back:\s*'\.main a\.set-back'/.test(sweep) && /querySelector\(sel\)[\s\S]{0,80}probe\.back/.test(sweep));

console.log(`test-page-scroll: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
