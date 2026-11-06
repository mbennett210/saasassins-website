// Public, read-only inspection report at /inspect/:token (no auth, no app shell —
// the quotes/forms public-link pattern). Renders the SAME self-contained document as
// the in-app report modal and the server PDF (lib/inspectionReportTemplate), so the
// shared link, the in-app view, and the downloaded PDF are byte-for-byte the same
// layout — now including per-section photos. "Download PDF" hits the public,
// token-scoped PDF endpoint. See CLEANSPACE_SWEPT.md §5.6.
//
// WHY THERE IS NO REPORT, told apart (like the QR scan page, PublicAreaScan): a 404 — or a link
// with no token, a 400 — means the link names no report the customer may read ("not found"); a
// 503 (the route could not load it just now, CS-648), any other answer, or no answer at all (no
// signal) is a try-again sentence with a Try again button. It said "Report not found" for all of
// them. The words are catalog lines rendered in English: the page is the customer's (LANG-8).
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { english } from '../i18n/core';
import { getPublicInspection, downloadPublicInspectionPdf } from '../lib/qcApi';
import { buildInspectionReportHtml } from '../lib/inspectionReportTemplate';

// The answers that mean the link names no report; anything else is "try again".
const NOT_FOUND_STATUSES = new Set([400, 404]);

function Card({ children }) {
  return <div className="public-report"><div className="public-report-card">{children}</div></div>;
}

export default function PublicInspection() {
  const { token } = useParams();
  // loading | ready | not-found | unavailable
  const [view, setView] = useState({ status: 'loading' });
  const [dlBusy, setDlBusy] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setView({ status: 'loading' });
    getPublicInspection(token)
      .then((report) => { if (alive) setView(report ? { status: 'ready', report } : { status: 'not-found' }); })
      .catch((e) => { if (alive) setView({ status: NOT_FOUND_STATUSES.has(Number(e?.status)) ? 'not-found' : 'unavailable' }); });
    return () => { alive = false; };
  }, [token]);
  useEffect(() => load(), [load]);

  if (view.status === 'loading') return <Card>{english('common.loading')}</Card>;
  if (view.status === 'not-found') {
    return (
      <Card>
        <h1>{english('publicReport.notFound.title')}</h1>
        <p className="text-muted">{english('publicReport.notFound.body')}</p>
      </Card>
    );
  }
  if (view.status === 'unavailable') {
    return (
      <Card>
        <h1>{english('publicReport.unavailable.title')}</h1>
        <p className="text-muted">{english('publicReport.unavailable.body')}</p>
        <button type="button" className="btn btn-primary" onClick={load}>{english('publicReport.tryAgain')}</button>
      </Card>
    );
  }

  const download = async () => {
    setDlBusy(true);
    try { await downloadPublicInspectionPdf(token); }
    catch (e) { window.alert(e?.message || english('publicReport.downloadFailed')); }
    finally { setDlBusy(false); }
  };

  return (
    <div className="public-report">
      <div className="public-report-doc-wrap">
        <div className="public-report-bar">
          <button type="button" className="btn btn-primary" disabled={dlBusy} onClick={download}>
            {dlBusy ? english('publicReport.preparing') : english('publicReport.download')}
          </button>
        </div>
        <div className="ir-paper" dangerouslySetInnerHTML={{ __html: buildInspectionReportHtml(view.report) }} />
      </div>
    </div>
  );
}
