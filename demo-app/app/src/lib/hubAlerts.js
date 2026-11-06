// THIS PHONE'S CREW-ON-THE-WAY ALERTS in the customer hub (Daniel's pick 2026-11-03, "A · Row on Home
// + Account"): the browser side. The rules (what the hub can offer here, when Home's row shows) are
// lib/crewOnTheWay.js; the server is api/hub push / push-off (api/_lib/clientHub/push.js).
//
//   · Turn on asks the browser for alerts, signs this browser up with the push service (the same
//     subscription the office app uses on a phone, public/sw.js shows both), and saves it for the
//     signed-in login. Nothing is saved until the browser says yes.
//   · Turn off removes this phone's sign-up for the login; the browser keeps its subscription.
//   · What this browser remembers per login (HUB_ALERTS_KEY) puts Home's row in place on the first
//     paint; the server is the truth the Account switch shows.
//   · Sign out removes this phone's sign-up first (forgetHubAlerts), so the next person on it is not
//     sent the last one's alerts.
//   · The demo signs up a made-up address with its twin (lib/hubDemo), asking the browser nothing.
import { fetchHubPush, saveHubPush, removeHubPush, isHubDemo } from './clientHubApi';
import { isPushSupported, isStandalonePWA, deriveDeviceLabel, urlBase64ToUint8Array } from './push';
import { phoneOf, installWelcomeFor } from './installWelcome';
import { HUB_ALERT_DEVICE, HUB_ALERT_MEMORY, hubAlertsDevice } from './crewOnTheWay';

export const HUB_ALERTS_KEY = 'cs.hubAlerts';
const DEMO_ENDPOINT_KEY = 'cs.hubAlerts.demoEndpoint';
const VAPID_PUBLIC_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_VAPID_PUBLIC_KEY) || null;
const READY_WAIT_MS = 10000;

const store = () => { try { return window.localStorage; } catch { return null; } };
function readAll() {
  try { return JSON.parse(store()?.getItem(HUB_ALERTS_KEY) || '{}') || {}; } catch { return {}; }
}
export function hubAlertsMemory(viewerKey) {
  const v = readAll()[String(viewerKey || '')];
  return v === HUB_ALERT_MEMORY.on || v === HUB_ALERT_MEMORY.dismissed ? v : null;
}
export function rememberHubAlerts(viewerKey, value) {
  const all = readAll();
  const k = String(viewerKey || '');
  if (value) all[k] = value; else delete all[k];
  try { store()?.setItem(HUB_ALERTS_KEY, JSON.stringify(all)); } catch { /* private mode: the row just comes back */ }
}

const ua = () => (typeof navigator !== 'undefined' && navigator.userAgent) || '';
const touches = () => (typeof navigator !== 'undefined' && navigator.maxTouchPoints) || 0;

// What the hub can offer on this browser (crewOnTheWay HUB_ALERT_DEVICE).
// The demo asks the browser nothing: an iPhone outside its Home Screen app still gets the steps,
// and everything else can turn alerts on.
export function hubAlertsDeviceNow() {
  const ios = phoneOf(ua(), touches()) === 'ios';
  if (isHubDemo()) return ios && !isStandalonePWA() ? HUB_ALERT_DEVICE.install : HUB_ALERT_DEVICE.ready;
  let permission = 'default';
  try { permission = typeof Notification !== 'undefined' ? Notification.permission : 'default'; } catch { /* none */ }
  return hubAlertsDevice({
    ios,
    standalone: isStandalonePWA(),
    supported: isPushSupported(),
    permission,
  });
}

// The Home Screen steps for this iPhone or iPad's browser (lib/installWelcome INSTALL_STEPS).
export function hubAlertsInstallVariant() {
  return installWelcomeFor({ ua: ua(), maxTouchPoints: touches(), standalone: false })?.variant || 'ios-safari';
}

export function hubAlertsError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function swReady() {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), READY_WAIT_MS); });
  try { return await Promise.race([navigator.serviceWorker.ready, late]); } finally { clearTimeout(timer); }
}

function demoEndpoint(make = false) {
  let e = null;
  try { e = store()?.getItem(DEMO_ENDPOINT_KEY) || null; } catch { /* none */ }
  if (!e && make) {
    e = `https://demo.invalid/push/${Math.random().toString(36).slice(2, 12)}`;
    try { store()?.setItem(DEMO_ENDPOINT_KEY, e); } catch { /* none */ }
  }
  return e;
}

// This browser's push address, or null (no subscription yet).
async function currentEndpoint() {
  if (isHubDemo()) return demoEndpoint(false);
  if (!isPushSupported()) return null;
  const reg = await swReady();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub?.endpoint || null;
}

// Is this phone signed up for this login? { on }.
export async function hubAlertsStatus() {
  const endpoint = await currentEndpoint();
  if (!endpoint) return { on: false };
  const r = await fetchHubPush(endpoint);
  return { on: r?.on === true };
}

// Turn alerts on for this phone. Throws an Error with a `code`: 'blocked' (refused now or before),
// 'not-allowed' (the browser's box was closed), 'unavailable' (no alerts here, or not set up).
export async function turnOnHubAlerts(viewerKey) {
  if (isHubDemo()) {
    const endpoint = demoEndpoint(true);
    await saveHubPush({ subscription: { endpoint, keys: { p256dh: 'demo-key', auth: 'demo-auth' } }, deviceLabel: deriveDeviceLabel() });
    rememberHubAlerts(viewerKey, HUB_ALERT_MEMORY.on);
    return { on: true };
  }
  const device = hubAlertsDeviceNow();
  if (device === HUB_ALERT_DEVICE.blocked) throw hubAlertsError('blocked', 'Alerts are blocked for this site in your browser’s settings.');
  if (device !== HUB_ALERT_DEVICE.ready) throw hubAlertsError('unavailable', 'This browser can’t show alerts.');
  if (!VAPID_PUBLIC_KEY) throw hubAlertsError('unavailable', 'Alerts aren’t set up yet. Try again later.');
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw hubAlertsError('blocked', 'Alerts are blocked for this site in your browser’s settings.');
  if (permission !== 'granted') throw hubAlertsError('not-allowed', 'Alerts weren’t allowed. Tap Turn on again and choose Allow.');
  const reg = await swReady();
  if (!reg) throw hubAlertsError('unavailable', 'This browser didn’t answer. Try again in a moment.');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  await saveHubPush({ subscription: sub.toJSON(), deviceLabel: deriveDeviceLabel() });
  rememberHubAlerts(viewerKey, HUB_ALERT_MEMORY.on);
  return { on: true };
}

// Turn alerts off for this phone (the Account switch).
export async function turnOffHubAlerts(viewerKey) {
  const endpoint = await currentEndpoint();
  if (endpoint) await removeHubPush(endpoint);
  rememberHubAlerts(viewerKey, HUB_ALERT_MEMORY.dismissed);
  return { on: false };
}

// Before Sign out: this phone's sign-up goes, best-effort and quick, never holding the sign-out up.
export async function forgetHubAlerts(viewerKey) {
  rememberHubAlerts(viewerKey, null);
  try {
    const endpoint = await currentEndpoint();
    if (!endpoint) return;
    await Promise.race([removeHubPush(endpoint), new Promise((resolve) => setTimeout(resolve, 3000))]);
  } catch { /* the push service's 410 removes it at the next send */ }
}
