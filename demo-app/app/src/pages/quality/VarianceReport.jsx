// Labor Variance — the manager "morning scan". Actual clocked labor vs the
// per-account expected time, per clean, multi-cleaner-attributed, flagged
// over/under. Renders from the seeded time entries via the pure variance engine
// (the same one the Rainier product runs server-side), so the demo numbers are
// real, not faked.
//
// The table carries `mobile-stack` + per-<td> `data-label` so it re-flows into
// cards on phones (the demo hides bare .table-wrap tables ≤640px) — see
// mobileParity.css.
import { Fragment, useReducer, useEffect, useState } from 'react';
import Badge from '../../components/Badge';
import { useToast } from '../../components/Toast';
import { usePermission } from '../../hooks/usePermission';
import { getVarianceReport, getOpsSettings, subscribe } from '../../demo/quality/qualityStore';
import { flagBadgeVariant, flagLabel, fmtMins } from '../../lib/variance';

function geofenceBadge(result) {
  if (result === 'inside') return <Badge variant="green">On-site</Badge>;
  if (result === 'override') return <Badge variant="amber">Off-site · override</Badge>;
  if (result === 'outside') return <Badge variant="red">Off-site</Badge>;
  return <Badge variant="slate">No GPS</Badge>;
}
function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return '—'; }
}
function VarianceCell({ row }) {
  if (row.flag === 'incomplete') return <span className="qc-var muted">In progress</span>;
  if (row.flag === 'no_baseline') return <span className="qc-var muted">No baseline</span>;
  const cls = row.flag === 'over' ? 'over' : row.flag === 'under' ? 'under' : 'on_target';
  const sign = row.variance > 0 ? '+' : '';
  return <span className={`qc-var ${cls}`}>{sign}{fmtMins(row.variance)}</span>;
}

export default function VarianceReport() {
  const toast = useToast();
  const canExport = usePermission('variance.export');
  const canAct = usePermission('variance.actions');
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(force), []);
  const [expanded, setExpanded] = useState(() => new Set());

  const ops = getOpsSettings();
  const { rows, summary } = getVarianceReport();
  const live = rows.filter((r) => r.flag === 'incomplete');
  const toggle = (k) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  function exportCsv() {
    const head = ['Site', 'Client', 'Cleaners', 'Expected (min)', 'Actual labor (min)', 'Variance (min)', 'Flag'];
    const body = rows.map((r) => [
      r.siteName, r.clientName,
      r.cleaners.map((c) => `${c.userName} ${c.durationMinutes}m`).join('; '),
      r.expectedMinutes ?? '', r.actualMinutes ?? '', r.variance ?? '', flagLabel(r.flag),
    ]);
    const csv = [head, ...body].map((line) => line.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'labor-variance.csv'; a.click();
    URL.revokeObjectURL(url);
    toast.success('Variance report exported');
  }

  return (
    <div>
      <div className="qc-chips">
        <div className="qc-chip"><div className="qc-chip-val">{summary.cleanCount}</div><div className="qc-chip-label">Cleans</div></div>
        <div className="qc-chip"><div className="qc-chip-val" style={{ color: summary.flaggedCount ? '#dc2626' : undefined }}>{summary.flaggedCount}</div><div className="qc-chip-label">Flagged</div></div>
        <div className="qc-chip"><div className="qc-chip-val">{summary.overCount}</div><div className="qc-chip-label">Over time</div></div>
        <div className="qc-chip"><div className="qc-chip-val">{summary.underCount}</div><div className="qc-chip-label">Under time</div></div>
        <div className="qc-chip"><div className="qc-chip-val">{summary.avgVarianceMins == null ? '—' : `${summary.avgVarianceMins > 0 ? '+' : ''}${fmtMins(summary.avgVarianceMins)}`}</div><div className="qc-chip-label">Avg variance</div></div>
        <div className="qc-chip"><div className="qc-chip-val">{fmtMins(summary.totalLaborMinutes)}</div><div className="qc-chip-label">Total labor</div></div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          Last night's cleans — actual labor vs each account's expected time. Basis: <strong>{ops.basis === 'labor' ? 'labor-minutes' : 'wall-clock'}</strong> · threshold ±{ops.thresholds.overMins}m.
        </p>
        {canExport && <button className="btn btn-outline btn-sm" onClick={exportCsv}>Export CSV</button>}
      </div>

      {live.length > 0 && (
        <div className="qc-live">
          {live.map((r) => (
            <div key={r.key} className="qc-live-card">
              <span className="qc-live-dot" />
              <strong>{r.siteName}</strong> — {r.cleaners.map((c) => c.userName).join(', ')} on the clock now
            </div>
          ))}
        </div>
      )}

      <div className="table-wrap mobile-stack">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}></th>
              <th>Site / Client</th>
              <th>Cleaners</th>
              <th>Expected</th>
              <th>Actual labor</th>
              <th>Variance</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = expanded.has(r.key);
              const offSite = r.cleaners.some((c) => c.geofenceResult && c.geofenceResult !== 'inside');
              return (
                <Fragment key={r.key}>
                  <tr className="qc-row-toggle" onClick={() => toggle(r.key)}>
                    <td className="cell-chevron"><span className={`qc-chevron ${open ? 'open' : ''}`}>›</span></td>
                    <td className="cell-primary">
                      <div style={{ fontWeight: 600 }}>{r.siteName}</div>
                      <div className="text-xs text-muted">{r.clientName}</div>
                    </td>
                    <td data-label="Cleaners">
                      {r.cleaners.map((c) => c.userName).join(', ')}
                      {r.cleaners.length > 1 && <span className="text-xs text-muted"> · {r.cleaners.length} cleaners</span>}
                      {offSite && <> {geofenceBadge('override')}</>}
                    </td>
                    <td data-label="Expected">{r.expectedMinutes != null ? fmtMins(r.expectedMinutes) : '—'}</td>
                    <td data-label="Actual labor">{r.actualMinutes != null ? fmtMins(r.actualMinutes) : <span className="text-muted">—</span>}</td>
                    <td data-label="Variance"><VarianceCell row={r} /></td>
                    <td data-label="Status"><Badge variant={flagBadgeVariant(r.flag)}>{flagLabel(r.flag)}</Badge></td>
                  </tr>
                  {open && (
                    <tr className="qc-drill">
                      <td className="cell-fullrow" colSpan={7}>
                        <div className="qc-drill-inner">
                          {r.entries.map((e) => (
                            <div key={e.id} className="qc-cleaner">
                              <span className="qc-cleaner-name">{e.userName}</span>
                              <span className="text-sm text-muted">{fmtTime(e.clockInAt)} – {e.clockOutAt ? fmtTime(e.clockOutAt) : 'now'}</span>
                              <span className="text-sm">{e.durationMinutes != null ? fmtMins(e.durationMinutes) : 'on the clock'}</span>
                              {geofenceBadge(e.geofenceResult)}
                              {e.geofenceResult === 'override' && e.distanceM != null && <span className="text-xs text-muted">{Math.round(e.distanceM)}m away</span>}
                              <span style={{ flex: 1 }} />
                              {canAct && (
                                <button
                                  className="btn btn-link btn-sm"
                                  onClick={(ev) => { ev.stopPropagation(); toast.success(`${e.userName}'s entry approved`); }}
                                >
                                  Approve
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
