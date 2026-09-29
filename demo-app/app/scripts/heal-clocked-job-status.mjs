// One-time heal for the Sept 4 clock↔status decoupling. Cleans crew punched into
// BEFORE the fix (commit 406105f) shipped kept status 'upcoming' and read as
// 'Missed' on the Schedule, with no future clock event to heal them. This sets each
// such clean to what its punches say: an OPEN punch → in_progress, otherwise → done.
//
// Only touches jobs that HAVE a real (non-void/reject/no-show) time entry, and only
// when the stored status is 'upcoming' (the synthesized-missed incident). A clean a
// manager EXPLICITLY marked 'missed' that also has a punch is REPORTED, not changed —
// that is a human decision, surfaced for review. status lives in both data.status
// (what the app reads) and the indexed status column; both are written, like toRow.
//
//   node scripts/heal-clocked-job-status.mjs --dry-run
//   node scripts/heal-clocked-job-status.mjs --commit
//
// Pure planner exported for the test.

// jobs: [{ id, status, data }], punchByJob: Map(job_id -> { hasOpen }).
export function planHeal(jobs, punchByJob) {
  const heal = [];
  const flaggedMissed = [];
  for (const j of jobs) {
    const p = punchByJob.get(j.id);
    if (!p) continue;                                   // no real punch → not our case
    if (j.status === 'upcoming') {
      heal.push({ id: j.id, from: j.status, to: p.hasOpen ? 'in_progress' : 'done' });
    } else if (j.status === 'missed') {
      flaggedMissed.push({ id: j.id, to: p.hasOpen ? 'in_progress' : 'done' });
    }
    // done/cancelled/in_progress already reflect reality → leave alone.
  }
  return { heal, flaggedMissed };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { readFileSync } = await import('node:fs');
  const { createClient } = await import('@supabase/supabase-js');
  const COMMIT = process.argv.includes('--commit');
  if (!COMMIT && !process.argv.includes('--dry-run')) {
    console.error('Pass --dry-run (report only) or --commit (write).');
    process.exit(2);
  }
  try {
    for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* env may be set in the shell */ }
  const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 1. real punches in the last 14 days → per-job { hasOpen }.
  const sinceIso = new Date(Date.now() - 14 * 86400000).toISOString();
  const punchByJob = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('time_entries')
      .select('job_id, clock_out_at, status')
      .eq('organization_id', ORG).gte('clock_in_at', sinceIso)
      .not('status', 'in', '("voided","no_show","rejected")')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data || !data.length) break;
    for (const e of data) {
      if (!e.job_id) continue;
      const cur = punchByJob.get(e.job_id) || { hasOpen: false };
      if (e.clock_out_at == null) cur.hasOpen = true;
      punchByJob.set(e.job_id, cur);
    }
    if (data.length < 1000) break;
  }
  const punchedIds = [...punchByJob.keys()];
  console.log(`Found ${punchedIds.length} clean(s) with a real punch in the last 14 days.`);

  // 2. fetch those jobs (status + data), chunked by id.
  const jobs = [];
  for (let i = 0; i < punchedIds.length; i += 200) {
    const { data, error } = await db.from('jobs')
      .select('id, status, data').eq('organization_id', ORG).in('id', punchedIds.slice(i, i + 200));
    if (error) { console.error(error.message); process.exit(1); }
    for (const r of data || []) jobs.push(r);
  }

  const { heal, flaggedMissed } = planHeal(jobs, punchByJob);
  console.log(`\n${heal.length} 'upcoming' clean(s) to heal (were reading Missed despite a punch):`);
  for (const h of heal.slice(0, 40)) console.log(`  ${h.id}: ${h.from} → ${h.to}`);
  if (heal.length > 40) console.log(`  … and ${heal.length - 40} more`);
  if (flaggedMissed.length) {
    console.log(`\n⚠ ${flaggedMissed.length} clean(s) EXPLICITLY marked 'missed' also have a punch — NOT changed (review manually):`);
    for (const f of flaggedMissed.slice(0, 20)) console.log(`  ${f.id} (punch suggests ${f.to})`);
  }

  if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.'); process.exit(0); }

  let done = 0;
  for (const h of heal) {
    const j = jobs.find((x) => x.id === h.id);
    const nextData = { ...(j.data || {}), status: h.to };
    const { error } = await db.from('jobs')
      .update({ data: nextData, status: h.to, updated_at: new Date().toISOString(), updated_via: 'heal:clock-status' })
      .eq('organization_id', ORG).eq('id', h.id);
    if (error) { console.error(`FAILED ${h.id}: ${error.message}`); process.exit(1); }
    done += 1;
  }
  console.log(`\nHealed ${done} clean(s).`);
}
