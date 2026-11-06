import { useMemo } from 'react';
import { useStore } from '../store';
import { useAuth } from './useAuth';
import { timeScopeFor } from '../lib/timeRules';

// The signed-in user's manager time scope (spec §2 / §4.1) for the Approvals, Time Clock and
// Variance surfaces. Identity comes from useAuth().currentUser — the SAME claims-first resolver
// the rest of the app renders from (store/identity.js; the demo user-switcher sets it too) — so
// this can never disagree with who the server authorizes.
//
// Returns:
//   scope      null (owner/admin: everything) | Set<clientId> the manager supervises (may be empty;
//              an Operations Manager's is their team's, lib/teamScope)
//   unscoped   scope === null
//   clientIds  null when unscoped, else the customer ids as an array (for passing to reads / options)
//   siteIds    null when unscoped, else the site ids at those customers (TimeClockHistory scoping)
//   user       the resolved current user (for the own-time rule)
// An empty Set (a manager assigned no customers) is DISTINCT from null: clientIds is [] and the
// surfaces show the "no locations assigned" state rather than reading company-wide.
export function useTimeScope() {
  const state = useStore();
  const { currentUser } = useAuth();
  const clients = state.clients;
  const sites = state.sites;
  const users = state.users;
  return useMemo(() => {
    // The roster rides along so an Operations Manager's scope is their team (S131) — the server's
    // own rule (api/time passes the committed roster the same way).
    const scope = timeScopeFor(currentUser, clients || [], users || []);
    const unscoped = scope === null;
    const clientIds = unscoped ? null : [...scope];
    const siteIds = unscoped
      ? null
      : (sites || []).filter((s) => s && s.clientId != null && scope.has(s.clientId)).map((s) => s.id);
    return { scope, unscoped, clientIds, siteIds, user: currentUser };
  }, [currentUser, clients, sites, users]);
}

export default useTimeScope;
