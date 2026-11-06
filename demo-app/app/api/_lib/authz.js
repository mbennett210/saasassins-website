// Server-side role / assignment guards for sensitive routes.
//
// The org_state RLS is OPEN for reads (any authenticated user can read the shared
// blob; since Increment 1e, migration 20260803150000, its writes go only through the
// guarded server routes) and role permissions are UI-enforced only, so requireAuth
// alone proves "some authenticated user" — NOT "an authorized one". Every sensitive route
// (labor, variance, codes, QC config) must re-check authority here. This is the
// only real boundary for those surfaces. See CLEANSPACE_SWEPT.md §2.4.

import { getClaims, claimsOf } from './claims.js';
import { readOrgState, readProtectedSlices } from './orgState.js';
import { getJobsAtSite } from './jobsTable.js';
import { assignmentsInitialized, isAssignedToSite } from './crewAssignments.js';
import { cached, withRequestCache } from './requestCache.js';
import { can, levelVariants, OFFICE_ROLES } from '../../src/lib/roles.js';
import { managerLevelIn } from '../../src/lib/teamScope.js';
import { jobGrantsSiteAccess } from '../../src/lib/siteAccess.js';
import { crewScopeFromJobs } from '../../src/lib/crewScope.js';
import { CLIENT_LOGIN_REFUSAL, clientUserHasAccess } from '../../src/lib/clientHub.js';
import {
  HUB_PREVIEW_HEADER, HUB_PREVIEW_PERMISSION, HUB_PREVIEW_FORBIDDEN, HUB_PREVIEW_CHECK_FAILED, HUB_PREVIEW_SENTENCES,
  hubPreviewBuildingIdOf,
} from '../../src/lib/hubPreview.js';
import { getClientUserById } from './clientHub/store.js';

// Every tier but crew: the roles the app shows EVERY account and site to
// (store/selectors.js selectVisibleClientIdsFor, where `role !== 'crew'` sees all). It IS
// lib/roles OFFICE_ROLES — one list for the server and the browser's read path (store/sync.js),
// derived from ROLES, so a new non-crew tier (the supply manager, S131) is office here exactly as
// in the app, while a null or unknown role matches nothing. Crew reach a site only through an
// assignment.
export { OFFICE_ROLES };

// Resolve who the caller is and what they may do. THE single authority source
// for every server gate — routes should never re-derive role or the `u_*` id
// from the blob themselves.
//
// CLAIMS-FIRST: `app_metadata` is service-role-writable only, so a stamped claim
// is tamper-proof. The blob's `users[].role` AND its email→id mapping are not: before
// Increment 1e any browser could write them, and since then team administrators still
// edit the roster through the guarded org_state route. So a roster row can be steered
// toward someone else's `u_*` identity (S77 closed two such manager → Super Admin
// paths in orgStateGuard), which is exactly what the claim closes.
//
// SCOPE OF THAT GUARANTEE — do not over-read it. The claim fixes WHO the caller
// is and WHAT ROLE they hold. It does NOT harden the assignment DATA that
// `requireSiteAssignment` reads. That took the write-revoke (Increment 1e: browsers
// can no longer write org_state or public.jobs, so every write passes orgStateGuard /
// jobsGuard) plus the service-role `crew_assignments` table (Increment 6). What stays
// writable does so by rule, never for crew: `standingCrewIds` and a site's parent
// account by owner + admin (orgStateGuard; nothing in the app writes them since
// 2026-09-09), and a job's crewIds by schedule authority (jobsGuard: owner + admin,
// or a manager holding schedule.edit).
//
// FALLBACK CONTRACT (deliberate, not a bypass): a login carrying no claim —
// never backfilled, created outside the app, or a manager ('manager' isn't a claim
// role yet) — resolves against the roster, i.e. the pre-Increment-1c behaviour.
// Treating a missing claim as "deny" would lock out every un-backfilled login the
// instant this deploys. A PRESENT claim always wins and can never be overridden by the
// blob, so the fallback only ever widens to what the gate already allowed. One that
// the roster doesn't list either has no role and no identity to act as, so it holds
// nothing (403 `not-on-team`, since 2026-09-23; before, it resolved as a roleless
// caller that could still write ordinary data).
//
// ROSTER: the claims answer WHO and WHAT ROLE when they can. The committed roster answers
// the rest (a claim-less login's role and id, a login's missing id) AND every login's STATUS:
// a member whose row says they have no access resolves as NO authority ("ROSTER STATUS"
// below). The roster is read once per request, as a small projection.
//
// Returns null when unauthenticated, disabled, or a claim-less login the roster can't place
// (no response written — see requireAuthority). Provenance is tracked PER FIELD. Branching
// on the role claim alone would throw away a perfectly good `org_user_id` claim just because
// the role claim was missing — handing identity back to the tamperable blob, which is the one
// thing this function exists to prevent. Each field independently prefers its claim.
export async function resolveAuthority(req, opts) {
  return (await resolveAuthorityDetailed(req, opts)).authority;
}

// resolveAuthority + the response when there is none. Caller: `if (!a) return;`
// No session → 401. A disabled member → 403 `account-disabled`, and a claim-less login the
// roster doesn't list → 403 `not-on-team` (they ARE signed in; it is their access that
// ended, or never began). `opts` passes through (the jobs write path sets strictRoster).
export async function requireAuthority(req, res, opts) {
  const r = await resolveAuthorityDetailed(req, opts);
  return r.authority || refuseAuthority(res, r);
}

// The answer for a resolution that holds no authority (requireAuthority's, shared with the hub's
// preview path below). Always returns null.
function refuseAuthority(res, r) {
  if (r.refusal === CLIENT_LOGIN_REFUSAL) {
    res.status(403).json({ error: 'This area is for staff logins.', code: CLIENT_LOGIN_REFUSAL });
    return null;
  }
  if (r.refusal === 'account-disabled') {
    res.status(403).json({ error: 'This account has been disabled.', code: 'account-disabled' });
    return null;
  }
  if (r.refusal === 'not-on-team') {
    res.status(403).json({ error: 'This login is not on the team.', code: 'not-on-team' });
    return null;
  }
  res.status(401).json({ error: 'Authentication required' });
  return null;
}

async function resolveAuthorityDetailed(req, { strictRoster = false } = {}) {
  return authorityFromClaims(await getClaims(req), { strictRoster });
}

// The resolution itself, from claims already read: the hub's gate (requireHubCaller) reads them
// once to tell a customer from staff, so GoTrue is asked once per request, not twice.
async function authorityFromClaims(claims, { strictRoster = false } = {}) {
  if (!claims) return { authority: null, refusal: null };
  // ── 🔴 A CUSTOMER-HUB LOGIN HOLDS NO OFFICE AUTHORITY, EVER (the client hub, 2026-10-03) ──
  // This is the ONE rule that isolates a client login, and it sits here because EVERY office
  // gate funnels through this function — requireAuthority, requireRole, requirePermission,
  // requireAnyPermission, requireRoleOrPermission, requireSiteAssignment, and the domain
  // gates built on them (inbox ownership, workspaces). A route cannot forget it, and a route
  // added next year inherits it; app/scripts/test-client-login-isolation.mjs walks app/api and
  // fails the build on any route that reaches a session without passing through here.
  //
  // IT IS DELIBERATELY NOT "no role, so no permission". That was the pre-hub behaviour and it
  // was only safe by accident, in three ways this refusal closes:
  //   · an UNREADABLE roster decides as before (rosterStatusVerdict → refused:false), so a
  //     PostgREST blip handed a client login a roleless-but-real authority — enough for
  //     /api/state/view's crew projection of the whole shared record;
  //   · a roster row carrying the SAME EMAIL lends its role to the claim-less fallback below
  //     (Matt is both the owner and a plausible customer contact);
  //   · a stray `org_user_id` on the login resolves a full crew identity.
  // The refusal is before any of that: it needs nothing but the claim, so nothing can widen
  // it. The hub reaches its own data through requireClientUser instead (below).
  if (claims.isClient) return { authority: null, refusal: CLIENT_LOGIN_REFUSAL };
  // strictRoster (the jobs write path, 2026-09-23): when the ROLE itself comes from the
  // roster (no role claim: every manager), a roster read that FAILS throws, so the route
  // answers 500 and the tab retries, instead of resolving as "no role", which the jobs
  // guard would turn into a silently reverted edit. A login whose role IS claimed reads
  // leniently, and so does every other route: a failed read decides as before this read.
  const strict = strictRoster && !claims.hasRoleClaim;
  let users = null;
  let rosterFailed = false;
  try {
    users = await readRosterUsers();
  } catch (e) {
    if (strict) throw e;
    rosterFailed = true;
    console.error(`[authz] roster unreadable; deciding without it: ${e?.message || e}`);
  }
  // A claim-less field comes from the FIRST row carrying the login's email (an empty email
  // matches nothing: anyone who may add members could add an email-less row).
  const emailRows = rosterRowsByEmail(users, claims.email);
  const me = (!claims.hasRoleClaim || !claims.orgUserId) ? (emailRows[0] || null) : null;
  const role = claims.role || me?.role || null;
  const orgUserId = claims.orgUserId || me?.id || null;
  const authority = {
    user: claims.user,
    email: claims.email,
    role,
    orgUserId,
    // `roleSource` gates the claim-writing routes — they must never accept
    // authority that came from the blob (see settings/[...path].js).
    roleSource: claims.hasRoleClaim ? 'claim' : 'blob',
    idSource: claims.orgUserId ? 'claim' : 'blob',
    // The MANAGER LEVEL, off this same committed roster read — what the caller's permission
    // COLUMN follows (CS-858: an Operations Manager's own column in Settings → Roles; the claim,
    // RLS and every `role === 'manager'` rule stay the role's). The role is the claim's, the level
    // the rows' with the caller's u_* id (lib/teamScope managerLevelIn, the app's reading of its
    // current user). null = it can't be known — the read failed, or the rows disagree — and every
    // check built on permissionChecker then FAILS CLOSED (a key holds only where both manager
    // columns hold it; lib/roles levelVariants). No second read: the roster is this one.
    managerLevel: rosterFailed && role === 'manager' ? null : managerLevelIn(users, { id: orgUserId, role }),
  };
  const verdict = rosterStatusVerdict(authority, users, {
    emailRows,
    claimless: !claims.hasRoleClaim && !claims.orgUserId,
  });
  return verdict.refused
    ? { authority: null, refusal: verdict.reason === 'not-on-team' ? 'not-on-team' : 'account-disabled' }
    : { authority, refusal: null };
}

// ── ROSTER STATUS: a disabled member holds no server authority (2026-09-23) ──────────
// Team › Status and revoking an invite end a member's access in the ROSTER. What actually
// stops a login is the Supabase ban (users.js setUserDisabled), and the ban route is
// owner-only. Since S77 a settings.team.edit holder (admins, and managers by default) may
// set another member to Disabled, so a member they disabled kept every server power (their
// role comes from the claim, or for a claim-less login from their row) until an owner also
// banned the login. So every authority decision reads the COMMITTED roster, and a member
// with no access resolves as NO authority, not merely no role: a roleless caller can still
// write ordinary org_state data, clock in and send mail.
//
//   · ACCESS_STATUSES is an ALLOWLIST: 'active' and 'invited' (an invited member's first
//     sign-in must reach the server before anyone marks them active). Any other value
//     (trimmed, case-folded) has no access: 'disabled' (Team › Status), 'inactive' (a
//     revoked invite), and a crafted 'Disabled ' the Team page would show as not active.
//     A row with no status at all is decided as before (a legacy row, not a refusal).
//   · The rows judged are the ones with the caller's `u_*` id; ANY of them with no access
//     refuses, so a duplicate row can't hide one. When no row has that id (a split identity:
//     the claim's id isn't the roster's), the rows with the login's email are judged instead.
//   · A claim-less login (no role claim, no id claim) that no row carries has no role and no
//     identity, so it holds nothing: 403 `not-on-team`. Otherwise a member set to Disabled
//     could change their LOGIN email (Supabase self-service) and stop matching their row
//     (adversarial review 2026-09-23).
//   · A caller whose RESOLVED role is owner is never refused by status: only an owner may
//     change an owner's status, and an owner can ban the login instead, so the backstop has
//     nothing to add; exempting them means no status edit can lock the org out of its Super
//     Admin (OWNER_CORE's rule, applied to status). The role, never a row: an admin could
//     prepend a duplicate `{ id: self, role: 'owner' }` row the guard doesn't compare, and a
//     row-based exemption made them immune (same review).
//   · FALLBACK CONTRACT, kept: a roster that is absent (a new org's first sign-in) or whose
//     read FAILS decides exactly as before, and a CLAIMED login with no row keeps its claim.
//   · Not covered: direct Supabase access under RLS, i.e. every read (the open read policy)
//     and writes to the storage buckets whose policies admit any signed-in user (e.g.
//     marketing-attachments). Only the login ban (GoTrue) ends those.
//   · Cost: one `users:state->users` projection per request, replacing the full ~0.9 MB state
//     read a claim-less login used to pay.
export const ACCESS_STATUSES = Object.freeze(['active', 'invited']);

// Does this roster row deny its member access? (See ACCESS_STATUSES above.)
export function hasNoAccess(row) {
  const s = row?.status;
  if (s === undefined || s === null || s === '') return false;
  return typeof s !== 'string' || !ACCESS_STATUSES.includes(s.trim().toLowerCase());
}

// PURE: does the committed roster refuse this authority? `users` is the committed
// `state.users`, or null when it is absent or couldn't be read. `emailRows` are the rows
// carrying the login's email; `claimless` means the login has neither a role nor an id claim.
export function rosterStatusVerdict(authority, users, { emailRows = [], claimless = false } = {}) {
  if (!Array.isArray(users)) return { refused: false, reason: 'unknown' };
  if (authority?.role === 'owner') return { refused: false, reason: 'owner' };
  const id = authority?.orgUserId;
  const idRows = typeof id === 'string' && id ? users.filter((u) => u && u.id === id) : [];
  const rows = idRows.length ? idRows : (Array.isArray(emailRows) ? emailRows : []);
  if (!rows.length) return claimless ? { refused: true, reason: 'not-on-team' } : { refused: false, reason: 'no-row' };
  return rows.some(hasNoAccess) ? { refused: true, reason: 'disabled' } : { refused: false, reason: 'active' };
}

// The rows carrying this login email (case-insensitive). An empty email matches nothing.
function rosterRowsByEmail(users, email) {
  if (!Array.isArray(users) || typeof email !== 'string' || email === '') return [];
  const key = email.toLowerCase();
  return users.filter((u) => u && typeof u.email === 'string' && u.email.toLowerCase() === key);
}

// The committed roster, projected out of the blob and cached per REQUEST (the same
// projection style as readAuthzSlices below; outside a request context `cached` is a
// straight pass-through). Null when the org has no row yet. THROWS when the read fails:
// resolveAuthority decides without it, and any other caller must fail closed. Exported for
// the team-photo route (api/avatars), which reads the photo versions off the same roster
// the gate already read, in the same request, for no second fetch.
export async function readRosterUsers() {
  return cached('rosterUsers', async () => {
    const data = await readProtectedSlices('users:state->users');
    return Array.isArray(data?.users) ? data.users : null;
  });
}

// ── THE OTHER SIDE OF THE SAME LINE: the customer hub's gate ─────────────────
// The mirror image of requireAuthority. It admits ONLY a customer-hub login and refuses every
// staff one, so the two gates between them partition every signed-in caller and neither can
// be reached by the other's audience. It lives in this file, next to the refusal above,
// because authz.js is the single authority source and the only module outside _lib/auth.js +
// _lib/claims.js allowed to resolve a session (test-disabled-authority.mjs C1 holds that).
//
// A client login's STATUS is checked here as well as inside the scope resolver, for the same
// reason the staff roster's is checked at the gate: disabling someone in the office UI must
// end their reach on the next request, without waiting for the GoTrue ban to propagate
// (the two are written together, but only one of them is ours to make instant).
//
// Returns { user, email, clientUser } — the full public.client_users row, already status-
// checked — or null with the response written. Caller: `if (!c) return;`
export async function requireClientUser(req, res) {
  const claims = await getClaims(req);
  if (!claims) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!claims.isClient) return refuseOfficeLogin(res);
  return clientCallerFrom(claims, res);
}

// A staff login at a customer URL is not an error on their part and must not read like an outage:
// they simply have no customer identity to serve a building list for.
function refuseOfficeLogin(res) {
  res.status(403).json({ error: 'This area is for customer logins.', code: 'office-login' });
  return null;
}

// The customer half's decision, from claims already known to be a client login's: its
// public.client_users row, or the code that refuses it — no claimed row, no such row, or a row
// with no access (Disabled, or the office preview's stand-in, whose status holds none). THROWS
// when the row can't be read; each caller fails closed.
async function clientUserOf(claims) {
  if (!claims.clientUserId) return { row: null, code: 'not-a-client-user' };
  const row = await getClientUserById(claims.clientUserId);
  if (!row) return { row: null, code: 'not-a-client-user' };
  if (!clientUserHasAccess(row.status)) return { row: null, code: 'account-disabled' };
  return { row, code: null };
}

// The customer half of the gate, from claims already known to be a client login's.
async function clientCallerFrom(claims, res) {
  let r;
  try {
    r = await clientUserOf(claims);
  } catch (e) {
    // A gate that cannot read its inputs fails CLOSED. Never "assume active".
    console.error(`[authz] client user unreadable: ${e?.message || e}`);
    res.status(503).json({ error: 'Your account could not be checked just now. Try again.', code: 'client-user-unreadable' });
    return null;
  }
  if (r.code === 'account-disabled') {
    res.status(403).json({ error: 'This account has been disabled.', code: 'account-disabled' });
    return null;
  }
  if (r.code) {
    res.status(403).json({ error: 'This login is not linked to a customer contact.', code: 'not-a-client-user' });
    return null;
  }
  return { user: claims.user, email: claims.email, clientUser: r.row };
}

// ── WOULD THIS LOGIN BE LET IN? — asked with no session ──────────────────────
// Every gate above decides a SESSION. The sign-in page's "Forgot password?" (api/public/auth,
// EP-413) has none, because the person can't sign in, and must still email a reset only to a
// login that could use it. So it asks the same question of a GoTrue user found by address,
// through the same code: claimsOf (claims.js, the reading getClaims uses), then
// authorityFromClaims for a staff login (the committed roster's STATUS: a Disabled member, or a
// claim-less login no row carries, holds nothing) or clientUserOf for a customer's (no row, a
// Disabled one, or the preview stand-in: no access).
// Stricter than a session in one way: a roster or customer row that can't be read REFUSES here.
// The roster is read first, strictly, in this call's own request cache, so authorityFromClaims
// decides from that same read; a session's claimed login is decided without the roster instead,
// but a public caller is never let through on "couldn't check". The login's GoTrue BAN is the
// caller's to check (users.js isLoginBanned); this asks only what our own records say.
//   { admitted: true }  |  { admitted: false, reason }   (a refusal code, or 'unreadable')
// Never throws.
export async function admissionOf(user) {
  if (!user || typeof user !== 'object') return { admitted: false, reason: 'no-login' };
  const claims = claimsOf(user);
  try {
    return await withRequestCache(async () => {
      if (claims.isClient) {
        const c = await clientUserOf(claims);
        return c.code ? { admitted: false, reason: c.code } : { admitted: true };
      }
      await readRosterUsers();
      const r = await authorityFromClaims(claims);
      return r.authority ? { admitted: true } : { admitted: false, reason: r.refusal || 'no-authority' };
    });
  } catch (e) {
    console.error(`[authz] admission unreadable; refused: ${e?.message || e}`);
    return { admitted: false, reason: 'unreadable' };
  }
}

// ── THE HUB ROUTE'S GATE: requireClientUser, plus the office's PREVIEW (the client hub redesign,
// plan 2026-10-08 §3.7 "Preview as customer", decision D2) ─────────────────────────────────────
// /api/hub/* runs this instead of requireClientUser. It adds exactly ONE way in for staff and
// changes nothing for a customer:
//   · A CUSTOMER login takes requireClientUser's path, UNCHANGED, and the preview header is
//     IGNORED for it: its scope is still resolved from its own claim, so naming another building in
//     the header widens nothing (test-hub-preview.mjs §5).
//   · A STAFF login is admitted ONLY with the preview header (src/lib/hubPreview.js
//     HUB_PREVIEW_HEADER) AND `hub.users.view`, read CLAIMS-FIRST from the committed matrix +
//     overrides, exactly as requirePermission reads a key. A disabled member is refused as
//     everywhere (403 account-disabled / not-on-team). Crew are refused by ROLE whatever they are
//     granted — the same reasoning as the activity log's floor: can() puts no key out of a per-user
//     grant's reach, and a cleaner must never read a building's customer hub. A matrix that can't
//     be read refuses (fail closed). No header: 403 `office-login`, the old answer.
//   · What a preview may then do is the ROUTE's (api/hub/[...path].js): its scope is exactly the
//     named building and only while that building is in the live customer book, and EVERY write is
//     refused (403 preview-read-only) before a branch is looked up.
// Returns { user, email, clientUser, preview } — `preview` null for a customer; for staff
// { buildingId, authority } with `clientUser` null (there is no customer behind a preview) — or
// null with the response written. Caller: `if (!c) return;`
export async function requireHubCaller(req, res) {
  const claims = await getClaims(req);
  if (!claims) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (claims.isClient) {
    const c = await clientCallerFrom(claims, res);
    return c ? { ...c, preview: null } : null;
  }
  const raw = req.headers?.[HUB_PREVIEW_HEADER];
  if (raw === undefined || raw === null || raw === '') return refuseOfficeLogin(res);
  const r = await authorityFromClaims(claims);
  if (!r.authority) return refuseAuthority(res, r);
  const a = r.authority;
  const forbidden = () => {
    res.status(403).json({ error: HUB_PREVIEW_SENTENCES[HUB_PREVIEW_FORBIDDEN], code: HUB_PREVIEW_FORBIDDEN });
    return null;
  };
  if (!a.role || !OFFICE_ROLES.includes(a.role)) return forbidden();
  let holds;
  try {
    holds = (await permissionChecker(a))(HUB_PREVIEW_PERMISSION);
  } catch {
    // A gate that cannot read its inputs fails CLOSED, never open.
    res.status(503).json({ error: HUB_PREVIEW_SENTENCES[HUB_PREVIEW_CHECK_FAILED], code: HUB_PREVIEW_CHECK_FAILED });
    return null;
  }
  if (!holds) return forbidden();
  // A header that names no building is no building: the route's scope check answers 404.
  return { user: claims.user, email: claims.email, clientUser: null, preview: { buildingId: hubPreviewBuildingIdOf(raw) || '', authority: a } };
}

// Returns { user, role, orgUserId } when the caller holds one of `roles`;
// otherwise writes 401 (no session), 403 `account-disabled` (a disabled member) or 403
// (wrong role) and returns null. Caller: `if (!g) return;`
export async function requireRole(req, res, roles) {
  const a = await requireAuthority(req, res);
  if (!a) return null; // 401 already written
  if (!a.role || !roles.includes(a.role)) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return a;
}

// The two authorization slices the permission model needs — the live matrix and
// per-user overrides — projected out of the ~900 KB blob and cached per REQUEST.
// Only an owner, or a holder of settings.roles.edit / staff.editOverrides (the latter
// never on their own row or a Super Admin's; a member's rows also leave with them when a
// settings.team.edit holder removes that member), can change them — checked against the
// COMMITTED values by orgStateGuard.protectedFieldViolations — and Increment 1e
// (migration 20260803150000) drops the browser's direct org_state write, so they are
// tamper-resistant enough to authorize FROM — unlike standingCrewIds/jobs, which
// stay assignment-gated (see requireSiteAssignment). Outside a request context
// `cached` is a straight pass-through, so this is correct even on un-wrapped routes.
// Read by every gate below (through permissionChecker) and by the jobs write path
// (api/state/jobs-delta.js → jobsGuard.guardJobsDelta, schedule.edit), which is why it is
// EXPORTED: that route imports it, and without the export every job save fails to load.
// Rows come back as stored. The gates here read them through canCommitted (a row the
// app's can() can't read answers no); the org_state and jobs guards, which must never
// throw, read them through permissionSlices.js.
export async function readAuthzSlices() {
  return cached('authzSlices', async () => authzSlicesOf(await readProtectedSlices(
    'permissions:state->permissions,userPermissionOverrides:state->userPermissionOverrides',
  )));
}

// The matrix + overrides from any org_state projection or the whole blob: a matrix that
// isn't a list reads as none (can() then uses the schema defaults), overrides that aren't a
// list as none. The ROWS are passed through untouched, so the server reads them exactly as
// the app's can() does (see canCommitted).
export function authzSlicesOf(src) {
  return {
    permissions: Array.isArray(src?.permissions) ? src.permissions : null,
    overrides: Array.isArray(src?.userPermissionOverrides) ? src.userPermissionOverrides : [],
  };
}

// can() over the committed slices, failing CLOSED. A row can() can read is read exactly as
// the app reads it (a roles string matches the way String#includes does, as in the
// browser), so the server never decides wider or narrower than the screen. A row can()
// can't read (a null row, roles that are null) throws there, as it throws in the app, which
// then offers nothing; here it answers no, where it used to throw a 500. "Repairing" such
// rows into missing ones was wider than the app (adversarial review, 2026-09-23).
export function canCommitted(user, permKey, { permissions, overrides }) {
  try {
    return can(user, permKey, permissions, overrides) === true;
  } catch {
    return false;
  }
}

// One read of the COMMITTED matrix + overrides, then any number of can() checks for this
// caller: role from the claim-first authority, overrides keyed by its `u_*` id, and the matrix
// COLUMN of their manager level (CS-858). THROWS when the slices can't be read; every caller must
// fail closed on that, never open. A level that can't be known (null) fails closed too: the key
// must hold at BOTH manager levels (lib/roles levelVariants), so it is never wider than either.
export async function permissionChecker(a) {
  const slices = await readAuthzSlices();
  const me = { id: a?.orgUserId, role: a?.role, managerLevel: await callerLevel(a) };
  const as = levelVariants(me);
  return (permKey) => !!a && as.every((u) => canCommitted(u, permKey, slices));
}

// The caller's manager level: the one resolveAuthority read with them — or, for an authority built
// without one, read off the committed roster now (cached per request, so a route that already
// resolved the caller pays nothing); null when that read fails. Only a manager has a level.
async function callerLevel(a) {
  if (!a || a.role !== 'manager') return undefined;
  if (Object.prototype.hasOwnProperty.call(a, 'managerLevel')) return a.managerLevel;
  try {
    return managerLevelIn(await readRosterUsers(), { id: a.orgUserId, role: a.role });
  } catch {
    return null;
  }
}

// Authorize a route by PERMISSION KEY, running the SAME can() the client uses
// (src/lib/roles.js) so the two can never disagree — role from the tamper-proof
// JWT claim (a.role, claim-first exactly as requireRole reads it), grants/revokes
// from the protected blob. A per-user grant therefore takes effect server-side on
// the very next request, with no token refresh.
//
// 🔴 DO NOT use this BARE to gate the AUTHORITY surfaces — role/permission-matrix/
// override writes (orgStateGuard, settings users/claims), the jobs field guard
// (jobsGuard), or anything a grant must never confer. `can()` places NO key
// out of a grant's reach, so an admin granted `staff.editOverrides` could grant
// themselves everything. The org_state guard and the claim-writing settings users routes
// consult the matrix for Team administration (2026-09-23), but only next to limits held
// by ROLE and identity: nobody edits their own role or overrides, only a Super Admin
// makes, re-roles, disables or removes a Super Admin or edits their overrides, and a role
// is given only by someone who holds all it carries (_lib/teamAuthority.js; the guard's
// header). The jobs guard consults it for a MANAGER's schedule.edit (2026-09-23; crew
// never, whatever they are granted), a key that confers job editing and no power to
// grant, through can() and NEVER this helper: a 403 on the jobs path wedges tabs, so it
// sanitizes instead (see jobsGuard).
// This is for FEATURE surfaces (marketing, quotes, qc, time,
// variance, media) whose client already gates on the same permission key. A gate that
// predates the matrix and must not tighten uses requireRoleOrPermission below instead.
//
// Returns the authority object when allowed; writes 401 (no session) or 403 and
// returns null otherwise. Caller: `if (!g) return;`
export async function requirePermission(req, res, permKey) {
  const a = await requireAuthority(req, res);
  if (!a) return null; // 401 already written
  return (await holdsOrRefuse(a, res, permKey)) ? a : null;
}

// A route reached by TWO different screens with two different capabilities: pass both keys
// and holding EITHER is enough. /api/email/send is the case — the Settings test card gates on
// `integrations.manage`, inviting a member on `settings.team.edit`, and before 2026-09-29 the
// route asked for neither, which is CS-015 (any crew login relayed company mail). Named
// requireXxx(req, res, …) so the endpoint inventory can SEE the gate by shape rather than
// reporting the weaker requireAuthority underneath it (endpoint-lint.mjs).
// Same contract as requirePermission. Caller: `if (!g) return;`
export async function requireAnyPermission(req, res, permKeys) {
  const a = await requireAuthority(req, res);
  if (!a) return null; // 401 already written
  const keys = Array.isArray(permKeys) ? permKeys.filter(Boolean) : [];
  for (const key of keys) {
    // holdsPermission FAILS CLOSED: an unreadable matrix answers no for every key, so an
    // outage narrows this gate rather than opening it.
    if (await holdsPermission(a, key)) return a;
  }
  res.status(403).json({ error: 'Insufficient permissions' });
  return null;
}

// For a gate that keyed on a role list before the matrix existed and now follows it too:
// the roles that always passed still pass on their own, whatever the matrix says (never
// tightened), and anyone holding `permKey` under the committed matrix + overrides passes
// as well, so the 4th-tier manager (and any per-user grant) gets what the app offers.
// Same contract as requirePermission. Caller: `if (!g) return;`
export async function requireRoleOrPermission(req, res, roles, permKey) {
  const a = await requireAuthority(req, res);
  if (!a) return null; // 401 already written
  if (a.role && roles.includes(a.role)) return a;
  return (await holdsOrRefuse(a, res, permKey)) ? a : null;
}

// true when `a` holds `permKey`; otherwise writes the 403 (or the 500 of an unreadable
// matrix, failing closed) and returns false.
async function holdsOrRefuse(a, res, permKey) {
  let holds;
  try {
    holds = await permissionChecker(a);
  } catch {
    // A gate that cannot read its inputs must fail closed, never open.
    res.status(500).json({ error: 'Authorization check failed' });
    return false;
  }
  if (!holds(permKey)) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return false;
  }
  return true;
}

// Non-writing permission check: does an ALREADY-authorized caller ALSO hold `permKey`?
// The read-side complement of requirePermission — for a route that has passed one gate
// (e.g. qc.view) and must vary its RESPONSE by a second, finer permission (e.g. strip a
// share token unless qc.share) WITHOUT writing a 403. Runs the same permissionChecker as
// requirePermission, so the two can never diverge, and FAILS CLOSED: a matrix that can't
// be read, or a row can() can't read, returns false (no elevated permission), never true
// and never a throw. `authority` is the object requirePermission/requireAuthority
// returned ({ orgUserId, role }).
export async function holdsPermission(authority, permKey) {
  if (!authority) return false;
  try {
    return (await permissionChecker(authority))(permKey);
  } catch {
    return false; // can't read the matrix → assume the caller does NOT hold it
  }
}

// requireSiteAssignment's job window when a caller names none: until a day after the clean
// ends (the older `jobWindowMs` default).
const DEFAULT_JOB_WINDOW = Object.freeze({ afterMs: 24 * 60 * 60 * 1000 });

// Allows the site's office OR a crew member assigned to `siteId`.
//
// WHO SKIPS THE ASSIGNMENT CHECK is each caller's to say, by capability. There is no
// default: the implicit owner/admin one refused the 4th-tier manager on both callers
// (2026-09-23), so a caller that names nobody lets nobody past by role.
//     `managerRoles`     pass by role.
//     `bypassPermission` passes whoever holds that key under the COMMITTED matrix +
//                        overrides. If the matrix can't be read the bypass is refused and
//                        the caller is judged on assignment alone (fail closed).
//     site-security reveal → { managerRoles: owner/admin, bypassPermission: 'ops.revealCodes', … },
//                            the key the app's Reveal buttons check (SecurityCard, JobDetail);
//                            owner/admin keep passing by role, never tightened.
//     account-media        → { managerRoles: OFFICE_ROLES }: the app shows every site's
//                            photos to every non-crew role, a role rule with no key.
//
// ASSIGNMENT means STANDING CREW by default — `crew_assignments` (the tamper-proof
// table) once `assignmentsInitialized()`, else the blob's `client/site.standingCrewIds`
// as a pre-init fallback. Standing crew has no time window: standing means currently
// assigned.
//
// 🔴 JOB-BASED ACCESS IS OFF UNLESS YOU PASS `allowJobBased: true`. Do not infer it
// from `jobWindow` / `jobRoles` — they are INERT on their own; they only shape the job
// path once it is enabled:
//     `jobRoles`   the roles that may take it (null = any caller whose u_* id resolved).
//     `jobWindow`  { leadMs, afterMs, maxSpanMs } around each clean (src/lib/siteAccess.js
//                  jobGrantsSiteAccess, the SAME rule the app runs); null = any
//                  non-cancelled job at the site, whenever it is. Default: until a day
//                  after the clean ends.
// Callers today:
//     site-security reveal → { allowJobBased: true, jobRoles: ['crew'], jobWindow:
//                            CODE_REVEAL_WINDOW } since 2026-09-23 (owner's call: "make it
//                            work for cleaners"): crew on a clean there, from a day before
//                            it starts to a day after it ends. Crew ONLY, because the jobs
//                            guard lets a manager holding schedule.edit write any crew, their
//                            own included, and a manager pared off ops.revealCodes must not
//                            get the codes back by scheduling themselves. 🔴 SAFE ONLY WHILE
//                            browser writes to public.jobs stay revoked (Increment 1e) AND
//                            jobsGuard keeps crew from creating a job, changing its crewIds /
//                            siteId / startAt / endAt, or the two status changes
//                            statusChangeKept refuses: before 1e, `public.jobs` was
//                            `using(true) with check(true)`, so anyone could INSERT a job
//                            naming themselves at any site and read its decrypted door/alarm
//                            codes. That WAS the exploit. If 1e is ever rolled back, take the
//                            job path off reveal first.
//     account-media        → { allowJobBased: true, jobWindow: null, … } — documenting
//                            a clean days later is legitimate, and photos are the
//                            lower-stakes surface.
//
// Jobs are read from `public.jobs` via `getJobsAtSite`, NOT from the blob: `state.jobs`
// is written EMPTY on every client save post-B1, so a "cheaper" filter over it returns
// [] forever and silently denies every job-assigned crew member (that is the C01
// regression — see the header of api/_lib/jobsTable.js). The read asks only for the
// caller's jobs at the site, and a fully bounded window also bounds it by start time
// (jobStartBounds), so a site with years of history can't push the granting clean past
// the PostgREST row cap.
//
// Returns { user, role } or null (401/403 written).
export async function requireSiteAssignment(req, res, siteId, opts = {}) {
  const {
    managerRoles = [], bypassPermission = null,
    allowJobBased = false, jobRoles = null, jobWindow = DEFAULT_JOB_WINDOW,
  } = opts;
  const a = await requireAuthority(req, res);
  if (!a) return null;
  if (a.role && managerRoles.includes(a.role)) return a;
  if (bypassPermission) {
    let held = false;
    try {
      held = (await permissionChecker(a))(bypassPermission);
    } catch { /* unreadable matrix: no bypass, judged on assignment below */ }
    if (held) return a;
  }
  if (!siteId) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  try {
    const meId = a.orgUserId;
    if (meId) {
      const { state } = await readOrgState();

      // STANDING CREW — from public.crew_assignments, which has no RLS policies
      // and so is service-role-write-only. Reading this from the blob's
      // standingCrewIds let a crew user append their own id and read any site's
      // decrypted door/alarm codes. Until the table has been populated at least
      // once, fall back to the blob rather than deny: an empty table must not
      // read as "nobody is assigned", which would lock out every crew member.
      if (await assignmentsInitialized()) {
        if (await isAssignedToSite(meId, siteId, state)) return { ...a, role: a.role || 'crew' };
      } else {
        const sites = Array.isArray(state?.sites) ? state.sites : [];
        const site = sites.find((s) => s.id === siteId);
        const client = site?.clientId ? (state?.clients || []).find((c) => c.id === site.clientId) : null;
        const standing = (Array.isArray(site?.standingCrewIds) && site.standingCrewIds.includes(meId))
          || (Array.isArray(client?.standingCrewIds) && client.standingCrewIds.includes(meId));
        if (standing) return { ...a, role: a.role || 'crew' };
      }

      // JOB-BASED access, only for callers that pass allowJobBased (see the docstring:
      // code reveal does since 2026-09-23, for crew, and that rests on Increment 1e +
      // jobsGuard, because a job naming yourself must be impossible to write). The window
      // is the app's own rule (src/lib/siteAccess.js), so the two can't drift. Each row is
      // re-checked on its own payload: the query matches the site_id column, the grant
      // needs the job's siteId to say the same.
      if (allowJobBased && (!jobRoles || (a.role && jobRoles.includes(a.role)))) {
        const now = Date.now();
        const siteJobs = await getJobsAtSite(siteId, { crewId: meId, ...jobStartBounds(jobWindow, now) });
        const assigned = siteJobs.some((j) =>
          j?.siteId === siteId && jobGrantsSiteAccess(j, meId, { ...jobWindow, now }));
        if (assigned) return { ...a, role: a.role || 'crew' };
      }
    }
  } catch {
    // fall through to 403
  }
  res.status(403).json({ error: 'Not assigned to this site' });
  return null;
}

// The start_at range a granting job can have: a clean opens access leadMs before it starts
// and holds it at most maxSpanMs + afterMs past its start, so only one starting in
// [now - afterMs - maxSpanMs, now + leadMs] can grant. A window missing any bound has no
// such range, and the read then pages through the caller's every job at the site.
function jobStartBounds(w, now) {
  if (w?.leadMs == null || w?.afterMs == null || w?.maxSpanMs == null) return {};
  return {
    startFrom: new Date(now - w.afterMs - w.maxSpanMs).toISOString(),
    startTo: new Date(now + w.leadMs).toISOString(),
  };
}

// Server-side mirror of the client's crew visibility (selectVisibleClientIdsFor):
// the client ids + site ids a crew user is ASSIGNED to — via account/site Standing
// crew (client/site.standingCrewIds) or the cleans they're on. Used to scope crew
// reads/writes server-side; the open org_state RLS means the client-side filter is NOT
// a boundary, so anything a crew user could exfiltrate/mutate through an API route must
// be re-scoped here. `crewJobs` is the user's jobs, fetched from public.jobs by the caller
// (getCrewJobs) — state.jobs is empty post-B1, so the job-derived scope must be passed in.
// The JOB half is the shared rule (src/lib/crewScope.js crewScopeFromJobs, CS-005) the screens
// and the QC routes read too; standing crew still comes from state (clients/sites).
export function crewAssignedScope(state, userId, crewJobs = []) {
  if (!userId) return { clientIds: [], siteIds: [] };
  const clients = Array.isArray(state?.clients) ? state.clients : [];
  const sites = Array.isArray(state?.sites) ? state.sites : [];
  const { clientIds, siteIds } = crewScopeFromJobs({ jobs: crewJobs, sites, userId });
  for (const si of sites) {
    if (Array.isArray(si.standingCrewIds) && si.standingCrewIds.includes(userId)) {
      siteIds.add(si.id);
      if (si.clientId) clientIds.add(si.clientId);
    }
  }
  for (const c of clients) {
    if (Array.isArray(c.standingCrewIds) && c.standingCrewIds.includes(userId)) clientIds.add(c.id);
  }
  // Every site of an assigned client is an assigned site too.
  for (const si of sites) {
    if (si.clientId && clientIds.has(si.clientId)) siteIds.add(si.id);
  }
  return { clientIds: [...clientIds], siteIds: [...siteIds] };
}
