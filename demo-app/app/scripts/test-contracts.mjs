// The CONTRACT rules — money, dates, the reminder schedule and the one-active-contract
// invariant (CON-1..CON-14, CS-194). Pure + offline: `src/lib/contracts.js` imports only
// lib/dates' day-key arithmetic, so node runs this headless with no store and no network.
//
// Every money figure is INTEGER CENTS and every date an org-zone DAY KEY ('YYYY-MM-DD')
// passed in EXPLICITLY — the lib never reads an ambient clock or zone, because the cron
// runs TZ=UTC and a reminder resolved in the process zone is a day wrong (THE LAW II.8).
//
// Assertions compute expected values from the module's OWN exported constants
// (REMINDER_LEAD_DAYS, MONTHS_PER_YEAR …) rather than restating a literal, so a changed
// rule fails here instead of quietly agreeing with a stale copy.
//
//   node app/scripts/test-contracts.mjs
import assert from 'node:assert/strict';
import { addDaysKey, addMonthsKey } from '../src/lib/dates.js';
import {
  CONTRACT_STATUS, TERM_TYPE, REMINDER_KIND, REMINDER_KINDS,
  REMINDER_LEAD_DAYS, MONTHS_PER_YEAR, RENEWAL_HORIZON_YEARS, MAX_CONTRACT_YEARS,
  DEFAULT_RENEWAL_TERM_MONTHS,
  derivedEndDate, yearStartDates, defaultYearRows, normalizeYearRows,
  currentYearRow, monthlyCentsOn, linesMonthlyCents, annualValueCents, bookValueCents,
  cancellationDeadline, renewalDates, priceChangeDates, contractReminderPlan,
  reminderIsDue, buildingConflicts, centsFromInput, inputFromCents,
} from '../src/lib/contracts.js';
import { moneyCents } from '../src/lib/money.js';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, fn) — stated here so nobody has to guess (the repo's suites differ).
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

const TODAY = '2026-10-03';
// A three-year fixed contract starting at the top of 2026, with a rise in years 2 and 3.
const base = (over = {}) => ({
  id: 'ct1',
  status: CONTRACT_STATUS.active,
  startDate: '2026-01-01',
  endDate: '2028-12-31',
  termType: TERM_TYPE.fixed,
  termMonths: 36,
  renewalTermMonths: null,
  cancellationNoticeDays: 90,
  baseMonthlyCents: 125075,
  ...over,
});
const years = [
  { yearNumber: 1, startsOn: '2026-01-01', monthlyCents: 125075 },
  { yearNumber: 2, startsOn: '2027-01-01', monthlyCents: 128900 },
  { yearNumber: 3, startsOn: '2028-01-01', monthlyCents: 132800 },
];
const lines = [
  { description: 'Floor care', monthlyCents: 25000 },
  { description: 'Window washing', monthlyCents: 7550 },
];
const kinds = (plan) => plan.map((r) => `${r.kind}@${r.targetDate}`);

console.log('\n── CON-1/CON-4: the term, and the end date it implies ──');

ok('a 36-month term ending the day before the fourth anniversary', () => {
  assert.equal(derivedEndDate({ startDate: '2026-01-01', termMonths: 36 }), '2028-12-31');
});
ok('derived from the module\'s own month arithmetic, not a restated literal', () => {
  const months = 18;
  assert.equal(
    derivedEndDate({ startDate: '2026-04-15', termMonths: months }),
    addDaysKey(addMonthsKey('2026-04-15', months), -1),
  );
});
ok('no term length means no derived end date (month-to-month runs on)', () => {
  assert.equal(derivedEndDate({ startDate: '2026-01-01', termMonths: null }), null);
  assert.equal(derivedEndDate({ startDate: '', termMonths: 12 }), null);
});
ok('a nonsense term never produces a date', () => {
  assert.equal(derivedEndDate({ startDate: '2026-01-01', termMonths: 0 }), null);
  assert.equal(derivedEndDate({ startDate: '2026-01-01', termMonths: -6 }), null);
  assert.equal(derivedEndDate({ startDate: '2026-01-01', termMonths: 'soon' }), null);
});

console.log('\n── CON-5/CON-13: each contract year\'s monthly price, prefilled from the term ──');

ok('year starts are whole-year steps off the start date', () => {
  assert.deepEqual(yearStartDates('2026-01-01', 3), ['2026-01-01', '2027-01-01', '2028-01-01']);
  assert.deepEqual(
    yearStartDates('2026-04-15', 2),
    ['2026-04-15', addMonthsKey('2026-04-15', MONTHS_PER_YEAR)],
  );
});
ok('a 36-month term prefills THREE year rows, all at the entered monthly price (CON-13)', () => {
  const rows = defaultYearRows({ startDate: '2026-01-01', termMonths: 36, baseMonthlyCents: 125075 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.yearNumber), [1, 2, 3]);
  assert.deepEqual([...new Set(rows.map((r) => r.monthlyCents))], [125075], 'every year starts at the base price');
});
ok('a part-year term still gets a whole year row (an 18-month term is two)', () => {
  assert.equal(defaultYearRows({ startDate: '2026-01-01', termMonths: 18, baseMonthlyCents: 1 }).length, 2);
  assert.equal(defaultYearRows({ startDate: '2026-01-01', termMonths: 1, baseMonthlyCents: 1 }).length, 1);
});
ok('no term at all still gets year 1 — a month-to-month contract has a price', () => {
  const rows = defaultYearRows({ startDate: '2026-01-01', termMonths: null, baseMonthlyCents: 90000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].monthlyCents, 90000);
});
ok('an absurd term is capped, so a typo cannot mint thousands of rows', () => {
  const rows = defaultYearRows({ startDate: '2026-01-01', termMonths: 12000, baseMonthlyCents: 1 });
  assert.equal(rows.length, MAX_CONTRACT_YEARS);
});
ok('normalizing KEEPS the prices the office typed and re-derives the dates', () => {
  const typed = [
    { yearNumber: 1, startsOn: 'whatever', monthlyCents: 100000 },
    { yearNumber: 2, startsOn: 'whatever', monthlyCents: 110000 },
  ];
  const rows = normalizeYearRows(typed, { startDate: '2026-03-01', termMonths: 36, baseMonthlyCents: 100000 });
  assert.equal(rows.length, 3, 'extended to the term');
  assert.deepEqual(rows.map((r) => r.monthlyCents), [100000, 110000, 110000], 'year 3 carries the last typed price forward');
  assert.deepEqual(rows.map((r) => r.startsOn), yearStartDates('2026-03-01', 3));
});
ok('normalizing TRIMS when the term shortens — a dropped year must not keep billing', () => {
  const rows = normalizeYearRows(years, { startDate: '2026-01-01', termMonths: 12, baseMonthlyCents: 125075 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].monthlyCents, 125075);
});

console.log('\n── CON-12: annual value, in integer cents, for the CURRENT contract year ──');

ok('the current year is the latest one that has started', () => {
  assert.equal(currentYearRow(years, '2026-06-01').yearNumber, 1);
  assert.equal(currentYearRow(years, '2027-01-01').yearNumber, 2, 'the changeover day is already the new year');
  assert.equal(currentYearRow(years, '2027-12-31').yearNumber, 2);
  assert.equal(currentYearRow(years, '2028-01-01').yearNumber, 3);
});
ok('before it starts, year 1 is the rate; after it ends, the last year holds', () => {
  assert.equal(currentYearRow(years, '2025-12-31').yearNumber, 1);
  assert.equal(currentYearRow(years, '2030-01-01').yearNumber, 3);
});
ok('the monthly price falls back to the contract base when there are no year rows', () => {
  assert.equal(monthlyCentsOn(base(), [], TODAY), 125075);
  assert.equal(monthlyCentsOn(base(), years, '2027-05-05'), 128900);
});
ok('lines sum in cents — a monthly extra service, never a yearly one', () => {
  assert.equal(linesMonthlyCents(lines), 32550);
  assert.equal(linesMonthlyCents([]), 0);
  assert.equal(linesMonthlyCents(null), 0);
  assert.equal(linesMonthlyCents([{ monthlyCents: null }, { monthlyCents: '12' }]), 12);
});
ok('annual value = (this year\'s monthly + the lines) x 12, exact to the cent', () => {
  const v = annualValueCents(base(), { years, lines }, '2027-05-05');
  assert.equal(v, (128900 + 32550) * MONTHS_PER_YEAR);
  assert.equal(v, 1937400);
});
ok('it moves on the changeover day, not a day either side', () => {
  const dayBefore = annualValueCents(base(), { years, lines }, '2026-12-31');
  const day = annualValueCents(base(), { years, lines }, '2027-01-01');
  assert.equal(dayBefore, (125075 + 32550) * MONTHS_PER_YEAR);
  assert.notEqual(day, dayBefore);
});
ok('HIDDEN money is null, never zero — a stripped payload must not read as a free contract', () => {
  const stripped = base({ baseMonthlyCents: null });
  assert.equal(monthlyCentsOn(stripped, [], TODAY), null);
  assert.equal(annualValueCents(stripped, { years: [], lines: [] }, TODAY), null);
});
ok('the book total sums only ACTIVE contracts, and skips what it cannot price', () => {
  const a = { contract: base({ id: 'a' }), years, lines };
  const b = { contract: base({ id: 'b', status: CONTRACT_STATUS.ended }), years, lines };
  const c = { contract: base({ id: 'c', status: CONTRACT_STATUS.draft }), years: [], lines: [] };
  const d = { contract: base({ id: 'd', baseMonthlyCents: null }), years: [], lines: [] };
  assert.equal(bookValueCents([a, b, c, d], '2027-05-05'), (128900 + 32550) * MONTHS_PER_YEAR);
});
ok('cents never round through a float — 1,250.75 x 12 is exactly $15,009.00', () => {
  const v = annualValueCents(base({ baseMonthlyCents: 125075 }), { years: [], lines: [] }, TODAY);
  assert.equal(v, 1500900);
  assert.equal(moneyCents(v), '$15,009.00');
  assert.equal(moneyCents(125075), '$1,250.75');
  assert.equal(moneyCents(20), '$0.20');
});
ok('a typed dollar amount round-trips through cents without drift', () => {
  assert.equal(centsFromInput('1250.75'), 125075);
  assert.equal(centsFromInput('1,250.75'), 125075);
  assert.equal(centsFromInput('$1,250.7'), 125070);
  assert.equal(centsFromInput('0.20'), 20);
  assert.equal(centsFromInput(''), null);
  assert.equal(centsFromInput('abc'), null);
  assert.equal(centsFromInput('-5'), null, 'a negative monthly price is not a price');
  assert.equal(inputFromCents(125075), '1250.75');
  assert.equal(inputFromCents(null), '');
  assert.equal(centsFromInput(inputFromCents(125075)), 125075);
});

console.log('\n── CON-1/CON-8: the cancellation-notice deadline ──');

ok('the deadline is the end date minus the notice period', () => {
  assert.equal(cancellationDeadline(base()), addDaysKey('2028-12-31', -90));
  assert.equal(cancellationDeadline(base()), '2028-10-02');
});
ok('no end date or no notice period means no deadline', () => {
  assert.equal(cancellationDeadline(base({ endDate: null })), null);
  assert.equal(cancellationDeadline(base({ cancellationNoticeDays: 0 })), null);
  assert.equal(cancellationDeadline(base({ cancellationNoticeDays: null })), null);
});

console.log('\n── CON-4/CON-7: renewal dates ──');

ok('a FIXED contract never renews — it ends', () => {
  assert.deepEqual(renewalDates(base(), TODAY), []);
});
ok('an auto-renewing contract renews the day after each term ends, yearly', () => {
  const c = base({ termType: TERM_TYPE.auto_renew, termMonths: 12, endDate: '2026-12-31', renewalTermMonths: null });
  const dates = renewalDates(c, TODAY);
  assert.equal(dates[0], '2027-01-01', 'the first renewal is the day after the first term ends');
  assert.equal(dates[1], addMonthsKey('2027-01-01', DEFAULT_RENEWAL_TERM_MONTHS));
  assert.equal(dates.length, RENEWAL_HORIZON_YEARS, 'a bounded horizon, re-generated on every save');
});
ok('a non-yearly renewal term is honoured', () => {
  const c = base({ termType: TERM_TYPE.auto_renew, termMonths: 24, endDate: '2027-12-31', renewalTermMonths: 24 });
  const dates = renewalDates(c, TODAY);
  assert.equal(dates[0], '2028-01-01');
  assert.equal(dates[1], addMonthsKey('2028-01-01', 24));
});
ok('renewals already in the past are dropped — nobody needs a 2019 reminder', () => {
  const c = base({ termType: TERM_TYPE.auto_renew, termMonths: 12, endDate: '2019-12-31' });
  const dates = renewalDates(c, TODAY);
  assert.ok(dates.every((d) => d >= TODAY), `every renewal must be in the future: ${dates.join(',')}`);
  assert.ok(dates.length > 0, 'the chain still reaches forward to today');
});
ok('MONTH-TO-MONTH has no renewal date — it just continues', () => {
  assert.deepEqual(renewalDates(base({ termType: TERM_TYPE.month_to_month, endDate: '2026-12-31' }), TODAY), []);
});

console.log('\n── CON-5/CON-6: price-change dates ──');

ok('every year whose price differs from the one before it is a change date', () => {
  assert.deepEqual(priceChangeDates(years), ['2027-01-01', '2028-01-01']);
});
ok('a flat schedule has no change dates', () => {
  const flat = years.map((y) => ({ ...y, monthlyCents: 125075 }));
  assert.deepEqual(priceChangeDates(flat), []);
});
ok('a price DROP counts too — the office still wants to know before it lands', () => {
  const down = [
    { yearNumber: 1, startsOn: '2026-01-01', monthlyCents: 120000 },
    { yearNumber: 2, startsOn: '2027-01-01', monthlyCents: 110000 },
  ];
  assert.deepEqual(priceChangeDates(down), ['2027-01-01']);
});

console.log('\n── CON-6..9: the reminder plan — 60 days ahead of every date that matters ──');

ok('an ACTIVE fixed contract plans an end, a notice deadline and each price change', () => {
  const plan = contractReminderPlan(base(), { years }, '2026-06-01');
  assert.deepEqual(kinds(plan).sort(), [
    `${REMINDER_KIND.cancellation_notice}@2028-10-02`,
    `${REMINDER_KIND.end}@2028-12-31`,
    `${REMINDER_KIND.price_increase}@2027-01-01`,
    `${REMINDER_KIND.price_increase}@2028-01-01`,
  ].sort());
});
ok('every reminder is due exactly REMINDER_LEAD_DAYS before its date', () => {
  const plan = contractReminderPlan(base(), { years }, '2026-06-01');
  for (const r of plan) {
    assert.equal(r.dueOn, addDaysKey(r.targetDate, -REMINDER_LEAD_DAYS), `${r.kind}@${r.targetDate}`);
  }
});
ok('the plan is sorted by date and carries only known kinds', () => {
  const plan = contractReminderPlan(base(), { years }, '2026-06-01');
  const dates = plan.map((r) => r.targetDate);
  assert.deepEqual(dates, [...dates].sort(), 'soonest first');
  for (const r of plan) assert.ok(REMINDER_KINDS.includes(r.kind), `unknown kind ${r.kind}`);
});
ok('BACK-BLAST GUARD: a date already past is never planned', () => {
  // Entered today, this contract's price changes and end are all behind us.
  const plan = contractReminderPlan(base(), { years }, '2029-06-01');
  assert.deepEqual(plan, [], 'a historical contract entered today raises nothing');
});
ok('an auto-renewing contract plans its renewals', () => {
  const c = base({ termType: TERM_TYPE.auto_renew, termMonths: 12, endDate: '2026-12-31', cancellationNoticeDays: 30 });
  const plan = contractReminderPlan(c, { years: [] }, '2026-06-01');
  const renewals = plan.filter((r) => r.kind === REMINDER_KIND.renewal);
  assert.equal(renewals.length, RENEWAL_HORIZON_YEARS);
  assert.equal(renewals[0].targetDate, '2027-01-01');
  assert.ok(plan.some((r) => r.kind === REMINDER_KIND.cancellation_notice && r.targetDate === addDaysKey('2026-12-31', -30)));
  assert.equal(plan.some((r) => r.kind === REMINDER_KIND.end), false, 'an auto-renewing contract does not END on its first term');
});
ok('a contract that is NOT active plans nothing — draft, ended and cancelled are silent', () => {
  for (const status of [CONTRACT_STATUS.draft, CONTRACT_STATUS.ended, CONTRACT_STATUS.cancelled]) {
    assert.deepEqual(contractReminderPlan(base({ status }), { years }, '2026-06-01'), [], status);
  }
});
ok('the plan is deduped — one row per kind and date however the dates line up', () => {
  // A zero-day notice period would otherwise put the notice deadline ON the end date.
  const c = base({ cancellationNoticeDays: 1 });
  const plan = contractReminderPlan(c, { years: [] }, '2026-06-01');
  const seen = kinds(plan);
  assert.equal(seen.length, new Set(seen).size);
});

console.log('\n── CON-10: when a stored reminder actually fires ──');

const rem = (over = {}) => ({
  kind: REMINDER_KIND.renewal, targetDate: '2027-01-01', dueOn: '2026-11-02',
  nextDueOn: '2026-11-02', status: 'pending', notifiedAt: null, ...over,
});

ok('due once its due date arrives', () => {
  assert.equal(reminderIsDue(rem(), '2026-11-01'), false);
  assert.equal(reminderIsDue(rem(), '2026-11-02'), true);
  assert.equal(reminderIsDue(rem(), '2026-12-25'), true);
});
ok('already notified never fires twice — the stamp IS the dedup', () => {
  assert.equal(reminderIsDue(rem({ notifiedAt: '2026-11-02T13:00:00.000Z' }), '2026-12-01'), false);
});
ok('marked DONE never fires', () => {
  assert.equal(reminderIsDue(rem({ status: 'done' }), '2026-12-01'), false);
});
ok('SNOOZED waits for the snooze date, then fires', () => {
  const snoozed = rem({ status: 'snoozed', nextDueOn: '2026-12-01' });
  assert.equal(reminderIsDue(snoozed, '2026-11-15'), false);
  assert.equal(reminderIsDue(snoozed, '2026-12-01'), true);
});
ok('a reminder whose date has PASSED is stale and never fires', () => {
  assert.equal(reminderIsDue(rem(), '2027-01-02'), false, 'the renewal already happened');
  assert.equal(reminderIsDue(rem(), '2027-01-01'), true, 'the day itself still counts');
});

console.log('\n── CON-2/CON-14: a building is on ONE active contract at a time ──');

ok('a building already covered by another ACTIVE contract is a conflict', () => {
  const existing = [
    { contractId: 'ctA', clientId: 'cl1', status: CONTRACT_STATUS.active },
    { contractId: 'ctA', clientId: 'cl2', status: CONTRACT_STATUS.active },
  ];
  assert.deepEqual(
    buildingConflicts({ contractId: 'ctB', clientIds: ['cl2', 'cl3'], status: CONTRACT_STATUS.active }, existing),
    ['cl2'],
  );
});
ok('a MASTER agreement over ten buildings is fine while none is taken', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `cl${i}`);
  assert.deepEqual(buildingConflicts({ contractId: 'ctB', clientIds: ten, status: CONTRACT_STATUS.active }, []), []);
});
ok('re-saving the SAME contract never conflicts with itself', () => {
  const existing = [{ contractId: 'ctA', clientId: 'cl1', status: CONTRACT_STATUS.active }];
  assert.deepEqual(buildingConflicts({ contractId: 'ctA', clientIds: ['cl1'], status: CONTRACT_STATUS.active }, existing), []);
});
ok('an ENDED contract releases its buildings — the replacement can be signed', () => {
  const existing = [{ contractId: 'ctA', clientId: 'cl1', status: CONTRACT_STATUS.ended }];
  assert.deepEqual(buildingConflicts({ contractId: 'ctB', clientIds: ['cl1'], status: CONTRACT_STATUS.active }, existing), []);
});
ok('a DRAFT may overlap — only going ACTIVE is refused', () => {
  const existing = [{ contractId: 'ctA', clientId: 'cl1', status: CONTRACT_STATUS.active }];
  assert.deepEqual(buildingConflicts({ contractId: 'ctB', clientIds: ['cl1'], status: CONTRACT_STATUS.draft }, existing), []);
});
ok('every conflicting building is reported, not just the first', () => {
  const existing = [
    { contractId: 'ctA', clientId: 'cl1', status: CONTRACT_STATUS.active },
    { contractId: 'ctC', clientId: 'cl2', status: CONTRACT_STATUS.active },
  ];
  assert.deepEqual(
    buildingConflicts({ contractId: 'ctB', clientIds: ['cl1', 'cl2'], status: CONTRACT_STATUS.active }, existing).sort(),
    ['cl1', 'cl2'],
  );
});

console.log(`\n${fails.length ? '✗' : '✓'} contract rules: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
