// Cancel-Job labor transform (lib/timeCancel), pins the owner-chosen policy: when a
// clean is cancelled, an OPEN punch is clocked out at the cancel moment (capped at the
// scheduled end, never before clock-in) and PAYS the real minutes; every punch on the
// clean is flagged job_cancelled_at; other jobs are untouched; the transform is
// idempotent. Run: node scripts/test-time-cancel.mjs
//
// timeCancel imports durationMins from timeMerge via an extensionless relative path
// (Vite style), so register the append-.js resolve hook raw Node needs.
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import assert from 'node:assert/strict';
const { applyJobCancellation, laborOnJob } = await import('../src/lib/timeCancel.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

const mk = (o) => ({
  id: o.id, job_id: o.job_id, user_name: o.user_name || null,
  clock_in_at: o.clock_in_at || null, clock_out_at: o.clock_out_at || null,
  duration_minutes: o.duration_minutes ?? null, scheduled_end: o.scheduled_end || null,
  status: o.status || (o.clock_out_at ? 'completed' : 'in_progress'),
  approval_status: 'pending', edit_history: o.edit_history || [],
});

ok('OPEN punch clocks out at the cancel moment and pays actual minutes', () => {
  const e = mk({ id: 'a', job_id: 'J', clock_in_at: '2026-09-19T10:00:00.000Z', scheduled_end: '2026-09-19T12:00:00.000Z' });
  const { entries, closed, flagged } = applyJobCancellation([e], 'J', '2026-09-19T10:15:00.000Z');
  const r = entries[0];
  assert.equal(r.clock_out_at, '2026-09-19T10:15:00.000Z');
  assert.equal(r.duration_minutes, 15);          // actual on-clock time, not the 120m window
  assert.equal(r.status, 'completed');            // NOT voided, it pays
  assert.equal(r.job_cancelled_at, '2026-09-19T10:15:00.000Z');
  assert.equal(closed, 1); assert.equal(flagged, 1);
  assert.ok(r.edit_history.some((h) => h.field === 'job_cancelled'));
});

ok('late cancel is capped at the scheduled end (no forgotten-punch inflation)', () => {
  const e = mk({ id: 'b', job_id: 'J', clock_in_at: '2026-09-19T09:00:00.000Z', scheduled_end: '2026-09-19T10:00:00.000Z' });
  const { entries } = applyJobCancellation([e], 'J', '2026-09-19T13:00:00.000Z'); // 3h after end
  assert.equal(entries[0].clock_out_at, '2026-09-19T10:00:00.000Z');
  assert.equal(entries[0].duration_minutes, 60);  // capped, not 240
});

ok('clock skew (now before clock-in) yields a real 0-minute punch, never negative', () => {
  const e = mk({ id: 'c', job_id: 'J', clock_in_at: '2026-09-19T10:00:00.000Z' });
  const { entries } = applyJobCancellation([e], 'J', '2026-09-19T09:50:00.000Z');
  assert.equal(entries[0].clock_out_at, '2026-09-19T10:00:00.000Z');
  assert.equal(entries[0].duration_minutes, 0);
});

ok('CLOSED punch is flagged only, its recorded time is left intact and still pays', () => {
  const e = mk({ id: 'd', job_id: 'J', clock_in_at: '2026-09-19T08:00:00.000Z', clock_out_at: '2026-09-19T09:30:00.000Z', duration_minutes: 90 });
  const { entries, closed, flagged } = applyJobCancellation([e], 'J', '2026-09-19T11:00:00.000Z');
  assert.equal(entries[0].clock_out_at, '2026-09-19T09:30:00.000Z');
  assert.equal(entries[0].duration_minutes, 90);
  assert.equal(entries[0].job_cancelled_at, '2026-09-19T11:00:00.000Z');
  assert.equal(closed, 0); assert.equal(flagged, 1);
});

ok('a punch on a DIFFERENT job is returned untouched (same reference)', () => {
  const keep = mk({ id: 'e', job_id: 'K', clock_in_at: '2026-09-19T10:00:00.000Z' });
  const { entries, flagged } = applyJobCancellation([keep], 'J', '2026-09-19T10:15:00.000Z');
  assert.equal(entries[0], keep);   // identity preserved
  assert.equal(flagged, 0);
});

ok('idempotent, re-applying never re-flags or re-closes an already-cancelled punch', () => {
  const e = mk({ id: 'f', job_id: 'J', clock_in_at: '2026-09-19T10:00:00.000Z', scheduled_end: '2026-09-19T12:00:00.000Z' });
  const first = applyJobCancellation([e], 'J', '2026-09-19T10:15:00.000Z');
  const second = applyJobCancellation(first.entries, 'J', '2026-09-19T10:45:00.000Z');
  assert.equal(second.closed, 0); assert.equal(second.flagged, 0);
  assert.equal(second.entries[0].clock_out_at, '2026-09-19T10:15:00.000Z'); // unchanged from first
});

ok('laborOnJob reports open punches + names for the manager warning', () => {
  const rows = [
    mk({ id: 'g', job_id: 'J', user_name: 'Ana' }),                                   // open
    mk({ id: 'h', job_id: 'J', user_name: 'Bo' }),                                    // open
    mk({ id: 'i', job_id: 'J', user_name: 'Cy', clock_in_at: '2026-09-19T08:00:00.000Z', clock_out_at: '2026-09-19T09:00:00.000Z' }), // closed
    mk({ id: 'j', job_id: 'K', user_name: 'Di' }),                                    // other job
  ];
  const info = laborOnJob(rows, 'J');
  assert.equal(info.total, 3);
  assert.equal(info.open.length, 2);
  assert.deepEqual(info.openNames, ['Ana', 'Bo']);
});

console.log(`\n${pass}/${pass} time-cancel assertions passed`);
