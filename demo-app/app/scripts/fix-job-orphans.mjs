// MUTATION (dry-run by default): NULL every dependent job_id that points at a
// job no longer in public.jobs, so the job-delete FK migration
// (20260717120000_job_delete_dependents.sql) can be applied. NULLing preserves the
// record and merely detaches it from a job that no longer exists — we never DELETE
// a labor/QC/media row here.
//
// Idempotent + CAS-safe: each UPDATE is filtered to the exact orphan job_ids found
// at read time, so a re-run finds nothing. Dry-run prints the exact per-table
// deltas; --commit executes.
//
//   node scripts/fix-job-orphans.mjs            # dry-run (default) — writes nothing
//   node scripts/fix-job-orphans.mjs --commit   # apply the NULLs
//
// PRECONDITION (per /data-op ritual): take a backup of the affected tables first
// (pg_dump of time_entries, inspection_records, checklist_results, problem_reports)
// — this touches relational tables, not org_state, so dump-orgstate.mjs does NOT
// cover it. Run audit-job-orphans.mjs first to see what will change.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const COMMIT = process.argv.includes('--commit');

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
const TABLES = ['time_entries', 'inspection_records', 'checklist_results', 'problem_reports'];

async function fetchColumn(table, column, filter) {
  const out = [];
  const PAGE = 1000;
  // Stable order by the PK is REQUIRED for correct OFFSET paging (see audit script).
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

const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

console.log(`\n${COMMIT ? '⚙ COMMIT MODE — writing.' : '🔍 DRY-RUN — no writes. Pass --commit to apply.'}\n`);
const jobIds = new Set(await fetchColumn('jobs', 'id'));

let grand = 0;
for (const table of TABLES) {
  const vals = await fetchColumn(table, 'job_id', (q) => q.not('job_id', 'is', null));
  const orphanIds = [...new Set(vals.filter((id) => !jobIds.has(id)))];
  const orphanRows = vals.filter((id) => !jobIds.has(id)).length;
  grand += orphanRows;
  if (!orphanIds.length) { console.log(`✓ ${table.padEnd(20)} no orphans`); continue; }
  console.log(`${COMMIT ? '→' : '·'} ${table.padEnd(20)} ${orphanRows} row(s) across ${orphanIds.length} orphan job_id(s) → NULL`);
  if (COMMIT) {
    for (const ids of chunk(orphanIds, 100)) {
      const { error } = await db.from(table).update({ job_id: null }).in('job_id', ids);
      if (error) throw new Error(`${table} update: ${error.message}`);
    }
  }
}

console.log('');
if (grand === 0) console.log('✓ Nothing to do — no orphans.');
else if (COMMIT) console.log(`✓ Detached ${grand} orphan row(s). The job-delete FK migration can now be applied.`);
else console.log(`Would detach ${grand} orphan row(s). Re-run with --commit to apply.`);
console.log('');
