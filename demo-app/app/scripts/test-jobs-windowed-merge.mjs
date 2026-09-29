// Node unit test for the windowed-boot jobs merge (mergeFullJobs) — the logic that
// reconciles the full table set with the local array after a fast windowed first paint.
// The load-bearing safety property: after hydration the app holds the COMPLETE set, and
// the NEXT save (mirror baseline = the pristine table set `all`) must write EXACTLY the
// edits/creates/deletes the user made during the window-only gap — and NOTHING on a clean
// boot. A bug here would mass-rewrite or mass-delete the live public.jobs table.
//
// Models the reducer's ref discipline: SET_JOBS stores the passed objects by reference,
// and an edit/create/delete produces a NEW object for the touched job while leaving the
// rest by ref (exactly what diffJobs keys off). `all` comes from a SEPARATE table read,
// so even unchanged ids are DIFFERENT object refs than the painted window snapshot.
//   node scripts/test-jobs-windowed-merge.mjs   (from app/)
import { mergeFullJobs, diffJobs } from '../src/store/jobsMerge.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };
const ids = (arr) => arr.map((j) => j.id).sort().join(',');
const job = (id, extra = {}) => ({ id, startAt: `2026-07-${String((Number(id.replace(/\D/g, '')) % 28) + 1).padStart(2, '0')}T10:00:00.000Z`, status: 'upcoming', ...extra });

// A fresh table read: same ids/content as the given jobs but DISTINCT object refs
// (this is what fetchAllJobs returns — never the same refs the window painted).
const tableCopy = (arr) => arr.map((j) => ({ ...j }));

// The full authoritative table set: two in-window ids (1,2) + two out-of-window (3,4).
const windowIds = [job('j1'), job('j2')];
const outOfWindow = [job('j3', { startAt: '2027-02-01T10:00:00.000Z' }), job('j4', { startAt: '2027-03-01T10:00:00.000Z' })];
const allTable = () => tableCopy([...windowIds, ...outOfWindow]); // fresh refs each call

// ── Scenario A: clean boot, no gap edits ────────────────────────────────────────────
// current === the painted window (same refs). Merged must equal the full set, and the
// next flush (diff pristine `all` vs merged) must write NOTHING.
{
  const snapshot = windowIds;           // painted refs
  const current = [...windowIds];        // no edits → same refs
  const all = allTable();
  const { merged, changed, removed } = mergeFullJobs(snapshot, current, all);
  ok(ids(merged) === 'j1,j2,j3,j4', 'A: merged holds the COMPLETE set (window + out-of-window)');
  ok(changed.length === 0 && removed.length === 0, 'A: no local divergence detected');
  const flush = diffJobs(all, merged); // what the next save would mirror (baseline = all)
  ok(flush.changed.length === 0 && flush.removed.length === 0, 'A: SAFETY — next save writes NOTHING on a clean boot');
}

// ── Scenario B: gap edit of an in-window job ─────────────────────────────────────────
{
  const snapshot = windowIds;
  const editedJ1 = { ...windowIds[0], status: 'done' }; // reducer makes a new ref on edit
  const current = [editedJ1, windowIds[1]];
  const all = allTable();
  const { merged, changed, removed } = mergeFullJobs(snapshot, current, all);
  ok(ids(merged) === 'j1,j2,j3,j4', 'B: merged still holds the full set');
  ok(merged.find((j) => j.id === 'j1').status === 'done', 'B: local edit wins over the table copy');
  ok(changed.length === 1 && removed.length === 0, 'B: exactly one gap edit detected');
  const flush = diffJobs(all, merged);
  ok(flush.changed.length === 1 && flush.changed[0].id === 'j1' && flush.removed.length === 0,
    'B: SAFETY — next save mirrors ONLY the edited job');
}

// ── Scenario C: gap create ───────────────────────────────────────────────────────────
{
  const snapshot = windowIds;
  const created = job('jNEW', { status: 'upcoming' });
  const current = [...windowIds, created];
  const all = allTable();
  const { merged, changed, removed } = mergeFullJobs(snapshot, current, all);
  ok(ids(merged) === 'j1,j2,j3,j4,jNEW', 'C: created job is present alongside the full set');
  ok(changed.length === 1 && changed[0].id === 'jNEW' && removed.length === 0, 'C: create detected');
  const flush = diffJobs(all, merged);
  ok(flush.changed.length === 1 && flush.changed[0].id === 'jNEW' && flush.removed.length === 0,
    'C: SAFETY — next save upserts ONLY the new job');
}

// ── Scenario D: gap delete of an in-window job ───────────────────────────────────────
{
  const snapshot = windowIds;
  const current = [windowIds[1]]; // j1 deleted during the gap
  const all = allTable();
  const { merged, changed, removed } = mergeFullJobs(snapshot, current, all);
  ok(ids(merged) === 'j2,j3,j4', 'D: deleted job is absent; the rest of the full set remains');
  ok(removed.length === 1 && removed[0] === 'j1' && changed.length === 0, 'D: delete detected');
  const flush = diffJobs(all, merged);
  ok(flush.removed.length === 1 && flush.removed[0] === 'j1' && flush.changed.length === 0,
    'D: SAFETY — next save deletes ONLY the removed job (no cascade)');
}

// ── Scenario E: realtime upsert of an out-of-window job during the gap ────────────────
// A peer tab changed an out-of-window job; PATCH_JOBS added it to `current`. The newer
// realtime copy must survive the full-load merge (not be clobbered by the table read).
{
  const snapshot = windowIds;
  const realtimeJ3 = { ...outOfWindow[0], status: 'cancelled', notes: 'peer edit' };
  const current = [...windowIds, realtimeJ3]; // r3 arrived via realtime during the gap
  const all = allTable(); // table's j3 is still 'upcoming' (pre-edit read)
  const { merged, changed, removed } = mergeFullJobs(snapshot, current, all);
  ok(merged.find((j) => j.id === 'j3').status === 'cancelled', 'E: realtime change survives the merge');
  ok(ids(merged) === 'j1,j2,j3,j4', 'E: no duplicate j3, full set intact');
  ok(changed.length === 1 && changed[0].id === 'j3', 'E: realtime job counted as local divergence');
}

// ── Scenario F: large set, window is a small subset, no edits → zero-delta ────────────
{
  const big = [];
  for (let i = 0; i < 5000; i++) big.push(job('b' + i, { startAt: `2026-1${(i % 2) + 1}-01T10:00:00.000Z` }));
  const snapshot = big.slice(0, 300);           // painted window
  const current = [...snapshot];                 // no edits
  const all = tableCopy(big);                    // full set, fresh refs
  const { merged, changed, removed } = mergeFullJobs(snapshot, current, all);
  ok(merged.length === 5000, 'F: merged restores the full 5000-row set from a 300-row window');
  ok(changed.length === 0 && removed.length === 0, 'F: no divergence');
  const flush = diffJobs(all, merged);
  ok(flush.changed.length === 0 && flush.removed.length === 0, 'F: SAFETY — 0 writes despite a 300→5000 hydration');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
