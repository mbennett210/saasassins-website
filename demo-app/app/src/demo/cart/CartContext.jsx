// Demo cart — a self-contained context for the modules a prospect wants to buy.
//
// Deliberately NOT part of the core store: it lives in its own localStorage key
// (`pp.demo.cart.v1`) so it never entangles with the shell's version-gated state
// schema (currently pp.store.v38) and disappears cleanly with the rest of the
// demo layer. Mirrors the store's useReducer + persist-on-change pattern for
// consistency. Modules are one-time purchases, so the cart is a set of unique
// module ids — no quantities.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { getModule } from '../modules.catalog';

const STORAGE_KEY = 'pp.demo.cart.v1';

const CartStateCtx = createContext(null);
const CartApiCtx = createContext(null);

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ids: [] };
    const parsed = JSON.parse(raw);
    // Drop unknown ids (catalog may have changed) and de-dupe.
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((id) => getModule(id)) : [];
    return { ids: [...new Set(ids)] };
  } catch {
    return { ids: [] };
  }
}

function reducer(state, action) {
  switch (action.type) {
    case 'ADD':
      if (state.ids.includes(action.id) || !getModule(action.id)) return state;
      return { ids: [...state.ids, action.id] };
    case 'REMOVE':
      return { ids: state.ids.filter((id) => id !== action.id) };
    case 'TOGGLE':
      if (state.ids.includes(action.id)) return { ids: state.ids.filter((id) => id !== action.id) };
      return getModule(action.id) ? { ids: [...state.ids, action.id] } : state;
    case 'CLEAR':
      return { ids: [] };
    default:
      return state;
  }
}

export function CartProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const first = useRef(true);

  // Persist on every change; skip the initial render (state was just loaded).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota exceeded / private mode — silently drop */
    }
  }, [state]);

  const api = useMemo(
    () => ({
      add: (id) => dispatch({ type: 'ADD', id }),
      remove: (id) => dispatch({ type: 'REMOVE', id }),
      toggle: (id) => dispatch({ type: 'TOGGLE', id }),
      clear: () => dispatch({ type: 'CLEAR' }),
    }),
    [],
  );

  return (
    <CartStateCtx.Provider value={state}>
      <CartApiCtx.Provider value={api}>{children}</CartApiCtx.Provider>
    </CartStateCtx.Provider>
  );
}

// Inert cart returned when there's no provider (e.g. a non-demo product build),
// so consumers never have to null-check. Demo UI is gated on IS_DEMO regardless.
const INERT_CART = {
  ids: [],
  items: [],
  count: 0,
  subtotal: 0,
  has: () => false,
  add() {},
  remove() {},
  toggle() {},
  clear() {},
};

export function useCart() {
  const state = useContext(CartStateCtx);
  const api = useContext(CartApiCtx);
  if (!state || !api) return INERT_CART;

  const items = state.ids.map(getModule).filter(Boolean);
  const subtotal = items.reduce((sum, m) => sum + m.price, 0);
  return {
    ids: state.ids,
    items,
    count: items.length,
    subtotal,
    has: (id) => state.ids.includes(id),
    ...api,
  };
}
