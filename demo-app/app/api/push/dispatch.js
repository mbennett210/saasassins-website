// GET /api/push/dispatch — per-minute Vercel Cron (see vercel.json). Sends OS Web
// Push for every bell-inbox notification row that hasn't been pushed yet, to each
// recipient's subscribed devices. Runs with NO browser tab open, so a notification
// created by a teammate's tab OR a server cron still reaches a user's phone.
//
// The dispatch logic is the shared core in _lib/push/dispatch (also used by the
// authed instant-flush endpoint api/push/flush, so a fresh message goes out in ~1s
// instead of waiting for this tick). This route is the tab-independent fallback +
// catch-up path; both share CAS reserve-then-send, so they never double-push.
//
// Cron-only: requires CRON_SECRET. Soft-fails to HTTP 200 so the next tick retries.
import { dispatchDue } from '../_lib/push/dispatch.js';
import { pushConfigured } from '../_lib/push/store.js';

export default async function handler(req, res) {
  // Cron-only. Fail closed when CRON_SECRET is unset — this endpoint sends real
  // push and churns org_state, so it must never be publicly invokable.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ ok: false, error: 'CRON_SECRET is not configured' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  // No VAPID keys → don't claim anything (so the backlog still flushes once keys
  // are provisioned); just no-op.
  if (!pushConfigured()) {
    res.status(200).json({ ok: true, skipped: 'vapid_unconfigured' });
    return;
  }
  try {
    const result = await dispatchDue();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}
