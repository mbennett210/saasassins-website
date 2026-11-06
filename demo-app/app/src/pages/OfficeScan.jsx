// SCAN A SITE QR CODE — the OFFICE's camera (QR Wave 2, 2026-10-17; Matt's QR-21: "Should managers
// and the office get a Scan button in the app, like cleaners and customers have?" → "Yes."). `/areas/scan`
// (lib/scanLanding OFFICE_SCAN_PATH), inside the office shell, reached from the Scan button on the
// manager's Home, the phone's menu and the desktop sidebar — and from a printed code opened in the
// phone's own camera by an office login (`/scan/<token>` → `/areas/scan?code=<token>`, the claim decides).
//
//   the ONE scanner (components/QrScanner, words passed in) → the code's URL → its token (lib/areaScan
//   scanTokenFromText; anything else is "That isn't a site code") → WHERE it is (EP-386, GET
//   /api/scan-codes/resolve: an office login resolves any location) → WHERE this person goes, the ONE
//   rule every scan page asks (lib/scanLanding staffScanDestination): an Account Manager, an Operations
//   Manager, an Admin or the Super Admin → the area's page (QR-17 / QR-20); the Supply Manager → that
//   building's supply orders (QR-19); without the page's key → the area's public page.
//
// A `?code=` arrival is resolved at once, ONCE (a ref through StrictMode), the code dropped from the
// address and the page REPLACED with no referrer, so Back from where it lands is that page's own; the
// camera keeps its referrer, so Back from an area returns here to scan the next code. The camera never
// starts for a `?code=` arrival. A CLEANER on screen — the owner's View-as a cleaner — is a cleaner:
// handed to the cleaner's own scan page with the code (crewPaths.scan), whose rule is theirs.
//
// QR-18: nothing is logged about a scan. This page writes nothing; it resolves and navigates.
// Every word is a catalog line: the office's own (`officeScan.*`) and the sentences every scan page
// shares, the cleaner scanner's `qrScan.*` lines (one line per sentence, already translated).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import BackLink from '../components/BackLink';
import Icon from '../components/Icon';
import QrScanner from '../components/QrScanner';
import { useT } from '../i18n/react';
import { useFromHere } from '../hooks/useFromHere';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePermission } from '../hooks/usePermission';
import { useGetState, useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { crewPaths } from '../lib/crewPaths';
import { isOfficeRole } from '../lib/roles';
import { isSupplyRole } from '../lib/navData';
import { scanTokenFromText, SCAN_INACTIVE_CODE } from '../lib/areaScan';
import { staffScanDestination, publicScanPath, SCAN_CODE_PARAM, SCAN_VIEW_PUBLIC } from '../lib/scanLanding';
import { resolveScanCode } from '../lib/scanCodesApi';

// A refusal → its sentence key. No signal (a fetch that never reached the server) is the offline line.
function refusalKey(err) {
  if (!err || err.status == null) return 'officeScan.offline';
  if (err.code === SCAN_INACTIVE_CODE) return 'officeScan.inactive';
  if (err.status === 429) return 'qrScan.rateLimited';
  return 'qrScan.failedCheck';
}

export default function OfficeScan() {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const online = useOnlineStatus();
  const getState = useGetState();
  const me = useSelector(selectCurrentUser);
  const [searchParams, setSearchParams] = useSearchParams();
  const codeParam = searchParams.get(SCAN_CODE_PARAM);
  // The EFFECTIVE user (the owner's View-as is the person on screen) decides, with the two pages' keys.
  const office = isOfficeRole(me?.role);
  const supply = isSupplyRole(me);
  const canSeeCustomer = usePermission('clients.view');
  const canSeeSupplies = usePermission('supplies.view');
  const handledCode = useRef(null);
  // null · { busy } · { key, publicFor? } (a notice) — `paused` holds the camera while it is shown.
  const [notice, setNotice] = useState(() => (codeParam ? { busy: true } : null));
  const [cameraOn, setCameraOn] = useState(() => !codeParam);

  const words = useMemo(() => ({
    hint: t('officeScan.hint'),
    starting: t('qrScan.starting'),
    noCamera: t('officeScan.noCamera'),
    noCameraHelp: t('officeScan.noCameraHelp'),
    denied: t('officeScan.denied'),
    deniedHelp: t('officeScan.deniedHelp'),
    failed: t('qrScan.failed'),
    failedHelp: t('qrScan.failedHelp'),
    retry: t('qrScan.retry'),
    photo: t('qrScan.photo'),
    reading: t('qrScan.reading'),
    photoNone: t('officeScan.photoNone'),
  }), [t]);

  // ONE road for the camera and a `?code=` link: WHERE the code is (EP-386 — the server decides what
  // this login may open), then WHERE this person goes (staffScanDestination).
  const resolveToken = useCallback(async (token, { link = false } = {}) => {
    setNotice({ busy: true });
    let loc;
    try {
      loc = await resolveScanCode(token, { state: getState(), user: me });
    } catch (err) {
      // An office login resolves any live code (EP-386, QR Wave 2), so no refusal here offers the
      // public page: a dead code says so alone.
      setNotice({ key: refusalKey(err), publicFor: null });
      return;
    }
    const dest = staffScanDestination({ loc, token, office: true, supply, canSeeCustomer, canSeeSupplies });
    // A link from the phone's camera REPLACES this page and carries no referrer: Back from where it
    // lands is that page's own, never this one (which would resolve the code again).
    navigate(dest.to, link ? { replace: true } : { state: nav });
  }, [canSeeCustomer, canSeeSupplies, getState, me, nav, navigate, supply]);

  const onResult = useCallback(async (text) => {
    const token = scanTokenFromText(text);
    if (!token) { setNotice({ key: 'qrScan.notACode' }); return; }
    await resolveToken(token);
  }, [resolveToken]);

  // `?code=`: resolved at once, ONCE (StrictMode runs an effect twice; the ref holds); the code leaves
  // the address as it is taken, so a reload, a later scan's referrer and Back never resolve it again.
  useEffect(() => {
    if (!office || !codeParam || !online) return;
    if (handledCode.current === codeParam) return;
    handledCode.current = codeParam;
    const next = new URLSearchParams(searchParams);
    next.delete(SCAN_CODE_PARAM);
    setSearchParams(next, { replace: true });
    const token = scanTokenFromText(codeParam);
    if (!token) { setNotice({ key: 'qrScan.notACode' }); return; }
    resolveToken(token, { link: true });
  }, [codeParam, office, online, resolveToken, searchParams, setSearchParams]);

  // A cleaner on screen scans on the cleaner's own page (their rule, their words).
  if (!office) return <Navigate to={crewPaths.scan(codeParam)} replace />;

  const scanAgain = () => { setNotice(null); setCameraOn(true); };

  return (
    <div className="page oscan">
      <BackLink to="/" />
      <div className="page-head">
        <div className="page-head-text">
          <h1>{t('officeScan.title')}</h1>
          <p className="page-sub">{supply ? t('officeScan.introSupply') : t('officeScan.intro')}</p>
        </div>
      </div>
      <div className="qr-scan-screen oscan-screen">
        <div className="qr-scan-body">
          {!online ? (
            <div className="qr-scan-notice" role="status">
              <Icon name="warning" size={20} />
              <p className="qr-scan-notice-text">{t('officeScan.offline')}</p>
            </div>
          ) : (
            <>
              {cameraOn && <QrScanner onResult={onResult} paused={!!notice} words={words} />}
              {notice && (
                <div className="qr-scan-notice" role="status">
                  {notice.busy ? (
                    <p className="qr-scan-notice-text">{t('qrScan.checking')}</p>
                  ) : (
                    <>
                      <p className="qr-scan-notice-text">{t(notice.key)}</p>
                      <div className="qr-scan-notice-actions">
                        <button type="button" className="btn btn-outline qr-scan-btn" onClick={scanAgain}>{t('qrScan.scanAgain')}</button>
                        {notice.publicFor && (
                          <Link className="btn btn-outline qr-scan-btn" to={publicScanPath(notice.publicFor, { view: SCAN_VIEW_PUBLIC })}>
                            {t('qrScan.publicPage')}
                          </Link>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
