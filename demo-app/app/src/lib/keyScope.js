// Crew key visibility — ONE rule, shared by the Keys page (pages/Keys.jsx), the scoped
// selector (store/selectors.selectVisibleKeysFor) and global search, so a crew member can
// never surface a key anywhere that the Keys page would not show them. Pure and
// import-free so node can test it (scripts/test-key-scope.mjs).
//
// Crew see keys for the companies they are ASSIGNED to (their scheduled jobs), matched by
// clientId or, for imported keys that carry a company name but no CRM link, by normalized
// company name; PLUS any key currently checked out to them (what lets them see and take a
// key at the lockbox). Everyone else sees every key. A blank name never matches, so an
// empty name is not a wildcard.

// Company-name normalization used for key matching everywhere (also by
// selectKeysForClient; mirrored in scripts/backfill-key-sites.mjs).
export const normKeyCompany = (v) => (v || '').trim().toLowerCase();

// Build the visibility predicate for `user`. `assignedClients` is the user's scoped client
// list (selectVisibleClientsFor); it is only consulted for crew.
export function makeKeyScope(user, assignedClients) {
  if (!user || user.role !== 'crew') return () => true;
  const ids = new Set((assignedClients || []).map((c) => c.id));
  const names = new Set((assignedClients || []).map((c) => normKeyCompany(c.name)).filter(Boolean));
  return (k) => {
    if (!k) return false;
    if (k.heldByUserId && k.heldByUserId === user.id) return true; // a key in your own hands
    if (k.clientId) return ids.has(k.clientId);                     // linked key: assigned company by id
    const n = normKeyCompany(k.clientName);                         // imported key: by company name
    return !!n && names.has(n);
  };
}
