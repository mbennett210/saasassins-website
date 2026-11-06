// THE BELL'S ANSWER, read ONCE for the whole hub (the client hub redesign, plan §3.4, Wave B).
//
// GET /api/hub/updates (or the demo's twin) answers the bell's list AND `messagesUnread`, the
// Messages badge's count. The layout (the nav badge, through ctx.updates), the bell (twice: the
// phone's top bar and the desktop's Home bar, each mounted, one hidden by CSS) and the Messages page
// (which clears its badge) all read this one store — one request a minute however many are
// mounted. The store's rules are lib/hubUpdatesStore.js (pure, held by
// scripts/test-hub-messages-screens.mjs); this file binds it to the hub's adapter and to React.
import { useEffect, useSyncExternalStore } from 'react';
import { fetchHubUpdates, markHubUpdatesSeen } from '../../lib/clientHubApi';
import { createHubUpdatesStore } from '../../lib/hubUpdatesStore';

export const HUB_UPDATES_POLL_MS = 60000;
const store = createHubUpdatesStore({ fetchUpdates: fetchHubUpdates, markSeen: markHubUpdatesSeen, pollMs: HUB_UPDATES_POLL_MS });

// Re-read now (the Messages page, after it marks a thread read).
export const reloadHubUpdates = () => store.reload();
// The bell opening: re-read, mark seen, clear the count.
export const markHubUpdatesOpened = () => store.opened();

// { data, error } — `data` is the bell's answer ({ updates, unseen, seenAt, messagesUnread }) or
// null before the first read. The one place that knows the viewer (the layout) passes its key, so
// a different viewer starts clean; the bell and the pages pass nothing.
export function useHubUpdates(viewerKey) {
  useEffect(() => { store.setViewer(viewerKey); }, [viewerKey]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
