// Local SEO insights — the four Business Profile tiles, review trends computed
// from the synced feed, reply coverage, and Google's search-keyword report.
// Charts are the house hand-rolled flex bars (.rev-chart idiom) — no chart lib.
import { useEffect, useMemo, useState } from 'react';
import { getGmbInsights, getGmbTrends, getGmbKeywords } from '../lib/reviewsApi';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';

const EMPTY = [];

const monthLabel = (key) => {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = Number(String(key).slice(5, 7));
  return names[m - 1] || key;
};

function Bars({ data, title, valueLabel }) {
  // data: [{ label, value, height 0-100, hint }]
  return (
    <div style={{ flex: '1 1 280px' }}>
      <div className="text-sm" style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div className="rev-chart">
        {data.map((d) => (
          <div key={d.label} className="rev-bar-wrap">
            <div className="rev-bar bar-primary" style={{ height: `${d.height}%` }} title={d.hint} />
            <div className="rev-bar-lbl">{d.label}</div>
          </div>
        ))}
      </div>
      {valueLabel && <div className="text-xs text-muted" style={{ marginTop: 4 }}>{valueLabel}</div>}
    </div>
  );
}

export default function GmbInsightsPanel({ connected }) {
  const [insights, setInsights] = useState(null);
  const [trends, setTrends] = useState(null);
  const [keywords, setKeywords] = useState(null);

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    getGmbInsights().then((d) => { if (alive) setInsights(d); }).catch(() => {});
    getGmbTrends().then((d) => { if (alive) setTrends(d); }).catch(() => {});
    getGmbKeywords().then((d) => { if (alive) setKeywords(d); }).catch(() => {});
    return () => { alive = false; };
  }, [connected]);

  const reviewBars = useMemo(() => {
    const months = trends?.months || [];
    const max = Math.max(1, ...months.map((m) => m.count));
    return months.map((m) => ({
      label: monthLabel(m.month),
      height: Math.round((m.count / max) * 100),
      hint: `${m.month}: ${m.count} review${m.count === 1 ? '' : 's'}`,
    }));
  }, [trends]);

  const ratingBars = useMemo(() => {
    const months = trends?.months || [];
    return months.map((m) => ({
      label: monthLabel(m.month),
      height: m.avg ? Math.round((m.avg / 5) * 100) : 0,
      hint: m.avg ? `${m.month}: ${m.avg}★ average` : `${m.month}: no reviews`,
    }));
  }, [trends]);

  const keywordBars = useMemo(() => {
    const months = keywords?.months || [];
    const max = Math.max(1, ...months.map((m) => m.totalImpressions));
    return months.map((m) => ({
      label: monthLabel(m.month),
      height: Math.round((m.totalImpressions / max) * 100),
      hint: `${m.month}: ${m.totalImpressions.toLocaleString()} impressions`,
    }));
  }, [keywords]);

  const kwPager = usePagedRows(keywords?.top || EMPTY, { resetKey: keywords?.latestMonth });

  if (!connected) {
    return <div className="card detail-card"><p className="text-sm text-muted">Connect Google Business Profile above to see performance insights.</p></div>;
  }

  const tiles = [
    { label: 'Profile views', value: insights?.profileViews },
    { label: 'Searches', value: insights?.searches },
    { label: 'Calls', value: insights?.calls },
    { label: 'Directions', value: insights?.directions },
  ];
  const coverage = trends?.replyCoverage;

  return (
    <>
      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <h3 className="dash-card-title">Last 30 days</h3>
        <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
          {tiles.map((t) => (
            <div key={t.label} style={{ flex: '1 1 120px', background: 'var(--color-neutral-50)', borderRadius: 8, padding: '12px 14px' }}>
              <div className="stat-val" style={{ color: t.value != null ? 'var(--text-body)' : 'var(--color-neutral-300)' }}>{t.value != null ? t.value.toLocaleString() : '—'}</div>
              <div className="stat-label">{t.label}</div>
            </div>
          ))}
        </div>
        {coverage && (
          <p className="text-sm text-muted" style={{ marginTop: 10 }}>
            Replied to <strong style={{ color: 'var(--color-neutral-700)' }}>{coverage.replied} of {coverage.total}</strong> reviews
            {coverage.total > 0 && coverage.replied < coverage.total ? '. Replying to every review helps local ranking.' : '.'}
          </p>
        )}
      </div>

      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <h3 className="dash-card-title">Review trends (12 months)</h3>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 8 }}>
          <Bars data={reviewBars} title="New reviews / month" />
          <Bars data={ratingBars} title="Average rating / month" valueLabel="Bar height = rating out of 5★" />
        </div>
      </div>

      <div className="card detail-card">
        <h3 className="dash-card-title">What people searched to find you</h3>
        {keywords === null && <p className="text-sm text-muted">Loading…</p>}
        {keywords && !keywords.latestMonth && (
          <p className="text-sm text-muted">No keyword data yet. Google's keyword report lags about a month behind.</p>
        )}
        {keywords?.latestMonth && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 8 }}>
            <div style={{ flex: '1 1 320px' }}>
              <div className="text-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Top searches · {keywords.latestMonth}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {kwPager.pageRows.map((k) => (
                    <tr key={k.keyword} style={{ borderTop: '1px solid var(--border-light)' }}>
                      <td className="text-sm" style={{ padding: '6px 4px' }}><span className="truncate" title={k.keyword}>{k.keyword}</span></td>
                      <td className="text-sm" style={{ padding: '6px 4px', textAlign: 'right', color: 'var(--text-faint)' }}>
                        {k.thresholded ? `< ${Math.max(k.impressions, 15)}` : k.impressions.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ListPager pager={kwPager} noun="searches" />
              <p className="text-xs text-muted" style={{ marginTop: 6 }}>"&lt; N" = Google withholds exact counts for low-volume searches. Data lags about a month.</p>
            </div>
            <Bars data={keywordBars} title="Search impressions / month" />
          </div>
        )}
      </div>
    </>
  );
}
