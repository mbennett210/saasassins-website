// Pure claims-first identity resolution — the client mirror of the server's
// authz.js resolveAuthority. Shared by sync.js (withSession) and
// selectors.js (selectCurrentUser), and unit-tested directly
// (scripts/test-identity-resolve.mjs). NO imports on purpose: this is the load-
// bearing logic behind the 2026-08-03 lockout fix and must be trivially testable
// in isolation, with zero browser/store dependencies.

// Which roster id this session IS. Mirrors the server (authz.js is claims-first):
//   • when the JWT carries a claim org_user_id it is FULLY AUTHORITATIVE — use
//     the roster row with that id, or (no such row) the claim id ITSELF, so a
//     valid login is non-null even with a missing roster row (the orphan-login
//     lockout). Email is NOT consulted here: the claim id is the tamper-proof
//     binding, so a renamed roster email can't strand a login and a coincidental
//     email match can't hijack a different identity.
//   • only a CLAIM-LESS login (legacy / un-backfilled, or demo/local) falls back
//     to the email match, then to the existing currentUserId.
export function resolveCurrentUserId({ users, sessionEmail, claimOrgUserId, fallback = null }) {
  const list = Array.isArray(users) ? users : [];
  if (claimOrgUserId) {
    const byId = list.find((u) => u.id === claimOrgUserId);
    return byId ? byId.id : claimOrgUserId;
  }
  const email = (sessionEmail || '').toLowerCase();
  const byEmail = email ? list.find((u) => (u.email || '').toLowerCase() === email) : null;
  return byEmail ? byEmail.id : fallback;
}

// The effective current user for permission checks + display. The roster row
// supplies profile, but the CLAIM ROLE overrides a stale/mismatched blob role
// (fixes a role split), and when the roster row is missing entirely we
// synthesize a minimal user from the claim so a valid login is never denied.
//   `auth`  = the per-session claim { claimOrgUserId, claimRole, sessionEmail }
//             (null in demo/no-claim mode → row returned unchanged).
//   `memo`  = a stabilizer the selector passes so divergent results keep a stable
//             reference (usePermission relies on Object.is); default is a pass-
//             through for correctness tests.
export function resolveCurrentUser({ row, auth, currentUserId, memo = (_deps, make) => make() }) {
  if (!auth || !auth.claimRole) return row;               // demo / no claim → unchanged
  if (row) {
    if (row.role === auth.claimRole) return row;           // blob agrees → by reference
    return memo([row, auth.claimRole], () => ({ ...row, role: auth.claimRole, __effectiveRole: true }));
  }
  if (currentUserId && auth.claimOrgUserId === currentUserId) { // no roster row → synthesize from claim
    return memo(['claim', auth.claimOrgUserId, auth.claimRole, auth.sessionEmail], () => ({
      id: auth.claimOrgUserId,
      email: auth.sessionEmail || null,
      role: auth.claimRole,
      name: auth.sessionEmail ? auth.sessionEmail.split('@')[0] : 'Team member',
      status: 'active',
      initials: (auth.sessionEmail || '?').slice(0, 2).toUpperCase(),
      __fromClaim: true,
    }));
  }
  return row;
}
