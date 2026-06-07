import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import CartDrawer from './CartDrawer';
// CONCIERGE STASHED (2026-06-07): the prospect-facing AI chat widget is disabled
// for now. The import + mount below are commented out — all concierge code
// (assistant/ConciergeWidget.jsx, assistant/conciergeKnowledge.js, lib/demoAssistant.js,
// api/assistant.js) is left intact, so re-enabling is just uncommenting these two lines.
// import ConciergeWidget from '../assistant/ConciergeWidget';
import '../demo.css';

// App-wide demo chrome: a floating cart button + drawer. (The product concierge
// chat widget is temporarily stashed — see the comment above.) Mounted once from
// App.jsx behind IS_DEMO, inside the Router (it reads the current path) and the
// CartProvider.
//
// The cart FAB is hidden on the landing ('/') and checkout surfaces (which present
// the cart their own way), and shown across the live app (/demo + every CRM page)
// where a prospect is actually adding modules.

export default function DemoChrome() {
  const [open, setOpen] = useState(false);
  const cart = useCart();
  const { pathname } = useLocation();

  const hideFab = pathname === '/' || pathname.startsWith('/checkout');

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
      {/* CONCIERGE STASHED — re-enable by uncommenting the import + this mount:
      <ConciergeWidget onOpenCart={() => setOpen(true)} /> */}
    </>
  );
}
