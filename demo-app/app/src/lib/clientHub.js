// THE CLIENT HUB — the vocabulary, shared by the browser and the server.
//
// Matt's answers (HUB-1/3/4/14/17, GO-10, 2026-10-02): every client contact gets their own
// login, the office adds and removes them, buildings are assigned PER PERSON, and a GROUP
// stands for a management company or a city so a facility director sees every building in
// their city while a property manager sees only theirs. Pilot invites are sent by the office.
//
// VOCABULARY. The office says "Customers"; the client side says "buildings" — Matt's word.
// A building IS one customer row (`state.clients`, the single-location model since 2026-09-10),
// and its supervisor is `client.supervisorId`, a team member whose own phone the hub shows.
//
// 🔴 WHY THE CLIENT-SIDE DATA LIVES IN ITS OWN TABLES AND NOT IN org_state. The shared record
// is ONE row every office browser reads and the server rewrites on every save, with a hard
// byte ceiling (3.5 MB). 1,500 cleaners and 750 buildings are already in it; client logins,
// groups and per-person assignments grow with the customer book and change independently, so
// they live in public.client_users / client_user_groups / client_user_group_members /
// client_user_assignments (migration 20261003110000). Those tables have RLS on and NO
// policies: the browser never reads them, only /api/client-users/* and /api/hub/* do.
//
// This module is PURE — no imports that reach a backend — because both halves read it:
// api/_lib/clientHub/store.js and the office + hub screens.
import { composeAddress } from './address.js';
import { hubFaceOf } from './hubFaces.js';

// The role a client login's JWT carries in `app_metadata.role`. It is deliberately NOT in
// `ROLES` (lib/roles.js): a client is not a tier of staff, holds no permission in the matrix,
// and `can()` must never be asked about one. api/_lib/claims.js imports this so the server
// and the browser can never disagree on the string, and api/_lib/authz.js refuses it from
// every office gate (see CLIENT_LOGIN_REFUSAL).
export const CLIENT_ROLE = 'client';

// Is the signed-in session a CUSTOMER's? Read from the JWT's app_metadata, which only the
// service role can write — the same claim the server gates on, so the two halves of the
// redirect (office → /hub, customer → /) can never disagree. In local/demo mode there is no
// claim at all, so this is false and the office app renders as it always has.
export const isClientSession = (session) => session?.user?.app_metadata?.role === CLIENT_ROLE;

// The refusal code every office gate answers a client login with. Distinct from
// `account-disabled` / `not-on-team` so a log line says WHICH boundary held, and so the
// browser can tell "you are signed in, but this is not your app" from "your access ended".
export const CLIENT_LOGIN_REFUSAL = 'client-login';

// A client user's lifecycle. 'invited' means the login exists and the set-password link is
// out; the first sign-in has to work before anyone marks them active, so invited HOLDS
// access. 'disabled' is the office ending it (the login is banned in GoTrue too).
export const CLIENT_USER_STATUSES = Object.freeze(['invited', 'active', 'disabled']);

// An ALLOWLIST, the same posture as the staff roster's ACCESS_STATUSES: anything else —
// a crafted 'Disabled ', a value from a future version, a non-string — holds nothing.
export const CLIENT_USER_ACCESS_STATUSES = Object.freeze(['invited', 'active']);

export function clientUserHasAccess(status) {
  if (typeof status !== 'string') return false;
  return CLIENT_USER_ACCESS_STATUSES.includes(status.trim().toLowerCase());
}

// THE OFFICE PREVIEW'S STAND-IN (2026-10-09, the client hub redesign §3.7: the office's preview acts
// as a building's customer — lib/hubPreview.js). One client_users row per building, made by the hub
// route the first time the office previews it, so every write the preview makes is a customer's
// write. Its status is deliberately in NEITHER list above: the office cannot set it
// (CLIENT_USER_STATUSES), it holds no access (clientUserHasAccess is false, so no login can use it,
// no scope resolves for it and no email is sent to it), and /api/client-users never lists or
// touches a row that carries it.
export const CLIENT_USER_PREVIEW_STATUS = 'preview';
export const isPreviewStandIn = (row) => !!row && row.status === CLIENT_USER_PREVIEW_STATUS;

// HUB-3 / HUB-17: a group is a management company, a city, or something else the office
// names. The kind is a label, not a rule — what a group DOES is grant its member buildings.
export const CLIENT_GROUP_KINDS = Object.freeze([
  { id: 'management', label: 'Management company' },
  { id: 'city', label: 'City' },
  { id: 'other', label: 'Other' },
]);
export const isClientGroupKind = (k) => CLIENT_GROUP_KINDS.some((g) => g.id === k);

// ── scope ────────────────────────────────────────────────────────────────────
// WHICH BUILDINGS A CLIENT USER MAY SEE. The single rule, pure, so the server gate and any
// screen that previews a person's access read the same answer.
//
//   · DIRECT assignments name a customer id outright (a property manager, one building).
//   · A GROUP assignment grants every customer currently in that group — including one added
//     to the group later, because membership is read at request time and never copied onto
//     the person (HUB-17: "a city's facility director sees every building in that city").
//   · A customer the office REMOVED is dropped: `clientIds` is the live customer book, and a
//     stale assignment row to a deleted customer grants nothing.
//   · A DISABLED (or unrecognized-status) user resolves to NOTHING, whatever they are
//     assigned. Status is checked here as well as at the gate so neither can be the only one.
//
// Returns a sorted array of customer ids, deduplicated.
export function resolveAllowedClientIds({
  status = 'active', assignments = [], groupMembers = [], clientIds = null,
} = {}) {
  if (!clientUserHasAccess(status)) return [];
  const rows = Array.isArray(assignments) ? assignments : [];
  const groupIds = new Set(rows.map((a) => a && a.groupId).filter(Boolean));
  const allowed = new Set(rows.map((a) => a && a.clientId).filter(Boolean));
  for (const m of Array.isArray(groupMembers) ? groupMembers : []) {
    if (m && m.clientId && groupIds.has(m.groupId)) allowed.add(m.clientId);
  }
  const known = clientIds == null ? null : new Set(clientIds);
  return [...allowed].filter((id) => known == null || known.has(id)).sort();
}

// ── the hub projection ───────────────────────────────────────────────────────
// 🔴 AN ALLOWLIST OF FIELDS, NOT A BLACKLIST. The customer record carries revenue, internal
// notes, access codes, tags, the billing address and the supervisor's pay — none of which a
// customer may read. A projection that DELETED the sensitive fields would leak the next one
// somebody adds. So the hub builds a new object from this list and nothing else, and the
// isolation test compares the served keys against this constant.
export const HUB_BUILDING_FIELDS = Object.freeze([
  'id', 'name', 'customerNumber', 'street', 'city', 'state', 'zip', 'address', 'supervisor',
]);

// The supervisor as the client may see them: who to call, and the number from their OWN
// profile (HUB-12 / HUB-18) — never the office switchboard, never their pay or email. The
// name is first name + last initial ("Dana K.", the redesign's "Account Manager · Dana K."):
// a staff name reaches a customer only through hubPersonName (plan §3, 2026-10-08). `photo` is
// their profile photo's version, { v }, or null (lib/hubFaces.js; HUB-19, Matt's "Your Account
// Manager", 2026-11-02).
export const HUB_SUPERVISOR_FIELDS = Object.freeze(['id', 'name', 'phone', 'photo']);

// ONE building for the hub. `site` is the customer's single location (for the composed
// address it already carries); `supervisor` is the team-member row `client.supervisorId`
// points at — the CALLER passes it only while that person is still the building's manager
// (lib/notifications resolveAccountSupervisor: active, still Super Admin / Admin / Manager;
// decision D4). Both optional — a customer with neither still renders.
//
// `customerNumber` is the customer's four-digit number (GO-2, CS-068, since 2026-10-04:
// "0001 Ball Harbor Village", lib/customerNumber.js). A customer with no number yet serves null
// and the hub omits the line.
export function projectHubBuilding(client, { site = null, supervisor = null } = {}) {
  const c = client || {};
  return {
    id: c.id || null,
    name: c.name || '',
    customerNumber: c.customerNumber ?? null,
    street: c.street || '',
    city: c.city || '',
    state: c.state || '',
    zip: c.zip || '',
    address: (site && site.address)
      || composeAddress({ street: c.street, city: c.city, state: c.state, zip: c.zip }),
    supervisor: supervisor
      ? {
        id: supervisor.id || null,
        name: hubPersonName(supervisor.name),
        phone: supervisor.phone || '',
        photo: hubFaceOf(supervisor),
      }
      : null,
  };
}

// A PERSON as a client sees them: first name + last initial — "Maria G." (Matt's HUB-5: "First
// name and last initial, time on site, and a location check"). ONE rule for every place a
// staff member's name reaches a customer — who is on site, the history, a reply in a ticket —
// so no surface can leak a full name by spelling it differently. The last WORD gives the
// initial; a single name stays as it is; nothing in is nothing out (never "undefined").
export function hubPersonName(full) {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

// ── the view (GET /api/hub/view) ─────────────────────────────────────────────
// The hub's landing answer: who is signed in, the buildings they may see, the groups they hold
// them through, and the org's zone. Round 2 added its sections as their own branches, never as
// a widened building projection; the redesign (2026-10-08) keeps that: a view ROW is the
// building projection plus its next visit, a separate declared list, and HUB_BUILDING_FIELDS
// itself is unchanged.
export const HUB_VIEW_FIELDS = Object.freeze(['viewer', 'brandName', 'timezone', 'groups', 'buildings']);
// The signed-in person's OWN details, for the greeting and the Account page (read-only there).
export const HUB_VIEWER_FIELDS = Object.freeze(['name', 'firstName', 'email', 'phone']);
// A group the viewer is ASSIGNED (a management company, a city), with only the buildings of it
// they may see: the Properties page's "4 locations under Bayside Property Group".
export const HUB_GROUP_FIELDS = Object.freeze(['id', 'name', 'buildingIds']);
export const HUB_VIEW_BUILDING_FIELDS = Object.freeze([...HUB_BUILDING_FIELDS, 'nextVisit']);

// The first word of a name, for "Good afternoon, Jordan".
export const hubFirstName = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean)[0] || '';

// One view row: the building projection plus its next upcoming visit (ISO, or null).
export function projectHubViewBuilding(building, { nextVisit = null } = {}) {
  const out = {};
  for (const f of HUB_BUILDING_FIELDS) out[f] = building && building[f] !== undefined ? building[f] : null;
  out.nextVisit = typeof nextVisit === 'string' && nextVisit ? nextVisit : null;
  return out;
}

// The viewer's groups as the hub serves them: only groups this person is ASSIGNED (never a group
// they merely share a building with), and in each only the buildings in their scope. A group with
// none of their buildings left is dropped. Sorted by name, ids sorted.
//   assignedGroupIds  the viewer's group assignments (client_user_assignments.group_id)
//   groups            [{ id, name }] for those ids
//   members           [{ groupId, clientId }] for those ids
//   allowedIds        the viewer's resolved scope
export function projectHubGroups({ assignedGroupIds = [], groups = [], members = [], allowedIds = [] } = {}) {
  const assigned = new Set((Array.isArray(assignedGroupIds) ? assignedGroupIds : []).filter(Boolean));
  const allowed = new Set(allowedIds instanceof Set ? [...allowedIds] : (Array.isArray(allowedIds) ? allowedIds : []));
  const byGroup = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !assigned.has(m.groupId) || !allowed.has(m.clientId)) continue;
    if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, new Set());
    byGroup.get(m.groupId).add(m.clientId);
  }
  return (Array.isArray(groups) ? groups : [])
    .filter((g) => g && assigned.has(g.id) && byGroup.has(g.id))
    .map((g) => ({ id: g.id, name: g.name || '', buildingIds: [...byGroup.get(g.id)].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id)));
}

export function buildHubView({ clientUser, buildings = [], brandName = '', groups = [], timezone = null }) {
  return {
    viewer: {
      name: clientUser?.name || '',
      firstName: hubFirstName(clientUser?.name),
      email: clientUser?.email || '',
      phone: clientUser?.phone || '',
    },
    brandName,
    timezone: typeof timezone === 'string' && timezone ? timezone : null,
    groups,
    buildings,
  };
}
