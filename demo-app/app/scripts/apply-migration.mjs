// Apply a .sql migration to the live Supabase Postgres via SUPABASE_DB_URL.
//
//   node scripts/apply-migration.mjs <path-to.sql>
//
//   Production needs BOTH `--prod` and `CONFIRM_PROD=<the prod ref>`, the same §8.2 guard
//   both live data-ops run (it was missing here until 2026-09-28):
//   CONFIRM_PROD=<prod ref> node --env-file="<checkout>/app/.env.local" app/scripts/apply-migration.mjs <path-to.sql> --prod
//   (PowerShell: $env:CONFIRM_PROD='<prod ref>'; node --env-file="…" … --prod)
//
// 🔴 A PRODUCTION DDL CHANGE. It runs only on the owner's recorded go (DEV_PLAYBOOK 3.10.1).
//    DEV_PLAYBOOK 3.5.7 names `supabase db push` as the migration route and this script as a
//    forbidden one; it is used here only because the migration ledger is drifted (CS-024),
//    which is the same exception CS-002 was applied under. The owner picks the route.
//
// There is NO DRY RUN: a migration either runs or it does not. What stands in for one is
// the refusal set below, every one of them decided from the file and the environment before
// a socket is opened — and the project ref printed before the connect, so an operator sees
// where they are pointed before anything happens.
//
// TWO MODES, because one of them is not optional:
//   · DEFAULT — the whole file in `begin … commit`. Postgres DDL is transactional, so a
//     migration either lands whole or not at all, and an idempotent file (`… if not exists`)
//     is safe to re-run.
//   · NO TRANSACTION — the file carries `-- apply: no-transaction` in its LEADING comment
//     block. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block (Postgres
//     answers 25001), so an index built concurrently has to be sent on a bare connection.
//
// And three refusals, all decided from the file alone, BEFORE a connection is opened:
//   1. `concurrently` in code without the marker — it would fail with 25001 after the
//      connection was made, which reads like a broken migration rather than a wrong route;
//   2. the marker on a file holding MORE THAN ONE statement — outside a transaction there
//      is nothing to undo statement 1 when statement 2 fails, so it could half-apply.
//      A concurrent index therefore lives alone in its own file (3.5.7), with no
//      `set lock_timeout` beside it — which is right anyway: a lock timeout during a
//      concurrent build aborts the build;
//   3. a file holding no statement at all — silently "applying" nothing is worse than a
//      refusal, because the ledger then records a migration that did nothing.
//
// The pure halves are exported so scripts/test-apply-migration-modes.mjs can prove every
// refusal and both apply paths offline, on an injected fake client — no socket, no
// credential. The live section is behind a main-module guard, so importing this file
// opens nothing.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// The SAME §8.2 guard both live data-ops run (CS-025). A script that changes the SCHEMA had
// none: it applied DDL to whatever SUPABASE_DB_URL named, and the documented worktree
// invocation preloads the production credential.
import { PROD_REF, refFromDbUrl, refuseTarget, printTarget } from './_lib/liveGuard.mjs';

export const NO_TX_MARKER = '-- apply: no-transaction';
export { PROD_REF };

// ── reading the file ─────────────────────────────────────────────────────────
// Replace every comment and literal with blanks, so the scanner below sees CODE only:
// a `;` inside `'null; means starter'` ends no statement, and the word "concurrently" in a
// header comment is not a concurrent index. Line comments, block comments, single-quoted
// strings (with '' escapes), double-quoted identifiers and dollar-quoted bodies.
export function stripSql(sql) {
  const s = String(sql || '');
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (two === '--') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out += blank(s.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += blank(s.slice(i, stop));
      i = stop;
      continue;
    }
    if (s[i] === "'" || s[i] === '"') {
      const q = s[i];
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === q) { if (s[j + 1] === q) { j += 2; continue; } j += 1; break; }
        j += 1;
      }
      out += blank(s.slice(i, j));
      i = j;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = s.indexOf(tag, i + tag.length);
      const stop = end === -1 ? s.length : end + tag.length;
      out += blank(s.slice(i, stop));
      i = stop;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

// The statements a file holds, as CODE (comments and literals blanked). Only the COUNT and
// "is there one at all" are load-bearing here — the file itself is still sent verbatim.
export function splitStatements(sql) {
  return stripSql(sql).split(';').map((p) => p.trim()).filter(Boolean);
}

export function hasConcurrently(sql) {
  return /\bconcurrently\b/i.test(stripSql(sql));
}

// The marker counts only in the LEADING block — the comment/blank lines before the first
// line of code. Buried at the foot of a long file it is just a comment; read from anywhere
// it would silently disarm the transaction for every statement above it.
export function readApplyMode(sql) {
  for (const line of String(sql || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('--')) break;
    if (t === NO_TX_MARKER || t.startsWith(`${NO_TX_MARKER} `)) return 'no-transaction';
  }
  return 'transaction';
}

// What this file will do, or why it will not run. A VALUE, so the refusal is decided (and
// testable) with no connection open.
export function planApply(sql) {
  const statements = splitStatements(sql);
  const mode = readApplyMode(sql);
  const count = statements.length;
  const refuse = (refusal) => ({ mode, count, refusal });
  if (!count) return refuse('the file holds no SQL statement — nothing to apply.');
  if (mode === 'no-transaction' && count > 1) {
    return refuse(`${NO_TX_MARKER} is only for a file holding ONE statement; this one holds ${count}.\n`
      + '   Outside a transaction nothing undoes statement 1 when statement 2 fails, so it could half-apply.\n'
      + '   Split it: CREATE INDEX CONCURRENTLY goes in its own file (DEV_PLAYBOOK 3.5.7), with no `set` beside it.');
  }
  if (mode !== 'no-transaction' && hasConcurrently(sql)) {
    return refuse('this file uses CONCURRENTLY, which Postgres refuses inside a transaction block (25001).\n'
      + `   Put ${NO_TX_MARKER} in its header — and keep it to that one statement.`);
  }
  return { mode, count, refusal: null };
}

// WHICH PROJECT this run would change, and whether it may — a VALUE, decided from the
// environment alone, so the refusal is testable with no socket open. This script only ever
// speaks Postgres, so the ref comes out of the DSN (`postgres.<ref>` for the pooler,
// `db.<ref>.supabase.co` for the direct host) and an UNPARSEABLE one is refused: an unknown
// ref cannot be checked against the production ref, so it may not be assumed harmless.
export function migrationTarget(env = process.env, { prod = false, confirmProd = null } = {}) {
  if (!env.SUPABASE_DB_URL) {
    return { ref: null, refusal: '\n⛔ No SUPABASE_DB_URL in app/.env.local or the environment.\n' };
  }
  const ref = refFromDbUrl(env.SUPABASE_DB_URL);
  return { ref, refusal: refuseTarget({ transport: 'pg', ref, prod, confirmProd }) };
}

// The index a `create index [concurrently] [if not exists] <name> on …` builds, or null.
// Read off the CODE, so the same words in a header comment name nothing.
export function indexNameOf(sql) {
  const m = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([A-Za-z_][\w$]*)/i.exec(stripSql(sql));
  return m ? m[1] : null;
}

// Send the file on an already-connected client. Returns the exit code; never exits itself.
export async function applyMigrationSql({ client, sql, label = 'migration', log = console.log, err = console.error }) {
  const plan = planApply(sql);
  if (plan.refusal) { err(`\n⛔ REFUSING ${label}: ${plan.refusal}\n`); return 1; }
  if (plan.mode === 'no-transaction') {
    try {
      await client.query(sql);
    } catch (e) {
      err(`✖ migration failed: ${label}: ${e.message}`);
      err('  It ran OUTSIDE a transaction, so nothing was rolled back.');
      const idx = indexNameOf(sql);
      if (idx) err(`  Recover with:  drop index concurrently if exists ${idx};   then run this file again.`);
      return 1;
    }
    // 🔴 THE STATEMENT SUCCEEDING IS NOT THE INDEX EXISTING. A CREATE INDEX CONCURRENTLY
    // that fails part-way leaves the index behind marked INVALID — the planner ignores it,
    // and `if not exists` then finds the name and skips the rebuild FOR EVER, so every
    // re-run "succeeds" against an index nothing uses. Only pg_index says which it is.
    const idx = indexNameOf(sql);
    if (idx) {
      try {
        const { rows } = await client.query(
          'select i.indisvalid from pg_index i where i.indexrelid = to_regclass($1)::oid', [idx]);
        if (!rows || !rows.length) {
          err(`✖ ${label}: the statement ran but ${idx} is not there. Nothing to re-use; run this file again.`);
          return 1;
        }
        if (rows[0].indisvalid === false) {
          err(`✖ ${label}: ${idx} was built INVALID — the concurrent build did not complete.`);
          err(`  The planner will ignore it, and \`if not exists\` would skip the rebuild for ever.`);
          err(`  Recover with:  drop index concurrently if exists ${idx};   then run this file again.`);
          return 1;
        }
      } catch (e) {
        err(`✖ ${label}: could not confirm ${idx} is valid: ${e.message}`);
        return 1;
      }
    }
    log(`✓ applied (no transaction, 1 statement${idx ? `, ${idx} is valid` : ''}): ${label}`);
    return 0;
  }
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    log(`✓ applied (transaction, ${plan.count} statement${plan.count === 1 ? '' : 's'}): ${label}`);
    return 0;
  } catch (e) {
    try { await client.query('rollback'); } catch { /* the connection may already be gone */ }
    err(`✖ migration failed, rolled back: ${label}: ${e.message}`);
    return 1;
  }
}

// ── live section ─────────────────────────────────────────────────────────────
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const sqlPath = process.argv[2];
  if (!sqlPath) {
    console.error('usage: node scripts/apply-migration.mjs <path-to.sql>');
    process.exitCode = 1;
  } else {
    let sql = null;
    try { sql = readFileSync(sqlPath, 'utf8'); } catch (e) { console.error(`✖ cannot read ${sqlPath}: ${e.message}`); }
    // The plan (and every refusal) is decided from the file BEFORE the credential is read
    // or a socket is opened, so a wrong-shaped file never reaches production at all.
    const plan = sql == null ? null : planApply(sql);
    if (sql == null) {
      process.exitCode = 1;
    } else if (plan.refusal) {
      console.error(`\n⛔ REFUSING ${sqlPath}: ${plan.refusal}\n`);
      process.exitCode = 1;
    } else {
      const env = {};
      try {
        for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
          if (line.trim().startsWith('#')) continue;
          const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
          if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
        }
      } catch { /* the environment may already carry the credential (node --env-file=…) */ }
      Object.assign(env, process.env);
      // §8.2 rule 3, the same one both data-ops run: WHICH project, and may this proceed?
      // Decided here, before the driver is imported and before any connection.
      const PROD = process.argv.includes('--prod');
      const target = migrationTarget(env, { prod: PROD, confirmProd: env.CONFIRM_PROD });
      if (target.refusal) {
        console.error(target.refusal);
        process.exitCode = 1;
      } else {
        // §8.2 rule 2: name the target BEFORE the connection, so a failed connect still
        // says which project the run was pointed at. `apply` is true because there is no
        // dry run here — a migration either runs or it does not.
        printTarget({
          op: 'apply-migration', ref: target.ref, transport: 'pg', apply: true,
          envLabel: 'app/.env.local or the preloaded environment',
        });
        console.log(`  file         : ${sqlPath}\n  mode         : ${plan.mode} (${plan.count} statement${plan.count === 1 ? '' : 's'})`);
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
        try {
          // ONCE. Supabase bans an address after a few failed password attempts, so a
          // connect that fails is reported, never retried.
          await client.connect();
          process.exitCode = await applyMigrationSql({ client, sql, label: sqlPath });
        } catch (e) {
          console.error('connect failed:', e.message);
          process.exitCode = 1;
        } finally { await client.end().catch(() => {}); }
      }
    }
  }
}
