// The QR code on a wall, scanned (QR-2, QR-3, QR-15, QR-28, QR-31, HUB-15) — /scan/:token. Public:
// no login, no app shell and no shared store, like /inspect/:token. Phone first: people scan it
// standing in a hallway.
//
// One answer, from one pure projection (lib/areaScan), drawn by the ONE area card it shares with the
// customer hub's area page (components/AreaScanCard, UI_RULES §173): the building and the area,
// when it was last cleaned in the org's own time zone — the same calm way however old (QR-28: never a
// warning) — the next scheduled clean and the last inspection as dates, what was done, the newest
// checklist photo, and the company's number for urgent problems (QR-31). An unknown, replaced or
// archived customer's code is a plain "This code is no longer active." (QR-27).
// Below the card, the visitor's two actions (QR-22..QR-26, QR-30; UI_RULES §174): rate the area
// 👍 / 👎 and report a problem — their own components, mounted as one block.
//
// ONE PRINTED CODE, A VIEW PER PERSON (QR Wave 1, 2026-10-16, UI_RULES §172): the page reads
// the sign-in SESSION on this browser — never the store, which a public page does not boot —
// and lib/scanLanding decides by the login's claim. Signed in, a customer goes on to
// /hub/scan?code=, an office login to /areas/scan?code= (QR Wave 2) and a cleaner to
// /my-day/scan?code= (replace: Back never lands here again); signed out, in the demo
// or with ?view=public, the public card as before — with ONE line, "… team or customer? Sign
// in", which comes back to this code after signing in. The public read is not made for someone
// being sent on. English throughout (LANG-8), like every word on this page.
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import AreaScanCard from '../components/AreaScanCard';
import { useSession } from '../auth/AuthProvider';
import { isClientSession } from '../lib/clientHub';
import { getPublicAreaScan } from '../lib/scanCodesApi';
import { formatScanWhen, SCAN_INACTIVE_CODE, SCAN_INACTIVE_MESSAGE, SCAN_RATE_LIMITED_CODE } from '../lib/areaScan';
import { scanLanding, scanShowsSignIn, scanSignInState, scanClaimRole, SCAN_LANDING, SCAN_VIEW_PARAM } from '../lib/scanLanding';
import { LIGHT_LOGO_URL } from '../brand/logo';
import ScanAreaRating from '../components/ScanAreaRating';
import ScanVisitorReport from '../components/ScanVisitorReport';
import { IDENTITY } from '../brand/identity.generated.js';

function Shell({ children }) {
  return (
    <div className="scan-shell">
      <header className="scan-bar">
        {/* the software's logo (the brand pack's product, UI_RULES §129); "Cleaning by" names the company */}
        <img className="scan-logo" src={LIGHT_LOGO_URL} alt={IDENTITY.product.name} />
      </header>
      <main className="scan-main">{children}</main>
      <footer className="scan-foot text-xs">Cleaning by {IDENTITY.name}</footer>
    </div>
  );
}

function Notice({ title, text, onRetry }) {
  return (
    <section className="card scan-card scan-notice" aria-live="polite">
      <h1 className="scan-area">{title}</h1>
      {text && <p className="scan-notice-text">{text}</p>}
      {onRetry && <button type="button" className="btn btn-primary scan-retry" onClick={onRetry}>Try again</button>}
    </section>
  );
}

export default function PublicAreaScan() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const { configured, loading: sessionLoading, session } = useSession();
  const landing = scanLanding({
    token, configured, loading: sessionLoading, signedIn: !!session,
    customer: isClientSession(session), role: scanClaimRole(session), view: searchParams.get(SCAN_VIEW_PARAM),
  });
  const showsPublic = landing.kind === SCAN_LANDING.PUBLIC;
  const signIn = scanShowsSignIn({ configured, loading: sessionLoading, signedIn: !!session });
  // loading | ready | inactive | busy | error
  const [view, setView] = useState({ status: 'loading' });

  const load = useCallback(() => {
    let alive = true;
    setView({ status: 'loading' });
    getPublicAreaScan(token)
      .then((r) => { if (alive) setView({ status: 'ready', scan: r.scan, photoUrl: r.photoUrl }); })
      .catch((e) => {
        if (!alive) return;
        if (e?.code === SCAN_INACTIVE_CODE) setView({ status: 'inactive' });
        else if (e?.code === SCAN_RATE_LIMITED_CODE) setView({ status: 'busy' });
        else setView({ status: 'error' });
      });
    return () => { alive = false; };
  }, [token]);
  // Only the public card reads the public answer: someone being sent on costs no read.
  useEffect(() => (showsPublic ? load() : undefined), [load, showsPublic]);

  if (landing.kind === SCAN_LANDING.REDIRECT) return <Navigate to={landing.to} replace />;
  if (!showsPublic || view.status === 'loading') {
    return <Shell><section className="card scan-card"><p className="scan-loading">Loading…</p></section></Shell>;
  }
  if (view.status === 'inactive') {
    return <Shell><Notice title={SCAN_INACTIVE_MESSAGE} text="It may have been replaced by a new label." /></Shell>;
  }
  if (view.status === 'busy') {
    return <Shell><Notice title="Too many requests" text="Please try again in a minute." onRetry={load} /></Shell>;
  }
  if (view.status === 'error') {
    return <Shell><Notice title="This page couldn’t load" text="Check your signal and try again." onRetry={load} /></Shell>;
  }

  const { scan, photoUrl } = view;
  return (
    <Shell>
      <AreaScanCard scan={scan} photoUrl={photoUrl}>
        {/* The one line the public card gains (UI_RULES §172): a staff member or a customer whose
            browser is not signed in signs in here and comes straight back to this code. */}
        {signIn && (
          <p className="scan-signin">
            <span>{IDENTITY.name} team or customer?</span>
            <Link className="btn btn-link scan-signin-link" to="/login" state={scanSignInState(token)}>Sign in</Link>
          </p>
        )}
      </AreaScanCard>
      <p className="scan-checked text-xs">Checked {formatScanWhen(scan.checkedAt, scan.timeZone)}</p>
      {/* QR-22..QR-26, QR-30 (UI_RULES §174): the visitor's two actions, below the card. */}
      <div className="scan-visitor">
        <ScanAreaRating token={token} timeZone={scan.timeZone} />
        <ScanVisitorReport token={token} area={scan.area} />
      </div>
    </Shell>
  );
}
