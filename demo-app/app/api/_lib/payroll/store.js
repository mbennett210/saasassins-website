// Service-role data layer for payroll_runs — the closed pay periods (wave W2-L). The browser
// never touches this table (RLS on, no policies → service role bypasses); only
// app/api/payroll/* does. Runs are INSERT-only: never edited or deleted (no reopen in this
// build), and the one insert that closes a period carries its paid_weeks + held_ot + file, so
// the ledger write is atomic (spec §3 / §5.2).
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';

const TABLE = 'payroll_runs';

// The run METADATA — everything except the heavy file / paid_weeks / held_ot (spec §5.2:
// GET /payroll/runs returns runs without them). Newest period first.
const META_COLUMNS = 'id, period_key, cadence, from_key, to_key, from_iso, to_iso, status, closed_at, closed_by, closed_by_name, pending_policy, rolled_forward, created_at';

export async function listRuns(db = getSupabase()) {
  const { data, error } = await db.from(TABLE).select(META_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('period_key', { ascending: false });
  if (error) throw error;
  return data || [];
}

// One run, FULL (file + paid_weeks + held_ot) — GET /payroll/run and the preview's
// "already closed" branch. null when the period has no run.
export async function getRun(periodKey, db = getSupabase()) {
  const { data, error } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('period_key', periodKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// The ONE insert that closes a period. The unique index (organization_id, period_key)
// makes a concurrent double-close atomic: the loser gets 23505, which we surface as
// { conflict: true } so the route answers 409 period-closed (the same code the pre-insert
// "already closed" check uses). Any other error throws.
export async function insertRun(row, db = getSupabase()) {
  const { data, error } = await db.from(TABLE)
    .insert({ organization_id: CLEANSPACE_ORG_ID, ...row })
    .select('*').single();
  if (error) {
    if (error.code === '23505') return { conflict: true };
    throw error;
  }
  return { run: data };
}
