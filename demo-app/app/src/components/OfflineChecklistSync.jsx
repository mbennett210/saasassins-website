import { useEffect, useRef } from 'react';
import { flushClockQueues } from '../lib/offlineFlush';
import { useAuth } from '../hooks/useAuth';

// Reconnect sync-back for offline-buffered checklist submissions (crew audit C1).
// Drains on load, whenever the network returns, on tab focus, on a fresh queued
// submission, and on a slow interval as a backstop. The replay is idempotent server-side
// (keyed on the device `client_submit_id`), so an over-eager flush can never double-record
// a checklist_results row. Fully best-effort + silent.
//
// 🔴 It goes through lib/offlineFlush, NOT straight at flushChecklistQueue: the checklist
// queue must reach the server BEFORE the punch queue, or a replayed clock-out arrives
// first and the entry is flagged "checklist not finished at clock-out" although the
// cleaner did finish it. Same single-flight pass OfflineClockSync triggers.
const FLUSH_INTERVAL_MS = 60 * 1000;

export default function OfflineChecklistSync() {
  const { currentUser } = useAuth();
  const uidRef = useRef(currentUser?.id || null);
  useEffect(() => { uidRef.current = currentUser?.id || null; }, [currentUser?.id]);

  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) flushClockQueues({ currentUserId: uidRef.current }).catch(() => { /* best-effort */ }); };
    run(); // drain anything buffered while the app was offline last session
    const onOnline = () => run();
    const onQueued = () => run();
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('rfs:checklist-queued', onQueued);
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(run, FLUSH_INTERVAL_MS);
    return () => {
      alive = false;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('rfs:checklist-queued', onQueued);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, []);
  return null;
}
