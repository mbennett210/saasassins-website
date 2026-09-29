// Unit test for the Complaints → Work Orders backfill mapping (Increment 3).
// complaintToWorkOrderRow is the PURE core of scripts/backfill-complaints-to-workorders.mjs
// (the DB plumbing is the impure shell). Pins the field mapping so a live complaint is
// preserved faithfully as a Work Order of type:complaint — no silent status/date loss.
//
//   node scripts/test-complaints-backfill.mjs
import assert from 'node:assert/strict';
import { complaintToWorkOrderRow, computeDueAt } from '../src/lib/workOrders.js';

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

const ORG = 'org_test';
const base = {
  id: 'cmp_1', status: 'open', clientId: 'cl_1', clientName: 'Las Olas Medical',
  detail: 'Exam room 3 not serviced overnight', createdAt: '2026-09-10T14:00:00.000Z',
  updatedAt: '2026-09-10T14:00:00.000Z', createdBy: 'u_sup', resolvedAt: null,
};

console.log('complaints → work orders backfill mapping:');

ok('an open complaint maps to an open type:complaint Work Order', () => {
  const r = complaintToWorkOrderRow(base, { orgId: ORG });
  assert.equal(r.organization_id, ORG);
  assert.equal(r.type, 'complaint');
  assert.equal(r.origin, 'internal');          // the old Complaints log was staff-logged
  assert.equal(r.priority, 'medium');          // complaints carried no severity
  assert.equal(r.status, 'open');
  assert.equal(r.resolved_at, null);
  assert.equal(r.client_id, 'cl_1');
  assert.equal(r.client_name, 'Las Olas Medical');
  assert.equal(r.reported_by_user_id, 'u_sup');
  assert.equal(r.title, 'Exam room 3 not serviced overnight');
  assert.equal(r.description, 'Exam room 3 not serviced overnight');
  assert.equal(r.created_at, '2026-09-10T14:00:00.000Z');
  assert.equal(r.due_at, computeDueAt('2026-09-10T14:00:00.000Z', 'medium')); // SLA clock preserved
  assert.equal(r.escalated_at, null);
});

ok('a resolved complaint carries status + resolved_at', () => {
  const r = complaintToWorkOrderRow({ ...base, status: 'resolved', resolvedAt: '2026-09-11T09:00:00.000Z' }, { orgId: ORG });
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolved_at, '2026-09-11T09:00:00.000Z');
});

ok('resolved with no resolvedAt falls back to updatedAt then createdAt', () => {
  const r = complaintToWorkOrderRow({ ...base, status: 'resolved', resolvedAt: null, updatedAt: '2026-09-10T20:00:00.000Z' }, { orgId: ORG });
  assert.equal(r.resolved_at, '2026-09-10T20:00:00.000Z');
  const r2 = complaintToWorkOrderRow({ ...base, status: 'resolved', resolvedAt: null, updatedAt: null }, { orgId: ORG });
  assert.equal(r2.resolved_at, base.createdAt);
});

ok("legacy 'ongoing' status maps to in_progress (not dropped to open)", () => {
  assert.equal(complaintToWorkOrderRow({ ...base, status: 'ongoing' }, { orgId: ORG }).status, 'in_progress');
});

ok('an unknown status normalizes to open (never silently resolved)', () => {
  const r = complaintToWorkOrderRow({ ...base, status: 'weird' }, { orgId: ORG });
  assert.equal(r.status, 'open');
  assert.equal(r.resolved_at, null);
});

ok('an unattached complaint (no client) maps to null client fields', () => {
  const r = complaintToWorkOrderRow({ ...base, clientId: null, clientName: '' }, { orgId: ORG });
  assert.equal(r.client_id, null);
  assert.equal(r.client_name, null);
});

ok('an empty detail yields the "Complaint" title fallback', () => {
  const r = complaintToWorkOrderRow({ ...base, detail: '' }, { orgId: ORG });
  assert.equal(r.title, 'Complaint');
  assert.equal(r.description, null);
});

ok('a long detail truncates the title to 120 chars but keeps the full description', () => {
  const long = 'x'.repeat(300);
  const r = complaintToWorkOrderRow({ ...base, detail: long }, { orgId: ORG });
  assert.equal(r.title.length, 120);
  assert.equal(r.description, long);
});

ok('the title is the first line only (multi-line detail)', () => {
  const r = complaintToWorkOrderRow({ ...base, detail: 'Trash left full\nSecond line of detail' }, { orgId: ORG });
  assert.equal(r.title, 'Trash left full');
  assert.equal(r.description, 'Trash left full\nSecond line of detail');
});

console.log(`\nAll ${pass} assertions passed.`);
