// Correction (2026-07-01): the Dania umbrella consolidation was wrong — the
// client confirmed the five separate Dania accounts were intentional, and the
// pre-change backup shows the 3 "Dania Warehouse" keys belong to the account
// "Dania Distribution Center" (1350 Wharf Rd — the actual warehouse; its
// standing crew, Rachel Boggs + RaKayla Vega, are the keys' named holders).
// finish-orphan-keys.mjs had instead created a "Dania" umbrella account +
// 4 sub-sites and attached the keys there.
//
// This script, in ONE atomic write:
//   1. Relinks the 3 Dania keys → "Dania Distribution Center" (by clientId).
//   2. Deletes the umbrella "Dania" account (cl_dania_group) + its 4 sites —
//      created minutes earlier by us, nothing else references them (verified
//      below before writing; aborts if anything does).
//   3. Leaves the five original Dania accounts untouched (they always were).
// Also VERIFIES (read-only report): no key in the system references the four
// retail Dania location accounts — they never had keys logged.
//
//   node scripts/fix-dania-keys.mjs --dry-run
//   node scripts/fix-dania-keys.mjs
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
const UMBRELLA_ID = 'cl_dania_group';
const TARGET_NAME = 'Dania Distribution Center';
const norm = (s) => (s || '').trim().toLowerCase();
const nowIso = new Date().toISOString();

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const clients = state.clients || [];
const sites = state.sites || [];
const keys = state.keys || [];

const target = clients.find((c) => norm(c.name) === norm(TARGET_NAME));
if (!target) { console.error(`✗ Account "${TARGET_NAME}" not found — aborting.`); process.exit(1); }
const umbrella = clients.find((c) => c.id === UMBRELLA_ID) || null;
const umbrellaSites = sites.filter((s) => s.clientId === UMBRELLA_ID);

// Keys to move: anything on the umbrella, plus any stragglers still labeled Dania Warehouse.
const moveKeys = keys.filter((k) =>
  (k.clientId === UMBRELLA_ID || (!k.clientId && norm(k.clientName) === 'dania warehouse'))
  && !(k.clientId === target.id && k.clientName === target.name));

// SAFETY: nothing else may reference the umbrella account or its sites.
const umbrellaSiteIds = new Set(umbrellaSites.map((s) => s.id));
const refs = [];
const chk = (label, arr, fn) => { const n = (arr || []).filter(fn).length; if (n) refs.push(`${n} ${label}`); };
chk('job(s)', state.jobs, (j) => j.clientId === UMBRELLA_ID || umbrellaSiteIds.has(j.siteId));
chk('invoice(s)', state.invoices, (i) => i.clientId === UMBRELLA_ID);
chk('contact(s)', state.contacts, (c) => c.companyId === UMBRELLA_ID);
chk('complaint(s)', state.complaints, (c) => c.clientId === UMBRELLA_ID);
chk('conversation(s)', state.conversations, (c) => c.clientId === UMBRELLA_ID);
chk('client activit(ies)', state.clientActivities, (a) => a.clientId === UMBRELLA_ID);
chk('key(s) NOT being moved', keys, (k) => k.clientId === UMBRELLA_ID && !moveKeys.includes(k));
if (refs.length) { console.error(`✗ Umbrella still referenced by: ${refs.join(', ')} — aborting, nothing written.`); process.exit(1); }

// VERIFY (report): the four retail Dania location accounts have never had keys.
const retail = clients.filter((c) => /^dania\s*-/i.test(c.name || ''));
console.log(`\norg_state v${snap.version}\n`);
console.log('Retail Dania accounts — keys referencing each (by clientId or name):');
for (const c of retail) {
  const n = keys.filter((k) => k.clientId === c.id || norm(k.clientName) === norm(c.name)).length;
  console.log(`  ${String(n).padStart(2)}  ${c.name}`);
}

console.log(`\nMOVE ${moveKeys.length} key(s) → "${target.name}" (${target.id}):`);
for (const k of moveKeys) console.log(`  ${k.label}  (was clientName=${JSON.stringify(k.clientName)}, clientId=${JSON.stringify(k.clientId)})`);
console.log(umbrella
  ? `DELETE umbrella account "${umbrella.name}" (${UMBRELLA_ID}) + ${umbrellaSites.length} site(s): ${umbrellaSites.map((s) => s.name).join(', ') || '—'}`
  : 'Umbrella account already gone — nothing to delete.');
console.log(`Originals untouched: ${retail.map((c) => c.name).join(' · ')} · ${target.name}`);

if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }
if (!moveKeys.length && !umbrella && !umbrellaSites.length) { console.log('\nNothing to change.\n'); process.exit(0); }

const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const moveIds = new Set(moveKeys.map((k) => k.id));
const nextState = {
  ...state,
  clients: clients.filter((c) => c.id !== UMBRELLA_ID),
  sites: sites.filter((s) => s.clientId !== UMBRELLA_ID),
  keys: keys.map((k) => (moveIds.has(k.id) ? { ...k, clientId: target.id, clientName: target.name } : k)),
};
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Moved ${moveKeys.length} keys to "${target.name}", removed the umbrella + ${umbrellaSites.length} sites. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
