// Supplies: the approval step, usage at delivery, the monthly budget and the order
// reminder — Matt's SUP-1 / SUP-4 / SUP-5 / SUP-7 / SUP-8 answers (2026-09-29) plus the
// SUP-9 / SUP-10 ★ defaults, and the register entries CS-191 (usage per building) and
// CS-380 (supply-order reminders).
//
// SUP-13 (2026-10-05): requests left the shared record, so the flow here runs the route's pure
// pieces (lib/supplyFlow supplyDecisionPatch / supplyDecisionNotifications) and the org_state
// guard section holds only what is still the blob's — a building's supply settings and the two
// RETIRED slices. Who may submit / approve / fill / cancel is judged by /api/supplies and driven
// per role in test-supplies-route.mjs.
//
//   node scripts/test-supplies-approval.mjs
//
// ⚠️ NAMESPACE IMPORTS on purpose. A missing named export is a LINK error that kills the
// whole file, so every rule would report as one crash instead of as the specific thing that
// is not built. Reading each function off a namespace makes a not-yet-built rule fail as its
// own named check — which is how this suite was seen failing on the pre-fix tree.
import * as supplies from '../src/lib/supplies.js';
import * as supplyFlow from '../src/lib/supplyFlow.js';
import * as opsAlerts from '../src/lib/opsAlerts.js';
import * as opsAlertApply from '../src/lib/opsAlertApply.js';
import * as opsAlertCopyModule from '../src/lib/opsAlertCopy.js';
import { renderText } from '../src/i18n/core.js';
// CS-193: the alert copy is catalog MESSAGES now, rendered for each recipient in their own
// language by the fan-out. Read here in English — the catalog's English is the source of truth.
const opsAlertCopy = {
  opsAlertCopy: typeof opsAlertCopyModule.opsAlertCopy === 'function'
    ? (...a) => { const c = opsAlertCopyModule.opsAlertCopy(...a); return { ...c, title: renderText(c.title, 'en'), body: renderText(c.body, 'en') }; }
    : undefined,
};
import * as notifications from '../src/lib/notifications.js';
import * as guard from '../api/_lib/orgStateGuard.js';
import { PERMISSIONS, PERM_GROUPS } from '../src/lib/roles.js';
import { setOrgTimezone } from '../src/lib/dates.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : undefined);

// Everything calendar here is the ORG's zone (II.8), pinned so the suite is the same on
// every machine. Florida is the real one; a US zone west of UTC is what catches a walker
// that keys months off UTC.
const ORG_TZ = 'America/New_York';
setOrgTimezone(ORG_TZ);

const OWNER = 'u_owner';
const OFFICE = 'u_office';     // holds supplies.manage, not supplies.approve
const SUP = 'u_sup';           // the building's supervisor — the default approver
const CREW = 'u_crew';
const DRIVER = 'u_driver';     // a crew login holding the Deliveries grant (SUP-17: "Alberto")

// ── the state machine (lib/supplies) ─────────────────────────────────────────
{
  const S = supplies.SUPPLY_STATUS || {};
  ok('SUP-1: `requested` is still the string "open" (no committed request is transformed)',
    S.requested === 'open');
  ok('SUP-1: approved / rejected / completed are the other three states',
    S.approved === 'approved' && S.rejected === 'rejected' && S.completed === 'completed');
  ok('SUP-1: a row with NO status reads as requested, never as an unknown state',
    call(supplies.supplyStatusOf, {}) === 'open' && call(supplies.supplyStatusOf, { status: 'nonsense' }) === 'open');

  ok('SUP-1: requested -> approve -> approved', call(supplies.nextSupplyStatus, 'open', 'approve') === 'approved');
  ok('SUP-1: requested -> reject -> rejected', call(supplies.nextSupplyStatus, 'open', 'reject') === 'rejected');
  // S131 (Matt's 2026-10-13 email): the Supply Manager SUBMITS an approved order to the supplier (the
  // stored `sent`), its lines are delivered one by one, and it is COMPLETED once every line is resolved.
  ok('S131: approved -> submit -> sent ("Submitted to supplier")', call(supplies.nextSupplyStatus, 'approved', 'submit') === 'sent');
  ok('S131: sent -> complete -> completed', call(supplies.nextSupplyStatus, 'sent', 'complete') === 'completed');
  ok('🔴 S131: approved -> complete is REFUSED (only a submitted order is completed)',
    call(supplies.nextSupplyStatus, 'approved', 'complete') === null);
  // 🔴 The whole point of SUP-1 (b): the office cannot fill what nobody approved.
  ok('🔴 SUP-1: requested -> complete is REFUSED (the office cannot fill an unapproved request)',
    call(supplies.nextSupplyStatus, 'open', 'complete') === null);
  ok('🔴 SUP-1: requested -> submit is REFUSED (nothing goes to the supplier before it is approved)',
    call(supplies.nextSupplyStatus, 'open', 'submit') === null);
  ok('SUP-1: rejected -> complete is refused', call(supplies.nextSupplyStatus, 'rejected', 'complete') === null);
  ok('SUP-1: completed -> approve is refused', call(supplies.nextSupplyStatus, 'completed', 'approve') === null);
  ok('S131: reopen -> requested from approved, rejected and submitted; a COMPLETED order is final',
    call(supplies.nextSupplyStatus, 'rejected', 'reopen') === 'open' && call(supplies.nextSupplyStatus, 'approved', 'reopen') === 'open'
    && call(supplies.nextSupplyStatus, 'sent', 'reopen') === 'open' && call(supplies.nextSupplyStatus, 'completed', 'reopen') === null);

  const perm = supplies.SUPPLY_DECISION_PERMISSION || {};
  ok('SUP-9: approve and reject take supplies.approve', perm.approve === 'supplies.approve' && perm.reject === 'supplies.approve');
  ok('S131: submit, backorder, cancel a line, complete and reopen take supplies.manage (the Supply Manager)',
    ['submit', 'backorder', 'cancelLine', 'complete', 'reopen'].every((d) => perm[d] === 'supplies.manage'));
  ok('🔴 S131: delivering a line takes supplies.deliver (the driver; the Supply Manager too, by maySupplyDecide)', perm.deliver === 'supplies.deliver');
}

// ── the new permissions exist and are grouped (Settings → Roles) ──────────────
{
  ok('supplies.approve is a real permission key', !!PERMISSIONS['supplies.approve']);
  ok('supplies.approve defaults to the office tiers (S35 manager-full convention)',
    JSON.stringify(PERMISSIONS['supplies.approve']?.defaultRoles || []) === JSON.stringify(['owner', 'admin', 'manager']));
  const group = PERM_GROUPS.find((g) => g.id === 'supplies');
  ok('supplies.approve is in the Supplies group of the Roles matrix', !!group && group.keys.includes('supplies.approve'));
  // S3 (plan 2026-10-12): "Deliveries", given to anyone by a per-person grant (Alberto on a crew login).
  ok('🔴 S3: supplies.deliver is a real permission key, labelled Deliveries', !!PERMISSIONS['supplies.deliver']
    && /^Deliveries\b/.test(PERMISSIONS['supplies.deliver']?.label || ''));
  // The office tiers by the S35 full-access convention (a manager who lacked a key the Admin role
  // carries could no longer give Admin — canGiveRole); never crew by default: a driver on a crew
  // login gets it by a per-person grant.
  // S131: the supply manager runs deliveries too (their own key set: view, manage, deliver).
  ok('S3: supplies.deliver defaults to the office tiers and the supply manager, never crew (a grant gives it to anyone else)',
    JSON.stringify(PERMISSIONS['supplies.deliver']?.defaultRoles || []) === JSON.stringify(['owner', 'admin', 'manager', 'supply_manager']));
  ok('S3: supplies.deliver is in the Supplies group of the Roles matrix', !!group && group.keys.includes('supplies.deliver'));
}

// ── SUP-4: a price is OPTIONAL, and a priceless item costs nothing ────────────
{
  ok('SUP-4: a line with no price contributes 0 to the total',
    call(supplies.supplyLineTotal, { qty: 3, unitPrice: null }) === 0);
  ok('SUP-4: a priced line is settled to cents PER LINE (II.8)',
    call(supplies.supplyLineTotal, { qty: 3, unitPrice: 6.805 }) === 20.42);
  // 4 x 6.80 = 27.20 and 2 x 32.90 = 65.80, so 93.00 — the seeded open request's own figure.
  ok('a request total sums the per-line figures',
    call(supplies.supplyRequestTotal, { lines: [{ qty: 4, unitPrice: 6.80 }, { qty: 2, unitPrice: 32.90 }] }) === 93);
}

// ── the approval flow, executed (lib/supplyFlow) ──────────────────────────────
const flowState = () => ({
  currentUserId: SUP,
  users: [
    { id: OWNER, name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
    { id: OFFICE, name: 'Heather', role: 'admin', status: 'active', notificationPrefs: {} },
    { id: SUP, name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} },
    { id: CREW, name: 'Cleaner', role: 'crew', status: 'active', notificationPrefs: {} },
    { id: DRIVER, name: 'Alberto Reyes', role: 'crew', status: 'active', notificationPrefs: {} },
  ],
  clients: [{ id: 'cl1', name: 'Las Olas Medical', supervisorId: SUP }],
  permissions: [
    { id: 'supplies.approve', roles: ['owner', 'manager'] },
    { id: 'supplies.manage', roles: ['owner', 'admin'] },
  ],
  userPermissionOverrides: [{ userId: DRIVER, grants: ['supplies.deliver'], revokes: [] }],
  opsSettings: {},
  notifications: [],
  supplyRequests: [{
    id: 'sr1', clientId: 'cl1', requestedByUserId: SUP, status: 'open', note: '',
    lines: [{ itemId: 'si1', name: 'Toilet paper', qty: 2, unitPrice: 41.20 }],
    createdAt: '2026-09-20T12:00:00.000Z', completedAt: null, completedByUserId: null,
  }],
});
const NOW = '2026-09-29T15:00:00.000Z';

// SUP-13 (2026-10-05): the flow runs in the supplies route now — the PATCH a decision writes is
// lib/supplyFlow supplyDecisionPatch and the bell rows supplyDecisionNotifications, which the
// route writes into org_state. This section executes both, on the same story as before.
const decideOn = (s, decision, byUserId, reason) => {
  const r = s.supplyRequests[0];
  const d = call(supplyFlow.supplyDecisionPatch, r, decision, { byUserId, byName: s.users.find((u) => u.id === byUserId)?.name || null, reason, now: NOW });
  if (!d || d.refused) return null;
  const after = { ...r, ...d.patch };
  return {
    supplyRequests: [after],
    notifications: call(supplyFlow.supplyDecisionNotifications, s, { request: after, decision, actorUserId: byUserId }) || [],
  };
};
{
  const s = flowState();
  const bad = decideOn(s, 'complete', OFFICE);
  ok('🔴 SUP-1: completing a REQUESTED request is refused at the write point (not just in the UI)', bad === null);

  const approved = decideOn(s, 'approve', SUP);
  ok('SUP-1: approving stamps status / approvedAt / approvedByUserId',
    !!approved && approved.supplyRequests[0].status === 'approved'
    && approved.supplyRequests[0].approvedAt === NOW
    && approved.supplyRequests[0].approvedByUserId === SUP);
  // The OFFICE is told on approval — "then the office fills".
  const officeRows = (approved?.notifications || []).filter((n) => n.eventKey === 'supplyRequestApproved');
  ok('SUP-1: approval notifies the OFFICE (supplies.manage holders), not the requester',
    officeRows.length > 0 && officeRows.every((n) => n.userId === OWNER || n.userId === OFFICE));
  ok('SUP-1: the approver is not notified of their own approval',
    !(approved?.notifications || []).some((n) => n.eventKey === 'supplyRequestApproved' && n.userId === SUP));

  // ...and only THEN does the Supply Manager submit it, the lines arrive, and it is completed (S131).
  const afterApprove = { ...s, supplyRequests: (approved || {}).supplyRequests || s.supplyRequests, notifications: [] };
  ok('🔴 S131: an approved order is not completed before it is submitted', decideOn(afterApprove, 'complete', OFFICE) === null);
  const submitted = decideOn(afterApprove, 'submit', OFFICE);
  ok('S131: the Supply Manager submits an APPROVED order — who and when, every line pending, no quantities',
    !!submitted && submitted.supplyRequests[0].status === 'sent' && submitted.supplyRequests[0].sentByUserId === OFFICE
    && submitted.supplyRequests[0].sentAt === NOW && submitted.supplyRequests[0].fulfillmentState === 'pending'
    && Array.isArray(submitted.supplyRequests[0].fulfillment) && submitted.supplyRequests[0].sentLines == null);
  ok('S131: a submit tells nobody (both screens show it)', (submitted?.notifications || []).length === 0);
  const afterSubmit = { ...s, supplyRequests: (submitted || {}).supplyRequests || s.supplyRequests, notifications: [] };
  ok('🔴 S131: Mark Completed is refused while a line is still to come',
    call(supplyFlow.supplyDecisionPatch, afterSubmit.supplyRequests[0], 'complete', { now: NOW })?.refused === 'lines_open');
  const fp = call(supplyFlow.supplyFulfillPatch, afterSubmit.supplyRequests[0], [{ line: 0, act: 'deliver' }],
    { byUserId: DRIVER, byName: 'Alberto Reyes', via: 'driver', now: NOW, todayKey: '2026-09-29' });
  const delivered = fp && fp.patch ? { ...afterSubmit.supplyRequests[0], ...fp.patch } : null;
  ok('S131: the driver delivers the line (the per-line record, via the driver)', !!delivered && delivered.fulfillmentState === 'ready'
    && delivered.fulfillment[0].deliveries[0].via === 'driver' && delivered.status === 'sent');
  const dRows = delivered ? call(supplyFlow.supplyFulfillNotifications, afterSubmit, { request: delivered, applied: fp.applied, actorUserId: DRIVER }) || [] : [];
  ok('🔴 S131: the delivery tells the person who asked (and the account manager), never the driver who did it',
    dRows.some((n) => n.eventKey === 'supplyItemsDelivered' && n.userId === SUP) && !dRows.some((n) => n.userId === DRIVER));
  const done = delivered ? decideOn({ ...s, supplyRequests: [delivered], notifications: [] }, 'complete', OFFICE) : null;
  ok('S131: then the Supply Manager marks it COMPLETED', !!done && done.supplyRequests[0].status === 'completed'
    && done.supplyRequests[0].completedByUserId === OFFICE);
  ok('SUP-1: completing KEEPS the approval stamps (who approved the spend) and who submitted it',
    !!done && done.supplyRequests[0].approvedByUserId === SUP && done.supplyRequests[0].sentByUserId === OFFICE);
  ok('S131: completing tells the person who asked and the account manager (here, the same person: once)',
    (done?.notifications || []).filter((n) => n.eventKey === 'supplyOrderCompleted' && n.userId === SUP).length === 1);
}
{
  const s = flowState();
  ok('🔴 SUP-1: a rejection with NO reason is refused ("rejected with a reason")', decideOn(s, 'reject', SUP) === null);
  ok('SUP-1: a whitespace-only reason is refused too', decideOn(s, 'reject', SUP, '   ') === null);

  const rejected = decideOn(s, 'reject', OWNER, 'Ordered last week');
  ok('SUP-1: rejecting stamps the reason and who rejected it',
    !!rejected && rejected.supplyRequests[0].status === 'rejected'
    && rejected.supplyRequests[0].rejectionReason === 'Ordered last week'
    && rejected.supplyRequests[0].rejectedByUserId === OWNER);
  const note = (rejected?.notifications || []).find((n) => n.eventKey === 'supplyOrderDeclined');
  ok('SUP-1: a decline notifies the REQUESTER and carries the reason',
    !!note && note.userId === SUP && /Ordered last week/.test(renderText(note.body, 'en') || ''));

  // Reopening clears what it left behind.
  const afterReject = { ...s, supplyRequests: (rejected || {}).supplyRequests || s.supplyRequests, notifications: [] };
  const reopened = decideOn(afterReject, 'reopen', OFFICE);
  ok('SUP-1: reopening clears the rejection stamps (no stale reason on a live request)',
    !!reopened && reopened.supplyRequests[0].status === 'open'
    && reopened.supplyRequests[0].rejectionReason === null
    && reopened.supplyRequests[0].rejectedByUserId === null);
}
{
  // Submit routes to the APPROVER, not the whole office (SUP-1 b changed this).
  const s = flowState();
  const req = s.supplyRequests[0];
  const rows = call(supplyFlow.supplySubmitNotifications, { ...s, currentUserId: OWNER }, req, { actorUserId: OWNER });
  const submitted = (rows || []).filter((n) => n.eventKey === 'supplyRequestSubmitted');
  ok('SUP-9 ★a: a submitted request notifies the BUILDING\'S SUPERVISOR by default',
    submitted.length === 1 && submitted[0].userId === SUP);

  // S131 (plan §1): the building's ACCOUNT MANAGER approves first; the Operations setting names the
  // approver only for a building with none.
  const named = { ...s, currentUserId: OWNER, opsSettings: { supplyApproverUserId: OWNER } };
  ok('🔴 S131: with a named approver the building\'s own account manager still approves',
    call(notifications.resolveSupplyApprover, named, 'cl1')?.id === SUP);
  const noManager = { ...named, clients: [{ id: 'cl1', name: 'Las Olas Medical', supervisorId: null }] };
  ok('S131: the named approver approves for a building with NO account manager',
    call(notifications.resolveSupplyApprover, noManager, 'cl1')?.id === OWNER);
  ok('SUP-9: with no setting the approver IS the building\'s supervisor',
    call(notifications.resolveSupplyApprover, s, 'cl1')?.id === SUP);
  const gone = { ...noManager, opsSettings: { supplyApproverUserId: OFFICE }, users: s.users.map((u) => (u.id === OFFICE ? { ...u, status: 'disabled' } : u)) };
  ok('SUP-9: a named approver who is no longer active resolves to nobody (never auto-approved)',
    call(notifications.resolveSupplyApprover, gone, 'cl1') === null);
}

// ── SUP-5 / CS-191: usage counted AT DELIVERY ────────────────────────────────
const usageRequests = [
  // delivered inside the window
  { id: 'a', clientId: 'cl1', status: 'completed', completedAt: '2026-09-10T12:00:00.000Z', createdAt: '2026-08-01T12:00:00.000Z',
    lines: [{ name: 'Toilet paper', qty: 2, unitPrice: 41.20 }, { name: 'Paper towels', qty: 1, unitPrice: 28.40 }] },
  { id: 'b', clientId: 'cl1', status: 'completed', completedAt: '2026-09-20T12:00:00.000Z', createdAt: '2026-09-19T12:00:00.000Z',
    lines: [{ name: 'Toilet paper', qty: 3, unitPrice: 42.00 }] },
  // submitted in the window but NOT delivered — must not count (SUP-5 a)
  { id: 'c', clientId: 'cl1', status: 'approved', completedAt: null, createdAt: '2026-09-21T12:00:00.000Z',
    lines: [{ name: 'Toilet paper', qty: 99, unitPrice: 41.20 }] },
  // delivered, but another building
  { id: 'd', clientId: 'cl2', status: 'completed', completedAt: '2026-09-11T12:00:00.000Z', createdAt: '2026-09-01T12:00:00.000Z',
    lines: [{ name: 'Toilet paper', qty: 7, unitPrice: 41.20 }] },
  // delivered outside the window
  { id: 'e', clientId: 'cl1', status: 'completed', completedAt: '2026-06-01T12:00:00.000Z', createdAt: '2026-05-01T12:00:00.000Z',
    lines: [{ name: 'Toilet paper', qty: 5, unitPrice: 41.20 }] },
];
const WIN = { clientId: 'cl1', fromMs: Date.parse('2026-09-01T04:00:00.000Z'), toMs: Date.parse('2026-09-30T23:59:59.999Z') };
{
  const rows = call(supplies.supplyUsageByItem, usageRequests, WIN) || [];
  const tp = rows.find((r) => r.name === 'Toilet paper');
  ok('🔴 SUP-5 / CS-191: an item counts only when DELIVERED — 2 + 3, never the approved 99',
    !!tp && tp.qty === 5);
  ok('SUP-5: usage is scoped to the building', !!tp && !rows.some((r) => r.qty === 7));
  ok('SUP-5: usage is scoped to the window (the June delivery is out)', !!tp && tp.qty !== 10);
  ok('SUP-5: each item\'s spend uses the SNAPSHOTTED prices (2×41.20 + 3×42.00)',
    !!tp && tp.total === 208.40);
  ok('SUP-5: an item delivered on two requests counts 2 deliveries', !!tp && tp.requests === 2);
  ok('SUP-5: the price shown is the latest delivered one', !!tp && tp.unitPrice === 42.00);
  ok('SUP-5: every delivered item appears', rows.some((r) => r.name === 'Paper towels' && r.qty === 1));
  ok('SUP-5: rows come back biggest spend first', rows.length >= 2 && rows[0].name === 'Toilet paper');
}

// ── SUP-7 / SUP-10: the monthly budget and the flag ──────────────────────────
{
  ok('SUP-7: a blank / zero / negative budget means NO budget (never a budget of zero)',
    call(supplies.supplyBudgetFor, {}) === null
    && call(supplies.supplyBudgetFor, { supplyBudgetMonthly: 0 }) === null
    && call(supplies.supplyBudgetFor, { supplyBudgetMonthly: -5 }) === null);
  ok('SUP-7: a set budget reads back in dollars', call(supplies.supplyBudgetFor, { supplyBudgetMonthly: 250 }) === 250);
  ok('SUP-7: with no budget an account is NEVER flagged', call(supplies.isOverSupplyBudget, 9999, null) === false);
  ok('SUP-7: landing exactly ON the budget is not over it', call(supplies.isOverSupplyBudget, 250, 250) === false);
  ok('SUP-7: a cent above the budget IS over it', call(supplies.isOverSupplyBudget, 250.01, 250) === true);

  const client = { id: 'cl1', supplyBudgetMonthly: 200 };
  const st = call(supplies.supplyBudgetStatus, client, usageRequests, { fromMs: WIN.fromMs, toMs: WIN.toMs });
  ok('🔴 SUP-7: spend is the sum of the DELIVERED requests\' snapshotted line totals',
    !!st && st.spend === 236.80);
  ok('SUP-7: over budget flags the account', !!st && st.over === true);
  ok('SUP-7: the remaining figure is budget − spend', !!st && st.remaining === -36.80);
  const under = call(supplies.supplyBudgetStatus, { id: 'cl1', supplyBudgetMonthly: 500 }, usageRequests, { fromMs: WIN.fromMs, toMs: WIN.toMs });
  ok('SUP-7: under budget is not flagged', !!under && under.over === false && under.remaining === 263.20);
}

// ── SUP-8 / CS-380: the monthly order reminder ───────────────────────────────
const reminderClients = [
  { id: 'cl_a', name: 'Alpha Tower', supervisorId: SUP },                                  // org default day
  { id: 'cl_b', name: 'Bravo Plaza', supervisorId: SUP, supplyOrderDayOfMonth: 20 },        // its own day
  { id: 'cl_seed_x', name: 'Seeded', supervisorId: SUP },                                   // CS-030 skip
  // CS-683: Inactive as the status menu and the import WRITE it (statusOverride). This fixture used the
  // retired `status` field, so the suite stayed green while a building set Inactive in the app kept
  // getting reminded.
  { id: 'cl_c', name: 'Charlie Centre', supervisorId: SUP, statusOverride: 'inactive' },     // not a live account
];
const SETTINGS_DAY10 = { supplyOrderDayOfMonth: 10 };
const at = (iso) => Date.parse(iso);
const kindsFor = (opts) => (call(opsAlerts.getDueSupplyAlerts, { tz: ORG_TZ, ...opts }) || []).map((a) => `${a.kind}:${a.clientId}`);
{
  ok('SUP-8: the org default order day is the 1st, capped per building at the 28th',
    supplies.DEFAULT_SUPPLY_ORDER_DAY === 1 && supplies.MAX_SUPPLY_ORDER_DAY === 28);
  ok('SUP-8: a building\'s own order day wins over the org default',
    call(supplies.supplyOrderDayFor, { supplyOrderDayOfMonth: 20 }, SETTINGS_DAY10) === 20
    && call(supplies.supplyOrderDayFor, {}, SETTINGS_DAY10) === 10);
  ok('SUP-8: a day past the 28th is clamped, so every month actually has it',
    call(supplies.supplyOrderDayFor, { supplyOrderDayOfMonth: 31 }, SETTINGS_DAY10) === 28);

  // The 9th: before either building's day → nothing.
  ok('SUP-8: nothing is due BEFORE the order day',
    kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-09T16:00:00Z'), settings: SETTINGS_DAY10 })
      .filter((k) => k.startsWith('supplyOrder')).length === 0);

  // The 10th: Alpha's day, nothing submitted → the SUPERVISOR only.
  const day10 = kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-10T16:00:00Z'), settings: SETTINGS_DAY10 });
  ok('🔴 SUP-8 / CS-380: on the order day with nothing submitted, the supervisor is reminded',
    day10.includes('supplyOrderDue:cl_a'));
  ok('SUP-8: the office is NOT told on the day itself', !day10.includes('supplyOrderOverdue:cl_a'));
  ok('SUP-8: a building whose own day has not arrived is not reminded', !day10.includes('supplyOrderDue:cl_b'));
  ok('CS-030: a seeded account raises no supply reminder', !day10.some((k) => k.includes('cl_seed_x')));
  ok('SUP-8: an inactive account raises no supply reminder', !day10.some((k) => k.includes('cl_c')));

  // The 11th: still nothing → the OFFICE too, the supervisor having been reminded on the 10th.
  const toldOn10 = { firedIds: new Set(['oa_supplyOrderDue_cl_a_2026-09']), firedAt: new Map([['oa_supplyOrderDue_cl_a_2026-09', '2026-09-10T16:00:00.000Z']]) };
  const day11 = kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10, ...toldOn10 });
  ok('🔴 SUP-8: the day AFTER, with still nothing, the office is told',
    day11.includes('supplyOrderOverdue:cl_a'));

  // 🔴 CS-953: a building first walked AFTER its order day (entered, or given its manager, late)
  // reminds its supervisor and NOT the office in the same run; the office hears the day after.
  const late = kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-27T20:50:00Z'), settings: SETTINGS_DAY10 });
  ok('🔴 CS-953: a building entered after its order day reminds its supervisor',
    late.includes('supplyOrderDue:cl_a'));
  ok('🔴 CS-953: …and does NOT tell the office in the same run',
    !late.includes('supplyOrderOverdue:cl_a'));
  const lateId = 'oa_supplyOrderDue_cl_a_2026-09';
  const toldAt = (iso) => ({ firedIds: new Set([lateId]), firedAt: new Map([[lateId, iso]]) });
  ok('🔴 CS-953: the supervisor told earlier the SAME org day: the office still waits',
    !kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-28T03:50:00Z'), settings: SETTINGS_DAY10, ...toldAt('2026-09-27T20:50:00.000Z') })
      .includes('supplyOrderOverdue:cl_a'));
  ok('🔴 CS-953: the next org day, with still nothing, the office is told',
    kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-28T04:30:00Z'), settings: SETTINGS_DAY10, ...toldAt('2026-09-27T20:50:00.000Z') })
      .includes('supplyOrderOverdue:cl_a'));
  ok('CS-953: the day is the ORG\'s: told at 11 PM New York, the office hears after midnight there',
    kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-28T04:05:00Z'), settings: SETTINGS_DAY10, ...toldAt('2026-09-28T03:00:00.000Z') })
      .includes('supplyOrderOverdue:cl_a'));
  ok('CS-953: last month\'s supervisor reminder does not open this month\'s office alert',
    !kindsFor({ clients: reminderClients, requests: [], now: at('2026-10-27T16:00:00Z'), settings: SETTINGS_DAY10, ...toldAt('2026-09-27T20:50:00.000Z') })
      .includes('supplyOrderOverdue:cl_a'));
  ok('CS-953: a raised marker with no time never silences the office',
    kindsFor({ clients: reminderClients, requests: [], now: at('2026-09-28T16:00:00Z'), settings: SETTINGS_DAY10, firedIds: new Set([lateId]) })
      .includes('supplyOrderOverdue:cl_a'));

  // A request submitted this month silences both, whatever state it is in.
  const submitted = [{ id: 'x', clientId: 'cl_a', status: 'open', createdAt: '2026-09-02T16:00:00Z', completedAt: null, lines: [] }];
  ok('SUP-8: a request SUBMITTED this month silences the reminder',
    !kindsFor({ clients: reminderClients, requests: submitted, now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10 })
      .some((k) => k.includes('cl_a')));
  const rejectedOnly = [{ id: 'x', clientId: 'cl_a', status: 'rejected', createdAt: '2026-09-02T16:00:00Z', rejectedAt: '2026-09-03T16:00:00Z', lines: [] }];
  ok('SUP-8: a REJECTED request still counts as "they ordered" — the supervisor did their part',
    !kindsFor({ clients: reminderClients, requests: rejectedOnly, now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10 })
      .some((k) => k.includes('cl_a')));
  // LAST month's request does not silence THIS month.
  const lastMonth = [{ id: 'x', clientId: 'cl_a', status: 'completed', createdAt: '2026-08-02T16:00:00Z', completedAt: '2026-08-03T16:00:00Z', lines: [] }];
  ok('SUP-8: last month\'s order does not silence this month',
    kindsFor({ clients: reminderClients, requests: lastMonth, now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10 })
      .includes('supplyOrderDue:cl_a'));

  // The marker is the once-only guard, and it carries the month.
  const first = call(opsAlerts.getDueSupplyAlerts, { clients: reminderClients, requests: [], now: at('2026-09-10T16:00:00Z'), settings: SETTINGS_DAY10, tz: ORG_TZ }) || [];
  const firstAt = new Map(first.map((a) => [a.id, '2026-09-10T16:00:00.000Z']));
  const second = call(opsAlerts.getDueSupplyAlerts, { clients: reminderClients, requests: [], now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10, firedIds: new Set(firstAt.keys()), firedAt: firstAt, tz: ORG_TZ }) || [];
  const fired = new Set([...first, ...second].map((a) => a.id));
  ok('SUP-8: with its marker present the same reminder does NOT fire again',
    (call(opsAlerts.getDueSupplyAlerts, { clients: reminderClients, requests: [], now: at('2026-09-12T16:00:00Z'), settings: SETTINGS_DAY10, firedIds: fired, firedAt: firstAt, tz: ORG_TZ }) || []).length === 0);
  ok('SUP-8: the marker id carries the month, so next month fires again',
    (call(opsAlerts.getDueSupplyAlerts, { clients: reminderClients, requests: [], now: at('2026-10-12T16:00:00Z'), settings: SETTINGS_DAY10, firedIds: fired, tz: ORG_TZ }) || [])
      .some((a) => a.kind === 'supplyOrderDue' && a.clientId === 'cl_a'));
  ok('SUP-8: the reminder routes to the supervisor and the escalation to the office',
    first.find((a) => a.kind === 'supplyOrderDue')?.recipientScope === 'supervisor'
    && second.find((a) => a.kind === 'supplyOrderOverdue')?.recipientScope === 'office');
}

// ── SUP-10 ★a: the over-budget alert, once per calendar month, to the approver ──
{
  const budgeted = [{ id: 'cl_a', name: 'Alpha Tower', supervisorId: SUP, supplyBudgetMonthly: 100 }];
  const overspend = [
    { id: 'p', clientId: 'cl_a', status: 'completed', createdAt: '2026-09-02T16:00:00Z', completedAt: '2026-09-05T16:00:00Z', lines: [{ name: 'TP', qty: 3, unitPrice: 41.20 }] },
  ];
  const due = call(opsAlerts.getDueSupplyAlerts, { clients: budgeted, requests: overspend, now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10, tz: ORG_TZ }) || [];
  const over = due.find((a) => a.kind === 'supplyBudgetExceeded');
  ok('🔴 SUP-10 ★a: passing the month\'s budget raises one alert for the building', !!over && over.clientId === 'cl_a');
  ok('SUP-10: the over-budget alert goes to the APPROVER', !!over && over.recipientScope === 'approver');
  ok('SUP-10: it carries the budget and the spend for the copy', !!over && over.budget === 100 && over.spend === 123.60);
  const fired = new Set(due.map((a) => a.id));
  ok('🔴 SUP-10: it alerts ONCE per month, not on every cron run',
    !(call(opsAlerts.getDueSupplyAlerts, { clients: budgeted, requests: overspend, now: at('2026-09-20T16:00:00Z'), settings: SETTINGS_DAY10, firedIds: fired, tz: ORG_TZ }) || [])
      .some((a) => a.kind === 'supplyBudgetExceeded'));
  ok('SUP-10: a NEW month gets its own alert',
    (call(opsAlerts.getDueSupplyAlerts, { clients: budgeted, requests: [{ ...overspend[0], createdAt: '2026-10-02T16:00:00Z', completedAt: '2026-10-05T16:00:00Z' }], now: at('2026-10-11T16:00:00Z'), settings: SETTINGS_DAY10, firedIds: fired, tz: ORG_TZ }) || [])
      .some((a) => a.kind === 'supplyBudgetExceeded'));
  // Last month's overspend must not flag this month.
  ok('SUP-10: the period is the CALENDAR month — last month\'s spend does not flag this one',
    !(call(opsAlerts.getDueSupplyAlerts, { clients: budgeted, requests: overspend, now: at('2026-10-11T16:00:00Z'), settings: SETTINGS_DAY10, tz: ORG_TZ }) || [])
      .some((a) => a.kind === 'supplyBudgetExceeded'));
  // A delivery just before the org-zone month boundary belongs to the earlier month
  // (2026-10-01T02:00Z is still Sept 30, 22:00 in New York).
  const edge = [{ id: 'p', clientId: 'cl_a', status: 'completed', createdAt: '2026-09-30T16:00:00Z', completedAt: '2026-10-01T02:00:00Z', lines: [{ name: 'TP', qty: 3, unitPrice: 41.20 }] }];
  ok('🔴 SUP-10: months are the ORG\'s calendar months, not UTC\'s',
    !(call(opsAlerts.getDueSupplyAlerts, { clients: budgeted, requests: edge, now: at('2026-10-11T16:00:00Z'), settings: SETTINGS_DAY10, tz: ORG_TZ }) || [])
      .some((a) => a.kind === 'supplyBudgetExceeded'));
  // S5 (plan 2026-10-12): spend is what was SENT. Three asked for ($123.60), one sent ($41.20):
  // under the $100 budget, so no alert — and the budget status reads the same figure.
  const partly = [{ ...overspend[0], sentLines: [{ itemId: null, qtySent: 1 }] }];
  ok('🔴 S5: the over-budget alert counts what was SENT, not what was asked',
    !(call(opsAlerts.getDueSupplyAlerts, { clients: budgeted, requests: partly, now: at('2026-09-11T16:00:00Z'), settings: SETTINGS_DAY10, tz: ORG_TZ }) || [])
      .some((a) => a.kind === 'supplyBudgetExceeded'));
  const sentStatus = call(supplies.supplyBudgetStatus, budgeted[0], partly, { fromMs: at('2026-09-01T04:00:00Z'), toMs: at('2026-09-30T23:59:59Z') });
  ok('S5: the budget status spends the sent value', !!sentStatus && sentStatus.spend === 41.2 && sentStatus.over === false);
}

// ── the alert copy and the marker retention ──────────────────────────────────
{
  const c1 = call(opsAlertCopy.opsAlertCopy, { kind: 'supplyOrderDue', clientId: 'cl_a', orderDay: 1 }, 'Alpha Tower');
  ok('the order reminder names the building and its day', !!c1 && /Alpha Tower/.test(c1.title) && /1st/.test(c1.body));
  const c2 = call(opsAlertCopy.opsAlertCopy, { kind: 'supplyBudgetExceeded', clientId: 'cl_a', budget: 100, spend: 123.6 }, 'Alpha Tower');
  ok('the over-budget alert names both figures', !!c2 && /\$123\.60/.test(c2.body) && /\$100/.test(c2.body));
  const c3 = call(opsAlertCopy.opsAlertCopy, { kind: 'supplyOrderOverdue', clientId: 'cl_a', orderDay: 22 }, 'Alpha Tower');
  ok('the ordinal reads as a date, not a count', !!c3 && /22nd/.test(c3.body));

  // 🔴 A MONTHLY marker must outlive the 48-hour shift horizon, or a 5-minute cron re-sends
  // the same reminder for the rest of the month (the bug the inspection reminder hit).
  const markerState = {
    users: [{ id: SUP, name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} }],
    clients: [{ id: 'cl_a', name: 'Alpha Tower', supervisorId: SUP }],
    permissions: [], userPermissionOverrides: [], opsSettings: {}, notifications: [],
    opsAlertEvents: [{ id: 'oa_supplyOrderDue_cl_a_2026-09', kind: 'supplyOrderDue', clientId: 'cl_a', jobId: null, firedAt: '2026-09-10T16:00:00.000Z' }],
  };
  const applied = call(opsAlertApply.applyOpsAlert, markerState,
    { id: 'oa_inspectionDue_other', kind: 'inspectionDue', recipientScope: 'supervisor', clientId: 'cl_other', title: 't', body: 'b', url: '/' },
    { now: at('2026-09-25T16:00:00Z') });
  ok('🔴 SUP-8: a supply marker survives 15 days (the 48h shift horizon would have dropped it)',
    !!applied && applied.opsAlertEvents.some((e) => e.id === 'oa_supplyOrderDue_cl_a_2026-09'));
  ok('the supply marker retention ceiling is well past a month',
    opsAlertApply.SUPPLY_MARKER_MAX_DAYS >= 32);

  // Only the NEWEST supply marker per building per kind is kept.
  const twoMonths = {
    ...markerState,
    opsAlertEvents: [
      { id: 'oa_supplyOrderDue_cl_a_2026-08', kind: 'supplyOrderDue', clientId: 'cl_a', jobId: null, firedAt: '2026-08-10T16:00:00.000Z' },
      { id: 'oa_supplyOrderDue_cl_a_2026-09', kind: 'supplyOrderDue', clientId: 'cl_a', jobId: null, firedAt: '2026-09-10T16:00:00.000Z' },
    ],
  };
  const pruned = call(opsAlertApply.applyOpsAlert, twoMonths,
    { id: 'oa_supplyOrderDue_cl_b_2026-09', kind: 'supplyOrderDue', recipientScope: 'supervisor', clientId: 'cl_b', title: 't', body: 'b', url: '/' },
    { now: at('2026-09-25T16:00:00Z') });
  ok('SUP-8: only the newest supply marker per building per kind is kept (bounded at one)',
    !!pruned && pruned.opsAlertEvents.filter((e) => e.kind === 'supplyOrderDue' && e.clientId === 'cl_a').length === 1
    && pruned.opsAlertEvents.some((e) => e.id === 'oa_supplyOrderDue_cl_a_2026-09'));
}

// ── the office reminder reaches the office, the budget alert the approver ─────
{
  const s = {
    users: [
      { id: OWNER, name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
      { id: OFFICE, name: 'Heather', role: 'admin', status: 'active', notificationPrefs: {} },
      { id: SUP, name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} },
    ],
    clients: [{ id: 'cl_a', name: 'Alpha Tower', supervisorId: SUP }],
    permissions: [{ id: 'supplies.manage', roles: ['owner', 'admin'] }, { id: 'supplies.approve', roles: ['owner', 'manager'] }],
    userPermissionOverrides: [], opsSettings: {}, notifications: [], opsAlertEvents: [],
  };
  const office = call(opsAlertApply.applyOpsAlert, s,
    { id: 'oa_supplyOrderOverdue_cl_a_2026-09', kind: 'supplyOrderOverdue', recipientScope: 'office', clientId: 'cl_a', title: 't', body: 'b', url: '/supplies' },
    { now: at('2026-09-11T16:00:00Z') });
  const officeIds = (office?.notifications || []).map((n) => n.userId).sort();
  ok('SUP-8: the overdue reminder reaches the supplies.manage holders, not the supervisor',
    JSON.stringify(officeIds) === JSON.stringify([OFFICE, OWNER].sort()));

  const toApprover = call(opsAlertApply.applyOpsAlert, s,
    { id: 'oa_supplyBudgetExceeded_cl_a_2026-09', kind: 'supplyBudgetExceeded', recipientScope: 'approver', clientId: 'cl_a', title: 't', body: 'b', url: '/supplies' },
    { now: at('2026-09-11T16:00:00Z') });
  ok('SUP-10: the over-budget alert reaches the approver alone',
    (toApprover?.notifications || []).length === 1 && toApprover.notifications[0].userId === SUP);
}

// ── the SERVER guard on the shared record (api/_lib/orgStateGuard.js) ───────────
// SUP-13 (2026-10-05): requests left org_state, so WHO may submit, approve, reject, fill or cancel
// one is decided by /api/supplies now (test-supplies-route.mjs drives it per role). What the
// org_state guard still holds is a building's SUPPLY SETTINGS — and the two RETIRED slices, which
// no browser save may change in either direction (restoreRetiredSlices).
const NOTHING_OWED = { removal: { payState: {}, recentHours: new Set() } };
const gbase = () => ({
  users: [
    { id: OWNER, role: 'owner', status: 'active', name: 'Owner' },
    { id: OFFICE, role: 'admin', status: 'active', name: 'Office' },
    { id: SUP, role: 'manager', status: 'active', name: 'Supervisor' },
    { id: CREW, role: 'crew', status: 'active', name: 'Crew' },
  ],
  permissions: [
    { id: 'supplies.approve', roles: ['owner', 'manager'] },
    { id: 'supplies.manage', roles: ['owner', 'admin'] },
    { id: 'supplies.request', roles: ['owner', 'admin', 'manager'] },
  ],
  userPermissionOverrides: [],
  sites: [], clients: [{ id: 'cl1', name: 'Alpha' }],
  company: { id: 'co', name: 'Clean Space', timezone: ORG_TZ },
  supplyRequests: [
    { id: 'sr_req', clientId: 'cl1', requestedByUserId: SUP, status: 'open', lines: [{ name: 'TP', qty: 1, unitPrice: 41.2 }], createdAt: '2026-09-20T12:00:00.000Z' },
  ],
});
const gedit = (fn) => { const s = gbase(); fn(s); return s; };
const violations = (next, role, self) => call(guard.protectedFieldViolations, gbase(), next, role, self, NOTHING_OWED) || [];
const refused = (next, role, self) => violations(next, role, self).length > 0;
{
  // The budget itself is money the office sets — a crew save must not raise it.
  const rebudget = gedit((s) => { s.clients[0].supplyBudgetMonthly = 99999; });
  ok('🔴 guard: CREW cannot set a building\'s supply budget', refused(rebudget, 'crew', CREW));
  ok('guard: the office CAN set a building\'s supply budget', !refused(rebudget, 'admin', OFFICE));
  ok('🔴 guard: the fingerprint moves when a supply budget changes',
    call(guard.protectedFingerprint, gbase()) !== call(guard.protectedFingerprint, rebudget));
  // The request rules are no longer the blob guard's: a status change in the blob is not judged
  // here (the route is the boundary), and the retired slice is put back instead (below).
  const approve = gedit((s) => { s.supplyRequests[0].status = 'completed'; });
  ok('SUP-13: the blob guard no longer judges a request\'s status (the supplies route does)',
    !violations(approve, 'admin', OFFICE).some((v) => /supply request/.test(v)));
}

// ── 🔴 SUP-13: the retired slices are the server's (restoreRetiredSlices) ─────────
// An installed PWA runs a stale bundle for weeks: its reducer still writes supplyRequests. No
// save may change the two keys — kept while the committed blob holds them, dropped once
// supplies-move.mjs --strip has removed them. Put back, never refused (a 403 drops every other
// edit in the batch).
{
  const committed = gbase();
  const stale = gedit((s) => {
    s.supplyRequests.push({ id: 'sr_stale', clientId: 'cl1', status: 'open', lines: [] });
    s.supplyItems = [{ id: 'si_stale', clientId: 'cl1', name: 'TP' }];
  });
  const out = call(guard.restoreRetiredSlices, committed, stale);
  ok('🔴 SUP-13: a stale bundle\'s supply edits are put back to the committed value (not committed, not refused)',
    !!out && out.changed === true
    && JSON.stringify(stale.supplyRequests) === JSON.stringify(committed.supplyRequests)
    && !('supplyItems' in stale));
  const fresh = gedit((s) => { delete s.supplyRequests; });
  const kept = call(guard.restoreRetiredSlices, committed, fresh);
  ok('🔴 SUP-13: a bundle that never had the keys does NOT erase them before the move (kept from the commit)',
    !!kept && kept.changed === true && JSON.stringify(fresh.supplyRequests) === JSON.stringify(committed.supplyRequests));
  const stripped = gedit((s) => { delete s.supplyRequests; });
  const afterStrip = gedit((s) => { s.supplyRequests = [{ id: 'sr_late', clientId: 'cl1', status: 'open', lines: [] }]; });
  call(guard.restoreRetiredSlices, stripped, afterStrip);
  ok('🔴 SUP-13: after --strip a stale bundle cannot put the keys back',
    !('supplyRequests' in afterStrip) && !('supplyItems' in afterStrip));
  const same = gbase();
  ok('SUP-13: an untouched save is left exactly as it is', call(guard.restoreRetiredSlices, gbase(), same)?.changed === false);
  ok('🔴 SUP-13: the fingerprint moves when a stale bundle touches a retired slice (so the restore runs)',
    call(guard.protectedFingerprint, committed) !== call(guard.protectedFingerprint, gedit((s) => { s.supplyRequests[0].status = 'approved'; })));
  ok('SUP-13: both retired slices are on the protected read (the committed values are in hand)',
    /supplyItems:state->supplyItems/.test(guard.PROTECTED_SELECT || '') && /supplyRequests:state->supplyRequests/.test(guard.PROTECTED_SELECT || ''));
}

// ── CS-596 (WHO) + CS-670 (WHEN): cancelling a supply request ───────────────────
// WHO is Daniel's CS-596 decision (2026-09-30): your own request while it waits; the building's
// approver and the office, any. WHEN is CS-670 (Daniel, 2026-10-12: no cancels once an order has
// gone out): only while it is requested or approved. Sent, it is on the van and the cleaners see
// it coming; delivered, it is usage, spend and the budget's history; rejected, a settled record —
// the office's Reopen (recorded) is the correction. The route judges each cancel with this pure
// rule (test-supplies-route.mjs §3 and §19 drive it per role); the Cancel BUTTON reads it too, so a
// button can never offer a cancel the server would refuse.
{
  const OTHER = 'u_other_mgr';
  const req = { id: 'x', clientId: 'cl1', requestedByUserId: SUP, status: 'open' };
  const appr = { ...req, status: 'approved' };
  const sent = { ...req, status: 'sent' };
  const done = { ...req, status: 'completed' };
  const rej = { ...req, status: 'rejected' };
  const may = (request, o) => call(supplies.maySupplyCancel, { request, ...o });
  // Each caller as the screens and the route hand them in: the approver (the building's account
  // manager) and the owner hold supplies.approve by default; OFFICE is supplies.manage WITHOUT it.
  const approver = { selfId: OTHER, role: 'manager', approverId: OTHER, holdsApprove: true };
  const office = { selfId: OFFICE, role: 'admin', holdsManage: true };
  const officeApprover = { ...office, holdsApprove: true };
  const owner = { selfId: OWNER, role: 'owner', holdsApprove: true };
  const requester = { selfId: SUP, role: 'manager', holdsRequest: true };
  // S131: the Supply Manager (its own role, supplies.manage + deliver, never supplies.approve) and the
  // approver's operations manager (users[].opsManagerId — Daniel's answer 3: an OM acts like their AMs).
  const sm = { selfId: 'u_sm', role: 'supply_manager', holdsManage: true };
  const om = { selfId: 'u_om', role: 'manager', approverId: OTHER, approverOpsManagerId: 'u_om', holdsApprove: true };
  ok('CS-596: the requester may cancel their own request while it waits — not once it is approved',
    may(req, requester) === true && may(appr, requester) === false);
  ok('CS-596: … and never someone else\'s', may(req, { selfId: OTHER, role: 'manager', holdsRequest: true }) === false);
  ok('CS-596: the building\'s approver, and the owner or an admin holding supplies.approve, may cancel a request that has not gone out (requested or approved)',
    [req, appr].every((r) => may(r, approver) === true && may(r, officeApprover) === true && may(r, owner) === true));
  // 🔴 THE CANCEL GAP (S131 Wave 2, brief A; found by Builder S): a cancel DELETES the order, and
  // supplies.manage alone — now the Supply Manager's role — let anyone holding it delete an order still
  // waiting for approval, against Matt's "only approved orders reach the Supply Manager".
  ok('🔴 S131: while it waits for approval, supplies.manage alone may NOT cancel it — not the Supply Manager, not an admin pared off supplies.approve',
    may(req, sm) === false && may(req, office) === false);
  ok('S131: … once approved it is the Supply Manager\'s to process, and the office (supplies.manage) may cancel it',
    may(appr, sm) === true && may(appr, office) === true);
  ok('🔴 S131: the approver\'s OPERATIONS MANAGER may cancel what the approver may (a waiting or an approved order)',
    may(req, om) === true && may(appr, om) === true && may(req, { ...om, approverOpsManagerId: 'u_someone_else' }) === false);
  ok('🔴 S131: an approver pared off supplies.approve cannot cancel a waiting order (they cannot decline it either)',
    may(req, { ...approver, holdsApprove: false }) === false);
  ok('🔴 S131: while it waits, cancelling is deciding — for anyone but the requester maySupplyCancel IS maySupplyDecide(approve), the one rule',
    [approver, { ...approver, holdsApprove: false }, office, officeApprover, owner, { ...owner, holdsApprove: false }, sm, om,
      { selfId: 'u_x', role: 'manager', holdsApprove: true }, { selfId: 'u_ad', role: 'admin', holdsApprove: true }]
      .every((c) => may(req, c) === call(supplies.maySupplyDecide, { request: req, decision: 'approve', ...c })));
  ok('🔴 CS-670: NOBODY may cancel a request once it has gone out (sent, delivered) or was rejected — not the approver, not the office, not the owner',
    [sent, done, rej].every((r) => may(r, approver) === false && may(r, office) === false && may(r, owner) === false && may(r, requester) === false));
  ok('🔴 CS-670: the cancellable states are exactly requested and approved (one list: the route, the demo stub and the buttons read it)',
    JSON.stringify(supplies.SUPPLY_CANCELLABLE_STATUSES) === JSON.stringify([supplies.SUPPLY_STATUS?.requested, supplies.SUPPLY_STATUS?.approved])
    && call(supplies.isSupplyCancellable, appr) === true && call(supplies.isSupplyCancellable, sent) === false
    && call(supplies.isSupplyCancellable, null) === false);
  ok('CS-670 / S131: … and Reopen, the correction, stays open from a submitted order (the office\'s, recorded) — a completed one is final',
    call(supplies.nextSupplyStatus, 'sent', 'reopen') === 'open' && call(supplies.nextSupplyStatus, 'completed', 'reopen') === null
    && call(supplies.maySupplyDecide, { request: sent, decision: 'reopen', ...office }) === true);
  ok('CS-596: a cleaner never cancels', may(req, { selfId: CREW, role: 'crew' }) === false);
  ok('CS-596: maySupplyCancel answers false for a missing request rather than throwing',
    call(supplies.maySupplyCancel, {}) === false && call(supplies.maySupplyCancel) === false);
}

// ── CS-670: who a cancel tells (lib/supplyFlow supplyCancelNotifications) ──────────
// The requester, and the building's approver when someone else cancelled — the canceller is never
// told about their own act. Pure, on a store snapshot, like the decision bells above.
{
  const cancelBells = (actor) => {
    const out = call(supplyFlow.supplyCancelNotifications, {
      users: [
        { id: SUP, role: 'manager', status: 'active', name: 'Sam Super', notificationPrefs: {} },
        { id: 'u_req', role: 'manager', status: 'active', name: 'Rae Requester', notificationPrefs: {} },
        { id: OFFICE, role: 'admin', status: 'active', name: 'Olga Office', notificationPrefs: {} },
      ],
      clients: [{ id: 'cl1', name: 'Alpha Tower', supervisorId: SUP }],
      permissions: [], userPermissionOverrides: [], opsSettings: {}, notifications: [],
    }, { request: { id: 'r1', clientId: 'cl1', requestedByUserId: 'u_req', status: 'approved', lines: [{ name: 'TP', qty: 2 }] }, actorUserId: actor });
    return Array.isArray(out) ? out.filter((n) => n.eventKey === 'supplyRequestCancelled').map((n) => n.userId).sort() : null;
  };
  ok('🔴 CS-670: the office cancels → the requester AND the approver are told', JSON.stringify(cancelBells(OFFICE)) === JSON.stringify(['u_req', SUP].sort()));
  ok('🔴 CS-670: the approver cancels → the requester is told (not the canceller)', JSON.stringify(cancelBells(SUP)) === JSON.stringify(['u_req']));
  ok('🔴 CS-670: the requester withdraws it → the approver is told', JSON.stringify(cancelBells('u_req')) === JSON.stringify([SUP]));
  ok('CS-670: the bell is a supplies event a person can switch off (Account → Notifications)',
    (notifications.NOTIFICATION_GROUPS || []).some((g) => g.id === 'supplies' && g.items.some((i) => i.key === 'supplyRequestCancelled')));
}

// ── report ───────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\n✗ ${fails.length} FAILED (${pass} passed)`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ supplies approval / usage / budget / reminders — ${pass} checks passed`);
}
