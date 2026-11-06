// The financials.view permission key (pure). Asserts against the source-of-truth vocabulary
// in lib/roles.js (never a restated literal): the key exists with the FINANCIALS default
// (owner + manager, admin excluded), sits in exactly one PERM_GROUP, is not ALWAYS_GRANTED,
// and resolves as designed through can() — a manager holds it, an admin and crew do not, a
// per-user grant lets a crew member hold it. This mirrors the server twin's gate
// (requirePermission('financials.view') in api/quickbooks/[...path].js, exercised by
// test-qbo-route.mjs).
//
//   node scripts/test-qbo-permission.mjs
import { PERMISSIONS, PERM_GROUPS, ALWAYS_GRANTED, can } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const KEY = 'financials.view';
const def = PERMISSIONS[KEY];
ok('financials.view is defined in PERMISSIONS', !!def, 'missing');
ok('financials.view has a label', typeof def?.label === 'string' && def.label.length > 0, def?.label);
ok('financials.view default roles are exactly [owner, manager] (financials pattern, admin excluded)',
  JSON.stringify(def?.defaultRoles) === JSON.stringify(['owner', 'manager']), JSON.stringify(def?.defaultRoles));
ok('financials.view is NOT always-granted (it is revocable)', !ALWAYS_GRANTED.has(KEY));

const groups = PERM_GROUPS.filter((g) => g.keys.includes(KEY));
ok('financials.view sits in EXACTLY ONE PERM_GROUP', groups.length === 1, `in ${groups.length} groups`);

// Resolution through can() with the DEFAULT (no live matrix, no overrides): the schema
// defaultRoles apply, so new keys work on existing state with no store bump.
const holds = (role, overrides = []) => can({ id: `u_${role}`, role }, KEY, null, overrides);
ok('owner holds financials.view', holds('owner') === true);
ok('manager holds financials.view', holds('manager') === true);
ok('admin does NOT hold financials.view by default', holds('admin') === false);
ok('crew does NOT hold financials.view by default', holds('crew') === false);
ok('a per-user grant lets a crew member hold financials.view',
  can({ id: 'u_c', role: 'crew' }, KEY, null, [{ userId: 'u_c', grants: [KEY], revokes: [] }]) === true);
ok('a per-user revoke removes it from a manager',
  can({ id: 'u_m', role: 'manager' }, KEY, null, [{ userId: 'u_m', grants: [], revokes: [KEY] }]) === false);

console.log(`\nqbo-permission: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
