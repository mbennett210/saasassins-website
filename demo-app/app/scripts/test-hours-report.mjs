// Reports › Hours by cleaner = the Payroll run's math for ANY date range (Reports fix
// #4, 2026-09-22). The report used to sum only the punches inside the chosen range, so
// the weekly 40h line landed on a partial week at each edge (a Mon–Fri 10h/day cleaner
// viewed from Wednesday showed 30h regular / 0 OT; the pay run pays 20h + 10h OT for the
// same days), filtered by customer BEFORE the split, and left out paid drive.
//   node app/scripts/test-hours-report.mjs
import {
  attributeWeeklyOt, hoursByUserForRange, payWeeksWindow, payrollByUserClipped, payrollByUser,
} from '../src/lib/payroll.js';
import { addDaysKey, startOfDayKey, dayKey } from '../src/lib/dates.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const TZ = 'America/New_York';
const at = (key, h, m = 0) => new Date(startOfDayKey(key, TZ).getTime() + (h * 60 + m) * 60000).toISOString();
let seq = 0;
const punch = (userId, key, h, mins, clientId = 'cA', extra = {}) => ({
  id: `e${String(seq++).padStart(5, '0')}`, userId, userName: userId.toUpperCase(), clientId,
  clockInAt: at(key, h), clockOutAt: at(key, h, mins), durationMinutes: mins,
  status: 'completed', approvalStatus: 'pending', ...extra,
});
const H = (m) => m / 60;
const one = (rows, u) => rows.find((r) => r.userId === u) || { regularMinutes: 0, otMinutes: 0, totalMinutes: 0, driveMinutes: 0, cleanCount: 0 };

// ── the case that started it: Mon–Fri 10h a day, viewed from Wednesday ─────────
{
  // Week of Sun 2026-09-13: Mon 14 … Fri 18.
  const days = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
  const entries = days.map((d) => punch('u1', d, 18, 600));
  const items = attributeWeeklyOt(entries, { tz: TZ });
  const wedOn = one(hoursByUserForRange(items, { fromKey: '2026-09-16', toKey: '2026-09-30' }), 'u1');
  ok(H(wedOn.regularMinutes) === 20 && H(wedOn.otMinutes) === 10, `W1: Wed–Fri of a 50h week = 20h regular + 10h OT (got ${H(wedOn.regularMinutes)}/${H(wedOn.otMinutes)})`);
  const clipped = one(payrollByUserClipped(entries, { tz: TZ, clipFromKey: '2026-09-16', clipToKey: '2026-09-30' }), 'u1');
  ok(wedOn.regularMinutes === clipped.regularMinutes && wedOn.otMinutes === clipped.otMinutes, 'W2: …exactly what the semi-monthly pay run pays for those days');
  const naive = one(payrollByUser(entries.filter((e) => dayKey(e.clockInAt, TZ) >= '2026-09-16'), { tz: TZ }), 'u1');
  ok(naive.otMinutes === 0, 'W3: (the old report — a plain sum of the in-range punches — gave 0 OT here; this is the defect)');
  const whole = one(hoursByUserForRange(items, { fromKey: '2026-09-13', toKey: '2026-09-19' }), 'u1');
  ok(H(whole.regularMinutes) === 40 && H(whole.otMinutes) === 10 && whole.cleanCount === 5, 'W4: the whole week = 40h + 10h OT, 5 cleans');
}

// ── equivalence with the pay run, on random data ───────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
{
  const r = rng(7);
  const users = ['ua', 'ub', 'uc', 'ud'];
  const clients = ['cA', 'cB', 'cC'];
  const entries = [];
  const drive = [];
  const start = '2026-08-30'; // a Sunday
  for (let d = 0; d < 35; d += 1) {
    const key = addDaysKey(start, d);
    for (const u of users) {
      if (r() < 0.25) continue;
      const shifts = 1 + Math.floor(r() * 3);
      let h = 6 + Math.floor(r() * 4);
      for (let s = 0; s < shifts; s += 1) {
        const mins = 60 + Math.floor(r() * 300);
        const extra = r() < 0.05 ? { status: 'voided' } : (r() < 0.05 ? { approvalStatus: 'rejected' } : (r() < 0.3 ? { approvalStatus: 'approved' } : {}));
        entries.push(punch(u, key, h, mins, clients[Math.floor(r() * 3)], extra));
        if (s > 0 && r() < 0.7) {
          drive.push({
            key: `d${seq++}`, userId: u, userName: u.toUpperCase(), startAt: at(key, h - 1), endAt: at(key, h),
            actualMinutes: 20 + Math.floor(r() * 30), paidMinutes: undefined,
            fromStatus: 'completed', toStatus: 'completed', fromApprovalStatus: 'pending',
            toApprovalStatus: r() < 0.5 ? 'approved' : 'pending', toClientId: clients[Math.floor(r() * 3)],
          });
        }
        h += Math.ceil(mins / 60) + 1;
      }
    }
  }
  const fields = ['regularMinutes', 'otMinutes', 'totalMinutes', 'driveMinutes', 'cleanCount'];
  let checked = 0; let mismatched = 0;
  for (const approvedOnly of [false, true]) {
    const items = attributeWeeklyOt(entries, { tz: TZ, driveSegments: drive, approvedOnly });
    for (let t = 0; t < 40; t += 1) {
      const a = addDaysKey(start, Math.floor(r() * 30));
      const b = addDaysKey(a, Math.floor(r() * 12));
      const mine = hoursByUserForRange(items, { fromKey: a, toKey: b });
      const theirs = payrollByUserClipped(entries, { tz: TZ, driveSegments: drive, approvedOnly, clipFromKey: a, clipToKey: b });
      for (const u of users) {
        checked += 1;
        const x = one(mine, u); const y = one(theirs, u);
        if (fields.some((f) => x[f] !== y[f])) mismatched += 1;
      }
    }
  }
  ok(mismatched === 0, `E1: any range, per cleaner, = payrollByUserClipped (the pay run) — ${checked - mismatched}/${checked} match`);
  // A week-aligned pay period equals the plain weekly rollup the weekly/biweekly runs use.
  const items = attributeWeeklyOt(entries, { tz: TZ, driveSegments: drive });
  const p = hoursByUserForRange(items, { fromKey: '2026-09-06', toKey: '2026-09-19' });
  const periodEntries = entries.filter((e) => { const k = dayKey(e.clockInAt, TZ); return k >= '2026-09-06' && k <= '2026-09-19'; });
  const periodDrive = drive.filter((s) => { const k = dayKey(s.startAt, TZ); return k >= '2026-09-06' && k <= '2026-09-19'; });
  const run = payrollByUser(periodEntries, { tz: TZ, driveSegments: periodDrive });
  ok(users.every((u) => fields.every((f) => one(p, u)[f] === one(run, u)[f])), 'E2: a biweekly period = the biweekly pay run, field for field');

  // Scoping by customer keeps the 40h line whole: the per-customer slices add back up.
  const all = hoursByUserForRange(items, { fromKey: start, toKey: addDaysKey(start, 34) });
  const perClient = clients.map((c) => hoursByUserForRange(items, { fromKey: start, toKey: addDaysKey(start, 34), clientIds: [c] }));
  const sumsUp = users.every((u) => ['regularMinutes', 'otMinutes', 'totalMinutes'].every((f) => perClient.reduce((acc, rows) => acc + one(rows, u)[f], 0) === one(all, u)[f]));
  ok(sumsUp, 'E3: every customer\'s slice adds back up to the unscoped total (no hours or OT lost or invented by scoping)');
}

// ── customer scope: hours elsewhere still push a cleaner over 40 ───────────────
{
  const entries = [
    punch('u2', '2026-09-14', 8, 30 * 60 / 2, 'cA'), // Mon 15h at A
    punch('u2', '2026-09-15', 8, 15 * 60, 'cA'),     // Tue 15h at A  → 30h at A
    punch('u2', '2026-09-16', 8, 20 * 60, 'cB'),     // Wed 20h at B  → crosses 40 on Wed
  ];
  const items = attributeWeeklyOt(entries, { tz: TZ });
  const atA = one(hoursByUserForRange(items, { clientIds: ['cA'] }), 'u2');
  const atB = one(hoursByUserForRange(items, { clientIds: ['cB'] }), 'u2');
  ok(H(atA.regularMinutes) === 30 && atA.otMinutes === 0, 'S1: 30h at customer A, all regular');
  ok(H(atB.regularMinutes) === 10 && H(atB.otMinutes) === 10, `S2: customer B carries the 10h that crossed 40 (got ${H(atB.regularMinutes)}/${H(atB.otMinutes)}; the old report showed B 20h / 0 OT)`);
}

// ── paid drive counts toward the 40h line, and is reported inside the total ────
{
  const entries = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'].map((d) => punch('u3', d, 8, 600)); // 40h
  const drive = [{
    key: 'dr1', userId: 'u3', userName: 'U3', startAt: at('2026-09-17', 18, 5), endAt: at('2026-09-17', 19),
    actualMinutes: 55, fromStatus: 'completed', toStatus: 'completed', fromApprovalStatus: 'pending', toApprovalStatus: 'pending', toClientId: 'cB',
  }];
  const row = one(hoursByUserForRange(attributeWeeklyOt(entries, { tz: TZ, driveSegments: drive })), 'u3');
  ok(row.otMinutes === 55 && row.driveMinutes === 55 && row.totalMinutes === 2400 + 55, 'D1: 55 min of paid drive after 40h worked is 55 min of OT, shown as drive inside the total');
}

// ── the fetch window: whole pay weeks around the range, in a US zone ───────────
{
  const w = payWeeksWindow('2026-09-16', '2026-09-22', { tz: TZ }); // Wed → next Tue
  ok(w.fromKey === '2026-09-13' && w.toKey === '2026-09-26', `P1: Wed→Tue fetches Sun 9/13 → Sat 9/26 (got ${w.fromKey} → ${w.toKey})`);
  const s = payWeeksWindow('2026-11-01', '2026-11-15', { tz: TZ }); // both Sundays
  ok(s.fromKey === '2026-11-01' && s.toKey === '2026-11-21', `P2: a range starting and ending on a Sunday keeps both Sundays (got ${s.fromKey} → ${s.toKey})`);
  ok(Date.parse(s.toIso) >= Date.parse(at('2026-11-15', 23, 59)), 'P3: …so a punch late on the last Sunday is inside the fetch');
}

// ── a week whose punches carried no name doesn't blank the cleaner's row ───────
{
  const entries = [
    punch('u4', '2026-09-08', 9, 120, 'cA', { userName: null }), // an older week: no name on the rows
    punch('u4', '2026-09-15', 9, 120),                           // this week: named
  ];
  const row = one(hoursByUserForRange(attributeWeeklyOt(entries, { tz: TZ })), 'u4');
  ok(row.userName === 'U4' && row.totalMinutes === 240, `N1: the row reads the name a later week carries, not "—" (got ${row.userName})`);
}

console.log(`\ntest-hours-report: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
