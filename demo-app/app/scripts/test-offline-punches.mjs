// CS-666 — a punch made online disappears offline, so the cleaner can clock in again; and
// offline punches replayed in random order.
//
// WHAT WAS WRONG.
//   1. `timeApi.mine()` swallowed the offline error and merged the phone's buffered punches
//      into an EMPTY server list. A buffered clock-out only patches a row that is present
//      (`timeMerge.mergeBufferedPunches`), so a cleaner who clocked in WITH signal and out
//      without it saw the card flip back to "Clock in", the "On the clock" banner gone — and
//      the same on any offline re-entry to My Day or the visit, or an offline restart.
//   2. Buffered punches replayed in IndexedDB KEY order (`op_<uuid>`: random), not in the
//      order the cleaner acted. Reversed, a clean's clock-in landed before the clock-out of
//      the clean before it and was flagged "Two cleans at once" (the verifier's v04), and a
//      clock-out could move to a later re-tap (v02).
//
// WHAT THIS PINS.
//   §1 the replay order, pure: by the sequence the phone stamped each punch with, else (a
//      punch buffered before the stamp existed) by when the cleaner acted; a clock-out before
//      a clock-in at the same instant
//   §2 the device's copy of the cleaner's own punches (lib/punchProjection): saved per
//      cleaner, raw GPS points stripped (PAY-20), bounded, unreadable or another cleaner's → none
//   §3 the merge: a buffered clock-out of a punch the phone has no row for still shows as
//      clocked out (pending sync)
//   §4 the REAL timeApi over the REAL /api/time handler (fake Supabase on 127.0.0.1, a
//      stand-in IndexedDB holding the REAL timeQueue): online read → offline clock-out →
//      offline read keeps the punch, closed and pending (the v02/s22 shape); an offline
//      restart keeps an open punch open
//   §5 the replay, both orders: punches whose keys sort AGAINST the order they happened in
//      replay in the order they happened — clean B is not flagged "Two cleans at once"
//      (v04), and the first clock-out keeps its own time (v02)
//
// REGRESSION (THE LAW II.3): on the pre-fix tree the new module and exports do not exist,
// `mine()` answers [] offline and the flush replays in key order, so each section fails.
//
//   node scripts/test-offline-punches.mjs
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeSupabase } from './fake-supabase-http.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const API = 'http://api.test/api';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const watchdog = setTimeout(() => { console.error('test-offline-punches: timed out'); process.exit(1); }, 90000);

// ── the browser this code expects, stood in ──────────────────────────────────────────────
// localStorage
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); }, clear: () => ls.clear(), key: (i) => [...ls.keys()][i] ?? null,
  get length() { return ls.size; },
};
// navigator.onLine
const net = { online: true };
Object.defineProperty(globalThis, 'navigator', { value: { get onLine() { return net.online; } }, configurable: true, writable: true });
// window (events the flush dispatches)
globalThis.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
// A minimal IndexedDB: one object store per database, keyPath records, getAll() in KEY order —
// exactly what makes the real store replay `op_<uuid>` punches in random order.
const idb = new Map();
const later = (fn) => setTimeout(fn, 0);
globalThis.indexedDB = {
  open(name) {
    const req = {};
    later(() => {
      let stores = idb.get(name);
      const fresh = !stores;
      if (fresh) { stores = new Map(); idb.set(name, stores); }
      const db = {
        objectStoreNames: { contains: (s) => stores.has(s) },
        createObjectStore: (s, { keyPath }) => { stores.set(s, { keyPath, rows: new Map() }); },
        transaction: (s) => ({
          objectStore: () => {
            const st = stores.get(s);
            const op = (fn) => { const r = {}; later(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
            return {
              put: (v) => op(() => { st.rows.set(v[st.keyPath], structuredClone(v)); return v[st.keyPath]; }),
              get: (k) => op(() => (st.rows.has(k) ? structuredClone(st.rows.get(k)) : undefined)),
              getAll: () => op(() => [...st.rows.keys()].sort().map((k) => structuredClone(st.rows.get(k)))),
              delete: (k) => op(() => { st.rows.delete(k); }),
              clear: () => op(() => { st.rows.clear(); }),
            };
          },
        }),
        close: () => {},
      };
      req.result = db;
      if (fresh) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

// The app's own imports omit the extension; it reads import.meta.env; its Supabase client is
// the browser's — replaced by a session that carries this test's crew token.
globalThis.__punchToken = 't-c1';
const SUPABASE_STANDIN = 'export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: globalThis.__punchToken } } }) } }; export const supabaseRead = supabase; export const isAuthConfigured = () => true;';
registerHooks({
  resolve(spec, ctx, next) {
    if (/\/app\/src\//.test(ctx.parentURL || '') && /^\.\/supabaseClient(\.js)?$/.test(spec)) {
      return { url: `data:text/javascript,${encodeURIComponent(SUPABASE_STANDIN)}`, shortCircuit: true };
    }
    try { return next(spec, ctx); } catch (e) {
      if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) {
        for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
      }
      throw e;
    }
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (/\/app\/src\//.test(url) && r.source && String(r.source).includes('import.meta.env')) {
      r.source = `if (!import.meta.env) import.meta.env = { MODE: 'production', PROD: true, DEV: false, VITE_FORMS_BACKEND_URL: '${API}' };\n${r.source}`;
    }
    return r;
  },
});

// ── the server: the REAL /api/time handler over the loopback fake ────────────────────────
const ORG = '00000000-0000-0000-0000-000000000001';
const fake = await startFakeSupabase({ authUsers: { 't-c1': { id: 'a-c1', email: 'c1@x.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } } } });
Object.assign(process.env, { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon', CLEANSPACE_ORG_ID: ORG, CRON_SECRET: 'x' });
delete process.env.ALERT_WEBHOOK_URL;
if (!String(process.env.SUPABASE_URL).startsWith('http://127.0.0.1:')) { console.error('refusing: SUPABASE_URL is not the local fake'); process.exit(1); }
const { default: handler } = await import(pathToFileURL(path.join(APP, 'api/time/[...path].js')).href);
const replays = [];
const server = { reachable: true };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  if (!url.startsWith(API)) return realFetch(input, init);
  if (!server.reachable) throw new TypeError('Failed to fetch');
  const u = new URL(url);
  const action = u.pathname.replace(/^\/api\/time\//, '');
  const body = init.body ? JSON.parse(init.body) : {};
  if (action === 'replay') replays.push(body.entryId ? `out:${body.entryId}` : `in:${body.jobId}`);
  const query = { path: action.split('/'), ...Object.fromEntries(u.searchParams) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; }, end() { return res; } };
  const auth = init.headers?.Authorization || init.headers?.authorization;
  await handler({ method: init.method || 'GET', url: u.pathname + u.search, query, body, headers: auth ? { authorization: auth } : {} }, res);
  return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { 'content-type': 'application/json' } });
};
console.error = () => {}; console.warn = () => {};

const imp = (rel) => import(pathToFileURL(path.join(APP, rel)).href).catch(() => ({}));
const merge = await imp('src/lib/timeMerge.js');
const projection = await imp('src/lib/punchProjection.js');
const clockRules = await imp('src/lib/clockRules.js');
const timeApi = await imp('src/lib/timeApi.js');
const { punchFlags } = await imp('src/lib/filters/timeApprovals.js');
const { english } = await imp('src/i18n/core.js');
const flagText = (row) => (typeof punchFlags === 'function' ? punchFlags(row) : []).map((m) => (m && m.key && english ? english(m.key, m.params) : JSON.stringify(m)));

// ── §1 the replay order, pure ────────────────────────────────────────────────────────────
{
  const order = typeof merge.replayOrder === 'function' ? merge.replayOrder : (p) => p.slice();
  const ids = (list) => order(list).map((p) => p.id);
  // keys that sort AGAINST the order the cleaner acted in
  const outA = { id: 'op_z', kind: 'out', entryId: 'te_A', assertedOutAt: '2026-10-13T10:00:00.000Z', seq: 1_790_000_000_000_001 };
  const inB = { id: 'op_a', kind: 'in', jobId: 'j_b', assertedInAt: '2026-10-13T10:05:00.000Z', seq: 1_790_000_000_000_002 };
  eq('§1 the order the cleaner acted, not the key order', ids([inB, outA]), ['op_z', 'op_a']);
  eq('§1 …whatever order storage hands them back in', ids([outA, inB]), ['op_z', 'op_a']);
  // the sequence wins over a phone clock that jumped back between the two taps
  const jumped = { ...inB, assertedInAt: '2026-10-13T09:00:00.000Z' };
  eq('§1 the stamped sequence wins over a phone clock that jumped', ids([jumped, outA]), ['op_z', 'op_a']);
  // punches buffered before the stamp existed: by when the cleaner acted
  const legacyOut = { id: 'op_y', kind: 'out', entryId: 'te_A', assertedOutAt: '2026-10-13T10:00:00.000Z', createdAt: '2026-10-13T10:00:00.000Z' };
  const legacyIn = { id: 'op_b', kind: 'in', jobId: 'j_b', assertedInAt: '2026-10-13T10:05:00.000Z', createdAt: '2026-10-13T10:05:00.000Z' };
  eq('§1 a punch with no stamp (an older build) goes by when the cleaner acted', ids([legacyIn, legacyOut]), ['op_y', 'op_b']);
  // a folded in+out punch sits at its clock-in
  const folded = { id: 'op_c', kind: 'in', jobId: 'j_c', assertedInAt: '2026-10-13T08:00:00.000Z', assertedOutAt: '2026-10-13T11:00:00.000Z', createdAt: '2026-10-13T08:00:00.000Z' };
  eq('§1 a clock-in that carries its clock-out sits where it was clocked in', ids([legacyIn, folded, legacyOut]), ['op_c', 'op_y', 'op_b']);
  const tieOut = { id: 'op_q', kind: 'out', entryId: 'te_A', assertedOutAt: '2026-10-13T10:00:00.000Z' };
  const tieIn = { id: 'op_p', kind: 'in', jobId: 'j_b', assertedInAt: '2026-10-13T10:00:00.000Z' };
  eq('§1 at the same instant a clock-out goes before a clock-in', ids([tieIn, tieOut]), ['op_q', 'op_p']);
  ok('§1 the input is not reordered in place', (() => { const l = [inB, outA]; order(l); return l[0] === inB; })());
}

// ── §2 the device's copy of the cleaner's own punches ────────────────────────────────────
{
  const save = typeof projection.savePunchProjection === 'function' ? projection.savePunchProjection : () => {};
  const read = typeof projection.readPunchProjection === 'function' ? projection.readPunchProjection : () => null;
  const GPS = clockRules.GPS_POINT_COLUMNS || ['clock_in_lat'];
  const row = (id, over = {}) => ({ id, user_id: 'u_c1', job_id: 'j_1', clock_in_at: '2026-10-13T10:00:00.000Z', clock_out_at: null, status: 'in_progress', geofence_result: 'inside', clock_in_distance_m: 12, clock_in_lat: 26.1, clock_in_lng: -80.1, clock_in_accuracy_m: 9, clock_out_lat: null, clock_out_lng: null, clock_out_accuracy_m: null, edit_history: [], ...over });
  ls.clear();
  save({ userId: 'u_c1', entries: [row('te_1')] });
  const back = read({ userId: 'u_c1' }) || [];
  eq('§2 the last server answer is kept on the phone', back.map((e) => e.id), ['te_1']);
  ok('§2 the raw GPS point is never kept (PAY-20)', back.length === 1 && GPS.every((c) => !(c in back[0])), JSON.stringify(back[0]));
  ok('§2 the verdict and the distance are (the card reads them)', back[0]?.geofence_result === 'inside' && back[0]?.clock_in_distance_m === 12);
  eq('§2 another cleaner on this phone gets nothing', read({ userId: 'u_c2' }), null);
  eq('§2 no cleaner → nothing', read({ userId: null }), null);
  const many = Array.from({ length: 400 }, (_, i) => row(`te_${i}`, { clock_in_at: new Date(Date.UTC(2026, 9, 13) - i * 3600e3).toISOString(), clock_out_at: '2026-10-13T00:00:00.000Z', status: 'completed' }));
  many.push(row('te_open_old', { clock_in_at: '2026-01-01T00:00:00.000Z' }));
  save({ userId: 'u_c1', entries: many });
  const capped = read({ userId: 'u_c1' }) || [];
  ok('§2 bounded at the write point', capped.length > 0 && capped.length <= (projection.PUNCH_PROJECTION_MAX_ROWS || 0) + 1, String(capped.length));
  ok('§2 …and an open punch is always kept, however old', capped.some((e) => e.id === 'te_open_old'));
  ls.set(projection.PUNCH_PROJECTION_KEY || 'x', '{not json');
  eq('§2 an unreadable copy reads as none', read({ userId: 'u_c1' }), null);
  if (typeof projection.clearPunchProjection === 'function') {
    save({ userId: 'u_c1', entries: [row('te_1')] });
    projection.clearPunchProjection();
    eq('§2 sign-out clears it', read({ userId: 'u_c1' }), null);
  } else ok('§2 sign-out can clear it', false);
  const ap = (await import('node:fs')).readFileSync(path.join(APP, 'src/auth/AuthProvider.jsx'), 'utf8');
  ok('§2 …and sign-out does', /clearPunchProjection\(\)/.test(ap));
}

// ── §3 the merge ─────────────────────────────────────────────────────────────────────────
{
  const out = { id: 'op_o', kind: 'out', userId: 'u_c1', entryId: 'te_9', jobId: 'j_9', clockInAt: '2026-10-13T09:00:00.000Z', assertedOutAt: '2026-10-13T11:00:00.000Z' };
  const merged = typeof merge.mergeBufferedPunches === 'function' ? merge.mergeBufferedPunches([], [out], { userId: 'u_c1' }) : [];
  const e = merged.find((x) => x.id === 'te_9');
  ok('§3 a buffered clock-out of a punch the phone has no row for still reads as clocked out', !!e && e.job_id === 'j_9' && e.clock_out_at === out.assertedOutAt && e.pending_sync === true, JSON.stringify(merged));
  ok('§3 …with its duration', e?.duration_minutes === 120);
}

// ── §4 the real timeApi: an online punch survives going offline ──────────────────────────
const NOW = Date.now();
const MIN = 60000;
const iso = (m) => new Date(NOW + m * MIN).toISOString();
const SITE = { lat: 26.1224, lng: -80.1373 };
const state = {
  version: 58, company: { id: 'co', name: 'Co', timezone: 'America/New_York' },
  users: [{ id: 'u_c1', role: 'crew', status: 'active', name: 'c1', email: 'c1@x.test', pay: { type: 'hourly', hourlyRate: 20 } }],
  clients: [{ id: 'c_a', name: 'A' }, { id: 'c_b', name: 'B' }],
  sites: [{ id: 's_a', clientId: 'c_a', name: 'A', lat: SITE.lat, lng: SITE.lng, geofenceEnabled: true }, { id: 's_b', clientId: 'c_b', name: 'B', lat: SITE.lat, lng: SITE.lng, geofenceEnabled: true }],
  permissions: [], userPermissionOverrides: [], opsSettings: { offlineReplayWindowHours: 12, autoCloseGraceMins: 120 },
};
const job = (id, site, client, s, e) => ({ id, organization_id: ORG, site_id: site, client_id: client, start_at: iso(s), data: { id, clientId: client, siteId: site, startAt: iso(s), endAt: iso(e), status: 'in_progress', crewIds: ['u_c1'] } });
const openRow = (id, jobId, clientId, siteId, inMin) => ({
  id, organization_id: ORG, job_id: jobId, client_id: clientId, site_id: siteId, user_id: 'u_c1', user_name: 'c1', client_name: clientId === 'c_a' ? 'A' : 'B', site_name: 'x',
  clock_in_at: iso(inMin), clock_out_at: null, status: 'in_progress', scheduled_start: iso(inMin - 2), scheduled_end: iso(120), approval_status: 'pending', edit_history: [],
  client_punch_id: `op_online_${id}`, duration_minutes: null, row_version: 0, clock_in_lat: SITE.lat, clock_in_lng: SITE.lng, geofence_result: 'inside',
});
function reset(entries) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length, { organization_id: ORG, state, version: 58, updated_at: iso(-600), protected_fingerprint: null });
  fake.tables.jobs = [job('j_a', 's_a', 'c_a', -120, -25), job('j_b', 's_b', 'c_b', -25, 90)];
  fake.tables.time_entries = entries;
  fake.tables.checklist_results = []; fake.tables.payroll_runs = []; fake.tables.crew_assignments = [];
  replays.length = 0;
  ls.clear();
  idb.clear();
}
const goOffline = () => { net.online = false; server.reachable = false; };
const goOnline = () => { net.online = true; server.reachable = true; };
const entryFor = (list, jobId) => {
  const forJob = (list || []).filter((e) => e.job_id === jobId);
  return forJob.find((e) => !e.clock_out_at) || forJob.sort((a, b) => (a.clock_in_at < b.clock_in_at ? 1 : -1))[0] || null;
};

if (typeof timeApi.mine === 'function') {
  // v02 / s22: clocked in WITH signal, then out without it
  reset([openRow('te_1', 'j_a', 'c_a', 's_a', -50)]);
  goOnline();
  const online = await timeApi.mine({ userId: 'u_c1' });
  ok('§4 online, My Day reads the open punch', entryFor(online, 'j_a')?.id === 'te_1' && !entryFor(online, 'j_a').clock_out_at);
  goOffline();
  const r = await timeApi.clockOut({ entryId: 'te_1', lat: SITE.lat, lng: SITE.lng, accuracyM: 5, userId: 'u_c1', jobId: 'j_a', clockInAt: online[0]?.clock_in_at });
  ok('§4 the offline clock-out is kept on the phone', r?.entry?.pending_sync === true, JSON.stringify(r));
  const offline = await timeApi.mine({ userId: 'u_c1' });
  const e = entryFor(offline, 'j_a');
  ok('§4 offline, the card still has the punch (it used to read "Clock in" again)', !!e, JSON.stringify(offline));
  ok('§4 …clocked out, waiting to sync', !!e?.clock_out_at && e?.pending_sync === true && e?.status === 'completed', JSON.stringify(e));
  ok('§4 …so nothing offers a second clock-in to this clean', !!e && !!e.clock_out_at);
  ok('§4 …and no punch reads as still open ("On the clock" ends)', !(offline || []).some((x) => !x.clock_out_at));

  // an offline restart while still on the clock: the open punch stays open
  reset([openRow('te_2', 'j_a', 'c_a', 's_a', -40)]);
  goOnline();
  await timeApi.mine({ userId: 'u_c1' });
  goOffline();
  const restarted = await timeApi.mine({ userId: 'u_c1' });
  const open = entryFor(restarted, 'j_a');
  ok('§4 offline re-entry (or restart) while on the clock keeps the punch open — Clock out, not Clock in', open?.id === 'te_2' && !open.clock_out_at, JSON.stringify(restarted));
  // the phone holds the cleaner's punches, not someone else's
  const other = await timeApi.mine({ userId: 'u_c2' });
  ok('§4 another cleaner signed in on this phone does not see them', !(other || []).some((x) => x.id === 'te_2'));
  goOnline();
} else ok('§4 timeApi loads', false);

// ── §5 the replay, in the order the cleaner acted ────────────────────────────────────────
// Punch keys are made to sort AGAINST time: the phone's random ids are replaced by ids that
// count DOWN, so IndexedDB hands back the newest punch first — the order a pre-fix flush used.
let countdown = 0xffffff;
const realUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
const descendingIds = () => { globalThis.crypto.randomUUID = () => `ffffffff-ffff-4fff-bfff-ff${(countdown -= 1).toString(16).padStart(10, '0')}`; };
const randomIds = () => { globalThis.crypto.randomUUID = realUUID; };
if (typeof timeApi.flushOfflineQueue === 'function') {
  // v04: on the clock at A (online), then offline: out of A, into B
  reset([openRow('te_A', 'j_a', 'c_a', 's_a', -118)]);
  goOnline();
  await timeApi.mine({ userId: 'u_c1' });
  goOffline();
  descendingIds();
  await timeApi.clockOut({ entryId: 'te_A', lat: SITE.lat, lng: SITE.lng, accuracyM: 5, userId: 'u_c1', jobId: 'j_a' });
  await new Promise((r) => setTimeout(r, 25));
  await timeApi.clockIn({ jobId: 'j_b', lat: SITE.lat, lng: SITE.lng, accuracyM: 5, ctx: { userId: 'u_c1' } });
  randomIds();
  goOnline();
  await timeApi.flushOfflineQueue({ currentUserId: 'u_c1' });
  eq('§5 v04: replayed in the order the cleaner acted (out of A, then into B)', replays, ['out:te_A', 'in:j_b']);
  const b = fake.tables.time_entries.find((x) => x.job_id === 'j_b');
  const a = fake.tables.time_entries.find((x) => x.id === 'te_A');
  ok('§5 v04: A closed before B opened', !!a?.clock_out_at && !!b?.clock_in_at && Date.parse(a.clock_out_at) <= Date.parse(b.clock_in_at), JSON.stringify({ a: a?.clock_out_at, b: b?.clock_in_at }));
  ok('§5 v04: B is NOT flagged "Two cleans at once"', !!b && !flagText(b).some((t) => /Two cleans at once/i.test(t)) && !/still on the clock/i.test(b.note || ''), JSON.stringify({ note: b?.note, flags: flagText(b || {}) }));

  // v02: out of te_1, then (a re-tap) in AND out again — the first clock-out keeps its time
  reset([openRow('te_1', 'j_a', 'c_a', 's_a', -50)]);
  goOnline();
  await timeApi.mine({ userId: 'u_c1' });
  goOffline();
  descendingIds();
  const out1 = await timeApi.clockOut({ entryId: 'te_1', lat: SITE.lat, lng: SITE.lng, accuracyM: 5, userId: 'u_c1', jobId: 'j_a' });
  await new Promise((r) => setTimeout(r, 25));
  const in2 = await timeApi.clockIn({ jobId: 'j_a', lat: SITE.lat, lng: SITE.lng, accuracyM: 5, ctx: { userId: 'u_c1' } });
  await new Promise((r) => setTimeout(r, 25));
  await timeApi.clockOut({ entryId: in2?.id, lat: SITE.lat, lng: SITE.lng, accuracyM: 5, userId: 'u_c1', jobId: 'j_a' });
  randomIds();
  goOnline();
  await timeApi.flushOfflineQueue({ currentUserId: 'u_c1' });
  eq('§5 v02: replayed in the order the cleaner acted', replays, ['out:te_1', 'in:j_a']);
  const t1 = fake.tables.time_entries.find((x) => x.id === 'te_1');
  ok('§5 v02: the first clock-out keeps its own time (it moved to the re-tap when reversed)', !!t1 && !!t1.clock_out_at && Date.parse(t1.clock_out_at) === Date.parse(out1?.entry?.clock_out_at), JSON.stringify({ stored: t1?.clock_out_at, tapped: out1?.entry?.clock_out_at }));
  const open2 = fake.tables.time_entries.filter((x) => !x.clock_out_at);
  eq('§5 v02: nothing is left open (no phantom time)', open2.map((x) => x.id), []);
  eq('§5 the phone\'s queue is empty after the replay', (await timeApi.pendingPunchCount({ includeFailed: true })), 0);
} else ok('§5 the flush loads', false);

clearTimeout(watchdog);
await fake.close();
if (fails.length) {
  process.stdout.write(`\ntest-offline-punches: ${pass} passed, ${fails.length} failed\n${fails.map((f) => `  FAIL ${f}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\ntest-offline-punches: ${pass}/${pass} passed\n`);
}
