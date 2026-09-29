// Listing photo manager — uploads categorized photos PUBLICLY to the Google
// listing (staged on the public org-branding bucket, Google fetches the URL),
// shows the existing media grid with view counts, deletes.
import { useEffect, useState } from 'react';
import { useToast } from './Toast';
import { listGmbPhotos, attachGmbPhoto, deleteGmbPhoto, uploadGbpImage } from '../lib/reviewsApi';

const CATEGORY_LABELS = {
  COVER: 'Cover', PROFILE: 'Profile', LOGO: 'Logo', EXTERIOR: 'Exterior',
  INTERIOR: 'Interior', TEAMS: 'Team', AT_WORK: 'At work', ADDITIONAL: 'Other',
};

export default function GmbPhotosPanel({ connected, canManage }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [category, setCategory] = useState('AT_WORK');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connected) { setItems([]); return; }
    let alive = true;
    listGmbPhotos().then((d) => { if (alive) setItems(d.items || []); }).catch((e) => {
      if (alive) { setItems([]); toast.error(e.message); }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    try {
      const path = await uploadGbpImage(file);
      const r = await attachGmbPhoto({ path, category });
      toast.success('Photo published on your Google listing');
      setFile(null);
      setItems((p) => [r.item, ...(p || [])]);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    if (!window.confirm('Remove this photo from your public Google listing?')) return;
    try {
      await deleteGmbPhoto(item.name);
      toast.success('Photo removed');
      setItems((p) => (p || []).filter((x) => x.name !== item.name));
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!connected) {
    return <div className="card detail-card"><p className="text-sm text-muted">Connect Google Business Profile above to manage listing photos.</p></div>;
  }

  return (
    <>
      {canManage && (
        <div className="card detail-card" style={{ marginBottom: 16 }}>
          <h3 className="dash-card-title">Add a photo</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8 }}>
              {Object.entries(CATEGORY_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <input type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            <button className="btn btn-primary" onClick={upload} disabled={busy || !file}>{busy ? 'Publishing…' : 'Publish photo'}</button>
          </div>
          <p className="text-xs text-muted" style={{ marginTop: 8 }}>JPG or PNG, at least 250×250px and 10 KB. Photos are published publicly on your Google listing.</p>
        </div>
      )}

      <div className="card detail-card">
        <h3 className="dash-card-title">Photos on your listing</h3>
        {items === null && <p className="text-sm text-muted">Loading…</p>}
        {items !== null && items.length === 0 && <p className="text-sm text-muted">No photos yet{canManage ? '. Add the first one above.' : '.'}</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginTop: 8 }}>
          {(items || []).map((m) => (
            <div key={m.name} style={{ border: '1px solid var(--border-light)', borderRadius: 10, overflow: 'hidden' }}>
              {m.thumbnailUrl
                ? <img src={m.thumbnailUrl} alt="" style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }} />
                : <div style={{ width: '100%', height: 110, background: 'var(--color-neutral-50)' }} />}
              <div style={{ padding: '6px 10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <span className="text-xs" style={{ fontWeight: 600 }}>{CATEGORY_LABELS[m.category] || m.category || '—'}</span>
                  {m.viewCount > 0 && <span className="text-xs text-muted">{m.viewCount.toLocaleString()} views</span>}
                </div>
                {canManage && (
                  <button className="linklike linklike-danger text-xs" onClick={() => remove(m)}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
