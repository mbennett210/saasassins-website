// The QR codes' two server surfaces, driven END TO END through the REAL handlers against
// fake-supabase.mjs (no network, no credentials, no live project — BUILD_INTEGRITY §6b):
//
//   /api/public/scan/area?token=   — the public scan page's read (no login, QR-3)
//   /api/scan-codes/{ensure,replace,sheet}   — the office's codes screen and print (QR-6)
//
// What it proves, in the order it matters:
//   A. 🔴 THE PUBLIC READ: the allowlist on the wire (no ids, names, notes or
//      internal_note), an unknown / replaced / malformed / orphaned code all answer the
//      SAME plain "no longer active", the rate limit answers 429, a failure is a sentence +
//      code with no provider text (CS-077), `Cache-Control: no-store`, and the read never
//      touches the shared record (one site read through `area_scan_site`, never org_state).
//   B. THE OFFICE: crew never (even holding the key), one code per area minted once,
//      Replace revokes the old code for good, the URL base is the app's PERMANENT address
//      (api/_lib/appUrl appPublicUrl: APP_PUBLIC_URL, else APP_BASE_URL, else the brand's
//      own) whatever address the office happens to be browsing, and the print sheet hands
//      Chromium one label per area whose QR is the matrix of that area's own URL.
//
// REGRESSION (THE LAW II.3): on the pre-change tree (ab55e180) neither handler exists, so
// every request below answers nothing and every check reports what it wanted.
//
//   node app/scripts/test-area-scan-route.mjs
import { Readable } from 'node:stream';
import { registerHooks } from 'node:module';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
delete process.env.APP_PUBLIC_URL;
delete process.env.APP_BASE_URL;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

// Chromium is not available offline (and must never be launched by the public route):
// `_lib/pdf/chromium.js` imports puppeteer-core lazily, so a stand-in is resolved in its
// place that records the HTML it is handed and the PDF options, and returns fixed bytes.
globalThis.__pdfCalls = [];
const FAKE_PUPPETEER = `export default { async launch() { return {
  async newPage() { return {
    async setContent(html) { globalThis.__pdfCalls.push({ html }); },
    async pdf(opts) { globalThis.__pdfCalls[globalThis.__pdfCalls.length - 1].opts = opts; return new TextEncoder().encode('%PDF-1.4 fake'); },
  }; },
  async close() {},
}; } };`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'puppeteer-core' || spec === '@sparticuz/chromium') {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_PUPPETEER)}`, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const scan = await import('../src/lib/areaScan.js').catch(() => ({}));
const codesLib = await import('../src/lib/scanCodes.js').catch(() => ({}));
// The app's permanent address with no APP_* env set: the brand pack's own (www.cleancorner.app
// for Clean Space) — the source of truth the codes must print, never a restated literal.
const { IDENTITY } = await import('../src/brand/identity.generated.js');
const APP_ADDRESS = new URL(IDENTITY.appUrl).origin;
const publicHandler = (await import('../api/public/scan/[...path].js').catch(() => ({}))).default || null;
const officeHandler = (await import('../api/scan-codes/[...path].js').catch(() => ({}))).default || null;
const qcHandler = (await import('../api/qc/[...path].js').catch(() => ({}))).default || null;
const { dayKey, startOfDayKey } = await import('../src/lib/dates.js');
const QRCode = (await import('qrcode')).default;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree and a
// swapped call "passes" on a truthy label.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

ok('both handlers exist', typeof publicHandler === 'function' && typeof officeHandler === 'function');

// ── the world ───────────────────────────────────────────────────────────────
const HOUR = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: `Name ${k}` }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [
  `tok-${k}`,
  { id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} },
]));

const SITE = 'st_clubhouse';
const AREAS = [
  { id: 'area_lobby', label: 'Lobby & entrance', instructions: 'Glass, mats, floor. SECRET instructions' },
  { id: 'area_rest', label: 'Restrooms', instructions: 'Sanitize, restock' },
  { id: 'area_floors', label: 'Hall & stair floors', instructions: 'Sweep, mop' },
];
const T = (c) => c.repeat(32);
const TOK = { lobby: T('L'), rest: T('R'), floors: T('F'), oldRest: T('O'), removed: T('X'), otherSite: T('Z') };

const item = (id, label) => ({ id, label, naAllowed: false, photoRequired: false });
const SCHEMA = {
  areas: [
    { id: 'fa_entry', label: 'Entrance', siteAreaId: 'area_lobby', items: [item('fi_glass', 'Entry glass cleaned'), item('fi_mats', 'Mats vacuumed')] },
    { id: 'fa_rest', label: 'Restrooms', siteAreaId: 'area_rest', items: [item('fi_toilet', 'Toilets sanitized')] },
    { id: 'fa_floors', label: 'Floors', siteAreaId: 'area_floors', items: [item('fi_mop', 'Floors mopped')] },
  ],
};
const SECRET_NOTE = 'cleaner note SECRET-7f3';
const SECRET_CAPTION = 'caption SECRET-91c';

// Which shape the area_scan_site twin answers (see seed): 'old' = the function production runs
// today (20261004110100); 'new' = after 20261017100000 is applied.
let rpcShape = 'old';
function seed({ overrides = [], permissions = seedPermissions(), sites = null, codes = null } = {}) {
  const state = {
    users: roster, permissions, userPermissionOverrides: overrides,
    company: { name: 'Clean Space', timezone: 'America/New_York' },
    clients: [{ id: 'cl_coral', name: 'Coral Bay HOA' }, { id: 'cl_other', name: 'Elsewhere' }],
    sites: sites || [
      { id: SITE, clientId: 'cl_coral', name: 'Clubhouse', accessNotes: 'door code 4411 SECRET', cleaningAreas: AREAS },
      { id: 'st_other', clientId: 'cl_other', name: 'Other', cleaningAreas: [{ id: 'area_x', label: 'X' }] },
    ],
    opsSettings: {},
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 9 }],
      area_scan_codes: codes || [
        { id: 'c1', organization_id: ORG, site_id: SITE, area_id: 'area_lobby', token: TOK.lobby, created_at: iso(NOW - 48 * HOUR), created_by: 'u_owner', revoked_at: null, revoked_by: null },
        { id: 'c2', organization_id: ORG, site_id: SITE, area_id: 'area_rest', token: TOK.rest, created_at: iso(NOW - 48 * HOUR), created_by: 'u_owner', revoked_at: null, revoked_by: null },
        { id: 'c3', organization_id: ORG, site_id: SITE, area_id: 'area_floors', token: TOK.floors, created_at: iso(NOW - 48 * HOUR), created_by: 'u_owner', revoked_at: null, revoked_by: null },
        { id: 'c4', organization_id: ORG, site_id: SITE, area_id: 'area_rest', token: TOK.oldRest, created_at: iso(NOW - 96 * HOUR), created_by: 'u_owner', revoked_at: iso(NOW - 48 * HOUR), revoked_by: 'u_owner' },
        { id: 'c5', organization_id: ORG, site_id: SITE, area_id: 'area_gone', token: TOK.removed, created_at: iso(NOW - 96 * HOUR), created_by: 'u_owner', revoked_at: null, revoked_by: null },
      ],
      checklist_results: [
        // Tonight: the lobby finished 2 hours ago; the restrooms NOT finished (no completion).
        {
          id: 'r_tonight', organization_id: ORG, site_id: SITE, client_id: 'cl_coral', job_id: null,
          client_submit_id: 'cs_tonight', completed_by_user_id: 'u_crew', completed_count: 2, total_count: 4,
          performed_at: iso(NOW - 2 * HOUR), area_completions: { fa_entry: iso(NOW - 2 * HOUR) },
          template_snapshot: { name: 'Full Clean SECRET-NAME', kind: 'checklist', schema: SCHEMA },
          items: [
            { key: 'fi_glass', checked: true, note: SECRET_NOTE },
            { key: 'fi_mats', checked: true },
            { key: 'fi_toilet', checked: false },
          ],
        },
        // Thirty hours ago: everything but the floors.
        {
          id: 'r_older', organization_id: ORG, site_id: SITE, client_id: 'cl_coral', job_id: null,
          client_submit_id: 'cs_older', completed_by_user_id: 'u_crew', completed_count: 3, total_count: 4,
          performed_at: iso(NOW - 30 * HOUR), area_completions: { fa_entry: iso(NOW - 30 * HOUR), fa_rest: iso(NOW - 30 * HOUR) },
          template_snapshot: { name: 'Full Clean SECRET-NAME', kind: 'checklist', schema: SCHEMA },
          items: [{ key: 'fi_glass', checked: true }, { key: 'fi_mats', checked: true }, { key: 'fi_toilet', checked: true }],
        },
      ],
      account_media: [{
        id: 'am_secret_id', organization_id: ORG, scope: 'checklist', ref_id: 'cs_tonight', area_id: 'fi_glass',
        site_id: SITE, client_id: 'cl_coral', kind: 'image', mime_type: 'image/jpeg', caption: SECRET_CAPTION,
        storage_path: `${ORG}/${SITE}/aaaaaaaaaaaaaaaa.jpg`, thumb_path: `${ORG}/${SITE}/aaaaaaaaaaaaaaaa.thumb.jpg`, created_at: iso(NOW - 2 * HOUR),
      }],
    },
    logins,
  });
  // Storage objects by "<bucket>/<path>" — what fake-supabase's download() serves.
  world.objects = {};
  // The JS twin of supabase/migrations/20261004110100_area_scan_site_read.sql: ONE site's
  // name, its customer's name, its areas' ids and labels, and the org's zone — nothing else.
  // With `rpcShape = 'new'` it is 20261017100000_area_scan_site_status_phone.sql's: the same plus
  // the customer's id and `statusOverride` (QR-27) and the company's phone (QR-31).
  world.rpc = (name, args) => {
    if (name !== 'area_scan_site') return { data: null, error: { code: 'PGRST202', message: `no function ${name}` } };
    const row = (world.tables.org_state || []).find((r) => r.organization_id === args.p_org);
    const site = (row?.state?.sites || []).find((s) => s && s.id === args.p_site_id);
    if (!site) return { data: null, error: null };
    const client = (row.state.clients || []).find((c) => c.id === site.clientId);
    return {
      data: {
        siteName: site.name ?? null,
        clientName: client?.name ?? null,
        areas: (Array.isArray(site.cleaningAreas) ? site.cleaningAreas : []).map((a) => ({ id: a?.id ?? null, label: a?.label ?? null })),
        timeZone: row.state.company?.timezone ?? null,
        ...(rpcShape === 'new' ? {
          clientId: client?.id ?? null,
          clientStatusOverride: client?.statusOverride ?? null,
          companyPhone: row.state.company?.phone ?? null,
        } : {}),
      },
      error: null,
    };
  };
  __resetRateLimit();
  globalThis.__pdfCalls = [];
  return state;
}

async function call(handler, { method = 'GET', path, token, body, query = {}, headers = {} }) {
  if (typeof handler !== 'function') return { status: null, body: null, headers: {} };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  req.query = { ...query, subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 10000);
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
  } finally { Object.assign(console, quiet); }
}
const scanGet = (token, { ip = '203.0.113.7', method = 'GET' } = {}) => call(publicHandler, {
  method, path: 'area', query: token === undefined ? {} : { token }, headers: { 'x-vercel-forwarded-for': ip },
});
const office = (path, who, body, headers = {}) => call(officeHandler, {
  method: 'POST', path, token: who ? `tok-${who}` : null, body,
  headers: { origin: 'https://office-host.example', ...headers },
});

const INACTIVE = scan.SCAN_INACTIVE_CODE;
const KEYS = scan.PUBLIC_SCAN_KEYS || [];
const statusCopy = typeof scan.scanStatusCopy === 'function' ? scan.scanStatusCopy : () => ({});
const NEVER_BADGE = 'Cleaning records start soon';

// ── A. the public read ──────────────────────────────────────────────────────
{
  seed();
  const r = await scanGet(TOK.lobby);
  eq('A1 a live code answers 200', r.status, 200);
  ok('A1 …with EXACTLY the allowlisted keys', !!r.body && sameSet(Object.keys(r.body), KEYS), show(r));
  eq('A1 …the building', r.body?.building, 'Coral Bay HOA');
  eq('A1 …the area', r.body?.area, 'Lobby & entrance');
  eq('A1 …last cleaned two hours ago: "Cleaned"', statusCopy(r.body?.lastCleanedAt)?.badge, 'Cleaned');
  eq('A1 …at the time the clean recorded', r.body?.lastCleanedAt, iso(NOW - 2 * HOUR));
  ok('A1 …listing what was done', (r.body?.items || []).map((i) => i.label).join('|') === 'Entry glass cleaned|Mats vacuumed', show(r));
  eq('A1 …saying there IS a newest checklist photo, and when (HUB-15)', r.body?.photo?.takenAt, iso(NOW - 2 * HOUR));
  eq('A1 …in the org\'s zone', r.body?.timeZone, 'America/New_York');
  const wire = JSON.stringify(r.body || {});
  for (const secret of ['u_crew', 'Name crew', 'r_tonight', 'cs_tonight', 'SECRET-NAME', SECRET_NOTE, SECRET_CAPTION, 'am_secret_id',
    'cl_coral', SITE, 'area_lobby', 'fi_glass', 'door code', 'SECRET instructions', TOK.lobby, ORG]) {
    ok(`A2 no "${secret}" on the wire`, !wire.includes(secret));
  }
  ok('A2 no URL at all: the photo\'s storage path never reaches the page', !/https?:\/\//.test(wire), wire);
  eq('A3 the answer is never cached', r.headers['cache-control'], 'no-store');
  ok('A4 the public read never touches the shared record', !world.log.some((q) => q.table === 'org_state'), JSON.stringify(world.log.map((q) => q.table)));
  eq('A4 …it reads ONE site through area_scan_site', world.log.filter((q) => q.table === 'rpc:area_scan_site').length, 1);
  eq('A5 …one checklist read', world.log.filter((q) => q.table === 'checklist_results').length, 1);
  ok('A5 …at most one media read', world.log.filter((q) => q.table === 'account_media').length <= 1);
  eq('A5 …and mints no signed URL (nothing it would hand out)', world.storage.filter((s) => s.op === 'download-url').length, 0);
}
// ── P. the photo, through the public route's own /photo ─────────────────────
const photoGet = (token, { ip = '203.0.113.50' } = {}) => call(publicHandler, {
  method: 'GET', path: 'photo', query: token === undefined ? {} : { token }, headers: { 'x-vercel-forwarded-for': ip },
});
const THUMB_BYTES = Buffer.from('thumb-jpeg-bytes');
const FULL_BYTES = Buffer.from('full-size-jpeg-bytes');
{
  seed();
  world.objects[`ops-media/${ORG}/${SITE}/aaaaaaaaaaaaaaaa.thumb.jpg`] = THUMB_BYTES;
  world.objects[`ops-media/${ORG}/${SITE}/aaaaaaaaaaaaaaaa.jpg`] = FULL_BYTES;
  const r = await photoGet(TOK.lobby);
  eq('P1 the lobby\'s newest photo answers 200', r.status, 200);
  eq('P1 …as an image', r.headers['content-type'], 'image/jpeg');
  ok('P1 …the THUMBNAIL bytes (a phone-sized picture, never a 10 MB original)', Buffer.isBuffer(r.body) && r.body.equals(THUMB_BYTES), String(r.body));
  ok('P1 …cached only briefly and only by the viewer', /^private, max-age=\d+$/.test(String(r.headers['cache-control'] || '')), r.headers['cache-control']);
  ok('P1 …and still no org_state read', !world.log.some((q) => q.table === 'org_state'));
  const f = await photoGet(TOK.floors);
  eq('P2 an area with no photo answers 404', f.status, 404);
  eq('P2 …saying so', f.body?.code, scan.SCAN_PHOTO_NONE_CODE);
  const old = await photoGet(TOK.oldRest);
  eq('P3 a replaced code gets no photo either', `${old.status} ${old.body?.code}`, `404 ${INACTIVE}`);
  eq('P3 …nor a malformed one', (await photoGet('../../etc')).body?.code, INACTIVE);
}
{
  seed();
  world.tables.account_media[0].thumb_path = null;
  world.tables.account_media[0].size_bytes = 9 * 1024 * 1024;
  const r = await photoGet(TOK.lobby);
  eq('P4 a thumbless 9 MB original is not streamed through the function', r.status, 404);
  world.tables.account_media[0].thumb_path = `${ORG}/${SITE}/../../_signatures/x.jpg`;
  const t = await photoGet(TOK.lobby);
  eq('P5 a tampered storage path is never downloaded', t.status, 404);
  ok('P5 …no download was attempted', !world.storage.some((s) => s.op === 'download'), JSON.stringify(world.storage));
}
{
  seed();
  world.objects[`ops-media/${ORG}/${SITE}/aaaaaaaaaaaaaaaa.thumb.jpg`] = THUMB_BYTES;
  const limit = scan.SCAN_RATE?.perIp?.limit || 0;
  for (let i = 0; i < limit; i += 1) await scanGet(T('Q'), { ip: '198.51.100.77' });
  eq('P6 the photo shares the page\'s per-IP allowance', (await photoGet(TOK.lobby, { ip: '198.51.100.77' })).status, 429);
}
{
  seed();
  const r = await scanGet(TOK.rest);
  ok('A6 🔴 the restrooms (last finished 30 hours ago) read the same calm "Cleaned" — no warning (QR-28)', statusCopy(r.body?.lastCleanedAt)?.badge === 'Cleaned'
    && !('freshness' in (r.body || {})) && !('staleAfterHours' in (r.body || {})), show(r));
  eq('A6 …with the older clean\'s time — tonight\'s unfinished restroom never counts', r.body?.lastCleanedAt, iso(NOW - 30 * HOUR));
  const f = await scanGet(TOK.floors);
  eq('A7 the floors (never finished) read the never state', statusCopy(f.body?.lastCleanedAt)?.badge, NEVER_BADGE);
  eq('A7 …with no time', f.body?.lastCleanedAt, null);
}
for (const [what, token] of [
  ['an unknown well-formed code', T('Q')],
  ['a REPLACED code', TOK.oldRest],
  ['a code whose area was removed', TOK.removed],
  ['a malformed code', 'not-a-token'],
]) {
  seed();
  const r = await scanGet(token);
  eq(`A8 ${what} answers 404`, r.status, 404);
  eq(`A8 ${what} says the plain code`, r.body?.code, INACTIVE);
  eq(`A8 ${what} says the plain sentence`, r.body?.error, scan.SCAN_INACTIVE_MESSAGE);
  eq(`A8 ${what} is not cached either`, r.headers['cache-control'], 'no-store');
  if (what === 'a malformed code') ok('A8 a malformed code costs no database read at all', world.log.length === 0, JSON.stringify(world.log));
}
{
  seed({ sites: [{ id: 'st_other', clientId: 'cl_other', name: 'Other', cleaningAreas: [{ id: 'area_x', label: 'X' }] }] });
  const r = await scanGet(TOK.lobby);
  eq('A9 a code whose LOCATION is gone answers the same 404', `${r.status} ${r.body?.code}`, `404 ${INACTIVE}`);
}
{
  seed();
  eq('A10 only GET', (await scanGet(TOK.lobby, { method: 'POST' })).status, 405);
  eq('A10 no token is the same inactive answer', (await scanGet(undefined)).body?.code, INACTIVE);
}
{
  seed();
  const limit = scan.SCAN_RATE?.perIp?.limit;
  ok('A11 the per-IP limit is a named constant', Number.isFinite(limit) && limit > 0);
  let last = null;
  for (let i = 0; i < (limit || 0); i += 1) last = await scanGet(T('Q'), { ip: '198.51.100.9' });
  ok('A11 the limit itself is allowed', last && last.status === 404, last ? show(last) : 'no calls');
  const over = await scanGet(TOK.lobby, { ip: '198.51.100.9' });
  eq('A11 one request past the per-IP limit answers 429', over.status, 429);
  eq('A11 …with a stable code', over.body?.code, scan.SCAN_RATE_LIMITED_CODE);
  ok('A11 …and a sentence', typeof over.body?.error === 'string' && over.body.error.length > 0);
  ok('A11 …and Retry-After', Number(over.headers['retry-after']) >= 0 && over.headers['retry-after'] !== undefined);
  eq('A11 another visitor is unaffected', (await scanGet(TOK.lobby, { ip: '198.51.100.10' })).status, 200);
}
{
  seed();
  const limit = scan.SCAN_RATE?.perToken?.limit;
  ok('A12 the per-code limit is a named constant', Number.isFinite(limit) && limit > 0);
  for (let i = 0; i < (limit || 0); i += 1) await scanGet(TOK.lobby, { ip: `192.0.2.${i % 250}.${Math.floor(i / 250)}` });
  const over = await scanGet(TOK.lobby, { ip: '192.0.2.251' });
  eq('A12 one request past the per-code limit, from a fresh IP, answers 429', over.status, 429);
  eq('A12 …while another code still answers', (await scanGet(TOK.rest, { ip: '192.0.2.252' })).status, 200);
}
{
  seed();
  world.failWhen = (q) => q.table === 'checklist_results';
  world.failMessage = 'permission denied for relation checklist_results PROVIDER-SECRET';
  const r = await scanGet(TOK.lobby);
  eq('A13 a failed read answers 503', r.status, 503);
  eq('A13 …with a stable code', r.body?.code, scan.SCAN_UNAVAILABLE_CODE);
  ok('A13 …and a sentence, never the provider\'s words (CS-077)', typeof r.body?.error === 'string' && !JSON.stringify(r.body).includes('PROVIDER-SECRET') && !/relation|permission denied/i.test(JSON.stringify(r.body)), show(r));
  eq('A13 …not cached', r.headers['cache-control'], 'no-store');
}

// ── Q. QR-27: an ARCHIVED customer's codes stop working (QR Wave 2, 2026-10-17) ─────────────
// Through the real public handler, with the area_scan_site twin answering both shapes: the function
// production runs today, and the one migration 20261017100000 writes (not applied).
{
  const { archiveCustomerPatch, restoreCustomerPatch } = await import('../src/lib/customerStatus.js');
  const archiveCoral = () => {
    const c = world.tables.org_state[0].state.clients.find((x) => x.id === 'cl_coral');
    Object.assign(c, archiveCustomerPatch(c, { at: iso(NOW), by: 'u_owner' }));
    return c;
  };
  rpcShape = 'new';
  seed();
  const live = await scanGet(TOK.lobby);
  eq('Q1 the new shape: a live customer\'s code answers 200 as before', live.status, 200);
  eq('Q1 …the building still the customer\'s name', live.body?.building, 'Coral Bay HOA');
  const c = archiveCoral();
  const from = world.log.length;
  for (const t of [TOK.lobby, TOK.rest, TOK.floors]) {
    const r = await scanGet(t, { ip: '203.0.113.71' });
    ok(`Q2 🔴 an ARCHIVED customer's code answers the SAME 404 as a dead one (${t.slice(0, 4)}…)`, r.status === 404
      && r.body?.code === INACTIVE && r.body?.error === scan.SCAN_INACTIVE_MESSAGE && r.headers['cache-control'] === 'no-store', show(r));
  }
  const ph = await photoGet(TOK.lobby, { ip: '203.0.113.72' });
  eq('Q3 …and its photo is not served either', `${ph.status} ${ph.body?.code}`, `404 ${INACTIVE}`);
  ok('Q3 …no checklist was read for it (refused before the area status)', !world.log.slice(from).some((q) => q.table === 'checklist_results'), JSON.stringify(world.log.slice(from).map((q) => q.table)));
  Object.assign(c, restoreCustomerPatch(c));
  eq('Q4 Restore: the same label answers again (nothing was revoked)', (await scanGet(TOK.lobby, { ip: '203.0.113.73' })).status, 200);
  c.statusOverride = 'inactive';
  eq('Q5 an INACTIVE (not archived) customer keeps its codes: QR-27 is the archive', (await scanGet(TOK.lobby, { ip: '203.0.113.74' })).status, 200);

  rpcShape = 'old';
  seed();
  archiveCoral();
  const before = await scanGet(TOK.lobby, { ip: '203.0.113.75' });
  ok('Q6 🔴 the OLD shape (20261017100000 not applied): no status key → active, the code answers exactly as today', before.status === 200
    && before.body?.building === 'Coral Bay HOA' && before.body?.area === 'Lobby & entrance' && before.body?.lastCleanedAt === iso(NOW - 2 * HOUR), show(before));
}

// ── N. the next clean, the last inspection and the urgent line, on the wire (QR Wave 2) ─────────
// QR-28 (the next scheduled clean, a DATE only), QR-15's note (the last inspection, a date) and
// QR-31 (the company's phone), through the real public handler, with 20261017100000's shape.
const TZ = 'America/New_York';
const TODAY = dayKey(new Date(NOW), TZ);
const dayStart = (key) => startOfDayKey(key, TZ).getTime();
const jobRow = (id, startMs, status = 'upcoming', siteId = SITE) => ({
  id, organization_id: ORG, client_id: 'cl_coral', site_id: siteId, status, start_at: iso(startMs),
  data: { id, clientId: 'cl_coral', siteId, startAt: iso(startMs), endAt: iso(startMs + 2 * HOUR), status, crewIds: ['u_crew'], notes: 'gate 9911 SECRET-JOB' },
});
const inspRow = (id, performedMs, status = 'submitted', siteId = SITE) => ({
  id, organization_id: ORG, client_id: 'cl_coral', site_id: siteId, status, performed_at: iso(performedMs),
  overall_score: 63.25, result: 'fail', inspector_user_id: 'u_mgr', inspector_name: 'Inspector SECRET', public_token: 'tok_SECRET_INSPECTION',
});
const PHONE = '(555) 010-4477';
function seedExtras({ jobs = [], inspections = [], phone = PHONE } = {}) {
  rpcShape = 'new';
  seed();
  world.tables.org_state[0].state.company.phone = phone;
  world.tables.jobs = jobs;
  world.tables.inspection_records = inspections;
}
{
  // Today's clean early this morning (org zone) has not been marked done; tomorrow's is upcoming; a
  // done clean and a cancelled one sit in between; another location's clean is sooner.
  const tomorrowKey = dayKey(new Date(dayStart(TODAY) + 30 * HOUR), TZ);
  seedExtras({
    jobs: [
      jobRow('j_today', dayStart(TODAY) + 60 * 1000),
      jobRow('j_tomorrow', dayStart(tomorrowKey) + 21.5 * HOUR),
      jobRow('j_cancel', dayStart(TODAY) + 2 * HOUR, 'cancelled'),
      jobRow('j_other_site', dayStart(TODAY) + 30 * 1000, 'upcoming', 'st_other'),
    ],
    inspections: [inspRow('i_old', NOW - 9 * 24 * HOUR), inspRow('i_new', NOW - 3 * 24 * HOUR, 'shared'), inspRow('i_draft', NOW - HOUR, 'draft'), inspRow('i_elsewhere', NOW - 2 * HOUR, 'submitted', 'st_other')],
  });
  const r = await scanGet(TOK.lobby);
  const lobbyLog = world.log.slice();   // the reads ONE page view makes (N6, N7)
  eq('N1 the answer still answers 200 with EXACTLY the allowlisted keys', r.status === 200 && sameSet(Object.keys(r.body || {}), KEYS), true);
  // The hall floors were never cleaned, so no visit is "the one that already did them" (N13).
  eq('N2 🔴 the next clean is TODAY\'s (org zone), not yet done — a date only', (await scanGet(TOK.floors, { ip: '203.0.113.80' })).body?.nextCleanOn, TODAY);
  eq('N3 🔴 the last inspection is the newest SUBMITTED one at this location, as its org-zone day (a newer draft and another location\'s ignored)', r.body?.lastInspectionOn, dayKey(new Date(NOW - 3 * 24 * HOUR), TZ));
  eq('N4 🔴 the urgent line\'s number is the company\'s phone (Settings → Company)', r.body?.urgentPhone, PHONE);
  const wire = JSON.stringify(r.body || {});
  // The score is 63.25 so it can never collide with the answer's own ISO times (seconds stop at 59);
  // a bare "63" matched a checkedAt millisecond on CI (2026-10-17).
  for (const secret of ['SECRET-JOB', 'gate 9911', 'j_today', 'u_crew', 'Inspector SECRET', 'tok_SECRET_INSPECTION', 'i_new', '"fail"', '63.25', 'overall_score']) {
    ok(`N5 no "${secret}" on the wire (no job, crew, time or inspection detail)`, !wire.includes(secret));
  }
  ok('N5 …and no clean\'s TIME at all: the two dates are bare day keys', /^\d{4}-\d{2}-\d{2}$/.test(r.body?.nextCleanOn || '') && /^\d{4}-\d{2}-\d{2}$/.test(r.body?.lastInspectionOn || ''));
  const jobsRead = lobbyLog.filter((q) => q.table === 'jobs');
  const opsOf = (q) => (q?.ops || []).map((o) => `${o.op}:${o.col}`);
  ok('N6 the next clean is ONE bounded read of this location\'s cleans: its site, not cancelled, between two start times', jobsRead.length === 1
    && jobsRead[0].eq?.site_id === SITE && ['neq:status', 'gte:start_at', 'lte:start_at'].every((o) => opsOf(jobsRead[0]).includes(o)), JSON.stringify(jobsRead));
  const inspRead = lobbyLog.filter((q) => q.table === 'inspection_records');
  ok('N7 the last inspection is ONE read: this location, submitted/shared only, newest first, one row', inspRead.length === 1
    && inspRead[0].eq?.site_id === SITE && JSON.stringify(inspRead[0].in?.status || []) === JSON.stringify(scan.SCAN_INSPECTION_STATUSES || ['?'])
    && JSON.stringify(inspRead[0].orders?.[0]) === JSON.stringify({ c: 'performed_at', asc: false }) && inspRead[0].limit === 1, JSON.stringify(inspRead));
  ok('N7 …and still no read of the shared record', !world.log.some((q) => q.table === 'org_state'));
}
{
  // Today's clean is DONE: the next one is tomorrow's.
  const tomorrowKey = dayKey(new Date(dayStart(TODAY) + 30 * HOUR), TZ);
  seedExtras({ jobs: [jobRow('j_done', dayStart(TODAY) + 60 * 1000, 'done'), jobRow('j_tom', dayStart(tomorrowKey) + 21.5 * HOUR)] });
  eq('N8 🔴 once today\'s clean is done, the next clean is tomorrow\'s', (await scanGet(TOK.lobby)).body?.nextCleanOn, tomorrowKey);
  seedExtras({ jobs: [jobRow('j_far', NOW + ((scan.SCAN_NEXT_CLEAN_DAYS || 45) + 2) * 24 * HOUR)], inspections: [], phone: '' });
  const far = await scanGet(TOK.lobby);
  ok('N9 nothing within the window, no inspection, no phone: no line for any of the three', far.status === 200 && far.body?.nextCleanOn === null
    && far.body?.lastInspectionOn === null && far.body?.urgentPhone === null, show(far));
}
{
  // The extras are display extras: a failed read leaves its line out, never the page.
  seedExtras({ jobs: [jobRow('j_t', NOW + HOUR)], inspections: [inspRow('i1', NOW - 24 * HOUR)] });
  world.failWhen = (q) => q.table === 'jobs';
  world.failMessage = 'relation jobs PROVIDER-SECRET';
  const r = await scanGet(TOK.lobby);
  ok('N10 a failed jobs read still answers the page (200), with no next-clean line and no provider words', r.status === 200 && r.body?.nextCleanOn === null
    && r.body?.lastInspectionOn !== null && !JSON.stringify(r.body).includes('PROVIDER-SECRET'), show(r));
  world.failWhen = (q) => q.table === 'inspection_records';
  const i = await scanGet(TOK.lobby, { ip: '203.0.113.90' });
  ok('N10 …and a failed inspection read, with no inspection line', i.status === 200 && i.body?.lastInspectionOn === null && i.body?.nextCleanOn !== null, show(i));
  world.failWhen = null;
  const before = world.log.length;
  world.objects[`ops-media/${ORG}/${SITE}/aaaaaaaaaaaaaaaa.thumb.jpg`] = Buffer.from('thumb');
  await photoGet(TOK.lobby, { ip: '203.0.113.91' });
  ok('N11 the photo route reads neither the cleans nor the inspections', !world.log.slice(before).some((q) => q.table === 'jobs' || q.table === 'inspection_records'), JSON.stringify(world.log.slice(before).map((q) => q.table)));
}
{
  // The orchestrator's ruling (2026-10-17): a clean that STARTED at or before the area's last
  // recorded clean is the visit that already did it — skipped, the one after it shown. Placed from
  // the start of today in the org's zone, so the run is the same at any hour: tonight's visit started
  // a minute into the day and finished the lobby a minute later.
  const t0 = dayStart(TODAY);
  const tomorrowKey = dayKey(new Date(t0 + 30 * HOUR), TZ);
  seedExtras({ jobs: [jobRow('j_did', t0 + 60 * 1000, 'in_progress'), jobRow('j_tom', dayStart(tomorrowKey) + 21.5 * HOUR)] });
  const tonight = world.tables.checklist_results.find((x) => x.id === 'r_tonight');
  tonight.performed_at = iso(t0 + 3 * 60 * 1000);
  tonight.area_completions = { fa_entry: iso(t0 + 2 * 60 * 1000) };
  const lobby = await scanGet(TOK.lobby, { ip: '203.0.113.81' });
  eq('N13 🔴 the lobby, cleaned by tonight\'s visit, shows the NEXT visit (tomorrow), never "Today" again', lobby.body?.nextCleanOn, tomorrowKey);
  eq('N13 …its last clean is that visit\'s', lobby.body?.lastCleanedAt, iso(t0 + 2 * 60 * 1000));
  const floors = await scanGet(TOK.floors, { ip: '203.0.113.82' });
  eq('N13 …while the floors, which that visit has not done, still read "Today"', floors.body?.nextCleanOn, TODAY);
}
{
  // The OLD shape (20261017100000 not applied): no phone key → no urgent line; the rest as above.
  rpcShape = 'old';
  seed();
  world.tables.org_state[0].state.company.phone = PHONE;
  const r = await scanGet(TOK.lobby);
  ok('N12 🔴 before the migration is applied: no urgent line (the phone is not read off the whole record)', r.status === 200 && r.body?.urgentPhone === null, show(r));
}

// ── K. Matt's note on QR-28: a checklist done with NO scan still updates the code ─────────────
// "Even if the cleaner comes into the restroom and uses the checklist and does not scan the QR
// code, the QR code still needs to update to show the cleaning was done based on the checklist
// completed." The cleaner opens their checklist from Today's Stops (no scan anywhere), fills it
// during the clean, and saves it through the REAL /api/qc submit; the public page then reads that
// clean — the area is stamped from the checklist itself (QR-1), never from a scan.
{
  rpcShape = 'new';
  seed();
  const st = world.tables.org_state[0].state;
  st.clients.find((c) => c.id === 'cl_coral').crewChecklists = { u_crew: 'it_full' };
  st.opsSettings = { autoCloseGraceMins: 120 };
  world.tables.checklist_results = [];
  world.tables.account_media = [];
  world.tables.inspection_templates = [{ id: 'it_full', organization_id: ORG, name: 'Full clean', kind: 'checklist', is_published: true, published_version_id: 'v_full', client_id: 'cl_coral' }];
  world.tables.inspection_template_versions = [{ id: 'v_full', template_id: 'it_full', version_number: 1, status: 'published', schema: SCHEMA }];
  world.tables.crew_assignments = [
    { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
    { organization_id: ORG, user_id: 'u_crew', site_id: null, client_id: 'cl_coral', source: 'standing_client' },
  ];
  world.tables.jobs = [jobRow('j_now', NOW - HOUR, 'in_progress')];
  world.tables.time_entries = [];
  const floorsBefore = await scanGet(TOK.floors);
  eq('K1 before: the hall floors have no clean on record', floorsBefore.body?.lastCleanedAt, null);
  const scansBefore = JSON.stringify(world.tables.area_scan_codes);
  const sent = await call(qcHandler, {
    method: 'POST', path: 'checklists/submit', token: 'tok-crew',
    body: {
      templateId: 'it_full', siteId: SITE, clientId: 'cl_coral', jobId: 'j_now',
      items: [{ key: 'fi_glass', checked: true }, { key: 'fi_mats', checked: true }, { key: 'fi_toilet', checked: true }, { key: 'fi_mop', checked: true }],
    },
  });
  eq('K2 the cleaner saves the checklist on their clean (no scan was made)', sent.status, 200);
  const row = (world.tables.checklist_results || [])[0] || {};
  ok('K2 …it is kept on the clean and stamps each area from the checklist itself', row.job_id === 'j_now' && !!row.area_completions?.fa_floors, JSON.stringify(row.area_completions));
  const after = await scanGet(TOK.floors, { ip: '203.0.113.95' });
  ok('K3 🔴 the hall floors\' code now shows that clean — updated by the checklist alone', after.status === 200 && !!after.body?.lastCleanedAt
    && after.body.lastCleanedAt === new Date(row.area_completions.fa_floors).toISOString(), show(after));
  ok('K3 …with what was done there', (after.body?.items || []).map((i) => i.label).join('|') === 'Floors mopped', show(after));
  const lobby = await scanGet(TOK.lobby, { ip: '203.0.113.96' });
  ok('K4 …and every other area it covered (the lobby) moved to it too', lobby.body?.lastCleanedAt === new Date(row.area_completions.fa_entry).toISOString(), show(lobby));
  eq('K5 nothing about the codes changed: no scan is needed for the page to follow the checklist', JSON.stringify(world.tables.area_scan_codes), scansBefore);
}

// ── B. the office ───────────────────────────────────────────────────────────
{
  rpcShape = 'old';
  seed();
  eq('B1 no login is 401', (await office('ensure', null, { siteId: SITE })).status, 401);
  eq('B2 crew are refused', (await office('ensure', 'crew', { siteId: SITE })).status, 403);
}
{
  seed({ overrides: [{ userId: 'u_crew', grants: ['sites.edit'], revokes: [] }] });
  eq('B2 crew are refused EVEN holding the key by a per-user grant (a role floor)', (await office('ensure', 'crew', { siteId: SITE })).status, 403);
}
{
  const perms = seedPermissions().map((p) => (p.id === 'sites.edit' ? { ...p, roles: p.roles.filter((r) => r !== 'manager') } : p));
  seed({ permissions: perms });
  eq('B3 a manager pared off the key is refused', (await office('ensure', 'mgr', { siteId: SITE })).status, 403);
}
{
  seed({ codes: [] });
  const r = await office('ensure', 'mgr', { siteId: SITE });
  eq('B4 the office opens the codes: 200', r.status, 200, show(r));
  const got = r.body?.codes || [];
  ok('B4 one code per area, in the office\'s order', got.map((c) => c.areaId).join(',') === 'area_lobby,area_rest,area_floors', show(r));
  ok('B4 every token is well-formed (32 URL-safe characters)', got.length === 3 && got.every((c) => scan.isScanToken?.(c.token)), show(r));
  ok('B4 every token is distinct', new Set(got.map((c) => c.token)).size === 3);
  eq('B4 🔴 the base is the app\'s permanent address (the brand\'s, with no APP_* set), never the office\'s own origin', r.body?.base, APP_ADDRESS);
  ok('B4 each URL is that base + /scan/ + the token', got.every((c) => c.url === `${APP_ADDRESS}/scan/${c.token}`), show(r));
  ok('B4 …and the address the office happened to be browsing is printed nowhere', !JSON.stringify(r.body).includes('office-host.example'), show(r));
  ok('B4 the labels ride along for the screen', got[0]?.label === 'Lobby & entrance');
  const stored = world.tables.area_scan_codes || [];
  eq('B4 three rows were written', stored.length, 3);
  ok('B4 …each stamped with WHO from the claim', stored.every((c) => c.created_by === 'u_mgr' && c.organization_id === ORG && c.site_id === SITE && c.revoked_at == null));
  const inserts = world.log.filter((q) => q.table === 'area_scan_codes' && q.op === 'insert').length;
  const again = await office('ensure', 'mgr', { siteId: SITE });
  ok('B5 opening it again hands back the SAME codes', (again.body?.codes || []).map((c) => c.token).join() === got.map((c) => c.token).join(), show(again));
  eq('B5 …and mints nothing (idempotent)', world.log.filter((q) => q.table === 'area_scan_codes' && q.op === 'insert').length, inserts);
  eq('B5 …still three rows', (world.tables.area_scan_codes || []).length, 3);
  const live = await scanGet(got[1]?.token);
  eq('B5 a freshly minted code works on the public page at once', live.status, 200);
}
{
  seed();
  process.env.APP_PUBLIC_URL = 'https://app-one.example/';
  process.env.APP_BASE_URL = 'https://app-base.example';
  const r = await office('ensure', 'owner', { siteId: SITE });
  delete process.env.APP_PUBLIC_URL;
  eq('B6 APP_PUBLIC_URL wins over APP_BASE_URL, the brand\'s address and the request\'s origin', r.body?.base, 'https://app-one.example');
  ok('B6 …and every URL is built on it', (r.body?.codes || []).every((c) => c.url.startsWith('https://app-one.example/scan/')), show(r));
  const b = await office('ensure', 'owner', { siteId: SITE });
  delete process.env.APP_BASE_URL;
  eq('B6 then APP_BASE_URL (the emailed links\' own order, api/_lib/appUrl)', b.body?.base, 'https://app-base.example');
  const alias = await office('ensure', 'owner', { siteId: SITE }, {
    origin: 'https://cleanspace-gilt.vercel.app', host: 'cleanspace-gilt.vercel.app', 'x-forwarded-host': 'cleanspace-gilt.vercel.app',
  });
  eq('B6 🔴 a code opened from the old alias still prints the permanent address (CS-111)', alias.body?.base, APP_ADDRESS);
  const n = await office('ensure', 'owner', { siteId: SITE }, { origin: 'javascript:alert(1)' });
  ok('B6 a hostile Origin is never printed into a code', n.status === 200 && n.body?.base === APP_ADDRESS, show(n));
}
{
  seed();
  const r = await office('replace', 'mgr', { siteId: SITE, areaId: 'area_lobby' });
  eq('B7 Replace answers 200', r.status, 200, show(r));
  const fresh = r.body?.code?.token;
  ok('B7 …with a NEW well-formed token', !!fresh && fresh !== TOK.lobby && scan.isScanToken?.(fresh), show(r));
  const old = (world.tables.area_scan_codes || []).find((c) => c.token === TOK.lobby);
  ok('B7 the old row is revoked, by whom and when', !!old?.revoked_at && old?.revoked_by === 'u_mgr', JSON.stringify(old));
  eq('B7 the old label stops working at once', (await scanGet(TOK.lobby)).body?.code, INACTIVE);
  eq('B7 the new one answers', (await scanGet(fresh)).status, 200);
  eq('B7 one live code per area, still', (world.tables.area_scan_codes || []).filter((c) => c.area_id === 'area_lobby' && !c.revoked_at).length, 1);
  eq('B8 Replace on an area the location no longer has is 404', (await office('replace', 'mgr', { siteId: SITE, areaId: 'area_gone' })).status, 404);
  eq('B8 crew may not Replace', (await office('replace', 'crew', { siteId: SITE, areaId: 'area_lobby' })).status, 403);
}
{
  seed();
  eq('B9 a malformed siteId is 400', (await office('ensure', 'mgr', { siteId: 'st),client_id.eq.x' })).status, 400);
  eq('B9 a missing siteId is 400', (await office('ensure', 'mgr', {})).status, 400);
  eq('B9 a location the record does not have is 404', (await office('ensure', 'mgr', { siteId: 'st_nope' })).status, 404);
  eq('B9 an unknown action is 404', (await office('nope', 'mgr', { siteId: SITE })).status, 404);
}
{
  seed();
  const r = await office('sheet', 'mgr', { siteId: SITE, layout: 'labels', format: 'avery5163' });
  eq('B10 the label sheet answers 200', r.status, 200, show(r));
  eq('B10 …as a PDF', r.headers['content-type'], 'application/pdf');
  ok('B10 …named for the building and the sheet', /attachment; filename="[^"]*coral-bay-hoa[^"]*avery5163[^"]*\.pdf"/.test(r.headers['content-disposition'] || ''), r.headers['content-disposition']);
  const call0 = globalThis.__pdfCalls[0] || {};
  const html = String(call0.html || '');
  eq('B10 Chromium was handed one document', globalThis.__pdfCalls.length, 1);
  eq('B10 …with one label per area', (html.match(/class="lbl /g) || []).length, 3);
  ok('B10 …on US letter, the CSS page size honoured, no margin', call0.opts?.preferCSSPageSize === true && /size:\s*8\.5in 11in/.test(html)
    && ['top', 'right', 'bottom', 'left'].every((k) => String(call0.opts?.margin?.[k] ?? '0').replace(/[a-z]/g, '') === '0'), JSON.stringify(call0.opts));
  const live = (world.tables.area_scan_codes || []).filter((c) => c.site_id === SITE && !c.revoked_at && ['area_lobby', 'area_rest', 'area_floors'].includes(c.area_id));
  const qrOf = (token) => (codesLib.qrPathData ? codesLib.qrPathData(QRCode.create(`${APP_ADDRESS}/scan/${token}`, { errorCorrectionLevel: 'M' }))?.d : null);
  ok('B10 each label\'s QR is the matrix of THAT area\'s own URL', live.length === 3 && live.every((c) => { const d = qrOf(c.token); return !!d && html.includes(d); }));
  ok('B10 …and the replaced code is printed nowhere', !html.includes(qrOf(TOK.oldRest) || 'x'.repeat(40)));
  const s = await office('sheet', 'mgr', { siteId: SITE, layout: 'sheet', format: 'avery5163' });
  eq('B11 the one-page sheet answers 200', s.status, 200, show(s));
  const sheetHtml = String(globalThis.__pdfCalls[1]?.html || '');
  ok('B11 …every code once, on ONE page', (sheetHtml.match(/class="cell /g) || []).length === 3 && (sheetHtml.match(/class="pg /g) || []).length === 1);
  eq('B12 an unknown label format is 400, never a different sheet', (await office('sheet', 'mgr', { siteId: SITE, layout: 'labels', format: 'avery9999' })).status, 400);
  eq('B12 an unknown layout is 400', (await office('sheet', 'mgr', { siteId: SITE, layout: 'poster', format: 'avery5163' })).status, 400);
  eq('B12 crew may not print', (await office('sheet', 'crew', { siteId: SITE, layout: 'labels', format: 'avery5163' })).status, 403);
  // Avery 22805 (1½″ squares) is gone (QR-10: no room for a 1¼″ code and the name under it): asked for
  // by name it is refused like any unknown sheet, never quietly swapped for another.
  eq('B12 the removed square sheet (Avery 22805) is refused, never a different sheet', (await office('sheet', 'mgr', { siteId: SITE, layout: 'labels', format: 'avery22805' })).status, 400);
  const tall = await office('sheet', 'mgr', { siteId: SITE, layout: 'labels', format: 'avery5164' });
  eq('B12 the tall labels print', tall.status, 200, show(tall));
}
{
  seed();
  world.failWhen = (q) => q.table === 'area_scan_codes';
  world.failMessage = 'relation area_scan_codes PROVIDER-SECRET';
  const r = await office('ensure', 'mgr', { siteId: SITE });
  ok('B13 an office failure is a sentence + code, never the provider\'s words', r.status >= 500 && typeof r.body?.code === 'string'
    && !JSON.stringify(r.body).includes('PROVIDER-SECRET'), show(r));
}

if (fails.length) { console.error('\narea-scan-route FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\narea-scan-route: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
