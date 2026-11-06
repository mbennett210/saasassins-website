import { useCallback, useEffect, useState } from 'react';
import { useSelector, shallowEqual } from '../store';
import { useAuth } from './useAuth';
import { selectClockContextForJob } from '../store/selectors';
import { geoPresence, PRESENCE } from '../lib/crewHome';

// The cleaner's live perimeter read for one clean (the Cleaner Hub, brief A §4): is this phone
// inside the clean's ring right now? DISPLAY ONLY — the server judges the punch from the
// coordinates the clock-in sends (PAY-17: an off-site punch is recorded, held for approval and the
// manager alerted; nothing is ever refused). The verdict is lib/crewHome geoPresence over the
// clean's own context (store/selectors selectClockContextForJob: the radius shift → site →
// company default, and the ring switched off for the site or for this cleaner), so the phone and
// the server reach the same answer.
//
// ONE position read per minute for the whole app, never `watchPosition` (a cleaner's battery
// lasts a night shift): a single getCurrentPosition when the first screen asks, again every 60 s
// while the page is visible, and at once when it comes back into view. Every screen that asks
// (Today's Stops draws one card per clean) shares that one fix.
const EVERY_MS = 60_000;
const OPTIONS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 };

const fixStore = { fix: null, locating: false, failed: false, subs: new Set(), timer: null };
const emit = () => { for (const fn of [...fixStore.subs]) fn(); };
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

function readFix() {
  if (fixStore.locating) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) { fixStore.failed = true; emit(); return; }
  fixStore.locating = true;
  emit();
  navigator.geolocation.getCurrentPosition(
    (p) => {
      fixStore.fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, at: Date.now() };
      fixStore.failed = false;
      fixStore.locating = false;
      emit();
    },
    () => { fixStore.failed = true; fixStore.locating = false; emit(); }, // denied / unavailable / timeout
    OPTIONS,
  );
}
const onVisibility = () => { if (visible()) readFix(); };

function subscribe(fn) {
  fixStore.subs.add(fn);
  if (fixStore.subs.size === 1) {
    readFix();
    fixStore.timer = setInterval(() => { if (visible()) readFix(); }, EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    fixStore.subs.delete(fn);
    if (fixStore.subs.size === 0) {
      clearInterval(fixStore.timer);
      fixStore.timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

// The shared fix: { fix, locating, failed }.
export function usePositionFix() {
  const [, tick] = useState(0);
  useEffect(() => subscribe(() => tick((n) => n + 1)), []);
  return { fix: fixStore.fix, locating: fixStore.locating && !fixStore.fix, failed: fixStore.failed && !fixStore.fix };
}

// → { state: 'inside'|'outside'|'unknown'|'noCentre'|'off', distanceM, locating }
export function useGeoPresence(job) {
  const { currentUser } = useAuth();
  const ctx = useSelector(
    useCallback((s) => (job ? selectClockContextForJob(s, job, currentUser?.id || null) : null), [job, currentUser?.id]),
    shallowEqual,
  );
  const { fix, locating } = usePositionFix();
  const out = geoPresence(ctx, fix);
  return { ...out, locating: out.state === PRESENCE.UNKNOWN && locating };
}
