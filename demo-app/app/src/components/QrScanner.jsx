// THE ONE QR SCANNER (the Cleaner Hub, D5, 2026-10-13; Matt's QRScan board, UI_RULES §167): the
// camera in a square viewfinder with corner brackets and one hint line. The cleaner's scan page
// (pages/crew/CrewScan.jsx) and the customer hub's (pages/hub/HubScan.jsx) both draw it — one camera
// implementation, two audiences.
//
//   <QrScanner onResult={(text) => …} paused={busy} words={{ hint, starting, … }} />
//
// · `qr-scanner` is imported LAZILY, here and only here, so the library and its decoding worker are
//   their own chunks: the main bundle never carries them (the service worker keeps both for the
//   cleaner's page — vite-plugins/sw-precache.mjs OFFLINE_LAZY_MODULES).
// · The WORDS come in as props: the cleaner app passes its catalog lines (a cleaner may read Spanish
//   or Creole), the hub passes English (LANG-8). This file renders no words of its own.
// · States: starting · scanning · noCamera · denied (camera permission refused — with what to do) ·
//   failed (Try again). Where the camera can't be used, "Take a photo of the code" reads the code
//   from a picture instead (the phone's own camera app), through the same library.
// · A code read stops the camera at once and hands its TEXT to `onResult` — one code at a time;
//   the page parses it (lib/areaScan scanTokenFromText) and decides what comes next. The page sets
//   `paused` while it works, and clears it to scan again.
// · The camera stops on unmount and whenever the page is hidden (a phone locked mid-scan must not
//   keep its camera light on), and starts again when the page is back in view.
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

const STATE = Object.freeze({ STARTING: 'starting', SCANNING: 'scanning', NO_CAMERA: 'noCamera', DENIED: 'denied', FAILED: 'failed' });

// The library's refusals: a DOMException from getUserMedia, or its own "Camera not found." string.
function cameraErrorState(e) {
  const name = e && typeof e === 'object' ? e.name : '';
  const text = String((e && e.message) || e || '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || /not allowed|permission|denied/i.test(text)) return STATE.DENIED;
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || /camera not found/i.test(text)) return STATE.NO_CAMERA;
  return STATE.FAILED;
}

const loadLibrary = () => import('qr-scanner').then((m) => m.default || m);

export default function QrScanner({ onResult, paused = false, words = {} }) {
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const onResultRef = useRef(onResult);
  const pausedRef = useRef(paused);
  const [state, setState] = useState(STATE.STARTING);
  const [attempt, setAttempt] = useState(0);
  const [photoNote, setPhotoNote] = useState('');

  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  useEffect(() => {
    let cancelled = false;
    let scanner = null;
    const start = async () => {
      if (!scanner || cancelled || pausedRef.current || document.visibilityState === 'hidden') return;
      try {
        await scanner.start();
        if (!cancelled) setState(STATE.SCANNING);
      } catch (e) {
        if (!cancelled) setState(cameraErrorState(e));
      }
    };
    const onVisibility = () => {
      if (!scanner) return;
      if (document.visibilityState === 'hidden') scanner.stop();
      else start();
    };
    (async () => {
      setState(STATE.STARTING);
      let Lib;
      try { Lib = await loadLibrary(); } catch { if (!cancelled) setState(STATE.FAILED); return; }
      if (cancelled || !videoRef.current) return;
      let hasCamera = true;
      try { hasCamera = await Lib.hasCamera(); } catch { hasCamera = true; }
      if (cancelled) return;
      if (!hasCamera) { setState(STATE.NO_CAMERA); return; }
      scanner = new Lib(videoRef.current, (result) => {
        const text = result && typeof result === 'object' ? result.data : result;
        if (!text || pausedRef.current) return;
        // One code at a time: stop now, and let the page say what happens next.
        scanner.stop();
        onResultRef.current?.(String(text));
      }, {
        returnDetailedScanResult: true,
        preferredCamera: 'environment',
        maxScansPerSecond: 5,
        highlightScanRegion: false,
        highlightCodeOutline: false,
      });
      scannerRef.current = scanner;
      document.addEventListener('visibilitychange', onVisibility);
      await start();
    })();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      scannerRef.current = null;
      if (scanner) {
        scanner.stop();
        scanner.destroy();
      }
    };
  }, [attempt]);

  // The page pauses the camera while it works on a code, and resumes it to scan again.
  useEffect(() => {
    pausedRef.current = paused;
    const scanner = scannerRef.current;
    if (!scanner) return;
    if (paused) { scanner.stop(); return; }
    if (document.visibilityState === 'hidden') return;
    scanner.start().then(() => setState(STATE.SCANNING)).catch((e) => setState(cameraErrorState(e)));
  }, [paused]);

  const readPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setPhotoNote(words.reading || '');
    try {
      const Lib = await loadLibrary();
      const result = await Lib.scanImage(file, { returnDetailedScanResult: true, alsoTryWithoutScanRegion: true });
      setPhotoNote('');
      if (result && result.data) onResultRef.current?.(String(result.data));
    } catch {
      setPhotoNote(words.photoNone || '');
    }
  };

  const blocked = state === STATE.NO_CAMERA || state === STATE.DENIED || state === STATE.FAILED;
  const line = {
    [STATE.STARTING]: words.starting,
    [STATE.SCANNING]: words.hint,
    [STATE.NO_CAMERA]: words.noCamera,
    [STATE.DENIED]: words.denied,
    [STATE.FAILED]: words.failed,
  }[state];
  const help = state === STATE.NO_CAMERA ? words.noCameraHelp : state === STATE.DENIED ? words.deniedHelp : state === STATE.FAILED ? words.failedHelp : '';

  return (
    <div className={`qr-scan${blocked ? ' is-blocked' : ''}`} data-state={state}>
      <div className="qr-scan-frame">
        <video ref={videoRef} className="qr-scan-video" muted playsInline aria-hidden="true" />
        <span className="qr-scan-corner is-tl" aria-hidden="true" />
        <span className="qr-scan-corner is-tr" aria-hidden="true" />
        <span className="qr-scan-corner is-bl" aria-hidden="true" />
        <span className="qr-scan-corner is-br" aria-hidden="true" />
        {blocked && (
          <span className="qr-scan-blocked" aria-hidden="true"><Icon name="camera" size={36} /></span>
        )}
      </div>
      <p className="qr-scan-hint" role="status">{line}</p>
      {blocked && (
        <div className="qr-scan-help">
          {help && <p className="qr-scan-help-text">{help}</p>}
          <div className="qr-scan-help-actions">
            {state === STATE.FAILED && (
              <button type="button" className="btn btn-outline qr-scan-btn" onClick={() => setAttempt((n) => n + 1)}>{words.retry}</button>
            )}
            <label className="btn btn-outline qr-scan-btn">
              <Icon name="camera" size={16} />
              <span>{words.photo}</span>
              <input type="file" accept="image/*" capture="environment" className="qr-scan-file" onChange={readPhoto} />
            </label>
          </div>
          {photoNote && <p className="qr-scan-help-text" role="status">{photoNote}</p>}
        </div>
      )}
    </div>
  );
}
