// The delivery step's migration (Matt, SUP-16 a + SUP-17 a, 2026-10-12; plan 2026-10-12 §2), STATIC
// — this suite never runs SQL. It pins the shape the route and the deploy order rest on:
//   20261012100000_supply_delivery_step.sql (applied BEFORE the deploy, additive):
//     · the status check gains `sent` — the old INLINE check found in the catalog by its
//       definition and dropped (a guessed name that missed would leave it refusing every send),
//       then re-added under a name, its vocabulary EXACTLY lib/supplies SUPPLY_STATUSES;
//     · the sent record: sent_at, sent_by_user_id, sender_name, sent_lines (jsonb, an array, null
//       until sent) and sent_total_cents (integer cents, what went out — the budget's spend);
//     · a sent row is dated, and the record is whole or absent (never half a send);
//     · every column the store's decision patch writes exists.
// The SQL itself was rehearsed on a fixture in an in-process Postgres (the builder's report).
// It was APPLIED to production on 2026-10-12 (22:49Z), so this file is history and stays as it is.
// S131's 20261014120000_supply_orders.sql later drops `supply_requests_sent_whole` for the looser
// `supply_requests_sent_record` (a submit to the supplier now stamps sent_at with NO sent
// quantities, which the old check would refuse); that file's own pins are in
// test-supply-orders-migration.mjs. The checks below read only the 2026-10-12 file.
//
//   node app/scripts/test-supply-delivery-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-service-role';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const S = await import('../src/lib/supplies.js');
let store = {};
try { store = await import('../api/_lib/supplies/store.js'); } catch { store = {}; }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir);
const NAME = '20261012100000_supply_delivery_step.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
// Code only: line comments out (the forward-fix lives in comments), whitespace folded.
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const has = (re) => re.test(c);

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('lock and statement timeouts', /set lock_timeout = '3s';/.test(raw) && /set statement_timeout = '60s';/.test(raw));
ok('no CONCURRENTLY (it runs in one transaction)', !/concurrently/.test(c));
ok('an EXPAND applied BEFORE the deploy: it drops no column and makes nothing required',
  /^-- expand\|contract: expand/m.test(raw) && /BEFORE THE DEPLOY/i.test(raw) && !has(/drop column/) && !has(/set not null/));
ok('it never rewrites an existing row (no UPDATE or DELETE of supply_requests)', !has(/update public\.supply_requests/) && !has(/delete from public\.supply_requests/));

// ── 1. the status vocabulary gains `sent` ─────────────────────────────────────
ok('🔴 the old inline status check is found BY ITS DEFINITION in the catalog and dropped (never a guessed name)',
  has(/from pg_constraint/) && has(/conrelid = 'public\.supply_requests'::regclass/) && has(/contype = 'c'/)
  && has(/pg_get_constraintdef\(/) && has(/execute format\('alter table public\.supply_requests drop constraint %i'/));
const m = c.match(/add constraint supply_requests_status_check check \(status in \(([^)]*)\)\)/);
const vocab = m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : [];
ok(`🔴 … and re-added by name, its vocabulary EXACTLY SUPPLY_STATUSES (${vocab.join(', ') || 'none found'})`,
  !!m && vocab.length === S.SUPPLY_STATUSES.length && S.SUPPLY_STATUSES.every((s) => vocab.includes(s)) && vocab.includes('sent'));
ok('a re-run is a no-op (the named check is dropped if it exists before it is added)',
  has(/drop constraint if exists supply_requests_status_check/) && c.indexOf('drop constraint if exists supply_requests_status_check') < c.indexOf('add constraint supply_requests_status_check'));

// ── 2. the sent record ────────────────────────────────────────────────────────
const addCol = (col, type) => has(new RegExp(`alter table public\\.supply_requests add column if not exists ${col} ${type}`));
ok('sent_at timestamptz', addCol('sent_at', 'timestamptz'));
ok('sent_by_user_id text (the login\'s org user id, never a body field)', addCol('sent_by_user_id', 'text'));
ok('sender_name text (the name at the act, as every other stamp)', addCol('sender_name', 'text'));
ok('sent_lines jsonb, null until sent, an array when present', addCol('sent_lines', 'jsonb') && has(/jsonb_typeof\(sent_lines\) = 'array'/));
ok('sent_total_cents integer, never negative (II.8: money in integer cents)', addCol('sent_total_cents', 'integer') && has(/sent_total_cents >= 0/));
ok('🔴 a sent row is dated', has(/constraint supply_requests_sent_dated check \(status <> 'sent' or sent_at is not null\)/));
ok('🔴 the record is whole or absent — never a date without what went out',
  has(/\(sent_at is null\) = \(sent_lines is null\)/) && has(/\(sent_at is null\) = \(sent_total_cents is null\)/));
ok('each column says what it is (comments)', ['sent_at', 'sent_by_user_id', 'sender_name', 'sent_lines', 'sent_total_cents']
  .every((col) => new RegExp(`comment on column public\\.supply_requests\\.${col} is`, 'i').test(raw)));
ok('the status comment names the new state', /comment on column public\.supply_requests\.status is[\s\S]*sent/i.test(raw));

// ── 3. the store writes only columns that exist ───────────────────────────────
const cols = store.REQUEST_PATCH_COLUMNS ? Object.values(store.REQUEST_PATCH_COLUMNS) : [];
const added = ['sent_at', 'sent_by_user_id', 'sender_name', 'sent_lines', 'sent_total_cents'];
ok(`🔴 every sent column the decision patch writes is added here (${cols.filter((x) => x.startsWith('sent') || x === 'sender_name').join(', ') || 'none'})`,
  cols.length > 0 && cols.filter((x) => x.startsWith('sent') || x === 'sender_name').length === added.length
  && added.every((col) => cols.includes(col)));
ok('no new RLS policy and no grant (the table keeps its house law)', !has(/create policy/) && !has(/\bgrant\b/));

console.log(`\ntest-supply-delivery-migration: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
