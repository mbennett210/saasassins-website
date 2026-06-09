import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { brandAssetUrl } from '../../lib/brandAssetUrl';
import NotificationsBell from '../../components/NotificationsBell';
import CartDrawer from './CartDrawer';
import '../demo.css';

// Persistent demo app bar — a slim bar across the very top of the live app so a
// prospect always has a way BACK to the modules landing and into their cart.
// Mirrors the landing's top bar so the chrome feels continuous when they click
// "Enter live demo." Mounted in AppLayout behind IS_DEMO (so it only rides the
// in-app routes, never the standalone landing/checkout).
//
// The cart icon is the single commerce entry point: it opens the cart drawer,
// which carries the order total + the "Review & checkout" button. (No separate
// top-level Checkout button — you check out from the cart, the standard pattern.)
//
// It toggles `body.pp-has-appbar` while mounted; that class shifts the app chrome
// (sidebar, mobile header, main padding) down to clear this fixed bar and hides
// the now-duplicate sidebar brand. The notifications bell folds in here (the
// bell-floater + mobile-header bell are hidden in the demo — see AppLayout).
//
// (This is also the natural mount point if the prospect-facing concierge widget,
// currently parked, is re-added later.)
export default function DemoTopBar() {
  const company = selectCompany(useStore());
  const cart = useCart();
  const navigate = useNavigate();
  const [cartOpen, setCartOpen] = useState(false);

  useEffect(() => {
    document.body.classList.add('pp-has-appbar');
    return () => document.body.classList.remove('pp-has-appbar');
  }, []);

  return (
    <>
      <header className="pp-demo-appbar">
        <button
          type="button"
          className="pp-demo-appbar-back"
          onClick={() => navigate('/')}
          aria-label="Back to modules"
        >
          <span className="pp-demo-appbar-arrow" aria-hidden="true">←</span>
          {company.logoUrl ? (
            <img className="pp-demo-appbar-logo" src={brandAssetUrl(company.logoUrl)} alt={company.name} />
          ) : (
            <span className="pp-demo-appbar-name">{company.name}</span>
          )}
          <span className="pp-demo-appbar-label">Modules</span>
        </button>

        <div className="pp-demo-appbar-actions">
          <button
            type="button"
            className="btn btn-outline btn-sm pp-demo-cartbtn"
            onClick={() => setCartOpen(true)}
            aria-label="Open your cart"
          >
            <span aria-hidden="true">🛒</span>
            <span className="pp-demo-appbar-cartword">&nbsp;Cart</span>
            {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
          </button>
          <NotificationsBell />
        </div>
      </header>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </>
  );
}
