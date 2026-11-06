// Polls the backend inbound endpoint and files each buffered email the server hasn't threaded:
// RECEIVE_EMAIL for one that landed on a personal inbox (a 1:1 Messaging thread),
// RECEIVE_MARKETING_REPLY for anything else (halts the drip, routes the contact). The decision
// is lib/inboundCursor.js `inboundActions`, shared with the offline suite.
//
// Replaces the marketing-only listener. Dev (stub mode, no VITE_EMAIL_BACKEND_URL):
// no-op — marketing replies are exercised via the "Simulate a reply" affordance
// on the Marketing → Replies tab.
//
// One fixed 60s tick (the backend self-throttles its own Gmail polling). The
// cursor (last inbound `seq` seen) is persisted so a reload doesn't replay.
//
// 🔴 NEVER AT OR BELOW THE SERVER'S CURSOR (CS-968). The ingest cron threads every buffered email
// into the record in the run that buffered it and stores how far it got (`inboundIngestSeq`).
// This tab polls from the later of its own cursor and that one (`pollFrom`), files nothing at or
// below it, and passes each email's `seq` to the reducer, which checks it again against the state
// it lands on. Before, a browser polling from 0 (a new phone on the shared login) filed again a
// reply whose thread had been deleted.

import { useEffect, useRef } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { pollInbound, INBOX_BACKEND_URL } from '../lib/connectedInboxes';
import { inboundActions, pollFrom } from '../lib/inboundCursor.js';

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
        const res = await pollInbound(pollFrom(cursorRef.current, stateRef.current));
        if (cancelled || !res || !Array.isArray(res.emails)) return;

        for (const action of inboundActions(res, stateRef.current, ACTIONS)) dispatch(action);

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
