// Admin user-management helpers (service-role). Used by the settings function
// to create/remove/disable the actual Supabase login for a team member, so the
// Settings → Team UI manages real access (not just a store record). Service-
// role only — never import client-side.
import crypto from 'node:crypto';
import { getSupabase } from './supabase.js';
import { readOrgState } from './orgState.js';
import { sendEmail, escapeHtml } from './email.js';
import { DOC } from '../../src/brand/doc.js';
import { buildClaims, setClaimsForAuthUser, VALID_ROLES, isOrgUserId } from './claims.js';
import { IDENTITY } from '../../src/brand/identity.generated.js';

// Find a Supabase auth user by email. listUsers is paginated; a facilities team
// is small, so a few pages is plenty.
export async function findAuthUserByEmail(email) {
  const sb = getSupabase();
  const target = (email || '').trim().toLowerCase();
  if (!target) return null;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((u) => (u.email || '').toLowerCase() === target);
    if (found) return found;
    if (users.length < 200) break;
  }
  return null;
}

export function generateTempPassword() {
  return `CleanSpace-${crypto.randomBytes(5).toString('hex')}!`;
}

// Look up a team member from the shared org_state document by email.
//
// NOT A TRUST ROOT: the roster is editable by team administrators (and was
// browser-writable before Increment 1e), so both the role and the email→id mapping here
// are steerable. Used for a TARGET member (whose role, whose row), never to resolve the
// CALLER: `resolveAuthority()` in authz.js resolves a claim-less login from its own
// roster projection, with the same first-row-by-email rule, and checks its status there.
// Reads through readOrgState() deliberately: it is the ONE org-id source the
// rest of the backend uses (CLEANSPACE_ORG_ID). The identity lookups this replaced
// all went through readOrgState, while the old role lookup queried org_state
// directly under FORMS_ORG_ID — two env vars for the same document. If prod ever
// set one without the other, identity would silently resolve to null and every
// crew login would 403 on clock-in. One source removes that failure mode.
//
// `strict`: a roster read that FAILS throws instead of reading as "not on the
// roster". adoptOrphanLogin's duplicate check passes it: a failed read taken for "no
// roster row" adopted a member's login and re-stamped its claims (HANDOFF S78 find 5,
// S80). Other callers keep the lenient null. (resolveAuthority no longer reaches here at
// all since S93 — it reads the roster itself, once, for the claim-less lookup AND the
// status check; its own strict-on-the-jobs-path handling moved with that read.)
//
// An empty email matches NOTHING. Without this, a login with no email matched the
// first roster row without one ('' === ''), and anyone who may add members can add
// such a row. (The client's identity lookup already refused an empty email.)
export async function getOrgUserByEmail(email, { strict = false } = {}) {
  if (typeof email !== 'string' || email === '') return null;
  let state;
  try {
    ({ state } = await readOrgState());
  } catch (e) {
    if (strict) throw e;
    return null;
  }
  const users = Array.isArray(state?.users) ? state.users : [];
  return users.find((u) => (u.email || '').toLowerCase() === (email || '').toLowerCase()) || null;
}

// Is this `u_*` id already spoken for by an EXISTING team member? The claim
// uniqueness check alone is vacuous while the backfill hasn't run (no login
// carries a claim yet), so the roster is the check that actually bites today.
export async function orgUserIdInRoster(orgUserId) {
  let state;
  try {
    ({ state } = await readOrgState());
  } catch {
    throw new Error('Could not verify the team roster.');
  }
  const users = Array.isArray(state?.users) ? state.users : [];
  return users.some((u) => u.id === orgUserId);
}

// (Removed in Increment 1c: `getOrgRoleByEmail` returned the blob's role, which
// any authenticated browser can rewrite. Its name read like an authority source,
// so it was a footgun for new routes. Callers use authz.resolveAuthority for the
// CALLER's role, or getAuthoritativeRoleByEmail below for a TARGET's.)

// The authoritative role of an arbitrary team member, for gates that check the
// TARGET's role rather than the caller's (e.g. "an Admin may not reset a Super
// Admin's password"). Prefers the service-role-only JWT claim; trusting the
// blob alone would let an attacker forge a Super Admin's role downward in the
// roster and then reset their password. Falls back to the blob for logins that
// were never stamped — the pre-Increment-1c behaviour.
export async function getAuthoritativeRoleByEmail(email) {
  const u = await findAuthUserByEmail(email);
  const claimed = u?.app_metadata?.role;
  if (VALID_ROLES.includes(claimed)) return claimed;
  return (await getOrgUserByEmail(email))?.role || null;
}

// Create a login and email the new member a "set your password" link via Resend
// (same recovery flow as a reset) — the admin never sees or shares a password.
// The account is created with a random password the member never uses + email
// confirmed, so it's usable the moment they set their own password via the link.
// Returns { id, invited }; invited:false means the login was created but the
// email couldn't be sent (retry with the reset link from the member's page).
// `claims` ({ role, orgUserId }) stamps the JWT trust root at creation time so
// a new login is never briefly claim-less (see _lib/claims.js). The caller mints
// the `u_*` org user id before this call, so both halves are known up front.
export async function createUserAccount(email, redirectTo, claims = {}) {
  const sb = getSupabase();
  const target = (email || '').trim().toLowerCase();
  if (!target) throw new Error('email is required');
  const appMetadata = buildClaims(claims); // throws on an invalid role / org user id

  // ADOPT BEFORE CREATE. An email that already has a login is far more often a
  // half-created member than a real duplicate, and only the ROSTER tells the two
  // apart — see adoptOrphanLogin below for why the orphan state exists at all.
  const existing = await findAuthUserByEmail(target);
  if (existing) return adoptOrphanLogin(existing, target, redirectTo, claims);

  // A brand-new login must carry a brand-new CRM identity — never one that
  // already belongs to a member (that would be a pre-bound takeover account).
  if (claims.orgUserId != null) await assertOrgUserIdUnused(claims.orgUserId);
  const { data, error } = await sb.auth.admin.createUser({
    email: target,
    password: generateTempPassword(),
    email_confirm: true,
    app_metadata: appMetadata,
  });
  if (error) {
    // Lost the race between the lookup above and this create (two admins
    // inviting the same person at once). Re-resolve and adopt rather than
    // surfacing "already registered", which is the dead end this replaced.
    const raced = await findAuthUserByEmail(target);
    if (raced) return adoptOrphanLogin(raced, target, redirectTo, claims);
    throw error;
  }
  let invited = true;
  try {
    await emailSetPasswordLink(target, redirectTo, 'invite');
  } catch {
    invited = false; // login exists; the set-password email just didn't send
  }
  return { id: data.user.id, invited, adopted: false, orgUserId: claims.orgUserId ?? null };
}

// The `code` of the error an adoption throws when it can't read the roster: nothing was
// changed and the caller may retry (the invite route answers 503, not 409).
export const ROSTER_UNREADABLE = 'roster-unreadable';

// Re-attach a login that exists with NO team record — the "orphan login".
//
// WHY THE STATE EXISTS: adding a member is two writes that are not atomic, and
// the durable one runs first — (1) this module creates the Supabase account and
// stamps its claims, server-side; then (2) the browser dispatches ADD_USER into
// the shared, CAS-contended org_state blob. Lose (2) — blob conflict, closed
// tab, dropped network — and the login survives while the roster row does not.
// The member is then invisible on Settings → Team, so no access level can be
// assigned to them. Confirmed live 2026-07-27 (david.pepin11@gmail.com).
//
// Before this function, that state was UNRECOVERABLE from the UI: re-inviting
// called auth.admin.createUser, which rejects an already-registered email, and
// stopped there. Repair needed a service-role script.
//
// The binding rule is the important part: adopt the org user id ALREADY IN THE
// CLAIM whenever the account carries one. Every server gate keys identity off
// that claim (labor, QC attribution, push delivery, site assignment), so minting
// a fresh `u_*` here would strand anything the old id already references and
// leave the trust root pointing at a member who does not exist.
async function adoptOrphanLogin(existing, target, redirectTo, { role, orgUserId } = {}) {
  // STRICT: only a login with no roster row may be adopted, so a read that fails must not
  // read as "no roster row". The invite route refuses a member's email on its own read
  // first; this is the backstop for one added in between.
  let rosterRow;
  try {
    rosterRow = await getOrgUserByEmail(target, { strict: true });
  } catch {
    throw Object.assign(new Error("The team list couldn't be read, so the login wasn't changed. Try again."), { code: ROSTER_UNREADABLE });
  }
  const plan = resolveAdoption({
    claimedOrgUserId: existing.app_metadata?.org_user_id,
    rosterRow,
    mintedOrgUserId: orgUserId,
  });
  // A login AND a roster row is a genuine duplicate — refuse, as before.
  if (plan.action === 'reject') throw new Error('That email already belongs to a team member.');
  const boundId = plan.boundId;
  if (boundId != null) {
    if (!isOrgUserId(boundId)) throw new Error(`Invalid org user id: ${boundId}`);
    // `existing.id` is excepted because the clash being checked for is ANOTHER
    // login holding this identity, not this one holding its own.
    if (await orgUserIdInRoster(boundId)) throw new Error('That id already belongs to a team member.');
    await assertNoClaimClash(boundId, existing.id);
  }
  // Re-stamp with the role the admin is choosing NOW — the claim still carries
  // whatever the lost invite asked for, which may not be what they want today.
  await setClaimsForAuthUser(existing.id, { role, orgUserId: boundId });
  // Their original set-password link is almost certainly dead: it is one-time,
  // it expires (Supabase "Email OTP Expiration", ≤24h), and a link-following
  // email scanner burns it on delivery. Always send a fresh one.
  let invited = true;
  try {
    await emailSetPasswordLink(target, redirectTo, 'invite');
  } catch {
    invited = false;
  }
  return { id: existing.id, invited, adopted: true, orgUserId: boundId ?? null };
}

// PURE. What an already-registered email MEANS, and which CRM identity the
// roster row must be bound to. Split out from the IO above because this is the
// part that must never regress — see scripts/test-orphan-adopt.mjs.
//
//   rosterRow present            → 'reject': a login AND a team record is a real duplicate.
//   valid org_user_id claim      → 'adopt' bound to the CLAIMED id. Non-negotiable: every
//                                  server gate resolves identity through that claim, so
//                                  binding anything else strands whatever it references.
//   no / malformed claim         → 'adopt' bound to the caller's freshly-minted id, and the
//                                  claim gets stamped with it (pre-backfill accounts, or one
//                                  created by hand in the Supabase dashboard).
export function resolveAdoption({ claimedOrgUserId, rosterRow, mintedOrgUserId } = {}) {
  if (rosterRow) return { action: 'reject', reason: 'duplicate', boundId: null, source: null };
  const fromClaim = isOrgUserId(claimedOrgUserId);
  return {
    action: 'adopt',
    reason: null,
    boundId: fromClaim ? claimedOrgUserId : (mintedOrgUserId ?? null),
    source: fromClaim ? 'claim' : 'minted',
  };
}

// PURE. Which auth accounts have no roster row. Email match is case- and
// whitespace-insensitive on BOTH sides: the roster is hand-edited through the UI
// and a stray capital would otherwise report a healthy member as an orphan.
export function pickOrphanLogins(authUsers = [], rosterUsers = []) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const rostered = new Set((rosterUsers || []).map((u) => norm(u?.email)).filter(Boolean));
  return (authUsers || [])
    .filter((u) => norm(u?.email) && !rostered.has(norm(u?.email)))
    .map((u) => ({
      email: u.email,
      role: VALID_ROLES.includes(u.app_metadata?.role) ? u.app_metadata.role : null,
      orgUserId: isOrgUserId(u.app_metadata?.org_user_id) ? u.app_metadata.org_user_id : null,
      createdAt: u.created_at || null,
      lastSignInAt: u.last_sign_in_at || null,
    }))
    .sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
}

// Every login with no roster row — the orphan class described above, surfaced so
// a half-created member is DISCOVERABLE instead of waiting for someone to notice
// a name missing from a forty-row list. Read-only; the repair is an ordinary
// invite through createUserAccount, which now adopts.
export async function listOrphanLogins() {
  const sb = getSupabase();
  let state;
  try {
    ({ state } = await readOrgState());
  } catch {
    throw new Error('Could not read the team roster.');
  }
  const authUsers = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    authUsers.push(...users);
    if (users.length < 200) break;
  }
  return pickOrphanLogins(authUsers, Array.isArray(state?.users) ? state.users : []);
}

// Re-stamp the JWT trust-root claims for an existing member (role changes, and
// backfilling the `u_*` org user id). Returns { ok:false, missing:true } when the
// member has no Supabase login yet — that is a normal state (a store-only team
// record), not an error.
export async function syncUserClaims(email, { role, orgUserId } = {}) {
  const u = await findAuthUserByEmail(email);
  if (!u) return { ok: false, missing: true };
  if (orgUserId != null) {
    // Re-stamping an EXISTING member: the id must be that member's own roster
    // id. Anything else is a rebinding attempt, not a sync.
    const rec = await getOrgUserByEmail(email);
    if (rec && rec.id !== orgUserId) throw new Error('That id does not belong to this team member.');
    if (!rec) await assertOrgUserIdUnused(orgUserId, u.id);
    else await assertNoClaimClash(orgUserId, u.id);
  }
  await setClaimsForAuthUser(u.id, { role, orgUserId });
  return { ok: true };
}

// One CRM identity per login, and never an identity that already belongs to a
// team member. Without this, an `org_user_id` pointing at an existing member is
// an identity-takeover primitive: every gate that now keys off the claim (labor,
// QC attribution, push delivery, site assignment) would follow the attacker's
// login into the victim's identity. Throws — covers create and re-stamp.
export async function assertOrgUserIdUnused(orgUserId, exceptAuthUserId = null) {
  if (await orgUserIdInRoster(orgUserId)) {
    throw new Error('That id already belongs to a team member.');
  }
  await assertNoClaimClash(orgUserId, exceptAuthUserId);
}

// No OTHER login may already carry this claim. Deliberately reports no detail
// about the holder — the message reaches an API response, and naming the other
// account would turn this into an id→email oracle.
export async function assertNoClaimClash(orgUserId, exceptAuthUserId = null) {
  const sb = getSupabase();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const clash = users.find((u) => u.id !== exceptAuthUserId && u.app_metadata?.org_user_id === orgUserId);
    if (clash) throw new Error('That id is already linked to another login.');
    if (users.length < 200) break;
  }
}

// Is this login currently banned (can't sign in or refresh)? A `banned_until` in the
// FUTURE; 'none', null, or a past timestamp is not banned. ONE definition, shared by the
// owner-login check below and the status→ban reconcile (loginBanSync.js) so the two can
// never read a ban differently.
export function isLoginBanned(u, now = Date.now()) {
  return !!u?.banned_until && Date.parse(u.banned_until) > now;
}

// Whether a login OTHER than `exceptAuthUserId` holds a Super Admin claim and can still
// sign in (not banned). A Super Admin disabling or removing their own login must leave
// one: only a Super Admin can make another, so the last one gone leaves a service-role
// script as the only way back (set-user-role.mjs). Claims, not the roster: the claim is
// what the server trusts. Throws on a read failure; the login route then answers 500 and
// changes nothing.
export async function hasOtherActiveOwnerLogin(exceptAuthUserId = null, now = Date.now()) {
  const sb = getSupabase();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    if (users.some((u) => u.id !== exceptAuthUserId && u.app_metadata?.role === 'owner' && !isLoginBanned(u, now))) return true;
    if (users.length < 200) break;
  }
  return false;
}

export async function deleteUserAccount(email) {
  const u = await findAuthUserByEmail(email);
  if (!u) return { ok: true, missing: true };
  const { error } = await getSupabase().auth.admin.deleteUser(u.id);
  if (error) throw error;
  return { ok: true };
}

// Ban (disable) or unban (enable) a login by its ALREADY-RESOLVED auth-user id — for a
// caller that has just read the user (loginBanSync, which also needs the id for the
// last-owner check). setUserDisabled is the by-EMAIL twin and delegates here so the one
// ban duration ('876000h' ≈ 100 years; 'none' lifts it) lives in one place.
export async function setLoginBannedById(authUserId, disabled) {
  const { error } = await getSupabase().auth.admin.updateUserById(authUserId, {
    ban_duration: disabled ? '876000h' : 'none',
  });
  if (error) throw error;
  return { ok: true };
}

// Ban (disable) or unban (enable) the login BY EMAIL. A banned user can't sign in or
// refresh; an existing access token stops working within its short lifetime.
export async function setUserDisabled(email, disabled) {
  const u = await findAuthUserByEmail(email);
  if (!u) return { ok: true, missing: true };
  return setLoginBannedById(u.id, disabled);
}

// HTML for a "set your password" email. `kind`: 'invite' (new member) or 'reset'.
function setPasswordEmailHtml(link, kind) {
  const safe = escapeHtml(link);
  const isInvite = kind === 'invite';
  const intro = isInvite
    ? `You've been added to <strong>${escapeHtml(IDENTITY.name)}</strong>. Set your password to finish setting up your account and sign in.`
    : `A password reset was requested for your <strong>${escapeHtml(IDENTITY.name)}</strong> account. Set a new password below.`;
  const cta = isInvite ? 'Set your password' : 'Set a new password';
  const footer = isInvite
    ? `Weren't expecting this? You can safely ignore this email.`
    : `Didn't request this? You can ignore this email — your password won't change.`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${DOC.body};line-height:1.55">
  <p>${intro}</p>
  <p style="font-size:13px;color:${DOC.muted}">This link can be used once and expires shortly.</p>
  <p style="margin:22px 0">
    <a href="${safe}" style="background:${DOC.brand};color:${DOC.onBrand};text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;font-weight:600">${cta}</a>
  </p>
  <p style="font-size:12px;color:${DOC.muted}">If the button doesn't work, paste this link into your browser:<br>${safe}</p>
  <p style="font-size:12px;color:${DOC.muted}">${footer}</p>
</div>`;
}

// Generate a Supabase recovery link for an existing user and email it via Resend.
// `redirectTo` is where they land (the app's /login set-password form). Throws on
// a generation or email failure.
async function emailSetPasswordLink(email, redirectTo, kind) {
  const { data, error } = await getSupabase().auth.admin.generateLink({
    type: 'recovery',
    email,
    ...(redirectTo ? { options: { redirectTo } } : {}),
  });
  if (error) throw error;
  const link = data?.properties?.action_link;
  if (!link) throw new Error('Could not generate the link.');
  const result = await sendEmail({
    to: email,
    // Auth (login/invite/reset) mail goes from a dedicated login@ sender, not
    // the quotes@ default. Same Resend-verified domain (billing.*), so no extra
    // setup; override with RESEND_AUTH_FROM if the address ever changes.
    from: process.env.RESEND_AUTH_FROM || IDENTITY.email.authFrom,
    subject: kind === 'invite'
      ? `Set up your ${IDENTITY.name} account`
      : `Reset your ${IDENTITY.name} password`,
    html: setPasswordEmailHtml(link, kind),
  });
  if (result.skipped) throw new Error('Email is not configured (RESEND_API_KEY missing).');
  if (!result.ok) throw new Error('Link generated, but the email failed to send.');
}

// Email a member a password-reset (recovery) link via Resend. The link goes only
// to the member — the admin never sees or sets a password. Returns { ok } or
// { ok:false, missing:true } when the member has no login yet.
export async function sendPasswordResetLink(email, redirectTo) {
  const target = (email || '').trim().toLowerCase();
  if (!target) throw new Error('email is required');
  const existing = await findAuthUserByEmail(target);
  if (!existing) return { ok: false, missing: true };
  await emailSetPasswordLink(target, redirectTo, 'reset');
  return { ok: true };
}
