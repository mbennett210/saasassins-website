// What the crew's Clock-out button SAYS and whether it is locked — the presentation half
// of the clock-out block (R4-R6, UI_RULES §131). Pure / node-safe and separate from the
// rule (lib/crewChecklist clockOutGate) so both can be unit-tested without React and the
// server never imports crew copy.
//
// The control is never hidden and never silently inert: a locked button carries the reason
// in its own visible text (UI_RULES §118 — don't offer what the server refuses, and say
// why), and the cleaner always gets a way to the checklist itself.
import { GATE } from './crewChecklist.js';

export const CLOCK_OUT_LABEL = 'Clock out';
export const CLOCK_OUT_LOCKED_LABEL = 'Finish your checklist to clock out';

// The server's refusal, defined HERE so the crew message and the code the button branches
// on have exactly one definition: api/_lib/time/checklistGate.js imports these (with the
// .js extension, DEV_PLAYBOOK 3.4.16) and the route answers with them. A client that
// matched a restated literal would drift the day someone reworded one of them.
export const CHECKLIST_INCOMPLETE_CODE = 'checklist_incomplete';
export const CHECKLIST_INCOMPLETE_ERROR = 'Finish your checklist before you clock out';

// The OTHER server answer: it could not judge the checklist at all (the blob, the job row
// or checklist_results was unreadable). It still fails CLOSED — nothing is recorded — but
// it is a RETRYABLE 503 with its own code, so the button can say "try again" instead of
// accusing the cleaner of an unfinished checklist, and never a 500 carrying provider text.
export const CHECKLIST_CHECK_FAILED_CODE = 'checklist_check_failed';
export const CHECKLIST_CHECK_FAILED_ERROR = 'Couldn’t check your checklist. Try again.';
// Offline with nothing to judge by. It names the ONE thing that resolves it on a dead
// link: finishing the checklist on THIS phone (the submission queues locally and counts).
export const NO_SIGNAL_HINT = 'No signal. Finish the checklist on this phone, or reconnect.';
// Online, but the read itself failed — "no signal" would be a lie, and the crew would
// stand there waiting for a bar of signal they already have.
export const CHECK_FAILED_HINT = 'Couldn’t check your checklist just now. Open it, or try again in a moment.';

const progress = (done, total) => (total > 0 ? ` · ${done}/${total}` : '');

// `gate`        — the clockOutGate verdict ({ state, done, total }), or null while loading.
// `loading`     — the results read is still in flight: disabled, but no accusation yet.
// `online`      — navigator.onLine, only to word the UNKNOWN hint truthfully.
// `serverBlock` — { done, total } from a 409 checklist_incomplete. The SERVER is the
//   authority (an old bundle, a stale local read, a submission that never synced), so it
//   overrides a local `done`.
export function clockOutButtonState({ gate = null, loading = false, online = true, serverBlock = null, checkFailed = false } = {}) {
  // A 409 describes the clean AS IT WAS when the server answered. Once the gate reaches a
  // state where there is nothing left to finish — DONE (a fresh read, or a complete
  // submission queued on the phone), OFF (the office lifted the block) or NONE (the
  // assignment went away) — the refusal is SUPERSEDED and must stop locking the button.
  // Without this a cleaner who hits the 409 and then finishes through the checklist CARD
  // (a sibling component that never touches the clock control's state) stays locked until
  // the page remounts. Anything else — loading, BLOCKED, UNKNOWN — keeps the refusal.
  const superseded = !!gate && (gate.state === GATE.DONE || gate.state === GATE.OFF || gate.state === GATE.NONE);
  if (serverBlock && !superseded) {
    return {
      locked: true,
      checking: false,
      label: `${CLOCK_OUT_LOCKED_LABEL}${progress(serverBlock.done || 0, serverBlock.total || 0)}`,
      hint: null,
      showOpenChecklist: true,
    };
  }
  if (loading || !gate) {
    return { locked: true, checking: true, label: CLOCK_OUT_LABEL, hint: null, showOpenChecklist: false };
  }
  if (gate.state === GATE.BLOCKED) {
    return {
      locked: true,
      checking: false,
      label: `${CLOCK_OUT_LOCKED_LABEL}${progress(gate.done || 0, gate.total || 0)}`,
      hint: null,
      showOpenChecklist: true,
    };
  }
  // The server answered 503 checklist_check_failed: it could not judge, and nothing was
  // recorded. That is NOT "finish your checklist" — the cleaner may well have finished it
  // — so the button keeps its normal label and stays ENABLED, which makes the next tap the
  // retry. The server is still the boundary: it will refuse again until the read works.
  // A local BLOCKED above outranks it, because a local read that DID work knows more.
  if (checkFailed) {
    return { locked: false, checking: false, label: CLOCK_OUT_LABEL, hint: CHECK_FAILED_HINT, showOpenChecklist: true };
  }
  if (gate.state === GATE.UNKNOWN) {
    return {
      locked: true,
      checking: false,
      label: CLOCK_OUT_LOCKED_LABEL,
      hint: online ? CHECK_FAILED_HINT : NO_SIGNAL_HINT,
      showOpenChecklist: true,
    };
  }
  // none · off · done — the normal button, and nothing about checklists shows (R1).
  return { locked: false, checking: false, label: CLOCK_OUT_LABEL, hint: null, showOpenChecklist: false };
}
