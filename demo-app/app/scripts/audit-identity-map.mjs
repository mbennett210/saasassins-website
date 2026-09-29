// READ-ONLY identity audit: every Supabase auth login ↔ org_state roster row,
// joined BOTH ways (claim org_user_id AND email), with a diagnosis per break.
//
// The two authority sources can split (2026-07-30 incident: 5 broken
// identities — orphan admin roster rows with no login, and logins whose
// claims point at roster rows a CAS race reverted away). The UI resolves
// identity by EMAIL (withSession), the server by CLAIM org_user_id — a break
// on either axis makes a user's app and their permissions disagree, or
// renders an empty app (no roster match → currentUserId null → can() false).
//
//   node scripts/audit-identity-map.mjs
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (reads .env.local).
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
const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: doc, error: docErr } = await db.from('org_state').select('state').eq('organization_id', ORG).maybeSingle();
if (docErr || !doc) { console.error('org_state read failed:', docErr?.message || 'missing'); process.exit(2); }
const roster = (doc.state.users || []).map((u) => ({ id: u.id, name: u.name, email: (u.email || '').toLowerCase(), role: u.role, status: u.status }));

// admin.listUsers pages at 50 by default — walk all pages.
const logins = [];
for (let page = 1; ; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('listUsers failed:', error.message); process.exit(2); }
  for (const au of data.users) {
    logins.push({
      email: (au.email || '').toLowerCase(),
      role: au.app_metadata?.role ?? null,
      orgUserId: au.app_metadata?.org_user_id ?? null,
      lastLogin: au.last_sign_in_at ? au.last_sign_in_at.slice(0, 10) : null,
    });
  }
  if (data.users.length < 200) break;
}

const byClaim = new Map(logins.filter((l) => l.orgUserId).map((l) => [l.orgUserId, l]));
const byEmail = new Map(logins.map((l) => [l.email, l]));
const rosterIds = new Set(roster.map((r) => r.id));
const rosterEmails = new Set(roster.map((r) => r.email));

let broken = 0;
console.log(`roster: ${roster.length} rows (${roster.filter((r) => r.status === 'active').length} active) · logins: ${logins.length}\n`);

console.log('── roster rows with identity breaks ──');
for (const r of roster.filter((x) => x.status === 'active')) {
  const claimLogin = byClaim.get(r.id);
  const emailLogin = byEmail.get(r.email);
  if (!claimLogin && !emailLogin) { broken++; console.log(`  ✗ NO LOGIN         ${r.id}  ${r.name} <${r.email}> role=${r.role} — user cannot act at their role (server sees no claims)`); continue; }
  if (!claimLogin && emailLogin) { broken++; console.log(`  ✗ CLAIM ELSEWHERE  ${r.id}  ${r.name} — login ${emailLogin.email} claims org_user_id=${emailLogin.orgUserId ?? 'NONE'} role=${emailLogin.role}`); continue; }
  if (claimLogin.role !== r.role) { broken++; console.log(`  ✗ ROLE SPLIT       ${r.id}  ${r.name} — blob=${r.role} claim=${claimLogin.role} (UI shows one, server enforces the other)`); }
}

console.log('\n── logins with no (or dangling) roster identity ──');
for (const l of logins) {
  const claimHit = l.orgUserId && rosterIds.has(l.orgUserId);
  const emailHit = rosterEmails.has(l.email);
  if (!claimHit && !emailHit) { broken++; console.log(`  ✗ EMPTY APP        ${l.email} — claim role=${l.role} org_user_id=${l.orgUserId ?? 'NONE'} (${l.orgUserId ? 'dangling id' : 'no claim'}), no roster email match, last login ${l.lastLogin ?? 'never'}`); }
  else if (!claimHit && l.orgUserId) { broken++; console.log(`  ✗ DANGLING CLAIM   ${l.email} — org_user_id=${l.orgUserId} not in roster (email match ${emailHit ? 'saves the UI only' : 'absent'})`); }
}

console.log(`\nidentity map: ${broken === 0 ? 'CLEAN' : `${broken} break(s)`}`);
process.exit(broken ? 1 : 0);
