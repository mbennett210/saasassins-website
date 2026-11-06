// The scale indexes (S128 round 2: CS-677, CS-676, CS-729), STATIC — this suite never runs SQL.
// It pins the shape the reads rest on:
//   20261013120000_jobs_and_checklist_scale_indexes.sql (applied BEFORE the deploy, additive):
//     · jobs_crew_ids_gin — GIN (jsonb_ops) on the EXPRESSION data->'crewIds', and the cleaner's
//       read (api/_lib/jobsTable getCrewJobRows) filters exactly that expression; jsonb_path_ops
//       would serve `@>` but not the RLS policy's `?`;
//     · jobs_org_series_master_idx — partial on `(data ->> 'recurrence') is not null`, the very
//       filter the office launch's series-master read sends (src/store/jobsSync fetchSeriesMasters),
//       ordered by id for its keyset;
//     · checklist_results_org_performed_idx — (organization_id, performed_at, id), the org-wide
//       checklist window's order (api/_lib/qc/store listChecklistsInWindow) and, read backwards,
//       the Quality hub's newest-first list (listChecklists; pinned in test-scale-complete-reads).
// The SQL itself was rehearsed with EXPLAIN on PGlite and Postgres 17.5 (the builder's report).
//
//   node app/scripts/test-scale-indexes-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const dir = new URL('../../supabase/migrations/', import.meta.url);
const NAME = '20261013120000_jobs_and_checklist_scale_indexes.sql';
const raw = readdirSync(dir).includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
// Code only: line comments out (the forward-fix lives in comments), whitespace folded.
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase().trim();
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('lock and statement timeouts', /set lock_timeout = '3s';/.test(raw) && /set statement_timeout = '60s';/.test(raw));
ok('no CONCURRENTLY (it runs in one transaction)', !/concurrently/.test(c));
ok('an EXPAND applied BEFORE the deploy', /^-- expand\|contract: expand/m.test(raw) && /BEFORE THE DEPLOY/i.test(raw));
// Every statement is a timeout or an idempotent index build: no table, column, policy, grant or row change.
const statements = c.split(';').map((s) => s.trim()).filter(Boolean);
ok(`🔴 indexes only — every statement is \`create index if not exists\` (${statements.length} statements)`,
  statements.length === 5 && statements.every((s) => /^set (lock|statement)_timeout = /.test(s) || /^create index if not exists /.test(s)));
ok('the forward-fix drops each index by name', ['jobs_crew_ids_gin', 'jobs_org_series_master_idx', 'checklist_results_org_performed_idx']
  .every((n) => new RegExp(`^-- .*drop index if exists public\\.${n};`, 'm').test(raw)));

// ── 1. a cleaner's cleans (CS-677) ────────────────────────────────────────────
ok('🔴 jobs_crew_ids_gin: GIN on the expression data -> \'crewIds\'',
  c.includes("create index if not exists jobs_crew_ids_gin on public.jobs using gin ((data -> 'crewids'))"));
ok('…with the default jsonb_ops (serves `@>` and the RLS policy\'s `?`), never jsonb_path_ops', !/jsonb_path_ops/.test(c));
const jobsTable = src('../api/_lib/jobsTable.js');
const crewRead = (jobsTable.match(/export async function getCrewJobRows[\s\S]*?\n\}/) || [])[0] || '';
ok('🔴 getCrewJobRows filters that same expression (`data->crewIds`), the form the index serves',
  /\.contains\('data->crewIds', JSON\.stringify\(\[userId\]\)\)/.test(crewRead));
ok('…never the whole-document containment no index served', !/\.contains\('data', \{ crewIds/.test(crewRead));
ok('…over the jobs window, keyset by id', /\.gte\('start_at', fromIso\)/.test(crewRead) && /\.lt\('start_at', toIso\)/.test(crewRead)
  && /\.gt\('id', after\)/.test(crewRead) && !/\.range\(/.test(crewRead));

// ── 2. every series' master (CS-676) ──────────────────────────────────────────
ok('🔴 jobs_org_series_master_idx: (organization_id, id), partial on a recurrence',
  c.includes("create index if not exists jobs_org_series_master_idx on public.jobs (organization_id, id) where ((data ->> 'recurrence') is not null)"));
const jobsSync = src('../src/store/jobsSync.js');
const masters = (jobsSync.match(/export async function fetchSeriesMasters\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
ok('🔴 fetchSeriesMasters sends exactly that predicate (`data->>recurrence` not null), keyset by id',
  /readById\(\(q\) => q\.not\('data->>recurrence', 'is', null\)\)/.test(masters));
const byId = (jobsSync.match(/async function readById\([\s\S]*?\n\}/) || [])[0] || '';
ok('…and readById pages by `id > last`, ordered by id, never OFFSET', /\.gt\('id', /.test(byId) && /\.order\('id'/.test(byId) && !/\.range\(/.test(byId));

// ── 3. the org-wide checklist window (CS-729) ─────────────────────────────────
ok('🔴 checklist_results_org_performed_idx: (organization_id, performed_at, id)',
  c.includes('create index if not exists checklist_results_org_performed_idx on public.checklist_results (organization_id, performed_at, id)'));
const qcStore = src('../api/_lib/qc/store.js');
const windowRead = (qcStore.match(/export async function listChecklistsInWindow[\s\S]*?\n\}/) || [])[0] || '';
ok('listChecklistsInWindow orders by (performed_at, id) inside the organization — the index order',
  /\.order\('performed_at', \{ ascending: true \}\)\.order\('id', \{ ascending: true \}\)/.test(windowRead)
  && /out = q\.eq\('organization_id', CLEANSPACE_ORG_ID\)/.test(qcStore));

console.log(`\ntest-scale-indexes-migration: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
