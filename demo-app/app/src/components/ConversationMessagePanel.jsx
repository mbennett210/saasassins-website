import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Avatar from './Avatar';
import ChannelBadge from './ChannelBadge';
import EmptyState from './EmptyState';
import Icon from './Icon';
import SnippetPicker from './SnippetPicker';
import { useToast } from './Toast';
import { useStore } from '../store';
import { selectUserById, selectOtherParticipant } from '../store/selectors';
import { fmtTime, fmtRelative } from '../lib/dates';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';

// Filter selected files by size cap. Returns the kept files and reports the
// rejected ones via a toast so the user knows what got dropped. Shared by
// the EmailModal reply attach handler and the inline compose attach handler.
function filterBySizeCap(files, toast) {
  const kept = [];
  const rejected = [];
  for (const f of files) {
    if (f.size > ATTACHMENT_MAX_BYTES) rejected.push(f);
    else kept.push(f);
  }
  if (rejected.length > 0) {
    const max = formatBytes(ATTACHMENT_MAX_BYTES);
    if (rejected.length === 1) {
      toast.error(`"${rejected[0].name}" is ${formatBytes(rejected[0].size)} — over the ${max} limit.`);
    } else {
      toast.error(`${rejected.length} files exceeded the ${max} per-file limit and were skipped.`);
    }
  }
  return kept;
}

function initialsFor(contact) {
  if (!contact) return 'T';
  return `${(contact.firstName || '')[0] || ''}${(contact.lastName || '')[0] || ''}`.toUpperCase() || 'C';
}

function InternalBubble({ message }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  return (
    <div className="internal-bubble">
      <div className="internal-bubble-head">
        {author && <span className="internal-bubble-author">{author.name}</span>}
        <span className="internal-bubble-time">{fmtTime(message.sentAt)} · {fmtRelative(message.sentAt)}</span>
      </div>
      <div className="internal-bubble-body">{message.text}</div>
    </div>
  );
}

function emailMeta(message, contact, author) {
  const isOut = message.direction === 'out';
  const fromLabel = isOut
    ? (author?.name || 'You')
    : (contact ? `${contact.firstName} ${contact.lastName}` : message.fromEmail || 'Unknown');
  const fromAddr = isOut
    ? (message.toInboxEmail || author?.email || '')
    : (message.fromEmail || contact?.email || '');
  const toAddr = isOut
    ? (contact?.email || message.fromEmail || '')
    : (message.toInboxEmail || '');
  return { fromLabel, fromAddr, toAddr };
}

function EmailModal({ message, contact, onClose, onReply }) {
  const state = useStore();
  const toast = useToast();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const { fromLabel, fromAddr, toAddr } = emailMeta(message, contact, author);
  const [replyText, setReplyText] = useState('');
  const [replyAttachments, setReplyAttachments] = useState([]);
  const [replyCc, setReplyCc] = useState('');
  const [replyBcc, setReplyBcc] = useState('');
  const [showReplyCc, setShowReplyCc] = useState(false);
  const [showReplyBcc, setShowReplyBcc] = useState(false);
  const fileRef = useRef(null);

  const handleAttach = (e) => {
    const files = filterBySizeCap([...(e.target.files || [])], toast);
    if (files.length > 0) {
      setReplyAttachments((prev) => [...prev, ...files.map((f) => ({ name: f.name, size: f.size, file: f }))]);
    }
    e.target.value = '';
  };

  const removeAttachment = (idx) => setReplyAttachments((prev) => prev.filter((_, i) => i !== idx));

  const handleSend = (e) => {
    e.preventDefault();
    if (!replyText.trim()) return;
    const sub = message.emailSubject
      ? (message.emailSubject.match(/^Re:/i) ? message.emailSubject : `Re: ${message.emailSubject}`)
      : '';
    onReply(replyText.trim(), {
      channel: 'email',
      subject: sub,
      attachments: replyAttachments,
      cc: replyCc.trim() || undefined,
      bcc: replyBcc.trim() || undefined,
    });
    setReplyText('');
    setReplyAttachments([]);
    setReplyCc('');
    setReplyBcc('');
    setShowReplyCc(false);
    setShowReplyBcc(false);
    onClose();
  };

  const fmtSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div className="email-modal-overlay" onClick={onClose}>
      <div className="email-modal" onClick={(e) => e.stopPropagation()}>
        <div className="email-modal-top">
          <Icon name="mail" size={18} />
          <span className="email-modal-title">{message.emailSubject || 'Email'}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="email-modal-header">
          <div className="email-bubble-row"><span className="email-bubble-label">From:</span><span className="email-bubble-value">{fromLabel} {fromAddr && <span className="email-bubble-addr">&lt;{fromAddr}&gt;</span>}</span></div>
          {toAddr && <div className="email-bubble-row"><span className="email-bubble-label">To:</span><span className="email-bubble-value">{toAddr}</span></div>}
          {message.emailSubject && <div className="email-bubble-row"><span className="email-bubble-label">Subject:</span><span className="email-bubble-value email-bubble-subject">{message.emailSubject}</span></div>}
          <div className="email-bubble-row"><span className="email-bubble-label">Date:</span><span className="email-bubble-value">{fmtTime(message.sentAt)} · {fmtRelative(message.sentAt)}</span></div>
        </div>

        {(message.attachments || []).length > 0 && (
          <div className="email-modal-attachments">
            {message.attachments.map((a, i) => (
              <div key={i} className="email-attachment-chip">
                <Icon name="paperclip" size={12} />
                <span>{a.name}</span>
                {a.size && <span className="text-muted text-xs">({fmtSize(a.size)})</span>}
              </div>
            ))}
          </div>
        )}

        <div className="email-modal-body">{message.text}</div>

        <form className="email-modal-reply" onSubmit={handleSend}>
          <div className="email-modal-reply-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="mail" size={14} /> Reply
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 12 }}>
              {!showReplyCc && (
                <button type="button" className="btn-link" onClick={() => setShowReplyCc(true)}>Cc</button>
              )}
              {!showReplyBcc && (
                <button type="button" className="btn-link" onClick={() => setShowReplyBcc(true)}>Bcc</button>
              )}
            </div>
          </div>
          {showReplyCc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="text-xs text-muted" style={{ minWidth: 40 }}>Cc:</span>
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                placeholder="email1@example.com, email2@example.com"
                value={replyCc}
                onChange={(e) => setReplyCc(e.target.value)}
              />
              <button
                type="button"
                className="btn-link"
                onClick={() => { setShowReplyCc(false); setReplyCc(''); }}
                title="Hide Cc"
                aria-label="Hide Cc"
              >
                ×
              </button>
            </div>
          )}
          {showReplyBcc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="text-xs text-muted" style={{ minWidth: 40 }}>Bcc:</span>
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                placeholder="email1@example.com, email2@example.com"
                value={replyBcc}
                onChange={(e) => setReplyBcc(e.target.value)}
              />
              <button
                type="button"
                className="btn-link"
                onClick={() => { setShowReplyBcc(false); setReplyBcc(''); }}
                title="Hide Bcc"
                aria-label="Hide Bcc"
              >
                ×
              </button>
            </div>
          )}
          <textarea
            className="email-modal-reply-input"
            placeholder="Type your reply…"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
          />
          {replyAttachments.length > 0 && (
            <div className="email-modal-reply-files">
              {replyAttachments.map((a, i) => (
                <div key={i} className="email-attachment-chip">
                  <Icon name="paperclip" size={12} />
                  <span>{a.name}</span>
                  <span className="text-muted text-xs">({fmtSize(a.size)})</span>
                  <button type="button" className="email-attachment-remove" onClick={() => removeAttachment(i)} aria-label="Remove">&times;</button>
                </div>
              ))}
            </div>
          )}
          <div className="email-modal-reply-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
              <Icon name="paperclip" size={14} /> Attach
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={handleAttach} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={!replyText.trim()}>Send</button>
          </div>
          <div className="compose-hint">Enter to send · Shift+Enter for new line</div>
        </form>
      </div>
    </div>
  );
}

function EmailBubble({ message, contact, onReply }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const isOut = message.direction === 'out';
  const { fromLabel } = emailMeta(message, contact, author);
  const [showModal, setShowModal] = useState(false);

  const preview = (message.text || '').split('\n').slice(0, 2).join(' ');
  const truncated = preview.length > 120 ? preview.slice(0, 120) + '…' : preview;
  const hasAttachments = (message.attachments || []).length > 0;

  return (
    <>
      <div className={`chat-bubble email-preview-bubble ${isOut ? 'outgoing' : 'incoming'}`}>
        {isOut && author && <div className="chat-bubble-author">{author.name}</div>}
        {!isOut && <div className="email-preview-from"><Icon name="mail" size={12} /> {fromLabel}</div>}
        {message.emailSubject && <div className="email-preview-subject">{message.emailSubject}</div>}
        <div className="email-preview-text">{truncated}</div>
        {hasAttachments && (
          <div className="email-preview-attach">
            <Icon name="paperclip" size={11} /> {message.attachments.length} attachment{message.attachments.length > 1 ? 's' : ''}
          </div>
        )}
        <div className="email-preview-footer">
          <span className="chat-time">{fmtTime(message.sentAt)}</span>
          <button type="button" className="email-expand-btn" onClick={() => setShowModal(true)}>
            <Icon name="chevronLeft" size={12} /> Expand / Reply
          </button>
        </div>
      </div>
      {showModal && (
        <EmailModal
          message={message}
          contact={contact}
          onClose={() => setShowModal(false)}
          onReply={onReply}
        />
      )}
    </>
  );
}

function ChatBubble({ message }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const isOut = message.direction === 'out';
  return (
    <div className={`chat-bubble ${isOut ? 'outgoing' : 'incoming'}`}>
      {isOut && author && <div className="chat-bubble-author">{author.name}</div>}
      <div>{message.text}</div>
      <div className="chat-time">{fmtTime(message.sentAt)}</div>
    </div>
  );
}

function DmBubble({ message, currentUserId }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const isMine = author?.id === currentUserId;
  return (
    <div className={`chat-bubble ${isMine ? 'outgoing' : 'incoming'}`}>
      {!isMine && author && <div className="chat-bubble-author">{author.name}</div>}
      <div>{message.text}</div>
      <div className="chat-time">{fmtTime(message.sentAt)}</div>
    </div>
  );
}

export default function ConversationMessagePanel({
  conversation,
  contact,
  messages,
  currentUser,
  isSuperAdmin,
  onSend,
  onDeleteForever,
  onSetStatus,
  onSnooze,
  onToggleStar,
  onToggleMute,
  onBack,
  // Phase 4a: per-user connected inboxes for the "Sending as" dropdown +
  // channel-toggle availability. The parent (Messaging.jsx) computes these
  // from selectors so the panel stays presentation-focused.
  connectedInboxes = [],
  defaultInboxId = null,
  emailBlockers = [],            // [{ key, label }] when sending email is blocked
  onSwitchChannel,               // (targetChannel) => void — toggles compose channel
  composeChannelOverride = null,
}) {
  const scrollRef = useRef(null);
  const navigate = useNavigate();
  const nav = useFromHere();
  const toast = useToast();
  const state = useStore();

  const composeChannel = composeChannelOverride || conversation?.channel || 'sms';
  const [draft, setDraft] = useState('');
  const [snippetId, setSnippetId] = useState(null);
  const [subject, setSubject] = useState('');
  const [selectedInboxId, setSelectedInboxId] = useState(defaultInboxId || null);
  const [composeAttachments, setComposeAttachments] = useState([]);
  const composeFileRef = useRef(null);
  // Cc/Bcc — hidden by default per Gmail/Outlook convention; user toggles
  // them in via small links next to Subject. Reset on conversation change
  // and on send so the next compose starts clean.
  const [composeCc, setComposeCc] = useState('');
  const [composeBcc, setComposeBcc] = useState('');
  const [showComposeCc, setShowComposeCc] = useState(false);
  const [showComposeBcc, setShowComposeBcc] = useState(false);

  // Whether SMS↔Email toggle should appear at all on this thread. Only on
  // external (sms/email) channels with a linked contact who has both modes.
  const isExternalThread = composeChannel === 'sms' || composeChannel === 'email';
  const contactHasPhone = Boolean(contact?.phone);
  const contactHasEmail = Boolean(contact?.email);
  const showChannelToggle = isExternalThread && contact && contactHasPhone && contactHasEmail;

  // Pre-fill subject with "Re: <prior subject>" when continuing an email
  // thread; first message in a thread starts with an empty subject.
  useEffect(() => {
    if (composeChannel !== 'email') return;
    const prior = [...messages].reverse().find((m) => m.emailSubject);
    if (prior?.emailSubject) {
      const base = prior.emailSubject.replace(/^(Re:\s*)+/i, '');
      setSubject(`Re: ${base}`);
    } else {
      setSubject('');
    }
  }, [conversation?.id, composeChannel, messages]);

  // Keep selected inbox synced with the default unless the user picked one.
  useEffect(() => {
    setSelectedInboxId((prev) => {
      if (prev && connectedInboxes.some((i) => i.id === prev && i.status === 'active')) return prev;
      return defaultInboxId || null;
    });
  }, [defaultInboxId, connectedInboxes]);

  const activeInbox = useMemo(
    () => connectedInboxes.find((i) => i.id === selectedInboxId) || null,
    [connectedInboxes, selectedInboxId]
  );

  // Compose textarea height — controlled in JS so the drag handle can grow it
  // *upward* from the top edge (the native textarea resize only goes down from
  // the bottom-right corner). 96px ≈ 4 lines, comfortable default for both
  // quick replies and longer notes.
  const COMPOSE_MIN_H = 56;
  const COMPOSE_MAX_H = 360;
  const [composeHeight, setComposeHeight] = useState(96);
  const composeDragRef = useRef(null);
  const [isResizingCompose, setIsResizingCompose] = useState(false);

  const onComposeResizeStart = useCallback((e) => {
    e.preventDefault();
    composeDragRef.current = { startY: e.clientY, startH: composeHeight };
    setIsResizingCompose(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    const onMove = (me) => {
      const ds = composeDragRef.current;
      if (!ds) return;
      // Drag UP (clientY decreases) → height grows. That makes the handle in
      // the top-right behave like the top edge of the box: pull it up to make
      // the textarea taller.
      const dy = ds.startY - me.clientY;
      const next = Math.max(COMPOSE_MIN_H, Math.min(COMPOSE_MAX_H, ds.startH + dy));
      setComposeHeight(next);
    };
    const onUp = () => {
      composeDragRef.current = null;
      setIsResizingCompose(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [composeHeight]);

  useEffect(() => {
    setDraft('');
    setSnippetId(null);
    setComposeAttachments([]);
    setComposeCc('');
    setComposeBcc('');
    setShowComposeCc(false);
    setShowComposeBcc(false);
  }, [conversation?.id]);

  // Whether the Send button should be disabled. Email channel is gated on
  // having an active connected inbox AND a Subject (subject only required
  // for the FIRST message in the thread; replies inherit via `emailSubject`).
  const hasPriorEmail = composeChannel === 'email' && messages.some((m) => m.emailSubject);
  const subjectRequired = composeChannel === 'email' && !hasPriorEmail;
  const emailBlocked = composeChannel === 'email' && (!activeInbox || emailBlockers.length > 0);
  const sendDisabled = !draft.trim()
    || (subjectRequired && !subject.trim())
    || emailBlocked;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, conversation?.id]);

  if (!conversation) {
    return (
      <section className="message-pane">
        <EmptyState
          icon={<Icon name="messaging" size={28} />}
          title="Select a conversation"
          message="Pick a thread from the list to start chatting."
        />
      </section>
    );
  }

  const isInternalThread = conversation.channel === 'internal';
  const isDmThread = conversation.channel === 'dm';
  const dmOther = isDmThread ? selectOtherParticipant(state, conversation, currentUser?.id) : null;
  let headerName;
  let headerSub;
  let initials;
  let avatarVariant;
  if (isDmThread) {
    headerName = dmOther ? dmOther.name : 'Unknown user';
    headerSub = 'Direct message · only the two of you can see this';
    initials = dmOther?.initials || '?';
    avatarVariant = dmOther?.avatar || 1;
  } else if (isInternalThread) {
    headerName = conversation.title || 'Team discussion';
    headerSub = 'Internal team thread';
    initials = 'T';
    avatarVariant = 3;
  } else {
    headerName = contact ? `${contact.firstName} ${contact.lastName}` : 'Unlinked';
    headerSub = contact?.email || contact?.phone || 'No contact info';
    initials = initialsFor(contact);
    avatarVariant = ((contact?.id?.length || 0) % 5) + 1;
  }

  const handleSend = (e) => {
    e.preventDefault();
    if (sendDisabled) return;
    const text = draft.trim();
    if (!text) return;
    onSend(text, {
      channel: composeChannel,
      snippetId,
      subject: composeChannel === 'email' ? subject.trim() : undefined,
      inboxId: composeChannel === 'email' ? selectedInboxId : undefined,
      attachments: composeChannel === 'email' ? composeAttachments : undefined,
      cc: composeChannel === 'email' && composeCc.trim() ? composeCc.trim() : undefined,
      bcc: composeChannel === 'email' && composeBcc.trim() ? composeBcc.trim() : undefined,
    });
    setDraft('');
    setSnippetId(null);
    setComposeAttachments([]);
    setComposeCc('');
    setComposeBcc('');
    setShowComposeCc(false);
    setShowComposeBcc(false);
    // Keep Subject populated as "Re: …" for the next reply, but clear it on
    // the FIRST send (since the next send is now a reply, not a new thread).
    if (composeChannel === 'email' && subject.trim()) {
      const base = subject.trim().replace(/^(Re:\s*)+/i, '');
      setSubject(`Re: ${base}`);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const handleInsertSnippet = ({ id, body }) => {
    setSnippetId(id);
    setDraft((prev) => (prev ? `${prev}\n${body}` : body));
  };

  const isMuted = currentUser && (conversation.mutedByUserIds || []).includes(currentUser.id);
  const isStarredByMe = Boolean(currentUser && (conversation.starredByUserIds || []).includes(currentUser.id));
  const canHardDelete = Boolean(isSuperAdmin || (currentUser && conversation.createdByUserId === currentUser.id));

  return (
    <section className="message-pane">
      <div className="message-pane-head">
        {onBack && (
          <button type="button" className="msg-back-btn" onClick={onBack} aria-label="Back to inbox">
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <Avatar initials={initials} variant={avatarVariant} size="sm" />
        <div className="message-pane-titles">
          <div className="message-pane-name">
            {isInternalThread || !contact ? (
              headerName
            ) : (
              <button type="button" className="linklike" onClick={() => navigate(`/contacts/${contact.id}`, { state: nav })}>
                {headerName}
              </button>
            )}
            {!isInternalThread && <ChannelBadge channel={conversation.channel} />}
          </div>
          <div className="message-pane-sub text-xs text-muted">{headerSub}</div>
        </div>
        <div className="message-pane-actions">
          <button
            type="button"
            className={`icon-btn ${isStarredByMe ? 'starred' : ''}`}
            onClick={onToggleStar}
            title={isStarredByMe ? 'Unstar' : 'Star'}
            aria-label={isStarredByMe ? 'Unstar' : 'Star'}
          >
            <Icon name="star" size={14} />
          </button>
          {!isDmThread && (
            <button
              type="button"
              className={`icon-btn ${isMuted ? 'is-muted' : ''}`}
              onClick={onToggleMute}
              title={isMuted ? 'Notifications silenced — click to unmute' : 'Silence notifications for this thread'}
              aria-label={isMuted ? 'Unmute notifications' : 'Mute notifications'}
              aria-pressed={isMuted ? 'true' : 'false'}
            >
              <Icon name={isMuted ? 'bellOff' : 'bell'} size={14} />
            </button>
          )}
          {canHardDelete && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={onDeleteForever}
              title="Permanently delete the thread and all messages for everyone"
            >
              <Icon name="trash" size={14} />
              Delete thread
            </button>
          )}
        </div>
      </div>

      <div className="message-pane-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <EmptyState message="No messages yet." />
        ) : messages.map((m) => {
          if (isDmThread) {
            return <DmBubble key={m.id} message={m} currentUserId={currentUser?.id} />;
          }
          // Internal team threads: every message is direction='internal' by definition.
          // External threads (sms/email) only carry direction='in'/'out' — the cross-channel
          // internal-note feature was removed in v26, so a chat bubble is always correct here.
          if (isInternalThread) {
            return <InternalBubble key={m.id} message={m} />;
          }
          if (m.emailSubject || m.fromEmail) {
            return <EmailBubble key={m.id} message={m} contact={contact} onReply={onSend} />;
          }
          return <ChatBubble key={m.id} message={m} />;
        })}
      </div>

      <form className="compose-bar" onSubmit={handleSend}>
        {/* Channel toggle + email metadata strip — external threads only,
            and only when the contact has both phone + email. Toggling
            switches to the contact's other-channel thread (auto-creates one
            if needed) so each channel keeps its own thread. */}
        {showChannelToggle && (
          <div className="compose-channel-toggle" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span className="text-xs text-muted">Send as:</span>
            <button
              type="button"
              className={`btn btn-sm ${composeChannel === 'sms' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => composeChannel !== 'sms' && onSwitchChannel?.('sms')}
              disabled={!contactHasPhone}
              title={contactHasPhone ? 'Switch to SMS' : 'Contact has no phone number'}
            >
              SMS
            </button>
            <button
              type="button"
              className={`btn btn-sm ${composeChannel === 'email' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => composeChannel !== 'email' && onSwitchChannel?.('email')}
              disabled={!contactHasEmail}
              title={contactHasEmail ? 'Switch to email' : 'Contact has no email address'}
            >
              Email
            </button>
          </div>
        )}

        {/* Email-only: Subject + Sending-as picker. */}
        {composeChannel === 'email' && (
          <div className="compose-email-meta" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {connectedInboxes.length > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="text-xs text-muted" style={{ minWidth: 80 }}>Sending as:</span>
                <select
                  className="form-input"
                  style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                  value={selectedInboxId || ''}
                  onChange={(e) => setSelectedInboxId(e.target.value)}
                >
                  {connectedInboxes
                    .filter((i) => i.status === 'active')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.email}{i.isDefault ? ' (default)' : ''} · via {i.provider === 'google' ? 'Gmail' : i.provider === 'microsoft' ? 'Microsoft' : 'SMTP'}
                      </option>
                    ))}
                </select>
              </div>
            ) : (
              <div className="card" style={{ padding: '8px 10px', background: 'var(--surface-muted, #f4f4f5)', fontSize: 13 }}>
                <strong>No connected inbox.</strong>{' '}
                <Link to="/settings/inboxes">Connect Gmail, Outlook, or SMTP</Link>{' '}
                so emails come from your real address.
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="text-xs text-muted" style={{ minWidth: 80 }}>Subject:</span>
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                placeholder={subjectRequired ? 'Subject (required for new threads)' : 'Subject'}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 6, fontSize: 12 }}>
                {!showComposeCc && (
                  <button type="button" className="btn-link" onClick={() => setShowComposeCc(true)}>Cc</button>
                )}
                {!showComposeBcc && (
                  <button type="button" className="btn-link" onClick={() => setShowComposeBcc(true)}>Bcc</button>
                )}
              </div>
            </div>
            {showComposeCc && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="text-xs text-muted" style={{ minWidth: 80 }}>Cc:</span>
                <input
                  type="text"
                  className="form-input"
                  style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                  placeholder="email1@example.com, email2@example.com"
                  value={composeCc}
                  onChange={(e) => setComposeCc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => { setShowComposeCc(false); setComposeCc(''); }}
                  title="Hide Cc"
                  aria-label="Hide Cc"
                >
                  ×
                </button>
              </div>
            )}
            {showComposeBcc && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="text-xs text-muted" style={{ minWidth: 80 }}>Bcc:</span>
                <input
                  type="text"
                  className="form-input"
                  style={{ flex: 1, padding: '4px 8px', fontSize: 13 }}
                  placeholder="email1@example.com, email2@example.com"
                  value={composeBcc}
                  onChange={(e) => setComposeBcc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => { setShowComposeBcc(false); setComposeBcc(''); }}
                  title="Hide Bcc"
                  aria-label="Hide Bcc"
                >
                  ×
                </button>
              </div>
            )}
            {emailBlockers.length > 0 && (
              <div className="form-error" style={{ fontSize: 12, marginTop: 2 }}>
                {emailBlockers.map((b) => b.label).join(' · ')}
              </div>
            )}
          </div>
        )}

        <div className="compose-row">
          <div
            className={`compose-input-wrap ${isResizingCompose ? 'is-resizing' : ''}`}
            style={{ height: `${composeHeight}px` }}
          >
            <textarea
              className="compose-input"
              placeholder={
                isDmThread
                  ? `Message ${dmOther ? dmOther.name.split(' ')[0] : 'teammate'}…`
                  : composeChannel === 'internal'
                  ? 'Internal note — only your team can see this.'
                  : `Type a ${composeChannel === 'email' ? 'message' : 'text'}…`
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
            />
            <button
              type="button"
              className="compose-input-resize"
              onPointerDown={onComposeResizeStart}
              title="Drag up to expand"
              aria-label="Resize compose box"
            >
              <Icon name="resizeGrip" size={12} />
            </button>
          </div>
          <div className="compose-row-actions">
            {composeChannel === 'email' && (
              <>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => composeFileRef.current?.click()}>
                  <Icon name="paperclip" size={14} /> Attach
                </button>
                <input ref={composeFileRef} type="file" multiple hidden onChange={(e) => {
                  const files = filterBySizeCap([...(e.target.files || [])], toast);
                  if (files.length > 0) {
                    setComposeAttachments((prev) => [...prev, ...files.map((f) => ({ name: f.name, size: f.size, file: f }))]);
                  }
                  e.target.value = '';
                }} />
              </>
            )}
            {!isDmThread && (
              <SnippetPicker channel={composeChannel} onInsert={handleInsertSnippet} />
            )}
            <button type="submit" className="btn btn-primary btn-sm" disabled={sendDisabled}>
              Send
            </button>
          </div>
          {composeChannel === 'email' && composeAttachments.length > 0 && (
            <div className="compose-attachments">
              {composeAttachments.map((a, i) => (
                <div key={i} className="email-attachment-chip">
                  <Icon name="paperclip" size={12} />
                  <span>{a.name}</span>
                  <span className="text-muted text-xs">({a.size < 1048576 ? `${(a.size / 1024).toFixed(1)} KB` : `${(a.size / 1048576).toFixed(1)} MB`})</span>
                  <button type="button" className="email-attachment-remove" onClick={() => setComposeAttachments((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove">&times;</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="compose-hint">Enter to send · Shift+Enter for new line</div>
      </form>
    </section>
  );
}
