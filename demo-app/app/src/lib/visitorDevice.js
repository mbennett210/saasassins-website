// The VISITOR's phone, as the public QR page knows it (QR-25's limits, QR-30's one vote a day):
// a random id kept in this browser's own storage — never a cookie, never a sign-in, sent only to
// the two visitor routes (EP-414 / EP-415), which store nothing but its HMAC. Private mode or a
// full storage keeps it for the page's life instead, so the page still works with no storage at
// all (the server's per-code and per-address limits still hold then).
//
// And the phone's memory of today's votes (lib/areaRatings rememberedVote / rememberVote over the
// same storage), so a visitor who comes back the same day sees their thumb still pressed.
import { VISITOR_DEVICE_ID_RE } from './visitorReports';
import { RATING_MEMORY_KEY } from './areaRatings';

export const VISITOR_DEVICE_KEY = 'cs.scanDevice.v1';
let pageId = null;

const storage = () => {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

// 16 bytes from the browser's CSPRNG, URL-safe: 'v' + 22 characters.
function mintDeviceId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return `v${btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function visitorDeviceId() {
  const ls = storage();
  try {
    const kept = ls?.getItem(VISITOR_DEVICE_KEY);
    if (kept && VISITOR_DEVICE_ID_RE.test(kept)) return kept;
  } catch { /* unreadable: mint below */ }
  if (pageId) return pageId;
  pageId = mintDeviceId();
  try { ls?.setItem(VISITOR_DEVICE_KEY, pageId); } catch { /* the page's life, then */ }
  return pageId;
}

export function readRatingMemory() {
  try {
    const m = JSON.parse(storage()?.getItem(RATING_MEMORY_KEY) || 'null');
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}
export function writeRatingMemory(memory) {
  try { storage()?.setItem(RATING_MEMORY_KEY, JSON.stringify(memory || {})); } catch { /* quota / private mode */ }
}
