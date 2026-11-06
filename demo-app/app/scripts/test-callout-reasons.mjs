// ALR-7 (Matt, 2026-09-29): "Call-out reasons: pick from a list, or type freely? — (a) A
// short list: sick, family, transportation, other." A typed reason could not be counted —
// "car trouble", "car broke down", "transportation" and "bus" were four answers to one
// question — so nobody could see that transport is why a third of the call-outs happen.
//
// What it pins: the vocabulary, the write-point sanitizer through the REAL reducer, the
// refusal both booking screens share, the one display formatter every surface reads, and that
// an entry booked before the list existed still reads by its free text.
//
//   node app/scripts/test-callout-reasons.mjs
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';
import {
  CALLOUT_REASONS, CALLOUT_REASON_LABEL, CALLOUT_REASON_REFUSALS,
  normalizeCalloutReason, calloutReasonRefusal, timeOffReasonText, isCallOut,
} from '../src/store/timeOffRules.js';
import { calledOutOn } from '../src/lib/reports/calledOut.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── the vocabulary is Matt's four, in his order ───────────────────────────────
eq('the four reasons, in order', CALLOUT_REASONS, ['sick', 'family', 'transportation', 'other']);
ok('each carries a label', CALLOUT_REASONS.every((r) => typeof CALLOUT_REASON_LABEL[r] === 'string' && CALLOUT_REASON_LABEL[r]));
eq('and no more than four', Object.keys(CALLOUT_REASON_LABEL).length, 4);

// ── the write-point sanitizer ─────────────────────────────────────────────────
eq('a known code survives', normalizeCalloutReason('sick', 'callout'), 'sick');
eq('an unknown code is dropped', normalizeCalloutReason('hungover', 'callout'), undefined);
eq('a non-string is dropped', normalizeCalloutReason(7, 'callout'), undefined);
eq('a code on PLANNED time off is dropped (the list is the call-out question)',
  normalizeCalloutReason('sick', 'planned'), undefined);
eq('no kind given is treated as a call-out, as everywhere else', normalizeCalloutReason('family', undefined), 'family');

// ── the refusal both booking screens share ────────────────────────────────────
eq('a call-out with no reason picked is refused', calloutReasonRefusal({ kind: 'callout' }), 'pick-reason');
eq('…and with an unknown one', calloutReasonRefusal({ kind: 'callout', calloutReason: 'nope' }), 'pick-reason');
eq('"Other" with no note is refused (it records nothing on its own)',
  calloutReasonRefusal({ kind: 'callout', calloutReason: 'other', reason: '  ' }), 'note-required');
eq('"Other" WITH a note is fine', calloutReasonRefusal({ kind: 'callout', calloutReason: 'other', reason: 'court date' }), null);
eq('the other three need no note', calloutReasonRefusal({ kind: 'callout', calloutReason: 'sick' }), null);
eq('PLANNED time off is never refused for a reason code', calloutReasonRefusal({ kind: 'planned' }), null);
ok('every refusal has a sentence', Object.keys(CALLOUT_REASON_REFUSALS).length === 2
  && ['pick-reason', 'note-required'].every((c) => typeof CALLOUT_REASON_REFUSALS[c] === 'string' && CALLOUT_REASON_REFUSALS[c]));

// ── the ONE display formatter every surface reads ─────────────────────────────
eq('a coded reason reads as its label', timeOffReasonText({ calloutReason: 'transportation' }), 'Transportation');
eq('…with the note after it', timeOffReasonText({ calloutReason: 'other', reason: 'court date' }), 'Other — court date');
eq('…and a blank note adds nothing', timeOffReasonText({ calloutReason: 'sick', reason: '   ' }), 'Sick');
eq('an entry booked BEFORE the list reads by its free text', timeOffReasonText({ reason: 'Called out sick' }), 'Called out sick');
eq('an entry with neither reads plainly', timeOffReasonText({}), 'time off');
eq('a null entry reads plainly', timeOffReasonText(null), 'time off');
eq('an unknown stored code falls back to the note rather than printing the code',
  timeOffReasonText({ calloutReason: 'hungover', reason: 'slept in' }), 'slept in');

// ── the REAL reducer sanitizes at the write point ─────────────────────────────
{
  const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
  const base = { ...INITIAL_STATE, timeOff: [] };
  const add = (entry) => reducer(base, { type: ACTIONS.ADD_TIME_OFF, entry }).timeOff.slice(-1)[0];
  const day = '2026-09-28';
  const of = (over = {}) => ({ id: `to_${Math.random().toString(36).slice(2, 8)}`, userId: 'u_c1', startDate: day, endDate: day, ...over });

  eq('a known code is stored', add(of({ kind: 'callout', calloutReason: 'family' })).calloutReason, 'family');
  eq('an unknown code is not stored at all',
    Object.prototype.hasOwnProperty.call(add(of({ kind: 'callout', calloutReason: 'hungover' })), 'calloutReason'), false);
  eq('a code on PLANNED time off is not stored',
    Object.prototype.hasOwnProperty.call(add(of({ kind: 'planned', calloutReason: 'sick' })), 'calloutReason'), false);
  eq('an entry with no code is still stored (before-the-list shape)',
    Object.prototype.hasOwnProperty.call(add(of({ kind: 'callout', reason: 'car trouble' })), 'calloutReason'), false);
  eq('…and keeps its free text', add(of({ kind: 'callout', reason: 'car trouble' })).reason, 'car trouble');
  eq('the kind still lands', add(of({ kind: 'callout', calloutReason: 'sick' })).kind, 'callout');
  ok('…and it is still a call-out by the shared predicate', isCallOut(add(of({ kind: 'callout', calloutReason: 'sick' }))));
}

// ── Reports › Called out shows the coded reason, and can count by code ────────
{
  const day = '2026-09-28';
  const usersById = new Map([['u_a', { id: 'u_a', name: 'Andre' }], ['u_b', { id: 'u_b', name: 'Tomas' }]]);
  const rows = calledOutOn({
    timeOff: [
      { id: 't1', userId: 'u_a', startDate: day, endDate: day, kind: 'callout', calloutReason: 'transportation' },
      { id: 't2', userId: 'u_b', startDate: day, endDate: day, kind: 'callout', reason: 'Called out sick' },
    ],
    jobs: [], usersById, clientsById: new Map(), sitesById: new Map(), dayKey: day,
  });
  const byId = new Map(rows.map((r) => [r.userId, r]));
  eq('both cleaners are listed', rows.length, 2);
  eq('a coded reason shows as its LABEL, not the raw code', byId.get('u_a').reason, 'Transportation');
  eq('…and the code is carried for counting', byId.get('u_a').reasonCodes, ['transportation']);
  eq('a pre-list entry still shows its free text', byId.get('u_b').reason, 'Called out sick');
  eq('…and carries no code', byId.get('u_b').reasonCodes, []);
  eq('a coded entry with a note shows both',
    calledOutOn({
      timeOff: [{ id: 't3', userId: 'u_a', startDate: day, endDate: day, kind: 'callout', calloutReason: 'other', reason: 'court date' }],
      jobs: [], usersById, clientsById: new Map(), sitesById: new Map(), dayKey: day,
    })[0].reason, 'Other — court date');
}

// ── both booking screens run the SHARED rules, not their own ──────────────────
{
  for (const [name, path] of [['Team › Time off', '../src/components/TimeOffCard.jsx'], ['HR › PTO', '../src/pages/hr/PtoTab.jsx']]) {
    const src = read(path);
    ok(`${name} offers the list from the vocabulary`, /CALLOUT_REASONS\.map\(/.test(src));
    ok(`${name} refuses through the shared rule`, /calloutReasonRefusal\(/.test(src));
    ok(`${name} shows the refusal's own sentence`, /CALLOUT_REASON_REFUSALS\[/.test(src));
    // CS-054: both screens build the booking with the ONE timeOffBooking, which decides
    // whether the code rides along (asserted on the builder, below).
    ok(`${name} sends the code through the shared booking`, /timeOffBooking\(\{[\s\S]{0,260}calloutReason/.test(src));
    ok(`${name} reads the shared formatter`, /timeOffReasonText\(/.test(src));
    ok(`${name} hard-codes none of the four labels`, !/'Transportation'|"Transportation"/.test(src));
  }
  const { timeOffBooking } = await import('../src/store/timeOffRules.js');
  const base = { jobs: [], id: 'to_x', userId: 'u_a', startDate: '2026-10-08', endDate: '2026-10-08', reason: '' };
  eq('the booking sends the code on a call-out', timeOffBooking({ ...base, kind: 'callout', calloutReason: 'sick' }).entry.calloutReason, 'sick');
  ok('…and never on planned time off', !('calloutReason' in timeOffBooking({ ...base, kind: 'planned', calloutReason: 'sick' }).entry));
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
