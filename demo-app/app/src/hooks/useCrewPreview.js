import { useAuth } from './useAuth';

// The owner's "View as" a cleaner (components/UserSwitcher): the cleaner's app draws as that
// person, but the SERVER still sees the owner's login, so a clock-in, a checklist, a supply
// request or a completed request would be written as the owner. While previewing, every write
// control in the cleaner's app is disabled and one line says whose app this is (plan
// docs/plans/2026-10-13-cleaner-hub.md §3). The login-free demo switches the user for real
// (SET_CURRENT_USER), so it is never a preview.
//
// `userId` is the person on screen — what a read that serves an office preview names
// (`?userId=`; the server honours it only for an office login holding the screen's office key).
export function useCrewPreview() {
  const { currentUser, authenticatedUser, viewAsUserId } = useAuth();
  const previewing = !!(viewAsUserId && currentUser && authenticatedUser && currentUser.id !== authenticatedUser.id);
  return {
    previewing,
    name: previewing ? (currentUser?.name || '') : '',
    userId: currentUser?.id || null,
  };
}
