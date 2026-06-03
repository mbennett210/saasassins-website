import { createContext, useContext, useEffect, useReducer, useRef } from 'react';
import { reducer } from './reducer';
import { loadState, saveState } from './persist';
import { INITIAL_STATE } from '../data/seed';

const StateCtx    = createContext(null);
const DispatchCtx = createContext(null);

function init() {
  const persisted = loadState();
  if (persisted && persisted.version === INITIAL_STATE.version) {
    return persisted;
  }
  return INITIAL_STATE;
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const firstRender = useRef(true);

  // Persist on every change (skip the very first render — state was either loaded or seed).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    saveState(state);
  }, [state]);

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>
        {children}
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useStore() {
  const s = useContext(StateCtx);
  if (s === null) throw new Error('useStore must be used inside <StoreProvider>');
  return s;
}

export function useDispatch() {
  const d = useContext(DispatchCtx);
  if (d === null) throw new Error('useDispatch must be used inside <StoreProvider>');
  return d;
}

// Convenience — select a slice via a selector function. Re-renders on every state change
// (acceptable for a localStorage-scale prototype; swap for memoized selector libs if needed).
export function useSelect(selector) {
  const s = useStore();
  return selector(s);
}

export { ACTIONS } from './reducer';
