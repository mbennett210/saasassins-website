// Pure helpers for folding buffered OFFLINE clock punches into fetched time entries
// (CLEANSPACE_SWEPT.md §5.4). Extracted from timeApi.js with ZERO imports so the merge
// logic is headlessly unit-testable in bare Node (timeApi.js itself pulls in
// browser/Vite-only modules). No I/O — every function is a pure transform.

// Whole-minute duration between two ISO timestamps; null if missing or negative.
export function durationMins(inAt, outAt) {
  if (!inAt || !outAt) return null;
  const ms = new Date(outAt).getTime() - new Date(inAt).getTime();
  return ms >= 0 ? Math.round(ms / 60000) : null;
}

// Synthesize the UI entry a buffered punch stands in for, so the crew immediately
// see themselves clocked in/out offline. Mirrors the server row shape the UI reads;
// `pending_sync` is a client-only flag the UI badges as "will sync". geofence_result
// is 'unknown' here — the SERVER decides it authoritatively on replay.
export function entryFromPunch(p) {
  const ctx = p.ctx || {};
  return {
    id: p.id,
    job_id: p.jobId || null,
    series_id: ctx.seriesId || null,
    shift_id: ctx.shiftId || null,
    client_id: ctx.clientId || null,
    site_id: ctx.siteId || null,
    user_id: p.userId || ctx.userId || null,
    client_name: ctx.clientName || null,
    site_name: ctx.siteName || null,
    user_name: ctx.userName || null,
    scheduled_start: ctx.scheduledStart || null,
    scheduled_end: ctx.scheduledEnd || null,
    expected_minutes_snapshot: Number.isFinite(ctx.expectedMins) ? ctx.expectedMins : null,
    clock_in_at: p.assertedInAt || null,
    clock_out_at: p.assertedOutAt || null,
    duration_minutes: durationMins(p.assertedInAt, p.assertedOutAt),
    clock_in_lat: p.inLat ?? null,
    clock_in_lng: p.inLng ?? null,
    clock_in_accuracy_m: p.inAccuracyM ?? null,
    clock_in_distance_m: null,
    clock_out_lat: p.outLat ?? null,
    clock_out_lng: p.outLng ?? null,
    geofence_result: 'unknown',
    source: 'offline_replay',
    status: p.assertedOutAt ? 'completed' : 'in_progress',
    approval_status: 'pending',
    client_punch_id: p.id,
    pending_sync: true,
    edit_history: [],
  };
}

// Fold not-yet-synced buffered offline punches into a fetched entries list so the
// crew see their offline clock state. 'in' punches become synthesized entries
// (unless the server row already exists — matched by client_punch_id); 'out'
// punches patch a matching open server entry. Buffered punches belong to whoever is
// signed in on this device, so a userId filter keeps another crew member's punches out.
export function mergeBufferedPunches(serverEntries, punches, { userId = null, openOnly = false } = {}) {
  if (!punches || !punches.length) return serverEntries;
  const syncedPunchIds = new Set(serverEntries.map((e) => e.client_punch_id).filter(Boolean));
  const out = serverEntries.slice();
  for (const p of punches) {
    if (userId && p.userId && p.userId !== userId) continue;
    if (p.kind === 'out') {
      const i = out.findIndex((e) => e.id === p.entryId);
      if (i >= 0 && !out[i].clock_out_at) {
        out[i] = {
          ...out[i], clock_out_at: p.assertedOutAt, status: 'completed',
          duration_minutes: durationMins(out[i].clock_in_at, p.assertedOutAt), pending_sync: true,
        };
      }
      continue;
    }
    // kind 'in'
    if (p.id && syncedPunchIds.has(p.id)) continue;         // already replayed to the server
    const e = entryFromPunch(p);
    if (openOnly && e.clock_out_at) continue;
    out.push(e);
  }
  return out;
}
