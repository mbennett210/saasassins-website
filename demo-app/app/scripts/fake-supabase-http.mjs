// A local stand-in for the slice of Supabase's HTTP APIs the org_state save route
// uses, so an offline suite can drive the REAL handler through the REAL client:
//   GoTrue    GET /auth/v1/user             (the bearer token → the user, with app_metadata)
//   PostgREST /rest/v1/org_state            GET + PATCH (select with `a:state->b`, eq, lte, is.null, or)
//             /rest/v1/crew_assignments     GET, POST, DELETE (id=in.(…))
//             /rest/v1/activity_log         POST (the CS-379 audit rows the save route writes)
//             /rest/v1/activity_log_baseline GET + upsert (its org-state change detector)
// Anything else answers 404 and lands in `unknown`, so a suite can assert it saw none.
// A GET honours `order=` and `limit=` the way PostgREST does, so a suite that pins
// "newest first, bounded" is really testing the query and not the insertion order.
//
// jsonb is returned the way Postgres returns it: object keys SHORTEST FIRST, then
// bytewise, not in the order they were written. The client writes keys sorted
// (canonicalJson), so a fake that echoed them back in order would hide exactly the
// key-order bugs this exists to catch.
//
// `stampRowVersion: ['jobs']` emulates a table's row-version TRIGGER (public.jobs restamps
// `row_version` from a sequence on every insert and update, 20260720010000): a write's own
// value is replaced by the next number, so a compare-and-swap on it is tested against a
// version that really moves. Off unless a suite names the table.
// `failWrites(table)` answers that table's inserts, updates and deletes with a 500 while its
// reads still work, so a suite can drive a handler's failed-write path in isolation.
//
// Not a test file (no `test-` prefix): run-tests.mjs neither runs nor scans it.
//
//   const fake = await startFakeSupabase({ authUsers: { tokenA: { id, email, app_metadata } }, rows: { org_state: [row] } });
//   process.env.SUPABASE_URL = fake.url;  …  fake.reads(/users:state->users/)  …  await fake.close();
import http from 'node:http';

const byteOrder = (a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b));
export function jsonbOrder(v) {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort(byteOrder).map((k) => [k, jsonbOrder(v[k])]));
}

// `a:state->b,version` → [{ name: 'a', col: 'state', key: 'b' }, { name: 'version', col: 'version' }]
function parseSelect(select) {
  if (!select || select === '*') return null;
  return select.split(',').filter(Boolean).map((item) => {
    const [alias, expr] = item.includes(':') ? item.split(':') : [null, item];
    const [col, key] = expr.split('->');
    return { name: alias || key || col, col, key };
  });
}

const JSONB = new Set(['state']);
function project(row, cols) {
  const out = {};
  for (const c of cols || Object.keys(row).map((k) => ({ name: k, col: k }))) {
    let v = row[c.col];
    if (c.key !== undefined) v = v && typeof v === 'object' ? v[c.key] : undefined;
    out[c.name] = JSONB.has(c.col) ? jsonbOrder(v ?? null) : (v ?? null);
  }
  return out;
}

// One PostgREST filter value (`eq.5`, `is.null`, `lte.7`, `in.(a,b)`, `cs.{json}`) → predicate.
// The column may be a JSON path into one, as PostgREST takes it (`data->crewIds`, a cleaner's
// cleans, CS-677; `data->>recurrence`): the path's value is what the filter sees — `->>` as
// TEXT, with JSON null as SQL NULL.
function predicate(col, spec) {
  const path = /^(\w+)((?:->>?\w+)+)$/.exec(col);
  if (!path) return plainPredicate(col, spec);
  const inner = plainPredicate(col, spec);
  return (r) => {
    let v = r[path[1]];
    let text = false;
    for (const [, op, key] of path[2].matchAll(/(->>?)(\w+)/g)) {
      v = v && typeof v === 'object' ? v[key] : undefined;
      text = op === '->>';
    }
    const cell = v === undefined || v === null ? null : (text && typeof v !== 'string' ? JSON.stringify(v) : v);
    return inner({ ...r, [col]: cell });
  };
}
function plainPredicate(col, spec) {
  const dot = spec.indexOf('.');
  const op = spec.slice(0, dot);
  const val = spec.slice(dot + 1);
  if (op === 'eq') return (r) => r[col] != null && String(r[col]) === val;
  if (op === 'neq') return (r) => String(r[col] ?? '') !== val;
  // `lte` on a number (the org_state fleet gate's build number) or an ISO instant (the auto-close
  // cron's `scheduled_end` cutoff): numerically when both sides are numbers, else as text, which
  // sorts ISO-8601 in time order exactly as `gte` / `lt` / `gt` below already compare it.
  if (op === 'lte') {
    const num = (x) => (x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
    return (r) => {
      if (r[col] == null) return false;
      const a = num(r[col]); const b = num(val);
      return a != null && b != null ? a <= b : String(r[col]) <= val;
    };
  }
  if (op === 'gte') return (r) => r[col] != null && String(r[col]) >= val;
  // `lt` / `gt` on an ISO instant or a number. ISO-8601 sorts lexically in the same order
  // it sorts chronologically, which is why `gte` above already compares as a string; these
  // two do the same so a timestamp cutoff (`.lt('clock_in_at', cutoffIso)`) works.
  if (op === 'lt') return (r) => r[col] != null && String(r[col]) < val;
  if (op === 'gt') return (r) => r[col] != null && String(r[col]) > val;
  if (op === 'is' && val === 'null') return (r) => r[col] == null;
  if (op === 'not' && /^is\.null$/.test(val)) return (r) => r[col] != null;
  if (op === 'in') {
    const set = new Set(val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));
    return (r) => r[col] != null && set.has(String(r[col]));
  }
  // jsonb CONTAINS (supabase-js .contains('data', {crewIds:[id]}) → data=cs.{"crewIds":["id"]};
  // .contains('data->crewIds', '["id"]') → data->crewIds=cs.["id"]), used by getCrewJobRows /
  // getJobsAtSite to filter public.jobs by data.crewIds membership.
  if (op === 'cs') {
    let obj = null;
    try { obj = JSON.parse(val); } catch { obj = null; }
    return (r) => {
      const cell = r[col];
      if (!obj || !cell || typeof cell !== 'object') return false;
      if (Array.isArray(obj)) return Array.isArray(cell) && obj.every((x) => cell.includes(x));
      return Object.entries(obj).every(([k, v]) => {
        const cv = cell[k];
        if (Array.isArray(v)) return Array.isArray(cv) && v.every((x) => cv.includes(x));
        return cv === v;
      });
    };
  }
  throw new Error(`fake-supabase-http: filter ${col}=${spec} unsupported`);
}

// `order=performed_at.desc,id.desc` → a comparator. Nulls sort last either way, as
// PostgREST's default (NULLS LAST on asc, NULLS FIRST on desc) is close enough for a
// fake; what matters is that a suite cannot pass by relying on insertion order.
function ordering(spec) {
  if (!spec) return null;
  const keys = spec.split(',').filter(Boolean).map((k) => {
    const [col, ...mods] = k.split('.');
    return { col, desc: mods.includes('desc') };
  });
  return (a, b) => {
    for (const { col, desc } of keys) {
      const x = a[col]; const y = b[col];
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  };
}

function filters(params) {
  const preds = [];
  for (const [k, v] of params) {
    // `on_conflict` names an UPSERT's conflict target, not a row filter (see the POST branch).
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    if (k === 'or') {
      const any = v.replace(/^\(|\)$/g, '').split(',').map((p) => {
        const [col, ...rest] = p.split('.');
        return predicate(col, rest.join('.'));
      });
      preds.push((r) => any.some((p) => p(r)));
    } else preds.push(predicate(k, v));
  }
  return (r) => preds.every((p) => p(r));
}

export async function startFakeSupabase({ authUsers = {}, rows = {}, rpcs = {}, stampRowVersion = [] } = {}) {
  // activity_log + activity_log_baseline are here by DEFAULT because the org_state save
  // route writes them on every commit (CS-379): a fake without them answered 404, which
  // made the route's audit writer report a failure on every save in every suite that
  // drives it, and put two 'unknown' calls into suites that assert they saw none.
  const tables = { org_state: [], crew_assignments: [], activity_log: [], activity_log_baseline: [], ...rows };
  const failing = new Map(); // table -> the message its reads answer 500 with
  const failingWrites = new Map(); // table -> the message its writes answer 500 with
  const stamped = new Set(stampRowVersion);
  let rowVersionSeq = 1000;
  const stamp = (table, row) => { if (stamped.has(table)) row.row_version = (rowVersionSeq += 1); return row; };
  const requests = [];
  const unknown = [];
  let nextId = 1;
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  // 🔴 `.single()` / `.maybeSingle()` ask PostgREST for the OBJECT form through the Accept
  // header, and PostgREST answers with the row itself, not a one-element array. The fake
  // always answered the array, so `const { data } = await db…insert(row).select('*').single()`
  // handed every caller `[{…}]` — `data.some_column` was undefined, and `if (maybeSingleRow)`
  // was truthy on an empty result. Harmless while suites read the table rather than the
  // answer, and a silent wrong answer the moment one reads the answer. So the fake honours
  // the header, including PostgREST's 406/PGRST116 when the result is not exactly one row
  // (which is what makes `maybeSingle()` resolve to null and `single()` error, as in prod).
  const PGRST_OBJECT = /application\/vnd\.pgrst\.object\+json/;
  const sendRows = (req, res, status, rows, headers = {}) => {
    if (!PGRST_OBJECT.test(req.headers.accept || '')) return send(res, status, rows, headers);
    if (rows.length === 1) return send(res, status, rows[0], headers);
    return send(res, 406, {
      code: 'PGRST116',
      message: 'JSON object requested, multiple (or no) rows returned',
      details: `The result contains ${rows.length} rows`,
      hint: null,
    }, headers);
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://fake');
        requests.push({ method: req.method, path: url.pathname, select: url.searchParams.get('select') || '' });
        if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
          const token = (req.headers.authorization || '').replace(/^Bearer /, '');
          const user = authUsers[token];
          return user ? send(res, 200, user) : send(res, 401, { code: 401, msg: 'invalid JWT' });
        }
        // A service-role RPC (`db.rpc(name, args)`). Only the ones a suite declares exist;
        // anything else stays an `unknown` 404, so a handler calling a function nobody
        // modelled is still caught rather than silently answered.
        const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
        if (rpc) {
          const fn = rpcs[rpc[1]];
          if (!fn) { unknown.push(`${req.method} ${url.pathname}`); return send(res, 404, { message: 'rpc not in the fake' }); }
          return send(res, 200, fn(JSON.parse(raw || '{}')));
        }
        const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
        // A table a suite has put into failure: PostgREST's own shape for a refused read,
        // so a handler's error path is exercised with provider text it must not leak.
        if (m && failing.has(m[1])) return send(res, 500, { code: '42501', message: failing.get(m[1]), details: null, hint: null });
        if (m && failingWrites.has(m[1]) && req.method !== 'GET' && req.method !== 'HEAD') {
          return send(res, 500, { code: '42501', message: failingWrites.get(m[1]), details: null, hint: null });
        }
        const table = m && tables[m[1]];
        if (!table) { unknown.push(`${req.method} ${url.pathname}`); return send(res, 404, { message: 'not in the fake' }); }
        const match = filters(url.searchParams);
        const cols = parseSelect(url.searchParams.get('select'));
        const wantRows = /return=representation/.test(req.headers.prefer || '');
        // A count read: `select('id', { count: 'exact', head: true })` is a HEAD whose
        // answer is the Content-Range header, not a body. The count half of every complete
        // read (_lib/pagedSelect selectAll) goes through here.
        if (req.method === 'HEAD') {
          const n = table.filter(match).length;
          return send(res, 200, undefined, { 'Content-Range': `*/${n}` });
        }
        if (req.method === 'GET') {
          let hit = table.filter(match);
          const order = ordering(url.searchParams.get('order'));
          if (order) hit = hit.slice().sort(order);
          const total = hit.length;
          // `.range(from, to)` becomes offset + limit in supabase-js. A fake that applied
          // `limit` but ignored `offset` serves the FIRST n rows to every page of a paged
          // read, so the reader never advances — it loops, or reads page one forever.
          const num = (k) => (url.searchParams.has(k) && Number.isFinite(Number(url.searchParams.get(k))) ? Number(url.searchParams.get(k)) : null);
          const offset = num('offset') ?? 0;
          const lim = num('limit');
          hit = hit.slice(offset, lim == null ? undefined : offset + lim);
          const headers = (offset || lim != null)
            ? { 'Content-Range': `${offset}-${Math.max(offset, offset + hit.length - 1)}/${total}` }
            : {};
          return sendRows(req, res, 200, hit.map((r) => project(r, cols)), headers);
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse(raw || '{}');
          const hit = table.filter(match);
          for (const r of hit) stamp(m[1], Object.assign(r, patch));
          return wantRows ? sendRows(req, res, 200, hit.map((r) => project(r, cols))) : send(res, 204);
        }
        if (req.method === 'POST') {
          const add = [].concat(JSON.parse(raw || '[]')).map((r) => ({ id: `row${nextId++}`, ...r }));
          // An UPSERT is a POST with `on_conflict=<cols>` and `Prefer: resolution=merge-duplicates`.
          // Appending instead would leave two rows where the real table keeps one, and the next
          // `.maybeSingle()` read of it would then error — so the conflict target is matched by
          // value (no unique index is emulated) and a hit is merged in place.
          const onConflict = (url.searchParams.get('on_conflict') || '').split(',').map((c) => c.trim()).filter(Boolean);
          if (onConflict.length && /merge-duplicates/.test(req.headers.prefer || '')) {
            const affected = [];
            for (const row of add) {
              const hit = table.find((r) => onConflict.every((k) => r[k] !== undefined && row[k] !== undefined && String(r[k]) === String(row[k])));
              if (hit) { stamp(m[1], Object.assign(hit, row)); affected.push(hit); } else { table.push(stamp(m[1], row)); affected.push(row); }
            }
            return wantRows ? sendRows(req, res, 201, affected.map((r) => project(r, cols))) : send(res, 201);
          }
          table.push(...add.map((r) => stamp(m[1], r)));
          return wantRows ? sendRows(req, res, 201, add.map((r) => project(r, cols))) : send(res, 201);
        }
        if (req.method === 'DELETE') {
          const keep = table.filter((r) => !match(r));
          table.splice(0, table.length, ...keep);
          return send(res, 204);
        }
        unknown.push(`${req.method} ${url.pathname}`);
        return send(res, 405, { message: 'method not in the fake' });
      } catch (e) {
        unknown.push(`${req.method} ${req.url}: ${e.message}`);
        return send(res, 500, { message: e.message });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    tables,
    requests,
    unknown,
    // How many requests so far read org_state with a select matching `re`.
    reads: (re) => requests.filter((r) => r.method === 'GET' && r.path === '/rest/v1/org_state' && re.test(r.select)).length,
    // Put a table into failure (and take it out), so a suite can drive a handler's
    // read-failure path — the half no happy-path test reaches.
    fail: (table, message = 'fake: read failed') => failing.set(table, message),
    clearFailures: () => failing.clear(),
    failWrites: (table, message = 'fake: write failed') => failingWrites.set(table, message),
    clearWriteFailures: () => failingWrites.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
