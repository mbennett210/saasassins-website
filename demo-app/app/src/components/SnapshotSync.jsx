// Headless: pulls the external financial snapshot (pushed by the Google Sheet
// via the inbound webhook) into the store so the Dashboard Financial Snapshot
// can render it as source of truth. Polls on mount + interval + focus.
import { useEffect, useRef } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { getSnapshot } from '../lib/integrationsApi';

const POLL_MS = 60000;

// A refusal is not a transient failure, so it must not be retried every 60 s for the life
// of the tab (CS-019: /api/settings/snapshot now gates on `invoices.view`). App.jsx only
// mounts this for holders, so reaching one of these means the permission was revoked
// mid-session — stop cleanly and keep whatever figure is already in the store.
const REFUSED_STATUSES = new Set([401, 403]);

// Change detection for the poll. The snapshot is the same object shape every tick
// (a server-serialized JSON), so string compare is a reliable "did it actually change".
const serialize = (v) => { try { return JSON.stringify(v ?? null); } catch { return null; } };

export default function SnapshotSync() {
  const dispatch = useDispatch();
  const store = useStore();
  // Live ref to the snapshot currently in the store, so the poll can compare against it
  // without the effect re-subscribing (the effect owns the interval and runs once).
  const currentRef = useRef();
  currentRef.current = store.financialSnapshot;

  useEffect(() => {
    let alive = true;
    let stop = () => {};
    async function pull() {
      try {
        const snapshot = await getSnapshot();
        if (!alive) return;
        const next = snapshot || null;
        // Only write when the value ACTUALLY changed. Dispatching an unchanged snapshot
        // bumps the shared org_state version and fans a Realtime signal out to every
        // connected client — every 60s, per idle tab. That idle write was the single
        // largest contributor to the Realtime-message overage (~a third of it), so guard
        // it at the source. (sync.js's flush content-guard is the systemic backstop.)
        if (serialize(next) === serialize(currentRef.current)) return;
        dispatch({ type: ACTIONS.SET_FINANCIAL_SNAPSHOT, snapshot: next });
      } catch (err) {
        // A refusal stops the poll for good; anything else is transient — keep last value.
        if (REFUSED_STATUSES.has(err?.status)) stop();
      }
    }
    pull();
    const t = setInterval(pull, POLL_MS);
    const onFocus = () => pull();
    window.addEventListener('focus', onFocus);
    stop = () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
    return () => { alive = false; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
