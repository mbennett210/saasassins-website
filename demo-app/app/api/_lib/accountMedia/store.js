// Service-role data layer for account_media — the in-app photo + VIDEO store that
// replaces Swept's Google-Doc-link sprawl. Bytes live in the private 'ops-media'
// bucket; this is the metadata index. The browser never holds the bucket key:
// uploads go through a short-lived SIGNED UPLOAD URL (so large video bypasses the
// serverless body limit and streams straight to Storage), and playback is via
// short-lived signed download URLs. Service-role only; org pinned. See §2.2 / §4.1.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment } from '../storagePaths.js';

const BUCKET = 'ops-media';
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];
const IMAGE_CAP = 10 * 1024 * 1024;   // 10 MB
const VIDEO_CAP = 200 * 1024 * 1024;  // 200 MB
// A caption is a short note shown under a thumbnail and in the lightbox, not an essay.
// The route validates against this ceiling; the test asserts the boundary against THIS
// constant, never a restated literal (THE LAW II.3).
export const MAX_CAPTION_LEN = 2000;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

const rid = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; for (let i = 0; i < 16; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

// Validate the declared mime + size before minting an upload URL. Returns
// { ok, kind } or { ok:false, error }.
export function validateUpload({ mimeType, sizeBytes }) {
  const isImage = IMAGE_MIME.includes(mimeType);
  const isVideo = VIDEO_MIME.includes(mimeType);
  if (!isImage && !isVideo) return { ok: false, error: 'Unsupported file type' };
  const cap = isVideo ? VIDEO_CAP : IMAGE_CAP;
  if (Number.isFinite(sizeBytes) && sizeBytes > cap) {
    return { ok: false, error: `File is too large (max ${isVideo ? '200MB video' : '10MB image'})` };
  }
  return { ok: true, kind: isVideo ? 'video' : 'image' };
}

// Derive the poster/thumbnail object path for a media object. Always JPEG (small +
// universally decodable) and stored BESIDE the original so removeMedia's existing
// [storage_path, thumb_path] sweep already collects it — no delete-path change needed.
export function thumbPathFor(storagePath) {
  return `${String(storagePath || '').replace(/\.[^./]+$/, '')}.thumb.jpg`;
}

// Mint a signed upload URL + token for a new object. The client uploads the bytes
// directly to Storage with uploadToSignedUrl(path, token, file), then calls confirm().
// Also mints a SECOND signed URL for the poster/thumbnail the client generates
// (canvas frame-grab for video, downscale for image). Without this, `thumb_path` was
// declared + swept on delete but never written, so every gallery view pulled the
// full-resolution image — or an entire 200MB video — to crew on slow links.
// Thumbnails are an optimisation, never a hard dependency: a client that skips the
// thumb upload simply confirms without a thumbPath and listMedia falls back to the
// full-res URL (the pre-fix behaviour), so this is safe for a mixed fleet.
export async function signedUploadUrl({ siteId, mimeType }) {
  const db = getSupabase();
  const ext = EXT[mimeType] || 'bin';
  // `siteId` arrives as `body.siteId` from api/account-media/[...path].js and is
  // interpolated into the object key, so an unvalidated value like `../../_signatures`
  // would mint a SIGNED UPLOAD URL pointing outside this prefix — into the same private
  // bucket that holds signatures and quote documents. The `|| 'site'` fallback is a
  // legitimate unfiled-media bucket, so it is applied first and then validated as one.
  const segment = siteId || 'site';
  requireSafeSegment(segment, 'account-media siteId');
  const path = `${CLEANSPACE_ORG_ID}/${segment}/${rid()}.${ext}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  let thumb = null;
  try {
    const tp = thumbPathFor(data.path || path);
    const t = await db.storage.from(BUCKET).createSignedUploadUrl(tp);
    if (!t.error && t.data) thumb = { path: t.data.path || tp, token: t.data.token, signedUrl: t.data.signedUrl };
  } catch { /* best-effort — never block the real upload on the thumb */ }
  return { path: data.path || path, token: data.token, signedUrl: data.signedUrl, thumb };
}

// Record an uploaded object in the metadata index.
export async function confirmUpload({ scope = 'cleaning_instruction', clientId, siteId, areaId, refId, kind, mimeType, storagePath, thumbPath, sizeBytes, durationSecs, caption, uploadedByUserId, clientMediaId = null }) {
  const db = getSupabase();
  // Idempotent replay (offline media queue): a buffered upload re-sends the same
  // client_media_id on reconnect, and a partial-then-retry sends it twice. Return the
  // already-stored row instead of inserting a duplicate. Backed by the partial unique
  // index (organization_id, client_media_id) from 20260804010000.
  if (clientMediaId) {
    const { data: existing } = await db.from('account_media').select('*')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_media_id', clientMediaId).maybeSingle();
    if (existing) return existing;
  }
  const { data, error } = await db.from('account_media').insert({
    organization_id: CLEANSPACE_ORG_ID,
    scope,
    client_id: clientId || null,
    site_id: siteId || null,
    area_id: areaId || null,
    ref_id: refId || null,
    kind,
    mime_type: mimeType,
    storage_path: storagePath,
    // Written for the first time here — the column existed and was swept on delete,
    // but nothing ever populated it, so no thumbnail was ever produced.
    thumb_path: thumbPath || null,
    size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    duration_secs: Number.isFinite(durationSecs) ? durationSecs : null,
    caption: caption || null,
    uploaded_by_user_id: uploadedByUserId || null,
    client_media_id: clientMediaId || null,
  }).select('*').single();
  if (error) {
    // A concurrent replay won the insert race: return the winner's row, not a 500.
    if (error.code === '23505' && clientMediaId) {
      const { data: winner } = await db.from('account_media').select('*')
        .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_media_id', clientMediaId).maybeSingle();
      if (winner) return winner;
    }
    throw error;
  }
  return data;
}

// List media for a site OR a specific owning record (ref_id — an inspection or
// problem report), each with a short-lived signed playback URL. ref_id wins when
// provided (QC photos); otherwise site_id (cleaning-instruction media). An optional
// areaId narrows to one inspection SECTION (the per-section photo galleries).
export async function listMedia({ siteId, refId, scope, areaId }) {
  const db = getSupabase();
  let q = db.from('account_media').select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('created_at', { ascending: false });
  if (refId) q = q.eq('ref_id', refId);
  else if (siteId) q = q.eq('site_id', siteId);
  if (scope) q = q.eq('scope', scope);
  if (areaId) q = q.eq('area_id', areaId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  // Mint signed URLs in one batch where possible; fall back per-row.
  const out = [];
  for (const r of rows) {
    let url = null;
    try { const s = await db.storage.from(BUCKET).createSignedUrl(r.storage_path, 600); url = s.data?.signedUrl || null; } catch { /* skip */ }
    // Project the poster/thumbnail so galleries render a ~KB JPEG instead of pulling
    // the full-resolution image or streaming an entire video. Null for rows uploaded
    // before thumbnails existed — callers fall back to `url`, i.e. today's behaviour.
    let thumbUrl = null;
    if (r.thumb_path) {
      try { const t = await db.storage.from(BUCKET).createSignedUrl(r.thumb_path, 600); thumbUrl = t.data?.signedUrl || null; } catch { /* skip */ }
    }
    out.push({
      id: r.id, kind: r.kind, mimeType: r.mime_type, caption: r.caption,
      sizeBytes: r.size_bytes, durationSecs: r.duration_secs, areaId: r.area_id,
      scope: r.scope, createdAt: r.created_at, uploadedByUserId: r.uploaded_by_user_id, url, thumbUrl,
    });
  }
  return out;
}

// Raw metadata rows (NO signed URLs) for an owning record — the server PDF renderer
// needs the storage_path/thumb_path to inline bytes itself, and minting signed URLs
// it will never fetch is pure waste. Ordered oldest-first so the report reads
// top-to-bottom in capture order. Not for browser use (paths are private keys).
export async function listMediaRaw({ siteId, refId, scope, areaId } = {}) {
  const db = getSupabase();
  let q = db.from('account_media')
    .select('id, kind, mime_type, caption, area_id, storage_path, thumb_path, created_at')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('created_at', { ascending: true });
  if (refId) q = q.eq('ref_id', refId);
  else if (siteId) q = q.eq('site_id', siteId);
  if (scope) q = q.eq('scope', scope);
  if (areaId) q = q.eq('area_id', areaId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// The owning SITE of a media row, org-pinned. Null when no such row exists in this org
// (a cross-org id included, exactly as removeMedia is pinned). The caption route re-gates
// on this site — the site the row was authorized under on confirm — never a caller-supplied
// one, so it resolves the row here before gating rather than trusting the request body.
export async function mediaOwnerSite({ id }) {
  const db = getSupabase();
  const { data, error } = await db.from('account_media')
    .select('id, site_id')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, siteId: data.site_id || null } : null;
}

// Set (or clear, with an empty string) a media row's caption. Org-pinned + id-pinned like
// removeMedia, so a stray id can't reach across organizations. Idempotent by nature — an
// UPDATE to a fixed value leaves exactly one row however many times it replays. Returns
// { ok: true }, or { notFound: true } when the row vanished (a concurrent delete).
// Projects only `id` back, never the private storage_path.
export async function updateCaption({ id, caption }) {
  const db = getSupabase();
  const { data, error } = await db.from('account_media')
    .update({ caption: caption || null })
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id)
    .select('id').maybeSingle();
  if (error) throw error;
  return data ? { ok: true } : { notFound: true };
}

// Hard-delete: remove the Storage object, then the metadata row.
// Org-pinned on BOTH statements — every other query in this file is, and a delete
// that isn't would be the one place a stray id could reach across organizations in a
// multi-org clone of the shell.
export async function removeMedia({ id }) {
  const db = getSupabase();
  const { data: row, error: e1 } = await db.from('account_media')
    .select('storage_path, thumb_path')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id).maybeSingle();
  if (e1) throw e1;
  if (!row) return { notFound: true };
  const paths = [row.storage_path, row.thumb_path].filter(Boolean);
  if (paths.length) { try { await db.storage.from(BUCKET).remove(paths); } catch { /* best-effort */ } }
  const { error } = await db.from('account_media').delete()
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', id);
  if (error) throw error;
  return { ok: true };
}
