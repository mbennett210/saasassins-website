import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useIsMobile } from '../hooks/useIsMobile';
import Avatar from './Avatar';
import ChannelBadge from './ChannelBadge';
import Badge from './Badge';
import EmptyState from './EmptyState';
import Icon from './Icon';
import SignaturePreview from './SignaturePreview';
import ThreadTitleEditor from './ThreadTitleEditor';
import { useToast } from './Toast';
import { useStore } from '../store';
import {
  selectUserById, selectOtherParticipant, selectSignaturePrefs,
  selectThreadCreator, selectCanRenameThread,
} from '../store/selectors';
import { CREATOR_STATE_SUFFIX } from '../lib/threads';
import { fmtTime, fmtRelative, fmtDate, dayKey, addDaysKey } from '../lib/dates';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { signatureHasContent, buildOutboundEmail } from '../lib/signature';

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
      toast.error(`"${rejected[0].name}" is ${formatBytes(rejected[0].size)}. Over the ${max} limit.`);
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

// Byline for a message, surviving the author's removal from the team. DELETE_USER
// nulls authorUserId but demotes the name onto the message (authorName), so history
// keeps its attribution instead of rendering as anonymous text.
function authorNameOf(message, author) {
  return author?.name || message?.authorName || null;
}

// Initials from a free-text display name (for DM/author avatars in the thread).
function initialsFromName(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// "Today" / "Yesterday" / "Mon, Sep 8" label for a thread day separator, on the
// org calendar (dayKey) so it splits on the same midnight fmtTime renders against.
function dayLabel(iso) {
  const k = dayKey(iso);
  const today = dayKey(Date.now());
  if (k === today) return 'Today';
  if (k === addDaysKey(today, -1)) return 'Yesterday';
  return fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' });
}

function InternalBubble({ message, currentUserId }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const authorName = authorNameOf(message, author);
  const isMine = author?.id === currentUserId;
  // Internal team channels read as a group chat (S39): my notes outgoing (right),
  // teammates' incoming (left) with an avatar + name. "Internal" is signalled by
  // the header + the composer's "Only your team can see this" note.
  return (
    <div className={`chat-row ${isMine ? 'out' : 'in'}`}>
      {!isMine && <div className="chat-av" aria-hidden="true">{initialsFromName(authorName)}</div>}
      <div className="chat-col">
        <div className={`chat-bubble ${isMine ? 'outgoing' : 'incoming'}`}>
          {!isMine && authorName && <div className="chat-bubble-author">{authorName}</div>}
          <div>{message.text}</div>
        </div>
        <div className="chat-time">{fmtTime(message.sentAt)} · {fmtRelative(message.sentAt)}</div>
      </div>
    </div>
  );
}

function emailMeta(message, contact, author) {
  const isOut = message.direction === 'out';
  const fromLabel = isOut
    ? (authorNameOf(message, author) || 'You')
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
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
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
            {/* Do-Not-Contact warning — WARN, not block (UI_RULES §47): Send
                stays enabled so a human can still answer a customer who wrote
                in first. */}
            {contact?.doNotContact && (
              <div className="callout callout-danger" style={{ marginBottom: 8 }}>
                This contact is marked <strong>Do Not Contact</strong>. Only reply if they contacted you first.
              </div>
            )}
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
                  <button type="button" className="linklike" onClick={() => setShowReplyCc(true)}>Cc</button>
                )}
                {!showReplyBcc && (
                  <button type="button" className="linklike" onClick={() => setShowReplyBcc(true)}>Bcc</button>
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
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowReplyCc(false); setReplyCc(''); }}
                  title="Hide Cc"
                  aria-label="Hide Cc"
                >
                  <Icon name="x" size={14} />
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
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowReplyBcc(false); setReplyBcc(''); }}
                  title="Hide Bcc"
                  aria-label="Hide Bcc"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            <div className="email-recip-hint">
              Sending to more than one person? Separate addresses with a comma. E.g. <code>alex@acme.com, sam@acme.com</code>.
            </div>
            <textarea
              className="email-modal-reply-input"
              placeholder={mode === 'forward' ? 'Add a note. The original is quoted below…' : 'Type your reply…'}
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
                <SignaturePreview prefs={sigPrefs} />
              </div>
            )}
            {replyAttachments.length > 0 && (
              <div className="email-modal-reply-files">
                {replyAttachments.map((a, i) => (
                  <div key={i} className="email-attachment-chip">
                    <Icon name="paperclip" size={12} />
                    <span>{a.name}</span>
                    <span className="text-muted text-xs">({fmtSize(a.size)})</span>
                    <button type="button" className="chip-remove" onClick={() => removeAttachment(i)} aria-label="Remove">&times;</button>
                  </div>
                ))}
              </div>
            )}
            <div className="email-modal-reply-actions">
              <button type="button" className="btn btn-outline" onClick={() => fileRef.current?.click()}>
                <Icon name="paperclip" size={14} /> Attach
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={handleAttach} />
              <button type="submit" className="btn btn-primary" disabled={!replyText.trim() || !toRecipients.trim()}>{mode === 'forward' ? 'Forward' : 'Send'}</button>
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
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
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
              <SignaturePreview prefs={signature} />
            </div>
          )}
        </div>

        <div className="email-modal-reply">
          <div className="email-modal-reply-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Back to edit</button>
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={!canSend}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmailBubble({ message, contact, onReply, onRetry, onExpand }) {
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
          <button type="button" className="btn btn-sm btn-gold" onClick={() => (onExpand ? onExpand() : setShowModal(true))}>
            {isOut ? 'Open' : 'Read & Reply'}
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

// Derive a short, scannable code from a free-text failure reason — a
// provider/HTTP-style number if one is present (e.g. Twilio 30003), else a
// category slug — so the compact row shows something clickable without dumping
// the full text. Returns null when nothing meaningful can be summarized.
function deriveErrorCode(reason) {
  const r = String(reason || '');
  const num = r.match(/\b(\d{3,6})\b/); // Twilio (30003, 21211…) / HTTP status
  if (num) return `Error ${num[1]}`;
  if (/no (email|phone)/i.test(r)) return 'No recipient';
  if (/not connected|not provisioned|a2p|no twilio number/i.test(r)) return 'Not configured';
  if (/bounce|mailbox|undeliverable|recipient/i.test(r)) return 'Bounced';
  if (/unauthor|invalid_grant|revoked|token|reconnect|\b40[13]\b/i.test(r)) return 'Auth expired';
  return null;
}

// Inline "Failed to deliver" row under an outbound message whose delivery failed
// — for both SMS and email (rendered from ChatBubble + the email preview).
// Compact by default: shows the status + a derived error code; clicking it
// expands the full reason + provider reference so staff can see exactly why.
// Retry re-fires the send for that exact message.
function FailedRow({ message, onRetry }) {
  const [open, setOpen] = useState(false);
  const reason = message.failureReason || '';
  const code = deriveErrorCode(reason);
  const ref = message.twilioMessageSid || message.emailMessageId || null;
  const channel = (message.emailMessageId || message.emailSubject) ? 'Email' : 'SMS';
  const hasDetail = Boolean(reason || ref);
  return (
    <div className="msg-failed">
      <button
        type="button"
        className={`linklike linklike-danger msg-failed-toggle ${open ? 'open' : ''}`}
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
      >
        <Icon name="warning" size={11} />
        <span className="msg-failed-label">Failed to deliver</span>
        {code && <span className="msg-failed-code">{code}</span>}
        {hasDetail && (
          <span className={`msg-failed-chevron ${open ? 'open' : ''}`}><Icon name="chevronDown" size={11} /></span>
        )}
      </button>
      {onRetry && (
        <button type="button" className="btn btn-sm btn-outline" onClick={() => onRetry(message)}>Retry</button>
      )}
      {open && hasDetail && (
        <div className="msg-failed-detail">
          <div><span className="msg-failed-k">Channel</span>{channel}</div>
          {reason && <div><span className="msg-failed-k">Why</span>{reason}</div>}
          {ref && <div><span className="msg-failed-k">Reference</span><code>{ref}</code></div>}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ message, contact, onRetry }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const authorName = authorNameOf(message, author);
  const isOut = message.direction === 'out';
  // Honest delivery state only — the model tracks a status (…/delivered/failed),
  // never a per-message "read" receipt, so we surface the real one or nothing.
  const ds = message.deliveryStatus;
  const status = isOut && ds && ds !== 'failed' ? ds.charAt(0).toUpperCase() + ds.slice(1) : null;
  return (
    <div className={`chat-row ${isOut ? 'out' : 'in'}`}>
      {!isOut && <div className="chat-av" aria-hidden="true">{initialsFor(contact)}</div>}
      <div className="chat-col">
        <div className={`chat-bubble ${isOut ? 'outgoing' : 'incoming'}`}>
          {isOut && authorName && <div className="chat-bubble-author">{authorName}</div>}
          <div>{message.text}</div>
        </div>
        <div className="chat-time">
          {fmtTime(message.sentAt)}{status && <span className="chat-status">· {status}</span>}
        </div>
        {isOut && ds === 'failed' && <FailedRow message={message} onRetry={onRetry} />}
      </div>
    </div>
  );
}

function DmBubble({ message, currentUserId }) {
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const authorName = authorNameOf(message, author);
  const isMine = author?.id === currentUserId;
  return (
    <div className={`chat-row ${isMine ? 'out' : 'in'}`}>
      {!isMine && <div className="chat-av" aria-hidden="true">{initialsFromName(authorName)}</div>}
      <div className="chat-col">
        <div className={`chat-bubble ${isMine ? 'outgoing' : 'incoming'}`}>
          {!isMine && authorName && <div className="chat-bubble-author">{authorName}</div>}
          <div>{message.text}</div>
        </div>
        <div className="chat-time">{fmtTime(message.sentAt)}</div>
      </div>
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
  onRename,                      // (title) => void — internal threads only; omit to disable renaming
  onToggleStar,
  onToggleMute,
  onBack,
  // Phase 4a: per-user connected inboxes for the "Sending as" dropdown +
  // channel-toggle availability. The parent (Messaging.jsx) computes these
  // from selectors so the panel stays presentation-focused.
  connectedInboxes = [],
  defaultInboxId = null,
  emailBlockers = [],            // [{ key, label }] when sending email is blocked
  composeChannelOverride = null,
  onRetry,                       // (message) => void — re-send a failed message
  initialDraft = null,           // seed the composer once (e.g. a payment reminder)
  hideHeader = false,            // MessagesDock mini-view supplies its own chrome; drop the pane's header row
  onEmailExpand = null,          // dock: route an email message's Open/Read & Reply to the full page (no in-dock email compose)
}) {
  const scrollRef = useRef(null);
  const nav = useFromHere();
  const toast = useToast();
  const state = useStore();
  const isMobile = useIsMobile();

  const composeChannel = composeChannelOverride || conversation?.channel || 'sms';
  const [draft, setDraft] = useState('');
  const [snippetId, setSnippetId] = useState(null); // no in-composer picker (S39); reset-only, kept null in the send payload
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

  // Email compose placement (Daniel, S39): DESKTOP restores the full inline email
  // composer (subject / Sending-as / body / Review & Send — all still wired below);
  // MOBILE keeps the read-only note for now (reply there via the expand-to-read card;
  // composing a NEW email on mobile is a separate surface, TBD). Gate on the same
  // 640px seam the mobile messaging layout uses.
  const isEmailThread = composeChannel === 'email';
  const emailReadOnly = isEmailThread && isMobile;

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

  // Compose is a fixed-height uniform pill now (S39) — the drag-to-grow handle
  // was removed; long text scrolls within the pill.

  // Reset the composer on a real conversation change, seeding it from a
  // deep-link draft (e.g. a payment reminder) when present, else clearing it.
  // Guarded by the last-processed conversation id so React StrictMode's dev
  // double-invoke short-circuits the replay pass — the old reset+seed effect
  // pair raced and the replay cleared a just-seeded draft. `initialDraft` can
  // stay in deps because the guard blocks a same-conversation re-run from
  // clobbering the user's edits. See UI_RULES §45.
  const lastConvRef = useRef(null);
  useEffect(() => {
    if (lastConvRef.current === conversation?.id) return;
    lastConvRef.current = conversation?.id;
    setSnippetId(null);
    setComposeAttachments([]);
    setComposeCc('');
    setComposeBcc('');
    setShowComposeCc(false);
    setShowComposeBcc(false);
    setReviewOpen(false);
    setDraft(initialDraft || '');
  }, [conversation?.id, initialDraft]);

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
  const threadCreator = selectThreadCreator(state, conversation);
  // Thread names belong to their creator. The one exception — a Super Admin
  // renaming an ORPHANED thread, whose owner is gone and whose name would
  // otherwise be frozen forever — lives inside the selector, not here.
  const canRenameThread = onRename ? selectCanRenameThread(state, conversation, currentUser) : false;
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
    // Threads outlive their creators, so say who made this one — including when
    // they're gone. Without it a departed creator reads as no creator at all,
    // and there's no way to tell an orphan from a live thread.
    headerSub = threadCreator.name
      ? `Internal team channel · Created by ${threadCreator.name}${CREATOR_STATE_SUFFIX[threadCreator.state] || ''}`
      : 'Internal team channel';
    initials = 'T';
    avatarVariant = 3;
  } else {
    headerName = contact ? `${contact.firstName} ${contact.lastName}` : 'Unlinked';
    headerSub = contact?.email || contact?.phone || 'No contact info';
    initials = initialsFor(contact);
    avatarVariant = ((contact?.id?.length || 0) % 5) + 1;
  }

  // Per-user signature appended to outbound EMAIL bodies — text inline, plus the
  // image rendered inline via Content-ID (buildOutboundEmail). SMS/internal
  // sends never get it.
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


  const isMuted = currentUser && (conversation.mutedByUserIds || []).includes(currentUser.id);
  const isStarredByMe = Boolean(currentUser && (conversation.starredByUserIds || []).includes(currentUser.id));
  const canHardDelete = Boolean(isSuperAdmin || (currentUser && conversation.createdByUserId === currentUser.id));

  // Build the timeline with day separators (Today / Yesterday / date) between
  // day changes. Bubble type is still chosen per channel/shape exactly as before.
  let _lastDayKey = null;
  const messageEls = messages.map((m) => {
    const dk = dayKey(m.sentAt);
    const sep = dk !== _lastDayKey
      ? <div className="chat-daysep" key={`sep-${m.id}`}><span>{dayLabel(m.sentAt)}</span></div>
      : null;
    _lastDayKey = dk;
    let bubble;
    if (isDmThread) {
      bubble = <DmBubble key={m.id} message={m} currentUserId={currentUser?.id} />;
    } else if (isInternalThread) {
      bubble = <InternalBubble key={m.id} message={m} currentUserId={currentUser?.id} />;
    } else if (m.emailSubject || m.fromEmail) {
      bubble = <EmailBubble key={m.id} message={m} contact={contact} onReply={onSend} onRetry={onRetry} onExpand={onEmailExpand} />;
    } else {
      bubble = <ChatBubble key={m.id} message={m} contact={contact} onRetry={onRetry} />;
    }
    return sep ? <Fragment key={`grp-${m.id}`}>{sep}{bubble}</Fragment> : bubble;
  });

  return (
    <section className="message-pane">
      {!hideHeader && (
      <div className="message-pane-head">
        {onBack && (
          <button type="button" className="btn-icon btn-icon-ghost msg-back-btn" onClick={onBack} aria-label="Back to inbox">
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <Avatar initials={initials} variant={avatarVariant} size="sm" />
        <div className="message-pane-titles">
          <div className="message-pane-name">
            {isInternalThread ? (
              <ThreadTitleEditor
                title={conversation.title}
                canEdit={canRenameThread}
                onRename={onRename}
              />
            ) : (
              headerName
            )}
            {!isInternalThread && <ChannelBadge channel={conversation.channel} />}
            {!isInternalThread && contact?.doNotContact && <Badge variant="red">DNC</Badge>}
          </div>
          <div className="message-pane-sub text-xs text-muted">{headerSub}</div>
        </div>
        <div className="message-pane-actions">
          {/* onToggleStar/onToggleMute are omitted for a crew (non-office) viewer — the crew
              write merge drops star/mute, so the toggle would be dead (CS-002). */}
          {onToggleStar && (
            <button
              type="button"
              className={`btn-icon ${isStarredByMe ? 'starred' : ''}`}
              onClick={onToggleStar}
              title={isStarredByMe ? 'Unstar' : 'Star'}
              aria-label={isStarredByMe ? 'Unstar' : 'Star'}
            >
              <Icon name="star" size={14} />
            </button>
          )}
          {/* Snooze = mute notifications for this thread (shown as a slashed bell).
              Works for every thread type — the engine honors mutedByUserIds before
              the channel branches (lib/notifications resolveMessageEvent), so DMs
              must be snooze-able too (a chatty teammate shouldn't force the global
              newDM toggle off). */}
          {onToggleMute && (
            <button
              type="button"
              className={`btn-icon ${isMuted ? 'is-muted' : ''}`}
              onClick={onToggleMute}
              title={isMuted ? 'Snoozed. Click to un-snooze notifications' : 'Snooze notifications for this thread'}
              aria-label={isMuted ? 'Un-snooze notifications' : 'Snooze notifications'}
              aria-pressed={isMuted ? 'true' : 'false'}
            >
              <Icon name={isMuted ? 'bellOff' : 'bell'} size={14} />
            </button>
          )}
          {canHardDelete && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={onDeleteForever}
              title="Permanently delete the thread and all messages for everyone"
            >
              <Icon name="trash" size={14} />
              Delete thread
            </button>
          )}
        </div>
      </div>
      )}

      <div className="message-pane-scroll" ref={scrollRef}>
        {messages.length === 0 ? <EmptyState message="No messages yet." /> : messageEls}
      </div>

      {emailReadOnly ? (
        <div className="compose-readonly">
          <Icon name="mail" size={16} />
          <span>Email is read-only here for now — open a full email to reply.</span>
        </div>
      ) : (
      <form className="compose-bar" onSubmit={handleSend}>
        {/* Composer is SMS/DM/internal only for now — email is read-only inline
            (reply to an email via its Open & Reply expand). The email-meta strip
            below stays dormant (email threads render the read-only note instead). */}

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
              <div className="card" style={{ padding: '8px 10px', background: 'var(--inset-bg)', fontSize: 13 }}>
                <strong>No connected inbox.</strong>{' '}
                <Link to="/settings/inboxes" state={nav}>Connect Gmail, Outlook, or SMTP</Link>{' '}
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
              <div className="email-recip-toggles">
                {!showComposeCc && (
                  <button type="button" className="linklike" onClick={() => setShowComposeCc(true)}>Cc</button>
                )}
                {!showComposeBcc && (
                  <button type="button" className="linklike" onClick={() => setShowComposeBcc(true)}>Bcc</button>
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
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowComposeCc(false); setComposeCc(''); }}
                  title="Hide Cc"
                  aria-label="Hide Cc"
                >
                  <Icon name="x" size={14} />
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
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowComposeBcc(false); setComposeBcc(''); }}
                  title="Hide Bcc"
                  aria-label="Hide Bcc"
                >
                  <Icon name="x" size={14} />
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
          <div className="compose-input-wrap">
            <textarea
              className="compose-input"
              placeholder={
                isDmThread
                  ? `Message ${dmOther ? dmOther.name.split(' ')[0] : 'teammate'}…`
                  : composeChannel === 'internal'
                  ? 'Internal note. Only your team can see this.'
                  : `Type a ${composeChannel === 'email' ? 'message' : 'text'}…`
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
            />
          </div>
          <div className="compose-row-actions">
            {composeChannel === 'email' && (
              <>
                <button type="button" className="btn btn-outline" onClick={() => composeFileRef.current?.click()}>
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
            <button type="submit" className="btn btn-sm btn-gold compose-send" disabled={sendDisabled}>
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
                  <button type="button" className="chip-remove" onClick={() => setComposeAttachments((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove">&times;</button>
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
      )}
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
