import { getModule, formatPrice } from '../modules.catalog';
import { useCart } from '../cart/CartContext';
import { useToast } from '../../components/Toast';
import InfoButton from './InfoButton';
import '../demo.css';

// In-context "add this add-on to your cart" surface. Dropped into the relevant
// feature pages (Invoices, Integrations, Team, Schedule, Dashboard) behind
// IS_DEMO, and reused on the demo landing as a grid card.
//
//   variant="inline" (default) — compact left-border row inside a feature page
//   variant="card"             — taller card for the featured-modules grid
//   variant="row"              — tight checklist row for the checkout "Add more"
//                                list (no blurb/features — name + price + Add)
//
// The glowing InfoButton beside each CTA opens the module's deep-dive copy. On
// the landing card it sits next to the module icon (top of the card); on the
// inline row it sits beside the name.

export default function ModuleCTA({ moduleId, variant = 'inline' }) {
  const mod = getModule(moduleId);
  const cart = useCart();
  const toast = useToast();
  if (!mod) return null;

  const inCart = cart.has(mod.id);
  const onToggle = () => {
    if (inCart) {
      cart.remove(mod.id);
      return;
    }
    cart.add(mod.id);
    toast.success(`${mod.name} added to cart`);
  };

  const info = (
    <InfoButton title={mod.name} glowKey={`mod:${mod.id}`} label={`About ${mod.name}`}>
      <p className="pp-info-lead">{mod.longDescription}</p>
      <ul className="pp-info-features">
        {mod.features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="pp-info-foot">
        <span className="pp-info-price">
          {formatPrice(mod.price)}
          <small>one-time</small>
        </span>
        <button type="button" className={`btn btn-sm ${inCart ? 'btn-success' : 'btn-primary'}`} onClick={onToggle}>
          {inCart ? 'In cart ✓' : 'Add to cart'}
        </button>
      </div>
    </InfoButton>
  );

  // Tight checklist row — the checkout "Add more" list. Name + category + price +
  // Add, kept deliberately compact so a long add-on list reads cleanly.
  if (variant === 'row') {
    return (
      <div className="pp-addon-row">
        <span className="pp-addon-row-icon" aria-hidden="true">{mod.icon}</span>
        <div className="pp-addon-row-body">
          <div className="pp-addon-row-name">{mod.name}</div>
          <div className="pp-addon-row-cat">{mod.category}</div>
        </div>
        <span className="pp-addon-row-price">{formatPrice(mod.price)}</span>
        <button type="button" className={`btn btn-sm ${inCart ? 'btn-success' : 'btn-primary'}`} onClick={onToggle}>
          {inCart ? 'In cart ✓' : 'Add'}
        </button>
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
          <span className="pp-addon-badge">Add-on</span>
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
          <span className="pp-module-card-price">
            {formatPrice(mod.price)}
            <small>one-time</small>
          </span>
          <div className="pp-module-card-actions">
            <button type="button" className={`btn btn-sm ${inCart ? 'btn-success' : 'btn-primary'}`} onClick={onToggle}>
              {inCart ? 'In cart ✓' : 'Add'}
            </button>
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
          <span className="pp-addon-badge">Add-on</span>
          <h4>{mod.name}</h4>
          {info}
        </div>
        <p className="pp-module-cta-blurb">{mod.blurb}</p>
      </div>
      <div className="pp-module-cta-aside">
        <span className="pp-module-cta-price">
          {formatPrice(mod.price)}
          <small>one-time</small>
        </span>
        <button type="button" className={`btn btn-sm ${inCart ? 'btn-success' : 'btn-primary'}`} onClick={onToggle}>
          {inCart ? 'In cart ✓' : 'Add to cart'}
        </button>
      </div>
    </div>
  );
}
