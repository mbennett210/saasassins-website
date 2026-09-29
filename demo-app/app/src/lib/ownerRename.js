// Pure owner-record correction for the v53 → v54 store migration.
//
// The seed's Super Admin was renamed Marcus Alvarez → Matt Giunco (S35), but that
// shipped as a plain seed edit with NO migration — so any browser seeded before it
// keeps surfacing "Marcus Alvarez" as the owner forever (persist's loadStateInner
// returns a v53 blob as-is). This corrects the owner record BY STABLE ID, mirroring the
// Heather rename (v35/v36). Kept dependency-free — like collapseToSingleLocationV53 in
// lib/location.js — so persist.js's migration hop AND its regression test can both use
// it without importing the whole persist module graph (the brand's identity has no imports).
import { IDENTITY } from '../brand/identity.generated.js';

// The seeded Super Admin's stable id (seedId('u', 'kyler') === 'u_seed_kyler').
export const RENAMED_OWNER_ID = 'u_seed_kyler';

// The current seed identity for that record: the brand's signatory, whom data/seed.js seeds as the
// u_seed_kyler user (UI_RULES §129). Read from the brand like the seed, so a re-branded build corrects a
// stale owner to its own and never to the previous client's.
const { name, initials, email } = IDENTITY.company.signatory;
export const CORRECTED_OWNER = { name, initials, email };

// Force-correct the Super Admin's identity fields by id; every other user (including
// client-added ones) is left untouched. Idempotent: an already-correct record is a
// no-op. Pure — returns a new array, never mutates the input.
export function correctOwnerIdentity(users) {
  return (users || []).map((u) =>
    u && u.id === RENAMED_OWNER_ID ? { ...u, ...CORRECTED_OWNER } : u
  );
}
