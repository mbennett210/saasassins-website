// Regression suite for the pure delete decisions in lib/deleteCascade.js: the LIVE wiring
// audit's fixes (2026-09-20 — LW-01 DELETE_CLIENT orphans supplies + ops-alerts, LW-02
// DELETE_TAG misses marketingSequences.replyTags, LW-03 REMOVE_OAUTH_WORKSPACE ignores
// marketing inboxes) and the deletion-ripple audit's user-delete sweep + delete guards
// (2026-09-22). Unit level; the end-to-end proof is test-deletion-ripple.mjs.
//   node app/scripts/test-delete-cascade.mjs
import * as cascade from '../src/lib/deleteCascade.js';
import {
  sweepClientOrphans, scrubTagFromSequences, oauthWorkspaceInUse, sweepUserOrphans,
  hasUnsettledPay, hasUnpaidSalary, payCutoffKey, payCutoffIso, memberDeleteBlock,
  reimbursementForLine, removeReimbursement,
} from '../src/lib/deleteCascade.js';
import { payPeriodRange } from '../src/lib/payroll.js';
import { calledOutOn } from '../src/lib/reports/calledOut.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

// ── LW-01: sweepClientOrphans removes supplies + ops-alerts keyed to the deleted client ──
{
  const state = {
    supplyItems: [{ id: 'si1', clientId: 'cl1' }, { id: 'si2', clientId: 'cl2' }],
    supplyRequests: [{ id: 'sr1', clientId: 'cl1' }, { id: 'sr2', clientId: 'cl2' }],
    opsAlertEvents: [
      { id: 'oa1', clientId: 'cl1', jobId: 'j1' },   // by clientId
      { id: 'oa2', clientId: 'cl2', jobId: 'j2' },   // kept
      { id: 'oa3', clientId: null, jobId: 'j1' },    // job-scoped, job belongs to cl1
      { id: 'oa4', clientId: null, jobId: 'j9' },    // unrelated → kept
    ],
  };
  const out = sweepClientOrphans(state, 'cl1', new Set(['j1']));
  ok(out.supplyItems.length === 1 && out.supplyItems[0].id === 'si2', 'LW-01 A: supply items for the deleted client are swept, others kept');
  ok(out.supplyRequests.length === 1 && out.supplyRequests[0].id === 'sr2', 'LW-01 B: supply requests for the deleted client are swept');
  const ids = out.opsAlertEvents.map((e) => e.id).sort();
  ok(ids.length === 2 && ids[0] === 'oa2' && ids[1] === 'oa4', 'LW-01 C: ops-alerts by clientId AND by deleted-jobId are swept; unrelated kept');
  // pre-fix state (no sweep) kept si1/sr1/oa1/oa3 — this assertion fails against that.
  ok(!out.supplyItems.some((r) => r.clientId === 'cl1'), 'LW-01 D: no supply item survives with the dead clientId');
}

// Empty/missing slices never throw.
{
  const out = sweepClientOrphans({}, 'clX');
  ok(out.supplyItems.length === 0 && out.supplyRequests.length === 0 && out.opsAlertEvents.length === 0, 'LW-01 E: missing slices default to [] safely');
}

// ── LW-02: scrubTagFromSequences drops the dead tag id from every sequence's replyTags ──
{
  const seqs = [
    { id: 's1', replyTags: ['t1', 't2'] },
    { id: 's2', replyTags: ['t3'] },
    { id: 's3' },                       // no replyTags at all
  ];
  const out = scrubTagFromSequences(seqs, 't1');
  ok(out.find((s) => s.id === 's1').replyTags.join(',') === 't2', 'LW-02 A: the deleted tag is removed from the sequence that had it');
  ok(out.find((s) => s.id === 's2').replyTags.join(',') === 't3', 'LW-02 B: an unrelated sequence is untouched');
  ok(out.find((s) => s.id === 's3').replyTags === undefined, 'LW-02 C: a sequence with no replyTags is left as-is (no crash)');
  ok(!out.some((s) => (s.replyTags || []).includes('t1')), 'LW-02 D: no sequence still carries the dead tag id');
  ok(scrubTagFromSequences(undefined, 't1').length === 0, 'LW-02 E: undefined sequences → [] safely');
}

// ── LW-03: oauthWorkspaceInUse counts BOTH connected AND marketing inboxes ──
{
  const state = {
    connectedInboxes: [{ id: 'ci1', workspaceId: 'ws_connected' }],
    marketingInboxes: [{ id: 'mi1', workspaceId: 'ws_marketing' }],
  };
  ok(oauthWorkspaceInUse(state, 'ws_connected') === true, 'LW-03 A: a workspace used by a connected inbox is in use');
  // THE fix: this returned false pre-fix (guard counted connected inboxes only) → the
  // workspace was removable, orphaning the marketing inbox. Must now be true.
  ok(oauthWorkspaceInUse(state, 'ws_marketing') === true, 'LW-03 B: a workspace used ONLY by a marketing inbox is in use (was the orphan gap)');
  ok(oauthWorkspaceInUse(state, 'ws_none') === false, 'LW-03 C: an unreferenced workspace is removable');
  ok(oauthWorkspaceInUse(state, null) === false, 'LW-03 D: a falsy id is never "in use"');
  ok(oauthWorkspaceInUse({}, 'ws') === false, 'LW-03 E: missing inbox slices default safely');
}

// ── sweepUserOrphans: the ~14 mechanical user-delete slices (deletion-ripple audit) ──
{
  const state = {
    clients: [{ id: 'cl1', supervisorId: 'u1', crewChecklists: { u1: 't1', u2: 't2' } }, { id: 'cl2', supervisorId: 'u2' }],
    clientActivities: [{ id: 'a1', authorUserId: 'u1' }, { id: 'a2', authorUserId: 'u2' }],
    marketingInboxes: [{ id: 'mi1', connectedByUserId: 'u1' }],
    marketingSequences: [{ id: 's1', createdByUserId: 'u1', notifyOnReplyUserId: 'u1' }],
    supplyRequests: [{ id: 'sr1', requestedByUserId: 'u1', completedByUserId: 'u1' }],
    timeOff: [{ id: 'to1', userId: 'u1', createdBy: 'u1' }],
    employeeDocuments: [{ id: 'd1', userId: 'u1' }, { id: 'd2', userId: 'u2' }],
    inspectionFollowUps: [{ id: 'f1', assigneeUserId: 'u1', updatedBy: 'u1' }],
    invitations: [{ id: 'iv1', userId: 'u1', invitedBy: 'u0' }, { id: 'iv2', userId: 'u2', invitedBy: 'u1' }],
    connectedInboxes: [{ id: 'ci1', userId: 'u1' }],
    // pay rows: u1's OWN settled line keeps its userId (history); u1's AUTHORSHIP of
    // rows about other employees is cleared.
    payrollLines: [{ id: 'pl1', userId: 'u1' }, { id: 'pl2', userId: 'u2', createdBy: 'u1' }],
    reimbursements: [{ id: 'r1', userId: 'u2', submittedBy: 'u1', decidedBy: 'u1', status: 'approved' }],
    keyEvents: [{ id: 'kev1', byUserId: 'u1' }],
  };
  const out = sweepUserOrphans(state, 'u1');
  ok(out.clients[0].supervisorId === null, 'USR-A: supervisorId nulled');
  ok(!('u1' in out.clients[0].crewChecklists) && out.clients[0].crewChecklists.u2 === 't2', 'USR-B: crewChecklists u1 key dropped, others kept');
  ok(out.clients[1].supervisorId === 'u2', 'USR-C: an unrelated supervisor is untouched');
  ok(out.clientActivities[0].authorUserId === null && out.clientActivities[1].authorUserId === 'u2', 'USR-D: clientActivities author nulled (the DR-20 twin of contactActivities)');
  ok(out.marketingInboxes[0].connectedByUserId === null, 'USR-E: marketingInbox connectedBy nulled');
  ok(out.marketingSequences[0].createdByUserId === null && out.marketingSequences[0].notifyOnReplyUserId === null, 'USR-F: sequence author + notify nulled');
  ok(out.supplyRequests[0].requestedByUserId === null && out.supplyRequests[0].completedByUserId === null, 'USR-G: supply requested/completed nulled');
  ok(out.timeOff[0].createdBy === null && out.timeOff[0].userId === 'u1', 'USR-H: timeOff.createdBy nulled but userId KEPT (DR-11 is a decision)');
  ok(out.employeeDocuments.length === 1 && out.employeeDocuments[0].id === 'd2', 'USR-I: the deleted user\'s employeeDocuments are swept');
  ok(out.inspectionFollowUps[0].assigneeUserId === null && out.inspectionFollowUps[0].updatedBy === null, 'USR-J: follow-up assignee + updatedBy nulled');
  ok(out.invitations.length === 1 && out.invitations[0].id === 'iv2' && out.invitations[0].invitedBy === null, 'USR-K: invitation FOR u1 swept; invitation BY u1 keeps its row with invitedBy nulled');
  // connectedInboxes IS swept (DR-05, owner: remove the departed user's mailbox link).
  ok(out.connectedInboxes.length === 0, 'USR-L: connectedInboxes for u1 swept (DR-05)');
  // keyEvents are name-denormed inline in the handler (needs the gone user's name).
  ok(!('keyEvents' in out), 'USR-M: keyEvents (inline denorm) are NOT in the sweep return');
  // Authorship on pay rows is cleared; the deleted user's OWN line keeps its userId (the
  // payroll guard only lets settled history through, and it survives as a record).
  const pl = Object.fromEntries(out.payrollLines.map((l) => [l.id, l]));
  ok(pl.pl2.createdBy === null && pl.pl1.userId === 'u1', 'USR-O: payrollLines.createdBy nulled; the deleted user\'s own line keeps its userId');
  ok(out.reimbursements[0].submittedBy === null && out.reimbursements[0].decidedBy === null && out.reimbursements[0].userId === 'u2', 'USR-P: reimbursement submittedBy + decidedBy nulled');
}
// ── A deleted person keeps their NAME on every record that survives them ──
// Before this, settled pay history, reimbursements, PTO (kept for the Called-out report)
// and supply requests showed the person as "—" once they were deleted, because each row
// stored only their id.
{
  const state = {
    payrollLines: [{ id: 'pl1', userId: 'u1', periodKey: '2000-01-01' }, { id: 'pl2', userId: 'u2', userName: 'Keep Me' }],
    reimbursements: [{ id: 'r1', userId: 'u1', status: 'approved' }],
    timeOff: [{ id: 't1', userId: 'u1', createdBy: 'u9' }],
    supplyRequests: [{ id: 's1', requestedByUserId: 'u1', completedByUserId: 'u1' }, { id: 's2', requestedByUserId: 'u2', requestedByName: 'Pre-set' }],
  };
  const out = sweepUserOrphans(state, 'u1', 'Andre Baptiste');
  const pl = Object.fromEntries(out.payrollLines.map((l) => [l.id, l]));
  ok(pl.pl1.userName === 'Andre Baptiste' && pl.pl1.userId === 'u1', 'NAME-A: a deleted employee\'s settled pay line keeps their id AND gains their name');
  ok(pl.pl2.userName === 'Keep Me', 'NAME-B: another employee\'s line is untouched');
  ok(out.reimbursements[0].userName === 'Andre Baptiste', 'NAME-C: their reimbursement gains their name');
  ok(out.timeOff[0].userName === 'Andre Baptiste' && out.timeOff[0].userId === 'u1', 'NAME-D: their kept PTO row gains their name (the Called-out report reads it)');
  const s1 = out.supplyRequests.find((r) => r.id === 's1');
  ok(s1.requestedByUserId === null && s1.requestedByName === 'Andre Baptiste' && s1.completedByUserId === null && s1.completedByName === 'Andre Baptiste', 'NAME-E: supply request requested/completed-by: id cleared, name kept');
  ok(out.supplyRequests.find((r) => r.id === 's2').requestedByName === 'Pre-set', 'NAME-F: an unrelated request is untouched');
  const noName = sweepUserOrphans(state, 'u1');
  ok(noName.payrollLines[0].userName == null && noName.supplyRequests[0].requestedByName == null, 'NAME-G: without a name to stamp, nothing is invented');
  // an already-stored name is never overwritten (the handler's keys/messages rule)
  const stored = sweepUserOrphans({ timeOff: [{ id: 't9', userId: 'u1', userName: 'Stored Name' }] }, 'u1', 'Andre Baptiste');
  ok(stored.timeOff[0].userName === 'Stored Name', 'NAME-I: a row that already stores a name keeps it');
  // The Called-out report (the reason PTO rows are kept) must show the stored name once
  // the person is gone from the users list, not "—".
  const D = '2026-09-22';
  const rows = calledOutOn({ timeOff: [{ id: 't1', userId: 'u_gone', startDate: D, endDate: D, userName: 'Andre Baptiste', reason: 'sick' }], usersById: new Map(), dayKey: D });
  ok(rows.length === 1 && rows[0].userName === 'Andre Baptiste', 'NAME-H: the Called-out report shows a deleted cleaner by their stored name');
}
{
  const out = sweepUserOrphans({}, 'uX');
  ok(out.clients.length === 0 && out.invitations.length === 0 && out.employeeDocuments.length === 0 && out.connectedInboxes.length === 0, 'USR-N: missing slices default to [] safely');
}

// ── hasUnsettledPay: DELETE_USER refuses only while pay may still be UNPAID (DR-18/19) ──
// Pay lines are kept forever as history (keyed by periodKey, no "paid" flag) and an
// approved reimbursement stays 'approved'. So "unsettled" = a line in the current or
// previous pay period (payout lag) or a still-pending reimbursement — NOT any line ever,
// which made every employee who once got a bonus permanently undeletable.
{
  const CUT = '2026-09-01'; // e.g. semi-monthly, today in Sep 16–30 → previous period starts Sep 1
  ok(hasUnsettledPay({ payrollLines: [{ userId: 'u1', periodKey: '2026-09-16' }] }, 'u1', CUT) === true, 'PAY-A: a line in the current period blocks');
  ok(hasUnsettledPay({ payrollLines: [{ userId: 'u1', periodKey: '2026-09-01' }] }, 'u1', CUT) === true, 'PAY-B: a line in the previous period (payout lag) blocks');
  // THE over-block regression: old, already-paid history must not block the delete.
  ok(hasUnsettledPay({ payrollLines: [{ userId: 'u1', periodKey: '2026-08-16' }] }, 'u1', CUT) === false, 'PAY-C: a line only in an older (settled) period does NOT block');
  ok(hasUnsettledPay({ payrollLines: [{ userId: 'u1' }] }, 'u1', CUT) === true, 'PAY-D: a line with no periodKey is treated as unsettled (fail-safe)');
  ok(hasUnsettledPay({ reimbursements: [{ userId: 'u1', status: 'pending', periodKey: '2026-01-01' }] }, 'u1', CUT) === true, 'PAY-E: a pending reimbursement blocks whatever its period');
  // An approved reimbursement's money moves through its pay line (checked above).
  ok(hasUnsettledPay({ reimbursements: [{ userId: 'u1', status: 'approved' }] }, 'u1', CUT) === false, 'PAY-F: an approved reimbursement alone does not block (its pay line governs)');
  ok(hasUnsettledPay({ reimbursements: [{ userId: 'u1', status: 'rejected' }] }, 'u1', CUT) === false, 'PAY-G: a rejected reimbursement does not block');
  ok(hasUnsettledPay({ payrollLines: [{ userId: 'u2', periodKey: '2026-09-16' }], reimbursements: [{ userId: 'u2', status: 'pending' }] }, 'u1', CUT) === false, "PAY-H: another user's pay does not block");
  ok(hasUnsettledPay({}, 'u1', CUT) === false && hasUnsettledPay({ payrollLines: [{ userId: 'u1', periodKey: '2026-09-16' }] }, null, CUT) === false, 'PAY-I: no data / falsy id → not blocked');
}

// ── A pay line created by approving a reimbursement is managed from HR ──
// DELETE_PAYROLL_LINE refuses it (removing it alone left the reimbursement 'approved'
// but unpaid — the Payroll drawer let anyone do that with one tap), and
// DELETE_REIMBURSEMENT takes the line with it.
{
  const state = {
    reimbursements: [{ id: 'r1', userId: 'u1', status: 'approved', payrollLineId: 'plR' }, { id: 'r2', userId: 'u1', status: 'pending' }],
    payrollLines: [{ id: 'plR', userId: 'u1', category: 'reimbursement' }, { id: 'plB', userId: 'u1', category: 'bonus' }],
  };
  ok(reimbursementForLine(state, 'plR')?.id === 'r1', 'RMB-A: the reimbursement a pay line pays out is found');
  ok(reimbursementForLine(state, 'plB') === null && reimbursementForLine(state, null) === null, 'RMB-B: an ordinary line (or no id) is not reimbursement-backed');
  const gone = removeReimbursement(state, 'r1');
  ok(gone.reimbursements.map((r) => r.id).join() === 'r2' && gone.payrollLines.map((l) => l.id).join() === 'plB', 'RMB-C: removing a reimbursement takes its pay line; other lines stay');
  const pend = removeReimbursement(state, 'r2');
  ok(pend.payrollLines.length === 2 && pend.reimbursements.length === 1, 'RMB-D: removing a reimbursement with no pay line leaves every line');
  ok(removeReimbursement({}, 'rX').payrollLines.length === 0 && reimbursementForLine({}, 'x') === null, 'RMB-E: missing slices default safely');
}

// ── payCutoffKey: the settlement cutoff uses the pay run's own period math ──
{
  const now = '2026-09-22';
  ok(payCutoffKey({ opsSettings: { payPeriodCadence: 'semimonthly' } }, now) === '2026-09-01', 'CUT-A: semi-monthly on Sep 22 → the previous period starts Sep 1');
  ok(payCutoffKey({ opsSettings: { payPeriodCadence: 'weekly' } }, now) === payPeriodRange('weekly', -1, now).fromKey, "CUT-B: weekly uses the run's own previous-period start");
  const biweekly = payPeriodRange('biweekly', -1, now).fromKey;
  ok(payCutoffKey({ opsSettings: {} }, now) === biweekly && payCutoffKey({}, now) === biweekly, 'CUT-C: a missing/unknown cadence normalizes to biweekly, like the pay run');
}

// ── memberDeleteBlock: the one decision the Team page checks before touching a login ──
{
  const CUT = '2026-09-01';
  const owner = { id: 'o1', role: 'owner', status: 'active' };
  const owner2 = { id: 'o2', role: 'owner', status: 'active' };
  const crew = { id: 'c1', role: 'crew', status: 'active' };
  const base = { users: [owner, crew] };
  ok(memberDeleteBlock(base, 'o1', 'x', CUT) === 'last-owner', 'MDB-A: the last owner is blocked');
  ok(memberDeleteBlock({ users: [owner, owner2, crew] }, 'o2', 'o2', CUT) === 'self', 'MDB-B: removing yourself is blocked');
  // The Team page's old inline check knew only last-owner + self, so it let this case
  // through: it deleted the login, DELETE_USER then refused, and the page said "removed".
  ok(memberDeleteBlock({ ...base, payrollLines: [{ userId: 'c1', periodKey: '2026-09-16' }] }, 'c1', 'o1', CUT) === 'unsettled-pay', 'MDB-C: a member with unpaid pay is blocked before their login is touched');
  ok(memberDeleteBlock({ users: [owner], payrollLines: [{ userId: 'o1', periodKey: '2026-09-16' }] }, 'o1', 'o1', CUT) === 'last-owner', 'MDB-D: precedence — last-owner is reported first');
  ok(memberDeleteBlock({ ...base, payrollLines: [{ userId: 'c1', periodKey: '2026-08-01' }], reimbursements: [{ userId: 'c1', status: 'approved' }] }, 'c1', 'o1', CUT) === null, 'MDB-E: settled pay history alone does not block removal');
  ok(memberDeleteBlock(base, 'c1', 'o1', CUT) === null, 'MDB-F: an ordinary member is removable');
}

// ── Salary and clocked hours are unpaid pay too (pay-run follow-up, 2026-09-22) ──
// The pay run can't price someone no longer on file (their rate goes with them), so a
// removal must wait until everything they earned is paid out. A salaried member is owed
// each period they're employed with no punches or lines to show it; clocked hours live
// in the time ledger, which the store can't see, so the Team page checks it and passes
// the answer in (recentHours).
{
  const CUT = '2026-09-01';
  const sal = (over) => ({ id: 's1', role: 'admin', status: 'active', pay: { type: 'salary', salaryPerPeriod: 2400 }, ...over });
  const owner = { id: 'o1', role: 'owner', status: 'active' };
  const crew = { id: 'c1', role: 'crew', status: 'active' };
  ok(hasUnpaidSalary({ users: [sal()] }, 's1', CUT) === true, 'SAL-A: an active salaried member is owed this period');
  ok(hasUnpaidSalary({ users: [sal({ status: 'disabled', disabledAt: '2026-09-05T15:00:00.000Z' })] }, 's1', CUT) === true, 'SAL-B: disabled inside the unpaid window (previous period on) → still owed');
  ok(hasUnpaidSalary({ users: [sal({ status: 'disabled', disabledAt: '2026-08-20T15:00:00.000Z' })] }, 's1', CUT) === false, 'SAL-C: disabled before the previous period began → the last salary is paid; removable');
  ok(hasUnpaidSalary({ users: [sal({ status: 'disabled' })] }, 's1', CUT) === false, 'SAL-D: disabled with no recorded date (before it was tracked) → not blocked; already off the run');
  ok(hasUnpaidSalary({ users: [sal({ pay: { type: 'hourly', hourlyRate: 20 } })] }, 's1', CUT) === false, 'SAL-E: hourly pay is governed by hours and lines, not this rule');
  ok(hasUnsettledPay({ users: [sal()] }, 's1', CUT) === true, "SAL-F: DELETE_USER's own guard (hasUnsettledPay) includes salary");
  ok(memberDeleteBlock({ users: [owner, sal()] }, 's1', 'o1', CUT) === 'unpaid-salary', 'MDB-G: an active salaried member is blocked with the salary reason');
  ok(memberDeleteBlock({ users: [owner, crew] }, 'c1', 'o1', CUT, { recentHours: true }) === 'unpaid-hours', 'MDB-H: clocked hours in this or the last pay period block removal');
  ok(memberDeleteBlock({ users: [owner, crew], payrollLines: [{ userId: 'c1', periodKey: '2026-09-16' }] }, 'c1', 'o1', CUT, { recentHours: true }) === 'unsettled-pay', 'MDB-I: precedence — a pay line is reported before hours');
  ok(memberDeleteBlock({ users: [owner, crew] }, 'c1', 'o1', CUT, { recentHours: false }) === null, 'MDB-J: nothing owed → removable');
}
// ── payCutoffIso: the same cutoff as an instant, for the Team page's hours check ──
{
  const now = '2026-09-22';
  ok(payCutoffIso({ opsSettings: { payPeriodCadence: 'semimonthly' } }, now) === payPeriodRange('semimonthly', -1, now).fromIso, "CUT-D: the hours cutoff is the previous period's start instant");
}

// ── owedPayBlock: the pay half the SERVER re-checks on a removal (2026-09-23) ──
// The login-delete route and the org_state guard run this, not a copy of it, so the app
// and the server can't disagree on who may still be owed pay. The server has no ambient
// org zone, so it passes company.timezone; the app leaves `tz` out (the store's zone).
{
  const owedPayBlock = cascade.owedPayBlock;
  ok(typeof owedPayBlock === 'function', 'OWED-0: owedPayBlock is exported for the server');
  const has = typeof owedPayBlock === 'function';
  const CUT = '2026-09-01';
  const owner = { id: 'o1', role: 'owner', status: 'active' };
  const crew = { id: 'c1', role: 'crew', status: 'active' };
  const sal = { id: 's1', role: 'crew', status: 'active', pay: { type: 'salary', salaryPerPeriod: 2400 } };
  ok(has && owedPayBlock({ users: [owner, sal] }, 's1', CUT) === 'unpaid-salary', 'OWED-A: salary still owed');
  ok(has && owedPayBlock({ users: [crew], payrollLines: [{ userId: 'c1', periodKey: '2026-09-16' }] }, 'c1', CUT) === 'unsettled-pay', 'OWED-B: a line this period');
  ok(has && owedPayBlock({ users: [crew] }, 'c1', CUT, { recentHours: true }) === 'unpaid-hours', 'OWED-C: clocked hours');
  ok(has && owedPayBlock({ users: [crew] }, 'c1', CUT) === null, 'OWED-D: nothing owed');
  ok(has && owedPayBlock({ users: [owner] }, 'o1', CUT) === null && memberDeleteBlock({ users: [owner] }, 'o1', null, CUT) === 'last-owner',
    'OWED-E: owedPayBlock is ONLY the pay half (last-owner and self stay memberDeleteBlock\'s)');
  // The org zone decides which day a disabledAt falls on, and so whether their last salary
  // is inside the unpaid window: 2026-09-01 06:30Z is still Aug 31 in Los Angeles.
  const late = { users: [{ ...sal, status: 'disabled', disabledAt: '2026-09-01T06:30:00.000Z' }] };
  ok(hasUnpaidSalary(late, 's1', CUT, 'America/Los_Angeles') === false, 'TZ-A: disabled Aug 31 in the org zone → before the cutoff, removable');
  ok(hasUnpaidSalary(late, 's1', CUT, 'UTC') === true, 'TZ-B: the same instant is Sep 1 in UTC → a zone passed in is honoured');
  const now = '2026-09-22';
  ok(payCutoffKey({ opsSettings: { payPeriodCadence: 'weekly' } }, now, 'America/New_York') === payPeriodRange('weekly', -1, now, 'America/New_York').fromKey,
    'TZ-C: payCutoffKey passes the zone to the pay run\'s own period math');
  ok(payCutoffIso({}, now, 'America/New_York') === payPeriodRange('biweekly', -1, now, 'America/New_York').fromIso, 'TZ-D: payCutoffIso too');
  ok(hasUnsettledPay({ users: [sal] }, 's1') === true && hasUnpaidSalary({ users: [crew] }, 'c1') === false,
    'CUT-E: a missing cutoff is computed as before (callers that pass none still work)');
}

console.log(`\n${pass}/${pass + fail} delete-cascade assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
