// Thin client for server-side geocoding (GET /api/geo). Reuses the existing
// GOOGLE_MAPS_API_KEY server-side — no key in the browser. In local/demo mode
// there's no backend, so it throws a friendly message pointing at "use my
// location" / manual entry. See CLEANSPACE_SWEPT.md §2.5.
//
// 🔴 A FAILED LOOKUP KEEPS THE SERVER'S STATUS on the error it throws (2026-10-03). /api/geo
// answers 404 when Google found no match (the address needs fixing) and 503 when there is no
// key (nothing to fix in the address); lib/geocodeLocation classifyFailure tells the two apart
// BY that status. A bare Error carried none, so every failure read "unavailable" and a
// mistyped address would have told the office "lookup isn't set up" — on every one of ~750
// imported buildings once a key exists.
//
// A 429 (CS-083: this login's hourly allowance, or Google's quota on the key) also keeps the
// server's `code` and its Retry-After (as `retryAfterMs`), so lib/geocodeLocation can stop a run
// and a screen can say which refusal it was and when to try again.
//
// Its dependencies are injectable (and its imports name their files) so a node test drives
// this exact function: `fetchImpl`, `configured` and `headers` default to the real ones.
import { authHeaders } from './authHeader.js';
import { isAuthConfigured } from './supabaseClient.js';

export async function geocodeAddress(address, { fetchImpl, configured = isAuthConfigured, headers = authHeaders } = {}) {
  if (!configured()) {
    const e = new Error('Geocoding needs the live backend. Use “My location” or enter coordinates manually.');
    e.stub = true;
    throw e;
  }
  const auth = await headers();
  const get = fetchImpl || fetch;
  const res = await get(`/api/geo?address=${encodeURIComponent(address)}`, { headers: auth });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = new Error(json?.error || 'Geocoding failed');
    e.status = res.status;
    if (typeof json?.code === 'string') e.code = json.code;
    const wait = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(wait) && wait > 0) e.retryAfterMs = wait * 1000;
    throw e;
  }
  return json; // { lat, lng, formatted }
}
