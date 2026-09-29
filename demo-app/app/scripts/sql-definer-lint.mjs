// sql-definer-lint — the build-failing sweep for un-revoked SECURITY DEFINER functions.
//
// THE LAW (playbook Part V, Security): "`SECURITY DEFINER` RPC executable by PUBLIC
// (Postgres default) → any phone could purge audit evidence → explicit REVOKE-to-service_role
// in the same migration, always." Part III A4.3 says the same at clone time.
//
// WHY A SWEEP AND NOT A CODE REVIEW. Concordia already got this right twice — by hand.
// `20260720140000_job_deletes_tombstones.sql:181` even says so: "Same class as the hole
// 20260713000000_revoke_org_state_signal_rpc.sql was" — the second instance was caught
// because a human remembered the first. That is exactly the failure Part V names: "fixing an
// instance is not fixing the bug → shared primitive + BUILD-FAILING SWEEP." The primitive
// existed; the sweep did not, so migration #35 could ship PUBLIC-executable with nothing to
// stop it. This is that sweep.
//
// WHAT COUNTS AS AT-RISK. Only CALLABLE definers. A `returns trigger` function is not
// reachable at /rest/v1/rpc — PostgREST never exposes it — which is why the five trigger
// definers in this repo legitimately carry no revoke
// (`20260721000000_jobs_broadcast_statement_level.sql:33` states this).
//
// 🔴 SQL IN THIS REPO IS LOWERCASE. A case-SENSITIVE grep for "REVOKE" during the 2026-07-27
// audit returned zero hits against seven `security definer` declarations and very nearly
// shipped as a false privilege-escalation critical. Everything here is case-insensitive.
//
// Usage:
//   node scripts/sql-definer-lint.mjs            # from app/ — exit 1 on any un-revoked definer
//   node scripts/sql-definer-lint.mjs --list     # show every definer found and its verdict
//
// Escape hatch:
//   -- sql-definer-lint:allow <fnName> — reason
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const LIST = process.argv.includes('--list');

if (!fs.existsSync(MIGRATIONS)) {
  console.log('\nsql-definer-lint: SKIPPED — supabase/migrations/ not found.');
  console.log('  (this is NOT a clean result — no files were checked)\n');
  process.exit(0);
}

// Strip SQL comments so a `--` line or a /* */ block mentioning "security definer" or a
// revoke cannot create a phantom match in either direction.
const stripSql = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*--[^\n]*/gm, ' ');

const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const rows = [];

for (const file of files) {
  const raw = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const src = stripSql(raw);

  // `create [or replace] function [schema.]name(args) ... returns X ... security definer`
  // Body-delimited, so we bound each declaration at the next `create ... function` or `$$`.
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(([^)]*)\)([\s\S]*?)(?=create\s+(?:or\s+replace\s+)?function|\$\$|$)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rawName = m[1].replace(/"/g, '');
    const name = rawName.includes('.') ? rawName.split('.').pop() : rawName;
    const head = m[3] || '';
    if (!/security\s+definer/i.test(head)) continue;

    const returnsTrigger = /returns\s+trigger/i.test(head);
    // A same-file revoke of EXECUTE from the browser roles.
    const revoked = new RegExp(
      `revoke\\s+execute\\s+on\\s+function\\s+[a-z0-9_."]*${name}\\b[^;]*?from[^;]*?public`, 'i',
    ).test(src);
    const allowed = new RegExp(`sql-definer-lint:allow\\s+${name}\\b`, 'i').test(raw);

    rows.push({ file, name, returnsTrigger, revoked, allowed });
  }
}

const atRisk = rows.filter((r) => !r.returnsTrigger && !r.revoked && !r.allowed);

if (LIST) {
  console.log(`\nsql-definer-lint — ${files.length} migrations, ${rows.length} security-definer function(s)\n`);
  for (const r of rows) {
    const verdict = r.returnsTrigger ? 'returns trigger — not RPC-callable'
      : r.revoked ? 'revoked from public ✓'
        : r.allowed ? 'allow-listed' : '🔴 CALLABLE AND NOT REVOKED';
    console.log(`  ${r.name.padEnd(28)} ${verdict}\n    ${r.file}`);
  }
  console.log('');
  process.exit(0);
}

console.log(`\nsql-definer-lint — ${files.length} migrations · ${rows.length} security-definer function(s) · `
  + `${rows.filter((r) => r.returnsTrigger).length} trigger-only · ${rows.filter((r) => r.revoked).length} revoked`);
if (atRisk.length) {
  console.error(`\n✖ ${atRisk.length} CALLABLE security-definer function(s) with no same-file revoke:\n`);
  for (const r of atRisk) console.error(`    ${r.file}\n      ${r.name}() is executable by PUBLIC (Postgres default)`);
  console.error('\n  Add, in the SAME migration:');
  console.error('    revoke execute on function public.<fn>(<args>) from public, anon, authenticated;');
  console.error('    grant  execute on function public.<fn>(<args>) to service_role;');
  console.error('  Or annotate:  -- sql-definer-lint:allow <fn> — reason\n');
  process.exit(1);
}
console.log('  ✓ every callable security-definer function is revoked from public\n');
