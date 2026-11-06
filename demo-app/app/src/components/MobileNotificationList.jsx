// MobileNotificationList — the phone (≤640px) notifications list rendered inside the bell's
// MobileSheet (NotificationsBell gates on useIsMobile). A QUIET list (owner pick 2026-10-03:
// mockup "A, quiet list" with "C"'s filter chips): plain rows on the white sheet, a neutral
// icon disc that turns red only for an ALERT, unread shown ONCE (a dot and a bold title; no
// row tint, no colour bar), two lines of detail, and day labels.
//
// Filter chips (the kit .chip + .control-count) narrow the list to one kind: Alerts,
// Messages, Work, Supplies, Money. A chip appears only when it has something to show, and
// the chip row is left out when everything is one kind, so a cleaner who only ever gets
// schedule news never sees five empty filters.
//
// Each row swipes: LEFT to dismiss, RIGHT (unread only) to mark read; tapping opens it.
// "Clear all" sits at the foot of the list and asks there, in place, before it runs. The anchored
// desktop dropdown (.bell-list in NotificationsBell) is unchanged, and so is its dead-link
// handling: this component only renders what isDeadLink says.
//
// Icon, chip and alert per event come from lib/notificationMeta (every catalog event has a
// row: test-notification-meta.mjs). Every colour is a theme token (UI_RULES §121).

import { useRef, useState } from 'react';
import Icon from './Icon';
import { useT } from '../i18n/react';
import { timeAgo } from '../i18n/relative';
import { dayKey, addDaysKey } from '../lib/dates';
import { NOTIFICATION_FILTERS, notificationMeta } from '../lib/notificationMeta';

// Relative age: the shared, translated one (src/i18n/relative — the bell's too).
// Bucket a timestamp into Today / Yesterday / Earlier, on the ORG's calendar (lib/dates) —
// the same "today" My Day and the schedule use, not the device's. The label is a catalog key.
function dayBucket(iso) {
  const today = dayKey(new Date());
  const day = dayKey(iso);
  if (day === today) return { key: 'today', labelKey: 'notif.today' };
  if (day === addDaysKey(today, -1)) return { key: 'yesterday', labelKey: 'notif.yesterday' };
  return { key: 'earlier', labelKey: 'notif.earlier' };
}

// One swipeable row. Horizontal intent is decided against the first move so the
// sheet still scrolls vertically (touch-action: pan-y); once decided we capture
// the pointer and drive the foreground's transform directly off the ref (no
// per-move React render). Past the threshold: left dismisses, right (unread)
// marks read; otherwise it snaps back.
function SwipeRow({ n, unread, dead, onOpen, onDismiss, onMarkRead }) {
  const t = useT();
  const meta = notificationMeta(n.eventKey);
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
      className={`mnotif-row${unread ? ' is-unread' : ''}${meta.alert ? ' is-alert' : ''}${dead ? ' is-dead' : ''}${removing ? ' is-removing' : ''}`}
    >
      <span className="mnotif-action mnotif-action-lead" aria-hidden="true"><Icon name="check" size={20} />{t('notif.read')}</span>
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
        title={dead ? t('notif.removedTitle') : undefined}
      >
        <span className="mnotif-icon">
          {unread && <span className="mnotif-dot" aria-hidden="true" />}
          <Icon name={meta.icon} size={18} />
        </span>
        <span className="mnotif-main">
          <span className="mnotif-text">
            <span className="mnotif-title">{n.title}</span>
            {n.body && <span className="mnotif-body">{n.body}</span>}
            {dead && <span className="mnotif-removed"><Icon name="x" size={12} />{t('notif.cleanDeleted')}</span>}
          </span>
          <span className="mnotif-time">{timeAgo(t, n.createdAt)}</span>
        </span>
      </button>
    </li>
  );
}

export default function MobileNotificationList({ items, isDeadLink, onOpen, onDismiss, onMarkRead, onClearAll }) {
  const t = useT();
  const [filter, setFilter] = useState('all');
  const [confirming, setConfirming] = useState(false);

  if (!items.length) {
    return <div className="bell-empty">{t('notif.allCaughtUp')}</div>;
  }

  const filterOf = (n) => notificationMeta(n.eventKey).filter;
  // The kinds actually present, in the chips' fixed order. One kind (or none) needs no chips.
  const present = NOTIFICATION_FILTERS.filter((f) => items.some((n) => filterOf(n) === f.id));
  const showChips = present.length > 1;
  // A chip whose last row was just dismissed falls back to All rather than an empty list.
  const active = showChips && present.some((f) => f.id === filter) ? filter : 'all';
  const view = active === 'all' ? items : items.filter((n) => filterOf(n) === active);
  const unreadIn = (id) => items.reduce((a, n) => a + (!n.readAt && (id === 'all' || filterOf(n) === id) ? 1 : 0), 0);
  const chips = [{ id: 'all', labelKey: 'notif.all' }, ...present];

  // Group in the order the selector already sorted (createdAt desc).
  const groups = [];
  for (const n of view) {
    const b = dayBucket(n.createdAt);
    let grp = groups.find((x) => x.key === b.key);
    if (!grp) { grp = { key: b.key, labelKey: b.labelKey, rows: [] }; groups.push(grp); }
    grp.rows.push(n);
  }

  return (
    <div className="mnotif">
      {showChips && (
        <div className="mnotif-chips" role="tablist" aria-label={t('notif.filterAria')}>
          {chips.map((c) => {
            const count = unreadIn(c.id);
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={active === c.id}
                className={`chip${active === c.id ? ' on' : ''}`}
                onClick={() => setFilter(c.id)}
              >
                {t(c.labelKey)}{count > 0 && <span className="control-count">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {groups.map((grp) => (
        <section className="mnotif-day-sec" key={grp.key}>
          <h4 className="mnotif-day">{t(grp.labelKey)}</h4>
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
      ))}

      {/* Clear all asks IN PLACE: a Modal (z 100) would open underneath this sheet (z 400). */}
      <div className="mnotif-foot">
        {confirming ? (
          <div className="mnotif-confirm" role="group" aria-label={t('notif.clearAllTitle')}>
            <p className="mnotif-confirm-text"><strong>{t('notif.clearAllTitle')}</strong> {t('notif.clearAllBody')}</p>
            <div className="mnotif-confirm-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-danger" onClick={() => { setConfirming(false); onClearAll(); }}>{t('notif.clearAll')}</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-link" onClick={() => setConfirming(true)}>{t('notif.clearAll')}</button>
        )}
      </div>
    </div>
  );
}
