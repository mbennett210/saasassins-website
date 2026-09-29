// Server side of the Drive-time report. Pulls the windowed time_entries, maps them
// to the neutral shape, then delegates ALL derivation + flag math to the shared
// pure module src/lib/driveTime.js — the SAME module the client imports — so a
// server-rendered flag and a demo-mode flag can never disagree. Config comes from
// opsSettings in the blob (one read). Mirrors variance/compute.js.
//
// ⚠️ TWO deliberate departures from the variance report — do NOT "fix" them back:
//
// 1. **Filters are applied AFTER derivation, never in the query.** Drive legs are
//    derived from CONSECUTIVE entries, so removing a middle entry at query time
//    (site/client filter) lets its neighbours pair across it and fabricates a
//    "drive" that actually contains a whole clean. Only userIds — which partitions
//    the derivation rather than punching holes in it — is safe to push down.
//
// 2. **The query window is padded backwards by the gap cap.** A leg that starts
//    just before fromIso and lands inside the window is real paid travel; without
//    the pad its opening entry is invisible and the leg silently disappears.
import { readOrgState } from '../orgState.js';
import { listForReport, listForReportAll, DRIVE_COLUMNS } from './store.js';
import { resolveDriveEstimates } from './driveEstimates.js';
import { listOverridesForEntries } from './driveOverrides.js';
import {
  deriveDriveSegments, applyDriveOverrides, applyDriveEstimates, buildDriveReport,
  collectSitePairs, DEFAULT_DRIVE_MAX_GAP_MINS, DEFAULT_DRIVE_FLAG_PCT, DEFAULT_DRIVE_GRACE_MINS,
  payrollLegFetchWindow, legsDepartingIn,
} from '../../../src/lib/driveTime.js';

const REPORT_CAP = 2000;

function mapRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    siteId: r.site_id,
    siteName: r.site_name,
    clientId: r.client_id,
    clientName: r.client_name,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
    status: r.status,
    approvalStatus: r.approval_status,
  };
}

// Gap cap + flag threshold from opsSettings (default-safe).
export async function driveConfig(state) {
  const s = state || (await readOrgState()).state;
  const ops = s?.opsSettings || {};
  return {
    maxGapMins: Number.isFinite(ops.driveMaxGapMins) ? ops.driveMaxGapMins : DEFAULT_DRIVE_MAX_GAP_MINS,
    flagPct: Number.isFinite(ops.driveVarianceFlagPct) ? ops.driveVarianceFlagPct : DEFAULT_DRIVE_FLAG_PCT,
    graceMins: Number.isFinite(ops.driveVarianceGraceMins) ? ops.driveVarianceGraceMins : DEFAULT_DRIVE_GRACE_MINS,
  };
}

export function siteMapFrom(state) {
  const map = new Map();
  for (const s of Array.isArray(state?.sites) ? state.sites : []) map.set(s.id, s);
  return map;
}

// window = { fromIso, toIso }; filters = { siteIds, clientIds, userIds, flaggedOnly }.
// skipEstimates=true is the payroll path: it needs paid minutes, not the Google
// comparison, and must never trigger a billable fetch from an export click.
//
// payroll=true (implies skipEstimates) is the pay run's + the Hours report's + the OT
// watch's read. It must see EVERY punch that can bound a leg in its window — the capped
// newest-N scan the drive-time screen uses would silently drop legs from a semi-monthly
// run at full volume, and the paid minutes with them. It keeps the legs that DEPART in
// the window and returns COMPACT rows (just what payability + the weekly 40h line need).
// One call covers at most PAYROLL_MAX_DAYS: the client (lib/driveApi) splits longer
// windows into week-sized calls so no single response nears the 4.5 MB function limit.
// `truncated` is always false on this path.
export const PAYROLL_MAX_DAYS = 35;
export const PAYROLL_SEGMENT_FIELDS = [
  'key', 'userId', 'userName', 'startAt', 'endAt', 'actualMinutes', 'paidMinutes',
  'fromStatus', 'toStatus', 'fromApprovalStatus', 'toApprovalStatus',
  'fromClientId', 'toClientId', 'fromSiteId', 'toSiteId',
];
const compactSegment = (s) => {
  const out = {};
  for (const k of PAYROLL_SEGMENT_FIELDS) if (s[k] !== undefined) out[k] = s[k];
  return out;
};

export async function runDriveReport({ fromIso, toIso, filters = {}, skipEstimates = false, payroll = false } = {}) {
  const { state } = await readOrgState();
  const config = await driveConfig(state);
  if (payroll) skipEstimates = true;

  let raw;
  if (payroll) {
    // PAYROLL: every punch that can bound a leg DEPARTING inside the window (back to the
    // departing clean's clock-in, forward by the gap cap), then only those legs are kept
    // (lib/driveTime.payrollLegFetchWindow / legsDepartingIn — the rule payroll.js buckets
    // by). Contiguous windows therefore pay each leg exactly once.
    const fetchWin = payrollLegFetchWindow({ fromIso, toIso, maxGapMins: config.maxGapMins });
    raw = await listForReportAll({ ...fetchWin, userIds: filters.userIds }, { columns: DRIVE_COLUMNS });
  } else {
    // The drive-time SCREEN: pad the lower bound so a leg straddling the window start
    // still has its opening entry; legs are trimmed back to the window after derivation.
    const paddedFrom = fromIso
      ? new Date(new Date(fromIso).getTime() - config.maxGapMins * 60000).toISOString()
      : null;
    raw = await listForReport({
      fromIso: paddedFrom,
      toIso,
      userIds: filters.userIds,   // safe to push down — it partitions the derivation
      limit: REPORT_CAP,
    });
  }
  const entries = raw.map(mapRow);

  let segments = deriveDriveSegments(entries, { maxGapMins: config.maxGapMins });
  if (payroll) {
    segments = legsDepartingIn(segments, { fromIso, toIso });
  } else if (fromIso) {
    // Trim the pad: keep only legs that ARRIVE inside the requested window.
    const from = new Date(fromIso).getTime();
    segments = segments.filter((s) => new Date(s.endAt).getTime() >= from);
  }

  // A manager's paid-minutes ruling changes what a leg PAYS, so on the payroll path a
  // failed override read must fail the run (the client shows the error) rather than
  // quietly pay the unadjusted minutes. The drive-time screen stays fail-soft.
  let overrides = [];
  try { overrides = await listOverridesForEntries(segments.map((s) => s.fromEntryId)); }
  catch (e) {
    if (payroll) throw e;
    console.error('[drive/report] override read failed', e?.message || e);
  }
  segments = applyDriveOverrides(segments, overrides);

  let lookup = null;
  let estimatesPending = 0;
  if (!skipEstimates) {
    try {
      const res = await resolveDriveEstimates(collectSitePairs(segments), siteMapFrom(state));
      lookup = res.lookup;
      estimatesPending = res.pending;
    } catch (e) {
      // Fail soft: the legs and their paid minutes are still correct, they just
      // render as 'No estimate' rather than blocking the whole report.
      console.error('[drive/report] estimate resolution failed', e?.message || e);
    }
  }
  segments = applyDriveEstimates(segments, lookup, { flagPct: config.flagPct, graceMins: config.graceMins });

  // Post-derivation filters (see the header note).
  if (filters.siteIds?.length) {
    const want = new Set(filters.siteIds);
    segments = segments.filter((s) => want.has(s.fromSiteId) || want.has(s.toSiteId));
  }
  if (filters.clientIds?.length) {
    const want = new Set(filters.clientIds);
    segments = segments.filter((s) => want.has(s.fromClientId) || want.has(s.toClientId));
  }
  if (filters.flaggedOnly) segments = segments.filter((s) => s.flag === 'over');

  const { rows, summary } = buildDriveReport(segments);
  if (payroll) {
    return { rows: rows.map(compactSegment), summary, config, estimatesPending: 0, truncated: false };
  }
  return {
    rows,
    summary,
    config,
    estimatesPending,
    truncated: raw.length >= REPORT_CAP, // surfaced so the UI never implies full coverage on a capped scan
  };
}
