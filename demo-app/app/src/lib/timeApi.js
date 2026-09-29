// Client adapter for crew clock-in/out + the labor projections (the caller's own
// entries, who's-on-the-clock). Real backend (/api/time/*) when Supabase auth is
// configured; an auto-engaged localStorage STUB in local/demo mode so the whole
// clock flow — geofence gate, running timer, multi-cleaner attribution — is
// exercisable without a backend. The stub computes the geofence verdict with the
// SAME src/lib/geo.js the server uses, so demo and prod gate identically.
//
// These results are component-local projections — pages hold them in useState and
// NEVER dispatch them into the synced blob (a clock-in must not trigger a
// full-document CAS rewrite + Realtime re-pull on every other client). See §2.1.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import { geofenceVerdict, DEFAULT_GEOFENCE_RADIUS_M } from './geo';
import { addPunch, getPunch, updatePunch, removePunch, allPunches, newPunchId, clearPunches } from './timeQueue';
import { fetchAllPages } from './pagedFetch';
// Pure merge/dedup helpers live in their own dependency-free module so they can be
// unit-tested headlessly (timeApi.js pulls in browser/Vite-only modules).
import { durationMins, entryFromPunch, mergeBufferedPunches } from './timeMerge';
import { applyJobCancellation } from './timeCancel';

export { entryFromPunch, mergeBufferedPunches } from './timeMerge';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js (Sept 1 incident)
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isTimeStub() { return !BACKEND; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON / empty */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = json; // carries the geofence {result,distanceM,allowedM} on a 403
    throw err;
  }
  return json;
}

// ── offline buffering (§5.4) ──────────────────────────────────────────────────
// A save that fails because the backend RESPONDED (HTTP status) is a real error
// the UI must handle (403 geofence, 409 duplicate, 500). A save that fails with NO
// status is a network/offline failure → we buffer the punch and replay it later.
// api() sets err.status for every HTTP error, so "no status" == offline.
const isOfflineError = (e) => !(e && Number.isFinite(e.status));
const isOffline = () => (typeof navigator !== 'undefined' && navigator.onLine === false);

// Fail closed when the punch can't be persisted (IndexedDB missing / over quota /
// private mode): tell the crew it was NOT captured instead of a false "will sync"
// that silently loses labor. §5.4 fails closed when it can't buffer.
function unbufferable(what) {
  const err = new Error(`Can’t save your ${what} offline on this device. Reconnect to a signal to ${what}.`);
  err.offlineUnbuffered = true;
  return err;
}

// clientPunchId is minted by the caller (clockIn) so the same key is used on the
// online attempt AND its buffered twin → they collide server-side, never double-pay.
async function bufferClockIn({ clientPunchId, jobId, lat, lng, accuracyM, ctx }) {
  const punch = {
    id: clientPunchId, kind: 'in',
    userId: ctx?.userId || null, jobId, ctx: ctx || null,
    assertedInAt: nowIso(),
    inLat: Number.isFinite(lat) ? lat : null,
    inLng: Number.isFinite(lng) ? lng : null,
    inAccuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
    createdAt: nowIso(),
  };
  if (!(await addPunch(punch))) throw unbufferable('clock in');
  return entryFromPunch(punch);
}

async function bufferClockOut({ entryId, lat, lng, userId = null }) {
  const punch = {
    id: newPunchId(), kind: 'out',
    userId, entryId,
    assertedOutAt: nowIso(),
    outLat: Number.isFinite(lat) ? lat : null,
    outLng: Number.isFinite(lng) ? lng : null,
    createdAt: nowIso(),
  };
  if (!(await addPunch(punch))) throw unbufferable('clock out');
  return { id: entryId, clock_out_at: punch.assertedOutAt, status: 'completed', pending_sync: true };
}

// ── public API ───────────────────────────────────────────────────────────────
// clockIn: real mode sends only the device facts (server resolves names/expected/
// coords authoritatively); the stub uses `ctx` (resolved client-side from the
// store) to mirror that resolution. A 403 throws an Error whose .payload.geofence
// carries { result, distanceM, allowedM } so the UI can explain + offer override.
// OFFLINE (network failure or navigator.onLine=false): buffer the punch and return
// a synthesized entry; the server re-geofences + windows it on replay (§5.4). A
// real HTTP error (geofence block, duplicate) still throws for the UI to handle.
export async function clockIn({ jobId, lat, lng, accuracyM, override, overrideReason, ctx }) {
  if (BACKEND) {
    // Mint the idempotency key up front: the online row and any buffered replay of
    // this same clock-in carry it, so a lost ACK can never double-record labor.
    const clientPunchId = newPunchId();
    if (isOffline()) return bufferClockIn({ clientPunchId, jobId, lat, lng, accuracyM, ctx });
    try {
      return (await api('/time/clock-in', { method: 'POST', body: { jobId, lat, lng, accuracyM, override, overrideReason, clientPunchId } })).entry;
    } catch (e) {
      if (isOfflineError(e)) return bufferClockIn({ clientPunchId, jobId, lat, lng, accuracyM, ctx });
      throw e;
    }
  }
  return stubClockIn({ jobId, lat, lng, accuracyM, override, ctx });
}

// userId is the entry owner (ClockControl passes entry.user_id) so a buffered
// clock-out is attributed + identity-filtered to the right crew member on replay.
export async function clockOut({ entryId, lat, lng, userId = null }) {
  if (BACKEND) {
    // Clocking out a still-buffered offline clock-in → fold the out-time into the
    // SAME buffered punch (one completed row on replay), no network needed.
    const buffered = await getPunch(entryId);
    if (buffered && buffered.kind === 'in') {
      const ok = await updatePunch(entryId, {
        assertedOutAt: nowIso(),
        outLat: Number.isFinite(lat) ? lat : null,
        outLng: Number.isFinite(lng) ? lng : null,
      });
      if (!ok) throw unbufferable('clock out');
      return entryFromPunch(await getPunch(entryId));
    }
    if (isOffline()) return bufferClockOut({ entryId, lat, lng, userId });
    try {
      return (await api('/time/clock-out', { method: 'POST', body: { entryId, lat, lng } })).entry;
    } catch (e) {
      if (isOfflineError(e)) return bufferClockOut({ entryId, lat, lng, userId });
      throw e;
    }
  }
  return stubClockOut({ entryId, lat, lng });
}

export async function correctEntry({ entryId, patch, reason }) {
  if (BACKEND) return (await api('/time/correct', { method: 'POST', body: { entryId, patch, reason } })).entry;
  return stubUpdate(entryId, (e) => {
    const next = { ...e, ...patch, edited: true };
    if (patch && (patch.clock_in_at !== undefined || patch.clock_out_at !== undefined)) {
      next.duration_minutes = durationMins(next.clock_in_at, next.clock_out_at);
    }
    const hist = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
    hist.push({ at: nowIso(), field: Object.keys(patch || {}).join(',') || 'note', from: null, to: null, reason: reason || null });
    next.edit_history = hist;
    return next;
  });
}

export async function manualEntry({ jobId, userId, clockInAt, clockOutAt, note, reason, ctx }) {
  if (BACKEND) return (await api('/time/manual', { method: 'POST', body: { jobId, userId, clockInAt, clockOutAt, note, reason } })).entry;
  return stubManual({ jobId, userId, clockInAt, clockOutAt, note, ctx });
}

export async function approveEntry({ entryId, approval }) {
  if (BACKEND) return (await api('/time/approve', { method: 'POST', body: { entryId, approval } })).entry;
  return stubUpdate(entryId, (e) => ({ ...e, approval_status: approval === 'rejected' ? 'rejected' : 'approved', approved_at: nowIso() }));
}

// A clean was cancelled: stop the clock on any OPEN punch (pay actual, capped at the
// scheduled end) and flag every punch on it as cancelled-clean labor so payroll + the
// clock history show it (lib/timeCancel is the shared transform). The manager who can
// cancel the job (schedule.edit) triggers this; the server re-checks that authority.
// Returns { closed, flagged }.
export async function cancelJobLabor({ jobId }) {
  if (!jobId) return { closed: 0, flagged: 0 };
  if (BACKEND) return api('/time/job-cancelled', { method: 'POST', body: { jobId } });
  const db = loadStub();
  const { entries, closed, flagged } = applyJobCancellation(db.entries, jobId, nowIso());
  db.entries = entries;
  saveStub(db);
  return { closed, flagged };
}

// Impure wrapper: read the buffered punches from IndexedDB, then merge (pure) via
// mergeBufferedPunches (imported from ./timeMerge).
async function mergeBuffered(serverEntries, opts = {}) {
  let punches;
  try { punches = await allPunches(); } catch { punches = []; }
  return mergeBufferedPunches(serverEntries, punches, opts);
}

// The caller's own recent entries. Real derives the user from the token; the stub
// filters by the passed userId. Offline (network failure) the fetch is swallowed and
// only the buffered offline punches are returned — the crew still see what they've
// clocked this session; a genuine HTTP error still throws (MyDay shows Retry).
export async function mine({ userId, sinceIso } = {}) {
  if (BACKEND) {
    let serverEntries = [];
    try {
      const qs = sinceIso ? `?sinceIso=${encodeURIComponent(sinceIso)}` : '';
      serverEntries = (await api(`/time/mine${qs}`)).entries || [];
    } catch (e) {
      if (!isOfflineError(e)) throw e;                       // real error → surface
    }
    let merged = await mergeBuffered(serverEntries, { userId });
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      merged = merged.filter((e) => !e.clock_in_at || new Date(e.clock_in_at).getTime() >= since);
    }
    return merged.sort((a, b) => new Date(b.clock_in_at) - new Date(a.clock_in_at));
  }
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  return loadStub().entries
    .filter((e) => e.user_id === userId && new Date(e.clock_in_at).getTime() >= since)
    .sort((a, b) => new Date(b.clock_in_at) - new Date(a.clock_in_at));
}

export async function open() {
  if (BACKEND) {
    let serverEntries = [];
    try { serverEntries = (await api('/time/open')).entries || []; }
    catch (e) { if (!isOfflineError(e)) throw e; }
    const merged = await mergeBuffered(serverEntries, { openOnly: true });
    return merged.filter((e) => !e.clock_out_at).sort((a, b) => new Date(a.clock_in_at) - new Date(b.clock_in_at));
  }
  return loadStub().entries.filter((e) => !e.clock_out_at).sort((a, b) => new Date(a.clock_in_at) - new Date(b.clock_in_at));
}

// Punch HISTORY for the manager Time Clock surfaces (account tab, crew-member
// page, job page, /time). Raw rows newest-first, bounded — SERVER truth only: a
// punch still buffered on some phone is not "registered" and must not read as
// one here (it shows on that phone's My Day banner until it replays, §5.4). A
// real HTTP error throws so the component can show Retry.
export async function entries({ fromIso, toIso, siteIds, clientIds, userIds, jobIds, limit = 500 } = {}) {
  if (BACKEND) {
    const qs = entryFilterParams({ fromIso, toIso, siteIds, clientIds, userIds, jobIds });
    qs.set('limit', String(limit));
    const r = await api(`/time/entries?${qs.toString()}`);
    return { entries: r.entries || [], truncated: !!r.truncated };
  }
  // Demo stub: the same filter semantics over the localStorage ledger.
  const rows = stubEntriesInWindow({ fromIso, toIso, siteIds, clientIds, userIds, jobIds })
    .sort((a, b) => new Date(b.clock_in_at) - new Date(a.clock_in_at));
  return { entries: rows.slice(0, limit), truncated: rows.length > limit };
}

// EVERY punch in a window — the COMPLETE read for anything that counts rather than lists
// (Reports › Not clocked in / out). The capped `entries` above is the newest-N history
// view; a report built on it silently missed the older punches of a busy day and called
// those cleaners "No punch". Paged (lib/pagedFetch.js); throws rather than return a
// partial set. `lite` narrows each punch to the columns attendance reads. Oldest first.
export async function entriesAll({ fromIso, toIso, siteIds, clientIds, userIds, jobIds, lite = false } = {}) {
  if (!fromIso || !toIso) throw new Error('A complete punch read needs a from and to date.');
  if (BACKEND) {
    return fetchAllPages({
      fetchPage: async (offset, limit) => {
        const qs = entryFilterParams({ fromIso, toIso, siteIds, clientIds, userIds, jobIds });
        qs.set('paged', '1'); qs.set('offset', String(offset)); qs.set('limit', String(limit));
        if (lite) qs.set('lite', '1');
        const r = await api(`/time/entries?${qs.toString()}`);
        return { rows: r.entries || [], total: r.total, limit: r.limit };
      },
    });
  }
  return stubEntriesInWindow({ fromIso, toIso, siteIds, clientIds, userIds, jobIds })
    .sort((a, b) => (new Date(a.clock_in_at) - new Date(b.clock_in_at)) || String(a.id).localeCompare(String(b.id)));
}

// The ids of the cleans someone really clocked into in a window (voided / no-show punches
// never count) — all the late/missed alerts and the Dashboard missed-cleans KPI need.
// Computed server-side over every punch in the window (complete at any volume), so the
// client receives job ids, not punches.
export async function coveredJobIds({ fromIso, toIso } = {}) {
  if (!fromIso || !toIso) throw new Error('Coverage needs a from and to date.');
  if (BACKEND) {
    const qs = new URLSearchParams({ fromIso, toIso });
    return (await api(`/time/covered-jobs?${qs.toString()}`)).jobIds || [];
  }
  const ids = stubEntriesInWindow({ fromIso, toIso })
    .filter((e) => e.job_id && e.clock_in_at && e.status !== 'voided' && e.status !== 'no_show')
    .map((e) => e.job_id);
  return [...new Set(ids)];
}

function entryFilterParams({ fromIso, toIso, siteIds, clientIds, userIds, jobIds }) {
  const qs = new URLSearchParams();
  if (fromIso) qs.set('fromIso', fromIso);
  if (toIso) qs.set('toIso', toIso);
  if (siteIds?.length) qs.set('siteIds', siteIds.join(','));
  if (clientIds?.length) qs.set('clientIds', clientIds.join(','));
  if (userIds?.length) qs.set('userIds', userIds.join(','));
  if (jobIds?.length) qs.set('jobIds', jobIds.join(','));
  return qs;
}

function stubEntriesInWindow({ fromIso, toIso, siteIds, clientIds, userIds, jobIds }) {
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  return loadStub().entries.filter((e) => {
    const t = new Date(e.clock_in_at).getTime();
    return Number.isFinite(t) && t >= from && t <= to
      && (!siteIds?.length || siteIds.includes(e.site_id))
      && (!clientIds?.length || clientIds.includes(e.client_id))
      && (!userIds?.length || userIds.includes(e.user_id))
      && (!jobIds?.length || jobIds.includes(e.job_id));
  });
}

// ── offline replay (reconnect sync-back) ──────────────────────────────────────
// Replay every buffered punch to POST /api/time/replay. Idempotent server-side (on
// clientPunchId) so a retried flush can't double-record. Stops on the first offline
// error (retry later); a TERMINAL http error (job deleted, no longer assigned) marks
// the punch failed and skips it in future flushes WITHOUT deleting it, so buffered
// labor is never silently lost — surfaced via pendingPunchCount({includeFailed}).
export async function flushOfflineQueue({ currentUserId = null } = {}) {
  if (!BACKEND) return { flushed: 0 };
  if (isOffline()) return { flushed: 0, offline: true };
  let punches;
  try { punches = await allPunches(); } catch { return { flushed: 0 }; }
  let flushed = 0, failed = 0, skipped = 0, newlyFailed = 0, transientSeen = 0;
  for (const p of punches) {
    if (p.synced) continue;                    // replayed already; only the local delete failed — inert
    if (p.failed) { failed++; continue; }
    // NEVER replay another crew member's buffered punch under the current session —
    // it would mis-attribute (and mis-pay) their labor. Hold it (don't fail it) for
    // its real owner to flush when they next sign in on this device.
    if (currentUserId && p.userId && p.userId !== currentUserId) { skipped++; continue; }
    const body = p.kind === 'out'
      ? { clientPunchId: p.id, entryId: p.entryId, assertedOutAt: p.assertedOutAt, outLat: p.outLat, outLng: p.outLng, userId: p.userId || null }
      : {
          clientPunchId: p.id, jobId: p.jobId, userId: p.userId || null,
          assertedInAt: p.assertedInAt, assertedOutAt: p.assertedOutAt || null,
          inLat: p.inLat, inLng: p.inLng, inAccuracyM: p.inAccuracyM,
          outLat: p.outLat, outLng: p.outLng,
        };
    try {
      await api('/time/replay', { method: 'POST', body });
      const removed = await removePunch(p.id);
      flushed++;                                             // replay committed (server is idempotent)
      if (!removed) {
        // Replayed to the server but the local delete failed. Mark it 'synced' (NOT
        // failed — the labor IS recorded) so it isn't replayed forever and doesn't
        // raise a false "couldn't sync" for the crew.
        await updatePunch(p.id, { synced: true, note: 'replayed; local delete failed', at: nowIso() });
      }
    } catch (e) {
      if (isOfflineError(e)) break;                          // still offline — stop, retry on next reconnect
      // Identity mismatch (shared device, punch owned by another crew member) is NOT
      // terminal — hold it for its real owner instead of failing it.
      if (e.status === 403 && e.payload?.identityMismatch) { skipped++; continue; }
      // 🔴 TRANSIENT failures are NOT terminal (Sept 1 hardening). This used to mark
      // failed:true for ANY HTTP error — so one 401 from a token mid-refresh, one
      // cold-start 500, or one 429 permanently stopped a punch from ever retrying,
      // and buffered labor sat dead on the phone with only a small crew-side banner.
      // A 401 heals on the next auth refresh; 5xx/408/429 heal on the server side.
      // Two refinements from adversarial review:
      //   · CONTINUE, not break, so one punch that deterministically 500s (a
      //     poisoned payload) can't head-of-line-block every later punch forever;
      //   · a small circuit breaker: several transients in one pass means the
      //     backend/session is down — stop hammering, retry next cycle (60s /
      //     reconnect / foreground). Attempts are counted on the punch so a
      //     chronically transient one is visible in its record, but it is NEVER
      //     auto-failed — losing labor to a counter would recreate the bug.
      const transient = e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500;
      if (transient) {
        await updatePunch(p.id, { transientAttempts: (p.transientAttempts || 0) + 1, lastTransientAt: nowIso(), lastError: e?.message || String(e) });
        transientSeen += 1;
        if (transientSeen >= 3) break;
        continue;
      }
      await updatePunch(p.id, { failed: true, error: e?.message || String(e), errorStatus: e?.status || null, failedAt: nowIso() });
      failed++; newlyFailed++;
    }
  }
  // A flush swaps buffered op_* ids for real server rows AND may newly mark a punch
  // failed — signal the UI to refetch so a clocked-in card stops pointing at a removed
  // id and the "couldn't sync" banner appears promptly.
  if ((flushed > 0 || newlyFailed > 0) && typeof window !== 'undefined' && window.dispatchEvent) {
    try { window.dispatchEvent(new CustomEvent('cleanspace:time-queue-flushed', { detail: { flushed, failed: newlyFailed } })); } catch { /* ignore */ }
  }
  return { flushed, failed, skipped };
}

// Count of buffered punches still to sync (for the UI banner). 'synced' artifacts
// (replayed to the server, local delete failed — labor already recorded) never
// count. Terminally 'failed' punches count only when includeFailed is set.
export async function pendingPunchCount({ includeFailed = false } = {}) {
  if (!BACKEND) return 0;
  let punches;
  try { punches = await allPunches(); } catch { return 0; }
  return punches.filter((p) => !p.synced && (includeFailed || !p.failed)).length;
}

// Clear the device's offline punch buffer (sign-out — a punch is per crew member).
export async function clearOfflineQueue() {
  try { await clearPunches(); } catch { /* ignore */ }
}

// snake_case DB / stub row -> the neutral shape lib/payroll.js expects (same field
// names as varianceApi.mapRow, kept in sync).
function mapRollupRow(r) {
  return {
    id: r.id, userId: r.user_id, userName: r.user_name,
    siteId: r.site_id, clientId: r.client_id, siteName: r.site_name, clientName: r.client_name,
    durationMinutes: r.duration_minutes, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at,
    approvalStatus: r.approval_status, status: r.status, jobCancelledAt: r.job_cancelled_at,
  };
}

// Manager-only: completed labor rows in a window for the weekly-hours / OT rollup
// and the payroll export. Real mode reads EVERY row in the window, paged
// (lib/pagedFetch.js) — it used to take one capped response of the newest rows, so a
// semi-monthly pay run at full volume silently dropped its oldest punches (underpaid).
// Throws rather than return a partial set. The stub reads the same localStorage ledger.
// Returns neutral (camelCase) rows; OT bucketing + the reg/OT split live in the SHARED
// lib/payroll.js so demo and prod agree.
export async function rollup({ fromIso, toIso, approvedOnly = false } = {}) {
  if (BACKEND) {
    const rows = await fetchAllPages({
      fetchPage: async (offset, limit) => {
        const qs = new URLSearchParams({ paged: '1', offset: String(offset), limit: String(limit) });
        if (fromIso) qs.set('fromIso', fromIso);
        if (toIso) qs.set('toIso', toIso);
        if (approvedOnly) qs.set('approvedOnly', '1');
        const r = await api(`/time/rollup?${qs.toString()}`);
        return { rows: r.entries || [], total: r.total, limit: r.limit };
      },
    });
    return rows.map(mapRollupRow);
  }
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  return loadStub().entries
    .filter((e) => {
      const t = new Date(e.clock_in_at).getTime();
      if (!Number.isFinite(t) || t < from || t > to) return false;
      if (approvedOnly && e.approval_status !== 'approved') return false;
      return true;
    })
    .map(mapRollupRow);
}

// Expose stub rows to the variance stub (same localStorage store) — real mode
// returns null so the variance adapter knows to hit the API instead.
export function _stubEntries() { return BACKEND ? null : loadStub().entries; }

// ── stub store (demo / local-only) ───────────────────────────────────────────
// Exported so the demo bootstrap (lib/demoBootstrap.js) can (re)seed the same
// localStorage ledger this stub reads via loadStub().
export const STUB_KEY = 'cleanspace_time_entries_stub_v1';
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const loadStub = () => { try { return JSON.parse(localStorage.getItem(STUB_KEY)) || { entries: [] }; } catch { return { entries: [] }; } };
const saveStub = (db) => { try { localStorage.setItem(STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };

function stubClockIn({ jobId, lat, lng, accuracyM, override, ctx = {} }) {
  const verdict = geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng, deviceLat: lat, deviceLng: lng,
    accuracyM, radiusM: ctx.radiusM ?? DEFAULT_GEOFENCE_RADIUS_M, enabled: ctx.geofenceEnabled !== false,
    // Which config switched the ring off (the site's, or this cleaner's — step 4b/R7), so a
    // demo punch records the same reason the deployed handler would.
    disabledReason: ctx.geofenceDisabledReason || undefined,
  });
  if (verdict.result === 'outside' && !override) {
    const err = new Error('Outside the geofence. You must be at the site to clock in');
    err.status = 403;
    err.payload = { geofence: { result: verdict.result, distanceM: verdict.distanceM, allowedM: verdict.allowedM } };
    throw err;
  }
  const db = loadStub();
  if (db.entries.some((e) => e.job_id === jobId && e.user_id === ctx.userId && e.status === 'in_progress')) {
    const err = new Error("You're already clocked in to this clean"); err.status = 409; throw err;
  }
  const result = (verdict.result === 'outside' && override) ? 'override' : verdict.result;
  const entry = {
    id: rid('te'), job_id: jobId, series_id: ctx.seriesId || null, shift_id: ctx.shiftId || null,
    client_id: ctx.clientId || null, site_id: ctx.siteId || null, user_id: ctx.userId || null,
    client_name: ctx.clientName || null, site_name: ctx.siteName || null, user_name: ctx.userName || null,
    scheduled_start: ctx.scheduledStart || null, scheduled_end: ctx.scheduledEnd || null,
    expected_minutes_snapshot: Number.isFinite(ctx.expectedMins) ? ctx.expectedMins : null,
    clock_in_at: nowIso(), clock_out_at: null, duration_minutes: null,
    clock_in_lat: lat ?? null, clock_in_lng: lng ?? null, clock_in_accuracy_m: accuracyM ?? null,
    clock_in_distance_m: verdict.distanceM, geofence_result: result,
    override_reason: result === 'override' ? (verdict.reason || 'override') : null,
    source: 'crew_mobile', status: 'in_progress', approval_status: 'pending', edit_history: [],
  };
  db.entries.push(entry); saveStub(db); return entry;
}

function stubClockOut({ entryId, lat, lng }) {
  return stubUpdate(entryId, (e) => {
    if (e.clock_out_at) return e;
    const out = nowIso();
    return { ...e, clock_out_at: out, duration_minutes: durationMins(e.clock_in_at, out), clock_out_lat: lat ?? null, clock_out_lng: lng ?? null, status: 'completed' };
  });
}

function stubManual({ jobId, userId, clockInAt, clockOutAt, note, ctx = {} }) {
  const db = loadStub();
  const entry = {
    id: rid('te'), job_id: jobId || null, series_id: ctx.seriesId || null, shift_id: ctx.shiftId || null,
    client_id: ctx.clientId || null, site_id: ctx.siteId || null, user_id: userId,
    client_name: ctx.clientName || null, site_name: ctx.siteName || null, user_name: ctx.userName || null,
    scheduled_start: ctx.scheduledStart || null, scheduled_end: ctx.scheduledEnd || null,
    expected_minutes_snapshot: Number.isFinite(ctx.expectedMins) ? ctx.expectedMins : null,
    clock_in_at: clockInAt, clock_out_at: clockOutAt || null, duration_minutes: durationMins(clockInAt, clockOutAt),
    clock_in_distance_m: null, geofence_result: 'override', override_reason: 'manual_entry',
    source: 'admin_manual', status: clockOutAt ? 'manual' : 'in_progress', approval_status: 'pending',
    note: note || null, edited: true, edit_history: [{ at: nowIso(), field: 'created', from: null, to: 'manual' }],
  };
  db.entries.push(entry); saveStub(db); return entry;
}

function stubUpdate(entryId, fn) {
  const db = loadStub();
  const i = db.entries.findIndex((e) => e.id === entryId);
  if (i < 0) return null;
  db.entries[i] = fn(db.entries[i]); saveStub(db); return db.entries[i];
}

// ── demo-period history recovery (Sept 1 incident) ────────────────────────────
// Phones that ran the stale demo-clock builds hold months of REAL punches in
// STUB_KEY localStorage. Once this (real-mode) build is loaded, MyDay offers a
// one-tap upload; the server ingests them as pending-approval 'stub_recovery'
// rows. The local data is RENAMED (never deleted) after a successful upload —
// it is the only original copy of that labor history.
const STUB_RECOVERED_KEY = `${STUB_KEY}_recovered`;

// Identity-hold, same law as flushOfflineQueue (line ~231): on a SHARED device
// the stub may hold several crew members' history. Only the signed-in owner's
// entries (or legacy entries with no user id) are counted/uploaded; everyone
// else's stay parked in STUB_KEY for their owner's next sign-in — one tap must
// never attribute a coworker's months of labor to the tapper.
const ownEntry = (e, currentUserId) => e.clock_in_at && e.clock_out_at
  && (!e.user_id || !currentUserId || e.user_id === currentUserId);

export function legacyStubEntryCount({ currentUserId = null } = {}) {
  if (!BACKEND) return 0; // demo mode itself — nothing to recover into
  // No resolved identity yet (blob still hydrating) → offer nothing. A null id
  // would classify COWORKERS' entries as "mine" on a shared device and the
  // upload's held-rewrite would strand their history in the parked copy.
  if (!currentUserId) return 0;
  try {
    const db = JSON.parse(localStorage.getItem(STUB_KEY));
    const entries = Array.isArray(db?.entries) ? db.entries : [];
    return entries.filter((e) => ownEntry(e, currentUserId)).length;
  } catch { return 0; }
}

// Batches under the server's 400-entry cap: a phone with months of multi-job
// nights can exceed it, and one over-cap POST would silently strand the tail
// (server slices, client clears). Sequential chunks, all-or-keep semantics.
const RECOVER_CHUNK = 300;

export async function recoverStubHistory({ currentUserId = null } = {}) {
  if (!BACKEND) return { inserted: 0 };
  if (!currentUserId) return { inserted: 0 }; // identity not resolved — see legacyStubEntryCount
  let db;
  try { db = JSON.parse(localStorage.getItem(STUB_KEY)); } catch { db = null; }
  const all = Array.isArray(db?.entries) ? db.entries : [];
  const mine = all.filter((e) => ownEntry(e, currentUserId));
  const held = all.filter((e) => !mine.includes(e));
  if (!mine.length) return { inserted: 0 };
  const payload = (e) => ({
    jobId: e.job_id || null,
    userId: e.user_id || null, // server-side identity backstop (mirrors replay)
    clockInAt: e.clock_in_at,
    clockOutAt: e.clock_out_at,
    clientName: e.client_name || null,
    siteName: e.site_name || null,
    userName: e.user_name || null,
  });
  const totals = { inserted: 0, duplicate: 0, skipped: 0, received: 0 };
  let sentCount = 0;
  try {
    for (let i = 0; i < mine.length; i += RECOVER_CHUNK) {
      const chunk = mine.slice(i, i + RECOVER_CHUNK);
      const r = await api('/time/recover-stub', { method: 'POST', body: { entries: chunk.map(payload) } });
      totals.inserted += r.inserted || 0;
      totals.duplicate += r.duplicate || 0;
      totals.skipped += r.skipped || 0;
      totals.received += r.received || 0;
      sentCount = i + chunk.length;
    }
  } catch (e) {
    // A mid-batch failure: keep EVERYTHING not-yet-confirmed in the live key
    // (already-sent chunks dedup server-side on retry) and rethrow for the UI.
    const remaining = [...mine.slice(sentCount), ...held];
    try { localStorage.setItem(STUB_KEY, JSON.stringify({ ...db, entries: remaining })); } catch { /* keep as-was */ }
    throw e;
  }
  // Success: park the uploaded copy (best-effort — the labor is now recorded
  // server-side) and rewrite the live key to ONLY the held-for-others entries
  // (or clear it), so the offer doesn't repeat for this user but coworkers'
  // history survives for their own sign-in. The deterministic punch ids make
  // any repeat upload harmless anyway.
  try { localStorage.setItem(STUB_RECOVERED_KEY, JSON.stringify({ at: nowIso(), uploaded: mine })); } catch { /* quota */ }
  try {
    if (held.length) localStorage.setItem(STUB_KEY, JSON.stringify({ ...db, entries: held }));
    else localStorage.removeItem(STUB_KEY);
  } catch { /* quota — repeat uploads dedup server-side */ }
  return { ...totals, heldForOthers: held.length };
}
