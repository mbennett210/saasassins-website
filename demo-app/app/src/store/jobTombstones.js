// Delete memory for the jobs order guard (D6 defect b).
//
// THE BUG: applyJobPatch's guard was `if (cur && (j._rv ?? 0) <= (cur._rv ?? 0))`.
// When `cur` is ABSENT — the row was just deleted locally — the condition
// short-circuits false and a REORDERED OLDER upsert applies unconditionally. The job
// comes back on the board, and `persistJobsDelta` then mirrors it, RESURRECTING THE
// ROW IN THE DATABASE. Latent today because postgres_changes delivers in order; live
// the moment Increment 2's Broadcast lands, because Broadcast is explicitly unordered
// and publishes DELETE with a row_version.
//
// The fix needs a floor for ids we no longer hold. That is what this remembers.
//
// ── WHERE THIS MUST NOT LIVE, AND WHY ─────────────────────────────────────────
//
// NOT in reducer state. `toSharedBlob` spreads `{ ...state }` and strips only
// `currentUserId` plus the registered table-owned slices, so a `state.jobTombstones`
// key would be serialized INTO the org_state blob. Every delete would then make the
// blob differ, defeating the flush content-guard skip, forcing a version-bumping
// UPDATE and an org_state_signal fan-out PER DELETE — 4,935 of them on the largest
// account delete, against a realtime meter that has already been at 191%.
//
// NOT a return value of applyJobPatch either: the reducer discards what it returns
// when `changed === false`, which is exactly the case a tombstone for an absent id
// has to record. And recording one must never flip `changed` to true, or a duplicate
// delete re-renders every jobs consumer and dirties the save path.
//
// So: a module-level singleton, dependency-free, never serialized, never persisted.
//
// ── WHY VERSION-KEYED RATHER THAN UNCONDITIONAL ───────────────────────────────
// Job ids are random and never reused, so an unconditional "once deleted, always
// ignore" would be safe against RE-CREATION. It is not safe against RESURRECTION: a
// stale peer tab can re-POST the deleted job in `changed[]` (manager tabs bypass the
// server-side sanitizer entirely), and the row genuinely comes back with a fresh
// row_version. An unconditional tombstone would leave this tab hiding a row the
// database holds — a local-absent/DB-present divergence that feeds the TOP_UP
// unique-index wedge. Version-keying with clear-on-strictly-newer makes the tab
// converge on the database instead.

const TTL_MS = 10 * 60 * 1000;   // ~10 poll cycles of reorder slack
const MAX_IDS = 20000;           // ~4x the largest single real gesture (4,935 rows)
const MAX_OCC = 50000;

const rv = new Map();   // jobId -> { rv, at }
const occ = new Map();  // `${seriesId}|${startAt}` -> at

const now = () => Date.now();

function prune(map, cap) {
  if (map.size <= cap) return;
  // Map preserves insertion order and every write re-inserts, so the oldest entries
  // are simply the first. Drop to 90% so this runs rarely rather than per insert.
  const excess = map.size - Math.floor(cap * 0.9);
  let n = 0;
  for (const k of map.keys()) { map.delete(k); if ((n += 1) >= excess) break; }
}

const occKey = (job) => (job && job.seriesId && job.startAt ? `${job.seriesId}|${job.startAt}` : null);

// Record that `id` was deleted at version `version`. `job` is the row as we last held
// it, used only to remember its recurrence slot.
export function record(id, version = 0, job = null) {
  if (!id) return;
  rv.delete(id);
  rv.set(id, { rv: Number(version) || 0, at: now() });
  prune(rv, MAX_IDS);
  noteOcc(job);
}

// The recurrence slot a deleted occurrence vacated. TOP_UP derives its next tail from
// IN-MEMORY jobs, so without this it re-mints into the slot the row still occupies in
// the database's partial unique index — a 23505 that surfaces as a permanently
// re-sending delta behind an "offline" badge.
export function noteOcc(job) {
  const k = occKey(job);
  if (!k) return;
  occ.delete(k);
  occ.set(k, now());
  prune(occ, MAX_OCC);
}

// The remembered delete version for `id`, or undefined. Expired entries are dropped
// lazily on read — no timer, nothing to clean up on unmount.
export function get(id) {
  const e = rv.get(id);
  if (!e) return undefined;
  if (now() - e.at > TTL_MS) { rv.delete(id); return undefined; }
  return e.rv;
}

// The id is genuinely alive again (a strictly newer upsert landed).
export function clear(id) { rv.delete(id); }

export function hasOcc(seriesId, startAt) {
  const k = seriesId && startAt ? `${seriesId}|${startAt}` : null;
  return k ? occ.has(k) : false;
}

// Test-only.
export function __reset() { rv.clear(); occ.clear(); }
export function __size() { return { ids: rv.size, occ: occ.size }; }

export default { record, noteOcc, get, clear, hasOcc };
