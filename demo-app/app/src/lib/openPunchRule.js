// ONE CLEAN AT A TIME — the double-punch rule (PAY-13 → CS-318).
//
// Matt, 2026-09-29: "Can a cleaner be clocked in to two cleans at once? — No, a manager can
// override." Before this the only constraint was per (user, JOB) — the partial unique index
// `time_entries_one_open_per_user_job` — so a cleaner could hold an open punch at every
// clean on the board at once, and every one of them counted in payroll and variance. Live
// data held 161 overlapping same-user punch pairs.
//
// 🔴 THE ASYMMETRY IS THE POINT, and it is THE LAW II.8 ("fix, never reject"):
//   · a LIVE clock-in is REFUSED, 409, naming the clean they are still on, so the cleaner
//     can go and close it — nothing is lost, because nothing has happened yet;
//   · an OFFLINE REPLAY is NEVER refused. The work already happened and the buffered punch
//     is its only record, so it is ACCEPTED and FLAGGED for approval, exactly as an
//     unfinished checklist is (lib/checklistFlag.js — same shape, same reasoning).
//   · a MANAGER (the punch bypass: owner/admin by role, or `time.edit.all`) may override the
//     live refusal — and the punch they open is flagged too, because overlapping punches
//     both reach payroll and the approver has to see it.
//
// ONE DEFINITION, BOTH DIRECTIONS (the checklistFlag pattern): the words the server writes
// and the parser the approval queue reads them back with live together here, and the parser
// is built FROM the writer's own prefix, so a reworded flag cannot leave the queue silently
// blind.
//
// Pure / node-safe: no React, no store, no browser globals; its one import is the i18n core
// (the refusal's English is a catalog line, CS-193). The server store
// (api/_lib/time/store.js), the route, the demo stub (lib/timeApi.js) and the approvals
// filters all read this module.
import { english, msg } from '../i18n/core.js';

// ── the LIVE refusal ─────────────────────────────────────────────────────────
// Its own code, so the client can tell it from the one-open-per-JOB duplicate (which means
// "you are already clocked in HERE" and is not an error at all).
export const DOUBLE_PUNCH_CODE = 'already-on-the-clock';

// What the cleaner is told. The open clean is NAMED — a bare "you're already clocked in"
// sends someone hunting through the board for it. The API's English comes from the catalog
// (CS-193); the cleaner's screen renders the same keys in their language from the 409's
// `openCleanName` (components/ClockControl).
export const doublePunchKey = (openCleanName) => (openCleanName ? 'clock.error.alreadyOnClockAt' : 'clock.error.alreadyOnClock');
export function doublePunchMessage(openCleanName) {
  return english(doublePunchKey(openCleanName), { place: openCleanName || null });
}

// ── the REPLAY / override flag ───────────────────────────────────────────────
const FLAG_PREFIX = 'clocked in here while still on the clock';
const escapeRe = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const FLAG_RE = new RegExp(`${escapeRe(FLAG_PREFIX)}(?: at ([^;]+))?`);

// What an accepted overlapping punch records, in the row's `note` and in an `edit_history`
// reason. `openCleanName` is the clean they were still on, when it is known.
export function overlapFlagNote(openCleanName) {
  return openCleanName ? `${FLAG_PREFIX} at ${openCleanName}` : FLAG_PREFIX;
}

// Read the flag back off a punch row (snake_case `note` + `edit_history`):
//   { clean }  an overlapping punch, with the other clean's name when it was recorded
//   null       no overlap flag (the normal case)
export function overlapFlagOf(entry) {
  const texts = [];
  if (entry && entry.note) texts.push(String(entry.note));
  const history = entry && Array.isArray(entry.edit_history) ? entry.edit_history : [];
  for (const h of history) if (h && h.reason) texts.push(String(h.reason));
  for (const t of texts) {
    const m = t.match(FLAG_RE);
    if (m) return { clean: (m[1] || '').trim() || null };
  }
  return null;
}

// The approval-queue CHIP (UI_RULES §132's flag row), or null. Short by design.
// As a MESSAGE (CS-193) the queue renders in its reader's language; the chip is its English.
export function overlapFlagChipMessage(entry) {
  return overlapFlagOf(entry) ? msg('punch.flag.overlap') : null;
}
export function overlapFlagChip(entry) {
  const m = overlapFlagChipMessage(entry);
  return m ? english(m) : null;
}

// The flag as the SENTENCE the server wrote, for the line under the chips — so the approver
// reads the same words the record carries. null when unflagged.
export function overlapFlagText(entry) {
  const flag = overlapFlagOf(entry);
  if (!flag) return null;
  return overlapFlagNote(flag.clean);
}

// ── picking the open punch that blocks (or flags) a new one ───────────────────
// Given this cleaner's OPEN punches and the clean they are now trying to start, which one is
// "another clean"? Rules, in order:
//   · a punch on the SAME job is not an overlap — that is the one-open-per-job duplicate;
//   · a punch with NO job is an overlap (CS-318: `job_id` is nullable, so those rows were
//     constrained by nothing at all);
//   · the EARLIEST open punch is reported, so the message names the one they have been on
//     longest rather than whichever row the query happened to return first.
// Returns the row, or null.
export function blockingOpenPunch(openRows, jobId) {
  const rows = (Array.isArray(openRows) ? openRows : []).filter((r) => {
    if (!r || r.clock_out_at) return false;
    const rowJob = r.job_id ?? r.jobId ?? null;
    return rowJob !== jobId;          // a null job_id is an overlap, as is a different clean
  });
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => {
    const ai = a.clock_in_at ?? a.clockInAt ?? '';
    const bi = b.clock_in_at ?? b.clockInAt ?? '';
    return String(ai).localeCompare(String(bi));
  })[0];
}

// How the open punch is NAMED in the refusal and the flag: the customer, else the site,
// else nothing (never an id — the cleaner has to recognise the place).
export function openPunchLabel(row) {
  return row?.client_name ?? row?.clientName ?? row?.site_name ?? row?.siteName ?? null;
}
