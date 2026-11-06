// What may be attached to a LOCATION (access instructions) or to an OFFICE NOTE, how big,
// and who may add or remove a location's files. Pure (its one import, the role list, is pure
// too) so the BROWSER (LocationCard, ClientDetail), the SERVER (api/site-attachments,
// api/_lib/siteAttachments/store.js) and the node tests all read the same rule.
import { SUPERVISOR_ROLES } from './roles.js';
//
// These attachments used to store `{ name, size, type }` and nothing else: the file was
// never uploaded anywhere, so the chip in the read view named a document that existed on
// nobody's machine (CS-043). The copy promised crew "site maps, gate codes, walkthrough
// PDFs" they could not open. Bytes now go to the private Storage bucket; this module is
// the gate both ends apply, because a cap enforced only in the browser is not a cap.

export const SITE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file

// The closed set of types. PDFs and images are what a site map, a gate diagram or a
// walkthrough actually is; an open set would mean serving arbitrary uploads back out of
// a private bucket by signed URL.
export const SITE_ATTACHMENT_ALLOWED_MIME = Object.freeze([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// mime → the extension the server appends to the object key. The key's extension comes
// from THIS map, never from the uploaded filename: a filename is caller-controlled and
// the object key must not be.
export const SITE_ATTACHMENT_EXT = Object.freeze({
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

// Where an attachment hangs. Each scope has its OWN authorization, mirroring the surface
// it belongs to — a location's access files are crew-facing, an office note's are not
// necessarily, so they are never gated as one thing.
export const ATTACHMENT_SCOPE = Object.freeze({
  /** Access instructions on the customer's location. Owner id = the site id. */
  SITE: 'site',
  /** A file on an office note (clientActivities). Owner id = the client id. */
  CLIENT_NOTE: 'client_note',
});

export const ATTACHMENT_SCOPES = Object.freeze(Object.values(ATTACHMENT_SCOPE));

/**
 * Validate a declared upload BEFORE any URL is minted, so a refused file never gets a
 * signed URL at all. Returns { ok: true } or { ok: false, error } with copy safe to show.
 */
export function validateSiteAttachment({ mimeType, sizeBytes } = {}) {
  if (!SITE_ATTACHMENT_ALLOWED_MIME.includes(mimeType)) {
    return { ok: false, error: 'Unsupported file type. Use a PDF or a PNG/JPG/WebP/GIF image.' };
  }
  if (Number.isFinite(Number(sizeBytes)) && Number(sizeBytes) > SITE_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: `File is too large (max ${Math.round(SITE_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB).` };
  }
  return { ok: true };
}

/** True when `scope` is one this app serves. Anything else is refused, never defaulted. */
export function isAttachmentScope(scope) {
  return ATTACHMENT_SCOPES.includes(scope);
}

// WHO MAY ADD OR REMOVE a location's access files (CS-692): the people who EDIT the location —
// `sites.edit`, the key its edit form needs, AND `sites.attachments`, the key its Add
// attachment control needs — and only an office role: crew never, whatever a per-user grant
// says (`can()` puts no key out of a grant's reach; the QR codes' office floor, lib/scanCodes,
// is the same shape). `sites.attachments` is a crew default, so the server used to let any
// cleaner who ever had a clean at a location upload files under it or delete the office's
// gate map through a crafted request. Crew still READ their assigned sites' files.
export const SITE_ATTACHMENT_WRITE_ROLES = SUPERVISOR_ROLES;
export function siteAttachmentWriteAllowed(role, { canEditSites = false, canAttach = false } = {}) {
  return SITE_ATTACHMENT_WRITE_ROLES.includes(role) && canEditSites === true && canAttach === true;
}
