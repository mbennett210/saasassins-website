import { assetUrl } from './assetUrl.js'; // polishpoint-demo
// staleBuild.js — what to do when an on-demand chunk (a page, a lazy library) fails to load.
//
// TWO CAUSES, OPPOSITE CURES.
//   · A STALE BUILD. Every page is its own chunk with a content-hashed file name, and a deploy
//     replaces all of them. A tab still running the previous build (an installed PWA resumed
//     from the background, a tab left open overnight) asks for chunk names the new deploy no
//     longer has. The cure is a reload — the fresh index.html names the fresh chunks.
//   · NO SIGNAL (CS-665). A cleaner in a basement taps a clean whose screen was never loaded.
//     A reload here is the worst possible answer: offline it lands on the browser's "no
//     internet" page and the app is gone. The cure is to keep the app on screen and say the
//     screen opens when the signal is back (components/OfflineScreen) — the service worker
//     (public/sw.js) keeps the crew's own screens on the phone, so this is the fallback for
//     everything else.
// They are told apart by asking: `navigator.onLine`, then — because "online" only means a
// network interface is up — whether the server answers at all (`serverReachable`). Any HTTP
// answer, even a 404, means it is there, so a missing chunk is a stale build.
//
// The reload guard is a COOLDOWN, not "once per session": an installed PWA keeps one session
// for days across resumes, so the old once-only rule recovered from the first deploy and then
// crashed to the error screen on the next one. A reload within the cooldown means the reloaded
// build failed too (a genuinely broken chunk), so we surface the error instead of looping.
// shouldRecover() and chunkFailureAction() are pure and node-tested (scripts/test-stale-build.mjs,
// scripts/test-offline-shell.mjs).

export const RELOAD_KEY = 'rfs.chunkReload';
export const RELOAD_COOLDOWN_MS = 30 * 1000;
// How long the "is the server there?" question may take. A phone on a weak signal that cannot
// fetch a few hundred bytes in this time cannot fetch a page chunk either.
export const PROBE_TIMEOUT_MS = 4000;

export const CHUNK_FAILURE = Object.freeze({ OFFLINE: 'offline', RELOAD: 'reload', ERROR: 'error' });

export function shouldRecover(lastReloadAt, now, cooldownMs = RELOAD_COOLDOWN_MS) {
  const last = Number(lastReloadAt);
  if (!Number.isFinite(last) || last <= 0) return true; // never reloaded (or junk)
  if (now < last) return true;                           // clock moved backwards: don't trap
  return now - last >= cooldownMs;
}

// The decision, pure. `online` = navigator.onLine; `reachable` = did the server answer.
// Offline wins over everything: a reload with no signal destroys the app.
export function chunkFailureAction({ online = true, reachable = true, lastReloadAt = null, now = Date.now(), cooldownMs = RELOAD_COOLDOWN_MS } = {}) {
  if (online === false || reachable === false) return CHUNK_FAILURE.OFFLINE;
  return shouldRecover(lastReloadAt, now, cooldownMs) ? CHUNK_FAILURE.RELOAD : CHUNK_FAILURE.ERROR;
}

// Does the server answer? A HEAD of the app's own page with `no-store`: never an HTTP-cache
// copy, and the service worker passes it straight through (it answers GETs only), so only the
// network can answer. Never /api — that is someone else's gate and some deployments proxy it.
export async function serverReachable({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetch !== 'function') return true;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    await fetch(assetUrl(`/index.html?probe=${Date.now()}`), { method: 'HEAD', cache: 'no-store', signal: ctrl?.signal });
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let reloading = false;

// Reload once to pick up the current build. True when a reload is under way (started now or
// already started by another failing import), so callers can wait for it instead of
// rendering the error; false when the loop guard says the reload itself already failed.
// Reached only through onChunkLoadFailure, which has already ruled out "no signal".
export function recoverFromStaleBuild() {
  if (reloading) return true;
  let last = null;
  try { last = sessionStorage.getItem(RELOAD_KEY); } catch { /* storage blocked: treat as never */ }
  if (!shouldRecover(last, Date.now())) return false;
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* best effort */ }
  reloading = true;
  window.location.reload();
  return true;
}

// THE door every failed chunk goes through (App.jsx lazyRoute, main.jsx vite:preloadError):
// → CHUNK_FAILURE.OFFLINE (keep the app on screen), .RELOAD (under way), or .ERROR (surface it).
// Single-flight: a page chunk and its preloads fail together, and both callers ask at once.
let inflight = null;
export function onChunkLoadFailure() {
  if (inflight) return inflight;
  inflight = (async () => {
    const online = typeof navigator === 'undefined' || !navigator ? true : navigator.onLine !== false;
    const reachable = online ? await serverReachable() : false;
    let last = null;
    try { last = sessionStorage.getItem(RELOAD_KEY); } catch { /* storage blocked: treat as never */ }
    const action = chunkFailureAction({ online, reachable, lastReloadAt: last, now: Date.now() });
    if (action !== CHUNK_FAILURE.RELOAD) return action;
    return recoverFromStaleBuild() ? CHUNK_FAILURE.RELOAD : CHUNK_FAILURE.ERROR;
  })();
  const settle = () => { setTimeout(() => { inflight = null; }, 1000); };
  inflight.then(settle, settle);
  return inflight;
}
