// Verifies the PostgREST filter shape the server-mediated org_state write relies
// on (Increment 1d): `.eq(org).eq(version).or('min_client_build.is.null,
// min_client_build.lte.N')`.
//
// Why this needs proving rather than assuming: that `.or()` IS the fleet gate.
// If it silently ANDs wrong, or doesn't compose with the preceding .eq()s, the
// gate either blocks every write (total outage) or admits stale builds during a
// prune (the data-loss scenario the whole safety spine exists to prevent).
//
// READ-ONLY — runs the identical filter chain as a SELECT. Writes nothing.
//
//   node scripts/test-fleet-gate-predicate.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* try next */ }
}
const ORG = process.env.FORMS_ORG_ID || '00000000-0000-0000-0000-000000000001';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: row, error } = await db
  .from('org_state').select('version, min_client_build').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('read failed:', error.message); process.exit(1); }

const version = row.version;
const min = row.min_client_build;
console.log(`\nlive org_state: version=${version} min_client_build=${min === null ? 'NULL (gate inert)' : min}\n`);

// The exact chain from _lib/orgState.js writeOrgStateFromClient, as a SELECT.
const probe = async (baseVersion, build) => {
  let q = db.from('org_state').select('version')
    .eq('organization_id', ORG).eq('version', baseVersion);
  if (build > 0) q = q.or(`min_client_build.is.null,min_client_build.lte.${build}`);
  const { data, error: e } = await q;
  if (e) throw new Error(e.message);
  return (data || []).length === 1;
};

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

ok('matches on the correct version + a high build', await probe(version, 999999999));
ok('matches on the correct version + build 0 (gate skipped)', await probe(version, 0));
ok('does NOT match a stale base version (CAS still bites)', !(await probe(version - 1, 999999999)));
ok('does NOT match a future base version', !(await probe(version + 1, 999999999)));

// The gate half only has teeth once min_client_build is set. It is NULL in prod
// today (deliberately inert), so assert the inert behaviour AND simulate the
// armed comparison arithmetic so the semantics are pinned either way.
if (min === null) {
  ok('min_client_build NULL → any build matches (inert, as intended)', await probe(version, 1));
  console.log('  note: min_client_build is NULL, so the gate half is inert in prod today.');
  console.log('        The armed case is covered by the .lte. semantics proven below.');
  // Prove `.lte.` on a non-null column behaves as expected using `version` itself,
  // which is non-null — same operator, same code path through PostgREST.
  const lteSelf = await db.from('org_state').select('version')
    .eq('organization_id', ORG).or(`version.is.null,version.lte.${version}`);
  const lteBelow = await db.from('org_state').select('version')
    .eq('organization_id', ORG).or(`version.is.null,version.lte.${version - 1}`);
  ok('.lte. matches when column <= value', (lteSelf.data || []).length === 1);
  ok('.lte. excludes when column > value (a stale build WOULD be gated)', (lteBelow.data || []).length === 0);
} else {
  ok('build below min_client_build is REJECTED', !(await probe(version, min - 1)));
  ok('build equal to min_client_build is accepted', await probe(version, min));
  ok('build above min_client_build is accepted', await probe(version, min + 1));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
