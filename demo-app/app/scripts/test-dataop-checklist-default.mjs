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
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OP_NAME, PROD_REF, ENV_DEFAULT, ENV_PROD, JOB_SELECT, OP_JOB_STATUSES,
  jobRowsToCleans, planChecklistDefaultOp,
  refFromDbUrl, liveTarget, refuseTarget, printTarget, pgTransport, runChecklistDefaultOp,
} from './dataop-checklist-default.mjs';
import { RETIRE_DEFAULT_JOB_STATUSES } from '../src/lib/crewChecklist.js';
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'dataop-checklist-default.mjs'), 'utf8');
// §8.2 rules 2 and 3 (which project, may it proceed, say so first) moved to the SHARED
// guard on 2026-09-28 so the second data-op runs the same one (CS-025). The contract is
// still checked mechanically — against the file that now implements it. Rules 1, 4 and 5
// stay in the op's own body and are still read off SRC below.
const GUARD = readFileSync(path.join(HERE, '_lib', 'liveGuard.mjs'), 'utf8');

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
  ok(/CONFIRM_PROD/.test(GUARD) && new RegExp(`CONFIRM_PROD[^\\n]*PROD_REF|PROD_REF[^\\n]*CONFIRM_PROD`).test(GUARD),
    'G3: production needs CONFIRM_PROD to equal the prod ref (the shared guard)');
  ok(/from '\.\/_lib\/liveGuard\.mjs'/.test(SRC) && /refuseTarget/.test(SRC),
    'G3: …and this op runs that shared guard rather than a copy of it');
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
  // The ceiling is checked inside the op body — the one function that performs the write,
  // whichever transport carries it. (Proven behaviourally further down too: an over-ceiling
  // state refuses and issues no UPDATE.)
  ok(/MAX_STATE_BYTES/.test(SRC.slice(SRC.indexOf('function runChecklistDefaultOp'))),
    'the write checks the ceiling before committing');

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

  // D3b: §8.2 rule 2 — the target prints BEFORE anything can fail. printTarget is declared
  // in the shared guard now; what matters here is that THIS op calls it before its read.
  const printAt = GUARD.indexOf('export function printTarget');
  const callAt = SRC.indexOf('printTarget({');
  const readAt = SRC.indexOf(".from('org_state')");
  ok(printAt > 0 && callAt > 0 && readAt > 0, 'the shared guard declares printTarget, and the script calls it and reads org_state');
  ok(callAt < readAt,
    'D3b: the target is printed before the org_state read, so a failed read still names what it was pointed at');

  // D6: the audit row must not credit a human for a script write.
  ok(/updated_by:\s*null/.test(SRC), 'D6: updated_by is null (uuid column — a script has no human author)');
  ok(/updated_by_build:\s*null/.test(SRC), 'D6: updated_by_build is null (bigint — not a client build)');
  ok(SRC.includes('updated_by_tab: `script:${OP_NAME}`'),
    'D6: updated_by_tab identifies the script (text column)');
}

// ── the Postgres transport (SUPABASE_DB_URL, no service-role key) ────────────
// Some machines hold only `SUPABASE_DB_URL` — a Postgres connection string — as the
// production credential (`apply-migration.mjs` already runs on it) and have no
// service-role pair at all. The op then talks to Postgres directly, on the SAME pure
// plan and under the SAME §8.2 guard contract. Everything below drives a FAKE client
// that records `query(text, params)`, so the suite stays offline.
const PASSWORD = 'n0t-a-real-p%40ssword';
const DSN_POOLER = `postgresql://postgres.${PROD_REF}:${PASSWORD}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`;
const DSN_DIRECT = `postgresql://postgres:${PASSWORD}@db.${PROD_REF}.supabase.co:5432/postgres`;

{
  eq('the pooler username carries the ref', refFromDbUrl(DSN_POOLER), PROD_REF);
  eq('the direct host carries the ref', refFromDbUrl(DSN_DIRECT), PROD_REF);
  eq('a sandbox pooler dsn reads its own ref',
    refFromDbUrl('postgres://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres'),
    'abcdefghijklmnopqrst');
  // A password may legally contain an '@', so the LAST one separates userinfo from host.
  eq('the LAST @ splits userinfo from host',
    refFromDbUrl(`postgresql://postgres:pw@db.deadbeefdeadbeefdead.supabase.co@db.${PROD_REF}.supabase.co:5432/postgres`),
    PROD_REF);
  eq('garbage is unknown, never a guess', refFromDbUrl('not a connection string'), null);
  eq('a local dsn is unknown', refFromDbUrl('postgresql://postgres:pw@localhost:5432/postgres'), null);
  eq('a missing dsn is unknown', refFromDbUrl(undefined), null);
}

// which transport the environment offers, and what it is pointed at
{
  eq('the service-role pair still wins when it is present',
    liveTarget({ SUPABASE_URL: `https://${PROD_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_DB_URL: DSN_POOLER }),
    { transport: 'supabase', ref: PROD_REF });
  eq('a bare SUPABASE_DB_URL takes the Postgres transport',
    liveTarget({ SUPABASE_DB_URL: DSN_POOLER }), { transport: 'pg', ref: PROD_REF });
  eq('half a service-role pair is not a transport',
    liveTarget({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }), { transport: null, ref: null });
  eq('no credential at all is no transport', liveTarget({}), { transport: null, ref: null });
}

// §8.2 rule 3 on the Postgres path — the refusal is a value, so it is testable
{
  const refusal = (over) => refuseTarget({ transport: 'pg', ref: PROD_REF, prod: false, confirmProd: undefined, ...over });
  ok(refusal() && /CONFIRM_PROD/.test(refusal()), 'G3/pg: the prod ref without --prod and CONFIRM_PROD is refused');
  ok(refusal({ prod: true }), 'G3/pg: --prod alone is not enough');
  ok(refusal({ confirmProd: PROD_REF }), 'G3/pg: CONFIRM_PROD alone is not enough');
  eq('G3/pg: both together proceed', refusal({ prod: true, confirmProd: PROD_REF }), null);
  eq('G3/pg: a non-production ref proceeds', refuseTarget({ transport: 'pg', ref: 'sandboxrefsandboxref', prod: false }), null);
  // An unknown ref cannot be compared with PROD_REF, so it may not be assumed harmless.
  ok(refuseTarget({ transport: 'pg', ref: null, prod: true, confirmProd: PROD_REF }),
    'G3/pg: an unparseable ref is unknown, and unknown is refused');
  eq('the supabase-js path is unchanged: an unparsed https host still runs',
    refuseTarget({ transport: 'supabase', ref: null, prod: false }), null);
  ok(!refusal().includes(PASSWORD) && !refusal().includes(DSN_POOLER), 'the refusal never quotes the credential');
}

// §8.2 rule 2 — the target names the project, never the credential
{
  const r = recorder();
  printTarget({ ref: refFromDbUrl(DSN_POOLER), org: '00000000-0000-0000-0000-0000000000ab', envLabel: 'the preloaded environment', transport: 'pg', apply: false, log: r.write });
  ok(r.text().includes(PROD_REF), 'the target names the project ref');
  ok(/PRODUCTION/.test(r.text()), '…and flags production');
  ok(/pg|postgres/i.test(r.text()), '…and says which transport is carrying the run');
  ok(!r.text().includes(PASSWORD), 'the target line never contains the password');
  ok(!r.text().includes(DSN_POOLER) && !r.text().includes('pooler.supabase.com'), '…nor the connection string');
}

// the guard is consulted before ANY driver is loaded or any socket opened
{
  // the CALL, not the declaration — the first occurrence after the function it names
  const guardAt = SRC.indexOf('refuseTarget({', SRC.indexOf('function refuseTarget') + 10);
  const importAt = SRC.indexOf('await import(');
  const pgAt = SRC.indexOf('new pg.Client');
  ok(guardAt > 0 && importAt > 0 && pgAt > 0, 'the script has a guard call, a dynamic driver import and a pg client');
  ok(guardAt < importAt, 'G3: the refusal is decided before the driver is even imported');
  ok(guardAt < pgAt, 'G3: …and before a Postgres connection is constructed — a refused run makes NO query');
  ok(SRC.indexOf('printTarget(', SRC.indexOf('function printTarget') + 10) > guardAt,
    'the guard runs before the target is printed, so a refused run prints only the refusal');
  // Supabase bans an address after a few failed password attempts: connect once, never loop.
  eq('the pg path connects exactly once', (SRC.match(/client\.connect\(\)/g) || []).length, 1);
  ok(/client\.end\(\)/.test(SRC), 'the pg client is closed on every exit');
  ok(!/process\.exit\(/.test(SRC), 'exit codes are set, never process.exit() — it can crash node on Windows after network I/O');
}

// ── the op over the Postgres transport, end to end on a fake client ──────────
const ORG_FIX = '00000000-0000-0000-0000-0000000000ab';
// 4177, not 1 or 2: a version digit that cannot be confused with a `$1` placeholder when
// the "no value is interpolated into the SQL" check scans the statement text.
const VERSION_FIX = 4177;
const JOB_ROWS = [
  { id: 'j1', client_id: 'cl_bay', status: 'upcoming', crewIds: ['u_andre', 'u_tomas'] },
  { id: 'j2', client_id: 'cl_bay', status: 'in_progress', crewIds: ['u_priya'] },
  { id: 'j5', client_id: 'cl_none', status: 'upcoming', crewIds: ['u_zoe', 'u_new'] },
];
const STATE_FIX = () => ({ version: 57, clients: fixture().clients, users: [] });

function recorder() {
  const lines = [];
  const write = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, write, text: () => lines.join('\n') };
}

// node-postgres hands bigint back as a STRING (PostgREST hands back a number), so the
// fake returns `version` as a string on purpose: if the op forgets to normalise it,
// `version + 1` concatenates and the success line reads "v4177 → 41771".
function fakePg({ state, version = VERSION_FIX, jobRows = JOB_ROWS, count, updated = [{ version: String(version + 1) }], onUpdate }) {
  const calls = [];
  const client = {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/from public\.org_state/.test(text)) return { rows: state === null ? [] : [{ state, version: String(version) }] };
      if (/count\(\*\)/.test(text)) return { rows: [{ n: count ?? jobRows.length }] };
      if (/from public\.jobs/.test(text)) return { rows: jobRows };
      if (/^\s*update public\.org_state/.test(text)) { if (onUpdate) onUpdate(); return { rows: updated }; }
      throw new Error(`the fake saw an unexpected statement: ${text}`);
    },
  };
  return client;
}

const BACKUPS = mkdtempSync(path.join(tmpdir(), 'cs-dataop-'));
const BACKUP_DIR = new URL(`${pathToFileURL(BACKUPS).href}/`);
const runPg = (client, over = {}) => {
  const r = recorder();
  return runChecklistDefaultOp({
    t: pgTransport(client), org: ORG_FIX, apply: true, backupDir: BACKUP_DIR,
    log: r.write, err: r.write, ...over,
  }).then((code) => ({ code, out: r.text(), calls: client.calls }));
};
const updateOf = (calls) => calls.find((c) => /^\s*update /i.test(c.text));

{
  const state = STATE_FIX();
  const client = fakePg({ state });
  const { code, out, calls } = await runPg(client);
  eq('the happy path exits 0', code, 0);
  ok(/org_state v4177 → 4178/.test(out), `the version is read as a number, not a string (got: ${out.split('\n').filter((l) => /v41/.test(l)).join(' | ')})`);

  // every statement is parameterized: the values live in `params`, never in the text
  for (const { text, params } of calls) {
    ok(!/;\s*\S/.test(text), `one statement per query: ${text.slice(0, 48)}…`);
    for (let i = 0; i < (params || []).length; i += 1) {
      const v = params[i];
      const asText = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      ok(text.includes(`$${i + 1}`), `$${i + 1} is a placeholder in: ${text.slice(0, 48)}…`);
      ok(!text.includes(asText), `param ${i + 1} is not interpolated into: ${text.slice(0, 48)}…`);
    }
  }

  // count-first, then ONE ordered read — pg has no PostgREST row cap, so a single
  // ordered statement is the complete set and the caller proves it against the count.
  const counts = calls.filter((c) => /count\(\*\)/.test(c.text));
  const reads = calls.filter((c) => /from public\.jobs/.test(c.text) && !/count\(\*\)/.test(c.text));
  eq('the jobs are counted first', calls.indexOf(counts[0]) < calls.indexOf(reads[0]), true);
  eq('…and read in exactly one statement', reads.length, 1);
  ok(/order by id/.test(reads[0].text), 'the jobs read is ordered by id');
  ok(/status = any\(\$2\)/.test(reads[0].text), 'the statuses ride as a parameter, not a literal list');
  eq('…and they are the shared constant', reads[0].params[1], OP_JOB_STATUSES);
  ok(/data->'crewIds' as "crewIds"/.test(reads[0].text), 'the crew ids are lifted out of data under the same alias the PostgREST select used');

  // the CAS write
  const upd = updateOf(calls);
  ok(/where organization_id = \$4 and version = \$5/.test(upd.text), 'CAS: the version predicate rides ON the update, as a parameter');
  ok(/set state = \$1::jsonb/.test(upd.text), 'the new blob is a jsonb parameter');
  ok(/version = version \+ 1/.test(upd.text), 'the next version is computed in SQL, never restated');
  ok(/updated_at = now\(\)/.test(upd.text), 'the write stamps updated_at');
  ok(/returning version/.test(upd.text), 'the update returns its row, so 0 rows is a detectable conflict');
  ok(/updated_by = null/.test(upd.text) && /updated_by_build = null/.test(upd.text),
    'D6/pg: no human and no client build is credited for a script write');
  eq('D6/pg: updated_via is the script', upd.params[1], `script:${OP_NAME}`);
  eq('D6/pg: updated_by_tab is the script', upd.params[2], `script:${OP_NAME}`);
  eq('the CAS params are the org and the version just read', [upd.params[3], upd.params[4]], [ORG_FIX, VERSION_FIX]);

  // the pg rows go through the SAME pure transform as the PostgREST rows
  const plan = planChecklistDefaultOp({ clients: STATE_FIX().clients, jobs: jobRowsToCleans(JOB_ROWS) });
  eq('the written blob is exactly the pure plan applied to the state it read',
    JSON.stringify(upd.params[0]), JSON.stringify({ ...STATE_FIX(), clients: plan.clients }));

  // G4: the backup lands on the gitignored pattern, and it parses
  const backups = readdirSync(BACKUPS).filter((f) => /^orgstate-backup-.*\.json$/.test(f));
  eq('G4: the write left exactly one backup', backups.length, 1);
  eq('G4: the backup holds the version and the state as they were read',
    JSON.parse(readFileSync(path.join(BACKUPS, backups[0]), 'utf8')),
    { version: VERSION_FIX, state: STATE_FIX() });
}

// G4 again, ordered: the backup must be on disk by the time the UPDATE is issued
{
  let backupsAtWrite = -1;
  const client = fakePg({
    state: STATE_FIX(),
    onUpdate: () => { backupsAtWrite = readdirSync(BACKUPS).filter((f) => /^orgstate-backup-/.test(f)).length; },
  });
  const { code } = await runPg(client, { now: new Date('2026-09-28T01:02:03.456Z') });
  eq('the op still exits 0', code, 0);
  ok(backupsAtWrite > 0, 'G4: a backup file is on disk before the UPDATE is issued');
  ok(existsSync(path.join(BACKUPS, 'orgstate-backup-2026-09-28T01-02-03-456Z.json')),
    'G4: the backup name is the run timestamp on the gitignored pattern');
}

// a CAS miss is loud, and never reads as success
{
  const client = fakePg({ state: STATE_FIX(), updated: [] });
  const { code, out } = await runPg(client);
  eq('0 rows updated exits 1', code, 1);
  ok(/CAS conflict/.test(out), 'a CAS miss says so');
  ok(!/✓ Converted/.test(out), 'a CAS miss prints no success line');
}

// the dry run is the default: it reads, prints, and writes nothing
{
  const client = fakePg({ state: STATE_FIX() });
  const { code, out, calls } = await runPg(client, { apply: false });
  eq('the dry run exits 0', code, 0);
  eq('the dry run issues no UPDATE', updateOf(calls), undefined);
  ok(/nothing written/.test(out), 'the dry run says nothing was written');
}

// a short read is refused rather than planned on
{
  const client = fakePg({ state: STATE_FIX(), count: JOB_ROWS.length + 1 });
  const { code, out, calls } = await runPg(client);
  eq('a jobs read that does not match the count exits 1', code, 1);
  eq('…and issues no UPDATE', updateOf(calls), undefined);
  ok(/re-run/.test(out), '…and says to re-run');
}

// the blob ceiling, behaviourally
{
  const state = STATE_FIX();
  state.filler = 'x'.repeat(MAX_STATE_BYTES);
  const client = fakePg({ state });
  const { code, out, calls } = await runPg(client);
  eq('a result over the ceiling exits 1', code, 1);
  eq('…and issues no UPDATE', updateOf(calls), undefined);
  ok(/ceiling/.test(out), '…and names the ceiling');
}

// an uninitialized org is a clean refusal, not a crash
{
  const client = fakePg({ state: null });
  const { code, out, calls } = await runPg(client);
  eq('no org_state row exits 1', code, 1);
  eq('…and issues no UPDATE', updateOf(calls), undefined);
  ok(/not initialized/.test(out), '…and says so');
}

rmSync(BACKUPS, { recursive: true, force: true });

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
