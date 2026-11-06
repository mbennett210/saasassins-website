// The contract migration that drops the Google Business Profile tables
// (supabase/migrations/20261020120000_drop_gmb_tables.sql; Google reviews removed, 2026-10-20),
// held statically. The rehearsal itself ran on PGlite (the two creating migrations, the sent-log
// migration and a decoy neighbour, then this file twice: 8 of 8 — the three tables and their four
// indexes gone, every other relation, function, trigger, policy and grant unchanged, the second run
// a no-op), recorded in the file's header.
//   M1  the header names the migrations that created what it drops, says contract, and says AFTER
//       the deploy
//   M2  it drops exactly gmb_connection, gmb_reviews, gmb_keywords and gmb_reviews_org_updated_idx —
//       nothing else, every statement `if exists`, never CASCADE (a dependency nobody knew of stops
//       it instead of going with it)
//   M3  the creating migrations made exactly those objects (so nothing of theirs is left behind)
//   M4  nothing in the app, its API or its scripts names the tables any more (the code before the
//       deploy is the only reader, which is why it applies after)
// REGRESSION (THE LAW II.3): on 9d2669cd there is no such migration and api/_lib/gmb/store.js still
// reads all three tables — M1, M2 and M4 fail.
//   node app/scripts/test-drop-gmb-tables-migration.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.resolve(APP, '..', 'supabase', 'migrations');
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

const TABLES = ['gmb_connection', 'gmb_reviews', 'gmb_keywords'];
const INDEXES = ['gmb_reviews_org_updated_idx'];
const CREATORS = ['20260731000000_gmb_reviews.sql', '20260801000000_gmb_keywords.sql'];

if (!existsSync(MIGRATIONS)) {
  console.log('test-drop-gmb-tables-migration: the repo has no supabase/migrations/ — nothing to check (a no-backend clone).');
} else {
  const sql = read(path.join(MIGRATIONS, '20261020120000_drop_gmb_tables.sql'));
  const header = sql.split('\n').filter((l) => l.startsWith('--')).join('\n');
  const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const statements = body.split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

  // ── M1 the header ──
  ok('M1a the migration exists', sql.length > 0);
  ok('M1b its header names the migrations that created what it drops', CREATORS.every((f) => header.includes(f)), CREATORS.filter((f) => !header.includes(f)));
  ok('M1c it says contract, and to apply it AFTER the deploy', /expand\|contract: contract/.test(header) && /APPLY THIS AFTER THE DEPLOY/.test(header));

  // ── M2 exactly those objects ──
  const drops = statements.filter((s) => /^drop /i.test(s));
  const others = statements.filter((s) => !/^drop /i.test(s) && !/^set (lock_timeout|statement_timeout) /i.test(s));
  ok('M2a nothing but the drops (and its two timeouts)', others.length === 0, others);
  const dropped = drops.map((s) => (/^drop (table|index) if exists public\.([a-z_]+)$/i.exec(s) || []).slice(1).join(':'));
  ok('M2b it drops exactly the three tables and the index, each `if exists`, in the public schema',
    JSON.stringify(dropped.slice().sort()) === JSON.stringify([...TABLES.map((t) => `table:${t}`), ...INDEXES.map((i) => `index:${i}`)].sort()), drops);
  ok('M2c never CASCADE', !/cascade/i.test(body));

  // ── M3 the creators made exactly those ──
  const made = CREATORS.map((f) => read(path.join(MIGRATIONS, f))).join('\n');
  const createdTables = [...made.matchAll(/create table if not exists ([a-z_.]+)/gi)].map((m) => m[1].replace(/^public\./, ''));
  const createdIndexes = [...made.matchAll(/create index if not exists ([a-z_.]+)/gi)].map((m) => m[1].replace(/^public\./, ''));
  ok('M3a the creating migrations made exactly these tables', JSON.stringify(createdTables.sort()) === JSON.stringify(TABLES.slice().sort()), createdTables);
  ok('M3b …and this one named index (the primary keys leave with their tables)', JSON.stringify(createdIndexes.sort()) === JSON.stringify(INDEXES), createdIndexes);
  ok('M3c …and no function, trigger, view, policy or grant of their own', !/create (or replace )?(function|trigger|view|policy)|\bgrant\b/i.test(made));
  const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && !CREATORS.includes(f) && f !== '20261020120000_drop_gmb_tables.sql')
    .filter((f) => /gmb_/.test(read(path.join(MIGRATIONS, f))));
  ok('M3d no other migration names them (no later grant, policy or foreign key to clear)', later.length === 0, later);

  // ── M4 no reader left ──
  const hits = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|jsx|mjs)$/.test(n) && p !== fileURLToPath(import.meta.url) && /\bgmb_(connection|reviews|keywords)\b/.test(read(p))) hits.push(path.relative(APP, p));
    }
  };
  for (const d of ['api', 'src', 'scripts']) walk(path.join(APP, d));
  ok('🔴 M4 nothing in app/api, app/src or app/scripts names the three tables', hits.length === 0, hits);
}

console.log(`test-drop-gmb-tables-migration: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
