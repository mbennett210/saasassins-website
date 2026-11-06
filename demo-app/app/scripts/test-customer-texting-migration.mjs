// The CUSTOMER TEXTING migration (Daniel, 2026-10-28: "Yes, add the Reply STOP functionality." /
// "Customer thread, texted back"), STATIC — this suite never runs SQL. It pins the shape the send
// step, the inbound text route and the thread rest on:
//   20261028120000_customer_texting.sql (an expand, applied BEFORE the code that reads it):
//     · `sms_opt_outs` under the house law (RLS on, no policies, anon/authenticated revoked,
//       service_role cut to the four verbs the server uses), one row per number per org, the
//       number in E.164, its `source` the vocabulary of src/lib/texting.js OPT_OUT_SOURCE, and
//       every column api/_lib/sms/optOuts.js reads and writes;
//     · `client_messages.via` / `.phone`, both nullable (every existing line keeps null/null), the
//       phone's shape checked;
//     · the sent log's index for "the newest text the app sent to this number".
// REGRESSION (THE LAW II.3): on e489af8f the file does not exist — every check fails.
//   node app/scripts/test-customer-texting-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

let TX = {};
try { TX = await import('../src/lib/texting.js'); } catch { TX = {}; }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const NAME = '20261028120000_customer_texting.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
ok('it is the only migration that names sms_opt_outs', files.filter((f) => f !== NAME && /sms_opt_outs/.test(readFileSync(new URL(f, dir), 'utf8'))).length === 0);
// (It was the newest when written; Crew on the way's 20261103120000_client_push_subscriptions.sql came after.)
ok('it sorts after every migration written before it (applied after them)', files.indexOf(NAME) > files.indexOf('20261027120000_hr_incidents.sql') && files.indexOf('20261027120000_hr_incidents.sql') >= 0);
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const has = (re) => re.test(c);

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('an EXPAND: nothing dropped, renamed or narrowed', /^-- expand\|contract: expand/m.test(raw)
  && !has(/drop (table|column|index|constraint)/) && !has(/rename/) && !has(/alter column/) && !has(/\bupdate public\./) && !has(/\bdelete from/));
ok('bounded locks and statements', has(/set lock_timeout/) && has(/set statement_timeout/));

// ── 1. sms_opt_outs ───────────────────────────────────────────────────────────
ok('the table', has(/create table if not exists public\.sms_opt_outs \(/));
const body = (c.match(/create table if not exists public\.sms_opt_outs \((.*?)\);/) || [])[1] || '';
const columns = new Set([...body.matchAll(/(?:^ *|, )([a-z_]+) (uuid|text|timestamptz)\b/g)].map((m) => m[1]));
ok('one row per number per org (the primary key)', /primary key \(organization_id, phone\)/.test(body));
ok('every column required but the keyword', /organization_id uuid not null/.test(body) && /phone text not null/.test(body)
  && /opted_out_at timestamptz not null/.test(body) && /source text not null/.test(body) && /updated_at timestamptz not null/.test(body) && /keyword text,/.test(body));
ok('the number is E.164', /check \(phone ~ '\^\\\+\[0-9\]\{7,15\}\$'\)/.test(body));
const sources = Object.values(TX.OPT_OUT_SOURCE || {}).sort();
const checked = ((body.match(/check \(source in \(([^)]*)\)\)/) || [])[1] || '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();
ok(`🔴 its source CHECK is exactly texting.js OPT_OUT_SOURCE (${sources.join(', ')})`, sources.length === 2 && JSON.stringify(checked) === JSON.stringify(sources));
const storeSrc = (() => { try { return readFileSync(new URL('../api/_lib/sms/optOuts.js', import.meta.url), 'utf8'); } catch { return ''; } })();
const selected = ((storeSrc.match(/const COLUMNS = '([^']+)'/) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const upserted = [...((storeSrc.match(/upsert\(\{([^}]*)\}/) || [])[1] || '').matchAll(/([a-z_]+):/g)].map((m) => m[1]);
const absent = [...new Set([...selected, ...upserted])].filter((col) => !columns.has(col));
ok(`every column the store reads and writes exists${absent.length ? ` (missing: ${absent.join(', ')})` : ''}`, selected.length >= 4 && upserted.length >= 5 && absent.length === 0);
ok('RLS enabled, no policies', has(/alter table public\.sms_opt_outs enable row level security/) && !has(/create policy/));
ok('anon and authenticated revoked', has(/revoke all on public\.sms_opt_outs from anon, authenticated/));
ok('🔴 service_role cut back to the four verbs the server uses (a grant only adds; only a revoke narrows)',
  has(/revoke truncate, trigger, references on public\.sms_opt_outs from service_role/)
  && has(/grant select, insert, update, delete on public\.sms_opt_outs to service_role/) && !has(/grant all on public\.sms_opt_outs/));
ok('no function, no trigger, no security definer', !has(/create (or replace )?function/) && !has(/create trigger/) && !has(/security definer/));

// ── 2. a texted line in the thread ────────────────────────────────────────────
ok('client_messages.via, nullable (every existing line keeps null)', has(/alter table public\.client_messages add column if not exists via text;/));
ok('client_messages.phone, nullable, its shape checked', has(/alter table public\.client_messages add column if not exists phone text constraint client_messages_phone_e164 check \(phone is null or phone ~ '\^\\\+\[0-9\]\{7,15\}\$'\);/));
ok('no default and no NOT NULL on the new columns (no rewrite of the table)', !/add column if not exists (via|phone) text[^;]*(not null|default)/.test(c));
ok('the via word lives in texting.js (TEXT_VIA), not a CHECK', TX.TEXT_VIA === 'sms' && !has(/check \(via/));

// ── 3. the sent log's index ───────────────────────────────────────────────────
ok('the newest text sent to a number: (org, recipient, sent_at desc) over sent texts',
  has(/create index if not exists customer_messages_sms_recipient_idx on public\.customer_messages \(organization_id, recipient, sent_at desc\) where channel = 'sms' and status = 'sent';/));

console.log(`\ntest-customer-texting-migration: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
