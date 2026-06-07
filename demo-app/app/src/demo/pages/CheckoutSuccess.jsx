import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { formatPrice } from '../modules.catalog';
import '../demo.css';

// /polishpoint/checkout/success — landing after checkout completes. Clears the
// cart once. Two arrival paths:
//   • Real Stripe redirect → ?session_id=...; we fetch the session from
//     /api/checkout and render a real receipt (items, total, email).
//   • Local-dev simulated path → router state { demo:true, order }; renders the
//     recap with a "no payment processed" note.

export default function CheckoutSuccess() {
  const company = selectCompany(useStore());
  const cart = useCart();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [params] = useSearchParams();

  const sessionId = params.get('session_id');
  const simulated = Boolean(state && state.demo);
  const [order, setOrder] = useState(simulated ? state.order : null);
  const [loading, setLoading] = useState(Boolean(sessionId) && !simulated);

  // Order complete — empty the cart once on mount.
  useEffect(() => {
    cart.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real Stripe arrival: fetch the session so we can show a real receipt.
  useEffect(() => {
    if (!sessionId || simulated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/checkout?session_id=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error('lookup failed');
        const data = await res.json();
        if (cancelled) return;
        setOrder({
          items: (data.items || []).map((it) => ({ name: it.name, price: (it.amount || 0) / 100 })),
          total: (data.amountTotal || 0) / 100,
          email: data.email || null,
          brandTheme: data.brandTheme || null,
          paid: data.paymentStatus === 'paid',
        });
      } catch {
        /* leave the generic confirmation in place */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, simulated]);

  return (
    <div className="pp-demo-page">
      <div className="pp-success">
        <div className="pp-success-mark" aria-hidden="true">✅</div>
        <h1>Thank you — your order is confirmed</h1>
        <p>
          We’ve received your order. Our team will reach out shortly to schedule setup and
          integration for your {company.name} platform
          {order && order.email ? ` (a confirmation is on its way to ${order.email})` : ''}.
          {' '}A receipt is on its way to your email.
        </p>

        {loading && <p className="pp-checkout-note">Loading your order…</p>}

        {order && (
          <div className="pp-success-recap">
            {(order.items || []).map((it, i) => (
              <div key={i} className="pp-summary-line">
                <span>{it.name}</span>
                <span>{formatPrice(it.price)}</span>
              </div>
            ))}
            <div className="pp-summary-total">
              <span>Total (one-time)</span>
              <strong>{formatPrice(order.total)}</strong>
            </div>
            {order.brandTheme && (
              <div className="pp-summary-line pp-summary-meta">
                <span>Brand theme</span>
                <span>{order.brandTheme}</span>
              </div>
            )}
            {simulated && (
              <p className="pp-success-demo-note">Local dev — no payment was processed.</p>
            )}
          </div>
        )}

        <div className="pp-success-actions">
          <button className="btn btn-primary" onClick={() => navigate('/demo')}>Back to the demo</button>
          <button className="btn btn-outline" onClick={() => navigate('/')}>Pricing &amp; modules</button>
        </div>
      </div>
    </div>
  );
}
