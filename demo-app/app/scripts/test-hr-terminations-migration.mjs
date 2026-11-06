// The HR TERMINATIONS migration (Super Clippy's idea #513 from Clean Corner's queue, 2026-11-05),
// STATIC — this suite never runs SQL. It pins the shape the route, the store, the cron and the
// deploy order rest on:
//   20261105120000_hr_terminations.sql (an expand, applied BEFORE the code that reads it is merged):
//     · one table, `hr_terminations`, under the house law (RLS on, no policies, anon/authenticated
//       revoked, service_role granted), with every column the store reads and writes;
//     · ONE LIVE TERMINATION PER PERSON: a partial unique index over the filed rows;
//     · 🔴 LOCKED ONCE FILED: a trigger refuses any change to who, the day, the manager, the
//       reasons or who filed it, refuses every DELETE, keeps a voided one voided and its void as
//       written, and lets the login move only forward (scheduled → ending | already_off,
//       ending → ended | already_off, and on a void ending | ended → restored | kept), each
//       moment written once;
//     · the trigger's vocabularies are the ones lib/hrTerminations.js names;
//     · every function pins its search_path.
// (The triggers' behaviour is rehearsed on Postgres inside `begin … rollback` before it is
// applied; the route suite's stand-in does not run them.)
//
//   node app/scripts/test-hr-terminations-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

let L = {};
try { L = await import('../src/lib/hrTerminations.js'); } catch { fails.push('lib/hrTerminations.js loads'); }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const NAME = '20261105120000_hr_terminations.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
ok('it is the only migration that names hr_terminations', files.filter((f) => f !== NAME && /hr_terminations/.test(readFileSync(new URL(f, dir), 'utf8'))).length === 0);
// Code only: line comments out, whitespace folded, lower case.
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const has = (re) => re.test(c);

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('an EXPAND that touches nothing existing', /^-- expand\|contract: expand/m.test(raw)
  && !has(/alter table (if exists )?public\.(?!hr_terminations\b)/) && !has(/drop (table|column)/));
ok('bounded locks and statements', has(/set lock_timeout/) && has(/set statement_timeout/));

// ── the table ─────────────────────────────────────────────────────────────────
ok('the table', has(/create table if not exists public\.hr_terminations \(/));
const body = (c.match(/create table if not exists public\.hr_terminations \((.*?)\);/) || [])[1] || '';
const columns = new Set([...body.matchAll(/(?:^ *|, )([a-z_]+) (uuid|text\[\]|text|date|timestamptz)\b/g)].map((m) => m[1]));
ok('a caller-minted uuid primary key (a retried filing is a no-op)', /\bid uuid primary key\b/.test(body) && !/\bid uuid primary key default\b/.test(body));
ok('his fields are required: who, the day, the manager', /employee_user_id text not null/.test(body) && /employee_name text not null/.test(body)
  && /termination_date date not null/.test(body) && /manager_user_id text not null/.test(body));
ok('at least one reason, none blank', /reasons text\[\] not null check \(cardinality\(reasons\) >= 1/.test(body));
ok('"Other"\'s words bounded as the lib bounds them', L.TERMINATION_TEXT_MAX && new RegExp(`reason_other text check \\(reason_other is null or length\\(reason_other\\) <= ${L.TERMINATION_TEXT_MAX.reasonOther}\\)`).test(body));
ok('a new row is filed and scheduled', /status text not null default 'filed'/.test(body) && /access_state text not null default 'scheduled'/.test(body));
const storeSrc = (() => { try { return readFileSync(new URL('../api/_lib/hrTerminations/store.js', import.meta.url), 'utf8'); } catch { return ''; } })();
const accessSrc = (() => { try { return readFileSync(new URL('../api/_lib/hrTerminations/access.js', import.meta.url), 'utf8'); } catch { return ''; } })();
// The insert's keys (createTermination's row) and every patch's keys (the moves).
const written = [...new Set([...`${storeSrc}\n${accessSrc}`.matchAll(/^\s{4,8}([a-z_]+):/gm)].map((m) => m[1]))]
  .filter((k) => k.includes('_') || ['id', 'reasons', 'status'].includes(k));
const unknown = written.filter((col) => !columns.has(col));
ok(`every column the store and the access module write exists${unknown.length ? ` (missing: ${unknown.join(', ')})` : ''}`, written.length >= 20 && unknown.length === 0);
const read = [...storeSrc.matchAll(/r\.([a-z_]+_[a-z_]+|reasons|status|id)\b/g)].map((m) => m[1]);
const absent = [...new Set(read)].filter((col) => !columns.has(col));
ok(`every column the store reads exists${absent.length ? ` (missing: ${absent.join(', ')})` : ''}`, read.length >= 15 && absent.length === 0);

// ── the house law ─────────────────────────────────────────────────────────────
ok('RLS enabled', has(/alter table public\.hr_terminations enable row level security/));
ok('no policies', !has(/create policy/));
ok('anon and authenticated revoked', has(/revoke all on public\.hr_terminations from anon, authenticated/));
ok('service_role granted', has(/grant all on public\.hr_terminations to service_role/));
ok('every function pins its search_path', (c.match(/create or replace function/g) || []).length === 2
  && (c.match(/language plpgsql set search_path = ''/g) || []).length === 2);
ok('no security definer', !has(/security definer/));

// ── indexes ───────────────────────────────────────────────────────────────────
ok('the list read (org, newest first)', has(/create index if not exists hr_terminations_org_filed_idx on public\.hr_terminations \(organization_id, filed_at desc\)/));
ok('🔴 one live termination per person (partial unique over the filed rows)',
  has(/create unique index if not exists hr_terminations_one_live_idx on public\.hr_terminations \(organization_id, employee_user_id\) where status = 'filed'/));

// ── 🔴 locked once filed ──────────────────────────────────────────────────────
const fnAt = c.indexOf('create or replace function public.hr_terminations_guard_change');
const guard = fnAt >= 0 ? c.slice(fnAt, c.indexOf('$$;', fnAt)) : '';
ok('the guard exists', guard.length > 0);
ok('🔴 a DELETE is refused outright', /if tg_op = 'delete' then raise exception/.test(guard)
  && has(/create trigger trg_hr_terminations_guard_delete before delete on public\.hr_terminations for each row execute function public\.hr_terminations_guard_change\(\)/));
ok('the guard runs before every UPDATE', has(/create trigger trg_hr_terminations_guard_update before update on public\.hr_terminations for each row execute function public\.hr_terminations_guard_change\(\)/));
const MOVES = new Set(['status', 'voided_at', 'voided_by_user_id', 'voided_by_name', 'void_reason', 'access_state', 'access_ended_at',
  'status_before', 'access_restored_at', 'updated_at']);
const lockedTuple = (guard.match(/if \((new\.[a-z_]+(?:, new\.[a-z_]+)*)\) is distinct from/) || [])[1] || '';
const locked = new Set([...lockedTuple.matchAll(/new\.([a-z_]+)/g)].map((m) => m[1]));
const unlocked = [...columns].filter((col) => !MOVES.has(col) && !locked.has(col));
ok(`🔴 who, the day, the manager, the reasons and who filed it are locked${unlocked.length ? ` (unlocked: ${unlocked.join(', ')})` : ''}`, columns.size >= 20 && unlocked.length === 0);
ok('…and nothing that may move is in the lock', [...MOVES].every((col) => !locked.has(col)));
ok('the statuses are the lib\'s', Array.isArray(L.TERMINATION_STATUSES)
  && guard.includes(`new.status not in (${L.TERMINATION_STATUSES.map((s) => `'${s}'`).join(', ')})`));
ok('🔴 a voided one stays voided, its void as written', /if old\.status = 'voided' and new\.status <> 'voided'/.test(guard)
  && /if old\.status = 'voided' and \(new\.voided_at, new\.voided_by_user_id, new\.voided_by_name, new\.void_reason\) is distinct from/.test(guard));
ok('a void records when and why', /a void records when and why/.test(guard) && /new\.voided_at is null or coalesce\(btrim\(new\.void_reason\), ''\) = ''/.test(guard));
ok('the access states are the lib\'s', Array.isArray(L.ACCESS_STATES)
  && guard.includes(`new.access_state not in (${L.ACCESS_STATES.map((s) => `'${s}'`).join(', ')})`));
ok('🔴 the login moves only forward', guard.includes("(old.access_state = 'scheduled' and new.access_state in ('ending', 'already_off'))")
  && guard.includes("(old.access_state = 'ending' and new.access_state in ('ended', 'already_off'))")
  && guard.includes("(old.access_state in ('ending', 'ended') and new.access_state in ('restored', 'kept') and new.status = 'voided')"));
ok('a turn-off begins only on a filed one, and records when', /new\.access_state = 'ending' and old\.access_state = 'scheduled' and \(new\.access_ended_at is null or new\.status <> 'filed'\)/.test(guard));
ok('🔴 each moment is written once (the turn-off, the status before, the give-back)',
  ['access_ended_at', 'status_before', 'access_restored_at'].every((col) => guard.includes(`if old.${col} is not null and new.${col} is distinct from old.${col}`)));
ok('updated_at kept by the database', has(/create trigger trg_hr_terminations_touch_updated_at before update on public\.hr_terminations/));
ok('the reasons stay in lib/hrTerminations.js (no check lists them)', !/'resignation'|'insubordination'|'job_abandonment'/.test(c));

console.log(`\ntest-hr-terminations-migration: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
