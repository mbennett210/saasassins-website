// The phone's memory of the clock-out gate's last known verdict, per (clean, cleaner,
// checklist).
//
// WHY. A cleaner finishes their checklist online, the phone restarts in a basement, and
// the results read now fails: without this the gate reads UNKNOWN and locks a cleaner who
// already finished — exactly the stranding R5 has no escape from. The remembered verdict
// is fed back into clockOutGate as its `results`, so ONE rule still decides.
//
// RETENTION AT THE WRITE POINT (THE LAW II.8, DEV_PLAYBOOK 3.5.6): every write prunes by
// an absolute age ceiling AND a count cap, so this can never grow into the phone's
// storage budget. Every read and write is quota- and parse-guarded: losing the memo
// degrades to UNKNOWN (locked with a reason), never to a crash or a false pass.
//
// Pure except for the injected `store` (localStorage by default), so the retention and
// the never-downgrade rule are unit-tested headlessly (scripts/test-clock-out-gate.mjs).
import { GATE } from './crewChecklist.js';
import { capTail, pruneByAge, DAY_MS } from './retention.js';

export const GATE_MEMO_KEY = 'cleanspace_checklist_gate_v1';
export const GATE_MEMO_MAX = 200;                       // count cap (≈ a busy month of cleans)
export const GATE_MEMO_MAX_AGE_MS = 30 * DAY_MS;        // absolute age ceiling

export function memoKey({ jobId = null, userId = null, templateId = null } = {}) {
  return `${jobId || ''}|${userId || ''}|${templateId || ''}`;
}

const defaultStore = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

// Rows are append-newest-LAST, so capTail keeps the newest (retention.js's ordering
// invariant). pruneByAge keeps an undated/legacy row rather than guessing it is expired.
export function pruneGateMemo(rows, { now = Date.now(), max = GATE_MEMO_MAX, maxAgeMs = GATE_MEMO_MAX_AGE_MS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return capTail(pruneByAge(list, maxAgeMs, now, ['at']), max);
}

function readAll(store, now) {
  const s = store === undefined ? defaultStore() : store;
  if (!s) return { store: null, rows: [] };
  let rows = [];
  try {
    const parsed = JSON.parse(s.getItem(GATE_MEMO_KEY) || 'null');
    rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch { rows = []; }          // corrupt / half-written → start over, never throw
  return { store: s, rows: pruneGateMemo(rows, { now }) };
}

// The remembered verdict, in the shape clockOutGate's `results` takes (one row), or null.
export function readGateMemo(id, { store, now = Date.now() } = {}) {
  const { store: s, rows } = readAll(store, now);
  if (!s) return null;
  const k = memoKey(id);
  const hit = rows.filter((r) => r && r.k === k).pop() || null;
  return hit ? { state: hit.state, done: hit.done, total: hit.total, at: hit.at } : null;
}

// Remember a verdict. UNKNOWN is never stored (there is nothing to remember), and a
// remembered DONE is never downgraded to BLOCKED — the same law the gate itself follows:
// a later partial re-submission does not undo a finished checklist. Returns whether it
// wrote, so a caller can skip needless work.
export function writeGateMemo(id, verdict, { store, now = Date.now() } = {}) {
  if (!verdict || (verdict.state !== GATE.DONE && verdict.state !== GATE.BLOCKED)) return false;
  const { store: s, rows } = readAll(store, now);
  if (!s) return false;
  const k = memoKey(id);
  const prior = rows.filter((r) => r && r.k === k).pop() || null;
  if (prior && prior.state === GATE.DONE && verdict.state !== GATE.DONE) return false;
  const next = pruneGateMemo([
    ...rows.filter((r) => r && r.k !== k),
    { k, state: verdict.state, done: verdict.done || 0, total: verdict.total || 0, at: new Date(now).toISOString() },
  ], { now });
  try {
    s.setItem(GATE_MEMO_KEY, JSON.stringify({ v: 1, rows: next }));
    return true;
  } catch {
    // QuotaExceededError / private mode / blocked site data: the gate still works from
    // the live read and the queue (PERF-23). Never surface it to the crew.
    return false;
  }
}

// WITHDRAW one remembered verdict. `writeGateMemo` refuses every downgrade on purpose,
// which leaves exactly one way for a remembered DONE to be wrong: it was derived from a
// submission still QUEUED on the phone, and that submission then failed terminally and
// will never reach the server. The queue's drain calls this when it marks a checklist
// failed (lib/qcApi), so the clock-out does not stay unlocked offline for a clean the
// office will never see a checklist for. Returns whether a row was actually dropped.
export function forgetGateMemo(id, { store, now = Date.now() } = {}) {
  const { store: s, rows } = readAll(store, now);
  if (!s) return false;
  const k = memoKey(id);
  const next = rows.filter((r) => r && r.k !== k);
  if (next.length === rows.length) return false;
  try {
    s.setItem(GATE_MEMO_KEY, JSON.stringify({ v: 1, rows: next }));
    return true;
  } catch {
    return false;
  }
}

// Sign-out on a shared device: the memo names who finished what.
export function clearGateMemo({ store } = {}) {
  const s = store === undefined ? defaultStore() : store;
  if (!s) return;
  try { s.removeItem(GATE_MEMO_KEY); } catch { /* nothing to clear */ }
}
