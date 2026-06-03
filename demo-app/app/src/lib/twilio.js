// ─────────────────────────────────────────────────────────────────────────────
// Twilio adapter — frontend interface for SMS send / connection / A2P.
//
// IMPORTANT: This module is environment-aware.
//
// In a stub deployment (the default for the shell repo and any dev session),
// network calls are simulated locally and resolve with realistic-shaped responses
// after a short delay. Outbound messages cycle through queued → sent → delivered;
// occasionally a stubbed message will fail to exercise the failure UI path.
//
// In a hosted/production deployment, the real backend (Vercel API routes or
// Supabase Edge Functions) sets `import.meta.env.VITE_TWILIO_BACKEND_URL` to a
// base URL. When that env var is present, every call hits the backend instead
// of the stub — credentials never live in the browser.
//
// The shell ships disconnected. Per-deployment ops fills env vars at deploy time.
// ─────────────────────────────────────────────────────────────────────────────

import { IS_DEMO } from '../demo/isDemo';

// The demo build hard-pins this to stub mode regardless of any env var, so the
// sales demo can never reach a real Twilio backend.
const BACKEND = IS_DEMO
  ? null
  : ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_TWILIO_BACKEND_URL) || null);

const STUB_DELAY_MS = 600;
const STUB_FAILURE_RATE = 0.08; // ~8% of stubbed outbound sends fail, to exercise failure UI

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskPhone(p) {
  if (!p) return '';
  const digits = p.replace(/\D+/g, '');
  if (digits.length < 4) return p;
  return `+${digits.slice(0, digits.length - 4).replace(/./g, '•')}${digits.slice(-4)}`;
}

// ────────────── Connection / number provisioning ──────────────

/**
 * Connect a Twilio account by Account SID + Auth Token.
 * Backend: POST { accountSid, authToken } → { ok, accountSidLast4, availableNumbers[] }
 * Stub: validates shape, returns last 4 of SID and a fake list of available numbers.
 */
export async function connectTwilio({ accountSid, authToken }) {
  if (!accountSid || !accountSid.startsWith('AC') || accountSid.length < 10) {
    throw new Error('Account SID must start with "AC" and be 34 characters.');
  }
  if (!authToken || authToken.length < 8) {
    throw new Error('Auth token is required.');
  }
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/twilio/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountSid, authToken }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Twilio connect failed (${res.status})`);
    }
    return res.json();
  }
  // Stub path — pretend Twilio responded with a couple of available numbers.
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    accountSidLast4: accountSid.slice(-4),
    availableNumbers: [
      { phoneNumber: '+12065550100', friendlyName: '(206) 555-0100 — Seattle' },
      { phoneNumber: '+14155550199', friendlyName: '(415) 555-0199 — San Francisco' },
      { phoneNumber: '+18005550144', friendlyName: '(800) 555-0144 — Toll-free' },
    ],
  };
}

/**
 * Provision (claim) a number on the connected Twilio account.
 * Backend: POST { phoneNumber } → { ok, phoneNumber, friendlyName, inboundWebhookUrl }
 * Stub: echoes back and synthesizes a plausible webhook URL for display.
 */
export async function provisionNumber({ phoneNumber, friendlyName }) {
  if (!phoneNumber || !phoneNumber.startsWith('+')) {
    throw new Error('Phone number must be E.164 format (e.g. +12065550100).');
  }
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/twilio/numbers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, friendlyName }),
    });
    if (!res.ok) throw new Error(`Provision failed (${res.status})`);
    return res.json();
  }
  await delay(STUB_DELAY_MS);
  // The webhook URL the deployment exposes for inbound SMS. In real production
  // the backend hands back its actual URL; the stub fakes one for display.
  const stubWebhook = `${window.location.origin}/api/twilio/inbound`;
  return { ok: true, phoneNumber, friendlyName, inboundWebhookUrl: stubWebhook };
}

/**
 * Disconnect the current Twilio account.
 * Backend: POST /twilio/disconnect → { ok }
 * Stub: resolves immediately.
 */
export async function disconnectTwilio() {
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/twilio/disconnect`, { method: 'POST' });
    if (!res.ok) throw new Error('Disconnect failed');
    return res.json();
  }
  await delay(200);
  return { ok: true };
}

// ────────────── Outbound SMS ──────────────

/**
 * Send an SMS.
 * Backend: POST { from, to, body } → { sid, status }
 * Stub: cycles delivery status (queued → sent → delivered or failed) and
 *       returns an initial { sid, status: 'queued' }. The caller is expected
 *       to subscribe to status updates via subscribeToDelivery().
 */
export async function sendSMS({ from, to, body }) {
  if (!from || !to) throw new Error('Missing from/to.');
  if (!body || !body.trim()) throw new Error('Message body is empty.');
  if (body.length > 1600) throw new Error('Message exceeds 1600 characters.');

  if (BACKEND) {
    const res = await fetch(`${BACKEND}/twilio/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, body }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Send failed (${res.status})`);
    }
    return res.json();
  }
  // Stub path — return queued immediately. Caller polls / subscribes for status.
  await delay(200);
  const sid = `SM${Math.random().toString(36).slice(2, 14)}`;
  return { sid, status: 'queued' };
}

/**
 * Subscribe to delivery status for a given message SID. Returns an unsubscribe fn.
 * Backend: opens an SSE/WS connection.
 * Stub: cycles status with timers and may fail randomly per STUB_FAILURE_RATE.
 *
 * @param {string} sid - Twilio message SID
 * @param {(update: { status: 'queued'|'sent'|'delivered'|'failed', failureReason?: string }) => void} onUpdate
 */
export function subscribeToDelivery(sid, onUpdate) {
  if (BACKEND) {
    // In production, open an SSE stream. For shell purposes, leave a minimal hook
    // that the deployment can replace with its real transport.
    const es = new EventSource(`${BACKEND}/twilio/sms/${encodeURIComponent(sid)}/stream`);
    es.onmessage = (ev) => {
      try { onUpdate(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    return () => es.close();
  }
  // Stub: simulate the lifecycle.
  let cancelled = false;
  const willFail = Math.random() < STUB_FAILURE_RATE;
  const t1 = setTimeout(() => {
    if (cancelled) return;
    onUpdate({ status: 'sent' });
  }, 800);
  const t2 = setTimeout(() => {
    if (cancelled) return;
    if (willFail) {
      onUpdate({ status: 'failed', failureReason: 'Carrier rejected: number unreachable' });
    } else {
      onUpdate({ status: 'delivered' });
    }
  }, 2200);
  return () => {
    cancelled = true;
    clearTimeout(t1);
    clearTimeout(t2);
  };
}

// ────────────── Inbound SMS ──────────────

/**
 * In production, the backend hosts the webhook and forwards inbound SMS into
 * a server-sent event stream the app subscribes to. This helper opens that stream.
 * The stub provides a manual `simulateInbound()` instead — used by the
 * Integrations page's "Simulate inbound" button to exercise the routing path.
 *
 * @param {(payload: { fromPhone: string, toPhone: string, body: string, messageSid: string }) => void} onMessage
 * @returns {() => void} unsubscribe
 */
export function subscribeToInbound(onMessage) {
  if (BACKEND) {
    const es = new EventSource(`${BACKEND}/twilio/inbound/stream`);
    es.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    return () => es.close();
  }
  // Stub: nothing to subscribe to — inbound only arrives via simulateInbound().
  return () => {};
}

/**
 * Locally simulate an inbound SMS — used by the Integrations page in dev.
 * In production this isn't called; real inbound arrives via webhook.
 */
export function simulateInbound({ fromPhone, toPhone, body }) {
  return {
    fromPhone,
    toPhone,
    body,
    messageSid: `SMin${Math.random().toString(36).slice(2, 14)}`,
  };
}

// ────────────── A2P 10DLC ──────────────

/**
 * Submit A2P 10DLC brand + campaign registration.
 * Backend: POST /twilio/a2p { brandName, ein, businessAddress, useCase, sampleMessages[] }
 * Stub: validates required fields, returns { ok, status: 'pending' }.
 *
 * Note from the email: "A2P handled for you" — meaning Kronelius/SaaSassins
 * shepherds the registration on behalf of the client. The form here captures
 * the data; an admin (super admin role) flips the status to approved when
 * carriers actually approve.
 */
export async function submitA2P(payload) {
  const required = ['brandName', 'ein', 'businessAddress', 'useCase'];
  for (const k of required) {
    if (!payload[k]) throw new Error(`A2P field "${k}" is required.`);
  }
  if (!Array.isArray(payload.sampleMessages) || payload.sampleMessages.length < 1) {
    throw new Error('At least one sample message is required.');
  }
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/twilio/a2p`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`A2P submit failed (${res.status})`);
    return res.json();
  }
  await delay(STUB_DELAY_MS);
  return { ok: true, status: 'pending' };
}

// ────────────── Helpers exported for UI ──────────────
export { maskPhone, BACKEND as TWILIO_BACKEND_URL };
