// READ-ONLY audit + backup for the duplicate-occurrence cleanup (SCALE-C02).
// Writes NOTHING to the database. It:
//   1. finds every duplicate (series_id, start_at) group in public.jobs,
//   2. picks the survivor (min id — deterministic, ≈ earliest-created) and the rows to delete,
//   3. checks whether any to-delete row has dependents (time_entries / inspection_records /
//      checklist_results / problem_reports / account_media scope='clean') — the migration's
//      FK policy is SET NULL so a delete only DETACHES, never destroys, but we surface it,
//   4. backs up the full to-delete rows to a timestamped JSON so the delete is reversible.
// Pages only the small indexed columns (id, series_id, start_at) — never the jsonb data for
// all rows — so it doesn't time out on the ~53 MB table. Run from app/:
//   node scripts/dedup-jobs-audit.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ORG = '00000000-0000-0000-0000-000000000001';

async function withRetry(fn, label) {
  for (let a = 0; a < 4; a++) {
    try { return await fn(); } catch (e) { if (a === 3) throw e; await new Promise((r) => setTimeout(r, 500 * (a + 1))); console.warn(`  retry ${label} (${e.message})`); }
  }
}

// 1. page ONLY the indexed columns (small + fast — no jsonb)
let all = [], from = 0, P = 500;
for (;;) {
  const data = await withRetry(async () => {
    const { data, error } = await db.from('jobs').select('id, series_id, start_at').eq('organization_id', ORG).order('id').range(from, from + P - 1);
    if (error) throw new Error(error.message); return data;
  }, `page@${from}`);
  all = all.concat(data); if (data.length < P) break; from += P;
}
console.log(`public.jobs: ${all.length} rows scanned`);

// 2. group by (series_id, start_at); survivor = min id
const groups = new Map();
for (const r of all) {
  if (!r.series_id) continue;
  const k = `${r.series_id} ${r.start_at || ''}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r.id);
}
const deleteIds = [];
let dupeGroups = 0;
for (const [, ids] of groups) {
  if (ids.length < 2) continue;
  dupeGroups++;
  ids.sort(); // survivor = min id
  deleteIds.push(...ids.slice(1));
}
console.log(`duplicate (series_id, start_at) groups: ${dupeGroups}`);
console.log(`rows to DELETE (dupes beyond the survivor): ${deleteIds.length}`);

// 3. dependents on the to-delete rows
async function depCount(table, col, extra) {
  let n = 0;
  for (let i = 0; i < deleteIds.length; i += 150) {
    const c = await withRetry(async () => {
      let q = db.from(table).select('*', { count: 'exact', head: true }).in(col, deleteIds.slice(i, i + 150));
      if (extra) q = extra(q);
      const { count, error } = await q; if (error) throw new Error(error.message); return count || 0;
    }, `${table}@${i}`);
    n += c;
  }
  return n;
}
console.log('\nDependents on the to-delete rows (FK policy is SET NULL → detach, not destroy):');
for (const [t, c] of [['time_entries', 'job_id'], ['inspection_records', 'job_id'], ['checklist_results', 'job_id'], ['problem_reports', 'job_id']]) {
  console.log(`  ${t.padEnd(20)}: ${await depCount(t, c)}`);
}
console.log(`  ${'account_media(clean)'.padEnd(20)}: ${await depCount('account_media', 'ref_id', (q) => q.eq('scope', 'clean'))}`);

// 4. backup the to-delete rows (FULL row incl. data) — timestamped, reversible
const stamp = new Date(Number(process.env.STAMP) || 0).toISOString().replace(/[:.]/g, '-');
const full = [];
for (let i = 0; i < deleteIds.length; i += 150) {
  const rows = await withRetry(async () => {
    const { data, error } = await db.from('jobs').select('*').in('id', deleteIds.slice(i, i + 150));
    if (error) throw new Error(error.message); return data;
  }, `backup@${i}`);
  full.push(...rows);
}
const backupName = `jobs-dedup-backup-${stamp}.json`;
writeFileSync(new URL(`./${backupName}`, import.meta.url), JSON.stringify({ takenAt: stamp, org: ORG, count: full.length, deleteIds, rows: full }, null, 2));
console.log(`\nBackup of ${full.length} to-delete rows → app/scripts/${backupName}`);
console.log(`PREDICTED DELTA: ${deleteIds.length} deleted, ${all.length - deleteIds.length} remain. Nothing else changes.`);
