// WHEN, and AT WHAT TIME, the hourly auto-close cron closes a forgotten punch (CS-667; PAY-10).
// Pure and node-safe (`.js` on every import): the server store (api/_lib/time/store.js
// autoCloseStale) runs it, the approval queue and the cleaner's card read what it wrote.
//
// THE TWO SHAPES.
//   · A punch that started BEFORE its clean's scheduled end closes AT the scheduled end, once
//     the end + the grace (`opsSettings.autoCloseGraceMins`) has passed — PAY-10, Matt
//     2026-09-29: "the system will clock them out at 4 pm and ask for approval". An overrun
//     past the scheduled end is cut there; the approver rules on it. Unchanged.
//   · 🔴 A punch that started AT OR AFTER the scheduled end — the clock-in window runs to the
//     end + the grace (lib/clockInWindow), so a late cleaner can — used to get the same
//     scheduled-end clock-out: a clock-out BEFORE the clock-in, duration null (0 paid), the
//     clean marked done under a cleaner still working there, and "Clocked out" on their card.
//     Now it is credited the clean's SCHEDULED LENGTH from their own clock-in (at most the
//     grace, so a forgotten punch on a long clean cannot run on unchecked), and closed only a
//     grace after THAT — the same tolerance every other punch gets past its anchor. Flagged:
//     the approval queue shows "Auto-closed · late start" with the sentence below, the cleaner's
//     card says the app clocked them out and that their manager will check it.
// Either way the close time is never before the clock-in, and the punch stays pending.
// A punch with no scheduled end has nothing to anchor to and is left for the office.
import { DEFAULT_AUTO_CLOSE_GRACE_MINS } from './clockInWindow.js';

const MIN = 60000;
const ms = (v) => {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};
const graceOf = (g) => (Number.isFinite(g) && g >= 0 ? g : DEFAULT_AUTO_CLOSE_GRACE_MINS);
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

// The minutes the clean was booked for: scheduled end − scheduled start, else the clean's
// expected minutes recorded on the punch, else null.
function scheduledLengthMins(row) {
  const span = (ms(row?.scheduled_end) - ms(row?.scheduled_start)) / MIN;
  return positive(Math.round(span)) ?? positive(Math.round(Number(row?.expected_minutes_snapshot)));
}

// → { closeAtMs, dueAtMs, lateStart, creditedMins } for an open punch (snake_case row), or null
// when it has no scheduled end (left for the office). `dueAtMs` is when the cron may close it;
// `closeAtMs` is the clock-out it writes.
export function autoCloseAnchor(row, graceMins) {
  const grace = graceOf(graceMins);
  const end = ms(row?.scheduled_end);
  if (!Number.isFinite(end)) return null;
  const inAt = ms(row?.clock_in_at);
  if (!Number.isFinite(inAt) || inAt < end) {
    return { closeAtMs: end, dueAtMs: end + grace * MIN, lateStart: false, creditedMins: null };
  }
  const length = scheduledLengthMins(row) ?? grace;
  const creditedMins = Math.max(1, grace > 0 ? Math.min(length, grace) : length);
  const closeAtMs = inAt + creditedMins * MIN;
  return { closeAtMs, dueAtMs: closeAtMs + grace * MIN, lateStart: true, creditedMins };
}

// Is this open punch due for the cron at `now`?
export function autoCloseDue(row, graceMins, now = Date.now()) {
  const a = autoCloseAnchor(row, graceMins);
  return !!a && now >= a.dueAtMs;
}

// The newest scheduled end a due punch can have at `now`: a punch is due no sooner than its
// scheduled end + the grace (a late start later still), so the cron reads only open punches
// whose scheduled end is at or before this — never the people on the clock right now, and
// never a punch with no scheduled end (F12-06: those crowded the read past PostgREST's row cap).
export function autoCloseCutoffIso(now, graceMins) {
  return new Date(now - graceOf(graceMins) * MIN).toISOString();
}

// ── the late-start flag: ONE definition, both directions (the checklistFlag pattern) ────
// The server writes this sentence as the auto-close `edit_history` reason; the approval queue
// and the cleaner's card read it back with the parser below, built from the same prefix, so a
// reworded flag cannot leave either of them blind.
const LATE_PREFIX = 'auto-closed: clocked in after the clean\'s scheduled end, so closed';
const LATE_SUFFIX = 'min after the clock-in';
const escapeRe = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const LATE_RE = new RegExp(`${escapeRe(LATE_PREFIX)} (\\d+) ${escapeRe(LATE_SUFFIX)}`);
export function lateStartAutoCloseNote(creditedMins, graceMins) {
  return `${LATE_PREFIX} ${creditedMins} ${LATE_SUFFIX} (the clean's scheduled length, at most the ${graceOf(graceMins)}m grace)`;
}

// → { creditedMins } when the cron closed this punch as a late start, else null.
export function lateStartAutoCloseOf(entry) {
  const history = Array.isArray(entry?.edit_history) ? entry.edit_history : [];
  for (const h of history) {
    const m = h && typeof h.reason === 'string' ? h.reason.match(LATE_RE) : null;
    if (m) return { creditedMins: Number(m[1]) };
  }
  return null;
}

// The recorded sentence, for the line a queue row shows under its chips; null otherwise.
export function lateStartAutoCloseText(entry) {
  const history = Array.isArray(entry?.edit_history) ? entry.edit_history : [];
  const h = history.find((x) => x && typeof x.reason === 'string' && LATE_RE.test(x.reason));
  return h ? h.reason : null;
}

// Was this auto-closed punch's clock-out corrected by a manager AFTER the cron closed it? Then
// the clock-out is a real, reviewed time — not the system's synthetic one. (correctEntry records
// a history row per field it changes; the cron records { field:'status', to:'auto_closed' }; the
// demo stub joins changed field names with commas.) The correction form never clears the
// auto_closed status, so without this a corrected punch read "Missing clock-out (auto)" in the
// attendance report (lib/attendanceReport) — and would tell the cleaner the app closed it.
export function clockOutCorrected(e) {
  const hist = Array.isArray(e && e.edit_history) ? e.edit_history : [];
  let closedAt = -1;
  hist.forEach((h, i) => { if (h && h.field === 'status' && h.to === 'auto_closed') closedAt = i; });
  for (let i = closedAt + 1; i < hist.length; i += 1) {
    if (String((hist[i] && hist[i].field) || '').split(',').includes('clock_out_at')) return true;
  }
  return false;
}

// The line on the CLEANER's done card, as a catalog key: the app closed this punch (and, for a
// late start, why), so they know the time is waiting for their manager. Nothing once the office
// corrected the clock-out (the time is then a reviewed one), and nothing for an ordinary punch.
export function crewAutoCloseNoteKey(entry) {
  if (!entry || entry.status !== 'auto_closed' || !entry.clock_out_at) return null;
  if (clockOutCorrected(entry)) return null;
  return lateStartAutoCloseOf(entry) ? 'clock.autoClosedLate' : 'clock.autoClosed';
}
