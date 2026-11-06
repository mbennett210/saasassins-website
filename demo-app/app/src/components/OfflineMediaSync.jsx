import { useEffect } from 'react';
import { flushMediaOnly } from '../lib/offlineFlush';

// Reconnect sync-back for offline-buffered photo/video uploads (crew offline-parity).
// Mirrors OfflineChecklistSync: drains the IndexedDB media buffer by replaying the full
// 3-hop upload (signed URL → Storage → confirm) on load, whenever the network returns,
// on tab focus, and on a slow interval as a backstop. The replay is idempotent
// server-side (confirmUpload keys on the device client_media_id), so an over-eager flush
// can never double-post a shot. Fully best-effort + silent.
//
// 🔴 It goes through lib/offlineFlush, NOT straight at flushMediaQueue: a checklist item
// the office marked "photo required" is counted against the photos that have LANDED
// (CS-547), so the media queue and the checklist queue have an order between them now,
// and both drain under one single-flight key (lib/queueFlushOrder). Called directly, this
// background pump could drain media concurrently with the ordered pass instead of being
// part of it.
const FLUSH_INTERVAL_MS = 60 * 1000;

export default function OfflineMediaSync() {
  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) flushMediaOnly().catch(() => { /* best-effort */ }); };
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
