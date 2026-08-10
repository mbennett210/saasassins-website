import { useState } from 'react';
import Modal from '../../components/Modal';
import { getModule } from '../modules.catalog';
import '../demo.css';

// Sidebar entry for a page-less module (demo only). These modules have no route
// of their own — they're in-context surfaces — so the nav button opens an info
// dialog instead of navigating. Mirrors the ModuleCTA popover. No pricing, no
// cart: the dialog's only action is "Book a call."

export default function NavAddonItem({ moduleId }) {
  const mod = getModule(moduleId);
  const [open, setOpen] = useState(false);
  if (!mod) return null;

  return (
    <>
      <button type="button" className="nav-btn" onClick={() => setOpen(true)}>
        <span className="nav-emoji" aria-hidden="true">{mod.icon}</span>
        <span className="nav-btn-label">{mod.navLabel || mod.name}</span>
        <span className="pp-addon-badge">Module</span>
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
            <a className="btn btn-sm btn-primary" href="/contact">Book a call</a>
          </div>
        </div>
      </Modal>
    </>
  );
}
