// C07 send path — the signature travels as a CLAIM-RESOLVED REFERENCE, not a path.
//
// ══ THE SECURITY PROPERTY ═════════════════════════════════════════════════════
// The obvious shape for "signature now lives in Storage" is for the client to send
// { storageKey, bucket } and the server to download it. That is AUTHORIZATION_AUDIT #5
// rebuilt on the send path: `ops-media` also holds account media and quote PDFs, so a
// caller could name ANY object in it and have the server mail the bytes to them.
//
// Instead the client sends a FLAG (`signatureRef: true` + a closed-set `signatureExt`)
// and the server rebuilds `<org>/_signatures/<the caller's own org_user_id>.<ext>` from
// the JWT claim. No path crosses the wire. Reading another user's object is not
// EXPRESSIBLE, not merely refused.
//
// This suite asserts that from both ends, so the two halves cannot drift apart.
//
//   node scripts/test-signature-ref.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { buildOutboundEmail, signatureExtFromPath } from '../src/lib/signature.js';
import { SIGNATURE_EXTS, signaturePathFor, SIGNATURE_BUCKET } from '../api/_lib/signatureUpload.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUg==';
const inlinePrefs = { enabled: true, text: 'Kyle', imageDataUrl: `data:image/png;base64,${PNG_1PX}` };
const storagePrefs = { enabled: true, text: 'Kyle', imagePath: 'org_cleanspace/_signatures/u_kyle.png' };

// ── 🔴 the STORAGE shape emits a reference and NO path ──────────────────
{
  const built = buildOutboundEmail('hello', storagePrefs);
  const part = built.inlineImages[0];
  ok('storage shape produces exactly one inline part', built.inlineImages.length === 1);
  ok('  ...flagged as a signature reference', part.signatureRef === true);
  ok('  ...carries NO storageKey', part.storageKey === undefined);
  ok('  ...carries NO bucket', part.bucket === undefined && part.storageBucket === undefined);
  ok('  ...carries NO content (bytes stay server-side)', part.content === undefined);
  ok('  ...carries NO imagePath', part.imagePath === undefined);
  // The whole serialized part must not contain the stored path anywhere.
  ok('  🔴 the object path appears NOWHERE in the payload',
    !JSON.stringify(part).includes('_signatures') && !JSON.stringify(part).includes('u_kyle'));
  ok('  ...keeps inline + contentId so google.js emits it inline', part.inline === true && part.contentId === 'cleanspace-signature');
  ok('  ...declares a mime type', part.mimeType === 'image/png');
  ok('  ...and the body still references the CID', built.sendBody.includes('cid:cleanspace-signature'));
}

// ── the INLINE shape is unchanged (regression guard) ────────────────────
{
  const built = buildOutboundEmail('hello', inlinePrefs);
  const part = built.inlineImages[0];
  ok('inline shape still ships bytes', part.content === PNG_1PX);
  ok('  ...is NOT flagged as a reference', part.signatureRef === undefined);
  ok('  ...keeps inline + contentId', part.inline === true && part.contentId === 'cleanspace-signature');
  ok('  ...name is derived from the mime type', part.name === 'signature.png');
  ok('  ...jpeg maps to a .jpg name', buildOutboundEmail('x', {
    enabled: true, imageDataUrl: `data:image/jpeg;base64,${PNG_1PX}`,
  }).inlineImages[0].name === 'signature.jpg');
}

// ── storage WINS over inline mid-migration ──────────────────────────────
{
  const both = buildOutboundEmail('x', { ...inlinePrefs, imagePath: storagePrefs.imagePath });
  ok('with both shapes present, storage wins', both.inlineImages[0].signatureRef === true);
  ok('  ...and no bytes are sent', both.inlineImages[0].content === undefined);
}

// ── degenerate / disabled ───────────────────────────────────────────────
ok('disabled prefs produce no part', buildOutboundEmail('x', { ...storagePrefs, enabled: false }).inlineImages.length === 0);
ok('no prefs produce no part', buildOutboundEmail('x', null).inlineImages.length === 0);
ok('text-only produces no part', buildOutboundEmail('x', { enabled: true, text: 'Kyle' }).inlineImages.length === 0);
ok('  ...but still appends the text', buildOutboundEmail('x', { enabled: true, text: 'Kyle' }).displayText.includes('Kyle'));

// ── 🔴 signatureExt is CLOSED — it is concatenated into a path ──────────
{
  ok('png/jpg/gif are recognised',
    signatureExtFromPath('a/b.png') === 'png' && signatureExtFromPath('a/b.jpg') === 'jpg' && signatureExtFromPath('a/b.gif') === 'gif');
  ok('  ...case-insensitively', signatureExtFromPath('a/b.PNG') === 'png');
  for (const [label, p] of [
    ['svg', 'a/b.svg'], ['exe', 'a/b.exe'], ['no extension', 'a/b'], ['empty', ''],
    ['null', null], ['traversal', 'a/../../etc/passwd'], ['double ext', 'a/b.png.exe'],
  ]) ok(`  ...${label} is rejected`, signatureExtFromPath(p) === null);

  // An unrecognised extension must degrade to a text-only signature, never emit a
  // part the server cannot resolve (a missing image beats a broken-image icon).
  const bad = buildOutboundEmail('x', { enabled: true, text: 'Kyle', imagePath: 'org/_signatures/u.svg' });
  ok('an unresolvable extension degrades to text-only', bad.inlineImages.length === 0);
  ok('  ...and the body is not HTML with a dangling cid', !bad.sendBody.includes('cid:'));
  ok('  ...but the signature TEXT survives', bad.displayText.includes('Kyle'));
}

// ── 🔴 client and server must agree on the closed set ───────────────────
{
  const clientExts = ['png', 'jpg', 'gif'].filter((e) => signatureExtFromPath(`x.${e}`) === e);
  ok('client accepts exactly png/jpg/gif', clientExts.length === 3);
  ok('  🔴 ...and the SERVER set is identical (drift pin)',
    [...SIGNATURE_EXTS].sort().join(',') === clientExts.sort().join(','));
  // Every ext the client can emit must produce a path the server can build.
  for (const e of clientExts) {
    const p = signaturePathFor('u_kyle', e);
    ok(`  server builds a path for .${e}`, p.endsWith(`u_kyle.${e}`) && p.includes('/_signatures/'));
  }
  ok('the signature bucket is the private ops-media', SIGNATURE_BUCKET === 'ops-media');
}

// ── 🔴 server branch: shape asserted against the source ─────────────────
// attachments.js reaches live Storage, so it is asserted by source rather than run.
{
  const src = readFileSync(new URL('../api/_lib/marketing/attachments.js', import.meta.url), 'utf8');
  ok('resolveOutboundAttachments takes orgUserId as an OPTION, not from the item',
    /resolveOutboundAttachments\(atts, \{ orgUserId \} = \{\}\)/.test(src));
  ok('🔴 the path is rebuilt via signaturePathFor(orgUserId, …), never read off the item',
    /signaturePathFor\(orgUserId, a\.signatureExt\)/.test(src));
  ok('  ...and the item is never consulted for a path or bucket',
    !/a\.(storagePath|imagePath|bucket|storageBucket)/.test(src));
  ok('no identity → the part is dropped, not defaulted', /if \(!orgUserId\) continue/.test(src));
  ok('🔴 the extension is checked against the closed server set BEFORE path building',
    src.indexOf('SIGNATURE_EXTS.includes(a.signatureExt)') < src.indexOf('signaturePathFor(orgUserId'));
  ok('the signature reads from SIGNATURE_BUCKET', /from\(SIGNATURE_BUCKET\)/.test(src));
  ok('  ...which is imported, not re-declared', /import \{[^}]*SIGNATURE_BUCKET[^}]*\} from/.test(src));
  ok('the internal flags are stripped from the MIME part',
    /signatureRef: _r, signatureExt: _e, \.\.\.rest/.test(src));
  ok('  ...and the rest of the part is spread, not rebuilt', /\.\.\.rest, content:/.test(src));
  ok('a failed signature download does not fail the email', /continue; \/\/ no signature stored/.test(src));

  // The marketing bucket branch must be untouched by all this.
  ok('the legacy inline passthrough survives', /if \(a\.content\) \{ out\.push\(a\); continue; \}/.test(src));
  ok('the marketing storageKey branch still uses the marketing bucket',
    /from\(MARKETING_ATTACHMENT_BUCKET\)/.test(src));
}

// ── 🔴 the route must not let the body supply the identity ──────────────
{
  const route = readFileSync(new URL('../api/inbox/[id]/send.js', import.meta.url), 'utf8');
  ok('the route captures the authority object', /const authority = await requireInboxOwner/.test(route));
  ok('  ...and bails when it is null', /if \(!authority\) return;/.test(route));
  ok('🔴 orgUserId comes from the CLAIM and is spread LAST, overriding the body',
    /\{ \.\.\.req\.body, orgUserId: authority\.orgUserId \}/.test(route));
  // The old form passed req.body straight through — that would let a caller inject it.
  ok('  ...the raw-body call form is gone', !/performSend\(req\.query\.id, req\.body\)/.test(route));

  const sender = readFileSync(new URL('../api/_lib/sender.js', import.meta.url), 'utf8');
  ok('performSend accepts orgUserId', /orgUserId \} = \{\}\)/.test(sender));
  ok('  ...and forwards it to the resolver', /resolveOutboundAttachments\(rawAttachments, \{ orgUserId \}\)/.test(sender));
}

// ── 🔴 EVERY performSend caller, found by scanning — not by name ────────
// The original version of this suite asserted the claim-override on ONE route
// (inbox/[id]/send.js) because that was the one I had just edited. The sibling
// inbox/[id]/test.js takes the identical payload and shipped passing `req.body`
// WHOLESALE, so `orgUserId` — the value a signatureRef is resolved against — was
// caller-supplied: any authenticated user could have had another user's signature
// object mailed to them out of the private bucket. Auditing by capability rather than
// by remembered filename is the loop's own rule, and this is what breaking it costs.
{
  const apiDir = fileURLToPath(new URL('../api', import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
  const files = walk(apiDir);
  const callers = files.filter((f) => {
    const s = readFileSync(f, 'utf8');
    return /\bperformSend\s*\(/.test(s) && !f.endsWith(join('_lib', 'sender.js'));
  });
  ok(`performSend callers located by scan (${callers.length})`, callers.length >= 2);

  const unguarded = [];
  for (const f of callers) {
    const s = readFileSync(f, 'utf8');
    // A caller is safe if it never hands performSend a wholesale request object, OR it
    // overrides orgUserId from a verified authority afterwards.
    const passesRawBody = /performSend\([^,]+,\s*req\.body\s*\)/.test(s);
    const overrides = /orgUserId:\s*(authority|a)\.orgUserId/.test(s);
    const spreadsBody = /performSend\([^,]+,\s*\{\s*\.\.\.req\.body/.test(s);
    if (passesRawBody || (spreadsBody && !overrides)) unguarded.push(relative(apiDir, f).replace(/\\/g, '/'));
  }
  ok(`🔴 no performSend caller lets the BODY supply orgUserId (${unguarded.join(', ') || 'none'})`,
    unguarded.length === 0);

  // The two HTTP routes must each derive it from the claim. The marketing cron passes
  // none, which is correct — marketing bodies carry no user signature.
  for (const name of ['send.js', 'test.js']) {
    const f = callers.find((c) => c.endsWith(join('[id]', name)));
    ok(`inbox/[id]/${name} is a known caller`, Boolean(f));
    if (f) {
      const s = readFileSync(f, 'utf8');
      ok(`  ...and spreads the CLAIM's orgUserId last`,
        /\{ \.\.\.req\.body, orgUserId: authority\.orgUserId \}/.test(s));
      ok(`  ...capturing the authority rather than discarding it`,
        /const authority = await requireInboxOwner/.test(s));
    }
  }
}

// ── 🔴 the path derivation refuses an unsafe id, whoever calls it ───────
// A guard that lives only in the routes is one new caller away from being reopened —
// which is exactly how test.js was missed when send.js was fixed.
{
  for (const [label, bad] of [
    ['traversal', '../../marketing/secret'], ['a slash', 'a/b'], ['a dot', 'u.kyle'],
    ['empty', ''], ['null', null], ['a number', 12], ['an object', {}],
    ['an over-long id', 'u_'.padEnd(200, 'x')],
  ]) {
    let threw = false;
    try { signaturePathFor(bad, 'png'); } catch { threw = true; }
    ok(`signaturePathFor rejects ${label}`, threw);
  }
  let threwExt = false;
  try { signaturePathFor('u_kyle', '../x'); } catch { threwExt = true; }
  ok('  ...and an unsupported extension', threwExt);
  ok('a legitimate id still resolves', signaturePathFor('u_kyle', 'png').endsWith('u_kyle.png'));
  ok('  ...as does a seed-style id', signaturePathFor('u_seed_kyle', 'jpg').endsWith('u_seed_kyle.jpg'));
}

// ── simulate the server branch's decision table ─────────────────────────
// Mirrors the guard order in attachments.js: identity, then closed-set ext, then path.
{
  const decide = (item, orgUserId) => {
    if (!item.signatureRef) return 'not-a-signature';
    if (!orgUserId) return 'dropped-no-identity';
    if (!SIGNATURE_EXTS.includes(item.signatureExt)) return 'dropped-bad-ext';
    return signaturePathFor(orgUserId, item.signatureExt);
  };
  const ref = { signatureRef: true, signatureExt: 'png' };
  ok('a cron caller (no identity) drops the signature', decide(ref, null) === 'dropped-no-identity');
  ok('a crafted extension is dropped', decide({ signatureRef: true, signatureExt: '../../secret' }, 'u_kyle') === 'dropped-bad-ext');
  ok('  ...including one that merely looks close', decide({ signatureRef: true, signatureExt: 'png ' }, 'u_kyle') === 'dropped-bad-ext');
  ok('  ...and a non-string', decide({ signatureRef: true, signatureExt: 1 }, 'u_kyle') === 'dropped-bad-ext');
  ok('two different callers resolve to two different paths',
    decide(ref, 'u_kyle') !== decide(ref, 'u_liz'));
  ok('🔴 the resolved path depends ONLY on the caller, not the item',
    decide({ ...ref, storageKey: 'org/_signatures/u_liz.png', bucket: 'ops-media' }, 'u_kyle') === decide(ref, 'u_kyle'));
}

console.log(`\nsignature ref (C07 send path): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
