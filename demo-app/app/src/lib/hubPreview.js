// PREVIEW AS CUSTOMER — the office opens the customer hub as ONE building's customers see it, with
// no customer login (the client hub redesign, plan 2026-10-08 §3.7, decision D2: Daniel, "Yes build
// it."), and since 2026-10-09 USES it as that building's customer (Daniel, on seeing New request
// greyed out: "that's the whole point, swapping the role should simulate being signed into that
// account for now"). Shared by the server's gate (api/_lib/authz.js requireHubCaller), the hub route
// (api/hub/[...path].js), the demo's twin (lib/hubDemo.js) and the screens.
//
// HOW IT WORKS
//   · An entry point — the customer page's "Preview customer hub" button, or the user menu's
//     "Preview the customer hub" and its building picker — stores the building in this TAB's
//     sessionStorage (startHubPreview) and opens /hub/b/<id>.
//   · HubRoot admits a STAFF session to the hub only while that flag is set (a customer session
//     ignores it), and lib/clientHubApi.js sends HUB_PREVIEW_HEADER with every hub call.
//   · The server admits a staff login to /api/hub/* ONLY with that header AND `hub.users.view`
//     (claims-first, crew never) and scopes the request to exactly that building (it must be in the
//     live customer book, else 404). A customer login's header is ignored.
//   · ACTING AS THE CUSTOMER (HUB_PREVIEW_ACTS_AS_CUSTOMER, below): the route then acts as the
//     building's STAND-IN customer login — one client_users row per building, status 'preview'
//     (lib/clientHub.js CLIENT_USER_PREVIEW_STATUS: no access, so it can never sign in, is never
//     emailed and the office's Customer logins never show it), named HUB_PREVIEW_STAND_IN_NAME, at
//     hubPreviewStandInEmail(building) (the reserved .invalid domain: never a mailbox). Every write
//     works and reaches the office exactly as a customer's would: the routing rule, the bells, the
//     Work orders queue, the activity log ("Preview customer", actor role client).
//   · With the switch OFF, the preview is read-only, as it was built on 2026-10-08: no stand-in, the
//     viewer nobody, every write refused (403 HUB_PREVIEW_READ_ONLY), and every write control drawn
//     disabled with HUB_PREVIEW_NOTE (UI_RULES §151).
//   · The layout shows hubPreviewBanner(name) with "Exit preview" (clearHubPreview, then back to the
//     customer page) and derives ONE flag for the screens: readOnly = preview && !the switch.
//
// This module is PURE and imports nothing (api/_lib/authz.js, which every server route loads, reads
// its constants); the three sessionStorage helpers at the end touch the browser only when called.

// 🔴 THE SWITCH. true: the office's preview acts as the building's customer (every write is real).
// false: the read-only preview. Daniel said "for now", so this is the way back, not a deletion; the
// server, the demo and the screens all read it through hubPreviewActsAsCustomer().
export const HUB_PREVIEW_ACTS_AS_CUSTOMER = true;
// The switch as everything reads it. Only the test suites move it (test-hub-preview.mjs runs both
// settings), through the seam below; nothing in the app calls the seam.
let actsOverride = null;
export const hubPreviewActsAsCustomer = () => (actsOverride === null ? HUB_PREVIEW_ACTS_AS_CUSTOMER : actsOverride);
export function __setHubPreviewActsForTests(v) { actsOverride = v === undefined || v === null ? null : !!v; }

// The request header naming the building being previewed (Node lower-cases header names).
export const HUB_PREVIEW_HEADER = 'x-hub-preview';
// The permission that opens a preview: the same key that shows the office who can sign in to a
// building (Customer Logins), owner / admin / manager by default, never crew.
export const HUB_PREVIEW_PERMISSION = 'hub.users.view';
// The codes a preview answers with.
export const HUB_PREVIEW_READ_ONLY = 'preview-read-only';   // any write, in a read-only preview
export const HUB_PREVIEW_FORBIDDEN = 'preview-forbidden';   // a staff login that may not preview
export const HUB_PREVIEW_CHECK_FAILED = 'preview-check-failed'; // the matrix could not be read (fail closed)
export const HUB_PREVIEW_SENTENCES = Object.freeze({
  [HUB_PREVIEW_READ_ONLY]: "This is a preview of the customer hub. Nothing here is sent.",
  [HUB_PREVIEW_FORBIDDEN]: "You don't have access to preview the customer hub.",
  [HUB_PREVIEW_CHECK_FAILED]: "Your access couldn't be checked just now. Try again in a moment.",
});

// The building's stand-in customer: its name (what the office sees on a request or a message the
// preview sent, and the hub's viewer), and its address — `preview+<building>@preview.invalid`, at
// the TLD reserved for names that never resolve (RFC 2606), lower-cased (the table is unique on
// lower(email) per org), so it is never a real mailbox. The office cannot create a login there.
export const HUB_PREVIEW_STAND_IN_NAME = 'Preview customer';
export const HUB_PREVIEW_EMAIL_DOMAIN = 'preview.invalid';
export const hubPreviewStandInEmail = (buildingId) => `preview+${String(buildingId || '').toLowerCase()}@${HUB_PREVIEW_EMAIL_DOMAIN}`;
export const isHubPreviewEmail = (email) => typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${HUB_PREVIEW_EMAIL_DOMAIN}`);

// The viewer a preview shows: the stand-in's name, and no address, phone or first name (so Home's
// greeting reads "Good afternoon", and the Account page shows no made-up address). Exactly the
// view's viewer allowlist (lib/clientHub.js HUB_VIEWER_FIELDS).
export const HUB_PREVIEW_VIEWER_NAME = HUB_PREVIEW_STAND_IN_NAME;
export const HUB_PREVIEW_VIEWER = Object.freeze({ name: HUB_PREVIEW_VIEWER_NAME, firstName: '', email: '', phone: '' });

// The words (the hub stays English, LANG-8). Acting as the customer, the banner says what is true:
// what the office sends here is real. Read-only, it says nothing is sent.
export const hubPreviewBanner = (buildingName, { actsAsCustomer = hubPreviewActsAsCustomer() } = {}) => (actsAsCustomer
  ? `Preview: you're using the customer hub as ${buildingName || 'this building'}'s customer. What you send here is real: it reaches the office as a customer's would.`
  : `Preview: you're seeing what customers of ${buildingName || 'this building'} see. Nothing here is sent.`);
// Beside a write control in a READ-ONLY preview only.
export const HUB_PREVIEW_NOTE = 'Preview: nothing here is sent.';

// A building id as the header (or the stored flag) may carry it: one trimmed string, at most 200
// characters. It is only ever COMPARED with the live customer book's ids, so this bounds garbage;
// it is not the gate. Anything else is null.
export function hubPreviewBuildingIdOf(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v && v.length <= 200 ? v : null;
}

// Where Exit preview goes: the building's customer page in the office app.
export const hubPreviewExitPath = (buildingId) => (buildingId ? `/clients/${encodeURIComponent(buildingId)}` : '/');

// ── the flag (per TAB: sessionStorage) ─────────────────────────────────────────
// Every access is wrapped: a private window or blocked storage keeps the preview in memory for this
// page's life instead, so an entry point still works there.
export const HUB_PREVIEW_STORAGE_KEY = 'cleanspace_hub_preview_v1';
let memory = null;

// { buildingId, name } | null
export function readHubPreview() {
  let raw = null;
  try { raw = sessionStorage.getItem(HUB_PREVIEW_STORAGE_KEY); } catch { raw = null; }
  let v = memory;
  if (raw) {
    try { v = JSON.parse(raw); } catch { v = null; }
  }
  const buildingId = hubPreviewBuildingIdOf(v?.buildingId);
  return buildingId ? { buildingId, name: typeof v?.name === 'string' ? v.name.slice(0, 200) : '' } : null;
}

// Start previewing a building. Returns false for no building.
export function startHubPreview({ buildingId, name = '' } = {}) {
  const id = hubPreviewBuildingIdOf(buildingId);
  if (!id) return false;
  memory = { buildingId: id, name: String(name || '') };
  try { sessionStorage.setItem(HUB_PREVIEW_STORAGE_KEY, JSON.stringify(memory)); } catch { /* memory holds it */ }
  return true;
}

export function clearHubPreview() {
  memory = null;
  try { sessionStorage.removeItem(HUB_PREVIEW_STORAGE_KEY); } catch { /* nothing stored */ }
}
