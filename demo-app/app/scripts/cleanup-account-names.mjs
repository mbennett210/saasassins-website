// One-time cleanup: some accounts were imported with the expected clean time
// typed into the company NAME (e.g. "Capital City Smiles (2.5 hrs)" or
// "Acme (2.5 / 1.25)"). This lifts the BIGGER number (the one-cleaner time, =
// total labor) into client.expectedCleanMins (labor-minutes) and strips the
// annotation from the name. The smaller two-cleaner number is derived by crew
// size, so it isn't stored. Only TIME-LIKE parentheticals match, so a real
// "(Suite 200)" / "(West)" is never touched. Idempotent + CAS-guarded.
//
//   node scripts/cleanup-account-names.mjs --dry-run   # report only, write nothing
//   node scripts/cleanup-account-names.mjs             # apply (writes org_state)
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Load env (.env.local preferred; fall back to .env.local.bak like other scripts).
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
const NUM = /\d+(?:\.\d+)?|\.\d+/g;

const isTimeLike = (inner) => {
  if (!/\d/.test(inner)) return false;
  // Strip digits/separators and any hr/min unit word — a real time leaves nothing.
  return inner.replace(/[\s\d.,/]/g, '').replace(/hrs?|hours?|mins?|min|h/gi, '') === '';
};

function parseAccountName(rawName) {
  const name = String(rawName || '');
  let annotation = null;
  let cleanName = name;
  const paren = name.match(/\s*[([{]([^)\]}]*)[)\]}]\s*$/);
  if (paren && isTimeLike(paren[1])) {
    annotation = paren[1];
    cleanName = name.slice(0, paren.index).trim();
  } else {
    const tail = name.match(/[\s\-–—:]+(\d[\d.,]*\s*\/\s*\d[\d.,]*|\d[\d.,]*\s*(?:hrs?|hours?|mins?|min|h)\b)\.?\s*$/i);
    if (tail) { annotation = tail[1]; cleanName = name.slice(0, tail.index).trim(); }
  }
  if (annotation == null) return null;
  const nums = (annotation.match(NUM) || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const minutesUnit = /\bmin/i.test(annotation) && !/\bh(?:rs?|ours?)?\b/i.test(annotation);
  const biggest = Math.max(...nums);
  const mins = Math.round(minutesUnit ? biggest : biggest * 60);
  if (!mins) return null;
  if (!cleanName) cleanName = name;
  return { cleanName, mins, numbers: [...nums].sort((a, b) => b - a) };
}

const hhmm = (m) => { const h = Math.floor(m / 60); const mm = m % 60; return h ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`; };

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }

const state = snap.state;
const clients = state.clients || [];
const sites = state.sites || [];
const siteCount = (cid) => sites.filter((s) => s.clientId === cid).length;

const matches = [];
for (const c of clients) {
  const p = parseAccountName(c.name);
  if (p) matches.push({ id: c.id, current: c.name, clean: p.cleanName, mins: p.mins, numbers: p.numbers, existing: c.expectedCleanMins, sites: siteCount(c.id) });
}

console.log(`\norg_state version ${snap.version} — ${clients.length} accounts total, ${matches.length} with a time in the name:\n`);
for (const m of matches) {
  const where = m.sites > 1 ? `  ⚠ ${m.sites} sites` : (m.sites === 1 ? '  · 1 site' : '  · no sites yet');
  const was = (typeof m.existing === 'number') ? `  [was ${hhmm(m.existing)}]` : '';
  console.log(`  • "${m.current}"`);
  console.log(`      → "${m.clean}"   expected ${hhmm(m.mins)} (${m.mins} min · from ${m.numbers.join(' / ')})${was}${where}`);
}
const multi = matches.filter((m) => m.sites > 1);
if (multi.length) {
  console.log(`\n⚠ ${multi.length} account(s) have MULTIPLE sites — the time lands as an account-level default (every site inherits it unless a site sets its own). Per-location-exact would need per-site entry.`);
}

if (!matches.length) { console.log('Nothing to clean.'); process.exit(0); }
if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }

// Safety: snapshot the full current state before writing, so any mistake is reversible.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = new URL(`./orgstate-backup-${stamp}.json`, import.meta.url);
writeFileSync(backupPath, JSON.stringify({ version: snap.version, state }));

const byId = new Map(matches.map((m) => [m.id, m]));
const nextClients = clients.map((c) => (byId.has(c.id)
  ? { ...c, name: byId.get(c.id).clean, expectedCleanMins: byId.get(c.id).mins }
  : c));
const nextState = { ...state, clients: nextClients };
const nowIso = new Date().toISOString();

const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — org_state changed under me (someone saved in the app). Nothing written; re-run.'); process.exit(1); }
console.log(`\n✓ Cleaned ${matches.length} account name(s) + set expected clean time. org_state version ${snap.version} → ${snap.version + 1}.`);
console.log(`  Backup of prior state: app/scripts/orgstate-backup-${stamp}.json\n`);
