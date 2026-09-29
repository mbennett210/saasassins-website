// Server-side port of the RECEIVE_MARKETING_REPLY reducer (src/store/reducer.js).
// Threads one inbound MARKETING reply into the org-state document with NO browser
// tab open: record the reply, halt the drip, route + tag the contact, auto opt-out,
// and fan out the `marketingReplyAssigned` bell row. Pure: returns the next state
// (or the same state on a dup). KEEP IN LOCKSTEP with the reducer's
// RECEIVE_MARKETING_REPLY case.
//
// Correlation is by from-email → contact → enrollment, exactly like the reducer's
// fallback — the inbound buffer carries no enrollmentId (neither the client poll
// nor the cron extracts one), so from-email is the only signal both paths use.
// Idempotency is by reply id (= the email's rfc Message-ID), so the cron and the
// client InboundListener can both process the same buffered reply without
// double-recording/halting/notifying.

import { newId } from '../../src/lib/ids.js';
import { capInsert } from '../../src/lib/notifications.js';
import { classifyReply, OPT_OUT_RE } from '../../src/lib/replyTriage.js';

const nowIso = () => new Date().toISOString();

export function ingestMarketingReply(state, email) {
  const now = nowIso();
  const fromEmail = (email.fromEmail || '').trim().toLowerCase();
  const replyId = email.messageId || null;
  const enrollments = state.marketingEnrollments || [];
  const sequences = state.marketingSequences || [];
  const contacts = state.contacts || [];
  const replies = state.marketingReplies || [];

  // Idempotency — skip if this reply is already recorded (cron/tab overlap).
  if (replyId && replies.some((r) => r.id === replyId)) return state;

  // Resolve the enrollment by from-email contact match (the reducer's fallback —
  // the only correlation available server-side).
  let enrollment = null;
  if (fromEmail) {
    const contact = contacts.find((c) => (c.email || '').toLowerCase() === fromEmail);
    if (contact) {
      const owned = enrollments.filter((e) => e.contactId === contact.id);
      enrollment =
        owned.find((e) => !e.repliedAt && (e.status === 'active' || e.status === 'completed')) ||
        owned[0] ||
        null;
    }
  }
  const sequence = enrollment
    ? sequences.find((s) => s.id === enrollment.sequenceId) || null
    : null;
  const contactId = enrollment ? enrollment.contactId : null;

  // 1. Record the reply row.
  const reply = {
    id: replyId || newId('mrep'),
    enrollmentId: enrollment ? enrollment.id : null,
    sequenceId: sequence ? sequence.id : null,
    contactId,
    fromEmail: fromEmail || null,
    subject: String(email.subject || '').slice(0, 300),
    body: String(email.body || '').slice(0, 4000),
    receivedAt: email.receivedAt || now,
    status: 'new',
    // Triage bucket stamped at record time (human / auto_reply / bounce /
    // unsubscribe) — same classifier the browser uses, so cron- and tab-
    // recorded replies bucket identically in the Replies inbox.
    category: classifyReply({ subject: email.subject, body: email.body, fromEmail }).category,
  };

  // 2. Halt the enrollment when the sequence opts in (haltOnReply default on).
  let nextEnrollments = enrollments;
  if (enrollment && sequence && sequence.haltOnReply !== false) {
    nextEnrollments = enrollments.map((e) =>
      e.id === enrollment.id && !e.repliedAt
        ? { ...e, repliedAt: now, status: 'replied' }
        : e
    );
  }

  // 3. Route the contact per the sequence's reply-routing config.
  let nextContacts = contacts;
  let nextActivities = state.contactActivities || [];
  let nextClients = state.clients;
  const rr = sequence ? (sequence.replyRouting || {}) : {};
  if (contactId && rr.enabled && rr.pipelineId && rr.stageKey) {
    const pipeline = (state.pipelines || []).find((p) => p.id === rr.pipelineId);
    const stage = pipeline ? (pipeline.stages || []).find((st) => st.key === rr.stageKey) : null;
    const contact = nextContacts.find((c) => c.id === contactId);
    if (pipeline && stage && contact && contact.stage !== rr.stageKey) {
      nextContacts = nextContacts.map((c) =>
        c.id === contactId
          ? {
              ...c,
              stage: rr.stageKey,
              pipelineId: rr.pipelineId,
              stageChangedAt: now,
              updatedAt: now,
              lifecycle: rr.stageKey === 'won' ? 'client' : c.lifecycle,
            }
          : c
      );
      if (rr.stageKey === 'won' && contact.companyId) {
        nextClients = (nextClients || []).map((cl) =>
          cl.id === contact.companyId && cl.status === 'prospect' ? { ...cl, status: 'active' } : cl
        );
      }
      nextActivities = [
        ...nextActivities,
        {
          id: newId('act'),
          contactId,
          kind: 'stage_change',
          authorUserId: null,
          body: `Stage: ${contact.stage || '—'} → ${rr.stageKey}`,
          occurredAt: now,
        },
      ];
    }
  }

  // 4. Notify the assigned user (per-sequence "Notify on reply"). The operator
  // pick IS the gate; still respect an active account + an explicit opt-out.
  let nextNotifications = state.notifications || [];
  const notifyUserId = sequence?.notifyOnReplyUserId || null;
  const notifyInApp = sequence?.notifyOnReplyChannels?.inApp === true;
  if (notifyUserId && notifyInApp && sequence) {
    const targetUser = (state.users || []).find((u) => u.id === notifyUserId);
    if (targetUser
      && targetUser.status === 'active'
      && (targetUser.notificationPrefs || {}).marketingReplyAssigned !== false) {
      const contact = contactId ? nextContacts.find((c) => c.id === contactId) : null;
      const contactName = contact
        ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email || 'a contact'
        : (fromEmail || 'a contact');
      const row = {
        id: newId('nt'),
        createdAt: now,
        readAt: null,
        userId: targetUser.id,
        eventKey: 'marketingReplyAssigned',
        title: `${contactName} replied to "${sequence.name}"`,
        body: (email.body || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        url: '/marketing?tab=replies',
      };
      nextNotifications = capInsert(nextNotifications, targetUser.id, row);
    }
  }

  // 5. Apply the sequence's reply tags to the contact.
  const replyTags = sequence && Array.isArray(sequence.replyTags) ? sequence.replyTags : [];
  if (contactId && replyTags.length > 0) {
    nextContacts = nextContacts.map((c) => {
      if (c.id !== contactId) return c;
      const have = c.tagIds || [];
      const merged = [...have];
      for (const tid of replyTags) {
        if (tid && !merged.includes(tid)) merged.push(tid);
      }
      return merged.length === have.length ? c : { ...c, tagIds: merged, updatedAt: now };
    });
  }

  // 6. Auto opt-out on an unsubscribe phrase (subject or body). Shares
  // OPT_OUT_RE with the triage classifier so the 'unsubscribe' bucket and the
  // CAN-SPAM suppress always agree.
  let nextSuppressions = state.marketingSuppressions || [];
  if (fromEmail && (OPT_OUT_RE.test(email.body || '') || OPT_OUT_RE.test(email.subject || ''))) {
    if (!nextSuppressions.some((s) => (s.email || '').toLowerCase() === fromEmail)) {
      nextSuppressions = [
        ...nextSuppressions,
        { email: fromEmail, source: 'reply', reason: 'Auto-detected opt-out in reply', createdAt: now },
      ];
    }
  }

  return {
    ...state,
    marketingReplies: [...replies, reply],
    marketingEnrollments: nextEnrollments,
    clients: nextClients,
    contacts: nextContacts,
    contactActivities: nextActivities,
    notifications: nextNotifications,
    marketingSuppressions: nextSuppressions,
  };
}
