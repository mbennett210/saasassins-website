// Polls the backend inbound endpoint and routes each buffered reply so it's
// handled exactly once:
//   • landed on a per-user personal inbox (Settings → Connected Inboxes)
//     → RECEIVE_EMAIL: threads into the 1:1 Messaging conversation
//   • anything else (the shared marketing rotation inboxes, or unknown)
//     → RECEIVE_MARKETING_REPLY: correlates to an enrollment, halts the drip,
//       routes the contact — exactly as before.
// Personal and marketing inboxes are always distinct addresses, so the
// `toInboxEmail` the backend records on each reply is an unambiguous router —
// no fragile Message-ID matching needed.
//
// Replaces the marketing-only listener. Dev (stub mode, no VITE_EMAIL_BACKEND_URL):
// no-op — marketing replies are exercised via the "Simulate a reply" affordance
// on the Marketing → Replies tab.
//
// One fixed 60s tick (the backend self-throttles its own Gmail polling). The
// cursor (last inbound `seq` seen) is persisted so a reload doesn't replay.

import { useEffect, useRef } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { pollInbound, INBOX_BACKEND_URL } from '../lib/connectedInboxes';

// Key unchanged from the former marketing-only listener so live deployments
// resume from their existing cursor instead of replaying buffered mail.
const CURSOR_KEY = 'pp.marketing.inboundCursor';
const POLL_MS = 60 * 1000;

export default function InboundListener() {
  const dispatch = useDispatch();
  const state = useStore();
  const stateRef = useRef(state);
  stateRef.current = state;
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

        // Addresses of the personal mailboxes. Mail that landed on one of
        // these belongs in a 1:1 Messaging thread; everything else is a reply
        // to a shared marketing send. The set comes from the SERVER (the
        // inbox_accounts table, piggybacked on the poll response) — the blob's
        // connectedInboxes was EMPTY in prod, so this fork matched nothing and
        // diverted every inbound message to marketing (the 2026-06-21
        // Messaging blackout). Blob fallback only for an older-deploy server
        // response that omits the field.
        const personalInboxes = new Set(
          (Array.isArray(res.personalInboxes) && res.personalInboxes.length
            ? res.personalInboxes
            : (stateRef.current.connectedInboxes || []).map((i) => i.email))
            .map((e) => (e || '').toLowerCase())
            .filter(Boolean)
        );

        for (const email of res.emails) {
          const landedOn = (email.toInboxEmail || '').toLowerCase();
          if (landedOn && personalInboxes.has(landedOn)) {
            dispatch({
              type: ACTIONS.RECEIVE_EMAIL,
              messageId: email.messageId || undefined,
              fromEmail: email.fromEmail,
              toInboxEmail: email.toInboxEmail,
              subject: email.subject,
              body: email.body,
              inReplyTo: email.inReplyTo,
              references: email.references,
              receivedAt: email.receivedAt || undefined,
            });
          } else {
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
