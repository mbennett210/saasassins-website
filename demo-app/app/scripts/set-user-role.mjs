// Change a team member's role on LIVE production — BOTH places, in lockstep.
//
// WHY THIS SCRIPT EXISTS (Increment 1b/1c, 2026-07-19): role now lives in two
// places and they must never diverge.
//   • org_state.users[].role  — what the CLIENT UI renders from.
//   • auth app_metadata.role  — the TRUST ROOT; what every server gate
//                               authorizes against (authz.resolveAuthority).
// The claim WINS. So editing the blob alone silently does nothing to real
// authority, and editing the claim alone leaves the UI lying about it.
//
// The in-app path (Settings → Team, which calls POST /api/settings/users/claims)
// requires claim-backed authority: a Super Admin, or a holder of "Assign roles to
// staff" within the owner's limits (nobody changes their own role, a Super Admin
// neither; only a Super Admin makes or unmakes one; _lib/teamAuthority.js). That is
// deliberate — it stops blob-derived authority laundering into a permanent signed
// claim — but it means the FIRST owner, or a locked-out owner, can only be set from
// here, with the service role.
//
//   node scripts/set-user-role.mjs --email someone@x.com --role owner
//   node scripts/set-user-role.mjs --email someone@x.com --role owner --apply
//
// Dry-run by default. Backs up the whole blob before writing. CAS-guarded on
// org_state.version (single-shot: on conflict it aborts and you re-run — it
// never blind-retries over someone else's concurrent write). Idempotent.
//
// EXIT CODE: 0 = done / nothing to do / a dry run, 1 = refused or failed. Once the client
// has talked to both Auth and the database, process.exit() trips a libuv assertion on
// Windows (Node 24) and the process dies with a meaningless code, so the run ends by
// returning its code (process.exitCode) instead (as backfill-jwt-claims.mjs does).
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { ROLES, isLastOwner } from '../src/lib/roles.js';

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

const argOf = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const EMAIL = (argOf('email') || '').trim().toLowerCase();
const ROLE = (argOf('role') || '').trim();
// The app's role list itself (as _lib/claims.js VALID_ROLES), never a copy: a copy
// without `manager` made this refuse the 4th tier for ten days (fixed 2026-09-23).
const VALID_ROLES = ROLES;
const ORG = process.env.FORMS_ORG_ID || '00000000-0000-0000-0000-000000000001';

if (!EMAIL) { console.error('--email is required'); process.exit(1); }
if (!VALID_ROLES.includes(ROLE)) { console.error(`--role must be one of ${VALID_ROLES.join(' | ')}`); process.exit(1); }

const norm = (s) => (s || '').trim().toLowerCase();

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 1. read the blob ──────────────────────────────────────────────────────
  const { data: snap, error: readErr } = await db
    .from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
  if (readErr) { console.error('org_state read failed:', readErr.message); return 1; }
  if (!snap?.state) { console.error('org_state not initialized.'); return 1; }

  const state = snap.state;
  const users = Array.isArray(state.users) ? state.users : [];
  const idx = users.findIndex((u) => norm(u.email) === EMAIL);
  if (idx < 0) { console.error(`No team member with email ${EMAIL}.`); return 1; }
  const target = users[idx];

  // ── 2. read the claim ─────────────────────────────────────────────────────
  let authUser = null;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('listUsers failed:', error.message); return 1; }
    const found = (data?.users || []).find((u) => norm(u.email) === EMAIL);
    if (found) { authUser = found; break; }
    if ((data?.users || []).length < 200) break;
  }

  const claimRole = authUser?.app_metadata?.role ?? null;
  const owners = users.filter((u) => u.role === 'owner');

  console.log(`\norg_state v${snap.version} · ${users.length} team members · ${owners.length} owner(s)`);
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (no writes)'} — role change\n`);
  console.log(`  member       : ${target.name} <${target.email}>  [${target.id}]`);
  console.log(`  blob role    : ${target.role}  ->  ${ROLE}${target.role === ROLE ? '   (already correct)' : ''}`);
  console.log(`  claim role   : ${claimRole ?? '(none)'}  ->  ${ROLE}${claimRole === ROLE ? '   (already correct)' : ''}`);
  console.log(`  auth login   : ${authUser ? authUser.id : 'MISSING — no Supabase login for this email'}`);
  console.log(`  other owners : ${owners.filter((u) => u.id !== target.id).map((u) => u.email).join(', ') || '(none)'}`);

  // ── 3. safety: never strand the org without an owner ──────────────────────
  // Only a Super Admin can make another, so removing the last owner is
  // unrecoverable from the UI — it would take another run of this script to undo.
  // Refuse it outright (lib/roles isLastOwner, the app's own rule).
  if (isLastOwner(users, target.id) && ROLE !== 'owner') {
    console.error('\nREFUSED: this is the last owner. Demoting them would leave nobody able to assign roles.\n');
    return 1;
  }
  if (!authUser) {
    console.error('\nREFUSED: no Supabase login for this email, so the trust-root claim cannot be set.');
    console.error('Create the login first (Settings → Team), then re-run.\n');
    return 1;
  }

  const blobNeedsChange = target.role !== ROLE;
  const claimNeedsChange = claimRole !== ROLE;
  if (!blobNeedsChange && !claimNeedsChange) {
    console.log('\nNothing to do — both places already agree.\n');
    return 0;
  }
  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Re-run with --apply to execute.\n');
    return 0;
  }

  // ── 4. backup the whole blob BEFORE any write ─────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `orgstate-backup-${stamp}.json`;
  writeFileSync(new URL(`./${backupName}`, import.meta.url), JSON.stringify({ version: snap.version, state }));
  console.log(`\nBackup written: app/scripts/${backupName}`);

  // ── 5. claim FIRST, then blob ─────────────────────────────────────────────
  // Order matters. The claim is the authority, so setting it first means the
  // window of inconsistency is "server already allows it, UI hasn't caught up" —
  // a strictly safer shape than "UI offers actions the server will 403". And if
  // the blob write then loses its CAS race, the operator re-runs and only the
  // blob step repeats (the claim step is idempotent).
  if (claimNeedsChange) {
    const { error } = await db.auth.admin.updateUserById(authUser.id, {
      app_metadata: { role: ROLE, org_user_id: target.id, org_id: ORG },
    });
    if (error) { console.error('claim update failed:', error.message); return 1; }
    console.log(`  ✓ claim  ${claimRole ?? '(none)'} -> ${ROLE}`);
  }

  if (blobNeedsChange) {
    const nextUsers = users.map((u, i) => (i === idx ? { ...u, role: ROLE } : u));
    const { data: wrote, error } = await db
      .from('org_state')
      .update({
        state: { ...state, users: nextUsers },
        version: (snap.version || 0) + 1,
        updated_at: new Date().toISOString(),
        updated_via: 'script', // distinct from 'browser'/'server' so the 1e gate query stays meaningful
      })
      .eq('organization_id', ORG).eq('version', snap.version)
      .select('version');
    if (error) { console.error('blob write failed:', error.message); return 1; }
    if (!wrote || wrote.length !== 1) {
      console.error(`\nCAS CONFLICT: org_state moved off v${snap.version} while this ran.`);
      console.error('The CLAIM is already updated (idempotent). Just re-run this script to finish the blob half.\n');
      return 1;
    }
    console.log(`  ✓ blob   ${target.role} -> ${ROLE}   (org_state v${snap.version} -> v${snap.version + 1})`);
  }

  // ── 6. verify BOTH places by re-reading ───────────────────────────────────
  const { data: after } = await db
    .from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
  const afterRole = (after?.state?.users || []).find((u) => norm(u.email) === EMAIL)?.role ?? null;
  const { data: afterAuth } = await db.auth.admin.getUserById(authUser.id);
  const afterClaim = afterAuth?.user?.app_metadata?.role ?? null;

  const ok = afterRole === ROLE && afterClaim === ROLE;
  console.log(`\nverify — blob: ${afterRole} · claim: ${afterClaim} · agree: ${ok ? 'YES' : 'NO'}`);
  if (!ok) { console.error('\nMISMATCH after write — re-run to reconcile.\n'); return 1; }
  console.log(`\n✓ ${target.name} is now ${ROLE}.`);
  console.log('  Server gates honour this IMMEDIATELY (getClaims does a live auth.getUser read).');
  console.log('  The UI reads the blob, so an open tab picks it up on its next sync/refresh.\n');
  return 0;
}

process.exitCode = await main();
