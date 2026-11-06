import { createPortal } from 'react-dom'; // polishpoint-demo
import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Avatar from './Avatar';
import Icon from './Icon';
import ConversationMessagePanel from './ConversationMessagePanel';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePermission } from '../hooks/usePermission';
import { useMessageSender } from '../hooks/useMessageSender';
import { useDismissTap } from '../hooks/useDismissTap';
import { useEscapeLayer } from '../hooks/useEscapeLayer';
import {
  selectContactById,
  selectConversationById,
  selectMessagesForConversation,
  selectUnreadForConversation,
  selectOtherParticipant,
  selectConversationsForInbox,
  selectUnreadCountForInbox,
} from '../store/selectors';
import { useT } from '../i18n/react';
import { timeShort } from '../i18n/relative';

// DESKTOP-ONLY floating messages launcher — the desktop counterpart to the mobile
// FloatingNav (which renders null on desktop). This renders null on mobile
// (≤640px) so the mobile shell/PWA is untouched: the mobile path already reaches
// Messaging through the floating-nav "Messaging" tab. Instagram-style: a
// drop-shadowed pill with an unread count that expands to a compact docked inbox
// with a Messages / Channels / DM selector. The three segments map to the app's
// real inbox buckets (inbox / internal / dm) and reuse the live scoped selectors,
// so counts + rows match the full Messaging page exactly.
//
// Clicking a row opens that thread as an in-dock MINI VIEW (no navigation): a
// compact ConversationMessagePanel (rendered headless — this dock supplies the
// back/title/expand/close chrome) with the same live message list + composer as
// the full page, sending through the shared useMessageSender pipeline so there's
// zero drift. The expand control jumps to the full Messaging page — to the open
// thread from the mini view, or to the inbox from the list view.

// The three selector segments. `key` is the real inbox bucket
// (selectConversationsForInbox); `label` is the launcher-facing name. NOTE: the
// full Messaging page labels these Inbox / Channels / DMs — see MessagingHeader.
const INBOX_TABS = [
  { key: 'inbox', labelKey: 'messages.dock.messages' },
  { key: 'internal', labelKey: 'messages.channels' },
  { key: 'dm', labelKey: 'messages.dock.dm' },
];

function initialsFromContact(contact) {
  if (!contact) return 'T';
  const first = (contact.firstName || '')[0] || '';
  const last = (contact.lastName || '')[0] || '';
  return `${first}${last}`.toUpperCase() || 'C';
}

// Build one conversation's row view-model. Mirrors ConversationThreadList.ThreadRow
// so the dock's display (name / preview / time / unread) can't drift from the page.
function deriveRow(state, conversation, currentUserId, t) {
  const isDm = conversation.channel === 'dm';
  const isInternal = conversation.channel === 'internal';
  const msgs = selectMessagesForConversation(state, conversation.id);
  const last = msgs[msgs.length - 1];
  const unread = selectUnreadForConversation(state, conversation.id);

  let displayName;
  let initials;
  let avatarVariant;
  let avatarUser = null; // a DM's teammate: their photo shows (UI_RULES §141)
  if (isDm) {
    const other = selectOtherParticipant(state, conversation, currentUserId);
    avatarUser = other || null;
    displayName = other ? other.name : t('messages.unknownUser');
    initials = other?.initials || '?';
    avatarVariant = other?.avatar || 1;
  } else if (isInternal) {
    displayName = conversation.title || t('messages.teamDiscussion');
    initials = 'T';
    avatarVariant = 3;
  } else {
    const contact = conversation.contactId ? selectContactById(state, conversation.contactId) : null;
    displayName = contact ? `${contact.firstName} ${contact.lastName}` : t('messages.unlinked');
    initials = initialsFromContact(contact);
    avatarVariant = ((contact?.id?.length || 0) % 5) + 1;
  }

  return {
    id: conversation.id,
    displayName,
    initials,
    avatarVariant,
    avatarUser,
    preview: last && last.text ? last.text : t('messages.noMessagesYet'),
    time: timeShort(t, last ? last.sentAt : conversation.createdAt),
    unread,
  };
}

// A short one-liner under the mini-view name — enough context to know which
// thread you're in without the full page's header.
function subtitleFor(conversation, contact, t) {
  if (conversation.channel === 'dm') return t('messages.dock.subDm');
  if (conversation.channel === 'internal') return t('messages.dock.subChannel');
  return contact?.email || contact?.phone || (conversation.channel === 'email' ? t('messages.dock.subEmail') : t('messages.dock.subText'));
}

const cap = (n) => (n > 99 ? '99+' : String(n));

export default function MessagesDock() {
  const t = useT();
  const isMobile = useIsMobile();
  const canUseMessaging = usePermission('messaging.use');
  const state = useStore();
  const dispatch = useDispatch();
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { sendMessage, retryMessage } = useMessageSender();
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState('inbox');
  // The thread opened as an in-dock mini view (null = show the conversation list).
  const [activeConvId, setActiveConvId] = useState(null);
  const rootRef = useRef(null);

  // Outside-tap dismissal via the canonical capture-phase hook, which EATS the tap so
  // closing the dock never also activates whatever sat under it (UI_RULES §100: the old
  // hand-rolled listener here closed on an outside click but did NOT swallow it, so the
  // same tap fell through to the page behind). The launcher + rows live inside rootRef, so
  // their own clicks still toggle/navigate. Escape is handled separately below (it backs out
  // of the mini view first), so this hook's own Escape is disabled.
  useDismissTap({ open, ref: rootRef, escape: false, onDismiss: () => setOpen(false) });

  // The dock is a layer on the one Escape stack (UI_RULES §181), so a menu opened inside it takes
  // Esc first and the dock stays where it was.
  useEscapeLayer(open, () => {
    if (activeConvId) setActiveConvId(null); // first Escape: mini view → list
    else setOpen(false);                     // already at the list: close the dock
  });

  // Reopening the dock always starts at the conversation list, never mid-thread.
  useEffect(() => { if (!open) setActiveConvId(null); }, [open]);

  if (isMobile) return null;        // DESKTOP ONLY
  if (!canUseMessaging) return null;
  // Not on Messaging itself: the page IS the full inbox, and the floating launcher sat over its
  // composer — over the input at an iPad's 820, over Send at 1024 and 1180 (CS-704, UI_RULES §164).
  if (pathname === '/messaging' || pathname.startsWith('/messaging/')) return null;

  // Per-bucket unread (drives the segment pills + the launcher total). Plain selector calls
  // (no hooks), so they sit AFTER the early returns: a phone pays nothing. The counts are
  // memoized in the store's selectors — one pass over the messages per change of the
  // messages, threads or viewer (CS-811) — because this dock re-renders on every address
  // change and every store change.
  const counts = {
    inbox: selectUnreadCountForInbox(state, 'inbox', currentUser),
    internal: selectUnreadCountForInbox(state, 'internal', currentUser),
    dm: selectUnreadCountForInbox(state, 'dm', currentUser),
  };
  const total = counts.inbox + counts.internal + counts.dm;

  // Mini-view thread. Only resolved when a row is open. The dock's inline composer
  // is SMS / channels / DMs only — email threads never open here (openConversation
  // routes them out), so no connected-inbox / email-blocker plumbing is needed.
  const activeConv = activeConvId ? selectConversationById(state, activeConvId) : null;
  // The list's rows only while the list is on screen (each reads its thread's messages).
  const rows = open && !activeConv
    ? selectConversationsForInbox(state, inbox, currentUser).slice(0, 30).map((c) => deriveRow(state, c, currentUser?.id, t))
    : [];
  const activeContact = activeConv?.contactId ? selectContactById(state, activeConv.contactId) : null;
  const activeMessages = activeConv ? selectMessagesForConversation(state, activeConv.id) : [];
  const activeRow = activeConv ? deriveRow(state, activeConv, currentUser?.id, t) : null;

  const openFull = () => { setOpen(false); navigate('/messaging'); };
  const openFullThread = (id) => { setOpen(false); navigate(`/messaging/${id}`); };
  const openConversation = (id) => {
    // Email is full-page only — its reply needs Sending-as / Subject / Review &
    // Send, which don't belong in a 384px dock. Deep-link to the full thread.
    const conv = selectConversationById(state, id);
    if (conv?.channel === 'email') { openFullThread(id); return; }
    if (selectUnreadForConversation(state, id) > 0) {
      dispatch({ type: ACTIONS.MARK_CONVERSATION_READ, id, currentUserId: currentUser?.id });
    }
    setActiveConvId(id);
  };
  const selectTab = (key) => { setInbox(key); setActiveConvId(null); };

  const handleMiniSend = (text, opts) => sendMessage(activeConv, activeContact, activeMessages, text, opts);
  const handleMiniRetry = (message) => retryMessage(activeConv, activeContact, message);

  return createPortal( // polishpoint-demo: the dock at the page's top level
    <div ref={rootRef} className={`cs-msg-dock ${open ? 'is-open' : ''}`}>
      {open && activeConv && (
        <div className="cs-msg-panel" role="dialog" aria-label={t('messages.dock.conversationWith', { name: activeRow.displayName })}>
          <div className="cs-msg-panel-head cs-msg-mini-head">
            <button
              type="button"
              className="btn-icon btn-icon-ghost"
              title={t('messages.dock.back')}
              aria-label={t('messages.dock.back')}
              onClick={() => setActiveConvId(null)}
            >
              <Icon name="chevronLeft" size={18} />
            </button>
            <Avatar user={activeRow.avatarUser} initials={activeRow.initials} variant={activeRow.avatarVariant} size="sm" />
            <div className="cs-msg-mini-title">
              <div className="cs-msg-mini-name">{activeRow.displayName}</div>
              <div className="cs-msg-mini-sub">{subtitleFor(activeConv, activeContact, t)}</div>
            </div>
            <div className="cs-msg-panel-ctrls">
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title={t('messages.dock.openFull')}
                aria-label={t('messages.dock.openFull')}
                onClick={() => openFullThread(activeConv.id)}
              >
                <Icon name="expand" size={16} />
              </button>
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title={t('common.close')}
                aria-label={t('messages.dock.close')}
                onClick={() => setOpen(false)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>

          <div className="cs-msg-mini-body">
            <ConversationMessagePanel
              hideHeader
              conversation={activeConv}
              contact={activeContact}
              messages={activeMessages}
              currentUser={currentUser}
              isSuperAdmin={currentUser?.role === 'owner'}
              onSend={handleMiniSend}
              onRetry={handleMiniRetry}
              onEmailExpand={() => openFullThread(activeConv.id)}
            />
          </div>
        </div>
      )}

      {open && !activeConv && (
        <div className="cs-msg-panel" role="dialog" aria-label={t('messages.dock.messages')}>
          <div className="cs-msg-panel-head">
            <div className="messaging-inbox-toggle" role="tablist" aria-label={t('messages.inbox')}>
              {INBOX_TABS.map((tb) => (
                <button
                  key={tb.key}
                  type="button"
                  role="tab"
                  aria-selected={inbox === tb.key}
                  className={`inbox-toggle-btn ${inbox === tb.key ? 'active' : ''}`}
                  onClick={() => selectTab(tb.key)}
                >
                  <span>{t(tb.labelKey)}</span>
                  {counts[tb.key] > 0 && <span className="inbox-toggle-unread">{cap(counts[tb.key])}</span>}
                </button>
              ))}
            </div>
            <div className="cs-msg-panel-ctrls">
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title={t('messages.dock.openFullShort')}
                aria-label={t('messages.dock.openFullShort')}
                onClick={openFull}
              >
                <Icon name="expand" size={16} />
              </button>
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title={t('common.close')}
                aria-label={t('messages.dock.close')}
                onClick={() => setOpen(false)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>

          <div className="cs-msg-list">
            {rows.length === 0 ? (
              <div className="cs-msg-empty">{t('messages.dock.empty')}</div>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`cs-msg-conv ${r.unread > 0 ? 'is-unread' : ''}`}
                  onClick={() => openConversation(r.id)}
                >
                  <span className="cs-msg-conv-av">
                    <Avatar user={r.avatarUser} initials={r.initials} variant={r.avatarVariant} size="sm" />
                    {r.unread > 0 && <span className="cs-msg-conv-dot" aria-label={t('messages.unreadCount', { count: r.unread })} />}
                  </span>
                  <div className="cs-msg-conv-body">
                    <div className="cs-msg-conv-name">{r.displayName}</div>
                    <div className="cs-msg-conv-preview">{r.preview}</div>
                  </div>
                  <div className="cs-msg-conv-meta">
                    <span className="cs-msg-conv-time">{r.time}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        className="cs-msg-launcher"
        aria-label={total > 0 ? t('messages.dock.launcherAria', { count: total }) : t('messages.dock.messages')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cs-msg-launcher-icon">
          <Icon name="messagingSolid" size={33} />
          {total > 0 && <span className="cs-msg-launcher-badge">{cap(total)}</span>}
        </span>
        <span className="cs-msg-launcher-label">{t('messages.dock.messages')}</span>
      </button>
    </div>,
    document.body,
  );
}
