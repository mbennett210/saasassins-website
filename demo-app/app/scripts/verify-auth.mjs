// Read-only verification of the auth gate + RLS. Creates nothing. Proves:
//   1. a protected admin endpoint rejects requests with no token (401),
//   2. it also rejects a bogus/expired token (401),
//   3. the anonymous key cannot read the shared org_state (RLS authenticated-only).
// Run from app/:  node scripts/verify-auth.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

function mockRes() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
let pass = 0, fail = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };

// 1) protected endpoint, no token → 401
{
  const { default: quotes } = await import('../api/quotes/[...path].js');
  const res = mockRes();
  await quotes({ method: 'GET', query: { path: ['list'] }, headers: {} }, res);
  check('quotes/list without token → 401', res.code === 401);
}

// 2) protected endpoint, bogus token → 401
{
  const { default: quotes } = await import('../api/quotes/[...path].js');
  const res = mockRes();
  await quotes({ method: 'GET', query: { path: ['list'] }, headers: { authorization: 'Bearer not.a.real.token' } }, res);
  check('quotes/list with bogus token → 401', res.code === 401);
}

// 3) anon key cannot read shared state (RLS authenticated-only)
{
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.from('org_state').select('organization_id');
  check('anon SELECT org_state blocked by RLS (0 rows, no leak)', !error && Array.isArray(data) && data.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
