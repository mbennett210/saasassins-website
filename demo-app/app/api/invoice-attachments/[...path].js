// Invoice PDF attachments API. Bytes go to the private 'invoice-attachments' bucket via a
// signed upload URL; this route mints that URL, mints short-lived signed download URLs,
// and deletes. Server-side authz: invoices.edit to attach/replace/delete, invoices.view
// to open. The object path is rebuilt from the invoiceId in the store layer, never trusted
// from the body. Metadata (name/size/storagePath) rides invoice.attachment in org_state.
//
//   POST /api/invoice-attachments/upload-url   { invoiceId, mimeType, sizeBytes } -> { path, token, signedUrl }
//   POST /api/invoice-attachments/download-url { invoiceId, storagePath }         -> { url }
//   POST /api/invoice-attachments/delete       { invoiceId, storagePath }         -> { ok }
import { requirePermission } from '../_lib/authz.js';
import { validateUpload, signedUploadUrl, signedDownloadUrl, removeObject } from '../_lib/invoiceAttachments/store.js';

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    if (action === 'upload-url' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'invoices.edit');
      if (!g) return;
      if (!body.invoiceId) return res.status(400).json({ error: 'invoiceId is required' });
      const v = validateUpload({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!v.ok) return res.status(400).json({ error: v.error });
      const su = await signedUploadUrl({ invoiceId: body.invoiceId, mimeType: body.mimeType });
      return res.status(200).json(su);
    }

    if (action === 'download-url' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'invoices.view');
      if (!g) return;
      if (!body.invoiceId || !body.storagePath) return res.status(400).json({ error: 'invoiceId and storagePath are required' });
      const r = await signedDownloadUrl({ invoiceId: body.invoiceId, storagePath: body.storagePath });
      return res.status(200).json(r);
    }

    if (action === 'delete' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'invoices.edit');
      if (!g) return;
      if (!body.invoiceId || !body.storagePath) return res.status(400).json({ error: 'invoiceId and storagePath are required' });
      const r = await removeObject({ invoiceId: body.invoiceId, storagePath: body.storagePath });
      return res.status(200).json(r);
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/invoice-attachments]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
