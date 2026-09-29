// Pure jobs diff/merge core — no I/O, no imports, no Supabase. Kept separate from
// jobsSync.js (which pulls in the Supabase client) so it can be unit-tested under plain
// node and reasoned about in isolation. jobsSync re-exports these for existing callers.

// Diff prev vs curr jobs by id. The reducer keeps the SAME object reference for
// unchanged jobs (it only allocates new objects for the ones it touched), so a
// reference difference means "added or changed" — an O(n) diff with no deep compare.
// Split a jobs delta into request-sized chunks, packing removals into whatever
// room is left after the changed rows so no request exceeds `max` TOTAL rows
// (the server counts changed + removed against one cap — app/api/state/
// jobs-delta.js). Lives here, in the dependency-free core, so the packing is
// unit-tested rather than eyeballed: an off-by-one is invisible on everyday
// deltas and only bites on a large series edit, where the symptom is a
// platform-layer 413 with no useful error.
//
// A row cap alone does NOT bound the payload — job payloads average ~2.8 KB but
// the tail is much fatter, so 200 fat rows can still clear the platform body
// cap and 413 before the handler runs (and a 413 is not retryable at the same
// chunk size — it would loop forever). `maxBytes` closes that: a chunk also
// ends once its serialized size would exceed the budget. A single row larger
// than the budget still ships alone, because splitting one row is impossible —
// that case must fail loudly rather than silently drop the job.
//
// Invariants: every input row appears in exactly one chunk, in order; no chunk
// exceeds `max` rows; no chunk exceeds `maxBytes` unless it is a single row; an
// empty delta yields NO chunks (so a no-op makes no request).
export function splitDelta(changed = [], removed = [], max = 200, maxBytes = 1_500_000) {
  const chunks = [];
  let ci = 0;
  let ri = 0;
  while (ci < changed.length || ri < removed.length) {
    const c = [];
    let bytes = 0;
    while (ci < changed.length && c.length < max) {
      const size = JSON.stringify(changed[ci]).length;
      if (c.length > 0 && bytes + size > maxBytes) break; // never emit an empty chunk
      c.push(changed[ci]);
      bytes += size;
      ci += 1;
    }
    const room = max - c.length;
    const r = [];
    while (ri < removed.length && r.length < room) {
      const size = String(removed[ri]).length + 3;
      if ((c.length > 0 || r.length > 0) && bytes + size > maxBytes) break;
      r.push(removed[ri]);
      bytes += size;
      ri += 1;
    }
    if (!c.length && !r.length) break; // guard against a stalled loop
    chunks.push({ changed: c, removed: r });
  }
  return chunks;
}

// ORDER-GUARDED-PATCH (Increment 2). Apply realtime upserts/deletes to the jobs
// array, DROPPING any upsert that is not strictly newer than the row already
// held. `_rv` is the row's globally monotonic server stamp (public.jobs
// .row_version); absent/NULL reads as 0, the oldest possible version.
//
// Realtime delivery is unordered — Broadcast, which replaces postgres_changes
// here, explicitly so — meaning an older payload can arrive after a newer one
// and silently revert a row. This makes "is it actually newer?" answerable
// locally.
//
// It is NOT the delivery guarantee: a DROPPED message has no row to compare
// against. The keyset cursor poll (store/sync.js jobsCursorPoll) is the
// authoritative backstop; this only prevents reordering damage.
//
// Returns { jobs, changed }. `changed:false` means the caller should preserve
// the previous state reference — a dropped stale patch must not re-render every
// jobs consumer or dirty the save path.
// Filter jobs to a date window, for the offline cache (SCALE-C14 / §8 G4).
//
// cacheJobs is a MAIN-THREAD structured clone, so its cost is the row count. Cloning
// the full ~19k-row set was ~52.9 MB resident — enough that the browser may evict the
// whole origin's storage under quota pressure, silently destroying the offline cache
// the crew depend on in the field. Caching what boot actually paints is both smaller
// and sufficient.
//
// A job with NO startAt is KEPT. It cannot be placed in the window, and dropping it
// would lose it from an offline boot entirely — the wrong direction to fail when the
// whole point is preserving usable state offline.
//
// `from`/`to` are 'YYYY-MM-DD' day keys, compared as strings against the ISO prefix —
// no Date construction per row, and no timezone to get wrong (the bounds are already
// loose by ±45/+100 days).
export function jobsInWindow(jobs, from, to) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!from || !to) return list;
  return list.filter((j) => {
    const s = j?.startAt;
    if (typeof s !== 'string' || s.length < 10) return true; // unplaceable — keep
    const day = s.slice(0, 10);
    return day >= from && day <= to;
  });
}

// Advance the keyset cursor across TWO streams — upserts from public.jobs and
// tombstones from public.job_deletes, which draws row_version from the same sequence
// so one scalar cursor covers both (D6).
//
// THE TRAP: a truncated page means that stream is complete only up to its OWN max, so
// the UNION is complete only up to the LOWER of the two. Taking max() across a
// truncated upsert page and a tombstone page pushes the cursor PAST upsert rows that
// were never fetched — and they are missed FOREVER, because nothing revisits a cursor
// once advanced. Silent and permanent, which is why this is a pure exported function
// with its own test rather than three lines inlined in the poll.
//
// While the tombstone migration is unapplied the caller passes tombMax 0 / tombFull
// false, and this reduces to exactly the previous behaviour.
export function nextJobsCursor({ cursor, upsertMax, tombMax, upsertFull, tombFull }) {
  const next = (upsertFull || tombFull)
    ? Math.min(upsertFull ? upsertMax : Infinity, tombFull ? tombMax : Infinity)
    : Math.max(upsertMax ?? 0, tombMax ?? 0);
  return next > cursor ? next : cursor; // never backwards, never a spin
}

// A delete memory that remembers nothing — the default, so this module keeps the
// "no imports" contract in the file header and stays unit-testable under plain node.
// The real one (store/jobTombstones.js) is INJECTED by the reducer; tests pass a
// plain object. With this default the guard degrades to exactly the old behaviour,
// which is what makes the parameter safe to add ahead of every caller adopting it.
const NO_TOMB = { get: () => undefined, clear: () => {}, noteOcc: () => {} };

// `tomb` is the delete memory (store/jobTombstones.js), injected by the caller.
export function applyJobPatch(jobs, upserts = [], deletes = [], tomb = NO_TOMB) {
  const byId = new Map((jobs || []).map((j) => [j.id, j]));
  let changed = false;
  for (const j of upserts) {
    if (!j || !j.id) continue;
    const cur = byId.get(j.id);
    const tombRv = tomb?.get?.(j.id);
    // THE FIX (D6 defect b): the floor is the higher of "what I still hold" and
    // "what I remember deleting". The old guard was `if (cur && …)`, so with `cur`
    // ABSENT it short-circuited and applied a reordered OLDER upsert
    // unconditionally — and persistJobsDelta then mirrored that resurrection back
    // into the database. Harmless under ordered postgres_changes; live the moment
    // Broadcast lands, which is unordered by design.
    const floor = Math.max(cur ? (cur._rv ?? 0) : -1, tombRv ?? -1);
    if ((j._rv ?? 0) <= floor) continue; // stale, duplicate, or a resurrection
    // Strictly newer than the delete, so the row is genuinely alive again. Clearing
    // (rather than keeping the tombstone) is what makes the tab converge on the
    // database instead of hiding a row the database holds.
    tomb?.clear?.(j.id);
    byId.set(j.id, j);
    changed = true;
  }
  for (const id of deletes) {
    const cur = byId.get(id);
    const tombRv = tomb?.get?.(id);
    // Deletes are order-guarded too. Under Broadcast a tombstone at rv 600 can
    // arrive AFTER a legitimate re-create at rv 601; applying it would silently drop
    // a LIVE job from the board with the cursor already past it — the worst outcome
    // available here, because nothing incremental would ever correct it.
    if (cur && tombRv != null && (cur._rv ?? 0) > tombRv) continue;
    if (byId.delete(id)) { tomb?.noteOcc?.(cur); changed = true; }
  }
  return changed ? { jobs: [...byId.values()], changed: true } : { jobs, changed: false };
}

// ── THE PING-PONG FIX (pure core) ────────────────────────────────────────────
// Advance the mirror baseline for rows that just arrived FROM the server
// (realtime patch or cursor poll). diffJobs below compares by OBJECT REFERENCE
// and the baseline otherwise advances only after a successful flush — so a
// server-originated row, applied to state with a fresh object identity, read as
// "locally changed" and was re-POSTed on the next save even though its data was
// identical. Each re-POST bumped row_version and fanned a per-row realtime event
// to every other tab, drifting THEIR baselines in turn — measured live at ~165
// UPDATEs per row (4.2M on 19k rows) and whole-table rewrites hourly.
// (app/api/state/jobs-delta.js names this exact bug in its own comment.)
//
// `stateJobs` is the array AFTER the PATCH_JOBS dispatch (synchronous), so it
// holds the applied rows. Pointing baseline entries at those SAME objects makes
// a server-originated row reference-identical to the baseline — the next diff
// sees no change. It can never mask a genuine local edit: a local edit is a ref
// the server never sent, so state ≠ baseline for it regardless.
//   · upsert dropped by the order guard → state still holds the row the baseline
//     already points at → the re-assignment is a no-op.
//   · upsert for a row not in state (guard dropped it and the row was never
//     held, or a pending local delete removed it) → baseline untouched, so a
//     pending local delete still diffs out as a delete.
//   · delete rejected by the order guard (row genuinely newer in state) → the
//     baseline entry is KEPT, so the surviving row does not read as a local
//     re-create and get re-POSTed.
// Returns the new baseline array.
export function advanceBaseline(baseline, stateJobs, upserts = [], deletes = []) {
  const stateById = new Map();
  for (const j of stateJobs || []) if (j && j.id) stateById.set(j.id, j);
  const byId = new Map();
  for (const j of baseline || []) if (j && j.id) byId.set(j.id, j);
  for (const u of upserts) {
    const id = u && u.id;
    if (!id) continue;
    const cur = stateById.get(id);
    if (cur) byId.set(id, cur);
  }
  for (const id of deletes) {
    if (!stateById.has(id)) byId.delete(id);
  }
  return [...byId.values()];
}

export function diffJobs(prevJobs, currJobs) {
  const prev = new Map();
  for (const j of prevJobs || []) if (j && j.id) prev.set(j.id, j);
  const curr = new Map();
  for (const j of currJobs || []) if (j && j.id) curr.set(j.id, j);

  const changed = [];
  for (const [id, job] of curr) {
    if (prev.get(id) !== job) changed.push(job); // new or mutated
  }
  const removed = [];
  for (const id of prev.keys()) {
    if (!curr.has(id)) removed.push(id);
  }
  return { changed, removed };
}

// Reconcile the authoritative full table set with the local jobs array after a
// windowed boot. `windowSnapshot` = the exact objects painted at first paint; `current`
// = the live array (that window plus any edit/create/delete the user made during the
// window-only gap); `all` = the full set just read from the table. Returns the array to
// display AND the delta the caller must still mirror. Because the reducer preserves object
// refs for untouched jobs, diffing current against the snapshot pinpoints local gap-changes;
// those win over the (older) table copy, everything else takes the fresh table copy. With
// the caller then setting its mirror baseline to `all`, the next save writes exactly
// {changed → upserts, removed → deletes} and nothing else (on a clean boot: nothing).
export function mergeFullJobs(windowSnapshot, current, all) {
  const { changed, removed } = diffJobs(windowSnapshot || [], current || []);
  const byId = new Map((all || []).map((j) => [j.id, j]));
  for (const j of changed) if (j && j.id) byId.set(j.id, j); // local edits / creates win
  for (const id of removed) byId.delete(id);                 // honor local deletions
  return { merged: [...byId.values()], changed, removed };
}
