// The Increment 1e revoke gate — READ-ONLY. Answers one question honestly:
//
//     "Is it safe to revoke the browser's write policies on org_state and jobs?"
//
//   node scripts/check-1e-gate.mjs                # default 24h window
//   node scripts/check-1e-gate.mjs --hours 72
//
// Exit 0 = GREEN, exit 1 = NOT GREEN. Nothing here writes.
//
// ══ WHY THIS SCRIPT EXISTS SEPARATELY FROM verify-server-write-path.mjs ═══════
// That script proves the server ENDPOINTS work. This one proves the FLEET has
// stopped writing directly — a different claim, and the actual precondition for the
// point of no return.
//
// ══ THE TWO WAYS THIS GATE LIES ══════════════════════════════════════════════
//
//  1. ERASURE. `org_state` is ONE mutable row carrying one `updated_via` stamp — the
//     last writer's. A browser write is erased by the next server write. Querying the
//     table directly can therefore only ever say "the most recent write was X", never
//     "no browser write happened". That is why 20260720130000_org_state_writes_seen.sql
//     exists; until it is applied this script reports UNANSWERABLE rather than
//     inventing a verdict from the live tables.
//
//  2. EMPTINESS READING AS CLEAN. Zero 'browser' rows is trivially true when nothing
//     has been written at all. The jobs half of this gate is in exactly that state
//     today. An empty sample is NOT a pass, and this script refuses to call it one —
//     which is the whole reason it is a script and not a query someone eyeballs.
//
// Revoking on a false green is the documented catastrophic failure: a broken server
// path silently falls back to the direct write, every indicator reads healthy, and
// the revoke takes every write in the app to zero for all users at once.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) || 24 : 24;
const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();

// A window with only a handful of observations is not a soak. Deliberately modest —
// the point is to reject a sample of 0-2, not to demand a specific traffic level.
const MIN_SERVER_OBSERVATIONS = 20;
const MIN_SPAN_HOURS = 8;

const fail = [];
const warn = [];
const line = (s = '') => console.log(s);

line(`\nIncrement 1e revoke gate — window: last ${HOURS}h (since ${since})\n${'='.repeat(72)}`);

// ── 1. is the sink applied? ───────────────────────────────────────────────
const sinkProbe = await db.from('org_state_writes_seen').select('id').limit(1);
const sinkExists = !sinkProbe.error;
if (!sinkExists) {
  line(`\n1. WRITE-OBSERVATION SINK ....... ABSENT (${sinkProbe.error.code})`);
  line('   supabase/migrations/20260720130000_org_state_writes_seen.sql is NOT applied.');
  line('   Without it org_state keeps only the LAST writer\'s stamp, so "zero browser');
  line('   writes" is NOT observable. Everything below is context, not a verdict.');
  fail.push('write-observation sink not applied — the gate question cannot be answered');
} else {
  const { count: total } = await db.from('org_state_writes_seen')
    .select('id', { count: 'exact', head: true }).gte('observed_at', since);
  const { data: rows, error } = await db.from('org_state_writes_seen')
    .select('source_table, updated_via, updated_by_build, observed_at')
    .gte('observed_at', since).order('observed_at', { ascending: true }).limit(10000);
  if (error) { line(`\n1. SINK READ FAILED: ${error.message}`); fail.push('sink unreadable'); }
  else {
    line(`\n1. WRITE-OBSERVATION SINK ....... PRESENT — ${total} observation(s) in window`);
    const by = new Map();
    for (const r of rows) {
      const k = `${r.source_table}/${r.updated_via ?? '(null)'}`;
      by.set(k, (by.get(k) || 0) + 1);
    }
    for (const [k, n] of [...by].sort()) line(`     ${k.padEnd(24)} ${n}`);

    const suspect = rows.filter((r) => r.updated_via !== 'server');
    const server = rows.filter((r) => r.updated_via === 'server');
    if (suspect.length) {
      fail.push(`${suspect.length} non-server write(s) observed — the fleet is STILL writing directly`);
      line(`\n   ⛔ ${suspect.length} NON-SERVER WRITE(S). Most recent:`);
      for (const r of suspect.slice(-5)) {
        line(`      ${r.observed_at}  ${r.source_table}  via=${r.updated_via ?? '(null)'}  build=${r.updated_by_build}`);
      }
    }
    // The half that has been missing: emptiness is not cleanliness.
    if (server.length < MIN_SERVER_OBSERVATIONS) {
      fail.push(`only ${server.length} server write(s) observed (need >= ${MIN_SERVER_OBSERVATIONS}) — the sample is EMPTY, not clean`);
    }
    if (server.length >= 2) {
      const spanH = (new Date(server[server.length - 1].observed_at) - new Date(server[0].observed_at)) / 3600000;
      line(`\n   server writes span ${spanH.toFixed(1)}h`);
      if (spanH < MIN_SPAN_HOURS) {
        fail.push(`server writes span only ${spanH.toFixed(1)}h (need >= ${MIN_SPAN_HOURS}h) — not a real operating window`);
      }
    }
  }
}

// ── 2. the live tables, as context only ──────────────────────────────────
line('\n2. LIVE TABLE STAMPS (context — subject to erasure, NOT the verdict)');
{
  const { data: os } = await db.from('org_state').select('updated_via, updated_by_build, updated_at, version');
  for (const r of os || []) {
    line(`   org_state  via=${r.updated_via ?? '(null)'}  build=${r.updated_by_build}  v${r.version}  ${r.updated_at}`);
  }
  line('   ^ one row, one stamp — this can never prove a browser write did NOT happen.');

  for (const via of ['server', 'browser', null]) {
    let q = db.from('jobs').select('id', { count: 'exact', head: true });
    q = via === null ? q.is('updated_via', null) : q.eq('updated_via', via);
    const { count } = await q;
    line(`   jobs  updated_via=${via ?? '(null)'} ......... ${count}`);
  }
  const { count: jobsTotal } = await db.from('jobs').select('id', { count: 'exact', head: true });
  line(`   jobs  TOTAL ......................... ${jobsTotal}`);
}

// ── 3. the policies 1e actually revokes ──────────────────────────────────
line('\n3. BROWSER WRITE POLICIES (what 1e removes)');
// pg_policies is not reachable through PostgREST, so this is an explicit manual
// step rather than a silently-skipped check.
line('   Not queryable from here. Confirm with:');
line('     node scripts/run-migration.mjs --sql "select tablename, policyname, cmd \\');
line('       from pg_policies where schemaname=\'public\' \\');
line('       and tablename in (\'org_state\',\'jobs\') and cmd <> \'SELECT\' order by 1,2"');
warn.push('browser write-policy inventory is manual — confirm it before revoking');

// ── verdict ──────────────────────────────────────────────────────────────
line(`\n${'='.repeat(72)}`);
if (fail.length) {
  line('VERDICT: ⛔ NOT GREEN — do NOT revoke.\n');
  for (const f of fail) line(`  • ${f}`);
  for (const w of warn) line(`  ~ ${w}`);
  line('');
  process.exit(1);
}
line('VERDICT: ✅ GREEN — the observed window shows server-only writes at a');
line('         realistic volume and span.\n');
for (const w of warn) line(`  ~ ${w}`);
line('\n  Still required before revoking, and NOT checked here: the jobs write guard');
line('  (jobsGuard.js) and the org_state guard must both be DEPLOYED, or 1e relocates');
line('  the self-assignment and mass-delete primitives behind the server endpoint');
line('  instead of closing them.\n');
