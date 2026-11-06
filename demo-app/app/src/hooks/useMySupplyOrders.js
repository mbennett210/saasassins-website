// The cleaner's newest supply orders, read once and shared (S131 Builder C; Matt's Cleaner Hub board:
// Home's "Request Supplies" tile reads "#SO-1047 · partial"). ONE light read — GET
// /api/supplies/crew-orders (EP-401: no list, no photo links) — through the shared-read cache
// (hooks/useSharedRead over lib/sharedRead), never a read per render: Home asks on a page view (an
// answer younger than half a minute is reused) and when the window comes back into focus, joins a read
// already in flight, and paints the last answer at once. The Request Supplies page reads it again the
// moment an order lands (refreshMySupplyOrders), so the tile names it when the cleaner gets back.
//
// The person is the one on screen (hooks/useCrewPreview): the owner's View-as names them, which the
// server honours only with supplies.view. BEST-EFFORT: with no signal or a failed read the tile keeps
// saying "Order supplies" — it is a way in, never a status that must load.
import { useSharedRead } from './useSharedRead';
import { useCrewPreview } from './useCrewPreview';
import { useOnlineStatus } from './useOnlineStatus';
import { usePermission } from './usePermission';
import { useAuth } from './useAuth';
import { useGetState } from '../store';
import { refreshShared } from '../lib/sharedRead';
import * as suppliesApi from '../lib/suppliesApi';

// The cache key carries whose orders they are, so one person's answer is never another's.
const keyOf = (previewing, userId) => `crewSupplyOrders|${previewing ? 'preview' : 'self'}|${userId || ''}`;
// The read itself. `ctx` is read by the demo stub only (the server reads the login's claim).
const readerOf = ({ previewing, userId, ctx }) => () => suppliesApi.crewOrders({ userId: previewing ? userId : null }, ctx);

// Home's tile: the cleaner's newest order (the crew shape, lib/supplies supplyCrewOrder), or null —
// none yet, not known yet, or the read failed.
export function useMyLastSupplyOrder({ enabled = true } = {}) {
  const { previewing, userId } = useCrewPreview();
  const online = useOnlineStatus();
  const getState = useGetState();
  const { currentUser } = useAuth();
  const canRequest = usePermission('supplies.request');
  const canView = usePermission('supplies.view');
  const r = useSharedRead(keyOf(previewing, userId), () => readerOf({
    previewing, userId, ctx: { state: getState(), user: currentUser, holds: { request: canRequest, view: canView } },
  })(), { enabled: enabled && !!userId, paused: !online, maxAgeMs: 30000 });
  const orders = r.data && Array.isArray(r.data.orders) ? r.data.orders : [];
  return orders[0] || null;
}

// Read again NOW, for whoever is on screen — the Request Supplies page, once an order lands.
export function refreshMySupplyOrders({ previewing = false, userId = null, ctx = null } = {}) {
  if (!userId) return Promise.resolve(null);
  return refreshShared(keyOf(previewing, userId), readerOf({ previewing, userId, ctx }), { maxAgeMs: 0 });
}
