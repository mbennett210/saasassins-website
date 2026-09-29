// One-time backfill for the Sept 3 "assignment overrides regular" rule.
//
// Before: a clean whose crewIds named only an OUTSIDE helper (no standing regular)
// resolved to helper + the account/site standing regulars (the old "supplement").
// After: crewIds is authoritative, so those cleans would resolve to JUST the helper
// and the regulars would silently drop off at the next occurrence. This materializes
// the old intent into explicit assignment: for each UPCOMING clean that names someone
// but NO regular of its own location, append that location's regulars (minus any
// per-clean crewExcludedIds) to crewIds. Idempotent; only touches the ~helper cleans.
//
// Run BEFORE deploying the new rule so there is never a window where those regulars
// are dropped. Reads standing crew from org_state; updates public.jobs.data.crewIds
// directly (the row_version/broadcast triggers fire normally).
//
//   node scripts/backfill-standing-into-crewids.mjs --dry-run   # report only
//   node scripts/backfill-standing-into-crewids.mjs --commit    # write
//
// Pure planner is exported for tests (test-backfill-standing.mjs).

// Standing regulars for a job's site + account (ids, deduped).
function standingForJob(job, clientsById, sitesById) {
  const site = job.site_id ? sitesById.get(job.site_id) : null;
  const clientId = job.client_id || site?.clientId || null;
  const client = clientId ? clientsById.get(clientId) : null;
  const ids = [];
  for (const id of (site?.standingCrewIds || [])) if (id) ids.push(id);
  for (const id of (client?.standingCrewIds || [])) if (id) ids.push(id);
  return [...new Set(ids)];
}

// Given org_state + the candidate job rows, return the list of { id, before, after }
// crew changes. A job is backfilled iff it NAMES someone, names NO regular of its own
// location, and that location HAS regulars — i.e. an old helper-supplement clean.
export function planBackfill(state, jobRows) {
  const clientsById = new Map((state.clients || []).map((c) => [c.id, c]));
  const sitesById = new Map((state.sites || []).map((s) => [s.id, s]));
  const plan = [];
  for (const j of jobRows) {
    const data = j.data || {};
    const crewIds = Array.isArray(data.crewIds) ? data.crewIds.filter(Boolean) : [];
    if (!crewIds.length) continue;                              // unnamed → regulars already cover it
    const standing = standingForJob(j, clientsById, sitesById);
    if (!standing.length) continue;                            // no regulars → nothing to add
    if (crewIds.some((id) => standing.includes(id))) continue; // names a regular → already authoritative
    const excluded = new Set(Array.isArray(data.crewExcludedIds) ? data.crewExcludedIds : []);
    const add = standing.filter((id) => !excluded.has(id) && !crewIds.includes(id));
    if (!add.length) continue;                                 // every regular excluded → leave as-is
    plan.push({ id: j.id, before: crewIds, after: [...crewIds, ...add] });
  }
  return plan;
}

// ── DB runner (skipped when imported by the test) ────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { readFileSync } = await import('node:fs');
  const { createClient } = await import('@supabase/supabase-js');
  const COMMIT = process.argv.includes('--commit');
  if (!COMMIT && !process.argv.includes('--dry-run')) {
    console.error('Pass --dry-run (report only) or --commit (write). Refusing to guess.');
    process.exit(2);
  }
  // Load env the same way the other backfills do.
  try {
    for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* env may already be set in the shell */ }
  const ORG = '00000000-0000-0000-0000-000000000001';
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: snap, error } = await db.from('org_state').select('state').eq('organization_id', ORG).maybeSingle();
  if (error) { console.error(error.message); process.exit(1); }
  if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

  const nowIso = new Date().toISOString();
  // PostgREST caps a select at ~1000 rows, and there are far more upcoming cleans
  // than that — page through ALL of them or the backfill silently misses most.
  const jobs = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error: jErr } = await db.from('jobs')
      .select('id, data, client_id, site_id, start_at, status')
      .eq('organization_id', ORG).eq('status', 'upcoming').gte('start_at', nowIso)
      .order('start_at', { ascending: true }).range(from, from + PAGE - 1);
    if (jErr) { console.error(jErr.message); process.exit(1); }
    if (!data || !data.length) break;
    jobs.push(...data);
    if (data.length < PAGE) break;
  }

  const plan = planBackfill(snap.state, jobs || []);
  console.log(`Scanned ${(jobs || []).length} upcoming cleans; ${plan.length} need their regulars materialized.`);
  const uname = (id) => (snap.state.users || []).find((u) => u.id === id)?.name || id;
  for (const p of plan.slice(0, 20)) {
    const added = p.after.filter((id) => !p.before.includes(id)).map(uname);
    console.log(`  ${p.id}: +[${added.join(', ')}]`);
  }
  if (plan.length > 20) console.log(`  … and ${plan.length - 20} more`);

  if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.'); process.exit(0); }

  let done = 0;
  for (const p of plan) {
    const j = jobs.find((x) => x.id === p.id);
    const nextData = { ...(j.data || {}), crewIds: p.after };
    const { error: uErr } = await db.from('jobs')
      .update({ data: nextData, updated_at: new Date().toISOString(), updated_via: 'backfill:standing-into-crewids' })
      .eq('organization_id', ORG).eq('id', p.id);
    if (uErr) { console.error(`FAILED ${p.id}: ${uErr.message}`); process.exit(1); }
    done += 1;
  }
  console.log(`\nCommitted ${done} clean(s).`);
}
