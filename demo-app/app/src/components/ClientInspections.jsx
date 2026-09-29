import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import Badge from './Badge';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import InspectionReportModal from './InspectionReportModal';
import { useStore } from '../store';
import { selectSiteById } from '../store/selectors';
import { summarizeInspections, resultBadgeVariant, resultLabel } from '../lib/inspections';
import { fmtDate } from '../lib/dates';
import { searchRows } from '../lib/searchRows';
import * as qcApi from '../lib/qcApi';
import { usePagedRows } from '../hooks/usePagedRows';
import { useTableSearch } from '../hooks/useTableSearch';
import ListPager from './ListPager';
import { canRetryError } from '../pages/reports/reportKit';

// Small recent-vs-prior trend indicator for an average inspection score.
function TrendArrow({ delta }) {
  if (delta == null || delta === 0) return <span className="text-muted text-xs">flat</span>;
  const up = delta > 0;
  return (
    <span className="text-xs" style={{ color: up ? 'var(--success)' : 'var(--danger)' }} title="Newer half vs older half">
      <Icon name={up ? 'chevronUp' : 'chevronDown'} size={11} /> {up ? '+' : '−'}{Math.abs(delta)} pts
    </span>
  );
}

const LOADING = { rows: null, truncated: false, error: null };

// Inspection history for an account, surfaced as a sub-tab of the client's Activity
// tab. Shows the overall quality score + trend, THEN the individual inspection
// records (who inspected, when, score, result, open the report), and a per-location
// rollup when the account spans multiple sites. Read-only; inspections are performed
// under Quality. Records carry `inspector_name` denormalized, so "who" needs no join.
export default function ClientInspections({ client }) {
  const state = useStore();
  // Read BY CUSTOMER — the server filters. This tab used to take the org's newest 200
  // and keep this customer's rows, so once the org passed 200 an account's older
  // inspections (or all of them) vanished from its own tab. It is a newest-N list:
  // `truncated` = the account has more than the list holds, and a note above the figures
  // says so (UI_RULES §117). `rows` is null while loading; a failed read is an error with Try
  // again, never "No inspections recorded".
  const [{ rows: inspections, truncated, error }, setLoad] = useState(LOADING);
  const [reloadKey, setReloadKey] = useState(0);
  const [reportId, setReportId] = useState(null); // inspection whose report modal is open
  useEffect(() => {
    let alive = true;
    qcApi.listInspections({ clientId: client.id })
      .then((r) => { if (alive) setLoad({ rows: r.inspections, truncated: r.truncated, error: null }); })
      .catch((e) => { if (alive) setLoad({ rows: null, truncated: false, error: e }); });
    return () => { alive = false; };
  }, [client.id, reloadKey]);
  const retry = () => { setLoad(LOADING); setReloadKey((k) => k + 1); };

  const siteName = useCallback(
    (r) => (r.site_id ? selectSiteById(state, r.site_id)?.name : null) || r.site_name || 'No location',
    [state],
  );

  // Individual inspection records, newest first — the detail the Activity tab needs.
  const detailRows = useMemo(
    () => (inspections || []).slice().sort((a, b) => new Date(b.performed_at || 0) - new Date(a.performed_at || 0)),
    [inspections],
  );

  // Per-site quality rollup (avg score + recent-vs-prior trend), plus an account total.
  const quality = useMemo(() => {
    const recs = inspections || [];
    const bySite = new Map();
    for (const r of recs) {
      const sid = r.site_id || '__none__';
      if (!bySite.has(sid)) bySite.set(sid, []);
      bySite.get(sid).push(r);
    }
    const rows = [...bySite.entries()].map(([sid, list]) => ({
      siteId: sid === '__none__' ? null : sid,
      siteName: sid === '__none__' ? (list[0]?.site_name || 'No location') : (selectSiteById(state, sid)?.name || list[0]?.site_name || 'Location'),
      ...summarizeInspections(list),
    })).sort((a, b) => b.count - a.count);
    return { rows, total: summarizeInspections(recs) };
  }, [inspections, state]);

  // URL-backed search over location name, key 'qq' so it does not collide with the
  // TimeClockHistory punch search that renders on the same scrolling page. Filters
  // both the detail list and the per-location rollup.
  const [q, setQ] = useTableSearch('qq');
  const filteredDetailRows = searchRows(detailRows, q, siteName);
  const filteredQualityRows = searchRows(quality.rows, q, (r) => r.siteName || '');
  const detailPager = usePagedRows(filteredDetailRows, { resetKey: `${client.id}|detail|${q}` });
  const qualityPager = usePagedRows(filteredQualityRows, { resetKey: `${client.id}|${q}` });

  return (
    <div>
      <div className="table-head">
        <h3 className="table-head-title">Inspections</h3>
        {inspections !== null && detailRows.length > 0 && (
          <div className="table-controls">
            <TableSearch value={q} onChange={setQ} placeholder="Search locations" ariaLabel="Search locations" />
            {q.trim() && <span className="table-count">{filteredDetailRows.length} of {detailRows.length}</span>}
          </div>
        )}
      </div>
      {error ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title="Couldn’t load inspections"
          message={error.message || 'Check your connection and try again.'}
          action={canRetryError(error) ? <button type="button" className="btn btn-primary" onClick={retry}>Try again</button> : null}
        />
      ) : inspections === null ? (
        <p className="text-sm text-muted">Loading inspection history…</p>
      ) : detailRows.length === 0 ? (
        <p className="text-sm text-muted">No inspections recorded for this account yet · <Link className="linklike" to="/inspections">perform one</Link>.</p>
      ) : (
        <>
          {/* Capped: said ONCE, above every figure, in visible text (a tooltip never shows on
              a phone). The score, trend and both tables are all computed from this list. */}
          {truncated && (
            <p className="text-sm text-muted" style={{ marginBottom: 'var(--space-3)' }}>Showing the newest {inspections.length} inspections. The score, trend and tables below cover only these.</p>
          )}
          <div className="inline-edit-grid">
            <label className="inline-edit-label">Overall score</label>
            <div className="inline-edit-value" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{quality.total.avgScore != null ? `${quality.total.avgScore}%` : '—'}</strong>
              <TrendArrow delta={quality.total.delta} />
              {/* "scored": the average counts submitted, scored records only, while the list
                  (and its pager) also holds drafts, so a bare "inspections" disagreed with it. */}
              <span className="text-xs text-muted">{quality.total.count} scored inspection{quality.total.count === 1 ? '' : 's'}{quality.total.failCount > 0 ? ` · ${quality.total.failCount} failed/follow-up` : ''}</span>
            </div>
          </div>

          {/* The individual inspections — who, when, score, result, open the report. */}
          {filteredDetailRows.length === 0 ? (
            <EmptyState icon={<Icon name="search" size={28} />} title="No matching inspections" message={`Nothing matches “${q}”.`} />
          ) : (
            <>
              {/* mobile-stack (UI_RULES §24): a plain .table-wrap is hidden at phone width. */}
              <div className="table-wrap mobile-stack" style={{ marginTop: 'var(--space-3)' }}>
                <table>
                  <thead><tr><th>Date</th><th>Location</th><th>Inspector</th><th>Score</th><th>Result</th><th aria-label="Report" /></tr></thead>
                  <tbody>
                    {detailPager.pageRows.map((r) => (
                      <tr key={r.id}>
                        <td className="cell-primary" data-label="Date" style={{ whiteSpace: 'nowrap' }}>{r.performed_at ? fmtDate(r.performed_at) : '—'}</td>
                        <td data-label="Location"><span className="truncate" title={siteName(r)}>{siteName(r)}</span></td>
                        <td data-label="Inspector"><span className="truncate" title={r.inspector_name || ''}>{r.inspector_name || '—'}</span></td>
                        <td data-label="Score">{r.overall_score != null ? `${r.overall_score}%` : <span className="text-muted">—</span>}</td>
                        <td data-label="Result">{r.result ? <Badge variant={resultBadgeVariant(r.result)}>{resultLabel(r.result)}</Badge> : <span className="text-muted">Draft</span>}</td>
                        <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {r.status === 'submitted' && (
                            <button type="button" className="btn btn-link btn-sm" onClick={() => setReportId(r.id)}>View report</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPager pager={detailPager} noun="inspections" />
            </>
          )}

          {/* Per-location quality rollup when the account spans multiple sites. */}
          {quality.rows.length > 1 && filteredQualityRows.length > 0 && (
            <>
              <div className="table-head" style={{ marginTop: 'var(--space-4)' }}><h3 className="table-head-title">By location</h3></div>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead><tr><th>Location</th><th>Inspections</th><th>Avg score</th><th>Trend</th></tr></thead>
                  <tbody>
                    {qualityPager.pageRows.map((r) => (
                      <tr key={r.siteId || '__none__'}>
                        <td className="cell-primary"><span className="truncate" title={r.siteName}>{r.siteName}</span></td>
                        <td data-label="Inspections">{r.count}</td>
                        <td data-label="Avg score">{r.avgScore != null ? `${r.avgScore}%` : '—'}</td>
                        <td data-label="Trend"><TrendArrow delta={r.delta} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPager pager={qualityPager} noun="locations" />
            </>
          )}
        </>
      )}

      <InspectionReportModal open={!!reportId} inspectionId={reportId} onClose={() => setReportId(null)} />
    </div>
  );
}
