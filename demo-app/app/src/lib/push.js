// ─────────────────────────────────────────────────────────────────────────────
// Web Push adapter — frontend interface for subscribing/unsubscribing the
// current device, retrieving the per-user device list, and firing a test push.
//
// Mirrors the lib/twilio.js / lib/email.js pattern: stub mode runs locally
// when VITE_PUSH_BACKEND_URL is unset (returns realistic-shaped responses
// instantly, fires a local Notification for the test-push path); hosted mode
// hits the deployment companion repo's /api/push/* endpoints.
//
// Backend contract (deployment companion):
//   POST   /api/push/subscribe   { userId, subscription, deviceLabel } → { ok, subscriptionId }
//   DELETE /api/push/subscribe   { userId, endpoint }                  → { ok }
//   GET    /api/push/devices?userId=...                                → [{ subscriptionId, deviceLabel, endpointMasked, lastSeenAt }]
//   POST   /api/push/test        { userId }                            → { delivered, failed, expired }
//
// VAPID public key is exposed via VITE_VAPID_PUBLIC_KEY at build time. The
// matching private key never leaves the backend.
// ─────────────────────────────────────────────────────────────────────────────

import { BRAND } from '../brand.config.js';

const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PUSH_BACKEND_URL) || null;
const VAPID_PUBLIC_KEY =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_VAPID_PUBLIC_KEY) || null;

export const PUSH_BACKEND_URL = BACKEND;

// Stub state — only used when BACKEND is unset. Cleared on reload.
let stubSubscription = null;     // { endpoint, keys, deviceLabel, subscribedAt }
const stubDevices = new Map();   // userId → [stubSubscription, ...]

// ───────────────────────── Feature detection ─────────────────────────

export function isPushSupported() {
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// iOS 16.4+ requires the app to be installed as a PWA on the home screen
// before push will work. We check both the standard standalone display-mode
// and the legacy iOS-only `navigator.standalone` flag.
export function isStandalonePWA() {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia?.('(display-mode: standalone)');
  if (mq?.matches) return true;
  return Boolean(window.navigator?.standalone);
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

// True when push is available right now in the current context. iOS in-browser
// (not installed as PWA) is the only modern blocker.
export function isPushAvailable() {
  if (!isPushSupported()) return false;
  if (isIOS() && !isStandalonePWA()) return false;
  return true;
}

// ───────────────────────── VAPID helper ─────────────────────────

export function urlBase64ToUint8Array(base64String) {
  if (!base64String) throw new Error('VAPID public key is not configured (VITE_VAPID_PUBLIC_KEY).');
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function deriveDeviceLabel() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'This device';
}

// ───────────────────────── Subscription ─────────────────────────

// Returns the current PushSubscription for this device, or null if none.
export async function getCurrentSubscription() {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// Mode-aware "is this device wired up to receive push?" check. The user-pref
// `mobilePushEnabled` is intent — this is the actual delivery readiness.
export async function isCurrentDeviceSubscribed() {
  if (!BACKEND) return stubSubscription !== null;
  const sub = await getCurrentSubscription();
  return sub !== null;
}

// Request permission + subscribe + persist on backend. Returns the subscription
// object on success, or throws with a user-facing error message.
export async function enableMobilePush({ userId, deviceLabel } = {}) {
  if (!userId) throw new Error('userId is required to enable mobile push.');
  if (!isPushSupported()) throw new Error('This browser does not support push notifications.');
  if (isIOS() && !isStandalonePWA()) {
    throw new Error('On iOS, install this app to your home screen first (Share → Add to Home Screen), then come back here.');
  }

  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new Error('Push notifications are blocked in your browser. Allow them in site settings, then try again.');
  }
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const label = deviceLabel || deriveDeviceLabel();

  // Stub mode — short-circuit before touching pushManager so dev environments
  // without VAPID keys still exercise the UI flow.
  if (!BACKEND) {
    stubSubscription = {
      endpoint: `stub://device-${Date.now()}`,
      keys: { p256dh: 'stub-p256dh', auth: 'stub-auth' },
      deviceLabel: label,
      subscribedAt: new Date().toISOString(),
    };
    const list = stubDevices.get(userId) || [];
    list.push(stubSubscription);
    stubDevices.set(userId, list);
    return { ok: true, stub: true, subscription: stubSubscription };
  }

  if (!VAPID_PUBLIC_KEY) {
    throw new Error('Push is not configured for this deployment (missing VITE_VAPID_PUBLIC_KEY).');
  }

  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const res = await fetch(`${BACKEND}/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId,
      subscription: subscription.toJSON(),
      deviceLabel: label,
    }),
  });
  if (!res.ok) throw new Error(`Push subscribe failed (${res.status}).`);
  return { ok: true, stub: false, subscription };
}

// Unsubscribe this device + tell backend to drop the row. Idempotent.
export async function disableMobilePush({ userId } = {}) {
  if (!userId) throw new Error('userId is required to disable mobile push.');

  if (!BACKEND) {
    stubSubscription = null;
    stubDevices.delete(userId);
    return { ok: true, stub: true };
  }

  const sub = await getCurrentSubscription();
  if (sub) {
    try {
      await fetch(`${BACKEND}/push/subscribe`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, endpoint: sub.endpoint }),
      });
    } catch {
      /* best-effort — continue with local unsubscribe even if backend errors */
    }
    try { await sub.unsubscribe(); } catch { /* ignore */ }
  }
  return { ok: true, stub: false };
}

// Remove a specific device by endpoint (used by the per-device list "Remove"
// button when the user is signed in elsewhere). Cannot unsubscribe the device
// locally — only deletes the row on backend.
export async function removeDevice({ userId, endpoint } = {}) {
  if (!userId || !endpoint) throw new Error('userId and endpoint are required.');
  if (!BACKEND) {
    const list = (stubDevices.get(userId) || []).filter((d) => d.endpoint !== endpoint);
    if (list.length) stubDevices.set(userId, list);
    else stubDevices.delete(userId);
    if (stubSubscription?.endpoint === endpoint) stubSubscription = null;
    return { ok: true, stub: true };
  }
  const res = await fetch(`${BACKEND}/push/subscribe`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, endpoint }),
  });
  if (!res.ok) throw new Error(`Push device removal failed (${res.status}).`);
  return { ok: true, stub: false };
}

// List all active subscriptions for a user. Each row is shaped for UI display.
export async function getDevices({ userId } = {}) {
  if (!userId) return [];
  if (!BACKEND) {
    const list = stubDevices.get(userId) || [];
    return list.map((d, i) => ({
      subscriptionId: `stub-${i}`,
      deviceLabel: d.deviceLabel,
      endpoint: d.endpoint,
      endpointMasked: d.endpoint.slice(0, 24) + '…',
      lastSeenAt: d.subscribedAt,
    }));
  }
  const res = await fetch(`${BACKEND}/push/devices?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Failed to load devices (${res.status}).`);
  return res.json();
}

// Send a canned test push to all of the user's subscribed devices. In stub mode
// fires a local Notification so the click-through path is exercisable without
// a backend.
export async function sendTestPush({ userId } = {}) {
  if (!userId) throw new Error('userId is required.');
  if (!BACKEND) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`${BRAND.name} — test push`, {
          body: 'If you can read this, mobile push is wired correctly on this device.',
          icon: '/icon-192.png',
        });
      } catch {
        /* some browsers don't allow new Notification() outside a SW; ignore */
      }
    }
    return { ok: true, stub: true, delivered: 1, failed: 0, expired: 0 };
  }
  const res = await fetch(`${BACKEND}/push/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(`Test push failed (${res.status}).`);
  return res.json();
}
