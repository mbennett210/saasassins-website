// GET /api/cron/reap — Vercel cron (daily). Daily DB maintenance:
//   (1) reaps `job_deletes` tombstones past their 30-day retention via
//       public.reap_job_deletes (service-role only; 20260720140000_job_deletes_tombstones.sql);
//   (2) prunes the `webhook_deliveries` audit log past 90 days (2026-08-03 audit O3);
//   (3) purges `activity_log` rows past their 3-year retention (CS-379, LOG-5 a: "3 years.
//       Nobody can edit or delete them"). It RIDES THIS CRON rather than adding a ninth
//       entry: it is one daily bounded delete, exactly like (1) and (2);
//   (4) clears the EXACT GPS POINTS on `time_entries` past their 90-day retention (PAY-20,
//       Matt 2026-09-30: "90 days, then only on site / off site and the distance"). The
//       verdict and the two distances stay — every reader keeps its answer — and only the
//       six raw lat/lng/accuracy columns go. Same reasoning as (2) and (3): one daily
//       bounded write, no new cron entry;
//   (5) sweeps members' IMAGES that outlived their reason (UI_RULES §141, CS-627): photo folders
//       and signature images of ids no longer on the roster, and photo versions the roster no
//       longer points at once they are a day old (_lib/memberStorage.js). Bounded per run, logs
//       its counts, sweeps nothing when the roster is empty or unreadable. (The code's own
//       numbering runs one ahead of this list: the heartbeat prune is its step 3.)
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
import { purgeExpiredActivity } from '../_lib/activityLog.js';
import { RETENTION_YEARS } from '../../src/lib/activityLog.js';
import { trimStalePunchCoords } from '../_lib/time/store.js';
import { GPS_POINT_RETENTION_DAYS } from '../../src/lib/clockRules.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { sweepMemberStorage } from '../_lib/memberStorage.js';
import { refuseUnconfiguredCron } from '../_lib/cronGate.js';

const RETAIN_DAYS = 30;
// webhook_deliveries is a pure audit log — integrations/store.js only ever shows the
// latest 20 per webhook, so older rows are safe to prune. Generous window for history.
const WEBHOOK_RETAIN_DAYS = 90;

export default async function handler(req, res) {
  // An unset secret is a 500 with a body that names nothing, the gap logged (`_lib/cronGate.js`);
  // a wrong or missing bearer is a 401.
  const secret = process.env.CRON_SECRET;
  if (!secret) { refuseUnconfiguredCron(res, 'cron/reap'); return; }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
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

    // 4) activity_log past its 3-year retention (CS-379 / LOG-5). The horizon is the app
    // constant (RETENTION_YEARS), and the table's own trigger refuses a delete of anything
    // newer, so a bug here cannot erase evidence inside the window. purgeExpiredActivity
    // never throws — it reports and returns { failed: true }.
    const activity = await purgeExpiredActivity({});

    // 5) PAY-20 — the exact GPS points on punches past GPS_POINT_RETENTION_DAYS. Best-effort,
    // same posture as (2) and (3): a failure here must not fail the reap that already
    // committed, and the sweep is idempotent so tomorrow's run picks up where it stopped.
    // `more` says the bounded run hit its cap and there is still history to work through.
    let punchCoordsTrimmed = 0;
    let punchCoordsMore = false;
    try {
      const r = await trimStalePunchCoords({});
      punchCoordsTrimmed = r.trimmed;
      punchCoordsMore = r.more;
    } catch (e) {
      console.error('[cron/reap] punch GPS point trim failed:', e?.message || e);
    }

    // 6) Members' images (UI_RULES §141, CS-627): photo folders and signature images of ids off
    // the roster, and photo versions the roster no longer names once a day old. Bounded
    // (_lib/memberStorage.js SWEEP_LIMITS; `more` says tomorrow continues), best-effort like (2),
    // and it reads the roster as a small projection. An unreadable roster is a skip, never "nobody
    // is on the team" — the sweep itself refuses an empty one too.
    let memberStorage = { skipped: 'not-run' };
    try {
      const committed = await readProtectedSlices('users:state->users');
      memberStorage = await sweepMemberStorage({ users: Array.isArray(committed?.users) ? committed.users : null });
      console.log('[cron/reap] member images:', JSON.stringify(memberStorage));
    } catch (e) {
      memberStorage = { skipped: 'failed' };
      console.error('[cron/reap] member image sweep failed:', e?.message || e);
    }

    res.status(200).json({
      ok: true, reaped, retainDays: RETAIN_DAYS, webhookDeliveriesPruned, webhookRetainDays: WEBHOOK_RETAIN_DAYS, heartbeatsPruned,
      activityPurged: activity.purged, activityRetentionYears: RETENTION_YEARS, activityCutoff: activity.cutoff,
      punchCoordsTrimmed, punchCoordsMore, gpsPointRetentionDays: GPS_POINT_RETENTION_DAYS,
      memberStorage,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'reap failed' });
  }
}
