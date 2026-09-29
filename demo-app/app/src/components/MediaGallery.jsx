import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import * as mediaApi from '../lib/accountMediaApi';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import Icon from './Icon';

// In-app photo + VIDEO gallery for a site (replaces Swept's Google-Doc-link sprawl).
// Bytes live in the private 'ops-media' bucket; large video uploads stream straight
// to Storage via a signed URL (bypassing the serverless body limit) and play back
// via short-lived signed URLs. The list is a component-local projection (useState),
// never the synced blob. Gated ops.media.upload (add) / ops.edit (delete). §2.2 / §5.3.
export default function MediaGallery({
  siteId, clientId, scope = 'cleaning_instruction', refId = null, areaId = null,
  label = 'Photos & video',
  hint = 'Viewable in-app. Crew see these on the account. Images up to 10MB, video up to 200MB.',
  readOnly = false, hideWhenEmpty = false,
  // Optional imperative handle: the parent sets `openRef.current` to a fn that pops the
  // native file/camera picker, so a button elsewhere (e.g. a visit step) can trigger THIS
  // gallery's upload directly — reusing its offline-buffering + thumbnail path. Null-safe:
  // if the viewer can't upload there's no input, so the handle is a no-op.
  openRef = null,
  // Optional: reports the loaded item count to the parent whenever it changes (a visit step
  // uses it to check itself off once a photo lands). Null-safe.
  onCount = null,
}) {
  const toast = useToast();
  const canUpload = usePermission('ops.media.upload') && !readOnly;
  const canDelete = usePermission('ops.edit') && !readOnly;
  const online = useOnlineStatus();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0); // offline-buffered uploads on THIS device
  const [viewIdx, setViewIdx] = useState(null); // open lightbox index, or null
  const [captionDraft, setCaptionDraft] = useState(''); // lightbox caption editor
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try { setItems(await mediaApi.listMedia({ siteId, refId, scope, areaId })); }
    catch (e) { toast.error(e.message || 'Could not load media'); setItems([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, refId, scope, areaId]);
  useEffect(() => { load(); }, [load]);

  // Expose the picker trigger to a parent via openRef (see prop doc).
  useEffect(() => {
    if (!openRef) return undefined;
    openRef.current = () => fileRef.current?.click();
    return () => { if (openRef) openRef.current = null; };
  }, [openRef]);

  // Report the loaded count up (0 while loading) so a visit step can check itself off.
  useEffect(() => { if (onCount) onCount(items?.length || 0); }, [items, onCount]);

  // Persistent "waiting to upload" indicator. The count is device-global (an offline
  // shot lives in IndexedDB, not the per-site list) and survives reloads, so the crew
  // always knows something is still un-synced. Refresh when a shot is queued/flushed;
  // a flush also re-lists so the now-live media appears.
  const refreshPending = useCallback(() => {
    mediaApi.pendingMediaCount().then(setPendingCount).catch(() => { /* best-effort */ });
  }, []);
  useEffect(() => {
    refreshPending();
    const onQueued = () => refreshPending();
    const onFlushed = () => { refreshPending(); load(); };
    window.addEventListener('rfs:media-queued', onQueued);
    window.addEventListener('rfs:media-flushed', onFlushed);
    return () => {
      window.removeEventListener('rfs:media-queued', onQueued);
      window.removeEventListener('rfs:media-flushed', onFlushed);
    };
  }, [refreshPending, load]);

  // Arrow-key paging while the lightbox is open (Esc is handled by <Modal>).
  const count = items?.length || 0;
  const stepView = useCallback((delta) => {
    setViewIdx((i) => (i == null ? i : (i + delta + count) % count));
  }, [count]);
  useEffect(() => {
    if (viewIdx == null) return;
    const onKey = (e) => {
      if (e.key === 'ArrowRight') stepView(1);
      else if (e.key === 'ArrowLeft') stepView(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewIdx, stepView]);

  const onFiles = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    let ok = 0, pending = 0;
    for (const f of files) {
      try {
        // Offline → uploadMedia buffers the file on-device and returns pending_sync;
        // OfflineMediaSync replays it (idempotently) when the network returns.
        const res = await mediaApi.uploadMedia(f, { siteId, clientId, scope, refId, areaId });
        if (res?.pending_sync) pending += 1; else ok += 1;
      }
      catch (err) { toast.error(`${f.name}: ${err.message || 'upload failed'}`); }
    }
    setBusy(false);
    if (ok) { toast.success(ok === 1 ? 'Uploaded' : `${ok} uploaded`); load(); }
    if (pending) {
      toast.success(pending === 1
        ? 'Saved on this device. It’ll upload when you’re back online.'
        : `${pending} saved on this device. They’ll upload when you’re back online.`);
      refreshPending();
    }
  };

  const del = async (id) => {
    try { await mediaApi.removeMedia(id); load(); }
    catch (e) { toast.error(e.message || 'Delete failed'); }
  };

  // Seed the caption editor whenever the lightbox opens or pages to another item.
  // Not keyed on `items` so saving (which mutates items) never clobbers the draft.
  useEffect(() => {
    setCaptionDraft(viewIdx == null ? '' : (items?.[viewIdx]?.caption || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewIdx]);

  const saveCaption = async () => {
    if (viewIdx == null) return;
    const it = items[viewIdx];
    if (!it) return;
    const cap = captionDraft.trim();
    if (cap === (it.caption || '')) return;
    try {
      await mediaApi.updateMediaCaption(it.id, cap);
      setItems((prev) => prev.map((m) => (m.id === it.id ? { ...m, caption: cap || null } : m)));
      toast.success('Note saved');
    } catch (e) { toast.error(e.message || 'Could not save note'); }
  };

  // In a read-only strip (e.g. the Access tab) stay invisible until there's
  // something to show — no "Loading…"/"No photos yet" noise under every card.
  if (hideWhenEmpty && (items === null || items.length === 0)) return null;

  const active = viewIdx != null ? items[viewIdx] : null;

  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {hint && <div className="text-xs text-muted" style={{ marginBottom: 8 }}>{hint}</div>}
      {items === null ? (
        <p className="text-muted text-sm">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-muted text-sm">No photos or video yet.</p>
      ) : (
        <div className="media-grid">
          {items.map((m, i) => (
            <div className="media-cell" key={m.id}>
              <div
                className="media-item"
                role="button"
                tabIndex={0}
                onClick={() => setViewIdx(i)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewIdx(i); } }}
              >
                {/* Prefer the poster/thumbnail: a ~KB JPEG instead of the full-resolution
                    image, or — for video — instead of streaming the real file just to
                    paint a tile. Rows uploaded before thumbnails existed have no
                    thumbUrl and fall back to the original behaviour. */}
                {m.thumbUrl
                  ? <img className="media-thumb" src={m.thumbUrl} alt={m.caption || (m.kind === 'video' ? 'video poster' : 'site photo')} loading="lazy" />
                  : (m.kind === 'video'
                    ? <video className="media-thumb" src={m.url} preload="metadata" muted />
                    : <img className="media-thumb" src={m.url} alt={m.caption || 'site photo'} loading="lazy" />)}
                {m.kind === 'video' && <span className="media-play" aria-hidden="true">▶</span>}
                {canDelete && <button type="button" className="thumb-remove" aria-label="Delete media" onClick={(e) => { e.stopPropagation(); del(m.id); }}><Icon name="x" size={12} /></button>}
              </div>
              {m.caption && <div className="media-cap" title={m.caption}>{m.caption}</div>}
            </div>
          ))}
        </div>
      )}
      {canUpload && !online && (
        <p className="text-xs" role="status" style={{ marginTop: 8, marginBottom: 0, color: 'var(--color-semantic-warning-700)' }}>
          You’re offline. Photos and short videos still save on this device and upload automatically once you’re back online. Large videos (over 50MB) need a signal; those stay in your camera roll.
        </p>
      )}
      {pendingCount > 0 && (
        <p className="text-xs" role="status" style={{ marginTop: 8, marginBottom: 0, color: 'var(--color-semantic-warning-700)' }}>
          {pendingCount === 1 ? '1 photo/video saved on this device' : `${pendingCount} photos/videos saved on this device`}. Waiting to upload. This happens automatically when you’re back online.
        </p>
      )}
      {canUpload && (
        <>
          <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={onFiles} />
          <button type="button" className="btn btn-success" style={{ marginTop: 8 }} disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Uploading…' : 'Upload photo / video'}
          </button>
        </>
      )}

      <Modal open={active != null} onClose={() => setViewIdx(null)} title={`${label} — ${(viewIdx ?? 0) + 1} / ${count}`} size="lg">
        {active && (
          <div className="media-viewer">
            {count > 1 && <button type="button" className="media-viewer-nav prev" aria-label="Previous" onClick={() => stepView(-1)}>‹</button>}
            {active.kind === 'video'
              ? <video className="media-viewer-media" src={active.url} controls autoPlay />
              : <img className="media-viewer-media" src={active.url} alt={active.caption || 'photo'} />}
            {count > 1 && <button type="button" className="media-viewer-nav next" aria-label="Next" onClick={() => stepView(1)}>›</button>}
          </div>
        )}
        {active && (canUpload ? (
          <div className="media-caption-edit">
            <textarea
              className="input"
              rows={2}
              placeholder="Add a note / caption for this photo…"
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
            />
            {captionDraft.trim() !== (active.caption || '') && (
              <div className="media-caption-actions">
                <button type="button" className="btn btn-outline" onClick={() => setCaptionDraft(active.caption || '')}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={saveCaption}>Save note</button>
              </div>
            )}
          </div>
        ) : (active.caption && <p className="media-viewer-caption text-sm text-muted">{active.caption}</p>))}
      </Modal>
    </div>
  );
}
