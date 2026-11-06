// THE SIGN-IN PAGE'S "Forgot password?" (Daniel, 2026-10-16: "Do it from alerts@"; CS-122). PURE and
// node-safe: the public route (api/public/auth, EP-413) and the browser (pages/Login.jsx through
// auth/AuthProvider.jsx) read the same path, allowance, codes and address rule from here, so the two
// halves can never disagree on what is asked or how it is refused.
//
// The reset email leaves from the app's Google SYSTEM SENDER (api/_lib/email.js) and is the office's
// own reset email, through the one function the member page's reset uses (api/_lib/users.js
// sendPasswordResetLink). It no longer comes from Supabase's built-in mailer
// (`supabase.auth.resetPasswordForEmail`): its setup was never verified, and by default it delivers
// only to the Supabase project's own team.
//
// 🔴 THE ANSWER NEVER SAYS WHETHER AN ADDRESS HAS A LOGIN. Every well-formed address gets the same 200
// and the same body (FORGOT_ANSWER) after the same minimum time (FORGOT_MIN_MS): an unknown address, a
// banned login, a Disabled member, a customer without access, the hub preview's stand-in, email not set
// up, a failure on the server, or a real send. The page then says what is true for all of them
// (login.resetSent: "If that email has an account…").

// The route, under the app's backend base (`/api` unless VITE_FORMS_BACKEND_URL names another).
export const FORGOT_PATH = '/public/auth/forgot';

// The one body every well-formed address is answered with.
export const FORGOT_ANSWER = Object.freeze({ ok: true });

// Every answer to a well-formed address waits until this long after the request arrived, so the time
// taken does not tell a real send (a GoTrue lookup, a roster read, a link, a Gmail send: about a
// second) from an address with no login (one lookup). The button reads "Sending…" meanwhile.
export const FORGOT_MIN_MS = 2000;

// The allowance (api/_lib/rateLimit.js `allow`: per serverless instance and fail-open, as that module
// says — a durable limit needs a table, which is not built). Per address: a person who did not get
// the email can ask twice more, and more than three reset emails an hour to one inbox is mail-bombing
// it (each new link also voids the last, so a fourth would not help them). Per network: one person
// needs a few taps; a script walking addresses from one IP stops after ten, and every ask costs a
// scan of the logins. The office's own reset (a member's page) is not counted here.
export const FORGOT_RATE = Object.freeze({
  perIp: Object.freeze({ limit: 10, windowMs: 60 * 60 * 1000 }),
  perEmail: Object.freeze({ limit: 3, windowMs: 60 * 60 * 1000 }),
});

// The two refusals, each a stable code beside a sentence (neither depends on the address having a login).
export const FORGOT_RATE_LIMITED_CODE = 'rate-limited';
export const FORGOT_BAD_EMAIL_CODE = 'bad-email';

// RFC 5321's limit on a forward path.
export const FORGOT_EMAIL_MAX = 254;
// One whole address: no space or line break, one @, a dotted domain, and none of the characters that
// would make it two addresses or a header (comma, semicolon, angle brackets, parentheses, quotes).
const EMAIL_SHAPE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

// The address a request names, trimmed and lower-cased (GoTrue keeps addresses lower-cased), or '' when
// it is not one whole address.
export function forgotEmail(raw) {
  if (typeof raw !== 'string') return '';
  const email = raw.trim().toLowerCase();
  return email.length <= FORGOT_EMAIL_MAX && EMAIL_SHAPE.test(email) ? email : '';
}

// ── the browser's half ─────────────────────────────────────────────────────────
// A direct NAMED read of the one env key, the form every client adapter uses (lib/teamApi.js): Vite
// inlines only that key, never the whole env object (CS-398).
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

// Ask the route to email a reset to `email`. No session and no Authorization header: the person can't
// sign in. Resolves { error: null } for the one answer every address gets, else { error } in the shape
// lib/authErrors reads ({ status, code, message }): a malformed address (400), the allowance (429), the
// server, or no signal. Never throws.
export async function requestPasswordReset(email, { fetchImpl = globalThis.fetch, backend = BACKEND } = {}) {
  let res;
  try {
    res = await fetchImpl(`${backend}${FORGOT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: typeof email === 'string' ? email.trim() : '' }),
    });
  } catch (e) {
    return { error: { message: String(e?.message || 'Failed to fetch') } };
  }
  if (res.ok) return { error: null };
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return {
    error: {
      status: res.status,
      code: typeof body?.code === 'string' ? body.code : null,
      message: typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`,
    },
  };
}
