// Service-role data layer for time_entries — the per-cleaner labor ledger and the
// substrate for the Variance report. The browser NEVER touches this table; only
// app/api/time/* does. RLS is on with no policies (service-role bypass), and
// organization_id is pinned to CLEANSPACE_ORG_ID. Names are denormalized at write so
// reports render without rehydrating the blob. See CLEANSPACE_SWEPT.md §4.1 / §5.4.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readOrgState, writeOrgState } from '../orgState.js';
import { cached } from '../requestCache.js';
import { getJobById, markJobDone } from '../jobsTable.js';
import { jobDoneAfterPunches } from '../../../src/lib/jobStatus.js';
import { geofenceVerdict, isOffSiteVerdict, metersToFeet } from '../../../src/lib/geo.js';
import {
  CLOCK_RULE_KEYS, GEOFENCE_OFF_REASON, isClockRuleOff, clockOutGeofenceFields,
  OFF_SITE_PUNCH_EVENT, offSitePunchSides,
  GPS_POINT_RETENTION_DAYS, GPS_POINT_COLUMNS,
} from '../../../src/lib/clockRules.js';
import { fanOutSupervisorFirst } from '../../../src/lib/notifications.js';
import { msg } from '../../../src/i18n/core.js';
import { isUserJobCrew } from '../../../src/lib/crewResolve.js';
import { VOIDED_CLOCK_OUT_REASON, closedPunchStatus, sameInstant, correctionChanges } from '../../../src/lib/timeRules.js';
import { blockingOpenPunch, openPunchLabel, overlapFlagNote } from '../../../src/lib/openPunchRule.js';
import { autoCloseAnchor, autoCloseDue, autoCloseCutoffIso, lateStartAutoCloseNote } from '../../../src/lib/autoClose.js';
import { rangeFill, selectAll, exactCount } from '../pagedSelect.js';
import {
  checklistGateFor, checklistBlocks, checklistUnknown, checklistFlagNote,
  CHECKLIST_UNKNOWN_NOTE, CHECKLIST_GATE_UNKNOWN,
} from './checklistGate.js';

const TABLE = 'time_entries';
const RUNS_TABLE = 'payroll_runs';
const nowIso = () => new Date().toISOString();

// THE SINGLE UPDATE PATH for time_entries, and it is ALWAYS a compare-and-swap. It bumps
// row_version off `base` (the value the caller read for an internal write, or the client's
// asserted version for a manager write), stamps updated_at with the server clock (spec §6.2
// — arrears detection reads it), and rides `.eq('row_version', base)` so a row that changed
// under the caller updates 0 rows. No caller may put row_version or updated_at in `patch`;
// this owns both. A source check (test-time-approval-routes.mjs) pins that this is the ONLY
// `.update(` on the table, and that the version filter is unconditional, so no punch write
// can skip the version bump or the swap.
//
// 🔴 THE CAS IS NOT OPTIONAL (W5-M F1). It used to ride only for a manager write, so every
// INTERNAL writer was last-write-wins: a write parked between its read and its UPDATE
// clobbered a newer one and rolled row_version BACKWARDS. The window widened when the
// clock-out checklist gate added reads between the two. `{ stale: true }` means the row
// changed or is gone — the caller decides: a manager write answers 409, an internal writer
// re-reads and rebuilds (writeFresh below).
async function updateEntry(db, id, base, patch) {
  const v = Number.isFinite(base) ? base : 0;
  const body = { ...patch, row_version: v + 1, updated_at: nowIso() };
  const { data, error } = await db.from(TABLE).update(body)
    .eq('id', id).eq('row_version', v).select('*');
  if (error) throw error;
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (!rows.length) return { stale: true };
  return { entry: rows[0] };
}

// How many times an internal writer rebuilds its patch on a fresh row before giving up.
// A punch is contended by a handful of actors at most (the cleaner, a manager, a cron), so
// a genuine miss is one retry; past this the row is being written in a loop and the honest
// answer is "try again", not a silent clobber.
const WRITE_TRIES = 4;

// The internal writers' CAS loop: `build(row)` returns `{ patch }` to write against THAT
// row's version, or `{ result }` to answer without writing at all (the clock-out that finds
// the punch already closed). On a stale miss the row is RE-READ and `build` runs again on
// the fresh one — which is what makes the retry correct rather than a replay of a patch
// computed from stale values (a duration, an edit_history append, a status decision).
//
// Answers: { entry } wrote · the build's own `result` · { notFound: true } the row is gone
// · { retryable: true } still contended after WRITE_TRIES — the route answers 503, never a
// 4xx for a buffered punch (THE LAW II.8: a replay is never refused).
async function writeFresh(db, first, build, { tries = WRITE_TRIES } = {}) {
  let row = first;
  for (let i = 0; i < tries; i += 1) {
    if (!row) return { notFound: true };
    const decision = await build(row);
    if (decision && 'result' in decision) return decision.result;
    const r = await updateEntry(db, row.id, row.row_version, decision.patch);
    if (!r.stale) return { entry: r.entry };
    row = await resolveEntry(db, first.id);
  }
  return { retryable: true };
}

// A MANAGER write's CAS base. A versioned caller asserts the version it saw, and a row that
// moved since answers 409 stale. A LEGACY (unversioned) body — an app bundle cached before
// W1-A shipped — has no version to assert, so the server re-reads the row immediately before
// the write and swaps on ITS OWN read: the race window shrinks from the whole request to
// that one statement, the patch is built from the FRESH row, and a write that still lands
// inside it answers 409 exactly as the versioned path does.
// TODO(remove-by: 2026-11-01) — drop with LEGACY_UNVERSIONED_UNTIL (api/time/[...path].js).
async function casBase(db, existing, version) {
  if (version != null) return { row: existing, base: version };
  const fresh = await resolveEntry(db, existing.id);
  if (!fresh) return { notFound: true };
  return { row: fresh, base: fresh.row_version };
}

// One entry by id (or by client_punch_id for a synth op_* id), for the route to read once
// before it gates + writes. Exported wrapper of resolveEntry.
export async function getEntry(entryId, db = getSupabase()) {
  return resolveEntry(db, entryId);
}

// A batch read for the approve queue: id -> row, chunked (the batch is capped at 200).
export async function getEntriesByIds(ids, db = getSupabase()) {
  const map = new Map();
  const list = [...new Set((ids || []).filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await db.from(TABLE).select('*')
      .eq('organization_id', CLEANSPACE_ORG_ID).in('id', list.slice(i, i + 200));
    if (error) throw error;
    for (const r of data || []) map.set(r.id, r);
  }
  return map;
}

// The FIRST (earliest period) and LATEST (most recent period) closed pay run — read once
// per request for the ledger lock (a paid punch refuses edits, §6.1) and the
// drive-override closed-territory refusal (§2 / §5.1). Both null before any run exists.
// Periods are contiguous and non-overlapping, so ordering by period_key gives first/latest.
export async function readRunBounds(db = getSupabase()) {
  return cached('payrollRunBounds', async () => {
    const { data, error } = await db.from(RUNS_TABLE)
      .select('id, period_key, from_key, to_key, from_iso, to_iso, closed_at')
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .order('period_key', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) return { firstRun: null, latestRun: null };
    return { firstRun: rows[0], latestRun: rows[rows.length - 1] };
  });
}

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

// 🔴 ONE CLEAN AT A TIME (PAY-13 → CS-318). This cleaner's OPEN punches on any OTHER clean
// (a different job_id, or none at all — `job_id` is nullable, so those rows were constrained
// by nothing). Narrow columns: only what the refusal and the flag need to NAME the clean.
// One indexed read on (organization_id, user_id) filtered to open rows, and only ever asked
// on a clock-in / replayed clock-in, never on an ordinary clock-out.
const OPEN_PUNCH_COLUMNS = 'id, job_id, clock_in_at, clock_out_at, client_name, site_name';
async function openPunchElsewhere(db, userId, jobId) {
  const { data, error } = await db.from(TABLE).select(OPEN_PUNCH_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('user_id', userId)
    .is('clock_out_at', null).eq('status', 'in_progress');
  if (error) throw error;
  return blockingOpenPunch(data || [], jobId);
}

// (Removed in Increment 1c: `blobUserByEmail` mapped an auth email to a `u_*` id
// through the browser-writable org_state roster, so a crew user could rewrite
// the roster to inherit someone else's identity for labor/QC writes. Identity
// now comes from the service-role-only JWT claim — see authz.resolveAuthority.)

// Crew clock-in with the SERVER-AUTHORITATIVE geofence. Returns one of:
//   { duplicate: true }   -> already clocked in to this clean (DB unique index)
//   { alreadyOpen, openPunch } -> still on the clock at ANOTHER clean (route → 409, PAY-13)
//   { entry }             -> the created row
//
// 🔴 PAY-17 (Matt, 2026-09-30): "The cleaner can clock in or out; the time is held until the
// supervisor approves it, and the supervisor is alerted right away." THE GEOFENCE NO LONGER
// REFUSES A CLOCK-IN. It used to answer 403 outside the ring unless the cleaner tapped "clock
// in anyway", which rewrote the honest verdict ('outside') as an 'override' with a
// crew-asserted reason — the record of where the punch actually happened replaced by a
// confession, and a cleaner whose device could not get a fix stranded at the door. Now the
// verdict is stored as it is, the punch is approval-gated like every punch (approval_status
// defaults to 'pending'; nothing here approves anything), and `notifyOffSitePunch` tells the
// account's supervisor at once. `offSiteReason` is the cleaner's OPTIONAL note, recorded, never
// required and never trusted to change the verdict.
export async function clockIn({ jobId, userId, isManager = false, deviceLat, deviceLng, accuracyM, offSiteReason, source = 'crew_mobile', clientPunchId = null }) {
  const ctx = await resolveJobContext(jobId, userId);
  if (!ctx.job) return { notFound: true };
  // Server-side authorization: a crew member can only clock into a clean they're
  // assigned to (the open RLS means UI gating is not a boundary). The punch bypass
  // (owner/admin, or time.edit.all) skips it.
  if (!isAssignedToJob(ctx.job, userId, { client: ctx.client, site: ctx.site }) && !(await hasPunchBypass(isManager))) return { forbidden: true };

  // 🔴 ONE CLEAN AT A TIME (PAY-13 → CS-318). A LIVE clock-in while this cleaner is still on
  // the clock somewhere else is REFUSED, naming that clean — nothing is lost, because nothing
  // has happened yet, and both punches would otherwise be paid. A MANAGER (the punch bypass)
  // may override, and the punch they open is FLAGGED so the overlap reaches the approver. The
  // offline REPLAY is never refused at all (replayPunch below, THE LAW II.8). Deliberately
  // NOT a database constraint: a partial unique index over (user_id) would also refuse the
  // manager's override and, worse, the replay.
  const openElsewhere = await openPunchElsewhere(getSupabase(), userId, ctx.job.id);
  let overlapFlag = null;
  if (openElsewhere) {
    if (!(await hasPunchBypass(isManager))) {
      return { alreadyOpen: true, openPunch: openElsewhere, openCleanName: openPunchLabel(openElsewhere) };
    }
    overlapFlag = overlapFlagNote(openPunchLabel(openElsewhere));
  }

  const verdict = geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng,
    deviceLat: Number.isFinite(deviceLat) ? deviceLat : null,
    deviceLng: Number.isFinite(deviceLng) ? deviceLng : null,
    accuracyM, radiusM: ctx.radiusM, enabled: ctx.geofenceEnabled,
    disabledReason: ctx.geofenceDisabledReason,
  });
  // PAY-17: the verdict is RECORDED, never a refusal. 'outside' stays 'outside'.
  const result = verdict.result;
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
    // The VERDICT's reason wins over the caller's, always. The verdict carries one when the
    // ring was off by CONFIG ('geofence_disabled', or geofence_off_for_cleaner) — a
    // server-side fact — and a client claim must never be able to erase it. The cleaner's
    // OPTIONAL note is recorded only on an OFF-SITE punch, where the verdict carries no
    // reason of its own; it explains the punch, it does not change it (PAY-17).
    override_reason: result === 'override'
      ? (verdict.reason || null)
      : (isOffSiteVerdict(result) ? (trimOffSiteReason(offSiteReason) || null) : null),
    // Nobody overrides anything any more (PAY-17): an off-site punch is allowed outright.
    override_by_user_id: null,
    source,
    status: 'in_progress',
    // Shared idempotency key: the client mints this BEFORE the online clock-in and
    // reuses it if the request has to be buffered + replayed after a lost ACK — so a
    // committed row and its buffered twin collide on time_entries_client_punch_uidx
    // instead of double-paying. Null only for legacy callers that don't send one.
    client_punch_id: clientPunchId || null,
    updated_at: nowIso(),
  };
  // A manager's PAY-13 override rides on the punch itself: the note the approver reads and
  // an edit_history line saying which clean the cleaner was still on. Absent on every
  // ordinary punch, so nothing changes for the common case.
  if (overlapFlag) {
    row.note = `[overlap] ${overlapFlag}`;
    row.edited = true;
    row.edit_history = [{ at: nowIso(), byUserId: userId, field: 'created', from: null, to: 'overlapping punch', reason: overlapFlag }];
  }

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
  // PAY-17: the punch is recorded and PENDING; the supervisor hears about it now. Awaited so
  // the bell row is durable before the response, best-effort inside (a failed alert must
  // never cost the cleaner their clock-in), and a no-op for an on-site punch, so the ordinary
  // path pays nothing.
  await notifyOffSitePunch(data, 'in');
  return { entry: data };
}

// ── PAY-17: the supervisor is alerted the moment a punch lands off-site ──────────────────
// Matt, 2026-09-30: "…and the supervisor is alerted right away." Routed to the ACCOUNT'S
// supervisor, falling back to the office bench when the account has none — the same
// `fanOutSupervisorFirst` the ticket ping uses, so "who hears about this customer" has one
// answer. The bell row is what the every-minute dispatch cron turns into a push AND a text
// (lib/alertDelivery: OFF_SITE_PUNCH_EVENT is in both ALWAYS_PUSH and SMS_ALERT), so there is
// nothing to send from here.
//
// CAS-guarded against a concurrent org_state write and FULLY best-effort: the punch is already
// durable, and losing the alert must never lose the labor. A no-op unless THIS end of the
// punch is off-site (`geo.isOffSiteVerdict`), so an ordinary punch costs no read at all.
const OFF_SITE_REASON_MAX = 300;
const trimOffSiteReason = (v) => (typeof v === 'string' ? v.trim().slice(0, OFF_SITE_REASON_MAX) : '');
export async function notifyOffSitePunch(entry, side = 'in', tries = 3) {
  if (!entry) return;
  const sides = offSitePunchSides(entry);
  if (!(side === 'out' ? sides.out : sides.in)) return;
  const result = side === 'out' ? entry.geofence_result_out : entry.geofence_result;
  const distanceM = side === 'out' ? entry.clock_out_distance_m : entry.clock_in_distance_m;
  // MESSAGES (CS-193): the supervisor reads it in their own language; the cleaner's and the
  // building's names are people's words and travel as written.
  const who = entry.user_name || entry.user_id || msg('alerts.offSite.aCleaner');
  const where = entry.client_name || entry.site_name || msg('alerts.anAccount');
  const feet = metersToFeet(distanceM);
  const away = result === 'unavailable'
    ? msg('alerts.offSite.noLocation')
    : (Number.isFinite(feet) ? msg('alerts.offSite.distance', { feet }) : msg('alerts.offSite.distanceUnknown'));
  try {
    for (let i = 0; i < tries; i += 1) {
      const { state, version } = await readOrgState();
      const notifications = fanOutSupervisorFirst({ ...state, notifications: state.notifications || [] }, {
        clientId: entry.client_id || null,
        eventKey: OFF_SITE_PUNCH_EVENT,
        title: msg(side === 'out' ? 'alerts.offSite.titleOut' : 'alerts.offSite.titleIn', { name: who, place: where }),
        body: msg('alerts.offSite.body', { away }),
        url: '/approvals?tab=approve',
        actorUserId: entry.user_id || null,
      });
      if (await writeOrgState({ ...state, notifications }, version)) return;
    }
  } catch { /* best-effort — the punch is already saved, and it is held either way */ }
}

// ── PAY-20: clear the exact GPS points once they are past the horizon ────────────────────
// Matt, 2026-09-30: "90 days, then only on site / off site and the distance." The six raw
// point columns are nulled on punches older than `GPS_POINT_RETENTION_DAYS` (by `clock_in_at`,
// the punch's own anchor); the verdict and the two distances stay, so every reader keeps its
// answer. Rides the DAILY /api/cron/reap beside the other retention sweeps — no new cron.
//
// 🔴 IDEMPOTENT by construction: the selection predicate is "still has a point", so a second
// run matches nothing. 🔴 BOUNDED: ids are read in pages and updated by id, at most
// `batchSize × maxBatches` rows per run, so the first run on years of history cannot try to
// rewrite the table in one statement or time the function out — `more: true` says to come
// back, and the cron runs again tomorrow (or sooner, by hand).
//
// The CAS version is deliberately NOT bumped: retention is not an edit anyone has to re-read,
// and bumping it would make every trimmed old punch look changed to a manager's open queue.
export const PUNCH_COORD_BATCH = 500;
export const PUNCH_COORD_MAX_BATCHES = 20;
export async function trimStalePunchCoords({
  now = Date.now(), days = GPS_POINT_RETENTION_DAYS,
  batchSize = PUNCH_COORD_BATCH, maxBatches = PUNCH_COORD_MAX_BATCHES,
} = {}) {
  const db = getSupabase();
  const cutoff = new Date(now - days * 86400 * 1000).toISOString();
  // "Any point is still recorded" — PostgREST's or() over the six columns. A row that has
  // already been trimmed (or never had a fix) is not matched, which is what makes this a
  // no-op on every run after the first.
  const stillHasAPoint = GPS_POINT_COLUMNS.map((c) => `${c}.not.is.null`).join(',');
  const cleared = Object.fromEntries(GPS_POINT_COLUMNS.map((c) => [c, null]));
  let trimmed = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const { data: page, error: readErr } = await db.from(TABLE).select('id')
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .lt('clock_in_at', cutoff)
      .or(stillHasAPoint)
      .order('clock_in_at', { ascending: true })
      .limit(batchSize);
    if (readErr) throw readErr;
    const ids = (page || []).map((r) => r.id);
    if (!ids.length) return { trimmed, more: false, cutoff, days };
    const { error: writeErr } = await db.from(TABLE).update(cleared)
      .eq('organization_id', CLEANSPACE_ORG_ID).in('id', ids);
    if (writeErr) throw writeErr;
    trimmed += ids.length;
    if (ids.length < batchSize) return { trimmed, more: false, cutoff, days };
  }
  return { trimmed, more: true, cutoff, days };
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

// The audit append a buffered clock-out leaves when it arrives AFTER the punch was already
// closed — the auto-close cron ran first, a manager closed it, or it was closed while this
// very replay waited to write. The recorded clock-out is NEVER overwritten (it is the time
// the row was actually closed at); the device's claim goes into the history for a manager
// to reconcile. ONE definition, built from whatever row it is handed, so the three places
// that can discover a closed row (the idempotency reconcile, the entryId path, and the CAS
// retry inside applyReplayClockOut) leave the same trail.
const LATE_CLOCK_OUT_REASON = 'buffered offline clock-out arrived after the punch was already closed';

// 🔴 A CLOCK-OUT NEVER UN-DELETES A PUNCH (W5-M F3) — the rule and its sentence live in the
// shared lib/timeRules.js, so the server, the demo stub and any reader of the history share
// one definition. The history line that goes with it, or null when there is nothing
// unusual to say.
function voidedClockOutHistory(row, { byUserId, at, outAt }) {
  if (row.status !== 'voided') return null;
  return { at, byUserId: byUserId || null, field: 'clock_out_at', from: null, to: outAt, reason: VOIDED_CLOCK_OUT_REASON };
}
function lateClockOutPatch(row, { byUserId, assertedOutAt }) {
  const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
  history.push({ at: nowIso(), byUserId, field: 'offline_clock_out_arrived',
    from: row.clock_out_at, to: assertedOutAt || null, reason: LATE_CLOCK_OUT_REASON });
  return { edit_history: history };
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

// 🔴 THE GEOFENCE VERDICT AT CLOCK-OUT (PAY-12, 2026-09-29). Matt: "all clock-ins and
// clock-outs need to be recorded at the actual site." The SAME `geofenceVerdict` the clock-in
// runs, on the clock-out coords, resolved SERVER-side — so a device can neither claim a verdict
// nor claim its own exemption. It is a RECORDING, never a gate: it cannot refuse a clock-out
// (the work happened and the punch is its only record, II.8) and it holds nothing; the approval
// flow is PAY-17, still unanswered.
//
// `ownerUserId` is the PUNCH'S OWNER, not the caller — the per-cleaner off switch belongs to
// whoever worked, so a manager closing someone else's punch must not have their own exemption
// applied to it. A punch with no clean has no site to measure against, and an unreadable blob
// must not turn a clock-out into a 500: both return no verdict, which writes nothing and leaves
// the columns absent (honest, where 'inside' would be a lie).
async function clockOutGeofence({ jobId, ownerUserId, deviceLat, deviceLng, accuracyM, ctx = null }) {
  if (!jobId || !ownerUserId) return { ctx: null, fields: {} };
  try {
    const c = ctx || await resolveJobContext(jobId, ownerUserId);
    const verdict = geofenceVerdict({
      siteLat: c.siteLat, siteLng: c.siteLng,
      deviceLat: Number.isFinite(deviceLat) ? deviceLat : null,
      deviceLng: Number.isFinite(deviceLng) ? deviceLng : null,
      accuracyM, radiusM: c.radiusM, enabled: c.geofenceEnabled,
      disabledReason: c.geofenceDisabledReason,
    });
    return { ctx: c, fields: clockOutGeofenceFields(verdict, { accuracyM }) };
  } catch (e) {
    console.error('[time/clock-out-geofence]', e?.code || 'read_failed');
    return { ctx: null, fields: {} };
  }
}

// 🔴 CS-051 — A CLEAN IS DONE WHEN ITS LAST CLEANER CLOCKS OUT, decided here. The screen used
// to mark the clean done on EVERY clock-out, so on a two-cleaner clean the first to leave
// finished it while the other was still working; the server alone sees every punch on a clean,
// so it decides (lib/jobStatus.jobDoneAfterPunches over this clean's punches) and writes the
// status (jobsTable.markJobDone, a compare-and-swap). Asked after each way a punch closes: the
// live clock-out and a replayed one, the office entering a clock-out or deleting an open punch,
// and the auto-close cron (api/time). Two phones clocking out at once cannot both miss it:
// each closes its OWN punch before it reads the clean's punches, so the later read sees both.
// One indexed read (time_entries_job_idx; a clean is a few rows), and it is BEST-EFFORT: the
// punch is already recorded, so a failure here answers { jobDone: false } and logs, never an
// error — the office can still mark the clean done by hand.
const SETTLE_COLUMNS = 'id, clock_out_at, status';
export async function settleJobAfterPunchClosed(jobId, db = getSupabase()) {
  if (!jobId) return { jobDone: false };
  try {
    const { data, error } = await db.from(TABLE).select(SETTLE_COLUMNS)
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('job_id', jobId);
    if (error) throw error;
    if (!jobDoneAfterPunches(data || [])) return { jobDone: false };
    const r = await markJobDone(jobId);
    return { jobDone: r.jobDone === true };
  } catch (e) {
    console.error('[time/job-done]', e?.code || e?.message || 'failed');
    return { jobDone: false, failed: true };
  }
}

// Clock-out (never GATED by the geofence — it is recorded, see above). Only the entry's owner or
// the punch bypass.
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
//
// 🔴 SCOPE ON SOMEONE ELSE'S PUNCH (W5-M F2). Closing another person's punch is a manager
// time write, so it takes the SAME scope rule time/correct takes: a manager writes time only
// at the customers they supervise. `inScope` is the route's `(entry) => boolean`, asked ONLY
// when the caller is not the punch's owner — so a cleaner's own clock-out reads no matrix
// and is never scope-checked (their own scope is empty; asking would refuse every punch).
// The paid lock and the own-time rule do NOT apply: closing an open punch is not an edit of
// paid time, and the office closing its own forgotten punch is the same escape hatch.
export async function clockOut({ entryId, userId, isManager, inScope = null, deviceLat, deviceLng, accuracyM }) {
  const db = getSupabase();
  const existing = await resolveEntry(db, entryId);
  if (!existing) return { notFound: true };
  if (existing.user_id !== userId) {
    if (!(await hasPunchBypass(isManager))) return { forbidden: true };
    if (inScope && !(await inScope(existing))) return { outOfScope: true };
  }
  if (existing.clock_out_at) return { alreadyOut: true, entry: existing };

  // PAY-12: the clean's context, resolved ONCE and shared with the checklist gate below (which
  // resolves the same thing), so recording the out verdict costs the owner path no extra read.
  const geo = await clockOutGeofence({
    jobId: existing.job_id, ownerUserId: existing.user_id, deviceLat, deviceLng, accuracyM,
  });

  if (existing.user_id === userId) {
    const gate = await checklistGateForEntry({ jobId: existing.job_id, userId: existing.user_id, ctx: geo.ctx });
    // Unreadable is not "finished": fail CLOSED, but as a distinct RETRYABLE answer so the
    // crew are told to try again rather than accused of an unfinished checklist.
    if (checklistUnknown(gate)) return { checklistCheckFailed: true };
    if (checklistBlocks(gate)) return { checklistIncomplete: true, done: gate.done, total: gate.total };
  }

  // The clock-out MOMENT is stamped once, here: a CAS retry must record when the cleaner
  // tapped, not when the retry landed. Everything else is rebuilt from the fresh row.
  const out = nowIso();
  const written = await writeFresh(db, existing, (row) => {
    // The punch was closed while this write waited (a manager closed it, the auto-close
    // cron ran). NEVER overwrite a recorded clock-out — answer as an already-out punch,
    // with the FRESH row, exactly as the pre-write check above does.
    if (row.clock_out_at) return { result: { alreadyOut: true, entry: row } };
    const update = {
      clock_out_at: out,
      duration_minutes: durationMins(row.clock_in_at, out),
      clock_out_lat: Number.isFinite(deviceLat) ? deviceLat : null,
      clock_out_lng: Number.isFinite(deviceLng) ? deviceLng : null,
      // PAY-12: the verdict + distance for THIS end of the punch. {} when it could not be
      // evaluated, so the columns stay absent rather than claim anything.
      ...geo.fields,
      // A DELETED punch keeps its status and its approval: the clock-out is recorded, the
      // deletion stands (F3). Everything else closes to 'completed'.
      status: closedPunchStatus(row),
    };
    const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
    let noted = false;
    // Someone else's punch, closed through the punch bypass: leave the trail a correction
    // leaves (who, when, which field), so the record shows it wasn't the cleaner's own
    // clock-out. The replayed clock-out records its history the same way.
    if (row.user_id !== userId) {
      history.push({ at: out, byUserId: userId, field: 'clock_out_at', from: null, to: out, reason: 'clocked out by another team member' });
      update.edited_by = userId;
      noted = true;
    }
    const voidedLine = voidedClockOutHistory(row, { byUserId: userId, at: out, outAt: out });
    if (voidedLine) { history.push(voidedLine); noted = true; }
    if (noted) Object.assign(update, { edited: true, edit_history: history });
    return { patch: update };
  });
  // PAY-17: the clock-OUT end alerts on its own terms — a cleaner who was on site when they
  // arrived and somewhere else when they left is exactly the question an approver has to
  // answer. Skipped when the write did not land, or when the punch was already closed (that
  // end's verdict was recorded, and alerted, by whoever actually closed it).
  if (written?.entry && !written.alreadyOut) await notifyOffSitePunch(written.entry, 'out');
  return written;
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
  inLat, inLng, inAccuracyM, outLat, outLng, outAccuracyM,
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
    // PAY-12: RE-RUN the geofence on the buffered clock-out coords, server-side, never trusting
    // a client verdict — the same rule and the same shared ctx the checklist flag below uses.
    const geo = await clockOutGeofence({
      jobId: existing.job_id, ownerUserId: existing.user_id,
      deviceLat: outLat, deviceLng: outLng, accuracyM: outAccuracyM,
    });
    // R4 off-line half: the punch is ACCEPTED whatever the checklist says, and the
    // unfinished checklist rides along as a flag so it shows at approval.
    const clFlag = await checklistReplayFlag({ jobId: existing.job_id, userId: existing.user_id, ctx: geo.ctx });
    const windowReason = outAccepted
      ? 'offline clock-out replay'
      : `offline clock-out asserted ${assertedOutAt} outside ${windowHours}h window — server-stamped`;
    let late = false;
    const r = await writeFresh(db, existing, (row) => {
      // Closed while this write waited (the auto-close cron, a manager, a concurrent
      // replay). The recorded time stands; the device's claim goes to the audit trail —
      // the SAME answer the pre-write checks below give, so the race and the ordinary
      // case cannot drift.
      if (row.clock_out_at) {
        late = true;
        return { patch: lateClockOutPatch(row, { byUserId: userId, assertedOutAt }) };
      }
      late = false;
      const at = nowIso();
      const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
      history.push({ at, byUserId: userId, field: 'clock_out_at', from: null, to: outAt,
        reason: clFlag ? `${windowReason}; ${clFlag}` : windowReason });
      // A DELETED punch keeps its status and the approval the delete left (F3): the buffered
      // clock-out is still recorded — II.8 — but it does not bring the punch back.
      const voidedLine = voidedClockOutHistory(row, { byUserId: userId, at, outAt });
      if (voidedLine) history.push(voidedLine);
      const update = {
        clock_out_at: outAt,
        duration_minutes: durationMins(row.clock_in_at, outAt),
        clock_out_lat: Number.isFinite(outLat) ? outLat : null,
        clock_out_lng: Number.isFinite(outLng) ? outLng : null,
        ...geo.fields,                                    // PAY-12, the replay's own re-check
        status: closedPunchStatus(row),
        client_asserted_out_at: assertedOutAt || null,
        edited: true,
        edit_history: history,
      };
      // Offline-touched → manager review. A DELETED punch keeps whatever the delete left.
      if (row.status !== 'voided') update.approval_status = 'pending';
      // Append to the row's existing offline flags note, never replace it.
      if (clFlag) update.note = row.note ? `${row.note}; ${clFlag}` : `[offline] ${clFlag}`;
      return { patch: update };
    });
    if (r.notFound || r.retryable) return r;
    return late ? { entry: r.entry, alreadyOut: true } : { entry: r.entry, outsideWindow: !outAccepted };
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
      // rather than silently dropping the crew's real clock-out. "Different" is by VALUE
      // (CS-694): the stored `…+00:00` and the phone's `….000Z` of one instant are the same time.
      if (assertedOutAt && prior.clock_out_at && !sameInstant(prior.clock_out_at, assertedOutAt)) {
        const r = await writeFresh(db, prior, (row) => ({ patch: lateClockOutPatch(row, { byUserId: userId, assertedOutAt }) }));
        if (r.notFound || r.retryable) return r;
        return { entry: r.entry, idempotent: true, alreadyOut: true };
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
      const r = await writeFresh(db, existing, (row) => ({ patch: lateClockOutPatch(row, { byUserId: userId, assertedOutAt }) }));
      if (r.notFound || r.retryable) return r;
      return { entry: r.entry, alreadyOut: true };
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
      if (assertedInAt && !sameInstant(openRow.clock_in_at, assertedInAt)) {
        const r = await writeFresh(db, openRow, (row) => {
          // Re-asked on the fresh row: a manager who corrected the clock-in to exactly the
          // asserted time in the gap leaves nothing to record (compared as instants, CS-694).
          if (!row.clock_in_at || sameInstant(row.clock_in_at, assertedInAt)) return { result: { entry: row, idempotent: true } };
          const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
          history.push({ at: nowIso(), byUserId: userId, field: 'offline_clock_in_arrived', from: row.clock_in_at, to: assertedInAt, reason: 'buffered offline clock-in arrived for an already-open entry' });
          return { patch: { edit_history: history } };
        });
        if (r.entry) return { entry: r.entry, idempotent: true };
        if (r.notFound || r.retryable) return r;
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
  // PAY-12: this shape is a buffered clock-in CARRYING its clock-out, so BOTH ends are measured
  // against the same site — reusing the ctx already resolved above. A clock-IN-only replay
  // closes nothing, so it records no out verdict.
  const outGeo = hasOut
    ? clockOutGeofenceFields(geofenceVerdict({
      siteLat: ctx.siteLat, siteLng: ctx.siteLng,
      deviceLat: Number.isFinite(outLat) ? outLat : null,
      deviceLng: Number.isFinite(outLng) ? outLng : null,
      accuracyM: outAccuracyM, radiusM: ctx.radiusM, enabled: ctx.geofenceEnabled,
      disabledReason: ctx.geofenceDisabledReason,
    }), { accuracyM: outAccuracyM })
    : {};

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
  // 🔴 PAY-13 / CS-318, the offline half: a buffered punch is NEVER REFUSED for overlapping
  // another open clean (THE LAW II.8 — the work happened and this punch is its only record).
  // It is accepted and FLAGGED, so it "shows at approval" exactly as an unfinished checklist
  // does. A failed read must not turn a buffered punch into a 500 that records nothing, so
  // the lookup is swallowed: worst case the punch lands unflagged, which is what it did
  // before this rule existed.
  try {
    const openElsewhere = await openPunchElsewhere(db, userId, ctx.job.id);
    if (openElsewhere) flags.push(overlapFlagNote(openPunchLabel(openElsewhere)));
  } catch (e) {
    console.error('[time/replay/overlap]', e?.code || 'read_failed');
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
    ...outGeo,                                // PAY-12, the clock-out end's own verdict
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
    updated_at: nowIso(),
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

// Manager correction of an existing entry (spec §5.1). The ROUTE has already resolved
// `existing`, gated it (scope / own / paid-lock) and validated the resulting times; this
// applies the change under the version CAS. `patch` carries clock_in_at / clock_out_at /
// note only — `status` is no longer accepted (Void/Restore own status). A changed clock
// time on an approved (or legacy rejected) punch sends it back to pending, clearing the
// approval and appending an approval history row; a clock-out set on an open punch closes
// it. `version` null = a legacy (unversioned) caller: the server re-reads and swaps on its
// own read (casBase). // TODO(remove-by: 2026-11-01)
export async function correctEntryRow({ existing, version = null, patch = {}, reason, byUserId }, db = getSupabase()) {
  const b = await casBase(db, existing, version);
  if (b.notFound) return b;
  const row = b.row;
  // 🔴 CS-694: what the patch CHANGES, the clock times compared as INSTANTS (lib/timeRules
  // correctionChanges — the demo stub runs the same rule). PostgREST spells a stored time
  // `…+00:00` and a browser `….000Z`, so a string compare made every save a time change: the
  // approved punch went back to pending, out of pay, with history lines for times nobody touched.
  // A save that changes nothing writes nothing — no version bump, no "Edited", no history.
  const { changes, timeChanged, newIn, newOut } = correctionChanges(row, patch);
  if (!Object.keys(changes).length) return { entry: row, unchanged: true };
  const update = { edited: true, edited_by: byUserId || null };
  const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
  for (const [field, to] of Object.entries(changes)) {
    history.push({ at: nowIso(), byUserId: byUserId || null, field, from: row[field] ?? null, to, reason: reason || null });
    update[field] = to;
  }
  // The paid minutes move only with the times — a note never re-prices a punch.
  if (timeChanged) update.duration_minutes = durationMins(newIn, newOut);
  // A clock-out set on an OPEN punch closes it — but never un-deletes one (F3): Restore
  // owns that, and only it knows what status the punch had before the delete.
  if (!row.clock_out_at && newOut) update.status = closedPunchStatus(row);
  // A changed clock TIME on an approved (or legacy rejected) punch → back to pending.
  if (timeChanged && (row.approval_status === 'approved' || row.approval_status === 'rejected')) {
    update.approval_status = 'pending';
    update.approved_by = null;
    update.approved_at = null;
    history.push({ at: nowIso(), byUserId: byUserId || null, field: 'approval', from: row.approval_status, to: 'pending', reason: 'times changed' });
  }
  update.edit_history = history;
  return updateEntry(db, row.id, b.base, update);
}

// Manager sign-off on ONE punch (spec §5.1). The route gates scope/own/closed/voided and
// judges idempotency (already-approved) before calling. CAS on the client's version.
export async function approveEntryRow({ existing, version = null, byUserId }, db = getSupabase()) {
  const b = await casBase(db, existing, version);
  if (b.notFound) return b;
  return updateEntry(db, b.row.id, b.base, {
    approval_status: 'approved', approved_by: byUserId || null, approved_at: nowIso(),
  });
}

// Delete a punch (Void): status → 'voided', approval reset to pending, approved fields
// cleared, a status history row with the required reason. CAS on the client's version.
export async function voidEntryRow({ existing, version = null, reason, byUserId }, db = getSupabase()) {
  const b = await casBase(db, existing, version);
  if (b.notFound) return b;
  const row = b.row;
  const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
  history.push({ at: nowIso(), byUserId: byUserId || null, field: 'status', from: row.status ?? null, to: 'voided', reason: reason || null });
  return updateEntry(db, row.id, b.base, {
    status: 'voided', approval_status: 'pending', approved_by: null, approved_at: null,
    edited: true, edited_by: byUserId || null, edit_history: history,
  });
}

// Restore a voided punch: status back to the value before the last void (from history;
// fallback 'completed' if closed else 'in_progress'), approval stays pending. CAS.
export async function restoreEntryRow({ existing, version = null, reason, byUserId }, db = getSupabase()) {
  const b = await casBase(db, existing, version);
  if (b.notFound) return b;
  const row = b.row;
  const hist = Array.isArray(row.edit_history) ? row.edit_history : [];
  let prior = null;
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    if (hist[i] && hist[i].field === 'status' && hist[i].to === 'voided') { prior = hist[i].from; break; }
  }
  // The pre-void status, or a sane fallback. A punch voided while OPEN and clocked out
  // afterwards (F3) records 'in_progress' as its prior status but now HAS a clock-out, and
  // an in_progress row carrying a clock-out is not a state this ledger has: it would sit
  // forever in Missing time's "missing clock-out" and never pay. It comes back completed.
  let status = prior || (row.clock_out_at ? 'completed' : 'in_progress');
  if (status === 'in_progress' && row.clock_out_at) status = 'completed';
  const history = hist.slice();
  history.push({ at: nowIso(), byUserId: byUserId || null, field: 'status', from: row.status ?? null, to: status, reason: reason || 'restored' });
  return updateEntry(db, row.id, b.base, {
    status, edited: true, edited_by: byUserId || null, edit_history: history,
  });
}

// Manager-entered time (no device clock event) — e.g. a forgotten clock-in. The route has
// resolved the clean's context (`ctx` from resolveJobContext), gated scope/own and
// validated the times; this inserts the pending row. Lands approval_status 'pending' so a
// manual add into closed territory pays only once approved (as arrears, §6.1).
export async function manualEntry({ ctx = null, jobId = null, userId, clockInAt, clockOutAt, note, reason, byUserId }, db = getSupabase()) {
  const c = ctx || await resolveJobContext(jobId, userId);
  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    job_id: c.job?.id || jobId || null,
    series_id: c.job?.seriesId || null,
    shift_id: c.job?.shiftId || null,
    client_id: c.clientId,
    site_id: c.job?.siteId || null,
    user_id: userId,
    client_name: c.clientName,
    site_name: c.siteName,
    user_name: c.userName,
    scheduled_start: c.job?.startAt || null,
    scheduled_end: c.job?.endAt || null,
    expected_minutes_snapshot: c.expectedMins,
    clock_in_at: clockInAt || nowIso(),
    clock_out_at: clockOutAt || null,
    duration_minutes: durationMins(clockInAt, clockOutAt),
    geofence_result: 'override',
    override_reason: reason || 'manual_entry',
    override_by_user_id: byUserId || null,
    source: 'admin_manual',
    status: clockOutAt ? 'manual' : 'in_progress',
    approval_status: 'pending',
    note: note || null,
    edited: true,
    edited_by: byUserId || null,
    updated_at: nowIso(),
    edit_history: [{ at: nowIso(), byUserId: byUserId || null, field: 'created', from: null, to: 'manual', reason: reason || null }],
  };
  const { data, error } = await db.from(TABLE).insert(row).select('*').single();
  if (error) throw error;
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

// 🔴 HUB-7: WHO IS IN THIS BUILDING RIGHT NOW. The user ids on an OPEN punch (clocked in,
// not yet out) at this site — or, with no site on the record, at this customer. That is
// Matt's "the cleaners on site": a failed inspection's redo notice goes to the people who
// can still act on it, and to the account's supervisor only when nobody is.
//
// A punch, not the schedule: a cleaner rostered for tonight who has not turned up cannot
// redo an area, and a cover who IS there is not on the roster. `clock_out_at is null` is
// the same predicate `listOpen` uses — there is no second definition of "on the clock".
// Narrow (one column) and de-duplicated: two punches by one person are one recipient.
export async function openPunchUserIdsAt({ siteId = null, clientId = null } = {}, db = getSupabase()) {
  if (!siteId && !clientId) return [];
  let q = db.from(TABLE).select('user_id')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .is('clock_out_at', null);
  // The SITE is the building; the customer is the fallback for a record filed without one
  // (every QC writer stores `site_id: siteId || null`). Never both — widening to the whole
  // customer when the site IS known would page cleaners in a different building.
  q = siteId ? q.eq('site_id', siteId) : q.eq('client_id', clientId);
  const { data, error } = await q;
  if (error) throw error;
  return [...new Set((data || []).map((r) => r?.user_id).filter(Boolean))];
}

// 🔴 QR Wave 2 (EP-419 / EP-420): WHO HAS CLOCKED IN TO THESE CLEANS — the people a filler may
// NOT cover (they are here). A punch, voided and no-show ones excepted (they count for nobody, as
// in coverage), open or closed (someone who came and left was still here). READ ONLY: a scan
// never writes a punch, an approval or anything the variance report reads (QR-13, "GPS only").
// One narrow read per 200 cleans; a handful of punches per clean.
// → Map jobId → Set(userId), every asked id present.
export async function punchedUserIdsByJob(jobIds = [], db = getSupabase()) {
  const list = [...new Set((Array.isArray(jobIds) ? jobIds : []).filter((id) => typeof id === 'string' && id))];
  const out = new Map(list.map((id) => [id, new Set()]));
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await db.from(TABLE).select('job_id,user_id')
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .in('job_id', list.slice(i, i + 200))
      .neq('status', 'voided').neq('status', 'no_show');
    if (error) throw error;
    for (const r of data || []) if (r?.job_id && r.user_id) out.get(r.job_id)?.add(r.user_id);
  }
  return out;
}

// Everyone currently on the clock (manager view: Variance's "On the clock now") — EVERY open
// punch, newest clock-in first (CS-726). PostgREST answers at most db-max-rows (1,000) rows a
// request whatever the read asks for, so the old single read, oldest first, dropped the NEWEST
// clock-ins once more than 1,000 people were on the clock — a shift start at Matt's 1,500
// cleaners. A complete read (pagedSelect selectAll: count-first, ordered pages, overlap for
// the punches that close mid-read); an answer still short of the count is an
// IncompleteReadError, which the route answers 503 (readErrorStatus), never part of the list.
export async function listOpen(db = getSupabase()) {
  const open = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID).is('clock_out_at', null);
  return selectAll({
    count: async () => {
      const { count, error } = await open(db.from(TABLE).select('id', { count: 'exact', head: true }));
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await open(db.from(TABLE).select('*'))
        .order('clock_in_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
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
// edit_history says whether a manager corrected an auto-closed clock-out; row_version lets
// the Approvals screen offer "Fix clock-out" on a missing_clock_out row (the CAS the edit
// route wants).
export const ATTENDANCE_COLUMNS = 'id,row_version,job_id,user_id,user_name,site_id,client_id,clock_in_at,clock_out_at,status,approval_status,edit_history';
// What drive-segment derivation reads (driveCompute.mapRow).
export const DRIVE_COLUMNS = 'id,user_id,user_name,site_id,site_name,client_id,client_name,clock_in_at,clock_out_at,status,approval_status';
const ROLLUP_COLUMNS = 'id,user_id,user_name,site_id,client_id,site_name,client_name,duration_minutes,clock_in_at,clock_out_at,approval_status,status,job_cancelled_at';
// What the OT ledger reads (otLedger.entryFromRow) — the punches the weekly 40 h walk needs.
export const LEDGER_ENTRY_COLUMNS = ROLLUP_COLUMNS;
// The pending-punch row the Approvals "To approve" tab shows (spec §5.1); row_version rides
// the Approve CAS, edit_history explains the flags.
// PAY-12 added the three clock-OUT verdict columns: the queue can only flag what it SELECTS, and
// an off-site clock-out that reached no approver would be a verdict written by one module and
// read by none (the lesson of the checklist note, W5-M F4).
export const APPROVALS_PENDING_COLUMNS = 'id,row_version,user_id,user_name,client_id,client_name,site_id,job_id,clock_in_at,clock_out_at,duration_minutes,expected_minutes_snapshot,status,approval_status,geofence_result,geofence_result_out,override_reason_out,clock_out_distance_m,source,edited,job_cancelled_at,note,override_reason,edit_history';

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

// My Hours (the Cleaner Hub, brief C §3; EP-381): ONE person's punches in a pay period —
// COMPLETE (count-first, ordered pages through listForReportAll; never `listMine`'s newest 100,
// which a busy period passes) and narrow (what lib/myHours myHoursPeriod reads: no names, no
// places, no notes). `userIds` is one id, so the read is that person's IN the query.
export const MY_HOURS_COLUMNS = 'id,clock_in_at,clock_out_at,duration_minutes,status,approval_status';
export async function listOwnPunchesInWindow({ userId, fromIso, toIso } = {}, db = getSupabase()) {
  if (!userId || !fromIso || !toIso) return [];
  return listForReportAll({ fromIso, toIso, userIds: [userId] }, { columns: MY_HOURS_COLUMNS }, db);
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

// The COMPLETE set of CLOSED, PENDING punches for the Approvals "To approve" tab (spec
// §5.1): clock-out set, approval pending, not voided/no-show, and (when a run exists) not
// pre-ledger (clock-in >= the first run's window start). Scoped by clientIds (a manager's
// supervised customers) and/or userIds when the caller pushes them; the route still filters
// to WORKED (duration > 0) + GATED people in JS. Oldest first, no silent cap — a busy day
// must never leave older pending punches unlisted.
function applyPendingFilters(q, { fromIso, clientIds, userIds } = {}) {
  let out = q.eq('organization_id', CLEANSPACE_ORG_ID)
    .not('clock_out_at', 'is', null)
    .eq('approval_status', 'pending')
    .neq('status', 'voided').neq('status', 'no_show');
  if (fromIso) out = out.gte('clock_in_at', fromIso);
  if (Array.isArray(clientIds) && clientIds.length) out = out.in('client_id', clientIds);
  if (Array.isArray(userIds) && userIds.length) out = out.in('user_id', userIds);
  return out;
}
export async function listPendingApprovalsAll({ fromIso, clientIds, userIds } = {}, db = getSupabase()) {
  const filters = { fromIso, clientIds, userIds };
  return selectAll({
    count: async () => {
      const { count, error } = await applyPendingFilters(db.from(TABLE).select('id', { count: 'exact', head: true }), filters);
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await applyPendingFilters(db.from(TABLE).select(APPROVALS_PENDING_COLUMNS), filters)
        .order('clock_in_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
}

// Auto-close entries left open past their anchor + grace (a forgotten clock-out). WHEN and AT
// WHAT TIME is the shared rule in lib/autoClose.js: a punch that started inside the clean closes
// AT the scheduled end (PAY-10 — a forgotten clock-out never inflates labor), and one that
// started at or after the scheduled end (CS-667) is credited the clean's scheduled length from
// its own clock-in, at most the grace, closed a grace after that — never a clock-out before the
// clock-in. Status 'auto_closed' (+ the history line saying which) flags it for the approver;
// it stays pending. Entries with no scheduled_end are left alone (nothing to anchor to →
// manual). The cron route gates this on CRON_SECRET. See CLEANSPACE_SWEPT.md §5.4.
//
// THE READ (F12-06): only open punches whose scheduled end is at least the grace ago — the
// earliest any punch can be due — complete, ordered and paged. It used to read every open
// punch, unordered, in one response: PostgREST's row cap then let punches with no scheduled end
// (never due, so never closed) crowd out the ones that were.
export async function autoCloseStale({ graceMinutes = 120, now = Date.now() } = {}, db = getSupabase()) {
  const cutoffIso = autoCloseCutoffIso(now, graceMinutes);
  const candidates = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID)
    .is('clock_out_at', null).eq('status', 'in_progress').lte('scheduled_end', cutoffIso);
  const openRows = await selectAll({
    count: async () => {
      const { count, error } = await candidates(db.from(TABLE).select('id', { count: 'exact', head: true }));
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await candidates(db.from(TABLE).select('*'))
        .order('scheduled_end', { ascending: true }).order('id', { ascending: true }).range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
  const closed = [];
  const jobIds = new Set(); // the cleans whose punches it closed — api/time settles each (CS-051)
  // Whether a row still qualifies — asked of the row the scan READ and again of the FRESH
  // row before each write, because the cron's scan-then-write window is long enough for a
  // manager to close (or delete) a punch underneath it, and re-closing it would overwrite
  // their clock-out with the scheduled end.
  const stillStale = (r) => !r.clock_out_at && r.status === 'in_progress' && autoCloseDue(r, graceMinutes, now);
  for (const e of openRows) {
    if (!stillStale(e)) continue;
    const r = await writeFresh(db, e, (row) => {
      if (!stillStale(row)) return { result: { skipped: true } };
      const a = autoCloseAnchor(row, graceMinutes);
      // PAY-10: the scheduled end as stored; a late start: its own clock-in + the credited minutes.
      const out = a.lateStart ? new Date(a.closeAtMs).toISOString() : row.scheduled_end;
      const reason = a.lateStart
        ? lateStartAutoCloseNote(a.creditedMins, graceMinutes)
        : `auto-closed: open past scheduled end + ${graceMinutes}m grace`;
      const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
      history.push({ at: nowIso(), byUserId: null, field: 'status', from: row.status, to: 'auto_closed', reason });
      return {
        patch: {
          clock_out_at: out,
          duration_minutes: durationMins(row.clock_in_at, out),
          status: 'auto_closed',
          edited: true,
          edit_history: history,
        },
      };
    });
    if (r.entry) {
      closed.push(r.entry.id);
      if (r.entry.job_id) jobIds.add(r.entry.job_id);
    }
  }
  return { closed: closed.length, ids: closed, jobIds: [...jobIds] };
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
    // Whether this punch is still OPEN is re-asked of the FRESH row inside the write: a
    // manager can close one between this scan and the write, and clocking it out again
    // would overwrite their time with the cancel moment.
    let didClose = false;
    const r = await writeFresh(db, e, (row) => {
      const history = Array.isArray(row.edit_history) ? row.edit_history.slice() : [];
      const patch = { job_cancelled_at: nowStamp, edited: true };
      didClose = !row.clock_out_at;
      if (didClose) {
        let out = nowStamp;
        if (row.scheduled_end && new Date(row.scheduled_end).getTime() < new Date(out).getTime()) out = row.scheduled_end;
        if (row.clock_in_at && new Date(out).getTime() < new Date(row.clock_in_at).getTime()) out = row.clock_in_at;
        patch.clock_out_at = out;
        patch.duration_minutes = durationMins(row.clock_in_at, out);
        patch.status = closedPunchStatus(row);              // a DELETED punch stays deleted (F3)
        history.push({ at: nowStamp, byUserId: null, field: 'job_cancelled', from: row.status ?? null, to: patch.status, reason: 'clean cancelled, clocked out at cancel' });
      } else {
        history.push({ at: nowStamp, byUserId: null, field: 'job_cancelled', from: null, to: null, reason: 'clean cancelled after this punch' });
      }
      patch.edit_history = history;
      return { patch };                                 // bumps row_version + stamps updated_at
    });
    if (!r.entry) continue;                             // gone, or contended past the retries
    if (didClose) closed += 1;
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
      updated_at: nowIso(),
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
