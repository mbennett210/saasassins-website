import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectCurrentUser, selectAuthenticatedUser } from '../store/selectors';
import { useSession } from '../auth/AuthProvider';

// App-level identity. In authed (Supabase) mode the current user is whoever
// signed in — the sync manager stamps state.currentUserId from the session
// email, so selectCurrentUser resolves to the right team member and the whole
// permission system keeps working unchanged.
//
// VIEW-AS: an owner may switch the UI perspective to any team member via
// setViewAs (selectors.selectCurrentUser honors it). It is VIEW-ONLY — the
// server still enforces the real owner claim (app_metadata), so this cannot
// escalate privilege; it only re-renders the app from that role's perspective.
// `authenticatedUser` is always the real login; `currentUser` reflects the
// active (possibly viewed-as) perspective. setCurrentUser remains for the
// local-mode demo user-switcher.
export function useAuth() {
  const state = useStore();
  const dispatch = useDispatch();
  const { signOut, configured, user } = useSession();
  const currentUser = selectCurrentUser(state);
  const authenticatedUser = selectAuthenticatedUser(state);
  const viewAsUserId = state.viewAsUserId || null;
  const setCurrentUser = (id) => dispatch({ type: ACTIONS.SET_CURRENT_USER, id });
  const setViewAs = (id) => dispatch({ type: ACTIONS.SET_VIEW_AS, id });
  // The role the SERVER enforces (JWT app_metadata claim). The roster role
  // above is what the UI renders from — the two are separate authorities and
  // can split (2026-07-30 incident). Surfaces that trigger server-refused
  // writes (e.g. job creates, which the jobs guard silently drops for
  // non-manager claims) must gate on THIS, or the tab shows phantom successes.
  const claimRole = user?.app_metadata?.role ?? null;
  return { currentUser, authenticatedUser, viewAsUserId, setCurrentUser, setViewAs, signOut, authConfigured: configured, claimRole };
}
