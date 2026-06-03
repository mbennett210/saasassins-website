import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../cart/CartContext';
import { BRAND } from '../../brand.config';
import '../demo.css';

// /polishpoint/checkout/success — landing after a completed Stripe Checkout.
// Clears the cart once (the order is placed) and confirms next steps.

export default function CheckoutSuccess() {
  const cart = useCart();
  const navigate = useNavigate();

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
          We’ve received your module selection. Our team will reach out shortly to schedule setup and
          integration for your {BRAND.name} platform. A receipt is on its way to your email.
        </p>
        <div className="pp-success-actions">
          <button className="btn btn-primary" onClick={() => navigate('/')}>Back to the demo</button>
          <button className="btn btn-outline" onClick={() => navigate('/demo')}>View modules</button>
        </div>
      </div>
    </div>
  );
}
