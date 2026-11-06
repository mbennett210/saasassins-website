// `apply-migration.mjs` has TWO modes, and picking the wrong one is not a slow migration —
// it is a failed one.
//
// WHY. Every migration this repo has applied went through ONE path: the whole file wrapped
// in `begin … commit` (Postgres DDL is transactional, so a half-applied file is impossible).
// `CREATE INDEX CONCURRENTLY` CANNOT run inside a transaction block — Postgres answers
// 25001 and the statement never runs. Step 5 adds two concurrent indexes (the per-customer
// checklist read, and CS-447's clock-out gate read), and the migration ledger is drifted
// (CS-024) so `supabase db push` is not available: these files go through this script.
//
// So the script now reads a MARKER out of the file's own header and refuses every shape
// that could half-apply or silently fail:
//   · `-- apply: no-transaction` in the leading comment block → no begin/commit;
//   · `concurrently` WITHOUT that marker → refused BEFORE a connection is opened;
//   · the marker on a file holding more than one statement → refused, because there is no
//     transaction to undo statement 1 when statement 2 fails.
// The refusal is a VALUE decided from the file alone, so this suite proves it without ever
// opening a socket: `planApply(sql)` here, an injected fake client for the apply itself.
//
// It also pins the three step-5 migration files themselves: the DEV_PLAYBOOK 3.5.7 header,
// a `concurrently` statement alone in its own marked file, and no backfill on the column.
//
// Failing-first by construction: pre-fix the script exports none of these and reads
// `.env.local` at module scope, so the import throws.
//
//   node app/scripts/test-apply-migration-modes.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  NO_TX_MARKER, stripSql, splitStatements, hasConcurrently, readApplyMode, planApply, applyMigrationSql,
  migrationTarget, indexNameOf,
} from './apply-migration.mjs';
import { PROD_REF } from './_lib/liveGuard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'apply-migration.mjs'), 'utf8');
const MIGRATIONS = path.resolve(HERE, '..', '..', 'supabase', 'migrations');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── the SQL scanner: a `;` inside a comment or a literal ends nothing ─────────
{
  eq('a plain statement is one statement', splitStatements('alter table t add column c text;').length, 1);
  eq('a trailing semicolon does not invent an empty second statement',
    splitStatements('select 1;\n\n').length, 1);
  eq('two statements are two', splitStatements('set lock_timeout = \'3s\';\nalter table t add column c text;').length, 2);
  eq('a semicolon inside a line comment ends nothing',
    splitStatements('-- a; b; c\nalter table t add column c text;').length, 1);
  eq('a semicolon inside a block comment ends nothing',
    splitStatements('/* a; b */ alter table t add column c text;').length, 1);
  eq('a semicolon inside a string literal ends nothing',
    splitStatements("comment on column t.c is 'null; means starter';").length, 1);
  eq('a semicolon inside a dollar-quoted body ends nothing',
    splitStatements('create function f() returns void as $$ begin perform 1; end $$ language plpgsql;').length, 1);
  eq('an escaped quote does not run the literal on',
    splitStatements("comment on column t.c is 'it''s null; a starter';\nselect 1;").length, 2);
  eq('a comment-only file holds no statement', splitStatements('-- nothing here\n\n').length, 0);

  ok(!/concurrently/i.test(stripSql('-- create index concurrently in its own file\nselect 1;')),
    'stripSql removes comments, so a WORD in a comment is not code');
  ok(!hasConcurrently('-- create index concurrently goes in its own file\nalter table t add column c text;'),
    'the word "concurrently" in a comment is not a concurrent index');
  ok(hasConcurrently('create index concurrently if not exists i on t (a);'),
    '…and in code it is');
  ok(hasConcurrently('CREATE INDEX CONCURRENTLY i ON t (a);'), '…whatever its case');
}

// ── the marker lives in the LEADING comment block ────────────────────────────
{
  eq('the marker is the one the migration files carry', NO_TX_MARKER, '-- apply: no-transaction');
  eq('a file with no marker runs in a transaction', readApplyMode('alter table t add column c text;'), 'transaction');
  eq('the marker in the header is read',
    readApplyMode(`-- 2026_x.sql\n${NO_TX_MARKER}\n-- purpose: x\ncreate index concurrently i on t (a);`), 'no-transaction');
  eq('…even as the very first line', readApplyMode(`${NO_TX_MARKER}\ncreate index concurrently i on t (a);`), 'no-transaction');
  eq('…with blank lines around it', readApplyMode(`\n-- hi\n\n  ${NO_TX_MARKER}  \n\ncreate index concurrently i on t (a);`), 'no-transaction');
  // Below the first statement it is just a comment — otherwise a marker buried at the foot
  // of a long file would silently disarm the transaction for everything above it.
  eq('a marker AFTER the first statement is only a comment',
    readApplyMode(`alter table t add column c text;\n${NO_TX_MARKER}\n`), 'transaction');
}

// ── planApply: the refusal is a value, decided from the file alone ───────────
{
  const plain = planApply("set lock_timeout = '3s';\nalter table public.t add column if not exists c text;");
  eq('a plain migration plans a transaction', { mode: plain.mode, refusal: plain.refusal, count: plain.count },
    { mode: 'transaction', refusal: null, count: 2 });

  const conc = planApply(`-- x\n${NO_TX_MARKER}\ncreate index concurrently if not exists i on public.t (a);`);
  eq('a marked single concurrent index plans no transaction',
    { mode: conc.mode, refusal: conc.refusal, count: conc.count }, { mode: 'no-transaction', refusal: null, count: 1 });

  const unmarked = planApply('create index concurrently if not exists i on public.t (a);');
  ok(unmarked.refusal, 'CONCURRENTLY without the marker is REFUSED');
  ok(/concurrently/i.test(unmarked.refusal) && unmarked.refusal.includes(NO_TX_MARKER),
    '…and the refusal names the marker the file is missing');

  const mixed = planApply(`${NO_TX_MARKER}\nset lock_timeout = '3s';\ncreate index concurrently i on public.t (a);`);
  ok(mixed.refusal, 'the marker on a MULTI-statement file is REFUSED — nothing may half-apply');
  ok(/one statement|single statement/i.test(mixed.refusal), '…and says why: one statement only outside a transaction');

  const empty = planApply('-- a header and nothing else\n');
  ok(empty.refusal, 'a file with no statement at all is refused rather than "applied"');
}

// ── applying, over an injected fake client ───────────────────────────────────
function fakeClient({ failOn = null } = {}) {
  const queries = [];
  return {
    queries,
    query: async (text) => {
      queries.push(text);
      if (failOn && failOn.test(text)) { const e = new Error('relation "t" does not exist'); e.code = '42P01'; throw e; }
      // A concurrent build is confirmed against pg_index afterwards (F6); the happy path
      // answers "valid". The invalid and missing cases have their own client below.
      if (/indisvalid/.test(text)) return { rows: [{ indisvalid: true }] };
      return { rows: [] };
    },
  };
}
const quiet = () => { const lines = []; return { lines, write: (...a) => lines.push(a.map(String).join(' ')), text: () => lines.join('\n') }; };

{
  const sql = "set lock_timeout = '3s';\nalter table public.t add column if not exists c text;";
  const c = fakeClient();
  const r = quiet();
  const code = await applyMigrationSql({ client: c, sql, label: 'x.sql', log: r.write, err: r.write });
  eq('a plain migration exits 0', code, 0);
  eq('…wrapped in one transaction', [c.queries[0], c.queries[c.queries.length - 1]], ['begin', 'commit']);
  eq('…with the file sent as ONE query between them', c.queries.length, 3);
  eq('…and the file itself is the middle query', c.queries[1], sql);
}
{
  const sql = `${NO_TX_MARKER}\ncreate index concurrently if not exists i on public.t (a);`;
  const c = fakeClient();
  const r = quiet();
  const code = await applyMigrationSql({ client: c, sql, label: 'i.sql', log: r.write, err: r.write });
  eq('a no-transaction migration exits 0', code, 0);
  ok(!c.queries.includes('begin') && !c.queries.includes('commit'),
    '…and issues NO begin/commit — CONCURRENTLY cannot run in one');
  eq('…the file itself is the first query', c.queries[0], sql);
  eq('…followed only by the pg_index validity check (F6)', c.queries.length, 2);
}
{
  const sql = 'alter table public.t add column if not exists c text;';
  const c = fakeClient({ failOn: /alter table/ });
  const r = quiet();
  const code = await applyMigrationSql({ client: c, sql, label: 'x.sql', log: r.write, err: r.write });
  eq('a failed transactional migration exits 1', code, 1);
  ok(c.queries.includes('rollback'), '…and rolls back');
  ok(!c.queries.includes('commit'), '…and never commits');
}
{
  const sql = `${NO_TX_MARKER}\ncreate index concurrently if not exists i on public.t (a);`;
  const c = fakeClient({ failOn: /create index/ });
  const r = quiet();
  const code = await applyMigrationSql({ client: c, sql, label: 'i.sql', log: r.write, err: r.write });
  eq('a failed no-transaction migration exits 1', code, 1);
  ok(!c.queries.includes('rollback'), '…and does not pretend to roll back what was never in a transaction');
  ok(/i\.sql/.test(r.text()), '…and the failure names the file');
}
{
  const c = fakeClient();
  const r = quiet();
  const code = await applyMigrationSql({ client: c, sql: 'create index concurrently i on public.t (a);', label: 'i.sql', log: r.write, err: r.write });
  eq('an unmarked concurrent file exits 1 through the apply path too', code, 1);
  eq('…and issues no query at all', c.queries, []);
}

// ── a concurrent index that FAILED to build must not read as applied ─────────
// `CREATE INDEX CONCURRENTLY` that fails leaves the index behind, marked INVALID — and
// `IF NOT EXISTS` then skips it for ever, so a re-run "succeeds" while the planner never
// uses it. The statement itself does not raise; only pg_index.indisvalid says so.
{
  eq('the index name comes out of the statement',
    indexNameOf('create index concurrently if not exists foo_idx on public.t (a);'), 'foo_idx');
  eq('…with or without IF NOT EXISTS', indexNameOf('CREATE INDEX CONCURRENTLY bar_idx ON public.t (a);'), 'bar_idx');
  eq('…and a non-index statement has none', indexNameOf('alter table public.t add column c text;'), null);
  eq('…as does a comment that merely mentions one',
    indexNameOf('-- create index concurrently foo_idx on t (a)\nalter table public.t add column c text;'), null);

  const validSql = `${NO_TX_MARKER}\ncreate index concurrently if not exists foo_idx on public.t (a);`;
  const idxClient = (indisvalid) => {
    const queries = [];
    return {
      queries,
      query: async (text, params) => {
        queries.push({ text, params });
        if (/indisvalid/.test(text)) return { rows: indisvalid === null ? [] : [{ indisvalid }] };
        return { rows: [] };
      },
    };
  };

  let c = idxClient(true);
  let r = quiet();
  let code = await applyMigrationSql({ client: c, sql: validSql, label: 'foo.sql', log: r.write, err: r.write });
  eq('a VALID index exits 0', code, 0);
  const check = c.queries.find((q) => /indisvalid/.test(q.text));
  ok(check, 'the build is checked against pg_index after the statement');
  ok(check.params?.some((p) => String(p).includes('foo_idx')), '…by the index it just created, as a parameter');
  ok(c.queries.indexOf(check) > 0, '…after the create, never before');

  c = idxClient(false);
  r = quiet();
  code = await applyMigrationSql({ client: c, sql: validSql, label: 'foo.sql', log: r.write, err: r.write });
  eq('an INVALID index exits 1 — a half-built index is not an applied migration', code, 1);
  ok(/invalid/i.test(r.text()), '…and says the index is invalid');
  ok(/drop index concurrently if exists foo_idx/i.test(r.text()),
    '…and gives the exact recovery: drop it concurrently, then re-run (IF NOT EXISTS would skip it for ever)');

  c = idxClient(null);   // no row at all: the index is not there
  r = quiet();
  code = await applyMigrationSql({ client: c, sql: validSql, label: 'foo.sql', log: r.write, err: r.write });
  eq('an index that is not there afterwards exits 1 too', code, 1);

  // A no-transaction file that creates no index is not interrogated about one.
  c = idxClient(true);
  r = quiet();
  await applyMigrationSql({ client: c, sql: `${NO_TX_MARKER}\nalter table public.t set (fillfactor = 90);`, label: 'x.sql', log: r.write, err: r.write });
  ok(!c.queries.some((q) => /indisvalid/.test(q.text)), 'a non-index no-transaction file asks nothing about pg_index');
}

// ── the production guard ─────────────────────────────────────────────────────
// This script applies DDL to whatever SUPABASE_DB_URL names, and the documented worktree
// invocation PRELOADS the production credential (`node --env-file=<main checkout>/app/
// .env.local …`). Both data-ops refuse the production ref without `--prod` AND
// `CONFIRM_PROD=<ref>`; a script that changes the SCHEMA had none at all. Same guard,
// shared from _lib/liveGuard.mjs, decided from the environment alone.
const PASSWORD = 'n0t-a-real-p%40ssword';
const PROD_DSN = `postgresql://postgres.${PROD_REF}:${PASSWORD}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`;
const SANDBOX_DSN = 'postgres://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';
{
  const t = (env, opts) => migrationTarget(env, opts);

  eq('the production ref is read out of the connection string, never the password',
    t({ SUPABASE_DB_URL: PROD_DSN }, {}).ref, PROD_REF);
  ok(t({ SUPABASE_DB_URL: PROD_DSN }, {}).refusal, 'production is REFUSED with neither flag');
  ok(t({ SUPABASE_DB_URL: PROD_DSN }, { prod: true }).refusal, '…and with --prod alone');
  ok(t({ SUPABASE_DB_URL: PROD_DSN }, { confirmProd: PROD_REF }).refusal, '…and with CONFIRM_PROD alone');
  eq('…and proceeds only with BOTH',
    t({ SUPABASE_DB_URL: PROD_DSN }, { prod: true, confirmProd: PROD_REF }).refusal, null);
  ok(t({ SUPABASE_DB_URL: PROD_DSN }, {}).refusal.includes('CONFIRM_PROD'),
    'the refusal says what it wants');
  ok(!t({ SUPABASE_DB_URL: PROD_DSN }, {}).refusal.includes(PASSWORD),
    '…and never quotes the credential');

  eq('a sandbox ref needs no ceremony', t({ SUPABASE_DB_URL: SANDBOX_DSN }, {}).refusal, null);
  eq('…and is named so the operator can see where it is pointed',
    t({ SUPABASE_DB_URL: SANDBOX_DSN }, {}).ref, 'abcdefghijklmnopqrst');

  ok(t({ SUPABASE_DB_URL: 'postgresql://postgres:pw@localhost:5432/postgres' }, {}).refusal,
    'an UNPARSEABLE ref is refused — it cannot be checked against the production one');
  ok(t({}, {}).refusal, 'no SUPABASE_DB_URL at all is refused, not defaulted');

  // The guard is the shared one, and the target is printed before anything connects.
  ok(/from '\.\/_lib\/liveGuard\.mjs'/.test(SRC) && /refuseTarget/.test(SRC),
    'it runs the SHARED guard (_lib/liveGuard.mjs), not a third copy');
  const guardAt = SRC.indexOf('migrationTarget(');
  const printAt = SRC.indexOf('printTarget({');
  const importAt = SRC.indexOf("await import('pg')");
  const connAt2 = SRC.indexOf('.connect()');
  ok(guardAt > 0 && printAt > 0 && importAt > 0, 'the script has a target, a print and a driver import');
  ok(guardAt < importAt && guardAt < connAt2, 'the refusal is decided before the driver is imported and before any connection');
  ok(printAt < connAt2, 'the target is printed before the connection, so a failed connect still names the project');
  ok(/--prod/.test(SRC) && /CONFIRM_PROD/.test(SRC), 'both flags are read from the invocation');
}

// ── the script's own shape ───────────────────────────────────────────────────
{
  ok(!/process\.exit\(/.test(SRC), 'exit codes are set, never process.exit() — it can crash node on Windows after network I/O (CS-465)');
  eq('the script connects exactly once — Supabase bans an address after failed passwords',
    (SRC.match(/\.connect\(\)/g) || []).length, 1);
  ok(!/for\s*\(.*attempt|retry|while\s*\(/i.test(SRC.slice(SRC.indexOf('.connect()') - 400, SRC.indexOf('.connect()') + 200)),
    'there is no retry loop around the connect');
  ok(/import\.meta\.url/.test(SRC) && /process\.argv\[1\]/.test(SRC),
    'the live section is behind a main-module guard, so importing the script opens nothing');
  const planAt = SRC.indexOf('planApply(', SRC.indexOf('export function planApply') + 10);
  const connAt = SRC.indexOf('.connect()');
  ok(planAt > 0 && connAt > 0 && planAt < connAt, 'the refusal is decided BEFORE a connection is opened');
  ok(!/SUPABASE_DB_URL\s*\)?\s*;?\s*$/m.test(SRC.split('\n')[0] || ''), 'the credential is never echoed');
}

// ── the three step-5 migration files ─────────────────────────────────────────
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const after = files.filter((f) => f > '20260925120000');
const find = (frag) => after.find((f) => f.includes(frag));
const readMig = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8');

{
  const col = find('inspection_templates_client_id');
  ok(col, `the column migration exists after 20260925120000 (saw: ${after.join(', ') || 'none'})`);
  if (col) {
    const sql = readMig(col);
    ok(/alter table public\.inspection_templates\s+add column if not exists client_id text/i.test(sql),
      'the column is added idempotently as text');
    ok(/comment on column public\.inspection_templates\.client_id/i.test(sql),
      'the column carries a comment saying what null means');
    ok(/null[^\n]*starter/i.test(sql), '…and that comment says null = a starter');
    ok(/^-- forward-fix:/m.test(sql) || /^-- rollback:/m.test(sql), '3.5.7: it carries a forward-fix / rollback header line');
    ok(/set lock_timeout/i.test(sql), '3.5.7: lock-safe DDL — lock_timeout is set');
    ok(readApplyMode(sql) === 'transaction' && !planApply(sql).refusal, 'the column migration plans cleanly in a transaction');

    // F4: the summary reads a denormalized count instead of every published schema
    // (~39 MB of jsonb at 3,750 checklists), so the column ships with this migration and
    // is backfilled from each row's published version. The table is small.
    ok(/add column if not exists item_count int/i.test(sql), 'it also adds `item_count int`');
    ok(/comment on column public\.inspection_templates\.item_count/i.test(sql), '…with a comment saying what it is');
    const code = stripSql(sql);
    ok(/update\s+public\.inspection_templates/i.test(code), 'F4: item_count is BACKFILLED, not left null on existing rows');
    ok(/jsonb_array_length/i.test(code) && /published_version_id/i.test(code),
      '…computed from each row\'s PUBLISHED version schema');
    ok(/client_id/i.test(code) ? !/update[\s\S]{0,200}set\s+client_id/i.test(code) : true,
      'NO client_id BACKFILL: production holds 0 per-cleaner assignments, so every existing row is correctly a starter');
  }

  // F5: (organization_id, kind, client_id) — EVERY template read filters org + kind, and
  // only some of them add a customer, so the optional column goes last or the index cannot
  // serve the reads that omit it.
  for (const [frag, table, cols] of [
    ['inspection_templates_org_client_kind_idx', 'public.inspection_templates', '(organization_id, kind, client_id)'],
    ['checklist_results_gate_idx', 'public.checklist_results', '(organization_id, job_id, completed_by_user_id, template_id)'],
  ]) {
    const f = find(frag);
    ok(f, `${frag} has its own migration file`);
    if (!f) continue;
    const sql = readMig(f);
    const plan = planApply(sql);
    eq(`${frag}: plans as a single no-transaction statement`, { mode: plan.mode, refusal: plan.refusal, count: plan.count },
      { mode: 'no-transaction', refusal: null, count: 1 });
    ok(new RegExp(`create index concurrently if not exists ${frag}\\s+on ${table.replace('.', '\\.')}`, 'i').test(sql),
      `${frag}: CREATE INDEX CONCURRENTLY IF NOT EXISTS on ${table}`);
    ok(sql.replace(/\s+/g, ' ').toLowerCase().includes(cols.toLowerCase()), `${frag}: indexes ${cols}`);
    ok(/^-- forward-fix:/m.test(sql) || /^-- rollback:/m.test(sql), `${frag}: carries a forward-fix / rollback header line`);
    // CODE, not the header: the header is expected to SAY why there is no lock_timeout.
    ok(!/set\s+lock_timeout/i.test(stripSql(sql)),
      `${frag}: no lock_timeout statement — a second statement would break the no-transaction rule, and a lock timeout aborts a concurrent build`);
    // F6: a failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS then skips
    // for ever, so "just re-run it" is wrong advice. The file has to say how to recover.
    ok(new RegExp(`drop index concurrently if exists[\\s\\S]{0,80}${frag}`, 'i').test(sql),
      `${frag}: the header says to DROP the invalid index concurrently before re-running`);
    ok(!/safe to re-?run|only slower, so a failed build is never a broken deploy — re-run it/i.test(sql),
      `${frag}: …and no longer claims a failed build is simply safe to re-run`);
  }
}

console.log(`\napply-migration-modes: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
