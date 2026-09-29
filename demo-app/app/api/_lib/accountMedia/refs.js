// Resolve an account_media `ref_id` to the record that OWNS it, so media routes can
// authorize against THAT record's site/account instead of a caller-supplied id.
//
// WHY (AUTHORIZATION_AUDIT.md §2026-07-20 OPEN #5 + #6) — the authorization key was
// not the filter key:
//
//   * GET /list gated on `?siteId=`, but `listMedia` filters on `ref_id` whenever one
//     is present and DISCARDS the gated site entirely. A crew user assigned to one
//     site passed the gate with that site and read the media of any inspection,
//     problem report or clean at ANY site. Because the gate never constrained what
//     came back, revoking someone's assignment to the site whose media they were
//     reading changed nothing — access was effectively permanent.
//   * POST /confirm gated on `body.siteId` but wrote `ref_id` / `client_id` verbatim,
//     so the same caller could attach an image to a manager's inspection record — and
//     inspection photos render on the CLIENT-FACING public report (qc/store.js
//     getInspectionByToken).
//
// "They would have to know the id" was never a boundary: blob ids are readable by
// every authenticated user under the open org_state RLS.
//
// THE RULE: when a refId is present, the owning record is the authorization subject
// AND the source of truth for site/client. Nothing about the placement of a media row
// is taken from the request body — the same principle jobsTable.toRow already applies
// to organization_id.
//
// Scope is REQUIRED alongside a refId. Without it `listMedia` skips its scope filter
// and there is no way to know which table owns the id, so it cannot be authorized at
// all. Every real caller already sends one (accountMediaApi.js defaults it).
//
// ⚠️ WHAT THIS DOES **NOT** CLOSE — job forgery. The media routes pass
// `allowJobBased: true`, so requireSiteAssignment still accepts assignment derived
// from `public.jobs`, which remains `using(true) with check(true)` until Increment
// 1e. An authenticated user can INSERT a job naming themselves at a victim site and
// satisfy the gate on ANY site — including the site this module resolves an owner to.
// So resolution narrows #5/#6 from "any record, no assignment needed" to "any record
// at a site you can forge a job for"; it does not make the site gate tamper-proof.
//
// (An earlier draft of this comment claimed the resolved site "is still checked
// against the tamper-proof crew_assignments table". That is only true when
// `allowJobBased` is false, which it is not here. Corrected rather than deleted so
// the overclaim is not repeated.)
//
// api/qc/[...path].js reaches the OPPOSITE conclusion for the same threat and
// excludes job membership deliberately — which leaves QC record metadata protected
// while the photos attached to those same records are not. Aligning them cannot be a
// one-line toggle: crew legitimately shoot before/after photos on jobs at sites they
// are not standing crew for, so `allowJobBased: false` here would break the MyDay
// capture flow until crew_assignments carries job-derived assignment too. Recorded in
// LOOP_REVIEW.md §3 for a human call.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { getJobById } from '../jobsTable.js';

// Scopes whose rows carry a ref_id, and the table that owns it. A scope absent from
// this map must NEVER be combined with a refId — see resolveRefOwner.
export const REF_SCOPE_TABLES = {
  inspection: 'inspection_records',
  problem_report: 'problem_reports',
  clean: null, // public.jobs, read through jobsTable.getJobById (blob text id, not uuid)
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRefScope(scope) {
  return Object.prototype.hasOwnProperty.call(REF_SCOPE_TABLES, scope);
}

// { ok: true, siteId, clientId } | { ok: false, reason: 'invalid' | 'not_found' }
//
// Fails CLOSED on every unknown. A caller that cannot be resolved to an owning record
// must not be authorized against a caller-supplied siteId — that is the bug itself.
//
// The two failure reasons are NOT interchangeable. 'invalid' means the request could
// never name a real record (bad scope, malformed id) and is always a hard deny.
// 'not_found' means the id is well-formed but no row exists — which for `clean` is a
// routine, benign race: the jobs mirror is debounced ~600ms and best-effort, so a job
// opened the instant it is created has no `public.jobs` row yet. Callers distinguish
// them; see the route.
export async function resolveRefOwner({ scope, refId }) {
  if (!refId) return { ok: false, reason: 'invalid' };
  if (!scope || !isRefScope(scope)) {
    // 'cleaning_instruction' and 'security' are site-level and carry no ref_id, so a
    // refId sent with either is either a client bug or an attempt to reach a record
    // through a scope that skips resolution.
    return { ok: false, reason: 'invalid' };
  }

  if (scope === 'clean') {
    const job = await getJobById(String(refId));
    if (!job) return { ok: false, reason: 'not_found' };
    return { ok: true, siteId: job.siteId || null, clientId: job.clientId || null };
  }

  // inspection_records.id / problem_reports.id are uuid columns — a non-uuid would
  // make PostgREST raise 22P02 and surface as a 500 rather than a clean denial.
  if (!UUID_RE.test(String(refId))) return { ok: false, reason: 'invalid' };

  const table = REF_SCOPE_TABLES[scope];
  const { data, error } = await getSupabase()
    .from(table).select('site_id, client_id')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', refId).maybeSingle();
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  if (!data) return { ok: false, reason: 'not_found' };
  return { ok: true, siteId: data.site_id || null, clientId: data.client_id || null };
}

// Validate a client-supplied Storage object path before it is recorded.
//
// `confirmUpload` wrote `storage_path` verbatim and `listMedia` mints a signed URL for
// whatever it finds there, so an unvalidated path is a read primitive for any object
// in the private bucket. Paths are minted by signedUploadUrl as exactly
// `<org>/<siteId|'site'>/<16-char id>.<ext>` — anything else was not minted for this
// caller. Binding the middle segment to the site the upload URL was requested for is
// what stops a row being filed against one site with another site's bytes.
export function isValidStoragePath(storagePath, siteId) {
  const p = String(storagePath || '');
  if (!p || p.startsWith('/') || p.includes('..') || p.includes('\\')) return false;
  const seg = p.split('/');
  if (seg.length !== 3) return false;
  if (seg[0] !== CLEANSPACE_ORG_ID) return false;
  if (seg[1] !== (siteId || 'site')) return false;
  return /^[a-z0-9]+\.[a-z0-9]+$/i.test(seg[2]);
}
