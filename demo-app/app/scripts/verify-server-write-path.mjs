// Post-deploy verification of the Increment 1d server write path, against LIVE
// prod — WITHOUT committing a single write.
//
// The trick: exercise routing + auth + the CAS predicate + the response contract
// using inputs that provably cannot commit.
//   • org-state with a deliberately STALE baseVersion -> must 409 conflict. The
//     CAS predicate matches no row, so nothing is written.
//   • jobs-delta with EMPTY arrays -> the handler returns before touching the DB.
//   • no bearer -> must 401 (proves the route exists AND is gated; a 404 would
//     mean the function never deployed and every save is silently falling back).
//
// Then reports the live `updated_via` marker, which is the real answer to "is
// the server path actually carrying traffic?" — the precondition for Increment
// 1e. Real user traffic is what flips it to 'server'.
//
// Credentials come from the environment (never hardcoded — this signs in as a
// LIVE crew account, so no credential is committed to the repo):
//   VERIFY_CREW_EMAIL     — the crew login's email
//   VERIFY_CREW_PASSWORD  — its password
// Both are REQUIRED; the script exits with a clear message if either is unset.
// Set them in the shell, or in app/.env.local (loaded below).
// Optional: VERIFY_BASE_URL overrides the default prod URL.
//
//   VERIFY_CREW_EMAIL=… VERIFY_CREW_PASSWORD=… node scripts/verify-server-write-path.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { IDENTITY } from '../src/brand/identity.generated.js';

for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* try next */ }
}
const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const ORG = process.env.FORMS_ORG_ID || '00000000-0000-0000-0000-000000000001';
const BASE = process.env.VERIFY_BASE_URL || IDENTITY.appUrl;

// Crew login for the authenticated probes — from the environment or app/.env.local
// (loaded above), NEVER hardcoded, so no live credential lives in the repo.
const CREW_EMAIL = process.env.VERIFY_CREW_EMAIL;
const CREW_PASSWORD = process.env.VERIFY_CREW_PASSWORD;
if (!CREW_EMAIL || !CREW_PASSWORD) {
  console.error('Missing VERIFY_CREW_EMAIL / VERIFY_CREW_PASSWORD — set both in the environment or app/.env.local before running this script.');
  process.exit(1);
}

const sb = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: s, error } = await sb.auth.signInWithPassword({
  email: CREW_EMAIL, password: CREW_PASSWORD,
});
if (error) { console.error('sign-in failed:', error.message); process.exit(1); }
const auth = { Authorization: `Bearer ${s.session.access_token}`, 'Content-Type': 'application/json' };

const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: before } = await admin.from('org_state')
  .select('version, updated_via, updated_at').eq('organization_id', ORG).maybeSingle();
console.log(`\nlive org_state: version=${before.version} updated_via=${before.updated_via ?? 'NULL (pre-1d)'}\n`);

const post = async (path, body, headers = auth) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: j };
};

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) pass += 1; else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// 1. Routing + auth. A 404 here means the function did not deploy and EVERY
//    save in production is silently taking the fallback.
const noAuth = await post('/api/state/org-state', {}, { 'Content-Type': 'application/json' });
ok('org-state route exists and is auth-gated', noAuth.status === 401, `${noAuth.status}`);
const noAuthJobs = await post('/api/state/jobs-delta', {}, { 'Content-Type': 'application/json' });
ok('jobs-delta route exists and is auth-gated', noAuthJobs.status === 401, `${noAuthJobs.status}`);
const noAuthSeed = await post('/api/state/seed', {}, { 'Content-Type': 'application/json' });
ok('seed route exists and is auth-gated', noAuthSeed.status === 401, `${noAuthSeed.status}`);

// 2. Validation.
const noState = await post('/api/state/org-state', { baseVersion: 1 });
ok('org-state rejects a missing state', noState.status === 400, `${noState.status}`);
const badVer = await post('/api/state/org-state', { state: {}, baseVersion: -1 });
ok('org-state rejects a bad baseVersion', badVer.status === 400, `${badVer.status}`);

// 3. CAS: a stale baseVersion matches no row → 409 conflict, nothing written.
const stale = await post('/api/state/org-state', { state: { probe: true }, baseVersion: 0, build: 0, tab: 't_probe' });
ok('stale baseVersion → 409 conflict (CAS holds, nothing written)',
  stale.status === 409 && stale.body?.conflict === true, `${stale.status} ${JSON.stringify(stale.body)}`);

// 4. jobs-delta empty payload short-circuits before any DB write.
const empty = await post('/api/state/jobs-delta', { changed: [], removed: [] });
ok('jobs-delta empty payload → 200 no-op',
  empty.status === 200 && empty.body?.changed === 0, `${empty.status} ${JSON.stringify(empty.body)}`);

// 5. Row cap is enforced server-side.
const tooMany = await post('/api/state/jobs-delta', { changed: Array.from({ length: 300 }, (_, i) => ({ id: `probe${i}` })), removed: [] });
ok('jobs-delta enforces its row cap', tooMany.status === 413, `${tooMany.status}`);

// 6. NOTHING was committed by any of the above.
const { data: after } = await admin.from('org_state')
  .select('version, updated_via').eq('organization_id', ORG).maybeSingle();
ok('org_state version unchanged by the probes', after.version === before.version,
  `${before.version} → ${after.version}`);
const { count: probeRows } = await admin.from('jobs')
  .select('id', { count: 'exact', head: true }).like('id', 'probe%');
ok('no probe job rows were created', (probeRows ?? 0) === 0, `${probeRows} rows`);

// 7. The 1e readiness signal (informational — flips with real user traffic).
const { count: browserJobs } = await admin.from('jobs')
  .select('id', { count: 'exact', head: true }).eq('updated_via', 'browser');
const { count: serverJobs } = await admin.from('jobs')
  .select('id', { count: 'exact', head: true }).eq('updated_via', 'server');
console.log('\n── Increment 1e readiness (needs real user traffic to move) ──');
console.log(`  org_state.updated_via : ${after.updated_via ?? 'NULL (not written since 1d deployed)'}`);
console.log(`  jobs written via server: ${serverJobs ?? 0}`);
console.log(`  jobs written via browser: ${browserJobs ?? 0}   <- must be 0 across a full soak before 1e`);

console.log(`\n${fails.length === 0 ? 'ALL CHECKS PASSED' : `${fails.length} CHECK(S) FAILED`} (${pass}/${pass + fails.length})\n`);
process.exit(fails.length ? 1 : 0);
