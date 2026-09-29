// GET /api/state/view → { state, version, minClientBuild, freezeStrip, projection }
//
// CS-002 crew read split. The whole store is one org_state row, so RLS can't hide fields
// inside it: the migration flips org_state's SELECT policy to office roles only, and crew (and
// any non-office login) read the blob THROUGH this route instead of `.from('org_state')`.
//
// AUTH STANCE: requireAuthority (the same live-role authority helper every other /api/state/*
// route uses — never the token role alone). It resolves role CLAIMS-FIRST from the CURRENT user
// record (`auth.getUser`, a live read — claims.js), so a role change, a downgrade included, takes
// effect on the very next request here, as do a status DISABLE (the roster ACCESS check refuses
// at once) and a claim-less login's roster role (a blob role edit is re-read live). The ~1h token
// lag belongs to the read-split RLS (`auth.jwt()` in the migration), not to this route.
//   · owner / admin / manager  → the FULL blob (projection: 'full'), exactly what a direct
//                                read returned before the policy flip.
//   · crew, or any other/absent role → a server-built PROJECTION (projection: 'crew'):
//                                projectCrewView scopes and trims the blob to what a field
//                                user may see (crewView.js). Fail-safe: a login the office set
//                                does not name gets the RESTRICTED view, never the full blob.
//
// A plain nested file under /api/state (like org-state / jobs-delta / seed): no vercel.json
// rewrite needed. Cache-Control: no-store — the projection is per-user and authority-bearing,
// never cacheable by a shared/CDN layer (playbook II.7 server-request-cache trap).
import { requireAuthority, OFFICE_ROLES } from '../_lib/authz.js';
import { readOrgStateWithControls } from '../_lib/orgState.js';
import { getCrewJobs } from '../_lib/jobsTable.js';
import { projectCrewView } from '../_lib/crewView.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let a;
  try {
    a = await requireAuthority(req, res);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Authority check failed' });
  }
  if (!a) return; // 401 / 403 already written

  res.setHeader('Cache-Control', 'no-store');

  try {
    const { state, version, minClientBuild, freezeStrip } = await readOrgStateWithControls();

    if (OFFICE_ROLES.includes(a.role)) {
      return res.status(200).json({ state, version, minClientBuild, freezeStrip, projection: 'full' });
    }

    // Crew / any non-office login: the caller's own jobs (from the RLS-scoped public.jobs)
    // give the job-based half of their assignment scope; standing crew comes from the blob.
    const crewJobs = await getCrewJobs(a.orgUserId);
    const projected = projectCrewView(state, { userId: a.orgUserId, crewJobs });
    return res.status(200).json({ state: projected, version, minClientBuild, freezeStrip, projection: 'crew' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Read failed' });
  }
}
