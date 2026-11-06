// The customer-message sent log and the survey tables (Matt's approved messages, 2026-10-19),
// STATIC — this suite never runs SQL (the PGlite rehearsal did: 26 checks, recorded in the
// reminders card). It pins the shape the server's store rests on:
//   20261019120000_customer_messages.sql (an expand, applied BEFORE the deploy):
//     · `customer_messages`, keyed (organization_id, id): the statuses EXACTLY the store's
//       MESSAGE_STATUSES, every column the store writes or reads, `keep_until` required (the
//       retention at the write point), the partial indexes the engine's reads use;
//     · `customer_surveys`: the token kept only as a 64-hex SHA-256, a 1–5 rating that goes with
//       its answered_at, a bounded comment;
//     · the house law on both: RLS on, no policies, anon/authenticated revoked, service_role cut
//       back to its four verbs (a grant only adds; only a revoke narrows).
// REGRESSION (THE LAW II.3): on 811e54eb neither the file nor the store exists — every check fails.
//
//   node app/scripts/test-customer-messages-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-service-role';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail)
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };

let store = {};
try { store = await import('../api/_lib/customerMessages/store.js'); } catch (e) { store = { __error: e.message }; }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const NAME = '20261019120000_customer_messages.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
// It was the newest migration when written; later ones (20261020120000_drop_gmb_tables.sql) only follow it.
const PREV = '20261017110100_area_scan_ratings.sql';
ok(`it sorts after every migration that existed when it was written (${PREV} was the newest then)`, files.includes(PREV) && files.indexOf(NAME) > files.indexOf(PREV), files.slice(-3));
const code = raw.replace(/--.*$/gm, '');
const c = code.replace(/\s+/g, ' ').toLowerCase();

ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract: expand/m.test(raw) && /^-- forward-fix/m.test(raw) && /^-- verified-on: NOT APPLIED ANYWHERE/m.test(raw));
ok('lock and statement timeouts are set', /set lock_timeout = '3s';/.test(c) && /set statement_timeout = '60s';/.test(c));

// The column list of one `create table`, from the code.
function columnsOf(table) {
  const m = new RegExp(`create table if not exists public\\.${table} \\((.*?)\\);`, 's').exec(code.replace(/\s+/g, ' '));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter((s) => !/^(constraint|primary key)/i.test(s)).map((s) => s.split(/\s+/)[0]);
}
const MSG_COLS = columnsOf('customer_messages');
const SURVEY_COLS = columnsOf('customer_surveys');
ok('customer_messages is created', MSG_COLS.length > 10, MSG_COLS);
ok('customer_surveys is created', SURVEY_COLS.length > 8, SURVEY_COLS);
ok('the store names the two tables the migration creates', store.MESSAGES_TABLE === 'customer_messages' && store.SURVEYS_TABLE === 'customer_surveys', store.__error);

// ── the sent log ─────────────────────────────────────────────────────────────
ok('keyed by (organization_id, id): one row per message per org', /primary key \(organization_id, id\)/.test(c));
const statusCheck = /constraint customer_messages_status_check check \(status in \(([^)]*)\)\)/.exec(c)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, '')) || [];
ok('🔴 the status CHECK allows EXACTLY the store\'s MESSAGE_STATUSES (one list)', Array.isArray(store.MESSAGE_STATUSES) && JSON.stringify([...statusCheck].sort()) === JSON.stringify([...store.MESSAGE_STATUSES].sort()), { sql: statusCheck, store: store.MESSAGE_STATUSES });
const written = typeof store.messageRow === 'function' ? Object.keys(store.messageRow({ id: 'k:1', templateKey: 't', channel: 'email', status: 'sent', keepUntil: '2026-12-01T00:00:00Z' })) : [];
const missing = written.filter((col) => !MSG_COLS.includes(col));
ok('every column the store writes exists', written.length > 0 && missing.length === 0, missing);
const STORE_SRC = (() => { try { return readFileSync(new URL('../api/_lib/customerMessages/store.js', import.meta.url), 'utf8'); } catch { return ''; } })();
const selected = [...STORE_SRC.matchAll(/\.select\('([^']+)'/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter((s) => s && !s.includes('('));
const missingRead = [...new Set(selected)].filter((col) => !MSG_COLS.includes(col));
ok('every column the store reads exists', selected.length > 0 && missingRead.length === 0, missingRead);
ok('🔴 keep_until is required (retention at the write point, THE LAW II.8)', /keep_until timestamptz not null/.test(c));
ok('a sent row carries sent_at, and only a sent row does', /check \(\(status = 'sent'\) = \(sent_at is not null\)\)/.test(c));
ok('channels are email and sms', /check \(channel in \('email', 'sms'\)\)/.test(c));
for (const ix of ['customer_messages_client_sent_idx', 'customer_messages_sent_day_idx', 'customer_messages_pending_idx', 'customer_messages_keep_idx']) {
  ok(`index ${ix}`, new RegExp(`create index if not exists ${ix} on public\\.customer_messages`).test(c));
}
ok('the history and daily-count indexes are partial on sent rows', /customer_messages_client_sent_idx on public\.customer_messages \(organization_id, client_id, template_key, sent_at desc\) where status = 'sent'/.test(c)
  && /customer_messages_sent_day_idx on public\.customer_messages \(organization_id, channel, sent_at\) where status = 'sent'/.test(c));

// ── the surveys ──────────────────────────────────────────────────────────────
ok('🔴 the token is kept only as a 64-hex SHA-256, unique', /token_hash text not null unique/.test(c) && /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(c));
ok('a rating is 1–5 and goes with answered_at', /rating is null or rating between 1 and 5/.test(c) && /\(rating is null\) = \(answered_at is null\)/.test(c));
ok('the comment is bounded (1,000)', /char_length\(comment\) <= 1000/.test(c));
for (const col of ['client_id', 'contact_id', 'message_id', 'sent_at', 'expires_at', 'answered_at', 'answer_count']) ok(`customer_surveys.${col}`, SURVEY_COLS.includes(col), SURVEY_COLS);

// ── the house law, on both ───────────────────────────────────────────────────
for (const t of ['customer_messages', 'customer_surveys']) {
  ok(`${t}: RLS enabled`, new RegExp(`alter table public\\.${t} enable row level security`).test(c));
  ok(`${t}: anon / authenticated revoked`, new RegExp(`revoke all on public\\.${t} from anon, authenticated`).test(c));
  ok(`${t}: service_role cut back to its four verbs`, new RegExp(`revoke truncate, trigger, references on public\\.${t} from service_role`).test(c)
    && new RegExp(`grant select, insert, update, delete on public\\.${t} to service_role`).test(c));
  ok(`${t}: no policy`, !new RegExp(`create policy [^;]* on public\\.${t}`).test(c));
}
ok('nothing existing is touched (an expand: no alter of another table, no drop)', !/alter table public\.(?!customer_messages|customer_surveys)/.test(c) && !/\bdrop (table|column|index)\b/.test(c));

console.log(`test-customer-messages-migration: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
