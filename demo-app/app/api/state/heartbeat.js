// POST /api/state/heartbeat  { build, tab, pendingPunches, failedPunches } → { ok }
// GET  /api/state/heartbeat  (owner/admin) → { rows, newestBuild }
//
// Fleet build telemetry (Sept 1 hardening — see the client_heartbeats migration
// for the full why). POST is open to every authenticated org member including
// crew: the whole point is hearing from the phones nobody watches. GET powers
// the Settings → Team "App versions" card. Service-role writes; RLS keeps the
// table invisible to the browser's anon key.
import { requireAuthority, requirePermission } from '../_lib/authz.js';
import { getSupabase } from '../_lib/supabase.js';
import { CLEANSPACE_ORG_ID } from '../_lib/constants.js';

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
      // Newest-per-user view; 60 days is plenty (older rows are just noise).
      const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await getSupabase().from('client_heartbeats')
        .select('org_user_id, build, ua, pending_punches, failed_punches, last_seen')
        .eq('organization_id', CLEANSPACE_ORG_ID)
        .gte('last_seen', since)
        .order('last_seen', { ascending: false })
        .limit(2000);
      if (error) throw error;
      // Reduce to each user's freshest row server-side so the card stays O(users).
      const byUser = new Map();
      let newestBuild = 0;
      for (const r of data || []) {
        if (!byUser.has(r.org_user_id)) byUser.set(r.org_user_id, r);
        if (Number(r.build) > newestBuild) newestBuild = Number(r.build);
      }
      return res.status(200).json({ rows: [...byUser.values()], newestBuild });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[api/state/heartbeat]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
