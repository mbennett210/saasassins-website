// CS-726 · CS-727 · CS-335 — three lists that showed part of the company and said nothing.
//
// PostgREST answers at most db-max-rows rows (Supabase's default 1,000) whatever a read asks
// for, and none of these paged:
//   · CS-726  Variance's "On the clock now" (GET /api/time/open → listOpen) read the open punches
//             OLDEST first with no range: past 1,000 open punches the newest clock-ins dropped off.
//   · CS-727  Team's App versions (GET /api/state/heartbeat) asked `.limit(2000)` of a table that
//             holds a row per app LAUNCH, then kept each person's freshest — the cap answered 1,000
//             rows, a few hours' worth at 1,500 cleaners, and most people showed no version. Team's
//             phone-alert status (GET /api/push/status) read every device row with no range.
//   · CS-335  Quality hub › Checklists showed the newest 200 submissions and called that the list:
//             no count, no "showing the newest 200 of N" (the Inspections tab's CS-322 treatment).
// THE FIX: complete, ordered reads (api/_lib/pagedSelect selectAll), newest first for the strip;
// the heartbeat keyed by DEVICE (lib/appBuild deviceKey), so a phone is one row, not one per
// launch; the checklist list returns its total and says "Showing the newest 200 of N".
//
// HOW. The real routes through scripts/fake-supabase.mjs with world.maxRows = 1000, at the
// audit's flood shapes ($AUDIT/F12/flood.mjs S2-S4).
//
//   node app/scripts/test-scale-complete-reads.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000726';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8');
const { seedPermissions } = await import('../src/lib/roles.js');
const time = (await import('../api/time/[...path].js')).default;
const heartbeat = (await import('../api/state/heartbeat.js')).default;
const pushStatus = (await import('../api/push/status.js')).default;
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(4, '0');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const login = (who, role) => ({ id: `auth-${who}`, email: `${who}@example.test`, app_metadata: { role, org_user_id: who, org_id: ORG } });
const LOGINS = { 'tok-owner': login('u_owner', 'owner'), 'tok-crew': login('u_crew', 'crew') };
const baseState = (extra = {}) => ({
  version: 3, company: { id: 'co', name: 'Flood Co', timezone: 'America/New_York' },
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'u_owner@example.test' },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Carl', email: 'u_crew@example.test' },
  ],
  clients: [{ id: 'cl_a', name: 'A' }, { id: 'cl_b', name: 'B' }],
  sites: [{ id: 's_a', clientId: 'cl_a', name: 'A' }, { id: 's_b', clientId: 'cl_b', name: 'B' }],
  permissions: seedPermissions(), userPermissionOverrides: [],
  ...extra,
});
function seed(tables, state = baseState()) {
  resetWorld({
    tables: { org_state: [{ organization_id: ORG, version: 3, state }], crew_assignments: [], jobs: [], ...tables },
    logins: LOGINS,
  });
  world.maxRows = 1000; // PostgREST's db-max-rows (Supabase's default)
}
async function call(handler, { method = 'GET', sub = '', query = {}, body, token = 'tok-owner' } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: sub, ...query };
  if (body !== undefined) req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        send(b) { resolve({ status: this.statusCode, body: b }); return this; },
        end(b) { resolve({ status: this.statusCode, body: b ?? null }); return this; },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  } finally { Object.assign(console, quiet); }
}

// ── CS-726: who is on the clock — every open punch, newest first ──────────────────────────
{
  const te = [];
  for (let i = 1; i <= 1200; i += 1) {
    te.push({ id: uuid(500000 + i), organization_id: ORG, user_id: `u_c${pad(i)}`, user_name: `Cleaner ${pad(i)}`, job_id: null,
      site_id: 's_a', client_id: 'cl_a', clock_in_at: iso(NOW - (1200 - i) * 60000), clock_out_at: null, status: 'in_progress',
      approval_status: 'pending', row_version: 1 });
  }
  seed({ time_entries: te });
  const r = await call(time, { sub: 'open' });
  const got = r.body?.entries || [];
  ok(`726.1 🔴 every open punch is listed past the 1,000-row cap: ${got.length} of 1200`, r.status === 200 && got.length === 1200, `status ${r.status}`);
  ok('726.2 🔴 the newest clock-in is there, and first', got[0]?.user_name === 'Cleaner 1200');
  ok('726.3 newest first all the way down', got.every((e, i) => i === 0 || Date.parse(got[i - 1].clock_in_at) >= Date.parse(e.clock_in_at)));
  ok('726.4 a closed punch is never listed', !got.some((e) => e.clock_out_at));
  const api = read('src/lib/timeApi.js');
  const open = (api.match(/export async function open\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
  ok('726.5 the strip keeps the order: newest clock-in first (server and demo)',
    (open.match(/\.sort\(\(a, b\) => new Date\(b\.clock_in_at\) - new Date\(a\.clock_in_at\)\)/g) || []).length === 2, open.slice(0, 200));
}

// ── CS-727: App versions — every person's freshest heartbeat ──────────────────────────────
{
  const hb = [];
  for (let i = 1; i <= 1500; i += 1) {
    for (let t = 0; t < 2; t += 1) {
      hb.push({ organization_id: ORG, org_user_id: `u_c${pad(i)}`, tab: `t_${i}_${t}`, build: 100 + t, ua: 'x',
        pending_punches: t, failed_punches: 0, last_seen: iso(NOW - (i * 2 + t) * 30000) });
    }
  }
  hb.push({ organization_id: ORG, org_user_id: 'u_c0001', tab: 'old', build: 1, ua: 'x', pending_punches: 0, failed_punches: 0, last_seen: iso(NOW - 70 * 86400000) });
  seed({ client_heartbeats: hb });
  const r = await call(heartbeat, { method: 'GET' });
  const rows = r.body?.rows || [];
  const byUser = new Map(rows.map((x) => [x.org_user_id, x]));
  ok(`727.1 🔴 every person heard from is on the card past the cap: ${byUser.size} of 1500`, r.status === 200 && byUser.size === 1500 && rows.length === 1500, `status ${r.status}`);
  ok('727.2 each with their FRESHEST report (build 100, the newer of their two)', [...byUser.values()].every((x) => Number(x.build) === 100 && Number(x.pending_punches) === 0));
  ok('727.3 the newest build seen', r.body?.newestBuild === 101);
  ok('727.4 a report older than 60 days is not counted', Number(byUser.get('u_c0001')?.build) === 100);
  // One phone is ONE row: the heartbeat is keyed by the device, not by the page load.
  installResolveShim();
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  const appBuild = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'appBuild.js')).href);
  const k1 = typeof appBuild.deviceKey === 'function' ? appBuild.deviceKey(storage) : null;
  const k2 = typeof appBuild.deviceKey === 'function' ? appBuild.deviceKey(storage) : null;
  ok('727.5 🔴 a device keeps ONE heartbeat key across launches', !!k1 && k1 === k2 && k1 !== appBuild.TAB_ID);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  ok('727.6 no storage (a private window): it falls back to the page-load id', typeof appBuild.deviceKey === 'function' && appBuild.deviceKey(broken) === appBuild.TAB_ID);
  ok('727.7 the heartbeat sends that key', /tab: deviceKey\(\)/.test(read('src/components/BuildHeartbeat.jsx')));
}

// ── CS-727: phone-alert status — every device ─────────────────────────────────────────────
{
  const ps = [];
  for (let i = 1; i <= 1600; i += 1) {
    ps.push({ id: uuid(600000 + i), organization_id: ORG, user_id: `u_c${pad(((i - 1) % 1500) + 1)}`, endpoint: `https://push.example/${i}`,
      p256dh: 'k', auth: 'a', last_seen_at: iso(NOW - i * 1000) });
  }
  seed({ push_subscriptions: ps });
  const r = await call(pushStatus, { method: 'GET' });
  const by = r.body || {};
  ok(`727.8 🔴 every person with a subscribed phone past the cap: ${Object.keys(by).length} of 1500`, r.status === 200 && Object.keys(by).length === 1500, `status ${r.status}`);
  ok('727.9 a person with two phones counts two', by.u_c0001?.deviceCount === 2 && by.u_c0101?.deviceCount === 1);
}

// ── CS-335: Quality hub › Checklists — the newest 200, and how many there are ──────────────
{
  const cl = (n, siteId, by = 'u_owner') => Array.from({ length: n }, (_, i) => ({
    id: uuid(700000 + i + (siteId === 's_b' ? 5000 : 0)), organization_id: ORG, client_id: siteId === 's_a' ? 'cl_a' : 'cl_b', site_id: siteId,
    job_id: `j_${siteId}_${i}`, template_id: null, completed_by_user_id: by, items: [], completed_count: 1, total_count: 1,
    template_snapshot: { name: 'Nightly' }, performed_at: iso(NOW - (i + 1) * 3600000), created_at: iso(NOW),
  }));
  seed({ checklist_results: [...cl(201, 's_a'), ...cl(150, 's_b', 'u_crew')] });
  const r = await call(qc, { sub: 'checklists/list' });
  const rows = r.body?.checklists || [];
  ok(`335.1 the list is the newest 200 (${rows.length})`, r.status === 200 && rows.length === 200, `status ${r.status}`);
  ok('335.2 🔴 it says how many there are in all', r.body?.total === 351, `total ${r.body?.total}`);
  ok('335.3 🔴 …and that it is cut', r.body?.truncated === true);
  ok('335.4 newest first', rows.every((x, i) => i === 0 || Date.parse(rows[i - 1].performed_at) >= Date.parse(x.performed_at)));
  const site = await call(qc, { sub: 'checklists/list', query: { siteId: 's_b' } });
  ok('335.5 a filter narrows the count too (one site: 150, not cut)', site.body?.total === 150 && site.body?.truncated === false && (site.body?.checklists || []).length === 150);
  const crew = await call(qc, { sub: 'checklists/list', token: 'tok-crew' });
  ok('335.6 a cleaner\'s count is their scope\'s, never the company\'s', crew.status === 200 && crew.body?.total === 150 && (crew.body?.checklists || []).every((x) => x.completed_by_user_id === 'u_crew'),
    `status ${crew.status} total ${crew.body?.total}`);
  const store = read('api/_lib/qc/store.js');
  const newest = (store.match(/export async function listChecklists\(\{[\s\S]*?\n\}/) || [])[0] || '';
  ok('335.6b the list reads (performed_at, id) newest first — checklist_results_org_performed_idx, backwards',
    /\.order\('performed_at', \{ ascending: false \}\)\.order\('id', \{ ascending: false \}\)/.test(newest));
  const page = read('src/pages/Inspections.jsx');
  ok('335.7 🔴 the tab says "Showing the newest N of TOTAL" when it is cut', /checklistTotals\.truncated && \(/.test(page) && /t\('checklistList\.capped', \{ shown: checklists\.length, total: checklistTotals\.total \}\)/.test(page));
  ok('  …in the catalog\'s words', /'checklistList\.capped': /.test(read('src/i18n/catalog/en.js')));
  // The demo stub answers the same shape: the newest 200, the total, cut or not.
  installResolveShim();
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  const { QC_CHECKLISTS_STUB_KEY } = await import(pathToFileURL(path.join(APP, 'src', 'data', 'stubKeys.js')).href);
  const qcApi = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'qcApi.js')).href);
  mem.set(QC_CHECKLISTS_STUB_KEY, JSON.stringify({ checklists: [...cl(201, 's_a'), ...cl(150, 's_b', 'u_crew')].reverse() }));
  const stub = typeof qcApi.listChecklistsNewest === 'function' ? await qcApi.listChecklistsNewest() : null;
  ok('335.8 🔴 the demo stub matches: newest 200 of 351, cut', stub?.checklists?.length === 200 && stub?.total === 351 && stub?.truncated === true
    && stub.checklists.every((x, i) => i === 0 || Date.parse(stub.checklists[i - 1].performed_at) >= Date.parse(x.performed_at)));
}

console.log(`\ncomplete reads at scale: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exitCode = 1; }
