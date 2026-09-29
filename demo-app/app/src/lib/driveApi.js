// Client adapter for the Drive-time report (paid travel between jobs). Real backend
// (POST /api/time/drive-report) when Supabase is configured; in local/demo mode it
// runs the SAME pure engine (src/lib/driveTime.js) over the timeApi stub's
// localStorage rows, so the demo report and the production report derive and flag
// identically. Mirrors varianceApi.js.
//
// In demo mode there is no Google key, so estimates come from the straight-line
// stub (haversine × road factor). Real mode NEVER falls back to that — an
// unroutable pair reports 'No estimate' rather than inventing a baseline.
//
// The report is a component-local projection (useState), never the synced blob.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import {
  runDriveReport, deriveDriveSegments, stubDriveEstimate, driveEstimateKey,
  DEFAULT_DRIVE_MAX_GAP_MINS, DEFAULT_DRIVE_FLAG_PCT, DEFAULT_DRIVE_GRACE_MINS,
  payrollLegFetchWindow, legsDepartingIn,
} from './driveTime';
import { _stubEntries } from './timeApi';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js (Sept 1 incident)
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isDriveStub() { return !BACKEND; }

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

// snake_case stub row -> the neutral entry shape lib/driveTime.js expects.
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

// ── demo-mode override store ─────────────────────────────────────────────────
// Real mode persists manager rulings in drive_segment_overrides; the demo keeps
// them in localStorage so the adjust-paid-minutes flow is fully drivable offline.
const OVERRIDE_KEY = 'cleanspace_drive_overrides_stub_v1';
const loadOverrides = () => { try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY)) || []; } catch { return []; } };
const saveOverrides = (list) => { try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(list)); } catch { /* quota */ } };

// report({ fromIso, toIso, filters, config, sites, skipEstimates }).
// `config` + `sites` are used ONLY by the stub; the real backend reads opsSettings
// and site coordinates server-side (the client can't be trusted with the baseline
// its own drives are judged against).
//
// payroll=true is the read for anything that PAYS or totals drive (the pay run, the Hours
// report, the OT watch): EVERY leg that DEPARTS in the window (lib/driveTime
// legsDepartingIn — the day/week payroll buckets a leg by), as compact rows, where the
// drive-time screen's read is a capped newest-N scan of legs by arrival. Implies
// skipEstimates. Real mode splits the window into week-long calls (bounded concurrency)
// so no single response nears the 4.5 MB function limit at full volume; legs partition
// cleanly across the calls because each is kept by its departure instant.
const PAYROLL_CHUNK_MS = 7 * 24 * 3600 * 1000;
const PAYROLL_CONCURRENCY = 3;

async function payrollReport({ fromIso, toIso, filters }) {
  if (!fromIso || !toIso) throw new Error('A payroll drive read needs a from and to date.');
  const end = Date.parse(toIso);
  const chunks = [];
  for (let a = Date.parse(fromIso); a <= end; a += PAYROLL_CHUNK_MS) {
    chunks.push([a, Math.min(a + PAYROLL_CHUNK_MS - 1, end)]);
  }
  const results = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      if (i >= chunks.length) return;
      next += 1;
      const [a, b] = chunks[i];
      results[i] = await api('/time/drive-report', {
        method: 'POST',
        body: { fromIso: new Date(a).toISOString(), toIso: new Date(b).toISOString(), filters, skipEstimates: true, payroll: true },
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAYROLL_CONCURRENCY, chunks.length) }, worker));
  const seen = new Set();
  const rows = [];
  for (const r of results) {
    for (const s of (r && r.rows) || []) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      rows.push(s);
    }
  }
  return { rows, summary: null, config: results[0]?.config || null, estimatesPending: 0, truncated: false };
}

export async function report({ fromIso, toIso, filters = {}, config, sites, skipEstimates = false, payroll = false } = {}) {
  if (payroll) skipEstimates = true;
  if (BACKEND) {
    if (payroll) return payrollReport({ fromIso, toIso, filters });
    return api('/time/drive-report', { method: 'POST', body: { fromIso, toIso, filters, skipEstimates, payroll } });
  }

  const cfg = {
    maxGapMins: Number.isFinite(config?.maxGapMins) ? config.maxGapMins : DEFAULT_DRIVE_MAX_GAP_MINS,
    flagPct: Number.isFinite(config?.flagPct) ? config.flagPct : DEFAULT_DRIVE_FLAG_PCT,
    graceMins: Number.isFinite(config?.graceMins) ? config.graceMins : DEFAULT_DRIVE_GRACE_MINS,
  };
  const all = (_stubEntries() || []).map(mapRow);
  // Same window padding the server uses — a leg straddling the window start is real
  // paid travel and must not vanish because its opening clean is out of range. The
  // payroll read pads the way the server's does (back to the departing clean's
  // clock-in, forward by the gap cap) and keeps legs by departure.
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  const win = payroll && fromIso && toIso
    ? payrollLegFetchWindow({ fromIso, toIso, maxGapMins: cfg.maxGapMins })
    : null;
  const lo = win ? Date.parse(win.fromIso) : (Number.isFinite(from) ? from - cfg.maxGapMins * 60000 : from);
  const hi = win ? Date.parse(win.toIso) : to;
  const entries = all.filter((e) => {
    const t = new Date(e.clockInAt).getTime();
    return Number.isFinite(t) && t >= lo && t <= hi;
  });

  const siteById = new Map((sites || []).map((s) => [s.id, s]));
  const estimates = new Map();
  if (!skipEstimates) {
    for (const seg of deriveDriveSegments(entries, { maxGapMins: cfg.maxGapMins })) {
      if (!seg.fromSiteId || !seg.toSiteId || seg.fromSiteId === seg.toSiteId) continue;
      const key = driveEstimateKey(seg.fromSiteId, seg.toSiteId);
      if (estimates.has(key)) continue;
      const est = stubDriveEstimate(siteById.get(seg.fromSiteId), siteById.get(seg.toSiteId));
      if (est) estimates.set(key, est);
    }
  }

  const { rows, summary } = runDriveReport(entries, { estimates, overrides: loadOverrides(), config: cfg });
  let finalRows = win
    ? legsDepartingIn(rows, { fromIso, toIso })
    : rows.filter((r) => new Date(r.endAt).getTime() >= from);
  if (filters.siteIds?.length) {
    const want = new Set(filters.siteIds);
    finalRows = finalRows.filter((r) => want.has(r.fromSiteId) || want.has(r.toSiteId));
  }
  if (filters.userIds?.length) {
    const want = new Set(filters.userIds);
    finalRows = finalRows.filter((r) => want.has(r.userId));
  }
  if (filters.flaggedOnly) finalRows = finalRows.filter((r) => r.flag === 'over');
  return { rows: finalRows, summary, config: cfg, estimatesPending: 0, truncated: false };
}

// One site pair, for the crew "drive to your next site" hint. Real mode resolves
// coordinates server-side; the stub uses the store's own site rows.
export async function estimate({ fromSiteId, toSiteId, sites } = {}) {
  if (!fromSiteId || !toSiteId || fromSiteId === toSiteId) return null;
  if (BACKEND) {
    const qs = new URLSearchParams({ fromSiteId, toSiteId });
    return (await api(`/time/drive-estimate?${qs.toString()}`)).estimate || null;
  }
  const byId = new Map((sites || []).map((s) => [s.id, s]));
  return stubDriveEstimate(byId.get(fromSiteId), byId.get(toSiteId));
}

// Manager ruling on ONE leg. paidMinutes null + excluded false = pay the recorded
// actual; a reason is always required (the pay-adjust audit).
export async function setOverride({ fromEntryId, toEntryId, excluded = false, paidMinutes = null, reason, actualMinutes = null, estimateMinutes = null }) {
  if (BACKEND) {
    return api('/time/drive-override', {
      method: 'POST',
      body: { fromEntryId, toEntryId, excluded, paidMinutes, reason, actualMinutes, estimateMinutes },
    });
  }
  const list = loadOverrides().filter((o) => !(o.fromEntryId === fromEntryId && o.toEntryId === toEntryId));
  const override = {
    fromEntryId, toEntryId, excluded: !!excluded,
    paidMinutes: Number.isFinite(paidMinutes) ? paidMinutes : null,
    reason, actualMinutes, estimateMinutes,
    createdByName: 'Demo manager', createdAt: new Date().toISOString(),
  };
  list.push(override);
  saveOverrides(list);
  return { override };
}

export async function clearOverride({ fromEntryId, toEntryId }) {
  if (BACKEND) {
    return api('/time/drive-override', { method: 'POST', body: { action: 'clear', fromEntryId, toEntryId } });
  }
  saveOverrides(loadOverrides().filter((o) => !(o.fromEntryId === fromEntryId && o.toEntryId === toEntryId)));
  return { cleared: true };
}
