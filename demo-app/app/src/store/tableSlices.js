// Explicit .js: this module is imported by the plain-node test suite as well as by
// Vite, and node's ESM resolver needs the extension (Vite doesn't).
import { canonicalJson } from '../lib/canonicalJson.js';

// The slice registry — the single source of truth for "which state slices live in
// their own Postgres table instead of the org_state blob".
//
// WHY THIS EXISTS: that fact used to be hardcoded as the literal string 'jobs' in
// five separate places in sync.js (serializeShared, the flush strip, adoptRemote's
// keep-injection, boot hydration, and the content-guard's skip-and-mirror set).
// Every future extraction (notifications, messages, activities, keys, marketing,
// invoices, clients/contacts/sites) had to find and update all five, and MISSING ONE
// IS SILENT: forget the content-guard entry and a slice-only edit skips the blob
// write without mirroring — the edit is simply lost. Registering a slice here drives
// all of them at once. See REMEDIATION_PLAN.md §2.3 / Increment 0.3.
//
// TWO PHASES, INDEPENDENTLY GATED — this distinction is the whole safety model:
//
//   'mirror'   → the table is dual-written and the client reads from it, but the
//                blob STILL carries the slice. Safe to deploy immediately: a tab
//                running older code keeps reading the blob copy and is unaffected.
//
//   'stripped' → flush() empties the slice from the blob before writing. This is the
//                POINT OF NO RETURN and must not happen until the fleet-reload gate
//                confirms zero pre-fix writers (see minClientBuild / GATE-BEFORE-PRUNE).
//
// REGISTERING A SLICE MUST NEVER, BY ITSELF, STRIP IT. Turning the mirror on and
// emptying the blob are two separate, separately-gated flips. Ship a new slice at
// 'mirror', soak it, and only then promote it to 'stripped'.

export const PHASE = Object.freeze({ MIRROR: 'mirror', STRIPPED: 'stripped' });

// `jobs` is entry #1, pinned at 'stripped' because that is exactly what ships today
// (B1). Its presence here is behaviour-preserving by construction — see
// app/scripts/test-table-slices.mjs, which asserts the registry-driven blob is
// byte-identical to the previous hardcoded-'jobs' transform.
export const TABLE_SLICES = Object.freeze([
  Object.freeze({ key: 'jobs', table: 'jobs', phase: PHASE.STRIPPED }),
]);

// Slices whose blob copy flush() empties before writing. Drives serializeShared +
// the flush strip. ONLY 'stripped' — a 'mirror' slice must stay in the blob.
export function strippedSliceKeys() {
  return TABLE_SLICES.filter((s) => s.phase === PHASE.STRIPPED).map((s) => s.key);
}

// Slices the client owns from a table rather than the blob, in BOTH phases. Drives
// adoptRemote's keep-injection (never let an adopted blob overwrite a table-sourced
// array) and the content-guard's skip-and-mirror set (a slice-only edit leaves the
// blob byte-identical, so the guard must still fire that slice's per-row mirror).
export function tableOwnedSliceKeys() {
  return TABLE_SLICES.map((s) => s.key);
}

// Is this slice currently emptied from the blob on write?
export function isStripped(key) {
  const s = TABLE_SLICES.find((e) => e.key === key);
  return !!s && s.phase === PHASE.STRIPPED;
}

// Canonical serialization of the shared blob: strip the per-session currentUserId and
// empty every STRIPPED slice. This is the one transform both serializeShared() and
// flush() must apply — they are a contract, and drift between them silently disables
// the content guard (every flush becomes a version-bumping write + a fan-out to every
// connected client). Keeping the transform HERE is what makes them impossible to drift.
// `freeze` is the server-controlled org_state.freeze_strip list: slice keys that must
// NOT be emptied even at phase 'stripped'. Setting it halts re-pruning FLEET-WIDE
// without a deploy — the thing that makes a reverse-materialization executable at all,
// because otherwise the next flush from any upgraded tab immediately re-strips the
// slice you just restored. Both callers (serializeShared + flush) MUST pass the same
// value or the content-guard baseline drifts.
export function toSharedBlob(state, freeze) {
  if (!state || typeof state !== 'object') return null;
  const frozen = Array.isArray(freeze) ? freeze : [];
  const shared = { ...state };
  delete shared.currentUserId;
  delete shared.__auth; // transient per-session claim (sync.js withSession) — never shared
  delete shared.viewAsUserId; // transient owner "view as" perspective — never shared
  for (const key of strippedSliceKeys()) {
    if (frozen.includes(key)) continue; // frozen → leave the blob copy intact
    shared[key] = [];
  }
  return shared;
}

// The serialized form used for the content-guard comparison. canonicalJson (sorted
// keys at every level), NOT JSON.stringify: the baseline is built from an ADOPTED
// jsonb copy (keys re-sorted by Postgres) and flush()'s snapshot from the live
// state (insertion order). Equal content must serialize identically on both sides
// or the guard never matches and every flush is a version-bumping no-op write
// (2026-09-02 two-tab ping-pong). flush() uses the same helper — keep it so.
export function serializeSharedBlob(state, freeze) {
  const shared = toSharedBlob(state, freeze);
  return shared === null ? null : canonicalJson(shared);
}
