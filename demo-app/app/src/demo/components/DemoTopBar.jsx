import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { brandAssetUrl } from '../../lib/brandAssetUrl';
import Icon from '../../components/Icon';
import NotificationsBell from '../../components/NotificationsBell';
import CartDrawer from './CartDrawer';
import '../demo.css';

// Persistent demo app bar — a slim bar across the very top of the live app so a
// prospect always has a way BACK to the modules landing and into their cart.
// Mirrors the landing's top bar so the chrome feels continuous when they click
// "Enter live demo." Mounted in AppLayout behind IS_DEMO (so it only rides the
// in-app routes, never the standalone landing/checkout).
//
// Top-left = a back affordance to the modules landing: a thick blue arrow + the
// brand logo (no text label). Top-right = the cart CTA + notifications bell.
//
// Two cart entry points, both opening the same drawer (→ Review & checkout):
//   1. the app-bar cart — the bar's primary CTA (filled), top-right; and
//   2. a floating FAB bottom-right — a white circle (blue ring) with the brand-blue
//      cart icon that gives a gentle left/right tilt every ~4s to draw the eye.
// There's no separate Checkout button; you check out from the cart drawer.
//
// It toggles `body.pp-has-appbar` while mounted; that class shifts the app chrome
// (sidebar, mobile header, main padding) down to clear this fixed bar and hides
// the now-duplicate sidebar brand. The notifications bell folds into the bar (the
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
        </button>

        <div className="pp-demo-appbar-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm pp-demo-cartbtn pp-appbar-cartbtn"
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

      {/* Always-in-thumb-reach cart, bottom-right — white circle with a blue ring,
          brand-blue cart icon, gentle tilt every ~4s. Opens the same drawer. */}
      <button
        type="button"
        className="pp-demo-cartfab"
        onClick={() => setCartOpen(true)}
        aria-label="Open your cart"
      >
        <Icon name="cart" size={22} />
        {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
      </button>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </>
  );
}
