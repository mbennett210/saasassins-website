// Increment 1b — backfill the JWT trust root onto existing Supabase logins.
//
// WHAT IT DOES: for every Supabase auth user that matches a team member in the
// live org_state blob, stamps `app_metadata = { role, org_user_id, org_id }`.
// That claim is service-role-writable ONLY, which is what makes it a tamper-
// proof trust root — unlike `users[].role` in the blob, which the browser can
// write directly under the open RLS policy (self-escalation proven live).
//
// IDEMPOTENT + STAMP-ONLY. Re-running is free: users already carrying the exact desired
// claims are skipped. It fills claims that are MISSING and nothing else: a login whose
// role or u_* id claim DIFFERS from the roster is reported as a conflict and left alone,
// because the roster is the browser-writable side and the claim is the trust root.
// Changing a role is set-user-role.mjs's job (claim first, then the blob, never the last
// owner); re-linking a login to another member's id is nobody's. An id another login
// already claims is a conflict too: two logins must never share one member. (Until
// 2026-09-23 a differing claim was overwritten from the roster; once `manager` became a
// claim role, a roster row saying Manager would have demoted a login claiming Super Admin.)
// NOT behaviour-neutral: every server gate reads these claims (Increment 1c), so a stamped
// login stops resolving its role and u_* id from the roster by email, and a stamped role
// is what the server enforces from the next request on.
//
// Any run skips an email that sits on more than one roster row: which member such a login
// is would be a guess (the server matches the FIRST row, this map the LAST).
//
// SAFETY: GoTrue MERGES app_metadata key-by-key rather than replacing the
// object, so Supabase's own `provider` / `providers` bookkeeping survives. The
// pre-apply backup captures every user's existing app_metadata regardless, so
// a revert is a mechanical replay of that file.
//
//   node scripts/backfill-jwt-claims.mjs                           # dry run — reports, writes NOTHING
//   node scripts/backfill-jwt-claims.mjs --apply                   # backs up, then writes
//   node scripts/backfill-jwt-claims.mjs --role manager [--apply]  # one roster role only
//
// --role <r> (or --role=<r>) scopes the run to members whose roster role is r. Built for
// the 2026-09-23 data-op: claims.js didn't know `manager` until then, so every manager's
// login was left claim-less by the original backfill. Any other argument is refused, so a
// mistyped scope can't silently become a whole-roster run.
//
// EXIT CODE: 0 = done (or a dry run), 1 = something failed or didn't verify. Once the
// client has talked to both Auth and the database, process.exit() trips a libuv
// assertion on Windows (Node 24) and the process dies with a meaningless code, so the run
// ends by returning its code (process.exitCode) instead. Checked offline by
// test-backfill-claims.mjs against the local fake.
//
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from app/.env.local.
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { ROLES } from '../src/lib/roles.js';

// The app's role list itself (the same list _lib/claims.js VALID_ROLES is), never a copy:
// a copy that said owner/admin/crew is why managers were left claim-less.
const VALID_ROLES = ROLES;
let APPLY = false;
let ONLY_ROLE = null;
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--apply') APPLY = true;
    else if (a === '--role') { ONLY_ROLE = (args[i + 1] || '').trim(); i += 1; }
    else if (a.startsWith('--role=')) ONLY_ROLE = a.slice('--role='.length).trim();
    else { console.error(`Unknown argument "${a}". Use --apply and/or --role <role>.`); process.exit(1); }
  }
}
if (ONLY_ROLE !== null && !VALID_ROLES.includes(ONLY_ROLE)) {
  console.error(`--role must be one of ${VALID_ROLES.join(' | ')}`);
  process.exit(1);
}

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

const ORG = process.env.FORMS_ORG_ID || '00000000-0000-0000-0000-000000000001';
const isOrgUserId = (v) => typeof v === 'string' && /^u_[A-Za-z0-9_]+$/.test(v);
const norm = (s) => (s || '').trim().toLowerCase();

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 1. the store roster (email → team record) ─────────────────────────────
  const { data: snap, error: readErr } = await db
    .from('org_state').select('state, version').eq('organization_id', ORG).maybeSingle();
  if (readErr) { console.error('org_state read failed:', readErr.message); return 1; }
  if (!snap?.state) { console.error('org_state not initialized.'); return 1; }

  const storeUsers = Array.isArray(snap.state.users) ? snap.state.users : [];
  const byEmail = new Map();
  const rowsPerEmail = new Map();
  for (const u of storeUsers) {
    if (!u?.email) continue;
    byEmail.set(norm(u.email), u);
    rowsPerEmail.set(norm(u.email), (rowsPerEmail.get(norm(u.email)) || 0) + 1);
  }

  // ── 2. every Supabase auth login ──────────────────────────────────────────
  const authUsers = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('listUsers failed:', error.message); return 1; }
    const batch = data?.users || [];
    authUsers.push(...batch);
    if (batch.length < 200) break;
  }

  // ── 3. classify ───────────────────────────────────────────────────────────
  const planned = [];   // needs a write
  const current = [];   // already correct
  const noRecord = [];  // auth login with no team record — left alone
  const badRole = [];   // team record with an unrecognized role — left alone
  const badId = [];     // team record whose u_* id the API would later reject
  const dupEmail = [];  // email on more than one roster row — which member is ambiguous
  const conflict = [];  // login claims another role / another id / an id another login holds — left alone
  let outOfScope = 0;   // --role: roster role is not the one asked for

  // Which logins already claim each u_* id: one member per login, one login per member.
  const idHolders = new Map();
  for (const au of authUsers) {
    const id = au.app_metadata?.org_user_id;
    if (typeof id === 'string' && id) idHolders.set(id, [...(idHolders.get(id) || []), au.id]);
  }

  for (const au of authUsers) {
    const rec = byEmail.get(norm(au.email));
    if (!rec) { noRecord.push(au.email); continue; }
    if ((rowsPerEmail.get(norm(au.email)) || 0) > 1) { dupEmail.push(`${au.email} (${rowsPerEmail.get(norm(au.email))} rows)`); continue; }
    if (!VALID_ROLES.includes(rec.role)) { badRole.push(`${au.email} (role="${rec.role}")`); continue; }
    if (ONLY_ROLE && rec.role !== ONLY_ROLE) { outOfScope += 1; continue; }
    // Same shape check the API enforces (_lib/claims.js isOrgUserId). Stamping an
    // id that fails it would create a claim no /settings/users route could ever
    // re-stamp — repairable only by re-running this script.
    if (!isOrgUserId(rec.id)) { badId.push(`${au.email} (id="${rec.id}")`); continue; }
    const md = au.app_metadata || {};
    // STAMP-ONLY: a claim that is present and differs is the trust root disagreeing with the
    // writable roster, never something to overwrite from it (see the header).
    const idTaken = (idHolders.get(rec.id) || []).some((holder) => holder !== au.id);
    if ((md.role != null && md.role !== rec.role) || (md.org_user_id != null && md.org_user_id !== rec.id) || idTaken) {
      conflict.push(`${au.email} (claim role=${md.role ?? '-'} org_user_id=${md.org_user_id ?? '-'} · roster role=${rec.role} id=${rec.id}`
        + `${idTaken ? ' · that id is already claimed by another login' : ''})`);
      continue;
    }
    const same = md.role === rec.role && md.org_user_id === rec.id && md.org_id === ORG;
    const entry = {
      authId: au.id,
      email: au.email,
      name: rec.name,
      from: { role: md.role ?? null, org_user_id: md.org_user_id ?? null, org_id: md.org_id ?? null },
      to: { role: rec.role, org_user_id: rec.id, org_id: ORG },
    };
    (same ? current : planned).push(entry);
  }

  const noLogin = storeUsers
    .filter((u) => u.email && !authUsers.some((a) => norm(a.email) === norm(u.email)))
    .map((u) => `${u.email} (${u.role}, ${u.status})`);

  // ── 4. report ─────────────────────────────────────────────────────────────
  console.log(`\norg_state version ${snap.version} · ${storeUsers.length} team records · ${authUsers.length} Supabase logins`);
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (no writes)'} — claim backfill, stamp-only${ONLY_ROLE ? ` · SCOPED to roster role "${ONLY_ROLE}"` : ''}\n`);

  const roleCount = planned.reduce((a, p) => { a[p.to.role] = (a[p.to.role] || 0) + 1; return a; }, {});
  console.log(`  to write : ${planned.length}${planned.length ? `  (${Object.entries(roleCount).map(([r, n]) => `${r}:${n}`).join(' · ')})` : ''}`);
  console.log(`  already correct : ${current.length}`);
  console.log(`  login with no team record (skipped) : ${noRecord.length}`);
  console.log(`  email on more than one team record (skipped) : ${dupEmail.length}`);
  console.log(`  team record with unknown role (skipped) : ${badRole.length}`);
  console.log(`  team record with malformed u_* id (skipped) : ${badId.length}`);
  if (ONLY_ROLE) console.log(`  other roster roles (out of scope) : ${outOfScope}`);
  console.log(`  login claims another role or id, or an id another login holds (left alone) : ${conflict.length}`);
  console.log(`  team record with no login (nothing to stamp) : ${noLogin.length}`);

  if (planned.length) {
    console.log('\n  DELTAS:');
    for (const p of planned) {
      const f = p.from.role === null && p.from.org_user_id === null ? '(no claims)' : `role=${p.from.role} org_user_id=${p.from.org_user_id}`;
      console.log(`    ${p.email.padEnd(38)} ${f}  →  role=${p.to.role} org_user_id=${p.to.org_user_id}`);
    }
  }
  if (noRecord.length) { console.log('\n  LOGINS WITH NO TEAM RECORD (left untouched):'); for (const e of noRecord) console.log(`    ${e}`); }
  if (dupEmail.length) { console.log('\n  EMAILS ON MORE THAN ONE TEAM RECORD (left untouched):'); for (const e of dupEmail) console.log(`    ${e}`); }
  if (conflict.length) { console.log('\n  CONFLICTING CLAIMS (left untouched; set-user-role.mjs changes a role):'); for (const e of conflict) console.log(`    ${e}`); }
  if (badRole.length) { console.log('\n  UNKNOWN ROLES (left untouched):'); for (const e of badRole) console.log(`    ${e}`); }
  if (badId.length) { console.log('\n  MALFORMED IDS (left untouched):'); for (const e of badId) console.log(`    ${e}`); }
  if (noLogin.length) { console.log('\n  TEAM RECORDS WITH NO LOGIN:'); for (const e of noLogin) console.log(`    ${e}`); }

  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Re-run with --apply to execute.\n');
    return 0;
  }
  if (!planned.length) { console.log('\nNothing to do.\n'); return 0; }

  // ── 5. back up every login's existing app_metadata, then write ────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = new URL(`./jwt-claims-backup-${stamp}.json`, import.meta.url);
  writeFileSync(backupPath, JSON.stringify({
    takenAt: new Date().toISOString(),
    orgStateVersion: snap.version,
    users: authUsers.map((u) => ({ id: u.id, email: u.email, app_metadata: u.app_metadata || {} })),
  }, null, 2));
  console.log(`\nBackup written: app/scripts/jwt-claims-backup-${stamp}.json (${authUsers.length} logins)\n`);

  let ok = 0;
  const failed = [];
  for (const p of planned) {
    const { error } = await db.auth.admin.updateUserById(p.authId, { app_metadata: p.to });
    if (error) { failed.push(`${p.email}: ${error.message}`); continue; }
    ok += 1;
    console.log(`  ✓ ${p.email.padEnd(38)} role=${p.to.role}`);
  }

  // ── 6. verify by re-reading ───────────────────────────────────────────────
  // The re-read must be COMPLETE or the assertions below are vacuous: both checks
  // are filters over `verify`, so a short read would silently report "0 lost".
  const verify = [];
  let verifyComplete = true;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { verifyComplete = false; console.log(`  ! verify read failed on page ${page}: ${error.message}`); break; }
    const batch = data?.users || [];
    verify.push(...batch);
    if (batch.length < 200) break;
  }
  if (verifyComplete && verify.length < authUsers.length) verifyComplete = false;

  const stillWrong = planned.filter((p) => {
    const au = verify.find((v) => v.id === p.authId);
    const md = au?.app_metadata || {};
    return !(md.role === p.to.role && md.org_user_id === p.to.org_user_id && md.org_id === ORG);
  });
  const providerLost = verify.filter((v) => {
    const before = authUsers.find((a) => a.id === v.id)?.app_metadata || {};
    return before.provider && !(v.app_metadata || {}).provider;
  });

  console.log(`\nwritten: ${ok}/${planned.length} · failed: ${failed.length} · verified-wrong-after-write: ${stillWrong.length}`);
  console.log(verifyComplete
    ? `provider bookkeeping preserved: ${providerLost.length === 0 ? 'yes (0 lost)' : `NO — ${providerLost.length} lost`}`
    : `provider bookkeeping: UNVERIFIED — the re-read was incomplete (${verify.length}/${authUsers.length}). Re-run to confirm.`);
  for (const f of failed) console.log(`  ✗ ${f}`);
  for (const s of stillWrong) console.log(`  ✗ verify failed: ${s.email}`);
  console.log('');
  return failed.length || stillWrong.length || providerLost.length || !verifyComplete ? 1 : 0;
}

process.exitCode = await main();
