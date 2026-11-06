// WHEN a checklist counts for a clean (CS-690). Pure / node-safe (explicit `.js` imports), so
// the server (api/_lib/qc/store submitChecklist), the demo stub (lib/qcApi), the clock-out
// gate (lib/crewChecklist clockOutGate) and the fill button (components/CleanChecklist) read
// ONE rule.
//
// THE RULE, PICKED: THE CLEAN'S WINDOW. A checklist counts for a clean only when the cleaner
// filled it in inside that clean's window — the SAME window its clock-in has
// (lib/clockInWindow: from 2 hours before the clean starts to its end plus the auto-close
// grace) — or, past that, while they are still clocked in there (a late start runs on past
// the window, and must not be stranded at a clock-out it cannot unlock).
//   WHY THE WINDOW and not "on the clock there" alone: the phone replays an offline checklist
//   BEFORE the punches (lib/offlineFlush: the server must see the finished checklist before
//   the clock-out that closes the clean), so when an offline checklist lands the clock-in
//   that would prove "on the clock" is often not on the server yet — a pure on-the-clock rule
//   would throw away every basement checklist. The window is a fact of the clean alone.
// A checklist filled anywhere else — the night before, from home — is KEPT (nothing is ever
// refused: THE LAW II.8), but not for the clean: stored without it, so it cannot unlock that
// clean's clock-out, and with no area "last cleaned" stamp, so the QR code on the wall and
// the customer's hub never show a clean time nobody worked. It used to unlock the next
// morning's clock-out the moment the cleaner clocked in.
//
// WHEN it was filled: the server's own clock when it arrives — or, for a submission the
// phone kept offline and sent later, the moment the cleaner pressed Submit (`filledAt`,
// stamped by lib/qcApi when it queues one), never later than its arrival. A claimed time can
// therefore only move the fill EARLIER, which can never make it count for a clean that has
// not happened yet.
import { clockInWindow, clockInRefusal } from './clockInWindow.js';

const msOf = (v) => {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};

// → ms: when this checklist was filled in.
export function checklistMadeAt(filledAt, receivedAt = Date.now()) {
  const received = msOf(receivedAt);
  const claimed = msOf(filledAt);
  if (!Number.isFinite(received)) return Number.isFinite(claimed) ? claimed : Date.now();
  return Number.isFinite(claimed) ? Math.min(claimed, received) : received;
}

// Inside the clean's own window? A clean with no start time is not gated (as its clock-in).
export function madeInCleanWindow(job, madeAt, { graceMins } = {}) {
  return clockInRefusal(job, madeAt, { graceMins }) === null;
}

// Does a checklist filled at `madeAt` count for this clean? `onClock` = the cleaner is
// clocked in to it right now (asked only once the window has closed).
export function checklistCountsForClean({ job, madeAt, graceMins, onClock = false } = {}) {
  if (!job) return false;
  if (madeInCleanWindow(job, madeAt, { graceMins })) return true;
  const w = clockInWindow(job, { graceMins });
  return !!(onClock && w && msOf(madeAt) >= w.opensAt);
}

// The fill button's answer, for a cleaner looking at the clean now:
//   null    open: fill it in;
//   'early' the window has not opened (say when it does);
//   'late'  the window has closed and they are not clocked in there.
export function checklistFillRefusal(job, now = Date.now(), { graceMins, clockedIn = false } = {}) {
  const refusal = clockInRefusal(job, now, { graceMins });
  if (refusal === 'late' && clockedIn) return null;
  return refusal;
}

// When the window opens, in ms (null for a clean with no start).
export function checklistOpensAt(job, { graceMins } = {}) {
  return clockInWindow(job, { graceMins })?.opensAt ?? null;
}
