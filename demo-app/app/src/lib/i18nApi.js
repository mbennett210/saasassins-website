// Client for /api/i18n (CS-193, CS-851): the server's lines for what this build's bundle lacks.
// The system translates everything — the app's own words here, a checklist's wording on its own
// save (POST /api/qc/templates/save) — and no person checks a line.
//
// Demo / local mode has no server, so there are no server lines there: `fetchLines` answers null
// and the runtime skips quietly (the demo fills an untranslated line with pseudo-text instead).
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';

const STUB = demoBackendsEngaged(); // prod builds ignore VITE_TIME_STUB — see lib/demoMode.js
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

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
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (json?.code) err.code = json.code;
    throw err;
  }
  return json;
}

// The server's lines for what this build's bundle lacks (GET /api/i18n/lines, EP-411, CS-851):
// { lang, lines } — or null in the demo, which has no server (the runtime then skips quietly).
// Throws on a failed request; src/i18n/serverLines.js treats that as "keep the device's copy".
export async function fetchLines(lang) {
  if (!BACKEND) return null;
  return api(`/i18n/lines?lang=${encodeURIComponent(lang)}`);
}
