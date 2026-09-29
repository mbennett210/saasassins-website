// Make the umbrella account ("Harnish Subaru/GMC/Chevy/VW") the ONE true
// Harnish account (Daniel, 2026-07-01 — supersedes the earlier keep-both call):
//   • The 4 original "Harnish - <Store> of Puyallup" accounts lose their
//     standing crew → crew stop seeing duplicate Harnish accounts (the umbrella
//     already carries all 8 at account level + per-store site crew).
//   • The 4 originals are set status 'inactive' → admins see them badged
//     Inactive in Contacts; all their data (notes, contacts, history) is KEPT
//     and the change is reversible from the account's status dropdown.
// The umbrella is untouched. Nothing is deleted.
//
// Idempotent, full backup before write, CAS-guarded.
//   node scripts/finalize-harnish.mjs --dry-run
//   node scripts/finalize-harnish.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* try next */ }
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1);
}

const ORG = '00000000-0000-0000-0000-000000000001';
const DRY = process.argv.includes('--dry-run');
const UMBRELLA_ID = 'cl_harnish_conjoined';
// The 4 originals, by id (created by the import; verified live this session).
const ORIGINAL_IDS = [
  'cl_imp_db0b5e82c25401', // Harnish - Chevrolet of Puyallup
  'cl_imp_cb49732435f5f7', // Harnish - GMC of Puyallup
  'cl_imp_63bd474fc84853', // Harnish - Subaru of Puyallup
  'cl_imp_5a5aa67732bddf', // Harnish - Volkswagen of Puyallup
];

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const umbrella = (state.clients || []).find((c) => c.id === UMBRELLA_ID);
if (!umbrella) { console.error('✗ Umbrella account not found — aborting.'); process.exit(1); }
const uname = (id) => (state.users || []).find((u) => u.id === id)?.name || id;

let changes = 0;
console.log(`\norg_state v${snap.version} — umbrella "${umbrella.name}" crew: ${(umbrella.standingCrewIds || []).map(uname).join(', ')}\n`);
const nextClients = (state.clients || []).map((c) => {
  if (!ORIGINAL_IDS.includes(c.id)) return c;
  const crew = (c.standingCrewIds || []);
  const needsCrew = crew.length > 0;
  const needsStatus = c.status !== 'inactive';
  if (!needsCrew && !needsStatus) { console.log(`  · "${c.name}" already finalized`); return c; }
  changes++;
  console.log(`  ✓ "${c.name}"  — remove crew [${crew.map(uname).join(', ') || '—'}] · status ${c.status} → inactive`);
  return { ...c, standingCrewIds: [], status: 'inactive' };
});
// Site-level crew on the originals' sites too (each original has 1 site).
const origSiteIds = new Set((state.sites || []).filter((s) => ORIGINAL_IDS.includes(s.clientId)).map((s) => s.id));
const nextSites = (state.sites || []).map((s) => {
  if (!origSiteIds.has(s.id) || !(s.standingCrewIds || []).length) return s;
  changes++;
  console.log(`  ✓ site "${s.name}" (original) — remove crew [${s.standingCrewIds.map(uname).join(', ')}]`);
  return { ...s, standingCrewIds: [] };
});

console.log(`\n${changes} record(s) to change. Umbrella untouched. Nothing deleted.`);
if (DRY) { console.log('--dry-run: nothing written.\n'); process.exit(0); }
if (!changes) { console.log('Nothing to change.\n'); process.exit(0); }

const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: { ...state, clients: nextClients, sites: nextSites }, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — re-run.'); process.exit(1); }
console.log(`\n✓ Umbrella is now the one true Harnish account. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
