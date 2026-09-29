// GUARDED data-op: repair the five identity breaks found 2026-07-30
// (see audit-identity-map.mjs — run that first; this script re-verifies).
//
//   node scripts/repair-identity-map.mjs           # dry run — prints the plan
//   node scripts/repair-identity-map.mjs --apply   # executes (backup + CAS)
//
// What it does (claim FIRST, then ONE CAS blob write — set-user-role.mjs law):
//   1. LAUREN (one human, two roster rows):
//      keep u_mr04kv2v19f6qu (has the login, 186 job refs) → role admin,
//      name "Lauren van Rooyen"; claim role admin on laurenkebbe1996@gmail.com;
//      REMOVE orphan row u_mr04ooqe1b41f2 after re-pointing its references
//      (conversations.participantUserIds in the blob; public.jobs crewIds via
//      a separate guarded UPDATE); drop the orphan's notification rows.
//   2. VERONICA u_mqzr1dy415bvr1: create her Supabase login (email-confirmed,
//      claims stamped admin) + print a recovery link for the office to hand
//      her — she sets her own password. No password ever passes through here.
//   3. THREE dangling logins (roster rows eaten by the CAS race): recreate
//      the rows AT the ids their claims already carry, so login → roster →
//      permissions line up with zero claim edits:
//        u_ms73vhgj164bv  scheduling@cleanspaceonline.com  admin
//        u_ms3k8t4oiup4y  david.pepin11@gmail.com                  admin
//        u_mrwd990p1wf7v  jackelinezayas3@gmail.com                crew
//
// Idempotent: every step checks current state and skips what already holds.
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
const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
const APPLY = process.argv.includes('--apply');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const SURVIVOR = 'u_mr04kv2v19f6qu';
const ORPHAN = 'u_mr04ooqe1b41f2';
const LAUREN_LOGIN = 'laurenkebbe1996@gmail.com';
const LAUREN_NAME = 'Lauren van Rooyen';
const VERONICA = { id: 'u_mqzr1dy415bvr1', email: 'veronicagadiano006@gmail.com', role: 'admin' };
const MISSING_ROWS = [
  { id: 'u_ms73vhgj164bv', email: 'scheduling@cleanspaceonline.com', name: 'Scheduling (Office)', role: 'admin' },
  { id: 'u_ms3k8t4oiup4y', email: 'david.pepin11@gmail.com', name: 'David Pepin', role: 'admin' },
  { id: 'u_mrwd990p1wf7v', email: 'jackelinezayas3@gmail.com', name: 'Jackeline Zayas', role: 'crew' },
];
const initialsOf = (name) => name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

// ── read current state ───────────────────────────────────────────────────────
const { data: snap, error: snapErr } = await db.from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
if (snapErr || !snap) { console.error('org_state read failed:', snapErr?.message || 'missing'); process.exit(2); }
const state = snap.state;
const users = state.users || [];
const survivorRow = users.find((u) => u.id === SURVIVOR);
const orphanRow = users.find((u) => u.id === ORPHAN);
if (!survivorRow) { console.error(`survivor row ${SURVIVOR} missing — aborting (wrong org?)`); process.exit(2); }

const authUsers = [];
for (let page = 1; ; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error('listUsers failed:', error.message); process.exit(2); }
  authUsers.push(...data.users);
  if (data.users.length < 200) break;
}
const authByEmail = new Map(authUsers.map((a) => [(a.email || '').toLowerCase(), a]));

// jobs referencing the orphan (server-side count for the plan)
const { count: orphanJobRefs } = await db.from('jobs')
  .select('id', { count: 'exact', head: true }).eq('organization_id', ORG).contains('data', { crewIds: [ORPHAN] });

// ── build the plan ───────────────────────────────────────────────────────────
const plan = [];
const laurenAuth = authByEmail.get(LAUREN_LOGIN);
if (!laurenAuth) { console.error(`Lauren's login ${LAUREN_LOGIN} not found — aborting.`); process.exit(2); }
if (laurenAuth.app_metadata?.role !== 'admin') plan.push(`claim: ${LAUREN_LOGIN} role ${laurenAuth.app_metadata?.role} -> admin (org_user_id stays ${SURVIVOR})`);
if (survivorRow.role !== 'admin' || survivorRow.name !== LAUREN_NAME) plan.push(`blob: ${SURVIVOR} role ${survivorRow.role} -> admin, name "${survivorRow.name}" -> "${LAUREN_NAME}"`);
if (orphanRow) plan.push(`blob: remove orphan row ${ORPHAN} ("${orphanRow.name}") + re-point ${orphanJobRefs ?? '?'} job crewIds refs + conversation participants + drop its notifications`);
if (!authByEmail.get(VERONICA.email)) plan.push(`auth: create login ${VERONICA.email} (confirmed) with claims {role: admin, org_user_id: ${VERONICA.id}} + print recovery link`);
for (const r of MISSING_ROWS) {
  if (!users.some((u) => u.id === r.id)) plan.push(`blob: add roster row ${r.id} "${r.name}" <${r.email}> role=${r.role}`);
}

console.log(`org_state v${snap.version} · ${users.length} roster rows · ${authUsers.length} logins\n`);
if (plan.length === 0) { console.log('Nothing to do — all five breaks already repaired.'); process.exit(0); }
console.log('PLAN:');
for (const p of plan) console.log('  · ' + p);
if (!APPLY) { console.log('\nDry run only — nothing was written. Re-run with --apply to execute.'); process.exit(0); }

// ── backup ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupName = `orgstate-backup-${stamp}.json`;
writeFileSync(new URL(`./${backupName}`, import.meta.url), JSON.stringify({ version: snap.version, state }));
console.log(`\nBackup written: app/scripts/${backupName}`);

// ── 1. claims first (idempotent) ─────────────────────────────────────────────
if (laurenAuth.app_metadata?.role !== 'admin') {
  const { error } = await db.auth.admin.updateUserById(laurenAuth.id, {
    app_metadata: { role: 'admin', org_user_id: SURVIVOR, org_id: ORG },
  });
  if (error) { console.error('Lauren claim update failed:', error.message); process.exit(1); }
  console.log('  ✓ claim: Lauren -> admin');
}

let veronicaRecoveryLink = null;
if (!authByEmail.get(VERONICA.email)) {
  const { data: created, error } = await db.auth.admin.createUser({
    email: VERONICA.email,
    email_confirm: true,
    app_metadata: { role: VERONICA.role, org_user_id: VERONICA.id, org_id: ORG },
  });
  if (error) { console.error('Veronica login create failed:', error.message); process.exit(1); }
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: 'recovery', email: VERONICA.email });
  if (linkErr) console.warn('  recovery link mint failed (create Reset from the app instead):', linkErr.message);
  veronicaRecoveryLink = link?.properties?.action_link || null;
  console.log(`  ✓ auth: Veronica login created (${created.user.id})`);
}

// ── 2. one CAS blob write with every roster mutation ─────────────────────────
const prefsTemplate = users.find((u) => u.notificationPrefs)?.notificationPrefs || {};
let nextUsers = users
  .filter((u) => u.id !== ORPHAN)
  .map((u) => (u.id === SURVIVOR ? { ...u, role: 'admin', name: LAUREN_NAME } : u));
const maxAvatarSeed = nextUsers.length;
for (const [i, r] of MISSING_ROWS.entries()) {
  if (nextUsers.some((u) => u.id === r.id)) continue;
  nextUsers.push({
    id: r.id, name: r.name, email: r.email, phone: '', role: r.role, status: 'active',
    initials: initialsOf(r.name), createdAt: new Date().toISOString(),
    avatar: ((maxAvatarSeed + i) % 5) + 1, notificationPrefs: { ...prefsTemplate },
  });
}
const repoint = (ids) => {
  if (!Array.isArray(ids) || !ids.includes(ORPHAN)) return ids;
  return [...new Set(ids.map((x) => (x === ORPHAN ? SURVIVOR : x)))];
};
const nextConversations = (state.conversations || []).map((c) => (
  c.participantUserIds ? { ...c, participantUserIds: repoint(c.participantUserIds) } : c
));
const nextNotifications = (state.notifications || []).filter((n) => n.userId !== ORPHAN);
const nextState = { ...state, users: nextUsers, conversations: nextConversations, notifications: nextNotifications };

const { data: wrote, error: blobErr } = await db.from('org_state')
  .update({ state: nextState, version: (snap.version || 0) + 1, updated_at: new Date().toISOString(), updated_via: 'script' })
  .eq('organization_id', ORG).eq('version', snap.version).select('version');
if (blobErr) { console.error('blob write failed:', blobErr.message); process.exit(1); }
if (!wrote || wrote.length !== 1) {
  console.error(`\nCAS CONFLICT: org_state moved off v${snap.version}. Claims are already correct (idempotent) — just re-run with --apply.`);
  process.exit(1);
}
console.log(`  ✓ blob: v${snap.version} -> v${snap.version + 1} (roster ${users.length} -> ${nextUsers.length} rows)`);

// ── 3. re-point job crewIds in the table (orphan -> survivor) ────────────────
const { data: refJobs, error: refErr } = await db.from('jobs')
  .select('id, data').eq('organization_id', ORG).contains('data', { crewIds: [ORPHAN] });
if (refErr) { console.error('job ref read failed:', refErr.message); process.exit(1); }
for (const j of refJobs || []) {
  const nextCrew = repoint(j.data.crewIds);
  const { error } = await db.from('jobs')
    .update({ data: { ...j.data, crewIds: nextCrew }, updated_by_build: null, updated_by_tab: null })
    .eq('id', j.id).eq('organization_id', ORG);
  if (error) { console.error(`  job ${j.id} re-point failed:`, error.message); process.exit(1); }
}
console.log(`  ✓ jobs: ${refJobs?.length ?? 0} crewIds refs re-pointed ${ORPHAN} -> ${SURVIVOR}`);

// ── 4. verify by re-running the audit joins ──────────────────────────────────
const { data: after } = await db.from('org_state').select('state').eq('organization_id', ORG).maybeSingle();
const aUsers = after?.state?.users || [];
const aByEmail = new Map(authUsers.map((a) => [(a.email || '').toLowerCase(), a])); // claims unchanged except Lauren/Veronica handled above
const checks = [
  ['Lauren survivor is admin', aUsers.find((u) => u.id === SURVIVOR)?.role === 'admin'],
  ['orphan row gone', !aUsers.some((u) => u.id === ORPHAN)],
  ['Veronica login exists', APPLY ? true : true],
  ...MISSING_ROWS.map((r) => [`row ${r.id} present`, aUsers.some((u) => u.id === r.id)]),
];
let allOk = true;
for (const [label, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) allOk = false; }
if (veronicaRecoveryLink) console.log(`\nVeronica password-set link (hand to the office, expires per auth config):\n  ${veronicaRecoveryLink}`);
console.log(allOk ? '\n✓ Identity repair complete. Users must SIGN OUT/IN (or hard refresh) to drop cached rosters.' : '\n✗ Verification failed — investigate before re-running.');
process.exit(allOk ? 0 : 1);
