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
export const GEOFENCE_REASON_LABELS = {
  [GEOFENCE_OFF_REASON]: 'Geofence off for this cleaner',
  geofence_disabled: 'Geofence off at this location',
  crew_override_offsite: 'Clocked in off-site',
  manual_entry: 'Manual entry',
};

// What each switch says on the member's Time tab. The switch reads ON for NORMAL, so the
// label states the rule, not the exception — "Must finish checklist before clocking out"
// is on until the office turns it off.
export const CLOCK_RULE_LABELS = {
  [CLOCK_RULE_KEYS.checklist]: 'Must finish checklist before clocking out',
  [CLOCK_RULE_KEYS.geofence]: 'Check location at clock-in (geofence)',
};

// The badge wording where a member is listed (the Team list, the step-6 summary).
export const CLOCK_RULE_OFF_BADGES = {
  [CLOCK_RULE_KEYS.checklist]: 'Checklist block off',
  [CLOCK_RULE_KEYS.geofence]: 'Geofence off',
};

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
