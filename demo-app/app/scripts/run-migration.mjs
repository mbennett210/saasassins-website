// Apply a SQL migration to the Supabase Postgres — DDL (ALTER/CREATE/TRIGGER) that
// PostgREST / the service-role key CANNOT do.
//
// Two auth modes, both read from app/.env.local (the gitignored file that already
// holds the Supabase secrets — this script NEVER prints them):
//   • PREFERRED — SUPABASE_ACCESS_TOKEN (a Personal Access Token from
//     supabase.com/dashboard/account/tokens). Runs SQL through the Management API,
//     the same path the dashboard SQL Editor uses. Project ref is derived from the
//     existing SUPABASE_URL — nothing else needed.
//   • FALLBACK — DATABASE_URL (Session-pooler / Direct connection string) via node-pg.
//
// Guard-railed:
//   node scripts/run-migration.mjs <file.sql>            # DRY RUN — prints target + SQL, runs nothing
//   node scripts/run-migration.mjs <file.sql> --apply    # execute
//   node scripts/run-migration.mjs --sql "select …"      # ad-hoc READ query (verification)
//
// <file.sql> may be a bare name (resolved under supabase/migrations/) or a path.
// The job-delete migration is idempotent (if-not-exists / create-or-replace), so a
// partial failure is always safe to re-run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── WHICH DATABASE ──────────────────────────────────────────────────────────────
// Read BEFORE anything else, because getting this wrong is the whole hazard.
//
// This script only ever read app/.env.local — i.e. PRODUCTION — while several
// migration headers instruct "verify on sandbox first" and cite this script by name.
// Following those instructions literally ran the verification against the live
// client database. `--sandbox` is that missing target.
//
// It HARD FAILS when app/.env.sandbox.local is absent rather than falling through to
// the production file. A silent fallback here means someone believing they are on the
// sandbox runs DDL against prod, which is the exact failure the flag exists to stop.
const SANDBOX = process.argv.includes('--sandbox');
const ENV_FILES = SANDBOX ? ['../.env.sandbox.local'] : ['../.env.local', '../.env.local.bak'];
let envLoaded = null;
for (const f of ENV_FILES) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    envLoaded = f;
    break;
  } catch { /* try next */ }
}
if (SANDBOX && !envLoaded) {
  console.error('\n⛔ --sandbox given but app/.env.sandbox.local could not be read.');
  console.error('   REFUSING to fall back to app/.env.local — that is production.\n');
  process.exit(1);
}

const PAT = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_TOKEN || null;
const DBURL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;
const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
let ref = null;
try { ref = new URL(SB_URL).hostname.split('.')[0] || null; } catch { /* */ }

if (!PAT && !DBURL) {
  console.error('No DDL credential in app/.env.local. Add ONE of:');
  console.error('  SUPABASE_ACCESS_TOKEN=sbp_…   (preferred — Personal Access Token, supabase.com/dashboard/account/tokens)');
  console.error('  DATABASE_URL=postgresql://postgres.<ref>:<password>@…pooler.supabase.com:5432/postgres');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sqlIdx = args.indexOf('--sql');
const adhoc = sqlIdx !== -1 ? args[sqlIdx + 1] : null;
const fileArg = args.find((a) => !a.startsWith('--') && a !== adhoc);

// ── Management API (PAT) ────────────────────────────────────────────────────────
async function mgmtQuery(sql) {
  if (!ref) throw new Error('Could not derive project ref from SUPABASE_URL — set it in app/.env.local.');
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${body}`);
  try { return JSON.parse(body); } catch { return body; }
}
async function mgmtTarget() {
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}`, { headers: { Authorization: `Bearer ${PAT}` } });
    if (res.ok) { const p = await res.json(); return `project "${p.name}" · ${p.region} · ref ${ref} (Management API)`; }
  } catch { /* */ }
  return `ref ${ref} (Management API)`;
}

// ── Direct connection (pg) ──────────────────────────────────────────────────────
async function withPg(fn) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

function resolveFile() {
  if (!fileArg) { console.error('Pass a migration file (or --sql "select …").'); process.exit(1); }
  const path = isAbsolute(fileArg) ? fileArg
    : (fileArg.includes('/') || fileArg.includes('\\')) ? resolve(process.cwd(), fileArg)
    : resolve(__dir, '../../supabase/migrations', fileArg);
  return { path, sql: readFileSync(path, 'utf8') };
}

async function main() {
  const usingPat = !!PAT;
  const target = usingPat ? await mgmtTarget() : `${(() => { try { const u = new URL(DBURL); return `${u.hostname}:${u.port || 5432}`; } catch { return '(db)'; } })()} (direct pg)`;
  // The env file is named explicitly. "Which database am I about to touch" must be
  // answerable from the output alone, not inferred from a project ref.
  console.log(`\nTarget → ${target}`);
  console.log(`         ${SANDBOX ? '🧪 SANDBOX' : '🔴 PRODUCTION'} · env ${envLoaded}\n`);

  if (adhoc) {
    if (!/^\s*(select|with|explain|show|table)\b/i.test(adhoc)) {
      console.error('--sql is READ-ONLY here (select/with/explain/show/table). Use a migration file + --apply for writes.');
      process.exit(1);
    }
    const rows = usingPat ? await mgmtQuery(adhoc) : (await withPg((c) => c.query(adhoc))).rows;
    console.log(`${Array.isArray(rows) ? rows.length : '?'} row(s):`);
    console.table(rows);
    return;
  }

  const { path, sql } = resolveFile();
  if (!apply) {
    console.log(`DRY RUN — nothing executed. Would apply:\n  ${path}\n${'─'.repeat(72)}`);
    console.log(sql.trim());
    console.log(`${'─'.repeat(72)}\nRe-run with --apply to execute.`);
    return;
  }

  console.log(`APPLYING ${path} …`);
  if (usingPat) {
    await mgmtQuery(sql);
    console.log('✓ Applied via Management API.');
  } else {
    await withPg(async (c) => {
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('COMMIT'); console.log('✓ COMMITTED.'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    });
  }
}

main().catch((e) => { console.error('✗ ' + (e.message || e)); process.exitCode = 1; });
