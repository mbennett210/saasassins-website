// Scope for "this & all future" series operations.
//
// Sept 2 (CleanSpace): an office desktop opened TONIGHT's occurrence at 22:23, chose
// "this & future", and the app hard-deleted the clean that had started at 20:00 —
// the tombstone reached the crew's phones within a minute and their in-progress
// clean vanished from My Day ("NW Dental disappeared from Linda's cleans"). The
// reducers scope series ops by `startAt >= fromDate`, and every dispatch site
// passed the opened occurrence's OWN startAt, so an occurrence that had already
// started was always in range. A started clean has people on site and (usually)
// punches on it; a series edit must never reach it — it is edited or cancelled on
// its own.
//
// Dispatch-time, not reducer-time: reducers must stay replay-idempotent
// (adoptRemote re-runs recorded actions), so the wall clock is read HERE and the
// action carries the concrete fromDate. Dependency-free so it unit-tests headless.
export function seriesFromDate(job, nowIso = new Date().toISOString()) {
  const startAt = job?.startAt || '';
  const t = startAt ? new Date(startAt).getTime() : NaN;
  const started = Number.isFinite(t) && t <= new Date(nowIso).getTime();
  return { fromDate: started ? nowIso : startAt, started };
}

export const STARTED_SERIES_NOTE = 'This clean already started, so it was left as-is — the change applies from the next occurrence. Edit or cancel tonight’s clean on its own.';
export const STARTED_SERIES_MOVE_BLOCK = 'This clean already started, so it can’t move with the series. Open the next occurrence to move the future ones, or edit tonight’s on its own.';
