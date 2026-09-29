// Server-side geocoding for site coordinates (the geofence center).
//
//   GET /api/geo?address=<address>  ->  { lat, lng, formatted }
//
// Reuses the existing GOOGLE_MAPS_API_KEY (already server-side for Places/reviews
// — no new key) so the clock-in radius gate has a center to measure against.
// Without coordinates the geofence is inert (clock-in passes through as
// 'no_site_coords'), so this is the unblock for radius-gated clock-in. Gated on
// requireAuthority (a team member; a Disabled one can't spend the key); a single-segment
// path so it hits the function directly (no rewrite needed). See CLEANSPACE_SWEPT.md §2.5.

import { requireAuthority } from './_lib/authz.js';

export default async function handler(req, res) {
  if (!(await requireAuthority(req, res))) return;

  const address = (req.query.address || '').toString().trim();
  if (!address) return res.status(400).json({ error: 'address is required' });

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Geocoding is not configured' });

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
      return res.status(404).json({ error: 'No geocoding match', status: data.status || 'UNKNOWN' });
    }
    const best = data.results[0];
    const loc = best.geometry?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return res.status(502).json({ error: 'Geocoding returned no coordinates' });
    }
    return res.status(200).json({ lat: loc.lat, lng: loc.lng, formatted: best.formatted_address || address });
  } catch {
    return res.status(502).json({ error: 'Geocoding request failed' });
  }
}
