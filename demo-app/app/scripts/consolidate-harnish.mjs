// One-time consolidation: fold the 4 individual Harnish dealership accounts
// into ONE new account with 4 sub-locations (sites), WITHOUT touching the
// originals. CleanSpace's client OK'd running the whole Harnish group as a single
// account with per-store sites.
//
// Why a script (not the UI): the CRM hub has no "create company" action (only
// Add-Contact, which forces a junk contact), and the Add-Site form can't set a
// per-site clean time or crew — both of which we need here. This does it
// cleanly and losslessly, copying each store's notes/codes verbatim from the
// live blob so nothing is re-typed.
//
// What it creates:
//   • Account "Harnish Subaru/GMC/Chevy/VW" (EXACT name → the 10 "SU 64" keys
//     attach by name, no key edits) — standing crew = the UNION of all 4
//     stores' crew; shared key-ring legend in its access instructions.
//   • 4 sites (Chevrolet / GMC / Subaru / VW of Puyallup), each carrying that
//     store's address (+ geocode), TRUE per-site clean time, that store's crew,
//     and its full access + cleaning notes (access instructions + ops notes).
//   • Site contacts left empty (no phone numbers available yet — the tap-to-call
//     UI is already wired for when they're added).
//
// What it does NOT do: it never edits or deletes the 4 original accounts, and
// never touches keys (they match the new account by name automatically).
//
// Idempotent (safe to re-run): skips the account if it already exists, and
// skips any site whose id is already present. CAS-guarded + full backup before
// any write, matching cleanup-account-names.mjs / backfill-key-sites.mjs.
//
//   node scripts/consolidate-harnish.mjs --dry-run   # report only, writes nothing
//   node scripts/consolidate-harnish.mjs             # apply (writes org_state)
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Load env (.env.local preferred; fall back to .env.local.bak like the others).
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

const NEW_ACCOUNT_ID = 'cl_harnish_conjoined';
const NEW_ACCOUNT_NAME = 'Harnish Subaru/GMC/Chevy/VW';
// Source account id → new sub-location (site) id + display name.
const SOURCES = [
  { srcId: 'cl_imp_db0b5e82c25401', siteId: 'st_harnish_chevy',  siteName: 'Chevrolet of Puyallup' },
  { srcId: 'cl_imp_cb49732435f5f7', siteId: 'st_harnish_gmc',    siteName: 'GMC of Puyallup' },
  { srcId: 'cl_imp_63bd474fc84853', siteId: 'st_harnish_subaru', siteName: 'Subaru of Puyallup' },
  { srcId: 'cl_imp_5a5aa67732bddf', siteId: 'st_harnish_vw',     siteName: 'Volkswagen of Puyallup' },
];

const hhmm = (m) => { if (typeof m !== 'number') return '—'; const h = Math.floor(m / 60), mm = m % 60; return h ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`; };

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }

const state = snap.state;
const clients = state.clients || [];
const sites = state.sites || [];
const users = state.users || [];
const uname = (id) => { const u = users.find((x) => x.id === id); return u ? (u.name || u.email || id) : id; };

// Resolve each source account + its (single) site.
const resolved = SOURCES.map((src) => {
  const client = clients.find((c) => c.id === src.srcId) || null;
  const site = client ? (sites.find((s) => s.clientId === client.id) || null) : null;
  return { ...src, client, site };
});
const missing = resolved.filter((r) => !r.client);
if (missing.length) {
  console.warn(`⚠ Source account(s) not found (skipped): ${missing.map((m) => m.srcId).join(', ')}`);
}
const present = resolved.filter((r) => r.client);
if (!present.length) { console.error('None of the 4 source Harnish accounts were found. Nothing to do.'); process.exit(1); }

// Union of every source account's standing crew → the conjoined account.
const crewUnion = [...new Set(present.flatMap((r) => r.client.standingCrewIds || []))];

// Idempotency: is the conjoined account already there (by fixed id or exact name)?
const existingAcct = clients.find((c) => c.id === NEW_ACCOUNT_ID || norm(c.name) === norm(NEW_ACCOUNT_NAME)) || null;
const acctId = existingAcct ? existingAcct.id : NEW_ACCOUNT_ID;

// Build the 4 new sites (skip any that already exist).
const newSites = [];
for (const r of present) {
  if (sites.some((s) => s.id === r.siteId)) continue;              // already created — idempotent
  const acc = r.client;
  const base = r.site || {};
  const accessNotes = [acc.security?.accessInstructions, acc.opsNotes].filter(Boolean).join(DIV);
  newSites.push({
    id: r.siteId,
    clientId: acctId,
    name: r.siteName,
    // Carry the store's address + geocode straight from its existing site.
    street: base.street || '', city: base.city || '', state: base.state || '', zip: base.zip || '',
    address: base.address || '',
    lat: base.lat ?? null, lng: base.lng ?? null, geocodedAddress: base.geocodedAddress || null,
    geofenceRadiusM: base.geofenceRadiusM ?? null, geofenceEnabled: base.geofenceEnabled !== false,
    // Per-site clean time (the UI can't set this) + per-store crew.
    expectedCleanMins: typeof acc.expectedCleanMins === 'number' ? acc.expectedCleanMins : null,
    standingCrewIds: (acc.standingCrewIds || []).slice(),
    // Full store instructions, verbatim; contact left empty (no numbers yet).
    accessNotes,
    cleaningAreas: [],
    siteContactId: null,
    attachments: [],
    createdAt: nowIso,
  });
}

// Build the conjoined account (only if it doesn't already exist).
let nextClients = clients;
if (!existingAcct) {
  const legend = present.find((r) => r.client.security?.accessInstructions)?.client.security.accessInstructions || null;
  const newAcct = {
    id: NEW_ACCOUNT_ID,
    name: NEW_ACCOUNT_NAME,
    status: 'active',
    revenue: 0,
    notes: '',
    tagIds: [],
    createdAt: nowIso,
    lastServiceAt: null,
    primaryContactId: null,
    standingCrewIds: crewUnion,
    expectedCleanMins: null,                                        // per-site now (see each location)
    opsNotes: 'Consolidated Harnish auto group — four service locations below (Chevrolet, GMC, Subaru & VW of Puyallup). The shared "SU 64" key ring opens all four; each site holds its own cleaning plan, schedule, and door codes.',
    security: { keyNumber: 'SU 64', accessInstructions: legend, accessLink: null },
    opsUpdatedAt: nowIso,
  };
  nextClients = [...clients, newAcct];
}
const nextSites = [...sites, ...newSites];

// Keys that will light up on the new account purely by name-match.
const matchingKeys = (state.keys || []).filter((k) => norm(k.clientName) === norm(NEW_ACCOUNT_NAME)).length;

// ---- Report ----
console.log(`\norg_state version ${snap.version}\n`);
console.log(existingAcct
  ? `Account "${NEW_ACCOUNT_NAME}" already exists (${acctId}) — will NOT recreate.`
  : `WILL CREATE account "${NEW_ACCOUNT_NAME}" (${NEW_ACCOUNT_ID})`);
if (!existingAcct) {
  console.log(`  standing crew (union of ${present.length} stores, ${crewUnion.length}): ${crewUnion.map(uname).join(', ')}`);
}
console.log(`  keys matching by name (auto-attach): ${matchingKeys}`);
console.log(`\nWILL CREATE ${newSites.length} site(s):`);
for (const s of newSites) {
  console.log(`  • ${s.name}  —  ${s.address || '(no address)'}`);
  console.log(`      clean time: ${hhmm(s.expectedCleanMins)} · crew: ${(s.standingCrewIds).map(uname).join(', ') || '—'} · notes: ${s.accessNotes.length} chars`);
}
const skippedSites = present.length - newSites.length;
if (skippedSites > 0) console.log(`\n(${skippedSites} site(s) already existed — skipped.)`);
console.log(`\nOriginals left untouched: ${present.map((r) => r.client.name).join(' · ')}`);

if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }
if (existingAcct && newSites.length === 0) { console.log('\nNothing to change (already consolidated).\n'); process.exit(0); }

// Safety: full backup of current state before writing.
const stamp = nowIso.replace(/[:.]/g, '-');
const backupPath = new URL(`./orgstate-backup-${stamp}.json`, import.meta.url);
writeFileSync(backupPath, JSON.stringify({ version: snap.version, state }));

const nextState = { ...state, clients: nextClients, sites: nextSites };
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me (someone saved in the app). Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Consolidated Harnish: +1 account, +${newSites.length} sites. org_state version ${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup of prior state: app/scripts/orgstate-backup-${stamp}.json\n`);
