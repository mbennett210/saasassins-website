// Positive-path auth check (read-only). Signs in as a real account, then proves
// a valid token is accepted by a protected endpoint and the shared state is
// reachable by an authenticated session. Run from app/:
//   TEST_PASSWORD='...' node scripts/verify-auth-positive.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const email = process.env.TEST_EMAIL || 'kyle@cleanspaceonline.com';
const password = process.env.TEST_PASSWORD;
if (!password) { console.error('Set TEST_PASSWORD'); process.exit(1); }

function mockRes() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); c ? pass++ : fail++; };

const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: signin, error: sErr } = await anon.auth.signInWithPassword({ email, password });
check(`sign in as ${email}`, !sErr && !!signin?.session?.access_token);
if (sErr) { console.log('  →', sErr.message); process.exit(1); }
const token = signin.session.access_token;

const { default: quotes } = await import('../api/quotes/[...path].js');
const res = mockRes();
await quotes({ method: 'GET', query: { path: ['list'] }, headers: { authorization: `Bearer ${token}` } }, res);
check('quotes/list with valid token → 200', res.code === 200 && Array.isArray(res.body?.quotes));

// Authenticated session can reach org_state (RLS allows authenticated). Empty is fine.
const { error: selErr } = await anon.from('org_state').select('organization_id');
check('authenticated SELECT org_state allowed (no RLS denial)', !selErr);

await anon.auth.signOut();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
