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
import { selectUserById, selectOtherParticipant, selectSignaturePrefs } from '../store/selectors';
import { fmtTime, fmtRelative } from '../lib/dates';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { appendSignature, signatureHasContent, buildOutboundEmail } from '../lib/signature';

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
    ? (message.toEmail || contact?.email || message.fromEmail || '')
    : (message.toInboxEmail || '');
  return { fromLabel, fromAddr, toAddr };
}

function EmailModal({ message, contact, onClose, onReply }) {
  const state = useStore();
  const toast = useToast();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const { fromLabel, fromAddr, toAddr } = emailMeta(message, contact, author);
  const isOut = message.direction === 'out';
  // Who a reply goes back to: the other party on the thread — the external
  // sender for an inbound email, the contact for one we sent.
  const replyToAddr = (isOut ? toAddr : fromAddr) || contact?.email || '';
  const sigPrefs = selectSignaturePrefs(state, state.currentUserId);
  const [replyText, setReplyText] = useState('');
  const [replyAttachments, setReplyAttachments] = useState([]);
  const [toRecipients, setToRecipients] = useState('');
  const [replyCc, setReplyCc] = useState('');
  const [replyBcc, setReplyBcc] = useState('');
  const [showReplyCc, setShowReplyCc] = useState(false);
  const [showReplyBcc, setShowReplyBcc] = useState(false);
  // null until the user picks an action — no default selection. 'reply' (back
  // to the other party) or 'forward' (on to a new recipient). The compose form
  // stays hidden until one is chosen, like a traditional email client.
  const [mode, setMode] = useState(null);
  const fileRef = useRef(null);

  // The original email, quoted, for the forward body — the user's note goes above it.
  const buildForwardQuote = () =>
    `\n\n---------- Forwarded message ----------\n`
    + `From: ${fromLabel}${fromAddr ? ` <${fromAddr}>` : ''}\n`
    + `Date: ${fmtTime(message.sentAt)} · ${fmtRelative(message.sentAt)}\n`
    + `Subject: ${message.emailSubject || '(no subject)'}\n\n`
    + `${message.text || ''}`;
  // Reply pre-fills To with the other party; forward starts blank so the user
  // names a fresh recipient. Both reveal Cc/Bcc up front (traditional email
  // modal) — the user can collapse either with its × if unused.
  const switchToReply = () => { setMode('reply'); setReplyText(''); setToRecipients(replyToAddr); setShowReplyCc(true); setShowReplyBcc(true); };
  // Reply All: everyone else who was on the original — its other To recipients
  // + Cc — minus our own inbox and the person we're already replying to. Inbound
  // emails currently store only the sender, so this is usually empty (degrades
  // to a plain Reply); outbound + future inbound-with-recipients populate it.
  const otherRecipients = () => {
    const mine = (message.toInboxEmail || '').toLowerCase();
    const sender = (replyToAddr || '').toLowerCase();
    const toList = Array.isArray(message.toEmails)
      ? message.toEmails
      : (message.toEmail ? [message.toEmail] : []);
    const ccRaw = message.ccEmails;
    const ccList = Array.isArray(ccRaw) ? ccRaw : (typeof ccRaw === 'string' ? ccRaw.split(',') : []);
    const seen = new Set();
    return [...toList, ...ccList]
      .map((e) => (e || '').trim())
      .filter((e) => {
        const k = e.toLowerCase();
        if (!e || k === mine || k === sender || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  };
  const switchToReplyAll = () => {
    setMode('replyAll');
    setReplyText('');
    setToRecipients(replyToAddr);
    setReplyCc(otherRecipients().join(', '));
    setShowReplyCc(true);
    setShowReplyBcc(true);
  };
  const switchToForward = () => { setMode('forward'); setReplyText(buildForwardQuote()); setToRecipients(''); setShowReplyCc(true); setShowReplyBcc(true); };

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
    const to = toRecipients.trim();
    if (!to) {
      toast.error(mode === 'forward' ? 'Add someone to forward to.' : 'Add a recipient in the To field.');
      return;
    }
    const baseSubject = (message.emailSubject || '').replace(/^((Re|Fwd):\s*)+/i, '');
    const opts = {
      channel: 'email',
      to,
      attachments: replyAttachments,
      cc: replyCc.trim() || undefined,
      bcc: replyBcc.trim() || undefined,
    };
    if (mode === 'forward') {
      opts.subject = baseSubject ? `Fwd: ${baseSubject}` : 'Fwd:';
    } else {
      opts.subject = baseSubject ? `Re: ${baseSubject}` : '';
    }
    const built = buildOutboundEmail(replyText.trim(), sigPrefs);
    onReply(built.displayText, { ...opts, sendBody: built.sendBody, inlineImages: built.inlineImages });
    setReplyText('');
    setReplyAttachments([]);
    setToRecipients('');
    setReplyCc('');
    setReplyBcc('');
    setShowReplyCc(false);
    setShowReplyBcc(false);
    setMode(null);
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
          <div className="email-modal-mode-toggle" role="group" aria-label="Reply or forward">
            <button
              type="button"
              className={`btn btn-sm ${mode === 'reply' ? 'btn-primary' : 'btn-outline'}`}
              onClick={switchToReply}
              aria-pressed={mode === 'reply'}
            >
              Reply
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'replyAll' ? 'btn-primary' : 'btn-outline'}`}
              onClick={switchToReplyAll}
              aria-pressed={mode === 'replyAll'}
            >
              Reply All
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'forward' ? 'btn-primary' : 'btn-outline'}`}
              onClick={switchToForward}
              aria-pressed={mode === 'forward'}
            >
              Forward
            </button>
          </div>
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

        {!mode && (
          <div className="email-modal-pick">
            Choose <strong>Reply</strong> to answer the sender, <strong>Reply All</strong> to include everyone on the thread, or <strong>Forward</strong> to send it on to someone else.
          </div>
        )}

        {mode && (
          <form className="email-modal-reply" onSubmit={handleSend}>
            {/* To — editable in both modes. Reply pre-fills the other party;
                forward starts blank. Comma-separate to reach several people. */}
            <div className="email-recip-row">
              <span className="email-recip-label">To:</span>
              <input
                type="text"
                className="form-input email-recip-input"
                placeholder="name@example.com, another@example.com"
                value={toRecipients}
                onChange={(e) => setToRecipients(e.target.value)}
                autoFocus={mode === 'forward'}
              />
              <div className="email-recip-toggles">
                {!showReplyCc && (
                  <button type="button" className="btn-link" onClick={() => setShowReplyCc(true)}>Cc</button>
                )}
                {!showReplyBcc && (
                  <button type="button" className="btn-link" onClick={() => setShowReplyBcc(true)}>Bcc</button>
                )}
              </div>
            </div>
            {showReplyCc && (
              <div className="email-recip-row">
                <span className="email-recip-label">Cc:</span>
                <input
                  type="text"
                  className="form-input email-recip-input"
                  placeholder="email1@example.com, email2@example.com"
                  value={replyCc}
                  onChange={(e) => setReplyCc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-link email-recip-hide"
                  onClick={() => { setShowReplyCc(false); setReplyCc(''); }}
                  title="Hide Cc"
                  aria-label="Hide Cc"
                >
                  ×
                </button>
              </div>
            )}
            {showReplyBcc && (
              <div className="email-recip-row">
                <span className="email-recip-label">Bcc:</span>
                <input
                  type="text"
                  className="form-input email-recip-input"
                  placeholder="email1@example.com, email2@example.com"
                  value={replyBcc}
                  onChange={(e) => setReplyBcc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-link email-recip-hide"
                  onClick={() => { setShowReplyBcc(false); setReplyBcc(''); }}
                  title="Hide Bcc"
                  aria-label="Hide Bcc"
                >
                  ×
                </button>
              </div>
            )}
            <div className="email-recip-hint">
              Sending to more than one person? Separate addresses with a comma — e.g. <code>alex@acme.com, sam@acme.com</code>.
            </div>
            <textarea
              className="email-modal-reply-input"
              placeholder={mode === 'forward' ? 'Add a note — the original is quoted below…' : 'Type your reply…'}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              autoFocus={mode === 'reply' || mode === 'replyAll'}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                // Gate: a stray Enter inserts a newline; send via the button or ⌘/Ctrl+Enter.
                if (e.metaKey || e.ctrlKey) { e.preventDefault(); handleSend(e); }
              }}
            />
            {signatureHasContent(sigPrefs) && (
              <div style={{ borderTop: '1px dashed var(--border-light)', paddingTop: 8 }}>
                <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Your signature is added when you send</div>
                {(sigPrefs.text || '').trim() && <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--text-body)' }}>{sigPrefs.text}</div>}
                {sigPrefs.imageDataUrl && <img src={sigPrefs.imageDataUrl} alt="Signature" style={{ maxHeight: 48, maxWidth: 200, marginTop: 4, display: 'block' }} />}
              </div>
            )}
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
              <button type="submit" className="btn btn-primary btn-sm" disabled={!replyText.trim() || !toRecipients.trim()}>{mode === 'forward' ? 'Forward' : 'Send'}</button>
            </div>
            <div className="compose-hint">Click {mode === 'forward' ? 'Forward' : 'Send'} or ⌘/Ctrl+Enter to send · Enter for new line</div>
          </form>
        )}
      </div>
    </div>
  );
}

// Review & Send preview for an outbound email — a read-only render of exactly
// what's about to go out (From / To / Subject / body / attachments) so a click
// can't fire a real email unreviewed. Mirrors the EmailModal styling.
function EmailReviewModal({ fromName, fromAddr, to, subject, cc, bcc, body, attachments, signature, onConfirm, onClose }) {
  const fmtSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };
  const canSend = Boolean(to) && Boolean((body || '').trim());
  return (
    <div className="email-modal-overlay" onClick={onClose}>
      <div className="email-modal" onClick={(e) => e.stopPropagation()}>
        <div className="email-modal-top">
          <Icon name="mail" size={18} />
          <span className="email-modal-title">Review &amp; send</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        <div className="email-modal-header">
          <div className="email-bubble-row"><span className="email-bubble-label">From:</span><span className="email-bubble-value">{fromName || 'You'} {fromAddr && <span className="email-bubble-addr">&lt;{fromAddr}&gt;</span>}</span></div>
          <div className="email-bubble-row"><span className="email-bubble-label">To:</span><span className="email-bubble-value">{to || <span className="text-muted">No recipient email on this thread</span>}</span></div>
          {cc && <div className="email-bubble-row"><span className="email-bubble-label">Cc:</span><span className="email-bubble-value">{cc}</span></div>}
          {bcc && <div className="email-bubble-row"><span className="email-bubble-label">Bcc:</span><span className="email-bubble-value">{bcc}</span></div>}
          <div className="email-bubble-row"><span className="email-bubble-label">Subject:</span><span className="email-bubble-value email-bubble-subject">{subject || <span className="text-muted">(no subject)</span>}</span></div>
        </div>

        {(attachments || []).length > 0 && (
          <div className="email-modal-attachments">
            {attachments.map((a, i) => (
              <div key={i} className="email-attachment-chip">
                <Icon name="paperclip" size={12} />
                <span>{a.name}</span>
                {a.size != null && <span className="text-muted text-xs">({fmtSize(a.size)})</span>}
              </div>
            ))}
          </div>
        )}

        <div className="email-modal-body">
          {body}
          {signatureHasContent(signature) && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--border-light)' }}>
              {(signature.text || '').trim() && <div style={{ whiteSpace: 'pre-wrap' }}>{signature.text}</div>}
              {signature.imageDataUrl && <img src={signature.imageDataUrl} alt="Signature" style={{ maxHeight: 64, maxWidth: 240, marginTop: 6, display: 'block' }} />}
            </div>
          )}
        </div>

        <div className="email-modal-reply">
          <div className="email-modal-reply-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Back to edit</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm} disabled={!canSend}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmailBubble({ message, contact, onReply, onRetry }) {
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
            {isOut ? 'Expand' : 'Expand / Reply'}
          </button>
        </div>
        {isOut && message.deliveryStatus === 'failed' && <FailedRow message={message} onRetry={onRetry} />}
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

// Inline "Failed to send · Retry" row shown under an outbound message whose
// delivery failed. Retry re-fires the send for that exact message.
function FailedRow({ message, onRetry }) {
  const reason = (message.failureReason || '').slice(0, 100);
  return (
    <div className="msg-failed">
      <span className="msg-failed-label">Failed to send{reason ? ` · ${reason}` : ''}</span>
      {onRetry && (
        <button type="button" className="msg-retry-btn" onClick={() => onRetry(message)}>Retry</button>
      )}
    </div>
  );
}

function ChatBubble({ message, onRetry }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const isOut = message.direction === 'out';
  return (
    <div className={`chat-bubble ${isOut ? 'outgoing' : 'incoming'}`}>
      {isOut && author && <div className="chat-bubble-author">{author.name}</div>}
      <div>{message.text}</div>
      <div className="chat-time">{fmtTime(message.sentAt)}</div>
      {isOut && message.deliveryStatus === 'failed' && <FailedRow message={message} onRetry={onRetry} />}
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
  onRetry,                       // (message) => void — re-send a failed message
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
  // Email Review & Send preview modal — gates the actual send.
  const [reviewOpen, setReviewOpen] = useState(false);

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
    setReviewOpen(false);
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

  // Per-user signature appended to outbound EMAIL bodies (text now; image once
  // HTML sending lands). SMS/internal sends never get it.
  const sigPrefs = selectSignaturePrefs(state, currentUser?.id || state.currentUserId);

  // The actual send — fires onSend with the composed payload and resets the
  // compose. For email this runs only after the Review & Send preview is
  // confirmed; SMS / internal call it straight from the Send button or Enter.
  const doSend = () => {
    const text = draft.trim();
    if (!text) return;
    const isEmail = composeChannel === 'email';
    const built = isEmail
      ? buildOutboundEmail(text, sigPrefs)
      : { displayText: text, sendBody: text, inlineImages: [] };
    onSend(built.displayText, {
      channel: composeChannel,
      snippetId,
      subject: isEmail ? subject.trim() : undefined,
      inboxId: isEmail ? selectedInboxId : undefined,
      attachments: isEmail ? composeAttachments : undefined,
      cc: isEmail && composeCc.trim() ? composeCc.trim() : undefined,
      bcc: isEmail && composeBcc.trim() ? composeBcc.trim() : undefined,
      sendBody: built.sendBody,
      inlineImages: built.inlineImages,
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

  const handleSend = (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (sendDisabled) return;
    if (!draft.trim()) return;
    // Email always opens the Review & Send preview before anything goes out.
    if (composeChannel === 'email') {
      setReviewOpen(true);
      return;
    }
    doSend();
  };

  const handleKey = (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Email is gated so a stray Enter can't fire a real email — plain Enter
    // inserts a newline; send via the button or ⌘/Ctrl+Enter. SMS/internal
    // keep Enter-to-send.
    if (composeChannel === 'email') {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); handleSend(e); }
      return;
    }
    e.preventDefault();
    handleSend(e);
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
            return <EmailBubble key={m.id} message={m} contact={contact} onReply={onSend} onRetry={onRetry} />;
          }
          return <ChatBubble key={m.id} message={m} onRetry={onRetry} />;
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
              {composeChannel === 'email' ? 'Review & Send' : 'Send'}
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
        <div className="compose-hint">
          {composeChannel === 'email'
            ? 'Review & Send opens a preview · Enter for new line'
            : 'Enter to send · Shift+Enter for new line'}
        </div>
      </form>
      {reviewOpen && composeChannel === 'email' && (
        <EmailReviewModal
          fromName={currentUser?.name}
          fromAddr={activeInbox?.email}
          to={contact?.email}
          subject={subject.trim()}
          cc={composeCc.trim()}
          bcc={composeBcc.trim()}
          body={draft}
          attachments={composeAttachments}
          signature={sigPrefs}
          onConfirm={() => { setReviewOpen(false); doSend(); }}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </section>
  );
}
