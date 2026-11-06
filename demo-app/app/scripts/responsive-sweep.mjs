// lint:responsive — drives the REAL app at every target viewport and fails on horizontal
// scroll. The regression harness for SHELL_MOBILE_RESPONSIVE.md's one mandate:
//
//   "Zero horizontal scroll on any viewport, anywhere in the app. No exceptions."
//
// 🔴 WHY A DRIVEN HARNESS AND NOT A STATIC LINT. Overflow is an emergent property of the
// rendered box tree — a fixed width, a long unbreakable string, a grid that will not
// collapse, a negative margin that cancels the wrong padding. None of those are visible by
// reading CSS, which is why this repo's mobile regressions have always been found by a
// human on a device instead of by the build. `document.scrollWidth > clientWidth` is the
// definitive test and it costs one page load per route.
//
// It also beats a screenshot: a 12px overflow is invisible in a picture and unambiguous
// here. Screenshots prove it LOOKS right; this proves it FITS.
//
// Viewports are Steve's reality, not generic device presets:
//   320  — the contract's floor
//   375  — the contract's canonical width (iPhone SE/12/13/14 mini class)
//   768  — iPad PORTRAIT, the 641–1024 seam that was unverified until 2026-07-29
//   1024 — iPad LANDSCAPE, which is how Steve actually works (renders as narrow desktop)
//
// 🔴 AND WHICH BOX SCROLLS ON A PHONE (UI_RULES §106), at 390×844. Inside the office shell the
// DOCUMENT never scrolls (html.cs-app-shell pins html, body and #root to the screen) and `.main`
// does, so the nav can't float mid-screen in the iOS standalone PWA. Every page OUTSIDE the shell
// (the login and the public pages) is an ordinary document. Until 2026-10-03 the lock was global,
// and on a phone the public quote and the inspection report were cut off at the bottom with no
// way to reach their last line, while every check above passed them: a clipped page still FITS.
// The phone pass scrolls each page outside the shell to its end and fails one whose last element
// stays below the screen or whose html/body refuse to scroll; on an office route it fails a
// document that scrolls or a `.main` that doesn't. test-phone-scroll-lock.mjs holds the CSS in CI.
//
// Usage (needs a dev server running — `--mode demo` gives seeded data and no login gate):
//   npm --prefix app run dev -- --mode demo --port 5193
//   node app/scripts/responsive-sweep.mjs                 # fail on any overflow
//   node app/scripts/responsive-sweep.mjs --url http://localhost:5193
//   node app/scripts/responsive-sweep.mjs --report        # also list inner side-scrollers
//   node app/scripts/responsive-sweep.mjs --phone         # only the phone scroll pass
//   node app/scripts/responsive-sweep.mjs --reach         # only the reach pass (UI_RULES §164)
//   node app/scripts/responsive-sweep.mjs --popups        # only the pop-up pass (UI_RULES §105)
//   node app/scripts/responsive-sweep.mjs --pages         # only the page pass (UI_RULES §186)
//
// CHROME_PATH overrides the browser, same env var api/_lib/quotes/render.js already uses.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appRoutes, publicRoutes, DEMO_PATHS, missingRecord } from './app-routes.mjs';
import { HUB_PREVIEW_STORAGE_KEY } from '../src/lib/hubPreview.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://localhost:5193').replace(/\/$/, '');
const REPORT = process.argv.includes('--report');
// --shots turns the sweep into a VISUAL contact sheet: one screenshot per route ×
// viewport + a single index.html gallery (viewport tabs, grid of thumbnails). This is
// the "does it LOOK solid & uniform" companion to the "does it FIT" gate — see
// app/MOBILE_QA.md. Gallery mode always exits 0 (a review tool, not a build gate).
const SHOTS = process.argv.includes('--shots');
const SHOTS_DIR = fileURLToPath(new URL('../mobile-shots/', import.meta.url));
const shots = [];

const LOCAL_CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const VIEWPORTS = [
  { w: 320, h: 568, label: 'floor' },
  { w: 375, h: 812, label: 'phone (canonical)' },
  { w: 768, h: 1024, label: 'iPad portrait — the OLD seam (Mini/9.7")' },
  // 🔴 820 — the seam the 768 row hid. Every CURRENT iPad in portrait is 810–834px
  // (10.9"/Air 820, Pro 11" 834), ABOVE 768, so 768 tested clean while a real iPad
  // rendered desktop tables crammed into ~580px and scrolled sideways. Added 2026-08-11.
  { w: 820, h: 1180, label: 'iPad 10.9"/Air portrait — the REAL device' },
  { w: 1024, h: 768, label: 'iPad landscape — Steve' },
];

// Every surface App.jsx routes to (scripts/app-routes.mjs, shared with lint:reskin and style-snapshot).
// Detail routes carry a seeded demo id so they render real content, and a demo page that says "not
// found" fails: an empty detail page has no layout to break and would pass vacuously.
const ROUTES = appRoutes();
const SHELL_LESS = new Set(publicRoutes()); // the login and public pages have no .main to wait for
// A route whose TABS are different layouts is swept per tab too: the route's own path shows only
// its first tab. Each entry must sit on a route App.jsx declares (a stale one is dropped, and
// says so below). Supplies' two views share nothing but the header (2026-10-04); a building's
// supply list is a tab of its customer page since 2026-10-06 (round 3), swept on the seeded one.
// A building's Documents tab (the client hub redesign, 2026-10-08) is swept on Coral Bay HOA: its
// agreement line, its certificate and a hidden office copy, and the company's W-9 below them; its
// Messages tab (the building's thread with its customers) on the same customer. Supplies' By building
// (the manager view redesign, 2026-10-09) is its own layout: tiles, a buildings table, the phone's
// all-set line. The owner's Home has two views behind its switch (the manager view redesign, UI_RULES
// §152): `/` is the cockpit, `/?view=manager` the manager Home with its tiles and Manager filter.
// The Schedule's Today view (the manager view, 2026-10-09) is its own layout too: the owner's
// default /schedule shows Day, so Today is swept by its own URL. So is the New Inspection form
// (Matt's board, 2026-10-09): its deep link with a building and a template opens straight onto
// the score card, the tick list, the Before / After tiles and the notes. The Quality hub's Work
// Orders tab (CS-640) carries the paged resolved history's note and Load more under its list.
// The master supply list (2026-10-11): Supplies' Catalog tab is its own table, and a building's
// switches open over its Supplies tab with ?edit=1 (the office's view; the demo signs in as one).
// The delivery step (2026-10-12): the driver's Deliveries page is a route of its own, so it is swept
// with the rest. The supply orders (S131): the queue's With supplier and Partially fulfilled tabs (the
// Supply Manager's "Process order →"), the New tab (its "Submit to supplier"), and the Catalog tab with
// one building picked (its products, "+ Add product" and the footer line); each order's page is a
// route of its own (app-routes.mjs PARAMS).
const TAB_VIEWS = ['/supplies?tab=usage', '/supplies?tab=buildings', '/supplies?tab=catalog', '/supplies?status=sent', '/supplies?status=partial', '/supplies?status=approved', '/supplies?tab=catalog&cb=cl_seed_pacridge', '/clients/cl_seed_evergreen?tab=supplies&edit=1','/inspections?tab=workorders', '/clients/cl_seed_evergreen?tab=supplies', '/clients/cl_seed_mtbaker?tab=documents', '/clients/cl_seed_mtbaker?tab=messages', '/clients/cl_seed_evergreen?tab=activity', '/hr?tab=warnings', '/?view=manager', '/schedule?view=Today', '/inspections?fill=1&siteId=st_seed_mtb-clbhs&templateId=it_janitorial'];
// The office's "Preview as customer" (the client hub redesign, plan §3.7, UI_RULES §151): the hub
// with this tab's preview flag set (lib/hubPreview.js), so its banner and its controls (live while
// it acts as the customer, disabled with the switch off) are swept at every width too — Coral Bay
// HOA's Home, a request with its reply box, the New request form and Account. A `#preview` view
// sets the flag before it loads and clears it after; it must show the preview's banner, whichever
// words the switch gives it (hubPreviewBanner).
const PREVIEW_BUILDING = { buildingId: 'cl_seed_mtbaker', name: 'Coral Bay HOA' };
const PREVIEW_VIEWS = ['/hub/b/cl_seed_mtbaker', '/hub/b/cl_seed_mtbaker/tickets/pr_coralbay_windows', '/hub/b/cl_seed_mtbaker/tickets/new', '/hub/account']
  .filter((p) => ROUTES.includes(p)).map((p) => `${p}#preview`);
const SWEEP = [...ROUTES, ...TAB_VIEWS.filter((p) => ROUTES.includes(p.split('?')[0])), ...PREVIEW_VIEWS];
const staleViews = TAB_VIEWS.filter((p) => !ROUTES.includes(p.split('?')[0]));
if (staleViews.length) console.warn(`  ⚠ TAB_VIEWS names a route App.jsx no longer declares: ${staleViews.join(', ')}`);
const noBanner = [];

// A board is a board: the Kanban scrolls sideways BY DESIGN and always will. Exempting it
// by name is honest; letting it fail and teaching everyone to ignore the run is not.
const INNER_SCROLL_EXEMPT = [/pipeline-board/];

// The phone scroll pass (see the header): an iPhone 12–15 screen, every page outside the shell,
// and one office route whose content is taller than a phone (it must be a route App.jsx declares).
const PHONE = { w: 390, h: 844 };
const PHONE_ONLY = process.argv.includes('--phone');
const REACH_ONLY = process.argv.includes('--reach');
const PHONE_SHELL_PROBES = ['/clients'];

// 🔴 REACH — the control a reader must TAP is on the screen, inside the box that draws it, and on
// top at its centre (CS-704, UI_RULES §164), at an iPad held upright (820), lying down (1024, 1180)
// and a laptop (1366). The checks above cannot see this: at 820 Messages' grid hid its overflow,
// so the page FIT while a thread's Send sat at x=937 on an 820px screen, Client Requests' Respond
// sat past its table's edge, and at 1024 the floating Messages launcher covered Send. A probe whose
// page does not draw its control fails too (it would prove nothing). And a context pane that is
// drawn must end inside the screen (it was cut at 1180 and 1366).
const REACH_VIEWPORTS = [{ w: 820, h: 1180 }, { w: 1024, h: 768 }, { w: 1180, h: 820 }, { w: 1366, h: 768 }];
const REACH_PROBES = [
  { path: '/messaging/cv_seed_c1', sel: '.message-pane .compose-send', what: "a conversation's Send" },
  { path: '/messaging?inbox=customers&b=cl_seed_mtbaker', sel: '.message-pane .compose-send', what: "a customer thread's Send" },
  { path: '/requests', sel: 'tr.creq-row td.col-review .btn', what: "Client Requests' Respond" },
];
// Run in the page: is the control reachable, and is a drawn context pane inside the screen?
function reachProbe(sel) {
  const vw = document.documentElement.clientWidth;
  const el = document.querySelector(sel);
  const out = { found: !!el, vw };
  if (el) {
    const r = el.getBoundingClientRect();
    out.drawn = r.width > 0 && r.height > 0;
    out.left = Math.round(r.left); out.right = Math.round(r.right);
    out.onScreen = r.left >= 0 && r.right <= vw + 1;
    out.clippedBy = null;
    for (let a = el.parentElement; a && !out.clippedBy; a = a.parentElement) {
      if (!/hidden|clip|auto|scroll/.test(getComputedStyle(a).overflowX)) continue;
      const b = a.getBoundingClientRect();
      if (r.right > b.right + 1 || r.left < b.left - 1) out.clippedBy = (typeof a.className === 'string' && a.className.trim().split(/\s+/)[0]) || a.tagName.toLowerCase();
    }
    const top = out.drawn ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    out.topmost = !!top && (top === el || el.contains(top));
    out.covering = top && !out.topmost ? ((typeof top.className === 'string' && top.className.trim().split(/\s+/)[0]) || top.tagName.toLowerCase()) : null;
  }
  const ctx = [...document.querySelectorAll('.context-pane')].find((p) => getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 0);
  out.contextRight = ctx ? Math.round(ctx.getBoundingClientRect().right) : null;
  return out;
}
const reach = [];

// 🔴 POP-UPS ON A PHONE (UI_RULES §105). Matt, 2026-11-02: the floating menu bar sat over the work
// order panel's status buttons on his phone, and a finger on one opened a page behind the bar. No
// pass above ever opened a panel, so none saw it. The menu bar now slides away while any pop-up on
// index.css's POP-UP LIST is on the page (test-popup-layers.mjs holds the list in CI). At a phone's
// sizes this opens each probe's pop-up the way a finger does, waits for it to land, and fails:
//   · the menu bar still showing over it,
//   · any button in it that isn't on top at its centre once scrolled into view (what a finger hits),
//   · the bar not back, or the pop-up still on the page, once its × has closed it.
// And on every office route the main sweep loads at a phone's width: the bar hidden with no pop-up
// open (a class from the list left on the page, which would keep the bar away for good).
const POPUPS_ONLY = process.argv.includes('--popups');
const POPUP_VIEWPORTS = [{ w: 320, h: 568 }, { w: 390, h: 844 }, { w: 420, h: 912 }, { w: 440, h: 956 }];
const POPUP_PROBES = [
  { path: '/inspections?tab=workorders', open: 'tr.wo-rowlink', panel: '.wo-drawer', what: 'the work order panel' },
  { path: '/requests', open: 'tr.creq-row td.col-review .btn', panel: '.wo-drawer', what: 'the work order panel from Client Requests' },
  // Payroll draws its people as cards on a phone (the Register layout) and as rows or a roster on a
  // wider screen or another layout: the first one drawn opens the panel.
  { path: '/payroll', open: 'button.pay-card:not([disabled]), button.pay-rrow:not([disabled]), tr.pay-row', panel: '.pay-drawer', what: 'the Payroll panel' },
  { path: '/variance', open: '.filter-open-btn', panel: '.sheet', what: 'the Filters sheet' },
];
// Run in the page: the menu bar's state, against the POP-UP LIST read from the page's own stylesheet
// (one list: never restated here). `drawn` = the list's layers on the page with a box.
function barState() {
  let list = null;
  const walkRules = (rules) => {
    for (const r of rules) {
      if (list) return;
      if (r.cssRules && !r.selectorText) walkRules(r.cssRules);
      const m = r.selectorText && /^body:has\(:is\(([^()]*)\)\) \.cs-fnav :is\(\.cs-fnav-pill, ?\.cs-fnav-menu-btn\)$/.exec(r.selectorText.replace(/\s+/g, ' '));
      if (m) list = m[1].split(',').map((s) => s.trim());
    }
  };
  for (const sheet of document.styleSheets) { try { walkRules(sheet.cssRules); } catch { /* another origin's sheet */ } }
  const parts = ['.cs-fnav-pill', '.cs-fnav-menu-btn'].map((s) => document.querySelector(s)).filter(Boolean);
  const vh = window.innerHeight;
  const showing = parts.filter((el) => getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().top < vh);
  const drawn = (list || []).filter((sel) => [...document.querySelectorAll(sel)].some((el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
  }));
  return { list, bar: parts.length > 0, showing: showing.length, hidden: parts.length > 0 && showing.length === 0, drawn };
}
// Run in the page with a pop-up open: every button in it, scrolled into view, is what a finger at its
// centre hits; and the menu bar is out of the way.
function popupProbe(panelSel) {
  const pop = document.querySelector(panelSel);
  if (!pop) return { found: false };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '');
  const covered = [];
  let checked = 0;
  for (const b of pop.querySelectorAll('button, a.btn, [role="tab"]')) {
    const cs = getComputedStyle(b);
    if (cs.visibility === 'hidden' || cs.display === 'none' || !b.getClientRects().length) continue;
    b.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = b.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    checked += 1;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || !(top === b || b.contains(top))) covered.push(`${(b.innerText || b.getAttribute('aria-label') || name(b)).trim().slice(0, 24)} under ${top ? name(top) : 'nothing'} at y ${Math.round(r.top)}`);
  }
  return { found: true, checked, covered };
}
const popups = [];
const barHidden = [];

// 🔴 WHERE A PAGE OPENS (UI_RULES §186, CS-960). Found 2026-11-02: a customer opened from the
// Customers list scrolled 600px opened 600px down, its name, its Back and its tabs off the top, on a
// phone (the shell's one scroller, .main) and on a computer (the document). Daniel, 2026-11-02: every
// page opens at its top from its first frame, and Back and Forward return you to where you were. At
// a phone's size and a computer's this logs every frame, read after it is drawn, through: a customer
// opened from the scrolled list; the browser's Back; its Forward (the customer scrolled a little
// first); the page's own ← Back. It fails a frame of the page arriving that is off its place: the
// customer at its top, the list where it was, the customer where it was. A frame as far down as the
// page then goes counts as its place: a page that fills in after its first frame (on a computer the
// list's ticket flags arrive from the server and its rows grow) is shorter until it has, and keeps
// to its place as it grows. Frames still showing the page before (React keeps it up until the next
// is ready) are not the next page's: its heading tells them apart. Settings' sections are opened
// without a referrer, so its ← Settings is the Back that names nothing (found live on 2026-11-02:
// it put Settings at its top): every ← Back control moves as a Back (BACK_STATE).
const PAGES_ONLY = process.argv.includes('--pages');
const PAGE_VIEWPORTS = [{ w: 390, h: 844 }, { w: 1280, h: 800 }];
const PAGE_PROBES = [
  { list: '/clients', open: 'tr.clickable', back: 'a.detail-back', what: 'a customer from the Customers list' },
  { list: '/settings', open: '.main a[href^="/settings/"]', back: '.main a.set-back', what: 'a section of Settings (no referrer)' },
];
// Run in the page: from now until pageLogStop, after each frame is drawn (a task posted from
// requestAnimationFrame; a read in the callback itself runs before the app's own pre-draw step),
// the path, the page's heading and where the page's box is scrolled.
function pageLogStart() {
  window.__pageLog = [];
  window.__pageLogOn = true;
  const box = () => { const m = document.querySelector('main.main'); return m && /auto|scroll/.test(getComputedStyle(m).overflowY) ? m : document.scrollingElement; };
  const read = () => { const b = box(); window.__pageLog.push({ path: location.pathname, h: ((document.querySelector('.main h1') || {}).textContent || '').trim().slice(0, 40), y: Math.round(b.scrollTop), room: Math.round(b.scrollHeight - b.clientHeight) }); };
  const tick = () => { if (!window.__pageLogOn) return; requestAnimationFrame(() => { setTimeout(read, 0); tick(); }); };
  tick();
}
function pageLogStop() { window.__pageLogOn = false; return window.__pageLog; }
// Run in the page: scroll the page's box to `to` at once (as a finger leaves it), and say where it is
// and how far it can go.
function pageBoxTo(to) {
  const m = document.querySelector('main.main');
  const box = m && /auto|scroll/.test(getComputedStyle(m).overflowY) ? m : document.scrollingElement;
  if (to != null) box.scrollTo({ top: to, behavior: 'instant' });
  return { y: Math.round(box.scrollTop), room: Math.round(box.scrollHeight - box.clientHeight) };
}
const pages = [];

// Run in the page (page.evaluate) at the phone size: which box scrolls, and can the reader reach the
// last thing on the page by scrolling it. The LAST element is the last one drawn in document order
// (not pinned by a fixed ancestor, and not parked outside an inner scroller of its own, which the
// reader scrolls separately). An overflow-hidden wrapper is NOT skipped: content it cuts off is
// content nobody can reach, which is the failure this looks for.
function phoneScrollProbe() {
  const d = document.documentElement;
  d.style.scrollBehavior = 'auto'; // html scrolls smoothly; a read straight after scrollTo would race it
  const se = document.scrollingElement || d;
  const locks = (el) => /hidden|clip/.test(getComputedStyle(el).overflowY);
  const pin = new Map();
  const pinned = (el) => {
    if (!el || el === d) return false;
    if (!pin.has(el)) pin.set(el, getComputedStyle(el).position === 'fixed' || pinned(el.parentElement));
    return pin.get(el);
  };
  const main = document.querySelector('.main');
  const root = document.getElementById('root') || document.body;
  const scope = main || root;
  const parkedInScroller = (el) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== scope; a = a.parentElement) {
      if (!/auto|scroll/.test(getComputedStyle(a).overflowY)) continue;
      const b = a.getBoundingClientRect();
      if (r.top >= b.bottom - 1 || r.bottom > b.bottom + 1) return true;
    }
    return false;
  };
  const drawn = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'contents') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) => el.tagName.toLowerCase()
    + (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '');
  const els = [...scope.querySelectorAll('*')].filter((el) => drawn(el) && !pinned(el));
  let last = null;
  for (let i = els.length - 1; i >= 0 && !last; i -= 1) if (!parkedInScroller(els[i])) last = els[i];
  const contentH = Math.round(Math.max(0, ...els.map((el) => el.getBoundingClientRect().bottom + se.scrollTop)));
  const docLocked = locks(d) || locks(document.body);
  if (main) main.scrollTop = main.scrollHeight;
  window.scrollTo(0, se.scrollHeight);
  const lb = last ? Math.round(last.getBoundingClientRect().bottom) : null;
  return {
    shell: !!main,
    docLocked,
    docScroll: Math.max(0, se.scrollHeight - se.clientHeight),
    docTop: Math.round(se.scrollTop),
    mainScrolls: !!main && /auto|scroll/.test(getComputedStyle(main).overflowY) && main.scrollHeight > main.clientHeight + 1,
    mainScroll: main ? main.scrollHeight - main.clientHeight : 0,
    mainTop: main ? Math.round(main.scrollTop) : 0,
    mainBottom: main ? Math.round(main.getBoundingClientRect().bottom) : null,
    rootH: Math.round(root.getBoundingClientRect().height),
    vh: window.innerHeight,
    last: last ? name(last) : null,
    lastBottom: lb,
    contentH,
  };
}

const res = await fetch(BASE).catch(() => null);
if (!res || !res.ok) {
  console.error(`\n✖ No dev server at ${BASE} (${res ? res.status : 'no response'}).`);
  console.error('  Start one:  npm --prefix app run dev -- --mode demo --port 5193\n');
  process.exit(2);
}

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  executablePath: LOCAL_CHROME,
  headless: true,
  args: ['--no-sandbox'],
});

const failures = [];
const innerScrollers = [];
const blanked = [];
const mismatched = [];
const vacuous = [];
const squeezedTabs = [];
const scrollingStrips = [];   // strips that scroll in place above a phone's width: listed for review, not a failure
const phone = [];

try {
  const page = await browser.newPage();
  for (const vp of PHONE_ONLY || REACH_ONLY || POPUPS_ONLY || PAGES_ONLY ? [] : VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h });
    for (const path of SWEEP) {
      // A `#preview` view: the same path with the office's preview flag set in this tab (the page is
      // already on the app's origin, from the routes before it); cleared again once it is checked.
      const previewView = path.endsWith('#preview');
      if (previewView) await page.evaluate((k, v) => sessionStorage.setItem(k, v), HUB_PREVIEW_STORAGE_KEY, JSON.stringify(PREVIEW_BUILDING));
      const bare = path.split('#')[0];
      await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 20000 });
      // The shell paints before lazy route chunks land; wait for real content or move on.
      if (!SHELL_LESS.has(bare)) await page.waitForFunction(() => document.querySelector('.main')?.childElementCount > 0, { timeout: 5000 }).catch(() => {});
      if (DEMO_PATHS.has(bare) && await page.evaluate(missingRecord)) vacuous.push({ vp: `${vp.w}px`, path });
      if (previewView) {
        // A preview view without its banner was swept as something else: it proves nothing.
        const banner = () => /^Preview: /.test(document.querySelector('.hub-preview[aria-label="Preview"]')?.innerText || '');
        await page.waitForFunction(banner, { timeout: 5000 }).catch(() => {});
        if (!(await page.evaluate(banner))) noBanner.push({ vp: `${vp.w}px`, path });
      }
      const r = await page.evaluate((exempt) => {
        const d = document.documentElement;
        const over = d.scrollWidth - d.clientWidth;
        let worst = null;
        if (over > 0) {
          const els = [...document.querySelectorAll('.main *')]
            .map((el) => ({ el, by: Math.round(el.getBoundingClientRect().right - d.clientWidth) }))
            .filter((x) => x.by > 1).sort((a, b) => b.by - a.by);
          if (els[0]) {
            const e = els[0].el;
            const cls = typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            worst = e.tagName.toLowerCase() + cls + ' +' + els[0].by + 'px';
          }
        }
        const inner = [...document.querySelectorAll('.main *')].filter((el) => {
          const cs = getComputedStyle(el);
          return /auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
        }).map((el) => ({
          cls: typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '?',
          by: el.scrollWidth - el.clientWidth,
        })).filter((x) => !exempt.some((p) => new RegExp(p).test(x.cls)));

        // 🔴 BLANKED SURFACES — the failure this harness was blind to on 2026-07-29.
        // The card-list treatment hides a table and shows cards instead. If the hide
        // lands but the cards do not, the route renders NOTHING and every other check
        // here PASSES: an element that is display:none has no box, so it cannot
        // overflow the page and cannot side-scroll. The sweep called 375px "nearly
        // clean" while 11 routes were empty. Counting rows on both sides is the only
        // way to tell "re-shaped correctly" apart from "deleted".
        const hidden = [...document.querySelectorAll('.main .table-wrap')]
          .filter((el) => getComputedStyle(el).display === 'none');
        // Skip totals rows on BOTH sides. Most tables foot themselves with <tfoot>, which
        // `tbody tr` already excludes — but ChangeOrderDetail puts its total row inside
        // <tbody> with a `co-total-row` class, so a straight row count read 3 against 2
        // real records and reported a parity bug that was not one.
        const rowsHidden = hidden.reduce(
          (n, el) => n + el.querySelectorAll('tbody tr:not([class*="total"])').length, 0);
        // `.pay-cards` is the Payroll/HR module's bespoke card list (its rich pay cards,
        // not the shared `.mobile-card-list`). Count it as a valid table replacement too,
        // else /payroll + /hr false-flag as BLANKED even though they render full-width cards.
        const shownLists = [...document.querySelectorAll('.main .mobile-card-list, .main .pay-cards')]
          .filter((el) => getComputedStyle(el).display !== 'none');
        // Count CHILDREN, not `.mobile-card`. Several tables carry their empty state as
        // a row inside <tbody> ("No quotes yet…"); the card list mirrors that as a plain
        // message div. Counting only cards would call a correctly-rendered empty list
        // blank and cry wolf on every seeded-empty surface.
        const cardsShown = shownLists.reduce((n, el) => n + el.childElementCount, 0);
        // `.mc-total` is the card shape of a <tfoot> — a summary, not a record. Counting
        // it as one puts every totalled list permanently one card over its row count.
        const realCards = shownLists.reduce(
          (n, el) => n + el.querySelectorAll('.mobile-card:not(.mc-total), .pay-card').length, 0);
        // 🔴 A TAB'S WORDS STAY IN ITS TAB (UI_RULES §184, CS-955, CS-956). A segment squeezed under its
        // words draws them over the next one while the page still FITS: every check above passed
        // Supplies' status tabs, HR's tabs and a customer's Activity tabs at 820 and 1024 while their
        // words ran into each other (the app's `* { min-width: 0 }` let an equal column shrink).
        // Measured from the words' own boxes, on both sides: a tab centres what overflows it, so its scrollWidth sees
        // only the right half (Supplies' "Pending approval 2" at 320 ran 2.3px past each edge and read as 2px).
        const pastEdge = (el) => {
          const box = el.getBoundingClientRect();
          let past = 0;
          for (const n of el.childNodes) {
            let rects = [];
            if (n.nodeType === 3 && n.textContent.trim()) {
              const rg = document.createRange();
              rg.selectNodeContents(n);
              rects = [...rg.getClientRects()];
            } else if (n.nodeType === 1 && !/absolute|fixed/.test(getComputedStyle(n).position)) {
              rects = [n.getBoundingClientRect()];
            }
            for (const q of rects) if (q.width) past = Math.max(past, q.right - box.right, box.left - q.left);
          }
          return past;
        };
        const squeezed = [...document.querySelectorAll('.main .tab-btn, .main .segmented-btn, .main .inbox-toggle-btn')]
          .filter((el) => el.clientWidth > 0)
          .map((el) => ({ el, past: pastEdge(el) }))
          .filter(({ el, past }) => past > 0.5 || el.scrollWidth > el.clientWidth + 1)
          .map(({ el, past }) => `"${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)}" ${el.clientWidth}px, its words ${Math.max(past, el.scrollWidth - el.clientWidth).toFixed(1)}px past its edge`);
        // ...and a strip scrolls in place only when its row has no room for it. A strip in a flex row is shrunk
        // with its neighbours (`* { min-width: 0 }`), so one could scroll while the field beside it had room to
        // give: Quick start's Admin | Crew got 89px of its 144 beside its search at 820. A strip that scrolls while
        // its row's neighbours could give up the difference (each down to its min-content) is cut for nothing.
        const cramped = [];
        const scrolling = [];
        for (const el of document.querySelectorAll('.main .tab-container-line, .main .segmented, .main .messaging-inbox-toggle')) {
          if (!el.clientWidth || el.scrollWidth <= el.clientWidth + 1) continue;
          const deficit = el.scrollWidth - el.clientWidth;
          const label = `"${[...el.children].map((c) => c.textContent.trim().replace(/\s+/g, ' ')).join(' | ').slice(0, 48)}"`;
          scrolling.push(`${label} by ${deficit}px`);
          const row = el.parentElement;
          const cs = row && getComputedStyle(row);
          if (!cs || !/flex/.test(cs.display) || !cs.flexDirection.startsWith('row') || cs.flexWrap !== 'nowrap') continue;
          let spare = 0;
          for (const sib of row.children) {
            if (sib === el || !sib.getClientRects().length || /absolute|fixed/.test(getComputedStyle(sib).position)) continue;
            const was = sib.getBoundingClientRect().width;
            const keep = [sib.style.flex, sib.style.width, sib.style.minWidth, sib.style.maxWidth];
            sib.style.flex = 'none'; sib.style.width = 'min-content'; sib.style.minWidth = '0'; sib.style.maxWidth = 'none';
            const min = sib.getBoundingClientRect().width;
            [sib.style.flex, sib.style.width, sib.style.minWidth, sib.style.maxWidth] = keep;
            spare += Math.max(0, was - min);
          }
          if (spare >= deficit) cramped.push(`${label} scrolls ${deficit}px with ${Math.round(spare)}px to spare beside it`);
        }
        return { over, worst, inner, squeezed, cramped, scrolling, rowsHidden, cardsShown, realCards, tablesHidden: hidden.length };
      }, INNER_SCROLL_EXEMPT.map((r) => r.source));

      if (r.over > 0) failures.push({ vp: `${vp.w}px`, path, over: r.over, worst: r.worst });
      // A phone's width: the menu bar is never hidden with no pop-up open (see POPUP_PROBES).
      if (vp.w <= 640) {
        const b = await page.evaluate(barState);
        if (b.hidden && !b.drawn.length) barHidden.push({ vp: `${vp.w}px`, path });
      }
      if (r.inner.length) innerScrollers.push({ vp: `${vp.w}px`, path, inner: r.inner });
      if (r.squeezed.length) squeezedTabs.push({ vp: `${vp.w}px`, path, tabs: r.squeezed });
      if (r.cramped.length) squeezedTabs.push({ vp: `${vp.w}px`, path, tabs: r.cramped });
      if (r.scrolling.length && vp.w > 640) scrollingStrips.push({ vp: `${vp.w}px`, path, strips: r.scrolling });
      if (r.rowsHidden > 0 && r.cardsShown === 0) {
        blanked.push({ vp: `${vp.w}px`, path, rows: r.rowsHidden, tables: r.tablesHidden });
      } else if (r.rowsHidden > 0 && r.realCards > 0 && r.realCards !== r.rowsHidden) {
        // Both surfaces render, but not the same number of records. Usually a card list
        // mapping a different array than the table's pager — a data-parity bug you cannot
        // see in a screenshot because both halves look plausible on their own.
        mismatched.push({ vp: `${vp.w}px`, path, rows: r.rowsHidden, cards: r.realCards });
      }
      if (SHOTS) {
        const slug = path === '/' ? 'root' : path.replace(/^\//, '').replace(/[/#]/g, '-');
        const dir = SHOTS_DIR + vp.w + 'px';
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: dir + '/' + slug + '.png', fullPage: true });
        shots.push({ vpW: vp.w, path, file: vp.w + 'px/' + slug + '.png' });
      }
      if (previewView) await page.evaluate((k) => sessionStorage.removeItem(k), HUB_PREVIEW_STORAGE_KEY);
    }
    process.stdout.write(`  ${String(vp.w).padStart(4)}px  ${SWEEP.length} routes  ${vp.label}\n`);
  }

  // 🔴 PHONE SCROLL — which box scrolls (see the header). Not in --shots mode (a gallery, not a gate).
  if (!SHOTS && !REACH_ONLY && !POPUPS_ONLY && !PAGES_ONLY) {
    await page.setViewport({ width: PHONE.w, height: PHONE.h });
    const fmt = (n) => Number(n).toLocaleString('en-US');
    for (const path of [...SHELL_LESS, ...PHONE_SHELL_PROBES]) {
      const office = PHONE_SHELL_PROBES.includes(path);
      if (office && !ROUTES.includes(path)) {
        phone.push({ path, ok: false, why: `${path} is no longer a route App.jsx declares; pick another long office page for PHONE_SHELL_PROBES` });
        continue;
      }
      await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 20000 });
      if (office) await page.waitForFunction(() => document.querySelector('.main')?.childElementCount > 0, { timeout: 5000 }).catch(() => {});
      else {
        // A public page fetches its record after it mounts: wait until it says more than "Loading…".
        await page.waitForFunction(() => {
          const t = (document.getElementById('root')?.innerText || '').trim();
          return t.length > 0 && !/^Loading\b/.test(t);
        }, { timeout: 8000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 300));
      const where = new URL(page.url()).pathname;
      const r = await page.evaluate(phoneScrollProbe);
      if (office) {
        const why = [];
        if (!r.shell) why.push(`no .main at ${where}: the office shell did not render`);
        if (!r.docLocked) why.push('html/body scroll as a document (the shell\'s lock is gone)');
        if (r.docScroll > 1 || r.docTop > 0) why.push(`the document scrolls ${fmt(r.docScroll)}px (the nav would float in the iOS PWA)`);
        if (!r.mainScrolls || r.mainTop <= 0) why.push(`.main does not scroll (overflow ${fmt(r.mainScroll)}px, scrolled ${r.mainTop}px)`);
        if (Math.abs(r.rootH - r.vh) > 1) why.push(`#root is ${r.rootH}px, not the ${r.vh}px screen`);
        if (r.lastBottom != null && r.mainBottom != null && r.lastBottom > r.mainBottom + 1) why.push(`its last element ${r.last} ends at ${fmt(r.lastBottom)}px, below .main`);
        phone.push({ path: `${path} (office shell)`, ok: !why.length, why: why.join(' · '),
          note: `document locked · .main scrolls ${fmt(r.mainScroll)}px · #root = ${r.rootH}px · last element ${r.last} reached` });
      } else if (r.shell) {
        // A shell-less path that rendered INSIDE the shell: a redirect in this mode (the customer hub
        // sends a staff or demo session to the office app), or a route this build doesn't have.
        phone.push({ path, skip: true, note: `rendered inside the office shell here (${where}): nothing outside it to drive` });
      } else {
        const why = [];
        if (r.docLocked) why.push('html/body overflow hidden: the document can\'t scroll');
        if (!r.last) why.push('nothing drawn on the page');
        else if (r.lastBottom > r.vh + 1) why.push(`its last element ${r.last} ends at ${fmt(r.lastBottom)}px, below the ${r.vh}px screen (content ${fmt(r.contentH)}px)`);
        phone.push({ path, ok: !why.length, why: why.join(' · '),
          note: r.docScroll > 1
            ? `document scrolls ${fmt(r.docScroll)}px · last element ${r.last} on screen`
            : `fits the screen (content ${fmt(r.contentH)}px) · document free to scroll · last element ${r.last} on screen` });
      }
    }
    process.stdout.write(`  ${PHONE.w}px  ${SHELL_LESS.size + PHONE_SHELL_PROBES.length} routes  phone scroll: which box scrolls\n`);
  }

  // 🔴 REACH (see REACH_PROBES): each control at each width. Not in --shots or --phone mode.
  if (!SHOTS && !PHONE_ONLY && !POPUPS_ONLY && !PAGES_ONLY) {
    for (const vp of REACH_VIEWPORTS) {
      await page.setViewport({ width: vp.w, height: vp.h });
      for (const probe of REACH_PROBES) {
        await page.goto(BASE + probe.path, { waitUntil: 'networkidle2', timeout: 20000 });
        await page.waitForSelector(probe.sel, { timeout: 5000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        let r = await page.evaluate(reachProbe, probe.sel);
        // A toast passing over the control is not the layout: look once more after it has gone.
        const fine = (x) => x.found && x.drawn && x.onScreen && !x.clippedBy && x.topmost && !(x.contextRight > x.vw + 1);
        if (!fine(r)) { await new Promise((res) => setTimeout(res, 2500)); r = await page.evaluate(reachProbe, probe.sel); }
        const why = [];
        if (!r.found || !r.drawn) why.push(`${probe.what} is not drawn (${probe.sel})`);
        else {
          if (!r.onScreen) why.push(`${probe.what} sits at x ${r.left}–${r.right} on a ${r.vw}px screen`);
          if (r.clippedBy) why.push(`${probe.what} is cut off by .${r.clippedBy} (x ${r.left}–${r.right})`);
          if (!r.topmost) why.push(`${probe.what} is covered by .${r.covering || '?'}`);
        }
        if (r.contextRight != null && r.contextRight > r.vw + 1) why.push(`the context pane ends at x ${r.contextRight} on a ${r.vw}px screen`);
        reach.push({ vp: `${vp.w}px`, path: probe.path, ok: !why.length, why: why.join(' · '), note: r.found ? `${probe.what} at x ${r.left}–${r.right}` : '' });
      }
    }
    process.stdout.write(`  reach  ${REACH_PROBES.length} controls × ${REACH_VIEWPORTS.length} widths (${REACH_VIEWPORTS.map((v) => v.w).join(', ')})\n`);
  }

  // 🔴 POP-UPS ON A PHONE (see POPUP_PROBES). Not in --shots, --phone, --reach or --pages mode.
  if (!SHOTS && !PHONE_ONLY && !REACH_ONLY && !PAGES_ONLY) {
    // Long enough for a panel's slide in (350ms) or out (200ms) and the bar's (200ms) to land.
    const settle = () => new Promise((res) => setTimeout(res, 700));
    for (const vp of POPUP_VIEWPORTS) {
      await page.setViewport({ width: vp.w, height: vp.h });
      for (const probe of POPUP_PROBES) {
        const why = [];
        let note = '';
        await page.goto(BASE + probe.path, { waitUntil: 'networkidle2', timeout: 20000 });
        await page.waitForSelector(probe.open, { timeout: 8000 }).catch(() => {});
        await new Promise((res) => setTimeout(res, 300));
        const before = await page.evaluate(barState);
        if (!before.list) why.push('no POP-UP LIST rule in the page\'s stylesheet');
        if (!before.bar) why.push('no menu bar on the page');
        else if (before.hidden && !before.drawn.length) why.push('the menu bar is hidden with no pop-up open');
        // The first match a finger can see (a phone may draw a list as cards and hide its table).
        const openers = await page.$$(probe.open);
        let opener = null;
        for (const h of openers) {
          if (await h.evaluate((el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')) { opener = h; break; }
        }
        if (!opener) why.push(`nothing opens ${probe.what} (${probe.open}: ${openers.length} on the page, none drawn)`);
        else {
          await opener.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await opener.click().catch((e) => why.push(`could not tap what opens ${probe.what}: ${e.message}`));
          await page.waitForSelector(probe.panel, { timeout: 5000 }).catch(() => {});
          await settle();
          const open = await page.evaluate(barState);
          let r = await page.evaluate(popupProbe, probe.panel);
          // A toast passing over a button is not the layout: look once more after it has gone.
          if (r.found && r.covered.length) { await new Promise((res) => setTimeout(res, 2500)); r = await page.evaluate(popupProbe, probe.panel); }
          if (!r.found) why.push(`${probe.what} did not open (${probe.panel})`);
          else {
            if (open.showing) why.push(`the menu bar still shows over ${probe.what}`);
            if (!r.checked) why.push(`${probe.what} has no button to check`);
            if (r.covered.length) why.push(`covered: ${r.covered.join(' · ')}`);
            // Its × closes it with a real tap: it leaves the page and the bar comes back.
            const x = await page.$(`${probe.panel} .modal-close`);
            if (!x) why.push(`${probe.what} has no × to close it`);
            else {
              await x.click().catch((e) => why.push(`could not tap its ×: ${e.message}`));
              await settle();
              const after = await page.evaluate(barState);
              if (await page.$(probe.panel)) why.push(`${probe.what} is still on the page after its × closed it`);
              if (after.showing < 2) why.push('the menu bar did not come back once it closed');
            }
            note = `${r.checked} buttons on top, the bar away while open and back after`;
          }
        }
        popups.push({ vp: `${vp.w}px`, path: probe.path, what: probe.what, ok: !why.length, why: why.join(' · '), note });
      }
    }
    process.stdout.write(`  popups ${POPUP_PROBES.length} pop-ups × ${POPUP_VIEWPORTS.length} phone sizes (${POPUP_VIEWPORTS.map((v) => `${v.w}×${v.h}`).join(', ')})\n`);
  }

  // 🔴 WHERE A PAGE OPENS (see PAGE_PROBES). Not in --shots, --phone, --reach or --popups mode.
  if (!SHOTS && !PHONE_ONLY && !REACH_ONLY && !POPUPS_ONLY) {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    // One step: log frames, act, wait for the page that `arrived` names (a path test, in the page) to
    // be up with its heading, let it settle, and keep the frames that show that page by its heading.
    const step = async (act, arrived) => {
      await page.evaluate(pageLogStart);
      await act();
      await page.waitForFunction(`(${arrived})(location.pathname) && !!document.querySelector('.main h1')`, { timeout: 8000 }).catch(() => {});
      await wait(900);
      const frames = await page.evaluate(pageLogStop);
      const now = await page.evaluate(() => ({ path: location.pathname, h: ((document.querySelector('.main h1') || {}).textContent || '').trim().slice(0, 40) }));
      return { ...now, frames: frames.filter((f) => f.path === now.path && f.h === now.h) };
    };
    // Every frame of the arriving page at `y`, at least one of them; else why not. A frame as far down
    // as the page then goes counts (a page that fills in after its first frame is shorter until it has).
    const held = (label, s, y) => {
      if (!s.frames.length) return `${label}: no frame showed the page`;
      const off = s.frames.filter((f) => Math.abs(f.y - y) > 1 && !(f.room < y && Math.abs(f.y - f.room) <= 1));
      return off.length ? `${label}: ${off.length} of ${s.frames.length} frames off ${y}px (${[...new Set(off.map((f) => f.y))].slice(0, 4).join(', ')}px)` : '';
    };
    for (const vp of PAGE_VIEWPORTS) {
      await page.setViewport({ width: vp.w, height: vp.h });
      for (const probe of PAGE_PROBES) {
        const why = [];
        let note = '';
        await page.goto(BASE + probe.list, { waitUntil: 'networkidle2', timeout: 20000 });
        await page.waitForSelector(probe.open, { timeout: 8000 }).catch(() => {});
        await wait(400);
        const { room } = await page.evaluate(pageBoxTo, null);
        if (room < 200) why.push(`${probe.list} scrolls only ${room}px at ${vp.w}×${vp.h}, too little to show where a page opens`);
        else {
          const listY = (await page.evaluate(pageBoxTo, Math.min(600, room - 100))).y;
          await wait(300); // its scroll lands, and the place is kept
          // A row on the screen, opened by the app's own click once the log runs (a tap scrolls nothing either).
          const found = await page.evaluate((sel) => {
            const row = [...document.querySelectorAll(sel)].find((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top > 120 && r.bottom < innerHeight - 120; });
            if (row) row.setAttribute('data-page-probe', '');
            return !!row;
          }, probe.open);
          if (!found) why.push(`no ${probe.open} on the screen at ${listY}px`);
          else {
            const list = probe.list;
            const opened = await step(() => page.evaluate(() => document.querySelector('[data-page-probe]').click()), `(p) => p !== ${JSON.stringify(list)}`);
            const a = held('opened', opened, 0);
            if (a) why.push(a);
            const { room: itsRoom } = await page.evaluate(pageBoxTo, null);
            const itsY = (await page.evaluate(pageBoxTo, Math.min(150, itsRoom))).y;
            await wait(300);
            const back = await step(() => page.goBack({ timeout: 5000 }).catch(() => null), `(p) => p === ${JSON.stringify(list)}`);
            const b = held('Back', back, listY);
            if (b) why.push(b);
            const forward = await step(() => page.goForward({ timeout: 5000 }).catch(() => null), `(p) => p === ${JSON.stringify(opened.path)}`);
            const c = held('Forward', forward, itsY);
            if (c) why.push(c);
            const pill = await step(() => page.evaluate((sel) => { const a = document.querySelector(sel); if (a) a.click(); return !!a; }, probe.back), `(p) => p === ${JSON.stringify(list)}`);
            const d = held('its ← Back', pill, listY);
            if (d) why.push(d);
            note = `list at ${listY}px · opened at 0 in ${opened.frames.length} frames · Back at ${listY} in ${back.frames.length} · Forward at ${itsY} in ${forward.frames.length} · ← Back at ${listY} in ${pill.frames.length}`;
          }
        }
        pages.push({ vp: `${vp.w}px`, what: probe.what, ok: !why.length, why: why.join(' · '), note });
      }
    }
    process.stdout.write(`  pages  ${PAGE_PROBES.length} page change(s) × ${PAGE_VIEWPORTS.length} sizes (${PAGE_VIEWPORTS.map((v) => `${v.w}×${v.h}`).join(', ')})\n`);
  }
} finally {
  await browser.close();
}

if (SHOTS) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const byVp = VIEWPORTS.map((vp) => ({ vp, items: shots.filter((s) => s.vpW === vp.w) }));
  const tabs = byVp.map((g, i) => `<button class="tab${i === 0 ? ' on' : ''}" data-vp="${g.vp.w}">${g.vp.w}px</button>`).join('');
  const panels = byVp.map((g, i) => `<section class="panel" data-vp="${g.vp.w}"${i === 0 ? '' : ' hidden'}>
    <p class="lbl">${g.vp.w}×${g.vp.h} — ${esc(g.vp.label)} · ${g.items.length} screens</p>
    <div class="grid" style="--w:${Math.min(g.vp.w, 260)}px">
    ${g.items.map((s) => `<figure><a href="${s.file}" target="_blank" rel="noreferrer"><img loading="lazy" src="${s.file}" alt="${esc(s.path)}"></a><figcaption>${esc(s.path)}</figcaption></figure>`).join('')}
    </div></section>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mobile contact sheet — Clean Space</title>
<style>body{font:14px system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;background:#f4f4f5;color:#18181b}
header{padding:14px 18px;background:#18181b;color:#fff;position:sticky;top:0;z-index:2}
header h1{margin:0 0 9px;font-size:15px;font-weight:700} header .sub{font-weight:400;opacity:.7}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tab{border:0;border-radius:999px;padding:6px 14px;font:600 12px system-ui;cursor:pointer;background:#3f3f46;color:#e4e4e7}
.tab.on{background:#FFD45A;color:#18181b}
.lbl{padding:2px 18px;color:#52525b;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--w),1fr));gap:14px;padding:8px 18px 24px}
figure{margin:0;background:#fff;border:1px solid #d4d4d8;border-radius:8px;overflow:hidden}
figure img{display:block;width:100%;height:auto;max-height:540px;object-fit:cover;object-position:top;border-bottom:1px solid #ececec;background:#fff}
figcaption{padding:6px 9px;font:600 11px ui-monospace,Menlo,Consolas,monospace;color:#3f3f46;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<header><h1>📱 Mobile contact sheet <span class="sub">every route × viewport · thumbnails crop to the top 540px · click to open full · regenerate with <code>npm run shots</code></span></h1><div class="tabs">${tabs}</div></header>
${panels}
<script>document.querySelector('.tabs').addEventListener('click',function(e){var b=e.target.closest('.tab');if(!b)return;document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('on',t===b);});document.querySelectorAll('.panel').forEach(function(p){p.hidden=p.dataset.vp!==b.dataset.vp;});});</script>
</body></html>`;
  writeFileSync(SHOTS_DIR + 'index.html', html);
  console.log(`\n  📸 contact sheet → ${SHOTS_DIR}index.html`);
  console.log(`     ${shots.length} shots · ${SWEEP.length} routes × ${VIEWPORTS.length} viewports\n`);
  process.exit(0);
}

const phoneFails = phone.filter((p) => p.ok === false);
const reachFails = reach.filter((p) => p.ok === false);
const popupFails = popups.filter((p) => p.ok === false);
const pageFails = pages.filter((p) => p.ok === false);
if (PHONE_ONLY) console.log(`\nresponsive-sweep --phone — ${phone.length} routes at ${PHONE.w}×${PHONE.h}\n`);
else if (REACH_ONLY) console.log(`\nresponsive-sweep --reach — ${reach.length} reach checks\n`);
else if (POPUPS_ONLY) console.log(`\nresponsive-sweep --popups — ${popups.length} pop-up checks\n`);
else if (PAGES_ONLY) console.log(`\nresponsive-sweep --pages — ${pages.length} page checks\n`);
else console.log(`\nresponsive-sweep — ${SWEEP.length} routes × ${VIEWPORTS.length} viewports = ${SWEEP.length * VIEWPORTS.length} checks, + ${phone.length} phone scroll checks, + ${reach.length} reach checks, + ${popups.length} pop-up checks, + ${pages.length} page checks\n`);

if (phone.length) {
  console.log(`  Phone scroll at ${PHONE.w}×${PHONE.h} — outside the office shell the DOCUMENT scrolls to the last line;`);
  console.log('  inside it the document stays put and .main scrolls (UI_RULES §106):\n');
  for (const p of phone) {
    const mark = p.skip ? '–' : p.ok ? '✓' : '✗';
    console.log(`    ${mark} ${p.path.padEnd(48)} ${p.ok === false ? p.why : p.note}`);
  }
  console.log('');
}

if (reach.length) {
  console.log('  Reach — the control to tap is on the screen, inside its box and on top (UI_RULES §164):\n');
  for (const p of reach) console.log(`    ${p.ok ? '✓' : '✗'} ${p.vp.padStart(6)}  ${p.path.padEnd(46)} ${p.ok ? p.note : p.why}`);
  console.log('');
}

if (popups.length) {
  console.log('  Pop-ups on a phone — the menu bar steps away, every button is what a finger hits, and it comes back (UI_RULES §105):\n');
  for (const p of popups) console.log(`    ${p.ok ? '✓' : '✗'} ${p.vp.padStart(6)}  ${p.what.padEnd(44)} ${p.ok ? p.note : p.why}`);
  console.log('');
}

if (pages.length) {
  console.log('  Where a page opens — at its top from its first frame, and Back and Forward where it was (UI_RULES §186):\n');
  for (const p of pages) console.log(`    ${p.ok ? '✓' : '✗'} ${p.vp.padStart(6)}  ${p.what.padEnd(36)} ${p.ok ? p.note : p.why}`);
  console.log('');
}

if (barHidden.length) {
  console.log('  ✗ MENU BAR HIDDEN WITH NO POP-UP OPEN — a class from index.css\'s POP-UP LIST is on the page while nothing is open,');
  console.log('    so the bar would never come back. A pop-up\'s outermost layer is on the page only while it is open (UI_RULES §105).\n');
  for (const b of barHidden) console.log(`    ${b.vp.padStart(6)}  ${b.path}`);
  console.log('');
}

if (REPORT && innerScrollers.length) {
  console.log('  Inner side-scrollers (NOT a failure — the page fits, a table inside it does not).');
  console.log('  On a touch device these are the panels Steve has to swipe sideways:\n');
  for (const s of innerScrollers) console.log(`    ${s.vp.padStart(6)}  ${s.path.padEnd(34)} ${s.inner.map((i) => i.cls + ' +' + i.by + 'px').join(' · ')}`);
  console.log('');
}

if (blanked.length) {
  console.log('  ✗ BLANKED SURFACES — a table is hidden and no card list replaced it.');
  console.log('    These routes render EMPTY at this width. Give the surface a');
  console.log('    .mobile-card-list, or drop .has-mobile-cards and let it side-scroll.\n');
  for (const b of blanked) {
    console.log(`    ${b.vp.padStart(6)}  ${b.path.padEnd(34)} ${b.rows} row(s) in ${b.tables} hidden table(s)`);
  }
  console.log('');
}

if (mismatched.length) {
  console.log('  ⚠ ROW/CARD COUNT MISMATCH — both shapes render, but not the same records.');
  console.log('    Check the card list maps the SAME pager rows as the table.\n');
  for (const m of mismatched) {
    console.log(`    ${m.vp.padStart(6)}  ${m.path.padEnd(34)} table ${m.rows} row(s) · cards ${m.cards}`);
  }
  console.log('');
}

if (vacuous.length) {
  console.log('  ✗ DEMO PAGES WITHOUT THEIR RECORD — the page says "not found", so it was swept empty.');
  console.log('    Fix the demo id in scripts/app-routes.mjs PARAMS.\n');
  for (const v of vacuous) console.log(`    ${v.vp.padStart(6)}  ${v.path}`);
  console.log('');
}

if (noBanner.length) {
  console.log('  ✗ PREVIEW VIEWS WITHOUT THE PREVIEW — the hub did not show the office\'s preview banner, so it was swept as something else.\n');
  for (const v of noBanner) console.log(`    ${v.vp.padStart(6)}  ${v.path}`);
  console.log('');
}

if (scrollingStrips.length) {
  console.log('  · Strips scrolling in place above a phone\'s width (UI_RULES §184; not a failure: each should be a row too long for its room).\n');
  for (const q of scrollingStrips) console.log(`    ${q.vp.padStart(6)}  ${q.path.padEnd(34)} ${q.strips.join(' · ')}`);
  console.log('');
}

if (squeezedTabs.length) {
  console.log('  ✗ TABS SQUEEZED UNDER THEIR WORDS — the words run into the next tab, or a strip scrolls while its row has room (UI_RULES §184).');
  console.log('    A segment is never narrower than its words: minmax(max-content, 1fr), or a row that scrolls only when it must.\n');
  for (const q of squeezedTabs) console.log(`    ${q.vp.padStart(6)}  ${q.path.padEnd(34)} ${q.tabs.join(' · ')}`);
  console.log('');
}

if (!failures.length && !blanked.length && !vacuous.length && !phoneFails.length && !noBanner.length && !reachFails.length && !squeezedTabs.length && !popupFails.length && !barHidden.length && !pageFails.length) {
  if (REACH_ONLY) console.log('  Every control is in reach at every width. ✓\n');
  else if (POPUPS_ONLY) console.log('  Every pop-up is clear of the menu bar on a phone. ✓\n');
  else if (PAGES_ONLY) console.log('  Every page opens at its top, and Back and Forward put it where it was. ✓\n');
  else console.log(PHONE_ONLY ? '  Every page scrolls in the right box on a phone. ✓\n' : '  No horizontal scroll at any viewport, every page scrolls in the right box on a phone, and every control is in reach. ✓\n');
  process.exit(0);
}
for (const f of failures) {
  console.log(`  ✗ ${f.vp.padStart(6)}  ${f.path}`);
  console.log(`        page overflows by ${f.over}px — widest offender: ${f.worst || 'unknown'}`);
}
const parts = [];
if (failures.length) parts.push(`${failures.length} route/viewport combination(s) scroll horizontally`);
if (blanked.length) parts.push(`${blanked.length} render blank`);
if (vacuous.length) parts.push(`${vacuous.length} demo page(s) without their record`);
if (noBanner.length) parts.push(`${noBanner.length} preview view(s) without the preview`);
if (phoneFails.length) parts.push(`${phoneFails.length} page(s) scroll in the wrong box on a phone`);
if (reachFails.length) parts.push(`${reachFails.length} control(s) out of reach`);
if (squeezedTabs.length) parts.push(`${squeezedTabs.length} route/viewport combination(s) squeeze a tab under its words`);
if (popupFails.length) parts.push(`${popupFails.length} pop-up check(s) failed on a phone`);
if (pageFails.length) parts.push(`${pageFails.length} page check(s) opened a page off its place`);
if (barHidden.length) parts.push(`${barHidden.length} page(s) hide the menu bar with no pop-up open`);
console.log(`\n${parts.join(' · ')} — FAIL\n`);
process.exit(1);
