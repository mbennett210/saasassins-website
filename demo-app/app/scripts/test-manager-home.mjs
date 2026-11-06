// The manager Home's rules (the manager view redesign, plan §2.1 D1 / D3, §3.2; UI_RULES §152).
//
// Every figure on a Home tile is an ANSWERED rule read through the module that owns it, never a
// restated one (the scaffolding rule: the boards' numbers are Claude's examples):
//   • Inspections "N due" — the inspection-reminder rule (ALR-9), the SAME predicate the walker
//     fires on (lib/opsAlerts isInspectionOverdue), per building, in the manager's scope;
//   • Hours Approval "N pending · due <day>" — the Hours Approval page's own rules (one timesheet
//     per person; the pay period holding the oldest pending punch, plan S4): lib/filters/timeApprovals;
//   • Client Requests "N open · M urgent" — the Client Requests page's own list (lib/clientRequests),
//     requests only (HUB-24 (c), 2026-10-12: a customer's message is not a request);
//   • Customer messages "N messages waiting · longest T" — the customer threads waiting for the
//     office's reply, their own figure (test-waiting-messages.mjs holds the read and the screens);
//   • Supplies "N properties need attention · M orders placed" — Supplies → By building's counts;
//   • the shift band, Schedule and Checklists — the today engine's visits (Wave B);
//   • the nav's count pills — the same five figures, null until read;
//   • which tile a viewer sees — the permission each tile's read needs (no new keys);
//   • the scope — a manager reads their own buildings (`client.supervisorId`); the owner/admin
//     pick a manager or "All managers".
//
// Offline. Run: node scripts/test-manager-home.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);

const home = await import('../src/lib/managerHome.js').catch(() => ({}));
const ops = await import('../src/lib/opsAlerts.js');
const roles = await import('../src/lib/roles.js');
const fn = (name) => (typeof home[name] === 'function' ? home[name] : () => undefined);

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-09T18:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const clients = [
  { id: 'cl_a', name: 'A', supervisorId: 'u_dana' },
  { id: 'cl_b', name: 'B', supervisorId: 'u_dana', inspectionIntervalDays: 7 },
  { id: 'cl_c', name: 'C', supervisorId: 'u_lee' },
  { id: 'cl_d', name: 'D', supervisorId: 'u_dana', status: 'inactive' },
  { id: 'cl_v', name: 'V', supervisorId: 'u_dana', type: 'vendor' },
  { id: 'cl_seed_e', name: 'E', supervisorId: 'u_dana' },
  { id: 'cl_n', name: 'N' },
];

// ── the scope ────────────────────────────────────────────────────────────────────────────────
{
  const scope = fn('homeScope');
  const dana = scope({ viewer: { id: 'u_dana', role: 'manager' }, mgrParam: 'u_lee', clients }) || {};
  ok(`a manager reads their own buildings, whatever ?mgr= says (${show(dana.clientIds && [...dana.clientIds])})`,
    dana.mgrId === 'u_dana' && dana.clientIds instanceof Set && show([...dana.clientIds].sort()) === show(['cl_a', 'cl_b', 'cl_d', 'cl_seed_e']) && dana.picker === false);
  ok('…and a vendor is not a property', dana.clientIds instanceof Set && !dana.clientIds.has('cl_v'));
  ok('the subtitle counts the buildings in scope', dana.propertyCount === 4);
  const all = scope({ viewer: { id: 'u_owner', role: 'owner' }, mgrParam: '', clients }) || {};
  ok('the owner\'s Manager view opens on "All managers": every building, unscoped', all.mgrId === null && all.clientIds === null && all.propertyCount === 6 && all.picker === true);
  const lee = scope({ viewer: { id: 'u_owner', role: 'owner' }, mgrParam: 'u_lee', clients }) || {};
  ok('the owner may pick one manager', lee.mgrId === 'u_lee' && show([...(lee.clientIds || [])]) === show(['cl_c']) && lee.propertyCount === 1);
  const none = scope({ viewer: { id: 'u_new', role: 'manager' }, mgrParam: '', clients }) || {};
  ok('a manager who supervises nothing reads NOTHING (an empty scope, never "everything")', none.clientIds instanceof Set && none.clientIds.size === 0 && none.propertyCount === 0);
  const inScope = fn('inHomeScope');
  ok('inHomeScope: unscoped takes everything, even a row with no building', inScope(all, 'cl_c') === true && inScope(all, null) === true);
  ok('inHomeScope: scoped takes only its buildings, never a row with none', inScope(dana, 'cl_a') === true && inScope(dana, 'cl_c') === false && inScope(dana, null) === false);
}

// ── Inspections "N due": THE reminder rule ───────────────────────────────────────────────────
{
  ok('opsAlerts exports the one inspection-due predicate', typeof ops.isInspectionOverdue === 'function');
  const overdue = typeof ops.isInspectionOverdue === 'function' ? ops.isInspectionOverdue : () => undefined;
  const days = ops.inspectionReminderDays({});
  ok('due once the latest inspection is a whole interval old (org default)', overdue({ client: clients[0], lastMs: NOW - days * DAY, now: NOW, settings: {} }) === true
    && overdue({ client: clients[0], lastMs: NOW - (days - 1) * DAY, now: NOW, settings: {} }) === false);
  ok('a building\'s own interval wins (ALR-9)', overdue({ client: clients[1], lastMs: NOW - 8 * DAY, now: NOW, settings: {} }) === true
    && overdue({ client: clients[1], lastMs: NOW - 6 * DAY, now: NOW, settings: {} }) === false);
  ok('a building never inspected is not "due" (onboarding, not a lapse)', overdue({ client: clients[0], lastMs: null, now: NOW, settings: {} }) === false);

  const latest = [
    { client_id: 'cl_a', performed_at: ago(days + 2) },   // due
    { client_id: 'cl_a', performed_at: ago(days + 9) },   // an older one: the latest decides
    { client_id: 'cl_b', performed_at: ago(8) },          // due on its own 7-day interval
    { client_id: 'cl_c', performed_at: ago(days + 5) },   // due, but Lee's
    { client_id: 'cl_d', performed_at: ago(days + 5) },   // inactive: never counted
    { client_id: 'cl_seed_e', performed_at: ago(days + 1) }, // a seed building: counted on Home
  ];
  const scope = fn('homeScope');
  const dana = scope({ viewer: { id: 'u_dana', role: 'manager' }, clients });
  const due = fn('inspectionsDueCount');
  ok(`Dana's tile counts her overdue buildings (${due({ clients, latest, scope: dana, now: NOW, settings: {} })})`,
    due({ clients, latest, scope: dana, now: NOW, settings: {} }) === 3);
  const all = scope({ viewer: { id: 'u_o', role: 'owner' }, mgrParam: '', clients });
  ok('"All managers" counts every active building', due({ clients, latest, scope: all, now: NOW, settings: {} }) === 4);
  // The walker and the tile agree on the same data, building for building (the seed skip and the
  // fired-once dedup are the walker's NOTIFICATION rules, not part of "due").
  const walker = ops.getDueInspectionReminders({ clients: clients.filter((c) => !c.id.includes('_seed_')), inspections: latest, now: NOW, settings: {} }).map((r) => r.clientId).sort();
  ok(`the reminder walker fires on exactly the non-seed buildings the tile counts (${show(walker)})`, show(walker) === show(['cl_a', 'cl_b', 'cl_c']));
  ok('a broader org interval moves both together', due({ clients, latest, scope: all, now: NOW, settings: { inspectionReminderDays: 60 } }) === 1);
}

// ── Inspections "last 92% Sep 27" and the desktop trend ────────────────────────────────────
{
  const last = fn('inspectionTrend');
  const rows = [
    { id: 'i6', status: 'draft', overall_score: null, performed_at: ago(0) },
    { id: 'i5', status: 'submitted', overall_score: 92, performed_at: ago(1) },
    { id: 'i4', status: 'submitted', overall_score: 81, performed_at: ago(3) },
    { id: 'i3', status: 'submitted', overall_score: null, performed_at: ago(4) },
    { id: 'i2', status: 'submitted', overall_score: 74, performed_at: ago(6) },
    { id: 'i1', status: 'submitted', overall_score: 88, performed_at: ago(9) },
    { id: 'i0', status: 'submitted', overall_score: 60, performed_at: ago(12) },
  ];
  const r = last(rows) || {};
  ok('the last inspection is the newest SUBMITTED one with a score (a draft is not one done)', r.last?.score === 92 && r.last?.at === ago(1));
  ok(`the trend is the last four scores, oldest first (${show(r.trend)})`, show(r.trend) === show([88, 74, 81, 92]));
  ok('no inspections → no last, no trend', (last([]) || {}).last === null && show((last([]) || {}).trend) === '[]');
}

// ── Hours Approval "N pending · due <day>" (+ overtime): the Hours Approval page's own figures ─
// The tile reads the page's rules (lib/filters/timeApprovals, Builder C), never its own: one
// timesheet per PERSON (the To approve tab's count), due the last day of the pay period holding the
// oldest pending punch (plan S4), the Overtime tab's count. test-approvals-by-person.mjs holds the
// rules themselves; this holds that the tile asks them.
{
  const figs = fn('hoursFigures');
  // Imported for comparison; absent before Builder C's helpers, the checks fail instead of crashing.
  const taMod = await import('../src/lib/filters/timeApprovals.js');
  const ta = { pendingByPerson: taMod.pendingByPerson || (() => []), pendingDueKey: taMod.pendingDueKey || (() => null) };
  const semi = { payPeriodCadence: 'semimonthly' };
  const tz = 'America/New_York';
  const at = new Date('2026-10-20T16:00:00Z');
  const pending = [
    { id: 'e1', user_id: 'u_1', user_name: 'Ana', client_id: 'cl_a', clock_in_at: '2026-10-14T22:00:00Z', clock_out_at: '2026-10-15T02:00:00Z' },
    { id: 'e2', user_id: 'u_1', user_name: 'Ana', client_id: 'cl_b', clock_in_at: '2026-10-18T22:00:00Z', clock_out_at: '2026-10-19T02:00:00Z' },
    { id: 'e3', user_id: 'u_2', user_name: 'Ben', client_id: 'cl_a', clock_in_at: '2026-10-19T22:00:00Z', clock_out_at: '2026-10-20T02:00:00Z' },
  ];
  const f = figs({ pending, overtime: [{ userId: 'u_1' }] }, { opsSettings: semi, now: at, tz }) || {};
  ok(`pending counts PEOPLE, as the page's To approve tab does (${f.pending} vs ${ta.pendingByPerson(pending).length})`, f.pending === 2 && f.pending === ta.pendingByPerson(pending).length);
  ok(`due is the page's own day: the period holding the oldest pending punch (${f.dueKey})`, f.dueKey === '2026-10-15'
    && f.dueKey === ta.pendingDueKey({ rows: pending, opsSettings: semi, now: at, tz }));
  ok("nothing pending → the current period's last day",(figs({ pending: [], overtime: [] }, { opsSettings: semi, now: at, tz }) || {}).dueKey === '2026-10-31');
  ok("overtime is the Overtime tab's count", f.overtime === 1);
  ok('a read with no rows is zero, not a crash', show(figs(null, { opsSettings: semi, now: at, tz })) === show({ pending: 0, dueKey: '2026-10-31', overtime: 0 }));
}

// ── Client Requests "N open · M urgent" ─────────────────────────────────────────────────────
{
  // The Client Requests page's own list and counts (lib/clientRequests, Builder C), narrowed to the
  // manager in view by the page's queue rule (the building's supervisor).
  const figs = fn('requestFigures');
  // { problems, threads } is the requests read's answer (hooks/useManagerHomeReads useRequestsRead).
  const counts = (problems, scope) => { const c = figs({ problems }, { scope, clients, now: NOW }); return { open: c.open, urgent: c.urgent }; };
  const scope = fn('homeScope');
  const dana = scope({ viewer: { id: 'u_dana', role: 'manager' }, clients });
  const all = scope({ viewer: { id: 'u_o', role: 'owner' }, mgrParam: '', clients });
  const problems = [
    { id: 'p1', client_id: 'cl_a', status: 'open', priority: 'urgent' },
    { id: 'p2', client_id: 'cl_a', status: 'ack', priority: 'medium' },          // legacy ack → in progress: open
    { id: 'p3', client_id: 'cl_b', status: 'awaiting_client', priority: 'high' }, // retired high → urgent (WO-18)
    { id: 'p4', client_id: 'cl_b', status: 'resolved', priority: 'urgent' },      // resolved: neither
    { id: 'p5', client_id: 'cl_c', status: 'open', priority: 'urgent' },          // Lee's
    { id: 'p6', client_id: null, status: 'open', priority: 'low' },               // no building
  ];
  ok(`Dana: 3 open, 2 urgent (${show(counts(problems, dana))})`, show(counts(problems, dana)) === show({ open: 3, urgent: 2 }));
  ok(`All managers: every open ticket, the one with no building too (${show(counts(problems, all))})`, show(counts(problems, all)) === show({ open: 5, urgent: 3 }));
  // HUB-24 (c), Matt 2026-10-12: messages and requests are separate. A customer thread waiting for a
  // reply is NOT a request: handed in beside the tickets, it changes none of the counts.
  const threads = [
    { clientId: 'cl_a', managerId: 'u_dana', waitingSince: new Date(NOW - 45 * 60000).toISOString(), lastBody: 'Lobby bin full' },
    { clientId: 'cl_c', managerId: 'u_lee', waitingSince: new Date(NOW - 5 * 60000).toISOString(), lastBody: 'Thanks' },
  ];
  const withThreads = figs({ problems, threads }, { scope: dana, clients, now: NOW, settings: { ticketEscalateMins: 30 } }) || {};
  const plain = figs({ problems }, { scope: dana, clients, now: NOW, settings: { ticketEscalateMins: 30 } }) || {};
  ok(`a waiting message is not one of Dana's requests (${show(withThreads)})`, withThreads.open === 3 && withThreads.urgent === 2 && show(withThreads) === show(plain));
  ok('…nor of All managers\'', figs({ problems, threads }, { scope: all, clients, now: NOW }).open === 5);
}

// ── Customer messages "N messages waiting · longest T": their own figure (HUB-24 (c)) ─────────
{
  const figs = fn('messageFigures');
  const scope = fn('homeScope');
  const dana = scope({ viewer: { id: 'u_dana', role: 'manager' }, clients });
  const all = scope({ viewer: { id: 'u_o', role: 'owner' }, mgrParam: '', clients });
  const lee = scope({ viewer: { id: 'u_o', role: 'owner' }, mgrParam: 'u_lee', clients });
  const mins = (m) => new Date(NOW - m * 60000).toISOString();
  // The read's answer (clientMessagesApi.listWaitingCustomerThreads): the longest wait first.
  const threads = [
    { clientId: 'cl_c', managerId: 'u_lee', waitingSince: mins(36 * 60) },
    { clientId: 'cl_a', managerId: 'u_dana', waitingSince: mins(50) },
    { clientId: 'cl_b', managerId: 'u_dana', waitingSince: mins(12) },
  ];
  ok(`Dana: the threads waiting on her buildings, and the longest wait (${show(figs({ threads }, { scope: dana, now: NOW }))})`,
    show(figs({ threads }, { scope: dana, now: NOW })) === show({ waiting: 2, longestMins: 50 }));
  ok('All managers: every waiting thread', show(figs({ threads }, { scope: all, now: NOW })) === show({ waiting: 3, longestMins: 36 * 60 }));
  ok('a picked manager: theirs only', show(figs({ threads }, { scope: lee, now: NOW })) === show({ waiting: 1, longestMins: 36 * 60 }));
  ok('nothing waiting → zero, and no longest', show(figs({ threads: [] }, { scope: dana, now: NOW })) === show({ waiting: 0, longestMins: null }));
  ok('no answer yet → no figures (never zeros drawn as data)', figs(null) === null && figs(undefined) === null);
}

/// ── Supplies "N properties need attention · M orders placed": the By building tiles as read ──
{
  const figs = fn('suppliesFigures');
  // S131 Wave 2 (brief A §4): an order waiting for approval is its own building state now (Pending
  // approval), and the tile and the nav pill count it INSIDE "need attention" — the page header's
  // figure (lib/supplies supplyBuildingCounts needAttention), so the tile and the page it opens agree.
  ok("🔴 the tile shows Supplies → By building's own counts: buildings needing attention WITH the ones pending approval inside, orders placed",
    show(figs({ counts: { attention: 1, pending: 2, placed: 1, allSet: 5, total: 9, needAttention: 3 } })) === show({ attention: 3, placed: 1 }));
  ok('🔴 … and recounted over a scope from the rows, pending approval still inside "need attention"',
    show(figs({ buildings: [{ clientId: 'cl_a', state: 'pending' }, { clientId: 'cl_b', state: 'attention' }, { clientId: 'cl_c', state: 'pending' }, { clientId: 'cl_d', state: 'placed' }] },
      { clientIds: new Set(['cl_a', 'cl_b', 'cl_d']) })) === show({ attention: 2, placed: 1 }));
  ok('no answer yet → no figures (never zeros drawn as data)', figs(null) === null && figs({}) === null);
  // The read's Manager filter (S131 Wave 2: `/api/supplies` resolves `team` from the caller's claim):
  // an Operations Manager's OWN team asks for `team` (the answer is the team's buildings only); one
  // picked manager asks for them; anything else — the owner's Operations view (whose `team` would be
  // the OWNER's, who leads none), "All managers", the buildings nobody supervises — reads every
  // building and is recounted over the scope here.
  const param = fn('suppliesMgrParam');
  const scope = fn('homeScope');
  const USERS = [
    { id: 'u_ops', role: 'manager', status: 'active', managerLevel: 'operations' },
    { id: 'u_dana', role: 'manager', status: 'active', opsManagerId: 'u_ops' },
    { id: 'u_lee', role: 'manager', status: 'active' },
    { id: 'u_o', role: 'owner', status: 'active' },
  ];
  const ops = USERS[0];
  const omTeam = scope({ viewer: ops, clients, users: USERS }) || {};
  const omOne = scope({ viewer: ops, mgrParam: 'u_dana', clients, users: USERS }) || {};
  const ownerOps = scope({ viewer: USERS[3], clients, users: USERS, opsManagerId: 'u_ops' }) || {};
  const ownerAll = scope({ viewer: USERS[3], mgrParam: '', clients, users: USERS }) || {};
  const ownerLee = scope({ viewer: USERS[3], mgrParam: 'u_lee', clients, users: USERS }) || {};
  const ownerNone = scope({ viewer: USERS[3], mgrParam: 'none', clients, users: USERS }) || {};
  const dana = scope({ viewer: USERS[1], clients, users: USERS }) || {};
  ok(`🔴 an Operations Manager's own team reads \`team\` (${param(omTeam, ops)}); one of their account managers, that one (${param(omOne, ops)})`,
    param(omTeam, ops) === 'team' && param(omOne, ops) === 'u_dana');
  ok(`🔴 the owner's Operations view reads every building (recounted over the team) — never \`team\`, the OWNER's (${show(param(ownerOps, USERS[3]))})`,
    param(ownerOps, USERS[3]) === '' && param(ownerAll, USERS[3]) === '' && param(ownerLee, USERS[3]) === 'u_lee' && param(ownerNone, USERS[3]) === '');
  ok(`an account manager reads their own (${param(dana, USERS[1])})`, param(dana, USERS[1]) === 'u_dana');
  const reads = (() => { try { return readFileSync(new URL('../src/hooks/useManagerHomeReads.js', import.meta.url), 'utf8'); } catch { return ''; } })();
  const supRead = reads.slice(reads.indexOf('export function useSuppliesRead'), reads.indexOf('export function useManagerNavCounts'));
  ok('🔴 the Home\'s and the nav pill\'s ONE supplies read asks with that rule, as the viewer (the demo stub resolves `team` from them)',
    /suppliesApi\.buildings\(\{ mgr: suppliesMgrParam\(scope, currentUser\) \}, ctx\)/.test(supRead) && /user: currentUser/.test(supRead));
}

// ── Today (Wave B, on the today engine): the shift band, Schedule, Checklists ──────────────
{
  const band = fn('shiftBand');
  const C = (o) => ({ total: 0, onSite: 0, late: 0, noCheckIn: 0, upcoming: 0, done: 0, calledOut: 0, ...o });
  const b1 = band(C({ total: 8, onSite: 6, late: 1, noCheckIn: 1 })) || {};
  ok(`crews not yet checked in = late + no check-in; "M of K on site" counts every crew due now (${show(b1)})`,
    b1.state === 'attention' && b1.missing === 2 && b1.onSite === 6 && b1.due === 8);
  ok('nobody missing → the band calms ("All crews checked in"), never hides', (band(C({ total: 5, onSite: 3, done: 2 })) || {}).state === 'allIn');
  ok('everything still to come → "no crews due yet"', (band(C({ total: 4, upcoming: 4 })) || {}).state === 'notYet');
  ok('everything done or called out → "finished"', (band(C({ total: 3, done: 2, calledOut: 1 })) || {}).state === 'finished');
  ok('no visits → "no visits today"', (band(C({})) || {}).state === 'none');
  ok('no answer yet → no band figures', band(null) === null);

  const at = Date.parse('2026-10-09T21:00:00Z');
  const V = (id, status, startAt, extra = {}) => ({ jobId: id, clientId: `cl_${id}`, status, startAt, customerLabel: `Bldg ${id}`, checklist: 'none', ...extra });
  const visits = [
    V('a', 'done', '2026-10-09T13:00:00Z', { checklist: 'complete' }),
    V('b', 'in_progress', '2026-10-09T20:00:00Z', { checklist: 'in_progress' }),
    V('c', 'upcoming', '2026-10-09T23:30:00Z', { checklist: 'not_started' }),
    V('d', 'upcoming', '2026-10-09T22:00:00Z'),
    V('e', 'upcoming', '2026-10-09T22:00:00Z', { clientId: 'cl_a' }),
    V('f', 'upcoming', '2026-10-10T00:15:00Z'),
    V('g', 'late', '2026-10-09T20:45:00Z', { checklist: 'not_started' }),
  ];
  const sched = fn('scheduleFigures')(visits, at) || {};
  ok(`Schedule: every visit, and the buildings they are at (${sched.total} · ${sched.properties})`, sched.total === 7 && sched.properties === 6);
  ok(`the desktop's next visits are the three still to start, by time (${show((sched.next || []).map((v) => v.jobId))})`,
    show((sched.next || []).map((v) => v.jobId)) === show(['d', 'e', 'c']));
  ok('no answer yet → no Schedule figures', fn('scheduleFigures')(null) === null);
  const ckl = fn('checklistsFigures')(visits) || {};
  ok(`Checklists: of the visits that OWE one (the Checklists today page's count), complete and in progress (${show(ckl)})`,
    show(ckl) === show({ owed: 4, complete: 1, inProgress: 1 }));
}

// ── the manager's count pills: the Home's own figures, zero and unread drawing nothing ──────
{
  const pills = fn('navPills');
  const p = pills({ band: { missing: 2 }, hours: { pending: 14 }, requests: { open: 5 }, messages: { waiting: 3 }, supplies: { attention: 2 } }) || {};
  ok(`Shift Check-in = crews not checked in, Hours Approval = timesheets, Client Requests = open, Messages = waiting, Supplies = attention (${show(p)})`,
    show(p) === show({ '/check-in': 2, '/approvals': 14, '/requests': 5, '/messaging': 3, '/supplies': 2 }));
  ok('a figure not read yet is null (no pill, and the nav never waits for it)',
    show(pills({})) === show({ '/check-in': null, '/approvals': null, '/requests': null, '/messaging': null, '/supplies': null }));
  const key = fn('homeScopeKey');
  const scope = fn('homeScope');
  const dana = scope({ viewer: { id: 'u_dana', role: 'manager' }, clients });
  const again = scope({ viewer: { id: 'u_dana', role: 'manager' }, clients: [...clients].reverse() });
  const all = scope({ viewer: { id: 'u_o', role: 'owner' }, mgrParam: '', clients });
  ok("the shared reads' key is the scope: the same buildings are one key, another scope another",
    typeof key(dana) === 'string' && key(dana) === key(again) && key(dana) !== key(all));
}

// ── which tiles a viewer sees: the permission each tile's read needs ───────────────────────
{
  const tiles = fn('homeTiles');
  const gate = typeof home.holdsGate === 'function' ? home.holdsGate : () => undefined;
  const checkerFor = (role, revokes = []) => {
    const user = { id: `u_${role}`, role };
    const overrides = revokes.length ? [{ userId: user.id, grants: [], revokes }] : [];
    return (key) => roles.can(user, key, undefined, overrides);
  };
  const ALL = ['schedule', 'inspections', 'hours', 'requests', 'messages', 'checklists', 'supplies', 'pnl'];
  ok(`a manager on the defaults sees the boards' seven tiles and Customer messages, in order (${show(tiles(checkerFor('manager')))})`,
    show(tiles(checkerFor('manager'))) === show(ALL));
  ok('…and the shift band', gate(checkerFor('manager'), 'band') === true);
  // Each revoke removes exactly its tile(s) and leaves the others.
  const without = (revokes) => tiles(checkerFor('manager', revokes));
  const only = (list, gone) => Array.isArray(list) && show(list) === show(ALL.filter((k) => !gone.includes(k)));
  ok('no financials.view → no Property P&L tile', only(without(['financials.view']), ['pnl']));
  ok('no time.approve → no Hours Approval tile (and no band)',
    only(without(['time.approve']), ['hours']) && gate(checkerFor('manager', ['time.approve']), 'band') === false);
  ok('no problems.manage → no Client Requests tile', only(without(['problems.manage']), ['requests']));
  ok('no hub.messages.view → no Customer messages tile (and Client Requests stays)', only(without(['hub.messages.view']), ['messages']));
  ok('no supplies.view → no Supplies tile', only(without(['supplies.view']), ['supplies']));
  ok('no qc.view → none of Inspections, Client Requests, Checklists, nor the today tiles (they read saved checklists)',
    only(without(['qc.view']), ['schedule', 'inspections', 'requests', 'checklists']));
  ok("no time.view → no today tiles and no band (the engine reads the day's punches)",
    only(without(['time.view']), ['schedule', 'checklists']) && gate(checkerFor('manager', ['time.view']), 'band') === false);
  ok('every gate is a key that exists (no new permission keys)', Object.values(home.TILE_GATES || {}).length === 9
    && Object.values(home.TILE_GATES || {}).every((g) => roles.PERMISSIONS[g.perm] && (g.permsAll || []).every((k) => roles.PERMISSIONS[k])));
}

// ── where each tile goes: the owner's pick rides into every page that scopes by manager (CS-702) ──
// The owner picked a manager on the Manager view, tapped a tile, and the page opened on All
// managers: "9 open" on the tile became "11 open" on the page. Five of the seven links were plain
// paths. Every page that scopes by manager reads `?mgr=`; each tile's link carries the pick.
{
  const { readFileSync } = await import('node:fs');
  const src = (rel) => { try { return readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8'); } catch { return ''; } };
  const href = fn('tileHref');
  const scope = fn('homeScope');
  const owner = { id: 'u_o', role: 'owner' };
  const lee = scope({ viewer: owner, mgrParam: 'u_lee', clients }) || {};
  const all = scope({ viewer: owner, mgrParam: '', clients }) || {};
  const dana = scope({ viewer: { id: 'u_dana', role: 'manager' }, clients }) || {};
  const PAGES = home.TILE_PAGES || {};
  const scoped = Object.entries(PAGES).filter(([, p]) => p.mgr).map(([k]) => k);
  ok(`🔴 the band and the six manager-scoped tiles each name their page (${show(scoped)})`,
    show(scoped.sort()) === show(['band', 'checklists', 'hours', 'messages', 'requests', 'schedule', 'supplies']));
  const mgrOf = (h) => { try { return new URL(h, 'http://x').searchParams.get('mgr'); } catch { return undefined; } };
  ok('🔴 with one manager picked, every one of them carries the pick (?mgr=)', scoped.length > 0 && scoped.every((k) => mgrOf(href(k, lee)) === 'u_lee'),
    show(scoped.map((k) => href(k, lee))));
  ok('…and keeps its own path and parameters', href('messages', lee) === '/messaging?inbox=customers&view=waiting&mgr=u_lee'
    && href('band', lee) === '/check-in?mgr=u_lee' && href('schedule', lee) === '/schedule?view=Today&mgr=u_lee');
  ok('"All managers" and a manager\'s own Home carry nothing (each page\'s default is already right)',
    scoped.every((k) => mgrOf(href(k, all)) === null && mgrOf(href(k, dana)) === null));
  ok('the pages with no Manager filter never get one (the Quality hub, a new inspection, the P&L board)',
    ['inspections', 'inspect', 'pnl'].every((k) => PAGES[k] && !PAGES[k].mgr && mgrOf(href(k, lee)) === null));
  // Mechanically: the Home links only through the rule — no tile or band writes a path of its own.
  const page = src('pages/ManagerHome.jsx');
  const literalLinks = [...page.matchAll(/\bto=(?:"\/|\{'\/|\{`\/)/g)].length;
  ok(`🔴 ManagerHome.jsx writes no path of its own (${literalLinks} literal link(s)); every link is tileHref(…)`, literalLinks === 0 && /tileHref\(/.test(page));
  // …and every page the rule sends `?mgr=` to reads it (a parameter nobody reads is the bug again).
  const READERS = {
    '/check-in': 'pages/ShiftCheckIn.jsx', '/schedule': 'components/ScheduleToday.jsx', '/checklists': 'pages/ChecklistsToday.jsx',
    '/approvals': 'pages/Approvals.jsx', '/requests': 'pages/ClientRequests.jsx', '/supplies': 'pages/Supplies.jsx',
    '/messaging': 'components/CustomerMessagesInbox.jsx',
  };
  for (const k of scoped) {
    const p = String(PAGES[k]?.path || '').split('?')[0];
    const file = READERS[p];
    const s = file ? src(file) : '';
    ok(`🔴 ${p} (${k}) reads ?mgr=`, !!file && (/useMgrParam\(/.test(s) || /get\('mgr'\)/.test(s)), file || 'no reader named');
  }

  // 🔴 S131 Wave 2 (Builder A's NEW-CANDIDATE — CS-702's shape again): with an Operations Manager's
  // WHOLE team in view the links carried nothing, so the owner's Operations view (`?view=ops`, an OM
  // picked) counted the TEAM on each tile and opened each page on All managers — the company's
  // figures. Every manager-scoped page now opens on the team the Home counted: `?mgr=team` (an OM's
  // own), and for the owner looking at an OM's team `&om=<that OM>`, which an owner or an admin may
  // name (they read every building) and a manager never widens theirs with (lib/teamScope teamLeadFor).
  const TEAM_USERS = [
    { id: 'u_ops', role: 'manager', status: 'active', managerLevel: 'operations' },
    { id: 'u_dana', role: 'manager', status: 'active', opsManagerId: 'u_ops' },
    { id: 'u_lee', role: 'manager', status: 'active' },
  ];
  const opsUser = TEAM_USERS[0];
  const omTeam = scope({ viewer: opsUser, clients, users: TEAM_USERS }) || {};
  const omDana = scope({ viewer: opsUser, mgrParam: 'u_dana', clients, users: TEAM_USERS }) || {};
  const ownerOps = scope({ viewer: owner, clients, users: TEAM_USERS, opsManagerId: 'u_ops' }) || {};
  const ownerOpsDana = scope({ viewer: owner, mgrParam: 'u_dana', clients, users: TEAM_USERS, opsManagerId: 'u_ops' }) || {};
  const omOf = (h) => { try { return new URL(h, 'http://x').searchParams.get('om'); } catch { return undefined; } };
  ok('🔴 an Operations Manager on "All my team": every manager-scoped tile opens its page on `team` (their own — no `om`)',
    scoped.every((k) => mgrOf(href(k, omTeam, opsUser)) === 'team' && omOf(href(k, omTeam, opsUser)) === null), show(scoped.map((k) => href(k, omTeam, opsUser))));
  ok('🔴 the owner\'s Operations view on an OM\'s whole team: every one opens on THAT team (`mgr=team&om=<the OM>`)',
    scoped.every((k) => mgrOf(href(k, ownerOps, owner)) === 'team' && omOf(href(k, ownerOps, owner)) === 'u_ops'), show(scoped.map((k) => href(k, ownerOps, owner))));
  ok('… one account manager picked on either is that manager, as before (no `om`)', scoped.every((k) => mgrOf(href(k, omDana, opsUser)) === 'u_dana' && omOf(href(k, omDana, opsUser)) === null
    && mgrOf(href(k, ownerOpsDana, owner)) === 'u_dana' && omOf(href(k, ownerOpsDana, owner)) === null));
  ok('… each keeping its own path and parameters', href('messages', ownerOps, owner) === '/messaging?inbox=customers&view=waiting&mgr=team&om=u_ops'
    && href('band', omTeam, opsUser) === '/check-in?mgr=team' && href('supplies', ownerOps, owner) === '/supplies?tab=buildings&mgr=team&om=u_ops');
  ok('🔴 the Home hands the rule its viewer (whose team it is decides the `om`)', /tileHref\(key, scope, currentUser\)/.test(page));
  // Every page reads the owner's pick too: the today pages through the kit (useMgrParam → the today
  // engine's opsManagerId), the others from the address.
  const kit = src('components/ManagerTodayKit.jsx');
  for (const k of scoped) {
    const p = String(PAGES[k]?.path || '').split('?')[0];
    const file = READERS[p];
    const s = file ? src(file) : '';
    const today = /useMgrParam\(/.test(s);
    ok(`🔴 ${p} (${k}) reads ?om= (the owner's pick of an OM's team)`, !!file && (today
      ? /get\('om'\)/.test(kit) && /useManagerToday\(\{ mgrId, opsManagerId \}\)/.test(s)
      : /get\('om'\)/.test(s)), file || 'no reader named');
  }
  // The rule itself, and its one home.
  const TS = await import('../src/lib/teamScope.js');
  const lead = (o) => (typeof TS.teamLeadFor === 'function' ? TS.teamLeadFor({ users: TEAM_USERS, ...o }) : undefined);
  ok('🔴 whose team `team` means (lib/teamScope teamLeadFor): a manager\'s own whatever `om` says; an owner or an admin may name an ACTIVE Operations Manager; anything else the caller\'s own',
    lead({ role: 'manager', selfId: 'u_dana', om: 'u_ops' }) === 'u_dana' && lead({ role: 'owner', selfId: 'u_o', om: 'u_ops' }) === 'u_ops'
    && lead({ role: 'admin', selfId: 'u_a', om: 'u_ops' }) === 'u_ops' && lead({ role: 'owner', selfId: 'u_o', om: 'u_dana' }) === 'u_o'
    && lead({ role: 'owner', selfId: 'u_o', om: 'u_nobody' }) === 'u_o' && lead({ role: 'owner', selfId: 'u_o' }) === 'u_o'
    && lead({ role: 'supply_manager', selfId: 'u_s', om: 'u_ops' }) === 'u_s');
  const MF = await import('../src/lib/managerFilter.js');
  const ids = (v, viewer, omParam) => { try { return show([...(MF.managerFilterIds(v, { viewer, users: TEAM_USERS, omParam }) || [])].sort()); } catch { return 'threw'; } };
  ok('🔴 the pages\' filter (lib/managerFilter managerFilterIds) reads the owner\'s `team` + `om` as that OM\'s team; a manager\'s stays theirs',
    ids('team', owner, 'u_ops') === show(['u_dana', 'u_ops']) && ids('team', { id: 'u_dana', role: 'manager' }, 'u_ops') === show(['u_dana'])
    && ids('team', opsUser, null) === show(['u_dana', 'u_ops']), `${ids('team', owner, 'u_ops')} · ${ids('team', { id: 'u_dana', role: 'manager' }, 'u_ops')}`);
  const anyFile = (rel) => { try { return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'); } catch { return ''; } };
  const READS = ['api/supplies/[...path].js', 'api/client-messages/[...path].js', 'api/time/[...path].js', 'src/lib/suppliesApi.js', 'src/lib/clientMessagesDemo.js', 'src/lib/timeApi.js'];
  ok(`🔴 the three reads behind those tiles and their demo stubs read that ONE rule (${READS.filter((f) => !/teamLeadFor\(/.test(anyFile(f))).join(', ') || 'all'})`,
    READS.every((f) => /teamLeadFor\(/.test(anyFile(f))));
}

// ── the greeting follows the reader's clock ────────────────────────────────────────────────
{
  const part = fn('greetingPart');
  ok('morning before noon, afternoon before six, evening after', part(0) === 'morning' && part(11) === 'morning'
    && part(12) === 'afternoon' && part(17) === 'afternoon' && part(18) === 'evening' && part(23) === 'evening');
}

// ── "Your account managers" (S131): each AM's day, partitioned out of the team-wide reads ─────
{
  const sig = fn('accountManagerSignals');
  const ams = [{ id: 'u_dana', name: 'Dana' }, { id: 'u_lee', name: 'Lee' }];
  const now = NOW;
  const VS = (await import('../src/lib/managerToday.js')).VISIT_STATUS;
  const visits = [
    { jobId: 'v1', clientId: 'cl_a', status: VS.LATE },
    { jobId: 'v2', clientId: 'cl_b', status: VS.NO_CHECK_IN },
    { jobId: 'v3', clientId: 'cl_c', status: VS.IN_PROGRESS },
    { jobId: 'v4', clientId: 'cl_c', status: VS.LATE },
  ];
  const problems = [
    { id: 'p1', client_id: 'cl_a', status: 'open', priority: 'urgent', created_at: new Date(now - 3600e3).toISOString() },
    { id: 'p2', client_id: 'cl_c', status: 'open', created_at: new Date(now - 60e3).toISOString() },
    { id: 'p3', client_id: 'cl_c', status: 'resolved', created_at: new Date(now - 60e3).toISOString() },
  ];
  const approvals = { pending: [
    { id: 'e1', user_id: 'u_crew1', client_id: 'cl_a', clock_in_at: new Date(now - 86400e3).toISOString() },
    { id: 'e2', user_id: 'u_crew2', client_id: 'cl_b', clock_in_at: new Date(now - 86400e3).toISOString() },
    { id: 'e3', user_id: 'u_crew3', client_id: 'cl_c', clock_in_at: new Date(now - 86400e3).toISOString() },
  ], overtime: [] };
  const supplies = { buildings: [{ clientId: 'cl_a', supervisorId: 'u_dana', waiting: 2 }, { clientId: 'cl_c', supervisorId: 'u_lee', waiting: 0 }] };
  const out = sig({ ams, clients, visits, problems, approvals, supplies, now }) || [];
  const dana = out.find((x) => x.id === 'u_dana') || {};
  const lee = out.find((x) => x.id === 'u_lee') || {};
  ok(`each AM's buildings are theirs (${dana.buildings} / ${lee.buildings})`, dana.buildings === 4 && lee.buildings === 1);
  ok(`crews not checked in, by the building's supervisor (shiftBand over their visits): ${dana.notIn} / ${lee.notIn}`, dana.notIn === 2 && lee.notIn === 1);
  ok(`open requests split the same way (${dana.open} / ${lee.open})`, dana.open === 1 && lee.open === 1);
  ok(`timesheets waiting: one per person at their buildings (${dana.hours} / ${lee.hours})`, dana.hours === 2 && lee.hours === 1);
  ok(`supply orders to approve: the By building rows' own count (${dana.supplyApprovals} / ${lee.supplyApprovals})`, dana.supplyApprovals === 2 && lee.supplyApprovals === 0);
  const unread = sig({ ams, clients, visits: null, problems: null, approvals: null, supplies: null }) || [];
  ok('a read that has not landed says nothing (null), never a false zero', unread.length === 2 && unread.every((x) => x.notIn === null && x.open === null && x.hours === null && x.supplyApprovals === null));
  const pageSrc = (() => { try { return readFileSync(new URL('../src/pages/ManagerHome.jsx', import.meta.url), 'utf8'); } catch { return ''; } })();
  ok('the Home computes the section from its OWN reads (no read per account manager)', /accountManagerSignals\(\{/.test(pageSrc)
    && /visits: today\.visits/.test(pageSrc) && /problems: reqs\.phase === 'ok' \? reqs\.data\.problems/.test(pageSrc)
    && !/useHoursRead\(\{ ?mgrId: am/.test(pageSrc));
  ok('a tap narrows the Home to that account manager (the team picker\'s own value)', /onPick=\{\(id\) => setManager\(id\)\}/.test(pageSrc));
  // the figures keep to the scope the Home is in: the owner's Operations view reads unscoped
  const scope = { clientIds: new Set(['cl_a', 'cl_b']) };
  ok('hoursFigures keeps to the scope it is given (the Operations view\'s unscoped read)', fn('hoursFigures')(approvals, { scope }).pending === 2);
  ok('suppliesFigures recounts a scoped team from the complete By building rows', show(fn('suppliesFigures')({ buildings: [{ clientId: 'cl_a', state: 'attention' }, { clientId: 'cl_c', state: 'placed' }], counts: { attention: 9, placed: 9 } }, scope)) === show({ attention: 1, placed: 0 }));
}

console.log(`\ntest-manager-home: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
