import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from './useAuth';
import { useToast } from '../components/Toast';
import {
  selectIsTwilioSendReady, selectTwilioPhone, selectTwilioBlockers,
  selectConnectedInboxesForUser, selectDefaultConnectedInbox,
  selectMessagingEmailBlockersForUser, selectEmailDefaultReplyTo,
} from '../store/selectors';
import { sendSMS, subscribeToDelivery } from '../lib/twilio';
import { sendViaInbox } from '../lib/connectedInboxes';
import { ATTACHMENT_TOTAL_MAX_BYTES, filesToStorageAttachments, formatBytes } from '../lib/attachments';

// ─────────────────────────────────────────────────────────────────────────────
// useMessageSender — the ONE outbound-message pipeline, shared by every surface
// that can send (the full Messaging page AND the floating MessagesDock mini-view).
// Extracted from Messaging.jsx so the dock's inline composer sends through the
// exact same path — optimistic insert, SMS/email gating, delivery lifecycle,
// attachment conversion, retry — with zero drift between the two surfaces.
//
//   const { sendMessage, retryMessage } = useMessageSender();
//   sendMessage(conversation, contact, messages, text, opts);
//   retryMessage(conversation, contact, message);
//
// `messages` is the thread's current message list (used for email subject
// inheritance + threading headers); callers pass their own scoped copy.
// ─────────────────────────────────────────────────────────────────────────────

// In-session cache of converted outbound attachments (the backend base64 shape),
// keyed by the optimistic message id. A failed email keeps its entry so Retry
// can resend the same files; a successful send clears it. Held here, out of the
// store, so megabytes of base64 never hit localStorage.
const pendingMessageAttachments = new Map();

export function useMessageSender() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();

  // Twilio readiness — used to gate outbound SMS.
  const sendReady = selectIsTwilioSendReady(state);
  const blockers = selectTwilioBlockers(state);
  const twilioPhone = selectTwilioPhone(state);

  // Per-user Connected Inboxes — drive the Email channel send flow.
  const myConnectedInboxes = selectConnectedInboxesForUser(state, currentUser?.id);
  const myDefaultInbox = selectDefaultConnectedInbox(state, currentUser?.id);
  const emailBlockers = selectMessagingEmailBlockersForUser(state, currentUser?.id);
  const emailDefaultReplyTo = selectEmailDefaultReplyTo(state);

  const sendMessage = (conversation, contact, messages, text, opts) => {
    if (!conversation) return;
    const threadMessages = messages || [];
    const isDmThread = conversation.channel === 'dm';
    // The compose toggle (Send as SMS / Email) wins over the thread's native
    // channel — otherwise the "Send as Email" pivot would still fire as SMS.
    const effectiveChannel = opts?.channel || conversation.channel;
    // DM messages all carry direction='internal' (peer-to-peer, no external counterpart).
    const direction = isDmThread || effectiveChannel === 'internal' ? 'internal' : 'out';
    const isSMS = effectiveChannel === 'sms' && direction === 'out';
    const isEmail = effectiveChannel === 'email' && direction === 'out';

    // Resolve email metadata up front so the optimistic message carries
    // it. Threading headers (In-Reply-To / References) chain off the most
    // recent prior email message in this thread so Gmail / Outlook group
    // the conversation correctly.
    let emailSubject = null;
    let emailFromInboxId = null;
    let emailHeaders = null;
    let emailTo = null;
    if (isEmail) {
      emailSubject = opts?.subject || null;
      if (!emailSubject) {
        // Replies inherit subject from the most recent prior email message.
        const prior = [...threadMessages].reverse().find((m) => m.emailSubject);
        emailSubject = prior?.emailSubject || null;
      }
      emailFromInboxId = opts?.inboxId || myDefaultInbox?.id || null;
      // Build threading headers from prior emails in this thread.
      const priorEmails = threadMessages.filter((m) => m.emailHeaders?.messageId);
      const messageId = `<msg-${conversation.id}-${Date.now()}@app.local>`;
      const inReplyTo = priorEmails.length ? priorEmails[priorEmails.length - 1].emailHeaders.messageId : null;
      const references = priorEmails.length
        ? priorEmails.map((m) => m.emailHeaders.messageId).join(' ')
        : null;
      emailHeaders = { messageId, inReplyTo, references };
      // Recipient: a forward (opts.to) targets a new address; otherwise the
      // conversation's contact.
      emailTo = (opts?.to && opts.to.trim()) || contact?.email || null;
    }

    // Optimistically insert the outbound message so the UI updates immediately.
    // For SMS we'll also kick off the Twilio adapter and patch deliveryStatus as it cycles.
    // For Email we kick off the per-user-inbox send and patch the same way.
    const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dispatch({
      type: ACTIONS.ADD_MESSAGE,
      message: {
        id: messageId,
        conversationId: conversation.id,
        direction,
        text,
        authorUserId: currentUser?.id || null,
        snippetId: opts?.snippetId || null,
        // SMS-only: track delivery state.
        ...(isSMS ? { deliveryStatus: 'queued' } : {}),
        // Email-only: subject + threading + which inbox sent it.
        ...(isEmail
          ? {
              deliveryStatus: 'queued',
              emailSubject,
              emailFromInboxId,
              emailHeaders,
              toEmail: emailTo,
              // Attachment metadata (names + sizes) so the sent email shows its
              // files in the thread. The bytes are converted + shipped below,
              // not stored here — keeps the persisted store lean.
              ...(opts?.attachments?.length
                ? { attachments: opts.attachments.map((a) => ({ name: a.name, size: a.size })) }
                : {}),
              // Persist Cc/Bcc so a later "Reply All" can reconstruct recipients
              // on threads we sent. (Inbound recipient capture needs backend work.)
              ccEmails: opts?.cc ? opts.cc.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
              bccEmails: opts?.bcc ? opts.bcc.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            }
          : {}),
      },
    });

    if (isEmail) {
      // Gate: must have an active connected inbox + the contact must have
      // an email address on file. Empty array == ready in the selector.
      if (emailBlockers.length > 0 || !emailFromInboxId) {
        const reasons = emailBlockers.map((b) => b.label).join('; ') || 'No connected inbox selected';
        dispatch({
          type: ACTIONS.SET_MESSAGE_DELIVERY,
          id: messageId,
          status: 'failed',
          failureReason: reasons,
        });
        toast.error(`Email not sent: ${reasons}`);
        return;
      }
      const toEmail = emailTo;
      if (!toEmail) {
        dispatch({
          type: ACTIONS.SET_MESSAGE_DELIVERY,
          id: messageId,
          status: 'failed',
          failureReason: 'No recipient email address on this thread',
        });
        toast.error('Email not sent: no recipient email on this thread.');
        return;
      }
      const inbox = myConnectedInboxes.find((i) => i.id === emailFromInboxId);
      const fromAddress = inbox?.displayName ? `${inbox.displayName} <${inbox.email}>` : inbox?.email;
      // Reply-To: when the inbox supports inbound capture (Phase 4c), set
      // it to a per-conversation address so replies thread back into the
      // app. Otherwise omit (replies land in the user's actual mailbox).
      const replyTo = inbox?.inboundEnabled
        ? `reply+${conversation.id}@inbound.app.local`
        : (emailDefaultReplyTo || undefined);
      // Total-size guard — per-file size is capped at attach time; this catches
      // the sum blowing Gmail's whole-message limit. Picked files carry .size.
      const pickedFiles = Array.isArray(opts?.attachments) ? opts.attachments : [];
      const totalBytes = pickedFiles.reduce((sum, a) => sum + (a.size || 0), 0);
      if (totalBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
        dispatch({
          type: ACTIONS.SET_MESSAGE_DELIVERY,
          id: messageId,
          status: 'failed',
          failureReason: `Attachments total ${formatBytes(totalBytes)}. Over the ${formatBytes(ATTACHMENT_TOTAL_MAX_BYTES)} limit.`,
        });
        toast.error(`Email not sent: attachments exceed the ${formatBytes(ATTACHMENT_TOTAL_MAX_BYTES)} limit.`);
        return;
      }

      // Convert the picked File objects to the backend's { name, mimeType,
      // content(base64) } shape, then MERGE them with the inline signature image
      // (already in that shape) — both ride the same `attachments` array, kept
      // apart downstream by contentId/inline, so files are merged in, not a
      // replacement for the inline image. Conversion is async, so the send is
      // deferred; the optimistic message is already in the thread. The merged
      // payload is cached by message id so a failed send can be retried with its
      // files intact (see retryMessage) without persisting base64 to the store.
      filesToStorageAttachments(pickedFiles)
        .then((converted) => {
          const attachments = [...converted, ...(opts?.inlineImages || [])];
          if (attachments.length) pendingMessageAttachments.set(messageId, attachments);
          return sendViaInbox(emailFromInboxId, {
            to: toEmail,
            from: fromAddress,
            // Per-user inbox: sender name flows from the user profile so the
            // recipient sees the real human name without per-inbox setup.
            fromName: currentUser?.name,
            subject: emailSubject || '(no subject)',
            // Plain text shows in the thread; opts.sendBody is what actually
            // goes out — HTML with an inline image when the signature carries one.
            body: opts?.sendBody || text,
            replyTo,
            headers: emailHeaders ? {
              'Message-ID': emailHeaders.messageId,
              ...(emailHeaders.inReplyTo ? { 'In-Reply-To': emailHeaders.inReplyTo } : {}),
              ...(emailHeaders.references ? { References: emailHeaders.references } : {}),
            } : undefined,
            tags: ['messaging'],
            attachments: attachments.length ? attachments : undefined,
          });
        })
        .then((result) => {
          pendingMessageAttachments.delete(messageId);
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: messageId,
            status: result.status === 'sent' ? 'delivered' : (result.status || 'sent'),
            emailMessageId: result.id,
            rfcMessageId: result.messageId,
          });
        })
        .catch((err) => {
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: messageId,
            status: 'failed',
            failureReason: err.message || 'Send error',
          });
          toast.error(`Email not sent: ${err.message || 'Unknown error'}`);
        });
      return;
    }

    if (!isSMS) return;

    // Gate: must be Twilio-ready (connected + number + A2P approved).
    if (!sendReady) {
      const reasons = blockers.map((b) => b.label).join('; ') || 'SMS sending is not configured';
      dispatch({
        type: ACTIONS.SET_MESSAGE_DELIVERY,
        id: messageId,
        status: 'failed',
        failureReason: reasons,
      });
      toast.error(`SMS not sent: ${reasons}`);
      return;
    }

    // Resolve "to" — prefer linked contact's phone, fall back to thread title (raw number).
    const toPhone = contact?.phone || conversation.title || null;
    if (!toPhone) {
      dispatch({
        type: ACTIONS.SET_MESSAGE_DELIVERY,
        id: messageId,
        status: 'failed',
        failureReason: 'No recipient phone number on this thread',
      });
      toast.error('SMS not sent: no recipient phone number on this thread.');
      return;
    }

    sendSMS({ from: twilioPhone, to: toPhone, body: text })
      .then((result) => {
        dispatch({
          type: ACTIONS.SET_MESSAGE_DELIVERY,
          id: messageId,
          status: result.status, // 'queued' initially
          twilioMessageSid: result.sid,
        });
        const unsubscribe = subscribeToDelivery(result.sid, (update) => {
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: messageId,
            status: update.status,
            ...(update.failureReason ? { failureReason: update.failureReason } : {}),
          });
          if (update.status === 'delivered' || update.status === 'failed') {
            unsubscribe();
            if (update.status === 'failed') {
              toast.error(`SMS failed: ${update.failureReason || 'Unknown error'}`);
            }
          }
        });
      })
      .catch((err) => {
        dispatch({
          type: ACTIONS.SET_MESSAGE_DELIVERY,
          id: messageId,
          status: 'failed',
          failureReason: err.message || 'Send error',
        });
        toast.error(`SMS not sent: ${err.message || 'Unknown error'}`);
      });
  };

  // Re-send a message that previously failed. Reuses the message's stored
  // channel + routing, flips it back to 'queued', then patches delivery as the
  // adapter resolves — same status lifecycle as the original send.
  const retryMessage = (conversation, contact, message) => {
    if (!message || message.direction !== 'out') return;
    const isEmailMsg = Boolean(message.emailFromInboxId || message.emailHeaders || message.emailSubject);
    dispatch({ type: ACTIONS.SET_MESSAGE_DELIVERY, id: message.id, status: 'queued', failureReason: null });

    if (isEmailMsg) {
      const inbox = myConnectedInboxes.find((i) => i.id === message.emailFromInboxId)
        || myConnectedInboxes.find((i) => i.id === myDefaultInbox?.id)
        || null;
      const toEmail = contact?.email || null;
      if (!inbox || !toEmail) {
        dispatch({
          type: ACTIONS.SET_MESSAGE_DELIVERY,
          id: message.id,
          status: 'failed',
          failureReason: inbox ? 'No recipient email on this thread' : 'No connected inbox to resend from',
        });
        toast.error(`Retry failed: ${inbox ? 'no recipient email.' : 'no connected inbox.'}`);
        return;
      }
      // Resend any attachments cached from the original send (picked files +
      // inline signature image). They live in-memory keyed by message id, so
      // retry works within the session the failure happened in.
      const retryAttachments = pendingMessageAttachments.get(message.id);
      sendViaInbox(inbox.id, {
        to: toEmail,
        fromName: currentUser?.name,
        subject: message.emailSubject || '(no subject)',
        body: message.text,
        headers: message.emailHeaders ? {
          'Message-ID': message.emailHeaders.messageId,
          ...(message.emailHeaders.inReplyTo ? { 'In-Reply-To': message.emailHeaders.inReplyTo } : {}),
          ...(message.emailHeaders.references ? { References: message.emailHeaders.references } : {}),
        } : undefined,
        tags: ['messaging'],
        attachments: retryAttachments && retryAttachments.length ? retryAttachments : undefined,
      })
        .then((result) => {
          pendingMessageAttachments.delete(message.id);
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: message.id,
            status: result.status === 'sent' ? 'delivered' : (result.status || 'sent'),
            emailMessageId: result.id,
            rfcMessageId: result.messageId,
          });
        })
        .catch((err) => {
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: message.id,
            status: 'failed',
            failureReason: err.message || 'Send error',
          });
          toast.error(`Email not sent: ${err.message || 'Unknown error'}`);
        });
      return;
    }

    // SMS retry.
    if (!sendReady) {
      const reasons = blockers.map((b) => b.label).join('; ') || 'SMS sending is not configured';
      dispatch({ type: ACTIONS.SET_MESSAGE_DELIVERY, id: message.id, status: 'failed', failureReason: reasons });
      toast.error(`SMS not sent: ${reasons}`);
      return;
    }
    const toPhone = contact?.phone || conversation?.title || null;
    if (!toPhone) {
      dispatch({
        type: ACTIONS.SET_MESSAGE_DELIVERY,
        id: message.id,
        status: 'failed',
        failureReason: 'No recipient phone number on this thread',
      });
      toast.error('SMS not sent: no recipient phone number on this thread.');
      return;
    }
    sendSMS({ from: twilioPhone, to: toPhone, body: message.text })
      .then((result) => {
        dispatch({ type: ACTIONS.SET_MESSAGE_DELIVERY, id: message.id, status: result.status, twilioMessageSid: result.sid });
        const unsubscribe = subscribeToDelivery(result.sid, (update) => {
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: message.id,
            status: update.status,
            ...(update.failureReason ? { failureReason: update.failureReason } : {}),
          });
          if (update.status === 'delivered' || update.status === 'failed') {
            unsubscribe();
            if (update.status === 'failed') toast.error(`SMS failed: ${update.failureReason || 'Unknown error'}`);
          }
        });
      })
      .catch((err) => {
        dispatch({ type: ACTIONS.SET_MESSAGE_DELIVERY, id: message.id, status: 'failed', failureReason: err.message || 'Send error' });
        toast.error(`SMS not sent: ${err.message || 'Unknown error'}`);
      });
  };

  return { sendMessage, retryMessage };
}
