// localStorage keys for the DEMO/local stubs — ONE declaration per key, imported by BOTH
// halves: the seed builder (data/demoStubs.js) and the adapter that reads and writes the
// rows (lib/qcApi.js). No imports of its own, so either side can read it for free.
//
// WHY IT IS ITS OWN FILE. `lib/demoBootstrap.js` writes a stub only when its key is
// ABSENT (a present stub may hold the client's own edits), so a key is also the stub's
// SCHEMA VERSION: change a row's shape without moving the key and every browser that was
// already seeded keeps the old rows for ever. The checklist key was duplicated as a
// literal in both files, which is exactly how that could happen unnoticed — CS-403 moved
// the checklist row's completer from a name to `completed_by_user_id`, and an unbumped key
// would have left an existing demo browser showing "—" in the Quality hub and "Not
// started" for a cleaner's own earlier completion.
//
// 🔴 BUMP THE VERSION whenever a stub's ROW SHAPE changes, and list the old key in
// RETIRED_STUB_KEYS so the stale rows are cleared instead of lingering.

// v2 (2026-09-27, CS-403): checklist rows carry `completed_by_user_id`, not a name.
export const QC_CHECKLISTS_STUB_KEY = 'cleanspace_qc_checklists_stub_v2';

// Keys no build writes any more. demoBootstrap removes them on every load, so a browser
// seeded under an older shape does not carry its rows around for ever.
export const RETIRED_STUB_KEYS = [
  'cleanspace_qc_checklists_stub_v1',
];
