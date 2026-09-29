// Server-mediated write path for org_state + public.jobs (Increment 1d).
//
// WHY: the browser holds only the anon key, and both tables are still writable
// by any authenticated session (`using(true) with check(true)`). Increment 1e
// revokes those policies — at which point these endpoints are the ONLY way a
// save reaches the database. Routing writes here first, while the direct path
// still works, is what makes that revoke a non-event.
//
// FALLBACK CONTRACT (temporary, 1d only): a TRANSPORT failure falls back to the
// direct client write, because until 1e the browser can still get there and a
// save must never be lost to a cold serverless function. It is deliberately
// LOUD — every fallback warns — because a silent fallback would let the server
// path be quietly broken while everything looks healthy, and we would only find
// out when 1e removed the safety net. An AUTHORIZATION or CONFLICT answer is a
// real answer, not a transport failure, and never falls back.
//
// 1e DELETES the fallback. `serverWriteHealth()` is how we confirm the server
// path is actually carrying the traffic before that happens.
import { supabase } from './supabaseClient';
import { terminalAuthCode } from './terminalAuth.js';

const BACKEND =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

// Terminal-auth handoff. The server answers a write 403 `code: 'account-disabled'` /
// `'not-on-team'` when the login can no longer act (see lib/terminalAuth.js). That is a
// real, non-recoverable answer: the app must sign out, not fall back and retry. The
// auth layer (AuthProvider) registers a handler here; this module fires it the moment a
// write comes back terminal. Kept as a REGISTERED CALLBACK, not an import, so this
// transport module stays free of a React/AuthProvider dependency — the same pattern the
// sync manager uses for its sign-out flush hook. The handler owns its own idempotency
// (it dedupes on an in-flight sign-out), so this fires on every terminal answer rather
// than latching — a failed sign-out can then be retried by the next attempt.
let terminalAuthHandler = null;
export function setTerminalAuthHandler(fn) { terminalAuthHandler = typeof fn === 'function' ? fn : null; }
function notifyTerminalAuth(code) {
  if (!terminalAuthHandler) return;
  try { terminalAuthHandler(code); } catch { /* a write path must never throw on the handoff */ }
}

// Observable counters so "is the server path actually being used?" is a question
// with an answer, not an assumption. Surfaced on window in DEV.
const health = { serverOk: 0, fellBack: 0, lastError: null };
export function serverWriteHealth() { return { ...health }; }
if (typeof window !== 'undefined') window.__ppWriteHealth = serverWriteHealth;

async function authHeader() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

// Thrown for answers that must NOT fall back to a direct write.
export class ServerWriteRejected extends Error {
  constructor(status, payload) {
    super(payload?.error || `Server write rejected (${status})`);
    this.status = status;
    this.payload = payload || {};
  }
}

// A stalled write must not wedge the sync manager: flush() holds `saving = true`
// for the whole call, and while it is true every later edit short-circuits and
// no save happens at all. Without a deadline a dead socket on a Manila handset
// pins that until the browser's own timeout. Mirrors BOOT_FETCH_TIMEOUT_MS.
const WRITE_TIMEOUT_MS = 12000;

async function post(path, bodyJson) {
  const auth = await authHeader();
  // No session → no server write is possible. Treated as a transport failure so
  // the caller can still persist via the direct path (pre-1e) rather than
  // dropping the user's edit on the floor.
  if (!auth) throw new Error('no session for server write');
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
  } finally {
    if (timer) clearTimeout(timer);
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
  if (res.ok) return payload || {};
  // ONLY 409 (and, below, a 403 carrying `violations`) is a real answer that must not
  // fall back: 409 is the CAS conflict / fleet-gate result, and retrying it directly
  // would either lose the conflict resolution or bypass the gate. Everything else — 401 (an Auth blip is
  // indistinguishable from a real one, see _lib/auth.js swallowing all errors),
  // 404 (function not deployed), 413, 429, 5xx — falls back, because pre-1e the
  // direct path still works and the user's edit is worth more than the purity
  // of the new path. Every fallback is counted and warned so a persistently
  // broken server path is visible BEFORE 1e removes the safety net.
  if (res.status === 409) throw new ServerWriteRejected(res.status, payload);
  // A 403 carrying a TERMINAL auth code (`account-disabled` / `not-on-team`, from
  // requireAuthority) means this login can never write again until an owner re-enables
  // it. A REAL answer, not transport: fall back / retry and the app just shows "offline"
  // and re-hits the same 403 every ~5s forever. Hand off to the auth layer to sign out,
  // then throw so the caller returns a non-ok result and skips its direct-write fallback.
  const terminalCode = terminalAuthCode(res.status, payload);
  if (terminalCode) { notifyTerminalAuth(terminalCode); throw new ServerWriteRejected(res.status, payload); }
  // A 403 carrying `violations` is the org-state field guard REFUSING a
  // protected-field change (roles, permissions, standing crew, site
  // parentage). Treating it as transport made the client silently retry the
  // same refused change through the direct-write fallback — the guard looked
  // enforced while being bypassed, and the user saw "synced" (2026-07-30
  // roles incident). It is a real answer; callers revert instead of retrying.
  if (res.status === 403 && payload && payload.violations) throw new ServerWriteRejected(res.status, payload);
  throw new Error(payload?.error || `Server write failed (${res.status})`);
}

// CS-002 — read the crew READ PROJECTION (or, for an office role, the full blob) from
// GET /api/state/view. A crew (non-office) login can no longer read org_state directly once
// the read-split RLS lands, so its sync goes through here. Returns
// { state, version, minClientBuild, freezeStrip, projection }. Throws on no session / non-2xx
// so the caller (store/sync.js fetchLatest) can fail open onto the offline path exactly as a
// failed direct read would.
export async function getStateView() {
  const auth = await authHeader();
  if (!auth) throw new Error('no session for state view');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`${BACKEND}/state/view`, {
      method: 'GET',
      headers: { ...auth },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`state view failed (${res.status})`);
  return res.json();
}

// CAS-write the shared blob. Resolves { ok:true, version } on success, or
// { ok:false, conflict|gated } when the server refused — both are real answers.
//
// `stateJson` is the ALREADY-SERIALIZED blob. flush() has just stringified it
// for the content guard, and re-stringifying ~800 KB on the main thread at a
// 600 ms debounce is real jank on a low-end phone — so it is spliced into the
// request body as raw JSON instead of round-tripping through an object.
export async function postOrgState({ stateJson, baseVersion, build, tab }) {
  const body = `{"state":${stateJson},"baseVersion":${Number(baseVersion)},`
    + `"build":${Number(build) || 0},"tab":${JSON.stringify(tab ?? null)}}`;
  try {
    const r = await post('/state/org-state', body);
    health.serverOk += 1;
    // `dropped` is present only on a CREW save (CS-002): the server merged allowlisted
    // changes and dropped the rest ({ count, slices }). The caller refetches + adopts on it
    // so the UI converges to the server's merged truth.
    return { ok: true, version: r.version, dropped: r.dropped, viaServer: true };
  } catch (e) {
    if (e instanceof ServerWriteRejected) {
      const p = e.payload || {};
      if (e.status === 409) return { ok: false, conflict: !!p.conflict, gated: !!p.gated, minClientBuild: p.minClientBuild, viaServer: true };
      if (e.status === 403 && p.violations) return { ok: false, rejected: true, violations: p.violations, viaServer: true };
      // Terminal auth (disabled / off the roster): a real answer, surfaced DISTINCTLY —
      // not `unavailable`, so flush() neither falls back to the direct write nor retries.
      const term = terminalAuthCode(e.status, p);
      if (term) { health.lastError = e.message; return { ok: false, terminal: true, code: term, viaServer: true }; }
      health.lastError = e.message;
      throw e; // 401/413 etc — a genuine rejection, not a transport hiccup
    }
    health.fellBack += 1;
    health.lastError = e?.message || String(e);
    console.warn('[sync] server org_state write unavailable, using direct write:', health.lastError);
    return { ok: false, unavailable: true, viaServer: false };
  }
}

// First-run bootstrap for a brand-new org. Idempotent server-side. Falls back to
// the direct upsert (pre-1e) the same way the other writes do.
export async function postSeedState(state) {
  try {
    await post('/state/seed', JSON.stringify({ state }));
    health.serverOk += 1;
    return { ok: true, viaServer: true };
  } catch (e) {
    health.fellBack += 1;
    health.lastError = e?.message || String(e);
    console.warn('[sync] server seed unavailable, using direct upsert:', health.lastError);
    return { ok: false, unavailable: true, viaServer: false };
  }
}

// Write a jobs delta. `chunks` are pre-split by the caller (see jobsSync).
export async function postJobsDelta({ changed, removed, build, tab }) {
  try {
    const r = await post('/state/jobs-delta', JSON.stringify({ changed, removed, build, tab }));
    health.serverOk += 1;
    return { ok: true, ...r, viaServer: true };
  } catch (e) {
    if (e instanceof ServerWriteRejected) {
      // Terminal auth (disabled / off the roster): return it DISTINCTLY so persistJobsDelta
      // skips the direct write (its fallback keys on `unavailable`) instead of throwing into
      // a retry. The sign-out handoff already fired in post().
      const term = terminalAuthCode(e.status, e.payload);
      if (term) { health.lastError = e.message; return { ok: false, terminal: true, code: term, viaServer: true }; }
      health.lastError = e.message; throw e;
    }
    health.fellBack += 1;
    health.lastError = e?.message || String(e);
    console.warn('[sync] server jobs write unavailable, using direct write:', health.lastError);
    return { ok: false, unavailable: true, viaServer: false };
  }
}
