// WO-19 — a FAILED inspection opens a ticket, assigned to the building's account manager and
// attached to the building's cleaners.
//
// Matt, Review WO-19 (a), 2026-10-09: "A failed inspection should create a ticket and
// automatically assign it to the account manager and cleaners of that site." His email adds
// the deadline ("48 hours for a failed-inspection fix"), which is the deadline table's job
// (lib/workOrders), not this suite's.
//
// Asserted against the REAL `api/qc/[...path].js` handler over the loopback Supabase fake, and
// against the demo stub (lib/qcApi) for the same inspection:
//   A. the type — `failed_inspection` is a work-order type with its own label and badge, the
//      server keeps it, and NOBODY can raise one by hand (the office's create, the hub's form);
//   B. ONE ticket per failed inspection — a replayed or edited submit never makes a second,
//      a pass and a needs-follow-up make none;
//   C. the people — assigned to the account manager (the customer's supervisor, while still
//      one), the cleaners of the inspected visit attached (else the building's cleaners that
//      week), and a cleaner on it can see it in the queue they already read;
//   D. one ping per person — the cleaners get HUB-7's redo notice (now pointing at the ticket),
//      the office its failed-inspection bell (pointing at the ticket), and no separate
//      new-ticket ping on top;
//   E. the stub opens the same ticket.
//
// REGRESSION (THE LAW II.3): on the pre-fix tree there is no `failed_inspection` type, a failed
// submit writes no ticket, and §A-§E go red.
//
// CS-699 (2026-10-13): the inspection is dated when it is SUBMITTED, so the ticket's title and the
// building's week of cleans follow the submission, never the moment the draft was started. The
// suite runs on a fixed clock — Submit at SUBMITTED, the draft started three days before — and
// B8, B8b and C4 fail on the tree before that fix (`186fffb0`), which dated it from the start.
//
//   node app/scripts/test-failed-inspection-ticket.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

// The clock: every "now" in this run is SUBMITTED (Oct 2, 7 PM in New York).
const SUBMITTED = '2026-10-02T23:00:00.000Z';
{
  const RealDate = Date;
  const at = { now: RealDate.parse(SUBMITTED) };
  globalThis.__clock = at;
  globalThis.Date = class FixedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(at.now); else super(...a); }
    static now() { return at.now; }
  };
}

const ORG = '00000000-0000-0000-0000-000000000007';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
installResolveShim(); // the stub (lib/qcApi) is written for Vite's extensionless imports

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const wo = await import('../src/lib/workOrders.js');
// Off the namespace objects, with fallbacks: on the pre-fix tree none of these exist, and the
// run must report WHAT it wanted rather than die on a TypeError.
const FAILED = wo.FAILED_INSPECTION_TYPE || 'failed_inspection';
const RAISABLE = Array.isArray(wo.RAISABLE_WO_TYPES) ? wo.RAISABLE_WO_TYPES : null;
const fit = await tryImport('../src/lib/failedInspectionTicket.js');
const view = await tryImport('../src/lib/clientHubView.js');
const { REDO_EVENT_KEY = 'inspectionRedo' } = await import('../src/lib/notifications.js');
const store = await import('../api/_lib/qc/store.js');
const ticketDeepLink = store.ticketDeepLink || ((id) => `/inspections?tab=workorders&wo=${id}`);
const { crewPaths } = await import('../src/lib/crewPaths.js');
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the fixture ──────────────────────────────────────────────────────────────
const SCHEMA = {
  areas: [
    { id: 'a_rest', label: 'Restrooms', items: [{ id: 'r_floor', label: 'Floor' }, { id: 'r_sink', label: 'Sink' }] },
    { id: 'a_break', label: 'Break room', items: [{ id: 'b_counter', label: 'Counter' }] },
    { id: 'a_lobby', label: 'Lobby', items: [{ id: 'l_glass', label: 'Glass' }, { id: 'l_floor', label: 'Floor' }, { id: 'l_mats', label: 'Mats' }] },
  ],
};
const SNAP = { name: 'Nightly Janitorial QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema: SCHEMA };
const answers = (ratings) => SCHEMA.areas.flatMap((a) => a.items.map((i) => ({
  item_key: i.id, label: `${a.label}. ${i.label}`, rating: ratings[i.id] ?? 'pass', comment: null,
})));
// 4 of 6 = 67%: a FAIL at the 80% pass mark, naming two areas.
const FAILING = answers({ r_sink: 'fail', b_counter: 'fail' });
// 5 of 6 = 83%: a PASS with one failing item (HUB-7's redo case, not a failed inspection).
const PASSING_WITH_ONE = answers({ r_sink: 'fail' });
const UNRATED = SCHEMA.areas.flatMap((a) => a.items.map((i) => ({ item_key: i.id, label: `${a.label}. ${i.label}`, rating: null, comment: null })));

// The draft was STARTED three days before it was submitted (Matt leaves an inspection open, D7).
const STARTED = '2026-09-29T22:00:00.000Z';     // Sep 29, 6 PM in New York
const user = (id, role, status = 'active') => ({ id, role, status, name: `${id} name`, email: `${id}@example.test` });
const USERS = [
  user('u_m', 'manager'), user('u_sup', 'manager'),
  user('u_c1', 'crew'), user('u_c2', 'crew'), user('u_c3', 'crew'), user('u_c4', 'crew'), user('u_c5', 'crew'),
  user('u_gone', 'crew', 'inactive'),
];
// The building's cleans. The inspected visit (j_vis) had u_c1, u_c2 and a cleaner who has
// since left; u_c3 cleaned it two days earlier; u_c5 three weeks ago (outside the week);
// u_c4 cleans the OTHER building.
const JOB = (id, siteId, startAt, crewIds, status = 'scheduled') => ({
  id, organization_id: ORG, site_id: siteId, status, start_at: startAt,
  data: { id, siteId, clientId: 'c1', startAt, crewIds, status },
});
const JOBS = [
  JOB('j_vis', 's1', '2026-10-02T20:00:00.000Z', ['u_c1', 'u_c2', 'u_gone']),
  JOB('j_old', 's1', '2026-09-30T20:00:00.000Z', ['u_c3']),
  JOB('j_far', 's1', '2026-09-12T20:00:00.000Z', ['u_c5']),
  JOB('j_s2', 's2', '2026-10-02T20:00:00.000Z', ['u_c4']),
  JOB('j_cxl', 's1', '2026-10-01T20:00:00.000Z', ['u_c5'], 'cancelled'),
];
const logins = {
  'tok-mgr': { id: 'auth-m', email: 'm@example.test', app_metadata: { role: 'manager', org_user_id: 'u_m', org_id: ORG } },
  'tok-c1': { id: 'auth-c1', email: 'c1@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
  'tok-c4': { id: 'auth-c4', email: 'c4@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c4', org_id: ORG } },
};

function seed({ jobId = 'j_vis', supervisorId = 'u_sup', openPunches = [], users = USERS } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 58,
        state: {
          version: 58,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users,
          clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }, { id: 's2', clientId: 'c1', name: 'Annexe' }],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          notifications: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      jobs: structuredClone(JOBS),
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: 'Nightly Janitorial QC', kind: 'inspection', is_published: true, published_version_id: 'v_i' }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SCHEMA }],
      inspection_records: [{
        id: 'ir_1', organization_id: ORG, public_token: 'tok_1', template_id: 'it_i', template_version_id: 'v_i',
        template_snapshot: SNAP, client_id: 'c1', site_id: 's1', job_id: jobId,
        inspector_user_id: 'u_m', client_name: 'Coral Bay HOA', site_name: 'Clubhouse', inspector_name: 'u_m name',
        status: 'draft', performed_at: STARTED, created_at: STARTED,
      }],
      inspection_items: [],
      problem_reports: [],
      work_order_messages: [],
      account_media: [],
      activity_log: [],
      client_users: [],
      time_entries: openPunches.map((uid, i) => ({
        id: `e_${uid}`, organization_id: ORG, job_id: `jp${i}`, client_id: 'c1', site_id: 's1', user_id: uid,
        clock_in_at: '2026-10-02T20:00:00.000Z', clock_out_at: null, status: 'in_progress', row_version: 0,
      })),
    },
    logins,
  });
}

async function call(method, subpath, { token = 'tok-mgr', body = null, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { authorization: `Bearer ${token}` };
  req.query = { subpath, ...query };
  req.body = body || {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(qc(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const submit = (items) => call('POST', 'inspections/submit', { body: { id: 'ir_1', items } });
const tickets = () => world.tables.problem_reports || [];
const notes = (eventKey) => (world.tables.org_state[0].state.notifications || []).filter((n) => !eventKey || n.eventKey === eventKey);
const sorted = (a) => [...(a || [])].sort().join(',');

// ── A. the type ──────────────────────────────────────────────────────────────
ok('A1 failed_inspection is a work-order type', Array.isArray(wo.WO_TYPES) && wo.WO_TYPES.includes(FAILED), JSON.stringify(wo.WO_TYPES));
eq('A2 …named "Failed inspection"', wo.WO_TYPE_META?.[FAILED]?.label, 'Failed inspection');
{
  const others = (wo.WO_TYPES || []).filter((t) => t !== FAILED).map((t) => wo.WO_TYPE_META[t]?.badge);
  const mine = wo.WO_TYPE_META?.[FAILED]?.badge;
  ok('A3 …with a kit badge colour of its own among the types', ['green', 'amber', 'red', 'blue', 'slate', 'purple'].includes(mine) && !others.includes(mine), `${mine} vs ${others}`);
}
ok('A4 the types a person can raise exclude it (the office form, the hub form)',
  Array.isArray(RAISABLE) && !RAISABLE.includes(FAILED) && ['complaint', 'request', 'issue'].every((t) => RAISABLE.includes(t)), JSON.stringify(RAISABLE));
ok('A5 the customer hub refuses it as a ticket type',
  typeof view.hubTicketInput === 'function'
  && view.hubTicketInput({ type: FAILED, category: 'other', description: 'x' }).code === 'ticket-type'
  && !!view.hubTicketInput({ type: 'complaint', category: 'other', description: 'x' }).value);
ok('A6 a failed result owes a ticket; a pass and a needs-follow-up do not',
  typeof fit.owesFailedInspectionTicket === 'function'
  && fit.owesFailedInspectionTicket({ id: 'x', status: 'submitted', result: 'fail' }) === true
  && fit.owesFailedInspectionTicket({ id: 'x', status: 'submitted', result: 'pass' }) === false
  && fit.owesFailedInspectionTicket({ id: 'x', status: 'submitted', result: 'needs_follow_up' }) === false);

// ── B + C. a failed submit opens ONE ticket, on the building, for its people ──
{
  seed();
  const r = await submit(FAILING);
  eq('B1 the inspection is submitted', r.status, 200);
  eq('B2 …as a fail', r.body?.inspection?.result, 'fail');
  eq('B3 a failed inspection opens exactly one ticket', tickets().length, 1);
  const t = tickets()[0] || {};
  eq('B4 …of type failed_inspection (the server keeps the type)', t.type, FAILED);
  eq('B5 …internal, so it is never a customer-hub ticket', t.origin, 'internal');
  eq('B6 …linked to the inspection', t.inspection_id, 'ir_1');
  eq('B7 …on the inspected building', `${t.client_id}/${t.site_id}/${t.job_id}`, 'c1/s1/j_vis');
  ok('🔴 B8 …titled from the inspection: the date it was SUBMITTED (not started, Sep 29) and the failed areas', t.title === 'Failed inspection Oct 2: Restrooms and Break room', t.title);
  const rec1 = () => (world.tables.inspection_records || []).find((x) => x.id === 'ir_1') || {};
  ok('🔴 B8b the inspection is dated when it was submitted, and its start is kept (created_at)', rec1().performed_at === SUBMITTED && rec1().created_at === STARTED,
    `${rec1().performed_at} / ${rec1().created_at}`);
  ok('B9 …the details name the score and each failed item under its area',
    /67%/.test(t.description || '') && /Restrooms: Sink/.test(t.description || '') && /Break room: Counter/.test(t.description || ''), t.description);
  eq('B10 …open', t.status, 'open');
  ok('B11 …with a deadline', !!t.due_at && Date.parse(t.due_at) > Date.parse(t.created_at), `${t.created_at} → ${t.due_at}`);
  // The deadline is lib/workOrders' one rule for the type (WO-20: 48 hours for a failed
  // inspection), never a second one here; asserted against the rule, not a restated number.
  eq('B11b …and it is the one deadline rule\'s for the type', t.due_at, wo.computeDueAt(t.created_at, { type: t.type, priority: t.priority }));
  eq('B12 …raised by the inspector', t.reported_by_user_id, 'u_m');
  eq('C1 assigned to the account manager (the customer\'s supervisor)', t.assignee_user_id, 'u_sup');
  eq('C2 the inspected visit\'s cleaners are on it (the active ones)', sorted(t.crew_user_ids), 'u_c1,u_c2');

  // replay-safe: the same submit again, then an edit that changes the score (two days later)
  await submit(FAILING);
  eq('B13 a replayed submit never opens a second ticket', tickets().length, 1);
  globalThis.__clock.now = Date.parse('2026-10-04T15:00:00.000Z');
  await submit(answers({ r_sink: 'fail', b_counter: 'fail', l_glass: 'fail' }));
  eq('B14 …nor does an edit that fails it again', tickets().length, 1);
  eq('B14b an edit days later keeps the date it was submitted (CS-699)', rec1().performed_at, SUBMITTED);
  await submit(answers({}));
  globalThis.__clock.now = Date.parse(SUBMITTED);
  eq('B15 an edit to a pass leaves the ticket where it is (the work may be under way)', tickets().length, 1);

  // D. the people are told once, and pointed at the ticket
  const link = ticketDeepLink(t.id);
  const redo = notes(REDO_EVENT_KEY);
  eq('D1 each cleaner on the ticket gets HUB-7\'s redo notice', sorted(redo.filter((n) => n.title?.startsWith('Please redo')).map((n) => n.userId).filter((v, i, a) => a.indexOf(v) === i)), 'u_c1,u_c2');
  // The Cleaner Hub (2026-10-13, brief C §1): a CLEANER's row opens the request on their phone
  // app (crewPaths.request), never the office's Quality hub; the office's rows below still open
  // the drawer.
  ok('🔴 D2 …which opens the ticket on the cleaner\'s phone (their Client Requests)', redo.length > 0 && redo.every((n) => n.url === crewPaths.request(t.id)), JSON.stringify(redo.map((n) => n.url)));
  const failedBell = notes('inspectionFailed');
  ok('D3 the office\'s failed-inspection bell opens the ticket too', failedBell.length > 0 && failedBell.every((n) => n.url === link), JSON.stringify(failedBell.map((n) => n.url)));
  ok('D4 …and no separate new-ticket ping is sent for it', notes().every((n) => !/^ticket/i.test(n.eventKey)), JSON.stringify(notes().map((n) => n.eventKey)));

  // C. a cleaner on it sees it where cleaners see tickets; one from another building does not
  const mine = await call('GET', 'problems/list', { token: 'tok-c1' });
  ok('C3 a cleaner on the ticket sees it in the Work Orders queue they already read',
    mine.status === 200 && (mine.body?.problems || []).some((p) => p.id === t.id), `${mine.status} ${JSON.stringify(mine.body)?.slice(0, 160)}`);
}
{
  // One ping per person: a cleaner on the clock there AND on the ticket hears it once.
  seed({ openPunches: ['u_c1', 'u_c3'] });
  await submit(FAILING);
  const redo = notes(REDO_EVENT_KEY);
  eq('D5 a cleaner on site and on the ticket gets ONE redo notice', redo.filter((n) => n.userId === 'u_c1').length, 1);
  ok('D6 …and a cleaner on site who is not on the visit is still sent back (HUB-7)', redo.some((n) => n.userId === 'u_c3'));
}

// ── B. no ticket for a pass or a needs-follow-up ─────────────────────────────
{
  seed();
  const r = await submit(PASSING_WITH_ONE);
  eq('B16 a pass with one failed item is a pass', r.body?.inspection?.result, 'pass');
  eq('B17 …and opens no ticket (HUB-7 sends the crew back; nothing is filed)', tickets().length, 0);
  ok('B18 …its redo notice still opens Quality, not a ticket', notes(REDO_EVENT_KEY).every((n) => n.url === '/inspections'));
}
{
  seed();
  const r = await submit(UNRATED);
  eq('B19 nothing rated is needs-follow-up', r.body?.inspection?.result, 'needs_follow_up');
  eq('B20 …and opens no ticket', tickets().length, 0);
}

// ── C. the building's cleaners when the inspection names no visit ────────────
{
  seed({ jobId: null });
  await submit(FAILING);
  const t = tickets()[0] || {};
  eq('C4 with no visit, the building\'s cleaners that week are on it (not the other building, not three weeks ago, not a cancelled clean)',
    sorted(t.crew_user_ids), 'u_c1,u_c2,u_c3');
}
{
  seed({ supervisorId: null });
  await submit(FAILING);
  const t = tickets()[0] || {};
  eq('C5 a customer with no manager: the ticket is opened unassigned', `${tickets().length}/${t.assignee_user_id}`, '1/null');
  ok('C6 …and the office bench hears of the failure', notes('inspectionFailed').length > 0);
}
{
  seed({ users: USERS.map((u) => (u.id === 'u_sup' ? { ...u, role: 'crew' } : u)) });
  await submit(FAILING);
  eq('C7 a supervisor no longer a manager is not assigned (the app\'s supervisor rule)', `${tickets().length}/${tickets()[0]?.assignee_user_id ?? null}`, '1/null');
}

{
  // A schedule read that fails costs the ticket its cleaners, never the ticket.
  seed();
  world.failWhen = (q) => q.table === 'jobs';
  await submit(FAILING);
  world.failWhen = null;
  const t = tickets()[0] || {};
  eq('C8 a failed read of the schedule still opens the ticket for the account manager', `${tickets().length}/${t.assignee_user_id}`, '1/u_sup');
  eq('…with no cleaners on it rather than a guess', sorted(t.crew_user_ids), '');
}

// ── A. nobody raises one by hand through the office's create ─────────────────
{
  seed();
  const r = await call('POST', 'problems/create', { body: { clientId: 'c1', siteId: 's1', title: 'Hand-made', type: FAILED } });
  eq('A7 the office\'s create answers', r.status, 200);
  eq('A8 …and files it as an ordinary issue, never a failed inspection', r.body?.problem?.type, 'issue');
}

// ── E. the demo stub opens the same ticket ───────────────────────────────────
let serverTicket;
{
  seed();
  await submit(FAILING);
  serverTicket = tickets()[0] || {};
}
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  const { QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY } = await import('../src/data/stubKeys.js');
  const demoState = {
    company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
    users: USERS,
    clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_sup' }],
    sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }, { id: 's2', clientId: 'c1', name: 'Annexe' }],
    jobs: JOBS.map((j) => j.data),
  };
  globalThis.window = { __ppGetState: () => demoState };
  const rec = {
    id: 'ir_s', public_token: 'tok_s', template_id: 'it_i', template_version_id: 'v_i', template_snapshot: SNAP,
    client_id: 'c1', site_id: 's1', job_id: 'j_vis', client_name: 'Coral Bay HOA', site_name: 'Clubhouse',
    inspector_user_id: 'u_m', inspector_name: 'u_m name', overall_score: null, result: null, status: 'draft', performed_at: STARTED, created_at: STARTED, _items: [],
  };
  mem.set(QC_INSPECTIONS_STUB_KEY, JSON.stringify({ inspections: [rec] }));
  const qcApi = await tryImport('../src/lib/qcApi.js');
  ok('E0 under plain node qcApi runs its demo stub', typeof qcApi.isQcStub === 'function' && qcApi.isQcStub());
  const stubTickets = () => (JSON.parse(mem.get(QC_PROBLEMS_STUB_KEY) || '{"problems":[]}').problems || []);
  try { await qcApi.submitInspection({ id: 'ir_s', items: FAILING }); } catch (e) { fails.push(`E stub submit threw: ${e.message}`); }
  eq('E1 the stub opens one ticket for a failed inspection', stubTickets().length, 1);
  const s = stubTickets()[0] || {};
  // Each against the server's ticket for the same inspection, and never two absences agreeing.
  const same = (label, a, b) => ok(label, a != null && a !== '' && a === b, `stub ${JSON.stringify(a)}, server ${JSON.stringify(b)}`);
  same('E2 …of the same type', s.type, serverTicket.type);
  same('E3 …the same origin', s.origin, serverTicket.origin);
  same('E4 …the same assignee', s.assignee_user_id, serverTicket.assignee_user_id);
  same('E5 …the same cleaners', sorted(s.crew_user_ids), sorted(serverTicket.crew_user_ids));
  same('E6 …the same title', s.title, serverTicket.title);
  same('E7 …the same details', s.description, serverTicket.description);
  same('E8 …the same priority', s.priority, serverTicket.priority);
  eq('E9 …linked to its inspection', s.inspection_id, 'ir_s');
  const stubRec = (JSON.parse(mem.get(QC_INSPECTIONS_STUB_KEY) || '{"inspections":[]}').inspections || []).find((x) => x.id === 'ir_s') || {};
  ok('🔴 E9b …and the stub dates the inspection when it was submitted too, its start kept (CS-699)', stubRec.performed_at === SUBMITTED && stubRec.created_at === STARTED,
    `${stubRec.performed_at} / ${stubRec.created_at}`);
  try { await qcApi.submitInspection({ id: 'ir_s', items: FAILING }); } catch { /* counted below */ }
  eq('E10 …and a replay opens no second one', stubTickets().length, 1);
  try { await qcApi.createProblem({ clientId: 'c1', siteId: 's1', title: 'Hand-made', type: FAILED }); } catch { /* counted below */ }
  eq('E11 the stub\'s create files a hand-made one as an issue, as the server does', stubTickets().find((p) => p.title === 'Hand-made')?.type, 'issue');
}

if (fails.length) { console.error('\nfailed-inspection-ticket FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nfailed-inspection-ticket: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
