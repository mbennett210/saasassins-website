// Server-side port of the RECEIVE_EMAIL reducer (src/store/reducer.js). Threads
// one inbound reply into the org-state document: dedup, then In-Reply-To match,
// then contact-by-email (preferring a thread that already carries email), else a
// new email thread. Pure: returns the next state (or the same state on a
// dup / missing sender). Keep this in sync with the reducer's RECEIVE_EMAIL.
//
// Notification fan-out (NOTIF-02) is the SAME helper the reducer uses
// (src/lib/notifications.js — Node-safe, like marketingScheduler.js), so the
// cron path and the live-tab path can't drift: with no tab open, an inbound
// client email still writes the per-recipient bell rows, which ride the same
// CAS write and reach clients over Realtime.

import crypto from 'node:crypto';
import { fanOutMessageNotifications } from '../../src/lib/notifications.js';

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

export function ingestInboundEmail(state, email) {
  const now = new Date().toISOString();
  const fromEmail = (email.fromEmail || '').trim().toLowerCase();
  if (!fromEmail) return state;

  const inReplyTo = email.inReplyTo || null;
  const subject = email.subject || null;
  const body = email.body || '';
  const messageId = email.messageId || null;
  const references = email.references || null;
  const toInboxEmail = email.toInboxEmail || null;

  const messages = Array.isArray(state.messages) ? state.messages : [];
  const conversations = Array.isArray(state.conversations) ? state.conversations : [];
  const contacts = Array.isArray(state.contacts) ? state.contacts : [];

  // Idempotency — skip if this reply is already stored.
  if (messageId && messages.some((m) => m.emailMessageId === messageId)) return state;

  // Strategy 1: In-Reply-To → the prior message whose Message-ID it answers.
  let convId = null;
  if (inReplyTo) {
    const prior = messages.find((m) => m.emailHeaders?.messageId === inReplyTo);
    if (prior?.conversationId) convId = prior.conversationId;
  }

  const matchContact = !convId
    ? contacts.find((c) => (c.email || '').toLowerCase() === fromEmail)
    : null;

  let nextConversations = conversations;
  if (convId) {
    nextConversations = conversations.map((c) =>
      c.id === convId ? { ...c, lastMessageAt: now } : c
    );
  } else {
    // Prefer a thread that already carries email with this contact (where the
    // emails were sent), then a dedicated email thread; else create one.
    const carriesEmail = (c) =>
      messages.some((m) => m.conversationId === c.id && (m.emailSubject || m.emailHeaders));
    const existing = matchContact
      ? (conversations.find((c) => c.contactId === matchContact.id && carriesEmail(c))
        || conversations.find((c) => c.channel === 'email' && c.contactId === matchContact.id)
        // Last resort before creating: ANY thread for this contact. A reply must
        // join an existing thread — never spawn a new one for a known contact.
        || conversations.find((c) => c.contactId === matchContact.id))
      : conversations.find((c) => c.channel === 'email' && c.title === fromEmail);

    if (existing) {
      convId = existing.id;
      nextConversations = conversations.map((c) =>
        c.id === existing.id ? { ...c, lastMessageAt: now } : c
      );
    } else {
      convId = newId('cv');
      nextConversations = [
        ...conversations,
        {
          id: convId,
          channel: 'email',
          createdAt: now,
          lastMessageAt: now,
          contactId: matchContact?.id || null,
          clientId: matchContact?.companyId || null,
          title: matchContact ? null : fromEmail,
          createdByUserId: null,
          status: 'open',
          snoozedUntil: null,
          starredByUserIds: [],
          mutedByUserIds: [],
        },
      ];
    }
  }

  const message = {
    id: newId('m'),
    conversationId: convId,
    direction: 'in',
    text: body,
    sentAt: now,
    readByUserIds: [],
    authorUserId: null,
    snippetId: null,
    deliveryStatus: 'received',
    emailMessageId: messageId,
    emailHeaders: { messageId, inReplyTo, references },
    emailSubject: subject,
    fromEmail,
    toInboxEmail,
  };

  const convForFanOut = nextConversations.find((c) => c.id === convId);
  const notifications = fanOutMessageNotifications(state, message, convForFanOut);

  return {
    ...state,
    conversations: nextConversations,
    messages: [...messages, message],
    notifications,
  };
}
