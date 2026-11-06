// Service-role data layer for HR WARNINGS (Matt's HR-1..HR-5, 2026-10-05).
//
// One table, `hr_warnings` (migration 20261005120000_hr_warnings.sql explains why it is not
// in org_state). Nothing but this module touches it, and only app/api/hr-warnings/* and the
// ops-alert cron call this module.
//
// 🔴 THE RULES THIS MODULE KEEPS, SO NO CALLER HAS TO REMEMBER THEM
//  1. LOCKED ONCE ISSUED. There is no edit path and no delete path. A warning changes only
//     by the four guarded moves below — acknowledge, refuse, void, and the reminder stamp —
//     and every one of them is a CONDITIONAL update ("…where status = 'awaiting'"), so two
//     people signing at once cannot both win: the loser gets a 409 naming what happened.
//     The table's own trigger refuses the rest (content edits, deletes, a changed signature).
//  2. NAMES ARE STAMPED AT WRITE from the committed roster, so a departed employee's
//     warnings still read with their name, supervisor and HR manager (the HR-history rule).
//  3. DATES: `issued_on` / `previous_meeting_date` are the org's DAY KEYS; the caller supplies
//     `today` in the org zone — this module never asks a clock for a day.
//  4. READS ARE COMPLETE (selectAll: count-first, ordered, paged), and the list NEVER selects
//     the signature columns; only the one-warning read carries them.
//
// `db` is the LAST argument everywhere and defaults to the real client, so the offline suite
// injects a PostgREST stand-in.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { selectAll } from '../pagedSelect.js';
import { english } from '../../../src/i18n/core.js';
import { SUPERVISOR_ROLES } from '../../../src/lib/roles.js';
import {
  WARNING_STATUS, WARNING_TEXT_MAX, WARNING_REFUSAL_KEYS, WARNING_REASON,
  warningDraftRefusal, signatureRefusal, isDayKey, normalizeReasons,
} from '../../../src/lib/hrWarnings.js';

const T = 'hr_warnings';

// A caller-visible refusal: the route turns it into a 4xx with this message (English — API
// bodies stay English, LANG-8) and the code the screen words in the reader's language.
export class WarningRefusal extends Error {
  constructor(code, { status = 400, message } = {}) {
    super(message || (WARNING_REFUSAL_KEYS[code] ? english(WARNING_REFUSAL_KEYS[code]) : code));
    this.name = 'WarningRefusal';
    this.code = code;
    this.status = status;
  }
}

const throwIf = (error, what) => { if (error) throw new Error(`${what}: ${error.message}`); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isWarningId = (v) => typeof v === 'string' && UUID_RE.test(v);
const text = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

// Every column but the two signatures — what the list and the cron read.
export const LIST_COLUMNS = [
  'id', 'employee_user_id', 'employee_name', 'supervisor_user_id', 'supervisor_name',
  'level', 'reasons', 'reason_other', 'previous_meeting_date',
  'what_happened', 'what_must_change', 'issued_at', 'issued_on',
  'issued_by_user_id', 'status', 'employee_signed_at', 'employee_comment', 'signed_in_person',
  'refused_at', 'hr_manager_user_id', 'hr_manager_name', 'hr_manager_signed_at',
  'voided_at', 'voided_by_user_id', 'voided_by_name', 'void_reason', 'reminded_at',
  'created_at', 'updated_at',
].join(', ');

// row → the camelCase shape every screen reads (the demo stub writes the same shape).
export function toWarning(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    employeeUserId: r.employee_user_id,
    employeeName: r.employee_name || null,
    supervisorUserId: r.supervisor_user_id,
    supervisorName: r.supervisor_name || null,
    level: r.level,
    // Matt's form (HR-1 b): the ticked reasons, in his form's order.
    reasons: normalizeReasons(r.reasons),
    reasonOther: r.reason_other || null,
    previousMeetingDate: r.previous_meeting_date || null,
    whatHappened: r.what_happened,       // "Details of actions that warranted this warning"
    whatMustChange: r.what_must_change,  // "The following immediate and sustained corrective action …"

    issuedAt: r.issued_at,
    issuedOn: r.issued_on,
    issuedByUserId: r.issued_by_user_id || null,
    status: r.status,
    employeeSignedAt: r.employee_signed_at || null,
    employeeComment: r.employee_comment || null,
    signedInPerson: !!r.signed_in_person,
    refusedAt: r.refused_at || null,
    hrManagerUserId: r.hr_manager_user_id || null,
    hrManagerName: r.hr_manager_name || null,
    hrManagerSignedAt: r.hr_manager_signed_at || null,
    voidedAt: r.voided_at || null,
    voidedByUserId: r.voided_by_user_id || null,
    voidedByName: r.voided_by_name || null,
    voidReason: r.void_reason || null,
    remindedAt: r.reminded_at || null,
  };
  // Only the one-warning read selects these, so only it carries them.
  if (Object.prototype.hasOwnProperty.call(r, 'employee_signature')) out.employeeSignature = r.employee_signature || null;
  if (Object.prototype.hasOwnProperty.call(r, 'hr_manager_signature')) out.hrManagerSignature = r.hr_manager_signature || null;
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────

// Every warning (or one employee's), newest first, COMPLETE, without signatures.
export async function listWarnings({ employeeUserId = null } = {}, db = getSupabase()) {
  const scope = (q) => {
    let x = q.eq('organization_id', CLEANSPACE_ORG_ID);
    if (employeeUserId) x = x.eq('employee_user_id', employeeUserId);
    return x;
  };
  const rows = await selectAll({
    count: async () => {
      const { count, error } = await scope(db.from(T).select('id', { count: 'exact', head: true }));
      throwIf(error, 'count hr_warnings');
      return count;
    },
    page: async (from, to) => {
      const { data, error } = await scope(db.from(T).select(LIST_COLUMNS))
        .order('issued_at', { ascending: false }).order('id').range(from, to);
      throwIf(error, 'read hr_warnings');
      return data || [];
    },
  });
  return rows.map(toWarning);
}

// One warning, WITH its signatures.
export async function getWarning(id, db = getSupabase()) {
  if (!isWarningId(id)) return null;
  const { data, error } = await db.from(T).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  throwIf(error, 'read hr_warning');
  return toWarning(data);
}

// ── who a name belongs to ───────────────────────────────────────────────────
const findUser = (roster, id) => (Array.isArray(roster) ? roster : []).find((u) => u && u.id === id) || null;
const isActive = (u) => !!u && (u.status === 'active' || u.status === undefined || u.status === null);

// ── issue ───────────────────────────────────────────────────────────────────
// The id is CALLER-MINTED, so a retried issue inserts nothing the second time and the caller
// gets the warning it already made (created: false) rather than a second one on the record.
//
// `roster` is the committed `state.users` (for the names, and to prove the employee and the
// supervisor are real team members). The questions are Matt's own form (HR-1 b).
export async function createWarning(body, { actor, roster, today, now = Date.now() }, db = getSupabase()) {
  const b = body || {};
  if (!isWarningId(b.id)) throw new WarningRefusal('bad-id', { message: 'A warning needs a caller-minted id.' });
  const existing = await getWarning(b.id, db);
  if (existing) return { warning: existing, created: false };

  const draft = {
    employeeUserId: typeof b.employeeUserId === 'string' ? b.employeeUserId : '',
    supervisorUserId: typeof b.supervisorUserId === 'string' ? b.supervisorUserId : '',
    level: b.level,
    reasons: Array.isArray(b.reasons) ? b.reasons : [],
    reasonOther: typeof b.reasonOther === 'string' ? b.reasonOther : '',
    previousMeetingDate: typeof b.previousMeetingDate === 'string' ? b.previousMeetingDate : null,
    whatHappened: typeof b.whatHappened === 'string' ? b.whatHappened : '',
    whatMustChange: typeof b.whatMustChange === 'string' ? b.whatMustChange : '',
  };
  const code = warningDraftRefusal(draft, today);
  if (code) throw new WarningRefusal(code);

  // Both people must be on the committed roster: the employee a member (any tier, active or
  // not — a warning can follow someone just set inactive), the supervisor an ACTIVE office
  // tier (the people the form offers).
  const employee = findUser(roster, draft.employeeUserId);
  if (!employee) throw new WarningRefusal('employee-missing', { message: 'That employee is not on the team.' });
  const supervisor = findUser(roster, draft.supervisorUserId);
  if (!supervisor || !isActive(supervisor) || !SUPERVISOR_ROLES.includes(supervisor.role)) {
    throw new WarningRefusal('supervisor-missing', { message: 'The supervisor must be an active manager on the team.' });
  }
  const at = new Date(now).toISOString();
  const row = {
    id: b.id,
    organization_id: CLEANSPACE_ORG_ID,
    employee_user_id: employee.id,
    employee_name: employee.name || null,
    supervisor_user_id: supervisor.id,
    supervisor_name: supervisor.name || null,
    level: draft.level,
    // In HIS order, whatever order they were ticked in; "Other"'s words only when it is ticked.
    reasons: normalizeReasons(draft.reasons),
    reason_other: draft.reasons.includes(WARNING_REASON.other) ? text(draft.reasonOther, WARNING_TEXT_MAX.reasonOther) : null,
    previous_meeting_date: draft.previousMeetingDate || null,
    what_happened: text(draft.whatHappened, WARNING_TEXT_MAX.whatHappened),
    what_must_change: text(draft.whatMustChange, WARNING_TEXT_MAX.whatMustChange),
    issued_at: at,
    issued_on: today,
    issued_by_user_id: actor || null,
    status: WARNING_STATUS.awaiting,
    employee_signature: null,
    employee_signed_at: null,
    employee_comment: null,
    signed_in_person: false,
    refused_at: null,
    hr_manager_user_id: null,
    hr_manager_name: null,
    hr_manager_signature: null,
    hr_manager_signed_at: null,
    voided_at: null,
    voided_by_user_id: null,
    voided_by_name: null,
    void_reason: null,
    reminded_at: null,
    created_at: at,
    updated_at: at,
  };
  if (!isDayKey(row.issued_on)) throw new Error('createWarning needs the org day (today)');
  const { error } = await db.from(T).insert(row);
  throwIf(error, 'issue hr_warning');
  return { warning: await getWarning(b.id, db), created: true };
}

// A conditional update: only a row still in `fromStatuses` moves. When nothing moved, the
// caller is told WHY (gone, or already signed / refused / voided) rather than a silent no-op.
async function guardedUpdate(id, fromStatuses, patch, db) {
  const { data, error } = await db.from(T).update(patch)
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).in('status', fromStatuses)
    .select('*').maybeSingle();
  throwIf(error, 'save hr_warning');
  if (data) return toWarning(data);
  const now = await getWarning(id, db);
  if (!now) throw new WarningRefusal('not-found', { status: 404, message: 'That warning does not exist.' });
  throw new WarningRefusal('already-closed', {
    status: 409,
    message: now.status === WARNING_STATUS.voided
      ? 'That warning was voided.'
      : now.status === WARNING_STATUS.refused
        ? 'That warning was already marked refused.'
        : 'That warning was already signed.',
  });
}

// ── the employee's acknowledgement ──────────────────────────────────────────
// On their own phone (`inPerson: false`) or on the supervisor's device (`inPerson: true`).
// Signing confirms RECEIPT, not agreement — the screens say so beside the box.
export async function acknowledgeWarning(id, { signature, comment, inPerson, now = Date.now() }, db = getSupabase()) {
  const sig = signatureRefusal(signature);
  if (sig) throw new WarningRefusal(sig);
  if (typeof comment === 'string' && comment.trim().length > WARNING_TEXT_MAX.comment) throw new WarningRefusal('too-long');
  return guardedUpdate(id, [WARNING_STATUS.awaiting], {
    status: WARNING_STATUS.acknowledged,
    employee_signature: signature,
    employee_signed_at: new Date(now).toISOString(),
    employee_comment: text(comment, WARNING_TEXT_MAX.comment),
    signed_in_person: !!inPerson,
  }, db);
}

// ── HR-3: refused to sign → the HR manager signs ────────────────────────────
// `hrManager` is the roster row of the person PICKED as the HR manager (the team shares one
// login, so it is never the login); the route has already proved they are an active office
// member.
export async function refuseWarning(id, { hrManager, signature, now = Date.now() }, db = getSupabase()) {
  if (!hrManager || !hrManager.id) throw new WarningRefusal('hr-manager-missing');
  const sig = signatureRefusal(signature);
  if (sig) throw new WarningRefusal(sig);
  const at = new Date(now).toISOString();
  return guardedUpdate(id, [WARNING_STATUS.awaiting], {
    status: WARNING_STATUS.refused,
    refused_at: at,
    hr_manager_user_id: hrManager.id,
    hr_manager_name: hrManager.name || null,
    hr_manager_signature: signature,
    hr_manager_signed_at: at,
  }, db);
}

// ── a mistake: voided by the owner, kept on file, never counted ─────────────
export async function voidWarning(id, { reason, voidedBy, now = Date.now() }, db = getSupabase()) {
  const why = text(reason, WARNING_TEXT_MAX.voidReason);
  if (!why) throw new WarningRefusal('void-reason-missing');
  return guardedUpdate(id, [WARNING_STATUS.awaiting, WARNING_STATUS.acknowledged, WARNING_STATUS.refused], {
    status: WARNING_STATUS.voided,
    voided_at: new Date(now).toISOString(),
    voided_by_user_id: (voidedBy && voidedBy.id) || null,
    voided_by_name: (voidedBy && voidedBy.name) || null,
    void_reason: why,
  }, db);
}

// ── HR-5: the cron's two calls ──────────────────────────────────────────────

// Every warning still awaiting a signature, never reminded, issued at least `hours` ago —
// oldest first, bounded. THE cheap early exit: one probe of the partial index
// (hr_warnings_unsigned_idx), no rows on almost every run.
export async function dueUnsignedWarnings({ now = Date.now(), hours, limit = 25 }, db = getSupabase()) {
  const cutoff = new Date(now - hours * 3600 * 1000).toISOString();
  const { data, error } = await db.from(T).select(LIST_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('status', WARNING_STATUS.awaiting)
    .is('reminded_at', null)
    .lte('issued_at', cutoff)
    .order('issued_at').order('id')
    .limit(Math.max(1, Math.min(Number(limit) || 25, 200)));
  throwIf(error, 'read unsigned hr_warnings');
  return (data || []).map(toWarning);
}

// Stamp the warnings a run reminded about. Called AFTER the bell rows are durably in
// org_state: a crash in between re-reminds on the next run, which is the right way round.
export async function markWarningsReminded(ids, { at } = {}, db = getSupabase()) {
  const list = (Array.isArray(ids) ? ids : []).filter(isWarningId);
  if (!list.length) return 0;
  const { data, error } = await db.from(T)
    .update({ reminded_at: at || new Date().toISOString() })
    .eq('organization_id', CLEANSPACE_ORG_ID).in('id', list).is('reminded_at', null).select('id');
  throwIf(error, 'stamp hr_warnings reminded');
  return (data || []).length;
}
