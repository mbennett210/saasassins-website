// Token encryption + OAuth state signing. AES-256-GCM protects secrets at rest;
// HMAC-SHA256 signs the OAuth `state` param. Inbox tokens / OAuth state use
// INBOX_TOKEN_ENCRYPTION_KEY (the default); other domains pass a different env
// var name to encrypt/decrypt for blast-radius isolation — e.g. site access
// codes use OPS_CODE_ENCRYPTION_KEY (see CLEANSPACE_SWEPT.md §2.4). Each key is a
// base64-encoded 32 bytes.

import crypto from 'node:crypto';

function getKey(envName = 'INBOX_TOKEN_ENCRYPTION_KEY') {
  const key = Buffer.from(process.env[envName] || '', 'base64');
  if (key.length !== 32) {
    throw new Error(`${envName} must be a base64-encoded 32-byte key.`);
  }
  return key;
}

// Returns base64( iv[12] | authTag[16] | ciphertext ).
export function encrypt(plaintext, keyEnv) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(keyEnv), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload, keyEnv) {
  const buf = Buffer.from(String(payload), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(keyEnv), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// Signed, self-describing OAuth state token: base64url(payload).base64url(hmac).
export function signState(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getKey()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Returns the payload when the token is well-formed, untampered and fresh;
// otherwise null.
export function verifyState(token, maxAgeMs = 10 * 60 * 1000) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', getKey()).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    // Malformed payload — treat as invalid state.
    return null;
  }
  if (!payload || typeof payload.ts !== 'number' || Date.now() - payload.ts > maxAgeMs) {
    return null;
  }
  return payload;
}
