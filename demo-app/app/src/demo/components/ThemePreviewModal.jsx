import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PALETTES, PALETTE_KEYS, themeLabel } from '../brandTheme';
import MockDashboard from './MockDashboard';
import '../demo.css';

// Checkout "see your dashboard" preview. Shows the abbreviated dashboard mock,
// themed to the chosen brand, inside a desktop-monitor frame and a phone frame
// side by side. The swatch row flips the previewed theme live (and records the
// selection via onChange). Portaled to <body> so the overlay escapes stacking.

export default function ThemePreviewModal({ value, onChange, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="pp-preview-overlay" onClick={onClose}>
      <div className="pp-preview-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Dashboard preview">
        <header className="pp-preview-head">
          <div className="pp-preview-head-text">
            <h3>Your dashboard in {themeLabel(value)}</h3>
            <p>A quick look at how your platform comes set up in your brand colors — on desktop and mobile.</p>
          </div>
          <button className="pp-preview-close" onClick={onClose} aria-label="Close preview">×</button>
        </header>

        <div className="pp-preview-swatches" role="radiogroup" aria-label="Brand style">
          {PALETTE_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={value === key}
              className={`pp-preview-swatch${value === key ? ' is-active' : ''}`}
              onClick={() => onChange(key)}
              title={themeLabel(key)}
            >
              <span className="pp-preview-swatch-dot" style={{ background: PALETTES[key].swatch }} aria-hidden="true" />
              {key === 'blue' ? 'PolishPoint' : PALETTES[key].label}
            </button>
          ))}
        </div>

        <div className="pp-preview-stage">
          <div className="pp-device pp-device-desktop">
            <div className="pp-device-screen">
              <MockDashboard themeKey={value} variant="desktop" />
            </div>
            <span className="pp-device-stand" aria-hidden="true" />
            <span className="pp-device-cap">Desktop</span>
          </div>

          <div className="pp-device pp-device-phone">
            <div className="pp-device-phone-body">
              <span className="pp-device-notch" aria-hidden="true" />
              <div className="pp-device-screen">
                <MockDashboard themeKey={value} variant="mobile" />
              </div>
            </div>
            <span className="pp-device-cap">Mobile</span>
          </div>
        </div>

        <footer className="pp-preview-foot">
          <button className="btn btn-outline" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={onClose}>Use {themeLabel(value)}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
