// NotificationListener — watches state for events the current viewer cares about
// and surfaces them as (a) a transient toast and (b) a browser-tab title badge.
//
// Persistent in-app notifications (the bell inbox) are NOT written here —
// the reducer's ADD_MESSAGE / job / invoice cases stamp those per-recipient at
// action time so switching users surfaces the right inbox. This component is
// a viewer-only side-effect surface.
//
// Sources of truth:
//   - lib/notifications.js for the catalog + the resolveMessageEvent helper.
//   - user.notificationPrefs for the current user's per-event opt-ins.
//   - conversation.mutedByUserIds for per-thread silence (handled inside
//     resolveMessageEvent).
//
// First-render guard: the listener seeds its "seen" sets from initial state on
// mount so we don't toast for everything that existed before the user opened
// the page. Only items added after mount fire.

import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { useToast } from './Toast';
import { setUnreadCount } from '../lib/documentTitle';
import {
  isNotificationVisibleForUser,
  resolveMessageEvent,
  previewMessageBody,
  buildMessageNotificationTitle,
} from '../lib/notifications';
import { selectUnreadNotificationCount } from '../store/selectors';

export default function NotificationListener() {
  const state = useStore();
  const toast = useToast();
  const seedRef = useRef(null);

  // Tab title — driven by the persistent notification-inbox unread count for
  // the current user. Same source the bell badge uses, so they always agree.
  const totalUnread = selectUnreadNotificationCount(state, state.currentUserId);
  useEffect(() => { setUnreadCount(totalUnread); }, [totalUnread]);

  useEffect(() => {
    const currentUser = state.users.find((u) => u.id === state.currentUserId);
    if (!currentUser) return;
    const prefs = currentUser.notificationPrefs || {};

    // First mount — and also when the viewer changes (different currentUserId)
    // we re-seed so we don't blast toasts for the new user's existing history.
    if (!seedRef.current || seedRef.current.userId !== currentUser.id) {
      seedRef.current = {
        userId: currentUser.id,
        msgIds: new Set(state.messages.map((m) => m.id)),
        jobs: new Map(state.jobs.map((j) => [j.id, { startAt: j.startAt, status: j.status }])),
        invoices: new Map(state.invoices.map((i) => [i.id, i.status])),
      };
      return;
    }

    const convById = new Map(state.conversations.map((c) => [c.id, c]));

    const toastFor = (eventKey, { title, body }) => {
      if (prefs[eventKey] !== true) return;
      if (!isNotificationVisibleForUser(eventKey, currentUser, state.permissions, state.userPermissionOverrides)) return;
      toast.info(body ? `${title}: ${body}` : title);
    };

    // ----- Messages -----
    for (const m of state.messages) {
      if (seedRef.current.msgIds.has(m.id)) continue;
      seedRef.current.msgIds.add(m.id);
      const conv = convById.get(m.conversationId);
      const eventKey = resolveMessageEvent(m, conv, currentUser.id);
      if (!eventKey) continue;
      const title = buildMessageNotificationTitle(eventKey, m, conv, state.users);
      toastFor(eventKey, { title, body: previewMessageBody(m.body || m.text) });
    }

    // ----- Jobs -----
    const seenJobs = seedRef.current.jobs;
    for (const j of state.jobs) {
      const prior = seenJobs.get(j.id);
      seenJobs.set(j.id, { startAt: j.startAt, status: j.status });
      if (!(j.crewIds || []).includes(currentUser.id)) continue;

      if (!prior) {
        toastFor('jobCreatedOrRescheduled', {
          title: 'New job assigned to you',
          body: j.startAt ? new Date(j.startAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '',
        });
        continue;
      }
      if (prior.startAt !== j.startAt) {
        toastFor('jobCreatedOrRescheduled', {
          title: 'Job rescheduled',
          body: `Now ${new Date(j.startAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`,
        });
      }
      if (prior.status !== j.status && j.status === 'cancelled') {
        toastFor('jobCancelled', { title: 'A job you were on was cancelled', body: '' });
      }
    }

    // ----- Invoices -----
    const seenInv = seedRef.current.invoices;
    for (const inv of state.invoices) {
      const priorStatus = seenInv.get(inv.id);
      seenInv.set(inv.id, inv.status);
      if (priorStatus === inv.status) continue;
      if (priorStatus === undefined) continue;
      const label = inv.number || inv.id;
      if (inv.status === 'paid') toastFor('invoicePaid', { title: `Invoice ${label} paid`, body: '' });
      if (inv.status === 'overdue') toastFor('invoiceOverdue', { title: `Invoice ${label} is overdue`, body: '' });
    }
  }, [state, toast]);

  return null;
}
