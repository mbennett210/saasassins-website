// Frontend Supabase client — powers per-user auth (login/session) and the
// shared-state Realtime sync. Uses the anon/publishable key, which is safe to
// ship in the browser bundle: every read/write is governed by RLS + the signed-
// in user's session.
//
// When VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are unset, this exports null
// and the app falls back to local-only mode (no login gate, localStorage store)
// — handy for offline UI work. In a real deployment both vars are set, which
// flips the app into authenticated + shared-data mode.
import { createClient } from '@supabase/supabase-js';

const url = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SUPABASE_URL : undefined;
const anonKey = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SUPABASE_ANON_KEY : undefined;

export const supabase = url && anonKey
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'cleanspace.auth',
      },
    })
  : null;

// True when Supabase auth is configured for this build (i.e. login is required
// and data syncs to the shared backend). False → local-only fallback mode.
export const isAuthConfigured = () => Boolean(supabase);

// ── Read-only client, optionally pointed at a read replica (Increment 0.2) ──────
// Staff in Manila cross the Pacific for every read; the jobs hydrate alone is ~19
// sequential pages at ~180-200ms each. A nearer read replica cuts that materially.
//
// INERT BY DEFAULT: with VITE_SUPABASE_LB_URL unset this is literally the primary
// client, so nothing changes until a replica exists and the env var is set. Only the
// large, lag-tolerant jobs reads are routed here — org_state, auth, realtime and ALL
// writes stay on the primary, because replication lag would otherwise break
// read-your-writes on correctness-sensitive paths.
const readUrl = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SUPABASE_LB_URL : undefined;

export const supabaseRead = (readUrl && anonKey && supabase)
  ? createClient(readUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : supabase;

// CRITICAL if a replica is ever configured: a second client does NOT inherit the
// signed-in session, so RLS would evaluate it as anon and every scoped read would come
// back empty — a silent, data-shaped failure rather than an error. Mirror the primary's
// session onto it on every auth change (including TOKEN_REFRESHED, or reads start
// failing ~an hour in).
if (supabase && supabaseRead !== supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session) return;
    supabaseRead.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }).catch(() => { /* best-effort — reads fall back to failing loudly, not silently */ });
  });
}
