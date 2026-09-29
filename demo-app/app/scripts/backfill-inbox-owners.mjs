// Assign inbox_accounts.owner_user_id — AUTHORIZATION_AUDIT.md §2026-07-20 #2.
//
// ⚠️ NOT RUN BY THE LOOP. Requires 20260720100000_inbox_owner.sql to be APPLIED
//    first (it is UNAPPLIED — LOOP_REVIEW.md §1).
//
//   node scripts/backfill-inbox-owners.mjs                          # report only (default)
//   node scripts/backfill-inbox-owners.mjs --set <inboxId>=<u_id>   # stage one mapping
//   node scripts/backfill-inbox-owners.mjs --set ... --apply        # write it
//   node scripts/backfill-inbox-owners.mjs --clear <inboxId> --apply# unclaim (back to open)
//
// THIS SCRIPT DELIBERATELY DOES NOT GUESS. Every other backfill in this repo derives
// its values from somewhere; this one cannot, and inventing a mapping here would
// hand a real person's Gmail to whoever the heuristic happened to pick. A read-only
// probe of production found:
//
//     inbox_accounts                        2  (jasmin@, amanda@ cleanspaceonline.com)
//     matching auth.users by email          0 / 2   — the logins are on other domains
//     org_state.connectedInboxes[]          0 rows  — the blob's ownership model is EMPTY
//
// So it reports what it can see and asks for the mapping explicitly. An unmapped
// mailbox stays NULL, which the route treats exactly as today (requireAuth only) —
// so doing nothing is safe, and doing it wrong is not.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const { createClient } = await import('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const sets = [];
let clear = null;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--set' && process.argv[i + 1]) {
    const [id, uid] = process.argv[i + 1].split('=');
    if (!id || !uid) { console.error(`--set wants <inboxId>=<u_id>, got "${process.argv[i + 1]}"`); process.exit(1); }
    sets.push({ id, uid });
  }
  if (process.argv[i] === '--clear' && process.argv[i + 1]) clear = process.argv[i + 1];
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── preflight: is the column even there? ──────────────────────────────────
const probe = await db.from('inbox_accounts').select('owner_user_id').limit(1);
if (probe.error) {
  console.error(`\n✗ inbox_accounts.owner_user_id is ABSENT (${probe.error.code}).`);
  console.error('  Apply supabase/migrations/20260720100000_inbox_owner.sql first.\n');
  process.exit(1);
}

const { data: accounts, error: ae } = await db
  .from('inbox_accounts').select('id, email, status, owner_user_id').order('email');
if (ae) { console.error('read failed:', ae.message); process.exit(1); }

const { data: org } = await db.from('org_state').select('state').limit(1).maybeSingle();
const users = Array.isArray(org?.state?.users) ? org.state.users : [];
const blobInboxes = Array.isArray(org?.state?.connectedInboxes) ? org.state.connectedInboxes : [];
const { data: authList } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
const authByEmail = new Map((authList?.users || []).map((u) => [String(u.email || '').toLowerCase(), u]));

console.log(`\ninbox_accounts: ${accounts.length}   org users: ${users.length}   blob connectedInboxes: ${blobInboxes.length}\n`);
console.log('mailbox'.padEnd(46), 'owner_user_id'.padEnd(24), 'evidence');
console.log('-'.repeat(110));
for (const a of accounts) {
  // Both candidate sources, shown side by side so the human can judge rather than
  // trust. `blob` is browser-writable and NOT authoritative — it is displayed as a
  // hint, never applied automatically.
  const viaAuth = authByEmail.get(String(a.email || '').toLowerCase());
  const claimId = viaAuth?.app_metadata?.org_user_id || null;
  const viaBlob = blobInboxes.find((i) => i.id === a.id)?.userId || null;
  const evidence = [
    claimId ? `auth-claim:${claimId}` : 'auth-claim:none',
    viaBlob ? `blob(untrusted):${viaBlob}` : 'blob:none',
  ].join('  ');
  console.log(`${a.email.padEnd(46)} ${String(a.owner_user_id || '(unclaimed)').padEnd(24)} ${evidence}`);
}

const unclaimed = accounts.filter((a) => !a.owner_user_id);
if (unclaimed.length) {
  console.log(`\n${unclaimed.length} mailbox(es) unclaimed — each still behaves exactly as before #2 (requireAuth only).`);
  console.log('Map one explicitly:  --set <inboxId>=<u_id>   (ids above / org_state users[].id)\n');
}

if (!sets.length && !clear) process.exit(0);

// ── staged changes ────────────────────────────────────────────────────────
const known = new Set(users.map((u) => u.id));
for (const { id, uid } of sets) {
  const acct = accounts.find((a) => a.id === id);
  if (!acct) { console.error(`✗ no inbox_accounts row with id "${id}"`); process.exit(1); }
  if (!known.has(uid)) { console.error(`✗ "${uid}" is not an org_state users[].id — refusing to write an owner nobody can be`); process.exit(1); }
  console.log(`${APPLY ? 'APPLY' : 'DRY  '}  ${acct.email}  ${acct.owner_user_id || '(unclaimed)'} -> ${uid}`);
}
if (clear) {
  const acct = accounts.find((a) => a.id === clear);
  if (!acct) { console.error(`✗ no inbox_accounts row with id "${clear}"`); process.exit(1); }
  console.log(`${APPLY ? 'APPLY' : 'DRY  '}  ${acct.email}  ${acct.owner_user_id || '(unclaimed)'} -> NULL (unclaim)`);
}

if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.\n'); process.exit(0); }

for (const { id, uid } of sets) {
  const { error } = await db.from('inbox_accounts').update({ owner_user_id: uid }).eq('id', id);
  if (error) { console.error(`✗ write failed for ${id}: ${error.message}`); process.exit(1); }
}
if (clear) {
  const { error } = await db.from('inbox_accounts').update({ owner_user_id: null }).eq('id', clear);
  if (error) { console.error(`✗ clear failed: ${error.message}`); process.exit(1); }
}

// Read back — a write that reports success without verifying is not a data-op.
const { data: after } = await db.from('inbox_accounts').select('id, email, owner_user_id').order('email');
console.log('\nafter:');
for (const a of after) console.log(`  ${a.email.padEnd(46)} ${a.owner_user_id || '(unclaimed)'}`);
console.log('\n✓ done. Each claimed mailbox now refuses send/test from anyone else.\n');
