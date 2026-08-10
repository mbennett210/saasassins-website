import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { CORE, featuredModules } from '../modules.catalog';
import { brandAssetUrl } from '../../lib/brandAssetUrl';
import ModuleCTA from '../components/ModuleCTA';
import InfoButton from '../components/InfoButton';
import '../demo.css';

// Marketing landing at /polishpoint — the page a prospect arrives on from the
// SaaSassins site. Pitches the product, lets them jump into the live CRM
// ("Enter live demo" → /demo), and browse the modules we can build. Standalone
// (no app sidebar). Brand logo + name are read from the store company
// (PolishPoint by default). No pricing and no cart: every commercial CTA points
// to a Strike Call (Book a call → the SaaSassins contact page).

export default function DemoLanding() {
  const navigate = useNavigate();
  const company = selectCompany(useStore());
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
          <a className="btn btn-outline" href="/contact">Book a call</a>
          <button className="btn btn-primary" onClick={() => navigate('/demo')}>Enter live demo →</button>
        </div>
      </header>

      <div className="pp-demo-wrap">
        <section className="pp-demo-hero">
          <h1>Run your entire service business on {company.name}</h1>
          <p className="pp-demo-hero-sub">
            Click through the real product with live sample data: scheduling, CRM, messaging,
            and invoicing. When you're ready, book a call and we'll scope a custom build for
            your business.
          </p>
          <div className="pp-demo-hero-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/demo')}>Explore the live demo</button>
            <a className="btn btn-outline btn-lg" href="#modules">See the modules</a>
          </div>
        </section>

        <section className="pp-demo-section">
          <div className="pp-section-head">
            <div className="pp-section-head-text">
              <h2>Included in the Core platform</h2>
              <p>The full operations suite every build starts with.</p>
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
              <h2>Modules we can build in</h2>
              <p>The Core platform above covers day-to-day operations. These modules extend it, each custom-built and integrated for your business.</p>
            </div>
            <InfoButton title="How modules work" glowKey="section:modules" label="How modules work">
              <p className="pp-info-lead">
                Every {company.name} plan starts with the Core platform and includes all of its
                features. Modules are extra capabilities we build and integrate for your business.
                Book a call and we'll scope exactly what you need.
              </p>
              <p className="pp-info-lead">
                Where a module connects to a third-party service (Twilio, Stripe, Gusto, QuickBooks),
                it uses your own account with that provider.
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
    </div>
  );
}
