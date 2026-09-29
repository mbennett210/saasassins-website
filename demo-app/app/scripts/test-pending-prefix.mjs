// A committed save must clear exactly the actions it persisted — no more, no less.
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════
// flush() snapshots `live`/`shared`, then AWAITS the network write. The user keeps
// working during that await: every action dispatched in the window lands in the pending
// queue and in local state, but is NOT in the snapshot being written.
//
// clearPending() wiped the WHOLE queue on commit, so the queue then claimed those edits
// were saved when they were not. Locally nothing looked wrong — the `dirty` flag
// schedules a follow-up flush that would persist them — but if a CAS conflict landed
// first, adoptRemote() replaced local state with the remote document and replayed a
// queue that no longer held them. The edits vanished with no error.
//
// ══ WHY PRECISION IS LOAD-BEARING IN BOTH DIRECTIONS ══════════════════════════
//   clearing TOO MUCH  -> the bug above: edits lost on the next conflict.
//   clearing TOO LITTLE -> already-committed actions replay on the next conflict. For
//                          ADD_INVOICE_PAYMENT that records the same payment twice,
//                          which is a separate confirmed finding in the money sweep.
// So this suite asserts BOTH bounds, not just "nothing was lost".
//
//   node scripts/test-pending-prefix.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const sync = read('../src/store/sync.js');
const store = read('../src/store/index.jsx');

// ── the invariant the fix depends on ────────────────────────────────────
// The prefix is only exact if the queue is append-only and an action is queued in the
// same synchronous turn it is applied.
{
  ok('the queue is append-only (push, never splice/unshift)',
    /pendingRef\.current\.push\(action\)/.test(store)
    && !/pendingRef\.current\.(unshift|splice)\(/.test(store));
  ok('  ...and the push happens in the same turn as the dispatch',
    /pendingRef\.current\.push\(action\);\s*\n\s*\}\s*\n\s*dispatch\(action\);/.test(store));
  ok('setPending replaces the queue wholesale (so a slice is the way to drop a prefix)',
    /setPending: \(actions\) => \{ pendingRef\.current = Array\.isArray\(actions\) \? actions : \[\]; \}/.test(store));
  ok('HYDRATE/RESET are never queued (they are the sync manager\'s own writes)',
    /action\.type !== ACTIONS\.HYDRATE && action\.type !== ACTIONS\.RESET/.test(store));
}

// ── 🔴 the prefix is captured next to the snapshot ──────────────────────
{
  ok('pendingCovered is recorded', /const pendingCovered = getPending\(\)\.length;/.test(sync));
  const iLive = sync.indexOf('const live = getState();');
  const iCovered = sync.indexOf('const pendingCovered = getPending().length;');
  const iAwait = sync.indexOf('await saveViaServer', iLive);
  ok('  🔴 ...after getState()', iLive > 0 && iCovered > iLive);
  ok('  🔴 ...and BEFORE any await (or the count would include in-flight actions)',
    iAwait === -1 || iCovered < iAwait);
}

// ── 🔴 both commit paths clear the PREFIX, not the queue ────────────────
{
  const slices = (sync.match(/setPending\(getPending\(\)\.slice\(pendingCovered\)\)/g) || []).length;
  // Four prefix-drop sites: content-guard, committed, the guard-REJECTED path (a
  // refused protected-field change must drop its prefix or adoptRemote replays the
  // refusal forever), and the TERMINAL-AUTH path (2026-09-23 — account-disabled /
  // not-on-team: the covered actions can never be saved by this login, so drop them
  // as we sign out rather than leave them to replay). All four drop the PREFIX only.
  ok(`🔴 all save paths drop only the covered prefix (${slices}/4)`, slices === 4);
  ok('  ...the content-guard (blob unchanged) path', /sharedJson === lastSavedStateJson\)\s*\{[\s\S]{0,400}?setPending\(getPending\(\)\.slice\(pendingCovered\)\)/.test(sync));
  ok('  ...the committed path', /lastSavedStateJson = sharedJson;[\s\S]{0,400}?setPending\(getPending\(\)\.slice\(pendingCovered\)\)/.test(sync));
  ok('  ...the guard-rejected path', /viaServer\.rejected\)[\s\S]{0,900}?setPending\(getPending\(\)\.slice\(pendingCovered\)\)/.test(sync));
  ok('  ...the terminal-auth (account-disabled / not-on-team) path', /viaServer\.terminal\)[\s\S]{0,900}?setPending\(getPending\(\)\.slice\(pendingCovered\)\)/.test(sync));
  ok('🔴 neither of them wipes the whole queue any more',
    !/lastSavedStateJson = sharedJson;[\s\S]{0,300}?clearPending\(\);/.test(sync));
}

// ── the replay path must KEEP the queue ─────────────────────────────────
// adoptRemote replays pending through the RAW dispatch (not dispatchLocal), so replayed
// actions are not re-queued. The queue must therefore survive the replay — the next
// successful flush is what clears it.
{
  const fn = (sync.match(/function adoptRemote\(remote\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  ok('adoptRemote found', fn.length > 0);
  ok('it replays the queue', /pending\.forEach\(\(a\) => dispatch\(a\)\)/.test(fn));
  // clearPending must sit in the ELSE branch only — i.e. it runs when there was
  // nothing to replay, never after a replay. (Tolerant of trailing comments.)
  {
    const replayBranch = (fn.match(/if \(pending\.length > 0\) \{([\s\S]*?)\n    \} else \{/) || [])[1] || '';
    const elseBranch = (fn.match(/\} else \{([\s\S]*?)\n    \}/) || [])[1] || '';
    ok('  🔴 ...and does NOT clear it when there was something to replay',
      replayBranch.length > 0 && !/clearPending\(\)/.test(replayBranch));
    ok('  ...clearing only happens when the queue was already empty',
      /clearPending\(\)/.test(elseBranch));
  }
  ok('  ...it schedules a save so the replayed edits persist', /scheduleSave\(\)/.test(fn));
}

// ── simulate the exact race, before and after ───────────────────────────
{
  // A: dispatched before the snapshot (covered by the write).
  // B: dispatched DURING the in-flight write (not covered).
  const run = (clearAll) => {
    let queue = ['A'];
    const covered = queue.length;      // snapshot taken here
    queue = [...queue, 'B'];           // user keeps working during the await
    // write commits:
    queue = clearAll ? [] : queue.slice(covered);
    // then a CAS conflict: adopt remote (which contains A but not B) and replay.
    const remoteHas = ['A'];
    return [...remoteHas, ...queue];
  };

  const before = run(true);
  ok('THE OLD SHAPE lost the in-flight edit on the next conflict', !before.includes('B'));
  const after = run(false);
  ok('🔴 the in-flight edit now survives the conflict', after.includes('B'));
  ok('  ...and the committed one is not replayed twice',
    after.filter((x) => x === 'A').length === 1);
}

// ── the double-apply bound, stated explicitly ───────────────────────────
{
  // Clearing too little is the other failure: a committed action replayed on adopt.
  const replayCount = (covered) => {
    let queue = ['PAYMENT'];
    queue = queue.slice(covered);
    return ['PAYMENT', ...queue].filter((x) => x === 'PAYMENT').length;
  };
  ok('clearing the exact prefix applies a committed payment ONCE', replayCount(1) === 1);
  ok('🔴 clearing NOTHING would double-record it (why the count must be exact)', replayCount(0) === 2);
}

console.log(`\npending prefix: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
