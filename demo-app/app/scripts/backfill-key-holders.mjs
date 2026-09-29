// One-time backfill: link imported key holders to real users.
// The key-sheet import recorded every checked-out key's holder as free text
// (heldByName) with heldByUserId null. The app's "always see a key in your own
// hands" rule (Keys.jsx keyInScope) matches on heldByUserId only, so a crew
// member who physically holds an imported key can't see it unless they happen
// to be assigned to the company — 10 holders currently can't see keys they
// hold. UI checkouts already link properly (reducer CHECKOUT_KEY); this fixes
// the imported backlog to match.
//
// For each key with status 'out', heldByUserId null, and a heldByName that
// UNIQUELY matches an ACTIVE user (accent-insensitive, edit distance ≤ 2 to
// absorb the import's typos: "Hellina"→Helina, "Josh Glass"→Joshua Glass,
// "Kiona Clagget"→Claggett, "Daré"→Darè), set heldByUserId = that user and
// null heldByName — exactly what a linked UI checkout writes. Names that don't
// match a user (clients/contractors like "Ray Boggs") stay free text — correct.
// keyEvents history is left untouched (holderName there is the historical
// record; the History view renders it fine).
//
// Idempotent (linked keys skipped), full backup before write, CAS-guarded.
//   node scripts/backfill-key-holders.mjs --dry-run
//   node scripts/backfill-key-holders.mjs
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
const pnorm = (s) => (s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const lev = (a, b) => {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const keys = state.keys || [];
const activeUsers = (state.users || []).filter((u) => u.active !== false && u.name);

const changes = new Map();  // keyId → userId
const lines = [];
let external = 0, ambiguous = 0;
for (const k of keys) {
  if (k.status !== 'out' || k.heldByUserId || !k.heldByName) continue;
  const hn = pnorm(k.heldByName);
  const matches = activeUsers.filter((u) => { const un = pnorm(u.name); return un === hn || lev(un, hn) <= 2; });
  if (matches.length === 1) {
    const u = matches[0];
    changes.set(k.id, u.id);
    lines.push(`  ✓ "${k.label}" (${k.clientName})  "${k.heldByName}" → ${u.name} [${u.id}]${pnorm(u.name) !== hn ? '  (near-match)' : ''}`);
  } else if (matches.length > 1) {
    ambiguous++;
    lines.push(`  ⚠ "${k.label}" (${k.clientName})  "${k.heldByName}" matches ${matches.length} users (${matches.map((u) => u.name).join(', ')}) — SKIPPED`);
  } else {
    external++;
  }
}

console.log(`\norg_state v${snap.version} — ${keys.length} keys.\n`);
lines.forEach((l) => console.log(l));
console.log(`\nLink ${changes.size} holder(s) · ${external} stay free-text (no user match — external holders) · ${ambiguous} ambiguous (skipped).`);

if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }
if (!changes.size) { console.log('\nNothing to change.\n'); process.exit(0); }

const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
writeFileSync(new URL(`./orgstate-backup-${stamp}.json`, import.meta.url), JSON.stringify({ version: snap.version, state }));

const nextKeys = keys.map((k) => (changes.has(k.id)
  ? { ...k, heldByUserId: changes.get(k.id), heldByName: null, updatedAt: nowIso }
  : k));
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: { ...state, keys: nextKeys }, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me. Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Linked ${changes.size} key holders. org_state v${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json\n`);
