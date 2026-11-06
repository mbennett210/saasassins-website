// Which session the app starts with when the phone has no signal (CS-665). Pure / node-safe.
//
// supabase-js refreshes an expired access token BEFORE it hands a session out, and a token
// lasts an hour. With no signal that refresh fails and getSession() answers "no session"
// although the session is still on the phone — so an installed app opened in a basement more
// than an hour after its last refresh went straight to the sign-in page, which needs a signal.
// The service worker brings the app itself up offline; this brings the person back with it.
//
// The phone's own session is used ONLY when the failure was the network's (no signal, or a
// refresh that could not reach the server). A refresh the server REFUSED (a revoked or
// signed-out-elsewhere session) is not a network failure, so it still means "sign in again".
// Nothing is unlocked by it: the server is the boundary and an expired token opens nothing
// there; the app shows what this phone already held. The moment the signal is back,
// supabase-js refreshes the token (TOKEN_REFRESHED) — or, if it was revoked, signs out.

// Where supabase-js keeps the session on this device (lib/supabaseClient's `storageKey`).
export const AUTH_STORAGE_KEY = 'cleanspace.auth';

// A failure that never reached the server: auth-js marks it AuthRetryableFetchError, with
// status 0 for a fetch that threw (no network) and 502/503/504 for a gateway that did not answer.
const networkFailure = (error) => !!error && (error.name === 'AuthRetryableFetchError' || error.status === 0);

const usable = (s) => !!s && typeof s === 'object' && typeof s.access_token === 'string' && !!s.access_token
  && !!s.user && typeof s.user === 'object';

// → the session to render with, or null (sign in).
//   session  what getSession() / the auth event answered
//   error    the error getSession() answered with, if any
//   online   navigator.onLine
//   stored   the session on this device (storedSession())
export function offlineSessionFallback({ session = null, error = null, online = true, stored = null } = {}) {
  if (session) return session;
  if (!(online === false || networkFailure(error))) return null;
  return usable(stored) ? stored : null;
}

export function storedSession(storage = (typeof localStorage === 'undefined' ? null : localStorage)) {
  try {
    const raw = storage ? storage.getItem(AUTH_STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    return usable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
