import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { CORE, featuredModules, formatPrice } from '../modules.catalog';
import { useCart } from '../cart/CartContext';
import { brandAssetUrl } from '../../lib/brandAssetUrl';
import ModuleCTA from '../components/ModuleCTA';
import InfoButton from '../components/InfoButton';
import CartDrawer from '../components/CartDrawer';
import '../demo.css';

// Marketing landing at /polishpoint — the page a prospect arrives on from the
// SaaSassins site. Pitches the product, lets them jump into the live CRM
// ("Enter live demo" → /demo), and browse the sellable add-on modules. Standalone
// (no app sidebar). Brand logo + name are read from the store company (PolishPoint by default).

export default function DemoLanding() {
  const navigate = useNavigate();
  const company = selectCompany(useStore());
  const cart = useCart();
  const [cartOpen, setCartOpen] = useState(false);
  const modules = featuredModules();

  return (
    <div className="pp-demo-page">
      <header className="pp-demo-topbar">
        <span className="pp-demo-topbar-brand">
          {company.logoUrl ? (
            <img className="pp-demo-topbar-logo" src={brandAssetUrl(company.logoUrl)} alt={company.name} />
          ) : (
            company.name
          )}
          <span className="pp-addon-badge">Demo</span>
        </span>
        <div className="pp-demo-topbar-actions">
          <button className="btn btn-outline pp-demo-cartbtn" onClick={() => setCartOpen(true)}>
            🛒 Cart
            {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/demo')}>Enter live demo →</button>
        </div>
      </header>

      <div className="pp-demo-wrap">
        <section className="pp-demo-hero">
          <h1>Run your entire service business on {company.name}</h1>
          <p className="pp-demo-hero-sub">
            Click through the real product with live sample data — scheduling, CRM, messaging,
            and invoicing. Every plan starts with the {formatPrice(CORE.price)} Core platform; bolt on
            the modules you need and check out when you’re ready.
          </p>
          <div className="pp-demo-hero-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/demo')}>Explore the live demo</button>
            <a className="btn btn-outline btn-lg" href="#modules">See add-on modules</a>
          </div>
        </section>

        <section className="pp-demo-section">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Included in the {formatPrice(CORE.price)} Core platform</h2>
              <p>The full operations suite — no add-ons required.</p>
            </div>
          </div>
          <div className="pp-core-band">
            <ul className="pp-core-list">
              {CORE.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="pp-demo-section" id="modules">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Featured add-on modules</h2>
              <p>The {formatPrice(CORE.price)} Core platform above covers your operations. These power-ups extend it — add any to your cart here or from inside the app.</p>
            </div>
            <InfoButton title="How modules work" glowKey="section:modules" label="How modules work">
              <p className="pp-info-lead">
                Every {company.name} plan starts with the Core platform ({formatPrice(CORE.price)}, one-time) and
                includes all of its features. Add-on modules are one-time purchases that unlock extra
                capability, tailored and integrated for your business. Add them here or from the relevant
                area inside the app, then confirm everything at checkout.
              </p>
              <p className="pp-info-lead">
                Prices are one-time build fees. Where a module connects to a third-party service — Twilio,
                Stripe, Gusto, QuickBooks — it uses your own account with that provider, which bills separately.
              </p>
            </InfoButton>
          </div>
          <div className="pp-module-grid">
            {modules.map((m) => (
              <ModuleCTA key={m.id} moduleId={m.id} variant="card" />
            ))}
          </div>
        </section>
      </div>

      <footer className="pp-demo-footer">
        Interactive demo with sample data · {company.name} by SaaSassins
      </footer>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </div>
  );
}
