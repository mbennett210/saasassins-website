// Pure, dependency-free decision helpers for the demo-sandbox bootstrap. The
// component that touches localStorage and builds the real seed data lives in
// lib/demoBootstrap.js; the logic that decides WHEN the seeded time-ledger has
// gone stale and WHICH stub keys are missing lives here so it stays unit-testable
// headlessly (the same split as reminderScheduler.js vs ReminderScheduler.jsx).
// Node-ESM-safe: no imports, no browser globals.

// A seeded time-ledger's demo story rows are dated to first load and never move on
// their own. Payroll reads a FIXED biweekly pay-period window and Variance reads
// rolling day windows, so once the newest story row is older than this the current
// pay period shows 0 hours ($0.00 payroll) and "last night" variance goes empty.
// 3 days comfortably exceeds the age of the freshest story rows (day 0 open punch +
// day -1 "last night"), so a same-session reload never triggers a rebuild.
export const DEMO_LEDGER_STALE_MS = 3 * 24 * 60 * 60 * 1000;

// The seeded demo story rows all carry synthetic `te_demo_*` ids (data/demoTimeLedger).
// A punch the client created while exploring the sandbox carries a different id, so
// this predicate is what lets a rebuild replace the story while preserving their work.
const isStoryRow = (e) => !!e && typeof e.id === 'string' && e.id.startsWith('te_demo_');

// Decide the next time-ledger entry list. `currentEntries` is the parsed
// `{ entries }.entries` from the stub (may be null/undefined); `freshStory` is a
// newly-built demo story (te_demo_* rows dated near now). Returns
// { changed, entries }: when the ledger is empty or its newest story row is older
// than `staleMs`, the story is replaced with `freshStory` and any client-created
// punch (non te_demo_* id) is kept; otherwise the input is returned unchanged so a
// within-session reload preserves the client's approvals/clock-ins. `now`/`staleMs`
// are injected so the clock is controllable (and the unit test is deterministic).
export function refreshLedgerEntries(currentEntries, freshStory, now = Date.now(), staleMs = DEMO_LEDGER_STALE_MS) {
  const entries = Array.isArray(currentEntries) ? currentEntries : [];
  const clientRows = entries.filter((e) => !isStoryRow(e));
  const storyRows = entries.filter(isStoryRow);
  const newest = storyRows.reduce((max, e) => {
    const t = new Date(e && e.clock_in_at).getTime();
    return Number.isFinite(t) && t > max ? t : max;
  }, 0);
  const stale = storyRows.length === 0 || (now - newest) > staleMs;
  if (!stale) return { changed: false, entries };
  return { changed: true, entries: [...(Array.isArray(freshStory) ? freshStory : []), ...clientRows] };
}

// Of `allKeys`, return those a store does NOT already have. `has(key)` is injected
// (`localStorage.getItem(key) != null` in the app; a Set lookup in the test) so the
// backfill only writes stubs an older seed never wrote and never clobbers a present
// one (which may hold the client's own QC edits).
export function missingStubKeys(allKeys, has) {
  const list = Array.isArray(allKeys) ? allKeys : [];
  return list.filter((k) => !has(k));
}
