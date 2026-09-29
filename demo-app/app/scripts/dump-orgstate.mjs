// Read-only snapshot of the live shared org_state → a local JSON file.
// Writes NOTHING to Supabase. Used to hand the current data to a migration
// author (e.g. the Harnish consolidation) so the transform is built against
// real records, not a stale backup.
//
//   node scripts/dump-orgstate.mjs            # → scripts/orgstate-current.json
//
// The output contains real contact PII — do NOT commit it. (It's a working
// snapshot, same class as the orgstate-backup-*.json files.)
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Load env (.env.local preferred; fall back to .env.local.bak like the other scripts).
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
const norm = (s) => (s || '').trim().toLowerCase();

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }

const state = snap.state;
const outPath = new URL('./orgstate-current.json', import.meta.url);
writeFileSync(outPath, JSON.stringify({ version: snap.version, state }, null, 2));

const clients = state.clients || [];
const contacts = state.contacts || [];
const sites = state.sites || [];
const keys = state.keys || [];

console.log(`org_state version ${snap.version} — dumped to app/scripts/orgstate-current.json`);
console.log(`  accounts: ${clients.length} · contacts: ${contacts.length} · sites: ${sites.length} · keys: ${keys.length}`);

// Surface the Harnish accounts right away, with the linked-record counts that
// the consolidation will need to carry over.
const harnish = clients.filter((c) => /harnish/i.test(c.name || ''));
console.log(`\n${harnish.length} account(s) matching "Harnish":`);
for (const c of harnish) {
  const sc = sites.filter((s) => s.clientId === c.id).length;
  const ct = contacts.filter((x) => x.companyId === c.id).length;
  const jb = (state.jobs || []).filter((j) => j.clientId === c.id).length;
  const iv = (state.invoices || []).filter((i) => i.clientId === c.id).length;
  console.log(`  • "${c.name}"  [${c.id}]`);
  console.log(`      contacts:${ct} sites:${sc} jobs:${jb} invoices:${iv}` +
    ` · standingCrew:${(c.standingCrewIds || []).length}` +
    ` · expectedCleanMins:${c.expectedCleanMins ?? '—'}` +
    ` · primaryContact:${c.primaryContactId || '—'}`);
}

// Any key groups whose label doesn't match a CRM account name (the divergent set).
const nameSet = new Set(clients.map((c) => norm(c.name)));
const groups = {};
for (const k of keys) { const n = k.clientName || '(blank)'; groups[n] = (groups[n] || 0) + 1; }
const orphanGroups = Object.keys(groups).filter((n) => !nameSet.has(norm(n))).sort();
console.log(`\n${orphanGroups.length} key group(s) with NO matching account name (invisible to assigned crew):`);
for (const n of orphanGroups) console.log(`  • ${String(groups[n]).padStart(3)}  ${n}`);
