// /api/quickbooks/[...path] route authz + behaviour (offline). Drives the REAL handler through
// fake-supabase.mjs with Intuit stubbed at the fetch boundary. Proves: every branch 401s
// unauthenticated; owner-only branches 403 for admin/manager/crew; pnl needs financials.view;
// a non-owner holder sees ONLY the properties they supervise (never another's numbers); the
// OAuth callback rejects a forged / expired / replayed state and exchanges the code once; no
// response body carries token material; every response is `private, no-store`; an unknown
// subpath is 401 anonymous / 404 authenticated; oauth/start is `not_configured` when env is missing.
//
//   node scripts/test-qbo-route.mjs
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { resolveRange } from '../api/_lib/qbo/ranges.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const KEY_ENV = 'QBO_TOKEN_ENCRYPTION_KEY';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.QBO_CLIENT_ID = 'qbo-client';
process.env.QBO_CLIENT_SECRET = 'qbo-secret';
process.env.QBO_ENVIRONMENT = 'sandbox';
process.env.QBO_REDIRECT_URI = 'https://cleanspace-gilt.vercel.app/api/quickbooks/oauth/callback';
process.env.QBO_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
// A DIFFERENT valid key for the inbox default — the forged-state case signs with it to
// prove a default-signed state never verifies under the QBO key.
process.env.INBOX_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// ── Intuit stub ─────────────────────────────────────────────────────────────
let tokenCalls = 0;
let pnlCalls = 0;
const jsonRes = (ok, status, body) => ({ ok, status, headers: { get: () => 'tid_test' }, json: async () => body });
// Intuit's REAL column shape (confirmed on the sandbox company, 2026-09-28): every column carries
// MetaData ColKey — 'account', an entity id, 'not_specified' or 'total' — and a parent customer's
// sub-customers sit between its own column and a "Total <parent>" roll-up carrying the SAME id.
// Here Brickell (2) is a sub-customer of Harbor Group (9).
const col = (title, key, type = 'Money') => ({ ColTitle: title, ColType: type, MetaData: [{ Name: 'ColKey', Value: key }] });
const CUSTOMERS_PNL = {
  Header: { ReportBasis: 'Accrual' },
  Columns: { Column: [col('', 'account', 'Account'), col('Ball Harbor', '1'), col('Harbor Group', '9'), col('Brickell', '2'), col('Total Harbor Group', '9'), col('Not Specified', 'not_specified'), col('TOTAL', 'total')] },
  Rows: { Row: [{ group: 'Income', Summary: { ColData: [{ value: 'Income' }, { value: '1000.00' }, { value: '50.00' }, { value: '2000.00' }, { value: '2050.00' }, { value: '10.00' }, { value: '3060.00' }] } }] },
};
const CLASSES_PNL = {
  Header: { ReportBasis: 'Accrual' },
  Columns: { Column: [col('', 'account', 'Account'), col('Las Olas', '3'), col('Not Specified', 'not_specified'), col('TOTAL', 'total')] },
  Rows: { Row: [{ group: 'Income', Summary: { ColData: [{ value: 'Income' }, { value: '500.00' }, { value: '0.00' }, { value: '500.00' }] } }] },
};
// The token-endpoint body is overridable so the callback's code-exchange validation (F2) can
// be driven with a malformed 200; reset to the valid body after each such case.
const validTokenBody = () => ({ access_token: 'AT_NEW', expires_in: 3600, refresh_token: 'RT_NEW', x_refresh_token_expires_in: 8640000 });
let tokenResponder = () => jsonRes(true, 200, validTokenBody());
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://oauth.platform.intuit.com')) { tokenCalls += 1; return tokenResponder(); }
  if (u.includes('/companyinfo/')) return jsonRes(true, 200, { CompanyInfo: { CompanyName: 'CleanSpace Sandbox', CompanyStartDate: '2019-01-01' } });
  if (u.includes('/reports/ProfitAndLoss')) {
    pnlCalls += 1;
    const by = new URL(u).searchParams.get('summarize_column_by');
    return jsonRes(true, 200, by === 'Classes' ? CLASSES_PNL : CUSTOMERS_PNL);
  }
  if (u.includes('/query')) return jsonRes(true, 200, { QueryResponse: { Customer: [{ Id: '1', DisplayName: 'Ball Harbor', Active: true }, { Id: '2', DisplayName: 'Brickell', Active: false }] } });
  if (u.includes('/tokens/revoke')) return jsonRes(true, 200, {});
  throw new Error(`network blocked in this suite (${u})`);
};

installFakeSupabase();
const { encrypt, signState } = await import('../api/_lib/crypto.js');
const handler = (await import('../api/quickbooks/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── people + world ───────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },     // claim-less, as live
  mgr2: { id: 'u_mgr2', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewFin: { id: 'u_crew_fin', role: 'crew', claim: true }, // granted financials.view
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, { id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} }]));
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const CLIENTS = [
  { id: 'cl_1', name: 'Ball Harbor Village', supervisorId: 'u_mgr' },
  { id: 'cl_2', name: 'Brickell Bay Offices', supervisorId: 'u_mgr2' },
  { id: 'cl_3', name: 'Las Olas Medical', supervisorId: 'u_mgr' },
];
const connRow = () => ({
  organization_id: ORG, environment: 'sandbox', realm_id: 'realm_1', company_name: 'CleanSpace Sandbox',
  access_token_enc: encrypt('SECRET_AT', KEY_ENV), access_token_expires_at: iso(3600e3),
  refresh_token_enc: encrypt('SECRET_RT', KEY_ENV), refresh_token_expires_at: iso(80 * 86400e3), refresh_token_hard_expires_at: null,
  token_version: 3, refresh_lease_until: null, status: 'active', last_error: null, connected_by: 'u_owner', connected_at: iso(-1000), last_synced_at: null,
});
const linkRows = () => [
  { organization_id: ORG, client_id: 'cl_1', realm_id: 'realm_1', entity_type: 'customer', entity_id: '1', entity_name: 'Ball Harbor', linked_by: 'u_owner' },
  { organization_id: ORG, client_id: 'cl_2', realm_id: 'realm_1', entity_type: 'customer', entity_id: '2', entity_name: 'Brickell', linked_by: 'u_owner' },
  { organization_id: ORG, client_id: 'cl_3', realm_id: 'realm_1', entity_type: 'class', entity_id: '3', entity_name: 'Las Olas', linked_by: 'u_owner' },
  { organization_id: ORG, client_id: 'cl_old', realm_id: 'realm_OTHER', entity_type: 'customer', entity_id: '9', entity_name: 'Old realm', linked_by: 'u_owner' },
];
function build({ connected = true, links = true, overrides = [] } = {}) {
  tokenCalls = 0; pnlCalls = 0;
  const state = { users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides, clients: CLIENTS, company: { timezone: 'America/Los_Angeles' } };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 4 }],
      qbo_connection: connected ? [connRow()] : [],
      qbo_property_links: links ? linkRows() : [],
      qbo_report_cache: [],
      qbo_oauth_states: [],
    },
    logins,
  });
}
const conn = () => world.tables.qbo_connection[0] || null;

// ── a request through the real handler ────────────────────────────────────────
async function call({ method = 'GET', path, token, body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: path };
  req.body = body;
  const headers = {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        setHeader(k, v) { headers[k.toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const tok = (w) => `tok-${w}`;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;

// ── 1. every gated branch 401s unauthenticated ────────────────────────────────
const GATED = [
  { label: 'status', method: 'GET', path: 'status' },
  { label: 'oauth/start', method: 'GET', path: 'oauth/start' },
  { label: 'disconnect', method: 'POST', path: 'disconnect' },
  { label: 'entities', method: 'GET', path: 'entities', query: { type: 'customer' } },
  { label: 'links GET', method: 'GET', path: 'links' },
  { label: 'links PUT', method: 'PUT', path: 'links', body: { clientId: 'cl_1', entityType: 'customer', entityId: '1' } },
  { label: 'links DELETE', method: 'DELETE', path: 'links', body: { clientId: 'cl_1' } },
  { label: 'pnl', method: 'GET', path: 'pnl', query: { range: 'd30' } },
  { label: 'refresh', method: 'POST', path: 'refresh' },
  { label: 'unknown subpath', method: 'GET', path: 'nonsense' },
];
for (const b of GATED) {
  build();
  const r = await call({ ...b });
  ok(`401 unauthenticated: ${b.label}`, r.status === 401, show(r));
  ok(`  ${b.label} still sends Cache-Control: private, no-store`, r.headers['cache-control'] === 'private, no-store', JSON.stringify(r.headers));
}

// ── 2. owner-only branches 403 for admin, manager, crew ───────────────────────
const OWNER_ONLY = GATED.filter((b) => !['status', 'pnl', 'unknown subpath'].includes(b.label));
for (const b of OWNER_ONLY) {
  for (const who of ['admin', 'mgr', 'crew']) {
    build();
    const r = await call({ ...b, token: tok(who) });
    ok(`403 owner-only: ${b.label} as ${who}`, r.status === 403, show(r));
  }
}

// ── 3. status gate = integrations.view (owner + manager) ──────────────────────
for (const [who, want] of [['owner', 200], ['mgr', 200], ['admin', 403], ['crew', 403]]) {
  build();
  const r = await call({ method: 'GET', path: 'status', token: tok(who) });
  ok(`status: ${who} → ${want}`, r.status === want, show(r));
  if (want === 200) ok(`  status carries NO token material for ${who}`, !JSON.stringify(r.body).includes('SECRET_') && r.body.access_token_enc === undefined, show(r));
}

// ── 4. pnl gate = financials.view (owner + manager; a granted crew too) ───────
for (const [who, want] of [['owner', 200], ['mgr', 200], ['admin', 403], ['crew', 403]]) {
  build();
  const r = await call({ method: 'GET', path: 'pnl', token: tok(who), query: { range: 'd30' } });
  ok(`pnl: ${who} → ${want}`, r.status === want, show(r));
}
// crew granted financials.view via override → allowed, but scoped to nothing they supervise.
build({ overrides: [{ userId: 'u_crew_fin', grants: ['financials.view'], revokes: [] }] });
{
  const r = await call({ method: 'GET', path: 'pnl', token: tok('crewFin'), query: { range: 'd30' } });
  ok('pnl: a crew granted financials.view is allowed', r.status === 200, show(r));
  ok('🔴 pnl: a non-supervising holder gets ZERO rows (no data leak)', Array.isArray(r.body.accounts) && r.body.accounts.length === 0, show(r));
  ok('pnl: a scoped holder with no rows makes NO Intuit P&L call', pnlCalls === 0, `${pnlCalls} calls`);
}

// ── 5. scoping: owner sees all supervised realm links; a manager only their own ──
build();
{
  const r = await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'd30' } });
  ok('pnl owner → 200 connected', r.status === 200 && r.body.connected === true, show(r));
  const ids = r.body.accounts.map((a) => a.clientId).sort();
  // CS-565: the company links on ONE dimension. cl_3 is a CLASS link among customer links (made
  // before that rule), so it is left out of every book rather than counting money twice.
  ok('🔴 owner sees every realm_1 link on the company\'s dimension (cl_1, cl_2), never the other realm (cl_old)', ids.join(',') === 'cl_1,cl_2', ids.join(','));
  const c1 = r.body.accounts.find((a) => a.clientId === 'cl_1');
  ok('owner: cl_1 incomeCents parsed to integer cents', c1.incomeCents === 100000, JSON.stringify(c1));
  ok('owner: response records the report basis', r.body.basis === 'Accrual', show(r));
  ok('owner: ONE P&L call for the company\'s one dimension, not one per property', pnlCalls === 1, `${pnlCalls} calls`);
  ok('owner: response carries no token material', !JSON.stringify(r.body).includes('SECRET_'), show(r));
  ok('pnl sends Cache-Control: private, no-store', r.headers['cache-control'] === 'private, no-store');
}
build();
{
  const r = await call({ method: 'GET', path: 'pnl', token: tok('mgr'), query: { range: 'd30' } });
  const ids = r.body.accounts.map((a) => a.clientId).sort();
  ok('🔴 manager sees ONLY supervised properties on the company\'s dimension (cl_1), never cl_2', ids.join(',') === 'cl_1', ids.join(','));
  ok('🔴 manager response never contains the un-supervised property cl_2', !JSON.stringify(r.body).includes('cl_2'), show(r));
  ok('manager: cl_3 (a class link among customer links, CS-565) is left out of their book too', !r.body.accounts.some((a) => a.clientId === 'cl_3'), JSON.stringify(r.body.accounts));
}
// A manager supervising nothing → zero rows, zero Intuit calls.
build();
{
  const r = await call({ method: 'GET', path: 'pnl', token: tok('mgr2'), query: { range: 'd30' } });
  // mgr2 supervises cl_2 (customer 2) only.
  ok('mgr2 sees only cl_2', r.body.accounts.map((a) => a.clientId).join(',') === 'cl_2', show(r));
}

// ── 5b. F4 (CS-066): an id-less financials.view holder supervises NOTHING ────
// A holder whose resolved orgUserId is nullish must not match a null-supervisor property
// via `null === null`. ("Not set" is written as null by ServiceSetupCard.jsx:159.)
build();
{
  world.tables.org_state[0].state.clients.push({ id: 'cl_ns', name: 'Unassigned Plaza', supervisorId: null });
  world.tables.qbo_property_links.push({ organization_id: ORG, client_id: 'cl_ns', realm_id: 'realm_1', entity_type: 'customer', entity_id: '4', entity_name: 'Unassigned Plaza', linked_by: 'u_owner' });
  // A manager ROLE claim with NO org_user_id, whose email no roster row carries → authz
  // resolves orgUserId to null (claims.orgUserId || me?.id || null).
  world.logins.set('tok-ghost', { id: 'auth-ghost', email: 'ghost@nowhere.test', app_metadata: { role: 'manager', org_id: ORG } });
  const r = await call({ method: 'GET', path: 'pnl', token: 'tok-ghost', query: { range: 'd30' } });
  ok('F4: an id-less manager is still allowed by financials.view', r.status === 200, show(r));
  ok('🔴 F4: an id-less holder sees ZERO rows — never a null-supervisor property (null === null)', Array.isArray(r.body.accounts) && r.body.accounts.length === 0, show(r));
  ok('F4: an id-less holder triggers NO Intuit P&L call (nothing in scope)', pnlCalls === 0, `${pnlCalls} calls`);
}

// ── 5c. sub-customers: money goes to the nearest LINKED property, across ALL links ──
// Found on the live sandbox (2026-09-28): the "Total <parent>" roll-up repeats the parent's id,
// so looking a link up by id double-counted a sub-customer that is linked to another property.
build();
{
  world.tables.org_state[0].state.clients.push({ id: 'cl_hg', name: 'Harbor Group HQ', supervisorId: 'u_mgr' });
  world.tables.qbo_property_links.push({ organization_id: ORG, client_id: 'cl_hg', realm_id: 'realm_1', entity_type: 'customer', entity_id: '9', entity_name: 'Harbor Group', linked_by: 'u_owner' });
  // mgr supervises cl_hg (parent 9); Brickell (sub-customer 2) is linked to cl_2, which mgr2 supervises.
  const r = await call({ method: 'GET', path: 'pnl', token: tok('mgr'), query: { range: 'd30' } });
  const hg = r.body.accounts.find((a) => a.clientId === 'cl_hg');
  ok('🔴 a parent whose sub-customer is linked to ANOTHER property gets only its own amounts (no double count)', hg && hg.incomeCents === 5000, JSON.stringify(hg));
  const o = await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'd30' } });
  const c2 = o.body.accounts.find((a) => a.clientId === 'cl_2');
  ok('the sub-customer\'s own property keeps its amounts', c2 && c2.incomeCents === 200000, JSON.stringify(c2));
}
build();
{
  world.tables.qbo_property_links = world.tables.qbo_property_links.filter((l) => l.client_id !== 'cl_2');
  world.tables.org_state[0].state.clients.push({ id: 'cl_hg', name: 'Harbor Group HQ', supervisorId: 'u_mgr' });
  world.tables.qbo_property_links.push({ organization_id: ORG, client_id: 'cl_hg', realm_id: 'realm_1', entity_type: 'customer', entity_id: '9', entity_name: 'Harbor Group', linked_by: 'u_owner' });
  const r = await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'd30' } });
  const hg = r.body.accounts.find((a) => a.clientId === 'cl_hg');
  ok('a parent linked on its own covers its whole subtree (own + unlinked sub-customers)', hg && hg.incomeCents === 205000, JSON.stringify(hg));
}

// ── 5d. the P&L cache: keyed on the parser's shape version too (THE LAW II.7: full inputs) ──
// A payload cached by an older parser (here: the pre-roll-up shape, under the unversioned key)
// must never be served; a repeat call inside the TTL still hits the cache.
build();
{
  const { start, end } = resolveRange('d30', { tz: 'America/Los_Angeles' });
  world.tables.qbo_report_cache.push({
    organization_id: ORG, cache_key: `pnl:sandbox:realm_1:customer:d30:${start}:${end}`, fetched_at: new Date().toISOString(),
    payload: { basis: 'Accrual', entities: [{ entityId: '1', entityName: 'Ball Harbor', incomeCents: 999 }], unassigned: {}, total: {} },
  });
  const r = await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'd30' } });
  const c1 = r.body.accounts.find((a) => a.clientId === 'cl_1');
  ok('🔴 a payload cached under an older parser\'s key is never served', c1 && c1.incomeCents === 100000 && pnlCalls === 1, `${JSON.stringify(c1)} · ${pnlCalls} Intuit calls`);
  const again = await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'd30' } });
  ok('a repeat call inside the TTL is served from the cache (no new Intuit call)', again.status === 200 && pnlCalls === 1, `${pnlCalls} Intuit calls`);
}

// pnl invalid range → 400; not connected → { connected:false } 200.
build();
ok('pnl bad range → 400', (await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'week' } })).status === 400);
build({ connected: false });
{
  const r = await call({ method: 'GET', path: 'pnl', token: tok('owner'), query: { range: 'd30' } });
  ok('pnl not connected → 200 { connected:false }', r.status === 200 && r.body.connected === false, show(r));
}

// ── 6. links PUT validation (strict body, known client, entity enum) ──────────
build();
ok('PUT links: unknown body key → 400', (await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_1', entityType: 'customer', entityId: '1', evil: 1 } })).status === 400);
ok('PUT links: unknown property (client) → 400', (await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'nope', entityType: 'customer', entityId: '1' } })).status === 400);
ok('PUT links: bad entityType → 400', (await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_1', entityType: 'vendor', entityId: '1' } })).status === 400);
{
  const r = await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_1', entityType: 'customer', entityId: '7', entityName: 'New' } });
  ok('PUT links: valid link → 200', r.status === 200 && r.body.ok === true, show(r));
  const link = world.tables.qbo_property_links.find((l) => l.client_id === 'cl_1');
  ok('  the link is stored on the connected realm with allowlisted fields only', link.realm_id === 'realm_1' && link.entity_id === '7' && link.evil === undefined, JSON.stringify(link));
}
// One QuickBooks entity belongs to ONE property: a second property linked to the same entity
// would show the same money twice and the dashboard's book total would count it twice.
build();
{
  const r = await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_1', entityType: 'customer', entityId: '2', entityName: 'Brickell' } });
  ok('🔴 PUT links: an entity already linked to ANOTHER property → 409 entity_already_linked', r.status === 409 && r.body.code === 'entity_already_linked', show(r));
  ok('🔴   the refused PUT left the existing links untouched', world.tables.qbo_property_links.find((l) => l.client_id === 'cl_1')?.entity_id === '1'
    && world.tables.qbo_property_links.filter((l) => l.entity_type === 'customer' && l.entity_id === '2').length === 1, JSON.stringify(world.tables.qbo_property_links));
  ok('  the 409 names the property holding the entity (so the owner knows where to unlink)', typeof r.body.error === 'string' && r.body.error.includes('Brickell Bay Offices'), show(r));
  const same = await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_2', entityType: 'customer', entityId: '2', entityName: 'Brickell' } });
  ok('PUT links: re-saving a property\'s OWN link → 200 (idempotent)', same.status === 200, show(same));
  const otherType = await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_1', entityType: 'class', entityId: '2', entityName: 'Class 2' } });
  // The same id in another dimension is a DIFFERENT entity (never entity_already_linked), but the
  // company links on ONE dimension (CS-565), so a class link among customer links is refused.
  ok('PUT links: the same id in ANOTHER dimension is not "already linked" — it is the dimension rule that refuses it',
    otherType.status === 409 && otherType.body.code === 'dimension_mismatch', show(otherType));
  const otherRealm = await call({ method: 'PUT', path: 'links', token: tok('owner'), body: { clientId: 'cl_3', entityType: 'customer', entityId: '9', entityName: 'Harbor Group' } });
  ok('PUT links: an entity linked only on ANOTHER realm does not block → 200', otherRealm.status === 200, show(otherRealm));
}

// ── 7. entities (owner): active + inactive flagged, cached ───────────────────
build();
{
  const r = await call({ method: 'GET', path: 'entities', token: tok('owner'), query: { type: 'customer' } });
  ok('entities: owner → 200 with entities', r.status === 200 && r.body.entities.length === 2, show(r));
  ok('entities: inactive is flagged', r.body.entities.find((e) => e.id === '2').active === false, show(r));
  ok('entities: bad type → 400', (await call({ method: 'GET', path: 'entities', token: tok('owner'), query: { type: 'vendor' } })).status === 400);
}

// ── 8. unknown subpath: 401 anonymous, 404 authenticated ─────────────────────
build();
ok('unknown subpath authenticated → 404', (await call({ method: 'GET', path: 'nope/deeper', token: tok('owner') })).status === 404);

// ── 9. not_configured when a QBO env var is missing ──────────────────────────
build();
{
  const saved = process.env.QBO_ENVIRONMENT;
  delete process.env.QBO_ENVIRONMENT;
  const r = await call({ method: 'GET', path: 'oauth/start', token: tok('owner') });
  ok('🔴 oauth/start → 503 not_configured when env is missing', r.status === 503 && r.body.code === 'not_configured', show(r));
  process.env.QBO_ENVIRONMENT = saved;
}

// ── 10. oauth/start mints a signed, single-use state ─────────────────────────
build();
let mintedState = null;
{
  const r = await call({ method: 'GET', path: 'oauth/start', token: tok('owner') });
  ok('oauth/start owner → 200 { url }', r.status === 200 && typeof r.body.url === 'string' && r.body.url.includes('appcenter.intuit.com'), show(r));
  ok('oauth/start requests only the accounting scope', /scope=com\.intuit\.quickbooks\.accounting/.test(r.body.url), r.body.url);
  mintedState = new URL(r.body.url).searchParams.get('state');
  ok('oauth/start stored a single-use nonce', world.tables.qbo_oauth_states.length === 1, `${world.tables.qbo_oauth_states.length} states`);
}

// ── 11. callback: exchanges the code ONCE, saves, and rejects a replay ───────
{
  const r = await call({ method: 'GET', path: 'oauth/callback', query: { code: 'the_code', state: mintedState, realmId: 'realm_1' } });
  ok('callback happy path → 200 HTML', r.status === 200 && typeof r.body === 'string' && r.body.includes('connect-qbo'), typeof r.body === 'string' ? r.body.slice(0, 120) : show(r));
  ok('🔴 callback posts ok:true to the app ORIGIN, never "*"', r.body.includes('"ok":true') && r.body.includes('https://cleanspace-gilt.vercel.app') && !r.body.includes(", '*'"), r.body.slice(0, 200));
  ok('🔴 callback exchanged the code EXACTLY once', tokenCalls === 1, `${tokenCalls} calls`);
  ok('callback saved the connection (sandbox / realm_1 / company name)', conn() && conn().environment === 'sandbox' && conn().realm_id === 'realm_1' && conn().company_name === 'CleanSpace Sandbox', JSON.stringify(conn()));
  ok('🔴 callback HTML leaks no token material', !r.body.includes('AT_NEW') && !r.body.includes('RT_NEW'), r.body.slice(0, 200));
  ok('callback response is private, no-store', r.headers['cache-control'] === 'private, no-store');
}
{
  const r = await call({ method: 'GET', path: 'oauth/callback', query: { code: 'the_code', state: mintedState, realmId: 'realm_1' } });
  ok('🔴 callback REPLAY of a consumed state is rejected (state_used)', r.body.includes('"error":"state_used"'), r.body.slice(0, 200));
  ok('replayed callback did NOT exchange again', tokenCalls === 1, `${tokenCalls} calls`);
}

// ── 11b. F2 (CS-066): a malformed token-exchange response must NOT save a connection ──
build({ connected: false });
{
  const r0 = await call({ method: 'GET', path: 'oauth/start', token: tok('owner') });
  const st = new URL(r0.body.url).searchParams.get('state');
  tokenResponder = () => jsonRes(true, 200, {}); // empty 200 — no access_token / refresh_token
  const r = await call({ method: 'GET', path: 'oauth/callback', query: { code: 'the_code', state: st, realmId: 'realm_1' } });
  tokenResponder = () => jsonRes(true, 200, validTokenBody());
  ok('🔴 F2: a malformed exchange response yields token_exchange_failed (never stores "undefined")', typeof r.body === 'string' && r.body.includes('"error":"token_exchange_failed"'), typeof r.body === 'string' ? r.body.slice(0, 200) : show(r));
  ok('🔴 F2: NO connection is saved on a malformed exchange (previous state kept)', conn() === null, JSON.stringify(conn()));
}

// ── 12. callback rejects a forged and an expired state ───────────────────────
build({ connected: false });
{
  // signed with the DEFAULT (inbox) key, not the QBO key → verifyState under the QBO key fails.
  const forged = signState({ t: 'qbo', ts: Date.now(), nonce: 'x', by: 'u_owner' });
  const r = await call({ method: 'GET', path: 'oauth/callback', query: { code: 'c', state: forged, realmId: 'realm_1' } });
  ok('🔴 callback rejects a state signed with the wrong key (state_invalid)', r.body.includes('"error":"state_invalid"'), r.body.slice(0, 200));
  ok('forged callback saved no connection', conn() === null);
}
build();
{
  const expired = signState({ t: 'qbo', ts: Date.now() - 20 * 60 * 1000, nonce: 'x', by: 'u_owner' }, KEY_ENV);
  const r = await call({ method: 'GET', path: 'oauth/callback', query: { code: 'c', state: expired, realmId: 'realm_1' } });
  ok('🔴 callback rejects an expired state (state_invalid)', r.body.includes('"error":"state_invalid"'), r.body.slice(0, 200));
}

console.log(`\nqbo-route: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
