// POST /api/push/flush — authed INSTANT dispatch. The client calls this right after
// a save that added notification rows (a DM, a thread/channel message, an inbound
// SMS or email surfaced by a listener), so the push goes out in ~1s instead of
// waiting up to a minute for the /api/push/dispatch cron.
//
// Same shared core (_lib/push/dispatch) as the cron, so it is idempotent with it
// (CAS reserve-then-send) and can never double-send. Any signed-in user may call
// it: it only sends ALREADY-CREATED rows to THEIR tagged recipients' devices
// (routing is not caller-controlled), and after the first run there is nothing
// unpushed left, so repeats are cheap no-ops. The client debounces its calls.
import { requireAuthority } from '../_lib/authz.js';
import { dispatchDue } from '../_lib/push/dispatch.js';
import { pushConfigured } from '../_lib/push/store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const a = await requireAuthority(req, res);
    if (!a) return; // 401 already written
    if (!pushConfigured()) { res.status(200).json({ ok: true, skipped: 'vapid_unconfigured' }); return; }
    const result = await dispatchDue();
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
