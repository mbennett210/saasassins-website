import { useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useSelector } from '../store';
import { selectCurrentUserBlobRole } from '../store/selectors';
import { supabase } from '../lib/supabaseClient';

// Canary + self-heal for a claim-vs-roster role split. Since 2026-08-03 the app
// resolves identity + role CLAIMS-FIRST (the UI trusts the claim, matching the
// server), so a split is not a functional lockout — it signals a stale/missing
// roster row (a CAS-race orphan, a dashboard-edited claim, a duplicate identity),
// OR a just-changed role whose new token the client hasn't refreshed yet.
//
// SELF-HEAL (Sept 3): when the two disagree, pull a fresh token ONCE so the
// client's claim catches up to a just-changed role without a manual re-login. The
// server already enforces the new role live (getClaims → live getUser), and
// per-user grants are read live from the blob on both sides — so this only closes
// the client's ~1h token-refresh lag for a ROLE change. One-shot per distinct
// (claim, roster) pair so it can never loop: after one refresh the token is
// current, and if the split persists it is a stale BLOB (not a stale token),
// which this cannot and must not keep retrying.
//
// We compare against selectCurrentUserBlobRole — NOT currentUser.role, which now
// reflects the claim and so could never disagree.
export default function RoleSyncBanner() {
  const { claimRole, authConfigured } = useAuth();
  const blobRole = useSelector(selectCurrentUserBlobRole);
  const split = !!(authConfigured && claimRole && claimRole !== blobRole);

  const refreshedFor = useRef(null);
  useEffect(() => {
    if (!split || !supabase) return;
    const key = `${claimRole}|${blobRole}`;
    if (refreshedFor.current === key) return; // already tried this exact split
    refreshedFor.current = key;
    supabase.auth.refreshSession().catch(() => { /* best-effort; banner still informs */ });
  }, [split, claimRole, blobRole]);

  if (!split) return null;
  return (
    <div
      role="alert"
      style={{
        background: 'var(--color-semantic-warning-50)', color: 'var(--color-semantic-warning-700)',
        borderBottom: '1px solid var(--color-semantic-warning-400)',
        padding: '6px 16px', fontSize: 13, fontWeight: 600, textAlign: 'center',
      }}
    >
      Your team roster is being updated (roster shows “{blobRole || 'none'}”, your access is “{claimRole}”).
      Your access is correct; the roster will catch up shortly, or an owner can re-save your role in Settings → Team.
    </div>
  );
}
