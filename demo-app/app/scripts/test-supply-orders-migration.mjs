// The supply ORDERS migration (S131, plan docs/plans/2026-10-14-supply-orders.md §2; brief S §1),
// STATIC — this suite never runs SQL. It pins the shape the route, the store and the deploy order
// rest on:
//   20261014120000_supply_orders.sql (applied BEFORE the deploy, additive, one transaction):
//     · order numbers: a sequence from 1001, `supply_requests.number` backfilled in creation order,
//       then defaulted from the sequence, required and unique per org; the sequence owned by the
//       column and usable by service_role;
//     · the per-line record: `fulfillment` (jsonb, an array) + `fulfillment_state` (pending /
//       partial / ready), whole or absent together, and an index for the queue's tabs;
//     · the old "sent record must be whole" check is REPLACED (a submit now stamps sent_at with no
//       sent quantities) by one that only keeps a legacy sent record whole;
//     · `supply_catalog.image_v` (a positive whole number, null = no image);
//     · two new tables, `supply_request_comments` and `supply_order_documents`, under the house law
//       (RLS on, no policies, anon/authenticated revoked, service_role's four verbs), each going
//       with its order (on delete cascade);
//     · a private bucket `supply-documents` with no storage policy;
//     · account_media's scope check gains `supply`;
//     · every column the store writes exists.
//
//   node app/scripts/test-supply-orders-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-service-role';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

let S = {};
try { S = await import('../src/lib/supplies.js'); } catch { S = {}; }
let store = {};
try { store = await import('../api/_lib/supplies/store.js'); } catch { store = {}; }
let docs = {};
try { docs = await import('../api/_lib/supplies/documents.js'); } catch { docs = {}; }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const NAME = '20261014120000_supply_orders.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
// Code only: line comments out, whitespace folded, lower case.
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const has = (re) => re.test(c);

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('an EXPAND, applied BEFORE THE DEPLOY', /^-- expand\|contract: expand/m.test(raw) && /APPLY THIS BEFORE THE DEPLOY/.test(raw));
ok('lock and statement timeouts', /set lock_timeout = '3s';/.test(raw) && /set statement_timeout = '60s';/.test(raw));
ok('one transaction: no CONCURRENTLY, no no-transaction marker, no begin/commit of its own (apply-migration wraps it)',
  !/concurrently/.test(c) && !/^-- apply: no-transaction/m.test(raw) && !has(/(^|;) ?begin;/) && !has(/(^|;) ?commit;/));
ok('it drops no column and no table', !has(/drop column/) && !has(/drop table/));

// ── 1. order numbers ──────────────────────────────────────────────────────────
ok('a sequence that starts at 1001', has(/create sequence if not exists public\.supply_request_number_seq start (with )?1001/));
ok('supply_requests.number bigint', has(/alter table public\.supply_requests add column if not exists number bigint/));
const backfill = c.indexOf('nextval(');
ok('🔴 the existing rows are numbered in creation order (created_at, then id) from the sequence',
  backfill >= 0 && has(/order by created_at, id/) && has(/update public\.supply_requests/));
const deflt = c.search(/alter column number set default nextval\('public\.supply_request_number_seq'/);
const notNull = c.search(/alter column number set not null/);
ok('🔴 then defaulted from the sequence and made required — AFTER the backfill',
  deflt > backfill && notNull > backfill);
ok('unique per org', has(/supply_requests_org_number_key unique \(organization_id, number\)/) || has(/unique index if not exists supply_requests_org_number_(key|idx) on public\.supply_requests \(organization_id, number\)/));
ok('the sequence is owned by the column', has(/alter sequence public\.supply_request_number_seq owned by public\.supply_requests\.number/));
ok('service_role may use the sequence (the default needs it)', has(/grant usage, select on sequence public\.supply_request_number_seq to service_role/));

// ── 2. the per-line record ────────────────────────────────────────────────────
ok('fulfillment jsonb, an array when present', has(/add column if not exists fulfillment jsonb/) && has(/jsonb_typeof\(fulfillment\) = 'array'/));
const m = c.match(/fulfillment_state in \(([^)]*)\)/);
const vocab = m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : [];
ok(`🔴 fulfillment_state's vocabulary is EXACTLY SUPPLY_FULFILLMENT_STATES (${vocab.join(', ') || 'none found'})`,
  Array.isArray(S.SUPPLY_FULFILLMENT_STATES) && vocab.length === S.SUPPLY_FULFILLMENT_STATES.length
  && S.SUPPLY_FULFILLMENT_STATES.every((s) => vocab.includes(s)));
ok('the record and its state are whole or absent together', has(/\(fulfillment is null\) = \(fulfillment_state is null\)/));
ok('an index for the queue\'s tabs: (organization_id, status, fulfillment_state, …)',
  has(/create index if not exists \w+ on public\.supply_requests \(organization_id, status, fulfillment_state/));
ok('🔴 the old whole-sent-record check is dropped (a submit stamps sent_at with no sent quantities)',
  has(/drop constraint if exists supply_requests_sent_whole/));
ok('… and a legacy sent record still stays whole and dated', has(/\(sent_lines is null\) = \(sent_total_cents is null\)/) && has(/sent_lines is null or sent_at is not null/));
ok('the status vocabulary is NOT redefined here (SUPPLY_STATUSES stays as it is)', !has(/supply_requests_status_check/));

// ── 3. the product image ──────────────────────────────────────────────────────
ok('supply_catalog.image_v: a positive whole number, null = no image',
  has(/alter table public\.supply_catalog add column if not exists image_v integer/) && has(/image_v is null or image_v > 0/));

// ── 4. comments and invoices ──────────────────────────────────────────────────
const table = (name) => {
  const i = c.indexOf(`create table if not exists public.${name}`);
  if (i < 0) return '';
  const j = c.indexOf(');', i);
  return c.slice(i, j + 2);
};
const comments = table('supply_request_comments');
ok('supply_request_comments exists', !!comments);
ok('… a caller-minted text id, the org, the order (cascade), the author snapshot, the body 1–1000, when',
  /id text primary key/.test(comments) && /organization_id uuid not null/.test(comments)
  && /request_id text not null references public\.supply_requests\(id\) on delete cascade/.test(comments)
  && /author_user_id text/.test(comments) && /author_role text/.test(comments) && /author_name text/.test(comments)
  && /body text not null check \(char_length\(body\) between 1 and 1000\)/.test(comments) && /created_at timestamptz not null default now\(\)/.test(comments));
ok('… read by order, oldest first', has(/create index if not exists \w+ on public\.supply_request_comments \(request_id, created_at\)/));
const documents = table('supply_order_documents');
ok('supply_order_documents exists', !!documents);
ok('… an invoice of PDF / JPEG / PNG up to 10 MB, kept with its order (cascade), the path the server built, who uploaded it',
  /id text primary key/.test(documents) && /request_id text not null references public\.supply_requests\(id\) on delete cascade/.test(documents)
  && /kind text not null check \(kind = 'invoice'\)/.test(documents) && /file_name text not null/.test(documents)
  && /mime_type text not null check \(mime_type in \('application\/pdf', 'image\/jpeg', 'image\/png'\)\)/.test(documents)
  && /size_bytes integer not null check \(size_bytes > 0 and size_bytes <= 10485760\)/.test(documents)
  && /storage_path text not null/.test(documents) && /uploaded_by_user_id text/.test(documents) && /uploader_name text/.test(documents));
ok('the store\'s limits ARE the table\'s (10 MB, the three types)',
  docs.SUPPLY_INVOICE_MAX_BYTES === 10485760 && Array.isArray(docs.SUPPLY_INVOICE_MIME)
  && ['application/pdf', 'image/jpeg', 'image/png'].every((t) => docs.SUPPLY_INVOICE_MIME.includes(t)) && docs.SUPPLY_INVOICE_MIME.length === 3);
for (const t of ['supply_request_comments', 'supply_order_documents']) {
  ok(`🔴 ${t}: RLS on, NO policy, anon/authenticated revoked, service_role cut to its four verbs`,
    has(new RegExp(`alter table public\\.${t} enable row level security`))
    && has(new RegExp(`revoke all on public\\.${t} from anon, authenticated`))
    && has(new RegExp(`revoke all on public\\.${t} from service_role`))
    && has(new RegExp(`grant select, insert, update, delete on public\\.${t} to service_role`)));
}
ok('no policy is created anywhere in the file', !has(/create policy/));

// ── 5. the private bucket ─────────────────────────────────────────────────────
ok('a PRIVATE supply-documents bucket, created only if absent',
  has(/insert into storage\.buckets \(id, name, public\) values \('supply-documents', 'supply-documents', false\) on conflict \(id\) do nothing/));
ok('its name is the store\'s', docs.SUPPLY_DOCUMENTS_BUCKET === 'supply-documents');

// ── 6. account_media gains the `supply` scope ─────────────────────────────────
// This file's own definition keeps the seven scopes before it and adds supply; and no LATER
// migration that redefines the check drops any of the eight (the last definition wins on the
// database — test-account-media-authz.mjs reads it the same way — and a later file may add a
// scope of its own: 20261017110000 adds the visitor's photo).
const SUPPLY_ERA_SCOPES = ['cleaning_instruction', 'inspection', 'problem_report', 'security', 'clean', 'checklist', 'client_ticket', 'supply'];
const scopeDefs = [];
for (const f of files) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  const mm = /account_media_scope_check[\s\S]{0,200}?check\s*\(\s*scope\s+in\s*\(([^)]*)\)/i.exec(src);
  if (mm) scopeDefs.push({ file: f, list: [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) });
}
const own = scopeDefs.find((d) => d.file === NAME) || null;
ok(`🔴 this file's scope check keeps every scope and adds supply (${own ? own.list.join(', ') : 'none'})`,
  !!own && SUPPLY_ERA_SCOPES.every((s) => own.list.includes(s)) && own.list.length === SUPPLY_ERA_SCOPES.length);
const later = scopeDefs.filter((d) => d.file > NAME);
ok(`… and no later definition drops one of them (${later.map((d) => d.file).join(', ') || 'none later'})`,
  later.every((d) => SUPPLY_ERA_SCOPES.every((s) => d.list.includes(s))));
ok('… dropped and re-added BY NAME', has(/alter table public\.account_media drop constraint if exists account_media_scope_check/));

// ── 7. the store writes only columns that exist ───────────────────────────────
const cols = store.REQUEST_PATCH_COLUMNS ? Object.values(store.REQUEST_PATCH_COLUMNS) : [];
ok(`🔴 the decision patch writes fulfillment + fulfillment_state, both added here (${cols.filter((x) => x.startsWith('fulfillment')).join(', ') || 'none'})`,
  cols.includes('fulfillment') && cols.includes('fulfillment_state'));

console.log(`\ntest-supply-orders-migration: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
