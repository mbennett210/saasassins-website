import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { formatPrice } from '../modules.catalog';
import '../demo.css';

// /polishpoint/checkout/success — landing after checkout completes. Clears the
// cart once (the order is placed). For the self-contained demo path it also shows
// an order recap passed via router state and flags that no real payment was taken;
// a real Stripe return (fresh load, no state) shows the plain confirmation.

export default function CheckoutSuccess() {
  const company = selectCompany(useStore());
  const cart = useCart();
  const navigate = useNavigate();
  const { state } = useLocation();
  const order = state && state.demo ? state.order : null;

  useEffect(() => {
    cart.clear();
    // Run once on mount — the order is complete, so empty the cart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pp-demo-page">
      <div className="pp-success">
        <div className="pp-success-mark" aria-hidden="true">✅</div>
        <h1>Thank you — your order is confirmed</h1>
        <p>
          We’ve received your selection. Our team will reach out shortly to schedule setup and
          integration for your {company.name} platform. A receipt is on its way to your email.
        </p>

        {order && (
          <div className="pp-success-recap">
            {order.items.map((it, i) => (
              <div key={i} className="pp-summary-line">
                <span>{it.name}</span>
                <span>{formatPrice(it.price)}</span>
              </div>
            ))}
            <div className="pp-summary-total">
              <span>Total (one-time)</span>
              <strong>{formatPrice(order.total)}</strong>
            </div>
            <p className="pp-success-demo-note">This is an interactive demo — no payment was processed.</p>
          </div>
        )}

        <div className="pp-success-actions">
          <button className="btn btn-primary" onClick={() => navigate('/')}>Back to the demo</button>
          <button className="btn btn-outline" onClick={() => navigate('/demo')}>View modules</button>
        </div>
      </div>
    </div>
  );
}
