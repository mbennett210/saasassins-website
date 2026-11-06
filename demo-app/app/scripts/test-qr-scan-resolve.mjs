// THE QR SCAN FOR SIGNED-IN PEOPLE (the Cleaner Hub, D5; plan docs/plans/2026-10-13-cleaner-hub.md;
// Matt: "QR code scan — a code posted on site opens that location's checklist directly. Add this on
// the client hub as well"). The REAL handlers over fake-supabase.mjs (no network, no credentials, no
// live project — BUILD_INTEGRITY §6b), plus the pure rules the screens and the routes share.
//
// What it holds, in the order it matters:
//   A. 🔴 TOKEN PARSING (lib/areaScan scanTokenFromText): the token from a scanned `…/scan/<token>`
//      URL on ANY origin, or a bare token — validated against the minter's own alphabet and length
//      (encodeScanToken) — and anything else is null ("That isn't a site code").
//   B. The pure rules: where a code is (lib/scanCodes scanLocationOf — a removed location or area is
//      nowhere), which of today's cleans a scan opens (crewCleanAtLocation), and the two answers
//      built key by key from their allowlists.
//   C. 🔴 THE STAFF RESOLVE (EP-386, GET /api/scan-codes/resolve): any staff login, on its OWN door
//      ahead of the office branches, for ANY live code — a cleaner too since QR Wave 2 (QR-14: a
//      filler is sent anywhere; what they may do there is test-qr-fill-in.mjs's); an unknown /
//      replaced / malformed / orphaned code is the public route's SAME 404 scan-code-inactive;
//      rate-limited per login; a customer login is refused; the office's ensure / replace / sheet are
//      unchanged (crew still refused).
//   D. 🔴 THE HUB SCAN (EP-387, GET /api/hub/scan): requireHubCaller first; the code's building must
//      be in the caller's scope (403 not-your-building); the office's preview is scoped to its one
//      building; a cleaner sending the preview header is refused; inactive codes the same 404.
//   E. Wiring: one scanner component over a LAZY qr-scanner (never in the main bundle), stopped on
//      unmount and when the page is hidden, its words passed in; the routes, the paths, the hub's
//      button, and the service worker keeping the scan page and its scanner chunks.
//
// REGRESSION (THE LAW II.3): on the tree before this change none of the exports, branches or files
// exist, so every check below reports what it wanted.
//
//   node app/scripts/test-qr-scan-resolve.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const scan = await import('../src/lib/areaScan.js').catch(() => ({}));
const codesLib = await import('../src/lib/scanCodes.js').catch(() => ({}));
const officeHandler = (await import('../api/scan-codes/[...path].js').catch(() => ({}))).default || null;
const hubHandler = (await import('../api/hub/[...path].js').catch(() => ({}))).default || null;
const PREVIEW = await import('../src/lib/hubPreview.js').catch(() => ({}));

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree and a swapped
// call "passes" on a truthy label.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 260)}`;
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
async function section(name, f) {
  try { await f(); } catch (e) { fails.push(`§${name} stopped: ${String((e && e.message) || e).split('\n')[0]}`); }
}

// ── A. token parsing ─────────────────────────────────────────────────────────
await section('A', async () => {
  const parse = fn(scan, 'scanTokenFromText');
  const encode = fn(scan, 'encodeScanToken');
  const bytes = Uint8Array.from({ length: scan.SCAN_TOKEN_BYTES || 24 }, (_, i) => (i * 37 + 11) & 255);
  const tok = encode(bytes);
  ok('A0 the minter makes a token to scan', typeof tok === 'string' && scan.isScanToken?.(tok), String(tok));
  eq('A1 a bare token is itself', parse(tok), tok);
  eq('A2 …around spaces and a newline (a scanner may add them)', parse(`  ${tok}\n`), tok);
  eq('A3 the production URL', parse(`https://cleanspace-gilt.vercel.app/scan/${tok}`), tok);
  eq('A4 ANY origin: the app moves to its own domain and old labels stay on the walls', parse(`https://www.cleancorner.app/scan/${tok}`), tok);
  eq('A5 a local dev origin (http)', parse(`http://localhost:5364/scan/${tok}`), tok);
  eq('A6 a trailing slash, a query and a hash do not matter', parse(`https://x.example/scan/${tok}/?utm=wall#top`), tok);
  ok('A7 a path that is not /scan/<token> is not a site code', [
    `https://x.example/other/${tok}`, `https://x.example/scan/${tok}/extra`, `https://x.example/a/scan/${tok}`,
    'https://x.example/scan/', 'https://x.example/',
  ].every((s) => parse(s) === null));
  ok('A8 only http(s): another scheme is not a site code', [`ftp://x.example/scan/${tok}`, `javascript:alert(1)//scan/${tok}`, `data:text/plain,${tok}`].every((s) => parse(s) === null));
  ok('A9 the minter\'s alphabet and length: standard base64, padding, 31 or 33 characters are not tokens', [
    `${tok.slice(0, 31)}+`, `${tok.slice(0, 31)}/`, `${tok.slice(0, 31)}=`, tok.slice(0, 31), `${tok}A`,
    `https://x.example/scan/${tok.slice(0, 31)}`,
  ].every((s) => parse(s) === null));
  ok('A10 not text, empty, or absurdly long → null', [null, undefined, 42, {}, '', '   ', `https://x.example/scan/${tok}?${'q'.repeat(5000)}`].every((s) => parse(s) === null));
  eq('A11 a percent-encoded token decodes to itself', parse(`https://x.example/scan/${encodeURIComponent(tok)}`), tok);
  const all64 = encode(Uint8Array.from({ length: 24 }, () => 255));
  eq('A12 every character the minter can write parses (the URL-safe "-" and "_")', parse(`https://x.example/scan/${all64}`), all64);
});

// ── B. the pure rules ────────────────────────────────────────────────────────
const SITES = [
  { id: 's_club', clientId: 'cl_coral', name: 'Clubhouse', cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }] },
  { id: 's_pool', clientId: 'cl_coral', name: 'Pool house', cleaningAreas: [{ id: 'area_deck', label: 'Deck' }] },
  { id: 's_tower', clientId: 'cl_harbor', name: 'Harbor Tower', cleaningAreas: [{ id: 'area_hall', label: 'Hall' }] },
  { id: 's_lone', clientId: null, name: 'Loose site', cleaningAreas: [{ id: 'area_x', label: 'X' }] },
];
const CLIENTS = [{ id: 'cl_coral', name: 'Coral Bay HOA' }, { id: 'cl_harbor', name: 'Harbor Tower' }];
await section('B', async () => {
  const where = fn(codesLib, 'scanLocationOf');
  const loc = where({ code: { siteId: 's_club', areaId: 'area_rest' }, sites: SITES, clients: CLIENTS });
  ok('B1 a live code is its location, customer and area', !!loc && loc.siteId === 's_club' && loc.clientId === 'cl_coral' && loc.areaId === 'area_rest'
    && loc.siteName === 'Clubhouse' && loc.building === 'Coral Bay HOA' && loc.area === 'Restrooms', JSON.stringify(loc));
  eq('B2 a code whose location was removed is nowhere', where({ code: { siteId: 's_gone', areaId: 'area_rest' }, sites: SITES, clients: CLIENTS }), null);
  eq('B3 a code whose AREA was removed is nowhere (the public page answers "no longer active" too)', where({ code: { siteId: 's_club', areaId: 'area_gone' }, sites: SITES, clients: CLIENTS }), null);
  eq('B4 no code is nowhere', where({ code: null, sites: SITES, clients: CLIENTS }), null);
  const lone = where({ code: { siteId: 's_lone', areaId: 'area_x' }, sites: SITES, clients: CLIENTS });
  ok('B5 a location with no customer resolves with no customer (no building scope can hold it)', !!lone && lone.clientId === null && lone.building === 'Loose site', JSON.stringify(lone));

  const K = codesLib.SCAN_RESOLVE_KEYS || [];
  const HK = codesLib.HUB_SCAN_KEYS || [];
  ok('B6 the staff answer is the allowlist, key by key', JSON.stringify(Object.keys(fn(codesLib, 'projectScanResolve')({ ...loc, secret: 'x', accessNotes: 'door 4411' }) || {})) === JSON.stringify(K) && K.length === 6, JSON.stringify(K));
  // QR Wave 2 (QR-16): the customer's scan opens that AREA's own page, so its answer names the area
  // (the page's address is the building and the area) — and still never the location's id.
  ok('B7 the customer\'s answer is its own allowlist (the area\'s id for its page; no location id)', JSON.stringify(Object.keys(fn(codesLib, 'projectHubScan')({ ...loc, secret: 'x' }) || {})) === JSON.stringify(HK)
    && HK.length === 4 && !HK.includes('siteId') && HK.includes('areaId') && fn(codesLib, 'projectHubScan')(loc)?.areaId === 'area_rest', JSON.stringify(HK));

  const pick = fn(codesLib, 'crewCleanAtLocation');
  const J = (id, siteId, status, startAt, clientId = 'cl_coral') => ({ id, siteId, clientId, status, startAt });
  const cleans = [
    J('j_done', 's_club', 'done', '2026-10-13T20:00:00Z'),
    J('j_live', 's_club', 'in_progress', '2026-10-13T22:00:00Z'),
    J('j_next', 's_club', 'upcoming', '2026-10-14T01:00:00Z'),
    J('j_pool', 's_pool', 'upcoming', '2026-10-13T23:00:00Z'),
  ];
  eq('B8 the clean in progress at that location wins', pick({ cleans, siteId: 's_club', clientId: 'cl_coral' })?.id, 'j_live');
  eq('B9 else the first one not finished', pick({ cleans: cleans.filter((j) => j.id !== 'j_live'), siteId: 's_club', clientId: 'cl_coral' })?.id, 'j_next');
  eq('B10 else the last one there (all done: the checklist still opens to read)', pick({ cleans: [cleans[0]], siteId: 's_club', clientId: 'cl_coral' })?.id, 'j_done');
  eq('B11 another location of the same customer is not this location', pick({ cleans: [cleans[3]], siteId: 's_club', clientId: 'cl_coral' }), null);
  eq('B12 a clean with no location counts for its customer', pick({ cleans: [{ id: 'j_nosite', siteId: null, clientId: 'cl_coral', status: 'upcoming', startAt: 'x' }], siteId: 's_club', clientId: 'cl_coral' })?.id, 'j_nosite');
  eq('B13 a cancelled clean opens nothing', pick({ cleans: [J('j_x', 's_club', 'cancelled', 'x')], siteId: 's_club', clientId: 'cl_coral' }), null);
  eq('B14 no cleans: nothing', pick({ cleans: [], siteId: 's_club', clientId: 'cl_coral' }), null);
});

// ── the world (C, D) ─────────────────────────────────────────────────────────
const HOUR = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const T = (c) => c.repeat(32);
const TOK = { lobby: T('L'), rest: T('R'), deck: T('D'), tower: T('W'), old: T('O'), orphan: T('X'), unknown: T('U') };
const CU1 = 'c0000000-0000-4000-8000-000000000001'; // Coral Bay's contact
const CU2 = 'c0000000-0000-4000-8000-000000000002'; // Harbor's contact
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },     // cleans the Clubhouse tonight
  crew2: { id: 'u_crew2', role: 'crew', claim: true },   // cleans only Harbor Tower
  crew3: { id: 'u_crew3', role: 'crew', claim: true },   // cleans nowhere
};
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: `${k}@example.test`, role: p.role, status: 'active', name: `Name ${k}` }));
const logins = {
  ...Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
    id: `auth-${k}`, email: `${k}@example.test`, app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
  }])),
  'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
  'tok-client2': { id: 'auth-c2', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU2, org_id: ORG } },
};
const job = (id, clientId, siteId, crewIds, startMs, status = 'upcoming') => ({
  id, organization_id: ORG, client_id: clientId, site_id: siteId, status, start_at: iso(startMs),
  data: { id, clientId, siteId, crewIds, startAt: iso(startMs), endAt: iso(startMs + 2 * HOUR), status },
});
const code = (id, siteId, areaId, token, extra = {}) => ({
  id, organization_id: ORG, site_id: siteId, area_id: areaId, token, created_at: iso(NOW - 48 * HOUR), created_by: 'u_owner', revoked_at: null, revoked_by: null, ...extra,
});
function seed() {
  __resetRateLimit?.();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 4,
        state: {
          company: { name: 'Clean Space', timezone: 'America/New_York' },
          users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
          clients: CLIENTS.map((c) => ({ ...c })),
          sites: SITES.map((s) => ({ ...s, accessNotes: 'door code 4411 SECRET' })),
          opsSettings: {}, notifications: [],
        },
      }],
      area_scan_codes: [
        code('c1', 's_club', 'area_lobby', TOK.lobby),
        code('c2', 's_club', 'area_rest', TOK.rest),
        code('c3', 's_pool', 'area_deck', TOK.deck),
        code('c4', 's_tower', 'area_hall', TOK.tower),
        code('c5', 's_club', 'area_rest', TOK.old, { revoked_at: iso(NOW - 24 * HOUR), revoked_by: 'u_owner' }),
        code('c6', 's_club', 'area_gone', TOK.orphan),
      ],
      jobs: [
        job('j_club_tonight', 'cl_coral', 's_club', ['u_crew'], NOW + HOUR),
        job('j_tower', 'cl_harbor', 's_tower', ['u_crew2'], NOW - HOUR, 'in_progress'),
      ],
      crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1' },
        { id: CU2, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c2' },
      ],
      client_user_groups: [], client_user_group_members: [],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_coral', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU2, client_id: 'cl_harbor', group_id: null },
      ],
      activity_log: [], activity_log_baseline: [],
    },
    logins,
  });
}

async function call(handler, { method = 'GET', path: p, token, query = {}, body, headers: extra = {} }) {
  const req = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, query: { subpath: p, ...query }, body: body || {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null, headers: {} }), 10000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler ? handler(req, res) : res.status(404).json({ error: 'no handler' })).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const resolve = (who, token, extra = {}) => call(officeHandler, { path: 'resolve', token: who ? `tok-${who}` : undefined, query: { token }, ...extra });
const INACTIVE = scan.SCAN_INACTIVE_CODE || 'scan-code-inactive';

// ── C. the staff resolve (EP-386) ────────────────────────────────────────────
await section('C', async () => {
  seed();
  const anon = await resolve(null, TOK.rest);
  eq('C1 no login → 401', anon.status, 401);
  const own = await resolve('owner', TOK.rest);
  ok('C2 the office (Super Admin) resolves any code: location, customer, area and their names', own.status === 200
    && own.body.siteId === 's_club' && own.body.clientId === 'cl_coral' && own.body.areaId === 'area_rest'
    && own.body.siteName === 'Clubhouse' && own.body.building === 'Coral Bay HOA' && own.body.area === 'Restrooms', show(own));
  ok('C3 …the answer is the allowlist and nothing else (no access notes, no token)', own.status === 200
    && JSON.stringify(Object.keys(own.body)) === JSON.stringify(codesLib.SCAN_RESOLVE_KEYS || ['?']) && !/4411|SECRET|LLLL|RRRR/.test(JSON.stringify(own.body)), show(own));
  eq('C4 …never cached', own.headers['cache-control'], 'no-store');
  const mgr = await resolve('mgr', TOK.tower);
  ok('C5 a manager (claim-less, as live) resolves any building\'s code', mgr.status === 200 && mgr.body.clientId === 'cl_harbor', show(mgr));
  const crewIn = await resolve('crew', TOK.rest);
  ok('C6 🔴 a cleaner resolves a code at a location they clean', crewIn.status === 200 && crewIn.body.siteId === 's_club', show(crewIn));
  const crewSibling = await resolve('crew', TOK.deck);
  ok('C7 …and at another location of the same customer (every location of a customer they clean)', crewSibling.status === 200 && crewSibling.body.siteId === 's_pool', show(crewSibling));
  const crewOut = await resolve('crew', TOK.tower);
  ok('C8 🔴 a cleaner resolves a code at a building they do not clean too (QR Wave 2, QR-14: a filler is sent anywhere)', crewOut.status === 200 && crewOut.body.siteId === 's_tower', show(crewOut));
  ok('C9 …the same minimal allowlist, nothing more (no access notes, no token)', crewOut.status === 200
    && JSON.stringify(Object.keys(crewOut.body)) === JSON.stringify(codesLib.SCAN_RESOLVE_KEYS || ['?']) && !/4411|SECRET|WWWW/.test(JSON.stringify(crewOut.body)), show(crewOut));
  const nowhere = await resolve('crew3', TOK.rest);
  ok('C10 🔴 a cleaner on no clean at all resolves it as well (the fill-in decides what follows)', nowhere.status === 200 && nowhere.body.siteId === 's_club', show(nowhere));
  const other = await resolve('crew2', TOK.tower);
  ok('C11 a cleaner mid-clean at their building resolves its code', other.status === 200 && other.body.clientId === 'cl_harbor', show(other));

  // The same 404 as the public route, for every way a code can be dead — the answer never says
  // whether a token ever existed.
  const pub = { code: INACTIVE, error: scan.SCAN_INACTIVE_MESSAGE };
  for (const [label, t] of [['unknown', TOK.unknown], ['replaced', TOK.old], ['orphaned (its area removed)', TOK.orphan]]) {
    const r = await resolve('owner', t);
    ok(`C12 a ${label} code → the public route's SAME 404`, r.status === 404 && r.body.code === pub.code && r.body.error === pub.error, show(r));
  }
  const before = world.log.length;
  const bad = await resolve('owner', 'not-a-token');
  ok('C13 a malformed token → the same 404, and the codes table is never asked', bad.status === 404 && bad.body.code === INACTIVE
    && !world.log.slice(before).some((q) => q.table === 'area_scan_codes'), show(bad));
  const crewDead = await resolve('crew3', TOK.orphan);
  ok('C14 a dead code is 404 for a cleaner too (it is checked before scope, so it says nothing more)', crewDead.status === 404 && crewDead.body.code === INACTIVE, show(crewDead));

  const client = await resolve('client', TOK.rest);
  ok('C15 🔴 a CUSTOMER login is refused the staff resolve (its own is EP-387)', client.status === 403, show(client));
  const post = await call(officeHandler, { method: 'POST', path: 'resolve', token: 'tok-owner', query: { token: TOK.rest } });
  eq('C16 only GET', post.status, 404);

  // The office branches keep their own door: crew are still refused, the office still served.
  const ensureCrew = await call(officeHandler, { method: 'POST', path: 'ensure', token: 'tok-crew', body: { siteId: 's_club' } });
  ok('C17 the office\'s ensure still refuses a cleaner (the resolve opened nothing else)', ensureCrew.status === 403, show(ensureCrew));
  const getEnsure = await call(officeHandler, { method: 'GET', path: 'ensure', token: 'tok-owner' });
  eq('C18 GET on an office branch is still 404', getEnsure.status, 404);

  // Rate limit, per login.
  seed();
  const RATE = codesLib.SCAN_RESOLVE_RATE || { limit: 0 };
  ok('C19 the resolve has a declared allowance', RATE.limit > 0 && RATE.windowMs > 0, JSON.stringify(RATE));
  let last = null;
  for (let i = 0; i <= RATE.limit; i += 1) last = await resolve('owner', TOK.rest);
  ok('C20 past the allowance a login is told to wait (429 rate-limited)', last && last.status === 429 && last.body.code === 'rate-limited', last ? show(last) : 'no call');
  const someoneElse = await resolve('mgr', TOK.rest);
  ok('C21 …another login is not', someoneElse.status === 200, show(someoneElse));
});

// ── D. the customer hub's scan (EP-387) ──────────────────────────────────────
await section('D', async () => {
  seed();
  const hub = (token, t, headers = {}) => call(hubHandler, { path: 'scan', token, query: { token: t }, headers });
  const anon = await hub(undefined, TOK.rest);
  eq('D1 no login → 401', anon.status, 401);
  const mine = await hub('tok-client', TOK.rest);
  ok('D2 a customer resolves a code at one of their buildings → the building to open', mine.status === 200
    && mine.body.buildingId === 'cl_coral' && mine.body.building === 'Coral Bay HOA' && mine.body.area === 'Restrooms', show(mine));
  ok('D3 …the answer is the hub allowlist: the area to open, no location or customer-login ids', mine.status === 200
    && JSON.stringify(Object.keys(mine.body)) === JSON.stringify(codesLib.HUB_SCAN_KEYS || ['?']) && mine.body.areaId === 'area_rest'
    && !/s_club|4411|c0000000/.test(JSON.stringify(mine.body)), show(mine));
  eq('D4 …private, never cached', mine.headers['cache-control'], 'private, no-store');
  const notMine = await hub('tok-client', TOK.tower);
  ok('D5 🔴 a code at a building outside their scope → 403 not-your-building', notMine.status === 403 && notMine.body.code === 'not-your-building'
    && !/Harbor|cl_harbor/.test(JSON.stringify(notMine.body)), show(notMine));
  const theirs = await hub('tok-client2', TOK.tower);
  ok('D6 …while that building\'s own customer resolves it', theirs.status === 200 && theirs.body.buildingId === 'cl_harbor', show(theirs));
  for (const [label, t] of [['unknown', TOK.unknown], ['replaced', TOK.old], ['orphaned', TOK.orphan], ['malformed', 'nope']]) {
    const r = await hub('tok-client', t);
    ok(`D7 a ${label} code → 404 ${INACTIVE}`, r.status === 404 && r.body.code === INACTIVE, show(r));
  }
  const H = PREVIEW.HUB_PREVIEW_HEADER || 'x-hub-preview';
  const office = await hub('tok-owner', TOK.rest);
  ok('D8 a staff login without the preview header is refused (403 office-login)', office.status === 403 && office.body.code === 'office-login', show(office));
  const previewIn = await hub('tok-owner', TOK.rest, { [H]: 'cl_coral' });
  ok('D9 the office\'s preview of Coral Bay resolves Coral Bay\'s code', previewIn.status === 200 && previewIn.body.buildingId === 'cl_coral', show(previewIn));
  const previewOut = await hub('tok-owner', TOK.tower, { [H]: 'cl_coral' });
  ok('D10 🔴 …and nothing outside the one building it previews', previewOut.status === 403 && previewOut.body.code === 'not-your-building', show(previewOut));
  const crewPreview = await hub('tok-crew', TOK.rest, { [H]: 'cl_coral' });
  ok('D11 🔴 a cleaner sending the preview header is refused', crewPreview.status === 403, show(crewPreview));
  // the allowance
  seed();
  const RATE = codesLib.SCAN_RESOLVE_RATE || { limit: 0 };
  let last = null;
  for (let i = 0; i <= RATE.limit; i += 1) last = await hub('tok-client', TOK.rest);
  ok('D12 the hub scan is rate-limited per login (429 too-many-requests)', last && last.status === 429 && last.body.code === 'too-many-requests', last ? show(last) : 'no call');
});

// ── E. wiring ────────────────────────────────────────────────────────────────
await section('E', async () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
  const scanner = strip(read('src/components/QrScanner.jsx'));
  ok('E1 one scanner component exists', existsSync(path.join(APP, 'src/components/QrScanner.jsx')));
  ok('E2 🔴 qr-scanner is loaded LAZILY (a dynamic import), never statically', /import\(\s*'qr-scanner'\s*\)/.test(scanner) && !/^import .*'qr-scanner'/m.test(scanner));
  const { readdirSync, statSync } = await import('node:fs');
  const files = [];
  (function walk(d) { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.jsx?$/.test(p)) files.push(p); } })(path.join(APP, 'src'));
  const statics = files.filter((f) => /^import [^;]*from 'qr-scanner'/m.test(readFileSync(f, 'utf8')));
  ok('E3 …nowhere in the app is it imported statically (the main bundle must not grow)', statics.length === 0, statics.join(', '));
  ok('E4 the camera stops on unmount (stop + destroy in the cleanup)', /return \(\) => \{[\s\S]*?\.stop\(\)[\s\S]*?\.destroy\(\)/.test(scanner));
  ok('E5 …and when the page is hidden', /visibilitychange/.test(scanner) && /document\.visibilityState\s*===\s*'hidden'|document\.hidden/.test(scanner));
  ok('E6 the words come in as props (the cleaner app passes catalog lines, the hub English)', /\bwords\b/.test(scanner) && !/useT\(|from '\.\.\/i18n/.test(scanner));
  ok('E7 no camera and permission denied are states of their own, with what to do', /noCamera/.test(scanner) && /denied/.test(scanner) && /NotAllowedError/.test(scanner));
  const tokens = /var\(--/.test(read('src/index.css').split('.qr-scan-')[1] || '');
  ok('E8 the dark camera screen and its corners are drawn in tokens (.qr-scan-* in index.css)', /\.qr-scan-[a-z-]+\s*\{/.test(read('src/index.css')) && tokens);

  const app = read('src/App.jsx');
  ok('E9 /my-day/scan is a crew route (time.clock)', /<Route path="my-day\/scan" element=\{<RequirePerm perm="time\.clock"><CrewScan \/><\/RequirePerm>\} \/>/.test(app)
    && /const CrewScan = lazyRoute\(\(\) => import\('\.\/pages\/crew\/CrewScan'\)\)/.test(app));
  ok('E10 /hub/scan is in the hub\'s routes', /<Route path="\/hub\/scan" element=\{<HubScan \/>\} \/>/.test(app) && /const HubScan = lazyRoute\(\(\) => import\('\.\/pages\/hub\/HubScan'\)\)/.test(app));
  const crewScan = strip(read('src/pages/crew/CrewScan.jsx'));
  ok('E11 the cleaner\'s scan opens the checklist through crewPaths (never a hand-written /my-day path)', /crewPaths\.checklist\(/.test(crewScan) && !/['`"]\/my-day\//.test(crewScan));
  ok('E12 …parses with the shared rule and resolves through the adapter', /scanTokenFromText\(/.test(crewScan) && /resolveScanCode\(/.test(crewScan) && /crewCleanAtLocation\(/.test(crewScan));
  ok('E13 …and says "No signal" honestly offline', /useOnlineStatus\(\)/.test(crewScan) && /qrScan\.offline/.test(crewScan));
  const paths = await import('../src/lib/crewPaths.js');
  eq('E14 crewPaths.scan() is the cleaner\'s scan page', paths.crewPaths.scan(), '/my-day/scan');
  eq('E15 crewPaths.checklist names the scanned area when there is one', paths.crewPaths.checklist('j 1', 'area_rest'), '/my-day/checklist/j%201?area=area_rest');
  eq('E16 …and nothing more when there is none', paths.crewPaths.checklist('j1'), '/my-day/checklist/j1');
  const hubScan = strip(read('src/pages/hub/HubScan.jsx'));
  ok('E17 the hub\'s scan page is English through english() (LANG-8) and opens that AREA\'s page (QR-16), no longer the building\'s Checklists', /english\('hubScan\./.test(hubScan)
    && /areaPath\(r\.buildingId, r\.areaId\)/.test(hubScan) && !/'checklists'/.test(hubScan) && /<BackLink\b/.test(hubScan));
  const home = strip(read('src/pages/hub/HubHome.jsx'));
  ok('E18 the hub\'s Home has the dashed "Scan site QR code" button, carrying its referrer', /to=\{HUB_SCAN_PATH\}/.test(home) && /state=\{nav\}/.test(home) && /hub-scan-button/.test(home));
  // Spelled once since QR Wave 1 (2026-10-16): lib/scanLanding owns it (a printed code opened by a
  // signed-in customer is routed there too, UI_RULES §172) and the hub's nav re-exports it.
  ok('E19 the hub scan path is one constant', /export const HUB_SCAN_PATH = '\/hub\/scan'/.test(read('src/lib/scanLanding.js'))
    && /export \{ HUB_SCAN_PATH \} from '\.\.\/\.\.\/lib\/scanLanding\.js'/.test(read('src/pages/hub/hubNav.js')));
  const sw = await import('../vite-plugins/sw-precache.mjs');
  ok('E20 the service worker keeps the cleaner\'s scan page and supply page', (sw.OFFLINE_SCREENS || []).includes('src/pages/crew/CrewScan.jsx') && (sw.OFFLINE_SCREENS || []).includes('src/pages/crew/CrewSupplies.jsx'));
  ok('E21 🔴 …and the scanner\'s lazy chunks (the library and its worker)', (sw.OFFLINE_LAZY_MODULES || []).includes('node_modules/qr-scanner/qr-scanner.min.js')
    && (sw.OFFLINE_LAZY_MODULES || []).includes('node_modules/qr-scanner/qr-scanner-worker.min.js'));
  const pkg = JSON.parse(read('package.json') || '{}');
  eq('E22 qr-scanner is pinned exactly', pkg.dependencies?.['qr-scanner'], '1.4.2');
  // The English-only rule lives in src/i18n/terms.js since CS-851 (the server reads it too).
  ok('E23 the i18n English-only rule holds the hub\'s scan words', /'hubScan\.'/.test(read('src/i18n/terms.js')));
  const conv = read('scripts/test-i18n-coverage.mjs');
  ok('E24 the cleaner\'s screens and the scanner\'s hub page are on the catalog (CONVERTED)', ['src/pages/crew/CrewScan.jsx', 'src/pages/crew/CrewSupplies.jsx', 'src/pages/hub/HubScan.jsx'].every((f) => conv.includes(`'${f}'`)));
});

// ── F. QR-27: an ARCHIVED customer's codes stop working (QR Wave 2, 2026-10-17) ─────────────
// Matt: "Stop working: they say 'This code is no longer active'." ONE rule (lib/scanCodes
// scanLocationOf, through §163's isArchivedCustomer), asked by both signed-in resolvers BEFORE their
// scope checks, so an archived building's code answers exactly what an unknown one answers — to the
// office, to a cleaner who still has a clean there, and to the building's own customer.
await section('F', async () => {
  const { isArchivedCustomer, archiveCustomerPatch, restoreCustomerPatch } = await import('../src/lib/customerStatus.js');
  const where = fn(codesLib, 'scanLocationOf');
  const archived = CLIENTS.map((c) => (c.id === 'cl_coral' ? { ...c, ...archiveCustomerPatch(c, { at: iso(NOW), by: 'u_owner' }) } : c));
  ok('F0 the fixture really archives Coral Bay (by §163\'s own patch and helper)', isArchivedCustomer(archived[0]) && !isArchivedCustomer(archived[1]));
  eq('F1 🔴 a code at an ARCHIVED customer\'s location is nowhere (scanLocationOf)', where({ code: { siteId: 's_club', areaId: 'area_rest' }, sites: SITES, clients: archived }), null);
  eq('F1 …every location of that customer', where({ code: { siteId: 's_pool', areaId: 'area_deck' }, sites: SITES, clients: archived }), null);
  ok('F2 …while another customer\'s codes still resolve', where({ code: { siteId: 's_tower', areaId: 'area_hall' }, sites: SITES, clients: archived })?.clientId === 'cl_harbor');
  const restored = archived.map((c) => (c.id === 'cl_coral' ? { ...c, ...restoreCustomerPatch(c) } : c));
  ok('F3 Restore brings the codes back (nothing was revoked)', where({ code: { siteId: 's_club', areaId: 'area_rest' }, sites: SITES, clients: restored })?.siteId === 's_club');
  const inactive = CLIENTS.map((c) => (c.id === 'cl_coral' ? { ...c, statusOverride: 'inactive' } : c));
  ok('F4 an INACTIVE customer (not archived) keeps its codes: QR-27 is the archive', where({ code: { siteId: 's_club', areaId: 'area_rest' }, sites: SITES, clients: inactive })?.siteId === 's_club');

  const archive = () => {
    const c = world.tables.org_state[0].state.clients.find((x) => x.id === 'cl_coral');
    Object.assign(c, archiveCustomerPatch(c, { at: iso(NOW), by: 'u_owner' }));
  };
  const pub = { code: INACTIVE, error: scan.SCAN_INACTIVE_MESSAGE };
  seed();
  archive();
  for (const who of ['owner', 'mgr', 'crew', 'crew3']) {
    const r = await resolve(who, TOK.rest);
    ok(`F5 🔴 EP-386: ${who} scanning an archived customer's code → the public route's SAME 404 (before any scope check)`, r.status === 404
      && r.body?.code === pub.code && r.body?.error === pub.error, show(r));
  }
  const sibling = await resolve('crew', TOK.deck);
  ok('F5 …at every location of that customer', sibling.status === 404 && sibling.body?.code === INACTIVE, show(sibling));
  const other = await resolve('crew2', TOK.tower);
  ok('F6 another customer\'s code still resolves for its cleaner', other.status === 200 && other.body?.clientId === 'cl_harbor', show(other));

  const hub = (token, t, headers = {}) => call(hubHandler, { path: 'scan', token, query: { token: t }, headers });
  seed();
  archive();
  const own = await hub('tok-client', TOK.rest);
  ok('F7 🔴 EP-387: the archived building\'s own customer gets the SAME 404 "no longer active" — never 403 not-your-building', own.status === 404
    && own.body?.code === INACTIVE && own.body?.error === pub.error, show(own));
  const stranger = await hub('tok-client2', TOK.rest);
  ok('F7 …and so does another customer (the dead code is answered BEFORE the scope check)', stranger.status === 404 && stranger.body?.code === INACTIVE, show(stranger));
  const harbor = await hub('tok-client2', TOK.tower);
  ok('F8 another customer\'s live building still resolves on the hub', harbor.status === 200 && harbor.body?.buildingId === 'cl_harbor', show(harbor));
});

console.log(`\nqr scan resolve: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exitCode = 1;
}
