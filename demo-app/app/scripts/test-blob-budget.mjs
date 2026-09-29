// Per-user embedded-image budget for the org_state blob.
//
// 🔴 THE CLIFF. Signature images are stored as base64 data URLs INSIDE the shared blob,
// and /api/state/org-state rejects any save over MAX_STATE_BYTES (3,500,000).
// Measured against production:
//
//     blob today ................. 914,189 bytes
//     server cap ............... 3,500,000 bytes
//     headroom ................. ~2,585,000 bytes
//     users with a signature ..... 0 of 43
//
// The only limit was `file.size > 1024 * 1024` in Settings → Account — CLIENT SIDE. A
// 1 MB image is ~1.37 MB base64, so TWO users adopting a documented feature push the
// blob past the cap, and then EVERY save in the org 413s — for everyone — with an
// error that names nothing ("body is 3700 KB, over the 3418 KB limit").
//
// Latent today (nobody has a signature); reachable the moment two people sign a quote.
//
//   node scripts/test-blob-budget.mjs
import { readFileSync } from 'node:fs';
import {
  SIGNATURE_MAX_B64_BYTES, userImageBytes, oversizedImageUsers, oversizedImageMessage,
  IMAGE_REFERENCE_FIELDS,
} from '../api/_lib/blobBudget.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const b64 = (n) => 'data:image/png;base64,' + 'A'.repeat(n);
const user = (id, bytes, over = {}) => ({
  id, name: id, ...over,
  // THE REAL FIELD — DEFAULT_SIGNATURE_PREFS in data/seed.js. The first version of
  // this suite used `signatureDataUrl`, which exists nowhere, so it tested the guard
  // against a field the app never writes and passed while the guard was inert.
  signaturePrefs: bytes == null ? undefined : { imageDataUrl: b64(bytes) },
});

// ── the budget arithmetic must actually fit ──────────────────────────────
// This is the whole point: 43 users all holding a signature must not breach the cap.
{
  const BLOB_TODAY = 914_189;
  const MAX_STATE = 3_500_000;
  const USERS = 43;
  const worst = BLOB_TODAY + USERS * SIGNATURE_MAX_B64_BYTES;
  ok(`43 users at the cap still fit under MAX_STATE_BYTES (${worst} < ${MAX_STATE})`, worst < MAX_STATE);
  ok('  ...with room left for ordinary blob growth (>400 KB)', MAX_STATE - worst > 400 * 1024);
  // The old client limit must be demonstrably unsafe, or this change is pointless.
  ok('the OLD 1 MB limit would have breached it with two users',
    BLOB_TODAY + 2 * Math.ceil(1024 * 1024 * 4 / 3) > MAX_STATE);
}

// ── detection ────────────────────────────────────────────────────────────
ok('an oversized signature is detected', oversizedImageUsers({ users: [user('u1', SIGNATURE_MAX_B64_BYTES + 1)] }).length === 1);
ok('exactly at the cap is allowed', oversizedImageUsers({ users: [user('u1', SIGNATURE_MAX_B64_BYTES - 30)] }).length === 0);
ok('a small signature is allowed', oversizedImageUsers({ users: [user('u1', 8 * 1024)] }).length === 0);
ok('no signaturePrefs is allowed', oversizedImageUsers({ users: [user('u1', null)] }).length === 0);
ok('multiple offenders are all reported', oversizedImageUsers({
  users: [user('u1', SIGNATURE_MAX_B64_BYTES + 1), user('u2', 10), user('u3', SIGNATURE_MAX_B64_BYTES + 1)],
}).length === 2);
ok('the report carries id and byte count', (() => {
  const [o] = oversizedImageUsers({ users: [user('u1', SIGNATURE_MAX_B64_BYTES + 100)] });
  return o.id === 'u1' && o.bytes > SIGNATURE_MAX_B64_BYTES;
})());

// ── 🔴 THE FIELD NAME MUST MATCH WHAT THE APP ACTUALLY WRITES ───────────
// The first version of this guard listed three plausible-sounding field names, none
// of which exist. It was completely inert — every oversized signature would have gone
// straight through while the guard looked healthy. This asserts the name against the
// SOURCE OF TRUTH rather than restating it, so a rename breaks the build.
{
  const seed = readFileSync(new URL('../src/data/seed.js', import.meta.url), 'utf8');
  const prefsBlock = (seed.match(/DEFAULT_SIGNATURE_PREFS = \{[\s\S]*?\n\};/) || [])[0] || '';
  ok('DEFAULT_SIGNATURE_PREFS found in seed.js', prefsBlock.length > 0);
  ok('  ...and it declares imageDataUrl', /imageDataUrl\s*:/.test(prefsBlock));
  // Every image-ish key the seed declares must be one the budget actually counts —
  // EXCEPT the ones the guard names as references rather than bytes. That exclusion is
  // read from the guard's own exported list, not restated here, so the two cannot
  // disagree: adding an image field without counting it still fails, but adding a
  // deliberate reference field does not.
  const seedImageKeys = [...prefsBlock.matchAll(/^\s{2}(\w*[Ii]mage\w*|\w*DataUrl)\s*:/gm)]
    .map((m) => m[1])
    .filter((k) => !/Width$/.test(k)) // imageWidth is a number, not bytes
    .filter((k) => !IMAGE_REFERENCE_FIELDS.includes(k));
  const uncounted = seedImageKeys.filter((k) => userImageBytes({ signaturePrefs: { [k]: b64(SIGNATURE_MAX_B64_BYTES + 1) } }) === 0);
  ok(`every image field in the seed is counted (${seedImageKeys.join(', ')}; uncounted: ${uncounted.join(', ') || 'none'})`,
    uncounted.length === 0);
  ok('  ...and the reference fields are declared, not merely absent', IMAGE_REFERENCE_FIELDS.length > 0);

  // 🔴 The C07 saving itself: a Storage PATH must not be charged as image bytes. If
  // this ever fails, moving the image out of the blob has bought the user nothing.
  for (const ref of IMAGE_REFERENCE_FIELDS) {
    ok(`a ${ref} reference costs no image budget`,
      userImageBytes({ signaturePrefs: { [ref]: 'org_cleanspace/_signatures/u_kyle.png' } }) === 0);
    ok(`  ...even at absurd length (it is never bytes)`,
      userImageBytes({ signaturePrefs: { [ref]: b64(SIGNATURE_MAX_B64_BYTES + 1) } }) === 0);
  }
  // And the real field must still be charged, so the exclusion did not widen.
  ok('imageDataUrl is still counted in full',
    userImageBytes({ signaturePrefs: { imageDataUrl: b64(SIGNATURE_MAX_B64_BYTES + 1) } }) > SIGNATURE_MAX_B64_BYTES);
}

// ── all image-shaped fields count, not just the one we know about ───────
ok('the legacy signatureImage alias counts too', oversizedImageUsers({
  users: [{ id: 'u1', signaturePrefs: { signatureImage: b64(SIGNATURE_MAX_B64_BYTES + 1) } }],
}).length === 1);
ok('fields ACCUMULATE (two half-cap images breach together)', oversizedImageUsers({
  users: [{ id: 'u1', signaturePrefs: { imageDataUrl: b64(SIGNATURE_MAX_B64_BYTES * 0.6), initialsDataUrl: b64(SIGNATURE_MAX_B64_BYTES * 0.6) } }],
}).length === 1);
// The post-C07 shape is a Storage REFERENCE, not bytes, so this guard must not fire on
// it — and the field name is the real one (`imagePath`, see lib/signature.js
// resolveSignatureImage), not a placeholder. A guard that only tolerates an invented
// shape would start rejecting real users the day C07 ships.
ok('a post-C07 imagePath reference costs nothing', oversizedImageUsers({
  users: [{ id: 'u1', signaturePrefs: { imagePath: 'sig/u1.png', imageWidth: 240 } }],
}).length === 0);
ok('  ...even with a long path', oversizedImageUsers({
  users: [{ id: 'u1', signaturePrefs: { imagePath: `sig/${'x'.repeat(400)}.png` } }],
}).length === 0);

// ── shape robustness — it runs on EVERY save, so it must never throw ────
ok('missing users slice is safe', oversizedImageUsers({}).length === 0);
ok('null state is safe', oversizedImageUsers(null).length === 0);
ok('non-array users is safe', oversizedImageUsers({ users: 'nope' }).length === 0);
ok('null user rows are safe', oversizedImageUsers({ users: [null, undefined] }).length === 0);
ok('a non-object signaturePrefs is safe', oversizedImageUsers({ users: [{ id: 'u1', signaturePrefs: 'x' }] }).length === 0);
ok('non-string image fields are ignored', userImageBytes({ signaturePrefs: { signatureDataUrl: 12345 } }) === 0);
// UTF-16 .length would undercount multi-byte content; the blob is what gets measured.
ok('byte length, not code-unit length', userImageBytes({ signaturePrefs: { signatureDataUrl: '€'.repeat(100) } }) === 300);

// ── the message names WHO and BY HOW MUCH ───────────────────────────────
// The existing MAX_STATE_BYTES error says "body is 3700 KB" and names nobody, which is
// exactly why this cliff would have been hard to diagnose.
{
  const msg = oversizedImageMessage(oversizedImageUsers({ users: [user('u_kyle', SIGNATURE_MAX_B64_BYTES * 2)] }));
  ok('the rejection names the user', msg.includes('u_kyle'));
  ok('  ...states the limit', /\d+ KB/.test(msg));
  ok('  ...explains why it matters to everyone', /everyone/i.test(msg));
  ok('  ...tells them what to do', /re-upload/i.test(msg));
}

// ── client and server caps must not drift ───────────────────────────────
{
  const acct = readFileSync(new URL('../src/pages/settings/Account.jsx', import.meta.url), 'utf8');
  const clientKb = Number((acct.match(/SIGNATURE_MAX_IMAGE_BYTES = (\d+) \* 1024/) || [])[1]);
  ok(`the client cap is declared (${clientKb} KB)`, Number.isFinite(clientKb));
  // 4/3 is base64's inflation. The client caps the RAW file; the server caps the
  // ENCODED string, so the client number must be the smaller one.
  ok('the client cap fits inside the server budget once base64-inflated',
    Math.ceil(clientKb * 1024 * 4 / 3) <= SIGNATURE_MAX_B64_BYTES);
  ok('the old 1 MB client limit is gone', !/file\.size > 1024 \* 1024/.test(acct));
}

console.log(`\nblob budget: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
