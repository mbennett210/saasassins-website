import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
import {
  selectContactById,
  selectConversationById,
  selectMessagesForConversation,
  selectUnreadForConversation,
  selectOtherParticipant,
  selectConversationsForInbox,
  selectUnreadCountForInbox,
} from '../store/selectors';
import { fmtRelative } from '../lib/dates';

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
  { key: 'inbox', label: 'Messages' },
  { key: 'internal', label: 'Channels' },
  { key: 'dm', label: 'DM' },
];

function initialsFromContact(contact) {
  if (!contact) return 'T';
  const first = (contact.firstName || '')[0] || '';
  const last = (contact.lastName || '')[0] || '';
  return `${first}${last}`.toUpperCase() || 'C';
}

// Build one conversation's row view-model. Mirrors ConversationThreadList.ThreadRow
// so the dock's display (name / preview / time / unread) can't drift from the page.
function deriveRow(state, conversation, currentUserId) {
  const isDm = conversation.channel === 'dm';
  const isInternal = conversation.channel === 'internal';
  const msgs = selectMessagesForConversation(state, conversation.id);
  const last = msgs[msgs.length - 1];
  const unread = selectUnreadForConversation(state, conversation.id);

  let displayName;
  let initials;
  let avatarVariant;
  if (isDm) {
    const other = selectOtherParticipant(state, conversation, currentUserId);
    displayName = other ? other.name : 'Unknown user';
    initials = other?.initials || '?';
    avatarVariant = other?.avatar || 1;
  } else if (isInternal) {
    displayName = conversation.title || 'Team discussion';
    initials = 'T';
    avatarVariant = 3;
  } else {
    const contact = conversation.contactId ? selectContactById(state, conversation.contactId) : null;
    displayName = contact ? `${contact.firstName} ${contact.lastName}` : 'Unlinked';
    initials = initialsFromContact(contact);
    avatarVariant = ((contact?.id?.length || 0) % 5) + 1;
  }

  return {
    id: conversation.id,
    displayName,
    initials,
    avatarVariant,
    preview: last && last.text ? last.text : 'No messages yet',
    time: last ? fmtRelative(last.sentAt) : fmtRelative(conversation.createdAt),
    unread,
  };
}

// A short one-liner under the mini-view name — enough context to know which
// thread you're in without the full page's header.
function subtitleFor(conversation, contact) {
  if (conversation.channel === 'dm') return 'Direct message';
  if (conversation.channel === 'internal') return 'Team channel';
  return contact?.email || contact?.phone || (conversation.channel === 'email' ? 'Email' : 'Text');
}

const cap = (n) => (n > 99 ? '99+' : String(n));

export default function MessagesDock() {
  const isMobile = useIsMobile();
  const canUseMessaging = usePermission('messaging.use');
  const state = useStore();
  const dispatch = useDispatch();
  const { currentUser } = useAuth();
  const navigate = useNavigate();
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

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setActiveConvId((cur) => {
        if (cur) return null;      // first Escape: mini view → list
        setOpen(false);            // already at the list: close the dock
        return cur;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Reopening the dock always starts at the conversation list, never mid-thread.
  useEffect(() => { if (!open) setActiveConvId(null); }, [open]);

  // Per-bucket unread (drives the segment pills + the launcher total). Plain
  // selector calls — computed before the early returns so hook order is stable.
  const counts = {
    inbox: selectUnreadCountForInbox(state, 'inbox', currentUser),
    internal: selectUnreadCountForInbox(state, 'internal', currentUser),
    dm: selectUnreadCountForInbox(state, 'dm', currentUser),
  };
  const total = counts.inbox + counts.internal + counts.dm;

  if (isMobile) return null;        // DESKTOP ONLY
  if (!canUseMessaging) return null;

  const rows = selectConversationsForInbox(state, inbox, currentUser)
    .slice(0, 30)
    .map((c) => deriveRow(state, c, currentUser?.id));

  // Mini-view thread. Only resolved when a row is open. The dock's inline composer
  // is SMS / channels / DMs only — email threads never open here (openConversation
  // routes them out), so no connected-inbox / email-blocker plumbing is needed.
  const activeConv = activeConvId ? selectConversationById(state, activeConvId) : null;
  const activeContact = activeConv?.contactId ? selectContactById(state, activeConv.contactId) : null;
  const activeMessages = activeConv ? selectMessagesForConversation(state, activeConv.id) : [];
  const activeRow = activeConv ? deriveRow(state, activeConv, currentUser?.id) : null;

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

  return (
    <div ref={rootRef} className={`cs-msg-dock ${open ? 'is-open' : ''}`}>
      {open && activeConv && (
        <div className="cs-msg-panel" role="dialog" aria-label={`Conversation with ${activeRow.displayName}`}>
          <div className="cs-msg-panel-head cs-msg-mini-head">
            <button
              type="button"
              className="btn-icon btn-icon-ghost"
              title="Back to messages"
              aria-label="Back to messages"
              onClick={() => setActiveConvId(null)}
            >
              <Icon name="chevronLeft" size={18} />
            </button>
            <Avatar initials={activeRow.initials} variant={activeRow.avatarVariant} size="sm" />
            <div className="cs-msg-mini-title">
              <div className="cs-msg-mini-name">{activeRow.displayName}</div>
              <div className="cs-msg-mini-sub">{subtitleFor(activeConv, activeContact)}</div>
            </div>
            <div className="cs-msg-panel-ctrls">
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title="Open in full Messaging"
                aria-label="Open in full Messaging"
                onClick={() => openFullThread(activeConv.id)}
              >
                <Icon name="expand" size={16} />
              </button>
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title="Close"
                aria-label="Close messages"
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
        <div className="cs-msg-panel" role="dialog" aria-label="Messages">
          <div className="cs-msg-panel-head">
            <div className="messaging-inbox-toggle" role="tablist" aria-label="Inbox">
              {INBOX_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={inbox === t.key}
                  className={`inbox-toggle-btn ${inbox === t.key ? 'active' : ''}`}
                  onClick={() => selectTab(t.key)}
                >
                  <span>{t.label}</span>
                  {counts[t.key] > 0 && <span className="inbox-toggle-unread">{cap(counts[t.key])}</span>}
                </button>
              ))}
            </div>
            <div className="cs-msg-panel-ctrls">
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title="Open full Messaging"
                aria-label="Open full Messaging"
                onClick={openFull}
              >
                <Icon name="expand" size={16} />
              </button>
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                title="Close"
                aria-label="Close messages"
                onClick={() => setOpen(false)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>

          <div className="cs-msg-list">
            {rows.length === 0 ? (
              <div className="cs-msg-empty">No conversations here yet.</div>
            ) : (
              rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`cs-msg-conv ${r.unread > 0 ? 'is-unread' : ''}`}
                  onClick={() => openConversation(r.id)}
                >
                  <span className="cs-msg-conv-av">
                    <Avatar initials={r.initials} variant={r.avatarVariant} size="sm" />
                    {r.unread > 0 && <span className="cs-msg-conv-dot" aria-label={`${r.unread} unread`} />}
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
        aria-label={total > 0 ? `Messages, ${total} unread` : 'Messages'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cs-msg-launcher-icon">
          <Icon name="messagingSolid" size={33} />
          {total > 0 && <span className="cs-msg-launcher-badge">{cap(total)}</span>}
        </span>
        <span className="cs-msg-launcher-label">Messages</span>
      </button>
    </div>
  );
}
