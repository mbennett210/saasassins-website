// Client adapter for the Variance report. Real backend (POST /api/variance/report)
// when Supabase is configured; in local/demo mode it runs the SAME pure engine
// (src/lib/variance.js → buildVarianceReport) over the timeApi stub's localStorage
// rows, so the demo report and the production report are computed identically.
//
// The report is a component-local projection (useState), never the synced blob.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import { buildVarianceReport, DEFAULT_THRESHOLDS } from './variance';
import { _stubEntries } from './timeApi';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js (Sept 1 incident)
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isVarianceStub() { return !BACKEND; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// snake_case DB / stub row -> the neutral entry shape lib/variance.js expects.
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
    // Twin of api/_lib/variance/compute.js mapRow — see the note there. Both dropped
    // `note`, so BOTH the deployed path and the local/demo path hid the reason a
    // payroll row was flagged from the manager reviewing it.
    note: r.note,
  };
}

// report({ fromIso, toIso, filters }). `config` (basis + thresholds from opsSettings)
// is used ONLY by the stub; the real backend reads opsSettings server-side.
export async function report({ fromIso, toIso, filters = {}, config } = {}) {
  if (BACKEND) {
    return api('/variance/report', { method: 'POST', body: { fromIso, toIso, filters } });
  }
  const all = _stubEntries() || [];
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  let entries = all.filter((e) => {
    const t = new Date(e.clock_in_at).getTime();
    return Number.isFinite(t) && t >= from && t <= to;
  });
  if (filters.siteIds?.length) entries = entries.filter((e) => filters.siteIds.includes(e.site_id));
  if (filters.clientIds?.length) entries = entries.filter((e) => filters.clientIds.includes(e.client_id));
  if (filters.userIds?.length) entries = entries.filter((e) => filters.userIds.includes(e.user_id));

  const basis = config?.basis === 'wallclock' ? 'wallclock' : 'labor';
  const thresholds = config?.thresholds || DEFAULT_THRESHOLDS;
  const { rows, summary } = buildVarianceReport(entries.map(mapRow), { basis, thresholds });
  const finalRows = filters.flaggedOnly ? rows.filter((r) => r.flag === 'over' || r.flag === 'under') : rows;
  return { rows: finalRows, summary, basis, threshold: thresholds, truncated: false };
}
