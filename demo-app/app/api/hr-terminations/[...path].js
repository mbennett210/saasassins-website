// HR TERMINATIONS API (Super Clippy's idea #513 from Clean Corner's queue, 2026-11-05: Matt's
// termination form in HR, set up like warnings and incident reports, which ends the person's
// Clean Corner access). A catch-all domain — its `vercel.json` rewrite is
// `/api/hr-terminations/:rest* -> /api/hr-terminations/_?subpath=:rest*`, and without it every
// pretty URL here 404s while the file path works (BUILD_INTEGRITY §2).
//
//   GET  /api/hr-terminations/list[?employeeId=]   -> { terminations }                 hr.view
//   GET  /api/hr-terminations/<id>                 -> { termination }                  hr.view
//   POST /api/hr-terminations/create               -> { termination, created, access } hr.edit + the Team login rule
//   POST /api/hr-terminations/<id>/void            -> { termination, access }          the OWNER only
//
// ── AUTH STANCE (declared at creation, by capability — BUILD_INTEGRITY §2) ───────────────
// Every branch resolves the caller through `requireAuthority` (claims-first; a disabled member
// and a customer-hub login hold nothing). Then, per branch, against the COMMITTED matrix +
// overrides through the same `can()` the screens run:
//   · the office reads with `hr.view` (owner + manager by default, admin excluded — Q24's HR
//     rule, as for warnings and incidents);
//   · FILING turns a login off, so it takes `hr.edit` AND the Team page's own rule for turning a
//     login off (Daniel's pick, 2026-11-05: "HR and Team editors"): a claim-backed session, and
//     teamAuthority.loginRefusal('status') — the owner by role or `settings.team.edit` by the
//     matrix, never a Super Admin's login, an Admin's only by an Admin or a Super Admin — plus
//     never your own (lib/hrTerminations terminationTargetRefusal). The form can never turn off a
//     login its filer couldn't turn off on Team;
//   · VOID is held by ROLE — the owner, never a grant (as for incidents and warnings);
//   · 🔴 anyone without `hr.view` — every cleaner — reaches NOTHING here: one termination's read
//     answers 404, so a cleaner cannot learn that one names them.
// RLS on the table is enabled with no policies and the browser roles are revoked, so this route
// IS the boundary.
//
// The employee and the Direct Account Manager are PICKED on the form and proved against the
// committed roster before their names are stamped. Dates are the ORG's day (THE LAW II.8; this
// function runs TZ=UTC).
//
// NO ALERTS, and NOT in the activity log, as for warnings and incidents: the log is read by
// admins, and a termination is HR — the row itself is the audit (who filed it, when, the void and
// why, and when the login went off and came back).
import { requireAuthority, requirePermission, holdsPermission, readRosterUsers } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { isOrgUserId } from '../_lib/claims.js';
import { loginTarget } from '../_lib/users.js';
import { loginRefusal, matrixAuthority } from '../_lib/teamAuthority.js';
import { terminationTargetRefusal } from '../../src/lib/hrTerminations.js';
import {
  TerminationRefusal, isTerminationId, listTerminations, getTermination, createTermination, voidTermination,
} from '../_lib/hrTerminations/store.js';
import { orgToday, endTerminationAccess, restoreTerminationAccess } from '../_lib/hrTerminations/access.js';
import { reportError } from '../_lib/monitor.js';

const TEAM_SELECT = 'users:state->users,permissions:state->permissions,'
  + 'userPermissionOverrides:state->userPermissionOverrides';

export default function handler(req, res) {
  return withRequestCache(() => hrTerminationsHandler(req, res));
}

// Whether the caller may turn this employee's login off, by the Team page's rule. → null when
// allowed, else { status, error, code }.
async function teamLoginRefusal(a, employee, committed) {
  if (a.roleSource !== 'claim') {
    return { status: 403, error: 'Turning a login off requires a claim-backed session.', code: 'not-allowed' };
  }
  const claimId = a.idSource === 'claim' && isOrgUserId(a.orgUserId) ? a.orgUserId : null;
  const own = terminationTargetRefusal({ id: claimId || a.orgUserId, role: a.role }, employee);
  if (own) return { status: 403, error: new TerminationRefusal(own).message, code: own };
  const who = { role: a.role, orgUserId: claimId, email: a.email, claimIdentity: !!claimId };
  const authority = matrixAuthority(committed, a.role, claimId);
  const found = await loginTarget(employee.email || '', committed.users);
  // A member with no email has no login, so loginTarget finds no row for them: the target is
  // still this roster member (their role is what the rule reads).
  const target = found.rows.length ? found : { ...found, rows: [{ id: employee.id, role: employee.role, email: employee.email }] };
  // Owner targets and the caller's own login were refused above, so the last-Super-Admin facts
  // the Team route gathers never apply here.
  return loginRefusal('status', { caller: who, authority, target, disabled: true });
}

async function hrTerminationsHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const body = req.body || {};
  const [head, tail] = path;

  try {
    // ── reads ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (head === 'list') {
        const g = await requirePermission(req, res, 'hr.view');
        if (!g) return;
        const employeeUserId = typeof req.query.employeeId === 'string' && req.query.employeeId ? req.query.employeeId : null;
        return res.status(200).json({ terminations: await listTerminations({ employeeUserId }) });
      }
      if (isTerminationId(head) && !tail) {
        // 404, never 403, to anyone without hr.view: a termination's existence is not theirs to learn.
        const a = await requireAuthority(req, res);
        if (!a) return;
        if (!await holdsPermission(a, 'hr.view')) return res.status(404).json({ error: 'Termination not found' });
        const t = await getTermination(head);
        if (!t) return res.status(404).json({ error: 'Termination not found' });
        return res.status(200).json({ termination: t });
      }
      return res.status(404).json({ error: 'Unknown route' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── file a termination ──────────────────────────────────────────────────
    if (head === 'create') {
      const g = await requirePermission(req, res, 'hr.edit');
      if (!g) return;
      const committed = (await readProtectedSlices(TEAM_SELECT)) || {};
      const roster = Array.isArray(committed.users) ? committed.users : [];
      const employee = roster.find((u) => u && u.id === body.employeeUserId) || null;
      // A retried filing whose first try landed answers with what is on file, before any gate
      // that the first try's own turn-off would now trip (the person is Disabled by then).
      const already = isTerminationId(body.id) ? await getTermination(body.id) : null;
      if (already) return res.status(200).json({ termination: already, created: false, access: already.accessState });
      if (employee) {
        const no = await teamLoginRefusal(g, employee, committed);
        if (no) return res.status(no.status).json({ error: no.error, code: no.code });
      }
      const now = Date.now();
      const today = await orgToday(now);
      const { termination, created } = await createTermination(body, { actor: g.orgUserId, roster, today, now });
      // The date has come (today or earlier): the login turns off now. A failure leaves it
      // `scheduled` / `ending` for the 5-minute run to finish, and the answer says so.
      let shown = termination;
      let access = termination.accessState;
      if (created && termination.terminationDate <= today) {
        try {
          const out = await endTerminationAccess(termination, { today, now });
          access = out.outcome;
          shown = (await getTermination(termination.id)) || termination;
        } catch (e) {
          reportError('hr_terminations.end_failed', e, { id: termination.id, note: 'at filing; the ops-alerts run retries it' });
          access = 'pending';
          shown = (await getTermination(termination.id)) || termination;
        }
      }
      return res.status(200).json({ termination: shown, created, access });
    }

    if (!isTerminationId(head)) return res.status(404).json({ error: 'Unknown route' });

    // ── void: the owner only ─────────────────────────────────────────────────
    if (tail === 'void') {
      // Held by ROLE (claims-first, from requireAuthority), never by a grant.
      const g = await requireAuthority(req, res);
      if (!g) return;
      if (g.role !== 'owner') return res.status(403).json({ error: 'Only the Super Admin can void a termination.', code: 'not-allowed' });
      const roster = await readRosterUsers();
      const me = (Array.isArray(roster) ? roster : []).find((u) => u && u.id === g.orgUserId) || { id: g.orgUserId, name: null };
      const voided = await voidTermination(head, { reason: body.reason, voidedBy: me });
      // Give the login back when this termination had turned it off. A failure is retried by the
      // 5-minute run; the answer says it is still to come.
      let access = voided.accessState;
      let shown = voided;
      try {
        const out = await restoreTerminationAccess(voided);
        if (out.outcome !== 'not-due') access = out.outcome;
        shown = (await getTermination(head)) || voided;
      } catch (e) {
        reportError('hr_terminations.restore_failed', e, { id: head, note: 'at the void; the ops-alerts run retries it' });
        access = 'pending';
      }
      return res.status(200).json({ termination: shown, access });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    if (e instanceof TerminationRefusal) return res.status(e.status).json({ error: e.message, code: e.code });
    const status = readErrorStatus(e);
    if (status !== 500) return res.status(status).json({ error: e.message });
    console.error('[api/hr-terminations]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
