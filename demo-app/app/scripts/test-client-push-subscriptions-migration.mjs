// CREW ON THE WAY's one database change (Daniel's picks 2026-11-03): the customer hub's phone alert
// sign-ups, STATIC — this suite never runs SQL. It pins the shape the hub's push branches and the
// On my way send rest on:
//   20261103120000_client_push_subscriptions.sql (an expand, applied BEFORE the code that reads it):
//     · `client_push_subscriptions` under the house law (RLS on, no policies, anon/authenticated
//       revoked, service_role cut to the four verbs the server uses);
//     · one row per push address per org (the store's upsert conflict target), the login's rows
//       indexed for the send, and every column api/_lib/clientHub/push.js reads and writes;
//     · retention by construction: the row goes with its login (on delete cascade from
//       client_users), and its lengths match lib/crewOnTheWay HUB_PUSH_LIMITS.
// REGRESSION (THE LAW II.3): on 872893a5 the file does not exist — every check fails.
//   node app/scripts/test-client-push-subscriptions-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

let W = {};
try { W = await import('../src/lib/crewOnTheWay.js'); } catch { W = {}; }

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).sort();
const NAME = '20261103120000_client_push_subscriptions.sql';
const raw = files.includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
ok(`${NAME} exists`, !!raw);
ok('it is the only migration that names client_push_subscriptions', files.filter((f) => f !== NAME && /client_push_subscriptions/.test(readFileSync(new URL(f, dir), 'utf8'))).length === 0);
ok('it sorts after every migration written before it (20261028120000_customer_texting.sql)', files.indexOf(NAME) > files.indexOf('20261028120000_customer_texting.sql') && files.indexOf('20261028120000_customer_texting.sql') >= 0);
const c = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const has = (re) => re.test(c);

// ── the header (DEV_PLAYBOOK 3.5.7) ───────────────────────────────────────────
ok('purpose / expand|contract / forward-fix / verified-on header lines',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract:/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on:/m.test(raw));
ok('an EXPAND: nothing dropped, renamed or narrowed, no existing row touched', /^-- expand\|contract: expand/m.test(raw)
  && !has(/drop (table|column|index|constraint)/) && !has(/rename/) && !has(/alter column/) && !has(/\bupdate public\./) && !has(/\bdelete from/) && !has(/alter table public\.(?!client_push_subscriptions)/));
ok('bounded locks and statements', has(/set lock_timeout/) && has(/set statement_timeout/));

// ── the table ─────────────────────────────────────────────────────────────────
ok('the table', has(/create table if not exists public\.client_push_subscriptions \(/));
const body = (c.match(/create table if not exists public\.client_push_subscriptions \((.*?)\);/) || [])[1] || '';
const columns = new Set([...body.matchAll(/(?:^ *|, )([a-z_0-9]+) +(uuid|text|timestamptz)\b/g)].map((m) => m[1]));
ok('every required column NOT NULL, the label optional', ['organization_id', 'client_user_id', 'endpoint', 'p256dh', 'auth', 'created_at', 'last_seen_at'].every((col) => new RegExp(`${col} +(uuid|text|timestamptz) +not null`).test(body)) && /device_label +text,/.test(body));
ok('🔴 the row goes with its login (on delete cascade from public.client_users)', /client_user_id uuid not null constraint client_push_subscriptions_client_user_fk references public\.client_users \(id\) on delete cascade/.test(body));
const L = W.HUB_PUSH_LIMITS || {};
ok(`the lengths are crewOnTheWay HUB_PUSH_LIMITS (${L.endpoint} / ${L.key} / ${L.label})`, L.endpoint === 2048 && L.key === 256 && L.label === 64
  && body.includes(`char_length(endpoint) between 1 and ${L.endpoint}`) && body.includes(`char_length(p256dh) between 1 and ${L.key}`) && body.includes(`char_length(auth) between 1 and ${L.key}`) && body.includes(`char_length(device_label) <= ${L.label}`));
const storeSrc = (() => { try { return readFileSync(new URL('../api/_lib/clientHub/push.js', import.meta.url), 'utf8'); } catch { return ''; } })();
const upserted = [...((storeSrc.match(/upsert\(\{([^}]*)\}/) || [])[1] || '').matchAll(/([a-z_0-9]+):/g)].map((m) => m[1]);
const selected = [...storeSrc.matchAll(/select\('([^']+)'\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
const absent = [...new Set([...upserted, ...selected])].filter((col) => !columns.has(col));
ok(`every column the store reads and writes exists${absent.length ? ` (missing: ${absent.join(', ')})` : ''}`, upserted.length >= 6 && selected.length >= 2 && absent.length === 0);
ok('🔴 one row per push address per org: the store\'s upsert conflict target is a unique index', /onConflict: 'organization_id,endpoint'/.test(storeSrc)
  && has(/create unique index if not exists client_push_subscriptions_endpoint_uidx on public\.client_push_subscriptions \(organization_id, endpoint\);/));
ok('a login\'s phones, indexed for the send', has(/create index if not exists client_push_subscriptions_user_idx on public\.client_push_subscriptions \(organization_id, client_user_id\);/));

// ── the house law ─────────────────────────────────────────────────────────────
ok('RLS enabled, no policies', has(/alter table public\.client_push_subscriptions enable row level security/) && !has(/create policy/));
ok('anon and authenticated revoked', has(/revoke all on public\.client_push_subscriptions from anon, authenticated/));
ok('🔴 service_role cut back to the four verbs the server uses (a grant only adds; only a revoke narrows)',
  has(/revoke truncate, trigger, references on public\.client_push_subscriptions from service_role/)
  && has(/grant select, insert, update, delete on public\.client_push_subscriptions to service_role/) && !has(/grant all on public\.client_push_subscriptions/));
ok('no function, no trigger, no security definer', !has(/create (or replace )?function/) && !has(/create trigger/) && !has(/security definer/));
ok('the push table the send may prune is named in the store\'s allowlist (push/store PUSH_TABLES)', /PUSH_TABLES = Object\.freeze\(\['push_subscriptions', 'client_push_subscriptions'\]\)/.test((() => { try { return readFileSync(new URL('../api/_lib/push/store.js', import.meta.url), 'utf8'); } catch { return ''; } })()));

console.log(`\ntest-client-push-subscriptions-migration: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
