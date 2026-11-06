import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import * as mediaApi from '../lib/accountMediaApi';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import Icon from './Icon';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

// In-app photo + VIDEO gallery for a site (replaces Swept's Google-Doc-link sprawl).
// Bytes live in the private 'ops-media' bucket; large video uploads stream straight
// to Storage via a signed URL (bypassing the serverless body limit) and play back
// via short-lived signed URLs. The list is a component-local projection (useState),
// never the synced blob. Gated ops.media.upload (add) / ops.edit (delete). §2.2 / §5.3.
// Its own words are catalog lines in the viewer's language (CS-193); `label` and `hint`
// come from the caller (already translated), with the catalog's defaults when omitted —
// `hint={null}` still means "no hint".
export default function MediaGallery({
  siteId, clientId, scope = 'cleaning_instruction', refId = null, areaId = null,
  label = null,
  hint,
  readOnly = false, hideWhenEmpty = false,
  // Optional imperative handle: the parent sets `openRef.current` to a fn that pops the
  // native file/camera picker, so a button elsewhere (e.g. a visit step) can trigger THIS
  // gallery's upload directly — reusing its offline-buffering + thumbnail path. Null-safe:
  // if the viewer can't upload there's no input, so the handle is a no-op.
  openRef = null,
  // Optional: reports the loaded item count to the parent whenever it changes (a visit step
  // uses it to check itself off once a photo lands). Null-safe.
  onCount = null,
  // A caller that draws its OWN add control (the New Inspection form's Before / After tiles,
  // 2026-10-09) passes `showUpload={false}`: the gallery's Upload button goes, while the
  // hidden picker stays so `openRef` still opens it. `label=""` draws no label row, and
  // `emptyText={null}` no "No photos yet" line (undefined keeps the default).
  showUpload = true,
  emptyText,
  // S131 — a supply ORDER's delivery photos (scope `supply`): the order's own rules decide who adds
  // and removes (supplies.manage, or the driver on a submitted order), not the site's ops keys, so
  // the caller passes them (`canAdd` / `canRemove`; undefined keeps the ops keys). `accept` narrows
  // the picker (an order's photo is a photo), and `captions={false}` drops the note editor (the
  // caption route is a site's).
  canAdd,
  canRemove,
  accept = 'image/*,video/*',
  captions = true,
  // The Upload button's words when the caller's are not the default "photo / video" (an order's
  // photos are photos only); already translated.
  uploadLabel = null,
}) {
  const t = useT();
  const labelText = label ?? t('media.defaultLabel');
  const hintText = hint === undefined ? t('media.defaultHint') : hint;
  const emptyLine = emptyText === undefined ? t('media.empty') : emptyText;
  const toast = useToast();
  const opsUpload = usePermission('ops.media.upload');
  const opsDelete = usePermission('ops.edit');
  const canUpload = (canAdd === undefined ? opsUpload : !!canAdd) && !readOnly;
  const canDelete = (canRemove === undefined ? opsDelete : !!canRemove) && !readOnly;
  const online = useOnlineStatus();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0); // offline-buffered uploads on THIS device
  const [viewIdx, setViewIdx] = useState(null); // open lightbox index, or null
  const [captionDraft, setCaptionDraft] = useState(''); // lightbox caption editor
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try { setItems(await mediaApi.listMedia({ siteId, refId, scope, areaId })); }
    catch (e) { toast.error(errorText(t, e, 'media.loadFailed')); setItems([]); }
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
      catch (err) { toast.error(`${f.name}: ${errorText(t, err, 'media.uploadFailed')}`); }
    }
    setBusy(false);
    if (ok) { toast.success(t('media.uploaded', { count: ok })); load(); }
    if (pending) {
      toast.success(t('media.savedOffline', { count: pending }));
      refreshPending();
    }
  };

  const del = async (id) => {
    try { await mediaApi.removeMedia(id); load(); }
    catch (e) { toast.error(errorText(t, e, 'media.deleteFailed')); }
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
      toast.success(t('media.noteSaved'));
    } catch (e) { toast.error(errorText(t, e, 'media.noteFailed')); }
  };

  // In a read-only strip (e.g. the Access tab) stay invisible until there's
  // something to show — no "Loading…"/"No photos yet" noise under every card.
  if (hideWhenEmpty && (items === null || items.length === 0)) return null;

  const active = viewIdx != null ? items[viewIdx] : null;

  return (
    <div className="form-group">
      {labelText && <label className="form-label">{labelText}</label>}
      {hintText && <div className="text-xs text-muted" style={{ marginBottom: 8 }}>{hintText}</div>}
      {items === null ? (
        <p className="text-muted text-sm">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        emptyLine ? <p className="text-muted text-sm">{emptyLine}</p> : null
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
                  ? <img className="media-thumb" src={m.thumbUrl} alt={m.caption || (m.kind === 'video' ? t('media.videoAlt') : t('media.photoAlt'))} loading="lazy" />
                  : (m.kind === 'video'
                    ? <video className="media-thumb" src={m.url} preload="metadata" muted />
                    : <img className="media-thumb" src={m.url} alt={m.caption || t('media.photoAlt')} loading="lazy" />)}
                {m.kind === 'video' && <span className="media-play" aria-hidden="true">▶</span>}
                {canDelete && <button type="button" className="thumb-remove" aria-label={t('media.deleteAria')} onClick={(e) => { e.stopPropagation(); del(m.id); }}><Icon name="x" size={12} /></button>}
              </div>
              {m.caption && <div className="media-cap" title={m.caption}>{m.caption}</div>}
            </div>
          ))}
        </div>
      )}
      {canUpload && !online && (
        <p className="text-xs" role="status" style={{ marginTop: 8, marginBottom: 0, color: 'var(--color-semantic-warning-700)' }}>
          {t('media.offlineNote')}
        </p>
      )}
      {pendingCount > 0 && (
        <p className="text-xs" role="status" style={{ marginTop: 8, marginBottom: 0, color: 'var(--color-semantic-warning-700)' }}>
          {t('media.pendingNote', { count: pendingCount })}
        </p>
      )}
      {canUpload && (
        <>
          <input ref={fileRef} type="file" accept={accept} multiple hidden onChange={onFiles} />
          {showUpload ? (
            <button type="button" className="btn btn-success" style={{ marginTop: 8 }} disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? t('media.uploading') : (uploadLabel || t('media.upload'))}
            </button>
          ) : busy ? <p className="text-muted text-sm" role="status">{t('media.uploading')}</p> : null}
        </>
      )}

      <Modal open={active != null} onClose={() => setViewIdx(null)} title={t('media.viewerTitle', { label: labelText, n: (viewIdx ?? 0) + 1, count })} size="lg">
        {active && (
          <div className="media-viewer">
            {count > 1 && <button type="button" className="media-viewer-nav prev" aria-label={t('common.previous')} onClick={() => stepView(-1)}>‹</button>}
            {active.kind === 'video'
              ? <video className="media-viewer-media" src={active.url} controls autoPlay />
              : <img className="media-viewer-media" src={active.url} alt={active.caption || t('media.photoAlt')} />}
            {count > 1 && <button type="button" className="media-viewer-nav next" aria-label={t('common.next')} onClick={() => stepView(1)}>›</button>}
          </div>
        )}
        {active && (canUpload && captions ? (
          <div className="media-caption-edit">
            <textarea
              className="input"
              rows={2}
              placeholder={t('media.captionPlaceholder')}
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
            />
            {captionDraft.trim() !== (active.caption || '') && (
              <div className="media-caption-actions">
                <button type="button" className="btn btn-outline" onClick={() => setCaptionDraft(active.caption || '')}>{t('common.cancel')}</button>
                <button type="button" className="btn btn-primary" onClick={saveCaption}>{t('media.saveNote')}</button>
              </div>
            )}
          </div>
        ) : (active.caption && <p className="media-viewer-caption text-sm text-muted">{active.caption}</p>))}
      </Modal>
    </div>
  );
}
