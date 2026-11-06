// The manager Home's rules (the manager view redesign, plan §2.1 D1 / D3, §3.2; UI_RULES §152).
// PURE and node-safe (explicit `.js` imports), so test-manager-home.mjs runs every rule offline.
//
// 🔴 THE SCAFFOLDING RULE (Daniel, 2026-10-09). Matt's boards were made with Claude: every number,
// deadline and standard on them is an example. Each figure here is an ANSWERED rule read through
// the module that owns it, never a second copy of it:
//   Inspections "N due"           lib/opsAlerts isInspectionOverdue (ALR-9; the reminder's rule)
//   Hours Approval pending / due  lib/filters/timeApprovals pendingByPerson + pendingDueKey (plan
//                                 S4–S6: one timesheet per person, due the pay period's last day)
//   Client Requests open / urgent lib/clientRequests clientRequestRows + clientRequestCounts (D4,
//   / overdue                     WO-20: the /requests page's own list and counts — requests only)
//   Customer messages waiting /   the customer threads waiting for the office's reply (HUB-24 (c),
//   longest                       Matt 2026-10-12: messages and requests are separate figures;
//                                 the wait is lib/dates minutesSince of each thread's waitingSince)
//   Supplies attention / placed   the Supplies page's By building counts (SUP-14 ★a; lib/supplies
//                                 supplyBuildingRows over GET /api/supplies/buildings)
//   the shift band, Schedule and  lib/managerToday (Builder A's today engine): one status per
//   Checklists tiles              visit, and the Checklists today page's own "owed" rule
// The reads behind them are the existing ones (no new endpoint): see pages/ManagerHome.jsx.
import { isInspectionOverdue } from './opsAlerts.js';
import { isActiveBuilding, isArchivedCustomer } from './customerStatus.js';
import { pendingByPerson, pendingDueKey } from './filters/timeApprovals.js';
import { clientRequestRows, clientRequestCounts } from './clientRequests.js';
import { minutesSince } from './dates.js';
import { CHECKLIST_STATE, VISIT_STATUS, NO_MANAGER, countVisits } from './managerToday.js';
import { UNSCOPED_ROLES } from './timeRules.js';
import { TEAM, isOpsManager, teamMemberIds, managerIdsMatch } from './teamScope.js';
import { supplyBuildingCounts } from './supplies.js';

// ── which tiles a viewer sees ─────────────────────────────────────────────────────────────────
// The boards' tiles in their order (mobile-01-home / web-01-dashboard), and the shift band over
// them; the customer messages waiting for a reply follow Client Requests as their own tile
// (HUB-24 (c), 2026-10-12). Each is gated by the permissions its READ needs and the key of the
// page it opens, so no tile ever shows a read the server would refuse. No new keys. The today
// engine (hooks/useManagerToday) reads the day's punches (`time.view`) and saved checklists
// (`qc.view`), so everything built on it needs both.
export const HOME_TILES = ['schedule', 'inspections', 'hours', 'requests', 'messages', 'checklists', 'supplies', 'pnl'];
const TODAY_READS = ['time.view', 'qc.view'];
export const TILE_GATES = {
  band: { perm: 'time.approve', permsAll: TODAY_READS },              // the shift band, → /check-in
  schedule: { perm: 'schedule.view', permsAll: TODAY_READS },         // → /schedule?view=Today
  inspections: { perm: 'qc.view' },                                   // /qc/inspections/*, the Quality hub
  hours: { perm: 'time.approve' },                                    // /time/approvals, Hours Approval
  requests: { perm: 'qc.view', permsAll: ['problems.manage'] },       // /qc/problems/list, Client Requests
  messages: { perm: 'hub.messages.view' },                            // /client-messages/threads?waiting=1, Messaging → Customers
  checklists: { perm: 'qc.view', permsAll: TODAY_READS },             // → /checklists
  supplies: { perm: 'supplies.view' },                                // /supplies/buildings, By building
  pnl: { perm: 'financials.view' },                                   // the P&L board (D3), /pnl
};
export function holdsGate(check, key) {
  const g = TILE_GATES[key];
  return !!g && check(g.perm) && (g.permsAll || []).every((p) => check(p));
}
export function homeTiles(check) {
  return HOME_TILES.filter((k) => holdsGate(check, k));
}

// ── whose buildings ───────────────────────────────────────────────────────────────────────────
// ONE RULE for the Home and the today engine (hooks/useManagerToday; Shift check-in, Checklists,
// the Schedule's Today): which managers' buildings a viewer's manager screens cover. Before S131
// the Home asked `role === 'manager'` and the today engine asked UNSCOPED_ROLES, so a viewer who
// was neither (a supply manager, any role the two lists disagreed on) got every building on the
// tiles and their own (none) on the band — the split-scope trap (NEW-CANDIDATE). Now:
//   · the owner / an admin (lib/timeRules UNSCOPED_ROLES): the Manager filter `?mgr=` — '' every
//     building, 'none' the buildings nobody supervises, an id that manager's (picker 'managers');
//   · an OPERATIONS MANAGER (lib/teamScope), or the owner / an admin on the Operations view with an
//     OM picked (`opsManagerId`, OwnerHome ?view=ops): their TEAM, or one member of it (`?mgr=` an
//     id on the team; '' / 'team' / anything else = the whole team) (picker 'team');
//   · anyone else — an account manager, any other role: their own buildings, no picker.
//   → { mode: 'all' | 'none' | 'one' | 'team' | 'own', mgrId, managerIds, picker, teamOf }
//     managerIds: the supervisors whose buildings are in scope — null = every building.
export function resolveManagerScope({ viewer = null, users = [], mgrParam = '', opsManagerId = null } = {}) {
  const role = viewer?.role || null;
  const unscoped = UNSCOPED_ROLES.includes(role);
  const omId = unscoped ? (opsManagerId || null) : (isOpsManager(viewer) ? viewer.id : null);
  if (omId) {
    const members = teamMemberIds(users, omId);
    const pick = mgrParam && mgrParam !== TEAM && members.includes(mgrParam) ? mgrParam : null;
    return pick
      ? { mode: 'one', mgrId: pick, managerIds: [pick], picker: 'team', teamOf: omId }
      : { mode: 'team', mgrId: null, managerIds: members, picker: 'team', teamOf: omId };
  }
  if (unscoped) {
    if (!mgrParam || mgrParam === TEAM) return { mode: 'all', mgrId: null, managerIds: null, picker: 'managers', teamOf: null };
    if (mgrParam === NO_MANAGER) return { mode: 'none', mgrId: NO_MANAGER, managerIds: [], picker: 'managers', teamOf: null };
    return { mode: 'one', mgrId: mgrParam, managerIds: [mgrParam], picker: 'managers', teamOf: null };
  }
  const self = viewer?.id || '';
  return { mode: 'own', mgrId: self || null, managerIds: self ? [self] : [], picker: null, teamOf: null };
}

// A property is a customer that is not a vendor (a supplier lives in the same list but is never
// cleaned). The Home's scope over resolveManagerScope: the buildings of the managers in view. A
// manager who supervises nothing gets an EMPTY scope, never "everything".
//   → { mgrId, managerIds, clientIds: Set | null (null = every building), propertyCount, picker,
//       pickerKind: 'managers' | 'team' | null, teamOf }
const isProperty = (c) => !!(c && c.id && c.type !== 'vendor');
export function homeScope({ viewer, mgrParam = '', clients = [], users = [], opsManagerId = null } = {}) {
  const props = (Array.isArray(clients) ? clients : []).filter(isProperty);
  const r = resolveManagerScope({ viewer, users, mgrParam, opsManagerId });
  const base = { mgrId: r.mode === 'one' || r.mode === 'own' ? r.mgrId : null, managerIds: r.managerIds, picker: !!r.picker, pickerKind: r.picker, teamOf: r.teamOf };
  if (r.mode === 'all') return { ...base, clientIds: null, propertyCount: props.length };
  const clientIds = new Set(props.filter((c) => (r.mode === 'none' ? !c.supervisorId : managerIdsMatch(r.managerIds, c.supervisorId))).map((c) => c.id));
  if (r.mode === 'none') base.mgrId = NO_MANAGER;
  return { ...base, clientIds, propertyCount: clientIds.size };
}
// ── where each tile goes (CS-702) ─────────────────────────────────────────────────────────────
// The page the shift band and each tile open, and whether that page scopes by manager. Every page
// that does reads the Manager filter `?mgr=` (the today kit's useMgrParam for Shift check-in, the
// Schedule's Today and Checklists today; Hours Approval; Client Requests and Messaging →
// Customers through lib/managerFilter; Supplies), so on the owner's Manager view with one manager
// picked each link carries the pick and the page opens on the figures the tile showed (the owner
// tapped "9 open" and landed on All managers' "11 open"). "All managers" and an account manager's
// own Home carry nothing: each page's default is already right. The Quality hub, a new inspection
// and the P&L board have no Manager filter.
// 🔴 S131 Wave 2 (the same shape again): an Operations Manager's WHOLE team in view — an OM on "All my
// team", or the owner's Operations view with an OM picked — carried nothing either, so each page
// opened on All managers while the tile counted the team. Each link now carries the team the Home
// counted: `mgr=team` (the OM's own), plus `&om=<the OM>` when the viewer is not that OM (the owner or
// an admin naming whose team; lib/teamScope teamLeadFor is the rule every page and route reads).
export const TILE_PAGES = {
  band: { path: '/check-in', mgr: true },
  schedule: { path: '/schedule?view=Today', mgr: true },
  inspections: { path: '/inspections', mgr: false },
  inspect: { path: '/inspections?fill=1', mgr: false },
  hours: { path: '/approvals', mgr: true },
  requests: { path: '/requests', mgr: true },
  messages: { path: '/messaging?inbox=customers&view=waiting', mgr: true },
  checklists: { path: '/checklists', mgr: true },
  supplies: { path: '/supplies?tab=buildings', mgr: true },
  pnl: { path: '/pnl', mgr: false },
};
export function tileHref(key, scope, viewer = null) {
  const page = TILE_PAGES[key];
  if (!page) return '/';
  if (!page.mgr || !scope?.picker) return page.path;
  const join = page.path.includes('?') ? '&' : '?';
  if (scope.mgrId) return `${page.path}${join}mgr=${encodeURIComponent(scope.mgrId)}`;
  if (!scope.teamOf) return page.path;
  const om = scope.teamOf !== (viewer && viewer.id) ? `&om=${encodeURIComponent(scope.teamOf)}` : '';
  return `${page.path}${join}mgr=${TEAM}${om}`;
}

// What a shared read is keyed by (lib/sharedRead): whose buildings — two scopes never share an
// answer, and the nav's pills and the Home (the same viewer, the same scope) share one.
export function homeScopeKey(scope) {
  if (!scope) return '-';
  return `${scope.mgrId || 'all'}|${scope.clientIds === null ? '*' : [...scope.clientIds].sort().join(',')}`;
}
// Is a row about a building in scope? Unscoped takes everything (a row with no building too, as
// the unscoped Approvals read does); scoped takes only its buildings.
export function inHomeScope(scope, clientId) {
  if (!scope || scope.clientIds === null) return true;
  return clientId != null && clientId !== '' && scope.clientIds.has(clientId);
}

// ── Inspections ─────────────────────────────────────────────────────────────────────────────
// "N due": the active buildings in scope whose latest submitted inspection is a whole interval
// old — THE reminder rule. `latest` is qcApi.latestInspectionPerClient()'s rows
// ({ client_id, performed_at }); the newest per building decides. "Active" is the reminder's own
// rule (lib/customerStatus isActiveBuilding, CS-683): a building set Inactive or Archived is not
// counted, as it is not reminded.
export function inspectionsDueCount({ clients = [], latest = [], scope, now = Date.now(), settings = {} } = {}) {
  const lastBy = new Map();
  for (const r of Array.isArray(latest) ? latest : []) {
    const t = Date.parse(r?.performed_at);
    if (!r?.client_id || !Number.isFinite(t)) continue;
    if (!lastBy.has(r.client_id) || t > lastBy.get(r.client_id)) lastBy.set(r.client_id, t);
  }
  let n = 0;
  for (const c of Array.isArray(clients) ? clients : []) {
    if (!isActiveBuilding(c) || !inHomeScope(scope, c.id)) continue;
    if (isInspectionOverdue({ client: c, lastMs: lastBy.get(c.id) ?? null, now, settings })) n += 1;
  }
  return n;
}
// "last 92% Sep 27" and the desktop's four-bar trend, from an inspection HISTORY list (newest
// first, as qcApi.listInspections returns it). Only SUBMITTED inspections with a score count: a
// draft is an inspection started, not one done. → { last: { score, at, id } | null, trend: [oldest → newest] }
export const TREND_SIZE = 4;
export function inspectionTrend(rows = []) {
  const done = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.status === 'submitted' && Number.isFinite(Number(r.overall_score)) && r.overall_score !== null)
    .sort((a, b) => String(b.performed_at).localeCompare(String(a.performed_at)));
  const last = done[0] ? { id: done[0].id, score: Math.round(Number(done[0].overall_score)), at: done[0].performed_at } : null;
  const trend = done.slice(0, TREND_SIZE).map((r) => Math.round(Number(r.overall_score))).reverse();
  return { last, trend };
}

// ── Hours Approval ──────────────────────────────────────────────────────────────────────────
// The Hours Approval page's own figures over the same read (timeApi.approvals, scoped by the
// server and `supervisorId`), so the tile and the page cannot disagree:
//   pending  — timesheets waiting, ONE PER PERSON (the To approve tab's count, plan S4–S6);
//   dueKey   — the last day of the pay period holding the oldest pending punch (S4; with nothing
//              pending, the current period's), a day key;
//   overtime — the overtime entries waiting (the Overtime tab's count).
// `scope` (optional) keeps the rows to the Home's buildings: the server already scopes a manager's
// read (an Operations Manager's to their team), so for them it changes nothing; it is the owner's
// Operations view — an unscoped read shown as one OM's team — that it narrows.
export function hoursFigures(approvals, { user = null, opsSettings = null, now = new Date(), tz, scope = null } = {}) {
  const keep = (r) => inHomeScope(scope, r?.client_id ?? r?.clientId ?? null);
  const pending = (Array.isArray(approvals?.pending) ? approvals.pending : []).filter(keep);
  return {
    pending: pendingByPerson(pending, user).length,
    dueKey: pendingDueKey({ rows: pending, opsSettings, now, tz }),
    overtime: (Array.isArray(approvals?.overtime) ? approvals.overtime : []).filter(keep).length,
  };
}

// ── Client Requests ─────────────────────────────────────────────────────────────────────────
// "N open · M urgent · K overdue": the Client Requests page's own list and counts
// (lib/clientRequests) over the same read — `problems` (qcApi.listOpenProblems: every open ticket,
// complete since CS-640, with its first staff reply) — narrowed to the manager in view by the same
// rule, the building's supervisor. "All managers" takes the whole list. Requests only: a customer
// message waiting for a reply is the messages tile's figure (HUB-24 (c)). `settings` is the org's
// ops settings (the first-reply window, WO-5).
export function requestFigures({ problems = [] } = {}, { scope, clients = [], settings = {}, now = Date.now() } = {}) {
  const byId = new Map((Array.isArray(clients) ? clients : []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const supervisorOf = (id) => (id ? byId.get(id)?.supervisorId || null : null);
  // An archived customer's request leaves the count, as it leaves the queue (CS-663).
  const clientArchived = (id) => isArchivedCustomer(byId.get(id));
  // The managers in view: one, a TEAM (an Operations Manager's, S131), or '' for every building.
  const managerId = scope?.managerIds ?? (scope?.mgrId || '');
  return clientRequestCounts(clientRequestRows(problems, {
    now, settings: settings || {}, supervisorOf, managerId, clientArchived,
  }));
}

// ── Customer messages (HUB-24 (c), Matt 2026-10-12: "Messages and requests should be treated
// separately") ──────────────────────────────────────────────────────────────────────────────
// "N messages waiting · longest T": the customer threads waiting for the office's reply, from
// clientMessagesApi.listWaitingCustomerThreads (complete; the read already narrowed to the manager
// in view by the building's supervisor), kept to the scope's buildings, with the longest wait in
// whole minutes (lib/dates minutesSince of `waitingSince`; null with nothing waiting). No answer → null.
export function messageFigures(answer, { scope, now = Date.now() } = {}) {
  if (!answer || typeof answer !== 'object') return null;
  const threads = (Array.isArray(answer.threads) ? answer.threads : []).filter((t) => t && inHomeScope(scope, t.clientId));
  let longestMins = null;
  for (const t of threads) {
    const m = minutesSince(t.waitingSince, now);
    if (m != null && (longestMins == null || m > longestMins)) longestMins = m;
  }
  return { waiting: threads.length, longestMins };
}

// ── Supplies (SUP-14 ★a) ────────────────────────────────────────────────────────────────────
// "N properties need attention · M orders placed": the Supplies page's By building figures, read
// as they are (suppliesApi.buildings → { counts }: one complete read of every building's ONE state).
// S131 Wave 2 (brief A §4): an order waiting for approval is its own state now (Pending approval),
// and "need attention" — this tile, the nav pill and the page's header — counts it INSIDE: the
// counts' `needAttention` (over budget + pending approval, lib/supplies supplyBuildingCounts), so the
// tile and the page it opens say the same number. → { attention: that figure, placed }.
// With a `scope` that names buildings, the counts are the page's own rule over the rows in scope —
// the owner's Operations view reads every building and keeps the team's here; an Operations
// Manager's own Home asks the server for `team` (suppliesMgrParam), whose rows are the team's already.
export function suppliesFigures(answer, scope = null) {
  if (!answer || typeof answer !== 'object') return null;
  if (scope && scope.clientIds && Array.isArray(answer.buildings)) {
    const c = supplyBuildingCounts(answer.buildings.filter((b) => inHomeScope(scope, b?.clientId)));
    return { attention: c.needAttention, placed: c.placed };
  }
  const c = answer.counts || null;
  if (!c) return null;
  const need = Number.isFinite(Number(c.needAttention)) ? Number(c.needAttention) : (Number(c.attention) || 0) + (Number(c.pending) || 0);
  return { attention: need, placed: Number(c.placed) || 0 };
}
// The Manager filter the Supplies read asks the SERVER for (S131 Wave 2: /api/supplies resolves
// `team` from the caller's claim): one manager in view, by id; an Operations Manager's OWN whole team,
// `team` — the answer is their team's buildings only; anything else '', every building, recounted over
// the scope by suppliesFigures: the owner's Operations view (`team` would be the OWNER's, who leads
// none), "All managers", and the buildings nobody supervises (`none` names no manager to the server).
export function suppliesMgrParam(scope, viewer = null) {
  if (!scope) return '';
  if (scope.mgrId && scope.mgrId !== NO_MANAGER) return scope.mgrId;
  if (!scope.mgrId && scope.teamOf && viewer?.id && scope.teamOf === viewer.id) return TEAM;
  return '';
}

// ── Today: the shift band, Schedule and Checklists (Wave B, on Builder A's today engine) ────
// The band (mobile-01-home's amber card): the crews NOT YET CHECKED IN are the visits past their
// start with nobody clocked in — late (inside the missed mark) and no check-in (past it) — and
// "M of K on site" counts the visits under way against every visit due on site now (under way,
// late or no check-in). With nobody missing the band CALMS rather than hiding:
//   attention — someone is not checked in (the warning tokens)
//   allIn     — every crew due on site now is there
//   notYet    — today's visits are all still to come
//   finished  — nothing is due any more (done, or called out)
//   none      — no visits today
export function shiftBand(counts) {
  if (!counts) return null;
  const missing = (counts.late || 0) + (counts.noCheckIn || 0);
  const onSite = counts.onSite || 0;
  const due = onSite + missing;
  let state = 'attention';
  if (!missing) {
    if (!counts.total) state = 'none';
    else if (due) state = 'allIn';
    else if (counts.upcoming) state = 'notYet';
    else state = 'finished';
  }
  return { state, missing, onSite, due, total: counts.total || 0, upcoming: counts.upcoming || 0 };
}
// The Schedule tile: "N visits · M properties", and on the desktop the next visits by start
// time (not started yet as of the answer's moment).
export const NEXT_VISITS = 3;
export function scheduleFigures(visits, asOf = Date.now()) {
  if (!Array.isArray(visits)) return null;
  const c = countVisits(visits);
  const at = new Date(asOf).getTime();
  const t = (v) => Date.parse(v?.startAt);
  const next = visits.filter((v) => v && v.status === VISIT_STATUS.UPCOMING && t(v) >= at)
    .sort((a, b) => t(a) - t(b) || String(a.customerLabel || '').localeCompare(String(b.customerLabel || '')))
    .slice(0, NEXT_VISITS);
  return { total: c.total, properties: c.properties, next };
}
// The Checklists tile: "N of M visits complete today · K in progress" — the Checklists today
// page's own count: a visit OWES a checklist unless its state is none; complete and in progress
// are lib/managerToday's checklist states (a checklist counts once the cleaner saves it, S9).
export function checklistsFigures(visits) {
  if (!Array.isArray(visits)) return null;
  const owed = visits.filter((v) => v && v.checklist !== CHECKLIST_STATE.NONE);
  const c = countVisits(owed);
  return { owed: c.total, complete: c.checklists.complete, inProgress: c.checklists.inProgress };
}

// ── an Operations Manager's account managers (S131, plan 2026-10-14 §0) ──────────────────────
// "Your account managers" on an OM's Home: each AM's buildings and today's signals — crews not
// checked in, open / overdue requests, timesheets waiting, supply orders waiting for approval —
// PARTITIONED out of the team-wide answers the Home already read, by each building's supervisor,
// never a read per AM (N account managers would be N times every read). Each figure goes through
// the rule that owns it (shiftBand over the today engine's visits, requestFigures, hoursFigures,
// the By building rows' own `waiting`), so a card and a tile can never disagree. A figure whose
// read has not landed (or failed) is null: the card says nothing rather than a false zero.
//   ams        the account managers, in display order (lib/teamScope teamAccountManagers)
//   visits     useManagerToday's visits over the team (each carries its clientId) | null
//   problems   the Client Requests read (qcApi.listOpenProblems) | null
//   approvals  the Hours Approval read (timeApi.approvals over the team) | null
//   supplies   Supplies → By building's answer ({ buildings: [{ clientId, supervisorId, waiting }] }) | null
//   → [{ id, buildings, notIn, open, overdue, hours, supplyApprovals }]
export function accountManagerSignals({
  ams = [], clients = [], visits = null, problems = null, approvals = null, supplies = null,
  settings = {}, user = null, now = Date.now(),
} = {}) {
  const props = (Array.isArray(clients) ? clients : []).filter(isProperty);
  const supervisorOf = new Map(props.map((c) => [c.id, c.supervisorId || null]));
  return (Array.isArray(ams) ? ams : []).filter((am) => am && am.id).map((am) => {
    const clientIds = new Set(props.filter((c) => c.supervisorId === am.id).map((c) => c.id));
    const scope = { mgrId: am.id, managerIds: [am.id], clientIds, picker: false };
    const band = Array.isArray(visits) ? shiftBand(countVisits(visits.filter((v) => v && supervisorOf.get(v.clientId) === am.id))) : null;
    const req = problems ? requestFigures({ problems }, { scope, clients, settings, now }) : null;
    const hrs = approvals ? hoursFigures(approvals, { user, scope }) : null;
    const sup = supplies && Array.isArray(supplies.buildings)
      ? supplies.buildings.filter((b) => b && b.supervisorId === am.id).reduce((n, b) => n + (Number(b.waiting) || 0), 0)
      : null;
    return {
      id: am.id,
      buildings: clientIds.size,
      notIn: band ? band.missing : null,
      open: req ? req.open : null,
      overdue: req ? req.overdue : null,
      hours: hrs ? hrs.pending : null,
      supplyApprovals: sup,
    };
  });
}

// ── the manager's count pills (the sidebar and the phone menu, web-0N) ───────────────────────
// The figures the Home shows, from the same shared reads: Shift Check-in = crews not checked in,
// Hours Approval = timesheets waiting, Client Requests = open requests, Messages = customer
// messages waiting for a reply (HUB-24 (c)), Supplies = buildings needing attention. A figure not
// read yet (or unreadable) is null; zero and null draw no pill. (On a phone Messages is a tab of
// the bottom bar, which never changes (UI_RULES §152), so its count is the Home's tile there.)
export function navPills({ band = null, hours = null, requests = null, messages = null, supplies = null } = {}) {
  return {
    '/check-in': band ? band.missing : null,
    '/approvals': hours ? hours.pending : null,
    '/requests': requests ? requests.open : null,
    '/messaging': messages ? messages.waiting : null,
    '/supplies': supplies ? supplies.attention : null,
  };
}

// ── the greeting ────────────────────────────────────────────────────────────────────────────
// A courtesy to whoever is reading, on the READER's clock (as the other two dashboards do);
// every business date on the page stays org-time.
export function greetingPart(hour) {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}
