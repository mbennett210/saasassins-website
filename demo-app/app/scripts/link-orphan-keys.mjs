// One-time fix: link orphaned key groups to the real CRM account they belong to.
// The key-sheet import filed keys under free-text company names that don't
// exactly match the account name (typos, punctuation, abbreviations), so the
// name-match silently failed and the keys were invisible to the account + crew
// (see audit-key-mapping.mjs). This stamps the correct clientId AND rewrites the
// key's clientName to the account's real name, so the keys map by id (authoritative)
// and group correctly on the Keys page.
//
// ONLY the high-confidence 1:1 matches are in CROSSWALK below. The ambiguous
// cases (Dania location, Fairway/Touchpoint Puyallup, Mount CleanSpace, Red Dot)
// are intentionally left out pending confirmation.
//
// Safety: for each entry the target account MUST exist (exact name, normalized)
// or that entry is skipped with a warning — never guesses. Idempotent (once a
// key's clientName is the account name it no longer matches the orphan label),
// full backup before write, CAS-guarded.
//
//   node scripts/link-orphan-keys.mjs --dry-run   # report only, writes nothing
//   node scripts/link-orphan-keys.mjs             # apply (writes org_state)
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
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (looked in app/.env.local).');
  process.exit(1);
}

const ORG = '00000000-0000-0000-0000-000000000001';
const DRY = process.argv.includes('--dry-run');
const norm = (s) => (s || '').trim().toLowerCase();
const nowIso = new Date().toISOString();

// keyLabel (orphan clientName, as on the keys) → account name (exact, as in CRM).
const CROSSWALK = [
  ['Bennet Motor Express',                 'Bennett Motors Express'],
  ['FREDRICKSON POWER',                    'Frederickson Power'],
  ['COMMENCEMENT BANK - Eunumclaw',        'Commencement Bank - Enumclaw'],
  ['Knapps Restaurant',                    "Knapp's Restaurant"],
  ['Harbor Pacific - Valley Ave',          'Harbor Pacific - Valley Ave.'],
  ['Fairway Mortgage - Maple Valley',      'Fairway Mortgage- Maple Valley'],
  ['Redhawk Fire Protection',              'Red Hawk Fire Protection'],
  ['Tri - West',                           'Tri-West'],
  ['Advanced Ortho - Kent',                'Advanced Orthodontics - Kent'],
  ['Advanced Ortho - Mercer',              'Advanced Ortho Mercer Island'],
  ['Advanced Ortho - Burien',              'Advanced Ortho - NEW Burien'],
  ['AMERICAN LEGION DEPARTMENT OF WA',     'American Legion Dept. of WA'],
  ['ANGLE LAKE',                           'Angle Lake Child Dev. Center'],
  ['CITIZEN ACCESS RESIDENTIAL RESOURCES', 'Citizen Access R.R.'],
  ['Daniel Ross',                          'Daniel Ross Salon'],
  ['NW Dental - Puyallup',                 'NW Dental Medicine - Puyallup'],
  ['OCEAN BEAUTY SEAFOOD',                 'Ocean Beauty'],
  ['Overcomer Church',                     'Overcomer Covenant Church'],
  ['Precision Dental',                     'Precision Dental Arts'],
  ['New Tacoma Cemeteries',                'New Tacoma'],
  ['Community Youth Services',             'Community Youth Services 914 7th'],
];

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const clients = state.clients || [];
const keys = state.keys || [];
const clientByName = new Map(clients.map((c) => [norm(c.name), c]));

// Resolve each crosswalk row to a real account, then relabel its keys.
const changes = new Map();          // keyId → { clientId, clientName }
const report = [];
let notFound = 0;
for (const [label, acctName] of CROSSWALK) {
  const acct = clientByName.get(norm(acctName));
  if (!acct) { console.warn(`⚠ SKIP "${label}" — target account "${acctName}" not found.`); notFound++; continue; }
  const hits = keys.filter((k) => norm(k.clientName) === norm(label) && !(k.clientId === acct.id && k.clientName === acct.name));
  for (const k of hits) changes.set(k.id, { clientId: acct.id, clientName: acct.name });
  report.push({ label, acctName: acct.name, acctId: acct.id, n: hits.length });
}

console.log(`\norg_state v${snap.version} — ${CROSSWALK.length} mappings, ${notFound} target account(s) missing.\n`);
for (const r of report) console.log(`  ${String(r.n).padStart(3)}  "${r.label}"  →  ${r.acctName}  (${r.acctId})`);
console.log(`\nKeys to relink: ${changes.size}.`);

if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }
if (changes.size === 0) { console.log('\nNothing to change (already linked).\n'); process.exit(0); }

const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const nextKeys = keys.map((k) => (changes.has(k.id) ? { ...k, ...changes.get(k.id) } : k));
const nextState = { ...state, keys: nextKeys };
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Linked ${changes.size} keys across ${report.filter((r) => r.n).length} accounts. org_state version ${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
