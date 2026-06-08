import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { CORE, formatPrice, featuredModules } from '../modules.catalog';
import { themeLabel, loadBrand, saveBrand, PALETTES } from '../brandTheme';
import CheckoutThemeSelect from '../components/CheckoutThemeSelect';
import ModuleCTA from '../components/ModuleCTA';
import '../demo.css';

// /polishpoint/checkout — confirms the order (Core base + selected add-ons + the
// chosen brand style), offers any modules not yet added, and completes the
// purchase. Always renders in the clean PolishPoint look; the brand-style choice
// is shown via faithful swatchboard example images (CheckoutThemeSelect) and
// recorded as a deployment preference — it does not reskin anything.
//
// Flow (top → bottom in the left column, with the order summary sticky on the
// right): 1) review the Core base + any added modules, 2) add more modules from a
// compact checklist, 3) pick the brand style — the last step before paying.
//
// Payment (LIVE): "Pay" POSTs the selected add-on ids + the chosen brand theme
// (label + stable key + hex) to /api/checkout, which creates a Stripe Checkout
// Session from SERVER-SIDE prices and returns a hosted-checkout URL we redirect
// to. The theme is a $0 choice — it rides along as order metadata so fulfilment
// knows which styling direction the client wants.
// In LOCAL DEV only (import.meta.env.DEV) — where there's no /api server — the
// flow falls back to a simulated success so the UX stays testable without a
// backend. In production a failure surfaces a real error; it never fakes a sale.

export default function CheckoutPage() {
  const company = selectCompany(useStore());
  const cart = useCart();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [deployTheme, setDeployTheme] = useState(loadBrand().deployTheme || 'blue');

  const chooseTheme = (key) => {
    setDeployTheme(key);
    saveBrand({ deployTheme: key });
  };

  const notInCart = featuredModules().filter((m) => !cart.has(m.id));
  const total = CORE.price + cart.subtotal;

  const pay = async () => {
    setSubmitting(true);
    setError('');

    // The brand theme is a $0 styling choice — sent as order metadata, not a line
    // item. Capture the display label + the STABLE key + hex so fulfilment is
    // unambiguous even if a label is later renamed.
    const brandTheme = themeLabel(deployTheme);
    const brandThemeKey = deployTheme;
    const brandThemeHex = (PALETTES[deployTheme] || {}).swatch || '';

    // Local-dev-only fallback: vite has no /api server, so complete to a simulated
    // success page to keep the checkout UX testable without a backend.
    const simulate = () => {
      const order = {
        items: [
          { name: CORE.name, price: CORE.price },
          ...cart.items.map((m) => ({ name: m.name, price: m.price })),
        ],
        total,
        brandTheme,
      };
      navigate('/checkout/success', { state: { demo: true, order } });
    };

    try {
      // Only add-on ids go up; the server always adds the Core base line item.
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleIds: cart.ids, brandTheme, brandThemeKey, brandThemeHex }),
      });

      if (res.ok) {
        const { url } = await res.json().catch(() => ({}));
        if (url) {
          window.location.href = url; // real Stripe hosted checkout
          return;
        }
        throw new Error('Could not start checkout — no URL returned.');
      }

      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Checkout failed (${res.status}).`);
    } catch (err) {
      // In local dev (no backend), simulate so the demo flow stays testable.
      // In production, never fake a sale — surface the failure to the buyer.
      if (import.meta.env.DEV) {
        simulate();
        return;
      }
      setError(err.message || 'Checkout is temporarily unavailable. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="pp-demo-page">
      <header className="pp-demo-topbar">
        <span className="pp-demo-topbar-brand">
          {company.name}
          <span className="pp-addon-badge">Checkout</span>
        </span>
        <div className="pp-demo-topbar-actions">
          <button className="pp-link-muted" onClick={() => navigate('/demo')}>← Back to demo</button>
        </div>
      </header>

      <div className="pp-demo-wrap">
        <div className="pp-section-head">
          <div className="pp-section-head-text">
            <h2>Confirm your order</h2>
            <p>Every order includes the {formatPrice(CORE.price)} Core platform. Add or remove modules below, then pick your brand style before you pay.</p>
          </div>
        </div>

        <div className="pp-checkout-grid">
          <div>
            <div className="pp-checkout-main">
              {/* Core platform — the mandatory base line item, not removable. */}
              <div className="pp-checkout-row pp-checkout-row-core">
                <span className="pp-checkout-row-icon" aria-hidden="true">🚀</span>
                <div className="pp-checkout-row-body">
                  <div className="pp-checkout-row-name">{CORE.name}</div>
                  <div className="pp-checkout-row-desc">The full operations suite — included in every plan.</div>
                </div>
                <span className="pp-checkout-row-price">{formatPrice(CORE.price)}</span>
                <span className="pp-addon-badge">Included</span>
              </div>

              {cart.items.map((m) => (
                <div key={m.id} className="pp-checkout-row">
                  <span className="pp-checkout-row-icon" aria-hidden="true">{m.icon}</span>
                  <div className="pp-checkout-row-body">
                    <div className="pp-checkout-row-name">{m.name}</div>
                    <div className="pp-checkout-row-desc">{m.blurb}</div>
                  </div>
                  <span className="pp-checkout-row-price">{formatPrice(m.price)}</span>
                  <button
                    className="pp-cart-row-remove"
                    onClick={() => cart.remove(m.id)}
                    aria-label={`Remove ${m.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {notInCart.length > 0 && (
              <section className="pp-demo-section">
                <div className="pp-section-head">
                  <div className="pp-section-head-text">
                    <h2>Add more before you go</h2>
                    <p>Round out your setup with another module.</p>
                  </div>
                </div>
                {/* Compact checklist (not the big card grid) so the add-on list
                    stays tidy. Each row reuses ModuleCTA's real add-to-cart logic. */}
                <div className="pp-addon-list">
                  {notInCart.map((m) => (
                    <ModuleCTA key={m.id} moduleId={m.id} variant="row" />
                  ))}
                </div>
              </section>
            )}

            {/* Final step: pick the brand style. Persistent themed dashboard
                preview re-themes live on toggle; the checkout itself stays
                clean PolishPoint. */}
            <CheckoutThemeSelect value={deployTheme} onChange={chooseTheme} />
          </div>

          <aside className="pp-checkout-summary">
            <h3>Order summary</h3>
            <div className="pp-summary-line">
              <span>{CORE.name}</span>
              <span>{formatPrice(CORE.price)}</span>
            </div>
            {cart.items.map((m) => (
              <div key={m.id} className="pp-summary-line">
                <span>{m.name}</span>
                <span>{formatPrice(m.price)}</span>
              </div>
            ))}
            <div className="pp-summary-total">
              <span>Total (one-time)</span>
              <strong>{formatPrice(total)}</strong>
            </div>
            <div className="pp-summary-line pp-summary-meta">
              <span>Brand theme</span>
              <span>{themeLabel(deployTheme)}</span>
            </div>
            {error && <div className="pp-checkout-error">{error}</div>}
            <button
              className="btn btn-primary btn-lg pp-pay-btn"
              disabled={submitting}
              onClick={pay}
            >
              {submitting ? 'Starting checkout…' : `Pay ${formatPrice(total)}`}
            </button>
            <p className="pp-checkout-note">
              Secure one-time payment via Stripe. You’ll be redirected to complete your purchase.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
