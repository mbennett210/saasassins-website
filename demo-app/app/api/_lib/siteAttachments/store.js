// Service-role data layer for LOCATION access attachments and OFFICE NOTE attachments.
//
// Bytes live in the private 'ops-media' bucket under a dedicated `site-attachments/`
// prefix — the same bucket the account photo/video store already uses, so no bucket has
// to be created and nothing needs a migration. The metadata (name / size / mimeType /
// storagePath) rides `site.attachments[]` and `clientActivity.attachment` in org_state,
// exactly as invoice.attachment does, so there is no table either.
//
// Before this, those records held `{ name, size, type }` and the file was never uploaded
// at all: staff attached gate maps and walkthrough PDFs, and the read view showed a
// filename chip with nothing behind it (CS-043).
//
// The object key is REBUILT here from the scope + owner id, never taken from the body,
// and a client-supplied storagePath is honoured only when it sits under the prefix that
// same rebuild produces (storage-path law, _lib/storagePaths.js).
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment } from '../storagePaths.js';
import {
  SITE_ATTACHMENT_EXT,
  ATTACHMENT_SCOPE,
  isAttachmentScope,
  validateSiteAttachment,
} from '../../../src/lib/siteAttachmentRules.js';

// Shared with the account photo/video store. Private: every object is reached only
// through a signed URL minted by the service role, and the browser never holds the key.
const BUCKET = 'ops-media';

// The prefix segment that keeps these apart from account_media objects in the same
// bucket. Not caller-supplied, so it is a constant, not a validated segment.
const ROOT = 'site-attachments';

// A signed download URL lives 10 minutes: long enough to open a PDF, short enough that a
// URL pasted into a chat log stops working.
export const DOWNLOAD_URL_TTL_SECONDS = 600;

const rid = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; for (let i = 0; i < 16; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

export { validateSiteAttachment };

/**
 * The object prefix for one owner: `<org>/site-attachments/<scope>/<ownerId>/`.
 *
 * `ownerId` is the SITE id for the site scope and the CLIENT id for a note, and it is
 * interpolated into a Storage key — so it goes through requireSafeSegment. Without that,
 * an ownerId of `../../_signatures` would mint a signed upload URL pointing at another
 * prefix of this same private bucket (which also holds signatures and quote documents).
 * The scope is validated against the closed set for the same reason.
 */
export function attachmentPrefix(scope, ownerId) {
  if (!isAttachmentScope(scope)) throw new Error('unsafe attachment scope');
  requireSafeSegment(scope, 'site-attachment scope');
  requireSafeSegment(ownerId, 'site-attachment ownerId');
  return `${CLEANSPACE_ORG_ID}/${ROOT}/${scope}/${ownerId}/`;
}

/**
 * Accept a caller-supplied storagePath only if it sits under the prefix this owner
 * rebuilds to. The path arrives from org_state, which the browser can write, so it is an
 * untrusted string: unchecked, it would be a read AND delete primitive over the whole
 * private bucket, including every account photo and every other customer's files.
 */
export function assertOwnedPath(scope, ownerId, storagePath) {
  const prefix = attachmentPrefix(scope, ownerId);
  if (typeof storagePath !== 'string'
    || !storagePath.startsWith(prefix)
    || storagePath.includes('..')
    || storagePath.includes('%')
    || storagePath.includes('\\')
    // Exactly one more segment below the prefix — the object itself. A deeper path is not
    // something this app ever mints.
    || storagePath.slice(prefix.length).includes('/')
    || storagePath.length === prefix.length) {
    throw new Error('storagePath does not belong to this record');
  }
  return storagePath;
}

/** The object key a fresh upload gets. The extension comes from the MIME map, not the filename. */
export function newObjectPath({ scope, ownerId, mimeType }) {
  const ext = SITE_ATTACHMENT_EXT[mimeType] || 'bin';
  return `${attachmentPrefix(scope, ownerId)}${rid()}.${ext}`;
}

export async function signedUploadUrl({ scope, ownerId, mimeType }) {
  const db = getSupabase();
  const path = newObjectPath({ scope, ownerId, mimeType });
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path: data?.path || path, token: data?.token, signedUrl: data?.signedUrl };
}

export async function signedDownloadUrl({ scope, ownerId, storagePath }) {
  assertOwnedPath(scope, ownerId, storagePath);
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(storagePath, DOWNLOAD_URL_TTL_SECONDS);
  if (error) throw error;
  return { url: data?.signedUrl || null };
}

export async function removeObject({ scope, ownerId, storagePath }) {
  assertOwnedPath(scope, ownerId, storagePath);
  const db = getSupabase();
  const { error } = await db.storage.from(BUCKET).remove([storagePath]);
  if (error) throw error;
  return { ok: true };
}

export { ATTACHMENT_SCOPE };
