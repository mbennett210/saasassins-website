// Regression test for DEL-05: the last owner cannot be deleted.
// Tests the pure `isLastOwner` helper (roles.js is import-free → node-runnable) that
// gates both the reducer's DELETE_USER write path and the Team UI's Remove control.
// Pre-fix there was no guard at all, so DELETE_USER removed the last owner and stranded
// the org off every owner-only setting. This asserts the invariant the guard enforces.
import assert from 'node:assert';
import { isLastOwner } from '../src/lib/roles.js';

const owner1 = { id: 'u_o1', role: 'owner', status: 'active' };
const owner2 = { id: 'u_o2', role: 'owner', status: 'active' };
const ownerDisabled = { id: 'u_o3', role: 'owner', status: 'disabled' };
const admin = { id: 'u_a1', role: 'admin', status: 'active' };
const crew = { id: 'u_c1', role: 'crew', status: 'active' };

let passed = 0;
const check = (label, actual, expected) => { assert.strictEqual(actual, expected, label); passed += 1; };

// The sole owner IS the last owner → blocked.
check('sole owner is last', isLastOwner([owner1, admin, crew], owner1.id), true);
check('single-user org owner is last', isLastOwner([owner1], owner1.id), true);
// A disabled second owner still counts (an admin can re-enable them) → deleting the
// active one is NOT deleting the last owner.
check('two owners (one disabled) → not last', isLastOwner([owner1, ownerDisabled], owner1.id), false);
// Two active owners → either is deletable.
check('one of two owners is not last', isLastOwner([owner1, owner2], owner1.id), false);
check('the other of two owners is not last', isLastOwner([owner1, owner2], owner2.id), false);
// Deleting a non-owner is always fine, even in a single-owner org.
check('deleting an admin is never last-owner', isLastOwner([owner1, admin], admin.id), false);
check('deleting crew is never last-owner', isLastOwner([owner1, crew], crew.id), false);
// Defensive: missing/blank inputs fail closed to "not last owner" (never block a
// delete because of a lookup gap; the delete of a non-owner must proceed).
check('null userId → false', isLastOwner([owner1], null), false);
check('empty users → false', isLastOwner([], owner1.id), false);
check('undefined users → false', isLastOwner(undefined, owner1.id), false);

console.log(`\ntest-last-owner-guard: ${passed}/${passed} assertions passed ✓\n`);
