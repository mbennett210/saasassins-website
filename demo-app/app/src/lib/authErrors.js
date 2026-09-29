// Human-friendly sign-in messaging.
//
// WHY THIS EXISTS: Supabase's raw auth errors are terse and technical ("Invalid
// login credentials") and the login form used to surface them verbatim — so a user
// who mistyped a password, one whose invite was never activated, and one who got
// rate-limited all saw the same opaque line, with no idea which to fix. This maps the
// real failure to a clear, actionable sentence. Pure + dependency-free so it is unit-
// tested (scripts/test-auth-errors.mjs) and safe to import into the pre-store Login.
//
// Shown to a user who was bounced to /login by an EXPIRED session (not a wrong
// password) — the "stale session" case, kept distinct so the message is honest.
export const SESSION_EXPIRED_MESSAGE =
  'Your session expired for your security. Please sign in again to continue.';

// Map a Supabase AuthError (or any {message, code, status}) to a clear message.
export function friendlyAuthError(err) {
  if (!err) return 'Sign in failed. Please try again.';
  const code = String(err.code || '').toLowerCase();
  const status = Number(err.status || err.statusCode || 0);
  const msg = String(err.message || '').toLowerCase();

  // Wrong email or password — the overwhelmingly common case. Newer Supabase
  // returns code 'invalid_credentials'; older builds only the message.
  if (code === 'invalid_credentials'
      || msg.includes('invalid login credentials')
      || msg.includes('invalid credentials')) {
    return 'The email or password is incorrect. Double-check both. If you’ve forgotten your password, use “Forgot password?” below.';
  }
  // Account provisioned but the invite / setup link was never completed.
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed') || msg.includes('not confirmed')) {
    return 'This account isn’t activated yet. Check your email for the setup link, or ask your administrator to resend your invite.';
  }
  // Rate limited — too many attempts, or reset requested too often.
  if (status === 429 || code.includes('rate') || code.includes('over_')
      || msg.includes('rate limit') || msg.includes('too many') || msg.includes('you can only request')) {
    return 'Too many attempts. Please wait a minute, then try again.';
  }
  // Network / server unreachable (fetch failed, timeout, 5xx).
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed')
      || msg.includes('timeout') || msg.includes('timed out') || status >= 500) {
    return 'Couldn’t reach the server. Check your connection and try again in a moment.';
  }
  // Auth backend not configured (local/dev without Supabase env).
  if (msg.includes('not configured')) {
    return 'Sign-in isn’t available right now. Please contact your administrator.';
  }
  // Unknown — surface the original only if it reads like a human sentence,
  // otherwise a safe generic line (never a stack trace or code).
  const raw = String(err.message || '').trim();
  return raw && raw.length <= 120 ? raw : 'Sign in failed. Please try again.';
}
