// The cleaner's supplies line (Matt, SUP-16 a, 2026-10-12: "so the supplies disappear from the
// cleaners' app … so they know the supplies are on property"; plan 2026-10-12 §2, S6): ONE read per
// screen of GET /api/supplies/onsite — the buildings the viewer cleans TODAY, PER LINE since S131
// Builder C: what was delivered today, what is backordered (with the supplier's day) and what is on
// its way (names and quantities only; the route is self-scoped to the caller's own cleans).
// → a Map, clientId → { clientId, delivered, backordered, onTheWay } (lib/supplies supplyCrewBuildings).
//
// Best-effort, like a note: no signal or a failed read shows no line, never an error — the clean
// card is the work. It reads again when the phone comes back online or the screen comes back into
// view (a driver may have dropped the supplies off since), and NOT on every store dispatch: My Day
// is the crew's home screen and subscribes per value (§8 0.4), so the demo stub's store snapshot is
// read imperatively, at fetch time (useGetState).
import { useEffect, useState } from 'react';
import { useGetState } from '../store';
import { useAuth } from './useAuth';
import * as suppliesApi from '../lib/suppliesApi';

export function useOnsiteSupplies() {
  const getState = useGetState();
  const { currentUser } = useAuth();
  const userId = currentUser?.id || null;
  const [byClient, setByClient] = useState(() => new Map());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const onVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') again(); };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    suppliesApi.onsite({ state: getState(), user: currentUser })
      .then((r) => { if (live) setByClient(new Map(((r && r.buildings) || []).map((b) => [b.clientId, b]))); })
      .catch(() => { /* best-effort: the line simply does not show */ });
    return () => { live = false; };
    // currentUser is read for the demo stub only; the identity that matters is userId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, tick, getState]);

  return byClient;
}
