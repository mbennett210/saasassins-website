// Alert DELIVERY policy — which channel a bell row is allowed to leave by, and when.
// PURE + node-safe: the push dispatcher (api/_lib/push/dispatch.js) is the only thing that
// enforces it, and the settings screens render from the same readers, so what a manager sees
// on their Account page is what the server actually does.
//
// Three decisions live here, all keyed on the notification row's `eventKey` (the dispatcher
// never sees the shift or the ticket the row came from, so the key has to carry the urgency —
// lib/ticketAlerts mints `ticketUrgent` for exactly that reason):
//
//  🔴 NTF-2 ★a (Matt, 2026-09-29) "Can managers set quiet hours? — (a) Yes — but missed
//     shifts and urgent tickets always come through." QUIET HOURS suppress the PUSH
//     only. The bell row is still written and still unread, so nothing is lost — the manager
//     finds it in the morning. There is no deferred queue: the dispatcher CLAIMS a row before
//     sending (reserve-then-send), so a row skipped for quiet hours is not re-tried later,
//     which is the whole point — a 2 a.m. ping arriving at 7 a.m. is still a ping about 2 a.m.
//
//  🔴 WO-7 ★ "Urgent tickets alert any time; the rest wait until morning." A NON-URGENT
//     ticket's push waits for the org's OFFICE HOURS (lib/officeHours). Org-wide, and scoped
//     to the ticket events only — it is not a curfew on DMs.
//
//  🔴 NTF-1 ★b "A phone notification, plus a text message for missed shifts and urgent
//     tickets." TEXTS are IN ADDITION to the push, for those two events alone, to the phone
//     on the person's profile, behind a per-user switch that is OFF until the person turns it on
//     (2026-10-28: the texting campaign covers the customer texts, so no one is texted by default).
import { areNotificationsMandatory } from './roles.js';
import { OFF_SITE_PUNCH_EVENT } from './clockRules.js';
import { isWithinOfficeHours, parseHhMm } from './officeHours.js';
import { dayKey, dayOfWeekKey, minutesInZone } from './dates.js';

// The events that ALWAYS reach the phone, whatever the hour and whatever anyone has set:
// a clean nobody turned up to, an urgent ticket, and (PAY-17) a punch that landed off the
// building's area — "the supervisor is alerted right away", and a punch is only off-site
// while somebody can still do something about it. (ALR-11 folded the old separate "late"
// event into the one missed-shift alert.)
export const ALWAYS_PUSH_EVENT_KEYS = new Set(['shiftMissed', 'ticketUrgent', OFF_SITE_PUNCH_EVENT]);

// The events whose push waits for office hours (WO-7). `problemReported` is a new ticket
// landing; `ticketUnanswered` is every later nudge about a non-urgent one.
export const OFFICE_HOURS_EVENT_KEYS = new Set(['problemReported', 'ticketUnanswered']);

// The events that ALSO go out as a text (NTF-1 ★b, and ALR-11: "the supervisor gets a
// notification and a text"). A subset of ALWAYS_PUSH by construction — a text is the
// loudest channel there is, so it is reserved for the events that are allowed to wake
// someone up. Nothing about a cleaner merely running a few minutes behind is here: that
// is how a texting channel gets muted in week one.
export const SMS_ALERT_EVENT_KEYS = new Set(['shiftMissed', 'ticketUrgent', OFF_SITE_PUNCH_EVENT]);

// Quiet-hours default when a manager switches it on without typing times.
export const QUIET_HOURS_DEFAULTS = { quietHoursStart: '21:00', quietHoursEnd: '07:00' };

// ── Quiet hours (NTF-2) ───────────────────────────────────────────────────────
// The window a user has asked not to be pushed in, or null for "no quiet hours".
// NULL for a MANDATORY-notifications role (crew): their operational alerts are not theirs to
// silence (lib/roles NOTIFICATIONS_MANDATORY_ROLES — the same policy list that refuses an
// event mute and a thread snooze), and quiet hours are a mute with a clock on it. Reading it
// here as well as stripping it at the write point means a hand-written blob value does
// nothing, which is the only kind of guard that holds on a browser-writable record.
export function quietHoursFor(user) {
  if (!user || areNotificationsMandatory(user)) return null;
  const prefs = user.notificationPrefs || {};
  if (prefs.quietHoursEnabled !== true) return null;     // opt-in, like every loud setting
  const startMins = parseHhMm(prefs.quietHoursStart ?? QUIET_HOURS_DEFAULTS.quietHoursStart);
  const endMins = parseHhMm(prefs.quietHoursEnd ?? QUIET_HOURS_DEFAULTS.quietHoursEnd);
  // A malformed or empty window is NO quiet hours rather than an all-day one: a half-typed
  // time must never silence someone's phone.
  if (startMins == null || endMins == null || startMins === endMins) return null;
  return { startMins, endMins };
}

// Is `at` inside this user's quiet hours, in the org's zone? Overnight (21:00→07:00) is the
// ordinary case, so the window wraps midnight.
export function isInQuietHours(user, at = Date.now(), tz = null) {
  const win = quietHoursFor(user);
  if (!win) return false;
  const mins = minutesInZone(at, tz);
  return win.endMins > win.startMins
    ? (mins >= win.startMins && mins < win.endMins)
    : (mins >= win.startMins || mins < win.endMins);
}

// WHY a row's push is being held back, or null when it may go out now.
//   'quiet-hours'  — this recipient's own window (NTF-2)
//   'office-hours' — a non-urgent ticket alert outside the org's hours (WO-7)
// `settings` is opsSettings (the office-hours window), `tz` the org's company.timezone.
export function pushHoldReason({ user, eventKey, at = Date.now(), settings = {}, tz = null } = {}) {
  if (ALWAYS_PUSH_EVENT_KEYS.has(eventKey)) return null;    // breaks through everything
  if (OFFICE_HOURS_EVENT_KEYS.has(eventKey) && !isWithinOfficeHours(at, settings, tz)) return 'office-hours';
  if (isInQuietHours(user, at, tz)) return 'quiet-hours';
  return null;
}

// ── Texting (NTF-1 / CS-069) ──────────────────────────────────────────────────
// "Text me alerts" is OFF by default for EVERYONE, the office tiers included (the 2026-10-28
// texting fixes: the approved A2P campaign covers the customer texts only; until 2026-10-28 it
// defaulted on for owner / admin / manager). A person's own explicit setting still wins either
// way, and the switch stays under Your Account, so anyone can turn it on. An un-backfilled
// roster reads the default (additive, default-safe → no store bump).
export const SMS_ALERTS_DEFAULT = false;
export function smsAlertsEnabled(user) {
  const v = (user?.notificationPrefs || {}).smsAlertsEnabled;
  return typeof v === 'boolean' ? v : SMS_ALERTS_DEFAULT;
}
// Twilio's "the recipient replied STOP" error. Once a carrier has recorded that opt-out,
// every further message to the number is rejected, so the number is stamped and left alone.
export const TWILIO_OPTED_OUT_CODE = 21610;
export const isSmsOptedOut = (user) => (user?.notificationPrefs || {}).smsOptedOut === true;

// E.164 for the Twilio API, from whatever shape the profile holds ('1-754-555-0101',
// '(754) 555-0101', '+1 754 555 0101'). Returns null when it cannot be made into one —
// never a guess: texting a number we invented is worse than not texting.
//   • an existing leading '+' is trusted (7…15 digits, the E.164 range);
//   • 10 digits are assumed North American and get +1 (every number in this book is);
//   • 11 digits starting 1 get a '+';
//   • anything else (a 4-digit extension, an international number typed without a '+')
//     is refused.
export function toE164(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// WHY this user is not being texted about this row, or null when they should be.
//   'not-an-sms-event' · 'inactive' · 'switched-off' · 'opted-out' · 'no-phone'
// Pure, so the test suite asserts the whole matrix without a Twilio account.
export function smsHoldReason({ user, eventKey } = {}) {
  if (!SMS_ALERT_EVENT_KEYS.has(eventKey)) return 'not-an-sms-event';
  if (!user || user.status !== 'active') return 'inactive';
  if (isSmsOptedOut(user)) return 'opted-out';
  if (!smsAlertsEnabled(user)) return 'switched-off';
  if (!toE164(user.phone)) return 'no-phone';
  return null;
}

// The day an alert text belongs to, in the org's zone — used only by the copy helpers below
// so a text and the bell row it mirrors never disagree about "today".
export const alertDayKey = (at = Date.now(), tz = null) => dayKey(at, tz);
export const alertDayOfWeek = (at = Date.now(), tz = null) => dayOfWeekKey(dayKey(at, tz));

// The body of an alert text: the bell row's own title and body, plus the brand name so the
// recipient knows who is texting. Kept short — one SMS segment is 160 characters, and a
// missed-shift text that arrives as three fragments at 2 a.m. is three buzzes.
export const SMS_MAX_BODY = 300;
export function alertSmsBody({ wordmark, title, body }) {
  const parts = [String(title || '').trim(), String(body || '').trim()].filter(Boolean);
  const text = `${wordmark ? `${wordmark}: ` : ''}${parts.join(' — ')}`.replace(/\s+/g, ' ').trim();
  return text.length > SMS_MAX_BODY ? `${text.slice(0, SMS_MAX_BODY - 1)}…` : text;
}
