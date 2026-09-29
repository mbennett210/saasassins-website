// The Variance report API — the headline differentiator. Manager-only
// (variance.view → owner/admin), server-side aggregation over a bounded window.
// Multi-cleaner attribution + flag math live in the shared src/lib/variance.js.
//
//   POST /api/variance/report  { fromIso, toIso, filters? }  -> { rows, summary, basis, threshold }
//
// POST (not GET) so the filter id-arrays ride in the body rather than a giant URL.
// requireRole re-checks authority server-side — UI gating is not a boundary (§2.4).
import { requirePermission } from '../_lib/authz.js';
import { runVarianceReport } from '../_lib/variance/compute.js';


export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    if (action === 'report' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'variance.view');
      if (!g) return;
      const report = await runVarianceReport({
        fromIso: body.fromIso || null,
        toIso: body.toIso || null,
        filters: {
          siteIds: Array.isArray(body.filters?.siteIds) ? body.filters.siteIds : null,
          clientIds: Array.isArray(body.filters?.clientIds) ? body.filters.clientIds : null,
          userIds: Array.isArray(body.filters?.userIds) ? body.filters.userIds : null,
          flaggedOnly: !!body.filters?.flaggedOnly,
        },
      });
      return res.status(200).json(report);
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/variance]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
