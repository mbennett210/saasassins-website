// TWILIO'S REQUEST SIGNATURE — the inbound text route's gate (api/sms/[...path].js).
//
// Twilio signs every webhook it sends: X-Twilio-Signature = base64(HMAC-SHA1(auth token, the full
// URL Twilio was given + each POST parameter's name and value, sorted by name)). Only a request
// that carries a signature made with OUR account's TWILIO_AUTH_TOKEN for the route's public URL is
// read; anything else is refused before a byte of it is used. No token configured = nothing is
// read (fail closed). The token is never logged, never echoed, never compared by `===`.
//
// THE URL. Twilio signs the address it was configured with, which must be the route's PUBLIC
// address (APP_PUBLIC_URL / the brand's appUrl, api/_lib/appUrl.js: today
// https://www.cleancorner.app/api/sms/inbound) — not the rewritten path Vercel hands the function
// (/api/sms/_?subpath=inbound), and never the request's own Host (test-app-links: no server file
// builds an address from the Host). A webhook set on another of the app's domains is refused.
import crypto from 'node:crypto';
import { appPublicUrl } from '../appUrl.js';

export const INBOUND_PATH = '/api/sms/inbound';
const env = (k) => String(process.env[k] || '').trim();
export const inboundAuthConfigured = () => !!env('TWILIO_AUTH_TOKEN');

// The signature Twilio would send for `url` and `params` (an object of strings).
export function twilioSignature(url, params, token) {
  const data = Object.keys(params || {}).sort().reduce((s, k) => s + k + String(params[k] ?? ''), String(url));
  return crypto.createHmac('sha1', String(token)).update(Buffer.from(data, 'utf8')).digest('base64');
}

function sameSignature(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

// The address Twilio signs for this route: the public one.
export const inboundUrl = () => `${appPublicUrl()}${INBOUND_PATH}`;

// Is this request Twilio's? `params` is the parsed form body.
export function twilioSignatureValid(req, params) {
  const token = env('TWILIO_AUTH_TOKEN');
  const given = req?.headers?.['x-twilio-signature'];
  if (!token || typeof given !== 'string' || !given) return false;
  return sameSignature(twilioSignature(inboundUrl(), params, token), given);
}

// THE GATE. → true when the request may be read; otherwise the refusal is written (503 when no
// auth token is configured, 403 for a missing or wrong signature) and the caller stops. The answer
// names nothing.
export function requireTwilioSignature(req, res, params) {
  if (!inboundAuthConfigured()) {
    res.status(503).json({ error: 'Texting is not set up.' });
    return false;
  }
  if (!twilioSignatureValid(req, params)) {
    res.status(403).json({ error: 'Forbidden.' });
    return false;
  }
  return true;
}
