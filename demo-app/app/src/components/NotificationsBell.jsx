// NotificationsBell — persistent bell icon with unread badge + dropdown panel
// listing the current user's most recent in-app notifications.
//
// Mounted at app root so it's reachable from every page. Reads from
// `state.notifications` via selectors; writes via MARK_NOTIFICATION_READ /
// MARK_ALL_NOTIFICATIONS_READ. Click on a row marks it read AND navigates to
// its url (with `state={ from }` referrer so back-button works).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectNotificationsForUser,
  selectUnreadNotificationCount,
} from '../store/selectors';
import Icon from './Icon';
import { useFromHere } from '../hooks/useFromHere';

const PANEL_LIMIT = 50;

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
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const nav = useFromHere();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const userId = state.currentUserId;
  const unread = selectUnreadNotificationCount(state, userId);
  const items = selectNotificationsForUser(state, userId, PANEL_LIMIT);

  // Click outside / Esc closes the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Close panel automatically when the route changes (clicking an item navigates).
  useEffect(() => { setOpen(false); }, [location.pathname]);

  const handleItemClick = useCallback((n) => {
    if (!n.readAt) dispatch({ type: ACTIONS.MARK_NOTIFICATION_READ, id: n.id });
    if (n.url) navigate(n.url, { state: nav });
    setOpen(false);
  }, [dispatch, navigate, nav]);

  const markAll = () => {
    dispatch({ type: ACTIONS.MARK_ALL_NOTIFICATIONS_READ, userId });
  };

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

      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-panel-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button type="button" className="btn-link" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="bell-empty">You're all caught up.</div>
          ) : (
            <ul className="bell-list">
              {items.map((n) => (
                <li key={n.id} className={`bell-item ${n.readAt ? 'read' : 'unread'}`}>
                  <button type="button" className="bell-item-btn" onClick={() => handleItemClick(n)}>
                    {!n.readAt && <span className="bell-dot" aria-hidden="true" />}
                    <div className="bell-item-text">
                      <div className="bell-item-title">{n.title}</div>
                      {n.body && <div className="bell-item-body">{n.body}</div>}
                      <div className="bell-item-time">{timeAgo(n.createdAt)}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
