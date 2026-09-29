// CS-002 — STATIC check of the crew read-split migration (never runs SQL). Pins the policy
// names, the office-role predicate, idempotency (every create is preceded by a matching
// drop-if-exists), the transaction, and a rollback block — so a hand-edit can't silently
// break the shape the apply step (and the report's pre-apply check) rely on.
//
//   node app/scripts/test-crew-read-split-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const dir = new URL('../../supabase/migrations/', import.meta.url);
const file = readdirSync(dir).find((f) => /_cs002_crew_read_split\.sql$/.test(f));
ok('migration file exists', !!file);
const raw = file ? readFileSync(new URL(file, dir), 'utf8').replace(/\r\n/g, '\n') : '';
const sql = raw.replace(/--.*$/gm, ''); // strip line comments (the rollback lives in comments)

// transactional
ok('begins a transaction', /\bbegin;/.test(sql));
ok('commits the transaction', /\bcommit;/.test(sql));

// org_state: office-only read replaces the open read
ok('org_state: drops the open read policy', /drop policy if exists "auth read org_state" on public\.org_state;/.test(sql));
ok('org_state: creates an office read policy', /create policy "office read org_state"[\s\S]*?for select to authenticated/.test(sql));

// jobs: office OR own-assigned read
ok('jobs: drops the open read policy', /drop policy if exists "auth read jobs" on public\.jobs;/.test(sql));
ok('jobs: creates a scoped read policy', /create policy "scoped read jobs"[\s\S]*?for select to authenticated/.test(sql));
ok('jobs: crew clause uses data->crewIds containment of org_user_id',
  /\(data -> 'crewIds'\) \? \(auth\.jwt\(\) -> 'app_metadata' ->> 'org_user_id'\)/.test(sql));

// office-role predicate (exact lowercase set, no defaulting — the realtime_scoped_rls pattern)
ok("office-role set ('owner','admin','manager') present",
  /\(auth\.jwt\(\) -> 'app_metadata' ->> 'role'\) in \('owner', 'admin', 'manager'\)/.test(sql));

// marketing-attachments: 4 open policies dropped, 4 office policies created
for (const op of ['insert', 'read', 'update', 'delete']) {
  ok(`marketing-attachments: drops open ${op}`, new RegExp(`drop policy if exists "auth ${op} marketing attachments" on storage\\.objects;`).test(sql));
  ok(`marketing-attachments: creates office ${op}`, new RegExp(`create policy "office ${op} marketing attachments"`).test(sql));
}

// org_state_signal / job_deletes: NOT touched (left open, deliberately)
ok('org_state_signal read policy NOT altered', !/policy[^\n]*org_state_signal/i.test(sql));
ok('job_deletes read policy NOT altered', !/policy[^\n]*job_deletes/i.test(sql));

// idempotency: every CREATE POLICY has a matching DROP POLICY IF EXISTS for the same name
const created = [...sql.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
const dropped = new Set([...sql.matchAll(/drop policy if exists "([^"]+)"/g)].map((m) => m[1]));
ok('created at least the 6 read/storage policies', created.length >= 6);
for (const name of created) ok(`idempotent: "${name}" is dropped-if-exists before create`, dropped.has(name));

// a rollback block (in comments — restores the open read policies)
ok('has a ROLLBACK block', /ROLLBACK/i.test(raw));
ok('rollback restores the open org_state read', /create policy "auth read org_state"/.test(raw));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
