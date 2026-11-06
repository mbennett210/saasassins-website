// NEW-CUSTOMER ONBOARDING (task 471 from Clean Corner's queue; UI_RULES §190).
//
// Every new customer starts the same way. Matt's list, in his email "clean corner" (2026-11-03,
// 10:46 AM PT): "these are the main fields we need for every customer: Company Name, Customer
// Number, Address: Street, City, State, ZIP Code, Primary Contact: First Name, Last Name, Title,
// Email, Phone Number, Cleaning Schedule, Assigned Cleaners, Supplies, Documents & Contracts."
// Daniel's picks (2026-11-03): an onboarding bar on the customer's own page; a step skipped with a
// note STAYS OPEN until it is filled in; every step but Company can be skipped (fixed, until Matt
// says which ones may be — tracked as his to-do); Documents & contracts is done once a signed
// contract is on file; the status reads "Onboarding" until every step is green.
// Task #507 (UI_RULES §192) adds a seventh step after Matt's list, from the same email: "When
// onboarding a new customer, we should be able to enter: Type of special service, Frequency …, Next
// scheduled service date." Daniel's pick (2026-11-04): it is green once a special service is
// entered, or once the office marks the building as having none (lib/specialServices), so every
// customer still finishes all green; like the others it may be skipped with a note.
//
// The record: `client.onboarding = { startedAt, startedBy, skipped: { [step]: { note, at, by } },
// doneAt }`, written by Add customer (ADD_CLIENT) and by the bar (UPDATE_CLIENT). Additive and
// default-safe: a customer without it (every existing and imported one) is not onboarding. A
// step's DONE is never stored — it is read from the real records each time (the customer's fields,
// its primary contact, its cleans, its cleaners, its supply list, its contracts), so the bar can
// never say a step is done that isn't. Only the skip notes and the finish stamp are stored. Once
// every step is green the page stamps `doneAt` and the customer leaves onboarding for good.
//
// PURE and node-safe (its imports are too), so the screens and the suites run it as written.
import { CONTRACT_STATUS } from './contracts.js';
import { projectHubAgreement } from './customerDocuments.js';
import { specialServicesSettled } from './specialServices.js';

// The steps, in the order of Matt's list, then his Special Services section.
export const ONBOARDING_STEPS = Object.freeze(['company', 'contact', 'schedule', 'cleaners', 'supplies', 'documents', 'special']);

// 🔴 WHICH STEPS MAY BE SKIPPED WITH A NOTE — the one place. Daniel's pick (2026-11-03): "Every
// step but Company, fixed; tracked as outstanding." Company makes the customer, so it is never
// skipped. When Matt answers, this list is the change.
export const SKIPPABLE_STEPS = Object.freeze(['contact', 'schedule', 'cleaners', 'supplies', 'documents', 'special']);
export const canSkipStep = (step) => SKIPPABLE_STEPS.includes(step);

export const STEP_STATE = Object.freeze({ done: 'done', skipped: 'skipped', todo: 'todo', unknown: 'unknown' });

// A skip note's longest (the shared record holds it).
export const ONBOARDING_NOTE_MAX = 500;

// The Company step's fields (Add customer requires every one) and the primary contact's.
export const COMPANY_FIELDS = Object.freeze(['name', 'customerNumber', 'street', 'city', 'state', 'zip']);
export const CONTACT_FIELDS = Object.freeze(['firstName', 'lastName', 'title', 'email', 'phone']);

// Each step's, state's and field's catalog line, written out whole so the catalog's checks can find
// every one (a key built at run time can't be checked).
export const STEP_TITLE_KEY = Object.freeze({
  company: 'onboarding.step.company', contact: 'onboarding.step.contact', schedule: 'onboarding.step.schedule',
  cleaners: 'onboarding.step.cleaners', supplies: 'onboarding.step.supplies', documents: 'onboarding.step.documents',
  special: 'onboarding.step.special',
});
export const STEP_SEGMENT_KEY = Object.freeze({
  company: 'onboarding.seg.company', contact: 'onboarding.seg.contact', schedule: 'onboarding.seg.schedule',
  cleaners: 'onboarding.seg.cleaners', supplies: 'onboarding.seg.supplies', documents: 'onboarding.seg.documents',
  special: 'onboarding.seg.special',
});
export const STEP_STATE_KEY = Object.freeze({
  done: 'onboarding.state.done', skipped: 'onboarding.state.skipped', todo: 'onboarding.state.todo', unknown: 'onboarding.state.unknown',
});
export const FIELD_KEY = Object.freeze({
  name: 'onboarding.field.name', customerNumber: 'onboarding.field.customerNumber', street: 'onboarding.field.street',
  city: 'onboarding.field.city', state: 'onboarding.field.state', zip: 'onboarding.field.zip',
  firstName: 'onboarding.field.firstName', lastName: 'onboarding.field.lastName', title: 'onboarding.field.title',
  email: 'onboarding.field.email', phone: 'onboarding.field.phone',
});

const filled = (v) => typeof v === 'string' ? v.trim() !== '' : v != null;

// The address is the customer's LOCATION once it has one (Add customer copies it there, and the
// Access tab edits it there); the name and number are the customer's own.
const ADDRESS_FIELDS = ['street', 'city', 'state', 'zip'];
export function missingCompanyFields(client, location = null) {
  return COMPANY_FIELDS.filter((k) => {
    const from = location && ADDRESS_FIELDS.includes(k) ? location : client;
    return !filled(from?.[k]);
  });
}
export const missingContactFields = (contact) => (contact ? CONTACT_FIELDS.filter((k) => !filled(contact[k])) : [...CONTACT_FIELDS]);

// The building has an ACTIVE contract with its signed copy uploaded — the same test the customer's
// Documents tab and the hub use (lib/customerDocuments projectHubAgreement).
export function hasSignedContractOnFile(contracts) {
  return (Array.isArray(contracts) ? contracts : [])
    .some((c) => c && c.status === CONTRACT_STATUS.active && projectHubAgreement(c).hasFile);
}

// Is this customer being onboarded now? (A vendor never is.)
export function isOnboarding(client) {
  const o = client?.onboarding;
  return !!o && typeof o === 'object' && !o.doneAt && client.type !== 'vendor';
}

// What Add customer stores on a new customer.
export function newOnboarding({ at, by = null } = {}) {
  return { startedAt: at || null, startedBy: by || null, skipped: {}, doneAt: null };
}

// The facts each step is read from, true / false, or null while a read is out (or the viewer may
// not read it). Inputs:
//   client, location (its one site), primaryContact
//   upcomingCleans  number | null — the customer's upcoming or running cleans (null: not loaded)
//   cleaners        number | null — cleaners on those cleans or linked to it by Works at
//   supplyItems     array | null  — the building's supply list (the items switched on)
//   contracts       array | null  — the building's contracts
// The special services are on the customer itself, so that step is never unknown.
export function onboardingFacts({ client, location = null, primaryContact = null, upcomingCleans = null, cleaners = null, supplyItems = null, contracts = null } = {}) {
  return {
    company: missingCompanyFields(client, location).length === 0,
    contact: missingContactFields(primaryContact).length === 0,
    schedule: upcomingCleans == null ? null : upcomingCleans > 0,
    cleaners: cleaners == null ? null : cleaners > 0,
    supplies: Array.isArray(supplyItems) ? supplyItems.length > 0 : null,
    documents: Array.isArray(contracts) ? hasSignedContractOnFile(contracts) : null,
    special: specialServicesSettled(client),
  };
}

const skipOf = (client, step) => {
  const s = client?.onboarding?.skipped?.[step];
  return s && typeof s === 'object' && typeof s.note === 'string' && s.note.trim() ? s : null;
};

// Each step's state. DONE wins (a skipped step that has since been filled in is green, and its
// note no longer shows); then SKIPPED (a note, on a step that may be skipped); then UNKNOWN (a
// read still out); else TO DO.
export function onboardingSteps(client, facts = {}) {
  return ONBOARDING_STEPS.map((step) => {
    const fact = facts[step];
    const skip = canSkipStep(step) ? skipOf(client, step) : null;
    let state = STEP_STATE.todo;
    if (fact === true) state = STEP_STATE.done;
    else if (skip) state = STEP_STATE.skipped;
    else if (fact == null) state = STEP_STATE.unknown;
    return { step, state, skip: state === STEP_STATE.skipped ? skip : null, canSkip: canSkipStep(step) };
  });
}

export function onboardingProgress(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const done = list.filter((s) => s.state === STEP_STATE.done).length;
  return { done, total: list.length, allDone: list.length > 0 && done === list.length };
}

// The step the bar opens on: the first that isn't done.
export const firstOpenStep = (steps) => (steps || []).find((s) => s.state !== STEP_STATE.done)?.step || null;

const withOnboarding = (client, patch) => ({ onboarding: { ...client.onboarding, ...patch } });

// Skip a step with a note → the UPDATE_CLIENT patch, or null (not onboarding, a step that can't be
// skipped, or no note).
export function skipStepPatch(client, step, { note, at, by = null } = {}) {
  if (!isOnboarding(client) || !canSkipStep(step)) return null;
  const text = typeof note === 'string' ? note.trim().slice(0, ONBOARDING_NOTE_MAX) : '';
  if (!text) return null;
  const skipped = { ...(client.onboarding.skipped || {}), [step]: { note: text, at: at || null, by: by || null } };
  return withOnboarding(client, { skipped });
}

export function unskipStepPatch(client, step) {
  if (!isOnboarding(client) || !client.onboarding.skipped?.[step]) return null;
  const { [step]: _gone, ...skipped } = client.onboarding.skipped;
  return withOnboarding(client, { skipped });
}

// Every step green → the finish stamp (its skip notes cleared), once. Null otherwise.
export function finishPatch(client, steps, { at } = {}) {
  if (!isOnboarding(client) || !onboardingProgress(steps).allDone) return null;
  return withOnboarding(client, { skipped: {}, doneAt: at || new Date().toISOString() });
}
