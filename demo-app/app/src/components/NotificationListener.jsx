// NotificationListener — the viewer-only TRANSIENT surface (toasts + browser-tab
// title badge) that complements the durable bell inbox.
//
// It toasts off NEW bell rows for the current user rather than re-deriving events
// from state.jobs/messages/invoices. Those durable rows are stamped by the
// fan-out helpers (lib/notifications) at action time with the correct recipient
// gating — prefs opt-out, role/permission visibility, thread muting, and actor
// self-exclusion — so toasting them inherits all of it for free:
//   - standing crew (who get bell rows) now get toasts too, not just named crew;
//   - every event family that fans out (ops / key / marketing /
//     problem / quote / reminder-failed / added-to-thread), not only
//     messages+jobs+invoices, surfaces a toast;
//   - the actor never toasts their own action (the fan-outs already skip them).
//
// First-render guard: seed the "seen" set from existing rows on mount (and on a
// user switch) so pre-existing history never toasts — only rows added after
// mount fire.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../store';
import { useToast } from './Toast';
import { setUnreadCount } from '../lib/documentTitle';
import { selectUnreadNotificationCount } from '../store/selectors';

// Above this many fresh rows in one batch (e.g. a resync after a long-hidden
// tab), collapse into a single digest toast instead of stacking N.
const MAX_INDIVIDUAL_TOASTS = 3;

export default function NotificationListener() {
  const state = useStore();
  const toast = useToast();
  const location = useLocation();
  const seenRef = useRef(null);

  const currentUserId = state.currentUserId;

  // Tab title — driven by the persistent bell unread count for the current user.
  // Same source the bell badge uses, so they always agree.
  const totalUnread = selectUnreadNotificationCount(state, currentUserId);
  useEffect(() => { setUnreadCount(totalUnread); }, [totalUnread]);

  useEffect(() => {
    if (!currentUserId) return;
    const rows = (state.notifications || []).filter((n) => n.userId === currentUserId);

    // Seed on first mount and whenever the viewer changes, so we never blast
    // toasts for the new user's existing history.
    if (!seenRef.current || seenRef.current.userId !== currentUserId) {
      seenRef.current = { userId: currentUserId, ids: new Set(rows.map((n) => n.id)) };
      return;
    }

    const seen = seenRef.current.ids;
    const fresh = rows.filter((n) => !seen.has(n.id));
    if (fresh.length === 0) return;
    fresh.forEach((n) => seen.add(n.id));

    // Suppress a toast for the message thread the user is already looking at —
    // the row still lands in the bell + tab title, it just doesn't pop a toast
    // on top of the conversation they're reading.
    const path = location.pathname || '';
    const shown = fresh.filter((n) => !(
      typeof n.url === 'string' && n.url.startsWith('/messaging/') && path.startsWith(n.url)
    ));
    if (shown.length === 0) return;

    if (shown.length > MAX_INDIVIDUAL_TOASTS) {
      toast.info(`${shown.length} new notifications`);
      return;
    }
    for (const n of shown) {
      toast.info(n.body ? `${n.title}: ${n.body}` : n.title);
    }
  }, [state.notifications, currentUserId, location.pathname, toast]);

  return null;
}
