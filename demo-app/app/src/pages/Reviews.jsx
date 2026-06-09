// Reviews & Reputation hub: live Google rating + recent reviews (Places API),
// the Google Business Profile integration stub (pending Google's API approval),
// and a manual Indeed count (no Indeed API exists).
//
// In the sales demo the live Places fetch is dead-ended (no /api) — we feed a
// seeded snapshot instead so the surface looks populated. Per-client product
// builds hit the real /api/settings/google-reviews endpoint.
import { useEffect, useState } from 'react';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectReviews } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { IS_DEMO } from '../demo/isDemo';

// Seeded Google snapshot for the demo (no live Places API call). Mirrors the
// shape the real /api/settings/google-reviews endpoint returns.
const DEMO_GOOGLE = {
  rating: 4.8,
  count: 127,
  url: null,
  configured: true,
  reviews: [
    { author: 'Morgan H.', rating: 5, when: '2 weeks ago', text: 'PolishPoint keeps all three of our locations spotless. The crews are reliable and the reporting is genuinely useful.', photo: null },
    { author: 'Dana P.', rating: 5, when: '1 month ago', text: 'Switched from our old janitorial vendor and never looked back — responsive, thorough, and easy to work with.', photo: null },
    { author: 'Sam R.', rating: 4, when: '1 month ago', text: 'Solid service overall. One missed visit early on, but they made it right the same day.', photo: null },
  ],
};

function Stars({ rating }) {
  const full = Math.round(rating || 0);
  return (
    <span style={{ letterSpacing: 1 }}>
      <span style={{ color: '#f59e0b' }}>{'★'.repeat(full)}</span>
      <span style={{ color: '#e2e8f0' }}>{'★'.repeat(Math.max(0, 5 - full))}</span>
    </span>
  );
}

export default function Reviews() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canManage = usePermission('reviews.view');
  const reviews = selectReviews(state);
  const [g, setG] = useState(null);
  const [indeed, setIndeed] = useState(reviews.indeedActual ?? 0);

  useEffect(() => {
    // Demo: serve a seeded snapshot; the live Places fetch is dead-ended.
    if (IS_DEMO) { setG(DEMO_GOOGLE); return; }
    let alive = true;
    fetch('/api/settings/google-reviews').then((r) => r.json()).then((d) => { if (alive && d) setG(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  function saveIndeed() {
    dispatch({ type: ACTIONS.SET_REVIEWS, patch: { indeedActual: Number(indeed) || 0 } });
    toast.success('Indeed count saved');
  }

  return (
    <div className="page">
      <div className="page-head"><h1>Reviews &amp; Reputation</h1><p className="page-sub">Your live Google rating, recent reviews, and reputation tools.</p></div>

      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="text-xs text-muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Google</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
              <span style={{ fontSize: 40, fontWeight: 800, color: '#1e293b' }}>{g?.rating ?? '—'}</span>
              <Stars rating={g?.rating} />
              <span className="text-sm text-muted">{g?.count != null ? `${g.count} reviews` : ''}</span>
            </div>
          </div>
          {g?.url && <a className="btn btn-primary" href={g.url} target="_blank" rel="noreferrer">View on Google</a>}
        </div>
        {g && g.configured === false && <p className="text-sm text-muted" style={{ marginTop: 10 }}>Add <code>GOOGLE_MAPS_API_KEY</code> in Vercel to show the live rating + reviews.</p>}
      </div>

      {g?.reviews?.length > 0 && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <h3 className="dash-card-title">Recent Google reviews</h3>
          {g.reviews.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: i ? '1px solid #eef0f6' : 'none' }}>
              {r.photo ? <img src={r.photo} alt="" style={{ width: 40, height: 40, borderRadius: 99 }} /> : <div style={{ width: 40, height: 40, borderRadius: 99, background: '#eef0f6' }} />}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{r.author}</strong><span className="text-xs text-muted">{r.when}</span></div>
                <Stars rating={r.rating} />
                <p className="text-sm" style={{ marginTop: 4 }}>{r.text}</p>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted" style={{ marginTop: 8 }}>Google's API exposes up to 5 reviews. Full review management arrives with the Business Profile connection below.</p>
        </div>
      )}

      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h3 className="dash-card-title" style={{ margin: 0 }}>Google Business Profile <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 99, fontSize: 11, marginLeft: 6 }}>Connecting…</span></h3>
          <button className="btn" disabled>Connect (pending approval)</button>
        </div>
        <p className="text-sm text-muted" style={{ marginTop: 8 }}>Once Google approves your Business Profile API access, this unlocks the full review feed, replying to reviews in-app, and performance insights below. The access request is in progress.</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          {['Profile views', 'Searches', 'Calls', 'Directions'].map((m) => (
            <div key={m} style={{ flex: '1 1 120px', background: '#f8fafc', borderRadius: 8, padding: '12px 14px' }}>
              <div className="stat-val" style={{ color: '#cbd5e1' }}>—</div>
              <div className="stat-label">{m}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card detail-card">
        <h3 className="dash-card-title">Indeed reviews</h3>
        <p className="text-sm text-muted" style={{ marginBottom: 10 }}>Indeed has no public API, so update your review count here manually — it feeds the dashboard goal.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="number" min="0" value={indeed} onChange={(e) => setIndeed(e.target.value)} disabled={!canManage} style={{ width: 120, padding: '8px 10px', border: '1px solid #d0d3e2', borderRadius: 8 }} />
          {canManage && <button className="btn btn-primary" onClick={saveIndeed}>Save</button>}
        </div>
      </div>
    </div>
  );
}
