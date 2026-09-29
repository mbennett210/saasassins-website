// Regression: the Super Admin persona rename (Marcus Alvarez → Matt Giunco, S35) must
// reach browsers that were seeded BEFORE it. That rename shipped as a plain seed edit
// with NO migration, so a persisted v53 blob kept surfacing "Marcus Alvarez" as the
// owner forever (loadStateInner returns a v53 blob as-is). The v53 → v54 hop
// (persist.js migrateV53toV54) delegates to correctOwnerIdentity, which force-corrects
// the owner BY STABLE ID — mirroring the Heather v35/v36 fix. Pre-fix (no helper) this
// file cannot import the function and fails; post-fix it passes.
//   node scripts/test-owner-rename-migration.mjs
//
// (The hop's wiring — version bump + chain runner invoking it + fast-path accepting the
// new version — is asserted separately by test-persist-chain.mjs.)
import { correctOwnerIdentity, RENAMED_OWNER_ID, CORRECTED_OWNER } from '../src/lib/ownerRename.js';
import { IDENTITY } from '../src/brand/identity.generated.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

eq('owner id is the seeded Super Admin', RENAMED_OWNER_ID, 'u_seed_kyler');
// the seed's owner is the brand's signatory (UI_RULES §129); test-name-ledger proves the same under another brand
const S = IDENTITY.company.signatory;
eq('corrected identity matches the current seed (the brand\'s signatory)', CORRECTED_OWNER, { name: S.name, initials: S.initials, email: S.email });
eq('the initials are the first and last names\' first letters', S.initials, (S.name.split(' ')[0][0] + S.name.split(' ').slice(-1)[0][0]).toUpperCase());

// The owner identity a pre-S35 browser persisted, plus another owner and a client-added user.
const staleUsers = [
  { id: 'u_seed_kyler', name: 'Marcus Alvarez', initials: 'MA', email: 'marcus@cleanspaceonline.com', role: 'owner', status: 'active' },
  { id: 'u_seed_steve', name: 'Dana Cole', initials: 'DC', email: 'dana@cleanspaceonline.com', role: 'owner', status: 'active' },
  { id: 'u_added_123', name: 'Client Added', initials: 'CA', email: 'ca@example.com', role: 'crew', status: 'active' },
];

const out = correctOwnerIdentity(staleUsers);
const owner = out.find((u) => u.id === 'u_seed_kyler');
eq('owner name corrected to the signatory', owner.name, S.name);
eq('owner initials corrected', owner.initials, S.initials);
eq('owner email corrected', owner.email, S.email);
eq('owner role preserved', owner.role, 'owner');
eq('owner status preserved', owner.status, 'active');
eq('other seed owner untouched', out.find((u) => u.id === 'u_seed_steve').name, 'Dana Cole');
eq('client-added user untouched', out.find((u) => u.id === 'u_added_123').name, 'Client Added');
eq('input not mutated', staleUsers[0].name, 'Marcus Alvarez');

// Idempotent: an already-correct roster is a no-op.
eq('idempotent — an already-correct owner stays', correctOwnerIdentity(out).find((u) => u.id === 'u_seed_kyler').name, S.name);

// Degenerate inputs never throw.
eq('undefined → []', correctOwnerIdentity(undefined), []);
eq('empty → []', correctOwnerIdentity([]), []);

console.log(`\nowner-rename migration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
