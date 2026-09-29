// POST /api/state/seed  { state } → { ok }
//
// First-run bootstrap for a brand-new org (Increment 1d). Creates the org_state
// row only if it does not already exist — `ignoreDuplicates`, so two first-time
// sign-ins racing is safe and an established org is never touched.
//
// WHY IT IS A ROUTE AT ALL: this was the last direct browser write to org_state
// (store/sync.js first-run path). It is dormant on an established org like
// CleanSpace, but it is the boot path for every new client clone under the
// shell-then-clone model — so Increment 1e's policy revoke would otherwise ship
// a shell that cannot seed itself, and the failure would only surface during a
// client buildout.
//
// The seed document is still client-supplied, exactly as before. That is not a
// new trust surface: the browser is the author of the blob on the normal write
// path too, until the slice extractions land.
import { requireAuthority } from '../_lib/authz.js';
import { seedOrgState } from '../_lib/orgState.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let a;
  try {
    a = await requireAuthority(req, res);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Authority check failed' });
  }
  if (!a) return; // 401 already written

  const state = req.body?.state;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state is required' });

  try {
    return res.status(200).json(await seedOrgState(state, a.user.id));
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Seed failed' });
  }
}
