// "Report an issue" client adapter (/api/support/*).
//
// The browser talks only to THIS app's proxy routes — it never sees the CRM or
// the portal token. Submitting is a three-step flow per file, then one POST:
//   1. POST /api/support/upload {name,mimeType,sizeBytes} → {attachmentId, path, signedUrl}
//      (the server validates type/size BEFORE minting — a rejected file gets no URL)
//   2. PUT the bytes straight to signedUrl (Supabase Storage; bytes never
//      transit our functions — Vercel caps request bodies ~4.5 MB, files may be 10 MB)
//   3. POST /api/support/report with the metadata rows + captured diagnostics.
//
// Validation helpers are ported from the CRM's proven supportTickets.js so the
// two halves agree on what a valid attachment is.
import { authHeaders } from './authHeader';

const BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

// ─── Attachment rules (mirror the CRM's server-side gates) ───────────────────
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB each
export const TICKET_ATTACHMENT_MAX_COUNT = 6;                // per report
export const TICKET_ATTACHMENT_ALLOWED_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
];

export const isImageMime = (m) => String(m || '').startsWith('image/');

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Returns an error string, or null when the file is acceptable — checked next
// to the drop zone so the reporter sees the problem before a failed submit.
export function validateAttachment(file) {
  if (!file) return 'No file';
  if (!TICKET_ATTACHMENT_ALLOWED_MIME.includes(file.type)) {
    return `${file.name || 'That file'} isn't a supported type. Use PNG, JPG, WebP, GIF or PDF.`;
  }
  if (file.size > TICKET_ATTACHMENT_MAX_BYTES) {
    return `${file.name || 'That file'} is ${formatBytes(file.size)}. The limit is ${formatBytes(TICKET_ATTACHMENT_MAX_BYTES)}.`;
  }
  return null;
}

// A pasted screenshot arrives as an unnamed blob ("image.png" at best). Give it
// a readable, sortable name so staff aren't looking at six identical names.
export function nameForPastedImage(mime, index = 0) {
  const ext = String(mime || 'image/png').split('/')[1] || 'png';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `screenshot-${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
}

// Pull files out of a paste/drop DataTransfer, renaming unnamed clipboard
// blobs. This is what makes Ctrl+V work.
export function filesFromDataTransfer(dataTransfer) {
  const out = [];
  const items = dataTransfer?.items ? Array.from(dataTransfer.items) : [];
  items.forEach((item, i) => {
    if (item.kind !== 'file') return;
    const file = item.getAsFile();
    if (!file) return;
    if (!file.name || file.name === 'image.png' || file.name === 'blob') {
      out.push(new File([file], nameForPastedImage(file.type, i), { type: file.type }));
    } else {
      out.push(file);
    }
  });
  if (out.length === 0 && dataTransfer?.files?.length) {
    return Array.from(dataTransfer.files);
  }
  return out;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  let res;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure (offline, DNS, proxy down) — same reporter-facing
    // meaning as a 502/503: support can't be reached right now.
    const err = new Error('Support is temporarily unavailable. Please try again shortly.');
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// "Support unavailable" — outage/config on the far side (or no network at
// all), nothing the reporter can fix by editing the form. The modal shows the
// graceful fallback state instead of a raw error. status 0 = fetch threw;
// pre-flight validation errors are plain Errors with NO status field, so they
// keep their specific messages.
export function isSupportUnavailable(err) {
  return err?.status === 0 || err?.status === 502 || err?.status === 503;
}

// Upload every file, then file the report. Throws with a user-facing message
// on any failure; nothing is retained server-side for a report never filed
// (staged uploads without a ticket age out on the CRM side).
export async function submitReport({ subject, description, priority, files = [], context = null }) {
  if (files.length > TICKET_ATTACHMENT_MAX_COUNT) {
    throw new Error(`Up to ${TICKET_ATTACHMENT_MAX_COUNT} files per report.`);
  }
  const attachments = [];
  for (const file of files) {
    const problem = validateAttachment(file);
    if (problem) throw new Error(problem);
    const minted = await api('/support/upload', {
      method: 'POST',
      body: { name: file.name, mimeType: file.type, sizeBytes: file.size },
    });
    const put = await fetch(minted.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!put.ok) throw new Error(`Upload failed for ${file.name}. Please try again.`);
    attachments.push({
      id: minted.attachmentId,
      path: minted.path,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    });
  }
  return api('/support/report', {
    method: 'POST',
    body: { subject, description, priority, attachments, context },
  });
}
