// PUBLIC — the sign-in page's "Forgot password?" (Daniel, 2026-10-16: "Do it from alerts@"; CS-122).
// The person can't sign in, so no session is read here and none is needed.
//
// AUTH STANCE: public — no login and no token; the caller only names an address. What that may cause
// is what is bounded: a reset email goes ONLY to a login that may sign in now (_lib/users.js
// loginMayResetOwnPassword: not banned, not the customer hub preview's reserved address, and admitted
// by _lib/authz.js admissionOf — a Disabled team member, a claim-less login no roster row carries, a
// customer whose row is gone or holds no access: none), ONLY from the Google system sender, ONLY to
// that login's own address, and it is the office's own reset email through the one function the
// member page's reset uses (users.js sendPasswordResetLink, WITHOUT the office's hand-over: the
// one-time link is never answered, logged or stored). Rate-limited per visitor IP and per address
// (_lib/rateLimit.js; per instance and fail-open, as that module says); never cached (`no-store`).
//
//   POST /api/public/auth/forgot  { email }  →  200 FORGOT_ANSWER  (EP-413)
//
// 🔴 THE ANSWER NEVER SAYS WHETHER AN ADDRESS HAS A LOGIN. An unknown address, a banned login, a
// customer without access, the preview stand-in, a Disabled member, no sender connected, a failure on
// our side and a real send all answer the same 200 body (src/lib/passwordReset.js FORGOT_ANSWER) after
// the same minimum time (FORGOT_MIN_MS), so neither the body nor the timing tells them apart. Only a
// malformed address (400 bad-email) and the allowance (429 rate-limited) answer otherwise, and neither
// depends on the address having a login. The link lands on the app's own /login (appPublicUrl(), never
// this request's Host), the recovery landing the office's reset uses.
import { createHash } from 'node:crypto';
import { allow, clientIp } from '../../_lib/rateLimit.js';
import { sendPasswordResetLink, loginMayResetOwnPassword } from '../../_lib/users.js';
import { appPublicUrl } from '../../_lib/appUrl.js';
import { LINK_NOT_SENT } from '../../../src/lib/signInLink.js';
import {
  FORGOT_ANSWER, FORGOT_MIN_MS, FORGOT_RATE, FORGOT_RATE_LIMITED_CODE, FORGOT_BAD_EMAIL_CODE, forgotEmail,
} from '../../../src/lib/passwordReset.js';

// The floor every answer to a well-formed address waits out. Only the test suite moves it, through the
// seam below (test-forgot-password-route.mjs); nothing in the app calls it.
let minMs = FORGOT_MIN_MS;
export function __setForgotMinMsForTests(ms) { minMs = ms == null ? FORGOT_MIN_MS : Math.max(0, Number(ms) || 0); }

// The JSON body, whatever arrived: the platform parses JSON, a text body is parsed here, anything
// else (no body, a body that is not an object, JSON that does not parse) reads as no address.
function bodyOf(req) {
  let b;
  try { b = req.body; } catch { return {}; }
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return {}; } }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

// The per-address allowance is kept under a digest, so the limiter's memory holds no address.
const addressKey = (email) => createHash('sha256').update(email).digest('hex').slice(0, 32);

// A server line never carries an address or a link, whatever an error's words were.
const scrub = (s) => String(s || '').replace(/https?:\/\/\S+/gi, '[link]').replace(/[^\s@'"<>]+@[^\s@'"<>]+/g, '[address]');

export default async function handler(req, res) {
  const started = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  const path = (typeof req.query?.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query?.path) ? req.query.path
      : (req.query?.path ? String(req.query.path).split('/').filter(Boolean) : []);
  if (path.length !== 1 || path[0] !== 'forgot') return res.status(404).json({ error: 'Not found.', code: 'not-found' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST is supported here.', code: 'method-not-allowed' });

  // Per visitor first, before anything is read; then per address, the digest of the address the
  // request names (an address with no login counts the same as one with a login).
  if (!allow(req, res, { bucket: 'forgot_ip', id: clientIp(req), ...FORGOT_RATE.perIp, code: FORGOT_RATE_LIMITED_CODE })) return undefined;
  const email = forgotEmail(bodyOf(req).email);
  if (!email) return res.status(400).json({ error: 'Enter a full email address.', code: FORGOT_BAD_EMAIL_CODE });
  if (!allow(req, res, { bucket: 'forgot_email', id: addressKey(email), ...FORGOT_RATE.perEmail, code: FORGOT_RATE_LIMITED_CODE })) return undefined;

  try {
    const out = await sendPasswordResetLink(email, `${appPublicUrl()}/login`, { admit: loginMayResetOwnPassword });
    if (out?.ok && out.emailed === false) {
      console.warn(out.why === LINK_NOT_SENT.notSetUp
        ? '[api/public/auth] forgot: no reset email sent — no system sender is connected (Settings → Integrations)'
        : `[api/public/auth] forgot: the reset email could not be sent (${out.why})`);
    }
  } catch (e) {
    // The person reads the same answer; the detail is logged, with no address or link in it.
    console.error('[api/public/auth] forgot', e?.code || e?.name || 'error', scrub(e?.message));
  }
  const wait = minMs - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
  return res.status(200).json(FORGOT_ANSWER);
}
