// Shared size/age bounds for the append-only event-log arrays that live in the
// single shared org_state blob (SCALE-C21/C22). Keeping these arrays from growing
// forever is what stops every full-blob write/refetch from getting heavier with age
// — the blob-obesity half of the realtime-overage work.
//
// Node-ESM-safe + browser-dependency-free (imported server-side via notifications.js /
// the reducer chain) — no DOM, no framework, explicit .js imports only.
//
// Ordering invariant: the C21 arrays (keyEvents, contactActivities, clientActivities,
// marketingSends, marketingReplies) all APPEND newest-LAST, so the tail is the newest —
// `capTail` keeps the newest N. (Notifications are the exception: `capInsert` in
// notifications.js prepends newest-FIRST and keeps the head, so it uses only pruneByAge
// here, not capTail.) `pruneByAge` is order-agnostic (a filter), so it serves both.

export const DAY_MS = 86400000;

// Keep the newest `limit` items of an append-newest-last array. Returns the SAME
// reference when already within bound (so a ref-equality gate upstream can skip work).
export function capTail(list, limit) {
  if (!Array.isArray(list) || list.length <= limit) return list;
  return list.slice(list.length - limit);
}

// Ceiling that NEVER drops a "protected" row. A row is protected when its `refKey`
// value is in `protectedIds`. Drops the OLDEST unprotected rows (append newest-last →
// front is oldest) by object identity, just enough to fit `limit`. The ceiling is SOFT:
// if protected rows alone exceed `limit`, they are all kept and the list stays over.
// Used for marketingSends — a send whose enrollment is still active must never be
// dropped (hasSent() would go false and re-fire the step → CAN-SPAM). Same ref when
// nothing is dropped.
export function capTailProtected(list, limit, protectedIds, refKey) {
  if (!Array.isArray(list) || list.length <= limit) return list;
  const dead = list.filter((r) => !protectedIds.has(r && r[refKey]));
  const room = Math.max(0, limit - (list.length - dead.length)); // slots left after keeping every protected row
  if (dead.length <= room) return list;
  const drop = new Set(dead.slice(0, dead.length - room)); // oldest dead first, by identity
  return list.filter((r) => !drop.has(r));
}

// Drop rows older than maxAgeMs, judged by the first present + parseable key in
// `tsKeys`. A row whose timestamp is absent or unparseable (NaN) is KEPT — we never
// guess a malformed/legacy row is expired and silently drop it. `keepIf(row)` force-
// keeps a row regardless of age (e.g. an unread notification). Returns the SAME
// reference when nothing was dropped.
export function pruneByAge(list, maxAgeMs, nowMs, tsKeys, keepIf) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const cutoff = nowMs - maxAgeMs;
  let dropped = false;
  const out = list.filter((row) => {
    if (keepIf && keepIf(row)) return true;
    let t = NaN;
    for (const k of tsKeys) {
      const v = row && row[k];
      if (v != null) { t = new Date(v).getTime(); if (!Number.isNaN(t)) break; }
    }
    if (Number.isNaN(t)) return true; // undated / malformed → keep, never drop on a guess
    const keep = t >= cutoff;
    if (!keep) dropped = true;
    return keep;
  });
  return dropped ? out : list;
}
