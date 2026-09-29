// Node unit test for the timezone contract in src/lib/dates.js — the layer that
// makes scheduling resolve in the ORG's timezone instead of the device's.
//
// The bug this locks down: a VA in Manila (UTC+8) booked every job one day early
// because `todayIso().slice(0,10)` read the UTC calendar day off a LOCAL midnight.
// Seattle (UTC-8) never saw it, so it survived to production.
//
// The whole point is device-zone INDEPENDENCE, so asserting in one process proves
// nothing: this re-execs itself under several TZ values and requires every zone to
// agree, byte for byte. A regression here fails in Manila and passes in Seattle.
// Run:
//   node scripts/test-dates-tz.mjs   (from app/)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  setOrgTimezone, todayKey, dayKey, composeIso, splitIso, sameDay,
  dayOfWeekIso, addDaysKey, startOfWeekKey, startOfMonthKey, startOfDayKey, todayIso,
  startOfYearKey, startOfQuarterKey, addMonthsKey,
} from '../src/lib/dates.js';

const ORG = 'America/Los_Angeles'; // the org's zone in every assertion below
// Africa/Johannesburg (UTC+2) is the 2026-08-03 incident's device zone — a SA-based
// scheduler must still see the calendar in the org zone (Seattle), not SAST.
const DEVICE_ZONES = ['America/Los_Angeles', 'Asia/Manila', 'UTC', 'Pacific/Kiritimati', 'Africa/Johannesburg'];

// ---------------------------------------------------------------------------
// Parent: fan out across device zones, require identical output from each.
// ---------------------------------------------------------------------------
if (!process.env.__TZ_CHILD) {
  const self = fileURLToPath(import.meta.url);
  const results = new Map();
  let failed = false;

  for (const tz of DEVICE_ZONES) {
    const r = spawnSync(process.execPath, [self], {
      env: { ...process.env, TZ: tz, __TZ_CHILD: '1' },
      encoding: 'utf8',
    });
    process.stdout.write(`\n── device TZ = ${tz} ${'─'.repeat(Math.max(0, 46 - tz.length))}\n`);
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) failed = true;
    results.set(tz, (r.stdout || '').split('FINGERPRINT ')[1] || `<no output: exit ${r.status}>`);
  }

  // The cross-zone invariant: same inputs, same org zone → same answers everywhere.
  const [baseZone, baseline] = [...results.entries()][0];
  console.log('\n── cross-zone agreement ' + '─'.repeat(38));
  for (const [tz, fp] of results) {
    const same = fp === baseline;
    if (!same) failed = true;
    console.log(`  ${same ? '✓' : '✗'} ${tz.padEnd(22)} ${same ? 'matches' : `DIVERGES from ${baseZone}`}`);
    if (!same) console.log(`      expected ${baseline}\n      got      ${fp}`);
  }

  console.log(failed ? '\n✗ FAIL — scheduling is still device-dependent\n' : '\n✓ PASS — all device zones agree\n');
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Child: run the assertions under whatever TZ the parent handed us.
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`);

setOrgTimezone(ORG);

// --- composeIso: form input (org wall clock) → absolute instant -------------
// 9:00 AM at the site is one instant. Which desk booked it is irrelevant.
eq(composeIso('2026-07-17', '09:00'), '2026-07-17T16:00:00.000Z', 'composeIso: Jul 17 9am PDT (UTC-7)');
eq(composeIso('2026-01-15', '09:00'), '2026-01-15T17:00:00.000Z', 'composeIso: Jan 15 9am PST (UTC-8) — DST-aware');
eq(composeIso('2026-07-17', '00:00'), '2026-07-17T07:00:00.000Z', 'composeIso: midnight boundary');
eq(composeIso('2026-07-17', '23:59'), '2026-07-18T06:59:00.000Z', 'composeIso: end-of-day crosses UTC midnight');
eq(composeIso(''), null, 'composeIso: blank date → null');

// --- splitIso: instant → org wall clock (exact inverse) ---------------------
eq(JSON.stringify(splitIso('2026-07-17T16:00:00.000Z')), JSON.stringify({ date: '2026-07-17', time: '09:00' }), 'splitIso: inverse of composeIso');
eq(JSON.stringify(splitIso('')), JSON.stringify({ date: '', time: '' }), 'splitIso: blank → blanks');

// The edit round-trip. Before the fix this silently rewrote a Manila-booked job to
// the previous day the moment a Seattle admin opened it and pressed Save.
for (const date of ['2026-01-01', '2026-03-08', '2026-07-17', '2026-11-01', '2026-12-31']) {
  for (const time of ['00:00', '09:00', '13:30', '23:45']) {
    const { date: d2, time: t2 } = splitIso(composeIso(date, time));
    ok(d2 === date && t2 === time, `round-trip ${date} ${time} → ${d2} ${t2}`);
  }
}

// --- DST transitions (US 2026: spring fwd Mar 8, fall back Nov 1) -----------
eq(composeIso('2026-03-07', '12:00'), '2026-03-07T20:00:00.000Z', 'DST: day before spring-forward is UTC-8');
eq(composeIso('2026-03-09', '12:00'), '2026-03-09T19:00:00.000Z', 'DST: day after spring-forward is UTC-7');
eq(composeIso('2026-10-31', '12:00'), '2026-10-31T19:00:00.000Z', 'DST: day before fall-back is UTC-7');
eq(composeIso('2026-11-02', '12:00'), '2026-11-02T20:00:00.000Z', 'DST: day after fall-back is UTC-8');
// 2:30 AM on spring-forward day does not exist; must resolve deterministically,
// not throw and not silently land on the wrong calendar day.
ok(/^2026-03-08T/.test(composeIso('2026-03-08', '02:30')), 'DST: nonexistent wall time stays on its own day');

// --- dayKey / todayKey: the reported bug ------------------------------------
eq(dayKey('2026-07-17T16:00:00.000Z'), '2026-07-17', 'dayKey: afternoon UTC → same org day');
eq(dayKey('2026-07-18T06:59:00.000Z'), '2026-07-17', 'dayKey: pre-UTC-midnight still yesterday in org zone');
eq(dayKey('2026-07-18T07:00:00.000Z'), '2026-07-18', 'dayKey: org midnight rolls the day');
// todayKey must be the org's today — NOT the device's, and never `.slice(0,10)`.
eq(todayKey(), dayKey(new Date()), 'todayKey: agrees with dayKey(now)');
ok(/^\d{4}-\d{2}-\d{2}$/.test(todayKey()), 'todayKey: well-formed YYYY-MM-DD');
eq(dayKey(startOfDayKey(todayKey())), todayKey(), 'startOfDayKey: round-trips to the same org day');
eq(dayKey(todayIso()), todayKey(), 'todayIso: lands on the org calendar day');

// --- sameDay: calendar bucketing -------------------------------------------
ok(sameDay('2026-07-17T16:00:00.000Z', '2026-07-18T06:00:00.000Z'), 'sameDay: both in the org Jul 17');
ok(!sameDay('2026-07-18T06:00:00.000Z', '2026-07-18T08:00:00.000Z'), 'sameDay: org midnight separates them');

// --- dayOfWeekIso: the recurrence crew lookup ------------------------------
// 2026-07-17 is a Friday in LA. Device-local getDay() returned Thursday in Seattle
// for a Manila-booked job, missing dayOverrides[dow] and flipping the crew.
eq(dayOfWeekIso('2026-07-17T16:00:00.000Z'), 5, 'dayOfWeekIso: Friday');
eq(dayOfWeekIso('2026-07-18T06:59:00.000Z'), 5, 'dayOfWeekIso: still Friday just before org midnight');
eq(dayOfWeekIso('2026-07-18T07:00:00.000Z'), 6, 'dayOfWeekIso: Saturday at org midnight');

// --- day-key arithmetic (pure labels — no zone may touch these) -------------
eq(addDaysKey('2026-07-17', 1), '2026-07-18', 'addDaysKey: +1');
eq(addDaysKey('2026-07-31', 1), '2026-08-01', 'addDaysKey: month boundary');
eq(addDaysKey('2026-12-31', 1), '2027-01-01', 'addDaysKey: year boundary');
eq(addDaysKey('2026-01-01', -1), '2025-12-31', 'addDaysKey: negative across year');
eq(addDaysKey('2028-02-28', 1), '2028-02-29', 'addDaysKey: leap day');
eq(addDaysKey('2026-03-08', 1), '2026-03-09', 'addDaysKey: unaffected by the DST day');
eq(startOfWeekKey('2026-07-17'), '2026-07-13', 'startOfWeekKey: Friday → Monday');
eq(startOfWeekKey('2026-07-19'), '2026-07-13', 'startOfWeekKey: Sunday → previous Monday');
eq(startOfWeekKey('2026-07-13'), '2026-07-13', 'startOfWeekKey: Monday is idempotent');
eq(startOfMonthKey('2026-07-17'), '2026-07-01', 'startOfMonthKey');
eq(startOfYearKey('2026-07-17'), '2026-01-01', 'startOfYearKey');
eq(startOfQuarterKey('2026-01-15'), '2026-01-01', 'startOfQuarterKey: Q1');
eq(startOfQuarterKey('2026-07-17'), '2026-07-01', 'startOfQuarterKey: Q3');
eq(startOfQuarterKey('2026-12-31'), '2026-10-01', 'startOfQuarterKey: Q4');
// addMonthsKey — used by the revenue selectors, MUST be safe for negative n.
eq(addMonthsKey('2026-07-01', 1), '2026-08-01', 'addMonthsKey: +1');
eq(addMonthsKey('2026-12-01', 1), '2027-01-01', 'addMonthsKey: +1 across year');
eq(addMonthsKey('2026-01-01', -1), '2025-12-01', 'addMonthsKey: -1 across year (negative-safe)');
eq(addMonthsKey('2026-03-31', -1), '2026-02-28', 'addMonthsKey: -1 clamps to Feb 28');
eq(addMonthsKey('2028-03-31', -1), '2028-02-29', 'addMonthsKey: -1 clamps to leap Feb 29');
eq(addMonthsKey('2026-01-15', -13), '2024-12-15', 'addMonthsKey: -13 spans two years');

// A blank org zone falls back to the LA default, NOT the device — "source of truth
// is always Los Angeles" until a Super Admin saves an explicit zone. This is what
// makes the fix take effect on the live blob (which predates company.timezone).
setOrgTimezone(null);
eq(todayKey(), dayKey(new Date(), 'America/Los_Angeles'), 'blank org tz: falls back to LA, not device');
setOrgTimezone('Not/AZone');
ok(/^\d{4}-\d{2}-\d{2}$/.test(todayKey()), 'invalid org tz: degrades instead of throwing');
setOrgTimezone(ORG);

console.log(`  ${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);

// Device-zone-independent fingerprint the parent compares across zones. Every value
// here is org-anchored, so a device zone leaking in anywhere changes this line.
const FINGERPRINT = [
  composeIso('2026-07-17', '09:00'),
  composeIso('2026-01-15', '09:00'),
  JSON.stringify(splitIso('2026-07-17T16:00:00.000Z')),
  dayKey('2026-07-18T06:59:00.000Z'),
  dayOfWeekIso('2026-07-17T16:00:00.000Z'),
  startOfWeekKey('2026-07-17'),
  todayKey(), // the reported bug: must be the org's today on every device
].join('|');
console.log('FINGERPRINT ' + FINGERPRINT);

process.exit(fail === 0 ? 0 : 1);
