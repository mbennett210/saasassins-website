// Public, read-only inspection report at /inspect/:token (no auth, no app shell —
// the quotes/forms public-link pattern). Renders the SAME self-contained document as
// the in-app report modal and the server PDF (lib/inspectionReportTemplate), so the
// shared link, the in-app view, and the downloaded PDF are byte-for-byte the same
// layout — now including per-section photos. "Download PDF" hits the public,
// token-scoped PDF endpoint. See CLEANSPACE_SWEPT.md §5.6.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicInspection, downloadPublicInspectionPdf } from '../lib/qcApi';
import { buildInspectionReportHtml } from '../lib/inspectionReportTemplate';

export default function PublicInspection() {
  const { token } = useParams();
  const [data, setData] = useState(undefined); // undefined = loading, null = not found
  const [dlBusy, setDlBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getPublicInspection(token).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [token]);

  if (data === undefined) return <div className="public-report"><div className="public-report-card">Loading…</div></div>;
  if (!data) return <div className="public-report"><div className="public-report-card"><h1>Report not found</h1><p className="text-muted">This link may be invalid or the inspection hasn’t been submitted.</p></div></div>;

  const download = async () => {
    setDlBusy(true);
    try { await downloadPublicInspectionPdf(token); }
    catch (e) { window.alert(e.message || 'Could not download the PDF'); }
    finally { setDlBusy(false); }
  };

  return (
    <div className="public-report">
      <div className="public-report-doc-wrap">
        <div className="public-report-bar">
          <button type="button" className="btn btn-primary" disabled={dlBusy} onClick={download}>
            {dlBusy ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
        <div className="ir-paper" dangerouslySetInnerHTML={{ __html: buildInspectionReportHtml(data) }} />
      </div>
    </div>
  );
}
