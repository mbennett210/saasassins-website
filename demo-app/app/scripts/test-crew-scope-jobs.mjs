// CS-005 — a cleaner reaches the QC records of the places they are SCHEDULED, whatever the
// standing-assignment table holds.
//
// THE BUG (re-verified at 6e61596c). The QC routes scope a crew login with `crewScopeFor`
// (api/qc/[...path].js): once `crew_assignments` has ever been synced (`assignmentsInitialized`)
// it reads ONLY that table — which is derived from the RETIRED `standingCrewIds` (removed
// 2026-09-09), so in production it holds nothing but its sync marker. Every cleaner's scope was
// empty: their checklist submit answered 403 "Not your account", the work orders at their own
// buildings never listed, and a building's area status was refused. (The door / alarm code
// reveal was already job-based — S81, cb14ad9 + 625435a — and is checked here as the control.)
//
// THE FIX. ONE rule, `src/lib/crewScope.js` `crewScopeFromJobs`: a cleaner's customers and
// locations are the ones a clean names them on (job.crewIds, lib/crewResolve), plus every
// location of those customers. `crewScopeFor` unions it with the standing table (the
// `assignmentsInitialized()` contract is kept, so an empty table still never locks anyone out),
// the server's `crewAssignedScope` (the CS-002 view and merge) takes its job half from it, and
// the screens' `selectVisibleClientIdsFor` reads it too — server and screen cannot disagree.
// It is safe because Increment 1e keeps browsers off public.jobs and jobsGuard keeps crew from
// writing a clean's crew, site or time (the same footing the reveal's job path stands on).
//
// HOW. The REAL qc and site-security routes through scripts/fake-supabase.mjs.
//
//   node app/scripts/test-crew-scope-jobs.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000005';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
  OPS_CODE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const qc = (await import('../api/qc/[...path].js')).default;
const siteSecurity = (await import('../api/site-security/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const iso = (h) => new Date(Date.now() + h * 3600000).toISOString();
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const login = (who, role) => ({ id: `auth-${who}`, email: `${who}@example.test`, app_metadata: { role, org_user_id: who, org_id: ORG } });
const logins = { 'tok-ana': login('u_ana', 'crew'), 'tok-ben': login('u_ben', 'crew'), 'tok-mgr': login('u_mgr', 'manager') };
const SCHEMA = { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Floors', naAllowed: false }] }] };

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 57,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_ana', 'crew'), user('u_ben', 'crew'), user('u_mgr', 'manager')],
          clients: [{ id: 'c1', name: 'Acme Towers', crewChecklists: { u_ana: 'it_a' } }, { id: 'c2', name: 'Bayside Plaza' }],
          sites: [
            { id: 's1', clientId: 'c1', name: 'Acme Towers', cleaningAreas: [{ id: 'ar1', label: 'Lobby' }], security: { doorCodeCipher: encrypt('4321', 'OPS_CODE_ENCRYPTION_KEY') } },
            { id: 's2', clientId: 'c2', name: 'Bayside Plaza', cleaningAreas: [] },
          ],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
        },
      }],
      // 🔴 INITIALIZED BUT EMPTY — production's state: the sync marker and no assignment.
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      // Ana cleans Acme tonight; Ben cleans Bayside.
      jobs: [
        { id: 'j1', organization_id: ORG, site_id: 's1', client_id: 'c1', status: 'upcoming', start_at: iso(2),
          data: { id: 'j1', clientId: 'c1', siteId: 's1', startAt: iso(2), endAt: iso(4), status: 'upcoming', crewIds: ['u_ana'] } },
        { id: 'j2', organization_id: ORG, site_id: 's2', client_id: 'c2', status: 'upcoming', start_at: iso(2),
          data: { id: 'j2', clientId: 'c2', siteId: 's2', startAt: iso(2), endAt: iso(4), status: 'upcoming', crewIds: ['u_ben'] } },
      ],
      inspection_templates: [{ id: 'it_a', organization_id: ORG, name: 'Nightly', kind: 'checklist', is_published: true, published_version_id: 'v1', client_id: 'c1' }],
      inspection_template_versions: [{ id: 'v1', template_id: 'it_a', version_number: 1, status: 'published', schema: SCHEMA }],
      checklist_results: [],
      // Work orders at both buildings, raised by the office (not by Ana).
      problem_reports: [
        { id: 'wo1', organization_id: ORG, client_id: 'c1', site_id: 's1', title: 'Lobby spill', status: 'open', reported_by_user_id: 'u_mgr', created_at: iso(-5) },
        { id: 'wo2', organization_id: ORG, client_id: 'c2', site_id: 's2', title: 'Restroom', status: 'open', reported_by_user_id: 'u_mgr', created_at: iso(-4) },
      ],
      account_media: [],
    },
    logins,
  });
}

async function call(handler, { method = 'POST', path, token, body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path, ...query };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path}: no response`)), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;
const submit = (token, siteId, clientId) => call(qc, { path: 'checklists/submit', token, body: { templateId: 'it_a', siteId, clientId, jobId: 'j1', items: [{ key: 'i1', checked: true }] } });

// ── 1. A cleaner on a clean at the site, with the assignment table initialized but empty ──
seed();
{
  const r = await submit('tok-ana', 's1', 'c1');
  ok('1.1 her checklist submit at the building she is scheduled at → 200', r.status === 200, show(r));
  ok('1.2 …and it is stored, stamped with her', world.tables.checklist_results.some((x) => x.completed_by_user_id === 'u_ana'));
  const list = await call(qc, { method: 'GET', path: 'problems/list', token: 'tok-ana' });
  const ids = (list.body?.problems || []).map((p) => p.id);
  ok('1.3 the work orders at her building are listed (raised by the office, not her)', list.status === 200 && ids.includes('wo1'), show(list));
  ok('1.4 …and only hers: another building\'s are not', !ids.includes('wo2'), JSON.stringify(ids));
  const areas = await call(qc, { method: 'GET', path: 'areas/status', token: 'tok-ana', query: { siteId: 's1' } });
  ok('1.5 her building\'s area status reads → 200', areas.status === 200, show(areas));
  const reveal = await call(siteSecurity, { method: 'POST', path: 'reveal', token: 'tok-ana', body: { siteId: 's1', which: 'door' } });
  ok('1.6 the door code at her building reveals within the clean\'s window (job-based since S81 — the control)', reveal.status === 200 && reveal.body?.code === '4321', show(reveal));
  const mine = await call(qc, { method: 'GET', path: 'checklists/list', token: 'tok-ana' });
  ok('1.7 she lists the checklists at her building', mine.status === 200 && (mine.body?.checklists || []).length >= 1, show(mine));
}

// ── 2. The boundary still holds ───────────────────────────────────────────────────────────
seed();
{
  const r = await submit('tok-ana', 's2', 'c2');
  ok('2.1 a submit at a building she is NOT scheduled at → 403', r.status === 403, show(r));
  const rb = await submit('tok-ben', 's1', 'c1');
  ok('2.2 another cleaner (not on Acme\'s clean) cannot submit there → 403', rb.status === 403, show(rb));
  const areas = await call(qc, { method: 'GET', path: 'areas/status', token: 'tok-ana', query: { siteId: 's2' } });
  ok('2.3 another building\'s area status → 403', areas.status === 403, show(areas));
  const reveal = await call(siteSecurity, { method: 'POST', path: 'reveal', token: 'tok-ben', body: { siteId: 's1', which: 'door' } });
  ok('2.4 another building\'s door code → 403', reveal.status === 403, show(reveal));
}

// ── 3. ONE rule: the server's scope and the screens read the same function ───────────────
{
  let S = null;
  try { S = await import('../src/lib/crewScope.js'); } catch { S = null; }
  ok('3.1 the rule lives in one module (src/lib/crewScope.js)', !!S && typeof S.crewScopeFromJobs === 'function');
  const jobs = [
    { id: 'j1', clientId: 'c1', siteId: 's1', crewIds: ['u_ana'] },
    { id: 'j3', siteId: 's3', crewIds: ['u_ana', 'u_ben'] },           // no clientId: the site's customer
    { id: 'j2', clientId: 'c2', siteId: 's2', crewIds: ['u_ben'] },
  ];
  const sites = [{ id: 's1', clientId: 'c1' }, { id: 's1b', clientId: 'c1' }, { id: 's2', clientId: 'c2' }, { id: 's3', clientId: 'c3' }];
  const sc = S ? S.crewScopeFromJobs({ jobs, sites, userId: 'u_ana' }) : null;
  ok('3.2 her customers are the ones a clean names her on (incl. through the site)', !!sc && [...sc.clientIds].sort().join() === 'c1,c3');
  ok('3.3 …and every location of those customers', !!sc && [...sc.siteIds].sort().join() === 's1,s1b,s3');
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  ok('3.4 the QC routes\' crew scope reads it', /crewScopeFromJobs/.test(read('../api/qc/[...path].js')));
  ok('3.5 the server\'s crewAssignedScope (the CS-002 view + merge) takes its job half from it', /crewScopeFromJobs/.test(read('../api/_lib/authz.js')));
  ok('3.6 the screens\' selectVisibleClientIdsFor reads it too', /crewScopeFromJobs/.test(read('../src/store/selectors.js')));
}

console.log(`\ntest-crew-scope-jobs: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
