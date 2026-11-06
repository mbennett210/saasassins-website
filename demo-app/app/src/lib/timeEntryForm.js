// The manager's punch-edit form (components/TimeEntryModal) as PURE rules: what the form opens
// with, and what a save sends. Node-safe (`.js` on every import), so the rules are tested
// headlessly (scripts/test-time-correct-by-value.mjs, test-time-fold-hour.mjs).
//
// 🔴 A SAVE SENDS ONLY WHAT THE PERSON CHANGED (CS-694). The form used to re-send BOTH clock
// times on every save, rebuilt from the minute-precision <input type="datetime-local"> — so a
// manager who only added a note rewrote both times: a real clock-in's seconds were lost, two
// history lines recorded times nobody touched, and (with the server comparing spellings) the
// approved punch went back to pending, out of pay. Now a time field the person did not touch
// keeps its ORIGINAL instant, to the millisecond and in its own spelling, and is not sent.
// The server compares by value too (lib/timeRules correctionChanges), for a cached bundle that
// still sends everything.
//
// 🔴 AND IT KNOWS WHICH 1 AM (CS-668). The night the clocks go back, 1:00–1:59 happens twice
// (lib/wallClock). Each time field carries a FOLD — 'first' / 'second' where its wall time
// repeats, null otherwise — opened from the punch's own instant, so editing the minutes of a
// second-1:xx punch keeps it in the second hour; a NEW time typed into the repeated hour has no
// fold until the manager picks one (`needsFold`), because guessing is how an hour of pay moved.
//
// The inputs show the SITE's wall clock (the org zone), so a manager editing from anywhere sees
// the times the cleaner worked and saves back the same instants.
import { splitIso, composeIso } from './dates.js';
import { sameInstant } from './timeRules.js';
import { wallClockInstants, foldOf } from './wallClock.js';

// An instant → the value a <input type="datetime-local"> shows ('' for none).
export function toLocalInput(iso, tz) {
  if (!iso) return '';
  const { date, time } = splitIso(iso, tz);
  return date ? `${date}T${time}` : '';
}

// An instant → one time field's state: what the input shows, and which occurrence of that wall
// time it is (null unless the hour repeats). For the form's prefills (a Missing-time row, a
// picked clean) as much as for opening a punch.
export function formTimeOf(iso, tz) {
  return { input: toLocalInput(iso, tz), fold: iso ? foldOf(iso, tz) : null };
}

// One time field as the form opens it: its state, and the instant it stands for.
const fieldOf = (iso, tz) => ({ ...formTimeOf(iso, tz), iso: iso || null });

// The correct-mode form for a punch (the neutral entry shape — clockInAt / clockOutAt / note):
// the editable values and the untouched originals a save is measured against.
export function openCorrectionForm(entry, { tz } = {}) {
  const inF = fieldOf(entry?.clockInAt, tz);
  const outF = fieldOf(entry?.clockOutAt, tz);
  const note = entry?.note || '';
  return {
    form: { inAt: inF.input, inFold: inF.fold, outAt: outF.input, outFold: outF.fold, note },
    initial: { in: inF, out: outF, note },
  };
}

// The two instants a typed wall time stands for when the zone repeats it — the form's choice —
// or null when there is nothing to choose.
export function foldChoices(input, tz) {
  if (!input) return null;
  const [date, time] = String(input).split('T');
  const list = wallClockInstants(date, time, tz);
  return list.length >= 2 ? { first: list[0], second: list[list.length - 1] } : null;
}

// The instant one time field stands for at save → { iso, changed, needsFold? }.
//   · Untouched (the input AND its fold are exactly what the form opened with) → the ORIGINAL
//     instant, so a save that did not touch a time never moves it — not by a second, not by an hour.
//   · Cleared → null.
//   · Typed → that wall clock in the org zone; in a repeated hour, the chosen occurrence — or,
//     with none chosen, `needsFold` and no instant (the form asks; it never guesses).
//   "changed" is judged as an instant, so retyping the same minute is not a change.
export function resolveFormTime({ input = '', fold = null, original = null, tz } = {}) {
  const orig = original || { input: '', iso: null, fold: null };
  if ((input || '') === (orig.input || '') && (fold ?? null) === (orig.fold ?? null)) {
    return { iso: orig.iso ?? null, changed: false };
  }
  if (!input) return { iso: null, changed: orig.iso != null };
  const choices = foldChoices(input, tz);
  if (choices && fold !== 'first' && fold !== 'second') return { iso: null, changed: true, needsFold: true };
  const [date, time] = String(input).split('T');
  const iso = choices ? choices[fold] : composeIso(date, time, tz);
  return { iso, changed: !sameInstant(iso, orig.iso) };
}

// The correct-mode save → { patch, timeChanged, inIso, outIso, needsFold }. `patch` holds ONLY
// the fields the person changed; inIso / outIso are the punch's times once it lands (the
// originals where untouched), which is what validation must read. `needsFold` names the field
// ('in' / 'out') still waiting for the manager to say which 1 AM — the save must not go.
export function buildCorrectionPatch({ entry, form, initial, tz } = {}) {
  const inR = resolveFormTime({ input: form?.inAt, fold: form?.inFold ?? null, original: initial?.in, tz });
  const outR = resolveFormTime({ input: form?.outAt, fold: form?.outFold ?? null, original: initial?.out, tz });
  const patch = {};
  if (inR.changed && !inR.needsFold) patch.clock_in_at = inR.iso;
  if (outR.changed && !outR.needsFold) patch.clock_out_at = outR.iso;
  if ((form?.note ?? '') !== (entry?.note || '')) patch.note = form.note;
  return {
    patch,
    timeChanged: inR.changed || outR.changed,
    inIso: inR.iso,
    outIso: outR.iso,
    needsFold: inR.needsFold ? 'in' : (outR.needsFold ? 'out' : null),
  };
}
