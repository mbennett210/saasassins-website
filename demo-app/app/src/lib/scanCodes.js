// QR-6 — the OFFICE side of the QR codes: who may manage them, which areas still need one,
// the label sheets and the one-page sheet, and the printable document both are drawn into.
//
// PURE / node-safe (explicit `.js` imports), shared by the office route
// (api/scan-codes, which renders the document to PDF through Chromium), the codes panel
// (components/AreaScanCodes) and the demo adapter (lib/scanCodesApi, which hands the SAME
// document to the browser's print dialog). Nothing here draws a QR matrix itself: callers
// pass what the `qrcode` package's create() returns, so this module stays import-free of it
// and the bundle loads that library only where a code is actually drawn.
import { ROLES } from './roles.js';
import { DOC } from '../brand/doc.js';
import { DOC_LOGO } from '../brand/logo.js';
import { toCsvText } from './csv.js';
import { composeAddress } from './address.js';
import { dayKey } from './dates.js';
import { isArchivedCustomer } from './customerStatus.js';
import { scanTimeZone } from './areaScan.js';

// ── who may manage codes ────────────────────────────────────────────────────
// `sites.edit` — the key that edits a location's cleaning areas on the very card the codes
// sit on (ClientDetail → Cleaning instructions). A code belongs to one of those areas, so
// whoever may define the areas may print, open and replace their codes. Not `ops.edit`
// (assigning checklists) and not `qc.templates.edit` (writing checklists): neither is about
// the building's own areas. PLUS A ROLE FLOOR: crew never, whatever a per-user grant says —
// `can()` puts no key out of a grant's reach, and a cleaner reprinting or replacing the codes
// on a customer's walls is not a thing this app should be able to express (the
// hub.users.* / activity.view convention). One rule, read by the route AND the screen.
export const SCAN_CODES_PERMISSION = 'sites.edit';
export const SCAN_CODES_ROLES = Object.freeze(ROLES.filter((r) => r !== 'crew'));

export function scanCodesAllowed(role, holdsPermission) {
  return holdsPermission === true && SCAN_CODES_ROLES.includes(role);
}

// ── which areas a code can exist for ────────────────────────────────────────
// A location's cleaning areas, in the office's order, each with an id (a code is keyed by
// it). An area with no id cannot carry a code; a repeated id is one area.
export function scanAreasOf(site) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(site?.cleaningAreas) ? site.cleaningAreas : []) {
    const id = typeof a?.id === 'string' && a.id.trim() ? a.id.trim() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: typeof a.label === 'string' && a.label.trim() ? a.label.trim() : null });
  }
  return out;
}

// The idempotent mint's plan: which of these areas already have a LIVE code (never revoked)
// and which still need one. A code whose area is no longer on the location is neither
// handed back nor revoked — it simply stops resolving, because the public read checks the
// area against the live location every time. The database allows ONE live code per area (a
// partial unique index); should a race ever leave two, the newest stands.
export function planScanCodes({ areas = [], codes = [] } = {}) {
  const ids = new Set((Array.isArray(areas) ? areas : []).map((a) => a.id));
  const live = new Map();
  for (const c of Array.isArray(codes) ? codes : []) {
    if (!c || c.revoked_at) continue;
    const areaId = c.area_id;
    if (!ids.has(areaId)) continue;
    const prev = live.get(areaId);
    if (!prev || String(c.created_at || '') > String(prev.created_at || '')) live.set(areaId, c);
  }
  const missing = [...ids].filter((id) => !live.has(id));
  return { live, missing };
}

// Whether the codes panel's answer (`codes`: `[{ areaId }]`, the ensure's) leaves an area of the
// location as the browser holds it without a code (CS-952). The server mints from the SAVED areas,
// so an area added a moment ago has none until its save lands; the panel asks again once it has.
export function scanCodesMissing(site, codes) {
  const have = new Set((Array.isArray(codes) ? codes : []).map((c) => c?.areaId).filter(Boolean));
  return scanAreasOf(site).some((a) => !have.has(a.id));
}

// ── a code scanned by someone SIGNED IN (the Cleaner Hub, D5, 2026-10-13) ──────
// Matt: "QR code scan — a code posted on site opens that location's checklist directly. Add this on
// the client hub as well." The same code the public page reads (`/scan/<token>`) is resolved by the
// staff route (EP-386, GET /api/scan-codes/resolve) and the customer hub's (EP-387, GET
// /api/hub/scan) to WHERE it is; the cleaner's page then opens their checklist there today, the
// customer's that area's own page (QR-16). Pure and shared by both routes and their demo halves.

// Where a live code is: its location, that location's customer, and the area — or null when the
// location or the area is gone (an orphaned code answers like an unknown one everywhere: "no longer
// active"). `code` is `{ siteId, areaId }` (store.resolveScanToken); `sites` / `clients` the shared
// record's.
//
// 🔴 AN ARCHIVED CUSTOMER'S CODES ARE DEAD TOO (QR-27, Matt 2026-10-16: "Stop working: they say 'This
// code is no longer active'"). The labels stay on the walls of a building nobody cleans any more, so
// its codes answer exactly as an unknown one does — the public page, the staff resolve (EP-386) and the
// customer hub's (EP-387) all ask THIS rule first, before any scope check, through §163's own helper
// (lib/customerStatus isArchivedCustomer), never a re-derived status. Restore brings them back: nothing
// is revoked, the rule just stops refusing.
export function scanLocationOf({ code = null, sites = [], clients = [] } = {}) {
  if (!code || !code.siteId || !code.areaId) return null;
  const site = (Array.isArray(sites) ? sites : []).find((s) => s && s.id === code.siteId) || null;
  if (!site) return null;
  const area = scanAreasOf(site).find((a) => a.id === code.areaId);
  if (!area) return null;
  const clientId = typeof site.clientId === 'string' && site.clientId ? site.clientId : null;
  const client = clientId ? (Array.isArray(clients) ? clients : []).find((c) => c && c.id === clientId) || null : null;
  if (client && isArchivedCustomer(client)) return null;
  const siteName = typeof site.name === 'string' && site.name.trim() ? site.name.trim() : null;
  return {
    siteId: site.id,
    clientId,
    areaId: area.id,
    siteName,
    building: (client && typeof client.name === 'string' && client.name.trim()) || siteName,
    area: area.label,
  };
}

// The two answers, each built KEY BY KEY from its allowlist (never a spread location: a site row
// carries door codes and access notes). The customer's carries the AREA's id since QR Wave 2
// (QR-16, 2026-10-17): its scan opens that area's own page in the hub, whose address is the
// building and the area (/hub/b/<buildingId>/areas/<areaId>); never the location's id.
export const SCAN_RESOLVE_KEYS = Object.freeze(['siteId', 'clientId', 'areaId', 'siteName', 'building', 'area']);
export const HUB_SCAN_KEYS = Object.freeze(['buildingId', 'areaId', 'building', 'area']);
export function projectScanResolve(loc) {
  if (!loc) return null;
  return {
    siteId: loc.siteId, clientId: loc.clientId ?? null, areaId: loc.areaId,
    siteName: loc.siteName ?? null, building: loc.building ?? null, area: loc.area ?? null,
  };
}
export function projectHubScan(loc) {
  if (!loc) return null;
  return { buildingId: loc.clientId ?? null, areaId: loc.areaId ?? null, building: loc.building ?? null, area: loc.area ?? null };
}

// The refusal: a customer scanning another building. (A cleaner's refusal outside their own
// cleans went with QR Wave 2: a cleaner may resolve any live code, since a filler is sent anywhere —
// QR-14 — and what they may do there is still judged by their own cleans; lib/scanFillIn.)
export const HUB_SCAN_NOT_YOURS_CODE = 'not-your-building';
// Each route's allowance, per login (api/_lib/rateLimit.js): a person scans a wall once or twice; a
// loop walking tokens meets it.
export const SCAN_RESOLVE_RATE = Object.freeze({ limit: 30, windowMs: 60 * 1000 });

// Which of a cleaner's cleans TODAY a scan at a location opens: the one in progress there, else the
// first not finished, else the last one (all done: the checklist still opens to read). A clean names
// the location (`siteId`) or, with none, its customer. Cancelled cleans open nothing. `cleans` are
// today's, in start order (store/selectors selectTodayCleansForUser). → the job, or null.
export function crewCleanAtLocation({ cleans = [], siteId = null, clientId = null } = {}) {
  const here = (Array.isArray(cleans) ? cleans : []).filter((j) => j && j.status !== 'cancelled'
    && ((siteId && j.siteId === siteId) || (!j.siteId && clientId && j.clientId === clientId)));
  if (!here.length) return null;
  return here.find((j) => j.status === 'in_progress')
    || here.find((j) => j.status !== 'done' && j.status !== 'completed')
    || here[here.length - 1];
}

// ── drawing a code ──────────────────────────────────────────────────────────
// Error correction M (15%): a label on a wall gets scuffed. The quiet zone is the standard
// four modules, inside the drawing, because a label stuck to a dark wall has no white
// margin of its own.
export const QR_ERROR_CORRECTION = 'M';
export const QR_QUIET_MODULES = 4;

// QR-10 (Matt, 2026-10-16): "1¼ inches square or larger" ("Scans easily from about a foot away").
// THE MEASUREMENT RULE: 1¼ in is the code ITSELF — its modules, edge to edge of the black squares,
// what the QR standard (ISO/IEC 18004) calls the symbol and what a ruler held to the label measures.
// The quiet zone is EXTRA, drawn white around it inside the code's square, so every square a layout
// draws is larger than 1¼ in. How much larger depends on the code's module count, and the fewest a
// scan link can have is 29 (version 3): the shortest web address + "/scan/" + the 32-character token
// is 46 characters, which even the library's mixed byte / alphanumeric / numeric packing cannot fit
// in version 2 at level M (test-qr-label-size.mjs §M2 encodes the worst cases to prove it). So
// QR_MIN_BOX_IN keeps the symbol at 1¼ in for EVERY link; real links (33–37 modules) print larger.
export const QR_MIN_IN = 1.25;
export const QR_MIN_MODULES = 29;
export const QR_MIN_BOX_IN = (QR_MIN_IN * (QR_MIN_MODULES + 2 * QR_QUIET_MODULES)) / QR_MIN_MODULES;

// The printed width of a code's symbol (quiet zone excluded) drawn in a `boxIn` square.
export function qrSymbolIn(boxIn, modules) {
  return (boxIn * modules) / (modules + 2 * QR_QUIET_MODULES);
}

// The dark modules of a `qrcode` create() result as ONE path (a run of dark modules in a row
// is one rectangle), in module units with the quiet zone included. Shared by the printed
// document and the codes panel's preview, so both draw the same code from the same matrix.
export function qrPathData(qr) {
  const m = qr?.modules;
  const size = Number(m?.size) || 0;
  if (!size || typeof m.get !== 'function') return null;
  let d = '';
  for (let r = 0; r < size; r += 1) {
    let c = 0;
    while (c < size) {
      if (!m.get(r, c)) { c += 1; continue; }
      let run = 1;
      while (c + run < size && m.get(r, c + run)) run += 1;
      d += `M${c + QR_QUIET_MODULES} ${r + QR_QUIET_MODULES}h${run}v1h-${run}z`;
      c += run;
    }
  }
  return { size: size + 2 * QR_QUIET_MODULES, d };
}

// ── the label sheets (QR-6, QR-9, QR-10) ────────────────────────────────────
// Matt (QR-9, 2026-10-16): "Probably a avery template paper and a regular printer. I would like to
// print, on one sheet, all the locations for that one property, with the name right below the QR
// code, so the person on site knows where to install it." Which sheets Clean Space buys is not
// settled, so the office picks; Avery 5163 / 8163 is the default. Geometry is in inches, from the
// sheet's top-left corner:
//   x0In, y0In  where the first label's top-left corner sits
//   dxIn, dyIn  the pitch: from one label's corner to the next one's, across and down
// Both are gLabels' published layouts (avery-us-templates.xml, re-read 2026-10-17). Inside a label:
//   padIn       the margin inside the label's edge
//   qrIn        the code's square, its quiet zone included: never under QR_MIN_BOX_IN (QR-10)
//   nameIn      the most room the area's name takes, DIRECTLY under the code (it wraps, then shrinks
//               to fit — fitText here, then the document's own measuring pass — and is never clipped);
//               nameMaxPt its largest type
//   bldgIn, lineIn, logoIn   the building, the scan line and the logo, after the name
//   gapIn       between those pieces; colGapIn (wide only) between the code's column and theirs
// A 'wide' label stacks the code and its name on the left and puts the building, the line and the
// logo beside them; a 'tall' one stacks all of it, centred. Avery 22805 (1½″ squares, 24 a sheet)
// was removed 2026-10-17 (QR-10, II.5): a 1½″ label cannot hold a 1¼″ code with its quiet zone, let
// alone the name under it. A saved choice of it reads as the default (labelFormatKey).
export const LETTER = Object.freeze({ widthIn: 8.5, heightIn: 11 });
export const LABEL_FORMATS = Object.freeze({
  avery5163: Object.freeze({
    key: 'avery5163', name: 'Avery 5163 / 8163', size: '2″ × 4″', perSheet: 10,
    cols: 2, rows: 5, wIn: 4, hIn: 2, x0In: 0.1625, y0In: 0.5, dxIn: 4.1875, dyIn: 2,
    shape: 'wide', padIn: 0.06, qrIn: 1.6, nameIn: 0.26, nameMaxPt: 13, colGapIn: 0.16, gapIn: 0.08,
    bldgIn: 0.34, bldgMaxPt: 11, lineIn: 0.26, linePt: 8, logoIn: 0.42, verified: true,
  }),
  avery5164: Object.freeze({
    key: 'avery5164', name: 'Avery 5164 / 8164', size: '3⅓″ × 4″', perSheet: 6,
    cols: 2, rows: 3, wIn: 4, hIn: 10 / 3, x0In: 0.15625, y0In: 0.5, dxIn: 4.1875, dyIn: 10 / 3,
    shape: 'tall', padIn: 0.13, qrIn: 1.9, nameIn: 0.42, nameMaxPt: 18, colGapIn: 0, gapIn: 0.04,
    bldgIn: 0.2, bldgMaxPt: 11, lineIn: 0.14, linePt: 8.5, logoIn: 0.27, verified: true,
  }),
});
export const DEFAULT_LABEL_FORMAT = 'avery5163';
// The whole office's choice, remembered in the shared record (additive, default-safe: a
// missing or unknown value reads as the default). Written from the codes panel through the
// same UPDATE_OPS_SETTINGS the Operations page uses, by the same key the server checks for
// the whole opsSettings slice (time.config — api/_lib/orgStateGuard.js).
export const LABEL_FORMAT_SETTING = 'scanLabelFormat';

export function isLabelFormat(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LABEL_FORMATS, v);
}
export function labelFormatKey(v) {
  return isLabelFormat(v) ? v : DEFAULT_LABEL_FORMAT;
}
export function labelFormatOptions() {
  return Object.values(LABEL_FORMATS).map((f) => ({ value: f.key, label: `${f.name} · ${f.size} · ${f.perSheet} per sheet` }));
}

// QR-9: "just one location on one site, if needed, if something gets damaged." A print may start
// part-way down a sheet, so a partly used one is not wasted: a POSITION is the label it starts on,
// 1 … the sheet's count, across then down (the panel's Print label shows the sheet's grid). Strict:
// a whole number on THIS sheet, else null (the route answers 400; it never guesses).
export function labelPosition(formatKey, value) {
  const f = LABEL_FORMATS[labelFormatKey(formatKey)];
  return Number.isInteger(value) && value >= 1 && value <= f.perSheet ? value : null;
}

// Every label's rectangle, page by page, filled left to right then top to bottom, from `start` (the
// 0-based slot of the first label: a position − 1) on the first sheet; any further sheet starts at 1.
export function labelPages(formatKey, count, { start = 0 } = {}) {
  const f = LABEL_FORMATS[labelFormatKey(formatKey)];
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const first = Number.isInteger(start) && start > 0 && start < f.perSheet ? start : 0;
  const pages = [];
  for (let i = 0; i < n; i += 1) {
    const slot = (first + i) % f.perSheet;
    if (i === 0 || slot === 0) pages.push([]);
    const col = slot % f.cols;
    const row = Math.floor(slot / f.cols);
    pages[pages.length - 1].push({
      index: i, col, row, xIn: f.x0In + col * f.dxIn, yIn: f.y0In + row * f.dyIn, wIn: f.wIn, hIn: f.hIn,
    });
  }
  return pages;
}

// ── the one-page sheet (Matt's note on QR-6) ────────────────────────────────
// "Or one sheet with all the QR codes in it … so we can just stamp it somewhere." Every code
// of the building on ONE page, each with its area's name under it: the grid grows with the
// building (2×2, 3×3, 4×4), so up to 16 areas fit one page; past that, more pages follow. It
// stops at four across (QR-10): a 5×5 cell is 1½″ wide, too narrow for a 1¼″ code with its
// quiet zone. A cell carries the building under the name, and the logo, where it has room;
// the page's header always carries both.
export const SHEET_LAYOUTS = Object.freeze({ LABELS: 'labels', SHEET: 'sheet' });
export const SHEET_MAX_COLS = 4;
const SHEET_MARGIN_IN = 0.5;
const SHEET_HEADER_IN = 1.1;
// The dashed cut line round each cell (0.75 pt).
export const SHEET_CUT_LINE_IN = 0.75 / 72;
// What each grid's cell holds, inside its cut line: the same fields as a label's.
export const SHEET_CELLS = Object.freeze({
  2: Object.freeze({ padIn: 0.12, qrIn: 2.8, nameIn: 0.5, nameMaxPt: 20, bldgIn: 0.28, bldgMaxPt: 12, logoIn: 0.36, gapIn: 0.06, gaps: 2 }),
  3: Object.freeze({ padIn: 0.1, qrIn: 2, nameIn: 0.42, nameMaxPt: 15, bldgIn: 0.2, bldgMaxPt: 10, logoIn: 0, gapIn: 0.05, gaps: 1 }),
  4: Object.freeze({ padIn: 0.1, qrIn: 1.6, nameIn: 0.38, nameMaxPt: 12, bldgIn: 0, bldgMaxPt: 0, logoIn: 0, gapIn: 0, gaps: 0 }),
});

export function sheetGrid(count) {
  const n = Math.max(1, Math.floor(Number(count) || 0));
  const cols = n <= 4 ? 2 : n <= 9 ? 3 : SHEET_MAX_COLS;
  return { cols, rows: cols, perPage: cols * cols };
}

export function sheetPages(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const { cols, rows, perPage } = sheetGrid(n);
  const wIn = (LETTER.widthIn - 2 * SHEET_MARGIN_IN) / cols;
  const hIn = (LETTER.heightIn - 2 * SHEET_MARGIN_IN - SHEET_HEADER_IN) / rows;
  const pages = [];
  for (let i = 0; i < n; i += 1) {
    const slot = i % perPage;
    if (slot === 0) pages.push([]);
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    pages[pages.length - 1].push({
      index: i, col, row, xIn: SHEET_MARGIN_IN + col * wIn, yIn: SHEET_MARGIN_IN + SHEET_HEADER_IN + row * hIn, wIn, hIn,
    });
  }
  return pages;
}

// ── fitting a name into its box ─────────────────────────────────────────────
// A long name wraps, then shrinks; it is never clipped (QR-9). fitText picks the LARGEST size, from
// the box's own maximum down in half points, at which the words wrap into the box — measured with
// Helvetica Bold's published advance widths (AFM, thousandths of an em, for ASCII 32–126; anything
// else counts as a wide capital) and a margin for the printer's own fonts. A word longer than the
// line breaks anywhere, as the document's `overflow-wrap:anywhere` does. The document then measures
// itself in the browser that prints it and shrinks whatever still spills (FIT_SCRIPT), down to
// FIT_FLOOR_PT, so a font wider than Helvetica cannot push a name out of its box either.
export const NAME_LINE_HEIGHT = 1.12;
export const NAME_MIN_PT = 6;
export const FIT_FLOOR_PT = 4;
const FIT_STEP_PT = 0.5;
const GLYPH_MARGIN = 1.12;
const BOLD_WIDTHS = ('278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 '
  + '333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 '
  + '667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 '
  + '556 778 556 556 500 389 280 389 584').split(' ').map(Number);
const glyphEm = (ch) => {
  const c = ch.codePointAt(0);
  return ((c >= 32 && c <= 126 ? BOLD_WIDTHS[c - 32] : 778) / 1000) * GLYPH_MARGIN;
};

function linesAt(text, pt, wIn) {
  const lineEm = (wIn * 72) / pt;
  const space = glyphEm(' ');
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    let w = 0;
    for (const ch of word) w += glyphEm(ch);
    if (used > 0 && used + space + w <= lineEm) { used += space + w; continue; }
    if (used > 0) { lines += 1; used = 0; }
    if (w <= lineEm) { used = w; continue; }
    for (const ch of word) {
      const g = glyphEm(ch);
      if (used > 0 && used + g > lineEm) { lines += 1; used = 0; }
      used += g;
    }
  }
  return lines;
}

// → { pt, lines } for `text` in a box `wIn` × `hIn` inches, type at most `maxPt`; past `minPt`
// nothing smaller is tried (the document's own pass goes on to FIT_FLOOR_PT). No text: no lines.
export function fitText(text, { wIn = 1, hIn = 1, maxPt = 12, minPt = NAME_MIN_PT } = {}) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { pt: maxPt, lines: 0 };
  for (let pt = maxPt; pt >= minPt - 1e-9; pt -= FIT_STEP_PT) {
    const lines = linesAt(s, pt, wIn);
    if (lines * pt * NAME_LINE_HEIGHT <= hIn * 72 + 1e-9) return { pt, lines };
  }
  return { pt: minPt, lines: linesAt(s, minPt, wIn) };
}

// ── the printable document ──────────────────────────────────────────────────
// ONE self-contained HTML string (its own <style>, every value escaped, every colour from
// the document palette `brand/doc.js` and the logo the documents' letterhead uses, so it
// re-skins with the brand) — the inspection-report pattern. The server prints it to PDF
// through Chromium; the demo hands it to the browser's print dialog. Geometry is absolute,
// in inches, on 8.5" × 11" pages with no printer margin, so it lands on the label sheet when
// printed at 100%. Every label and cell is: the code, the area's name directly under it, then
// the building, the scan line and the logo where there is room.
export const SCAN_LABEL_LINE = 'Scan to see when this area was last cleaned';
export const SCAN_SHEET_LINE = 'Scan a code to see when that area was last cleaned.';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const name = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const inch = (v) => `${Math.round(v * 10000) / 10000}in`;

function qrSvg(qr, sizeIn, label) {
  const p = qrPathData(qr);
  const box = `width="${inch(sizeIn)}" height="${inch(sizeIn)}"`;
  if (!p) return `<svg class="qr" ${box} role="img" aria-label="QR code missing"></svg>`;
  return `<svg class="qr" viewBox="0 0 ${p.size} ${p.size}" ${box} shape-rendering="crispEdges" role="img" aria-label="QR code for ${esc(label)}">`
    + `<rect width="${p.size}" height="${p.size}" fill="${DOC.paper}"/><path d="${p.d}" fill="${DOC.ink}"/></svg>`;
}

// A name (or the building) in its box, at the size fitText chose; `data-fit` is the floor the
// document's own pass may shrink it to.
function fitted(cls, text, box) {
  return `<div class="${cls}" data-fit="${FIT_FLOOR_PT}" style="font-size:${fitText(text, box).pt}pt">${esc(text)}</div>`;
}

// Each format's and each grid's own boxes, from the numbers above.
const nameWidthIn = (f) => (f.shape === 'wide' ? f.qrIn : f.wIn - 2 * f.padIn);
const moreWidthIn = (f) => (f.shape === 'wide' ? f.wIn - 2 * f.padIn - f.qrIn - f.colGapIn : f.wIn - 2 * f.padIn);
const cellInnerIn = (wIn, c) => wIn - 2 * (c.padIn + SHEET_CUT_LINE_IN);

function formatCss(f) {
  const k = `.f-${f.key}`;
  return `${k}{padding:${inch(f.padIn)};gap:${inch(f.shape === 'wide' ? f.colGapIn : f.gapIn)}}`
    + `${k} .name{width:${inch(nameWidthIn(f))};max-height:${inch(f.nameIn)}}`
    + `${k} .more{width:${inch(moreWidthIn(f))};gap:${inch(f.gapIn)}}`
    + `${k} .bldg{max-height:${inch(f.bldgIn)}}`
    + `${k} .line{font-size:${f.linePt}pt;max-height:${inch(f.lineIn)}}`
    + `${k} .logo{height:${inch(f.logoIn)}}`;
}
function cellCss(cols, c) {
  const k = `.cell-${cols}`;
  return `${k}{padding:${inch(c.padIn)};gap:${inch(c.gapIn)}}`
    + `${k} .name{max-height:${inch(c.nameIn)}}`
    + (c.bldgIn ? `${k} .bldg{max-height:${inch(c.bldgIn)}}` : '')
    + (c.logoIn ? `${k} .logo{height:${inch(c.logoIn)}}` : '');
}

const STYLE = `@page{size:8.5in 11in;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:${DOC.ink};background:${DOC.paper};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{position:relative;width:8.5in;height:11in;overflow:hidden;break-after:page;page-break-after:always}
.pg:last-child{break-after:auto;page-break-after:auto}
.qr{display:block;flex:0 0 auto}
.lbl{position:absolute;display:flex}
.code{display:flex;flex-direction:column;align-items:center;flex:0 0 auto}
.name{font-weight:700;line-height:${NAME_LINE_HEIGHT};text-align:center;overflow-wrap:anywhere}
.more{display:flex;flex-direction:column;min-width:0}
.bldg{color:${DOC.pen};font-weight:600;line-height:${NAME_LINE_HEIGHT};overflow-wrap:anywhere}
.line{color:${DOC.muted};line-height:1.15}
.logo{width:100%;flex:0 0 auto;background:url("${DOC_LOGO}") no-repeat left center/contain}
.lbl-wide{flex-direction:row;align-items:flex-start}
.lbl-wide .more{align-self:stretch;justify-content:center}
.lbl-tall{flex-direction:column;align-items:center;justify-content:center;text-align:center}
.lbl-tall .code,.lbl-tall .more{width:100%;align-items:center}
.lbl-tall .logo,.cell .logo{background-position:center}
.sheet-head{position:absolute;left:0.5in;top:0.5in;width:7.5in;display:flex;align-items:flex-start;justify-content:space-between;gap:0.3in}
.sheet-title{min-width:0}
.sheet-head h1{margin:0;font-size:18pt;line-height:1.15;color:${DOC.brand};overflow-wrap:anywhere}
.sheet-loc{margin-top:0.03in;font-size:11pt;color:${DOC.pen}}
.sheet-head p{margin:0.06in 0 0;font-size:10pt;color:${DOC.muted}}
.sheet-head .logo{width:1.45in;height:0.5in;background-position:right top}
.cell{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border:${inch(SHEET_CUT_LINE_IN)} dashed ${DOC.line}}
.cell .code,.cell .name,.cell .bldg{width:100%}
${Object.values(LABEL_FORMATS).map(formatCss).join('\n')}
${Object.entries(SHEET_CELLS).map(([cols, c]) => cellCss(cols, c)).join('\n')}`;

// The document's own measuring pass (see fitText): once laid out, any name or building taller
// than its box steps down a quarter point at a time, to its floor. It reads and writes nothing else.
const FIT_SCRIPT = '<script>(function(){var els=document.querySelectorAll(\'[data-fit]\');'
  + 'for(var i=0;i<els.length;i+=1){var el=els[i];var floor=parseFloat(el.getAttribute(\'data-fit\'))||4;'
  + 'var pt=parseFloat(el.style.fontSize)||10;'
  + 'while(el.scrollHeight > el.clientHeight+1&&pt>floor){pt=Math.max(floor,pt-0.25);el.style.fontSize=pt+\'pt\';}}})();</script>';

function labelHtml(c, r, f, building) {
  const area = name(c.label) || 'Untitled area';
  const pos = `left:${inch(r.xIn)};top:${inch(r.yIn)};width:${inch(r.wIn)};height:${inch(r.hIn)}`;
  return `<div class="lbl lbl-${f.shape} f-${f.key}" style="${pos}">`
    + `<div class="code">${qrSvg(c.qr, f.qrIn, area)}${fitted('name', area, { wIn: nameWidthIn(f), hIn: f.nameIn, maxPt: f.nameMaxPt })}</div>`
    + '<div class="more">'
    + `${building ? fitted('bldg', building, { wIn: moreWidthIn(f), hIn: f.bldgIn, maxPt: f.bldgMaxPt }) : ''}`
    + `<div class="line">${SCAN_LABEL_LINE}</div><div class="logo"></div></div></div>`;
}

function labelsBody(list, f, building, start) {
  return labelPages(f.key, list.length, { start }).map((page) => `<div class="pg pg-labels">${page.map((r) => labelHtml(list[r.index], r, f, building)).join('')}</div>`).join('');
}

function sheetBody(list, building, location) {
  const { cols } = sheetGrid(list.length);
  const c = SHEET_CELLS[cols];
  const head = `<div class="sheet-head"><div class="sheet-title"><h1>${esc(building || 'QR codes')}</h1>`
    + `${location ? `<div class="sheet-loc">${esc(location)}</div>` : ''}<p>${SCAN_SHEET_LINE}</p></div><div class="logo"></div></div>`;
  return sheetPages(list.length).map((page) => `<div class="pg pg-sheet">${head}${page.map((r) => {
    const code = list[r.index];
    const area = name(code.label) || 'Untitled area';
    const wIn = cellInnerIn(r.wIn, c);
    const pos = `left:${inch(r.xIn)};top:${inch(r.yIn)};width:${inch(r.wIn)};height:${inch(r.hIn)}`;
    return `<div class="cell cell-${cols}" style="${pos}">`
      + `<div class="code">${qrSvg(code.qr, c.qrIn, area)}${fitted('name', area, { wIn, hIn: c.nameIn, maxPt: c.nameMaxPt })}</div>`
      + `${c.bldgIn && building ? fitted('bldg', building, { wIn, hIn: c.bldgIn, maxPt: c.bldgMaxPt }) : ''}`
      + `${c.logoIn ? '<div class="logo"></div>' : ''}</div>`;
  }).join('')}</div>`).join('');
}

//   layout    SHEET_LAYOUTS.LABELS (one label per area) | SHEET_LAYOUTS.SHEET (all on one page)
//   format    a LABEL_FORMATS key (labels only)
//   building  the customer's name; location the location's own name (the sheet's header)
//   codes     [{ label, url, qr }] in the office's order, `qr` = qrcode.create(url) — one code is
//             Print label's one label (QR-9)
//   position  labels only: the label of the sheet the first one goes on (labelPosition; 1 = the top
//             left, the default)
export function buildScanSheetHtml({ layout = SHEET_LAYOUTS.LABELS, format = DEFAULT_LABEL_FORMAT, building = '', location = '', codes = [], position = 1 } = {}) {
  const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
  const b = name(building) || name(location);
  const l = name(location) && name(location) !== b ? name(location) : '';
  const sheet = layout === SHEET_LAYOUTS.SHEET;
  const title = `${sheet ? 'QR codes' : 'QR labels'}${b ? ` · ${b}` : ''}`;
  const f = LABEL_FORMATS[labelFormatKey(format)];
  const body = sheet ? sheetBody(list, b, l) : labelsBody(list, f, b, (labelPosition(f.key, position) || 1) - 1);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}${FIT_SCRIPT}</body></html>`;
}

// A building's name as a file name's safe part: lowercase letters, digits and dashes only.
const fileSlug = (building) => String(building || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'building';

// "qr-labels-coral-bay-hoa-avery5163.pdf" / "qr-codes-coral-bay-hoa.pdf"; one area's label (Print
// label, QR-9): "qr-label-coral-bay-hoa-restrooms-avery5163.pdf".
export function scanSheetFilename({ layout = SHEET_LAYOUTS.LABELS, format = DEFAULT_LABEL_FORMAT, building = '', area = '' } = {}) {
  const slug = fileSlug(building);
  if (layout === SHEET_LAYOUTS.SHEET) return `qr-codes-${slug}.pdf`;
  return name(area) ? `qr-label-${slug}-${fileSlug(area)}-${labelFormatKey(format)}.pdf` : `qr-labels-${slug}-${labelFormatKey(format)}.pdf`;
}

// ── the links, for the office's own label software (QR Wave 1, 2026-10-16) ──
// Daniel: "whatever software he's using to print he just needs the link for each unique
// scanpoint". ONE builder for both files: a building's "Download links" on its QR panel (built
// in the browser from the panel's own answer) and the all-buildings "QR code links" spreadsheet
// on the Customers list (EP-412, built on the server). One row per LIVE code, in the office's
// area order; every cell through the repo's one escaper (lib/csv toCsvText → payroll csvCell:
// RFC 4180 quoting, a UTF-8 byte-order mark, CRLF, and a text cell starting = + - @ TAB or CR
// written with a leading apostrophe, so a customer named "=HYPERLINK(…)" is text in Excel).
export const SCAN_LINK_COLUMNS = Object.freeze(['Customer', 'Customer #', 'Location', 'Address', 'Area', 'Link', 'Made on']);

// A building's address: its location's composed line, else the location's fields, else the
// customer's (the hub's projectHubBuilding reads the same two).
function buildingAddress(site, client) {
  const line = name(site?.address);
  if (line) return line;
  return composeAddress({ street: site?.street, city: site?.city, state: site?.state, zip: site?.zip })
    || composeAddress({ street: client?.street, city: client?.city, state: client?.state, zip: client?.zip });
}

// One building's rows.
//   client    the customer (its name and number); null for a location with none
//   site      the location (its name and address)
//   codes     [{ label, url, createdAt }] — the panel's and the route's own shape, in area order
//   timeZone  the org's zone: "Made on" is the code's day there
// → [{ customer, customerNumber, location, address, area, link, madeOn }]. "Location" only when it
// says something the customer's name does not (the public page's rule, lib/areaScan).
export function scanLinkRows({ client = null, site = null, codes = [], timeZone = null } = {}) {
  const customer = name(client?.name) || name(site?.name);
  const place = name(site?.name);
  const location = customer && place && place !== customer ? place : '';
  const address = buildingAddress(site, client);
  const zone = scanTimeZone(timeZone);
  const customerNumber = name(client?.customerNumber);
  return (Array.isArray(codes) ? codes : []).filter((c) => c && typeof c.url === 'string' && c.url).map((c) => {
    const at = typeof c.createdAt === 'string' ? Date.parse(c.createdAt) : NaN;
    return {
      customer, customerNumber, location, address,
      area: name(c.label) || 'Untitled area',
      link: c.url,
      madeOn: Number.isFinite(at) ? dayKey(new Date(at), zone) : '',
    };
  });
}

// The rows as the file: the column names, then one line per row.
export function scanLinksCsv(rows = []) {
  return toCsvText([
    SCAN_LINK_COLUMNS,
    ...(Array.isArray(rows) ? rows : []).map((r) => [r.customer, r.customerNumber, r.location, r.address, r.area, r.link, r.madeOn]),
  ]);
}

// "qr-code-links-2026-10-16.csv" (every building, the org's day) / "qr-code-links-coral-bay-hoa.csv".
export function scanLinksFilename({ building = null, dateKey: day = null } = {}) {
  if (building != null) return `qr-code-links-${fileSlug(building)}.csv`;
  return `qr-code-links-${/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : 'all'}.csv`;
}

// Which buildings the all-buildings spreadsheet lists, in its order: every location whose
// customer is not ARCHIVED (UI_RULES §163 — nobody prints labels for a building they no longer
// clean), each with its customer; those with cleaning areas are the `buildings` (by customer
// name, then number, then the location), the rest are counted as `withoutAreas` (the office has
// yet to enter them: "add their areas on the customer's page").
export function scanLinkBuildings({ sites = [], clients = [] } = {}) {
  const byId = new Map((Array.isArray(clients) ? clients : []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const buildings = [];
  let withoutAreas = 0;
  for (const site of Array.isArray(sites) ? sites : []) {
    if (!site || !site.id) continue;
    const client = site.clientId ? byId.get(site.clientId) || null : null;
    if (client && isArchivedCustomer(client)) continue;
    if (!scanAreasOf(site).length) { withoutAreas += 1; continue; }
    buildings.push({ site, client });
  }
  const key = (b) => (name(b.client?.name) || name(b.site.name)).toLowerCase();
  buildings.sort((a, b) => key(a).localeCompare(key(b), 'en')
    || name(a.client?.customerNumber).localeCompare(name(b.client?.customerNumber), 'en')
    || name(a.site.name).localeCompare(name(b.site.name), 'en')
    || String(a.site.id).localeCompare(String(b.site.id), 'en'));
  return { buildings, withoutAreas };
}

// EP-412's allowance per login: a whole-book export is a complete read and maybe a mint of
// thousands of codes, so a person asks once or twice, never in a loop.
export const SCAN_LINKS_RATE = Object.freeze({ limit: 6, windowMs: 60 * 1000 });
