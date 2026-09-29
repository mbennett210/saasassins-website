// Headless checks for the HR helpers (lib/pto.js) and the payroll line feed handling
// the HR-fed categories (special-service pay, reimbursements). Run: node scripts/test-hr.mjs
import { ptoUsedDays, ptoBalance } from '../src/lib/pto.js';
import { lineTotals, grossForUser } from '../src/lib/payroll.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

// ── PTO: inclusive day spans, clamped to the calendar year, per user ──
const off = [
  { userId: 'u1', startDate: '2026-07-06', endDate: '2026-07-10' }, // 5 inclusive days
  { userId: 'u1', startDate: '2026-12-30', endDate: '2027-01-02' }, // clamps to 2 days in 2026
  { userId: 'u2', startDate: '2026-03-01', endDate: '2026-03-01' }, // 1 day, different user
];
eq('pto single range inclusive', ptoUsedDays([off[0]], 'u1', 2026), 5);
eq('pto clamps a year-spanning range', ptoUsedDays([off[1]], 'u1', 2026), 2);
eq('pto sums per user in the year', ptoUsedDays(off, 'u1', 2026), 7);
eq('pto ignores other users', ptoUsedDays(off, 'u2', 2026), 1);
eq('pto range outside the year → 0', ptoUsedDays([off[1]], 'u1', 2025), 0);
eq('pto empty ledger → 0', ptoUsedDays([], 'u1', 2026), 0);

const user = { id: 'u1', hr: { ptoAllowanceDays: 15 } };
eq('pto balance used/remaining', ptoBalance(user, off, 2026), { allowance: 15, used: 7, remaining: 8 });
eq('pto balance no allowance', ptoBalance({ id: 'u1' }, off, 2026), { allowance: 0, used: 7, remaining: 0 });

// ── Payroll line feed: special-service pay + reimbursement categories ──
const lines = [
  { category: 'special', amount: 200, taxable: true },
  { category: 'reimbursement', amount: 60, taxable: false },
];
const lt = lineTotals(lines);
eq('special buckets into byCategory', lt.byCategory.special, 200);
eq('reimbursement buckets into byCategory', lt.byCategory.reimbursement, 60);
eq('both are earnings (net +260)', [lt.earnings, lt.net], [260, 260]);
eq('reimbursement is the non-taxable portion', lt.nonTaxable, 60);
// gross = base (40h @ $20 = 800) + special 200 + reimbursement 60 = 1060
eq('gross includes special + reimbursement', grossForUser({ regularMinutes: 2400, otMinutes: 0 }, { type: 'hourly', hourlyRate: 20 }, lines), 1060);

console.log(`\nhr: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
