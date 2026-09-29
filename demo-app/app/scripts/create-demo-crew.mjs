// Provision the permanent "Demo Crew" login — a read-only-feeling crew account
// the client can always sign in with to see exactly what a field user sees.
// Idempotent on both halves:
//   1. Supabase auth user — created email-confirmed with a set password (no real
//      mailbox / verification needed). Re-running resets the password, re-confirms
//      the email, and lifts any ban so the login is always usable.
//   2. org_state user record — a `crew` row matched to that email (the sync layer
//      maps the signed-in email → this row to assign the role). Re-running updates
//      the existing row in place instead of duplicating it.
//
// The demo-crew PASSWORD is read from the environment (DEMO_CREW_PASSWORD),
// never hardcoded — this is the LIVE login this script SETS, so no credential is
// committed. Set it in the shell or in app/.env.local (loaded below); the script
// exits with a clear message if it is unset.
//
//   DEMO_CREW_PASSWORD=… node scripts/create-demo-crew.mjs --dry-run   # report only, write nothing
//   DEMO_CREW_PASSWORD=… node scripts/create-demo-crew.mjs             # provision against the live org
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Load env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + DEMO_CREW_PASSWORD) from app/.env.local.
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ORG = process.env.VITE_CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
const DRY = process.argv.includes('--dry-run');

// The demo identity — kept in lockstep with the seed record in src/data/seed.js
// (id seedId('u','crewdemo') === 'u_seed_crewdemo'). The email is pinned to the
// seed (a correctness constraint, not a secret); the password comes from the
// environment (DEMO_CREW_PASSWORD) so no live credential is committed.
const DEMO = {
  id: 'u_seed_crewdemo',
  name: 'Demo Crew',
  email: 'crew.demo@cleanspaceonline.com',
  password: process.env.DEMO_CREW_PASSWORD,
  role: 'crew',
  initials: 'DC',
  avatar: 4,
};
if (!DEMO.password) {
  console.error('Missing DEMO_CREW_PASSWORD — set it in the environment or app/.env.local before running this script.');
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in app/.env.local'); process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── 1. Supabase auth user ────────────────────────────────────────────────────
async function findAuthUser(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((u) => (u.email || '').toLowerCase() === target);
    if (found) return found;
    if (users.length < 200) break;
  }
  return null;
}

async function ensureAuthUser() {
  const existing = await findAuthUser(DEMO.email);
  if (DRY) {
    console.log(existing
      ? `auth: would RESET password + re-confirm + unban ${DEMO.email} (id ${existing.id})`
      : `auth: would CREATE ${DEMO.email} (email-confirmed, password set)`);
    return;
  }
  // app_metadata carries the JWT trust root (Increment 1b) — service-role-only,
  // so it's the tamper-proof source of role, unlike the blob's users[].role.
  const claims = { role: DEMO.role, org_user_id: DEMO.id, org_id: ORG };
  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, {
      password: DEMO.password, email_confirm: true, ban_duration: 'none', app_metadata: claims,
    });
    if (error) throw error;
    console.log(`auth: ✓ updated ${DEMO.email} (password reset, email confirmed, unbanned, claims stamped).`);
  } else {
    const { error } = await db.auth.admin.createUser({
      email: DEMO.email, password: DEMO.password, email_confirm: true, app_metadata: claims,
    });
    if (error) throw error;
    console.log(`auth: ✓ created ${DEMO.email} (email-confirmed, password set, claims stamped).`);
  }
}

// ── 2. org_state crew record ─────────────────────────────────────────────────
async function ensureOrgUser() {
  const { data: snap, error } = await db.from('org_state')
    .select('state, version').eq('organization_id', ORG).maybeSingle();
  if (error) throw error;
  if (!snap?.state) { console.error('org_state not initialized — log into the app once, then re-run.'); process.exit(1); }

  const state = snap.state;
  const users = Array.isArray(state.users) ? state.users : [];
  const idx = users.findIndex((u) => (u.email || '').toLowerCase() === DEMO.email.toLowerCase());

  // Clone prefs shape from an existing user so the row matches the live schema.
  const template = users[0] || {};
  const baseRow = {
    id: DEMO.id, name: DEMO.name, email: DEMO.email, phone: '',
    role: DEMO.role, status: 'active', avatar: DEMO.avatar, initials: DEMO.initials,
    createdAt: new Date().toISOString(),
    ...(template.notificationPrefs ? { notificationPrefs: { ...template.notificationPrefs } } : {}),
    ...(template.signaturePrefs ? { signaturePrefs: { ...template.signaturePrefs } } : {}),
  };

  let nextUsers;
  if (idx >= 0) {
    const cur = users[idx];
    if (cur.role === DEMO.role && cur.status === 'active') {
      console.log(`org_state: ✓ "${DEMO.name}" already present as active crew (no change).`);
      return;
    }
    nextUsers = users.map((u, i) => (i === idx ? { ...u, role: DEMO.role, status: 'active' } : u));
    if (DRY) { console.log(`org_state: would FIX existing "${DEMO.name}" → active crew.`); return; }
  } else {
    nextUsers = [...users, baseRow];
    if (DRY) { console.log(`org_state: would ADD "${DEMO.name}" as active crew (id ${DEMO.id}).`); return; }
  }

  const { data: w, error: wErr } = await db.from('org_state')
    .update({ state: { ...state, users: nextUsers }, version: (snap.version || 0) + 1, updated_at: new Date().toISOString() })
    .eq('organization_id', ORG).eq('version', snap.version).select('version');
  if (wErr) throw wErr;
  if (!w || w.length !== 1) { console.error('org_state: version moved under us (someone saved first) — re-run.'); process.exit(1); }
  console.log(`org_state: ✓ ${idx >= 0 ? 'updated' : 'added'} "${DEMO.name}" (version ${snap.version} → ${snap.version + 1}).`);
}

await ensureAuthUser();
await ensureOrgUser();
console.log(DRY ? '\n--dry-run: nothing written.' : `\n✓ Demo Crew login ready: ${DEMO.email}`);
