// Step 4a — the clock-out block (R4–R6). The PURE halves, unit-tested apart from React:
//
//   · lib/crewChecklist.clockOutGate  — none | off | done | blocked(done,total) | unknown
//   · lib/crewChecklist.hasCompleteChecklistFor's optional templateId filter
//   · lib/clockOutBlock.clockOutButtonState — every ClockControl state's copy + lock
//   · lib/checklistGateMemo — the phone's last-known verdict per (clean, cleaner),
//     with retention AT THE WRITE POINT (count cap + age ceiling) and quota safety
//   · lib/queueFlushOrder.runOrderedFlush — the checklist queue drains BEFORE the punch
//     queue on reconnect, single-flight, one failing step never skips the next
//
// Every expectation reads the module's own exported constant, never a restated literal
// (THE LAW II.3). Fails on the pre-fix code: none of these exports exist there.
//
//   node app/scripts/test-clock-out-gate.mjs
import {
  clockOutGate, GATE, hasCompleteChecklistFor, isChecklistComplete,
  completeChecklistIndex, checklistFor,
} from '../src/lib/crewChecklist.js';
import {
  clockOutButtonState, CLOCK_OUT_LABEL, CLOCK_OUT_LOCKED_LABEL,
  NO_SIGNAL_HINT, CHECK_FAILED_HINT,
  CHECKLIST_CHECK_FAILED_CODE, CHECKLIST_CHECK_FAILED_ERROR,
} from '../src/lib/clockOutBlock.js';
import {
  memoKey, pruneGateMemo, readGateMemo, writeGateMemo, forgetGateMemo,
  GATE_MEMO_KEY, GATE_MEMO_MAX, GATE_MEMO_MAX_AGE_MS,
} from '../src/lib/checklistGateMemo.js';
import { runOrderedFlush } from '../src/lib/queueFlushOrder.js';
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const JOB = 'j1';
const ME = 'u_me';
const OTHER = 'u_other';
const LIST = 'it_a';
const OTHER_LIST = 'it_b';

const row = (p = {}) => ({
  id: p.id || `cr_${Math.random().toString(36).slice(2, 8)}`,
  job_id: JOB, site_id: 's1', template_id: LIST, completed_by_user_id: ME,
  completed_count: 0, total_count: 10, performed_at: '2026-09-27T12:00:00.000Z',
  ...p,
});
const done = (p = {}) => row({ completed_count: 10, total_count: 10, ...p });

// ── clockOutGate: the five states ────────────────────────────────────────────
eq('no checklist assigned → none',
  clockOutGate({ checklistId: null, results: [], userId: ME, jobId: JOB }).state, GATE.NONE);
eq('no checklist assigned, results unknown → still none (never strands a cleaner)',
  clockOutGate({ checklistId: null, results: null, userId: ME, jobId: JOB }).state, GATE.NONE);

eq('block off for this cleaner → off',
  clockOutGate({ checklistId: LIST, rules: { checklistBlockOff: true }, results: [], userId: ME, jobId: JOB }).state, GATE.OFF);
eq('block off only counts when === true (a truthy string is not the switch)',
  clockOutGate({ checklistId: LIST, rules: { checklistBlockOff: 'yes' }, results: [], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('geofenceOff alone does not unlock the checklist block',
  clockOutGate({ checklistId: LIST, rules: { geofenceOff: true }, results: [], userId: ME, jobId: JOB }).state, GATE.BLOCKED);

eq('a complete synced submission → done',
  clockOutGate({ checklistId: LIST, results: [done()], userId: ME, jobId: JOB }).state, GATE.DONE);
eq('nothing submitted, list loaded → blocked',
  clockOutGate({ checklistId: LIST, results: [], userId: ME, jobId: JOB }).state, GATE.BLOCKED);

const partial = clockOutGate({ checklistId: LIST, results: [row({ completed_count: 12, total_count: 46 })], userId: ME, jobId: JOB });
eq('a partial submission → blocked', partial.state, GATE.BLOCKED);
eq('blocked carries done', partial.done, 12);
eq('blocked carries total', partial.total, 46);

const virgin = clockOutGate({ checklistId: LIST, results: [], userId: ME, jobId: JOB });
eq('nothing started → done 0', virgin.done, 0);
eq('nothing started → total 0 (the button then shows no progress)', virgin.total, 0);

// ── DONE is per clean, per cleaner, per assigned checklist ───────────────────
eq('another cleaner’s complete submission does NOT count',
  clockOutGate({ checklistId: LIST, results: [done({ completed_by_user_id: OTHER })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('a complete submission on ANOTHER clean does NOT count',
  clockOutGate({ checklistId: LIST, results: [done({ job_id: 'j2' })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('a complete submission of ANOTHER checklist does NOT count',
  clockOutGate({ checklistId: LIST, results: [done({ template_id: OTHER_LIST })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('a job-less submission does NOT count for the clean',
  clockOutGate({ checklistId: LIST, results: [done({ job_id: null })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('an empty checklist (0/0) is never done',
  clockOutGate({ checklistId: LIST, results: [row({ completed_count: 0, total_count: 0 })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);

// A LATER PARTIAL RE-SUBMISSION NEVER UNDOES A COMPLETE ONE.
const afterComplete = clockOutGate({
  checklistId: LIST, userId: ME, jobId: JOB,
  results: [
    row({ completed_count: 3, total_count: 10, performed_at: '2026-09-27T14:00:00.000Z' }), // newest, partial
    done({ performed_at: '2026-09-27T12:00:00.000Z' }),
  ],
});
eq('a partial re-submission after a complete one stays done', afterComplete.state, GATE.DONE);
eq('done reports the complete counts', `${afterComplete.done}/${afterComplete.total}`, '10/10');

// ── queued (still on the phone) submissions count ───────────────────────────
const queuedItem = (items, p = {}) => ({
  id: `cl_${Math.random().toString(36).slice(2, 8)}`,
  createdAt: '2026-09-27T13:00:00.000Z',
  payload: { templateId: LIST, siteId: 's1', jobId: JOB, completedByUserId: ME, items, ...p },
});
const ticked = (n, total) => Array.from({ length: total }, (_, i) => ({ key: `k${i}`, checked: i < n }));

eq('a QUEUED complete submission counts as done',
  clockOutGate({ checklistId: LIST, results: [], queued: [queuedItem(ticked(10, 10))], userId: ME, jobId: JOB }).state, GATE.DONE);
eq('a QUEUED complete submission counts with NO server list at all (offline)',
  clockOutGate({ checklistId: LIST, results: null, queued: [queuedItem(ticked(4, 4))], userId: ME, jobId: JOB }).state, GATE.DONE);
eq('a QUEUED partial submission is blocked, with its progress',
  clockOutGate({ checklistId: LIST, results: null, queued: [queuedItem(ticked(2, 9))], userId: ME, jobId: JOB }).total, 9);
eq('a QUEUED submission for another cleaner does not count',
  clockOutGate({ checklistId: LIST, results: [], queued: [queuedItem(ticked(5, 5), { completedByUserId: OTHER })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('a QUEUED submission for another clean does not count',
  clockOutGate({ checklistId: LIST, results: [], queued: [queuedItem(ticked(5, 5), { jobId: 'j2' })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);
eq('a QUEUED submission with no completedByUserId is read as this phone’s cleaner',
  clockOutGate({ checklistId: LIST, results: [], queued: [queuedItem(ticked(5, 5), { completedByUserId: null })], userId: ME, jobId: JOB }).state, GATE.DONE);
eq('a queued item already marked failed does not count',
  clockOutGate({ checklistId: LIST, results: [], queued: [{ ...queuedItem(ticked(5, 5)), failed: true }], userId: ME, jobId: JOB }).state, GATE.BLOCKED);

// ── unknown: offline with nothing synced, cached or queued to judge by ───────
eq('no list, no queue → unknown',
  clockOutGate({ checklistId: LIST, results: null, queued: null, userId: ME, jobId: JOB }).state, GATE.UNKNOWN);
eq('no list, empty queue → unknown',
  clockOutGate({ checklistId: LIST, results: null, queued: [], userId: ME, jobId: JOB }).state, GATE.UNKNOWN);
eq('a CACHED verdict (passed in as results) is judged, never unknown',
  clockOutGate({ checklistId: LIST, results: [done()], queued: null, userId: ME, jobId: JOB }).state, GATE.DONE);
eq('no userId → unknown rather than a silent pass',
  clockOutGate({ checklistId: LIST, results: [done()], userId: null, jobId: JOB }).state, GATE.UNKNOWN);

// ── the templateId filter added to step 1's helper (no parallel helper) ──────
ok('hasCompleteChecklistFor takes an optional templateId',
  hasCompleteChecklistFor([done()], { userId: ME, jobId: JOB, templateId: LIST }) === true);
ok('hasCompleteChecklistFor with templateId rejects another checklist',
  hasCompleteChecklistFor([done({ template_id: OTHER_LIST })], { userId: ME, jobId: JOB, templateId: LIST }) === false);
ok('hasCompleteChecklistFor WITHOUT templateId is unchanged (the reminder walker’s narrow columns)',
  hasCompleteChecklistFor([done({ template_id: undefined })], { userId: ME, jobId: JOB }) === true);
ok('hasCompleteChecklistFor with templateId rejects a row that carries no template_id',
  hasCompleteChecklistFor([done({ template_id: undefined })], { userId: ME, jobId: JOB, templateId: LIST }) === false);
ok('isChecklistComplete still pins 0/0 as not done', isChecklistComplete({ completed_count: 0, total_count: 0 }) === false);
// …and the filter has to work on BOTH input shapes: step 1's hot callers hand it a
// prebuilt index, not the records (ONE rule, two shapes).
const idx = completeChecklistIndex([done(), done({ template_id: OTHER_LIST, job_id: 'j2' })]);
ok('the templateId filter works on a PREBUILT index', hasCompleteChecklistFor(idx, { userId: ME, jobId: JOB, templateId: LIST }) === true);
ok('…and rejects another checklist on the index too', hasCompleteChecklistFor(idx, { userId: ME, jobId: JOB, templateId: OTHER_LIST }) === false);
ok('…while the un-scoped ask on the index is unchanged', hasCompleteChecklistFor(idx, { userId: ME, jobId: JOB }) === true);
const looseIdx = completeChecklistIndex([done({ job_id: null, site_id: 's1', performed_at: '2026-09-27T12:00:00.000Z' })]);
ok('a job-less complete row is template-scoped on the index as well',
  hasCompleteChecklistFor(looseIdx, { userId: ME, siteId: 's1', startMs: Date.parse('2026-09-27T12:10:00.000Z'), windowMs: 3600000, templateId: LIST }) === true);
ok('…and another checklist does not match it', hasCompleteChecklistFor(looseIdx, { userId: ME, siteId: 's1', startMs: Date.parse('2026-09-27T12:10:00.000Z'), windowMs: 3600000, templateId: OTHER_LIST }) === false);

// ── a COVER is gated on the covered cleaner's checklist (step 3 × step 4a) ───
// checklistFor already hands a cover the COVERED cleaner's pick, so the gate only has to
// be asked with that id — and the cover's OWN checklist must not unlock the clock.
const coverJob = { id: JOB, coverFor: { [ME]: OTHER } };
eq('the cover is judged on the checklist checklistFor gave them',
  checklistFor({ client: { crewChecklists: { [OTHER]: LIST, [ME]: OTHER_LIST } }, job: coverJob, userId: ME }), LIST);
eq('finishing the COVERED cleaner’s checklist unlocks the cover',
  clockOutGate({ checklistId: LIST, results: [done()], userId: ME, jobId: JOB }).state, GATE.DONE);
eq('finishing their OWN checklist does not',
  clockOutGate({ checklistId: LIST, results: [done({ template_id: OTHER_LIST })], userId: ME, jobId: JOB }).state, GATE.BLOCKED);

// ── the ClockControl states (pure copy + lock) ───────────────────────────────
const st = (p) => clockOutButtonState(p);
const checking = st({ gate: null, loading: true });
ok('checking: disabled', checking.locked === true && checking.checking === true);
eq('checking: normal label', checking.label, CLOCK_OUT_LABEL);
ok('checking: no Open-checklist button', checking.showOpenChecklist === false);

for (const state of [GATE.NONE, GATE.OFF, GATE.DONE]) {
  const s = st({ gate: { state, done: 0, total: 0 } });
  ok(`${state}: normal button`, s.locked === false && s.label === CLOCK_OUT_LABEL && s.showOpenChecklist === false);
}

const locked = st({ gate: { state: GATE.BLOCKED, done: 12, total: 46 } });
ok('blocked: locked', locked.locked === true);
eq('blocked: label carries progress', locked.label, `${CLOCK_OUT_LOCKED_LABEL} · 12/46`);
ok('blocked: offers Open checklist', locked.showOpenChecklist === true);
eq('blocked: no hint', locked.hint, null);

eq('blocked with nothing started: label omits 0/0',
  st({ gate: { state: GATE.BLOCKED, done: 0, total: 0 } }).label, CLOCK_OUT_LOCKED_LABEL);

const offlineUnknown = st({ gate: { state: GATE.UNKNOWN }, online: false });
ok('unknown offline: locked', offlineUnknown.locked === true);
eq('unknown offline: no-signal hint', offlineUnknown.hint, NO_SIGNAL_HINT);
ok('unknown offline: offers Open checklist', offlineUnknown.showOpenChecklist === true);

const onlineUnknown = st({ gate: { state: GATE.UNKNOWN }, online: true });
eq('unknown online: the read failed, so say that instead of "no signal"', onlineUnknown.hint, CHECK_FAILED_HINT);

const refused = st({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, serverBlock: { done: 1, total: 4 } });
ok('server 409 locks the button', refused.locked === true);
eq('server 409 shows the server’s progress', refused.label, `${CLOCK_OUT_LOCKED_LABEL} · 1/4`);
ok('server 409 offers Open checklist', refused.showOpenChecklist === true);
eq('server 409 outranks a stale local BLOCKED progress', st({ gate: { state: GATE.BLOCKED, done: 9, total: 9 }, serverBlock: { done: 1, total: 4 } }).label, `${CLOCK_OUT_LOCKED_LABEL} · 1/4`);

// K2 — a 409 must not be STICKY. The refusal described the clean BEFORE the cleaner
// finished; once the gate reaches DONE (a fresh read, or a complete submission queued on
// the phone) the button unlocks. The cleaner may finish through the sibling checklist card,
// which never touches the clock control's own state, so the rule has to live here.
const refusedThenDone = st({ gate: { state: GATE.DONE, done: 4, total: 4 }, serverBlock: { done: 1, total: 4 } });
ok('a 409 followed by DONE unlocks', refusedThenDone.locked === false);
eq('…with the normal label', refusedThenDone.label, CLOCK_OUT_LABEL);
ok('…and no Open checklist', refusedThenDone.showOpenChecklist === false);
ok('a 409 followed by OFF unlocks too (the office turned the block off)',
  st({ gate: { state: GATE.OFF }, serverBlock: { done: 1, total: 4 } }).locked === false);
ok('a 409 followed by NONE unlocks (the assignment was removed)',
  st({ gate: { state: GATE.NONE }, serverBlock: { done: 1, total: 4 } }).locked === false);
ok('a 409 still locks while the re-read is in flight',
  st({ gate: null, loading: true, serverBlock: { done: 1, total: 4 } }).locked === true);
ok('a 409 still locks when the gate can’t tell',
  st({ gate: { state: GATE.UNKNOWN }, serverBlock: { done: 1, total: 4 } }).locked === true);

// S2 — the OTHER server answer: 503 checklist_check_failed. The server could not judge and
// recorded nothing (it still fails closed), but the cleaner may well have finished, so the
// button must NOT accuse them: normal label, still enabled so the next tap is the retry,
// and the check-failed hint. A local BLOCKED outranks it — a read that DID work knows more.
const checkFailed = st({ gate: { state: GATE.UNKNOWN }, checkFailed: true });
ok('a 503 does not lock the button', checkFailed.locked === false);
eq('…it keeps the normal label, never "finish your checklist"', checkFailed.label, CLOCK_OUT_LABEL);
eq('…and says what happened', checkFailed.hint, CHECK_FAILED_HINT);
ok('…and still offers the checklist', checkFailed.showOpenChecklist === true);
eq('a 503 with a local DONE is just the normal button', st({ gate: { state: GATE.DONE }, checkFailed: true }).hint, CHECK_FAILED_HINT);
ok('a local BLOCKED outranks a 503', st({ gate: { state: GATE.BLOCKED, done: 2, total: 9 }, checkFailed: true }).locked === true);
eq('…showing the local progress', st({ gate: { state: GATE.BLOCKED, done: 2, total: 9 }, checkFailed: true }).label, `${CLOCK_OUT_LOCKED_LABEL} · 2/9`);
ok('a 409 outranks a 503 (a definite answer beats an unreadable one)',
  st({ gate: { state: GATE.UNKNOWN }, serverBlock: { done: 1, total: 4 }, checkFailed: true }).locked === true);
ok('a 503 while the read is in flight still shows checking',
  st({ gate: null, loading: true, checkFailed: true }).checking === true);
ok('the 503 code and message are defined ONCE, beside the crew copy',
  CHECKLIST_CHECK_FAILED_CODE === 'checklist_check_failed' && typeof CHECKLIST_CHECK_FAILED_ERROR === 'string');

// ── the phone's memory of the last known verdict ─────────────────────────────
eq('memoKey is stable', memoKey({ jobId: JOB, userId: ME, templateId: LIST }), memoKey({ jobId: JOB, userId: ME, templateId: LIST }));
ok('memoKey separates cleaners', memoKey({ jobId: JOB, userId: ME, templateId: LIST }) !== memoKey({ jobId: JOB, userId: OTHER, templateId: LIST }));
ok('memoKey separates cleans', memoKey({ jobId: JOB, userId: ME, templateId: LIST }) !== memoKey({ jobId: 'j2', userId: ME, templateId: LIST }));

// Retention AT THE WRITE POINT: an absolute age ceiling and a count cap.
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const memoRow = (k, ageDays) => ({ k, state: GATE.DONE, done: 1, total: 1, at: new Date(NOW - ageDays * 86400000).toISOString() });
const aged = pruneGateMemo([memoRow('old', 40), memoRow('fresh', 1)], { now: NOW });
eq('memo: a row past the age ceiling is dropped', aged.length, 1);
eq('memo: the fresh row survives', aged[0].k, 'fresh');
ok('memo: the age ceiling is 30 days', GATE_MEMO_MAX_AGE_MS === 30 * 86400000);

const many = Array.from({ length: GATE_MEMO_MAX + 25 }, (_, i) => memoRow(`k${i}`, 0));
const capped = pruneGateMemo(many, { now: NOW });
eq('memo: the count cap holds', capped.length, GATE_MEMO_MAX);
eq('memo: the cap keeps the NEWEST rows (append newest-last)', capped[capped.length - 1].k, `k${GATE_MEMO_MAX + 24}`);

// A fake localStorage, so the round trip is real without a browser.
const fakeStore = (throwOnSet = false) => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (throwOnSet) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } m.set(k, v); },
    removeItem: (k) => m.delete(k),
    _raw: m,
  };
};
const store = fakeStore();
const id = { jobId: JOB, userId: ME, templateId: LIST };
eq('memo: nothing cached yet', readGateMemo(id, { store }), null);
writeGateMemo(id, { state: GATE.DONE, done: 10, total: 10 }, { store, now: NOW });
eq('memo: stored under the versioned key', store._raw.has(GATE_MEMO_KEY), true);
eq('memo: read back done', readGateMemo(id, { store, now: NOW })?.state, GATE.DONE);
eq('memo: read back counts', `${readGateMemo(id, { store, now: NOW })?.done}/${readGateMemo(id, { store, now: NOW })?.total}`, '10/10');
writeGateMemo(id, { state: GATE.BLOCKED, done: 2, total: 10 }, { store, now: NOW + 1000 });
eq('memo: a later PARTIAL never overwrites a remembered done', readGateMemo(id, { store, now: NOW + 1000 })?.state, GATE.DONE);
writeGateMemo({ jobId: 'j9', userId: ME, templateId: LIST }, { state: GATE.BLOCKED, done: 2, total: 10 }, { store, now: NOW });
eq('memo: a blocked verdict for a fresh clean is remembered', readGateMemo({ jobId: 'j9', userId: ME, templateId: LIST }, { store, now: NOW })?.done, 2);
eq('memo: an expired row reads as nothing', readGateMemo(id, { store, now: NOW + GATE_MEMO_MAX_AGE_MS + 1000 }), null);
eq('memo: unknown is never remembered', writeGateMemo({ jobId: 'j8', userId: ME, templateId: LIST }, { state: GATE.UNKNOWN }, { store, now: NOW }), false);

let threw = false;
try { writeGateMemo(id, { state: GATE.DONE, done: 1, total: 1 }, { store: fakeStore(true), now: NOW }); } catch { threw = true; }
ok('memo: a quota error never reaches the caller', threw === false);
ok('memo: no store at all is a no-op, not a crash', readGateMemo(id, { store: null }) === null);

// K4 — a remembered DONE can be WITHDRAWN. `writeGateMemo` refuses every downgrade (a
// partial re-submission must never undo a finished checklist), so the one case that CAN
// make a DONE wrong — the queued submission it was derived from failing terminally and
// never reaching the server — needs its own door. Without it the phone stays unlocked
// offline for a clean the office will never see a checklist for.
eq('memo: the done verdict is there to withdraw', readGateMemo(id, { store, now: NOW })?.state, GATE.DONE);
eq('memo: forget drops exactly that row', forgetGateMemo(id, { store, now: NOW }), true);
eq('memo: …and it reads as nothing afterwards', readGateMemo(id, { store, now: NOW }), null);
eq('memo: …while another clean’s row survives', readGateMemo({ jobId: 'j9', userId: ME, templateId: LIST }, { store, now: NOW })?.done, 2);
eq('memo: forgetting a row that isn’t there is a no-op', forgetGateMemo({ jobId: 'nope', userId: ME, templateId: LIST }, { store, now: NOW }), false);
ok('memo: forget with no store is a no-op, not a crash', forgetGateMemo(id, { store: null }) === false);
writeGateMemo(id, { state: GATE.BLOCKED, done: 2, total: 10 }, { store, now: NOW });
eq('memo: after a withdrawal the next verdict is recorded normally', readGateMemo(id, { store, now: NOW })?.state, GATE.BLOCKED);

// ── reconnect order: checklists before punches, once ────────────────────────
const seen = [];
const steps = [
  { name: 'checklists', run: async () => { seen.push('checklists'); return { flushed: 1 }; } },
  { name: 'punches', run: async () => { seen.push('punches'); return { flushed: 2 }; } },
];
const r1 = await runOrderedFlush('clock', steps);
eq('flush order: checklists first', seen.join('>'), 'checklists>punches');
eq('flush order: each step’s result comes back', r1.checklists?.flushed, 1);
eq('flush order: punch result too', r1.punches?.flushed, 2);

seen.length = 0;
let release;
const gate2 = new Promise((res) => { release = res; });
const slow = [
  { name: 'checklists', run: async () => { seen.push('checklists'); await gate2; return { flushed: 0 }; } },
  { name: 'punches', run: async () => { seen.push('punches'); return { flushed: 0 }; } },
];
const a = runOrderedFlush('clock', slow);
const b = runOrderedFlush('clock', slow);
ok('flush order: single-flight — a second trigger joins the pass in flight', a === b);
release();
await a;
eq('flush order: the joined pass ran each step once', seen.join('>'), 'checklists>punches');
const c = runOrderedFlush('clock', steps);
ok('flush order: a later trigger starts a new pass', c !== a);
await c;

// A trigger that must NOT be swallowed by the pass already running (the Retry button):
// it chains a fresh pass behind it, so the tap always reaches the queue, and the order
// inside each pass is still checklists-then-punches.
seen.length = 0;
let release2;
const gate3 = new Promise((res) => { release2 = res; });
const slow2 = [
  { name: 'checklists', run: async () => { seen.push('checklists'); await gate3; return { flushed: 0 }; } },
  { name: 'punches', run: async () => { seen.push('punches'); return { flushed: 0 }; } },
];
const first = runOrderedFlush('clock', slow2);
const chained = runOrderedFlush('clock', steps, { chain: true });
ok('flush order: a chained trigger is NOT the pass in flight', chained !== first);
release2();
const chainedResult = await chained;
eq('flush order: the chained pass ran AFTER the first, each in order', seen.join('>'), 'checklists>punches>checklists>punches');
eq('flush order: the chained pass ran its own steps', chainedResult.checklists?.flushed, 1);
await first;

seen.length = 0;
const broken = [
  { name: 'checklists', run: async () => { seen.push('checklists'); throw new Error('boom'); } },
  { name: 'punches', run: async () => { seen.push('punches'); return { flushed: 7 }; } },
];
const r2 = await runOrderedFlush('clock', broken);
eq('flush order: a thrown step never skips the next', seen.join('>'), 'checklists>punches');
ok('flush order: the thrown step is reported, not rethrown', !!r2.checklists?.error);
eq('flush order: the later step still ran', r2.punches?.flushed, 7);

// ── the wiring the rules above depend on ────────────────────────────────────
// K1 — SIGN-OUT is the end of a shift on a shared phone, so it replays the punch queue.
// It used to call flushOfflineQueue() directly, which put a replayed clock-out ahead of
// the checklist that finished the clean and flagged an entry that was fine.
const auth = readFileSync(new URL('../src/auth/AuthProvider.jsx', import.meta.url), 'utf8');
ok('sign-out drains through the ordered pump', /flushClockQueues\(/.test(auth));
ok('sign-out no longer calls the punch queue directly', !/\bflushOfflineQueue\(/.test(auth));
ok('sign-out still clears the gate memo (a shared phone)', /clearGateMemo\(/.test(auth));

// Every trigger of the clock queues goes through the ONE ordered pump. (The media queue
// is not in it — media order cannot flag a punch — and a checklist-only drain can never
// put a punch ahead of a checklist, but the Retry button routes through the pump anyway
// so there is a single answer to "what drains the clock queues".)
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
for (const f of ['../src/components/OfflineClockSync.jsx', '../src/components/OfflineChecklistSync.jsx', '../src/components/OfflineQueueFailures.jsx', '../src/auth/AuthProvider.jsx']) {
  const s = src(f);
  ok(`${f.split('/').pop()} drains the clock queues through flushClockQueues`, /flushClockQueues\(/.test(s));
  ok(`${f.split('/').pop()} calls neither clock queue directly`, !/\bflushOfflineQueue\(|\bflushChecklistQueue\(/.test(s));
}

// K5 — the failed-queue card is mounted ONCE, in the shell, so a cleaner sees it wherever
// they are working a clean (My Day, the crew visit, a job page), never twice.
const layout = src('../src/layouts/AppLayout.jsx');
const myDay = src('../src/pages/MyDay.jsx');
ok('the failed-queue card is mounted in the app shell', /<OfflineQueueFailures\s*\/>/.test(layout));
ok('…and not a second time on My Day', !/<OfflineQueueFailures/.test(myDay));

// K2's other half: the component drops a stale 409 once the gate says done, so the state
// cannot outlive the refusal it described.
const cc = src('../src/components/ClockControl.jsx');
ok('ClockControl clears a stale serverBlock when the gate reaches DONE', /gate\.state === GATE\.DONE[\s\S]{0,120}setServerBlock\(null\)/.test(cc));
// S2's client half: a 503 checklist_check_failed sets its own state (never serverBlock,
// which would lock the button and accuse the cleaner), and a later answer clears it.
ok('ClockControl branches on the 503 code', /CHECKLIST_CHECK_FAILED_CODE/.test(cc));
ok('…and feeds it to the button state as checkFailed', /checkFailed/.test(cc));

// ── report ──────────────────────────────────────────────────────────────────
for (const f of fails) console.error(`✖ ${f}`);
console.log(`\n${pass}/${pass + fails.length} clock-out-gate cases green`);
process.exit(fails.length ? 1 : 0);
