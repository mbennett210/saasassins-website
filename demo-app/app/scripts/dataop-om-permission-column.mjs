// LIVE DATA-OP — give the Operations Manager's permission column its starting rows in the shared
// org_state matrix (CS-858, plan docs/plans/2026-10-16-om-permission-column.md §6).
//
// 🔴 NEVER RUN THIS AGAINST PRODUCTION WITHOUT THE OWNER'S RECORDED GO. A dry run against
//    production is still a production connection: it reads the live blob with a production
//    credential. The owner's go is relayed by the orchestrating session and recorded in
//    DATA_AND_SYNC.md §11. Rehearse in the sandbox first.
//
//   node app/scripts/dataop-om-permission-column.mjs                 # DRY RUN, sandbox env
//   node app/scripts/dataop-om-permission-column.mjs --apply         # write, sandbox env
//
//   Production needs CONFIRM_PROD on EVERY invocation, a dry run included — reading the live
//   blob is itself a production connection, so the guard refuses the prod ref without it
//   (§8.2 rule 3):
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-om-permission-column.mjs --prod
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-om-permission-column.mjs --prod --apply
//
//   TWO TRANSPORTS, one guard. The service-role pair (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//   is used whenever it is present; on a machine whose only production credential is
//   SUPABASE_DB_URL, preload it and the op talks to Postgres directly, on the same plan and under
//   the same guard. A worktree has no app/.env.local of its own, so the relative read below finds
//   nothing and the preloaded environment is the source:
//   CONFIRM_PROD=<prod ref> node --env-file="<checkout>/app/.env.local" app/scripts/dataop-om-permission-column.mjs --prod
//   CONFIRM_PROD=<prod ref> node --env-file="<checkout>/app/.env.local" app/scripts/dataop-om-permission-column.mjs --prod --apply
//
// WHY: Settings → Roles gives the Operations Manager a permission column of its own,
// `operations_manager` (lib/roles PERMISSION_COLUMNS). A STORED matrix row wins over the code
// default (lib/roles can()), and production's saved matrix names no such column on any row, so
// the moment the new code runs every Operations Manager would hold NOTHING. This op copies the
// manager column into the new one: `operations_manager` added right after `manager` on every
// stored row whose roles include `manager`, so OMs start with exactly what Account Managers have.
// It touches nothing else — not a row without the manager (the office's own choice is copied,
// never overridden), not a row already carrying the column, not a row outside the app's shape,
// and no slice but `permissions`. The transform is the SAME pure function the demo's v59 → v60
// store hop runs (lib/roles withOpsManagerColumn), so demo and production cannot drift.
//
// RUN ORDER: BEFORE the deploy. Today's code ignores a name in a row that no member's role is
// (can() matches the row against the member's role), so running first changes nothing anyone can
// do, and the new code then finds the column in place. ⚠️ Between this run and the deploy, nobody
// should press Reset in Settings → Roles: the old page resets a row to defaults that predate the
// column.
//
// GUARD CONTRACT (DATA_AND_SYNC.md §8.2). Rules 2 and 3 — which project, may it proceed, and say
// so before the first read — are the SHARED scripts/_lib/liveGuard.mjs (CS-025); rules 1, 4 and 5
// are here, and both halves are re-checked by test-dataop-om-permission-column.mjs:
//   1. dry run is the DEFAULT; writes need `--apply`;
//   2. the target (Supabase ref, org id) is printed before anything else;
//   3. the sandbox env is the default; production needs `--prod` AND `CONFIRM_PROD=<the prod ref>`
//      in the environment, or the prod ref is refused;
//   4. the row is exported to a gitignored backup before the write;
//   5. idempotent (a second run is a no-op that writes nothing), provenance-stamped
//      (`updated_via = 'script:dataop-om-permission-column'`), and READ BACK after the write.
// CAS: the version predicate rides ON the UPDATE (never check-then-write), exactly as
// api/_lib/orgState.writeOrgState does; 0 rows updated = conflict = re-run.
// `protected_fingerprint` is deliberately LEFT ALONE. The matrix IS a protected field, so the next
// browser save takes the full protected-field check against the committed matrix (this run's) and
// raises ONE `org_state.baseline_mismatch` alarm naming the commit since a server writer last
// vouched — by design for any operator write to a protected field (api/state/org-state.js,
// BASELINE INTEGRITY); that save stores a fresh digest. Stamping one here would launder the write.
//
// The live section below is behind a main-module guard, so importing this file (the offline unit
// suite does) opens nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { withOpsManagerColumn, OPS_MANAGER_COLUMN } from '../src/lib/roles.js';
// The ONE ceiling every server write enforces — imported, never restated (THE LAW II.3).
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';
// §8.2 rules 2 and 3, shared by every live data-op (CS-025).
import { PROD_REF, ENV_DEFAULT, ENV_PROD, refFromDbUrl, liveTarget, refuseTarget, printTarget, loadEnv } from './_lib/liveGuard.mjs';

export const OP_NAME = 'dataop-om-permission-column';
export { PROD_REF, ENV_DEFAULT, ENV_PROD, refFromDbUrl, liveTarget, refuseTarget, printTarget };

// A row the app reads (lib/roles can()): an object with a string id and an array of roles.
const wellFormed = (p) => !!p && typeof p === 'object' && typeof p.id === 'string' && Array.isArray(p.roles);
const census = (permissions) => {
  const rows = Array.isArray(permissions) ? permissions : [];
  return {
    rows: rows.length,
    managerRows: rows.filter((p) => wellFormed(p) && p.roles.includes('manager')).length,
    withColumn: rows.filter((p) => wellFormed(p) && p.roles.includes(OPS_MANAGER_COLUMN)).length,
    malformed: rows.filter((p) => !wellFormed(p)).length,
  };
};
// JSON with every object's keys sorted: the same value whatever order jsonb hands back.
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// The whole plan, pure: the matrix before, the matrix after, which rows gain the column, and
// whether there is anything to do at all. `changed` false means a re-run is a no-op, so --apply
// refuses to burn an org_state version.
export function planOmColumnOp({ permissions = null } = {}) {
  const { permissions: next, added } = withOpsManagerColumn(permissions);
  return { permissions: next, added, before: census(permissions), after: census(next), changed: added.length > 0 };
}

// ── the Postgres transport ───────────────────────────────────────────────────
// The two statements the op needs, parameterized, on an injected `pg.Client` — injected so the
// offline suite can drive the whole op on a fake that records `query(text, params)`.
// node-postgres hands `bigint` back as a STRING (PostgREST hands back a number), so `version` is
// normalized here or `version + 1` would concatenate instead of adding.
export function pgTransport(client) {
  return {
    readOrgState: async (org) => {
      const { rows } = await client.query(
        'select state, version from public.org_state where organization_id = $1', [org]);
      return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : null;
    },
    casWrite: async ({ org, baseVersion, state }) => {
      const { rows } = await client.query(
        'update public.org_state set state = $1::jsonb, version = version + 1, updated_at = now(),'
        + ' updated_via = $2, updated_by = null, updated_by_build = null, updated_by_tab = $3'
        + ' where organization_id = $4 and version = $5 returning version',
        [state, `script:${OP_NAME}`, `script:${OP_NAME}`, org, baseVersion]);
      return rows;
    },
  };
}

// ── the supabase-js transport (the service-role pair) ────────────────────────
// The same two statements over PostgREST, on an injected client (the live section builds it).
// PROVENANCE (§8.2 rule 5): an UPDATE that omits a column keeps the LAST writer's value, so the
// audit row would credit whoever saved last; `updated_by` (uuid) and `updated_by_build` (bigint)
// are null — a script has no human author and no client build — and `updated_by_tab` names it.
export function supabaseTransport(db) {
  return {
    readOrgState: async (org) => {
      const { data, error } = await db.from('org_state').select('state, version').eq('organization_id', org).maybeSingle();
      if (error) throw new Error(`org_state read failed: ${error.message}`);
      return data ? { state: data.state, version: Number(data.version) } : null;
    },
    casWrite: async ({ org, baseVersion, state, nowIso }) => {
      const { data, error } = await db.from('org_state')
        .update({
          state,
          version: (baseVersion || 0) + 1,
          updated_at: nowIso,
          updated_via: `script:${OP_NAME}`,
          updated_by: null,
          updated_by_build: null,
          updated_by_tab: `script:${OP_NAME}`,
        })
        .eq('organization_id', org).eq('version', baseVersion)
        .select('version');
      if (error) throw new Error(error.message);
      return data || [];
    },
  };
}

// ── the op ───────────────────────────────────────────────────────────────────
// Everything after the target is printed, on whichever transport was chosen. Returns the exit
// code rather than ending the process itself (`process.exitCode` only).
export async function runOmColumnOp({
  t, org, apply = false, now = new Date(), backupDir = new URL('./', import.meta.url),
  log = console.log, err = console.error,
} = {}) {
  let snap;
  try {
    snap = await t.readOrgState(org);
  } catch (e) { err(e.message); return 1; }
  if (!snap?.state) { err('org_state not initialized for this org.'); return 1; }

  const state = snap.state;
  const plan = planOmColumnOp({ permissions: Array.isArray(state.permissions) ? state.permissions : null });
  const line = (label, value, tail = '') => log(`          ${label.padEnd(30)}: ${value}${tail}`);
  log(`  org_state    : v${snap.version}, ${plan.before.rows} permission rows`);
  log('');
  log('  BEFORE');
  line('rows naming the manager', plan.before.managerRows);
  line('rows naming the OM column', plan.before.withColumn);
  line("rows not in the app's shape", plan.before.malformed, plan.before.malformed ? '  (left as they are)' : '');
  log('  AFTER');
  line('rows naming the OM column', plan.after.withColumn);
  log(`          (${plan.added.length} row(s) gain ${OPS_MANAGER_COLUMN}, right after manager)\n`);
  const before = new Map((state.permissions || []).filter(wellFormed).map((p) => [p.id, p.roles]));
  for (const p of plan.permissions || []) {
    if (!wellFormed(p) || !plan.added.includes(p.id)) continue;
    log(`   · ${p.id.padEnd(28)} ${before.get(p.id).join(', ')}  →  ${p.roles.join(', ')}`);
  }

  if (!Array.isArray(state.permissions)) {
    log('\n✓ No stored matrix: the code defaults apply, and they carry the OM column. No-op.\n');
    return 0;
  }
  if (!plan.changed) {
    log('\n✓ Every row naming the manager already carries the OM column. No-op.\n');
    return 0;
  }
  if (!apply) {
    log('\n--dry-run (the default): nothing written. Re-run with --apply to arm.\n');
    return 0;
  }

  const nextState = { ...state, permissions: plan.permissions };
  const bytes = Buffer.byteLength(JSON.stringify(nextState), 'utf8');
  if (bytes > MAX_STATE_BYTES) {
    err(`Refusing: the result is ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_STATE_BYTES / 1024)} KB ceiling.`);
    return 1;
  }

  // (4) backup first, on the gitignored pattern, and prove it parses
  const nowIso = now.toISOString();
  const backupName = `orgstate-backup-${nowIso.replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL(`./${backupName}`, backupDir), JSON.stringify({ version: snap.version, state }));
  JSON.parse(readFileSync(new URL(`./${backupName}`, backupDir), 'utf8'));

  // (5) CAS: the version predicate rides ON the update.
  let wrote;
  try {
    wrote = await t.casWrite({ org, baseVersion: snap.version, state: nextState, nowIso });
  } catch (e) { err(`Write failed: ${e.message}`); return 1; }
  if (!wrote || !wrote.length) {
    err('CAS conflict — org_state changed under me. Nothing written; re-run.');
    return 1;
  }

  // (5) READ BACK: the committed row must be this write — the next version, the planned matrix
  // (compared key-order-insensitively: jsonb hands keys back in its own order) — and a re-plan on
  // it must have nothing left to do.
  let back;
  try {
    back = await t.readOrgState(org);
  } catch (e) { err(`read-back failed: ${e.message}. The write committed; re-run the dry run to check, backup app/scripts/${backupName}.`); return 1; }
  const backPlan = planOmColumnOp({ permissions: Array.isArray(back?.state?.permissions) ? back.state.permissions : null });
  if (!back || back.version !== snap.version + 1 || canonical(back.state.permissions) !== canonical(plan.permissions) || backPlan.changed) {
    err(`read-back does not match the write (read v${back?.version ?? '?'}, expected v${snap.version + 1} with the planned matrix).`);
    err(`  Another writer may have landed in between, or the write did not hold. Restore from the backup app/scripts/${backupName} if needed.`);
    return 1;
  }
  log(`\n✓ ${plan.added.length} row(s) gained ${OPS_MANAGER_COLUMN}. org_state v${snap.version} → ${snap.version + 1}.`);
  log(`  Read back: v${back.version}, ${backPlan.after.withColumn} of ${backPlan.after.managerRows} manager rows carry the column (0 left to add).`);
  log(`  Backup: app/scripts/${backupName}`);
  log('  Expect ONE org_state.baseline_mismatch on the next browser save (an operator write to a protected field); that save heals the digest.\n');
  return 0;
}

// ── live section ─────────────────────────────────────────────────────────────
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const APPLY = process.argv.includes('--apply');
  const PROD = process.argv.includes('--prod');

  // (3) env: the sandbox unless production is asked for explicitly. A run started with
  // `node --env-file=<checkout>/app/.env.local …` already carries the credential, and this
  // relative read simply finds nothing — a worktree has no env file of its own.
  const envFile = PROD ? ENV_PROD : ENV_DEFAULT;
  const loaded = loadEnv(envFile, import.meta.url);

  const { transport, ref } = liveTarget(process.env);
  const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
  const refusal = transport && refuseTarget({ transport, ref, prod: PROD, confirmProd: process.env.CONFIRM_PROD });

  if (!transport) {
    console.error(`Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_DB_URL (looked in app/${envFile.replace('../', '')}${loaded ? '' : ' — file not found'}).`);
    console.error(PROD ? '' : 'Sandbox is the default. Pass --prod for production (see the guard contract).');
    process.exitCode = 1;
  } else if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
  } else {
    // (2) §8.2 rule 2: name the target BEFORE the first read.
    printTarget({
      op: OP_NAME, ref: ref || '(unknown)', org: ORG, transport, apply: APPLY,
      envLabel: loaded ? `app/${envFile.replace('../', '')}` : 'the preloaded environment',
    });

    if (transport === 'pg') {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
      try {
        // ONCE. Supabase bans an address after a few failed password attempts, so a connect that
        // fails is reported, never retried.
        await client.connect();
        process.exitCode = await runOmColumnOp({ t: pgTransport(client), org: ORG, apply: APPLY });
      } catch (e) {
        console.error('connect failed:', e.message);
        process.exitCode = 1;
      } finally { await client.end().catch(() => {}); }
    } else {
      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      process.exitCode = await runOmColumnOp({ t: supabaseTransport(db), org: ORG, apply: APPLY });
    }
  }
}
