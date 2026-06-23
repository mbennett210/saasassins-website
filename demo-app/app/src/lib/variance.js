// The labor-variance engine — the headline Swept-replacement differentiator.
//
// Swept gets MULTI-CLEANER cleans wrong; we don't. The contract: ONE time-entry
// row per cleaner per clean. For a clean (a job worked by 1..N cleaners):
//   - labor   = Σ each cleaner's own durationMinutes  (2 cleaners × 2h = 240 labor-min)
//   - elapsed = max(clockOut) − min(clockIn)          (the wall-clock the site was open)
// `basis` (from opsSettings) picks which one variance compares to expected:
// 'labor' (default — a labor-cost-driven op thinks in labor-minutes) | 'wallclock'.
//
// PURE. No React / store / browser deps — ported from the Rainier client build
// (lib/variance.js) verbatim, so the report flags identically everywhere.

export const DEFAULT_THRESHOLDS = { overMins: 15, underMins: 15 };

const fin = (n) => (Number.isFinite(n) ? n : 0);

// Σ of each cleaner's own clocked minutes — the multi-cleaner-correct actual.
export function laborMinutes(entries) {
  return (entries || []).reduce((sum, e) => sum + fin(e.durationMinutes), 0);
}

// Wall-clock span the site was occupied: max(out) − min(in) across all cleaners.
// null until at least one in AND one out exist.
export function elapsedMinutes(entries) {
  const ins = [];
  const outs = [];
  for (const e of entries || []) {
    const i = e.clockInAt ? new Date(e.clockInAt).getTime() : NaN;
    const o = e.clockOutAt ? new Date(e.clockOutAt).getTime() : NaN;
    if (Number.isFinite(i)) ins.push(i);
    if (Number.isFinite(o)) outs.push(o);
  }
  if (!ins.length || !outs.length) return null;
  return Math.max(0, Math.round((Math.max(...outs) - Math.min(...ins)) / 60000));
}

// flag: 'over' | 'under' | 'on_target' | 'no_baseline' | 'incomplete'
export function varianceFlag(variance, hasBaseline, thresholds = DEFAULT_THRESHOLDS) {
  if (!hasBaseline) return 'no_baseline';
  if (variance == null) return 'incomplete';
  if (variance > fin(thresholds.overMins)) return 'over';
  if (variance < -fin(thresholds.underMins)) return 'under';
  return 'on_target';
}

// Per-cleaner split — each cleaner credited their OWN minutes. The shares sum back
// to the labor total exactly, so a multi-cleaner clean is never double-counted
// (the explicit Swept fix). Sorted longest-first.
export function byCleanerSplit(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const cur = map.get(e.userId) || {
      userId: e.userId, userName: e.userName || '—', durationMinutes: 0,
      entryCount: 0, anyOpen: false, geofenceResult: e.geofenceResult || null, distanceM: e.distanceM ?? null,
    };
    cur.durationMinutes += fin(e.durationMinutes);
    cur.entryCount += 1;
    if (!e.clockOutAt) cur.anyOpen = true;
    map.set(e.userId, cur);
  }
  return [...map.values()].sort((a, b) => b.durationMinutes - a.durationMinutes);
}

// One clean's variance. entries = all rows sharing a job. expectedMins is the
// resolved baseline. Returns null variance (NOT 0) when there's no baseline or
// the clean is still in progress, so the UI shows 'No baseline' / 'In progress'
// rather than a false flag.
export function computeCleanVariance(entries, { expectedMins, basis = 'labor', thresholds = DEFAULT_THRESHOLDS } = {}) {
  const list = entries || [];
  const labor = laborMinutes(list);
  const elapsed = elapsedMinutes(list);
  const hasBaseline = typeof expectedMins === 'number' && expectedMins > 0;
  const anyOpen = list.some((e) => !e.clockOutAt);
  const actual = basis === 'wallclock' ? elapsed : labor;
  const variance = (hasBaseline && !anyOpen && actual != null) ? actual - expectedMins : null;
  return {
    laborMinutes: labor,
    elapsedMinutes: elapsed,
    actualMinutes: anyOpen ? null : actual,
    expectedMinutes: hasBaseline ? expectedMins : null,
    variance,
    hasBaseline,
    anyOpen,
    basis,
    flag: anyOpen ? 'incomplete' : varianceFlag(variance, hasBaseline, thresholds),
    cleanerCount: new Set(list.map((e) => e.userId)).size,
  };
}

// Group a flat entry list into cleans. A clean = all rows sharing a jobId;
// ad-hoc rows (no job) each stand alone.
export function groupEntriesByClean(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const key = e.jobId || `adhoc:${e.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

// Sort comparator for the morning scan: flagged cleans first, then biggest
// absolute deviation, then no-baseline / in-progress last, then by recency.
function reportSort(a, b) {
  const flaggedRank = (r) => (r.flag === 'over' || r.flag === 'under') ? 0 : (r.flag === 'on_target' ? 1 : 2);
  const fr = flaggedRank(a) - flaggedRank(b);
  if (fr !== 0) return fr;
  const av = a.variance == null ? -1 : Math.abs(a.variance);
  const bv = b.variance == null ? -1 : Math.abs(b.variance);
  if (bv !== av) return bv - av;
  return String(b.scheduledStart || '').localeCompare(String(a.scheduledStart || ''));
}

// Build the full report (rows + summary) from a flat entry list. Each entry carries
// the denormalized job/site/client/user names + expectedMinutesSnapshot captured
// at clock-in (point-in-time truth).
export function buildVarianceReport(entries, { basis = 'labor', thresholds = DEFAULT_THRESHOLDS } = {}) {
  const cleans = groupEntriesByClean(entries || []);
  const rows = [];
  for (const [key, group] of cleans) {
    const head = group[0];
    const expectedMins = group.find((e) => Number.isFinite(e.expectedMinutesSnapshot))?.expectedMinutesSnapshot ?? null;
    const v = computeCleanVariance(group, { expectedMins, basis, thresholds });
    rows.push({
      key,
      jobId: head.jobId || null,
      siteId: head.siteId || null,
      clientId: head.clientId || null,
      siteName: head.siteName || '—',
      clientName: head.clientName || '—',
      scheduledStart: head.scheduledStart || null,
      cleaners: byCleanerSplit(group),
      entries: group.map((e) => ({
        id: e.id,
        userId: e.userId,
        userName: e.userName || '—',
        durationMinutes: e.durationMinutes ?? null,
        clockInAt: e.clockInAt || null,
        clockOutAt: e.clockOutAt || null,
        approvalStatus: e.approvalStatus || 'pending',
        geofenceResult: e.geofenceResult || null,
        distanceM: e.distanceM ?? null,
      })),
      ...v,
    });
  }
  rows.sort(reportSort);
  const withBaseline = rows.filter((r) => r.hasBaseline && r.variance != null);
  const summary = {
    cleanCount: rows.length,
    flaggedCount: rows.filter((r) => r.flag === 'over' || r.flag === 'under').length,
    overCount: rows.filter((r) => r.flag === 'over').length,
    underCount: rows.filter((r) => r.flag === 'under').length,
    noBaselineCount: rows.filter((r) => r.flag === 'no_baseline').length,
    inProgressCount: rows.filter((r) => r.flag === 'incomplete').length,
    totalLaborMinutes: rows.reduce((s, r) => s + fin(r.laborMinutes), 0),
    avgVarianceMins: withBaseline.length
      ? Math.round(withBaseline.reduce((s, r) => s + r.variance, 0) / withBaseline.length)
      : null,
  };
  return { rows, summary };
}

// Map a flag to a Badge color variant. over = red (paying for unbudgeted labor),
// under = amber (left early / quality risk), on_target = green, no_baseline =
// slate, incomplete = blue.
export function flagBadgeVariant(flag) {
  switch (flag) {
    case 'over': return 'red';
    case 'under': return 'amber';
    case 'on_target': return 'green';
    case 'incomplete': return 'blue';
    default: return 'slate';
  }
}

export function flagLabel(flag) {
  switch (flag) {
    case 'over': return 'Over';
    case 'under': return 'Under';
    case 'on_target': return 'On target';
    case 'incomplete': return 'In progress';
    default: return 'No baseline';
  }
}

// Minutes → "1h 45m" / "45m" display.
export function fmtMins(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const min = abs % 60;
  return `${sign}${h ? `${h}h ` : ''}${min}m`;
}
