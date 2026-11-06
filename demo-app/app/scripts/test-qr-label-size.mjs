// QR-9 / QR-10 — the printed labels: every code at least 1¼ inches, the area's name right under it.
//
// Matt (2026-10-16). QR-10: "1¼ inches square or larger" ("Scans easily from about a foot away").
// QR-9: "…all the locations for that one property, with the name right below the QR code, so the
// person on site knows where to install it."
//
// THE MEASUREMENT RULE (stated in lib/scanCodes, held here). 1¼ in is the code ITSELF — its modules,
// edge to edge of the black squares, which is what the QR standard (ISO/IEC 18004) calls the symbol
// and what a ruler held to the label measures. The four-module white quiet zone is EXTRA, drawn inside
// the code's square, so the square is larger than 1¼ in. How much larger depends on how many modules
// the code has, and the fewest a scan link can ever have is QR_MIN_MODULES: §M2 PROVES that floor with
// the real `qrcode` library on the shortest web address and the tokens that pack tightest. Every square
// any layout draws is then at least QR_MIN_BOX_IN, which keeps the symbol at 1¼ in for EVERY link.
//
// WHAT IT HOLDS
//   §M  the minimum: the floor proved, every label format and every grid of the one-page sheet computed
//       FROM ITS OWN NUMBERS (Object.values(LABEL_FORMATS), every grid sheetGrid can choose — a future
//       format or grid is checked the day it is added), the document drawn at those sizes, the layouts
//       that could not hold the code and the name gone (Avery 22805, the 5 × 5 grid)
//   §N  the name right under the code, on every format and the grid: the order in the document, the
//       box it gets, never clipped (no clamp, no ellipsis, no hidden overflow), shrunk to fit by a pure
//       rule (fitText) and by the document's own measuring pass, then the building, then the logo
//
// REGRESSION (THE LAW II.3): on 90d7ca9e the codes are 0.86–1.72 in squares with no minimum, Avery
// 22805 prints a 0.86 in code, the 5 × 5 grid a 1.2 in one, the 2″ × 4″ label puts the name BESIDE the
// code, and names are clamped and ellipsised — the checks below report each.
//
//   node app/scripts/test-qr-label-size.mjs
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const imp = (rel) => import(pathToFileURL(path.join(APP, rel)).href).catch(() => ({}));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };

const codes = await imp('src/lib/scanCodes.js');
const scan = await imp('src/lib/areaScan.js');
const { IDENTITY } = await imp('src/brand/identity.generated.js');
const { DOC_LOGO } = await imp('src/brand/logo.js');
const { STANDARD_AREA_NAMES = [] } = await imp('src/lib/standardAreas.js');
const QRCode = (await import('qrcode').catch(() => ({}))).default || {};

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const fn = (name) => (typeof codes[name] === 'function' ? codes[name] : () => undefined);
const EPS = 1e-9;

const FORMATS = Object.values(codes.LABEL_FORMATS || {});
const MIN_IN = codes.QR_MIN_IN;
const FLOOR = codes.QR_MIN_MODULES;
const QUIET = codes.QR_QUIET_MODULES;
const MIN_BOX = codes.QR_MIN_BOX_IN;
const qrSymbolIn = fn('qrSymbolIn');
const buildScanSheetHtml = fn('buildScanSheetHtml');
const sheetGrid = fn('sheetGrid');
const sheetPages = fn('sheetPages');
const fitText = fn('fitText');
const CELLS = codes.SHEET_CELLS || {};
const HAS = Number.isFinite(MIN_BOX) && Number.isInteger(FLOOR) && FORMATS.length > 0;

// ── §M the minimum ───────────────────────────────────────────────────────────
ok('M1 the minimum is a named constant: 1¼ inches', MIN_IN === 1.25, String(MIN_IN));
ok('M1 …which is 90 points', MIN_IN * 72 === 90);
{
  // The fewest modules a scan link can have, PROVED: the shortest web address the app could be served
  // at, and the token shapes the library packs tightest (capitals and "-" as alphanumeric, digits as
  // numeric), plus the brand's own address and a random token as the real labels are.
  const origins = ['http://a', 'https://a.b', new URL(IDENTITY?.appUrl || 'https://x.y').origin, 'http://localhost:5213'];
  const rnd = () => { const b = new Uint8Array(24); webcrypto.getRandomValues(b); return scan.encodeScanToken ? scan.encodeScanToken(b) : null; };
  const tokens = ['A'.repeat(32), '7'.repeat(32), '-'.repeat(32), 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6', rnd(), rnd(), rnd()].filter(Boolean);
  const sizes = [];
  for (const o of origins) {
    for (const tk of tokens) {
      const url = typeof scan.scanUrl === 'function' ? scan.scanUrl(o, tk) : null;
      if (!url || typeof QRCode.create !== 'function') continue;
      sizes.push(QRCode.create(url, { errorCorrectionLevel: codes.QR_ERROR_CORRECTION }).modules.size);
    }
  }
  ok('M2 every scan link tried was encoded (the floor is tested, not assumed)', sizes.length === origins.length * tokens.length, `${sizes.length}`);
  ok('M2 no scan link has fewer modules than QR_MIN_MODULES', HAS && sizes.length > 0 && sizes.every((n) => n >= FLOOR), `${FLOOR} vs ${Math.min(...sizes)}`);
  ok('M2 …and the floor is reached (it is the true fewest, not a number picked low)', HAS && sizes.includes(FLOOR));
  const brand = sizes.length ? QRCode.create(scan.scanUrl(new URL(IDENTITY.appUrl).origin, rnd()), { errorCorrectionLevel: codes.QR_ERROR_CORRECTION }).modules.size : 0;
  ok('M2 the brand\'s own links are at or above the floor too', HAS && brand >= FLOOR, String(brand));
}
ok('M3 the smallest square any layout may draw is the 1¼ in symbol plus its quiet zone, at the floor',
  HAS && Math.abs(MIN_BOX - MIN_IN * (FLOOR + 2 * QUIET) / FLOOR) < EPS, `${MIN_BOX}`);
ok('M3 …so that square holds a 1¼ in symbol at the floor', HAS && Math.abs(qrSymbolIn(MIN_BOX, FLOOR) - MIN_IN) < EPS);
ok('M3 …and a larger code (more modules) is never smaller in the same square', HAS && qrSymbolIn(MIN_BOX, FLOOR + 8) > MIN_IN);
for (const f of FORMATS) {
  ok(`M4 ${f.key}: its code square (${f.qrIn} in) is at least QR_MIN_BOX_IN (${MIN_BOX?.toFixed?.(3)} in)`, HAS && f.qrIn >= MIN_BOX - EPS);
  ok(`M4 ${f.key}: …so its symbol is at least 1¼ in for every link`, HAS && qrSymbolIn(f.qrIn, FLOOR) >= MIN_IN - EPS);
  const inner = f.hIn - 2 * f.padIn;
  if (f.shape === 'wide') {
    ok(`M5 ${f.key} (wide): the code and the name under it fit the label's height`, f.qrIn + f.nameIn <= inner + EPS, `${f.qrIn} + ${f.nameIn} vs ${inner}`);
    ok(`M5 ${f.key} (wide): …and leave a column beside them for the building and the logo (≥ 1 in)`, f.wIn - 2 * f.padIn - f.qrIn - f.colGapIn >= 1 - EPS);
    ok(`M5 ${f.key} (wide): …whose building, line and logo fit its height`, f.bldgIn + f.lineIn + f.logoIn + 2 * f.gapIn <= inner + EPS);
  } else if (f.shape === 'tall') {
    ok(`M5 ${f.key} (tall): the code, the name, the building, the line and the logo stack inside the label`,
      f.qrIn + f.nameIn + f.bldgIn + f.lineIn + f.logoIn + 3 * f.gapIn <= inner + EPS, `${inner}`);
    ok(`M5 ${f.key} (tall): …and the code fits its width`, f.qrIn <= f.wIn - 2 * f.padIn + EPS);
  } else {
    ok(`M5 ${f.key}: has a shape the document knows how to draw`, false, String(f.shape));
  }
}
ok('M6 Avery 22805 is gone: a 1½″ square cannot hold a 1¼″ code with its quiet zone and a name under it', HAS && !('avery22805' in (codes.LABEL_FORMATS || {})));
ok('M6 …and an office that had picked it reads as the default sheet, never a broken one',
  HAS && fn('labelFormatKey')('avery22805') === codes.DEFAULT_LABEL_FORMAT && fn('isLabelFormat')('avery22805') === false);
{
  const seen = new Map();
  for (let n = 1; n <= 80; n += 1) { const g = sheetGrid(n); if (g?.cols) seen.set(g.cols, n); }
  ok('M7 the one-page sheet never draws more than four across (the 5 × 5 grid printed 1.2 in codes)', HAS && seen.size > 0 && Math.max(...seen.keys()) === codes.SHEET_MAX_COLS && codes.SHEET_MAX_COLS === 4);
  ok('M7 …so 25 areas take two pages (16 + 9)', HAS && (sheetPages(25) || []).length === 2 && (sheetPages(25) || [])[0]?.length === 16);
  for (const [cols, n] of seen) {
    const cell = (sheetPages(n) || [[]])[0][0] || {};
    const c = CELLS[cols] || {};
    const frame = 2 * ((c.padIn || 0) + (codes.SHEET_CUT_LINE_IN || 0));
    ok(`M7 grid ${cols} × ${cols}: its code square (${c.qrIn} in) is at least QR_MIN_BOX_IN`, HAS && c.qrIn >= MIN_BOX - EPS);
    ok(`M7 grid ${cols} × ${cols}: the code, the name (and the building and logo it shows) fit the cell`,
      HAS && c.qrIn + c.nameIn + (c.bldgIn || 0) + (c.logoIn || 0) + (c.gaps || 0) * (c.gapIn || 0) <= cell.hIn - frame + EPS && c.qrIn <= cell.wIn - frame + EPS,
      `${JSON.stringify(c)} in ${cell.wIn} × ${cell.hIn}`);
  }
}
// The document draws what the numbers say: every square in every print is at least the minimum.
const label = (lbl) => String(lbl || '');
const list = (n, names = null) => Array.from({ length: n }, (_, i) => {
  const token = String.fromCharCode(65 + (i % 26)).repeat(31) + String.fromCharCode(97 + Math.floor(i / 26));
  const url = `https://app-one.example/scan/${token}`;
  return { label: names ? names[i % names.length] : `Area ${i + 1}`, url, qr: QRCode.create ? QRCode.create(url, { errorCorrectionLevel: 'M' }) : null };
});
const squares = (html) => [...html.matchAll(/<svg class="qr"[^>]*\bwidth="([\d.]+)in"[^>]*\bheight="([\d.]+)in"/g)].map((m) => [Number(m[1]), Number(m[2])]);
for (const f of FORMATS) {
  const html = label(buildScanSheetHtml({ layout: 'labels', format: f.key, building: 'Coral Bay HOA', codes: list(3) }));
  const sq = squares(html);
  ok(`M8 ${f.key}: the printed squares are the layout's own (${f.qrIn} in), never under the minimum`,
    HAS && sq.length === 3 && sq.every(([w, h]) => Math.abs(w - f.qrIn) < 1e-3 && w === h && w >= MIN_BOX - 1e-6), JSON.stringify(sq));
}
for (const n of [1, 4, 9, 16, 17, 25]) {
  const html = label(buildScanSheetHtml({ layout: 'sheet', building: 'Coral Bay HOA', codes: list(n) }));
  const sq = squares(html);
  ok(`M8 the one-page sheet of ${n}: every square is at least the minimum`, HAS && sq.length === n && sq.every(([w, h]) => w === h && w >= MIN_BOX - 1e-6), JSON.stringify(sq.slice(0, 3)));
}

// ── §N the name right under the code ─────────────────────────────────────────
// Each label / cell, cut out of the document.
const pieces = (html, cls) => html.split(new RegExp(`(?=<div class="${cls} )`)).slice(1).map((s) => s.split(/(?=<div class="(?:lbl|cell) )|<\/div><\/body>/)[0]);
const NAMES = ['Lobby', 'Restrooms', 'Hall & stair floors'];
const prints = [
  ...FORMATS.map((f) => ({ what: f.key, cls: 'lbl', html: label(buildScanSheetHtml({ layout: 'labels', format: f.key, building: 'Coral Bay HOA', codes: list(3, NAMES) })) })),
  ...[4, 9, 16].map((n) => ({ what: `grid of ${n}`, cls: 'cell', html: label(buildScanSheetHtml({ layout: 'sheet', building: 'Coral Bay HOA', codes: list(n, NAMES) })) })),
];
for (const p of prints) {
  const ps = pieces(p.html, p.cls);
  ok(`N1 ${p.what}: every code is followed DIRECTLY by its area's name, in one column`,
    ps.length > 0 && ps.every((s) => /<div class="code"[^>]*><svg class="qr"[\s\S]*?<\/svg><div class="name"[^>]*>[^<]+<\/div>/.test(s)), (ps[0] || '').slice(0, 200));
  ok(`N1 ${p.what}: …the name is the area's own`, ps.length > 0 && ps.every((s, i) => s.includes(`>${NAMES[i % 3].replace('&', '&amp;')}</div>`)));
  ok(`N2 ${p.what}: the name comes before the building, and the building before the logo`,
    ps.length > 0 && ps.every((s) => {
      const n = s.indexOf('class="name"'); const b = s.indexOf('class="bldg"'); const l = s.indexOf('class="logo"');
      return n > 0 && (b === -1 || b > n) && (l === -1 || (l > n && (b === -1 || l > b)));
    }));
}
{
  const f = codes.LABEL_FORMATS?.avery5163 || {};
  const html = label(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', codes: list(1) }));
  ok('N2 the 2″ × 4″ label: the name sits UNDER the code (it sat beside it), the building and the logo beside the two',
    /<div class="code"[^>]*>[\s\S]*?<\/div><div class="more">[\s\S]*?class="bldg"[\s\S]*?class="logo"/.test(html) && f.shape === 'wide');
  const tall = label(buildScanSheetHtml({ layout: 'labels', format: 'avery5164', building: 'Coral Bay HOA', codes: list(1) }));
  ok('N2 the 3⅓″ × 4″ label: the building, the line and the logo follow under the name', /class="name"[\s\S]*class="bldg"[\s\S]*Scan to see when this area was last cleaned[\s\S]*class="logo"/.test(tall));
  ok('N2 every label says where it is (the building) and carries the line', (html.match(/Coral Bay HOA/g) || []).length >= 2 && html.includes(codes.SCAN_LABEL_LINE || 'missing'));
}
{
  const css = label(buildScanSheetHtml({ layout: 'labels', codes: list(1) })).match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  const rulesFor = (sel) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => new RegExp(`\\.${sel}\\b`).test(s))).map((m) => m[2]).join(';');
  for (const sel of ['name', 'bldg']) {
    const r = rulesFor(sel);
    ok(`N3 .${sel} is never clipped: no clamp, no ellipsis, no hidden overflow, no single-line squeeze`,
      r.length > 0 && !/line-clamp|text-overflow|overflow:\s*hidden|white-space:\s*nowrap/.test(r), r);
  }
  ok('N3 the clamped name classes are gone (.area clamped a label to 1–3 lines, .cell-area a cell to 2)', css.length > 0 && !/\.(?:cell-)?area\b/.test(css));
  ok('N3 a long name wraps (anywhere, if a word is longer than the line)', /overflow-wrap:\s*anywhere/.test(rulesFor('name')));
  ok('N3 no label box hides what spills out of it', !/\.lbl\{[^}]*overflow:\s*hidden/.test(css));
}
{
  // fitText — pure: the largest size, from the box's own max, at which the words wrap into the box.
  const boxes = [
    ...FORMATS.map((f) => ({ what: f.key, wIn: f.shape === 'wide' ? f.qrIn : f.wIn - 2 * f.padIn, hIn: f.nameIn, maxPt: f.nameMaxPt })),
    ...Object.entries(CELLS).map(([cols, c]) => ({ what: `grid ${cols}`, wIn: 7.5 / Number(cols) - 2 * (c.padIn + (codes.SHEET_CUT_LINE_IN || 0)), hIn: c.nameIn, maxPt: c.nameMaxPt })),
  ];
  const LH = codes.NAME_LINE_HEIGHT;
  for (const b of boxes) {
    const fits = (r) => !!r && r.pt * LH * r.lines <= b.hIn * 72 + EPS;
    const std = STANDARD_AREA_NAMES.map((n) => fitText(n, b));
    ok(`N4 ${b.what}: every standard area name fits its name box at 9 pt or larger`, std.length === 10 && std.every((r) => fits(r) && r.pt >= 9), JSON.stringify(std.map((r) => r?.pt)));
    const long = fitText('Second floor east wing men’s and women’s restrooms', b);
    ok(`N4 ${b.what}: a 50-character name still fits, smaller`, fits(long) && long.pt < (fitText('Pool', b)?.pt || 0) && long.pt >= codes.NAME_MIN_PT, JSON.stringify(long));
    const word = fitText('Superlongareanamewithnospacesatallanywhere', b);
    ok(`N4 ${b.what}: one word longer than the line is broken, never pushed out of the box`, fits(word), JSON.stringify(word));
  }
  ok('N4 a bigger box never gets a smaller size', (fitText('Fitness center', { wIn: 3, hIn: 0.5, maxPt: 14 })?.pt || 0) >= (fitText('Fitness center', { wIn: 1.5, hIn: 0.25, maxPt: 14 })?.pt || 1));
  ok('N4 nothing to fit is no size at all', fitText('', { wIn: 1, hIn: 1, maxPt: 12 })?.lines === 0);
  const html = label(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', codes: [
    { ...list(1)[0], label: 'Pool' }, { ...list(2)[1], label: 'Second floor east wing men’s and women’s restrooms' },
  ] }));
  const sizes = [...html.matchAll(/class="name" data-fit="[\d.]+" style="font-size:([\d.]+)pt"/g)].map((m) => Number(m[1]));
  ok('N4 the document prints the fitted size: the long name smaller than "Pool"', sizes.length === 2 && sizes[1] < sizes[0], JSON.stringify(sizes));
}
{
  const html = label(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', codes: list(3) }));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
  ok('N5 the document measures itself once laid out: every name and building that spills over its box shrinks',
    /querySelectorAll\('\[data-fit\]'\)/.test(script) && /scrollHeight > [\w.]+clientHeight/.test(script) && /fontSize/.test(script));
  ok('N5 …down to a floor of its own', /data-fit/.test(script) && Number.isFinite(codes.FIT_FLOOR_PT) && codes.FIT_FLOOR_PT > 0 && codes.FIT_FLOOR_PT < codes.NAME_MIN_PT);
  ok('N5 every name and every building carries the floor', (html.match(/class="name" data-fit="/g) || []).length === 3 && (html.match(/class="bldg" data-fit="/g) || []).length === 3);
  ok('N5 the script is the document\'s own: it fetches nothing and writes nothing but font sizes', script.length > 0 && !/fetch\(|XMLHttpRequest|location|cookie|innerHTML/.test(script));
}
{
  const many = label(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'Coral Bay HOA', codes: list(10) }));
  const logo = String(DOC_LOGO || '');
  ok('N6 the logo is the documents\' own letterhead mark (brand/logo DOC_LOGO)', logo.length > 0 && many.includes(logo));
  ok('N6 …drawn once in the stylesheet however many labels print', logo.length > 0 && many.split(logo).length === 2);
  ok('N6 …and placed on every label with room for it', (many.match(/class="logo"/g) || []).length === 10);
  const cells = label(buildScanSheetHtml({ layout: 'sheet', building: 'Coral Bay HOA', codes: list(16) }));
  ok('N6 the one-page sheet carries the logo in its header', /class="sheet-head"[\s\S]*class="logo"/.test(cells));
}
{
  const html = label(buildScanSheetHtml({ layout: 'labels', format: 'avery5163', building: 'B', codes: [{ ...list(1)[0], label: '<img src=x onerror=alert(1)>' }] }));
  ok('N7 an area name still cannot inject markup', !html.includes('<img src=x') && html.includes('&lt;img src=x'));
}

if (fails.length) { console.error('\nqr-label-size FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqr-label-size: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
