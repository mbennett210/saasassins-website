// Client adapter for account media (site photos + video). Real backend uploads via
// a signed URL straight to Storage (large video bypasses the serverless body limit);
// playback uses signed URLs from /list. In local/demo mode an auto-engaged stub
// keeps the bytes as data URLs in localStorage so the gallery is exercisable.
// Media lists are component-local projections (useState), never the synced blob.
import { authHeaders } from './authHeader';
import { supabase } from './supabaseClient';
import { demoBackendsEngaged } from './demoMode';
import { isOfflineError } from './netError';
import { addMedia, allMedia, removeMedia as removeQueuedMedia, updateMedia, newMediaId, OFFLINE_CAP } from './mediaQueue';
import { drainQueue } from './offlineRetry';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js (Sept 1 incident)
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';
const BUCKET = 'ops-media';
const IMAGE_CAP = 10 * 1024 * 1024;
const VIDEO_CAP = 200 * 1024 * 1024;

export function isMediaStub() { return !BACKEND; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    // The STATUS is what the offline drain classifies a failed replay by (CS-007): without
    // it every server answer looked alike and the queue deleted the photo. Same shape as
    // qcApi's api() since eaf39fc.
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function listMedia({ siteId, refId, scope = 'cleaning_instruction', areaId = null }) {
  if (!siteId) return [];
  if (BACKEND) {
    const qs = new URLSearchParams({ siteId, scope });
    if (refId) qs.set('refId', refId);
    if (areaId) qs.set('areaId', areaId);
    return (await api(`/account-media/list?${qs.toString()}`)).media;
  }
  return stubList({ siteId, refId, scope, areaId });
}

export async function uploadMedia(file, { siteId, clientId, scope = 'cleaning_instruction', areaId = null, refId = null, clientMediaId = null }) {
  const isVideo = (file.type || '').startsWith('video');
  if (file.size > (isVideo ? VIDEO_CAP : IMAGE_CAP)) {
    throw new Error(`That file is too large (max ${isVideo ? '200MB video' : '10MB image'}).`);
  }
  if (!BACKEND) return stubUpload(file, { siteId, clientId, scope, areaId, refId });
  // Stamp the idempotency key up front so a buffered file replays under the SAME id —
  // confirmUpload dedupes the account_media row on it (migration 20260804010000), so a
  // partial-then-retry or an over-eager flush can't double-post the shot.
  const mediaId = clientMediaId || newMediaId();
  const meta = { siteId, clientId, scope, areaId, refId, clientMediaId: mediaId };
  try {
    return await doUpload(file, meta);
  } catch (e) {
    // A real rejection (403/404/400 — un-assigned, bad path) will never succeed on
    // replay, so surface it. Only a TRANSPORT failure (offline / no signal) gets buffered.
    if (!isOfflineError(e)) throw e;
    // Video too large to stash on the device — keep it in the camera roll for a live
    // upload rather than filling the phone. Images (≤10MB) always fit under the cap.
    if (file.size > OFFLINE_CAP) {
      throw new Error("You’re offline and this video is too large to save on the device (over 50MB). It stays in your camera roll. Upload it once you have signal.");
    }
    await addMedia({
      id: mediaId, file,
      meta: { siteId, clientId, scope, areaId, refId, mimeType: file.type, sizeBytes: file.size, fileName: file.name || null },
      createdAt: new Date().toISOString(),
    });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('rfs:media-queued'));
    return { pending_sync: true, id: mediaId, kind: isVideo ? 'video' : 'image' };
  }
}

// The real 3-hop upload: mint a signed URL → stream bytes straight to Storage (large
// video bypasses the serverless body limit) → best-effort poster → record the row.
// Extracted so both a live upload and an offline REPLAY run the identical path; the
// clientMediaId threads through to confirm for row idempotency.
async function doUpload(file, { siteId, clientId, scope, areaId, refId, clientMediaId }) {
  const isVideo = (file.type || '').startsWith('video');
  const { path, token, kind, thumb } = await api('/account-media/upload-url', { method: 'POST', body: { siteId, mimeType: file.type, sizeBytes: file.size } });
  const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(path, token, file);
  if (error) throw new Error(error.message || 'Upload failed');
  // Poster/thumbnail — STRICTLY best-effort and never blocks the media itself. Without
  // it the gallery pulls the full-resolution image (or streams an entire 200MB video)
  // for every tile, which is brutal on the crew's mobile links.
  let thumbPath = null;
  if (thumb && thumb.path && thumb.token) {
    try {
      const poster = await makeThumbnail(file, isVideo);
      if (poster) {
        const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(thumb.path, thumb.token, poster);
        if (!up.error) thumbPath = thumb.path;
      }
    } catch { /* fall through — confirm without a thumb */ }
  }
  return (await api('/account-media/confirm', { method: 'POST', body: { siteId, clientId, scope, areaId, refId, kind, mimeType: file.type, storagePath: path, thumbPath, sizeBytes: file.size, clientMediaId } })).media;
}

// Replay every buffered upload on reconnect. Idempotent server-side (confirmUpload keys
// on clientMediaId). CS-007: the loop is now the SHARED drain (lib/offlineRetry), the same
// one flushChecklistQueue runs — a 5xx / 429 / 408 / 401 / 403 or a status-less Storage
// error KEEPS the photo and backs off, only a definitive validation 4xx stops the retries,
// and even then the file stays on the device marked `failed` for Retry / Discard
// (components/OfflineQueueFailures). It used to delete the crew's photos on ANY
// non-transport error. Emits rfs:media-flushed when anything synced or newly failed.
export async function flushMediaQueue() {
  if (!BACKEND) return { flushed: 0 };
  const items = await allMedia();
  const out = await drainQueue(items, {
    send: (it) => doUpload(it.file, { ...it.meta, clientMediaId: it.id }),
    remove: removeQueuedMedia,
    mark: updateMedia,
  });
  if ((out.flushed || out.stopped) && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('rfs:media-flushed'));
  }
  return out;
}

// Buffered uploads still to sync. Terminally `failed` ones are on the device too and count
// by default — they ARE still un-synced work the crew can see and act on.
export async function pendingMediaCount({ includeFailed = true } = {}) {
  const items = await allMedia();
  return includeFailed ? items.length : items.filter((it) => !it.failed).length;
}

// ── poster/thumbnail generation ──────────────────────────────────────────────
const THUMB_MAX_EDGE = 480;   // longest edge, px
const THUMB_QUALITY = 0.72;

// Build a small JPEG poster: downscale for an image, first-frame grab for a video.
// Any failure (unsupported codec, no canvas, timeout) resolves null and the upload
// proceeds without a thumbnail — the gallery then falls back to the full-res URL.
async function makeThumbnail(file, isVideo) {
  try {
    const source = isVideo ? await videoFirstFrame(file) : file;
    if (!source) return null;
    const bmp = await createImageBitmap(source);
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
  } catch { return null; }
}

// Seek a picked video to its first decodable frame and hand the element back as a
// bitmap source. Hard 5s timeout so an undecodable codec can never hang an upload.
function videoFirstFrame(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(val); };
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { finish(null); } };
    v.onseeked = () => finish(v);
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 5000);
    v.src = url;
  });
}

export async function removeMedia(id) {
  if (BACKEND) return api('/account-media/delete', { method: 'POST', body: { id } });
  return stubRemove(id);
}

// Set/replace a media item's caption (the note shown under the thumbnail + in the
// lightbox). Real backend: POST /account-media/caption (authenticated, re-gated on the
// media row's OWN site like confirm; caption ≤ MAX_CAPTION_LEN). Demo runs the stub.
export async function updateMediaCaption(id, caption) {
  if (BACKEND) return api('/account-media/caption', { method: 'POST', body: { id, caption } });
  return stubUpdateCaption(id, caption);
}

// ── stub store (demo / local-only) ───────────────────────────────────────────
const STUB_KEY = 'cleanspace_account_media_stub_v1';
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const loadStub = () => { try { return JSON.parse(localStorage.getItem(STUB_KEY)) || { media: [] }; } catch { return { media: [] }; } };
const saveStub = (db) => { try { localStorage.setItem(STUB_KEY, JSON.stringify(db)); } catch { /* quota — video too big for localStorage */ } };

function stubList({ siteId, refId, scope, areaId }) {
  return loadStub().media
    .filter((m) => (refId ? m.ref_id === refId : m.site_id === siteId)
      && (!scope || m.scope === scope)
      && (!areaId || m.area_id === areaId))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}
async function stubUpload(file, { siteId, clientId, scope, areaId, refId }) {
  const url = await readAsDataUrl(file);
  const db = loadStub();
  const media = {
    id: rid('am'), site_id: siteId, client_id: clientId || null, scope, area_id: areaId || null, ref_id: refId || null,
    kind: (file.type || '').startsWith('video') ? 'video' : 'image', mimeType: file.type,
    sizeBytes: file.size, caption: file.name || null, url, createdAt: nowIso(), created_at: nowIso(),
  };
  db.media.push(media); saveStub(db); return media;
}
function stubRemove(id) {
  const db = loadStub(); db.media = db.media.filter((m) => m.id !== id); saveStub(db); return { ok: true };
}
function stubUpdateCaption(id, caption) {
  const db = loadStub();
  db.media = db.media.map((m) => (m.id === id ? { ...m, caption: caption || null } : m));
  saveStub(db);
  return { ok: true };
}
