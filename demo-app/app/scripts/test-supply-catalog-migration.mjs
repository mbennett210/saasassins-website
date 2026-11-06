// The master supply list's two migrations (plan 2026-10-11 §2, D5), STATIC — this suite never runs
// SQL. It pins the shape the route and the deploy order rest on:
//   1. 20261011100000_supply_catalog.sql (applied BEFORE the deploy, additive): the catalog table
//      under the house law (RLS on, no policies, anon/authenticated revoked, service_role cut back
//      to the four verbs), the org-unique SKU on lower(btrim(sku)), the link from a building's row
//      to its catalog item (cascade on delete, one row per building and item), `name` no longer
//      required — and the BACKFILL that carries production's rows: one catalog row per distinct
//      (name, how it comes, price), every row linked, a building's duplicate rows folded into one,
//      and each request line given the catalog item it was (so history keys on it, D6).
//   2. 20261011100100_supply_items_catalog_only.sql (applied AFTER the deploy, contract): the
//      SAME backfill again (for any row the old code wrote between the two), the link made
//      required, and the three copied columns dropped.
// The backfill's semantics were rehearsed on a 3-row fixture in an in-process Postgres (the
// builder's report carries the run); the two files' backfill blocks must stay byte-identical so
// that rehearsal covers both.
//
//   node app/scripts/test-supply-catalog-migration.mjs
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond)
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const dir = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(dir);
const read = (name) => (files.includes(name) ? readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n') : '');
const M1 = '20261011100000_supply_catalog.sql';
const M2 = '20261011100100_supply_items_catalog_only.sql';
const raw1 = read(M1);
const raw2 = read(M2);
ok(`${M1} exists`, !!raw1);
ok(`${M2} exists`, !!raw2);
// Code only: line comments out (the forward-fix lives in comments), whitespace folded.
const code = (sql) => sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
const c1 = code(raw1);
const c2 = code(raw2);
const has = (c, re) => re.test(c);

// ── the headers (DEV_PLAYBOOK 3.5.7) ──────────────────────────────────────────
for (const [name, sql] of [[M1, raw1], [M2, raw2]]) {
  ok(`${name}: purpose / expand|contract / forward-fix / verified-on header lines`,
    /^-- purpose:/m.test(sql) && /^-- expand\|contract:/m.test(sql) && /^-- forward-fix:/m.test(sql) && /^-- verified-on:/m.test(sql));
  ok(`${name}: lock and statement timeouts`, /set lock_timeout = '3s';/.test(sql) && /set statement_timeout = '60s';/.test(sql));
  ok(`${name}: no CONCURRENTLY (it runs in one transaction)`, !/concurrently/i.test(code(sql)));
}
ok(`${M1} is an EXPAND: it drops no column and makes nothing required`, /^-- expand\|contract: expand/m.test(raw1)
  && !has(c1, /drop column/) && !has(c1, /set not null/));
ok(`${M2} is the CONTRACT, applied after the deploy`, /^-- expand\|contract: contract/m.test(raw2) && /AFTER THE DEPLOY/i.test(raw2));

// ── 1. the catalog table, under the house law ─────────────────────────────────
ok('supply_catalog: created with a caller-minted text id, the org, a required name and the optional fields',
  has(c1, /create table if not exists public\.supply_catalog \( id text primary key/)
  && has(c1, /organization_id uuid not null/) && has(c1, /sku text check \(sku is null or char_length\(sku\) <= 40\)/)
  && has(c1, /name text not null check \(char_length\(name\) between 1 and 200\)/)
  && has(c1, /category text check \(category is null or char_length\(category\) <= 60\)/)
  && has(c1, /unit text check \(unit is null or char_length\(unit\) <= 80\)/)
  && has(c1, /unit_price_cents integer check \(unit_price_cents is null or unit_price_cents > 0\)/)
  && has(c1, /created_by_user_id text/) && has(c1, /version integer not null default 1/));
ok('supply_catalog: RLS on, anon/authenticated revoked, service_role cut back to the four verbs (a GRANT only adds)',
  has(c1, /alter table public\.supply_catalog enable row level security/)
  && has(c1, /revoke all on public\.supply_catalog from anon, authenticated/)
  && has(c1, /revoke all on public\.supply_catalog from service_role/)
  && has(c1, /grant select, insert, update, delete on public\.supply_catalog to service_role/)
  && !has(c1, /create policy/));
ok('🔴 D2: one SKU per org, case-insensitive and around its spaces, a blank one allowed many times',
  has(c1, /create unique index if not exists supply_catalog_org_sku_key on public\.supply_catalog \(organization_id, lower\(btrim\(sku\)\)\) where sku is not null/));
ok('supply_catalog keeps updated_at by the existing trigger function',
  has(c1, /create trigger trg_supply_catalog_touch_updated_at before update on public\.supply_catalog for each row execute function public\.supplies_touch_updated_at\(\)/));

// ── 2. the link ──────────────────────────────────────────────────────────────
ok('supply_items.catalog_item_id → supply_catalog(id), removed with its catalog item',
  has(c1, /alter table public\.supply_items add column if not exists catalog_item_id text references public\.supply_catalog\(id\) on delete cascade/));
ok('one row per building and catalog item (NULLs distinct until the contract makes the link required)',
  has(c1, /create unique index if not exists supply_items_org_client_catalog_key on public\.supply_items \(organization_id, client_id, catalog_item_id\)/));
ok('an index for the catalog\'s "On N buildings" counts and the cascade',
  has(c1, /create index if not exists supply_items_org_catalog_idx on public\.supply_items \(organization_id, catalog_item_id\)/));
ok('`name` is no longer required, so the new code can write a row without the copy',
  has(c1, /alter table public\.supply_items alter column name drop not null/));
ok('the table comments say the list is the master catalog now (the Oct 6 call supersedes SUP-12 c)',
  /comment on table public\.supply_catalog/i.test(raw1) && /comment on table public\.supply_items/i.test(raw1) && /SUP-12/.test(raw1));

// ── 3. the backfill ─────────────────────────────────────────────────────────
const block = (sql) => {
  const m = sql.replace(/\r\n/g, '\n').match(/-- ── BACKFILL \(begin\)[^\n]*\n([\s\S]*?)-- ── BACKFILL \(end\)/);
  return m ? m[1] : '';
};
const b1 = block(raw1);
const b2 = block(raw2);
const cb = code(b1);
ok('both files carry a marked BACKFILL block', !!b1 && !!b2);
ok('🔴 the two backfill blocks are byte-identical (the rehearsal covers both)', !!b1 && b1 === b2);
ok('… one catalog row per distinct (name, how it comes, price) per org, a deterministic id, idempotent (on conflict do nothing)',
  has(cb, /insert into public\.supply_catalog/) && has(cb, /group by/) && has(cb, /lower\(btrim\(/)
  && has(cb, /md5\(/) && has(cb, /on conflict \(id\) do nothing/));
ok('… only rows not yet linked, and only the copied columns are read to group them',
  has(cb, /where (\w+\.)?catalog_item_id is null/));
ok('… each request line gets the catalog item its row was (never its name, qty or price), only where it has none',
  has(cb, /update public\.supply_requests/) && has(cb, /jsonb_build_object\('catalogitemid'/) && has(cb, /\? 'catalogitemid'/));
// The rehearsal's catch (2026-10-11): a row linked by this very backfill is in BOTH halves of the
// lines' join source (supply_items and the map), and a plain union doubled every line naming it —
// twice the quantity, on a frozen record. The source must be one row per item id.
ok('🔴 … and a line is never doubled: the join source is ONE row per item id',
  has(cb, /left join \(select distinct on \(u\.item_id\) u\.item_id, u\.catalog_id/) && has(cb, /order by u\.item_id, u\.pref\) c/));
ok('… one row per building is linked and a building\'s duplicate rows are folded into it',
  has(cb, /update public\.supply_items/) && has(cb, /delete from public\.supply_items/));
ok('… the backfill runs before the unique link index is built', c1.indexOf('supply_items_org_client_catalog_key') > c1.indexOf(code(b1).slice(0, 40)));

// ── 4. the contract ─────────────────────────────────────────────────────────
ok(`${M2}: the link becomes required`, has(c2, /alter table public\.supply_items alter column catalog_item_id set not null/));
ok(`${M2}: the three copied columns are dropped`, ['name', 'unit', 'unit_price_cents'].every((col) => has(c2, new RegExp(`alter table public\\.supply_items drop column if exists ${col}\\b`))));
ok(`${M2}: nothing else is dropped (the backfill's own temp table aside)`, (c2.match(/drop column/g) || []).length === 3
  && (c2.match(/drop table/g) || []).length === (c2.match(/drop table if exists pg_temp\.supply_backfill_map/g) || []).length);

console.log(`\ntest-supply-catalog-migration: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
