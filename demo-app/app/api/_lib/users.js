// Admin user-management helpers (service-role). Used by the settings function
// to create/remove/disable the actual Supabase login for a team member, so the
// Settings → Team UI manages real access (not just a store record). Service-
// role only — never import client-side.
import crypto from 'node:crypto';
import { getSupabase } from './supabase.js';
import { readOrgState } from './orgState.js';
import { readRosterUsers, admissionOf } from './authz.js';
import { sendEmail, systemSenderReady } from './email.js';
import { isHubPreviewEmail } from '../../src/lib/hubPreview.js';
import {
  buildClaims, setClaimsForAuthUser, VALID_ROLES, isOrgUserId,
  buildClientClaims, setClientClaimsForAuthUser, isClientUserId,
} from './claims.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { CLIENT_ROLE } from '../../src/lib/clientHub.js';
// Why a set-password link did not leave by email — the screens' words follow it (the one list).
import { LINK_NOT_SENT } from '../../src/lib/signInLink.js';
import { IDENTITY } from '../../src/brand/identity.generated.js';
import { setPasswordEmail } from '../../src/lib/signInEmail.js';
import { deleteMemberStorage } from './memberStorage.js';

// GoTrue's admin list is paged; these bound one full scan of it. 50 pages of 200 is 10,000
// logins — Matt's 1,500 cleaners plus a login or two for each of 750 buildings, several times over.
export const AUTH_PAGE_SIZE = 200;
export const AUTH_MAX_PAGES = 50;

// Find a Supabase auth user by email. listUsers is paginated; this reads every page (bounded
// above) until it finds the address or the list ends.
//
// 🔴 A SCAN THAT RUNS OUT IS NOT "NO LOGIN" (S128, CS-660's family). It used to stop after 10
// pages (2,000 logins) and answer null, which every caller reads as "this address has no login":
// past 2,000 logins a staff address would pass Customer logins' Save, and an orphan would never
// be found to adopt. Now a list longer than the bound THROWS, so a caller fails closed.
export async function findAuthUserByEmail(email) {
  const sb = getSupabase();
  const target = (email || '').trim().toLowerCase();
  if (!target) return null;
  for (let page = 1; page <= AUTH_MAX_PAGES; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((u) => (u.email || '').toLowerCase() === target);
    if (found) return found;
    if (users.length < AUTH_PAGE_SIZE) return null;
  }
  throw new Error(`There are more than ${AUTH_PAGE_SIZE * AUTH_MAX_PAGES} logins, so the address couldn't be checked against all of them.`);
}

const emailKey = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

// The member a login action acts on (Settings → Team's login routes, and a termination turning a
// login off): their login's claims (the trust root) and every committed roster row carrying their
// email or their claimed u_* id. A row matched either way counts, so a split (a login whose claim
// points at a row with another email) reads as the stricter of the two. The shape
// teamAuthority.loginRefusal reads as `target`.
export async function loginTarget(email, roster) {
  const au = await findAuthUserByEmail(email);
  const md = au?.app_metadata || {};
  const claimOrgUserId = isOrgUserId(md.org_user_id) ? md.org_user_id : null;
  const key = emailKey(email);
  const rows = (Array.isArray(roster) ? roster : [])
    .filter((u) => u && typeof u === 'object' && ((key && emailKey(u.email) === key) || (claimOrgUserId && u.id === claimOrgUserId)))
    .map((u) => ({ id: u.id, role: u.role, email: u.email }));
  return {
    email,
    authUserId: au?.id ?? null,
    claimRole: VALID_ROLES.includes(md.role) ? md.role : null,
    claimOrgUserId,
    // A CUSTOMER's login (role 'client'): never a team member's, so the team routes don't hand
    // out its sign-in link (teamAuthority loginRefusal 'reset').
    isClient: md.role === CLIENT_ROLE,
    rows,
  };
}

// A login by its auth id: the user, or null when GoTrue has no such login. Throws on any other
// failure, so a caller deciding whether to touch a login never mistakes an outage for "gone".
export async function getAuthUserById(id) {
  if (!id) return null;
  const { data, error } = await getSupabase().auth.admin.getUserById(id);
  if (error) {
    if (error.status === 404 || error.code === 'user_not_found') return null;
    throw error;
  }
  return data?.user || null;
}

// Is this address on the TEAM — any row of the committed roster, whatever its status? STRICT: a
// roster that can't be read throws (the caller refuses, never "not on the team"). The org's first
// sign-in has no roster yet: nobody is on it.
export async function emailOnRoster(email) {
  const target = (email || '').trim().toLowerCase();
  if (!target) return false;
  const users = await readRosterUsers();
  return Array.isArray(users) && users.some((u) => u && typeof u.email === 'string' && u.email.trim().toLowerCase() === target);
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

// Create a login and email the new member a "set your password" link through the Google
// system sender (same recovery flow as a reset) — the admin never sees or shares a password.
// The account is created with a random password the member never uses + email
// confirmed, so it's usable the moment they set their own password via the link.
// Returns { id, invited, adopted, orgUserId } and, when the email did NOT go, the reason and the
// one-time link (handOverLink below): invited:false + `link` is the office's to send (CS-661).
// `claims` ({ role, orgUserId }) stamps the JWT trust root at creation time so
// a new login is never briefly claim-less (see _lib/claims.js). The caller mints
// the `u_*` org user id before this call, so both halves are known up front.
// The link goes by EMAIL only (the 2026-10-28 texting fixes Daniel approved, "Do the rest of the
// fixes": the texting campaign covers customer texts, not sign-in links); GO-7's texted link for
// a cleaner was removed with it.
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
  // The login exists either way; the set-password link is emailed, or handed back.
  return { id: data.user.id, adopted: false, orgUserId: claims.orgUserId ?? null, ...(await handOverLink(target, redirectTo, 'invite')) };
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
  // A CUSTOMER's login is never adopted as staff (the mirror of CS-706): re-stamping it would end
  // the customer's hub access without a word and hand the office's reach to whoever reads that
  // inbox. The office uses another address, or removes the customer login first.
  if (existing.app_metadata?.role === CLIENT_ROLE) {
    throw new Error('That email signs in to the customer hub. Use a different address for the team member.');
  }
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
  // email scanner burns it on delivery. Always make a fresh one.
  return { id: existing.id, adopted: true, orgUserId: boundId ?? null, ...(await handOverLink(target, redirectTo, 'invite')) };
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
// A CUSTOMER's login (role 'client') is never one: it has no roster row by design, and offering
// "Add to team" on it would invite the office to turn a customer into staff (S128).
export function pickOrphanLogins(authUsers = [], rosterUsers = []) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const rostered = new Set((rosterUsers || []).map((u) => norm(u?.email)).filter(Boolean));
  return (authUsers || [])
    .filter((u) => norm(u?.email) && !rostered.has(norm(u?.email)) && u?.app_metadata?.role !== CLIENT_ROLE)
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
  let state;
  try {
    ({ state } = await readOrgState());
  } catch {
    throw new Error('Could not read the team roster.');
  }
  return pickOrphanLogins(await listAllLogins(), Array.isArray(state?.users) ? state.users : []);
}

// Every login, page by page (bounded like findAuthUserByEmail, and like it THROWING when the list
// is longer than the bound — a partial list must never read as the whole one).
export async function listAllLogins() {
  const sb = getSupabase();
  const all = [];
  for (let page = 1; page <= AUTH_MAX_PAGES; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw error;
    const users = data?.users || [];
    all.push(...users);
    if (users.length < AUTH_PAGE_SIZE) return all;
  }
  throw new Error(`There are more than ${AUTH_PAGE_SIZE * AUTH_MAX_PAGES} logins, so the list couldn't be read whole.`);
}

// PURE (CS-661, S128). The Team list's sign-in state, by address: which members' logins have
// NEVER signed in (an invite or a link nobody used yet — they would otherwise look Active), and
// which members have no login at all. Addresses lower-cased; a member with no email is skipped.
export function pickSignIns(authUsers = [], rosterUsers = []) {
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const byEmail = new Map();
  for (const u of authUsers || []) if (norm(u?.email)) byEmail.set(norm(u.email), u);
  const neverSignedIn = [];
  const noLogin = [];
  for (const m of rosterUsers || []) {
    const e = norm(m?.email);
    if (!e) continue;
    const login = byEmail.get(e);
    if (!login) noLogin.push(e);
    else if (!login.last_sign_in_at) neverSignedIn.push(e);
  }
  return { neverSignedIn: [...new Set(neverSignedIn)].sort(), noLogin: [...new Set(noLogin)].sort() };
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

// Remove a member's login, THEN their images (UI_RULES §141, CS-627): the photo folder and the
// signature image of every id they were known by — `orgUserIds` (the route passes their roster
// rows' ids and their claimed id) plus the deleted login's own claimed id. The image cleanup is
// best-effort (memberStorage.deleteMemberStorage never throws): the login is already gone, so
// the removal must not look failed, and the daily reap sweeps whatever a failure leaves.
export async function deleteUserAccount(email, { orgUserIds = [] } = {}) {
  const u = await findAuthUserByEmail(email);
  if (u) {
    const { error } = await getSupabase().auth.admin.deleteUser(u.id);
    if (error) throw error;
  }
  const ids = [...orgUserIds, u?.app_metadata?.org_user_id].filter((id) => typeof id === 'string' && id);
  const images = ids.length ? await deleteMemberStorage(ids) : null;
  return u ? { ok: true, images } : { ok: true, missing: true, images };
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

// The "set your password" email's words (setPasswordEmail: an invite or a reset) live in the shared
// src/lib/signInEmail.js, so the Review section's Drafts preview renders the very email sent here.

// Generate a Supabase recovery link for an existing login. `redirectTo` is where they land
// (the app's /login set-password form). Throws when one can't be made.
//
// 🔴 THE RETURN VALUE IS A CAPABILITY. Anyone holding it can set that account's password.
// Never log it, never persist it; a route that answers with it must be permission-gated and
// `Cache-Control: no-store`. ONE generator for every invite and reset path, so they can never
// drift on link type, TTL or redirect. A new link VOIDS the one before it (GoTrue keeps one
// recovery token per login), which is why the screens say so before a re-invite.
async function generateSetPasswordLink(email, redirectTo) {
  const { data, error } = await getSupabase().auth.admin.generateLink({
    type: 'recovery',
    email,
    ...(redirectTo ? { options: { redirectTo } } : {}),
  });
  if (error) throw error;
  const link = data?.properties?.action_link;
  if (!link) throw new Error('Could not generate the link.');
  return link;
}

// THE ONE WAY A SET-PASSWORD LINK LEAVES THE SERVER (S128, CS-661). The Google system sender
// emails it to the person; when it can't, the CALLER gets the link back to hand to the office,
// who send it themselves (GO-10's shape for customer logins, and since CS-661 staff's too).
// 🔴 EMAIL ONLY (the 2026-10-28 texting fixes). The texted link (GO-7 for cleaners, 2026-10-19, and the
// customer's hub invite) is gone: the approved texting campaign covers the three customer texts,
// not sign-in links. The link is a capability: it is never logged.
// Never throws. { emailed, why? }.
async function deliverSetPasswordLink(email, link, kind) {
  const { subject, html } = setPasswordEmail(link, kind);
  let result;
  try {
    result = await sendEmail({
      to: email,
      // Auth (login/invite/reset) mail leaves from the SYSTEM SENDER like everything else —
      // Gmail sends as the authenticated mailbox, so a per-purpose From is not something this
      // transport can honour. The brand's auth address rides as the Reply-To instead, so a
      // reply still reaches the right place (api/_lib/email.js resolveFromAndReplyTo).
      replyTo: IDENTITY.email.authFrom,
      subject,
      html,
    });
  } catch {
    result = { ok: false };
  }
  if (result?.ok) return { emailed: true };
  return { emailed: false, why: result?.skipped ? LINK_NOT_SENT.notSetUp : LINK_NOT_SENT.failed };
}

// A fresh link, delivered — the invite paths' half of their answer:
//   { invited: true }                    emailed
//   { invited: false, why, link }        NOT sent: `link` is the office's to send
//   { invited: false, why: 'no-link' }   not even made (the login exists; invite again)
// 🔴 `link` only when it was NOT sent: the capability goes where it is needed and nowhere else.
async function handOverLink(email, redirectTo, kind) {
  let link;
  try {
    link = await generateSetPasswordLink(email, redirectTo);
  } catch {
    return { invited: false, why: LINK_NOT_SENT.noLink };
  }
  const sent = await deliverSetPasswordLink(email, link, kind);
  if (sent.emailed) return { invited: true };
  return { invited: false, why: sent.why, link };
}

// ── CUSTOMER-HUB LOGINS (the client hub, 2026-10-03) ─────────────────────────
// A client user's login is a Supabase account like any other, with three differences that
// are the whole of its isolation and must not be relaxed:
//   1. its claims are role 'client' + client_user_id, and NO org_user_id (buildClientClaims);
//   2. it is ADOPTED only when it is already this contact's customer login, or a login with no
//      claim at all whose address is on no team roster row (resolveClientAdoption, CS-706): a
//      staff login stamped `client` loses the office, and a claim-less one may be a team
//      member's that was never stamped ("created outside the app", authz.js);
//   3. the stamp is READ BACK. GoTrue merges app_metadata key by key, so "I passed null" is
//      not proof the key is gone, and `public.jobs` RLS reads the TOKEN, not our claims
//      helper — a surviving org_user_id would admit a customer to crew rows.
//
// Returns { authUserId, adopted, invited } and, when nothing was emailed, `why` and the one-time
// set-password `link`, for the office to send themselves (GO-10: "we will send the invite
// ourselves for the pilot"). 🔴 `link` is a capability — never log it, never store it, no-store
// the response that carries it. The invite goes by email only (2026-10-28).
export async function createClientUserAccount(email, redirectTo, { clientUserId } = {}) {
  const sb = getSupabase();
  const target = (email || '').trim().toLowerCase();
  if (!target) throw new Error('email is required');
  if (!isClientUserId(clientUserId)) throw new Error(`Invalid client user id: ${clientUserId}`);
  const appMetadata = buildClientClaims({ clientUserId });

  const existing = await findAuthUserByEmail(target);
  let authUserId;
  let adopted = false;
  if (existing) {
    // A re-invite of this contact, or a claim-less login nobody on the team holds: re-stamp it
    // (which also clears any stray org_user_id) and make a fresh link — the old one is one-time,
    // expires within 24h, and an email scanner burns it on delivery.
    await adoptClientLogin(existing, target, clientUserId);
    authUserId = existing.id;
    adopted = true;
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email: target,
      password: generateTempPassword(),
      email_confirm: true,
      app_metadata: appMetadata,
    });
    if (error) {
      // Lost a race: a login appeared at this address between the lookup and the create (another
      // office tab inviting the same person, or anything else). The SAME rule decides it.
      const raced = await findAuthUserByEmail(target);
      if (!raced) throw error;
      await adoptClientLogin(raced, target, clientUserId);
      authUserId = raced.id;
      adopted = true;
    } else {
      authUserId = data.user.id;
      const md = data.user.app_metadata || {};
      // Read-back on the CREATE path too (see 3 above): if the account came back wrong, ban
      // it before anyone can use it and say so, rather than leaving a staff-reaching login.
      if (md.role !== CLIENT_ROLE || md.org_user_id != null) {
        try { await setLoginBannedById(authUserId, true); } catch { /* best effort */ }
        throw new Error('The customer login could not be stamped safely; it was disabled.');
      }
    }
  }
  return { authUserId, adopted, ...(await handOverLink(target, redirectTo, 'invite')) };
}

// The claim keys that make a login SOMEONE's: a staff role or id, a customer row, or this org's
// stamp. A login carrying none of them was never stamped by this app.
const CLAIM_KEYS = ['role', 'org_user_id', 'client_user_id', 'org_id'];
const isClaimless = (md) => CLAIM_KEYS.every((k) => md?.[k] == null || md[k] === '');

// PURE (CS-706, S128). May the customer invite take over this EXISTING login for contact
// `clientUserId`? Only when it is already that contact's customer login (a re-invite), or it
// carries no claim at all AND its address is on no team roster row. Everything else is refused,
// and so is "can't tell":
//   'team'      a staff role or a u_* id: a team member's login
//   'other'     a customer login, but another contact's (or another org's)
//   'kind'      some other claim
//   'roster'    claim-less, but the address is on the team roster (a member never stamped)
//   'unknown'   claim-less, and the roster couldn't be read
// `onRoster` is true / false, or null when the roster couldn't be read.
export function resolveClientAdoption({ claims, clientUserId, onRoster = null } = {}) {
  const md = claims && typeof claims === 'object' ? claims : {};
  if (VALID_ROLES.includes(md.role) || isOrgUserId(md.org_user_id)) return { action: 'reject', reason: 'team' };
  if (md.role === CLIENT_ROLE) {
    const ours = isClientUserId(clientUserId) && md.client_user_id === clientUserId && (md.org_id == null || md.org_id === CLEANSPACE_ORG_ID);
    return ours ? { action: 'adopt', reason: 'reinvite' } : { action: 'reject', reason: 'other' };
  }
  if (!isClaimless(md)) return { action: 'reject', reason: 'kind' };
  if (onRoster === false) return { action: 'adopt', reason: 'claimless' };
  return { action: 'reject', reason: onRoster === true ? 'roster' : 'unknown' };
}

// What each refusal says to the office.
export const CLIENT_ADOPTION_REFUSALS = Object.freeze({
  team: 'That email already belongs to a team member. Use a different address for the customer contact.',
  roster: 'That email belongs to someone on your team. Use the customer contact\'s own address.',
  other: 'That email already signs in as another customer contact. Use a different address.',
  kind: 'That email already has a login of another kind.',
  unknown: "The team list couldn't be read, so the login wasn't changed. Try again.",
});

// Decide (reading the roster only when the answer turns on it, and strictly), then re-stamp.
async function adoptClientLogin(login, target, clientUserId) {
  const claims = login.app_metadata || {};
  let onRoster = null;
  if (isClaimless(claims)) {
    try { onRoster = await emailOnRoster(target); } catch { onRoster = null; }
  }
  const plan = resolveClientAdoption({ claims, clientUserId, onRoster });
  if (plan.action !== 'adopt') {
    throw Object.assign(new Error(CLIENT_ADOPTION_REFUSALS[plan.reason]), { code: plan.reason === 'unknown' ? ROSTER_UNREADABLE : 'refused' });
  }
  await setClientClaimsForAuthUser(login.id, { clientUserId });
}

// PURE (CS-660, S128). Is this login PROVABLY the customer login of contact row `clientUserId`?
// Its claims must say role 'client' and this very row (and this org, when stamped). The office's
// Disable and Remove act on nothing else: an address match alone once banned and deleted the
// shared office login.
export function isClientLoginFor(user, clientUserId) {
  const md = user?.app_metadata || {};
  return md.role === CLIENT_ROLE && isClientUserId(clientUserId) && md.client_user_id === clientUserId
    && (md.org_id == null || md.org_id === CLEANSPACE_ORG_ID);
}

// The login of customer contact `row`, and whether it is provably theirs: the row's own
// auth_user_id first, else the login at its address (an invite whose row write was lost).
//   { verdict: 'theirs', authUserId }   their own customer login
//   { verdict: 'none' }                 no login at all
//   { verdict: 'other' }                a login exists, but its claims are not this contact's
// THROWS when GoTrue can't be read: the caller refuses rather than guess.
export async function customerLoginOf(row) {
  let user = row?.auth_user_id ? await getAuthUserById(row.auth_user_id) : null;
  if (!user) user = await findAuthUserByEmail(row?.email);
  if (!user) return { verdict: 'none' };
  return isClientLoginFor(user, row.id) ? { verdict: 'theirs', authUserId: user.id } : { verdict: 'other' };
}

// Ban (or unban) customer contact `row`'s login — only one provably theirs. Never throws.
//   true / false     the login was banned / unbanned
//   null             there is no login
//   'kept'           a login holds the address but is not theirs: untouched
//   'failed'         the login couldn't be read or changed (the row's status still holds every gate)
export async function setCustomerLoginBanned(row, banned) {
  let found;
  try { found = await customerLoginOf(row); } catch { return 'failed'; }
  if (found.verdict === 'none') return null;
  if (found.verdict === 'other') return 'kept';
  try { await setLoginBannedById(found.authUserId, banned); return banned; } catch { return 'failed'; }
}

// THE ONE RESET STEP: a login's password-reset link, made fresh and emailed by the system sender
// (generateSetPasswordLink + deliverSetPasswordLink 'reset', the office's own reset email). Both ways a
// reset starts run it, so they can never differ on the link, where it lands or the email:
//   · the office's, from a member's page (api/settings users/reset-link): `handOver: true`, so when
//     the email can't go the link comes back for the office to send (CS-661) — the route decides
//     whether this caller may hold it;
//   · the person's own, the sign-in page's "Forgot password?" (api/public/auth, EP-413): `admit`
//     (loginMayResetOwnPassword below) and NO hand-over — the link leaves by email or not at all.
//   { ok: true, emailed: true }
//   { ok: true, emailed: false, why }          nothing emailed (`link` too, only with handOver)
//   { ok: false, missing: true }               no login at that address
//   { ok: false, refused: true }               `admit` said no: nothing was made
// 🔴 `link` is a capability: no-store, never logged. Throws when the link can't be made.
export async function sendPasswordResetLink(email, redirectTo, { handOver = false, admit = null } = {}) {
  const target = (email || '').trim().toLowerCase();
  if (!target) throw new Error('email is required');
  const existing = await findAuthUserByEmail(target);
  if (!existing) return { ok: false, missing: true };
  if (admit && !(await admit(existing))) return { ok: false, refused: true };
  // With no one to hand it to, a link the system sender can't email could only be thrown away, and
  // making it VOIDS the person's last one (one recovery token per login) — so none is made.
  if (!handOver && !(await systemSenderReady())) return { ok: true, emailed: false, why: LINK_NOT_SENT.notSetUp };
  const link = await generateSetPasswordLink(target, redirectTo);
  const sent = await deliverSetPasswordLink(target, link, 'reset');
  if (sent.emailed) return { ok: true, emailed: true };
  return handOver ? { ok: true, emailed: false, why: sent.why, link } : { ok: true, emailed: false, why: sent.why };
}

// May the sign-in page's "Forgot password?" email this login a reset? Only a login that could sign
// in and act right now — the answer the server's gates give it once it has:
//   · not banned in GoTrue (isLoginBanned: a member whose access ended, a removed one);
//   · not at the customer hub preview's reserved address (lib/hubPreview isHubPreviewEmail: a
//     stand-in is never a mailbox and never a login);
//   · admitted by authz.js admissionOf: a staff login by the committed roster's status (a Disabled
//     member, or a claim-less login no row carries, holds nothing), a customer's by its own
//     client_users row (gone, Disabled, or the preview stand-in: no access). Unreadable is a no.
// Never throws.
export async function loginMayResetOwnPassword(login) {
  if (!login || isLoginBanned(login) || isHubPreviewEmail(login.email)) return false;
  try {
    return (await admissionOf(login)).admitted === true;
  } catch {
    return false;
  }
}
