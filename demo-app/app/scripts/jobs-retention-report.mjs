// public.jobs retention — READ-ONLY decision input. Writes nothing, deletes nothing.
//
//   node scripts/jobs-retention-report.mjs                # default 24-month cutoff
//   node scripts/jobs-retention-report.mjs --months 12
//   node scripts/jobs-retention-report.mjs --sandbox      # against the sandbox rig
//
// ══ WHY THIS IS A REPORT AND NOT A PRUNE ══════════════════════════════════════
//
// public.jobs has no cap, no TTL and no prune in any code path or migration, and it
// sits outside every increment's scope (ledger F5). But the obvious framing —
// "19,267 rows and growing, add a TTL" — is wrong, and a live read is what shows it:
//
//   19,014 of 19,267 rows are in the FUTURE. Nothing is older than six months. The
//   distribution is a flat ~1,570 rows/month for twelve months forward, tapering at
//   both ends — a ROLLING HORIZON maintained by TOP_UP_RECURRING_SERIES, in steady
//   state, not an accumulating history.
//
// So the table is not growing without bound today. What WILL grow is the past: as time
// advances, roughly 1,570 occurrences/month fall behind `now` and nothing removes them
// — about 19k rows/year of history, indefinitely.
//
// ⚠️ AND DELETING A PAST JOB IS NOT A CLEANUP. It is destructive in ways the row count
// does not show, which is the entire reason this script exists instead of a migration:
//
//   • trg_delete_clean_media_for_job fires AFTER DELETE and sweeps that job's
//     account_media — the before/after photos crew captured on the clean.
//   • time_entries, inspection_records, checklist_results and problem_reports all
//     reference the job with ON DELETE SET NULL, so the labor and QC records SURVIVE
//     but are permanently orphaned from the job they describe.
//
// That makes retention a legal/business decision about operational and payroll
// records, not a storage decision — and it needs a named owner. This script produces
// the numbers that decision needs; it deliberately does not act on them.
import { readFileSync } from 'node:fs';

const SANDBOX = process.argv.includes('--sandbox');
const envFile = SANDBOX ? '../.env.sandbox.local' : '../.env.local';
for (const line of readFileSync(new URL(envFile, import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const mi = process.argv.indexOf('--months');
const MONTHS = mi >= 0 ? Number(process.argv[mi + 1]) || 24 : 24;

const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - MONTHS);
const cutoffIso = cutoff.toISOString();
const p = (s = '') => console.log(s);

p(`\npublic.jobs retention report ${SANDBOX ? '🧪 SANDBOX' : '🔴 PRODUCTION'}`);
p(`cutoff: start_at < ${cutoffIso.slice(0, 10)}  (${MONTHS} months)`);
p('='.repeat(72));

const countOf = async (table, build) => {
  const { count, error } = await build(db.from(table).select('id', { count: 'exact', head: true }));
  return error ? `ERR ${error.message}` : count;
};

// ── the shape of the table ───────────────────────────────────────────────
const total = await countOf('jobs', (q) => q);
const past = await countOf('jobs', (q) => q.lt('start_at', new Date().toISOString()));
const future = await countOf('jobs', (q) => q.gte('start_at', new Date().toISOString()));
const stale = await countOf('jobs', (q) => q.lt('start_at', cutoffIso));

p('\nSHAPE');
p(`  total ................ ${total}`);
p(`  in the future ........ ${future}   <- the rolling horizon TOP_UP maintains`);
p(`  in the past .......... ${past}   <- the only thing that accumulates`);
p(`  older than ${String(MONTHS).padStart(2)} months .. ${stale}   <- what a ${MONTHS}-month TTL would DELETE`);

// ── what a prune would take with it ──────────────────────────────────────
// The row count is the least interesting number here.
p('\n⚠️ CASCADE — what deleting those rows would ALSO do');
const { data: staleRows, error: srErr } = await db
  .from('jobs').select('id').lt('start_at', cutoffIso).limit(10000);
if (srErr) {
  p(`  could not enumerate stale ids: ${srErr.message}`);
} else {
  const ids = (staleRows || []).map((r) => r.id);
  p(`  stale job ids enumerated: ${ids.length}`);
  if (!ids.length) {
    p('  nothing to cascade at this cutoff.');
  } else {
    const slice = ids.slice(0, 1000); // PostgREST .in() has a practical URL limit
    if (ids.length > 1000) p(`  (cascade sampled over the first 1000 of ${ids.length})`);
    const media = await countOf('account_media', (q) => q.in('ref_id', slice));
    p(`  account_media rows swept (HARD DELETE, photos/video gone) .... ${media}`);
    for (const [t, col] of [['time_entries', 'job_id'], ['inspection_records', 'job_id'], ['checklist_results', 'job_id'], ['problem_reports', 'job_id']]) {
      const n = await countOf(t, (q) => q.in(col, slice));
      p(`  ${t.padEnd(20)} orphaned (ON DELETE SET NULL) .... ${n}`);
    }
  }
}

// ── growth model ─────────────────────────────────────────────────────────
p('\nGROWTH');
p('  The horizon is flat at ~1,570 rows/month for 12 months forward, so the table is');
p('  in STEADY STATE going forward. The past grows at the same ~1,570/month, i.e.');
p('  roughly 19k rows/year, indefinitely, with nothing pruning it.');
p(`  At today's ${total} rows and ~19k/year of accumulating history:`);
for (const y of [1, 2, 3, 5]) p(`    +${y}y ≈ ${(total + y * 19000).toLocaleString()} rows`);

p('\nDECISION NEEDED (LOOP_REVIEW §3 F5) — this script will not make it:');
p('  1. Is there a retention period for completed work? It governs payroll and QC');
p('     evidence, not just storage.');
p('  2. If yes, must the media survive the job? Today the AFTER DELETE trigger');
p('     destroys it. Detaching media from a pruned job is a code change, not a policy.');
p('  3. Orphaned time_entries / QC records keep their own data but lose the job link.');
p('     Acceptable, or should a prune be blocked while linked records exist?');
p('');
