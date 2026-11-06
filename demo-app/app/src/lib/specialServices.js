// SPECIAL SERVICES (task #507 from Clean Corner's queue; UI_RULES §192).
//
// The recurring extra work at a building that is NOT on its cleaning schedule. Matt, "clean corner"
// (2026-11-03, 10:46 AM PT): "We also need a section to track recurring special services at each
// location. For example, we may have a building where we provide carpet cleaning four times a year
// or strip and wax every six months. When onboarding a new customer, we should be able to enter:
// Type of special service, Frequency (monthly, quarterly, semi-annually, annually, etc.), Next
// scheduled service date." And: "We don't need these services added to the regular cleaning
// schedule. We simply need reminders so our team knows when to coordinate the work."
//
// Daniel's answers (2026-11-04, question cards):
//   · the reminders are built here too (lib/specialServiceReminders);
//   · a 7th part on the onboarding bar, green once a service is entered or the office marks the
//     building as having none (lib/onboarding);
//   · the frequencies: Monthly, Every 2 months, Quarterly, Semi-annually, Annually, Every 2 years,
//     and Every … months for anything else (1 to 36);
//   · Mark done moves the next date on by one frequency after the SCHEDULED date (Jan 15 quarterly
//     → Apr 15); a date that has passed reads Overdue until then.
//
// THE RECORD, on the customer (`state.clients[]`; a customer is one building, its one location):
//   client.specialServices = [{ id, type, months, nextDate, lastDoneOn, lastDoneBy, createdAt, createdBy }]
//     months     the frequency, in whole months (1 to 36): ONE number, so a preset and "every 3
//                months" are the same thing and read the same name
//     nextDate   the next scheduled service, an org-zone day key 'YYYY-MM-DD'
//     lastDoneOn the day Mark done was pressed (a day key) or null; lastDoneBy who pressed it
//   client.noSpecialServices = { at, by } | null — "No special services at this building"; adding a
//     service clears it.
// Additive and default-safe: a customer without either has none entered (no version bump). Small
// and bounded (SPECIAL_SERVICES_MAX a building, Mark done replaces its last-done day rather than
// adding a history), so it belongs in the shared record beside the customer's other fields.
//
// Writes are the store's own actions (SAVE_SPECIAL_SERVICE, REMOVE_SPECIAL_SERVICE,
// MARK_SPECIAL_SERVICE_DONE, SET_NO_SPECIAL_SERVICES), one service at a time, so two people
// editing one building at once both land when the sync replays them (store/sync), and two presses
// of Mark done move the date on once. They are the customer's ordinary data: the server's guard
// names no rule for them (api/_lib/orgStateGuard "each card has its own key"), and the screens gate
// them on `clients.edit`.
//
// PURE and node-safe (its imports are too), so the screens, the reducer, the cron's walker and the
// suites run it as written.
import { addMonthsKey, diffDaysKey } from './dates.js';

// The frequency menu, in its order. Each preset is a number of months; anything else is "Every …
// months".
export const FREQUENCY_PRESETS = Object.freeze([
  { key: 'monthly', months: 1 },
  { key: 'bimonthly', months: 2 },
  { key: 'quarterly', months: 3 },
  { key: 'semiannual', months: 6 },
  { key: 'annual', months: 12 },
  { key: 'biennial', months: 24 },
]);
export const CUSTOM_FREQUENCY = 'custom';
export const FREQUENCY_KEYS = Object.freeze([...FREQUENCY_PRESETS.map((p) => p.key), CUSTOM_FREQUENCY]);
export const SPECIAL_SERVICE_MONTHS_MIN = 1;
export const SPECIAL_SERVICE_MONTHS_MAX = 36;

// The longest service name, and how many a building can hold (the shared record carries them).
export const SPECIAL_SERVICE_TYPE_MAX = 80;
export const SPECIAL_SERVICES_MAX = 40;

// How many days ahead a service reads "Due soon" on its card, and is told to the building's Account
// Manager and Operations Manager (lib/specialServiceReminders). Claude's number in the question
// Daniel answered on 2026-11-04 ("14 days is my guess"); one place to change.
export const SPECIAL_SERVICE_LEAD_DAYS = 14;

// Each frequency's catalog line, written out whole so the catalog's checks find every one.
export const FREQUENCY_LABEL_KEY = Object.freeze({
  monthly: 'specialSvc.freq.monthly',
  bimonthly: 'specialSvc.freq.bimonthly',
  quarterly: 'specialSvc.freq.quarterly',
  semiannual: 'specialSvc.freq.semiannual',
  annual: 'specialSvc.freq.annual',
  biennial: 'specialSvc.freq.biennial',
  custom: 'specialSvc.freq.custom',
});
// The name a stored frequency reads: a preset's, else "Every {months} months" (specialSvc.freq.every).
export const EVERY_MONTHS_KEY = 'specialSvc.freq.every';

export const DUE = Object.freeze({ overdue: 'overdue', soon: 'soon', later: 'later' });
export const DUE_LABEL_KEY = Object.freeze({
  overdue: 'specialSvc.due.overdue',
  soon: 'specialSvc.due.soon',
  later: 'specialSvc.due.later',
});

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day, not just its shape (2026-02-30 is refused).
export function isDayKey(v) {
  if (typeof v !== 'string' || !DAY_KEY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isMonths(n) {
  return Number.isInteger(n) && n >= SPECIAL_SERVICE_MONTHS_MIN && n <= SPECIAL_SERVICE_MONTHS_MAX;
}

// The menu's key for a stored number of months.
export function frequencyKeyOf(months) {
  return FREQUENCY_PRESETS.find((p) => p.months === months)?.key || CUSTOM_FREQUENCY;
}

// The menu's choice (and the custom months typed) → months, or null when it isn't one.
export function monthsFromChoice(key, customMonths) {
  const preset = FREQUENCY_PRESETS.find((p) => p.key === key);
  if (preset) return preset.months;
  if (key !== CUSTOM_FREQUENCY) return null;
  const n = typeof customMonths === 'number' ? customMonths : Number(String(customMonths ?? '').trim());
  return isMonths(n) ? n : null;
}

// How a stored frequency reads: { key, params } for t().
export function frequencyLabel(months) {
  const key = frequencyKeyOf(months);
  return key === CUSTOM_FREQUENCY ? { key: EVERY_MONTHS_KEY, params: { count: months } } : { key: FREQUENCY_LABEL_KEY[key], params: {} };
}

const cleanType = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, SPECIAL_SERVICE_TYPE_MAX) : '');

// A stored row that reads whole, or null (a hand-edited or damaged row is never shown or reminded).
function validRow(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) return null;
  const type = cleanType(s.type);
  if (!type || !isMonths(s.months) || !isDayKey(s.nextDate)) return null;
  return s;
}

// The building's services that read whole, soonest first (then by name).
export function specialServicesOf(client) {
  const list = Array.isArray(client?.specialServices) ? client.specialServices : [];
  return list.map(validRow).filter(Boolean)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.type.localeCompare(b.type));
}

export const hasNoSpecialServices = (client) => !!client?.noSpecialServices && specialServicesOf(client).length === 0;

// The onboarding step's fact: a service is entered, or the building is marked as having none.
export const specialServicesSettled = (client) => specialServicesOf(client).length > 0 || hasNoSpecialServices(client);

// The form's fields → the problems with them (catalog keys), empty when it can be saved.
//   { type, frequency, customMonths, nextDate }
export function specialServiceProblems({ type, frequency, customMonths, nextDate } = {}) {
  const out = [];
  if (!cleanType(type)) out.push('specialSvc.err.type');
  if (!FREQUENCY_KEYS.includes(frequency)) out.push('specialSvc.err.frequency');
  else if (monthsFromChoice(frequency, customMonths) == null) out.push('specialSvc.err.months');
  if (!isDayKey(nextDate)) out.push('specialSvc.err.date');
  return out;
}

// The row a save stores, or null when the fields don't make one. `prev` is the row being changed
// (its id, who made it and its last-done day are kept); a new one takes the caller-minted `id`.
export function specialServiceRow(fields, { prev = null, id = null, at = null, by = null } = {}) {
  if (specialServiceProblems(fields).length) return null;
  const rowId = prev?.id || id;
  if (!rowId) return null;
  return {
    id: rowId,
    type: cleanType(fields.type),
    months: monthsFromChoice(fields.frequency, fields.customMonths),
    nextDate: fields.nextDate,
    lastDoneOn: prev?.lastDoneOn || null,
    lastDoneBy: prev?.lastDoneBy || null,
    createdAt: prev?.createdAt || at || null,
    createdBy: prev?.createdBy || by || null,
  };
}

// The date Mark done moves a service to: one frequency after the SCHEDULED date (Daniel's pick),
// stepped on again while that is still on or before the day it was done, so it never lands in the
// past. Each step counts from the scheduled date (never from a day already clamped into a short
// month), so a service on the 31st stays at the month's end.
export function nextDateAfterDone(service, doneOn) {
  const s = validRow(service);
  if (!s || !isDayKey(doneOn)) return null;
  let k = 1;
  let next = addMonthsKey(s.nextDate, s.months);
  while (next <= doneOn && k < 1000) { k += 1; next = addMonthsKey(s.nextDate, s.months * k); }
  return next;
}

// How a service stands today: Overdue (its date has passed), Due soon (within the lead days) or
// later. `today` is an org-zone day key.
export function dueState(service, today) {
  const s = validRow(service);
  if (!s || !isDayKey(today)) return DUE.later;
  const days = diffDaysKey(today, s.nextDate);
  if (days < 0) return DUE.overdue;
  if (days <= SPECIAL_SERVICE_LEAD_DAYS) return DUE.soon;
  return DUE.later;
}

// The types already entered across the book, for the form's suggestions (so "Carpet cleaning" is
// typed the same way at every building), most used first, at most SPECIAL_SERVICE_SUGGESTIONS_MAX:
// a short vocabulary, however many buildings and one-off names the book holds.
export const SPECIAL_SERVICE_SUGGESTIONS_MAX = 30;
export function knownServiceTypes(clients) {
  const counts = new Map();
  for (const c of Array.isArray(clients) ? clients : []) {
    for (const s of specialServicesOf(c)) {
      const k = s.type.toLowerCase();
      const hit = counts.get(k);
      counts.set(k, { type: hit?.type || s.type, n: (hit?.n || 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.type.localeCompare(b.type))
    .slice(0, SPECIAL_SERVICE_SUGGESTIONS_MAX).map((x) => x.type);
}

// ── The reducer's four steps (store/reducer), each on one customer → its new row, or null for a
// no-op. Kept here so the suites drive the same code the store runs.

export function withServiceSaved(client, row) {
  const s = validRow(row);
  if (!client || !s) return null;
  const list = Array.isArray(client.specialServices) ? client.specialServices : [];
  const i = list.findIndex((x) => x && x.id === s.id);
  if (i < 0 && list.length >= SPECIAL_SERVICES_MAX) return null;
  const next = i < 0 ? [...list, s] : list.map((x, j) => (j === i ? s : x));
  return { ...client, specialServices: next, noSpecialServices: null };
}

export function withServiceRemoved(client, serviceId) {
  const list = Array.isArray(client?.specialServices) ? client.specialServices : [];
  if (!list.some((x) => x && x.id === serviceId)) return null;
  return { ...client, specialServices: list.filter((x) => !x || x.id !== serviceId) };
}

// Mark done, only while the service is still at the date the person saw (`fromDate`): a second
// press, or one replayed after a teammate's, moves it on once.
export function withServiceDone(client, serviceId, { fromDate, doneOn, by = null } = {}) {
  const list = Array.isArray(client?.specialServices) ? client.specialServices : [];
  const s = list.find((x) => x && x.id === serviceId);
  if (!validRow(s) || s.nextDate !== fromDate) return null;
  const nextDate = nextDateAfterDone(s, doneOn);
  if (!nextDate) return null;
  const done = { ...s, nextDate, lastDoneOn: doneOn, lastDoneBy: by || null };
  return { ...client, specialServices: list.map((x) => (x === s ? done : x)) };
}

export function withNoSpecialServices(client, none, { at = null, by = null } = {}) {
  if (!client) return null;
  if (none) {
    if (specialServicesOf(client).length || client.noSpecialServices) return null;
    return { ...client, noSpecialServices: { at: at || null, by: by || null } };
  }
  if (!client.noSpecialServices) return null;
  return { ...client, noSpecialServices: null };
}
