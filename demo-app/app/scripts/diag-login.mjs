// READ-ONLY login diagnosis. Creates/modifies NOTHING.
// Cross-references the live org_state roster (users[]) against Supabase Auth
// (auth.users) to explain why a given person can't log in. A login needs BOTH:
//   1) a Supabase Auth account for their email, confirmed, not banned, and
//   2) a matching users[] row in org_state (email match, case-insensitive) so
//      the app can map the session → identity + role (see store/sync.js).
//
// Run from app/:  node scripts/diag-login.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* next */ }
}
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const ORG = '00000000-0000-0000-0000-000000000001';
const norm = (s) => (s || '').trim().toLowerCase();
const db = createClient(url, key, { auth: { persistSession: false } });

// 1) Live roster from org_state
const { data: snap, error: e1 } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (e1) { console.error('org_state read failed:', e1.message); process.exit(1); }
const roster = (snap?.state?.users || []).filter((u) => !u.deleted);
console.log(`org_state v${snap.version} — ${roster.length} roster users\n`);

// 2) All Supabase Auth users (paginate)
const authByEmail = new Map();
for (let page = 1; page < 50; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
  const users = data?.users || [];
  for (const u of users) authByEmail.set(norm(u.email), u);
  if (users.length < 200) break;
}
console.log(`Supabase Auth — ${authByEmail.size} accounts total\n`);

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
const rows = [];
for (const u of roster) {
  const a = authByEmail.get(norm(u.email));
  rows.push({
    name: u.name, email: u.email, role: u.role,
    auth: a ? 'YES' : 'MISSING',
    confirmed: a ? (a.email_confirmed_at ? 'yes' : 'NO') : '—',
    lastSignIn: a ? fmt(a.last_sign_in_at) : '—',
    banned: a && a.banned_until ? `BANNED→${fmt(a.banned_until)}` : '',
  });
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('NAME', 22) + pad('EMAIL', 40) + pad('ROLE', 7) + pad('AUTH', 9) + pad('CONF', 6) + pad('LAST SIGN-IN', 18) + 'FLAGS');
console.log('-'.repeat(110));
for (const r of rows.sort((a, b) => (a.auth === b.auth ? 0 : a.auth === 'MISSING' ? -1 : 1))) {
  console.log(pad(r.name, 22) + pad(r.email, 40) + pad(r.role, 7) + pad(r.auth, 9) + pad(r.confirmed, 6) + pad(r.lastSignIn, 18) + r.banned);
}

// 3) Targeted callout
console.log('\n=== TARGETED: Liz & Bernice ===');
for (const needle of ['liz', 'bernice']) {
  const u = roster.find((x) => norm(x.name).includes(needle) || norm(x.email).includes(needle));
  if (!u) { console.log(`  ${needle}: NOT in roster`); continue; }
  const a = authByEmail.get(norm(u.email));
  console.log(`  ${u.name} <${u.email}> role=${u.role}`);
  if (!a) { console.log(`     → NO Supabase Auth account. Cannot authenticate. Needs account creation / invite.`); continue; }
  console.log(`     → Auth account EXISTS. confirmed=${a.email_confirmed_at ? 'yes' : 'NO'} lastSignIn=${fmt(a.last_sign_in_at)} created=${fmt(a.created_at)} banned=${a.banned_until ? fmt(a.banned_until) : 'no'}`);
  if (a.email && norm(a.email) !== norm(u.email)) console.log(`     → EMAIL MISMATCH auth<${a.email}> vs roster<${u.email}>`);
}

// 4) Summary counts
const missing = rows.filter((r) => r.auth === 'MISSING');
const unconfirmed = rows.filter((r) => r.auth === 'YES' && r.confirmed === 'NO');
const neverSignedIn = rows.filter((r) => r.auth === 'YES' && r.lastSignIn === '—');
console.log(`\n=== SUMMARY ===`);
console.log(`  roster users with NO auth account : ${missing.length}`);
if (missing.length) for (const r of missing) console.log(`      • ${r.name} <${r.email}> (${r.role})`);
console.log(`  auth accounts unconfirmed         : ${unconfirmed.length}`);
if (unconfirmed.length) for (const r of unconfirmed) console.log(`      • ${r.name} <${r.email}>`);
console.log(`  auth accounts never signed in     : ${neverSignedIn.length}`);
if (neverSignedIn.length) for (const r of neverSignedIn) console.log(`      • ${r.name} <${r.email}>`);

// 5) Auth accounts with NO roster row (would authenticate but land with no identity)
const rosterEmails = new Set(roster.map((u) => norm(u.email)));
const orphanAuth = [...authByEmail.values()].filter((a) => !rosterEmails.has(norm(a.email)));
console.log(`  auth accounts with NO roster row  : ${orphanAuth.length}`);
if (orphanAuth.length) for (const a of orphanAuth) console.log(`      • <${a.email}> confirmed=${a.email_confirmed_at ? 'yes' : 'NO'} lastSignIn=${fmt(a.last_sign_in_at)}`);
