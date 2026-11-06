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
import { fmtTime, fmtDate, dayKey, addDaysKey } from '../lib/dates';
import { useT } from '../i18n/react';
import { timeShort } from '../i18n/relative';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import { signatureHasContent, buildOutboundEmail } from '../lib/signature';

// Filter selected files by size cap. Returns the kept files and reports the
// rejected ones via a toast so the user knows what got dropped. Shared by
// the EmailModal reply attach handler and the inline compose attach handler.
function filterBySizeCap(files, toast, t) {
  const kept = [];
  const rejected = [];
  for (const f of files) {
    if (f.size > ATTACHMENT_MAX_BYTES) rejected.push(f);
    else kept.push(f);
  }
  if (rejected.length > 0) {
    const max = formatBytes(ATTACHMENT_MAX_BYTES);
    if (rejected.length === 1) {
      toast.error(t('messages.email.fileTooBig', { name: rejected[0].name, size: formatBytes(rejected[0].size), max }));
    } else {
      toast.error(t('messages.email.filesTooBig', { count: rejected.length, max }));
    }
  }
  return kept;
}

// The mailbox providers, by their own names (not translated).
const PROVIDER_NAMES = { google: 'Gmail', microsoft: 'Microsoft', smtp: 'SMTP' };

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
function dayLabel(iso, t) {
  const k = dayKey(iso);
  const today = dayKey(Date.now());
  if (k === today) return t('messages.today');
  if (k === addDaysKey(today, -1)) return t('messages.yesterday');
  return fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' });
}

function InternalBubble({ message, currentUserId }) {
  const t = useT();
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
        <div className="chat-time">{fmtTime(message.sentAt)} · {timeShort(t, message.sentAt)}</div>
      </div>
    </div>
  );
}

function emailMeta(message, contact, author, t) {
  const isOut = message.direction === 'out';
  const fromLabel = isOut
    ? (authorNameOf(message, author) || t('messages.email.you'))
    : (contact ? `${contact.firstName} ${contact.lastName}` : message.fromEmail || t('messages.email.unknownSender'));
  const fromAddr = isOut
    ? (message.toInboxEmail || author?.email || '')
    : (message.fromEmail || contact?.email || '');
  const toAddr = isOut
    ? (message.toEmail || contact?.email || message.fromEmail || '')
    : (message.toInboxEmail || '');
  return { fromLabel, fromAddr, toAddr };
}

function EmailModal({ message, contact, onClose, onReply }) {
  const t = useT();
  const state = useStore();
  const toast = useToast();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const { fromLabel, fromAddr, toAddr } = emailMeta(message, contact, author, t);
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
    + `Date: ${fmtDate(message.sentAt, { month: 'short', day: 'numeric', year: 'numeric' }, undefined, 'en-US')} ${fmtTime(message.sentAt, undefined, 'en-US')}\n`
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
    const files = filterBySizeCap([...(e.target.files || [])], toast, t);
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
      toast.error(mode === 'forward' ? t('messages.email.needForwardTo') : t('messages.email.needTo'));
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

  const fmtSize = formatBytes;

  return (
    <div className="email-modal-overlay" onClick={onClose}>
      <div className="email-modal" onClick={(e) => e.stopPropagation()}>
        <div className="email-modal-top">
          <Icon name="mail" size={18} />
          <span className="email-modal-title">{message.emailSubject || t('messages.email.untitled')}</span>
          <div className="email-modal-mode-toggle" role="group" aria-label={t('messages.email.replyOrForward')}>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'reply' ? 'btn-primary' : 'btn-outline'}`}
              onClick={switchToReply}
              aria-pressed={mode === 'reply'}
            >
              {t('messages.email.reply')}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'replyAll' ? 'btn-primary' : 'btn-outline'}`}
              onClick={switchToReplyAll}
              aria-pressed={mode === 'replyAll'}
            >
              {t('messages.email.replyAll')}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === 'forward' ? 'btn-primary' : 'btn-outline'}`}
              onClick={switchToForward}
              aria-pressed={mode === 'forward'}
            >
              {t('messages.email.forward')}
            </button>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={18} /></button>
        </div>

        <div className="email-modal-header">
          <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.from')}</span><span className="email-bubble-value">{fromLabel} {fromAddr && <span className="email-bubble-addr">&lt;{fromAddr}&gt;</span>}</span></div>
          {toAddr && <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.to')}</span><span className="email-bubble-value">{toAddr}</span></div>}
          {message.emailSubject && <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.subjectLabel')}</span><span className="email-bubble-value email-bubble-subject">{message.emailSubject}</span></div>}
          <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.date')}</span><span className="email-bubble-value">{fmtTime(message.sentAt)} · {timeShort(t, message.sentAt)}</span></div>
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
            {t.rich('messages.email.pick')}
          </div>
        )}

        {mode && (
          <form className="email-modal-reply" onSubmit={handleSend}>
            {/* Do-Not-Contact warning — WARN, not block (UI_RULES §47): Send
                stays enabled so a human can still answer a customer who wrote
                in first. */}
            {contact?.doNotContact && (
              <div className="callout callout-danger" style={{ marginBottom: 8 }}>
                {t.rich('messages.email.dnc')}
              </div>
            )}
            {/* To — editable in both modes. Reply pre-fills the other party;
                forward starts blank. Comma-separate to reach several people. */}
            <div className="email-recip-row">
              <span className="email-recip-label">{t('messages.email.to')}</span>
              <input
                type="text"
                className="form-input email-recip-input"
                /* i18n-ok: example addresses, not words */ placeholder="name@example.com, another@example.com"
                value={toRecipients}
                onChange={(e) => setToRecipients(e.target.value)}
                autoFocus={mode === 'forward'}
              />
              <div className="email-recip-toggles">
                {!showReplyCc && (
                  <button type="button" className="linklike" onClick={() => setShowReplyCc(true)}>{t('messages.email.cc')}</button>
                )}
                {!showReplyBcc && (
                  <button type="button" className="linklike" onClick={() => setShowReplyBcc(true)}>{t('messages.email.bcc')}</button>
                )}
              </div>
            </div>
            {showReplyCc && (
              <div className="email-recip-row">
                <span className="email-recip-label">{t('messages.email.ccLabel')}</span>
                <input
                  type="text"
                  className="form-input email-recip-input"
                  /* i18n-ok: example addresses */ placeholder="email1@example.com, email2@example.com"
                  value={replyCc}
                  onChange={(e) => setReplyCc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowReplyCc(false); setReplyCc(''); }}
                  title={t('messages.email.hideCc')}
                  aria-label={t('messages.email.hideCc')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            {showReplyBcc && (
              <div className="email-recip-row">
                <span className="email-recip-label">{t('messages.email.bccLabel')}</span>
                <input
                  type="text"
                  className="form-input email-recip-input"
                  /* i18n-ok: example addresses */ placeholder="email1@example.com, email2@example.com"
                  value={replyBcc}
                  onChange={(e) => setReplyBcc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowReplyBcc(false); setReplyBcc(''); }}
                  title={t('messages.email.hideBcc')}
                  aria-label={t('messages.email.hideBcc')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            <div className="email-recip-hint">
              {t.rich('messages.email.multiHint', null, { code: (chunk) => <code>{chunk}</code> })}
            </div>
            <textarea
              className="email-modal-reply-input"
              placeholder={mode === 'forward' ? t('messages.email.forwardNote') : t('messages.email.replyPlaceholder')}
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
                <div className="text-xs text-muted" style={{ marginBottom: 4 }}>{t('messages.email.signatureNote')}</div>
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
                    <button type="button" className="chip-remove" onClick={() => removeAttachment(i)} aria-label={t('messages.email.remove')}>&times;</button>
                  </div>
                ))}
              </div>
            )}
            <div className="email-modal-reply-actions">
              <button type="button" className="btn btn-outline" onClick={() => fileRef.current?.click()}>
                <Icon name="paperclip" size={14} /> {t('messages.email.attach')}
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={handleAttach} />
              <button type="submit" className="btn btn-primary" disabled={!replyText.trim() || !toRecipients.trim()}>{mode === 'forward' ? t('messages.email.forward') : t('messages.send')}</button>
            </div>
            <div className="compose-hint">{t('messages.email.sendHint', { action: mode === 'forward' ? t('messages.email.forward') : t('messages.send') })}</div>
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
  const t = useT();
  const fmtSize = formatBytes;
  const canSend = Boolean(to) && Boolean((body || '').trim());
  return (
    <div className="email-modal-overlay" onClick={onClose}>
      <div className="email-modal" onClick={(e) => e.stopPropagation()}>
        <div className="email-modal-top">
          <Icon name="mail" size={18} />
          <span className="email-modal-title">{t('messages.email.review')}</span>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={18} /></button>
        </div>

        <div className="email-modal-header">
          <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.from')}</span><span className="email-bubble-value">{fromName || t('messages.email.you')} {fromAddr && <span className="email-bubble-addr">&lt;{fromAddr}&gt;</span>}</span></div>
          <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.to')}</span><span className="email-bubble-value">{to || <span className="text-muted">{t('messages.email.noRecipient')}</span>}</span></div>
          {cc && <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.ccLabel')}</span><span className="email-bubble-value">{cc}</span></div>}
          {bcc && <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.bccLabel')}</span><span className="email-bubble-value">{bcc}</span></div>}
          <div className="email-bubble-row"><span className="email-bubble-label">{t('messages.email.subjectLabel')}</span><span className="email-bubble-value email-bubble-subject">{subject || <span className="text-muted">{t('messages.email.noSubject')}</span>}</span></div>
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
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('messages.email.backToEdit')}</button>
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={!canSend}>{t('messages.send')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmailBubble({ message, contact, onReply, onRetry, onExpand }) {
  const t = useT();
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const isOut = message.direction === 'out';
  const { fromLabel } = emailMeta(message, contact, author, t);
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
            <Icon name="paperclip" size={11} /> {t('messages.email.attachments', { count: message.attachments.length })}
          </div>
        )}
        <div className="email-preview-footer">
          <span className="chat-time">{fmtTime(message.sentAt)}</span>
          <button type="button" className="btn btn-sm btn-gold" onClick={() => (onExpand ? onExpand() : setShowModal(true))}>
            {isOut ? t('messages.email.open') : t('messages.email.readReply')}
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
function deriveErrorCode(reason, t) {
  const r = String(reason || '');
  const num = r.match(/\b(\d{3,6})\b/); // Twilio (30003, 21211…) / HTTP status
  if (num) return t('messages.failed.error', { code: num[1] });
  if (/no (email|phone)/i.test(r)) return t('messages.failed.noRecipient');
  if (/not connected|not provisioned|a2p|no twilio number/i.test(r)) return t('messages.failed.notConfigured');
  if (/bounce|mailbox|undeliverable|recipient/i.test(r)) return t('messages.failed.bounced');
  if (/unauthor|invalid_grant|revoked|token|reconnect|\b40[13]\b/i.test(r)) return t('messages.failed.authExpired');
  return null;
}

// Inline "Failed to deliver" row under an outbound message whose delivery failed
// — for both SMS and email (rendered from ChatBubble + the email preview).
// Compact by default: shows the status + a derived error code; clicking it
// expands the full reason + provider reference so staff can see exactly why.
// Retry re-fires the send for that exact message.
function FailedRow({ message, onRetry }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // The reason is the text or email service's own words, shown as it came.
  const reason = message.failureReason || '';
  const code = deriveErrorCode(reason, t);
  const ref = message.twilioMessageSid || message.emailMessageId || null;
  const channel = (message.emailMessageId || message.emailSubject) ? t('messages.channel.email') : t('messages.channel.sms');
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
        <span className="msg-failed-label">{t('messages.failed.label')}</span>
        {code && <span className="msg-failed-code">{code}</span>}
        {hasDetail && (
          <span className={`msg-failed-chevron ${open ? 'open' : ''}`}><Icon name="chevronDown" size={11} /></span>
        )}
      </button>
      {onRetry && (
        <button type="button" className="btn btn-sm btn-outline" onClick={() => onRetry(message)}>{t('common.retry')}</button>
      )}
      {open && hasDetail && (
        <div className="msg-failed-detail">
          <div><span className="msg-failed-k">{t('messages.failed.channel')}</span>{channel}</div>
          {reason && <div><span className="msg-failed-k">{t('messages.failed.why')}</span>{reason}</div>}
          {ref && <div><span className="msg-failed-k">{t('messages.failed.reference')}</span><code>{ref}</code></div>}
        </div>
      )}
    </div>
  );
}

// A delivery status the services report, in the reader's language; an unknown one shows as sent.
const DELIVERY_STATUS_KEYS = {
  queued: 'messages.status.queued',
  sending: 'messages.status.sending',
  sent: 'messages.status.sent',
  delivered: 'messages.status.delivered',
  received: 'messages.status.received',
  undelivered: 'messages.status.undelivered',
};

function ChatBubble({ message, contact, onRetry }) {
  const t = useT();
  const state = useStore();
  const author = message.authorUserId ? selectUserById(state, message.authorUserId) : null;
  const authorName = authorNameOf(message, author);
  const isOut = message.direction === 'out';
  // Honest delivery state only — the model tracks a status (…/delivered/failed),
  // never a per-message "read" receipt, so we surface the real one or nothing.
  const ds = message.deliveryStatus;
  const status = isOut && ds && ds !== 'failed'
    ? (DELIVERY_STATUS_KEYS[ds] ? t(DELIVERY_STATUS_KEYS[ds]) : ds.charAt(0).toUpperCase() + ds.slice(1))
    : null;
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
  unavailable = false,           // the address names a thread that does not exist or this person may not open (CS-149)
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
  onSwitchChannel = null,        // (channel) => void: the composer's Send as SMS / Email switch; the dock passes none
  composeChannelOverride = null,
  onRetry,                      // (message) => void — re-send a failed message
  initialDraft = null,           // seed the composer once (e.g. a payment reminder)
  hideHeader = false,            // MessagesDock mini-view supplies its own chrome; drop the pane's header row
  onEmailExpand = null,          // dock: route an email message's Open/Read & Reply to the full page (no in-dock email compose)
}) {
  const t = useT();
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

  // Send as SMS / Email (Daniel, 2026-10-27: back on the phone and the desktop, with the full
  // email box on both). It shows on a customer thread whose contact has a phone AND an email;
  // picking one only changes how THIS reply goes out, in this thread (an email sent from a text
  // thread stays here, and its reply finds it by In-Reply-To, RECEIVE_EMAIL). Opening another
  // thread starts again on that thread's own channel (Messaging.jsx resets the override).
  const subjectRef = useRef(null);
  const draftRef = useRef(null);
  const focusAfterSwitch = useRef(false);
  const showChannelSwitch = Boolean(onSwitchChannel)
    && (conversation?.channel === 'sms' || conversation?.channel === 'email')
    && Boolean(contact?.phone) && Boolean(contact?.email);
  const switchChannel = (channel) => {
    if (channel === composeChannel) return;
    focusAfterSwitch.current = true;
    onSwitchChannel(channel);
  };

  // Pre-fill subject with "Re: <prior subject>" when continuing an email
  // thread; first message in a thread starts with an empty subject.
  // Keyed on the last email SUBJECT, never the messages array: the parent passes a new array on
  // every render (selectMessagesForConversation), which wiped what was typed (CS-961,
  // test-messaging-subject.mjs). It is set again only when the thread, the channel or that
  // subject changes.
  const priorSubject = useMemo(
    () => [...messages].reverse().find((m) => m.emailSubject)?.emailSubject || null,
    [messages]
  );
  useEffect(() => {
    if (composeChannel !== 'email') return;
    if (priorSubject) {
      const base = priorSubject.replace(/^(Re:\s*)+/i, '');
      setSubject(`Re: ${base}`);
    } else {
      setSubject('');
    }
  }, [conversation?.id, composeChannel, priorSubject]);

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

  // After the switch, the cursor goes where the next word is typed: the Subject when a first
  // email still needs one, else the message. On a phone only when the cursor was already in the
  // message, so a tap on the switch never raises the keyboard by itself.
  useEffect(() => {
    if (!focusAfterSwitch.current) return;
    focusAfterSwitch.current = false;
    const typing = Boolean(draftRef.current) && document.activeElement === draftRef.current;
    if (isMobile && !typing) return;
    const target = composeChannel === 'email' && subjectRequired && !subject.trim() ? subjectRef.current : draftRef.current;
    target?.focus({ preventScroll: true });
  }, [composeChannel, isMobile, subjectRequired, subject]);

  if (!conversation) {
    // A link to a conversation this person cannot open says so, with the way back; nothing else is
    // opened in its place (CS-149). With no link, the pane waits for a pick.
    return (
      <section className="message-pane">
        {unavailable ? (
          <EmptyState
            icon={<Icon name="lock" size={28} />}
            title={t('messages.unavailable.title')}
            message={t('messages.unavailable.body')}
            action={onBack ? <button type="button" className="btn btn-secondary" onClick={onBack}>{t('messages.unavailable.back')}</button> : null}
          />
        ) : (
          <EmptyState
            icon={<Icon name="messaging" size={28} />}
            title={t('messages.pickConversation')}
            message={t('messages.pickConversationHint')}
          />
        )}
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
    headerName = dmOther ? dmOther.name : t('messages.unknownUser');
    headerSub = t('messages.dmSub');
    initials = dmOther?.initials || '?';
    avatarVariant = dmOther?.avatar || 1;
  } else if (isInternalThread) {
    headerName = conversation.title || t('messages.teamDiscussion');
    // Threads outlive their creators, so say who made this one — including when
    // they're gone. Without it a departed creator reads as no creator at all,
    // and there's no way to tell an orphan from a live thread.
    const creator = threadCreator.state === 'inactive' ? t('messages.creatorInactive', { name: threadCreator.name })
      : threadCreator.state === 'removed' ? t('messages.creatorRemoved', { name: threadCreator.name })
        : threadCreator.name;
    headerSub = threadCreator.name ? t('messages.internalChannelBy', { name: creator }) : t('messages.internalChannel');
    initials = 'T';
    avatarVariant = 3;
  } else {
    headerName = contact ? `${contact.firstName} ${contact.lastName}` : t('messages.unlinked');
    headerSub = contact?.email || contact?.phone || t('messages.noContactInfo');
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
      ? <div className="chat-daysep" key={`sep-${m.id}`}><span>{dayLabel(m.sentAt, t)}</span></div>
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
          <button type="button" className="btn-icon btn-icon-ghost msg-back-btn" onClick={onBack} aria-label={t('messages.backToInbox')}>
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <Avatar user={dmOther} initials={initials} variant={avatarVariant} size="sm" />
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
            {!isInternalThread && contact?.doNotContact && <Badge variant="red">{t('messages.dnc')}</Badge>}
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
              title={isStarredByMe ? t('messages.unstar') : t('messages.star')}
              aria-label={isStarredByMe ? t('messages.unstar') : t('messages.star')}
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
              title={isMuted ? t('messages.snoozed') : t('messages.snooze')}
              aria-label={isMuted ? t('messages.unsnoozeAria') : t('messages.snoozeAria')}
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
              title={t('messages.deleteThreadTitle')}
            >
              <Icon name="trash" size={14} />
              {t('messages.deleteThread')}
            </button>
          )}
        </div>
      </div>
      )}

      <div className="message-pane-scroll" ref={scrollRef}>
        {messages.length === 0 ? <EmptyState message={t('messages.noMessagesYetDot')} /> : messageEls}
      </div>

      <form className={`compose-bar${composeChannel === 'email' ? ' is-email' : ''}`} onSubmit={handleSend}>
        {/* Send as SMS / Email. Its buttons never take the cursor from the message (a press
            while typing keeps the keyboard up, and Shift never lands on them). */}
        {showChannelSwitch && (
          <div className="compose-channel">
            <span className="compose-email-label">{t('messages.sendAs')}</span>
            <div className="segmented" role="group" aria-label={t('messages.sendAs')}>
              {[
                { channel: 'sms', label: t('messages.channel.sms') },
                { channel: 'email', label: t('messages.channel.email') },
              ].map(({ channel, label }) => (
                <button
                  key={channel}
                  type="button"
                  className={`segmented-btn ${composeChannel === channel ? 'active' : ''}`}
                  aria-pressed={composeChannel === channel}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => switchChannel(channel)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Email-only: Subject + Sending-as picker. */}
        {composeChannel === 'email' && (
          <div className="compose-email-meta">
            {connectedInboxes.length > 0 ? (
              <div className="compose-email-row">
                <span className="compose-email-label">{t('messages.email.sendingAs')}</span>
                <select
                  className="form-input compose-email-field"
                  value={selectedInboxId || ''}
                  onChange={(e) => setSelectedInboxId(e.target.value)}
                >
                  {connectedInboxes
                    .filter((i) => i.status === 'active')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.email}{i.isDefault ? ` ${t('messages.email.default')}` : ''} · {t('messages.email.via', { provider: PROVIDER_NAMES[i.provider] || PROVIDER_NAMES.smtp })}
                      </option>
                    ))}
                </select>
              </div>
            ) : (
              <div className="card" style={{ padding: '8px 10px', background: 'var(--inset-bg)', fontSize: 13 }}>
                {t.rich('messages.email.noInbox', null, { link: (chunk) => <Link to="/settings/inboxes" state={nav}>{chunk}</Link> })}
              </div>
            )}
            <div className="compose-email-row">
              <span className="compose-email-label">{t('messages.email.subjectLabel')}</span>
              <input
                ref={subjectRef}
                type="text"
                className="form-input compose-email-field"
                placeholder={subjectRequired ? t('messages.email.subjectRequired') : t('messages.email.subject')}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <div className="email-recip-toggles">
                {!showComposeCc && (
                  <button type="button" className="linklike" onClick={() => setShowComposeCc(true)}>{t('messages.email.cc')}</button>
                )}
                {!showComposeBcc && (
                  <button type="button" className="linklike" onClick={() => setShowComposeBcc(true)}>{t('messages.email.bcc')}</button>
                )}
              </div>
            </div>
            {showComposeCc && (
              <div className="compose-email-row">
                <span className="compose-email-label">{t('messages.email.ccLabel')}</span>
                <input
                  type="text"
                  className="form-input compose-email-field"
                  /* i18n-ok: example addresses */ placeholder="email1@example.com, email2@example.com"
                  value={composeCc}
                  onChange={(e) => setComposeCc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowComposeCc(false); setComposeCc(''); }}
                  title={t('messages.email.hideCc')}
                  aria-label={t('messages.email.hideCc')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            {showComposeBcc && (
              <div className="compose-email-row">
                <span className="compose-email-label">{t('messages.email.bccLabel')}</span>
                <input
                  type="text"
                  className="form-input compose-email-field"
                  /* i18n-ok: example addresses */ placeholder="email1@example.com, email2@example.com"
                  value={composeBcc}
                  onChange={(e) => setComposeBcc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-ghost email-recip-hide"
                  onClick={() => { setShowComposeBcc(false); setComposeBcc(''); }}
                  title={t('messages.email.hideBcc')}
                  aria-label={t('messages.email.hideBcc')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            {/* With no mailbox the card above already says so; the red line is for the others. */}
            {connectedInboxes.length > 0 && emailBlockers.length > 0 && (
              <div className="form-error" style={{ fontSize: 12, marginTop: 2 }}>
                {emailBlockers.map((b) => b.label).join(' · ')}
              </div>
            )}
          </div>
        )}

        <div className="compose-row">
          <div className="compose-input-wrap">
            <textarea
              ref={draftRef}
              className="compose-input"
              placeholder={
                isDmThread
                  ? (dmOther ? t('messages.compose.dm', { name: dmOther.name.split(' ')[0] }) : t('messages.compose.dmSomeone'))
                  : composeChannel === 'internal'
                  ? t('messages.compose.internal')
                  : composeChannel === 'email' ? t('messages.compose.email') : t('messages.compose.text')
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
            />
          </div>
          <div className="compose-row-actions">
            {composeChannel === 'email' && (
              <>
                <button type="button" className="btn btn-outline compose-attach" onClick={() => composeFileRef.current?.click()} aria-label={t('messages.email.attach')}>
                  <Icon name="paperclip" size={14} /> <span className="compose-attach-label">{t('messages.email.attach')}</span>
                </button>
                <input ref={composeFileRef} type="file" multiple hidden onChange={(e) => {
                  const files = filterBySizeCap([...(e.target.files || [])], toast, t);
                  if (files.length > 0) {
                    setComposeAttachments((prev) => [...prev, ...files.map((f) => ({ name: f.name, size: f.size, file: f }))]);
                  }
                  e.target.value = '';
                }} />
              </>
            )}
            <button type="submit" className="btn btn-sm btn-gold compose-send" disabled={sendDisabled}>
              {composeChannel === 'email' ? t('messages.reviewAndSend') : t('messages.send')}
            </button>
          </div>
          {composeChannel === 'email' && composeAttachments.length > 0 && (
            <div className="compose-attachments">
              {composeAttachments.map((a, i) => (
                <div key={i} className="email-attachment-chip">
                  <Icon name="paperclip" size={12} />
                  <span>{a.name}</span>
                  <span className="text-muted text-xs">({formatBytes(a.size)})</span>
                  <button type="button" className="chip-remove" onClick={() => setComposeAttachments((prev) => prev.filter((_, j) => j !== i))} aria-label={t('messages.email.remove')}>&times;</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="compose-hint">
          {composeChannel === 'email'
            ? t('messages.compose.hintEmail')
            : t('messages.compose.hint')}
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
