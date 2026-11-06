// POST /api/state/heartbeat  { build, tab, pendingPunches, failedPunches } → { ok }
//      `tab` is the DEVICE key (lib/appBuild deviceKey, CS-727) — the row's key with the
//      person, so a phone reporting at every launch keeps one row; older bundles (and a
//      browser without storage) send their page-load id instead.
// GET  /api/state/heartbeat  (owner/admin) → { rows, newestBuild }: every person's freshest
//      row over 60 days, read completely (CS-727).
//
// Fleet build telemetry (Sept 1 hardening — see the client_heartbeats migration
// for the full why). POST is open to every authenticated org member including
// crew: the whole point is hearing from the phones nobody watches. GET powers
// the Settings → Team "App versions" card. Service-role writes; RLS keeps the
// table invisible to the browser's anon key.
import { requireAuthority, requirePermission } from '../_lib/authz.js';
import { getSupabase } from '../_lib/supabase.js';
import { CLEANSPACE_ORG_ID } from '../_lib/constants.js';
import { selectAll, exactCount, readErrorStatus } from '../_lib/pagedSelect.js';

// How far back the App versions card looks: a person silent for longer reads as never seen.
const HEARTBEAT_WINDOW_DAYS = 60;

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const a = await requireAuthority(req, res);
      if (!a) return;
      if (!a.orgUserId) return res.status(200).json({ ok: false }); // unlinked login — nothing to attribute
      const body = req.body || {};
      const build = Number(body.build);
      const tab = typeof body.tab === 'string' ? body.tab.slice(0, 64) : null;
      if (!tab || !Number.isFinite(build)) return res.status(400).json({ error: 'build and tab are required' });
      const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 200) : null;
      const row = {
        organization_id: CLEANSPACE_ORG_ID,
        org_user_id: a.orgUserId,
        tab,
        auth_user_id: a.user?.id || null,
        build,
        ua,
        pending_punches: Number.isFinite(Number(body.pendingPunches)) ? Number(body.pendingPunches) : 0,
        failed_punches: Number.isFinite(Number(body.failedPunches)) ? Number(body.failedPunches) : 0,
        last_seen: new Date().toISOString(),
      };
      const { error } = await getSupabase().from('client_heartbeats')
        .upsert(row, { onConflict: 'organization_id,org_user_id,tab' });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const a = await requirePermission(req, res, 'settings.team.view');
      if (!a) return;
      // Each person's freshest report over the last 60 days (older rows are just noise), read
      // COMPLETELY (CS-727). The table holds a row per person per device — per page load
      // before lib/appBuild deviceKey — so it passes PostgREST's 1,000-row cap long before the
      // company does: the old `.limit(2000)` newest-first read came back with 1,000 rows, a few
      // hours of launches at 1,500 cleaners, and most people showed no version at all. Pages
      // are ordered by the primary key, so a phone reporting mid-read (its last_seen moving)
      // never moves its row across a page; an answer short of the count is a 503.
      const since = new Date(Date.now() - HEARTBEAT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
      const db = getSupabase();
      const recent = (q) => q.eq('organization_id', CLEANSPACE_ORG_ID).gte('last_seen', since);
      const all = await selectAll({
        count: async () => {
          const { count, error } = await recent(db.from('client_heartbeats').select('org_user_id', { count: 'exact', head: true }));
          if (error) throw error;
          return exactCount(count);
        },
        page: async (from, to) => {
          const { data, error } = await recent(db.from('client_heartbeats').select('org_user_id, tab, build, ua, pending_punches, failed_punches, last_seen'))
            .order('org_user_id', { ascending: true }).order('tab', { ascending: true })
            .range(from, to);
          if (error) throw error;
          return data || [];
        },
        keyOf: (r) => `${r.org_user_id}\u0000${r.tab}`,
      });
      // Reduce to each user's freshest row server-side so the card stays O(users).
      const byUser = new Map();
      let newestBuild = 0;
      for (const r of all) {
        const cur = byUser.get(r.org_user_id);
        if (!cur || Date.parse(r.last_seen) > Date.parse(cur.last_seen)) byUser.set(r.org_user_id, r);
        if (Number(r.build) > newestBuild) newestBuild = Number(r.build);
      }
      const rows = [...byUser.values()]
        .sort((x, y) => Date.parse(y.last_seen) - Date.parse(x.last_seen))
        .map(({ tab: _tab, ...r }) => r);
      return res.status(200).json({ rows, newestBuild });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/state/heartbeat]', e);
    return res.status(readErrorStatus(e)).json({ error: e?.message || 'Server error' });
  }
}
