// friendlyAuthError maps Supabase auth failures to clear, actionable messages so the
// login form never shows an opaque line again (2026-08-03: David couldn't tell a wrong
// password from a system fault). lib/authErrors.js is dependency-free → imported direct.
//
//   node scripts/test-auth-errors.mjs
import { friendlyAuthError, SESSION_EXPIRED_MESSAGE } from '../src/lib/authErrors.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`✖ ${n}`); } };
const has = (s, sub) => s.toLowerCase().includes(sub);

// ── wrong password / email (code AND legacy message shapes) ─────────────────────
ok('invalid_credentials code → "incorrect"',
  has(friendlyAuthError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }), 'incorrect'));
ok('legacy "Invalid login credentials" message → "incorrect"',
  has(friendlyAuthError({ message: 'Invalid login credentials' }), 'incorrect'));
ok('wrong-password message points to Forgot password',
  has(friendlyAuthError({ code: 'invalid_credentials' }), 'forgot password'));

// ── unactivated invite ──────────────────────────────────────────────────────────
ok('email_not_confirmed → activation guidance',
  has(friendlyAuthError({ code: 'email_not_confirmed', message: 'Email not confirmed' }), 'activated'));

// ── rate limit ──────────────────────────────────────────────────────────────────
ok('429 status → wait/try again',
  has(friendlyAuthError({ status: 429, message: 'Request rate limit reached' }), 'too many'));
ok('"you can only request this after" → rate-limit message',
  has(friendlyAuthError({ message: 'For security purposes, you can only request this after 39 seconds' }), 'too many'));

// ── network / server ─────────────────────────────────────────────────────────────
ok('Failed to fetch → connection message', has(friendlyAuthError({ message: 'Failed to fetch' }), 'connection'));
ok('500 status → connection message', has(friendlyAuthError({ status: 500, message: 'Internal Server Error' }), 'connection'));

// ── degenerate inputs never leak a technical string ─────────────────────────────
ok('null error → safe generic', friendlyAuthError(null) === 'Sign in failed. Please try again.');
ok('a 400-char garbage message is NOT echoed', friendlyAuthError({ message: 'x'.repeat(400) }) === 'Sign in failed. Please try again.');
ok('a short unknown human message passes through', friendlyAuthError({ message: 'Signups are disabled' }) === 'Signups are disabled');

// ── the stale-session constant is distinct + mentions signing in again ──────────
ok('SESSION_EXPIRED_MESSAGE says expired + sign in again',
  has(SESSION_EXPIRED_MESSAGE, 'expired') && has(SESSION_EXPIRED_MESSAGE, 'sign in again'));
ok('expired message is NOT the wrong-password message',
  SESSION_EXPIRED_MESSAGE !== friendlyAuthError({ code: 'invalid_credentials' }));

console.log(`\n${pass}/${pass + fail} auth-error cases green`);
process.exit(fail ? 1 : 0);
