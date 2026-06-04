import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import CartDrawer from './CartDrawer';
import ConciergeWidget from '../assistant/ConciergeWidget';
import '../demo.css';

// App-wide demo chrome: a floating cart button + drawer, and the prospect-facing
// product concierge. Mounted once from App.jsx behind IS_DEMO, inside the Router
// (it reads the current path) and the CartProvider.
//
// The cart FAB is hidden on the standalone /demo + /checkout surfaces (which
// present the cart their own way), but the concierge rides along everywhere — the
// /demo landing is exactly where a prospect is most likely to have questions. The
// concierge can open the cart drawer, so the drawer's open state lives here and is
// handed to it via onOpenCart.

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
      <ConciergeWidget onOpenCart={() => setOpen(true)} />
    </>
  );
}
