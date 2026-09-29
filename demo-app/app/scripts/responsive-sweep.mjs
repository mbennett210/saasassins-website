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
// Usage (needs a dev server running — `--mode demo` gives seeded data and no login gate):
//   npm --prefix app run dev -- --mode demo --port 5193
//   node app/scripts/responsive-sweep.mjs                 # fail on any overflow
//   node app/scripts/responsive-sweep.mjs --url http://localhost:5193
//   node app/scripts/responsive-sweep.mjs --report        # also list inner side-scrollers
//
// CHROME_PATH overrides the browser, same env var api/_lib/quotes/render.js already uses.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appRoutes, publicRoutes, DEMO_PATHS, missingRecord } from './app-routes.mjs';

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

// A board is a board: the Kanban scrolls sideways BY DESIGN and always will. Exempting it
// by name is honest; letting it fail and teaching everyone to ignore the run is not.
const INNER_SCROLL_EXEMPT = [/pipeline-board/];

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

try {
  const page = await browser.newPage();
  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h });
    for (const path of ROUTES) {
      await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 20000 });
      // The shell paints before lazy route chunks land; wait for real content or move on.
      if (!SHELL_LESS.has(path)) await page.waitForFunction(() => document.querySelector('.main')?.childElementCount > 0, { timeout: 5000 }).catch(() => {});
      if (DEMO_PATHS.has(path) && await page.evaluate(missingRecord)) vacuous.push({ vp: `${vp.w}px`, path });
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
        return { over, worst, inner, rowsHidden, cardsShown, realCards, tablesHidden: hidden.length };
      }, INNER_SCROLL_EXEMPT.map((r) => r.source));

      if (r.over > 0) failures.push({ vp: `${vp.w}px`, path, over: r.over, worst: r.worst });
      if (r.inner.length) innerScrollers.push({ vp: `${vp.w}px`, path, inner: r.inner });
      if (r.rowsHidden > 0 && r.cardsShown === 0) {
        blanked.push({ vp: `${vp.w}px`, path, rows: r.rowsHidden, tables: r.tablesHidden });
      } else if (r.rowsHidden > 0 && r.realCards > 0 && r.realCards !== r.rowsHidden) {
        // Both surfaces render, but not the same number of records. Usually a card list
        // mapping a different array than the table's pager — a data-parity bug you cannot
        // see in a screenshot because both halves look plausible on their own.
        mismatched.push({ vp: `${vp.w}px`, path, rows: r.rowsHidden, cards: r.realCards });
      }
      if (SHOTS) {
        const slug = path === '/' ? 'root' : path.replace(/^\//, '').replace(/\//g, '-');
        const dir = SHOTS_DIR + vp.w + 'px';
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: dir + '/' + slug + '.png', fullPage: true });
        shots.push({ vpW: vp.w, path, file: vp.w + 'px/' + slug + '.png' });
      }
    }
    process.stdout.write(`  ${String(vp.w).padStart(4)}px  ${ROUTES.length} routes  ${vp.label}\n`);
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
  console.log(`     ${shots.length} shots · ${ROUTES.length} routes × ${VIEWPORTS.length} viewports\n`);
  process.exit(0);
}

console.log(`\nresponsive-sweep — ${ROUTES.length} routes × ${VIEWPORTS.length} viewports = ${ROUTES.length * VIEWPORTS.length} checks\n`);

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

if (!failures.length && !blanked.length && !vacuous.length) { console.log('  No horizontal scroll at any viewport. ✓\n'); process.exit(0); }
for (const f of failures) {
  console.log(`  ✗ ${f.vp.padStart(6)}  ${f.path}`);
  console.log(`        page overflows by ${f.over}px — widest offender: ${f.worst || 'unknown'}`);
}
const parts = [];
if (failures.length) parts.push(`${failures.length} route/viewport combination(s) scroll horizontally`);
if (blanked.length) parts.push(`${blanked.length} render blank`);
if (vacuous.length) parts.push(`${vacuous.length} demo page(s) without their record`);
console.log(`\n${parts.join(' · ')} — FAIL\n`);
process.exit(1);
