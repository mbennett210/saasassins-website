// Server-side verification of the Supabase auth session: WHO holds this token.
// Routes never gate on it directly. They go through authz.js (requireAuthority and
// the gates built on it), which adds the claims AND the roster status, so a member set
// to Disabled is refused on every server route. (Not by Supabase itself: reads under
// the open read RLS, and writes to storage buckets whose policies admit any signed-in
// user, end only with the login ban.) The bare session gate `requireAuth` was removed
// 2026-09-23 when its last five callers moved onto requireAuthority, and
// test-disabled-authority.mjs fails the build on a route that imports or calls
// getAuthUser / getClaims itself. Public routes (HMAC inbound webhook, token-scoped
// public pay / public qc) intentionally do NOT use this — they self-verify.
import { createClient } from '@supabase/supabase-js';

let anonClient = null;
function getAnonClient() {
  if (anonClient) return anonClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  anonClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return anonClient;
}

function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Returns the authenticated Supabase user, or null if the bearer token is
// missing/invalid/expired.
export async function getAuthUser(req) {
  const token = bearer(req);
  if (!token) return null;
  try {
    const { data, error } = await getAnonClient().auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}
