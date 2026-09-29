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
//   POST /api/hr-files/upload-url   { ownerId, mimeType, sizeBytes } -> { path, token, signedUrl }
//   POST /api/hr-files/download-url { ownerId, storagePath }         -> { url }
//   POST /api/hr-files/delete       { ownerId, storagePath }         -> { ok }
import { requireRoleOrPermission } from '../_lib/authz.js';
import { validateUpload, signedUploadUrl, signedDownloadUrl, removeObject } from '../_lib/hrFiles/store.js';

const HR_ROLES = ['owner', 'admin'];

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    if (action === 'upload-url' && req.method === 'POST') {
      const g = await requireRoleOrPermission(req, res, HR_ROLES, 'hr.edit');
      if (!g) return;
      if (!body.ownerId) return res.status(400).json({ error: 'ownerId is required' });
      const v = validateUpload({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!v.ok) return res.status(400).json({ error: v.error });
      const su = await signedUploadUrl({ ownerId: body.ownerId, mimeType: body.mimeType });
      return res.status(200).json(su);
    }

    if (action === 'download-url' && req.method === 'POST') {
      const g = await requireRoleOrPermission(req, res, HR_ROLES, 'hr.view');
      if (!g) return;
      if (!body.ownerId || !body.storagePath) return res.status(400).json({ error: 'ownerId and storagePath are required' });
      return res.status(200).json(await signedDownloadUrl({ ownerId: body.ownerId, storagePath: body.storagePath }));
    }

    if (action === 'delete' && req.method === 'POST') {
      const g = await requireRoleOrPermission(req, res, HR_ROLES, 'hr.edit');
      if (!g) return;
      if (!body.ownerId || !body.storagePath) return res.status(400).json({ error: 'ownerId and storagePath are required' });
      return res.status(200).json(await removeObject({ ownerId: body.ownerId, storagePath: body.storagePath }));
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/hr-files]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
