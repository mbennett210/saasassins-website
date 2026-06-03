// ─────────────────────────────────────────────────────────────────────────────
// Reminder scheduler — auto-fires Core reminders on job lifecycle.
//
// Mounted once at app root. It:
//   1. Re-evaluates due reminders whenever state.jobs / state.reminderEvents /
//      state.reminderTemplates / state.company.integrations changes.
//   2. Ticks every 60 seconds to catch time-based windows (24h, day-of) when
//      state hasn't changed.
//   3. For each due reminder: dispatches ADD_REMINDER_EVENT with status='pending',
//      then calls the matching delivery adapter (lib/twilio.sendSMS for sms,
//      lib/email.sendEmail for email) and dispatches UPDATE_REMINDER_EVENT
//      with the resolved status ('sent' or 'failed') + provider message id /
//      failureReason as appropriate.
//
// Dedup is handled by the scheduler library: hasFired() in
// lib/reminderScheduler.js — once an event exists for (templateKey, jobId),
// the same template won't re-fire for that job. This makes the component safe
// to re-run on every render: extra ticks are no-ops.
//
// Production: when VITE_TWILIO_BACKEND_URL / VITE_EMAIL_BACKEND_URL are set,
// the adapters call the real backends. Otherwise stub mode simulates timings.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { getDueReminders } from '../lib/reminderScheduler';
import { sendSMS } from '../lib/twilio';
import { sendEmail } from '../lib/email';

const TICK_MS = 60 * 1000;

// Module-level in-flight guard. Persists across React.StrictMode's
// dev-only double-mount cycle (a useRef would be reset on remount, allowing
// a duplicate fire in the brief window before the first dispatch lands in
// state). Once a (templateKey, jobId) is added it is NEVER deleted — that
// would race with synchronous failure paths that finalize before state
// propagates. Permanent-per-session dedup is fine because state-based
// hasFired() covers refires after a reload.
const inFlight = new Set();

export default function ReminderScheduler() {
  const state = useStore();
  const dispatch = useDispatch();

  // Latest state ref — the interval callback below needs fresh state without
  // re-creating the interval on every render.
  const stateRef = useRef(state);
  stateRef.current = state;

  function fireOne(due) {
    const key = `${due.template.key}::${due.job.id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    // Step 1: record the event in 'pending' state immediately so it appears
    // in the Delivery Inbox during the brief window before the adapter resolves.
    const eventId = `re_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dispatch({
      type: ACTIONS.ADD_REMINDER_EVENT,
      event: {
        id: eventId,
        templateKey: due.template.key,
        jobId: due.job.id,
        clientId: due.client.id,
        channel: due.channel,
        status: 'pending',
        recipient: due.recipient,
        body: due.body,
        subject: due.subject || null,
      },
    });

    // Step 2: deliver via the right adapter. If the channel can't deliver
    // (no recipient, no Twilio number, etc.), mark as failed with a clear reason.
    const finalize = (patch) => {
      dispatch({ type: ACTIONS.UPDATE_REMINDER_EVENT, id: eventId, patch });
      // NOTE: do NOT delete from inFlight. See module-top comment.
    };

    if (!due.recipient) {
      finalize({
        status: 'failed',
        failureReason: due.channel === 'sms'
          ? 'No phone number on client/contact'
          : 'No email address on client/contact',
      });
      return;
    }

    if (due.channel === 'sms') {
      const twilio = stateRef.current.company?.integrations?.twilio;
      if (!twilio?.connected) {
        finalize({ status: 'failed', failureReason: 'Twilio not connected' });
        return;
      }
      if (!twilio.phoneNumber) {
        finalize({ status: 'failed', failureReason: 'No Twilio number provisioned' });
        return;
      }
      if (twilio.a2p?.status !== 'approved') {
        finalize({
          status: 'failed',
          failureReason: `A2P 10DLC not approved (status: ${twilio.a2p?.status || 'not_started'})`,
        });
        return;
      }
      sendSMS({ from: twilio.phoneNumber, to: due.recipient, body: due.body })
        .then((res) => finalize({ status: 'sent', providerMessageId: res.sid }))
        .catch((err) => finalize({ status: 'failed', failureReason: err.message || 'SMS send error' }));
      return;
    }

    if (due.channel === 'email') {
      sendEmail({
        to: due.recipient,
        from: due.fromEmail || 'no-reply@example.com',
        subject: due.subject || '(no subject)',
        body: due.body,
      })
        .then((res) => finalize({ status: 'sent', providerMessageId: res.id }))
        .catch((err) => finalize({ status: 'failed', failureReason: err.message || 'Email send error' }));
      return;
    }

    finalize({ status: 'failed', failureReason: `Unsupported channel: ${due.channel}` });
  }

  // Re-evaluate on state change. dispatchDue() walks the due list and fires
  // each reminder; in-flight + already-fired guards prevent duplicates.
  useEffect(() => {
    const due = getDueReminders(stateRef.current, new Date());
    due.forEach(fireOne);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.jobs,
    state.reminderEvents,
    state.reminderTemplates,
    state.company?.integrations?.twilio?.connected,
    state.company?.integrations?.twilio?.a2p?.status,
  ]);

  // Tick every 60s for time-based windows (24h, day-of) when state is idle.
  useEffect(() => {
    const id = setInterval(() => {
      const due = getDueReminders(stateRef.current, new Date());
      due.forEach(fireOne);
    }, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
