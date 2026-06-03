import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import CartDrawer from './CartDrawer';
import '../demo.css';

// App-wide demo chrome: a floating cart button that opens the cart drawer while a
// prospect explores the CRM. Hidden on the standalone /demo + /checkout surfaces,
// which present the cart their own way. Mounted once from App.jsx behind IS_DEMO,
// inside the Router (it reads the current path) and the CartProvider.

export default function DemoChrome() {
  const [open, setOpen] = useState(false);
  const cart = useCart();
  const { pathname } = useLocation();

  const hideFab = pathname.startsWith('/demo') || pathname.startsWith('/checkout');

  return (
    <>
      {!hideFab && (
        <button className="pp-cart-fab" onClick={() => setOpen(true)} aria-label="Open your modules cart">
          <span className="pp-cart-fab-icon" aria-hidden="true">🛒</span>
          <span className="pp-cart-fab-label">Modules</span>
          {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
        </button>
      )}
      <CartDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
