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

// Every role the app has is a role a claim can carry: THE role list (lib/roles ROLES),
// never a copy. A hand-kept copy here said owner/admin/crew for ten days after the 4th
// tier `manager` shipped (2026-09-13), so nobody could invite a manager or re-role anyone
// to manager in live mode ("Invalid role"), and every manager's login carried no role
// claim and was matched to its roster row by email instead (fixed 2026-09-23).
export const VALID_ROLES = Object.freeze([...ROLES]);

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
  if (!user) return null;
  const md = user.app_metadata || {};
  const role = VALID_ROLES.includes(md.role) ? md.role : null;
  return {
    user,
    email: user.email || null,
    authUserId: user.id,
    role,
    orgUserId: typeof md.org_user_id === 'string' ? md.org_user_id : null,
    orgId: typeof md.org_id === 'string' ? md.org_id : null,
    hasRoleClaim: role !== null,
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
