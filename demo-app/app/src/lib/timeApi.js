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
import { geofenceVerdict, DEFAULT_GEOFENCE_RADIUS_M, isOffSiteVerdict } from './geo';
import { clockOutGeofenceFields } from './clockRules';
import { addPunch, getPunch, updatePunch, removePunch, allPunches, newPunchId, clearPunches, nextPunchSeq } from './timeQueue';
import { fetchAllPages } from './pagedFetch';
// Pure merge/dedup helpers live in their own dependency-free module so they can be
// unit-tested headlessly (timeApi.js pulls in browser/Vite-only modules).
import { durationMins, entryFromPunch, mergeBufferedPunches, replayOrder } from './timeMerge';
import { savePunchProjection, readPunchProjection } from './punchProjection';
import { applyJobCancellation } from './timeCancel';
import { jobDoneAfterPunches } from './jobStatus';
// The SAME pure rules the server runs (spec §7) so the demo stub gates a punch write —
// scope, own, the paid lock, punch-time validation, the version CAS — exactly as prod does.
import { timeScopeFor, inTimeScope, refusesOwn, isPaidLocked, isGatedUser, isWorkedEntry, validatePunchTimes, closedPunchStatus, reasonRefusal, trimmedReason, correctionChanges, VOIDED_CLOCK_OUT_REASON, TIME_REFUSALS } from './timeRules';
import { TEAM, teamMemberIds, teamClientIds, teamLeadFor } from './teamScope';
import { blockingOpenPunch, openPunchLabel, overlapFlagNote, doublePunchMessage, DOUBLE_PUNCH_CODE } from './openPunchRule';
// The SAME weekly OT ledger the server approvals read runs (spec §4.2 / §7), so the demo
// Approvals screen shows identical pending OT + overtime.
import { computeWeekLedger, entryOtMinutes, overtimeUnitsForApproval } from './otLedger';
import { payWeekKeyOf, payPeriodRange, payWeekStartDayOf, isPayWeekKey } from './payroll';
import { can } from './roles';
import { addDaysKey, startOfDayKey } from './dates';
import { myHoursPeriod } from './myHours';
import { onTheWayEta, ON_THE_WAY_STUB_KEY, ON_THE_WAY_STUB_MAX } from './crewOnTheWay';

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
// the UI must handle (409 duplicate, 500). A save that fails with NO
// status is a network/offline failure → we buffer the punch and replay it later.
// api() sets err.status for every HTTP error, so "no status" == offline.
const isOfflineError = (e) => !(e && Number.isFinite(e.status));
const isOffline = () => (typeof navigator !== 'undefined' && navigator.onLine === false);

// Fail closed when the punch can't be persisted (IndexedDB missing / over quota /
// private mode): tell the crew it was NOT captured instead of a false "will sync"
// that silently loses labor. §5.4 fails closed when it can't buffer.
// The crew screen words it from the code, in their language (CS-193); the English message
// stays for the logs and the English reader.
function unbufferable(what) {
  const err = new Error(`Can’t save your ${what} offline on this device. Reconnect to a signal to ${what}.`);
  err.offlineUnbuffered = true;
  err.code = what === 'clock in' ? 'offline-unbufferable-in' : 'offline-unbufferable-out';
  return err;
}

// clientPunchId is minted by the caller (clockIn) so the same key is used on the
// online attempt AND its buffered twin → they collide server-side, never double-pay.
// Every buffered punch carries `seq` (CS-666): the flush replays in that order — the order the
// cleaner acted — never in the store's key order, which is random.
async function bufferClockIn({ clientPunchId, jobId, lat, lng, accuracyM, ctx }) {
  const punch = {
    id: clientPunchId, kind: 'in',
    userId: ctx?.userId || null, jobId, ctx: ctx || null,
    assertedInAt: nowIso(),
    inLat: Number.isFinite(lat) ? lat : null,
    inLng: Number.isFinite(lng) ? lng : null,
    inAccuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
    createdAt: nowIso(),
    seq: nextPunchSeq(),
  };
  if (!(await addPunch(punch))) throw unbufferable('clock in');
  return entryFromPunch(punch);
}

// `jobId` + `clockInAt` (CS-666) are the clean and the clock-in this punch closes, so the card
// can still show it clocked out offline when the phone holds no row for the punch.
async function bufferClockOut({ entryId, lat, lng, accuracyM, userId = null, jobId = null, clockInAt = null }) {
  const punch = {
    id: newPunchId(), kind: 'out',
    userId, entryId,
    jobId: jobId || null,
    clockInAt: clockInAt || null,
    seq: nextPunchSeq(),
    assertedOutAt: nowIso(),
    outLat: Number.isFinite(lat) ? lat : null,
    outLng: Number.isFinite(lng) ? lng : null,
    // PAY-12: the accuracy the device reported travels with the buffered punch, so the server's
    // clock-out geofence re-check widens the ring exactly as a live clock-out would.
    outAccuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
    createdAt: nowIso(),
  };
  if (!(await addPunch(punch))) throw unbufferable('clock out');
  return { id: entryId, clock_out_at: punch.assertedOutAt, status: 'completed', pending_sync: true };
}

// ── public API ───────────────────────────────────────────────────────────────
// clockIn: real mode sends only the device facts (server resolves names/expected/
// coords authoritatively); the stub uses `ctx` (resolved client-side from the
// store) to mirror that resolution. 🔴 PAY-17: the geofence NEVER refuses a clock-in — the
// returned entry carries the server's verdict, and the caller warns on an off-site one.
// `offSiteReason` is the cleaner's OPTIONAL note, recorded and never required.
// OFFLINE (network failure or navigator.onLine=false): buffer the punch and return
// a synthesized entry; the server re-geofences + windows it on replay (§5.4). A
// real HTTP error (a duplicate, the PAY-13 double punch) still throws for the UI to handle.
export async function clockIn({ jobId, lat, lng, accuracyM, offSiteReason, ctx }) {
  if (BACKEND) {
    // Mint the idempotency key up front: the online row and any buffered replay of
    // this same clock-in carry it, so a lost ACK can never double-record labor.
    const clientPunchId = newPunchId();
    if (isOffline()) return bufferClockIn({ clientPunchId, jobId, lat, lng, accuracyM, ctx });
    try {
      return (await api('/time/clock-in', { method: 'POST', body: { jobId, lat, lng, accuracyM, offSiteReason, clientPunchId } })).entry;
    } catch (e) {
      if (isOfflineError(e)) return bufferClockIn({ clientPunchId, jobId, lat, lng, accuracyM, ctx });
      throw e;
    }
  }
  return stubClockIn({ jobId, lat, lng, accuracyM, offSiteReason, ctx });
}

// userId is the entry owner (ClockControl passes entry.user_id) so a buffered
// clock-out is attributed + identity-filtered to the right crew member on replay.
// `accuracyM` and `ctx` are PAY-12's: the server measures the clock-out against the site the
// same way it measures the clock-in, and the demo stub needs the same context to reach the same
// verdict (in real mode `ctx` is ignored — the verdict is server-authoritative).
// → { entry, jobDone }. 🔴 CS-051: `jobDone` is the SERVER's answer — this was the clean's last
// open punch, so it marked the clean done. A buffered (offline) clock-out answers false: the
// replay settles the clean when it lands, and the change arrives like any schedule update.
// `jobId` + `clockInAt` are the entry's (CS-666): a buffered clock-out keeps them.
export async function clockOut({ entryId, lat, lng, accuracyM, userId = null, ctx = null, jobId = null, clockInAt = null }) {
  if (BACKEND) {
    // Clocking out a still-buffered offline clock-in → fold the out-time into the
    // SAME buffered punch (one completed row on replay), no network needed.
    const buffered = await getPunch(entryId);
    if (buffered && buffered.kind === 'in') {
      const ok = await updatePunch(entryId, {
        assertedOutAt: nowIso(),
        outLat: Number.isFinite(lat) ? lat : null,
        outLng: Number.isFinite(lng) ? lng : null,
        outAccuracyM: Number.isFinite(accuracyM) ? accuracyM : null,
      });
      if (!ok) throw unbufferable('clock out');
      return { entry: entryFromPunch(await getPunch(entryId)), jobDone: false };
    }
    const buffer = () => bufferClockOut({ entryId, lat, lng, accuracyM, userId, jobId, clockInAt });
    if (isOffline()) return { entry: await buffer(), jobDone: false };
    try {
      const r = await api('/time/clock-out', { method: 'POST', body: { entryId, lat, lng, accuracyM } });
      return { entry: r.entry, jobDone: r.jobDone === true };
    } catch (e) {
      if (isOfflineError(e)) return { entry: await buffer(), jobDone: false };
      throw e;
    }
  }
  return stubClockOut({ entryId, lat, lng, accuracyM, ctx });
}

// Correct (edit) a punch. Carries the version the manager saw (CAS); a changed clock time
// on an approved punch is sent back to pending server-side.
export async function correctEntry({ entryId, version, patch, reason }) {
  if (BACKEND) return (await api('/time/correct', { method: 'POST', body: { entryId, version, patch, reason } })).entry;
  return stubCorrect({ entryId, version, patch: patch || {}, reason });
}

// Delete a punch (Void) and Restore it — the manager replacements for the removed Reject.
export async function voidEntry({ entryId, version, reason }) {
  if (BACKEND) return (await api('/time/void', { method: 'POST', body: { entryId, version, reason } })).entry;
  return stubVoid({ entryId, version, reason });
}
export async function restoreEntry({ entryId, version, reason }) {
  if (BACKEND) return (await api('/time/restore', { method: 'POST', body: { entryId, version, reason } })).entry;
  return stubRestore({ entryId, version, reason });
}

export async function manualEntry({ jobId, userId, clockInAt, clockOutAt, note, reason, ctx }) {
  if (BACKEND) return (await api('/time/manual', { method: 'POST', body: { jobId, userId, clockInAt, clockOutAt, note, reason } })).entry;
  return stubManual({ jobId, userId, clockInAt, clockOutAt, note, reason, ctx });
}

// Approve a batch of punches, each carrying the version the manager saw. Returns the
// per-item results array ([{ entryId, ok, code?, entry? }]) — one refused item never blocks
// the others. Replaces the old single-punch approveEntry (II.5): every caller moved here.
export async function approveEntries(items) {
  const list = Array.isArray(items) ? items : [];
  if (BACKEND) return (await api('/time/approve', { method: 'POST', body: { items: list } })).results || [];
  return stubApprove(list);
}

// Approve a batch of OVERTIME units, each { userId, weekKey, clientId, minutes } (the unit's
// TOTAL approved OT). Returns per-item results ([{ key, ok, code?, approvedMinutes? }]) — one
// refused item never blocks the others, exactly like approveEntries.
export async function approveOvertime(items) {
  const list = Array.isArray(items) ? items : [];
  if (BACKEND) return (await api('/time/ot-approve', { method: 'POST', body: { items: list } })).results || [];
  return stubApproveOvertime(list);
}

// The Approvals read: { scope, pending:[punch rows + ot_minutes], overtime:[units], ledger,
// asOf }. supervisorId (owner/admin only; 'none' = customers with no manager) filters the
// unscoped view. Real mode hits the server; the demo stub runs the SAME timeRules + otLedger
// over the localStorage ledger + store blob + the OT-approval stub key.
export async function approvals({ supervisorId, om } = {}) {
  if (BACKEND) {
    const qs = supervisorId ? `?supervisorId=${encodeURIComponent(supervisorId)}${om ? `&om=${encodeURIComponent(om)}` : ''}` : '';
    return api(`/time/approvals${qs}`);
  }
  return stubApprovals({ supervisorId, om });
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
// filters by the passed userId. A genuine HTTP error still throws (MyDay shows Retry).
// 🔴 OFFLINE (CS-666): the read starts from the last server answer THIS PHONE saw for this
// cleaner (lib/punchProjection — every full online read is kept), and the buffered punches
// fold into it: a punch clocked in online stays open, and a clock-out made offline closes it
// "· will sync". It used to start from NOTHING, so the card offered "Clock in" again and
// "On the clock" vanished on any offline refresh, re-entry or restart.
export async function mine({ userId, sinceIso } = {}) {
  if (BACKEND) {
    let serverEntries = null;
    if (!isOffline()) {
      try {
        const qs = sinceIso ? `?sinceIso=${encodeURIComponent(sinceIso)}` : '';
        serverEntries = (await api(`/time/mine${qs}`)).entries || [];
        if (!sinceIso) savePunchProjection({ userId, entries: serverEntries });  // a windowed read is a part, not the answer
      } catch (e) {
        if (!isOfflineError(e)) throw e;                       // real error → surface
      }
    }
    if (serverEntries === null) serverEntries = readPunchProjection({ userId }) || [];
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

// "On my way" (Crew on the way: lib/crewOnTheWay.js; EP-422 / EP-423). The status says which of
// `jobIds` someone can be told on (`canTell`: a customer login on the building, or Matt's approved
// text) — the button shows only on those — and which already told them; the send tells the
// customers of ONE clean the cleaner is on, once: the hub's bell, their phones, and the text.
// The login-free demo has no server: every clean can be told, and the tap keeps its notice in this
// browser (ON_THE_WAY_STUB_KEY), which the demo hub's bell reads (lib/hubDemo updates).
export function readOnTheWayStub() {
  try {
    const rows = JSON.parse(localStorage.getItem(ON_THE_WAY_STUB_KEY) || '[]');
    return Array.isArray(rows) ? rows.filter((r) => r && r.jobId) : [];
  } catch { return []; }
}
export async function onMyWayStatus(jobIds = []) {
  const ids = [...new Set(jobIds.filter(Boolean))].slice(0, 30);
  if (!BACKEND) {
    const told = new Set(readOnTheWayStub().map((r) => r.jobId));
    return { available: ids.length > 0, canTell: ids, sent: ids.filter((id) => told.has(id)) };
  }
  return api(`/time/on-my-way${ids.length ? `?jobIds=${encodeURIComponent(ids.join(','))}` : ''}`);
}
// `job` (the demo only): its customer and start, for the notice the demo hub reads.
export async function sendOnMyWay(jobId, job = null) {
  if (!BACKEND) {
    const rows = readOnTheWayStub();
    if (rows.some((r) => r.jobId === jobId)) return { sent: true, already: true };
    const now = Date.now();
    rows.unshift({ jobId, clientId: job?.clientId || null, eta: onTheWayEta(job, now), at: new Date(now).toISOString() });
    try { localStorage.setItem(ON_THE_WAY_STUB_KEY, JSON.stringify(rows.slice(0, ON_THE_WAY_STUB_MAX))); } catch { /* demo only */ }
    return { sent: true };
  }
  return api('/time/on-my-way', { method: 'POST', body: { jobId } });
}

// The Cleaner Hub's MY HOURS (2026-10-13, brief C §3; view only): the caller's own pay period, day
// by day — lib/myHours myHoursPeriod, the ONE rule the route (EP-381) and this stub run. The server
// works the period out from the full opsSettings (the crew's view of the record has no cadence);
// the demo reads its own store's. A cleaner sends nothing but `offset` (0 = this period, 1 = the one
// before…); the owner's View-as names the person on screen (`previewUserId`), which the server
// honours only for an office login holding time.view. In the demo the user is switched for real.
export async function myHours({ userId = null, previewUserId = null, offset = 0 } = {}) {
  if (BACKEND) {
    const qs = new URLSearchParams();
    if (offset) qs.set('offset', String(offset));
    if (previewUserId) qs.set('userId', previewUserId);
    const q = qs.toString();
    return api(`/time/my-hours${q ? `?${q}` : ''}`);
  }
  const s = ppGetState();
  const who = previewUserId || userId;
  return myHoursPeriod({
    entries: who ? loadStub().entries.filter((e) => e.user_id === who) : [],
    opsSettings: s?.opsSettings || {}, now: Date.now(), offset, tz: s?.company?.timezone || undefined,
  });
}

// Everyone on the clock now, NEWEST clock-in first (CS-726): the server answers every open
// punch (a complete read), and the strip leads with who just arrived.
export async function open() {
  if (BACKEND) {
    let serverEntries = [];
    try { serverEntries = (await api('/time/open')).entries || []; }
    catch (e) { if (!isOfflineError(e)) throw e; }
    const merged = await mergeBuffered(serverEntries, { openOnly: true });
    return merged.filter((e) => !e.clock_out_at).sort((a, b) => new Date(b.clock_in_at) - new Date(a.clock_in_at));
  }
  return loadStub().entries.filter((e) => !e.clock_out_at).sort((a, b) => new Date(b.clock_in_at) - new Date(a.clock_in_at));
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
// 🔴 IN THE ORDER THE CLEANER ACTED (CS-666, lib/timeMerge replayOrder), never the store's
// key order (`op_<uuid>`: random). Reversed, a clean's clock-in reached the server while the
// clean before it was still open and was flagged "Two cleans at once", and a re-tap's
// clock-out could replace the real one.
export const HOLD_THE_LINE_ATTEMPTS = 3;
export async function flushOfflineQueue({ currentUserId = null } = {}) {
  if (!BACKEND) return { flushed: 0 };
  if (isOffline()) return { flushed: 0, offline: true };
  let punches;
  try { punches = replayOrder(await allPunches()); } catch { return { flushed: 0 }; }
  let flushed = 0, failed = 0, skipped = 0, newlyFailed = 0, transientSeen = 0;
  for (const p of punches) {
    if (p.synced) continue;                    // replayed already; only the local delete failed — inert
    if (p.failed) { failed++; continue; }
    // NEVER replay another crew member's buffered punch under the current session —
    // it would mis-attribute (and mis-pay) their labor. Hold it (don't fail it) for
    // its real owner to flush when they next sign in on this device.
    if (currentUserId && p.userId && p.userId !== currentUserId) { skipped++; continue; }
    const body = p.kind === 'out'
      ? { clientPunchId: p.id, entryId: p.entryId, assertedOutAt: p.assertedOutAt, outLat: p.outLat, outLng: p.outLng, outAccuracyM: p.outAccuracyM ?? null, userId: p.userId || null }
      : {
          clientPunchId: p.id, jobId: p.jobId, userId: p.userId || null,
          assertedInAt: p.assertedInAt, assertedOutAt: p.assertedOutAt || null,
          inLat: p.inLat, inLng: p.inLng, inAccuracyM: p.inAccuracyM,
          outLat: p.outLat, outLng: p.outLng, outAccuracyM: p.outAccuracyM ?? null,
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
      // Refinements from adversarial review, and the replay order (CS-666):
      //   · a punch that has failed fewer than HOLD_THE_LINE_ATTEMPTS times HOLDS THE LINE:
      //     the pass stops and retries next cycle, because replaying the punches after it
      //     first is exactly the reorder that flags a clean or moves a clock-out;
      //   · once it has failed that often it stops holding the line — CONTINUE past it —
      //     so one punch that deterministically 500s (a poisoned payload) can't
      //     head-of-line-block every later punch forever;
      //   · a small circuit breaker: several transients in one pass means the
      //     backend/session is down — stop hammering, retry next cycle (60s /
      //     reconnect / foreground). Attempts are counted on the punch so a
      //     chronically transient one is visible in its record, but it is NEVER
      //     auto-failed — losing labor to a counter would recreate the bug.
      const transient = e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500;
      if (transient) {
        const attempts = (p.transientAttempts || 0) + 1;
        await updatePunch(p.id, { transientAttempts: attempts, lastTransientAt: nowIso(), lastError: e?.message || String(e) });
        transientSeen += 1;
        if (attempts < HOLD_THE_LINE_ATTEMPTS || transientSeen >= 3) break;
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

function stubClockIn({ jobId, lat, lng, accuracyM, offSiteReason, ctx = {} }) {
  const verdict = geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng, deviceLat: lat, deviceLng: lng,
    accuracyM, radiusM: ctx.radiusM ?? DEFAULT_GEOFENCE_RADIUS_M, enabled: ctx.geofenceEnabled !== false,
    // Which config switched the ring off (the site's, or this cleaner's — step 4b/R7), so a
    // demo punch records the same reason the deployed handler would.
    disabledReason: ctx.geofenceDisabledReason || undefined,
  });
  // PAY-17: the demo twin refuses nothing either — the verdict is recorded as it is.
  const db = loadStub();
  if (db.entries.some((e) => e.job_id === jobId && e.user_id === ctx.userId && e.status === 'in_progress')) {
    const err = new Error("You're already clocked in to this clean"); err.status = 409; err.code = 'already-clocked-in'; throw err;
  }
  // 🔴 PAY-13 / CS-318, the demo twin: still on the clock at ANOTHER clean → refused, naming
  // it. A manager (the punch bypass, which in the demo is the signed-in user's own role /
  // time.edit.all) may override, and the punch they open is FLAGGED instead.
  const openElsewhere = blockingOpenPunch(
    db.entries.filter((e) => e.user_id === ctx.userId && e.status === 'in_progress'), jobId,
  );
  let overlapFlag = null;
  if (openElsewhere) {
    if (!stubHasPunchBypass()) {
      const err = new Error(doublePunchMessage(openPunchLabel(openElsewhere)));
      err.status = 409; err.code = DOUBLE_PUNCH_CODE;
      // The same shape the deployed route answers with, so the screen names the clean in
      // the cleaner's language either way.
      err.payload = { code: DOUBLE_PUNCH_CODE, openCleanName: openPunchLabel(openElsewhere) };
      throw err;
    }
    overlapFlag = overlapFlagNote(openPunchLabel(openElsewhere));
  }
  const result = verdict.result;
  const entry = {
    id: rid('te'), job_id: jobId, series_id: ctx.seriesId || null, shift_id: ctx.shiftId || null,
    client_id: ctx.clientId || null, site_id: ctx.siteId || null, user_id: ctx.userId || null,
    client_name: ctx.clientName || null, site_name: ctx.siteName || null, user_name: ctx.userName || null,
    scheduled_start: ctx.scheduledStart || null, scheduled_end: ctx.scheduledEnd || null,
    expected_minutes_snapshot: Number.isFinite(ctx.expectedMins) ? ctx.expectedMins : null,
    clock_in_at: nowIso(), clock_out_at: null, duration_minutes: null,
    clock_in_lat: lat ?? null, clock_in_lng: lng ?? null, clock_in_accuracy_m: accuracyM ?? null,
    clock_in_distance_m: verdict.distanceM, geofence_result: result,
    // The CONFIG reason when the ring was off, else the cleaner's optional off-site note —
    // the same precedence the server applies (api/_lib/time/store.js clockIn).
    override_reason: result === 'override'
      ? (verdict.reason || 'override')
      : (isOffSiteVerdict(result) ? ((typeof offSiteReason === 'string' && offSiteReason.trim()) || null) : null),
    source: 'crew_mobile', status: 'in_progress', approval_status: 'pending', edit_history: [],
    row_version: 0, updated_at: nowIso(),
  };
  if (overlapFlag) {
    entry.note = `[overlap] ${overlapFlag}`;
    entry.edited = true;
    entry.edit_history = [{ at: nowIso(), byUserId: ctx.userId || null, field: 'created', from: null, to: 'overlapping punch', reason: overlapFlag }];
  }
  db.entries.push(entry); saveStub(db); return entry;
}

// The demo twin of the server's clock-out (`api/_lib/time/store.js clockOut`): the same
// scope rule, the same deleted-punch rule, and the same row_version / updated_at bump every
// other stub write makes — without it a demo clock-out left the version behind and the next
// manager write read as stale.
// PAY-12: the demo twin computes the clock-OUT verdict from the SAME `geofenceVerdict` and the
// SAME `clockOutGeofenceFields` writer the server uses, over the ctx the caller resolved from the
// store — so a demo punch records what a production punch would. `ctx` absent (a caller that has
// none) leaves the verdict unset rather than guessing, exactly as the server does for a punch
// with no clean.
// CS-051: answers { entry, jobDone } like the route — jobDone from the SAME rule the server asks
// (lib/jobStatus.jobDoneAfterPunches) over this clean's stub punches.
const stubJobDone = (db, jobId) => (jobId ? jobDoneAfterPunches(db.entries.filter((x) => x.job_id === jobId)) : false);
function stubClockOut({ entryId, lat, lng, accuracyM, ctx = null }) {
  // Someone else's punch goes through the SAME scope rule the server applies to the punch
  // bypass (W5-M F2): the office closes a punch only at a customer it supervises, exactly as
  // stubCorrect refuses the same manager. The cleaner's OWN punch is never scope-checked —
  // a cleaner supervises nothing, so asking would refuse every ordinary clock-out.
  const { user, scope } = stubActor();
  const db = loadStub();
  const e = db.entries.find((x) => x.id === entryId);
  if (!e) return { entry: null, jobDone: false };
  if (user && e.user_id && e.user_id !== user.id
    && !inTimeScope(scope, e.client_id ?? null)) throw stubRefusal('out-of-scope');
  if (e.clock_out_at) return { entry: e, jobDone: stubJobDone(db, e.job_id) };
  const out = nowIso();
  // A DELETED punch keeps its status and its approval (W5-M F3): the clock-out is recorded,
  // the deletion stands until a manager restores it, and the history says so.
  const voided = e.status === 'voided';
  if (voided) {
    const hist = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
    hist.push({ at: out, byUserId: user?.id || e.user_id || null, field: 'clock_out_at', from: null, to: out, reason: VOIDED_CLOCK_OUT_REASON });
    e.edited = true; e.edit_history = hist;
  }
  const outFields = ctx ? clockOutGeofenceFields(geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng, deviceLat: lat, deviceLng: lng,
    accuracyM, radiusM: ctx.radiusM ?? DEFAULT_GEOFENCE_RADIUS_M, enabled: ctx.geofenceEnabled !== false,
    disabledReason: ctx.geofenceDisabledReason || undefined,
  }), { accuracyM }) : {};
  Object.assign(e, {
    clock_out_at: out,
    duration_minutes: durationMins(e.clock_in_at, out),
    clock_out_lat: lat ?? null,
    clock_out_lng: lng ?? null,
    ...outFields,
    status: closedPunchStatus(e),
    row_version: versionOf(e) + 1,
    updated_at: out,
  });
  saveStub(db);
  return { entry: e, jobDone: stubJobDone(db, e.job_id) };
}

function stubManual({ jobId, userId, clockInAt, clockOutAt, note, reason, ctx = {} }) {
  // PAY-11: a manual add asserts times nobody clocked, so it names a reason too.
  if (reasonRefusal(reason)) throw stubRefusal('reason-required');
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
    note: note || null, edited: true, edit_history: [{ at: nowIso(), field: 'created', from: null, to: 'manual', reason: trimmedReason(reason) }],
    row_version: 0, updated_at: nowIso(),
  };
  db.entries.push(entry); saveStub(db); return entry;
}

// ── demo approval gating (runs the SAME timeRules the server runs, spec §7) ────
// The pay runs the demo has closed (W2-L seeds them; empty for W1-A → no lock).
export const RUNS_STUB_KEY = 'cleanspace_payroll_runs_stub_v1';
function stubRunBounds() {
  let runs = [];
  try { const r = JSON.parse(localStorage.getItem(RUNS_STUB_KEY)); runs = Array.isArray(r) ? r : (Array.isArray(r?.runs) ? r.runs : []); } catch { runs = []; }
  if (!runs.length) return { firstRun: null, latestRun: null };
  const sorted = runs.slice().sort((a, b) => String(a.period_key).localeCompare(String(b.period_key)));
  return { firstRun: sorted[0], latestRun: sorted[sorted.length - 1] };
}
// The demo's signed-in user + their scope, read from the live store (DEV-only window hook).
// If the store can't be read, scope is null (allow) — the owner-like default, never a lock-out.
function stubActor() {
  try {
    const s = (typeof window !== 'undefined' && typeof window.__ppGetState === 'function') ? window.__ppGetState() : null;
    if (!s) return { user: null, scope: null };
    const user = (s.users || []).find((u) => u.id === s.currentUserId) || null;
    return { user, scope: user ? timeScopeFor(user, s.clients || [], s.users || []) : null };
  } catch { return { user: null, scope: null }; }
}
// The demo twin of `api/time` punchBypass: owner / admin by role, or `time.edit.all` under
// the live matrix + overrides. It decides who may override the PAY-13 one-clean-at-a-time
// refusal. Unreadable store → NOT a bypass, so the demo enforces the rule rather than
// waving everyone through (the deployed handler's gate is the boundary either way).
function stubHasPunchBypass() {
  try {
    const s = (typeof window !== 'undefined' && typeof window.__ppGetState === 'function') ? window.__ppGetState() : null;
    if (!s) return false;
    const user = (s.users || []).find((u) => u.id === s.currentUserId) || null;
    if (!user) return false;
    if (user.role === 'owner' || user.role === 'admin') return true;
    return can(user, 'time.edit.all', s.permissions, s.userPermissionOverrides || []);
  } catch { return false; }
}

const STUB_STATUS = { 'out-of-scope': 403, 'own-entry': 403, stale: 409, 'paid-locked': 409, 'not-closed': 409, voided: 409 };
function stubRefusal(code) {
  const err = new Error(TIME_REFUSALS[code] || 'Invalid request');
  err.status = STUB_STATUS[code] || 400; err.code = code; return err;
}
// scope + own + (for correct/void/restore) the paid lock — the server's gatePunch.
function stubGate(e, { user, scope, firstRun, latestRun, checkLock }) {
  if (!inTimeScope(scope, e.client_id ?? null)) return 'out-of-scope';
  if (refusesOwn(user, e.user_id)) return 'own-entry';
  if (checkLock && isPaidLocked(e, latestRun, firstRun)) return 'paid-locked';
  return null;
}
const versionOf = (e) => (Number.isFinite(e.row_version) ? e.row_version : 0);

function stubApprove(items) {
  const { user, scope } = stubActor();
  const db = loadStub();
  const results = [];
  for (const it of items) {
    const e = db.entries.find((x) => x.id === it.entryId);
    if (!e) { results.push({ entryId: it.entryId, ok: false, code: 'not-found' }); continue; }
    if (!inTimeScope(scope, e.client_id ?? null)) { results.push({ entryId: it.entryId, ok: false, code: 'out-of-scope' }); continue; }
    if (refusesOwn(user, e.user_id)) { results.push({ entryId: it.entryId, ok: false, code: 'own-entry' }); continue; }
    if (!e.clock_out_at) { results.push({ entryId: it.entryId, ok: false, code: 'not-closed' }); continue; }
    if (e.status === 'voided' || e.status === 'no_show') { results.push({ entryId: it.entryId, ok: false, code: 'voided' }); continue; }
    if (e.approval_status === 'approved') { results.push({ entryId: it.entryId, ok: true, entry: e }); continue; }
    if (Number.isInteger(it.version) && it.version !== versionOf(e)) { results.push({ entryId: it.entryId, ok: false, code: 'stale' }); continue; }
    e.approval_status = 'approved'; e.approved_at = nowIso(); e.approved_by = user?.id || null;
    e.row_version = versionOf(e) + 1; e.updated_at = nowIso();
    results.push({ entryId: it.entryId, ok: true, entry: e });
  }
  saveStub(db);
  return results;
}

// ── demo OVERTIME approvals + the Approvals read (runs the SAME otLedger, spec §7) ────
// The manager-approved OT totals live in their OWN localStorage key (cleared by
// ?demo=reset, lib/demoBootstrap.js). Neutral shape ({ userId, weekKey, clientId,
// approvedOtMinutes, updatedAt }) — what computeWeekLedger reads.
export const OT_STUB_KEY = 'cleanspace_ot_approvals_stub_v1';
const loadOt = () => { try { const r = JSON.parse(localStorage.getItem(OT_STUB_KEY)); return Array.isArray(r) ? r : (Array.isArray(r?.approvals) ? r.approvals : []); } catch { return []; } };
const saveOt = (list) => { try { localStorage.setItem(OT_STUB_KEY, JSON.stringify(list)); } catch { /* quota */ } };
const ppGetState = () => { try { return (typeof window !== 'undefined' && typeof window.__ppGetState === 'function') ? window.__ppGetState() : null; } catch { return null; } };

function stubApproveOvertime(items) {
  const { user, scope } = stubActor();
  const list = loadOt();
  // CS-659, the demo twin: the unit's week is the ORG's workweek, judged by the same shared rule
  // as the route (lib/payroll isPayWeekKey) — never a Sunday-only check.
  const weekStartDay = payWeekStartDayOf(ppGetState()?.opsSettings);
  const results = [];
  for (const it of items) {
    const clientId = (it && it.clientId != null) ? String(it.clientId) : '';
    const key = `${it?.userId ?? ''}|${it?.weekKey ?? ''}|${clientId}`;
    if (!it || !it.userId || !isPayWeekKey(it.weekKey, weekStartDay)) { results.push({ key, ok: false, code: 'invalid-week' }); continue; }
    if (!inTimeScope(scope, clientId)) { results.push({ key, ok: false, code: 'out-of-scope' }); continue; }
    if (refusesOwn(user, it.userId)) { results.push({ key, ok: false, code: 'own-entry' }); continue; }
    const minutes = Math.max(0, Math.min(10080, Math.round(Number(it.minutes) || 0)));
    const now = nowIso();
    const existing = list.find((a) => a.userId === it.userId && a.weekKey === it.weekKey && (a.clientId || '') === clientId);
    if (existing) { existing.approvedOtMinutes = minutes; existing.approvedBy = user?.id || null; existing.approvedAt = now; existing.updatedAt = now; }
    else list.push({ userId: it.userId, weekKey: it.weekKey, clientId, approvedOtMinutes: minutes, approvedBy: user?.id || null, approvedAt: now, updatedAt: now });
    results.push({ key, ok: true, approvedMinutes: minutes });
  }
  saveOt(list);
  return results;
}

async function stubApprovals({ supervisorId, om = null } = {}) {
  const s = ppGetState();
  const users = Array.isArray(s?.users) ? s.users : [];
  const clients = Array.isArray(s?.clients) ? s.clients : [];
  const tz = s?.company?.timezone || undefined;   // lib/dates DEFAULT_ORG_TIMEZONE applies when unset
  const cadence = s?.opsSettings?.payPeriodCadence || 'biweekly';
  const weekStartDay = payWeekStartDayOf(s?.opsSettings);
  const usersById = new Map(users.map((u) => [u.id, u]));
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const isGatedId = (userId) => isGatedUser(usersById.get(userId));

  const { scope, user: actor } = stubActor();
  const unscoped = scope === null;
  let effClientIds = null;
  let includeNoCustomer = false;
  if (unscoped) {
    includeNoCustomer = true;
    if (supervisorId === 'none') effClientIds = new Set(clients.filter((c) => !c.supervisorId).map((c) => c.id));
    // `team` + `om` (S131 Wave 2): the route's rule — an owner or an admin names an OM's team.
    else if (supervisorId === TEAM) { effClientIds = teamClientIds(users, clients, teamLeadFor({ role: actor?.role, selfId: actor?.id, users, om })); includeNoCustomer = false; }
    else if (supervisorId) { effClientIds = new Set(clients.filter((c) => c.supervisorId === supervisorId).map((c) => c.id)); includeNoCustomer = false; }
  } else {
    effClientIds = scope;
    // An Operations Manager narrows to one member of their team, never beyond it (S131) — the
    // route's own rule (api/time approvals).
    if (supervisorId && supervisorId !== TEAM && actor && teamMemberIds(users, actor.id).includes(supervisorId)) {
      effClientIds = new Set([...scope].filter((id) => clientsById.get(id)?.supervisorId === supervisorId));
    }
  }
  const inEff = (clientId) => { const c = clientId || ''; if (c === '') return includeNoCustomer; if (effClientIds === null) return true; return effClientIds.has(c); };
  const scopedEmpty = !unscoped && effClientIds instanceof Set && effClientIds.size === 0;

  const { firstRun, latestRun } = stubRunBounds();
  const floorMs = firstRun?.from_iso ? Date.parse(firstRun.from_iso) : -Infinity;
  const entries = loadStub().entries;
  const otApprovals = loadOt();

  // Pending punches: closed, worked, pending, gated, in scope, not pre-ledger.
  let pendingRows = scopedEmpty ? [] : entries.filter((r) => isWorkedEntry(r)
    && r.approval_status === 'pending' && r.status !== 'voided' && r.status !== 'no_show'
    && Date.parse(r.clock_in_at) >= floorMs && isGatedId(r.user_id) && inEff(r.client_id));

  // Considered weeks — open territory ∪ changed (§6.2) ∪ held_ot ∪ pending weeks.
  const now = new Date();
  const openFromKey = (latestRun && latestRun.to_key) ? addDaysKey(latestRun.to_key, 1) : payPeriodRange(cadence, -1, now, tz, weekStartDay).fromKey;
  const considered = new Set();
  { let w = payWeekKeyOf(openFromKey, weekStartDay, tz); const end = payWeekKeyOf(now, weekStartDay, tz); for (let i = 0; w <= end && i < 520; i += 1) { considered.add(w); w = addDaysKey(w, 7); } }
  if (firstRun && latestRun && latestRun.closed_at) {
    const threshold = Date.parse(latestRun.closed_at) - 3600e3;
    const terrFrom = Date.parse(firstRun.from_iso); const terrTo = Date.parse(latestRun.to_iso);
    for (const e of entries) {
      const ci = Date.parse(e.clock_in_at); const up = Date.parse(e.updated_at);
      if (Number.isFinite(ci) && ci >= terrFrom && ci <= terrTo && Number.isFinite(up) && up > threshold) considered.add(payWeekKeyOf(e.clock_in_at, weekStartDay, tz));
    }
    for (const a of otApprovals) {
      const up = Date.parse(a.updatedAt); const weekEnd = addDaysKey(a.weekKey, 6);
      if (Number.isFinite(up) && up > threshold && a.weekKey <= latestRun.to_key && weekEnd >= firstRun.from_key) considered.add(a.weekKey);
    }
  }
  for (const h of Array.isArray(latestRun?.held_ot) ? latestRun.held_ot : []) if (h?.weekKey) considered.add(h.weekKey);
  for (const r of pendingRows) considered.add(payWeekKeyOf(r.clock_in_at, weekStartDay, tz));

  // Ledger over the considered-weeks span.
  let items = [];
  let otUnits = [];
  if (!scopedEmpty && considered.size) {
    const weekKeys = [...considered].sort();
    const spanFrom = startOfDayKey(weekKeys[0], tz).getTime();
    const spanTo = startOfDayKey(addDaysKey(weekKeys[weekKeys.length - 1], 7), tz).getTime() - 1;
    const spanEntries = entries.filter((e) => { const t = Date.parse(e.clock_in_at); return Number.isFinite(t) && t >= spanFrom && t <= spanTo; });
    // Paid drive legs from the demo drive stub (same localStorage ledger); labor-only if it's unavailable.
    let legs = [];
    try {
      const drive = await import('./driveApi');
      const r = await drive.report({ fromIso: new Date(spanFrom).toISOString(), toIso: new Date(spanTo).toISOString(), filters: {}, payroll: true, config: s?.opsSettings, sites: s?.sites });
      legs = Array.isArray(r?.rows) ? r.rows : [];
    } catch { /* labor-only */ }
    const led = computeWeekLedger({ entries: spanEntries.map(mapRollupRow), driveSegments: legs, otApprovals, tz, weekStartDay });
    items = led.items;
    otUnits = led.otUnits.filter((u) => considered.has(u.weekKey));
  }

  const otByEntry = entryOtMinutes(items);
  const pending = pendingRows.map((r) => ({ ...r, ot_minutes: otByEntry.get(r.id) || 0 }));
  const overtime = overtimeUnitsForApproval(otUnits, { usersById, clientsById, inScope: inEff, isGated: isGatedId });

  return {
    scope: { unscoped, clientIds: unscoped ? null : [...(effClientIds || [])] },
    pending,
    overtime,
    ledger: { firstFromKey: firstRun?.from_key || null, latestToKey: latestRun?.to_key || null, latestClosedAt: latestRun?.closed_at || null },
    asOf: nowIso(),
  };
}

function stubFindGate({ entryId, checkLock = true }) {
  const { user, scope } = stubActor();
  const { firstRun, latestRun } = stubRunBounds();
  const db = loadStub();
  const e = db.entries.find((x) => x.id === entryId);
  if (!e) { const err = new Error('Time entry not found'); err.status = 404; throw err; }
  const refusal = stubGate(e, { user, scope, firstRun, latestRun, checkLock });
  if (refusal) throw stubRefusal(refusal);
  return { db, e, user };
}

function stubCorrect({ entryId, version, patch, reason }) {
  // PAY-11: a manager's edit always names a reason (the shared rule the route runs).
  if (reasonRefusal(reason)) throw stubRefusal('reason-required');
  const { db, e } = stubFindGate({ entryId });
  const newIn = patch.clock_in_at !== undefined ? patch.clock_in_at : e.clock_in_at;
  const newOut = ('clock_out_at' in patch) ? patch.clock_out_at : e.clock_out_at;
  const vcode = validatePunchTimes({ clockInAt: newIn, clockOutAt: newOut, now: Date.now(), requireOut: !!e.clock_out_at });
  if (vcode) throw stubRefusal(vcode);
  if (Number.isInteger(version) && version !== versionOf(e)) throw stubRefusal('stale');
  // CS-694, the demo twin of correctEntryRow: what the patch CHANGES, times compared as instants
  // (lib/timeRules correctionChanges); nothing changed → nothing written.
  const { changes, timeChanged } = correctionChanges(e, patch);
  if (!Object.keys(changes).length) return e;
  const origOut = e.clock_out_at; const origApproval = e.approval_status;
  const hist = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
  for (const [field, to] of Object.entries(changes)) {
    hist.push({ at: nowIso(), field, from: e[field] ?? null, to, reason: reason || null });
    e[field] = to;
  }
  if (timeChanged) e.duration_minutes = durationMins(e.clock_in_at, e.clock_out_at);
  if (!origOut && e.clock_out_at) e.status = closedPunchStatus(e);
  if (timeChanged && (origApproval === 'approved' || origApproval === 'rejected')) {
    e.approval_status = 'pending'; e.approved_by = null; e.approved_at = null;
    hist.push({ at: nowIso(), field: 'approval', from: origApproval, to: 'pending', reason: 'times changed' });
  }
  e.edited = true; e.edit_history = hist; e.row_version = versionOf(e) + 1; e.updated_at = nowIso();
  saveStub(db); return e;
}

function stubVoid({ entryId, version, reason }) {
  if (reasonRefusal(reason)) throw stubRefusal('reason-required');
  const { db, e } = stubFindGate({ entryId });
  if (Number.isInteger(version) && version !== versionOf(e)) throw stubRefusal('stale');
  const hist = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
  hist.push({ at: nowIso(), field: 'status', from: e.status ?? null, to: 'voided', reason: String(reason).trim() });
  e.status = 'voided'; e.approval_status = 'pending'; e.approved_by = null; e.approved_at = null;
  e.edited = true; e.edit_history = hist; e.row_version = versionOf(e) + 1; e.updated_at = nowIso();
  saveStub(db); return e;
}

function stubRestore({ entryId, version, reason }) {
  const { db, e } = stubFindGate({ entryId });
  if (Number.isInteger(version) && version !== versionOf(e)) throw stubRefusal('stale');
  const hist = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
  let prior = null;
  for (let i = hist.length - 1; i >= 0; i -= 1) { if (hist[i] && hist[i].field === 'status' && hist[i].to === 'voided') { prior = hist[i].from; break; } }
  // A punch voided while OPEN and clocked out afterwards (W5-M F3) records 'in_progress' as
  // its prior status but now HAS a clock-out. It comes back completed — an in_progress row
  // carrying a clock-out would sit forever in Missing time and never pay.
  let status = prior || (e.clock_out_at ? 'completed' : 'in_progress');
  if (status === 'in_progress' && e.clock_out_at) status = 'completed';
  hist.push({ at: nowIso(), field: 'status', from: e.status ?? null, to: status, reason: reason || 'restored' });
  e.status = status; e.edited = true; e.edit_history = hist; e.row_version = versionOf(e) + 1; e.updated_at = nowIso();
  saveStub(db); return e;
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
