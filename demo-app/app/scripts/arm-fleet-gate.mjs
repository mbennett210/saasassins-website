// Arm (or disarm) the Increment 0.3 fleet-reload gate — `org_state.min_client_build`.
//
//   node scripts/arm-fleet-gate.mjs                      # inspect only (default)
//   node scripts/arm-fleet-gate.mjs --build <id>         # dry run of a specific floor
//   node scripts/arm-fleet-gate.mjs --build <id> --apply # write it
//   node scripts/arm-fleet-gate.mjs --disarm --apply     # back to NULL (always safe)
//
// TWO TRANSPORTS. The service-role pair (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) is used
// whenever it is present. On a machine whose only production credential is SUPABASE_DB_URL
// — the Postgres connection string `apply-migration.mjs` already runs on — preload it and
// the script talks to Postgres directly, on the same refusals:
//   node --env-file="<checkout>/app/.env.local" app/scripts/arm-fleet-gate.mjs
//
// ══ WHAT THIS DOES, AND WHY IT IS THE DANGEROUS ONE ══════════════════════════
//
// `min_client_build` is the floor below which a tab must reload before it may write.
// sync.js:158 `isBuildTooOld()` is `APP_BUILD > 0 && minClientBuild > 0 && APP_BUILD
// < minClientBuild`, so the gate is INERT until this is set — it is NULL live today,
// which is why no prune has ever been safe: a prune with old tabs still writing lets
// them re-bloat the blob from stale in-memory state.
//
// The failure mode is not subtle. `APP_BUILD` is a millisecond timestamp of WHEN THE
// BUNDLE WAS BUILT, baked in at build time (vite.config.js). Set the floor above the
// newest deployed build and EVERY tab is below it: every user is told to reload, reloads
// into the same bundle, is still below the floor, and can never write again. There is no
// client-side recovery — the fix has to come from the database.
//
// So this script refuses to set a floor above the highest build id it can OBSERVE
// having written. That is the only evidence available that a build actually exists and
// is deployed; a build id nobody has written under may be a typo, a preview
// deployment, or a bundle that never shipped.
//
// Deliberately NOT derived from the clock. A "now" floor is above every build that
// exists, which is precisely the fleet-wide lockout above.
//
// The live section is behind a main-module guard, so importing this file (the offline unit
// suite does) opens nothing.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The evidence window. Bounded on both reads, newest first — the top of that window is
// all the refusal needs, and an unbounded scan of the append-only sink is a table scan.
export const OBSERVED_LIMIT = 5000;

// ── the Postgres transport ───────────────────────────────────────────────────
// The reads and the two writes, parameterized, on an injected `pg.Client` — injected so the
// offline suite can drive the whole op on a fake that records `query(text, params)`.
// node-postgres hands `bigint` back as a STRING and `timestamptz` as a Date (PostgREST
// hands back a number and an ISO string), so both are normalized here: left alone,
// `wantBuild > maxBuild` compares a number with a string and the printed times change shape.
const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : v);

export function pgTransport(client) {
  return {
    readOrg: async () => {
      const { rows } = await client.query(
        'select organization_id, version, min_client_build, freeze_strip, updated_by_build,'
        + ' updated_via, updated_at from public.org_state order by organization_id limit 1');
      const r = rows[0];
      return r ? {
        ...r,
        version: num(r.version),
        min_client_build: num(r.min_client_build),
        updated_by_build: num(r.updated_by_build),
        updated_at: iso(r.updated_at),
      } : null;
    },
    // The append-only sink is the good source once it exists; null means "not there yet",
    // which is survivable — org_state + jobs still carry evidence.
    observedSink: async (limit) => {
      try {
        const { rows } = await client.query(
          'select updated_by_build, observed_at from public.org_state_writes_seen'
          + ' order by observed_at desc limit $1', [limit]);
        return rows.map((r) => ({ updated_by_build: num(r.updated_by_build), observed_at: iso(r.observed_at) }));
      } catch { return null; }
    },
    observedJobs: async (limit) => {
      try {
        const { rows } = await client.query(
          'select updated_by_build, updated_at from public.jobs where updated_by_build is not null'
          + ' order by updated_at desc limit $1', [limit]);
        return rows.map((r) => ({ updated_by_build: num(r.updated_by_build), updated_at: iso(r.updated_at) }));
      } catch { return null; }
    },
    // CAS on the value the run read, so a concurrent change is not silently clobbered.
    // Two whole statements rather than one with a spliced predicate: nothing is built by
    // string, and each shape is readable on its own.
    arm: async ({ org, value, current }) => {
      const { rows } = current === null || current === undefined
        ? await client.query(
          'update public.org_state set min_client_build = $1 where organization_id = $2'
          + ' and min_client_build is null returning min_client_build', [value, org])
        : await client.query(
          'update public.org_state set min_client_build = $1 where organization_id = $2'
          + ' and min_client_build = $3 returning min_client_build', [value, org, current]);
      return rows;
    },
    // No CAS: clearing the floor can never lock anyone out, so it is unconditional.
    disarm: async (org) => {
      await client.query(
        'update public.org_state set min_client_build = null where organization_id = $1', [org]);
    },
    readGate: async (org) => {
      const { rows } = await client.query(
        'select min_client_build from public.org_state where organization_id = $1', [org]);
      return num(rows[0]?.min_client_build);
    },
  };
}

// ── the op ───────────────────────────────────────────────────────────────────
// Every refusal and every print, on whichever transport was chosen. Returns the exit code
// rather than ending the process itself: after network I/O, exiting outright takes node
// down on Windows with a libuv assertion. `process.exitCode` only.
export async function runFleetGate({ t, argv = [], log = console.log, err = console.error } = {}) {
  const APPLY = argv.includes('--apply');
  const DISARM = argv.includes('--disarm');
  const bi = argv.indexOf('--build');
  const wantBuild = bi >= 0 ? Number(argv[bi + 1]) : null;
  const p = (s = '') => log(s);

  // ── current state ─────────────────────────────────────────────────────────
  let org;
  try { org = await t.readOrg(); } catch (e) { err('read failed:', e.message); return 1; }
  if (!org) { err('read failed: no org_state row'); return 1; }

  p(`\nFLEET GATE — org ${org.organization_id}`);
  p('='.repeat(70));
  p(`  min_client_build : ${org.min_client_build ?? 'NULL  (gate INERT — isBuildTooOld can never fire)'}`);
  p(`  freeze_strip     : ${org.freeze_strip ? JSON.stringify(org.freeze_strip) : 'NULL'}`);
  p(`  doc version      : ${org.version}`);
  p(`  last write       : build ${org.updated_by_build} via ${org.updated_via ?? '(null)'} at ${org.updated_at}`);

  // ── observed builds: the ONLY evidence a build is real and deployed ──────
  const seen = new Map(); // build -> { n, last }
  const note = (b, at) => {
    // A null column is NOT build 0 — pre-1d sink rows carry no build, and letting them
    // register would make "no build has ever been observed" unreachable.
    if (b === null || b === undefined || b === '' || !Number.isFinite(Number(b))) return;
    const k = Number(b);
    const e = seen.get(k) || { n: 0, last: '' };
    e.n += 1; if (at > e.last) e.last = at;
    seen.set(k, e);
  };
  if (org.updated_by_build) note(org.updated_by_build, org.updated_at);

  const sink = await t.observedSink(OBSERVED_LIMIT);
  for (const r of sink || []) note(r.updated_by_build, r.observed_at);
  const jobs = await t.observedJobs(OBSERVED_LIMIT);
  for (const r of jobs || []) note(r.updated_by_build, r.updated_at);

  const builds = [...seen.entries()].sort((a, b) => b[0] - a[0]);
  p(`\nOBSERVED BUILD IDS (${builds.length}) ${sink ? '' : '— sink absent, from org_state + jobs only'}`);
  if (!builds.length) { p('  none — cannot verify any build exists. Refusing to arm.'); }
  for (const [b, e] of builds.slice(0, 12)) {
    p(`  ${b}   ${new Date(b).toISOString()}   ${String(e.n).padStart(5)} write(s)   last ${e.last}`);
  }
  const maxBuild = builds.length ? builds[0][0] : null;

  // ── disarm ────────────────────────────────────────────────────────────────
  if (DISARM) {
    p('\nDISARM → min_client_build = NULL (always safe: the gate simply stops firing)');
    if (!APPLY) { p('Dry run — nothing written. Re-run with --apply.\n'); return 0; }
    try { await t.disarm(org.organization_id); } catch (e) { err('write failed:', e.message); return 1; }
    const after = await t.readGate(org.organization_id);
    p(`✓ disarmed — min_client_build is now ${after ?? 'NULL'}\n`);
    return 0;
  }

  if (wantBuild === null) {
    p('\nNo --build given — inspection only.');
    if (maxBuild) p(`Highest observed build is ${maxBuild}; arming at that value asks every OLDER tab to reload once.`);
    p('');
    return 0;
  }

  // ── the refusals ──────────────────────────────────────────────────────────
  if (!Number.isFinite(wantBuild) || wantBuild <= 0) {
    err(`\n⛔ --build must be a positive number, got "${argv[bi + 1]}".\n`); return 1;
  }
  if (!maxBuild) {
    err('\n⛔ No build id has ever been observed writing. Cannot verify the target exists.\n'); return 1;
  }
  if (wantBuild > maxBuild) {
    err(`\n⛔ REFUSING: ${wantBuild} is ABOVE the highest observed build ${maxBuild}.`);
    err('   Every tab would be below the floor, told to reload, and reload into a bundle');
    err('   that is still below it — a permanent fleet-wide write outage with no');
    err('   client-side recovery. If a newer build really is deployed, wait until it has');
    err('   written once so it can be observed, then re-run.\n');
    return 1;
  }

  // ── impact ────────────────────────────────────────────────────────────────
  const below = builds.filter(([b]) => b < wantBuild);
  const atOrAbove = builds.filter(([b]) => b >= wantBuild);
  p(`\nARM → min_client_build = ${wantBuild}  (${new Date(wantBuild).toISOString()})`);
  p(`  builds AT/ABOVE the floor (keep writing) : ${atOrAbove.length}  ${atOrAbove.map(([b]) => b).join(', ') || '—'}`);
  p(`  builds BELOW the floor (reload once)     : ${below.length}  ${below.map(([b]) => b).join(', ') || '—'}`);
  if (org.min_client_build && wantBuild < org.min_client_build) {
    p(`  ⚠️  LOWERING the floor from ${org.min_client_build} — allowed, but it re-admits older tabs.`);
  }
  if (!APPLY) { p('\nDry run — nothing written. Re-run with --apply.\n'); return 0; }

  let written;
  try {
    written = await t.arm({ org: org.organization_id, value: wantBuild, current: org.min_client_build ?? null });
  } catch (e) { err('write failed:', e.message); return 1; }
  if (!written || !written.length) {
    err('\n⛔ CAS MISS — min_client_build changed since this script read it. Nothing written. Re-run.\n');
    return 1;
  }
  const after = await t.readGate(org.organization_id);
  p(`\n✓ armed — min_client_build is now ${after}`);
  p('  Tabs below the floor reload ONCE per page-load (sync.js guards against a loop).');
  p('  Rollback: node scripts/arm-fleet-gate.mjs --disarm --apply\n');
  return 0;
}

// ── live section ─────────────────────────────────────────────────────────────
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through: the environment may already carry the credential */ }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const t = {
      readOrg: async () => {
        const { data, error } = await db.from('org_state')
          .select('organization_id, version, min_client_build, freeze_strip, updated_by_build, updated_via, updated_at')
          .limit(1).maybeSingle();
        if (error) throw new Error(error.message);
        return data || null;
      },
      observedSink: async (limit) => {
        const r = await db.from('org_state_writes_seen')
          .select('updated_by_build, observed_at').order('observed_at', { ascending: false }).limit(limit);
        return r.error ? null : (r.data || []);
      },
      observedJobs: async (limit) => {
        const r = await db.from('jobs')
          .select('updated_by_build, updated_at').not('updated_by_build', 'is', null)
          .order('updated_at', { ascending: false }).limit(limit);
        return r.error ? null : (r.data || []);
      },
      arm: async ({ org, value, current }) => {
        const q = db.from('org_state').update({ min_client_build: value }).eq('organization_id', org);
        const { data, error } = await (current === null || current === undefined
          ? q.is('min_client_build', null)
          : q.eq('min_client_build', current)).select('min_client_build');
        if (error) throw new Error(error.message);
        return data || [];
      },
      disarm: async (org) => {
        const { error } = await db.from('org_state').update({ min_client_build: null }).eq('organization_id', org);
        if (error) throw new Error(error.message);
      },
      readGate: async (org) => {
        const { data } = await db.from('org_state').select('min_client_build').eq('organization_id', org).maybeSingle();
        return data?.min_client_build ?? null;
      },
    };
    process.exitCode = await runFleetGate({ t, argv: process.argv });
  } else if (process.env.SUPABASE_DB_URL) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    try {
      // ONCE. Supabase bans an address after a few failed password attempts, so a connect
      // that fails is reported, never retried.
      await client.connect();
      process.exitCode = await runFleetGate({ t: pgTransport(client), argv: process.argv });
    } catch (e) {
      console.error('connect failed:', e.message);
      process.exitCode = 1;
    } finally { await client.end().catch(() => {}); }
  } else {
    console.error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_DB_URL (looked in app/.env.local).');
    process.exitCode = 1;
  }
}
