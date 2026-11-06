// The clock-out CHECKLIST FLAG: the words a replayed clock-out carries when the cleaner's
// checklist was not finished (or could not be read), and the parser the approval surfaces
// read them back with.
//
// 🔴 ONE DEFINITION, BOTH DIRECTIONS. A buffered clock-out is never refused (THE LAW II.8 —
// the work already happened and the punch is its only record), so the unfinished checklist
// rides along as a flag instead, "so it shows at approval" (checklists plan R4). The SERVER
// writes it into `time_entries.note` and `edit_history[].reason`
// (`api/_lib/time/checklistGate.js` re-exports the two builders below, with the `.js`
// extension so it loads in plain Node — DEV_PLAYBOOK 3.4.16); the APPROVALS queue reads it
// back with `checklistFlagOf`. Both halves are here, and the parser is built FROM the
// builder's own prefix, so a reworded flag cannot leave the queue silently blind — which is
// exactly what happened before: the flag was written on every replay and read by nobody, so
// an approver saw only "Edited".
//
// Pure / node-safe: no React, no store, no browser globals, no imports.

// The one phrase both halves are built from.
import { english, msg } from '../i18n/core.js';

const FLAG_PREFIX = 'checklist not finished at clock-out';
const escapeRe = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const PROGRESS_RE = new RegExp(`${escapeRe(FLAG_PREFIX)} \\((\\d+)\\/(\\d+)\\)`);

// What a replay writes when the cleaner's checklist there is unfinished.
export const checklistFlagNote = (done, total) => `${FLAG_PREFIX} (${done}/${total})`;
// …and when the gate could not be READ at all: the replay is still accepted, with a flag
// that says exactly that rather than accusing the cleaner of an unfinished checklist.
export const CHECKLIST_UNKNOWN_NOTE = 'checklist status unknown at clock-out';

// Every place a flag can be recorded on a punch, newest intent first: the offline `note`,
// then the reasons in `edit_history` (a manager who rewrites the note must not erase it).
function flagTexts(entry) {
  const out = [];
  if (entry && entry.note) out.push(String(entry.note));
  const history = entry && Array.isArray(entry.edit_history) ? entry.edit_history : [];
  for (const h of history) if (h && h.reason) out.push(String(h.reason));
  return out;
}

// Read the flag back off a punch row (snake_case `note` + `edit_history`):
//   { done, total }   the checklist was unfinished, with the progress recorded
//   { unknown: true } the gate could not be read when the punch was replayed
//   null              no checklist flag on this punch (the normal case)
// A recorded PROGRESS wins over an unknown: if both are present the specific one is the
// answer, because "unknown" only ever means "we could not tell at that moment".
export function checklistFlagOf(entry) {
  const texts = flagTexts(entry);
  for (const t of texts) {
    const m = t.match(PROGRESS_RE);
    if (m) return { done: Number(m[1]), total: Number(m[2]) };
  }
  return texts.some((t) => t.includes(CHECKLIST_UNKNOWN_NOTE)) ? { unknown: true } : null;
}

// The flag as the SENTENCE the server wrote — for the line a queue row shows under its
// chips, so the approver reads the same words the record carries. null when unflagged.
export function checklistFlagText(entry) {
  const flag = checklistFlagOf(entry);
  if (!flag) return null;
  return flag.unknown ? CHECKLIST_UNKNOWN_NOTE : checklistFlagNote(flag.done, flag.total);
}

// The queue CHIP for that flag (UI_RULES §132's flag row), or null. Short by design — the
// sentence goes on the line beneath.
// As a MESSAGE (CS-193) the queue renders in its reader's language; the chip is its English.
export function checklistFlagChipMessage(entry) {
  const flag = checklistFlagOf(entry);
  if (!flag) return null;
  return flag.unknown ? msg('punch.flag.checklistUnknown') : msg('punch.flag.checklist', { done: flag.done, total: flag.total });
}
export function checklistFlagChip(entry) {
  const m = checklistFlagChipMessage(entry);
  return m ? english(m) : null;
}
