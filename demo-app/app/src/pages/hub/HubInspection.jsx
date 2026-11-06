import { useState } from 'react';
import { useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { fetchHubInspection, downloadHubInspectionPdf } from '../../lib/clientHubApi';
import { buildInspectionReportHtml } from '../../lib/inspectionReportTemplate';
import { resultLabel } from '../../lib/inspections';
import { useHubRead, hubWhen, RESULT_BADGE } from './hubData';
import { sectionPath } from './hubNav';

// ONE INSPECTION (HUB-6, HUB-7, HUB-10): the full report — every item and the inspector's
// comment on it — exactly as the shared link and the PDF lay it out (the same
// buildInspectionReportHtml over the same projectReport shape), a PDF to keep, and when
// something failed, what we are doing about it: the areas the cleaners on site were sent back
// to redo (HUB-7). The office's own note on an inspection never reaches this page — the
// server never reads it for the hub, and the projection has no place for it (HUB-16).
export default function HubInspection() {
  const { buildingId, inspectionId } = useParams();
  const toast = useToast();
  const read = useHubRead(() => fetchHubInspection(buildingId, inspectionId), [buildingId, inspectionId]);
  const [busy, setBusy] = useState(false);
  const listHref = sectionPath(buildingId, 'inspections');

  if (read.loading) return <p className="text-muted">Loading the report…</p>;
  if (read.error) {
    return (
      <div className="hub-page">
        <BackLink to={listHref} label="Inspections" />
        {read.status === 404
          ? <EmptyState icon={<Icon name="forms" size={28} />} title="Report not found" message={read.error} />
          : (
            <div className="card hub-card">
              <p className="text-sm">{read.error}</p>
              <button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button>
            </div>
          )}
      </div>
    );
  }

  const ins = read.data.inspection;
  const r = ins.report.inspection;
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try { await downloadHubInspectionPdf(buildingId, inspectionId); }
    catch (e) { toast.error(e?.message || 'The PDF could not be made.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="hub-page">
      <BackLink to={listHref} label="Inspections" />
      <header className="hub-head">
        <h1 className="hub-title">{r.templateName}</h1>
        <div className="hub-badges">
          <Badge variant={RESULT_BADGE[r.result] || 'slate'}>{resultLabel(r.result)}{r.overallScore != null ? ` · ${r.overallScore}%` : ''}</Badge>
        </div>
        <div className="hub-head-sub text-xs text-muted">{hubWhen(r.performedAt)}</div>
      </header>

      {ins.redo && (
        <section className="card hub-card hub-redo">
          <div className="hub-sup-label text-xs">What we are doing about it</div>
          <p className="text-sm">The cleaners on site were sent back to redo <strong>{ins.redo.sentence}</strong>:</p>
          <ul className="hub-redo-list text-sm">
            {ins.redo.areas.map((a) => (
              <li key={a.label}><strong>{a.label}:</strong> {a.items.join(', ')}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="hub-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={download}>
          {busy ? 'Preparing the PDF…' : 'Download PDF'}
        </button>
      </div>

      <div className="ir-paper hub-report" dangerouslySetInnerHTML={{ __html: buildInspectionReportHtml(ins.report) }} />
    </div>
  );
}
