// Client adapter for encrypted site access codes. Door/alarm codes are AES-256-GCM
// at rest, written + revealed ONLY via /api/site-security (the key never reaches the
// browser). Non-secret fields (key #, access instructions, code hint) live in the
// blob and render straight from the store; only set + reveal need the server.
//
// In local/demo mode there's no backend, so isSecurityStub() is true and the
// SecurityCard handles set/reveal against the blob directly (codes kept as a
// STUB:-prefixed marker — demo only, never real ciphertext). See CLEANSPACE_SWEPT.md §2.4.
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js (Sept 1 incident)
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isSecurityStub() { return !BACKEND; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

// Set codes / hint on a site. Real backend only — encrypts server-side and returns
// the SAFE fields (presence flags + hint, never ciphertext/plaintext). undefined =
// keep existing, '' = clear, value = (re)encrypt.
export async function setSecurity({ siteId, doorCode, alarmCode, codeHint }) {
  return (await api('/site-security/set', { method: 'POST', body: { siteId, doorCode, alarmCode, codeHint } })).security;
}

// Reveal one decrypted code (server checks the caller is a manager or assigned crew).
export async function revealCode({ siteId, which }) {
  return (await api('/site-security/reveal', { method: 'POST', body: { siteId, which } })).code;
}
