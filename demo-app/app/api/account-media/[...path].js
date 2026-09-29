// Account media API (Swept replacement — in-app photo + video for sites). Bytes
// go to the private 'ops-media' bucket via a signed upload URL; this route mints
// that URL, records the metadata, lists with signed playback URLs, and deletes.
// Server-side authz: the office roles (every tier but crew) upload/list at any site, as
// the app shows every site to them; crew only at a site they work. Deletion is ops.edit.
// See CLEANSPACE_SWEPT.md §2.2 / §2.4.
//
//   POST /api/account-media/upload-url { siteId, mimeType, sizeBytes }      -> { path, token, signedUrl, kind, thumb? }
//   POST /api/account-media/confirm    { siteId, clientId, scope, areaId, kind, mimeType, storagePath, sizeBytes } -> { media }
//   GET  /api/account-media/list?siteId=&scope=                              -> { media: [...] }
//   POST /api/account-media/delete     { id }                               -> ops.edit
//   POST /api/account-media/caption    { id, caption }                      -> gated on the row's own site (like confirm)
import { requireSiteAssignment, requirePermission, requireAuthority, OFFICE_ROLES } from '../_lib/authz.js';
import { validateUpload, signedUploadUrl, confirmUpload, listMedia, removeMedia, thumbPathFor, mediaOwnerSite, updateCaption, MAX_CAPTION_LEN } from '../_lib/accountMedia/store.js';
import { resolveRefOwner, isValidStoragePath } from '../_lib/accountMedia/refs.js';

// Who reaches a site's media, on every route here: the office roles at any site (the app's
// site visibility is `role !== 'crew'`, so the 4th-tier manager is office too; the old
// owner/admin default refused them, 2026-09-23), crew through standing crew or a job there.
// No job-age cutoff: documenting a clean the next day (or a final occurrence) is legit; the
// tight window stays on code reveal only (#10).
const SITE_OPTS = { managerRoles: OFFICE_ROLES, jobWindow: null, allowJobBased: true };

// Resolve the record that OWNS a refId, and make sure the caller is assigned to THAT
// record's site — never to the siteId they supplied. `listMedia` filters on ref_id and
// ignores site_id, so gating on the caller's site authorized one site and returned
// another's (AUTHORIZATION_AUDIT §2026-07-20 #5/#6).
//
// Returns { status: 'ok', owner } | { status: 'miss' } | { status: 'denied' }
// ('denied' means the response is already written).
//
// ORDERING IS DELIBERATE: callers gate on the caller-supplied siteId BEFORE calling
// this, so the caller is already authenticated and the DB resolution below is never
// reachable unauthenticated. The re-gate here only runs when the owner's site differs
// from the one already gated — which never happens on a legitimate call (every mount
// site passes the record's own site), so the happy path costs exactly one gate and one
// readOrgState, not two.
//
// An owner with no site_id re-gates against null = the office roles only. Deliberate
// fail-closed: both QC creators write `site_id: siteId || null`, so a site-less record
// can exist, and there is no assignment that could scope it.
async function resolveOwnerOrDeny(req, res, { scope, refId, gatedSiteId }) {
  let owner;
  try {
    owner = await resolveRefOwner({ scope, refId });
  } catch (e) {
    console.error('[api/account-media] ref resolve failed', e);
    res.status(403).json({ error: 'Not authorized for this record' });
    return { status: 'denied' };
  }
  if (!owner.ok) {
    // A well-formed `clean` refId with no row is a routine race, not an attack: the
    // jobs mirror is debounced ~600ms and best-effort, so a job opened the moment it
    // is created has no public.jobs row yet. Denying it would turn the crew's primary
    // capture surface (MyDay before/after) into an error toast on a cold job. Callers
    // treat 'miss' as "no owning record" — list returns nothing, confirm files the row
    // under the already-gated site, i.e. exactly the pre-fix behaviour for a ref that
    // points at nothing. Every other failure stays a hard deny.
    if (owner.reason === 'not_found' && scope === 'clean') return { status: 'miss' };
    // Deliberately not echoing owner.reason — distinguishing "no such record" from
    // "not yours" is an existence oracle over ids the caller may not be entitled to
    // probe.
    res.status(403).json({ error: 'Not authorized for this record' });
    return { status: 'denied' };
  }
  if ((owner.siteId || null) !== (gatedSiteId || null)) {
    const g2 = await requireSiteAssignment(req, res, owner.siteId, SITE_OPTS);
    if (!g2) return { status: 'denied' };
  }
  return { status: 'ok', owner };
}

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};

  try {
    if (action === 'upload-url' && req.method === 'POST') {
      const g = await requireSiteAssignment(req, res, body.siteId, SITE_OPTS);
      if (!g) return;
      const v = validateUpload({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!v.ok) return res.status(400).json({ error: v.error });
      const su = await signedUploadUrl({ siteId: body.siteId, mimeType: body.mimeType });
      return res.status(200).json({ ...su, kind: v.kind });
    }

    if (action === 'confirm' && req.method === 'POST') {
      const scope = body.scope || 'cleaning_instruction';
      const refId = body.refId || null;

      // Gate on the site the upload URL was minted for; when a refId is present the
      // OWNING RECORD is authorized as well, and its site/client — not the body's —
      // are what get written. Without that a caller assigned to one site could file
      // an image against a manager's inspection, which renders on the client-facing
      // public report.
      const g = await requireSiteAssignment(req, res, body.siteId, SITE_OPTS);
      if (!g) return;
      let owner = null;
      if (refId) {
        const r = await resolveOwnerOrDeny(req, res, { scope, refId, gatedSiteId: body.siteId });
        if (r.status === 'denied') return;
        // 'miss' leaves owner null: the row is filed under the already-gated site.
        if (r.status === 'ok') owner = r.owner;
      }

      if (!body.storagePath || !body.kind || !body.mimeType) return res.status(400).json({ error: 'storagePath, kind, mimeType are required' });
      // storage_path is written verbatim and listMedia signs whatever it finds there,
      // so an unconstrained path is a read primitive over the whole private bucket.
      if (!isValidStoragePath(body.storagePath, body.siteId)) return res.status(400).json({ error: 'Invalid storagePath' });
      // A thumb that doesn't derive from this object is DROPPED, not rejected. The
      // bytes are already in Storage by the time confirm runs, so 400-ing here would
      // discard an uploaded 200MB video over a best-effort poster. listMedia already
      // falls back to the full-res URL when thumb_path is null.
      const thumbPath = body.thumbPath && body.thumbPath === thumbPathFor(body.storagePath)
        ? body.thumbPath
        : null;

      const media = await confirmUpload({
        scope,
        // Server-derived when a refId owns the row — the same principle jobsTable
        // applies to organization_id. A row whose site_id disagrees with its ref_id's
        // record is exactly the mis-filing this closes.
        clientId: owner ? owner.clientId : body.clientId,
        siteId: owner ? owner.siteId : body.siteId,
        areaId: body.areaId, refId,
        kind: body.kind, mimeType: body.mimeType, storagePath: body.storagePath,
        thumbPath, // optional poster/thumbnail, dropped when it doesn't derive
        sizeBytes: body.sizeBytes, durationSecs: body.durationSecs, caption: body.caption,
        uploadedByUserId: g.orgUserId,
        clientMediaId: typeof body.clientMediaId === 'string' ? body.clientMediaId.slice(0, 64) : null,
      });
      return res.status(200).json({ media });
    }

    if (action === 'list' && req.method === 'GET') {
      const siteId = req.query.siteId;
      const refId = req.query.refId || null;
      const scope = req.query.scope || null;
      const areaId = req.query.areaId || null; // narrows to one inspection section
      if (!siteId) return res.status(400).json({ error: 'siteId is required' });
      const g = await requireSiteAssignment(req, res, siteId, SITE_OPTS);
      if (!g) return;
      if (refId) {
        // listMedia filters on ref_id and ignores site_id, so the authorization key
        // must follow the filter key. The gate above only covers the site the caller
        // NAMED; this re-gates against the site that actually owns the rows about to
        // be returned. Without it the gate constrained nothing about the result set,
        // so revoking an assignment revoked no access.
        const r = await resolveOwnerOrDeny(req, res, { scope, refId, gatedSiteId: siteId });
        if (r.status === 'denied') return;
        // 'miss' = a well-formed clean refId whose job row hasn't mirrored yet. There
        // is no owning record, so there is nothing to authorize and nothing to return.
        if (r.status === 'miss') return res.status(200).json({ media: [] });
      }
      // Passed explicitly rather than relying on listMedia's precedence — the query
      // it runs and the query that was authorized are now the same query by shape.
      // areaId only narrows the result set (a section of an already-authorized ref);
      // it never widens access, so it rides on the same gate.
      const media = await listMedia(refId ? { refId, scope, areaId } : { siteId, scope, areaId });
      return res.status(200).json({ media });
    }

    if (action === 'delete' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'ops.edit');
      if (!g) return;
      if (!body.id) return res.status(400).json({ error: 'id is required' });
      const r = await removeMedia({ id: body.id });
      if (r.notFound) return res.status(404).json({ error: 'Media not found' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'caption' && req.method === 'POST') {
      // Authenticate BEFORE any DB read (no session → 401). We can't lead with
      // requireSiteAssignment because the client posts { id, caption } — no siteId to gate
      // on — so we resolve the row's OWNING site first, then re-gate on it.
      const a = await requireAuthority(req, res);
      if (!a) return;
      // Validate before touching the DB: a required id and a caption that is a string within
      // the cap. An empty string clears the note; anything else non-string, or over the cap,
      // is a 400.
      if (!body.id || typeof body.id !== 'string') return res.status(400).json({ error: 'id is required' });
      if (body.caption != null && typeof body.caption !== 'string') return res.status(400).json({ error: 'caption must be text' });
      const caption = typeof body.caption === 'string' ? body.caption : '';
      if (caption.length > MAX_CAPTION_LEN) return res.status(400).json({ error: `caption must be at most ${MAX_CAPTION_LEN} characters` });
      // Re-gate on the site that OWNS the row, exactly as confirm authorizes against the
      // owning record and never a caller-supplied site. Org-pinned, so a cross-org id
      // resolves to nothing; a missing row is a hard deny that does NOT distinguish "no such
      // row" from "not yours" — the existence-oracle stance resolveOwnerOrDeny takes above.
      const owner = await mediaOwnerSite({ id: body.id });
      if (!owner) return res.status(403).json({ error: 'Not authorized for this record' });
      const g = await requireSiteAssignment(req, res, owner.siteId, SITE_OPTS);
      if (!g) return;
      const r = await updateCaption({ id: body.id, caption });
      if (r.notFound) return res.status(404).json({ error: 'Media not found' });
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/account-media]', e);
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
