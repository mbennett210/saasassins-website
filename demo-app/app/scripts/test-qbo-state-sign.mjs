// signState / verifyState key isolation (pure, offline). The QBO OAuth flow signs its
// `state` with a DEDICATED key env (QBO_TOKEN_ENCRYPTION_KEY), never the inbox key
// (THE LAW II.9: one key per purpose). This proves:
//   1. the default (no key arg) behaviour is BYTE-for-byte unchanged for inbox callers;
//   2. a QBO-key-signed state does NOT verify under the default key, and vice-versa.
//
//   node scripts/test-qbo-state-sign.mjs
import crypto from 'node:crypto';

process.env.INBOX_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.QBO_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { signState, verifyState } = await import('../api/_lib/crypto.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const payload = { t: 'x', ts: Date.now(), nonce: 'abc', by: 'u_1' };

// 1. default behaviour unchanged — sign/verify round-trips with no key arg.
const def = signState(payload);
const defOut = verifyState(def);
ok('default: round-trips (inbox callers unchanged)', defOut && defOut.nonce === 'abc' && defOut.by === 'u_1', JSON.stringify(defOut));
// A default-signed token is a plain `data.sig` shape — its two segments are unchanged.
ok('default: token shape is data.sig', typeof def === 'string' && def.split('.').length === 2, def);

// 2. QBO-key isolation: a state signed with the QBO key verifies ONLY under the QBO key.
const qbo = signState(payload, 'QBO_TOKEN_ENCRYPTION_KEY');
ok('QBO-signed state verifies under the QBO key', !!verifyState(qbo, 10 * 60 * 1000, 'QBO_TOKEN_ENCRYPTION_KEY'));
ok('🔴 QBO-signed state does NOT verify under the default key (isolation)',
  verifyState(qbo) === null, 'default key accepted a QBO-signed state — keys are NOT isolated');
ok('🔴 default-signed state does NOT verify under the QBO key (isolation)',
  verifyState(def, 10 * 60 * 1000, 'QBO_TOKEN_ENCRYPTION_KEY') === null, 'QBO key accepted a default-signed state');

// 3. expiry still enforced under the QBO key.
const stale = signState({ ...payload, ts: Date.now() - 20 * 60 * 1000 }, 'QBO_TOKEN_ENCRYPTION_KEY');
ok('QBO-signed state past maxAge is rejected', verifyState(stale, 10 * 60 * 1000, 'QBO_TOKEN_ENCRYPTION_KEY') === null);

// 4. tamper still caught under the QBO key.
const [d] = qbo.split('.');
const tampered = `${d}.${'A'.repeat(qbo.split('.')[1].length)}`;
ok('QBO-signed state with a forged signature is rejected', verifyState(tampered, 10 * 60 * 1000, 'QBO_TOKEN_ENCRYPTION_KEY') === null);

console.log(`\nqbo-state-sign: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
