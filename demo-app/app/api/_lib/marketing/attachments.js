// Server-side read of marketing step attachments from Supabase Storage, for the
// send cron (api/marketing/run). Mirrors the client's loadAttachmentsForSend:
// a missing/unsynced blob is skipped (never blocks the whole send) since
// attachment metadata and the blob can drift apart.

import { getSupabase } from '../supabase.js';
import { SIGNATURE_BUCKET, SIGNATURE_EXTS, signaturePathFor } from '../signatureUpload.js';
import { requireSafeSegment, isValidAttachmentKey } from '../storagePaths.js';

// Shared with the client uploader (src/lib/attachments.js). Keep in lockstep.
export const MARKETING_ATTACHMENT_BUCKET = 'marketing-attachments';

// The `id` comes from step.attachments[] inside the org_state blob, which every user can
// write directly under the open RLS policy until Increment 1e. So it is caller-influenced
// even though it looks like internal metadata, and it is interpolated straight into an
// object key. Validated at the point of derivation rather than trusted by provenance.
export const marketingAttachmentKey = (id) => `marketing/${requireSafeSegment(id, 'marketing attachment id')}`;

// Resolve step.attachments[] metadata into send-ready { name, mimeType, content }
// parts (content = base64, no data: prefix), downloading each blob from Storage.
export async function loadStepAttachmentsForSend(metas) {
  const list = Array.isArray(metas) ? metas : [];
  if (list.length === 0) return [];
  const supabase = getSupabase();
  const parts = [];
  for (const meta of list) {
    if (!meta?.id) continue;
    try {
      const { data, error } = await supabase.storage
        .from(MARKETING_ATTACHMENT_BUCKET)
        .download(marketingAttachmentKey(meta.id));
      if (error || !data) continue; // not yet synced to Storage → skip this attachment
      const buf = Buffer.from(await data.arrayBuffer());
      parts.push({
        name: meta.name || 'attachment',
        mimeType: meta.mimeType || 'application/octet-stream',
        content: buf.toString('base64'),
      });
    } catch {
      // Skip a bad blob rather than fail the whole send.
    }
  }
  return parts;
}

// Resolve OUTBOUND (Messaging compose/reply) attachments into send-ready parts.
// New clients upload the bytes straight to Storage and send only a `storageKey`
// reference, because a base64 body could never exceed ~3.3MB of real file (Vercel's
// ~4.5MB platform body cap + base64's +33% inflation).
//
// MIXED-FLEET SAFE: `main` deploys with no forced reload, so a tab still running
// pre-fix client code will keep sending inline base64 `content`. Those pass through
// untouched — this only resolves the ones carrying a storageKey.
export async function resolveOutboundAttachments(atts, { orgUserId } = {}) {
  const list = Array.isArray(atts) ? atts : [];
  if (list.length === 0) return [];
  const supabase = getSupabase();
  const out = [];
  for (const a of list) {
    if (!a) continue;
    if (a.content) { out.push(a); continue; } // legacy inline base64 from an old tab

    // ── the caller's OWN signature image (C07) ────────────────────────────
    // 🔴 THE CLIENT SENDS A FLAG, NOT A PATH. The object key is rebuilt here from the
    // caller's JWT-derived org_user_id, so a caller cannot name another user's
    // signature — or any other `ops-media` object (account media, quote PDFs) — and
    // have it mailed to them. Accepting a caller-supplied `{storageKey, bucket}` pair
    // instead would be exactly AUTHORIZATION_AUDIT #5's read primitive, reintroduced
    // on the send path. Do not add a path or bucket parameter to this branch.
    if (a.signatureRef) {
      // No identity → no derivable path. The marketing cron reaches performSend with no
      // caller (it is a cron), and marketing bodies must never carry a user signature
      // anyway, so dropping the part is the correct outcome rather than an error.
      if (!orgUserId) continue;
      // Closed set: this value is concatenated into a Storage path.
      if (!SIGNATURE_EXTS.includes(a.signatureExt)) continue;
      try {
        const path = signaturePathFor(orgUserId, a.signatureExt);
        const { data, error } = await supabase.storage.from(SIGNATURE_BUCKET).download(path);
        if (error || !data) continue; // no signature stored → send without it
        const buf = Buffer.from(await data.arrayBuffer());
        const { signatureRef: _r, signatureExt: _e, ...rest } = a;
        out.push({ ...rest, content: buf.toString('base64') });
      } catch {
        // A signature that will not load must never block the email itself.
      }
      continue;
    }

    if (!a.storageKey) continue;
    // 🔴 THE KEY IS CALLER-SUPPLIED. `atts` is `req.body.attachments`, arriving through
    // performSend from both inbox routes, and this downloads whatever key it is given
    // out of a shared private bucket and mails the bytes to a caller-chosen recipient.
    // Unvalidated, that is a read primitive over every object in `marketing-attachments`
    // — every org's outbound attachments and every marketing asset.
    //
    // This branch sat directly BELOW the signatureRef branch, which was carefully shaped
    // so no path could cross the wire. Hardening one and leaving its sibling open is the
    // same mistake as gating /send and not /test. Legitimate keys are only ever
    // `outbox/<id>` or `marketing/<id>` (src/lib/attachments.js, marketingAttachmentKey),
    // so a closed form costs nothing and refuses everything else.
    if (!isValidAttachmentKey(a.storageKey)) continue;
    try {
      const { data, error } = await supabase.storage
        .from(MARKETING_ATTACHMENT_BUCKET)
        .download(a.storageKey);
      if (error || !data) continue; // missing blob → skip, never fail the whole send
      const buf = Buffer.from(await data.arrayBuffer());
      // ⚠️ SPREAD `a` — do NOT rebuild from a fixed field list.
      //
      // This used to return only { name, mimeType, content }, which SILENTLY DROPPED
      // `inline` and `contentId`. The legacy passthrough two lines up pushes `a`
      // untouched, so the two branches disagreed about which fields survive — and only
      // the Storage branch lost them.
      //
      // Harmless while signatures are inline base64 (they take the legacy branch), but
      // C07 turns the signature into a Storage reference. Routed through here it would
      // arrive with its Content-ID stripped, so google.js's `file.inline &&
      // file.contentId` test fails, the part is emitted as a normal attachment, and the
      // `<img src="cid:cleanspace-signature">` in the HTML body resolves to nothing —
      // a broken image in EVERY email with a signature, with no error anywhere.
      const { storageKey: _k, ...rest } = a;
      out.push({
        ...rest,
        name: a.name || 'attachment',
        mimeType: a.mimeType || 'application/octet-stream',
        content: buf.toString('base64'),
      });
    } catch {
      // Skip a bad blob rather than fail the whole send.
    }
  }
  return out;
}
