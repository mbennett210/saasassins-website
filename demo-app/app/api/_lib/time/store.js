// Service-role data layer for time_entries — the per-cleaner labor ledger and the
// substrate for the Variance report. The browser NEVER touches this table; only
// app/api/time/* does. RLS is on with no policies (service-role bypass), and
// organization_id is pinned to CLEANSPACE_ORG_ID. Names are denormalized at write so
// reports render without rehydrating the blob. See CLEANSPACE_SWEPT.md §4.1 / §5.4.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readOrgState } from '../orgState.js';
import { getJobById } from '../jobsTable.js';
import { geofenceVerdict } from '../../../src/lib/geo.js';
import { CLOCK_RULE_KEYS, GEOFENCE_OFF_REASON, isClockRuleOff } from '../../../src/lib/clockRules.js';
import { isUserJobCrew } from '../../../src/lib/crewResolve.js';
import { rangeFill, selectAll, exactCount } from '../pagedSelect.js';
import {
  checklistGateFor, checklistBlocks, checklistUnknown, checklistFlagNote,
  CHECKLIST_UNKNOWN_NOTE, CHECKLIST_GATE_UNKNOWN,
} from './checklistGate.js';

const TABLE = 'time_entries';
const nowIso = () => new Date().toISOString();

function durationMins(inAt, outAt) {
  if (!inAt || !outAt) return null;
  const ms = new Date(outAt).getTime() - new Date(inAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

// Resolve a time-entry row by its uuid id, OR by client_punch_id when the caller
// passes a synth 'op_*' punch id — a clock-out issued in the brief window after a
// buffered clock-in replayed to a real row but before the UI refetched the real id.
// (id is a uuid column, so querying it with an 'op_*' value would 22P02; we skip
// straight to the client_punch_id lookup in that case.)
async function resolveEntry(db, entryId) {
  if (!String(entryId).startsWith('op_')) {
    const { data, error } = await db.from(TABLE).select('*').eq('id', entryId).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  const { data, error } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_punch_id', entryId).maybeSingle();
  if (error) throw error;
  return data || null;
}

// Resolve the blob context for a clean at clock-in: denormalized names, the
// point-in-time expected baseline (shift → site → client → null), and the
// geofence center + radius. Read server-side so the client can't spoof any of it.
export async function resolveJobContext(jobId, userId) {
  const { state } = await readOrgState();
  const sites = Array.isArray(state?.sites) ? state.sites : [];
  const clients = Array.isArray(state?.clients) ? state.clients : [];
  const users = Array.isArray(state?.users) ? state.users : [];

  // Jobs live per-row in public.jobs (B1); the blob's `jobs` is written empty by every
  // client save, so the job MUST come from the table — not state.jobs (always []).
  const job = await getJobById(jobId);
  const site = job?.siteId ? sites.find((s) => s.id === job.siteId) || null : null;
  const clientId = job?.clientId || site?.clientId || null;
  const client = clientId ? clients.find((c) => c.id === clientId) || null : null;
  const user = users.find((u) => u.id === userId) || null;
  const shift = (job?.shiftId && Array.isArray(site?.shifts))
    ? site.shifts.find((sh) => sh.id === job.shiftId) || null : null;

  let expectedMins = null;
  if (shift && typeof shift.expectedCleanMins === 'number') expectedMins = shift.expectedCleanMins;
  else if (typeof site?.expectedCleanMins === 'number') expectedMins = site.expectedCleanMins;
  else if (typeof client?.expectedCleanMins === 'number') expectedMins = client.expectedCleanMins;

  const radiusM = (shift && Number.isFinite(shift.geofenceRadiusM)) ? shift.geofenceRadiusM
    : Number.isFinite(site?.geofenceRadiusM) ? site.geofenceRadiusM
      : (state?.opsSettings?.defaultGeofenceRadiusM ?? 150);

  // The geofence is off when the SITE turns it off, or when the office turned it off for
  // THIS CLEANER (`user.clockRules.geofenceOff`, checklists step 4b / R7 — the cleaner an
  // account manager hasn't trained on the app yet). Read from the roster server-side, like
  // every other fact here, so a device can't claim its own exemption. The reason rides along
  // so the punch records WHICH rule skipped the ring; the per-cleaner one wins when both
  // apply, because that is the rule the office set on a PERSON and every punch of theirs
  // then reads the same way wherever they work.
  const geofenceOffForUser = isClockRuleOff(user, CLOCK_RULE_KEYS.geofence);
  const siteGeofenceOff = site?.geofenceEnabled === false;
  return {
    state, job, site, client, user, expectedMins, radiusM,
    clientId,
    siteLat: Number.isFinite(site?.lat) ? site.lat : null,
    siteLng: Number.isFinite(site?.lng) ? site.lng : null,
    geofenceEnabled: !siteGeofenceOff && !geofenceOffForUser, // default ON; either switch disables the gate
    geofenceDisabledReason: geofenceOffForUser ? GEOFENCE_OFF_REASON : (siteGeofenceOff ? 'geofence_disabled' : null),
    siteName: site?.name ?? null,
    clientName: client?.name ?? null,
    userName: user?.name ?? null,
  };
}

// Is this crew user assigned to the job (server-checked)? THE payroll/access
// boundary — the open RLS means this is the real gate. Delegates to the SAME
// shared isUserJobCrew the client uses (lib/crewResolve.js): since crew became
// named-only (008f5f2, standing/regular crew and crewExcludedIds retired) a crew
// member is assigned iff they are on the job's crewIds. The punch bypass skips it
// (hasPunchBypass below: owner / admin by role, or time.edit.all under the committed
// matrix + overrides, which the 4th-tier manager holds by default; api/time punchBypass).
// One rule, imported on both sides, so the client's My Day and this gate can never
// disagree again (Sept 2 incident). crewIds is PROTECTED in jobsGuard, so crew can't
// self-assign: only owner / admin or a manager holding schedule.edit changes a crew.
export function isAssignedToJob(job, userId, { client = null, site = null } = {}) {
  return isUserJobCrew(job, userId, { site, client });
}

// `isManager` is the punch bypass: clock in to a clean you are not on, clock out someone
// else's punch. A boolean, or a function (possibly async) asked only when the caller
// isn't on the clean / isn't the punch's owner, so an ordinary punch never pays for the
// check (api/time punchBypass reads the permission matrix).
async function hasPunchBypass(isManager) {
  return typeof isManager === 'function' ? (await isManager()) === true : isManager === true;
}

// (Removed in Increment 1c: `blobUserByEmail` mapped an auth email to a `u_*` id
// through the browser-writable org_state roster, so a crew user could rewrite
// the roster to inherit someone else's identity for labor/QC writes. Identity
// now comes from the service-role-only JWT claim — see authz.resolveAuthority.)

// Crew clock-in with the SERVER-AUTHORITATIVE geofence. Returns one of:
//   { blocked, verdict }  -> outside the ring, no override (route → 403)
//   { duplicate: true }   -> already clocked in to this clean (DB unique index)
//   { entry }             -> the created row
export async function clockIn({ jobId, userId, isManager = false, deviceLat, deviceLng, accuracyM, override, overrideReason, source = 'crew_mobile', clientPunchId = null }) {
  const ctx = await resolveJobContext(jobId, userId);
  if (!ctx.job) return { notFound: true };
  // Server-side authorization: a crew member can only clock into a clean they're
  // assigned to (the open RLS means UI gating is not a boundary). The punch bypass
  // (owner/admin, or time.edit.all) skips it.
  if (!isAssignedToJob(ctx.job, userId, { client: ctx.client, site: ctx.site }) && !(await hasPunchBypass(isManager))) return { forbidden: true };

  const verdict = geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng,
    deviceLat: Number.isFinite(deviceLat) ? deviceLat : null,
    deviceLng: Number.isFinite(deviceLng) ? deviceLng : null,
    accuracyM, radiusM: ctx.radiusM, enabled: ctx.geofenceEnabled,
    disabledReason: ctx.geofenceDisabledReason,
  });
  if (verdict.result === 'outside' && !override) return { blocked: true, verdict, ctx };

  const result = (verdict.result === 'outside' && override) ? 'override' : verdict.result;
  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    job_id: ctx.job.id,
    series_id: ctx.job.seriesId || null,
    shift_id: ctx.job.shiftId || null,
    client_id: ctx.clientId,
    site_id: ctx.job.siteId || null,
    user_id: userId,
    client_name: ctx.clientName,
    site_name: ctx.siteName,
    user_name: ctx.userName,
    scheduled_start: ctx.job.startAt || null,
    scheduled_end: ctx.job.endAt || null,
    expected_minutes_snapshot: ctx.expectedMins,
    clock_in_at: nowIso(),
    clock_in_lat: Number.isFinite(deviceLat) ? deviceLat : null,
    clock_in_lng: Number.isFinite(deviceLng) ? deviceLng : null,
    clock_in_accuracy_m: Number.isFinite(accuracyM) ? accuracyM : null,
    clock_in_distance_m: verdict.distanceM,
    geofence_result: result,
    // The VERDICT's reason wins over the caller's. The verdict only carries one when the ring
    // was off by CONFIG ('geofence_disabled', or geofence_off_for_cleaner) — a server-side
    // fact — while `overrideReason` is a client claim, meaningful only for an 'outside'
    // override, where the verdict carries none. Before 2026-09-27 the body's value won, so a
    // request claiming crew_override_offsite could erase the record of which rule skipped the
    // ring.
    override_reason: (result === 'override') ? (verdict.reason || overrideReason || null) : null,
    override_by_user_id: (verdict.result === 'outside' && override) ? userId : null,
    source,
    status: 'in_progress',
    // Shared idempotency key: the client mints this BEFORE the online clock-in and
    // reuses it if the request has to be buffered + replayed after a lost ACK — so a
    // committed row and its buffered twin collide on time_entries_client_punch_uidx
    // instead of double-paying. Null only for legacy callers that don't send one.
    client_punch_id: clientPunchId || null,
  };

  const db = getSupabase();
  const { data, error } = await db.from(TABLE).insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') {
      // Either the one-open-per-(user,job) index, or the client_punch_id uniq when a
      // buffered replay of THIS same clock-in already landed — both mean "already
      // recorded". Return the existing row for the punch id when we can find it.
      if (clientPunchId) {
        const { data: dup } = await db.from(TABLE).select('*')
          .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_punch_id', clientPunchId).maybeSingle();
        if (dup) return { entry: dup, idempotent: true };
      }
      return { duplicate: true };
    }
    throw error;
  }
  return { entry: data };
}

// The clock-out checklist gate (R4-R6), for the ENTRY OWNER. Resolves the clean's blob
// context the same way clock-in does (names, client, the roster row's clockRules) and hands
// it to the shared rule. Used twice: to REFUSE a live clock-out, and to FLAG a replayed one.
async function checklistGateForEntry({ jobId, userId, ctx = null }) {
  if (!jobId || !userId) return { state: 'none', done: 0, total: 0 };
  try {
    const c = ctx || await resolveJobContext(jobId, userId);
    return await checklistGateFor({ ctx: c, userId, jobId });
  } catch (e) {
    // The gate could not be EVALUATED: the blob, the job row or checklist_results was
    // unreadable. Never let that decide, and never let the provider's text out — the code
    // only (3.4.12). The callers differ deliberately: a live clock-out fails closed with a
    // retryable 503, a replay is accepted and flagged.
    console.error('[time/checklist-gate]', e?.code || 'read_failed');
    return CHECKLIST_GATE_UNKNOWN;
  }
}

// The note a REPLAYED clock-out carries: the unfinished progress, or — when the gate could
// not be read at all — that it is unknown. NEVER a refusal (THE LAW II.8: the work already
// happened and the punch is its only record). null when the checklist was finished, when
// there is none, or when the office turned the block off for that cleaner.
async function checklistReplayFlag({ jobId, userId, ctx = null }) {
  const gate = await checklistGateForEntry({ jobId, userId, ctx });
  if (checklistUnknown(gate)) return CHECKLIST_UNKNOWN_NOTE;
  return checklistBlocks(gate) ? checklistFlagNote(gate.done, gate.total) : null;
}

// Clock-out (NO geofence gate, per requirements). Only the entry's owner or the punch bypass.
// entryId is normally a time_entries.id (uuid). It can also be a client punch id
// ('op_*') when the crew clock out in the brief window after a buffered clock-in was
// replayed to a real row but before the UI refetched the real id — resolve that by
// client_punch_id so the clock-out still lands (never a 404 / lost clock-out).
//
// 🔴 THE CHECKLIST BLOCK (R4): a cleaner cannot clock THEMSELVES out of a clean until the
// checklist assigned to them there is finished. It applies to every role on their OWN
// entry (plan §6) and NEVER to the punch bypass — the office closing someone else's punch
// is the documented escape hatch (R5), as are time/correct, time/manual and the auto-close
// cron, none of which come through here. Returns { checklistIncomplete, done, total } for
// the route to answer 409.
export async function clockOut({ entryId, userId, isManager, deviceLat, deviceLng }) {
  const db = getSupabase();
  const existing = await resolveEntry(db, entryId);
  if (!existing) return { notFound: true };
  if (existing.user_id !== userId && !(await hasPunchBypass(isManager))) return { forbidden: true };
  if (existing.clock_out_at) return { alreadyOut: true, entry: existing };

  if (existing.user_id === userId) {
    const gate = await checklistGateForEntry({ jobId: existing.job_id, userId: existing.user_id });
    // Unreadable is not "finished": fail CLOSED, but as a distinct RETRYABLE answer so the
    // crew are told to try again rather than accused of an unfinished checklist.
    if (checklistUnknown(gate)) return { checklistCheckFailed: true };
    if (checklistBlocks(gate)) return { checklistIncomplete: true, done: gate.done, total: gate.total };
  }

  const out = nowIso();
  const update = {
    clock_out_at: out,
    duration_minutes: durationMins(existing.clock_in_at, out),
    clock_out_lat: Number.isFinite(deviceLat) ? deviceLat : null,
    clock_out_lng: Number.isFinite(deviceLng) ? deviceLng : null,
    status: 'completed',
    updated_at: out,
  };
  // Someone else's punch, closed through the punch bypass: leave the trail a correction
  // leaves (who, when, which field), so the record shows it wasn't the cleaner's own
  // clock-out. The replayed clock-out records its history the same way.
  if (existing.user_id !== userId) {
    const history = Array.isArray(existing.edit_history) ? existing.edit_history.slice() : [];
    history.push({ at: out, byUserId: userId, field: 'clock_out_at', from: null, to: out, reason: 'clocked out by another team member' });
    Object.assign(update, { edited: true, edited_by: userId, edit_history: history });
  }
  const { data, error } = await db.from(TABLE).update(update).eq('id', existing.id).select('*').single();
  if (error) throw error;
  return { entry: data };
}

// Replay a buffered OFFLINE punch (CLEANSPACE_SWEPT.md §5.4). The device buffered the
// clock event while Supabase/network was down and replays it on reconnect. Safety
// rules baked in here (the client is never trusted):
//   • IDEMPOTENT on client_punch_id — a retried/duplicated replay returns the
//     existing row, never a second labor row (the DB partial-unique is the backstop).
//   • The device-asserted event time is accepted ONLY within a tight window
//     (opsSettings.offlineReplayWindowHours, default 12h, + a small future skew);
//     outside it we fall back to the server clock and flag the row for review, so a
//     stale/forged asserted time can't silently backdate payroll.
//   • The geofence is RE-RUN server-side on the buffered coords — the stored
//     geofence_result is the server's verdict, not any client claim. Unlike a live
//     clock-in this NEVER blocks (the work already happened); an outside verdict is
//     recorded + flagged for the manager instead.
//   • source='offline_replay' and approval_status stays 'pending' so nothing reaches
//     the payroll export (approvedOnly) until a manager signs it off.
// Handles two shapes: a clock-IN (optionally carrying a clock-OUT captured offline
// too → one completed row) via jobId; or a clock-OUT of an already-synced entry via
// entryId.
export async function replayPunch({
  clientPunchId, userId, assertedUserId = null, isManager = false,
  jobId = null, entryId = null,
  assertedInAt = null, assertedOutAt = null,
  inLat, inLng, inAccuracyM, outLat, outLng,
  windowHours = 12,
}) {
  if (!clientPunchId) return { badRequest: 'clientPunchId is required' };
  if (!jobId && !entryId) return { badRequest: 'jobId or entryId is required' };
  // Never re-attribute a buffered punch. The row is stamped with the token-resolved
  // user, so refuse a punch whose device-recorded owner differs — the shared-device
  // case where user A's session lapsed and user B is now signed in. (The client also
  // filters these out before sending; this is the server-side backstop.)
  if (assertedUserId && assertedUserId !== userId) return { forbidden: true, identityMismatch: true };
  const db = getSupabase();

  const now = Date.now();
  const SKEW_MS = 5 * 60 * 1000;                       // tolerate minor device-clock drift into the future
  const windowMs = Math.max(1, windowHours) * 3600 * 1000;
  const inWindow = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t <= now + SKEW_MS && t >= now - windowMs;
  };

  // Apply a buffered clock-out to an already-OPEN row. Shared by the entryId path and
  // the idempotency reconcile (a clock-out folded into a clock-in that a lost-ACK
  // online request had already committed). Windowed + flagged like every replay.
  async function applyReplayClockOut(existing) {
    const outAccepted = inWindow(assertedOutAt);
    const outAt = outAccepted ? assertedOutAt : nowIso();   // out of window → server clock, flagged
    // R4 off-line half: the punch is ACCEPTED whatever the checklist says, and the
    // unfinished checklist rides along as a flag so it shows at approval.
    const clFlag = await checklistReplayFlag({ jobId: existing.job_id, userId: existing.user_id });
    const windowReason = outAccepted
      ? 'offline clock-out replay'
      : `offline clock-out asserted ${assertedOutAt} outside ${windowHours}h window — server-stamped`;
    const history = Array.isArray(existing.edit_history) ? existing.edit_history.slice() : [];
    history.push({ at: nowIso(), byUserId: userId, field: 'clock_out_at', from: null, to: outAt,
      reason: clFlag ? `${windowReason}; ${clFlag}` : windowReason });
    const update = {
      clock_out_at: outAt,
      duration_minutes: durationMins(existing.clock_in_at, outAt),
      clock_out_lat: Number.isFinite(outLat) ? outLat : null,
      clock_out_lng: Number.isFinite(outLng) ? outLng : null,
      status: 'completed',
      client_asserted_out_at: assertedOutAt || null,
      approval_status: 'pending',                            // offline-touched → manager review
      edited: true,
      edit_history: history,
      updated_at: nowIso(),
    };
    // Append to the row's existing offline flags note, never replace it.
    if (clFlag) update.note = existing.note ? `${existing.note}; ${clFlag}` : `[offline] ${clFlag}`;
    const { data, error } = await db.from(TABLE).update(update).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return { entry: data, outsideWindow: !outAccepted };
  }

  // Idempotency: a retried replay (flaky reconnect) must never create a 2nd row. It
  // ALSO matches a row committed by a lost-ACK ONLINE clock-in that reused this same
  // client_punch_id. If a clock-out was folded into the punch AFTER that open row was
  // created, apply it here instead of returning the row stale-open.
  {
    const { data: prior, error } = await db.from(TABLE).select('*')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_punch_id', clientPunchId).maybeSingle();
    if (error) throw error;
    if (prior) {
      if (assertedOutAt && !prior.clock_out_at) {
        if (prior.user_id !== userId && !(await hasPunchBypass(isManager))) return { forbidden: true };
        return { ...(await applyReplayClockOut(prior)), idempotent: true };
      }
      // Prior already closed (e.g. auto-close ran first) but the punch asserts a
      // different offline out-time — record it in the audit trail for a manager
      // rather than silently dropping the crew's real clock-out.
      if (assertedOutAt && prior.clock_out_at && prior.clock_out_at !== assertedOutAt) {
        const history = Array.isArray(prior.edit_history) ? prior.edit_history.slice() : [];
        history.push({ at: nowIso(), byUserId: userId, field: 'offline_clock_out_arrived', from: prior.clock_out_at, to: assertedOutAt, reason: 'buffered offline clock-out arrived after the row was already closed' });
        const { data, error } = await db.from(TABLE).update({ edit_history: history, updated_at: nowIso() }).eq('id', prior.id).select('*').single();
        if (error) throw error;
        return { entry: data, idempotent: true, alreadyOut: true };
      }
      return { entry: prior, idempotent: true };
    }
  }

  // ── clock-OUT of an already-synced entry (crew clocked in online, then went
  //    offline before clocking out) ─────────────────────────────────────────────
  if (entryId && !jobId) {
    const existing = await resolveEntry(db, entryId); // handles uuid OR a synth op_* id
    if (!existing) return { notFound: true };
    if (existing.user_id !== userId && !(await hasPunchBypass(isManager))) return { forbidden: true };
    if (existing.clock_out_at) {
      // Already closed (e.g. the auto-close cron ran first). Never overwrite a
      // recorded time; log the arriving asserted out-time for a manager to reconcile.
      const history = Array.isArray(existing.edit_history) ? existing.edit_history.slice() : [];
      history.push({ at: nowIso(), byUserId: userId, field: 'offline_clock_out_arrived', from: existing.clock_out_at, to: assertedOutAt || null, reason: 'buffered offline clock-out arrived after the entry was already closed' });
      const { data, error } = await db.from(TABLE).update({ edit_history: history, updated_at: nowIso() }).eq('id', entryId).select('*').single();
      if (error) throw error;
      return { entry: data, alreadyOut: true };
    }
    return applyReplayClockOut(existing);
  }

  // ── clock-IN (optionally with a clock-OUT captured offline in the same buffer) ──
  const ctx = await resolveJobContext(jobId, userId);
  if (!ctx.job) return { notFound: true };
  if (!isAssignedToJob(ctx.job, userId, { client: ctx.client, site: ctx.site }) && !(await hasPunchBypass(isManager))) return { forbidden: true };

  // 🔴 RECONCILE AGAINST AN EXISTING OPEN ROW *BEFORE* INSERTING (Sept 1). A
  // different open row for this (user, job) — a lost-ACK online clock-in that
  // minted its own punch id, or a manager-opened entry — used to surface only as
  // a 23505 from the one-open partial index, and the bare {duplicate} response
  // made the client delete the punch: the crew's REAL times evaporated while the
  // stale open row waited for schedule-capped auto-close. Worse, the 23505 path
  // was UNREACHABLE for punches carrying a clock-out (they insert 'completed',
  // which the in_progress-only partial index never conflicts with), so a
  // completed replay would silently DOUBLE-insert alongside the open row.
  // Pre-insert: if an open row exists, that row IS this clean's clock-in —
  // apply the buffered clock-out to it, or return it for an in-only replay.
  {
    const { data: openRow, error: openErr } = await db.from(TABLE).select('*')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('user_id', userId).eq('job_id', jobId)
      .is('clock_out_at', null).limit(1).maybeSingle();
    if (openErr) throw openErr;
    if (openRow) {
      if (assertedOutAt) return { ...(await applyReplayClockOut(openRow)), recoveredOpenRow: true };
      // In-only replay resolving to the open row: leave an audit trace of the
      // asserted in-time when it differs (every other reconcile path does), so
      // a manager reviewing hours can see the device's claim.
      if (assertedInAt && openRow.clock_in_at !== assertedInAt) {
        const history = Array.isArray(openRow.edit_history) ? openRow.edit_history.slice() : [];
        history.push({ at: nowIso(), byUserId: userId, field: 'offline_clock_in_arrived', from: openRow.clock_in_at, to: assertedInAt, reason: 'buffered offline clock-in arrived for an already-open entry' });
        const { data, error } = await db.from(TABLE).update({ edit_history: history, updated_at: nowIso() }).eq('id', openRow.id).select('*').single();
        if (!error && data) return { entry: data, idempotent: true };
      }
      return { entry: openRow, idempotent: true };
    }
  }

  // Re-run the geofence SERVER-SIDE on the buffered coords — never trust a client
  // verdict. Offline replay records the verdict + flags; it does NOT block.
  const verdict = geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng,
    deviceLat: Number.isFinite(inLat) ? inLat : null,
    deviceLng: Number.isFinite(inLng) ? inLng : null,
    accuracyM: inAccuracyM, radiusM: ctx.radiusM, enabled: ctx.geofenceEnabled,
    disabledReason: ctx.geofenceDisabledReason,
  });

  const inAccepted = inWindow(assertedInAt);
  const inAt = inAccepted ? assertedInAt : nowIso();
  const hasOut = !!assertedOutAt;
  const outAccepted = hasOut && inWindow(assertedOutAt);
  const outAt = hasOut ? (outAccepted ? assertedOutAt : nowIso()) : null;

  const flags = [];
  if (!inAccepted) flags.push(`clock-in time asserted ${assertedInAt} outside the ${windowHours}h replay window — server-stamped instead`);
  if (hasOut && !outAccepted) flags.push(`clock-out time asserted ${assertedOutAt} outside the replay window — server-stamped instead`);
  if (verdict.result === 'outside') flags.push(`offline geofence re-check: ${verdict.distanceM}m from site (allowed ${verdict.allowedM}m)`);
  // R4 off-line half, the buffered clock-IN-with-its-clock-OUT shape: accepted, flagged.
  // Only a punch that CLOSES a clean can carry it — a clock-in alone is not a clock-out.
  if (hasOut) {
    const clFlag = await checklistReplayFlag({ jobId: ctx.job.id, userId, ctx });
    if (clFlag) flags.push(clFlag);
  }

  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    job_id: ctx.job.id,
    series_id: ctx.job.seriesId || null,
    shift_id: ctx.job.shiftId || null,
    client_id: ctx.clientId,
    site_id: ctx.job.siteId || null,
    user_id: userId,
    client_name: ctx.clientName,
    site_name: ctx.siteName,
    user_name: ctx.userName,
    scheduled_start: ctx.job.startAt || null,
    scheduled_end: ctx.job.endAt || null,
    expected_minutes_snapshot: ctx.expectedMins,
    clock_in_at: inAt,
    clock_out_at: outAt,
    duration_minutes: durationMins(inAt, outAt),
    clock_in_lat: Number.isFinite(inLat) ? inLat : null,
    clock_in_lng: Number.isFinite(inLng) ? inLng : null,
    clock_in_accuracy_m: Number.isFinite(inAccuracyM) ? inAccuracyM : null,
    clock_in_distance_m: verdict.distanceM,
    clock_out_lat: Number.isFinite(outLat) ? outLat : null,
    clock_out_lng: Number.isFinite(outLng) ? outLng : null,
    geofence_result: verdict.result,          // server-authoritative re-check
    // A replay's verdict is 'override' only when the ring was off by CONFIG (the site's
    // switch, or off for this cleaner), so carry that reason — the manager reviewing the
    // pending row needs to know WHY the ring wasn't checked. It was hardcoded null, which
    // left a config-skipped replay indistinguishable from a manual override.
    override_reason: verdict.result === 'override' ? (verdict.reason || null) : null,
    override_by_user_id: null,
    source: 'offline_replay',
    status: outAt ? 'completed' : 'in_progress',
    client_punch_id: clientPunchId,
    client_asserted_at: assertedInAt || null,
    client_asserted_out_at: assertedOutAt || null,
    approval_status: 'pending',               // never auto-paid; manager signs off
    note: flags.length ? `[offline] ${flags.join('; ')}` : null,
    edited: flags.length > 0,
    edit_history: [{ at: nowIso(), byUserId: userId, field: 'created', from: null, to: 'offline_replay',
      reason: flags.length ? flags.join('; ') : 'offline replay' }],
  };

  const { data, error } = await db.from(TABLE).insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') {
      // Concurrent replay won the race (client_punch_id uniq) OR one-open-per-user-job.
      const { data: dup } = await db.from(TABLE).select('*')
        .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_punch_id', clientPunchId).maybeSingle();
      if (dup) return { entry: dup, idempotent: true };
      // Remaining 23505 = a concurrent replay/clock-in won a race in the moment
      // between the pre-insert open-row reconcile above and this insert. The
      // client stops retrying; the winner's row carries the labor.
      return { duplicate: true };
    }
    throw error;
  }
  return { entry: data, outsideWindow: !inAccepted || (hasOut && !outAccepted) };
}

// Manager correction of an existing entry. Appends to the append-only edit_history.
export async function correctEntry({ entryId, patch = {}, reason, byUserId }) {
  const db = getSupabase();
  const { data: existing, error: e1 } = await db.from(TABLE).select('*').eq('id', entryId).maybeSingle();
  if (e1) throw e1;
  if (!existing) return { notFound: true };

  const allowed = ['clock_in_at', 'clock_out_at', 'note', 'status'];
  const update = { edited: true, edited_by: byUserId || null, updated_at: nowIso() };
  const history = Array.isArray(existing.edit_history) ? existing.edit_history.slice() : [];
  for (const field of allowed) {
    if (patch[field] !== undefined && patch[field] !== existing[field]) {
      history.push({ at: nowIso(), byUserId: byUserId || null, field, from: existing[field] ?? null, to: patch[field], reason: reason || null });
      update[field] = patch[field];
    }
  }
  const inAt = update.clock_in_at ?? existing.clock_in_at;
  const outAt = update.clock_out_at ?? existing.clock_out_at;
  update.duration_minutes = durationMins(inAt, outAt);
  update.edit_history = history;

  const { data, error } = await db.from(TABLE).update(update).eq('id', entryId).select('*').single();
  if (error) throw error;
  return { entry: data };
}

// Manager-entered time (no device clock event) — e.g. a forgotten clock-in.
export async function manualEntry({ jobId, userId, clockInAt, clockOutAt, note, reason, byUserId }) {
  const ctx = await resolveJobContext(jobId, userId);
  const db = getSupabase();
  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    job_id: ctx.job?.id || jobId || null,
    series_id: ctx.job?.seriesId || null,
    shift_id: ctx.job?.shiftId || null,
    client_id: ctx.clientId,
    site_id: ctx.job?.siteId || null,
    user_id: userId,
    client_name: ctx.clientName,
    site_name: ctx.siteName,
    user_name: ctx.userName,
    scheduled_start: ctx.job?.startAt || null,
    scheduled_end: ctx.job?.endAt || null,
    expected_minutes_snapshot: ctx.expectedMins,
    clock_in_at: clockInAt || nowIso(),
    clock_out_at: clockOutAt || null,
    duration_minutes: durationMins(clockInAt, clockOutAt),
    geofence_result: 'override',
    override_reason: reason || 'manual_entry',
    override_by_user_id: byUserId || null,
    source: 'admin_manual',
    status: clockOutAt ? 'manual' : 'in_progress',
    note: note || null,
    edited: true,
    edited_by: byUserId || null,
    edit_history: [{ at: nowIso(), byUserId: byUserId || null, field: 'created', from: null, to: 'manual', reason: reason || null }],
  };
  const { data, error } = await db.from(TABLE).insert(row).select('*').single();
  if (error) throw error;
  return { entry: data };
}

// Manager sign-off on a (typically flagged) entry.
export async function approveEntry({ entryId, approval, byUserId }) {
  const status = approval === 'rejected' ? 'rejected' : 'approved';
  const db = getSupabase();
  const { data, error } = await db.from(TABLE).update({
    approval_status: status,
    approved_by: byUserId || null,
    approved_at: nowIso(),
    updated_at: nowIso(),
  }).eq('id', entryId).select('*').single();
  if (error) throw error;
  if (!data) return { notFound: true };
  return { entry: data };
}

// The caller's own recent entries (clock screen state). Bounded.
export async function listMine(userId, { sinceIso, limit = 100 } = {}) {
  const db = getSupabase();
  let q = db.from(TABLE).select('*').eq('organization_id', CLEANSPACE_ORG_ID).eq('user_id', userId)
    .order('clock_in_at', { ascending: false }).limit(limit);
  if (sinceIso) q = q.gte('clock_in_at', sinceIso);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  // ALWAYS include still-open punches, regardless of window/limit. An open row's
  // clock_in_at is frozen at clock-in, so an overnight or long-forgotten shift can
  // sink below the 100 most-recent rows and become un-closable (Sept 3). Open rows
  // are always few, so this second read is cheap; merge without duplicating.
  const { data: openRows, error: openErr } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('user_id', userId).is('clock_out_at', null);
  if (openErr) throw openErr;
  if (openRows && openRows.length) {
    const seen = new Set(rows.map((r) => r.id));
    for (const r of openRows) if (!seen.has(r.id)) rows.push(r);
  }
  return rows;
}

// Everyone currently on the clock (manager view).
export async function listOpen() {
  const db = getSupabase();
  const { data, error } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).is('clock_out_at', null)
    .order('clock_in_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Windowed reads ────────────────────────────────────────────────────────────
// Two shapes, one filter set. The CAPPED read (listForReport) is the newest-N scan the
// history surfaces + the Variance / drive-time UI use; they show "newest N" when it is
// hit. The COMPLETE reads (count/page/All) are for anything that sums, pays or alerts —
// reports, the pay run, shift coverage — which must see every row in the window or fail
// loudly (api/_lib/pagedSelect.js). Every page is ordered (sort col, then id) so page
// membership is deterministic, and filled in <= 1000-row slices so PostgREST's
// db-max-rows can't quietly cut a page short.

// Just enough of a punch for "who clocked in / out of which clean" (attendance). The
// edit_history says whether a manager corrected an auto-closed clock-out.
export const ATTENDANCE_COLUMNS = 'id,job_id,user_id,user_name,site_id,client_id,clock_in_at,clock_out_at,status,approval_status,edit_history';
// What drive-segment derivation reads (driveCompute.mapRow).
export const DRIVE_COLUMNS = 'id,user_id,user_name,site_id,site_name,client_id,client_name,clock_in_at,clock_out_at,status,approval_status';
const ROLLUP_COLUMNS = 'id,user_id,user_name,site_id,client_id,site_name,client_name,duration_minutes,clock_in_at,clock_out_at,approval_status,status,job_cancelled_at';

function applyReportFilters(q, { fromIso, toIso, siteIds, clientIds, userIds, jobIds } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID);
  if (fromIso) out = out.gte('clock_in_at', fromIso);
  if (toIso) out = out.lte('clock_in_at', toIso);
  if (Array.isArray(siteIds) && siteIds.length) out = out.in('site_id', siteIds);
  if (Array.isArray(clientIds) && clientIds.length) out = out.in('client_id', clientIds);
  if (Array.isArray(userIds) && userIds.length) out = out.in('user_id', userIds);
  // jobIds: the job page's "who clocked in to THIS clean" list (Time Clock, Sept 3).
  if (Array.isArray(jobIds) && jobIds.length) out = out.in('job_id', jobIds);
  return out;
}

// The ascending, id-tie-broken page reader the complete reads share.
function reportPager(db, filters, columns) {
  return async (from, to) => {
    const { data, error } = await applyReportFilters(db.from(TABLE).select(columns), filters)
      .order('clock_in_at', { ascending: true }).order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
}

// Windowed, filtered rows, NEWEST first, capped at `limit` — the caller surfaces
// truncation ("newest N"). Filled past db-max-rows, so a cap of 2000 means 2000.
export async function listForReport({ fromIso, toIso, siteIds, clientIds, userIds, jobIds, limit = 2000 } = {}, db = getSupabase()) {
  const filters = { fromIso, toIso, siteIds, clientIds, userIds, jobIds };
  const page = async (from, to) => {
    const { data, error } = await applyReportFilters(db.from(TABLE).select('*'), filters)
      .order('clock_in_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
  return rangeFill(page, 0, Math.max(0, limit) - 1);
}

// Exact row count for the same filters (the first page of a paged read carries it).
export async function countForReport(filters = {}, db = getSupabase()) {
  const { count, error } = await applyReportFilters(db.from(TABLE).select('id', { count: 'exact', head: true }), filters);
  if (error) throw error;
  return exactCount(count);
}

// One page of a COMPLETE read, oldest first: rows [offset, offset + limit).
export async function pageForReport(filters = {}, { offset = 0, limit = 1000, columns = '*' } = {}, db = getSupabase()) {
  return rangeFill(reportPager(db, filters, columns), offset, offset + limit - 1);
}

// EVERY row in the window (server-side consumers: the pay-run drive feed, the alert cron).
export async function listForReportAll(filters = {}, { columns = '*', maxRows } = {}, db = getSupabase()) {
  return selectAll({ count: () => countForReport(filters, db), page: reportPager(db, filters, columns), maxRows });
}

// The distinct job ids with a REAL clock-in in the window — "covered" cleans for the
// late/missed alerts (client tick + cron) and the Dashboard missed-cleans KPI. Voided and
// no-show punches never cover a clean (matches jobIdsWithPunches). Complete, so a busy day
// can't leave a clocked-in clean looking uncovered and fire a false alert.
export async function coveredJobIdsInWindow({ fromIso, toIso } = {}, db = getSupabase()) {
  const coverage = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID)
    .gte('clock_in_at', fromIso).lte('clock_in_at', toIso)
    .not('job_id', 'is', null).neq('status', 'voided').neq('status', 'no_show');
  const rows = await selectAll({
    count: async () => {
      const { count, error } = await coverage(db.from(TABLE).select('id', { count: 'exact', head: true }));
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await coverage(db.from(TABLE).select('id,job_id'))
        .order('clock_in_at', { ascending: true }).order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
  return [...new Set(rows.map((r) => r.job_id).filter(Boolean))];
}

// Of the given job ids, the ones carrying at least one non-voided punch. The
// jobs-delta guard refuses to hard-delete these: time_entries.job_id is ON DELETE
// SET NULL, so deleting the clean would silently orphan payroll rows — and on
// Sept 2 a "this & future" series edit deleted in-progress cleans crew were
// clocked into. Chunked; bounded by the delta's own row cap.
export async function jobIdsWithPunches(jobIds) {
  const ids = (jobIds || []).filter((id) => typeof id === 'string' && id);
  const out = new Set();
  if (!ids.length) return out;
  const db = getSupabase();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from(TABLE).select('job_id')
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .in('job_id', ids.slice(i, i + 200))
      .neq('status', 'voided');
    if (error) throw error;
    for (const r of data || []) if (r.job_id) out.add(r.job_id);
  }
  return out;
}

// Completed labor rows in a window for the weekly-hours / OT rollup + payroll
// export. Only rows with a clock-out (a real duration) — open/void rows never pay.
// approvedOnly narrows to manager-signed-off rows (the payroll gate).
function applyRollupFilters(q, { fromIso, toIso, approvedOnly = false } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID).not('clock_out_at', 'is', null);
  if (fromIso) out = out.gte('clock_in_at', fromIso);
  if (toIso) out = out.lte('clock_in_at', toIso);
  if (approvedOnly) out = out.eq('approval_status', 'approved');
  return out;
}

// LEGACY single-response read (newest first, capped) — kept only for app bundles cached
// before the paged read shipped; current clients page through countForRollup/pageForRollup.
export async function listForRollup({ fromIso, toIso, approvedOnly = false, limit = 5000 } = {}, db = getSupabase()) {
  const filters = { fromIso, toIso, approvedOnly };
  const page = async (from, to) => {
    const { data, error } = await applyRollupFilters(db.from(TABLE).select(ROLLUP_COLUMNS), filters)
      .order('clock_in_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
  return rangeFill(page, 0, Math.max(0, limit) - 1);
}

export async function countForRollup(filters = {}, db = getSupabase()) {
  const { count, error } = await applyRollupFilters(db.from(TABLE).select('id', { count: 'exact', head: true }), filters);
  if (error) throw error;
  return exactCount(count);
}

// One page of the COMPLETE rollup, oldest first: rows [offset, offset + limit).
export async function pageForRollup(filters = {}, { offset = 0, limit = 1000 } = {}, db = getSupabase()) {
  const page = async (from, to) => {
    const { data, error } = await applyRollupFilters(db.from(TABLE).select(ROLLUP_COLUMNS), filters)
      .order('clock_in_at', { ascending: true }).order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data || [];
  };
  return rangeFill(page, offset, offset + limit - 1);
}

// Auto-close entries left open past scheduled_end + grace (a forgotten clock-out).
// The clock-out is capped at scheduled_end (NOT "now") so a forgotten clock-out
// never inflates labor; status 'auto_closed' flags it for manager review/correction.
// Entries with no scheduled_end are left alone (nothing to anchor to → manual). The
// cron route gates this on CRON_SECRET. See CLEANSPACE_SWEPT.md §5.4.
export async function autoCloseStale({ graceMinutes = 120, now = Date.now() } = {}) {
  const db = getSupabase();
  const { data: openRows, error } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).is('clock_out_at', null).eq('status', 'in_progress');
  if (error) throw error;
  const closed = [];
  for (const e of openRows || []) {
    const sched = e.scheduled_end ? new Date(e.scheduled_end).getTime() : null;
    if (sched == null || now < sched + graceMinutes * 60000) continue;
    const out = e.scheduled_end; // cap at the scheduled end, not now
    const history = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
    history.push({ at: nowIso(), byUserId: null, field: 'status', from: 'in_progress', to: 'auto_closed', reason: `auto-closed: open past scheduled end + ${graceMinutes}m grace` });
    const { data, error: uErr } = await db.from(TABLE).update({
      clock_out_at: out,
      duration_minutes: durationMins(e.clock_in_at, out),
      status: 'auto_closed',
      edited: true,
      edit_history: history,
      updated_at: nowIso(),
    }).eq('id', e.id).select('id').single();
    if (!uErr && data) closed.push(data.id);
  }
  return { closed: closed.length, ids: closed };
}

// ── a clean was cancelled: stop the clock + flag its labor ────────────────────
// The server twin of src/lib/timeCancel.applyJobCancellation (keep them in step). When
// a clean is cancelled, any OPEN punch on it is clocked out at the cancel moment: capped
// at the scheduled end (same law as autoCloseStale, so a forgotten punch cancelled the
// next day can't inflate the window), never before clock-in, and PAID (status
// 'completed', not voided). EVERY punch on the clean gets job_cancelled_at so payroll +
// the clock history show it. Filtering on job_cancelled_at IS NULL makes it idempotent
// (a re-cancel touches nothing). Bounded: one clean = a few per-cleaner rows.
export async function cancelJobLabor(jobId, { now = Date.now() } = {}) {
  if (!jobId) return { closed: 0, flagged: 0 };
  const db = getSupabase();
  const nowStamp = new Date(now).toISOString();
  const { data: rows, error } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('job_id', jobId).is('job_cancelled_at', null);
  if (error) throw error;
  let closed = 0;
  let flagged = 0;
  for (const e of rows || []) {
    const history = Array.isArray(e.edit_history) ? e.edit_history.slice() : [];
    const patch = { job_cancelled_at: nowStamp, edited: true, updated_at: nowStamp };
    if (!e.clock_out_at) {
      let out = nowStamp;
      if (e.scheduled_end && new Date(e.scheduled_end).getTime() < new Date(out).getTime()) out = e.scheduled_end;
      if (e.clock_in_at && new Date(out).getTime() < new Date(e.clock_in_at).getTime()) out = e.clock_in_at;
      patch.clock_out_at = out;
      patch.duration_minutes = durationMins(e.clock_in_at, out);
      patch.status = 'completed';
      history.push({ at: nowStamp, byUserId: null, field: 'job_cancelled', from: 'in_progress', to: 'completed', reason: 'clean cancelled, clocked out at cancel' });
      closed += 1;
    } else {
      history.push({ at: nowStamp, byUserId: null, field: 'job_cancelled', from: null, to: null, reason: 'clean cancelled after this punch' });
    }
    patch.edit_history = history;
    const { error: uErr } = await db.from(TABLE).update(patch).eq('id', e.id);
    if (uErr) throw uErr;
    flagged += 1;
  }
  return { closed, flagged };
}

// ── zero-punch watchdog (Sept 1 hardening) ────────────────────────────────────
// The Sept 1 incident's deepest failure was silence: crew clocked in nightly for
// MONTHS with zero rows landing here, and nothing alarmed — the org only found
// out when payroll came up empty. This is the guarantee that can never happen
// again: cleans occurred, no punches recorded → a page goes out. Read-only;
// the route (cron, daily) does the alerting so this stays unit-composable.
export async function punchWatchdog({ windowHours = 26, minJobs = 3 } = {}) {
  const db = getSupabase();
  const sinceIso = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const upToIso = nowIso();
  const { count: jobsN, error: e1 } = await db.from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .neq('status', 'cancelled')
    .gte('start_at', sinceIso).lte('start_at', upToIso);
  if (e1) throw e1;
  const { count: punchesN, error: e2 } = await db.from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .gte('clock_in_at', sinceIso);
  if (e2) throw e2;
  // minJobs keeps a genuinely quiet day (holiday, storm closure) from paging.
  const silent = (jobsN || 0) >= minJobs && (punchesN || 0) === 0;
  return { jobs: jobsN || 0, punches: punchesN || 0, windowHours, silent };
}

// ── demo-period history recovery (Sept 1 incident) ────────────────────────────
// Crew phones on stale demo-clock builds accumulated MONTHS of real punches in
// per-phone localStorage while the server heard nothing. Once such a phone loads
// a current build, the client offers to upload that history; this ingests it.
// Historical facts, so asserted times are stored AS-GIVEN (no replay window) —
// but every row lands approval_status 'pending' + source 'stub_recovery', so
// payroll only pays what a manager signs off. Idempotent per entry via a
// deterministic client_punch_id, so a retried upload can never double-insert.
export async function recoverStubEntries({ userId, entries = [] }) {
  if (!userId) return { badRequest: 'userId required' };
  const db = getSupabase();
  const list = (Array.isArray(entries) ? entries : []).slice(0, 400);
  // One blob read serves every job lookup + name denormalization in the batch.
  let blobCtx = null;
  try { blobCtx = await readOrgState(); } catch { blobCtx = null; }
  const sites = Array.isArray(blobCtx?.state?.sites) ? blobCtx.state.sites : [];
  const clients = Array.isArray(blobCtx?.state?.clients) ? blobCtx.state.clients : [];
  const selfName = (Array.isArray(blobCtx?.state?.users) ? blobCtx.state.users : [])
    .find((u) => u.id === userId)?.name || null;
  const jobCache = new Map();
  const lookupJob = async (jobId) => {
    if (!jobId) return null;
    if (jobCache.has(jobId)) return jobCache.get(jobId);
    let job = null;
    try { job = await getJobById(jobId); } catch { job = null; }
    jobCache.set(jobId, job);
    return job;
  };
  let inserted = 0, duplicate = 0, skipped = 0;
  for (const e of list) {
    // Identity backstop, same law as replayPunch: a stub entry recorded for a
    // DIFFERENT crew member (shared device) is skipped, never re-attributed —
    // it stays on the phone for its owner's own sign-in.
    const assertedUser = typeof (e?.userId || e?.user_id) === 'string' ? (e.userId || e.user_id) : null;
    if (assertedUser && assertedUser !== userId) { skipped++; continue; }
    const inAt = e?.clockInAt || e?.clock_in_at || null;
    const outAt = e?.clockOutAt || e?.clock_out_at || null;
    const inMs = inAt ? new Date(inAt).getTime() : NaN;
    const outMs = outAt ? new Date(outAt).getTime() : NaN;
    // Only completed, sane entries: both times, in order, not in the future,
    // shift under 24h. Half-open demo rows are stale junk, not payroll.
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs
      || outMs - inMs > 24 * 3600 * 1000 || inMs > Date.now()) { skipped++; continue; }
    // Validate the claimed job server-side: time_entries.job_id carries an FK,
    // so a stale id (job since deleted — routine over months) would 23503 and
    // kill the whole upload. A resolvable job also lets us denormalize the real
    // client/site links so the recovered labor shows up in every filtered
    // report; an unresolvable one degrades to the payload's display names.
    const rawJobId = typeof (e.jobId || e.job_id) === 'string' ? (e.jobId || e.job_id).slice(0, 64) : null;
    const job = await lookupJob(rawJobId);
    const site = job?.siteId ? sites.find((s) => s.id === job.siteId) || null : null;
    const clientId = job?.clientId || site?.clientId || null;
    const client = clientId ? clients.find((c) => c.id === clientId) || null : null;
    const row = {
      organization_id: CLEANSPACE_ORG_ID,
      job_id: job ? job.id : null,
      series_id: job?.seriesId || null,
      site_id: job?.siteId || null,
      client_id: clientId,
      user_id: userId,
      client_name: client?.name
        || (typeof (e.clientName || e.client_name) === 'string' ? (e.clientName || e.client_name).slice(0, 120) : null),
      site_name: site?.name
        || (typeof (e.siteName || e.site_name) === 'string' ? (e.siteName || e.site_name).slice(0, 120) : null),
      user_name: selfName
        || (typeof (e.userName || e.user_name) === 'string' ? (e.userName || e.user_name).slice(0, 120) : null),
      scheduled_start: job?.startAt || null,
      scheduled_end: job?.endAt || null,
      clock_in_at: new Date(inMs).toISOString(),
      clock_out_at: new Date(outMs).toISOString(),
      duration_minutes: Math.round((outMs - inMs) / 60000),
      source: 'stub_recovery', // allowed by 20260902110000 (CHECK widened)
      status: 'completed',
      // Job discriminator in the dedup key: two same-instant entries on
      // DIFFERENT jobs (demo-build manual entries) must not collide.
      client_punch_id: `stubrec_${userId}_${inMs}_${(rawJobId || 'nojob').slice(-8)}`,
      client_asserted_at: new Date(inMs).toISOString(),
      client_asserted_out_at: new Date(outMs).toISOString(),
      approval_status: 'pending',
      note: '[stub recovery] uploaded from a phone that ran the demo-period build',
      edited: true,
      edit_history: [{ at: nowIso(), byUserId: userId, field: 'created', from: null, to: 'stub_recovery',
        reason: 'demo-period localStorage history recovered after build refresh' }],
    };
    const { error } = await db.from(TABLE).insert(row);
    if (error) {
      if (error.code === '23505') { duplicate++; continue; }
      if (error.code === '23503') { skipped++; continue; } // FK raced a delete — degrade, don't kill the batch
      throw error;
    }
    inserted++;
  }
  return { inserted, duplicate, skipped, received: list.length };
}
