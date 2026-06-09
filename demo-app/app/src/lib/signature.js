// Per-user email signature helpers.
//
// Emails go out through the connected-inbox pipeline, which auto-detects HTML
// and supports inline images via Content-ID. So:
//   - a text-only signature appends to a plain-text body, and
//   - an image signature produces an HTML body that references the image inline
//     (the image rides along as an inline Content-ID attachment, so it renders
//     in place rather than as a download).
// Marketing email sequences build their own bodies and must NOT call these.

const SIGNATURE_CID = 'pp-signature';

// True when the signature is on AND has something to add (text or image).
export function signatureHasContent(prefs) {
  if (!prefs || !prefs.enabled) return false;
  return Boolean((prefs.text || '').trim() || prefs.imageDataUrl);
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

// Builds the outbound forms of an email:
//   displayText  – plain text stored on the message + shown in the thread
//   sendBody     – what actually goes out: plain text, or HTML when there's a
//                  signature image to render inline
//   inlineImages – inline (Content-ID) attachments referenced by the HTML
export function buildOutboundEmail(messageText, prefs) {
  const text = messageText || '';
  const displayText = appendSignature(text, prefs);
  const img = (prefs?.enabled && prefs?.imageDataUrl) ? parseDataUrl(prefs.imageDataUrl) : null;
  if (!img) {
    return { displayText, sendBody: displayText, inlineImages: [] };
  }
  const sigText = (prefs.text || '').trim();
  const sigTextHtml = sigText ? `<div style="white-space:pre-wrap">${textToHtml(prefs.text)}</div>` : '';
  const sendBody =
    `<div style="white-space:pre-wrap">${textToHtml(text)}</div>` +
    `<br>` +
    `<div>${sigTextHtml}` +
    `<div style="margin-top:4px"><img src="cid:${SIGNATURE_CID}" alt="Signature" style="max-width:240px;height:auto" /></div>` +
    `</div>`;
  const ext = (img.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return {
    displayText,
    sendBody,
    inlineImages: [{
      name: `signature.${ext}`,
      mimeType: img.mimeType,
      content: img.base64,
      contentId: SIGNATURE_CID,
      inline: true,
    }],
  };
}
