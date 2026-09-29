// READ-ONLY audit: does every key group map to a real CRM account?
// A key "maps to a true place" if it has a clientId pointing at an existing
// account, OR (no clientId) its free-text clientName matches an account name
// after trim+lowercase — the same rule the app uses for crew visibility and the
// account keys card (selectKeysForClient / keyInScope). Groups that satisfy
// neither are ORPHANS (like Harnish was: keys under "Harnish Subaru/GMC/Chevy/VW"
// with no matching account). For each orphan it lists the closest account names
// by shared-word overlap, so a "renamed" case (needs consolidation) is easy to
// tell from a "no account at all" case (needs an account created).
//
// Writes NOTHING. Just prints the report.
//   node scripts/audit-key-mapping.mjs
import { readFileSync } from 'node:fs';
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
const norm = (s) => (s || '').trim().toLowerCase();
// Significant words for fuzzy suggestions (drop noise/stopwords).
const STOP = new Set(['the', 'of', 'and', 'inc', 'llc', 'co', 'company', 'a', 'at', '-', 'puyallup']);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w && w.length > 2 && !STOP.has(w));

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }

const state = snap.state;
const clients = state.clients || [];
const keys = state.keys || [];
const clientById = new Map(clients.map((c) => [c.id, c]));
const clientByName = new Map(clients.map((c) => [norm(c.name), c]));
const clientWords = clients.map((c) => ({ name: c.name, w: new Set(words(c.name)) }));

// Group keys by their free-text company label.
const groups = new Map();
for (const k of keys) {
  const label = k.clientName || '(no company name)';
  if (!groups.has(label)) groups.set(label, { label, keys: [], anyValidId: false, anyBrokenId: false });
  const g = groups.get(label);
  g.keys.push(k);
  if (k.clientId) { (clientById.has(k.clientId) ? (g.anyValidId = true) : (g.anyBrokenId = true)); }
}

const suggest = (label) => {
  const lw = new Set(words(label));
  if (!lw.size) return [];
  return clientWords
    .map((c) => ({ name: c.name, overlap: [...c.w].filter((w) => lw.has(w)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map((x) => x.name);
};

const mapped = [], orphans = [];
for (const g of [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))) {
  const nameMatch = clientByName.get(norm(g.label)) || null;
  const isMapped = !!nameMatch || g.anyValidId;
  const rec = { ...g, count: g.keys.length, nameMatch: nameMatch?.name || null };
  (isMapped ? mapped : orphans).push(rec);
}

console.log(`\norg_state v${snap.version} — ${keys.length} keys across ${groups.size} company groups; ${clients.length} accounts.\n`);
console.log(`MAPPED to a real account: ${mapped.length} group(s).`);
console.log(`ORPHANED (no account matches): ${orphans.length} group(s).\n`);

if (orphans.length) {
  console.log('ORPHAN key groups — need a true place:');
  for (const o of orphans) {
    const flag = o.anyBrokenId ? ' [has clientId pointing at a MISSING account]' : '';
    console.log(`  • ${String(o.count).padStart(3)}  "${o.label}"${flag}`);
    const sugg = suggest(o.label);
    if (sugg.length) console.log(`         closest accounts: ${sugg.join('  |  ')}`);
    else console.log('         closest accounts: (no similar account name found)');
  }
} else {
  console.log('✓ Every key group maps to a real account. No orphans.');
}
console.log('');
