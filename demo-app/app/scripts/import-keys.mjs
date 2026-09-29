// One-time import of the Key sheet into the shared org_state. Reads the public
// CSV, parses each client's keys + current holders, maps holders to staff users
// by name (else keeps a label / flags unknown), and appends keys + seed history
// events into org_state.keys / org_state.keyEvents. Idempotent (skips keys that
// already exist by clientName+label).
//
//   node scripts/import-keys.mjs --dry-run    # parse + report, write nothing
//   node scripts/import-keys.mjs              # actually write to org_state
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const ORG = '00000000-0000-0000-0000-000000000001';
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1fG_Srlu0pRChHKRKuYrTLznjitG_Ia7CrIwo1knnzXQ/export?format=csv&gid=0';
const DRY = process.argv.includes('--dry-run');

// minimal CSV parser (handles quoted fields with embedded commas/newlines)
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => (s || '').trim();
function classifyHolder(raw, usersByName) {
  const v = norm(raw);
  if (!v) return { status: 'in' };
  if (/office/i.test(v)) return { status: 'in', notes: v };                       // at the office = available
  if (/\?\?\?|where is it|no key|no info|lost|missing|on site/i.test(v)) return { status: 'unknown', notes: v };
  const user = usersByName.get(v.toLowerCase());
  if (user) return { status: 'out', heldByUserId: user.id };                      // checked out to a staff member
  return { status: 'out', heldByName: v, unmatched: true };                        // a person we couldn't match
}

const res = await fetch(SHEET_CSV);
if (!res.ok) { console.error('Failed to fetch sheet CSV:', res.status); process.exit(1); }
const rows = parseCsv(await res.text());
const header = rows.shift() || [];
// header: Customer, Key #, # of keys, Key 1, Team Member, Key 2, Team Member, ...
const keyPairCols = [];
for (let i = 3; i < header.length; i += 2) keyPairCols.push([i, i + 1]); // [keyLabelCol, holderCol]

// pull current org_state (users for name-matching, existing keys for idempotency)
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }
const state = snap.state;
const usersByName = new Map((state.users || []).map((u) => [(u.name || '').toLowerCase(), u]));
const existing = new Set((state.keys || []).map((k) => `${k.clientName}|${k.label}`.toLowerCase()));

const newKeys = [], newEvents = [], unmatched = [];
let rid = 0; const id = (p) => `${p}_imp_${Date.now().toString(36)}_${rid++}`;
const nowIso = new Date().toISOString();

for (const r of rows) {
  const clientName = norm(r[0]); if (!clientName) continue;
  const masterCode = norm(r[1]); const qty = norm(r[2]);
  for (const [labelCol, holderCol] of keyPairCols) {
    const label = norm(r[labelCol]); if (!label) continue;
    if (existing.has(`${clientName}|${label}`.toLowerCase())) continue; // idempotent
    const h = classifyHolder(r[holderCol], usersByName);
    const keyId = id('key');
    newKeys.push({
      id: keyId, clientName, clientId: null, masterCode, label,
      status: h.status, heldByUserId: h.heldByUserId || null, heldByName: h.heldByName || null,
      notes: [qty ? `# of keys: ${qty}` : '', h.notes || ''].filter(Boolean).join(' · '),
      createdAt: nowIso, updatedAt: nowIso,
    });
    if (h.status === 'out') {
      newEvents.push({ id: id('kev'), keyId, kind: 'checkout', byUserId: null, holderUserId: h.heldByUserId || null, holderName: h.heldByName || null, occurredAt: nowIso, note: 'Imported from key sheet' });
    }
    if (h.unmatched) unmatched.push(`${clientName} · ${label} → "${norm(r[holderCol])}"`);
  }
}

console.log(`Parsed ${rows.length} client rows → ${newKeys.length} new keys (${newEvents.length} currently out).`);
if (unmatched.length) {
  console.log(`\n⚠ ${unmatched.length} holders couldn't be matched to a staff user (kept as a label — review in-app):`);
  unmatched.slice(0, 40).forEach((u) => console.log('   ' + u));
}
if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
if (newKeys.length === 0) { console.log('\nNothing new to import.'); process.exit(0); }

const nextState = { ...state, keys: [...(state.keys || []), ...newKeys], keyEvents: [...(state.keyEvents || []), ...newEvents] };
const { error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version);
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
console.log(`\n✓ Imported ${newKeys.length} keys into org_state (version ${snap.version} → ${snap.version + 1}).`);
