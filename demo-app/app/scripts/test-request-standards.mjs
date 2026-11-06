// Matt's response standards (his email, 2026-10-09): "each request shows a live countdown against
// our actual response standards (30 min to first reply, 2 hours for a complaint, 24 hours for a
// standard request, 48 hours for a failed-inspection fix)". WO-20 (a): a client request's deadline
// is set by its TYPE; urgency only sorts the list and keeps its after-hours alert role (WO-7).
// WO-21 (a): an issue keeps the urgency clock. The first reply is the org's no-reply window (WO-5).
//
// What this pins, every figure read from where it lives (lib/workOrders TYPE_DEADLINE_HOURS and
// SLA_HOURS, lib/ticketAlerts ticketEscalateMins) — only section A restates Matt's own numbers,
// because they are the spec:
//   A. the deadline table per type, failed_inspection included, and urgency never moving it;
//   B. ONE rule, derived at read: a ticket raised under the old rule (its stored due_at) reads the
//      new deadline everywhere — toWorkOrder, ticketDueAtMs, the alert walker — no migration;
//   C. the escalation (WO-16's ticketSlaEscalate) fires on the TYPE's clock;
//   D. the first-reply clock: counting down until the office first answers, overdue after the
//      window, then the fix clock; the window is the org's setting;
//   E. the server writes the same rule on create and on a type / urgency change, and the open
//      view carries each ticket's first staff reply — a complete read past the 1,000-row cap
//      (the reply read the WO-2 reminders use was capped too: fixed with it);
//   F. the screens say it: the drawer's first-reply line, the page's two clocks, the banner.
//
// Every module is imported at run time, so on the tree before the change each check FAILS.
//
//   node app/scripts/test-request-standards.mjs
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

const ORG = '00000000-0000-0000-0000-000000000620';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const WO = await import('../src/lib/workOrders.js');
const TA = await import('../src/lib/ticketAlerts.js');
let CR = {};
try { CR = await import('../src/lib/clientRequests.js'); } catch { CR = {}; }
const { seedPermissions } = await import('../src/lib/roles.js');
const store = await import('../api/_lib/qc/store.js');
const qc = (await import('../api/qc/[...path].js')).default;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let pass = 0;
const fails = [];
// ok(label, fn): fn returns truthy to pass; a throw is a fail carrying its message.
const ok = (label, fn, detail = () => '') => {
  let good = false;
  let why = '';
  try { good = !!fn(); } catch (e) { why = e.message; }
  if (good) pass += 1;
  else {
    let d = '';
    try { d = why ? '' : detail(); } catch { d = ''; }
    fails.push(`${label}${why ? `\n      threw: ${why}` : ''}${d ? `\n      ${d}` : ''}`);
  }
};
const okAsync = async (label, fn, detail) => {
  let v;
  let why = '';
  try { v = await fn(); } catch (e) { why = e.message; }
  ok(label, () => { if (why) throw new Error(why); return v; }, detail);
};
const need = (mod, name) => { if (typeof mod[name] !== 'function') throw new Error(`no ${name}()`); return mod[name]; };

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-30T14:00:00.000Z'); // a Wednesday, 10:00 in New York
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(NOW - ms);
const TYPES = WO.TYPE_DEADLINE_HOURS || {};

// ═══ A. the deadline table, per type (Matt's numbers are the spec) ═══════════════════════════
const MATT = { complaint: 2, request: 24, failed_inspection: 48 };
ok('A1 the type table is exactly Matt\'s: complaint 2 h, request 24 h, failed inspection 48 h',
  () => JSON.stringify(TYPES) === JSON.stringify(MATT), () => JSON.stringify(TYPES));
for (const type of Object.keys(MATT)) {
  ok(`A2 a ${type}'s deadline is its type's at every urgency (urgency sorts, it does not set it)`, () => WO.WO_PRIORITIES
    .every((priority) => need(WO, 'deadlineHours')({ type, priority }) === TYPES[type]));
  ok(`A3 computeDueAt puts a ${type} ${MATT[type]} h after it came in`, () => WO.WO_PRIORITIES.every((priority) => Date.parse(WO.computeDueAt(ago(0), { type, priority })) === NOW + TYPES[type] * HOUR));
}
ok('A4 an issue keeps the urgency clock (WO-21), every urgency on SLA_HOURS', () => WO.WO_PRIORITIES
  .every((priority) => need(WO, 'deadlineHours')({ type: 'issue', priority }) === WO.SLA_HOURS[priority]));
ok('A5 a retired "high" issue is judged on urgent\'s clock', () => need(WO, 'deadlineHours')({ type: 'issue', priority: WO.RETIRED_PRIORITY }) === WO.SLA_HOURS.urgent);
ok('A6 a failed inspection reads its own deadline even before the vocabulary lists the type (Builder B adds it)', () => {
  const w = WO.toWorkOrder({ id: 'fi', type: 'failed_inspection', priority: 'low', status: 'open', created_at: ago(0) });
  return Date.parse(w.due_at) === NOW + TYPES.failed_inspection * HOUR;
}, () => JSON.stringify(WO.toWorkOrder({ id: 'fi', type: 'failed_inspection', priority: 'low', status: 'open', created_at: ago(0) })));
ok('A7 the client request types are exactly the table\'s (an issue is not one)', () => typeof WO.isClientRequestType === 'function'
  && Object.keys(MATT).every((t) => WO.isClientRequestType(t)) && !WO.isClientRequestType('issue') && !WO.isClientRequestType(undefined));

// ═══ B. one rule, derived at read: the old rule's stored due_at no longer decides ═══════════════
{
  // A request raised as URGENT under the old rule was stamped due 2 h after it came in.
  const old = { id: 'old', type: 'request', priority: 'urgent', status: 'in_progress', created_at: ago(3 * HOUR), due_at: ago(HOUR) };
  ok('B1 toWorkOrder reads a ticket\'s deadline from the rule, not its stored due_at', () => Date.parse(WO.toWorkOrder(old).due_at) === Date.parse(old.created_at) + TYPES.request * HOUR,
    () => WO.toWorkOrder(old).due_at);
  ok('B2 …so it is not breached (21 h left on a 24 h request)', () => WO.toWorkOrder(old).sla?.state !== 'breached' && WO.deriveSla({ dueAt: WO.toWorkOrder(old).due_at, status: 'in_progress', now: NOW }).state !== 'breached');
  ok('B3 ticketDueAtMs (the alert walker\'s deadline) is the same derived instant', () => TA.ticketDueAtMs(old) === Date.parse(WO.toWorkOrder(old).due_at));
  const complaint = { id: 'c', type: 'complaint', priority: 'low', status: 'in_progress', created_at: ago(3 * HOUR), due_at: iso(NOW + 69 * HOUR) };
  ok('B4 a LOW complaint stamped with the old 3-day clock is overdue on its 2 h type clock', () => Date.parse(WO.toWorkOrder(complaint).due_at) < NOW && TA.ticketDueAtMs(complaint) < NOW);
  // The one rule: the server, the stub and the backfill all stamp through computeDueAt with the type.
  const storeSrc = read('../api/_lib/qc/store.js');
  const stubSrc = read('../src/lib/qcApi.js');
  ok('B5 the server stamps due_at by the one rule on create (type + urgency)', () => /due_at: computeDueAt\(createdAt, \{ type: storedType, priority: prio \}\)/.test(storeSrc));
  ok('B6 …and on a type or urgency change', () => /if \(patch\.priority \|\| patch\.type\) \{\s*patch\.due_at = computeDueAt\(cur\.created_at, \{ type: patch\.type \|\| cur\.type, priority: patch\.priority \|\| cur\.priority \}\)/.test(storeSrc));
  ok('B7 the demo stub stamps by the same rule (create and change)', () => /due_at: computeDueAt\(created_at, \{ type:/.test(stubSrc) && /if \(priority \|\| type\) r\.due_at = computeDueAt\(r\.created_at, \{ type: r\.type, priority: r\.priority \}\)/.test(stubSrc));
  ok('B8 no module restates a deadline table (SLA_HOURS / TYPE_DEADLINE_HOURS indexed only in lib/workOrders)', () => {
    const files = ['../src/lib/ticketAlerts.js', '../src/lib/clientRequests.js', '../src/lib/qcApi.js', '../api/_lib/qc/store.js', '../src/pages/ClientRequests.jsx', '../src/components/WorkOrderDrawer.jsx'];
    return files.every((f) => !/\b(SLA_HOURS|TYPE_DEADLINE_HOURS)\[/.test(read(f)));
  });
}

// ═══ C. the escalation moves with the type (WO-16's ticketSlaEscalate) ═══════════════════════
{
  const walk = (t, settings = {}) => TA.getDueTicketAlerts({
    tickets: [{ id: 't1', client_id: 'cl_real', title: 'x', status: 'in_progress', ...t }],
    repliedAt: { t1: ago(10 * MIN) }, now: NOW, settings, timeZone: 'America/New_York',
  });
  const esc = (due) => due.some((d) => d.kind === 'ticketSlaEscalate');
  ok('C1 a LOW complaint escalates once its TYPE\'s 2 h pass (low\'s 3 days have not)', () => esc(walk({ type: 'complaint', priority: 'low', created_at: ago(TYPES.complaint * HOUR + MIN) })));
  ok('C2 …and not a minute before', () => !esc(walk({ type: 'complaint', priority: 'low', created_at: ago(TYPES.complaint * HOUR - MIN) })));
  ok('C3 an URGENT request does not escalate at urgent\'s 2 h — its type gives it 24', () => !esc(walk({ type: 'request', priority: 'urgent', created_at: ago(WO.SLA_HOURS.urgent * HOUR + MIN) })));
  ok('C4 …and does once its 24 h pass', () => esc(walk({ type: 'request', priority: 'urgent', created_at: ago(TYPES.request * HOUR + MIN) })));
  ok('C5 a failed inspection escalates at 48 h, not before', () => !esc(walk({ type: 'failed_inspection', priority: 'urgent', created_at: ago(TYPES.failed_inspection * HOUR - MIN) }))
    && esc(walk({ type: 'failed_inspection', priority: 'urgent', created_at: ago(TYPES.failed_inspection * HOUR + MIN) })));
  ok('C6 an urgent ISSUE still escalates on urgent\'s clock (WO-21)', () => esc(walk({ type: 'issue', priority: 'urgent', created_at: ago(WO.SLA_HOURS.urgent * HOUR + MIN) })));
  ok('C7 a stored due_at from the old rule cannot hold the escalation back (or fire it early)', () => esc(walk({ type: 'complaint', priority: 'low', created_at: ago(3 * HOUR), due_at: iso(NOW + 69 * HOUR) }))
    && !esc(walk({ type: 'request', priority: 'urgent', created_at: ago(3 * HOUR), due_at: ago(HOUR) })));
}

// ═══ D. the first-reply clock (Matt's 30 minutes = the org's WO-5 window) ═══════════════════════
{
  const clock = (wo, settings = {}) => need(CR, 'requestClock')(wo, { now: NOW, settings });
  const W = TA.ticketEscalateMins({});
  const fresh = { id: 'f', type: 'complaint', priority: 'medium', status: 'open', created_at: ago(10 * MIN), first_reply_at: null };
  ok(`D1 an unanswered complaint 10 min old: the FIRST-REPLY clock, ${W - 10} min left`, () => { const c = clock(fresh); return c.phase === 'reply' && c.state !== 'breached' && c.minutes === W - 10; }, () => JSON.stringify(clock(fresh)));
  const late = { ...fresh, created_at: ago((W + 12) * MIN) };
  ok('D2 past the window with no reply: the first reply is overdue, by the minute', () => { const c = clock(late); return c.phase === 'reply' && c.state === 'breached' && c.minutes === 12; }, () => JSON.stringify(clock(late)));
  const answered = { ...late, first_reply_at: ago(5 * MIN), status: 'in_progress' };
  ok('D3 once the office has replied: the FIX clock, the type\'s deadline', () => { const c = clock(answered); return c.phase === 'fix' && c.minutes === TYPES.complaint * 60 - (W + 12); }, () => JSON.stringify(clock(answered)));
  const moved = { ...late, status: 'in_progress', first_reply_at: null };
  ok('D4 a ticket moved off "open" by hand counts as answered (the WO-2 reminders\' own rule)', () => clock(moved).phase === 'fix');
  ok('D5 the window is the org\'s setting, not a literal: 45 minutes', () => { const c = clock(fresh, { ticketEscalateMins: 45 }); return c.phase === 'reply' && c.minutes === 35; }, () => JSON.stringify(clock(fresh, { ticketEscalateMins: 45 })));
  ok('D6 a 0-minute window: the first reply is due at once', () => clock(fresh, { ticketEscalateMins: 0 }).state === 'breached');
  ok('D7 an issue has no client to answer: straight to its fix clock', () => clock({ ...fresh, type: 'issue' }).phase === 'fix');
  ok('D8 waiting on the client pauses the clock', () => clock({ ...answered, status: 'awaiting_client' }).state === 'paused');
  ok('D9 a resolved ticket has no clock', () => clock({ ...answered, status: 'resolved' }).state === 'none');
  ok('D10 a failed inspection is a client request: it gets the first-reply clock too', () => clock({ ...fresh, type: 'failed_inspection' }).phase === 'reply');
  const counts = need(CR, 'clientRequestCounts')(need(CR, 'clientRequestRows')([fresh, late, answered], { now: NOW }));
  ok('D11 the overdue count includes a late first reply', () => counts.overdue === 1 && counts.open === 3, () => JSON.stringify(counts));
}

// ═══ E. the server: the same rule written, and every first reply read ══════════════════════════
const tickets = [];
const replies = [];
// 100 open tickets (one REPLY_CHUNK). The first 95 have eleven staff replies each, the last five
// one later reply: 1,050 reply rows in one chunk, past a 1,000-row response.
for (let i = 0; i < 100; i += 1) {
  const id = `t_${String(i).padStart(3, '0')}`;
  tickets.push({ id, organization_id: ORG, client_id: 'c1', site_id: 's1', title: id, type: i % 2 ? 'request' : 'complaint', priority: 'medium', status: 'in_progress', origin: 'portal', created_at: ago((200 - i) * MIN), resolved_at: null, due_at: null });
  const n = i < 95 ? 11 : 1;
  for (let k = 0; k < n; k += 1) {
    replies.push({ id: `m_${id}_${k}`, organization_id: ORG, problem_id: id, author_role: 'office', author_user_id: 'u_owner', author_name: 'Owner', body: 'on it', internal: false,
      created_at: i < 95 ? ago((150 - k) * MIN) : ago((20 - (i - 95)) * MIN) });
  }
}
// A ticket nobody has answered (a client line and an internal note only).
tickets.push({ id: 't_unanswered', organization_id: ORG, client_id: 'c1', site_id: 's1', title: 'Unanswered', type: 'complaint', priority: 'low', status: 'open', origin: 'portal', created_at: ago(40 * MIN), resolved_at: null, due_at: null });
replies.push({ id: 'm_u_client', organization_id: ORG, problem_id: 't_unanswered', author_role: 'client', author_user_id: null, author_name: 'Pat', body: 'hello', internal: false, created_at: ago(39 * MIN) });
replies.push({ id: 'm_u_note', organization_id: ORG, problem_id: 't_unanswered', author_role: 'office', author_user_id: 'u_owner', author_name: 'Owner', body: 'note', internal: true, created_at: ago(30 * MIN) });

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          version: 3, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [{ id: 'u_owner', role: 'owner', status: 'active', name: 'Owner', email: 'o@example.test' }],
          clients: [{ id: 'c1', name: 'Acme Towers', supervisorId: 'u_owner' }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Acme Towers' }],
          permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
      crew_assignments: [],
      jobs: [],
      problem_reports: tickets.map((t) => ({ ...t })),
      work_order_messages: replies.map((m) => ({ ...m })),
      account_media: [],
      activity_log: [],
    },
    logins: { 'tok-owner': { id: 'auth-o', email: 'o@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } } },
  });
  world.maxRows = 1000; // 🔴 Supabase's db-max-rows
}
async function call(path, { method = 'GET', body = {}, query = {} } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = { authorization: 'Bearer tok-owner' };
  req.query = { subpath: path, ...query };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path}: no response`)), 20000);
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

seed();
{
  const ids = tickets.filter((t) => t.id !== 't_unanswered').map((t) => t.id);
  const first = await store.firstStaffReplyByProblem(ids);
  ok('🔴 E1 every ticket\'s first staff reply is found past the 1,000-row cap (the WO-2 reminders\' read)', () => ids.every((id) => first.has(id)), () => `${first.size} of ${ids.length}`);
  ok('E2 …and it is the EARLIEST reply', () => first.get('t_000') === ago(150 * MIN) && first.get('t_099') === ago(16 * MIN), () => `${first.get('t_000')} · ${first.get('t_099')}`);
  const none = await store.firstStaffReplyByProblem(['t_unanswered']);
  ok('E3 a client line or an internal note is not a reply', () => !none.has('t_unanswered'));
}
{
  const open = await call('problems/list');
  const rows = (open.body && open.body.problems) || [];
  const by = new Map(rows.map((r) => [r.id, r]));
  ok('🔴 E4 the open view carries every ticket\'s first staff reply (101 tickets, 1,050+ replies)', () => open.status === 200 && rows.length === tickets.length
    && tickets.filter((t) => t.id !== 't_unanswered').every((t) => by.get(t.id)?.first_reply_at), () => `${open.status} · ${rows.length} rows · ${rows.filter((r) => r.first_reply_at).length} with a reply`);
  ok('E5 …and null for the one nobody has answered', () => by.get('t_unanswered') && by.get('t_unanswered').first_reply_at === null);
}
{
  seed();
  const made = await call('problems/create', { method: 'POST', body: { title: 'Lobby glass', clientId: 'c1', siteId: 's1', type: 'complaint', priority: 'low' } });
  const p = made.body?.problem || {};
  ok('E6 a LOW complaint is created due on the complaint clock', () => made.status === 200 && Date.parse(p.due_at) - Date.parse(p.created_at) === TYPES.complaint * HOUR, () => `${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
  const changed = await call('problems/update', { method: 'POST', body: { id: p.id, type: 'request' } });
  const q = changed.body?.problem || world.tables.problem_reports.find((r) => r.id === p.id) || {};
  ok('E7 changing its type to a request moves the deadline to 24 h', () => Date.parse(q.due_at) - Date.parse(p.created_at) === TYPES.request * HOUR, () => `${changed.status} ${q.due_at}`);
  const urg = await call('problems/update', { method: 'POST', body: { id: p.id, priority: 'urgent' } });
  const u = urg.body?.problem || world.tables.problem_reports.find((r) => r.id === p.id) || {};
  ok('E8 …and making it urgent does not (urgency sorts, the type sets the deadline)', () => Date.parse(u.due_at) - Date.parse(p.created_at) === TYPES.request * HOUR && u.priority === 'urgent', () => `${urg.status} ${u.due_at}`);
  const issue = await call('problems/create', { method: 'POST', body: { title: 'Leak', clientId: 'c1', siteId: 's1', type: 'issue', priority: 'urgent' } });
  const ip = issue.body?.problem || {};
  ok('E9 an urgent ISSUE is created on urgent\'s clock', () => Date.parse(ip.due_at) - Date.parse(ip.created_at) === WO.SLA_HOURS.urgent * HOUR);
}

// ═══ F. the screens say it ══════════════════════════════════════════════════════════════════
{
  const en = read('../src/i18n/catalog/en.js');
  const page = read('../src/pages/ClientRequests.jsx');
  const drawer = read('../src/components/WorkOrderDrawer.jsx');
  ok('F1 the work-order drawer shows the first-reply line (sent, or the countdown) from the queue\'s own clock', () => /function FirstReplyCell/.test(drawer) && /requestClock\(wo/.test(drawer) && /<FirstReplyCell wo=\{wo\}/.test(drawer));
  ok('F2 …its words are catalog lines', () => ['label', 'sent', 'overdue', 'left'].every((k) => new RegExp(`'workOrders\\.firstReply\\.${k}':`).test(en)));
  ok('F3 the page words both clocks (a first reply due / late, then the fix)', () => /'clientReq\.left\.replyRemaining'/.test(page) && /'clientReq\.left\.replyOverdue'/.test(page)
    && /'clientReq\.left\.replyRemaining': '[^']*\{time, duration\}/.test(en) && /'clientReq\.left\.replyOverdue': '[^']*\{time, duration\}/.test(en));
  ok('F4 the banner states the first reply and every type\'s deadline from the rule (no digit in its words)', () => {
    const lines = [...en.matchAll(/^\s*'(clientReq\.standards\.[\w.]+)':\s*(.+)$/gm)];
    return lines.length >= 3 && lines.every(([, , v]) => !/\d/.test(v)) && /\{reply\}/.test(en) && /\{failed\}/.test(en);
  });
  const s = need(CR, 'responseStandards')({ ticketEscalateMins: 45 });
  ok('F5 responseStandards: the reply window from the setting, each type\'s hours from the table, each issue urgency from SLA_HOURS', () => s.replyMins === 45
    && s.types.every((x) => x.unit === 'hours' && x.count === TYPES[x.type]) && Object.keys(MATT).every((t) => s.types.some((x) => x.type === t))
    && s.issues.every((x) => x.count * (x.unit === 'days' ? 24 : 1) === WO.SLA_HOURS[x.priority]), () => JSON.stringify(s));
}

if (fails.length) {
  console.error(`\n✖ test-request-standards: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-request-standards: ${pass} passed`);
}
