// Server-side PDF for a scored inspection — the printable/shareable Quality report.
// Renders the SAME self-contained HTML the in-app modal and the public /inspect page
// use (src/lib/inspectionReportTemplate.js) through headless chromium, so the PDF
// matches what everyone saw on screen. Mirrors api/_lib/quotes/render.js.
//
// Photos are INLINED as data: URIs (the ops-media bucket is private — a signed URL
// would expire and chromium would have to hit the network). We prefer each object's
// small JPEG thumbnail; a video with no poster is dropped (a PDF can't show it).
import { getSupabase } from '../supabase.js';
import { listMediaRaw } from '../accountMedia/store.js';
import { isValidStoragePath } from '../storagePaths.js';
import { projectReport } from './store.js';
import { launchBrowser } from '../pdf/chromium.js';
import { buildInspectionReportHtml, REPORT_PRINT_HEADER, REPORT_PRINT_FOOTER } from '../../../src/lib/inspectionReportTemplate.js';

const BUCKET = 'ops-media';
const MAX_PHOTOS = 60; // hard cap so a photo-heavy inspection can't OOM the function

// Client-facing PDF filename: "inspection-<site|client>-<YYYY-MM-DD>.pdf", slugged.
// Shared by the authed (/api/qc) and public (/api/public/qc) download routes.
export function inspectionPdfFilename(rec) {
  const who = String(rec.site_name || rec.client_name || 'inspection')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'inspection';
  const day = String(rec.performed_at || '').slice(0, 10) || 'report';
  return `inspection-${who}-${day}.pdf`;
}

// Download one Storage object and return it as a data: URI, or null on any failure
// (a missing/renamed object must never sink the whole report).
async function objectDataUri(db, path, mime) {
  // `path` is read back from ops_media (storage_path / thumb_path). Re-validate it before
  // handing it to Storage so a corrupted or tampered row can't traverse the private
  // bucket; a rejected path is treated like any missing object (photo omitted, report
  // still renders).
  if (!path || !isValidStoragePath(path)) return null;
  try {
    const { data, error } = await db.storage.from(BUCKET).download(path);
    if (error || !data) return null;
    const buf = Buffer.from(await data.arrayBuffer());
    return `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// Resolve the inspection's photos to inlined, PDF-safe images. Thumbnail first (a
// ~KB JPEG); fall back to the full-res original for a thumbless image; skip a
// thumbless video (nothing to paint).
async function inlinePhotos(refId) {
  const db = getSupabase();
  const rows = (await listMediaRaw({ refId, scope: 'inspection' })).slice(0, MAX_PHOTOS);
  const out = [];
  for (const r of rows) {
    let url = null;
    if (r.thumb_path) url = await objectDataUri(db, r.thumb_path, 'image/jpeg');
    if (!url && r.kind === 'image') url = await objectDataUri(db, r.storage_path, r.mime_type);
    if (!url) continue; // thumbless video, or a download that failed — omit it
    out.push({ id: r.id, kind: r.kind, url, caption: r.caption || null, areaId: r.area_id || null });
  }
  return out;
}

// rec: an inspection_records row; items: its inspection_items rows. Returns PDF bytes.
export async function renderInspectionReportPdf(rec, items) {
  const photos = await inlinePhotos(rec.id);
  const report = projectReport(rec, items, photos);
  const inner = buildInspectionReportHtml(report, { forPdf: true });
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=816"></head><body>${inner}</body></html>`;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Every asset is an inline data: URI — no network — so 'load' is enough.
    await page.setContent(doc, { waitUntil: 'load' });
    return await page.pdf({
      format: 'letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: REPORT_PRINT_HEADER,
      footerTemplate: REPORT_PRINT_FOOTER,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.4in', right: '0.4in' },
    });
  } finally {
    await browser.close();
  }
}
