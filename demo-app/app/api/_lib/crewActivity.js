// When each cleaner last USED THE APP — the reads behind task #468's quiet-cleaner alert
// (src/lib/crewQuietAlerts.js, run by api/cron/ops-alerts.js once a morning).
//
// Daniel (2026-11-03): active = "Uses the app": opening Clean Corner signed in as themselves, or a
// clock-in recorded for them. The two records of that:
//   · client_heartbeats.last_seen — every signed-in tab reports at launch, on coming back into
//     view and every 6 hours (components/BuildHeartbeat, api/state/heartbeat), one row per person
//     per device, pruned when unseen for 60 days (cron/reap);
//   · time_entries.clock_in_at — every punch, voided and no-show ones aside (the same rule as
//     time/store coveredJobIdsInWindow), served by time_entries_user_idx.
//
// Both are COMPLETE reads (count-first, ordered pages, _lib/pagedSelect) over the ids asked for,
// 100 at a time, so a busy roster can never come back short and make someone look quiet. A read
// that fails or comes up short THROWS: the caller skips the alert for the run rather than judge
// anyone on partial data. Service-role reads; nothing here is reachable from a browser.
import { getSupabase } from './supabase.js';
import { CLEANSPACE_ORG_ID } from './constants.js';
import { selectAll, exactCount } from './pagedSelect.js';

const ID_CHUNK = 100;

const chunks = (ids) => {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  const out = [];
  for (let i = 0; i < list.length; i += ID_CHUNK) out.push(list.slice(i, i + ID_CHUNK));
  return out;
};

const keepLatest = (map, id, iso) => {
  if (!id || !iso) return;
  const prev = map.get(id);
  if (!prev || Date.parse(iso) > Date.parse(prev)) map.set(id, iso);
};

// → Map userId → the newest heartbeat's last_seen (ISO) since `sinceIso`, for the ids asked.
export async function lastSeenByUser(userIds, { sinceIso } = {}, db = getSupabase()) {
  const out = new Map();
  for (const ids of chunks(userIds)) {
    const scoped = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID).in('org_user_id', ids).gte('last_seen', sinceIso);
    const rows = await selectAll({
      count: async () => {
        const { count, error } = await scoped(db.from('client_heartbeats').select('org_user_id', { count: 'exact', head: true }));
        if (error) throw error;
        return exactCount(count);
      },
      page: async (from, to) => {
        const { data, error } = await scoped(db.from('client_heartbeats').select('org_user_id, tab, last_seen'))
          .order('org_user_id', { ascending: true }).order('tab', { ascending: true })
          .range(from, to);
        if (error) throw error;
        return data || [];
      },
      keyOf: (r) => `${r.org_user_id}\u0000${r.tab}`,
    });
    for (const r of rows) keepLatest(out, r.org_user_id, r.last_seen);
  }
  return out;
}

// → Map userId → their newest clock-in (ISO) since `sinceIso`, voided and no-show punches aside.
export async function lastPunchByUser(userIds, { sinceIso } = {}, db = getSupabase()) {
  const out = new Map();
  for (const ids of chunks(userIds)) {
    const scoped = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID).in('user_id', ids)
      .gte('clock_in_at', sinceIso).neq('status', 'voided').neq('status', 'no_show');
    const rows = await selectAll({
      count: async () => {
        const { count, error } = await scoped(db.from('time_entries').select('id', { count: 'exact', head: true }));
        if (error) throw error;
        return exactCount(count);
      },
      page: async (from, to) => {
        const { data, error } = await scoped(db.from('time_entries').select('id, user_id, clock_in_at'))
          .order('clock_in_at', { ascending: true }).order('id', { ascending: true })
          .range(from, to);
        if (error) throw error;
        return data || [];
      },
    });
    for (const r of rows) keepLatest(out, r.user_id, r.clock_in_at);
  }
  return out;
}
