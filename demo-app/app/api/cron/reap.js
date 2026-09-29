// GET /api/cron/reap — Vercel cron (daily). Daily DB maintenance:
//   (1) reaps `job_deletes` tombstones past their 30-day retention via
//       public.reap_job_deletes (service-role only; 20260720140000_job_deletes_tombstones.sql);
//   (2) prunes the `webhook_deliveries` audit log past 90 days (2026-08-03 audit O3).
//
// WHY THIS EXISTS: the reaper function was written but NEVER SCHEDULED — no cron and
// no caller — so the tombstone table grew unbounded (36,066 rows vs 4,181 live jobs
// at the 2026-08-03 audit). job_deletes is read on every jobs delta-sync keyset poll
// (it is how deletes propagate without a second cursor), so unbounded growth slowly
// degrades sync for every client. This cron is the missing scheduler; the function
// already stamps a `__reaped_below__` watermark so stale cursors self-recover.
//
// Cron-only: requires CRON_SECRET, fail CLOSED (mirrors reminders/run + push/dispatch).
// The reaper is service-role-gated (EXECUTE revoked from public/anon/authenticated),
// so it MUST be called with the service-role client, never the browser anon key.
import { getSupabase } from '../_lib/supabase.js';
import { CLEANSPACE_ORG_ID } from '../_lib/constants.js';

const RETAIN_DAYS = 30;
// webhook_deliveries is a pure audit log — integrations/store.js only ever shows the
// latest 20 per webhook, so older rows are safe to prune. Generous window for history.
const WEBHOOK_RETAIN_DAYS = 90;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(secret ? 401 : 500).json({ ok: false, error: secret ? 'Unauthorized' : 'CRON_SECRET is not configured' });
    return;
  }
  try {
    const supabase = getSupabase();

    // 1) job_deletes tombstones past their 30-day retention (returns the count removed).
    const { data: reapedData, error: reapErr } = await supabase.rpc('reap_job_deletes', { org: CLEANSPACE_ORG_ID, retain_days: RETAIN_DAYS });
    if (reapErr) throw new Error(`reap_job_deletes: ${reapErr.message}`);
    const reaped = typeof reapedData === 'number' ? reapedData : (reapedData ?? 0);

    // 2) webhook_deliveries audit log past WEBHOOK_RETAIN_DAYS. Best-effort — a prune
    // failure must not fail the tombstone reap that already committed above.
    let webhookDeliveriesPruned = 0;
    try {
      const cutoff = new Date(Date.now() - WEBHOOK_RETAIN_DAYS * 86400 * 1000).toISOString();
      const { data: pruned, error: pruneErr } = await supabase
        .from('webhook_deliveries').delete().lt('created_at', cutoff).select('id');
      if (pruneErr) throw new Error(pruneErr.message);
      webhookDeliveriesPruned = Array.isArray(pruned) ? pruned.length : 0;
    } catch (e) {
      console.error('[cron/reap] webhook_deliveries prune failed:', e?.message || e);
    }

    // 3) client_heartbeats rows unseen for 60d (fleet telemetry, Sept 1) — per-tab
    // rows accrete forever otherwise. Best-effort, same posture as (2).
    let heartbeatsPruned = 0;
    try {
      const hbCutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
      const { data: prunedHb, error: hbErr } = await supabase
        .from('client_heartbeats').delete().lt('last_seen', hbCutoff).select('tab');
      if (hbErr) throw new Error(hbErr.message);
      heartbeatsPruned = Array.isArray(prunedHb) ? prunedHb.length : 0;
    } catch (e) {
      console.error('[cron/reap] client_heartbeats prune failed:', e?.message || e);
    }

    res.status(200).json({ ok: true, reaped, retainDays: RETAIN_DAYS, webhookDeliveriesPruned, webhookRetainDays: WEBHOOK_RETAIN_DAYS, heartbeatsPruned });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'reap failed' });
  }
}
