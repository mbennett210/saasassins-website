// One-time cleanup: drop the dead 'messaging.internalComment' permission from the
// live org_state. The toggle was read by NO code (CREW_AUDIT #19) — revoking it did
// nothing, misleading admins about enforced state — and the roadmap wants every
// role posting internal notes, so the key was removed from lib/roles.js + the Roles
// matrix UI (2026-07-01). This removes the leftover row from state.permissions and
// prunes it from any per-user override grants/revokes (pruning empty override rows,
// matching the app's own save behavior).
//
// Idempotent, full backup before write, CAS-guarded.
//   node scripts/remove-dead-perm.mjs --dry-run
//   node scripts/remove-dead-perm.mjs
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
const DEAD = 'messaging.internalComment';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const perms = state.permissions || [];
const overrides = state.userPermissionOverrides || [];

const hadRow = perms.some((p) => p.id === DEAD);
const nextPerms = perms.filter((p) => p.id !== DEAD);
const touchedOverrides = overrides.filter((o) => (o.grants || []).includes(DEAD) || (o.revokes || []).includes(DEAD)).length;
const nextOverrides = overrides
  .map((o) => ({ ...o, grants: (o.grants || []).filter((k) => k !== DEAD), revokes: (o.revokes || []).filter((k) => k !== DEAD) }))
  .filter((o) => o.grants.length || o.revokes.length);

console.log(`\norg_state v${snap.version} — matrix row present: ${hadRow} · overrides referencing it: ${touchedOverrides}`);
if (!hadRow && !touchedOverrides) { console.log('Nothing to change.\n'); process.exit(0); }
if (DRY) { console.log('--dry-run: nothing written.\n'); process.exit(0); }

const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const nextState = { ...state, permissions: nextPerms, userPermissionOverrides: nextOverrides };
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — re-run.'); process.exit(1); }
console.log(`✓ Removed '${DEAD}'. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
