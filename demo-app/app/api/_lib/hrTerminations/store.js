// Service-role data layer for HR TERMINATIONS (Super Clippy's idea #513 from Clean Corner's
// queue, 2026-11-05: Matt's termination form in HR, set up like warnings and incident reports).
//
// One table, `hr_terminations` (migration 20261105120000_hr_terminations.sql explains why it is
// not in org_state). Nothing but this module touches it; app/api/hr-terminations/* and the
// ops-alerts cron (through ./access.js) call it.
//
// 🔴 THE RULES THIS MODULE KEEPS, SO NO CALLER HAS TO REMEMBER THEM
//  1. LOCKED ONCE FILED. There is no edit path and no delete path. A termination changes only by
//     the void and by its login moving forward (`access_state`), and each is a CONDITIONAL update
//     on the state it read, so two voids at once cannot both win and a turn-off and a void racing
//     each other always leave one truthful answer. The table's own trigger refuses the rest.
//  2. ONE LIVE TERMINATION PER PERSON: a second filing for someone already terminated (not voided)
//     is refused here, and the table's partial unique index is the belt under it.
//  3. NAMES ARE STAMPED AT WRITE from the committed roster, so a departed employee's termination
//     still reads with their name, and so does their manager's.
//  4. DATES: `termination_date` is the org's DAY KEY, and the caller supplies `today` in the org
//     zone — this module never asks a clock for a day.
//  5. READS ARE COMPLETE (selectAll: count-first, ordered, paged).
//
// `db` is the LAST argument everywhere and defaults to the real client, so the offline suite
// injects a PostgREST stand-in.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { selectAll } from '../pagedSelect.js';
import { english } from '../../../src/i18n/core.js';
import {
  TERMINATION_STATUS, ACCESS_STATE, TERMINATION_TEXT_MAX, TERMINATION_REFUSAL_KEYS,
  terminationDraftRefusal, terminationAnswers, isDirectManagerChoice, isDayKey, isTerminationId,
} from '../../../src/lib/hrTerminations.js';

const T = 'hr_terminations';

export { isTerminationId };

// A caller-visible refusal: the route turns it into a 4xx with this message (English — API
// bodies stay English, LANG-8) and the code the screen words in the reader's language.
export class TerminationRefusal extends Error {
  constructor(code, { status = 400, message } = {}) {
    super(message || (TERMINATION_REFUSAL_KEYS[code] ? english(TERMINATION_REFUSAL_KEYS[code]) : code));
    this.name = 'TerminationRefusal';
    this.code = code;
    this.status = status;
  }
}

const throwIf = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
const text = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const list = (v) => (Array.isArray(v) ? v : []);

// row → the camelCase shape every screen reads (the demo stub writes the same shape).
export function toTermination(r) {
  if (!r) return null;
  return {
    id: r.id,
    employeeUserId: r.employee_user_id,
    employeeName: r.employee_name || null,
    terminationDate: r.termination_date,
    managerUserId: r.manager_user_id,
    managerName: r.manager_name || null,
    reasons: list(r.reasons),
    reasonOther: r.reason_other || null,
    filedAt: r.filed_at,
    filedByUserId: r.filed_by_user_id || null,
    filedByName: r.filed_by_name || null,
    status: r.status,
    voidedAt: r.voided_at || null,
    voidedByUserId: r.voided_by_user_id || null,
    voidedByName: r.voided_by_name || null,
    voidReason: r.void_reason || null,
    accessState: r.access_state,
    accessEndedAt: r.access_ended_at || null,
    statusBefore: r.status_before || null,
    accessRestoredAt: r.access_restored_at || null,
  };
}

const scoped = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID);

// Every termination, newest first — or one employee's (their HR card).
export async function listTerminations({ employeeUserId = null } = {}, db = getSupabase()) {
  const scope = (q) => {
    const x = scoped(q);
    return employeeUserId ? x.eq('employee_user_id', employeeUserId) : x;
  };
  const rows = await selectAll({
    count: async () => {
      const { count, error } = await scope(db.from(T).select('id', { count: 'exact', head: true }));
      throwIf(error, 'count hr_terminations');
      return count;
    },
    page: async (from, to) => {
      const { data, error } = await scope(db.from(T).select('*'))
        .order('filed_at', { ascending: false }).order('id').range(from, to);
      throwIf(error, 'read hr_terminations');
      return data || [];
    },
  });
  return rows.map(toTermination);
}

export async function getTermination(id, db = getSupabase()) {
  if (!isTerminationId(id)) return null;
  const { data, error } = await scoped(db.from(T).select('*')).eq('id', id).maybeSingle();
  throwIf(error, 'read hr_termination');
  return toTermination(data || null);
}

// The person's live (filed, not voided) termination, or null.
export async function liveTerminationFor(employeeUserId, db = getSupabase()) {
  const { data, error } = await scoped(db.from(T).select('*'))
    .eq('employee_user_id', employeeUserId).eq('status', TERMINATION_STATUS.filed)
    .order('filed_at', { ascending: false }).order('id').limit(1);
  throwIf(error, 'read hr_termination');
  return toTermination((data || [])[0] || null);
}

const findById = (rows, id) => (Array.isArray(rows) ? rows : []).find((u) => u && u.id === id) || null;

/**
 * File a termination. The route has already checked WHO may file it for this employee
 * (hr.edit, the Team page's login rule, lib/hrTerminations terminationTargetRefusal); this
 * checks WHAT is filed, against the committed roster.
 *
 * @param body  { id, employeeUserId, terminationDate, managerUserId, reasons, reasonOther }
 * @param ctx   { actor (the claim's u_* id), roster (committed users), today (org day), now }
 * @returns { termination, created } — `created: false` for a retried id already on file
 */
export async function createTermination(body, { actor, roster, today, now = Date.now() }, db = getSupabase()) {
  const b = body || {};
  if (!isTerminationId(b.id)) throw new TerminationRefusal('bad-id', { message: 'A termination needs a caller-minted id.' });
  const existing = await getTermination(b.id, db);
  if (existing) return { termination: existing, created: false };
  if (!isDayKey(today)) throw new Error('createTermination needs the org day (today)');

  const code = terminationDraftRefusal(b, today);
  if (code) throw new TerminationRefusal(code);

  const employee = findById(roster, b.employeeUserId);
  if (!employee) throw new TerminationRefusal('employee-not-on-team');
  const manager = findById(roster, b.managerUserId);
  if (!isDirectManagerChoice(manager, employee.id)) throw new TerminationRefusal('manager-not-account-manager');
  if (await liveTerminationFor(employee.id, db)) throw new TerminationRefusal('already-terminated', { status: 409 });

  const answers = terminationAnswers(b);
  const filer = findById(roster, actor);
  const at = new Date(now).toISOString();
  const row = {
    id: b.id,
    organization_id: CLEANSPACE_ORG_ID,
    employee_user_id: employee.id,
    employee_name: employee.name || employee.email || employee.id,
    termination_date: answers.terminationDate,
    manager_user_id: manager.id,
    manager_name: manager.name || null,
    reasons: answers.reasons,
    reason_other: answers.reasonOther,
    filed_at: at,
    filed_by_user_id: actor || null,
    filed_by_name: (filer && filer.name) || null,
    status: TERMINATION_STATUS.filed,
    voided_at: null,
    voided_by_user_id: null,
    voided_by_name: null,
    void_reason: null,
    access_state: ACCESS_STATE.scheduled,
    access_ended_at: null,
    status_before: null,
    access_restored_at: null,
    created_at: at,
    updated_at: at,
  };
  const { error } = await db.from(T).insert(row);
  if (error) {
    // Two filings at once for one person: the partial unique index lets one stand.
    if (error.code === '23505') throw new TerminationRefusal('already-terminated', { status: 409 });
    throwIf(error, 'file hr_termination');
  }
  return { termination: await getTermination(b.id, db), created: true };
}

// One conditional move: `patch` lands only while the row still has the status and access state
// it was read with. → the row after the move, or null when it had moved on (the caller re-reads).
export async function moveTermination(id, { status = null, accessStates = null }, patch, db = getSupabase()) {
  let q = scoped(db.from(T).update(patch)).eq('id', id);
  if (status) q = q.eq('status', status);
  if (accessStates) q = q.in('access_state', accessStates);
  const { data, error } = await q.select('*').maybeSingle();
  throwIf(error, 'save hr_termination');
  return data ? toTermination(data) : null;
}

// The Super Admin voids a mistake, with a reason. The paper only: giving the login back (when
// this termination had turned it off) is ./access.js restoreTerminationAccess, which the route
// runs next and the cron runs again until it lands.
export async function voidTermination(id, { reason, voidedBy, now = Date.now() }, db = getSupabase()) {
  const why = text(reason, TERMINATION_TEXT_MAX.voidReason);
  if (!why) throw new TerminationRefusal('void-reason-missing');
  const moved = await moveTermination(id, { status: TERMINATION_STATUS.filed }, {
    status: TERMINATION_STATUS.voided,
    voided_at: new Date(now).toISOString(),
    voided_by_user_id: (voidedBy && voidedBy.id) || null,
    voided_by_name: (voidedBy && voidedBy.name) || null,
    void_reason: why,
  }, db);
  if (moved) return moved;
  const cur = await getTermination(id, db);
  if (!cur) throw new TerminationRefusal('not-found', { status: 404, message: 'That termination does not exist.' });
  throw new TerminationRefusal('already-voided', { status: 409 });
}

// What the cron's turn-off reads: filed, the login not yet off, the date come. Oldest date first,
// bounded per run.
export async function dueAccessTerminations({ today, limit = 50 }, db = getSupabase()) {
  if (!isDayKey(today)) return [];
  const { data, error } = await scoped(db.from(T).select('*'))
    .eq('status', TERMINATION_STATUS.filed).in('access_state', [ACCESS_STATE.scheduled, ACCESS_STATE.ending])
    .lte('termination_date', today)
    .order('termination_date').order('id').limit(limit);
  throwIf(error, 'read due hr_terminations');
  return (data || []).map(toTermination);
}

// What the cron's give-back reads: voided after this termination began turning the login off.
export async function dueRestoreTerminations({ limit = 50 } = {}, db = getSupabase()) {
  const { data, error } = await scoped(db.from(T).select('*'))
    .eq('status', TERMINATION_STATUS.voided).in('access_state', [ACCESS_STATE.ending, ACCESS_STATE.ended])
    .order('voided_at').order('id').limit(limit);
  throwIf(error, 'read voided hr_terminations');
  return (data || []).map(toTermination);
}
