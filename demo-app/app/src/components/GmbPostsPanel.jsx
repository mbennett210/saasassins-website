// Google Posts publisher — composes What's New / Event / Offer posts and
// publishes them PUBLICLY on the Google listing; lists + deletes existing ones.
// Validation mirrors api/_lib/gmb/client.js buildLocalPost (the server is the
// authority; this is UX). Management-gated by the caller via canManage.
import { useEffect, useState } from 'react';
import { useToast } from './Toast';
import { listGmbPosts, createGmbPost, deleteGmbPost, uploadGbpImage } from '../lib/reviewsApi';

const TYPE_LABELS = { STANDARD: "What's New", EVENT: 'Event', OFFER: 'Offer' };
const CTA_LABELS = { '': 'No button', BOOK: 'Book', ORDER: 'Order', SHOP: 'Shop', LEARN_MORE: 'Learn more', SIGN_UP: 'Sign up', CALL: 'Call' };
const STATE_STYLES = {
  LIVE: { background: 'var(--color-semantic-success-50)', color: 'var(--color-semantic-success-700)' },
  PROCESSING: { background: 'var(--color-semantic-warning-50)', color: 'var(--color-semantic-warning-700)' },
  REJECTED: { background: 'var(--color-semantic-error-50)', color: 'var(--color-semantic-error-700)' },
};

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function StateBadge({ state }) {
  if (!state) return null;
  const style = STATE_STYLES[state] || { background: 'var(--color-neutral-100)', color: 'var(--text-faint)' };
  return <span style={{ ...style, padding: '2px 8px', borderRadius: 99, fontSize: 11, marginLeft: 6 }}>{state}</span>;
}

const EMPTY = { topicType: 'STANDARD', summary: '', ctaType: '', ctaUrl: '', eventTitle: '', startDate: '', startTime: '', endDate: '', endTime: '', couponCode: '', redeemOnlineUrl: '', termsConditions: '' };

export default function GmbPostsPanel({ connected, canManage }) {
  const toast = useToast();
  const [posts, setPosts] = useState(null); // null = loading
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!connected) { setPosts([]); return; }
    let alive = true;
    listGmbPosts().then((d) => { if (alive) setPosts(d.posts || []); }).catch((e) => {
      if (alive) { setPosts([]); toast.error(e.message); }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const isEventish = form.topicType === 'EVENT' || form.topicType === 'OFFER';

  async function publish() {
    if (busy) return;
    setBusy(true);
    try {
      let photoPath = null;
      if (file) photoPath = await uploadGbpImage(file);
      const payload = {
        topicType: form.topicType,
        summary: form.summary,
        eventTitle: form.eventTitle,
        startDate: form.startDate, startTime: form.startTime,
        endDate: form.endDate, endTime: form.endTime,
        couponCode: form.couponCode, redeemOnlineUrl: form.redeemOnlineUrl, termsConditions: form.termsConditions,
        ...(form.ctaType ? { cta: { actionType: form.ctaType, url: form.ctaUrl } } : {}),
        ...(photoPath ? { photoPath } : {}),
      };
      const r = await createGmbPost(payload);
      toast.success('Post published on your Google listing');
      setForm(EMPTY);
      setFile(null);
      setOpen(false);
      setPosts((p) => [r.post, ...(p || [])]);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(post) {
    if (!window.confirm('Delete this post from your public Google listing?')) return;
    try {
      await deleteGmbPost(post.name);
      toast.success('Post deleted');
      setPosts((p) => (p || []).filter((x) => x.name !== post.name));
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!connected) {
    return <div className="card detail-card"><p className="text-sm text-muted">Connect Google Business Profile above to publish posts.</p></div>;
  }

  return (
    <>
      {canManage && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <h3 className="dash-card-title" style={{ margin: 0 }}>New post</h3>
            {!open && <button className="btn btn-primary" onClick={() => setOpen(true)}>Write a post</button>}
          </div>
          {open && (
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(TYPE_LABELS).map(([v, label]) => (
                  <button key={v} type="button" className={`tab-btn ${form.topicType === v ? 'active' : ''}`} onClick={() => setForm((f) => ({ ...f, topicType: v, ...(v === 'OFFER' ? { ctaType: '', ctaUrl: '' } : {}) }))}>
                    {label}
                  </button>
                ))}
              </div>
              {isEventish && (
                <input value={form.eventTitle} onChange={set('eventTitle')} placeholder={form.topicType === 'EVENT' ? 'Event title' : 'Offer title'} style={{ padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }} />
              )}
              <div>
                <textarea value={form.summary} onChange={set('summary')} rows={4} maxLength={1500} placeholder="What do you want to share?" style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8, resize: 'vertical' }} />
                <div className="text-xs text-muted" style={{ textAlign: 'right' }}>{form.summary.length}/1500</div>
              </div>
              {isEventish && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label className="text-sm">Starts <input type="date" value={form.startDate} onChange={set('startDate')} style={{ marginLeft: 4 }} /></label>
                  <input type="time" value={form.startTime} onChange={set('startTime')} />
                  <label className="text-sm">Ends <input type="date" value={form.endDate} onChange={set('endDate')} style={{ marginLeft: 4 }} /></label>
                  <input type="time" value={form.endTime} onChange={set('endTime')} />
                </div>
              )}
              {form.topicType === 'OFFER' && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <input value={form.couponCode} onChange={set('couponCode')} placeholder="Coupon code (optional)" style={{ padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }} />
                  <input value={form.redeemOnlineUrl} onChange={set('redeemOnlineUrl')} placeholder="Redeem link https://… (optional)" style={{ padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }} />
                  <input value={form.termsConditions} onChange={set('termsConditions')} placeholder="Terms & conditions (optional)" style={{ padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }} />
                  <p className="text-xs text-muted" style={{ margin: 0 }}>Offers get a "View offer" button from Google automatically.</p>
                </div>
              )}
              {form.topicType !== 'OFFER' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <select value={form.ctaType} onChange={set('ctaType')} style={{ padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }}>
                    {Object.entries(CTA_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                  {form.ctaType && form.ctaType !== 'CALL' && (
                    <input value={form.ctaUrl} onChange={set('ctaUrl')} placeholder="Button link https://…" style={{ flex: 1, minWidth: 220, padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }} />
                  )}
                </div>
              )}
              <div>
                <label className="text-sm text-muted">Photo (optional, JPG/PNG ≥250×250):{' '}
                  <input type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={publish} disabled={busy}>{busy ? 'Publishing…' : 'Publish post'}</button>
                <button className="btn btn-outline" onClick={() => { setOpen(false); setFile(null); }} disabled={busy}>Cancel</button>
                <span className="text-xs text-muted">This post is published publicly on your Google listing.</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card detail-card">
        <h3 className="dash-card-title">Posts on your listing</h3>
        {posts === null && <p className="text-sm text-muted">Loading…</p>}
        {posts !== null && posts.length === 0 && <p className="text-sm text-muted">No posts yet{canManage ? '. Write the first one above.' : '.'}</p>}
        {(posts || []).map((p, i) => (
          <div key={p.name} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: i ? '1px solid var(--border-light)' : 'none' }}>
            {p.photoUrl && <img src={p.photoUrl} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <strong>{TYPE_LABELS[p.topicType] || p.topicType}<StateBadge state={p.state} /></strong>
                <span className="text-xs text-muted">{fmtWhen(p.createTime)}</span>
              </div>
              {p.event?.title && <div className="text-sm" style={{ fontWeight: 600 }}>{p.event.title}</div>}
              {p.summary && <p className="text-sm" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{p.summary}</p>}
              {p.state === 'REJECTED' && <p className="text-xs" style={{ color: 'var(--color-semantic-error-700)' }}>Google declined this post. Edit and republish.</p>}
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                {p.searchUrl && <a className="linklike text-xs" href={p.searchUrl} target="_blank" rel="noreferrer">View on Google</a>}
                {canManage && <button className="linklike linklike-danger text-xs" onClick={() => remove(p)}>Delete</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
