// Pure delete-cascade helpers (anti-ORPHAN, BUILD_INTEGRITY §3 / playbook II.5).
//
// The *decisions* a delete handler makes live here as pure functions: the reducer calls
// them, `test-delete-cascade.mjs` unit-tests them under plain node, and the deletion-
// ripple harness (`scripts/deletion-harness.mjs`) proves them end-to-end by dispatching
// the real reducer. Imports stay explicit `.js` so this file loads under plain node.
//
// History: the first three close gaps the LIVE wiring audit found (2026-09-20, LW-01/02/
// 03); the user-delete sweep and the delete guards come from the deletion-ripple audit
// (2026-09-22, DELETION_AUDIT.md).
import { isLastOwner } from './roles.js';
import { payPeriodRange } from './payroll.js';
import { dayKey } from './dates.js';
import { removeUserFromCrewChecklists } from './crewChecklist.js';

// LW-01 — rows a DELETE_CLIENT must also sweep. `supplyItems` / `supplyRequests` (S58)
// and `opsAlertEvents` all carry `clientId` but were never cascaded, so a deleted
// account left them riding the org_state blob keyed to a clientId nothing resolves.
// `deletedJobIds` (the client's jobs, already computed by the handler) also clears any
// job-scoped ops alert whose clientId happens to be null.
export function sweepClientOrphans(state, clientId, deletedJobIds = new Set()) {
  return {
    supplyItems: (state.supplyItems || []).filter((r) => r.clientId !== clientId),
    supplyRequests: (state.supplyRequests || []).filter((r) => r.clientId !== clientId),
    opsAlertEvents: (state.opsAlertEvents || []).filter(
      (e) => e.clientId !== clientId && !deletedJobIds.has(e.jobId)
    ),
  };
}

// LW-02 — scrub a deleted tag id from every marketing sequence's `replyTags`. Without
// this, RECEIVE_MARKETING_REPLY (reducer) re-applies the dead tag id to a contact on the
// next inbound reply, minting a dangling tagId on a live contact. DELETE_TAG already
// scrubs contacts/clients/jobs/sites; sequences were the missed slice.
export function scrubTagFromSequences(sequences, tagId) {
  return (sequences || []).map((seq) =>
    (seq.replyTags || []).includes(tagId)
      ? { ...seq, replyTags: (seq.replyTags || []).filter((x) => x !== tagId) }
      : seq
  );
}

// LW-03 — an OAuth workspace is "in use" if ANY connected inbox OR marketing inbox
// references it. REMOVE_OAUTH_WORKSPACE previously refused removal only for connected
// inboxes, so a workspace referenced solely by a marketing rotation inbox could be
// removed, orphaning that inbox's `workspaceId`.
export function oauthWorkspaceInUse(state, workspaceId) {
  if (!workspaceId) return false;
  const connected = Array.isArray(state.connectedInboxes) ? state.connectedInboxes : [];
  const marketing = Array.isArray(state.marketingInboxes) ? state.marketingInboxes : [];
  return connected.some((i) => i.workspaceId === workspaceId)
    || marketing.some((i) => i.workspaceId === workspaceId);
}

// The pay-period key before which pay is treated as settled: the start of the PREVIOUS
// period (a period's payout lands after it closes). Computed exactly as the pay run
// computes its periods (usePayrollRun: same cadence normalization, same payPeriodRange)
// so the guard and the run agree on what "this" and "last" period mean. `tz` is for the
// SERVER, which has no ambient org zone: it passes company.timezone. In the app it is left
// out, so the org zone the store sets (lib/dates setOrgTimezone) applies, as for the run.
export function payCutoffKey(state, now = new Date(), tz) {
  return payPeriodRange(normalCadence(state), -1, now, tz).fromKey;
}

// The same cutoff as an instant — for the Team page's clocked-hours check, which asks
// the time ledger for any punch on or after it.
export function payCutoffIso(state, now = new Date(), tz) {
  return payPeriodRange(normalCadence(state), -1, now, tz).fromIso;
}

function normalCadence(state) {
  const c = state?.opsSettings?.payPeriodCadence;
  return c === 'weekly' || c === 'semimonthly' ? c : 'biweekly';
}

// A salaried member is owed pay for every period they are employed, with no punches or
// pay lines to show it: while active, or when disabled on or after the cutoff (their
// last salary may not be paid out yet — UPDATE_USER records `disabledAt`). Someone
// disabled before `disabledAt` was tracked is already off the pay run, so removing them
// changes nothing and does not block.
export function hasUnpaidSalary(state, userId, cutoffKey, tz) {
  const u = userId ? (state.users || []).find((x) => x.id === userId) : null;
  if (!u || u.pay?.type !== 'salary') return false;
  if (u.status === 'active') return true;
  return !!u.disabledAt && dayKey(u.disabledAt, tz) >= (cutoffKey ?? payCutoffKey(state, undefined, tz));
}

// A DELETE_USER is REFUSED while the user has pay that may not be paid out yet: the pay
// run can't price someone who is no longer on file (their pay rate goes with them), so
// it would silently drop it (deletion-ripple audit DR-18/19; owner decision:
// block-delete). Pay lines are kept forever as history (keyed by periodKey, with no
// "paid" flag) and an approved reimbursement stays 'approved', so "unsettled" means: a
// line in the current or previous pay period (or with no periodKey — fail-safe), a
// reimbursement still 'pending', or salary still owed (hasUnpaidSalary). An approved
// reimbursement's money moves through its pay line. Older lines are settled history:
// they never block and survive the delete as a record. Clocked HOURS live in the time
// ledger, which the store can't see — the Team page checks those (memberDeleteBlock).
export function hasUnsettledPay(state, userId, cutoffKey, tz) {
  if (!userId) return false;
  const cut = cutoffKey ?? payCutoffKey(state, undefined, tz);
  const lines = Array.isArray(state.payrollLines) ? state.payrollLines : [];
  const reimb = Array.isArray(state.reimbursements) ? state.reimbursements : [];
  return lines.some((l) => l.userId === userId && (!l.periodKey || l.periodKey >= cut))
    || reimb.some((r) => r.userId === userId && r.status === 'pending')
    || hasUnpaidSalary(state, userId, cut, tz);
}

// Why a member may still be owed pay, as a code — 'unpaid-salary' | 'unsettled-pay' |
// 'unpaid-hours' — or null. The pay half of memberDeleteBlock, and what the SERVER checks
// before a removal (the login-delete route and the org_state guard, 2026-09-23 owner's
// call), so the app and the server run one rule. `recentHours` is the time ledger's
// answer (any punch on or after payCutoffIso): the store can't see clocked hours.
export function owedPayBlock(state, userId, cutoffKey, { recentHours = false, tz } = {}) {
  const cut = cutoffKey ?? payCutoffKey(state, undefined, tz);
  if (hasUnpaidSalary(state, userId, cut, tz)) return 'unpaid-salary';
  if (hasUnsettledPay(state, userId, cut, tz)) return 'unsettled-pay';
  if (recentHours) return 'unpaid-hours';
  return null;
}

// Why a team member can't be removed right now, as a code — 'last-owner' | 'self' |
// 'unpaid-salary' | 'unsettled-pay' | 'unpaid-hours' — or null when removal is allowed.
// The Team page renders the wording and runs this BEFORE deleting the member's login,
// so a refused delete never strands a login-less roster row. `recentHours` is the Team
// page's answer from the time ledger (any punch on or after payCutoffIso). DELETE_USER
// enforces last-owner + unsettled pay (incl. salary) itself; the store can't see hours.
// The server re-checks the pay codes, hours included, on both removal paths (owedPayBlock
// over the committed state + its own read of the time ledger).
export function memberDeleteBlock(state, userId, currentUserId, cutoffKey, { recentHours = false, tz } = {}) {
  if (isLastOwner(state.users || [], userId)) return 'last-owner';
  if (currentUserId && currentUserId === userId) return 'self';
  return owedPayBlock(state, userId, cutoffKey, { recentHours, tz });
}

// Approving a reimbursement in HR creates the pay line that pays it out and stores the
// line's id on the reimbursement (payrollLineId). That line is managed from HR: deleting
// it alone (the Payroll drawer's ×) left the reimbursement 'approved' but unpaid, with
// nothing flagging it. Returns the reimbursement a line pays out, or null.
export function reimbursementForLine(state, lineId) {
  if (!lineId) return null;
  return (state.reimbursements || []).find((r) => r.payrollLineId === lineId) || null;
}

// DELETE_REIMBURSEMENT takes its pay line with it, so HR's delete is one atomic write
// (it used to dispatch the line delete separately — which the line guard now refuses).
export function removeReimbursement(state, reimbursementId) {
  const all = state.reimbursements || [];
  const lines = state.payrollLines || [];
  const r = all.find((x) => x.id === reimbursementId);
  return {
    reimbursements: all.filter((x) => x.id !== reimbursementId),
    payrollLines: r?.payrollLineId ? lines.filter((l) => l.id !== r.payrollLineId) : lines,
  };
}

// The slices a DELETE_USER must ALSO scrub (deletion-ripple audit, 2026-09-22 + owner
// decisions). The handler already demotes conversation/message/key authorship and sweeps
// crewIds/notifications/overrides; this covers the ~15 other user-referencing slices that
// were left dangling. Returns ONLY the slices this sweep changes; the handler spreads it.
// NOT touched here (handled elsewhere by owner decision): keyEvents by/holderUserId is
// name-denormed inline in the handler; timeOff.userId is KEPT by design (historical
// call-out reports); a user's OWN unsettled pay BLOCKS the delete (hasUnsettledPay).
//
// `goneName` is the deleted user's name. A record that OUTLIVES them keeps it (owner:
// a deleted person must not turn into "—" in history): their own settled pay lines,
// reimbursements and PTO keep userId AND gain userName; a supply request or client note
// drops the id and keeps the name. An existing stored name wins, as in the handler.
export function sweepUserOrphans(state, userId, goneName = null) {
  const withName = (row, field) => (goneName && !row[field] ? { ...row, [field]: goneName } : row);
  return {
    // A departed user's mailbox connection goes with them (DR-05). NOTE: the provider-side
    // OAuth token revoke is a server call that binds at go-live — this clears the client row.
    connectedInboxes: (state.connectedInboxes || []).filter((i) => i.userId !== userId),
    // The per-cleaner checklist map { [userId]: templateId } drops the deleted user's entry
    // (lib/crewChecklist owns that rule — see [[swept-qc]]), and supervisorId → null (a
    // dangling one strands the account off the needs-a-manager bench). This is the ONLY
    // place DELETE_USER changes `clients`: a second writer would be silently overwritten.
    clients: removeUserFromCrewChecklists(state.clients, userId)
      .map((c) => (c.supervisorId === userId ? { ...c, supervisorId: null } : c)),
    // authorship link → null, name kept (the client Notes list shows the author; mirrors
    // contactActivities in the handler — the missing twin).
    clientActivities: (state.clientActivities || []).map((a) => (a.authorUserId === userId ? { ...withName(a, 'authorName'), authorUserId: null } : a)),
    marketingInboxes: (state.marketingInboxes || []).map((i) => (i.connectedByUserId === userId ? { ...i, connectedByUserId: null } : i)),
    marketingSequences: (state.marketingSequences || []).map((s) => {
      let ns = s;
      if (s.createdByUserId === userId) ns = { ...ns, createdByUserId: null };
      if (ns.notifyOnReplyUserId === userId) ns = { ...ns, notifyOnReplyUserId: null };
      return ns;
    }),
    supplyRequests: (state.supplyRequests || []).map((r) => {
      let nr = r;
      if (nr.requestedByUserId === userId) nr = { ...withName(nr, 'requestedByName'), requestedByUserId: null };
      if (nr.completedByUserId === userId) nr = { ...withName(nr, 'completedByName'), completedByUserId: null };
      return nr;
    }),
    // timeOff.userId is a DECISION (kept for historical call-out reports): the row keeps
    // the id and gains the name; only the authorship link (createdBy) is scrubbed.
    timeOff: (state.timeOff || []).map((t) => {
      let nt = t;
      if (nt.userId === userId) nt = withName(nt, 'userName');
      if (nt.createdBy === userId) nt = { ...nt, createdBy: null };
      return nt;
    }),
    // a departed employee's documents go with the employee.
    employeeDocuments: (state.employeeDocuments || []).filter((d) => d.userId !== userId),
    inspectionFollowUps: (state.inspectionFollowUps || []).map((f) => {
      let nf = f;
      if (f.assigneeUserId === userId) nf = { ...nf, assigneeUserId: null };
      if (nf.updatedBy === userId) nf = { ...nf, updatedBy: null };
      return nf;
    }),
    // an invitation FOR the deleted user is removed; an invitation the user SENT keeps
    // the row but drops the now-dangling inviter link.
    invitations: (state.invitations || [])
      .filter((iv) => iv.userId !== userId)
      .map((iv) => (iv.invitedBy === userId ? { ...iv, invitedBy: null } : iv)),
    // Pay rows the user CREATED or DECIDED for other employees keep the row, drop the
    // authorship link. Their OWN settled lines keep userId and gain their name: the
    // payroll guard only lets a delete through once that pay is history, and history
    // survives as a record.
    payrollLines: (state.payrollLines || []).map((l) => {
      let nl = l;
      if (nl.userId === userId) nl = withName(nl, 'userName');
      if (nl.createdBy === userId) nl = { ...nl, createdBy: null };
      return nl;
    }),
    reimbursements: (state.reimbursements || []).map((r) => {
      let nr = r;
      if (nr.userId === userId) nr = withName(nr, 'userName');
      if (nr.submittedBy === userId) nr = { ...nr, submittedBy: null };
      if (nr.decidedBy === userId) nr = { ...nr, decidedBy: null };
      return nr;
    }),
  };
}
