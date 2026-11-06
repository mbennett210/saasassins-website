// CONTRACT RULES — the pure half of contract tracking (CON-1..CON-14, CS-194).
//
// Matt, 2026-10-03: "It's hundreds of them. We will enter them ourselves." So the rules that
// decide money, dates and reminders live HERE, once, and are shared by the screens, the
// server routes and the reminder cron. None of them reads a clock, a zone, a store or a
// database — every caller passes `today` as an org-zone DAY KEY, because the cron runs
// TZ=UTC and a renewal resolved in the process zone is a day wrong (THE LAW II.8).
//
// 🔴 MONEY IS INTEGER CENTS, END TO END. `baseMonthlyCents`, a year row's `monthlyCents` and
// a line's `monthlyCents` are integers; nothing here ever holds a dollar float, so a
// three-year schedule cannot drift a cent. The ONE formatter is `moneyCents` (lib/money.js).
// A money field that is NULL means "not served to this viewer" (the route strips money from
// anyone without `invoices.view`, CS-019) — never "free". Every reader must keep that
// distinction: `annualValueCents` returns null rather than 0 when it cannot price a contract,
// and the screens say "Hidden" rather than "$0.00".
//
// 🔴 DATES ARE DAY KEYS ('YYYY-MM-DD'), compared with <= and stepped with lib/dates' label
// arithmetic. A contract date is a calendar day, never an instant: a bare key parsed as a
// Date is UTC midnight and renders a day early in the org's zone (CS-145).
//
// Explicit .js on the one import — the serverless routes and the node suites load this file
// through node's ESM resolver, which (unlike Vite) does not add extensions. lib/dates has no
// imports of its own, and only its ZONE-FREE label helpers are used here.
import { addDaysKey, addMonthsKey } from './dates.js';

export const MONTHS_PER_YEAR = 12;

// How far ahead every reminder fires. Matt (CON-6/7/8/9): "60 days ahead" of each
// price-increase date, each renewal or end date, and the cancellation-notice deadline.
export const REMINDER_LEAD_DAYS = 60;

// How many renewals an auto-renewing contract plans at a time. The generator is idempotent
// and re-anchors on today, and the ops-alert cron re-runs it for any contract it fired on,
// so the chain tops itself up; this bound only stops one save minting rows for ever.
export const RENEWAL_HORIZON_YEARS = 5;

// A ceiling on the year-price schedule, so a typo in the term ("1200 months") cannot mint
// thousands of rows for the office to scroll past.
export const MAX_CONTRACT_YEARS = 25;

// An auto-renewing contract renews yearly unless the office says otherwise (CON-4 b).
export const DEFAULT_RENEWAL_TERM_MONTHS = 12;

// Back-blast guard for the cron: however many reminders come due at once (the office enters
// 700 contracts in an afternoon), at most this many bells are raised per 5-minute run. The
// rest are raised on the following runs; nothing is lost, because the reminder ROW is the
// record and the Contracts page shows it whether or not a bell went out.
export const CONTRACT_REMINDER_MAX_PER_RUN = 25;

// How long a snooze lasts when the office does not pick a date (CON-10).
export const DEFAULT_SNOOZE_DAYS = 14;

export const CONTRACT_STATUS = Object.freeze({
  draft: 'draft', active: 'active', ended: 'ended', cancelled: 'cancelled',
});
export const CONTRACT_STATUSES = Object.freeze(Object.values(CONTRACT_STATUS));
export const CONTRACT_STATUS_LABELS = Object.freeze({
  draft: 'Draft', active: 'Active', ended: 'Ended', cancelled: 'Cancelled',
});
// Badge variants (components/Badge.jsx vocabulary) — one map so no surface invents a colour.
export const CONTRACT_STATUS_VARIANTS = Object.freeze({
  draft: 'slate', active: 'green', ended: 'slate', cancelled: 'red',
});

// CON-4, Matt's three shapes, in his words.
export const TERM_TYPE = Object.freeze({
  fixed: 'fixed', auto_renew: 'auto_renew', month_to_month: 'month_to_month',
});
export const TERM_TYPES = Object.freeze(Object.values(TERM_TYPE));
export const TERM_TYPE_LABELS = Object.freeze({
  fixed: 'Fixed term (ends on its end date)',
  auto_renew: 'Renews automatically each year',
  month_to_month: 'Month-to-month after the first term',
});

export const REMINDER_KIND = Object.freeze({
  price_increase: 'price_increase',
  renewal: 'renewal',
  end: 'end',
  cancellation_notice: 'cancellation_notice',
});
export const REMINDER_KINDS = Object.freeze(Object.values(REMINDER_KIND));
export const REMINDER_KIND_LABELS = Object.freeze({
  price_increase: 'Price change',
  renewal: 'Renewal',
  end: 'Contract ends',
  cancellation_notice: 'Cancellation notice deadline',
});

export const REMINDER_STATUS = Object.freeze({ pending: 'pending', snoozed: 'snoozed', done: 'done' });
export const REMINDER_STATUSES = Object.freeze(Object.values(REMINDER_STATUS));

// Service frequency is free text with suggestions — Matt's book runs on phrases
// ("5x per week, nights"), not an enum we would have to keep extending.
export const SERVICE_FREQUENCY_SUGGESTIONS = Object.freeze([
  '7x per week', '6x per week', '5x per week', '3x per week', '2x per week',
  'Weekly', 'Bi-weekly', 'Monthly', 'Quarterly',
]);

// ── small, shared coercions ─────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDayKey = (v) => typeof v === 'string' && DAY_RE.test(v);

// A whole number of cents, or null. Rejects NaN, Infinity and a negative price — a monthly
// price below zero is a data-entry slip, not a credit, and silently storing it would make
// the book total wrong in a way nobody would spot.
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// A positive whole number (a term length, a notice period, a square footage), or null.
export function toCount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// What the office typed in a dollar field -> integer cents. Tolerates the grouping commas
// and the currency symbol a paste carries, because 700 contracts get entered by hand and a
// refused paste is a keystroke tax. Parsing is on the STRING (split on the decimal point),
// never `Math.round(parseFloat(x) * 100)`, which rounds 1234.565 the wrong way.
export function centsFromInput(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^\d*(\.\d{0,2})?$/.test(s)) return null;      // a negative, a letter, 3dp -> not a price
  const [whole, frac = ''] = s.split('.');
  if (whole === '' && frac === '') return null;
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return Number.isFinite(cents) ? cents : null;
}

// Integer cents -> the value a dollar <input> wants back. '' for hidden/absent money, so the
// field renders empty instead of '0.00', which would read as a price someone entered.
export function inputFromCents(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '';
  const n = Math.round(Number(cents));
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

// ── CON-1 / CON-4: the term and the dates it implies ────────────────────────

// The end date a start date + a term length imply: the day BEFORE the term's anniversary, so
// a 36-month term starting 2026-01-01 ends 2028-12-31 rather than running a day into 2029.
//
// It is a DEFAULT, not the truth: CON-1 says the office enters start AND end dates, so the
// stored `endDate` always wins. That matters at the month edges — `addMonthsKey` clamps into
// the target month (Jan 31 + 1 month is Feb 28), which is the repo's one month rule, and a
// contract that really ends on the 30th is simply typed in.
export function derivedEndDate({ startDate, termMonths }) {
  const months = toCount(termMonths);
  if (!isDayKey(startDate) || !months) return null;
  return addDaysKey(addMonthsKey(startDate, months), -1);
}

// The first day of each contract year, as day keys.
export function yearStartDates(startDate, count) {
  if (!isDayKey(startDate)) return [];
  const n = Math.max(0, Math.min(Math.floor(Number(count) || 0), MAX_CONTRACT_YEARS));
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(i === 0 ? startDate : addMonthsKey(startDate, i * MONTHS_PER_YEAR));
  return out;
}

// How many year-price rows a term needs. A part year still gets a whole row (an 18-month
// term prices two years), and a contract with no term length still has year 1 — a
// month-to-month agreement has a monthly price like any other.
export function yearCountFor(termMonths) {
  const months = toCount(termMonths);
  if (!months) return 1;
  return Math.max(1, Math.min(Math.ceil(months / MONTHS_PER_YEAR), MAX_CONTRACT_YEARS));
}

// CON-13: the year rows a new contract opens with — every year at the monthly price the
// office just typed, ready to be edited where it rises. Prefilling beats an empty grid when
// there are hundreds to enter and most of them are flat.
export function defaultYearRows({ startDate, termMonths, baseMonthlyCents }) {
  const cents = toCents(baseMonthlyCents);
  return yearStartDates(startDate, yearCountFor(termMonths)).map((startsOn, i) => ({
    yearNumber: i + 1, startsOn, monthlyCents: cents,
  }));
}

// Reconcile a typed schedule against the term: keep every price the office entered, extend
// with the LAST typed price (a lengthened term most often continues at the latest rate),
// trim what the term no longer covers, and re-derive every date from the start date so a
// moved start date cannot leave a row anchored to the old one.
export function normalizeYearRows(rows, { startDate, termMonths, baseMonthlyCents }) {
  const typed = Array.isArray(rows) ? [...rows].sort((a, b) => (a.yearNumber || 0) - (b.yearNumber || 0)) : [];
  const starts = yearStartDates(startDate, yearCountFor(termMonths));
  const fallback = toCents(baseMonthlyCents);
  let carry = fallback;
  return starts.map((startsOn, i) => {
    const row = typed[i];
    const cents = row ? toCents(row.monthlyCents) : null;
    if (cents !== null) carry = cents;
    return {
      ...(row && row.id ? { id: row.id } : {}),
      yearNumber: i + 1,
      startsOn,
      monthlyCents: cents !== null ? cents : carry,
    };
  });
}

// ── CON-12: what a contract is worth ────────────────────────────────────────

// The year row in effect on `today`: the latest one that has started. Before the contract
// begins, year 1 is the rate (that is what will be billed); after the last year starts it
// holds, because a contract running past its schedule bills at its last known price.
export function currentYearRow(years, today) {
  const rows = (Array.isArray(years) ? years : [])
    .filter((r) => r && isDayKey(r.startsOn))
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0));
  if (!rows.length) return null;
  let found = rows[0];
  for (const r of rows) if (r.startsOn <= today) found = r;
  return found;
}

// The monthly price in effect, in cents — or NULL when money is not served to this viewer.
export function monthlyCentsOn(contract, years, today) {
  const row = currentYearRow(years, today);
  const fromYear = row ? toCents(row.monthlyCents) : null;
  if (fromYear !== null) return fromYear;
  return toCents(contract && contract.baseMonthlyCents);
}

// CON-3: extra services (floor care, window washing) are LINES on the contract, each with
// its own monthly price. Summed in cents; a line with no price counts as nothing.
export function linesMonthlyCents(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((sum, l) => sum + (toCents(l && l.monthlyCents) || 0), 0);
}

// CON-12: "the current contract year's monthly price x 12 plus lines". Integer cents, so the
// account figure, the book total and any export agree exactly. NULL when the monthly price is
// hidden — the caller must render "Hidden", never "$0.00".
export function annualValueCents(contract, { years, lines } = {}, today) {
  const monthly = monthlyCentsOn(contract, years, today);
  if (monthly === null) return null;
  return (monthly + linesMonthlyCents(lines)) * MONTHS_PER_YEAR;
}

// WHAT CHANGED FOR THE CUSTOMER when an ACTIVE agreement was saved (the service-change
// confirmation, Matt's approved messages 2026-10-19): its frequency, its scope (the extra-service
// lines) or its monthly price (the year's price plus the lines). → the lines the email lists, in
// the customer's words, or null when nothing they would notice changed (a note, a name, a
// document, a draft). A price the saver could not see (money hidden: null) is never a change.
export function customerVisibleChange(before, after, today) {
  if (!before || !after || before.status !== CONTRACT_STATUS.active || after.status !== CONTRACT_STATUS.active) return null;
  const lines = [];
  const freqBefore = String(before.serviceFrequency || '').trim();
  const freqAfter = String(after.serviceFrequency || '').trim();
  if (freqAfter && freqAfter !== freqBefore) lines.push(`New schedule: ${freqAfter}`);
  const scope = (c) => (Array.isArray(c.lines) ? c.lines : []).map((l) => String(l?.description || '').trim()).filter(Boolean);
  const scopeBefore = scope(before);
  const scopeAfter = scope(after);
  if (scopeAfter.join('\u0000') !== scopeBefore.join('\u0000')) {
    lines.push(scopeAfter.length ? `Services: ${scopeAfter.join(', ')}` : 'Services: no extra services');
  }
  const total = (c) => {
    const m = monthlyCentsOn(c, c.years, today);
    return m === null ? null : m + linesMonthlyCents(c.lines);
  };
  const priceBefore = total(before);
  const priceAfter = total(after);
  if (priceBefore !== null && priceAfter !== null && priceAfter !== priceBefore) {
    lines.push(`New monthly rate: ${(priceAfter / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  }
  return lines.length ? lines : null;
}

// CS-663: a contract whose EVERY building is ARCHIVED has left the book — its customer has left
// every working surface. It stays on the Contracts list (marked) with its history, out of the book
// value, and its reminders stay silent. A master agreement that still covers a live building
// stays in. `archivedIds` is the book's archived customer ids (lib/customerStatus archivedClientIds).
export function contractLeftTheBook(contract, archivedIds) {
  const ids = Array.isArray(contract && contract.clientIds) ? contract.clientIds.filter(Boolean) : [];
  return !!archivedIds && ids.length > 0 && ids.every((id) => archivedIds.has(id));
}

// The whole book: every ACTIVE contract's annual value, a contract that left the book excepted
// (`archivedIds`, above). A contract whose money is hidden contributes nothing rather than
// zero-ing the total — the caller only shows this figure to a viewer who may see revenue, so in
// practice nothing is skipped.
export function bookValueCents(entries, today, archivedIds = null) {
  return (Array.isArray(entries) ? entries : []).reduce((sum, e) => {
    const c = e && e.contract;
    if (!c || c.status !== CONTRACT_STATUS.active) return sum;
    if (contractLeftTheBook(c, archivedIds)) return sum;
    const v = annualValueCents(c, { years: e.years, lines: e.lines }, today);
    return v === null ? sum : sum + v;
  }, 0);
}

// ── CON-6..9: the dates worth a reminder ────────────────────────────────────

// CON-8: the last day to give notice — the end date minus the notice period.
export function cancellationDeadline(contract) {
  const days = toCount(contract && contract.cancellationNoticeDays);
  const end = contract && contract.endDate;
  if (!isDayKey(end) || !days) return null;
  return addDaysKey(end, -days);
}

// CON-4 b / CON-7: when an auto-renewing contract rolls over. The first renewal is the day
// after the first term ends; each one after it is `renewalTermMonths` later (a year unless
// the office says otherwise). Dates already past are skipped — a contract entered today that
// has been renewing since 2019 needs the NEXT renewal, not eleven historical ones — and the
// list is bounded by RENEWAL_HORIZON_YEARS.
export function renewalDates(contract, today) {
  if (!contract || contract.termType !== TERM_TYPE.auto_renew) return [];
  const step = toCount(contract.renewalTermMonths) || DEFAULT_RENEWAL_TERM_MONTHS;
  const end = isDayKey(contract.endDate)
    ? contract.endDate
    : derivedEndDate({ startDate: contract.startDate, termMonths: contract.termMonths });
  if (!isDayKey(end)) return [];
  let at = addDaysKey(end, 1);
  // Walk forward to the first renewal that has not happened yet. Bounded hard: a corrupt
  // step can never spin here, because the loop count is capped as well as the date.
  for (let i = 0; at < today && i < 200; i += 1) at = addMonthsKey(at, step);
  const out = [];
  for (let i = 0; i < RENEWAL_HORIZON_YEARS; i += 1) {
    out.push(at);
    at = addMonthsKey(at, step);
  }
  return out;
}

// CON-5/CON-6: the day each year's price differs from the year before it. A DROP counts as
// well as a rise — the office still wants sixty days' warning before the invoice changes.
export function priceChangeDates(years) {
  const rows = (Array.isArray(years) ? years : [])
    .filter((r) => r && isDayKey(r.startsOn))
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0));
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = toCents(rows[i - 1].monthlyCents);
    const cur = toCents(rows[i].monthlyCents);
    if (prev === null || cur === null) continue;      // money hidden -> no claim either way
    if (prev !== cur) out.push(rows[i].startsOn);
  }
  return out;
}

// THE reminder schedule for one contract: every date that matters, each with the day it
// becomes due (REMINDER_LEAD_DAYS ahead). Idempotent and anchored on `today`, so the save
// path and the cron's top-up produce the same rows.
//
// Only an ACTIVE contract plans anything — a draft is not signed and an ended or cancelled
// one has nothing left to warn about. Dates already past are never planned (the back-blast
// guard that keeps a bulk import of historical contracts silent).
export function contractReminderPlan(contract, { years } = {}, today) {
  if (!contract || contract.status !== CONTRACT_STATUS.active || !isDayKey(today)) return [];
  const targets = [];
  for (const d of priceChangeDates(years)) targets.push({ kind: REMINDER_KIND.price_increase, targetDate: d });
  for (const d of renewalDates(contract, today)) targets.push({ kind: REMINDER_KIND.renewal, targetDate: d });
  // An auto-renewing contract does not END on its first term, so it gets no end reminder —
  // its renewal reminder is the one that matters.
  if (contract.termType !== TERM_TYPE.auto_renew && isDayKey(contract.endDate)) {
    targets.push({ kind: REMINDER_KIND.end, targetDate: contract.endDate });
  }
  const notice = cancellationDeadline(contract);
  if (notice) targets.push({ kind: REMINDER_KIND.cancellation_notice, targetDate: notice });

  const seen = new Set();
  return targets
    .filter((t) => isDayKey(t.targetDate) && t.targetDate >= today)
    .filter((t) => {
      const k = `${t.kind}|${t.targetDate}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((t) => ({ ...t, dueOn: addDaysKey(t.targetDate, -REMINDER_LEAD_DAYS) }))
    .sort((a, b) => (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : 0));
}

// Does a STORED reminder fire today? One definition, so the cron's SQL predicate, the screens'
// "Due" pill and the tests cannot disagree.
//   · done            -> never again
//   · notifiedAt set  -> already rung; the stamp IS the dedup (CON-10)
//   · snoozed         -> waits for nextDueOn, which the snooze moved
//   · target past     -> stale; the renewal already happened, so a bell would only confuse
export function reminderIsDue(reminder, today) {
  if (!reminder || !isDayKey(today)) return false;
  if (reminder.status === REMINDER_STATUS.done) return false;
  if (reminder.notifiedAt) return false;
  const due = isDayKey(reminder.nextDueOn) ? reminder.nextDueOn : reminder.dueOn;
  if (!isDayKey(due) || due > today) return false;
  return !isDayKey(reminder.targetDate) || reminder.targetDate >= today;
}

// ── CON-2 / CON-14: one ACTIVE contract per building ────────────────────────

// Which of `clientIds` are already covered by a DIFFERENT active contract.
// `existing` is every stored building row as `{ contractId, clientId, status }` (the status of
// the contract it belongs to). Pure, so the server route and the editor's warning run the
// same rule — the route is the boundary (the database carries the matching partial unique
// index), and this is what lets the screen say which buildings before the save is attempted.
//
// Only going ACTIVE is refused: a DRAFT may be prepared over a building whose current
// contract is still running, which is exactly how a renewal gets written before it is signed.
export function buildingConflicts({ contractId, clientIds, status }, existing) {
  if (status !== CONTRACT_STATUS.active) return [];
  const want = new Set((Array.isArray(clientIds) ? clientIds : []).filter(Boolean));
  if (!want.size) return [];
  const taken = new Set();
  for (const row of Array.isArray(existing) ? existing : []) {
    if (!row || row.status !== CONTRACT_STATUS.active) continue;
    if (contractId && row.contractId === contractId) continue;   // itself is never a conflict
    if (want.has(row.clientId)) taken.add(row.clientId);
  }
  return [...taken];
}

// ── the bell's words (CON-6..9), shared by the cron and the screens ─────────

// One sentence per kind. The cron has no org timezone and a stored string cannot be re-zoned
// later, so the DATE is passed in already formatted by the caller (activity-log rule).
export function reminderTitle(kind, subject) {
  const who = subject || 'a customer';
  if (kind === REMINDER_KIND.renewal) return `${who} is up for renewal`;
  if (kind === REMINDER_KIND.end) return `${who}'s contract is ending`;
  if (kind === REMINDER_KIND.cancellation_notice) return `${who}: cancellation notice deadline`;
  if (kind === REMINDER_KIND.price_increase) return `${who}: contract price changes`;
  return `${who}: contract reminder`;
}

export function reminderBody(kind, { dateText, daysAhead }) {
  const when = dateText ? ` on ${dateText}` : '';
  const lead = Number.isFinite(Number(daysAhead)) ? ` (${Math.max(0, Math.round(daysAhead))} days away)` : '';
  if (kind === REMINDER_KIND.renewal) return `The contract renews${when}${lead}.`;
  if (kind === REMINDER_KIND.end) return `The contract ends${when}${lead}.`;
  if (kind === REMINDER_KIND.cancellation_notice) return `Notice to cancel must be given by${when ? when.replace(' on ', ' ') : ' the deadline'}${lead}.`;
  if (kind === REMINDER_KIND.price_increase) return `The monthly price changes${when}${lead}.`;
  return `A contract date is coming up${when}${lead}.`;
}
