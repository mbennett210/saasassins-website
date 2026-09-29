// ─────────────────────────────────────────────────────────────────────────────
// Web Push adapter — frontend interface for subscribing/unsubscribing the
// current device, retrieving the per-user device list, and firing a test push.
//
// Mirrors the lib/timeApi.js pattern: a localStorage/in-memory STUB runs in
// local/demo mode (no Supabase) — returns realistic-shaped responses instantly
// and fires a local Notification for the test-push path; HOSTED mode hits the
// co-located, auth-gated push routes under app/api/push/*. The backend base is
// same-origin `/api` by default (override with VITE_PUSH_BACKEND_URL only if the
// push routes ever move to a separate deployment).
//
// Backend contract (app/api/push/*):
//   POST   /api/push/subscribe   { subscription, deviceLabel } → { ok }
//   DELETE /api/push/subscribe   { endpoint }                  → { ok }
//   GET    /api/push/devices                                   → [{ subscriptionId, deviceLabel, endpoint, endpointMasked, lastSeenAt }]
//   POST   /api/push/test                                      → { ok, delivered, failed, expired }
// (The caller's user id is resolved server-side from the auth session, so it is
// never trusted from the request body.)
//
// VAPID public key is exposed via VITE_VAPID_PUBLIC_KEY at build time. The
// matching private key never leaves the backend.
// ─────────────────────────────────────────────────────────────────────────────

import { authHeaders } from './authHeader';
import { isAuthConfigured } from './supabaseClient';
import { IDENTITY } from '../brand/identity.generated.js';

const EXPLICIT_BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PUSH_BACKEND_URL) || null;
// Hosted when Supabase auth is configured (real deployment): default to the
// same-origin `/api`. Stub (null) in local/demo so the UI flow stays exercisable.
const BACKEND = EXPLICIT_BACKEND || (isAuthConfigured() ? '/api' : null);
const VAPID_PUBLIC_KEY =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_VAPID_PUBLIC_KEY) || null;

export const PUSH_BACKEND_URL = BACKEND;

// Stub state — only used when BACKEND is unset. Cleared on reload.
let stubSubscription = null;     // { endpoint, keys, deviceLabel, subscribedAt }
const stubDevices = new Map();   // userId → [stubSubscription, ...]

// Authed fetch against the push backend. Attaches the Supabase bearer (the
// routes are requireAuth-gated) and parses { error } bodies into thrown Errors.
async function pushApi(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON / empty */ }
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

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

  await pushApi('/push/subscribe', {
    method: 'POST',
    body: { userId, subscription: subscription.toJSON(), deviceLabel: label },
  });
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
      await pushApi('/push/subscribe', { method: 'DELETE', body: { userId, endpoint: sub.endpoint } });
    } catch {
      /* best-effort — continue with local unsubscribe even if backend errors */
    }
    try { await sub.unsubscribe(); } catch { /* ignore */ }
  }
  return { ok: true, stub: false };
}

// Tear down THIS device's subscription on sign-out — no userId required. The
// backend resolves the owner from the (still-valid) auth session, so we only
// need the endpoint; the local unsubscribe is device-scoped. Best-effort and
// idempotent so it can never block logout. Without this, the browser keeps its
// PushSubscription and the backend keeps the row, so the NEXT user on this
// device receives the signed-out user's OS pushes (title + 90-char preview).
export async function unsubscribeCurrentDevice() {
  try {
    if (!BACKEND) { stubSubscription = null; return { ok: true, stub: true }; }
    const sub = await getCurrentSubscription();
    if (!sub) return { ok: true };
    try {
      await pushApi('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } });
    } catch { /* best-effort — still unsubscribe locally below */ }
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    return { ok: true };
  } catch {
    return { ok: false };
  }
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
  await pushApi('/push/subscribe', { method: 'DELETE', body: { userId, endpoint } });
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
  return (await pushApi('/push/devices')) || [];
}

// Per-user push status for the Team view (admin only): map of userId ->
// { deviceCount, lastSeenAt }, from actual push_subscriptions rows. Stub derives
// it from the in-memory stub subscriptions so the demo Team view still reflects a
// device subscribed this session.
export async function getTeamPushStatus() {
  if (!BACKEND) {
    const out = {};
    for (const [uid, list] of stubDevices) {
      if (list && list.length) out[uid] = { deviceCount: list.length, lastSeenAt: list[list.length - 1]?.subscribedAt || null };
    }
    return out;
  }
  try { return (await pushApi('/push/status')) || {}; } catch { return {}; }
}

// Send a canned test push to all of the user's subscribed devices. In stub mode
// fires a local Notification so the click-through path is exercisable without
// a backend.
export async function sendTestPush({ userId } = {}) {
  if (!userId) throw new Error('userId is required.');
  if (!BACKEND) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`${IDENTITY.name}: Test push`, {
          body: 'If you can read this, mobile push is wired correctly on this device.',
          icon: '/icon-192.png',
        });
      } catch {
        /* some browsers don't allow new Notification() outside a SW; ignore */
      }
    }
    return { ok: true, stub: true, delivered: 1, failed: 0, expired: 0 };
  }
  return pushApi('/push/test', { method: 'POST', body: { userId } });
}

// Fire an IMMEDIATE server dispatch of any unpushed notification rows, so a freshly
// created message (DM / thread / SMS / email) reaches subscribed phones in ~1s
// instead of waiting for the every-minute /api/push/dispatch cron. Debounced +
// fire-and-forget; the cron stays as the fallback, and the server core is idempotent
// (CAS reserve-then-send) so a flush and a cron tick never double-send. No-op in
// stub/demo (no backend).
let flushTimer = null;
export function flushPush() {
  if (!BACKEND) return;
  if (flushTimer) return; // coalesce a burst of sends into one flush
  flushTimer = setTimeout(() => {
    flushTimer = null;
    pushApi('/push/flush', { method: 'POST' }).catch(() => { /* the dispatch cron is the fallback */ });
  }, 500);
}
