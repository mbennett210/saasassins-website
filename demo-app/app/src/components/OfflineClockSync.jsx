import { useEffect, useRef } from 'react';
import { flushClockQueues } from '../lib/offlineFlush';
import { useAuth } from '../hooks/useAuth';

// Reconnect sync-back for buffered offline clock punches (CLEANSPACE_SWEPT.md §5.4).
// Mounted with the other authed background workers, it drains the IndexedDB punch
// buffer to POST /api/time/replay on load, whenever the network returns, and on a
// slow interval as a backstop. The replay is idempotent server-side (keyed on the
// device punch id), so an over-eager flush can never double-record a labor row.
// The current crew id is passed so a punch is only ever replayed by its own owner
// (a shared device never mis-attributes another crew member's buffered labor).
//
// 🔴 It goes through lib/offlineFlush, which drains the CHECKLIST queue first: the server
// must see the finished checklist before the clock-out that closes the clean, or the entry
// is flagged "checklist not finished at clock-out" for a scheduling coincidence.
const FLUSH_INTERVAL_MS = 60 * 1000;

export default function OfflineClockSync() {
  const { currentUser } = useAuth();
  const uidRef = useRef(currentUser?.id || null);
  useEffect(() => { uidRef.current = currentUser?.id || null; }, [currentUser?.id]);

  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) flushClockQueues({ currentUserId: uidRef.current }).catch(() => { /* best-effort */ }); };
    run(); // drain anything buffered while the app was offline last session
    const onOnline = () => run();
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(run, FLUSH_INTERVAL_MS);
    return () => {
      alive = false;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, []);
  return null;
}
