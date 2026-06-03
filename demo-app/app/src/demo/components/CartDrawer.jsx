import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import { formatPrice } from '../modules.catalog';
import '../demo.css';

// Slide-in panel listing the modules a prospect has added. Reachable from the
// app-wide cart FAB (DemoChrome). "Review & checkout" routes to the catch-all
// /checkout confirmation page. Portaled to <body> so the fixed overlay escapes
// the app's stacking contexts (same approach as the shared Modal).

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
            <p>No modules yet</p>
            <p className="pp-cart-empty-sub">
              Add featured modules as you explore the demo — they collect here, ready for checkout.
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
          <div className="pp-cart-subtotal">
            <span>Subtotal</span>
            <strong>{formatPrice(cart.subtotal)}</strong>
          </div>
          <button className="btn btn-primary pp-cart-checkout" disabled={cart.count === 0} onClick={goCheckout}>
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
