import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { CORE, MODULE_CATALOG, featuredModules, getModule, formatPrice } from '../modules.catalog';
import { useCart } from '../cart/CartContext';
import ModuleCTA from '../components/ModuleCTA';
import InfoButton from '../components/InfoButton';
import CartDrawer from '../components/CartDrawer';
import '../demo.css';

// Product landing at /polishpoint (the SPA index in the marketing demo) — the
// front door a prospect arrives on from the SaaSassins site. Pitches PolishPoint,
// shows the full one-time pricing menu (sheet midpoints), and funnels into the
// interactive demo ("Explore the live demo" → /demo) and checkout. Standalone (no
// app sidebar). Brand name is read from the store company (PolishPoint by default).

// Pricing menu rows. Prices come from the catalog (single source of truth); the
// "note" mirrors the agreed pricing sheet, and `tag` flags how it shows in the
// demo (Core base / a live built feature / a sellable add-on).
const PRICING_ROWS = [
  { id: 'core', tag: 'Core', note: 'The platform shell every plan starts on — dashboard, CRM, scheduling, pipeline, messaging.' },
  { id: 'marketing', tag: 'Built', note: 'Incl. domain/inbox/DNS warmup standup. Managed cold-email shops charge $1.5k–$3k just to set up.' },
  { id: 'ipr', tag: 'Built', note: 'Invoicing + quoting combined — market-standard packaging.' },
  { id: 'forms', tag: 'Add-on', note: 'Drag-drop builder, submissions, analytics, webhooks.' },
  { id: 'sms', tag: 'Add-on', note: 'A2P 10DLC registration + number provisioning labor.' },
  { id: 'quickbooks', tag: 'Add-on', note: 'Bidirectional sync + AR aging.' },
  { id: 'fieldops', tag: 'Add-on', note: 'Checklists, before/after photos, GPS completion.' },
  { id: 'ems', tag: 'Add-on', note: 'HR + GPS clock + onboarding + Gusto payroll.' },
  { id: 'inventory', tag: 'Add-on', note: 'Physical keys + general inventory with low-stock alerts.' },
  { id: 'salesautomation', tag: 'Add-on', note: 'Timed, trigger-based workflows.' },
  { id: 'datamigration', tag: 'Add-on', note: 'Per source, e.g. GoHighLevel — CSV import wizard + per-source config.' },
];

const TAG_CLASS = { Core: 'is-core', Built: 'is-built', 'Add-on': 'is-addon' };

function pricingRow(row) {
  if (row.id === 'core') return { name: CORE.name, price: CORE.price, ...row };
  const m = getModule(row.id);
  return m ? { name: m.name, price: m.price, ...row } : null;
}

export default function DemoLanding() {
  const navigate = useNavigate();
  const company = selectCompany(useStore());
  const cart = useCart();
  const [cartOpen, setCartOpen] = useState(false);
  const modules = featuredModules();
  const rows = PRICING_ROWS.map(pricingRow).filter(Boolean);

  return (
    <div className="pp-demo-page">
      <header className="pp-demo-topbar">
        <span className="pp-demo-topbar-brand">
          {company.name}
          <span className="pp-addon-badge">by SaaSassins</span>
        </span>
        <div className="pp-demo-topbar-actions">
          <button className="btn btn-outline pp-demo-cartbtn" onClick={() => setCartOpen(true)}>
            🛒 Cart
            {cart.count > 0 && <span className="pp-cart-fab-count">{cart.count}</span>}
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/demo')}>Launch live demo →</button>
        </div>
      </header>

      <div className="pp-demo-wrap">
        <section className="pp-demo-hero">
          <h1>The all-in-one platform to run your service business</h1>
          <p className="pp-demo-hero-sub">
            {company.name} replaces the stack of subscriptions you’re renting — scheduling, CRM,
            messaging, invoicing, marketing — with one platform you buy once and own. Click through
            the real product with live sample data, then build your plan from the {formatPrice(CORE.price)} Core
            platform up.
          </p>
          <div className="pp-demo-hero-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/demo')}>Explore the live demo</button>
            <a className="btn btn-outline btn-lg" href="#pricing">See pricing</a>
          </div>
        </section>

        <section className="pp-demo-section" id="modules">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Add-on modules</h2>
              <p>The {formatPrice(CORE.price)} Core platform covers the essentials. These power-ups extend it — add any to your cart here or from inside the app.</p>
            </div>
            <InfoButton title="How modules work" glowKey="section:modules" label="How modules work">
              <p className="pp-info-lead">
                Every {company.name} plan starts with the Core platform ({formatPrice(CORE.price)}, one-time) and
                includes all of its features. Add-on modules are one-time purchases that unlock extra
                capability, tailored and integrated for your business. Add them here or from the relevant
                area inside the app, then confirm everything at checkout.
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

        <section className="pp-demo-section" id="pricing">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Transparent, one-time pricing</h2>
              <p>No subscriptions — pay once, own it. Below is the full build menu. Core is the only required line; everything else is à la carte.</p>
            </div>
          </div>
          <div className="pp-pricing-table" role="table" aria-label="PolishPoint pricing">
            <div className="pp-pricing-row pp-pricing-head" role="row">
              <span role="columnheader">Component</span>
              <span role="columnheader">One-time</span>
              <span role="columnheader">What’s covered</span>
            </div>
            {rows.map((r) => (
              <div className="pp-pricing-row" role="row" key={r.id}>
                <span className="pp-pricing-name" role="cell">
                  {r.name}
                  <span className={`pp-pricing-tag ${TAG_CLASS[r.tag] || ''}`}>{r.tag}</span>
                </span>
                <span className="pp-pricing-price" role="cell">{formatPrice(r.price)}</span>
                <span className="pp-pricing-note" role="cell">{r.note}</span>
              </div>
            ))}
          </div>
          <p className="pp-pricing-caption">
            Figures are the midpoint of our quoted ranges; your exact scope is confirmed in a Strike Call.
            “Built” features are live in this demo today; “Add-on” modules are sold to be built and
            integrated for your business.
          </p>
        </section>

        <section className="pp-demo-cta">
          <h2>See it run your business</h2>
          <p>Click through the real product with sample data, then configure your plan and check out when you’re ready.</p>
          <div className="pp-demo-hero-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/demo')}>Explore the live demo</button>
            <button className="btn btn-outline btn-lg" onClick={() => navigate('/checkout')}>Configure your plan</button>
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
