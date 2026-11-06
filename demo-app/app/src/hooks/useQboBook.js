import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './useAuth';
import { useSelector } from '../store';
import { selectClients, selectUsers } from '../store/selectors';
import { usePermission } from './usePermission';
import { getQboStatus, getQboPnl } from '../lib/qboApi';
import { buildPreviewBook, buildLiveBook, qboFirstPaintPhase } from '../lib/qboView';
import { RANGES, WINDOWS, DEFAULT_WINDOW } from '../data/dashboardLayoutPreview';

// The account-book dashboard's data source. Decision 3: with QuickBooks NOT connected (or the
// caller lacking financials.view) the home stays exactly as today — the design-phase preview
// layouts, no banner (CS-013). Once connected it shows ONLY live, linked properties in the
// caller's scope (the empty state is the caller's to render). The MAIN view is the chosen
// PERIOD (the dashboard's picker, `?window=`: this month, 30 / 60 / 90 days, 12 months, a
// calendar month or a span of dates — lib/pnlRange.js); the drill-in's
// "Revenue by range" bars fetch their ranges LAZILY after the main view paints (decision 3).
const BAR_RANGES = RANGES.map((r) => r.key);
const WINDOW_KEYS = WINDOWS.map((w) => w.key);
const ALL_KEYS = [...new Set([...BAR_RANGES, ...WINDOW_KEYS])];

// Session (in-memory) cache of the last good P&L per (authenticated user, range) — II.7 /
// decision 7: re-visits paint instantly and refresh in the background. Keyed by the
// AUTHENTICATED user because the server always answers with the real caller's scope (view-as
// is applied client-side, below), so the raw response is the same whoever we are viewing as.
// Financial figures are NEVER persisted to localStorage/IndexedDB — this Map dies with the tab.
const pnlCache = new Map();
const cacheKey = (uid, range) => `${uid || 'anon'}:${range}`;

// C3: a NON-SENSITIVE per-user hint of the last-known QBO connection state (a boolean-ish
// string, never any figure), so the FIRST paint is chosen without waiting on getQboStatus
// (II.7 cache-first). Every access is guarded — private mode / cleared storage must not throw.
const CONN_FLAG_PREFIX = 'cleanspace_qbo_conn_v1:';
function readLastKnownConnected(uid) {
  try { return localStorage.getItem(CONN_FLAG_PREFIX + (uid || 'anon')) === '1'; } catch { return false; }
}
function writeLastKnownConnected(uid, connected) {
  try { localStorage.setItem(CONN_FLAG_PREFIX + (uid || 'anon'), connected ? '1' : '0'); } catch { /* private mode / quota */ }
}

export function useQboBook({ window: mainRange = DEFAULT_WINDOW } = {}) {
  const { currentUser, authenticatedUser } = useAuth();
  const clients = useSelector(selectClients);
  const users = useSelector(selectUsers);
  const hasFinancials = usePermission('financials.view');
  const authUserId = authenticatedUser?.id || currentUser?.id || null;

  // C3: the FIRST paint is chosen from the last-known connection flag (cache-first, II.7): a
  // not-connected / unknown user paints the preview instantly, only a last-known-connected user
  // opens on the skeleton. load() then reconciles against the real status.
  const [phase, setPhase] = useState(() => qboFirstPaintPhase({
    hasFinancials, lastKnownConnected: readLastKnownConnected(authUserId),
  })); // preview | live-loading | live | error
  const [status, setStatus] = useState(null);
  const [pnlByRange, setPnlByRange] = useState({});
  const [error, setError] = useState(null);
  // Monotonic token so a slow response from a superseded load can't overwrite the current one
  // (3.8.14 — ignore stale async).
  const tokenRef = useRef(0);
  // The window at the moment load() runs (load is not re-created per window: switching windows
  // fetches only the window, below, never the status and the bars again).
  const mainRef = useRef(mainRange);
  useEffect(() => { mainRef.current = mainRange; }, [mainRange]);
  // Which `${token}:${range}` fetches this load has started, so a window is asked for once.
  const requested = useRef(new Set());

  const load = useCallback(async () => {
    const token = (tokenRef.current += 1);
    const main = mainRef.current;
    setError(null);
    let st;
    try { st = await getQboStatus(); } catch (e) {
      if (token !== tokenRef.current) return;
      setStatus(null); setError(e); setPhase('error'); return;
    }
    if (token !== tokenRef.current) return;
    setStatus(st);

    // Preview fallback: not configured, not connected, or no financial visibility. The home
    // page is unchanged from today (decision 3).
    if (!st.configured || !st.connected || !hasFinancials) {
      writeLastKnownConnected(authUserId, false); // C3: clears the flag (also covers disconnect)
      setPnlByRange({}); setPhase('preview'); return;
    }

    // Cache-first paint: seed every cached range so a revisit paints instantly and complete,
    // then refresh in the background (II.7).
    writeLastKnownConnected(authUserId, true); // C3: remember this user renders the live book
    const seeded = {};
    for (const r of new Set([...ALL_KEYS, main])) { const c = pnlCache.get(cacheKey(authUserId, r)); if (c) seeded[r] = c; }
    setPnlByRange(seeded);
    setPhase(seeded[main] ? 'live' : 'live-loading');

    // Foreground: the chosen window.
    requested.current.add(`${token}:${main}`);
    let resp;
    try { resp = await getQboPnl(main); } catch (e) {
      if (token !== tokenRef.current) return;
      if (seeded[main]) return; // keep the cached book; drop the failed refresh
      setError(e); setPhase('error'); return;
    }
    if (token !== tokenRef.current) return;
    if (!resp || resp.connected === false) { writeLastKnownConnected(authUserId, false); setPnlByRange({}); setPhase('preview'); return; }
    pnlCache.set(cacheKey(authUserId, main), resp);
    setPnlByRange((prev) => ({ ...prev, [main]: resp }));
    setPhase('live');

    // Background: the drill-in bars (decision 3). A range that fails just stays muted.
    for (const r of BAR_RANGES) {
      if (r === main) continue;
      requested.current.add(`${token}:${r}`);
      getQboPnl(r).then((got) => {
        if (token !== tokenRef.current || !got || got.connected === false) return;
        pnlCache.set(cacheKey(authUserId, r), got);
        setPnlByRange((prev) => ({ ...prev, [r]: got }));
      }).catch(() => { /* muted bar */ });
    }
  }, [authUserId, hasFinancials]);

  useEffect(() => { load(); }, [load]);

  // A window chosen once the book is live and not fetched yet: ask for it alone. The book on
  // screen stays (labelled with ITS window) until the new one lands — no skeleton between
  // windows. A failure is the error state, with Try again (refresh → load).
  useEffect(() => {
    if (phase !== 'live' || pnlByRange[mainRange]) return;
    const token = tokenRef.current;
    const tag = `${token}:${mainRange}`;
    if (requested.current.has(tag)) return;
    requested.current.add(tag);
    getQboPnl(mainRange).then((got) => {
      if (token !== tokenRef.current || !got || got.connected === false) return;
      pnlCache.set(cacheKey(authUserId, mainRange), got);
      setPnlByRange((prev) => ({ ...prev, [mainRange]: got }));
    }).catch((e) => {
      if (token !== tokenRef.current) return;
      setError(e); setPhase('error');
    });
  }, [mainRange, phase, pnlByRange, authUserId]);

  // The period whose figures are on screen: the chosen one, else (while it loads) the one shown
  // last, else the first window that has figures. The book carries ITS range and dates, so every
  // label matches its numbers.
  const [lastShown, setLastShown] = useState(null);
  useEffect(() => { if (pnlByRange[mainRange]) setLastShown(mainRange); }, [pnlByRange, mainRange]);
  const shownPnl = pnlByRange[mainRange] || (lastShown && pnlByRange[lastShown])
    || WINDOW_KEYS.map((k) => pnlByRange[k]).find(Boolean) || null;

  // Build the book to render. Live once a window has figures; preview otherwise. The book is
  // re-derived (and re-SCOPED to the viewed-as perspective) whenever pnlByRange or currentUser
  // changes, with no re-fetch — view-as is display-only (decision 8).
  const book = useMemo(() => {
    if ((phase === 'live' || phase === 'live-loading') && shownPnl) {
      const rangeRevenueByClient = {};
      for (const [rk, resp] of Object.entries(pnlByRange)) {
        for (const a of (resp.accounts || [])) {
          (rangeRevenueByClient[a.clientId] || (rangeRevenueByClient[a.clientId] = {}))[rk] = a.incomeCents;
        }
      }
      return buildLiveBook(shownPnl, { clients, users, currentUser, rangeRevenueByClient });
    }
    return buildPreviewBook(mainRange);
  }, [phase, shownPnl, pnlByRange, clients, users, currentUser, mainRange]);

  // 'live-loading' with figures already in hand renders as live; with none, the skeleton.
  const uiPhase = (phase === 'live-loading' && shownPnl) ? 'live' : phase;
  // True while the chosen window is still on its way (the toggle says so).
  const updating = uiPhase === 'live' && !pnlByRange[mainRange];
  return { phase: uiPhase, book, status, error, refresh: load, updating };
}

export default useQboBook;
