// Per-user email signature helpers.
//
// Emails go out through the connected-inbox pipeline (api/_lib/google.js),
// which auto-detects HTML and supports inline images via Content-ID. So:
//   - a text-only signature appends to a plain-text body, and
//   - an image signature produces an HTML body that references the image inline
//     (the image rides along as an inline Content-ID attachment, so it renders
//     in place rather than as a download).
// Marketing email sequences build their own bodies and must NOT call these.

const SIGNATURE_CID = 'cleanspace-signature';

// Display-width presets for the signature image (S/M/L), in CSS pixels. This is
// scaling, not cropping — the image keeps its aspect ratio (height:auto). The
// same width drives the live preview (SignaturePreview) and the sent email
// (buildOutboundEmail) so preview == sent (UI_RULES §48).
export const SIGNATURE_IMAGE_WIDTH_PRESETS = { S: 160, M: 240, L: 360 };
export const DEFAULT_SIGNATURE_IMAGE_WIDTH = 240;

// Resolve the signature image width from prefs, clamped to a sane range. A
// missing or out-of-range value falls back to the default (240).
export function signatureImageWidth(prefs) {
  const w = Number(prefs?.imageWidth);
  if (!Number.isFinite(w) || w < 80 || w > 600) return DEFAULT_SIGNATURE_IMAGE_WIDTH;
  return Math.round(w);
}

// ── SIGNATURE IMAGE SHAPES (C07) ─────────────────────────────────────────────
//
// The image is moving out of the org_state blob and into Supabase Storage, so a
// reader has to handle THREE shapes — not two, which is what the plan says:
//
//   'none'     signaturePrefs absent entirely, disabled, or no image.
//              ⚠️ THIS IS THE ACTUAL LIVE STATE: 0 of 43 users have signaturePrefs
//              (verified by SELECT). The v45→v46 backfill that would have created it
//              only ever runs in local/demo mode, so production skipped it. Any
//              migration written for "legacy → new" would therefore find nothing to
//              migrate and silently do nothing.
//   'inline'   `imageDataUrl` — the base64 data URL in the blob. What the app writes
//              today, and what buildOutboundEmail already renders as an inline CID.
//   'storage'  `imagePath` — a Supabase Storage object key. Bytes are NOT in the blob,
//              so a caller that needs them must fetch first (that is why the email
//              path has to become async).
//
// Deliberately does NOT fetch. Describing the shape is synchronous and pure, which
// keeps buildOutboundEmail synchronous for the inline case and confines the async
// resolve to the one caller that genuinely needs bytes.
//
// Field names verified against DEFAULT_SIGNATURE_PREFS (data/seed.js) and every write
// in settings/Account.jsx — `imageDataUrl`, `imageWidth`. `imagePath` follows the same
// `image*` convention. This check is not ceremony: the blob-budget guard shipped inert
// in this same area by assuming a field name that did not exist.
export const SIGNATURE_SHAPE = Object.freeze({ NONE: 'none', INLINE: 'inline', STORAGE: 'storage' });

export function resolveSignatureImage(prefs) {
  if (!prefs || !prefs.enabled) return { kind: SIGNATURE_SHAPE.NONE };
  // Storage wins when both are present: that is the state DURING the migration, and
  // the Storage copy is the one being kept. Preferring the data URL would make a
  // half-migrated user silently keep using the blob copy and never converge.
  if (typeof prefs.imagePath === 'string' && prefs.imagePath) {
    return { kind: SIGNATURE_SHAPE.STORAGE, path: prefs.imagePath, width: signatureImageWidth(prefs) };
  }
  if (typeof prefs.imageDataUrl === 'string' && prefs.imageDataUrl) {
    return { kind: SIGNATURE_SHAPE.INLINE, dataUrl: prefs.imageDataUrl, width: signatureImageWidth(prefs) };
  }
  return { kind: SIGNATURE_SHAPE.NONE };
}

// True when the signature is on AND has something to add (text or image).
export function signatureHasContent(prefs) {
  if (!prefs || !prefs.enabled) return false;
  return Boolean((prefs.text || '').trim() || resolveSignatureImage(prefs).kind !== SIGNATURE_SHAPE.NONE);
}

// The trailing text block to append to a plain-text body, or '' when empty.
export function signatureTextBlock(prefs) {
  if (!prefs || !prefs.enabled) return '';
  const text = (prefs.text || '').trim();
  return text ? `\n\n${text}` : '';
}

// Append signature text to a plain-text body. No-op when disabled/empty.
export function appendSignature(body, prefs) {
  const block = signatureTextBlock(prefs);
  return block ? `${body || ''}${block}` : (body || '');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtml(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

// Pull the mime type + raw base64 out of a `data:` URL. Restricted to the
// email-safe image types we accept; the strict character classes also keep a
// crafted data URL from smuggling CR/LF into the downstream MIME headers.
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  return m ? { mimeType: m[1], base64: m[2].replace(/\s+/g, '') } : null;
}

// The extensions a signature object may carry, mirroring MIME_EXT in
// api/_lib/signatureUpload.js (the only thing that writes them). A closed map, not a
// parse: `signatureExt` crosses to the server and is concatenated into a Storage path
// there, so an open-ended value would be a path-traversal parameter.
const SIGNATURE_EXT_MIME = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' });

// The trailing extension of a stored signature path, or null when unrecognised.
export function signatureExtFromPath(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
  const ext = (m ? m[1] : '').toLowerCase();
  return SIGNATURE_EXT_MIME[ext] ? ext : null;
}

// Builds the outbound forms of an email:
//   displayText  – plain text stored on the message + shown in the thread
//   sendBody     – what actually goes out: plain text, or HTML when there's a
//                  signature image to render inline
//   inlineImages – inline (Content-ID) attachments referenced by the HTML
//
// ⚠️ STAYS SYNCHRONOUS, and the STORAGE shape emits a REFERENCE, NOT BYTES.
//
// The obvious C07 design — make this async and fetch the Storage bytes here — is worse
// twice over. It would make the browser download its own signature on every send just
// to base64 it back to a server that is already talking to Storage, and it would force
// both call sites (ConversationMessagePanel's doSend and doReply) to await inside a
// click handler, opening a double-send window. `resolveOutboundAttachments` already
// resolves Storage references server-side and (since the inline/contentId fix)
// preserves the CID, so the reference just rides the existing path.
//
// 🔴 AND IT CARRIES NO PATH. A `storageKey` + bucket pair would let any caller name any
// object in the private `ops-media` bucket — account media, quotes — and have the
// server mail it to them. That is AUTHORIZATION_AUDIT #5's exact shape. Instead the
// client sets a FLAG, and the server rebuilds `<org>/_signatures/<the caller's own
// org_user_id>.<ext>` from the JWT claim. Reading someone else's object is not
// expressible rather than merely refused — the same property the upload route has.
// `signatureExt` is the only value that crosses, and it is closed to three literals.
export function buildOutboundEmail(messageText, prefs) {
  const text = messageText || '';
  const displayText = appendSignature(text, prefs);

  const sig = resolveSignatureImage(prefs);
  let part = null;
  if (sig.kind === SIGNATURE_SHAPE.INLINE) {
    const img = parseDataUrl(sig.dataUrl);
    if (img) {
      const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      part = {
        name: `signature.${ext}`,
        mimeType: img.mimeType,
        content: img.base64,
        contentId: SIGNATURE_CID,
        inline: true,
      };
    }
  } else if (sig.kind === SIGNATURE_SHAPE.STORAGE) {
    const ext = signatureExtFromPath(sig.path);
    // An unrecognised extension degrades to a text-only signature rather than emitting
    // a part the server cannot resolve — a missing image beats a broken-image icon.
    if (ext) {
      part = {
        name: `signature.${ext}`,
        mimeType: SIGNATURE_EXT_MIME[ext],
        contentId: SIGNATURE_CID,
        inline: true,
        signatureRef: true,
        signatureExt: ext,
      };
    }
  }

  if (!part) {
    return { displayText, sendBody: displayText, inlineImages: [] };
  }
  const sigText = (prefs.text || '').trim();
  const sigTextHtml = sigText ? `<div style="white-space:pre-wrap">${textToHtml(prefs.text)}</div>` : '';
  const sendBody =
    `<div style="white-space:pre-wrap">${textToHtml(text)}</div>` +
    `<br>` +
    `<div>${sigTextHtml}` +
    `<div style="margin-top:4px"><img src="cid:${SIGNATURE_CID}" alt="Signature" style="max-width:${sig.width}px;height:auto" /></div>` +
    `</div>`;
  return { displayText, sendBody, inlineImages: [part] };
}
