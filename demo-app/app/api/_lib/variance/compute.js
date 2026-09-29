// Server side of the Variance report. Pulls the windowed/filtered time_entries,
// maps DB rows to the neutral entry shape, then delegates ALL flag math to the
// shared pure module src/lib/variance.js — the SAME module the client imports —
// so a server-rendered flag and a client-rendered flag can never disagree (§5.5).
// Basis + thresholds come from opsSettings in the blob (one read).
import { readOrgState } from '../orgState.js';
import { listForReport } from '../time/store.js';
import { buildVarianceReport, DEFAULT_THRESHOLDS } from '../../../src/lib/variance.js';

const REPORT_CAP = 2000;

function mapRow(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    seriesId: r.series_id,
    siteId: r.site_id,
    clientId: r.client_id,
    userId: r.user_id,
    userName: r.user_name,
    siteName: r.site_name,
    clientName: r.client_name,
    scheduledStart: r.scheduled_start,
    durationMinutes: r.duration_minutes,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
    status: r.status,
    expectedMinutesSnapshot: r.expected_minutes_snapshot,
    geofenceResult: r.geofence_result,
    // WHY the ring wasn't checked: the site's switch, the office turning it off for this
    // cleaner, or a crew off-site override. The drill-down labels it (lib/clockRules
    // GEOFENCE_REASON_LABELS); an 'override' badge alone can't tell those apart. Keep in
    // lockstep with the twin mapper.
    overrideReason: r.override_reason ?? null,
    distanceM: r.clock_in_distance_m,
    approvalStatus: r.approval_status,
    editHistory: r.edit_history,
    // 🔴 `note` is where replayPunch records WHY a row was flagged ("[offline] clock-in
    // time asserted … outside the 12h replay window — server-stamped instead; offline
    // geofence re-check: 340m from site"), where manualEntry records the manager's
    // reason, and where prior corrections accumulate. Those rows are stamped
    // approval_status:'pending' precisely so a human reviews them.
    //
    // Omitting it here made buildVarianceReport's `note: e.note || null`
    // (src/lib/variance.js) always null, so the manager reviewing a flagged,
    // payroll-bearing row saw NOTHING about why it was flagged — and because the
    // correction modal round-trips its own prefill back into the patch, saving an
    // unrelated time fix wrote note:'' over the explanation. Keep this in lockstep with
    // the twin mapper in src/lib/varianceApi.js.
    note: r.note,
  };
}

// Resolve the org's basis + flag thresholds from opsSettings (default-safe).
async function reportConfig() {
  const { state } = await readOrgState();
  const ops = state?.opsSettings || {};
  return {
    basis: ops.expectedBasis === 'wallclock' ? 'wallclock' : 'labor',
    thresholds: {
      overMins: Number.isFinite(ops.varianceFlagOverMins) ? ops.varianceFlagOverMins : DEFAULT_THRESHOLDS.overMins,
      underMins: Number.isFinite(ops.varianceFlagUnderMins) ? ops.varianceFlagUnderMins : DEFAULT_THRESHOLDS.underMins,
    },
  };
}

// Run the report. window = { fromIso, toIso }; filters = { siteIds, clientIds, userIds, flaggedOnly }.
// Returns { rows, summary, basis, threshold, truncated }.
export async function runVarianceReport({ fromIso, toIso, filters = {} } = {}) {
  const { basis, thresholds } = await reportConfig();
  const raw = await listForReport({
    fromIso, toIso,
    siteIds: filters.siteIds, clientIds: filters.clientIds, userIds: filters.userIds,
    limit: REPORT_CAP,
  });
  const entries = raw.map(mapRow);
  const { rows, summary } = buildVarianceReport(entries, { basis, thresholds });
  const finalRows = filters.flaggedOnly ? rows.filter((r) => r.flag === 'over' || r.flag === 'under') : rows;
  return {
    rows: finalRows,
    summary,
    basis,
    threshold: thresholds,
    truncated: raw.length >= REPORT_CAP, // surfaced so the UI never implies full coverage on a capped scan
  };
}
