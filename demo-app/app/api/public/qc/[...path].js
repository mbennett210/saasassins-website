// PUBLIC, token-scoped inspection report (the shareable QC results link — the
// quotes public-link pattern). NO requireAuth: the unguessable public_token
// IS the capability. Returns a safe projection only; draft records 404.
//
// AUTH STANCE: public — no requireAuth; the unguessable CSPRNG public_token is the capability (getInspectionByToken); safe projection only, draft records 404.
//
//   GET /api/public/qc/inspection?token=<token>      ->  { inspection, items, photos }
//   GET /api/public/qc/inspection-pdf?token=<token>  ->  application/pdf (attachment)
import { getInspectionByToken, getInspectionRawByToken } from '../../_lib/qc/store.js';
import { renderInspectionReportPdf, inspectionPdfFilename } from '../../_lib/qc/reportPdf.js';

// maxDuration: the inspection-pdf action launches headless chromium — cold-start +
// render can exceed the default limit. Mirrors the quote + pay routes.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;

  try {
    if (action === 'inspection' && req.method === 'GET') {
      const token = (req.query.token || '').toString();
      if (!token) return res.status(400).json({ error: 'token is required' });
      const r = await getInspectionByToken(token);
      if (!r) return res.status(404).json({ error: 'Report not found' });
      return res.status(200).json(r);
    }
    // Same report, rendered to PDF — the "Download PDF" button on the shared link.
    // Token IS the capability (submitted-only); drafts 404 exactly like the HTML view.
    if (action === 'inspection-pdf' && req.method === 'GET') {
      const token = (req.query.token || '').toString();
      if (!token) return res.status(400).json({ error: 'token is required' });
      const raw = await getInspectionRawByToken(token);
      if (!raw) return res.status(404).json({ error: 'Report not found' });
      const pdf = await renderInspectionReportPdf(raw.rec, raw.items);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${inspectionPdfFilename(raw.rec)}"`);
      return res.status(200).send(Buffer.from(pdf));
    }
    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/public/qc]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
