// A PostgREST stand-in for the offline suites — the slice of the supabase-js query
// builder the server stores use (select / eq / neq / gte / lte / gt / lt / in / is /
// not-is-null / or / order / range / limit / count+head), with the behavior these suites
// exist to pin: db-max-rows. NO response carries more than `maxRows` rows, whatever
// .range() or .limit() asked for — Supabase's default is 1000, and it is exactly how a
// "limit 5000" read quietly came back with 1000.
//
// Not a test file (no `test-` prefix), so run-tests.mjs neither runs nor scans it.
//
//   const db = fakeDb({ time_entries: rows }, { maxRows: 1000 });
//   db.failNext(2);          // the next 2 queries return { error } (transient failure)
//   db.calls                 // { select, count } — how many queries ran
//
// Two more PostgREST behaviors, both opt-in or additive:
//   · select() takes JSON paths — `col->key` / `col->>key`, optionally aliased
//     (`name:col->>key`); unaliased, the field is named after the path's last key.
//   · { uuidColumns: { table: ['id'] } } types those columns as uuid: a filter comparing
//     one to a literal that isn't a uuid fails the query with Postgres's 22P02, as the
//     real database does (`eq('id', '__none__')` is an error there, not "no rows").

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fakeDb(tables = {}, { maxRows = 1000, uuidColumns = {} } = {}) {
  const db = {
    tables,
    maxRows,
    uuidColumns,
    calls: { select: 0, count: 0 },
    pendingFailures: 0,
    failNext(n = 1) { db.pendingFailures += n; },
    from(table) { return new Query(db, table); },
  };
  return db;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string' && ISO_RE.test(a) && ISO_RE.test(b)) {
    return Date.parse(a) - Date.parse(b);
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// `a.in.(x,y),b.eq.z` → predicates. Commas inside parentheses belong to the list.
function parseOr(expr) {
  const parts = [];
  let depth = 0; let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => {
    const [col, op, ...rest] = p.split('.');
    const val = rest.join('.');
    if (op === 'in') {
      const set = new Set(val.replace(/^\(|\)$/g, '').split(',').filter(Boolean));
      return (r) => r[col] != null && set.has(String(r[col]));
    }
    if (op === 'eq') return (r) => r[col] != null && String(r[col]) === val;
    throw new Error(`fake-postgrest: or() op "${op}" unsupported`);
  });
}

// `col`, `alias:col`, `col->key`, `col->>key`, `alias:col->>key` (and deeper paths).
function selectColumns(cols) {
  return cols.split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
    const m = /^([A-Za-z_]\w*):(?!:)(.+)$/.exec(spec);
    const path = m ? m[2] : spec;
    const parts = path.split(/(->>?)/);
    const col = parts[0];
    const keys = [];
    for (let i = 1; i < parts.length; i += 2) keys.push({ key: parts[i + 1], text: parts[i] === '->>' });
    return { name: m ? m[1] : (keys.length ? keys[keys.length - 1].key : col), col, keys };
  });
}

function project(row, cols) {
  if (!cols || cols === '*') return { ...row };
  const out = {};
  for (const { name, col, keys } of selectColumns(cols)) {
    if (!keys.length) { out[name] = row[col]; continue; }
    let v = row[col];
    for (const { key } of keys) v = v != null && typeof v === 'object' ? v[key] : undefined;
    const text = keys[keys.length - 1].text;
    out[name] = v == null ? null : (text && typeof v !== 'string' ? JSON.stringify(v) : v);
  }
  return out;
}

class Query {
  constructor(db, table) {
    this.db = db; this.table = table;
    this.filters = []; this.orders = [];
    this.offset = 0; this.lim = null;
    this.cols = '*'; this.countMode = null; this.head = false;
    this.typeError = null;
  }

  // A uuid column compared to a literal that isn't one: the query fails (22P02).
  typed(c, vals) {
    if (!this.typeError && (this.db.uuidColumns[this.table] || []).includes(c)) {
      const bad = vals.find((v) => v != null && !UUID_RE.test(String(v)));
      if (bad !== undefined) this.typeError = { code: '22P02', message: `invalid input syntax for type uuid: "${bad}"` };
    }
    return this;
  }

  select(cols = '*', opts = {}) { this.cols = cols; if (opts.count) this.countMode = opts.count; if (opts.head) this.head = true; return this; }
  eq(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) === 0); return this.typed(c, [v]); }
  neq(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) !== 0); return this.typed(c, [v]); }
  gte(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this.typed(c, [v]); }
  lte(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this.typed(c, [v]); }
  gt(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) > 0); return this.typed(c, [v]); }
  lt(c, v) { this.filters.push((r) => r[c] != null && cmp(r[c], v) < 0); return this.typed(c, [v]); }
  in(c, arr) { const s = new Set(arr); this.filters.push((r) => r[c] != null && s.has(r[c])); return this.typed(c, arr); }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, op, v) {
    if (op === 'is' && v === null) { this.filters.push((r) => r[c] != null); return this; }
    throw new Error(`fake-postgrest: not.${op} unsupported`);
  }
  or(expr) { const preds = parseOr(expr); this.filters.push((r) => preds.some((p) => p(r))); return this; }
  order(c, { ascending = true } = {}) { this.orders.push({ c, asc: ascending }); return this; }
  range(a, b) { this.offset = a; this.lim = b - a + 1; return this; }
  limit(n) { this.lim = n; return this; }
  abortSignal() { return this; }

  run() {
    if (this.db.pendingFailures > 0) {
      this.db.pendingFailures -= 1;
      return { data: null, count: null, error: { message: 'fake transient failure' } };
    }
    if (this.typeError) return { data: null, count: null, error: this.typeError };
    let rows = (this.db.tables[this.table] || []).filter((r) => this.filters.every((f) => f(r)));
    if (this.countMode && this.head) {
      this.db.calls.count += 1;
      return { data: null, count: rows.length, error: null };
    }
    this.db.calls.select += 1;
    if (this.orders.length) {
      rows = rows.slice().sort((x, y) => {
        for (const { c, asc } of this.orders) {
          const d = cmp(x[c], y[c]);
          if (d !== 0) return asc ? d : -d;
        }
        return 0;
      });
    }
    const want = this.lim == null ? rows.length : this.lim;
    const take = Math.max(0, Math.min(want, this.db.maxRows));
    const data = rows.slice(this.offset, this.offset + take).map((r) => project(r, this.cols));
    return { data, count: this.countMode ? rows.length : null, error: null };
  }

  // Thenable like the real builder: `await query` runs it.
  then(onFulfilled, onRejected) {
    return Promise.resolve().then(() => this.run()).then(onFulfilled, onRejected);
  }
}
