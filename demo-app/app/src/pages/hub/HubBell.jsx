import AnchoredPortal from '../../demo/AnchoredPortal'; // polishpoint-demo
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Icon from '../../components/Icon';
import MobileSheet from '../../components/MobileSheet';
import { useDismissTap } from '../../hooks/useDismissTap';
import { useFromHere } from '../../hooks/useFromHere';
import { useIsMobile } from '../../hooks/useIsMobile';
import { hubAgo } from '../../lib/hubMessages';
import { useHubUpdates, markHubUpdatesOpened } from './hubUpdates';

// THE BELL (plan §3.4): what changed for this customer in the last 30 days, across their
// buildings — the office's replies on their requests, a request's new stage, the office's
// messages, new inspection reports — newest first, at most 20 (GET /api/hub/updates, read once
// for the hub by ./hubUpdates.js). The HUB_BELL slot (./hubSlots.js) places it on the phone's
// top bar and the desktop's Home bar.
//
// The badge is the count not yet seen. Opening the bell re-reads it and marks it seen
// (POST updates-seen); the rows keep their "new" dot while it is open. A desktop gets a popover
// that an outside tap or Esc closes (and EATS the tap, UI_RULES §100); a phone the shared bottom
// sheet (MobileSheet, UI_RULES §105). Each row links to its page with its referrer. English
// (LANG-8), like every hub word.
// In the office's READ-ONLY preview (`readOnly`, UI_RULES §151) opening it marks nothing seen: there
// is no customer. A preview acting as the customer marks its stand-in's bell seen, as a customer's.
export default function HubBell({ readOnly = false }) {
  const { data, error } = useHubUpdates();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const panelRef = useRef(null); // polishpoint-demo: the desktop panel, at the page's top level
  const isMobile = useIsMobile();
  const nav = useFromHere();
  const { pathname } = useLocation();

  useDismissTap({ open: open && !isMobile, ref: wrapRef, ref2: panelRef, onDismiss: () => setOpen(false) });
  // A row navigates; the bell closes on any page change.
  useEffect(() => { setOpen(false); }, [pathname]);

  const unseen = Number(data?.unseen) || 0;
  const items = Array.isArray(data?.updates) ? data.updates : [];
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !readOnly) markHubUpdatesOpened();
  };
  const count = unseen > 99 ? '99+' : String(unseen);

  let body;
  if (!data && error) body = <div className="bell-empty">{error}</div>;
  else if (!data) body = <div className="bell-empty">Loading…</div>;
  else if (!items.length) body = <div className="bell-empty">Nothing new</div>;
  else {
    body = (
      <ul className="bell-list hub-bell-list">
        {items.map((u) => (
          <li key={`${u.kind}|${u.url}|${u.at}|${u.text}`} className={`bell-item ${u.unread ? 'unread' : 'read'}`}>
            <Link className="bell-item-btn" to={u.url} state={nav} onClick={() => setOpen(false)}>
              {u.unread && <span className="bell-dot" aria-hidden="true" />}
              <span className="bell-item-text">
                <span className="hub-bell-text">{u.text}</span>
                <span className="bell-item-time">{[u.buildingName, hubAgo(u.at)].filter(Boolean).join(' · ')}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="bell-wrap hub-bell" ref={wrapRef}>
      <button
        type="button"
        className={`bell-btn ${open ? 'open' : ''}`}
        onClick={toggle}
        aria-label={unseen > 0 ? `Updates, ${count} new` : 'Updates'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="bell" size={18} />
        {unseen > 0 && <span className="bell-badge" aria-hidden="true">{count}</span>}
      </button>
      {isMobile ? (
        <MobileSheet
          open={open}
          onClose={() => setOpen(false)}
          title="Updates"
          titleAside={unseen > 0 ? <span className="mnotif-count">{count}</span> : null}
        >
          {body}
        </MobileSheet>
      ) : (open && (
        <AnchoredPortal anchorRef={wrapRef} ref={panelRef}><div className="bell-panel" role="dialog" aria-label="Updates">
          <div className="bell-panel-head"><strong>Updates</strong></div>
          {body}
        </div></AnchoredPortal>
      ))}
    </div>
  );
}
