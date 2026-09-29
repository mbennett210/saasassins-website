// Tamper-proof crew -> site/account assignments.
//
// WHY: requireSiteAssignment and crewAssignedScope (authz.js) decide who may
// reveal a site's decrypted door/alarm codes and whose QC records are visible.
// They read that from `standingCrewIds` in the browser-writable org_state blob,
// and from public.jobs, which is `using(true) with check(true)` — so a crew user
// could append their own id, or INSERT a job naming themselves at any site, and
// read every account's access codes. The JWT claim (Increment 1c) fixed WHO you
// are; it never hardened WHAT YOU ARE ASSIGNED TO.
//
// public.crew_assignments has no RLS policies at all, so only the service role
// can write it. The rows are DERIVED from the blob and resynced by the org_state
// write endpoint — which is only trustworthy because orgStateGuard.js already
// rejects a non-manager touching standingCrewIds. Without that guard this table
// would faithfully mirror an attacker's self-assignment and close nothing. The
// two ship together on purpose.
import { getSupabase } from './supabase.js';

const ORG_ID = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';

// Flatten the blob's standing assignments into rows. Pure — exported for tests.
export function assignmentRowsFromState(state) {
  const rows = [];
  const seen = new Set();
  const add = (userId, siteId, clientId, source) => {
    if (!userId) return;
    const key = `${userId}|${source}|${siteId || ''}|${clientId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ organization_id: ORG_ID, user_id: userId, site_id: siteId || null, client_id: clientId || null, source });
  };
  for (const s of Array.isArray(state?.sites) ? state.sites : []) {
    for (const u of Array.isArray(s?.standingCrewIds) ? s.standingCrewIds : []) {
      add(u, s.id, s.clientId || null, 'standing_site');
    }
  }
  for (const c of Array.isArray(state?.clients) ? state.clients : []) {
    for (const u of Array.isArray(c?.standingCrewIds) ? c.standingCrewIds : []) {
      add(u, null, c.id, 'standing_client');
    }
  }
  return rows;
}

// A reserved row proving the table has been synced at least once. It exists so
// "the table is empty" can be told apart from "the table has never been written",
// which are the same query result but opposite security answers — see
// assignmentsInitialized(). `user_id` is a sentinel no real `u_*` id can collide
// with, and every read filters by the caller's own user_id, so it never matches.
const SYNC_MARKER_USER_ID = '__sync_marker__';
const markerRow = () => ({
  organization_id: ORG_ID, user_id: SYNC_MARKER_USER_ID,
  site_id: null, client_id: null, source: 'marker',
});

const rowKey = (r) => `${r.user_id}|${r.source}|${r.site_id || ''}|${r.client_id || ''}`;

// Bring the assignment set in line with what the given state implies. Called after a
// committed org_state write whose authority digest moved, so it runs rarely.
//
// ⚠️ ADD-THEN-REMOVE, NEVER CLEAR-THEN-REFILL. This used to
// `delete(org) → insert(rows)` in two unsynchronized statements with no transaction.
// PostgREST gives no transaction across calls, so a failure between them — or a
// failing insert chunk — left the table EMPTY. Permanently and silently, because the
// caller swallowed the throw and returned 200. And an empty table is not a closed
// door: assignmentsInitialized() reads it as "never synced" and every gate falls back
// to the browser-writable blob, restoring the exact self-assignment hole this table
// exists to close. The destructive window also applied to every concurrent request.
//
// Diffing instead: insert what is missing, then delete what is stale. A failure at
// any point leaves a SUPERSET of the truth — slightly stale, never empty, never a
// blob fallback — and the next sync converges it. The original comment argued a full
// replace "cannot drift" while a diff might; that traded a bounded staleness risk for
// an unbounded availability-and-security one.
export async function syncAssignmentsFromState(state) {
  const db = getSupabase();
  const desired = [...assignmentRowsFromState(state), markerRow()];
  const desiredKeys = new Set(desired.map(rowKey));

  const { data: existing, error: readErr } = await db
    .from('crew_assignments').select('id, user_id, site_id, client_id, source')
    .eq('organization_id', ORG_ID);
  if (readErr) throw new Error(`crew_assignments read failed: ${readErr.message}`);

  const existingKeys = new Set((existing || []).map(rowKey));
  const toAdd = desired.filter((r) => !existingKeys.has(rowKey(r)));
  const staleIds = (existing || []).filter((r) => !desiredKeys.has(rowKey(r))).map((r) => r.id);

  // ADD FIRST — plain INSERT, deliberately NOT an upsert.
  //
  // ⚠️ `onConflict` CANNOT BE USED HERE, and getting this wrong breaks the table
  // permanently. crew_assignments_uidx is a unique index over EXPRESSIONS:
  //     (organization_id, user_id, source, COALESCE(site_id,''), COALESCE(client_id,''))
  // PostgREST's onConflict emits a bare column list, which does not match an
  // expression index, so Postgres raises 42P10 ("no unique or exclusion constraint
  // matching the ON CONFLICT specification"). That throws out of here on EVERY sync
  // that has anything to add — the caller retries once, gives up, and the assignment
  // table then never updates again: revoked crew keep access and new assignments never
  // land. Strictly worse than the delete-then-insert this replaced.
  //
  // A plain insert is correct because `toAdd` is already diffed against what exists.
  // The only way to hit a duplicate is a CONCURRENT sync inserting the same row
  // between our read and our write — and that row existing is exactly the end state we
  // wanted, so 23505 is benign here and must not fail the pass.
  // ⚠️ A conflict aborts the WHOLE statement, so 23505 on a 500-row chunk cannot just
  // be swallowed — that would silently drop 499 good rows and leave crew unassigned
  // until the next authority change, which may be weeks away. On conflict the chunk is
  // retried row-by-row so only the genuinely-duplicate row is skipped. Cold path:
  // concurrent syncs only happen when two authority changes race.
  for (let i = 0; i < toAdd.length; i += 500) {
    const chunk = toAdd.slice(i, i + 500);
    const { error } = await db.from('crew_assignments').insert(chunk);
    if (!error) continue;
    if (error.code !== '23505') throw new Error(`crew_assignments insert failed: ${error.message}`);
    for (const row of chunk) {
      // eslint-disable-next-line no-await-in-loop -- cold path, correctness over speed
      const { error: rowErr } = await db.from('crew_assignments').insert(row);
      if (rowErr && rowErr.code !== '23505') throw new Error(`crew_assignments insert failed: ${rowErr.message}`);
    }
  }
  // REMOVE SECOND, and only ever by explicit id — never a broad org-scoped delete,
  // which is what made the old version able to empty the table.
  for (let i = 0; i < staleIds.length; i += 500) {
    const { error } = await db.from('crew_assignments').delete()
      .eq('organization_id', ORG_ID).in('id', staleIds.slice(i, i + 500));
    if (error) throw new Error(`crew_assignments prune failed: ${error.message}`);
  }
  return { rows: desired.length - 1, added: toAdd.length, removed: staleIds.length };
}

// The site ids and client ids a user is assigned to, from the tamper-proof
// table. Every site of an assigned ACCOUNT counts as an assigned site — the same
// rule crewAssignedScope already applied, resolved here against the blob's site
// list (which is safe to read for topology; only the ASSIGNMENT had to move).
export async function getAssignedScope(orgUserId, state) {
  if (!orgUserId) return { siteIds: [], clientIds: [] };
  const { data, error } = await getSupabase()
    .from('crew_assignments').select('site_id, client_id')
    .eq('organization_id', ORG_ID).eq('user_id', orgUserId);
  if (error) throw new Error(`crew_assignments read failed: ${error.message}`);
  const siteIds = new Set();
  const clientIds = new Set();
  for (const r of data || []) {
    if (r.site_id) siteIds.add(r.site_id);
    if (r.client_id) clientIds.add(r.client_id);
  }
  for (const s of Array.isArray(state?.sites) ? state.sites : []) {
    if (s?.clientId && clientIds.has(s.clientId)) siteIds.add(s.id);
  }
  return { siteIds: [...siteIds], clientIds: [...clientIds] };
}

export async function isAssignedToSite(orgUserId, siteId, state) {
  if (!orgUserId || !siteId) return false;
  const { siteIds } = await getAssignedScope(orgUserId, state);
  return siteIds.includes(siteId);
}

// Have assignments ever been synced? Until the first sync the table is empty, and an
// empty table must NOT read as "nobody is assigned to anything" — that would lock
// every crew member out of the sites they legitimately work. Callers fall back to the
// legacy blob path while this is false.
//
// ⚠️ IT THROWS ON A READ ERROR, AND MUST. It used to `if (error) return false`, so any
// transient Supabase hiccup silently answered "never synced" and handed every gate
// back to the browser-writable blob — re-opening self-assignment for the duration,
// with nothing logged. That is a security control failing OPEN on a network blip.
//
// Throwing instead means one request fails closed: requireSiteAssignment catches and
// 403s, the QC routes 500. A transient failure therefore costs a retry, not a hole.
// Callers must NOT catch this and treat it as "not initialized".
//
// The `marker` row (see syncAssignmentsFromState) is what makes a genuinely
// assignment-free org distinguishable from an un-synced one: it is counted here, so a
// synced org always reads initialized even with zero real assignments. Without it,
// an org that legitimately assigns nobody would fall back to the blob forever —
// and the blob is exactly where an attacker would add themselves.
export async function assignmentsInitialized() {
  const { count, error } = await getSupabase()
    .from('crew_assignments').select('user_id', { count: 'exact', head: true })
    .eq('organization_id', ORG_ID);
  if (error) throw new Error(`crew_assignments init check failed: ${error.message}`);
  return (count ?? 0) > 0;
}
