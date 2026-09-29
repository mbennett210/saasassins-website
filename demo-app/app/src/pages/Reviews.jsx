// Reviews & Reputation hub — the GMB management suite. Tabs (?view=, Variance
// idiom): Reviews (feed + public replies), Posts, Photos, Insights (tiles +
// trends + keywords), Get Reviews (share link/QR/templates). The GBP
// connection card sits ABOVE the tabs — it's the master switch every tab
// depends on.
//
// Permission split (don't re-conflate): `reviews.view` gates the page,
// `reviews.manage` gates everything that touches the public listing —
// connect/disconnect/sync, replies, posts, photos. The server re-checks
// (owner/admin) on every route; this gate is UX, not security.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectReviews } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import GmbPostsPanel from '../components/GmbPostsPanel';
import GmbPhotosPanel from '../components/GmbPhotosPanel';
import GmbInsightsPanel from '../components/GmbInsightsPanel';
import ReviewGrowthPanel from '../components/ReviewGrowthPanel';
import {
  getGmbFeed, connectGmb, listGmbLocations, chooseGmbLocation,
  postGmbReply, deleteGmbReply, syncGmbNow, disconnectGmb,
} from '../lib/reviewsApi';

const VIEWS = ['reviews', 'posts', 'photos', 'insights', 'growth'];
const VIEW_LABELS = { reviews: 'Reviews', posts: 'Posts', photos: 'Photos', insights: 'Insights', growth: 'Get Reviews' };

function Stars({ rating }) {
  const full = Math.round(rating || 0);
  return (
    <span style={{ letterSpacing: 1 }}>
      <span style={{ color: 'var(--rating-star)' }}>{'★'.repeat(full)}</span>
      <span style={{ color: 'var(--rating-star-empty)' }}>{'★'.repeat(Math.max(0, 5 - full))}</span>
    </span>
  );
}

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

// One review row: reviewer, stars, text, the existing public reply, and (for
// reviews.manage) the reply composer. Replies go straight onto the public
// Google listing — the copy says so on every composer.
function ReviewRow({ review, canManage, onReply, onDeleteReply, divider }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(review.reply?.comment || '');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onReply(review.name, text.trim());
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }
  async function removeReply() {
    if (busy) return;
    if (!window.confirm('Remove your public reply from Google?')) return;
    setBusy(true);
    try {
      await onDeleteReply(review.name);
      setText('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: divider ? '1px solid var(--border-light)' : 'none' }}>
      {review.photo
        ? <img src={review.photo} alt="" style={{ width: 40, height: 40, borderRadius: 99 }} />
        : <div style={{ width: 40, height: 40, borderRadius: 99, background: 'var(--color-neutral-100)' }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <strong>{review.reviewer || 'Google user'}</strong>
          <span className="text-xs text-muted">{fmtWhen(review.updateTime)}</span>
        </div>
        <Stars rating={review.rating} />
        {review.comment && <p className="text-sm" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{review.comment}</p>}

        {review.reply && !open && (
          <div style={{ marginTop: 8, background: 'var(--color-neutral-50)', borderRadius: 8, padding: '8px 12px' }}>
            <div className="text-xs text-muted" style={{ fontWeight: 600 }}>Your public reply · {fmtWhen(review.reply.updateTime)}</div>
            <p className="text-sm" style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>{review.reply.comment}</p>
            {canManage && (
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button className="linklike text-xs" onClick={() => { setText(review.reply.comment); setOpen(true); }}>Edit</button>
                <button className="linklike linklike-danger text-xs" onClick={removeReply} disabled={busy}>Remove</button>
              </div>
            )}
          </div>
        )}

        {canManage && !review.reply && !open && (
          <button className="btn btn-link" onClick={() => setOpen(true)}>Reply…</button>
        )}
        {canManage && open && (
          <div style={{ marginTop: 8 }}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="Write your reply…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={send} disabled={busy || !text.trim()}>
                {busy ? 'Posting…' : (review.reply ? 'Update public reply' : 'Post public reply')}
              </button>
              <button className="btn btn-outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <span className="text-xs text-muted">This reply is posted publicly on Google.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Reviews() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canView = usePermission('reviews.view');
  const canManage = usePermission('reviews.manage');
  const reviews = selectReviews(state);
  const [g, setG] = useState(null);
  const [indeed, setIndeed] = useState(reviews.indeedActual ?? 0);

  // Tab state rides the URL (Variance idiom) so tabs deep-link and survive
  // refresh; invalid values collapse to the default.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = VIEWS.includes(searchParams.get('view')) ? searchParams.get('view') : 'reviews';
  const setView = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v === 'reviews') next.delete('view'); else next.set('view', v);
    setSearchParams(next, { replace: true });
  };

  // GBP state: feed carries the connection summary + reviews in one call.
  const [gmb, setGmb] = useState(null);       // null = loading; {connected, ...}
  const [picker, setPicker] = useState(null); // [{name, accountName, locations:[{name,title}]}]
  const [busy, setBusy] = useState(false);

  const loadGmb = useCallback(async () => {
    try {
      const feed = await getGmbFeed();
      setGmb(feed);
    } catch {
      // No backend reachable (offline UI work) — render the disconnected card.
      setGmb({ connected: false, reviews: [], unreachable: true });
    }
  }, []);
  useEffect(() => { loadGmb(); }, [loadGmb]);

  useEffect(() => {
    let alive = true;
    fetch('/api/settings/google-reviews').then((r) => r.json()).then((d) => { if (alive && d) setG(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  function saveIndeed() {
    dispatch({ type: ACTIONS.SET_REVIEWS, patch: { indeedActual: Number(indeed) || 0 } });
    toast.success('Indeed count saved');
  }

  async function handleConnect() {
    setBusy(true);
    try {
      const result = await connectGmb();
      if (result.needsLocation) {
        setPicker(result.accounts || (await listGmbLocations()).accounts);
        toast.success('Connected. Now pick your location');
      } else {
        toast.success(`Connected${result.locationTitle ? ` to ${result.locationTitle}` : ''}`);
      }
      await loadGmb();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePickLocation(accountName, loc) {
    setBusy(true);
    try {
      await chooseGmbLocation({ accountName, locationName: loc.name, locationTitle: loc.title });
      setPicker(null);
      toast.success(`Linked ${loc.title}`);
      await loadGmb();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow() {
    setBusy(true);
    try {
      const r = await syncGmbNow();
      toast.success(`Synced ${r.synced} review${r.synced === 1 ? '' : 's'}`);
      await loadGmb();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm('Disconnect Google Business Profile? The synced review feed is cleared (it re-syncs on reconnect).')) return;
    setBusy(true);
    try {
      await disconnectGmb();
      setPicker(null);
      toast.success('Disconnected');
      await loadGmb();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReply(reviewName, comment) {
    try {
      await postGmbReply(reviewName, comment);
      toast.success('Reply posted publicly on Google');
      await loadGmb();
    } catch (err) {
      toast.error(err.message);
      throw err;
    }
  }

  async function handleDeleteReply(reviewName) {
    try {
      await deleteGmbReply(reviewName);
      toast.success('Public reply removed');
      await loadGmb();
    } catch (err) {
      toast.error(err.message);
      throw err;
    }
  }

  const connected = Boolean(gmb?.connected);
  const needsLocation = connected && gmb.needsLocation;

  return (
    <div className="page">
      <div className="page-head"><h1>Reviews &amp; Reputation</h1><p className="page-sub">Your Google listing: reviews, posts, photos, performance, and growth tools.</p></div>

      {/* ---- Google Business Profile connection (master switch, above the tabs) ---- */}
      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h3 className="dash-card-title" style={{ margin: 0 }}>
            Google Business Profile
            {connected && !needsLocation && gmb.status === 'active' && (
              <span style={{ background: 'var(--color-semantic-success-50)', color: 'var(--color-semantic-success-700)', padding: '2px 8px', borderRadius: 99, fontSize: 11, marginLeft: 6 }}>Connected</span>
            )}
            {connected && gmb.status === 'error' && (
              <span style={{ background: 'var(--color-semantic-error-50)', color: 'var(--color-semantic-error-700)', padding: '2px 8px', borderRadius: 99, fontSize: 11, marginLeft: 6 }}>Error</span>
            )}
          </h3>
          {canManage && !connected && gmb !== null && (
            <button className="btn btn-primary" onClick={handleConnect} disabled={busy}>{busy ? 'Connecting…' : 'Connect Google Business Profile'}</button>
          )}
          {canManage && connected && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleSyncNow} disabled={busy || needsLocation}>{busy ? 'Working…' : 'Sync now'}</button>
              <button className="btn btn-outline" onClick={handleDisconnect} disabled={busy}>Disconnect</button>
            </div>
          )}
        </div>

        {gmb === null && <p className="text-sm text-muted" style={{ marginTop: 8 }}>Checking connection…</p>}

        {gmb !== null && !connected && (
          <p className="text-sm text-muted" style={{ marginTop: 8 }}>
            {canManage
              ? 'Connect the Workspace account that manages your Google listing to unlock the full review feed, replying to reviews from here, and the performance stats below.'
              : 'Not connected yet. An owner or admin can connect the Google listing here.'}
          </p>
        )}

        {connected && (
          <p className="text-sm text-muted" style={{ marginTop: 8 }}>
            {gmb.locationTitle ? <strong style={{ color: 'var(--color-neutral-700)' }}>{gmb.locationTitle}</strong> : 'No location linked yet'}
            {gmb.googleEmail ? ` · ${gmb.googleEmail}` : ''}
            {gmb.lastSyncedAt ? ` · synced ${fmtWhen(gmb.lastSyncedAt)}` : ''}
          </p>
        )}

        {connected && gmb.status === 'error' && gmb.lastError && (
          <p className="text-sm" style={{ marginTop: 8, background: 'var(--color-semantic-error-50)', color: 'var(--color-semantic-error-700)', borderRadius: 8, padding: '8px 12px' }}>{gmb.lastError}</p>
        )}

        {/* Location picker — after consent when the account manages several listings */}
        {canManage && (needsLocation || picker) && (
          <div style={{ marginTop: 12 }}>
            <div className="text-sm" style={{ fontWeight: 600, marginBottom: 6 }}>Pick the listing to manage:</div>
            {(picker || []).map((a) => a.locations.map((loc) => (
              <button key={loc.name} className="btn btn-outline" style={{ marginRight: 8, marginBottom: 8 }} disabled={busy} onClick={() => handlePickLocation(a.name, loc)}>
                {loc.title}
              </button>
            )))}
            {!picker && (
              <button className="btn btn-primary" disabled={busy} onClick={async () => {
                try { setPicker((await listGmbLocations()).accounts); } catch (err) { toast.error(err.message); }
              }}>Load locations</button>
            )}
          </div>
        )}

      </div>

      {/* ---- Tabs ---- */}
      <div className="tab-container-line" role="group" aria-label="Reputation tools" style={{ marginBottom: 16 }}>
        {VIEWS.map((v) => (
          <button key={v} type="button" className={`tab-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {view === 'reviews' && (
        <>
          <div className="card detail-card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="text-xs text-muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Google</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
                  <span style={{ fontSize: 40, fontWeight: 800, color: 'var(--text-body)' }}>{g?.rating ?? '—'}</span>
                  <Stars rating={g?.rating} />
                  <span className="text-sm text-muted">{g?.count != null ? `${g.count} reviews` : ''}</span>
                </div>
              </div>
              {g?.url && <a className="btn btn-primary" href={g.url} target="_blank" rel="noreferrer">View on Google</a>}
            </div>
            {g && g.configured === false && <p className="text-sm text-muted" style={{ marginTop: 10 }}>Add <code>GOOGLE_MAPS_API_KEY</code> in Vercel to show the live rating + reviews.</p>}
          </div>

          {connected && gmb.reviews?.length > 0 && (
            <div className="card detail-card" style={{ marginBottom: 16 }}>
              <h3 className="dash-card-title">Google reviews</h3>
              {gmb.reviews.map((r, i) => (
                <ReviewRow key={r.name} review={r} canManage={canManage} onReply={handleReply} onDeleteReply={handleDeleteReply} divider={i > 0} />
              ))}
            </div>
          )}
          {!connected && g?.reviews?.length > 0 && (
            <div className="card detail-card" style={{ marginBottom: 16 }}>
              <h3 className="dash-card-title">Recent Google reviews</h3>
              {g.reviews.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: i ? '1px solid var(--border-light)' : 'none' }}>
                  {r.photo ? <img src={r.photo} alt="" style={{ width: 40, height: 40, borderRadius: 99 }} /> : <div style={{ width: 40, height: 40, borderRadius: 99, background: 'var(--color-neutral-100)' }} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{r.author}</strong><span className="text-xs text-muted">{r.when}</span></div>
                    <Stars rating={r.rating} />
                    <p className="text-sm" style={{ marginTop: 4 }}>{r.text}</p>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted" style={{ marginTop: 8 }}>Google's public API exposes up to 5 reviews. Connect the Business Profile above for the full feed and in-app replies.</p>
            </div>
          )}

          <div className="card detail-card">
            <h3 className="dash-card-title">Indeed reviews</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 10 }}>Indeed has no public API, so update your review count here manually. It feeds the dashboard goal.</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="number" min="0" value={indeed} onChange={(e) => setIndeed(e.target.value)} disabled={!canView} className="input" style={{ width: 120 }} />
              {canView && <button className="btn btn-primary" onClick={saveIndeed}>Save</button>}
            </div>
          </div>
        </>
      )}

      {view === 'posts' && <GmbPostsPanel connected={connected && !needsLocation} canManage={canManage} />}
      {view === 'photos' && <GmbPhotosPanel connected={connected && !needsLocation} canManage={canManage} />}
      {view === 'insights' && <GmbInsightsPanel connected={connected && !needsLocation} />}
      {view === 'growth' && <ReviewGrowthPanel writeReviewUrl={g?.writeReviewUrl || null} connected={connected} />}
    </div>
  );
}
