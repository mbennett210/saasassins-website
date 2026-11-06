// sync-harness.mjs — drive the REAL browser sync engine against the REAL save routes, offline.
//
// WHY (CS-064). `src/store/sync.js` decides what happens to every edit anyone makes — a save,
// a refusal, an outage, a conflict — and until this harness no test ever RAN it: suites read
// it as text. So the two ways it lost work (CS-008: one refused change dropped the whole
// pending batch and reported "synced"; CS-009: a dead direct-write fallback turned every
// failed save into a silent 600 ms loop) shipped with CI green.
//
// HOW. One in-process fake Supabase (scripts/fake-supabase.mjs) is shared by both halves:
//   · the SERVER: api/state/org-state.js, jobs-delta.js and seed.js, run as Vercel calls them,
//     their service-role client built by the fake (installFakeSupabase) — so a refusal is the
//     real guard's refusal, not a scripted one;
//   · the BROWSER: `src/lib/supabaseClient` is redirected to a wrapper of the same fake that
//     adds what only the browser client has (auth.getSession, realtime channels) and answers a
//     DIRECT browser write the way the live database has since Increment 1e (no write policy:
//     an UPDATE or DELETE matches nothing and reports no error, an INSERT or UPSERT is
//     refused) — and RECORDS it in `directWrites`, so a suite can prove none is attempted.
// `fetch` is a router that hands `/api/state/*` to the real handlers, unless a suite's
// `override(path)` answers first (the 500 / 413 / outage cases). Timers are VIRTUAL:
// setTimeout / setInterval queue on a clock the suite advances with `advance(ms)`, so a 600 ms
// debounce or a 5 s backoff is asserted, not waited for (`timerDelays()` lists what is armed).
//
// NOT a test file (no `test-` prefix): run-tests.mjs neither runs nor scans it.
//
//   const h = await createSyncHarness();
//   h.seedOrg(state, { logins });                 // the org_state row + the GoTrue logins
//   const tab = await h.bootTab('tok-mgr');       // a signed-in tab, booted through sync.js
//   tab.dispatchLocal(action);                    // what components do (store/index.jsx)
//   await h.advance(600);                         // the debounce fires; the save runs
//   h.committed()                                 // the org_state row now
//   h.directWrites                                // every direct browser write attempted
import { registerHooks } from 'node:module';
import { installFakeSupabase, world, resetWorld, createClient } from './fake-supabase.mjs';

export const ORG = '00000000-0000-0000-0000-000000000001';

let instance = null;

export async function createSyncHarness() {
  if (instance) return instance;

  // The server half reads these when its modules load; a closed local port, so even a
  // stray real client could reach nothing.
  Object.assign(process.env, {
    SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon',
    CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
  });
  delete process.env.ALERT_WEBHOOK_URL;
  installFakeSupabase();

  const h = {
    token: null,
    directWrites: [],          // { table, op } — every DIRECT browser write attempted
    requests: [],              // { path, search, method, status } — every /api call the browser made
    override: null,            // (path, init) => { status, body } | 'network' | null
    alerts: [],                // [ALERT] lines the server raised
  };

  // ── the browser's Supabase client ─────────────────────────────────────────────────────
  const channels = [];
  h.browserClient = {
    isHarnessBrowserClient: true,
    from(table) {
      const q = createClient('http://browser', 'anon').from(table);
      for (const op of ['update', 'upsert', 'insert', 'delete']) {
        const orig = q[op].bind(q);
        q[op] = (...args) => {
          orig(...args);
          h.directWrites.push({ table, op });
          // Increment 1e: no browser write policy on org_state or public.jobs. PostgREST
          // answers an UPDATE / DELETE the policy filters out with zero rows and no error,
          // and refuses an INSERT / UPSERT outright.
          q.run = () => (op === 'insert' || op === 'upsert'
            ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }
            : { data: [], error: null });
          return q;
        };
      }
      return q;
    },
    auth: {
      async getSession() {
        return { data: { session: h.token ? { access_token: h.token } : null } };
      },
    },
    channel(topic) {
      const ch = { topic, state: 'joined', on() { return ch; }, subscribe() { channels.push(ch); return ch; } };
      return ch;
    },
    getChannels() { return channels.slice(); },
    removeChannel(ch) {
      const i = channels.indexOf(ch);
      if (i >= 0) channels.splice(i, 1);
      return Promise.resolve('ok');
    },
  };
  globalThis.__syncHarness = h;

  const BROWSER_CLIENT = `data:text/javascript,${encodeURIComponent(
    'const c = globalThis.__syncHarness.browserClient;'
    + 'export const supabase = c; export const supabaseRead = c; export const isAuthConfigured = () => true;',
  )}`;
  registerHooks({
    resolve(spec, ctx, next) {
      if (/(^|\/)supabaseClient(\.js)?$/.test(spec) && /\/src\//.test(ctx.parentURL || '')) {
        return { url: BROWSER_CLIENT, shortCircuit: true };
      }
      try {
        return next(spec, ctx);
      } catch (e) {
        // The app's modules import without extensions (Vite resolves them); node does not.
        if (e?.code === 'ERR_MODULE_NOT_FOUND' && (spec.startsWith('./') || spec.startsWith('../'))) {
          return next(`${spec}.js`, ctx);
        }
        throw e;
      }
    },
  });

  // ── the server: the real routes ─────────────────────────────────────────────────────────
  const consoleError = console.error;
  console.error = (...args) => {
    if (args[0] === '[ALERT]') { h.alerts.push(args[1]); return; }
    if (process.env.VERBOSE) consoleError(...args);
  };
  const consoleWarn = console.warn;
  console.warn = (...args) => { if (process.env.VERBOSE) consoleWarn(...args); };
  const routes = {
    '/api/state/org-state': (await import('../api/state/org-state.js')).default,
    '/api/state/jobs-delta': (await import('../api/state/jobs-delta.js')).default,
    '/api/state/seed': (await import('../api/state/seed.js')).default,
    // A crew tab reads its projection here, and its own window of cleans (`?part=jobs`, CS-677).
    '/api/state/view': (await import('../api/state/view.js')).default,
  };
  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { if (body === undefined) throw new Error('no body'); return JSON.parse(JSON.stringify(body)); },
  });
  const runHandler = (handler, req) => new Promise((resolve) => {
    const out = { status: 200, body: undefined };
    const res = {
      statusCode: 200,
      status(c) { out.status = c; this.statusCode = c; return this; },
      json(b) { out.body = b; resolve(out); return this; },
      setHeader() {},
      send(b) { out.body = b; resolve(out); return this; },
      end() { resolve(out); return this; },
    };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { error: String(e?.message || e) } }));
  });
  globalThis.fetch = async (url, init = {}) => {
    const [path, search = ''] = String(url).replace(/^https?:\/\/[^/]+/, '').split('?');
    const method = init.method || 'GET';
    const forced = h.override ? h.override(path, init) : null;
    if (forced === 'network') {
      h.requests.push({ path, search, method, status: 'network' });
      throw new TypeError('Failed to fetch');
    }
    if (forced) {
      h.requests.push({ path, search, method, status: forced.status });
      return respond(forced.status, forced.body);
    }
    const handler = routes[path];
    if (!handler) {
      h.requests.push({ path, search, method, status: 404 });
      return respond(404, { error: `no route ${path}` });
    }
    const text = typeof init.body === 'string' ? init.body : '';
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    headers['content-length'] = String(Buffer.byteLength(text));
    const req = { method, query: Object.fromEntries(new URLSearchParams(search)), headers, body: text ? JSON.parse(text) : undefined };
    const out = await runHandler(handler, req);
    h.requests.push({ path, search, method, status: out.status });
    return respond(out.status, out.body);
  };

  // ── virtual timers ──────────────────────────────────────────────────────────────────────
  // The sync manager arms its debounce, its backoff and the version poll with setTimeout /
  // setInterval. They queue here; `advance(ms)` runs every one that falls due, in order,
  // letting the promise chains each one starts settle before the next.
  let clock = 0;
  let seq = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    seq += 1;
    timers.set(seq, { at: clock + Math.max(0, Number(ms) || 0), ms: Number(ms) || 0, fn: () => fn(...args), repeat: false });
    return seq;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.setInterval = (fn, ms = 0, ...args) => {
    seq += 1;
    timers.set(seq, { at: clock + Math.max(1, Number(ms) || 0), ms: Math.max(1, Number(ms) || 0), fn: () => fn(...args), repeat: true });
    return seq;
  };
  globalThis.clearInterval = (id) => { timers.delete(id); };

  h.settle = async (rounds = 60) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
  };
  h.advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      clock = t.at;
      if (t.repeat) t.at += t.ms; else timers.delete(id);
      t.fn();
      await h.settle();
    }
    clock = target;
    await h.settle();
  };
  // The ONE-SHOT timers armed now, as delays from the current clock (the version poll's
  // interval is left out — it is not a save).
  h.timerDelays = () => [...timers.values()].filter((t) => !t.repeat).map((t) => t.at - clock).sort((a, b) => a - b);
  h.clearTimers = () => { timers.clear(); };

  // ── the world ───────────────────────────────────────────────────────────────────────────
  // `logins`: bearer token -> the Supabase auth user (id, email, app_metadata claims).
  // `noRow`: a brand-new org with no org_state row yet (the first-run seed path).
  h.seedOrg = (state, { logins = {}, jobs = [], noRow = false } = {}) => {
    const blob = { ...state, jobs: [] };
    delete blob.currentUserId;
    resetWorld({
      tables: {
        org_state: noRow ? [] : [{
          organization_id: ORG, state: blob, version: 1, protected_fingerprint: null,
          min_client_build: null, freeze_strip: [], updated_at: new Date().toISOString(),
        }],
        jobs: jobs.map((j, i) => ({
          id: j.id, organization_id: ORG, data: j, row_version: i + 1, start_at: j.startAt || null,
          status: j.status || null, client_id: j.clientId || null, site_id: j.siteId || null, series_id: j.seriesId || null,
        })),
        crew_assignments: [], payroll_runs: [], job_deletes: [],
      },
      logins,
    });
    world.rpc = (name) => (name === 'delete_jobs' ? { data: null, error: { code: 'PGRST202', message: 'no such function' } } : { data: null, error: null });
    h.directWrites.length = 0;
    h.requests.length = 0;
    h.alerts.length = 0;
    h.override = null;
  };
  h.committed = () => world.tables.org_state[0];
  h.world = world;

  // ── a signed-in tab ─────────────────────────────────────────────────────────────────────
  const { reducer } = await import('../src/store/reducer.js');
  const { createExternalStore } = await import('../src/store/externalStore.js');
  const { createSyncManager } = await import('../src/store/sync.js');
  const { INITIAL_STATE } = await import('../src/data/seed.js');
  h.reducer = reducer;
  h.bootTab = async (token) => {
    const login = world.logins.get(token);
    if (!login) throw new Error(`sync-harness: no login for ${token}`);
    h.token = token;
    const store = createExternalStore(INITIAL_STATE, reducer);
    let pending = [];
    const tab = { store, statuses: [], problems: [] };
    tab.mgr = createSyncManager({
      dispatch: store.dispatch,
      getState: store.getSnapshot,
      getPending: () => pending,
      clearPending: () => { pending = []; },
      setPending: (actions) => { pending = Array.isArray(actions) ? actions : []; },
      userId: login.id,
      sessionEmail: login.email,
      claimOrgUserId: login.app_metadata?.org_user_id ?? null,
      claimRole: login.app_metadata?.role ?? null,
      onStatus: (s) => tab.statuses.push(s),
      onJobsReady: () => { tab.jobsReady = true; },
      onProblem: (p) => tab.problems.push(p),
    });
    const started = tab.mgr.start();
    await h.settle();
    await started;
    await h.settle();
    tab.pending = () => pending;
    tab.status = () => tab.statuses[tab.statuses.length - 1];
    tab.state = () => store.getSnapshot();
    // What a component's dispatch does in authed mode (store/index.jsx dispatchLocal).
    tab.dispatchLocal = (action) => {
      pending.push(action);
      store.dispatch(action);
      tab.mgr.notifyChange();
    };
    tab.stop = () => tab.mgr.stop();
    return tab;
  };

  instance = h;
  return h;
}
