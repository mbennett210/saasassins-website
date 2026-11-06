// THE QR CODE LINKS (QR Wave 1, 2026-10-16; Daniel: "whatever software he's using to print he just
// needs the link for each unique scanpoint"): every live code's link as a spreadsheet, for the
// office's own label software — the all-buildings file on the Customers list (EP-412,
// POST /api/scan-codes/links) and a building's "Download links" on its QR panel, both written by
// ONE pure builder (src/lib/scanCodes scanLinkRows / scanLinksCsv), plus each row's Copy link.
//
// What it holds:
//   L. the builder: the columns, one row per live code in the office's area order, "Location"
//      only when it says something the customer's name does not, the address, "Made on" as the
//      org's day, RFC 4180 + a byte-order mark + CRLF, and CSV-injection safety (= + - @ TAB CR)
//   B. which buildings: an ARCHIVED customer's skipped, the ones with no areas counted, the order
//   R. the REAL handler over fake-supabase.mjs (no network, no credentials — BUILD_INTEGRITY §6b):
//      its door (no login 401; crew 403 even holding the key by a grant; a customer login 403; a
//      manager pared off the key 403), the answer, missing codes minted once with WHO from the
//      claim, an idempotent second call, a racing mint absorbed, the permanent address whatever
//      origin the office browses, the rate limit, no-store, the body never read, and 750
//      buildings × 5 areas past PostgREST's 1,000-row cap
//   W. the wiring: the demo stub answers the same shape from the same builder; the Customers
//      list's button and the panel's Copy link / Download links read the one rule and the one builder
//
// REGRESSION (THE LAW II.3): on the tree before this change (91805d09) neither the builder nor the
// branch exists, so every check below reports what it wanted.
//
//   node app/scripts/test-qr-links-export.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

const ORG = '00000000-0000-0000-0000-000000000412';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
delete process.env.APP_PUBLIC_URL;
delete process.env.APP_BASE_URL;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const { parseCsv } = await import('../src/lib/csv.js');
const { IDENTITY } = await import('../src/brand/identity.generated.js');
const scan = await import('../src/lib/areaScan.js');
const lib = await import('../src/lib/scanCodes.js');
const handler = (await import('../api/scan-codes/[...path].js').catch(() => ({}))).default || null;
const APP_ADDRESS = new URL(IDENTITY.appUrl).origin;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (name) => (typeof lib[name] === 'function' ? lib[name] : () => undefined);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
async function section(name, f) {
  try { await f(); } catch (e) { fails.push(`§${name} stopped: ${String((e && e.message) || e).split('\n')[0]}`); }
}

// The columns are the spec (the plan §3 and the brief: Customer, Customer #, Location, Address,
// Area, Link, Made on) — a requirement, so it is written here as the requirement it is.
const SPEC_COLUMNS = ['Customer', 'Customer #', 'Location', 'Address', 'Area', 'Link', 'Made on'];
const T = (c) => c.repeat(32);

// ── L. the builder ───────────────────────────────────────────────────────────
await section('L', async () => {
  ok('L1 the columns are the spec\'s, in its order', JSON.stringify(lib.SCAN_LINK_COLUMNS || []) === JSON.stringify(SPEC_COLUMNS), JSON.stringify(lib.SCAN_LINK_COLUMNS));
  const client = { id: 'cl_1', name: 'Coral Bay HOA', customerNumber: '0007' };
  const site = { id: 'st_1', name: 'Clubhouse', address: '100 Ocean Dr, Miami FL 33139' };
  const rows = fn('scanLinkRows')({
    client, site, timeZone: 'America/New_York',
    codes: [
      { label: 'Lobby', url: `https://x.example/scan/${T('A')}`, createdAt: '2026-10-16T03:30:00.000Z' },
      { label: '  ', url: `https://x.example/scan/${T('B')}`, createdAt: '2026-10-16T15:00:00.000Z' },
      { label: 'No link', url: null, createdAt: '2026-10-16T15:00:00.000Z' },
    ],
  }) || [];
  eq('L2 one row per code with a link (a code with no link is no row)', rows.length, 2);
  ok('L2 …in the order given (the office\'s area order)', rows[0]?.area === 'Lobby' && rows[1]?.area === 'Untitled area', JSON.stringify(rows));
  ok('L3 the customer, its number, the location (it says something the name does not), the address, the link', rows[0]?.customer === 'Coral Bay HOA'
    && rows[0]?.customerNumber === '0007' && rows[0]?.location === 'Clubhouse' && rows[0]?.address === site.address
    && rows[0]?.link === `https://x.example/scan/${T('A')}`, JSON.stringify(rows[0]));
  eq('L3 🔴 "Made on" is the code\'s day in the ORG\'s zone (03:30 UTC on the 16th is the 15th in New York)', rows[0]?.madeOn, '2026-10-15');
  const same = (fn('scanLinkRows')({ client: { name: 'Clubhouse' }, site: { name: 'Clubhouse' }, codes: [{ label: 'X', url: 'https://x.example/scan/a' }] }) || [])[0];
  eq('L3 a location named like its customer is left blank (the public page\'s rule)', same?.location, '');
  eq('L3 …and a code with no date has no "Made on"', same?.madeOn, '');
  const fields = (fn('scanLinkRows')({ client: { name: 'C', street: '1 Client St', city: 'Tampa', state: 'FL', zip: '33602' }, site: { name: 'S', street: '9 Site Rd', city: 'Miami', state: 'FL', zip: '33101' }, codes: [{ label: 'X', url: 'https://x.example/scan/a' }] }) || [])[0];
  eq('L3 the address is the location\'s own fields when it has no composed line', fields?.address, '9 Site Rd, Miami FL 33101');
  const clientOnly = (fn('scanLinkRows')({ client: { name: 'C', street: '1 Client St', city: 'Tampa', state: 'FL', zip: '33602' }, site: { name: 'S' }, codes: [{ label: 'X', url: 'https://x.example/scan/a' }] }) || [])[0];
  eq('L3 …else the customer\'s', clientOnly?.address, '1 Client St, Tampa FL 33602');
  const noClient = (fn('scanLinkRows')({ client: null, site: { name: 'Loose site' }, codes: [{ label: 'X', url: 'https://x.example/scan/a' }] }) || [])[0];
  ok('L3 a location with no customer names the location as the customer', noClient?.customer === 'Loose site' && noClient?.location === '', JSON.stringify(noClient));

  const csv = String(fn('scanLinksCsv')([
    ...rows,
    { customer: '=HYPERLINK("http://evil.example","x")', customerNumber: '', location: '+1+cmd', address: '-2', area: '@SUM(A1)', link: '\tTab', madeOn: '\rCR' },
    { customer: 'Smith, "Jo" & Co', customerNumber: '', location: '', address: 'Line one\nLine two', area: 'A', link: 'https://x.example/scan/b', madeOn: '2026-10-16' },
  ]) || '');
  ok('L4 a UTF-8 byte-order mark first (Excel reads it as UTF-8)', csv.charCodeAt(0) === 0xFEFF, JSON.stringify(csv.slice(0, 3)));
  ok('L4 CRLF line ends', csv.includes('\r\n') && !/[^\r]\n(?=")/.test(csv.split('"Line one')[0]), JSON.stringify(csv.slice(0, 80)));
  const parsed = parseCsv(csv);
  ok('L4 the header is the columns', JSON.stringify(parsed.headers) === JSON.stringify(SPEC_COLUMNS), JSON.stringify(parsed.headers));
  eq('L4 every row reads back (RFC 4180: a comma, a quote and a line break inside a cell)', parsed.rows.length, 4);
  ok('L4 …the quoted cell whole', parsed.rows[3]?.[0] === 'Smith, "Jo" & Co' && parsed.rows[3]?.[3] === 'Line one\nLine two', JSON.stringify(parsed.rows[3]));
  const injection = csv.split('\r\n').find((l) => l.includes('HYPERLINK')) || '';
  ok('L5 🔴 CSV injection: a cell starting = + - @ TAB or CR is written as text (a leading apostrophe)', injection.startsWith('"\'=HYPERLINK')
    && injection.includes('"\'+1+cmd"') && injection.includes('"\'-2"') && injection.includes('"\'@SUM(A1)"') && injection.includes('"\'\tTab"') && injection.includes('"\'\rCR"'), JSON.stringify(injection));
  eq('L6 the all-buildings file is named for the org\'s day', fn('scanLinksFilename')({ dateKey: '2026-10-16' }), 'qr-code-links-2026-10-16.csv');
  eq('L6 a building\'s file is named for it, in safe characters only', fn('scanLinksFilename')({ building: 'Coral Bay HOA / "Tower" #2' }), 'qr-code-links-coral-bay-hoa-tower-2.csv');
});

// ── B. which buildings ───────────────────────────────────────────────────────
await section('B', async () => {
  const pick = fn('scanLinkBuildings');
  const got = pick({
    clients: [
      { id: 'c_z', name: 'Zephyr Towers' }, { id: 'c_a', name: 'alder court' }, { id: 'c_arch', name: 'Archived Place', statusOverride: 'archived' },
      { id: 'c_none', name: 'No Areas Yet' }, { id: 'c_m', name: 'Maple' },
    ],
    sites: [
      { id: 's_z', clientId: 'c_z', name: 'Z', cleaningAreas: [{ id: 'a1', label: 'Lobby' }] },
      { id: 's_a', clientId: 'c_a', name: 'A', cleaningAreas: [{ id: 'a2', label: 'Gym' }] },
      { id: 's_arch', clientId: 'c_arch', name: 'Arch', cleaningAreas: [{ id: 'a3', label: 'Pool' }] },
      { id: 's_none', clientId: 'c_none', name: 'None', cleaningAreas: [] },
      { id: 's_m', clientId: 'c_m', name: 'M', cleaningAreas: [{ id: '', label: 'no id' }] },
      { id: 's_loose', clientId: null, name: 'Loose', cleaningAreas: [{ id: 'a4', label: 'Hall' }] },
    ],
  }) || {};
  ok('B1 🔴 an ARCHIVED customer\'s building is skipped (no label for a building you no longer clean)', (got.buildings || []).length > 0 && !(got.buildings || []).some((b) => b.site.id === 's_arch'), JSON.stringify(got));
  eq('B2 buildings with no cleaning areas (none, or none with an id) are counted, not listed', got.withoutAreas, 2);
  ok('B3 the rest, by customer name (case-insensitively), a location with no customer by its own name',
    (got.buildings || []).map((b) => b.site.id).join(',') === 's_a,s_loose,s_z', JSON.stringify((got.buildings || []).map((b) => b.site.id)));
});

// ── R. the route ─────────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
};
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: `${k}@example.test`, role: p.role, status: 'active', name: `Name ${k}` }));
const logins = {
  ...Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
    id: `auth-${k}`, email: `${k}@example.test`, app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
  }])),
  'tok-client': { id: 'auth-client', email: 'pat@coral.test', app_metadata: { role: 'client', client_user_id: 'c0000000-0000-4000-8000-000000000001', org_id: ORG } },
};
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const liveCode = (id, siteId, areaId, token, createdAt = iso(NOW - 5 * 86400000)) => ({
  id, organization_id: ORG, site_id: siteId, area_id: areaId, token, created_at: createdAt, created_by: 'u_owner', revoked_at: null, revoked_by: null,
});
const BOOK = {
  clients: [
    { id: 'cl_coral', name: 'Coral Bay HOA', customerNumber: '0001' },
    { id: 'cl_harbor', name: 'Harbor Point', customerNumber: '0002', street: '5 Bay St', city: 'Tampa', state: 'FL', zip: '33602' },
    { id: 'cl_gone', name: 'Gone Towers', customerNumber: '0003', statusOverride: 'archived' },
    { id: 'cl_new', name: 'Brand New Plaza', customerNumber: '0004' },
    { id: 'cl_evil', name: '=HYPERLINK("http://evil.example","Click")' },
  ],
  sites: [
    { id: 'st_coral', clientId: 'cl_coral', name: 'Clubhouse', address: '100 Ocean Dr, Miami FL 33139', accessNotes: 'door 4411 SECRET',
      cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }, { id: 'area_gym', label: 'Gym' }] },
    { id: 'st_harbor', clientId: 'cl_harbor', name: 'Harbor Point', cleaningAreas: [{ id: 'area_pool', label: 'Pool deck' }] },
    { id: 'st_gone', clientId: 'cl_gone', name: 'Gone', cleaningAreas: [{ id: 'area_x', label: 'Hall' }] },
    { id: 'st_new', clientId: 'cl_new', name: 'Brand New Plaza', cleaningAreas: [] },
    { id: 'st_evil', clientId: 'cl_evil', name: 'Evil', cleaningAreas: [{ id: 'area_e', label: '-1+1' }] },
  ],
};
function seed({ overrides = [], permissions = seedPermissions(), book = BOOK, codes = null } = {}) {
  __resetRateLimit();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 7,
        state: {
          company: { name: 'Clean Space', timezone: 'America/New_York' },
          users: roster, permissions, userPermissionOverrides: overrides,
          clients: structuredClone(book.clients), sites: structuredClone(book.sites), opsSettings: {},
        },
      }],
      area_scan_codes: codes || [
        liveCode('c_lobby', 'st_coral', 'area_lobby', T('L')),
        liveCode('c_rest', 'st_coral', 'area_rest', T('R')),
        liveCode('c_rest_old', 'st_coral', 'area_rest', T('O')),
        liveCode('c_gone', 'st_gone', 'area_x', T('G')),
        liveCode('c_removed', 'st_coral', 'area_removed', T('X')),
      ],
    },
    logins,
  });
  // the replaced lobby code: revoked, never listed
  const old = world.tables.area_scan_codes.find((c) => c.id === 'c_rest_old');
  if (old) { old.revoked_at = iso(NOW - 86400000); old.revoked_by = 'u_owner'; }
  // the live partial unique index: ONE live code per (org, location, area)
  world.uniqueKeys = { area_scan_codes: [(r) => (r.revoked_at ? null : `${r.organization_id}|${r.site_id}|${r.area_id}`)] };
}
async function call({ who, body = {}, method = 'POST', path: p = 'links', headers = {} }) {
  if (typeof handler !== 'function') return { status: null, body: null, headers: {} };
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = method;
  req.headers = { ...(who ? { authorization: `Bearer tok-${who}` } : {}), origin: 'https://office-host.example', ...headers };
  req.query = { subpath: p };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null, headers: {} }), 20000);
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
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const liveRows = () => (world.tables.area_scan_codes || []).filter((c) => !c.revoked_at);

await section('R', async () => {
  ok('R0 the route exists', typeof handler === 'function');
  seed();
  eq('R1 no login is 401', (await call({ who: null })).status, 401);
  eq('R1 a cleaner is refused (403)', (await call({ who: 'crew' })).status, 403);
  eq('R1 a customer login is refused (403)', (await call({ who: 'client' })).status, 403);
  seed({ overrides: [{ userId: 'u_crew', grants: ['sites.edit'], revokes: [] }] });
  const grant = await call({ who: 'crew' });
  ok('R1 🔴 a cleaner HOLDING sites.edit by a per-user grant is still refused (the office floor), and nothing is minted', grant.status === 403
    && liveRows().length === 4, `${show(grant)} · ${liveRows().length} live`);
  const perms = seedPermissions().map((p) => (p.id === 'sites.edit' ? { ...p, roles: p.roles.filter((r) => r !== 'manager') } : p));
  seed({ permissions: perms });
  eq('R1 a manager pared off sites.edit is refused', (await call({ who: 'mgr' })).status, 403);

  seed();
  const before = liveRows().length;
  const r = await call({ who: 'mgr', body: { createdBy: 'u_evil', siteIds: ['st_gone'] } });
  eq('R2 the office gets 200', r.status, 200);
  eq('R2 …never cached', r.headers['cache-control'], 'no-store');
  ok('R2 …the answer is the file and its counts', !!r.body && ['filename', 'csv', 'links', 'buildings', 'withoutAreas'].every((k) => k in r.body), show(r));
  const parsed = parseCsv(String(r.body?.csv || ''));
  ok('R2 the file\'s header is the columns', JSON.stringify(parsed.headers) === JSON.stringify(SPEC_COLUMNS), JSON.stringify(parsed.headers));
  const col = (name) => SPEC_COLUMNS.indexOf(name);
  const order = parsed.rows.map((row) => `${row[col('Customer')]}|${row[col('Area')]}`);
  ok('R3 one row per live code: by customer, then the office\'s area order', JSON.stringify(order) === JSON.stringify([
    '=HYPERLINK("http://evil.example","Click")|-1+1',
    'Coral Bay HOA|Lobby', 'Coral Bay HOA|Restrooms', 'Coral Bay HOA|Gym',
    'Harbor Point|Pool deck',
  ]), JSON.stringify(order));
  const evilLine = String(r.body?.csv || '').split('\r\n').find((l) => l.includes('HYPERLINK')) || '';
  ok('R3 🔴 on the wire, the formula-looking customer and area are text', evilLine.startsWith('"\'=HYPERLINK') && evilLine.includes('"\'-1+1"'), JSON.stringify(evilLine));
  ok('R3 🔴 an ARCHIVED customer\'s building is not in the file', parsed.rows.length > 0 && !parsed.rows.some((row) => row[col('Customer')] === 'Gone Towers'), JSON.stringify(parsed.rows));
  ok('R3 …and gets no new code', r.status === 200 && !liveRows().some((c) => c.site_id === 'st_gone' && c.id !== 'c_gone'));
  ok('R3 a replaced code and a removed area\'s code are not in it', parsed.rows.length > 0 && !String(r.body?.csv).includes(T('O')) && !String(r.body?.csv).includes(T('X')));
  const coral = parsed.rows.find((row) => row[col('Area')] === 'Lobby') || [];
  ok('R4 the existing code keeps its link (the permanent address + /scan/ + its token)', coral[col('Link')] === `${APP_ADDRESS}/scan/${T('L')}`, JSON.stringify(coral));
  ok('R4 the row carries the customer #, the location (it differs from the name) and the address', coral[col('Customer #')] === '0001'
    && coral[col('Location')] === 'Clubhouse' && coral[col('Address')] === '100 Ocean Dr, Miami FL 33139', JSON.stringify(coral));
  const harbor = parsed.rows.find((row) => row[col('Area')] === 'Pool deck') || [];
  ok('R4 a location named like its customer leaves Location blank; its address comes from the customer', harbor[col('Location')] === ''
    && harbor[col('Address')] === '5 Bay St, Tampa FL 33602', JSON.stringify(harbor));
  ok('R4 "Made on" is the code\'s day in the org\'s zone', coral[col('Made on')] === new Date(NOW - 5 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), JSON.stringify(coral));
  const minted = liveRows().length - before;
  eq('R5 🔴 the codes still missing were minted: the gym, the pool deck and the formula area', minted, 3);
  const fresh = liveRows().filter((c) => !['c_lobby', 'c_rest', 'c_gone', 'c_removed'].includes(c.id));
  ok('R5 …each stamped with WHO from the claim (never the body)', fresh.length === 3
    && fresh.every((c) => c.created_by === 'u_mgr' && c.organization_id === ORG && scan.isScanToken(c.token)), JSON.stringify(liveRows()));
  eq('R5 the counts: five links from three buildings', `${r.body?.links} ${r.body?.buildings}`, '5 3');
  eq('R5 …and one live building with no areas yet (Brand New Plaza), the archived one not counted', r.body?.withoutAreas, 1);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  eq('R5 the file is named for the org\'s day', r.body?.filename, `qr-code-links-${today}.csv`);
  ok('R5 nothing private rides along (no access notes, no ids)', r.status === 200 && !/4411|SECRET|st_coral|cl_coral|u_mgr|c_lobby/.test(JSON.stringify(r.body)), show(r));

  const inserts = world.log.filter((q) => q.table === 'area_scan_codes' && q.op === 'insert').length;
  const again = await call({ who: 'mgr' });
  ok('R6 🔴 asked again, it mints nothing (idempotent)', inserts > 0 && again.status === 200
    && world.log.filter((q) => q.table === 'area_scan_codes' && q.op === 'insert').length === inserts, `${inserts} inserts before · ${show(again)}`);
  ok('R6 …and answers the same file', typeof r.body?.csv === 'string' && r.body.csv.length > 0 && again.body?.csv === r.body.csv);

  seed();
  const alias = await call({ who: 'owner', headers: { origin: 'https://cleanspace-gilt.vercel.app', host: 'cleanspace-gilt.vercel.app', 'x-forwarded-host': 'cleanspace-gilt.vercel.app' } });
  const links = parseCsv(String(alias.body?.csv || '')).rows.map((row) => row[col('Link')]);
  ok('R7 🔴 every link is the permanent address, whatever origin the office is on', links.length === 5 && links.every((u) => u.startsWith(`${APP_ADDRESS}/scan/`)), JSON.stringify(links));
  process.env.APP_PUBLIC_URL = 'https://app-one.example';
  const env = await call({ who: 'owner' });
  delete process.env.APP_PUBLIC_URL;
  ok('R7 …APP_PUBLIC_URL when the deploy sets it', parseCsv(String(env.body?.csv || '')).rows.every((row) => row[col('Link')].startsWith('https://app-one.example/scan/')), show(env));

  seed();
  const RATE = lib.SCAN_LINKS_RATE || { limit: 0, windowMs: 0 };
  ok('R8 the export has a declared allowance per login', RATE.limit > 0 && RATE.limit <= 10 && RATE.windowMs >= 60000, JSON.stringify(RATE));
  let last = null;
  for (let i = 0; i < RATE.limit; i += 1) last = await call({ who: 'mgr' });
  eq('R8 the allowance itself is served', last?.status, 200);
  const over = await call({ who: 'mgr' });
  ok('R8 one past it is 429 rate-limited', over.status === 429 && over.body?.code === 'rate-limited', show(over));
  eq('R8 …another login is not', (await call({ who: 'owner' })).status, 200);

  // A racing mint: another office tab mints the gym's code between this read and this insert.
  seed();
  let raced = false;
  world.beforeQuery = async (q) => {
    if (raced || q.table !== 'area_scan_codes' || q.op !== 'insert') return;
    raced = true;
    world.tables.area_scan_codes.push(liveCode('c_tab2', 'st_coral', 'area_gym', T('Z'), iso(NOW)));
  };
  const race = await call({ who: 'mgr' });
  world.beforeQuery = null;
  eq('R9 a mint that loses a race (23505) still answers', race.status, 200);
  ok('R9 …ONE live code per area, the other tab\'s kept', liveRows().filter((c) => c.site_id === 'st_coral' && c.area_id === 'area_gym').length === 1
    && liveRows().some((c) => c.id === 'c_tab2'), JSON.stringify(liveRows().filter((c) => c.area_id === 'area_gym')));
  ok('R9 …and every area has its link', parseCsv(String(race.body?.csv || '')).rows.length === 5 && String(race.body?.csv).includes(T('Z')), show(race));

  seed();
  eq('R10 only POST', (await call({ who: 'mgr', method: 'GET' })).status, 404);
});

// ── R11. scale: 750 buildings × 5 areas, past PostgREST's 1,000-row cap ─────────
await section('R11', async () => {
  const clients = [];
  const sites = [];
  const codes = [];
  for (let b = 0; b < 750; b += 1) {
    const n = String(b + 1).padStart(4, '0');
    clients.push({ id: `cl_${n}`, name: `Building ${n}`, customerNumber: n });
    const areas = Array.from({ length: 5 }, (_, a) => ({ id: `ar_${n}_${a}`, label: `Area ${a + 1}` }));
    sites.push({ id: `st_${n}`, clientId: `cl_${n}`, name: `Building ${n}`, address: `${b + 1} Main St, Miami FL 33101`, cleaningAreas: areas });
    // three of every five already have codes, so the call mints 1,500 in batches
    for (let a = 0; a < 3; a += 1) codes.push(liveCode(`c_${n}_${a}`, `st_${n}`, `ar_${n}_${a}`, `${n}${'k'.repeat(23)}${a}${'q'.repeat(4)}`.slice(0, 32)));
  }
  seed({ book: { clients, sites }, codes });
  world.maxRows = 1000;
  const t0 = Date.now();
  const r = await call({ who: 'owner' });
  const ms = Date.now() - t0;
  eq('R11 3,750 links from 750 buildings', `${r.status} ${r.body?.links} ${r.body?.buildings}`, '200 3750 750');
  eq('R11 🔴 every live code read despite the 1,000-row cap (a complete, paged read)', parseCsv(String(r.body?.csv || '')).rows.length, 3750);
  eq('R11 the 1,500 missing codes minted, one per area', liveRows().length, 3750);
  const batches = world.log.filter((q) => q.table === 'area_scan_codes' && q.op === 'insert').length;
  ok('R11 …in batches, not one statement per code', batches >= 3 && batches <= 6, `${batches} inserts`);
  const bytes = Buffer.byteLength(JSON.stringify(r.body || {}));
  ok('R11 the answer is well under Vercel\'s 4.5 MB response cap', r.status === 200 && bytes > 0 && bytes < 1.5 * 1024 * 1024, `${bytes} bytes`);
  ok('R11 …and comes back well inside the route\'s 60 s', r.status === 200 && ms < 15000, `${ms} ms`);
});

// ── W. wiring ────────────────────────────────────────────────────────────────
await section('W', async () => {
  const api = strip(read('src/lib/scanCodesApi.js'));
  ok('W1 the browser asks EP-412 through the adapter', /export async function fetchScanLinks\(/.test(api) && /'\/scan-codes\/links'/.test(api));
  ok('W2 the demo answers the same shape from the same builder (behind the STATIC demo gate)', /function stubLinks\(/.test(api)
    && /scanLinkBuildings\(/.test(api) && /scanLinkRows\(/.test(api) && /scanLinksCsv\(/.test(api) && /if \(STUB\) return stubLinks\(/.test(api));
  ok('W3 one place saves a CSV in the browser', /export function saveScanLinksCsv\(/.test(api));
  const panel = strip(read('src/components/AreaScanCodes.jsx'));
  ok('W4 each code\'s row has Copy link, copying its link', /navigator\.clipboard\.writeText\(\w+\.url\)/.test(panel) && /onClick=\{\(\) => copyLink\(c\)\}/.test(panel) && /t\('qrLinks\.copy'\)/.test(panel) && /t\('qrLinks\.copied'\)/.test(panel));
  ok('W5 the panel downloads the building\'s links with the ONE builder', /scanLinkRows\(/.test(panel) && /scanLinksCsv\(/.test(panel)
    && /scanLinksFilename\(/.test(panel) && /saveScanLinksCsv\(/.test(panel) && /t\('qrLinks\.download'\)/.test(panel));
  // The download lives in ONE hook behind both buttons that offer it: the Customers list's and the QR
  // codes page's (UI_RULES §183, hooks/useScanLinksDownload).
  const list = strip(read('src/pages/Clients.jsx'));
  const qrPage = strip(read('src/pages/QrCodes.jsx'));
  const dl = strip(read('src/hooks/useScanLinksDownload.js'));
  ok('W6 the Customers list offers "QR code links" only to a viewer the route serves (sites.edit + the office floor)', /scanCodesAllowed\(/.test(dl)
    && /usePermission\(SCAN_CODES_PERMISSION\)/.test(dl) && lib.SCAN_CODES_PERMISSION === 'sites.edit' && /fetchScanLinks\(/.test(dl)
    && /useScanLinksDownload\(\)/.test(list) && /qrLinks\.show &&/.test(list) && /t\('qrLinks\.button'\)/.test(list));
  ok('W6b …and the QR codes page offers the same file through the same hook (one implementation)', /useScanLinksDownload\(\)/.test(qrPage)
    && /qrLinks\.show &&/.test(qrPage) && /onClick=\{qrLinks\.download\}/.test(qrPage) && !/fetchScanLinks\(/.test(list) && !/fetchScanLinks\(/.test(qrPage));
  ok('W7 …says "Preparing…" while it works and how many links from how many buildings when done', /t\('qrLinks\.preparing'\)/.test(list) && /t\('qrLinks\.done'/.test(dl) && /t\('qrLinks\.withoutAreas'/.test(dl));
  const en = read('src/i18n/catalog/en.js');
  ok('W8 the words are catalog lines (office and cleaner words, UI_RULES §140)', ['qrLinks.copy', 'qrLinks.copied', 'qrLinks.download', 'qrLinks.button', 'qrLinks.preparing', 'qrLinks.done', 'qrLinks.withoutAreas']
    .every((k) => en.includes(`'${k}':`)));
  const route = read('api/scan-codes/[...path].js');
  ok('W9 the route declares EP-412 in its header', /POST \/api\/scan-codes\/links/.test(route) && /EP-412/.test(route));
});

if (fails.length) { console.error('\nqr-links-export FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqr-links-export: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
