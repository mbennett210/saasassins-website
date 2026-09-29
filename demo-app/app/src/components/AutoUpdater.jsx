// Gentle self-update. Polls the deployed index.html for a changed asset hash and,
// when a new build is live, reloads the tab so rollout changes (e.g. the jobs
// migration stages) reach everyone within minutes — no one has to hit refresh.
//
// "Gentle" = it only reloads when it's safe and unobtrusive:
//   • the shared store is fully 'synced' (no pending unsaved change), AND
//   • the tab is backgrounded OR the user has been idle a moment,
//   • and never twice within a cooldown (hard guard against reload loops).
//
// It also checks the moment the app comes back to the foreground (and on a back/forward-
// cache restore), not just on the 3-minute poll: an installed PWA resumed after a deploy
// is still running the old build, whose page chunks the new deploy no longer serves, so
// its first tap on an unvisited tab would fail. Time spent in the background counts as
// idle, so after more than a minute away it refreshes before the first tap; a quicker
// return falls back to lib/staleBuild's recover-on-failure.
import { useEffect, useRef } from 'react';
import { useSyncStatus } from '../store';

const POLL_MS = 3 * 60 * 1000;      // check for a new build every 3 minutes
const IDLE_MS = 60 * 1000;          // "idle" = 1 minute since last pointer/key input
const COOLDOWN_MS = 2 * 60 * 1000;  // never auto-reload twice within 2 min (loop guard)

// Signature of the build = the sorted set of hashed /assets/*.{js,css} URLs that the
// deployed index.html references. Changes whenever a new build is deployed.
async function fetchAssetSig() {
  try {
    const res = await fetch(`/index.html?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    const set = new Set();
    const re = /\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g;
    let m;
    while ((m = re.exec(html))) set.add(m[0]);
    return set.size ? [...set].sort().join(',') : null;
  } catch {
    return null;
  }
}

export default function AutoUpdater() {
  const syncStatus = useSyncStatus();
  const syncRef = useRef(syncStatus);
  useEffect(() => { syncRef.current = syncStatus; }, [syncStatus]);

  const mySig = useRef(null);
  const updateReady = useRef(false);
  const lastInteract = useRef(Date.now());

  useEffect(() => {
    let alive = true;
    const bump = () => { lastInteract.current = Date.now(); };
    window.addEventListener('pointerdown', bump, { passive: true });
    window.addEventListener('keydown', bump, { passive: true });

    const canReload = () => {
      if (!updateReady.current) return false;
      if (syncRef.current !== 'synced') return false;                       // nothing pending
      const last = Number(sessionStorage.getItem('rfs.autoreload') || 0);
      if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) return false; // loop guard
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const idle = Date.now() - lastInteract.current > IDLE_MS;
      return hidden || idle;
    };
    const maybeReload = () => {
      if (!canReload()) return;
      try { sessionStorage.setItem('rfs.autoreload', String(Date.now())); } catch { /* ignore */ }
      window.location.reload();
    };

    // Establish the current build's signature (the one this tab is running).
    (async () => { mySig.current = await fetchAssetSig(); })();

    const check = async () => {
      if (!alive) return;
      const latest = await fetchAssetSig();
      if (!alive || !latest) return;
      if (mySig.current == null) { mySig.current = latest; return; }
      if (latest !== mySig.current) { updateReady.current = true; maybeReload(); }
    };
    const poll = setInterval(check, POLL_MS);

    const idleTimer = setInterval(maybeReload, IDLE_MS);
    const onVis = () => {
      if (document.visibilityState === 'hidden') maybeReload();
      else check(); // back in the foreground: a deploy may have landed while we were away
    };
    const onPageShow = (e) => { if (e.persisted) check(); }; // restored from the bf-cache
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(idleTimer);
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  return null;
}
