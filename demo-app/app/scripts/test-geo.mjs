// Node unit test for the SERVER-AUTHORITATIVE geofence (geofenceVerdict) that the
// offline clock replay re-runs on the buffered device coords. Pure — no Supabase,
// no network, no browser. Run:  node scripts/test-geo.mjs   (from app/)
import { geofenceVerdict, DEFAULT_GEOFENCE_RADIUS_M } from '../src/lib/geo.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const SITE = { lat: 47.5, lng: -122.3 };
const northMeters = (m) => SITE.lat + m / 111320; // ~metres north of the site

// Sanity: the default ring is ~76 m (250 ft).
ok(DEFAULT_GEOFENCE_RADIUS_M >= 74 && DEFAULT_GEOFENCE_RADIUS_M <= 78, `default radius ~76 m (got ${DEFAULT_GEOFENCE_RADIUS_M})`);

// inside: 50 m from the site, no accuracy widening → inside/allowed
{
  const v = geofenceVerdict({ siteLat: SITE.lat, siteLng: SITE.lng, deviceLat: northMeters(50), deviceLng: SITE.lng });
  ok(v.result === 'inside' && v.allowed === true, 'inside: 50 m from site → inside/allowed');
  ok(v.distanceM >= 45 && v.distanceM <= 55, `inside: distanceM ~50 (got ${v.distanceM})`);
}

// outside: 555 m from the site → outside/not allowed
{
  const v = geofenceVerdict({ siteLat: SITE.lat, siteLng: SITE.lng, deviceLat: northMeters(555), deviceLng: SITE.lng });
  ok(v.result === 'outside' && v.allowed === false, 'outside: 555 m from site → outside/not allowed');
  ok(v.distanceM >= 540 && v.distanceM <= 570, `outside: distanceM ~555 (got ${v.distanceM})`);
}

// accuracy widening: 100 m away (> ring) but a 60 m GPS accuracy widens the ring → inside
{
  const v = geofenceVerdict({ siteLat: SITE.lat, siteLng: SITE.lng, deviceLat: northMeters(100), deviceLng: SITE.lng, accuracyM: 60 });
  ok(v.result === 'inside', 'accuracy widening: 100 m + 60 m accuracy → inside');
}

// no site coords → no_site_coords, allowed (never block before a site is geocoded)
{
  const v = geofenceVerdict({ siteLat: null, siteLng: null, deviceLat: northMeters(50), deviceLng: SITE.lng });
  ok(v.result === 'no_site_coords' && v.allowed === true, 'no site coords → no_site_coords/allowed');
}

// geofence disabled on the site → override, allowed even when far away
{
  const v = geofenceVerdict({ siteLat: SITE.lat, siteLng: SITE.lng, deviceLat: northMeters(555), deviceLng: SITE.lng, enabled: false });
  ok(v.result === 'override' && v.allowed === true, 'geofence disabled → override/allowed even at 555 m');
}

// no device coords (GPS unavailable, e.g. offline capture) → unavailable, allowed
{
  const v = geofenceVerdict({ siteLat: SITE.lat, siteLng: SITE.lng, deviceLat: null, deviceLng: null });
  ok(v.result === 'unavailable' && v.allowed === true, 'no device coords → unavailable/allowed');
}

console.log(`\ngeofence verdict: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
