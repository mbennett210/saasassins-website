// Headless unit checks for the payroll period-lock helpers (src/pages/payroll/periodLock.js,
// wave W3-P §8.5): the first-open-period, the open-period picker list, the reimbursement
// retarget, the closed-period lock predicate the drawer / HR pickers use, and the CSV /
// draft file naming. These encode the closed-period lock — none of this behaviour exists on
// the pre-W3-P code, so this suite fails there (the module is absent).
//   node scripts/run-tests.mjs   (auto-discovered)  ·  node scripts/test-payroll-period-lock.mjs
import {
  firstOpenPeriodKey, openPeriods, isPeriodClosed, retargetToOpenPeriodKey, csvFileName, latestClosedRun,
  payLineRemovable, reimbursementRemovable,
} from '../src/pages/payroll/periodLock.js';
import { payPeriodRange } from '../src/lib/payroll.js';
import { addDaysKey } from '../src/lib/dates.js';

const TZ = 'America/New_York';
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${name}\n      ${detail}` : name); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// A fixed "now" so payPeriodRange is deterministic. 2026-06-24 is a Wednesday.
const NOW = new Date('2026-06-24T15:00:00Z');
// Minimal run rows — the helpers read only period_key + to_key.
const runOf = (period) => ({ period_key: period.fromKey, from_key: period.fromKey, to_key: period.toKey });

// The current weekly period and the two before it, from the source of truth (payPeriodRange).
const cur = payPeriodRange('weekly', 0, NOW, TZ);
const prev = payPeriodRange('weekly', -1, NOW, TZ);
const prev2 = payPeriodRange('weekly', -2, NOW, TZ);
const prev3 = payPeriodRange('weekly', -3, NOW, TZ);
const next = payPeriodRange('weekly', 1, NOW, TZ);

// ═══ 1. firstOpenPeriodKey ═══════════════════════════════════════════════════
// No run yet → the CURRENT period is the first open one (asserted against payPeriodRange,
// never a restated literal).
eq('firstOpenPeriodKey: no runs → current period fromKey', firstOpenPeriodKey([], 'weekly', { now: NOW, tz: TZ }), cur.fromKey);
// A run closing the previous period → the first open period starts the day AFTER its to_key.
eq('firstOpenPeriodKey: after a run → day after the latest run to_key',
  firstOpenPeriodKey([runOf(prev)], 'weekly', { now: NOW, tz: TZ }), addDaysKey(prev.toKey, 1));
// With the previous period closed, day-after(prev.to_key) is exactly the current period.
eq('firstOpenPeriodKey: closing the previous period → current is first open',
  firstOpenPeriodKey([runOf(prev)], 'weekly', { now: NOW, tz: TZ }), cur.fromKey);
// The LATEST run wins even when runs are out of order.
eq('firstOpenPeriodKey: latest run wins (unordered input)',
  firstOpenPeriodKey([runOf(prev), runOf(prev3)], 'weekly', { now: NOW, tz: TZ }), addDaysKey(prev.toKey, 1));

// ═══ 2. latestClosedRun ══════════════════════════════════════════════════════
eq('latestClosedRun: none → null', latestClosedRun([]), null);
eq('latestClosedRun: picks the newest period_key', latestClosedRun([runOf(prev3), runOf(prev)]).period_key, prev.fromKey);

// ═══ 3. openPeriods (the picker list) ════════════════════════════════════════
{
  // No runs → only the current period is offered (pre-ledger past periods are NOT open —
  // a reimbursement there would never be paid by a run, spec §8.5).
  const list = openPeriods([], 'weekly', { now: NOW, tz: TZ });
  eq('openPeriods: no runs → [current] only', list.map((p) => p.fromKey), [cur.fromKey]);
}
{
  // Previous period closed → still only the current period is open.
  const list = openPeriods([runOf(prev)], 'weekly', { now: NOW, tz: TZ });
  eq('openPeriods: previous closed → [current] only', list.map((p) => p.fromKey), [cur.fromKey]);
}
{
  // A run three periods back leaves prev2, prev and current open, newest first — and NONE
  // of them is a closed run's period.
  const runs = [runOf(prev3)];
  const list = openPeriods(runs, 'weekly', { now: NOW, tz: TZ });
  eq('openPeriods: older close → current+prev+prev2 open, newest first',
    list.map((p) => p.fromKey), [cur.fromKey, prev.fromKey, prev2.fromKey]);
  ok('openPeriods: never offers a closed period', list.every((p) => !isPeriodClosed(runs, p.fromKey)));
  ok('openPeriods: every offered period starts on/after the first open period',
    list.every((p) => p.fromKey >= firstOpenPeriodKey(runs, 'weekly', { now: NOW, tz: TZ })));
}
{
  // A gap in closed territory (prev3 and prev closed, prev2 not) still uses day-after-latest:
  // the first open period is the current one, so only current is offered.
  const runs = [runOf(prev3), runOf(prev)];
  const list = openPeriods(runs, 'weekly', { now: NOW, tz: TZ });
  eq('openPeriods: latest close governs even with a gap → [current]', list.map((p) => p.fromKey), [cur.fromKey]);
}

// ═══ 4. isPeriodClosed ═══════════════════════════════════════════════════════
{
  const runs = [runOf(prev), runOf(prev3)];
  ok('isPeriodClosed: true for a run period', isPeriodClosed(runs, prev.fromKey) === true);
  ok('isPeriodClosed: false for an open period', isPeriodClosed(runs, cur.fromKey) === false);
  ok('isPeriodClosed: false for []/nullish', isPeriodClosed([], cur.fromKey) === false && isPeriodClosed(null, cur.fromKey) === false);
}

// ═══ 5. retargetToOpenPeriodKey (the reimbursement retarget) ═════════════════
{
  const runs = [runOf(prev)];
  // The chosen period is still open → unchanged.
  eq('retarget: open chosen period is unchanged', retargetToOpenPeriodKey(cur.fromKey, runs, 'weekly', { now: NOW, tz: TZ }), cur.fromKey);
  // The chosen period closed since it was chosen → pays in the first open period.
  eq('retarget: a closed chosen period moves to the first open period',
    retargetToOpenPeriodKey(prev.fromKey, runs, 'weekly', { now: NOW, tz: TZ }),
    firstOpenPeriodKey(runs, 'weekly', { now: NOW, tz: TZ }));
  eq('retarget: no runs → any chosen period is unchanged', retargetToOpenPeriodKey(prev3.fromKey, [], 'weekly', { now: NOW, tz: TZ }), prev3.fromKey);
}

// ═══ 6. csvFileName (the CSV / draft file naming) ════════════════════════════
{
  const p = { fromKey: '2026-06-01', toKey: '2026-06-15' };
  eq('csvFileName: final has no -DRAFT', csvFileName(p), 'payroll-2026-06-01_to_2026-06-15.csv');
  eq('csvFileName: draft ends -DRAFT.csv', csvFileName(p, { draft: true }), 'payroll-2026-06-01_to_2026-06-15-DRAFT.csv');
  ok('csvFileName: draft flag is the ONLY difference (both carry the period)',
    csvFileName(p, { draft: true }) === csvFileName(p).replace(/\.csv$/, '-DRAFT.csv'));
  ok('csvFileName: draft name actually ends in -DRAFT.csv', /-DRAFT\.csv$/.test(csvFileName(p, { draft: true })) && !/-DRAFT\.csv$/.test(csvFileName(p)));
}

// ═══ 7. removability: HR › Special services + Reimbursements Remove gates (W4-F finding 2) ══
// Removing a pay line in a CLOSED period is refused by orgStateGuard, and a refused save drops
// the whole batch — so the HR tabs must not offer Remove there.
{
  const runs = [runOf(prev)];   // the previous period is closed; the current one is open
  // Special-service line: removable ONLY while its period is open (mirrors !isPeriodClosed).
  ok('payLineRemovable: open period → true', payLineRemovable(runs, cur.fromKey) === true);
  ok('payLineRemovable: closed period → false', payLineRemovable(runs, prev.fromKey) === false);
  ok('payLineRemovable: no runs → always true', payLineRemovable([], prev.fromKey) === true);
  // Reimbursement: pending/rejected carry no pay line (always removable); an APPROVED one is
  // locked only when its pay line's period (= periodKey) is closed.
  ok('reimbursementRemovable: approved + closed period → false',
    reimbursementRemovable(runs, { status: 'approved', periodKey: prev.fromKey }) === false);
  ok('reimbursementRemovable: approved + open period → true',
    reimbursementRemovable(runs, { status: 'approved', periodKey: cur.fromKey }) === true);
  ok('reimbursementRemovable: pending in a closed period → true (no pay line)',
    reimbursementRemovable(runs, { status: 'pending', periodKey: prev.fromKey }) === true);
  ok('reimbursementRemovable: rejected in a closed period → true (no pay line)',
    reimbursementRemovable(runs, { status: 'rejected', periodKey: prev.fromKey }) === true);
  ok('reimbursementRemovable: nullish → true (defensive)', reimbursementRemovable(runs, null) === true);
}

if (fails.length) { console.error(`\n✖ payroll period-lock: ${fails.length} FAILED\n   - ${fails.join('\n   - ')}\n   (${pass} passed)`); process.exit(1); }
console.log(`✓ payroll period-lock — ${pass} checks passed`);
