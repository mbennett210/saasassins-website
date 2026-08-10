import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { brandAssetUrl } from '../../lib/brandAssetUrl';
import NotificationsBell from '../../components/NotificationsBell';
import '../demo.css';
import '../demoChromeFixes.css';

// Persistent demo app bar — a slim bar across the very top of the live app so a
// prospect always has a way BACK to the modules landing. Mirrors the landing's
// top bar so the chrome feels continuous when they click "Enter live demo."
// Mounted in AppLayout behind IS_DEMO (so it only rides the in-app routes, never
// the standalone landing).
//
// Top-left = a back affordance to the landing: a thick blue arrow + the brand
// logo (no text label). Top-right = a "Book a call" CTA + notifications bell.
// (The prospect-facing cart/checkout was removed — the demo no longer sells
// modules directly; every commercial CTA now points to a Strike Call.)
//
// It toggles `body.pp-has-appbar` while mounted; that class shifts the app chrome
// (sidebar, mobile header, main padding) down to clear this fixed bar and hides
// the now-duplicate sidebar brand. The notifications bell folds into the bar (the
// bell-floater + mobile-header bell are hidden in the demo — see AppLayout).
export default function DemoTopBar() {
  const company = selectCompany(useStore());
  const navigate = useNavigate();

  useEffect(() => {
    document.body.classList.add('pp-has-appbar');
    return () => document.body.classList.remove('pp-has-appbar');
  }, []);

  return (
    <header className="pp-demo-appbar">
      <button
        type="button"
        className="pp-demo-appbar-back"
        onClick={() => navigate('/')}
        aria-label="Back to overview"
      >
        <span className="pp-demo-appbar-arrow" aria-hidden="true">←</span>
        {company.logoUrl ? (
          <img className="pp-demo-appbar-logo" src={brandAssetUrl(company.logoUrl)} alt={company.name} />
        ) : (
          <span className="pp-demo-appbar-name">{company.name}</span>
        )}
      </button>

      <div className="pp-demo-appbar-actions">
        <a className="btn btn-primary btn-sm pp-appbar-cartbtn" href="/contact">
          Book a call
        </a>
        <NotificationsBell />
      </div>
    </header>
  );
}
