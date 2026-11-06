// JWT trust root — identity + role live in Supabase `app_metadata`.
//
// WHY THIS EXISTS (REMEDIATION_PLAN.md Increment 1): today every server gate
// resolves authority by reading `users[].role` out of the shared `org_state`
// blob — a document the browser can write directly under the open RLS policy.
// That makes "role" a client-writable field, and self-escalation was proven
// live (AUTHORIZATION_AUDIT.md). `app_metadata` is writable ONLY by the
// service role, so a claim stamped here is a tamper-proof trust root.
//
// Increment 1b (this file) makes the claims TRUE and keeps them true — nothing
// reads them for authorization yet. Increment 1c flips the gates over.
//
// STALENESS — the important subtlety: a JWT only picks up an `app_metadata`
// change on its next refresh (~1h), so anything reading the *token's* claims
// (RLS policies via `auth.jwt()`, client-side reads) can lag by up to an hour.
// `getClaims()` below does NOT have that problem: it goes through
// `getAuthUser()` → `auth.getUser(token)`, which is a live round-trip to the
// Auth server and returns the CURRENT user record. Server gates therefore see
// a role change immediately. Keep it that way — resolving claims from a
// locally-decoded token would silently reintroduce the ~1h lag.
import { getSupabase } from './supabase.js';
import { getAuthUser } from './auth.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { ROLES } from '../../src/lib/roles.js';
import { CLIENT_ROLE } from '../../src/lib/clientHub.js';

// Every role the app has is a role a claim can carry: THE role list (lib/roles ROLES),
// never a copy. A hand-kept copy here said owner/admin/crew for ten days after the 4th
// tier `manager` shipped (2026-09-13), so nobody could invite a manager or re-role anyone
// to manager in live mode ("Invalid role"), and every manager's login carried no role
// claim and was matched to its roster row by email instead (fixed 2026-09-23).
export const VALID_ROLES = Object.freeze([...ROLES]);

// 🔴 `client` IS NOT IN VALID_ROLES, AND MUST NOT BE. A customer-hub login (the client hub,
// 2026-10-03) carries `app_metadata.role = 'client'` — but it is not a tier of staff: it holds
// no permission in the matrix, has no roster row, and `can()` must never be asked about one.
// Keeping it out of VALID_ROLES is what makes buildClaims / setClaimsForAuthUser — the STAFF
// invite and re-stamp path — refuse to mint one by accident. The client half has its own
// builder below, and api/_lib/authz.js refuses the role at every office gate.
export { CLIENT_ROLE };

// Shape of a client-user row id: the uuid primary key of public.client_users. Validated
// everywhere it crosses a request boundary for the same reason isOrgUserId exists — the hub's
// whole scope is resolved from this claim, so an unvalidated one is an identity-rebinding
// primitive.
export const isClientUserId = (v) => typeof v === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Shape of a CRM user id. Validated everywhere an org_user_id crosses a request
// boundary: an unvalidated one is an identity-rebinding primitive, since every
// server gate now keys labor, QC attribution, push delivery and site assignment
// off this claim. An empty string is NOT a valid id — it is falsy, so stamping
// one would silently push the caller back onto the tamperable blob fallback.
export const isOrgUserId = (v) => typeof v === 'string' && /^u_[A-Za-z0-9_]+$/.test(v);

// Read the caller's verified claims. Returns null when unauthenticated.
// `role`/`orgUserId` are null for a user who has never been stamped — callers
// in Increment 1c MUST treat null as "fall back to the blob lookup", never as
// "deny", or every un-backfilled login locks out.
export async function getClaims(req) {
  const user = await getAuthUser(req);
  return user ? claimsOf(user) : null;
}

// The claims of a GoTrue user already in hand: the ONE reading of `app_metadata`. getClaims reads a
// session's; authz.js `admissionOf` reads a login found by address, with no session (the sign-in
// page's "Forgot password?", api/public/auth), so both decide from the same fields.
export function claimsOf(user) {
  const md = user.app_metadata || {};
  const role = VALID_ROLES.includes(md.role) ? md.role : null;
  // A CLIENT login is recognized HERE and refused in authz.js, rather than quietly resolving
  // as "no role" — which is what it did before the hub shipped, and which was only ever safe
  // by accident (no roster row). Three ways that accident failed: an unreadable roster
  // decides "as before" and hands back an authority; a roster row with the same email lends
  // its role to the claim-less fallback; and a stray org_user_id resolves a full identity.
  const isClient = md.role === CLIENT_ROLE;
  return {
    user,
    email: user.email || null,
    authUserId: user.id,
    role,
    // 🔴 A CLIENT LOGIN NEVER CARRIES AN ORG IDENTITY HERE, whatever app_metadata says. The
    // mint path refuses to stamp one and reads the account back to prove it (users.js
    // createClientUserAccount), because `public.jobs` RLS admits any login whose
    // org_user_id claim is in a job's crewIds and RLS reads the TOKEN, not this. This line is
    // the second belt: even a login that somehow kept the key resolves to no identity in
    // every server gate.
    orgUserId: isClient ? null : (typeof md.org_user_id === 'string' ? md.org_user_id : null),
    orgId: typeof md.org_id === 'string' ? md.org_id : null,
    hasRoleClaim: role !== null,
    isClient,
    clientUserId: isClient && isClientUserId(md.client_user_id) ? md.client_user_id : null,
  };
}

// Stamp the trust-root claims onto an auth user. GoTrue MERGES app_metadata
// key-by-key (it does not replace the object), so the provider bookkeeping
// Supabase puts there — `provider` / `providers` — survives untouched.
export async function setClaimsForAuthUser(authUserId, { role, orgUserId } = {}) {
  if (!authUserId) throw new Error('authUserId is required');
  if (role != null && !VALID_ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
  if (orgUserId != null && !isOrgUserId(orgUserId)) throw new Error(`Invalid org user id: ${orgUserId}`);
  const appMetadata = { org_id: CLEANSPACE_ORG_ID };
  if (role != null) appMetadata.role = role;
  if (orgUserId != null) appMetadata.org_user_id = orgUserId;
  const { error } = await getSupabase().auth.admin.updateUserById(authUserId, {
    app_metadata: appMetadata,
  });
  if (error) throw error;
  return { ok: true, claims: appMetadata };
}

// Build the app_metadata object for a login being created (createUser accepts
// app_metadata inline, so a new account is never briefly claim-less).
// Callers MUST validate first — this throws rather than silently dropping an
// unrecognized value, because a silently-dropped role produced a claim-less
// login that fell through to the tamperable blob path.
export function buildClaims({ role, orgUserId } = {}) {
  if (role != null && !VALID_ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
  if (orgUserId != null && !isOrgUserId(orgUserId)) throw new Error(`Invalid org user id: ${orgUserId}`);
  const appMetadata = { org_id: CLEANSPACE_ORG_ID };
  if (role != null) appMetadata.role = role;
  if (orgUserId != null) appMetadata.org_user_id = orgUserId;
  return appMetadata;
}

// The CLIENT half of buildClaims: the trust root of a customer-hub login.
//
// 🔴 `org_user_id: null` IS THE POINT, NOT A PLACEHOLDER. GoTrue MERGES app_metadata key by
// key and DELETES a key whose value is null, so stamping this over an account that somehow
// carried an org identity removes it. `public.jobs` and (after 20261003110100)
// `public.job_deletes` admit a login by that claim straight through PostgREST, with no server
// route in the way, so the one thing a customer login must never hold is an org_user_id.
// Callers read the account back and refuse the login if the key survived
// (users.js createClientUserAccount).
export function buildClientClaims({ clientUserId } = {}) {
  if (!isClientUserId(clientUserId)) throw new Error(`Invalid client user id: ${clientUserId}`);
  return {
    org_id: CLEANSPACE_ORG_ID,
    role: CLIENT_ROLE,
    client_user_id: clientUserId,
    org_user_id: null,
  };
}

// Stamp (or re-stamp) a customer-hub login's claims and PROVE the result: the returned
// account must carry the client role, this client-user id, and no org_user_id. Throws
// otherwise — a half-stamped client login is a login with staff reach.
export async function setClientClaimsForAuthUser(authUserId, { clientUserId } = {}) {
  if (!authUserId) throw new Error('authUserId is required');
  const appMetadata = buildClientClaims({ clientUserId });
  const { data, error } = await getSupabase().auth.admin.updateUserById(authUserId, {
    app_metadata: appMetadata,
  });
  if (error) throw error;
  const md = data?.user?.app_metadata || {};
  if (md.role !== CLIENT_ROLE || md.client_user_id !== clientUserId || md.org_user_id != null) {
    throw new Error('The customer login could not be stamped safely; it was left unusable.');
  }
  return { ok: true, claims: md };
}
