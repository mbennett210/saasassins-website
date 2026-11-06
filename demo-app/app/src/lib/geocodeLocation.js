// The ONE rule for turning a location's address into its clock-in geofence centre.
//
// ══ WHY THIS IS A MODULE AND NOT A FEW LINES IN LocationCard ══════════════════
// It used to be a few lines in LocationCard, and they were wrong in two ways that
// both ended with the geofence judging clock-ins against the wrong place:
//
//   CS-041  A failed geocode after an address EDIT kept the previous lat/lng. The
//           toast said the location "will save without a clock-in location", which
//           was not true — it saved with the OLD one, so crew were measured against
//           the address they had just moved away from.
//   CS-042  Nothing except LocationCard's Save ever geocoded at all. Every other
//           create path (Add Customer, the CSV import, AddContactModal's new
//           company) left lat/lng null while the read view claimed it was
//           "locating from the address". It never was.
//
// So the decision lives here, as a PURE function over {address, previous, outcome},
// and every path — the editor's Save and every create — asks the same question and
// writes the same fields. `resolveGeocode` is the async wrapper that calls the
// geocoder; the geocoder is INJECTED so a node test can drive every branch offline.
//
// ══ THE RULE ══════════════════════════════════════════════════════════════════
// Coordinates are only ever kept when they belong to the address currently on file:
// `geocodedAddress` is the address they were resolved FROM, and a mismatch means they
// are not usable. When a geocode fails, the coordinates are CLEARED, not kept —
// lib/geo.js then returns 'no_site_coords', which lets a clock-in through flagged
// rather than blocking or passing it on a false measurement. A location with no
// coordinates is shown as "address not located" (never "locating…", which implied
// work in progress that was not happening).
//
// GOOGLE_MAPS_API_KEY was unset in production until 2026-10-13 (CS-036), so `unavailable`
// had to be right with no key at all; it now also covers Google refusing the key or failing.
//
// A LOOKUP THE SERVER REFUSED (429, CS-083) LEARNS NOTHING. /api/geo answers 429 when this
// login has used its hourly allowance or Google's daily quota on the key is used up. That says
// nothing about the address, so it is neither `not_found` (which tells the office to fix a
// good address, and which "Locate the next 100" never asks again) nor `unavailable`: the
// location stays NOT_ATTEMPTED, waiting for the next run, and a bulk run stops.

// What is known about a location's coordinates. Written to `site.geocodeStatus`;
// additive and default-safe (a site from before this reads `undefined` → treated as
// NOT_ATTEMPTED), so no store-version bump.
export const GEOCODE_STATUS = Object.freeze({
  /** Coordinates resolved, and they belong to the address on file. */
  LOCATED: 'located',
  /** The geocoder answered and could not place this address. Fix the address. */
  NOT_LOCATED: 'not_located',
  /** No geocoder to answer — no API key (CS-036), Google refused or failed, no backend (demo), or offline. */
  UNAVAILABLE: 'unavailable',
});

/** A site that has never been through this path (an older record). */
export const NOT_ATTEMPTED = null;

// Short, plain-language reason per status — one copy source for the Location card and
// anywhere else that has to explain why the geofence is not enforcing.
export const GEOCODE_REASON = Object.freeze({
  [GEOCODE_STATUS.NOT_LOCATED]: 'We couldn’t find this address on the map. Check the street, city and ZIP.',
  [GEOCODE_STATUS.UNAVAILABLE]: 'Address lookup wasn’t available, so the clock-in area isn’t placed yet.',
});

// Coordinates are stored to 6 decimal places — ~11 cm, far finer than any geofence
// radius, and it keeps the blob small and diffs stable.
const COORD_DP = 6;
const round6 = (n) => +Number(n).toFixed(COORD_DP);

/** True when a site has a usable geofence centre. */
export function hasCoords(site) {
  return Number.isFinite(site?.lat) && Number.isFinite(site?.lng);
}

/**
 * True when `site`'s coordinates were resolved from the address it currently holds.
 * Coordinates whose `geocodedAddress` does not match are STALE and must not be used:
 * that mismatch is precisely the CS-041 state (address edited, geocode failed, old
 * coordinates left behind).
 */
export function coordsMatchAddress(site, address = site?.address) {
  const a = (address || '').trim();
  return hasCoords(site) && !!a && (site.geocodedAddress || '') === a;
}

/**
 * The coordinate patch for a save. PURE — no network, no clock beyond `now`.
 *
 * @param address  the composed one-line address being saved ('' when incomplete)
 * @param previous the site as it stands (for its existing coords + geocodedAddress)
 * @param outcome  {kind:'skipped'} address unchanged and already located
 *                 {kind:'located', lat, lng}
 *                 {kind:'not_found'} the geocoder ran and found nothing
 *                 {kind:'unavailable'} there was no geocoder to ask
 *                 {kind:'limited'} the server refused the lookup (429): nothing learned
 * @returns the fields to merge into the site — always ALL of them, so a stale value
 *          can never survive by omission.
 */
export function geocodePatch({ address, previous = {}, outcome, now = new Date() }) {
  const addr = (address || '').trim();
  const at = (now instanceof Date ? now : new Date(now)).toISOString();

  if (outcome?.kind === 'skipped') {
    // Nothing was asked because the address is unchanged AND already located. Carry the
    // existing values forward verbatim, including the timestamp — asserting nothing new.
    return {
      lat: previous.lat ?? null,
      lng: previous.lng ?? null,
      geocodedAddress: previous.geocodedAddress || null,
      geocodeStatus: previous.geocodeStatus ?? NOT_ATTEMPTED,
      geocodeCheckedAt: previous.geocodeCheckedAt || null,
    };
  }

  if (outcome?.kind === 'located' && Number.isFinite(Number(outcome.lat)) && Number.isFinite(Number(outcome.lng))) {
    return {
      lat: round6(outcome.lat),
      lng: round6(outcome.lng),
      geocodedAddress: addr,
      geocodeStatus: GEOCODE_STATUS.LOCATED,
      geocodeCheckedAt: at,
    };
  }

  if (outcome?.kind === 'limited') {
    // CS-083: refused before anyone looked. The location claims nothing — NOT_ATTEMPTED, no
    // check time — so it waits for the next Locate run. Its coordinates still go: a lookup is
    // only asked when they don't belong to this address (needsGeocode), so keeping them is CS-041.
    return { lat: null, lng: null, geocodedAddress: null, geocodeStatus: NOT_ATTEMPTED, geocodeCheckedAt: null };
  }

  // EVERY failure clears the coordinates (CS-041). An address with no coordinates is
  // honest and safe — the geofence passes a clock-in through as 'no_site_coords' — while
  // keeping the old pair silently measured crew against a place they no longer clean.
  return {
    lat: null,
    lng: null,
    geocodedAddress: null,
    geocodeStatus: outcome?.kind === 'unavailable' ? GEOCODE_STATUS.UNAVAILABLE : GEOCODE_STATUS.NOT_LOCATED,
    geocodeCheckedAt: at,
  };
}

/**
 * Does this save need to call the geocoder? Only when there is an address AND it is not
 * already the one the current coordinates were resolved from. This is what keeps the
 * ~750-building import (and every ordinary Save) from spending a lookup per submit: an
 * unchanged address costs nothing, and NOTHING here is wired to typing, only to a save.
 */
export function needsGeocode({ address, previous = {} }) {
  const addr = (address || '').trim();
  if (!addr) return false;
  return !coordsMatchAddress({ ...previous, address: addr }, addr);
}

/**
 * Resolve one address into its coordinate patch, calling `geocode` at most ONCE.
 *
 * @param geocode async (address) => { lat, lng } — inject `lib/geoApi.geocodeAddress`
 *                in the app, a stub in tests. A thrown error carrying `.stub` (demo,
 *                no backend), a 503 (no API key — CS-036) or any transport failure is
 *                `unavailable`; a 404/no-match is `not_found`. There is no retry: a
 *                second identical call gets the same answer, and a retry loop over an
 *                import of 750 buildings is how a key gets rate-limited or a bill runs.
 */
export async function resolveGeocode(args) {
  return (await resolveGeocodeOutcome(args)).patch;
}

/**
 * resolveGeocode, plus what happened: { kind, patch, retryAfterMs, code }. `kind` is the
 * outcome geocodePatch was given ('skipped' | 'located' | 'not_found' | 'unavailable' |
 * 'limited'); for 'limited', `retryAfterMs` is when the server will answer again (null when it
 * didn't say) and `code` which refusal it was ('rate-limited': this login's allowance;
 * 'lookup-quota': Google's quota on the key). A screen needs these to say a refused lookup was
 * refused, rather than show the patch's NOT_ATTEMPTED as if nothing had been tried.
 */
export async function resolveGeocodeOutcome({ address, previous = {}, geocode, now = new Date() }) {
  const addr = (address || '').trim();
  const done = (outcome, extra = {}) => ({
    kind: outcome.kind,
    patch: geocodePatch({ address: addr, previous, outcome, now }),
    retryAfterMs: extra.retryAfterMs ?? null,
    code: extra.code ?? null,
  });
  if (!addr) return done({ kind: 'not_found' });
  if (!needsGeocode({ address: addr, previous })) return done({ kind: 'skipped' });
  if (typeof geocode !== 'function') return done({ kind: 'unavailable' });
  try {
    const r = await geocode(addr);
    const lat = Number(r?.lat);
    const lng = Number(r?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return done({ kind: 'not_found' });
    return done({ kind: 'located', lat, lng });
  } catch (err) {
    const kind = classifyFailure(err);
    if (kind !== 'limited') return done({ kind });
    const wait = Number(err?.retryAfterMs);
    return done({ kind }, {
      retryAfterMs: Number.isFinite(wait) && wait > 0 ? wait : null,
      code: typeof err?.code === 'string' ? err.code : null,
    });
  }
}

/**
 * Which failure this is. 'not_found' means the address is wrong and someone should fix
 * it; 'unavailable' means the server can't look anything up and the address may be
 * perfect; 'limited' means the server refused to ask (429: this login's allowance, or
 * Google's quota) and nothing was learned. Telling a manager to "check the address" when the
 * real problem is a missing API key, or a busy hour, sends them hunting for a typo that
 * isn't there.
 */
export function classifyFailure(err) {
  if (err?.stub) return 'unavailable';                        // demo / no backend
  const status = Number(err?.status);
  if (status === 404) return 'not_found';                     // geocoder ran, no match
  if (status === 429) return 'limited';                       // refused before asking (CS-083)
  if (Number.isFinite(status) && status >= 500) return 'unavailable';  // 502/503 — no key, upstream down
  if (status === 0 || !Number.isFinite(status)) return 'unavailable';  // transport / offline
  return 'not_found';
}

// ── Bulk: the imported-book path ─────────────────────────────────────────────
// Matt's book is ~750 buildings, so the import cannot fire 750 parallel lookups (the
// browser caps connections, Google rate-limits, and a half-finished storm leaves the
// book in an unknown state). These bound it: at most GEOCODE_CONCURRENCY in flight,
// at most GEOCODE_MAX_PER_RUN looked up per run, and never a retry. Anything past the
// cap is simply left NOT_ATTEMPTED — visibly "not located", to be picked up by the
// next run rather than silently wrong.
export const GEOCODE_CONCURRENCY = 3;
export const GEOCODE_MAX_PER_RUN = 100;

/**
 * Resolve many locations, bounded. `items` is [{ id, address, previous }].
 * Returns { patches: [{ id, patch }], lookedUp, skipped, deferred, stoppedUnavailable,
 *           stoppedLimited, limitCode, retryAfterMs }.
 * `deferred` is the count left untouched (NOT_ATTEMPTED): past the per-run cap, or — with
 * `stopWhenUnavailable` — after the geocoder answered "unavailable" (no GOOGLE_MAPS_API_KEY,
 * Google refusing the key, no backend, offline). Asking again would only spend requests to
 * learn the same thing, so the Customers import opts in; a single "not found" (one mistyped
 * address) never stops a run.
 * A REFUSED lookup (429: this login's allowance, or Google's quota — CS-083) ALWAYS stops the
 * run, opted in or not, since every further ask would be refused too. The refused address gets
 * no patch and counts as deferred, so it claims nothing and stays waiting for the next run;
 * `limitCode` and `retryAfterMs` say which refusal and when the server will answer again.
 */
export async function resolveGeocodeMany(items, { geocode, now = new Date(), concurrency = GEOCODE_CONCURRENCY, maxPerRun = GEOCODE_MAX_PER_RUN, stopWhenUnavailable = false } = {}) {
  const list = Array.isArray(items) ? items.filter((it) => it && it.id) : [];
  const patches = [];
  let lookedUp = 0;
  let skipped = 0;
  let deferred = 0;
  let refused = 0;
  let stoppedUnavailable = false;
  let stoppedLimited = false;
  let limitCode = null;
  let retryAfterMs = null;

  // Split first, so the cap applies to LOOKUPS and an unchanged address never consumes
  // budget. A skipped item still gets its (unchanged) patch, keeping the caller's write
  // uniform.
  const toLookUp = [];
  for (const it of list) {
    if (!needsGeocode({ address: it.address, previous: it.previous })) {
      skipped += 1;
      patches.push({ id: it.id, patch: geocodePatch({ address: it.address, previous: it.previous, outcome: { kind: 'skipped' }, now }) });
    } else if (toLookUp.length < Math.max(0, maxPerRun)) {
      toLookUp.push(it);
    } else {
      deferred += 1;
    }
  }

  // A fixed pool of workers over a shared cursor — bounded in flight, and it terminates
  // because the cursor only ever moves forward.
  let next = 0;
  const stopped = () => stoppedUnavailable || stoppedLimited;
  const worker = async () => {
    while (next < toLookUp.length && !stopped()) {
      const it = toLookUp[next];
      next += 1;
      const out = await resolveGeocodeOutcome({ address: it.address, previous: it.previous, geocode, now });
      if (out.kind === 'limited') {
        refused += 1;
        stoppedLimited = true;
        limitCode = limitCode || out.code;
        if (out.retryAfterMs) retryAfterMs = Math.max(retryAfterMs || 0, out.retryAfterMs);
        continue;
      }
      lookedUp += 1;
      patches.push({ id: it.id, patch: out.patch });
      if (stopWhenUnavailable && out.patch.geocodeStatus === GEOCODE_STATUS.UNAVAILABLE) stoppedUnavailable = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), toLookUp.length || 1) }, worker));
  // Never asked, or refused before anyone looked: left NOT_ATTEMPTED, claiming nothing.
  deferred += toLookUp.length - next + refused;

  return { patches, lookedUp, skipped, deferred, stoppedUnavailable, stoppedLimited, limitCode, retryAfterMs };
}
