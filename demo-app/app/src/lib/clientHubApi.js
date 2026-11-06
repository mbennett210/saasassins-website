// Client adapter for the customer hub — both halves of it:
//   · the OFFICE's administration of customer logins  (/api/client-users/*)
//   · the CUSTOMER's own view of their buildings      (/api/hub/*)
//
// Like the activity log, this is SERVER-ONLY data with no reducer slice and no local mirror:
// client users, groups and assignments live in their own tables (migration 20261003110000)
// precisely so they never enter the shared record. The office's administration has NO stub:
// a stub there would be a stub of an ACCESS CONTROL, the one thing that must never be
// pretended, so demo mode says there is nothing to show.
//
// 🔴 THE HUB'S DEMO (Phase 2 Wave 2 Round 2). Daniel has to SEE the customer's screens without
// a production customer login, so a DEMO build answers the hub's reads and writes from the
// demo's own seeded data (lib/hubDemo.js) through the SAME pure projections the server runs
// (lib/clientHubView.js). It cannot reach production, three ways over:
//   · `HUB_DEMO` is the STATIC `import.meta.env.MODE === 'demo'` (Vite inlines it, so in
//     `npm run build` it folds to false and every demo branch below is dead code), AND the
//     runtime `demoBackendsEngaged()` (no demo where a real backend is configured);
//   · the demo module is reached only through the dynamic import behind `HUB_DEMO`, so a
//     production build emits no chunk for it at all;
//   · check-bundle-stubs fails a production bundle that carries the hub's sentinel or the
//     demo's own fixture names (test-bundle-stubs.mjs builds one and runs it in CI).
// The production gate is unchanged: HubRoot's isClientSession, and requireClientUser on the
// server for every /api/hub/* call.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged, markStub } from './demoMode';
import { supabase } from './supabaseClient';
import { makeThumbnail } from './accountMediaApi';
import { shrinkPhoto } from './imageCanvas';
import {
  readHubPreview, hubPreviewActsAsCustomer, HUB_PREVIEW_HEADER, HUB_PREVIEW_READ_ONLY, HUB_PREVIEW_SENTENCES,
} from './hubPreview';

const STUB = demoBackendsEngaged(); // prod builds ignore the demo env — see lib/demoMode.js
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isClientHubStub() { return !BACKEND; }

export const CLIENT_HUB_STUB_MESSAGE =
  'Customer logins need the connected app — there is nothing to show in demo mode.';

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

async function api(path, { method = 'GET', body, headers: extra = {} } = {}) {
  // No backend = no customer logins, and it says so. There is deliberately NO stub here:
  // a simulated ACCESS CONTROL is the one thing that must never be pretended (CS-038's
  // lesson, and CS-010's before it). Without this, every write fetched the literal string
  // "null/client-users/…" and failed as a network error instead of a sentence.
  if (!BACKEND) {
    const err = new Error(CLIENT_HUB_STUB_MESSAGE);
    err.status = 501;
    throw err;
  }
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...auth, ...extra, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code || null;
    throw err;
  }
  return json;
}

const EMPTY_ADMIN = { users: [], groups: [], groupMembers: [], assignments: [], stub: true };

// ── office ───────────────────────────────────────────────────────────────────
export async function listClientHub() {
  if (!BACKEND) return EMPTY_ADMIN;
  return api('/client-users/list');
}

// Who can see ONE building, split into direct grants and grants that arrive through a group —
// the office has to know which, because taking someone off a building they hold through a
// city group does nothing.
export async function whoCanSee(clientId) {
  if (!BACKEND) return { direct: [], viaGroup: [], groups: [], stub: true };
  return api(`/client-users/for-client${qs({ clientId })}`);
}

export async function saveClientUser({ id, name, email, phone }) {
  return api('/client-users/save', { method: 'POST', body: { id, name, email, phone } });
}

// Replaces one person's grants. `base` is the set the screen LOADED ({ clientIds, groupIds }): the
// server replaces only while that is still the stored set (CS-662) — else 409 `stale` (someone
// changed it since) or `reload` (no base: an out-of-date screen), and nothing is deleted.
export async function setClientUserAssignments({ id, clientIds, groupIds, base }) {
  return api('/client-users/assign', { method: 'POST', body: { id, clientIds, groupIds, base } });
}

// Creates (or re-creates) the login and sends the set-password email. When nothing was emailed
// (`invited: false`, with the server's `why`) the answer carries `link` — the one-time
// set-password URL — so the office can send it themselves while no system sender is connected
// (GO-10); an emailed invite carries none. A re-invite VOIDS the link sent before.
// 🔴 Show it, let them copy it, never persist it.
export async function inviteClientUser(id) {
  return api('/client-users/invite', { method: 'POST', body: { id } });
}

export async function setClientUserStatus(id, status) {
  return api('/client-users/status', { method: 'POST', body: { id, status } });
}

export async function removeClientUser(id) {
  return api('/client-users/remove', { method: 'POST', body: { id } });
}

// An existing group's save names the buildings the editor LOADED (`baseClientIds`), as
// setClientUserAssignments names its base (CS-662); a new group has none.
export async function saveClientGroup({ id, name, kind, clientIds, baseClientIds }) {
  return api('/client-users/group-save', { method: 'POST', body: { id, name, kind, clientIds, ...(id ? { baseClientIds } : {}) } });
}

export async function removeClientGroup(id) {
  return api('/client-users/group-remove', { method: 'POST', body: { id } });
}

// ── the customer's own view ──────────────────────────────────────────────────
// PLAIN member read so Vite inlines it and the whole demo folds away in production (header).
export const HUB_DEMO = import.meta.env.MODE === 'demo' && demoBackendsEngaged();
if (HUB_DEMO) markStub('cs-stub:hub');
const loadDemo = HUB_DEMO ? () => import('./hubDemo.js') : null;
export function isHubDemo() { return HUB_DEMO; }

// THE OFFICE'S PREVIEW (the client hub redesign, plan §3.7; lib/hubPreview.js): while this tab is
// previewing a building, every hub call names it in HUB_PREVIEW_HEADER. The SERVER decides what
// that buys (a staff login holding hub.users.view: that one building, acting as its stand-in
// customer — or read-only with HUB_PREVIEW_ACTS_AS_CUSTOMER off; a customer login: nothing, the
// header is ignored), so this only says which building.
function previewHeaders() {
  const p = readHubPreview();
  return p ? { [HUB_PREVIEW_HEADER]: p.buildingId } : {};
}
// The demo's twin of the server's refusal of every write in a READ-ONLY preview (the switch off;
// the demo IS the server there, so it answers the same code and sentence).
function previewRefusal() {
  const err = new Error(HUB_PREVIEW_SENTENCES[HUB_PREVIEW_READ_ONLY]);
  err.status = 403;
  err.code = HUB_PREVIEW_READ_ONLY;
  return err;
}

// Every hub call goes through here: the demo's answer in a demo build, the server's otherwise.
async function hub(demoFn, args, path, opts) {
  if (loadDemo) {
    if (readHubPreview() && !hubPreviewActsAsCustomer() && opts?.method && opts.method !== 'GET') throw previewRefusal();
    const demo = await loadDemo();
    return demo[demoFn](...args);
  }
  return api(path, { ...opts, headers: previewHeaders() });
}

// The landing view: every building this login may see. The scope is resolved server-side
// from the login's claim — this sends no building id, so there is nothing for an IDOR to change.
export async function fetchHubView() {
  return hub('view', [], '/hub/view'); // throws 501 with CLIENT_HUB_STUB_MESSAGE with no backend
}

// Every section of one building. Each call NAMES a building, and the server checks it against
// the login's scope before reading anything (a building outside it is a 404).
export async function fetchHubChecklists(buildingId, { offset = 0, limit } = {}) {
  return hub('checklists', [buildingId, { offset, limit }], `/hub/checklists${qs({ buildingId, offset, limit })}`);
}
export async function fetchHubChecklist(buildingId, id) {
  return hub('checklist', [buildingId, id], `/hub/checklist${qs({ buildingId, id })}`);
}
export async function fetchHubInspections(buildingId, { offset = 0, limit } = {}) {
  return hub('inspections', [buildingId, { offset, limit }], `/hub/inspections${qs({ buildingId, offset, limit })}`);
}
export async function fetchHubInspection(buildingId, id) {
  return hub('inspection', [buildingId, id], `/hub/inspection${qs({ buildingId, id })}`);
}
export async function fetchHubTickets(buildingId, { offset = 0, limit } = {}) {
  return hub('tickets', [buildingId, { offset, limit }], `/hub/tickets${qs({ buildingId, offset, limit })}`);
}
export async function fetchHubTicket(buildingId, id) {
  return hub('ticket', [buildingId, id], `/hub/ticket${qs({ buildingId, id })}`);
}
export async function fetchHubHistory(buildingId, { offset = 0, limit } = {}) {
  return hub('history', [buildingId, { offset, limit }], `/hub/history${qs({ buildingId, offset, limit })}`);
}

// The customer's camera (the Cleaner Hub, D5, 2026-10-13; EP-387): which of their buildings a
// scanned code is in — { buildingId, building, area }. The server checks the code's building against
// the login's scope (403 `not-your-building`); a dead code is 404 `scan-code-inactive`.
export async function resolveHubScan(token) {
  return hub('scan', [token], `/hub/scan${qs({ token })}`);
}

// One area of a building (QR-16, QR Wave 2; EP-421): what its code's page shows the customer —
// { scan, photoUrl }: `scan` is the public page's own projection (lib/areaScan projectAreaScan: the
// last clean, what was done, the next clean and the last inspection as dates), `photoUrl` a
// short-lived signed thumbnail of the newest photo beside a recorded clean, or null. The server
// checks the building against the login's scope and the area against its location (else 404).
export async function fetchHubArea(buildingId, areaId) {
  return hub('area', [buildingId, areaId], `/hub/area${qs({ buildingId, areaId })}`);
}

// The writes. Each mints its own id (THE LAW II.7) so a retried tap is one ticket, one message.
const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);
// `siteAreaId` (QR Wave 2): the cleaning area a request is about, when it was raised from that area's
// page (QR-16) — the server stores it once it knows the key, and ignores it until then.
export async function createHubTicket({ buildingId, type, category, description, urgent = false, id = newId(), siteAreaId = null }) {
  const body = { id, buildingId, type, category, description, urgent: urgent === true, ...(typeof siteAreaId === 'string' && siteAreaId ? { siteAreaId } : {}) };
  return hub('createTicket', [body], '/hub/ticket-create', { method: 'POST', body });
}
export async function sendHubMessage({ buildingId, ticketId, body: text, id = newId() }) {
  const body = { id, buildingId, ticketId, body: text };
  return hub('sendMessage', [body], '/hub/ticket-message', { method: 'POST', body });
}
export async function reopenHubTicket({ buildingId, ticketId }) {
  const body = { buildingId, ticketId };
  return hub('reopenTicket', [body], '/hub/ticket-reopen', { method: 'POST', body });
}

// The customer's own photo on their ticket: shrunk on the device first (lib/imageCanvas
// shrinkPhoto, CS-678 — a camera photo becomes a JPEG of a few hundred KB), an upload address
// from the server (filed under the ticket's own location), the bytes straight to Storage, a
// small poster when one can be made, then the record. Returns { photo }.
export async function attachHubTicketPhoto({ buildingId, ticketId, file: picked, id = newId() }) {
  const file = await shrinkPhoto(picked);
  if (loadDemo) {
    if (readHubPreview() && !hubPreviewActsAsCustomer()) throw previewRefusal();
    return (await loadDemo()).attachPhoto({ buildingId, ticketId, file });
  }
  const up = await api('/hub/ticket-photo-url', {
    method: 'POST', body: { buildingId, ticketId, mimeType: file.type, sizeBytes: file.size }, headers: previewHeaders(),
  });
  const sent = await supabase.storage.from('ops-media').uploadToSignedUrl(up.path, up.token, file);
  if (sent.error) throw new Error('The photo did not upload. Try again.');
  let thumbPath = null;
  if (up.thumb?.path && up.thumb?.token) {
    try {
      const poster = await makeThumbnail(file, false);
      if (poster) {
        const t = await supabase.storage.from('ops-media').uploadToSignedUrl(up.thumb.path, up.thumb.token, poster);
        if (!t.error) thumbPath = up.thumb.path;
      }
    } catch { /* best-effort: the photo itself is what matters */ }
  }
  return api('/hub/ticket-photo', {
    method: 'POST',
    body: { id, buildingId, ticketId, storagePath: up.path, thumbPath, mimeType: file.type, sizeBytes: file.size },
    headers: previewHeaders(),
  });
}

// The inspection report as a PDF. The endpoint needs the Authorization header, so a plain
// link cannot reach it: fetch the bytes, then save them. The demo prints the same report.
export async function downloadHubInspectionPdf(buildingId, id) {
  if (loadDemo) return (await loadDemo()).printInspection(buildingId, id);
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/hub/inspection-pdf${qs({ buildingId, id })}`, { headers: { ...auth, ...previewHeaders() } });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); msg = j?.error || msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const name = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'inspection.pdf';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Builder B: messages + updates + email prefs (client hub redesign, plan §3.4) ──────────────
// The customer's side of a building's thread with the office, the bell, and the login's own email
// switches. Each call names at most a building — the server checks it against the login's scope
// and takes the author, the reader and the row to write from the login's claim, never from here.
// In a demo build the answers come from lib/hubDemo.js's twins, as every other hub call's do.

// One building's thread: { messages[] (oldest first; each { id, body, createdAt, mine, authorRole,
// authorName }), hasMore, manager: { name } | null }. `before` (an ISO time: the oldest line
// shown) pages back; at most 50 lines a call, the last 12 months.
export async function fetchHubMessages(buildingId, { before = null, limit } = {}) {
  return hub('buildingMessages', [buildingId, { before, limit }], `/hub/messages${qs({ buildingId, before, limit })}`);
}
// Post a line: { message }. The id is minted here (THE LAW II.7), so a retried Send is one line.
export async function postHubMessage({ buildingId, body: text, id = newId() }) {
  const body = { id, buildingId, body: text };
  return hub('postBuildingMessage', [body], '/hub/message', { method: 'POST', body });
}
// Mark the thread read up to `at` (the newest line shown): { readAt }.
export async function markHubMessagesRead(buildingId, at = null) {
  const body = { buildingId, at };
  return hub('markBuildingMessagesRead', [body], '/hub/messages-read', { method: 'POST', body });
}
// The bell: { updates[] (newest first, at most 20, the last 30 days; each { kind: 'reply' |
// 'stage' | 'message' | 'inspection', buildingId, buildingName, text, at, url, unread }), unseen,
// seenAt, messagesUnread: [{ buildingId, count }] } — the last also drives the Messages badge.
export async function fetchHubUpdates() {
  return hub('updates', [], '/hub/updates');
}
// Opening the bell: { seenAt }.
export async function markHubUpdatesSeen() {
  return hub('markUpdatesSeen', [], '/hub/updates-seen', { method: 'POST', body: {} });
}
// The login's own email switches: { prefs: { messages, requests, inspections } } (all booleans).
export async function fetchHubEmailPrefs() {
  return hub('emailPrefs', [], '/hub/email-prefs');
}
// Save one or more switches (booleans only): { prefs } as saved.
export async function saveHubEmailPrefs(patch) {
  return hub('saveEmailPrefs', [patch], '/hub/email-prefs', { method: 'POST', body: patch });
}

// ── Crew on the way: this phone's alerts (lib/hubAlerts.js drives them) ────────────────────────
// Is this phone (its push address) signed up for the caller's alerts: { on }.
export async function fetchHubPush(endpoint) {
  return hub('pushStatus', [endpoint], `/hub/push?endpoint=${encodeURIComponent(endpoint || '')}`);
}
// Turn them on for this phone: the browser's PushSubscription (toJSON) and a label. { on: true }.
export async function saveHubPush({ subscription, deviceLabel }) {
  return hub('pushOn', [{ subscription, deviceLabel }], '/hub/push', { method: 'POST', body: { subscription, deviceLabel } });
}
// Turn them off for this phone. { on: false }.
export async function removeHubPush(endpoint) {
  return hub('pushOff', [endpoint], '/hub/push-off', { method: 'POST', body: { endpoint } });
}

// ── Builder C: invoices + documents (client hub redesign, plan 2026-10-08 §3.5 / §3.6) ────────
// Read-only. Each call NAMES a building and the server checks it against the login's scope
// first (another building is a 404). The demo answers from lib/hubDemo.js's twins.
//
//   fetchHubInvoices(buildingId, { offset, limit })
//     → { state, rows: [{ id, number, totalCents, balanceCents, issuedDay, dueDay, paidDay,
//         status: 'paid'|'open'|'overdue', partlyPaid }], total, offset, limit,
//         summary: { openCount, openCents, overdueCount, paidCount }, asOf }
//     state ∈ lib/hubInvoices.js HUB_INVOICE_STATE; anything but 'ready' carries no rows and its
//     sentence is HUB_INVOICE_STATE_SENTENCES[state]. Money is integer cents.
//   openHubInvoicePdf(buildingId, id)       → opens QuickBooks's PDF of that invoice in a new tab
//   fetchHubDocuments(buildingId)
//     → { agreement: { title, startedDay, hasFile } | null, documents: [{ id, kind, title, validUntil, expired }] }
//   fetchHubDocumentUrl(buildingId, id)     → { url, expiresIn }  (id = a document id or 'agreement')
//   openHubDocument(buildingId, id)         → opens that link in a new tab
export async function fetchHubInvoices(buildingId, { offset = 0, limit } = {}) {
  return hub('invoices', [buildingId, { offset, limit }], `/hub/invoices${qs({ buildingId, offset, limit })}`);
}
export async function fetchHubDocuments(buildingId) {
  return hub('documents', [buildingId], `/hub/documents${qs({ buildingId })}`);
}
export async function fetchHubDocumentUrl(buildingId, id) {
  return hub('documentUrl', [buildingId, id], `/hub/document-url${qs({ buildingId, id })}`);
}

// A new tab opened INSIDE the tap (so a pop-up blocker lets it through), then pointed at the
// link once it arrives; closed again if the link cannot be had.
async function intoNewTab(getUrl) {
  const w = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  try {
    const url = await getUrl();
    if (w) { w.opener = null; w.location.href = url; } else window.open(url, '_blank', 'noopener');
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

export async function openHubDocument(buildingId, id) {
  return intoNewTab(async () => (await fetchHubDocumentUrl(buildingId, id)).url);
}

// The invoice PDF needs the Authorization header, so a plain link cannot reach it: fetch the
// bytes, then open them. The demo opens a placeholder page for an invoice the building shows.
export async function openHubInvoicePdf(buildingId, id) {
  return intoNewTab(async () => {
    if (loadDemo) return (await loadDemo()).invoicePdfUrl(buildingId, id);
    const auth = await authHeaders();
    const res = await fetch(`${BACKEND}/hub/invoice-pdf${qs({ buildingId, id })}`, { headers: { ...auth, ...previewHeaders() } });
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try { const j = await res.json(); msg = j?.error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    return URL.createObjectURL(await res.blob());
  });
}

// ── Builder A: home + visit (client hub redesign, 2026-10-08) ─────────────────
// Home: the building, the crew band and the Requests / Checklists / Inspections tiles (EP-305).
export async function fetchHubHome(buildingId) {
  return hub('home', [buildingId], `/hub/home${qs({ buildingId })}`);
}
// Today's Visit: the crew status and its timeline, who is on site, the visit's before/after
// photos, the next visits and the account manager (EP-306).
export async function fetchHubVisit(buildingId) {
  return hub('visit', [buildingId], `/hub/visit${qs({ buildingId })}`);
}

// A team member's photo (HUB-19): an image source for a face an answer served ({ v },
// lib/hubFaces.js). The endpoint needs the Authorization header, so a plain <img> cannot reach it:
// fetch the bytes and hand back an object URL (pages/hub/hubFaces.js keeps one per photo for the
// page's life; the browser keeps the bytes, which never change for a version). The demo answers
// its stored photo.
export async function fetchHubFace(buildingId, v) {
  if (loadDemo) return (await loadDemo()).face(buildingId, v);
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/hub/face${qs({ buildingId, v })}`, { headers: { ...auth, ...previewHeaders() } });
  if (!res.ok) {
    const err = new Error(`Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}
