// Permission-settings alignment: the general editor (Settings → Roles) and the
// per-member editor (Team → member → Permission overrides) must present the SAME set
// of editable permissions.
//
//   - TeamDetail.jsx iterates Object.keys(PERMISSIONS) minus ALWAYS_GRANTED (every
//     editable key, always current by construction).
//   - Roles.jsx renders lib/roles.js PERM_GROUPS, then a defensive "Other" catch-all
//     for any leftover store key.
//
// The bug this pins (2026-09-16): reviews.manage and drafts.view were real permissions
// with NO group, so the general editor dumped them into the unlabeled "Other" bucket
// while the per-member editor showed them inline — the two surfaces disagreed. The fix
// gave every editable key a home. This test fails the instant that regresses, so a new
// permission key can never again ship without a section (which would desync the two UIs
// and hide a real permission under "Other").
//
//   node scripts/test-permission-groups.mjs
import { PERMISSIONS, ALWAYS_GRANTED, PERM_GROUPS } from '../src/lib/roles.js';

let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const editableKeys = Object.keys(PERMISSIONS).filter((k) => !ALWAYS_GRANTED.has(k));
const groupedKeys = PERM_GROUPS.flatMap((g) => g.keys);
const groupedSet = new Set(groupedKeys);

// 1. Every editable permission has exactly one home in PERM_GROUPS. This is THE
//    alignment guarantee: the general editor's rendered set == the per-member editor's.
for (const key of editableKeys) {
  const homes = PERM_GROUPS.filter((g) => g.keys.includes(key)).length;
  ok(`🔴 '${key}' has exactly one group (found ${homes}) — else it desyncs the two editors / lands in "Other"`, homes === 1);
}

// 2. No group references a key PERMISSIONS doesn't define (a dead/renamed key).
for (const key of groupedKeys) {
  ok(`group key '${key}' exists in PERMISSIONS`, key in PERMISSIONS);
}

// 3. ALWAYS_GRANTED (universal, non-toggleable) keys are never grouped — both editors
//    filter them out, so grouping one would render an inert toggle.
for (const key of ALWAYS_GRANTED) {
  ok(`ALWAYS_GRANTED '${key}' is not listed in any group`, !groupedSet.has(key));
}

// 4. No key is grouped twice (across sections), and group ids are unique.
ok('no permission key appears in more than one group', groupedKeys.length === groupedSet.size);
const ids = PERM_GROUPS.map((g) => g.id);
ok('group ids are unique', ids.length === new Set(ids).size);

// 5. The rendered set matches exactly — nothing grouped that isn't editable, nothing
//    editable that isn't grouped. Set equality, stated directly.
const editableSet = new Set(editableKeys);
const groupedNotEditable = [...groupedSet].filter((k) => !editableSet.has(k));
const editableNotGrouped = editableKeys.filter((k) => !groupedSet.has(k));
ok(`no grouped key is non-editable (${groupedNotEditable.join(', ') || 'ok'})`, groupedNotEditable.length === 0);
ok(`🔴 every editable key is grouped (missing: ${editableNotGrouped.join(', ') || 'none'})`, editableNotGrouped.length === 0);

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\npermission-group alignment: ${pass}/${pass} passed (${editableKeys.length} editable keys, ${PERM_GROUPS.length} sections)`);
