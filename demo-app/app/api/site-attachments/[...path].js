// Location access attachments + office-note attachments (CS-043). Bytes go to the private
// 'ops-media' bucket under a `site-attachments/` prefix via a signed upload URL; this
// route mints that URL, mints short-lived signed download URLs, and deletes. The metadata
// rides site.attachments[] / clientActivity.attachment in org_state, so there is no table.
//
//   POST /api/site-attachments/upload-url   { scope, ownerId, mimeType, sizeBytes } -> { path, token, signedUrl }
//   POST /api/site-attachments/download-url { scope, ownerId, storagePath }         -> { url }
//   POST /api/site-attachments/delete       { scope, ownerId, storagePath }         -> { ok }
//
// ══ AUTHORIZATION IS PER SCOPE, because the two surfaces are not the same audience ══
//   scope 'site'        — the location's ACCESS instructions. Crew-facing by design ("shown
//                         to any crew member assigned to this customer"), so a read is
//                         requireSiteAssignment: every office role at any site, crew only at
//                         a site they work. A WRITE (upload, delete) is the location's EDIT
//                         form's (CS-692, src/lib/siteAttachmentRules siteAttachmentWriteAllowed,
//                         the Location card's own rule): `sites.edit` AND `sites.attachments`
//                         AND an office role — crew never, whatever a grant says. It used to
//                         need only `sites.attachments`, a crew default, so any cleaner who ever
//                         had a clean at a location could upload under it or delete the office's
//                         gate map with a crafted request.
//   scope 'client_note' — a file on an OFFICE note. Gated on the customer record's own
//                         permissions, `clients.view` to open and `clients.edit` to attach
//                         or remove, mirroring ClientDetail's canView / canEdit exactly.
// ownerId is the SITE id for 'site' and the CLIENT id for 'client_note'; the object key is
// rebuilt from it server-side and a supplied storagePath must fall under that same prefix.
import { requirePermission, requireSiteAssignment, holdsPermission, OFFICE_ROLES } from '../_lib/authz.js';
import {
  signedUploadUrl, signedDownloadUrl, removeObject,
  validateSiteAttachment, ATTACHMENT_SCOPE,
} from '../_lib/siteAttachments/store.js';
import { isAttachmentScope, siteAttachmentWriteAllowed } from '../../src/lib/siteAttachmentRules.js';

// Same site-visibility stance as account-media: the app shows every site to every office
// role (site visibility is `role !== 'crew'`), and crew reach a site through a standing
// assignment or a clean there. No job-age cutoff — opening the gate map for a clean you
// did yesterday is legitimate; the tight window belongs to code reveal alone.
const SITE_OPTS = { managerRoles: OFFICE_ROLES, jobWindow: null, allowJobBased: true };

// `write` = uploading or deleting. Returns the caller, or null once a 401/403 is written.
async function gate(req, res, { scope, ownerId, write }) {
  if (scope === ATTACHMENT_SCOPE.SITE) {
    // AND, deliberately: the editor's rule AND the site. requireSiteAssignment's
    // bypassPermission is an OR, which would let a permission stand in for the site.
    if (write) {
      const g = await requirePermission(req, res, 'sites.edit');
      if (!g) return null;
      if (!siteAttachmentWriteAllowed(g.role, { canEditSites: true, canAttach: await holdsPermission(g, 'sites.attachments') })) {
        res.status(403).json({ error: 'Access files are managed by the office.', code: 'office-only' });
        return null;
      }
    }
    return requireSiteAssignment(req, res, ownerId, SITE_OPTS);
  }
  return requirePermission(req, res, write ? 'clients.edit' : 'clients.view');
}

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};
  const scope = body.scope;
  const ownerId = body.ownerId;

  try {
    // Validate the shape BEFORE authorizing on it: an unknown scope would otherwise fall
    // through `gate`'s else branch and be judged by the wrong rule.
    if (!isAttachmentScope(scope)) return res.status(400).json({ error: 'Unknown attachment scope' });
    if (!ownerId) return res.status(400).json({ error: 'ownerId is required' });

    if (action === 'upload-url' && req.method === 'POST') {
      if (!(await gate(req, res, { scope, ownerId, write: true }))) return;
      // Declared type + size are checked before a URL exists, so a refused file is never
      // handed anywhere to put bytes.
      const v = validateSiteAttachment({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!v.ok) return res.status(400).json({ error: v.error });
      return res.status(200).json(await signedUploadUrl({ scope, ownerId, mimeType: body.mimeType }));
    }

    if (action === 'download-url' && req.method === 'POST') {
      if (!(await gate(req, res, { scope, ownerId, write: false }))) return;
      if (!body.storagePath) return res.status(400).json({ error: 'storagePath is required' });
      return res.status(200).json(await signedDownloadUrl({ scope, ownerId, storagePath: body.storagePath }));
    }

    if (action === 'delete' && req.method === 'POST') {
      if (!(await gate(req, res, { scope, ownerId, write: true }))) return;
      if (!body.storagePath) return res.status(400).json({ error: 'storagePath is required' });
      return res.status(200).json(await removeObject({ scope, ownerId, storagePath: body.storagePath }));
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    console.error('[api/site-attachments]', e);
    // A rejected storagePath or ownerId is a 400 about the request, not a server fault —
    // and its message is the generic one from the store, naming no bucket or prefix.
    if (/does not belong to this record|^unsafe /.test(e?.message || '')) {
      return res.status(400).json({ error: 'That file does not belong to this record' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
}
