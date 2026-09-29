// Drive-duration estimates between two sites — the baseline the paid inter-site
// travel is judged against.
//
// Source: Google **Routes API** `computeRoutes` (the current replacement for the
// legacy Distance Matrix API), called with routingPreference TRAFFIC_UNAWARE and a
// minimal field mask so every call bills at the cheapest (Essentials) tier. Reuses
// the existing backend GOOGLE_MAPS_API_KEY (also used by api/geo.js geocoding) —
// the Routes API must be ENABLED on that key's Google Cloud project.
//
// Cached per DIRECTIONAL site pair in drive_time_estimates: a pair's typical drive
// time barely moves, the call is billable, and a manager reloading the report all
// morning must not re-bill it. Invalidated when a site is re-geocoded (its pin
// moved more than COORD_EPSILON_M) or the row ages past MAX_AGE_DAYS.
//
// FAIL-SOFT by design: no key, API disabled, quota, network — every failure path
// returns "no estimate for this pair", which the pure engine renders as the slate
// 'No estimate' chip. It NEVER produces a zero, which would flag every leg as an
// overage and put phantom deductions in front of a manager.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { haversineMeters } from '../../../src/lib/geo.js';
import { driveEstimateKey } from '../../../src/lib/driveTime.js';

const TABLE = 'drive_time_estimates';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const MAX_AGE_DAYS = 180;   // re-price a pair twice a year (road changes, not traffic)
const COORD_EPSILON_M = 50; // a re-geocode that moves the pin further than this invalidates
// Hard ceiling on billable calls per report load. Beyond it the remaining pairs are
// reported as `pending` and resolve on the next load — a manager opening a 90-day
// report on a fresh cache can't fan out hundreds of paid calls in one click.
const MAX_FETCH_PER_CALL = 25;

const isFinite2 = (a, b) => Number.isFinite(a) && Number.isFinite(b);

// "1234s" | "1234.5s" -> whole minutes. Routes API returns duration as a STRING
// with a trailing 's' — parsing it as a number silently yields NaN.
export function parseGoogleDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(1, Math.round(v / 60));
  if (typeof v !== 'string') return null;
  const m = v.match(/^([\d.]+)s$/);
  if (!m) return null;
  const secs = Number(m[1]);
  if (!Number.isFinite(secs)) return null;
  return Math.max(1, Math.round(secs / 60));
}

// A cached row is usable when it isn't stale AND both endpoint snapshots still
// match where the sites actually are. Exported for the headless checks — a wrong
// answer here either re-bills every load or serves a route to the old address.
export function cacheIsFresh(row, fromSite, toSite) {
  if (!row) return false;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (!Number.isFinite(age) || age > MAX_AGE_DAYS * 86400000) return false;
  const moved = (snapLat, snapLng, site) => {
    if (!isFinite2(snapLat, snapLng)) return true;          // pre-snapshot row — re-fetch once
    const d = haversineMeters(snapLat, snapLng, site.lat, site.lng);
    return d == null || d > COORD_EPSILON_M;
  };
  if (moved(row.from_lat, row.from_lng, fromSite)) return false;
  if (moved(row.to_lat, row.to_lng, toSite)) return false;
  return true;
}

async function readCache(pairs) {
  if (!pairs.length) return new Map();
  const db = getSupabase();
  const fromIds = [...new Set(pairs.map((p) => p.fromSiteId))];
  const toIds = [...new Set(pairs.map((p) => p.toSiteId))];
  const { data, error } = await db.from(TABLE).select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .in('from_site_id', fromIds)
    .in('to_site_id', toIds);
  if (error) throw error;
  const map = new Map();
  for (const r of data || []) map.set(driveEstimateKey(r.from_site_id, r.to_site_id), r);
  return map;
}

// One billable Routes call. Returns { durationMinutes, distanceMeters } or null.
async function fetchGoogleRoute(fromSite, toSite, apiKey) {
  const body = {
    origin: { location: { latLng: { latitude: fromSite.lat, longitude: fromSite.lng } } },
    destination: { location: { latLng: { latitude: toSite.lat, longitude: toSite.lng } } },
    travelMode: 'DRIVE',
    // TRAFFIC_UNAWARE keeps the call on the cheapest SKU and makes the estimate
    // STABLE — a cached baseline that swung with rush hour would flag or clear the
    // same leg depending on when the report was opened.
    routingPreference: 'TRAFFIC_UNAWARE',
    units: 'IMPERIAL',
  };
  const res = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // The most likely cause on a fresh install is "Routes API has not been used in
    // project … before or it is disabled" — log Google's own text so the fix is
    // obvious instead of an unexplained wall of 'No estimate'.
    console.error('[drive/estimates] Routes API error', res.status, json?.error?.message || JSON.stringify(json || {}));
    return null;
  }
  const route = json?.routes?.[0];
  const durationMinutes = parseGoogleDuration(route?.duration);
  if (durationMinutes == null) return null;
  return {
    durationMinutes,
    distanceMeters: Number.isFinite(route?.distanceMeters) ? route.distanceMeters : null,
  };
}

async function writeCache(pair, fromSite, toSite, est) {
  const { error } = await getSupabase().from(TABLE).upsert({
    organization_id: CLEANSPACE_ORG_ID,
    from_site_id: pair.fromSiteId,
    to_site_id: pair.toSiteId,
    duration_minutes: est.durationMinutes,
    distance_meters: est.distanceMeters,
    from_lat: fromSite.lat, from_lng: fromSite.lng,
    to_lat: toSite.lat, to_lng: toSite.lng,
    source: 'google',
    fetched_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,from_site_id,to_site_id' });
  if (error) console.error('[drive/estimates] cache write failed', error.message);
}

// Resolve estimates for a batch of directional site pairs.
//   pairs: [{ fromSiteId, toSiteId }]  (already deduped by collectSitePairs)
//   siteById: Map|object of blob sites (needs .lat/.lng)
// Returns { lookup: Map(driveEstimateKey -> {durationMinutes,distanceMeters,source}),
//           pending: n }  — `pending` counts pairs deferred past the per-call cap or
// left unresolved by a Google failure, so the UI can say coverage is partial.
export async function resolveDriveEstimates(pairs, siteById, { allowFetch = true } = {}) {
  const lookup = new Map();
  const list = Array.isArray(pairs) ? pairs : [];
  if (!list.length) return { lookup, pending: 0, fetched: 0 };

  const site = (id) => (siteById instanceof Map ? siteById.get(id) : siteById?.[id]) || null;
  const usable = [];
  for (const p of list) {
    const f = site(p.fromSiteId);
    const t = site(p.toSiteId);
    // A site with no coordinates can't be routed. Not an error — the site just
    // hasn't been geocoded yet; the leg shows 'No estimate'.
    if (!f || !t || !isFinite2(f.lat, f.lng) || !isFinite2(t.lat, t.lng)) continue;
    usable.push({ ...p, fromSite: f, toSite: t });
  }
  if (!usable.length) return { lookup, pending: 0, fetched: 0 };

  let cache = new Map();
  try { cache = await readCache(usable); } catch (e) { console.error('[drive/estimates] cache read failed', e?.message || e); }

  const misses = [];
  for (const p of usable) {
    const key = driveEstimateKey(p.fromSiteId, p.toSiteId);
    const row = cache.get(key);
    if (cacheIsFresh(row, p.fromSite, p.toSite)) {
      lookup.set(key, {
        durationMinutes: row.duration_minutes,
        distanceMeters: row.distance_meters,
        source: row.source,
        fetchedAt: row.fetched_at,
      });
    } else {
      misses.push(p);
    }
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!misses.length) return { lookup, pending: 0, fetched: 0 };
  if (!allowFetch) return { lookup, pending: misses.length, fetched: 0 };
  if (!apiKey) {
    console.error('[drive/estimates] GOOGLE_MAPS_API_KEY is not set — legs will report No estimate');
    return { lookup, pending: misses.length, fetched: 0 };
  }

  const batch = misses.slice(0, MAX_FETCH_PER_CALL);
  let fetched = 0;
  // Sequential on purpose: a fan-out of billable calls from one page load is how a
  // Maps bill surprises someone. The cap plus the cache means steady-state is ~0.
  for (const p of batch) {
    let est = null;
    try { est = await fetchGoogleRoute(p.fromSite, p.toSite, apiKey); }
    catch (e) { console.error('[drive/estimates] Routes fetch failed', e?.message || e); }
    if (!est) continue;
    lookup.set(driveEstimateKey(p.fromSiteId, p.toSiteId), { ...est, source: 'google' });
    fetched += 1;
    try { await writeCache(p, p.fromSite, p.toSite, est); } catch { /* logged in writeCache */ }
  }
  return { lookup, pending: misses.length - fetched, fetched };
}

// Single-pair convenience for the crew "drive to your next site" hint.
export async function resolveOneEstimate(fromSiteId, toSiteId, siteById) {
  if (!fromSiteId || !toSiteId || fromSiteId === toSiteId) return null;
  const { lookup } = await resolveDriveEstimates([{ fromSiteId, toSiteId }], siteById);
  return lookup.get(driveEstimateKey(fromSiteId, toSiteId)) || null;
}
