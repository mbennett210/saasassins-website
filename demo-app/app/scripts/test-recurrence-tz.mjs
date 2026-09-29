// Node unit test for recurrence expansion under the org-timezone contract.
//
// Two defects locked down here, both of which only ever misfired for a user outside
// the org's zone (so Seattle never saw them and they reached production):
//   1. crewForOccurrence keyed dayOverrides off `new Date(startAt).getDay()` — the
//      DEVICE's day-of-week. A Friday series booked from Manila read as Saturday,
//      missed its override, and silently handed the occurrence the default crew.
//   2. expandRecurrence stepped instants with setDate/setHours/setMonth — the
//      DEVICE's calendar — so the same series expanded onto different days per user.
//
// As with test-dates-tz.mjs, asserting in one zone proves nothing: this re-execs
// itself across device zones and requires byte-identical output from each.
// Run:
//   node scripts/test-recurrence-tz.mjs   (from app/)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setOrgTimezone, composeIso, splitIso, dayKey } from '../src/lib/dates.js';
import { expandRecurrence, crewForOccurrence } from '../src/lib/recurrence.js';

const ORG = 'America/Los_Angeles';
const DEVICE_ZONES = ['America/Los_Angeles', 'Asia/Manila', 'UTC', 'Pacific/Kiritimati'];

if (!process.env.__TZ_CHILD) {
  const self = fileURLToPath(import.meta.url);
  const results = new Map();
  let failed = false;

  for (const tz of DEVICE_ZONES) {
    const r = spawnSync(process.execPath, [self], {
      env: { ...process.env, TZ: tz, __TZ_CHILD: '1' }, encoding: 'utf8',
    });
    process.stdout.write(`\n── device TZ = ${tz} ${'─'.repeat(Math.max(0, 46 - tz.length))}\n`);
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) failed = true;
    results.set(tz, (r.stdout || '').split('FINGERPRINT ')[1] || `<no output: exit ${r.status}>`);
  }

  const [baseZone, baseline] = [...results.entries()][0];
  console.log('\n── cross-zone agreement ' + '─'.repeat(38));
  for (const [tz, fp] of results) {
    const same = fp === baseline;
    if (!same) failed = true;
    console.log(`  ${same ? '✓' : '✗'} ${tz.padEnd(22)} ${same ? 'matches' : `DIVERGES from ${baseZone}`}`);
    if (!same) console.log(`      expected ${baseline}\n      got      ${fp}`);
  }
  console.log(failed ? '\n✗ FAIL — recurrence is still device-dependent\n' : '\n✓ PASS — all device zones agree\n');
  process.exit(failed ? 1 : 0);
}

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`);

setOrgTimezone(ORG);

// Render an occurrence as the org sees it — the only view that matters.
const asOrg = (o) => { const { date, time } = splitIso(o.startAt); return `${date} ${time}`; };

// --- crewForOccurrence: the silent crew flip -------------------------------
// 2026-07-17T16:00Z is Friday 9:00 AM in LA. Device-local getDay() called it
// Saturday in Manila and Thursday nowhere near — either way the override missed.
{
  const rec = { frequency: 'weekly', daysOfWeek: [5], dayOverrides: { 5: { crewIds: ['u-friday'] } } };
  const crew = crewForOccurrence(rec, '2026-07-17T16:00:00.000Z', ['u-default']);
  eq(JSON.stringify(crew), JSON.stringify(['u-friday']), 'crewForOccurrence: Friday override resolves in the org zone');

  // Just inside org-Friday, but already Saturday UTC — the case that used to flip.
  const late = crewForOccurrence(rec, '2026-07-18T06:59:00.000Z', ['u-default']);
  eq(JSON.stringify(late), JSON.stringify(['u-friday']), 'crewForOccurrence: 23:59 org-Friday is still Friday');

  // Genuinely a different day → correctly falls back to the series default.
  const sat = crewForOccurrence(rec, '2026-07-18T16:00:00.000Z', ['u-default']);
  eq(JSON.stringify(sat), JSON.stringify(['u-default']), 'crewForOccurrence: Saturday falls back to default crew');
}

// --- weekly expansion ------------------------------------------------------
{
  const out = expandRecurrence({
    startAt: composeIso('2026-07-17', '09:00'),
    endAt: composeIso('2026-07-17', '10:30'),
    recurrence: { frequency: 'weekly', daysOfWeek: [5], endType: 'count', endCount: 3 },
  });
  eq(out.length, 3, 'weekly: count honoured');
  eq(out.map(asOrg).join(' | '), '2026-07-24 09:00 | 2026-07-31 09:00 | 2026-08-07 09:00', 'weekly: every Friday at the org 9:00');
  eq(splitIso(out[0].endAt).time, '10:30', 'weekly: duration preserved');
}

// --- weekly across a DST boundary (US fall-back: Nov 1 2026) ---------------
// The real prize: a 9:00 AM series must stay 9:00 AM, not drift to 8:00 when the
// offset changes underneath it.
{
  const out = expandRecurrence({
    startAt: composeIso('2026-10-30', '09:00'), // Friday, PDT (UTC-7)
    endAt: composeIso('2026-10-30', '10:30'),
    recurrence: { frequency: 'weekly', daysOfWeek: [5], endType: 'count', endCount: 3 },
  });
  eq(out.map(asOrg).join(' | '), '2026-11-06 09:00 | 2026-11-13 09:00 | 2026-11-20 09:00', 'DST: series holds 9:00 across fall-back');
  eq(out[0].startAt, '2026-11-06T17:00:00.000Z', 'DST: post-fall-back 9:00 is UTC-8, not UTC-7');
}

// --- daily / biweekly stride ----------------------------------------------
{
  const daily = expandRecurrence({
    startAt: composeIso('2026-03-06', '09:00'), // spans spring-forward (Mar 8)
    endAt: composeIso('2026-03-06', '10:00'),
    recurrence: { frequency: 'daily', endType: 'count', endCount: 4 },
  });
  eq(daily.map(asOrg).join(' | '), '2026-03-07 09:00 | 2026-03-08 09:00 | 2026-03-09 09:00 | 2026-03-10 09:00', 'daily: holds 9:00 across spring-forward');

  const bi = expandRecurrence({
    startAt: composeIso('2026-07-17', '09:00'),
    endAt: composeIso('2026-07-17', '10:00'),
    recurrence: { frequency: 'biweekly', endType: 'count', endCount: 2 },
  });
  eq(bi.map(asOrg).join(' | '), '2026-07-31 09:00 | 2026-08-14 09:00', 'biweekly: 14-day stride');
}

// --- monthly: clamp, don't overflow ---------------------------------------
// Date's setMonth() overflows — Jan 31 + 1mo lands in March — so a series anchored
// on the 31st used to skip February entirely.
{
  const out = expandRecurrence({
    startAt: composeIso('2026-01-31', '09:00'),
    endAt: composeIso('2026-01-31', '10:00'),
    recurrence: { frequency: 'monthly', endType: 'count', endCount: 3 },
  });
  eq(out.map(asOrg).join(' | '), '2026-02-28 09:00 | 2026-03-31 09:00 | 2026-04-30 09:00', 'monthly: clamps into short months, never skips one');
}

// --- per-day overrides ----------------------------------------------------
{
  const out = expandRecurrence({
    startAt: composeIso('2026-07-13', '09:00'), // Monday
    endAt: composeIso('2026-07-13', '10:00'),
    recurrence: {
      frequency: 'weekly', daysOfWeek: [1, 6], endType: 'count', endCount: 4,
      dayOverrides: { 6: { startTime: '08:00', endTime: '11:00', crewIds: ['u-sat'] } },
    },
  });
  eq(out.map(asOrg).join(' | '), '2026-07-18 08:00 | 2026-07-20 09:00 | 2026-07-25 08:00 | 2026-07-27 09:00', 'dayOverrides: Saturdays run at their own 8:00');
  eq(splitIso(out[0].endAt).time, '11:00', 'dayOverrides: override end time applied');
  eq(dayKey(out[0].startAt), '2026-07-18', 'dayOverrides: Saturday lands on the org Saturday');
}

// --- endType: date --------------------------------------------------------
{
  const out = expandRecurrence({
    startAt: composeIso('2026-07-17', '09:00'),
    endAt: composeIso('2026-07-17', '10:00'),
    recurrence: { frequency: 'weekly', daysOfWeek: [5], endType: 'date', endDate: composeIso('2026-08-01', '23:59') },
  });
  eq(out.map(asOrg).join(' | '), '2026-07-24 09:00 | 2026-07-31 09:00', 'endType date: cutoff respected in the org zone');
}

console.log(`  ${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);

const FINGERPRINT = [
  expandRecurrence({
    startAt: composeIso('2026-10-30', '09:00'), endAt: composeIso('2026-10-30', '10:30'),
    recurrence: { frequency: 'weekly', daysOfWeek: [5], endType: 'count', endCount: 3 },
  }).map((o) => o.startAt).join(','),
  expandRecurrence({
    startAt: composeIso('2026-01-31', '09:00'), endAt: composeIso('2026-01-31', '10:00'),
    recurrence: { frequency: 'monthly', endType: 'count', endCount: 3 },
  }).map(asOrg).join(','),
  JSON.stringify(crewForOccurrence(
    { dayOverrides: { 5: { crewIds: ['u-friday'] } } }, '2026-07-18T06:59:00.000Z', ['u-default'],
  )),
].join('|');
console.log('FINGERPRINT ' + FINGERPRINT);

process.exit(fail === 0 ? 0 : 1);
