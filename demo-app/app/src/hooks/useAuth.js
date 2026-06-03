import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectCurrentUser } from '../store/selectors';

export function useAuth() {
  const state = useStore();
  const dispatch = useDispatch();
  const currentUser = selectCurrentUser(state);

  const setCurrentUser = (id) => dispatch({ type: ACTIONS.SET_CURRENT_USER, id });

  return { currentUser, setCurrentUser };
}
