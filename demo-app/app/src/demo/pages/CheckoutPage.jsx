import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { CORE, formatPrice, featuredModules } from '../modules.catalog';
import ModuleCTA from '../components/ModuleCTA';
import ThemePicker from '../components/ThemePicker';
import '../demo.css';

// /polishpoint/checkout — confirms the order (Core base + selected add-ons),
// offers any modules not yet added, and completes the purchase.
//
// Payment: if a Stripe key is wired (api/checkout returns a hosted-checkout URL)
// we redirect to it. Otherwise — the usual demo case, with no backend — we
// simulate a completed order and route to the success page, so the flow is fully
// clickable end to end without a card. A genuine Stripe failure still surfaces.

export default function CheckoutPage() {
  const company = selectCompany(useStore());
  const cart = useCart();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const notInCart = featuredModules().filter((m) => !cart.has(m.id));
  const total = CORE.price + cart.subtotal;

  const pay = async () => {
    setSubmitting(true);
    setError('');
    const order = {
      items: [
        { name: CORE.name, price: CORE.price },
        ...cart.items.map((m) => ({ name: m.name, price: m.price })),
      ],
      total,
    };
    const goSuccess = () => navigate('/checkout/success', { state: { demo: true, order } });

    let res;
    try {
      // Only add-on ids go up; the server always adds the Core base line item.
      res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleIds: cart.ids }),
      });
    } catch {
      goSuccess(); // no backend reachable (local demo) → simulate a completed order
      return;
    }

    if (res.ok) {
      const { url } = await res.json().catch(() => ({}));
      if (url) {
        window.location.href = url; // real Stripe Checkout
        return;
      }
      goSuccess();
      return;
    }

    // 404 (no endpoint) / 503 (no Stripe key) → payments aren't wired; simulate.
    if (res.status === 404 || res.status === 503) {
      goSuccess();
      return;
    }

    // Stripe is configured but the call genuinely failed — surface it.
    const body = await res.json().catch(() => ({}));
    setError(body.error || `Checkout failed (${res.status})`);
    setSubmitting(false);
  };

  return (
    <div className="pp-demo-page">
      <header className="pp-demo-topbar">
        <span className="pp-demo-topbar-brand">
          {company.name}
          <span className="pp-addon-badge">Checkout</span>
        </span>
        <div className="pp-demo-topbar-actions">
          <button className="pp-link-muted" onClick={() => navigate('/')}>← Back to demo</button>
        </div>
      </header>

      <div className="pp-demo-wrap">
        <div className="pp-section-head">
          <div className="pp-section-head-text">
            <h2>Confirm your order</h2>
            <p>Every order includes the {formatPrice(CORE.price)} Core platform. Add or remove modules below before you pay.</p>
          </div>
        </div>

        <ThemePicker />

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
                <div className="pp-module-grid">
                  {notInCart.map((m) => (
                    <ModuleCTA key={m.id} moduleId={m.id} variant="card" />
                  ))}
                </div>
              </section>
            )}
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
