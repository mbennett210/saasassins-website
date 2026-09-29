// Team-login management — calls the /api/settings/users routes that create / remove /
// disable the real Supabase account behind a team member, so Settings → Team manages
// actual access (not just a store record). The server gates each on the permission this
// page gates it on, within the Super Admin limits (api/_lib/teamAuthority.js).
// Stub (local) mode returns synthetic results so the UI still works offline.
// Extensioned specifiers (Vite resolves either) so this module is loadable by
// bare Node too — scripts/test-orphan-adopt.mjs imports bindRosterId from here.
import { authHeaders } from './authHeader.js';
import { markStub } from './demoMode.js';

// CS-038: the stub never engages in a production build. STUB gates on the STATIC Vite mode via
// DIRECT OPTIONAL-CHAINED reads — Vite inlines each `import.meta.env?.KEY` to a literal, so STUB
// folds to a compile-time `false` in `npm run build` and every `if (!STUB) return api(...)` DCEs
// the stub body + the 'cs-stub:team' sentinel (check-bundle-stubs.mjs asserts it). Two things
// are load-bearing, proven the hard way in Vite 8: (1) the reads are `?.` so bare Node — where
// import.meta.env is undefined (test-orphan-adopt / test-team-logins import this module) — reads
// undefined, not a throw; (2) there is NO bare `import.meta.env` and NO `typeof import.meta`
// guard IN the STUB expression — either one makes rolldown hoist a runtime `var`, and STUB (with
// the stub bodies) then shipped, which is exactly the pre-fix bug this replaces. `MODE === 'demo'`
// keeps the stub in build:demo; VITE_INTEGRATIONS_STUB=1 keeps it in a non-production dev build.
// The BACKEND url below is a direct NAMED read (`import.meta.env?.VITE_FORMS_BACKEND_URL`), the
// same optional-chained form the STUB gate uses, so Vite inlines ONLY that one key. It must
// NEVER be a whole-object `import.meta.env` read (e.g. an `env` alias): that inlines the entire
// env object — on Vercel every VITE_VERCEL_* system var — into this chunk (CS-398). test-env-inline-scan.mjs enforces it. See lib/demoMode.js.
const STUB =
  import.meta.env?.MODE === 'demo' ||
  (!import.meta.env?.PROD && (import.meta.env?.VITE_INTEGRATIONS_STUB === '1' || import.meta.env?.VITE_INTEGRATIONS_STUB === 'true'));
if (STUB) markStub('cs-stub:team');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let m = `Request failed (${res.status})`;
    try { m = (await res.json()).error || m; } catch { /* non-JSON */ }
    throw new Error(m);
  }
  return res.json();
}

// Creates the login — OR adopts one that already exists with no team record (the
// orphan case; see _lib/users.js adoptOrphanLogin). The response's `orgUserId` is
// authoritative: on an adopt it is the id already stamped into that login's JWT,
// and the caller MUST use it for the roster row rather than its own minted id,
// or the trust root ends up pointing at a member who doesn't exist.
export async function createTeamLogin(email, role, orgUserId) {
  if (!STUB) return api('/settings/users', { method: 'POST', body: { email, role, orgUserId } });
  return { id: `stub_${Math.random().toString(36).slice(2, 10)}`, invited: true, adopted: false, orgUserId };
}
// Which id the roster row must carry, given what the server returned and the id
// the caller minted before the call. THE SERVER WINS. On an adopt its value is
// the org user id already stamped into that login's JWT, and every server gate
// (labor, QC attribution, push delivery, site assignment) resolves identity
// through that claim — so writing the minted id instead would leave the trust
// root pointing at a member who does not exist, which is the exact failure this
// whole path exists to repair. Named and tested rather than inlined as `||` so a
// later tidy-up cannot quietly drop it (scripts/test-orphan-adopt.mjs).
export function bindRosterId(result, mintedId) {
  const fromServer = result?.orgUserId;
  return (typeof fromServer === 'string' && fromServer) ? fromServer : mintedId;
}
// Logins with no roster row — a member whose invite only half-landed. Drives the
// reconciliation banner on Settings → Team so the state is visible rather than
// waiting to be noticed. Stub mode has no auth backend, so there are none.
export async function listOrphanLogins() {
  if (!STUB) return api('/settings/users/orphans');
  return { orphans: [] };
}
// Re-stamps the server-side JWT trust root (app_metadata role / org user id) so
// it can never drift from the store record. Called whenever a member's role
// changes — the claim, not the blob field, is what server gates will trust.
export async function syncTeamClaims(email, role, orgUserId) {
  if (STUB) return { ok: true };
  const r = await api('/settings/users/claims', { method: 'POST', body: { email, role, orgUserId } });
  // The endpoint answers HTTP 200 with {ok:false, missing:true} when no login
  // matches the roster email. Treating that as success let TeamDetail write
  // the BLOB half anyway — a silent split-brain where the UI showed the new
  // role and every server gate enforced the old one (2026-07-30 roles
  // incident). An un-synced claim is a FAILURE the caller must abort on.
  if (r && r.ok === false) {
    throw new Error(r.missing
      ? 'No login exists for this email yet. Invite them first (Settings → Team → Add), then set the role.'
      : (r.error || 'Role claim update failed. The change was NOT applied.'));
  }
  return r;
}
// Self-heal a MISSING roster row from the tamper-proof JWT claim — the orphan-
// login lockout (2026-08-03). Fire-and-forget on boot when the client resolved
// identity from the claim alone (selectCurrentUser().__fromClaim). The server is
// add-only + claim-gated; a successful write bumps org_state_signal so the client
// pulls the repaired roster over Realtime. Stub (local) mode is inert.
export async function reconcileSelf() {
  if (STUB) return { ok: true, reconciled: false };
  return api('/settings/users/reconcile-self', { method: 'POST' });
}
// The LOGIN half of a Team › Profile save that changes a member's status and/or role, in
// the order that keeps it in step with the roster: the status (ban / unban) FIRST, then
// the role claim, and a failure at the second step puts the first back. Status first
// because its undo is always allowed (re-enabling follows the same rule as disabling),
// while a role can't always be given back: a caller may demote someone to a level they
// may give but not restore one they couldn't have given (lib/roles canGiveRole), so the
// old role-first order could leave a changed claim on a roster row that still read the
// old role. Both steps must land before the roster change is dispatched.
// Returns null when both landed (or nothing changed), else { step: 'status'|'role', error }
// with nothing left changed (best effort: an undo that fails is not retried).
// `deps` is for tests; the app passes nothing.
export async function applyLoginChanges({ email, orgUserId, role, status }, deps = {}) {
  const setDisabled = deps.setDisabled || setTeamLoginDisabled;
  const syncClaims = deps.syncClaims || syncTeamClaims;
  const statusChanged = !!status && status.to !== status.from;
  const roleChanged = !!role && role.to !== role.from;
  if (statusChanged) {
    try {
      await setDisabled(email, status.to === 'disabled');
    } catch (error) {
      return { step: 'status', error };
    }
  }
  if (roleChanged) {
    try {
      await syncClaims(email, role.to, orgUserId);
    } catch (error) {
      if (statusChanged) {
        try { await setDisabled(email, status.from === 'disabled'); } catch { /* best effort */ }
      }
      return { step: 'role', error };
    }
  }
  return null;
}
export async function deleteTeamLogin(email) {
  if (!STUB) return api('/settings/users/delete', { method: 'POST', body: { email } });
  return { ok: true };
}
export async function setTeamLoginDisabled(email, disabled) {
  if (!STUB) return api('/settings/users/disable', { method: 'POST', body: { email, disabled } });
  return { ok: true };
}
// Emails the member a Supabase password-reset link via Resend (gated by
// staff.resetPassword — Super Admin, Admin and Manager by default; only a Super Admin
// can target a Super Admin). The link goes to the member's inbox — the caller never
// sees the password.
export async function sendTeamPasswordReset(email) {
  if (!STUB) return api('/settings/users/reset-link', { method: 'POST', body: { email } });
  return { ok: true };
}

// Fleet build telemetry for the Settings → Team "App versions" card (Sept 1
// hardening). Owner/admin only server-side. Stub mode: empty (no fleet).
export async function listHeartbeats() {
  if (STUB) return { rows: [], newestBuild: 0 };
  return api('/state/heartbeat');
}
