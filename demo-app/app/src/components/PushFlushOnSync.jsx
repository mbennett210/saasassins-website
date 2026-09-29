import { useEffect, useRef } from 'react';
import { useSelector, useSyncStatus } from '../store';
import { flushPush } from '../lib/push';

// Instant push trigger. When a NEW notification row appears AND the shared save has
// landed ('synced'), fire an immediate server dispatch so a DM / thread / SMS-email
// notification reaches subscribed phones in ~1s instead of waiting for the
// every-minute dispatch cron.
//
// Gating on 'synced' is load-bearing: the flush makes the server re-read org_state,
// so the new row must already be persisted there or the dispatch reads a pre-write
// snapshot and sends nothing (then the row waits for the cron anyway). The backlog
// present at mount is seeded as already-handled so a login never re-blasts old rows
// (the cron owns catch-up). flushPush is debounced client-side and idempotent
// server-side, so an extra fire (e.g. a peer's rows arriving over Realtime) is safe.
// Mounted in App BackgroundServices (authed only).
export default function PushFlushOnSync() {
  const notifications = useSelector((s) => s.notifications);
  const syncStatus = useSyncStatus();
  const seenIds = useRef(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    const rows = Array.isArray(notifications) ? notifications : [];
    if (!seeded.current) {
      for (const n of rows) if (n && n.id) seenIds.current.add(n.id);
      seeded.current = true;
      return;
    }
    // Only once the new rows are persisted server-side.
    if (syncStatus !== 'synced') return;
    let hasNew = false;
    for (const n of rows) { if (n && n.id && !seenIds.current.has(n.id)) { hasNew = true; break; } }
    if (!hasNew) return;
    for (const n of rows) if (n && n.id) seenIds.current.add(n.id);
    flushPush();
  }, [notifications, syncStatus]);

  return null;
}
