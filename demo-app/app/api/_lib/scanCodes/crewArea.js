// QR Wave 2 — what a CLEANER's scan reads and tells (2026-10-17; UI_RULES §176). The route is
// api/scan-codes/[...path].js (EP-419 fill-in, EP-420 the cleaner's area read); the rules are
// src/lib/scanFillIn.js. Service role, org-pinned, narrow:
//
//   lastInspectionAt  the newest SUBMITTED inspection at the location (a draft is nobody's
//                     business but its inspector's, D8): its date and result only
//   openTicketsAt     the location's open tickets, newest first: ONE bounded page and the exact
//                     count, so the cleaner's view can say "the newest N of M" honestly
//   notifyFillIn      the building's account manager hears that a cleaner filled in (the
//                     account-alert fan-out, NOTIF-02: the supervisor alone, or nobody — the
//                     clean's own record and the activity log still say it)
//
// A ticket is read whole (`*`) because builder R's `site_area_id` exists only once its migration
// is applied, and naming a missing column is an error; what leaves is scanFillIn's allowlist
// (projectCrewAreaInfo), never the row — a visitor's name and contact stay here.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readOrgState, writeOrgState } from '../orgState.js';
import { exactCount } from '../pagedSelect.js';
import { fanOutAccountAlert, SCAN_FILL_IN_EVENT } from '../../../src/lib/notifications.js';
import { CREW_AREA_TICKETS_MAX } from '../../../src/lib/scanFillIn.js';

export async function lastInspectionAt(siteId, db = getSupabase()) {
  if (!siteId) return null;
  const { data, error } = await db.from('inspection_records').select('id,performed_at,result,status')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('site_id', siteId).neq('status', 'draft')
    .order('performed_at', { ascending: false }).order('id', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

export async function openTicketsAt(siteId, db = getSupabase()) {
  if (!siteId) return { tickets: [], total: 0 };
  const open = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID).eq('site_id', siteId).neq('status', 'resolved');
  const { count, error: countErr } = await open(db.from('problem_reports').select('id', { count: 'exact', head: true }));
  if (countErr) throw countErr;
  const { data, error } = await open(db.from('problem_reports').select('*'))
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(0, CREW_AREA_TICKETS_MAX - 1);
  if (error) throw error;
  return { tickets: data || [], total: exactCount(count) };
}

// Best-effort and CAS-guarded like every other fan-out: the fill-in is already written, and a lost
// bell must never undo it. `title` / `body` are catalog messages (msg), rendered per recipient.
export async function notifyFillIn({ clientId, title, body, url, actorUserId }, { tries = 4 } = {}) {
  try {
    for (let i = 0; i < tries; i += 1) {
      const { state, version } = await readOrgState();
      const before = state.notifications || [];
      const notifications = fanOutAccountAlert({ ...state, notifications: before }, {
        clientId: clientId || null, eventKey: SCAN_FILL_IN_EVENT, title, body, url, actorUserId,
      });
      if (notifications === before) return { sent: false, reason: 'no-supervisor' };
      if (await writeOrgState({ ...state, notifications }, version)) return { sent: true };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch {
    return { sent: false, reason: 'error' };
  }
}
