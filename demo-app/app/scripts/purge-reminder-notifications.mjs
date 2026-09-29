// One-time cleanup after automated customer reminders were disabled (2026-07-02).
// The (unplanned) reminder scheduler was firing on every open staff tab and
// failing for accounts with no email on file; the reminderFailed alert I'd added
// then flooded every manager's bell (Kyle hit 99+). Reminders are now off (the
// scheduler is unmounted + templates seeded disabled), so this clears the mess:
//
//   1. Removes every `reminderFailed` notification row (the flooded bell rows).
//   2. Empties `reminderEvents` — dead churn now that nothing fires (mostly the
//      "No email address" failure records for no-email accounts).
//
// Idempotent, full backup before write, CAS-guarded. Preview first:
//   node scripts/purge-reminder-notifications.mjs --dry-run
//   node scripts/purge-reminder-notifications.mjs
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

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const notifications = state.notifications || [];
const reminderEvents = state.reminderEvents || [];

const flooded = notifications.filter((n) => n.eventKey === 'reminderFailed');
const keptNotifications = notifications.filter((n) => n.eventKey !== 'reminderFailed');

// Per-user breakdown of the flood, so it's clear who got hit.
const byUser = new Map();
for (const n of flooded) byUser.set(n.userId, (byUser.get(n.userId) || 0) + 1);
const userName = (id) => (state.users || []).find((u) => u.id === id)?.name || id;

console.log(`\norg_state v${snap.version}.\n`);
console.log(`reminderFailed bell rows to remove: ${flooded.length}`);
for (const [uid, count] of [...byUser.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  · ${userName(uid)}: ${count}`);
}
console.log(`reminderEvents to clear (dead now): ${reminderEvents.length}`);
console.log(`notifications kept: ${keptNotifications.length}`);

if (!flooded.length && !reminderEvents.length) { console.log('\nNothing to clean — already clear.\n'); process.exit(0); }
if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }

const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const nextState = { ...state, notifications: keptNotifications, reminderEvents: [] };
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Removed ${flooded.length} reminderFailed rows + cleared ${reminderEvents.length} reminderEvents. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
