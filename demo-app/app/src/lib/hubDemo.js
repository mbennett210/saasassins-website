// THE CLIENT HUB'S LOGIN-FREE DEMO — what Daniel sees on `--mode demo` at /hub.
//
// 🔴 REACHABLE ONLY FROM A DEMO BUILD. lib/clientHubApi.js imports this module dynamically,
// behind the static `import.meta.env.MODE === 'demo'` gate (and the runtime
// demoBackendsEngaged()), so `npm run build` emits no chunk for it and check-bundle-stubs fails
// any production bundle that carries its fixture names (the demo's management company below
// exists nowhere else). Round 1 refused a hub stub because a pretend ACCESS CONTROL must never
// ship; this one cannot, and it is only ever a preview of the screens.
//
// THE SAME ANSWERS AS THE SERVER. Every function here mirrors a branch of api/hub/[...path].js:
// the scope is the ONE pure rule the server gate runs (resolveAllowedClientIds), a building or
// record outside it is a 404 with the server's code, and every object is built by the SAME
// allowlist projections (lib/clientHubView.js). Only the reads differ: the demo's own seeded
// data (data/demoStubs.js, data/demoTimeLedger.js, data/demoSiteMedia.js) through the demo
// adapters (qcApi, accountMediaApi), instead of the relational tables.
//
// THE DEMO CUSTOMER CONTACT is Coral Bay HOA's property manager (data/demoStubs.js
// DEMO_CLIENT_USER): Coral Bay is assigned to her directly, and her management company's GROUP
// grants her the rest — the two ways a building is granted (HUB-17). The redesign (2026-10-08)
// widens the group to five buildings, all on the manager Renata's book, so the hub shows the crew
// states of her day (data/demoManagerDay.js, placed in the demo's store and ledger by
// lib/demoBootstrap): Coral Bay on site, Flagler Townhomes done, Palmetto Ridge done this morning
// with an evening visit to come, Bayshore arriving later, Gulfstream's crew called out; Coral Bay is
// in the group as well, so the Properties page reads "5 locations under Royal Palm Property
// Management". Her requests from the hub are the ones the office's Client Requests answers.
import {
  resolveAllowedClientIds, projectHubBuilding, buildHubView, projectHubViewBuilding, projectHubGroups,
} from './clientHub.js';
import {
  hubWindowStartIso, isWithinHubWindow, hubPage, hubOnSiteList,
  projectHubChecklistRow, projectHubChecklist, projectHubInspectionRow, projectHubInspection,
  projectHubTicketRow, projectHubTicket, projectHubMessage, projectHubPhoto, projectHubEvent, hubHistoryPage,
  hubTicketInput, hubMessageInput, hubVisibleMessages, HUB_INPUT_REFUSALS,
} from './clientHubView.js';
import {
  hubVisitStatus, hubVisitWindow, hubUpcomingVisits, hubVisitPhotoPick, projectHubCrew, projectHubVisit,
  projectHubVisitPhotos, projectHubManager, HUB_UPCOMING_MAX, HUB_VISIT_PHOTO_AREAS, HUB_VISIT_PHOTO_SCOPE,
} from './hubVisit.js';
import {
  hubRequestCounts, hubChecklistTile, hubInspectionTile, hubResolveTile, projectHubHome, HUB_TREND_MAX, HUB_TILE_PHOTO_MAX,
} from './hubHome.js';
import { woClientStage, ticketReopenRefusal, REOPEN_NOT_COMPLETED, REOPEN_WINDOW_CLOSED, ticketAreaInput, ticketAreaLabel, AREA_CODES, AREA_MESSAGES } from './workOrders.js';
import { resolveAccountSupervisor } from './notifications.js';
import { dayKey, DEFAULT_ORG_TIMEZONE } from './dates.js';
import { isArchivedCustomer } from './customerStatus.js';
import { selectServiceEvents } from './activityLog.js';
import { buildInspectionReportHtml } from './inspectionReportTemplate.js';
import * as qcApi from './qcApi';
import * as mediaApi from './accountMediaApi';
// Team photos (HUB-19): the same faces as the server (lib/hubFaces.js), and the image from the
// demo's own photo store (lib/avatarApi's stub) where the server reads Storage.
import { fetchAvatarUrls } from './avatarApi';
import { isPhotoVersion, photoVersionOf } from './userPhoto.js';
import { hubFaceOf } from './hubFaces.js';
import { STUB_KEY as TIME_STUB_KEY, readOnTheWayStub } from './timeApi';
import { ON_THE_WAY_KIND, hubPushInput, hubPushEndpoint, HUB_PUSH_CODES } from './crewOnTheWay.js';
import { loadState } from '../store/persist';
import { INITIAL_STATE } from '../data/seed';
import { DEMO_CLIENT_USER } from '../data/demoStubs';
import { IDENTITY } from '../brand/identity.generated.js';
// The QR scan (the Cleaner Hub, D5, Builder D): the demo's codes, and the route's location rule.
import { demoScanCodeFor, demoScanExtras } from './scanCodesApi';
import { isScanToken, projectHubArea, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE } from './areaScan.js';
import { scanLocationOf, scanAreasOf, projectHubScan, HUB_SCAN_NOT_YOURS_CODE } from './scanCodes.js';
// The office's "Preview as customer" (plan §3.7): while this tab previews a building, the demo
// answers as the server does — that building only, the viewer "Preview customer", and (the switch
// on, the default) every read and write AS THE BUILDING'S STAND-IN customer (its own requests,
// "mine", bell and switches); with HUB_PREVIEW_ACTS_AS_CUSTOMER off, nobody's bell, switches or
// "mine" (and lib/clientHubApi.js refuses the writes before they reach here).
import { readHubPreview, hubPreviewActsAsCustomer, HUB_PREVIEW_VIEWER, HUB_PREVIEW_VIEWER_NAME } from './hubPreview.js';

// The demo contact's management company: the GROUP that grants her the other buildings.
const DEMO_GROUP = Object.freeze({ id: 'grp_demo_royal_palm', name: 'Royal Palm Property Management', kind: 'management' });
const DEMO_GROUP_BUILDINGS = Object.freeze(['Coral Bay', 'Bayshore', 'Palmetto', 'Gulfstream', 'Flagler']);
const DEMO_PHOTO_MAX = 5;   // api/hub HUB_TICKET_PHOTO_MAX
const NEXT_VISIT_DAYS = 60; // migration 20261008100000 hub_next_visits' horizon

// ── errors, in the server's words and codes ───────────────────────────────────
const SENTENCES = {
  'not-found': "We couldn't find that. It may have been removed, or it isn't one of your buildings.",
  'ticket-id': 'This request could not be saved. Refresh the page and try again.',
  'message-id': 'This message could not be sent. Refresh the page and try again.',
  'ticket-completed': 'This request is completed. Reopen it to add to it, or raise a new request.',
  [REOPEN_NOT_COMPLETED]: 'Only a completed request can be reopened.',
  [REOPEN_WINDOW_CLOSED]: 'A request can be reopened for 7 days after it is completed. Raise a new request instead.',
  'photo-type': 'Attach a photo (JPG, PNG, WebP or GIF, up to 10 MB).',
  'too-many-photos': `A request can carry up to ${DEMO_PHOTO_MAX} photos.`,
  [HUB_PUSH_CODES.bad]: 'That isn’t a phone alert sign-up this app can use.',
  [HUB_PUSH_CODES.preview]: 'Phone alerts are turned on by the customer, on their own phone. A preview can’t turn them on.',
};
function refuse(status, code, sentence) {
  const err = new Error(sentence || SENTENCES[code] || HUB_INPUT_REFUSALS[code] || 'Something went wrong. Try again.');
  err.status = status;
  err.code = code;
  return err;
}
const notFound = () => refuse(404, 'not-found');

// ── the demo's org and the contact's scope ────────────────────────────────────
function org() {
  let state = null;
  try { state = loadState(); } catch { state = null; }
  const s = state && Array.isArray(state.clients) ? state : INITIAL_STATE;
  const clients = (s.clients || []).filter((c) => c && c.id);
  const byName = (frag) => clients.find((c) => String(c.name || '').includes(frag)) || null;
  const coral = byName('Coral Bay');
  const groupMembers = DEMO_GROUP_BUILDINGS.map(byName).filter(Boolean).map((c) => ({ groupId: DEMO_GROUP.id, clientId: c.id }));
  const assignments = [{ clientId: coral?.id || null }, { groupId: DEMO_GROUP.id }];
  // A preview's scope is exactly the previewed building, while it is in the book (the server's rule).
  // The live book holds no ARCHIVED customer (CS-663, as api/hub's gate).
  const live = clients.filter((c) => !isArchivedCustomer(c));
  const previewId = readHubPreview()?.buildingId || null;
  const allowedIds = previewId
    ? new Set(live.some((c) => c.id === previewId) ? [previewId] : [])
    : new Set(resolveAllowedClientIds({
      status: 'active', assignments, groupMembers, clientIds: live.map((c) => c.id),
    }));
  const siteFor = new Map();
  for (const site of s.sites || []) if (site && site.clientId && !siteFor.has(site.clientId)) siteFor.set(site.clientId, site);
  const userById = new Map((s.users || []).filter((u) => u && u.id).map((u) => [u.id, u]));
  // The org's zone, as the server reads company.timezone; the jobs, as the server reads public.jobs.
  const tz = s.company?.timezone || DEFAULT_ORG_TIMEZONE;
  const jobs = Array.isArray(s.jobs) ? s.jobs.filter((j) => j && j.id) : [];
  return { clients, sites: Array.isArray(s.sites) ? s.sites : [], allowedIds, siteFor, userById, tz, jobs, groupMembers, assignments, preview: !!previewId };
}
// WHO the demo answers as: the demo contact; in the office's preview acting as the customer, the
// building's stand-in (as the server's route does — a demo id of its own, named "Preview
// customer"); in a read-only preview, nobody (null).
function actor() {
  const p = readHubPreview();
  if (!p) return DEMO_CLIENT_USER;
  return hubPreviewActsAsCustomer() ? { id: `preview_${p.buildingId}`, name: HUB_PREVIEW_VIEWER_NAME } : null;
}
// Whose "mine" / "You" the demo answers for.
const viewerId = () => actor()?.id ?? null;
// The writer of a write (never null: a read-only preview's writes are refused before they arrive).
const writer = () => actor() || DEMO_CLIENT_USER;

function buildingIn(o, id) {
  if (typeof id !== 'string' || !id || !o.allowedIds.has(id)) return null;
  return o.clients.find((c) => c.id === id) || null;
}
function mustBuilding(id) {
  const o = org();
  const b = buildingIn(o, id);
  if (!b) throw notFound();
  return { o, b };
}
// The building's manager only while still one (resolveAccountSupervisor, D4), as the server.
const managerOf = (o, b) => {
  const sup = b.supervisorId ? o.userById.get(b.supervisorId) || null : null;
  return sup ? resolveAccountSupervisor({ clients: [b], users: [sup] }, b.id) : null;
};
const projectBuilding = (o, b) => projectHubBuilding(b, {
  site: o.siteFor.get(b.id) || null,
  supervisor: managerOf(o, b),
});
const nameOf = (o, userId) => (userId ? o.userById.get(userId)?.name || null : null);
// A team member's face (HUB-19), as the server's faceOf: { v } of their current photo, or null.
const faceOf = (o, userId) => (userId ? hubFaceOf(o.userById.get(userId)) : null);
const pageOf = (rows, q) => {
  const { offset, limit } = hubPage(q);
  return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
};
const newestFirst = (col) => (a, b) => Date.parse(b[col]) - Date.parse(a[col]);

// ── the demo's own records, read the way the server reads its tables ─────────
function ledgerEntries() {
  try { return (JSON.parse(localStorage.getItem(TIME_STUB_KEY)) || {}).entries || []; } catch { return []; }
}
// Every punch (the server reads public.time_entries).
function timeEntries() {
  return ledgerEntries();
}
// One building's jobs (the server reads public.jobs).
function jobsAt(o, buildingId) {
  return o.jobs.filter((j) => j.clientId === buildingId);
}
// A client ticket is one the customer raised in the hub (origin 'portal'), inside the year: every
// ticket of the building created since the hub's window opened (a complete read, CS-640).
async function clientTickets(buildingId) {
  return (await qcApi.listProblemsSince({ clientId: buildingId, sinceIso: hubWindowStartIso() }))
    .filter((p) => p.origin === 'portal' && isWithinHubWindow(p.created_at))
    .sort(newestFirst('created_at'));
}
async function ticketOf(buildingId, id) {
  return (await clientTickets(buildingId)).find((p) => p.id === id) || null;
}
async function photosOf(siteId, refId, scope) {
  if (!siteId || !refId) return [];
  try { return await mediaApi.listMedia({ siteId, refId, scope }); } catch { return []; }
}
async function buildingChecklists(buildingId) {
  return (await qcApi.listChecklists({}))
    .filter((c) => c.client_id === buildingId && isWithinHubWindow(c.performed_at))
    .sort(newestFirst('performed_at'));
}
async function buildingInspections(buildingId) {
  const { inspections } = await qcApi.listInspections({ clientId: buildingId });
  return (inspections || [])
    .filter((i) => i.status === 'submitted' && isWithinHubWindow(i.performed_at))
    .sort(newestFirst('performed_at'));
}

// QR-16 / QR-23: the NAME of the area a request is about, from its own location's list — the
// server's rule (api/hub ticketAreaOf).
function areaOf(o, b, t) {
  if (!t?.site_area_id) return null;
  const site = (t.site_id && o.sites.find((s) => s && s.id === t.site_id)) || o.siteFor.get(b.id) || null;
  return ticketAreaLabel(t, site);
}

async function fullTicket(t, now = Date.now(), area = null) {
  const completed = woClientStage(t.status).key === 'completed';
  // WO-9 at the read, as the server's query does: an internal note never leaves here.
  const messages = hubVisibleMessages(await qcApi.listWorkOrderMessages(t.id));
  const [photos, completionPhotos] = await Promise.all([
    photosOf(t.site_id, t.id, 'client_ticket'),
    completed ? photosOf(t.site_id, t.id, 'problem_report') : Promise.resolve([]),
  ]);
  return projectHubTicket(t, { messages, photos, completionPhotos, viewerClientUserId: viewerId(), now, area });
}

// ── the branches ──────────────────────────────────────────────────────────────
// The view: the buildings with each one's next visit (within NEXT_VISIT_DAYS, the server
// function's horizon), the groups the contact is assigned, the org's zone.
export async function view() {
  const o = org();
  // A preview of a building that is not in the book is the server's 404 on every branch.
  if (o.preview && !o.allowedIds.size) throw notFound();
  const now = Date.now();
  const horizon = now + NEXT_VISIT_DAYS * 86400000;
  const buildings = o.clients
    .filter((c) => o.allowedIds.has(c.id))
    .map((c) => {
      const next = hubUpcomingVisits(jobsAt(o, c.id), { now, max: 1 })[0] || null;
      const nextVisit = next && Date.parse(next.startAt) < horizon ? next.startAt : null;
      return projectHubViewBuilding(projectBuilding(o, c), { nextVisit });
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  const groups = o.preview ? [] : projectHubGroups({
    assignedGroupIds: o.assignments.map((a) => a.groupId).filter(Boolean),
    groups: [DEMO_GROUP],
    members: o.groupMembers,
    allowedIds: o.allowedIds,
  });
  const v = buildHubView({ clientUser: DEMO_CLIENT_USER, buildings, groups, brandName: IDENTITY.name, timezone: o.tz });
  return o.preview ? { ...v, viewer: { ...HUB_PREVIEW_VIEWER } } : v;
}

export async function checklists(buildingId, q = {}) {
  const { o, b } = mustBuilding(buildingId);
  const page = pageOf(await buildingChecklists(b.id), q);
  return {
    ...page,
    rows: page.rows.map((r) => projectHubChecklistRow(r, {
      cleanerName: nameOf(o, r.completed_by_user_id),
      cleanerPhoto: faceOf(o, r.completed_by_user_id),
    })),
  };
}

export async function checklist(buildingId, id) {
  const { o, b } = mustBuilding(buildingId);
  const row = (await buildingChecklists(b.id)).find((c) => c.id === id);
  if (!row) throw notFound();
  const photos = await photosOf(row.site_id, row.client_submit_id, 'checklist');
  return {
    checklist: projectHubChecklist(row, {
      cleanerName: nameOf(o, row.completed_by_user_id), cleanerPhoto: faceOf(o, row.completed_by_user_id), photos,
    }),
  };
}

export async function inspections(buildingId, q = {}) {
  const { b } = mustBuilding(buildingId);
  const page = pageOf(await buildingInspections(b.id), q);
  return { ...page, rows: page.rows.map((r) => projectHubInspectionRow(r)) };
}

// The report is the demo's own projectReport twin (qcApi.getInspectionReport), re-picked
// through the hub's allowlists; only its three report keys are read.
async function inspectionFor(buildingId, id) {
  const { b } = mustBuilding(buildingId);
  if (!(await buildingInspections(b.id)).some((i) => i.id === id)) throw notFound();
  const [raw, full] = await Promise.all([qcApi.getInspection(id), qcApi.getInspectionReport(id)]);
  if (!raw || !full) throw notFound();
  const report = { inspection: full.inspection, items: full.items, photos: full.photos };
  return projectHubInspection({ id, report, snapshot: raw.inspection?.template_snapshot || null, items: raw.items || [] });
}
export async function inspection(buildingId, id) {
  return { inspection: await inspectionFor(buildingId, id) };
}
// The demo has no PDF renderer: it prints the same report the PDF is made from.
export async function printInspection(buildingId, id) {
  const ins = await inspectionFor(buildingId, id);
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to print or save the report as a PDF.');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Inspection report</title></head><body>${buildInspectionReportHtml(ins.report)}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

export async function tickets(buildingId, q = {}) {
  const { o, b } = mustBuilding(buildingId);
  const page = pageOf(await clientTickets(b.id), q);
  return { ...page, rows: page.rows.map((t) => projectHubTicketRow(t, { area: areaOf(o, b, t) })) };
}

export async function ticket(buildingId, id) {
  const { o, b } = mustBuilding(buildingId);
  const t = await ticketOf(b.id, id);
  if (!t) throw notFound();
  return { ticket: await fullTicket(t, Date.now(), areaOf(o, b, t)) };
}

export async function createTicket(body = {}) {
  const me = writer();
  const { o, b } = mustBuilding(body.buildingId);
  const input = hubTicketInput(body);
  if (input.refused) throw refuse(400, input.code, input.refused);
  // QR-16: one of the building's own areas, or none — the route's rule.
  const area = ticketAreaInput(body.siteAreaId, o.siteFor.get(b.id) || null);
  if (area.refused) throw refuse(400, area.refused, AREA_MESSAGES[AREA_CODES.unknown]);
  const id = body.id || `pr_hub_${Date.now().toString(36)}`;
  // A caller-minted id is the retry of a ticket raised moments ago, so the hub's year holds it.
  const existing = (await qcApi.listProblemsSince({ sinceIso: hubWindowStartIso() })).find((p) => p.id === id);
  if (existing) {
    if (existing.client_id === b.id && existing.raised_by_client_user_id === me.id) {
      return { ticket: projectHubTicket(existing, { viewerClientUserId: me.id, area: areaOf(o, b, existing) }) };
    }
    throw refuse(409, 'ticket-id');
  }
  const site = o.siteFor.get(b.id) || null;
  const created = await qcApi.createProblem({
    id,
    clientId: b.id,
    siteId: site?.id || null,
    clientName: b.name || null,
    siteName: site?.name || null,
    title: input.value.title,
    description: input.value.description,
    type: input.value.type,
    category: input.value.category,
    priority: input.value.urgent ? 'urgent' : 'medium',
    origin: 'portal',
    raisedByClientUserId: me.id,
    raisedByClientName: me.name,
    siteAreaId: area.value,
  });
  return { ticket: projectHubTicket(created, { viewerClientUserId: me.id, area: areaOf(o, b, created) }) };
}

export async function sendMessage(body = {}) {
  const me = writer();
  const { b } = mustBuilding(body.buildingId);
  const t = await ticketOf(b.id, body.ticketId);
  if (!t) throw notFound();
  const input = hubMessageInput(body);
  if (input.refused) throw refuse(400, input.code, input.refused);
  if (woClientStage(t.status).key === 'completed') throw refuse(409, 'ticket-completed');
  const id = body.id || `wom_hub_${Date.now().toString(36)}`;
  const already = (t.messages || []).find((m) => m.id === id);
  if (already) return { message: projectHubMessage(already, { viewerClientUserId: me.id }) };
  const row = await qcApi.addWorkOrderMessage({
    id, problemId: t.id, body: input.value.body,
    authorRole: 'client', authorName: me.name, authorClientUserId: me.id,
  });
  return { message: projectHubMessage(row, { viewerClientUserId: me.id }) };
}

export async function reopenTicket(body = {}) {
  const { o, b } = mustBuilding(body.buildingId);
  const t = await ticketOf(b.id, body.ticketId);
  if (!t) throw notFound();
  const refusal = ticketReopenRefusal({ status: t.status, resolvedAt: t.resolved_at });
  if (refusal) throw refuse(409, refusal);
  const row = await qcApi.updateProblem({ id: t.id, status: 'open' });
  const after = row || { ...t, status: 'open', resolved_at: null };
  return { ticket: await fullTicket(after, Date.now(), areaOf(o, b, after)) };
}

export async function attachPhoto({ buildingId, ticketId, file }) {
  const { b } = mustBuilding(buildingId);
  const t = await ticketOf(b.id, ticketId);
  if (!t) throw notFound();
  if (woClientStage(t.status).key === 'completed') throw refuse(409, 'ticket-completed');
  if (!file || !String(file.type || '').startsWith('image/') || file.size > 10 * 1024 * 1024) throw refuse(400, 'photo-type');
  if (mediaApi.stubMediaCount({ scope: 'client_ticket', refId: t.id }) >= DEMO_PHOTO_MAX) throw refuse(409, 'too-many-photos');
  const row = await mediaApi.uploadMedia(file, { siteId: t.site_id, clientId: b.id, scope: 'client_ticket', refId: t.id });
  return { photo: projectHubPhoto(row) };
}

// HUB-9: a year of service events. The demo has no activity log behind it, so a ticket's
// progress is read off the ticket itself (its completion), through the same selection.
export async function history(buildingId, q = {}) {
  const { b } = mustBuilding(buildingId);
  const now = Date.now();
  const fromIso = hubWindowStartIso(now);
  const inWindow = (iso) => Date.parse(iso) >= Date.parse(fromIso);
  const [ticketRows, checklistRows, inspectionRows] = await Promise.all([
    clientTickets(b.id), buildingChecklists(b.id), buildingInspections(b.id),
  ]);
  const activity = ticketRows
    .filter((t) => t.resolved_at && inWindow(t.resolved_at))
    .map((t) => ({ action: 'ticket.status_changed', occurredAt: t.resolved_at, entityId: t.id, clientId: b.id, after: { status: 'resolved' } }));
  const events = selectServiceEvents({
    activity,
    timeEntries: timeEntries().filter((e) => e && e.client_id === b.id && inWindow(e.clock_in_at)),
    checklists: checklistRows,
    inspections: inspectionRows,
    tickets: ticketRows,
    ticketIds: ticketRows.map((t) => t.id),
  }).map((e) => projectHubEvent(e));
  const { offset, limit } = hubPage(q);
  const out = hubHistoryPage(events, { offset, limit });
  return { events: out.events, total: out.total, offset, limit };
}

// ── Builder B: messages + updates + email prefs (client hub redesign, plan §3.4) ──────────────
// The twins of api/hub's messages, message, messages-read, updates, updates-seen and email-prefs
// branches. The thread lives in the SAME local store the office's demo reads
// (lib/clientMessagesDemo.js), so a reply typed on the office's Customers tab shows here and the
// other way; the bell's request and inspection lines come from the demo's own Quality stubs, read
// through the same helpers as the pages above.
import * as messagesDemo from './clientMessagesDemo.js';
import {
  projectHubBuildingMessage, projectHubMessageManager, hubUpdate, finishHubUpdates, updatesSinceIso,
  messageCursor, messagePageLimit, messageWindowStartIso, readMarkerAt, countCustomerUnread,
  HUB_MESSAGE_AUTHOR_ROLES as MSG_ROLE,
} from './hubMessages.js';
import { resolveHubEmailPrefs, hubEmailPrefsInput, mergeHubEmailPrefs } from './hubEmailPrefs.js';

const lineFor = (o, row) => projectHubBuildingMessage(row, {
  viewerClientUserId: viewerId(),
  staffName: row.author_role === MSG_ROLE.staff ? o.userById.get(row.author_user_id)?.name || null : null,
});

export async function buildingMessages(buildingId, q = {}) {
  const { o, b } = mustBuilding(buildingId);
  const db = messagesDemo.loadDb();
  const { rows, hasMore } = messagesDemo.threadPage(db, b.id, {
    sinceIso: messageWindowStartIso(), before: messageCursor(q.before), limit: messagePageLimit(q.limit),
  });
  const manager = resolveAccountSupervisor({ clients: o.clients, users: [...o.userById.values()] }, b.id);
  return { messages: rows.map((r) => lineFor(o, r)), hasMore, manager: projectHubMessageManager(manager) };
}

export async function postBuildingMessage(body = {}) {
  const me = writer();
  const { o, b } = mustBuilding(body.buildingId);
  const db = messagesDemo.loadDb();
  const { row } = messagesDemo.appendLine(db, {
    id: body.id,
    clientId: b.id,
    body: body.body,
    author: { role: MSG_ROLE.client, clientUserId: me.id, name: me.name },
    own: (m) => m.client_id === b.id && m.author_role === MSG_ROLE.client && m.author_client_user_id === me.id,
  });
  messagesDemo.saveDb(db);
  return { message: lineFor(o, row) };
}

export async function markBuildingMessagesRead(body = {}) {
  const me = writer();
  const { b } = mustBuilding(body.buildingId);
  const db = messagesDemo.loadDb();
  const readAt = messagesDemo.setMarker(db, b.id, 'client', me.id, readMarkerAt(body.at));
  messagesDemo.saveDb(db);
  return { readAt };
}

export async function updates() {
  const o = org();
  // The bell is a person's news: a read-only preview (nobody) has none, as on the server; acting as
  // the customer it is the stand-in's own.
  const me = actor();
  if (!me) return { ...finishHubUpdates([], { seenAt: null }), seenAt: null, messagesUnread: [] };
  const db = messagesDemo.loadDb();
  const seenAt = db.updatesSeen[me.id] || null;
  const since = Date.parse(updatesSinceIso());
  const inWindow = (iso) => Date.parse(iso) >= since;
  const ids = [...o.allowedIds].sort();
  const nameOf = (id) => o.clients.find((c) => c.id === id)?.name || '';
  const items = [];
  for (const id of ids) {
    // The contact's OWN requests: the office's replies, and a completion.
    for (const t of (await clientTickets(id)).filter((x) => x.raised_by_client_user_id === me.id)) {
      for (const m of hubVisibleMessages(await qcApi.listWorkOrderMessages(t.id))) {
        if (m.author_role !== 'client' && inWindow(m.created_at)) {
          items.push(hubUpdate('reply', { buildingId: id, buildingName: nameOf(id), at: m.created_at, authorName: m.author_name, title: t.title, ticketId: t.id }));
        }
      }
      if (t.resolved_at && inWindow(t.resolved_at)) {
        items.push(hubUpdate('stage', { buildingId: id, buildingName: nameOf(id), at: t.resolved_at, status: 'resolved', title: t.title, ticketId: t.id }));
      }
    }
    for (const i of await buildingInspections(id)) {
      if (inWindow(i.performed_at)) {
        items.push(hubUpdate('inspection', { buildingId: id, buildingName: nameOf(id), at: i.performed_at, name: i.template_snapshot?.name, result: i.result, score: Number.isFinite(i.overall_score) ? i.overall_score : null, inspectionId: i.id }));
      }
    }
  }
  for (const m of db.messages) {
    if (ids.includes(m.client_id) && m.author_role === MSG_ROLE.staff && inWindow(m.created_at)) {
      items.push(hubUpdate('message', { buildingId: m.client_id, buildingName: nameOf(m.client_id), at: m.created_at, authorName: o.userById.get(m.author_user_id)?.name || m.author_name, body: m.body }));
    }
  }
  // Crew on the way: the demo cleaner's On my way taps (lib/timeApi sendOnMyWay keeps them here).
  for (const n of readOnTheWayStub()) {
    if (ids.includes(n.clientId) && inWindow(n.at)) {
      items.push(hubUpdate(ON_THE_WAY_KIND, { buildingId: n.clientId, buildingName: nameOf(n.clientId), at: n.at, eta: n.eta, tz: o.tz }));
    }
  }
  const messagesUnread = ids
    .map((id) => ({ buildingId: id, count: countCustomerUnread(db.messages, { clientId: id, clientUserId: me.id, since: messagesDemo.markerOf(db, id, 'client', me.id) }) }))
    .filter((x) => x.count > 0);
  return { ...finishHubUpdates(items, { seenAt }), seenAt, messagesUnread };
}

export async function markUpdatesSeen() {
  const me = writer();
  const db = messagesDemo.loadDb();
  const seenAt = new Date().toISOString();
  db.updatesSeen[me.id] = seenAt;
  messagesDemo.saveDb(db);
  return { seenAt };
}

export async function emailPrefs() {
  // A read-only preview's switches are the defaults, never the demo contact's own choices; acting as
  // the customer they are the stand-in's own.
  const me = actor();
  if (!me) return { prefs: resolveHubEmailPrefs(null) };
  return { prefs: resolveHubEmailPrefs(messagesDemo.loadDb().emailPrefs[me.id] || null) };
}

export async function saveEmailPrefs(patch) {
  const me = writer();
  const input = hubEmailPrefsInput(patch);
  if (input.refused) throw refuse(400, input.code, input.refused);
  const db = messagesDemo.loadDb();
  db.emailPrefs[me.id] = mergeHubEmailPrefs(db.emailPrefs[me.id], input.value);
  messagesDemo.saveDb(db);
  return { prefs: resolveHubEmailPrefs(db.emailPrefs[me.id]) };
}

// ── Crew on the way: this phone's alerts (api/hub push / push-off) ─────────────────────────────
// The demo keeps its sign-ups in this browser; nothing is ever sent. A preview signs no phone up, as
// on the server: its read answers off and its writes are refused.
const HUB_PUSH_STUB_KEY = 'cleanspace_hub_push_stub_v1';
function pushRows() {
  try { const rows = JSON.parse(localStorage.getItem(HUB_PUSH_STUB_KEY) || '[]'); return Array.isArray(rows) ? rows : []; } catch { return []; }
}
function savePushRows(rows) {
  try { localStorage.setItem(HUB_PUSH_STUB_KEY, JSON.stringify(rows)); } catch { /* demo only */ }
}
export async function pushStatus(endpoint) {
  const me = actor();
  const e = hubPushEndpoint(endpoint);
  if (readHubPreview() || !me || !e) return { on: false };
  return { on: pushRows().some((r) => r.clientUserId === me.id && r.endpoint === e) };
}
export async function pushOn(body) {
  if (readHubPreview()) throw refuse(403, HUB_PUSH_CODES.preview);
  const input = hubPushInput(body);
  if (input.refused) throw refuse(400, input.code, input.refused);
  const me = writer();
  const rows = pushRows().filter((r) => r.endpoint !== input.value.endpoint);
  rows.push({ clientUserId: me.id, endpoint: input.value.endpoint, deviceLabel: input.value.deviceLabel, at: new Date().toISOString() });
  savePushRows(rows);
  return { on: true };
}
export async function pushOff(endpoint) {
  if (readHubPreview()) throw refuse(403, HUB_PUSH_CODES.preview);
  const e = hubPushEndpoint(endpoint);
  if (!e) throw refuse(400, HUB_PUSH_CODES.bad);
  const me = writer();
  savePushRows(pushRows().filter((r) => !(r.clientUserId === me.id && r.endpoint === e)));
  return { on: false };
}

// ── Builder C: invoices + documents (client hub redesign, plan 2026-10-08 §3.5 / §3.6) ────────
// The twins of api/_lib/clientHub/branches/invoicesDocuments.js, built by the SAME pure rules
// (lib/hubInvoices.js, lib/customerDocuments.js). Their imports sit here, with them, so the three
// builders' appends to this file never touch the same lines (an import is hoisted wherever it is).
//   · invoices: the demo QuickBooks book (lib/qboStubData.js stubInvoicesFor). With the demo's
//     QuickBooks CONNECTED, a building's invoices follow its link exactly as live (not linked, or
//     linked by class or location, says so). Not connected, the demo previews the book anyway:
//     the QuickBooks customer carrying the building's own number (GO-2) — so the hub's Invoices
//     page can be seen without connecting anything; a building with no match is "not connected".
//   · documents: the office's demo documents (data/demoStubs.js → CUSTOMER_DOCUMENTS_STUB_KEY) and
//     the building's active contract from the demo contract book (the master agreement over
//     Coral Bay HOA and Bayshore Senior Living). The demo keeps no files: "View" opens the file
//     the office picked this session, else a placeholder page (lib/demoPdf.js).
import { HUB_INVOICE_STATE, hubInvoiceList, invoiceCustomerIds } from './hubInvoices.js';
import {
  AGREEMENT_DOCUMENT_ID, AGREEMENT_FALLBACK_TITLE, CUSTOMER_DOCUMENT_URL_TTL_S,
  hubDocumentList, projectHubAgreement, documentVisibleAt,
} from './customerDocuments.js';
import { stubEntities, stubInvoicesFor } from './qboStubData.js';
import { realmDimension } from './qboRules.js';
import { QBO_STUB_KEY, CUSTOMER_DOCUMENTS_STUB_KEY } from '../data/stubKeys';
import { demoDocumentUrl } from './customerDocumentsApi';
import { placeholderPdfUrl } from './demoPdf';
import { contractsForClient } from './contractsApi';
import { todayKey } from './dates';
import { moneyCents } from './money';

const readStub = (key, empty) => { try { return JSON.parse(localStorage.getItem(key)) || empty; } catch { return empty; } };

// Which demo QuickBooks customers are this building's (the server's buildingInvoiceScope twin).
function demoInvoiceScope(b) {
  const db = readStub(QBO_STUB_KEY, { connection: null, links: [] });
  const customers = stubEntities('customer');
  if (db.connection) {
    const links = (db.links || []).filter((l) => l && l.clientId);
    const own = links.find((l) => l.clientId === b.id);
    if (!own) return { state: HUB_INVOICE_STATE.notLinked };
    if (realmDimension(links) !== 'customer' || own.entityType !== 'customer') return { state: HUB_INVOICE_STATE.unsupportedDimension };
    const others = links.filter((l) => l.clientId !== b.id && l.entityType === 'customer').map((l) => l.entityId);
    return { state: HUB_INVOICE_STATE.ready, customerIds: invoiceCustomerIds(own.entityId, customers, others) };
  }
  const num = typeof b.customerNumber === 'string' ? b.customerNumber : '';
  const match = num ? customers.find((c) => c.active && String(c.name).startsWith(`${num} `)) : null;
  if (!match) return { state: HUB_INVOICE_STATE.notConnected };
  return { state: HUB_INVOICE_STATE.ready, customerIds: invoiceCustomerIds(match.id, customers, []) };
}

function demoInvoices(b) {
  const scope = demoInvoiceScope(b);
  if (scope.state !== HUB_INVOICE_STATE.ready) return { state: scope.state, invoices: [] };
  const today = todayKey();
  return { state: scope.state, invoices: scope.customerIds.flatMap((id) => stubInvoicesFor(id, today)) };
}

export async function invoices(buildingId, q = {}) {
  const { b } = mustBuilding(buildingId);
  const { offset, limit } = hubPage(q);
  const got = demoInvoices(b);
  if (got.state !== HUB_INVOICE_STATE.ready) {
    return { state: got.state, rows: [], total: 0, offset, limit, summary: { openCount: 0, openCents: 0, overdueCount: 0, paidCount: 0 }, asOf: null };
  }
  const list = hubInvoiceList(got.invoices, { today: todayKey(), offset, limit });
  return { state: got.state, rows: list.rows, total: list.total, offset, limit, summary: list.summary, asOf: new Date().toISOString() };
}

// The demo has no QuickBooks to render a PDF: it opens a placeholder page naming the invoice —
// only for an invoice this building's list shows (the server's re-check, in miniature).
export async function invoicePdfUrl(buildingId, id) {
  const { b } = mustBuilding(buildingId);
  const inv = hubInvoiceList(demoInvoices(b).invoices, { today: todayKey(), offset: 0, limit: 10000 }).rows.find((r) => r.id === id);
  if (!inv) throw notFound();
  return placeholderPdfUrl([
    `Invoice ${inv.number}`,
    // (The placeholder page is ASCII only, lib/demoPdf.js: a "-" between, not a "·".)
    `Amount ${moneyCents(inv.totalCents)} - Balance ${moneyCents(inv.balanceCents)}`,
    `Issued ${inv.issuedDay || ''} - Due ${inv.dueDay || ''}`,
    'Sample invoice in the demo. The connected app opens the PDF QuickBooks makes.',
  ]);
}

async function demoAgreement(clientId) {
  const list = await contractsForClient(clientId);
  return (list || []).find((c) => c.status === 'active') || null;
}
const demoDocumentRows = () => readStub(CUSTOMER_DOCUMENTS_STUB_KEY, { documents: [] }).documents || [];

export async function documents(buildingId) {
  const { b } = mustBuilding(buildingId);
  return {
    agreement: projectHubAgreement(await demoAgreement(b.id)),
    documents: hubDocumentList(demoDocumentRows(), b.id, todayKey()),
  };
}

export async function documentUrl(buildingId, id) {
  const { b } = mustBuilding(buildingId);
  if (id === AGREEMENT_DOCUMENT_ID) {
    const a = await demoAgreement(b.id);
    if (!a) throw notFound();
    if (!projectHubAgreement(a).hasFile) throw refuse(404, 'no-file', 'Signed copy not on file yet.');
    return {
      url: placeholderPdfUrl([a.name || AGREEMENT_FALLBACK_TITLE, 'The signed service agreement.', 'Sample document in the demo. The connected app opens the signed copy on file.']),
      expiresIn: CUSTOMER_DOCUMENT_URL_TTL_S,
    };
  }
  const row = demoDocumentRows().find((r) => r.id === id);
  if (!row || !documentVisibleAt(row, b.id)) throw notFound();
  return { url: demoDocumentUrl(row), expiresIn: CUSTOMER_DOCUMENT_URL_TTL_S };
}

// ── Builder A: home + visit (client hub redesign, 2026-10-08) ─────────────────
// The twins of api/hub's `home` (EP-305) and `visit` (EP-306): the same pure rule
// (lib/hubVisit.js hubVisitStatus) and the same projections (lib/hubHome.js, lib/hubVisit.js),
// over the demo's store jobs and its ledger (today's are the manager's day, data/demoManagerDay.js).

// The crew status's four inputs for one building, as the server's visitInputs reads them: jobs
// from the start of yesterday to the end of today, punches and checklist saves from then, the
// next upcoming jobs.
async function visitInputs(o, b, now) {
  const win = hubVisitWindow(now, o.tz);
  const from = Date.parse(win.fromIso);
  const to = Date.parse(win.toIso);
  const all = jobsAt(o, b.id);
  const jobs = all.filter((j) => { const t = Date.parse(j.startAt); return t >= from && t < to; });
  const punches = timeEntries().filter((e) => e && e.client_id === b.id && Date.parse(e.clock_in_at) >= Math.min(from, now - 24 * 3600000));
  const checklists = (await buildingChecklists(b.id)).filter((c) => Date.parse(c.performed_at) >= from);
  return { win, jobs, punches, checklists, upcoming: all };
}

export async function home(buildingId) {
  const { o, b } = mustBuilding(buildingId);
  const now = Date.now();
  const inputs = await visitInputs(o, b, now);
  const status = hubVisitStatus({ ...inputs, client: b, now, tz: o.tz, photoOf: (id) => faceOf(o, id) });
  const tickets = await clientTickets(b.id);
  const stage = (key) => tickets.filter((p) => woClientStage(p.status).key === key).length;
  const inspections = (await buildingInspections(b.id)).slice(0, HUB_TREND_MAX);
  let photos = [];
  let total = 0;
  if (inspections[0]) {
    const all = (await photosOf(inspections[0].site_id, inspections[0].id, 'inspection')).filter((p) => p.kind !== 'video');
    photos = all.slice(0, HUB_TILE_PHOTO_MAX);
    total = all.length;
  }
  return projectHubHome({
    building: projectBuilding(o, b),
    crew: projectHubCrew(status),
    requests: hubRequestCounts({
      open: tickets.filter((p) => woClientStage(p.status).key !== 'completed').length,
      working: stage('working'),
      needsInfo: stage('needs_info'),
    }),
    checklists: hubChecklistTile(await buildingChecklists(b.id), { now, tz: o.tz }),
    inspections: hubInspectionTile(inspections, { photos, totalPhotos: total }),
    // The building's requests from the hub (origin portal, inside the year — the set the server
    // reads, D11); the one rule keeps those resolved in the window.
    resolve: hubResolveTile(tickets, { now }),
  });
}

export async function visit(buildingId) {
  const { o, b } = mustBuilding(buildingId);
  const now = Date.now();
  const inputs = await visitInputs(o, b, now);
  const photoOf = (id) => faceOf(o, id);
  const status = hubVisitStatus({ ...inputs, client: b, now, tz: o.tz, photoOf });
  // Today's visits' photos (and a still-open night clean's), this building's own jobs only.
  const ids = new Set(inputs.jobs.filter((j) => dayKey(j.startAt, o.tz) === inputs.win.today).map((j) => j.id));
  const own = new Set(inputs.jobs.map((j) => j.id));
  for (const p of inputs.punches) if (p.job_id && !p.clock_out_at && own.has(p.job_id)) ids.add(p.job_id);
  const siteId = o.siteFor.get(b.id)?.id || null;
  const rows = (await Promise.all([...ids].map((refId) => photosOf(siteId, refId, HUB_VISIT_PHOTO_SCOPE))))
    .flat()
    .filter((p) => p && p.kind !== 'video' && HUB_VISIT_PHOTO_AREAS.includes(p.area_id ?? p.areaId))
    .sort((a, c) => Date.parse(a.created_at) - Date.parse(c.created_at));
  return projectHubVisit({
    status,
    onSite: hubOnSiteList(inputs.punches, now, { photoOf }),
    photos: projectHubVisitPhotos(hubVisitPhotoPick(rows), { total: rows.length }),
    upcoming: hubUpcomingVisits(inputs.upcoming, { now, max: HUB_UPCOMING_MAX + 1 }),
    manager: projectHubManager(projectBuilding(o, b).supervisor),
  });
}

// The twin of api/hub's `face` (HUB-19): the image of the CURRENT photo whose version is `v`, for a
// building in the contact's scope (else the server's 404) — the demo's stored data URL, where the
// server reads the object from Storage.
export async function face(buildingId, v) {
  const { o } = mustBuilding(buildingId);
  if (!isPhotoVersion(v)) throw notFound();
  const member = [...o.userById.values()].find((u) => photoVersionOf(u) === v);
  if (!member) throw notFound();
  const link = (await fetchAvatarUrls([member.id]))?.urls?.[member.id];
  if (!link || link.v !== v || typeof link.url !== 'string') throw notFound();
  return link.url;
}

// ── the QR scan (the Cleaner Hub, D5 — Builder D): api/hub GET scan, on the demo's codes ─────────
// The same order as the route: a dead code (unknown, replaced, malformed, orphaned) is the public
// page's 404; a building outside the contact's scope (or the preview's one) is 403; the answer is
// the route's allowlist.
export async function scan(token) {
  const code = isScanToken(token) ? demoScanCodeFor(token) : null;
  const o = org();
  const loc = code ? scanLocationOf({ code, sites: o.sites, clients: o.clients }) : null;
  if (!loc) throw refuse(404, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE);
  if (!buildingIn(o, loc.clientId)) throw refuse(403, HUB_SCAN_NOT_YOURS_CODE, "That code is for a building that isn't one of yours.");
  return projectHubScan(loc);
}

// ── one area's page (QR-16, QR Wave 2 — Builder P): api/hub GET area, on the demo's data ─────────
// The same order as the route: the building in the contact's scope (or the preview's one), the area
// on its location, else the hub's 404; the answer is the route's projection (lib/areaScan
// projectHubArea) over the demo's area status, its jobs and its inspections (the public stub's own
// extras, lib/scanCodesApi demoScanExtras). The demo keeps photos as data URLs, so the page is
// handed the picture itself.
export async function area(buildingId, areaId) {
  const { o, b } = mustBuilding(buildingId);
  const site = o.siteFor.get(b.id) || null;
  const a = site && typeof areaId === 'string' ? scanAreasOf(site).find((x) => x.id === areaId) : null;
  if (!a) throw notFound();
  const status = await qcApi.areaStatus({ siteId: site.id, cleaningAreas: [a] });
  const row = (status?.areas || []).find((x) => x.areaId === a.id) || { areaId: a.id, label: a.label, items: [], photo: null };
  const extras = await demoScanExtras({ jobs: o.jobs, company: { timezone: o.tz } }, site, { lastCleanedAt: row.lastCleanedAt ?? null });
  return projectHubArea({
    building: b.name || site.name || null,
    location: site.name || null,
    area: row,
    timeZone: o.tz,
    nowMs: extras.nowMs,
    nextCleanOn: extras.nextCleanOn,
    lastInspectionOn: extras.lastInspectionOn,
  });
}
