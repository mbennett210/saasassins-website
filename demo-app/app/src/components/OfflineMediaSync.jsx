import { useEffect } from 'react';
import { flushMediaQueue } from '../lib/accountMediaApi';

// Reconnect sync-back for offline-buffered photo/video uploads (crew offline-parity).
// Mirrors OfflineChecklistSync: drains the IndexedDB media buffer by replaying the full
// 3-hop upload (signed URL → Storage → confirm) on load, whenever the network returns,
// on tab focus, and on a slow interval as a backstop. The replay is idempotent
// server-side (confirmUpload keys on the device client_media_id), so an over-eager flush
// can never double-post a shot. Fully best-effort + silent.
const FLUSH_INTERVAL_MS = 60 * 1000;

export default function OfflineMediaSync() {
  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) flushMediaQueue().catch(() => { /* best-effort */ }); };
    run(); // drain anything buffered while the app was offline last session
    const onOnline = () => run();
    const onQueued = () => run();
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('rfs:media-queued', onQueued);
    document.addEventListener('visibilitychange', onVisible);
    const id = setInterval(run, FLUSH_INTERVAL_MS);
    return () => {
      alive = false;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('rfs:media-queued', onQueued);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, []);
  return null;
}
