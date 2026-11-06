// Client Requests (`/requests`, the manager view redesign, 2026-10-09; plan §1, D4, §2.2; brief C §2).
//
// The page is the Quality hub's Work Orders list seen from Matt's board: the OPEN tickets, and
// nothing else — a customer's message waiting for a reply is not a request (HUB-24 (c), Matt
// 2026-10-12: "Messages and requests should be treated separately"; test-waiting-messages.mjs) —
// overdue first, each with its time left, under a banner that states the REAL standards. The
// board's "Carol's standards" were Claude's example (Daniel, 2026-10-09); the standards are Matt's
// answered ones: a first reply inside the org's no-reply window (WO-5, lib/ticketAlerts), then the
// fix by the request's TYPE (WO-20, lib/workOrders TYPE_DEADLINE_HOURS) or, for an issue, its
// urgency (WO-21, SLA_HOURS). The rule itself is test-request-standards.mjs's. What this pins:
//   A. only open tickets, scoped by the building's manager and by type;
//   B. the time left is the queue's clock (first reply, then the fix; overdue / left / paused);
//   C. overdue first, then by urgency (WO-20: urgency sorts); waiting on the client after;
//   D. "N open · M urgent · K overdue";
//   E. the banner's numbers come from the rules, and its words restate none;
//   F. the page is wired end to end (route + gate, nav leaf, search, back pill, catalog) and the
//      work-order drawer is ONE component the Work Orders tab and this page share (II.5).
//
// The module is imported at run time, so on a tree without it each check FAILS with a count.
//
//   node app/scripts/test-client-requests.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SLA_HOURS, TYPE_DEADLINE_HOURS, WO_TYPES, WO_PRIORITIES, computeDueAt } from '../src/lib/workOrders.js';
import { ticketEscalateMins, TICKET_ALERT_DEFAULTS } from '../src/lib/ticketAlerts.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => (existsSync(path.join(APP, rel)) ? readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n') : '');

let CR = {};
try { CR = await import(pathToFileURL(path.join(APP, 'src/lib/clientRequests.js')).href); } catch { CR = {}; }
const need = (name) => { if (typeof CR[name] !== 'function') throw new Error(`lib/clientRequests.js has no ${name}()`); return CR[name]; };

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

const NOW = Date.parse('2026-10-09T18:00:00.000Z');
const MIN = 60000;
const ago = (mins) => new Date(NOW - mins * MIN).toISOString();
// A problem_reports row as listOpenProblems returns it (due_at as the server stamps it, the first
// staff reply as the open view carries it — answered five minutes in, so the FIX clock runs).
const ticket = (id, { priority = 'medium', type = 'request', status = 'open', openedMinsAgo = 60, client = 'cl_a', ...rest } = {}) => {
  const created_at = ago(openedMinsAgo);
  return {
    id, title: `T ${id}`, client_id: client, client_name: `Client ${client}`, priority, type, status, created_at,
    due_at: computeDueAt(created_at, { type, priority }), first_reply_at: ago(Math.max(0, openedMinsAgo - 5)), origin: 'portal', ...rest,
  };
};
const SUP = { cl_a: 'mgr_dana', cl_b: 'mgr_dana', cl_c: 'mgr_luis' };
const supervisorOf = (id) => SUP[id] || null;
const COMPLAINT_MINS = TYPE_DEADLINE_HOURS.complaint * 60;

const rows = [
  ticket('urgent_late', { priority: 'urgent', type: 'complaint', openedMinsAgo: COMPLAINT_MINS + 20 }),             // 20 min overdue
  ticket('urgent_soon', { priority: 'urgent', type: 'complaint', openedMinsAgo: COMPLAINT_MINS - 20, client: 'cl_b' }), // 20 min left
  ticket('medium_ok', { priority: 'medium', type: 'request', openedMinsAgo: 300 }),                                  // 19 h left
  ticket('low_ok', { priority: 'low', type: 'issue', openedMinsAgo: 60, client: 'cl_c' }),                           // 71 h left
  ticket('waiting', { priority: 'urgent', type: 'complaint', status: 'awaiting_client', openedMinsAgo: 500 }),
  ticket('done', { priority: 'urgent', type: 'complaint', status: 'resolved', openedMinsAgo: 30, resolved_at: ago(5) }),
  ticket('legacy_ack', { priority: 'medium', type: 'request', status: 'ack', openedMinsAgo: 120, client: 'cl_b' }),
];
const list = (opts = {}) => need('clientRequestRows')(rows, { now: NOW, supervisorOf, ...opts });
const ids = (l) => l.map((w) => w.id);

// ═══ A. open only, scoped by manager and type ═══════════════════════════════════════
ok('A1 a resolved ticket is not a request in the list', () => !ids(list()).includes('done'));
ok('A2 every other ticket is open and listed (a legacy "ack" reads as in progress)', () => ids(list()).length === 6 && ids(list()).includes('legacy_ack'), () => JSON.stringify(ids(list())));
ok('A3 a manager sees their own buildings only (client.supervisorId)', () => ids(list({ managerId: 'mgr_luis' })).join() === 'low_ok', () => JSON.stringify(ids(list({ managerId: 'mgr_luis' }))));
ok('A4 the type filter keeps one type', () => list({ type: 'complaint' }).every((w) => w.type === 'complaint') && list({ type: 'complaint' }).length === 3);
ok('A5 the types offered are the work orders\' own (WO_TYPES), and no "message" type', () => /WO_TYPES\.map\(/.test(read('src/pages/ClientRequests.jsx'))
  && !('CLIENT_REQUEST_TYPES' in CR) && !('MESSAGE_KIND' in CR) && !WO_TYPES.includes('message'));

// ═══ B. time left, to the minute, on the queue's clock ════════════════════════════════
{
  const by = () => new Map(list().map((w) => [w.id, w]));
  ok('B1 20 minutes past a complaint\'s TYPE deadline reads overdue by 20', () => { const l = by().get('urgent_late').left; return l.phase === 'fix' && l.state === 'breached' && l.minutes === 20; }, () => JSON.stringify(by().get('urgent_late')?.left));
  ok('B2 20 minutes before it reads 20 left, inside the warning window', () => { const l = by().get('urgent_soon').left; return l.state === 'soon' && l.minutes === 20; }, () => JSON.stringify(by().get('urgent_soon')?.left));
  ok('B3 a request 5 h old has 19 h left (TYPE_DEADLINE_HOURS.request)', () => { const l = by().get('medium_ok').left; return l.state === 'ok' && l.minutes === TYPE_DEADLINE_HOURS.request * 60 - 300; }, () => JSON.stringify(by().get('medium_ok')?.left));
  ok('B4 a LOW issue keeps its urgency clock (SLA_HOURS.low)', () => { const l = by().get('low_ok').left; return l.state === 'ok' && l.minutes === SLA_HOURS.low * 60 - 60; }, () => JSON.stringify(by().get('low_ok')?.left));
  ok('B5 waiting on the client is paused, with no minutes', () => { const l = by().get('waiting').left; return l.state === 'paused' && l.minutes == null; });
  ok('B6 opened-ago is whole minutes since created_at', () => by().get('medium_ok').openedMinutes === 300 && by().get('urgent_late').openedMinutes === COMPLAINT_MINS + 20);
  ok('B7 a ticket with no due_at gets one by the rule (an urgent issue: SLA_HOURS.urgent)', () => {
    const r = need('clientRequestRows')([{ id: 'x', type: 'issue', priority: 'urgent', status: 'open', created_at: ago(30) }], { now: NOW });
    return r[0].left.state === 'soon' && r[0].left.minutes === SLA_HOURS.urgent * 60 - 30;
  });
  ok('B8 an unanswered request runs the FIRST-REPLY clock (the org\'s window), not the fix', () => {
    const r = need('clientRequestRows')([{ id: 'y', type: 'request', priority: 'low', status: 'open', created_at: ago(10), first_reply_at: null }], { now: NOW });
    return r[0].left.phase === 'reply' && r[0].left.minutes === ticketEscalateMins({}) - 10;
  });
}

// ═══ C. overdue first, then urgency ════════════════════════════════════════════════
ok('C1 overdue, then by urgency and the nearest deadline, …, then paused', () => ids(list()).join() === 'urgent_late,urgent_soon,medium_ok,legacy_ack,low_ok,waiting', () => JSON.stringify(ids(list())));
ok('C2 urgency sorts (WO-20): an urgent request comes before a medium complaint due sooner', () => {
  const r = need('clientRequestRows')([
    { id: 'm', type: 'complaint', priority: 'medium', status: 'in_progress', created_at: ago(10), first_reply_at: ago(5) },
    { id: 'u', type: 'request', priority: 'urgent', status: 'in_progress', created_at: ago(10), first_reply_at: ago(5) },
  ], { now: NOW });
  return ids(r).join() === 'u,m';
});

// ═══ D. N open · M urgent · K overdue ═════════════════════════════════════════════════
ok('D1 counts: 6 open, 3 urgent, 1 overdue', () => { const c = need('clientRequestCounts')(list()); return c.open === 6 && c.urgent === 3 && c.overdue === 1; }, () => JSON.stringify(need('clientRequestCounts')(list())));
ok('D2 counts follow the manager in view', () => { const c = need('clientRequestCounts')(list({ managerId: 'mgr_luis' })); return c.open === 1 && c.urgent === 0 && c.overdue === 0; });

// ═══ E. the banner states the REAL standards ════════════════════════════════════════
ok('E1 one target per client request type (in hours, TYPE_DEADLINE_HOURS) and per issue urgency (SLA_HOURS)', () => {
  const s = need('responseStandards')({});
  return s.types.length === Object.keys(TYPE_DEADLINE_HOURS).length && s.types.every((x) => x.unit === 'hours' && x.count === TYPE_DEADLINE_HOURS[x.type])
    && s.issues.length === WO_PRIORITIES.length && s.issues.every((x) => x.count * (x.unit === 'days' ? 24 : 1) === SLA_HOURS[x.priority]);
}, () => JSON.stringify(need('responseStandards')({})));
ok('E2 the first-reply window is the alert walker\'s own (default)', () => need('responseStandards')({}).replyMins === TICKET_ALERT_DEFAULTS.ticketEscalateMins);
ok('E3 …and follows the org\'s setting, with its clamps', () => need('responseStandards')({ ticketEscalateMins: 45 }).replyMins === 45
  && need('responseStandards')({ ticketEscalateMins: -5 }).replyMins === ticketEscalateMins({ ticketEscalateMins: -5 }));
{
  const en = read('src/i18n/catalog/en.js');
  const page = read('src/pages/ClientRequests.jsx');
  const lines = [...en.matchAll(/^\s*'(clientReq\.[\w.]+)':\s*(.+)$/gm)];
  ok('E4 the banner\'s words restate no number (every figure is a placeholder)', () => lines.length > 0
    && lines.filter(([, k]) => k.startsWith('clientReq.standards')).every(([, , v]) => !/\d/.test(v)), () => lines.filter(([, k]) => k.startsWith('clientReq.standards')).map((m) => m[0]).join(' | '));
  ok('E5 nothing on the page names the board\'s example (Carol)', () => page && !/Carol/i.test(page) && !/Carol/.test(lines.map((m) => m[0]).join('\n')));
  ok('E6 the page reads responseStandards() over the org\'s ops settings', () => /const settings = state\.opsSettings \|\| \{\}/.test(page) && /responseStandards\(settings\)/.test(page));
  const kinds = [...new Set([...WO_TYPES, ...Object.keys(TYPE_DEADLINE_HOURS)])];
  ok('E7 every request type has its catalog word (failed inspection too), and no "message" word', () => kinds
    .every((t) => new RegExp(`'clientReq\\.type\\.${t}':`).test(en) && new RegExp(`${t}: 'clientReq\\.type\\.${t}'`).test(page))
    && !/'clientReq\.type\.message'/.test(en) && !/clientReq\.type\.message/.test(page));
}

// ═══ F. wired end to end ══════════════════════════════════════════════════════════
{
  const app = read('src/App.jsx');
  const nav = read('src/lib/navData.js');
  const from = read('src/hooks/useFromHere.js');
  const reg = read('src/lib/masterSearch/registry.js');
  const en = read('src/i18n/catalog/en.js');
  const page = read('src/pages/ClientRequests.jsx');
  const panel = read('src/components/WorkOrdersPanel.jsx');
  const drawer = read('src/components/WorkOrderDrawer.jsx');
  const conv = read('scripts/test-i18n-coverage.mjs');
  ok('F1 /requests is routed behind the Work Orders tab\'s own gate (problems.manage)', () => /<Route path="requests" element=\{<RequirePerm perm="problems\.manage"><ClientRequests \/><\/RequirePerm>\} \/>/.test(app));
  ok('F2 a nav leaf, managers only, after Quality', () => {
    // (descKey: the line its Launcher tile shows, UI_RULES §182)
    const leaf = /\{ to: '\/requests', label: 'Client Requests', labelKey: 'nav\.clientRequests', (?:descKey: 'nav\.desc\.\w+', )?icon: '\w+', perm: 'problems\.manage', managerOnly: true/.test(nav);
    return leaf && nav.indexOf("to: '/requests'") > nav.indexOf("to: '/inspections'");
  });
  ok('F3 the nav word is a catalog line equal to the leaf\'s English', () => /'nav\.clientRequests': 'Client Requests'/.test(en));
  ok('F4 the back pill names the page (useFromHere)', () => /pathname === '\/requests'\) return 'nav\.clientRequests'/.test(from));
  ok('F5 search finds it by what an office would type', () => /'\/requests': \[[^\]]*'complaints'/.test(reg));
  ok('F6 the page is on the catalog (test-i18n-coverage CONVERTED)', () => /'src\/pages\/ClientRequests\.jsx'/.test(conv));
  ok('F7 Respond opens the ONE work-order drawer, shared with the Work Orders tab', () => /import WorkOrderDrawer from '\.\.\/components\/WorkOrderDrawer'/.test(page)
    && /import WorkOrderDrawer(, \{[^}]*\})? from '\.\/WorkOrderDrawer'/.test(panel) && /export default function WorkOrderDrawer/.test(drawer));
  ok('F8 the drawer is not copied: the Work Orders tab no longer defines it (II.5)', () => !/function WorkOrderDetail\b/.test(panel) && !/function WorkOrderMessage\b/.test(panel) && /function WorkOrderDetail\b/.test(drawer));
  ok('F9 the list is the Work Orders tab\'s own read: every open ticket (qcApi.listOpenProblems, CS-640)', () => /qcApi\.listOpenProblems\(/.test(page));
  ok('F10 the page orders and scopes with the requests\' own rows (clientRequestRows), never its own sort', () => /clientRequestRows\(/.test(page) && !/clientRequestQueue/.test(page) && !/\.sort\(/.test(page));
}

if (fails.length) {
  console.error(`\n✖ test-client-requests: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-client-requests: ${pass} passed`);
}
