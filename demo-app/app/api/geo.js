// Server-side geocoding for site coordinates (the geofence center).
//
//   GET /api/geo?address=<address>  ->  200 { lat, lng, formatted }
//                                       404 'not-found'     Google has no match: fix the address
//                                       429 'rate-limited'  this login's allowance is used (CS-083),
//                                                           with Retry-After
//                                       429 'lookup-quota'  Google's quota on the key is used
//                                       503 'not-configured' no GOOGLE_MAPS_API_KEY
//                                       503 'lookup-failed' Google refused or failed the request
//
// Reuses the existing GOOGLE_MAPS_API_KEY (server-side, shared with the drive-time estimates
// — no new key) so the clock-in radius gate has a center to measure against.
// Without coordinates the geofence is inert (clock-in passes through as
// 'no_site_coords'), so this is the unblock for radius-gated clock-in. Gated on
// requireAuthority (a team member; a Disabled one can't spend the key); a single-segment
// path so it hits the function directly (no rewrite needed). See CLEANSPACE_SWEPT.md §2.5.
//
// 🔴 ONLY "NO MATCH" IS A 404 (CS-083). The client reads a 404 as "this address can't be found":
// the location is marked not located, its Access tab says to check the address, and the import's
// "Locate the next 100" skips it for good (customerImport.locatableLocations). Every other
// answer that isn't a match — Google's quota used up, the key refused, an outage — says nothing
// about the address, so it must never be a 404: it was, for every non-OK status, which would have
// marked real buildings "not located" the first time the daily cap ran out. Every body here is
// a fixed sentence and a code; nothing of Google's own text reaches the browser.

import { requireAuthority } from './_lib/authz.js';
import { allow } from './_lib/rateLimit.js';
import { GEOCODE_MAX_PER_RUN } from '../src/lib/geocodeLocation.js';

// ── CS-083: every lookup is billed to the company's Maps key, so each LOGIN gets an allowance ──
// The callers, and what they need:
//   · the Location editor's Save and "Locate address", and Add customer: one lookup per click;
//   · the customer import's "Locate the next 100" (lib/geocodeLocation resolveGeocodeMany):
//     GEOCODE_MAX_PER_RUN lookups per run, GEOCODE_CONCURRENCY at a time, never retried.
// Google's cap on the whole project is 300 geocodes a day (set 2026-10-13). So the allowance is
// a whole run and half another per hour (150): a full "Locate the next 100" always passes, with
// room for the day's ordinary saves, but nobody spends the company's whole day in one go — a
// second run straight after stops half way, and a third can't start within the hour. A loop that
// re-asks on every render (or a script) is refused after 150. Everyone shares ONE login in
// production today, so this is the whole office's allowance until each person has their own.
// Tied to GEOCODE_MAX_PER_RUN so a bigger run never trips it. Per serverless instance (see
// _lib/rateLimit.js): a backstop against a runaway, not a quota — Google's cap is the ceiling.
export const GEO_RATE = { limit: GEOCODE_MAX_PER_RUN + GEOCODE_MAX_PER_RUN / 2, windowMs: 60 * 60 * 1000 };

// Google's answer when the key's quota is used up. OVER_DAILY_LIMIT is also Google's word for a
// self-imposed usage cap (and for a billing problem); neither is about the address.
const QUOTA_STATUSES = new Set(['OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT']);

export default async function handler(req, res) {
  const a = await requireAuthority(req, res);
  if (!a) return;

  const address = (req.query.address || '').toString().trim();
  if (!address) return res.status(400).json({ error: 'address is required' });

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Geocoding is not configured', code: 'not-configured' });

  // Counted HERE, just before the billable call: a request refused above spends nothing.
  // Keyed on the login (the claim's member id, else its email), never the IP.
  if (!allow(req, res, { bucket: 'geo', id: a.orgUserId || a.email || a.user?.id || 'unknown', ...GEO_RATE, code: 'rate-limited' })) return;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    const r = await fetch(url);
    const data = await r.json();
    const status = typeof data?.status === 'string' ? data.status : 'UNKNOWN';
    const results = Array.isArray(data?.results) ? data.results : [];
    if (status === 'ZERO_RESULTS' || (status === 'OK' && results.length === 0)) {
      return res.status(404).json({ error: 'No geocoding match', code: 'not-found' });
    }
    if (status !== 'OK') {
      // Google's status only, never the URL (it carries the key) or its message.
      console.error(`[geo] Google answered ${status}`);
      if (QUOTA_STATUSES.has(status)) {
        return res.status(429).json({ error: 'Address lookups are used up for now. Please try again later.', code: 'lookup-quota' });
      }
      return res.status(503).json({ error: 'Address lookup isn’t available right now. Please try again later.', code: 'lookup-failed' });
    }
    const best = results[0];
    const loc = best.geometry?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return res.status(502).json({ error: 'Geocoding returned no coordinates' });
    }
    return res.status(200).json({ lat: loc.lat, lng: loc.lng, formatted: best.formatted_address || address });
  } catch {
    return res.status(502).json({ error: 'Geocoding request failed' });
  }
}
