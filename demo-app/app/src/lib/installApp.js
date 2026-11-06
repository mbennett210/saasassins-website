// The browser side of the Home Screen welcome (task #127, UI_RULES §178): Android's install offer,
// the answers this browser keeps, whether the app is already installed, and the hook the welcome and
// the push prompt read. The decision itself is lib/installWelcome.js (pure, tested).
//
// Imported first thing by main.jsx, so the listeners below are on before Chrome hands over its
// install offer (which can come before React has drawn anything).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { isStandalonePWA } from './push';
import {
  installWelcomeFor, phoneOf, INSTALL_STORE_KEY, INSTALL_LATER_KEY, INSTALL_SHOWN_KEY,
} from './installWelcome';

const hasWindow = typeof window !== 'undefined';

function readLocal(key) { try { return window.localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } }
function readSession(key) { try { return window.sessionStorage.getItem(key) === '1'; } catch { return false; } }
function writeSession(key) { try { window.sessionStorage.setItem(key, '1'); } catch { /* private mode */ } }

// ── A tiny store: the welcome and the push prompt re-read when any of this changes. ──
let deferredPrompt = null; // Android's held install offer (BeforeInstallPromptEvent)
let version = 0;
const listeners = new Set();
function changed() { version += 1; listeners.forEach((fn) => fn()); }
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function getVersion() { return version; }

const stored = () => readLocal(INSTALL_STORE_KEY);

if (hasWindow) {
  // Opened from the Home Screen: remember it. On Android the installed app shares Chrome's storage,
  // so Chrome visits stay quiet after this; on iPhone the Home Screen app's storage is its own.
  if (isStandalonePWA()) writeLocal(INSTALL_STORE_KEY, 'installed');
  window.addEventListener('beforeinstallprompt', (e) => {
    // A computer keeps the browser's own install UI. On a phone the welcome is the one install prompt:
    // Chrome's own "Install" bar stays down, even after "I already have the app" / "Don't show again"
    // (seen on the Android emulator: an app added as a shortcut still drew Chrome's bar in Chrome).
    if (!phoneOf(navigator.userAgent || '', navigator.maxTouchPoints || 0)) return;
    e.preventDefault();
    if (stored() === 'never' || stored() === 'installed') return;
    deferredPrompt = e;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    writeLocal(INSTALL_STORE_KEY, 'installed');
    changed();
  });
}

// The decision for this browser, right now (the Android installed-check below can still turn it off).
export function installWelcomeNow() {
  if (!hasWindow) return null;
  return installWelcomeFor({
    ua: navigator.userAgent || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: isStandalonePWA(),
    stored: stored(),
    laterThisVisit: readSession(INSTALL_LATER_KEY),
    canPrompt: !!deferredPrompt,
  });
}

// One pop-up per visit: the push prompt waits while the welcome is due, or once it has shown.
export function installWelcomeHoldsPush() {
  if (!hasWindow) return false;
  return readSession(INSTALL_SHOWN_KEY) || !!installWelcomeNow();
}
export function useInstallWelcomeHold() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return installWelcomeHoldsPush();
}

// Android (Chrome 84+) can tell an in-scope page that its own installed app is on the phone, through
// the manifest's related_applications entry (public/manifest.json). Anything else answers false.
async function relatedAppInstalled() {
  try {
    if (typeof navigator.getInstalledRelatedApps !== 'function') return false;
    const apps = await navigator.getInstalledRelatedApps();
    return Array.isArray(apps) && apps.length > 0;
  } catch { return false; }
}

const ANDROID_WAIT_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// The welcome's hook: undefined while deciding, then null (nothing to show) or the decision. Decided
// once per mount, so the screen opens with its final content and never changes under the reader. On
// Android it first waits (up to ~1 s from the page's start) for the installed-check and the offer.
export function useInstallWelcome() {
  const [welcome, setWelcome] = useState(undefined);
  useEffect(() => {
    let alive = true;
    const first = installWelcomeNow();
    if (!first || first.phone !== 'android' || first.variant === 'inapp') {
      setWelcome(first);
      return () => { alive = false; };
    }
    const waitLeft = ANDROID_WAIT_MS - (typeof performance !== 'undefined' ? performance.now() : 0);
    let off = () => {};
    const offer = deferredPrompt ? Promise.resolve() : new Promise((resolve) => {
      off = subscribe(() => { if (deferredPrompt) resolve(); });
    });
    Promise.all([
      Promise.race([relatedAppInstalled(), sleep(ANDROID_WAIT_MS).then(() => false)]),
      Promise.race([offer, sleep(waitLeft)]),
    ]).then(([installed]) => {
      off();
      if (!alive) return;
      if (installed) { writeLocal(INSTALL_STORE_KEY, 'installed'); changed(); setWelcome(null); return; }
      setWelcome(installWelcomeNow());
    });
    return () => { alive = false; off(); };
  }, []);
  return welcome;
}

// ── The answers ──
export function markWelcomeShown() { writeSession(INSTALL_SHOWN_KEY); changed(); }
export function continueInBrowser() { writeSession(INSTALL_LATER_KEY); changed(); }
// 'installed' ("I already have the app") or 'never' ("Don't show again"): either stops it in this browser.
export function stopWelcomeForGood(answer = 'never') {
  writeLocal(INSTALL_STORE_KEY, answer === 'installed' ? 'installed' : 'never');
  changed();
}

// Android's Install button: opens the phone's own install box. Resolves 'accepted' | 'dismissed' |
// 'unavailable'. Accepted is remembered as installed (appinstalled says so too).
export async function promptInstall() {
  const offer = deferredPrompt;
  if (!offer) return 'unavailable';
  deferredPrompt = null; // an offer can be shown once
  try {
    await offer.prompt();
    const choice = await offer.userChoice;
    if (choice?.outcome === 'accepted') { writeLocal(INSTALL_STORE_KEY, 'installed'); changed(); return 'accepted'; }
    changed();
    return 'dismissed';
  } catch {
    changed();
    return 'unavailable';
  }
}
