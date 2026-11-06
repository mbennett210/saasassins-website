// QR codes adapter (QR-1..QR-6, HUB-15) — the office's codes panel and the public scan page — and,
// since the Cleaner Hub (D5, 2026-10-13), a signed-in staff member's camera: `resolveScanCode`.
// Real backend by default: /api/scan-codes/* (the office, sites.edit; the resolve, any staff login)
// and /api/public/scan/* (anyone, no login).
//
// The localStorage DEMO engages only in a demo build, or a non-production dev build with no
// backend, on the STATIC `import.meta.env.MODE` / `.PROD` Vite inlines at build time — the
// CS-010 / CS-038 lesson (lib/demoMode.js). In `npm run build` STUB folds to a literal
// `false`, so every stub body, the 'cs-stub:scanCodes' sentinel and the demo's own codes
// (data/demoScanCodes.js) are dead code the bundler drops; check-bundle-stubs.mjs asserts
// it. (`demoBackendsEngaged()` on its own is a RUNTIME check: it would keep the stub from
// running in production but leave the demo's tokens in the shipped bundle.)
//
// The demo runs the SAME pure rules the server does — the mint plan and the printable
// document (lib/scanCodes), the token encoder and the public allowlist projection
// (lib/areaScan), and each area's last clean through qcApi's demo half of the one
// `siteAreaStatus` rule — so what Daniel sees on the demo is what production computes.
import { authHeaders } from './authHeader';
import { markStub, demoBackendsEngaged } from './demoMode';
import {
  isScanToken, encodeScanToken, projectAreaScan, scanBaseUrl, scanUrl, scanTimeZone, SCAN_TOKEN_BYTES,
  SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE, SCAN_UNAVAILABLE_CODE, SCAN_UNAVAILABLE_MESSAGE,
  scanNextCleanDay, scanLastInspectionDay,
} from './areaScan';
import {
  planScanCodes, scanAreasOf, buildScanSheetHtml, labelFormatKey, QR_ERROR_CORRECTION,
  scanLocationOf, projectScanResolve,
  scanLinkBuildings, scanLinkRows, scanLinksCsv, scanLinksFilename,
} from './scanCodes';
import {
  fillInPlan, fillInDecision, projectFillInCandidates, projectCrewAreaInfo, atLocation, FILL_IN_REFUSAL_STATUS,
} from './scanFillIn';
import { isOnTodayList } from './clockInWindow';
import { dayKey, addDaysKey, startOfDayKey } from './dates';
import { areaStatus as qcAreaStatus, listInspections as qcListInspections, listOpenProblems as qcListOpenProblems, demoFileVisitorProblem } from './qcApi';
import { entriesAll as timeEntriesAll } from './timeApi';
import { stubAttachDataUrl } from './accountMediaApi';
import {
  visitorReportInput, visitorHoneypotFilled, visitorLimitVerdict, visitorLimitWindows, visitorTicketInput,
  visitorReportStatus, VISITOR_REPORT_THANKS, VISITOR_REPORT_ALREADY, VISITOR_REPORT_MESSAGES, VISITOR_REPORT_CODES,
} from './visitorReports';
import {
  areaRatingInput, areaRatingLimitVerdict, areaRatingStatus, ratingDay, ratingRetentionCutoffDay, ratingPeriodDays,
  ratingPeriodWindow, visitorRatingsReport, AREA_RATING_THANKS, AREA_RATING_MESSAGES, AREA_RATING_CODES,
} from './areaRatings';
import { loadState } from '../store/persist';
import { INITIAL_STATE } from '../data/seed';
import { SCAN_CODES_STUB_KEY, SCAN_RATINGS_STUB_KEY } from '../data/stubKeys';
import { demoScanCodes } from '../data/demoScanCodes';
import { demoAreaRatings } from '../data/demoAreaRatings';

// PLAIN member reads so Vite inlines them and STUB folds to a literal (see the header).
const STUB = import.meta.env.MODE === 'demo' || (!import.meta.env.PROD && demoBackendsEngaged());
if (STUB) markStub('cs-stub:scanCodes');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isScanCodesStub() { return STUB; }

function scanError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function api(path, body) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw scanError(res.status, json?.code || null, json?.error || `Request failed (${res.status})`);
  return json;
}

// ── the office ──────────────────────────────────────────────────────────────
// One live code for every cleaning area of the location, minting only what is missing.
// → { siteId, building, location, base, codes: [{ areaId, label, token, url, createdAt }] }
export async function ensureScanCodes(siteId) {
  if (!STUB) return api('/scan-codes/ensure', { siteId });
  return stubEnsure(siteId);
}

// Revoke the area's code (its label stops working at once) and mint a new one. → { code }
export async function replaceScanCode({ siteId, areaId }) {
  if (!STUB) return api('/scan-codes/replace', { siteId, areaId });
  return stubReplace({ siteId, areaId });
}

// The printable codes: `layout` 'labels' (one label per area, on `format`'s sheet) or
// 'sheet' (every code on one page). Print label (QR-9) passes `areaId` (that area's label only)
// and `position` (the label of the sheet it goes on, lib/scanCodes labelPosition). The server
// renders a PDF and the browser saves it; the demo hands the SAME document to the browser's
// print dialog ("Save as PDF" is one of its printers). Call it straight from the click: the
// demo opens its window before awaiting anything, which is what keeps a pop-up blocker from
// refusing it.
export async function printScanSheet({ siteId, layout, format, areaId = null, position = null }) {
  if (STUB) return stubPrint({ siteId, layout, format, areaId, position });
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/scan-codes/sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ siteId, layout, format, areaId, position }),
  });
  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    throw scanError(res.status, json?.code || null, json?.error || `Request failed (${res.status})`);
  }
  const blob = await res.blob();
  const m = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') || '');
  saveBlob(blob, m ? m[1] : 'qr-codes.pdf');
  return { saved: true };
}

// EVERY building's links as one spreadsheet (EP-412, the Customers list's "QR code links"): the
// server mints any code still missing first, then answers the file the building panel's own
// "Download links" builds too (lib/scanCodes scanLinkRows / scanLinksCsv).
// → { filename, csv, links, buildings, withoutAreas }
export async function fetchScanLinks() {
  if (STUB) return stubLinks();
  return api('/scan-codes/links', {});
}

// A links file, saved in the browser: the panel's building file and the all-buildings one. The
// text already starts with its byte-order mark (lib/csv toCsvText), so Excel reads it as UTF-8.
export function saveScanLinksCsv(csv, filename) {
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename || 'qr-code-links.csv');
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── the public scan page ────────────────────────────────────────────────────
// → { scan, photoUrl }: `scan` is the allowlist projection (lib/areaScan.projectAreaScan) and
// `photoUrl` where the page may fetch the area's newest checklist photo (the public route's
// own /photo, keyed by the token the visitor already holds — the answer itself carries no
// URL). Throws an Error carrying `.code` (SCAN_INACTIVE_CODE, 'rate-limited',
// SCAN_UNAVAILABLE_CODE) and `.status`. A malformed token costs no request.
export async function getPublicAreaScan(token) {
  if (!isScanToken(token)) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  if (STUB) return stubPublicScan(token);
  const q = `token=${encodeURIComponent(token)}`;
  const res = await fetch(`${BACKEND}/public/scan/area?${q}`, { headers: { Accept: 'application/json' } });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw scanError(res.status, json?.code || SCAN_UNAVAILABLE_CODE, json?.error || SCAN_UNAVAILABLE_MESSAGE);
  return { scan: json, photoUrl: json?.photo ? `${BACKEND}/public/scan/photo?${q}` : null };
}

// ── a visitor's two writes from the public page (QR-22..QR-26, QR-30; EP-414, EP-415) ─────
// No session: a visitor is whoever holds the code (the token rides in the body). Each answers the
// route's JSON — { ok, message, photoSaved } for a report ({ duplicate: true } when the same report
// came moments ago), { ok, vote, message } for a vote — or throws an Error carrying the route's
// stable `.code` and its sentence as `.message` (a refusal, a limit, "no longer active"); no signal
// is a fetch TypeError (no `.status`).
async function publicPost(path, body, fallback) {
  const res = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw scanError(res.status, json?.code || null, json?.error || fallback);
  return json;
}
export async function sendVisitorReport(body) {
  if (STUB) return stubVisitorReport(body);
  return publicPost('/public/scan/report', body, VISITOR_REPORT_MESSAGES[VISITOR_REPORT_CODES.unavailable]);
}
export async function rateScanArea(body) {
  if (STUB) return stubRateArea(body);
  return publicPost('/public/scan/rate', body, AREA_RATING_MESSAGES[AREA_RATING_CODES.unavailable]);
}

// ── the office's Reports → Visitor ratings (QR-30; EP-416) ──────────────────────────────────
// → { days, fromDay, toDay, buildings[], totals } (lib/areaRatings visitorRatingsReport).
export async function fetchVisitorRatings({ days } = {}) {
  if (STUB) return stubVisitorRatings({ days });
  const auth = await authHeaders();
  const q = days ? `?days=${encodeURIComponent(days)}` : '';
  const res = await fetch(`${BACKEND}/qc/reports/visitor-ratings${q}`, { headers: { Accept: 'application/json', ...auth } });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw scanError(res.status, json?.code || null, json?.error || `Request failed (${res.status})`);
  return json;
}

// ── a code scanned by a signed-in staff member (EP-386, the Cleaner Hub D5) ───
// → { siteId, clientId, areaId, siteName, building, area } (lib/scanCodes projectScanResolve) for ANY
// live code of the org (a cleaner too, since QR Wave 2: a filler may scan anywhere). Throws an Error
// carrying `.code` (SCAN_INACTIVE_CODE for a dead or malformed code, 'rate-limited') and `.status`;
// no signal is a fetch TypeError (no `.status`). A malformed token costs no request. `ctx` —
// { state, user } — is read by the demo only (the route takes the caller from the login's claim).
export async function resolveScanCode(token, ctx) {
  if (!isScanToken(token)) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  if (STUB) return stubResolve(token, ctx);
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/scan-codes/resolve?token=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json', ...auth } });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw scanError(res.status, json?.code || null, json?.error || `Request failed (${res.status})`);
  return json;
}

// ── QR Wave 2: the cleaner's scan (EP-420, EP-419; the rules are lib/scanFillIn) ──
// What a cleaner finds at the code's location today: { onClean, fillIn, info } — their own clean
// there (the row, to adopt) with the building's last inspection and open tickets, or the fill-in
// offer. `ctx.previewUserId`: the owner's View-as asks for the viewed cleaner (the server allows it
// with `time.view`). Throws like resolveScanCode.
export async function crewAreaForScan(token, ctx) {
  if (!isScanToken(token)) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  if (STUB) return stubCrewArea(token, ctx);
  const qs = new URLSearchParams({ token });
  if (ctx?.previewUserId) qs.set('userId', ctx.previewUserId);
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/scan-codes/crew-area?${qs.toString()}`, { headers: { Accept: 'application/json', ...auth } });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw scanError(res.status, json?.code || null, json?.error || `Request failed (${res.status})`);
  return json;
}

// The fill-in itself: the server swaps the cleaner onto today's clean as `coverFor`'s cover and
// answers the clean as written ({ job, changed }), which the phone adopts at once (the store's jobs
// loader, adoptServerJobs). A refusal throws with its `code` (lib/scanFillIn FILL_IN_REFUSAL).
export async function fillInFromScan({ token, jobId, coverFor }, ctx) {
  if (!isScanToken(token)) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  if (STUB) return stubFillIn({ token, jobId, coverFor }, ctx);
  return api('/scan-codes/fill-in', { token, jobId, coverFor });
}

// ── demo (localStorage) ─────────────────────────────────────────────────────
// `{ codes: [area_scan_codes-shaped rows] }`; absent, it starts from the demo's own three.
function loadDb() {
  try {
    const db = JSON.parse(localStorage.getItem(SCAN_CODES_STUB_KEY));
    if (db && Array.isArray(db.codes)) return db;
  } catch { /* unreadable: start again */ }
  return { codes: demoScanCodes() };
}
function saveDb(db) {
  try { localStorage.setItem(SCAN_CODES_STUB_KEY, JSON.stringify(db)); } catch { /* quota / private mode */ }
}
// The demo's shared record: what the app has saved in this browser, else the seed — the
// demo's stand-in for the server's read of org_state. Read without booting the store.
const demoState = () => loadState() || INITIAL_STATE;
const demoSite = (state, siteId) => (state.sites || []).find((s) => s && s.id === siteId) || null;
const demoBuilding = (state, site) => (state.clients || []).find((c) => c && c.id === site?.clientId)?.name || site?.name || null;
// Web Crypto, never Math.random(): the demo mints the same 24-byte, 32-character token.
function mintDemoToken() {
  const bytes = new Uint8Array(SCAN_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return encodeScanToken(bytes);
}
const demoRow = (siteId, areaId) => {
  const token = mintDemoToken();
  return {
    id: `sc_${token.slice(0, 12)}`, site_id: siteId, area_id: areaId, token,
    created_at: new Date().toISOString(), created_by: null, revoked_at: null, revoked_by: null,
  };
};
const demoShape = (base, area, code) => ({
  areaId: area.id, label: area.label, token: code.token, url: scanUrl(base, code.token), createdAt: code.created_at || null,
});

function stubEnsure(siteId) {
  const state = demoState();
  const site = demoSite(state, siteId);
  if (!site) throw scanError(404, 'not-found', 'That location could not be found.');
  const db = loadDb();
  const areas = scanAreasOf(site);
  const { live, missing } = planScanCodes({ areas, codes: db.codes.filter((c) => c.site_id === siteId) });
  for (const areaId of missing) {
    const r = demoRow(siteId, areaId);
    db.codes.push(r);
    live.set(areaId, r);
  }
  if (missing.length) saveDb(db);
  const base = scanBaseUrl({ origin: window.location.origin });
  return {
    siteId,
    building: demoBuilding(state, site),
    location: site.name || null,
    base,
    codes: areas.map((a) => demoShape(base, a, live.get(a.id))),
  };
}

function stubReplace({ siteId, areaId }) {
  const site = demoSite(demoState(), siteId);
  const area = scanAreasOf(site).find((a) => a.id === areaId);
  if (!site || !area) throw scanError(404, 'not-found', 'That area is no longer on this location.');
  const db = loadDb();
  const now = new Date().toISOString();
  for (const c of db.codes) if (c.site_id === siteId && c.area_id === areaId && !c.revoked_at) c.revoked_at = now;
  const r = demoRow(siteId, areaId);
  db.codes.push(r);
  saveDb(db);
  return { code: demoShape(scanBaseUrl({ origin: window.location.origin }), area, r) };
}

async function stubPrint({ siteId, layout, format, areaId, position }) {
  const w = window.open('', '_blank');
  if (!w) throw scanError(0, 'popup-blocked', 'Allow pop-ups to print the codes, or save them as a PDF.');
  try {
    const data = stubEnsure(siteId);
    // The route's rule: one area's label when one is named (an area no longer here is not found).
    const chosen = areaId ? data.codes.filter((c) => c.areaId === areaId) : data.codes;
    if (!chosen.length) throw scanError(404, 'not-found', 'That area is no longer on this location.');
    const mod = await import('qrcode');
    const QR = mod.default || mod;
    const codes = chosen.map((c) => ({ ...c, qr: QR.create(c.url, { errorCorrectionLevel: QR_ERROR_CORRECTION }) }));
    const html = buildScanSheetHtml({
      layout, format: labelFormatKey(format), building: data.building, location: data.location, codes, position: position ?? 1,
    });
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
    return { printed: true };
  } catch (e) {
    w.close();
    throw e;
  }
}

// The route's links (EP-412), on the demo's codes and the store's own state: the same buildings
// (an archived customer's skipped), the same idempotent mint, the same rows and file, built on the
// page's own origin (the demo has no deployment address).
function stubLinks() {
  const state = demoState();
  const { buildings, withoutAreas } = scanLinkBuildings({ sites: state.sites, clients: state.clients });
  const db = loadDb();
  const base = scanBaseUrl({ origin: window.location.origin });
  const timeZone = scanTimeZone(state.company?.timezone);
  let minted = false;
  const rows = [];
  for (const { site, client } of buildings) {
    const areas = scanAreasOf(site);
    const { live, missing } = planScanCodes({ areas, codes: db.codes.filter((c) => c.site_id === site.id) });
    for (const areaId of missing) {
      const r = demoRow(site.id, areaId);
      db.codes.push(r);
      live.set(areaId, r);
      minted = true;
    }
    rows.push(...scanLinkRows({
      client, site, timeZone,
      codes: areas.map((a) => ({ label: a.label, url: scanUrl(base, live.get(a.id)?.token), createdAt: live.get(a.id)?.created_at || null })),
    }));
  }
  if (minted) saveDb(db);
  return {
    filename: scanLinksFilename({ dateKey: dayKey(new Date(), timeZone) }),
    csv: scanLinksCsv(rows),
    links: rows.length,
    buildings: buildings.length,
    withoutAreas,
  };
}

// The route's resolve, on the demo's codes and the store's own state: the same location rule, the
// same answer — any live code, for anyone signed in (QR Wave 2).
function stubLocation(token, ctx) {
  const code = loadDb().codes.find((c) => c.token === token && !c.revoked_at);
  if (!code) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  const state = ctx?.state || demoState();
  const loc = scanLocationOf({ code: { siteId: code.site_id, areaId: code.area_id }, sites: state.sites, clients: state.clients });
  if (!loc) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  return { loc, state };
}
function stubResolve(token, ctx) {
  return projectScanResolve(stubLocation(token, ctx).loc);
}

// The cleaner's scan on the demo (EP-420 / EP-419's halves): the same rules over the store's jobs,
// the demo time ledger's punches and the QC stubs' inspections and tickets. The demo has no server
// to write the activity log or ring the account manager; the phone's flow is the same.
function stubDay(state) {
  const timeZone = scanTimeZone(state.company?.timezone);
  const nowMs = Date.now();
  const todayKey = dayKey(new Date(nowMs), timeZone);
  const grace = Number(state.opsSettings?.autoCloseGraceMins);
  return {
    timeZone, nowMs, todayKey, graceMins: Number.isFinite(grace) ? grace : undefined,
    fromIso: startOfDayKey(addDaysKey(todayKey, -2), timeZone).toISOString(),
    toIso: startOfDayKey(addDaysKey(todayKey, 1), timeZone).toISOString(),
    activeUserIds: (state.users || []).filter((u) => u && u.status === 'active').map((u) => u.id),
  };
}
async function stubPunches(day, jobIds) {
  const out = new Map(jobIds.map((id) => [id, new Set()]));
  if (!jobIds.length) return out;
  const rows = await timeEntriesAll({ fromIso: new Date(Date.parse(day.fromIso) - 86400000).toISOString(), toIso: new Date(day.nowMs + 86400000).toISOString(), jobIds });
  for (const e of rows || []) {
    if (!e || !e.job_id || !e.user_id || e.status === 'voided' || e.status === 'no_show') continue;
    out.get(e.job_id)?.add(e.user_id);
  }
  return out;
}
const crewOnlyStub = () => scanError(403, 'crew-only', 'This is for a cleaner’s own scan.');

async function stubCrewArea(token, ctx) {
  const { loc, state } = stubLocation(token, ctx);
  const userId = ctx?.previewUserId || ctx?.user?.id || null;
  if (!userId) throw crewOnlyStub();
  const day = stubDay(state);
  const jobs = (state.jobs || []).filter((j) => atLocation(j, loc.siteId, loc.clientId) && isOnTodayList(j, day.todayKey, day.nowMs, day.graceMins, day.timeZone));
  const plan = fillInPlan({
    jobs, siteId: loc.siteId, clientId: loc.clientId, userId,
    punchedByJob: await stubPunches(day, jobs.map((j) => j.id)), activeUserIds: day.activeUserIds,
    todayKey: day.todayKey, nowMs: day.nowMs, graceMins: day.graceMins, timeZone: day.timeZone,
  });
  if (!plan.onClean) return { onClean: null, fillIn: { state: plan.state, candidates: projectFillInCandidates(plan.candidates) }, info: null };
  const [{ inspections }, open] = await Promise.all([
    qcListInspections({ siteIds: [loc.siteId] }),
    qcListOpenProblems({ siteIds: [loc.siteId] }),
  ]);
  const newest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id).localeCompare(String(a.id));
  const tickets = (open || []).filter((t) => t && t.site_id === loc.siteId).sort(newest);
  return {
    onClean: plan.onClean,
    fillIn: null,
    info: projectCrewAreaInfo({
      inspection: (inspections || []).find((r) => r && r.status !== 'draft') || null,
      tickets, ticketsTotal: tickets.length,
      site: (state.sites || []).find((s) => s && s.id === loc.siteId) || null,
    }),
  };
}

async function stubFillIn({ token, jobId, coverFor }, ctx) {
  const { loc, state } = stubLocation(token, ctx);
  const userId = ctx?.user?.id || null;
  if (!userId || ctx?.user?.role !== 'crew') throw crewOnlyStub();
  const day = stubDay(state);
  const job = (state.jobs || []).find((j) => j && j.id === jobId) || null;
  const d = fillInDecision({
    job, loc, userId, coverFor, punched: job ? (await stubPunches(day, [jobId])).get(jobId) : null,
    activeUserIds: day.activeUserIds, todayKey: day.todayKey, nowMs: day.nowMs, graceMins: day.graceMins, timeZone: day.timeZone,
  });
  if (d.kind === 'refuse') throw scanError(FILL_IN_REFUSAL_STATUS[d.code] || 409, d.code, 'That fill-in could not be made.');
  if (d.kind === 'repeat') return { job, changed: false };
  // A newer version than the store holds, so the phone's order guard takes it (store/jobsMerge).
  return { job: { ...d.job, _rv: (Number(job._rv) || 0) + 1 }, changed: true };
}

// The route's two display extras on the demo's own data, by the SAME rules (lib/areaScan): the next
// clean from the store's jobs at the location — never the visit that already did the area, so the
// area's own `lastCleanedAt` goes in (QR-28) — and the last inspection from the demo's inspections
// there (QR-15). Shared with the hub's demo area page (lib/hubDemo area). Demo only.
export async function demoScanExtras(state, site, { nowMs = Date.now(), lastCleanedAt = null } = {}) {
  if (!STUB || !site?.id) return { nowMs, nextCleanOn: null, lastInspectionOn: null };
  const timeZone = state?.company?.timezone;
  let inspections = [];
  try { inspections = (await qcListInspections({ siteIds: [site.id] }))?.inspections || []; } catch { inspections = []; }
  return {
    nowMs,
    nextCleanOn: scanNextCleanDay({ jobs: state?.jobs || [], siteId: site.id, timeZone, nowMs, lastCleanedAt }),
    lastInspectionOn: scanLastInspectionDay(inspections, timeZone),
  };
}

// The customer hub's demo (lib/hubDemo.js scan) reads the demo's codes through here: a live code's
// `{ siteId, areaId }`, or null. Demo builds only — dead in production with everything above.
export function demoScanCodeFor(token) {
  if (!STUB || !isScanToken(token)) return null;
  const code = loadDb().codes.find((c) => c.token === token && !c.revoked_at);
  return code ? { siteId: code.site_id, areaId: code.area_id } : null;
}

async function stubPublicScan(token) {
  const db = loadDb();
  const code = db.codes.find((c) => c.token === token && !c.revoked_at);
  if (!code) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  const state = demoState();
  // The route's ONE location rule: a removed location or area, or an ARCHIVED customer (QR-27), is
  // the same "no longer active".
  const loc = scanLocationOf({ code: { siteId: code.site_id, areaId: code.area_id }, sites: state.sites, clients: state.clients });
  const site = loc ? demoSite(state, loc.siteId) : null;
  const area = loc ? { id: loc.areaId, label: loc.area } : null;
  if (!site || !area) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  const status = await qcAreaStatus({ siteId: site.id, cleaningAreas: [area] });
  const row = (status?.areas || []).find((a) => a.areaId === area.id) || { label: area.label, items: [], photo: null };
  const extras = await demoScanExtras(state, site, { lastCleanedAt: row.lastCleanedAt ?? null });
  const scan = projectAreaScan({
    building: demoBuilding(state, site),
    location: site.name,
    area: row,
    timeZone: state.company?.timezone,
    nowMs: extras.nowMs,
    nextCleanOn: extras.nextCleanOn,
    lastInspectionOn: extras.lastInspectionOn,
    phone: state.company?.phone || null,
  });
  // The demo keeps photos as data URLs in the browser, so the page can be handed the picture
  // itself — there is no storage path to hide.
  return { scan, photoUrl: scan.photo ? (row.photo?.thumbUrl || row.photo?.url || null) : null };
}

// ── the visitor's two writes, in the demo (the routes' twins, EP-414 / EP-415) ──────────────
// The same rules in the same order — the honeypot, the code, the input, the durable limits over a
// ledger kept beside the demo's codes, the code's location through the shared rule — and the
// ticket filed into the QC stub the office's lists read (lib/qcApi demoFileVisitorProblem), its
// photo into the media stub at the visitor's own scope. The phone's HMAC is a demo stand-in.
const demoRefusal = (code, message, status) => scanError(status, code, message);
const demoPhone = (deviceId) => `demo_${String(deviceId).slice(0, 38)}`.padEnd(43, '0').slice(0, 43);
function demoLiveLocation(token) {
  const code = isScanToken(token) ? loadDb().codes.find((c) => c.token === token && !c.revoked_at) : null;
  if (!code) return null;
  const state = demoState();
  const loc = scanLocationOf({ code: { siteId: code.site_id, areaId: code.area_id }, sites: state.sites, clients: state.clients });
  return loc ? { code, loc, state } : null;
}

async function stubVisitorReport(body) {
  if (visitorHoneypotFilled(body)) return { ok: true, message: VISITOR_REPORT_THANKS, photoSaved: null };
  const live = demoLiveLocation(body?.token);
  if (!live) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  const input = visitorReportInput(body);
  if (input.refused) throw demoRefusal(input.code, input.refused, visitorReportStatus(input.code));
  const v = input.value;
  const { code, loc } = live;
  const db = loadDb();
  const ledger = Array.isArray(db.visitorReports) ? db.visitorReports : [];
  const now = Date.now();
  const w = visitorLimitWindows(now);
  const phone = demoPhone(v.deviceId);
  const since = (iso) => (r) => r.created_at >= iso;
  const verdict = visitorLimitVerdict({
    sameRecent: ledger.filter((r) => r.code_id === code.id && r.device_hash === phone && r.choice === v.choice && since(w.sameSinceIso)(r)).length,
    phoneCodeHour: ledger.filter((r) => r.code_id === code.id && r.device_hash === phone && since(w.hourAgoIso)(r)).length,
    phoneDay: ledger.filter((r) => r.device_hash === phone && since(w.dayAgoIso)(r)).length,
    codeHour: ledger.filter((r) => r.code_id === code.id && since(w.hourAgoIso)(r)).length,
  });
  if (verdict.duplicate) return { ok: true, duplicate: true, message: VISITOR_REPORT_ALREADY, photoSaved: null };
  if (verdict.refused) throw demoRefusal(verdict.code, verdict.refused, visitorReportStatus(verdict.code));
  const ticket = demoFileVisitorProblem({
    id: v.id || undefined,
    clientId: loc.clientId, siteId: loc.siteId, clientName: loc.building, siteName: loc.siteName,
    ...visitorTicketInput({ choice: v.choice, text: v.text, areaLabel: loc.area }),
    siteAreaId: loc.areaId, reporterName: v.name, reporterContact: v.contact,
  });
  db.visitorReports = [
    ...ledger.filter((r) => r.created_at >= w.retentionCutoffIso),
    { problem_id: ticket.id, code_id: code.id, site_id: loc.siteId, area_id: loc.areaId, device_hash: phone, choice: v.choice, created_at: new Date(now).toISOString() },
  ];
  saveDb(db);
  let photoSaved = null;
  if (v.photo) {
    photoSaved = !!stubAttachDataUrl({
      dataUrl: `data:${v.photo.mimeType};base64,${v.photo.base64}`, mimeType: v.photo.mimeType,
      sizeBytes: Math.floor((v.photo.base64.length * 3) / 4), siteId: loc.siteId, clientId: loc.clientId,
      scope: 'visitor_report', refId: ticket.id,
    });
  }
  return { ok: true, message: VISITOR_REPORT_THANKS, photoSaved };
}

// The demo's votes: { ratings: [area_scan_ratings-shaped rows] }; absent, a placed week of them.
function loadRatings(timeZone) {
  try {
    const db = JSON.parse(localStorage.getItem(SCAN_RATINGS_STUB_KEY));
    if (db && Array.isArray(db.ratings)) return db;
  } catch { /* unreadable: start again */ }
  return { ratings: demoAreaRatings({ nowMs: Date.now(), dayOf: (ms) => ratingDay(ms, timeZone) }) };
}
function saveRatings(db) {
  try { localStorage.setItem(SCAN_RATINGS_STUB_KEY, JSON.stringify(db)); } catch { /* quota / private mode */ }
}

async function stubRateArea(body) {
  const live = demoLiveLocation(body?.token);
  if (!live) throw scanError(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  const input = areaRatingInput(body);
  if (input.refused) throw demoRefusal(input.code, input.refused, areaRatingStatus(input.code));
  const { code, loc, state } = live;
  const tz = state.company?.timezone || null;
  const now = Date.now();
  const day = ratingDay(now, tz);
  const phone = demoPhone(input.value.deviceId);
  const db = loadRatings(tz);
  const stamp = new Date(now).toISOString();
  const mine = db.ratings.find((r) => r.site_id === loc.siteId && r.area_id === loc.areaId && r.device_hash === phone && r.day === day);
  if (mine) {
    if (mine.value !== input.value.value) { mine.value = input.value.value; mine.updated_at = stamp; saveRatings(db); }
    return { ok: true, vote: input.value.vote, message: AREA_RATING_THANKS };
  }
  const hourAgo = new Date(now - 3600e3).toISOString();
  const dayAgo = new Date(now - 86400e3).toISOString();
  const verdict = areaRatingLimitVerdict({
    codeHour: db.ratings.filter((r) => r.code_id === code.id && r.created_at >= hourAgo).length,
    phoneDay: db.ratings.filter((r) => r.device_hash === phone && r.created_at >= dayAgo).length,
  });
  if (verdict.refused) throw demoRefusal(verdict.code, verdict.refused, areaRatingStatus(verdict.code));
  const cutoff = ratingRetentionCutoffDay(now, tz);
  db.ratings = [
    ...db.ratings.filter((r) => r.day >= cutoff),
    {
      id: `ar_${phone.slice(5, 13)}_${now.toString(36)}`, code_id: code.id, site_id: loc.siteId, client_id: loc.clientId,
      area_id: loc.areaId, value: input.value.value, device_hash: phone, day, created_at: stamp, updated_at: stamp,
    },
  ];
  saveRatings(db);
  return { ok: true, vote: input.value.vote, message: AREA_RATING_THANKS };
}

// The office's report, in the demo: the route's period and tally over the demo's votes and its
// saved record (EP-416's twin).
async function stubVisitorRatings({ days } = {}) {
  const d = ratingPeriodDays(days);
  if (d === null) throw scanError(400, 'days', 'Pick 7, 30 or 90 days.');
  const state = demoState();
  const tz = state.company?.timezone || null;
  const win = ratingPeriodWindow({ days: d, nowMs: Date.now(), timeZone: tz });
  const rows = loadRatings(tz).ratings.filter((r) => r.day >= win.fromDay && r.day <= win.toDay);
  return { days: d, ...win, ...visitorRatingsReport(rows, { sites: state.sites, clients: state.clients }) };
}
