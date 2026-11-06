// A DEAL'S WALKTHROUGH (Daniel, 2026-10-20: "Add a date and time to deals (Recommended)"), so the
// walkthrough confirmation Matt approved can go (lib/customerMessages.js walkthrough_confirm).
//
// Three fields on an opportunity, ADDITIVE and default-safe (a reader defaults to null; no version
// bump, no migration — the deal rides the shared record through the existing CAS write):
//   walkthroughAt     the walkthrough's instant (ISO). Entered as a date and a time on the ORG's
//                     clock (company.timezone, THE LAW II.8): "Nov 5, 7:30 PM" is 7:30 PM where the
//                     building is, whoever fills the form (lib/dates composeIso / splitIso).
//   walkthroughWhere  where to meet, optional, one line of at most WALKTHROUGH_WHERE_MAX characters.
//                     The approved words say "We will meet you at {site_name} …": this note is that
//                     place; with none, the company's location, else its name (lib/reminderScheduler).
//   walkthroughSetAt  WHEN the date and time were last set or changed. Never typed: the write stamps
//                     it (store/reducer ADD_OPPORTUNITY / UPDATE_OPPORTUNITY through stampWalkthrough
//                     below). The confirmation fires on a stamp younger than EVENT_MAX_AGE_HOURS on
//                     a walkthrough still ahead, keyed by the stamp: once per date set, and a changed
//                     date or time is one updated confirmation. A deal from before this build has no
//                     stamp, so switching the message on never confirms an old walkthrough.
//
// Moving a deal into "Walkthrough Scheduled" (WALKTHROUGH_STAGE_KEY, the stage key the seed's Master
// board and the legacy-key normaliser in store/persist.js both use) ASKS for the date and time: a
// prompt after the move, never a block (components/WalkthroughPrompt.jsx).
import { composeIso, splitIso, normalizeHm, isStrictHm } from './dates.js';

export const WALKTHROUGH_STAGE_KEY = 'walkthrough';
export const isWalkthroughStage = (stage) => stage === WALKTHROUGH_STAGE_KEY;

// Where to meet: a place, not a letter ("Main lobby, Suite 400").
export const WALKTHROUGH_WHERE_MAX = 120;
const cleanWhere = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, WALKTHROUGH_WHERE_MAX).trim();

/** `next` with the stamp its walkthrough change earns: set or changed → now; cleared → null. */
export function stampWalkthrough(prior, next, nowIso) {
  if (!next) return next;
  const before = prior?.walkthroughAt ?? null;
  const after = next.walkthroughAt ?? null;
  if (before === after) return next;
  return { ...next, walkthroughSetAt: after ? nowIso : null };
}

// The form's three fields → the patch the write takes, or why not.
//   { date: 'YYYY-MM-DD', time: 'HH:MM' (or typed: '7:30 pm', '1930'), where } → { patch } | { error: 'date' | 'time' }
// Both date and time empty = no walkthrough (cleared). A time that cannot be read is refused, never
// composed into a wrong instant (composeIso rolls an hour of 1975 over by days; lib/dates normalizeHm).
// `tz` is the org's zone; omitted, lib/dates' ambient org zone (set by the store from company.timezone).
export function walkthroughPatch({ date = '', time = '', where = '' } = {}, tz) {
  const d = String(date ?? '').trim();
  const typed = String(time ?? '').trim();
  const walkthroughWhere = cleanWhere(where) || null;
  if (!d && !typed) return { patch: { walkthroughAt: null, walkthroughWhere } };
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'date' };
  const hm = normalizeHm(typed);
  if (!hm || !isStrictHm(hm)) return { error: 'time' };
  return { patch: { walkthroughAt: composeIso(d, hm, tz), walkthroughWhere } };
}

/** A stored walkthrough back into the form's fields (the exact inverse of walkthroughPatch). */
export function walkthroughFields(opportunity, tz) {
  const { date, time } = splitIso(opportunity?.walkthroughAt || '', tz);
  return { date, time, where: opportunity?.walkthroughWhere || '' };
}
