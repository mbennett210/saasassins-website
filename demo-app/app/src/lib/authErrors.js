// Human-friendly sign-in messaging.
//
// WHY THIS EXISTS: Supabase's raw auth errors are terse and technical ("Invalid
// login credentials") and the login form used to surface them verbatim — so a user
// who mistyped a password, one whose invite was never activated, and one who got
// rate-limited all saw the same opaque line, with no idea which to fix. This maps the
// real failure to a clear, actionable sentence. Pure + dependency-free so it is unit-
// tested (scripts/test-auth-errors.mjs) and safe to import into the pre-store Login.
//
//
// LANGUAGES (CS-193): every sentence is a catalog line (src/i18n/catalog/en.js `login.*`).
// The sign-in screen passes its own `t` so the person reads it in their language; without
// one (a test, a log) it is the English.
import { english } from '../i18n/core.js';
import { FORGOT_BAD_EMAIL_CODE, FORGOT_RATE_LIMITED_CODE } from './passwordReset.js';

// Shown to a user who was bounced to /login by an EXPIRED session (not a wrong
// password) — the "stale session" case, kept distinct so the message is honest.
export const SESSION_EXPIRED_KEY = 'login.sessionExpired';
export const SESSION_EXPIRED_MESSAGE = english(SESSION_EXPIRED_KEY);

// Map a Supabase AuthError (or any {message, code, status}) to a clear message.
export function friendlyAuthError(err, t = english) {
  if (!err) return t('login.error.generic');
  const code = String(err.code || '').toLowerCase();
  const status = Number(err.status || err.statusCode || 0);
  const msg = String(err.message || '').toLowerCase();

  // Wrong email or password — the overwhelmingly common case. Newer Supabase
  // returns code 'invalid_credentials'; older builds only the message.
  if (code === 'invalid_credentials'
      || msg.includes('invalid login credentials')
      || msg.includes('invalid credentials')) {
    return t('login.error.credentials');
  }
  // Account provisioned but the invite / setup link was never completed.
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed') || msg.includes('not confirmed')) {
    return t('login.error.notActivated');
  }
  // Rate limited — too many attempts, or reset requested too often.
  if (status === 429 || code.includes('rate') || code.includes('over_')
      || msg.includes('rate limit') || msg.includes('too many') || msg.includes('you can only request')) {
    return t('login.error.tooMany');
  }
  // Network / server unreachable (fetch failed, timeout, 5xx).
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed')
      || msg.includes('timeout') || msg.includes('timed out') || status >= 500) {
    return t('login.error.unreachable');
  }
  // Auth backend not configured (local/dev without Supabase env).
  if (msg.includes('not configured')) {
    return t('login.error.unavailable');
  }
  // Unknown — surface the original only if it reads like a human sentence,
  // otherwise a safe generic line (never a stack trace or code). The original is the
  // auth service's own English; it is shown as it came.
  const raw = String(err.message || '').trim();
  return raw && raw.length <= 120 ? raw : t('login.error.generic');
}

// The "Forgot password?" request's failures (lib/passwordReset.js requestPasswordReset): a malformed
// address, the reset allowance (an hour per address and per network, so not the sign-in's "wait a
// minute"), else the sign-in mapping (the server unreachable, sign-in not set up…). A success is never
// here: every address gets the one neutral answer, login.resetSent.
export function friendlyResetError(err, t = english) {
  const code = String(err?.code || '');
  if (code === FORGOT_BAD_EMAIL_CODE) return t('login.badEmail');
  if (code === FORGOT_RATE_LIMITED_CODE || Number(err?.status) === 429) return t('login.resetTooMany');
  return friendlyAuthError(err, t);
}
