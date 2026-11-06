// test-drop-snapshot-review-columns — the contract migration that drops the finances snapshot's
// four review columns when Google reviews leave the app (Daniel, 2026-10-20: "Drop them too").
//
//   C1  the migration exists, names the migration that created the columns, says contract, and
//       says to apply it AFTER the deploy
//   C2  it drops exactly the four columns of public.financial_snapshot, each `if exists`, and
//       nothing else (no CASCADE, no other table)
//   C3  the creating migration made exactly those four columns
//   🔴 C4  nothing in app/api, app/src or app/scripts reads or writes the columns any more
//       (comments aside), so the code runs the same before and after the drop
//
// Static and offline. Fails before the migration exists (C1).
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.resolve(APP, '..', 'supabase', 'migrations');
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

const COLUMNS = ['google_reviews_actual', 'google_reviews_goal', 'indeed_reviews_actual', 'indeed_reviews_goal'];
const CREATOR = '20260605130000_dashboard_snapshot_metrics.sql';
const FILE = '20261020120100_drop_snapshot_review_columns.sql';

if (!existsSync(MIGRATIONS)) {
  console.log('test-drop-snapshot-review-columns: the repo has no supabase/migrations/ — nothing to check (a no-backend clone).');
} else {
  const sql = read(path.join(MIGRATIONS, FILE));
  const header = sql.split('\n').filter((l) => l.startsWith('--')).join('\n');
  const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const statements = body.split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

  // ── C1 the file and its header ──
  ok('C1a the migration exists', sql.length > 0);
  ok('C1b its header names the migration that created the columns', header.includes(CREATOR));
  ok('C1c it says contract, and to apply it AFTER the deploy', /expand\|contract: contract/.test(header) && /APPLY THIS AFTER THE DEPLOY/.test(header));

  // ── C2 exactly those four drops ──
  const timeouts = statements.filter((s) => /^set (lock|statement)_timeout/i.test(s));
  const drops = statements.filter((s) => /^alter table/i.test(s));
  const others = statements.filter((s) => !timeouts.includes(s) && !drops.includes(s));
  ok('C2a nothing but the drops (and its two timeouts)', others.length === 0 && timeouts.length === 2, others);
  const expected = COLUMNS.map((c) => `alter table public.financial_snapshot drop column if exists ${c}`);
  ok('C2b it drops exactly the four columns, each `if exists`, on public.financial_snapshot',
    JSON.stringify(drops.map((s) => s.toLowerCase()).sort()) === JSON.stringify(expected.slice().sort()), drops);
  ok('C2c never CASCADE', !/cascade/i.test(body));

  // ── C3 the creator made exactly these ──
  const made = read(path.join(MIGRATIONS, CREATOR));
  const created = [...made.matchAll(/add column if not exists (\w+)/gi)].map((m) => m[1]).filter((c) => /reviews/.test(c));
  ok('C3 the creating migration made exactly these four review columns', JSON.stringify(created.sort()) === JSON.stringify(COLUMNS.slice().sort()), created);

  // ── C4 no code names them (comments aside) ──
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(m?js|jsx)$/.test(name) || name === path.basename(fileURLToPath(import.meta.url))) continue;
      read(p).split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (COLUMNS.some((c) => code.includes(c))) hits.push(`${path.relative(APP, p)}:${i + 1}`);
      });
    }
  };
  for (const d of ['api', 'src', 'scripts']) walk(path.join(APP, d));
  ok('🔴 C4 nothing in app/api, app/src or app/scripts names the four columns', hits.length === 0, hits);
}

if (fails.length) {
  console.log(`test-drop-snapshot-review-columns: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-drop-snapshot-review-columns: ${pass} passed, 0 failed`);
}
