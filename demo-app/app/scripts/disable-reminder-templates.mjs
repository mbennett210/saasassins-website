// One-time data-op (2026-07-12): set every reminderTemplates[].enabled = false in
// the LIVE org_state blob.
//
// ✅ ALREADY RAN 2026-07-12 against prod: org_state v47166 → v47167, 5 templates
//    (welcome_email, booking_confirmation, reminder_24h, day_of_eta, post_service)
//    all flipped true → false. Backup: orgstate-backup-2026-07-12T22-12-55-030Z.json.
//    Idempotent — a re-run now is a clean no-op. Kept as the runbook.
//
// WHY: the "reminders off by default" guarantee lives in the SEED (enabled:false),
// but the live blob hydrates raw and was never reset — it still carries
// enabled:true on all templates from before the 2026-07-02 client-scheduler kill.
// That was inert while nothing read them. WS-E adds a SERVER cron
// (/api/reminders/run, every 5 min in vercel.json) that DOES read them, so
// shipping WS-E would auto-resume customer emails (booking_confirmation +
// post_service) with no operator action. This reconciles live state with the
// intended default so an operator must deliberately turn a template on.
//
// Idempotent (re-run → all already false → no-op), full backup before write,
// CAS-guarded (single-shot; re-run on conflict). Touches ONLY the `enabled`
// flags — reminderEvents (the dedup ledger) and everything else are untouched.
//
//   node scripts/disable-reminder-templates.mjs            # dry-run (default) — writes nothing
//   node scripts/disable-reminder-templates.mjs --apply    # arm: backup + CAS write
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
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (looked in app/.env.local).'); process.exit(1);
}

const ORG = '00000000-0000-0000-0000-000000000001';
const APPLY = process.argv.includes('--apply');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const templates = state.reminderTemplates || [];

console.log(`\norg_state v${snap.version} — connected to ${(process.env.SUPABASE_URL || '').replace(/(https:\/\/[a-z0-9]+)\..*/, '$1.supabase.co')}`);
console.log(`reminderTemplates (${templates.length}) — current → planned:`);
const willFlip = [];
for (const t of templates) {
  const before = t.enabled === true;
  if (before) willFlip.push(t.key);
  console.log(`  · ${String(t.key).padEnd(22)} channel=${String(t.channel || '—').padEnd(6)} enabled ${before ? 'true' : 'false'} → false${before ? '   [FLIP]' : ''}`);
}
console.log(`\nSummary: ${templates.length} templates, ${willFlip.length} enabled → all false. Flipping: ${willFlip.join(', ') || '(none)'}`);
console.log(`(reminderEvents untouched: ${(state.reminderEvents || []).length} rows kept as the dedup ledger.)`);

if (willFlip.length === 0) { console.log('\n✓ Already all disabled — no-op.\n'); process.exit(0); }

if (!APPLY) {
  console.log('\n--dry-run (default): nothing written. Re-run with --apply to arm.\n');
  process.exit(0);
}

// ── ARMED WRITE ──────────────────────────────────────────────────────────────
const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
const backupName = `orgstate-backup-${stamp}.json`;
writeFileSync(new URL(`./${backupName}`, import.meta.url), JSON.stringify({ version: snap.version, state }));
// sanity: backup parses
JSON.parse(readFileSync(new URL(`./${backupName}`, import.meta.url), 'utf8'));

const nextTemplates = templates.map((t) => (t.enabled === true ? { ...t, enabled: false } : t));
const nextState = { ...state, reminderTemplates: nextTemplates };
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Disabled ${willFlip.length} reminder template(s). org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/${backupName}\n`);
