// Google Business Profile API adapter (/api/reviews/*). Real backend only —
// with no backend reachable the Reviews page just renders the disconnected
// card. Connect uses a popup: the server mints the consent URL (authority is
// checked there — the popup itself can't carry our Bearer header), the popup
// goes straight to Google, and the callback page posts a 'connect-gmb'
// message back (same pattern as connectedInboxes' openOAuthPopup).
import { authHeaders } from './authHeader';
import { supabase } from './supabaseClient';

const BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  return res.json();
}

export function getGmbStatus() { return api('/reviews/status'); }
export function getGmbFeed() { return api('/reviews/feed'); }
export function getGmbInsights() { return api('/reviews/insights'); }
export function listGmbLocations() { return api('/reviews/locations'); }
export function chooseGmbLocation({ accountName, locationName, locationTitle }) {
  return api('/reviews/location', { method: 'POST', body: { accountName, locationName, locationTitle } });
}
export function postGmbReply(reviewName, comment) {
  return api('/reviews/reply', { method: 'POST', body: { reviewName, comment } });
}
export function deleteGmbReply(reviewName) {
  return api('/reviews/reply', { method: 'DELETE', body: { reviewName } });
}
export function syncGmbNow() { return api('/reviews/sync-now', { method: 'POST' }); }
export function disconnectGmb() { return api('/reviews/disconnect', { method: 'POST' }); }

// ── suite: posts / photos / SEO ──────────────────────────────────────────────
export function listGmbPosts() { return api('/reviews/posts'); }
export function createGmbPost(payload) { return api('/reviews/posts', { method: 'POST', body: payload }); }
export function deleteGmbPost(name) { return api('/reviews/posts', { method: 'DELETE', body: { name } }); }
export function listGmbPhotos() { return api('/reviews/photos'); }
export function attachGmbPhoto({ path, category }) { return api('/reviews/photos', { method: 'POST', body: { path, category } }); }
export function deleteGmbPhoto(name) { return api('/reviews/photos', { method: 'DELETE', body: { name } }); }
export function getGmbKeywords() { return api('/reviews/keywords'); }
export function getGmbTrends() { return api('/reviews/trends'); }

// Google fetches post/listing photos by URL, so the image is staged on the
// public org-branding bucket first (3-hop accountMediaApi pattern: mint signed
// upload → browser PUTs bytes → hand the staged path to the attach/create
// call). Client-side gates run BEFORE any bytes move: JPG/PNG, 10KB–10MB,
// ≥250×250px (Google's floors — instant feedback beats a server round-trip).
export async function uploadGbpImage(file) {
  if (!file) throw new Error('Pick an image first.');
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    throw new Error('Google listing photos must be JPG or PNG.');
  }
  if (file.size < 10 * 1024) throw new Error('Image is too small. Google requires at least 10 KB.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Image is too large (10 MB max).');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image.');
  }
  const { width, height } = bitmap;
  bitmap.close?.();
  if (width < 250 || height < 250) {
    throw new Error(`Image is ${width}×${height}px. Google requires at least 250×250.`);
  }
  const { path, token } = await api('/reviews/photos/upload-url', {
    method: 'POST',
    body: { mimeType: file.type, sizeBytes: file.size },
  });
  const { error } = await supabase.storage.from('org-branding').uploadToSignedUrl(path, token, file);
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

// Fetches the consent URL (server-side owner/admin check), opens it in a
// popup, resolves with the callback's payload:
//   { googleEmail, needsLocation, locationTitle, accounts? }
export async function connectGmb() {
  const { url } = await api('/reviews/oauth/start');
  return new Promise((resolve, reject) => {
    const popup = window.open(
      url,
      'connect-gmb',
      'width=600,height=720,menubar=no,toolbar=no,location=no,status=no'
    );
    if (!popup) {
      reject(new Error('Popup blocked. Allow popups for this site and try again.'));
      return;
    }
    let settled = false;
    const onMessage = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type !== 'connect-gmb') return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      try { popup.close(); } catch { /* ignore */ }
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.connected || {});
    };
    window.addEventListener('message', onMessage);
    // Popup closed without completing = user cancel.
    const poll = setInterval(() => {
      if (popup.closed && !settled) {
        clearInterval(poll);
        window.removeEventListener('message', onMessage);
        reject(new Error('Connect flow was cancelled.'));
      }
    }, 500);
  });
}
