// Per-mailbox ownership for connected inboxes — AUTHORIZATION_AUDIT.md §2026-07-20 #2.
//
// /api/inbox/:id/send and /test were requireAuth-only, so any authenticated user
// could send arbitrary mail out of ANY connected mailbox — including a manager's real
// Gmail, from the company's real domain. A role gate was not available:
// `messaging.use` is ALWAYS_GRANTED and Messaging.jsx calls these routes, so gating
// on owner/admin is an outage for 37 crew.
//
// The gate must be INERT on today's schema (the migration is unapplied) and inert per
// unclaimed row. These tests pin exactly that: the decision table's default is ALLOW,
// and it only ever denies for a row someone has explicitly claimed.
//
//   node scripts/test-inbox-ownership.mjs
import { ownershipVerdict } from '../api/_lib/inboxOwnership.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const ME = 'u_me';
const THEM = 'u_them';
const v = (o) => ownershipVerdict(o);

// ── LAYER 1: inert while the migration is unapplied ───────────────────────
// This is the loop-rule requirement: code written against un-applied DDL must not
// change behaviour. Today's schema has no owner_user_id, so everything allows.
ok('column absent -> allow', v({ columnPresent: false }).allow);
ok('column absent -> allow even with a mismatched owner', v({ columnPresent: false, ownerUserId: THEM, orgUserId: ME, rowFound: true }).allow);
ok('column absent -> reason names the cause', v({ columnPresent: false }).reason === 'column-absent');

// ── LAYER 2: inert per unclaimed row ──────────────────────────────────────
// A GLOBAL "is it initialized" flag would flip the moment one row got an owner and
// start denying every still-unclaimed mailbox. Per-row is why that cannot happen.
ok('claimed by nobody -> allow (pre-#2 behaviour)', v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId: ME }).allow);
ok('  ...reason is unclaimed', v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId: ME }).reason === 'unclaimed');
ok('empty-string owner counts as unclaimed', v({ columnPresent: true, rowFound: true, ownerUserId: '', orgUserId: ME }).allow);
ok('one row being claimed does not affect another (function is per-row)',
  v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId: ME }).allow
  && !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: ME }).allow);

// ── THE headline denial ───────────────────────────────────────────────────
const denied = v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: ME });
ok('a claimed mailbox REFUSES a different user', !denied.allow);
ok('  ...with a reason of not-owner', denied.reason === 'not-owner');
ok('the owner themselves is allowed', v({ columnPresent: true, rowFound: true, ownerUserId: ME, orgUserId: ME }).allow);
ok('  ...with a reason of owner', v({ columnPresent: true, rowFound: true, ownerUserId: ME, orgUserId: ME }).reason === 'owner');

// A claimed mailbox with an unidentifiable caller must DENY, not fall through.
// resolveAuthority can return orgUserId: null for a login with no claim and no blob
// row; treating that as "allowed" would be a free bypass on every claimed mailbox.
ok('claimed + caller has no org id -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: null }).allow);
ok('  ...reason is no-identity', v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: null }).reason === 'no-identity');
ok('claimed + caller org id undefined -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: undefined }).allow);
ok('claimed + caller org id empty string -> DENY', !v({ columnPresent: true, rowFound: true, ownerUserId: THEM, orgUserId: '' }).allow);

// ── no accidental matches ─────────────────────────────────────────────────
// Ownership is an exact string identity. Anything looser is a bypass primitive.
ok('a prefix of the owner id does not match', !v({ columnPresent: true, rowFound: true, ownerUserId: 'u_me_extra', orgUserId: ME }).allow);
ok('a suffix of the owner id does not match', !v({ columnPresent: true, rowFound: true, ownerUserId: 'x_u_me', orgUserId: ME }).allow);
ok('case differences do not match', !v({ columnPresent: true, rowFound: true, ownerUserId: 'U_ME', orgUserId: ME }).allow);
ok('whitespace padding does not match', !v({ columnPresent: true, rowFound: true, ownerUserId: ' u_me', orgUserId: ME }).allow);

// ── missing row ───────────────────────────────────────────────────────────
// Not a security decision: performSend produces a far more useful error for a
// nonexistent mailbox than a blanket 403 would, and there is nothing to protect.
ok('missing row -> allow (performSend reports it)', v({ columnPresent: true, rowFound: false, orgUserId: ME }).allow);
ok('  ...reason is row-missing', v({ columnPresent: true, rowFound: false, orgUserId: ME }).reason === 'row-missing');

// ── the default is ALLOW ──────────────────────────────────────────────────
// Stated as a test because it is the property the loop rules require: on today's
// schema this module cannot deny anything.
ok('a wholly empty verdict input allows', v({}).allow);
ok('an undefined-ish input allows', v({ columnPresent: undefined, ownerUserId: undefined, orgUserId: undefined }).allow);

// Enumerate the decision table: with the column absent, NO combination denies.
let anyDenyWhileAbsent = false;
for (const ownerUserId of [null, '', ME, THEM]) {
  for (const orgUserId of [null, '', ME, THEM]) {
    for (const rowFound of [true, false]) {
      if (!v({ columnPresent: false, ownerUserId, orgUserId, rowFound }).allow) anyDenyWhileAbsent = true;
    }
  }
}
ok('NO input combination denies while the column is absent (32 cases)', !anyDenyWhileAbsent);

// And with it present, the only denials are for a claimed row.
let deniedUnclaimed = false;
for (const orgUserId of [null, '', ME, THEM]) {
  if (!v({ columnPresent: true, rowFound: true, ownerUserId: null, orgUserId }).allow) deniedUnclaimed = true;
}
ok('NO input combination denies an unclaimed row', !deniedUnclaimed);

console.log(`\ninbox ownership: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
