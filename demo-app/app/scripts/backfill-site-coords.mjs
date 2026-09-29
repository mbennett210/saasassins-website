// Backfill site coordinates on the LIVE org_state blob.
//
// WHY: `site.lat`/`lng` is only written when a site is SAVED through the app, so the
// 116 sites that predate the geofence build never got coordinates. Without them the
// clock-in geofence is inert (`no_site_coords` → pass-through allow) and every
// drive-time leg between those sites reports "No estimate" — the Routes API has
// nothing to route between. This is the one-time catch-up.
//
// SOURCE: every pair in site-coords-2026-07-29.json came from the DEPLOYED /api/geo
// route (Google Geocoding — the same path a manual site save uses), run 2026-07-29
// against each site's stored address. All 116 resolved with zero failures, and every
// result was bounds-checked to Washington State (lat 46.95–47.82, lng −122.93…−121.98)
// before being recorded here.
//
// ⚠️ SIDE EFFECT — READ THIS. A site WITH coordinates has its clock-in geofence ARMED
// (`site.geofenceEnabled` defaults ON), so crew must be within the org radius (250 ft)
// to clock in there. That is the intended design (CLEANSPACE_SWEPT §2.5) and it is inert
// today because nobody is clocking in yet — but it goes live the moment they start.
// Set `geofenceEnabled: false` on a specific site if that site needs the fence off.
//
//   node scripts/backfill-site-coords.mjs           # dry run — prints the plan, writes nothing
//   node scripts/backfill-site-coords.mjs --apply   # backup, then ONE CAS-guarded write
//
// Idempotent: a site that already has finite lat/lng is skipped, so a re-run is a
// no-op. Additive + default-safe — no seed version / STORAGE_KEY bump.
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Load env (.env.local preferred; fall back like the other scripts).
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
const APPLY = process.argv.includes('--apply');
const COORDS = JSON.parse(readFileSync(new URL('./site-coords-2026-07-29.json', import.meta.url), 'utf8'));

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error || !snap) { console.error('Could not read org_state:', error?.message); process.exit(1); }

const state = snap.state;
const sites = Array.isArray(state.sites) ? state.sites : [];
const fin = (n) => Number.isFinite(n);

const plan = [];
const already = [];
const noData = [];
for (const s of sites) {
  if (fin(s.lat) && fin(s.lng)) { already.push(s.name || s.id); continue; }
  const c = COORDS[s.id];
  if (!c) { noData.push(s.name || s.id); continue; }
  plan.push({ id: s.id, name: s.name, address: s.address, lat: c.lat, lng: c.lng });
}

console.log(`org_state version ${snap.version} — ${sites.length} sites total`);
console.log(`  will set coordinates on : ${plan.length}`);
console.log(`  already had coordinates : ${already.length}`);
console.log(`  no coordinate available : ${noData.length}${noData.length ? ` (${noData.slice(0, 5).join(', ')}${noData.length > 5 ? ', …' : ''})` : ''}`);
for (const p of plan.slice(0, 5)) console.log(`    ${p.name} — ${p.address}  ->  ${p.lat}, ${p.lng}`);
if (plan.length > 5) console.log(`    … and ${plan.length - 5} more`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
  process.exit(0);
}
if (!plan.length) { console.log('\nNothing to do (already backfilled).'); process.exit(0); }

// Backup BEFORE any mutation (the non-negotiable step).
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupName = `orgstate-backup-${stamp}.json`;
writeFileSync(new URL(`./${backupName}`, import.meta.url), JSON.stringify({ version: snap.version, state }));
console.log(`\nBackup written: scripts/${backupName}`);

const byId = new Map(plan.map((p) => [p.id, p]));
const nextState = {
  ...state,
  sites: sites.map((s) => (byId.has(s.id) ? { ...s, lat: byId.get(s.id).lat, lng: byId.get(s.id).lng } : s)),
};

// CAS: only write if nobody else has bumped the version since we read it.
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: new Date().toISOString() })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote?.length) { console.error('CAS conflict — another write landed first. Re-run the dry run, then --apply.'); process.exit(1); }

console.log(`\n✓ Backfilled ${plan.length} site(s). org_state version ${snap.version} → ${wrote[0].version}.`);
