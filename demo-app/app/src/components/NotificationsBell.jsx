// NotificationsBell — persistent bell icon with unread badge + dropdown panel
// listing the current user's most recent in-app notifications.
//
// Mounted at app root so it's reachable from every page. Reads from
// `state.notifications` via selectors; writes via MARK_NOTIFICATION_READ /
// MARK_ALL_NOTIFICATIONS_READ. Click on a row marks it read AND navigates to
// its url (with `state={ from }` referrer so back-button works).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSelector, useDispatch, useJobsHydrated, shallowEqual } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectNotificationsForUser,
  selectUnreadNotificationCount,
} from '../store/selectors';
import Icon from './Icon';
import { useFromHere } from '../hooks/useFromHere';
import { useDismissTap } from '../hooks/useDismissTap';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileSheet from './MobileSheet';
import MobileNotificationList from './MobileNotificationList';

const PANEL_LIMIT = 50;

// ── Dead job links ───────────────────────────────────────────────────────────
// A notification's `url` outlives the record it points at. The reducer scrubs
// `/schedule/<id>` links when IT deletes a job (DELETE_JOB, DELETE_JOB_SERIES,
// UPDATE_JOB_SERIES' day drop) — but the app is not the only thing that deletes
// jobs. A retention tail-trim run as bulk SQL removes rows without any reducer
// action, so no scrub fires. Measured on live 2026-07-22: 50 bell rows across 29
// job ids that no longer exist, 46 of them UNREAD, spread over 20 crew — six
// traced to a single bulk statement at 2026-07-21T23:48:25.984Z. Tapping one
// lands a cleaner on "Job not found".
//
// Delete-time scrubbing therefore cannot be the whole answer; the read side has
// to cope. Hence this.
//
// 🔴 GATED ON FULL HYDRATION, AND THAT GATE IS THE WHOLE TRICK. `state.jobs` is
// only a ~-45/+100-day WINDOW until the detached backfill lands, so "not in
// state.jobs" means "deleted" ONLY once everything is loaded. Judging it against
// the window would mark every out-of-window job dead and strip working links off
// notifications for real future cleans — the exact false positive that made the
// first count of this bug wrong by 20. Un-hydrated → treat every link as live
// (status quo, fails safe).
const jobIdOfUrl = (url) => {
  const m = /^\/schedule\/([^/?#]+)$/.exec(url || '');
  return m ? m[1] : null;
};

// The job ids among `rows` that no longer exist in `jobs`. Lives at module scope and
// returns an ARRAY so the useSelector below can be a single expression ending in
// .join(',') — a string, which the default Object.is comparer settles. Inlining this
// as a block-bodied arrow made test-selector-benefit read the leading `{` as an object
// literal and (wrongly, but not unreasonably) call the selector reference-returning.
function deadJobIds(jobs, rows) {
  const live = new Set(jobs.map((j) => j.id));
  return rows.map((n) => jobIdOfUrl(n.url)).filter((id) => id && !live.has(id));
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationsBell({ className = '' }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const nav = useFromHere();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const isMobile = useIsMobile();

  // Increment 0.4. This is mounted twice in AppLayout for the whole session, so on the
  // whole-snapshot useStore() it re-rendered on every dispatch in the app.
  //
  // The comparers here are NOT interchangeable — this is the one call site in the
  // first migration wave where the default would be wrong:
  //   • currentUserId and the unread COUNT are scalars      -> default Object.is
  //   • selectNotificationsForUser does .filter().slice()   -> a FRESH ARRAY per call,
  //     so the default would never match and the bell would re-render on every
  //     dispatch exactly as before. shallowEqual compares the elements by reference,
  //     and notification rows keep their identity across dispatches that do not touch
  //     them, so an unrelated dispatch now bails out.
  const userId = useSelector((s) => s.currentUserId);
  const unread = useSelector((s) => selectUnreadNotificationCount(s, userId));
  const items = useSelector((s) => selectNotificationsForUser(s, userId, PANEL_LIMIT), shallowEqual);

  // Which of the visible rows point at a job that is genuinely gone.
  //
  // Cost is paid ONLY while the panel is open: this bell is mounted for the whole
  // session (twice, per the note above) and `jobs` churns constantly under realtime,
  // so building an id set on every job change would undo the useSelector work above.
  // Closed panel → the selector returns '' without ever touching s.jobs. The result is
  // a STRING so the default Object.is comparer settles it — returning a Set or array
  // would be a fresh reference every call and re-render the bell on every dispatch.
  const jobsHydrated = useJobsHydrated();
  const deadKey = useSelector((s) => (!open || !jobsHydrated ? '' : deadJobIds(s.jobs, items).join(',')));
  const deadIds = useMemo(() => new Set(deadKey ? deadKey.split(',') : []), [deadKey]);
  const isDeadLink = useCallback((n) => {
    const id = jobIdOfUrl(n.url);
    return !!id && deadIds.has(id);
  }, [deadIds]);

  // DESKTOP dismissal for the anchored dropdown: click-outside / Esc, capture-phase so the
  // tap is EATEN and never also activates whatever sits behind it (UI_RULES §100). The bell
  // trigger + panel live inside wrapRef, so their own clicks still run (the button toggles
  // closed, an item navigates). On MOBILE the panel renders as a portaled MobileSheet
  // (UI_RULES §105 / THEME_CLEANSPACE R9) with its own full-screen backdrop + Esc, which
  // both closes on an outside tap AND blocks tap-through to the inbox behind it, so the
  // anchored-popover dismiss is gated OFF on mobile.
  useDismissTap({ open: open && !isMobile, ref: wrapRef, onDismiss: () => setOpen(false) });

  // Close panel automatically when the route changes (clicking an item navigates).
  useEffect(() => { setOpen(false); }, [location.pathname]);

  const handleItemClick = useCallback((n) => {
    if (!n.readAt) dispatch({ type: ACTIONS.MARK_NOTIFICATION_READ, id: n.id });
    // A dead link still marks read and closes — it just doesn't strand the user on
    // "Job not found". The row stays in the list (it's real history: the clean WAS
    // assigned) and is labelled, so nobody is left wondering where it went.
    if (n.url && !isDeadLink(n)) navigate(n.url, { state: nav });
    setOpen(false);
  }, [dispatch, navigate, nav, isDeadLink]);

  const markAll = () => {
    dispatch({ type: ACTIONS.MARK_ALL_NOTIFICATIONS_READ, userId });
  };

  const clearAll = () => {
    dispatch({ type: ACTIONS.CLEAR_NOTIFICATIONS, userId });
  };

  const dismiss = useCallback((e, id) => {
    e.stopPropagation();
    dispatch({ type: ACTIONS.REMOVE_NOTIFICATION, id });
  }, [dispatch]);

  const panelActions = items.length > 0 && (
    <div className="bell-panel-actions">
      {unread > 0 && (
        <button type="button" className="btn btn-link" onClick={markAll}>
          Mark all read
        </button>
      )}
      <button type="button" className="btn btn-link" onClick={clearAll}>
        Clear all
      </button>
    </div>
  );

  const panelList = items.length === 0 ? (
    <div className="bell-empty">You're all caught up.</div>
  ) : (
    <ul className="bell-list">
      {items.map((n) => {
        const dead = isDeadLink(n);
        return (
        <li key={n.id} className={`bell-item ${n.readAt ? 'read' : 'unread'}${dead ? ' dead-link' : ''}`}>
          <button
            type="button"
            className="bell-item-btn"
            onClick={() => handleItemClick(n)}
            title={dead ? 'This clean was removed from the schedule' : undefined}
          >
            {!n.readAt && <span className="bell-dot" aria-hidden="true" />}
            <div className="bell-item-text">
              <div className="bell-item-title">{n.title}</div>
              {n.body && <div className="bell-item-body">{n.body}</div>}
              <div className="bell-item-time">
                {timeAgo(n.createdAt)}
                {dead && <span className="bell-item-removed"> · clean removed</span>}
              </div>
            </div>
          </button>
          <button
            type="button"
            className="btn-icon btn-icon-ghost"
            aria-label="Dismiss notification"
            onClick={(e) => dismiss(e, n.id)}
          >
            <Icon name="x" size={14} />
          </button>
        </li>
        );
      })}
    </ul>
  );

  return (
    <div className={`bell-wrap ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={`bell-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="bell-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {/* Mobile: a portaled bottom sheet whose full-screen backdrop escapes .main's stacking
          context, sits above the floating nav, closes on an outside tap, and blocks tap-through
          to the inbox behind (UI_RULES §105 / THEME_CLEANSPACE R9). Desktop: anchored dropdown. */}
      {isMobile ? (
        <MobileSheet open={open} onClose={() => setOpen(false)} title="Notifications">
          {panelActions && <div className="bell-sheet-actions">{panelActions}</div>}
          <MobileNotificationList
            items={items}
            isDeadLink={isDeadLink}
            onOpen={handleItemClick}
            onDismiss={(id) => dispatch({ type: ACTIONS.REMOVE_NOTIFICATION, id })}
            onMarkRead={(id) => dispatch({ type: ACTIONS.MARK_NOTIFICATION_READ, id })}
          />
        </MobileSheet>
      ) : (open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-panel-head">
            <strong>Notifications</strong>
            {panelActions}
          </div>
          {panelList}
        </div>
      ))}
    </div>
  );
}
