// Apply a .sql migration to the live Supabase Postgres via SUPABASE_DB_URL.
// Wraps the file in a transaction (Postgres DDL is transactional); idempotent
// migrations (add ... if not exists) are safe to re-run.
//   node scripts/apply-migration.mjs <path-to.sql>       (run from app/)
import { readFileSync } from 'node:fs';
import pg from 'pg';

const sqlPath = process.argv[2];
if (!sqlPath) { console.error('usage: node scripts/apply-migration.mjs <path-to.sql>'); process.exit(1); }
const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  if (line.trim().startsWith('#')) continue;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2];
}
if (!env.SUPABASE_DB_URL) { console.error('✖ No SUPABASE_DB_URL in app/.env.local'); process.exit(1); }
const sql = readFileSync(sqlPath, 'utf8');
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query('begin'); await client.query(sql); await client.query('commit');
  console.log('✓ applied:', sqlPath);
} catch (e) {
  try { await client.query('rollback'); } catch { /* ignore */ }
  console.error('✖ migration failed:', e.message); process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
