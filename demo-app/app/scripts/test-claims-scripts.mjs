// The two service-role claims scripts, run for real as child processes against the local
// fake GoTrue + PostgREST (fake-supabase-server.mjs), behind offline-fetch-guard.mjs so no
// request can leave the machine.
// backfill-jwt-claims.mjs, the tool of the 2026-09-23 data-op that stamps existing
// managers' claims:
//   • STAMP-ONLY: missing claims are filled; a present role or u_* id that differs from the
//     roster is left alone and reported (a roster row saying Manager must never demote a
//     login claiming Super Admin; that is set-user-role.mjs's job, with its last-owner check);
//   • one member per login: an id another login already claims is never stamped again;
//   • an email on two roster rows is skipped (which member it is would be a guess);
//   • --role scopes the run (both spellings), and a mistyped flag refuses BEFORE any read
//     instead of silently widening to a whole-roster run;
//   • a dry run writes nothing; --apply backs up first, then writes; a re-run is a no-op.
// set-user-role.mjs: takes `manager` (its role list was a copy without it) and still
// refuses to demote the last owner.
// Both: the exit code means something (0 done / 1 refused or failed). process.exit() after
// the client used Auth + the database died on a libuv assertion on Windows (Node 24).
//   node app/scripts/test-claims-scripts.mjs
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startFakeSupabase } from './fake-supabase-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORG = '00000000-0000-0000-0000-0000000fab13';
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const fake = await startFakeSupabase();
const roster = (email, role, id) => ({ id, role, status: 'active', name: email.split('@')[0], email });
const login = (email, md) => ({ id: randomUUID(), email, app_metadata: { provider: 'email', providers: ['email'], ...md }, user_metadata: {}, banned_until: null });
function world() {
  return {
    orgState: {
      organization_id: ORG,
      version: 3,
      state: {
        users: [
          roster('owner@cs.test', 'owner', 'u_owner'),
          roster('m1@cs.test', 'manager', 'u_m1'), // claim-less login → stamp
          roster('m2@cs.test', 'manager', 'u_m2'), // role claim, no id → stamp the id
          roster('m3@cs.test', 'manager', 'u_m3'), // login claims admin → conflict, untouched
          roster('m4@cs.test', 'manager', 'u_m4'), // login claims another id → conflict
          roster('m5new@cs.test', 'manager', 'u_m5'), // u_m5 is already claimed by m5old's login
          roster('m6@cs.test', 'manager', 'u_m6'),
          roster(' M6@cs.test', 'crew', 'u_m6b'), // the same email on a second row → skipped
          roster('c1@cs.test', 'crew', 'u_c1'), // claim-less crew: out of a manager-scoped run
          roster('boss@cs.test', 'manager', 'u_boss'), // login claims Super Admin: never demoted
          roster('m7@cs.test', 'manager', 'u_m7'), // no login: nothing to stamp
        ],
      },
    },
    authUsers: [
      login('owner@cs.test', { role: 'owner', org_user_id: 'u_owner', org_id: ORG }),
      login('m1@cs.test', {}),
      login('m2@cs.test', { role: 'manager' }),
      login('m3@cs.test', { role: 'admin', org_user_id: 'u_m3', org_id: ORG }),
      login('m4@cs.test', { role: 'manager', org_user_id: 'u_other', org_id: ORG }),
      login('m5new@cs.test', {}),
      login('m5old@cs.test', { role: 'manager', org_user_id: 'u_m5', org_id: ORG }),
      login('m6@cs.test', {}),
      login('c1@cs.test', {}),
      login('boss@cs.test', { role: 'owner', org_user_id: 'u_boss', org_id: ORG }),
    ],
  };
}

// A script, as the operator runs it, but pointed at the fake. Async: the fake answers
// from THIS process, so a blocking spawn would deadlock.
const backfill = (...args) => script('backfill-jwt-claims.mjs', ...args);
const setUserRole = (...args) => script('set-user-role.mjs', ...args);
function script(name, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(path.join(HERE, 'offline-fetch-guard.mjs')).href,
      path.join(HERE, name), ...args,
    ], {
      env: { ...process.env, SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', FORMS_ORG_ID: ORG, OFFLINE_ONLY_URL: fake.url },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const count = (out, label) => Number((out.match(new RegExp(`${label}[^:\\n]*: (\\d+)`)) || [])[1] ?? NaN);
const md = (email) => fake.db.authUsers.find((u) => u.email === email)?.app_metadata || {};
const snapshot = () => JSON.stringify(fake.db.authUsers);
const backups = [];
const cleanupBackups = (out) => {
  for (const m of out.matchAll(/Backup written: app\/scripts\/((?:jwt-claims|orgstate)-backup-[\w-]+\.json)/g)) {
    const f = path.join(HERE, m[1]);
    backups.push(f);
    if (existsSync(f)) unlinkSync(f);
  }
};

try {
  // ── dry runs write nothing ──────────────────────────────────────────────────────────
  for (const args of [['--role=manager'], ['--role', 'manager']]) {
    fake.reset(world());
    const before = snapshot();
    const r = await backfill(...args);
    const label = args.join(' ');
    ok(`dry run (${label}) exits 0 and is scoped to managers`, r.code === 0 && /SCOPED to roster role "manager"/.test(r.out));
    ok(`  (${label}) plans exactly the two claim-less managers`, count(r.out, 'to write') === 2 && /m1@cs\.test[\s\S]*m2@cs\.test/.test(r.out.split('DELTAS:')[1] || ''));
    ok(`  (${label}) leaves the 4 conflicting logins alone`, count(r.out, 'login claims another role or id') === 4);
    ok(`  (${label}) skips the email on two roster rows`, count(r.out, 'email on more than one team record') === 1);
    ok(`  (${label}) writes nothing`, snapshot() === before && fake.requests.every((q) => q.method === 'GET'));
  }
  fake.reset(world());
  let r = await backfill();
  ok('an unscoped dry run plans the claim-less crew too (3), still never the conflicts',
    r.code === 0 && count(r.out, 'to write') === 3 && count(r.out, 'login claims another role or id') === 4);
  ok('  ...and the login claiming Super Admin is NOT planned down to its roster role (Manager)',
    !/boss@cs\.test[^\n]*→/.test(r.out) && /boss@cs\.test \(claim role=owner/.test(r.out));
  ok('  ...nor is an id another login already claims stamped on a second login',
    !/m5new@cs\.test[^\n]*→/.test(r.out) && /m5new@cs\.test[^\n]*already claimed by another login/.test(r.out));

  // ── a mistyped scope refuses before touching anything ──────────────────────────────
  for (const bad of [['--rol', 'manager'], ['--role', 'boss'], ['--apply', '--scope=manager']]) {
    fake.reset(world());
    r = await backfill(...bad);
    ok(`"${bad.join(' ')}" refuses (exit 1) before any read`, r.code === 1 && fake.requests.length === 0);
  }

  // ── --apply stamps, backs up, verifies; a re-run is a no-op ─────────────────────────
  fake.reset(world());
  r = await backfill('--role', 'manager', '--apply');
  cleanupBackups(r.out);
  ok('--apply exits 0 after writing and verifying', r.code === 0 && /written: 2\/2/.test(r.out));
  ok('  ...backing up every login first', backups.length === 1);
  ok('  ...m1 now carries role + id + org, its provider bookkeeping kept',
    md('m1@cs.test').role === 'manager' && md('m1@cs.test').org_user_id === 'u_m1' && md('m1@cs.test').org_id === ORG && md('m1@cs.test').provider === 'email');
  ok('  ...m2 gained its id', md('m2@cs.test').role === 'manager' && md('m2@cs.test').org_user_id === 'u_m2');
  ok('  ...the conflicts are untouched (admin claim, other id, taken id, Super Admin)',
    md('m3@cs.test').role === 'admin' && md('m4@cs.test').org_user_id === 'u_other'
    && md('m5new@cs.test').org_user_id === undefined && md('boss@cs.test').role === 'owner');
  ok('  ...and out-of-scope logins too (claim-less crew)', md('c1@cs.test').role === undefined);
  r = await backfill('--role', 'manager', '--apply');
  cleanupBackups(r.out);
  ok('a second --apply has nothing to do (idempotent) and writes no backup', r.code === 0 && /Nothing to do/.test(r.out) && backups.length === 1);

  // ── set-user-role.mjs ────────────────────────────────────────────────────────────────
  fake.reset(world());
  r = await setUserRole('--email', 'c1@cs.test', '--role', 'manager');
  ok('set-user-role takes `manager` (dry run, exit 0, both places planned)',
    r.code === 0 && /claim role\s+: \(none\)\s+->\s+manager/.test(r.out) && /Dry run only/.test(r.out) && md('c1@cs.test').role === undefined);
  r = await setUserRole('--email', 'c1@cs.test', '--role', 'manager', '--apply');
  cleanupBackups(r.out);
  ok('  ...--apply sets the claim, then the roster, and verifies (exit 0)',
    r.code === 0 && md('c1@cs.test').role === 'manager'
    && fake.db.orgState.state.users.find((u) => u.email === 'c1@cs.test').role === 'manager');
  r = await setUserRole('--email', 'owner@cs.test', '--role', 'manager');
  ok('  ...and still refuses to demote the last owner (exit 1)', r.code === 1 && /REFUSED: this is the last owner/.test(r.out) && md('owner@cs.test').role === 'owner');
} finally {
  for (const f of backups) if (existsSync(f)) unlinkSync(f);
  await fake.close();
}

console.log(`\nclaims scripts: ${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
