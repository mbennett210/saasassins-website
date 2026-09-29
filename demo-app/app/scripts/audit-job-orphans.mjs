// READ-ONLY audit: which dependent rows reference a job_id that no longer exists
// in public.jobs? These orphans MUST be resolved before the job-delete FK migration
// (20260717120000_job_delete_dependents.sql) — adding a foreign key fails if any
// non-null job_id has no matching jobs.id. NULL job_ids (ad-hoc / unscheduled
// entries) are fine: FKs permit NULL, so they are not orphans.
//
// Writes NOTHING. Prints per-table orphan counts + a sample of orphan job_ids.
//   node scripts/audit-job-orphans.mjs
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
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (looked in app/.env.local).');
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Tables whose job_id becomes an ON DELETE CASCADE FK to public.jobs.
const TABLES = ['time_entries', 'inspection_records', 'checklist_results', 'problem_reports'];

// Page through a single column so large tables don't hit the 1000-row default cap.
async function fetchColumn(table, column, filter) {
  const out = [];
  const PAGE = 1000;
  // Stable order by the PK is REQUIRED for correct OFFSET paging — without ORDER BY,
  // Postgres gives no cross-query row order, so a concurrent write could skip or
  // duplicate a row and a skipped jobs.id would make its live rows look orphaned.
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(column).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}.${column}: ${error.message}`);
    out.push(...data.map((r) => r[column]));
    if (data.length < PAGE) break;
  }
  return out;
}

console.log('\nLoading public.jobs ids…');
const jobIds = new Set(await fetchColumn('jobs', 'id'));
console.log(`  ${jobIds.size} live jobs.\n`);

let totalOrphanRows = 0;
const perTable = [];
for (const table of TABLES) {
  const jobColVals = await fetchColumn(table, 'job_id', (q) => q.not('job_id', 'is', null));
  const orphanRows = jobColVals.filter((id) => !jobIds.has(id));
  const orphanIds = [...new Set(orphanRows)];
  totalOrphanRows += orphanRows.length;
  perTable.push({ table, total: jobColVals.length, orphanRows: orphanRows.length, orphanIds });
}

console.log('Orphan job_id references (non-null job_id with no matching jobs.id):\n');
for (const t of perTable) {
  const flag = t.orphanRows ? ' ⚠' : ' ✓';
  console.log(`${flag} ${t.table.padEnd(20)} ${String(t.orphanRows).padStart(5)} orphan row(s) / ${t.total} with a job_id`);
  if (t.orphanRows) {
    console.log(`     ${t.orphanIds.length} distinct orphan job_id(s), e.g.: ${t.orphanIds.slice(0, 8).join(', ')}${t.orphanIds.length > 8 ? ' …' : ''}`);
  }
}

console.log('');
if (totalOrphanRows === 0) {
  console.log('✓ No orphans. The job-delete FK migration can be applied safely.');
} else {
  console.log(`⚠ ${totalOrphanRows} orphan row(s) total. Run scripts/fix-job-orphans.mjs (dry-run first, then --commit)`);
  console.log('  to NULL these job_ids BEFORE applying the job-delete FK migration.');
}
console.log('');
