import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import { CORE, formatPrice, featuredModules } from '../modules.catalog';
import ModuleCTA from '../components/ModuleCTA';
import { BRAND } from '../../brand.config';
import '../demo.css';

// /polishpoint/checkout — the final catch-all. Confirms the prospect's order (the
// Core platform base + any selected add-ons, editable here), offers any modules
// they haven't added, and starts a real one-time Stripe Checkout via the
// /api/checkout serverless function, which maps ids → server-side Stripe prices
// (always including Core) and returns a hosted-Checkout URL to redirect to.

export default function CheckoutPage() {
  const cart = useCart();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const notInCart = featuredModules().filter((m) => !cart.has(m.id));
  const total = CORE.price + cart.subtotal;

  const pay = async () => {
    setSubmitting(true);
    setError('');
    try {
      // Only add-on ids go up; the server always adds the Core base line item.
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleIds: cart.ids }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Checkout failed (${res.status})`);
      }
      const { url } = await res.json();
      if (!url) throw new Error('No checkout URL returned.');
      window.location.href = url; // → Stripe-hosted Checkout
    } catch (e) {
      setError(e.message || 'Something went wrong starting checkout.');
      setSubmitting(false);
    }
  };

  return (
    <div className="pp-demo-page">
      <header className="pp-demo-topbar">
        <span className="pp-demo-topbar-brand">
          {BRAND.name}
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
