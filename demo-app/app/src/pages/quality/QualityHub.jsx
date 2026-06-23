// Quality Control hub — the Swept-replacement heart, ported into the demo.
// Four tabs: Inspections (scored records), Variance (the labor morning-scan),
// Problems (cross-account punch-list), Templates. Fully clickable and seeded;
// data lives in the fail-safe pp.qc.* localStorage layer (qualityStore), so none
// of this touches the main store.
//
// Tables carry `mobile-stack` + per-<td> `data-label` so they re-flow into cards
// on phones (the demo hides bare .table-wrap tables ≤640px) — see mobileParity.css.
import { useReducer, useEffect, useMemo, useState } from 'react';
import Badge from '../../components/Badge';
import Modal from '../../components/Modal';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { usePermission } from '../../hooks/usePermission';
import { fmtDate } from '../../lib/dates';
import {
  listInspections, listProblems, listTemplates, setProblemStatus, addInspection,
  openProblemCount, getVarianceReport, subscribe,
} from '../../demo/quality/qualityStore';
import { resultBadgeVariant, resultLabel, flattenItems, scoreInspection } from '../../lib/inspections';
import VarianceReport from './VarianceReport';
import './quality.css';

const SEVERITY = { high: { label: 'High', variant: 'red' }, medium: { label: 'Medium', variant: 'amber' }, low: { label: 'Low', variant: 'slate' } };
const PROBLEM_STATUS = { open: { label: 'Open', variant: 'red' }, acknowledged: { label: 'Acknowledged', variant: 'blue' }, resolved: { label: 'Resolved', variant: 'green' } };

function publicUrl(token) {
  return `${window.location.origin}${import.meta.env.BASE_URL}inspect/${token}`;
}

function ItemRating({ item, scale }) {
  const r = item.rating;
  if (r === 'pass') return <Badge variant="green">Pass</Badge>;
  if (r === 'fail') return <Badge variant="red">Fail</Badge>;
  if (r === 'na' || r == null || r === '') return <span className="qc-muted">N/A</span>;
  if (scale.type === 'numeric') return <Badge variant="blue">{r} / {scale.max || 5}</Badge>;
  return <span>{String(r)}</span>;
}

function RatingControl({ scale, value, onChange }) {
  if (scale.type === 'numeric') {
    const max = scale.max || 5;
    return (
      <div className="qc-rate">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <button key={n} className={Number(value) === n ? 'on-num' : ''} onClick={() => onChange(n)}>{n}</button>
        ))}
        <button className={value === 'na' ? 'on-na' : ''} onClick={() => onChange('na')}>N/A</button>
      </div>
    );
  }
  return (
    <div className="qc-rate">
      <button className={value === 'pass' ? 'on-pass' : ''} onClick={() => onChange('pass')}>Pass</button>
      <button className={value === 'fail' ? 'on-fail' : ''} onClick={() => onChange('fail')}>Fail</button>
      <button className={value === 'na' ? 'on-na' : ''} onClick={() => onChange('na')}>N/A</button>
    </div>
  );
}

export default function QualityHub({ defaultTab = 'inspections' }) {
  const toast = useToast();
  const canInspect = usePermission('qc.inspect');
  const canManageProblems = usePermission('problems.manage');
  const canShare = usePermission('qc.share');
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(force), []);

  const [tab, setTab] = useState(defaultTab);
  const [detail, setDetail] = useState(null); // selected inspection
  const [fill, setFill] = useState(null); // new-inspection draft

  const inspections = listInspections();
  const problems = listProblems();
  const templates = listTemplates();
  const openProblems = openProblemCount();
  const variance = getVarianceReport();

  const scored = inspections.filter((i) => typeof i.overallScore === 'number');
  const avgScore = scored.length ? Math.round(scored.reduce((s, i) => s + i.overallScore, 0) / scored.length) : null;
  const passCount = inspections.filter((i) => i.result === 'pass').length;

  // ── new-inspection (fill) flow ──
  function startFill() {
    const t = templates[0];
    setFill({ templateId: t.id, siteName: '', clientName: '', inspectorName: 'You', ratings: {} });
  }
  const fillTemplate = fill ? templates.find((t) => t.id === fill.templateId) : null;
  const fillAreas = useMemo(() => {
    if (!fillTemplate) return [];
    return fillTemplate.areas.map((a) => ({
      id: a.id, label: a.label,
      items: a.items.map((it) => ({ id: it.id, label: it.label, rating: fill.ratings[it.id] ?? 'na', comment: '', photo: false })),
    }));
  }, [fill, fillTemplate]);
  const fillPreview = fillTemplate ? scoreInspection(flattenItems(fillAreas), fillTemplate.scale) : null;

  function submitFill() {
    if (!fill.siteName.trim()) { toast.error('Enter a site name.'); return; }
    addInspection({
      template: fillTemplate,
      siteName: fill.siteName.trim(),
      clientName: fill.clientName.trim() || '—',
      inspectorName: fill.inspectorName.trim() || 'You',
      areas: fillAreas,
    });
    setFill(null);
    setTab('inspections');
    toast.success('Inspection recorded & scored');
  }

  function copyLink(token) {
    const url = publicUrl(token);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast.success('Client report link copied'), () => toast.success(url));
    else toast.success(url);
  }

  const TABS = [
    { id: 'inspections', label: 'Inspections', count: inspections.length },
    { id: 'variance', label: 'Variance', count: variance.summary.flaggedCount || null },
    { id: 'problems', label: 'Problems', count: openProblems || null },
    { id: 'templates', label: 'Templates', count: templates.length },
  ];

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Quality Control</h1>
          <p className="page-sub">Scored site inspections, labor variance, and the cross-account problems queue — the janitorial quality layer.</p>
        </div>
        {canInspect && tab === 'inspections' && (
          <button className="btn btn-primary" onClick={startFill}><Icon name="plus" size={16} /> New inspection</button>
        )}
      </div>

      <div className="qc-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`qc-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}{t.count != null && <span className="qc-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ── Inspections ── */}
      {tab === 'inspections' && (
        <>
          <div className="qc-chips">
            <div className="qc-chip"><div className="qc-chip-val">{avgScore == null ? '—' : `${avgScore}%`}</div><div className="qc-chip-label">Avg score</div></div>
            <div className="qc-chip"><div className="qc-chip-val">{passCount}/{inspections.length}</div><div className="qc-chip-label">Passing</div></div>
            <div className="qc-chip"><div className="qc-chip-val" style={{ color: openProblems ? '#dc2626' : undefined }}>{openProblems}</div><div className="qc-chip-label">Open problems</div></div>
          </div>
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>Site</th><th>Template</th><th>Inspector</th><th>Date</th><th>Score</th><th>Result</th></tr></thead>
              <tbody>
                {inspections.map((i) => (
                  <tr key={i.id} className="qc-row-toggle" onClick={() => setDetail(i)}>
                    <td className="cell-primary" style={{ fontWeight: 600 }}>{i.siteName}<div className="text-xs text-muted" style={{ fontWeight: 400 }}>{i.clientName}</div></td>
                    <td data-label="Template">{i.templateName}</td>
                    <td data-label="Inspector">{i.inspectorName}</td>
                    <td data-label="Date">{fmtDate(i.date)}</td>
                    <td data-label="Score"><strong>{i.overallScore == null ? '—' : `${i.overallScore}%`}</strong></td>
                    <td data-label="Result"><Badge variant={resultBadgeVariant(i.result)}>{resultLabel(i.result)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Variance ── */}
      {tab === 'variance' && <VarianceReport />}

      {/* ── Problems ── */}
      {tab === 'problems' && (
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th>Issue</th><th>Site</th><th>Severity</th><th>Status</th><th>Reported</th><th></th></tr></thead>
            <tbody>
              {problems.map((p) => (
                <tr key={p.id}>
                  <td className="cell-primary" style={{ fontWeight: 600 }}>{p.title}{p.note ? <div className="text-xs text-muted" style={{ fontWeight: 400, marginTop: 2 }}>{p.note}</div> : null}</td>
                  <td data-label="Site">{p.siteName}<div className="text-xs text-muted">{p.clientName}</div></td>
                  <td data-label="Severity"><Badge variant={SEVERITY[p.severity]?.variant || 'slate'}>{SEVERITY[p.severity]?.label || p.severity}</Badge></td>
                  <td data-label="Status"><Badge variant={PROBLEM_STATUS[p.status]?.variant || 'slate'}>{PROBLEM_STATUS[p.status]?.label || p.status}</Badge></td>
                  <td data-label="Reported">{p.reportedBy}<div className="text-xs text-muted">{fmtDate(p.date)}</div></td>
                  <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canManageProblems && p.status !== 'resolved' && <button className="btn btn-link btn-sm" onClick={() => { setProblemStatus(p.id, 'resolved'); toast.success('Problem resolved'); }}>Resolve</button>}
                    {canManageProblems && p.status === 'resolved' && <button className="btn btn-link btn-sm" onClick={() => { setProblemStatus(p.id, 'open'); toast.success('Problem reopened'); }}>Reopen</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Templates ── */}
      {tab === 'templates' && (
        <div className="card detail-card">
          {templates.map((t) => {
            const itemCount = flattenItems(t.areas).length;
            return (
              <div key={t.id} className="qc-tmpl">
                <div className="qc-tmpl-icon">{t.scale.type === 'numeric' ? '🔢' : '✓'}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div className="text-xs text-muted">{t.areas.length} areas · {itemCount} items · {t.scale.type === 'numeric' ? `numeric / ${t.scale.max}` : 'pass-fail'} · pass ≥ {t.scale.passThreshold}%</div>
                </div>
                <span className="text-xs text-muted">v{t.version}</span>
                <Badge variant="green">Published</Badge>
              </div>
            );
          })}
          <p className="text-xs text-muted" style={{ marginTop: 12 }}>Templates are versioned — publishing freezes the structure so submitted inspections never drift. (Drag-to-build editor available in the full build.)</p>
        </div>
      )}

      {/* ── inspection detail ── */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.siteName} — inspection` : ''}>
        {detail && (
          <div>
            <div className="qc-public-hero">
              <div className={`qc-score qc-score-lg ${resultBadgeVariant(detail.result)}`}>{detail.overallScore == null ? '—' : `${detail.overallScore}%`}</div>
              <div>
                <Badge variant={resultBadgeVariant(detail.result)}>{resultLabel(detail.result)}</Badge>
                <div style={{ marginTop: 6, fontWeight: 600 }}>{detail.templateName}</div>
                <div className="text-sm text-muted">{detail.inspectorName} · {fmtDate(detail.date)}</div>
                <div className="text-sm text-muted">{detail.clientName}</div>
              </div>
            </div>
            {detail.areas.map((a) => (
              <div key={a.id} className="qc-area">
                <div className="qc-area-head">{a.label}</div>
                {a.items.map((it) => (
                  <div key={it.id} className="qc-item">
                    <div className="qc-item-main">
                      {it.label}
                      {it.comment ? <div className="qc-item-note">{it.comment}</div> : null}
                    </div>
                    {it.photo && <span className="qc-photo-chip">📷 photo</span>}
                    <ItemRating item={it} scale={detail.scale} />
                  </div>
                ))}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
              {canShare && <button className="btn btn-outline btn-sm" onClick={() => copyLink(detail.token)}>Copy client link</button>}
              <a className="btn btn-primary btn-sm" href={publicUrl(detail.token)} target="_blank" rel="noreferrer">View as client report ↗</a>
            </div>
          </div>
        )}
      </Modal>

      {/* ── new inspection (fill) ── */}
      <Modal open={!!fill} onClose={() => setFill(null)} title="Perform an inspection">
        {fill && fillTemplate && (
          <div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <label style={{ flex: '1 1 200px' }}>
                <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Template</div>
                <select value={fill.templateId} onChange={(e) => setFill((f) => ({ ...f, templateId: e.target.value, ratings: {} }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d0d3e2', borderRadius: 8 }}>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label style={{ flex: '1 1 160px' }}>
                <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Site</div>
                <input value={fill.siteName} onChange={(e) => setFill((f) => ({ ...f, siteName: e.target.value }))} placeholder="e.g. Riverside Medical" style={{ width: '100%', padding: '8px 10px', border: '1px solid #d0d3e2', borderRadius: 8 }} />
              </label>
              <label style={{ flex: '1 1 160px' }}>
                <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Client (optional)</div>
                <input value={fill.clientName} onChange={(e) => setFill((f) => ({ ...f, clientName: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d0d3e2', borderRadius: 8 }} />
              </label>
            </div>

            {fillTemplate.areas.map((a) => (
              <div key={a.id} className="qc-area">
                <div className="qc-area-head">{a.label}</div>
                {a.items.map((it) => (
                  <div key={it.id} className="qc-item">
                    <div className="qc-item-main">{it.label}</div>
                    <RatingControl scale={fillTemplate.scale} value={fill.ratings[it.id]} onChange={(v) => setFill((f) => ({ ...f, ratings: { ...f.ratings, [it.id]: v } }))} />
                  </div>
                ))}
              </div>
            ))}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className={`qc-score ${resultBadgeVariant(fillPreview.result)}`}>{fillPreview.overallScore == null ? '—' : `${fillPreview.overallScore}%`}</div>
                <div className="text-sm text-muted">Live score preview</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => setFill(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={submitFill}>Submit & score</button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
