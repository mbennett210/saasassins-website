// CS-083 — the two server routes that spend GOOGLE MAPS money are rate-limited PER LOGIN.
//
//   GET /api/geo?address=…                 Geocoding (the Location editor's save, Add customer,
//                                          the import's "Locate the next 100")
//   GET /api/time/drive-estimate?from&to   Routes (the cleaner's "drive to your next site" hint),
//                                          cached per site pair: a cache hit costs nothing
//
// Neither had any limit, so one stuck loop (a screen re-asking on every render, a script) could
// spend without bound on the company's key. Driven END TO END through the REAL handlers against
// fake-supabase.mjs, with Google itself faked and every call to it counted (no network, no
// credentials, no live project — BUILD_INTEGRITY §6b). What it pins:
//
//   G. /api/geo: a whole "Locate the next 100" run (GEOCODE_MAX_PER_RUN, the client's own cap)
//      passes; a runaway loop is refused with 429 at exactly GEO_RATE.limit + 1, before Google
//      is asked; the 429 is a plain sentence + a stable code + Retry-After; another login has its
//      own allowance; a new IP does not reset a login's; a request that never reaches Google
//      (no address, no key) spends nothing.
//      G7: only Google's "no match" is a 404; its quota (OVER_QUERY_LIMIT / OVER_DAILY_LIMIT) is a
//      429 and a refused key or an outage a 503, each a fixed sentence with none of Google's text.
//   D. drive-estimate: only a request that would CALL Google counts — an unroutable pair asked
//      over and over is refused at DRIVE_ESTIMATE_RATE.limit + 1; a cached pair is answered free
//      even while that login is refused; another login has its own allowance.
//   E. End to end, the import's bounded run (resolveGeocodeMany) through the app's own client
//      (geoApi) through the handler: Google's cap running out, a refused key, and one login
//      pressing "Locate the next 100" twice all stop the run and mark NO building "not located",
//      so every unanswered building stays in the next run's list.
//
// The limits are read from the handlers (GEO_RATE, DRIVE_ESTIMATE_RATE), never restated. Google's
// own caps on the project (300 geocodes and 300 ComputeRoutes a day, set 2026-10-13) are console
// settings, so G0 states the policy against them in runs: one run passes, three cannot.
// REGRESSION (THE LAW II.3): on the pre-fix tree neither constant exists, no request is ever
// refused, and every non-OK Google status is a 404 — G0/D0, every "refused at limit + 1", G7's
// quota/denied rows and all of E fail.
//
//   node app/scripts/test-geo-rate-limit.mjs
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-000000000001';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
const KEY = 'fake-maps-key';
process.env.GOOGLE_MAPS_API_KEY = KEY;

// ── Google, faked: every call counted, answered the way Google answers ──────────────
// `geoStatus(n)` picks the Geocoding status for the n-th call (1-based): 'OK', 'OK_EMPTY' (OK
// with no results), or any of Google's own non-OK statuses, which carry Google's message.
const GOOGLE_TEXT = 'GOOGLE-OWN-TEXT-7d1';
const google = { geocode: 0, routes: 0, routesFail: false, geoStatus: () => 'OK' };
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://maps.googleapis.com/maps/api/geocode/json')) {
    google.geocode += 1;
    const s = google.geoStatus(google.geocode);
    if (s === 'OK') return answer(200, { status: 'OK', results: [{ geometry: { location: { lat: 26.12, lng: -80.14 } }, formatted_address: '1 Main St' }] });
    if (s === 'OK_EMPTY') return answer(200, { status: 'OK', results: [] });
    return answer(200, { status: s, results: [], error_message: `${GOOGLE_TEXT} (${s})` });
  }
  if (u.startsWith('https://routes.googleapis.com/directions/v2:computeRoutes')) {
    google.routes += 1;
    // An unroutable pair: Google answers, but with no route, so nothing is cached and the
    // next ask for the same pair is billed again — the runaway this limit exists for.
    if (google.routesFail) return answer(400, { error: { message: 'no route' } });
    return answer(200, { routes: [{ duration: '900s', distanceMeters: 12000 }] });
  }
  throw new Error(`network blocked in this suite (${u})`);
};

const { installFakeSupabase, resetWorld } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { GEOCODE_MAX_PER_RUN, GEOCODE_CONCURRENCY, GEOCODE_STATUS, resolveGeocodeMany } = await import('../src/lib/geocodeLocation.js');
const { locatableLocations } = await import('../src/lib/customerImport.js');
const geoApi = await import('../src/lib/geoApi.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const geoMod = await import('../api/geo.js');
const timeMod = await import('../api/time/[...path].js');
const geoHandler = geoMod.default;
const timeHandler = timeMod.default;
const GEO_RATE = geoMod.GEO_RATE;
const DRIVE_RATE = timeMod.DRIVE_ESTIMATE_RATE;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree and a
// swapped call "passes" on a truthy label.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

// A runaway loop must be refused well inside this many requests. It bounds the pre-fix run
// (which is never refused) — it is the test's own definition of "quickly", not a limit.
const RUNAWAY = 5000;

// ── the world ───────────────────────────────────────────────────────────────────────
const PEOPLE = {
  office: { id: 'u_office', role: 'owner' },
  office2: { id: 'u_office2', role: 'admin' },
  crew1: { id: 'u_crew1', role: 'crew' },
  crew2: { id: 'u_crew2', role: 'crew' },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: `Name ${k}` }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [
  `tok-${k}`, { id: `auth-${k}`, email: emailOf(k), app_metadata: { role: p.role, org_user_id: p.id, org_id: ORG } },
]));
// Eight geocoded sites a few km apart.
const SITES = Array.from({ length: 8 }, (_, i) => ({ id: `st_${i}`, clientId: 'cl_1', name: `Site ${i}`, lat: 26.1 + i * 0.01, lng: -80.1 - i * 0.01 }));
const site = (i) => SITES[i];

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
          company: { name: 'Clean Space', timezone: 'America/New_York' },
          clients: [{ id: 'cl_1', name: 'Coral Bay HOA' }],
          sites: SITES, opsSettings: {},
        },
      }],
      // st_0 → st_1 is already priced (a fresh cache row whose pins match the sites).
      drive_time_estimates: [{
        organization_id: ORG, from_site_id: 'st_0', to_site_id: 'st_1',
        duration_minutes: 14, distance_meters: 9000,
        from_lat: site(0).lat, from_lng: site(0).lng, to_lat: site(1).lat, to_lng: site(1).lng,
        source: 'google', fetched_at: new Date(Date.now() - 86400000).toISOString(),
      }],
    },
    logins,
  });
  __resetRateLimit();
  google.geocode = 0; google.routes = 0; google.routesFail = false; google.geoStatus = () => 'OK';
  process.env.GOOGLE_MAPS_API_KEY = KEY;
}

// The console is silenced while any request is in flight — counted, because the end-to-end
// runs below drive several at once and a per-call save/restore would leave it silenced.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let inFlight = 0;
async function call(handler, { who, query = {}, ip = '203.0.113.7' }) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'x-vercel-forwarded-for': ip };
  req.query = query;
  if (inFlight++ === 0) console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const hdrs = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers: hdrs }); };
      const res = {
        statusCode: 200,
        setHeader(k, v) { hdrs[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { if (--inFlight === 0) Object.assign(console, realConsole); }
}
// The app's own client (lib/geoApi.geocodeAddress) wired to the REAL handler, as `who`: the
// chain the import and the Location editor actually run, status and headers included.
const geocodeAs = (who) => (address) => geoApi.geocodeAddress(address, {
  configured: () => true,
  headers: async () => ({}),
  fetchImpl: async (url) => {
    const r = await call(geoHandler, { who, query: { address: new URL(url, 'http://app.test').searchParams.get('address') } });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => r.headers[String(h).toLowerCase()] ?? null },
      json: async () => r.body,
    };
  },
});
const bulkItems = (n, tag = 'Bulk') => Array.from({ length: n }, (_, i) => ({
  id: `st_${tag}_${i}`, address: `${i} ${tag} Rd, Tampa FL 33602`, previous: { lat: null, lng: null, geocodedAddress: null },
}));
const countStatus = (run, s) => run.patches.filter((p) => p.patch.geocodeStatus === s).length;
const geo = (who, address = '1 Main St, Pompano Beach FL 33062', opts = {}) => call(geoHandler, { who, query: { address }, ...opts });
const drive = (who, from, to) => call(timeHandler, { who, query: { subpath: 'drive-estimate', fromSiteId: `st_${from}`, toSiteId: `st_${to}` } });

// Asks until the first 429, at most RUNAWAY times. Returns the 1-based number of the refused
// request (null when none was) and that refusal.
async function untilRefused(ask) {
  for (let n = 1; n <= RUNAWAY; n += 1) {
    const r = await ask(n);
    if (r.status === 429) return { at: n, refusal: r };
    if (r.status !== 200) return { at: null, refusal: null, broke: r };
  }
  return { at: null, refusal: null };
}
const plainRefusal = (label, r) => {
  ok(`${label}: the 429 is a plain sentence`, typeof r?.body?.error === 'string' && r.body.error.length > 0
    && !/\d|google|maps|routes|geocod|bucket|limit/i.test(r.body.error), show(r || {}));
  eq(`${label}: …with a stable code a screen can branch on`, r?.body?.code, 'rate-limited');
  ok(`${label}: …and a Retry-After in whole seconds`, /^\d+$/.test(String(r?.headers?.['retry-after'] ?? '')) && Number(r.headers['retry-after']) > 0, show(r || {}));
};

// ── G. /api/geo ─────────────────────────────────────────────────────────────────────
ok('G0 api/geo.js exports GEO_RATE { limit, windowMs }', Number.isInteger(GEO_RATE?.limit) && GEO_RATE.limit > 0
  && Number.isFinite(GEO_RATE?.windowMs) && GEO_RATE.windowMs > 0, `got ${JSON.stringify(GEO_RATE)}`);
ok('G0 …and one login\'s allowance holds a whole "Locate the next 100" run', (GEO_RATE?.limit ?? 0) >= GEOCODE_MAX_PER_RUN);
// Google's cap on the project is 300 geocodes a day (2026-10-13): three runs. One login must not
// be able to spend it in one sitting.
ok('G0 …but not three back-to-back runs (Google\'s whole daily cap) inside its window', (GEO_RATE?.limit ?? Infinity) < 3 * GEOCODE_MAX_PER_RUN);
{
  seed();
  let all200 = true;
  for (let i = 0; i < GEOCODE_MAX_PER_RUN; i += 1) {
    const r = await geo('office', `${i} Bulk Rd, Tampa FL 33602`);
    if (r.status !== 200) { all200 = false; ok(`G1 lookup ${i + 1} of a full run answers 200`, false, show(r)); break; }
  }
  ok(`G1 a full "Locate the next ${GEOCODE_MAX_PER_RUN}" run answers 200 every time`, all200);
  eq('G1 …and asks Google once per building', google.geocode, GEOCODE_MAX_PER_RUN);
}
{
  seed();
  const { at, refusal, broke } = await untilRefused(() => geo('office'));
  ok('G2 a runaway geocode loop is refused (429)', at !== null, broke ? show(broke) : `no 429 in ${RUNAWAY} requests`);
  eq('G2 …at exactly GEO_RATE.limit + 1', at, (GEO_RATE?.limit ?? NaN) + 1);
  eq('G2 …and the refused request never reached Google', google.geocode, at === null ? -1 : at - 1);
  if (refusal) plainRefusal('G2', refusal);
  const before = google.geocode;
  eq('G3 the same login stays refused', (await geo('office')).status, 429);
  eq('G3 …from another IP too (the bucket is the login, not the address)', (await geo('office', undefined, { ip: '198.51.100.9' })).status, 429);
  eq('G4 another office login has its own allowance', (await geo('office2')).status, 200);
  eq('G4 …and so does a crew login', (await geo('crew1')).status, 200);
  eq('G4 …each of those asked Google once', google.geocode, before + 2);
}
{
  seed();
  const n = (GEO_RATE?.limit ?? 0) + 5;
  delete process.env.GOOGLE_MAPS_API_KEY;
  let all503 = true;
  for (let i = 0; i < n; i += 1) if ((await geo('office')).status !== 503) all503 = false;
  ok('G5 with no key every lookup is 503 (nothing to spend)', all503);
  process.env.GOOGLE_MAPS_API_KEY = KEY;
  let all400 = true;
  for (let i = 0; i < n; i += 1) if ((await geo('office', '')).status !== 400) all400 = false;
  ok('G5 a lookup with no address is 400', all400);
  eq('G5 …and neither spent the allowance: the next real lookup answers 200', (await geo('office')).status, 200);
}
{
  seed();
  eq('G6 no login is still 401, never a 429 or a Google call', (await geo(null)).status, 401);
  eq('G6 …Google untouched', google.geocode, 0);
}
// G7 — ONLY "no match" is a 404. A 404 tells the office to fix the address, and the import's
// "Locate the next 100" skips that building for good; Google's quota, a refused key or an
// outage say nothing about the address (the coordinator, 2026-10-13: the project's daily cap).
for (const [s, want, code] of [
  ['ZERO_RESULTS', 404, 'not-found'],
  ['OK_EMPTY', 404, 'not-found'],
  ['OVER_QUERY_LIMIT', 429, 'lookup-quota'],
  ['OVER_DAILY_LIMIT', 429, 'lookup-quota'],
  ['REQUEST_DENIED', 503, 'lookup-failed'],
  ['INVALID_REQUEST', 503, 'lookup-failed'],
  ['UNKNOWN_ERROR', 503, 'lookup-failed'],
]) {
  seed();
  google.geoStatus = () => s;
  const r = await geo('office');
  eq(`G7 Google ${s} → ${want}`, r.status, want);
  eq(`G7 …code ${code}`, r.body?.code, code);
  const wire = JSON.stringify(r.body || {});
  ok(`G7 …a fixed sentence, nothing of Google's own text or the key (${s})`, typeof r.body?.error === 'string'
    && !wire.includes(GOOGLE_TEXT) && !wire.includes(KEY) && !wire.includes(s), wire);
}

// ── E. end to end: the import's bounded run, through the app's client, through the handler ──
{
  // E1 — Google's daily cap runs out part way through a run.
  seed();
  google.geoStatus = (n) => (n > 5 ? 'OVER_QUERY_LIMIT' : 'OK');
  const items = bulkItems(30, 'Quota');
  const run = await resolveGeocodeMany(items, { geocode: geocodeAs('office'), stopWhenUnavailable: true });
  eq('E1 the cap running out marks NO building "not located"', countStatus(run, GEOCODE_STATUS.NOT_LOCATED), 0);
  eq('E1 …the five answered are located', countStatus(run, GEOCODE_STATUS.LOCATED), 5);
  ok('E1 …and the run stops instead of asking the rest', google.geocode <= 5 + GEOCODE_CONCURRENCY, `asked Google ${google.geocode} times for 30`);
  ok('E1 …saying lookups were refused', run.stoppedLimited === true && run.limitCode === 'lookup-quota', JSON.stringify({ stoppedLimited: run.stoppedLimited, limitCode: run.limitCode }));
  const sites = items.map((it) => ({ id: it.id, clientId: 'cl_1', address: it.address, ...(run.patches.find((p) => p.id === it.id)?.patch || {}) }));
  eq('E1 …so the other 25 are still waiting for "Locate the next 100"',
    locatableLocations({ clients: [{ id: 'cl_1', type: 'customer' }], sites }).length, 25);
}
{
  // E2 — the key is refused (restricted wrongly, billing): nobody can answer, nothing is "not found".
  seed();
  google.geoStatus = () => 'REQUEST_DENIED';
  const items = bulkItems(30, 'Denied');
  const run = await resolveGeocodeMany(items, { geocode: geocodeAs('office'), stopWhenUnavailable: true });
  eq('E2 a refused key marks NO building "not located"', countStatus(run, GEOCODE_STATUS.NOT_LOCATED), 0);
  ok('E2 …the run stops at the first answers', run.stoppedUnavailable === true && google.geocode <= GEOCODE_CONCURRENCY, `asked ${google.geocode}`);
  const sites = items.map((it) => ({ id: it.id, clientId: 'cl_1', address: it.address, ...(run.patches.find((p) => p.id === it.id)?.patch || {}) }));
  eq('E2 …and every building is still waiting to be located', locatableLocations({ clients: [{ id: 'cl_1', type: 'customer' }], sites }).length, 30);
}
{
  // E3 — one login presses "Locate the next 100" twice, back to back.
  seed();
  const first = await resolveGeocodeMany(bulkItems(GEOCODE_MAX_PER_RUN, 'One'), { geocode: geocodeAs('office'), stopWhenUnavailable: true });
  eq('E3 the first full run locates every building', countStatus(first, GEOCODE_STATUS.LOCATED), GEOCODE_MAX_PER_RUN);
  ok('E3 …and is not refused', first.stoppedLimited !== true);
  const second = await resolveGeocodeMany(bulkItems(GEOCODE_MAX_PER_RUN, 'Two'), { geocode: geocodeAs('office'), stopWhenUnavailable: true });
  eq('E3 the second run stops where the login\'s allowance ends', countStatus(second, GEOCODE_STATUS.LOCATED), (GEO_RATE?.limit ?? NaN) - GEOCODE_MAX_PER_RUN);
  eq('E3 …marking nothing "not located"', countStatus(second, GEOCODE_STATUS.NOT_LOCATED), 0);
  ok('E3 …saying this login was refused, and when to ask again', second.stoppedLimited === true && second.limitCode === 'rate-limited'
    && second.retryAfterMs > 0, JSON.stringify({ stoppedLimited: second.stoppedLimited, limitCode: second.limitCode, retryAfterMs: second.retryAfterMs }));
  eq('E3 …Google was asked exactly the allowance, no more', google.geocode, GEO_RATE?.limit ?? NaN);
}

// ── D. /api/time/drive-estimate ─────────────────────────────────────────────────────
ok('D0 api/time exports DRIVE_ESTIMATE_RATE { limit, windowMs }', Number.isInteger(DRIVE_RATE?.limit) && DRIVE_RATE.limit > 0
  && Number.isFinite(DRIVE_RATE?.windowMs) && DRIVE_RATE.windowMs > 0, `got ${JSON.stringify(DRIVE_RATE)}`);
{
  seed();
  const r = await drive('crew1', 0, 1);
  eq('D1 a cached pair answers 200', r.status, 200);
  eq('D1 …with the cached minutes', r.body?.estimate?.durationMinutes, 14);
  eq('D1 …and never asks Google', google.routes, 0);
  const fresh = await drive('crew1', 2, 3);
  eq('D1 a new pair answers 200 with Google\'s minutes', fresh.body?.estimate?.durationMinutes, 15);
  const again = await drive('crew1', 2, 3);
  eq('D1 …and is cached: asking again is free', google.routes, 1);
  eq('D1 …with the same minutes', again.body?.estimate?.durationMinutes, 15);
}
{
  seed();
  google.routesFail = true; // every ask for this pair is billed and caches nothing
  const { at, refusal, broke } = await untilRefused(() => drive('crew1', 4, 5));
  ok('D2 a runaway on an unroutable pair is refused (429)', at !== null, broke ? show(broke) : `no 429 in ${RUNAWAY} requests`);
  eq('D2 …at exactly DRIVE_ESTIMATE_RATE.limit + 1', at, (DRIVE_RATE?.limit ?? NaN) + 1);
  eq('D2 …and the refused request never reached Google', google.routes, at === null ? -1 : at - 1);
  if (refusal) plainRefusal('D2', refusal);
  const billed = google.routes;
  const cached = await drive('crew1', 0, 1);
  eq('D3 a refused login still gets a CACHED pair (it costs nothing)', cached.status, 200);
  eq('D3 …with its minutes', cached.body?.estimate?.durationMinutes, 14);
  eq('D3 …and Google untouched', google.routes, billed);
  eq('D4 another cleaner has their own allowance', (await drive('crew2', 4, 5)).status, 200);
  eq('D4 …and that ask was billed once', google.routes, billed + 1);
}
{
  seed();
  // Cache hits do not spend the allowance: limit + 5 cached asks, then a billable one passes.
  const n = (DRIVE_RATE?.limit ?? 0) + 5;
  let all200 = true;
  for (let i = 0; i < n; i += 1) if ((await drive('crew1', 0, 1)).status !== 200) all200 = false;
  ok(`D5 ${n} cached asks all answer 200`, all200);
  eq('D5 …none reached Google', google.routes, 0);
  const billable = await drive('crew1', 6, 7);
  eq('D5 …and the next billable ask still passes', billable.status, 200);
  eq('D5 …billed once', google.routes, 1);
}
{
  seed();
  delete process.env.GOOGLE_MAPS_API_KEY;
  const n = (DRIVE_RATE?.limit ?? 0) + 5;
  let allNull = true;
  for (let i = 0; i < n; i += 1) {
    const r = await drive('crew1', 2, 3);
    if (r.status !== 200 || r.body?.estimate !== null) allNull = false;
  }
  ok('D6 with no key an uncached pair answers 200 { estimate: null } (fail-soft)', allNull);
  process.env.GOOGLE_MAPS_API_KEY = KEY;
  eq('D6 …and spent nothing: the next billable ask passes', (await drive('crew1', 2, 3)).status, 200);
}

if (fails.length) { console.error('\ngeo-rate-limit FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\ngeo-rate-limit: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
