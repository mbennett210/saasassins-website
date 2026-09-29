// Server-side access to the shared org-state JSONB document (the whole app
// store), mirroring src/store/sync.js but using the service-role client. A DB
// trigger keeps `org_state_signal` in lockstep with every write, so a CAS
// update here automatically notifies open clients over Realtime.

import { getSupabase } from './supabase.js';
import { cached, invalidate, ORG_STATE_KEY } from './requestCache.js';
import { MAX_STATE_BYTES } from './blobBudget.js';
import { protectedFingerprint } from './orgStateGuard.js';

// Must match the client's org id (src/store/sync.js ORG_ID). Single-org
// deployment, so the default UUID matches the client default; set CLEANSPACE_ORG_ID
// on the backend too if you ever override VITE_CLEANSPACE_ORG_ID on the frontend.
const ORG_ID = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';

async function readOrgStateUncached() {
  const { data, error } = await getSupabase()
    .from('org_state')
    .select('state, version')
    .eq('organization_id', ORG_ID)
    .maybeSingle();
  if (error) throw new Error(`org_state read failed: ${error.message}`);
  return data || { state: {}, version: 0 };
}

// Memoized PER REQUEST (§8 G2). This pulls the ~900 KB blob and is called from 20
// files — a single QC request resolves crew scope six times, each a full fetch.
//
// The cache is request-scoped via AsyncLocalStorage, never module-level: Vercel reuses
// warm instances, so a TTL cache would hand one user a snapshot fetched during another
// user's request — and this blob is the authorization source. Outside a request
// context it passes straight through, so routes opt in individually.
//
// ⚠️ Any code path that WRITES org_state and then reads it again must call
// invalidate(ORG_STATE_KEY) in between, or it will get its own pre-write snapshot.
export async function readOrgState() {
  return cached(ORG_STATE_KEY, readOrgStateUncached);
}

// The blob PLUS the server-controlled fleet controls (min_client_build, freeze_strip),
// in one read — what GET /api/state/view returns so a crew client's view fetch carries the
// same fleet directives the direct org_state read used to (store/sync.js applyFleetControls).
// Service-role (bypasses RLS), so it is unaffected by the crew read-split policy. Not
// request-cached: the view route reads it once per request.
export async function readOrgStateWithControls() {
  const { data, error } = await getSupabase()
    .from('org_state')
    .select('state, version, min_client_build, freeze_strip')
    .eq('organization_id', ORG_ID)
    .maybeSingle();
  if (error) throw new Error(`org_state read failed: ${error.message}`);
  return {
    state: data?.state || {},
    version: typeof data?.version === 'number' ? data.version : 0,
    minClientBuild: data?.min_client_build ?? null,
    freezeStrip: Array.isArray(data?.freeze_strip) ? data.freeze_strip : [],
  };
}

// THE STORED DIGEST NAMES THE COMMIT IT DESCRIBES: `protected_fingerprint` holds
// `<digest>@<version>/<updated_at in ms>`, written in the same UPDATE as the row's own
// version and updated_at. It vouches for the committed protected content only while the
// row is still that commit: every writer in this repo moves `updated_at` (the route,
// writeOrgState, the operator scripts, the pre-1e fallback), so after any of them the tag
// no longer matches and the org-state route takes the full check instead of matching
// content the digest may not describe any more. Binding the time as well as the version
// keeps that true when a version NUMBER comes back (a restore that rewound it, then a write
// that bumped it again). ⚠️ Nothing in the database enforces it: a hand SQL or Studio edit
// that keeps both `version` and `updated_at` leaves the tag matching, so a save putting the
// older protected content back still takes the fast path (as before tags existed); but
// writeOrgState won't vouch over such an edit, and the next full check raises the baseline
// alarm. A BEFORE UPDATE trigger that moves updated_at would close it (DDL; not added,
// 2026-09-23). Before 2026-09-23 the column held the bare digest and only
// the route refreshed it: a save that put a server write's protected change back (crew
// removing a member reconcile-self had added) matched the older digest and committed
// unchecked. '@' is outside every digest format the column holds or may hold (base36, hex,
// base64url with '.' and ':'), so the last `@<digits>/<digits>` is always the tag; a value
// without one (stored before tagging, or garbage) vouches for nothing.
const tagDigest = (digest, version, at) => `${digest}@${version}/${Date.parse(at)}`;
export function parseStoredDigest(stored) {
  if (typeof stored !== 'string') return { fingerprint: null, taggedVersion: null, taggedAt: null };
  const m = /^(.*)@(\d+)\/(\d+)$/.exec(stored);
  return m ? { fingerprint: m[1], taggedVersion: Number(m[2]), taggedAt: Number(m[3]) } : { fingerprint: stored, taggedVersion: null, taggedAt: null };
}

// Whether a stored digest (a readProtectedFingerprint() result) vouches for the committed
// row at `version`: a server writer stored it in the very commit that produced the row.
// The org-state route's fast path runs on it (it can't look at the content without the
// full read it exists to skip). Unknown is false: fail closed.
export function isDigestCurrent(read, version) {
  return !!read && read.fingerprint != null && read.version === version
    && read.taggedVersion === version && read.taggedAt != null && read.taggedAt === Date.parse(read.updatedAt);
}

// Cheap pre-write read: the committed authority digest (~100 bytes), the commit it was
// stored for, and the row's version + updated_at. The digest is compared against one
// computed from the incoming state (free), so the expensive protected-slice read only
// happens when something authority-bearing moved; the row version lets
// api/state/org-state.js answer any version but the save's base as a CAS miss before
// anything is judged. A NULL fingerprint means "unknown" and forces the deeper check (the
// safe direction), and so does a digest stored for another commit (isDigestCurrent). null
// (no row, or the read failed) is "unknown" too.
export async function readProtectedFingerprint() {
  const { data } = await getSupabase()
    .from('org_state').select('protected_fingerprint, version, updated_at')
    .eq('organization_id', ORG_ID).maybeSingle();
  return data ? { ...parseStoredDigest(data.protected_fingerprint), version: data.version ?? null, updatedAt: data.updated_at ?? null } : null;
}

// The authority-bearing slices, projected out of the 843 KB blob (~314 KB).
// Only read when the fingerprint says something changed.
export async function readProtectedSlices(select) {
  const { data, error } = await getSupabase()
    .from('org_state').select(select)
    .eq('organization_id', ORG_ID).maybeSingle();
  if (error) throw new Error(`org_state protected read failed: ${error.message}`);
  return data || null;
}

// Client-originated CAS write (Increment 1d: server-mediated writes). Same
// optimistic CAS as writeOrgState, plus two things that only apply to a browser
// save: real `updated_by` provenance (from the caller's JWT claim, never the
// request body) and the build/tab stamps the prune gate is checked against.
//
// The fleet gate rides IN the predicate rather than as a separate read: the row
// must have `min_client_build IS NULL` or `<= build`. That keeps the write a
// single round-trip, and a stale-build tab simply matches no row. Callers
// disambiguate conflict-vs-gate with one read (describeWriteMiss), only when the
// write cannot land.
//
// A build of 0 means "unknown build id" — the gate is SKIPPED, matching the
// client's deliberate fail-open (a misconfigured build must never block saves).
export async function writeOrgStateFromClient({ state, baseVersion, userId, build = 0, tab = null, fingerprint = undefined }) {
  // Any memoized snapshot is now stale by definition. Dropped BEFORE the write, not
  // after, so a concurrent reader in this request cannot latch the pre-write value
  // into the cache while the update is in flight.
  invalidate(ORG_STATE_KEY);
  const at = new Date().toISOString(); // one instant for updated_at AND the digest's tag
  let q = getSupabase()
    .from('org_state')
    .update({
      state,
      version: baseVersion + 1,
      updated_by: userId ?? null, // Auth UUID — the column is uuid, not text
      updated_at: at,
      updated_by_build: build,
      updated_by_tab: tab,
      // The 1e revoke gate. build/tab are client-supplied and copied verbatim,
      // so they cannot distinguish a server write from a direct browser write —
      // this can. Gate query: zero 'browser' rows over a full soak window.
      updated_via: 'server',
      // Recorded on every commit, tagged with the commit it describes, so the NEXT
      // write can skip the protected-slice read. Omitted (undefined) leaves the column
      // untouched.
      ...(fingerprint === undefined ? {} : { protected_fingerprint: fingerprint == null ? null : tagDigest(fingerprint, baseVersion + 1, at) }),
    })
    .eq('organization_id', ORG_ID)
    .eq('version', baseVersion);
  if (build > 0) q = q.or(`min_client_build.is.null,min_client_build.lte.${build}`);
  const { data, error } = await q.select('version');
  if (error) throw new Error(`org_state write failed: ${error.message}`);
  return Array.isArray(data) && data.length === 1 ? { ok: true, version: baseVersion + 1 } : { ok: false };
}

// First-run bootstrap: create the org's row if it does not exist yet.
// Idempotent — `ignoreDuplicates` makes a race between two first-time sign-ins
// safe, and an existing row is left completely untouched.
//
// This exists because the seed was the one remaining DIRECT browser write
// (store/sync.js first-run path). Dormant on an established org, but it is the
// boot path for every new client clone, so Increment 1e's policy revoke would
// otherwise make a fresh clone unable to seed itself.
export async function seedOrgState(state, userId) {
  const { error } = await getSupabase()
    .from('org_state')
    .upsert(
      {
        organization_id: ORG_ID,
        state,
        version: 1,
        updated_by: userId ?? null,
        updated_at: new Date().toISOString(),
        updated_via: 'server',
      },
      { onConflict: 'organization_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`org_state seed failed: ${error.message}`);
  return { ok: true };
}

// Why a write cannot land on `baseVersion`: a version conflict (another writer won)
// or the build gate (this tab is below min_client_build). Asked after the CAS
// missed, or before it when the pre-write reads already show another version.
// A failed read THROWS (the caller answers 500): read as "no row", it was reported as
// "org_state row not found — check CLEANSPACE_ORG_ID", sending whoever reads the log
// after an env var that is fine.
export async function describeWriteMiss(baseVersion, build) {
  const { data, error } = await getSupabase()
    .from('org_state')
    .select('version, min_client_build')
    .eq('organization_id', ORG_ID)
    .maybeSingle();
  if (error) throw new Error(`org_state miss read failed: ${error.message}`);
  // No row for this org at all — almost always a server/client ORG_ID mismatch
  // (CLEANSPACE_ORG_ID vs VITE_CLEANSPACE_ORG_ID; .env.example warns they must be set
  // together). Reported as `missing`, NOT as a conflict: telling the client
  // "conflict" would send it into adopt→replay→save against a row that does not
  // exist, a 600ms hot loop with no backoff and no offline status.
  if (!data) return { version: null, minClientBuild: null, gated: false, conflict: false, missing: true };
  const min = data.min_client_build ?? null;
  const gated = build > 0 && min != null && build < min;
  return { version: data.version ?? null, minClientBuild: min, gated, conflict: !gated && data.version !== baseVersion, missing: false };
}

// Optimistic compare-and-swap write: only succeeds if `version` is still
// `baseVersion`. Returns true on success, false if another writer moved the
// version under us (caller should re-read and retry). The trigger bumps
// org_state_signal → Realtime → clients pull.
// `prev` (optional): the state the caller read and changed. Pass it when the change
// touches a protected field, so the digest can still be kept current (see below).
export async function writeOrgState(state, baseVersion, { prev } = {}) {
  invalidate(ORG_STATE_KEY); // see writeOrgStateFromClient

  // 🔴 THE SAME CEILING THE CLIENT ROUTE ENFORCES. This path had no size check at all,
  // while api/state/org-state.js rejected an oversized body with a 413. 14 call sites (in
  // 12 files) use this — including the SESSION-LESS public lead webhook
  // (api/webhooks/[...path].js: a per-endpoint bearer token, or an optional HMAC), which
  // inserts a contact per delivery through leads/upsert.js ingestLead. So the blob
  // could be grown past the ceiling through a path that never looked, and past it EVERY
  // BROWSER SAVE IN THE ORG 413s: a fleet-wide outage reachable without credentials.
  //
  // Throwing is the right failure here, and deliberately so. Every caller runs this in a
  // CAS retry loop checking the boolean return and does NOT catch, so a throw surfaces
  // loudly — one cron run or one form submission fails visibly, instead of the blob
  // growing silently until all 43 users are wedged. Over the cap both write paths are
  // then blocked, which is not a regression: at that size the org is already broken from
  // the browser's side, and recovery was always going to be a data-op. What this buys is
  // that the state is no longer REACHABLE by an anonymous request.
  const bytes = Buffer.byteLength(JSON.stringify(state ?? null), 'utf8');
  if (bytes > MAX_STATE_BYTES) {
    throw new Error(
      `org_state write refused: ${Math.round(bytes / 1024)} KB exceeds the ${Math.round(MAX_STATE_BYTES / 1024)} KB ceiling. `
      + 'Shrink the blob (a data-op) before further server writes.',
    );
  }

  // ⚠️ KEEP THE DIGEST CURRENT, BUT VOUCH ONLY FOR WHAT A SERVER WRITER VOUCHED FOR. Until
  // 2026-09-23 only the org-state route stored it, so after a server write here changed a
  // protected field (reconcile-self appending a roster row) the digest still described the
  // older content: a save putting that content back matched it and skipped the field
  // guard. But the digest of what this call commits must not be stored blindly either:
  // `state` is the caller's read plus its change, and if anything outside the server paths
  // changed a protected field since the last server-stored digest (an operator script, the
  // pre-1e fallback, a direct or Studio write, even one that kept `version` and
  // `updated_at`), stamping it would launder that change: no baseline alarm, no
  // crew-assignment sync. So the new digest is stored only when the stored one (one
  // ~100-byte read) still describes the row this write replaces: it equals the digest of the
  // caller's read (`prev`) when the caller changed something protected, or else of `state`
  // itself, whose protected fields are then the row's, unchanged. That checks the content,
  // so unlike the route's fast path it needs no tag: an outside write that changed nothing
  // protected is re-vouched here (the next save keeps the fast path), one that changed
  // something is not. Otherwise the column is left as it is, and the next org-state save
  // takes the full check and raises the alarm. A digest that cannot be computed (a hostile
  // row) is left the same way: the write must not fail.
  const at = new Date().toISOString(); // one instant for updated_at AND the digest's tag
  let digest;
  try {
    const stored = await readProtectedFingerprint();
    if (stored?.fingerprint != null) {
      const next = protectedFingerprint(state);
      const before = prev === undefined ? next : protectedFingerprint(prev);
      if (before === stored.fingerprint) digest = tagDigest(next, baseVersion + 1, at);
    }
  } catch {
    digest = undefined;
  }

  const { data, error } = await getSupabase()
    .from('org_state')
    .update({
      state,
      version: baseVersion + 1,
      updated_by: null, // server write — no human author
      // ⚠️ STAMP THIS. An UPDATE that omits a column leaves the previous value in place,
      // so every server write through here inherited whatever the LAST writer set —
      // typically 'browser'. `updated_via` is the Increment 1e signal for "is anything
      // still writing from a browser", and its two siblings in this same file
      // (writeOrgStateFromClient and seedOrgState) both stamp it. Its server callers (14
      // call sites today) silently left it stale, so the gate was reading phantom browser writes and could
      // never have gone quiet. This is a concrete cause of the "1e gate is unanswerable"
      // finding from earlier in this loop.
      updated_via: 'server',
      updated_at: at,
      // The digest decided above (keeps cron writes off the next browser save's ~314 KB
      // protected read). Left out, the column keeps its older commit's tag, which can no
      // longer match this row: the next org-state save takes the full check.
      ...(digest === undefined ? {} : { protected_fingerprint: digest }),
    })
    .eq('organization_id', ORG_ID)
    .eq('version', baseVersion)
    .select('version');
  if (error) throw new Error(`org_state write failed: ${error.message}`);
  return Array.isArray(data) && data.length === 1;
}
