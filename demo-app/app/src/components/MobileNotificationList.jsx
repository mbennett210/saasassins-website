// MobileNotificationList — the mobile (≤640px) notifications surface rendered
// inside the bell's MobileSheet (NotificationsBell gates on useIsMobile). A
// triage inbox: an All / Unread segmented filter (the kit .segmented, UI_RULES
// §7), day sections (Today / Yesterday / Earlier) with an unread tally, and slim
// rows carrying a type-colour icon + a left accent. Each row swipes: LEFT to
// dismiss, RIGHT (unread only) to mark read; tapping opens it. The anchored
// desktop dropdown (.bell-list / .bell-item in NotificationsBell) is unchanged —
// this replaces ONLY the sheet body, so the dead-link handling there is untouched.
//
// Colour + icon per event come from EVENT_META below, keyed by the notification
// eventKey (lib/notifications.js catalog). The colour is applied as the CSS var
// --mn via the mnotif--<cat> class, so every hue is a theme token (the re-skin
// guarantee, UI_RULES §121) — no literal reaches this component.

import { useRef, useState } from 'react';
import Icon from './Icon';

// eventKey -> { icon (Icon name), cat (drives --mn via .mnotif--<cat>) }.
// Categories reuse the app's existing semantic/accent palette (the same hues as
// the Badge variants), so type-colour is consistent with the rest of the app.
const EVENT_META = {
  newClientMessage:       { icon: 'mail',         cat: 'message' },
  newDM:                  { icon: 'messaging',    cat: 'message' },
  newInternalMessage:     { icon: 'messaging',    cat: 'message' },
  jobCreatedOrRescheduled:{ icon: 'schedule',     cat: 'schedule' },
  jobCancelled:           { icon: 'schedule',     cat: 'alert' },
  shiftLate:              { icon: 'warning',      cat: 'alert' },
  shiftMissed:            { icon: 'warning',      cat: 'alert' },
  accountOpsUpdated:      { icon: 'settings',     cat: 'account' },
  keyCustody:             { icon: 'lock',         cat: 'keys' },
  keyLost:                { icon: 'lock',         cat: 'alert' },
  reminderFailed:         { icon: 'warning',      cat: 'alert' },
  supplyRequestSubmitted: { icon: 'box',          cat: 'supplies' },
  supplyRequestCompleted: { icon: 'box',          cat: 'supplies' },
  problemReported:        { icon: 'warning',      cat: 'quality' },
  inspectionFailed:       { icon: 'forms',        cat: 'quality' },
  newGoogleReview:        { icon: 'star',         cat: 'reviews' },
  checklistDue:           { icon: 'forms',        cat: 'quality' },
  inspectionDue:          { icon: 'forms',        cat: 'quality' },
  invoicePaid:            { icon: 'dollarCircle', cat: 'paid' },
  invoiceOverdue:         { icon: 'invoices',     cat: 'alert' },
  marketingReplyAssigned: { icon: 'mail',         cat: 'message' },
  inboxExpired:           { icon: 'warning',      cat: 'alert' },
  newLead:                { icon: 'user',         cat: 'sales' },
  quoteSigned:            { icon: 'check',        cat: 'sales' },
};
const metaFor = (eventKey) => EVENT_META[eventKey] || { icon: 'bell', cat: 'account' };

// Relative age. Kept in sync with NotificationsBell's timeAgo (display-only).
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

// Bucket a timestamp into Today / Yesterday / Earlier (local time).
const DAY_MS = 86_400_000;
function dayBucket(iso) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= startToday) return { key: 'today', label: 'Today' };
  if (t >= startToday - DAY_MS) return { key: 'yesterday', label: 'Yesterday' };
  return { key: 'earlier', label: 'Earlier' };
}

// One swipeable row. Horizontal intent is decided against the first move so the
// sheet still scrolls vertically (touch-action: pan-y); once decided we capture
// the pointer and drive the foreground's transform directly off the ref (no
// per-move React render). Past the threshold: left dismisses, right (unread)
// marks read; otherwise it snaps back.
function SwipeRow({ n, unread, dead, onOpen, onDismiss, onMarkRead }) {
  const meta = metaFor(n.eventKey);
  const rowRef = useRef(null);
  const fgRef = useRef(null);
  const g = useRef({ sx: 0, sy: 0, dx: 0, drag: false, decided: false, moved: false, live: false });
  const [removing, setRemoving] = useState(false);
  const THRESHOLD = 88;

  const setDir = (dx) => {
    const row = rowRef.current;
    if (!row) return;
    row.classList.toggle('drag-left', dx < 0);
    row.classList.toggle('drag-right', dx > 0);
  };

  const onPointerDown = (e) => {
    const s = g.current;
    s.sx = e.clientX; s.sy = e.clientY; s.dx = 0;
    s.drag = false; s.decided = false; s.moved = false; s.live = true;
    fgRef.current?.classList.remove('snap');
  };

  const onPointerMove = (e) => {
    const s = g.current;
    if (!s.live) return;
    const dx = e.clientX - s.sx;
    const dy = e.clientY - s.sy;
    if (!s.decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) >= Math.abs(dx)) { s.live = false; return; } // vertical wins -> let it scroll
      s.decided = true; s.drag = true;
      try { fgRef.current.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    }
    if (!s.drag) return;
    s.moved = true;
    // right-swipe only means something for an unread row; otherwise rubber-band it.
    const d = dx > 0 && !unread ? dx * 0.15 : dx;
    s.dx = d;
    setDir(d);
    fgRef.current.style.transform = `translateX(${d}px)`;
  };

  const snapBack = () => {
    const fg = fgRef.current;
    if (fg) fg.style.transform = 'translateX(0)';
    setTimeout(() => rowRef.current?.classList.remove('drag-left', 'drag-right'), 200);
  };

  const remove = () => {
    const fg = fgRef.current;
    if (fg) { fg.classList.add('snap'); fg.style.transform = 'translateX(-110%)'; }
    setRemoving(true);
    setTimeout(() => onDismiss(n.id), 280);
  };

  const onPointerUp = () => {
    const s = g.current;
    if (!s.live) return;
    s.live = false;
    fgRef.current?.classList.add('snap');
    if (s.dx <= -THRESHOLD) remove();
    else if (unread && s.dx >= THRESHOLD) { snapBack(); onMarkRead(n.id); }
    else snapBack();
  };

  const onClick = (e) => {
    if (g.current.moved) { e.preventDefault(); return; } // a swipe, not a tap
    onOpen(n);
  };

  return (
    <li
      ref={rowRef}
      className={`mnotif-row mnotif--${meta.cat}${unread ? ' is-unread' : ''}${dead ? ' is-dead' : ''}${removing ? ' is-removing' : ''}`}
    >
      <span className="mnotif-action mnotif-action-lead" aria-hidden="true"><Icon name="check" size={20} />Read</span>
      <span className="mnotif-action mnotif-action-trail" aria-hidden="true"><Icon name="trash" size={20} /></span>
      <button
        type="button"
        ref={fgRef}
        className="mnotif-open"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        title={dead ? 'This clean was removed from the schedule' : undefined}
      >
        <span className="mnotif-chip"><Icon name={meta.icon} size={17} /></span>
        <span className="mnotif-text">
          <span className="mnotif-title">{n.title}</span>
          {n.body && <span className="mnotif-body">{n.body}</span>}
          {dead && <span className="mnotif-removed">clean removed</span>}
        </span>
        <span className="mnotif-meta">
          <span className="mnotif-time">{timeAgo(n.createdAt)}</span>
          {unread && <span className="mnotif-dot" aria-hidden="true" />}
        </span>
      </button>
    </li>
  );
}

export default function MobileNotificationList({ items, isDeadLink, onOpen, onDismiss, onMarkRead }) {
  const [filter, setFilter] = useState('all');

  if (!items.length) {
    return <div className="bell-empty">You&apos;re all caught up.</div>;
  }

  const unreadTotal = items.reduce((a, n) => a + (n.readAt ? 0 : 1), 0);
  const view = filter === 'unread' ? items.filter((n) => !n.readAt) : items;

  // Group in the order the selector already sorted (createdAt desc).
  const groups = [];
  for (const n of view) {
    const b = dayBucket(n.createdAt);
    let grp = groups.find((x) => x.key === b.key);
    if (!grp) { grp = { key: b.key, label: b.label, rows: [] }; groups.push(grp); }
    grp.rows.push(n);
  }

  return (
    <div className="mnotif">
      <div className="mnotif-toolbar">
        <div className="segmented" role="tablist" aria-label="Filter notifications">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`segmented-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unread'}
            className={`segmented-btn ${filter === 'unread' ? 'active' : ''}`}
            onClick={() => setFilter('unread')}
          >
            Unread{unreadTotal > 0 && <span className="control-count">{unreadTotal}</span>}
          </button>
        </div>
      </div>

      {view.length === 0 ? (
        <div className="bell-empty">No unread notifications.</div>
      ) : (
        <>
          <p className="mnotif-hint" aria-hidden="true">
            <Icon name="arrowLeft" size={14} />Swipe to dismiss, or right to mark read
          </p>
          {groups.map((grp) => {
            const grpUnread = grp.rows.reduce((a, n) => a + (n.readAt ? 0 : 1), 0);
            return (
              <section className="mnotif-day-sec" key={grp.key}>
                <header className="mnotif-day">
                  <span className="mnotif-day-label">{grp.label}</span>
                  {grpUnread > 0 && <span className="mnotif-day-count">{grpUnread} unread</span>}
                </header>
                <ul className="mnotif-list">
                  {grp.rows.map((n) => (
                    <SwipeRow
                      key={n.id}
                      n={n}
                      unread={!n.readAt}
                      dead={isDeadLink(n)}
                      onOpen={onOpen}
                      onDismiss={onDismiss}
                      onMarkRead={onMarkRead}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
