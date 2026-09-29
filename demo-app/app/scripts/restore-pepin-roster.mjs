// One-time data-op: restore the MISSING roster row for david.pepin11@gmail.com.
//
// What happened (verified 2026-07-29 by scripts/diag-login.mjs):
//   Adding a team member is TWO writes that are not atomic, and they run in this
//   order — (1) POST /api/settings/users → Supabase Auth account + JWT claims,
//   server-side and durable; then (2) dispatch ADD_USER → the `users` slice of the
//   shared org_state blob, client-side and subject to CAS contention. On
//   2026-07-27T18:28:37Z the FIRST write landed and the SECOND never did:
//     • auth account 5e274469-a108-4952-9c09-5009088eaacb exists, confirmed,
//       carrying app_metadata { org_user_id: 'u_ms3k8t4oiup4y', role: 'admin' }
//     • that id appears NOWHERE in org_state, and no users[] row matches /pepin/i
//   So he has a login and no team record: invisible on Settings → Team, and
//   therefore impossible to grant an access level to. Re-inviting through the UI
//   cannot fix it either — createUserAccount calls auth.admin.createUser, which
//   rejects an email that is already registered.
//
// The fix is the missing half, nothing else: insert the users[] row using the
// org user id ALREADY STAMPED IN HIS JWT. Minting a fresh u_* id instead would
// leave the claim (the trust root every server gate reads) pointing at a user
// that does not exist. No auth write happens here — the claim is already correct.
//
// Idempotent, full backup before write, CAS-guarded.
//   node scripts/restore-pepin-roster.mjs --dry-run
//   node scripts/restore-pepin-roster.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// seed.js can't be `import`ed here — it uses extensionless specifiers that Vite
// resolves and bare Node does not. So read the CURRENT default prefs out of the
// source instead of hand-copying 18 booleans that would silently drift from it.
// Fails closed: if the literal can't be parsed, the script stops rather than
// writing a member whose notification prefs are quietly wrong.
function readDefaultNotificationPrefs() {
  const src = readFileSync(new URL('../src/data/seed.js', import.meta.url), 'utf8');
  const m = src.match(/export const DEFAULT_NOTIFICATION_PREFS = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error('Could not locate DEFAULT_NOTIFICATION_PREFS in src/data/seed.js');
  const prefs = {};
  // Strip CR before the comment strip: `.` never matches \r, so on a CRLF file
  // `//.*$` silently fails to strip a trailing comment and that key is dropped.
  for (const line of m[1].split('\n')) {
    const kv = line.replace(/\r/g, '').replace(/\/\/.*$/, '').match(/^\s*([A-Za-z0-9_]+)\s*:\s*(true|false)\s*,?\s*$/);
    if (kv) prefs[kv[1]] = kv[2] === 'true';
  }
  // The count is asserted against the literal's own key lines, so a dropped key
  // (the CRLF trap above) is caught rather than shipped as a missing pref.
  const declared = m[1].split('\n').filter((l) => /^\s*[A-Za-z0-9_]+\s*:\s*(true|false)\s*,?/.test(l)).length;
  if (Object.keys(prefs).length !== declared) {
    throw new Error(`Parsed ${Object.keys(prefs).length} prefs but seed.js declares ${declared} — refusing to guess.`);
  }
  if (declared < 10) throw new Error(`Only ${declared} prefs found in seed.js — literal shape changed.`);
  return prefs;
}
const DEFAULT_NOTIFICATION_PREFS = readDefaultNotificationPrefs();

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
const EMAIL = 'david.pepin11@gmail.com';
const NAME = 'David Pepin';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const norm = (s) => (s || '').trim().toLowerCase();

// ── 1. The auth account is the source of truth for id + role. Read it, don't assume.
let auth = null;
for (let page = 1; page < 50; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
  const users = data?.users || [];
  const found = users.find((u) => norm(u.email) === EMAIL);
  if (found) { auth = found; break; }
  if (users.length < 200) break;
}
if (!auth) {
  console.error(`No Supabase Auth account for ${EMAIL}. This script repairs a HALF-created member;`);
  console.error('with no login there is nothing orphaned — add them normally via Settings → Team.');
  process.exit(1);
}
const claimUid = auth.app_metadata?.org_user_id || null;
const claimRole = auth.app_metadata?.role || null;
if (!claimUid || !claimRole) {
  console.error(`Auth account ${auth.id} carries no org_user_id/role claim (${JSON.stringify(auth.app_metadata)}).`);
  console.error('Refusing to guess an id — a roster row that disagrees with the claim is worse than none.');
  process.exit(1);
}

// ── 2. Read the live blob.
const { data: snap, error } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (error) { console.error('Read failed:', error.message); process.exit(1); }
if (!snap?.state) { console.error('org_state not initialized.'); process.exit(1); }
const state = snap.state;
const users = Array.isArray(state.users) ? state.users : [];

console.log(`\norg_state v${snap.version} — ${users.length} roster rows`);
console.log(`auth  ${auth.id}  claims { org_user_id: '${claimUid}', role: '${claimRole}' }`);

// ── 3. Idempotence: bail if EITHER key is already taken.
const byId = users.find((u) => u.id === claimUid);
const byEmail = users.find((u) => norm(u.email) === EMAIL);
if (byId || byEmail) {
  const hit = byId || byEmail;
  console.log(`\nAlready present: "${hit.name}" <${hit.email}> id=${hit.id} role=${hit.role} status=${hit.status}`);
  console.log('Nothing to change.\n');
  process.exit(0);
}

// ── 4. Build the row the way the reducer's ADD_USER would (seed.js shape), but
//      with the CLAIMED id, and createdAt = when the login was actually made.
const row = {
  id: claimUid,
  name: NAME,
  role: claimRole,
  email: EMAIL,
  phone: '',
  avatar: (users.length % 5) + 1,
  status: 'active',
  initials: NAME.split(' ').filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2),
  createdAt: auth.created_at,
  notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
};

console.log('\nWill append this users[] row:');
console.log(JSON.stringify({ ...row, notificationPrefs: `{…${Object.keys(row.notificationPrefs).length} default prefs}` }, null, 2));
console.log(`\nPredicted delta: users ${users.length} → ${users.length + 1} · org_state v${snap.version} → ${snap.version + 1}`);
console.log('No other slice is touched. No auth write — the claim already matches this row.');
if (DRY) { console.log('\n--dry-run: nothing written.\n'); process.exit(0); }

// ── 5. Backup, then CAS write.
const nowIso = new Date().toISOString();
const stamp = nowIso.replace(/[:.]/g, '-');
const backup = new URL(`./orgstate-backup-${stamp}.json`, import.meta.url);
writeFileSync(backup, JSON.stringify({ version: snap.version, state }));

const nextState = { ...state, users: [...users, row] };
const { data: wrote, error: wErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: nowIso })
  .eq('organization_id', ORG).eq('version', snap.version)
  .select('version');
if (wErr) { console.error('Write failed:', wErr.message); process.exit(1); }
if (!wrote || !wrote.length) { console.error('CAS conflict — someone else wrote first. Re-run.'); process.exit(1); }

console.log(`\n✓ Restored ${NAME} (${claimRole}). org_state v${snap.version} → ${wrote[0].version}.`);
console.log(`  Backup: app/scripts/orgstate-backup-${stamp}.json`);
console.log('\nNext, in the app: Settings → Team → David Pepin → Email password-reset link.');
console.log('His original invite link was almost certainly consumed by an email scanner');
console.log('(last_sign_in_at is 14s after account creation), so he needs a fresh one.\n');
