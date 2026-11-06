// A local stand-in for the two Supabase services the API routes call, so an offline suite
// can drive a REAL handler through the REAL supabase-js client (its request building, its
// response parsing) without a live project. Point SUPABASE_URL at it before the handler
// module is imported (the clients are built on first use).
//   GoTrue    GET /auth/v1/user (by bearer token) · GET|POST /auth/v1/admin/users ·
//             PUT|DELETE /auth/v1/admin/users/:id · POST /auth/v1/admin/generate_link
//   PostgREST GET|PATCH /rest/v1/org_state (select items `col` and `alias:col->key`),
//             GET /rest/v1/time_entries (eq / gte / lte / in, order, offset + limit),
//             GET|POST|DELETE /rest/v1/crew_assignments (an empty table),
//             GET|HEAD|POST|PATCH|DELETE /rest/v1/<any table a suite seeds through reset({ tables })>
//             (the same filters, order, offset + limit, a count=exact Content-Range; a POST appends,
//             or upserts on `on_conflict`; PATCH/DELETE by the filters) — an unseeded table still 404s
//   Storage   POST /storage/v1/object/<bucket>/<path> (upload; `x-upsert`) ·
//             POST /storage/v1/object/list/<bucket> (one folder level, folders as `id: null`,
//             by name, offset + limit) · DELETE /storage/v1/object/<bucket> (`prefixes` =
//             exact object names, as Storage deletes them) · POST /storage/v1/object/sign/<bucket>
//             (createSignedUrls: a missing object answers its entry with an error, as Storage does)
// Only what the users + org_state + team-photo routes need. Anything else answers 404, so a
// new call shows up as a failing request rather than a silent pass.
//
// Not a test file (no `test-` prefix), so run-tests.mjs neither runs nor scans it.
//
//   const fake = await startFakeSupabase();   // fake.url → SUPABASE_URL
//   fake.reset({ authUsers, tokens, orgState, timeEntries, objects, tables });
//                                              // tables: { <name>: [rows] } → fake.db.tables
//   fake.failTable('time_entries');            // that table answers 500 until reset
//   fake.intercept((q, db) => …);              // sees each request first ({ method, path,
//                                              // table, select }); may change db; 'fail' → 500
//   fake.answer((q) => ({ status, body }));    // answers a request no route below knows
//                                              // (e.g. an rpc); null/undefined → the 404
//   fake.requests                               // every request, for "was X ever called"
//   fake.db.objects                             // "<bucket>/<path>" → { bytes, contentType,
//                                              // cacheControl, created_at }
//   await fake.close();
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export async function startFakeSupabase() {
  const db = { authUsers: [], tokens: new Map(), orgState: null, timeEntries: [], objects: new Map(), tables: new Map(), failing: new Set(), intercept: null, answer: null };
  const requests = [];

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  // The raw bytes, then JSON when they parse (a Storage upload is bytes; everything else JSON).
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(Buffer.from(c)); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let json = {};
      try { json = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { json = {}; }
      resolve({ raw, json });
    });
  });

  // PostgREST `select=` items: `col`, or `alias:col->key` (one JSON level, as the routes use).
  const project = (row, select) => {
    if (!select || select === '*') return { ...row };
    const out = {};
    for (const raw of select.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^(?:([A-Za-z_][\w]*):)?([A-Za-z_][\w]*)(?:->([A-Za-z_][\w]*))?$/.exec(raw);
      if (!m) throw new Error(`fake-supabase: select item "${raw}" unsupported`);
      const [, alias, col, key] = m;
      out[alias || (key ? key : col)] = key ? (row[col] && typeof row[col] === 'object' ? row[col][key] ?? null : null) : row[col] ?? null;
    }
    return out;
  };
  // `a=eq.x`, `a=neq.x`, `a=gte.x`, `a=gt.x`, `a=lte.x`, `a=lt.x`, `a=in.(x,"y")`, `a=is.null`,
  // `a=not.is.null` — every other param is ignored. (Strings compare as text: an ISO time compares
  // in time order only when both sides are written the same way, as the routes write them.)
  const filtersOf = (params) => {
    const out = [];
    for (const [col, v] of params) {
      if (['select', 'order', 'offset', 'limit', 'or', 'on_conflict', 'columns'].includes(col)) continue;
      const dot = v.indexOf('.');
      const op = v.slice(0, dot);
      const val = v.slice(dot + 1);
      if (op === 'eq') out.push((r) => r[col] != null && String(r[col]) === val);
      else if (op === 'neq') out.push((r) => r[col] == null || String(r[col]) !== val);
      else if (op === 'gte') out.push((r) => r[col] != null && String(r[col]) >= val);
      else if (op === 'gt') out.push((r) => r[col] != null && String(r[col]) > val);
      else if (op === 'lte') out.push((r) => r[col] != null && String(r[col]) <= val);
      else if (op === 'lt') out.push((r) => r[col] != null && String(r[col]) < val);
      else if (op === 'not' && val === 'is.null') out.push((r) => r[col] != null);
      else if (op === 'in') {
        const set = new Set(val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean));
        out.push((r) => r[col] != null && set.has(String(r[col])));
      } else if (op === 'is' && val === 'null') out.push((r) => r[col] == null);
      else throw new Error(`fake-supabase: filter ${col}=${v} unsupported`);
    }
    return out;
  };
  const orderRows = (rows, order) => {
    if (!order) return rows;
    const keys = order.split(',').map((o) => { const [c, dir] = o.split('.'); return { c, desc: dir === 'desc' }; });
    return rows.slice().sort((a, b) => {
      for (const { c, desc } of keys) {
        const x = String(a[c] ?? ''); const y = String(b[c] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const { raw, json: body } = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : { raw: Buffer.alloc(0), json: {} };
    requests.push({ method: req.method, path, query: url.search, body });
    try {
      // A test's interceptor sees each request first (and may change the data): 'fail'
      // answers it 500, as a transient database error would.
      if (db.intercept) {
        const table = /^\/rest\/v1\/([a-z_]+)$/.exec(path)?.[1] ?? null;
        if (db.intercept({ method: req.method, path, table, select: url.searchParams.get('select') }, db) === 'fail') {
          return send(res, 500, { code: 'XX000', message: 'fake: intercepted failure' });
        }
      }
      // ── GoTrue ─────────────────────────────────────────────────────────────
      if (path === '/auth/v1/user' && req.method === 'GET') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
        const id = db.tokens.get(token);
        const u = db.authUsers.find((x) => x.id === id);
        if (!u) return send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
        return send(res, 200, u);
      }
      if (path === '/auth/v1/admin/users' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        const per = Number(url.searchParams.get('per_page') || 50);
        return send(res, 200, { aud: 'authenticated', users: db.authUsers.slice((page - 1) * per, page * per) });
      }
      if (path === '/auth/v1/admin/users' && req.method === 'POST') {
        if (db.authUsers.some((x) => x.email === String(body.email || '').toLowerCase())) {
          return send(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
        }
        const u = { id: randomUUID(), email: String(body.email || '').toLowerCase(), app_metadata: { provider: 'email', providers: ['email'], ...(body.app_metadata || {}) }, user_metadata: {}, banned_until: null, created_at: new Date().toISOString() };
        db.authUsers.push(u);
        return send(res, 200, u);
      }
      const one = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(path);
      if (one) {
        const u = db.authUsers.find((x) => x.id === one[1]);
        if (!u) return send(res, 404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
        if (req.method === 'PUT') {
          // GoTrue MERGES app_metadata key by key; a ban_duration of 'none' lifts a ban.
          if (body.app_metadata) u.app_metadata = { ...(u.app_metadata || {}), ...body.app_metadata };
          if (body.ban_duration !== undefined) {
            u.banned_until = body.ban_duration === 'none' ? null : new Date(Date.now() + 100 * 365 * 864e5).toISOString();
          }
          return send(res, 200, u);
        }
        if (req.method === 'DELETE') {
          db.authUsers = db.authUsers.filter((x) => x.id !== u.id);
          return send(res, 200, {});
        }
        if (req.method === 'GET') return send(res, 200, u);
      }
      if (path === '/auth/v1/admin/generate_link' && req.method === 'POST') {
        const u = db.authUsers.find((x) => x.email === String(body.email || '').toLowerCase());
        if (!u) return send(res, 404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
        return send(res, 200, { ...u, action_link: `http://127.0.0.1/verify?token=${randomUUID()}`, email_otp: '000000', hashed_token: 'h', redirect_to: body.redirect_to || '', verification_type: 'recovery' });
      }

      // ── PostgREST ──────────────────────────────────────────────────────────
      const table = /^\/rest\/v1\/([a-z_]+)$/.exec(path)?.[1];
      if (table && db.failing.has(table)) return send(res, 500, { code: 'XX000', message: `fake: ${table} is failing` });
      if (table === 'org_state') {
        const rows = db.orgState ? [db.orgState] : [];
        const hit = rows.filter((r) => filtersOf(url.searchParams).every((f) => f(r)));
        if (req.method === 'GET') return send(res, 200, hit.map((r) => project(r, url.searchParams.get('select'))));
        if (req.method === 'PATCH') {
          for (const r of hit) Object.assign(r, body);
          return send(res, 200, hit.map((r) => project(r, url.searchParams.get('select'))));
        }
      }
      if (table === 'time_entries' && req.method === 'GET') {
        const hit = orderRows(db.timeEntries.filter((r) => filtersOf(url.searchParams).every((f) => f(r))), url.searchParams.get('order'));
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : hit.length;
        return send(res, 200, hit.slice(offset, offset + limit).map((r) => project(r, url.searchParams.get('select'))));
      }
      if (table === 'crew_assignments') {
        if (req.method === 'GET') return send(res, 200, []);
        return send(res, req.method === 'POST' ? 201 : 200, []);
      }
      // A table the suite seeded (reset({ tables })): a read filters, orders and pages like
      // time_entries (a `count=exact` read answers Content-Range, a HEAD no body); a POST appends
      // (an object or an array) — with `on_conflict` it is an upsert: `resolution=ignore-
      // duplicates` keeps an existing row and answers only the rows it inserted, else the row is
      // merged; a PATCH updates the rows its filters match; a DELETE removes them. Each returns
      // the rows only when asked (`return=representation`).
      if (table && db.tables.has(table)) {
        const rows = db.tables.get(table);
        const prefer = String(req.headers.prefer || '');
        const wantRows = /return=representation/.test(prefer);
        const matches = () => rows.filter((r) => filtersOf(url.searchParams).every((f) => f(r)));
        if (req.method === 'GET' || req.method === 'HEAD') {
          const hit = orderRows(matches(), url.searchParams.get('order'));
          const offset = Number(url.searchParams.get('offset') || 0);
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : hit.length;
          const counted = /count=exact/.test(prefer) ? { 'Content-Range': `${hit.length ? `${offset}-${Math.min(hit.length, offset + limit) - 1}` : '*'}/${hit.length}` } : {};
          if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json', ...counted }); return res.end(); }
          return send(res, 200, hit.slice(offset, offset + limit).map((r) => project(r, url.searchParams.get('select'))), counted);
        }
        if (req.method === 'POST') {
          const incoming = (Array.isArray(body) ? body : [body]).map((r) => ({ ...r }));
          const conflict = url.searchParams.get('on_conflict');
          if (!conflict) {
            rows.push(...incoming);
            return wantRows ? send(res, 201, incoming.map((r) => project(r, url.searchParams.get('select')))) : send(res, 201);
          }
          const cols = conflict.split(',').map((c) => c.trim());
          const same = (a, b) => cols.every((c) => String(a[c]) === String(b[c]));
          const ignore = /resolution=ignore-duplicates/.test(prefer);
          const written = [];
          for (const r of incoming) {
            const existing = rows.find((x) => same(x, r));
            if (!existing) { rows.push(r); written.push(r); } else if (!ignore) { Object.assign(existing, r); written.push(existing); }
          }
          return wantRows ? send(res, 201, written.map((r) => project(r, url.searchParams.get('select')))) : send(res, 201);
        }
        if (req.method === 'PATCH') {
          const hit = matches();
          for (const r of hit) Object.assign(r, body);
          return wantRows ? send(res, 200, hit.map((r) => project(r, url.searchParams.get('select')))) : send(res, 204);
        }
        if (req.method === 'DELETE') {
          const hit = new Set(matches());
          const kept = rows.filter((r) => !hit.has(r));
          rows.length = 0;
          rows.push(...kept);
          return wantRows ? send(res, 200, [...hit].map((r) => project(r, url.searchParams.get('select')))) : send(res, 204);
        }
      }

      // ── Storage ────────────────────────────────────────────────────────────
      if (path.startsWith('/storage/v1/object/')) {
        const rest = decodeURIComponent(path.slice('/storage/v1/object/'.length));
        // createSignedUrls: one entry per path, the missing ones with Storage's error.
        const sign = /^sign\/([^/]+)$/.exec(rest);
        if (sign && req.method === 'POST') {
          const bucket = sign[1];
          const paths = Array.isArray(body.paths) ? body.paths : [];
          return send(res, 200, paths.map((p) => (db.objects.has(`${bucket}/${p}`)
            ? { path: p, signedURL: `/object/sign/${bucket}/${p}?token=fake.${Number(body.expiresIn) || 0}`, error: null }
            : { path: p, signedURL: null, error: 'Either the object does not exist or you do not have access to it' })));
        }
        // list: the direct children of `prefix` (a folder level), folders with `id: null`.
        const list = /^list\/([^/]+)$/.exec(rest);
        if (list && req.method === 'POST') {
          const bucket = list[1];
          const prefix = String(body.prefix || '').replace(/\/+$/, '');
          const head = `${bucket}/${prefix ? `${prefix}/` : ''}`;
          const entries = new Map();
          for (const [key, o] of db.objects) {
            if (!key.startsWith(head)) continue;
            const tail = key.slice(head.length);
            const slash = tail.indexOf('/');
            if (slash === -1) {
              entries.set(tail, { name: tail, id: `obj-${tail}`, created_at: o.created_at, updated_at: o.created_at, last_accessed_at: o.created_at, metadata: { size: o.bytes.length, mimetype: o.contentType, cacheControl: o.cacheControl } });
            } else if (!entries.has(tail.slice(0, slash))) {
              const name = tail.slice(0, slash);
              entries.set(name, { name, id: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null });
            }
          }
          const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const offset = Number(body.offset) || 0;
          const limit = Number(body.limit) || 100;
          return send(res, 200, sorted.slice(offset, offset + limit));
        }
        // remove: exact object names only — Storage never deletes by prefix.
        if (req.method === 'DELETE' && /^[^/]+$/.test(rest)) {
          const bucket = rest;
          const out = [];
          for (const p of Array.isArray(body.prefixes) ? body.prefixes : []) {
            if (db.objects.delete(`${bucket}/${p}`)) out.push({ name: p, bucket_id: bucket });
          }
          return send(res, 200, out);
        }
        // upload: `<bucket>/<path>`, refusing an existing name unless x-upsert is true.
        const up = /^([^/]+)\/(.+)$/.exec(rest);
        if (up && req.method === 'POST') {
          const key = `${up[1]}/${up[2]}`;
          if (db.objects.has(key) && req.headers['x-upsert'] !== 'true') {
            return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
          }
          db.objects.set(key, {
            bytes: raw,
            contentType: req.headers['content-type'] || null,
            cacheControl: req.headers['cache-control'] || null,
            created_at: new Date().toISOString(),
          });
          return send(res, 200, { Id: randomUUID(), Key: key });
        }
      }

      if (db.answer) {
        const a = db.answer({ method: req.method, path, table: table ?? null, body });
        if (a) return send(res, a.status ?? 200, a.body);
      }
      return send(res, 404, { message: `fake-supabase: no route for ${req.method} ${path}` });
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    db,
    requests,
    reset({ authUsers = [], tokens = {}, orgState = null, timeEntries = [], objects = {}, tables = {} } = {}) {
      db.authUsers = JSON.parse(JSON.stringify(authUsers));
      db.tables = new Map(Object.entries(tables).map(([name, rows]) => [name, JSON.parse(JSON.stringify(rows))]));
      db.tokens = new Map(Object.entries(tokens));
      db.orgState = orgState ? JSON.parse(JSON.stringify(orgState)) : null;
      db.timeEntries = JSON.parse(JSON.stringify(timeEntries));
      // "<bucket>/<path>" → { bytes, contentType?, cacheControl?, created_at? } (seeded objects
      // may set an old created_at, for the reap's "older than a day").
      db.objects = new Map(Object.entries(objects).map(([k, o]) => [k, {
        bytes: Buffer.from(o.bytes ?? []), contentType: o.contentType ?? 'image/jpeg',
        cacheControl: o.cacheControl ?? null, created_at: o.created_at ?? new Date().toISOString(),
      }]));
      db.failing = new Set();
      db.intercept = null;
      db.answer = null;
      requests.length = 0;
    },
    failTable(name) { db.failing.add(name); },
    intercept(fn) { db.intercept = fn; },
    answer(fn) { db.answer = fn; },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}
