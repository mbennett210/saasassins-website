// READ-ONLY audit: is anything in the live org_state mis-routed in a way that
// breaks (or will break) what a crew member can see?
//
// Checks, grouped by output section:
//   A. BROKEN REFERENCES — FKs pointing at records that don't exist (these
//      render as blanks/"Unknown" or silently drop rows from crew scope).
//   B. KEYS HELD BY UNLINKED PEOPLE — key.heldByName fuzzy-matches a real user
//      but heldByUserId is null (the original Chloe Potter failure mode): the
//      "always see a key in your own hands" rule never fires. Flags whether the
//      person can currently see the key at all via company assignment.
//   C. KEY GROUPING / NAME DRIFT — linked keys whose clientName ≠ the account
//      name (Keys page groups by clientName → key files under a stale header);
//      duplicate normalized account names (name-fallback matches BOTH).
//   D. CREW REACH — per crew user: visible accounts / jobs / in-scope keys;
//      flags crew who see nothing. Plus accounts holding keys that NO crew
//      member can see (keys nobody on the floor can get to).
//   E. RENDER HAZARDS from CREW_AUDIT.md needs-live-data: contacts with null
//      lifecycle; site contacts whose companyId ≠ the site's client (JobDetail
//      links crew to a contact they can't open); users with duplicate /
//      case-differing emails (sync.js identity match).
//
// Writes NOTHING.   node scripts/audit-crew-visibility.mjs
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
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1);
}

const ORG = '00000000-0000-0000-0000-000000000001';
const norm = (s) => (s || '').trim().toLowerCase();
// Accent-insensitive person-name normalize ("Darè" ≈ "Dare").
const pnorm = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const lev = (a, b) => { // small Levenshtein for near-miss names ("Hellina" vs "Helina")
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
const s = snap.state;

const clients = s.clients || [], sites = s.sites || [], keys = s.keys || [];
const users = s.users || [], contacts = s.contacts || [], jobs = s.jobs || [];
const clientById = new Map(clients.map((c) => [c.id, c]));
const siteById = new Map(sites.map((x) => [x.id, x]));
const userById = new Map(users.map((u) => [u.id, u]));
const contactById = new Map(contacts.map((c) => [c.id, c]));
const activeUsers = users.filter((u) => u.active !== false);
const crew = activeUsers.filter((u) => u.role === 'crew');
const uname = (id) => userById.get(id)?.name || userById.get(id)?.email || id;

// Mirrors selectVisibleClientIdsFor (selectors.js:899).
const visibleFor = (user) => {
  const ids = new Set();
  clients.forEach((c) => { if ((c.standingCrewIds || []).includes(user.id)) ids.add(c.id); });
  sites.forEach((si) => { if (si.clientId && (si.standingCrewIds || []).includes(user.id)) ids.add(si.clientId); });
  jobs.forEach((j) => {
    if (!(j.crewIds || []).includes(user.id)) return;
    const cid = j.clientId || (j.siteId ? siteById.get(j.siteId)?.clientId : null);
    if (cid) ids.add(cid);
  });
  return ids;
};
// Mirrors keyInScope (Keys.jsx:75).
const keyInScopeFor = (user, vis, visNames) => (k) => {
  if (k.heldByUserId === user.id) return true;
  if (k.clientId) return vis.has(k.clientId);
  const n = norm(k.clientName);
  return !!n && visNames.has(n);
};
// Mirrors selectJobsForUser (selectors.js:323).
const jobMine = (user) => (j) => {
  if ((j.crewIds || []).includes(user.id)) return true;
  const site = j.siteId ? siteById.get(j.siteId) : null;
  if (site && (site.standingCrewIds || []).includes(user.id)) return true;
  const cid = j.clientId || site?.clientId || null;
  const c = cid ? clientById.get(cid) : null;
  return !!c && (c.standingCrewIds || []).includes(user.id);
};

const out = [];
const section = (t) => out.push(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);
const line = (t) => out.push(t);

// ---------- A. BROKEN REFERENCES ----------
section('A. BROKEN REFERENCES');
let broken = 0;
const flag = (t) => { broken++; line('  ✗ ' + t); };
keys.forEach((k) => { if (k.clientId && !clientById.has(k.clientId)) flag(`key "${k.label}" clientId → missing account ${k.clientId}`); });
keys.forEach((k) => { if (k.heldByUserId && !userById.has(k.heldByUserId)) flag(`key "${k.label}" heldByUserId → missing user ${k.heldByUserId}`); });
keys.forEach((k) => { if (k.heldByUserId && userById.get(k.heldByUserId)?.active === false) flag(`key "${k.label}" held by INACTIVE user ${uname(k.heldByUserId)}`); });
sites.forEach((si) => { if (si.clientId && !clientById.has(si.clientId)) flag(`site "${si.name}" clientId → missing account ${si.clientId}`); });
sites.forEach((si) => { if (!si.clientId) flag(`site "${si.name}" [${si.id}] has NO clientId (orphan — its standing crew grants nothing; jobs there resolve no account)`); });
sites.forEach((si) => { if (si.siteContactId && !contactById.has(si.siteContactId)) flag(`site "${si.name}" siteContactId → missing contact ${si.siteContactId}`); });
sites.forEach((si) => (si.standingCrewIds || []).forEach((id) => { if (!userById.has(id)) flag(`site "${si.name}" standing crew → missing user ${id}`); else if (userById.get(id).active === false) flag(`site "${si.name}" standing crew includes INACTIVE ${uname(id)}`); }));
clients.forEach((c) => (c.standingCrewIds || []).forEach((id) => { if (!userById.has(id)) flag(`account "${c.name}" standing crew → missing user ${id}`); else if (userById.get(id).active === false) flag(`account "${c.name}" standing crew includes INACTIVE ${uname(id)}`); }));
clients.forEach((c) => { if (c.primaryContactId && !contactById.has(c.primaryContactId)) flag(`account "${c.name}" primaryContactId → missing contact ${c.primaryContactId}`); });
contacts.forEach((c) => { if (c.companyId && !clientById.has(c.companyId)) flag(`contact "${c.firstName} ${c.lastName}" companyId → missing account ${c.companyId} (contact invisible to ALL crew + orphaned)`); });
jobs.forEach((j) => {
  if (j.clientId && !clientById.has(j.clientId)) flag(`job ${j.id} clientId → missing account`);
  if (j.siteId && !siteById.has(j.siteId)) flag(`job ${j.id} siteId → missing site (site block blank; site-crew scoping dead)`);
  if (!j.clientId && !(j.siteId && siteById.get(j.siteId)?.clientId)) flag(`job ${j.id} resolves NO account (invisible to crew via job path)`);
  (j.crewIds || []).forEach((id) => { if (!userById.has(id)) flag(`job ${j.id} crewIds → missing user ${id}`); });
});
if (!broken) line('  ✓ none — every FK resolves to a live record');

// ---------- B. KEYS HELD BY UNLINKED PEOPLE ----------
section('B. KEYS "OUT" TO A REAL USER BUT NOT LINKED (heldByUserId null)');
let unlinked = 0;
for (const k of keys) {
  if (k.heldByUserId || !k.heldByName || k.status !== 'out') continue;
  const hn = pnorm(k.heldByName);
  const match = activeUsers.find((u) => { const un = pnorm(u.name || ''); return un && (un === hn || lev(un, hn) <= 2); });
  if (!match) continue;
  unlinked++;
  const vis = visibleFor(match);
  const visNames = new Set([...vis].map((id) => norm(clientById.get(id)?.name)).filter(Boolean));
  const canSee = keyInScopeFor(match, vis, visNames)(k);
  line(`  ${canSee ? '·' : '✗'} "${k.label}" (${k.clientName}) held by "${k.heldByName}" ≈ user ${match.name} [${match.role}]${canSee ? ' — can see it via assignment' : ' — CANNOT SEE THE KEY THEY HOLD'}`);
}
if (!unlinked) line('  ✓ none');

// ---------- C. KEY GROUPING / NAME DRIFT ----------
section('C. KEY NAME DRIFT + DUPLICATE ACCOUNT NAMES');
let drift = 0;
for (const k of keys) {
  if (!k.clientId) continue;
  const c = clientById.get(k.clientId);
  if (c && norm(k.clientName) !== norm(c.name)) { drift++; line(`  ✗ key "${k.label}" files under header "${k.clientName}" but is linked to account "${c.name}"`); }
}
const nameCount = new Map();
clients.forEach((c) => { const n = norm(c.name); nameCount.set(n, (nameCount.get(n) || []).concat(c.name)); });
for (const [n, arr] of nameCount) if (arr.length > 1) { drift++; line(`  ✗ DUPLICATE account name (normalized "${n}"): ${arr.join(' | ')} — name-fallback keys/visibility match BOTH`); }
if (!drift) line('  ✓ none — headers match linked accounts; account names unique');

// ---------- D. CREW REACH ----------
section('D. CREW REACH (visible accounts / my cleans / keys in scope)');
for (const u of crew) {
  const vis = visibleFor(u);
  const visNames = new Set([...vis].map((id) => norm(clientById.get(id)?.name)).filter(Boolean));
  const myJobs = jobs.filter(jobMine(u)).length;
  const myKeys = keys.filter(keyInScopeFor(u, vis, visNames)).length;
  const zero = vis.size === 0;
  line(`  ${zero ? '✗' : '·'} ${u.name}  — accounts:${vis.size}  cleans:${myJobs}  keys:${myKeys}${zero ? '   ← SEES NOTHING (no standing-crew or job anywhere)' : ''}`);
}
const anyCrewVis = new Set();
crew.forEach((u) => visibleFor(u).forEach((id) => anyCrewVis.add(id)));
const keyedInvisible = [...new Set(keys.map((k) => k.clientId).filter(Boolean))]
  .filter((cid) => !anyCrewVis.has(cid)).map((cid) => clientById.get(cid)?.name || cid);
line(`\n  Accounts WITH keys that NO crew member can see (${keyedInvisible.length}):`);
keyedInvisible.forEach((n) => line(`    - ${n}`));

// ---------- E. RENDER HAZARDS (CREW_AUDIT needs-live-data) ----------
section('E. RENDER HAZARDS FROM CREW_AUDIT (checked against live data)');
let haz = 0;
const nullLife = contacts.filter((c) => !c.lifecycle);
if (nullLife.length) { haz++; line(`  ✗ ${nullLife.length} contact(s) with NULL lifecycle (N5 white-screen class): ${nullLife.map((c) => `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id).join(', ')}`); }
for (const si of sites) {
  if (!si.siteContactId) continue;
  const ct = contactById.get(si.siteContactId);
  if (ct && si.clientId && ct.companyId !== si.clientId) {
    haz++;
    line(`  ✗ site "${si.name}" (${clientById.get(si.clientId)?.name}) has site contact "${ct.firstName} ${ct.lastName}" from a DIFFERENT company (${clientById.get(ct.companyId)?.name || 'none'}) — crew at this site get "Contact not found" when they tap the name`);
  }
}
const emails = new Map();
users.forEach((u) => { const e = norm(u.email); if (!e) return; emails.set(e, (emails.get(e) || []).concat(u.name)); });
for (const [e, arr] of emails) if (arr.length > 1) { haz++; line(`  ✗ duplicate user email ${e}: ${arr.join(' | ')} (sync.js identity match is ambiguous — silent lockout risk)`); }
const caseDiff = users.filter((u) => u.email && u.email !== u.email.toLowerCase());
if (caseDiff.length) { haz++; line(`  ✗ ${caseDiff.length} user email(s) stored with uppercase letters (check sync.js case handling): ${caseDiff.map((u) => u.email).join(', ')}`); }
if (!haz) line('  ✓ none fire on current data');

console.log(`\norg_state v${snap.version} — ${clients.length} accounts · ${sites.length} sites · ${contacts.length} contacts · ${keys.length} keys · ${jobs.length} jobs · ${users.length} users (${crew.length} active crew)`);
out.forEach((l) => console.log(l));
console.log('');
