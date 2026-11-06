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
  // CS-547 — a checklist ITEM's required photo. The ref is the SUBMISSION's caller-minted
  // id (`checklist_results.client_submit_id`), not the row's: the cleaner shoots the photo
  // while filling the checklist, so on the normal path NO ROW EXISTS YET and resolution
  // soft-misses exactly as a not-yet-mirrored `clean` does (see MISS_SCOPES in the route).
  // The boundary for a pre-submit photo is therefore the SITE gate the caller already
  // passed, which is the same gate that decides whether they may submit the checklist
  // there at all. Once the row exists, its own site/client take over — so a photo added to
  // a submitted checklist is re-gated on the record, like an inspection's.
  checklist: 'checklist_results',
  // The photo a CLIENT attached to their own ticket from the hub (migration 20261004100100).
  // Owned by the ticket like a completion photo, but kept at its own scope so it can never
  // count as one (WO-10). WRITTEN only by POST /api/hub/ticket-photo — /confirm below refuses
  // this scope — and READ by the office's work-order drawer through /list, gated on the
  // ticket's own site like every other ref scope.
  client_ticket: 'problem_reports',
  // S131 — a supply ORDER's delivery photo (migration 20261014120000). The ref is the order's
  // caller-minted TEXT id (`sr_…`, not a uuid: resolved by its own branch below); `area_id` is the
  // line's catalog item when the photo is of one item. NOT site-gated: an order is gated by the
  // supply keys (supplyMediaGrant below — the Supply Manager, or the driver on a submitted order);
  // the row is filed under the order's building, with no site.
  supply: 'supply_requests',
  // QR-23 (e) — the one photo a VISITOR attached to a report from a QR code (migration
  // 20261017110000). Owned by the ticket like the customer's photo, at its own scope so it can never
  // count as a completion photo (WO-10) nor read as the customer's. WRITTEN only by the public
  // route (POST /api/public/scan/report, which builds the path itself) — /confirm below refuses
  // this scope — and READ by the office's work-order drawer through /list, gated on the ticket's
  // own site like every other ref scope.
  visitor_report: 'problem_reports',
};
// The supply orders' caller-minted id alphabet (api/_lib/supplies/store.js isSupplyId).
const SUPPLY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// The ref scopes whose id may legitimately name NO row yet. Both are caller-minted ids
// recorded by a later write: a job the mirror has not caught up with, and a checklist
// submission the cleaner has not finished.
export const SOFT_MISS_SCOPES = new Set(['clean', 'checklist']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The caller-minted submission id's alphabet — `cl_<uuid>` from lib/checklistQueue, held
// to the shared id shape because it is interpolated into a PostgREST filter.
const SUBMIT_ID_RE = /^[A-Za-z0-9_\-:.]{1,64}$/;

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

  // CS-547: a checklist photo is filed under the SUBMISSION id, which is a caller-minted
  // text key, not a uuid — so it is matched on `client_submit_id` and held to the id
  // alphabet rather than the uuid shape. 'not_found' is the ordinary pre-submit case.
  if (scope === 'checklist') {
    if (!SUBMIT_ID_RE.test(String(refId))) return { ok: false, reason: 'invalid' };
    const { data, error } = await getSupabase()
      .from('checklist_results').select('site_id, client_id')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('client_submit_id', String(refId)).maybeSingle();
    if (error) throw new Error(`checklist_results read failed: ${error.message}`);
    if (!data) return { ok: false, reason: 'not_found' };
    return { ok: true, siteId: data.site_id || null, clientId: data.client_id || null };
  }

  // S131: a supply order's TEXT id. Its building is the owner; it has no site (an order is not
  // site-gated — supplyMediaGrant decides who may file or read it).
  if (scope === 'supply') {
    const order = await supplyOrderRef(refId);
    if (!order) return { ok: false, reason: SUPPLY_ID_RE.test(String(refId)) ? 'not_found' : 'invalid' };
    return { ok: true, siteId: null, clientId: order.clientId };
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

// 🔴 THE CLEANER HUB'S ONE EXCEPTION TO THE SITE GATE (Daniel's D3, "Cleaner closes it"; 2026-10-14).
// The office may put ANY active cleaner on a ticket (api/qc problems/update `crewUserIds`), and a
// cleaner it names must be able to finish THAT ticket even at a building they do not clean: file
// its completion photo (WO-10) and see it. True only when ALL of these hold:
//   · the scope is `problem_report` (a completion photo) and `refId` is a ticket of THIS org;
//   · that ticket's STORED `crew_user_ids` names the caller's claim id (never anything the client
//     sends: the office writes the list, and only the office may);
//   · the ticket's own building is the `siteId` the call is about (the upload link is minted
//     under it, and the row is filed under it).
// Nothing else widens: no other ticket at that building, no other media scope, no site-level
// read or write. Any doubt (a malformed id, a failed read) is false, and the caller falls through
// to requireSiteAssignment exactly as before. → boolean
export const NAMED_TICKET_SCOPE = 'problem_report';
export async function namedTicketGrant({ scope, refId, siteId, userId } = {}) {
  if (scope !== NAMED_TICKET_SCOPE || !refId || !siteId || !userId) return false;
  if (!UUID_RE.test(String(refId))) return false;
  try {
    const { data, error } = await getSupabase()
      .from('problem_reports').select('site_id, crew_user_ids')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', String(refId)).maybeSingle();
    if (error || !data) return false;
    return data.site_id === siteId && Array.isArray(data.crew_user_ids) && data.crew_user_ids.includes(userId);
  } catch {
    return false;   // fail closed: the site gate decides
  }
}

// ── S131: a supply order's delivery photos ─────────────────────────────────────────────────────
// One order, read by its text id: { id, clientId, status, catalogItemIds } or null (a malformed id,
// no such order, a failed read — the caller refuses all of them alike).
export const SUPPLY_MEDIA_SCOPE = 'supply';
export async function supplyOrderRef(refId) {
  if (!refId || !SUPPLY_ID_RE.test(String(refId))) return null;
  try {
    const { data, error } = await getSupabase()
      .from('supply_requests').select('id, client_id, status, lines')
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', String(refId)).maybeSingle();
    if (error || !data) return null;
    const catalogItemIds = (Array.isArray(data.lines) ? data.lines : []).map((l) => l && l.catalogItemId).filter((x) => typeof x === 'string' && x);
    return { id: data.id, clientId: data.client_id || null, status: data.status, catalogItemIds };
  } catch {
    return null; // fail closed
  }
}
// 🔴 WHO MAY FILE OR READ AN ORDER'S PHOTOS (brief S §3) — the supply keys, never a site:
//   upload / confirm — a `supplies.manage` holder (the Supply Manager) on any order; or a
//                      `supplies.deliver` holder ON A SUBMITTED ORDER (the driver's exception, the
//                      way namedTicketGrant above is the named cleaner's: a crew login with the
//                      Deliveries grant may photograph what they drop off, and nothing else);
//   list             — an OFFICE role holding `supplies.view` (the order page); never crew, never the
//                      driver.
// `holds(key)` is the caller's committed-matrix check (authz holdsPermission). PURE given the order.
export function supplyMediaGrant({ action, order, isOffice = false, holds = () => false } = {}) {
  if (!order) return false;
  if (action === 'list') return !!isOffice && !!holds('supplies.view');
  if (action === 'upload') return !!holds('supplies.manage') || (!!holds('supplies.deliver') && order.status === 'sent');
  return false;
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
