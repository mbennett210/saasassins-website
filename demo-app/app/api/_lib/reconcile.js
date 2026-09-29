// Pure roster decision for the orphan-login self-heal
// (settings/users/reconcile-self). Given the current roster + the caller's
// CLAIM-resolved identity, decide whether to materialize the caller's OWN roster
// row. No I/O and no imports → unit-tested in isolation
// (scripts/test-reconcile-decision.mjs). The ROUTE enforces the claim-source
// gate (idSource/roleSource === 'claim' + role/id validation) BEFORE calling
// this, and performs the CAS write of decision.row.
//
// ADD-ONLY by construction: it never returns an edit to an existing row, so it
// can't downgrade or overwrite anyone. A missing row is added; an id already
// present is a no-op; an email already bound to a DIFFERENT id is left alone
// (a split/dangling case for an owner + the audit canary, never a duplicate).
export function reconcileSelfDecision({ users, orgUserId, email, role }) {
  const list = Array.isArray(users) ? users : [];
  if (!orgUserId || !role) return { reconciled: false, reason: 'no-claim' };
  if (list.some((u) => u.id === orgUserId)) return { reconciled: false, reason: 'present' };
  const em = (email || '').toLowerCase();
  if (em && list.some((u) => (u.email || '').toLowerCase() === em)) {
    return { reconciled: false, reason: 'email-bound' };
  }
  return {
    reconciled: true,
    reason: 'add',
    row: {
      id: orgUserId,
      email: email || null,
      name: (email || '').split('@')[0] || 'Team member',
      phone: '',
      role,
      status: 'active',
      initials: (email || '?').slice(0, 2).toUpperCase(),
    },
  };
}
