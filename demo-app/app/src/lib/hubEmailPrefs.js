// EACH CUSTOMER LOGIN'S OWN EMAIL SWITCHES (client hub redesign, plan §3.4 "Emails").
//
// Daniel, 2026-10-08: "we need to have this be on the customer to set up". A customer login picks
// its own emails on the hub's Account page — three switches, all ON by default:
//
//   messages     "Replies from the office"   the office answered in the building's Messages
//   requests     "Updates on my requests"    HUB-11: a stage change or a staff reply on a request
//                                            the login raised
//   inspections  "New inspection reports"    HUB-11: a new report for a building it can see
//
// The defaults ARE Matt's HUB-11 answer, so a login that never touches the switches gets exactly
// the emails it got before plus the new reply email. Stored in `client_users.email_prefs`
// (migration 20261008110000) as `{ messages?, requests?, inspections? }`; NULL or a missing key
// means ON, and only an explicit `false` turns one off — a value from a future version, a string
// or a number never silences anything.
//
// ONE pure reader (`hubEmailEnabled`), used by every sender (api/_lib/clientHub/notify.js) and by
// the demo, so the switch the customer sees and the email that is or is not sent can never
// disagree. PURE and node-safe: no imports.

export const HUB_EMAIL_KINDS = Object.freeze(['messages', 'requests', 'inspections']);

// Is this kind of email on for this login? `prefs` is the stored column (anything at all).
export function hubEmailEnabled(prefs, kind) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return true;
  return prefs[kind] !== false;
}

// The three switches as booleans — what the Account page shows and the route answers.
export function resolveHubEmailPrefs(prefs) {
  return Object.fromEntries(HUB_EMAIL_KINDS.map((k) => [k, hubEmailEnabled(prefs, k)]));
}

// What a customer may SEND: booleans for known keys, at least one, and nothing else. A body that
// names anything else — another login's id above all — is refused whole rather than partly
// applied: the row written is always the caller's own (the route takes the id from the claim),
// and a request that tries to say otherwise is a mistake or a probe, never a save.
export const HUB_EMAIL_PREFS_REFUSAL = 'Those email settings could not be saved. Refresh the page and try again.';
export function hubEmailPrefsInput(body) {
  const refuse = { refused: HUB_EMAIL_PREFS_REFUSAL, code: 'email-prefs' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse;
  const keys = Object.keys(body);
  if (!keys.length) return refuse;
  const patch = {};
  for (const k of keys) {
    if (!HUB_EMAIL_KINDS.includes(k) || typeof body[k] !== 'boolean') return refuse;
    patch[k] = body[k];
  }
  return { value: patch };
}

// The stored object after a patch: only the known keys survive, so a stray key written by an
// older build (or by hand) is dropped at the next save rather than carried forever.
export function mergeHubEmailPrefs(stored, patch) {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const out = {};
  for (const k of HUB_EMAIL_KINDS) {
    if (typeof patch?.[k] === 'boolean') out[k] = patch[k];
    else if (typeof base[k] === 'boolean') out[k] = base[k];
  }
  return out;
}
