// HR INCIDENT REPORTS API (task #258 from Clean Corner's queue, 2026-10-27: Matt's "ACCIDENT /
// INCIDENT REPORT", in HR, set up like warnings). A catch-all domain — its `vercel.json` rewrite
// is `/api/hr-incidents/:rest* -> /api/hr-incidents/_?subpath=:rest*`, and without it every
// pretty URL here 404s while the file path works (BUILD_INTEGRITY §2).
//
//   GET  /api/hr-incidents/list[?employeeId=]   -> { incidents }             hr.view
//   GET  /api/hr-incidents/<id>                 -> { incident }              hr.view
//   POST /api/hr-incidents/create               -> { incident, created }     hr.edit
//   POST /api/hr-incidents/<id>/files           -> { incident }              hr.edit (only ever more)
//   POST /api/hr-incidents/<id>/review          -> { incident }              hr.edit (section 07, once)
//   POST /api/hr-incidents/<id>/void            -> { incident }              the OWNER only
//
// ── AUTH STANCE (declared at creation, by capability — BUILD_INTEGRITY §2) ───────────────
// Every branch resolves the caller through `requireAuthority` (claims-first; a disabled member
// and a customer-hub login hold nothing). Then, per branch, against the COMMITTED matrix +
// overrides through the same `can()` the screens run:
//   · the office reads with `hr.view` and files / marks reviewed / adds files with `hr.edit`
//     (owner + manager by default, admin excluded — Q24's HR rule, as for warnings);
//   · VOID is held by ROLE — the owner, never a grant: a void takes a report off the record's
//     face, and `can()` puts no key out of a grant's reach;
//   · 🔴 anyone without `hr.view` — every cleaner — reaches NOTHING here: a report's one read
//     answers 404, so a cleaner cannot even learn that one names them. (Daniel's pick: the
//     office files reports; nobody signs one on their phone.)
// RLS on the table is enabled with no policies and the browser roles are revoked, so this route
// IS the boundary.
//
// The reporter, the people involved, the submitter and the reviewer are PICKED on the form (the
// team shares one login), and the server proves each is on the committed roster (the submitter
// and the reviewer active office members) before stamping their names. Dates are the ORG's day
// (THE LAW II.8; this function runs TZ=UTC).
//
// NO ALERTS (Daniel's pick, 2026-10-27), and NOT in the activity log, on purpose: the log is read
// by admins, and an incident report is HR — the row itself is the audit (filed_by, the
// signature, the review, voided_by and why).
import { requireAuthority, requirePermission, holdsPermission, readRosterUsers } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { dayKey } from '../../src/lib/dates.js';
import {
  IncidentRefusal, isIncidentId, activeOfficeMember,
  listIncidents, getIncident, createIncident, addIncidentFiles, reviewIncident, voidIncident,
} from '../_lib/hrIncidents/store.js';

// The org's calendar day (a falsy zone resolves to the org default inside lib/dates).
async function orgToday(now = Date.now()) {
  try {
    const data = await readProtectedSlices('company:state->company');
    return dayKey(new Date(now), (data && data.company && data.company.timezone) || null);
  } catch {
    return dayKey(new Date(now), null);
  }
}

// The committed customers (the property's name is stamped from here).
async function readClients() {
  const data = await readProtectedSlices('clients:state->clients');
  return Array.isArray(data?.clients) ? data.clients : [];
}

export default function handler(req, res) {
  return withRequestCache(() => hrIncidentsHandler(req, res));
}

async function hrIncidentsHandler(req, res) {
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
        return res.status(200).json({ incidents: await listIncidents({ employeeUserId }) });
      }
      if (isIncidentId(head) && !tail) {
        // 404, never 403, to anyone without hr.view: a report's existence is not theirs to learn.
        const a = await requireAuthority(req, res);
        if (!a) return;
        if (!await holdsPermission(a, 'hr.view')) return res.status(404).json({ error: 'Report not found' });
        const inc = await getIncident(head);
        if (!inc) return res.status(404).json({ error: 'Report not found' });
        return res.status(200).json({ incident: inc });
      }
      return res.status(404).json({ error: 'Unknown route' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── file a report ───────────────────────────────────────────────────────
    if (head === 'create') {
      const g = await requirePermission(req, res, 'hr.edit');
      if (!g) return;
      const now = Date.now();
      const [roster, clients, today] = await Promise.all([readRosterUsers(), readClients(), orgToday(now)]);
      const { incident, created } = await createIncident(body, {
        actor: g.orgUserId, roster, clients, today, now,
      });
      return res.status(200).json({ incident, created });
    }

    if (!isIncidentId(head)) return res.status(404).json({ error: 'Unknown route' });

    // ── files added later (only ever more) ──────────────────────────────────
    if (tail === 'files') {
      const g = await requirePermission(req, res, 'hr.edit');
      if (!g) return;
      const incident = await addIncidentFiles(head, { files: body.files, actor: g.orgUserId });
      return res.status(200).json({ incident });
    }

    // ── section 07: Mark reviewed ───────────────────────────────────────────
    if (tail === 'review') {
      const g = await requirePermission(req, res, 'hr.edit');
      if (!g) return;
      const reviewer = activeOfficeMember(await readRosterUsers(), body.reviewerUserId);
      if (!reviewer) throw new IncidentRefusal('reviewer-missing');
      const incident = await reviewIncident(head, { reviewer, today: await orgToday() });
      return res.status(200).json({ incident });
    }

    // ── void: the owner only ─────────────────────────────────────────────────
    if (tail === 'void') {
      // Held by ROLE (claims-first, from requireAuthority), never by a grant.
      const g = await requireAuthority(req, res);
      if (!g) return;
      if (g.role !== 'owner') return res.status(403).json({ error: 'Only the Super Admin can void a report.' });
      const roster = await readRosterUsers();
      const me = (Array.isArray(roster) ? roster : []).find((u) => u && u.id === g.orgUserId) || { id: g.orgUserId, name: null };
      const incident = await voidIncident(head, { reason: body.reason, voidedBy: me });
      return res.status(200).json({ incident });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    if (e instanceof IncidentRefusal) return res.status(e.status).json({ error: e.message, code: e.code });
    const status = readErrorStatus(e);
    if (status !== 500) return res.status(status).json({ error: e.message });
    console.error('[api/hr-incidents]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
