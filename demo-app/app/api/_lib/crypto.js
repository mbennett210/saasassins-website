// Token encryption + OAuth state signing. AES-256-GCM protects secrets at rest;
// HMAC-SHA256 signs the OAuth `state` param. Inbox tokens / OAuth state use
// INBOX_TOKEN_ENCRYPTION_KEY (the default); other domains pass a different env
// var name to encrypt/decrypt for blast-radius isolation — e.g. site access
// codes use OPS_CODE_ENCRYPTION_KEY (see CLEANSPACE_SWEPT.md §2.4). Each key is a
// base64-encoded 32 bytes.

import crypto from 'node:crypto';

// A key that is absent or the wrong length is an OPERATOR condition, not a caller
// error, so it gets a machine-readable marker (`code`) a route can map to a 503 and a
// generic `message` safe to hand a browser. The env NAME rides on `err.envName` for the
// server log only: the old message was `${envName} must be a base64-encoded 32-byte
// key.`, and routes that echo `e.message` into a 500 published the variable name to
// anyone who could reach them (CS-037's 500 named OPS_CODE_ENCRYPTION_KEY; CS-077).
export const ENCRYPTION_KEY_MISSING = 'ENCRYPTION_KEY_MISSING';

/** True when `err` is the "this key is not configured" condition, whatever the domain. */
export function isEncryptionKeyMissing(err) {
  return !!err && err.code === ENCRYPTION_KEY_MISSING;
}

/**
 * Whether a domain's key is present and usable, WITHOUT doing any crypto. Lets a route
 * pre-flight before it starts a read-modify-write, so a missing key refuses cleanly
 * instead of throwing mid-transaction. Returns true/false only — never the value.
 */
export function hasEncryptionKey(envName = 'INBOX_TOKEN_ENCRYPTION_KEY') {
  return Buffer.from(process.env[envName] || '', 'base64').length === 32;
}

function getKey(envName = 'INBOX_TOKEN_ENCRYPTION_KEY') {
  const key = Buffer.from(process.env[envName] || '', 'base64');
  if (key.length !== 32) {
    const err = new Error('Encryption is not configured on this server.');
    err.code = ENCRYPTION_KEY_MISSING;
    err.envName = envName;   // server-log only — never put this in a response body
    throw err;
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

// A KEYED PSEUDONYM for a value the app must count but never keep — a visitor's random device id on
// the public QR page (QR-25's limits, api/_lib/scanCodes/visitor.js): HMAC-SHA256, base64url
// (43 characters), so the stored value cannot be turned back into the id and is worthless outside
// this server. The key is DERIVED (HKDF-SHA256) from an existing server secret under a `purpose`
// label, so it is never the secret itself and never the key another purpose uses (THE LAW II.9:
// keys separate per purpose) — and no new secret has to be provisioned for it. Rotating the
// secret only changes every pseudonym (the limits start over). Throws the module's
// ENCRYPTION_KEY_MISSING error when the secret is absent; a caller fails closed on it.
// The HKDF label names no brand (a re-brand must not change every pseudonym; the name ledger).
export function purposeHmac(value, purpose, keyEnv) {
  if (typeof purpose !== 'string' || !purpose) throw new Error('purposeHmac needs a purpose');
  const key = Buffer.from(crypto.hkdfSync('sha256', getKey(keyEnv), Buffer.alloc(0), `purpose-hmac:${purpose}`, 32));
  return crypto.createHmac('sha256', key).update(String(value)).digest('base64url');
}

// Signed, self-describing OAuth state token: base64url(payload).base64url(hmac).
//
// `keyEnv` (optional) names the HMAC key env, exactly like encrypt/decrypt above, so a
// domain can sign its OAuth state with its OWN key (blast-radius isolation, THE LAW II.9).
// Omitting it keeps the inbox default (INBOX_TOKEN_ENCRYPTION_KEY) byte-for-byte, so
// every existing caller is unchanged; the QuickBooks flow passes QBO_TOKEN_ENCRYPTION_KEY.
// A state signed under one key never verifies under another (proven by test-qbo-state-sign).
export function signState(payload, keyEnv) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getKey(keyEnv)).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Returns the payload when the token is well-formed, untampered and fresh;
// otherwise null. `keyEnv` must match the one signState used (default when omitted).
export function verifyState(token, maxAgeMs = 10 * 60 * 1000, keyEnv) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', getKey(keyEnv)).update(data).digest('base64url');
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
