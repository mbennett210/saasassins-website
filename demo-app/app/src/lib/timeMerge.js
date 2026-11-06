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

// The entry a buffered clock-OUT stands for when the list it should patch has no row for it
// (CS-666: the phone's saved copy is gone, or predates the clock-in). The punch remembers its
// clean and its clock-in, which is all the card needs to read "clocked out, will sync".
function closedFromOutPunch(p) {
  return {
    id: p.entryId,
    job_id: p.jobId || null,
    user_id: p.userId || null,
    clock_in_at: p.clockInAt,
    clock_out_at: p.assertedOutAt || null,
    duration_minutes: durationMins(p.clockInAt, p.assertedOutAt),
    status: 'completed',
    approval_status: 'pending',
    pending_sync: true,
    edit_history: [],
  };
}

// Fold not-yet-synced buffered offline punches into a fetched entries list so the
// crew see their offline clock state. 'in' punches become synthesized entries
// (unless the server row already exists — matched by client_punch_id); 'out'
// punches patch a matching open server entry, or — when the list has no row for it —
// stand for it themselves. Buffered punches belong to whoever is signed in on this
// device, so a userId filter keeps another crew member's punches out.
export function mergeBufferedPunches(serverEntries, punches, { userId = null, openOnly = false } = {}) {
  if (!punches || !punches.length) return serverEntries;
  const syncedPunchIds = new Set(serverEntries.map((e) => e.client_punch_id).filter(Boolean));
  const out = serverEntries.slice();
  for (const p of punches) {
    if (userId && p.userId && p.userId !== userId) continue;
    if (p.kind === 'out') {
      const i = out.findIndex((e) => e.id === p.entryId);
      if (i >= 0) {
        if (!out[i].clock_out_at) {
          out[i] = {
            ...out[i], clock_out_at: p.assertedOutAt, status: 'completed',
            duration_minutes: durationMins(out[i].clock_in_at, p.assertedOutAt), pending_sync: true,
          };
        }
      } else if (!openOnly && p.entryId && p.jobId && p.clockInAt) {
        out.push(closedFromOutPunch(p));
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

// ── The replay order (CS-666) ───────────────────────────────────────────────────────────
// Buffered punches replay in the order the cleaner ACTED. The store hands them back in key
// order, and a key is `op_<uuid>` — random — so a clean's clock-in could land before the
// clock-out of the clean before it ("Two cleans at once" on an honest punch), or a re-tap's
// clock-out could replace the real one. Every punch carries `seq`, a number the phone stamps
// when the punch is made (lib/timeQueue nextPunchSeq: strictly increasing on this phone, so a
// clock the phone corrects between two taps cannot swap them). A punch buffered before the
// stamp existed is placed by when the cleaner acted — its clock-in for a clock-in (a clock-out
// folded into it later does not move it), its clock-out for a clock-out — on the same scale.
// At one instant a clock-out goes before a clock-in: closing one clean, then opening the next.
export const PUNCH_SEQ_PER_MS = 1000;

const msOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; };
function actedAtMs(p) {
  const t = p?.kind === 'out' ? msOf(p.assertedOutAt) : msOf(p?.assertedInAt);
  if (Number.isFinite(t)) return t;
  const created = msOf(p?.createdAt);
  return Number.isFinite(created) ? created : Infinity;
}
const orderKey = (p) => (Number.isFinite(p?.seq) ? p.seq : actedAtMs(p) * PUNCH_SEQ_PER_MS);
const kindRank = (p) => (p?.kind === 'out' ? 0 : 1);

export function replayOrder(punches) {
  return (Array.isArray(punches) ? punches : []).slice().sort((a, b) => (
    (orderKey(a) - orderKey(b)) || (kindRank(a) - kindRank(b)) || String(a?.id).localeCompare(String(b?.id))
  ));
}

// The next stamp after `last`: never behind the clock, never equal to the last one.
export function nextPunchSeqAfter(last, now = Date.now()) {
  const prior = Number(last);
  return Math.max(Math.floor(now) * PUNCH_SEQ_PER_MS, (Number.isFinite(prior) ? prior : 0) + 1);
}
