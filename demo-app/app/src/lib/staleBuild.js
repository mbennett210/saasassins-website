// staleBuild.js — recovering a tab that outlived a deploy.
//
// Every page is its own chunk with a content-hashed file name, and a deploy replaces all of
// them. A tab still running the previous build (an installed PWA resumed from the
// background, a tab left open overnight) asks for chunk names the new deploy no longer has,
// so the first visit to any page it hadn't opened yet fails to load: a tap on a tab does
// nothing, then crashes. The cure is a reload — the fresh index.html names the fresh chunks.
//
// The guard is a COOLDOWN, not "once per session": an installed PWA keeps one session for
// days across resumes, so the old once-only rule recovered from the first deploy and then
// crashed to the error screen on the next one. A reload within the cooldown means the
// reloaded build failed too (a genuinely broken chunk), so we surface the error instead of
// looping. shouldRecover() is pure and node-tested (scripts/test-stale-build.mjs).

export const RELOAD_KEY = 'rfs.chunkReload';
export const RELOAD_COOLDOWN_MS = 30 * 1000;

export function shouldRecover(lastReloadAt, now, cooldownMs = RELOAD_COOLDOWN_MS) {
  const last = Number(lastReloadAt);
  if (!Number.isFinite(last) || last <= 0) return true; // never reloaded (or junk)
  if (now < last) return true;                           // clock moved backwards: don't trap
  return now - last >= cooldownMs;
}

let reloading = false;

// Reload once to pick up the current build. True when a reload is under way (started now or
// already started by another failing import), so callers can wait for it instead of
// rendering the error; false when the loop guard says the reload itself already failed.
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
