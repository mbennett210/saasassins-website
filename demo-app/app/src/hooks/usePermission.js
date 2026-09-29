import { useSelector } from '../store';
import { selectCurrentUser, selectPermissions, selectUserPermissionOverrides } from '../store/selectors';
import { can } from '../lib/roles';

// Increment 0.4: these hooks are called from nearly every gated component, so on the
// whole-snapshot useStore() they re-ran — and re-rendered their caller — on EVERY
// dispatch, including ones touching nothing they read. Selecting the three inputs
// individually means a permission check only re-renders when a permission input
// actually moves, which is rare.
//
// All three are safe with the DEFAULT Object.is comparer, and it is worth stating why,
// because getting this wrong is exactly the trap store/selectionCache.js guards:
//   selectCurrentUser             .find() -> an existing element BY REFERENCE (or null)
//   selectPermissions             s.permissions BY REFERENCE
//   selectUserPermissionOverrides s.userPermissionOverrides BY REFERENCE
//
// ⚠️ The overrides selector's fallback used to be a bare `|| []`, which allocates a
// fresh array per call when the key is ABSENT — stable WITHIN a snapshot (so it could
// not loop) but different across snapshots, i.e. a re-render on every dispatch and no
// gain whatsoever. It was safe only because the key is present in both the seed and the
// live blob, so the branch never fired — a data invariant holding up a code guarantee.
//
// That is now FIXED rather than merely noted: the selector falls back to the shared
// frozen EMPTY_ARRAY (store/selectors.js), so it returns a stable reference in BOTH
// branches and no longer depends on the invariant. Found by
// scripts/test-selector-benefit.mjs, which now fails the build on any allocating
// selector reached through useSelector without a comparer.

export function usePermission(permKey) {
  const user = useSelector(selectCurrentUser);
  const permissions = useSelector(selectPermissions);
  const overrides = useSelector(selectUserPermissionOverrides);
  return can(user, permKey, permissions, overrides);
}

// Whether the current user may create, edit, reschedule, re-crew or delete jobs: the UI
// twin of the server's jobs guard (api/_lib/jobsGuard.js), tier for tier. schedule.edit,
// held by owner / admin, or by a manager whose id resolved (the server can't apply a
// manager's overrides without it, so it keeps nothing of theirs); never crew or any
// other role, whatever they are granted (owner's call, 2026-09-23). So no one gets a
// job-edit control that looks saved and quietly reverts. This is the claim-role gate
// Schedule used to hold alone: the current user's role IS the claim role whenever the
// login carries one (store/identity.js), and a login without one is judged by its roster
// role, as the server judges it. Owner + admin always write jobs on the server; the UI
// still follows the key for them, which can only hide a control the server would keep.
// Gate every job-writing control on this, not on the key alone.
export function useCanEditJobs() {
  const user = useSelector(selectCurrentUser);
  const holds = usePermission('schedule.edit');
  if (!holds) return false;
  if (user?.role === 'owner' || user?.role === 'admin') return true;
  return user?.role === 'manager' && typeof user.id === 'string' && user.id !== '';
}

// Hook returning a checker function you can call with many keys, useful in lists.
export function usePermissionChecker() {
  const user = useSelector(selectCurrentUser);
  const permissions = useSelector(selectPermissions);
  const overrides = useSelector(selectUserPermissionOverrides);
  // Deliberately NOT memoized. `can` is a pure lookup and this closure is invoked
  // inline during render, so a fresh identity costs nothing. A useCallback would only
  // matter if it were passed to a memoized child, and there is exactly one React.memo
  // in the codebase.
  return (key) => can(user, key, permissions, overrides);
}
