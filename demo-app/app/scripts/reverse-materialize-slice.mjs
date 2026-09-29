// REVERSE-MATERIALIZE a decomposed slice: per-row table  →  back into the org_state blob.
//
// This is the rollback half of every extraction in REMEDIATION_PLAN.md Increments 3-9.
// A prune (emptying a slice from the blob) is the ONLY point of no return in the plan;
// this script is what makes it recoverable, so it must exist and be sandbox-tested
// BEFORE any prune runs (the REVERSE-SCRIPT-BEFORE-PRUNE invariant).
//
//   node scripts/reverse-materialize-slice.mjs --slice=notifications            # DRY RUN
//   node scripts/reverse-materialize-slice.mjs --slice=notifications --apply    # execute
//
// SAFETY PROPERTIES
//   • Refuses to run unless the slice is listed in org_state.freeze_strip. Without the
//     freeze, the very next flush() from ANY upgraded tab immediately re-strips the
//     slice you just restored — you would "succeed" and silently lose the data again.
//     Rollback order is therefore: set freeze_strip → run this → (optionally) revert code.
//   • Backs up the live blob to a timestamped file before writing.
//   • CAS-guarded: writes only if org_state.version is unchanged since the read, so a
//     concurrent client save can never be clobbered. Re-run on conflict.
//   • Idempotent: the slice is REPLACED wholesale from the table, so running twice
//     lands the same state.
//   • Dry-run by default; --apply is required to write.
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ORG = process.env.VITE_CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
const APPLY = process.argv.includes('--apply');
const sliceArg = process.argv.find((a) => a.startsWith('--slice='));
const SLICE = sliceArg ? sliceArg.split('=')[1] : null;
// Slice key → source table. Extend as each increment lands.
const TABLE_FOR = { jobs: 'jobs', notifications: 'notifications', messages: 'messages', conversations: 'conversations' };

if (!SLICE) { console.error('Usage: --slice=<key> [--apply]'); process.exit(1); }
const TABLE = TABLE_FOR[SLICE];
if (!TABLE) { console.error(`Unknown slice "${SLICE}". Known: ${Object.keys(TABLE_FOR).join(', ')}`); process.exit(1); }

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in app/.env.local');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = (...a) => console.log(...a);

async function main() {
  log(`\nReverse-materialize  slice="${SLICE}"  ←  public.${TABLE}`);
  log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (writes nothing)'}\n`);

  // 1. Read the blob + the fleet controls.
  const { data: row, error: e1 } = await db
    .from('org_state')
    .select('state, version, freeze_strip')
    .eq('organization_id', ORG)
    .maybeSingle();
  if (e1) throw e1;
  if (!row) { console.error('No org_state row found.'); process.exit(1); }

  const freeze = Array.isArray(row.freeze_strip) ? row.freeze_strip : [];
  log(`org_state.version   : ${row.version}`);
  log(`freeze_strip        : ${freeze.length ? freeze.join(', ') : '(none)'}`);

  // 2. HARD GATE — refuse without the freeze. Restoring into an unfrozen slice is
  //    worse than doing nothing: it looks like it worked, then the next flush from any
  //    upgraded tab re-strips it and the data is gone again.
  if (!freeze.includes(SLICE)) {
    console.error(
      `\nREFUSING: "${SLICE}" is not in org_state.freeze_strip.\n` +
      `Without the freeze, the next flush() from any upgraded tab will immediately\n` +
      `re-strip this slice and silently discard the restore.\n\n` +
      `Set it first, e.g.:\n` +
      `  update public.org_state set freeze_strip = array['${SLICE}']\n` +
      `   where organization_id = '${ORG}';\n`,
    );
    process.exit(1);
  }

  // 3. Read every row from the source table (paginated — the table may be large).
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE)
      .select('data')
      .eq('organization_id', ORG)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const restored = rows.map((r) => r.data).filter(Boolean);
  const current = Array.isArray(row.state?.[SLICE]) ? row.state[SLICE].length : 0;
  log(`rows in public.${TABLE}: ${restored.length}`);
  log(`blob["${SLICE}"] now  : ${current}`);
  log(`blob["${SLICE}"] after: ${restored.length}   (delta ${restored.length - current >= 0 ? '+' : ''}${restored.length - current})`);

  if (!APPLY) { log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return; }

  // 4. Backup BEFORE writing (non-negotiable).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = new URL(`./orgstate-backup-${stamp}.json`, import.meta.url);
  writeFileSync(backup, JSON.stringify({ version: row.version, state: row.state }, null, 2), 'utf8');
  log(`\nBackup written: ${backup.pathname.split('/').pop()}`);

  // 5. CAS write — only if nobody saved in between.
  const next = { ...row.state, [SLICE]: restored };
  const { data: wrote, error: e2 } = await db
    .from('org_state')
    .update({ state: next, version: row.version + 1, updated_at: new Date().toISOString() })
    .eq('organization_id', ORG)
    .eq('version', row.version)
    .select('version');
  if (e2) throw e2;
  if (!wrote || wrote.length !== 1) {
    console.error(`\nCAS CONFLICT — org_state moved past v${row.version} while this ran. Nothing written. Re-run.\n`);
    process.exit(2);
  }
  log(`✓ Restored ${restored.length} row(s) into blob["${SLICE}"] — org_state v${row.version} → v${wrote[0].version}`);

  // 6. Verify by reading back.
  const { data: after } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
  const n = Array.isArray(after?.state?.[SLICE]) ? after.state[SLICE].length : 0;
  log(`✓ Verified: blob["${SLICE}"] = ${n} row(s) at v${after?.version}`);
  if (n !== restored.length) { console.error('MISMATCH — verify manually.'); process.exit(3); }
  log(`\nNext: keep freeze_strip set until the code that re-strips "${SLICE}" is reverted or fixed.\n`);
}

main().catch((e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
