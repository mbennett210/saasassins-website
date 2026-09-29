// ⚠️ DELIBERATELY NOT RUN. Daniel declined the purge on 2026-07-22 — the existing rows
// are being left to clear themselves via capInsert's caps. This script is kept ready in
// case that changes. Do NOT run it as "leftover cleanup" from a handoff; it is not an
// unfinished task. Only run it if someone asks for the old rows gone NOW.
//
// One-time cleanup after the key "overdue" feature was removed (2026-07-22, owner
// decision: keys have NO return window and NO due-back date or time, and nobody is
// notified about a key still being out).
//
// The code is already gone — SWEEP_OVERDUE_KEYS, the `keyOverdue` catalog toggle,
// `opsSettings.keyOverdueDays`, and the `{n}d overdue` chip. But removing the code
// does NOT remove rows the old sweep already wrote into the live blob, so a manager's
// bell keeps showing "Key X out N days" forever. This clears the residue:
//
//   1. Removes every `keyOverdue` notification row (the manager bell rows).
//   2. Drops the per-key `overdueNotifiedAt` one-shot marker (dead field).
//   3. Drops `opsSettings.keyOverdueDays` (dead setting).
//   4. Drops the per-user `notificationPrefs.keyOverdue` toggle value (dead key —
//      the toggle no longer renders, so a stored true/false is unreachable).
//
// Idempotent, full backup before write, CAS-guarded. Preview first:
//   node scripts/purge-key-overdue.mjs --dry-run
//   node scripts/purge-key-overdue.mjs
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
const keys = state.keys || [];
const users = state.users || [];

const flooded = notifications.filter((n) => n.eventKey === 'keyOverdue');
const keptNotifications = notifications.filter((n) => n.eventKey !== 'keyOverdue');

// Per-user breakdown of the bell rows, so it's clear who was getting these.
const byUser = new Map();
for (const n of flooded) byUser.set(n.userId, (byUser.get(n.userId) || 0) + 1);
const userName = (id) => users.find((u) => u.id === id)?.name || id;

// Dead-field residue.
const stampedKeys = keys.filter((k) => k.overdueNotifiedAt != null);
const hadSetting = state.opsSettings && 'keyOverdueDays' in state.opsSettings;
const prefUsers = users.filter((u) => u.notificationPrefs && 'keyOverdue' in u.notificationPrefs);

console.log(`\norg_state v${snap.version}.\n`);
console.log(`keyOverdue bell rows to remove: ${flooded.length}`);
for (const [uid, count] of [...byUser.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  · ${userName(uid)}: ${count}`);
}
console.log(`keys carrying a dead overdueNotifiedAt marker: ${stampedKeys.length}`);
console.log(`opsSettings.keyOverdueDays present: ${hadSetting ? `yes (${state.opsSettings.keyOverdueDays})` : 'no'}`);
console.log(`users carrying a dead keyOverdue pref: ${prefUsers.length}`);
console.log(`notifications kept: ${keptNotifications.length}`);

if (!flooded.length && !stampedKeys.length && !hadSetting && !prefUsers.length) {
  console.log('\nNothing to clean — already clear.\n'); process.exit(0);
}
if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }

const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

// Strip the dead fields rather than nulling them — a null `overdueNotifiedAt` would
// still read as "this key participates in an overdue concept", and it does not.
const nextKeys = keys.map((k) => {
  if (k.overdueNotifiedAt == null) return k;
  const { overdueNotifiedAt: _drop, ...rest } = k;
  return rest;
});
const nextUsers = users.map((u) => {
  if (!u.notificationPrefs || !('keyOverdue' in u.notificationPrefs)) return u;
  const { keyOverdue: _drop, ...prefs } = u.notificationPrefs;
  return { ...u, notificationPrefs: prefs };
});
let nextOps = state.opsSettings;
if (hadSetting) {
  const { keyOverdueDays: _drop, ...rest } = state.opsSettings;
  nextOps = rest;
}

const nextState = {
  ...state,
  notifications: keptNotifications,
  keys: nextKeys,
  users: nextUsers,
  ...(state.opsSettings ? { opsSettings: nextOps } : {}),
};

const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Removed ${flooded.length} keyOverdue rows · cleared ${stampedKeys.length} overdueNotifiedAt markers · dropped keyOverdueDays (${hadSetting ? 'was set' : 'absent'}) · cleaned ${prefUsers.length} dead prefs. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
