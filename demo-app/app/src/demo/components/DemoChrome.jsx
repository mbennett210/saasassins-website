import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import CartDrawer from './CartDrawer';
import '../demo.css';

// App-wide demo chrome: a floating Cart button + drawer. Mounted once from
// App.jsx behind IS_DEMO, inside the Router (it reads the current path) and the
// CartProvider.
//
// The Cart FAB is hidden on surfaces that present the cart their own way — the
// marketing landing ('/', whose topbar already has a Cart button) and the
// /checkout flow. It rides along across the interactive app (the /demo dashboard
// + inner CRM pages) so a prospect can review their selected modules from
// anywhere in the product.
//
// NOTE: the prospect-facing concierge ("Ask") widget is temporarily removed.
// Its components/libs are left in place (demo/assistant/*, lib/demoAssistant.js,
// api/assistant.js) so it can be re-mounted here later.

export default function DemoChrome() {
  const [open, setOpen] = useState(false);
  const cart = useCart();
  const { pathname } = useLocation();

  const hideFab = pathname === '/' || pathname.startsWith('/checkout');

  return (
    <>
      {!hideFab && (
        <button className="pp-cart-fab" onClick={() => setOpen(true)} aria-label="Open your cart">
          <span className="pp-cart-fab-icon" aria-hidden="true">🛒</span>
          <span className="pp-cart-fab-label">Cart</span>
          {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
        </button>
      )}
      <CartDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}
