// Finish the last 5 orphan key groups (Daniel's calls, 2026-07-01):
//   • Link to an existing account (stamp clientId + align clientName):
//       - "Fairway Mortgage - Puyallup"     → "Fairway Mortgage"
//       - "Touchpoint Counseling - Puyallup" → "TouchPoint Counseling"
//       - "MOUNT CLEANSPACE CHRISTIAN"          → "Mount CleanSpace C.C."
//   • Create a fresh account:
//       - "Red Dot"  (+ attach its 6 "RED DOT" keys)
//   • Consolidate like Harnish (umbrella account + one sub-site per store,
//     originals kept):
//       - "Dania"  ← the "Dania - KIRKLAND/LYNNWOOD/TACOMA" accounts;
//         "Dania Warehouse" keys attach to the umbrella by clientId.
//
// One atomic write. Read live org_state, --dry-run + full backup + CAS guard.
// Idempotent: existing accounts/sites are reused, already-linked keys skipped.
//
//   node scripts/finish-orphan-keys.mjs --dry-run
//   node scripts/finish-orphan-keys.mjs
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
const DIV = '\n\n----------------------------------------\n\n';
const titleCase = (s) => (s || '').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const hhmm = (m) => (typeof m === 'number' ? (Math.floor(m / 60) ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`) : '—');

// (orphan key label) → (exact existing account name)
const LINKS = [
  ['Fairway Mortgage - Puyallup',      'Fairway Mortgage'],
  ['Touchpoint Counseling - Puyallup', 'TouchPoint Counseling'],
  ['MOUNT CLEANSPACE CHRISTIAN',          'Mount CleanSpace C.C.'],
];
// create a plain account, then attach a key group by clientId
const CREATE = [
  { id: 'cl_reddot', name: 'Red Dot', keyLabel: 'RED DOT' },
];
// Harnish-style consolidation: umbrella account + one sub-site per source store
const CONSOLIDATE = [
  {
    id: 'cl_dania_group', name: 'Dania', keyLabel: 'Dania Warehouse',
    sourceMatch: (c) => /^dania\s*-/i.test(c.name || ''),
    location: (c) => (c.name || '').replace(/^dania\s*-\s*/i, ''),
  },
];

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const clients = state.clients || [];
const sites = state.sites || [];
const keys = state.keys || [];
const users = state.users || [];
const byId = new Map(clients.map((c) => [c.id, c]));
const byName = new Map(clients.map((c) => [norm(c.name), c]));
const uname = (id) => { const u = users.find((x) => x.id === id); return u ? (u.name || u.email || id) : id; };
const siteExists = (id) => sites.some((s) => s.id === id);

const newClients = [];
const newSites = [];
const keyChanges = new Map();  // keyId → { clientId, clientName }
const relink = (label, clientId, clientName) => {
  const hits = keys.filter((k) => norm(k.clientName) === norm(label) && !(k.clientId === clientId && k.clientName === clientName));
  hits.forEach((k) => keyChanges.set(k.id, { clientId, clientName }));
  return hits.length;
};
const mkAccount = (id, name, extra = {}) => ({
  id, name, status: 'active', revenue: 0, notes: '', tagIds: [],
  createdAt: nowIso, lastServiceAt: null, primaryContactId: null, ...extra,
});

const log = [];

// 1) LINK to existing accounts
for (const [label, acctName] of LINKS) {
  const acct = byName.get(norm(acctName));
  if (!acct) { console.warn(`⚠ SKIP link "${label}" — account "${acctName}" not found.`); continue; }
  log.push(`LINK  ${String(relink(label, acct.id, acct.name)).padStart(2)} keys  "${label}" → ${acct.name}`);
}

// 2) CREATE plain accounts
for (const c of CREATE) {
  const existing = byId.get(c.id) || byName.get(norm(c.name)) || null;
  const acctId = existing ? existing.id : c.id;
  const acctName = existing ? existing.name : c.name;
  if (!existing) newClients.push(mkAccount(c.id, c.name, { standingCrewIds: [], expectedCleanMins: null, opsNotes: '' }));
  const n = relink(c.keyLabel, acctId, acctName);
  log.push(`${existing ? 'REUSE' : 'CREATE'} account "${acctName}"  +  ${n} keys ("${c.keyLabel}")`);
}

// 3) CONSOLIDATE (umbrella + sub-sites)
for (const g of CONSOLIDATE) {
  const sources = clients.filter(g.sourceMatch);
  if (!sources.length) { console.warn(`⚠ SKIP consolidate "${g.name}" — no source accounts matched.`); continue; }
  const existing = byId.get(g.id) || byName.get(norm(g.name)) || null;
  const acctId = existing ? existing.id : g.id;
  const acctName = existing ? existing.name : g.name;
  const crewUnion = [...new Set(sources.flatMap((s) => s.standingCrewIds || []))];
  if (!existing) {
    const legend = sources.find((s) => s.security?.accessInstructions)?.security.accessInstructions || null;
    newClients.push(mkAccount(g.id, g.name, {
      standingCrewIds: crewUnion, expectedCleanMins: null,
      opsNotes: `Consolidated ${g.name} — locations below. See each site for its cleaning plan, schedule, and access notes.`,
      security: { keyNumber: null, accessInstructions: legend, accessLink: null }, opsUpdatedAt: nowIso,
    }));
  }
  log.push(`${existing ? 'REUSE' : 'CREATE'} account "${acctName}"  (crew union: ${crewUnion.map(uname).join(', ') || '—'})`);
  for (const src of sources) {
    const loc = titleCase(g.location(src));
    const siteId = `st_${slug(g.name)}_${slug(loc)}`;
    if (siteExists(siteId)) { log.push(`  · site "${loc}" already exists — skipped`); continue; }
    const base = sites.find((s) => s.clientId === src.id) || {};
    const accessNotes = [src.security?.accessInstructions, src.opsNotes].filter(Boolean).join(DIV);
    newSites.push({
      id: siteId, clientId: acctId, name: loc,
      street: base.street || '', city: base.city || '', state: base.state || '', zip: base.zip || '',
      address: base.address || '',
      lat: base.lat ?? null, lng: base.lng ?? null, geocodedAddress: base.geocodedAddress || null,
      geofenceRadiusM: base.geofenceRadiusM ?? null, geofenceEnabled: base.geofenceEnabled !== false,
      expectedCleanMins: typeof src.expectedCleanMins === 'number' ? src.expectedCleanMins : null,
      standingCrewIds: (src.standingCrewIds || []).slice(),
      accessNotes, cleaningAreas: [], siteContactId: null, attachments: [], createdAt: nowIso,
    });
    log.push(`  + site "${loc}"  —  ${base.address || '(no address)'}  ·  clean ${hhmm(src.expectedCleanMins)}  ·  crew ${(src.standingCrewIds || []).map(uname).join(', ') || '—'}`);
  }
  const n = relink(g.keyLabel, acctId, acctName);
  log.push(`  attach ${n} keys ("${g.keyLabel}") → ${acctName}`);
  log.push(`  originals kept: ${sources.map((s) => s.name).join(' · ')}`);
}

console.log(`\norg_state v${snap.version}\n`);
log.forEach((l) => console.log(l));
console.log(`\nTotals: +${newClients.length} account(s), +${newSites.length} site(s), ${keyChanges.size} key(s) relinked.`);

if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }
if (!newClients.length && !newSites.length && !keyChanges.size) { console.log('\nNothing to change.\n'); process.exit(0); }

const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const nextState = {
  ...state,
  clients: [...clients, ...newClients],
  sites: [...sites, ...newSites],
  keys: keys.map((k) => (keyChanges.has(k.id) ? { ...k, ...keyChanges.get(k.id) } : k)),
};
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Finished orphans: +${newClients.length} accounts, +${newSites.length} sites, ${keyChanges.size} keys relinked. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
