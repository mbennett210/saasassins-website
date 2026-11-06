// qbo-harness.mjs — the shared OFFLINE rig for the QuickBooks route suites (Wave 3: accrual,
// one dimension per company, the nightly refresh, the needs-matching list, the redirect
// address). NOT a test file (no `test-` prefix), so run-tests.mjs neither runs nor scans it.
//
// It does what test-qbo-route.mjs does inline, once: sets the env BEFORE anything under api/
// is imported, installs fake-supabase.mjs (the real handlers, stores and authz run against an
// in-memory PostgREST stand-in), and stubs `fetch` at Intuit's boundary with a programmable
// router that LOGS every URL. Nothing here reaches the network: SUPABASE_URL points at a
// closed port and an unknown URL throws.
//
//   import { rig } from './qbo-harness.mjs';
//   const r = await rig();                       // handlers loaded, world empty
//   r.build({ links: [...], entities: [...] });  // a fresh world
//   const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
//   r.intuitLog                                  // every Intuit URL this world saw
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';

export const ORG = '00000000-0000-0000-0000-000000000001';
export const KEY_ENV = 'QBO_TOKEN_ENCRYPTION_KEY';
export const REDIRECT_GILT = 'https://cleanspace-gilt.vercel.app/api/quickbooks/oauth/callback';
export const REDIRECT_CORNER = 'https://www.cleancorner.app/api/quickbooks/oauth/callback';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.QBO_CLIENT_ID = 'qbo-client';
process.env.QBO_CLIENT_SECRET = 'qbo-secret';
process.env.QBO_ENVIRONMENT = 'sandbox';
process.env.QBO_REDIRECT_URI = REDIRECT_GILT;
process.env.QBO_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.INBOX_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.CRON_SECRET = 'cron-secret-for-tests';

// ── an Intuit-shaped ProfitAndLoss, built from columns ────────────────────────
// Every column carries MetaData ColKey, as the live sandbox showed (2026-09-28): 'account',
// an entity id, 'not_specified' or 'total'. `cols` are { key, title, income, cogs } in DOLLARS
// (strings, the way Intuit sends them); a roll-up column is just a column whose key repeats.
export function pnlReport({ cols = [], notSpecified = { income: '0.00', cogs: '0.00' }, basis = 'Accrual' } = {}) {
  const meta = (title, key, type = 'Money') => ({ ColTitle: title, ColType: type, MetaData: [{ Name: 'ColKey', Value: key }] });
  const sum = (field) => {
    const own = cols.filter((c, i) => cols.findIndex((x) => x.key === c.key) === i); // roll-ups excluded
    const cents = own.reduce((s, c) => s + Math.round(Number(c[field] || 0) * 100), 0) + Math.round(Number(notSpecified[field] || 0) * 100);
    return (cents / 100).toFixed(2);
  };
  const cell = (v) => ({ value: v });
  const rowOf = (field, label) => [cell(label), ...cols.map((c) => cell(c[field] ?? '')), cell(notSpecified[field] ?? ''), cell(sum(field))];
  const gp = (c) => (Math.round(Number(c.income || 0) * 100 - Number(c.cogs || 0) * 100) / 100).toFixed(2);
  const nsGp = (Math.round(Number(notSpecified.income || 0) * 100 - Number(notSpecified.cogs || 0) * 100) / 100).toFixed(2);
  const totalGp = (Math.round(Number(sum('income')) * 100 - Number(sum('cogs')) * 100) / 100).toFixed(2);
  return {
    Header: { ReportBasis: basis, Option: [{ Name: 'NoReportData', Value: cols.length ? 'false' : 'true' }] },
    Columns: { Column: [meta('', 'account', 'Account'), ...cols.map((c) => meta(c.title || c.key, c.key)), meta('Not Specified', 'not_specified'), meta('TOTAL', 'total')] },
    Rows: {
      Row: [
        { group: 'Income', Summary: { ColData: rowOf('income', 'Total Income') } },
        { group: 'COGS', Summary: { ColData: rowOf('cogs', 'Total Cost of Goods Sold') } },
        { group: 'GrossProfit', ColData: [cell('Gross Profit'), ...cols.map((c) => cell(gp(c))), cell(nsGp), cell(totalGp)] },
      ],
    },
  };
}

// ── the rig ──────────────────────────────────────────────────────────────────
let loaded = null;

export async function rig() {
  if (loaded) return loaded;
  const intuitLog = [];
  // The programmable Intuit. `responders` are tried in order; each returns a response object
  // (or undefined to pass). Tests push their own in front of the defaults.
  const state = {
    tokenBody: () => ({ access_token: 'AT_NEW', expires_in: 3600, refresh_token: 'RT_NEW', x_refresh_token_expires_in: 8640000 }),
    entities: { customer: [], class: [], department: [] },
    // (url: URL) → an Intuit report JSON. Default: an empty report.
    pnl: () => pnlReport({ cols: [] }),
    fail: null, // (url) → { status, body } to answer an Intuit call with an error
  };
  const jsonRes = (ok, status, body, headers = {}) => ({
    ok, status, headers: { get: (k) => headers[k.toLowerCase()] ?? (k.toLowerCase() === 'intuit_tid' ? 'tid_test' : null) }, json: async () => body,
  });
  const QBO_ENTITY = { Customer: 'customer', Class: 'class', Department: 'department' };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    intuitLog.push({ url: u, method: init.method || 'GET', body: init.body != null ? String(init.body) : null });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    if (state.fail) {
      const f = state.fail(u);
      if (f) {
        if (f.throw) throw Object.assign(new Error(f.throw), { name: f.throw });
        return jsonRes(false, f.status, f.body || {});
      }
    }
    if (u.origin === 'https://oauth.platform.intuit.com') return jsonRes(true, 200, state.tokenBody());
    if (u.pathname.includes('/tokens/revoke')) return jsonRes(true, 200, {});
    if (u.pathname.includes('/companyinfo/')) return jsonRes(true, 200, { CompanyInfo: { CompanyName: 'CleanSpace Sandbox' } });
    if (u.pathname.endsWith('/reports/ProfitAndLoss')) return jsonRes(true, 200, state.pnl(u));
    if (u.pathname.endsWith('/query')) {
      const q = u.searchParams.get('query') || '';
      const m = /from\s+(\w+)/i.exec(q);
      const entity = m ? m[1] : '';
      const rows = state.entities[QBO_ENTITY[entity]] || [];
      if (/count\(\*\)/i.test(q)) return jsonRes(true, 200, { QueryResponse: { totalCount: rows.length } });
      const start = Number((/startposition\s+(\d+)/i.exec(q) || [])[1] || 1);
      const max = Number((/maxresults\s+(\d+)/i.exec(q) || [])[1] || 1000);
      const page = rows.slice(start - 1, start - 1 + max);
      return jsonRes(true, 200, { QueryResponse: page.length ? { [entity]: page, startPosition: start, maxResults: page.length } : {} });
    }
    throw new Error(`network blocked in this suite (${u})`);
  };

  installFakeSupabase();
  const crypt = await import('../api/_lib/crypto.js');
  const handler = (await import('../api/quickbooks/[...path].js')).default;

  const PEOPLE = {
    owner: { id: 'u_owner', role: 'owner', claim: true },
    admin: { id: 'u_admin', role: 'admin', claim: true },
    mgr: { id: 'u_mgr', role: 'manager', claim: false },
    mgr2: { id: 'u_mgr2', role: 'manager', claim: false },
    crew: { id: 'u_crew', role: 'crew', claim: true },
  };
  const emailOf = (k) => `${k.toLowerCase()}@example.test`;
  const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: `${k[0].toUpperCase()}${k.slice(1)} Person` }));
  const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, { id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} }]));
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const connRow = (over = {}) => ({
    organization_id: ORG, environment: 'sandbox', realm_id: 'realm_1', company_name: 'CleanSpace Sandbox',
    access_token_enc: crypt.encrypt('SECRET_AT', KEY_ENV), access_token_expires_at: iso(3600e3),
    refresh_token_enc: crypt.encrypt('SECRET_RT', KEY_ENV), refresh_token_expires_at: iso(80 * 86400e3), refresh_token_hard_expires_at: null,
    token_version: 3, refresh_lease_until: null, status: 'active', last_error: null, connected_by: 'u_owner', connected_at: iso(-86400e3), last_synced_at: null,
    ...over,
  });
  const linkRow = (clientId, entityType, entityId, entityName = null, realm = 'realm_1') => ({
    organization_id: ORG, client_id: clientId, realm_id: realm, entity_type: entityType, entity_id: String(entityId), entity_name: entityName, linked_by: 'u_owner',
  });

  function build({ connected = true, conn = {}, links = [], clients = null, entities = null, timezone = 'America/New_York', cache = [] } = {}) {
    intuitLog.length = 0;
    state.fail = null;
    if (entities) state.entities = { customer: [], class: [], department: [], ...entities };
    const state0 = {
      users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
      clients: clients || [
        { id: 'cl_1', name: 'Ball Harbor Village', supervisorId: 'u_mgr' },
        { id: 'cl_2', name: 'Brickell Bay Offices', supervisorId: 'u_mgr2' },
        { id: 'cl_3', name: 'Las Olas Medical', supervisorId: 'u_mgr' },
      ],
      company: { timezone },
    };
    resetWorld({
      tables: {
        org_state: [{ organization_id: ORG, state: state0, version: 4 }],
        qbo_connection: connected ? [connRow(conn)] : [],
        qbo_property_links: links,
        qbo_report_cache: cache.map((c) => ({ organization_id: ORG, ...c })),
        qbo_oauth_states: [],
      },
      logins,
    });
  }

  // A request through a handler (the QuickBooks catch-all by default).
  async function call({ method = 'GET', path, token, body, query = {}, headers = {}, using = handler, raw = false }) {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
    req.method = method;
    req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    req.query = raw ? { ...query } : { ...query, subpath: path };
    req.body = body;
    const out = {};
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    const logged = [];
    console.log = console.warn = () => {};
    console.error = (...a) => { logged.push(a.map(String).join(' ')); };
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 15000);
        const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers: out, logged }); };
        const res = {
          statusCode: 200,
          setHeader(k, v) { out[k.toLowerCase()] = v; return this; },
          status(c) { this.statusCode = c; return this; },
          json(b) { done(this.statusCode, b); return this; },
          send(b) { done(this.statusCode, b); return this; },
          end(b) { done(this.statusCode, b ?? null); return this; },
        };
        Promise.resolve(using(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
      });
    } finally { Object.assign(console, quiet); }
  }

  const pnlUrls = () => intuitLog.filter((e) => e.url.pathname.endsWith('/reports/ProfitAndLoss')).map((e) => e.url);
  const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;

  loaded = { handler, call, build, world, intuitLog, intuit: state, pnlUrls, show, crypt, connRow, linkRow, roster, iso };
  return loaded;
}

// The plain `ok(label, cond, detail)` every Wave 3 suite uses (CONDITION second).
export function counter(name) {
  let pass = 0;
  const fails = [];
  const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
  const finish = () => {
    console.log(`\n${name}: ${pass}/${pass + fails.length} passed`);
    if (fails.length) {
      for (const f of fails) console.error(`  FAIL ${f}`);
      process.exitCode = 1;
    }
  };
  return { ok, finish, get failed() { return fails.length; } };
}
