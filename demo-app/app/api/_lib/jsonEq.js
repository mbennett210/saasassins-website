// Key-order-insensitive deep equality for JSON values (the parsed kind: null,
// boolean, number, string, array, plain object). Dependency-free and pure so it
// is unit-testable under plain node (scripts/test-jobs-baseline-advance.mjs).
//
// WHY NOT JSON.stringify COMPARISON: Postgres jsonb does not preserve key order
// (it stores keys in its own physical order and returns them that way), so a
// payload that round-trips through the `data` column can come back with the same
// content but a different key sequence. Stringify-comparing that against the
// client's original object reads as "different" and would defeat the
// data-equality guard in writeJobsDelta — re-introducing the no-op UPDATE churn
// (row_version bump + 8 index rewrites + a per-row realtime fan-out per row)
// that guard exists to stop.
//
// Inputs are values that crossed JSON serialization (request bodies, jsonb
// reads), so undefined / NaN / Infinity / Date / functions cannot appear; if a
// caller ever passes them anyway, mismatching types simply compare unequal.
export function jsonEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false; // one null, other not (=== caught both-null)
  if (typeof a !== 'object' || typeof b !== 'object') return false; // differing primitives
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!jsonEq(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonEq(a[k], b[k])) return false;
  }
  return true;
}
