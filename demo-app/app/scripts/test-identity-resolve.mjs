// Claims-first identity resolution — the core of the 2026-08-03 lockout fix.
// resolveCurrentUserId (withSession precedence) + resolveCurrentUser
// (selectCurrentUser: claim-role override + claim-only synthesis + ref-stability).
// store/identity.js is dependency-free, so this imports it directly.
//
//   node scripts/test-identity-resolve.mjs
import { resolveCurrentUserId, resolveCurrentUser } from '../src/store/identity.js';

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1; else { fail += 1; console.error(`✖ ${n}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const ok = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`✖ ${n}`); } };

const users = [
  { id: 'u_owner', email: 'kyle@x.com', role: 'owner' },
  { id: 'u_admin', email: 'a@x.com', role: 'admin' },
  { id: 'u_lauren', email: 'lauren@x.com', role: 'crew' },
];

// ── resolveCurrentUserId (withSession precedence) ────────────────────────────
eq('claim-id present + in roster → that row', resolveCurrentUserId({ users, sessionEmail: 'a@x.com', claimOrgUserId: 'u_admin' }), 'u_admin');
eq('claim-id present, roster email renamed → still the claim-id row', resolveCurrentUserId({ users: [{ id: 'u_admin', email: 'renamed@x.com', role: 'admin' }], sessionEmail: 'a@x.com', claimOrgUserId: 'u_admin' }), 'u_admin');
eq('claim-id present but NOT in roster (David/orphan) → the claim id itself', resolveCurrentUserId({ users, sessionEmail: 'david.pepin11@x.com', claimOrgUserId: 'u_ms3' }), 'u_ms3');
eq('claim-id present, coincidental email match is IGNORED → claim id wins', resolveCurrentUserId({ users, sessionEmail: 'a@x.com', claimOrgUserId: 'u_ghost' }), 'u_ghost');
eq('no claim id, email matches (legacy login) → that row', resolveCurrentUserId({ users, sessionEmail: 'a@x.com', claimOrgUserId: null }), 'u_admin');
eq('no claim id, no email match → fallback (demo currentUserId)', resolveCurrentUserId({ users, sessionEmail: 'x@x.com', claimOrgUserId: null, fallback: 'u_demo' }), 'u_demo');
eq('no claim id, no email → fallback (user-switcher)', resolveCurrentUserId({ users, sessionEmail: null, claimOrgUserId: null, fallback: 'u_switch' }), 'u_switch');

// ── resolveCurrentUser: agree / split / synthesis / demo ─────────────────────
const idmemo = (_deps, make) => make();
const rowAdmin = users[1];
ok('agree (blob role === claim role): returns the IDENTICAL row (Object.is)',
  resolveCurrentUser({ row: rowAdmin, auth: { claimOrgUserId: 'u_admin', claimRole: 'admin', sessionEmail: 'a@x.com' }, currentUserId: 'u_admin', memo: idmemo }) === rowAdmin);

const rowLauren = users[2];
const split = resolveCurrentUser({ row: rowLauren, auth: { claimOrgUserId: 'u_lauren', claimRole: 'admin', sessionEmail: 'lauren@x.com' }, currentUserId: 'u_lauren', memo: idmemo });
eq('split (blob crew, claim admin): effective role is the CLAIM role', split.role, 'admin');
ok('split: __effectiveRole flag set', split.__effectiveRole === true);
ok('split: does NOT mutate the roster row', rowLauren.role === 'crew');

const synth = resolveCurrentUser({ row: null, auth: { claimOrgUserId: 'u_ms3', claimRole: 'admin', sessionEmail: 'david.pepin11@x.com' }, currentUserId: 'u_ms3', memo: idmemo });
ok('claim-only (no roster row): non-null user', !!synth);
eq('claim-only: id from claim', synth.id, 'u_ms3');
eq('claim-only: role from claim', synth.role, 'admin');
ok('claim-only: __fromClaim flag (drives self-heal)', synth.__fromClaim === true);
eq('claim-only: name from email local part', synth.name, 'david.pepin11');
eq('claim-only: status active', synth.status, 'active');

ok('demo (no auth): row returned by reference',
  resolveCurrentUser({ row: rowAdmin, auth: null, currentUserId: 'u_admin', memo: idmemo }) === rowAdmin);
eq('no claim, no row → null', resolveCurrentUser({ row: null, auth: null, currentUserId: null, memo: idmemo }), null);

// ── reference stability with the REAL single-slot memo ───────────────────────
let _m = null;
const realMemo = (deps, make) => {
  if (_m && _m.deps.length === deps.length && _m.deps.every((d, i) => d === deps[i])) return _m.value;
  const value = make(); _m = { deps, value }; return value;
};
const authL = { claimOrgUserId: 'u_lauren', claimRole: 'admin', sessionEmail: 'lauren@x.com' };
const s1 = resolveCurrentUser({ row: rowLauren, auth: authL, currentUserId: 'u_lauren', memo: realMemo });
const s2 = resolveCurrentUser({ row: rowLauren, auth: authL, currentUserId: 'u_lauren', memo: realMemo });
ok('memo: identical inputs → STABLE reference (no per-dispatch re-render churn)', s1 === s2);

console.log(`\ntest-identity-resolve: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
