// Production: polls the backend's inbound endpoint and feeds marketing replies
// into the store as RECEIVE_MARKETING_REPLY dispatches — the reducer correlates
// each to an enrollment, records it in marketingReplies, halts the drip when
// the sequence opts in, and routes the contact. Dev (stub mode, no
// VITE_EMAIL_BACKEND_URL): resolves to a no-op — replies are exercised via the
// "Simulate a reply" affordance on the Marketing → Replies tab.
//
// The backend self-throttles its own Gmail polling, so a fixed 60s tick here
// is safe. The cursor (last inbound `seq` seen) is persisted in localStorage
// so a reload doesn't replay already-dispatched replies.

import { useEffect, useRef } from 'react';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { pollInbound, INBOX_BACKEND_URL } from '../lib/connectedInboxes';

const CURSOR_KEY = 'pp.marketing.inboundCursor';
const POLL_MS = 60 * 1000;

export default function MarketingInboundListener() {
  const dispatch = useDispatch();
  const cursorRef = useRef(Number(localStorage.getItem(CURSOR_KEY)) || 0);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!INBOX_BACKEND_URL) return undefined; // stub mode — nothing to poll

    let cancelled = false;

    async function tick() {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const res = await pollInbound(cursorRef.current);
        if (cancelled || !res || !Array.isArray(res.emails)) return;
        for (const email of res.emails) {
          dispatch({
            type: ACTIONS.RECEIVE_MARKETING_REPLY,
            id: email.messageId || undefined,
            enrollmentId: email.enrollmentId || null,
            fromEmail: email.fromEmail,
            subject: email.subject,
            body: email.body,
            receivedAt: email.receivedAt || undefined,
          });
        }
        if (typeof res.cursor === 'number' && res.cursor > cursorRef.current) {
          cursorRef.current = res.cursor;
          localStorage.setItem(CURSOR_KEY, String(res.cursor));
        }
      } catch {
        // Transient — the next tick retries.
      } finally {
        busyRef.current = false;
      }
    }

    tick();
    const intervalId = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [dispatch]);

  return null;
}
