// Twilio transport for STAFF ALERT TEXTS — NTF-1 ★b (Matt, 2026-09-29): "A missed shift at
// 2 a.m.: how should the supervisor find out? — (b) A phone notification, plus a text message
// for missed shifts and urgent tickets." CS-069.
//
// Service-role / server-only: never import this from the browser. It is a thin `fetch` against
// Twilio's REST API — no SDK, because the whole surface is one form POST and a serverless cold
// start should not pay for a dependency to make it.
//
// 🔴 SECRETS (THE LAW II.9): the account sid, the auth token and the sender all come from the
// environment and are NEVER logged, returned or put in an error message. `smsStatus()` answers
// only whether each one is PRESENT and which kind of sender is configured — that is what the
// Integrations page needs, and it is not a secret.
//   TWILIO_ACCOUNT_SID          the account
//   TWILIO_AUTH_TOKEN           its auth token
//   TWILIO_MESSAGING_SERVICE_SID  the preferred sender (a Messaging Service handles the
//                               number pool and the A2P campaign), or
//   TWILIO_FROM_NUMBER          a single E.164 sending number
// With the env unset the channel is OFF: every send is a no-op that says `skipped:
// 'sms_unconfigured'`, exactly as the push core no-ops without VAPID, and Settings →
// Integrations says so in words.
import { toE164, TWILIO_OPTED_OUT_CODE } from '../../../src/lib/alertDelivery.js';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
// Twilio is a dependency of a cron run, not of the response to a person, so it gets a short
// leash: a hung request must not eat the run's 60 s budget for the alerts still to send.
const SEND_TIMEOUT_MS = 8000;

const env = (k) => {
  const v = process.env[k];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

// True only when an account, a token AND a sender are all provisioned. Any one missing means
// the channel is not configured — a half-configured Twilio would fail on every send, which is
// worse than being honestly off.
export function smsConfigured() {
  return Boolean(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN')
    && (env('TWILIO_MESSAGING_SERVICE_SID') || env('TWILIO_FROM_NUMBER')));
}

// What Settings → Integrations renders. Env NAMES and presence only — never a value, not even
// masked: a masked account sid is still an account sid on a screen anyone in the office can see.
export function smsStatus() {
  const hasService = !!env('TWILIO_MESSAGING_SERVICE_SID');
  const hasNumber = !!env('TWILIO_FROM_NUMBER');
  return {
    configured: smsConfigured(),
    senderKind: hasService ? 'messaging_service' : (hasNumber ? 'from_number' : null),
    missing: [
      ...(env('TWILIO_ACCOUNT_SID') ? [] : ['TWILIO_ACCOUNT_SID']),
      ...(env('TWILIO_AUTH_TOKEN') ? [] : ['TWILIO_AUTH_TOKEN']),
      ...(hasService || hasNumber ? [] : ['TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER']),
    ],
  };
}

// Send one text. Returns, never throws:
//   { ok: true, sid }                        delivered to Twilio
//   { ok: false, skipped: 'sms_unconfigured' | 'bad_number' }
//   { ok: false, optedOut: true, code }      the number replied STOP (Twilio 21610)
//   { ok: false, code, error }               anything else, with Twilio's own numeric code
//
// `fetchImpl` is injectable so the test suite drives the whole matrix with a stubbed fetch and
// no Twilio account (app/scripts/test-alert-sms.mjs).
export async function sendSms({ to, body }, { fetchImpl = fetch } = {}) {
  if (!smsConfigured()) return { ok: false, skipped: 'sms_unconfigured' };
  const dest = toE164(to);
  if (!dest) return { ok: false, skipped: 'bad_number' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, skipped: 'empty_body' };

  const accountSid = env('TWILIO_ACCOUNT_SID');
  const form = new URLSearchParams({ To: dest, Body: text });
  const service = env('TWILIO_MESSAGING_SERVICE_SID');
  if (service) form.set('MessagingServiceSid', service);
  else form.set('From', env('TWILIO_FROM_NUMBER'));

  // Basic auth. Built inline and never held in a variable that could be logged.
  const auth = Buffer.from(`${accountSid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64');
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(`${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* a non-JSON body is still an outcome */ }
    if (res.ok) return { ok: true, sid: payload?.sid || null };
    const code = Number(payload?.code) || null;
    // 21610 = "the recipient has replied STOP". Every later message to that number is rejected
    // the same way, so the caller stamps the person as opted out and stops texting them.
    if (code === TWILIO_OPTED_OUT_CODE) return { ok: false, optedOut: true, code };
    // Twilio's message text is safe to surface (it describes the number/campaign, not the
    // credentials); the status code is carried so a caller can tell 4xx from 5xx.
    return { ok: false, code, status: res.status, error: payload?.message || `Twilio rejected the message (${res.status})` };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    return { ok: false, error: aborted ? 'Twilio request timed out' : (err?.message || 'Twilio request failed') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
