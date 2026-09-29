// Build + tab identity, stamped on every write to org_state and public.jobs.
//
// WHY (REMEDIATION_PLAN.md Increment 0.3): `main` is push-to-deploy with NO forced
// client reload, so a tab opened before a deploy keeps running old code indefinitely.
// That is harmless while we only ADD tables — but every slice extraction in Increments
// 3-9 ends with a PRUNE (emptying the slice from the blob), and an old-code tab that
// writes after a prune resurrects the slice into the blob, where new clients ignore it.
// The write is then lost from the system of record. These two values make the fleet
// observable, so "is it safe to prune yet?" becomes a query instead of a guess.

// Monotonic build id, inlined by Vite at build time (see vite.config.js `define`).
// Falls back to 0 when unset — treated as "unknown build", which DISABLES the gate
// rather than tripping it (see minClientBuild handling in store/sync.js). Failing
// open is deliberate: a misconfigured build id must never lock a user out of writing.
export const APP_BUILD = Number(import.meta.env?.VITE_APP_BUILD) || 0;

// Short git SHA of the deployed build, inlined by Vite (vite.config.js:
// VERCEL_GIT_COMMIT_SHA on Vercel, `git rev-parse` locally, '' when neither
// resolves). Display/diagnostics only — support reports stamp it as
// `cleanspace-app@<sha>` so a ticket says exactly which build the reporter ran.
// NOT part of the fleet-reload gate; that stays on the monotonic APP_BUILD.
export const APP_SHA = String(import.meta.env?.VITE_APP_SHA || '');

// Per-tab (really per-page-load) id. Realtime echo suppression MUST key on this, not
// on user id: the same user routinely has several tabs or devices open, and
// suppressing by user id makes tab B discard tab A's write and sit stale until a full
// refetch. Regenerated on every load, which is correct — a reload is a new listener.
export const TAB_ID = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// Stamp applied to every org_state UPDATE and every public.jobs upsert.
//
// `updated_via: 'browser'` marks a DIRECT client write — the path Increment 1e
// revokes. The server endpoints stamp 'server' instead. Without this marker the
// 1e gate is unfalsifiable: build/tab are client-supplied and the server copies
// them verbatim, so the two paths are otherwise byte-identical in the table.
export function writeStamp() {
  return { updated_by_build: APP_BUILD, updated_by_tab: TAB_ID, updated_via: 'browser' };
}
