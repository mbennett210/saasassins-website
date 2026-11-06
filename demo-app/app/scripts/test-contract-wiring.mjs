// The SEAMS contract tracking hangs off (CON-1..CON-14, CS-194). Deliberately imports ONLY
// modules that existed BEFORE this change — roles, the activity-log vocabulary, the
// notification catalog, the nav model and the search registry — so every check here fails on
// the pre-fix tree with a WRONG-BEHAVIOUR assertion rather than a missing file (THE LAW II.3).
// The new module's own rules are pinned by test-contracts.mjs, and the routes by
// test-contracts-route.mjs.
//
// Pure + offline: nothing here touches a network, a database or the DOM.
//
//   node app/scripts/test-contract-wiring.mjs
import assert from 'node:assert/strict';
import * as roles from '../src/lib/roles.js';
import * as activityLog from '../src/lib/activityLog.js';
import * as notifications from '../src/lib/notifications.js';
import { NAV, navLeaves, visible } from '../src/lib/navData.js';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, fn) — this file's own convention, declared here so a reader never
// has to guess (the repo's suites disagree; a swapped call "passes" on a truthy label).
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

const user = (role, id = 'u1') => ({ id, role });
const holds = (role, key) => roles.can(user(role), key, null, null);

console.log('\n── CON permissions: contracts.view / contracts.edit ──');

ok('contracts.view is a declared permission key', () => {
  assert.ok(roles.PERMISSIONS['contracts.view'], 'PERMISSIONS must declare contracts.view');
  assert.equal(typeof roles.PERMISSIONS['contracts.view'].label, 'string');
});
ok('contracts.edit is a declared permission key', () => {
  assert.ok(roles.PERMISSIONS['contracts.edit'], 'PERMISSIONS must declare contracts.edit');
});
ok('owner / admin / manager hold contracts.view by default', () => {
  for (const r of ['owner', 'admin', 'manager']) assert.equal(holds(r, 'contracts.view'), true, `${r} should hold contracts.view`);
});
ok('owner / admin / manager hold contracts.edit by default', () => {
  for (const r of ['owner', 'admin', 'manager']) assert.equal(holds(r, 'contracts.edit'), true, `${r} should hold contracts.edit`);
});
ok('CREW never hold either key — a cleaner has no business in the contract book', () => {
  assert.equal(holds('crew', 'contracts.view'), false);
  assert.equal(holds('crew', 'contracts.edit'), false);
});
ok('a SUPPLY MANAGER (S131) holds neither by default — their keys are the supply ones', () => {
  assert.equal(holds('supply_manager', 'contracts.view'), false);
  assert.equal(holds('supply_manager', 'contracts.edit'), false);
});
ok('both keys live in exactly one PERM_GROUP, so Settings → Roles shows them', () => {
  for (const key of ['contracts.view', 'contracts.edit']) {
    const homes = roles.PERM_GROUPS.filter((g) => g.keys.includes(key));
    assert.equal(homes.length, 1, `${key} must appear in exactly one group (found ${homes.length})`);
  }
});
ok('seedPermissions() carries both keys into a fresh org matrix', () => {
  const seeded = roles.seedPermissions();
  for (const key of ['contracts.view', 'contracts.edit']) {
    assert.ok(seeded.some((p) => p.id === key), `${key} missing from seedPermissions()`);
  }
});

console.log('\n── CON activity log: created / edited / deleted, with money before+after ──');

ok('the three contract actions are in the vocabulary', () => {
  for (const a of ['contract.created', 'contract.edited', 'contract.deleted']) {
    assert.equal(activityLog.isKnownAction(a), true, `${a} must be a known action`);
  }
});
ok('all three are MONEY actions — an admin must not read contract value (LOG-4)', () => {
  for (const a of ['contract.created', 'contract.edited', 'contract.deleted']) {
    assert.equal(activityLog.isMoneyAction(a), true, `${a} must carry money: true`);
  }
  // Derived, never a restated list — so the admin filter picks them up automatically.
  for (const a of ['contract.created', 'contract.edited', 'contract.deleted']) {
    assert.ok(activityLog.MONEY_ACTIONS.includes(a), `${a} missing from MONEY_ACTIONS`);
  }
});
ok('their group is a real ACTION_GROUP, so the Reports "Action type" filter can select them', () => {
  const group = activityLog.ACTIONS['contract.created'].group;
  const g = activityLog.ACTION_GROUPS.find((x) => x.id === group);
  assert.ok(g, `ACTION_GROUPS must contain "${group}"`);
  assert.deepEqual(
    g.actions.filter((a) => a.startsWith('contract.')).sort(),
    ['contract.created', 'contract.deleted', 'contract.edited'],
  );
});
ok('they are NOT automatic — a person signs a contract', () => {
  for (const a of ['contract.created', 'contract.edited', 'contract.deleted']) {
    assert.equal(activityLog.isAutoAction(a), false, `${a} must not be an auto action`);
  }
});

console.log('\n── CON-6..9 reminder bell: the notification event exists and is office-only ──');

ok('contractReminder is in the notification catalog', () => {
  const item = notifications.NOTIFICATION_GROUPS
    .flatMap((g) => g.items).find((i) => i.key === 'contractReminder');
  assert.ok(item, 'NOTIFICATION_GROUPS must carry a contractReminder toggle');
  assert.equal(typeof item.label, 'string');
});
ok('it is visible to the office and gated on contracts.view', () => {
  const perms = roles.seedPermissions();
  for (const r of ['owner', 'admin', 'manager']) {
    assert.equal(
      notifications.isNotificationVisibleForUser('contractReminder', user(r, `u_${r}`), perms, []),
      true, `${r} should see the contractReminder toggle`,
    );
  }
});
ok('a cleaner never receives one (no contracts.view, so the visibility gate refuses)', () => {
  const perms = roles.seedPermissions();
  assert.equal(
    notifications.isNotificationVisibleForUser('contractReminder', user('crew', 'u_crew'), perms, []),
    false,
  );
});
ok('nor does a supply manager (S131): the same visibility gate', () => {
  const perms = roles.seedPermissions();
  assert.equal(
    notifications.isNotificationVisibleForUser('contractReminder', user('supply_manager', 'u_sm'), perms, []),
    false,
  );
});
ok('it is opt-OUT, not opt-in — a renewal must reach people who never touched the toggle', () => {
  assert.equal(notifications.isNotificationEnabled({}, 'contractReminder'), true);
  assert.equal(notifications.isNotificationEnabled({ contractReminder: false }, 'contractReminder'), false);
});

console.log('\n── CON surfaces: /contracts is a Finances leaf, never shown to crew ──');

ok('/contracts is a nav leaf gated on contracts.view', () => {
  const leaf = navLeaves().find((n) => n.to === '/contracts');
  assert.ok(leaf, 'navData must carry a /contracts leaf');
  assert.equal(leaf.perm, 'contracts.view');
});
ok('it sits in the Finances group (the Sales group stays gone)', () => {
  const finances = NAV.find((n) => n.group === 'Finances');
  assert.ok(finances, 'the Finances group must still exist');
  assert.ok(finances.children.some((c) => c.to === '/contracts'), '/contracts belongs in Finances');
  assert.equal(NAV.some((n) => n.group === 'Sales'), false, 'the Sales group must stay removed');
});
ok('the shared visibility predicate hides it from a crew login', () => {
  const leaf = navLeaves().find((n) => n.to === '/contracts');
  const check = (k) => holds('crew', k);
  assert.equal(visible(leaf, check, false, true), false, 'crew must not see the Contracts nav row');
  const officeCheck = (k) => holds('manager', k);
  assert.equal(visible(leaf, officeCheck, false, false), true, 'the office must see it');
});

console.log(`\n${fails.length ? '✗' : '✓'} contract wiring: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
