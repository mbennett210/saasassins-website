// HMAC-SHA256 signing/verification for webhooks. Signature format: `sha256=<hex>`
// (one convention shared by inbound Apps Script and outbound consumers).
import crypto from 'node:crypto';

export function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function verifyInbound(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = `sha256=${sign(rawBody, secret)}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function newSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

// Bearer token for inbound lead webhooks (Zapier-friendly: sent as
// `Authorization: Bearer <token>`). Distinct prefix from the HMAC secret so the
// two are never confused when copied.
export function newToken() {
  return `rlw_${crypto.randomBytes(24).toString('base64url')}`;
}
