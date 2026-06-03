// ─────────────────────────────────────────────────────────────────────────────
// Messaging — GHL-shaped inbox (Phase 2a + 2b).
//   Shell: MessagingHeader (inbox toggle + filters + new button)
//          ┌─ Thread List ─┬─ Message Panel ─┬─ Context Panel ─┐
//   Channels: SMS, Email, Internal Comment ONLY. No FB/IG/WhatsApp.
//
// Phase 2b shipped: assignment, status lifecycle (open/snoozed/closed),
// auto-unsnooze (read-side), starring, following, folder membership,
// bulk actions (mark read/unread, delete, assign).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import MessagingHeader, { EMPTY_FILTERS } from '../components/MessagingHeader';
import ConversationThreadList from '../components/ConversationThreadList';
import ConversationMessagePanel from '../components/ConversationMessagePanel';
import ConversationContextPanel from '../components/ConversationContextPanel';
import NewConversationModal from '../components/NewConversationModal';
import NewDmModal from '../components/NewDmModal';
import NewInternalThreadModal from '../components/NewInternalThreadModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import {
  selectContactById, selectConversationById, selectMessagesForConversation,
  selectUnreadForConversation, selectConversationsForInbox, selectUnreadCountForInbox,
  selectEffectiveStatus, selectIsTwilioSendReady, selectTwilioPhone, selectTwilioBlockers,
  selectConnectedInboxesForUser, selectDefaultConnectedInbox,
  selectMessagingEmailBlockersForUser, selectEmailDefaultReplyTo,
  selectConversationsForContact,
} from '../store/selectors';
import { sendSMS, subscribeToDelivery } from '../lib/twilio';
import { sendViaInbox } from '../lib/connectedInboxes';
import { useToast } from '../components/Toast';

const DATE_WINDOW_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Pane-resize constraints. The middle pane is protected by both a CSS
// minmax(480px, 1fr) on the grid AND a JS-side soft clamp here — without the
// JS clamp the side pane could keep visually resizing while the middle pushed
// the layout past the container width.
const PANE_MIN = 260;
const PANE_LEFT_MAX = 520;
const PANE_RIGHT_MAX = 520;
const MIDDLE_MIN = 480;
const HANDLE_WIDTH_TOTAL = 12; // two 6px handles
const PANE_STORAGE_KEY = 'pp.messaging.panes.v1';

function usePaneSizes(containerRef) {
  const [sizes, setSizes] = useState(() => {
    try {
      const raw = localStorage.getItem(PANE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.left === 'number' && typeof parsed.right === 'number') {
          return {
            left: Math.min(PANE_LEFT_MAX, Math.max(PANE_MIN, parsed.left)),
            right: Math.min(PANE_RIGHT_MAX, Math.max(PANE_MIN, parsed.right)),
          };
        }
      }
    } catch { /* ignore */ }
    return { left: 340, right: 320 };
  });

  useEffect(() => {
    try { localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }
  }, [sizes]);

  const dragState = useRef(null);
  const [dragging, setDragging] = useState(null); // 'left' | 'right' | null

  const onDragStart = useCallback((side) => (e) => {
    e.preventDefault();
    dragState.current = {
      side,
      startX: e.clientX,
      startLeft: sizes.left,
      startRight: sizes.right,
      containerWidth: containerRef.current?.getBoundingClientRect().width || 0,
    };
    setDragging(side);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (me) => {
      const ds = dragState.current;
      if (!ds) return;
      const dx = me.clientX - ds.startX;
      // Dynamic max for the side being dragged: don't let the middle pane fall
      // below MIDDLE_MIN. availableForSide = container - other side - handles - MIDDLE_MIN.
      const other = ds.side === 'left' ? ds.startRight : ds.startLeft;
      const dynamicMax = Math.max(PANE_MIN, ds.containerWidth - other - HANDLE_WIDTH_TOTAL - MIDDLE_MIN);
      const hardMax = ds.side === 'left' ? PANE_LEFT_MAX : PANE_RIGHT_MAX;
      const cap = Math.min(hardMax, dynamicMax);
      if (ds.side === 'left') {
        const next = Math.min(cap, Math.max(PANE_MIN, ds.startLeft + dx));
        setSizes((s) => (s.left === next ? s : { ...s, left: next }));
      } else {
        // Right handle: dragging right shrinks the right pane.
        const next = Math.min(cap, Math.max(PANE_MIN, ds.startRight - dx));
        setSizes((s) => (s.right === next ? s : { ...s, right: next }));
      }
    };
    const onUp = () => {
      dragState.current = null;
      setDragging(null);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [sizes.left, sizes.right, containerRef]);

  return { sizes, dragging, onDragStart };
}

function withinDateRange(conv, range) {
  if (range === 'all' || !range) return true;
  const ms = DATE_WINDOW_MS[range];
  if (!ms) return true;
  const ts = conv.lastMessageAt || conv.createdAt;
  if (!ts) return false;
  return Date.now() - new Date(ts).getTime() <= ms;
}

// Compute each active filter's outcome, then combine with AND/OR logic.
// Inactive filters (empty arrays, blank values, defaults) are ignored.
function passesFilters(conv, filters, state) {
  const active = [];
  if (filters.channels.length > 0) {
    active.push(filters.channels.includes(conv.channel));
  }
  if (filters.tagIds.length > 0) {
    const contact = conv.contactId ? selectContactById(state, conv.contactId) : null;
    const tagIds = contact?.tagIds || [];
    active.push(filters.tagIds.some((id) => tagIds.includes(id)));
  }
  if (filters.dateRange && filters.dateRange !== 'all') {
    active.push(withinDateRange(conv, filters.dateRange));
  }
  if (filters.statuses && filters.statuses.length > 0) {
    const eff = selectEffectiveStatus(conv);
    active.push(filters.statuses.includes(eff));
  }
  if (filters.starredOnly) {
    const uid = state.currentUserId;
    active.push(Boolean(uid) && (conv.starredByUserIds || []).includes(uid));
  }
  if (active.length === 0) return true;
  return filters.logic === 'or' ? active.some(Boolean) : active.every(Boolean);
}

function matchesSearch(conv, q, state) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const contact = conv.contactId ? selectContactById(state, conv.contactId) : null;
  const name = contact ? `${contact.firstName} ${contact.lastName}`.toLowerCase() : (conv.title || '').toLowerCase();
  if (name.includes(needle)) return true;
  const msgs = selectMessagesForConversation(state, conv.id);
  return msgs.some((m) => (m.text || '').toLowerCase().includes(needle));
}

export default function Messaging() {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { conversationId: paramId } = useParams();
  const { currentUser } = useAuth();

  const canStart = usePermission('messaging.startConversation');
  const canStartInternalThread = usePermission('messaging.startInternalThread');
  const canBulk = usePermission('messaging.bulkActions');
  const canViewExternalInbox = usePermission('messaging.startConversation');
  const isSuperAdmin = currentUser?.role === 'owner';

  const toast = useToast();

  // Twilio readiness — used to gate outbound SMS in handleSend.
  const sendReady = selectIsTwilioSendReady(state);
  const blockers = selectTwilioBlockers(state);
  const twilioPhone = selectTwilioPhone(state);

  // Per-user Connected Inboxes — drive the "Sending as" dropdown + Email
  // channel send flow. Email blockers surface inline in the compose pane
  // when the user has no active inbox.
  const myConnectedInboxes = selectConnectedInboxesForUser(state, currentUser?.id);
  const myDefaultInbox = selectDefaultConnectedInbox(state, currentUser?.id);
  const emailBlockers = selectMessagingEmailBlockersForUser(state, currentUser?.id);
  const emailDefaultReplyTo = selectEmailDefaultReplyTo(state);

  // Read ?inbox=… from the URL once on mount so deep-links from "New DM" land on the DMs tab.
  const initialInbox = (() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get('inbox');
      if (v === 'inbox' || v === 'internal' || v === 'dm') return v;
    } catch { /* ignore */ }
    return canViewExternalInbox ? 'inbox' : 'internal';
  })();
  const [selectedInbox, setSelectedInbox] = useState(initialInbox);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(paramId || null);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newInternalThreadOpen, setNewInternalThreadOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // null when closed; { ids, deletable, skipped } when the bulk-delete confirm dialog is open.
  const [bulkDeletePrompt, setBulkDeletePrompt] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const paneContainerRef = useRef(null);
  const panes = usePaneSizes(paneContainerRef);

  // Base inbox list (no filters/search applied yet) — also used for totals in rail counts.
  const inboxConversations = useMemo(
    () => selectConversationsForInbox(state, selectedInbox, currentUser),
    [state, selectedInbox, currentUser]
  );

  // Apply filters + search on top of the inbox slice.
  const visibleConversations = useMemo(
    () => inboxConversations.filter((c) => passesFilters(c, filters, state) && matchesSearch(c, search, state)),
    [inboxConversations, filters, search, state]
  );

  const inboxUnread = useMemo(() => ({
    inbox:    selectUnreadCountForInbox(state, 'inbox',    currentUser),
    internal: selectUnreadCountForInbox(state, 'internal', currentUser),
    dm:       selectUnreadCountForInbox(state, 'dm',       currentUser),
  }), [state, currentUser]);

  const visibleInboxes = canViewExternalInbox
    ? [
        { key: 'inbox',    label: 'Inbox' },
        { key: 'internal', label: 'Threads' },
        { key: 'dm',       label: 'DMs' },
      ]
    : [
        { key: 'internal', label: 'Threads' },
        { key: 'dm',       label: 'DMs' },
      ];

  // Force crew into Threads when they can't see the external inbox.
  useEffect(() => {
    if (!canViewExternalInbox && selectedInbox !== 'internal') {
      setSelectedInbox('internal');
    }
  }, [canViewExternalInbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep activeId in sync with URL + visible-set membership.
  useEffect(() => {
    if (paramId && paramId !== activeId) setActiveId(paramId);
    if (!paramId && activeId && window.matchMedia('(max-width: 768px)').matches) setActiveId(null);
  }, [paramId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visibleConversations.length) return;
    // On mobile, don't auto-select — user should see the inbox first and choose.
    if (window.matchMedia('(max-width: 768px)').matches && !paramId) return;
    if (!activeId || !visibleConversations.find((c) => c.id === activeId)) {
      setActiveId(visibleConversations[0].id);
    }
  }, [visibleConversations, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the user switches inbox, pick the first conversation in the new set
  // and clear any lingering bulk selection (selections don't cross inboxes).
  useEffect(() => {
    setSelectedIds(new Set());
    if (!visibleConversations.length) {
      setActiveId(null);
      return;
    }
    if (window.matchMedia('(max-width: 768px)').matches) {
      setActiveId(null);
      return;
    }
    if (!visibleConversations.find((c) => c.id === activeId)) {
      setActiveId(visibleConversations[0].id);
    }
  }, [selectedInbox]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeConversation = activeId ? selectConversationById(state, activeId) : null;
  const activeContact = activeConversation?.contactId ? selectContactById(state, activeConversation.contactId) : null;
  const activeMessages = activeConversation ? selectMessagesForConversation(state, activeConversation.id) : [];

  // Mark incoming messages as read when opening a thread.
  useEffect(() => {
    if (activeConversation && selectUnreadForConversation(state, activeConversation.id) > 0) {
      dispatch({
        type: ACTIONS.MARK_CONVERSATION_READ,
        id: activeConversation.id,
        currentUserId: currentUser?.id,
      });
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelect = (id) => {
    setActiveId(id);
    navigate(`/messaging/${id}`);
  };

  const handleBackToInbox = () => {
    setActiveId(null);
    navigate('/messaging');
  };

  const handleSend = (text, opts) => {
    if (!activeConversation) return;
    const isDmThread = activeConversation.channel === 'dm';
    // DM messages all carry direction='internal' (peer-to-peer, no external counterpart).
    const direction = isDmThread || opts?.channel === 'internal' ? 'internal' : 'out';
    const isSMS = activeConversation.channel === 'sms' && direction === 'out';
    const isEmail = activeConversation.channel === 'email' && direction === 'out';

    // Resolve email metadata up front so the optimistic message carries
    // it. Threading headers (In-Reply-To / References) chain off the most
    // recent prior email message in this thread so Gmail / Outlook group
    // the conversation correctly.
    let emailSubject = null;
    let emailFromInboxId = null;
    let emailHeaders = null;
    if (isEmail) {
      emailSubject = opts?.subject || null;
      if (!emailSubject) {
        // Replies inherit subject from the most recent prior email message.
        const prior = [...activeMessages].reverse().find((m) => m.emailSubject);
        emailSubject = prior?.emailSubject || null;
      }
      emailFromInboxId = opts?.inboxId || myDefaultInbox?.id || null;
      // Build threading headers from prior emails in this thread.
      const priorEmails = activeMessages.filter((m) => m.emailHeaders?.messageId);
      const messageId = `<msg-${activeConversation.id}-${Date.now()}@app.local>`;
      const inReplyTo = priorEmails.length ? priorEmails[priorEmails.length - 1].emailHeaders.messageId : null;
      const references = priorEmails.length
        ? priorEmails.map((m) => m.emailHeaders.messageId).join(' ')
        : null;
      emailHeaders = { messageId, inReplyTo, references };
    }

    // Optimistically insert the outbound message so the UI updates immediately.
    // For SMS we'll also kick off the Twilio adapter and patch deliveryStatus as it cycles.
    // For Email we kick off the per-user-inbox send and patch the same way.
    const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dispatch({
      type: ACTIONS.ADD_MESSAGE,
      message: {
        id: messageId,
        conversationId: activeConversation.id,
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
      const toEmail = activeContact?.email || null;
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
        ? `reply+${activeConversation.id}@inbound.app.local`
        : (emailDefaultReplyTo || undefined);
      sendViaInbox(emailFromInboxId, {
        to: toEmail,
        from: fromAddress,
        subject: emailSubject || '(no subject)',
        body: text,
        replyTo,
        headers: emailHeaders ? {
          'Message-ID': emailHeaders.messageId,
          ...(emailHeaders.inReplyTo ? { 'In-Reply-To': emailHeaders.inReplyTo } : {}),
          ...(emailHeaders.references ? { References: emailHeaders.references } : {}),
        } : undefined,
        tags: ['messaging'],
      })
        .then((result) => {
          dispatch({
            type: ACTIONS.SET_MESSAGE_DELIVERY,
            id: messageId,
            status: result.status === 'sent' ? 'delivered' : (result.status || 'sent'),
            emailMessageId: result.id,
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
    const toPhone = activeContact?.phone || activeConversation.title || null;
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

  // Hard-delete the active thread for everyone. Gated to creator OR Super Admin at the
  // call site: the Delete-thread button only renders when canHardDelete is true on the
  // message panel, so this handler can trust its caller. Heavy warning modal precedes.
  const handleHardDeleteConversation = () => {
    if (!activeConversation) return;
    const id = activeConversation.id;
    dispatch({ type: ACTIONS.DELETE_CONVERSATION, id });
    setConfirmDeleteOpen(false);
    toast.success('Thread deleted for everyone');
    setActiveId(null);
    navigate('/messaging' + (selectedInbox !== 'inbox' ? `?inbox=${selectedInbox}` : ''));
  };

  // --- Phase 2b per-thread action handlers -------------------------------
  const handleSetStatus = (status) => {
    if (!activeConversation) return;
    dispatch({ type: ACTIONS.SET_CONVERSATION_STATUS, id: activeConversation.id, status });
  };
  const handleSnooze = (until) => {
    if (!activeConversation) return;
    dispatch({ type: ACTIONS.SNOOZE_CONVERSATION, id: activeConversation.id, until });
  };
  const handleToggleStarActive = () => {
    if (!activeConversation) return;
    dispatch({ type: ACTIONS.TOGGLE_CONVERSATION_STAR, id: activeConversation.id });
  };
  const handleToggleStarRow = (id) => {
    dispatch({ type: ACTIONS.TOGGLE_CONVERSATION_STAR, id });
  };
  const handleToggleMute = () => {
    if (!activeConversation || !currentUser) return;
    dispatch({ type: ACTIONS.TOGGLE_CONVERSATION_MUTE, id: activeConversation.id, userId: currentUser.id });
  };
  const handleLinkContact = (contactId) => {
    if (!activeConversation) return;
    dispatch({
      type: ACTIONS.UPDATE_CONVERSATION,
      id: activeConversation.id,
      patch: { contactId: contactId || null },
    });
  };

  // Channel toggle in the compose pane: pivot the user to the contact's
  // other-channel thread (SMS ↔ Email), creating one if it doesn't exist
  // yet. Each channel keeps its own thread per the existing schema; this
  // gives the GHL-style "I want to talk to this contact via X now" pivot
  // without merging channels into a single thread.
  const [composeChannelOverride, setComposeChannelOverride] = useState(null);
  useEffect(() => { setComposeChannelOverride(null); }, [activeConversation?.id]);
  const handleSwitchChannel = (targetChannel) => {
    if (!activeConversation || !activeContact) return;
    if (targetChannel === 'sms' && !activeContact.phone) {
      toast.error('Contact has no phone number on file.');
      return;
    }
    if (targetChannel === 'email' && !activeContact.email) {
      toast.error('Contact has no email address on file.');
      return;
    }
    setComposeChannelOverride(targetChannel);
  };

  // --- Bulk selection ----------------------------------------------------
  const handleToggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const handleSelectAll = (ids) => setSelectedIds(new Set(ids));
  const handleClearSelection = () => setSelectedIds(new Set());

  const handleBulkMarkRead = () => {
    dispatch({ type: ACTIONS.BULK_MARK_CONVERSATIONS_READ, ids: Array.from(selectedIds) });
  };
  const handleBulkMarkUnread = () => {
    dispatch({ type: ACTIONS.BULK_MARK_CONVERSATIONS_UNREAD, ids: Array.from(selectedIds) });
  };
  // Bulk hard-delete. Filters the selection to threads the current user is
  // permitted to hard-delete (creator or Super Admin) and pops a confirm
  // before doing anything destructive. If 0 threads are deletable we just
  // toast and bail without showing the dialog.
  const handleBulkDeleteRequest = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const eligible = [];
    const skipped = [];
    for (const id of ids) {
      const conv = state.conversations.find((c) => c.id === id);
      if (!conv) continue;
      const allowed = isSuperAdmin || (currentUser && conv.createdByUserId === currentUser.id);
      if (allowed) eligible.push(id); else skipped.push(id);
    }
    if (eligible.length === 0) {
      toast.error("You can't delete any of the selected threads — only their creators or a Super Admin can.");
      return;
    }
    setBulkDeletePrompt({ ids: eligible, skipped: skipped.length });
  };
  const handleBulkDeleteConfirm = () => {
    if (!bulkDeletePrompt) return;
    const { ids, skipped } = bulkDeletePrompt;
    dispatch({ type: ACTIONS.BULK_DELETE_CONVERSATIONS, ids });
    if (activeId && ids.includes(activeId)) {
      setActiveId(null);
      navigate('/messaging' + (selectedInbox !== 'inbox' ? `?inbox=${selectedInbox}` : ''));
    }
    setSelectedIds(new Set());
    setBulkDeletePrompt(null);
    if (skipped > 0) {
      toast.success(`Deleted ${ids.length} thread${ids.length === 1 ? '' : 's'}; skipped ${skipped} you couldn't delete.`);
    } else {
      toast.success(`Deleted ${ids.length} thread${ids.length === 1 ? '' : 's'} for everyone.`);
    }
  };

  return (
    <>
      <div className="messaging-wrap messaging-fullpage">
        <MessagingHeader
          selectedInbox={selectedInbox}
          onInboxChange={setSelectedInbox}
          unread={inboxUnread}
          filters={filters}
          onFiltersChange={setFilters}
          canStart={canStart}
          canStartInternalThread={canStartInternalThread}
          onNewConversation={() => setNewConvOpen(true)}
          onNewDm={() => setNewDmOpen(true)}
          onNewInternalThread={() => setNewInternalThreadOpen(true)}
          visibleInboxes={visibleInboxes}
        />
        <div
          className={`msg-3pane ${activeId ? 'has-active' : ''}`}
          ref={paneContainerRef}
          style={{ '--pane-left': `${panes.sizes.left}px`, '--pane-right': `${panes.sizes.right}px` }}
        >
          <ConversationThreadList
            conversations={visibleConversations}
            activeId={activeId}
            onSelect={handleSelect}
            search={search}
            onSearchChange={setSearch}
            totalBeforeFilter={inboxConversations.length}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onToggleStar={handleToggleStarRow}
            onBulkMarkRead={handleBulkMarkRead}
            onBulkMarkUnread={handleBulkMarkUnread}
            onBulkDelete={handleBulkDeleteRequest}
            canBulk={canBulk}
            selectedInbox={selectedInbox}
          />
          <div
            className={`msg-pane-handle msg-pane-handle-left ${panes.dragging === 'left' ? 'is-dragging' : ''}`}
            onPointerDown={panes.onDragStart('left')}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize thread list"
            title="Drag to resize"
          />
          <ConversationMessagePanel
            conversation={activeConversation}
            contact={activeContact}
            messages={activeMessages}
            currentUser={currentUser}
            isSuperAdmin={isSuperAdmin}
            onSend={handleSend}
            onDeleteForever={() => setConfirmDeleteOpen(true)}
            onSetStatus={handleSetStatus}
            onSnooze={handleSnooze}
            onToggleStar={handleToggleStarActive}
            onToggleMute={handleToggleMute}
            onBack={handleBackToInbox}
            connectedInboxes={myConnectedInboxes}
            defaultInboxId={myDefaultInbox?.id || null}
            emailBlockers={emailBlockers}
            onSwitchChannel={handleSwitchChannel}
            composeChannelOverride={composeChannelOverride}
          />
          <div
            className={`msg-pane-handle msg-pane-handle-right ${panes.dragging === 'right' ? 'is-dragging' : ''}`}
            onPointerDown={panes.onDragStart('right')}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize context panel"
            title="Drag to resize"
          />
          <ConversationContextPanel
            conversation={activeConversation}
            contact={activeContact}
            onLinkContact={handleLinkContact}
          />
        </div>
      </div>

      <NewConversationModal
        open={newConvOpen}
        onClose={() => setNewConvOpen(false)}
      />

      <NewDmModal
        open={newDmOpen}
        onClose={() => setNewDmOpen(false)}
      />

      <NewInternalThreadModal
        open={newInternalThreadOpen}
        onClose={() => setNewInternalThreadOpen(false)}
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Permanently delete this thread?"
        message={
          activeConversation
            ? `This permanently deletes the thread and all ${activeMessages.length} message${activeMessages.length === 1 ? '' : 's'} for everyone. This cannot be undone.`
            : 'This permanently deletes the thread and all of its messages for everyone. This cannot be undone.'
        }
        confirmLabel="Delete forever"
        variant="danger"
        onConfirm={handleHardDeleteConversation}
        onClose={() => setConfirmDeleteOpen(false)}
      />

      <ConfirmDialog
        open={!!bulkDeletePrompt}
        title={
          bulkDeletePrompt
            ? `Permanently delete ${bulkDeletePrompt.ids.length} thread${bulkDeletePrompt.ids.length === 1 ? '' : 's'}?`
            : 'Permanently delete threads?'
        }
        message={
          bulkDeletePrompt
            ? `This permanently deletes ${bulkDeletePrompt.ids.length} selected thread${bulkDeletePrompt.ids.length === 1 ? '' : 's'} and every message in them, for everyone. This cannot be undone.${bulkDeletePrompt.skipped ? ` ${bulkDeletePrompt.skipped} other thread${bulkDeletePrompt.skipped === 1 ? '' : 's'} you can't delete will be skipped.` : ''}`
            : ''
        }
        confirmLabel="Delete forever"
        variant="danger"
        onConfirm={handleBulkDeleteConfirm}
        onClose={() => setBulkDeletePrompt(null)}
      />
    </>
  );
}
