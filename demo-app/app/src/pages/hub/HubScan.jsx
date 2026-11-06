// SCAN SITE QR CODE on the customer hub (the Cleaner Hub, D5, 2026-10-13; Matt: "QR code scan … Add
// this on the client hub as well … You can make it look similar"). `/hub/scan`, from Home's dashed
// "Scan site QR code" (HUB_SCAN_PATH).
//
//   the same camera as the cleaner's (components/QrScanner — one scanner) → the code's URL → its token
//   (lib/areaScan scanTokenFromText) → which building and area (EP-387, GET /api/hub/scan: only a
//   building in this login's scope; the office's preview, only the building it previews) → THAT
//   AREA's own page (QR-16, QR Wave 2: pages/hub/HubArea — when it was last cleaned, the photo, what
//   was done, and "Make a request about this area").
//
// A read, never a write: it works in the office's preview whatever its switch (UI_RULES §151). Its
// back arrow is the page's own BackLink, passed into the shared heading (UI_RULES §144). Every word
// a customer reads is English (LANG-8): catalog lines rendered through english(), the scanner's
// included (passed in as `words`).
//
// ONE PRINTED CODE, A VIEW PER PERSON (QR Wave 1, 2026-10-16, UI_RULES §172): a printed code opened
// by a signed-in customer arrives as `?code=<token>` (the public page sends them here) and goes the
// camera's road at once, once: that area's own page (Matt's QR-16, 2026-10-16). A code at a
// building that isn't theirs says so with "See this area's public page"; a dead code (an archived
// customer's included, QR-27) says so alone.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Icon from '../../components/Icon';
import QrScanner from '../../components/QrScanner';
import { english } from '../../i18n/core';
import { useFromHere } from '../../hooks/useFromHere';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { scanTokenFromText, SCAN_INACTIVE_CODE } from '../../lib/areaScan';
import { HUB_SCAN_NOT_YOURS_CODE } from '../../lib/scanCodes';
import { publicScanPath, SCAN_CODE_PARAM, SCAN_VIEW_PUBLIC } from '../../lib/scanLanding';
import { resolveHubScan } from '../../lib/clientHubApi';
import { areaPath, buildingPath, sectionPath } from './hubNav';
import { useHub } from './hubData';
import HubSectionHead from './HubSectionHead';

// A refusal → its sentence. No signal (a fetch that never reached the server) is the offline line.
function refusalKey(err) {
  if (!err || err.status == null) return 'hubScan.offline';
  if (err.code === SCAN_INACTIVE_CODE) return 'hubScan.inactive';
  if (err.code === HUB_SCAN_NOT_YOURS_CODE) return 'hubScan.notYours';
  if (err.status === 429) return 'hubScan.rateLimited';
  return 'hubScan.failedCheck';
}

export default function HubScan() {
  const { currentId } = useHub();
  const navigate = useNavigate();
  const nav = useFromHere();
  const online = useOnlineStatus();
  const [searchParams, setSearchParams] = useSearchParams();
  const codeParam = searchParams.get(SCAN_CODE_PARAM);
  const handledCode = useRef(null);
  // A `?code=` arrival starts "checking" with NO camera at all (not even the library): it opens
  // only when the person asks to scan again.
  const [notice, setNotice] = useState(() => (codeParam ? { busy: true } : null));
  const [cameraOn, setCameraOn] = useState(() => !codeParam);
  const back = <BackLink to={currentId ? sectionPath(currentId, '') : '/hub'} label={english('hubScan.back')} />;

  const words = useMemo(() => ({
    hint: english('hubScan.hint'),
    starting: english('hubScan.starting'),
    noCamera: english('hubScan.noCamera'),
    noCameraHelp: english('hubScan.noCameraHelp'),
    denied: english('hubScan.denied'),
    deniedHelp: english('hubScan.deniedHelp'),
    failed: english('hubScan.failed'),
    failedHelp: english('hubScan.failedHelp'),
    retry: english('hubScan.retry'),
    photo: english('hubScan.photo'),
    reading: english('hubScan.reading'),
    photoNone: english('hubScan.photoNone'),
  }), []);

  // ONE road for the camera and a `?code=` link (EP-387 decides which buildings are this login's).
  const resolveToken = useCallback(async (token, { link = false } = {}) => {
    setNotice({ busy: true });
    try {
      const r = await resolveHubScan(token);
      // That area's own page (QR-16). A link from the phone's camera replaces this page and carries no
      // referrer (Back is the page's own).
      navigate(r.areaId ? areaPath(r.buildingId, r.areaId) : buildingPath(r.buildingId), link ? { replace: true } : { state: nav });
    } catch (err) {
      setNotice({ key: refusalKey(err), publicFor: err?.code === HUB_SCAN_NOT_YOURS_CODE ? token : null });
    }
  }, [nav, navigate]);

  const onResult = useCallback(async (text) => {
    const token = scanTokenFromText(text);
    if (!token) { setNotice({ key: 'hubScan.notACode' }); return; }
    await resolveToken(token);
  }, [resolveToken]);

  // `?code=`: at once, ONCE (the ref holds through StrictMode's second run); the code leaves the
  // address as it is taken, so a reload and Back never resolve it again.
  useEffect(() => {
    if (!codeParam || !online || handledCode.current === codeParam) return;
    handledCode.current = codeParam;
    const next = new URLSearchParams(searchParams);
    next.delete(SCAN_CODE_PARAM);
    setSearchParams(next, { replace: true });
    const token = scanTokenFromText(codeParam);
    if (!token) { setNotice({ key: 'hubScan.notACode' }); return; }
    resolveToken(token, { link: true });
  }, [codeParam, online, resolveToken, searchParams, setSearchParams]);

  return (
    <div className="hub-page hub-scan">
      <HubSectionHead back={back} title={english('hubScan.title')} />
      <div className="qr-scan-screen hub-scan-screen">
        <div className="qr-scan-body">
          {!online ? (
            <div className="qr-scan-notice" role="status">
              <Icon name="warning" size={20} />
              <p className="qr-scan-notice-text">{english('hubScan.offline')}</p>
            </div>
          ) : (
            <>
              {cameraOn && <QrScanner onResult={onResult} paused={!!notice} words={words} />}
              {notice && (
                <div className="qr-scan-notice" role="status">
                  <p className="qr-scan-notice-text">{english(notice.busy ? 'hubScan.checking' : notice.key)}</p>
                  {!notice.busy && (
                    <div className="qr-scan-notice-actions">
                      <button type="button" className="btn btn-outline qr-scan-btn" onClick={() => { setNotice(null); setCameraOn(true); }}>{english('hubScan.scanAgain')}</button>
                      {notice.publicFor && (
                        <Link className="btn btn-outline qr-scan-btn" to={publicScanPath(notice.publicFor, { view: SCAN_VIEW_PUBLIC })}>
                          {english('hubScan.publicPage')}
                        </Link>
                      )}
                    </div>
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
