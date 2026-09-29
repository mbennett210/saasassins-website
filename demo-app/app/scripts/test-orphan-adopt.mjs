// Offline tests for the orphan-login rules in api/_lib/users.js.
//
// The state under test: adding a member is two non-atomic writes — the Supabase
// login (server-side, durable) then the roster row (into the CAS-contended
// org_state blob). Lose the second and the login exists with nobody on Settings
// → Team. Confirmed live 2026-07-27 (david.pepin11@gmail.com, claim
// u_ms3k8t4oiup4y/admin, zero references in the blob). Re-inviting used to hit
// auth.admin.createUser's already-registered rejection and dead-end there.
//
// The rule that must never regress: an adopt binds the roster row to the org
// user id ALREADY IN THE CLAIM. Every server gate (labor, QC attribution, push
// delivery, site assignment) resolves identity through that claim, so minting a
// fresh u_* strands whatever the old id references.
//
//   node scripts/test-orphan-adopt.mjs
import { resolveAdoption, pickOrphanLogins } from '../api/_lib/users.js';
import { bindRosterId } from '../src/lib/teamApi.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; } else { fail += 1; console.log(`  ✗ ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
};
const ok = (label, cond) => { if (cond) { pass += 1; } else { fail += 1; console.log(`  ✗ ${label}`); } };

// ── resolveAdoption ────────────────────────────────────────────────────────
console.log('resolveAdoption — duplicate vs orphan');
{
  const r = resolveAdoption({ claimedOrgUserId: 'u_abc', rosterRow: { id: 'u_abc', email: 'a@b.c' }, mintedOrgUserId: 'u_new' });
  eq('a login WITH a roster row is a real duplicate → reject', r.action, 'reject');
  eq('  and binds nothing', r.boundId, null);
}
{
  const r = resolveAdoption({ claimedOrgUserId: 'u_ms3k8t4oiup4y', rosterRow: null, mintedOrgUserId: 'u_freshlyminted' });
  eq('a login with NO roster row is an orphan → adopt', r.action, 'adopt');
  eq('  bound to the CLAIMED id, never the minted one', r.boundId, 'u_ms3k8t4oiup4y');
  eq('  and says so', r.source, 'claim');
}

console.log('resolveAdoption — accounts that carry no usable claim');
for (const [label, claimed] of [
  ['no claim at all (created by hand in the dashboard)', undefined],
  ['null claim', null],
  ['empty-string claim (falsy — would silently mean "unstamped")', ''],
  ['malformed claim (missing the u_ prefix)', 'ms3k8t4oiup4y'],
  ['wrong type', 12345],
  ['prefix only, no id body', 'u_'],
]) {
  const r = resolveAdoption({ claimedOrgUserId: claimed, rosterRow: null, mintedOrgUserId: 'u_minted1' });
  eq(`${label} → falls back to the minted id`, r.boundId, 'u_minted1');
  eq(`  ${label} → source reported as minted`, r.source, 'minted');
}
{
  const r = resolveAdoption({ claimedOrgUserId: null, rosterRow: null, mintedOrgUserId: undefined });
  eq('no claim AND no minted id → adopt with a null binding (caller stamps nothing)', r.boundId, null);
}
{
  const r = resolveAdoption();
  eq('called with nothing → adopt, not a crash', r.action, 'adopt');
}

// ── pickOrphanLogins ───────────────────────────────────────────────────────
console.log('pickOrphanLogins');
const roster = [
  { id: 'u_kyle', name: 'Kyle Boyden', email: 'kyle@example.com' },
  { id: 'u_liz', name: 'Liz Garcia', email: '  LIZ@Example.com  ' }, // hand-edited: caps + spaces
  { id: 'u_v', name: 'Veronica', email: 'veronica@example.com' },    // roster row with NO login
];
const authUsers = [
  { email: 'kyle@example.com', app_metadata: { role: 'owner', org_user_id: 'u_kyle' }, created_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-07-20T05:47:00Z' },
  { email: 'Liz@example.COM', app_metadata: { role: 'admin', org_user_id: 'u_liz' }, created_at: '2026-07-06T17:12:40Z', last_sign_in_at: '2026-07-06T17:27:00Z' },
  { email: 'david.pepin11@gmail.com', app_metadata: { role: 'admin', org_user_id: 'u_ms3k8t4oiup4y' }, created_at: '2026-07-27T18:28:37Z', last_sign_in_at: null },
  { email: 'anna@example.com', app_metadata: {}, created_at: '2026-07-28T00:00:00Z', last_sign_in_at: null },
  { email: '', app_metadata: {}, created_at: '2026-07-28T00:00:00Z' }, // phone-only account
];
const orphans = pickOrphanLogins(authUsers, roster);
eq('finds exactly the two logins with no roster row', orphans.map((o) => o.email), ['anna@example.com', 'david.pepin11@gmail.com']);
eq('  sorted by email', orphans.map((o) => o.email), [...orphans.map((o) => o.email)].sort());
ok('  case/whitespace mismatch is NOT an orphan (Liz)', !orphans.some((o) => /liz/i.test(o.email)));
ok('  a roster row with no login is NOT reported (Veronica)', !orphans.some((o) => /veronica/i.test(o.email)));
ok('  an account with no email is skipped', !orphans.some((o) => !o.email));

const pepin = orphans.find((o) => o.email === 'david.pepin11@gmail.com');
eq('carries the claimed role', pepin.role, 'admin');
eq('carries the claimed org user id', pepin.orgUserId, 'u_ms3k8t4oiup4y');
eq('carries created_at (so the banner can say when)', pepin.createdAt, '2026-07-27T18:28:37Z');
eq('never-signed-in is null, not undefined', pepin.lastSignInAt, null);

const anna = orphans.find((o) => o.email === 'anna@example.com');
eq('an unstamped account reports role null rather than guessing', anna.role, null);
eq('an unstamped account reports orgUserId null', anna.orgUserId, null);

eq('empty inputs are safe', pickOrphanLogins(), []);
eq('no roster at all → every login is an orphan', pickOrphanLogins([{ email: 'x@y.z', app_metadata: {} }], []).length, 1);
eq('a roster row with a blank email never swallows a real login',
  pickOrphanLogins([{ email: 'x@y.z', app_metadata: {} }], [{ id: 'u_1', email: '' }]).length, 1);

// ── bindRosterId: the client half of the same rule ─────────────────────────
console.log('bindRosterId — the server\'s id wins');
eq('adopt response → the CLAIMED id, not the minted one',
  bindRosterId({ adopted: true, orgUserId: 'u_ms3k8t4oiup4y' }, 'u_minted'), 'u_ms3k8t4oiup4y');
eq('ordinary create echoing the minted id → that id',
  bindRosterId({ adopted: false, orgUserId: 'u_minted' }, 'u_minted'), 'u_minted');
eq('server omits orgUserId (older deploy) → fall back to minted',
  bindRosterId({ adopted: false }, 'u_minted'), 'u_minted');
eq('server returns null → fall back to minted',
  bindRosterId({ orgUserId: null }, 'u_minted'), 'u_minted');
eq('server returns "" → fall back rather than binding an empty id',
  bindRosterId({ orgUserId: '' }, 'u_minted'), 'u_minted');
eq('non-string id is never bound', bindRosterId({ orgUserId: 42 }, 'u_minted'), 'u_minted');
eq('stub mode (no result at all) → minted', bindRosterId(undefined, 'u_minted'), 'u_minted');

// ── round trip: the live incident, end to end ──────────────────────────────
console.log('the 2026-07-27 incident, replayed');
{
  const found = pickOrphanLogins(authUsers, roster).find((o) => o.email === 'david.pepin11@gmail.com');
  ok('detected as an orphan', !!found);
  const plan = resolveAdoption({ claimedOrgUserId: found.orgUserId, rosterRow: null, mintedOrgUserId: 'u_whatever' });
  eq('re-inviting adopts rather than rejecting', plan.action, 'adopt');
  eq('and rebuilds him on his ORIGINAL identity', plan.boundId, 'u_ms3k8t4oiup4y');
  // Second invite, now that the roster row exists → must refuse.
  const after = [...roster, { id: plan.boundId, name: 'David Pepin', email: 'david.pepin11@gmail.com' }];
  ok('after the fix he is no longer listed as an orphan', !pickOrphanLogins(authUsers, after).some((o) => /pepin/i.test(o.email)));
  const again = resolveAdoption({ claimedOrgUserId: found.orgUserId, rosterRow: after[after.length - 1], mintedOrgUserId: 'u_whatever' });
  eq('and inviting him a THIRD time is refused as a duplicate', again.action, 'reject');
}

console.log(`\n${pass}/${pass + fail} assertions passed.`);
process.exit(fail ? 1 : 0);
