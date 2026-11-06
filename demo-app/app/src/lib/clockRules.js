// Per-cleaner clock rules — the office's two per-person exceptions to the clock gates
// (checklists plan step 4b, rules R6 + R7).
//
//   user.clockRules = { checklistBlockOff?: true, geofenceOff?: true }
//
// SPARSE BY CONTRACT: absent (or null) means NORMAL — the clock-out checklist block and
// the clock-in geofence both apply. Only the literal `true` turns a gate off, so a
// truthy-but-wrong value ('yes', 1) read from an old or crafted document fails CLOSED to
// the enforced behaviour. Additive and default-safe, so no store-version bump.
//
// NO React, NO browser, NO store: the server imports this too (api/_lib/time/store.js and
// the org_state guard), so the app, the demo stub and the deployed handler read ONE
// vocabulary. Keep it pure.
//
// The field is AUTHORITY, not profile. Whoever can write it can exempt a person from the
// gate that anchors attendance, so it is gated on its own permission key and protected in
// api/_lib/orgStateGuard.js (FIELD_KEYS + the own-row rule + protectedFingerprint).

import { isOffSiteVerdict, metersToFeet } from './geo.js';
import { english, msg } from '../i18n/core.js';

// The field's key names, EXACTLY as stored. Referenced by name everywhere instead of a
// bare string, so a rename is one edit and a typo is a build error, not a silent no-op.
export const CLOCK_RULE_KEYS = {
  checklist: 'checklistBlockOff',
  geofence: 'geofenceOff',
};

// The permission that may write the field (Time & Labor; owner / admin / manager by
// default). ⚠️ The GATES spell it as a literal — `usePermission('time.clockRules')`,
// `holds('time.clockRules')` — because `test-permission-references.mjs` reads gates
// statically and skips a non-literal argument by design: passing this constant would hide
// every gate from the typo guard and make the key read as decorative in the audit note.
// This export is for the maps and the tests' oracle, where no gate scanner looks.
export const CLOCK_RULES_PERM = 'time.clockRules';

// What the punch records when the geofence was skipped because it is off for THIS cleaner,
// as against 'geofence_disabled' (the site-level config). Both land in
// `time_entries.override_reason` beside `geofence_result: 'override'`, so the office can
// tell a person-level exception from a location-level one. The labels the manager surfaces
// show live in GEOFENCE_REASON_LABELS below.
export const GEOFENCE_OFF_REASON = 'geofence_off_for_cleaner';

// Human labels for `override_reason`, for the variance drill-down and the punch detail.
// A reason with no entry here renders as stored (a manager's typed correction reason).
//
// ⚠️ This map is a READER of values that are already in the table, and a stored value
// outlives the code that wrote it. PAY-17 stopped MINTING `crew_override_offsite` — a punch
// off the ring is no longer an override the cleaner confesses to, it is the verdict
// `outside`, recorded as it is — but every punch written before 2026-10-03 still carries it,
// and dropping the label would make those rows show the raw code to the office. So it stays,
// marked as legacy, until those rows age out.
export const LEGACY_CREW_OFFSITE_REASON = 'crew_override_offsite';
// Each label is a catalog line (CS-193): a screen shows t(GEOFENCE_REASON_KEYS[reason]) in its
// reader's language; GEOFENCE_REASON_LABELS is the same lines in English.
export const GEOFENCE_REASON_KEYS = {
  [GEOFENCE_OFF_REASON]: 'punch.geo.offForCleaner',
  geofence_disabled: 'punch.geo.offAtLocation',
  manual_entry: 'punch.geo.manualEntry',
  // Legacy only — no writer mints this any more (PAY-17).
  [LEGACY_CREW_OFFSITE_REASON]: 'punch.geo.legacyOffsite',
};
export const GEOFENCE_REASON_LABELS = Object.fromEntries(
  Object.entries(GEOFENCE_REASON_KEYS).map(([reason, key]) => [reason, english(key)]),
);

// ── PAY-17: an off-site punch is ALLOWED, HELD, and ALERTED ──────────────────
// Matt, 2026-09-30: "The cleaner can clock in or out; the time is held until the supervisor
// approves it, and the supervisor is alerted right away."
//
// Nothing here blocks anything. `geo.isOffSiteVerdict` says WHICH verdicts are off-site;
// this module owns what the people involved are told about it:
//   • the CLEANER gets one plain sentence — the catalog's `clock.offSite`, in their own
//     language (CS-193; components/ClockControl) — no confession, no reason field they have
//     to fill in to be allowed to work;
//   • the SUPERVISOR gets a notification on OFF_SITE_PUNCH_EVENT (push + bell + text, and
//     it breaks through quiet hours — lib/alertDelivery);
//   • the APPROVER gets the chips below, each carrying HOW FAR, because "off-site" with no
//     distance cannot be judged: forty feet past the ring and half a mile away are not the
//     same fact, and the punch is pending until someone decides which it was.
export const OFF_SITE_PUNCH_EVENT = 'offSitePunch';

// ── PAY-20: exact GPS points are kept 90 days, then only the answer ─────────
// Matt, 2026-09-30: "90 days, then only on site / off site and the distance."
//
// A punch records WHERE the device was, to the metre. What the office ever reads afterwards
// is the VERDICT and the DISTANCE — variance, the approval queue, the punch detail — and the
// raw point only matters while a punch can still be disputed. So after the horizon the six
// raw columns are cleared and the four derived ones stay: the record still says "off site,
// about 3,750 ft" without keeping a map pin on a person's movements from last quarter.
//
// The horizon and the two lists live HERE, beside the verdict they describe, so the reaper
// (api/_lib/time/store.trimStalePunchCoords, on the daily /api/cron/reap) and anything that
// quotes the policy read one definition. Clearing is a plain nulling of nullable columns —
// no migration, and nothing derived is recomputed from the point, so nothing breaks.
export const GPS_POINT_RETENTION_DAYS = 90;
export const GPS_POINT_COLUMNS = Object.freeze([
  'clock_in_lat', 'clock_in_lng', 'clock_in_accuracy_m',
  'clock_out_lat', 'clock_out_lng', 'clock_out_accuracy_m',
]);
export const GPS_DERIVED_COLUMNS = Object.freeze([
  'geofence_result', 'geofence_result_out', 'clock_in_distance_m', 'clock_out_distance_m',
]);

// Which END(s) of a punch were off-site, from the row's own two verdicts. One reader, so the
// server's alert, the approval chips and the crew's warning ask the same question.
export function offSitePunchSides(row) {
  return {
    in: isOffSiteVerdict(row?.geofence_result ?? null),
    out: isOffSiteVerdict(row?.geofence_result_out ?? null),
  };
}

// "· 3,750 ft" for a recorded distance, or '' when none was recorded. Feet is the display
// unit everywhere in this build (lib/geo converts only at the render edge); a punch with no
// location has no distance, and inventing one would be worse than saying nothing.
function feetAway(distanceM) {
  return metersToFeet(Number.isFinite(distanceM) ? distanceM : NaN);
}

// The chip an approver sees for ONE end of a punch, or null when that end says nothing.
// `side` is 'in' | 'out'; 'inside' is the expected case and adds no noise, and
// `no_site_coords` is the NORMAL state for most locations (CS-036), so neither wears a chip.
//
// An OVERRIDE (the ring switched off by CONFIG) names WHICH rule skipped it, from the same
// map the Time Clock detail's GeoBadge and the Variance drill read (W5-M F6) — a bare
// "Override" reads as "the cleaner bypassed the ring" on a punch where the office turned the
// geofence off. The clock-IN one keeps its long-standing bare label, since that is the punch's
// own verdict; only the clock-OUT one has to say which end it is about.
// As a MESSAGE (CS-193) the queue renders in its reader's language; offSiteChip below is its
// English, for everything that compares or stores the words.
export function offSiteChipMessage(row, side) {
  const out = side === 'out';
  const result = out ? (row?.geofence_result_out ?? null) : (row?.geofence_result ?? null);
  const feet = feetAway(out ? row?.clock_out_distance_m : row?.clock_in_distance_m);
  if (result === 'outside') {
    if (feet == null) return msg(out ? 'punch.flag.offSiteOut' : 'punch.flag.offSiteIn');
    return msg(out ? 'punch.flag.offSiteOutAway' : 'punch.flag.offSiteInAway', { feet });
  }
  if (result === 'unavailable') return msg(out ? 'punch.flag.noLocationOut' : 'punch.flag.noLocationIn');
  if (result === 'override') {
    const key = GEOFENCE_REASON_KEYS[out ? row?.override_reason_out : row?.override_reason] || 'punch.flag.override';
    return out ? msg('punch.flag.overrideAtOut', { label: msg(key) }) : msg(key);
  }
  return null;
}
export function offSiteChip(row, side) {
  const m = offSiteChipMessage(row, side);
  return m ? english(m) : null;
}

// ── PAY-12: the geofence verdict at CLOCK-OUT ─────────────────────────────────
// Matt, 2026-09-29: "all clock-ins and clock-outs need to be recorded at the actual site."
// The clock-out is measured by the SAME `geo.geofenceVerdict` rule the clock-in runs, on the
// clock-out coords, server-side. These four columns are the clock-in columns' twin (migration
// `20261001120000_time_entry_clock_out_geofence`), and this is the one place that maps a verdict
// onto them — the live clock-out, the offline replay and the demo stub all write through it, so
// a demo punch and a production punch cannot record differently.
//
// 🔴 NOTHING IS BLOCKED by the out verdict. A refused clock-out loses the record of work that
// already happened (THE LAW II.8). PAY-17 (2026-09-30) answered what happens instead: the punch
// is HELD — approval-gated like every punch — the account's supervisor is alerted at once, and
// the approver sees the flag and the distance (`offSiteChip` above, `punchFlags` in
// lib/filters/timeApprovals.js).
//
// `verdict` null (the fence could not be evaluated: no clean, or an unreadable blob) writes
// NOTHING, leaving the columns absent — honest, where 'inside' would be a lie and 'unavailable'
// would claim we asked the device.
export function clockOutGeofenceFields(verdict, { accuracyM } = {}) {
  if (!verdict || !verdict.result) return {};
  return {
    clock_out_distance_m: verdict.distanceM ?? null,
    clock_out_accuracy_m: Number.isFinite(accuracyM) ? accuracyM : null,
    geofence_result_out: verdict.result,
    // The verdict's own reason only — it is a SERVER fact, and the clock-out body carries no
    // override to honour (an off-site clock-out is recorded, never confirmed away).
    override_reason_out: verdict.result === 'override' ? (verdict.reason || null) : null,
  };
}

// What each switch says on the member's Time tab. The switch reads ON for NORMAL, so the
// label states the rule, not the exception — "Must finish checklist before clocking out"
// is on until the office turns it off.
// Catalog lines (CS-193): a translated screen shows t(CLOCK_RULE_LABEL_KEYS[key]); the English
// maps below are the same lines, for the screens not translated yet and anything comparing words.
export const CLOCK_RULE_LABEL_KEYS = {
  [CLOCK_RULE_KEYS.checklist]: 'cka.rule.checklist',
  [CLOCK_RULE_KEYS.geofence]: 'cka.rule.geofence',
};
export const CLOCK_RULE_LABELS = Object.fromEntries(Object.entries(CLOCK_RULE_LABEL_KEYS).map(([k, key]) => [k, english(key)]));

// The badge wording where a member is listed (the Team list, the step-6 summary).
export const CLOCK_RULE_OFF_BADGE_KEYS = {
  [CLOCK_RULE_KEYS.checklist]: 'cka.ruleOff.checklist',
  [CLOCK_RULE_KEYS.geofence]: 'cka.ruleOff.geofence',
};
export const CLOCK_RULE_OFF_BADGES = Object.fromEntries(Object.entries(CLOCK_RULE_OFF_BADGE_KEYS).map(([k, key]) => [k, english(key)]));

// Is one gate off for this member? The ONLY reader of the raw field — every gate asks
// this, so "absent means normal" and "only `true` counts" are decided in one place.
export function isClockRuleOff(user, key) {
  return user?.clockRules?.[key] === true;
}

// Which gates are off, in display order. [] for a normal member (the common case), so a
// caller can render the badge on `length`.
export function clockRulesOff(user) {
  return [CLOCK_RULE_KEYS.checklist, CLOCK_RULE_KEYS.geofence].filter((k) => isClockRuleOff(user, k));
}

// The next value of the field after one switch moves. Returns null — never `{}` — once
// nothing is off, so a member with normal rules carries no rule object: the field stays
// genuinely sparse, the org_state fingerprint returns to its previous value, and a reader
// that predates this module still sees "no rules".
export function nextClockRules(rules, key, off) {
  const next = {};
  for (const k of [CLOCK_RULE_KEYS.checklist, CLOCK_RULE_KEYS.geofence]) {
    const on = k === key ? off === true : rules?.[k] === true;
    if (on) next[k] = true;
  }
  return Object.keys(next).length ? next : null;
}
