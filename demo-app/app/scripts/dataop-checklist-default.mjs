// LIVE DATA-OP — retire the location-wide default checklist in the shared org_state blob
// (R3, Daniel 2026-09-27; plan docs/plans/2026-09-27-checklists-by-location.md step 2).
//
// 🔴 NEVER RUN THIS AGAINST PRODUCTION WITHOUT THE OWNER'S RECORDED GO. A dry run against
//    production is still a production connection: it reads the live blob with a
//    production credential. The owner's go is relayed by the orchestrating session and
//    recorded in DATA_AND_SYNC.md §11. Rehearse in the sandbox first.
//
//   node app/scripts/dataop-checklist-default.mjs                 # DRY RUN, sandbox env
//   node app/scripts/dataop-checklist-default.mjs --apply         # write, sandbox env
//
//   Production needs CONFIRM_PROD on EVERY invocation, a dry run included — reading the
//   live blob is itself a production connection, so the guard refuses the prod ref
//   without it (§8.2 rule 3):
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-checklist-default.mjs --prod
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-checklist-default.mjs --prod --apply
//
//   TWO TRANSPORTS, one guard. The service-role pair (SUPABASE_URL +
//   SUPABASE_SERVICE_ROLE_KEY) is used whenever it is present. On a machine whose only
//   production credential is SUPABASE_DB_URL — the Postgres connection string
//   `apply-migration.mjs` already runs on — preload it and the op talks to Postgres
//   directly, on the same plan and under the same guard. A worktree has no app/.env.local
//   of its own, so the relative read below finds nothing and the preloaded environment is
//   the source:
//   CONFIRM_PROD=<prod ref> node --env-file="<checkout>/app/.env.local" app/scripts/dataop-checklist-default.mjs --prod
//   CONFIRM_PROD=<prod ref> node --env-file="<checkout>/app/.env.local" app/scripts/dataop-checklist-default.mjs --prod --apply
//   (PowerShell: $env:CONFIRM_PROD='<prod ref>'; node --env-file="…" … --prod)
//
// WHY: `persist.js` migrations (the v56 → v57 hop) run in LOCAL/DEMO mode only — the live
// Supabase blob hydrates raw and never sees them (brain/recipes/version-bump-decision.md).
// So the same conversion ships as a separate data-op (THE LAW II.8 · DEV_PLAYBOOK 3.5.10).
// It is safe to run BEFORE the code deploys, because the old code already honours a
// cleaner's own pick — converting first means no cleaner loses their checklist for a
// moment in between.
//
// WHAT: for every customer carrying `checklistTemplateId`, each cleaner scheduled on one of
// that location's upcoming / in-progress cleans who has no pick of their own inherits the
// saved default as their own pick; then the field is DELETED. A cleaner's own pick is never
// overwritten. The transform is the SAME pure function the store migration uses
// (`retireLocationDefaultsV57` in app/src/lib/crewChecklist.js), so demo and production
// cannot drift.
//
// WHERE THE CLEANS COME FROM: `public.jobs`, not the blob — jobs live per row and client
// saves write the blob's own `jobs` array empty (BUILD_INTEGRITY §1, the B1 split).
//
// GUARD CONTRACT (DATA_AND_SYNC.md §8.2). Rules 2 and 3 — which project this is pointed at,
// whether it may proceed, and saying so before the first read — now live in the SHARED
// `scripts/_lib/liveGuard.mjs` (the direction CS-025 names), imported and re-exported below
// so this module's API is unchanged; rules 1, 4 and 5 are in this op's own body, because
// only the op knows what it would write. Both halves are re-checked mechanically by
// test-dataop-checklist-default.mjs:
//   1. dry run is the DEFAULT; writes need `--apply`;
//   2. the target (Supabase ref, org id, row counts) is printed before anything else;
//   3. the sandbox env is the default; production needs `--prod` AND
//      `CONFIRM_PROD=<the prod ref>` in the environment, or the prod ref is refused;
//   4. the rows that will change are exported to a gitignored backup before the write;
//   5. idempotent, and provenance-stamped (`updated_via = 'script:dataop-checklist-default'`).
// CAS: the version predicate rides ON the UPDATE (never check-then-write), exactly as
// `api/_lib/orgState.writeOrgState` does; 0 rows updated = conflict = re-run.
// `protected_fingerprint` is deliberately LEFT ALONE: the fields this touches are
// unprotected, and leaving the column stale makes the next browser save take the full
// protected-field check instead of laundering a script write.
//
// The live section below is behind a main-module guard, so importing this file (the offline
// unit suite does) opens nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { retireLocationDefaultsV57, RETIRE_DEFAULT_JOB_STATUSES } from '../src/lib/crewChecklist.js';
// The ONE ceiling every server write enforces — imported, never restated (THE LAW II.3).
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';
// §8.2 rules 2 and 3, shared by every live data-op (CS-025).
import { PROD_REF, ENV_DEFAULT, ENV_PROD, refFromDbUrl, liveTarget, refuseTarget, printTarget, loadEnv } from './_lib/liveGuard.mjs';

export const OP_NAME = 'dataop-checklist-default';
// Re-exported so this module's API — and every suite reading it — is unchanged.
export { PROD_REF, ENV_DEFAULT, ENV_PROD, refFromDbUrl, liveTarget, refuseTarget, printTarget };
// Narrow read (DEV_PLAYBOOK 3.5.15): the scalar columns plus the crew ids lifted out of
// `data`, never the whole job document.
export const JOB_SELECT = 'id,client_id,status,crewIds:data->crewIds';
export const PAGE = 1000;
// D4: the statuses come from the rule module, so the op and the store migration can never
// disagree about which cleans a conversion reads.
export const OP_JOB_STATUSES = RETIRE_DEFAULT_JOB_STATUSES;

// public.jobs rows → the shape retireLocationDefaultsV57 reads. A jsonb value that is not
// an array (a hand-written row, or a job with no crew) becomes [].
export function jobRowsToCleans(rows) {
  return (rows || []).map((r) => ({
    id: r.id,
    clientId: r.client_id ?? null,
    status: r.status ?? null,
    crewIds: Array.isArray(r.crewIds) ? r.crewIds : [],
  }));
}

const countAssignments = (clients) => (clients || []).reduce(
  (n, c) => n + Object.keys(c?.crewChecklists || {}).length, 0,
);
// A real default to convert, versus a key a stale tab wrote back as null — counted apart,
// because the op's verification is "re-run and see ZERO conversions" (D5).
const countDefaults = (clients) => (clients || []).filter((c) => c && c.checklistTemplateId).length;
const countStaleNullKeys = (clients) => (clients || [])
  .filter((c) => c && 'checklistTemplateId' in c && !c.checklistTemplateId).length;
const census = (clients) => ({
  clientsWithDefault: countDefaults(clients),
  staleNullKeys: countStaleNullKeys(clients),
  assignments: countAssignments(clients),
});

// The whole plan, pure: what the blob looks like before, what it would look like after, and
// whether there is anything to do at all. `changed` false means a re-run is a no-op, so
// `--apply` refuses to burn an org_state version.
export function planChecklistDefaultOp({ clients = [], jobs = [] } = {}) {
  const before = census(clients);
  const { clients: next, converted, cleaned, assignmentsAdded } = retireLocationDefaultsV57({ clients, jobs });
  return {
    clients: next, before, after: census(next), converted, cleaned, assignmentsAdded,
    changed: converted.length > 0 || cleaned.length > 0,
  };
}

// ── the Postgres transport ───────────────────────────────────────────────────
// The four statements the op needs, parameterized, on an injected `pg.Client` — injected so
// the offline suite can drive the whole op on a fake that records `query(text, params)`.
// node-postgres hands `bigint` back as a STRING (PostgREST hands back a number), so
// `version` is normalized here or `version + 1` would concatenate instead of adding.
export function pgTransport(client) {
  return {
    readOrgState: async (org) => {
      const { rows } = await client.query(
        'select state, version from public.org_state where organization_id = $1', [org]);
      return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : null;
    },
    countJobs: async (org) => {
      const { rows } = await client.query(
        'select count(*)::int as n from public.jobs where organization_id = $1 and status = any($2)',
        [org, OP_JOB_STATUSES]);
      return rows[0]?.n ?? 0;
    },
    // No PostgREST row cap on this transport, so ONE ordered statement is the complete set;
    // the caller proves it against the count rather than trusting it.
    readJobs: async (org) => {
      const { rows } = await client.query(
        'select id, client_id, status, data->\'crewIds\' as "crewIds" from public.jobs'
        + ' where organization_id = $1 and status = any($2) order by id',
        [org, OP_JOB_STATUSES]);
      return rows;
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

// ── the op ───────────────────────────────────────────────────────────────────
// Everything after the target is printed, on whichever transport was chosen. Returns the
// exit code rather than ending the process itself: after network I/O, exiting outright
// takes node down on Windows with a libuv assertion. `process.exitCode` only.
export async function runChecklistDefaultOp({
  t, org, apply = false, now = new Date(), backupDir = new URL('./', import.meta.url),
  log = console.log, err = console.error,
} = {}) {
  let snap, count, rows;
  try {
    snap = await t.readOrgState(org);
    if (!snap?.state) { err('org_state not initialized for this org.'); return 1; }
    // the cleans: count-first, ordered (THE LAW II.7 fetch strategy)
    count = await t.countJobs(org);
    rows = await t.readJobs(org);
  } catch (e) { err(e.message); return 1; }

  // A read that does not match its own count is an incomplete read, and a plan computed
  // from one silently drops a cleaner's checklist. Refuse; the table moved, so re-run.
  if (rows.length !== count) {
    err(`jobs read is incomplete: ${rows.length} row(s) for a count of ${count}. Nothing written; re-run.`);
    return 1;
  }

  const state = snap.state;
  const jobs = jobRowsToCleans(rows);
  const plan = planChecklistDefaultOp({ clients: state.clients || [], jobs });

  log(`  org_state    : v${snap.version}, ${(state.clients || []).length} customers`);
  log(`  cleans read  : ${jobs.length} ${OP_JOB_STATUSES.join('/')} rows from public.jobs (count said ${count})`);
  const censusLines = (label, c) => {
    log(`  ${label}  customers with a location default : ${c.clientsWithDefault}`);
    log(`          present-but-null keys (stale tab)  : ${c.staleNullKeys}`);
    log(`          per-cleaner assignments            : ${c.assignments}`);
  };
  log('');
  censusLines('BEFORE', plan.before);
  censusLines('AFTER ', plan.after);
  log(`          (${plan.converted.length} converted, ${plan.cleaned.length} dead key(s) cleaned up, ${plan.assignmentsAdded} assignment(s) added)\n`);
  const nameOf = (id) => (state.clients || []).find((c) => c.id === id)?.name || id;
  for (const row of plan.converted) {
    log(`   · ${nameOf(row.clientId)}  default=${row.templateId}  → ${row.addedUserIds.length ? row.addedUserIds.join(', ') : 'nobody scheduled'}`);
  }
  for (const id of plan.cleaned) {
    log(`   · ${nameOf(id)}  dead key (null) — removed, nobody gains a checklist`);
  }

  if (!plan.changed) {
    log('\n✓ No customer carries a location default — already retired. No-op.\n');
    return 0;
  }
  if (!apply) {
    log('\n--dry-run (the default): nothing written. Re-run with --apply to arm.\n');
    return 0;
  }

  const nextState = { ...state, clients: plan.clients };
  const bytes = Buffer.byteLength(JSON.stringify(nextState), 'utf8');
  if (bytes > MAX_STATE_BYTES) {
    err(`Refusing: the result is ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_STATE_BYTES / 1024)} KB ceiling.`);
    return 1;
  }

  // (4) backup first, on the gitignored pattern
  const nowIso = now.toISOString();
  const backupName = `orgstate-backup-${nowIso.replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL(`./${backupName}`, backupDir), JSON.stringify({ version: snap.version, state }));
  JSON.parse(readFileSync(new URL(`./${backupName}`, backupDir), 'utf8')); // it parses

  // (5) CAS: the version predicate rides ON the update.
  // PROVENANCE (§8.2 rule 5): an UPDATE that omits a column keeps the LAST writer's value,
  // so the append-only audit row (org_state_writes_seen, which copies updated_by / _build /
  // _tab) would credit whichever user saved last for a script write. All three are set to
  // what the schema allows: `updated_by` is uuid → null (a script has no human author, as
  // writeOrgState does); `updated_by_build` is bigint → null (no client build);
  // `updated_by_tab` is text → the script's name. `updated_via` is deliberately NOT
  // 'server': the 1e gate counts anything other than 'server' as suspect, and a script
  // write should be visible there.
  let wrote;
  try {
    wrote = await t.casWrite({ org, baseVersion: snap.version, state: nextState, nowIso });
  } catch (e) { err('Write failed: ' + e.message); return 1; }
  if (!wrote || !wrote.length) {
    err('CAS conflict — org_state changed under me. Nothing written; re-run.');
    return 1;
  }
  log(`\n✓ Converted ${plan.converted.length} location default(s), cleaned ${plan.cleaned.length} dead key(s), added ${plan.assignmentsAdded} assignment(s). org_state v${snap.version} → ${snap.version + 1}.`);
  log(`  Backup: app/scripts/${backupName}`);
  log('  Verify: re-run without --apply — it must report 0 CONVERTED. A present-but-null');
  log('  key a pre-deploy tab wrote back is a cleanup, not a failed write. Then INV-13/INV-15.\n');
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
    // (2) §8.2 rule 2: name the target BEFORE the first read, so a failed read still
    // says which project and org the run was pointed at.
    printTarget({
      op: OP_NAME, ref: ref || '(unknown)', org: ORG, transport, apply: APPLY,
      envLabel: loaded ? `app/${envFile.replace('../', '')}` : 'the preloaded environment',
    });

    if (transport === 'pg') {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
      try {
        // ONCE. Supabase bans an address after a few failed password attempts, so a
        // connect that fails is reported, never retried.
        await client.connect();
        process.exitCode = await runChecklistDefaultOp({ t: pgTransport(client), org: ORG, apply: APPLY });
      } catch (e) {
        console.error('connect failed:', e.message);
        process.exitCode = 1;
      } finally { await client.end().catch(() => {}); }
    } else {
      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      // The same four statements over PostgREST. Paged (it caps rows), count-first and
      // ordered, exactly as before the Postgres transport existed.
      const t = {
        readOrgState: async (org) => {
          const { data, error } = await db.from('org_state')
            .select('state, version').eq('organization_id', org).maybeSingle();
          if (error) throw new Error(`org_state read failed: ${error.message}`);
          return data || null;
        },
        countJobs: async (org) => {
          const { count, error } = await db.from('jobs')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', org).in('status', OP_JOB_STATUSES);
          if (error) throw new Error(`jobs count failed: ${error.message}`);
          return count || 0;
        },
        readJobs: async (org) => {
          const rows = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await db.from('jobs')
              .select(JOB_SELECT)
              .eq('organization_id', org).in('status', OP_JOB_STATUSES)
              .order('id', { ascending: true })
              .range(from, from + PAGE - 1);
            if (error) throw new Error(`jobs page @${from} failed: ${error.message}`);
            rows.push(...(data || []));
            if ((data || []).length < PAGE) return rows;
          }
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
      process.exitCode = await runChecklistDefaultOp({ t, org: ORG, apply: APPLY });
    }
  }
}
