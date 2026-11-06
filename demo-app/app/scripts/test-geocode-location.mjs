// CS-041 + CS-042 regression: the geofence centre must belong to the address on file,
// and every create path must produce coordinates or an explicit "not located" state.
//
//   CS-041  A failed geocode after an address EDIT kept the previous lat/lng, so crew
//           were measured against the address the customer had just moved away from —
//           behind a toast claiming it saved "without a clock-in location".
//   CS-042  Only LocationCard's Save ever geocoded. Add Customer, the CSV import and
//           AddContactModal's new company all left lat/lng null while the read view
//           said "locating from the address".
//
// Offline: the geocoder is INJECTED, so every branch (found / no match / no API key /
// demo stub / offline) is driven without a network or a key. GOOGLE_MAPS_API_KEY is
// unset in production (CS-036), so `unavailable` is the CURRENT live path.
//
// Run: node app/scripts/test-geocode-location.mjs
import {
  GEOCODE_STATUS, GEOCODE_REASON, NOT_ATTEMPTED,
  geocodePatch, needsGeocode, resolveGeocode, resolveGeocodeMany, classifyFailure,
  coordsMatchAddress, hasCoords,
  GEOCODE_CONCURRENCY, GEOCODE_MAX_PER_RUN,
} from '../src/lib/geocodeLocation.js';
// The namespace too, for exports a pre-fix tree lacks (a named import of one would crash the
// whole file instead of failing its checks).
import * as geocodeLib from '../src/lib/geocodeLocation.js';
import { buildClientLocation, clientLocationId } from '../src/lib/location.js';
import { geofenceVerdict } from '../src/lib/geo.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const OLD = { lat: 27.95, lng: -82.45, geocodedAddress: '1 Old St, Tampa FL 33601', geocodeStatus: GEOCODE_STATUS.LOCATED, address: '1 Old St, Tampa FL 33601' };
const NEW_ADDR = '900 New Ave, Tampa FL 33602';
const NOW = new Date('2026-09-29T12:00:00.000Z');

const found = async () => ({ lat: 28.1234567, lng: -82.7654321 });
const noMatch = async () => { const e = new Error('No geocoding match'); e.status = 404; throw e; };
const noKey = async () => { const e = new Error('Geocoding is not configured'); e.status = 503; throw e; };
const demoStub = async () => { const e = new Error('Geocoding needs the live backend.'); e.stub = true; throw e; };
const offline = async () => { const e = new Error('Failed to fetch'); throw e; };

console.log('CS-041 / CS-042 — the geofence centre follows the address\n');

// ── CS-041: a failed geocode after an address change must CLEAR the coordinates ──
for (const [label, geocode, expected] of [
  ['the geocoder finds nothing', noMatch, GEOCODE_STATUS.NOT_LOCATED],
  ['there is no API key (the live state, CS-036)', noKey, GEOCODE_STATUS.UNAVAILABLE],
  ['there is no backend (demo)', demoStub, GEOCODE_STATUS.UNAVAILABLE],
  ['the device is offline', offline, GEOCODE_STATUS.UNAVAILABLE],
]) {
  const p = await resolveGeocode({ address: NEW_ADDR, previous: OLD, geocode, now: NOW });
  ok(p.lat === null && p.lng === null, `address changed and ${label} → lat/lng cleared`);
  ok(p.geocodedAddress === null, `address changed and ${label} → geocodedAddress cleared`);
  ok(p.geocodeStatus === expected, `address changed and ${label} → status ${expected}`);
  ok(typeof p.geocodeCheckedAt === 'string', `address changed and ${label} → the attempt is timestamped`);
  // The point of clearing: the geofence must not judge against the OLD place.
  const v = geofenceVerdict({ siteLat: p.lat, siteLng: p.lng, deviceLat: 27.95, deviceLng: -82.45 });
  ok(v.result === 'no_site_coords' && v.allowed === true,
    `${label} → the geofence reports no_site_coords (flagged, not falsely measured)`);
}

// The old coordinates were a MEASURABLE distance from the new address, which is exactly
// the harm: keeping them produced a confident verdict about the wrong place.
const kept = geofenceVerdict({ siteLat: OLD.lat, siteLng: OLD.lng, deviceLat: OLD.lat, deviceLng: OLD.lng });
ok(kept.result === 'inside', 'pre-fix shape: kept coordinates yield a CONFIDENT verdict (about the old address)');

// A successful geocode writes the new centre, bound to the address it came from.
const good = await resolveGeocode({ address: NEW_ADDR, previous: OLD, geocode: found, now: NOW });
ok(good.lat === 28.123457 && good.lng === -82.765432, 'a located address stores coordinates rounded to 6dp');
ok(good.geocodedAddress === NEW_ADDR, 'the located address is recorded as geocodedAddress');
ok(good.geocodeStatus === GEOCODE_STATUS.LOCATED, 'status is located');
ok(coordsMatchAddress({ ...good, address: NEW_ADDR }), 'the stored coordinates match the stored address');

// ── No wasted lookups ────────────────────────────────────────────────────────
let calls = 0;
const counting = async (a) => { calls += 1; return found(a); };
const located = { ...good, address: NEW_ADDR };
ok(needsGeocode({ address: NEW_ADDR, previous: located }) === false, 'an unchanged, already-located address needs no lookup');
const skip = await resolveGeocode({ address: NEW_ADDR, previous: located, geocode: counting, now: NOW });
ok(calls === 0, 'saving without touching the address calls the geocoder ZERO times');
ok(skip.lat === located.lat && skip.geocodeStatus === GEOCODE_STATUS.LOCATED, 'an unchanged address keeps its coordinates');
ok(needsGeocode({ address: NEW_ADDR, previous: OLD }) === true, 'a CHANGED address needs a lookup');
ok(needsGeocode({ address: '', previous: OLD }) === false, 'an empty address never triggers a lookup');
calls = 0;
await resolveGeocode({ address: NEW_ADDR, previous: OLD, geocode: counting, now: NOW });
ok(calls === 1, 'a changed address calls the geocoder exactly ONCE (no retry loop)');

// Coordinates present but bound to a DIFFERENT address are stale and must be re-looked-up
// — this is the CS-041 state as it exists in the live blob today.
ok(needsGeocode({ address: NEW_ADDR, previous: { lat: 1, lng: 2, geocodedAddress: 'somewhere else' } }) === true,
  'coordinates bound to another address are treated as stale');
ok(coordsMatchAddress({ lat: 1, lng: 2, geocodedAddress: 'somewhere else', address: NEW_ADDR }) === false,
  'coordsMatchAddress rejects coordinates from another address');

// ── CS-042: a fresh customer's location starts honestly NOT located ──────────
const client = { id: 'cl_x', street: '900 New Ave', city: 'Tampa', state: 'FL', zip: '33602', serviceId: 'sv1', createdAt: NOW.toISOString() };
const loc = buildClientLocation(client, [{ id: 'sv1', defaultDurationMins: 90 }]);
ok(loc.id === clientLocationId(client.id), 'the location id is the deterministic one the create path can address');
ok(hasCoords(loc) === false, 'a newly built location has no coordinates');
ok(loc.geocodeStatus === NOT_ATTEMPTED, 'a newly built location is explicitly NOT_ATTEMPTED, not "locating"');
ok(loc.address === '900 New Ave, Tampa FL 33602', 'the location carries the composed address to geocode from');

// The create path then resolves it through the SAME function the editor uses.
const created = await resolveGeocode({ address: loc.address, previous: loc, geocode: found, now: NOW });
ok(created.geocodeStatus === GEOCODE_STATUS.LOCATED && hasCoords(created), 'a created customer gets located through the same path');
const createdNoKey = await resolveGeocode({ address: loc.address, previous: loc, geocode: noKey, now: NOW });
ok(createdNoKey.geocodeStatus === GEOCODE_STATUS.UNAVAILABLE && !hasCoords(createdNoKey),
  'with no API key a created customer is explicitly unavailable, never silently blank');

// Every status a location can end on must have copy explaining it — a bare "not located"
// with no reason is what sent people hunting for a typo that was really a missing key.
ok(typeof GEOCODE_REASON[GEOCODE_STATUS.NOT_LOCATED] === 'string' && GEOCODE_REASON[GEOCODE_STATUS.NOT_LOCATED].length > 0,
  'not_located has a reason to show');
ok(typeof GEOCODE_REASON[GEOCODE_STATUS.UNAVAILABLE] === 'string' && GEOCODE_REASON[GEOCODE_STATUS.UNAVAILABLE].length > 0,
  'unavailable has a DIFFERENT reason to show');
ok(GEOCODE_REASON[GEOCODE_STATUS.NOT_LOCATED] !== GEOCODE_REASON[GEOCODE_STATUS.UNAVAILABLE],
  'the two failure reasons are not the same sentence');

// ── classifyFailure: "fix the address" vs "the server can't look it up" ──────
ok(classifyFailure({ status: 404 }) === 'not_found', '404 → not_found');
ok(classifyFailure({ status: 503 }) === 'unavailable', '503 (no key) → unavailable');
ok(classifyFailure({ status: 502 }) === 'unavailable', '502 → unavailable');
ok(classifyFailure({ stub: true }) === 'unavailable', 'the demo stub → unavailable');
ok(classifyFailure(new Error('Failed to fetch')) === 'unavailable', 'a transport failure → unavailable');
ok(classifyFailure({ status: 400 }) === 'not_found', 'a 400 is about the address → not_found');

// ── Bulk: the ~750-building import must stay bounded ────────────────────────
const mkItem = (i) => ({ id: `st_${i}`, address: `${i} Bulk Rd, Tampa FL 33602`, previous: { lat: null, lng: null, geocodedAddress: null } });
let inFlight = 0;
let peak = 0;
let bulkCalls = 0;
const slow = async () => {
  inFlight += 1; peak = Math.max(peak, inFlight); bulkCalls += 1;
  await new Promise((r) => setTimeout(r, 1));
  inFlight -= 1;
  return { lat: 28, lng: -82 };
};
const many = Array.from({ length: 40 }, (_, i) => mkItem(i));
const bulk = await resolveGeocodeMany(many, { geocode: slow, now: NOW });
ok(bulk.patches.length === many.length, 'every item comes back with a patch');
ok(peak <= GEOCODE_CONCURRENCY, `at most GEOCODE_CONCURRENCY (${GEOCODE_CONCURRENCY}) lookups are in flight at once (peak ${peak})`);
ok(bulkCalls === many.length, 'each address is looked up exactly once');
ok(bulk.patches.every((p) => p.patch.geocodeStatus === GEOCODE_STATUS.LOCATED), 'all located');

// The per-run cap: past it, items are DEFERRED and left visibly not-located rather than
// firing an unbounded storm of lookups.
bulkCalls = 0;
const overCap = Array.from({ length: GEOCODE_MAX_PER_RUN + 25 }, (_, i) => mkItem(i));
const capped = await resolveGeocodeMany(overCap, { geocode: slow, now: NOW });
ok(bulkCalls === GEOCODE_MAX_PER_RUN, `the run looks up at most GEOCODE_MAX_PER_RUN (${GEOCODE_MAX_PER_RUN}) addresses`);
ok(capped.lookedUp === GEOCODE_MAX_PER_RUN && capped.deferred === 25, 'the rest are reported as deferred, not lost');
ok(capped.patches.length === GEOCODE_MAX_PER_RUN, 'deferred items get no patch, so nothing claims a status it did not check');

// An already-located address in a bulk run costs no budget at all.
bulkCalls = 0;
const mixed = [
  { id: 'st_a', address: NEW_ADDR, previous: located },
  { id: 'st_b', address: '5 Other Rd, Tampa FL 33602', previous: { lat: null, lng: null } },
];
const mix = await resolveGeocodeMany(mixed, { geocode: slow, now: NOW });
ok(bulkCalls === 1 && mix.skipped === 1 && mix.lookedUp === 1, 'a bulk run skips addresses that are already located');
ok(mix.patches.find((p) => p.id === 'st_a').patch.lat === located.lat, 'a skipped item keeps its coordinates');

// A bulk run with NO geocoder available marks everything unavailable and calls nothing.
const dry = await resolveGeocodeMany([mkItem(1)], { geocode: null, now: NOW });
ok(dry.patches[0].patch.geocodeStatus === GEOCODE_STATUS.UNAVAILABLE, 'no geocoder → unavailable, not a crash');

// geocodePatch always returns every field, so a stale value cannot survive by omission.
const FIELDS = ['lat', 'lng', 'geocodedAddress', 'geocodeStatus', 'geocodeCheckedAt'];
for (const kind of ['skipped', 'located', 'not_found', 'unavailable', 'limited']) {
  const p = geocodePatch({ address: NEW_ADDR, previous: OLD, outcome: { kind, lat: 1, lng: 2 }, now: NOW });
  ok(FIELDS.every((f) => f in p), `a '${kind}' patch writes every coordinate field`);
}

// ── The REAL client keeps the server's answer (the customer import, 2026-10-03) ──
// geoApi.geocodeAddress threw a bare Error with no status, so classifyFailure read NaN and
// called EVERY failure "unavailable": with a key set, a mistyped address would have told the
// office "lookup isn't set up" instead of "check the address". The checks above fed
// classifyFailure hand-made errors that carried a status; the one the app throws never did.
let geoApi = null;
try { geoApi = await import('../src/lib/geoApi.js'); } catch { /* the pre-change module does not load in node */ }
ok(!!geoApi, 'src/lib/geoApi.js loads in node (its imports name their files)');
if (geoApi) {
  const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const deps = (status, body) => ({ fetchImpl: answer(status, body), configured: () => true, headers: async () => ({}) });
  const outcome = async (status, body) => {
    try { await geoApi.geocodeAddress('1 Main St', deps(status, body)); return 'resolved'; } catch (e) { return classifyFailure(e); }
  };
  ok(await outcome(404, { error: 'No geocoding match' }) === 'not_found', 'a 404 from /api/geo is "not found" (fix the address)');
  ok(await outcome(503, { error: 'Geocoding is not configured' }) === 'unavailable', 'a 503 (no GOOGLE_MAPS_API_KEY) is "unavailable"');
  let resolved = null;
  try { resolved = await geoApi.geocodeAddress('1 Main St', deps(200, { lat: 26.1, lng: -80.1 })); } catch { resolved = null; }
  ok(resolved?.lat === 26.1, 'a 200 resolves its coordinates');
}

// ── Stop asking when nobody can answer (the ~750-building import, 2026-10-03) ──
// With no Maps key every lookup is a 503: a run spent its whole budget of 100 requests to
// learn the same thing 100 times. Opted into by the import; one not-found address (a typo)
// never stops a run — only "nobody can answer" does.
calls = 0;
const noKeyCounting = async () => { calls += 1; const e = new Error('Geocoding is not configured'); e.status = 503; throw e; };
const stopped = await resolveGeocodeMany(Array.from({ length: 30 }, (_, i) => mkItem(i)), { geocode: noKeyCounting, now: NOW, stopWhenUnavailable: true });
ok(calls <= GEOCODE_CONCURRENCY, `no key: the run stops after the first "unavailable" answers (${calls} asked, not 30)`);
ok(stopped.stoppedUnavailable === true && stopped.deferred + stopped.lookedUp === 30, 'the rest are reported as not asked, not lost');
ok(stopped.patches.length === calls && stopped.patches.every((p) => p.patch.geocodeStatus === GEOCODE_STATUS.UNAVAILABLE),
  'only the addresses actually asked are marked unavailable');
calls = 0;
const oneTypo = async (a) => { calls += 1; if (a.startsWith('0 ')) { const e = new Error('No match'); e.status = 404; throw e; } return { lat: 28, lng: -82 }; };
const typoRun = await resolveGeocodeMany(Array.from({ length: 10 }, (_, i) => mkItem(i)), { geocode: oneTypo, now: NOW, stopWhenUnavailable: true });
ok(calls === 10 && typoRun.patches.filter((p) => p.patch.geocodeStatus === GEOCODE_STATUS.NOT_LOCATED).length === 1 && !typoRun.stoppedUnavailable,
  'one address not found never stops the run');

// ── CS-083: a 429 (this login looked up too many addresses) is not "not found" ──────────────
// /api/geo refuses a login past its hourly allowance with 429. classifyFailure read every
// non-5xx status as "not found", so a refused run marked each building NOT_LOCATED: the
// Access tab told the office to fix an address that was fine, and "Locate the next 100" skips
// NOT_LOCATED buildings for good (customerImport.locatableLocations), so they were never asked
// again. A refusal is "nothing learned": it claims no status, and the run stops.
const RETRY_MS = 600000;
const limitedErr = () => { const e = new Error('Too many requests. Please try again shortly.'); e.status = 429; e.retryAfterMs = RETRY_MS; return e; };
const refuses = async () => { throw limitedErr(); };
ok(classifyFailure({ status: 429 }) === 'limited', '429 → limited, not not_found');
const p429 = await resolveGeocode({ address: NEW_ADDR, previous: OLD, geocode: refuses, now: NOW });
ok(p429.geocodeStatus !== GEOCODE_STATUS.NOT_LOCATED, 'a refused lookup never marks the address not found');
ok(p429.geocodeStatus === NOT_ATTEMPTED, 'a refused lookup leaves the location NOT_ATTEMPTED (still waiting to be located)');
ok(p429.lat === null && p429.lng === null && p429.geocodedAddress === null,
  'a refused lookup after an address change still clears the old coordinates (CS-041)');
ok(p429.geocodeCheckedAt === null, 'a refused lookup records no check: nothing was learned');
const outcome429 = typeof geocodeLib.resolveGeocodeOutcome === 'function'
  ? await geocodeLib.resolveGeocodeOutcome({ address: NEW_ADDR, previous: OLD, geocode: refuses, now: NOW })
  : null;
ok(outcome429?.kind === 'limited' && outcome429?.retryAfterMs === RETRY_MS,
  'resolveGeocodeOutcome names the refusal and when to ask again, so a screen can say so');
const outcomeOk = typeof geocodeLib.resolveGeocodeOutcome === 'function'
  ? await geocodeLib.resolveGeocodeOutcome({ address: NEW_ADDR, previous: OLD, geocode: found, now: NOW })
  : null;
ok(outcomeOk?.kind === 'located' && outcomeOk?.patch?.geocodeStatus === GEOCODE_STATUS.LOCATED,
  'resolveGeocodeOutcome carries the same patch resolveGeocode returns');
const { locatableLocations } = await import('../src/lib/customerImport.js');
const waitingAfter = locatableLocations({
  clients: [{ id: 'cl_1', type: 'customer' }],
  sites: [{ id: 'st_1', clientId: 'cl_1', address: NEW_ADDR, ...p429 }],
});
ok(waitingAfter.length === 1, 'a building whose lookup was refused stays in the "Locate the next 100" list');

const LIMIT_AFTER = 7;
calls = 0;
const limitedAfter = async () => { calls += 1; if (calls > LIMIT_AFTER) throw limitedErr(); return { lat: 28, lng: -82 }; };
const thirty = Array.from({ length: 30 }, (_, i) => mkItem(i));
const lim = await resolveGeocodeMany(thirty, { geocode: limitedAfter, now: NOW, stopWhenUnavailable: true });
ok(calls <= LIMIT_AFTER + GEOCODE_CONCURRENCY, `a refused lookup stops the run (${calls} asked, not 30)`);
ok(lim.stoppedLimited === true && lim.stoppedUnavailable === false, 'the run says it stopped because lookups were refused, not because lookup is not set up');
ok(lim.patches.length === LIMIT_AFTER && lim.patches.every((p) => p.patch.geocodeStatus === GEOCODE_STATUS.LOCATED),
  'only the answered addresses get a patch: a refused one claims nothing');
ok(lim.lookedUp === LIMIT_AFTER && lim.lookedUp + lim.deferred === thirty.length, 'the refused and the never-asked are deferred, not lost');
ok(lim.retryAfterMs === RETRY_MS, 'the run carries when the server will answer again');
calls = 0;
const limNoOptIn = await resolveGeocodeMany(thirty, { geocode: limitedAfter, now: NOW });
ok(calls <= LIMIT_AFTER + GEOCODE_CONCURRENCY && limNoOptIn.stoppedLimited === true,
  'a refusal stops every run, opted in or not: the next ask would only be refused too');

if (geoApi) {
  const r429 = async () => ({
    ok: false, status: 429,
    headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '1800' : null) },
    json: async () => ({ error: 'Too many requests. Please try again shortly.', code: 'rate-limited' }),
  });
  let err429 = null;
  try { await geoApi.geocodeAddress('1 Main St', { fetchImpl: r429, configured: () => true, headers: async () => ({}) }); } catch (e) { err429 = e; }
  ok(classifyFailure(err429) === 'limited', 'a 429 from /api/geo is "limited"');
  ok(err429?.retryAfterMs === 1800 * 1000, 'the error carries the server\'s Retry-After, in ms');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
