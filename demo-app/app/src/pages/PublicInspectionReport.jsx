// Client-facing inspection report — the "send my client proof the building was
// inspected and scored 94%" artifact. Renders OUTSIDE the app shell (no sidebar,
// no auth) at /inspect/:token. The token is the capability; it resolves a seeded
// inspection from the fail-safe qualityStore.
import { useParams } from 'react-router-dom';
import Badge from '../components/Badge';
import { useStore } from '../store';
import { selectCompany } from '../store/selectors';
import { getInspection } from '../demo/quality/qualityStore';
import { resultBadgeVariant, resultLabel } from '../lib/inspections';
import { fmtDate } from '../lib/dates';
import './quality/quality.css';

function ItemRating({ item, scale }) {
  const r = item.rating;
  if (r === 'pass') return <Badge variant="green">Pass</Badge>;
  if (r === 'fail') return <Badge variant="red">Fail</Badge>;
  if (r === 'na' || r == null || r === '') return <span className="qc-muted">N/A</span>;
  if (scale.type === 'numeric') return <Badge variant="blue">{r} / {scale.max || 5}</Badge>;
  return <span>{String(r)}</span>;
}

export default function PublicInspectionReport() {
  const { token } = useParams();
  const company = selectCompany(useStore());
  const insp = getInspection(token);

  if (!insp) {
    return (
      <div className="qc-public">
        <div className="qc-public-card" style={{ textAlign: 'center' }}>
          <h2>Report not found</h2>
          <p className="qc-muted">This inspection link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="qc-public">
      <div className="qc-public-brand">
        {company?.logoInitials ? <span className="qc-tmpl-icon" style={{ width: 32, height: 32 }}>{company.logoInitials}</span> : null}
        {company?.name || 'PolishPoint'}
      </div>
      <div className="qc-public-card">
        <div className="qc-public-hero">
          <div className={`qc-score qc-score-lg ${resultBadgeVariant(insp.result)}`}>{insp.overallScore == null ? '—' : `${insp.overallScore}%`}</div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{insp.siteName}</div>
            <div className="qc-muted">{insp.clientName}</div>
            <div style={{ marginTop: 6 }}><Badge variant={resultBadgeVariant(insp.result)}>{resultLabel(insp.result)}</Badge></div>
            <div className="qc-muted" style={{ marginTop: 6, fontSize: 13 }}>{insp.templateName} · inspected by {insp.inspectorName} · {fmtDate(insp.date)}</div>
          </div>
        </div>

        {insp.areas.map((a) => (
          <div key={a.id} className="qc-area">
            <div className="qc-area-head">{a.label}</div>
            {a.items.map((it) => (
              <div key={it.id} className="qc-item">
                <div className="qc-item-main">
                  {it.label}
                  {it.comment ? <div className="qc-item-note">{it.comment}</div> : null}
                </div>
                {it.photo && <span className="qc-photo-chip">📷 photo</span>}
                <ItemRating item={it} scale={insp.scale} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="qc-public-foot">Quality report shared by {company?.name || 'PolishPoint'} · generated automatically from the nightly inspection.</div>
    </div>
  );
}
