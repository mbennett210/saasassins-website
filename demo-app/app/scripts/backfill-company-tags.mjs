// One-time backfill of contact tags → their company (account) in the shared
// org_state. Tags are now COMPANY-level: a person's "effective tags" are their
// company's (see selectEffectiveTagIdsForContact). Existing data carries tags on
// contact.tagIds; this unions each company-attached contact's tags onto its
// client.tagIds so nothing appears to vanish when the UI switches to company
// tags. contact.tagIds are LEFT IN PLACE (harmless legacy; still the fallback
// store for company-less contacts). Idempotent: a tag already on the company is
// skipped, so re-running is a no-op.
//
//   node scripts/backfill-company-tags.mjs --dry-run   # report only, write nothing
//   node scripts/backfill-company-tags.mjs             # write to org_state
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const ORG = '00000000-0000-0000-0000-000000000001';
const DRY = process.argv.includes('--dry-run');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }
const state = snap.state;

const contacts = state.contacts || [];
const clients = state.clients || [];
const clientById = new Map(clients.map((c) => [c.id, c]));

// Union each company-attached contact's tags, keyed by clientId. Company-less
// contacts are skipped — they keep their own tagIds as the fallback store.
const tagsByClient = new Map();
for (const c of contacts) {
  if (!c.companyId || !clientById.has(c.companyId)) continue;
  const set = tagsByClient.get(c.companyId) || new Set();
  (c.tagIds || []).forEach((t) => set.add(t));
  tagsByClient.set(c.companyId, set);
}

let companiesChanged = 0, tagsAdded = 0, alreadyComplete = 0;

const nextClients = clients.map((cl) => {
  const incoming = tagsByClient.get(cl.id);
  if (!incoming || incoming.size === 0) return cl;
  const current = new Set(cl.tagIds || []);
  const missing = [...incoming].filter((t) => !current.has(t));
  if (missing.length === 0) { alreadyComplete++; return cl; } // idempotent — nothing new
  companiesChanged++; tagsAdded += missing.length;
  return { ...cl, tagIds: [...current, ...missing] };
});

console.log(`Clients: ${clients.length} total · ${tagsByClient.size} have tagged contacts.`);
console.log(`→ ${companiesChanged} companies gain ${tagsAdded} tags from their contacts.`);
console.log(`→ ${alreadyComplete} companies already carried all their contacts' tags (skipped).`);

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
if (companiesChanged === 0) { console.log('\nNothing to change.'); process.exit(0); }

const nowIso = new Date().toISOString();
const nextState = { ...state, clients: nextClients };
const { error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version);
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
console.log(`\n✓ Backfilled ${tagsAdded} tags onto ${companiesChanged} companies (version ${snap.version} → ${snap.version + 1}).`);
