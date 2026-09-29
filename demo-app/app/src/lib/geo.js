// Pure geo math for the clock-in geofence. NO React / browser / store deps —
// imported by the server clock-in route (app/api/time/*), the demo stub
// (timeApi.js), and the site geo-capture UI (distance preview), so the gate the
// crew sees in demo and the gate the server enforces in prod use ONE function.
//
// The geofence verdict is SERVER-AUTHORITATIVE in production: the client sends
// device coords, the server computes the haversine distance and decides. A
// client-side check is trivially spoofed, so the browser never owns the verdict.
// See CLEANSPACE_SWEPT.md §2.5 / §5.4.

// Great-circle distance in whole meters between two lat/lng points; null if any
// coordinate is non-finite.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n))) return null;
  const R = 6371000; // Earth radius, meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

// ── Unit helpers ─────────────────────────────────────────────────────────
// The geofence is computed + stored in METERS (the haversine is metric). Feet is
// a DISPLAY-only unit — convert at the render edge, never in the math. The
// clock-in radius default is expressed in feet (what Clean Space thinks in) and kept
// as its meters-equivalent for storage/enforcement. 250 ft ≈ 76 m.
export const FEET_PER_METER = 3.28084;
export const metersToFeet = (m) => (Number.isFinite(m) ? Math.round(m * FEET_PER_METER) : null);
export const feetToMeters = (ft) => (Number.isFinite(ft) ? ft / FEET_PER_METER : null);
// ONE source of truth for the clock-in radius default — seed `opsSettings` and
// every fallback (selectors, timeApi) derive from this, so retuning the fence is
// a one-line change right here.
export const DEFAULT_GEOFENCE_RADIUS_FT = 250;
export const DEFAULT_GEOFENCE_RADIUS_M = Math.round(DEFAULT_GEOFENCE_RADIUS_FT / FEET_PER_METER); // ≈ 76

// Geofence verdict. result is one of the time_entries.geofence_result enum:
// 'inside' | 'outside' | 'override' | 'no_site_coords' | 'unavailable'.
//   - no site coords  -> pass-through allow, flagged 'no_site_coords' (site not
//     geocoded yet — never block the trial before backfill; §2.5).
//   - geofence disabled -> allow, recorded 'override' w/ reason so the audit shows the
//     gate was bypassed by CONFIG, not by the cleaner (the enum has no 'disabled'). The
//     caller names WHICH config via `disabledReason`: the site's own switch
//     ('geofence_disabled', the default) or the office turning it off for this one cleaner
//     (`GEOFENCE_OFF_REASON` in lib/clockRules.js), so the two are told apart on the punch.
//   - no device coords -> allow, flagged 'unavailable' (momentary GPS miss with
//     connectivity present; the NO-CONNECTIVITY case is fail-closed client-side —
//     the request never reaches here). §5.4.
//   - coords present + enabled -> inside if distance <= radius + min(accuracy,cap).
// effectiveRadius widens the ring by the device's reported GPS accuracy (capped)
// so a poor fix doesn't false-block someone standing on the doorstep.
export function geofenceVerdict({
  siteLat, siteLng, deviceLat, deviceLng, accuracyM,
  radiusM = DEFAULT_GEOFENCE_RADIUS_M, enabled = true, accuracyCap = 100,
  disabledReason = 'geofence_disabled',
}) {
  const hasSite = Number.isFinite(siteLat) && Number.isFinite(siteLng);
  const hasDevice = Number.isFinite(deviceLat) && Number.isFinite(deviceLng);

  if (!hasSite) return { result: 'no_site_coords', distanceM: null, allowedM: null, allowed: true };
  if (enabled === false) {
    // The distance is still measured and stored: turning the ring off stops it BLOCKING,
    // it does not stop the office seeing where the punch happened.
    const distanceM = hasDevice ? haversineMeters(siteLat, siteLng, deviceLat, deviceLng) : null;
    return { result: 'override', distanceM, allowedM: null, allowed: true, reason: disabledReason || 'geofence_disabled' };
  }
  if (!hasDevice) return { result: 'unavailable', distanceM: null, allowedM: null, allowed: true };

  const distanceM = haversineMeters(siteLat, siteLng, deviceLat, deviceLng);
  const widen = Math.min(Number.isFinite(accuracyM) ? Math.max(0, accuracyM) : 0, accuracyCap);
  const allowedM = Math.round((Number.isFinite(radiusM) ? radiusM : DEFAULT_GEOFENCE_RADIUS_M) + widen);
  const inside = distanceM != null && distanceM <= allowedM;
  return { result: inside ? 'inside' : 'outside', distanceM, allowedM, allowed: inside };
}

// True when a verdict means the clock-in should be flagged for review (allowed but
// not positively confirmed inside the ring).
export function isFlaggedVerdict(result) {
  return result === 'no_site_coords' || result === 'unavailable' || result === 'override';
}
