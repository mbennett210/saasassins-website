// A QR code's token — its whole capability (THE LAW II.6: "CSPRNG tokens, never
// Math.random() — the token IS the capability"). 24 bytes from node:crypto, written by the
// shared pure encoder (src/lib/areaScan.js) so the demo's Web-Crypto minter and this one
// produce the same 32-character URL-safe shape the database CHECK accepts.
import crypto from 'node:crypto';
import { SCAN_TOKEN_BYTES, encodeScanToken } from '../../../src/lib/areaScan.js';

export function mintScanToken() {
  return encodeScanToken(crypto.randomBytes(SCAN_TOKEN_BYTES));
}
