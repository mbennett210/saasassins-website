// Pins for the 2026-07-30 schedule fixes that are pure-function testable:
//
//   1. CUSTOM date range is REACHABLE: the '__custom' sentinel round-trips
//      through the codec even with both dates empty (encoding to '' made
//      useUrlFilters delete the param and the control snapped back).
//   2. Schedule presets are FORWARD-looking (next7/next30/weekAll/monthAll
//      end AFTER now; the shared retrospective presets end AT now and hid the
//      entire future schedule).
//   3. OVERNIGHT shifts roll the end to the next day (10 PM–2 AM stored
//      endAt < startAt, inverting conflict math and zeroing durations) — in
//      composeEndIso AND in recurrence expansion with per-day end times.
//
// Run: node scripts/test-schedule-range-overnight.mjs
//
// applyFilters.js uses Vite-style extensionless imports; register the same
// append-.js resolve hook test-replay-idempotence.mjs uses.
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import assert from 'node:assert/strict';
const { composeEndIso, composeIso } = await import('../src/lib/dates.js');
const { codecFor, rangeBounds, SCHEDULE_DATE_PRESETS } = await import('../src/lib/filters/applyFilters.js');
const { expandRecurrence } = await import('../src/lib/recurrence.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

// ── 1. custom range round-trip ───────────────────────────────────────────────
ok("'__custom' with empty dates survives the codec (param is never deleted)", () => {
  const codec = codecFor('dateRange');
  const v = { preset: '__custom', from: '', to: '' };
  const enc = codec.encode(v);
  assert.ok(enc, `encoded to falsy ${JSON.stringify(enc)} — the param would be deleted`);
  const back = codec.decode(enc);
  assert.equal(back.preset, '__custom');
  assert.equal(codec.empty(back), false);
});
ok('custom with dates round-trips from/to intact', () => {
  const codec = codecFor('dateRange');
  const back = codec.decode(codec.encode({ preset: '__custom', from: '2026-08-01', to: '2026-08-15' }));
  assert.equal(back.from, '2026-08-01');
  assert.equal(back.to, '2026-08-15');
});
ok('plain presets still round-trip unchanged', () => {
  const codec = codecFor('dateRange');
  assert.deepEqual(codec.decode(codec.encode({ preset: 'next7' })), { preset: 'next7' });
});

// ── 2. forward presets end in the future ─────────────────────────────────────
ok('every schedule preset ends AFTER now (a calendar shows what is coming)', () => {
  const now = new Date();
  for (const p of SCHEDULE_DATE_PRESETS) {
    const { to } = rangeBounds({ preset: p.value }, now);
    assert.ok(to && to.getTime() >= now.getTime() - 60000, `${p.value} ends at ${to} — retrospective on a schedule`);
  }
});
ok('next7 spans about a week forward', () => {
  const now = new Date();
  const { from, to } = rangeBounds({ preset: 'next7' }, now);
  const spanDays = (to.getTime() - from.getTime()) / 86400000;
  assert.ok(spanDays > 6.5 && spanDays < 8.5, `span ${spanDays.toFixed(1)}d`);
});

// ── 3. overnight rollover ────────────────────────────────────────────────────
ok('composeEndIso rolls a 22:00–02:00 shift to the next day', () => {
  const start = composeIso('2026-08-10', '22:00');
  const end = composeEndIso('2026-08-10', '22:00', '02:00');
  assert.ok(end > start, `endAt ${end} <= startAt ${start}`);
  const durH = (new Date(end) - new Date(start)) / 3600000;
  assert.equal(durH, 4);
});
ok('composeEndIso leaves a same-day 09:00–17:00 shift alone', () => {
  assert.equal(composeEndIso('2026-08-10', '09:00', '17:00'), composeIso('2026-08-10', '17:00'));
});
ok('weekly expansion with an overnight dayOverride keeps endAt after startAt', () => {
  const occ = expandRecurrence({
    startAt: composeIso('2026-08-10', '22:00'),
    endAt: composeEndIso('2026-08-10', '22:00', '02:00'),
    recurrence: {
      frequency: 'weekly', daysOfWeek: [1, 3], endType: 'count', endCount: 6,
      dayOverrides: { 3: { startTime: '23:00', endTime: '03:00' } },
    },
  });
  assert.ok(occ.length >= 5);
  for (const o of occ) assert.ok(o.endAt > o.startAt, `inverted occurrence ${o.startAt} → ${o.endAt}`);
});

console.log(`\nschedule range + overnight: ${pass} passed`);
