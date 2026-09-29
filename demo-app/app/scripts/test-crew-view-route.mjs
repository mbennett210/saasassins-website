// CS-002 — GET /api/state/view end to end, offline: the REAL handler (api/state/view.js) +
// the real Supabase client against scripts/fake-supabase-http.mjs (GoTrue + PostgREST +
// public.jobs on 127.0.0.1). Pins: an office login gets the FULL blob, a crew login gets the
// scoped/trimmed PROJECTION (sensitive slices absent), and no session is 401.
//
//   node app/scripts/test-crew-view-route.mjs
import { startFakeSupabase } from './fake-supabase-http.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} (${detail})` : label); };

const ORG = '00000000-0000-0000-0000-000000000001';
const USERS = {
  't-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  't-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
};
const fake = await startFakeSupabase({ authUsers: USERS });
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
const { default: handler } = await import('../api/state/view.js');

const seedState = () => ({
  version: 3,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'owner@cs.co', pay: { type: 'none' } },
    { id: 'u_crew', role: 'crew', status: 'active', name: 'Crew', email: 'crew@cs.co', phone: '222', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'E2' } },
  ],
  clients: [{ id: 'c1', name: 'Acme', standingCrewIds: [] }, { id: 'c2', name: 'Other', standingCrewIds: [] }],
  sites: [{ id: 's1', clientId: 'c1' }, { id: 's2', clientId: 'c2' }],
  invoices: [{ id: 'inv1', total: 12345 }],
  payrollLines: [{ id: 'pl1', userId: 'u_crew', amount: 999 }],
  keys: [{ id: 'k1', clientId: 'c1', clientName: 'Acme', masterCode: 'SECRET', status: 'in' }],
  permissions: [], opsSettings: { defaultGeofenceRadiusM: 250, otMultiplier: 1.5 },
});

fake.tables.org_state.push({ organization_id: ORG, state: seedState(), version: 3, min_client_build: null, freeze_strip: [] });
// The crew's assigned job (public.jobs) — puts c1/s1 in scope for the projection.
fake.tables.jobs = [{ id: 'j1', organization_id: ORG, data: { id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1' } }];

async function get(token) {
  const req = { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
  const out = { status: 200, body: null, headers: {} };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader(k, v) { out.headers[k] = v; return res; },
  };
  await handler(req, res);
  return out;
}

// ── owner: full blob ──────────────────────────────────────────────────────
const owner = await get('t-owner');
ok('owner: 200', owner.status === 200, `status ${owner.status}`);
ok('owner: projection=full', owner.body?.projection === 'full');
ok('owner: full blob has invoices', Array.isArray(owner.body?.state?.invoices) && owner.body.state.invoices.length === 1);
ok('owner: full blob has payrollLines', Array.isArray(owner.body?.state?.payrollLines));
ok('owner: version carried', owner.body?.version === 3);
ok('owner: no-store', owner.headers['Cache-Control'] === 'no-store');

// ── crew: projection ──────────────────────────────────────────────────────
const crew = await get('t-crew');
ok('crew: 200', crew.status === 200, `status ${crew.status}`);
ok('crew: projection=crew', crew.body?.projection === 'crew');
const cs = crew.body?.state || {};
ok('crew: invoices ABSENT', cs.invoices === undefined);
ok('crew: payrollLines ABSENT', cs.payrollLines === undefined);
ok('crew: client c1 in scope', Array.isArray(cs.clients) && cs.clients.some((c) => c.id === 'c1'));
ok('crew: client c2 out of scope', Array.isArray(cs.clients) && !cs.clients.some((c) => c.id === 'c2'));
ok('crew: key masterCode stripped', Array.isArray(cs.keys) && cs.keys.every((k) => !('masterCode' in k)));
const selfRow = (cs.users || []).find((u) => u.id === 'u_crew');
ok('crew: own row present, no pay', selfRow && !('pay' in selfRow) && selfRow.email === 'crew@cs.co');
const ownerRow = (cs.users || []).find((u) => u.id === 'u_owner');
ok('crew: owner row trimmed (no pay/email)', ownerRow && !('pay' in ownerRow) && !('email' in ownerRow));
ok('crew: opsSettings pay-run field stripped', cs.opsSettings && !('otMultiplier' in cs.opsSettings) && cs.opsSettings.defaultGeofenceRadiusM === 250);
ok('crew: version carried', crew.body?.version === 3);

// ── unauthenticated ────────────────────────────────────────────────────────
const anon = await get(null);
ok('no session: 401', anon.status === 401, `status ${anon.status}`);
const badTok = await get('nope');
ok('bad token: 401', badTok.status === 401, `status ${badTok.status}`);

await fake.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
