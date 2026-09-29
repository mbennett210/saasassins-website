// Key-order-independent JSON serialization for the org_state content guard.
//
// org_state.state is jsonb, and jsonb re-sorts object keys at every level. A live
// state whose keys merely sit in a different ORDER than the adopted copy (a spread
// like `{ ...job, ...patch }` re-orders them) is byte-different to JSON.stringify
// but identical to Postgres. So the guard fired, wrote a no-op, bumped `version`
// and signalled every client — and the tab that adopted THAT write did the same
// straight back: the 2026-09-02 two-tab ping-pong, one no-op blob write every
// ~32 s all night, each one re-running the jobs delete-diff and keeping the CAS
// conflict window permanently open. Sorting keys makes equal content serialize
// equally no matter how it was built. Arrays keep their order (it is meaningful).
// Dependency-free so it unit-tests headless.
//
// The copy has NO prototype, so a key literally named "__proto__" (JSON.parse makes it an
// own key, and jsonb keeps it) is copied like any other: on a plain `{}` the assignment set
// the copy's prototype instead, so the key vanished from the body while the server and the
// database kept it, and every save that reached the field guard read as changing it
// (a false 403 that dropped the batch). 2026-09-23.
export function canonicalJson(value) {
  return JSON.stringify(value, (key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = Object.create(null);
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
}
