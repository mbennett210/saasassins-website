// One-time backfill of keys → sites in the shared org_state. The original key
// sheet import (import-keys.mjs) filed every key under a company name only, with
// no siteId. This resolves each key's company to a CRM client and, when that
// client has EXACTLY ONE site, files the key under that site (and backfills the
// clientId link when the import left it null). Keys whose company has zero or
// multiple sites are left as "Unassigned site" for manual triage in-app.
// Idempotent: keys that already carry a siteId are skipped.
//
//   node scripts/backfill-key-sites.mjs --dry-run   # report only, write nothing
//   node scripts/backfill-key-sites.mjs             # write to org_state
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const ORG = '00000000-0000-0000-0000-000000000001';
const DRY = process.argv.includes('--dry-run');
const norm = (s) => (s || '').trim().toLowerCase();

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }
const state = snap.state;

const clients = state.clients || [];
const sites = state.sites || [];
const clientById = new Map(clients.map((c) => [c.id, c]));
const clientByName = new Map(clients.map((c) => [norm(c.name), c]));
const sitesByClient = new Map();
for (const s of sites) {
  if (!s.clientId) continue;
  if (!sitesByClient.has(s.clientId)) sitesByClient.set(s.clientId, []);
  sitesByClient.get(s.clientId).push(s);
}

let assigned = 0, linkedOnly = 0, alreadySited = 0, unchanged = 0;
const multiSite = [], noClient = [], noSites = [];

const nextKeys = (state.keys || []).map((k) => {
  if (k.siteId) { alreadySited++; return k; }            // idempotent — leave sited keys alone

  // Resolve the company → clientId (the import left clientId null for most rows).
  const clientId = k.clientId || clientByName.get(norm(k.clientName))?.id || null;
  if (!clientId) { noClient.push(k.clientName || '(no name)'); unchanged++; return k; }

  const clientSites = sitesByClient.get(clientId) || [];
  const needsLink = !k.clientId;                          // import left the company link null

  if (clientSites.length === 1) {                         // single-site account → auto-file
    const site = clientSites[0];
    assigned++;
    return { ...k, clientId, siteId: site.id, siteName: site.name };
  }

  // 0 or 2+ sites — can't auto-pick a building. Still backfill the company link.
  if (clientSites.length === 0) noSites.push(clientById.get(clientId)?.name || k.clientName);
  else multiSite.push(`${clientById.get(clientId)?.name || k.clientName} · ${k.label} (${clientSites.length} sites)`);
  if (needsLink) { linkedOnly++; return { ...k, clientId }; }
  unchanged++; return k;
});

const changed = assigned + linkedOnly;
console.log(`Keys: ${(state.keys || []).length} total · ${alreadySited} already sited (skipped).`);
console.log(`→ ${assigned} auto-filed under a single-site account.`);
console.log(`→ ${linkedOnly} company links backfilled without a site (multi/zero-site).`);
if (multiSite.length) {
  console.log(`\n⚠ ${multiSite.length} keys at MULTI-site accounts — left Unassigned, pick the building in-app:`);
  multiSite.slice(0, 40).forEach((m) => console.log('   ' + m));
}
if (noSites.length) console.log(`\nℹ ${noSites.length} keys at accounts with no sites yet (add a site, then re-run).`);
if (noClient.length) console.log(`\nℹ ${noClient.length} keys whose company didn't match a CRM client (left as-is).`);

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
if (changed === 0) { console.log('\nNothing to change.'); process.exit(0); }

const nowIso = new Date().toISOString();
const nextState = { ...state, keys: nextKeys };
const { error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version);
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
console.log(`\n✓ Backfilled ${changed} keys (version ${snap.version} → ${snap.version + 1}).`);
