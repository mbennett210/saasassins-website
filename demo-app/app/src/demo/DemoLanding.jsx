// The public marketing landing at /polishpoint (the SPA index in the demo build). It pitches PolishPoint,
// lists the Core platform + add-on modules, and sends every CTA to the live demo (/demo) or the booking page.
// Standalone: no auth, no store — it reads the brand from IDENTITY and the modules from the catalog, so it can
// render outside the authed shell.
import { Link } from 'react-router-dom';
import { IDENTITY } from '../brand/identity.generated';
import { CORE, featuredModules } from './modules.catalog';
import { bookACall } from './demoConfig';
import { assetUrl } from '../lib/assetUrl';
import './demoLanding.css';

const NAME = IDENTITY.name;

export default function DemoLanding() {
  const modules = featuredModules();
  return (
    <div className="ppl">
      <header className="ppl-top">
        <img className="ppl-top-logo" src={assetUrl('/cleanspace-logo.png')} alt={NAME} />
        <div className="ppl-top-actions">
          <Link className="ppl-btn ppl-btn-ghost" to="/demo">Enter live demo</Link>
          <button type="button" className="ppl-btn ppl-btn-primary" onClick={bookACall}>Book a call</button>
        </div>
      </header>

      <section className="ppl-hero">
        <div className="ppl-hero-inner">
          <h1>Run your entire service business on {NAME}</h1>
          <p className="ppl-hero-sub">
            Scheduling, a sales pipeline, messaging, quoting and invoicing, quality control, and payroll —
            one platform your whole team owns. Start with the Core platform, then switch on the modules your
            operation needs.
          </p>
          <div className="ppl-hero-cta">
            <Link className="ppl-btn ppl-btn-primary ppl-btn-lg" to="/demo">Explore the live demo</Link>
            <button type="button" className="ppl-btn ppl-btn-outline ppl-btn-lg" onClick={bookACall}>Book a call</button>
          </div>
          <p className="ppl-hero-note">A fully interactive demo with sample data — click into every section.</p>
        </div>
      </section>

      <section className="ppl-core">
        <div className="ppl-core-card">
          <div className="ppl-core-head">
            <span className="ppl-pill">Core platform</span>
            <h2>{CORE.name}</h2>
            <p>{CORE.blurb}</p>
          </div>
          <ul className="ppl-core-features">
            {CORE.features.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
      </section>

      <section className="ppl-modules" id="modules">
        <div className="ppl-section-head">
          <h2>Modules</h2>
          <p>Extend the Core platform with the capabilities your operation needs — tailored and integrated for you.</p>
        </div>
        <div className="ppl-module-grid">
          {modules.map((m) => (
            <article className="ppl-module" key={m.id}>
              <div className="ppl-module-icon" aria-hidden="true">{m.icon}</div>
              <h3>{m.name}</h3>
              <p className="ppl-module-blurb">{m.blurb}</p>
              <ul className="ppl-module-features">
                {m.features.slice(0, 5).map((f) => <li key={f}>{f}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="ppl-cta-band">
        <div className="ppl-cta-band-inner">
          <div>
            <h2>See it on your operation</h2>
            <p>Walk us through how you work and which modules matter. We&rsquo;ll tailor {NAME} to fit.</p>
          </div>
          <button type="button" className="ppl-btn ppl-btn-primary ppl-btn-lg" onClick={bookACall}>Book a call</button>
        </div>
      </section>

      <footer className="ppl-footer">
        <img className="ppl-footer-logo" src={assetUrl('/cleanspace-logo.png')} alt={NAME} />
        <div className="ppl-footer-actions">
          <Link className="ppl-footer-link" to="/demo">Live demo</Link>
          <button type="button" className="ppl-footer-link ppl-linkbtn" onClick={bookACall}>Book a call</button>
        </div>
        <p className="ppl-footer-fine">© {new Date().getFullYear()} {NAME}. Demo with sample data.</p>
      </footer>
    </div>
  );
}
