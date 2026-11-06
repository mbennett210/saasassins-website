// GET /api/cron/qbo-refresh — Vercel cron, NIGHTLY (QB-9, Matt 2026-09-29: "How fresh should the
// numbers be? (a) Updated every night"). Pulls every window of the linked properties' P&L,
// including the last twelve months (QB-10), into the report cache, so the owner and manager
// dashboards open on warm numbers; stamps Settings' "Last refresh" (CS-569); reaps the cache
// (CS-566). The work is _lib/qbo/refresh.js refreshBook — the same routine as the owner's
// "Refresh data" button.
//
// SCHEDULE (app/vercel.json): "30 6-8 * * *" — 06:30, 07:30 and 08:30 UTC, which is 2:30–4:30 AM
// in New York in summer and 1:30–3:30 AM in winter: always after the org's midnight, always before
// the office opens. THREE runs, one job: a run that finds tonight's refresh already complete
// (`last_synced_at` on the org's today, no `last_error`) answers 200 "already_refreshed" and asks
// QuickBooks nothing; a run that could not finish (a transient QuickBooks failure, or the
// function's time limit) answers 503 + retryable and the next run picks up only its gaps
// (CS-574) — Vercel does not retry a failed cron call itself.
//
// AUTH STANCE: cron-secret. `Authorization: Bearer $CRON_SECRET`, compared in constant time
// (CS-200), FAIL CLOSED: an unset secret is a 500 with a body that names nothing (the gap logged,
// `_lib/cronGate.js`), a wrong one a 401, and neither reads anything.
import { createHash, timingSafeEqual } from 'node:crypto';
import { qboEnvironment, isConfigured } from '../_lib/qbo/config.js';
import { getConnectionForEnv } from '../_lib/qbo/store.js';
import { refreshBook, refreshedToday } from '../_lib/qbo/refresh.js';
import { QboError, isTransient } from '../_lib/qbo/client.js';
import { readOrgState } from '../_lib/orgState.js';
import { refuseUnconfiguredCron } from '../_lib/cronGate.js';

export const config = { maxDuration: 60 };
// The work's own budget inside the 60 s limit, leaving room to stamp, reap and answer.
const BUDGET_MS = 48 * 1000;

const digest = (s) => createHash('sha256').update(String(s)).digest();
function cronAuthorized(req, secret) {
  return timingSafeEqual(digest(req.headers?.authorization || ''), digest(`Bearer ${secret}`));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret) return refuseUnconfiguredCron(res, 'cron/qbo-refresh');
  if (!cronAuthorized(req, secret)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const environment = qboEnvironment();
  if (!environment || !isConfigured()) return res.status(200).json({ ok: true, skipped: 'not_configured' });
  const started = Date.now();
  try {
    const conn = await getConnectionForEnv(environment);
    if (!conn) return res.status(200).json({ ok: true, skipped: 'not_connected' });
    const { state } = await readOrgState();
    const tz = state?.company?.timezone;
    const now = new Date();
    if (refreshedToday(conn, now, tz)) {
      return res.status(200).json({ ok: true, skipped: 'already_refreshed', lastSyncedAt: conn.last_synced_at });
    }
    const result = await refreshBook({ environment, mode: 'nightly', now, deadline: started + BUDGET_MS, conn, tz });
    const summary = {
      warmed: result.warmed, windows: result.windows, dimension: result.dimension, linked: result.linked,
      failures: result.failures, reaped: result.reaped, lastSyncedAt: result.lastSyncedAt, ms: Date.now() - started,
    };
    if (result.ok) return res.status(200).json({ ok: true, ...summary });
    if (result.code === 'reauth_required') {
      // Not retryable: a person must reconnect QuickBooks (Settings shows it).
      return res.status(409).json({ ok: false, retryable: false, code: 'reauth_required' });
    }
    res.setHeader('Retry-After', '3600');
    return res.status(503).json({ ok: false, retryable: result.retryable, code: 'refresh_incomplete', ...summary });
  } catch (e) {
    const code = e instanceof QboError ? e.code : (e?.code || 'error');
    // No tokens, bodies or PII: a code and our own message (CS-571).
    console.error(`[cron/qbo-refresh] ${code}: ${String(e?.message || '').slice(0, 160)}`);
    if (isTransient(e) || code === 'store_error') {
      res.setHeader('Retry-After', '3600');
      return res.status(503).json({ ok: false, retryable: true, code });
    }
    return res.status(500).json({ ok: false, retryable: false, code });
  }
}
