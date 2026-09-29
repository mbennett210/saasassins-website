// Tie the Supabase LOGIN ban to a member's roster STATUS, so "Disabled" always implies
// "login banned" — however the status was set.
//
// WHY (S87 is the suspenders; this is the belt). S87 makes a member whose committed roster
// status is a no-access one (authz.js ACCESS_STATUSES / hasNoAccess) hold NO server ROUTE
// authority — every app API route answers 403 `account-disabled`. But that only covers the
// app's own routes. A member whose Supabase LOGIN is not also banned can still, with their
// own valid session, reach Supabase DIRECTLY: read the org_state blob (the RLS read policy
// is open) and INSERT/UPDATE/DELETE in the storage buckets whose policies admit any
// authenticated user — notably `marketing-attachments`, which the marketing cron then
// emails to contacts. Only the GoTrue login ban (users.js setUserDisabled → ban_duration)
// stops that direct access.
//
// The normal Team path already bans: TeamDetail → teamApi.applyLoginChanges →
// POST /api/settings/users/disable → setUserDisabled, on a status change. The GAP this
// closes is a RAW org_state save (a crafted client, bypassing the Team UI) that flips a
// member to a no-access status WITHOUT that ban. So the org_state write endpoint, after it
// COMMITS a save, reconciles the login ban to the committed status here.
//
// SAFE because it runs only AFTER orgStateGuard ACCEPTED the save (api/state/org-state.js):
// the guard already enforces WHO may change WHOSE status — disabling an Admin takes admin+
// by role, an owner's status only an owner (S87 protectedFieldViolations) — so a COMMITTED
// status change was already authorized, and banning on it bans only a member the actor was
// allowed to disable. This never re-authorizes and never runs on an uncommitted save.
//
// CONTRACT, mirroring crewAssignments.syncAssignmentsFromState (the other post-commit sync
// on that write path): BEST-EFFORT (the save has already committed — a ban failure must
// NEVER fail it), IDEMPOTENT (a login already in the wanted state is left alone, so it never
// double-bans what the Team UI just banned), and LOGGED / reported on failure. It NEVER bans
// the last active owner login (OWNER_CORE spirit: only an owner can make another, so the
// last one gone strands the org off a service-role script — users.js hasOtherActiveOwnerLogin).
import { hasNoAccess } from './authz.js';
import { findAuthUserByEmail, setLoginBannedById, hasOtherActiveOwnerLogin, isLoginBanned } from './users.js';

// Roster rows by id, LAST wins (as orgStateGuard.byId and the reducer's upsert do). A row
// with no string id can't be matched across the two states, so it is left out.
function byId(users) {
  const m = new Map();
  for (const u of Array.isArray(users) ? users : []) {
    if (u && typeof u.id === 'string' && u.id) m.set(u.id, u);
  }
  return m;
}

// PURE. The members whose login-ban state must change between the committed roster `prev`
// and the just-committed `next`, by STATUS transition (hasNoAccess: `active` / `invited`
// keep access, everything else — `disabled`, `inactive`, a crafted `Disabled ` — ends it;
// authz.js owns that allowlist, never restated here). Matched BY ID: each transition targets
// one member's own row, and its own `email` is what finds the login to ban.
//   · toBan   — went from access (or a newly-added row) to no-access: its login must be banned.
//   · toUnban — went from no-access back to access: its login must be un-banned.
// A member only in `prev` is a REMOVAL — the login-delete route's job (which deletes the
// login), not this one — so it is left out. A row with no usable email is skipped (nothing
// to find). A new member added as `active`/`invited` is not a transition (their login, if
// any, is already usable), so it is left out too.
export function loginBanTransitions(prev, next) {
  const prevById = byId(prev);
  const toBan = [];
  const toUnban = [];
  for (const [id, after] of byId(next)) {
    const before = prevById.get(id);
    const nowNoAccess = hasNoAccess(after);
    const wasNoAccess = before ? hasNoAccess(before) : false; // a newly-added row starts un-banned
    if (nowNoAccess === wasNoAccess) continue;
    const email = typeof after.email === 'string' ? after.email.trim() : '';
    if (!email) continue;
    const target = { id, email, role: after.role || before?.role || null };
    (nowNoAccess ? toBan : toUnban).push(target);
  }
  return { toBan, toUnban };
}

// Reconcile Supabase login bans to the committed roster status. NEVER throws: the save has
// already committed, so every failure is COLLECTED and returned, never surfaced as a lost
// save. Returns a summary — a non-empty `failures` is what the caller logs and flags in the
// response; `skippedLastOwner` is reported too (a disabled owner whose login was left active
// because they are the org's last one). Reads each login once (findAuthUserByEmail) and
// writes only when the ban state actually differs, so it makes no GoTrue call for a status
// change the Team UI already mirrored, and none at all when nothing transitioned.
export async function syncLoginBansFromState(prev, next, { now = Date.now() } = {}) {
  const { toBan, toUnban } = loginBanTransitions(prev, next);
  const summary = { banned: 0, unbanned: 0, missing: 0, unchanged: 0, skippedLastOwner: 0, failures: [] };
  if (!toBan.length && !toUnban.length) return summary;

  // Un-bans first: if the same save re-enables one owner and disables another, the re-enabled
  // one counts as an active owner when the disable's last-owner check runs below.
  for (const m of toUnban) {
    try {
      const u = await findAuthUserByEmail(m.email);
      if (!u) { summary.missing += 1; continue; }
      if (!isLoginBanned(u, now)) { summary.unchanged += 1; continue; }
      await setLoginBannedById(u.id, false);
      summary.unbanned += 1;
    } catch (e) {
      summary.failures.push({ email: m.email, op: 'unban', message: e?.message || String(e) });
    }
  }
  for (const m of toBan) {
    try {
      const u = await findAuthUserByEmail(m.email);
      if (!u) { summary.missing += 1; continue; } // no login yet (e.g. an invite never sent): nothing to ban
      if (isLoginBanned(u, now)) { summary.unchanged += 1; continue; } // already banned (e.g. by the Team UI): no double-ban
      // NEVER ban the last active owner login. Only an owner can make another, so the last
      // one gone leaves a service-role script as the only way back in (OWNER_CORE spirit).
      // The guard only lets an owner disable an owner's status, so this is a deliberate
      // owner action on a co-owner — banned only while another active owner login remains.
      if (m.role === 'owner' && !(await hasOtherActiveOwnerLogin(u.id, now))) { summary.skippedLastOwner += 1; continue; }
      await setLoginBannedById(u.id, true);
      summary.banned += 1;
    } catch (e) {
      summary.failures.push({ email: m.email, op: 'ban', message: e?.message || String(e) });
    }
  }
  return summary;
}

// PURE. The members REMOVED from the committed roster between `prev` and the just-committed
// `next` — present in prev, absent from next, matched BY ID (as orgStateGuard.removedMemberIds
// and loginBanTransitions match members, LAST row wins per id). Each is a login whose roster
// row is gone, so it must be BANNED (see banRemovedLogins). Carries the removed row's own
// `email` (trimmed, what finds the login) and `role` (what the last-owner guard reads).
//
// WHY (the belt to loginBanTransitions above, which deliberately LEAVES removals out). The
// normal Team path DELETES the login on removal (/api/settings/users/delete). But a RAW
// org_state save — a crafted client bypassing that route — drops a roster row WITHOUT that
// delete, and authz.js keeps a CLAIMED login with no roster row VALID (the orphan-login
// recovery fallback, S87), so the removed member's login AND its JWT claim persist with FULL
// route authority. This finds those logins so the write endpoint can ban them, closing the
// removal gap the way the status sync closes the status one.
//
// An ORPHAN login (an auth login in NEITHER prev nor next) is not in prev, so it is NEVER
// returned — it must stay signable-in to self-heal through /api/settings/users/reconcile-self
// (_lib/reconcile.js). A member in BOTH states is not a removal (a status change is
// loginBanTransitions' job). A removed row with no usable email is skipped (nothing to find).
export function removedLoginsToBan(prev, next) {
  const nextById = byId(next);
  const out = [];
  for (const [id, before] of byId(prev)) {
    if (nextById.has(id)) continue; // still on the roster: a status change, not a removal
    const email = typeof before.email === 'string' ? before.email.trim() : '';
    if (!email) continue;
    out.push({ id, email, role: before.role || null });
  }
  return out;
}

// Ban the Supabase login of every member the committed save REMOVED from the roster. Same
// contract as syncLoginBansFromState: NEVER throws (the save has committed, so a ban failure is
// COLLECTED and returned, never a lost save), IDEMPOTENT (a login already banned — the member
// was disabled before removal, or the Team delete route already ran — is left alone), and it
// NEVER bans the last active owner login (hasOtherActiveOwnerLogin, OWNER_CORE spirit). BAN, not
// delete: reversible, and a clean no-op when the login is already gone (the normal delete path
// ran), so it is safe to run beside that path. Reads each login once and writes only when it
// isn't already banned, so it makes no GoTrue call when nothing was removed.
export async function banRemovedLogins(prev, next, { now = Date.now() } = {}) {
  const removed = removedLoginsToBan(prev, next);
  const summary = { banned: 0, missing: 0, unchanged: 0, skippedLastOwner: 0, failures: [] };
  if (!removed.length) return summary;
  for (const m of removed) {
    try {
      const u = await findAuthUserByEmail(m.email);
      if (!u) { summary.missing += 1; continue; } // no login (or the delete route already removed it): nothing to ban
      if (isLoginBanned(u, now)) { summary.unchanged += 1; continue; } // already banned: no-op (idempotent)
      // NEVER ban the last active owner login. The guard already let an owner remove this
      // co-owner (a non-owner can't remove an owner, and no one may leave the team without a
      // Super Admin), but banning the org's LAST active owner login would strand it off a
      // service-role script — left ACTIVE and reported instead (OWNER_CORE spirit).
      if (m.role === 'owner' && !(await hasOtherActiveOwnerLogin(u.id, now))) { summary.skippedLastOwner += 1; continue; }
      await setLoginBannedById(u.id, true);
      summary.banned += 1;
    } catch (e) {
      summary.failures.push({ email: m.email, op: 'ban-removed', message: e?.message || String(e) });
    }
  }
  return summary;
}
