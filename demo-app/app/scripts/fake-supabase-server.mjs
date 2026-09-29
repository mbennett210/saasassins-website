// A local stand-in for the two Supabase services the API routes call, so an offline suite
// can drive a REAL handler through the REAL supabase-js client (its request building, its
// response parsing) without a live project. Point SUPABASE_URL at it before the handler
// module is imported (the clients are built on first use).
//   GoTrue    GET /auth/v1/user (by bearer token) · GET|POST /auth/v1/admin/users ·
//             PUT|DELETE /auth/v1/admin/users/:id · POST /auth/v1/admin/generate_link
//   PostgREST GET|PATCH /rest/v1/org_state (select items `col` and `alias:col->key`),
//             GET /rest/v1/time_entries (eq / gte / lte / in, order, offset + limit),
//             GET|POST|DELETE /rest/v1/crew_assignments (an empty table)
// Only what the users + org_state routes need. Anything else answers 404, so a new call
// shows up as a failing request rather than a silent pass.
//
// Not a test file (no `test-` prefix), so run-tests.mjs neither runs nor scans it.
//
//   const fake = await startFakeSupabase();   // fake.url → SUPABASE_URL
//   fake.reset({ authUsers, tokens, orgState, timeEntries });
//   fake.failTable('time_entries');            // that table answers 500 until reset
//   fake.intercept((q, db) => …);              // sees each request first ({ method, path,
//                                              // table, select }); may change db; 'fail' → 500
//   fake.requests                               // every request, for "was X ever called"
//   await fake.close();
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export async function startFakeSupabase() {
  const db = { authUsers: [], tokens: new Map(), orgState: null, timeEntries: [], failing: new Set(), intercept: null };
  const requests = [];

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
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
  // `a=eq.x`, `a=gte.x`, `a=lte.x`, `a=in.(x,"y")`, `a=is.null` — every other param is ignored.
  const filtersOf = (params) => {
    const out = [];
    for (const [col, v] of params) {
      if (['select', 'order', 'offset', 'limit', 'or'].includes(col)) continue;
      const dot = v.indexOf('.');
      const op = v.slice(0, dot);
      const val = v.slice(dot + 1);
      if (op === 'eq') out.push((r) => r[col] != null && String(r[col]) === val);
      else if (op === 'gte') out.push((r) => r[col] != null && String(r[col]) >= val);
      else if (op === 'lte') out.push((r) => r[col] != null && String(r[col]) <= val);
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
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
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
    reset({ authUsers = [], tokens = {}, orgState = null, timeEntries = [] } = {}) {
      db.authUsers = JSON.parse(JSON.stringify(authUsers));
      db.tokens = new Map(Object.entries(tokens));
      db.orgState = orgState ? JSON.parse(JSON.stringify(orgState)) : null;
      db.timeEntries = JSON.parse(JSON.stringify(timeEntries));
      db.failing = new Set();
      db.intercept = null;
      requests.length = 0;
    },
    failTable(name) { db.failing.add(name); },
    intercept(fn) { db.intercept = fn; },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}
