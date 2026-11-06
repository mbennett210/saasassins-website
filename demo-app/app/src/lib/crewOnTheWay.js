// CREW ON THE WAY — what a cleaner's "On my way" tap tells the building's customers, and the words
// both sides read. Daniel's Oct 28 call: "Crew on the way let's just have it go out through system
// notifications" and "why not send a push notification to them, as well? The text ability should
// remain"; his picks 2026-11-03: "A · Row on Home + Account" and "When someone can be told".
//
// One tap (the Cleaner Hub, api/time on-my-way → api/_lib/customerMessages/onTheWay.js), once per
// clean, tells the customers three ways:
//   · THE BELL — a line in the customer hub's Updates for every login that can see the building,
//     from the activity log row the tap writes (ON_THE_WAY_ACTION, one per clean: its id is the
//     clean's, so a second tap or a second phone writes nothing); it opens the Crew status page;
//   · THE PHONE ALERT — to those logins' phones and computers that turned alerts on (the Home row
//     or the Account switch, lib/hubAlerts.js; table client_push_subscriptions);
//   · THE TEXT — Matt's approved "Crew on the way" text to the clean's site contact, as built
//     (lib/reminderScheduler onTheWayItem), when texting is set up and the text is switched on.
// The button shows only when one of them can reach someone (canTellCustomer).
//
// Pure: no I/O, no React. The hub's words are English (the hub is), like its other bell lines.
import { fmtTime } from './dates.js';

// The activity log's action for a tap (lib/activityLog ACTIONS; the office reads it in Activity).
export const ON_THE_WAY_ACTION = 'job.on_the_way';
// The bell's kind for it (lib/hubMessages HUB_UPDATE_KINDS).
export const ON_THE_WAY_KIND = 'onTheWay';

// The building's Crew status page: where the bell line and the phone alert open.
export const hubVisitPath = (buildingId) => `/hub/b/${encodeURIComponent(String(buildingId ?? ''))}/visit`;

// When the crew will arrive, as the text says it: the clean's start while it is at least
// ON_THE_WAY_MIN_LEAD_MS away, else a quarter of an hour from now, rounded up to five minutes.
// (Moved here from lib/reminderScheduler, which re-exports it, so the bell, the alert and the text
// give the same time.)
export const ON_THE_WAY_MIN_LEAD_MS = 10 * 60 * 1000;
export function onTheWayEta(job, nowMs) {
  const start = Date.parse(job?.startAt ?? '');
  if (Number.isFinite(start) && start - nowMs >= ON_THE_WAY_MIN_LEAD_MS) return new Date(start).toISOString();
  const five = 5 * 60 * 1000;
  return new Date(Math.ceil((nowMs + 15 * 60 * 1000) / five) * five).toISOString();
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const arrival = (eta, tz) => (Number.isFinite(Date.parse(eta ?? '')) ? fmtTime(eta, tz, 'en-US') : '');

// The bell's line: "Your crew is on the way to Coral Bay HOA, arriving around 2:15 PM."
export function onTheWayLine({ buildingName, eta, tz } = {}) {
  const place = clean(buildingName) || 'your building';
  const time = arrival(eta, tz);
  return time ? `Your crew is on the way to ${place}, arriving around ${time}.` : `Your crew is on the way to ${place}.`;
}

// The phone alert: no buttons; a tap opens the building's Crew status page. The tag folds a repeat
// for the same clean into one alert on the phone.
export const ON_THE_WAY_TITLE = 'Your crew is on the way';
export function onTheWayAlert({ buildingId, buildingName, eta, tz, jobId } = {}) {
  const place = clean(buildingName) || 'Your building';
  const time = arrival(eta, tz);
  return {
    title: ON_THE_WAY_TITLE,
    body: time ? `${place}, arriving around ${time}.` : `${place}.`,
    url: hubVisitPath(buildingId),
    tag: `on-the-way-${jobId}`,
  };
}

// The activity log's line (English, like every log line).
export function onTheWaySummary({ actorName, buildingName } = {}) {
  return `${clean(actorName) || 'A cleaner'} is on the way to ${clean(buildingName) || 'the building'}.`;
}

// Daniel's pick: the button shows only when someone can be told — a customer login that can see
// the building, or the text (texting set up, the text on, a mobile number for the clean).
export const canTellCustomer = ({ hubLogins = 0, textReady = false } = {}) => hubLogins > 0 || textReady === true;

// ── the hub's phone alerts: the one input rule (api/hub POST push) ─────────────
// A browser's PushSubscription as the hub sends it: an https push address and its two keys, and a
// short label. Anything else is refused whole.
export const HUB_PUSH_LIMITS = Object.freeze({ endpoint: 2048, key: 256, label: 64 });
export const HUB_PUSH_CODES = Object.freeze({ bad: 'bad-subscription', preview: 'preview-no-alerts' });
const isHttpsUrl = (s) => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };
export function hubPushEndpoint(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= HUB_PUSH_LIMITS.endpoint && isHttpsUrl(s) ? s : null;
}
export function hubPushInput(body) {
  const sub = body && typeof body === 'object' ? body.subscription : null;
  const endpoint = hubPushEndpoint(sub?.endpoint);
  const key = (k) => (typeof k === 'string' && k.length > 0 && k.length <= HUB_PUSH_LIMITS.key && /^[A-Za-z0-9_\-=+/]+$/.test(k) ? k : null);
  const p256dh = key(sub?.keys?.p256dh);
  const auth = key(sub?.keys?.auth);
  if (!endpoint || !p256dh || !auth) return { refused: 'That isn’t a phone alert sign-up this app can use.', code: HUB_PUSH_CODES.bad };
  const label = clean(body.deviceLabel).slice(0, HUB_PUSH_LIMITS.label) || null;
  return { value: { endpoint, p256dh, auth, deviceLabel: label } };
}

// ── the login-free demo ───────────────────────────────────────────────────────
// The demo has no server: the crew's tap keeps its notice in this browser (lib/timeApi), and the
// hub's demo bell reads it (lib/hubDemo). Never read by the connected app.
export const ON_THE_WAY_STUB_KEY = 'cleanspace_on_the_way_stub_v1';
export const ON_THE_WAY_STUB_MAX = 50;

// ── this phone's alerts: what the hub can offer (lib/hubAlerts.js reads the browser) ──
// 'install'      an iPhone or iPad outside the Home Screen app: Safari gives a page no alerts, so
//                Turn on shows the Home Screen steps (lib/installWelcome) first;
// 'unsupported'  a browser with no alerts at all (an older browser, some in-app browsers);
// 'blocked'      alerts were refused for this site in the browser's settings;
// 'ready'        Turn on asks the browser, then signs this phone up.
export const HUB_ALERT_DEVICE = Object.freeze({ install: 'install', unsupported: 'unsupported', blocked: 'blocked', ready: 'ready' });
export function hubAlertsDevice({ ios = false, standalone = false, supported = false, permission = 'default' } = {}) {
  if (ios && !standalone) return HUB_ALERT_DEVICE.install;
  if (!supported) return HUB_ALERT_DEVICE.unsupported;
  if (permission === 'denied') return HUB_ALERT_DEVICE.blocked;
  return HUB_ALERT_DEVICE.ready;
}

// What this browser remembers for a login (lib/hubAlerts HUB_ALERTS_KEY): 'on' once alerts were
// turned on here, 'dismissed' once the Home row's × was tapped or the Account switch turned them off.
export const HUB_ALERT_MEMORY = Object.freeze({ on: 'on', dismissed: 'dismissed' });

// Home's row ("Get an alert when your crew is on the way"): on a phone or computer that can have
// alerts (or an iPhone that can once the app is on its Home Screen), until they are turned on here
// or the row is closed. Decided from what the browser knows, so it is in place on the first paint.
export function hubAlertsRowShows({ device, memory } = {}) {
  if (device !== HUB_ALERT_DEVICE.ready && device !== HUB_ALERT_DEVICE.install) return false;
  return memory !== HUB_ALERT_MEMORY.on && memory !== HUB_ALERT_MEMORY.dismissed;
}
