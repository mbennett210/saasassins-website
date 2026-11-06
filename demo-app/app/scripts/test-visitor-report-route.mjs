// QR-22..QR-26 (Matt, 2026-10-16) — a VISITOR's report from the public QR page, driven END TO END
// through the REAL handlers against fake-supabase.mjs (no network, no credentials, no live project —
// BUILD_INTEGRITY §6b):
//   POST /api/public/scan/report (EP-414) · /api/qc (the office) · /api/hub (the customer)
//
// What it proves, in the order it matters:
//   A. a report is a TICKET at the code's location, customer and area, typed by its choice (QR-24),
//      origin visitor, routed like any other ticket (QR-25: the building's manager's bell, the
//      type's deadline), the visitor's name and contact kept for the office;
//   B. every refusal is a sentence and a stable code, never an echo, nothing written; every dead code
//      the SAME 404; the honeypot answers thanks and writes nothing;
//   C. the DURABLE limits (counted in the ledger, never an IP, the phone an HMAC) and the
//      same-report-twice answer; the caller-minted id's replay;
//   D. the photo: its bytes judged, its path built by the server, filed at its own scope;
//   E. no secret, or the database before the migration: 503, nothing written;
//   F. 🔴 QR-26 — office only: absent from every customer-hub reader, from the ticket volume, from
//      a cleaner's copy of the visitor's name and contact; present in the office's lists;
//   G. `siteAreaId` on the office's and the hub's creates (one of the location's areas, else 400),
//      shown on the customer's own request; and the old database shape keeps both working.
//
// REGRESSION (THE LAW II.3): on 90d7ca9e the public route answers POST with 405, the office's and
// the hub's creates ignore an area, and the ticket volume counts everything — so nearly every check
// below reports what it wanted.
//
//   node app/scripts/test-visitor-report-route.mjs
import { Readable } from 'node:stream';

const ORG = '00000000-0000-0000-0000-000000000077';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
const SECRET = Buffer.alloc(32, 7).toString('base64');
process.env.INBOX_TOKEN_ENCRYPTION_KEY = SECRET;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const { __resetRateLimit } = await import('../api/_lib/rateLimit.js');
const wo = await import('../src/lib/workOrders.js');
const vr = await tryImport('../src/lib/visitorReports.js');
const cols = await tryImport('../api/_lib/qc/ticketColumns.js');
const notify = await import('../api/_lib/clientHub/notify.js');
const scanLib = await import('../src/lib/areaScan.js');
const publicHandler = (await import('../api/public/scan/[...path].js')).default;
const qcHandler = (await import('../api/qc/[...path].js')).default;
const hubHandler = (await import('../api/hub/[...path].js')).default;

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, want !== undefined && JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const show = (r) => `got ${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;

// ── the world ───────────────────────────────────────────────────────────────
const H = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SITE = 'st_club';
const AREAS = [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }];
const T = (c) => c.repeat(32);
const TOK = { lobby: T('L'), rest: T('R'), old: T('O'), gone: T('G') };
const CODE = { lobby: 'c0000000-0000-4000-8000-0000000000a1', rest: 'c0000000-0000-4000-8000-0000000000a2' };
const CU = 'a0000000-0000-4000-8000-000000000001';
const DEVICE = 'dev_visitor_0123456789abcdef';
const OFFICE_TICKET = 'e0000000-0000-4000-8000-000000000001';
const user = (id, role, name) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {} });

function seed({ tables = {} } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 5,
        state: {
          company: { name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_owner', 'owner', 'Dana Owner'), user('u_mgr', 'manager', 'Renata Cruz'), user('u_crew', 'crew', 'Tomas Rivera')],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr' }, { id: 'cl_b', name: 'Elsewhere', supervisorId: 'u_owner' }],
          sites: [
            { id: SITE, clientId: 'cl_a', name: 'Clubhouse', cleaningAreas: AREAS },
            { id: 'st_other', clientId: 'cl_b', name: 'Other', cleaningAreas: [{ id: 'area_x', label: 'X' }] },
          ],
          notifications: [],
        },
      }],
      area_scan_codes: [
        { id: CODE.lobby, organization_id: ORG, site_id: SITE, area_id: 'area_lobby', token: TOK.lobby, created_at: iso(NOW - 48 * H), revoked_at: null },
        { id: CODE.rest, organization_id: ORG, site_id: SITE, area_id: 'area_rest', token: TOK.rest, created_at: iso(NOW - 48 * H), revoked_at: null },
        { id: 'c0000000-0000-4000-8000-0000000000a3', organization_id: ORG, site_id: SITE, area_id: 'area_lobby', token: TOK.old, created_at: iso(NOW - 96 * H), revoked_at: iso(NOW - 48 * H) },
        { id: 'c0000000-0000-4000-8000-0000000000a4', organization_id: ORG, site_id: SITE, area_id: 'area_removed', token: TOK.gone, created_at: iso(NOW - 96 * H), revoked_at: null },
      ],
      problem_reports: [{
        id: OFFICE_TICKET, organization_id: ORG, client_id: 'cl_a', site_id: SITE, title: 'Office note', type: 'issue', origin: 'internal',
        priority: 'medium', status: 'open', created_at: iso(NOW - 2 * H), category: null,
      }],
      visitor_reports: [],
      account_media: [],
      crew_assignments: [],
      jobs: [{ id: 'j_today', organization_id: ORG, client_id: 'cl_a', site_id: SITE, status: 'in_progress', start_at: iso(NOW - H), data: { id: 'j_today', clientId: 'cl_a', siteId: SITE, startAt: iso(NOW - H), crewIds: ['u_crew'] } }],
      client_users: [{ id: CU, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', status: 'active', auth_user_id: 'auth-c1' }],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: [{ id: 'as1', organization_id: ORG, client_user_id: CU, client_id: 'cl_a', group_id: null }],
      ...tables,
    },
    logins: {
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU, org_id: ORG } },
    },
  });
  __resetRateLimit();
  cols.__resetTicketColumnProbe?.();
}

async function call(handler, { method = 'GET', path, token, body, query = {}, headers = {} }) {
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
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
        headersSent: false,
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
const JSON_H = { 'content-type': 'application/json' };
let ipSeq = 0;
const report = (body, { ip = `203.0.113.${(ipSeq += 1) % 250}`, headers = JSON_H } = {}) => call(publicHandler, {
  method: 'POST', path: 'report', body, headers: { 'x-vercel-forwarded-for': ip, ...headers },
});
const base = (patch = {}) => ({ token: TOK.lobby, category: 'supplies', deviceId: DEVICE, hp: '', ...patch });
const tickets = () => (world.tables.problem_reports || []).filter((p) => p.origin === 'visitor');
const ledger = () => world.tables.visitor_reports || [];
const RC = vr.VISITOR_REPORT_CODES || {};
const INACTIVE = scanLib.SCAN_INACTIVE_CODE;

// ── A. a report is a ticket like any other (QR-24, QR-25) ───────────────────
{
  seed();
  const r = await report(base({ text: 'No soap in the men’s room', name: 'Ana Ruiz', contact: '+1 (305) 555-0142' }));
  eq('A1 a report answers 200', r.status, 200);
  eq('A1 …with the sentence the page shows', r.body?.message, vr.VISITOR_REPORT_THANKS);
  ok('A1 …and nothing else: no ticket id, no echo', JSON.stringify(Object.keys(r.body || {}).sort()) === JSON.stringify(['message', 'ok', 'photoSaved']), show(r));
  ok('A1 …never cached', r.status === 200 && r.headers['cache-control'] === 'no-store', show(r));
  const t = tickets()[0] || {};
  eq('A2 ONE visitor ticket', tickets().length, 1);
  eq('A2 …at the CODE\'s location and customer', [t.site_id, t.client_id, t.site_name, t.client_name], [SITE, 'cl_a', 'Clubhouse', 'Coral Bay HOA']);
  eq('A2 …about the code\'s area', t.site_area_id, 'area_lobby');
  eq('A2 …titled by the area and the choice', t.title, 'Lobby: Out of supplies');
  eq('A2 …the visitor\'s words as its details', t.description, 'No soap in the men’s room');
  eq('A3 QR-24: out of supplies is a request, restock', [t.type, t.category], ['request', 'restock']);
  eq('A3 …origin visitor, the ordinary urgency, open', [t.origin, t.priority, t.status], ['visitor', 'medium', 'open']);
  eq('A3 …its deadline the request\'s 24 hours (lib/workOrders)', Date.parse(t.due_at) - Date.parse(t.created_at), wo.TYPE_DEADLINE_HOURS.request * H);
  eq('A4 the visitor\'s name and contact, for the office', [t.reporter_name, t.reporter_contact], ['Ana Ruiz', '+1 (305) 555-0142']);
  ok('A4 …nobody on the roster reported it', !!t.id && t.reported_by_user_id == null && t.raised_by_client_user_id == null);
  const row = ledger()[0] || {};
  eq('A5 the ledger names the ticket, the code, the area and the choice', [row.problem_id, row.code_id, row.site_id, row.area_id, row.choice], [t.id, CODE.lobby, SITE, 'area_lobby', 'supplies']);
  ok('A5 …the phone as a 43-character HMAC, never the id itself', /^[A-Za-z0-9_-]{43}$/.test(row.device_hash || '') && row.device_hash !== DEVICE && !JSON.stringify(row).includes(DEVICE), JSON.stringify(row));
  ok('A5 …and no IP anywhere', ledger().length > 0 && !JSON.stringify(world.tables).includes('203.0.113.'));
  const bells = world.tables.org_state[0].state.notifications || [];
  ok('A6 QR-25: the building\'s manager is rung, like any new ticket', bells.some((n) => n.userId === 'u_mgr'), JSON.stringify(bells.map((n) => n.userId)));
  ok('A6 …and only them (supervisor-first)', bells.length > 0 && bells.every((n) => n.userId === 'u_mgr'), JSON.stringify(bells.map((n) => n.userId)));
  ok('A6 …with the ticket\'s title, not the visitor\'s words', bells.some((n) => /Lobby: Out of supplies/.test(n.body || '')) && !JSON.stringify(bells).includes('No soap'), JSON.stringify(bells));

  const c = await report(base({ token: TOK.rest, category: 'cleaning', text: '' }));
  const ct = tickets().find((x) => x.site_area_id === 'area_rest') || {};
  eq('A7 needs cleaning: a complaint, spill, 2 hours', [c.status, ct.type, ct.category, Date.parse(ct.due_at) - Date.parse(ct.created_at)], [200, 'complaint', 'spill', wo.TYPE_DEADLINE_HOURS.complaint * H]);
  ok('A7 …with no words, no details', !!ct.id && ct.description == null);
  const b = await report(base({ category: 'broken', deviceId: 'dev_other_phone_00000001' }));
  eq('A7 broken: a complaint, damage', [b.status, tickets().slice(-1)[0]?.type, tickets().slice(-1)[0]?.category], [200, 'complaint', 'damage']);
  const o = await report(base({ category: 'other', text: 'The door is propped open', deviceId: 'dev_other_phone_00000002' }));
  eq('A7 something else: a request, other (our default)', [o.status, tickets().slice(-1)[0]?.type, tickets().slice(-1)[0]?.category], [200, 'request', 'other']);
  const spoof = await report(base({ category: 'supplies', deviceId: 'dev_other_phone_00000003', origin: 'portal', type: 'issue', siteId: 'st_other', clientId: 'cl_b', priority: 'urgent', siteAreaId: 'area_x' }));
  const st = tickets().slice(-1)[0] || {};
  eq('A8 a body naming a building, area, type, origin or urgency changes none of them', [spoof.status, st.site_id, st.client_id, st.site_area_id, st.type, st.origin, st.priority], [200, SITE, 'cl_a', 'area_lobby', 'request', 'visitor', 'medium']);
}

// ── B. refusals: a sentence and a code, nothing written ─────────────────────
{
  seed();
  const before = () => [tickets().length, ledger().length, (world.tables.org_state[0].state.notifications || []).length].join('/');
  const zero = before();
  const refusal = async (label, body, wantStatus, wantCode, opts) => {
    const r = await report(body, opts);
    eq(`${label}: ${wantStatus} ${wantCode}`, [r.status, r.body?.code], [wantStatus, wantCode]);
    const mine = wantCode !== undefined && r.body?.code === wantCode;
    ok(`${label}: …in a sentence`, mine && typeof r.body?.error === 'string' && r.body.error.length > 5, show(r));
    ok(`${label}: …that does not echo what was sent`, mine && !JSON.stringify(r.body || {}).includes('ZZSENT'), show(r));
  };
  await refusal('B1 not JSON', 'category=supplies', 415, RC.contentType, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  await refusal('B2 a body over the cap', base(), 413, RC.tooLarge, { headers: { ...JSON_H, 'content-length': String((vr.VISITOR_BODY_MAX_BYTES || 0) + 1) } });
  await refusal('B3 not an object', '["ZZSENT"]', 400, RC.body);
  await refusal('B4 no choice', base({ category: 'ZZSENT' }), 400, RC.choice);
  await refusal('B5 "something else" with no words', base({ category: 'other', text: 'ab' }), 400, RC.textRequired);
  await refusal('B6 too many words', base({ text: `ZZSENT${'x'.repeat(vr.VISITOR_TEXT_MAX || 0)}` }), 400, RC.textLong);
  await refusal('B7 a name too long', base({ name: `ZZSENT${'n'.repeat(vr.VISITOR_NAME_MAX || 0)}` }), 400, RC.nameLong);
  await refusal('B8 a contact that is neither phone nor email', base({ contact: 'ZZSENT call me' }), 400, RC.contact);
  await refusal('B9 no phone id', base({ deviceId: undefined }), 400, RC.device);
  await refusal('B10 a malformed caller id', base({ id: 'ZZSENT' }), 400, RC.id);
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]).toString('base64');
  await refusal('B11 a photo that is a GIF', base({ photo: `data:image/gif;base64,${gif}` }), 400, RC.photo);
  const html = Buffer.from('<html>ZZSENT<script>alert(1)</script></html>').toString('base64');
  await refusal('B12 a page named a JPEG', base({ photo: `data:image/jpeg;base64,${html}` }), 400, RC.photo);
  // (The fallback only keeps this fixture buildable on a tree without the constant; the check is the route's code.)
  const bigJpeg = Buffer.alloc((vr.VISITOR_PHOTO_MAX_BYTES || 2 * 1024 * 1024) + 3, 1);
  bigJpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  await refusal('B13 a photo over 2 MB decoded', base({ photo: `data:image/jpeg;base64,${bigJpeg.toString('base64')}` }), 400, RC.photoLarge);
  eq('B14 none of those wrote a ticket, a ledger row or a bell', before(), zero);

  const dead = async (label, token) => {
    const r = await report(base({ token }));
    eq(`${label}: the SAME 404 as the public page`, [r.status, r.body?.code, r.body?.error], [404, INACTIVE, scanLib.SCAN_INACTIVE_MESSAGE]);
  };
  await dead('B15 a malformed code', '../../etc/passwd');
  await dead('B15 an unknown code', T('U'));
  await dead('B15 a replaced code', TOK.old);
  await dead('B15 a code whose area was removed', TOK.gone);
  eq('B15 …and nothing written for any of them', before(), zero);

  const hp = await report(base({ hp: 'http://spam.example', text: 'buy now' }));
  eq('B16 the honeypot: the same thanks a person gets', [hp.status, hp.body?.message], [200, vr.VISITOR_REPORT_THANKS]);
  eq('B16 …and nothing written', before(), zero);
  const get = await call(publicHandler, { method: 'GET', path: 'report', query: { token: TOK.lobby } });
  eq('B17 GET on the report is 405', get.status, 405);
  const postArea = await call(publicHandler, { method: 'POST', path: 'area', body: {}, headers: JSON_H });
  eq('B17 …and the reads stay GET-only', postArea.status, 405);
  const limit = vr.VISITOR_POST_RATE?.perIp?.limit || 0;
  let last = null;
  for (let i = 0; i <= limit; i += 1) last = await report(base({ category: 'ZZ' }), { ip: '198.51.100.9' });
  eq('B18 one address past its minute: 429', [last?.status, last?.body?.code], [429, scanLib.SCAN_RATE_LIMITED_CODE]);
}

// ── C. the durable limits, the same report twice, the replay ────────────────
{
  seed();
  const r1 = await report(base());
  const r2 = await report(base({ text: 'again' }));
  eq('C1 the same phone, code and choice inside 10 minutes: "we already have this one"', [r1.status, r2.status, r2.body?.message, r2.body?.duplicate], [200, 200, vr.VISITOR_REPORT_ALREADY, true]);
  eq('C1 …and no second ticket', tickets().length, 1);
  const hash = ledger()[0]?.device_hash;
  const L = vr.VISITOR_LIMITS || {};
  const ago = (min) => iso(NOW - min * 60 * 1000);
  const row = (i, extra) => ({ problem_id: `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, organization_id: ORG, code_id: CODE.lobby, site_id: SITE, area_id: 'area_lobby', device_hash: hash, choice: 'cleaning', created_at: ago(30), ...extra });
  // The phone at its hour's limit on this code (a different choice, so not "the same report").
  world.tables.visitor_reports = Array.from({ length: L.perPhonePerCodeHour || 0 }, (_, i) => row(i));
  const r3 = await report(base({ category: 'broken' }));
  eq('C2 a phone at its limit on one code in an hour: 429', [r3.status, r3.body?.code], [429, RC.limitPhone]);
  // …but those three are 61 minutes old: allowed again.
  world.tables.visitor_reports = Array.from({ length: L.perPhonePerCodeHour || 0 }, (_, i) => row(i, { created_at: ago(61) }));
  eq('C2 …an hour later, allowed again', (await report(base({ category: 'broken' }))).status, 200);
  // The phone's day: ten, across codes.
  world.tables.visitor_reports = Array.from({ length: L.perPhonePerDay || 0 }, (_, i) => row(i, { code_id: CODE.rest, created_at: ago(120 + i) }));
  const r4 = await report(base({ category: 'other', text: 'eleventh' }));
  eq('C3 a phone at its day\'s limit: 429', [r4.status, r4.body?.code], [429, RC.limitPhone]);
  // The code's hour: twenty, from other phones.
  world.tables.visitor_reports = Array.from({ length: L.perCodePerHour || 0 }, (_, i) => row(i, { device_hash: `${'x'.repeat(40)}${String(i).padStart(3, '0')}` }));
  const r5 = await report(base({ category: 'other', text: 'one too many', deviceId: 'dev_brand_new_phone_0001' }));
  eq('C4 a code at its hour\'s limit, from every phone together: 429', [r5.status, r5.body?.code], [429, RC.limitCode]);
  ok('C4 …a sentence the page can show', /lot of reports/.test(r5.body?.error || ''), show(r5));

  seed();
  const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const first = await report(base({ id: ID }));
  const again = await report(base({ id: ID }));
  eq('C5 a retried send with the same id: the same thanks', [first.status, again.status, again.body?.message], [200, 200, vr.VISITOR_REPORT_THANKS]);
  eq('C5 …one ticket, under the page\'s own id', tickets().map((x) => x.id), [ID]);
  const taken = await report(base({ id: OFFICE_TICKET, category: 'broken', deviceId: 'dev_some_other_phone_01' }));
  eq('C6 an id that names someone else\'s ticket: 409, and it is not touched', [taken.status, taken.body?.code, world.tables.problem_reports.find((p) => p.id === OFFICE_TICKET)?.title], [409, RC.id, 'Office note']);
}

// ── D. the photo ────────────────────────────────────────────────────────────
{
  seed();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(200, 9)]);
  const r = await report(base({ photo: `data:image/jpeg;base64,${jpeg.toString('base64')}`, storagePath: `${ORG}/st_other/aaaaaaaaaaaaaaaa.jpg` }));
  eq('D1 a report with a photo: saved', [r.status, r.body?.photoSaved], [200, true]);
  const t = tickets()[0] || {};
  const m = (world.tables.account_media || [])[0] || {};
  eq('D2 the photo is the ticket\'s, at the visitor\'s own scope (never a completion photo)', [m.scope, m.ref_id, m.site_id, m.client_id, m.kind], ['visitor_report', t.id, SITE, 'cl_a', 'image']);
  ok('D3 its path is built by the server: the org, the CODE\'s location, random', new RegExp(`^${ORG}/${SITE}/[a-f0-9]{20}\\.jpg$`).test(m.storage_path || ''), m.storage_path);
  ok('D3 …the path the body sent is ignored', !!m.storage_path && !String(m.storage_path).includes('st_other'));
  const up = world.storage.find((s) => s.op === 'upload') || {};
  ok('D4 the bytes went to the private bucket under that path', up.bucket === 'ops-media' && up.path === m.storage_path && up.contentType === 'image/jpeg' && !up.upsert, JSON.stringify(up));
  ok('D4 …exactly the bytes sent', Buffer.from(world.objects[`ops-media/${m.storage_path}`] || []).equals(jpeg));
  ok('D5 WO-10 still holds: the visitor\'s photo is no completion photo', m.scope === 'visitor_report' && (world.tables.account_media || []).filter((x) => x.scope === 'problem_report').length === 0);
  // A failing upload never fails the report.
  seed();
  world.failWhen = (q) => q.table === 'account_media' && q.op === 'insert';
  const f = await report(base({ photo: `data:image/jpeg;base64,${jpeg.toString('base64')}` }));
  eq('D6 a photo that could not be filed: the report still stands, and says so', [f.status, f.body?.photoSaved, tickets().length], [200, false, 1]);
  ok('D6 …and the uploaded object is removed again', world.storage.some((s) => s.op === 'remove'), JSON.stringify(world.storage));
}

// ── E. no secret, and the database before the migration ─────────────────────
{
  seed();
  delete process.env.INBOX_TOKEN_ENCRYPTION_KEY;
  const r = await report(base());
  eq('E1 no server secret for the phone\'s HMAC: 503, in words', [r.status, r.body?.code], [503, RC.unavailable]);
  ok('E1 …that names no setting', r.body?.code === RC.unavailable && !/KEY|ENCRYPTION|env/i.test(JSON.stringify(r.body || {})), show(r));
  eq('E1 …and nothing written', tickets().length, 0);
  process.env.INBOX_TOKEN_ENCRYPTION_KEY = SECRET;
  seed();
  world.failWhen = (q) => q.table === 'visitor_reports';
  world.failMessage = 'relation "public.visitor_reports" does not exist';
  const m = await report(base());
  eq('E2 before the migration (no ledger table): 503 "not available"', [m.status, m.body?.code], [503, RC.unavailable]);
  ok('E2 …never the provider\'s words', m.body?.code === RC.unavailable && !JSON.stringify(m.body || {}).includes('relation'), show(m));
  eq('E2 …and no ticket was opened', tickets().length, 0);
}

// ── F. 🔴 QR-26: office only ────────────────────────────────────────────────
const hub = (method, path, query = {}, body) => call(hubHandler, { method, path, token: 'tok-client', query, body, headers: body ? JSON_H : {} });
const qc = (who, method, path, query = {}, body) => call(qcHandler, { method, path, token: `tok-${who}`, query, body, headers: body ? JSON_H : {} });
{
  // The visitor's ticket is SEEDED here (the shape EP-414 writes, A above), so each customer reader
  // is judged on its own, whatever the route does.
  const VT = 'e0000000-0000-4000-8000-0000000000f1';
  seed({ tables: { problem_reports: [
    { id: OFFICE_TICKET, organization_id: ORG, client_id: 'cl_a', site_id: SITE, title: 'Office note', type: 'issue', origin: 'internal', priority: 'medium', status: 'open', created_at: iso(NOW - 2 * H), category: null },
    { id: VT, organization_id: ORG, client_id: 'cl_a', site_id: SITE, client_name: 'Coral Bay HOA', site_name: 'Clubhouse', title: 'Lobby: Out of supplies', description: 'No soap', type: 'request', origin: 'visitor', category: 'restock', priority: 'medium', status: 'open', created_at: iso(NOW - 3 * H), resolved_at: null, site_area_id: 'area_lobby', reporter_name: 'Ana Ruiz', reporter_contact: 'ana@example.test' },
    // …and one the office has already resolved (the customer's time-to-resolve tile must not count it).
    { id: 'e0000000-0000-4000-8000-0000000000f2', organization_id: ORG, client_id: 'cl_a', site_id: SITE, client_name: 'Coral Bay HOA', site_name: 'Clubhouse', title: 'Restrooms: Needs cleaning', description: null, type: 'complaint', origin: 'visitor', category: 'spill', priority: 'medium', status: 'resolved', created_at: iso(NOW - 5 * H), resolved_at: iso(NOW - 4 * H), site_area_id: 'area_rest', reporter_name: null, reporter_contact: null },
  ] } });
  const vt = world.tables.problem_reports.find((p) => p.id === VT) || {};
  ok('F0 there is a visitor ticket on the customer\'s building', vt.client_id === 'cl_a' && vt.origin === 'visitor');
  const list = await hub('GET', 'tickets', { buildingId: 'cl_a' });
  ok('F1 the customer\'s Requests list does not hold it', list.status === 200 && !(list.body?.rows || []).some((x) => x.id === vt.id), show(list));
  eq('F1 …nor counts it', list.body?.total, 0);
  const one = await hub('GET', 'ticket', { buildingId: 'cl_a', id: vt.id });
  eq('F2 opening it by its id: the same 404 as any other building\'s', one.status, 404);
  const home = await hub('GET', 'home', { buildingId: 'cl_a' });
  ok('F3 the customer\'s Home counts no visitor report', home.status === 200 && home.body?.requests && Object.values(home.body.requests).every((n) => n === 0), show(home));
  eq('F3 …nor its average time to resolve (the visitor\'s is resolved)', home.body?.resolve?.count, 0);
  const hist = await hub('GET', 'history', { buildingId: 'cl_a' });
  ok('F4 nor does their history', hist.status === 200 && !JSON.stringify(hist.body).includes(vt.id) && !JSON.stringify(hist.body).includes('Out of supplies'), show(hist));
  const bell = await hub('GET', 'updates');
  ok('F5 nor their bell', bell.status === 200 && !JSON.stringify(bell.body).includes(vt.id), show(bell));
  // The office moves it along: the customer is emailed about nothing (the gate never even looks them up).
  const logBefore = world.log.length;
  ok('F6 a stage change on it emails no customer', (await notify.emailTicketStageChanged({ ...vt, status: 'in_progress' }, 'open')) === false);
  ok('F6 …and reads no customer login to try', !world.log.slice(logBefore).some((q) => q.table === 'client_users'));
  const counts = await qc('owner', 'GET', 'problems/counts');
  const a = (counts.body?.counts || []).find((x) => x.clientId === 'cl_a');
  eq('F7 the customer\'s ticket volume (WO-14) leaves both out: only the office\'s own ticket', a?.count, 1);
  const office = await qc('owner', 'GET', 'problems/list');
  const mine = (office.body?.problems || []).find((x) => x.id === vt.id) || {};
  eq('F8 the office\'s queue holds it, with the visitor\'s name and contact', [mine.origin, mine.reporter_name, mine.reporter_contact], ['visitor', 'Ana Ruiz', 'ana@example.test']);
  const crew = await qc('crew', 'GET', 'problems/list');
  const cv = (crew.body?.problems || []).find((x) => x.id === vt.id);
  ok('F9 a cleaner at the building sees the ticket', !!cv, show(crew));
  ok('F9 …without the visitor\'s name or contact', cv && !('reporter_name' in cv) && !('reporter_contact' in cv) && !JSON.stringify(crew.body).includes('ana@example.test'), JSON.stringify(cv));
  const upd = await qc('crew', 'POST', 'problems/update', {}, { id: vt.id, status: 'in_progress' });
  ok('F10 a cleaner\'s update answers the ticket without them too', upd.status === 200 && !JSON.stringify(upd.body).includes('Ana Ruiz'), show(upd));
}

// ── G. an area on the office's and the hub's creates ────────────────────────
{
  seed();
  const good = await qc('mgr', 'POST', 'problems/create', {}, { siteId: SITE, title: 'Mop the lobby', siteAreaId: 'area_lobby' });
  eq('G1 the office files a ticket about one of the location\'s areas', [good.status, good.body?.problem?.site_area_id], [200, 'area_lobby']);
  const bad = await qc('mgr', 'POST', 'problems/create', {}, { siteId: SITE, title: 'Pool', siteAreaId: 'area_x' });
  eq('G1 …another location\'s area is refused', [bad.status, bad.body?.code], [400, wo.AREA_CODES?.unknown]);
  const vis = await qc('mgr', 'POST', 'problems/create', {}, { siteId: SITE, title: 'Pretend', origin: 'visitor', reporterName: 'X' });
  eq('G2 the office cannot file a "visitor" ticket: it is its own', [vis.status, vis.body?.problem?.origin, vis.body?.problem?.reporter_name ?? null], [200, 'internal', null]);
  const hc = await hub('POST', 'ticket-create', {}, { id: 'aaaaaaaa-0000-4000-8000-0000000000c1', buildingId: 'cl_a', type: 'request', category: 'restock', description: 'Lobby: more paper towels please', siteAreaId: 'area_lobby' });
  eq('G3 the customer\'s "request about this area" stores it', [hc.status, world.tables.problem_reports.find((p) => p.id === 'aaaaaaaa-0000-4000-8000-0000000000c1')?.site_area_id], [200, 'area_lobby']);
  eq('G3 …and names it on their request', hc.body?.ticket?.area, 'Lobby');
  const hl = await hub('GET', 'tickets', { buildingId: 'cl_a' });
  eq('G3 …in their list too (the area\'s NAME, never its id)', (hl.body?.rows || []).map((x) => x.area), ['Lobby']);
  ok('G3 …and no row carries an area id', (hl.body?.rows || []).length > 0 && !JSON.stringify(hl.body).includes('area_lobby'), show(hl));
  const hbad = await hub('POST', 'ticket-create', {}, { buildingId: 'cl_a', type: 'request', category: 'restock', description: 'x', siteAreaId: 'area_x' });
  eq('G4 a customer naming another building\'s area: 400 area-unknown', [hbad.status, hbad.body?.code], [400, wo.AREA_CODES?.unknown]);
  ok('G4 …in the hub\'s own words', /building/.test(hbad.body?.error || ''), show(hbad));

  // The database BEFORE the migration: the column is not there, and nothing may name it.
  seed();
  world.failWhen = (q) => q.table === 'problem_reports' && String(q.cols || '').includes('site_area_id');
  const old = await qc('mgr', 'POST', 'problems/create', {}, { siteId: SITE, title: 'Mop the lobby', siteAreaId: 'area_lobby' });
  eq('G5 old shape: the office\'s create still goes through', old.status, 200);
  ok('G5 …without naming the column it does not have', !world.log.some((q) => q.table === 'problem_reports' && q.op === 'insert' && JSON.stringify(q).includes('site_area_id')) && !('site_area_id' in (world.tables.problem_reports.slice(-1)[0] || {})));
  const oldList = await hub('GET', 'tickets', { buildingId: 'cl_a' });
  eq('G6 old shape: the customer\'s Requests still load', oldList.status, 200);
  const oldCreate = await hub('POST', 'ticket-create', {}, { buildingId: 'cl_a', type: 'request', category: 'restock', description: 'x', siteAreaId: 'area_lobby' });
  eq('G6 …and their request still goes through', oldCreate.status, 200);
}

console.log(`\ntest-visitor-report-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
