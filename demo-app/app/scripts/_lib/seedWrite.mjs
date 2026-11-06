// The backend seed's WRITE PATH (app/scripts/seed-backend.mjs), over either transport:
//   · supabase-js with the service-role pair (the original path), or
//   · Postgres over SUPABASE_DB_URL (a machine holding only that connection string — the main
//     checkout's app/.env.local has nothing else): EVERY write in ONE transaction, the shared
//     record's write a version-checked UPDATE (CAS) inside it, and any failure rolls all of it back.
//
// The seed describes its writes as a PLAN — `{ kind: 'delete', table, where }` and
// `{ kind: 'upsert', table, rows, conflict }` steps, in order, plus a `blob` step — and this module
// only executes, counts (the dry run's "rows deleted") and checks it. A delete always names the
// seed's own rows (`where` is required and every step filters on the org); there is no
// whole-table form at all.
//
// 🔴 THE TARGET IS CHECKED BEFORE A SOCKET OPENS: the Postgres path writes to ONE project, the
// production sandbox (PROD_REF), and refuses any other ref, or a connection string whose ref it
// cannot read. The connection string is never printed — only the ref.
import { PROD_REF, refFromDbUrl } from './liveGuard.mjs';

export const SEED_PG_REF = PROD_REF;
const CHUNK = 200;
const OPS = new Set(['eq', 'like', 'in']);
const IDENT = /^[a-z_][a-z0-9_]*$/;

// The ref of a SUPABASE_DB_URL, and the reason to refuse it (null to proceed).
export function pgTarget(dbUrl) {
  const ref = refFromDbUrl(dbUrl);
  if (!ref) return { ref: null, refusal: '⛔ REFUSING: could not read the project ref from SUPABASE_DB_URL (expected postgres.<ref>@… or …@db.<ref>.supabase.co).' };
  if (ref !== SEED_PG_REF) return { ref, refusal: `⛔ REFUSING project ${ref}: the seed's Postgres path writes only to the production sandbox ${SEED_PG_REF}.` };
  return { ref, refusal: null };
}

const ident = (name) => {
  if (!IDENT.test(name)) throw new Error(`seedWrite: refusing the identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

// ── SQL ──────────────────────────────────────────────────────────────────────────────────────
// A step's filter. Every delete/count carries at least one condition (a seed id, a seed prefix, a
// seed marker) besides the org: a plan that asks for a bare table is refused, not run.
export function whereSql(where, start = 1) {
  if (!Array.isArray(where) || !where.length) throw new Error('seedWrite: a delete must say which rows (no whole-table delete)');
  const parts = [];
  const values = [];
  for (const w of where) {
    if (!w || !OPS.has(w.op)) throw new Error(`seedWrite: unknown filter ${JSON.stringify(w)}`);
    const col = ident(w.col);
    values.push(w.op === 'in' ? [...w.value] : w.value);
    const n = start + values.length - 1;
    parts.push(w.op === 'eq' ? `${col} = $${n}` : w.op === 'like' ? `${col} like $${n}` : `${col} = any($${n})`);
  }
  if (!where.some((w) => w.col !== 'organization_id')) throw new Error('seedWrite: a delete must name the seed rows, not only the org');
  return { text: parts.join(' and '), values };
}
export function deleteSql(table, where) {
  const w = whereSql(where);
  return { text: `delete from public.${ident(table)} where ${w.text}`, values: w.values };
}
export function countSql(table, where) {
  const w = whereSql(where);
  return { text: `select count(*)::int as n from public.${ident(table)} where ${w.text}`, values: w.values };
}

// A column's value as a parameter, by its type: jsonb as JSON text, an array as a Postgres array.
function param(type, v) {
  if (v === null) return { value: null, cast: '' };
  if (type?.data_type === 'jsonb' || type?.data_type === 'json') return { value: JSON.stringify(v), cast: `::${type.data_type}` };
  if (type?.data_type === 'ARRAY') return { value: Array.isArray(v) ? v : [v], cast: `::${String(type.udt_name || '_text').replace(/^_/, '')}[]` };
  if (v && typeof v === 'object' && !(v instanceof Date)) return { value: JSON.stringify(v), cast: '' };
  return { value: v, cast: '' };
}
// INSERT … ON CONFLICT … DO UPDATE, in chunks. A key a row leaves undefined takes the column's
// DEFAULT. `types` is the table's column → { data_type, udt_name }; a key the table does not have
// is refused (the dry run reports it before anything is written).
export function upsertSql(table, rows, { conflict = ['id'], types } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
  const unknown = types ? cols.filter((c) => !types.has(c)) : [];
  if (unknown.length) throw new Error(`seedWrite: ${table} has no column ${unknown.join(', ')}`);
  cols.forEach(ident);
  conflict.forEach(ident);
  const updates = cols.filter((c) => !conflict.includes(c));
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const values = [];
    const tuples = list.slice(i, i + CHUNK).map((r) => `(${cols.map((c) => {
      if (r[c] === undefined) return 'default';
      const p = param(types?.get(c), r[c]);
      values.push(p.value);
      return `$${values.length}${p.cast}`;
    }).join(', ')})`);
    const set = updates.length ? `do update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}` : 'do nothing';
    out.push({
      text: `insert into public.${ident(table)} (${cols.map(ident).join(', ')}) values ${tuples.join(', ')} on conflict (${conflict.map(ident).join(', ')}) ${set}`,
      values,
    });
  }
  return out;
}

// The tables a plan touches, with their columns' types (one read; a table the project does not
// have comes back absent, and its steps are skipped and reported).
export async function readColumnTypes(client, tables) {
  const r = await client.query(
    `select table_name, column_name, data_type, udt_name from information_schema.columns
      where table_schema = 'public' and table_name = any($1)`, [[...new Set(tables)]]);
  const out = new Map();
  for (const row of r.rows) {
    if (!out.has(row.table_name)) out.set(row.table_name, new Map());
    out.get(row.table_name).set(row.column_name, { data_type: row.data_type, udt_name: row.udt_name });
  }
  return out;
}

// ── the plan over Postgres ───────────────────────────────────────────────────────────────────
// Validate the plan against the project (every table present, every column known) WITHOUT
// writing: the dry run's check, and the commit's first step. → { types, skipped: [label], problems: [] }
export async function checkPgPlan(client, steps) {
  const types = await readColumnTypes(client, steps.map((s) => s.table));
  const skipped = [];
  const problems = [];
  for (const s of steps) {
    if (!types.has(s.table)) { skipped.push(`${s.label || s.table} (no table ${s.table})`); continue; }
    if (s.kind === 'upsert') {
      try { upsertSql(s.table, s.rows, { conflict: s.conflict, types: types.get(s.table) }); } catch (e) { problems.push(e.message); }
    } else {
      try { whereSql(s.where); } catch (e) { problems.push(e.message); }
    }
  }
  return { types, skipped, problems };
}

// The shared record's version-checked write, as runPgPlan sends it.
export const CAS_UPDATE_SQL = "update public.org_state set state = $1::jsonb, version = version + 1, updated_via = 'server', updated_at = now() where organization_id = $2 and version = $3";

// Every statement the commit would send, PLANNED by the live database but never executed: EXPLAIN
// (without ANALYZE) parses, type-checks and plans an INSERT / DELETE / UPDATE — the columns, the
// casts, the ON CONFLICT target's unique index — and a READ ONLY transaction allows it, because
// nothing runs. Each in its own savepoint, so one refusal does not end the read. → [problem]
export async function explainPgPlan(client, steps, types, { blob = null } = {}) {
  const statements = [];
  for (const s of steps) {
    if (!types.has(s.table)) continue;
    if (s.kind === 'delete') statements.push({ label: s.label || s.table, ...deleteSql(s.table, s.where) });
    else for (const q of upsertSql(s.table, s.rows, { conflict: s.conflict, types: types.get(s.table) })) statements.push({ label: s.label || s.table, ...q });
  }
  if (blob) statements.push({ label: 'org_state (CAS)', text: CAS_UPDATE_SQL, values: [JSON.stringify(blob.state), blob.org, blob.version] });
  const problems = [];
  for (const st of statements) {
    await client.query('savepoint seed_explain');
    try {
      await client.query(`explain ${st.text}`, st.values);
      await client.query('release savepoint seed_explain');
    } catch (e) {
      problems.push(`${st.label}: ${e.message}`);
      await client.query('rollback to savepoint seed_explain');
    }
  }
  return { statements: statements.length, problems };
}

// How many rows each delete step would remove (read-only; the dry run's numbers).
export async function countPgDeletes(client, steps, types) {
  const out = [];
  for (const s of steps) {
    if (s.kind !== 'delete' || !types.has(s.table)) continue;
    const q = countSql(s.table, s.where);
    out.push({ label: s.label || s.table, table: s.table, n: (await client.query(q.text, q.values)).rows[0].n });
  }
  return out;
}

// Run the whole plan in ONE transaction: the steps in order, then the shared record — re-read
// under a row lock, changed by `blob.apply(state)`, size-checked, written only if its version is
// still the one read (CAS). Anything failing rolls everything back. → { results, blob }
export async function runPgPlan(client, { steps, blob = null, maxBlobBytes = Infinity, log = () => {} }) {
  const { types, skipped, problems } = await checkPgPlan(client, steps);
  if (problems.length) throw new Error(`the plan does not fit the database: ${problems.join('; ')}`);
  const results = [];
  await client.query('begin');
  try {
    for (const s of steps) {
      if (!types.has(s.table)) continue;
      if (s.kind === 'delete') {
        const q = deleteSql(s.table, s.where);
        const r = await client.query(q.text, q.values);
        results.push({ label: s.label || s.table, deleted: r.rowCount });
        log(`  ✓ deleted ${r.rowCount} from ${s.label || s.table}`);
      } else {
        let n = 0;
        for (const q of upsertSql(s.table, s.rows, { conflict: s.conflict, types: types.get(s.table) })) n += (await client.query(q.text, q.values)).rowCount;
        results.push({ label: s.label || s.table, upserted: n });
        log(`  ✓ wrote ${n} to ${s.label || s.table}`);
      }
    }
    let blobResult = null;
    if (blob) {
      const cur = (await client.query('select state, version from public.org_state where organization_id = $1 for update', [blob.org])).rows[0];
      if (!cur) throw new Error('no org_state row');
      const { state: next, changes } = blob.apply(cur.state || {});
      const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (bytes > maxBlobBytes) throw new Error(`the shared record would be ${Math.round(bytes / 1024)} KB, over its ${Math.round(maxBlobBytes / 1024)} KB limit`);
      const r = await client.query(CAS_UPDATE_SQL, [JSON.stringify(next), blob.org, cur.version]);
      if (r.rowCount !== 1) throw new Error('the shared record moved while the seed was writing (version check failed); nothing was written — run it again');
      const v = Number(cur.version);   // a bigint column arrives as a string
      blobResult = { from: v, to: v + 1, bytes, changes };
      log(`  ✓ org_state v${v} → v${v + 1} (${Math.round(bytes / 1024)} KB)`);
    }
    await client.query('commit');
    return { results, blob: blobResult, skipped };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  }
}

// ── the plan over supabase-js (the service-role pair) ────────────────────────────────────────
const restFilter = (q, where) => {
  whereSql(where);   // the same refusals as the Postgres path
  for (const w of where) q = w.op === 'eq' ? q.eq(w.col, w.value) : w.op === 'like' ? q.like(w.col, w.value) : q.in(w.col, w.value);
  return q;
};
export async function countRestDeletes(sb, steps) {
  const out = [];
  for (const s of steps) {
    if (s.kind !== 'delete') continue;
    const { count, error } = await restFilter(sb.from(s.table).select('*', { count: 'exact', head: true }), s.where);
    out.push({ label: s.label || s.table, table: s.table, n: error ? `? (${error.message})` : count });
  }
  return out;
}
export async function runRestPlan(sb, { steps, blob = null, maxBlobBytes = Infinity, log = () => {} }) {
  const results = [];
  for (const s of steps) {
    if (s.kind === 'delete') {
      const { error } = await restFilter(sb.from(s.table).delete(), s.where);
      if (error) throw new Error(`${s.label || s.table} cleanup failed: ${error.message}`);
      results.push({ label: s.label || s.table, deleted: '✓' });
      log(`  ✓ cleaned ${s.label || s.table}`);
    } else {
      const rows = s.rows || [];
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from(s.table).upsert(rows.slice(i, i + 500), { onConflict: (s.conflict || ['id']).join(',') });
        if (error) throw new Error(`${s.table} write failed: ${error.message}`);
      }
      results.push({ label: s.label || s.table, upserted: rows.length });
      if (rows.length) log(`  ✓ ${s.label || s.table}: ${rows.length}`);
    }
  }
  let blobResult = null;
  if (blob) {
    for (let attempt = 1; attempt <= 3 && !blobResult; attempt += 1) {
      const { data: cur, error: rerr } = await sb.from('org_state').select('state, version').eq('organization_id', blob.org).maybeSingle();
      if (rerr || !cur) throw new Error(`blob read failed: ${rerr?.message}`);
      const { state: next, changes } = blob.apply(cur.state || {});
      const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (bytes > maxBlobBytes) throw new Error(`blob too large after seed: ${Math.round(bytes / 1024)} KB`);
      const { data, error } = await sb.from('org_state')
        .update({ state: next, version: cur.version + 1, updated_via: 'server', updated_at: new Date().toISOString() })
        .eq('organization_id', blob.org).eq('version', cur.version).select('version');
      if (error) throw new Error(`blob write failed: ${error.message}`);
      if (Array.isArray(data) && data.length === 1) {
        blobResult = { from: cur.version, to: cur.version + 1, bytes, changes };
        log(`  ✓ org_state blob v${cur.version}→${cur.version + 1} (${Math.round(bytes / 1024)} KB)`);
      } else log(`  … CAS conflict, re-reading (attempt ${attempt}/3)`);
    }
    if (!blobResult) throw new Error('blob CAS failed after 3 attempts — re-run.');
  }
  return { results, blob: blobResult, skipped: [] };
}
