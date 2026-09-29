// Arm (or disarm) the Increment 0.3 fleet-reload gate — `org_state.min_client_build`.
//
//   node scripts/arm-fleet-gate.mjs                      # inspect only (default)
//   node scripts/arm-fleet-gate.mjs --build <id>         # dry run of a specific floor
//   node scripts/arm-fleet-gate.mjs --build <id> --apply # write it
//   node scripts/arm-fleet-gate.mjs --disarm --apply     # back to NULL (always safe)
//
// ══ WHAT THIS DOES, AND WHY IT IS THE DANGEROUS ONE ══════════════════════════
//
// `min_client_build` is the floor below which a tab must reload before it may write.
// sync.js:158 `isBuildTooOld()` is `APP_BUILD > 0 && minClientBuild > 0 && APP_BUILD
// < minClientBuild`, so the gate is INERT until this is set — it is NULL live today,
// which is why no prune has ever been safe: a prune with old tabs still writing lets
// them re-bloat the blob from stale in-memory state.
//
// The failure mode is not subtle. `APP_BUILD` is `String(Date.now())` baked in at
// build time (vite.config.js), so it is a millisecond timestamp of WHEN THE BUNDLE
// WAS BUILT. Set the floor above the newest deployed build and EVERY tab is below it:
// every user is told to reload, reloads into the same bundle, is still below the
// floor, and can never write again. There is no client-side recovery — the fix has to
// come from the database.
//
// So this script refuses to set a floor above the highest build id it can OBSERVE
// having written. That is the only evidence available that a build actually exists and
// is deployed; a build id nobody has written under may be a typo, a preview
// deployment, or a bundle that never shipped.
//
// Deliberately NOT derived from Date.now(). A "now" floor is above every build that
// exists, which is precisely the fleet-wide lockout above.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const argv = process.argv;
const APPLY = argv.includes('--apply');
const DISARM = argv.includes('--disarm');
const bi = argv.indexOf('--build');
const wantBuild = bi >= 0 ? Number(argv[bi + 1]) : null;
const p = (s = '') => console.log(s);

// ── current state ─────────────────────────────────────────────────────────
const { data: org, error: e1 } = await db
  .from('org_state').select('organization_id, version, min_client_build, freeze_strip, updated_by_build, updated_via, updated_at')
  .limit(1).maybeSingle();
if (e1 || !org) { console.error('read failed:', e1?.message || 'no org_state row'); process.exit(1); }

p(`\nFLEET GATE — org ${org.organization_id}`);
p('='.repeat(70));
p(`  min_client_build : ${org.min_client_build ?? 'NULL  (gate INERT — isBuildTooOld can never fire)'}`);
p(`  freeze_strip     : ${org.freeze_strip ? JSON.stringify(org.freeze_strip) : 'NULL'}`);
p(`  doc version      : ${org.version}`);
p(`  last write       : build ${org.updated_by_build} via ${org.updated_via ?? '(null)'} at ${org.updated_at}`);

// ── observed builds: the ONLY evidence a build is real and deployed ──────
const seen = new Map(); // build -> { n, last }
const note = (b, at) => {
  if (!Number.isFinite(Number(b))) return;
  const k = Number(b);
  const e = seen.get(k) || { n: 0, last: '' };
  e.n += 1; if (at > e.last) e.last = at;
  seen.set(k, e);
};
if (org.updated_by_build) note(org.updated_by_build, org.updated_at);

// The append-only sink is the good source once it exists; jobs is the fallback.
const sink = await db.from('org_state_writes_seen')
  .select('updated_by_build, observed_at').order('observed_at', { ascending: false }).limit(5000);
if (!sink.error) for (const r of sink.data || []) note(r.updated_by_build, r.observed_at);

const jobs = await db.from('jobs')
  .select('updated_by_build, updated_at').not('updated_by_build', 'is', null)
  .order('updated_at', { ascending: false }).limit(5000);
if (!jobs.error) for (const r of jobs.data || []) note(r.updated_by_build, r.updated_at);

const builds = [...seen.entries()].sort((a, b) => b[0] - a[0]);
p(`\nOBSERVED BUILD IDS (${builds.length}) ${sink.error ? '— sink absent, from org_state + jobs only' : ''}`);
if (!builds.length) { p('  none — cannot verify any build exists. Refusing to arm.'); }
for (const [b, e] of builds.slice(0, 12)) {
  p(`  ${b}   ${new Date(b).toISOString()}   ${String(e.n).padStart(5)} write(s)   last ${e.last}`);
}
const maxBuild = builds.length ? builds[0][0] : null;

// ── disarm ────────────────────────────────────────────────────────────────
if (DISARM) {
  p('\nDISARM → min_client_build = NULL (always safe: the gate simply stops firing)');
  if (!APPLY) { p('Dry run — nothing written. Re-run with --apply.\n'); process.exit(0); }
  const { error } = await db.from('org_state').update({ min_client_build: null }).eq('organization_id', org.organization_id);
  if (error) { console.error('write failed:', error.message); process.exit(1); }
  const { data: after } = await db.from('org_state').select('min_client_build').eq('organization_id', org.organization_id).maybeSingle();
  p(`✓ disarmed — min_client_build is now ${after?.min_client_build ?? 'NULL'}\n`);
  process.exit(0);
}

if (wantBuild === null) {
  p('\nNo --build given — inspection only.');
  if (maxBuild) p(`Highest observed build is ${maxBuild}; arming at that value asks every OLDER tab to reload once.`);
  p('');
  process.exit(0);
}

// ── the refusals ──────────────────────────────────────────────────────────
if (!Number.isFinite(wantBuild) || wantBuild <= 0) {
  console.error(`\n⛔ --build must be a positive number, got "${argv[bi + 1]}".\n`); process.exit(1);
}
if (!maxBuild) {
  console.error('\n⛔ No build id has ever been observed writing. Cannot verify the target exists.\n'); process.exit(1);
}
if (wantBuild > maxBuild) {
  console.error(`\n⛔ REFUSING: ${wantBuild} is ABOVE the highest observed build ${maxBuild}.`);
  console.error('   Every tab would be below the floor, told to reload, and reload into a bundle');
  console.error('   that is still below it — a permanent fleet-wide write outage with no');
  console.error('   client-side recovery. If a newer build really is deployed, wait until it has');
  console.error('   written once so it can be observed, then re-run.\n');
  process.exit(1);
}

// ── impact ────────────────────────────────────────────────────────────────
const below = builds.filter(([b]) => b < wantBuild);
const atOrAbove = builds.filter(([b]) => b >= wantBuild);
p(`\nARM → min_client_build = ${wantBuild}  (${new Date(wantBuild).toISOString()})`);
p(`  builds AT/ABOVE the floor (keep writing) : ${atOrAbove.length}  ${atOrAbove.map(([b]) => b).join(', ') || '—'}`);
p(`  builds BELOW the floor (reload once)     : ${below.length}  ${below.map(([b]) => b).join(', ') || '—'}`);
if (org.min_client_build && wantBuild < org.min_client_build) {
  p(`  ⚠️  LOWERING the floor from ${org.min_client_build} — allowed, but it re-admits older tabs.`);
}
if (!APPLY) { p('\nDry run — nothing written. Re-run with --apply.\n'); process.exit(0); }

// CAS on the value we just read, so a concurrent change is not silently clobbered.
const q = db.from('org_state').update({ min_client_build: wantBuild }).eq('organization_id', org.organization_id);
const { data: written, error } = await (org.min_client_build === null
  ? q.is('min_client_build', null)
  : q.eq('min_client_build', org.min_client_build)).select('min_client_build');
if (error) { console.error('write failed:', error.message); process.exit(1); }
if (!written || !written.length) {
  console.error('\n⛔ CAS MISS — min_client_build changed since this script read it. Nothing written. Re-run.\n');
  process.exit(1);
}
const { data: after } = await db.from('org_state').select('min_client_build').eq('organization_id', org.organization_id).maybeSingle();
p(`\n✓ armed — min_client_build is now ${after?.min_client_build}`);
p('  Tabs below the floor reload ONCE per page-load (sync.js guards against a loop).');
p(`  Rollback: node scripts/arm-fleet-gate.mjs --disarm --apply\n`);
