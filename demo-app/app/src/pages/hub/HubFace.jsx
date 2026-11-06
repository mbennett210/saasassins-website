import { useEffect, useState, useSyncExternalStore } from 'react';
import Centred from '../../components/Centred';
import { fetchHubFace } from '../../lib/clientHubApi';
import { hubInitials } from '../../lib/hubFaces';

// A TEAM MEMBER'S FACE IN THE CUSTOMER HUB (HUB-19; Matt's "Your Account Manager", 2026-11-02): the
// kit's avatar disc (UI_RULES §141) with the initials of the name the hub served (first name + last
// initial), and the person's photo over them once it has loaded. The hub's answers name a photo by
// its version only, { v } (lib/hubFaces.js); the image comes from GET /api/hub/face, signed in as
// the customer (lib/clientHubApi fetchHubFace). As the kit's Avatar:
//   · the box never changes size: the photo fills the disc it sits in;
//   · until it loads, and if it never does, the initials show; it fades in where they were.
// `className` replaces the kit's disc look (the visit band's ringed face, .hub-crew-face).
//
// ONE IMAGE PER PHOTO, for the page's life. Home and Today's Visit are read again every minute,
// with the same version each time, so a version is fetched once and its object URL kept (a few
// small photos; the page's end frees them). A failed fetch is asked again only after
// FACE_RETRY_MS, so a list of initials never polls. A new photo is a new version: it shows at once.
const FACE_RETRY_MS = 5 * 60 * 1000;
const faces = new Map(); // v → { state: 'loading' | 'ready' | 'failed', src, at }
const listeners = new Set();
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) fn(); };

function loadFace(buildingId, v) {
  const known = faces.get(v);
  if (known && (known.state !== 'failed' || Date.now() - known.at < FACE_RETRY_MS)) return;
  faces.set(v, { state: 'loading', src: null, at: Date.now() });
  fetchHubFace(buildingId, v)
    .then((src) => { faces.set(v, { state: 'ready', src, at: Date.now() }); emit(); })
    .catch(() => { faces.set(v, { state: 'failed', src: null, at: Date.now() }); emit(); });
}

// The image source for a face once it has been fetched, else null.
export function useHubFaceSrc(buildingId, face) {
  const v = face?.v || null;
  useEffect(() => { if (buildingId && v) loadFace(buildingId, v); }, [buildingId, v]);
  return useSyncExternalStore(subscribe, () => (v ? faces.get(v)?.src || null : null));
}

// The initials' INK sits in the disc's middle (the styling vault's "Icons sit in the middle"):
// Poppins' line isn't centred on its capitals (they sat 0.3 to 0.65px low) and each letter's sides
// differ ("RC" sat 0.31px right in the 44px face), so components/Centred works the offset out by
// code, as Forge's measure reads it.
export default function HubFace({ buildingId, name, initials = null, photo = null, size = 'sm', className = '' }) {
  const src = useHubFaceSrc(buildingId, photo);
  const [loaded, setLoaded] = useState(null);
  const [broken, setBroken] = useState(null);
  const look = className || `avatar avatar-${size} avatar-1`;
  const letters = initials ?? hubInitials(name);
  return (
    <span className={`hub-face ${look}`} aria-hidden="true">
      <Centred kind="ink" className="hub-face-letters" watch={look}>{letters}</Centred>
      {src && src !== broken && (
        <img
          className={`avatar-img${loaded === src ? ' is-loaded' : ''}`}
          src={src}
          alt=""
          decoding="async"
          onLoad={() => setLoaded(src)}
          onError={() => setBroken(src)}
        />
      )}
    </span>
  );
}
