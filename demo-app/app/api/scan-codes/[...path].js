// The OFFICE side of the QR codes (QR-1..QR-6): one code per cleaning area of a location,
// Replace for a stolen or moved label, and the two printable PDFs. The codes live in their
// own table (`area_scan_codes`, via api/_lib/scanCodes/store.js), never in the shared record.
//
// AUTH STANCE: requirePermission(SCAN_CODES_PERMISSION = 'sites.edit') — the key that edits
// the location's cleaning areas on the card these codes sit on — PLUS a role floor: crew
// never, whatever a per-user grant says (src/lib/scanCodes.scanCodesAllowed, the same rule
// the codes panel reads). Writes stamp WHO from the caller's verified claim, never the body.
//
//   POST /api/scan-codes/ensure  { siteId }                   → { siteId, building, location, base, codes }   (EP-260)
//   POST /api/scan-codes/replace { siteId, areaId }           → { code }                                       (EP-261)
//   POST /api/scan-codes/sheet   { siteId, layout, format, areaId?, position? } → application/pdf              (EP-262)
//   GET  /api/scan-codes/resolve?token=                       → { siteId, clientId, areaId, siteName, building, area } (EP-386)
//   POST /api/scan-codes/links   {}                           → { filename, csv, links, buildings, withoutAreas } (EP-412)
//   POST /api/scan-codes/fill-in { token, jobId, coverFor }   → { job, changed }                               (EP-419)
//   GET  /api/scan-codes/crew-area?token=[&userId=]           → { onClean, fillIn, info }                      (EP-420)
//
// ONE LABEL, FOR A DAMAGED ONE (EP-262's `areaId` + `position` — QR Wave 2, 2026-10-17; Matt, QR-9: "just
// one location on one site, if needed, if something gets damaged"): `areaId` prints only that area's
// label (an area the location does not have is 404, as Replace's is); `position` (labels only, a whole
// number on THAT sheet — src/lib/scanCodes labelPosition, else 400) puts it on that label of a partly
// used sheet. The same builder, the same door, the same gate and the same per-person print allowance.
//
// THE LINKS FOR THE OFFICE'S OWN LABEL SOFTWARE (EP-412 — QR Wave 1, 2026-10-16; Daniel: "he just
// needs the link for each unique scanpoint"): every live code of every building, as ONE spreadsheet
// (CSV, opens in Excel). The office branches' door (sites.edit + the office floor: crew never, a
// customer login refused at the gate), rate-limited per login (SCAN_LINKS_RATE). Reads `sites` +
// `clients` + the org's zone once, skips an ARCHIVED customer's building (UI_RULES §163), reads
// every live code COMPLETE (store.listLiveCodes, paged by id), mints the codes still missing in
// batches (store.ensureCodesForSites — idempotent: asked twice, it mints nothing the second time;
// `created_by` from the claim) and answers the file built by the ONE builder the building panel's
// "Download links" uses (src/lib/scanCodes scanLinkRows / scanLinksCsv). Nothing in the body is read.
// `withoutAreas` counts the live buildings with no cleaning areas yet, which the button reports.
//
// THE STAFF RESOLVE (EP-386 — the Cleaner Hub, D5, 2026-10-13; Matt: "a code posted on site opens that
// location's checklist directly"): the camera in the cleaner's app reads a code's URL and asks here
// WHERE it is. Its OWN door, before the office branches: any staff login (requireAuthority — a
// customer login holds no staff authority and is refused there; its own scan is EP-387 on /api/hub),
// for ANY live code of the org — a cleaner too, since QR Wave 2 (Matt's QR-14: "sometimes we might
// send cleaners as a filler … they also have to be able to scan and do the checklist"). Where that
// may lead stays crew-scoped: the answer names only where the code is (the minimal allowlist
// projectScanResolve), and everything a cleaner may DO there — read a checklist, submit one, the
// area's status, photos — is still judged by the cleaner's own cleans (CS-005), which a fill-in
// (EP-419) is what joins. An unknown, replaced, malformed or orphaned code (its location or area
// removed) is the public route's SAME 404 scan-code-inactive. Rate-limited per login
// (SCAN_RESOLVE_RATE). Reads the code row and the shared record's `sites` + `clients` (the
// location's customer — the public read's area_scan_site does not name it), never cached.
//
// THE CLEANER'S SCAN (QR Wave 2, 2026-10-17; UI_RULES §176 — the rules are src/lib/scanFillIn.js):
//   EP-420 GET crew-area?token=  — what a cleaner's scan finds at the code's location TODAY (the ORG's
//     day, lib/clockInWindow isOnTodayList): their OWN clean there (`onClean`, the row as the phone
//     adopts it) with the building's last inspection and open tickets (`info`, the allowlist
//     projectCrewAreaInfo — never a visitor's name or contact, a description or a note), or, not on
//     one, the fill-in offer (`fillIn`: its state and the scheduled cleaners who haven't clocked in,
//     key by key). Crew from the claim; an office login only previewing a cleaner (`?userId`,
//     api/_lib/crewPreview with `time.view` — the key that already shows who is on the clock), else
//     403 crew-only. Read only.
//   EP-419 POST fill-in { token, jobId, coverFor } — the cleaner fills in for someone on today's clean
//     there: R8's cover (lib/jobCover), written by the SERVER through jobsTable updateJobByServer
//     (a compare-and-swap on row_version, the decision re-made on each fresh read, the server's own
//     tab) — so the crew-protected fields (crewIds, coverFor, oneOff: jobsGuard) move only by this
//     rule, never by a crew tab's jobs delta. Crew from the claim (the office and the preview never
//     write here, 403 crew-only); the code live; the clean at the code's location, today, not done or
//     cancelled; `coverFor` an active cleaner on it who hasn't clocked in, and not the caller; the
//     caller already on it → success, nothing written. Then the activity log (`job.filled_in`) and
//     the building's account manager (notifyFillIn, the account-alert fan-out). 10/min per login.
//     A scan writes NOTHING about time (QR-13: "GPS only").
//
// A code encodes the app's PERMANENT address + /scan/<token>: api/_lib/appUrl appPublicUrl()
// (APP_PUBLIC_URL, else APP_BASE_URL, else the brand pack's own address — www.cleancorner.app for
// Clean Space), the emailed links' rule, because a printed label outlives every alias the office
// might be browsing (CS-111: a code minted on the old cleanspace-gilt.vercel.app alias would have
// printed that alias). The office request's own origin is the last resort, read only when no
// address is configured at all. Never a host written into the code (src/lib/areaScan).
import { requirePermission, requireAuthority } from '../_lib/authz.js';
import { appPublicUrl } from '../_lib/appUrl.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { allow } from '../_lib/rateLimit.js';
import { idParam } from '../_lib/queryParams.js';
import { readScanSite, ensureCodesForSite, ensureCodesForSites, replaceCode, resolveScanToken } from '../_lib/scanCodes/store.js';
import { lastInspectionAt, openTicketsAt, notifyFillIn } from '../_lib/scanCodes/crewArea.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { getJobRowsAtSite, updateJobByServer } from '../_lib/jobsTable.js';
import { punchedUserIdsByJob } from '../_lib/time/store.js';
import { crewReadSubject } from '../_lib/crewPreview.js';
import { logActivityAs } from '../_lib/activityLog.js';
import { buildSheetHtml, renderScanSheetPdf } from '../_lib/scanCodes/sheetPdf.js';
import { scanBaseUrl, scanUrl, scanTimeZone, isScanToken, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE } from '../../src/lib/areaScan.js';
import {
  SCAN_CODES_PERMISSION, scanCodesAllowed, isLabelFormat, DEFAULT_LABEL_FORMAT, SHEET_LAYOUTS, scanSheetFilename, labelPosition,
  scanLocationOf, projectScanResolve, SCAN_RESOLVE_RATE,
  scanAreasOf, scanLinkBuildings, scanLinkRows, scanLinksCsv, scanLinksFilename, SCAN_LINKS_RATE,
} from '../../src/lib/scanCodes.js';
import {
  fillInPlan, fillInDecision, projectFillInCandidates, projectCrewAreaInfo,
  FILL_IN_REFUSAL_STATUS, SCAN_CREW_AREA_RATE, SCAN_FILL_IN_RATE,
} from '../../src/lib/scanFillIn.js';
import { isOnTodayList } from '../../src/lib/clockInWindow.js';
import { dayKey, addDaysKey, startOfDayKey } from '../../src/lib/dates.js';
import { msg } from '../../src/i18n/core.js';

// maxDuration: `sheet` launches headless Chromium (cold start + render), like the inspection
// and quote PDFs.
export const config = { maxDuration: 60 };

// A print is a Chromium launch: bound it per person (an office member printing a building's
// labels needs one or two).
const SHEET_RATE = { limit: 12, windowMs: 60 * 1000 };

const first = (v) => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();

// The address a printed code points at: the app's permanent one (appPublicUrl, above), else —
// only when no address is configured at all — this request's own Origin (a browser POST always
// carries it), else the host it reached. Each is checked to be an http(s) origin; none is a
// literal.
function codeBase(req) {
  const h = req.headers || {};
  const host = first(h['x-forwarded-host']) || first(h.host);
  const proto = first(h['x-forwarded-proto']) || 'https';
  return scanBaseUrl({ appPublicUrl: appPublicUrl(), origin: first(h.origin) })
    || (host ? scanBaseUrl({ origin: `${proto}://${host}` }) : null);
}

const shape = (base, { area, code }) => ({
  areaId: area.id,
  label: area.label,
  token: code.token,
  url: scanUrl(base, code.token),
  createdAt: code.created_at || null,
});

export default function handler(req, res) {
  return withRequestCache(() => scanCodesHandler(req, res));
}

const inactive = (res) => res.status(404).json({ error: SCAN_INACTIVE_MESSAGE, code: SCAN_INACTIVE_CODE });

// EP-386 (see the header): the cleaner's camera, and any staff login's.
async function resolveForStaff(req, res) {
  const a = await requireAuthority(req, res);
  if (!a) return undefined;
  if (!allow(req, res, { bucket: 'scan_resolve', id: a.orgUserId || a.email || 'unknown', ...SCAN_RESOLVE_RATE, code: 'rate-limited' })) return undefined;
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  // A malformed token costs no read.
  if (!isScanToken(token)) return inactive(res);
  const code = await resolveScanToken(token);
  if (!code) return inactive(res);
  const data = await readProtectedSlices('sites:state->sites,clients:state->clients');
  const sites = Array.isArray(data && data.sites) ? data.sites : [];
  const loc = scanLocationOf({ code, sites, clients: Array.isArray(data && data.clients) ? data.clients : [] });
  if (!loc) return inactive(res);
  return res.status(200).json(projectScanResolve(loc));
}

// ── QR Wave 2: the cleaner's scan (EP-420, EP-419; see the header) ───────────────────────────
const arr = (v) => (Array.isArray(v) ? v : []);
const isCrew = (a) => a?.role === 'crew';
const crewOnly = (res) => res.status(403).json({ error: 'This is for a cleaner’s own scan.', code: 'crew-only' });
// The office's preview of a cleaner's scan reads who is on the clock there: the key that already
// shows the office that (Variance's "On the clock now", the Time Clock).
const CREW_AREA_PREVIEW_KEY = 'time.view';
// A row as a crew phone adopts it: its payload with the server's version beside it (the reducer's
// order guard, store/jobsMerge applyJobPatch).
const jobForPhone = (row) => (row?.data ? { ...row.data, _rv: row.row_version ?? 0 } : null);
// The sentence behind each refusal (CS-077: a sentence and a stable code, never an internal word).
const FILL_IN_REFUSAL_MESSAGE = Object.freeze({
  'fill-in-not-found': 'That clean could not be found.',
  'fill-in-wrong-location': 'That clean is not at this building.',
  'fill-in-cancelled': 'That clean was cancelled.',
  'fill-in-not-today': 'That clean is not today.',
  'fill-in-done': 'That clean is already done.',
  'fill-in-template': 'Ask your manager to add you to this clean.',
  'fill-in-self': 'Pick the person you are filling in for.',
  'fill-in-not-on-clean': 'That person is not on this clean.',
  'fill-in-clocked-in': 'That person has already clocked in here.',
});

// The code's location and what the cleaner's scan reads beside it, once: the location's customer,
// the roster's active members (their names travel as written), the org's zone and today's frame.
// null = the code is dead (the same 404 as everywhere).
async function scanDay(token) {
  const code = await resolveScanToken(token);
  if (!code) return null;
  const data = await readProtectedSlices('sites:state->sites,clients:state->clients,users:state->users,tz:state->company->>timezone,grace:state->opsSettings->autoCloseGraceMins');
  const sites = arr(data && data.sites);
  const loc = scanLocationOf({ code, sites, clients: arr(data && data.clients) });
  if (!loc) return null;
  const users = arr(data && data.users);
  const timeZone = scanTimeZone(data && data.tz);
  const nowMs = Date.now();
  const todayKey = dayKey(new Date(nowMs), timeZone);
  const grace = Number(data && data.grace);
  return {
    loc,
    site: sites.find((s) => s && s.id === loc.siteId) || null,
    users,
    activeUserIds: users.filter((u) => u && u.id && u.status === 'active').map((u) => u.id),
    timeZone, nowMs, todayKey,
    graceMins: Number.isFinite(grace) ? grace : undefined,
    // Today's cleans start today in the org's zone; an earlier day's stays on today's list while its
    // clock-in window is open (CS-052), so the read reaches two days back.
    fromIso: startOfDayKey(addDaysKey(todayKey, -2), timeZone).toISOString(),
    toIso: startOfDayKey(addDaysKey(todayKey, 1), timeZone).toISOString(),
  };
}
const dayOpts = (d) => ({ todayKey: d.todayKey, nowMs: d.nowMs, graceMins: d.graceMins, timeZone: d.timeZone });

// EP-420.
async function crewAreaForScan(req, res) {
  const a = await requireAuthority(req, res);
  if (!a) return undefined;
  if (!allow(req, res, { bucket: 'scan_crew_area', id: a.orgUserId || a.email || 'unknown', ...SCAN_CREW_AREA_RATE, code: 'rate-limited' })) return undefined;
  const subject = await crewReadSubject(a, req.query.userId, CREW_AREA_PREVIEW_KEY);
  if (subject.status) return res.status(subject.status).json({ error: subject.error, code: subject.code });
  if (!subject.userId || (!subject.preview && !isCrew(a))) return crewOnly(res);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!isScanToken(token)) return inactive(res);
  const day = await scanDay(token);
  if (!day) return inactive(res);
  const rows = await getJobRowsAtSite(day.loc.siteId, { startFrom: day.fromIso, startTo: day.toIso });
  const today = rows.filter((r) => isOnTodayList(r.data, day.todayKey, day.nowMs, day.graceMins, day.timeZone));
  const punchedByJob = await punchedUserIdsByJob(today.map((r) => r.data.id));
  const plan = fillInPlan({
    jobs: today.map((r) => r.data), siteId: day.loc.siteId, clientId: day.loc.clientId, userId: subject.userId,
    punchedByJob, activeUserIds: day.activeUserIds, ...dayOpts(day),
  });
  if (plan.onClean) {
    const [inspection, open] = await Promise.all([lastInspectionAt(day.loc.siteId), openTicketsAt(day.loc.siteId)]);
    return res.status(200).json({
      onClean: jobForPhone(today.find((r) => r.data.id === plan.onClean.id)),
      fillIn: null,
      info: projectCrewAreaInfo({ inspection, tickets: open.tickets, ticketsTotal: open.total, site: day.site }),
    });
  }
  return res.status(200).json({
    onClean: null,
    fillIn: { state: plan.state, candidates: projectFillInCandidates(plan.candidates) },
    info: null,
  });
}

// EP-419.
async function fillInFromScan(req, res) {
  const a = await requireAuthority(req, res);
  if (!a) return undefined;
  if (!isCrew(a) || !a.orgUserId) return crewOnly(res);
  if (!allow(req, res, { bucket: 'scan_fill_in', id: a.orgUserId, ...SCAN_FILL_IN_RATE, code: 'rate-limited' })) return undefined;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const token = typeof body.token === 'string' ? body.token : '';
  if (!isScanToken(token)) return inactive(res);
  const jobId = idParam(body.jobId);
  const coverFor = idParam(body.coverFor);
  if (!jobId || !coverFor) return res.status(400).json({ error: 'Say which clean and who you are filling in for.', code: 'bad-request' });
  const day = await scanDay(token);
  if (!day) return inactive(res);
  const outcome = await updateJobByServer(jobId, async (row) => {
    const punched = row ? (await punchedUserIdsByJob([jobId])).get(jobId) : null;
    const d = fillInDecision({
      job: row ? row.data : null, loc: day.loc, userId: a.orgUserId, coverFor, punched,
      activeUserIds: day.activeUserIds, ...dayOpts(day),
    });
    return d.kind === 'write' ? { write: d.job } : d;
  }, { updatedBy: a.user?.id || null });
  if (outcome.contended) return res.status(503).json({ error: 'This clean is being changed right now. Try again.', code: 'fill-in-contended' });
  if (!outcome.written) {
    const d = outcome.result || {};
    if (d.kind === 'repeat') return res.status(200).json({ job: jobForPhone(outcome.prev), changed: false });
    return res.status(FILL_IN_REFUSAL_STATUS[d.code] || 409).json({ error: FILL_IN_REFUSAL_MESSAGE[d.code] || 'That fill-in could not be made.', code: d.code || 'fill-in-refused' });
  }
  const before = outcome.prev.data;
  const after = outcome.written.data;
  const nameOf = (id) => day.users.find((u) => u && u.id === id)?.name || id;
  const place = day.loc.building || day.loc.siteName || '';
  // Who did what, best-effort (the log never fails the action): the crew before and after, and who
  // covers whom.
  await logActivityAs(a, {
    action: 'job.filled_in',
    entityId: jobId,
    clientId: after.clientId || day.loc.clientId || null,
    clientName: day.loc.building || null,
    summary: `${nameOf(a.orgUserId)} filled in for ${nameOf(coverFor)} at ${place} from a QR scan`,
    before: { crewIds: arr(before.crewIds), coverFor: before.coverFor ?? null },
    after: { crewIds: arr(after.crewIds), coverFor: after.coverFor ?? null },
  });
  // The building's account manager hears it, in their own language; the names and the building
  // travel as written.
  await notifyFillIn({
    clientId: after.clientId || day.loc.clientId || null,
    title: msg('alerts.fillIn.title', { name: nameOf(a.orgUserId), covered: nameOf(coverFor), place }),
    body: msg('alerts.fillIn.body', { start: after.startAt || null }),
    url: `/schedule/${encodeURIComponent(jobId)}`,
    actorUserId: a.orgUserId,
  });
  return res.status(200).json({ job: jobForPhone(outcome.written), changed: true });
}

const noAddress = (res) => res.status(503).json({ error: 'This deploy has no public address for the codes yet. Set APP_PUBLIC_URL.', code: 'scan-base-missing' });

// EP-412 (see the header): every building's links as one spreadsheet. `g` has passed the office
// branches' door already.
async function linksForOffice(req, res, g) {
  if (!allow(req, res, { bucket: 'scan_links', id: g.orgUserId || g.email || 'unknown', ...SCAN_LINKS_RATE, code: 'rate-limited' })) return undefined;
  const base = codeBase(req);
  if (!base) return noAddress(res);
  const data = await readProtectedSlices('sites:state->sites,clients:state->clients,tz:state->company->>timezone');
  const { buildings, withoutAreas } = scanLinkBuildings({
    sites: Array.isArray(data && data.sites) ? data.sites : [],
    clients: Array.isArray(data && data.clients) ? data.clients : [],
  });
  let live;
  try {
    ({ live } = await ensureCodesForSites({ sites: buildings.map((b) => b.site), createdBy: g.orgUserId }));
  } catch (e) {
    const status = readErrorStatus(e);
    if (status === 500) throw e;
    // A read that came back short (or too wide) is never a partial spreadsheet: say so, try again.
    console.error('[api/scan-codes] links', e?.name || 'read');
    return res.status(status).json({ error: 'The codes could not all be read just now. Try again in a minute.', code: 'scan-links-incomplete' });
  }
  const timeZone = scanTimeZone(data && data.tz);
  const rows = [];
  for (const { site, client } of buildings) {
    const codes = live.get(site.id) || new Map();
    rows.push(...scanLinkRows({
      client,
      site,
      timeZone,
      codes: scanAreasOf(site).map((area) => {
        const code = codes.get(area.id);
        return code ? { label: area.label, url: scanUrl(base, code.token), createdAt: code.created_at || null } : null;
      }).filter(Boolean),
    }));
  }
  return res.status(200).json({
    filename: scanLinksFilename({ dateKey: dayKey(new Date(), timeZone) }),
    csv: scanLinksCsv(rows),
    links: rows.length,
    buildings: buildings.length,
    withoutAreas,
  });
}

async function scanCodesHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    if (action === 'resolve' && req.method === 'GET') return await resolveForStaff(req, res);
    if (action === 'crew-area' && req.method === 'GET') return await crewAreaForScan(req, res);
    if (action === 'fill-in' && req.method === 'POST') return await fillInFromScan(req, res);
    if (!['ensure', 'replace', 'sheet', 'links'].includes(action) || req.method !== 'POST') {
      return res.status(404).json({ error: 'Unknown route.', code: 'not-found' });
    }
    const g = await requirePermission(req, res, SCAN_CODES_PERMISSION);
    if (!g) return undefined;
    if (!scanCodesAllowed(g.role, true)) {
      return res.status(403).json({ error: 'QR codes are managed by the office.', code: 'office-only' });
    }
    if (action === 'links') return await linksForOffice(req, res, g);

    const siteId = idParam(body.siteId);
    if (siteId === undefined) return res.status(400).json({ error: 'siteId is malformed.', code: 'bad-request' });
    if (!siteId) return res.status(400).json({ error: 'siteId is required.', code: 'bad-request' });

    if (action === 'sheet') {
      if (!Object.values(SHEET_LAYOUTS).includes(body.layout)) {
        return res.status(400).json({ error: 'layout must be labels or sheet.', code: 'bad-request' });
      }
      if (body.format != null && !isLabelFormat(body.format)) {
        return res.status(400).json({ error: 'That label sheet is not one the app knows.', code: 'bad-request' });
      }
      if (idParam(body.areaId) === undefined) return res.status(400).json({ error: 'areaId is malformed.', code: 'bad-request' });
      if (body.position != null) {
        if (body.layout !== SHEET_LAYOUTS.LABELS) {
          return res.status(400).json({ error: 'A position is for a label sheet.', code: 'bad-request' });
        }
        if (!labelPosition(body.format == null ? DEFAULT_LABEL_FORMAT : body.format, body.position)) {
          return res.status(400).json({ error: 'That position is not on this label sheet.', code: 'bad-request' });
        }
      }
      if (!allow(req, res, { bucket: 'scan_sheet', id: g.orgUserId || g.email || 'unknown', ...SHEET_RATE, code: 'rate-limited' })) return undefined;
    }

    const site = await readScanSite(siteId);
    if (!site) return res.status(404).json({ error: 'That location could not be found.', code: 'not-found' });
    const base = codeBase(req);
    if (!base) return noAddress(res);
    const building = site.clientName || site.name || null;

    if (action === 'replace') {
      const areaId = idParam(body.areaId);
      if (!areaId) return res.status(400).json({ error: 'areaId is required.', code: 'bad-request' });
      const r = await replaceCode({ site, areaId, by: g.orgUserId });
      if (r.notFound) return res.status(404).json({ error: 'That area is no longer on this location.', code: 'not-found' });
      return res.status(200).json({ code: shape(base, r) });
    }

    const pairs = await ensureCodesForSite({ site, createdBy: g.orgUserId });
    const codes = pairs.map((p) => shape(base, p));

    if (action === 'ensure') {
      return res.status(200).json({ siteId, building, location: site.name || null, base, codes });
    }

    // action === 'sheet'
    if (!codes.length) return res.status(409).json({ error: 'Add a cleaning area to this location first.', code: 'no-areas' });
    const areaId = idParam(body.areaId);
    const printed = areaId ? codes.filter((c) => c.areaId === areaId) : codes;
    if (!printed.length) return res.status(404).json({ error: 'That area is no longer on this location.', code: 'not-found' });
    const format = body.format == null ? DEFAULT_LABEL_FORMAT : body.format;
    const position = body.position == null ? 1 : body.position;
    const html = await buildSheetHtml({ layout: body.layout, format, building, location: site.name, codes: printed, position });
    const pdf = await renderScanSheetPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    const area = areaId ? printed[0].label || 'area' : '';
    res.setHeader('Content-Disposition', `attachment; filename="${scanSheetFilename({ layout: body.layout, format, building, area })}"`);
    return res.status(200).send(Buffer.from(pdf));
  } catch (e) {
    // CS-077: the detail is logged here; the office gets a sentence and a code.
    console.error('[api/scan-codes]', action || '?', e?.code || e?.name || 'error', e?.message || '');
    return res.status(500).json({ error: 'Something went wrong with the QR codes. Try again.', code: 'scan_codes_server_error' });
  }
}
