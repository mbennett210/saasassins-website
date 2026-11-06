// TIME TO RESOLVE — the average time from a ticket being opened to being closed (Matt's KPI, the
// Oct 6 call; plan docs/plans/2026-10-11-oct-6-call-additions.md §4, decisions D10–D12).
//
// What it holds:
//   A. THE ONE RULE (src/lib/resolveTime.js) at its edges: a reopened ticket counts once, to its
//      LATEST resolution; nothing in the window; a ticket resolved before the window; a status that
//      is not resolved; a missing stored due date (the deadline is the type rule's, WO-20/21, never
//      the stored cache); the mean, the median and "met the deadline".
//   B. The formatter's units ("22 min", "3 h 10 min", "1 day 4 h"), through the catalog.
//   C. The office report's split (overall, by type, by customer) from the same rule.
//   D. 🔴 THE HUB (GET /api/hub/home, the REAL handler over fake-supabase): the `resolve` field is
//      EXACTLY its allowlist and counts only what the customer can check against their own Requests
//      list (D11) — that building's requests from the hub; never another building's, never the
//      office's internal tickets, never one older than the hub's year — read completely; a reopen
//      drops a ticket until it is resolved again, then it counts once.
//   E. 🔴 THE REPORT ROUTE (GET /api/qc/reports/resolve-time, the REAL handler): reports.view AND
//      qc.view (crew refused, a manager without qc.view refused, no login 401), a window is required
//      and bounded, Manager / Customer narrow it on the server, and the read is COMPLETE past
//      PostgREST's 1,000-row cap (the CS-640 lesson: no page cap that silently drops rows).
//   F. Wiring: the demo twins call the same rule; the hub tile, the report, Reports' entry and the
//      search entry exist and read the catalog.
//
// REGRESSION (THE LAW II.3): on the pre-change tree there is no src/lib/resolveTime.js, the hub's
// Home has no `resolve` field and /api/qc/reports/resolve-time is a 404, so every section fails.
//
//   node app/scripts/test-resolve-time.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const code = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const { seedPermissions } = await import('../src/lib/roles.js');
const { TYPE_DEADLINE_HOURS, SLA_HOURS, WO_TYPES } = await import('../src/lib/workOrders.js');
const core = await import('../src/i18n/core.js');
const rule = await tryImport('../src/lib/resolveTime.js');
const homeLib = await tryImport('../src/lib/hubHome.js');
const hub = (await import('../api/hub/[...path].js')).default;
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail) — as test-client-hub-routes.mjs. The repo's suites disagree.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;
const has = (fn) => typeof fn === 'function';

const MIN = 60000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// The window the rule reads by default, from the rule's OWN constant (never a restated 30). The
// fallback exists only so the fixtures can be built on the pre-change tree, where A0 fails.
const WINDOW_OK = Number.isFinite(rule.RESOLVE_WINDOW_DAYS) && rule.RESOLVE_WINDOW_DAYS > 0;
const WINDOW_DAYS = WINDOW_OK ? rule.RESOLVE_WINDOW_DAYS : 30;
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// ── A. the one rule ──────────────────────────────────────────────────────────
{
  ok('A0 the rule loads (src/lib/resolveTime.js) and names its window', () => has(rule.resolveStats) && WINDOW_OK, rule.__error || '');
  // created / resolved as offsets before NOW.
  const t = (id, createdAgo, resolvedAgo, extra = {}) => ({
    id, status: 'resolved', type: 'complaint', priority: 'medium',
    created_at: iso(NOW - createdAgo), resolved_at: resolvedAgo == null ? null : iso(NOW - resolvedAgo), ...extra,
  });
  const empty = has(rule.resolveStats) ? rule.resolveStats([], { now: NOW }) : null;
  ok('A1 nothing in the window: no figure, never a made-up zero', () => empty && empty.count === 0 && empty.meanMs === null && empty.medianMs === null && empty.onTime === 0 && empty.withDeadline === 0, JSON.stringify(empty));
  ok('A1b …and the answer is EXACTLY its shape', () => sameKeys(empty, rule.RESOLVE_STATS_FIELDS));

  const before = has(rule.resolveStats) ? rule.resolveStats([t('b1', (WINDOW_DAYS + 3) * DAY, (WINDOW_DAYS + 1) * DAY)], { now: NOW }) : null;
  ok('A2 a ticket resolved BEFORE the window is not counted (even though it was a fast one)', () => before && before.count === 0, JSON.stringify(before));

  const inside = t('i1', (WINDOW_DAYS - 1) * DAY + 20 * MIN, (WINDOW_DAYS - 1) * DAY);
  const s1 = has(rule.resolveStats) ? rule.resolveStats([inside], { now: NOW }) : null;
  ok('A3 Matt\'s example: opened, closed 20 minutes later, inside the window → 20 minutes', () => s1 && s1.count === 1 && s1.meanMs === 20 * MIN && s1.medianMs === 20 * MIN, JSON.stringify(s1));

  const notResolved = [
    t('n1', 2 * H, H, { status: 'open' }),            // a stale resolved_at on an open ticket
    t('n2', 2 * H, H, { status: 'in_progress' }),
    t('n3', 2 * H, H, { status: 'awaiting_client' }),
    t('n4', 2 * H, H, { status: 'ack' }),             // legacy: "working on it"
    t('n5', 2 * H, null),                             // resolved with no completion time
    t('n6', null, H, { created_at: null }),           // no creation time
  ];
  const s2 = has(rule.resolveStats) ? rule.resolveStats(notResolved, { now: NOW }) : null;
  ok('A4 only RESOLVED tickets with both times count (open, in progress, awaiting the client, legacy ack, no times: none)', () => s2 && s2.count === 0, JSON.stringify(s2));

  // A reopened ticket: reopen clears resolved_at, resolving again stamps it anew (store.js), so a
  // ticket opened 6 days ago, closed, reopened and closed again yesterday counts ONCE, 5 days.
  const reopened = t('r1', 6 * DAY, 1 * DAY);
  const s3 = has(rule.resolveStats) ? rule.resolveStats([reopened, { ...reopened }], { now: NOW }) : null;
  ok('A5 a reopened-then-resolved ticket counts ONCE, to its latest resolution (a repeated row is one ticket)', () => s3 && s3.count === 1 && s3.meanMs === 5 * DAY, JSON.stringify(s3));

  // The mean and the median over 20 min, 40 min, 3 h (odd) and with 1 h added (even).
  const three = [t('m1', 2 * DAY, 2 * DAY - 20 * MIN), t('m2', 3 * DAY, 3 * DAY - 40 * MIN), t('m3', 4 * DAY, 4 * DAY - 3 * H)];
  const s4 = has(rule.resolveStats) ? rule.resolveStats(three, { now: NOW }) : null;
  ok('A6 the mean and the median (odd count: the middle one)', () => s4 && s4.count === 3 && s4.meanMs === mean([20 * MIN, 40 * MIN, 3 * H]) && s4.medianMs === 40 * MIN, JSON.stringify(s4));
  const s5 = has(rule.resolveStats) ? rule.resolveStats([...three, t('m4', 5 * DAY, 5 * DAY - H)], { now: NOW }) : null;
  ok('A7 the median of an even count is the middle two\'s mean', () => s5 && s5.medianMs === (40 * MIN + H) / 2, JSON.stringify(s5));

  // "Met the deadline" is the ONE deadline rule (lib/workOrders: by type for a client request, by
  // urgency for an issue), DERIVED from created_at — never the stored due_at, which may be missing.
  const cHrs = TYPE_DEADLINE_HOURS.complaint;
  const rHrs = TYPE_DEADLINE_HOURS.request;
  const iHrs = SLA_HOURS.urgent;
  const deadlines = [
    t('d1', 3 * DAY, 3 * DAY - (cHrs * H - MIN), { due_at: null }),                       // complaint, just inside, no stored due date
    t('d2', 3 * DAY, 3 * DAY - (cHrs * H + MIN), { due_at: iso(NOW + 99 * DAY) }),        // complaint, just late — a stale stored cache says otherwise
    t('d3', 4 * DAY, 4 * DAY - (rHrs * H - H), { type: 'request', due_at: undefined }),   // request, inside its own (longer) deadline
    t('d4', 5 * DAY, 5 * DAY - (iHrs * H + MIN), { type: 'issue', priority: 'urgent' }),   // issue: the urgency clock, late
  ];
  const s6 = has(rule.resolveStats) ? rule.resolveStats(deadlines, { now: NOW }) : null;
  ok('A8 met the deadline by the type rule, a missing or stale stored due date ignored (2 of 4)', () => s6 && s6.count === 4 && s6.withDeadline === 4 && s6.onTime === 2, JSON.stringify(s6));

  // An explicit window (the report's period) beats the default.
  const s7 = has(rule.resolveStats) ? rule.resolveStats([t('w1', 50 * DAY, 45 * DAY), t('w2', 10 * DAY, 9 * DAY)], { from: iso(NOW - 60 * DAY), to: iso(NOW - 40 * DAY) }) : null;
  ok('A9 an explicit from / to window counts what was resolved inside it, and nothing after', () => s7 && s7.count === 1 && s7.meanMs === 5 * DAY, JSON.stringify(s7));
  const s8 = has(rule.resolveStats) ? rule.resolveStats([t('f1', 2 * H, -H)], { now: NOW }) : null;
  ok('A10 a resolution stamped after "now" is outside the window', () => s8 && s8.count === 0, JSON.stringify(s8));
  const s9 = has(rule.resolveStats) ? rule.resolveStats([t('z1', H, 2 * H)], { now: NOW }) : null;
  ok('A11 a resolution stamped before its creation counts as no time at all, never a negative', () => s9 && s9.count === 1 && s9.meanMs === 0, JSON.stringify(s9));
}

// ── B. the formatter ─────────────────────────────────────────────────────────
{
  const f = has(rule.formatResolveDuration) ? rule.formatResolveDuration : () => null;
  ok('B1 minutes: "22 min" (Matt\'s figure)', () => f(22 * MIN) === '22 min', f(22 * MIN));
  ok('B2 under a minute', () => f(20 * 1000) === 'Under 1 min', f(20 * 1000));
  ok('B3 whole hours: "1 h"', () => f(H) === '1 h', f(H));
  ok('B4 hours and minutes: "3 h 10 min"', () => f(3 * H + 10 * MIN) === '3 h 10 min', f(3 * H + 10 * MIN));
  ok('B5 a day: "1 day"', () => f(DAY) === '1 day', f(DAY));
  ok('B6 a day and hours: "1 day 4 h"', () => f(DAY + 4 * H) === '1 day 4 h', f(DAY + 4 * H));
  ok('B7 days are plural: "2 days 1 h"', () => f(2 * DAY + H) === '2 days 1 h', f(2 * DAY + H));
  ok('B8 a day\'s worth of minutes rounds to hours (23 h 59 min stays, 47 h 59 min is 2 days)', () => f(DAY - MIN) === '23 h 59 min' && f(2 * DAY - MIN) === '2 days', `${f(DAY - MIN)} / ${f(2 * DAY - MIN)}`);
  ok('B9 nothing to say: a dash, never "NaN" or "0 min"', () => f(null) === '—' && f(undefined) === '—' && f(Number.NaN) === '—', `${f(null)}`);
  // Through the catalog: every word is a catalog line, and a reader's `t` renders them.
  const asked = [];
  const t = (key, params) => { asked.push(key); return `[${key}]${params ? JSON.stringify(params) : ''}`; };
  if (has(rule.formatResolveDuration)) { [20 * 1000, 22 * MIN, H, 3 * H + 10 * MIN, DAY, DAY + 4 * H].forEach((ms) => rule.formatResolveDuration(ms, t)); }
  const en = core.SOURCE_CATALOG;
  ok('B10 the words come from the catalog: a reader\'s translator is asked for six catalog keys', () => asked.length === 6 && new Set(asked).size === 6 && asked.every((k) => typeof en[k] === 'string' || (en[k] && typeof en[k] === 'object')), asked.join(', '));
}

// ── C. the office's split ─────────────────────────────────────────────────────
{
  const row = (id, clientId, type, createdAgo, takes, extra = {}) => ({
    id, client_id: clientId, client_name: `Name of ${clientId}`, status: 'resolved', type, priority: 'medium', origin: 'portal',
    created_at: iso(NOW - createdAgo), resolved_at: iso(NOW - createdAgo + takes), ...extra,
  });
  const rows = [
    row('c1', 'cl_a', 'complaint', 3 * DAY, 20 * MIN),
    row('c2', 'cl_a', 'request', 4 * DAY, 2 * H),
    row('c3', 'cl_b', 'issue', 5 * DAY, 30 * MIN, { origin: 'internal' }),
    row('c4', 'cl_b', 'failed_inspection', 6 * DAY, 50 * H, { origin: 'internal' }),
    row('c5', 'cl_b', null, 6 * DAY, H, { origin: 'internal' }),        // legacy: no type → an issue (toWorkOrder's default)
    row('c6', 'cl_a', 'complaint', 90 * DAY, H),                        // outside the window
  ];
  const r = has(rule.resolveReport) ? rule.resolveReport(rows, { now: NOW }) : null;
  ok('C1 overall: every ticket resolved in the window, whatever its origin', () => r && r.overall.count === 5, JSON.stringify(r?.overall));
  ok('C2 by type: one row per type, in the vocabulary\'s order, each EXACTLY its shape', () => r && r.byType.map((x) => x.type).join() === WO_TYPES.join()
    && r.byType.every((x) => sameKeys(x, ['type', ...rule.RESOLVE_STATS_FIELDS])), JSON.stringify(r?.byType?.map((x) => x.type)));
  const byType = Object.fromEntries((r?.byType || []).map((x) => [x.type, x]));
  ok('C3 …a ticket with no type counts as an issue; a failed inspection is its own row', () => byType.issue?.count === 2 && byType.failed_inspection?.count === 1 && byType.complaint?.count === 1 && byType.request?.count === 1, JSON.stringify(byType));
  const a = (r?.byClient || []).find((x) => x.clientId === 'cl_a');
  const b = (r?.byClient || []).find((x) => x.clientId === 'cl_b');
  ok('C4 by customer: each customer\'s own figures and name', () => r.byClient.length === 2 && a?.count === 2 && a.meanMs === mean([20 * MIN, 2 * H]) && b?.count === 3 && a.clientName === 'Name of cl_a'
    && r.byClient.every((x) => sameKeys(x, ['clientId', 'clientName', ...rule.RESOLVE_STATS_FIELDS])), JSON.stringify(r?.byClient));
}

// ── the world for the routes ─────────────────────────────────────────────────
const CU1 = 'a0000000-0000-4000-8000-000000000001'; // Pat: cl_a directly
const CU4 = 'a0000000-0000-4000-8000-000000000004'; // only cl_x
const R = (n) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const user = (id, role, name) => ({ id, role, name, status: 'active', email: `${id}@example.test`, notificationPrefs: {} });
// A ticket that took `takes` ms, created `createdAgo` before now.
const ticket = (id, client, origin, createdAgo, takes, extra = {}) => ({
  id, organization_id: ORG, client_id: client, site_id: `s_${client.slice(-1)}`, job_id: null, reported_by_user_id: null, assignee_user_id: 'u_mgr',
  client_name: client === 'cl_a' ? 'Coral Bay HOA' : client === 'cl_b' ? 'Bayshore Senior Living' : 'Harbor Tower', site_name: 'Main',
  title: `Ticket ${id.slice(-2)}`, description: 'Something.', type: 'complaint', origin, category: null, priority: 'medium',
  status: takes == null ? 'open' : 'resolved', created_at: iso(NOW - createdAgo), due_at: null,
  resolved_at: takes == null ? null : iso(NOW - createdAgo + takes), escalated_at: null,
  raised_by_client_user_id: origin === 'portal' ? CU1 : null, raised_by_client_name: origin === 'portal' ? 'Pat Manager' : null, ...extra,
});
// cl_a's hub figure is exactly HUB_A (the building's requests from the hub, resolved in the window,
// inside the hub's year). Everything else is a trap the figure must NOT include.
const HUB_A = [
  ticket(R(1), 'cl_a', 'portal', 3 * DAY, 20 * MIN),                    // 20 min, complaint: on time
  ticket(R(2), 'cl_a', 'portal', 5 * DAY, 3 * H),                       // 3 h, complaint: late
];
const TRAPS = [
  ticket(R(3), 'cl_a', 'portal', (WINDOW_DAYS + 16) * DAY, H),          // resolved before the window
  ticket(R(4), 'cl_a', 'internal', 2 * DAY, H, { raised_by_client_user_id: null }),   // the office's own (D11)
  ticket(R(5), 'cl_x', 'portal', 2 * DAY, 10 * MIN, { raised_by_client_user_id: CU4 }), // another building's
  ticket(R(6), 'cl_a', 'portal', 400 * DAY, 400 * DAY - DAY),           // created outside the hub's year, resolved a day ago
  ticket(R(7), 'cl_a', 'portal', DAY, null),                            // still open
  ticket(R(8), 'cl_a', 'portal', 2 * DAY, null, { status: 'awaiting_client' }),
  ticket(R(9), 'cl_b', 'internal', 4 * DAY, 45 * MIN, { type: 'issue', raised_by_client_user_id: null }), // Bayshore: the office's issue
];
// R(10): completed two days ago, the customer will reopen it and the office resolve it again.
const REOPEN = ticket(R(10), 'cl_a', 'portal', 6 * DAY, 4 * DAY);

function seed({ overrides = [], extraTickets = [] } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_owner', 'owner', 'Dana Owner'), user('u_mgr', 'manager', 'Renata Cruz'), user('u_crew', 'crew', 'Tomas Rivera')],
          clients: [
            { id: 'cl_a', name: 'Coral Bay HOA', supervisorId: 'u_mgr' },
            { id: 'cl_b', name: 'Bayshore Senior Living', supervisorId: 'u_owner' },
            { id: 'cl_x', name: 'Harbor Tower', supervisorId: 'u_mgr' },
          ],
          sites: [{ id: 's_a', clientId: 'cl_a', name: 'Clubhouse' }, { id: 's_b', clientId: 'cl_b', name: 'Main' }, { id: 's_x', clientId: 'cl_x', name: 'Tower' }],
          permissions: seedPermissions(),
          userPermissionOverrides: overrides,
          notifications: [],
        },
      }],
      crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-c1' },
        { id: CU4, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', phone: null, status: 'active', auth_user_id: 'auth-c4' },
      ],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as5', organization_id: ORG, client_user_id: CU4, client_id: 'cl_x', group_id: null },
      ],
      jobs: [], time_entries: [], checklist_results: [], inspection_records: [], inspection_items: [],
      account_media: [
        // WO-10: a completion photo on the ticket the office resolves again.
        { id: 'm_done', organization_id: ORG, scope: 'problem_report', ref_id: REOPEN.id, area_id: null, site_id: 's_a', client_id: 'cl_a', kind: 'image', mime_type: 'image/jpeg', storage_path: `${ORG}/s_a/done.jpg`, thumb_path: null, caption: null, created_at: iso(NOW - 4 * DAY) },
      ],
      problem_reports: [...HUB_A, ...TRAPS, REOPEN, ...extraTickets],
      work_order_messages: [],
      activity_log: [],
      inbox_accounts: [],
    },
    logins: {
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
    },
  });
}

async function call(handler, { method = 'GET', path: p, token, body, headers: extra = {} }) {
  const [sub, qs] = p.split('?');
  const req = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body || {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 15000);
      const done = (status, b, headers) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const headers = {};
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b, headers); return this; },
        send(b) { done(this.statusCode, b, headers); return this; },
        end(b) { done(this.statusCode, b ?? null, headers); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }, headers));
    });
  } finally { Object.assign(console, quiet); }
}
const hubGet = (p, token = 'tok-client', headers = {}) => call(hub, { path: p, token, headers });
const qcGet = (p, token = 'tok-owner') => call(qc, { path: p, token });
const spanOf = (t) => Date.parse(t.resolved_at) - Date.parse(t.created_at);

// ── D. the hub's Home ─────────────────────────────────────────────────────────
seed();
{
  ok('D0 the hub\'s Home names the field in its allowlist', () => Array.isArray(homeLib.HUB_HOME_FIELDS) && homeLib.HUB_HOME_FIELDS.includes('resolve') && Array.isArray(homeLib.HUB_RESOLVE_FIELDS), homeLib.__error || '');
  world.log = [];
  const r = await hubGet('home?buildingId=cl_a');
  const v = r.body?.resolve;
  ok('D1 Home answers the building\'s time to resolve, EXACTLY its allowlist', () => r.status === 200 && sameKeys(r.body, homeLib.HUB_HOME_FIELDS) && sameKeys(v, homeLib.HUB_RESOLVE_FIELDS), show(r));
  ok('D2 …over the rule\'s own window', () => WINDOW_OK && v?.days === rule.RESOLVE_WINDOW_DAYS, JSON.stringify(v));
  // cl_a's requests from the hub resolved in the window: HUB_A and the one completed two days ago.
  const own = [...HUB_A, REOPEN];
  const want = own.map(spanOf);
  ok('🔴 D3 …counting ONLY this building\'s requests from the hub resolved in the window: 3 of them, their mean',
    () => v?.count === own.length && v.meanMs === mean(want), `${JSON.stringify(v)} want count ${own.length} mean ${mean(want)}`);
  ok('🔴 D4 …never the office\'s internal ticket, another building\'s, one resolved before the window or created outside the hub\'s year (all seeded, none counted)',
    () => TRAPS.every((t) => world.tables.problem_reports.some((p) => p.id === t.id)) && v?.count === own.length, JSON.stringify(v));
  const q = world.log.filter((x) => x.table === 'problem_reports' && x.op === 'select' && x.eq.status === 'resolved');
  ok('🔴 D5 the read puts the building, the hub\'s origin and the status IN THE QUERY, with declared columns',
    () => q.length > 0 && q.every((x) => x.eq.client_id === 'cl_a' && x.eq.origin === 'portal' && x.cols && x.cols !== '*' && !/description|internal_note|assignee/.test(x.cols)), JSON.stringify(q.slice(0, 2)));
  const blob = JSON.stringify(v || {});
  ok('🔴 D6 nothing but the figure: no ticket ids, titles, types or names', () => r.status === 200 && !!v && !/e0000000|Ticket|complaint|Renata|Pat/.test(blob), blob);

  const x = await hubGet('home?buildingId=cl_x', 'tok-client4');
  ok('D7 another customer\'s building has its OWN figure (one request, 10 minutes)', () => x.status === 200 && x.body?.resolve?.count === 1 && x.body.resolve.meanMs === 10 * MIN, show(x));
  const foreign = await hubGet('home?buildingId=cl_x');
  ok('🔴 D8 a building outside the login\'s scope is a 404 that confirms nothing', () => foreign.status === 404 && !JSON.stringify(foreign.body).includes('Harbor'), show(foreign));

  // The office's preview acting as the customer shows the same figure (plan §4: "The office's
  // preview shows the same").
  const pv = await hubGet('home?buildingId=cl_a', 'tok-owner', { 'x-hub-preview': 'cl_a' });
  ok('D9 the office\'s preview of the building shows the same figure', () => pv.status === 200 && pv.body?.resolve?.count === v?.count && pv.body.resolve.meanMs === v?.meanMs, show(pv));

  // Bayshore: the office resolved its own issue there; the customer's hub has nothing to check it against.
  world.tables.client_user_assignments.push({ id: 'as2', organization_id: ORG, client_user_id: CU1, client_id: 'cl_b', group_id: null });
  const b = await hubGet('home?buildingId=cl_b');
  ok('🔴 D10 a building whose only closed ticket is the office\'s own says none (count 0, no average)', () => b.status === 200 && b.body?.resolve?.count === 0 && b.body.resolve.meanMs === null, show(b));
}

// D11–D13: the reopen, end to end — the customer reopens a completed request (WO-11), it leaves the
// figure; the office resolves it again (WO-10 photo on file), it counts ONCE, from its creation to
// the new resolution.
seed();
{
  const before = await hubGet('home?buildingId=cl_a');
  const reopenWant = [...HUB_A, REOPEN].map(spanOf);
  ok('D11 a request completed two days ago counts while it is completed', () => before.body?.resolve?.count === 3 && before.body.resolve.meanMs === mean(reopenWant), JSON.stringify(before.body?.resolve));
  const re = await call(hub, { method: 'POST', path: 'ticket-reopen', token: 'tok-client', body: { buildingId: 'cl_a', ticketId: REOPEN.id } });
  const mid = await hubGet('home?buildingId=cl_a');
  ok('D12 the customer reopens it: it leaves the figure until it is resolved again', () => re.status === 200 && mid.body?.resolve?.count === 2, `${show(re)} / ${JSON.stringify(mid.body?.resolve)}`);
  const up = await call(qc, { method: 'POST', path: 'problems/update', token: 'tok-owner', body: { id: REOPEN.id, status: 'resolved' } });
  const after = await hubGet('home?buildingId=cl_a');
  const row = world.tables.problem_reports.find((p) => p.id === REOPEN.id);
  const reSpan = Date.parse(row?.resolved_at) - Date.parse(row?.created_at);
  ok('🔴 D13 …resolved again, it counts ONCE, to its latest resolution (from its creation, six days)',
    () => up.status === 200 && after.body?.resolve?.count === 3 && after.body.resolve.meanMs === mean([...HUB_A.map(spanOf), reSpan]) && reSpan >= 6 * DAY - MIN,
    `${show(up)} / ${JSON.stringify(after.body?.resolve)}`);
}

// D14: complete past PostgREST's 1,000-row cap — a building with 1,050 requests resolved this month.
{
  const many = Array.from({ length: 1050 }, (_, i) => ticket(`f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, 'cl_a', 'portal', 10 * DAY + i * MIN, (i % 2 ? 30 : 10) * MIN));
  seed({ extraTickets: many });
  world.maxRows = 1000;
  const r = await hubGet('home?buildingId=cl_a');
  const want = [...HUB_A, REOPEN, ...many].map(spanOf);
  ok('🔴 D14 the hub\'s read is COMPLETE past the 1,000-row cap (1,053 requests, every one counted)',
    () => r.status === 200 && r.body?.resolve?.count === want.length && r.body.resolve.meanMs === mean(want), `${show(r)} want ${want.length}`);
}

// ── E. the office's report route ─────────────────────────────────────────────
seed();
{
  const win = `fromIso=${encodeURIComponent(iso(NOW - WINDOW_DAYS * DAY))}&toIso=${encodeURIComponent(iso(NOW + MIN))}`;
  const path0 = `reports/resolve-time?${win}`;
  const r = await qcGet(path0);
  // In the window: HUB_A (2), the internal one at cl_a (R4), cl_x's (R5), the 400-day-old one resolved
  // yesterday (R6), Bayshore's issue (R9), REOPEN (R10) = 7. Not: R3 (before), R7 / R8 (not resolved).
  const inWindow = [...HUB_A, TRAPS[1], TRAPS[2], TRAPS[3], TRAPS[6], REOPEN];
  ok('E1 the owner runs it: every ticket resolved in the period, whatever its origin (the office\'s KPI)',
    () => r.status === 200 && r.body?.overall?.count === inWindow.length && r.body.overall.meanMs === mean(inWindow.map(spanOf)), show(r));
  ok('E2 …the answer is the report\'s shape: overall, by type (every type), by customer', () => sameKeys(r.body?.overall, rule.RESOLVE_STATS_FIELDS)
    && (r.body?.byType || []).map((x) => x.type).join() === WO_TYPES.join() && Array.isArray(r.body?.byClient), show(r));
  const met = inWindow.filter((t) => spanOf(t) <= (t.type === 'issue' ? SLA_HOURS.medium : TYPE_DEADLINE_HOURS[t.type]) * H).length;
  ok('E3 …"met the deadline" by Matt\'s standards (the type rule), every ticket judged', () => r.body?.overall?.onTime === met && r.body.overall.withDeadline === inWindow.length, `${JSON.stringify(r.body?.overall)} want ${met}`);
  const a = (r.body?.byClient || []).find((x) => x.clientId === 'cl_a');
  ok('E4 …by customer, the office\'s own tickets included (cl_a: 5)', () => a?.count === 5 && a.clientName === 'Coral Bay HOA', JSON.stringify(r.body?.byClient));
  ok('E5 private, never cached', () => !r.headers?.['cache-control'] || /no-store|private/.test(r.headers['cache-control']), JSON.stringify(r.headers));

  const sup = await qcGet(`${path0}&supervisorId=u_owner`);
  ok('E6 Manager narrows ON THE SERVER to that manager\'s buildings (Bayshore: 1)', () => sup.status === 200 && sup.body?.overall?.count === 1 && sup.body.byClient.map((x) => x.clientId).join() === 'cl_b', show(sup));
  const one = await qcGet(`${path0}&clientId=cl_x`);
  ok('E7 Customer narrows to that customer (Harbor Tower: 1, 10 minutes)', () => one.status === 200 && one.body?.overall?.count === 1 && one.body.overall.meanMs === 10 * MIN, show(one));
  const nobody = await qcGet(`${path0}&supervisorId=u_crew`);
  ok('E8 a manager with no buildings reads nothing, never the whole company', () => nobody.status === 200 && nobody.body?.overall?.count === 0, show(nobody));

  const crew = await qcGet(path0, 'tok-crew');
  ok('🔴 E9 crew are refused (no reports.view)', () => crew.status === 403, show(crew));
  const anon = await call(qc, { path: path0 });
  ok('🔴 E10 no login is a 401', () => anon.status === 401, show(anon));
  const mgr = await qcGet(path0, 'tok-mgr');
  ok('E11 a manager holding both keys runs it', () => mgr.status === 200 && mgr.body?.overall?.count === inWindow.length, show(mgr));
  for (const [label, q] of [['no period', 'reports/resolve-time'], ['a period over a year', `reports/resolve-time?fromIso=${encodeURIComponent(iso(NOW - 400 * DAY))}&toIso=${encodeURIComponent(iso(NOW))}`],
    ['a malformed customer', `${path0}&clientId=${encodeURIComponent('x),client_id.in.(cl_a')}`], ['a malformed manager', `${path0}&supervisorId=${encodeURIComponent('a b')}`]]) {
    const x = await qcGet(q);
    ok(`E12 ${label} is a 400, never a wider read`, () => x.status === 400, show(x));
  }
}
seed({ overrides: [{ userId: 'u_mgr', grants: [], revokes: ['qc.view'] }] });
{
  const x = await qcGet(`reports/resolve-time?fromIso=${encodeURIComponent(iso(NOW - DAY))}&toIso=${encodeURIComponent(iso(NOW))}`, 'tok-mgr');
  ok('🔴 E13 reports.view WITHOUT qc.view is refused (a role with tickets turned off reads no ticket figures)', () => x.status === 403, show(x));
}
{
  const many = Array.from({ length: 1500 }, (_, i) => ticket(`f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, i % 2 ? 'cl_a' : 'cl_x', 'internal', 9 * DAY + i * MIN, (i % 3 + 1) * 15 * MIN, { raised_by_client_user_id: null }));
  seed({ extraTickets: many });
  world.maxRows = 1000;
  const x = await qcGet(`reports/resolve-time?fromIso=${encodeURIComponent(iso(NOW - WINDOW_DAYS * DAY))}&toIso=${encodeURIComponent(iso(NOW + MIN))}`);
  ok('🔴 E14 the report\'s read is COMPLETE past the 1,000-row cap (1,507 tickets, every one counted)', () => x.status === 200 && x.body?.overall?.count === 1507, show(x));
}

// ── G. a ticket is resolved ONCE: a retried or raced resolve never moves resolved_at ──
// store.updateProblem stamped `resolved_at = now()` on EVERY resolve it was sent, so a resolve that
// arrived for a ticket already resolved — a retried request, a double-tap, two people closing it at
// once — moved its completion time: the ticket's time to resolve (the hub's and the report's
// number) grew, and its 7-day reopen window (WO-11) restarted. The first resolution stands; only
// a real reopen (resolved_at cleared) lets a later resolve stamp it anew (D13 above).
const statusRows = (id) => (world.tables.activity_log || []).filter((r) => r.entity_id === id && r.action === 'ticket.status_changed');
seed();
{
  const T = HUB_A[0]; // resolved three days ago, 20 minutes after it was opened
  const firstResolvedAt = world.tables.problem_reports.find((p) => p.id === T.id).resolved_at;
  world.tables.account_media.push({ ...world.tables.account_media[0], id: 'm_done_g1', ref_id: T.id }); // WO-10: its completion photo
  const before = await hubGet('home?buildingId=cl_a');
  const again = await call(qc, { method: 'POST', path: 'problems/update', token: 'tok-owner', body: { id: T.id, status: 'resolved' } });
  const row = world.tables.problem_reports.find((p) => p.id === T.id);
  ok('🔴 G1 a resolve sent for a ticket ALREADY resolved keeps its first resolved_at (a retried / double-tapped resolve)',
    () => again.status === 200 && row.status === 'resolved' && row.resolved_at === firstResolvedAt && again.body?.problem?.resolved_at === firstResolvedAt,
    `${show(again)} stored ${row?.resolved_at} first ${firstResolvedAt}`);
  ok('G2 …and logs no status change (resolved → resolved is not one)', () => statusRows(T.id).length === 0, JSON.stringify(statusRows(T.id)));
  const after = await hubGet('home?buildingId=cl_a');
  ok('🔴 G3 …so the hub\'s figure does not move', () => after.body?.resolve?.count === before.body?.resolve?.count && after.body.resolve.meanMs === before.body.resolve.meanMs,
    `${JSON.stringify(before.body?.resolve)} → ${JSON.stringify(after.body?.resolve)}`);
  const edit = await call(qc, { method: 'POST', path: 'problems/update', token: 'tok-owner', body: { id: T.id, status: 'resolved', priority: 'urgent', title: 'Coffee stain (re-titled)' } });
  const row2 = world.tables.problem_reports.find((p) => p.id === T.id);
  ok('G4 the rest of an edit sent with the resolve still lands; the completion time does not move',
    () => edit.status === 200 && row2.priority === 'urgent' && row2.title === 'Coffee stain (re-titled)' && row2.resolved_at === firstResolvedAt, `${show(edit)} stored ${row2?.resolved_at}`);
}
// Two people resolve the same open ticket at once: the second write lands after the first has
// already resolved it. Held deterministically by the fake's barrier (the first UPDATE parked until
// the second request has finished), not by timing.
seed();
{
  const T = TRAPS[4]; // still open
  world.tables.account_media.push({ ...world.tables.account_media[0], id: 'm_done_g5', ref_id: T.id });
  let release;
  const held = new Promise((r) => { release = r; });
  let parked = false;
  world.beforeQuery = async (q) => {
    if (!parked && q.table === 'problem_reports' && q.op === 'update') { parked = true; await held; }
  };
  const first = call(qc, { method: 'POST', path: 'problems/update', token: 'tok-owner', body: { id: T.id, status: 'resolved' } });
  // Wait until the first request is parked at its UPDATE, then a beat so the clocks differ.
  for (let i = 0; i < 200 && !parked; i += 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 15));
  const second = await call(qc, { method: 'POST', path: 'problems/update', token: 'tok-mgr', body: { id: T.id, status: 'resolved' } });
  release();
  const firstR = await first;
  world.beforeQuery = null;
  const row = world.tables.problem_reports.find((p) => p.id === T.id);
  ok('G5 both people\'s resolves answer 200', () => parked && firstR.status === 200 && second.status === 200, `${show(firstR)} / ${show(second)}`);
  ok('🔴 G6 the ticket keeps the resolved_at of the resolve that landed FIRST; the late one does not overwrite it',
    () => !!second.body?.problem?.resolved_at && row.resolved_at === second.body.problem.resolved_at, `stored ${row?.resolved_at} first-landed ${second.body?.problem?.resolved_at}`);
  ok('🔴 G7 …and ONE status change is logged, not two', () => statusRows(T.id).length === 1, JSON.stringify(statusRows(T.id).map((r) => r.actor_user_id)));
}
// A real reopen still lets the next resolve stamp a new completion time (D13 holds it end to end
// through the hub; here, the office's own Reopen → Resolve).
seed();
{
  const T = HUB_A[1];
  world.tables.account_media.push({ ...world.tables.account_media[0], id: 'm_done_g8', ref_id: T.id });
  const first = world.tables.problem_reports.find((p) => p.id === T.id).resolved_at;
  const open = await call(qc, { method: 'POST', path: 'problems/update', token: 'tok-owner', body: { id: T.id, status: 'open' } });
  const cleared = world.tables.problem_reports.find((p) => p.id === T.id).resolved_at;
  const done = await call(qc, { method: 'POST', path: 'problems/update', token: 'tok-owner', body: { id: T.id, status: 'resolved' } });
  const row = world.tables.problem_reports.find((p) => p.id === T.id);
  ok('G8 the office reopens it (resolved_at cleared) and resolves it again: a NEW completion time, two status changes logged',
    () => open.status === 200 && cleared === null && done.status === 200 && row.resolved_at && row.resolved_at !== first
      && Date.parse(row.resolved_at) > Date.parse(first) && statusRows(T.id).length === 2, `${show(done)} stored ${row?.resolved_at}`);
  // The demo stub answers as the server does (lib/qcApi stubUpdateProblem): it stamps only a ticket
  // that was not resolved yet, and clears the time on any other status.
  const stub = code('src/lib/qcApi.js');
  const body = stub.slice(stub.indexOf('function stubUpdateProblem'), stub.indexOf('function stubFirstReplyAt'));
  ok('G9 the demo stub resolves once too (stamps only a ticket not yet resolved)',
    () => /if \(s !== 'resolved'\) r\.resolved_at = null;/.test(body) && /else if \(normalizeStatus\(r\.status\) !== 'resolved'\) r\.resolved_at = nowIso\(\);/.test(body)
      && !/r\.resolved_at = s === 'resolved' \? nowIso\(\) : null/.test(body));
}

// ── H. the demo's closed tickets never age out of the window ─────────────────────
// The seeded book's closed tickets were stamped once, when a browser was first seeded, and never
// moved: three weeks later Coral Bay's tile read "No requests closed" until ?demo=reset. They are
// now re-placed relative to now whenever the manager's day is (lib/demoBootstrap: once the last
// placing is two hours old or yesterday's), each keeping its own story — closed N hours ago,
// after M hours open — and a ticket the viewer has reopened is left as they left it.
{
  const { installResolveShim } = await import('./deletion-core.mjs');
  installResolveShim(); // the data modules import extensionless paths (Vite's resolution)
  const stubs = await tryImport('../src/data/demoStubs.js');
  const sandbox = await tryImport('../src/lib/demoSandbox.js');
  const { INITIAL_STATE } = await tryImport('../src/data/seed.js');
  const coral = (INITIAL_STATE?.clients || []).find((c) => /Coral Bay/.test(c.name || ''))?.id;
  const T0 = Date.UTC(2026, 9, 1, 15, 0, 0);
  const LATER = T0 + (WINDOW_DAYS + 10) * DAY;
  const has2 = has(stubs.seededClosedTickets) && has(sandbox.replaceClosedRows);
  ok('H0 the seeded book\'s closed tickets can be built for any moment, and re-placed', () => has2, `${stubs.__error || ''} ${sandbox.__error || ''}`);
  const atT0 = has2 ? stubs.seededClosedTickets(T0) : [];
  const atLater = has2 ? stubs.seededClosedTickets(LATER) : [];
  ok('H1 …the closed ones only, the same tickets at either moment, each placed relative to it',
    () => atT0.length >= 4 && atT0.every((r) => r.status === 'resolved' && r.resolved_at) && atT0.map((r) => r.id).join() === atLater.map((r) => r.id).join()
      && atT0.every((r, i) => Date.parse(atLater[i].resolved_at) - Date.parse(r.resolved_at) === LATER - T0), JSON.stringify(atT0.map((r) => r.id)));
  // A browser seeded at T0, opened again long after the window has passed them by.
  const reopenedId = atT0[0]?.id;
  const stale = atT0.map((r) => (r.id === reopenedId ? { ...r, status: 'open', resolved_at: null } : r))
    .concat([{ id: 'pr_viewer_own', status: 'resolved', created_at: iso(T0 - H), resolved_at: iso(T0) }]);
  const coralTile = (rows, now) => homeLib.hubResolveTile((rows || []).filter((r) => r.client_id === coral && r.origin === 'portal'), { now });
  const decayed = coralTile(atT0, LATER);
  const fresh = coralTile(atT0, T0);
  ok('H2 (the decay) left where they were seeded, Coral Bay\'s figure reads none once the window has passed', () => !!coral && fresh.count >= 1 && decayed.count === 0, `${JSON.stringify(fresh)} → ${JSON.stringify(decayed)}`);
  const placed = has2 ? sandbox.replaceClosedRows(stale, atLater) : stale;
  const pairs = placed.filter((r) => r.id !== reopenedId && r.id !== 'pr_viewer_own').map((r) => [r, atT0.find((x) => x.id === r.id), atLater.find((x) => x.id === r.id)]);
  ok('🔴 H3 re-placed at the later moment, each closed ticket lands where a fresh seed would put it, its span and its thread moved with it',
    () => pairs.length >= 3 && pairs.every(([r, old, nu]) => r.resolved_at === nu.resolved_at && r.created_at === nu.created_at
      && Date.parse(r.resolved_at) - Date.parse(r.created_at) === Date.parse(old.resolved_at) - Date.parse(old.created_at)
      && (r.messages || []).every((m, i) => Date.parse(m.created_at) - Date.parse(old.messages[i].created_at) === LATER - T0)), JSON.stringify(pairs.map(([r]) => [r.id, r.resolved_at])));
  ok('🔴 H4 …so Coral Bay\'s tile reads the same figure it read when seeded', () => {
    const now = coralTile(placed.map((r) => (r.id === reopenedId ? atLater.find((x) => x.id === r.id) : r)), LATER);
    return fresh.count >= 1 && now.count === fresh.count && now.meanMs === fresh.meanMs;
  });
  ok('H5 a closed ticket the viewer REOPENED is left as they left it, and a row not in the story is untouched',
    () => placed.find((r) => r.id === reopenedId)?.status === 'open' && placed.find((r) => r.id === reopenedId).resolved_at === null
      && placed.find((r) => r.id === 'pr_viewer_own')?.resolved_at === iso(T0));
  const boot = code('src/lib/demoBootstrap.js');
  ok('H6 the demo re-places them with the manager\'s day (same clock: two hours old or yesterday\'s)',
    () => /const placeManagerDay = \(prev\) => \{[\s\S]*replaceClosedRows\([\s\S]*seededClosedTickets\(day\.nowMs\)[\s\S]*\n {2}\};/.test(boot));
}

// ── F. wiring ────────────────────────────────────────────────────────────────
{
  const demo = code('src/lib/hubDemo.js');
  const api = code('src/lib/qcApi.js');
  const homePage = code('src/pages/hub/HubHome.jsx');
  const tile = code('src/pages/hub/HubResolveTile.jsx');
  const report = code('src/pages/reports/ResolveTimeReport.jsx');
  const reports = code('src/pages/Reports.jsx');
  const registry = code('src/lib/masterSearch/registry.js');
  const route = code('api/hub/[...path].js');
  const qcRoute = code('api/qc/[...path].js');
  ok('F1 the hub\'s route and its demo twin build the field with the SAME projection', () => /hubResolveTile\(/.test(route) && /hubResolveTile\(/.test(demo));
  ok('F2 the report\'s route and its demo stub run the SAME rule', () => /resolveReport\(/.test(qcRoute) && /resolveReport\(/.test(api) && /export async function resolveTimes\(/.test(api));
  ok('F3 Home draws the tile, beside Requests (the next entry in TILES)', () => /\{ key: 'requests'[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*\{ key: 'resolve', Tile: HubResolveTile/.test(homePage) && existsSync(path.join(APP, 'src/pages/hub/HubResolveTile.jsx')));
  ok('F4 the tile reads its words from the catalog in English (LANG-8: the hub stays English)', () => /from '\.\.\/\.\.\/i18n\/core'/.test(tile) && /english\('resolveTime\.hub\./.test(tile) && /formatResolveDuration\(/.test(tile));
  ok('F5 Reports lists "Time to resolve", gated on qc.view as its route is', () => /id: 'resolve-time'[^\n]*perm: 'qc\.view'/.test(reports) && /ResolveTimeReport/.test(reports) && /useT\(\)/.test(report) && /qcApi\.resolveTimes\(/.test(report));
  ok('F6 search finds it, with the report\'s own extra key', () => /to: '\/reports\?r=resolve-time'[^\n]*permsAll: \['qc\.view'\]/.test(registry));
  ok('F7 the formatter\'s words, the tile\'s and the report\'s are catalog lines', () => ['resolveTime.dur.minutes', 'resolveTime.hub.title', 'resolveTime.report.tab'].every((k) => k in core.SOURCE_CATALOG));
  ok('F8 the report tab\'s English equals the search entry\'s label', () => /label: 'Time to resolve'/.test(registry) && core.english('resolveTime.report.tab') === 'Time to resolve');
}

console.log(`\ntest-resolve-time: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
