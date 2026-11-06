// CS-037 regression: a missing OPS_CODE_ENCRYPTION_KEY must fail ONLY the door/alarm
// code part of a Location save, with a message the office can act on — and it must not
// name the environment variable in the response (CS-077).
//
// Pre-fix, `encrypt()` threw "OPS_CODE_ENCRYPTION_KEY must be a base64-encoded 32-byte
// key.", the route's catch-all returned it as a 500, and LocationCard's `catch { return; }`
// abandoned the entire edit — so a manager who typed a door code lost the address,
// geofence, access notes and expected clean time along with it.
//
// Offline: no Supabase, no network. Drives the route's own exported rule and the real
// crypto module, and enumerates the key names api/ actually reads.
// Run: node app/scripts/test-ops-code-key.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt, hasEncryptionKey, isEncryptionKeyMissing, ENCRYPTION_KEY_MISSING } from '../api/_lib/crypto.js';
import { opsCodeWriteBlock, CODES_UNAVAILABLE } from '../api/site-security/[...path].js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPS_KEY = 'OPS_CODE_ENCRYPTION_KEY';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

console.log('CS-037 — a missing ops-code key fails only the codes\n');

// ── 1. The crypto error is typed, and generic ────────────────────────────────
delete process.env[OPS_KEY];
ok(hasEncryptionKey(OPS_KEY) === false, 'hasEncryptionKey is false when the key is unset');

let thrown = null;
try { encrypt('1234', OPS_KEY); } catch (e) { thrown = e; }
ok(!!thrown, 'encrypt throws when the key is unset');
ok(isEncryptionKeyMissing(thrown), `the error is tagged ${ENCRYPTION_KEY_MISSING}`);
ok(!String(thrown?.message || '').includes(OPS_KEY),
  'the error MESSAGE does not name the environment variable (it is echoed to browsers)');
ok(thrown?.envName === OPS_KEY, 'the env name is available on err.envName for the server log');

let revealErr = null;
try { decrypt('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', OPS_KEY); } catch (e) { revealErr = e; }
ok(isEncryptionKeyMissing(revealErr), 'decrypt reports the same condition, so reveal can 503 too');

// ── 2. The route refuses ONLY a code write ───────────────────────────────────
const blocked = opsCodeWriteBlock({ siteId: 'st_1', doorCode: '4321' });
ok(blocked === CODES_UNAVAILABLE, 'storing a door code with no key is blocked');
ok(blocked?.status === 503, 'blocked with 503 (a server setting is missing, not a bad request)');
ok(!String(blocked?.error || '').includes(OPS_KEY),
  'the blocked response does not name the environment variable');
ok(typeof blocked?.code === 'string' && blocked.code.length > 0,
  'the block carries a machine-readable code the client keys off');
ok(opsCodeWriteBlock({ siteId: 'st_1', alarmCode: '99' }) === CODES_UNAVAILABLE,
  'storing an alarm code with no key is blocked too');

// The whole point of CS-037: everything that is NOT an encrypted code still goes through.
ok(opsCodeWriteBlock({ siteId: 'st_1', codeHint: 'ends 42' }) === null,
  'a hint-only save is NOT blocked by a missing key');
ok(opsCodeWriteBlock({ siteId: 'st_1', accessInstructions: 'Side gate', keyNumber: 'K-7' }) === null,
  'access instructions + key number are NOT blocked by a missing key');
ok(opsCodeWriteBlock({ siteId: 'st_1', doorCode: '' }) === null,
  "CLEARING a code ('') needs no key, so it is not blocked");
ok(opsCodeWriteBlock({ siteId: 'st_1' }) === null, 'a body with no code fields is not blocked');

// ── 3. With a key present, nothing is blocked and a round-trip works ─────────
process.env[OPS_KEY] = Buffer.alloc(32, 7).toString('base64');
ok(hasEncryptionKey(OPS_KEY) === true, 'hasEncryptionKey is true for a 32-byte base64 key');
ok(opsCodeWriteBlock({ siteId: 'st_1', doorCode: '4321' }) === null,
  'a configured key blocks nothing');
ok(decrypt(encrypt('4321', OPS_KEY), OPS_KEY) === '4321', 'the code round-trips under that key');

// A key of the wrong LENGTH is as unusable as an absent one (a truncated paste).
process.env[OPS_KEY] = Buffer.alloc(16, 7).toString('base64');
ok(hasEncryptionKey(OPS_KEY) === false, 'a 16-byte key is rejected');
ok(opsCodeWriteBlock({ siteId: 'st_1', doorCode: '4321' }) === CODES_UNAVAILABLE,
  'a wrong-length key blocks the code write rather than throwing mid-write');
delete process.env[OPS_KEY];

// ── 4. Env parity: every encryption key api/ reads is documented ─────────────
// CS-037's other half — OPS_CODE_ENCRYPTION_KEY was absent from .env.example, so nobody
// setting up an environment knew it existed. Enumerated from the code, never a hand list.
const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const documented = new Set(
  example.split('\n')
    .map((l) => l.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/))
    .filter(Boolean)
    .map((m) => m[1]),
);
const used = new Set();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.m?js$/.test(e.name)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/\b([A-Z][A-Z0-9_]*_ENCRYPTION_KEY)\b/g)) used.add(m[1]);
  }
};
walk(path.join(ROOT, 'api'));
ok(used.has(OPS_KEY), `the scan found ${OPS_KEY} in api/ (the scan itself works)`);
for (const name of [...used].sort()) {
  ok(documented.has(name), `${name} is documented in app/.env.example`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
