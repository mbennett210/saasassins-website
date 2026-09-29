// Tracks the Supabase auth session for the whole app. When Supabase isn't
// configured (no VITE_SUPABASE_* env), runs in "local mode": no session is
// required and the app behaves like the old localStorage-only prototype.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, isAuthConfigured } from '../lib/supabaseClient';
import { shouldRefreshOnResume } from '../lib/sessionRefresh';
import { setTerminalAuthHandler } from '../lib/stateApi';
import { terminalAuthMessage } from '../lib/terminalAuth';
import { unsubscribeCurrentDevice } from '../lib/push';
import { clearCache } from '../store/offlineCache';
import { flushSyncBeforeSignOut, markSyncCacheWipeForSignOut, unmarkSyncCacheWipeForSignOut } from '../store/sync';
import { flushClockQueues } from '../lib/offlineFlush';
import { clearGateMemo } from '../lib/checklistGateMemo';

const SessionCtx = createContext(null);

export function AuthProvider({ children }) {
  const configured = isAuthConfigured();
  const [session, setSession] = useState(null);
  // In local mode there's nothing to wait for, so we're never "loading".
  const [loading, setLoading] = useState(configured);
  // True when the user arrives via a password-reset link, so /login shows a
  // set-new-password form instead of bouncing them into the app. Seeded from
  // the URL hash synchronously so it's set before getSession() resolves.
  const [recovery, setRecovery] = useState(
    () => typeof window !== 'undefined' && /[#&]type=recovery\b/.test(window.location.hash || '')
  );
  // An expired/already-used reset link comes back as an error hash
  // (#error=...&error_description=...), NOT a recovery hash — capture it so the
  // user gets a clear message instead of a blank sign-in form.
  const [authError, setAuthError] = useState(() => {
    if (typeof window === 'undefined') return '';
    const h = window.location.hash || '';
    if (!/[#&]error/.test(h)) return '';
    const p = new URLSearchParams(h.replace(/^#/, ''));
    return (p.get('error_description') || p.get('error') || 'This link is invalid or has expired.').trim();
  });
  // Distinguish an INVOLUNTARY session loss (token expired / revoked → the Supabase SDK
  // signs the user out mid-use) from a deliberate Sign out. Only the former should tell
  // the user "your session expired" on the login screen — the "stale session" case.
  const [sessionExpired, setSessionExpired] = useState(false);
  // Set when the SERVER refuses a write because this login can no longer act — its roster
  // status is disabled/inactive (`account-disabled`) or it's no longer on the team
  // (`not-on-team`). Distinct from an expired session: it carries a specific message and,
  // like sessionExpired, surfaces on the login screen after the forced sign-out below.
  const [accountDisabled, setAccountDisabled] = useState(null); // null | { code, message }
  const wasAuthedRef = useRef(false);   // have we EVER held a session this load?
  const signingOutRef = useRef(false);  // is the in-flight SIGNED_OUT user-initiated?

  useEffect(() => {
    if (!supabase) return undefined;
    let mounted = true;
    // Never let a hung or failed getSession() strand the app on the loading
    // screen during a Supabase/DB blip. Resolve `loading` on success, on error,
    // OR after a hard timeout — after which the route guard sends the user to
    // /login to retry instead of showing a frozen "Loading…".
    const settle = (s) => { if (!mounted) return; if (s) wasAuthedRef.current = true; setSession(s ?? null); setLoading(false); };
    const failsafe = setTimeout(() => { if (mounted) setLoading(false); }, 8000);
    supabase.auth.getSession()
      .then(({ data }) => settle(data?.session ?? null))
      .catch(() => settle(null))
      .finally(() => clearTimeout(failsafe));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return;
      setSession(s ?? null);
      setLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (s) { wasAuthedRef.current = true; setSessionExpired(false); }
      if (event === 'SIGNED_OUT') {
        // A sign-out we did NOT initiate, for a user who WAS signed in, is an expiry.
        if (wasAuthedRef.current && !signingOutRef.current) setSessionExpired(true);
        wasAuthedRef.current = false;
        signingOutRef.current = false;
      }
    });
    return () => { mounted = false; clearTimeout(failsafe); sub.subscription.unsubscribe(); };
  }, []);

  // Resume refresh: when the app comes back to the foreground after being away, pull a
  // fresh token so a role change made while this tab was hidden (a demotion, above all)
  // reaches the UI without waiting out the ~1h auto-refresh. The server already enforces
  // the live role; this only realigns what the client renders. Complements RoleSyncBanner,
  // which needs the roster signal a backgrounded tab may miss. Pure decision in
  // lib/sessionRefresh; here is only the DOM wiring. `refreshSession` emits TOKEN_REFRESHED
  // → onAuthStateChange above → setSession → the new app_metadata.role flows through.
  const sessionRef = useRef(null);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    if (!supabase) return undefined;
    let hiddenSince = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? Date.now() : 0;
    let refreshing = false;
    const resume = () => {
      const ok = shouldRefreshOnResume({
        visibilityState: document.visibilityState,
        hiddenSince,
        now: Date.now(),
        hasSession: !!sessionRef.current,
        refreshing,
      });
      // Clear the away-marker on every foreground event, so a later focus with no
      // intervening hide can't re-trigger. Keep it while still hidden.
      if (document.visibilityState === 'visible') hiddenSince = 0;
      if (!ok) return;
      refreshing = true;
      Promise.resolve(supabase.auth.refreshSession())
        .catch(() => { /* best-effort: offline, or a revoked token → onAuthStateChange handles SIGNED_OUT */ })
        .finally(() => { refreshing = false; });
    };
    const onVis = () => { if (document.visibilityState === 'hidden') hiddenSince = Date.now(); else resume(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
    };
  }, []);

  // Terminal-auth sign-out. When a server write comes back 403 account-disabled /
  // not-on-team (lib/terminalAuth.js), this login can no longer act — the sync manager
  // would otherwise retry the same 403 every ~5s and show a stuck "offline". stateApi
  // fires this handler; we sign out with a clear message. Built on the deliberate-sign-out
  // machinery: reuse signingOutRef so the SIGNED_OUT isn't mistaken for an expired session
  // and a manual Sign out already in flight isn't doubled. It's a LEAN teardown — no
  // unsynced-edit confirm (the writes 403 now, so there's nothing to save and no choice to
  // offer) and no offline-punch flush (that would 403 too). Complements the S86 resume
  // refresh (a token that returns SIGNED_OUT); this covers a still-valid token whose
  // account was disabled server-side.
  useEffect(() => {
    if (!supabase) return undefined; // local/demo mode never reaches a server 403
    const onTerminalAuth = async (code) => {
      if (signingOutRef.current) return;         // a sign-out is already underway — never stack
      signingOutRef.current = true;
      setAccountDisabled({ code, message: terminalAuthMessage(code) });
      try { markSyncCacheWipeForSignOut(); } catch { /* ignore */ }
      try { await unsubscribeCurrentDevice(); } catch { /* ignore */ }
      try { await clearCache(); } catch { /* ignore */ }
      let res;
      try { res = await supabase.auth.signOut(); } catch (e) { res = { error: e }; }
      // On success, SIGNED_OUT (onAuthStateChange) resets signingOutRef and drops us to the
      // login screen, where accountDisabled renders. On failure (network), un-latch so the
      // next terminal answer can retry, and un-mark the wipe — same as the manual path.
      if (res?.error) {
        signingOutRef.current = false;
        try { unmarkSyncCacheWipeForSignOut(); } catch { /* ignore */ }
      }
    };
    setTerminalAuthHandler(onTerminalAuth);
    return () => setTerminalAuthHandler(null);
  }, []);

  const value = useMemo(() => ({
    configured,
    loading,
    session,
    user: session?.user ?? null,
    signIn: (email, password) =>
      supabase
        ? supabase.auth.signInWithPassword({ email: email.trim(), password })
        : Promise.resolve({ error: { message: 'Auth is not configured.' } }),
    signOut: async () => {
      // Re-entrancy: a second Sign out tap during the (up to 15s) flush window
      // must not start a parallel teardown / stack a second confirm dialog.
      if (signingOutRef.current) return { error: null, cancelled: true };
      // Mark this as a DELIBERATE sign-out so the SIGNED_OUT event isn't mistaken for
      // an expired session (which would wrongly warn the user they were kicked out).
      signingOutRef.current = true;
      // 🔴 FLUSH (and offer the Cancel) BEFORE ANY TEARDOWN. clearCache() below
      // destroys the LAST copy of any not-yet-synced edit (unsaved blob actions
      // + unmirrored schedule rows) — "log out and back in and they are all
      // gone" (Lauren, 2026-08-13). Push everything local through a final
      // bounded flush first; if something still can't reach the server, make
      // the loss an informed CHOICE, not a silent one. Cancel must land before
      // unsubscribeCurrentDevice(), or the "safe" option silently kills push
      // notifications for a still-signed-in user (nothing re-subscribes).
      // 15s: longer than one stalled org-state write (12s timeout), so a save
      // that is actually about to land isn't reported as lost.
      let syncedClean = true;
      try { syncedClean = await flushSyncBeforeSignOut(15000); } catch { syncedClean = false; }
      if (!syncedClean && typeof window !== 'undefined') {
        const proceed = window.confirm(
          'Some of your latest changes may not have reached the server yet '
          + '(weak connection). Sign out anyway and risk losing them?\n\n'
          + 'Choose Cancel to stay signed in and let them finish syncing.',
        );
        if (!proceed) {
          signingOutRef.current = false;
          return { error: null, cancelled: true };
        }
      }
      // Tear down this device's push subscription BEFORE dropping the session
      // (the backend resolves the owner from the still-valid auth token), so the
      // next person on this device never receives the signed-out user's pushes.
      // Best-effort — a push hiccup must never block sign-out.
      try { await unsubscribeCurrentDevice(); } catch { /* ignore */ }
      // From here the wipe is committed: stop the sync manager from ever
      // repopulating the cache (an abandoned finalFlush attempt can settle
      // AFTER clearCache and would otherwise write doc+queue+pending back
      // into IndexedDB on a signed-out, possibly shared device).
      try { markSyncCacheWipeForSignOut(); } catch { /* ignore */ }
      // Drop this device's offline WORKSPACE cache (org-wide data, re-fetched on next
      // sign-in — safe to clear). But try to SYNC buffered clock punches first and
      // never wipe any that remain un-synced: that would silently lose the crew's
      // labor. Un-synced punches stay per-user (the replay identity check + mergeBuffered
      // keep them inert/invisible to a different signed-in user) until their owner returns.
      try { await clearCache(); } catch { /* ignore */ }
      // Flush the buffered CHECKLISTS and then the buffered PUNCHES, while the departing
      // user's token is still valid.
      // 🔴 THROUGH THE ORDERED PUMP (lib/offlineFlush), never flushOfflineQueue alone. On
      // a shared phone the end of a shift IS a sign-out, so this is the flush that carries
      // the day's work: punches first would land a replayed clock-out before the checklist
      // that finished the clean, and the entry would be flagged "checklist not finished at
      // clock-out" on a clean that was finished.
      // Pass no crew id: the punch owner id is a blob u_* id (not the Supabase auth uuid we
      // have here), so filtering by session.user.id would match nothing and flush nothing.
      // With no filter the server enforces identity from the token — the departing user's
      // punches sync; any other user's are held (identityMismatch), never wiped.
      try { await flushClockQueues(); } catch { /* ignore */ }
      // The clock-out gate's remembered verdicts name WHO finished WHICH checklist on
      // WHICH clean (lib/checklistGateMemo) — per-crew-member, so they leave with their
      // owner on a shared phone (SEC-23 / DATA-62). Unlike a buffered punch there is
      // nothing to lose: the verdict is re-derivable from the server on the next read.
      try { clearGateMemo(); } catch { /* ignore */ }
      // AWAITED, with an error reset: auth-js resolves { error } WITHOUT emitting
      // SIGNED_OUT on a network failure, so nothing downstream would ever reset
      // signingOutRef — every later Sign out tap silently no-ops via the
      // re-entrancy guard, and the still-signed-in session would be left with
      // persistence latched off. Un-latch + reset so the user can retry.
      let res;
      try {
        res = supabase ? await supabase.auth.signOut() : { error: null };
      } catch (e) {
        // auth-js can THROW (not just resolve {error}) — e.g. a lock-acquisition
        // failure. Same reset, or the ref/latch wedge the comment above names.
        res = { error: e };
      }
      if (res?.error) {
        signingOutRef.current = false;
        try { unmarkSyncCacheWipeForSignOut(); } catch { /* ignore */ }
      }
      return res;
    },
    sendPasswordReset: (email) =>
      supabase
        ? supabase.auth.resetPasswordForEmail(email.trim(), {
            redirectTo: `${window.location.origin}/login`,
          })
        : Promise.resolve({ error: { message: 'Auth is not configured.' } }),
    updatePassword: (password) =>
      supabase
        ? supabase.auth.updateUser({ password })
        : Promise.resolve({ error: { message: 'Auth is not configured.' } }),
    recovery,
    clearRecovery: () => setRecovery(false),
    authError,
    clearAuthError: () => setAuthError(''),
    sessionExpired,
    clearSessionExpired: () => setSessionExpired(false),
    accountDisabled,
    clearAccountDisabled: () => setAccountDisabled(null),
  }), [configured, loading, session, recovery, authError, sessionExpired, accountDisabled]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error('useSession must be used inside <AuthProvider>');
  return ctx;
}
