// The public marketing landing at /polishpoint (main.jsx renders it in place of the app there; see demoConfig's
// demoEntry). It pitches PolishPoint, lists the Core platform and the modules, and sends every CTA to the live
// demo (/polishpoint/demo) or the booking page. Standalone: no auth, no store, no router. It reads the brand
// from IDENTITY and the modules from the catalog, and links into the app with plain hrefs.
import { IDENTITY } from '../brand/identity.generated';
import { CORE, MODULE_CATALOG } from './modules.catalog';
import { bookACall, demoHref } from './demoConfig';
import { LIGHT_LOGO_URL } from '../brand/logo.js';
import './demoLanding.css';

const NAME = IDENTITY.name;

export default function DemoLanding() {
  return (
    <div className="ppl">
      <header className="ppl-top">
        <img className="ppl-top-logo" src={LIGHT_LOGO_URL} alt={NAME} />
        <div className="ppl-top-actions">
          <a className="ppl-btn ppl-btn-ghost" href={demoHref()}>Enter live demo</a>
          <button type="button" className="ppl-btn ppl-btn-primary" onClick={bookACall}>Book a call</button>
        </div>
      </header>

      <section className="ppl-hero">
        <div className="ppl-hero-inner">
          <h1>Run your entire service business on {NAME}</h1>
          <p className="ppl-hero-sub">
            Scheduling, sales, messaging, quality control, time and payroll, supplies, and a portal for your
            customers, on one platform your whole team owns. Start with the Core platform, then switch on the
            modules your operation needs.
          </p>
          <div className="ppl-hero-cta">
            <a className="ppl-btn ppl-btn-primary ppl-btn-lg" href={demoHref()}>Explore the live demo</a>
            <button type="button" className="ppl-btn ppl-btn-outline ppl-btn-lg" onClick={bookACall}>Book a call</button>
          </div>
          <p className="ppl-hero-note">
            A fully interactive demo with sample data. Click into every section, and switch to any team member
            from the user menu.
          </p>
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
          <p>Every module below is live in the demo. Add the ones your operation needs, tailored and integrated for you.</p>
        </div>
        <div className="ppl-module-grid">
          {MODULE_CATALOG.map((m) => (
            <article className="ppl-module" key={m.id}>
              <div className="ppl-module-icon" aria-hidden="true">{m.icon}</div>
              <h3>{m.name}</h3>
              <p className="ppl-module-blurb">{m.blurb}</p>
              <ul className="ppl-module-features">
                {m.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <div className="ppl-module-foot">
                {m.how && <span className="ppl-module-how">{m.how}</span>}
                <a className="ppl-footer-link" href={demoHref(m.route)}>See it in the demo →</a>
              </div>
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
        <img className="ppl-footer-logo" src={LIGHT_LOGO_URL} alt={NAME} />
        <div className="ppl-footer-actions">
          <a className="ppl-footer-link" href={demoHref()}>Live demo</a>
          <button type="button" className="ppl-footer-link ppl-linkbtn" onClick={bookACall}>Book a call</button>
        </div>
        <p className="ppl-footer-fine">© {new Date().getFullYear()} {NAME}. Demo with sample data.</p>
      </footer>
    </div>
  );
}
