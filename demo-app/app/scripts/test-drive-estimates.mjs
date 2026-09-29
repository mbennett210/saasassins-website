// Headless checks for the drive-estimate cache layer (api/_lib/time/driveEstimates.js).
// No network, no Supabase — only the two pure decisions that layer makes:
// how a Google duration is parsed, and when a cached row must be thrown away.
// Run: node scripts/test-drive-estimates.mjs
import { parseGoogleDuration, cacheIsFresh } from '../api/_lib/time/driveEstimates.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

// --- Routes API returns duration as a STRING with a trailing 's' ---
eq('parses "1234s"', parseGoogleDuration('1234s'), 21);
eq('parses fractional seconds', parseGoogleDuration('1234.5s'), 21);
eq('rounds to the nearest minute', parseGoogleDuration('90s'), 2);
eq('sub-minute drive floors at 1 min', parseGoogleDuration('29s'), 1);
eq('accepts a raw number of seconds', parseGoogleDuration(600), 10);
eq('rejects a bare number string', parseGoogleDuration('1234'), null);
eq('rejects garbage', parseGoogleDuration('PT20M'), null);
eq('rejects null/undefined', [parseGoogleDuration(null), parseGoogleDuration(undefined)], [null, null]);

// --- cache invalidation ---
const A = { lat: 47.6062, lng: -122.3321 };
const B = { lat: 47.6740, lng: -122.1215 };
const fresh = {
  fetched_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  from_lat: A.lat, from_lng: A.lng, to_lat: B.lat, to_lng: B.lng,
};
eq('fresh row with matching pins is reused', cacheIsFresh(fresh, A, B), true);
eq('missing row is never fresh', cacheIsFresh(null, A, B), false);
eq('row older than 180d is re-fetched', cacheIsFresh({ ...fresh, fetched_at: new Date(Date.now() - 200 * 86400000).toISOString() }, A, B), false);
eq('pre-snapshot row (no coords) is re-fetched once', cacheIsFresh({ ...fresh, from_lat: null, from_lng: null }, A, B), false);
// A re-geocode that actually moves the site invalidates its cached legs...
const moved = { lat: 47.6500, lng: -122.3500 };
eq('re-geocoded origin invalidates', cacheIsFresh(fresh, moved, B), false);
eq('re-geocoded destination invalidates', cacheIsFresh(fresh, A, moved), false);
// ...but GPS-scale jitter (a few metres) must not re-bill every load.
const jitter = { lat: A.lat + 0.0001, lng: A.lng };   // ~11 m
eq('metre-scale pin jitter keeps the cache', cacheIsFresh(fresh, jitter, B), true);
eq('a site that loses its coords invalidates', cacheIsFresh(fresh, { lat: null, lng: null }, B), false);

console.log(`\ndrive-estimates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
