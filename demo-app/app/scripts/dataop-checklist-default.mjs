// LIVE DATA-OP — retire the location-wide default checklist in the shared org_state blob
// (R3, Daniel 2026-09-27; plan docs/plans/2026-09-27-checklists-by-location.md step 2).
//
// 🔴 NEVER RUN THIS AGAINST PRODUCTION WITHOUT THE OWNER'S RECORDED GO. A dry run against
//    production is still a production connection: it reads the live blob with the
//    service-role key. The owner's go is relayed by the orchestrating session and recorded
//    in DATA_AND_SYNC.md §11. Rehearse in the sandbox first.
//
//   node app/scripts/dataop-checklist-default.mjs                 # DRY RUN, sandbox env
//   node app/scripts/dataop-checklist-default.mjs --apply         # write, sandbox env
//
//   Production needs CONFIRM_PROD on EVERY invocation, a dry run included — reading the
//   live blob with the service-role key is itself a production connection, so the guard
//   refuses the prod ref without it (§8.2 rule 3):
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-checklist-default.mjs --prod
//   CONFIRM_PROD=<prod ref> node app/scripts/dataop-checklist-default.mjs --prod --apply
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
// GUARD CONTRACT (DATA_AND_SYNC.md §8.2; `_lib/liveGuard.mjs` is still unbuilt — CS-025 —
// so the contract is implemented here and re-checked by test-dataop-checklist-default.mjs):
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

export const OP_NAME = 'dataop-checklist-default';
// The production project ref DATA_AND_SYNC.md §8.2 names in the CONFIRM_PROD contract.
export const PROD_REF = 'nvsbknowpkmhrzbkcwxs';
export const ENV_DEFAULT = '../.env.sandbox.local';
export const ENV_PROD = '../.env.local';
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

// (2) §8.2 rule 2 — printed BEFORE the first read, so a failed read still names what the run
// was pointed at.
function printTarget({ ref, org, envFile, apply }) {
  console.log(`\n── ${OP_NAME} ${apply ? '(ARMED)' : '(dry run)'} ─────────────────────────`);
  console.log(`  env file     : app/${envFile.replace('../', '')}`);
  console.log(`  Supabase ref : ${ref}${ref === PROD_REF ? '  ⚠ PRODUCTION' : ''}`);
  console.log(`  org id       : ${org}`);
}

// ── live section ─────────────────────────────────────────────────────────────
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const APPLY = process.argv.includes('--apply');
  const PROD = process.argv.includes('--prod');

  // (3) env: the sandbox unless production is asked for explicitly.
  const envFile = PROD ? ENV_PROD : ENV_DEFAULT;
  let loaded = false;
  try {
    for (const line of readFileSync(new URL(envFile, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    loaded = true;
  } catch { /* fall through to the explicit error below */ }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (looked in app/${envFile.replace('../', '')}${loaded ? '' : ' — file not found'}).`);
    console.error(PROD ? '' : 'Sandbox is the default. Pass --prod for production (see the guard contract).');
    process.exitCode = 1;
  } else {
    const ref = (process.env.SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || '(unknown)';
    const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';

    // (3) the prod refusal — all three conditions, or nothing happens.
    if (ref === PROD_REF && !(PROD && process.env.CONFIRM_PROD === PROD_REF)) {
      console.error(`\n⛔ REFUSING the production ref ${ref}.`);
      console.error('   Production needs BOTH --prod and CONFIRM_PROD=' + PROD_REF + ' in the environment,');
      console.error("   plus the owner's go recorded in docs/playbook/DATA_AND_SYNC.md §11.\n");
      process.exitCode = 1;
    } else {
      // (2) §8.2 rule 2: name the target BEFORE the first read, so a failed read still
      // says which project and org the run was pointed at.
      printTarget({ ref, org: ORG, envFile, apply: APPLY });

      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

      const { data: snap, error } = await db.from('org_state')
        .select('state, version').eq('organization_id', ORG).maybeSingle();
      if (error) { console.error('org_state read failed:', error.message); process.exitCode = 1; }
      else if (!snap?.state) { console.error('org_state not initialized for this org.'); process.exitCode = 1; }
      else {
        const state = snap.state;

        // the cleans: count-first, ordered, paged (THE LAW II.7 fetch strategy)
        const { count, error: cErr } = await db.from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', ORG).in('status', OP_JOB_STATUSES);
        if (cErr) { console.error('jobs count failed:', cErr.message); process.exitCode = 1; }
        const rows = [];
        for (let from = 0; process.exitCode !== 1 && from < (count || 0); from += PAGE) {
          const { data, error: jErr } = await db.from('jobs')
            .select(JOB_SELECT)
            .eq('organization_id', ORG).in('status', OP_JOB_STATUSES)
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1);
          if (jErr) { console.error(`jobs page @${from} failed:`, jErr.message); process.exitCode = 1; break; }
          rows.push(...(data || []));
        }

        if (process.exitCode !== 1) {
          const jobs = jobRowsToCleans(rows);
          const plan = planChecklistDefaultOp({ clients: state.clients || [], jobs });

          console.log(`  org_state    : v${snap.version}, ${(state.clients || []).length} customers`);
          console.log(`  cleans read  : ${jobs.length} ${OP_JOB_STATUSES.join('/')} rows from public.jobs (count said ${count ?? '—'})`);
          const censusLines = (label, c) => {
            console.log(`  ${label}  customers with a location default : ${c.clientsWithDefault}`);
            console.log(`          present-but-null keys (stale tab)  : ${c.staleNullKeys}`);
            console.log(`          per-cleaner assignments            : ${c.assignments}`);
          };
          console.log('');
          censusLines('BEFORE', plan.before);
          censusLines('AFTER ', plan.after);
          console.log(`          (${plan.converted.length} converted, ${plan.cleaned.length} dead key(s) cleaned up, ${plan.assignmentsAdded} assignment(s) added)\n`);
          const nameOf = (id) => (state.clients || []).find((c) => c.id === id)?.name || id;
          for (const row of plan.converted) {
            console.log(`   · ${nameOf(row.clientId)}  default=${row.templateId}  → ${row.addedUserIds.length ? row.addedUserIds.join(', ') : 'nobody scheduled'}`);
          }
          for (const id of plan.cleaned) {
            console.log(`   · ${nameOf(id)}  dead key (null) — removed, nobody gains a checklist`);
          }

          if (!plan.changed) {
            console.log('\n✓ No customer carries a location default — already retired. No-op.\n');
          } else if (!APPLY) {
            console.log('\n--dry-run (the default): nothing written. Re-run with --apply to arm.\n');
          } else {
            const nextState = { ...state, clients: plan.clients };
            const bytes = Buffer.byteLength(JSON.stringify(nextState), 'utf8');
            if (bytes > MAX_STATE_BYTES) {
              console.error(`Refusing: the result is ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_STATE_BYTES / 1024)} KB ceiling.`);
              process.exitCode = 1;
            } else {
              // (4) backup first, on the gitignored pattern
              const nowIso = new Date().toISOString();
              const backupName = `orgstate-backup-${nowIso.replace(/[:.]/g, '-')}.json`;
              writeFileSync(new URL(`./${backupName}`, import.meta.url), JSON.stringify({ version: snap.version, state }));
              JSON.parse(readFileSync(new URL(`./${backupName}`, import.meta.url), 'utf8')); // it parses

              // (5) CAS: the version predicate rides ON the update.
              // PROVENANCE (§8.2 rule 5): an UPDATE that omits a column keeps the LAST
              // writer's value, so the append-only audit row (org_state_writes_seen, which
              // copies updated_by / _build / _tab) would credit whichever user saved last for
              // a script write. All three are set to what the schema allows:
              // `updated_by` is uuid → null (a script has no human author, as writeOrgState
              // does); `updated_by_build` is bigint → null (no client build); `updated_by_tab`
              // is text → the script's name. `updated_via` is deliberately NOT 'server': the 1e
              // gate counts anything other than 'server' as suspect, and a service-role script
              // write should be visible there.
              const { data: wrote, error: wErr } = await db.from('org_state')
                .update({
                  state: nextState,
                  version: (snap.version || 0) + 1,
                  updated_at: nowIso,
                  updated_via: `script:${OP_NAME}`,
                  updated_by: null,
                  updated_by_build: null,
                  updated_by_tab: `script:${OP_NAME}`,
                })
                .eq('organization_id', ORG).eq('version', snap.version)
                .select('version');
              if (wErr) { console.error('Write failed:', wErr.message); process.exitCode = 1; }
              else if (!wrote || !wrote.length) {
                console.error('CAS conflict — org_state changed under me. Nothing written; re-run.');
                process.exitCode = 1;
              } else {
                console.log(`\n✓ Converted ${plan.converted.length} location default(s), cleaned ${plan.cleaned.length} dead key(s), added ${plan.assignmentsAdded} assignment(s). org_state v${snap.version} → ${snap.version + 1}.`);
                console.log(`  Backup: app/scripts/${backupName}`);
                console.log('  Verify: re-run without --apply — it must report 0 CONVERTED. A present-but-null');
                console.log('  key a pre-deploy tab wrote back is a cleanup, not a failed write. Then INV-13/INV-15.\n');
              }
            }
          }
        }
      }
    }
  }
}
