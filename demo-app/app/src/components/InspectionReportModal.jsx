import { useEffect, useState } from 'react';
import Modal from './Modal';
import { useToast } from './Toast';
import { usePermission } from '../hooks/usePermission';
import * as qcApi from '../lib/qcApi';
import { buildInspectionReportHtml } from '../lib/inspectionReportTemplate';
import { appLink } from '../lib/appLink';

// In-app inspection REPORT viewer. Fetches the normalized report (schema + answers +
// per-section photos) and renders the SAME self-contained document the public /inspect
// page and the server PDF use — so what you see here is exactly what downloads. The
// PDF is rendered server-side (headless chromium); "Copy link" shares the public token.
export default function InspectionReportModal({ open, inspectionId, onClose }) {
  const toast = useToast();
  const canShare = usePermission('qc.share');
  const [report, setReport] = useState(undefined); // undefined = loading, null = error/not found
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !inspectionId) { setReport(undefined); return; }
    let alive = true;
    setReport(undefined);
    qcApi.getInspectionReport(inspectionId)
      .then((r) => { if (alive) setReport(r || null); })
      .catch(() => { if (alive) setReport(null); });
    return () => { alive = false; };
  }, [open, inspectionId]);

  const ins = report?.inspection || {};

  const downloadPdf = async () => {
    setBusy(true);
    try { await qcApi.downloadInspectionPdf(inspectionId); }
    catch (e) { toast.error(e.message || 'Could not generate the PDF'); }
    finally { setBusy(false); }
  };

  const copyLink = () => {
    if (!ins.publicToken) return;
    navigator.clipboard?.writeText(appLink(`/inspect/${ins.publicToken}`)); // the app's own address (lib/appLink.js)
    toast.success('Share link copied');
  };

  return (
    <Modal open={open} onClose={onClose} title="Inspection report" size="lg">
      {report === undefined ? (
        <p className="text-muted text-sm">Loading…</p>
      ) : report === null ? (
        <p className="text-muted text-sm">This report could not be loaded.</p>
      ) : (
        <>
          {/* HUB-16 — the office's own note, ABOVE the document and outside it. The
              document below is the client's copy, byte for byte: `buildInspectionReportHtml`
              is handed `report` and reads only its inspection / items / photos, so a
              sibling key cannot reach the page, the PDF or the shared link. The server
              only sends it to a caller holding `qc.inspect`, so there is nothing to hide
              here — if it is present, this viewer is allowed it. */}
          {report.internalNote && (
            <div className="callout callout-info insp-internal-note-read">
              <strong>Internal note — your team only.</strong>
              {' '}
              <span>{report.internalNote}</span>
              <p className="text-xs text-muted" style={{ margin: '4px 0 0' }}>
                Not part of the report below, the shared link or the PDF.
              </p>
            </div>
          )}
          <div className="insp-report-scroll">
            <div dangerouslySetInnerHTML={{ __html: buildInspectionReportHtml(report) }} />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
            {canShare && ins.publicToken && ins.status === 'submitted' && (
              <button type="button" className="btn btn-outline" onClick={copyLink}>Copy link</button>
            )}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={downloadPdf}>
              {busy ? 'Preparing…' : 'Download PDF'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
