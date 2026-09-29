// Populate public.crew_assignments from the live org_state standingCrewIds.
//
// Derives a new table from data that already exists — it mutates no customer
// record. Idempotent: it replaces the assignment set wholesale, so re-running
// converges rather than accumulating.
//
// The org_state write endpoint keeps this in sync from here on; this script is
// the initial fill and the repair tool if the two ever diverge.
//
//   node scripts/sync-crew-assignments.mjs           # dry run — reports, writes nothing
//   node scripts/sync-crew-assignments.mjs --apply
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
process.env.CLEANSPACE_ORG_ID = process.env.CLEANSPACE_ORG_ID || process.env.FORMS_ORG_ID
  || '00000000-0000-0000-0000-000000000001';

const { assignmentRowsFromState, syncAssignmentsFromState } = await import('../api/_lib/crewAssignments.js');
const APPLY = process.argv.includes('--apply');
const ORG = process.env.CLEANSPACE_ORG_ID;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('org_state read failed:', error.message); process.exit(1); }

const state = snap.state;
const rows = assignmentRowsFromState(state);
const { count: existing } = await db.from('crew_assignments')
  .select('user_id', { count: 'exact', head: true }).eq('organization_id', ORG);

const users = new Map((state.users || []).map((u) => [u.id, u]));
const perUser = {};
for (const r of rows) perUser[r.user_id] = (perUser[r.user_id] || 0) + 1;
const unknown = Object.keys(perUser).filter((id) => !users.has(id));

console.log(`\norg_state v${snap.version}`);
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (no writes)'} — crew_assignments sync\n`);
console.log(`  rows currently in table : ${existing ?? 0}`);
console.log(`  rows derived from blob  : ${rows.length}`);
console.log(`    site-level            : ${rows.filter((r) => r.source === 'standing_site').length}`);
console.log(`    account-level         : ${rows.filter((r) => r.source === 'standing_client').length}`);
console.log(`  distinct users assigned : ${Object.keys(perUser).length} of ${users.size}`);
if (unknown.length) {
  console.log(`\n  ⚠ ${unknown.length} assignment(s) reference a user id NOT in the roster:`);
  for (const id of unknown) console.log(`      ${id} (${perUser[id]} row(s)) — stale id left behind by a delete`);
  console.log('    These are carried across as-is: they grant nothing (no login maps to them)');
  console.log('    and dropping them here would hide a real data-hygiene problem.');
}

const top = Object.entries(perUser).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (top.length) {
  console.log('\n  most-assigned users:');
  for (const [id, n] of top) console.log(`      ${(users.get(id)?.name || id).padEnd(28)} ${n} assignment(s)`);
}

if (!APPLY) { console.log('\nDry run only — nothing was written. Re-run with --apply.\n'); process.exit(0); }

const r = await syncAssignmentsFromState(state);
const { count: after } = await db.from('crew_assignments')
  .select('user_id', { count: 'exact', head: true }).eq('organization_id', ORG);
const ok = after === r.rows;
console.log(`\n  wrote ${r.rows} row(s); table now holds ${after} — ${ok ? 'match' : 'MISMATCH'}`);
console.log(ok ? '\n✓ crew_assignments in sync with org_state.\n' : '\n✗ Count mismatch — investigate before relying on it.\n');
process.exit(ok ? 0 : 1);
