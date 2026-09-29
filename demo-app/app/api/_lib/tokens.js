// Unguessable public tokens.
//
// WHY: quote `public_token`, public form slugs, and QC inspection `public_token`
// are bearer capabilities — whoever holds one reads (or in the quote case
// SIGNS) the document, with no other authentication. They were generated from
// `Math.random()`, which is a fast PRNG seeded from process state, NOT a
// cryptographic one: its output is predictable from observed values, so tokens
// were guessable rather than merely long. The repo already knew better —
// _lib/integrations/hmac.js and _lib/accounts.js both use crypto.randomBytes.
//
// FORMAT IS PRESERVED DELIBERATELY. Existing tokens are already embedded in
// links sent to real customers and remain valid; rotating them would break
// those links, which is a separate migration decision. So this changes only the
// SOURCE of randomness, keeping the same alphabet and length — new tokens are
// indistinguishable in shape from old ones, and nothing that consumes or
// pattern-matches a token needs to change.
import crypto from 'node:crypto';

// Rejection sampling, not `byte % alphabet.length`. A plain modulo over 256
// values with a 36-character alphabet maps the first 76 byte-values to one extra
// character each, measurably biasing the output; discarding the tail above the
// largest exact multiple removes that.
export function randomToken(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  const n = Math.max(1, Number(length) || 1);
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    const buf = crypto.randomBytes(n * 2);
    for (const b of buf) {
      if (out.length >= n) break;
      if (b >= limit) continue; // biased tail — discard
      out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
