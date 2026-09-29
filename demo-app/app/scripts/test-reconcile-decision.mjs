// The orphan self-heal decision (api/_lib/reconcile.js): add-only + never
// duplicate. The route enforces the claim-source gate before calling this; here
// we pin the pure roster logic.
//
//   node scripts/test-reconcile-decision.mjs
import { reconcileSelfDecision } from '../api/_lib/reconcile.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`✖ ${n}`); } };

const roster = [
  { id: 'u_a', email: 'a@x.com', role: 'admin' },
  { id: 'u_c', email: 'c@x.com', role: 'crew' },
];

// David: absent by BOTH id and email → materialize the row
const d = reconcileSelfDecision({ users: roster, orgUserId: 'u_ms3', email: 'david.pepin11@x.com', role: 'admin' });
ok('orphan (absent by id + email) → reconciled add', d.reconciled === true && d.reason === 'add');
ok('added row carries claim id/role/status', d.row?.id === 'u_ms3' && d.row?.role === 'admin' && d.row?.status === 'active');
ok('added row name from email local part', d.row?.name === 'david.pepin11');

// already present by id → no-op, no row (ADD-ONLY, never edits)
const present = reconcileSelfDecision({ users: roster, orgUserId: 'u_a', email: 'a@x.com', role: 'admin' });
ok('id already present → no-op', present.reconciled === false && present.reason === 'present');
ok('present case returns NO row (can never edit/downgrade an existing member)', present.row === undefined);

// email bound to a DIFFERENT id → no-op (never duplicate an identity)
const bound = reconcileSelfDecision({ users: roster, orgUserId: 'u_new', email: 'a@x.com', role: 'admin' });
ok('email bound to another id → no-op (no duplicate row)', bound.reconciled === false && bound.reason === 'email-bound');

// missing claim fields → no-op
ok('no orgUserId → no-claim no-op', reconcileSelfDecision({ users: roster, orgUserId: null, email: 'x@x.com', role: 'admin' }).reason === 'no-claim');
ok('no role → no-claim no-op', reconcileSelfDecision({ users: roster, orgUserId: 'u_z', email: 'z@x.com', role: null }).reason === 'no-claim');

// empty roster → add
ok('empty roster → add', reconcileSelfDecision({ users: [], orgUserId: 'u_first', email: 'f@x.com', role: 'owner' }).reconciled === true);

console.log(`\ntest-reconcile-decision: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
