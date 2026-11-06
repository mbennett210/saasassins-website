// THE JOBS WINDOW (CS-676, CS-677): which cleans the app holds without being asked.
//
// public.jobs grows by every clean ever done (~16,000 a month at Matt's book, nothing pruned),
// so nothing may read all of it on a launch. The app loads the cleans that START inside this
// window — 45 days back (the Dashboard's month, the recent history a manager scrolls) and 100
// days ahead (past the 90-day materialised horizon, lib/recurrence HORIZON_DAYS) — and fetches
// anything else when a screen needs it: a past week on the Schedule, a series being edited
// (src/store/sync.js ensureJobsRange / ensureSeries). The server reads a cleaner's own cleans
// over the SAME window (api/_lib/jobsTable getCrewJobRows), so what a cleaner's phone shows
// and what the server scopes them to cannot disagree.
//
// Pure and import-free: the browser, the API routes and the node suites share it.
export const JOBS_WINDOW_BACK_DAYS = 45;
export const JOBS_WINDOW_FORWARD_DAYS = 100;

const DAY_MS = 86400000;

// → { fromMs, toMs, fromIso, toIso }, half-open: a clean belongs when fromMs <= start < toMs.
export function jobsWindowBounds(now = Date.now()) {
  const fromMs = now - JOBS_WINDOW_BACK_DAYS * DAY_MS;
  const toMs = now + JOBS_WINDOW_FORWARD_DAYS * DAY_MS;
  return { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}
