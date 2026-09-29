// Terminal auth answers on the server-mediated write path.
//
// WHY THIS EXISTS: the server (requireAuthority, app/api/_lib/authz.js) answers a
// write with HTTP 403 + `{ error, code }` when the login can no longer act at all —
// its roster status is `disabled`/`inactive` (`account-disabled`), or the login
// isn't on the roster the org lists (`not-on-team`). That is a REAL answer, not a
// transport hiccup: the write can never succeed until an owner re-enables the
// account. The client used to classify it as a transport failure (any 403 without a
// field-guard `violations` list), so `stateApi` fell back to the direct write and the
// sync manager retried every ~5s forever — the app showed "offline" instead of
// telling the user their account was disabled and signing them out.
//
// This module is the SINGLE SOURCE OF TRUTH for that classification and its user
// message. It is deliberately DEPENDENCY-FREE (no supabase client, no import.meta) so
// it imports cleanly under plain node and is unit-tested directly
// (scripts/test-terminal-auth.mjs) — stateApi.js itself can't be node-imported (its
// Vite-only extensionless imports), which is exactly why the decision lives here and
// not inline. stateApi wires it into the write path; AuthProvider maps the code to the
// sign-out message.

// The 403 `code` values that mean "this login is done and must sign out". Anything
// NOT in this set stays classified as before (a `violations` 403 is the field guard;
// any other 403, and every 4xx/5xx/transport error, still falls back to the direct
// write pre-1e). Keeping the set tiny is the guard against over-broadening: a generic
// 403 must not sign anyone out.
export const TERMINAL_AUTH_CODES = new Set(['account-disabled', 'not-on-team']);

// Pure classifier. Given an HTTP status and the parsed JSON body, return the terminal
// auth code the server sent, or null. ONLY a 403 whose `code` is a known terminal code
// qualifies — a field-guard 403 (which carries `violations`, not a terminal `code`), a
// bare 403, a 401, and any transport failure all return null and keep today's behaviour.
export function terminalAuthCode(status, payload) {
  if (status !== 403 || !payload || typeof payload !== 'object') return null;
  const code = payload.code;
  return TERMINAL_AUTH_CODES.has(code) ? code : null;
}

// The message shown on the sign-in screen after a terminal sign-out. One line per code;
// the default covers `account-disabled` and any future terminal code without a blank
// screen. Kept here so the code→message mapping has one home and is unit-testable.
export const ACCOUNT_DISABLED_MESSAGE =
  'This account has been disabled — contact an owner.';
export const NOT_ON_TEAM_MESSAGE =
  'This account is no longer on the team — contact an owner.';

export function terminalAuthMessage(code) {
  if (code === 'not-on-team') return NOT_ON_TEAM_MESSAGE;
  return ACCOUNT_DISABLED_MESSAGE; // 'account-disabled' and any other terminal code
}
