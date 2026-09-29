// The LIVE data-op that retires the location-wide default checklist (R3) —
// `app/scripts/dataop-checklist-default.mjs`. The production blob never sees the
// v56 → v57 store migration (persist.js migrations run in local/demo mode only), so the
// same conversion ships as a separate, idempotent, CAS-guarded, dry-run-first data-op
// (THE LAW II.8 · DEV_PLAYBOOK 3.5.10).
//
// This suite is OFFLINE: it exercises the script's pure halves on fixtures and checks the
// §8.2 guard contract MECHANICALLY over its source. It never opens a connection — the
// script's live section is behind an `import.meta.url === argv[1]` main guard, so
// importing it here runs nothing. ⚠️ The script itself is NEVER run against production
// without the owner's recorded go (DATA_AND_SYNC.md §11).
//
// Failing-first by construction: pre-fix the module does not exist, so the import throws.
//
// Run: node app/scripts/test-dataop-checklist-default.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  OP_NAME, PROD_REF, ENV_DEFAULT, ENV_PROD, JOB_SELECT, OP_JOB_STATUSES,
  jobRowsToCleans, planChecklistDefaultOp,
} from './dataop-checklist-default.mjs';
import { RETIRE_DEFAULT_JOB_STATUSES } from '../src/lib/crewChecklist.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'dataop-checklist-default.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── the jobs read: public.jobs rows → the transform's clean shape ────────────
// The blob's own `jobs` array is written EMPTY by client saves (jobs live per-row in
// public.jobs), so the live op must read the table. Rows come back with the denormalized
// scalar columns plus the crew ids lifted out of `data`.
{
  eq('the read is narrow and names the crew ids', JOB_SELECT, 'id,client_id,status,crewIds:data->crewIds');
  const rows = [
    { id: 'j1', client_id: 'cl_bay', status: 'upcoming', crewIds: ['u_a', 'u_b'] },
    { id: 'j2', client_id: 'cl_bay', status: 'in_progress', crewIds: null },
    { id: 'j3', client_id: null, status: 'upcoming', crewIds: ['u_c'] },
    { id: 'j4', client_id: 'cl_bay', status: 'done', crewIds: ['u_d'] },
  ];
  eq('rows map to { clientId, status, crewIds }', jobRowsToCleans(rows), [
    { id: 'j1', clientId: 'cl_bay', status: 'upcoming', crewIds: ['u_a', 'u_b'] },
    { id: 'j2', clientId: 'cl_bay', status: 'in_progress', crewIds: [] },
    { id: 'j3', clientId: null, status: 'upcoming', crewIds: ['u_c'] },
    { id: 'j4', clientId: 'cl_bay', status: 'done', crewIds: ['u_d'] },
  ]);
  eq('a nullish result set maps to []', jobRowsToCleans(null), []);
  // A jsonb string (a hand-written row) must not become an array of characters.
  eq('a non-array crewIds becomes []', jobRowsToCleans([{ id: 'j', client_id: 'c', status: 'upcoming', crewIds: 'u_a' }])[0].crewIds, []);
}

// ── the plan: before/after counts, on fixtures ───────────────────────────────
const fixture = () => ({
  clients: [
    { id: 'cl_bay', name: 'Coral Bay HOA', checklistTemplateId: 'it_closeout', crewChecklists: { u_andre: 'it_floorcare' } },
    { id: 'cl_quiet', name: 'Quiet St', checklistTemplateId: 'it_closeout' },
    { id: 'cl_none', name: 'No Checklist Ave', crewChecklists: { u_zoe: 'it_zoe' } },
  ],
  jobs: jobRowsToCleans([
    { id: 'j1', client_id: 'cl_bay', status: 'upcoming', crewIds: ['u_andre', 'u_tomas'] },
    { id: 'j2', client_id: 'cl_bay', status: 'in_progress', crewIds: ['u_priya'] },
    { id: 'j3', client_id: 'cl_bay', status: 'done', crewIds: ['u_past'] },
    { id: 'j4', client_id: 'cl_quiet', status: 'cancelled', crewIds: ['u_gone'] },
    { id: 'j5', client_id: 'cl_none', status: 'upcoming', crewIds: ['u_zoe', 'u_new'] },
  ]),
});

{
  const f = fixture();
  const plan = planChecklistDefaultOp(f);

  // CONVERTS
  eq('CONVERTS: before, two locations carry a default and 2 picks exist',
    plan.before, { clientsWithDefault: 2, staleNullKeys: 0, assignments: 2 });
  eq('CONVERTS: after, no default remains and the scheduled cleaners hold picks',
    plan.after, { clientsWithDefault: 0, staleNullKeys: 0, assignments: 4 });
  const byId = Object.fromEntries(plan.clients.map((c) => [c.id, c]));
  eq('CONVERTS: each unassigned cleaner on an upcoming/in-progress clean inherits the default',
    byId.cl_bay.crewChecklists, { u_andre: 'it_floorcare', u_tomas: 'it_closeout', u_priya: 'it_closeout' });

  // NEVER OVERWRITES a cleaner's own pick
  eq('NEVER OVERWRITES: the cleaner who already picked keeps their own checklist',
    byId.cl_bay.crewChecklists.u_andre, 'it_floorcare');
  eq('NEVER OVERWRITES: a location with no default is untouched, even with new cleaners on it',
    byId.cl_none.crewChecklists, { u_zoe: 'it_zoe' });

  // CLEARS
  ok(!('checklistTemplateId' in byId.cl_bay), 'CLEARS: the field is deleted from the converted location');
  ok(!('checklistTemplateId' in byId.cl_quiet), 'CLEARS: …and from one nobody is scheduled at');
  eq('CLEARS: a cancelled-only cleaner inherits nothing', byId.cl_quiet.crewChecklists, undefined);
  ok(plan.changed === true, 'the plan reports there is work to do');
  eq('the plan counts 2 conversions and no cleanups', { converted: plan.converted.length, cleaned: plan.cleaned.length }, { converted: 2, cleaned: 0 });
  eq('the plan names each converted location for the printout',
    plan.converted.map((r) => `${r.clientId}:${r.templateId}:${r.addedUserIds.join('+') || '-'}`),
    ['cl_bay:it_closeout:u_tomas+u_priya', 'cl_quiet:it_closeout:-']);

  // IDEMPOTENT
  const rerun = planChecklistDefaultOp({ clients: plan.clients, jobs: f.jobs });
  ok(rerun.changed === false, 'IDEMPOTENT: a re-run has nothing to do');
  eq('IDEMPOTENT: a re-run counts no work', { converted: rerun.converted.length, cleaned: rerun.cleaned.length, added: rerun.assignmentsAdded }, { converted: 0, cleaned: 0, added: 0 });
  eq('IDEMPOTENT: a re-run produces the identical clients', JSON.stringify(rerun.clients), JSON.stringify(plan.clients));
  eq('IDEMPOTENT: before === after on a re-run', rerun.before, rerun.after);

  // D5 — STALE-TAB RE-MINT. A pre-deploy tab's UPDATE_CLIENT_OPS can write
  // `checklistTemplateId: null` back after the op committed. The op's prescribed
  // verification is "re-run without --apply and it must report 0 conversions", so that
  // write-back must NOT read as a conversion, or a successful op looks failed.
  const remint = plan.clients.map((c) => (c.id === 'cl_bay' ? { ...c, checklistTemplateId: null } : c));
  const after = planChecklistDefaultOp({ clients: remint, jobs: f.jobs });
  eq('STALE TAB: a written-back null is 0 conversions', after.converted.length, 0);
  eq('STALE TAB: …reported separately as a cleanup', after.cleaned, ['cl_bay']);
  eq('STALE TAB: …counted apart in before/after', [after.before.clientsWithDefault, after.before.staleNullKeys], [0, 1]);
  ok(after.changed === true, 'STALE TAB: there is still work to do (the key is removed on apply)');
  eq('STALE TAB: nobody gains a checklist from it', after.assignmentsAdded, 0);
  ok(!('checklistTemplateId' in after.clients.find((c) => c.id === 'cl_bay')), 'STALE TAB: the key is removed');

  // an already-converted blob is recognised as a no-op, so `--apply` refuses to burn a version
  eq('a blob with no defaults at all is a no-op',
    planChecklistDefaultOp({ clients: [{ id: 'c', crewChecklists: {} }], jobs: [] }).changed, false);
  eq('nullish input is a no-op, never a crash', planChecklistDefaultOp().changed, false);
}

// ── the §8.2 guard contract, read off the script ─────────────────────────────
{
  eq('the op names itself for the provenance stamp', OP_NAME, 'dataop-checklist-default');
  eq('the production ref is the one §8.2 names', PROD_REF, 'nvsbknowpkmhrzbkcwxs');
  eq('the default env is the sandbox, not production', ENV_DEFAULT, '../.env.sandbox.local');
  eq('production env is only reached deliberately', ENV_PROD, '../.env.local');

  ok(/--dry-run|DRY|APPLY\s*=\s*process\.argv\.includes\('--apply'\)/.test(SRC), 'G1: writes are behind --apply');
  ok(/APPLY\s*=\s*process\.argv\.includes\('--apply'\)/.test(SRC), 'G1: dry run is the DEFAULT (an --apply opt-in, never a --dry-run opt-out)');
  ok(!/includes\('--dry-run'\)/.test(SRC), 'G1: not one of the write-by-default scripts (§8.1)');
  ok(/CONFIRM_PROD/.test(SRC) && new RegExp(`CONFIRM_PROD[^\\n]*PROD_REF|PROD_REF[^\\n]*CONFIRM_PROD`).test(SRC),
    'G3: production needs CONFIRM_PROD to equal the prod ref');
  ok(/--prod/.test(SRC), 'G3: production needs an explicit --prod');
  ok(/orgstate-backup-/.test(SRC), 'G4: the pre-write backup lands on the gitignored orgstate-backup-* pattern');
  ok(new RegExp(`updated_via:\\s*\`script:\\$\\{OP_NAME\\}\`|updated_via:\\s*'script:${OP_NAME}'`).test(SRC),
    'G5: the write stamps script provenance in updated_via');
  ok(/\.eq\('version',\s*(snap\.version|baseVersion)\)/.test(SRC), 'CAS: the version predicate rides ON the update');
  ok(/import\.meta\.url/.test(SRC) && /process\.argv\[1\]/.test(SRC), 'the live section is behind a main-module guard, so importing it is inert');
  // D7: the ceiling is the api constant, never a restated literal (THE LAW II.3).
  ok(/import \{ MAX_STATE_BYTES \} from '\.\.\/api\/_lib\/blobBudget\.js'/.test(SRC),
    'D7: the blob ceiling is imported from api/_lib/blobBudget.js, not redeclared');
  ok(!/3_500_000|3500000/.test(SRC), 'D7: no restated byte literal anywhere in the script');
  ok(/MAX_STATE_BYTES/.test(SRC.slice(SRC.indexOf('const isMain'))), 'the write checks the ceiling before committing');

  // D4: the statuses come from the rule module, so the op and the store migration can
  // never disagree about which cleans count.
  eq('D4: the op reads the statuses from crewChecklist.js', OP_JOB_STATUSES, RETIRE_DEFAULT_JOB_STATUSES);
  ok(/\.in\('status', OP_JOB_STATUSES\)/.test(SRC), 'D4: the jobs read filters on the shared constant, not a literal list');
  ok(!/\['upcoming', 'in_progress'\]/.test(SRC), 'D4: no hard-coded status list left in the script');

  // D3a: the usage block must not promise a prod dry run the guard refuses.
  const usage = SRC.slice(0, SRC.indexOf('// WHY:'));
  const prodLines = usage.split(String.fromCharCode(10)).filter((l) => /--prod/.test(l));
  ok(prodLines.length >= 2, `the usage block documents the production invocations (${prodLines.length})`);
  ok(prodLines.every((l) => /CONFIRM_PROD/.test(l)),
    'D3a: every documented --prod invocation carries CONFIRM_PROD, as the guard requires');

  // D3b: §8.2 rule 2 — the target prints BEFORE anything can fail.
  const printAt = SRC.indexOf('function printTarget');
  const callAt = SRC.indexOf('printTarget(');
  const readAt = SRC.indexOf(".from('org_state')");
  ok(printAt > 0 && callAt > 0 && readAt > 0, 'the script has a printTarget and an org_state read');
  ok(SRC.indexOf('printTarget(', printAt + 10) < readAt,
    'D3b: the target is printed before the org_state read, so a failed read still names what it was pointed at');

  // D6: the audit row must not credit a human for a script write.
  ok(/updated_by:\s*null/.test(SRC), 'D6: updated_by is null (uuid column — a script has no human author)');
  ok(/updated_by_build:\s*null/.test(SRC), 'D6: updated_by_build is null (bigint — not a client build)');
  ok(SRC.includes('updated_by_tab: `script:${OP_NAME}`'),
    'D6: updated_by_tab identifies the script (text column)');
}

// the backup pattern the script writes must already be gitignored (§8.2 rule 4)
{
  const ignore = readFileSync(path.join(HERE, '..', '.gitignore'), 'utf8');
  ok(/scripts\/orgstate-backup-\*\.json/.test(ignore), 'app/.gitignore already excludes scripts/orgstate-backup-*.json');
}

// it must NOT look like a test to the canonical runner (it would then need a LIVE_EFFECT row)
{
  const runner = readFileSync(path.join(HERE, 'run-tests.mjs'), 'utf8');
  ok(!/dataop-checklist-default/.test(runner), 'the op is out of the test path entirely (its name is not test-*), so no LIVE_EFFECT row is needed');
}

console.log(`\ndataop-checklist-default: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
