// Live verification that the jobs row_version trigger + keyset cursor query
// actually work (Increment 2). Self-cleaning.
//
// Why this can't be assumed: if the trigger doesn't fire, row_version stays NULL
// forever, and BOTH the order guard and the cursor poll become silently inert —
// they'd read every row as version 0, drop nothing, and recover nothing, while
// every test and lint stays green. That is the same "looks healthy, does
// nothing" failure mode the Increment 1d review caught.
//
// Uses ONE probe row with a null start_at (so it falls outside every window
// query and renders nowhere) and a clearly-marked id, deleted at the end and in
// a finally block. Touches no real job.
//
//   node scripts/test-row-version-trigger.mjs
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

const PROBE = `job_rvprobe_${Date.now().toString(36)}`;
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) pass += 1; else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const cleanup = async () => { await db.from('jobs').delete().eq('id', PROBE); };

try {
  console.log(`\nprobe row: ${PROBE} (start_at null -> outside every window query)\n`);

  // 1. INSERT stamps a version.
  const { data: ins, error: insErr } = await db.from('jobs').insert({
    id: PROBE, organization_id: ORG, data: { id: PROBE, probe: true }, start_at: null,
  }).select('row_version').single();
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  const v1 = ins.row_version;
  ok('INSERT stamps row_version', typeof v1 === 'number' && v1 > 0, `v=${v1}`);

  // 2. UPDATE stamps a STRICTLY GREATER version (this is what the order guard
  //    compares, and what makes the cursor advance).
  const { data: upd, error: updErr } = await db.from('jobs')
    .update({ data: { id: PROBE, probe: true, touched: 1 } })
    .eq('id', PROBE).select('row_version').single();
  if (updErr) throw new Error(`update failed: ${updErr.message}`);
  const v2 = upd.row_version;
  ok('UPDATE bumps row_version strictly upward', v2 > v1, `${v1} -> ${v2}`);

  // 3. A client cannot forge or freeze it — the BEFORE trigger overrides.
  const { data: forge, error: forgeErr } = await db.from('jobs')
    .update({ row_version: 1 }).eq('id', PROBE).select('row_version').single();
  if (forgeErr) throw new Error(`forge attempt failed: ${forgeErr.message}`);
  ok('a supplied row_version is overridden by the trigger', forge.row_version > v2, `sent 1, got ${forge.row_version}`);
  const v3 = forge.row_version;

  // 4. The keyset cursor query returns the row when the cursor is behind it...
  const { data: since } = await db.from('jobs')
    .select('id, row_version').eq('organization_id', ORG)
    .gt('row_version', v2).order('row_version', { ascending: true }).limit(50);
  ok('cursor query returns rows written after the cursor',
    (since || []).some((r) => r.id === PROBE), `${(since || []).length} row(s)`);

  // 5. ...and NOT when the cursor is at or past it (a healthy poll is a no-op).
  const { data: none } = await db.from('jobs')
    .select('id').eq('organization_id', ORG)
    .gt('row_version', v3).order('row_version', { ascending: true }).limit(50);
  ok('cursor query excludes rows at/behind the cursor (healthy poll = no-op)',
    !(none || []).some((r) => r.id === PROBE), `${(none || []).length} row(s)`);

  // 6. Untouched real rows still read NULL — proving the migration did NOT rewrite the
  //    table or fan out 19k realtime events.
  //
  //    ⚠️ THIS IS A RATIO, NOT AN ABSOLUTE, AND THAT MATTERS. It was `<= 2`, written
  //    when exactly 2 rows had been stamped. Every genuine write since then stamps
  //    another, so the assertion started failing as soon as REAL TRAFFIC arrived —
  //    reporting the 1e soak working as a broken test. (28 stamped at the time this was
  //    reframed.) A permanently-red suite stops being a signal, which is exactly how
  //    test-notif-fanout rotted for a month.
  //
  //    What the test actually needs to prove is that no MASS backfill occurred, i.e.
  //    stamped rows remain a small minority. A backfill would stamp ~100%; organic
  //    writes take years to approach even 10% at ~1.5k/month against ~19k rows.
  const { count: stamped } = await db.from('jobs')
    .select('id', { count: 'exact', head: true }).not('row_version', 'is', null);
  const { count: totalRows } = await db.from('jobs')
    .select('id', { count: 'exact', head: true });
  const pct = totalRows ? ((stamped ?? 0) / totalRows) * 100 : 0;
  ok('no mass backfill — stamped rows are a small minority', pct < 10,
    `${stamped}/${totalRows} stamped (${pct.toFixed(2)}%)`);

  // 7. The _rv strip contract: nothing persisted _rv into the data payload.
  const { count: leaked } = await db.from('jobs')
    .select('id', { count: 'exact', head: true }).not('data->_rv', 'is', null);
  ok('_rv never leaked into the data JSONB', (leaked ?? 0) === 0, `${leaked} row(s) with data->_rv`);
} catch (e) {
  fails.push(`threw: ${e.message}`);
  console.log(`  FAIL  threw — ${e.message}`);
} finally {
  await cleanup();
  const { data: left } = await db.from('jobs').select('id').eq('id', PROBE);
  const clean = !left || left.length === 0;
  console.log(`  ${clean ? 'PASS' : 'FAIL'}  probe row cleaned up`);
  if (clean) pass += 1; else fails.push('probe row NOT cleaned up');
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
