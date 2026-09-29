import { useEffect, useState } from 'react';
import Modal from './Modal';
import { useToast } from './Toast';
import { usePermission } from '../hooks/usePermission';
import * as qcApi from '../lib/qcApi';
import { buildInspectionReportHtml } from '../lib/inspectionReportTemplate';

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
    navigator.clipboard?.writeText(`${window.location.origin}/inspect/${ins.publicToken}`);
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
