// The HR INCIDENT REPORTS migration (task #258 from Clean Corner's queue, 2026-10-27), STATIC —
// this suite never runs SQL. It pins the shape the route, the store and the deploy order rest on:
//   20261027120000_hr_incidents.sql (an expand, applied BEFORE the code that reads it is merged):
//     · one table, `hr_incidents`, under the house law (RLS on, no policies, anon/authenticated
//       revoked, service_role granted), with every column the store reads and writes;
//     · the case number from a sequence (never highest + 1), unique per org, the sequence OWNED by
//       the column and usable by service_role alone;
//     · 🔴 LOCKED ONCE FILED: a trigger refuses any change to an answer, a name, the signature, a
//       date or the case number, refuses every DELETE, freezes a voided report, lets a reviewed one
//       only be voided, keeps a review once written, and lets the files list only grow;
//     · the HR card's read is indexed (gin on involved_user_ids);
//     · every function pins its search_path.
// (The triggers' behaviour was rehearsed on a real Postgres engine before this was handed back;
// the route suite's stand-in does not run them.)
//
//   node app/scripts/test-hr-incidents-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-service-role';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

let store = {};
try { store = await import('../api/_lib/hrIncidents/store.js'); } catch { store = {}; }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const NAME = '20261027120000_hr_incidents.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
ok('it is the only migration that names hr_incidents', files.filter((f) => f !== NAME && /hr_incidents/.test(readFileSync(new URL(f, dir), 'utf8'))).length === 0);
// Code only: line comments out, whitespace folded, lower case.
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const has = (re) => re.test(c);

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('an EXPAND that touches nothing existing', /^-- expand\|contract: expand/m.test(raw)
  && !has(/alter table (if exists )?public\.(?!hr_incidents\b)/) && !has(/drop (table|column)/));
ok('bounded locks and statements', has(/set lock_timeout/) && has(/set statement_timeout/));

// ── the table ─────────────────────────────────────────────────────────────────
ok('the table', has(/create table if not exists public\.hr_incidents \(/));
const body = (c.match(/create table if not exists public\.hr_incidents \((.*?)\);/) || [])[1] || '';
const columns = new Set([...body.matchAll(/(?:^ *|, )([a-z_]+) (uuid|text|bigint|date|jsonb|integer|timestamptz)\b/g)].map((m) => m[1]));
ok('a caller-minted uuid primary key (a retried filing is a no-op)', /\bid uuid primary key\b/.test(body) && !/\bid uuid primary key default\b/.test(body));
ok('the case number from the sequence, required', /number bigint not null default nextval\('public\.hr_incident_number_seq'\)/.test(body));
ok('…unique per org', /unique \(organization_id, number\)/.test(body));
ok('the sequence starts at 1 and is owned by the column', has(/create sequence if not exists public\.hr_incident_number_seq start with 1/)
  && has(/alter sequence public\.hr_incident_number_seq owned by public\.hr_incidents\.number/));
ok('the signature is bounded (≤ 200,000 characters)', /submitter_signature text not null check \(length\(submitter_signature\) <= 200000\)/.test(body));
ok('at least one type, none blank', /types text\[\] not null check \(cardinality\(types\) >= 1/.test(body));
ok('people and files are JSON arrays', /people jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(people\) = 'array'\)/.test(body)
  && /files jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(files\) = 'array'\)/.test(body));
ok('the time is HH:MM or nothing', /incident_time text check \(incident_time is null or incident_time ~/.test(body));
ok('the version the files CAS reads', /version integer not null default 1/.test(body));
// LIST_COLUMNS is the select string the list reads (every column but the signature).
const read = typeof store.LIST_COLUMNS === 'string' ? [...store.LIST_COLUMNS.split(',').map((x) => x.trim()).filter(Boolean), 'submitter_signature'] : [];
const absent = read.filter((col) => !columns.has(col));
ok(`every column the store reads exists${absent.length ? ` (missing: ${absent.join(', ')})` : ''}`, read.length > 0 && absent.length === 0);
const storeSrc = (() => { try { return readFileSync(new URL('../api/_lib/hrIncidents/store.js', import.meta.url), 'utf8'); } catch { return ''; } })();
const written = [...new Set([...storeSrc.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]))].filter((k) => k.includes('_') || ['id', 'people', 'types', 'files', 'injured', 'witnesses', 'police', 'notified', 'status', 'version'].includes(k));
const unknown = written.filter((col) => !columns.has(col));
ok(`every column the store writes exists${unknown.length ? ` (missing: ${unknown.join(', ')})` : ''}`, written.length > 20 && unknown.length === 0);

// ── the house law ─────────────────────────────────────────────────────────────
ok('RLS enabled', has(/alter table public\.hr_incidents enable row level security/));
ok('no policies', !has(/create policy/));
ok('anon and authenticated revoked (table and sequence)', has(/revoke all on public\.hr_incidents from anon, authenticated/)
  && has(/revoke all on sequence public\.hr_incident_number_seq from anon, authenticated/));
ok('service_role granted (table and sequence)', has(/grant all on public\.hr_incidents to service_role/)
  && has(/grant usage, select on sequence public\.hr_incident_number_seq to service_role/));
ok('every function pins its search_path', (c.match(/create or replace function/g) || []).length === 2
  && (c.match(/language plpgsql set search_path = ''/g) || []).length === 2);
ok('no security definer', !has(/security definer/));

// ── indexes ───────────────────────────────────────────────────────────────────
ok('the list read (org, newest first)', has(/create index if not exists hr_incidents_org_filed_idx on public\.hr_incidents \(organization_id, filed_at desc\)/));
ok('the HR card read (gin on involved_user_ids)', has(/create index if not exists hr_incidents_involved_idx on public\.hr_incidents using gin \(involved_user_ids\)/));

// ── 🔴 locked once filed ──────────────────────────────────────────────────────
const fnAt = c.indexOf('create or replace function public.hr_incidents_guard_change');
const guard = fnAt >= 0 ? c.slice(fnAt, c.indexOf('$$;', fnAt)) : '';
ok('the guard exists', guard.length > 0);
ok('🔴 a DELETE is refused outright', /if tg_op = 'delete' then raise exception/.test(guard)
  && has(/create trigger trg_hr_incidents_guard_delete before delete on public\.hr_incidents for each row execute function public\.hr_incidents_guard_change\(\)/));
ok('the guard runs before every UPDATE', has(/create trigger trg_hr_incidents_guard_update before update on public\.hr_incidents for each row execute function public\.hr_incidents_guard_change\(\)/));
// Every column but the ones that may move after filing is in the locked tuple.
const MOVES = new Set(['status', 'reviewed_by_user_id', 'reviewed_by_name', 'received_on', 'reviewed_at', 'voided_at', 'voided_by_user_id',
  'voided_by_name', 'void_reason', 'files', 'version', 'created_at', 'updated_at']);
const lockedTuple = (guard.match(/if \((new\.[a-z_]+(?:, new\.[a-z_]+)*)\) is distinct from/) || [])[1] || '';
const locked = new Set([...lockedTuple.matchAll(/new\.([a-z_]+)/g)].map((m) => m[1]));
const unlocked = [...columns].filter((col) => !MOVES.has(col) && !locked.has(col));
ok(`🔴 every answer, name, date, the signature and the case number are locked${unlocked.length ? ` (unlocked: ${unlocked.join(', ')})` : ''}`, columns.size > 40 && unlocked.length === 0);
ok('…and nothing that may move is in the lock', [...MOVES].every((col) => !locked.has(col)));
ok('🔴 a voided report freezes its review, its void, its files and its version', /if old\.status = 'voided' and \(new\.status, new\.reviewed_by_user_id, new\.reviewed_by_name, new\.received_on, new\.reviewed_at, new\.voided_at, new\.voided_by_user_id, new\.voided_by_name, new\.void_reason, new\.files, new\.version\) is distinct from/.test(guard));
ok('a reviewed report may only stay reviewed or be voided', /if old\.status = 'reviewed' and new\.status not in \('reviewed', 'voided'\)/.test(guard));
ok('a review, once recorded, stays', /if old\.reviewed_at is not null and \(new\.reviewed_by_user_id, new\.reviewed_by_name, new\.received_on, new\.reviewed_at\) is distinct from/.test(guard));
ok('🔴 the files list only grows (every file stays, unchanged)', /if not \(new\.files @> old\.files\) or jsonb_array_length\(new\.files\) < jsonb_array_length\(old\.files\)/.test(guard));
ok('a review records who and when; a void records when and why', /a review records who and when/.test(guard) && /a void records when and why/.test(guard));
ok('a review needs its reviewer, its time and its day', /new\.status = 'reviewed' and \(new\.reviewed_by_user_id is null or new\.reviewed_at is null or new\.received_on is null\)/.test(guard));
ok('updated_at kept by the database', has(/create trigger trg_hr_incidents_touch_updated_at before update on public\.hr_incidents/));
ok('the vocabularies stay in lib/hrIncidents.js (no check lists the types)', !/'employee injury'|'injury'|'near_miss'|'first_aid'/.test(c));

console.log(`\ntest-hr-incidents-migration: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
