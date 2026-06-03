import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import { CORE, formatPrice } from '../modules.catalog';
import '../demo.css';

// Slide-in panel listing the add-on modules a prospect has added. Reachable from
// the app-wide cart FAB (DemoChrome). "Review & checkout" routes to the catch-all
// /checkout confirmation page (the Core base + add-ons). Portaled to <body> so the
// fixed overlay escapes the app's stacking contexts (same approach as Modal).

export default function CartDrawer({ open, onClose }) {
  const cart = useCart();
  const navigate = useNavigate();
  if (!open) return null;

  const goCheckout = () => {
    onClose();
    navigate('/checkout');
  };

  return createPortal(
    <div className="pp-cart-overlay" onClick={onClose}>
      <aside className="pp-cart-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Your modules">
        <header className="pp-cart-head">
          <h2>Your modules</h2>
          <button className="pp-cart-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {cart.count === 0 ? (
          <div className="pp-cart-empty">
            <span className="pp-cart-empty-icon" aria-hidden="true">🛒</span>
            <p>No add-ons yet</p>
            <p className="pp-cart-empty-sub">
              Your order already includes the {formatPrice(CORE.price)} Core platform. Add modules as you
              explore the demo — they collect here, ready for checkout.
            </p>
          </div>
        ) : (
          <ul className="pp-cart-list">
            {cart.items.map((m) => (
              <li key={m.id} className="pp-cart-row">
                <span className="pp-cart-row-icon" aria-hidden="true">{m.icon}</span>
                <div className="pp-cart-row-body">
                  <span className="pp-cart-row-name">{m.name}</span>
                  <span className="pp-cart-row-cat">{m.category}</span>
                </div>
                <span className="pp-cart-row-price">{formatPrice(m.price)}</span>
                <button
                  className="pp-cart-row-remove"
                  onClick={() => cart.remove(m.id)}
                  aria-label={`Remove ${m.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="pp-cart-foot">
          <div className="pp-summary-line">
            <span>Core platform</span>
            <span>{formatPrice(CORE.price)}</span>
          </div>
          {cart.count > 0 && (
            <div className="pp-summary-line">
              <span>Add-ons ({cart.count})</span>
              <span>{formatPrice(cart.subtotal)}</span>
            </div>
          )}
          <div className="pp-summary-total">
            <span>Total</span>
            <strong>{formatPrice(CORE.price + cart.subtotal)}</strong>
          </div>
          <button className="btn btn-primary pp-cart-checkout" onClick={goCheckout}>
            Review &amp; checkout
          </button>
          {cart.count > 0 && (
            <button className="pp-cart-clear" onClick={() => cart.clear()}>
              Clear all
            </button>
          )}
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
