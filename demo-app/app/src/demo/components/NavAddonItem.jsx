import { useState } from 'react';
import Modal from '../../components/Modal';
import { useCart } from '../cart/CartContext';
import { useToast } from '../../components/Toast';
import { getModule, formatPrice } from '../modules.catalog';
import '../demo.css';

// Sidebar entry for a page-less add-on module (demo only). These modules have no
// route of their own — they're in-context upsells — so the nav button opens an
// info + add-to-cart dialog instead of navigating. Mirrors the ModuleCTA popover.

export default function NavAddonItem({ moduleId }) {
  const mod = getModule(moduleId);
  const cart = useCart();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (!mod) return null;

  const inCart = cart.has(mod.id);
  const toggle = () => {
    if (inCart) {
      cart.remove(mod.id);
      return;
    }
    cart.add(mod.id);
    toast.success(`${mod.name} added to cart`);
  };

  return (
    <>
      <button type="button" className="nav-btn" onClick={() => setOpen(true)}>
        <span className="nav-emoji" aria-hidden="true">{mod.icon}</span>
        <span className="nav-btn-label">{mod.navLabel || mod.name}</span>
        <span className="pp-addon-badge">{inCart ? 'In cart ✓' : 'Add-on'}</span>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={mod.name} size="sm">
        <div className="pp-info-pop">
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
            <button
              type="button"
              className={`btn btn-sm ${inCart ? 'btn-success' : 'btn-primary'}`}
              onClick={toggle}
            >
              {inCart ? 'In cart ✓' : 'Add to cart'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
