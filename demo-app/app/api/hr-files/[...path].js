// HR files API (employee documents + reimbursement receipts). Employee PII. The gates
// follow the app's HR cards: hr.view to download (the documents card and the Reimbursements
// tab show only to hr.view holders), hr.edit to upload or delete, both read from the
// committed matrix + overrides. Owner and admin pass by role as they always did (owner's
// call 2026-09-23: never tightened, although the app hides HR from admin by default, Q24).
// Until then the route was owner/admin only, so the manager tier (hr.* by default) was
// refused the files the app showed it. Bytes go to the private 'hr-files' bucket through
// signed URLs; the object path is rebuilt from the ownerId in the store, never the body.
// Metadata rides the employeeDocuments / reimbursements slices in org_state.
//
// AN INCIDENT REPORT'S FILES (owner `incident-<id>`, task #258) are listed on the report itself
// (/api/hr-incidents) and gate like it: hr.view to download, hr.edit to upload, by the matrix
// alone (no role passes: the report's own route lets admin by no role either). A file a report
// holds is NEVER removed (Daniel's pick, 2026-10-27): delete refuses it. One the report never took
// (the form cancelled, a row taken off before filing) can be removed, so it is not stranded in
// the bucket. A voided report, or one already holding its most files, takes no upload.
//
//   POST /api/hr-files/upload-url   { ownerId, mimeType, sizeBytes } -> { path, token, signedUrl }
//   POST /api/hr-files/download-url { ownerId, storagePath }         -> { url }
//   POST /api/hr-files/delete       { ownerId, storagePath }         -> { ok }
import { requireRoleOrPermission, requirePermission } from '../_lib/authz.js';
import { validateUpload, signedUploadUrl, signedDownloadUrl, removeObject } from '../_lib/hrFiles/store.js';
import { incidentFileState } from '../_lib/hrIncidents/store.js';
import { isIncidentFileOwner, incidentIdOfOwner, INCIDENT_STATUS, MAX_FILES } from '../../src/lib/hrIncidents.js';

const HR_ROLES = ['owner', 'admin'];

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    const incident = isIncidentFileOwner(body.ownerId);
    if (incident && !incidentIdOfOwner(body.ownerId)) return res.status(400).json({ error: 'That is not an incident report.' });

    if (action === 'upload-url' && req.method === 'POST') {
      const g = incident
        ? await requirePermission(req, res, 'hr.edit')
        : await requireRoleOrPermission(req, res, HR_ROLES, 'hr.edit');
      if (!g) return;
      if (!body.ownerId) return res.status(400).json({ error: 'ownerId is required' });
      const v = validateUpload({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (incident) {
        // A new report's form uploads before the report exists; a filed one must still take files.
        const st = await incidentFileState(incidentIdOfOwner(body.ownerId));
        if (st && st.status === INCIDENT_STATUS.voided) return res.status(409).json({ error: 'That report was voided.', code: 'already-closed' });
        if (st && st.files.length >= MAX_FILES) return res.status(400).json({ error: 'That report holds as many files as it can.', code: 'files-too-many' });
      }
      const su = await signedUploadUrl({ ownerId: body.ownerId, mimeType: body.mimeType });
      return res.status(200).json(su);
    }

    if (action === 'download-url' && req.method === 'POST') {
      const g = incident
        ? await requirePermission(req, res, 'hr.view')
        : await requireRoleOrPermission(req, res, HR_ROLES, 'hr.view');
      if (!g) return;
      if (!body.ownerId || !body.storagePath) return res.status(400).json({ error: 'ownerId and storagePath are required' });
      return res.status(200).json(await signedDownloadUrl({ ownerId: body.ownerId, storagePath: body.storagePath }));
    }

    if (action === 'delete' && req.method === 'POST') {
      const g = incident
        ? await requirePermission(req, res, 'hr.edit')
        : await requireRoleOrPermission(req, res, HR_ROLES, 'hr.edit');
      if (!g) return;
      if (!body.ownerId || !body.storagePath) return res.status(400).json({ error: 'ownerId and storagePath are required' });
      if (incident) {
        const st = await incidentFileState(incidentIdOfOwner(body.ownerId));
        if (st && st.files.some((f) => f && f.storagePath === body.storagePath)) {
          return res.status(403).json({ error: 'A file on an incident report is never removed.' });
        }
        return res.status(200).json(await removeObject({ ownerId: body.ownerId, storagePath: body.storagePath, unheldIncidentFile: true }));
      }
      return res.status(200).json(await removeObject({ ownerId: body.ownerId, storagePath: body.storagePath }));
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/hr-files]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
