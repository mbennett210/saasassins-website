// Server-side role / assignment guards for sensitive routes.
//
// The org_state RLS is OPEN for reads (any authenticated user can read the shared
// blob; since Increment 1e, migration 20260803150000, its writes go only through the
// guarded server routes) and role permissions are UI-enforced only, so requireAuth
// alone proves "some authenticated user" — NOT "an authorized one". Every sensitive route
// (labor, variance, codes, QC config) must re-check authority here. This is the
// only real boundary for those surfaces. See CLEANSPACE_SWEPT.md §2.4.

import { getClaims } from './claims.js';
import { readOrgState, readProtectedSlices } from './orgState.js';
import { getJobsAtSite } from './jobsTable.js';
import { assignmentsInitialized, isAssignedToSite } from './crewAssignments.js';
import { cached } from './requestCache.js';
import { can, ROLES } from '../../src/lib/roles.js';
import { jobGrantsSiteAccess } from '../../src/lib/siteAccess.js';

// Every tier but crew: the roles the app shows EVERY account and site to
// (store/selectors.js selectVisibleClientIdsFor, where `role !== 'crew'` sees all). Derived
// from ROLES, so a new non-crew tier is included as it would be in the app, while a null or
// unknown role matches nothing. Crew reach a site only through an assignment.
export const OFFICE_ROLES = ROLES.filter((r) => r !== 'crew');

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
  if (r.refusal === 'account-disabled') {
    res.status(403).json({ error: 'This account has been disabled.', code: 'account-disabled' });
    return null;
  }
  if (r.refusal === 'not-on-team') {
    res.status(403).json({ error: 'This login is not on the team.', code: 'not-on-team' });
    return null;
  }
  if (!r.authority) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return r.authority;
}

async function resolveAuthorityDetailed(req, { strictRoster = false } = {}) {
  const claims = await getClaims(req);
  if (!claims) return { authority: null, refusal: null };
  // strictRoster (the jobs write path, 2026-09-23): when the ROLE itself comes from the
  // roster (no role claim: every manager), a roster read that FAILS throws, so the route
  // answers 500 and the tab retries, instead of resolving as "no role", which the jobs
  // guard would turn into a silently reverted edit. A login whose role IS claimed reads
  // leniently, and so does every other route: a failed read decides as before this read.
  const strict = strictRoster && !claims.hasRoleClaim;
  let users = null;
  try {
    users = await readRosterUsers();
  } catch (e) {
    if (strict) throw e;
    console.error(`[authz] roster unreadable; deciding without it: ${e?.message || e}`);
  }
  // A claim-less field comes from the FIRST row carrying the login's email (an empty email
  // matches nothing: anyone who may add members could add an email-less row).
  const emailRows = rosterRowsByEmail(users, claims.email);
  const me = (!claims.hasRoleClaim || !claims.orgUserId) ? (emailRows[0] || null) : null;
  const authority = {
    user: claims.user,
    email: claims.email,
    role: claims.role || me?.role || null,
    orgUserId: claims.orgUserId || me?.id || null,
    // `roleSource` gates the claim-writing routes — they must never accept
    // authority that came from the blob (see settings/[...path].js).
    roleSource: claims.hasRoleClaim ? 'claim' : 'blob',
    idSource: claims.orgUserId ? 'claim' : 'blob',
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
// straight pass-through). Null when the org has no row yet.
async function readRosterUsers() {
  return cached('rosterUsers', async () => {
    const data = await readProtectedSlices('users:state->users');
    return Array.isArray(data?.users) ? data.users : null;
  });
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
// caller: role from the claim-first authority, overrides keyed by its `u_*` id. THROWS when
// the slices can't be read; every caller must fail closed on that, never open.
export async function permissionChecker(a) {
  const slices = await readAuthzSlices();
  const me = { id: a?.orgUserId, role: a?.role };
  return (permKey) => !!a && canCommitted(me, permKey, slices);
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
// This is for FEATURE surfaces (marketing, quotes, qc, reviews, time,
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
// crew (client/site.standingCrewIds) or jobs they're on (clientId, or the job's
// site's client when null). Used to scope crew reads/writes server-side; the open
// org_state RLS means the client-side filter is NOT a boundary, so anything a crew
// user could exfiltrate/mutate through an API route must be re-scoped here.
// `crewJobs` is the user's jobs, fetched from public.jobs by the caller (getCrewJobs) —
// state.jobs is empty post-B1, so the job-derived scope must be passed in. Standing-crew
// scope still comes from state (clients/sites).
export function crewAssignedScope(state, userId, crewJobs = []) {
  if (!userId) return { clientIds: [], siteIds: [] };
  const clients = Array.isArray(state?.clients) ? state.clients : [];
  const sites = Array.isArray(state?.sites) ? state.sites : [];
  const jobs = Array.isArray(crewJobs) ? crewJobs : [];
  const clientIds = new Set();
  const siteIds = new Set();
  const siteClient = new Map();
  for (const si of sites) {
    siteClient.set(si.id, si.clientId || null);
    if (Array.isArray(si.standingCrewIds) && si.standingCrewIds.includes(userId)) {
      siteIds.add(si.id);
      if (si.clientId) clientIds.add(si.clientId);
    }
  }
  for (const c of clients) {
    if (Array.isArray(c.standingCrewIds) && c.standingCrewIds.includes(userId)) clientIds.add(c.id);
  }
  for (const j of jobs) {
    if (!Array.isArray(j.crewIds) || !j.crewIds.includes(userId)) continue;
    const cid = j.clientId || (j.siteId ? siteClient.get(j.siteId) : null);
    if (cid) clientIds.add(cid);
    if (j.siteId) siteIds.add(j.siteId);
  }
  // Every site of an assigned client is an assigned site too.
  for (const si of sites) {
    if (si.clientId && clientIds.has(si.clientId)) siteIds.add(si.id);
  }
  return { clientIds: [...clientIds], siteIds: [...siteIds] };
}
