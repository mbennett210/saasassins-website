// The Quality hub's three inspection reads, driven through the REAL route handler
// (api/qc/[...path].js) and the real supabase-js, against a local fake GoTrue + PostgREST
// (an HTTP server over scripts/fake-postgrest.mjs, db-max-rows 1000). test-hub-inspections
// pins the store and the wiring by shape; this proves the HTTP layer end to end: the auth
// gates (qc.view, qc.share on the export, crew scope from crew_assignments), the strict
// query-string parsing (400s), the JSON-path export column through a real PostgREST URL,
// and the paged export read through lib/pagedFetch.js exactly as the browser reads it.
// Offline: nothing leaves 127.0.0.1.
//   node app/scripts/test-hub-inspections-route.mjs
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeDb } from './fake-postgrest.mjs';
import { installResolveShim } from './deletion-core.mjs';

installResolveShim(); // Vite writes extensionless imports; plain node needs `.js`
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = '00000000-0000-0000-0000-000000000001'; // the default org id (_lib/constants.js, _lib/orgState.js)

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

// ── data: 450 inspections; the org's newest 200 are all c_busy's ─────────────────
const BASE = Date.parse('2026-01-05T15:00:00.000Z');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const rec = (site, client, t, extra = {}) => {
  seq += 1;
  return {
    id: `in_${String(seq).padStart(5, '0')}`, organization_id: ORG, public_token: `tok_${seq}`,
    client_id: client, site_id: site, client_name: `Customer ${client}`, site_name: `Site ${site}`,
    inspector_user_id: 'u_mgr', inspector_name: 'Manager', overall_score: 90, result: 'pass', status: 'submitted',
    performed_at: iso(t), template_snapshot: { name: `Walkthrough ${site}`, schema: { areas: [] } }, ...extra,
  };
};
const ROWS = [];
for (let i = 0; i < 50; i += 1) ROWS.push(rec('s_old', 'c_old', BASE + i * 60 * MIN, i % 5 === 0 ? { result: 'fail', overall_score: 60 } : {}));
for (let i = 0; i < 100; i += 1) ROWS.push(rec(i % 2 ? 's_crew' : 's_other', 'c_mid', BASE + 10 * 1440 * MIN + i * 60 * MIN, i % 4 === 0 ? { inspector_user_id: 'u_crew', result: 'fail', overall_score: 55 } : {}));
for (let i = 0; i < 300; i += 1) ROWS.push(rec('s_busy', 'c_busy', BASE + 90 * 1440 * MIN + i * 30 * MIN));

const USERS = {
  tok_owner: { id: 'auth_owner', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  tok_crew: { id: 'auth_crew', email: 'crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
};
const db = fakeDb({
  inspection_records: ROWS,
  org_state: [{ organization_id: ORG, version: 1, state: { users: [], clients: [], sites: [{ id: 's_crew', clientId: 'c_mid' }, { id: 's_other', clientId: 'c_mid' }] } }],
  crew_assignments: [{ organization_id: ORG, user_id: 'u_crew', site_id: 's_crew', client_id: null }],
}, { maxRows: 1000 });

// ── the fake: GoTrue's GET /auth/v1/user + PostgREST over the in-memory engine ────
const seen = [];
function applyParam(q, key, raw) {
  if (key === 'or') return q.or(raw.replace(/^\(|\)$/g, ''));
  const dot = raw.indexOf('.');
  let op = raw.slice(0, dot);
  let val = raw.slice(dot + 1);
  if (op === 'not' && val === 'is.null') return q.not(key, 'is', null);
  if (op === 'in') return q.in(key, val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')));
  if (op === 'is') return q.is(key, val === 'null' ? null : val);
  if (!['eq', 'neq', 'gte', 'lte', 'gt', 'lt'].includes(op)) throw new Error(`fake: op ${op} unsupported`);
  return q[op](key, val);
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (u.pathname === '/auth/v1/user') {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const user = USERS[token];
    return user ? send(200, { aud: 'authenticated', role: 'authenticated', ...user }) : send(401, { msg: 'invalid JWT' });
  }
  const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (!m) return send(404, { message: 'no route' });
  seen.push(`${req.method} ${m[1]}?${u.searchParams.toString()}`);
  const counted = /count=exact/.test(String(req.headers.prefer || ''));
  const head = req.method === 'HEAD';
  try {
    let q = db.from(m[1]).select(u.searchParams.get('select') || '*', counted ? { count: 'exact', head } : {});
    for (const [key, raw] of u.searchParams) {
      if (['select', 'offset', 'limit', 'order'].includes(key)) continue;
      q = applyParam(q, key, raw);
    }
    for (const part of (u.searchParams.get('order') || '').split(',').filter(Boolean)) {
      const [col, dir] = part.split('.');
      q = q.order(col, { ascending: dir !== 'desc' });
    }
    const offset = Number(u.searchParams.get('offset') || 0);
    if (u.searchParams.has('limit')) q = q.range(offset, offset + Number(u.searchParams.get('limit')) - 1);
    const r = await q;
    if (r.error) return send(400, r.error);
    const headers = counted ? { 'Content-Range': head ? `*/${r.count}` : `${offset}-${offset + r.data.length - 1}/${r.count}` } : {};
    return head ? send(200, undefined, headers) : send(200, r.data, headers);
  } catch (e) {
    return send(400, { message: e.message });
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const { default: handler } = await import(pathToFileURL(path.join(APP, 'api', 'qc', '[...path].js')).href);
const { fetchAllPages } = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'pagedFetch.js')).href);

// One call through the handler, as Vercel's rewrite delivers it (?subpath=…).
function call(subpath, query = {}, token = 'tok_owner') {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      send(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    const req = { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath, ...query }, body: {} };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 'threw', body: { error: e.message } }));
  });
}

// ── the truth, from the data ─────────────────────────────────────────────────────
const newestFirst = (a, b) => (Date.parse(b.performed_at) - Date.parse(a.performed_at)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const truth = (pred) => ROWS.filter(pred).sort(newestFirst);
const ids = (rows) => (Array.isArray(rows) ? rows.map((r) => r.id) : []);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

try {
  // The list: filters run in the query.
  const org = await call('inspections/list');
  ok(org.status === 200 && ids(org.body.inspections).length === 200 && org.body.truncated === true
    && org.body.inspections.every((r) => r.client_id === 'c_busy'),
  `R1: no filter → the org's newest 200, truncated (all c_busy) [${org.status}]`);
  const old = await call('inspections/list', { siteIds: 's_old', results: 'fail' });
  ok(old.status === 200 && same(ids(old.body.inspections), ids(truth((r) => r.site_id === 's_old' && r.result === 'fail'))) && old.body.truncated === false,
    `R2: ?siteIds&results through the real query string → every old failed inspection, not truncated [${old.status}]`);
  const win = await call('inspections/list', { fromIso: iso(BASE), toIso: iso(BASE + 30 * 60 * MIN), inspectorIds: 'u_mgr' });
  ok(win.status === 200 && same(ids(win.body.inspections), ids(truth((r) => r.inspector_user_id === 'u_mgr' && Date.parse(r.performed_at) <= BASE + 30 * 60 * MIN))),
    `R3: ?fromIso&toIso&inspectorIds → the window's rows [${win.status}]`);

  // The figures: every match.
  const fig = await call('inspections/figures');
  ok(fig.status === 200 && fig.body.figures?.total === ROWS.length && fig.body.figures?.failCount === ROWS.filter((r) => r.result === 'fail').length,
    `R4: figures tally all ${ROWS.length}, not the list's 200 [${fig.status} total ${fig.body.figures?.total}]`);

  // The export: every page, as the browser reads it; the JSON-path column is real.
  const pages = [];
  let exported = [];
  let exportError = null;
  try {
    exported = await fetchAllPages({
      backoffMs: 1,
      pageSize: 120,
      fetchPage: async (offset, limit) => {
        const r = await call('inspections/export', { siteIds: 's_old,s_busy', offset: String(offset), limit: String(limit) });
        if (r.status !== 200) { const e = new Error(r.body?.error || `status ${r.status}`); e.status = r.status; throw e; }
        pages.push({ offset, total: r.body.total, n: r.body.inspections.length });
        return { rows: r.body.inspections, total: r.body.total, limit: r.body.limit };
      },
    });
  } catch (e) { exportError = e; }
  const expTruth = truth((r) => r.site_id === 's_old' || r.site_id === 's_busy');
  ok(!exportError && same(ids(exported), ids(expTruth)) && exported.every((r) => r.template_name === `Walkthrough ${r.site_id}` && !('template_snapshot' in r) && !('public_token' in r)),
    `R5: the paged export returns all ${expTruth.length} matches once each, newest first, template_name out of the snapshot, no snapshot or token [${exported.length} rows over ${pages.length} pages${exportError ? `; threw ${exportError.message}` : ''}]`);
  ok(pages.length > 3 && pages[0].total === expTruth.length && pages.slice(1).every((p) => p.total === null),
    'R6: only the first page carries the total (count-first), the rest are plain pages');
  ok(seen.some((s) => s.startsWith('GET inspection_records?select=') && s.includes('template_name%3Atemplate_snapshot-%3E%3Ename')),
    'R7: the export page went to PostgREST with the JSON-path column (template_name:template_snapshot->>name)');
  const big = await call('inspections/export', { limit: '999999' });
  ok(big.status === 200 && big.body.limit === 2000 && big.body.inspections.length === Math.min(2000, ROWS.length),
    `R8: a page is clamped to 2,000 rows however many are asked for [limit ${big.body.limit}]`);

  // Crew: scoped everywhere, and no export (qc.share).
  const crewScope = (r) => r.site_id === 's_crew' || r.inspector_user_id === 'u_crew';
  const cl = await call('inspections/list', {}, 'tok_crew');
  ok(cl.status === 200 && same(ids(cl.body.inspections), ids(truth(crewScope))),
    `R9: crew list = their assigned site + their own inspections only [${cl.status} ${ids(cl.body.inspections).length}]`);
  const cOld = await call('inspections/list', { siteIds: 's_old' }, 'tok_crew');
  ok(cOld.status === 200 && ids(cOld.body.inspections).length === 0, 'R10: a crew filter to a site outside their scope reads nothing (narrows, never widens)');
  const cf = await call('inspections/figures', {}, 'tok_crew');
  ok(cf.status === 200 && cf.body.figures?.total === truth(crewScope).length, `R11: crew figures tally only their scope [${cf.body.figures?.total}]`);
  const ce = await call('inspections/export', {}, 'tok_crew');
  ok(ce.status === 403, `R12: crew (no qc.share) cannot export [${ce.status}]`);
  const anon = await call('inspections/list', {}, null);
  ok(anon.status === 401, `R13: no session → 401 [${anon.status}]`);

  // Malformed input is a 400 before any query runs.
  const bad = [
    ['siteIds', 'x),client_id.in.(c_busy'], ['inspectorIds', 'u_1,u 2'], ['results', 'pass,maybe'],
    ['fromIso', '1'], ['toIso', '2026-02-31T00:00:00Z'], ['siteId', 's_old'], ['clientId', 'c)x'],
  ];
  for (const [k, v] of bad) {
    const r = await call('inspections/list', { [k]: v });
    ok(r.status === 400, `R14: ?${k}=${v} → 400 [${r.status} ${r.body?.error || ''}]`);
  }
  const back = await call('inspections/figures', { fromIso: iso(BASE + MIN), toIso: iso(BASE) });
  ok(back.status === 400, `R15: a backward range → 400 [${back.status}]`);
  const many = await call('inspections/list', { siteIds: Array.from({ length: 201 }, (_, i) => `s_${i}`).join(',') });
  ok(many.status === 400, `R16: 201 site ids → 400 [${many.status}]`);
  const rep = await call('reports/inspections-by-site', { fromIso: iso(BASE), toIso: iso(BASE + 200 * 1440 * MIN), result: 'maybe' });
  ok(rep.status === 400, `R17: Reports ?result outside the vocabulary → 400, not all results [${rep.status}]`);
  const repOk = await call('reports/inspections-by-site', { fromIso: iso(BASE), toIso: iso(BASE + 200 * 1440 * MIN), result: 'fail' });
  ok(repOk.status === 200 && repOk.body.recordCount === ROWS.filter((r) => r.result === 'fail').length,
    `R18: Reports ?result=fail tallies every failed inspection through the shared filter [${repOk.status} ${repOk.body?.recordCount}]`);

  // ── The share token is a bearer capability: only a caller who may SHARE receives it ──
  // (owner holds qc.share; crew hold qc.view but not qc.share). The list, get and report
  // reads all carry public_token / publicToken for a sharer and strip it for a reader.
  const ownerRec = ROWS[0];                                   // c_old / s_old — owner sees all
  const crewRec = ROWS.find((r) => r.site_id === 's_crew');   // in crew's assigned scope

  // The list also narrowed off `select *`: the fat template_snapshot is gone and the name
  // arrives as template_name (template_snapshot->>name), and the token is present for owner.
  ok(org.body.inspections.length > 0
    && org.body.inspections.every((r) => typeof r.public_token === 'string' && r.public_token
      && !('template_snapshot' in r) && r.template_name === `Walkthrough ${r.site_id}`),
  'R19: owner list carries public_token and template_name, and no longer ships the template_snapshot blob');
  ok(seen.some((s) => s.startsWith('GET inspection_records?select=') && s.includes('template_name%3Atemplate_snapshot-%3E%3Ename') && s.includes('public_token') && !s.includes('select=*')),
    'R19b: the list read went to PostgREST with explicit columns (the JSON-path name + public_token), never select=*');
  ok(cl.body.inspections.length > 0 && cl.body.inspections.every((r) => !('public_token' in r) && r.template_name != null && r.id),
    'R20: crew list drops public_token (they can read their inspections but not harvest share links), keeping the fields the tab renders');

  const gOwner = await call('inspections/get', { id: ownerRec.id });
  ok(gOwner.status === 200 && gOwner.body.inspection?.public_token, `R21: owner inspections/get carries public_token [${gOwner.status}]`);
  const gCrew = await call('inspections/get', { id: crewRec.id }, 'tok_crew');
  ok(gCrew.status === 200 && gCrew.body.inspection && !('public_token' in gCrew.body.inspection),
    `R22: crew inspections/get (a record in scope) reads it WITHOUT public_token [${gCrew.status}]`);

  const rOwner = await call('inspections/report', { id: ownerRec.id });
  ok(rOwner.status === 200 && rOwner.body.inspection?.publicToken, `R23: owner inspections/report carries publicToken [${rOwner.status}]`);
  const rCrew = await call('inspections/report', { id: crewRec.id }, 'tok_crew');
  ok(rCrew.status === 200 && rCrew.body.inspection && !('publicToken' in rCrew.body.inspection),
    `R24: crew inspections/report (a record in scope) reads it WITHOUT publicToken [${rCrew.status}]`);
} catch (e) {
  ok(false, `the drive threw: ${e.message}`); // a failed assertion with its message, not a crashed process
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\ntest-hub-inspections-route: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
