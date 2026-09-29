// fake-supabase.mjs — an in-process stand-in for @supabase/supabase-js, so an offline
// suite can drive the REAL api/ route handlers (auth.js, claims.js, authz.js, orgState.js,
// the stores) end to end with no network, no credentials and no live project.
//
// WHY. A server gate is only proven by a request going through it. Unit-testing the
// decision function alone misses the wiring (which key a route passes, whether it asks at
// all, what the store does with the answer), and "connected mode" writes the real Supabase
// project, which BUILD_INTEGRITY §6b forbids for server claims. This replaces the one
// module every server path funnels through: `installFakeSupabase()` registers a
// module.registerHooks() resolve hook (the same node ≥22.15 capability deletion-core.mjs
// uses) that points every `import … from '@supabase/supabase-js'` at THIS file, so
// api/_lib/supabase.js and auth.js build their clients from `createClient` below.
//
// NOT a test file (no `test-` prefix), so run-tests.mjs neither runs nor scans it.
//
//   import { installFakeSupabase, world, resetWorld } from './fake-supabase.mjs';
//   installFakeSupabase();                       // BEFORE importing anything under api/
//   resetWorld({ tables: { org_state: [...] }, logins: { tok: user } });
//   const handler = (await import('../api/time/[...path].js')).default;
//   world.log                                    // every query run: { table, op, eq, cols }
//   world.failWhen = (q) => q.table === 'jobs'   // answer matching queries with an error
//
// Supported: auth.getUser(token) · from(t).select(cols, { count, head }) with plain columns
// or `alias:col->key` JSON projections (the org_state slice reads) · eq / neq / in / is /
// gte / lte / gt / lt / not(col,'is',null) · contains(col, obj) (JSONB `@>`) · order / range /
// limit · single / maybeSingle ·
// insert / update / delete (+ .select() to return rows) · storage.from(b).createSignedUploadUrl
// / createSignedUrl / remove. Anything else throws, loudly, rather than answering wrong.
//
// NOT emulated (a suite must not rely on them): column types (a uuid column accepts any
// string here), unique indexes / 23505 conflicts, RLS and triggers. db-max-rows is OFF
// unless a suite sets `world.maxRows` (Supabase's is 1000): then every read returns at most
// that many rows, as PostgREST's cap does, so an unpaged read can be shown to miss rows. It makes no network calls itself; a suite should still
// point SUPABASE_URL at a closed local port and stub `fetch`, so nothing else can either.
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';

// ── the world a suite sets up ───────────────────────────────────────────────
export const world = {
  tables: {},           // table name -> array of rows (mutated by writes)
  logins: new Map(),    // bearer token -> Supabase auth user { id, email, app_metadata }
  log: [],              // every query that ran: { table, op, eq: {col: val}, cols }
  storage: [],          // every storage call: { bucket, op, path }
  failWhen: null,       // (query) => true to answer that query with an error, as a DB outage would
  maxRows: null,        // PostgREST's db-max-rows: null = no cap
};

export function resetWorld({ tables = {}, logins = {} } = {}) {
  world.tables = structuredClone(tables);
  world.logins = new Map(Object.entries(logins));
  world.log = [];
  world.storage = [];
  world.failWhen = null;
  world.maxRows = null;
}

// ── install ─────────────────────────────────────────────────────────────────
let installed = false;
export function installFakeSupabase() {
  if (installed) return;
  installed = true;
  const self = import.meta.url;
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec === '@supabase/supabase-js') return { url: self, shortCircuit: true };
      return next(spec, ctx);
    },
  });
  // A suite's offline claim rests on this hook, so prove it took before anything under
  // api/ is imported: a real client must never be built behind a suite's back.
  if (import.meta.resolve('@supabase/supabase-js') !== self) {
    throw new Error('fake-supabase: the resolve hook did not take; refusing to run against a real client');
  }
}

// The export api/_lib/supabase.js and auth.js call.
export function createClient(url, key) {
  return new FakeClient(url, key);
}

class FakeClient {
  constructor(url, key) {
    this.url = url;
    this.key = key;
    this.isFake = true;
    this.auth = {
      async getUser(token) {
        const user = world.logins.get(token);
        return user
          ? { data: { user: structuredClone(user) }, error: null }
          : { data: { user: null }, error: { message: 'invalid JWT' } };
      },
      admin: new Proxy({}, { get: (_t, p) => () => { throw new Error(`fake-supabase: auth.admin.${String(p)} is not faked`); } }),
    };
    this.storage = { from: (bucket) => new FakeBucket(bucket) };
  }

  from(table) { return new FakeQuery(table); }
}

class FakeBucket {
  constructor(bucket) { this.bucket = bucket; }
  async createSignedUploadUrl(path) {
    world.storage.push({ bucket: this.bucket, op: 'upload-url', path });
    return { data: { path, token: `tok_${path.length}`, signedUrl: `https://fake.storage/${this.bucket}/${path}?upload` }, error: null };
  }
  async createSignedUrl(path, ttl) {
    world.storage.push({ bucket: this.bucket, op: 'download-url', path, ttl });
    return { data: { signedUrl: `https://fake.storage/${this.bucket}/${path}?ttl=${ttl}` }, error: null };
  }
  async remove(paths) {
    for (const path of paths) world.storage.push({ bucket: this.bucket, op: 'remove', path });
    return { data: paths.map((name) => ({ name })), error: null };
  }
}

// ── the query builder ───────────────────────────────────────────────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string' && ISO_RE.test(a) && ISO_RE.test(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// `state, version` · `users:state->users` · `permissions:state->permissions,…`
function project(row, cols) {
  if (!cols || cols.trim() === '*') return structuredClone(row);
  const out = {};
  for (const item of cols.split(',').map((s) => s.trim()).filter(Boolean)) {
    const json = item.match(/^(\w+):(\w+)->(\w+)$/);
    if (json) {
      const [, alias, col, key] = json;
      const v = row[col] && typeof row[col] === 'object' ? row[col][key] : undefined;
      out[alias] = v === undefined ? null : structuredClone(v);
    } else if (/^\w+$/.test(item)) {
      out[item] = row[item] === undefined ? null : structuredClone(row[item]);
    } else {
      throw new Error(`fake-supabase: select item "${item}" unsupported`);
    }
  }
  return out;
}

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.eqs = {};
    this.orders = [];
    this.offset = 0;
    this.lim = null;
    this.cols = '*';
    this.returning = false;
    this.countMode = null;
    this.head = false;
    this.one = null; // 'single' | 'maybe'
  }

  select(cols = '*', opts = {}) {
    if (this.op === 'select') {
      this.cols = cols;
      if (opts.count) this.countMode = opts.count;
      if (opts.head) this.head = true;
    } else {
      this.returning = true;
      this.cols = cols;
    }
    return this;
  }
  insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert() { throw new Error('fake-supabase: upsert is not faked'); }

  eq(c, v) { this.eqs[c] = v; this.filters.push((r) => r[c] != null && cmp(r[c], v) === 0); return this; }
  // SQL semantics: `col <> v` is NULL (so excluded) when col is NULL, as in fake-postgrest.
  neq(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) !== 0); return this; }
  gte(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
  lte(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this; }
  gt(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) > 0); return this; }
  lt(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) < 0); return this; }
  // JSONB containment (`col @> obj`): every key of `obj` must be contained, an array by
  // each of its elements (as Postgres checks array containment), anything else by equality.
  contains(c, obj) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    this.filters.push((r) => r[c] != null && typeof r[c] === 'object'
      && Object.entries(obj).every(([k, want]) => (Array.isArray(want)
        ? Array.isArray(r[c][k]) && want.every((w) => r[c][k].some((h) => same(h, w)))
        : same(r[c][k], want))));
    return this;
  }
  in(c, arr) { const s = new Set(arr); this.filters.push((r) => r[c] != null && s.has(r[c])); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, op, v) {
    if (op === 'is' && v === null) { this.filters.push((r) => r[c] != null); return this; }
    throw new Error(`fake-supabase: not.${op} unsupported`);
  }
  or() { throw new Error('fake-supabase: or() is not faked'); }
  order(c, { ascending = true } = {}) { this.orders.push({ c, asc: ascending }); return this; }
  range(a, b) { this.offset = a; this.lim = b - a + 1; return this; }
  limit(n) { this.lim = n; return this; }
  abortSignal() { return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }

  rows() { return world.tables[this.table] || (world.tables[this.table] = []); }
  matching() { return this.rows().filter((r) => this.filters.every((f) => f(r))); }

  finish(rows) {
    const data = rows.map((r) => project(r, this.cols));
    if (this.one === 'single') {
      return data.length === 1
        ? { data: data[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${data.length}` } };
    }
    if (this.one === 'maybe') {
      if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
      return { data: data[0] || null, error: null };
    }
    return { data, error: null };
  }

  run() {
    const q = { table: this.table, op: this.op, eq: { ...this.eqs }, cols: this.cols };
    world.log.push(q);
    if (world.failWhen && world.failWhen(q)) return { data: null, count: null, error: { message: 'fake read failure' } };
    if (this.op === 'insert') {
      const now = new Date().toISOString();
      const added = this.payload.map((r) => ({ id: randomUUID(), created_at: now, ...structuredClone(r) }));
      this.rows().push(...added);
      return this.returning ? this.finish(added) : { data: null, error: null };
    }
    if (this.op === 'update') {
      const hit = this.matching();
      for (const r of hit) Object.assign(r, structuredClone(this.payload));
      return this.returning ? this.finish(hit) : { data: null, error: null };
    }
    if (this.op === 'delete') {
      const hit = new Set(this.matching());
      world.tables[this.table] = this.rows().filter((r) => !hit.has(r));
      return this.returning ? this.finish([...hit]) : { data: null, error: null };
    }
    let rows = this.matching();
    if (this.countMode && this.head) return { data: null, count: rows.length, error: null };
    if (this.orders.length) {
      rows = rows.slice().sort((x, y) => {
        for (const { c, asc } of this.orders) {
          const d = cmp(x[c], y[c]);
          if (d !== 0) return asc ? d : -d;
        }
        return 0;
      });
    }
    const take = Math.min(this.lim ?? Infinity, world.maxRows ?? Infinity, rows.length);
    const out = this.finish(rows.slice(this.offset, this.offset + take));
    if (this.countMode) out.count = rows.length;
    return out;
  }

  // Thenable like the real builder: `await query` runs it.
  then(onFulfilled, onRejected) {
    return Promise.resolve().then(() => this.run()).then(onFulfilled, onRejected);
  }
}
