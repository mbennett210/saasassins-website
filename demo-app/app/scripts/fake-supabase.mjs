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
//   resetWorld({ tables: { org_state: [...] }, logins: { tok: user }, authUsers: [...] });  // authUsers: optional, turns on auth.admin
//   const handler = (await import('../api/time/[...path].js')).default;
//   world.log                                    // every query run: { table, op, eq, cols }
//   world.failWhen = (q) => q.table === 'jobs'   // answer matching queries with an error
//   world.beforeQuery = async (q) => { … }       // an await point BEFORE each query runs
//
// `beforeQuery` is the concurrency BARRIER: every query awaits it with its own descriptor
// before touching the tables, so a suite can park ONE statement (say the clock-out's
// UPDATE) and drive a whole second request through the handler in the gap — a read→write
// race reproduced deterministically instead of by timing. It is per-world (resetWorld
// clears it) and must never throw; throw from `failWhen` to simulate a failing read.
//
// Supported: auth.getUser(token) · from(t).select(cols, { count, head }) with plain columns
// or `alias:col->key` JSON projections, deeper paths and a final `->>` included (the org_state
// slice reads, a job's `end_at:data->>endAt`) · eq / neq / in / is /
// gte / lte / gt / lt / not(col,'is',null) · contains(col, obj) (JSONB `@>`) ·
// or('col.op.val,col.op.val') (the org_state fleet gate) · order / range /
// limit · single / maybeSingle ·
// insert / update / delete / upsert(rows, { onConflict, ignoreDuplicates }) (+ .select() to
// return rows) · storage.from(b).createSignedUploadUrl
// / createSignedUrl / createSignedUrls / upload / remove / download (bytes from
// `world.objects["<bucket>/<path>"]`, which `upload` writes) ·
// auth.admin (GoTrue's admin API) ONLY when a suite seeds `world.authUsers` (see fakeAdmin below).
// Anything else throws, loudly, rather than answering wrong.
//
// NOT emulated (a suite must not rely on them): column types (a uuid column accepts any
// string here), unique indexes / 23505 conflicts (unless a suite declares a table's in
// `world.uniqueKeys`, for inserts), RLS and triggers. db-max-rows is OFF
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
  objects: {},          // "<bucket>/<path>" -> bytes, what storage.download() serves
  failWhen: null,       // (query) => true to answer that query with an error, as a DB outage would
  // The PROVIDER's own words for that error. A suite that checks an error body never leaks
  // them (CS-077) needs a recognisable string to look for, which "fake read failure" is not.
  failMessage: null,
  maxRows: null,        // PostgREST's db-max-rows: null = no cap
  beforeQuery: null,    // async (query) => void — awaited BEFORE each query runs (the barrier)
  // (name, args) => { data, error } for a `db.rpc(...)` call. DEFAULT: throw loudly, like every
  // other unfaked capability — a suite must opt in rather than get a wrong answer by accident.
  // A suite whose route calls an RPC with a documented fallback (jobsTable's `delete_jobs`
  // answers PGRST202 when the migration isn't deployed) sets this to that answer. The app's own
  // write functions (`inspection_write`) are answered by their built-in twin (BUILTIN_RPC,
  // below) before this is asked, so a suite never has to fake them.
  rpc: null,
  // { [table]: [(row) => key | null, …] } — a table's UNIQUE indexes, opt-in. An insert whose row
  // repeats a key of a row already there (or of an earlier row in the same insert) is refused
  // whole with Postgres's 23505, as a unique index would; a null key is not checked (a partial
  // index). Default: none, as before (see "NOT emulated" above).
  uniqueKeys: null,
  // { [table]: { [column]: () => value } } — a column's DEFAULT on insert, opt-in (a sequence: the
  // supply orders' `number`). Applied to a new row that names no value for it; the row's own wins.
  columnDefaults: null,
  // GoTrue's ADMIN API, opt-in (fakeAdmin below). null = not faked: every auth.admin call throws,
  // as it always did. An ARRAY of auth users ({ id, email, app_metadata, banned_until?,
  // last_sign_in_at? }) turns the stand-in on, and the calls read and write it.
  authUsers: null,
  authFail: null,      // (op, args) => true answers that admin call with an error, as an outage would
  authBefore: null,    // async (op, args) => void — runs before each admin call (e.g. a login appears)
};

export function resetWorld({ tables = {}, logins = {}, objects = {}, authUsers = null } = {}) {
  world.tables = structuredClone(tables);
  world.logins = new Map(Object.entries(logins));
  world.log = [];
  world.storage = [];
  world.objects = { ...objects };
  world.failWhen = null;
  world.failMessage = null;
  world.maxRows = null;
  world.beforeQuery = null;
  world.rpc = null;
  world.uniqueKeys = null;
  world.columnDefaults = null;
  world.authUsers = Array.isArray(authUsers) ? structuredClone(authUsers) : null;
  world.authFail = null;
  world.authBefore = null;
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
      admin: fakeAdmin(),
    };
    this.storage = { from: (bucket) => new FakeBucket(bucket) };
  }

  from(table) { return new FakeQuery(table); }

  // A Postgres function call. The app's own write functions have a built-in twin
  // (BUILTIN_RPC below), answered first, so every suite that drives those writes works
  // whatever its own `world.rpc` says. Anything else is unfaked by default (see world.rpc): a
  // route that calls one and has a documented fallback (jobsTable's `delete_jobs` -> plain
  // delete on PGRST202) lets a suite answer it, and anything else still throws loudly rather
  // than answering wrong. An rpc is a statement like any other: it waits at the
  // `beforeQuery` barrier (descriptor `{ table: 'rpc:<name>', op: 'rpc', args }`), is logged
  // with its arguments, and `failWhen` can fail it.
  async rpc(name, args) {
    const q = { table: `rpc:${name}`, op: 'rpc', eq: {}, cols: '', args: structuredClone(args ?? null) };
    if (world.beforeQuery) await world.beforeQuery(q);
    world.log.push(q);
    if (world.failWhen && world.failWhen(q)) return { data: null, error: { message: world.failMessage || 'fake rpc failure' } };
    if (Object.prototype.hasOwnProperty.call(BUILTIN_RPC, name)) return BUILTIN_RPC[name](args || {});
    if (typeof world.rpc !== 'function') throw new Error(`fake-supabase: rpc("${name}") is not faked (set world.rpc)`);
    const out = await world.rpc(name, args);
    return out || { data: null, error: null };
  }
}

// ── Built-in twins of the app's own database functions ──────────────────────
// 🔴 THE SQL IS THE TRUTH; these are the smallest models of it that answer the same shapes.
// Each runs ATOMICALLY (no await inside), which is what the real function's row lock makes the
// real one: nothing can interleave with it. A behaviour change goes in the migration first, then
// here, and the suite that owns the function holds the two to one answer where it can.
//
// public.inspection_write (supabase/migrations/20261011110000_inspection_write.sql, CS-650):
// the ONE write of an inspection's answers — lock the record (id AND org), refuse a non-draft
// when draft-only, replace its items, update it from the allowlisted patch, stamp updated_at,
// and answer the row after with the status / score / result before.
export const INSPECTION_WRITE_PATCH_KEYS = Object.freeze(['status', 'overall_score', 'result', 'performed_at', 'internal_note']);
const BUILTIN_RPC = {
  inspection_write({ p_org, p_id, p_items, p_patch, p_draft_only } = {}) {
    const rec = (world.tables.inspection_records || []).find((r) => r.id === p_id && r.organization_id === p_org);
    if (!rec) return { data: { outcome: 'not_found' }, error: null };
    if (p_draft_only && rec.status !== 'draft') return { data: { outcome: 'not_a_draft', before: { status: rec.status } }, error: null };
    const before = { status: rec.status ?? null, overall_score: rec.overall_score ?? null, result: rec.result ?? null };
    world.tables.inspection_items = (world.tables.inspection_items || [])
      .filter((i) => i.inspection_id !== p_id)
      .concat((Array.isArray(p_items) ? p_items : []).map((x) => ({
        id: randomUUID(), inspection_id: p_id, item_key: x.item_key ?? null, label: x.label ?? null,
        rating: x.rating ?? null, comment: x.comment ?? null, photo_count: x.photo_count ?? 0,
      })));
    const patch = p_patch && typeof p_patch === 'object' ? p_patch : {};
    for (const k of INSPECTION_WRITE_PATCH_KEYS) if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = patch[k];
    rec.updated_at = new Date().toISOString();
    return { data: { outcome: 'written', record: structuredClone(rec), before }, error: null };
  },
};

// ── GoTrue's admin API (opt-in: world.authUsers) ────────────────────────────
// The calls the server's login code makes, in supabase-js's shapes ({ data, error }, an error
// carrying GoTrue's `status` and `code`), over `world.authUsers`:
//   listUsers({ page, perPage })        one page of logins, in insertion order
//   getUserById(id)                     the login, or 404 user_not_found
//   updateUserById(id, { app_metadata, ban_duration })
//                                       app_metadata is MERGED key by key and a null value DELETES
//                                       the key (GoTrue's own rule, which claims.js relies on);
//                                       ban_duration 'none' lifts a ban, anything else sets one
//   deleteUser(id)                      gone, or 404
//   createUser({ email, app_metadata }) 422 email_exists for an address that already has a login
//   generateLink({ type, email })       a one-time link for an existing login, or 404
// Every call is logged as { table: 'auth.admin', op, eq: { id | email } }. `world.authBefore(op,
// args)` runs first and `world.authFail(op, args)` → true answers the call with a 500, so a suite
// can stage a login appearing mid-flow or GoTrue being down. With world.authUsers null every call
// throws, exactly as before this existed.
const authError = (status, code, message) => ({ name: 'AuthApiError', status, code, message });
const findAuth = (id) => (world.authUsers || []).find((u) => u.id === id) || null;
const AUTH_ADMIN = {
  async listUsers({ page = 1, perPage = 50 } = {}) {
    const all = world.authUsers || [];
    const from = (Math.max(1, Number(page) || 1) - 1) * perPage;
    return { data: { users: structuredClone(all.slice(from, from + perPage)), aud: 'authenticated' }, error: null };
  },
  async getUserById(id) {
    const u = findAuth(id);
    return u ? { data: { user: structuredClone(u) }, error: null }
      : { data: { user: null }, error: authError(404, 'user_not_found', 'User not found') };
  },
  async updateUserById(id, attrs = {}) {
    const u = findAuth(id);
    if (!u) return { data: { user: null }, error: authError(404, 'user_not_found', 'User not found') };
    if (attrs.app_metadata && typeof attrs.app_metadata === 'object') {
      const md = { ...(u.app_metadata || {}) };
      for (const [k, v] of Object.entries(attrs.app_metadata)) { if (v === null) delete md[k]; else md[k] = structuredClone(v); }
      u.app_metadata = md;
    }
    if (attrs.ban_duration !== undefined) {
      u.banned_until = attrs.ban_duration === 'none' ? null : new Date(Date.now() + 100 * 365 * 864e5).toISOString();
    }
    return { data: { user: structuredClone(u) }, error: null };
  },
  async deleteUser(id) {
    if (!findAuth(id)) return { data: null, error: authError(404, 'user_not_found', 'User not found') };
    world.authUsers = world.authUsers.filter((u) => u.id !== id);
    return { data: {}, error: null };
  },
  async createUser(attrs = {}) {
    const email = String(attrs.email || '').trim().toLowerCase();
    if ((world.authUsers || []).some((u) => String(u.email || '').toLowerCase() === email)) {
      return { data: { user: null }, error: authError(422, 'email_exists', 'A user with this email address has already been registered') };
    }
    const u = {
      id: randomUUID(), email, app_metadata: { provider: 'email', providers: ['email'], ...(attrs.app_metadata || {}) },
      user_metadata: {}, banned_until: null, last_sign_in_at: null, created_at: new Date().toISOString(),
    };
    world.authUsers.push(u);
    return { data: { user: structuredClone(u) }, error: null };
  },
  async generateLink({ type, email, options } = {}) {
    const target = String(email || '').trim().toLowerCase();
    const u = (world.authUsers || []).find((x) => String(x.email || '').toLowerCase() === target);
    if (!u) return { data: { properties: null, user: null }, error: authError(404, 'user_not_found', 'User not found') };
    const link = `https://fake.auth/verify?type=${encodeURIComponent(type || '')}&token=${randomUUID()}&redirect_to=${encodeURIComponent(options?.redirectTo || '')}`;
    return { data: { properties: { action_link: link, verification_type: type }, user: structuredClone(u) }, error: null };
  },
};
function fakeAdmin() {
  return new Proxy({}, {
    get: (_t, p) => {
      const op = String(p);
      if (!Array.isArray(world.authUsers) || !Object.prototype.hasOwnProperty.call(AUTH_ADMIN, op)) {
        return () => { throw new Error(`fake-supabase: auth.admin.${op} is not faked`); };
      }
      return async (...args) => {
        const a0 = args[0];
        world.log.push({ table: 'auth.admin', op, eq: typeof a0 === 'string' ? { id: a0 } : (a0?.email ? { email: a0.email } : {}), cols: '' });
        if (world.authBefore) await world.authBefore(op, args);
        if (world.authFail && world.authFail(op, args)) {
          return { data: op === 'listUsers' ? { users: [] } : { user: null }, error: authError(500, 'unexpected_failure', 'fake auth failure') };
        }
        return AUTH_ADMIN[op](...args);
      };
    },
  });
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
  // Many links in one call, as Storage answers: one entry per path, each with its own `path` (each
  // log entry carries `batch`, the call's size, so a suite can prove the links came in one call).
  async createSignedUrls(paths, ttl) {
    for (const path of paths) world.storage.push({ bucket: this.bucket, op: 'download-url', path, ttl, batch: paths.length });
    return { data: paths.map((path) => ({ path, error: null, signedUrl: `https://fake.storage/${this.bucket}/${path}?ttl=${ttl}` })), error: null };
  }
  // A server-side upload: the bytes land in `world.objects` (refused, as Storage refuses it, when
  // the object exists and `upsert` is not set).
  async upload(path, bytes, opts = {}) {
    const key = `${this.bucket}/${path}`;
    world.storage.push({ bucket: this.bucket, op: 'upload', path, upsert: !!opts.upsert, contentType: opts.contentType || null });
    if (world.objects[key] != null && !opts.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
    world.objects[key] = bytes;
    return { data: { path }, error: null };
  }
  async remove(paths) {
    for (const path of paths) world.storage.push({ bucket: this.bucket, op: 'remove', path });
    return { data: paths.map((name) => ({ name })), error: null };
  }
  // The object's bytes from `world.objects["<bucket>/<path>"]`, as Storage's Blob; a missing
  // object answers Storage's not-found error, as the real client does.
  async download(path) {
    world.storage.push({ bucket: this.bucket, op: 'download', path });
    const bytes = world.objects?.[`${this.bucket}/${path}`];
    if (bytes == null) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
    return { data: new Blob([bytes]), error: null };
  }
}

// ── the query builder ───────────────────────────────────────────────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

// A filter's column: a plain column, or a JSON path into one as PostgREST takes it in a filter
// (`data->crewIds`, `data->>recurrence`) — the jobs reads filter on the crew list and on the
// series master's `recurrence` (CS-676/677). `->` answers the JSON value; a final `->>` answers
// TEXT: a string as it is, anything else as its JSON, and JSON null as SQL NULL (so
// `not(…, 'is', null)` skips a `"recurrence": null` the way Postgres does).
function cell(r, c) {
  const m = /^(\w+)((?:->>?\w+)+)$/.exec(c);
  if (!m) return r[c];
  let v = r[m[1]];
  let text = false;
  for (const [, op, key] of m[2].matchAll(/(->>?)(\w+)/g)) {
    v = v && typeof v === 'object' ? v[key] : undefined;
    text = op === '->>';
  }
  if (v === undefined || v === null) return null;
  return text && typeof v !== 'string' ? JSON.stringify(v) : v;
}
function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string' && ISO_RE.test(a) && ISO_RE.test(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// `state, version` · `users:state->users` · `permissions:state->permissions,…` · and deeper
// paths, as PostgREST takes them: `tz:state->company->>timezone`, `end_at:data->>endAt`. A `->>`
// step answers TEXT (a string as it is, anything else as its JSON), like Postgres's operator.
function project(row, cols) {
  if (!cols || cols.trim() === '*') return structuredClone(row);
  const out = {};
  for (const item of cols.split(',').map((s) => s.trim()).filter(Boolean)) {
    const json = item.match(/^(\w+):(\w+)((?:->>?\w+)+)$/);
    if (json) {
      const [, alias, col, chain] = json;
      let v = row[col];
      let text = false;
      for (const [, op, key] of chain.matchAll(/(->>?)(\w+)/g)) {
        v = v && typeof v === 'object' ? v[key] : undefined;
        text = op === '->>';
      }
      if (v === undefined || v === null) out[alias] = null;
      else if (text) out[alias] = typeof v === 'string' ? v : JSON.stringify(v);
      else out[alias] = structuredClone(v);
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
    this.ins = {};
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
  // Insert-or-update on the onConflict key set. No unique index is emulated, so the
  // conflict target is taken from `onConflict` (comma-separated columns) and matched by
  // value against the existing rows (every key present on both sides) — enough to prove a
  // route's upsert path end to end. A matched row is merged (replaced field by field) unless
  // `ignoreDuplicates` is set, which leaves it untouched and out of the answer (only inserted rows
  // come back, as PostgREST answers); a new row gets the same `id` and
  // `created_at` defaults `insert` gives it (its own values win).
  upsert(rows, opts = {}) {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = typeof opts.onConflict === 'string' ? opts.onConflict.split(',').map((s) => s.trim()).filter(Boolean) : [];
    this.ignoreDuplicates = !!opts.ignoreDuplicates;
    return this;
  }

  eq(c, v) { this.eqs[c] = v; this.filters.push((r) => cell(r, c) != null && cmp(cell(r, c), v) === 0); return this; }
  // SQL semantics: `col <> v` is NULL (so excluded) when col is NULL, as in fake-postgrest.
  neq(c, v) { this.filters.push((r) => cell(r, c) != null && cmp(cell(r, c), v) !== 0); return this; }
  gte(c, v) { this.filters.push((r) => cell(r, c) != null && cmp(cell(r, c), v) >= 0); return this; }
  lte(c, v) { this.filters.push((r) => cell(r, c) != null && cmp(cell(r, c), v) <= 0); return this; }
  gt(c, v) { this.filters.push((r) => cell(r, c) != null && cmp(cell(r, c), v) > 0); return this; }
  lt(c, v) { this.filters.push((r) => cell(r, c) != null && cmp(cell(r, c), v) < 0); return this; }
  // JSONB containment (`col @> value`): every key of an object must be contained, an array by
  // each of its elements (as Postgres checks array containment), anything else by equality. A
  // STRING value is the JSON PostgREST would receive (supabase-js passes a string through as
  // `cs.<value>`): `contains('data->crewIds', '["u_1"]')` is `data->'crewIds' @> '["u_1"]'`.
  contains(c, value) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const want = typeof value === 'string' ? JSON.parse(value) : value;
    const holds = (have, w) => {
      if (Array.isArray(w)) return Array.isArray(have) && w.every((x) => have.some((h) => holds(h, x) || same(h, x)));
      if (w && typeof w === 'object') return have != null && typeof have === 'object' && !Array.isArray(have) && Object.entries(w).every(([k, x]) => holds(have[k], x));
      return same(have, w);
    };
    this.filters.push((r) => { const v = cell(r, c); return v != null && typeof v === 'object' && holds(v, want); });
    return this;
  }
  in(c, arr) { this.ins[c] = [...arr]; const s = new Set(arr); this.filters.push((r) => cell(r, c) != null && s.has(cell(r, c))); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? cell(r, c) == null : cell(r, c) === v)); return this; }
  not(c, op, v) {
    if (op === 'is' && v === null) { this.filters.push((r) => cell(r, c) != null); return this; }
    throw new Error(`fake-supabase: not.${op} unsupported`);
  }
  // PostgREST's `or=(a.is.null,a.lte.3)`: a comma-separated list of `col.op.value` terms, any
  // of which may match. The one caller under api/ is the org_state FLEET GATE
  // (`min_client_build.is.null,min_client_build.lte.<build>`), which every save on the
  // server-mediated write path goes through — so a suite that drives that route needs this,
  // and before 2026-09-29 it threw and no suite could reach the route through this fake. The
  // ops are the builder's own; an unsupported one still throws, loudly, rather than answering
  // wrong. Values are coerced to numbers when they look numeric, as PostgREST does against a
  // numeric column (the string "3" must not be compared to 3 as text).
  or(spec) {
    const num = (raw) => { const n = Number(raw); return raw !== '' && Number.isFinite(n) ? n : raw; };
    // Split on the commas BETWEEN terms only: an `in.(a,b)` list carries its own commas, and a
    // plain split cut a crew scope of two sites into "site_id.in.(s1" and "s2)" (WO-19's suite
    // was the first to read the queue as a cleaner whose customer has two buildings).
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(spec)) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    const terms = parts.map((t) => t.trim()).filter(Boolean).map((t) => {
      const first = t.indexOf('.');
      const second = t.indexOf('.', first + 1);
      if (first < 0 || second < 0) throw new Error(`fake-supabase: or() term "${t}" unsupported`);
      const col = t.slice(0, first);
      const op = t.slice(first + 1, second);
      // A value with PostgREST's reserved characters (`,.:()`, e.g. an ISO instant) arrives
      // double-quoted — the jobs window's keyset `start_at.gt."2026-…",id.gt."j_…"` (CS-676).
      const raw = /^".*"$/.test(t.slice(second + 1)) ? t.slice(second + 2, -1) : t.slice(second + 1);
      if (op === 'is' && raw === 'null') return (r) => r[col] == null;
      // `in.(a,b,c)` — what `applyCrewScope` (api/_lib/qc/store.js) emits for a crew
      // member's assigned clients and sites, so without it NO crew-scoped QC read could be
      // driven through this fake at all (it threw "unsupported" and the route answered
      // 500). PostgREST allows the list to be quoted; both spellings are accepted, and an
      // empty list matches nothing, as SQL's IN () does.
      if (op === 'in') {
        const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
        const vals = inner === '' ? [] : inner.split(',').map((v) => num(v.trim().replace(/^"(.*)"$/, '$1')));
        return (r) => r[col] != null && vals.some((v) => cmp(r[col], v) === 0);
      }
      // `ilike.*term*` — the supplies queue's search (api/_lib/supplies/store.js): `*` is
      // PostgREST's wildcard in a URL filter; matched case-insensitively, as ILIKE is.
      if (op === 'ilike') {
        const esc = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*');
        const re = new RegExp(`^${esc}$`, 'i');
        return (r) => r[col] != null && re.test(String(r[col]));
      }
      if (op === 'eq') return (r) => r[col] != null && cmp(r[col], num(raw)) === 0;
      if (op === 'neq') return (r) => r[col] != null && cmp(r[col], num(raw)) !== 0;
      if (op === 'lte') return (r) => r[col] != null && cmp(r[col], num(raw)) <= 0;
      if (op === 'gte') return (r) => r[col] != null && cmp(r[col], num(raw)) >= 0;
      if (op === 'lt') return (r) => r[col] != null && cmp(r[col], num(raw)) < 0;
      if (op === 'gt') return (r) => r[col] != null && cmp(r[col], num(raw)) > 0;
      throw new Error(`fake-supabase: or() term "${t}" unsupported`);
    });
    this.filters.push((r) => terms.some((f) => f(r)));
    return this;
  }
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

  // What `world.log`, `failWhen` and `beforeQuery` all see: the statement about to run. `in`
  // carries each .in() filter's list, so a suite can prove a read was narrowed IN the query.
  descriptor() { return { table: this.table, op: this.op, eq: { ...this.eqs }, in: { ...this.ins }, cols: this.cols }; }

  run() {
    const q = this.descriptor();
    world.log.push(q);
    if (world.failWhen && world.failWhen(q)) return { data: null, count: null, error: { message: world.failMessage || 'fake read failure' } };
    if (this.op === 'insert') {
      const now = new Date().toISOString();
      const defaults = world.columnDefaults?.[this.table] || {};
      const added = this.payload.map((r) => {
        const row = { id: randomUUID(), created_at: now, ...structuredClone(r) };
        for (const [col, make] of Object.entries(defaults)) if (row[col] === undefined) row[col] = make();
        return row;
      });
      const unique = world.uniqueKeys?.[this.table] || [];
      for (const keyOf of unique) {
        const seen = new Set(this.rows().map(keyOf).filter((k) => k !== null && k !== undefined));
        for (const r of added) {
          const k = keyOf(r);
          if (k === null || k === undefined) continue;
          if (seen.has(k)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          seen.add(k);
        }
      }
      this.rows().push(...added);
      return this.returning ? this.finish(added) : { data: null, error: null };
    }
    if (this.op === 'update') {
      const hit = this.matching();
      for (const r of hit) Object.assign(r, structuredClone(this.payload));
      return this.returning ? this.finish(hit) : { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const now = new Date().toISOString();
      const keys = this.onConflict || [];
      const affected = [];
      for (const incoming of this.payload) {
        const row = structuredClone(incoming);
        const existing = keys.length
          ? this.rows().find((r) => keys.every((k) => r[k] !== undefined && row[k] !== undefined && cmp(r[k], row[k]) === 0))
          : null;
        if (existing) {
          // ignore-duplicates answers only the rows it INSERTED (PostgREST's
          // `resolution=ignore-duplicates`): a kept row is not in the answer.
          if (!this.ignoreDuplicates) { Object.assign(existing, row); affected.push(existing); }
        } else {
          const added = { id: randomUUID(), created_at: now, ...row };
          this.rows().push(added);
          affected.push(added);
        }
      }
      return this.returning ? this.finish(affected) : { data: null, error: null };
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

  // Thenable like the real builder: `await query` runs it. The barrier is awaited first,
  // so a suite can hold this statement open while another request runs to completion.
  then(onFulfilled, onRejected) {
    return Promise.resolve()
      .then(() => (world.beforeQuery ? world.beforeQuery(this.descriptor()) : null))
      .then(() => this.run())
      .then(onFulfilled, onRejected);
  }
}

// Every filter a statement used, in order, as { op, col } (`or` carries its whole expression as
// `col`; `contains` also its `value`), its ORDER BY (`orders`) and the OFFSET and LIMIT it paged at
// — on the descriptor `world.log` keeps, so a suite can prove HOW a read was shaped: a column a
// real index serves (the jobs reads' `data->crewIds`, CS-677), keyset rather than OFFSET pages
// (CS-676), an ordered and bounded page that names the area it looks for (CS-701).
for (const op of ['eq', 'neq', 'gte', 'lte', 'gt', 'lt', 'contains', 'in', 'is', 'not', 'or']) {
  const orig = FakeQuery.prototype[op];
  FakeQuery.prototype[op] = function noteFilter(c, ...rest) {
    (this.ops || (this.ops = [])).push(op === 'contains' ? { op, col: c, value: rest[0] } : { op, col: c });
    return orig.call(this, c, ...rest);
  };
}
const plainDescriptor = FakeQuery.prototype.descriptor;
FakeQuery.prototype.descriptor = function describeWithFilters() {
  return {
    ...plainDescriptor.call(this), ops: [...(this.ops || [])], offset: this.offset, limit: this.lim,
    orders: this.orders.map((o) => ({ ...o })),
  };
};
