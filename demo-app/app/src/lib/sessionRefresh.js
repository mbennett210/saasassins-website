// When the app returns to the foreground after being away, pull a fresh Supabase
// token so a role change made while this tab was hidden — a demotion, most of all —
// reaches the UI instead of waiting out the ~1h JWT auto-refresh. The whole app is
// claims-first (the UI renders from `app_metadata.role`) while the server enforces the
// role LIVE (authz.js getClaims → auth.getUser), so a stale token only misleads the
// client: a just-demoted Super Admin keeps the owner screens until the token catches up.
//
// RoleSyncBanner already refreshes once when the token role and the ROSTER role split —
// but that needs the roster change to have reached this device (the org_state realtime
// signal), which a backgrounded / asleep tab may miss. This resume refresh is the
// complement: it doesn't depend on any signal arriving, only on the user coming back.
//
// The decision is pure so it's unit-testable (scripts/test-session-refresh.mjs); the
// DOM wiring (visibilitychange / pageshow / focus) lives in auth/AuthProvider.jsx.

// Don't refresh on a quick tab flick — only after a real absence. A demotion is rare
// and refreshSession rotates the refresh token, so this trades a little staleness on a
// brief switch for not hammering refresh on every focus.
export const RESUME_REFRESH_AWAY_MS = 60_000;

// Should returning to the foreground trigger a token refresh?
//   visibilityState  document.visibilityState at the resume event ('visible' to act)
//   hiddenSince      epoch ms the tab last went hidden, or 0/null if it never did
//   now              epoch ms now
//   hasSession       there is a signed-in session to refresh (skip on the login screen)
//   refreshing       a refresh this helper started is still in flight (coalesces the
//                    focus + visibilitychange double-fire into one refresh)
//   awayMs           the absence threshold (override in tests)
export function shouldRefreshOnResume({
  visibilityState, hiddenSince, now, hasSession, refreshing, awayMs = RESUME_REFRESH_AWAY_MS,
}) {
  if (visibilityState !== 'visible') return false; // a hidden→hidden or blur event, not a resume
  if (!hasSession || refreshing) return false;
  if (!hiddenSince) return false;                  // never went away → nothing to catch up on
  return now - hiddenSince >= awayMs;
}
