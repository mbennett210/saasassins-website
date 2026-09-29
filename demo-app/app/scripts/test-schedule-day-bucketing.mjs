// The Schedule day-bucketing fix, pinned two ways (2026-07-21):
//
//   1. SEMANTICS — bucketing by dayKey then reading cells by key returns
//      exactly what the pre-fix per-cell `sameDay` filters returned (same
//      membership, same within-day sort), across a month grid spanning a
//      DST transition. If this fails, the calendar shows different jobs
//      than before the optimization — that is a correctness bug.
//   2. COST — the full per-toggle chain (bucket once + read day, week and
//      month cells) must stay under 500ms at 5k jobs. The pre-fix chain
//      MEASURED 4,031ms on the same machine class (42×N + 7×N + 1×N
//      un-cached Intl day-key calls); the fix lands ~10-90ms, so 500ms is
//      generous headroom for slow CI — while still 8× under the defect.
//
// Offline: imports only lib/dates.js. Run: node scripts/test-schedule-day-bucketing.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { sameDay, dayKey, startOfWeek, startOfMonth, addDays } from '../src/lib/dates.js';

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

// 5k jobs spread across ~120 days, hour-jittered, including the Nov 2026
// US DST fall-back (org zone America/Los_Angeles) — the boundary where a
// day-bucketing rewrite would drift from per-instant sameDay if it mishandled
// zones. Deterministic (no Math.random) so failures reproduce.
const N = 5048;
const base = new Date('2026-09-15T08:00:00.000Z').getTime();
const jobs = Array.from({ length: N }, (_, i) => ({
  id: `j${i}`,
  startAt: new Date(base + ((i % 120) - 10) * 86400000 + (i % 24) * 3600000 + (i % 7) * 60000).toISOString(),
}));

// The fix's shape, mirrored from Schedule.jsx jobsByDay.
function bucket(list) {
  const m = new Map();
  for (const j of list) {
    const k = dayKey(j.startAt);
    const arr = m.get(k);
    if (arr) arr.push(j); else m.set(k, [j]);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return m;
}
// The pre-fix shape: per-cell scan of every job.
const preFixCell = (d) => jobs.filter((j) => sameDay(j.startAt, d)).sort((a, b) => a.startAt.localeCompare(b.startAt));

const refDates = [new Date('2026-09-20T12:00:00Z'), new Date('2026-11-01T12:00:00Z')]; // plain + DST-transition month

ok('bucketed cells ≡ per-cell sameDay filters across day, week, and a DST month grid', () => {
  const byDay = bucket(jobs);
  for (const refDate of refDates) {
    const gridStart = startOfWeek(startOfMonth(refDate));
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const bucketed = byDay.get(dayKey(d)) || [];
      const scanned = preFixCell(d);
      assert.deepEqual(bucketed.map((j) => j.id), scanned.map((j) => j.id), `cell ${dayKey(d)}`);
    }
    const ws = startOfWeek(refDate);
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      assert.deepEqual((byDay.get(dayKey(d)) || []).map((j) => j.id), preFixCell(d).map((j) => j.id));
    }
  }
});

ok('every job lands in exactly one bucket (no loss, no duplication)', () => {
  const byDay = bucket(jobs);
  let total = 0;
  for (const arr of byDay.values()) total += arr.length;
  assert.equal(total, N);
});

ok('full per-toggle chain stays under 500ms at 5k jobs (defect measured 4,031ms)', () => {
  const refDate = refDates[0];
  const t0 = performance.now();
  const byDay = bucket(jobs); // the one O(N) pass
  byDay.get(dayKey(refDate));                                   // dayJobs
  const ws = startOfWeek(refDate);
  for (let i = 0; i < 7; i++) byDay.get(dayKey(addDays(ws, i))); // weekJobs
  const gs = startOfWeek(startOfMonth(refDate));
  for (let i = 0; i < 42; i++) byDay.get(dayKey(addDays(gs, i))); // monthGrid
  const ms = performance.now() - t0;
  console.log(`    (chain: ${ms.toFixed(1)} ms)`);
  assert.ok(ms < 500, `per-toggle chain took ${ms.toFixed(0)}ms — the freeze is back`);
});

console.log(`\nschedule day bucketing: ${pass} passed`);
