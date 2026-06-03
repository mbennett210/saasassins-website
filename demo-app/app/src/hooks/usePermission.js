import { useStore } from '../store';
import { selectCurrentUser, selectPermissions, selectUserPermissionOverrides } from '../store/selectors';
import { can } from '../lib/roles';

export function usePermission(permKey) {
  const state = useStore();
  const user = selectCurrentUser(state);
  const permissions = selectPermissions(state);
  const overrides = selectUserPermissionOverrides(state);
  return can(user, permKey, permissions, overrides);
}

// Hook returning a checker function you can call with many keys, useful in lists.
export function usePermissionChecker() {
  const state = useStore();
  const user = selectCurrentUser(state);
  const permissions = selectPermissions(state);
  const overrides = selectUserPermissionOverrides(state);
  return (key) => can(user, key, permissions, overrides);
}
