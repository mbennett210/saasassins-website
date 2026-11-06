// The server-mediated write path for org_state + public.jobs — the ONLY way a browser save
// reaches the database. Increment 1e (migration 20260803150000) revoked the browser's own
// write policies on both tables; this module is what every save goes through instead.
//
// EVERY ANSWER IS AN ANSWER, AND THERE IS NO SECOND PATH (CS-009, 2026-10-03). Until this
// change, anything but a 409 or a guard refusal "fell back" to a direct
// `supabase.from('org_state').update(...)`. Since 1e that update matches no row and reports no
// error, which the sync manager read as a CAS conflict: adopt, replay, save again in 600 ms —
// an expired session, a 500, a missing function or an over-budget blob became an org-wide
// loop that showed "Saving…" for ever, and a removal-only jobs chunk "succeeded" through an
// RLS-filtered DELETE that deleted nothing, so deleted cleans came back on the next load. The
// fallback is deleted (replace means delete); every outcome is classified here, once, and the
// caller backs off and retries THROUGH THIS PATH while showing the person an error:
//   ok           2xx
//   conflict     409 { conflict }       — adopt the latest and replay (store/sync.js)
//   gated        409 { gated }          — this build is below min_client_build: reload
//   rejected     403 { violations }     — the field guard refused a change (CS-008 isolates it)
//   terminal     403 account-disabled / not-on-team — sign out (lib/terminalAuth.js)
//   tooLarge     413                    — the shared record is over its size budget: a blocking
//                                         message; the edits stay on the device
//   failed       any other non-2xx, or no session — back off and retry; an error state
//   unreachable  the request never got an answer (offline, DNS, the 12 s abort) — offline
// Nothing here writes anywhere but the server routes. app/scripts/test-sync-save-failures.mjs
// drives each class through the real sync engine and holds that no browser module writes
// org_state or public.jobs directly.
import { supabase } from './supabaseClient';
import { terminalAuthCode } from './terminalAuth.js';

const BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

// Terminal-auth handoff. The server answers a write 403 `code: 'account-disabled'` /
// `'not-on-team'` when the login can no longer act (see lib/terminalAuth.js). That is a
// real, non-recoverable answer: the app must sign out, not retry. The auth layer
// (AuthProvider) registers a handler here; this module fires it the moment a write comes back
// terminal. Kept as a REGISTERED CALLBACK, not an import, so this transport module stays free
// of a React/AuthProvider dependency — the same pattern the sync manager uses for its sign-out
// flush hook. The handler owns its own idempotency (it dedupes on an in-flight sign-out), so
// this fires on every terminal answer rather than latching — a failed sign-out can then be
// retried by the next attempt.
let terminalAuthHandler = null;
export function setTerminalAuthHandler(fn) { terminalAuthHandler = typeof fn === 'function' ? fn : null; }
function notifyTerminalAuth(code) {
  if (!terminalAuthHandler) return;
  try { terminalAuthHandler(code); } catch { /* a write path must never throw on the handoff */ }
}

// Observable counters so "is the server path carrying the traffic, and how often does it
// fail?" is a question with an answer. Surfaced on window (support's diagnostics read it).
const health = { serverOk: 0, failed: 0, lastError: null };
export function serverWriteHealth() { return { ...health }; }
if (typeof window !== 'undefined') window.__ppWriteHealth = serverWriteHealth;

async function authHeader() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

// A stalled write must not wedge the sync manager: flush() holds `saving = true` for the
// whole call, and while it is true every later edit short-circuits and no save happens at
// all. Without a deadline a dead socket on a Manila handset pins that until the browser's
// own timeout. (The crew's state read shares it; a first load gives each read
// store/sync.js BOOT_ATTEMPT_MS before it says it cannot reach the server, and retries.)
const WRITE_TIMEOUT_MS = 12000;

// One POST, classified (see the header). Never throws.
async function post(path, bodyJson) {
  const auth = await authHeader();
  // No session: nothing can be written until the login is back. A FAILURE to retry, not a
  // reason to write some other way.
  if (!auth) return { kind: 'failed', status: 0, payload: { error: 'Not signed in' } };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: bodyJson,
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } catch (e) {
    return { kind: 'unreachable', status: 0, payload: { error: e?.name === 'AbortError' ? 'The save timed out' : (e?.message || 'Network error') } };
  } finally {
    if (timer) clearTimeout(timer);
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
  payload = payload || {};
  if (res.ok) return { kind: 'ok', status: res.status, payload };
  if (res.status === 409) return { kind: payload.gated ? 'gated' : 'conflict', status: 409, payload };
  // A 403 carrying a TERMINAL auth code means this login can never write again until an
  // owner re-enables it: hand off to the auth layer to sign out.
  const terminalCode = terminalAuthCode(res.status, payload);
  if (terminalCode) { notifyTerminalAuth(terminalCode); return { kind: 'terminal', status: res.status, payload, code: terminalCode }; }
  // A 403 carrying `violations` is the org-state field guard REFUSING a change (CS-008).
  if (res.status === 403 && Array.isArray(payload.violations)) return { kind: 'rejected', status: 403, payload };
  if (res.status === 413) return { kind: 'tooLarge', status: 413, payload };
  return { kind: 'failed', status: res.status, payload };
}

const failure = (r) => ({
  ok: false,
  viaServer: true,
  status: r.status,
  error: r.payload?.error || `Server write failed (${r.status})`,
  ...(r.kind === 'unreachable' ? { unreachable: true } : {}),
  ...(r.kind === 'tooLarge' ? { tooLarge: true, field: r.payload?.field || null } : {}),
  ...(r.kind === 'failed' ? { failed: true } : {}),
});

// CS-002 — read the crew READ PROJECTION (or, for an office role, the full blob) from
// GET /api/state/view. A crew (non-office) login can no longer read org_state directly once
// the read-split RLS lands, so its sync goes through here. Returns
// { state, version, minClientBuild, freezeStrip, projection }. Throws on no session / non-2xx,
// exactly as a failed direct read would: store/sync.js retries it (on a first load, behind the
// boot screen — CS-672) and never opens the app without its answer.
// A 403 carrying a TERMINAL auth code (the login was disabled, or is off the team) is handed to
// the sign-out like a terminal answer on a save: retried, it would only ever say "can't reach".
export async function getStateView() {
  return getView('/state/view');
}

// One GET of the view route, as getStateView describes: throws on no session / non-2xx, and
// hands a terminal 403 to the sign-out.
async function getView(path) {
  const auth = await authHeader();
  if (!auth) throw new Error('no session for state view');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method: 'GET',
      headers: { ...auth },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON */ }
    const terminalCode = terminalAuthCode(res.status, payload);
    if (terminalCode) notifyTerminalAuth(terminalCode);
    throw new Error(`state view failed (${res.status})`);
  }
  return res.json();
}

// CS-677 — the caller's OWN cleans in the jobs window (src/lib/jobsWindow.js), for a crew
// launch: GET /api/state/view?part=jobs. The server reads them as the service role through the
// index on the crew list, where the same read through the browser runs under RLS and filters
// every clean in the window. → { jobs (each with its row version as `_rv`, like every jobs
// read), highWater (the table's high-water row_version, read before the cleans), fromMs, toMs
// (the window the server read) }. Throws like getStateView, and on an answer that isn't one.
export async function getOwnJobsWindow() {
  const body = await getView('/state/view?part=jobs');
  if (!body || !Array.isArray(body.jobs)) throw new Error('state view: no jobs in the answer');
  const fromMs = Date.parse(body.from);
  const toMs = Date.parse(body.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('state view: no window in the answer');
  return {
    jobs: body.jobs.filter((r) => r && r.data && r.data.id).map((r) => ({ ...r.data, _rv: r.row_version ?? 0 })),
    highWater: Number(body.highWater) || 0,
    fromMs,
    toMs,
  };
}

// CAS-write the shared blob. Resolves to one of the classes in the header, never throws:
//   { ok:true, version, dropped }                        saved
//   { ok:false, conflict } | { ok:false, gated, minClientBuild }
//   { ok:false, rejected, violations } | { ok:false, terminal, code }
//   { ok:false, tooLarge | failed | unreachable, status, error }
//
// `stateJson` is the ALREADY-SERIALIZED blob. flush() has just stringified it for the
// content guard, and re-stringifying ~800 KB on the main thread at a 600 ms debounce is real
// jank on a low-end phone — so it is spliced into the request body as raw JSON instead of
// round-tripping through an object.
export async function postOrgState({ stateJson, baseVersion, build, tab }) {
  const body = `{"state":${stateJson},"baseVersion":${Number(baseVersion)},`
    + `"build":${Number(build) || 0},"tab":${JSON.stringify(tab ?? null)}}`;
  const r = await post('/state/org-state', body);
  if (r.kind === 'ok') {
    health.serverOk += 1;
    // `dropped` is present only on a CREW save (CS-002): the server merged allowlisted changes
    // and dropped the rest ({ count, slices }). The caller refetches + adopts on it so the UI
    // converges to the server's merged truth.
    return { ok: true, version: r.payload.version, dropped: r.payload.dropped, viaServer: true };
  }
  if (r.kind === 'conflict') return { ok: false, conflict: true, viaServer: true };
  if (r.kind === 'gated') return { ok: false, gated: true, minClientBuild: r.payload.minClientBuild, viaServer: true };
  if (r.kind === 'rejected') return { ok: false, rejected: true, violations: r.payload.violations, viaServer: true };
  health.failed += 1;
  health.lastError = r.payload?.error || `status ${r.status}`;
  if (r.kind === 'terminal') return { ok: false, terminal: true, code: r.code, viaServer: true };
  return failure(r);
}

// First-run bootstrap for a brand-new org. Idempotent server-side. A failure is returned, not
// worked around: with no row, every later save answers 500 ("row not found") and backs off.
export async function postSeedState(state) {
  const r = await post('/state/seed', JSON.stringify({ state }));
  if (r.kind === 'ok') { health.serverOk += 1; return { ok: true, viaServer: true }; }
  health.failed += 1;
  health.lastError = r.payload?.error || `status ${r.status}`;
  return failure(r);
}

// Write a jobs delta. `chunks` are pre-split by the caller (see jobsSync). Resolves
// { ok:true, ... } or { ok:false, terminal } (the sign-out is under way: nothing to retry);
// every other outcome THROWS, with `kind` and `status` on the error, so the mirror leaves its
// baseline where it was and the next flush re-sends the delta — through this route, never
// around it. A removal counts as done only when the server says so.
export async function postJobsDelta({ changed, removed, build, tab }) {
  const r = await post('/state/jobs-delta', JSON.stringify({ changed, removed, build, tab }));
  if (r.kind === 'ok') { health.serverOk += 1; return { ok: true, ...r.payload, viaServer: true }; }
  health.failed += 1;
  health.lastError = r.payload?.error || `status ${r.status}`;
  if (r.kind === 'terminal') return { ok: false, terminal: true, code: r.code, viaServer: true };
  const err = new Error(r.payload?.error || `jobs save failed (${r.status})`);
  err.kind = r.kind === 'unreachable' ? 'unreachable' : 'failed';
  err.status = r.status;
  throw err;
}
