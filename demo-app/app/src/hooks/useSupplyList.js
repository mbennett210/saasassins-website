// One building's supply list, read once for the customer page (round 3, 2026-10-06): the
// Supplies tab's count and the tab itself share this read, so the number on the tab is the
// number of rows in it. `history` asks the server for each item's last delivery, its quantity
// and the last 90 days' total (GET /api/supplies/items?history=1).
//
// A list that has not loaded is `null`, never `[]`: an empty list is a real answer ("no supply
// list yet") and must not show while the read is still out, or when it failed (UI_RULES §117).
// Only a `supplies.view` holder asks (`enabled`); the route refuses anyone else.
import { useCallback, useEffect, useState } from 'react';
import * as suppliesApi from '../lib/suppliesApi';

export function useSupplyList(clientId, { enabled = true, history = false } = {}) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !clientId) { setItems(null); setError(null); return undefined; }
    let live = true;
    setError(null);
    suppliesApi.listItems(clientId, { history })
      .then((list) => { if (live) setItems(list || []); })
      .catch((e) => { if (live) { setItems(null); setError(e); } });
    return () => { live = false; };
  }, [clientId, enabled, history, tick]);
  return { items, error, reload };
}
