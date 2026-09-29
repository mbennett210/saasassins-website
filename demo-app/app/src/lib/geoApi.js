// Thin client for server-side geocoding (GET /api/geo). Reuses the existing
// GOOGLE_MAPS_API_KEY server-side — no key in the browser. In local/demo mode
// there's no backend, so it throws a friendly message pointing at "use my
// location" / manual entry. See CLEANSPACE_SWEPT.md §2.5.
import { authHeaders } from './authHeader';
import { isAuthConfigured } from './supabaseClient';

export async function geocodeAddress(address) {
  if (!isAuthConfigured()) {
    const e = new Error('Geocoding needs the live backend. Use “My location” or enter coordinates manually.');
    e.stub = true;
    throw e;
  }
  const auth = await authHeaders();
  const res = await fetch(`/api/geo?address=${encodeURIComponent(address)}`, { headers: auth });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json?.error || 'Geocoding failed');
  return json; // { lat, lng, formatted }
}
