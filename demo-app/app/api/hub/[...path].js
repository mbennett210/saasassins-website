// THE CUSTOMER HUB — the only API family a client login may reach.
//
//   GET  /api/hub/view                                   -> { viewer, brandName, timezone, groups[], buildings[] }
//   GET  /api/hub/home?buildingId                        -> { building, crew, requests, checklists, inspections, resolve }  EP-305
//   GET  /api/hub/visit?buildingId                       -> { crew, onSite[], timeline[], photos, upcoming[], manager }  EP-306
//   GET  /api/hub/checklists?buildingId[&offset&limit]   -> { rows[], total, offset, limit }         HUB-8
//   GET  /api/hub/checklist?buildingId&id                -> { checklist }  every item, notes, photos  HUB-8/15
//   GET  /api/hub/inspections?buildingId[&offset&limit]  -> { rows[], total, offset, limit }         HUB-6
//   GET  /api/hub/inspection?buildingId&id               -> { inspection } the report + the redo     HUB-6/7
//   GET  /api/hub/inspection-pdf?buildingId&id           -> application/pdf                          HUB-10
//   GET  /api/hub/tickets?buildingId[&offset&limit]      -> { rows[], total, offset, limit }         HUB-13
//   GET  /api/hub/ticket?buildingId&id                   -> { ticket } its conversation + photos     WO-8/9/10
//   POST /api/hub/ticket-create  { id, buildingId, type, category, description, urgent?, siteAreaId? } -> { ticket }  HUB-13, WO-4
//        (siteAreaId, QR-16: one of the building's own areas, else 400 area-unknown; the request's
//        `area` — its NAME — rides on the request rows and page)
//   POST /api/hub/ticket-message { id, buildingId, ticketId, body }  -> { message }                 HUB-13
//   POST /api/hub/ticket-reopen  { buildingId, ticketId }            -> { ticket }                  WO-11
//   POST /api/hub/ticket-photo-url { buildingId, ticketId, mimeType, sizeBytes } -> { path, token, signedUrl, thumb }
//   POST /api/hub/ticket-photo   { id?, buildingId, ticketId, storagePath, thumbPath?, mimeType, sizeBytes } -> { photo }
//   GET  /api/hub/history?buildingId[&offset&limit]      -> { events[], total, offset, limit }       HUB-9, LOG-1/9
//   (client hub redesign, plan §3.4 — Builder B)
//   GET  /api/hub/messages?buildingId[&before&limit]     -> { messages[], hasMore, manager }         one thread per building
//   POST /api/hub/message        { id, buildingId, body } -> { message }                              routed by Matt's rule
//   POST /api/hub/messages-read  { buildingId, at? }      -> { readAt }
//   GET  /api/hub/updates                                -> { updates[], unseen, seenAt, messagesUnread[] }   the bell
//   POST /api/hub/updates-seen                           -> { seenAt }
//   GET  /api/hub/email-prefs                            -> { prefs }                               the customer's own switches
//   POST /api/hub/email-prefs    { messages?, requests?, inspections? } -> { prefs }
//   (Crew on the way, 2026-11-03 — lib/crewOnTheWay.js; Daniel's picks "A · Row on Home + Account")
//   GET  /api/hub/push?endpoint                           -> { on }       is THIS phone signed up for the caller's alerts
//   POST /api/hub/push           { subscription, deviceLabel? } -> { on: true }   turn alerts on for this phone
//   POST /api/hub/push-off       { endpoint }             -> { on: false }        turn them off for this phone
//   GET  /api/hub/invoices?buildingId[&offset&limit]     -> { state, rows[], total, offset, limit, summary, asOf }  redesign §3.5
//   GET  /api/hub/invoice-pdf?buildingId&id              -> application/pdf (Intuit's)                redesign §3.5
//   GET  /api/hub/documents?buildingId                   -> { agreement, documents[] }                redesign §3.6
//   GET  /api/hub/document-url?buildingId&id             -> { url, expiresIn }  id = uuid | 'agreement'  redesign §3.6
//   GET  /api/hub/face?buildingId&v                      -> image/jpeg | image/png  a team member's photo, by its version (HUB-19)
//   (the last four: api/_lib/clientHub/branches/invoicesDocuments.js)
//   (the Cleaner Hub, D5, 2026-10-13 — Builder D)
//   GET  /api/hub/scan?token                             -> { buildingId, areaId, building, area }  EP-387
//        Matt: the QR code "on the client hub as well". The customer's camera reads a code's URL and
//        asks here which building it is: an unknown / replaced / malformed / orphaned code, or one at
//        an ARCHIVED customer's building (QR-27), is the public route's SAME 404 scan-code-inactive;
//        a code at a building OUTSIDE the caller's scope is 403 not-your-building (the preview's
//        scope is its one building); the answer is the allowlist src/lib/scanCodes projectHubScan.
//        Rate-limited per login. The page opens that area's own page (QR-16, below).
//   (QR Wave 2, 2026-10-17 — Builder P)
//   GET  /api/hub/area?buildingId&areaId                 -> { scan, photoUrl }                      EP-421
//        Matt (QR-16): a customer's scan opens "that area's own page: when it was last cleaned, the
//        photo, what was done, and a button to make a request about it". The building must be in
//        the caller's scope and the area one of its location's cleaning areas, else the hub's 404
//        that names nothing. The answer is src/lib/areaScan projectHubArea: the PUBLIC page's own
//        allowlist projection (no cleaner, note, result or checklist name) — with the next clean and
//        the last inspection as dates (QR-28, QR-15) — plus a short-lived signed URL of the winning
//        photo's thumbnail, beside a recorded clean only. A read: it works in any preview (§151).
//
// AUTH STANCE: `requireHubCaller` (api/_lib/authz.js) on EVERY request, before the branch is
// even looked up. For a customer it is requireClientUser, unchanged — a login whose JWT claim is
// `role: 'client'` plus a `client_user_id`, whose public.client_users row exists and is not
// disabled. A STAFF login is refused (403 `office-login`): the hub is not a second view of the
// office app, it is a different audience — with ONE exception, the office's "Preview as customer"
// (plan 2026-10-08 §3.7, decision D2): a staff login sending the preview header AND holding
// `hub.users.view` (claims-first, never crew) uses exactly one building, the one named, scoped to
// that building only while it is in the live customer book (else 404 everywhere). Since 2026-10-09
// (Daniel: "swapping the role should simulate being signed into that account") it ACTS AS THE
// BUILDING'S STAND-IN CUSTOMER (store.js ensurePreviewStandIn; src/lib/hubPreview.js): every branch
// runs with that client_users row as the caller, so every write is a customer's write and reaches
// the office as one. With HUB_PREVIEW_ACTS_AS_CUSTOMER off it is the read-only preview again: no
// stand-in, the bell / the switches / every "mine" nobody's, and EVERY write refused (403
// `preview-read-only`) before a branch is looked up. Either way the viewer the view names is
// "Preview customer", with no address. A customer's header is ignored. The mirror rule lives in
// the same file — every office gate refuses role 'client'. So an unknown branch is a 401 to nobody
// and a 404 to a client, never a probe that answers first.
//
// 🔴 THE SCOPE IS RESOLVED HERE, NEVER SENT BY THE CALLER. Which buildings this person may see
// is read from public.client_user_assignments + the groups they are in, against the live
// customer book (store.js resolveScopeForClientUser → the pure rule in src/lib/clientHub.js).
// An ARCHIVED customer is not in that book (CS-663: its hub logins lose access, and a preview of
// it is a 404), so nothing below ever serves or writes it. A caller names a building, and every branch below starts by checking that name against
// `allowedIds`: a building outside it, and any record whose own building is not that building,
// is a 404 that never confirms the record exists. The record reads put the building IN THE
// QUERY (clientHub/reads.js), so a foreign id comes back as nothing rather than as a row a
// branch must remember to compare.
//
// 🔴 EVERY ANSWER IS BUILT FROM AN ALLOWLIST (src/lib/clientHubView.js, shared with the demo),
// never by deleting fields: the rows behind it carry pay, coordinates, internal notes, share
// tokens and storage keys. An inspection's internal note is never even SELECTED (HUB-16), and
// an internal ticket note is excluded in the thread's query (WO-9).
//
// TEAM PHOTOS (HUB-19; Matt's "Your Account Manager", 2026-11-02): `view`, `home`, `visit`,
// `checklists` and `checklist` name the photo of each team member they already name (the
// building's manager, the cleaners on the visit or on site, a checklist's cleaner) by its VERSION
// only, { v } (src/lib/hubFaces.js), and `face` answers that version's image. A signed link would
// carry the photo's path and with it the member's id, which the hub never serves; a customer
// cannot reach /api/avatars/urls (staff only) either.
//
// 🔴 ERRORS ARE A SENTENCE AND A CODE (CS-077 class): the provider's words go to the server log,
// never to the customer. Round 1's two `e.message` / `detail` leaks are closed here.
//
// WRITES go through the office's own store path (api/_lib/qc/store.js): a hub ticket is
// `origin: 'portal'`, so Wave 1's supervisor-first bell (notifyTicketRaised) and the repeat
// walker treat it exactly as the office's queue does. The raiser and every message's author
// are stamped from the verified claim, never from the body. Ids are CALLER-MINTED (THE LAW
// II.7) and read back first, so a double-tap is one ticket and one message.
//
// TIME IS THE ORG'S ZONE: the context reads `company.timezone` from the shared record (as
// api/supplies does) and every "today" below is that zone's day (src/lib/hubVisit.js).
//
// Cache-Control: private, no-store — per-login and authority-bearing (playbook II.7).
import { randomUUID } from 'node:crypto';
import { requireHubCaller } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { resolveScopeForClientUser, ensurePreviewStandIn } from '../_lib/clientHub/store.js';
import * as reads from '../_lib/clientHub/reads.js';
import {
  createProblem, notifyTicketRaised, notifyClientReplied, addWorkOrderMessage, reopenProblem, projectReport,
  areaStatusForSite,
} from '../_lib/qc/store.js';
import { renderInspectionReportPdf, inspectionPdfFilename } from '../_lib/qc/reportPdf.js';
import { serviceEventsForClient, logActivity, logActivityAs } from '../_lib/activityLog.js';
import { checklistEventDetail } from '../../src/lib/activityLog.js';
import { validateUpload, signedUploadUrl, confirmUpload, thumbPathFor, signMediaRow } from '../_lib/accountMedia/store.js';
import { isValidStoragePath } from '../_lib/accountMedia/refs.js';
import { readAvatar } from '../_lib/avatars.js';
import { hit } from '../_lib/rateLimit.js';
import { resolveScanToken, scanCleansAhead, scanLastInspectionAt } from '../_lib/scanCodes/store.js';
import { isScanToken, projectHubArea, scanNextCleanDay, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE } from '../../src/lib/areaScan.js';
import { scanLocationOf, scanAreasOf, projectHubScan, HUB_SCAN_NOT_YOURS_CODE, SCAN_RESOLVE_RATE } from '../../src/lib/scanCodes.js';
import {
  projectHubBuilding, buildHubView, projectHubViewBuilding, projectHubGroups,
} from '../../src/lib/clientHub.js';
import {
  hubWindowStartIso, hubPage, hubOnSiteList, HUB_ON_SITE_HOURS,
  projectHubChecklistRow, projectHubChecklist, projectHubInspectionRow, projectHubInspection,
  projectHubTicketRow, projectHubTicket, projectHubMessage, projectHubPhoto, projectHubEvent, hubHistoryPage,
  hubTicketInput, hubMessageInput,
} from '../../src/lib/clientHubView.js';
import {
  hubVisitStatus, hubVisitWindow, hubUpcomingVisits, projectHubCrew, projectHubVisit, projectHubVisitPhotos,
  projectHubManager, HUB_UPCOMING_MAX,
} from '../../src/lib/hubVisit.js';
import {
  hubRequestCounts, hubChecklistTile, hubInspectionTile, hubResolveTile, projectHubHome, HUB_TILE_PHOTO_MAX, HUB_RESOLVE_DAYS,
} from '../../src/lib/hubHome.js';
import {
  woClientStage, ticketReopenRefusal, REOPEN_NOT_COMPLETED, REOPEN_WINDOW_CLOSED, WO_STATUSES,
  ticketAreaInput, ticketAreaLabel, AREA_CODES,
} from '../../src/lib/workOrders.js';
import { resolveAccountSupervisor } from '../../src/lib/notifications.js';
import { dayKey, DEFAULT_ORG_TIMEZONE } from '../../src/lib/dates.js';
import { IDENTITY } from '../../src/brand/identity.generated.js';
import { isArchivedCustomer } from '../../src/lib/customerStatus.js';
import { isPhotoVersion, photoVersionOf } from '../../src/lib/userPhoto.js';
import { hubFaceOf } from '../../src/lib/hubFaces.js';
// ── Builder B: messages + updates + email prefs (client hub redesign) ──
import * as hubMessages from '../_lib/clientHub/messages.js';
import { hubMessageBodyInput, readMarkerAt, HUB_MESSAGE_RATE, finishHubUpdates } from '../../src/lib/hubMessages.js';
import { hubEmailPrefsInput, resolveHubEmailPrefs, HUB_EMAIL_PREFS_REFUSAL } from '../../src/lib/hubEmailPrefs.js';
import { invoiceAndDocumentBranches } from '../_lib/clientHub/branches/invoicesDocuments.js';
import * as clientPush from '../_lib/clientHub/push.js';
import { hubPushInput, hubPushEndpoint, HUB_PUSH_CODES } from '../../src/lib/crewOnTheWay.js';
// ── Builder D: the office's read-only "Preview as customer" (client hub redesign §3.7) ──
import {
  HUB_PREVIEW_READ_ONLY, HUB_PREVIEW_SENTENCES, HUB_PREVIEW_VIEWER, hubPreviewActsAsCustomer,
} from '../../src/lib/hubPreview.js';

// The inspection PDF launches headless chromium (the qc route's reason, the same renderer).
export const config = { maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// A client may attach this many photos to one ticket. A ticket's photo shows the problem; it
// is not an album, and every one is signed on every read of the ticket.
export const HUB_TICKET_PHOTO_MAX = 5;

// Per-login limits, per instance (api/_lib/rateLimit.js says exactly what that does and does
// not stop). Generous for a person, tight for a loop; the PDF is the expensive one.
const LIMITS = {
  'ticket-create': { limit: 20, windowMs: 3600000 },
  'ticket-message': { limit: 120, windowMs: 3600000 },
  'ticket-reopen': { limit: 30, windowMs: 3600000 },
  'ticket-photo': { limit: 60, windowMs: 3600000 },
  'inspection-pdf': { limit: 20, windowMs: 600000 },
  // ── Builder B: messages + email prefs (client hub redesign) ──
  message: HUB_MESSAGE_RATE,
  'email-prefs': { limit: 60, windowMs: 3600000 },
  // Crew on the way's phone alerts: a person turning one switch on and off, not a loop.
  push: { limit: 30, windowMs: 3600000 },
  // ── Builder C: invoices + documents (client hub redesign) ──
  // An invoice PDF is fetched from Intuit per request: the inspection PDF's bound.
  'invoice-pdf': { limit: 20, windowMs: 600000 },
  // A document link is cheap, but each is a signed URL to a private file.
  'document-url': { limit: 60, windowMs: 600000 },
  // ── Builder D (the Cleaner Hub): a scan is a person at a wall, not a loop walking tokens ──
  scan: SCAN_RESOLVE_RATE,
  // A team member's photo (HUB-19): each is read from Storage, then kept by the browser for a
  // year, so a person meets this only on a first visit (a checklists page names up to 20 cleaners).
  face: { limit: 120, windowMs: 600000 },
};

// ── answers ───────────────────────────────────────────────────────────────────
// The customer's word for a ticket is "request" (Matt's word, decision D6, 2026-10-08); the codes
// keep their names, so a caller's handling never changes.
const SENTENCES = {
  'not-found': "We couldn't find that. It may have been removed, or it isn't one of your buildings.",
  'read-failed': "This couldn't be loaded just now. Try again in a moment.",
  'save-failed': "That couldn't be saved just now. Try again in a moment.",
  'pdf-failed': "The PDF couldn't be made just now. Try again in a moment.",
  'too-many-requests': "That's a lot of requests in a short time. Wait a moment and try again.",
  'ticket-id': 'This request could not be saved. Refresh the page and try again.',
  'message-id': 'This message could not be sent. Refresh the page and try again.',
  'photo-id': 'This photo could not be saved. Refresh the page and try again.',
  'ticket-completed': 'This request is completed. Reopen it to add to it, or raise a new request.',
  [REOPEN_NOT_COMPLETED]: 'Only a completed request can be reopened.',
  [REOPEN_WINDOW_CLOSED]: 'A request can be reopened for 7 days after it is completed. Raise a new request instead.',
  'photo-type': 'Attach a photo (JPG, PNG, WebP or GIF, up to 10 MB).',
  'photo-path': "That photo didn't upload properly. Try attaching it again.",
  'too-many-photos': `A request can carry up to ${HUB_TICKET_PHOTO_MAX} photos.`,
  // ── Builder B: messages + email prefs (client hub redesign) ──
  'email-prefs': HUB_EMAIL_PREFS_REFUSAL,
  // ── Crew on the way: phone alerts ──
  [HUB_PUSH_CODES.bad]: 'That isn’t a phone alert sign-up this app can use.',
  [HUB_PUSH_CODES.preview]: 'Phone alerts are turned on by the customer, on their own phone. A preview can’t turn them on.',
  // ── Builder C: invoices + documents (client hub redesign) ──
  'invoice-unavailable': "This invoice couldn't be loaded from QuickBooks just now. Try again in a moment.",
  'no-file': 'Signed copy not on file yet.',
  // ── Builder D: the office's preview ──
  [HUB_PREVIEW_READ_ONLY]: HUB_PREVIEW_SENTENCES[HUB_PREVIEW_READ_ONLY],
  // ── Builder D (the Cleaner Hub): the QR scan ──
  [SCAN_INACTIVE_CODE]: SCAN_INACTIVE_MESSAGE,
  [HUB_SCAN_NOT_YOURS_CODE]: "That code is for a building that isn't one of yours.",
  // ── QR Wave 2 (Builder R): a request about one of the building's areas ──
  [AREA_CODES.unknown]: "That area isn't on this building's list any more. Refresh the page and try again.",
};
function fail(res, status, code, sentence) {
  return res.status(status).json({ error: sentence || SENTENCES[code] || 'Something went wrong. Try again.', code });
}
const notFound = (res) => fail(res, 404, 'not-found');

// Who a per-login limit counts: the customer login, or in a preview the staff login previewing (so
// two people previewing one building, acting as its one stand-in, are limited apart).
const limitKeyOf = (c) => (c.preview ? `preview:${c.user?.id || ''}` : c.clientUser.id);

function limited(req, res, c, action) {
  const cfg = LIMITS[action];
  if (!cfg) return false;
  const r = hit(`hub:${action}:${limitKeyOf(c)}`, cfg);
  if (r.ok) return false;
  res.setHeader('Retry-After', String(Math.ceil((r.retryAfterMs || 0) / 1000)));
  fail(res, 429, 'too-many-requests');
  return true;
}

// ── the request's context: the customer book, the scope, the roster, the zone ──
// The slices every branch needs, and no more: the customer book (the scope's live ids), their
// single locations, the roster (a supervisor's own phone, a cleaner's first name) and the org's
// time zone — only `company.timezone`, never the company record.
async function hubContext(c) {
  const slices = await readProtectedSlices('clients:state->clients,sites:state->sites,users:state->users,tz:state->company->>timezone');
  const clients = Array.isArray(slices?.clients) ? slices.clients.filter((x) => x && x.id) : [];
  const sites = Array.isArray(slices?.sites) ? slices.sites : [];
  const users = Array.isArray(slices?.users) ? slices.users.filter((u) => u && u.id) : [];
  // FAIL CLOSED on an unreadable customer book: with no live ids, the scope resolves to
  // nothing rather than to "every id an assignment names". A PREVIEW's scope is exactly the
  // building it names, and only while that building is in the live book (plan §3.7). The live
  // book holds no ARCHIVED customer (CS-663): its logins lose it, and so does a preview.
  const live = clients.filter((x) => !isArchivedCustomer(x));
  const allowedIds = c.preview
    ? new Set(live.some((x) => x.id === c.preview.buildingId) ? [c.preview.buildingId] : [])
    : new Set(await resolveScopeForClientUser(c.clientUser, { clientIds: live.map((x) => x.id) }));
  const siteFor = new Map();
  for (const s of sites) if (s && s.clientId && !siteFor.has(s.clientId)) siteFor.set(s.clientId, s);
  const userById = new Map(users.map((u) => [u.id, u]));
  // A blank zone is the org default (lib/dates' falsy-zone rule), never the server's.
  const tz = typeof slices?.tz === 'string' && slices.tz ? slices.tz : DEFAULT_ORG_TIMEZONE;
  return { clients, sites, allowedIds, siteFor, userById, tz };
}

// 🔴 THE GATE every per-building branch starts with: the building must be one this login was
// granted. Anything else — another customer's id, a deleted one, a path, nothing — is null.
function buildingIn(ctx, id) {
  if (typeof id !== 'string' || !id || !ctx.allowedIds.has(id)) return null;
  return ctx.clients.find((x) => x.id === id) || null;
}

// The building's manager is its supervisor only while they are still one: active, and still
// Super Admin, Admin or Manager (resolveAccountSupervisor — decision D4). Otherwise the hub says
// "your account team" and Call rings the company's main number.
const managerOf = (ctx, b) => {
  const sup = b.supervisorId ? ctx.userById.get(b.supervisorId) || null : null;
  return sup ? resolveAccountSupervisor({ clients: [b], users: [sup] }, b.id) : null;
};
const projectBuilding = (ctx, b) => projectHubBuilding(b, {
  site: ctx.siteFor.get(b.id) || null,
  supervisor: managerOf(ctx, b),
});
const nameOf = (ctx, userId) => (userId ? ctx.userById.get(userId)?.name || null : null);
// A team member's face (HUB-19): their current photo's version, { v }, or null.
const faceOf = (ctx, userId) => (userId ? hubFaceOf(ctx.userById.get(userId)) : null);
const siteIdOf = (ctx, b, ticket = null) => ticket?.site_id || ctx.siteFor.get(b.id)?.id || null;
// QR-16 / QR-23: the NAME of the area a request is about, from its own location's list (an area
// since removed names nothing) — the only thing about the area the customer is served.
const ticketAreaOf = (ctx, b, t) => {
  if (!t?.site_area_id) return null;
  const site = (t.site_id && ctx.sites.find((s) => s && s.id === t.site_id)) || ctx.siteFor.get(b.id) || null;
  return ticketAreaLabel(t, site);
};

// ── the handler ───────────────────────────────────────────────────────────────
export default function handler(req, res) {
  return withRequestCache(() => hubHandler(req, res));
}

async function hubHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;

  // Authenticate FIRST, on every branch (an unknown one included).
  let c = await requireHubCaller(req, res);
  if (!c) return; // 401 / 403 / 503 already written
  res.setHeader('Cache-Control', 'private, no-store');

  // 🔴 A READ-ONLY PREVIEW (HUB_PREVIEW_ACTS_AS_CUSTOMER off): whatever the branch, anything but a
  // read is refused before it is looked up, so no write path is ever reached with no customer
  // behind it. With the switch on, the preview acts as the building's stand-in (below).
  const actsAsCustomer = hubPreviewActsAsCustomer();
  if (c.preview && !actsAsCustomer && req.method !== 'GET') return fail(res, 403, HUB_PREVIEW_READ_ONLY);

  const branch = BRANCHES[`${req.method} ${action}`];
  if (!branch) return notFound(res);

  let ctx;
  try {
    ctx = await hubContext(c);
  } catch (e) {
    console.error(`[api/hub] ${action}: context read failed:`, e?.code || '', e?.message || e);
    return fail(res, 503, 'read-failed', action === 'view' ? 'Your buildings could not be loaded just now. Try again.' : undefined);
  }
  // A preview of a building that is not in the live customer book (removed, or never there) is a
  // 404 on every branch, the view included: there is nothing to show its customers — and no
  // stand-in is ever made for it.
  if (c.preview && !ctx.allowedIds.size) return notFound(res);
  // 🔴 THE PREVIEW ACTS AS THE BUILDING'S CUSTOMER (2026-10-09): from here every branch runs with
  // the building's stand-in customer login as the caller (created on the first preview, one per
  // building, status 'preview': it can never sign in and is never emailed — store.js). The scope
  // stays exactly the previewed building (above), never the stand-in's own (it has none).
  if (c.preview && actsAsCustomer) {
    try {
      c = { ...c, clientUser: await ensurePreviewStandIn(c.preview.buildingId) };
    } catch (e) {
      console.error(`[api/hub] ${action}: preview stand-in unavailable:`, e?.code || '', e?.message || e);
      return fail(res, 503, 'read-failed');
    }
  }
  try {
    return await branch({ req, res, c, ctx, q: req.query || {}, body: req.body || {}, now: Date.now() });
  } catch (e) {
    // The detail is for the server log; the customer gets a sentence and a code. A read that
    // failed, came back incomplete or ran too wide is "try again" (503); a write is a 500.
    console.error(`[api/hub] ${action} failed:`, e?.name || '', e?.code || '', e?.message || e);
    if (res.headersSent) return undefined;
    return req.method === 'GET' ? fail(res, 503, 'read-failed') : fail(res, 500, 'save-failed');
  }
}

// ── the branches ──────────────────────────────────────────────────────────────
const BRANCHES = {
  // ── Builder D (the Cleaner Hub, D5): the customer's camera (EP-387, see the header) ──
  // The code first (the public route's SAME 404 for every dead one, so this says nothing a
  // stranger's scan would not), then the scope: a building outside it is refused by name of no
  // building.
  'GET scan': async ({ req, res, c, ctx, q }) => {
    if (limited(req, res, c, 'scan')) return undefined;
    const token = typeof q.token === 'string' ? q.token : '';
    if (!isScanToken(token)) return fail(res, 404, SCAN_INACTIVE_CODE);
    const code = await resolveScanToken(token);
    const loc = code ? scanLocationOf({ code, sites: ctx.sites, clients: ctx.clients }) : null;
    if (!loc) return fail(res, 404, SCAN_INACTIVE_CODE);
    if (!buildingIn(ctx, loc.clientId)) return fail(res, 403, HUB_SCAN_NOT_YOURS_CODE);
    return res.status(200).json(projectHubScan(loc));
  },

  // ── QR Wave 2 (Builder P, 2026-10-17): the customer's page for ONE area (EP-421, see the header) ──
  // The building first (the caller's scope; an archived one is not in it), then the area on its
  // location; the area's last clean is the office's own rule (store.areaStatusForSite, signing only
  // the winning photo), the next clean and the last inspection the public page's own reads — each a
  // display extra (a failed one is left out, never the page).
  'GET area': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const site = ctx.siteFor.get(b.id) || null;
    const areaId = typeof q.areaId === 'string' ? q.areaId : '';
    const area = site && areaId ? scanAreasOf(site).find((a) => a.id === areaId) : null;
    if (!area) return notFound(res);
    const one = { id: site.id, name: site.name || null, cleaningAreas: [area] };
    const at = { id: site.id, timeZone: ctx.tz };
    const extra = (what) => (e) => {
      console.error(`[api/hub] area: ${what} unreadable:`, e?.code || e?.name || 'error');
      return null;
    };
    const [status, cleans, lastInspectionOn] = await Promise.all([
      areaStatusForSite({ siteId: site.id, site: one, sign: true }),
      scanCleansAhead(at, { nowMs: now }).catch(extra('next clean')),
      scanLastInspectionAt(at).catch(extra('last inspection')),
    ]);
    const row = (status?.areas || []).find((a) => a.areaId === area.id) || { areaId: area.id, label: area.label, items: [], photo: null };
    // The visit that already did this area is not its next clean (the public page's own rule).
    const nextCleanOn = cleans
      ? scanNextCleanDay({ jobs: cleans, siteId: site.id, timeZone: ctx.tz, nowMs: now, lastCleanedAt: row.lastCleanedAt ?? null })
      : null;
    return res.status(200).json(projectHubArea({
      building: b.name || site.name || null,
      location: site.name || null,
      area: row,
      timeZone: ctx.tz,
      nowMs: now,
      nextCleanOn,
      lastInspectionOn,
    }));
  },

  // Round 1: every building this login may see. The redesign (2026-10-08) adds the viewer's own
  // phone and first name, the groups they are ASSIGNED (only their in-scope buildings), each
  // building's next visit, and the org's zone. The groups and the next visits are display
  // extras: an unreadable one is logged and left empty, never a hub that will not open.
  'GET view': async ({ res, c, ctx, now }) => {
    const inScope = ctx.clients.filter((x) => ctx.allowedIds.has(x.id));
    const NO_GROUPS = { assignedGroupIds: [], groups: [], members: [] };
    const [groupRows, next] = await Promise.all([
      // A preview is one building, held by no group (its stand-in, when it acts, is assigned none).
      c.preview ? NO_GROUPS : reads.viewerGroups({ clientUserId: c.clientUser.id }).catch((e) => {
        console.error('[api/hub] view: groups unreadable:', e?.code || '', e?.message || e);
        return NO_GROUPS;
      }),
      reads.nextVisits({ clientIds: inScope.map((x) => x.id), fromIso: new Date(now).toISOString() }).catch((e) => {
        console.error('[api/hub] view: next visits unreadable:', e?.code || '', e?.message || e);
        return new Map();
      }),
    ]);
    const buildings = inScope
      .map((x) => projectHubViewBuilding(projectBuilding(ctx, x), { nextVisit: next.get(x.id) || null }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
    const groups = projectHubGroups({ ...groupRows, allowedIds: ctx.allowedIds });
    const view = buildHubView({
      clientUser: c.clientUser, buildings, groups, brandName: IDENTITY.name, timezone: ctx.tz,
    });
    if (!c.preview) return res.status(200).json(view);
    // The office's preview (plan §3.7): the viewer is "Preview customer" with no address (the
    // stand-in's made-up one is never shown); and the office's activity log records who opened it,
    // against the building (best-effort, as every entry).
    const b = inScope[0];
    await logActivityAs(c.preview.authority, {
      action: 'hub.previewed',
      summary: `Previewed the customer hub as the customers of ${b?.name || 'a building'} see it`,
      entityId: b?.id || null,
      clientId: b?.id || null,
      clientName: b?.name || null,
    }).catch(() => null);
    return res.status(200).json({ ...view, viewer: { ...HUB_PREVIEW_VIEWER } });
  },

  'GET checklists': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const { offset, limit } = hubPage(q);
    const { rows, total } = await reads.pageChecklists({ clientId: b.id, sinceIso: hubWindowStartIso(now), offset, limit });
    return res.status(200).json({
      rows: rows.map((r) => projectHubChecklistRow(r, {
        cleanerName: nameOf(ctx, r.completed_by_user_id),
        cleanerPhoto: faceOf(ctx, r.completed_by_user_id),
      })),
      total, offset, limit,
    });
  },

  'GET checklist': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b || !isUuid(q.id)) return notFound(res);
    const row = await reads.getChecklist({ clientId: b.id, id: q.id, sinceIso: hubWindowStartIso(now) });
    if (!row) return notFound(res);
    // Not best-effort: without the photo keys a photo-required item would read "not done".
    const { keys, photos } = await reads.checklistPhotos(row.client_submit_id);
    return res.status(200).json({
      checklist: projectHubChecklist(row, {
        cleanerName: nameOf(ctx, row.completed_by_user_id),
        cleanerPhoto: faceOf(ctx, row.completed_by_user_id),
        photos,
        photoKeys: keys,
      }),
    });
  },

  'GET inspections': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const { offset, limit } = hubPage(q);
    const { rows, total } = await reads.pageInspections({ clientId: b.id, sinceIso: hubWindowStartIso(now), offset, limit });
    return res.status(200).json({ rows: rows.map(projectHubInspectionRow), total, offset, limit });
  },

  // The full report (HUB-6) — the SAME projectReport the shared link and the PDF are built
  // from — with what we are doing about a failure (HUB-7, the redo the cleaners were sent).
  'GET inspection': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b || !isUuid(q.id)) return notFound(res);
    const rec = await reads.getInspection({ clientId: b.id, id: q.id, sinceIso: hubWindowStartIso(now) });
    if (!rec) return notFound(res);
    const [items, photos] = await Promise.all([
      reads.inspectionItems(rec.id),
      // Photos are best-effort here, as on every report surface: the report reads true without them.
      reads.signedPhotos({ refId: rec.id, scope: 'inspection', imagesOnly: false }).catch((e) => {
        console.error('[api/hub] inspection photos unreadable:', e?.message || e);
        return [];
      }),
    ]);
    const report = projectReport(rec, items, photos);
    return res.status(200).json({
      inspection: projectHubInspection({ id: rec.id, report, snapshot: rec.template_snapshot, items }),
    });
  },

  'GET inspection-pdf': async ({ req, res, c, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b || !isUuid(q.id)) return notFound(res);
    const rec = await reads.getInspection({ clientId: b.id, id: q.id, sinceIso: hubWindowStartIso(now) });
    if (!rec) return notFound(res);
    if (limited(req, res, c, 'inspection-pdf')) return undefined;
    const items = await reads.inspectionItems(rec.id);
    let pdf;
    try {
      // `rec` carries only the declared columns, so the renderer cannot reach the note.
      pdf = await renderInspectionReportPdf(rec, items);
    } catch (e) {
      console.error('[api/hub] inspection pdf failed:', e?.message || e);
      return fail(res, 503, 'pdf-failed');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inspectionPdfFilename(rec)}"`);
    return res.status(200).send(Buffer.from(pdf));
  },

  'GET tickets': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const { offset, limit } = hubPage(q);
    const { rows, total } = await reads.pageTickets({ clientId: b.id, sinceIso: hubWindowStartIso(now), offset, limit });
    return res.status(200).json({ rows: rows.map((r) => projectHubTicketRow(r, { area: ticketAreaOf(ctx, b, r) })), total, offset, limit });
  },

  'GET ticket': async ({ res, c, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b || !isUuid(q.id)) return notFound(res);
    const t = await reads.getTicket({ clientId: b.id, id: q.id, sinceIso: hubWindowStartIso(now) });
    if (!t) return notFound(res);
    return res.status(200).json({ ticket: await fullTicket(t, c, now, ticketAreaOf(ctx, b, t)) });
  },

  // HUB-13 / WO-4: the client raises a ticket — through createProblem, the office's own path.
  'POST ticket-create': async ({ req, res, c, ctx, body, now }) => {
    const b = buildingIn(ctx, body.buildingId);
    if (!b) return notFound(res);
    const input = hubTicketInput(body);
    if (input.refused) return fail(res, 400, input.code, input.refused);
    if (body.id != null && !isUuid(body.id)) return fail(res, 400, 'ticket-id');
    // QR-16: "Make a request about this area" names one of the building's own areas, or none.
    const area = ticketAreaInput(body.siteAreaId, ctx.siteFor.get(b.id) || null);
    if (area.refused) return fail(res, 400, area.refused);
    const id = body.id || randomUUID();
    // A replay of this person's own create (a double-tap, a retried request) is answered
    // with the ticket it made. An id that names anything else is refused without saying what.
    const replay = async (row) => (row.client_id === b.id && row.origin === 'portal' && row.raised_by_client_user_id === c.clientUser.id
      ? res.status(200).json({ ticket: projectHubTicket(row, { viewerClientUserId: c.clientUser.id, now, area: ticketAreaOf(ctx, b, row) }) })
      : fail(res, 409, 'ticket-id'));
    const existing = await reads.ticketById(id);
    if (existing) return replay(existing);
    if (limited(req, res, c, 'ticket-create')) return undefined;
    let created;
    try {
      created = await createProblem({
        id,
        clientId: b.id,
        siteId: siteIdOf(ctx, b),
        jobId: null,
        title: input.value.title,
        description: input.value.description,
        // WO-4: urgent or not; the office can change it. The ordinary case is medium (WO-18).
        priority: input.value.urgent ? 'urgent' : 'medium',
        type: input.value.type,
        category: input.value.category,
        origin: 'portal',
        assigneeUserId: null,
        reportedByUserId: null,
        raisedByClientUserId: c.clientUser.id,
        raisedByClientName: c.clientUser.name || null,
        siteAreaId: area.value,
      });
    } catch (e) {
      if (e?.code === '23505') {
        const winner = await reads.ticketById(id);
        if (winner) return replay(winner);
      }
      throw e;
    }
    // Wave 1's supervisor-first bell, unchanged (best-effort; never fails the saved ticket).
    await notifyTicketRaised(created);
    return res.status(200).json({ ticket: projectHubTicket(created, { viewerClientUserId: c.clientUser.id, now, area: ticketAreaOf(ctx, b, created) }) });
  },

  // HUB-13: a message on the client's ticket, in its own conversation.
  'POST ticket-message': async ({ req, res, c, ctx, body, now }) => {
    const t = await ticketInScope(ctx, body, now);
    if (!t) return notFound(res);
    const input = hubMessageInput(body);
    if (input.refused) return fail(res, 400, input.code, input.refused);
    if (woClientStage(t.status).key === 'completed') return fail(res, 409, 'ticket-completed');
    if (body.id != null && !isUuid(body.id)) return fail(res, 400, 'message-id');
    const id = body.id || randomUUID();
    const replay = (row) => (row.problem_id === t.id && row.author_role === 'client' && row.author_client_user_id === c.clientUser.id
      ? res.status(200).json({ message: projectHubMessage(row, { viewerClientUserId: c.clientUser.id }) })
      : fail(res, 409, 'message-id'));
    const existing = await reads.messageById(id);
    if (existing) return replay(existing);
    if (limited(req, res, c, 'ticket-message')) return undefined;
    let row;
    try {
      row = await addWorkOrderMessage({
        id, problemId: t.id, body: input.value.body,
        authorRole: 'client', authorName: c.clientUser.name || null, authorClientUserId: c.clientUser.id,
      });
    } catch (e) {
      if (e?.code === '23505') {
        const winner = await reads.messageById(id);
        if (winner) return replay(winner);
      }
      throw e;
    }
    await logClientAction(c, t, { action: 'ticket.replied', summary: `Customer replied on ticket "${String(t.title || '').slice(0, 80)}"` });
    // The office hears it — the assignee, else the supervisor, else the office (best-effort;
    // a replay above never rings twice, it returns before reaching here).
    await notifyClientReplied(t, row);
    return res.status(200).json({ message: projectHubMessage(row, { viewerClientUserId: c.clientUser.id }) });
  },

  // WO-11: reopen within 7 days of completion, not after.
  'POST ticket-reopen': async ({ req, res, c, ctx, body, now }) => {
    const t = await ticketInScope(ctx, body, now);
    if (!t) return notFound(res);
    const refusal = ticketReopenRefusal({ status: t.status, resolvedAt: t.resolved_at, now });
    if (refusal) return fail(res, 409, refusal);
    if (limited(req, res, c, 'ticket-reopen')) return undefined;
    const row = await reopenProblem(t.id);
    // Someone moved it in between: it is no longer a completed ticket to reopen.
    if (!row) return fail(res, 409, REOPEN_NOT_COMPLETED);
    await logClientAction(c, t, {
      action: 'ticket.status_changed',
      summary: `Customer reopened ticket "${String(t.title || '').slice(0, 80)}": resolved → open`,
      before: { status: t.status ?? null },
      after: { status: row.status ?? null },
    });
    // Back in the office's queue as a ticket to act on: the same supervisor-first bell.
    await notifyTicketRaised(row);
    return res.status(200).json({ ticket: await fullTicket(row, c, now, ticketAreaOf(ctx, buildingIn(ctx, body.buildingId), row)) });
  },

  // The client's own photo on their ticket (an upload address first, then the record).
  'POST ticket-photo-url': async ({ req, res, c, ctx, body, now }) => {
    const t = await ticketInScope(ctx, body, now);
    if (!t) return notFound(res);
    const refused = photoRefusal(t, body);
    if (refused) return fail(res, refused.status, refused.code);
    if (limited(req, res, c, 'ticket-photo')) return undefined;
    if (await reads.clientPhotoCount(t.id) >= HUB_TICKET_PHOTO_MAX) return fail(res, 409, 'too-many-photos');
    const b = buildingIn(ctx, body.buildingId);
    const su = await signedUploadUrl({ siteId: siteIdOf(ctx, b, t), mimeType: body.mimeType });
    return res.status(200).json({
      path: su.path, token: su.token, signedUrl: su.signedUrl,
      thumb: su.thumb ? { path: su.thumb.path, token: su.thumb.token, signedUrl: su.thumb.signedUrl } : null,
    });
  },

  'POST ticket-photo': async ({ req, res, c, ctx, body, now }) => {
    const t = await ticketInScope(ctx, body, now);
    if (!t) return notFound(res);
    const refused = photoRefusal(t, body);
    if (refused) return fail(res, refused.status, refused.code);
    if (body.id != null && !isUuid(body.id)) return fail(res, 400, 'photo-id');
    const b = buildingIn(ctx, body.buildingId);
    const siteId = siteIdOf(ctx, b, t);
    // The bytes must sit under THIS ticket's location, at a path the upload address minted.
    if (!isValidStoragePath(body.storagePath, siteId)) return fail(res, 400, 'photo-path');
    if (limited(req, res, c, 'ticket-photo')) return undefined;
    if (await reads.clientPhotoCount(t.id) >= HUB_TICKET_PHOTO_MAX) return fail(res, 409, 'too-many-photos');
    const row = await confirmUpload({
      scope: 'client_ticket',
      clientId: b.id,
      siteId,
      areaId: null,
      refId: t.id,
      kind: 'image',
      mimeType: body.mimeType,
      storagePath: body.storagePath,
      thumbPath: body.thumbPath && body.thumbPath === thumbPathFor(body.storagePath) ? body.thumbPath : null,
      sizeBytes: Number.isFinite(body.sizeBytes) ? body.sizeBytes : null,
      caption: null,
      uploadedByUserId: null,
      // The caller's id, namespaced so it can never name another surface's upload: confirm
      // answers an existing row for a known id (its replay rule), and that row must be THIS
      // ticket's client photo before anything about it is signed and served.
      clientMediaId: body.id ? `hub_${body.id}` : null,
    });
    if (!row || row.scope !== 'client_ticket' || row.ref_id !== t.id) return fail(res, 409, 'photo-id');
    return res.status(200).json({ photo: projectHubPhoto(await signMediaRow(row)) });
  },

  // HUB-9 / LOG-1 / LOG-9: a year of service events, paged on the server.
  'GET history': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const fromIso = hubWindowStartIso(now);
    const tickets = await reads.historyTickets({ clientId: b.id, sinceIso: fromIso });
    const events = await serviceEventsForClient({ clientId: b.id, fromIso, toIso: new Date(now).toISOString(), tickets });
    const { offset, limit } = hubPage(q);
    const pageOut = hubHistoryPage(events, { offset, limit });
    // The year's checklists are read without their items; the ones on THIS page are read again by
    // id so a task the cleaner marked "not completed" reads as not done (D2) — bounded by the page.
    const ids = pageOut.events.filter((e) => e.kind === 'checklist' && e.checklistId).map((e) => e.checklistId);
    const byId = await reads.checklistItemsByIds({ clientId: b.id, ids });
    const served = pageOut.events.map((e) => projectHubEvent(e.kind === 'checklist' && byId.has(e.checklistId)
      ? { ...e, detail: checklistEventDetail(byId.get(e.checklistId)) } : e));
    return res.status(200).json({ events: served, total: pageOut.total, offset, limit });
  },

  // ── Builder A: home + visit (client hub redesign) ─────────────────────────────
  // Home (EP-305): the building, the crew band, and the Requests / Checklists / Inspections tiles,
  // and the average time to resolve (the Oct 6 call, plan 2026-10-11 §4: the building's requests
  // from the hub resolved in the last 30 days — D11, what the customer can check against their own
  // list). The crew band is the ONE time rule (src/lib/hubVisit.js); the tiles are src/lib/hubHome.js.
  'GET home': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const sinceIso = hubWindowStartIso(now);
    const win = hubVisitWindow(now, ctx.tz);
    const resolvedSinceIso = new Date(now - HUB_RESOLVE_DAYS * 24 * 3600 * 1000).toISOString();
    const [inputs, open, working, needsInfo, checklistRows, inspectionRows, resolvedRows] = await Promise.all([
      visitInputs(b, win, now),
      reads.openTicketCount({ clientId: b.id, sinceIso }),
      reads.ticketCountIn({ clientId: b.id, sinceIso, statuses: STAGE_STATUSES.working }),
      reads.ticketCountIn({ clientId: b.id, sinceIso, statuses: STAGE_STATUSES.needs_info }),
      reads.tileChecklists({ clientId: b.id, dayStartIso: win.dayStartIso, sinceIso }),
      reads.tileInspections({ clientId: b.id, sinceIso }),
      reads.resolvedTickets({ clientId: b.id, sinceIso, resolvedSinceIso }),
    ]);
    // The last report's thumbnails are best-effort, as on every report surface.
    const peek = inspectionRows.length
      ? await reads.photoPeek({ refId: inspectionRows[0].id, scope: 'inspection', max: HUB_TILE_PHOTO_MAX }).catch((e) => {
        console.error('[api/hub] home: inspection photos unreadable:', e?.message || e);
        return { photos: [], total: 0 };
      })
      : { photos: [], total: 0 };
    const status = hubVisitStatus({ ...inputs, client: b, now, tz: ctx.tz, photoOf: (id) => faceOf(ctx, id) });
    return res.status(200).json(projectHubHome({
      building: projectBuilding(ctx, b),
      crew: projectHubCrew(status),
      requests: hubRequestCounts({ open, working, needsInfo }),
      checklists: hubChecklistTile(checklistRows, { now, tz: ctx.tz }),
      inspections: hubInspectionTile(inspectionRows, { photos: peek.photos, totalPhotos: peek.total }),
      resolve: hubResolveTile(resolvedRows, { now }),
    }));
  },

  // Today's Visit (EP-306): the crew status with its timeline, who is on site (HUB-5), the
  // visit's own before/after photos, the next visits and the account manager.
  'GET visit': async ({ res, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    const win = hubVisitWindow(now, ctx.tz);
    const inputs = await visitInputs(b, win, now);
    const photoOf = (id) => faceOf(ctx, id);
    const status = hubVisitStatus({ ...inputs, client: b, now, tz: ctx.tz, photoOf });
    // The photos are TODAY's visits' (and a night clean's that began yesterday and is still
    // going): only this building's own job ids, and the building in the query again.
    const jobIds = new Set(inputs.jobs.filter((j) => dayKey(j.start_at, ctx.tz) === win.today).map((j) => j.id));
    const ownJob = new Set(inputs.jobs.map((j) => j.id));
    for (const p of inputs.punches) if (p.job_id && !p.clock_out_at && ownJob.has(p.job_id)) jobIds.add(p.job_id);
    const photos = await reads.visitPhotos({ clientId: b.id, jobIds: [...jobIds] }).catch((e) => {
      console.error('[api/hub] visit: photos unreadable:', e?.message || e);
      return { photos: [], total: 0 };
    });
    return res.status(200).json(projectHubVisit({
      status,
      onSite: hubOnSiteList(inputs.punches, now, { photoOf }),
      photos: projectHubVisitPhotos(photos.photos, { total: photos.total }),
      upcoming: hubUpcomingVisits(inputs.upcoming, { now, max: HUB_UPCOMING_MAX + 1 }),
      manager: projectHubManager(projectBuilding(ctx, b).supervisor),
    }));
  },

  // A TEAM MEMBER'S PHOTO (HUB-19; Matt's "Your Account Manager", 2026-11-02): the image of the
  // CURRENT photo whose version is `v` — a face one of the answers above served — for a building in
  // this login's scope. The version is a random 128-bit id that reaches a customer only inside an
  // answer about someone their building names, so it is the whole capability: the answer names no
  // member, path or link. A replaced or removed photo's version is the hub's 404, as is a building
  // outside the scope. The object never changes for its version (api/_lib/avatars.js), so the
  // browser may keep it: private, a year.
  'GET face': async ({ req, res, c, ctx, q }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b || !isPhotoVersion(q.v)) return notFound(res);
    if (limited(req, res, c, 'face')) return undefined;
    const member = [...ctx.userById.values()].find((u) => photoVersionOf(u) === q.v);
    if (!member) return notFound(res);
    // A display extra: a photo Storage cannot give back is the person's initials on the page.
    const photo = await readAvatar(member.id, q.v).catch((e) => {
      console.error('[api/hub] face: unreadable:', e?.message || e);
      return null;
    });
    if (!photo) {
      console.warn('[api/hub] face: no photo object for a current version');
      return notFound(res);
    }
    res.setHeader('Content-Type', photo.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(photo.buffer);
  },
  // ── Builder B: messages + updates + email prefs (client hub redesign) ─────────────────────
  // One thread per building with the office (plan §3.4). The logic lives in
  // api/_lib/clientHub/messages.js; the pure rules (allowlists, bounds, the bell's words) in
  // src/lib/hubMessages.js. Each building-scoped branch starts at `buildingIn`, like every other.
  'GET messages': async ({ res, c, ctx, q, now }) => {
    const b = buildingIn(ctx, q.buildingId);
    if (!b) return notFound(res);
    // A read-only preview (no customer behind it) reads the thread as nobody's: no line is "mine".
    // Acting as the customer, it is the stand-in's own view of the thread.
    const clientUser = c.clientUser || { id: null };
    return res.status(200).json(await hubMessages.hubThread({ ctx, building: b, clientUser, q, now }));
  },

  'POST message': async ({ req, res, c, ctx, body, now }) => {
    const b = buildingIn(ctx, body.buildingId);
    if (!b) return notFound(res);
    const input = hubMessageBodyInput(body);
    if (input.refused) return fail(res, 400, input.code, input.refused);
    if (body.id != null && !isUuid(body.id)) return fail(res, 400, 'message-id');
    const id = body.id || randomUUID();
    // A replay of this login's own line in this building is answered with it (and heals its
    // thread summary); an id that names anything else is a 409 that says nothing about it.
    const replay = async (row) => {
      if (!hubMessages.isOwnCustomerLine(row, b.id, c.clientUser.id)) return fail(res, 409, 'message-id');
      await hubMessages.healThread(row);
      return res.status(200).json({ message: hubMessages.projectForCustomer(ctx, row, c.clientUser) });
    };
    const existing = await hubMessages.messageById(id);
    if (existing) return replay(existing);
    if (limited(req, res, c, 'message')) return undefined;
    const out = await hubMessages.postCustomerMessage({ id, building: b, clientUser: c.clientUser, body: input.value.body, now });
    if (out.replay) return replay(out.replay);
    return res.status(200).json({ message: hubMessages.projectForCustomer(ctx, out.row, c.clientUser) });
  },

  'POST messages-read': async ({ res, c, ctx, body, now }) => {
    const b = buildingIn(ctx, body.buildingId);
    if (!b) return notFound(res);
    const readAt = await hubMessages.markRead({ clientId: b.id, readerKind: 'client', readerId: c.clientUser.id, at: readMarkerAt(body.at, now) });
    return res.status(200).json({ readAt });
  },

  // The bell: names no building — it reads every building in this login's scope. It is a PERSON's
  // news, so a read-only preview (nobody behind it) answers the empty bell, never another
  // customer's; acting as the customer it is the stand-in's own bell.
  'GET updates': async ({ res, c, ctx, now }) => res.status(200).json(!c.clientUser
    ? { ...finishHubUpdates([], { seenAt: null }), seenAt: null, messagesUnread: [] }
    : await hubMessages.hubUpdates({ ctx, clientUser: c.clientUser, now })),

  'POST updates-seen': async ({ res, c, now }) => res.status(200).json({ seenAt: await hubMessages.stampUpdatesSeen(c.clientUser, now) }),

  // The customer's own email switches (lib/hubEmailPrefs.js). The row is ALWAYS the caller's —
  // the id comes from the verified claim, and a body that names anything but the three switches
  // is refused whole.
  // A read-only preview's switches are the defaults, never a customer's own choices; acting as the
  // customer they are the stand-in's own row's.
  'GET email-prefs': ({ res, c }) => res.status(200).json({ prefs: resolveHubEmailPrefs(c.clientUser ? c.clientUser.email_prefs : null) }),

  'POST email-prefs': async ({ req, res, c, body }) => {
    const input = hubEmailPrefsInput(body);
    if (input.refused) return fail(res, 400, input.code, input.refused);
    if (limited(req, res, c, 'email-prefs')) return undefined;
    return res.status(200).json({ prefs: await hubMessages.saveEmailPrefs(c.clientUser, input.value) });
  },
  // ── Crew on the way: the caller's OWN phone alerts (api/_lib/clientHub/push.js) ──
  // A phone is named by its push address; the row is ALWAYS the caller's, from the verified claim.
  // 🔴 A PREVIEW NEVER SIGNS A PHONE UP, read-only or acting as the building's stand-in: the
  // stand-in is nobody's, and its alerts would ring the office person previewing. Its GET answers
  // "off" (every GET answers a preview), its POSTs are refused.
  'GET push': async ({ req, res, c }) => {
    if (c.preview || !c.clientUser) return res.status(200).json({ on: false });
    const endpoint = hubPushEndpoint(req.query?.endpoint);
    if (!endpoint) return res.status(200).json({ on: false });
    return res.status(200).json({ on: await clientPush.clientPushOn({ clientUserId: c.clientUser.id, endpoint }) });
  },

  'POST push': async ({ req, res, c, body }) => {
    if (c.preview || !c.clientUser) return fail(res, 403, HUB_PUSH_CODES.preview);
    const input = hubPushInput(body);
    if (input.refused) return fail(res, 400, input.code, input.refused);
    if (limited(req, res, c, 'push')) return undefined;
    await clientPush.upsertClientPush({ clientUserId: c.clientUser.id, value: input.value });
    return res.status(200).json({ on: true });
  },

  'POST push-off': async ({ req, res, c, body }) => {
    if (c.preview || !c.clientUser) return fail(res, 403, HUB_PUSH_CODES.preview);
    const endpoint = hubPushEndpoint(body?.endpoint);
    if (!endpoint) return fail(res, 400, HUB_PUSH_CODES.bad);
    if (limited(req, res, c, 'push')) return undefined;
    await clientPush.removeClientPush({ clientUserId: c.clientUser.id, endpoint });
    return res.status(200).json({ on: false });
  },

  // ── Builder C: invoices + documents (client hub redesign) ──
  // GET invoices · GET invoice-pdf · GET documents · GET document-url — read-only, each gated by
  // this file's own buildingIn (api/_lib/clientHub/branches/invoicesDocuments.js).
  ...invoiceAndDocumentBranches({ buildingIn, fail, notFound, limited }),
};

// Every "METHOD branch" this route serves, for the suites that must walk all of them
// (test-hub-preview.mjs: every GET answers a preview, every POST refuses it).
export const HUB_BRANCH_KEYS = Object.freeze(Object.keys(BRANCHES));

// ── helpers the Builder A branches share ─────────────────────────────────────
// The client stages' office statuses, from the one vocabulary (workOrders WO_CLIENT_STAGES via
// woClientStage), including the legacy 'ack' that reads as "working on it".
const STAGE_STATUSES = Object.freeze({
  working: ['ack', ...WO_STATUSES].filter((s) => woClientStage(s).key === 'working'),
  needs_info: ['ack', ...WO_STATUSES].filter((s) => woClientStage(s).key === 'needs_info'),
});

// The crew status's four reads for one building: its jobs from the start of yesterday to the end
// of today, its punches from then (or the on-site window, whichever is earlier), its checklist
// saves from then, and the next upcoming jobs.
async function visitInputs(b, win, now) {
  const punchesSince = Math.min(Date.parse(win.fromIso), now - HUB_ON_SITE_HOURS * 3600000);
  const [jobs, punches, checklists, upcoming] = await Promise.all([
    reads.visitJobs({ clientId: b.id, fromIso: win.fromIso, toIso: win.toIso }),
    reads.visitPunches({ clientId: b.id, sinceIso: new Date(punchesSince).toISOString() }),
    reads.visitChecklists({ clientId: b.id, sinceIso: win.fromIso }),
    reads.upcomingJobs({ clientId: b.id, afterIso: new Date(now).toISOString(), limit: HUB_UPCOMING_MAX + 1 }),
  ]);
  return { jobs, punches, checklists, upcoming };
}

// ── helpers the ticket branches share ────────────────────────────────────────
// The ticket a POST names, inside the building it names, inside this login's scope — or null.
async function ticketInScope(ctx, body, now) {
  const b = buildingIn(ctx, body.buildingId);
  if (!b || !isUuid(body.ticketId)) return null;
  return reads.getTicket({ clientId: b.id, id: body.ticketId, sinceIso: hubWindowStartIso(now) });
}

// The whole ticket as the client reads it: its conversation (no internal note — the query
// excludes them), the client's own photos, and once completed the completion photos (WO-10).
async function fullTicket(t, c, now, area = null) {
  const completed = woClientStage(t.status).key === 'completed';
  const photosOf = (scope) => reads.signedPhotos({ refId: t.id, scope }).catch((e) => {
    console.error(`[api/hub] ${scope} photos unreadable:`, e?.message || e);
    return [];
  });
  const [messages, photos, completionPhotos] = await Promise.all([
    reads.ticketThread(t.id),
    photosOf('client_ticket'),
    completed ? photosOf('problem_report') : Promise.resolve([]),
  ]);
  // A read-only preview has no customer behind it: nothing reads "You" (acting, the stand-in's own do).
  return projectHubTicket(t, { messages, photos, completionPhotos, viewerClientUserId: c.clientUser ? c.clientUser.id : null, now, area });
}

// A photo is an image the client attaches while the ticket is still open.
function photoRefusal(t, body) {
  if (woClientStage(t.status).key === 'completed') return { status: 409, code: 'ticket-completed' };
  const v = validateUpload({ mimeType: body.mimeType, sizeBytes: Number(body.sizeBytes) });
  if (!v.ok || v.kind !== 'image') return { status: 400, code: 'photo-type' };
  return null;
}

// The office's activity log records what the customer did to a ticket (LOG-2: status changes
// and replies), with the CLIENT named as the actor — never a staff id. Best-effort.
async function logClientAction(c, t, entry) {
  await logActivity({
    ...entry,
    entityId: t.id,
    clientId: t.client_id || null,
    clientName: t.client_name || null,
    actorUserId: null,
    actorRole: 'client',
    actorName: c.clientUser.name || null,
  });
}
