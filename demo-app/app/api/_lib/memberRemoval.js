// What the removal pay rule needs from outside the protected read: the server twin of the
// Team page's "can this member be removed?" (owner's call, 2026-09-23: the server enforces
// it on both halves). Read by the org_state route, only when a save removes a member, and
// by the login-delete route; judged by teamAuthority.owedPayFor, which runs the app's own
// rule (lib/deleteCascade owedPayBlock).
import { readProtectedSlices } from './orgState.js';
import { listForReport } from './time/store.js';
import { payCutoffIso } from '../../src/lib/deleteCascade.js';

// The pay slices: kept off PROTECTED_SELECT because pay lines are kept forever and the
// protected read runs on every authority change, while removals are rare.
export const REMOVAL_PAY_SELECT = 'payrollLines:state->payrollLines,reimbursements:state->reimbursements,'
  + 'opsSettings:state->opsSettings';

// `committed` must carry company (the org zone: the server has no ambient one); `userIds`
// are the members being removed. Throws when a read fails: callers turn that into a
// refusal, never a pass.
export async function removalPayFacts(committed, userIds, { now = new Date() } = {}) {
  const pay = (await readProtectedSlices(REMOVAL_PAY_SELECT)) || {};
  const tz = typeof committed?.company?.timezone === 'string' && committed.company.timezone
    ? committed.company.timezone : undefined;
  const fromIso = payCutoffIso({ opsSettings: pay.opsSettings }, now, tz);
  const recentHours = new Set();
  for (const id of userIds) {
    // The Team page's question, asked the same way (timeApi.entries reads listForReport):
    // any punch on or after the start of the previous pay period.
    const hit = await listForReport({ fromIso, userIds: [id], limit: 1 });
    if (hit.length) recentHours.add(id);
  }
  return {
    payState: {
      payrollLines: pay.payrollLines ?? null,
      reimbursements: pay.reimbursements ?? null,
      opsSettings: pay.opsSettings ?? null,
    },
    recentHours,
    now,
  };
}
