// The activity log's SERVER layer — the one writer, the scoped reads, the retention purge
// and the client hub's service-event selection. CS-379; Matt's answers LOG-1..8.
//
// 🔴 THE LOG IS WRITTEN ONLY FROM HERE, ONLY UNDER THE SERVICE ROLE. `activity_log` has RLS
// on with no policies and no UPDATE grant for anybody, so a browser cannot write, edit or
// forge a row, and neither can a bug in our own code edit one. The vocabulary is
// src/lib/activityLog.js ACTIONS; an unknown action is refused rather than stored, so "what
// is logged" stays one readable table.
//
// 🔴 BEST-EFFORT AT THE CALL SITE, LOUD IN THE LOGS. A failed log write must never fail the
// user's action — a door-code reveal, a time correction or a save that already committed
// cannot be undone because the audit row didn't land. So every writer here swallows its
// error and reports it through the monitor (`activity_log.write_failed`), which is the
// signal that the trail has a hole. Nothing here throws.
//
// WHO SEES WHAT is applied on the READ (LOG-4): the owner everything, an admin everything
// except pay and money, a manager only the customers they supervise, crew nothing. It is a
// SQL predicate (is_money = false / client_id in (...)), not a post-filter, because a
// post-filter would make paging lie about its totals.
import { getSupabase } from './supabase.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { readProtectedSlices } from './orgState.js';
import { cached } from './requestCache.js';
import { reportError } from './monitor.js';
import { selectAll, exactCount, withRetry } from './pagedSelect.js';
import { isOpsManagerIn, teamClientIds } from '../../src/lib/teamScope.js';
import {
  ACTIONS, isKnownAction, isMoneyAction, isAutoAction, actionEntity,
  LOG_VISIBILITY, logVisibilityFor, supervisedClientIds, retentionCutoffIso,
  orgStateActivityEvents, activityDigestInput, ACTIVITY_SELECT,
  selectServiceEvents, SERVICE_EVENT_ACTIONS,
} from '../../src/lib/activityLog.js';

const TABLE = 'activity_log';
const BASELINE = 'activity_log_baseline';
// Every column a read serves. Explicit, so a column added later is not served by accident.
export const ACTIVITY_COLUMNS = 'id, occurred_at, actor_user_id, actor_name, actor_role, auto, '
  + 'action, entity_type, entity_id, client_id, client_name, summary, before, after, is_money';

// ── the writer ──────────────────────────────────────────────────────────────

// One row, ready for insert. PURE and exported so the tests can assert the shape (and the
// money flag) without a database. Returns null for an action outside the vocabulary.
export function activityRow(entry = {}) {
  const action = entry.action;
  if (!isKnownAction(action)) return null;
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  if (!summary) return null;
  const auto = entry.auto === undefined ? isAutoAction(action) : !!entry.auto;
  const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
  return {
    organization_id: entry.orgId || CLEANSPACE_ORG_ID,
    occurred_at: entry.occurredAt || new Date().toISOString(),
    // An automatic action has no person behind it; anything else takes the actor from the
    // caller's verified claim (never the request body).
    actor_user_id: auto ? null : str(entry.actorUserId, 64),
    actor_name: auto ? null : str(entry.actorName, 200),
    actor_role: auto ? null : str(entry.actorRole, 32),
    auto,
    action,
    entity_type: str(entry.entityType, 40) || actionEntity(action),
    entity_id: str(entry.entityId, 128),
    client_id: str(entry.clientId, 128),
    client_name: str(entry.clientName, 200),
    summary: summary.slice(0, 1000),
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
    // From the shared registry, never the caller — an admin's "no pay or money" filter
    // (LOG-4) is only as good as this flag, so a call site cannot get it wrong.
    is_money: isMoneyAction(action),
  };
}

// Log ONE action. Best-effort: returns the stored row, or null when it could not be written
// (reported, never thrown). `db` last, like every other store here, so the offline suite can
// inject the fake client.
export async function logActivity(entry, db = null) {
  const rows = await logActivities([entry], db);
  return rows[0] || null;
}

// Log several in ONE insert (a save's diff, a cron's raised alerts). Same contract.
//
// 🔴 `db` DEFAULTS TO NULL AND IS RESOLVED INSIDE THE TRY, never as a default parameter:
// `getSupabase()` THROWS when SUPABASE_URL / the service-role key are unset, and a default
// parameter is evaluated before the try — which made this writer throw out of a cron whose
// own suite runs without credentials. A writer whose whole contract is "never fail the
// caller's action" must not be able to throw on the way in.
export async function logActivities(entries, db = null) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return [];
  const rows = [];
  for (const e of list) {
    const row = activityRow(e);
    if (row) rows.push(row);
    else {
      reportError('activity_log.refused_entry', new Error(`refused an entry the vocabulary does not cover: ${JSON.stringify({ action: e?.action, summary: (e?.summary || '').slice(0, 60) })}`), {});
    }
  }
  if (!rows.length) return [];
  try {
    const { data, error } = await (db || getSupabase()).from(TABLE).insert(rows).select(ACTIVITY_COLUMNS);
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    // The hole in the trail is the thing to notice, so name what was lost.
    reportError('activity_log.write_failed', err, {
      count: rows.length,
      actions: [...new Set(rows.map((r) => r.action))],
      actor: rows[0]?.actor_user_id || null,
    });
    return [];
  }
}

// Log ONE action AT MOST ONCE, under an id the caller derives from what it is about (Crew on the
// way: one row per clean). A row that is the user's action itself, not a trail of it, so the answer
// is told, never swallowed: 'won' (written now), 'already' (that id is in the log: Postgres's 23505
// on the primary key, so two taps racing write one row) or 'failed' (reported, as every write here).
export async function logActivityOnce(id, entry, db = null) {
  const row = activityRow(entry);
  if (!row || typeof id !== 'string' || !id) {
    reportError('activity_log.refused_entry', new Error(`refused a once-only entry: ${JSON.stringify({ action: entry?.action, id })}`), {});
    return 'failed';
  }
  try {
    const { error } = await (db || getSupabase()).from(TABLE).insert([{ ...row, id }]);
    if (!error) return 'won';
    if (error.code === '23505') return 'already';
    throw new Error(error.message);
  } catch (err) {
    reportError('activity_log.write_failed', err, { count: 1, actions: [row.action], actor: row.actor_user_id || null });
    return 'failed';
  }
}

// Whether each id is in the log already (the once-only rows above). Throws on a failed read.
export async function activityIdsPresent(ids, db = null) {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  if (!list.length) return new Set();
  const { data, error } = await (db || getSupabase()).from(TABLE).select('id')
    .eq('organization_id', CLEANSPACE_ORG_ID).in('id', list);
  if (error) throw new Error(`activity_log read failed: ${error.message}`);
  return new Set((data || []).map((r) => r.id));
}

// The actor's display name, denormalized at write time so a three-year-old row still reads
// correctly after a rename. Read from the roster PROJECTION (small) through the per-request
// cache, and best-effort: no name is a cosmetic loss, never a reason to skip the row.
export async function actorNameFor(orgUserId) {
  if (!orgUserId) return null;
  try {
    const users = await cached('activityActorNames', async () => {
      const data = await readProtectedSlices('users:state->users');
      return Array.isArray(data?.users) ? data.users : [];
    });
    return users.find((u) => u && u.id === orgUserId)?.name || null;
  } catch { return null; }
}

// logActivity with the actor's name filled in from the roster. For a call site that holds
// the authority object but not the roster (most routes).
export async function logActivityAs(authority, entry, db = getSupabase()) {
  const actorUserId = authority?.orgUserId || null;
  return logActivity({
    ...entry,
    actorUserId,
    actorRole: authority?.role || null,
    actorName: entry.actorName ?? await actorNameFor(actorUserId),
  }, db);
}

// ── the reads (LOG-4 visibility) ────────────────────────────────────────────

// Turn a viewer into the read's SCOPE, or a refusal. `clients` is the committed customers
// slice (needed only for a manager). Returns { refused: true } for crew and any unresolved
// role — a role floor no per-user grant can lift (see logVisibilityFor).
// `users` (the committed roster, S131): an Operations Manager's "customers they supervise" are
// their TEAM's (lib/teamScope teamClientIds — their own and their account managers'); the role is
// the claim's. Without it the rule is the manager's own customers, as before.
export function activityScopeFor({ role, orgUserId }, clients, users = null) {
  const visibility = logVisibilityFor(role);
  if (visibility === LOG_VISIBILITY.NONE) return { refused: true, visibility };
  if (visibility === LOG_VISIBILITY.SUPERVISED) {
    const ids = Array.isArray(users) && isOpsManagerIn(users, { id: orgUserId, role })
      ? [...teamClientIds(users, clients, orgUserId)]
      : supervisedClientIds(clients, orgUserId);
    // A manager who supervises nothing sees nothing — an empty scope, never "everything".
    return { refused: false, visibility, clientIds: ids, noMoney: true };
  }
  return { refused: false, visibility, clientIds: null, noMoney: visibility === LOG_VISIBILITY.NO_MONEY };
}

// Apply the filters + the scope to a query. ONE definition, so the count and the page can
// never disagree (which is what makes paging honest).
function applyActivityFilters(q, filters = {}, scope = {}) {
  q = q.eq('organization_id', CLEANSPACE_ORG_ID);
  if (filters.fromIso) q = q.gte('occurred_at', filters.fromIso);
  if (filters.toIso) q = q.lte('occurred_at', filters.toIso);
  if (filters.clientId) q = q.eq('client_id', filters.clientId);
  if (filters.actorUserId) q = q.eq('actor_user_id', filters.actorUserId);
  if (Array.isArray(filters.actions) && filters.actions.length) q = q.in('action', filters.actions);
  // ── the scope, applied last and never overridable by a filter ──
  if (scope.noMoney) q = q.eq('is_money', false);
  if (Array.isArray(scope.clientIds)) {
    // A manager: only their supervised customers. An empty list must match NOTHING, and
    // `in('client_id', [])` does exactly that in PostgREST.
    q = q.in('client_id', scope.clientIds);
  }
  return q;
}

export async function countActivity(filters = {}, scope = {}, db = getSupabase()) {
  const { count, error } = await applyActivityFilters(
    db.from(TABLE).select('id', { count: 'exact', head: true }), filters, scope,
  );
  if (error) throw new Error(`activity_log count failed: ${error.message}`);
  return exactCount(count);
}

// One page, NEWEST FIRST. `.order(occurred_at).order(id)` before `.range()` so pages are
// deterministic even when two rows share a timestamp (lint:paging).
export async function pageActivity(filters = {}, scope = {}, { offset = 0, limit = 50 } = {}, db = getSupabase()) {
  const { data, error } = await applyActivityFilters(db.from(TABLE).select(ACTIVITY_COLUMNS), filters, scope)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + Math.max(1, limit) - 1);
  if (error) throw new Error(`activity_log read failed: ${error.message}`);
  return data || [];
}

// EVERY matching row, paged to completeness (the exports — a dispute needs the whole
// window, not the newest page). Throws IncompleteReadError rather than serving a short set.
export async function listActivityAll(filters = {}, scope = {}, { maxRows = 50000 } = {}, db = getSupabase()) {
  return selectAll({
    count: () => countActivity(filters, scope, db),
    page: (from, to) => withRetry(async () => {
      const { data, error } = await applyActivityFilters(db.from(TABLE).select(ACTIVITY_COLUMNS), filters, scope)
        // OLDEST first for an export: a document reads forward in time.
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw new Error(`activity_log export read failed: ${error.message}`);
      return data || [];
    }),
    maxRows,
  });
}

// ── retention (LOG-5): the purge that rides the daily cron ───────────────────
// Deletes only what is past the 3-year horizon; the table's own trigger refuses anything
// newer, so this is belt and braces with the database rather than the only guard.
export async function purgeExpiredActivity({ now = Date.now() } = {}, db = null) {
  const cutoff = retentionCutoffIso(now);
  try {
    const { data, error } = await (db || getSupabase()).from(TABLE).delete()
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .lt('occurred_at', cutoff)
      .select('id');
    if (error) throw new Error(error.message);
    return { purged: (data || []).length, cutoff };
  } catch (err) {
    reportError('activity_log.purge_failed', err, { cutoff });
    return { purged: 0, cutoff, failed: true };
  }
}

// ── the shared-record (org_state) diff ──────────────────────────────────────
// The write path's contract is two calls, both of which can be ignored safely:
//
//   const plan = collectOrgStateActivity({ state, baseVersion, authority });  // started, not awaited
//   … the existing guard's reads …
//   const ready = await plan;            // 🔴 BEFORE the CAS write, never after
//   … the CAS write …
//   if (committed) await commitOrgStateActivity(ready, newVersion);
//
// `collect` is STARTED without awaiting, so its one small read overlaps the guard's own reads
// and adds no wall-clock time to a save. It is AWAITED BEFORE THE WRITE, because the diff's
// previous values come from the row the write is about to replace: let the write land first
// and the read returns the NEW state, the diff finds nothing, and the change is never logged.
// (That is not theoretical — it is what the first run of the handler test did.)
// It never rejects.
//
// COST. The common save touches nothing loggable, and then the whole cost is: one hash of
// the loggable fields from the state already in memory, plus one ~100-byte read of the
// baseline row (concurrent). Only a save that actually changed a pay rate, a role, a
// customer, an invoice amount or a supply-request status pays the slice read and the diff.
// Measured in app/scripts/test-activity-log.mjs.

let nodeCrypto = null;
async function sha256(text) {
  if (!nodeCrypto) nodeCrypto = await import('node:crypto');
  return nodeCrypto.createHash('sha256').update(text).digest('hex');
}

// The hash of exactly the fields the diff reads (src/lib/activityLog.js activityDigestInput).
export async function activityFingerprint(state) {
  return sha256(activityDigestInput(state));
}

export async function readActivityBaseline(db = null) {
  const { data, error } = await (db || getSupabase()).from(BASELINE)
    .select('state_version, fingerprint')
    .eq('organization_id', CLEANSPACE_ORG_ID).maybeSingle();
  if (error) throw new Error(`activity baseline read failed: ${error.message}`);
  return data || null;
}

export async function writeActivityBaseline({ version, fingerprint }, db = null) {
  const { error } = await (db || getSupabase()).from(BASELINE).upsert({
    organization_id: CLEANSPACE_ORG_ID,
    state_version: version,
    fingerprint,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'organization_id' });
  if (error) throw new Error(`activity baseline write failed: ${error.message}`);
}

// Decide what this save would log. Never rejects; on any trouble it returns a plan that
// logs nothing and says why.
export function collectOrgStateActivity({ state, baseVersion, authority } = {}, db = getSupabase()) {
  return (async () => {
    const plan = { events: [], fingerprint: null, skipped: null };
    try {
      plan.fingerprint = await activityFingerprint(state);
      // A baseline that cannot be READ is not a reason to go blind: it is a cache, so an
      // unreadable one falls through to the slice read below (fail toward MORE logging, never
      // less — the diff itself is authoritative).
      let baseline = null;
      try { baseline = await readActivityBaseline(db); }
      catch (err) { reportError('activity_log.baseline_read_failed', err, {}); }
      // Trusted only while it describes the very version this write replaces (the same
      // rule as orgStateGuard's isDigestCurrent). Anything else pays the read.
      const fresh = baseline && baseline.state_version === baseVersion;
      if (fresh && baseline.fingerprint === plan.fingerprint) return plan; // nothing loggable moved
      const prev = await readProtectedSlices(ACTIVITY_SELECT);
      // The write replaces exactly `baseVersion`; a row at another version means the CAS is
      // about to miss anyway, so judge nothing rather than diff against the wrong past.
      if (!prev || prev.version !== baseVersion) { plan.skipped = 'version-moved'; return plan; }
      const events = orgStateActivityEvents(prev, state);
      if (!events.length) return plan;   // the baseline was stale, but nothing loggable moved
      // The actor's name comes out of the read we JUST did, never a second projection: this
      // path is the expensive one, and `users` is already in it.
      const actorName = (Array.isArray(prev.users) ? prev.users : [])
        .find((u) => u && u.id === authority?.orgUserId)?.name || null;
      const clientsById = new Map((Array.isArray(state?.clients) ? state.clients : []).map((c) => [c.id, c]));
      plan.events = events.map((e) => ({
        ...e,
        actorUserId: authority?.orgUserId || null,
        actorRole: authority?.role || null,
        actorName,
        clientName: e.clientId ? (clientsById.get(e.clientId)?.name || null) : null,
      }));
      return plan;
    } catch (err) {
      reportError('activity_log.org_state_diff_failed', err, { caller: authority?.orgUserId || null });
      plan.skipped = 'diff-failed';
      return plan;
    }
  })();
}

// Write what the plan found, then move the baseline forward. Best-effort throughout: the
// save has already committed. A baseline that fails to advance only costs the next save one
// read, because the diff's previous values always come from org_state, never the baseline.
export async function commitOrgStateActivity(planPromise, committedVersion, db = getSupabase()) {
  let plan;
  try { plan = await planPromise; } catch { return { logged: 0 }; }
  if (!plan) return { logged: 0 };
  let logged = 0;
  if (plan.events.length) logged = (await logActivities(plan.events, db)).length;
  if (plan.fingerprint && Number.isInteger(committedVersion)) {
    try { await writeActivityBaseline({ version: committedVersion, fingerprint: plan.fingerprint }, db); }
    catch (err) { reportError('activity_log.baseline_write_failed', err, { version: committedVersion }); }
  }
  return { logged, skipped: plan.skipped || null };
}

// ── the client hub's service-event subset (HUB-9, LOG-1, LOG-9) ─────────────
// The inputs of the history GET /api/hub/history serves; the log itself stays staff-only
// (LOG-9 ★a). The selection is the pure function in src/lib/activityLog.js — this only fetches
// its inputs, so what a customer may see is decided in one readable place and unit-tested
// without a database.
//
//   · NARROW reads: the punches' seven columns the selection reads (never pay, distance or
//     coordinates), and only the activity actions the selection keeps (SERVICE_EVENT_ACTIONS),
//     so a year of a busy building's log is not paged through to keep a few rows.
//   · `tickets` are the building's CLIENT tickets in the window (the caller reads them:
//     clientHub/reads.historyTickets). They are the "ticket raised" rows AND the filter on the
//     log's ticket rows — an office-internal ticket's status changes never reach a customer.
//     Omitted, NO ticket progress is shown (fail closed), never every ticket's.
//   · 🔴 A FAILED READ THROWS. This is the customer's proof of service: a history that quietly
//     dropped the arrivals (a timed-out punch read) would tell them nobody came. The route
//     answers "could not be loaded, try again" instead.
//   · `maxRows` bounds each read; past it the read throws TooManyRowsError (the route's 503).
export const SERVICE_TIME_COLUMNS = 'id,user_name,site_id,client_id,clock_in_at,clock_out_at,status';
export async function serviceEventsForClient({ clientId, fromIso, toIso, tickets = [] }, db = getSupabase(), { maxRows = 20000 } = {}) {
  if (!clientId) return [];
  const { listForReportAll } = await import('./time/store.js');
  const { listChecklistsInWindow, listInspectionsInWindow } = await import('./qc/store.js');
  const window = { fromIso, toIso };
  const [timeEntries, checklists, inspections, activity] = await Promise.all([
    listForReportAll({ ...window, clientIds: [clientId] }, { columns: SERVICE_TIME_COLUMNS, maxRows }, db),
    listChecklistsInWindow({ ...window, clientId }, { maxRows }, db),
    listInspectionsInWindow({ ...window, clientId }, { maxRows }, db),
    listActivityAll({ ...window, clientId, actions: [...SERVICE_EVENT_ACTIONS] }, {}, { maxRows }, db),
  ]);
  const ticketList = Array.isArray(tickets) ? tickets : [];
  return selectServiceEvents({
    activity: activity.map((r) => ({
      action: r.action, occurredAt: r.occurred_at, clientId: r.client_id, entityId: r.entity_id, after: r.after,
    })),
    timeEntries, checklists, inspections,
    tickets: ticketList,
    ticketIds: ticketList.map((t) => t && t.id).filter(Boolean),
  });
}

export { ACTIONS };
