// One-time, idempotent backfill: copy any legacy blob `complaints` into relational
// Work Orders (problem_reports, type:complaint). Increment 3 folded the standalone
// Complaints log into the Quality hub's Work Orders queue and retired the blob
// `complaints` slice. The DEMO seed carried no complaints and the connected backend
// seed never seeded any, so on the live org this is expected to find ZERO rows — but
// the owner asked for a defensive migration so a complaint typed into the live app is
// preserved rather than left inert in the blob.
//
// SAFE BY DESIGN:
//   • INSERT-ONLY. It never mutates org_state. The copied complaints keep sitting in
//     the blob (inert — no reader after Inc 3), so there is no lost-update race with a
//     live tab; the authoritative copy now also lives in problem_reports where the
//     Work Orders queue + Dashboard read it.
//   • DRY RUN unless --commit. Prints exactly what it would insert.
//   • IDEMPOTENT. Dedupes against existing type:complaint rows by the natural key
//     (created_at + client_id + title), so re-running never duplicates.
//
//   node scripts/backfill-complaints-to-workorders.mjs            # DRY RUN
//   node scripts/backfill-complaints-to-workorders.mjs --commit   # writes problem_reports
//
// Creds from app/.env.local: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLEANSPACE_ORG_ID.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { complaintToWorkOrderRow } from '../src/lib/workOrders.js';

const COMMIT = process.argv.includes('--commit');
const MODE = COMMIT ? 'COMMIT (writing problem_reports)' : 'DRY RUN (no writes)';

// ── env (same source as seed-backend.mjs) ───────────────────────────────────────
const env = {};
try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  console.error('✖ Could not read app/.env.local — this script targets the CONNECTED backend.');
  process.exit(1);
}
const SUPABASE_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ORG = env.CLEANSPACE_ORG_ID || env.FORMS_ORG_ID;
if (!SUPABASE_URL || !KEY) { console.error('✖ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in app/.env.local'); process.exit(1); }
if (!ORG) { console.error('✖ Missing CLEANSPACE_ORG_ID in app/.env.local'); process.exit(1); }
const sb = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

// Natural key for idempotency — a complaint's created_at is effectively unique per
// account, and title is derived deterministically from its detail (workOrders.js).
const keyOf = (r) => `${r.created_at || ''}|${r.client_id || ''}|${r.title || ''}`;

async function main() {
  console.log(`\nbackfill-complaints-to-workorders — ${MODE}\n  org: ${ORG}`);

  // 1. Read the blob and pull the (retired) complaints slice.
  const { data: row, error: readErr } = await sb
    .from('org_state').select('state').eq('organization_id', ORG).single();
  if (readErr) { console.error(`✖ org_state read failed: ${readErr.message}`); process.exit(1); }
  const complaints = Array.isArray(row?.state?.complaints) ? row.state.complaints : [];
  console.log(`  blob complaints found: ${complaints.length}`);
  if (complaints.length === 0) {
    console.log('  nothing to backfill — done.\n');
    return;
  }

  // 2. Map each to a problem_reports payload (pure, shared with the unit test).
  const rows = complaints.map((c) => complaintToWorkOrderRow(c, { orgId: ORG }));

  // 3. Dedupe against existing type:complaint rows (idempotent re-runs).
  const { data: existing, error: exErr } = await sb
    .from('problem_reports')
    .select('created_at, client_id, title')
    .eq('organization_id', ORG)
    .eq('type', 'complaint');
  if (exErr) { console.error(`✖ problem_reports read failed: ${exErr.message}`); process.exit(1); }
  const seen = new Set((existing || []).map(keyOf));
  const toInsert = rows.filter((r) => !seen.has(keyOf(r)));
  const skipped = rows.length - toInsert.length;

  console.log(`  already present (skipped): ${skipped}`);
  console.log(`  to insert: ${toInsert.length}`);
  for (const r of toInsert) {
    console.log(`    · ${r.status.padEnd(12)} ${r.created_at?.slice(0, 10) || '????-??-??'}  ${(r.client_name || 'unattached').slice(0, 28).padEnd(28)}  ${r.title}`);
  }

  if (!COMMIT) {
    console.log('\n  DRY RUN — pass --commit to write these rows.\n');
    return;
  }
  if (toInsert.length === 0) { console.log('\n  nothing new to write — done.\n'); return; }

  // 4. Insert. problem_reports.id defaults server-side; we set the mapped fields.
  const { data: inserted, error: insErr } = await sb.from('problem_reports').insert(toInsert).select('id');
  if (insErr) { console.error(`✖ insert failed: ${insErr.message}`); process.exit(1); }
  console.log(`\n  ✓ inserted ${inserted?.length ?? 0} Work Order(s) of type:complaint.`);
  console.log('  (The blob copy is left inert — no reader after Inc 3. Nothing else to do.)\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
