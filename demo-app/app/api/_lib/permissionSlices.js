// The committed permission matrix + per-user overrides, in the shape lib/roles can()
// reads without throwing.
//
// Two server guards authorize FROM these slices: orgStateGuard (Team administration)
// and jobsGuard (job creates, deletes, reschedules, re-crews). Both must read a
// malformed committed row the same way, as a MISSING one, never a throw. can() calls
// .find on both lists and .includes on a row's roles / grants / revokes, so one bad row
// would throw inside the guard: org_state saves would 500, and a jobs save that 500s
// retries every 5 s forever. A string where an array belongs would be worse than a
// throw: .includes on a string matches a SUBSTRING, so roles: 'crews' would hold for crew.
//
// So: a matrix that isn't an array reads as null (can() then uses the schema defaults,
// its own rule for a missing record); a row without a string id and a roles array is
// dropped, so that key falls back to its defaults; an override row without a string
// userId is ignored, and grants / revokes that aren't arrays count as none. Nothing is
// widened past what the app writes: orgStateGuard refuses a malformed row from anyone
// but an owner, and the app never writes one.

export function matrixForCan(permissions) {
  return Array.isArray(permissions)
    ? permissions.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.roles))
    : null;
}

export function overridesForCan(overrides) {
  return (Array.isArray(overrides) ? overrides : [])
    .filter((o) => o && typeof o.userId === 'string')
    .map((o) => ({
      userId: o.userId,
      grants: Array.isArray(o.grants) ? o.grants : [],
      revokes: Array.isArray(o.revokes) ? o.revokes : [],
    }));
}
