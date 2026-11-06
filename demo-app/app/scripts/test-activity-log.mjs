// CS-379 — the system-wide activity log. Matt's answers LOG-1..8 (2026-09-29).
//
// The register's finding: nothing recorded who did what. 183 reducer actions saved the whole
// blob and kept no diff, door-code reveals reached only the console, job tombstones were
// reaped at 30 days, and CRM "activity" rows were client-authored and editable. So every rule
// below is proven against the REAL handlers through scripts/fake-supabase.mjs — no network,
// no credentials, no live project.
//
// WHAT IS PROVEN
//   A  the vocabulary: only the set list is storable, and the money flag comes from it
//   B  before/after for money, roles, schedules and inspections (LOG-3)
//   C  the org_state diff (pay, roles, customers, invoice amounts) + its COST. A supply request's
//      status change is logged by /api/supplies since SUP-13 (test-supplies-route.mjs).
//   D  who sees what, per role, against the real read route (LOG-4) — including a crew login
//      holding a per-user grant of activity.view
//   E  retention: the 3-year horizon, and that the purge rides the daily reap cron (LOG-5)
//   F  the exports: a complete paged read, the csvCell formula guard, org-zone dates (LOG-6)
//   G  a failed log write never fails the user's action (the best-effort contract)
//   H  the client hub's service-event subset: nothing internal leaks (LOG-1 / Wave 2)
//   I  the write points are wired: each named route calls the one writer
//
//   node app/scripts/test-activity-log.mjs
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { installFakeSupabase, world, resetWorld } from './fake-supabase.mjs';
import { seedPermissions, PERMISSIONS } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const pure = await import('../src/lib/activityLog.js');
const exportLib = await import('../src/lib/activityLogExport.js');
const server = await import('../api/_lib/activityLog.js');
const activityRoute = (await import('../api/activity/[...path].js')).default;
const orgStateRoute = (await import('../api/state/org-state.js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
// A file that does not exist reads as empty, so a MISSING migration / route / wiring is a
// named failure rather than a crash that hides every check after it.
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };

// ── the people ───────────────────────────────────────────────────────────────
// `crewG` is a crew member GRANTED activity.view — the case that proves crew's "nothing" is
// a ROLE floor and not a key (a grant must buy them nothing).
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },     // claim-less, exactly as live
  mgr2: { id: 'u_mgr2', role: 'manager', claim: false },    // supervises nothing
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewG: { id: 'u_crew_g', role: 'crew', claim: true },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: `${k} person`,
  pay: p.role === 'crew' ? { type: 'hourly', hourlyRate: 15 } : { type: 'none' },
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k),
  app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const OVERRIDES = [{ userId: 'u_crew_g', grants: ['activity.view'], revokes: [] }];

const CLIENTS = [
  { id: 'cl_alpha', name: 'Alpha Tower', supervisorId: 'u_mgr' },
  { id: 'cl_beta', name: 'Beta Plaza', supervisorId: null },
];

const baseState = () => ({
  users: roster.map((u) => ({ ...u })),
  permissions: seedPermissions(),
  userPermissionOverrides: OVERRIDES,
  clients: CLIENTS.map((c) => ({ ...c })),
  invoices: [{ id: 'INV-1', clientId: 'cl_alpha', lineItems: [{ qty: 1, unitPrice: 100 }], taxRate: 0, payments: [] }],
  supplyRequests: [{ id: 'sr_1', clientId: 'cl_beta', status: 'open' }],
  company: { timezone: 'America/New_York' },
});

function buildWorld(extra = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 7, state: baseState(), protected_fingerprint: null, updated_at: '2026-09-29T00:00:00.000Z' }],
      activity_log: [],
      activity_log_baseline: [],
      ...extra,
    },
    logins,
  });
}

// ── a request through a real handler ─────────────────────────────────────────
async function call(handler, { method = 'GET', path, token, query = {}, body } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, ...(path ? { subpath: path } : {}) };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 10000);
      const done = (status, b, headers) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const hdrs = {};
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { hdrs[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b, hdrs); return this; },
        send(b) { done(this.statusCode, b, hdrs); return this; },
        end(b) { done(this.statusCode, b ?? null, hdrs); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const listFor = (who, query = {}) => call(activityRoute, { path: 'list', token: who ? `tok-${who}` : undefined, query });
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

console.log('CS-379 activity log — the set list, before/after, who sees what, retention, exports:\n');

// ── A. the vocabulary is the set list (LOG-2) ────────────────────────────────
{
  ok('every action in the registry declares a label, a group and an entity',
    pure.ACTION_KEYS.length > 0 && pure.ACTION_KEYS.every((a) => pure.ACTIONS[a].label && pure.ACTIONS[a].group && pure.ACTIONS[a].entity));
  ok('🔴 sign-ins are NOT in the vocabulary (LOG-8 a, "not now")',
    !pure.ACTION_KEYS.some((a) => /sign.?in|login|logout|session/i.test(a)));
  ok('LOG-2\'s list is covered: inspections, schedule, time, pay, roles, customers, tickets, supplies, codes, automatic',
    ['inspection.submitted', 'inspection.edited', 'job.created', 'job.moved', 'job.cancelled', 'job.crew_changed',
      'time.corrected', 'time.added', 'time.deleted', 'time.restored', 'time.approved', 'time.overtime_approved',
      'pay.rate_changed', 'user.role_changed', 'customer.added', 'customer.archived', 'customer.reactivated',
      'ticket.status_changed', 'ticket.replied', 'supply_request.status_changed', 'code.revealed',
      'alert.sent', 'alert.escalated'].every((a) => pure.isKnownAction(a)),
    pure.ACTION_KEYS.join(', '));
  ok('an action OUTSIDE the vocabulary is refused, never stored',
    server.activityRow({ action: 'not.a.real.action', summary: 'x' }) === null);
  ok('an entry with no summary is refused (a row nobody can read is not a record)',
    server.activityRow({ action: 'code.revealed', summary: '   ' }) === null);
  // The money flag is the ONLY thing an admin's view turns on, so it must come from the
  // registry and never from a caller.
  const forged = server.activityRow({ action: 'pay.rate_changed', summary: 'x', is_money: false, isMoney: false });
  ok('🔴 is_money comes from the registry — a caller cannot forge it off a pay change', forged.is_money === true);
  ok('… and a non-money action cannot be flagged as money by a caller',
    server.activityRow({ action: 'job.moved', summary: 'x', isMoney: true }).is_money === false);
  ok('MONEY_ACTIONS is derived from the registry, not restated',
    pure.MONEY_ACTIONS.includes('pay.rate_changed') && pure.MONEY_ACTIONS.includes('invoice.amount_changed')
    && pure.MONEY_ACTIONS.every((a) => pure.ACTIONS[a].money));
  ok('an AUTOMATIC action stores no actor (a cron blames nobody)',
    server.activityRow({ action: 'alert.sent', summary: 'x', actorUserId: 'u_owner', actorRole: 'owner' }).actor_user_id === null);
}

// ── B / C. the org_state diff, with before and after (LOG-3) ─────────────────
{
  const prev = baseState();
  const next = baseState();
  next.users = next.users.map((u) => (u.id === 'u_crew' ? { ...u, pay: { type: 'hourly', hourlyRate: 16 } } : u));
  next.users = next.users.map((u) => (u.id === 'u_crew_g' ? { ...u, role: 'manager' } : u));
  next.clients = [...next.clients, { id: 'cl_gamma', name: 'Gamma Court' }];
  next.clients = next.clients.map((c) => (c.id === 'cl_beta' ? { ...c, status: 'inactive' } : c));
  next.invoices = [{ ...next.invoices[0], lineItems: [{ qty: 1, unitPrice: 125 }] }];
  next.supplyRequests = [{ ...next.supplyRequests[0], status: 'approved' }];

  const events = pure.orgStateActivityEvents(prev, next);
  const byAction = new Map(events.map((e) => [e.action, e]));
  ok('a PAY RATE change is logged', byAction.has('pay.rate_changed'));
  // The summary is LOG-3's example, "pay rate $15.00 → $16.00" — asserted against the SEED
  // rates, not a restated literal.
  const payRow = byAction.get('pay.rate_changed');
  const was = prev.users.find((u) => u.id === 'u_crew').pay.hourlyRate;
  const now = next.users.find((u) => u.id === 'u_crew').pay.hourlyRate;
  ok(`… with before and after in words ("hourly $${was}.00 → hourly $${now}.00")`,
    !!payRow && payRow.summary.includes(`$${was}.00`) && payRow.summary.includes(`$${now}.00`) && payRow.summary.includes('→'),
    payRow?.summary);
  ok('… and the machine-readable pair', !!payRow && payRow.before.pay.hourlyRate === was && payRow.after.pay.hourlyRate === now);
  ok('a ROLE change is logged with before and after',
    byAction.get('user.role_changed')?.before.role === 'crew' && byAction.get('user.role_changed')?.after.role === 'manager');
  ok('a customer ADDED is logged', byAction.get('customer.added')?.entityId === 'cl_gamma');
  ok('a customer ARCHIVED is logged (status inactive — this build has no separate archive flag)',
    byAction.get('customer.archived')?.clientId === 'cl_beta');
  ok('an INVOICE AMOUNT change is logged with before and after (LOG-3 names invoice amounts)',
    byAction.get('invoice.amount_changed')?.before.total === 100 && byAction.get('invoice.amount_changed')?.after.total === 125);
  // SUP-13 (2026-10-05): requests left the shared record, so the blob diff must NOT log them — a
  // stale bundle still writing `supplyRequests` would otherwise log a status change that never
  // happened (the route restores the slice) — the route logs the real one (test-supplies-route).
  ok('a supplyRequests change in the blob is NOT logged by the diff (the supplies route logs decisions)',
    !byAction.has('supply_request.status_changed'));
  ok('the pay change is flagged money and the role change is not',
    server.activityRow({ ...payRow, summary: payRow.summary }).is_money === true
    && server.activityRow({ ...byAction.get('user.role_changed') }).is_money === false);

  // A reactivation is the reverse, and a removal is its own action.
  const back = baseState();
  const arch = baseState();
  arch.clients = arch.clients.map((c) => (c.id === 'cl_beta' ? { ...c, status: 'inactive' } : c));
  ok('a customer REACTIVATED is logged',
    pure.orgStateActivityEvents(arch, back).some((e) => e.action === 'customer.reactivated' && e.clientId === 'cl_beta'));
  const gone = baseState();
  gone.clients = gone.clients.filter((c) => c.id !== 'cl_beta');
  ok('a customer REMOVED is logged', pure.orgStateActivityEvents(back, gone).some((e) => e.action === 'customer.removed'));

  // NOT logged: the ordinary save. This is what keeps the log a set list rather than a firehose.
  const noisy = baseState();
  noisy.clients = noisy.clients.map((c) => (c.id === 'cl_alpha' ? { ...c, notes: 'gate code changed', phone: '555' } : c));
  ok('🔴 an ordinary edit (notes, phone) logs NOTHING — LOG-2 is a set list, not a firehose',
    pure.orgStateActivityEvents(prev, noisy).length === 0);
  // jsonb hands object keys back in its own order, and a spread re-orders them, so a reorder
  // must NOT read as a change — or every save would pay the diff and log a phantom edit.
  const reorder = (v) => (Array.isArray(v) ? v.map(reorder)
    : (v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reorder(v[k])]))
      : v));
  ok('a key REORDER is not a change (jsonb re-sorts keys)',
    pure.activityDigestInput(prev) === pure.activityDigestInput(reorder(prev)));
  ok('… and a reordered state produces no events', pure.orgStateActivityEvents(prev, reorder(prev)).length === 0);
}

// ── C2. the org_state WRITE PATH logs, and the fast path costs nothing ───────
{
  buildWorld();
  const next = baseState();
  next.users = next.users.map((u) => (u.id === 'u_crew' ? { ...u, pay: { type: 'hourly', hourlyRate: 16 } } : u));
  const r = await call(orgStateRoute, { method: 'POST', token: 'tok-owner', body: { state: next, baseVersion: 7, build: 1, tab: 't1' } });
  ok('the org_state save still succeeds with the log wired in', r.status === 200 && r.body?.ok === true, show(r));
  const rows = world.tables.activity_log || [];
  ok('… and the pay-rate change landed in activity_log exactly once',
    rows.filter((x) => x.action === 'pay.rate_changed').length === 1, `rows: ${JSON.stringify(rows.map((x) => x.action))}`);
  ok('… stamped with the ACTOR from the verified claim, never the body',
    rows[0]?.actor_user_id === 'u_owner' && rows[0]?.actor_role === 'owner');
  ok('… and the baseline advanced to the committed version',
    world.tables.activity_log_baseline?.[0]?.state_version === 8);

  // THE COST. A save that touches nothing loggable must not read the blob's slices at all.
  const version = world.tables.org_state[0].version;
  const committed = world.tables.org_state[0].state;
  world.log = [];
  const quiet = { ...committed, clients: committed.clients.map((c) => ({ ...c, notes: 'a note nobody audits' })) };
  const r2 = await call(orgStateRoute, { method: 'POST', token: 'tok-owner', body: { state: quiet, baseVersion: version, build: 1, tab: 't1' } });
  ok('a save that changes nothing loggable still succeeds', r2.status === 200, show(r2));
  const activityReads = world.log.filter((q) => q.table === 'org_state' && /invoices/.test(q.cols || ''));
  ok('🔴 … and pays NO slice read for the log (the baseline hash matched)', activityReads.length === 0,
    `slice reads: ${activityReads.length}`);
  ok('… and wrote no activity row', (world.tables.activity_log || []).filter((x) => x.action !== 'pay.rate_changed').length === 0);
  const baselineReads = world.log.filter((q) => q.table === 'activity_log_baseline' && q.op === 'select');
  ok('… the whole cost is one baseline read (a single row, one text column)', baselineReads.length === 1,
    `baseline reads: ${baselineReads.length}`);
}

// ── C3. the measured cost of the diff itself ─────────────────────────────────
{
  // At Matt's stated volume (1,500 cleaners × 750 locations — meetings note): the hash and
  // the diff both run over the state the route already holds in memory.
  const big = baseState();
  big.users = Array.from({ length: 1500 }, (_, i) => ({ id: `u_${i}`, role: 'crew', status: 'active', pay: { type: 'hourly', hourlyRate: 15 + (i % 7) } }));
  big.clients = Array.from({ length: 750 }, (_, i) => ({ id: `cl_${i}`, name: `Site ${i}`, status: i % 9 === 0 ? 'inactive' : 'active' }));
  big.invoices = Array.from({ length: 2000 }, (_, i) => ({ id: `INV-${i}`, clientId: `cl_${i % 750}`, lineItems: [{ qty: 1, unitPrice: 100 + i }], taxRate: 0 }));
  const changed = { ...big, users: big.users.map((u, i) => (i === 0 ? { ...u, pay: { type: 'hourly', hourlyRate: 21 } } : u)) };
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) pure.activityDigestInput(changed);
  const hashMs = (performance.now() - t0) / 20;
  const t1 = performance.now();
  let n = 0;
  for (let i = 0; i < 20; i += 1) n = pure.orgStateActivityEvents(big, changed).length;
  const diffMs = (performance.now() - t1) / 20;
  console.log(`   cost at 1500 cleaners / 750 customers / 2000 invoices:`);
  console.log(`     change detector (every save): ${hashMs.toFixed(1)} ms   diff (only when something moved): ${diffMs.toFixed(1)} ms`);
  ok(`the change detector adds no noticeable cost to a save (${hashMs.toFixed(1)} ms, budget 60 ms)`, hashMs < 60, `${hashMs} ms`);
  ok(`the diff itself is cheap when it does run (${diffMs.toFixed(1)} ms, budget 60 ms)`, diffMs < 60, `${diffMs} ms`);
  ok('… and it found the one pay change among 4,750 records', n === 1, `found ${n}`);
}

// ── D. who sees what (LOG-4), against the real read route ───────────────────
const SEED = [
  { action: 'pay.rate_changed', client_id: null, summary: 'pay rate $15.00 -> $16.00', is_money: true },
  { action: 'invoice.amount_changed', client_id: 'cl_alpha', summary: 'invoice amount changed', is_money: true },
  { action: 'job.cancelled', client_id: 'cl_alpha', summary: 'Clean cancelled', is_money: false },
  { action: 'job.cancelled', client_id: 'cl_beta', summary: 'Clean cancelled', is_money: false },
  { action: 'user.role_changed', client_id: null, summary: 'access level crew -> manager', is_money: false },
  { action: 'alert.sent', client_id: 'cl_beta', summary: 'Late shift', is_money: false, auto: true },
];
function seedLog() {
  buildWorld();
  world.tables.activity_log = SEED.map((r, i) => ({
    id: `al_${i}`, organization_id: ORG, occurred_at: `2026-09-2${i}T12:00:00.000Z`,
    actor_user_id: r.auto ? null : 'u_owner', actor_name: r.auto ? null : 'owner person',
    actor_role: r.auto ? null : 'owner', auto: !!r.auto, action: r.action,
    entity_type: pure.actionEntity(r.action), entity_id: `e_${i}`,
    client_id: r.client_id, client_name: null, summary: r.summary,
    before: null, after: null, is_money: r.is_money,
  }));
}
{
  const KEY = 'activity.view';
  ok(`the gate's key exists and defaults to owner/admin/manager, never crew`,
    Array.isArray(PERMISSIONS[KEY]?.defaultRoles)
    && ['owner', 'admin', 'manager'].every((r) => PERMISSIONS[KEY].defaultRoles.includes(r))
    && !PERMISSIONS[KEY].defaultRoles.includes('crew'),
    JSON.stringify(PERMISSIONS[KEY]?.defaultRoles));

  seedLog();
  const owner = await listFor('owner');
  ok('the OWNER sees everything', owner.status === 200 && owner.body.total === SEED.length, show(owner));

  seedLog();
  const admin = await listFor('admin');
  const moneyCount = SEED.filter((r) => r.is_money).length;
  ok(`🔴 an ADMIN sees everything EXCEPT pay and money (${SEED.length} - ${moneyCount})`,
    admin.status === 200 && admin.body.total === SEED.length - moneyCount, show(admin));
  ok('🔴 … and no money row reaches them at all',
    (admin.body.entries || []).every((e) => !e.isMoney && !pure.isMoneyAction(e.action)),
    JSON.stringify((admin.body.entries || []).map((e) => e.action)));
  ok('… the response says the view is scoped, so it is not mistaken for the whole record',
    admin.body.scope?.visibility === 'no-money');

  seedLog();
  const mgr = await listFor('mgr');
  const supervised = SEED.filter((r) => r.client_id === 'cl_alpha' && !r.is_money).length;
  ok('🔴 a MANAGER sees only the customers they supervise', mgr.status === 200 && mgr.body.total === supervised, show(mgr));
  ok('🔴 … never a row for a customer they do not supervise',
    (mgr.body.entries || []).every((e) => e.clientId === 'cl_alpha'),
    JSON.stringify((mgr.body.entries || []).map((e) => e.clientId)));
  ok('🔴 … and never a customer-less row (a pay rate or an access level is nobody\'s account)',
    (mgr.body.entries || []).every((e) => !!e.clientId));

  seedLog();
  const mgr2 = await listFor('mgr2');
  ok('a manager who supervises nothing sees nothing (an empty scope, never "everything")',
    mgr2.status === 200 && mgr2.body.total === 0, show(mgr2));

  seedLog();
  const crew = await listFor('crew');
  ok('🔴 CREW get nothing — 403, not an empty list', crew.status === 403, show(crew));
  ok('… and the refusal carries no entry', !crew.body?.entries);

  seedLog();
  const crewG = await listFor('crewG');
  ok('🔴 a CREW login GRANTED activity.view is still refused — crew\'s "nothing" is a role floor, not a key',
    crewG.status === 403, show(crewG));

  seedLog();
  const anon = await listFor(null);
  ok('no session → 401, never an entry', anon.status === 401, show(anon));

  // The pure rule agrees with the route for every role — one definition, two checks.
  for (const [role, expect] of [['owner', 'all'], ['admin', 'no-money'], ['manager', 'supervised'], ['crew', 'none'], [null, 'none']]) {
    ok(`logVisibilityFor(${JSON.stringify(role)}) = ${expect}`, pure.logVisibilityFor(role) === expect);
  }
  ok('maySeeEntry refuses a money row for an admin',
    !pure.maySeeEntry({ action: 'pay.rate_changed' }, { visibility: 'no-money' }));
  ok('maySeeEntry refuses an unsupervised customer for a manager',
    !pure.maySeeEntry({ action: 'job.moved', clientId: 'cl_beta' }, { visibility: 'supervised', supervisedIds: ['cl_alpha'] }));
}

// ── D2. the filters narrow, and a malformed one is refused not widened ──────
{
  seedLog();
  const byGroup = await listFor('owner', { group: 'schedule' });
  ok('the Action-type filter narrows to that group\'s actions',
    byGroup.status === 200 && byGroup.body.total === SEED.filter((r) => r.action.startsWith('job.')).length, show(byGroup));
  seedLog();
  const byCustomer = await listFor('owner', { clientId: 'cl_beta' });
  ok('the Customer filter narrows to that customer',
    byCustomer.status === 200 && byCustomer.body.total === SEED.filter((r) => r.client_id === 'cl_beta').length, show(byCustomer));
  seedLog();
  const bad = await listFor('owner', { group: 'everything-please' });
  ok('🔴 an unknown Action-type group is a 400, never a quietly widened read', bad.status === 400, show(bad));
  seedLog();
  const badDate = await listFor('owner', { fromIso: '1' });
  ok('🔴 a malformed date is a 400, never a dropped filter', badDate.status === 400, show(badDate));
  seedLog();
  const backwards = await listFor('owner', { fromIso: '2026-09-20T00:00:00.000Z', toIso: '2026-09-01T00:00:00.000Z' });
  ok('a backwards range is a 400', backwards.status === 400, show(backwards));
  seedLog();
  const paged = await listFor('owner', { limit: 2 });
  const pagedRows = paged.body?.entries || [];
  ok('the list is paged and NEWEST FIRST',
    pagedRows.length === 2 && paged.body?.total === SEED.length
    && Date.parse(pagedRows[0].occurredAt) > Date.parse(pagedRows[1].occurredAt), show(paged));
}

// ── E. retention (LOG-5) ────────────────────────────────────────────────────
{
  ok('the retention horizon is 3 years, from the shared constant', pure.RETENTION_YEARS === 3);
  const now = Date.parse('2026-09-29T00:00:00.000Z');
  const cutoff = pure.retentionCutoffIso(now);
  ok('retentionCutoffIso is exactly RETENTION_YEARS back', cutoff.startsWith(`${2026 - pure.RETENTION_YEARS}-09-29`), cutoff);

  buildWorld();
  world.tables.activity_log = [
    { id: 'old', organization_id: ORG, occurred_at: '2020-01-01T00:00:00.000Z', action: 'job.moved', entity_type: 'job', summary: 'old', is_money: false },
    { id: 'new', organization_id: ORG, occurred_at: '2026-09-01T00:00:00.000Z', action: 'job.moved', entity_type: 'job', summary: 'new', is_money: false },
  ];
  const purge = await server.purgeExpiredActivity({ now });
  ok('the purge removes only what is past the horizon', purge.purged === 1 && world.tables.activity_log.length === 1);
  ok('… and the row inside the window is untouched', world.tables.activity_log[0].id === 'new');

  // ── the database's own belt ────────────────────────────────────────────────
  // 🔴 THE PRIVILEGES ARE REPLAYED, NOT PATTERN-MATCHED. The create migration granted
  // `select, insert, delete` and its header claimed that made "never edited" a privilege. It
  // did not: Supabase ships `alter default privileges … grant all on tables to service_role`,
  // so the table was born with ALL and a GRANT only ADDS — the post-apply read-back found
  // UPDATE, TRUNCATE, TRIGGER and REFERENCES still held, and TRUNCATE does not fire row
  // triggers, so it walked past the retention guard. A test that greps for the grant LINE
  // would have passed then and would pass again on the next table. So this starts from what
  // Postgres actually starts from and replays every grant/revoke in the migrations, in file
  // order, to the set the role really ends up with.
  const sql = read('../../supabase/migrations/20260930130000_activity_log.sql');
  const fixSql = read('../../supabase/migrations/20260930140000_activity_log_revoke_update_truncate.sql');
  const ALL_TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  // Supabase's default privileges hand ALL to these roles on every new table in `public`; the
  // create migration then revokes the browser roles. That default is the whole reason this
  // replay exists — model it, don't assume a clean slate.
  const held = { service_role: new Set(ALL_TABLE_PRIVS), anon: new Set(ALL_TABLE_PRIVS), authenticated: new Set(ALL_TABLE_PRIVS) };
  const STMT = /\b(grant|revoke)\s+([a-z, \n\r\t]+?)\s+on\s+public\.activity_log\s+(?:to|from)\s+([a-z_,\s]+?)\s*;/gi;
  let replayed = 0;
  for (const src of [sql, fixSql]) {
    for (const m of src.matchAll(STMT)) {
      const [, verb, privText, roleText] = m;
      const privs = /\ball\b/i.test(privText)
        ? ALL_TABLE_PRIVS
        : privText.split(',').map((x) => x.trim().toUpperCase()).filter((x) => ALL_TABLE_PRIVS.includes(x));
      const roles = roleText.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      for (const role of roles) {
        if (!held[role]) held[role] = new Set();
        for (const p of privs) { if (verb.toLowerCase() === 'grant') held[role].add(p); else held[role].delete(p); }
      }
      replayed += 1;
    }
  }
  const sorted = (s) => [...s].sort().join(',');
  ok('the activity_log migration exists', /create table if not exists public\.activity_log/i.test(sql));
  ok('the follow-up that narrows the grants exists', /revoke\s+update,\s*truncate,\s*trigger,\s*references\s+on\s+public\.activity_log\s+from\s+service_role/i.test(fixSql));
  ok(`replayed every grant/revoke on the table (${replayed} statements across both migrations)`, replayed >= 4, `${replayed}`);
  // THE assertion: the set the server's own role ends up with, not the text of one line.
  ok('🔴 service_role ends up with exactly SELECT, INSERT, DELETE — no UPDATE, no TRUNCATE, no TRIGGER, no REFERENCES',
    sorted(held.service_role) === 'DELETE,INSERT,SELECT', `service_role holds ${sorted(held.service_role) || '(nothing)'}`);
  for (const role of ['anon', 'authenticated']) {
    ok(`🔴 ${role} ends up with NOTHING (no browser reaches the table)`, held[role].size === 0, `${role} holds ${sorted(held[role])}`);
  }
  ok('… and RLS is on with no policies', /alter table public\.activity_log enable row level security/i.test(sql)
    && !/create policy[^;]*on\s+public\.activity_log/i.test(sql + fixSql));
  // The two triggers: the row guard, and the statement guard TRUNCATE needs (a TRUNCATE
  // trigger cannot be row-level — which is exactly how it used to slip through).
  ok('a ROW trigger refuses every UPDATE and any DELETE inside the retention window',
    /before update or delete on public\.activity_log/i.test(sql)
    && /append-only and cannot be edited/i.test(sql)
    && new RegExp(`interval '${pure.RETENTION_YEARS} years'`, 'i').test(sql));
  ok('🔴 a STATEMENT-level BEFORE TRUNCATE trigger refuses TRUNCATE outright (it fires no row trigger)',
    /before truncate on public\.activity_log/i.test(fixSql)
    && /for each statement/i.test(fixSql)
    && /raise exception/i.test(fixSql));
  ok('the create migration records that it is APPLIED, and points at its correction',
    /APPLIED TO PRODUCTION/i.test(sql) && /CORRECTED BY 20260930140000/i.test(sql) && /forward-fix:/i.test(sql));
  ok('the follow-up is NOT APPLIED, is idempotent and carries its forward-fix',
    /NOT APPLIED/i.test(fixSql) && /forward-fix:/i.test(fixSql)
    && /create or replace function/i.test(fixSql) && /drop trigger if exists/i.test(fixSql));
  ok('… and neither file still claims "no grantee anywhere that may UPDATE"',
    !/there is no grantee anywhere that may UPDATE a row\.(?!')/i.test(fixSql)
    && /THE NEXT SENTENCE WAS WRONG/i.test(sql));
  // ⚠️ THE LIMIT OF AN OFFLINE SUITE, stated rather than papered over: this proves what the
  // migrations SAY. No harness here emulates Postgres privileges (fake-supabase does not, and
  // lint:sql only looks at SECURITY DEFINER functions), so the EFFECTIVE grants on the live
  // table can only be confirmed by the read-only catalog query in the follow-up's header
  // (`information_schema.role_table_grants` + `pg_trigger`). That is a read-back for whoever
  // applies it, not something this file can do.
  ok('the follow-up carries the read-only catalog query its read-back needs',
    /role_table_grants/i.test(fixSql) && /pg_trigger/i.test(fixSql));
  ok('… and says plainly that the table OWNER cannot be locked out (the honest ceiling)',
    /HONEST CEILING/i.test(fixSql));
  // The purge has to actually be scheduled — a purge nobody calls is not retention.
  const reap = read('./../api/cron/reap.js');
  ok('🔴 the purge RIDES the existing daily reap cron', /purgeExpiredActivity/.test(reap));
  const vercel = JSON.parse(read('./../vercel.json'));
  ok('… and that cron is scheduled daily', vercel.crons.some((c) => c.path === '/api/cron/reap' && /^\d+ \d+ \* \* \*$/.test(c.schedule)));
}

// ── F. the exports (LOG-6) ──────────────────────────────────────────────────
{
  const entries = [
    { id: 'a', occurredAt: '2026-09-29T02:30:00.000Z', actorName: 'Renata Cruz', actorRole: 'manager', auto: false, action: 'job.moved', clientName: 'Alpha Tower', summary: 'Clean moved to a new time', before: { startAt: '2026-09-28T13:00:00.000Z' }, after: { startAt: '2026-09-29T13:00:00.000Z' }, entityType: 'job', entityId: 'j1' },
    // A formula-shaped free-text summary: a dispute pack is opened in Excel.
    { id: 'b', occurredAt: '2026-09-29T03:00:00.000Z', actorName: '=cmd|\' /c calc\'!A1', actorRole: 'admin', auto: false, action: 'ticket.status_changed', clientName: 'Alpha Tower', summary: '=1+1 ticket reopened', before: null, after: null, entityType: 'work_order', entityId: 'w1' },
  ];
  const csv = exportLib.activityCsv(entries, { tz: 'America/New_York' });
  ok('the CSV has a header row and one row per entry', csv.trim().split('\r\n').length === entries.length + 1);
  ok('🔴 a formula-shaped cell is neutralized by the SHARED csvCell guard (Excel must not run it)',
    csv.includes("\"'=1+1 ticket reopened\"") && csv.includes("\"'=cmd"), csv.split('\r\n')[2]);
  // 02:30 UTC is the previous DAY in the org's zone — the whole point of org-zone dates.
  // Asserted on the "When" CELL, not the line (the before/after cell quotes other instants).
  const whenCell = csv.split('\r\n')[1].split('","')[0].replace(/^"/, '');
  ok('🔴 the When column is written in the ORG\'s zone, not the server\'s UTC (02:30 UTC = Sep 28 in New York)',
    whenCell.startsWith('Sep 28, 2026') && !whenCell.includes('Sep 29'), whenCell);
  ok('… the same instant in UTC would have named the next day',
    pure.fmtStampIn(entries[0].occurredAt, 'UTC').startsWith('Sep 29, 2026'),
    pure.fmtStampIn(entries[0].occurredAt, 'UTC'));
  ok('the before/after column re-zones the instants it quotes',
    pure.beforeAfterText(entries[0], 'America/New_York').includes('Sep 28, 2026'),
    pure.beforeAfterText(entries[0], 'America/New_York'));
  const html = exportLib.buildActivityLogHtml({ entries, clientName: 'Alpha Tower', fromIso: '2026-09-01T00:00:00.000Z', toIso: '2026-09-30T00:00:00.000Z', tz: 'America/New_York' });
  ok('the PDF document names the customer, the range and every entry',
    html.includes('Alpha Tower') && html.includes('Clean moved to a new time') && html.includes('Activity record'));
  // The rendered HTML necessarily carries the palette's resolved colours; what must contain
  // no colour literal is the TEMPLATE, so a re-skin changes this document with the app
  // (UI_RULES §121). The document paints only from DOC, which is generated from the theme.
  const tpl = read('../src/lib/activityLogExport.js');
  ok('🔴 the PDF template carries NO colour literal — it paints from the document palette, so a re-skin follows',
    !/#[0-9a-fA-F]{3,8}\b/.test(tpl) && !/rgba?\(/.test(tpl) && /\$\{DOC\./.test(tpl),
    'a colour literal in the PDF template');
  ok('… and the rendered document really used those palette values', /color:\s*#|background:\s*#/.test(html));
  ok('the PDF escapes the formula-shaped text rather than rendering markup', html.includes('=1+1 ticket reopened'));

  // The export route: complete, paged, and scoped exactly like the list.
  seedLog();
  const csvRes = await call(activityRoute, { path: 'export', token: 'tok-owner', query: { format: 'csv', clientId: 'cl_alpha' } });
  ok('GET /api/activity/export?format=csv answers a spreadsheet',
    csvRes.status === 200 && /text\/csv/.test((csvRes.headers || {})['content-type'] || ''), show(csvRes));
  ok('… named for the customer and the dates', /filename="activity-alpha-tower-/.test((csvRes.headers || {})['content-disposition'] || ''),
    (csvRes.headers || {})['content-disposition']);
  const lines = String(csvRes.body).trim().split('\r\n');
  ok('… and it holds every entry for that customer (a header + its rows)',
    lines.length === 1 + SEED.filter((r) => r.client_id === 'cl_alpha').length, `${lines.length} lines`);
  seedLog();
  const crewCsv = await call(activityRoute, { path: 'export', token: 'tok-crew', query: { format: 'csv' } });
  ok('🔴 crew cannot export what they cannot read', crewCsv.status === 403, show(crewCsv));
  seedLog();
  const adminCsv = await call(activityRoute, { path: 'export', token: 'tok-admin', query: { format: 'csv', clientId: 'cl_alpha' } });
  ok('🔴 an admin\'s export leaves the money rows out, like their list',
    adminCsv.status === 200 && !String(adminCsv.body).includes('invoice amount changed'), show(adminCsv));
  // COMPLETENESS. A dispute pack that stops at the row cap is worse than none: the export
  // reads through selectAll, which throws rather than serving a short set.
  seedLog();
  world.tables.activity_log = Array.from({ length: 2500 }, (_, i) => ({
    id: `big_${i}`, organization_id: ORG, occurred_at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 1000).toISOString(),
    actor_user_id: 'u_owner', actor_name: 'owner person', actor_role: 'owner', auto: false,
    action: 'job.moved', entity_type: 'job', entity_id: `j${i}`, client_id: 'cl_alpha', client_name: 'Alpha Tower',
    summary: `move ${i}`, before: null, after: null, is_money: false,
  }));
  world.maxRows = 1000; // PostgREST's db-max-rows, as live
  const bigCsv = await call(activityRoute, { path: 'export', token: 'tok-owner', query: { format: 'csv', clientId: 'cl_alpha' } });
  ok('🔴 the export is COMPLETE past PostgREST\'s 1000-row cap (2,500 rows, paged)',
    bigCsv.status === 200 && String(bigCsv.body).trim().split('\r\n').length === 2501,
    `${String(bigCsv.body).trim().split('\r\n').length} lines`);
}

// ── G. best-effort: a failed log write never fails the user's action ─────────
{
  buildWorld();
  const next = baseState();
  next.users = next.users.map((u) => (u.id === 'u_crew' ? { ...u, pay: { type: 'hourly', hourlyRate: 17 } } : u));
  world.failWhen = (q) => q.table === 'activity_log' && q.op === 'insert';
  const r = await call(orgStateRoute, { method: 'POST', token: 'tok-owner', body: { state: next, baseVersion: 7, build: 1, tab: 't1' } });
  ok('🔴 a log write that FAILS still lets the save succeed (a lost audit row can\'t undo a commit)',
    r.status === 200 && r.body?.ok === true, show(r));
  ok('… and the state really committed', world.tables.org_state[0].version === 8);
  world.failWhen = null;

  buildWorld();
  world.failWhen = (q) => q.table === 'activity_log_baseline';
  const r2 = await call(orgStateRoute, { method: 'POST', token: 'tok-owner', body: { state: next, baseVersion: 7, build: 1, tab: 't1' } });
  ok('a baseline read/write failure still logs and still saves', r2.status === 200 && (world.tables.activity_log || []).length === 1, show(r2));
  world.failWhen = null;
}

// ── H. the client hub's service-event subset (LOG-1 / Wave 2) ───────────────
{
  const events = pure.selectServiceEvents({
    timeEntries: [
      { id: 't1', status: 'active', clock_in_at: '2026-09-28T13:00:00.000Z', clock_out_at: '2026-09-28T16:00:00.000Z', client_id: 'cl_alpha', site_id: 's1', user_name: 'Andre B' },
      { id: 't2', status: 'voided', clock_in_at: '2026-09-28T13:00:00.000Z', client_id: 'cl_alpha' },
      { id: 't3', status: 'no_show', clock_in_at: '2026-09-28T13:00:00.000Z', client_id: 'cl_alpha' },
    ],
    checklists: [{ id: 'c1', performed_at: '2026-09-28T16:05:00.000Z', client_id: 'cl_alpha', completed_count: 9, total_count: 10 }],
    inspections: [
      { id: 'i1', status: 'submitted', performed_at: '2026-09-27T15:00:00.000Z', client_id: 'cl_alpha', result: 'pass', overall_score: 94 },
      { id: 'i2', status: 'draft', performed_at: '2026-09-27T15:00:00.000Z', client_id: 'cl_alpha' },
    ],
    activity: [
      { action: 'ticket.status_changed', occurredAt: '2026-09-28T17:00:00.000Z', clientId: 'cl_alpha', after: { status: 'resolved' } },
      { action: 'pay.rate_changed', occurredAt: '2026-09-28T18:00:00.000Z', clientId: 'cl_alpha', after: { pay: { hourlyRate: 16 } } },
      { action: 'code.revealed', occurredAt: '2026-09-28T19:00:00.000Z', clientId: 'cl_alpha' },
      { action: 'user.role_changed', occurredAt: '2026-09-28T20:00:00.000Z', clientId: 'cl_alpha' },
      { action: 'alert.sent', occurredAt: '2026-09-28T21:00:00.000Z', clientId: 'cl_alpha' },
    ],
  });
  const kinds = events.map((e) => e.kind);
  ok('the service view carries arrivals and departures', kinds.includes('arrival') && kinds.includes('departure'));
  ok('… checklists done and inspection results', kinds.includes('checklist') && kinds.includes('inspection'));
  ok('… and ticket progress', kinds.includes('ticket'));
  ok('🔴 NOTHING internal leaks: no pay, no access levels, no door codes, no automatic alerts',
    events.length === 5 && !JSON.stringify(events).match(/hourlyRate|role|code|alert/i),
    JSON.stringify(events));
  ok('a voided punch and a no-show never read as an arrival', !events.some((e) => e.detail === undefined && e.kind === 'arrival' && e.at === '2026-09-28T13:00:00.000Z' && !e.detail));
  ok('a DRAFT inspection is not a result the customer sees', events.filter((e) => e.kind === 'inspection').length === 1);
  ok('the events are newest first', events.every((e, i) => i === 0 || Date.parse(events[i - 1].at) >= Date.parse(e.at)));
  ok('the customer-facing action list is a tiny allowlist, not "everything but…"',
    pure.SERVICE_EVENT_ACTIONS.length === 1 && pure.SERVICE_EVENT_ACTIONS[0] === 'ticket.status_changed');
}

// ── I. the write points are wired ───────────────────────────────────────────
// A writer nobody calls logs nothing. Each named action in LOG-2 must reach the one writer
// from the route that performs it; these are source checks because the handler-level proof
// for the org_state path is above and the rest are one-line calls in routes with their own
// suites (test-manager-time-approval, test-ops-alerts-cron, …).
{
  const wired = [
    ['the org_state save path', '../api/state/org-state.js', /commitOrgStateActivity/],
    ['the jobs delta (schedule changes)', '../api/state/jobs-delta.js', /jobActivityEvents[\s\S]*logActivities/],
    ['the time route (correct / add / delete / restore / approve / OT)', '../api/time/[...path].js', /time\.corrected[\s\S]*time\.added[\s\S]*time\.deleted[\s\S]*time\.restored/],
    ['the time route approvals', '../api/time/[...path].js', /time\.approved[\s\S]*time\.overtime_approved/],
    ['the QC route (inspection submitted)', '../api/qc/[...path].js', /'inspection\.submitted'/],
    ['the QC route (inspection edited)', '../api/qc/[...path].js', /'inspection\.edited'/],
    ['the QC route (ticket status)', '../api/qc/[...path].js', /'ticket\.status_changed'/],
    ['the QC route (ticket replies)', '../api/qc/[...path].js', /'ticket\.replied'/],
    ['the door / alarm code reveal (CS-081)', '../api/site-security/[...path].js', /code\.revealed/],
    ['the ops-alerts cron (LOG-7 automatic actions)', '../api/cron/ops-alerts.js', /alert\.escalated[\s\S]*alert\.sent|alert\.sent[\s\S]*alert\.escalated/],
    ['the daily reap cron (retention)', '../api/cron/reap.js', /purgeExpiredActivity/],
  ];
  for (const [what, file, re] of wired) {
    ok(`${what} writes to the activity log`, re.test(read(file)), `no match in ${file}`);
  }
  ok('🔴 the door-code reveal no longer logs ONLY to the console (CS-081)',
    /logActivityAs\([\s\S]{0,400}code\.revealed/.test(read('../api/site-security/[...path].js'))
    && !/console\.log\(`\[site-security\] \$\{g\.user\.email\} revealed/.test(read('../api/site-security/[...path].js')));
  // The log is a server record: no browser writer, and no reducer slice to forge.
  ok('🔴 nothing under src/ writes the log (the browser can only read it)',
    !/logActivit(y|ies)\s*\(/.test(read('../src/lib/activityApi.js')));
  const rewrite = JSON.parse(read('./../vercel.json')).rewrites.some((r) => r.source === '/api/activity/:rest*');
  ok('the new api domain has its vercel.json rewrite (or pretty URLs 404 in production)', rewrite);
  ok('the endpoint inventory lists the route with a permission stance',
    /`\/activity\/\[\.\.\.path\]`\s*\|\s*requirePermission/.test(read('./../api/ENDPOINTS.md')));
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nactivity log: ${pass}/${pass} passed`);
}
