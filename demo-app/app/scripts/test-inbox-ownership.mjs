// Per-mailbox ownership for connected inboxes — CS-017 (AUTHORIZATION_AUDIT §2026-07-20 #2).
//
// /api/inbox/:id/send and /test were requireAuth-only, so any authenticated user could send
// arbitrary mail out of ANY connected mailbox — including a manager's real Gmail. A role gate
// was not available: `messaging.use` is ALWAYS_GRANTED and Messaging.jsx calls these routes.
//
// ── WHAT THIS FILE USED TO PIN, AND WHY IT FLIPPED ────────────────────────────────────
// It asserted that the gate was INERT: "column absent -> allow", "unclaimed -> allow",
// "NO input combination denies while the column is absent (32 cases)". That was the
// deliberate design while the migration was unapplied — and CS-017 is the finding that the
// sum of those allowances was a gate which enforced nothing, in front of a route that puts
// real mail on the wire from a real mailbox.
//
// It now FAILS CLOSED, and this file pins the opposite table. Safe to flip because
// inbox_accounts held 0 rows on 2026-09-25 (CS-116, L2 verified) — there is no live mailbox
// to lock out — and every mailbox connected from here on is stamped with its connector's
// u_* id at the OAuth callback, so "unclaimed" is no longer a state a real mailbox reaches.
//
//   node scripts/test-inbox-ownership.mjs
import { ownershipVerdict } from '../api/_lib/inboxOwnership.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const ME = 'u_me';
const THEM = 'u_them';
const v = (o) => ownershipVerdict(o);

// ── 🔴 the three allowances that WERE the hole ────────────────────────────────────
ok('column absent -> DENY', !v({ columnPresent: false }).allow);
ok('  ...reason names the cause', v({ columnPresent: false }).reason === 'not-provisioned');
ok('column absent -> DENY even for a matching owner',
  !v({ columnPresent: false, ownerUserId: ME, orgUserId: ME, rowFound: true }).allow);
ok('claimed by nobody -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId: ME }).allow);
ok('  ...reason is unclaimed', v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId: ME }).reason === 'unclaimed');
ok('empty-string owner counts as unclaimed and DENIES',
  !v({ columnPresent: true, rowFound: true, ownerUserId: '', orgUserId: ME }).allow);

// ── the headline denial ───────────────────────────────────────────────────────────
const denied = v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: ME });
ok('a claimed mailbox REFUSES a different user', !denied.allow);
ok('  ...with a reason of not-owner', denied.reason === 'not-owner');
ok('the owner themselves is allowed', v({ columnPresent: true, rowFound: true, ownerUserId: ME, orgUserId: ME }).allow);
ok('  ...with a reason of owner', v({ columnPresent: true, rowFound: true, ownerUserId: ME, orgUserId: ME }).reason === 'owner');

// A claimed mailbox with an unidentifiable caller must DENY, not fall through.
// resolveAuthority can return orgUserId: null for a login with no claim and no blob row.
ok('claimed + caller has no org id -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: null }).allow);
ok('  ...reason is no-identity', v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: null }).reason === 'no-identity');
ok('claimed + caller org id undefined -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: undefined }).allow);
ok('claimed + caller org id empty string -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: '' }).allow);

// ── no accidental matches ─────────────────────────────────────────────────────────
// Ownership is an exact string identity. Anything looser is a bypass primitive.
ok('a prefix of the owner id does not match', !v({ columnPresent: true, rowFound: true, ownerUserId: 'u_me_extra', orgUserId: ME }).allow);
ok('a suffix of the owner id does not match', !v({ columnPresent: true, rowFound: true, ownerUserId: 'x_u_me', orgUserId: ME }).allow);
ok('case differences do not match', !v({ columnPresent: true, rowFound: true, ownerUserId: 'U_ME', orgUserId: ME }).allow);
ok('whitespace padding does not match', !v({ columnPresent: true, rowFound: true, ownerUserId: ' u_me', orgUserId: ME }).allow);

// ── missing row: the ONE remaining allowance, and it is not a hole ────────────────
// There is no mailbox to act on, and performSend's "Connected inbox not found" is a far
// more useful answer than a blanket 403.
ok('missing row -> allow (performSend reports it)', v({ columnPresent: true, rowFound: false, orgUserId: ME }).allow);
ok('  ...reason is row-missing', v({ columnPresent: true, rowFound: false, orgUserId: ME }).reason === 'row-missing');

// ── the default is DENY ──────────────────────────────────────────────────────────
ok('a wholly empty verdict input DENIES', !v({}).allow);
ok('an undefined-ish input DENIES', !v({ columnPresent: undefined, ownerUserId: undefined, orgUserId: undefined }).allow);

// Enumerate the decision table: with the column absent, NOTHING allows.
let anyAllowWhileAbsent = false;
for (const ownerUserId of [null, '', ME, THEM]) {
  for (const orgUserId of [null, '', ME, THEM]) {
    for (const rowFound of [true, false]) {
      if (v({ columnPresent: false, ownerUserId, orgUserId, rowFound }).allow) anyAllowWhileAbsent = true;
    }
  }
}
ok('NO input combination allows while the column is absent (32 cases)', !anyAllowWhileAbsent);

// And with it present, an unclaimed row allows NOBODY.
let allowedUnclaimed = false;
for (const orgUserId of [null, '', ME, THEM]) {
  if (v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId }).allow) allowedUnclaimed = true;
}
ok('NO caller is allowed on an unclaimed row', !allowedUnclaimed);

// The ONLY allowing combinations on an existing row: the exact owner.
const allowedRows = [];
for (const ownerUserId of [null, '', ME, THEM]) {
  for (const orgUserId of [null, '', ME, THEM]) {
    if (v({ columnPresent: true, rowFound: true, ownerUserId, orgUserId }).allow) allowedRows.push(`${ownerUserId}/${orgUserId}`);
  }
}
ok('exactly two allowing pairs on a found row, both owner==caller',
  allowedRows.length === 2 && allowedRows.every((p) => { const [a, b] = p.split('/'); return a === b && a !== ''; }));

console.log(`\ninbox ownership (CS-017, fail-closed): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
