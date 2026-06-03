import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { featuredModules } from '../modules.catalog';
import { useCart } from '../cart/CartContext';
import ModuleCTA from '../components/ModuleCTA';
import InfoButton from '../components/InfoButton';
import CartDrawer from '../components/CartDrawer';
import { resetDemo } from '../resetDemo';
import { BRAND } from '../../brand.config';
import '../demo.css';

// Demo entry at /polishpoint/demo — the marketing landing a prospect arrives on
// from the SaaSassins site. Pitches the product, lets them jump into the live CRM
// ("Enter live demo" → /), and showcases the sellable add-on modules with
// add-to-cart + glowing info buttons. Standalone (no app sidebar).

const CORE_FEATURES = [
  'Operations Dashboard',
  'Scheduling & Calendar',
  'Client Database (Contacts + Accounts)',
  'Sales Pipeline',
  'Messaging Suite',
  'Marketing (cold-email sequences)',
  'SMS via Twilio + A2P',
  'Invoice & Payment logging',
  'Automated Reminders',
  'Team, Roles & Permissions',
];

export default function DemoLanding() {
  const navigate = useNavigate();
  const cart = useCart();
  const [cartOpen, setCartOpen] = useState(false);
  const modules = featuredModules();

  return (
    <div className="pp-demo-page">
      <header className="pp-demo-topbar">
        <span className="pp-demo-topbar-brand">
          {BRAND.name}
          <span className="pp-addon-badge">Demo</span>
        </span>
        <div className="pp-demo-topbar-actions">
          <button className="pp-link-muted" onClick={resetDemo}>Reset demo</button>
          <button className="btn btn-outline pp-demo-cartbtn" onClick={() => setCartOpen(true)}>
            🛒 Cart
            {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/')}>Enter live demo →</button>
        </div>
      </header>

      <div className="pp-demo-wrap">
        <section className="pp-demo-hero">
          <h1>Run your entire service business on {BRAND.name}</h1>
          <p className="pp-demo-hero-sub">
            Click through the real product with live sample data — scheduling, CRM, messaging,
            marketing, and invoicing. Then bolt on the modules you need and check out when you’re ready.
          </p>
          <div className="pp-demo-hero-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/')}>Explore the live demo</button>
            <a className="btn btn-outline btn-lg" href="#modules">See add-on modules</a>
          </div>
        </section>

        <section className="pp-demo-section" id="modules">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Featured add-on modules</h2>
              <p>Core is included free. These power-ups extend it — add any to your cart here or from inside the app.</p>
            </div>
            <InfoButton title="How modules work" glowKey="section:modules" label="How modules work">
              <p className="pp-info-lead">
                Your {BRAND.name} platform ships with every core feature included. Add-on modules are
                one-time purchases that unlock extra capability, tailored and integrated for your business.
                Add them here or from the relevant area inside the app, then confirm everything at checkout.
              </p>
            </InfoButton>
          </div>
          <div className="pp-module-grid">
            {modules.map((m) => (
              <ModuleCTA key={m.id} moduleId={m.id} variant="card" />
            ))}
          </div>
        </section>

        <section className="pp-demo-section">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Included in every plan</h2>
              <p>The full operations suite — no add-ons required.</p>
            </div>
          </div>
          <div className="pp-core-band">
            <ul className="pp-core-list">
              {CORE_FEATURES.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <footer className="pp-demo-footer">
        Interactive demo with sample data · {BRAND.name} by SaaSassins
      </footer>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </div>
  );
}
