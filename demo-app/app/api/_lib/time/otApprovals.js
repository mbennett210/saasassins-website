// Service-role data layer for time_ot_approvals — the manager-approved overtime TOTAL per
// unit (cleaner × pay week × customer). The browser never touches this table; only
// app/api/time/* does (RLS on, no policies → service role bypasses). The stored value is
// the TOTAL approved for the unit, not an increment (spec §3 / §5.1). client_id is '' when
// the punches/legs of the unit have no customer.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { otApprovalFromRow } from '../../../src/lib/otLedger.js';

const TABLE = 'time_ot_approvals';
const nowIso = () => new Date().toISOString();
const UNIT_CONFLICT = 'organization_id,user_id,week_key,client_id';

// The OT-approval totals for a set of users, optionally narrowed to a set of week keys —
// chunked `.in()` so a large user set can't blow past PostgREST's URL limit. Returns the
// neutral shape computeWeekLedger reads ({ userId, weekKey, clientId, approvedOtMinutes }).
export async function readOtApprovalsForUsers(userIds, weekKeys = null, db = getSupabase()) {
  const users = [...new Set((userIds || []).filter(Boolean))];
  if (!users.length) return [];
  const weeks = Array.isArray(weekKeys) && weekKeys.length ? [...new Set(weekKeys)] : null;
  const out = [];
  for (let i = 0; i < users.length; i += 200) {
    let q = db.from(TABLE).select('user_id, week_key, client_id, approved_ot_minutes, approved_by, approved_at')
      .eq('organization_id', CLEANSPACE_ORG_ID)
      .in('user_id', users.slice(i, i + 200));
    if (weeks) q = q.in('week_key', weeks);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data || []) out.push(otApprovalFromRow(r));
  }
  return out;
}

// Set a unit's approved-OT TOTAL, stamping the approver + server now. Upsert on the unit's
// unique index (migration 20260927225850) — atomic, so two concurrent approvals of the same
// unit can't race a select-then-insert. minutes is already clamped to 0..10080 by the route.
export async function setOtApproval({ userId, weekKey, clientId = '', minutes, byUserId = null }, db = getSupabase()) {
  const now = nowIso();
  const row = {
    organization_id: CLEANSPACE_ORG_ID,
    user_id: userId, week_key: weekKey, client_id: clientId || '',
    approved_ot_minutes: minutes,
    approved_by: byUserId, approved_at: now, updated_at: now,
  };
  const { data, error } = await db.from(TABLE)
    .upsert(row, { onConflict: UNIT_CONFLICT })
    .select('approved_ot_minutes')
    .single();
  if (error) throw error;
  return { approvedMinutes: data?.approved_ot_minutes ?? minutes };
}
