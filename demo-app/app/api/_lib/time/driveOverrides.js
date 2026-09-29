// Manager rulings on ONE derived drive leg (drive_segment_overrides).
//
// A flagged leg is a conversation, not an automatic deduction — recorded travel
// between job sites is compensable time, so the engine never docks anything on its
// own. A manager may adjust the paid minutes or exclude the leg entirely, and a
// reason is REQUIRED. The recorded actual gap is never rewritten; only what payroll
// pays changes, and the ruling carries the actual + estimate it was made against so
// the audit reads back correctly even after a later clock correction.
//
// Service-role only, organization_id pinned. See CLEANSPACE_SWEPT.md §5.6.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';

const TABLE = 'drive_segment_overrides';

export function mapOverrideRow(r) {
  return {
    id: r.id,
    fromEntryId: r.from_entry_id,
    toEntryId: r.to_entry_id,
    excluded: !!r.excluded,
    paidMinutes: Number.isFinite(r.paid_minutes) ? r.paid_minutes : null,
    reason: r.reason || null,
    actualMinutes: r.actual_minutes ?? null,
    estimateMinutes: r.estimate_minutes ?? null,
    createdByUserId: r.created_by_user_id || null,
    createdByName: r.created_by_name || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Rulings covering a set of derived legs, queried by the LEFT entry id. EVERY id is
// looked up: the old single `.in()` kept only the first 1000 ids (a semi-monthly pay run
// at full volume derives more legs than that, so later rulings were silently ignored and
// the leg paid its unadjusted minutes) and packed them all into one request URL. The ids
// now go in chunks small enough for any URL limit, a few at a time.
export const OVERRIDE_ID_CHUNK = 100;
const OVERRIDE_CONCURRENCY = 4;

export async function listOverridesForEntries(fromEntryIds = [], db = getSupabase()) {
  const ids = [...new Set((fromEntryIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += OVERRIDE_ID_CHUNK) chunks.push(ids.slice(i, i + OVERRIDE_ID_CHUNK));
  const results = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      if (i >= chunks.length) return;
      next += 1;
      const { data, error } = await db.from(TABLE).select('*')
        .eq('organization_id', CLEANSPACE_ORG_ID)
        .in('from_entry_id', chunks[i]);
      if (error) throw error;
      results[i] = data || [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(OVERRIDE_CONCURRENCY, chunks.length) }, worker));
  return results.flat().map(mapOverrideRow);
}

export async function upsertOverride({
  fromEntryId, toEntryId, excluded = false, paidMinutes = null, reason,
  actualMinutes = null, estimateMinutes = null, byUserId = null, byName = null,
}) {
  if (!fromEntryId || !toEntryId) return { badRequest: 'fromEntryId and toEntryId are required' };
  if (!reason || !String(reason).trim()) return { badRequest: 'A reason is required to adjust paid drive time' };
  const paid = excluded ? null : (Number.isFinite(paidMinutes) ? Math.max(0, Math.round(paidMinutes)) : null);
  const { data, error } = await getSupabase().from(TABLE).upsert({
    organization_id: CLEANSPACE_ORG_ID,
    from_entry_id: fromEntryId,
    to_entry_id: toEntryId,
    excluded: !!excluded,
    paid_minutes: paid,
    reason: String(reason).trim(),
    actual_minutes: Number.isFinite(actualMinutes) ? actualMinutes : null,
    estimate_minutes: Number.isFinite(estimateMinutes) ? estimateMinutes : null,
    created_by_user_id: byUserId,
    created_by_name: byName,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,from_entry_id,to_entry_id' }).select('*').maybeSingle();
  if (error) throw error;
  return { override: data ? mapOverrideRow(data) : null };
}

// Clearing a ruling restores the recorded actual as the paid amount.
export async function clearOverride({ fromEntryId, toEntryId }) {
  if (!fromEntryId || !toEntryId) return { badRequest: 'fromEntryId and toEntryId are required' };
  const { error } = await getSupabase().from(TABLE).delete()
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('from_entry_id', fromEntryId)
    .eq('to_entry_id', toEntryId);
  if (error) throw error;
  return { cleared: true };
}
