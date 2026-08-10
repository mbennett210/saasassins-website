import { getModule } from '../modules.catalog';
import InfoButton from './InfoButton';
import '../demo.css';

// In-context "here's a module we can build for you" surface. Dropped into the
// relevant feature pages (Invoices, Integrations, Team, Schedule, Dashboard)
// behind IS_DEMO, and reused on the demo landing as a grid card.
//
//   variant="inline" (default) — compact left-border row inside a feature page
//   variant="card"             — taller card for the featured-modules grid
//   variant="row"              — tight checklist row (name + Book a call)
//
// The glowing InfoButton beside each CTA opens the module's deep-dive copy. There
// is no pricing and no cart — every commercial action points to a Strike Call
// (Book a call → the SaaSassins contact page), where scope and cost are figured
// out for the specific business.

const BOOK_CALL_HREF = '/contact';

function BookCall({ block = false }) {
  return (
    <a className={`btn btn-sm btn-primary${block ? ' btn-block' : ''}`} href={BOOK_CALL_HREF}>
      Book a call
    </a>
  );
}

export default function ModuleCTA({ moduleId, variant = 'inline' }) {
  const mod = getModule(moduleId);
  if (!mod) return null;

  const info = (
    <InfoButton title={mod.name} glowKey={`mod:${mod.id}`} label={`About ${mod.name}`}>
      <p className="pp-info-lead">{mod.longDescription}</p>
      <ul className="pp-info-features">
        {mod.features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="pp-info-foot">
        <BookCall />
      </div>
    </InfoButton>
  );

  // Tight checklist row — name + category + Book a call, kept deliberately compact.
  if (variant === 'row') {
    return (
      <div className="pp-addon-row">
        <span className="pp-addon-row-icon" aria-hidden="true">{mod.icon}</span>
        <div className="pp-addon-row-body">
          <div className="pp-addon-row-name">{mod.name}</div>
          <div className="pp-addon-row-cat">{mod.category}</div>
        </div>
        <BookCall />
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <div className={`pp-module-card${mod.featured ? ' is-featured' : ''}`}>
        <div className="pp-module-card-top">
          <div className="pp-module-card-top-left">
            <span className="pp-module-card-icon" aria-hidden="true">{mod.icon}</span>
            {info}
          </div>
          <span className="pp-addon-badge">Module</span>
        </div>
        <h3 className="pp-module-card-name">{mod.name}</h3>
        <p className="pp-module-card-cat">{mod.category}</p>
        <p className="pp-module-card-blurb">{mod.blurb}</p>
        <ul className="pp-module-card-features">
          {mod.features.slice(0, 4).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="pp-module-card-foot">
          <div className="pp-module-card-actions">
            <BookCall />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-module-cta">
      <span className="pp-module-cta-icon" aria-hidden="true">{mod.icon}</span>
      <div className="pp-module-cta-body">
        <div className="pp-module-cta-title">
          <span className="pp-addon-badge">Module</span>
          <h4>{mod.name}</h4>
          {info}
        </div>
        <p className="pp-module-cta-blurb">{mod.blurb}</p>
      </div>
      <div className="pp-module-cta-aside">
        <BookCall />
      </div>
    </div>
  );
}
