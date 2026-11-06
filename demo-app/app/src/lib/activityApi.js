// Client adapter for the activity log (CS-379). The log is a SERVER-ONLY record — there is
// no local mirror and no reducer slice, by design: it must grow forever and be tamper-proof,
// which the shared blob cannot be. So every read goes through /api/activity, and in
// local/demo mode there is simply nothing to read (isActivityStub() is true and the screens
// say so) rather than a stub that would invent a trail nobody performed.
//
// The two exports are file downloads behind the same bearer auth as the reads, so they are
// fetched and saved from the response blob — a plain <a href> would arrive unauthenticated.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';

const STUB = demoBackendsEngaged(); // prod builds ignore the demo env — see lib/demoMode.js
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isActivityStub() { return !BACKEND; }

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

async function api(path, { method = 'GET' } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, { method, headers: { ...auth } });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code || null;
    throw err;
  }
  return json;
}

// One page of the log, newest first. Returns { entries, total, offset, limit, scope }.
// An empty result in demo mode is honest — there is no local log (see the header).
export async function list({ fromIso, toIso, clientId, actorUserId, group, offset = 0, limit = 50 } = {}) {
  if (!BACKEND) return { entries: [], total: 0, offset: 0, limit, stub: true };
  return api(`/activity/list${qs({ fromIso, toIso, clientId, actorUserId, group, offset, limit })}`);
}

// LOG-6 — the dispute pack for one customer over a date range. `format` is 'csv' | 'pdf';
// the server names the file and reads COMPLETE (paged to the count), so what downloads is the
// whole window or a clear error, never a silently truncated page.
export async function exportFile({ format = 'csv', clientId, fromIso, toIso } = {}) {
  if (!BACKEND) {
    const err = new Error('The activity log needs the connected app — there is nothing to export in demo mode.');
    err.status = 501;
    throw err;
  }
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}/activity/export${qs({ format, clientId, fromIso, toIso })}`, { headers: { ...auth } });
  if (!res.ok) {
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    const err = new Error(json?.error || `Export failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code || null;
    throw err;
  }
  const blob = await res.blob();
  // The server owns the file name (it knows the customer and the org's dates); fall back to a
  // plain one if the header is missing or a proxy stripped it.
  const disp = res.headers.get('Content-Disposition') || '';
  const match = /filename="([^"]+)"/.exec(disp);
  const name = match ? match[1] : `activity.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return { name, bytes: blob.size };
}
